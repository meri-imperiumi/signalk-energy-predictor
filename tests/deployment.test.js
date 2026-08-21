/**
 * Tests for the unified deployment recommendation system.
 * @file deployment.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PredictionEngine, LoadProfile } = require("../plugin/prediction.js");
const { AdvisoryPublisher } = require("../plugin/advisory.js");
const { parseManufacturerCurve } = require("../plugin/schema.js");

function withCurve(gen) {
  return { ...gen, curve: parseManufacturerCurve(gen.manufacturerCurve) };
}

// --- Helpers ---

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

function makePredictionEngine({
  solarArrays,
  generators,
  navState,
  speed,
  app,
}) {
  const a = app || makeFakeApp();
  if (navState != null) a.setSelfPath("navigation.state", navState);
  if (speed != null) a.setSelfPath("navigation.speedThroughWater", speed);

  return new PredictionEngine({
    battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
    solarArrays: solarArrays || [],
    mechanicalGenerators: (generators || []).map(withCurve),
    getEfficiency: () => 0.7,
    getSelfPath: (path) => a.getSelfPath(path),
    app: a,
  });
}

// A forecast with gust/wind fields that populate lastPrediction
function makeForecastWithGusts(gustKnots, windKnots) {
  const now = new Date();
  return Array.from({ length: 24 }, (_, h) => ({
    time: new Date(now.getTime() + h * 3600000),
    ghi: 500,
    cloudCover: 0.3,
    gustSpeedKnots: gustKnots,
    windSpeedKnots: windKnots,
  }));
}

test.describe("Deployment recommendations: FLINsail", () => {
  test("stows FLINsail when underway (sailing)", () => {
    const engine = makePredictionEngine({
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
        },
      ],
      navState: "sailing",
    });
    engine.runPrediction(makeForecastWithGusts(10, 8));
    const recs = engine.getDeploymentRecommendations();
    const rec = recs.find((r) => r.id === "flinsail");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /under way/);
  });

  test("stows FLINsail when motoring", () => {
    const engine = makePredictionEngine({
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
        },
      ],
      navState: "motoring",
    });
    engine.runPrediction(makeForecastWithGusts(10, 8));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "flinsail");
    assert.strictEqual(rec.recommendedState, "stowed");
  });

  test("stows FLINsail when gusts exceed limit", () => {
    const engine = makePredictionEngine({
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
        },
      ],
      navState: "anchored",
    });
    engine.runPrediction(makeForecastWithGusts(25, 18));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "flinsail");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /25/);
    assert.match(rec.reason, /20/);
  });

  test("deploys FLINsail when at anchor and gusts below limit", () => {
    const engine = makePredictionEngine({
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
        },
      ],
      navState: "anchored",
    });
    engine.runPrediction(makeForecastWithGusts(10, 8));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "flinsail");
    assert.strictEqual(rec.recommendedState, "deployed");
  });

  test("deploys FLINsail when moored with no significant gusts", () => {
    const engine = makePredictionEngine({
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
        },
      ],
      navState: "moored",
    });
    engine.runPrediction(makeForecastWithGusts(0, 0));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "flinsail");
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.match(rec.reason, /no significant gusts/);
  });

  test("ignores non-deployable solar arrays", () => {
    const engine = makePredictionEngine({
      solarArrays: [{ id: "cabin-roof", type: "fixed", capacityWp: 200 }],
      navState: "sailing",
    });
    engine.runPrediction(makeForecastWithGusts(10, 8));
    const recs = engine.getDeploymentRecommendations();
    assert.strictEqual(recs.length, 0);
  });
});

test.describe("Deployment recommendations: wind generators", () => {
  test("stows wind generator when underway", () => {
    const engine = makePredictionEngine({
      generators: [
        {
          id: "windgen",
          type: "wind",
          deployable: true,
          maxWindKnots: 30,
          powerPath: "electrical.windgen.power",
          manufacturerCurve: "5,10,10,50,15,100,20,150,25,200,30,250",
        },
      ],
      navState: "sailing",
    });
    engine.runPrediction(makeForecastWithGusts(15, 12));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "windgen");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /under way/);
  });

  test("stows wind generator when gusts exceed max", () => {
    const engine = makePredictionEngine({
      generators: [
        {
          id: "windgen",
          type: "wind",
          deployable: true,
          maxWindKnots: 30,
          powerPath: "electrical.windgen.power",
          manufacturerCurve: "5,10,10,50,15,100,20,150,25,200,30,250",
        },
      ],
      navState: "moored",
    });
    engine.runPrediction(makeForecastWithGusts(35, 25));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "windgen");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /35/);
  });

  test("deploys wind generator when wind is sufficient and gusts below max", () => {
    const engine = makePredictionEngine({
      generators: [
        {
          id: "windgen",
          type: "wind",
          deployable: true,
          maxWindKnots: 30,
          powerPath: "electrical.windgen.power",
          manufacturerCurve: "5,10,10,50,15,100,20,150,25,200,30,250",
        },
      ],
      navState: "moored",
    });
    engine.runPrediction(makeForecastWithGusts(15, 12));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "windgen");
    assert.strictEqual(rec.recommendedState, "deployed");
  });

  test("stows wind generator when wind too low", () => {
    const engine = makePredictionEngine({
      generators: [
        {
          id: "windgen",
          type: "wind",
          deployable: true,
          maxWindKnots: 30,
          powerPath: "electrical.windgen.power",
          manufacturerCurve: "5,10,10,50,15,100,20,150,25,200,30,250",
        },
      ],
      navState: "anchored",
    });
    engine.runPrediction(makeForecastWithGusts(2, 2));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "windgen");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /too low/);
  });
});

test.describe("Deployment recommendations: hydro generators", () => {
  test("stows hydro when moored", () => {
    const engine = makePredictionEngine({
      generators: [
        {
          id: "hydrogen",
          type: "hydro",
          deployable: true,
          minSpeedKnots: 3,
          maxSpeedKnots: 12,
          powerPath: "electrical.hydro.power",
          manufacturerCurve: "3,50,5,100,8,150,10,200,12,250",
        },
      ],
      navState: "moored",
    });
    engine.runPrediction(makeForecastWithGusts(0, 0));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "hydrogen");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /not sailing/);
  });

  test("stows hydro when motoring (not sailing)", () => {
    const engine = makePredictionEngine({
      generators: [
        {
          id: "hydrogen",
          type: "hydro",
          deployable: true,
          minSpeedKnots: 3,
          maxSpeedKnots: 12,
          powerPath: "electrical.hydro.power",
          manufacturerCurve: "3,50,5,100,8,150,10,200,12,250",
        },
      ],
      navState: "motoring",
      speed: 6,
    });
    engine.runPrediction(makeForecastWithGusts(0, 0));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "hydrogen");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /hydro requires sailing/);
  });

  test("deploys hydro when sailing at sufficient speed", () => {
    const engine = makePredictionEngine({
      generators: [
        {
          id: "hydrogen",
          type: "hydro",
          deployable: true,
          minSpeedKnots: 3,
          maxSpeedKnots: 12,
          powerPath: "electrical.hydro.power",
          manufacturerCurve: "3,50,5,100,8,150,10,200,12,250",
        },
      ],
      navState: "sailing",
      speed: 5,
    });
    engine.runPrediction(makeForecastWithGusts(0, 0));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "hydrogen");
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.match(rec.reason, /5.0kn/);
  });

  test("stows hydro when sailing too slow", () => {
    const engine = makePredictionEngine({
      generators: [
        {
          id: "hydrogen",
          type: "hydro",
          deployable: true,
          minSpeedKnots: 3,
          maxSpeedKnots: 12,
          powerPath: "electrical.hydro.power",
          manufacturerCurve: "3,50,5,100,8,150,10,200,12,250",
        },
      ],
      navState: "sailing",
      speed: 2,
    });
    engine.runPrediction(makeForecastWithGusts(0, 0));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "hydrogen");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /too slow/);
  });

  test("stows hydro when sailing too fast (exceeds max speed)", () => {
    const engine = makePredictionEngine({
      generators: [
        {
          id: "hydrogen",
          type: "hydro",
          deployable: true,
          minSpeedKnots: 3,
          maxSpeedKnots: 12,
          powerPath: "electrical.hydro.power",
          manufacturerCurve: "3,50,5,100,8,150,10,200,12,250",
        },
      ],
      navState: "sailing",
      speed: 14,
    });
    engine.runPrediction(makeForecastWithGusts(0, 0));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "hydrogen");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /exceeds limit/);
  });
});

test.describe("Deployment recommendations: no devices configured", () => {
  test("returns empty array when no deployable devices", () => {
    const engine = makePredictionEngine({
      solarArrays: [{ id: "roof", type: "fixed", capacityWp: 200 }],
      generators: [],
      navState: "sailing",
    });
    engine.runPrediction(makeForecastWithGusts(10, 8));
    const recs = engine.getDeploymentRecommendations();
    assert.strictEqual(recs.length, 0);
  });

  test("returns empty array when devices are not deployable", () => {
    const engine = makePredictionEngine({
      solarArrays: [],
      generators: [
        {
          id: "fixed-wind",
          type: "wind",
          deployable: false,
          maxWindKnots: 30,
          manufacturerCurve: "5,10,10,50,15,100,20,150,25,200,30,250",
        },
      ],
      navState: "moored",
    });
    engine.runPrediction(makeForecastWithGusts(15, 12));
    const recs = engine.getDeploymentRecommendations();
    assert.strictEqual(recs.length, 0);
  });
});

test.describe("Missed yield calculation", () => {
  test("FLINsail deployed recommendation includes missed yield", () => {
    const engine = makePredictionEngine({
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
        },
      ],
      navState: "anchored",
    });
    // High GHI forecast - significant yield expected
    engine.runPrediction(makeForecastWithGusts(10, 8));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "flinsail");
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.ok(rec.missedYieldWh > 0, "Should have positive missed yield");
  });

  test("FLINsail stowed recommendation has zero missed yield", () => {
    const engine = makePredictionEngine({
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
        },
      ],
      navState: "sailing",
    });
    engine.runPrediction(makeForecastWithGusts(10, 8));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "flinsail");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.strictEqual(rec.missedYieldWh, 0);
  });

  test("wind generator deployed recommendation includes missed yield", () => {
    const engine = makePredictionEngine({
      generators: [
        {
          id: "windgen",
          type: "wind",
          deployable: true,
          maxWindKnots: 30,
          powerPath: "electrical.windgen.power",
          manufacturerCurve: "5,10,10,50,15,100,20,150,25,200,30,250",
        },
      ],
      navState: "moored",
    });
    engine.runPrediction(makeForecastWithGusts(15, 12));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "windgen");
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.ok(
      rec.missedYieldWh > 0,
      "Should have positive missed yield from wind",
    );
  });

  test("hydro generator deployed recommendation includes missed yield", () => {
    const engine = makePredictionEngine({
      generators: [
        {
          id: "hydrogen",
          type: "hydro",
          deployable: true,
          minSpeedKnots: 3,
          maxSpeedKnots: 12,
          powerPath: "electrical.hydro.power",
          manufacturerCurve: "3,50,5,100,8,150,10,200,12,250",
        },
      ],
      navState: "sailing",
      speed: 5,
    });
    engine.runPrediction(makeForecastWithGusts(0, 0));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "hydrogen");
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.ok(
      rec.missedYieldWh > 0,
      "Should have positive missed yield from hydro",
    );
  });

  test("notification message includes missed yield when deploy recommended and stowed", () => {
    const app = makeFakeApp();
    app.selfId = "self";
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const recs = [
      {
        id: "windgen",
        name: "Wind Gen",
        type: "wind",
        recommendedState: "deployed",
        reason: "Deploy - wind 12kn",
        missedYieldWh: 850,
      },
    ];
    const currentStates = new Map([["windgen", "stowed"]]);

    pub.publishDeploymentStates(recs, currentStates);

    const notifCalls = app.handleMessageCalls
      .filter(
        (c) =>
          c.msg.updates &&
          c.msg.updates[0].values.some((v) =>
            v.path.startsWith("notifications."),
          ),
      )
      .flatMap((c) => c.msg.updates[0].values);
    const notif = notifCalls.find((v) => v.path.startsWith("notifications."));
    assert.ok(notif);
    assert.match(notif.value.message, /850Wh in 24h/);
  });

  test("missedYieldWh is published as a delta value", () => {
    const app = makeFakeApp();
    app.selfId = "self";
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const recs = [
      {
        id: "flinsail",
        name: "FLINsail",
        type: "solar-deployable",
        recommendedState: "deployed",
        reason: "Deploy",
        missedYieldWh: 1200,
      },
    ];
    const currentStates = new Map();

    pub.publishDeploymentStates(recs, currentStates);

    const deltaCall = app.handleMessageCalls.find(
      (c) =>
        c.msg.updates &&
        c.msg.updates[0].values.some((v) =>
          v.path.startsWith("electrical.energy.prediction."),
        ),
    );
    assert.ok(deltaCall);
    const paths = {};
    for (const v of deltaCall.msg.updates[0].values) {
      paths[v.path] = v.value;
    }
    assert.strictEqual(
      paths["electrical.energy.prediction.deployment.flinsail.missedYieldWh"],
      1200,
    );
  });
});

test.describe("AdvisoryPublisher deployment states", () => {
  function makePublisher() {
    const app = makeFakeApp();
    return { app, pub: new AdvisoryPublisher(app, "test-plugin") };
  }

  test("publishes recommendedState, detectedState, and reason as deltas", () => {
    const { app, pub } = makePublisher();
    const recs = [
      {
        id: "flinsail",
        name: "FLINsail",
        type: "solar-deployable",
        recommendedState: "stowed",
        reason: "Stow - gusts 25kn exceed limit of 20kn",
      },
    ];
    const currentStates = new Map([["flinsail", "deployed"]]);

    pub.publishDeploymentStates(recs, currentStates);

    // Should have published a notification and a delta via handleMessage
    // Find the delta call (contains prediction paths, not notifications)
    const deltaCall = app.handleMessageCalls.find(
      (c) =>
        c.msg.updates &&
        c.msg.updates[0].values.some((v) =>
          v.path.startsWith("electrical.energy.prediction."),
        ),
    );
    assert.ok(deltaCall, "Should have published a delta");
    const delta = deltaCall.msg;
    assert.strictEqual(delta.context, "vessels.self");
    const paths = {};
    for (const v of delta.updates[0].values) {
      paths[v.path] = v.value;
    }
    assert.strictEqual(
      paths[
        "electrical.energy.prediction.deployment.flinsail.recommendedState"
      ],
      "stowed",
    );
    assert.strictEqual(
      paths["electrical.energy.prediction.deployment.flinsail.detectedState"],
      "deployed",
    );
    assert.strictEqual(
      paths["electrical.energy.prediction.deployment.flinsail.reason"],
      "Stow - gusts 25kn exceed limit of 20kn",
    );
  });

  test("sends alert notification when detected differs from recommended", () => {
    const { app, pub } = makePublisher();
    const recs = [
      {
        id: "flinsail",
        name: "FLINsail",
        type: "solar-deployable",
        recommendedState: "stowed",
        reason: "Stow - gusts 25kn exceed limit of 20kn",
      },
    ];
    const currentStates = new Map([["flinsail", "deployed"]]);

    pub.publishDeploymentStates(recs, currentStates);

    // Should have a notification message - check handlemessage calls
    const notifCalls = app.handleMessageCalls.filter(
      (c) =>
        c.msg.updates &&
        c.msg.updates[0].values.some((v) =>
          v.path.startsWith("notifications."),
        ),
    );
    assert.ok(notifCalls.length > 0, "Should publish a notification");
    const notifValues = notifCalls[0].msg.updates[0].values;
    const notif = notifValues.find((v) => v.path.startsWith("notifications."));
    assert.ok(notif.value.state !== "normal", "Should be alert/warn state");
    assert.match(notif.value.message, /Stow now/);
  });

  test("sends normal notification when detected matches recommended", () => {
    const { app, pub } = makePublisher();
    const recs = [
      {
        id: "flinsail",
        name: "FLINsail",
        type: "solar-deployable",
        recommendedState: "deployed",
        reason: "Deploy - no significant gusts forecast",
      },
    ];
    const currentStates = new Map([["flinsail", "deployed"]]);

    pub.publishDeploymentStates(recs, currentStates);

    const notifCalls = app.handleMessageCalls.filter(
      (c) =>
        c.msg.updates &&
        c.msg.updates[0].values.some((v) =>
          v.path.startsWith("notifications."),
        ),
    );
    assert.ok(notifCalls.length > 0);
    const notif = notifCalls[0].msg.updates[0].values.find((v) =>
      v.path.startsWith("notifications."),
    );
    assert.strictEqual(notif.value.state, "normal");
  });

  test("publishes null detectedState when current state unknown", () => {
    const { app, pub } = makePublisher();
    const recs = [
      {
        id: "flinsail",
        name: "FLINsail",
        type: "solar-deployable",
        recommendedState: "deployed",
        reason: "Deploy",
      },
    ];
    const currentStates = new Map(); // No state known

    pub.publishDeploymentStates(recs, currentStates);

    // Find the delta call (not the notification)
    const deltaCall = app.handleMessageCalls.find(
      (c) =>
        c.msg.updates &&
        c.msg.updates[0].values.some((v) =>
          v.path.startsWith("electrical.energy.prediction."),
        ),
    );
    assert.ok(deltaCall, "Should have published a delta");
    const paths = {};
    for (const v of deltaCall.msg.updates[0].values) {
      paths[v.path] = v.value;
    }
    // detectedState should be null when unknown
    assert.strictEqual(
      paths["electrical.energy.prediction.deployment.flinsail.detectedState"],
      null,
    );
  });
});

test.describe("Detected state inference from navigation state", () => {
  test("hydro detected as stowed when moored (even without deployStatePath)", async () => {
    // This test uses the full plugin to test the index.js inference logic
    const makePlugin = require("../plugin/index.js");

    class FakeSubManager {
      constructor() {
        this.subs = [];
      }
      subscribe(sub, unsubs, err, handler) {
        this.subs.push({ handler });
        unsubs.push(() => {});
      }
    }

    class FakeApp {
      constructor() {
        this.selfId = "self";
        this.subscriptionmanager = new FakeSubManager();
        this.dataPath = null;
        this.pathValues = new Map();
        this.handleMessageCalls = [];
        this.setPluginStatusCalls = [];
      }
      getSelfPath(p) {
        return this.pathValues.get(p);
      }
      getDataPath() {
        return this.dataPath;
      }
      debug() {}
      error() {}
      setPluginStatus(m) {
        this.setPluginStatusCalls.push(m);
      }
      handleMessage(s, m) {
        this.handleMessageCalls.push({ s, m });
      }
    }

    const app = new FakeApp();
    const plugin = makePlugin(app);
    const config = {
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        {
          id: "sailinggen",
          type: "hydro",
          deployable: true,
          minSpeedKnots: 3,
          maxSpeedKnots: 12,
          powerPath: "electrical.hydro.power",
        },
      ],
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
        forecastHours: 24,
      },
    };

    app.dataPath = "/tmp/energy-test";
    const os = require("node:os");
    const fs = require("node:fs/promises");
    app.dataPath = await fs.mkdtemp(
      require("node:path").join(os.tmpdir(), "energy-"),
    );
    await plugin.start(config, () => {});

    // Emit navigation state = moored and position
    app.subscriptionmanager.subs.forEach(({ handler }) => {
      handler({
        context: "self",
        updates: [
          {
            values: [
              { path: "navigation.state", value: "moored" },
              {
                path: "navigation.position",
                value: { latitude: 60, longitude: 18 },
              },
            ],
          },
        ],
      });
    });

    // Trigger prediction cycle manually via internals
    const internals = plugin.__getInternals();
    await internals.runPredictionCycle();

    // Check published deltas for detectedState
    const deployDeltas = app.handleMessageCalls
      .filter((c) => c.m.updates)
      .flatMap((c) => c.m.updates[0].values)
      .filter(
        (v) =>
          v.path ===
          "electrical.energy.prediction.deployment.sailinggen.detectedState",
      );

    assert.ok(
      deployDeltas.length > 0,
      "Should have published detectedState for hydro",
    );
    assert.strictEqual(deployDeltas[0].value, "stowed");

    await plugin.stop();
    await fs.rm(app.dataPath, { recursive: true, force: true });
  });

  test("FLINsail detected as stowed when underway", async () => {
    const makePlugin = require("../plugin/index.js");

    class FakeSubManager {
      constructor() {
        this.subs = [];
      }
      subscribe(sub, unsubs, err, handler) {
        this.subs.push({ handler });
        unsubs.push(() => {});
      }
    }

    class FakeApp {
      constructor() {
        this.selfId = "self";
        this.subscriptionmanager = new FakeSubManager();
        this.dataPath = null;
        this.pathValues = new Map();
        this.handleMessageCalls = [];
        this.setPluginStatusCalls = [];
      }
      getSelfPath(p) {
        return this.pathValues.get(p);
      }
      getDataPath() {
        return this.dataPath;
      }
      debug() {}
      error() {}
      setPluginStatus(m) {
        this.setPluginStatusCalls.push(m);
      }
      handleMessage(s, m) {
        this.handleMessageCalls.push({ s, m });
      }
    }

    const app = new FakeApp();
    const plugin = makePlugin(app);
    const config = {
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
          powerPath: "electrical.solar.flinsail.power",
        },
      ],
      mechanicalGenerators: [],
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
        forecastHours: 24,
      },
    };

    const os = require("node:os");
    const fs = require("node:fs/promises");
    app.dataPath = await fs.mkdtemp(
      require("node:path").join(os.tmpdir(), "energy-"),
    );
    await plugin.start(config, () => {});

    app.subscriptionmanager.subs.forEach(({ handler }) => {
      handler({
        context: "self",
        updates: [
          {
            values: [
              { path: "navigation.state", value: "sailing" },
              {
                path: "navigation.position",
                value: { latitude: 60, longitude: 18 },
              },
            ],
          },
        ],
      });
    });

    const internals = plugin.__getInternals();
    await internals.runPredictionCycle();

    const deployDeltas = app.handleMessageCalls
      .filter((c) => c.m.updates)
      .flatMap((c) => c.m.updates[0].values)
      .filter(
        (v) =>
          v.path ===
          "electrical.energy.prediction.deployment.flinsail.detectedState",
      );

    assert.ok(deployDeltas.length > 0);
    assert.strictEqual(deployDeltas[0].value, "stowed");

    await plugin.stop();
    await fs.rm(app.dataPath, { recursive: true, force: true });
  });

  test("wind generator detected as stowed when wind present but no power output", async () => {
    const makePlugin = require("../plugin/index.js");

    class FakeSubManager {
      constructor() {
        this.subs = [];
      }
      subscribe(sub, unsubs, err, handler) {
        this.subs.push({ handler });
        unsubs.push(() => {});
      }
    }

    class FakeApp {
      constructor() {
        this.selfId = "self";
        this.subscriptionmanager = new FakeSubManager();
        this.dataPath = null;
        this.pathValues = new Map();
        this.handleMessageCalls = [];
        this.setPluginStatusCalls = [];
      }
      getSelfPath(p) {
        return this.pathValues.get(p);
      }
      getDataPath() {
        return this.dataPath;
      }
      debug() {}
      error() {}
      setPluginStatus(m) {
        this.setPluginStatusCalls.push(m);
      }
      handleMessage(s, m) {
        this.handleMessageCalls.push({ s, m });
      }
    }

    const app = new FakeApp();
    const plugin = makePlugin(app);
    const config = {
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        {
          id: "superwind",
          type: "wind",
          deployable: true,
          maxWindKnots: 30,
          startupSpeedKnots: 8,
          powerPath: "electrical.wind.superwind.power",
          manufacturerCurve: "5,10,10,50,15,100,20,150,25,200,30,250",
        },
      ],
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
        forecastHours: 24,
      },
    };

    const os = require("node:os");
    const fs = require("node:fs/promises");
    app.dataPath = await fs.mkdtemp(
      require("node:path").join(os.tmpdir(), "energy-"),
    );
    await plugin.start(config, () => {});

    // Emit: at anchor, wind 12kn, but power output is 0 (stowed)
    app.subscriptionmanager.subs.forEach(({ handler }) => {
      handler({
        context: "self",
        updates: [
          {
            values: [
              { path: "navigation.state", value: "moored" },
              {
                path: "navigation.position",
                value: { latitude: 60, longitude: 18 },
              },
              { path: "environment.wind.speedApparent", value: 6 },
              { path: "electrical.wind.superwind.power", value: 0 },
            ],
          },
        ],
      });
    });

    const internals = plugin.__getInternals();
    await internals.runPredictionCycle();

    const deployDeltas = app.handleMessageCalls
      .filter((c) => c.m.updates)
      .flatMap((c) => c.m.updates[0].values)
      .filter(
        (v) =>
          v.path ===
          "electrical.energy.prediction.deployment.superwind.detectedState",
      );

    // Wind 6kn is below startup speed of 8kn, so we cannot infer stow
    assert.ok(deployDeltas.length > 0, "Should have published detectedState");
    assert.strictEqual(deployDeltas[0].value, null);

    await plugin.stop();
    await fs.rm(app.dataPath, { recursive: true, force: true });
  });

  test("hydro generator detected as stowed when sailing above min speed but no power output", async () => {
    const makePlugin = require("../plugin/index.js");

    class FakeSubManager {
      constructor() {
        this.subs = [];
      }
      subscribe(sub, unsubs, err, handler) {
        this.subs.push({ handler });
        unsubs.push(() => {});
      }
    }

    class FakeApp {
      constructor() {
        this.selfId = "self";
        this.subscriptionmanager = new FakeSubManager();
        this.dataPath = null;
        this.pathValues = new Map();
        this.handleMessageCalls = [];
        this.setPluginStatusCalls = [];
      }
      getSelfPath(p) {
        return this.pathValues.get(p);
      }
      getDataPath() {
        return this.dataPath;
      }
      debug() {}
      error() {}
      setPluginStatus(m) {
        this.setPluginStatusCalls.push(m);
      }
      handleMessage(s, m) {
        this.handleMessageCalls.push({ s, m });
      }
    }

    const app = new FakeApp();
    const plugin = makePlugin(app);
    const config = {
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        {
          id: "sailinggen",
          type: "hydro",
          deployable: true,
          minSpeedKnots: 3,
          maxSpeedKnots: 12,
          powerPath: "electrical.hydro.sailinggen.power",
          manufacturerCurve: "3,50,5,100,8,150,10,200,12,250",
        },
      ],
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
        forecastHours: 24,
      },
    };

    const os = require("node:os");
    const fs = require("node:fs/promises");
    app.dataPath = await fs.mkdtemp(
      require("node:path").join(os.tmpdir(), "energy-"),
    );
    await plugin.start(config, () => {});

    // Emit: sailing at 5kn (above min of 3kn), but power output is 0 (stowed)
    app.subscriptionmanager.subs.forEach(({ handler }) => {
      handler({
        context: "self",
        updates: [
          {
            values: [
              { path: "navigation.state", value: "sailing" },
              {
                path: "navigation.position",
                value: { latitude: 60, longitude: 18 },
              },
              { path: "navigation.speedThroughWater", value: 5 },
              { path: "electrical.hydro.sailinggen.power", value: 0 },
            ],
          },
        ],
      });
    });

    const internals = plugin.__getInternals();
    await internals.runPredictionCycle();

    const deployDeltas = app.handleMessageCalls
      .filter((c) => c.m.updates)
      .flatMap((c) => c.m.updates[0].values)
      .filter(
        (v) =>
          v.path ===
          "electrical.energy.prediction.deployment.sailinggen.detectedState",
      );

    assert.ok(deployDeltas.length > 0, "Should have published detectedState");
    assert.strictEqual(deployDeltas[0].value, "stowed");

    await plugin.stop();
    await fs.rm(app.dataPath, { recursive: true, force: true });
  });
});

test.describe("24-hour clock in engine run advisory", () => {
  test("uses 24-hour format in notification message", () => {
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test-plugin");

    // Create a runTime with specific window
    const start = new Date("2026-01-01T22:54:00Z");
    const end = new Date("2026-01-02T08:04:00Z");
    pub.publishEngineRunAdvisory({ hours: 9.2, optimalWindow: { start, end } });

    const notifCalls = app.handleMessageCalls
      .filter(
        (c) =>
          c.msg.updates &&
          c.msg.updates[0].values.some((v) =>
            v.path.startsWith("notifications."),
          ),
      )
      .flatMap((c) => c.msg.updates[0].values);

    const notif = notifCalls.find((v) => v.path.startsWith("notifications."));
    assert.ok(notif);
    assert.match(notif.value.message, /\d{2}:\d{2}-\d{2}:\d{2}/);
    // Should NOT contain AM/PM
    assert.doesNotMatch(notif.value.message, /AM|PM/);
  });
});
