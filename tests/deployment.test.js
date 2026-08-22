/**
 * Tests for the unified deployment recommendation system.
 * @file deployment.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PredictionEngine, LoadProfile } = require("../plugin/prediction.js");
const { nextSunrise, lastSunset } = require("../plugin/solar.js");
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
  if (speed != null)
    a.setSelfPath("navigation.speedThroughWater", speed / 1.94384); // knots to m/s

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
    // Values are forecast-derived and labeled as such, without a
    // "Deploy - " prefix (the action lives in recommendedState)
    assert.strictEqual(rec.reason, "forecast wind 12kn (gusts 15kn)");
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

  test("notification message joins action with comma and formats kWh", () => {
    const app = makeFakeApp();
    app.selfId = "self";
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const recs = [
      {
        id: "windgen",
        name: "Superwind 350",
        type: "wind",
        recommendedState: "deployed",
        reason: "forecast wind 19kn (gusts 24kn)",
        missedYieldWh: 3470,
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
    assert.strictEqual(
      notif.value.message,
      "Superwind 350: Deploy now, forecast wind 19kn (gusts 24kn) (3.5kWh in 24h)",
    );
  });

  test("notification message for stow uses comma join", () => {
    const app = makeFakeApp();
    app.selfId = "self";
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const recs = [
      {
        id: "flinsail",
        name: "FLINsail",
        type: "solar-deployable",
        recommendedState: "stowed",
        reason: "forecast gusts 24kn exceed limit of 20kn",
      },
    ];
    const currentStates = new Map([["flinsail", "deployed"]]);

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
    assert.strictEqual(
      notif.value.message,
      "FLINsail: Stow now, forecast gusts 24kn exceed limit of 20kn",
    );
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

  test("normal notification includes potential yield for deployed recommendation", () => {
    const { app, pub } = makePublisher();
    const recs = [
      {
        id: "windgen",
        name: "Superwind 350",
        type: "wind",
        recommendedState: "deployed",
        reason: "forecast wind 19kn (gusts 24kn)",
        missedYieldWh: 3470,
      },
    ];
    const currentStates = new Map([["windgen", "deployed"]]);

    pub.publishDeploymentStates(recs, currentStates);

    const notifCalls = app.handleMessageCalls.filter(
      (c) =>
        c.msg.updates &&
        c.msg.updates[0].values.some((v) =>
          v.path.startsWith("notifications."),
        ),
    );
    const notif = notifCalls[0].msg.updates[0].values.find((v) =>
      v.path.startsWith("notifications."),
    );
    assert.ok(notif);
    assert.strictEqual(notif.value.state, "normal");
    assert.strictEqual(
      notif.value.message,
      "Superwind 350: forecast wind 19kn (gusts 24kn) (3.5kWh in 24h)",
    );
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
      getDataDirPath() {
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
      getDataDirPath() {
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
      getDataDirPath() {
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
              { path: "environment.wind.speedApparent", value: 2 },
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

    // Wind 2 m/s (~3.9kn) is below startup speed of 8kn, so we cannot infer stow
    assert.ok(deployDeltas.length > 0, "Should have published detectedState");
    assert.strictEqual(deployDeltas[0].value, null);

    await plugin.stop();
    await fs.rm(app.dataPath, { recursive: true, force: true });
  });

  test("wind generator detected as stowed with sustained wind above startup", async () => {
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
      }
      getSelfPath(p) {
        return this.pathValues.get(p);
      }
      getDataDirPath() {
        return this.dataPath;
      }
      debug() {}
      error() {}
      setPluginStatus() {}
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
          startupSpeedKnots: 5,
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

    // Emit multiple wind deltas above startup threshold (sustained wind)
    // 6 m/s = ~11.7kn, well above 5kn startup
    // Use timestamps 60s apart to simulate sustained wind over time
    const baseTime = new Date("2026-01-01T12:00:00Z");
    for (let i = 0; i < 3; i++) {
      const ts = new Date(baseTime.getTime() + i * 60000);
      app.subscriptionmanager.subs.forEach(({ handler }) => {
        handler({
          context: "self",
          updates: [
            {
              timestamp: ts.toISOString(),
              values: [{ path: "environment.wind.speedApparent", value: 6 }],
            },
          ],
        });
      });
    }
    // Final delta with all state
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

    assert.ok(deployDeltas.length > 0, "Should have published detectedState");
    assert.strictEqual(deployDeltas[0].value, "stowed");

    await plugin.stop();
    await fs.rm(app.dataPath, { recursive: true, force: true });
  });

  test("wind generator not inferred stowed from single gust above startup", async () => {
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
      }
      getSelfPath(p) {
        return this.pathValues.get(p);
      }
      getDataDirPath() {
        return this.dataPath;
      }
      debug() {}
      error() {}
      setPluginStatus() {}
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
          startupSpeedKnots: 5,
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

    // Emit single wind delta above threshold (just a gust)
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

    // Single reading (a gust) is not enough to infer stowed
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
      getDataDirPath() {
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

test.describe("FLINsail pointing recommendation (port/starboard)", () => {
  test("sun to starboard → recommendedSide starboard", () => {
    const app = makeFakeApp();
    // Position at midday, sun due east (azimuth 90° = π/2)
    // Heading north (0°) → sun is to starboard
    app.setSelfPath("navigation.position", {
      latitude: 0,
      longitude: 0,
    });
    app.setSelfPath("navigation.headingTrue", 0); // facing north
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
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
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Override sunPosition via a known time: use equinox noon at equator,
    // sun is nearly overhead. Instead, mock by setting a time where azimuth is known.
    // We use a real date and position where we can predict the result.
    // At lat=0, lon=0, on 2026-03-20 06:00 UTC, sun is near due east (azimuth ~90°).
    // But altitude is near 0 at sunrise, which triggers morning mode.
    // Let's use 09:00 UTC: sun is to the east, altitude well above horizon.
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(`2026-03-20T${h.toString().padStart(2, "0")}:00:00Z`),
      ghi: 500,
      cloudCover: 0,
      gustSpeedKnots: 0,
      windSpeedKnots: 0,
      windDirectionDeg: null,
    }));
    // Patch Date.now to return our test time
    const realNow = Date.now;
    Date.now = () => new Date("2026-03-20T09:00:00Z").getTime();
    try {
      engine.runPrediction(forecast);
      const recs = engine.getDeploymentRecommendations();
      const rec = recs.find((r) => r.id === "flinsail");
      assert.strictEqual(rec.recommendedState, "deployed");
      assert.strictEqual(rec.recommendedSide, "starboard");
      assert.ok(rec.recommendedSideTime);
    } finally {
      Date.now = realNow;
    }
  });

  test("sun to port → recommendedSide port", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 0,
      longitude: 0,
    });
    // Heading north (0°), sun azimuth ~270° (west) → port
    app.setSelfPath("navigation.headingTrue", 0);
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
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
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // At 15:00 UTC at equator, sun is to the west (azimuth ~270°)
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(`2026-03-20T${h.toString().padStart(2, "0")}:00:00Z`),
      ghi: 500,
      cloudCover: 0,
      gustSpeedKnots: 0,
      windSpeedKnots: 0,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => new Date("2026-03-20T15:00:00Z").getTime();
    try {
      engine.runPrediction(forecast);
      const recs = engine.getDeploymentRecommendations();
      const rec = recs.find((r) => r.id === "flinsail");
      assert.strictEqual(rec.recommendedState, "deployed");
      assert.strictEqual(rec.recommendedSide, "port");
    } finally {
      Date.now = realNow;
    }
  });

  test("stowed (underway) → recommendedSide null", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "sailing");
    const engine = makePredictionEngine({
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
          powerPath: "electrical.solar.flinsail.power",
        },
      ],
      navState: "sailing",
      app,
    });
    engine.runPrediction(makeForecastWithGusts(0, 0));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "flinsail");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.strictEqual(rec.recommendedSide, null);
    assert.strictEqual(rec.recommendedSideTime, null);
  });

  test("heading missing → recommendedSide null with reason", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 0,
      longitude: 0,
    });
    // No heading set → null
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
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
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(`2026-03-20T${h.toString().padStart(2, "0")}:00:00Z`),
      ghi: 500,
      cloudCover: 0,
      gustSpeedKnots: 0,
      windSpeedKnots: 0,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => new Date("2026-03-20T09:00:00Z").getTime();
    try {
      engine.runPrediction(forecast);
      const recs = engine.getDeploymentRecommendations();
      const rec = recs.find((r) => r.id === "flinsail");
      assert.strictEqual(rec.recommendedState, "deployed");
      assert.strictEqual(rec.recommendedSide, null);
      assert.match(rec.reason, /No heading/);
    } finally {
      Date.now = realNow;
    }
  });

  test("AdvisoryPublisher publishes recommendedSide and recommendedSideTime", () => {
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const targetTime = new Date("2026-03-20T09:00:00Z").toISOString();
    pub.publishDeploymentStates(
      [
        {
          id: "flinsail",
          name: "FLINsail",
          type: "solar-deployable",
          recommendedState: "deployed",
          reason: "Deploy - no gusts. Point starboard",
          recommendedSide: "starboard",
          recommendedSideTime: targetTime,
          missedYieldWh: 0,
        },
      ],
      new Map([["flinsail", "stowed"]]),
    );

    const deltas = app.handleMessageCalls
      .filter((c) => c.msg.updates)
      .flatMap((c) => c.msg.updates[0].values);
    const side = deltas.find(
      (v) =>
        v.path ===
        "electrical.energy.prediction.deployment.flinsail.recommendedSide",
    );
    const target = deltas.find(
      (v) =>
        v.path ===
        "electrical.energy.prediction.deployment.flinsail.recommendedSideTime",
    );
    assert.ok(side, "recommendedSide should be published");
    assert.strictEqual(side.value, "starboard");
    assert.ok(target, "recommendedSideTime should be published");
    assert.strictEqual(target.value, targetTime);
  });

  test("AdvisoryPublisher does NOT publish pointing for wind/hydro generators", () => {
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test-plugin");
    pub.publishDeploymentStates(
      [
        {
          id: "sailinggen",
          name: "Sailing Generator",
          type: "wind",
          recommendedState: "deployed",
          reason: "Deploy - wind sufficient",
          missedYieldWh: 0,
        },
        {
          id: "hydrogen",
          name: "Hydro Generator",
          type: "hydro",
          recommendedState: "stowed",
          reason: "Stow - not sailing",
          missedYieldWh: 0,
        },
      ],
      new Map(),
    );

    const deltas = app.handleMessageCalls
      .filter((c) => c.msg.updates)
      .flatMap((c) => c.msg.updates[0].values);
    const windSide = deltas.find(
      (v) =>
        v.path ===
        "electrical.energy.prediction.deployment.sailinggen.recommendedSide",
    );
    const windTarget = deltas.find(
      (v) =>
        v.path ===
        "electrical.energy.prediction.deployment.sailinggen.recommendedSideTime",
    );
    const hydroSide = deltas.find(
      (v) =>
        v.path ===
        "electrical.energy.prediction.deployment.hydrogen.recommendedSide",
    );
    assert.strictEqual(windSide, undefined);
    assert.strictEqual(windTarget, undefined);
    assert.strictEqual(hydroSide, undefined);
  });

  test("FLINsail recommendedStateTime: stow now, deploy when gusts drop", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
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
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Forecast: first 5 hours gusts 25kn (above limit), then drops to 10kn
    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 500,
      cloudCover: 0,
      gustSpeedKnots: h < 5 ? 25 : 10,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      engine.runPrediction(forecast);
      const rec = engine
        .getDeploymentRecommendations()
        .find((r) => r.id === "flinsail");
      assert.strictEqual(rec.recommendedState, "stowed");
      // Gusts drop at hour 5 (17:00Z), which is after sunset at 60°N in March.
      // Night-time deploy shifts to the next sunrise instead
      assert.ok(rec.recommendedStateTime);
      const changeTime = new Date(rec.recommendedStateTime);
      const expectedSunrise = nextSunrise(
        new Date(now.getTime() + 5 * 3600000),
        60,
        18,
      );
      assert.strictEqual(changeTime.getTime(), expectedSunrise.getTime());
    } finally {
      Date.now = realNow;
    }
  });

  test("FLINsail recommendedStateTime: null when state stays same", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
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
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Forecast: gusts always below limit → stays deployed
    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 500,
      cloudCover: 0,
      gustSpeedKnots: 10,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      engine.runPrediction(forecast);
      const rec = engine
        .getDeploymentRecommendations()
        .find((r) => r.id === "flinsail");
      assert.strictEqual(rec.recommendedState, "deployed");
      assert.strictEqual(rec.recommendedStateTime, null);
    } finally {
      Date.now = realNow;
    }
  });

  test("wind generator recommendedStateTime: stow now (gusts), deploy when gusts drop", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        withCurve({
          id: "windgen",
          type: "wind",
          deployable: true,
          powerPath: "electrical.wind.power",
          maxWindKnots: 30,
          startupSpeedKnots: 5,
        }),
      ],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Gusts exceed max (35kn) for first 3 hours, then drop to 15kn (below 30 limit)
    // Wind always 8kn (above startup 5)
    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 500,
      cloudCover: 0,
      gustSpeedKnots: h < 3 ? 35 : 15,
      windSpeedKnots: 8,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      engine.runPrediction(forecast);
      const rec = engine
        .getDeploymentRecommendations()
        .find((r) => r.id === "windgen");
      assert.strictEqual(rec.recommendedState, "stowed");
      assert.ok(rec.recommendedStateTime);
      const changeTime = new Date(rec.recommendedStateTime);
      assert.strictEqual(
        changeTime.getTime(),
        new Date(now.getTime() + 3 * 3600000).getTime(),
      );
    } finally {
      Date.now = realNow;
    }
  });

  test("hydro recommendedStateTime: null (depends on boat speed, not forecast)", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        withCurve({
          id: "hydrogen",
          type: "hydro",
          deployable: true,
          powerPath: "electrical.hydro.power",
          minSpeedKnots: 3,
          maxSpeedKnots: 12,
        }),
      ],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 500,
      cloudCover: 0,
      gustSpeedKnots: 0,
      windSpeedKnots: 0,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      engine.runPrediction(forecast);
      const rec = engine
        .getDeploymentRecommendations()
        .find((r) => r.id === "hydrogen");
      assert.strictEqual(rec.recommendedState, "stowed");
      assert.strictEqual(rec.recommendedStateTime, null);
    } finally {
      Date.now = realNow;
    }
  });

  test("two yield tracks: recommended vs detected (Superwind stowed for repair)", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        withCurve({
          id: "windgen",
          type: "wind",
          deployable: true,
          powerPath: "electrical.wind.power",
          maxWindKnots: 30,
          startupSpeedKnots: 5,
          manufacturerCurve: "6,30,8,100,10,170,12,220",
        }),
      ],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Wind 10kn, gusts 15kn (both below limits) → recommended: deployed
    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 0,
      cloudCover: 0,
      gustSpeedKnots: 15,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      // Detected as stowed (e.g. being repaired) → detected track should be 0
      const detectedStates = new Map([["windgen", "stowed"]]);
      engine.runPrediction(forecast, detectedStates);
      const rec = engine
        .getDeploymentRecommendations()
        .find((r) => r.id === "windgen");
      // Recommended: deployed (conditions are fine)
      assert.strictEqual(rec.recommendedState, "deployed");
      // Recommended track: wind yield > 0 (should be deployed)
      assert.ok(
        engine.lastPrediction[0].idealWindYieldWh > 0,
        "Recommended track should have wind yield (conditions fine)",
      );
      // Detected track: yield 0 (detected as stowed)
      assert.strictEqual(
        engine.lastPrediction[0].detectedYieldWh,
        0,
        "Detected track yield should be 0 (device stowed for repair)",
      );
      // Net tracks diverge: recommended is positive, detected is negative (load only)
      assert.ok(
        engine.lastPrediction[0].idealNetWh >
          engine.lastPrediction[0].detectedNetWh,
        "Recommended net should exceed detected net",
      );
    } finally {
      Date.now = realNow;
    }
  });

  test("two yield tracks match when device detected as deployed", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        withCurve({
          id: "windgen",
          type: "wind",
          deployable: true,
          powerPath: "electrical.wind.power",
          maxWindKnots: 30,
          startupSpeedKnots: 5,
          manufacturerCurve: "6,30,8,100,10,170,12,220",
        }),
      ],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 0,
      cloudCover: 0,
      gustSpeedKnots: 15,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      // Detected as deployed → both tracks should match
      const detectedStates = new Map([["windgen", "deployed"]]);
      engine.runPrediction(forecast, detectedStates);
      assert.strictEqual(
        engine.lastPrediction[0].idealWindYieldWh,
        engine.lastPrediction[0].detectedYieldWh,
        "Tracks should match when device detected as deployed",
      );
      assert.strictEqual(
        engine.lastPrediction[0].idealNetWh,
        engine.lastPrediction[0].detectedNetWh,
        "Net tracks should match when device detected as deployed",
      );
    } finally {
      Date.now = realNow;
    }
  });

  test("deployable solar deployed against stow advice produces on the detected track only", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
          powerPath: "electrical.solar.flinsail.panelPower",
        },
      ],
      mechanicalGenerators: [],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Daytime GHI but gusts over the stow limit: ideal track stows FLINsail
    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 500,
      cloudCover: 0,
      gustSpeedKnots: 25,
      windSpeedKnots: 18,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      // FLINsail actually deployed despite the stow recommendation
      const detectedStates = new Map([["flinsail", "deployed"]]);
      engine.runPrediction(forecast, detectedStates);

      const first = engine.lastPrediction[0];
      assert.strictEqual(
        first.idealSolarYieldWh,
        0,
        "Ideal track should assume FLINsail stowed (gusts over limit)",
      );
      assert.ok(
        first.detectedYieldWh > 0,
        "Detected track should credit the actually-deployed array",
      );
      const last = engine.lastPrediction[engine.lastPrediction.length - 1];
      assert.ok(
        last.detectedSoC > last.idealSoC,
        "Detected SoC should run above ideal when the array is deployed against advice",
      );
    } finally {
      Date.now = realNow;
    }
  });

  test("deployable wind generator deployed against gust advice produces on the detected track only", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        withCurve({
          id: "windgen",
          type: "wind",
          deployable: true,
          powerPath: "electrical.wind.power",
          maxWindKnots: 30,
          manufacturerCurve: "6,30,8,100,10,170,12,220",
        }),
      ],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Wind 20kn (spinning) but gusts 35kn over the 30kn stow limit
    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 0,
      cloudCover: 0,
      gustSpeedKnots: 35,
      windSpeedKnots: 20,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      const detectedStates = new Map([["windgen", "deployed"]]);
      engine.runPrediction(forecast, detectedStates);

      const first = engine.lastPrediction[0];
      assert.strictEqual(
        first.idealWindYieldWh,
        0,
        "Ideal track should assume wind generator stowed (gusts over limit)",
      );
      assert.ok(
        first.detectedYieldWh > 0,
        "Detected track should credit the actually-deployed generator",
      );
    } finally {
      Date.now = realNow;
    }
  });

  test("fixed-mount wind generator produces on the detected track above max wind", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        withCurve({
          id: "windgen",
          type: "wind",
          deployable: false,
          powerPath: "electrical.wind.power",
          maxWindKnots: 30,
          manufacturerCurve: "6,30,8,100,10,170,12,220,20,300,25,350,30,300",
        }),
      ],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Wind 35kn exceeds the 30kn limit: ideal track assumes stow, but a
    // fixed mount cannot be stowed and keeps producing
    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 0,
      cloudCover: 0,
      gustSpeedKnots: 35,
      windSpeedKnots: 35,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      engine.runPrediction(forecast);

      const first = engine.lastPrediction[0];
      assert.strictEqual(
        first.idealWindYieldWh,
        0,
        "Ideal track should assume wind generator stowed (wind over limit)",
      );
      assert.ok(
        first.detectedYieldWh > 0,
        "Detected track should credit the fixed-mount generator",
      );
    } finally {
      Date.now = realNow;
    }
  });

  test("hourly actions: ideal deploy, detected needs deploy (stowed for repair)", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        withCurve({
          id: "windgen",
          type: "wind",
          deployable: true,
          powerPath: "electrical.wind.power",
          maxWindKnots: 30,
          startupSpeedKnots: 5,
          manufacturerCurve: "6,30,8,100,10,170,12,220",
        }),
      ],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Wind 10kn, gusts 15kn (below limits) → ideal: deploy
    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 0,
      cloudCover: 0,
      gustSpeedKnots: 15,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      const detectedStates = new Map([["windgen", "stowed"]]);
      engine.runPrediction(forecast, detectedStates);
      const actions = engine.lastPrediction[0].actions;
      const windAction = actions.find((a) => a.id === "windgen");
      assert.strictEqual(windAction.idealAction, "deploy");
      // Detected as stowed, ideal is deploy → detectedAction = deploy
      assert.strictEqual(windAction.detectedAction, "deploy");
      assert.match(windAction.reason, /wind.*startup/);
    } finally {
      Date.now = realNow;
    }
  });

  test("hourly actions: no action entry when already in ideal state (stay)", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        withCurve({
          id: "windgen",
          type: "wind",
          deployable: true,
          powerPath: "electrical.wind.power",
          maxWindKnots: 30,
          startupSpeedKnots: 5,
          manufacturerCurve: "6,30,8,100,10,170,12,220",
        }),
      ],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Gusts 35kn (exceeds max 30) → ideal: stow. Detected as already stowed
    // → nothing to do, no action entry at hour 0
    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, () => ({
      time: new Date(now.getTime()),
      ghi: 0,
      cloudCover: 0,
      gustSpeedKnots: 35,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      const detectedStates = new Map([["windgen", "stowed"]]);
      engine.runPrediction(forecast, detectedStates);
      assert.strictEqual(
        engine.lastPrediction[0].actions.find((a) => a.id === "windgen"),
        undefined,
        "Device already stowed in stow conditions should produce no action",
      );
    } finally {
      Date.now = realNow;
    }
  });

  test("hourly actions: FLINsail stows when gusts exceed limit", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
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
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Gusts 25kn (exceeds limit 20) → ideal: stow
    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, () => ({
      time: new Date(now.getTime()),
      ghi: 500,
      cloudCover: 0,
      gustSpeedKnots: 25,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      // Detected as deployed → detectedAction = stow (needs to stow)
      const detectedStates = new Map([["flinsail", "deployed"]]);
      engine.runPrediction(forecast, detectedStates);
      const actions = engine.lastPrediction[0].actions;
      const solarAction = actions.find((a) => a.id === "flinsail");
      assert.strictEqual(solarAction.idealAction, "stow");
      assert.strictEqual(solarAction.detectedAction, "stow");
      assert.match(solarAction.reason, /gusts.*limit/);
    } finally {
      Date.now = realNow;
    }
  });

  test("hourly actions: detectedAction null when detected state unknown", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        withCurve({
          id: "windgen",
          type: "wind",
          deployable: true,
          powerPath: "electrical.wind.power",
          maxWindKnots: 30,
          startupSpeedKnots: 5,
          manufacturerCurve: "6,30,8,100,10,170,12,220",
        }),
      ],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, () => ({
      time: new Date(now.getTime()),
      ghi: 0,
      cloudCover: 0,
      gustSpeedKnots: 15,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      // No detected states passed → all unknown
      engine.runPrediction(forecast);
      const actions = engine.lastPrediction[0].actions;
      const windAction = actions.find((a) => a.id === "windgen");
      assert.strictEqual(windAction.idealAction, "deploy");
      assert.strictEqual(windAction.detectedAction, null);
    } finally {
      Date.now = realNow;
    }
  });

  test("hourly actions only emitted on state change, not repeated every hour", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        withCurve({
          id: "windgen",
          type: "wind",
          deployable: true,
          powerPath: "electrical.wind.power",
          maxWindKnots: 30,
          startupSpeedKnots: 5,
          manufacturerCurve: "6,30,8,100,10,170,12,220",
        }),
      ],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Gusts 35kn (above 30 limit) for hours 0-2, then 15kn (below limit) for hours 3+.
    // Wind always 10kn (above startup).
    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 0,
      cloudCover: 0,
      gustSpeedKnots: h < 3 ? 35 : 15,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      engine.runPrediction(forecast);
      // Hour 0: baseline, action emitted (stow)
      const h0 = engine.lastPrediction[0].actions.find(
        (a) => a.id === "windgen",
      );
      assert.strictEqual(h0.idealAction, "stow");
      // Hours 1-2: still stowed, no repeated action
      assert.strictEqual(
        engine.lastPrediction[1].actions.find((a) => a.id === "windgen"),
        undefined,
        "Hour 1 should not repeat the stow action",
      );
      assert.strictEqual(
        engine.lastPrediction[2].actions.find((a) => a.id === "windgen"),
        undefined,
        "Hour 2 should not repeat the stow action",
      );
      // Hour 3: gusts drop → deploy action emitted
      const h3 = engine.lastPrediction[3].actions.find(
        (a) => a.id === "windgen",
      );
      assert.strictEqual(h3.idealAction, "deploy");
      assert.match(h3.reason, /gusts.*limit|wind.*startup/);
      // Hour 4: still deployed, no repeated action
      assert.strictEqual(
        engine.lastPrediction[4].actions.find((a) => a.id === "windgen"),
        undefined,
        "Hour 4 should not repeat the deploy action",
      );
    } finally {
      Date.now = realNow;
    }
  });

  test("FLINsail stow triggered at night is reported at sunset", () => {
    const app = makeFakeApp();
    // Helsinki midsummer: sunset 2026-06-20T19:50:54Z, sunrise 2026-06-21T00:55:14Z
    app.setSelfPath("navigation.position", {
      latitude: 60.17,
      longitude: 24.94,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
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
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Gusts 25kn only at hour 14 (00:00Z, night). Night block is h10-h14
    // (20:00Z-00:00Z). Night max gust exceeds limit → stow from sunset on.
    const now = new Date("2026-06-20T10:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 500,
      cloudCover: 0,
      gustSpeedKnots: h === 14 ? 25 : 10,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      engine.runPrediction(forecast);

      // The stow action must NOT be at the night hour (h10, 20:00Z)...
      assert.strictEqual(
        engine.lastPrediction[10].actions.find((a) => a.id === "flinsail"),
        undefined,
        "Stow action must not sit at the night hour",
      );
      // ...but in the hour bucket containing sunset, with the exact sunset time
      const sunsetBucket = engine.lastPrediction[9].actions.find(
        (a) => a.id === "flinsail",
      );
      assert.ok(
        sunsetBucket,
        "Stow action should be in the sunset hour bucket",
      );
      assert.strictEqual(sunsetBucket.idealAction, "stow");
      assert.strictEqual(sunsetBucket.type, "solar-deployable");
      const expectedSunset = lastSunset(
        new Date("2026-06-20T20:00:00Z"),
        60.17,
        24.94,
      );
      assert.strictEqual(sunsetBucket.time, expectedSunset.toISOString());
    } finally {
      Date.now = realNow;
    }
  });

  test("FLINsail deploy suggested at night is reported at sunrise", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60.17,
      longitude: 24.94,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
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
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Forecast starts at night (22:00Z), gusts fine throughout.
    // Hour 0 baseline: deployed → deploy action, but at a night hour
    const now = new Date("2026-06-20T22:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 0,
      cloudCover: 0,
      gustSpeedKnots: 10,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      engine.runPrediction(forecast);

      // The deploy action must NOT be at hour 0 (night)...
      assert.strictEqual(
        engine.lastPrediction[0].actions.find((a) => a.id === "flinsail"),
        undefined,
        "Deploy action must not sit at a night hour",
      );
      // ...but at sunrise (00:55:14Z next day), in the hour bucket containing it
      const sunriseBucket = engine.lastPrediction[2].actions.find(
        (a) => a.id === "flinsail",
      );
      assert.ok(sunriseBucket, "Deploy action should be at the sunrise bucket");
      assert.strictEqual(sunriseBucket.idealAction, "deploy");
      const expectedSunrise = nextSunrise(now, 60.17, 24.94);
      assert.strictEqual(sunriseBucket.time, expectedSunrise.toISOString());
    } finally {
      Date.now = realNow;
    }
  });

  test("FLINsail night stow when sunset already passed is stamped now", () => {
    const app = makeFakeApp();
    // Helsinki June: sunset 2026-06-20T19:50:54Z. Forecast starts at 22:00Z,
    // already in the night, with gusts above the limit all night.
    app.setSelfPath("navigation.position", {
      latitude: 60.17,
      longitude: 24.94,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
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
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    const now = new Date("2026-06-20T22:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 0,
      cloudCover: 0,
      gustSpeedKnots: 25,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      // Detected deployed: in gusty night, stow is needed
      engine.runPrediction(forecast, new Map([["flinsail", "deployed"]]));
      const stow = engine.lastPrediction[0].actions.find(
        (a) => a.id === "flinsail",
      );
      assert.ok(stow, "Stow action should be present");
      assert.strictEqual(stow.idealAction, "stow");
      assert.match(stow.reason, /night gusts/);
      // Sunset 19:50Z already passed: the advice is "stow now", not a past time
      assert.strictEqual(
        stow.time,
        engine.lastPrediction[0].time.toISOString(),
        "Past sunset should clamp to the current hour's time",
      );
    } finally {
      Date.now = realNow;
    }
  });

  test("FLINsail day-time actions stay at their hour (no shift)", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60.17,
      longitude: 24.94,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
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
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Gusts 25kn at hour 5 (15:00Z, day) → stow at that hour, unshifted
    const now = new Date("2026-06-20T10:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 500,
      cloudCover: 0,
      gustSpeedKnots: h === 5 ? 25 : 10,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      engine.runPrediction(forecast);
      const stow = engine.lastPrediction[5].actions.find(
        (a) => a.id === "flinsail",
      );
      assert.ok(stow, "Stow action should be at hour 5");
      assert.strictEqual(stow.idealAction, "stow");
      // Day-time action keeps the bucket time, no sun-boundary shift
      assert.strictEqual(
        stow.time,
        new Date(now.getTime() + 5 * 3600000).toISOString(),
      );
    } finally {
      Date.now = realNow;
    }
  });

  test("idealWindYieldWh is 0 in hours when gusts exceed max (deployable wind stowed)", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60,
      longitude: 18,
    });
    app.setSelfPath("navigation.state", "moored");

    const engine = new PredictionEngine({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
      mechanicalGenerators: [
        withCurve({
          id: "windgen",
          type: "wind",
          deployable: true,
          powerPath: "electrical.wind.power",
          maxWindKnots: 30,
          startupSpeedKnots: 5,
          manufacturerCurve: "6,30,8,100,10,170,12,220,14,280",
        }),
      ],
      getEfficiency: () => 0.7,
      getSelfPath: (path) => app.getSelfPath(path),
      app,
    });

    // Gusts exceed max (35kn) for first 3 hours, then drop to 15kn
    // Wind always 10kn (above startup, below max)
    const now = new Date("2026-03-20T12:00:00Z");
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 0,
      cloudCover: 0,
      gustSpeedKnots: h < 3 ? 35 : 15,
      windSpeedKnots: 10,
      windDirectionDeg: null,
    }));
    const realNow = Date.now;
    Date.now = () => now.getTime();
    try {
      engine.runPrediction(forecast);
      // Hours 0-2: gusts 35kn >= max 30kn → idealWindYieldWh should be 0
      assert.strictEqual(
        engine.lastPrediction[0].idealWindYieldWh,
        0,
        "Hour 0 gusts exceed limit, yield should be 0",
      );
      assert.strictEqual(
        engine.lastPrediction[1].idealWindYieldWh,
        0,
        "Hour 1 gusts exceed limit, yield should be 0",
      );
      assert.strictEqual(
        engine.lastPrediction[2].idealWindYieldWh,
        0,
        "Hour 2 gusts exceed limit, yield should be 0",
      );
      // Hour 3: gusts drop to 15kn, wind 10kn → should generate
      assert.ok(
        engine.lastPrediction[3].idealWindYieldWh > 0,
        "Hour 3 gusts below limit, should generate",
      );
    } finally {
      Date.now = realNow;
    }
  });

  test("AdvisoryPublisher publishes recommendedStateTime", () => {
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const stateTime = new Date("2026-03-20T17:00:00Z").toISOString();
    pub.publishDeploymentStates(
      [
        {
          id: "flinsail",
          name: "FLINsail",
          type: "solar-deployable",
          recommendedState: "stowed",
          reason: "Stow - gusts 25kn exceed limit of 20kn",
          recommendedSide: null,
          recommendedSideTime: null,
          recommendedStateTime: stateTime,
          missedYieldWh: 0,
        },
      ],
      new Map(),
    );

    const deltas = app.handleMessageCalls
      .filter((c) => c.msg.updates)
      .flatMap((c) => c.msg.updates[0].values);
    const stateTimeDelta = deltas.find(
      (v) =>
        v.path ===
        "electrical.energy.prediction.deployment.flinsail.recommendedStateTime",
    );
    assert.ok(stateTimeDelta, "recommendedStateTime should be published");
    assert.strictEqual(stateTimeDelta.value, stateTime);
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
