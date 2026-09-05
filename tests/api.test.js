/**
 * Tests for the REST API builders and routes.
 * @file api.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { Recorder } = require("../plugin/recorder.js");
const {
  ApiError,
  parseTimeWindow,
  granularityForWindow,
  sourceTypesFromConfig,
  sampleToActualPoint,
  integratePerHour,
  downsamplePoints,
  hourlyPredictions,
  buildActuals,
  buildPredictions,
  buildEnvironment,
  buildSummary,
  buildDeployStates,
  registerApiRoutes,
  resolveNavState,
  MAX_WINDOW_DAYS,
  offsetMinutesFromSamples,
} = require("../plugin/api.js");
const openApiSpec = require("../schema/openapi.json");

const CONFIG = {
  solarArrays: [{ id: "flinsail" }, { id: "bow" }],
  mechanicalGenerators: [
    { id: "superwind", type: "wind" },
    { id: "sailinggen", type: "hydro" },
  ],
};

const SOURCE_TYPES = sourceTypesFromConfig(CONFIG);

function makeApp() {
  return { debug() {}, error() {} };
}

/** Writes fixtures via the real recorder into a temp dir. */
async function writeFixtures(dataDir) {
  const recorder = new Recorder(makeApp(), dataDir, {});
  const base = new Date("2026-08-22T00:00:00Z").getTime();

  // One cycle at 00:05 predicting 24 hours; hour 12 predicts 100 Wh solar,
  // 50 Wh wind against a 60 W load
  const forecast = [];
  for (let h = 0; h < 24; h++) {
    forecast.push({
      time: new Date(base + 5 * 60000 + h * 3600000).toISOString(),
      idealSolarYieldWh: h === 12 ? 100 : 10,
      idealWindYieldWh: h === 12 ? 50 : 5,
      houseLoadWh: 60,
      idealNetWh: h === 12 ? 90 : -45,
      idealSoC: 0.5,
      detectedYieldWh: 0,
      detectedNetWh: -60,
      detectedSoC: 0.5,
      gustSpeedKnots: 10,
      windSpeedKnots: 8,
      actions: [],
    });
  }
  await recorder.recordCycle({
    timestamp: new Date(base + 5 * 60000),
    weatherTier: 1,
    forecast,
    actions: [],
  });

  // Samples every 5 minutes for 2 hours: solar 200 W, wind 100 W,
  // hydro 0 W, house load 60 W, SoC 0.8, wind 8 kn
  for (let m = 0; m <= 120; m += 5) {
    await recorder.recordSample({
      timestamp: new Date(base + m * 60000),
      arrays: { flinsail: 150, bow: 50 },
      generators: { superwind: 100, sailinggen: 0 },
      soc: 0.8,
      houseLoadW: 60,
      windSpeedKnots: 8,
      navState: "moored",
      position: { latitude: -18.86, longitude: -159.8 },
    });
  }
  return { base };
}

test.describe("parseTimeWindow", () => {
  test("parses valid windows", () => {
    const { from, to } = parseTimeWindow({
      from: "2026-08-22T00:00:00Z",
      to: "2026-08-23T00:00:00Z",
    });
    assert.strictEqual(from.toISOString(), "2026-08-22T00:00:00.000Z");
    assert.strictEqual(to.toISOString(), "2026-08-23T00:00:00.000Z");
  });

  test("rejects missing parameters", () => {
    assert.throws(
      () => parseTimeWindow({ from: "2026-08-22T00:00:00Z" }),
      ApiError,
    );
    assert.throws(() => parseTimeWindow({}), ApiError);
  });

  test("rejects unparsable timestamps", () => {
    assert.throws(
      () => parseTimeWindow({ from: "yesterday", to: "2026-08-23T00:00:00Z" }),
      ApiError,
    );
  });

  test("rejects reversed windows", () => {
    assert.throws(
      () =>
        parseTimeWindow({
          from: "2026-08-23T00:00:00Z",
          to: "2026-08-22T00:00:00Z",
        }),
      ApiError,
    );
  });

  test("rejects oversized windows", () => {
    assert.throws(
      () =>
        parseTimeWindow({
          from: "2026-01-01T00:00:00Z",
          to: "2026-12-31T00:00:00Z",
        }),
      ApiError,
    );
    // Exactly the cap is allowed
    const { from, to } = parseTimeWindow({
      from: "2026-01-01T00:00:00Z",
      to: new Date(
        new Date("2026-01-01T00:00:00Z").getTime() +
          MAX_WINDOW_DAYS * 24 * 3600000,
      ).toISOString(),
    });
    assert.ok(to > from);
  });
});

test.describe("granularityForWindow", () => {
  test("day windows are raw", () => {
    const g = granularityForWindow(
      new Date("2026-08-22T00:00:00Z"),
      new Date("2026-08-23T00:00:00Z"),
    );
    assert.strictEqual(g.intervalMs, null);
    assert.strictEqual(g.label, "5min");
  });

  test("week windows are 15-minute", () => {
    const g = granularityForWindow(
      new Date("2026-08-22T00:00:00Z"),
      new Date("2026-08-29T00:00:00Z"),
    );
    assert.strictEqual(g.intervalMs, 900000);
    assert.strictEqual(g.label, "15min");
  });

  test("month windows are hourly", () => {
    const g = granularityForWindow(
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-31T00:00:00Z"),
    );
    assert.strictEqual(g.intervalMs, 3600000);
    assert.strictEqual(g.label, "60min");
  });
});

test.describe("sourceTypesFromConfig and sample mapping", () => {
  test("devices map to yield sources", () => {
    assert.ok(SOURCE_TYPES.solarIds.has("flinsail"));
    assert.ok(SOURCE_TYPES.windIds.has("superwind"));
    assert.ok(SOURCE_TYPES.hydroIds.has("sailinggen"));
  });

  test("sample becomes per-source point", () => {
    const point = sampleToActualPoint(
      {
        timestamp: "2026-08-22T00:00:00.000Z",
        arrays: { flinsail: 150, bow: 50, unknown: 999 },
        generators: { superwind: 100, sailinggen: 0 },
        houseLoadW: 60,
        soc: 0.8,
        windSpeedKnots: 8,
        navState: "moored",
      },
      SOURCE_TYPES,
    );
    assert.strictEqual(point.solarW, 200);
    assert.strictEqual(point.windW, 100);
    assert.strictEqual(point.hydroW, 0);
    assert.strictEqual(point.houseLoadW, 60);
    // Unconfigured devices are ignored
    assert.strictEqual(point.solarW, 200);
  });
});

