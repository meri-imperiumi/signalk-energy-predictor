/**
 * Integration smoketests for the WPF sector fallback at the *application*
 * path (work doc #16): `resolveWindProtectionContext` must apply a
 * neighboring-sector fallback to an unlearned sector's forecast, report
 * `speedSource`/`gustSource`, and publish the `speedFactorSource`/
 * `gustFactorSource` Signal K paths.
 *
 * @file wind-protection-fallback-integration.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EventEmitter } = require("node:events");

const makePlugin = require("../plugin/index.js");
const { placeKey, sectorFromDeg } = require("../plugin/wind-protection.js");
const { msFromKnots } = require("../plugin/prediction.js");

class FakeStreamBundle {
  constructor() {
    this.subscriptions = [];
  }
  getdelta(_subscription, _errorHandler, deltaHandler) {
    this.subscriptions.push({ deltaHandler });
    return () => {};
  }
}

class FakeSubscriptionManager {
  subscribe(_s, unsubscribes) {
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
    this.status = [];
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
  setPluginStatus(m) {
    this.status.push(m);
  }
  setProviderStatus(m) {
    this.status.push(m);
  }
  handleMessage() {}
  debug() {}
  error() {}
}

let tempDir = null;
test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wpf-fallback-int-"));
});
test.after(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function baseConfig() {
  return {
    battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
    solarArrays: [],
    mechanicalGenerators: [],
    learning: { enabled: false },
    weather: { openMeteoEnabled: false, useLogbook: false, forecastHours: 24 },
    windProtection: { enabled: true, learnGusts: true },
  };
}

/** Starts the plugin and pins a speed factor for a (place, sector) via learn(). */
async function startAndSeedSpeed(app, { lat, lon, dirDeg, ratio }) {
  const plugin = makePlugin(app);
  // Each test gets its own data dir under the shared tempDir so a previous
  // test's persisted WPF store isn't loaded and doesn't leak learned bins
  // into the next test (the store is saved on plugin.stop()).
  app.dataPath = await mkdtemp(join(tempDir, "t-"));
  await plugin.start(baseConfig(), () => {});
  const { windProtection, resolveWindProtectionContext } =
    plugin.__getInternals();
  windProtection.alpha = 1;
  const key = placeKey(lat, lon, 500);
  const sector = sectorFromDeg(dirDeg);
  windProtection.learn({
    placeKey: key,
    sector,
    night: false,
    measuredSpeed: 10 * ratio,
    forecastSpeed: 10,
    measuredGust: null,
    forecastGust: null,
  });
  return { plugin, windProtection, resolveWindProtectionContext, key };
}

