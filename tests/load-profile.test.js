/**
 * Tests for the load profile with sun-phase bins.
 *
 * @file load-profile.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LoadProfile,
  SunPhase,
  StateClass,
} = require("../plugin/prediction.js");

test.describe("LoadProfile", () => {
  let loadProfile;

  test.beforeEach(() => {
    loadProfile = new LoadProfile({
      config: {
        enabled: true,
        alpha: 0.05,
        minDaysPerBin: 3,
        outlierFactor: 3,
      },
      getSelfPath: () => null,
      app: {
        debug: () => {},
        error: () => {},
      },
    });
  });

  test("initializes with 8 bins (2 state classes × 4 sun phases)", () => {
    assert.strictEqual(loadProfile.bins.size, 0);
  });

  test("classifies sun phases based on sun position", () => {
    const SunCalc = require("suncalc");
    const testDate = new Date("2024-06-21T12:00:00Z");
    const sunPos = { latitude: 37.77, longitude: -122.42 };

    // Get actual astronomical times for the test date/location
    const times = SunCalc.getTimes(testDate, sunPos.latitude, sunPos.longitude);
    const sunrise = new Date(times.sunrise);
    const sunset = new Date(times.sunset);

    // Dawn is 2h before sunrise
    const dawn = new Date(sunrise.getTime() - 3600000);
    assert.strictEqual(loadProfile.getSunPhase(dawn, sunPos), SunPhase.DAWN);

    // Just before sunrise is still dawn
    const beforeSunrise = new Date(sunrise.getTime() - 1000);
    assert.strictEqual(loadProfile.getSunPhase(beforeSunrise, sunPos), SunPhase.DAWN);

    // At sunrise is day
    assert.strictEqual(loadProfile.getSunPhase(sunrise, sunPos), SunPhase.DAY);

    // Mid-day is day
    const noon = new Date((sunrise.getTime() + sunset.getTime()) / 2);
    assert.strictEqual(loadProfile.getSunPhase(noon, sunPos), SunPhase.DAY);

    // Just before sunset is still day
    const beforeSunset = new Date(sunset.getTime() - 1000);
    assert.strictEqual(loadProfile.getSunPhase(beforeSunset, sunPos), SunPhase.DAY);

    // At sunset is dusk (boundary starts at sunset)
    assert.strictEqual(loadProfile.getSunPhase(sunset, sunPos), SunPhase.DUSK);

    // Dusk is sunset to sunset + 2h
    const dusk = new Date(sunset.getTime() + 3600000);
    assert.strictEqual(loadProfile.getSunPhase(dusk, sunPos), SunPhase.DUSK);

    // Night is after dusk (2h after sunset)
    const night = new Date(sunset.getTime() + 3 * 3600000);
    assert.strictEqual(loadProfile.getSunPhase(night, sunPos), SunPhase.NIGHT);

    // Night before dawn
    const beforeDawn = new Date(sunrise.getTime() - 3 * 3600000);
    assert.strictEqual(
      loadProfile.getSunPhase(beforeDawn, sunPos),
      SunPhase.NIGHT,
    );
  });

  test("classifies state class from navigation state", () => {
    // Test underway states
    const underwayStates = ["sailing", "motoring", "under way"];
    for (const state of underwayStates) {
      const lp = new LoadProfile({
        config: { enabled: true },
        getSelfPath: (path) =>
          path === "navigation.state" ? state : null,
        app: { debug: () => {}, error: () => {} },
      });
      assert.strictEqual(
        lp.getStateClass(),
        StateClass.UNDERWAY,
        `state: ${state}`,
      );
    }

    // Test at-rest states
    const restStates = ["anchored", "moored"];
    for (const state of restStates) {
      const lp = new LoadProfile({
        config: { enabled: true },
        getSelfPath: (path) =>
          path === "navigation.state" ? state : null,
        app: { debug: () => {}, error: () => {} },
      });
      assert.strictEqual(
        lp.getStateClass(),
        StateClass.AT_REST,
        `state: ${state}`,
      );
    }

    // Test unknown/null state defaults to at-rest
    const lp = new LoadProfile({
      config: { enabled: true },
      getSelfPath: () => null,
      app: { debug: () => {}, error: () => {} },
    });
    assert.strictEqual(lp.getStateClass(), StateClass.AT_REST);
  });

  test("returns default DAY phase when no position available", () => {
    assert.strictEqual(loadProfile.getSunPhase(new Date(), null), SunPhase.DAY);
    assert.strictEqual(
      loadProfile.getSunPhase(new Date(), { latitude: null, longitude: null }),
      SunPhase.DAY,
    );
  });

  test("generates bin keys correctly", () => {
    assert.strictEqual(
      loadProfile.getBinKey(StateClass.AT_REST, SunPhase.NIGHT),
      "at-rest:night",
    );
    assert.strictEqual(
      loadProfile.getBinKey(StateClass.UNDERWAY, SunPhase.DAY),
      "underway:day",
    );
  });

  test("gates samples when shore power connected", () => {
    const lp = new LoadProfile({
      config: { enabled: true },
      getSelfPath: (path) =>
        path === "electrical.shore.power.connected" ? true : null,
      app: { debug: () => {}, error: () => {} },
    });

    const gate = lp.shouldGate(100, 50, "at-rest:day");
    assert.strictEqual(gate, "shore-power");
  });

  test("gates samples when engine is running", () => {
    const lp = new LoadProfile({
      config: { enabled: true },
      getSelfPath: (path) =>
        path === "propulsion.main.state" ? "started" : null,
      app: { debug: () => {}, error: () => {} },
    });

    const gate = lp.shouldGate(100, 50, "at-rest:day");
    assert.strictEqual(gate, "engine-running");
  });

  test("gates spike outliers", () => {
    // First sample establishes EMA
    loadProfile.addSample(100, 50, { latitude: 37.77, longitude: -122.42 });
    loadProfile.samples = []; // Clear rolling average so EMA is used

    // Initialize the bin directly (simulating first sample)
    const binKey = loadProfile.getBinKey(
      loadProfile.getStateClass(),
      loadProfile.getSunPhase(new Date(), {
        latitude: 37.77,
        longitude: -122.42,
      }),
    );
    loadProfile.bins.set(binKey, { dcEma: 100, acEma: 50 });

    // Spike sample (4× current EMA)
    const gate = loadProfile.shouldGate(400, 200, binKey);
    assert.strictEqual(gate, "spike-outlier");
  });

  test("does not gate normal samples", () => {
    const gate = loadProfile.shouldGate(100, 50, "at-rest:day");
    assert.strictEqual(gate, null);
  });

  test("returns rolling average fallback when bin not ready", () => {
    const lp = new LoadProfile({
      config: { enabled: true, minDaysPerBin: 3 },
      getSelfPath: () => null,
      app: { debug: () => {}, error: () => {} },
    });

    // Add some samples for rolling average
    lp.addSample(100, 50, { latitude: 37.77, longitude: -122.42 });
    lp.addSample(110, 55, { latitude: 37.77, longitude: -122.42 });

    const load = lp.getLoad(SunPhase.DAY, StateClass.AT_REST);
    assert.strictEqual(load, null); // Bin not learned yet
  });

  test("returns rolling average values", () => {
    loadProfile.addSample(100, 50, { latitude: 37.77, longitude: -122.42 });
    loadProfile.addSample(110, 55, { latitude: 37.77, longitude: -122.42 });

    const load = loadProfile.getAverageLoad();
    assert.strictEqual(load.dcWh, 105);
    assert.strictEqual(load.acWh, 52.5);
  });

  test("returns zero when no samples", () => {
    const load = loadProfile.getAverageLoad();
    assert.strictEqual(load.dcWh, 0);
    assert.strictEqual(load.acWh, 0);
  });

  test("does not sample when disabled", () => {
    const lp = new LoadProfile({
      config: { enabled: false },
      getSelfPath: () => null,
      app: { debug: () => {}, error: () => {} },
    });

    lp.addSample(100, 50, { latitude: 37.77, longitude: -122.42 });
    assert.strictEqual(lp.bins.size, 0);
  });

  test("serializes and deserializes", () => {
    loadProfile.bins.set("at-rest:night", { dcEma: 120, acEma: 40 });
    loadProfile.bins.set("underway:day", { dcEma: 200, acEma: 80 });
    loadProfile.samplesPerBin.set("at-rest:night:2024-08-21", true);

    const json = loadProfile.toJSON();

    const lp2 = new LoadProfile({
      config: { enabled: true },
      getSelfPath: () => null,
      app: { debug: () => {}, error: () => {} },
    });
    lp2.fromJSON(json);

    assert.strictEqual(lp2.bins.size, 2);
    assert.strictEqual(lp2.bins.get("at-rest:night").dcEma, 120);
    assert.strictEqual(lp2.bins.get("underway:day").acEma, 80);
    assert(lp2.samplesPerBin.has("at-rest:night:2024-08-21"));
  });

  test("tracks sample days per bin", () => {
    loadProfile.trackSampleDay("at-rest:day");
    loadProfile.trackSampleDay("at-rest:day"); // Same day, no duplicate

    assert.strictEqual(loadProfile.getSampleDays("at-rest:day"), 1);

    // Add historical samples by directly setting samplesPerBin
    loadProfile.samplesPerBin.set("at-rest:day:2024-08-22", true);
    loadProfile.samplesPerBin.set("at-rest:day:2024-08-23", true);

    assert.strictEqual(loadProfile.getSampleDays("at-rest:day"), 3);
  });

  test("returns null for bin with insufficient samples", () => {
    // Initialize a bin with only 2 days of samples
    loadProfile.bins.set("at-rest:day", { dcEma: 100, acEma: 50 });
    loadProfile.samplesPerBin.set("at-rest:day:2024-08-20", true);
    loadProfile.samplesPerBin.set("at-rest:day:2024-08-21", true);

    const load = loadProfile.getLoad(SunPhase.DAY, StateClass.AT_REST);
    assert.strictEqual(load, null); // Only 2 days, need 3
  });

  test("returns learned bin when sufficient samples", () => {
    // Initialize a bin with 3 days of samples
    loadProfile.bins.set("at-rest:day", { dcEma: 100, acEma: 50 });
    loadProfile.samplesPerBin.set("at-rest:day:2024-08-20", true);
    loadProfile.samplesPerBin.set("at-rest:day:2024-08-21", true);
    loadProfile.samplesPerBin.set("at-rest:day:2024-08-22", true);

    const load = loadProfile.getLoad(SunPhase.DAY, StateClass.AT_REST);
    assert.deepStrictEqual(load, { dcWh: 100, acWh: 50 });
  });

  test("applies EMA to samples", () => {
    loadProfile.addSample(100, 50, { latitude: 37.77, longitude: -122.42 });
    loadProfile.samples = []; // Clear rolling average

    // Get the bin that was created
    const binKey = Array.from(loadProfile.bins.keys())[0];
    const bin = loadProfile.bins.get(binKey);

    // First sample should set EMA directly
    assert.strictEqual(bin.dcEma, 100);
    assert.strictEqual(bin.acEma, 50);

    // Second sample should apply EMA
    loadProfile.addSample(120, 60, { latitude: 37.77, longitude: -122.42 });

    // With alpha=0.05: new = alpha*new + (1-alpha)*old
    // dc: 0.05*120 + 0.95*100 = 6 + 95 = 101
    // ac: 0.05*60 + 0.95*50 = 3 + 47.5 = 50.5
    assert.strictEqual(Math.round(bin.dcEma), 101);
    assert.strictEqual(Math.round(bin.acEma), 51);
  });

  test("tracks AC and DC separately in rolling average", () => {
    loadProfile.addSample(100, 50, { latitude: 37.77, longitude: -122.42 });
    loadProfile.addSample(120, 30, { latitude: 37.77, longitude: -122.42 });

    const load = loadProfile.getAverageLoad();
    assert.strictEqual(load.dcWh, 110);
    assert.strictEqual(load.acWh, 40);
  });

  test("respects config values", () => {
    const lp = new LoadProfile({
      config: {
        enabled: false,
        alpha: 0.1,
        minDaysPerBin: 5,
        outlierFactor: 4,
      },
      getSelfPath: () => null,
      app: { debug: () => {}, error: () => {} },
    });

    assert.strictEqual(lp.enabled, false);
    assert.strictEqual(lp.alpha, 0.1);
    assert.strictEqual(lp.minDaysPerBin, 5);
    assert.strictEqual(lp.outlierFactor, 4);
  });

  test("uses default config values", () => {
    const lp = new LoadProfile({
      getSelfPath: () => null,
      app: { debug: () => {}, error: () => {} },
    });

    assert.strictEqual(lp.enabled, true);
    assert.strictEqual(lp.alpha, 0.05);
    assert.strictEqual(lp.minDaysPerBin, 3);
    assert.strictEqual(lp.outlierFactor, 3);
  });
});
