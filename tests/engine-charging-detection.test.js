/**
 * Smoketests for shunt-signature engine detection: boats without
 * propulsion instrumentation (Victron-only setups have no `propulsion.*`
 * paths) must still register a running engine when the alternator
 * out-produces the house load, so the ideal track models the alternator
 * while motoring and load learning pauses.
 *
 * Incident (2026-09, Lille Ø): motoring with the alternator bulk-charging
 * showed a "deficit" outlook — `engineRunning` was null (no propulsion
 * data), the alternator never entered the ideal track, and the 0 W-clamped
 * load samples dragged the rolling average down.
 *
 * @file engine-charging-detection.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EventEmitter } = require("node:events");

const {
  detectEngineCharging,
  detectEngineRunning,
} = require("../plugin/combustion.js");
const { PredictionEngine, LoadProfile } = require("../plugin/prediction.js");
const makePlugin = require("../plugin/index.js");

// --- Fakes (mirrors plugin.test.js) --------------------------------------

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
    this.setPluginStatusCalls = [];
    this.handleMessageCalls = [];
  }
  getSelfPath(path) {
    return this.pathValues.get(path);
  }
  setSelfPath(path, value) {
    this.pathValues.set(path, value);
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
    if (!this.errors) this.errors = [];
    this.errors.push(msg);
  }
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

function emitDeltas(app, values) {
  app.subscriptionmanager.subscriptions.forEach(({ deltaHandler }) => {
    deltaHandler({
      context: app.selfId,
      updates: [{ values }],
    });
  });
}

// --- Pure detector --------------------------------------------------------

test.describe("detectEngineCharging (shunt signature)", () => {
  test("alternator out-producing the load reads as engine running", () => {
    // dcPower = shunt + solar = load − alternator = 150 − 1500 = −1350
    assert.strictEqual(
      detectEngineCharging({ dcPowerW: -1350, unaccountedChargingW: 0 }),
      true,
    );
  });

  test("renewable charging is subtracted and is not an engine", () => {
    // Wind + hydro cover the load: dcPower = 150 − 1350 = −1200, but with
    // 1350 W of measured renewables the balance is +150 (the load) → no
    // combustion charging.
    assert.strictEqual(
      detectEngineCharging({
        dcPowerW: -1200,
        unaccountedChargingW: 1350,
      }),
      false,
    );
  });

  test("a small alternator margin over renewables still fires", () => {
    // 200 W of net combustion charging beyond renewables and load
    assert.strictEqual(
      detectEngineCharging({
        dcPowerW: -1400,
        unaccountedChargingW: 1200,
      }),
      true,
    );
  });

  test("shore power defeats the signature", () => {
    assert.strictEqual(
      detectEngineCharging({
        dcPowerW: -1350,
        unaccountedChargingW: 0,
        shorePowerConnected: true,
      }),
      false,
    );
  });

  test("discharging battery reads as no engine", () => {
    assert.strictEqual(
      detectEngineCharging({ dcPowerW: 80, unaccountedChargingW: 0 }),
      false,
    );
  });

  test("missing dcPower is undecidable", () => {
    assert.strictEqual(
      detectEngineCharging({ dcPowerW: null, unaccountedChargingW: 0 }),
      null,
    );
  });
});

// --- Load profile gating ---------------------------------------------------

test.describe("LoadProfile rolling average gates combustion charging", () => {
  const makeLP = (engineRunning) =>
    new LoadProfile({
      getSelfPath: () => null,
      app: makeFakeApp(),
      getEngineRunning: () => engineRunning,
    });

  test("engine-running samples do not enter the rolling average", () => {
    const lp = makeLP(true);
    lp.addSample(200, 0, null);
    lp.addSample(250, 0, null);
    const avg = lp.getAverageLoad();
    assert.strictEqual(avg.dcWh, 0, "no samples must be learned");
  });

  test("shore-power samples do not enter the rolling average", () => {
    const a = makeFakeApp();
    a.setSelfPath("electrical.shore.power.connected", true);
    const lp = new LoadProfile({
      getSelfPath: (p) => a.getSelfPath(p),
      app: a,
      getEngineRunning: () => false,
    });
    lp.addSample(200, 0, null);
    assert.strictEqual(lp.getAverageLoad().dcWh, 0);
  });

  test("engine stopped: samples learn normally again", () => {
    const lp = makeLP(false);
    lp.addSample(200, 0, null);
    lp.addSample(300, 0, null);
    assert.strictEqual(lp.getAverageLoad().dcWh, 250);
  });

  test("unknown engine state still learns (cannot gate on null)", () => {
    const lp = makeLP(null);
    lp.addSample(200, 0, null);
    assert.strictEqual(lp.getAverageLoad().dcWh, 200);
  });
});

// --- Full-plugin integration: motoring without propulsion data -------------

test.describe("motoring on a Victron-only boat (no propulsion paths)", () => {
  let tempDir = null;
  test.before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "engine-charge-"));
  });
  test.after(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  async function startMotoringApp({ dcPowerW, hydroPowerW = 0 }) {
    const app = new FakeSignalKApp();
    app.dataPath = tempDir;
    const plugin = makePlugin(app);
    const config = {
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
        chemistry: "lifepo4",
      },
      engines: [{ id: "main", alternatorWatts: 1800, enabled: true }],
      // No solar arrays: the weather config below disables every fetch
      // tier, so the forecast is empty and a configured array would make
      // the outlook's degenerate-forecast guard (correctly) withhold the
      // status. This test is about alternator detection, not solar.
      solarArrays: [],
      mechanicalGenerators: [
        {
          id: "hydro",
          type: "hydro",
          deployable: true,
          powerPath: "electrical.generators.hydro.power",
          manufacturerCurve: "3,0,4,20,5,60,6,120",
          minSpeedKnots: 4,
          maxSpeedKnots: 12,
          enabled: true,
        },
      ],
      weather: { openMeteoEnabled: false, useLogbook: false },
    };
    await plugin.start(config, () => {});

    emitDeltas(app, [
      {
        path: "navigation.position",
        value: { latitude: -18, longitude: -149 },
      },
      { path: "navigation.state", value: "motoring" },
      {
        path: "electrical.batteries.house.capacity.stateOfCharge",
        value: 0.9,
      },
      { path: "electrical.venus.dcPower", value: dcPowerW },
      {
        path: "electrical.generators.hydro.power",
        value: hydroPowerW,
      },
      { path: "electrical.venus.acPower", value: 0 },
    ]);
    await plugin.__getInternals().runPredictionCycle();
    return { app, plugin };
  }

  test("alternator charging is detected and modeled in the ideal track", async () => {
    // dcPower = load(150) − alternator(1500) = −1350, no renewables
    const { plugin } = await startMotoringApp({ dcPowerW: -1350 });
    const engine = plugin.__getInternals().predictionEngine;

    assert.strictEqual(
      engine.loadProfile.isEngineRunning(),
      true,
      "shunt signature must read as engine running",
    );

    const hourly = engine.getHourlyForecast();
    assert.ok(hourly.length > 0, "prediction must run under motoring");
    assert.strictEqual(
      hourly[0].alternatorWh,
      1800,
      "configured alternator watts enter the ideal track",
    );

    const outlook = engine.getEnergyOutlook();
    assert.notStrictEqual(outlook.status, "deficit");
    assert.notStrictEqual(outlook.status, "critical");
    await plugin.stop();
  });

  test("renewable charging is not misread as an engine", async () => {
    // 1350 W of hydro (stowed in reality, but its power path reads) plus
    // a 150 W load and no alternator: dcPower = −1200 but the balance
    // after subtracting measured renewables is the load itself.
    const { plugin } = await startMotoringApp({
      dcPowerW: -1200,
      hydroPowerW: 1350,
    });
    const engine = plugin.__getInternals().predictionEngine;

    assert.strictEqual(
      engine.loadProfile.isEngineRunning(),
      false,
      "renewables covering the load must not read as an engine",
    );
    assert.strictEqual(engine.getHourlyForecast()[0].alternatorWh, 0);
    await plugin.stop();
  });
});

// --- Alternator / DC-DC charger path detection ---------------------------

test.describe("alternator charger paths (mode + power)", () => {
  const read = (vals) => (path) => vals[path];

  test("an active charging mode marks the engine running", () => {
    const engine = {
      id: "main",
      alternatorModePath: "electrical.chargers.alternator.chargingMode",
      alternatorPowerPath: "electrical.chargers.alternator.power",
    };
    // Absorption-tapered trickle while the engine still runs hard — the
    // mode, not the watts, is the truthful signal.
    const vals = {
      "electrical.chargers.alternator.chargingMode": "absorption",
      "electrical.chargers.alternator.power": 15,
    };
    assert.strictEqual(
      detectEngineRunning(engine, read(vals)),
      true,
      "active mode must read as running despite trickle power",
    );
  });

  test("float mode still counts as running", () => {
    const engine = {
      id: "main",
      alternatorModePath: "electrical.chargers.alternator.chargingMode",
    };
    assert.strictEqual(
      detectEngineRunning(
        engine,
        read({ "electrical.chargers.alternator.chargingMode": "float" }),
      ),
      true,
    );
  });

  test("an explicit off mode means not running", () => {
    const engine = {
      id: "main",
      alternatorModePath: "electrical.chargers.alternator.chargingMode",
    };
    assert.strictEqual(
      detectEngineRunning(
        engine,
        read({ "electrical.chargers.alternator.chargingMode": "off" }),
      ),
      false,
    );
  });

  test("without a mode path, positive power means running", () => {
    const engine = {
      id: "main",
      alternatorPowerPath: "electrical.chargers.alternator.power",
    };
    assert.strictEqual(
      detectEngineRunning(
        engine,
        read({ "electrical.chargers.alternator.power": 1350 }),
      ),
      true,
    );
    assert.strictEqual(
      detectEngineRunning(
        engine,
        read({ "electrical.chargers.alternator.power": 0 }),
      ),
      false,
    );
  });

  test("no paths at all stays unknown (propulsion-less, path-less)", () => {
    assert.strictEqual(detectEngineRunning({ id: "main" }, read({})), null);
  });

  test("ideal-track attribution falls back to measured watts", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.state", "motoring");
    app.setSelfPath("electrical.batteries.house.capacity.stateOfCharge", 0.9);
    app.setSelfPath("electrical.chargers.alternator.chargingMode", "bulk");
    app.setSelfPath("electrical.chargers.alternator.power", 1350);

    const engine = new PredictionEngine({
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
        chemistry: "lifepo4",
      },
      solarArrays: [],
      mechanicalGenerators: [],
      // No alternatorWatts — the measured output must stand in
      engines: [
        {
          id: "main",
          alternatorPowerPath: "electrical.chargers.alternator.power",
          alternatorModePath: "electrical.chargers.alternator.chargingMode",
        },
      ],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(Date.now() + h * 3600000),
      ghi: 0,
      cloudCover: 0,
      gustSpeedMs: null,
      windSpeedMs: null,
    }));
    engine.runPrediction(forecast);
    assert.strictEqual(
      engine.getHourlyForecast()[0].alternatorWh,
      1350,
      "measured charger output models the ideal track when watts unset",
    );
  });
});

test.describe("PredictionEngine alternator attribution", () => {
  test("engine detected via shunt (getEngineRunning) counts its alternator", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.state", "motoring");
    app.setSelfPath("electrical.batteries.house.capacity.stateOfCharge", 0.9);
    app.setSelfPath("electrical.venus.dcPower", -1350);

    const engine = new PredictionEngine({
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
        chemistry: "lifepo4",
      },
      solarArrays: [],
      mechanicalGenerators: [],
      engines: [{ id: "main", alternatorWatts: 1800 }],
      // Simulates index.js's shunt-signature detector with no
      // propulsion paths present
      getEngineRunning: () => true,
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(Date.now() + h * 3600000),
      ghi: 0,
      cloudCover: 0,
      gustSpeedMs: null,
      windSpeedMs: null,
    }));
    engine.runPrediction(forecast);
    assert.strictEqual(engine.getHourlyForecast()[0].alternatorWh, 1800);
    const outlook = engine.getEnergyOutlook();
    assert.ok(
      ["surplus", "rising"].includes(outlook.status),
      `motoring with a 1.8kW alternator must not read as ${outlook.status}`,
    );
  });
});