test.describe("WPF fallback application: unlearned sector borrows a neighbor", () => {
  test("applies an adjacent-sector speed fallback for an unlearned sector", async () => {
    const app = new FakeSignalKApp();
    const lat = 60.1;
    const lon = 21.8;
    app.setSelfPath("navigation.position", { latitude: lat, longitude: lon });
    app.setSelfPath("navigation.state", "anchored");

    // Seed sector 3 (SE, 135°) with ratio 0.66. Then query sector 2 (E, 90°),
    // whose only learned neighbor is sector 3 → adjacent-sector fallback.
    const { plugin, resolveWindProtectionContext } = await startAndSeedSpeed(
      app,
      { lat, lon, dirDeg: 135, ratio: 0.66 },
    );

    const ctx = resolveWindProtectionContext(
      10, // forecastSpeedKnots
      null, // forecastGustKnots
      90, // windDirectionDeg → sector 2 (E), unlearned
      Math.PI / 4, // day
    );

    assert.ok(ctx.applies, "fallback should apply for an unlearned sector");
    assert.strictEqual(ctx.sector, 2);
    assert.strictEqual(ctx.speedSource, "adjacent-sector");
    // 0.66 borrowed from sector 3, scaled at 10 m then translated to device
    // height — just assert it's reduced from the raw 10 kn and roughly right.
    assert.ok(ctx.correctedSpeed < 10, `corrected ${ctx.correctedSpeed} < 10`);
    assert.ok(
      ctx.correctedSpeed > 6 && ctx.correctedSpeed < 7,
      `expected ~6.6 kn at device height, got ${ctx.correctedSpeed}`,
    );
    // No gust factor anywhere → gust stays raw
    assert.strictEqual(ctx.gustSource, "none");
    assert.strictEqual(ctx.correctedGust, null);

    await plugin.stop();
  });

  test("reports none and passes through when nothing is learned for the place", async () => {
    const app = new FakeSignalKApp();
    const lat = 60.1;
    const lon = 21.8;
    app.setSelfPath("navigation.position", { latitude: lat, longitude: lon });
    app.setSelfPath("navigation.state", "anchored");

    // Seed sector 3 at a *different* place (far away) so the current place
    // has no learned bins at all.
    const { plugin, resolveWindProtectionContext } = await startAndSeedSpeed(
      app,
      { lat: -18.86, lon: -159.8, dirDeg: 135, ratio: 0.66 },
    );

    const ctx = resolveWindProtectionContext(10, null, 90, Math.PI / 4);
    assert.strictEqual(ctx.applies, false);
    assert.strictEqual(ctx.speedSource, "none");
    assert.strictEqual(ctx.gustSource, "none");
    assert.strictEqual(ctx.correctedSpeed, 10);
    assert.strictEqual(ctx.correctedGust, null);

    await plugin.stop();
  });
});

test.describe("WPF fallback publish: factorSource paths", () => {
  test("publishes speedFactorSource / gustFactorSource for a fallback", async () => {
    const app = new FakeSignalKApp();
    const lat = 60.1;
    const lon = 21.8;
    app.setSelfPath("navigation.position", { latitude: lat, longitude: lon });
    app.setSelfPath("navigation.state", "anchored");

    // Seed a current forecast point so publishWindProtection can find "now".
    const now = new Date();
    // The publisher reads from predictionEngine.lastForecast; seed the
    // engine directly via the internals.
    const { plugin, resolveWindProtectionContext } = await startAndSeedSpeed(
      app,
      { lat, lon, dirDeg: 135, ratio: 0.66 },
    );

    // Give the prediction engine a forecast covering now so the publisher
    // can resolve the current point. We only need wind direction + speed.
    // Seed BOTH stores: lastRawForecast (what publishWindProtection reads)
    // with the raw 10 kn point, and lastForecast (the corrected store) with
    // what the engine would have produced after applying the 0.66 fallback
    // + height translation, so the publish path can't accidentally read the
    // corrected store and double-apply without failing the assertions below.
    const engine = plugin.__getInternals().predictionEngine;
    const rawSpeedMs = msFromKnots(10);
    engine.lastRawForecast = [
      {
        time: now,
        windSpeedMs: rawSpeedMs,
        gustSpeedMs: null,
        windDirectionDeg: 90, // sector 2 (E), unlearned → adjacent fallback
        ghi: 0,
        cloudCover: 0,
      },
    ];
    engine.lastForecast = engine.lastRawForecast.map((p) => ({
      ...p,
      windSpeedMs: rawSpeedMs * 0.66 * 0.9359, // once-corrected stand-in
    }));

    // Capture published deltas via the advisory publisher.
    const pub = plugin.__getInternals().advisoryPublisher;
    let published = null;
    const orig = pub.publishDelta.bind(pub);
    pub.publishDelta = (u) => {
      published = u;
      orig(u);
    };

    // resolveWindProtectionContext for sector 2 must report adjacent-sector.
    const ctx = resolveWindProtectionContext(10, null, 90, Math.PI / 4);
    assert.strictEqual(ctx.speedSource, "adjacent-sector");

    // Call publishWindProtection directly (avoids driving the full weather
    // ingestion cycle, which needs a forecast provider to resolve).
    plugin.__getInternals().publishWindProtection();

    // The published delta carries the fallback source paths.
    assert.ok(published, "a windProtection delta was published");
    const base = "electrical.energy.prediction.windProtection";
    assert.ok(
      `${base}.speedFactorSource` in published,
      "speedFactorSource path published",
    );
    assert.strictEqual(
      published[`${base}.speedFactorSource`],
      "adjacent-sector",
    );
    assert.ok(
      `${base}.gustFactorSource` in published,
      "gustFactorSource path published",
    );
    assert.strictEqual(published[`${base}.gustFactorSource`], "none");
    // forecastSpeed is the RAW forecast; correctedSpeed applies the 0.66
    // fallback factor and the 10 m → 5 m height translation exactly ONCE
    // (10 kn × 0.66 × 0.9359 ≈ 6.18 kn ≈ 3.18 m/s). A double application
    // (reading the corrected store) would land near 1.96 m/s.
    assert.ok(
      Math.abs(published[`${base}.forecastSpeed`] - rawSpeedMs) < 1e-9,
      `forecastSpeed should be the raw ${rawSpeedMs.toFixed(3)} m/s, got ${published[`${base}.forecastSpeed`]}`,
    );
    const expectedCorrected = rawSpeedMs * 0.66 * 0.9359;
    assert.ok(
      Math.abs(published[`${base}.correctedSpeed`] - expectedCorrected) < 0.02,
      `correctedSpeed should be ~${expectedCorrected.toFixed(3)} m/s (single application), got ${published[`${base}.correctedSpeed`]}`,
    );

    await plugin.stop();
  });
});

