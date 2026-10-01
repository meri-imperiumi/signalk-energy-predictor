/**
 * Smoketests for deploy-state hysteresis in the live prediction cycle.
 *
 * On a rainy, overcast morning just after sunrise a deployed FLINsail's
 * output hovers around zero, flickering between 0 W and fractions of a
 * watt. The pre-hysteresis inference (power > 0 → deployed, 0 W with the
 * sun up → stowed) flapped the detected state on every sample, producing
 * multiple deploy/stow detections. The live cycle now reads the same
 * 5-minute window average the generators use, and the shared detector
 * holds the previous state for sub-threshold positive output (dead band):
 * only output above a capacity-scaled threshold confirms deployed, and a
 * window-average of exactly 0 W with the sun up confirms stowed.
 *
 * @file deploy-hysteresis.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EventEmitter } = require("node:events");

const makePlugin = require("../plugin/index.js");

class FakeStreamBundle {
  constructor() {
    this.subscriptions = [];
  }
  getdelta(subscription, errorHandler, deltaHandler) {
    this.subscriptions.push({ subscription, errorHandler, deltaHandler });
    return () => {};
  }
}
class FakeSubscriptionManager {
  constructor() {
    this.subscriptions = [];
  }
  subscribe(subscription, unsubscribes, errorHandler, deltaHandler) {
    this.subscriptions.push({ subscription, errorHandler, deltaHandler });
    unsubscribes.push(() => {});
  }
}
class FakeSignalKApp extends EventEmitter {
  constructor() {
    super();
    this.selfId = "urn:mrn:imo:mmsi:123456789";
    this.streambundle = new FakeStreamBundle();
    this.subscriptionmanager = new FakeSubscriptionManager();
    this.dataPath = null;
    this.pathValues = new Map();
    this.handleMessageCalls = [];
  }
  getSelfPath(path) {
    return this.pathValues.get(path);
  }
  setSelfPath(path, value) {
    this.pathValues.set(path, value);
    this.emit("delta", { path, value });
  }
  getDataDirPath() {
    return this.dataPath;
  }
  setPluginStatus() {}
  setProviderStatus() {}
  handleMessage(source, message) {
    this.handleMessageCalls.push({ source, message });
  }
  debug() {}
  error(msg) {
    this.errors = this.errors || [];
    this.errors.push(msg);
  }
}

/**
 * Longitude that puts the sun near local noon (high) at the equator,
 * regardless of when the test runs. The sun is well above the ~5° stow
 * gate, so 0 W would be stow evidence — exactly the overcast-day case.
 */
function noonLongitude() {
  const now = new Date();
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  return (12 - utcHours) * 15;
}

/** Emits a delta to all subscribed handlers (populates deltaState). */
function emit(app, values, timestamp) {
  const update = { values };
  if (timestamp) update.timestamp = timestamp;
  app.subscriptionmanager.subscriptions.forEach(({ deltaHandler }) => {
    deltaHandler({ context: app.selfId, updates: [update] });
  });
}

/** Finds the most recent detectedState delta published for a device. */
function lastDetectedState(app, deviceId) {
  const path = `electrical.energy.prediction.deployment.${deviceId}.detectedState`;
  for (let i = app.handleMessageCalls.length - 1; i >= 0; i--) {
    const msg = app.handleMessageCalls[i].message;
    const updates = msg?.updates || [];
    for (const u of updates) {
      const vals = u?.values || [];
      for (const v of vals) {
        if (v.path === path) return v.value;
      }
    }
  }
  return undefined;
}

const FLINSAIL_POWER = "electrical.solar.flinsail.panelPower";
const WIND_POWER = "electrical.wind.superwind.power";
const WIND_SPEED = "environment.wind.speedApparent";
const SOC_PATH = "electrical.batteries.house.capacity.stateOfCharge";