test.describe("resolveNavState", () => {
  test("uses the sample state when present", () => {
    const sorted = [{ navState: "moored" }];
    assert.strictEqual(
      resolveNavState({ navState: "anchored" }, sorted),
      "anchored",
    );
  });

  test("falls back to the first sample's state before any sample", () => {
    // Hours before the first recorded sample have no state to carry forward.
    // A hardcoded "anchored" default would let a deployable wind generator
    // predict yield for the gap at the start of the window when the vessel
    // is actually moored. Use the first sample's state instead.
    const sorted = [{ navState: "moored" }, { navState: "anchored" }];
    assert.strictEqual(resolveNavState(null, sorted), "moored");
  });

  test("defaults to anchored when there are no samples at all", () => {
    assert.strictEqual(resolveNavState(null, []), "anchored");
    assert.strictEqual(resolveNavState(null, undefined), "anchored");
  });
});

test.describe("integratePerHour", () => {
  test("trapezoidal integration of constant power", () => {
    const points = [];
    const base = new Date("2026-08-22T00:00:00Z").getTime();
    for (let m = 0; m <= 60; m += 5) {
      points.push({
        time: new Date(base + m * 60000).toISOString(),
        solarW: 100,
      });
    }
    const hourly = integratePerHour(points, ["solarW"]);
    const entry = hourly.get(base);
    // 12 five-minute intervals at 100 W → 100 Wh
    assert.ok(Math.abs(entry.solarW - 100) < 0.01);
  });

  test("attributes intervals to midpoint hour", () => {
    const base = new Date("2026-08-22T00:55:00Z").getTime();
    const points = [
      { time: new Date(base).toISOString(), solarW: 100 },
      { time: new Date(base + 10 * 60000).toISOString(), solarW: 100 },
    ];
    const hourly = integratePerHour(points, ["solarW"]);
    // Interval 00:55–01:05, midpoint 01:00 → hour 01 bucket
    const hour1 = new Date("2026-08-22T01:00:00Z").getTime();
    assert.ok(Math.abs(hourly.get(hour1).solarW - 100 / 6) < 0.01);
    assert.strictEqual(
      hourly.get(new Date("2026-08-22T00:00:00Z").getTime()),
      undefined,
    );
  });
});

test.describe("downsamplePoints", () => {
  test("averages within buckets", () => {
    const base = new Date("2026-08-22T00:00:00Z").getTime();
    const points = [
      {
        time: new Date(base).toISOString(),
        solarW: 100,
        soc: 0.5,
        navState: "moored",
      },
      {
        time: new Date(base + 5 * 60000).toISOString(),
        solarW: 200,
        soc: 0.7,
        navState: "moored",
      },
      {
        time: new Date(base + 20 * 60000).toISOString(),
        solarW: 400,
        soc: 0.9,
        navState: "anchored",
      },
    ];
    const out = downsamplePoints(points, 15 * 60000);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].solarW, 150); // (100+200)/2
    assert.strictEqual(out[0].soc, 0.6);
    assert.strictEqual(out[0].navState, "moored");
    assert.strictEqual(out[1].solarW, 400);
  });
});

test.describe("hourlyPredictions", () => {
  test("freshest cycle wins per hour", () => {
    const t0 = new Date("2026-08-22T12:00:00Z").getTime();
    const old = {
      timestamp: new Date(t0 - 3600000).toISOString(),
      weatherTier: 4,
      forecast: [
        {
          time: new Date(t0).toISOString(),
          idealSolarYieldWh: 10,
          idealWindYieldWh: 0,
          houseLoadWh: 50,
          idealNetWh: -40,
        },
      ],
    };
    const fresh = {
      timestamp: new Date(t0 - 600000).toISOString(),
      weatherTier: 1,
      forecast: [
        {
          time: new Date(t0).toISOString(),
          idealSolarYieldWh: 99,
          idealWindYieldWh: 0,
          houseLoadWh: 50,
          idealNetWh: 49,
        },
      ],
    };
    const hourly = hourlyPredictions([old, fresh]);
    const entry = hourly.get(t0);
    assert.strictEqual(entry.solarWh, 99);
    assert.strictEqual(entry.weatherTier, 1);
  });
});