test.describe("WPF identity passthrough: no learned data at all", () => {
  test("corrected wind deltas publish the raw forecast when nothing is learned", async () => {
    const app = new FakeSignalKApp();
    const lat = 60.1;
    const lon = 21.8;
    app.setSelfPath("navigation.position", { latitude: lat, longitude: lon });
    app.setSelfPath("navigation.state", "anchored");

    // Start with WPF enabled but NOTHING learned (fresh store).
    const plugin = makePlugin(app);
    app.dataPath = await mkdtemp(join(tempDir, "t-"));
    await plugin.start(baseConfig(), () => {});

    // Seed the engine's forecast stores with a current point in m/s (the
    // engine's canonical unit). Nothing is learned, so raw == corrected.
    const now = new Date();
    const engine = plugin.__getInternals().predictionEngine;
    const rawPoint = {
      time: now,
      windSpeedMs: msFromKnots(10),
      gustSpeedMs: msFromKnots(18),
      windDirectionDeg: 90,
      ghi: 0,
      cloudCover: 0,
    };
    engine.lastRawForecast = [rawPoint];
    engine.lastForecast = [rawPoint];

    const pub = plugin.__getInternals().advisoryPublisher;
    let published = null;
    const orig = pub.publishDelta.bind(pub);
    pub.publishDelta = (u) => {
      published = u;
      orig(u);
    };

    plugin.__getInternals().publishWindProtection();

    const base = "electrical.energy.prediction.windProtection";
    assert.ok(published, "a windProtection delta was published");
    assert.strictEqual(published[`${base}.enabled`], true);
    assert.strictEqual(published[`${base}.speedFactorSource`], "none");
    assert.strictEqual(published[`${base}.gustFactorSource`], "none");
    // Identity passthrough: the corrected paths carry the raw forecast
    // (m/s) so at-sea consumers still see wind on these paths.
    assert.ok(
      Math.abs(published[`${base}.forecastSpeed`] - msFromKnots(10)) < 1e-9,
    );
    assert.ok(
      Math.abs(published[`${base}.correctedSpeed`] - msFromKnots(10)) < 1e-9,
      `correctedSpeed should equal the raw forecast in m/s, got ${published[`${base}.correctedSpeed`]}`,
    );
    assert.ok(
      Math.abs(published[`${base}.correctedGust`] - msFromKnots(18)) < 1e-9,
      `correctedGust should equal the raw forecast in m/s, got ${published[`${base}.correctedGust`]}`,
    );

    await plugin.stop();
  });
});