function baseConfig() {
  return {
    battery: {
      capacityAh: 400,
      systemVoltage: 12,
      minSafeSoC: 0.2,
      socPath: SOC_PATH,
    },
    solarArrays: [
      {
        id: "flinsail",
        type: "deployable",
        capacityWp: 400, // deploy-confirm threshold: 400 Wp * 0.5% = 2 W
        powerPath: FLINSAIL_POWER,
        enabled: true,
        gustLimitKnots: 25,
      },
    ],
    mechanicalGenerators: [],
    weather: { openMeteoEnabled: false, useLogbook: false, forecastHours: 24 },
    updateIntervalMinutes: 9999, // disable the scheduled cycle
    learning: { enabled: false },
  };
}

function windConfig() {
  const config = baseConfig();
  config.solarArrays = [];
  config.mechanicalGenerators = [
    {
      id: "superwind",
      type: "wind",
      deployable: true,
      maxWindKnots: 30,
      startupSpeedKnots: 5, // stow-confirm threshold: 5 kn * 1.5 = 7.5 kn
      powerPath: WIND_POWER,
      manufacturerCurve: "5,10,10,50,15,100,20,150,25,200,30,250",
      enabled: true,
    },
  ];
  return config;
}

/** Injects a minimal forecast (night solar, steady wind) into the FSM. */
function injectForecast(plugin) {
  const fsm = plugin.__getInternals().ingestionFSM;
  const now = new Date();
  const points = [];
  for (let h = 0; h < 24; h++) {
    points.push({
      time: new Date(now.getTime() + h * 3600000),
      windSpeedMs: 2.6,
      gustSpeedMs: 4.1,
      windDirectionDeg: 180,
      ghi: 0,
      temperatureC: 20,
      speedThroughWaterKnots: 0,
    });
  }
  fsm.lastForecast = points;
  fsm.lastFetchTime = new Date();
  fsm.currentTier = 4; // Clear Sky tier (no network)
}

