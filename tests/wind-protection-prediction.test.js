/**
 * Integration smoketests for Wind Protection Factor application in the
 * prediction engine.
 *
 * Verifies that when getWindProtection returns a corrected (reduced) wind/
 * gust for the current place, the FLINsail gust gate and the wind
 * generator curve + max-wind gate consume the *corrected* values, and that
 * under way (getWindProtection returns null) the forecast passes through
 * unchanged.
 *
 * @file wind-protection-prediction.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PredictionEngine, msFromKnots } = require("../plugin/prediction.js");
const { parseManufacturerCurve } = require("../plugin/schema.js");

function withCurve(gen) {
  return { ...gen, curve: parseManufacturerCurve(gen.manufacturerCurve) };
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
  };
}

/**
 * A 24-hour forecast with explicit wind direction so WPF can select a
 * sector. Day hours (sun above horizon) so FLINsail deployment isn't
 * suppressed by the night handling.
 */
function makeForecast(gustKnots, windKnots, dirDeg = 180) {
  const now = new Date();
  // Test authors pass knot magnitudes; the engine works in m/s, so
  // convert at this fixture boundary.
  const gustMs = msFromKnots(gustKnots);
  const windMs = msFromKnots(windKnots);
  return Array.from({ length: 24 }, (_, h) => ({
    time: new Date(now.getTime() + h * 3600000),
    ghi: 500,
    cloudCover: 0.3,
    gustSpeedMs: gustMs,
    windSpeedMs: windMs,
    windDirectionDeg: dirDeg,
  }));
}

function makeEngine({
  solarArrays,
  generators,
  navState,
  getWindProtection,
  app,
}) {
  const a = app || makeFakeApp();
  // Position is required for WPF selection; lat/lon set by caller via app
  if (navState != null) a.setSelfPath("navigation.state", navState);
  return new PredictionEngine({
    battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
    solarArrays: solarArrays || [],
    mechanicalGenerators: (generators || []).map(withCurve),
    getEfficiency: () => 0.7,
    getSelfPath: (path) => a.getSelfPath(path),
    getWindProtection,
    app: a,
  });
}

test.describe("WPF application: FLINsail gust gate", () => {
  test("reduces a false-stow: raw gust over limit, corrected gust under", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60.1,
      longitude: 21.8,
    });
    app.setSelfPath("navigation.state", "anchored");

    // Forecast gust 25 kn ≥ limit 20 → would stow without WPF. WPF halves
    // the gust (and wind) at device height, bringing the gate-eligible
    // value to 12.5 kn → deploy.
    const getWindProtection = (speed, gust) => ({
      speed: speed * 0.5,
      gust: gust * 0.5,
    });

    const engine = makeEngine({
      app,
      navState: "anchored",
      getWindProtection,
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
        },
      ],
    });

    engine.runPrediction(makeForecast(25, 15));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "flinsail");
    assert.strictEqual(rec.recommendedState, "deployed");
    // The recorded max gust in lastPrediction reflects the corrected value
    const maxGust = engine.getMaxForecastGust();
    assert.ok(maxGust <= 13, `corrected max gust ${maxGust} should be ~12.5`);
  });

  test("passes forecast through when getWindProtection returns null (under way)", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60.1,
      longitude: 21.8,
    });
    app.setSelfPath("navigation.state", "sailing");

    // getWindProtection returns null → no correction
    const getWindProtection = () => null;

    const engine = makeEngine({
      app,
      navState: "sailing",
      getWindProtection,
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
        },
      ],
    });

    engine.runPrediction(makeForecast(25, 15));
    // Under way → stowed regardless of gust, but the recorded gust is raw.
    // Engine stores m/s; 25 kn ≈ 12.86 m/s.
    assert.ok(Math.abs(engine.getMaxForecastGust() - msFromKnots(25)) < 1e-9);
  });
});

test.describe("WPF application: wind generator", () => {
  // Superwind-ish curve: 0 W at 0, ramps with wind
  const CURVE = "5,10,10,50,15,100,20,150,30,200";

  test("corrects wind speed into the curve lookup", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60.1,
      longitude: 21.8,
    });
    app.setSelfPath("navigation.state", "anchored");

    // Forecast wind 18 kn, gusts 22 kn. Halving wind→9 kn, gust→11 kn.
    // 22 kn < max 30 so no stow either way; the curve sees 9 kn instead of 18.
    const getWindProtection = (speed, gust) => ({
      speed: speed * 0.5,
      gust: gust * 0.5,
    });

    const engine = makeEngine({
      app,
      navState: "anchored",
      getWindProtection,
      generators: [
        {
          id: "wind-aft",
          type: "wind",
          deployable: true,
          deployableAtMoored: true,
          manufacturerCurve: CURVE,
          maxWindKnots: 30,
          startupSpeedKnots: 5,
        },
      ],
    });

    engine.runPrediction(makeForecast(22, 18));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "wind-aft");
    // Corrected wind 9 kn ≥ startup 5, gust 11 < max 30 → deploy
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.match(rec.reason, /9kn/);
    // Recorded wind speed reflects correction
    const maxWind = engine.getMaxForecastWind();
    assert.ok(maxWind <= 10, `corrected max wind ${maxWind} should be ~9`);
  });

  test("clears a false-stow when corrected gust drops below max-wind", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60.1,
      longitude: 21.8,
    });
    app.setSelfPath("navigation.state", "anchored");

    // Forecast gust 35 kn ≥ max 30 → stow without WPF. WPF brings gust to 14.
    const getWindProtection = (speed, gust) => ({
      speed: speed * 0.5,
      gust: gust * 0.5,
    });

    const engine = makeEngine({
      app,
      navState: "anchored",
      getWindProtection,
      generators: [
        {
          id: "wind-aft",
          type: "wind",
          deployable: true,
          deployableAtMoored: true,
          manufacturerCurve: CURVE,
          maxWindKnots: 30,
          startupSpeedKnots: 5,
        },
      ],
    });

    engine.runPrediction(makeForecast(35, 20));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "wind-aft");
    assert.strictEqual(rec.recommendedState, "deployed");
    assert.ok(engine.getMaxForecastGust() <= 18, "corrected gust under max");
  });
});

test.describe("WPF application: no wind direction", () => {
  test("passes through when windDirectionDeg is null (no sector to select)", () => {
    const app = makeFakeApp();
    app.setSelfPath("navigation.position", {
      latitude: 60.1,
      longitude: 21.8,
    });
    app.setSelfPath("navigation.state", "anchored");

    let called = false;
    const getWindProtection = () => {
      called = true;
      return { speed: 5, gust: 6 };
    };

    const engine = makeEngine({
      app,
      navState: "anchored",
      getWindProtection,
      solarArrays: [
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 300,
          gustLimitKnots: 20,
        },
      ],
    });

    // Forecast without windDirectionDeg → applyWindProtection returns the
    // raw point unchanged, so getWindProtection is never consulted for it.
    const forecast = makeForecast(10, 8).map((fp) => ({
      ...fp,
      windDirectionDeg: null,
    }));
    engine.runPrediction(forecast);
    // Raw gust 10 < limit 20 → deployed, and recorded gust is raw
    assert.strictEqual(
      engine.getDeploymentRecommendations().find((r) => r.id === "flinsail")
        .recommendedState,
      "deployed",
    );
    assert.ok(Math.abs(engine.getMaxForecastGust() - msFromKnots(10)) < 1e-9);
    assert.strictEqual(called, false);
  });
});
