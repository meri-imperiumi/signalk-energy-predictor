/**
 * Tests for polar-based boat speed estimation: parsing the active-polar
 * pointer, table interpolation, the prediction-engine wiring (hydro
 * yield, hourly actions, deploy/stow timing), and degradation when no
 * polar is available.
 *
 * @file polar.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseActivePolarId,
  parsePerformanceFactor,
  isInterpolatableTable,
  interpolatePolarSpeed,
  createPolarSpeedModel,
  loadActivePolarModel,
} = require("../plugin/polar.js");
const { PredictionEngine, msFromKnots } = require("../plugin/prediction.js");
const { parseManufacturerCurve } = require("../plugin/schema.js");

// --- Helpers --------------------------------------------------------------

/** Canonical polar table: tws [5, 10] m/s × twa [0.5, 1.5] rad. */
function makeTable({ symmetric = true } = {}) {
  return {
    kind: "polarTable",
    schemaVersion: "1.0.0",
    units: { tws: "m/s", twa: "rad", boatSpeed: "m/s" },
    symmetry: { portStarboardSymmetric: symmetric },
    axes: {
      tws: [5, 10],
      twa: [0.5, 1.5],
    },
    values: {
      // [twsIndex][twaIndex] in m/s
      boatSpeedMatrix: [
        [2, 4],
        [4, 8],
      ],
    },
  };
}

function makeFakeApp() {
  const pathValues = new Map();
  return {
    selfId: "self",
    debug() {},
    info() {},
    warn() {},
    error() {},
    getSelfPath(path) {
      return pathValues.get(path);
    },
    setSelfPath(path, value) {
      pathValues.set(path, value);
    },
    handleMessageCalls: [],
    handleMessage(source, msg) {
      this.handleMessageCalls.push({ source, msg });
    },
  };
}

const HYDRO = {
  id: "hydro",
  name: "Hydrogenerator",
  type: "hydro",
  deployable: true,
  manufacturerCurve: "3,0,4,20,5,60,6,120,7,200",
  minSpeedKnots: 4,
  maxSpeedKnots: 12,
  curve: parseManufacturerCurve("3,0,4,20,5,60,6,120,7,200"),
};

function makeEngine({
  navState = "sailing",
  stwKn = null,
  headingRad = 0,
  cogRad = null,
  gens = [HYDRO],
  polarModel = null,
} = {}) {
  const app = makeFakeApp();
  app.setSelfPath("navigation.state", navState);
  if (stwKn != null)
    app.setSelfPath("navigation.speedThroughWater", msFromKnots(stwKn));
  if (headingRad != null) app.setSelfPath("navigation.headingTrue", headingRad);
  if (cogRad != null)
    app.setSelfPath("navigation.courseOverGroundTrue", cogRad);
  app.setSelfPath("electrical.batteries.house.capacity.stateOfCharge", 0.5);

  return new PredictionEngine({
    battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
    solarArrays: [],
    mechanicalGenerators: gens,
    engines: [],
    getEfficiency: () => 0.7,
    getSelfPath: (path) => app.getSelfPath(path),
    app,
    getPolarModel: () => polarModel,
  });
}

/** Forecast with per-hour wind speed (kn) and a fixed wind direction. */
function makeForecast(windKnPerHour, windDirectionDeg = 90) {
  const now = new Date();
  return windKnPerHour.map((kn, h) => ({
    time: new Date(now.getTime() + h * 3600000),
    ghi: 0,
    cloudCover: 0.3,
    gustSpeedMs: msFromKnots(kn + 2),
    windSpeedMs: msFromKnots(kn),
    windDirectionDeg,
  }));
}

// --- Pointer parsing ------------------------------------------------------

test.describe("parseActivePolarId", () => {
  test("extracts id from a plain href", () => {
    assert.strictEqual(
      parseActivePolarId({ href: "/resources/polars/my-polar" }),
      "my-polar",
    );
  });

  test("extracts id from a full API URL", () => {
    assert.strictEqual(
      parseActivePolarId({
        href: "/signalk/v1/api/resources/polars/orc-1234",
      }),
      "orc-1234",
    );
  });

  test("unwraps the getSelfPath form", () => {
    assert.strictEqual(
      parseActivePolarId({ value: { href: "/resources/polars/x" } }),
      "x",
    );
  });

  test("null for unset, null value, or malformed href", () => {
    assert.strictEqual(parseActivePolarId(null), null);
    assert.strictEqual(parseActivePolarId({ href: null }), null);
    assert.strictEqual(
      parseActivePolarId({ href: "/resources/routes/1" }),
      null,
    );
    assert.strictEqual(parseActivePolarId({ something: "else" }), null);
  });
});

