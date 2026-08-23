/**
 * Tests that the Wind Protection Factor correction never lets the
 * corrected gust fall below the corrected base wind speed.
 *
 * A gust is, by definition, a wind speed peak above the mean. After WPF
 * scaling (and height translation) the corrected gust can drop below the
 * corrected speed — e.g. when the learned gust factor is small but the
 * speed factor is large, or just from forecast rounding. The correction
 * path must floor the gust at the speed so the prediction gates and
 * published Signal K values stay physically sensible.
 *
 * @file wind-protection-gust-floor.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EventEmitter } = require("node:events");

const makePlugin = require("../plugin/index.js");
const { placeKey, sectorFromDeg } = require("../plugin/wind-protection.js");

// --- Fakes (minimal subset, same shape as plugin.test.js) -------------

class FakeStreamBundle {
  constructor() {
    this.subscriptions = [];
  }
  getdelta(subscription, errorHandler, deltaHandler) {
    this.subscriptions.push({ subscription, deltaHandler });
    return () => {
      const idx = this.subscriptions.findIndex(
        (s) => s.deltaHandler === deltaHandler,
      );
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }
}

class FakeSubscriptionManager {
  subscribe(subscription, unsubscribes, errorHandler, deltaHandler) {
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
  setPluginStatus(message) {
    this.setPluginStatusCalls.push(message);
  }
  setProviderStatus(message) {
    this.setPluginStatusCalls.push(message);
  }
  handleMessage() {}
  debug() {}
  error() {}
}

let tempDir = null;

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "wpf-gust-floor-"));
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

/**
 * Starts the plugin with WPF enabled and seeds the WindProtectionStore so
 * that the speed factor is large (1.5) and the gust factor is small (0.5)
 * for the given place + wind direction sector, in both day and night bins.
 *
 * With forecast speed 10 kn and gust 12 kn, the raw scaling would give
 * correctedSpeed = 15 kn and correctedGust = 6 kn — i.e. gust < speed,
 * which is physically impossible. The floor must bring the gust up to 15.
 */
async function startAndSeed(app, { lat, lon, dirDeg }) {
  const plugin = makePlugin(app);
  app.dataPath = tempDir;
  await plugin.start(baseConfig(), () => {});

  const { windProtection, resolveWindProtectionContext } =
    plugin.__getInternals();
  assert.ok(windProtection, "windProtection store should be initialized");

  // Use alpha = 1 so a single learn() pins the factor to the observed ratio.
  windProtection.alpha = 1;

  const key = placeKey(lat, lon, 500);
  const sector = sectorFromDeg(dirDeg);
  // Seed a speed factor of 1.5 (measured 15 / forecast 10)
  windProtection.learn({
    placeKey: key,
    sector,
    night: false,
    measuredSpeed: 15,
    forecastSpeed: 10,
    measuredGust: 6,
    forecastGust: 12,
  });
  // Seed the night bin too so the test is robust to the day/night bin.
  windProtection.learn({
    placeKey: key,
    sector,
    night: true,
    measuredSpeed: 15,
    forecastSpeed: 10,
    measuredGust: 6,
    forecastGust: 12,
  });

  return { plugin, resolveWindProtectionContext };
}

test.describe("WPF gust floor: corrected gust never below corrected speed", () => {
  test("floors corrected gust at corrected speed when factors invert them", async () => {
    const app = new FakeSignalKApp();
    const lat = 60.1;
    const lon = 21.8;
    const dirDeg = 180; // from S → sector 4

    app.setSelfPath("navigation.position", { latitude: lat, longitude: lon });
    app.setSelfPath("navigation.state", "anchored");

    const { plugin, resolveWindProtectionContext } = await startAndSeed(app, {
      lat,
      lon,
      dirDeg,
    });

    // Daytime sun elevation (positive → night=false). Both bins are seeded.
    const ctx = resolveWindProtectionContext(
      10, // forecastSpeedKnots
      12, // forecastGustKnots
      dirDeg,
      Math.PI / 4, // sun elevation: clearly above horizon
    );

    assert.ok(ctx.applies, "WPF should apply for an anchored, learned place");
    assert.ok(
      ctx.correctedGust >= ctx.correctedSpeed,
      `corrected gust (${ctx.correctedGust}) must be >= corrected speed (${ctx.correctedSpeed})`,
    );
    // The raw (un-floored) scaling would put the gust at 6 kn and speed at
    // 15 kn (×device-height ratio), so the floor must actually bind here:
    assert.strictEqual(
      ctx.correctedGust,
      ctx.correctedSpeed,
      "floor should bind: gust clamped up to the corrected speed",
    );

    await plugin.stop();
  });

  test("leaves a already-valid gust (>= speed) unchanged", async () => {
    const app = new FakeSignalKApp();
    const lat = 60.1;
    const lon = 21.8;
    const dirDeg = 180;

    app.setSelfPath("navigation.position", { latitude: lat, longitude: lon });
    app.setSelfPath("navigation.state", "anchored");

    const { plugin, resolveWindProtectionContext } = await startAndSeed(app, {
      lat,
      lon,
      dirDeg,
    });

    // Here the seeded factors still give speed×1.5 and gust×0.5, but with a
    // forecast gust large enough that the corrected gust stays above the
    // corrected speed: speed = 10×1.5 = 15, gust = 40×0.5 = 20 → 20 >= 15.
    const ctx = resolveWindProtectionContext(
      10, // forecastSpeedKnots
      40, // forecastGustKnots (large)
      dirDeg,
      Math.PI / 4,
    );

    assert.ok(ctx.applies);
    // Gust stays above speed; floor must not raise it further.
    assert.ok(
      ctx.correctedGust > ctx.correctedSpeed,
      `corrected gust (${ctx.correctedGust}) should remain above corrected speed (${ctx.correctedSpeed})`,
    );

    await plugin.stop();
  });

  test("does not apply (no floor) when under way", async () => {
    const app = new FakeSignalKApp();
    const lat = 60.1;
    const lon = 21.8;
    const dirDeg = 180;

    app.setSelfPath("navigation.position", { latitude: lat, longitude: lon });
    app.setSelfPath("navigation.state", "sailing");

    const { plugin, resolveWindProtectionContext } = await startAndSeed(app, {
      lat,
      lon,
      dirDeg,
    });

    const ctx = resolveWindProtectionContext(10, 12, dirDeg, Math.PI / 4);
    assert.strictEqual(ctx.applies, false);
    // Pass-through: gust equals the raw forecast gust, not floored to speed.
    assert.strictEqual(ctx.correctedSpeed, 10);
    assert.strictEqual(ctx.correctedGust, 12);

    await plugin.stop();
  });
});