test.describe("builders over recorded fixtures", () => {
  let dataDir;
  let base;

  test.before(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "energy-api-"));
    ({ base } = await writeFixtures(dataDir));
  });

  test.after(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function loadSamples(from, to) {
    const { getRecordings } = require("../plugin/recorder.js");
    return getRecordings(dataDir, from, to, "sample");
  }

  async function loadCycles(from, to) {
    const { getRecordings } = require("../plugin/recorder.js");
    return getRecordings(
      dataDir,
      new Date(from.getTime() - 24 * 3600000),
      to,
      "cycle",
    );
  }

  test("buildActuals: raw series, per-source totals, averages", async () => {
    const from = new Date(base);
    const to = new Date(base + 2 * 3600000);
    const samples = await loadSamples(from, to);
    const actuals = buildActuals(samples, SOURCE_TYPES, from, to);

    assert.strictEqual(actuals.granularity, "5min");
    assert.strictEqual(actuals.points.length, 25);
    assert.strictEqual(actuals.points[0].solarW, 200);
    assert.strictEqual(actuals.points[0].windW, 100);

    // 2 h at 200/100/60 W → about 400/200/120 Wh (trapezoid between
    // 5-minute samples: 23 of 24 intervals inside the hour-rounded window)
    assert.ok(
      Math.abs(actuals.totals.solarWh - 400) < 25,
      `solar ${actuals.totals.solarWh}`,
    );
    assert.ok(
      Math.abs(actuals.totals.windWh - 200) < 25,
      `wind ${actuals.totals.windWh}`,
    );
    assert.ok(Math.abs(actuals.totals.houseLoadWh - 120) < 25);
    assert.strictEqual(actuals.averageW.houseLoad, 60);
  });

  test("buildActuals: week window downsamples to 15-minute", async () => {
    const from = new Date(base);
    const to = new Date(base + 7 * 24 * 3600000);
    const samples = await loadSamples(from, to);
    const actuals = buildActuals(samples, SOURCE_TYPES, from, to);
    assert.strictEqual(actuals.granularity, "15min");
    assert.strictEqual(actuals.points.length, 9); // 2h / 15min + 1
  });

  test("buildPredictions: day window returns raw cycles", async () => {
    const from = new Date(base);
    const to = new Date(base + 24 * 3600000);
    const cycles = await loadCycles(from, to);
    const predictions = buildPredictions(cycles, from, to);
    assert.strictEqual(predictions.granularity, "raw");
    assert.strictEqual(predictions.cycles.length, 1);
    assert.strictEqual(predictions.cycles[0].weatherTier, 1);
    assert.strictEqual(predictions.cycles[0].forecast.length, 24);
  });

  test("buildPredictions: week window returns daily totals", async () => {
    const from = new Date(base);
    const to = new Date(base + 7 * 24 * 3600000);
    const cycles = await loadCycles(from, to);
    const predictions = buildPredictions(cycles, from, to);
    assert.strictEqual(predictions.granularity, "daily");
    assert.strictEqual(predictions.days.length, 1);
    const day = predictions.days[0];
    assert.strictEqual(day.date, "2026-08-22");
    // 24 h forecast: 23×10 + 100 solar
    assert.strictEqual(day.solarWh, 330);
    assert.strictEqual(day.windWh, 165);
    assert.strictEqual(day.hydroWh, 0);
    assert.strictEqual(day.hours, 24);
  });

  test("buildEnvironment: wind series with nav state", async () => {
    const from = new Date(base);
    const to = new Date(base + 3600000);
    const samples = await loadSamples(from, to);
    const env = buildEnvironment(samples, from, to);
    assert.strictEqual(env.points[0].windSpeedKnots, 8);
    assert.strictEqual(env.points[0].navState, "moored");
    assert.deepStrictEqual(env.points[0].position, {
      latitude: -18.86,
      longitude: -159.8,
    });
    // Reserved fields are null until the recorder persists them
    assert.strictEqual(env.points[0].cloudCover, null);
    assert.strictEqual(env.points[0].ghi, null);
  });

  test("buildSummary: totals, SoC stats, prediction accuracy", async () => {
    const from = new Date(base);
    const to = new Date(base + 2 * 3600000);
    const samples = await loadSamples(from, to);
    const cycles = await loadCycles(from, to);
    const summary = buildSummary(cycles, samples, SOURCE_TYPES, from, to);

    assert.ok(Math.abs(summary.consumption.totalWh - 120) < 25);
    assert.strictEqual(summary.soc.min, 0.8);
    assert.strictEqual(summary.soc.max, 0.8);
    assert.strictEqual(
      summary.yield.wind.totalWh,
      summary.consumption.totalWh * (200 / 120),
    );

    const acc = summary.predictionAccuracy;
    assert.ok(acc.hoursCompared >= 1);
    // Hours 0-1: predicted 15 Wh (10 solar + 5 wind) vs actual 300 Wh
    // → error 95%. With one compared hour, MAPE is exactly that.
    assert.ok(
      acc.meanAbsoluteErrorPercent > 50,
      `mape ${acc.meanAbsoluteErrorPercent}`,
    );
    assert.ok(acc.totalActualWh > 0);
  });
});