test.describe("parsePerformanceFactor", () => {
  test("passes through a valid factor", () => {
    assert.strictEqual(parsePerformanceFactor(0.8), 0.8);
    assert.strictEqual(parsePerformanceFactor({ value: 0.5 }), 0.5);
  });

  test("clamps out-of-range values", () => {
    assert.strictEqual(parsePerformanceFactor(1.7), 1);
    assert.strictEqual(parsePerformanceFactor(-0.2), 0);
  });

  test("defaults to 1 when unset or invalid", () => {
    assert.strictEqual(parsePerformanceFactor(null), 1);
    assert.strictEqual(parsePerformanceFactor("high"), 1);
  });
});

// --- Interpolation --------------------------------------------------------

test.describe("interpolatePolarSpeed", () => {
  const grid = (() => {
    const t = makeTable();
    return {
      tws: t.axes.tws,
      twa: t.axes.twa,
      matrix: t.values.boatSpeedMatrix,
      symmetric: true,
    };
  })();

  test("exact grid points", () => {
    assert.strictEqual(interpolatePolarSpeed(grid, 5, 0.5), 2);
    assert.strictEqual(interpolatePolarSpeed(grid, 5, 1.5), 4);
    assert.strictEqual(interpolatePolarSpeed(grid, 10, 1.5), 8);
  });

  test("bilinear midpoint", () => {
    // halfway in both axes: (2+4+4+8)/4 = 4.5
    assert.strictEqual(interpolatePolarSpeed(grid, 7.5, 1.0), 4.5);
  });

  test("symmetric: negative TWA mirrors positive", () => {
    assert.strictEqual(
      interpolatePolarSpeed(grid, 7.5, -1.0),
      interpolatePolarSpeed(grid, 7.5, 1.0),
    );
  });

  test("pinching below the minimum TWA scales toward zero", () => {
    // speed at twa 0.5 is 4 (tws 10); at half the angle -> 2
    assert.strictEqual(interpolatePolarSpeed(grid, 10, 0.25), 2);
    assert.strictEqual(interpolatePolarSpeed(grid, 10, 0), 0);
  });

  test("above the maximum TWA clamps to the last column", () => {
    assert.strictEqual(interpolatePolarSpeed(grid, 10, Math.PI), 8);
  });

  test("below the lightest TWS scales toward zero", () => {
    // speed at tws 5 is 4 (twa 1.5); at 2.5 m/s -> 2
    assert.strictEqual(interpolatePolarSpeed(grid, 2.5, 1.5), 2);
    assert.strictEqual(interpolatePolarSpeed(grid, 0, 1.5), 0);
  });

  test("above the strongest TWS clamps to the last row", () => {
    assert.strictEqual(interpolatePolarSpeed(grid, 25, 1.5), 8);
  });

  test("asymmetric tables keep TWA sign", () => {
    const asym = { ...grid, symmetric: false };
    // twa -1.0 clamps to 0 on a 0.5..1.5 axis -> pinch scaling
    assert.ok(interpolatePolarSpeed(asym, 7.5, -1.0) < 4.5);
  });
});

test.describe("isInterpolatableTable", () => {
  test("accepts a canonical table", () => {
    assert.strictEqual(isInterpolatableTable(makeTable()), true);
  });

  test("rejects malformed shapes", () => {
    assert.strictEqual(isInterpolatableTable(null), false);
    assert.strictEqual(isInterpolatableTable({}), false);
    assert.strictEqual(
      isInterpolatableTable({ axes: { tws: [5], twa: [1] }, values: {} }),
      false,
    );
    // matrix dimensions must match axes
    assert.strictEqual(
      isInterpolatableTable({
        axes: { tws: [5, 10], twa: [0.5, 1.5] },
        values: { boatSpeedMatrix: [[1, 2]] },
      }),
      false,
    );
    // axes must be ascending
    assert.strictEqual(
      isInterpolatableTable({
        axes: { tws: [10, 5], twa: [0.5, 1.5] },
        values: {
          boatSpeedMatrix: [
            [1, 2],
            [3, 4],
          ],
        },
      }),
      false,
    );
  });
});

test.describe("createPolarSpeedModel", () => {
  test("applies the performance factor", () => {
    const model = createPolarSpeedModel({
      id: "x",
      table: makeTable(),
      performanceFactor: 0.5,
    });
    assert.strictEqual(model.speedAt(10, 1.5), 4);
    assert.strictEqual(model.performanceFactor, 0.5);
  });

  test("null model for a malformed table", () => {
    assert.strictEqual(
      createPolarSpeedModel({ id: "x", table: { junk: true } }),
      null,
    );
  });
});

