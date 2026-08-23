/**
 * Tests for history backfill: weather parsing, replay branching,
 * generator validation, recordings gap-fill, and populate integration.
 * @file backfill.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  fetchHistoricalWeather,
  interpolateWeather,
  replayHistory,
  replayGenerators,
  backfillSamples,
  populateFromHistory,
  historyHeaders,
  queryHistory,
} = require("../plugin/history-backfill.js");
const { SolarMatrix } = require("../plugin/learning.js");
const { getRecordings } = require("../plugin/recorder.js");

/** Latitude/longitude with a high sun at fixture noon (French Polynesia) */
const LAT = -18.86;
const LON = -159.8;
/** 2026-08-20T22:00Z = local noon */
const NOON = Date.parse("2026-08-20T22:00:00Z");

function makeWeather(t) {
  return [
    {
      time: new Date(t - 3600000),
      ghi: 700,
      cloudCover: null,
      windSpeedKnots: 15,
      gustSpeedKnots: 20,
      windDirectionDeg: 90,
    },
    {
      time: new Date(t),
      ghi: 800,
      cloudCover: null,
      windSpeedKnots: 15,
      gustSpeedKnots: 20,
      windDirectionDeg: 90,
    },
  ];
}

/** History /values fixture (anchored, no AWA, no power) */
function makeHistoryData() {
  return {
    values: [
      { path: "electrical.solar.test.power" },
      { path: "electrical.batteries.house.capacity.stateOfCharge" },
      { path: "navigation.state" },
      { path: "environment.wind.angleApparent" },
      { path: "navigation.speedThroughWater" },
      { path: "electrical.dcsource.wind.power" },
      { path: "electrical.venus.dcPower" },
      { path: "navigation.position" },
    ],
    data: [],
  };
}

/** Column order in makeHistoryData fixtures */
const COL = {
  solar: 1,
  soc: 2,
  navState: 3,
  awa: 4,
  stw: 5,
  windGen: 6,
  house: 7,
  position: 8,
};

/**
 * Pushes a history tick with named fields so column order can't be misread.
 * @param {object} historyData
 * @param {number} minutes - Offset from NOON in minutes
 * @param {object} vals - { solar, soc, navState, awa, stw, windGen, house, position }
 */
function pushTick(historyData, minutes, vals) {
  const row = [new Date(NOON + minutes * 60000).toISOString()];
  row[COL.solar] = vals.solar ?? null;
  row[COL.soc] = vals.soc ?? null;
  row[COL.navState] = vals.navState ?? null;
  row[COL.awa] = vals.awa ?? null;
  row[COL.stw] = vals.stw ?? null;
  row[COL.windGen] = vals.windGen ?? null;
  row[COL.house] = vals.house ?? null;
  row[COL.position] = vals.position ?? [LON, LAT];
  historyData.data.push(row);
}

test.describe("weather fetch", () => {
  test("archive query includes wind and parses UTC timestamps", async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: ["2026-08-20T22:00", "2026-08-20T23:00"],
            shortwave_radiation: [800, 750],
            cloud_cover: [null, null],
            wind_speed_10m: [27.782, 25.928], // → ~15 kn, ~14 kn
            wind_gusts_10m: [37.0, 35.0],
            wind_direction_10m: [90, 95],
          },
        }),
      };
    };

    const weather = await fetchHistoricalWeather({
      latitude: LAT,
      longitude: LON,
      from: new Date(NOON),
      to: new Date(NOON + 3600000),
      fetchImpl,
    });

    assert.match(urls[0], /wind_speed_10m/);
    assert.match(urls[0], /shortwave_radiation/);
    assert.strictEqual(weather.length, 2);
    // Naive timestamps parsed as UTC regardless of host timezone
    assert.strictEqual(
      weather[0].time.toISOString(),
      "2026-08-20T22:00:00.000Z",
    );
    // km/h → knots
    assert.ok(Math.abs(weather[0].windSpeedKnots - 15) < 0.01);
    assert.ok(Math.abs(weather[0].gustSpeedKnots - 19.98) < 0.01);
    assert.strictEqual(weather[0].windDirectionDeg, 90);
  });

  test("interpolation carries wind fields and rejects far matches", () => {
    const weather = makeWeather(NOON);
    const at = interpolateWeather(weather, new Date(NOON + 60000));
    assert.strictEqual(at.windSpeedKnots, 15);
    assert.strictEqual(at.gustSpeedKnots, 20);

    const far = interpolateWeather(weather, new Date(NOON + 5 * 3600000));
    assert.strictEqual(far.ghi, null);
    assert.strictEqual(far.windSpeedKnots, null);
  });
});