test.describe("route registration", () => {
  function makeRouter() {
    const routes = new Map();
    return {
      routes,
      get(path, handler) {
        routes.set(path, handler);
      },
    };
  }

  function makeRes() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
  }

  async function withFixtures(fn) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "energy-routes-"));
    try {
      await writeFixtures(dataDir);
      await fn(dataDir);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }

  test("routes are registered with window validation", async () => {
    await withFixtures(async (dataDir) => {
      const router = makeRouter();
      registerApiRoutes(router, {
        app: makeApp(),
        getConfig: () => CONFIG,
        dataDir,
      });
      for (const p of [
        "/api/predictions",
        "/api/actuals",
        "/api/environment",
        "/api/summary",
      ]) {
        assert.ok(router.routes.has(p), `missing route ${p}`);
      }

      const res = makeRes();
      await router.routes.get("/api/actuals")({ query: {} }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.match(res.body.message, /from.*to.*required/i);

      const res2 = makeRes();
      await router.routes.get("/api/actuals")(
        { query: { from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" } },
        res2,
      );
      assert.strictEqual(res2.statusCode, 400);
      assert.match(res2.body.message, /92 days/);
    });
  });

  test("routes serve fixture data end to end", async () => {
    await withFixtures(async (dataDir) => {
      const router = makeRouter();
      registerApiRoutes(router, {
        app: makeApp(),
        getConfig: () => CONFIG,
        dataDir,
      });
      const from = "2026-08-22T00:00:00Z";
      const to = "2026-08-22T02:00:00Z";

      const actuals = makeRes();
      await router.routes.get("/api/actuals")({ query: { from, to } }, actuals);
      assert.strictEqual(actuals.statusCode, null);
      assert.strictEqual(actuals.body.granularity, "5min");
      assert.ok(actuals.body.totals.solarWh > 0);

      const predictions = makeRes();
      await router.routes.get("/api/predictions")(
        { query: { from, to } },
        predictions,
      );
      assert.strictEqual(predictions.body.cycles.length, 1);

      const summary = makeRes();
      await router.routes.get("/api/summary")({ query: { from, to } }, summary);
      assert.ok(summary.body.predictionAccuracy.hoursCompared >= 1);
    });
  });

  test("GET /api/vessel returns the solar-local offset from the live position", async () => {
    await withFixtures(async (dataDir) => {
      const router = makeRouter();
      // 30°E → +120 minutes solar-local offset
      registerApiRoutes(router, {
        app: {
          debug() {},
          error() {},
          getSelfPath: () => ({
            value: { latitude: 0, longitude: 30 },
          }),
        },
        getConfig: () => CONFIG,
        dataDir,
      });
      const res = makeRes();
      await router.routes.get("/api/vessel")({}, res);
      assert.strictEqual(res.statusCode, null);
      assert.strictEqual(res.body.solarOffsetMinutes, 120);
    });
  });

  test("GET /api/vessel returns null offset when the position is unknown", async () => {
    await withFixtures(async (dataDir) => {
      const router = makeRouter();
      registerApiRoutes(router, {
        app: { debug() {}, error() {}, getSelfPath: () => null },
        getConfig: () => CONFIG,
        dataDir,
      });
      const res = makeRes();
      await router.routes.get("/api/vessel")({}, res);
      assert.strictEqual(res.statusCode, null);
      assert.strictEqual(res.body.solarOffsetMinutes, null);
    });
  });

  test("GET /api/retro-predicted responds cache-only: no network on the request path", async () => {
    await withFixtures(async (dataDir) => {
      // Blackholed uplink: a fetch would never settle. Before the fix a
      // cold weather cache made this endpoint hang (and with it the whole
      // webapp, which awaits all endpoints together) behind retries.
      const realFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = () => {
        fetchCalls++;
        return new Promise(() => {});
      };
      try {
        const router = makeRouter();
        registerApiRoutes(router, {
          app: makeApp(),
          getConfig: () => CONFIG,
          dataDir,
          // No getUplinkStatus: unknown uplink defaults to offline, so no
          // background warm either
        });
        const res = makeRes();
        await router.routes.get("/api/retro-predicted")(
          {
            query: { from: "2026-08-22T00:00:00Z", to: "2026-08-22T02:00:00Z" },
          },
          res,
        );
        assert.strictEqual(res.statusCode, null);
        // Window covers hours 00–02 → 3 hourly points, computed from local
        // records with empty (uncached) weather — served instantly
        assert.strictEqual(res.body.points.length, 3);
        assert.strictEqual(fetchCalls, 0);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  test("GET /api/retro-predicted warms the weather cache only on an unmetered online uplink", async () => {
    await withFixtures(async (dataDir) => {
      const realFetch = globalThis.fetch;
      let warmFetches = 0;
      let warmStarted;
      const started = new Promise((resolve) => {
        warmStarted = resolve;
      });
      globalThis.fetch = async () => {
        warmFetches++;
        warmStarted();
        return { ok: true, json: async () => ({ hourly: { time: [] } }) };
      };
      try {
        const router = makeRouter();
        registerApiRoutes(router, {
          app: makeApp(),
          getConfig: () => CONFIG,
          dataDir,
          getUplinkStatus: () => ({ online: true, metered: false }),
        });
        const res = makeRes();
        await router.routes.get("/api/retro-predicted")(
          {
            query: { from: "2026-08-22T00:00:00Z", to: "2026-08-22T02:00:00Z" },
          },
          res,
        );
        // The response itself is cache-only and did not wait for the warm
        assert.strictEqual(res.statusCode, null);
        assert.strictEqual(res.body.points.length, 3);
        await started;
        assert.strictEqual(warmFetches, 1);

        // A metered (volume-billed) uplink must never buy the download —
        // same rule as the forecast tiers
        let meteredFetches = 0;
        globalThis.fetch = async () => {
          meteredFetches++;
          return new Promise(() => {});
        };
        const meteredRouter = makeRouter();
        registerApiRoutes(meteredRouter, {
          app: makeApp(),
          getConfig: () => CONFIG,
          dataDir,
          getUplinkStatus: () => ({ online: true, metered: true }),
        });
        const meteredRes = makeRes();
        await meteredRouter.routes.get("/api/retro-predicted")(
          {
            query: { from: "2026-08-22T00:00:00Z", to: "2026-08-22T02:00:00Z" },
          },
          meteredRes,
        );
        assert.strictEqual(meteredRes.statusCode, null);
        assert.strictEqual(meteredFetches, 0);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });
});

test.describe("OpenAPI spec", () => {
  test("documents all API paths", () => {
    const documented = Object.keys(openApiSpec.paths);
    for (const p of [
      "/api/predictions",
      "/api/actuals",
      "/api/environment",
      "/api/summary",
    ]) {
      assert.ok(documented.includes(p), `missing ${p}`);
      assert.ok(openApiSpec.paths[p].get);
      // Both window parameters referenced
      const params = JSON.stringify(openApiSpec.paths[p].get.parameters);
      assert.match(params, /From/);
      assert.match(params, /To/);
    }
  });

  test("plugin exposes getOpenApi and registerWithRouter", () => {
    const createPlugin = require("../plugin/index.js");
    const plugin = createPlugin({
      debug() {},
      error() {},
      warn() {},
      setPluginStatus() {},
      getSelfPath: () => null,
      getDataDirPath: () => "/tmp",
      subscriptionmanager: {
        subscribe() {},
      },
      on: () => {},
    });
    assert.strictEqual(typeof plugin.registerWithRouter, "function");
    assert.strictEqual(typeof plugin.getOpenApi, "function");
    assert.deepStrictEqual(plugin.getOpenApi(), openApiSpec);
  });
});

test("buildDeployStates: detected transitions with carry-forward + collapsed recommendations", () => {
  const from = new Date("2026-06-01T00:00:00Z");
  const to = new Date("2026-08-24T00:00:00Z");
  // superwind stowed since June, deploys briefly in Aug. flinsail up then stowed.
  const samples = [
    {
      timestamp: "2026-06-15T12:00:00.000Z",
      deployStates: { superwind: "stowed", flinsail: "deployed" },
    },
    {
      timestamp: "2026-07-15T12:00:00.000Z",
      deployStates: { superwind: "stowed" },
    },
    {
      timestamp: "2026-08-23T12:00:00.000Z",
      deployStates: { superwind: "deployed", flinsail: "stowed" },
    },
    {
      timestamp: "2026-08-23T18:00:00.000Z",
      deployStates: { superwind: "stowed" },
    },
  ];
  const cycles = [
    {
      timestamp: "2026-08-23T08:00:00.000Z",
      forecast: [
        {
          time: "2026-08-23T08:00:00.000Z",
          actions: [
            {
              id: "flinsail",
              idealAction: "stow",
              detectedAction: "stow",
              reason: "gusts 22kn",
              idealState: "stowed",
            },
          ],
        },
        {
          time: "2026-08-23T16:00:00.000Z",
          actions: [
            {
              id: "flinsail",
              idealAction: "deploy",
              detectedAction: "deploy",
              reason: "gusts drop",
              idealState: "deployed",
            },
          ],
        },
      ],
    },
    {
      timestamp: "2026-08-23T08:15:00.000Z",
      forecast: [
        {
          time: "2026-08-23T08:15:00.000Z",
          actions: [
            {
              id: "flinsail",
              idealAction: "stow",
              detectedAction: "stow",
              reason: "gusts 22kn",
              idealState: "stowed",
            },
          ],
        },
      ],
    },
  ];
  const res = buildDeployStates(samples, cycles, from, to);
  // Detected: only transitions, carry-forward means no repeated stowed entries
  assert.deepStrictEqual(
    res.detected.map((d) => ({ time: d.time, id: d.id, state: d.state })),
    [
      { time: "2026-06-15T12:00:00.000Z", id: "superwind", state: "stowed" },
      { time: "2026-06-15T12:00:00.000Z", id: "flinsail", state: "deployed" },
      { time: "2026-08-23T12:00:00.000Z", id: "superwind", state: "deployed" },
      { time: "2026-08-23T12:00:00.000Z", id: "flinsail", state: "stowed" },
      { time: "2026-08-23T18:00:00.000Z", id: "superwind", state: "stowed" },
    ],
  );
  // Recommendations: collapsed across cycles, keyed by forecast hour
  assert.deepStrictEqual(
    res.recommendations.map((r) => ({
      time: new Date(r.time).toISOString(),
      id: r.id,
      action: r.action,
    })),
    [
      { time: "2026-08-23T08:00:00.000Z", id: "flinsail", action: "stow" },
      { time: "2026-08-23T16:00:00.000Z", id: "flinsail", action: "deploy" },
    ],
  );
});

test("buildDeployStates: empty inputs yield empty lists", () => {
  const res = buildDeployStates([], [], new Date(0), new Date(1));
  assert.deepStrictEqual(res.detected, []);
  assert.deepStrictEqual(res.recommendations, []);
  assert.deepStrictEqual(res.advisories, []);
});

test("buildDeployStates: advisories from recorded cycles, deduped + window-filtered", () => {
  const from = new Date("2026-08-23T00:00:00Z");
  const to = new Date("2026-08-23T23:59:00Z");
  // Two cycles report the same surplus window at 14:00; the newer cycle's
  // message wins. An engine-run advisory at 06:00 is inside the window; an
  // out-of-window surplus (next day) is dropped.
  const cycles = [
    {
      timestamp: "2026-08-23T08:00:00.000Z",
      advisories: [
        {
          type: "surplus",
          time: "2026-08-23T14:00:00.000Z",
          message: "1.2 kWh surplus available 14:00-18:00",
        },
      ],
    },
    {
      timestamp: "2026-08-23T08:15:00.000Z",
      advisories: [
        {
          type: "surplus",
          time: "2026-08-23T14:00:00.000Z",
          message: "1.5 kWh surplus available 14:00-19:00",
          surplusWh: 1500,
          from: "2026-08-23T14:00:00.000Z",
          to: "2026-08-23T19:00:00.000Z",
          sustainedW: 150,
          loads: [{ name: "Watermaker", watts: 150, runHours: 5 }],
        },
        {
          type: "engine_run",
          time: "2026-08-23T06:00:00.000Z",
          message:
            "Run engine for 1.5h between 06:00-07:30 to avoid low battery",
        },
        {
          type: "surplus",
          time: "2026-08-24T14:00:00.000Z",
          message: "Out-of-window surplus",
        },
      ],
    },
  ];
  const res = buildDeployStates([], cycles, from, to);
  assert.deepStrictEqual(
    res.advisories.map((a) => ({ type: a.type, message: a.message })),
    [
      {
        type: "engine_run",
        message: "Run engine for 1.5h between 06:00-07:30 to avoid low battery",
      },
      {
        type: "surplus",
        message: "1.5 kWh surplus available 14:00-19:00",
      },
    ],
  );
  // Structured surplus fields pass through verbatim so the UI can render
  // richer detail than the terse notification message.
  const surplus = res.advisories.find((a) => a.type === "surplus");
  assert.strictEqual(surplus.surplusWh, 1500);
  assert.deepStrictEqual(surplus.loads, [
    { name: "Watermaker", watts: 150, runHours: 5 },
  ]);
  // Detected/recommendations empty (no samples / no forecast actions)
  assert.deepStrictEqual(res.detected, []);
  assert.deepStrictEqual(res.recommendations, []);
});

test("buildDeployStates: advisory dedup keys on solar-local sun-day, not UTC", () => {
  // Two cycles forecast the same local-day surplus, but their window
  // starts straddle UTC midnight (UTC-10 offset): 13:46 local = 23:46 UTC
  // on Aug 23, and 14:05 local = 00:05 UTC on Aug 24. Keying on UTC date
  // would split them into two events; keying on the solar-local sun-day
  // collapses them to one, keeping the newest cycle's version.
  const from = new Date("2026-08-23T00:00:00Z");
  const to = new Date("2026-08-25T00:00:00Z");
  const cycles = [
    {
      timestamp: "2026-08-23T08:00:00.000Z",
      advisories: [
        {
          type: "surplus",
          time: "2026-08-23T23:46:00.000Z", // 13:46 local Aug 23
          message: "1.4kWh surplus available 13:46-17:46",
          surplusWh: 1400,
        },
      ],
    },
    {
      timestamp: "2026-08-23T08:15:00.000Z",
      advisories: [
        {
          type: "surplus",
          time: "2026-08-24T00:05:00.000Z", // 14:05 local Aug 23
          message: "1.6kWh surplus available 14:05-18:05",
          surplusWh: 1600,
        },
      ],
    },
  ];
  const res = buildDeployStates([], cycles, from, to, {
    solarOffsetMinutes: -10 * 60, // UTC-10
  });
  assert.strictEqual(res.advisories.length, 1);
  assert.strictEqual(res.advisories[0].surplusWh, 1600); // newest wins
});

test("offsetMinutesFromSamples: derives solar offset from most recent in-window sample", () => {
  // Longitude 150°E → +600 minutes (UTC+10). Older in-window sample at a
  // different longitude must NOT win over the most recent one.
  const from = new Date("2026-08-23T00:00:00Z");
  const to = new Date("2026-08-23T23:59:00Z");
  const samples = [
    {
      timestamp: "2026-08-23T06:00:00Z",
      position: { latitude: 0, longitude: 0 }, // would be 0 min
    },
    {
      timestamp: "2026-08-23T18:00:00Z",
      position: { latitude: 0, longitude: 150 }, // UTC+10
    },
  ];
  assert.strictEqual(offsetMinutesFromSamples(samples, from, to), 600);
});

test("offsetMinutesFromSamples: returns null when no in-window sample has position", () => {
  const from = new Date("2026-08-23T00:00:00Z");
  const to = new Date("2026-08-23T23:59:00Z");
  const samples = [
    { timestamp: "2026-08-23T06:00:00Z", position: null },
    { timestamp: "2026-08-23T18:00:00Z" }, // no position field
  ];
  assert.strictEqual(offsetMinutesFromSamples(samples, from, to), null);
});

test("buildDeployStates: advisories dedupe by calendar day across minute-drift between cycles", () => {
  // Each cycle's forecast is anchored at its own run timestamp, so the same
  // logical surplus window (bank hits full at ~14:00) is reported by
  // consecutive cycles with window starts that drift by minutes (14:00,
  // 14:08, 14:15). There is at most one surplus event per day, so these
  // must collapse to ONE event in the Events list keeping the newest
  // cycle's version — otherwise the list floods with near-duplicates every
  // cycle.
  const from = new Date("2026-08-23T00:00:00Z");
  const to = new Date("2026-08-23T23:59:00Z");
  const cycles = [
    {
      timestamp: "2026-08-23T08:00:00.000Z",
      advisories: [
        {
          type: "surplus",
          time: "2026-08-23T14:00:00.000Z",
          message: "1.2 kWh surplus available 14:00-18:00",
          surplusWh: 1200,
        },
      ],
    },
    {
      timestamp: "2026-08-23T08:08:00.000Z",
      advisories: [
        {
          type: "surplus",
          time: "2026-08-23T14:08:00.000Z",
          message: "1.5 kWh surplus available 14:08-19:08",
          surplusWh: 1500,
        },
      ],
    },
    {
      timestamp: "2026-08-23T08:15:00.000Z",
      advisories: [
        {
          type: "surplus",
          time: "2026-08-23T14:15:00.000Z",
          message: "1.6 kWh surplus available 14:15-19:15",
          surplusWh: 1600,
        },
      ],
    },
  ];
  const res = buildDeployStates([], cycles, from, to);
  assert.strictEqual(res.advisories.length, 1);
  assert.strictEqual(res.advisories[0].type, "surplus");
  // Newest cycle's version wins (last written for that date key)
  assert.strictEqual(res.advisories[0].surplusWh, 1600);
  assert.match(res.advisories[0].message, /14:15/);
});

test("buildDeployStates: stamp advisories with forecastAt (cycle run time)", () => {
  // Each emitted advisory carries the ISO timestamp of the cycle that
  // produced it, so the UI can show "as forecast at HH:MM" and let the
  // crew correlate a historical surplus with what actually happened.
  const from = new Date("2026-08-23T00:00:00Z");
  const to = new Date("2026-08-23T23:59:00Z");
  const cycles = [
    {
      timestamp: "2026-08-23T08:00:00.000Z",
      advisories: [
        {
          type: "surplus",
          time: "2026-08-23T14:00:00.000Z",
          message: "1.2 kWh surplus available 14:00-18:00",
          surplusWh: 1200,
        },
      ],
    },
    {
      timestamp: "2026-08-23T08:15:00.000Z",
      advisories: [
        {
          type: "surplus",
          time: "2026-08-23T14:15:00.000Z",
          message: "1.6 kWh surplus available 14:15-19:15",
          surplusWh: 1600,
        },
      ],
    },
  ];
  const res = buildDeployStates([], cycles, from, to);
  // Newest cycle's run time wins.
  assert.strictEqual(res.advisories[0].forecastAt, "2026-08-23T08:15:00.000Z");
  // Not stale: the newest covering cycle (08:15) is the one that produced it.
  assert.strictEqual(res.advisories[0].stale, false);
});

test("buildDeployStates: mark advisory stale when a newer cycle drops it", () => {
  // The Aug 23 08:00 cycle forecast a surplus for 14:00. A newer cycle at
  // 08:15 — whose forecast still covers the 14:00 hour — no longer flags a
  // surplus (the crew ran loads and consumed it, the weather changed, …).
  // The historical event is kept as a record but marked stale so the UI
  // doesn't present it as a live current opportunity.
  const from = new Date("2026-08-23T00:00:00Z");
  const to = new Date("2026-08-23T23:59:00Z");
  const cycles = [
    {
      timestamp: "2026-08-23T08:00:00.000Z",
      forecast: [{ time: "2026-08-23T14:00:00.000Z" }],
      advisories: [
        {
          type: "surplus",
          time: "2026-08-23T14:00:00.000Z",
          message: "1.2 kWh surplus available 14:00-18:00",
          surplusWh: 1200,
        },
      ],
    },
    {
      // Newer cycle covers the 14:00 hour but produced no surplus advisory
      timestamp: "2026-08-23T08:15:00.000Z",
      forecast: [{ time: "2026-08-23T14:00:00.000Z" }],
      advisories: [],
    },
  ];
  const res = buildDeployStates([], cycles, from, to);
  assert.strictEqual(res.advisories.length, 1);
  assert.strictEqual(res.advisories[0].surplusWh, 1200);
  assert.strictEqual(res.advisories[0].forecastAt, "2026-08-23T08:00:00.000Z");
  assert.strictEqual(res.advisories[0].stale, true);
});

test("buildDeployStates: not stale when a newer cycle still flags it", () => {
  // Both cycles cover the 14:00 hour and both emit a surplus; the newest
  // cycle's version wins and is NOT stale (the latest forecast still
  // confirms the surplus, just resized).
  const from = new Date("2026-08-23T00:00:00Z");
  const to = new Date("2026-08-23T23:59:00Z");
  const cycles = [
    {
      timestamp: "2026-08-23T08:00:00.000Z",
      forecast: [{ time: "2026-08-23T14:00:00.000Z" }],
      advisories: [
        {
          type: "surplus",
          time: "2026-08-23T14:00:00.000Z",
          message: "1.2 kWh surplus available 14:00-18:00",
          surplusWh: 1200,
        },
      ],
    },
    {
      timestamp: "2026-08-23T08:15:00.000Z",
      forecast: [{ time: "2026-08-23T14:00:00.000Z" }],
      advisories: [
        {
          type: "surplus",
          time: "2026-08-23T14:15:00.000Z",
          message: "1.6 kWh surplus available 14:15-19:15",
          surplusWh: 1600,
        },
      ],
    },
  ];
  const res = buildDeployStates([], cycles, from, to);
  assert.strictEqual(res.advisories.length, 1);
  assert.strictEqual(res.advisories[0].surplusWh, 1600);
  assert.strictEqual(res.advisories[0].stale, false);
});

test("buildDeployStates: not stale when no newer cycle covers the day", () => {
  // An older cycle's surplus for a day no newer cycle's forecast reaches is
  // still the authoritative forecast for that day — not stale. (A cycle
  // "covers" a day only if its forecast span intersects it; a cycle that ran
  // later but forecasted a shorter horizon not reaching the day doesn't
  // overtake it.)
  const from = new Date("2026-08-23T00:00:00Z");
  const to = new Date("2026-08-26T00:00:00Z");
  const cycles = [
    {
      // 48h forecast covers Aug 25
      timestamp: "2026-08-23T08:00:00.000Z",
      forecast: [
        { time: "2026-08-23T08:00:00.000Z" },
        { time: "2026-08-25T14:00:00.000Z" },
      ],
      advisories: [
        {
          type: "surplus",
          time: "2026-08-25T14:00:00.000Z",
          message: "3.1 kWh surplus available 14:00-18:00",
          surplusWh: 3100,
        },
      ],
    },
    {
      // Newer cycle at 08:15 but with a 24h horizon that doesn't reach Aug 25
      timestamp: "2026-08-23T08:15:00.000Z",
      forecast: [{ time: "2026-08-23T08:15:00.000Z" }],
      advisories: [],
    },
  ];
  const res = buildDeployStates([], cycles, from, to);
  const surplus = res.advisories.find((a) => a.type === "surplus");
  assert.ok(surplus, "surplus for Aug 25 is preserved");
  assert.strictEqual(surplus.stale, false);
  assert.strictEqual(surplus.forecastAt, "2026-08-23T08:00:00.000Z");
});

test("buildDeployStates: prior state from before window suppresses first-entry emission", () => {
  // Window is Aug 13-18. A sample from Aug 12 establishes superwind as
  // stowed, so the first in-window sample (Aug 13, also stowed) does NOT
  // emit a spurious "None -> stowed" transition.
  const from = new Date("2026-08-13T00:00:00Z");
  const to = new Date("2026-08-18T00:00:00Z");
  const samples = [
    {
      timestamp: "2026-08-12T23:00:00.000Z",
      deployStates: {
        superwind: "stowed",
        sailinggen: "stowed",
        flinsail: "deployed",
      },
    },
    {
      timestamp: "2026-08-13T00:00:00.000Z",
      deployStates: {
        superwind: "stowed",
        sailinggen: "stowed",
        flinsail: "deployed",
      },
    },
    {
      timestamp: "2026-08-13T17:10:00.000Z",
      deployStates: { sailinggen: "deployed" },
    },
    {
      timestamp: "2026-08-17T21:40:00.000Z",
      deployStates: { sailinggen: "stowed" },
    },
  ];
  const res = buildDeployStates(samples, [], from, to);
  // Only the genuine in-window transitions; no "None ->" entries.
  assert.deepStrictEqual(
    res.detected.map((d) => ({ time: d.time, id: d.id, state: d.state })),
    [
      { time: "2026-08-13T17:10:00.000Z", id: "sailinggen", state: "deployed" },
      { time: "2026-08-17T21:40:00.000Z", id: "sailinggen", state: "stowed" },
    ],
  );
});

test("buildDeployStates: suppresses recommendations matching current detected state", () => {
  // superwind is stowed (moored, not deployable). flinsail is deployed.
  // At night flinsail reads 0 W so its deploy state is absent from recent
  // samples — the carried-forward state from the last daylight sample
  // (deployed) must still suppress a redundant "deploy" recommendation.
  const from = new Date("2026-08-23T00:00:00Z");
  const to = new Date("2026-08-25T00:00:00Z");
  const samples = [
    {
      // Last daylight sample: flinsail deployed, superwind stowed.
      timestamp: "2026-08-23T04:25:00.000Z",
      deployStates: { flinsail: "deployed", superwind: "stowed" },
    },
    // Night samples: no flinsail entry (0 W, dark). superwind stays stowed.
    {
      timestamp: "2026-08-23T21:00:00.000Z",
      deployStates: { superwind: "stowed" },
    },
    {
      timestamp: "2026-08-24T00:00:00.000Z",
      deployStates: { superwind: "stowed" },
    },
  ];
  const cycles = [
    {
      timestamp: "2026-08-23T05:00:00.000Z",
      forecast: [
        {
          time: "2026-08-23T05:00:00.000Z",
          actions: [
            // superwind already stowed -> suppress.
            {
              id: "superwind",
              idealAction: "stow",
              reason: "cannot deploy while moored",
            },
            // flinsail already deployed -> suppress.
            { id: "flinsail", idealAction: "deploy", reason: "no night gusts" },
          ],
        },
        {
          time: "2026-08-23T21:00:00.000Z",
          actions: [
            // flinsail should stow (gusts) -> real change, keep.
            {
              id: "flinsail",
              idealAction: "stow",
              reason: "forecast gusts 21kn >= limit 20kn",
            },
          ],
        },
        {
          time: "2026-08-24T00:00:00.000Z",
          actions: [
            // flinsail should deploy again (gusts drop) -> real change, keep.
            {
              id: "flinsail",
              idealAction: "deploy",
              reason: "forecast gusts 12kn < limit 20kn",
            },
          ],
        },
      ],
    },
  ];
  const res = buildDeployStates(samples, cycles, from, to);
  // Only the genuine ideal-state changes: stow at 21:00, deploy at 00:00.
  // The redundant "stow superwind" and "deploy flinsail" at 05:00 are
  // suppressed because those devices are already in that state.
  assert.deepStrictEqual(
    res.recommendations.map((r) => ({
      time: new Date(r.time).toISOString(),
      id: r.id,
      action: r.action,
    })),
    [
      { time: "2026-08-23T21:00:00.000Z", id: "flinsail", action: "stow" },
      { time: "2026-08-24T00:00:00.000Z", id: "flinsail", action: "deploy" },
    ],
  );
});

test("buildDeployStates: a newer cycle overturns an older cycle's future stow (WPF learning / new forecast)", () => {
  // Cycle A (05:00) forecast a stow for tonight's 22:00 — the raw gust
  // breached the limit before WPF learning corrected it. Cycle B (11:00),
  // with WPF now applied, covers the same future hour and has NO flinsail
  // action there (the corrected gust no longer breaches). The 22:00 stow
  // from cycle A must be withdrawn — the current recommendation reflects
  // the latest forecast, not the stale one. Historical recs for hours no
  // newer cycle covers are preserved.
  const from = new Date("2026-08-23T00:00:00Z");
  const to = new Date("2026-08-25T00:00:00Z");
  const samples = [
    {
      timestamp: "2026-08-23T05:00:00.000Z",
      deployStates: { flinsail: "deployed" },
    },
  ];
  // Cycle A: stow at 22:00 (future), deploy at 02:00 (later still)
  const cycleA = {
    timestamp: "2026-08-23T05:00:00.000Z",
    forecast: [
      {
        time: "2026-08-23T05:00:00.000Z",
        actions: [],
      },
      {
        time: "2026-08-23T22:00:00.000Z",
        actions: [
          {
            id: "flinsail",
            idealAction: "stow",
            detectedAction: "stow",
            reason: "forecast night gusts up to 22kn ≥ limit 20kn",
            idealState: "stowed",
          },
        ],
      },
      {
        time: "2026-08-24T02:00:00.000Z",
        actions: [
          {
            id: "flinsail",
            idealAction: "deploy",
            detectedAction: "deploy",
            reason: "no night gusts",
            idealState: "deployed",
          },
        ],
      },
    ],
  };
  // Cycle B (newer): covers 11:00 onward through the same future hours but
  // records NO flinsail actions — WPF cleared the gusts, flinsail stays
  // deployed all night, no transitions. 48 hourly points from 11:00 Aug 23.
  const cycleB = {
    timestamp: "2026-08-23T11:00:00.000Z",
    forecast: Array.from({ length: 48 }, (_, h) => ({
      time: new Date(
        new Date("2026-08-23T11:00:00.000Z").getTime() + h * 3600000,
      ).toISOString(),
      actions: [],
    })),
  };
  const res = buildDeployStates(samples, [cycleA, cycleB], from, to);
  // The 22:00 stow and the 02:00 deploy from cycle A are both future hours
  // covered (and overturned) by cycle B → withdrawn entirely.
  assert.deepStrictEqual(
    res.recommendations.map((r) => ({
      time: new Date(r.time).toISOString(),
      id: r.id,
      action: r.action,
    })),
    [],
    "newer cycle overturning the future stow must withdraw it",
  );
});

test("buildDeployStates: historical recs for hours no newer cycle covers are preserved", () => {
  // Cycle A issued a stow for 22:00. Cycle B is newer but its forecast span
  // does NOT reach 22:00 (it only covers later hours), so 22:00 is still
  // authoritative from cycle A — the historical recommendation stands
  // because nothing newer revises it.
  const from = new Date("2026-08-23T00:00:00Z");
  const to = new Date("2026-08-26T00:00:00Z");
  const samples = [
    {
      timestamp: "2026-08-23T05:00:00.000Z",
      deployStates: { flinsail: "deployed" },
    },
  ];
  const cycleA = {
    timestamp: "2026-08-23T05:00:00.000Z",
    forecast: [
      {
        time: "2026-08-23T05:00:00.000Z",
        actions: [],
      },
      {
        time: "2026-08-23T22:00:00.000Z",
        actions: [
          {
            id: "flinsail",
            idealAction: "stow",
            detectedAction: "stow",
            reason: "forecast night gusts up to 22kn",
            idealState: "stowed",
          },
        ],
      },
    ],
  };
  // Cycle B is newer but only covers 25:00 onward (doesn't span 22:00).
  const cycleB = {
    timestamp: "2026-08-24T01:00:00.000Z",
    forecast: [
      { time: "2026-08-24T01:00:00.000Z", actions: [] },
      { time: "2026-08-24T02:00:00.000Z", actions: [] },
    ],
  };
  const res = buildDeployStates(samples, [cycleA, cycleB], from, to);
  assert.deepStrictEqual(
    res.recommendations.map((r) => ({
      time: new Date(r.time).toISOString(),
      id: r.id,
      action: r.action,
    })),
    [{ time: "2026-08-23T22:00:00.000Z", id: "flinsail", action: "stow" }],
    "historical rec for an hour no newer cycle covers must be preserved",
  );
});

test("buildDeployStates: cycles older than 24h before the latest are ignored for recommendations", () => {
  // A stow from 3 days ago is stale history — even if no newer cycle covers
  // that hour, it must not surface in the recommendation timeline. Only
  // cycles run within the past 24h of the latest cycle contribute recs.
  const from = new Date("2026-08-20T00:00:00Z");
  const to = new Date("2026-08-26T00:00:00Z");
  const samples = [
    {
      timestamp: "2026-08-20T05:00:00.000Z",
      deployStates: { flinsail: "deployed" },
    },
    {
      timestamp: "2026-08-23T11:00:00.000Z",
      deployStates: { flinsail: "deployed" },
    },
  ];
  // Old cycle (Aug 20, 3 days before the latest): stow at Aug 20 22:00.
  const oldCycle = {
    timestamp: "2026-08-20T05:00:00.000Z",
    forecast: [
      { time: "2026-08-20T05:00:00.000Z", actions: [] },
      {
        time: "2026-08-20T22:00:00.000Z",
        actions: [
          {
            id: "flinsail",
            idealAction: "stow",
            detectedAction: "stow",
            reason: "night gusts 22kn",
            idealState: "stowed",
          },
        ],
      },
    ],
  };
  // Latest cycle (Aug 23): no actions, flinsail stays deployed.
  const latestCycle = {
    timestamp: "2026-08-23T11:00:00.000Z",
    forecast: [
      { time: "2026-08-23T11:00:00.000Z", actions: [] },
      { time: "2026-08-23T12:00:00.000Z", actions: [] },
    ],
  };
  const res = buildDeployStates(samples, [oldCycle, latestCycle], from, to);
  assert.deepStrictEqual(
    res.recommendations.map((r) => ({
      time: new Date(r.time).toISOString(),
      id: r.id,
      action: r.action,
    })),
    [],
    "a rec from a cycle older than 24h before the latest must not surface",
  );
});
