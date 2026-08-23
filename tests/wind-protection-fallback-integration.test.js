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
    const engine = plugin.__getInternals().predictionEngine;
    engine.lastForecast = [
      {
        time: now,
        windSpeedKnots: 10,
        gustSpeedKnots: null,
        windDirectionDeg: 90, // sector 2 (E), unlearned → adjacent fallback
        ghi: 0,
        cloudCover: 0,
      },
    ];

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