test.describe("replayHistory", () => {
  const array = {
    id: "test-array",
    powerPath: "electrical.solar.test.power",
    capacityWp: 100,
  };

  test("anchored ticks update the anchored matrix", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, { solar: 50, soc: 0.5, navState: "anchored" });
    }
    const matrix = new SolarMatrix("test-array");
    const stats = replayHistory({
      matrix,
      array,
      socPath: "electrical.batteries.house.capacity.stateOfCharge",
      historyData,
      weather: makeWeather(NOON),
      latitude: LAT,
      longitude: LON,
      resolution: 300,
    });

    assert.ok(stats.dataPoints > 0);
    assert.strictEqual(stats.sailingTicks, 0);
    assert.ok(stats.binUpdates > 0);
    assert.ok(stats.totalActualWh > 0);
    assert.ok(matrix.anchored.size > 0);
    assert.strictEqual(matrix.sailing.size, 0);
  });

  test("sailing ticks with AWA update the sailing matrix", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 50,
        soc: 0.5,
        navState: "sailing",
        awa: 0.5,
      });
    }
    const matrix = new SolarMatrix("test-array");
    const stats = replayHistory({
      matrix,
      array,
      socPath: "electrical.batteries.house.capacity.stateOfCharge",
      historyData,
      weather: makeWeather(NOON),
      latitude: LAT,
      longitude: LON,
      resolution: 300,
    });

    assert.strictEqual(stats.sailingTicks, stats.dataPoints);
    assert.ok(stats.sailingTicks > 0);
    assert.ok(matrix.sailing.size > 0);
  });

  test("navState is inferred from STW when navigation.state is absent", () => {
    // Many vessels never report navigation.state; without inference the
    // backfill treats every tick as anchored, killing sailing solar bins
    // and hydro predictions even while STW shows the boat underway.
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 50,
        soc: 0.5,
        navState: null, // no explicit nav state
        awa: 0.5,
        stw: 2.57222, // 5 knots in m/s
      });
    }
    const matrix = new SolarMatrix("test-array");
    const stats = replayHistory({
      matrix,
      array,
      socPath: "electrical.batteries.house.capacity.stateOfCharge",
      historyData,
      weather: makeWeather(NOON),
      latitude: LAT,
      longitude: LON,
      resolution: 300,
    });

    // Inferred as sailing from STW >= 2 kn, so sailing bins update
    assert.strictEqual(stats.sailingTicks, stats.dataPoints);
    assert.ok(matrix.sailing.size > 0);
  });

  test("navState defaults to anchored when STW is below threshold", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 50,
        soc: 0.5,
        navState: null,
        stw: 0.514444, // 1 knot in m/s, below 2 kn threshold
      });
    }
    const matrix = new SolarMatrix("test-array");
    const stats = replayHistory({
      matrix,
      array,
      socPath: "electrical.batteries.house.capacity.stateOfCharge",
      historyData,
      weather: makeWeather(NOON),
      latitude: LAT,
      longitude: LON,
      resolution: 300,
    });

    // Below 2 kn → anchored, no sailing bins
    assert.strictEqual(stats.sailingTicks, 0);
    assert.strictEqual(matrix.sailing.size, 0);
  });

  test("night ticks produce no theoretical power", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, { solar: 50, soc: 0.5, navState: "anchored" });
    }
    const night = Date.parse("2026-08-20T10:00:00Z"); // local midnight
    const matrix = new SolarMatrix("test-array");
    const stats = replayHistory({
      matrix,
      array,
      socPath: "electrical.batteries.house.capacity.stateOfCharge",
      historyData,
      weather: makeWeather(night),
      latitude: LAT,
      longitude: LON,
      resolution: 300,
    });
    assert.strictEqual(stats.dataPoints, 0);
  });
});