test.describe("deploy-state hysteresis in the live cycle", () => {
  test("overcast 0↔0.4 W flicker does not flap the detected state", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const testDir = await mkdtemp(join(tmpdir(), "hysteresis-flap-"));

    app.dataPath = testDir;
    await plugin.start(baseConfig(), () => {});

    // Sun high (local noon at the equator): 0 W would count as stow
    // evidence on a clear day — the flicker is pure overcast noise.
    const longitude = noonLongitude();
    app.setSelfPath("navigation.position", { latitude: 0, longitude });
    emit(app, [
      { path: "navigation.position", value: { latitude: 0, longitude } },
    ]);
    app.setSelfPath("navigation.state", "anchored");
    emit(app, [{ path: "navigation.state", value: "anchored" }]);
    app.setSelfPath(SOC_PATH, 0.6);
    emit(app, [{ path: SOC_PATH, value: 0.6 }]);

    // Last known state: deployed (recorded while yesterday's sun lasted)
    const recorder = plugin.__getInternals().recorder;
    await recorder.recordSample({
      timestamp: new Date(),
      arrays: { flinsail: 0 },
      generators: {},
      soc: 0.6,
      houseLoadW: 100,
      windSpeedKnots: 5,
      navState: "anchored",
      position: { latitude: 0, longitude },
      stwKnots: null,
      deployStates: { flinsail: "deployed" },
      controllerModes: {},
      awaRad: null,
    });

    injectForecast(plugin);
    const cycle = () => plugin.__getInternals().runPredictionCycle();

    // The overcast flicker: alternate sub-threshold and 0 W readings,
    // running a prediction cycle after each — pre-hysteresis every 0 W
    // cycle published "stowed" and every positive one "deployed".
    for (const powerW of [0.4, 0, 0.4, 0, 0.3, 0]) {
      app.setSelfPath(FLINSAIL_POWER, powerW);
      emit(app, [{ path: FLINSAIL_POWER, value: powerW }]);
      await cycle();
      assert.strictEqual(
        lastDetectedState(app, "flinsail"),
        "deployed",
        `flicker sample ${powerW} W must hold the deployed state`,
      );
    }

    await plugin.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  test("sustained 0 W still confirms stowed; recovery needs real output", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const testDir = await mkdtemp(join(tmpdir(), "hysteresis-stow-"));

    app.dataPath = testDir;
    await plugin.start(baseConfig(), () => {});

    const longitude = noonLongitude();
    app.setSelfPath("navigation.position", { latitude: 0, longitude });
    emit(app, [
      { path: "navigation.position", value: { latitude: 0, longitude } },
    ]);
    app.setSelfPath("navigation.state", "anchored");
    emit(app, [{ path: "navigation.state", value: "anchored" }]);
    app.setSelfPath(SOC_PATH, 0.6);
    emit(app, [{ path: SOC_PATH, value: 0.6 }]);

    const recorder = plugin.__getInternals().recorder;
    await recorder.recordSample({
      timestamp: new Date(),
      arrays: { flinsail: 0 },
      generators: {},
      soc: 0.6,
      houseLoadW: 100,
      windSpeedKnots: 5,
      navState: "anchored",
      position: { latitude: 0, longitude },
      stwKnots: null,
      deployStates: { flinsail: "deployed" },
      controllerModes: {},
      awaRad: null,
    });

    injectForecast(plugin);
    const cycle = () => plugin.__getInternals().runPredictionCycle();

    // Some flicker first (seeds the power history inside the window)
    for (const powerW of [0.4, 0]) {
      app.setSelfPath(FLINSAIL_POWER, powerW);
      emit(app, [{ path: FLINSAIL_POWER, value: powerW }]);
    }
    await cycle();
    assert.strictEqual(lastDetectedState(app, "flinsail"), "deployed");

    // Sustained zero: emit 0 W samples with timestamps past the 5-minute
    // window so the running average drops the flicker and reads exactly 0
    const later = (min) => new Date(Date.now() + min * 60000).toISOString();
    for (const min of [6, 6.5]) {
      app.setSelfPath(FLINSAIL_POWER, 0);
      emit(app, [{ path: FLINSAIL_POWER, value: 0 }], later(min));
    }
    await cycle();
    assert.strictEqual(
      lastDetectedState(app, "flinsail"),
      "stowed",
      "a window of solid 0 W with the sun up must confirm stowed",
    );

    // Persist the live detection (the 5-minute recorder does this in
    // production) so the next cycle's seed carries "stowed" forward
    await plugin.__getInternals().recordSample();

    // Sub-threshold blips must not resurrect the deployed state
    app.setSelfPath(FLINSAIL_POWER, 0.4);
    emit(app, [{ path: FLINSAIL_POWER, value: 0.4 }], later(7));
    await cycle();
    assert.strictEqual(
      lastDetectedState(app, "flinsail"),
      "stowed",
      "sub-threshold blips must hold the stowed state",
    );

    // Real output (above the 2 W confirm threshold) recovers deployed
    for (const min of [8, 9]) {
      app.setSelfPath(FLINSAIL_POWER, 10);
      emit(app, [{ path: FLINSAIL_POWER, value: 10 }], later(min));
    }
    await cycle();
    assert.strictEqual(
      lastDetectedState(app, "flinsail"),
      "deployed",
      "output above the confirm threshold must confirm deployed",
    );

    await plugin.stop();
    await rm(testDir, { recursive: true, force: true });
  });
});