test.describe("WPF corrected paths without forecast wind (tiers 3/4)", () => {
  const base = "electrical.energy.prediction.windProtection";

  async function startWithWindlessForecast(app) {
    const plugin = makePlugin(app);
    app.dataPath = await mkdtemp(join(tempDir, "t-"));
    await plugin.start(baseConfig(), () => {});
    // Tier-3/4 style current hour: solar geometry only, no wind at all.
    const engine = plugin.__getInternals().predictionEngine;
    engine.lastRawForecast = [
      {
        time: new Date(),
        windSpeedMs: null,
        gustSpeedMs: null,
        windDirectionDeg: null,
        ghi: 400,
        cloudCover: 0.5,
      },
    ];
    engine.lastForecast = engine.lastRawForecast;

    const pub = plugin.__getInternals().advisoryPublisher;
    let published = null;
    const orig = pub.publishDelta.bind(pub);
    pub.publishDelta = (u) => {
      published = u;
      orig(u);
    };
    plugin.__getInternals().publishWindProtection();
    assert.ok(published, "a windProtection delta was published");
    return { plugin, published };
  }

  test("at anchor: corrected deltas carry the measured wind, forecast paths stay null", async () => {
    const app = new FakeSignalKApp();
    app.setSelfPath("navigation.position", {
      latitude: 60.1,
      longitude: 21.8,
    });
    app.setSelfPath("navigation.state", "anchored");
    // Measured wind: 6 m/s from the east (π/2 rad). No gust history →
    // no gust estimate (currentWindGustMs needs ≥2 samples).
    app.setSelfPath("environment.wind.speedTrue", 6);
    app.setSelfPath("environment.wind.directionTrue", Math.PI / 2);

    const { plugin, published } = await startWithWindlessForecast(app);

    // Honest provenance: the tier carries no wind, so the forecast paths
    // must not fabricate one.
    assert.strictEqual(published[`${base}.forecastSpeed`], null);
    assert.strictEqual(published[`${base}.forecastGust`], null);
    // The corrected paths nowcast from the measured wind. Nothing is
    // learned here, so the WPF is identity: corrected == measured.
    assert.strictEqual(
      published[`${base}.correctedSpeed`],
      6,
      `correctedSpeed should carry the measured 6 m/s, got ${published[`${base}.correctedSpeed`]}`,
    );
    assert.strictEqual(published[`${base}.correctedGust`], null);
    // Place resolved (at rest): factor fields publish with honest sources.
    assert.ok(published[`${base}.placeKey`] != null);
    assert.strictEqual(published[`${base}.speedFactorSource`], "none");

    await plugin.stop();
  });

  test("under way (offshore passage case): measured nowcast still publishes", async () => {
    const app = new FakeSignalKApp();
    app.setSelfPath("navigation.position", {
      latitude: -19.19,
      longitude: -169.77,
    });
    app.setSelfPath("navigation.state", "sailing");
    app.setSelfPath("environment.wind.speedTrue", 7.5);
    app.setSelfPath("environment.wind.directionTrue", Math.PI);

    const { plugin, published } = await startWithWindlessForecast(app);

    // Under way the WPF is identity and the place fields stay cleared —
    // but the corrected paths must still carry the measured nowcast
    // (during a forecast-degraded passage these used to go null).
    assert.strictEqual(published[`${base}.placeKey`], null);
    assert.strictEqual(published[`${base}.speedFactor`], null);
    assert.strictEqual(
      published[`${base}.correctedSpeed`],
      7.5,
      `correctedSpeed should carry the measured 7.5 m/s, got ${published[`${base}.correctedSpeed`]}`,
    );
    assert.strictEqual(published[`${base}.correctedGust`], null);

    await plugin.stop();
  });

  test("no wind anywhere: corrected paths stay null, not calm", async () => {
    const app = new FakeSignalKApp();
    app.setSelfPath("navigation.position", {
      latitude: 60.1,
      longitude: 21.8,
    });
    app.setSelfPath("navigation.state", "anchored");
    // No forecast wind, no instruments: nothing to publish

    const { plugin, published } = await startWithWindlessForecast(app);

    assert.strictEqual(published[`${base}.correctedSpeed`], null);
    assert.strictEqual(published[`${base}.correctedGust`], null);
    assert.strictEqual(published[`${base}.forecastSpeed`], null);

    await plugin.stop();
  });
});