test.describe("replayGenerators", () => {
  test("wind generator prediction uses archive wind through the curve", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 0,
        soc: 0.5,
        navState: "anchored",
        windGen: 10,
      });
    }
    const results = replayGenerators({
      generators: [
        {
          id: "windgen",
          type: "wind",
          deployable: true,
          powerPath: "electrical.dcsource.wind.power",
          curve: [
            { speed: 5, watts: 5 },
            { speed: 10, watts: 15 },
            { speed: 15, watts: 55 },
            { speed: 20, watts: 140 },
          ],
        },
      ],
      historyData,
      weather: makeWeather(NOON), // 15 kn
      resolution: 300,
    });

    assert.strictEqual(results.length, 1);
    const r = results[0];
    assert.strictEqual(r.id, "windgen");
    assert.strictEqual(r.dataPoints, 6);
    // 6 ticks × 5 min at 55 W → 27.5 Wh → 28 rounded
    assert.ok(
      Math.abs(r.totalPredictedWh - 28) <= 1,
      `got ${r.totalPredictedWh}`,
    );
  });

  test("wind generator stows at moored when deployableAtMoored is false", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 0,
        soc: 0.5,
        navState: "moored",
        windGen: 0,
      });
    }
    const gen = {
      id: "windgen",
      type: "wind",
      deployable: true,
      deployableAtMoored: false,
      powerPath: "electrical.dcsource.wind.power",
      curve: [
        { speed: 5, watts: 5 },
        { speed: 10, watts: 15 },
        { speed: 15, watts: 55 },
      ],
    };
    const results = replayGenerators({
      generators: [gen],
      historyData,
      weather: makeWeather(NOON), // 15 kn
      resolution: 300,
    });
    // Moored + deployableAtMoored:false → stowed → 0 Wh
    assert.strictEqual(results[0].totalPredictedWh, 0);
  });

  test("wind generator deploys at moored when deployableAtMoored is true (default)", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 0,
        soc: 0.5,
        navState: "moored",
        windGen: 10,
      });
    }
    const gen = {
      id: "windgen",
      type: "wind",
      deployable: true,
      // deployableAtMoored omitted → default true
      powerPath: "electrical.dcsource.wind.power",
      curve: [
        { speed: 5, watts: 5 },
        { speed: 10, watts: 15 },
        { speed: 15, watts: 55 },
      ],
    };
    const results = replayGenerators({
      generators: [gen],
      historyData,
      weather: makeWeather(NOON),
      resolution: 300,
    });
    // Moored + default deployableAtMoored → deployed → 55 W × 6 ticks × 5min
    assert.ok(results[0].totalPredictedWh > 0);
  });

  test("navigation.state carries forward across gaps in backfill replay", () => {
    // First tick is explicitly moored; subsequent ticks have no nav state
    // and STW=0 (which would otherwise infer "anchored"). Carry-forward
    // must keep the wind generator stowed (deployableAtMoored:false) for
    // the whole run instead of flipping to anchored→deployed at the gaps.
    const historyData = makeHistoryData();
    pushTick(historyData, 0, {
      solar: 0,
      soc: 0.5,
      navState: "moored",
      windGen: 0,
      stw: 0,
    });
    for (let m = 5; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 0,
        soc: 0.5,
        navState: null, // gap: should carry "moored" forward
        windGen: 0,
        stw: 0,
      });
    }
    const gen = {
      id: "windgen",
      type: "wind",
      deployable: true,
      deployableAtMoored: false,
      powerPath: "electrical.dcsource.wind.power",
      curve: [
        { speed: 5, watts: 5 },
        { speed: 10, watts: 15 },
        { speed: 15, watts: 55 },
      ],
    };
    const results = replayGenerators({
      generators: [gen],
      historyData,
      weather: makeWeather(NOON), // 15 kn — enough to deploy if at anchor
      resolution: 300,
    });
    // Carried moored → stowed for every tick → 0 Wh. Without carry-forward
    // the gaps would infer anchored and produce >0 Wh.
    assert.strictEqual(results[0].totalPredictedWh, 0);
  });

  test("hydro generator requires sailing and speed", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      // stw column = 4 m/s ≈ 7.8 kn (above min)
      pushTick(historyData, m, { stw: 4, soc: 0.5, navState: "anchored" });
    }
    const results = replayGenerators({
      generators: [
        {
          id: "hydrogen",
          type: "hydro",
          deployable: true,
          powerPath: "electrical.dcsource.wind.power",
          curve: [
            { speed: 4, watts: 24 },
            { speed: 5, watts: 48 },
          ],
        },
      ],
      historyData,
      weather: makeWeather(NOON),
      resolution: 300,
    });
    // Not sailing → engine predicts stowed → 0
    assert.strictEqual(results[0].totalPredictedWh, 0);
  });
});