// --- Loader ---------------------------------------------------------------

test.describe("loadActivePolarModel", () => {
  test("loads the referenced resource and factor", async () => {
    const table = makeTable();
    const app = makeFakeApp();
    app.resourcesApi = {
      getResource: async (type, id) => {
        assert.strictEqual(type, "polars");
        assert.strictEqual(id, "my-polar");
        return table;
      },
    };
    const readValue = (p) =>
      p === "polars.activePolar"
        ? { href: "/resources/polars/my-polar" }
        : p === "polars.performanceFactor"
          ? 0.9
          : null;

    const { model, id } = await loadActivePolarModel({ app, readValue });
    assert.strictEqual(id, "my-polar");
    assert.strictEqual(model.id, "my-polar");
    assert.strictEqual(model.performanceFactor, 0.9);
    assert.strictEqual(model.speedAt(10, 1.5), 8 * 0.9);
  });

  test("null when no polar is active", async () => {
    const { model, id } = await loadActivePolarModel({
      app: makeFakeApp(),
      readValue: () => null,
    });
    assert.strictEqual(model, null);
    assert.strictEqual(id, null);
  });

  test("null when no resource provider API exists", async () => {
    const app = makeFakeApp();
    const { model } = await loadActivePolarModel({
      app,
      readValue: (p) =>
        p === "polars.activePolar" ? { href: "/resources/polars/x" } : null,
    });
    assert.strictEqual(model, null);
  });

  test("null when the provider rejects (not installed)", async () => {
    const app = makeFakeApp();
    app.resourcesApi = {
      getResource: async () => {
        throw new Error("No provider for polars");
      },
    };
    const { model } = await loadActivePolarModel({
      app,
      readValue: (p) =>
        p === "polars.activePolar" ? { href: "/resources/polars/x" } : null,
    });
    assert.strictEqual(model, null);
  });

  test("reuses the cached table when the id is unchanged", async () => {
    let fetches = 0;
    const app = makeFakeApp();
    app.resourcesApi = {
      getResource: async () => {
        fetches++;
        return makeTable();
      },
    };
    const readValue = () => ({ href: "/resources/polars/same" });

    const first = await loadActivePolarModel({ app, readValue });
    assert.strictEqual(fetches, 1);
    const second = await loadActivePolarModel({
      app,
      readValue,
      cachedId: first.id,
      cachedTable: first.table,
    });
    assert.strictEqual(fetches, 1);
    assert.ok(second.model);
  });
});

// --- Engine wiring --------------------------------------------------------

