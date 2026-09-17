/**
 * Smoketests for hydrogenerator deploy/stow verdicts and wind-generator
 * verdicts on forecast-degraded days.
 *
 * Incident (2026-09, Lille Ø, weather API down → tier-4 clear-sky forecast
 * with no wind): hydro recommendations flipped on every surf over the
 * stow limit and lull below cut-in (instantaneous STW against hard
 * thresholds), a missing paddlewheel fabricated "sailing too slow
 * (0.0kn)" stows, and a windless forecast tier collapsed to a fabricated
 * calm that stowed the wind generator in real wind.
 *
 * @file hydro-verdict.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PredictionEngine, msFromKnots } = require("../plugin/prediction.js");
const { AdvisoryPublisher } = require("../plugin/advisory.js");
const { parseManufacturerCurve } = require("../plugin/schema.js");

// --- Helpers --------------------------------------------------------------

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
  sustainedStwKn = null,
  stwKn = null,
  sogKn = null,
  measuredWindKn = null,
  gens = [HYDRO],
  engines = [],
  getEngineRunning = null,
} = {}) {
  const app = makeFakeApp();
  app.setSelfPath("navigation.state", navState);
  if (sustainedStwKn != null)
    app.setSelfPath("navigation.speedThroughWater", msFromKnots(stwKn ?? 0));
  if (stwKn != null)
    app.setSelfPath("navigation.speedThroughWater", msFromKnots(stwKn));
  if (sogKn != null)
    app.setSelfPath("navigation.speedOverGround", msFromKnots(sogKn));
  if (measuredWindKn != null)
    app.setSelfPath("environment.wind.speedTrue", msFromKnots(measuredWindKn));
  app.setSelfPath("electrical.batteries.house.capacity.stateOfCharge", 0.5);

  return new PredictionEngine({
    battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
    solarArrays: [],
    mechanicalGenerators: gens,
    engines,
    getEfficiency: () => 0.7,
    getSelfPath: (path) => app.getSelfPath(path),
    app,
    ...(getEngineRunning ? { getEngineRunning } : {}),
    // Window-averaged STW as index.js injects it
    getObservedStwMs:
      sustainedStwKn != null ? () => msFromKnots(sustainedStwKn) : () => null,
  });
}

/** A windless forecast (tier 3/4 shape): GHI but no wind fields at all. */
function windlessForecast(hours = 24) {
  const now = new Date();
  return Array.from({ length: hours }, (_, h) => ({
    time: new Date(now.getTime() + h * 3600000),
    ghi: 400,
    cloudCover: 0.2,
    gustSpeedMs: null,
    windSpeedMs: null,
  }));
}

function forecastWithWind(windKn, gustKn, hours = 24) {
  const now = new Date();
  return Array.from({ length: hours }, (_, h) => ({
    time: new Date(now.getTime() + h * 3600000),
    ghi: 400,
    cloudCover: 0.2,
    gustSpeedMs: msFromKnots(gustKn),
    windSpeedMs: msFromKnots(windKn),
  }));
}

function hydroRec(engine, detectedStates = null) {
  engine.runPrediction(windlessForecast());
  const recs = engine.getDeploymentRecommendations(detectedStates);
  return recs.find((r) => r.id === "hydro");
}

// --- Hydro verdicts ---------------------------------------------------------

test.describe("hydrogenerator deploy/stow verdicts", () => {
  test("sustained speed in range deploys", () => {
    const rec = hydroRec(makeEngine({ sustainedStwKn: 6 }));
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.match(rec.reason, /6\.0kn STW/);
  });

  test("a surf spike does not flip a deployed hydro (averaged basis)", () => {
    // Instantaneous reading spikes to 13 kn (over the 12 kn limit) but
    // the sustained speed is 7 kn: the verdict must stay deployed.
    const engine = makeEngine({ sustainedStwKn: 7, stwKn: 13 });
    const rec = hydroRec(engine);
    assert.strictEqual(rec.recommendedState, "deployed");
  });

  test("sustained speed over the limit stows, with hysteresis on recovery", () => {
    const engine = makeEngine({ sustainedStwKn: 12.5 });
    let rec = hydroRec(engine);
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /exceeds limit/);

    // Back to 11.5 kn — inside the 1 kn recovery band under 12: hold stow
    engine.getObservedStwMs = () => msFromKnots(11.5);
    rec = hydroRec(engine);
    assert.strictEqual(
      rec.recommendedState,
      "stowed",
      "recovery within the hysteresis band must hold the stow",
    );

    // Clearly under: deploy again
    engine.getObservedStwMs = () => msFromKnots(10.5);
    rec = hydroRec(engine);
    assert.strictEqual(rec.recommendedState, "deployed");
  });

  test("a lull below cut-in holds deployment within the band, then stows", () => {
    const engine = makeEngine({ sustainedStwKn: 5 });
    let rec = hydroRec(engine);
    assert.strictEqual(rec.recommendedState, "deployed");

    // Lull to 3.3 kn (min 4 − 1 kn band = 3): keep the hydro in the water
    engine.getObservedStwMs = () => msFromKnots(3.3);
    rec = hydroRec(engine);
    assert.strictEqual(
      rec.recommendedState,
      "deployed",
      "a lull within the hysteresis band must not stow",
    );

    // Sustained 2.5 kn: genuinely too slow
    engine.getObservedStwMs = () => msFromKnots(2.5);
    rec = hydroRec(engine);
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /too slow/);
  });

  test("missing STW falls back to SOG instead of fabricating 0 kn", () => {
    // No paddlewheel at all: SOG 6 kn must drive a deploy verdict, and
    // the reason must tell the crew which source it used.
    const engine = makeEngine({ sogKn: 6 });
    const rec = hydroRec(engine);
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.match(rec.reason, /SOG \(no STW\)/);
  });

  test("no speed source at all holds the detected state, honestly", () => {
    // The old behavior fabricated "sailing too slow (0.0kn < 4.0kn)" —
    // a stow recommendation with no data behind it.
    const engine = makeEngine({});
    let rec = hydroRec(engine, new Map([["hydro", "deployed"]]));
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.match(rec.reason, /no boat speed data/);

    // Unknown detected state: neutral stow, still no fabricated speed
    rec = hydroRec(engine, new Map());
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /no boat speed data/);
  });

  test("not sailing still stows (motoring verdict unchanged)", () => {
    const engine = makeEngine({ navState: "motoring", sustainedStwKn: 6 });
    const rec = hydroRec(engine);
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /requires sailing/);
  });
});