test.describe("recordings gap-fill", () => {
  test("replayed ticks skip timestamps near live samples", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-gap-"));
    try {
      const { recordSample } = require("../plugin/recorder.js");
      // Live sample at noon sharp
      await recordSample({ debug() {} }, dataDir, {
        timestamp: new Date(NOON),
        arrays: { live: 1 },
        generators: {},
        soc: 0.5,
        houseLoadW: 50,
        windSpeedKnots: 5,
        navState: "anchored",
        position: null,
      });

      const historyData = makeHistoryData();
      for (let m = -10; m <= 10; m += 5) {
        pushTick(historyData, m, { solar: 50, soc: 0.5, navState: "anchored" });
      }

      const written = await backfillSamples({
        app: { debug() {} },
        dataDir,
        historyData,
        weather: makeWeather(NOON),
        arrays: [
          {
            id: "test-array",
            powerPath: "electrical.solar.test.power",
          },
        ],
        generators: [],
        socPath: "electrical.batteries.house.capacity.stateOfCharge",
        from: new Date(NOON - 3600000),
        to: new Date(NOON + 3600000),
      });

      // 5 ticks, but the one at noon (±2.5 min) is a live sample
      assert.strictEqual(written, 4);

      const samples = await getRecordings(
        dataDir,
        new Date(NOON - 3600000),
        new Date(NOON + 3600000),
        "sample",
      );
      assert.strictEqual(samples.length, 5);
      // The noon bucket keeps the live sample (arrays: {live: 1}), not a replayed one
      const noon = samples.find(
        (s) => Math.abs(Date.parse(s.timestamp) - NOON) < 60000,
      );
      assert.deepStrictEqual(noon.arrays, { live: 1 });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

test.describe("populateFromHistory", () => {
  test("full flow: matrices, generator stats, samples written", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-pop-"));
    try {
      const config = {
        battery: {
          socPath: "electrical.batteries.house.capacity.stateOfCharge",
        },
        solarArrays: [
          {
            id: "test-array",
            powerPath: "electrical.solar.test.power",
            capacityWp: 100,
          },
        ],
        mechanicalGenerators: [
          {
            id: "windgen",
            type: "wind",
            powerPath: "electrical.dcsource.wind.power",
            manufacturerCurve: "5,5,15,55,20,140",
          },
        ],
      };

      const historyData = makeHistoryData();
      for (let m = 0; m < 30; m += 5) {
        // solar 50 W, wind gen 20 W actual
        pushTick(historyData, m, {
          solar: 50,
          soc: 0.5,
          navState: "anchored",
          windGen: 20,
        });
      }

      const fetchImpl = async (url) => {
        const u = String(url);
        if (u.includes("/history/values")) {
          return { ok: true, json: async () => historyData };
        }
        if (u.includes("/history/paths")) {
          return { ok: true, json: async () => ["propulsion.main.state"] };
        }
        if (u.includes("archive-api")) {
          return {
            ok: true,
            json: async () => ({
              hourly: {
                time: ["2026-08-20T22:00"],
                shortwave_radiation: [800],
                cloud_cover: [null],
                wind_speed_10m: [27.782], // → ~15 kn
                wind_gusts_10m: [37],
                wind_direction_10m: [90],
              },
            }),
          };
        }
        throw new Error(`unexpected url ${u}`);
      };

      const result = await populateFromHistory({
        config,
        baseUrl: "http://localhost:3000",
        from: new Date(NOON - 3600000),
        to: new Date(NOON + 3600000),
        latitude: LAT,
        longitude: LON,
        dataDir,
        resolution: 300,
        fetchImpl,
      });

      // Solar matrix learned
      assert.strictEqual(result.arrays.length, 1);
      assert.ok(result.arrays[0].binUpdates > 0);
      // Matrix persisted to data dir
      const matrixFile = path.join(dataDir, "solar-matrix-test-array.json");
      const persisted = JSON.parse(await fs.readFile(matrixFile, "utf8"));
      assert.ok(
        persisted.anchored && Object.keys(persisted.anchored).length > 0,
      );

      // Generator replayed with validation stats
      assert.strictEqual(result.generators.length, 1);
      assert.strictEqual(result.generators[0].id, "windgen");
      assert.ok(result.generators[0].totalPredictedWh > 0);

      // Samples gap-filled into recordings
      assert.strictEqual(result.samplesWritten, 6);
      const samples = await getRecordings(
        dataDir,
        new Date(NOON - 3600000),
        new Date(NOON + 3600000),
        "sample",
      );
      assert.strictEqual(samples.length, 6);
      assert.ok(Math.abs(samples[0].windSpeedKnots - 15) < 0.1);
      // Solar power recorded into the sample's arrays map
      assert.strictEqual(samples[0].arrays["test-array"], 50);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("fresh: true wipes existing matrices and rebuilds from scratch", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-fresh-"));
    try {
      const config = {
        battery: {
          socPath: "electrical.batteries.house.capacity.stateOfCharge",
        },
        solarArrays: [
          {
            id: "test-array",
            powerPath: "electrical.solar.test.power",
            capacityWp: 100,
          },
        ],
        mechanicalGenerators: [],
      };

      const historyData = makeHistoryData();
      for (let m = 0; m < 30; m += 5) {
        pushTick(historyData, m, { solar: 50, soc: 0.5, navState: "anchored" });
      }

      const fetchImpl = async (url) => {
        const u = String(url);
        if (u.includes("/history/values")) {
          return { ok: true, json: async () => historyData };
        }
        if (u.includes("/history/paths")) {
          return { ok: true, json: async () => [] };
        }
        if (u.includes("archive-api")) {
          return {
            ok: true,
            json: async () => ({
              hourly: {
                time: ["2026-08-20T22:00"],
                shortwave_radiation: [800],
                cloud_cover: [null],
                wind_speed_10m: [27.782],
                wind_gusts_10m: [37],
                wind_direction_10m: [90],
              },
            }),
          };
        }
        throw new Error(`unexpected url ${u}`);
      };

      // First run: seeds a matrix from scratch
      await populateFromHistory({
        config,
        baseUrl: "http://localhost:3000",
        from: new Date(NOON - 3600000),
        to: new Date(NOON + 3600000),
        latitude: LAT,
        longitude: LON,
        dataDir,
        resolution: 300,
        fetchImpl,
      });
      const matrixFile = path.join(dataDir, "solar-matrix-test-array.json");
      const firstRun = JSON.parse(await fs.readFile(matrixFile, "utf8"));
      const firstBinCount = Object.keys(firstRun.anchored).length;
      assert.ok(firstBinCount > 0);

      // Second run with fresh: true wipes and rebuilds — same data, same bins
      const result2 = await populateFromHistory({
        config,
        baseUrl: "http://localhost:3000",
        from: new Date(NOON - 3600000),
        to: new Date(NOON + 3600000),
        latitude: LAT,
        longitude: LON,
        dataDir,
        fresh: true,
        resolution: 300,
        fetchImpl,
      });
      assert.strictEqual(result2.arrays[0].seeded, false);
      const secondRun = JSON.parse(await fs.readFile(matrixFile, "utf8"));
      // Rebuilt from scratch: same bin count, not double-applied
      assert.strictEqual(Object.keys(secondRun.anchored).length, firstBinCount);
      // Values should be identical (same input, fresh EMA from default)
      const firstVal = Object.values(firstRun.anchored)[0];
      const secondVal = Object.values(secondRun.anchored)[0];
      assert.ok(Math.abs(firstVal - secondVal) < 0.001);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

test.describe("auth headers", () => {
  test("SIGNALK_TOKEN env becomes a bearer header", () => {
    const saved = process.env.SIGNALK_TOKEN;
    process.env.SIGNALK_TOKEN = "test-token";
    try {
      assert.deepStrictEqual(historyHeaders(), {
        Accept: "application/json",
        Authorization: "Bearer test-token",
      });
      assert.deepStrictEqual(historyHeaders("other"), {
        Accept: "application/json",
        Authorization: "Bearer other",
      });
    } finally {
      if (saved == null) {
        delete process.env.SIGNALK_TOKEN;
      } else {
        process.env.SIGNALK_TOKEN = saved;
      }
    }
  });
});

test.describe("queryHistory", () => {
  test("textual .state paths get :last method, numeric paths stay default", async () => {
    let capturedUrl;
    const fakeFetch = async (input) => {
      capturedUrl = new URL(input);
      return {
        ok: true,
        json: async () => ({
          values: [
            { path: "navigation.state", method: "last" },
            { path: "propulsion.main.state", method: "last" },
            { path: "navigation.speedThroughWater", method: "average" },
          ],
          data: [],
        }),
      };
    };
    await queryHistory({
      baseUrl: "http://example.test",
      from: new Date("2026-08-15T00:00:00Z"),
      to: new Date("2026-08-15T23:59:59Z"),
      paths: [
        "navigation.state",
        "propulsion.main.state",
        "navigation.speedThroughWater",
      ],
      fetchImpl: fakeFetch,
    });
    const pathsParam = capturedUrl.searchParams.get("paths");
    assert.ok(
      pathsParam.includes("navigation.state:last"),
      "navigation.state must get :last",
    );
    assert.ok(
      pathsParam.includes("propulsion.main.state:last"),
      "propulsion state must get :last",
    );
    assert.ok(
      !pathsParam.includes("speedThroughWater:last"),
      "numeric path must not get :last",
    );
  });
});
