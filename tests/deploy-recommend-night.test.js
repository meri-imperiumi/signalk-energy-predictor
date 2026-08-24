/**
 * Tests that the live FLINsail `recommendedState` reflects the *current
 * night's* worst gust (stow before dark if any hour of tonight breaches the
 * gust limit), while a gust in a *later* night — after a full day — does
 * NOT drive a "stow now".
 *
 * Background: `getDeploymentRecommendations` sizes its
 * `computeDeployableSolarStates` window to cover the rest of the current
 * night block (until next sunrise) when the current hour is night, so the
 * night-block max aggregates tonight's upcoming gusts. A daytime current
 * hour uses a single-hour window (night-block logic only applies to night
 * hours). See prediction.js `getDeploymentRecommendations`.
 *
 * @file deploy-recommend-night.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PredictionEngine, msFromKnots } = require("../plugin/prediction.js");
const { sunPosition } = require("../plugin/solar.js");

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
    handleMessage() {},
  };
}

/**
 * Longitude that puts the sun near local midnight (below horizon) or local
 * noon (above horizon) at the equator, regardless of when the test runs.
 */
function midnightLongitude() {
  const now = new Date();
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  return (0 - utcHours) * 15;
}
function noonLongitude() {
  const now = new Date();
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
  return (12 - utcHours) * 15;
}

/** Builds a 24h forecast where gust varies per hour. */
function forecastWithHourlyGusts(gustByHour) {
  const now = new Date();
  // Test authors pass knot magnitudes; the engine works in m/s.
  return Array.from({ length: 24 }, (_, h) => ({
    time: new Date(now.getTime() + h * 3600000),
    ghi: 500,
    cloudCover: 0.3,
    gustSpeedMs: msFromKnots(gustByHour(h)),
    windSpeedMs: msFromKnots(10),
  }));
}

function makeEngine({ navState, latitude, longitude }) {
  const app = makeFakeApp();
  app.setSelfPath("navigation.state", navState);
  app.setSelfPath("navigation.position", { latitude, longitude });
  return new PredictionEngine({
    battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
    solarArrays: [
      {
        id: "flinsail",
        type: "deployable",
        capacityWp: 300,
        gustLimitKnots: 20,
      },
    ],
    mechanicalGenerators: [],
    getEfficiency: () => 0.7,
    getSelfPath: (path) => app.getSelfPath(path),
    app,
  });
}

test.describe("FLINsail recommendedState: current-night gust verdict", () => {
  test("night: stows now when a later hour TONIGHT breaches the gust limit", () => {
    const longitude = midnightLongitude();
    const latitude = 0;
    // Sanity: the current hour really is night at this position
    const sun = sunPosition(new Date(), latitude, longitude);
    assert.ok(sun.altitude <= 0, "current hour must be night for this test");

    const engine = makeEngine({ navState: "anchored", latitude, longitude });
    // Calm now (11 kn) but a gust later tonight hits 23 kn (>= limit 20)
    engine.runPrediction(forecastWithHourlyGusts((h) => (h === 5 ? 23 : 11)));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "flinsail");

    assert.strictEqual(
      rec.recommendedState,
      "stowed",
      "tonight's 23kn gust must drive a stow recommendation even though it's calm now",
    );
    assert.match(rec.reason, /23/);
    assert.match(rec.reason, /20/);
  });

  test("night: stays deployed when tonight's gusts stay below the limit", () => {
    const longitude = midnightLongitude();
    const latitude = 0;
    const engine = makeEngine({ navState: "anchored", latitude, longitude });
    // All of tonight stays at 11 kn (< limit 20)
    engine.runPrediction(forecastWithHourlyGusts(() => 11));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "flinsail");

    assert.strictEqual(
      rec.recommendedState,
      "deployed",
      "calm tonight should not force a stow",
    );
  });

  test("night: a gust in a LATER night (after a full day) does NOT force stow now", () => {
    const longitude = midnightLongitude();
    const latitude = 0;
    const engine = makeEngine({ navState: "anchored", latitude, longitude });
    // Calm tonight (11 kn); a 25 kn gust appears 20h from now, which is in
    // a later night block (after tomorrow's day), not the current night.
    engine.runPrediction(forecastWithHourlyGusts((h) => (h === 20 ? 25 : 11)));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "flinsail");

    assert.strictEqual(
      rec.recommendedState,
      "deployed",
      "a gust in a later night must not drive a 'stow now'",
    );
  });

  test("daytime: a gust later today (not tonight) does not stow now", () => {
    const longitude = noonLongitude();
    const latitude = 0;
    const sun = sunPosition(new Date(), latitude, longitude);
    assert.ok(sun.altitude > 0, "current hour must be day for this test");

    const engine = makeEngine({ navState: "anchored", latitude, longitude });
    // Calm now; a 25 kn gust 5h from now (still daytime-ish). The current
    // hour is day so the window is 1 hour: that future daytime gust must
    // not force a stow now (it shows up via recommendedStateTime instead).
    engine.runPrediction(forecastWithHourlyGusts((h) => (h === 5 ? 25 : 11)));
    const rec = engine
      .getDeploymentRecommendations()
      .find((r) => r.id === "flinsail");

    assert.strictEqual(
      rec.recommendedState,
      "deployed",
      "a future daytime gust must not force a 'stow now'",
    );
  });
});