test.describe("PredictionEngine polar wiring", () => {
  // Heading north (0 rad), wind from 90° -> TWA = 90° (1.57 rad), which
  // clamps to the table's last TWA column (1.5 rad). Polar axes are m/s:
  //   TWS  6 kn = 3.09 m/s -> below the lightest column (5) -> scales to
  //          4 x 3.09/5 = 2.47 m/s ≈ 4.8 kn  (deploy band, curve ≈ 52 W)
  //   TWS 20 kn = 10.29 m/s -> above the strongest column (10) -> clamps
  //          to 8 m/s ≈ 15.6 kn (above the 12 kn stow limit)
  //   TWS2.5 kn = 1.29 m/s -> scales to 1.03 m/s ≈ 2.0 kn (below cut-in)
  const model = createPolarSpeedModel({ id: "t", table: makeTable() });

  test("hydro yield follows the polar estimate per hour", () => {
    const engine = makeEngine({ polarModel: model, headingRad: 0 });
    const hourly = engine.runPrediction(
      makeForecast([6, 6, 2.5, 2.5]),
      new Map(),
    );
    // 4.8 kn on the curve (4 kn=20 W, 5 kn=60 W) -> 52 Wh
    assert.ok(Math.abs(hourly[0].idealHydroYieldWh - 52) < 1.5);
    assert.strictEqual(hourly[2].idealHydroYieldWh, 0);
  });

  test("hourly actions carry the polar label", () => {
    const engine = makeEngine({ polarModel: model, headingRad: 0 });
    const hourly = engine.runPrediction(makeForecast([6]), new Map());
    const action = hourly[0].actions.find((a) => a.id === "hydro");
    assert.ok(action);
    assert.match(action.reason, /polar est\./);
  });

  test("recommendedStateTime: deploy when polar speed enters the band", () => {
    // Sailing below cut-in now (2 kn sustained): verdict is stowed, but
    // the polar says the wind builds to 6 kn (4.8 kn boat) at hour 2.
    const engine = makeEngine({
      polarModel: model,
      headingRad: 0,
      stwKn: 2,
    });
    engine.runPrediction(makeForecast([2.5, 2.5, 6, 6]), new Map());
    const recs = engine.getDeploymentRecommendations(new Map());
    const rec = recs.find((r) => r.id === "hydro");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.ok(rec.recommendedStateTime, "deploy time should be scheduled");
    assert.ok(
      Math.abs(
        new Date(rec.recommendedStateTime).getTime() - hourlyTime(engine, 2),
      ) < 60000,
    );
  });

  test("recommendedStateTime: stow when polar speed exceeds the limit", () => {
    // Sailing in the band now (5 kn sustained): verdict deployed, polar
    // says 20 kn wind (15.6 kn boat) at hour 1 -> stow trigger.
    const engine = makeEngine({
      polarModel: model,
      headingRad: 0,
      stwKn: 5,
    });
    engine.runPrediction(makeForecast([6, 20]), new Map());
    const recs = engine.getDeploymentRecommendations(new Map());
    const rec = recs.find((r) => r.id === "hydro");
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.ok(rec.recommendedStateTime);
    assert.ok(
      Math.abs(
        new Date(rec.recommendedStateTime).getTime() - hourlyTime(engine, 1),
      ) < 60000,
    );
  });

  test("no polar: timing stays null and observed speed is used", () => {
    const engine = makeEngine({ stwKn: 5, headingRad: 0 });
    engine.runPrediction(makeForecast([6, 20]), new Map());
    const recs = engine.getDeploymentRecommendations(new Map());
    const rec = recs.find((r) => r.id === "hydro");
    assert.strictEqual(rec.recommendedStateTime, null);
    // yield is the constant observed speed, not a per-hour estimate
    const hourly = engine.lastPrediction;
    assert.strictEqual(
      hourly[0].idealHydroYieldWh,
      hourly[1].idealHydroYieldWh,
    );
    assert.ok(hourly[0].idealHydroYieldWh > 0);
  });

  test("no wind direction in forecast: polar estimate declines", () => {
    const engine = makeEngine({ polarModel: model, headingRad: 0, stwKn: 5 });
    const forecast = makeForecast([6, 6]).map((p) => ({
      ...p,
      windDirectionDeg: null,
    }));
    engine.runPrediction(forecast, new Map());
    // falls back to observed constant
    const hourly = engine.lastPrediction;
    assert.strictEqual(
      hourly[0].idealHydroYieldWh,
      hourly[1].idealHydroYieldWh,
    );
  });

  test("not sailing: polar estimate is suppressed", () => {
    const engine = makeEngine({
      polarModel: model,
      navState: "motoring",
      stwKn: 5,
      headingRad: 0,
    });
    engine.runPrediction(makeForecast([6, 6]), new Map());
    const recs = engine.getDeploymentRecommendations(new Map());
    const rec = recs.find((r) => r.id === "hydro");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.strictEqual(rec.recommendedStateTime, null);
  });

  test("getGoodOutputHours counts polar-speed hours above cut-in", () => {
    const engine = makeEngine({ polarModel: model, headingRad: 0, stwKn: 2 });
    engine.runPrediction(makeForecast([6, 6, 2.5]), new Map());
    // hours 0-1 polar speed 4.8 kn >= cut-in; hour 2 drops to 2 kn -> stops
    assert.strictEqual(engine.getGoodOutputHours("hydro"), 2);
  });

  test("getPotentialYieldWh uses per-hour polar speeds", () => {
    const engine = makeEngine({ polarModel: model, headingRad: 0, stwKn: 2 });
    engine.runPrediction(makeForecast([6, 6]), new Map());
    const potential = engine.getPotentialYieldWh("hydro");
    // 2 hours at 52 W each
    assert.ok(Math.abs(potential - 104) < 3);
  });

  test("heading fallback to COG when headingTrue missing", () => {
    const engine = makeEngine({
      polarModel: model,
      headingRad: null,
      cogRad: 0,
    });
    const hourly = engine.runPrediction(makeForecast([6]), new Map());
    const withCog = hourly[0].idealHydroYieldWh;
    assert.ok(withCog > 0, "COG should stand in for heading");
  });
});

/** Timestamp of prediction hour h from the last run. */
function hourlyTime(engine, h) {
  return engine.lastPrediction[h].time.getTime();
}