test.describe("wind generator detection hysteresis", () => {
  /** Emits a wind speed sample in m/s (Signal K unit); spacing ≥ 30 s so each lands in history. */
  const emitWind = (app, knots, iso) => {
    const ms = knots / 1.943844;
    app.setSelfPath(WIND_SPEED, ms);
    emit(app, [{ path: WIND_SPEED, value: ms }], iso);
  };
  const later = (min) => new Date(Date.now() + min * 60000).toISOString();

  test("gusty marginal wind does not flap the live detected state", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const testDir = await mkdtemp(join(tmpdir(), "hysteresis-wind-"));

    app.dataPath = testDir;
    await plugin.start(windConfig(), () => {});

    app.setSelfPath("navigation.position", { latitude: 0, longitude: 0 });
    emit(app, [
      { path: "navigation.position", value: { latitude: 0, longitude: 0 } },
    ]);
    app.setSelfPath("navigation.state", "anchored");
    emit(app, [{ path: "navigation.state", value: "anchored" }]);
    app.setSelfPath(SOC_PATH, 0.6);
    emit(app, [{ path: SOC_PATH, value: 0.6 }]);

    // Last known state: deployed (a gust was producing earlier)
    const recorder = plugin.__getInternals().recorder;
    await recorder.recordSample({
      timestamp: new Date(),
      arrays: {},
      generators: { superwind: 20 },
      soc: 0.6,
      houseLoadW: 100,
      windSpeedKnots: 7,
      navState: "anchored",
      position: { latitude: 0, longitude: 0 },
      stwKnots: null,
      deployStates: { superwind: "deployed" },
      controllerModes: {},
      awaRad: null,
    });

    injectForecast(plugin);
    const cycle = () => plugin.__getInternals().runPredictionCycle();

    // Gusty marginal night: average wind 6 kn (≥ 5 kn startup, below the
    // 7.5 kn stow-confirm), generator silent in the lulls. Pre-hysteresis
    // this published "stowed" within five minutes.
    app.setSelfPath(WIND_POWER, 0);
    emit(app, [{ path: WIND_POWER, value: 0 }]);
    emitWind(app, 6);
    emitWind(app, 6, later(0.7));
    emitWind(app, 6, later(1.4));
    await cycle();
    assert.strictEqual(
      lastDetectedState(app, "superwind"),
      "deployed",
      "0 W in marginal gusty wind must hold the deployed state",
    );

    // Sustained clear wind well above the confirm threshold: a deployed
    // unit would produce — 0 W now confirms stowed
    emitWind(app, 12, later(6));
    emitWind(app, 12, later(6.7));
    await cycle();
    assert.strictEqual(
      lastDetectedState(app, "superwind"),
      "stowed",
      "sustained wind clearly above startup with 0 W must confirm stowed",
    );

    // A single producing gust re-confirms deployment immediately
    app.setSelfPath(WIND_POWER, 20);
    emit(app, [{ path: WIND_POWER, value: 20 }], later(7));
    await cycle();
    assert.strictEqual(
      lastDetectedState(app, "superwind"),
      "deployed",
      "positive power must confirm deployment immediately",
    );

    await plugin.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  test("recording: gusty marginal wind keeps the recorded state deployed", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const testDir = await mkdtemp(join(tmpdir(), "hysteresis-wind-rec-"));

    app.dataPath = testDir;
    await plugin.start(windConfig(), () => {});

    app.setSelfPath("navigation.position", { latitude: 0, longitude: 0 });
    emit(app, [
      { path: "navigation.position", value: { latitude: 0, longitude: 0 } },
    ]);
    app.setSelfPath("navigation.state", "anchored");
    emit(app, [{ path: "navigation.state", value: "anchored" }]);
    app.setSelfPath(SOC_PATH, 0.6);
    emit(app, [{ path: SOC_PATH, value: 0.6 }]);

    const recorder = plugin.__getInternals().recorder;

    // 00:52 — a gust spins the unit up: the sample records "deployed"
    app.setSelfPath(WIND_POWER, 20);
    emit(app, [{ path: WIND_POWER, value: 20 }]);
    emitWind(app, 7);
    await plugin.__getInternals().recordSample();

    // 00:57 — five minutes later the sample lands in a lull (0 W) with
    // gusty average wind at 6 kn: above startup, below the 7.5 kn
    // stow-confirm. Pre-hysteresis this recorded "stowed".
    app.setSelfPath(WIND_POWER, 0);
    emit(app, [{ path: WIND_POWER, value: 0 }]);
    emitWind(app, 6, later(0.7));
    emitWind(app, 6, later(1.4));
    emitWind(app, 6, later(2.1));

    await plugin.__getInternals().recordSample();

    const samples = await recorder.getRecords(
      "sample",
      new Date(Date.now() - 3600000),
      new Date(Date.now() + 60000),
    );
    const newest = samples[samples.length - 1];
    assert.strictEqual(
      newest.deployStates?.superwind,
      "deployed",
      "a lull sample in marginal gusty wind must record the held state",
    );

    await plugin.stop();
    await rm(testDir, { recursive: true, force: true });
  });
});