// --- Wind generator verdicts without forecast wind --------------------------

test.describe("wind generator verdicts on a windless forecast tier", () => {
  const WINDGEN = {
    id: "windgen",
    name: "Wind generator",
    type: "wind",
    deployable: true,
    manufacturerCurve: "5,5,10,15,15,55,20,140",
    startupSpeedKnots: 5,
    maxWindKnots: 30,
    curve: parseManufacturerCurve("5,5,10,15,15,55,20,140"),
  };

  const windRec = (engine, detectedStates = null) => {
    engine.runPrediction(windlessForecast());
    const recs = engine.getDeploymentRecommendations(detectedStates);
    return recs.find((r) => r.id === "windgen");
  };

  test("measured wind stands in for the missing forecast wind", () => {
    // The weather API is down (tier 4 carries no wind) but 18 kn is
    // blowing: the old fabricated calm stowed the generator.
    const engine = makeEngine({
      navState: "anchored",
      gens: [WINDGEN],
      measuredWindKn: 18,
    });
    const rec = windRec(engine);
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.match(rec.reason, /measured wind 18kn/);
  });

  test("genuinely calm measured wind stows with an honest reason", () => {
    const engine = makeEngine({
      navState: "anchored",
      gens: [WINDGEN],
      measuredWindKn: 3,
    });
    const rec = windRec(engine);
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /measured wind too low/);
  });

  test("no wind data from any source holds the detected state", () => {
    const engine = makeEngine({
      navState: "anchored",
      gens: [WINDGEN],
      measuredWindKn: null,
    });
    let rec = windRec(engine, new Map([["windgen", "deployed"]]));
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.match(rec.reason, /no wind data/);

    rec = windRec(engine, new Map());
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /no wind data/);
  });

  test("a forecast that carries wind still governs", () => {
    const engine = makeEngine({
      navState: "anchored",
      gens: [WINDGEN],
      measuredWindKn: 18, // measured says 18 kn…
    });
    engine.runPrediction(forecastWithWind(3, 5)); // …forecast says 3 kn
    const recs = engine.getDeploymentRecommendations(null);
    const rec = recs.find((r) => r.id === "windgen");
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.match(rec.reason, /forecast wind too low/);
  });
});

// --- Hydro down while motoring (rule violation) ----------------------------

test.describe("hydro down while motoring", () => {
  test("detected deployed while motoring flags an actual violation", () => {
    const engine = makeEngine({
      navState: "motoring",
      sustainedStwKn: 6,
    });
    const rec = hydroRec(engine, new Map([["hydro", "deployed"]]));
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.strictEqual(rec.actualViolation, true);
    assert.match(rec.reason, /hydro requires sailing/);
  });

  test("unknown detected state while motoring is treated as a violation", () => {
    const engine = makeEngine({
      navState: "motoring",
      sustainedStwKn: 6,
    });
    const rec = hydroRec(engine, new Map());
    assert.strictEqual(rec.actualViolation, true);
  });

  test("stowed while motoring is no violation", () => {
    const engine = makeEngine({
      navState: "motoring",
      sustainedStwKn: 6,
    });
    const rec = hydroRec(engine, new Map([["hydro", "stowed"]]));
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.notStrictEqual(rec.actualViolation, true);
  });

  test("at anchor there is no violation (undetectable, harmless)", () => {
    const engine = makeEngine({
      navState: "anchored",
      gens: [HYDRO],
    });
    const rec = hydroRec(engine, new Map([["hydro", "deployed"]]));
    assert.strictEqual(rec.recommendedState, "stowed");
    assert.notStrictEqual(rec.actualViolation, true);
  });

  test("the violation publishes as a warn with sound, not a visual-only note", () => {
    // A towed generator in the prop wash is an equipment-damage risk:
    // urgency reads it like an actual over-limit event (full intensity,
    // flip-cooldown carve-out), landing at the deployable cap (high).
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test");
    pub.publishDeploymentStates(
      [
        {
          id: "hydro",
          name: "Hydrogenerator",
          type: "hydro",
          recommendedState: "stowed",
          reason: "vessel motoring, hydro requires sailing",
          actualViolation: true,
        },
      ],
      new Map([["hydro", "deployed"]]),
      { isUnderway: true },
    );
    const notif = app.handleMessageCalls
      .flatMap((c) => c.msg.updates[0].values)
      .find(
        (v) =>
          v.path === "notifications.electrical.energy.deploy_hydro" &&
          v.value.state !== "normal",
      );
    assert.ok(notif, "expected a deploy_hydro notification");
    assert.strictEqual(notif.value.state, "warn");
    assert.ok(notif.value.method.includes("sound"));
    assert.match(notif.value.message, /Stow now/);
    assert.match(notif.value.message, /hydro requires sailing/);
  });
});