test.describe("WPF fallback non-cascading at the application path", () => {
  test("sector 3 does not inherit sector 2's borrowed value (falls to place average)", async () => {
    const app = new FakeSignalKApp();
    const lat = 60.1;
    const lon = 21.8;
    app.setSelfPath("navigation.position", { latitude: lat, longitude: lon });
    app.setSelfPath("navigation.state", "anchored");

    // Only sector 3 (SE, 135°) is learned. Sector 2 (E) borrows it
    // (adjacent). Sector 1 (NE) — sector 2's *other* neighbor — is
    // unlearned, so it must NOT borrow sector 2's borrowed value; with its
    // other neighbor sector 0 (N) also unlearned, it falls to place average
    // (the mean of all learned = sector 3 alone = 0.66).
    const { plugin, resolveWindProtectionContext } = await startAndSeedSpeed(
      app,
      { lat, lon, dirDeg: 135, ratio: 0.66 },
    );

    const ctx2 = resolveWindProtectionContext(10, null, 90, Math.PI / 4);
    assert.strictEqual(ctx2.sector, 2);
    assert.strictEqual(ctx2.speedSource, "adjacent-sector");

    const ctx1 = resolveWindProtectionContext(10, null, 45, Math.PI / 4);
    assert.strictEqual(ctx1.sector, 1);
    // Sector 1's neighbors: 0 (N, unlearned) and 2 (E, a fallback → NOT a
    // donor). So adjacent resolves to nothing → place average.
    assert.strictEqual(ctx1.speedSource, "place-average");
    assert.ok(ctx1.applies, "place-average fallback still applies");
    assert.ok(
      Math.abs(ctx1.speedFactor - 0.66) < 1e-9,
      `place average = sector 3's value, got ${ctx1.speedFactor}`,
    );

    await plugin.stop();
  });
});

test.describe("WPF fallback end-to-end: hourly forecast reflects the fallback", () => {
  test("an unlearned-sector hour's published windSpeedKnots carries the fallback factor", async () => {
    const app = new FakeSignalKApp();
    const lat = 60.1;
    const lon = 21.8;
    app.setSelfPath("navigation.position", { latitude: lat, longitude: lon });
    app.setSelfPath("navigation.state", "anchored");

    // Seed sector 3 (SE, 135°) at this place with ratio 0.5. Then forecast
    // from sector 2 (E, 90°), which is unlearned and borrows sector 3 → the
    // hourly wind for those hours must be the fallback-corrected value.
    const { plugin, windProtection } = await startAndSeedSpeed(app, {
      lat,
      lon,
      dirDeg: 135,
      ratio: 0.5,
    });
    windProtection.alpha = 1; // (re-applied; startAndSeedSpeed already set)

    const engine = plugin.__getInternals().predictionEngine;
    const now = new Date();
    const forecast = Array.from({ length: 24 }, (_, h) => ({
      time: new Date(now.getTime() + h * 3600000),
      ghi: 0, // night-equivalent; we only care about wind here
      cloudCover: 0,
      windSpeedMs: msFromKnots(10),
      gustSpeedMs: null,
      windDirectionDeg: 90, // sector 2 (E), unlearned → adjacent fallback from sector 3
    }));
    engine.runPrediction(forecast);

    const hourly = engine.getHourlyForecast();
    assert.ok(hourly.length > 0, "hourly forecast produced");

    // Every hour is sector 2 (unlearned). The published windSpeedKnots is
    // the WPF-corrected (fallback) value; forecastWindSpeedKnots is the raw.
    // 10 kn × 0.5 (sector-3 fallback) scaled at 10 m then translated to
    // device height → somewhat below 5 kn. Assert it's reduced from raw 10
    // and well below it, and that the raw is preserved at 10.
    const sample = hourly[0];
    assert.ok(
      sample.windSpeedKnots != null,
      "hourly windSpeedKnots is populated",
    );
    assert.ok(
      sample.windSpeedKnots < 10,
      `fallback-corrected wind ${sample.windSpeedKnots} should be < raw 10`,
    );
    assert.ok(
      sample.windSpeedKnots > 4 && sample.windSpeedKnots < 6,
      `expected ~5 kn at device height (10×0.5 translated down), got ${sample.windSpeedKnots}`,
    );
    assert.strictEqual(sample.forecastWindSpeedKnots, 10);

    // The source is also reported on the windProtection publish path.
    // (resolveWindProtectionContext is the single source of truth for the
    // source; assert it agrees with the fallback that drove the hour.)
    const { resolveWindProtectionContext } = plugin.__getInternals();
    const ctx = resolveWindProtectionContext(10, null, 90, Math.PI / 4);
    assert.strictEqual(ctx.speedSource, "adjacent-sector");
    assert.strictEqual(ctx.speedFactor, 0.5);

    await plugin.stop();
  });
});

