/**
 * Smoketests for carry-forward of detected deploy state across a restart.
 *
 * `runPredictionCycle` rebuilds `currentDeployStates` fresh each cycle from
 * live power + conditions. At night a deployable solar array (FLINsail)
 * naturally produces ~0 W, so the live inference yields null and a
 * fresh-restart Map would publish `detectedState: null` even though the
 * array was last known to be deployed/stowed. The 5-minute sample
 * recordings already persist `deployStates` per device, so the cycle now
 * seeds `currentDeployStates` from the most recent sample as a fallback.
 *
 * @file deploy-state-seed.test.js
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
 * Longitude that puts the sun near local noon (high) or local midnight
 * (below horizon) at the equator, regardless of when the test runs.
 */
function noonLongitude() {
  const now = new Date();
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  return (12 - utcHours) * 15;
}
function midnightLongitude() {
  const now = new Date();
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  return (0 - utcHours) * 15;
}

/** Emits a delta to all subscribed handlers (populates deltaState). */
function emit(app, values) {
  app.subscriptionmanager.subscriptions.forEach(({ deltaHandler }) => {
    deltaHandler({ context: app.selfId, updates: [{ values }] });
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
        capacityWp: 400,
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

/** Injects a minimal all-zero forecast into the ingestion FSM. */
function injectForecast(plugin) {
  const fsm = plugin.__getInternals().ingestionFSM;
  const now = new Date();
  const points = [];
  for (let h = 0; h < 24; h++) {
    points.push({
      time: new Date(now.getTime() + h * 3600000),
      windSpeedKnots: 5,
      gustSpeedKnots: 8,
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

test.describe("detected deploy state carry-forward across restart", () => {
  test("night restart: seeded detectedState survives when live inference yields null", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const testDir = await mkdtemp(join(tmpdir(), "seed-night-"));

    app.dataPath = testDir;
    const config = baseConfig();
    await plugin.start(config, () => {});

    // Position at local midnight (sun below horizon) at the equator
    const longitude = midnightLongitude();
    app.setSelfPath("navigation.position", { latitude: 0, longitude });
    emit(app, [
      { path: "navigation.position", value: { latitude: 0, longitude } },
    ]);
    app.setSelfPath("navigation.state", "anchored");
    emit(app, [{ path: "navigation.state", value: "anchored" }]);
    app.setSelfPath(SOC_PATH, 0.6);
    emit(app, [{ path: SOC_PATH, value: 0.6 }]);
    // FLINsail producing 0 W at night (deployed panels do this at night)
    app.setSelfPath(FLINSAIL_POWER, 0);
    emit(app, [{ path: FLINSAIL_POWER, value: 0 }]);

    // Record a sample carrying the last-known deploy state ("deployed")
    // before the "restart". This mirrors what the live recorder persists.
    const recorder = plugin.__getInternals().recorder;
    assert.ok(recorder, "recorder should be initialised");
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

    // Inject a forecast so runPredictionCycle doesn't need the network
    injectForecast(plugin);

    await plugin.__getInternals().runPredictionCycle();

    // At night the live inference yields null (0 W, sun down), so the
    // seed from the recording must carry forward as "deployed".
    assert.strictEqual(
      lastDetectedState(app, "flinsail"),
      "deployed",
      "night restart should carry forward the last recorded deploy state",
    );

    await plugin.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  test("daytime: a definite live reading overrides the seed", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const testDir = await mkdtemp(join(tmpdir(), "seed-day-"));

    app.dataPath = testDir;
    const config = baseConfig();
    await plugin.start(config, () => {});

    // Position at local noon (sun well above horizon) at the equator
    const longitude = noonLongitude();
    app.setSelfPath("navigation.position", { latitude: 0, longitude });
    emit(app, [
      { path: "navigation.position", value: { latitude: 0, longitude } },
    ]);
    app.setSelfPath("navigation.state", "anchored");
    emit(app, [{ path: "navigation.state", value: "anchored" }]);
    app.setSelfPath(SOC_PATH, 0.6);
    emit(app, [{ path: SOC_PATH, value: 0.6 }]);

    // Record a stale "deployed" seed...
    const recorder = plugin.__getInternals().recorder;
    await recorder.recordSample({
      timestamp: new Date(),
      arrays: { flinsail: 50 },
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

    // ...but the live reading is 0 W in daytime -> definitely "stowed",
    // which must override the carried-forward "deployed".
    app.setSelfPath(FLINSAIL_POWER, 0);
    emit(app, [{ path: FLINSAIL_POWER, value: 0 }]);

    injectForecast(plugin);

    await plugin.__getInternals().runPredictionCycle();

    assert.strictEqual(
      lastDetectedState(app, "flinsail"),
      "stowed",
      "daytime 0 W must override the carried-forward seed",
    );

    await plugin.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  test("stale recording (older than the freshness window) is not carried forward", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const testDir = await mkdtemp(join(tmpdir(), "seed-stale-"));

    app.dataPath = testDir;
    const config = baseConfig();
    await plugin.start(config, () => {});

    const longitude = midnightLongitude();
    app.setSelfPath("navigation.position", { latitude: 0, longitude });
    emit(app, [
      { path: "navigation.position", value: { latitude: 0, longitude } },
    ]);
    app.setSelfPath("navigation.state", "anchored");
    emit(app, [{ path: "navigation.state", value: "anchored" }]);
    app.setSelfPath(SOC_PATH, 0.6);
    emit(app, [{ path: SOC_PATH, value: 0.6 }]);
    app.setSelfPath(FLINSAIL_POWER, 0);
    emit(app, [{ path: FLINSAIL_POWER, value: 0 }]);

    // Record a sample 12 hours ago — beyond the 6h freshness window
    const recorder = plugin.__getInternals().recorder;
    await recorder.recordSample({
      timestamp: new Date(Date.now() - 12 * 3600000),
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

    await plugin.__getInternals().runPredictionCycle();

    // Too stale to trust: at night the live inference yields null and no
    // seed is applied, so detectedState must be null (not "deployed").
    assert.strictEqual(
      lastDetectedState(app, "flinsail"),
      null,
      "a stale recording past the freshness window must not be carried forward",
    );

    await plugin.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  test("night restart: recovers a device absent from the newest sample from an earlier within-window sample", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const testDir = await mkdtemp(join(tmpdir(), "seed-merge-"));

    app.dataPath = testDir;
    const config = baseConfig();
    await plugin.start(config, () => {});

    const longitude = midnightLongitude();
    app.setSelfPath("navigation.position", { latitude: 0, longitude });
    emit(app, [
      { path: "navigation.position", value: { latitude: 0, longitude } },
    ]);
    app.setSelfPath("navigation.state", "anchored");
    emit(app, [{ path: "navigation.state", value: "anchored" }]);
    app.setSelfPath(SOC_PATH, 0.6);
    emit(app, [{ path: SOC_PATH, value: 0.6 }]);
    app.setSelfPath(FLINSAIL_POWER, 0);
    emit(app, [{ path: FLINSAIL_POWER, value: 0 }]);

    const recorder = plugin.__getInternals().recorder;

    // 3 hours ago: FLINsail was definitely deployed (last daytime reading).
    // Within the 6h freshness window but older than the newest sample.
    await recorder.recordSample({
      timestamp: new Date(Date.now() - 3 * 3600000),
      arrays: { flinsail: 50 },
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
    // Now (newest sample): night, FLINsail can't be inferred -> no flinsail
    // entry, only sailinggen. Mirrors the real failure case.
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
      deployStates: { sailinggen: "stowed" },
      controllerModes: {},
      awaRad: null,
    });

    injectForecast(plugin);

    await plugin.__getInternals().runPredictionCycle();

    // The newest sample lacks flinsail, but the 3h-old sample (within the
    // freshness window) had it -> flinsail must be recovered as "deployed".
    assert.strictEqual(
      lastDetectedState(app, "flinsail"),
      "deployed",
      "a device absent from the newest sample must be recovered from an earlier within-window sample",
    );

    await plugin.stop();
    await rm(testDir, { recursive: true, force: true });
  });
});
