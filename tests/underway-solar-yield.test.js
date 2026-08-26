/**
 * Smoketests for the ideal-track deployable-solar navigation gate.
 *
 * The ideal track must only count a deployable solar array (FLINsail) in
 * hours whose ideal state is "deployed" (computeDeployableSolarStates stows
 * it under way, in gusts, and before gusty nights). Before the gate, the
 * ideal-yield loop added predictSolarHour() output unconditionally — the
 * gust gate was its only gate — so the ideal track counted FLINsail Wh
 * while sailing in sub-limit gusts, inflating idealSoC (work doc #15
 * update #4) and suppressing the combustion run gates (work doc #11).
 *
 * @file underway-solar-yield.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PredictionEngine, msFromKnots } = require("../plugin/prediction.js");
const { parseManufacturerCurve } = require("../plugin/schema.js");

// --- Helpers (mirrors deployment.test.js) ---

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

function makeEngine({ navState, solarArrays, generators, speedKnots } = {}) {
  const app = makeFakeApp();
  app.setSelfPath("navigation.state", navState);
  app.setSelfPath("electrical.batteries.house.capacity.stateOfCharge", 0.5);
  if (speedKnots != null) {
    app.setSelfPath("navigation.speedThroughWater", speedKnots / 1.94384);
  }
  return new PredictionEngine({
    battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
    solarArrays: solarArrays || [],
    mechanicalGenerators: (generators || []).map((g) => ({
      ...g,
      curve: parseManufacturerCurve(g.manufacturerCurve),
    })),
    gensets: [],
    engines: [],
    getEfficiency: () => 0.7,
    getSelfPath: (path) => app.getSelfPath(path),
    app,
  });
}

/** Calm, sunny forecast: gusts well below the 20 kn FLINsail limit. */
function calmSunnyForecast() {
  const now = new Date();
  return Array.from({ length: 24 }, (_, h) => ({
    time: new Date(now.getTime() + h * 3600000),
    ghi: 500,
    cloudCover: 0.2,
    gustSpeedMs: msFromKnots(10),
    windSpeedMs: msFromKnots(8),
  }));
}

const FLINSAIL = {
  id: "flinsail",
  type: "deployable",
  capacityWp: 300,
  gustLimitKnots: 20,
};

const HYDRO = {
  id: "hydrogen",
  type: "hydro",
  deployable: true,
  manufacturerCurve: "3,50,6,200,10,400,12,450",
};

test.describe("Ideal-track yield: deployable solar under way", () => {
  test("FLINsail contributes 0 Wh to the ideal track on every hour while sailing", () => {
    const engine = makeEngine({
      navState: "sailing",
      solarArrays: [FLINSAIL],
      generators: [HYDRO],
      speedKnots: 5,
    });
    const predictions = engine.runPrediction(calmSunnyForecast());

    assert.strictEqual(predictions.length, 24);
    for (const p of predictions) {
      assert.strictEqual(
        p.idealSolarYieldWh,
        0,
        `hour ${p.hour} counted deployable solar while under way`,
      );
    }
    // The under-way source covers generation instead: hydro yields at 5 kn.
    assert.ok(
      predictions.some((p) => p.idealHydroYieldWh > 0),
      "hydro should yield while sailing at 5 kn",
    );
  });

  test("same forecast at anchor yields FLINsail in the ideal track (control)", () => {
    // Proves the sailing zeros come from the nav-state gate, not from the
    // forecast/sun: same calm sunny forecast, same array, but at rest.
    const engine = makeEngine({
      navState: "anchored",
      solarArrays: [FLINSAIL],
    });
    const predictions = engine.runPrediction(calmSunnyForecast());

    assert.ok(
      predictions.some((p) => p.idealSolarYieldWh > 0),
      "FLINsail should yield in daylight hours at anchor",
    );
  });

  test("fixed arrays are not gated by navigation state", () => {
    const engine = makeEngine({
      navState: "sailing",
      solarArrays: [{ id: "arch", type: "fixed", capacityWp: 300 }],
    });
    const predictions = engine.runPrediction(calmSunnyForecast());

    assert.ok(
      predictions.some((p) => p.idealSolarYieldWh > 0),
      "fixed solar should yield in daylight hours under way",
    );
  });

  test("detected track keeps modeling reality: stowed FLINsail at anchor yields 0", () => {
    const engine = makeEngine({
      navState: "anchored",
      solarArrays: [FLINSAIL],
    });
    const stowed = new Map([["flinsail", "stowed"]]);
    const predictions = engine.runPrediction(calmSunnyForecast(), stowed);

    for (const p of predictions) {
      assert.strictEqual(p.detectedYieldWh, 0, `hour ${p.hour}`);
    }
  });

  test("detected FLINsail actually producing under way counts in the detected track", () => {
    // Reality can differ from the ideal (owner left it up): the detected
    // track models the watts it is really making via skipStowGate.
    const engine = makeEngine({
      navState: "sailing",
      solarArrays: [FLINSAIL],
    });
    const deployed = new Map([["flinsail", "deployed"]]);
    const predictions = engine.runPrediction(calmSunnyForecast(), deployed);

    assert.ok(
      predictions.some((p) => p.detectedYieldWh > 0),
      "detected-deployed FLINsail should yield in daylight hours",
    );
    // …while the ideal track stays honest about the recommendation.
    for (const p of predictions) {
      assert.strictEqual(p.idealSolarYieldWh, 0, `hour ${p.hour}`);
    }
  });
});