test.describe("Bad-cycle protection: degenerate forecast keeps last good cycle", () => {
  test("runPredictionCycle skips an all-zero forecast and preserves state", async () => {
    const app = new FakeSignalKApp();
    app.setSelfPath("navigation.position", {
      latitude: 60.1,
      longitude: 21.8,
    });
    app.setSelfPath("navigation.state", "anchored");

    const plugin = makePlugin(app);
    app.dataPath = await mkdtemp(join(tempDir, "t-"));
    await plugin.start(baseConfig(), () => {});
    const internals = plugin.__getInternals();

    // Seed a good previous cycle on the engine, with a marker time a real
    // run would never reproduce.
    const marker = new Date("2027-01-01T00:00:00Z");
    internals.predictionEngine.lastRawForecast = [
      {
        time: marker,
        ghi: 500,
        windSpeedMs: 3,
        gustSpeedMs: 4,
        windDirectionDeg: 90,
        cloudCover: 0,
      },
    ];
    internals.predictionEngine.lastPrediction = [
      {
        hour: 0,
        time: marker,
        idealSolarYieldWh: 100,
        idealWindYieldWh: 0,
        idealHydroYieldWh: 0,
        houseLoadWh: 50,
        idealNetWh: 50,
        idealSoC: 0.9,
        detectedYieldWh: 0,
        detectedNetWh: 0,
        detectedSoC: 0.9,
        gustSpeedMs: 4,
        windSpeedMs: 3,
        forecastWindSpeedMs: 3,
        forecastGustMs: 4,
        windDirectionDeg: 90,
        actions: [],
      },
    ];

    // Force the ingestion seam to hand the cycle a degenerate forecast
    // (the ingestion-layer guards normally prevent this from ever
    // happening; this tests the cycle-level safety net itself).
    const fsm = internals.ingestionFSM;
    fsm.position = { latitude: 60.1, longitude: 21.8 };
    const origGetForecast = fsm.getForecast.bind(fsm);
    fsm.getForecast = async () => [
      {
        time: new Date(),
        ghi: 0,
        cloudCover: null,
        windSpeedMs: 0,
        gustSpeedMs: 0,
        windDirectionDeg: 0,
      },
    ];

    let published = false;
    const pub = internals.advisoryPublisher;
    const origPublishAll = pub.publishAll.bind(pub);
    pub.publishAll = (...args) => {
      published = true;
      return origPublishAll(...args);
    };

    try {
      await internals.runPredictionCycle();
      assert.strictEqual(
        published,
        false,
        "no advisories published from a degenerate cycle",
      );
      assert.strictEqual(
        internals.predictionEngine.lastRawForecast[0].time,
        marker,
        "engine keeps the last good raw forecast (wind-protection values stay good)",
      );
      assert.strictEqual(
        internals.predictionEngine.lastPrediction[0].time,
        marker,
        "engine keeps the last good prediction",
      );
    } finally {
      fsm.getForecast = origGetForecast;
      await plugin.stop();
    }
  });
});
