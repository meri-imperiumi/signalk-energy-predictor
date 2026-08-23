/**
 * Tests for the offline-first weather cache: bucket keying, tier-precedence
 * merge (better tier wins; worse tier only fills null fields and uncovered
 * hours), offline read, and resumable backfill behavior.
 *
 * `plugin/weather-cache.js` has no DOM dependencies, so it can be imported
 * and exercised directly against a temp directory.
 * @file weather-cache.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  weatherPositionBucket,
  weatherCachePath,
  mergeHours,
  readWeatherCache,
  writeWeatherCache,
} = require("../plugin/weather-cache.js");

const DATE = "2026-08-20";
const NOON_ISO = "2026-08-20T12:00:00.000Z";

/**
 * @param {number} hour - UTC hour 0..23
 * @param {Partial<object>} over
 * @returns {object}
 */
function hp(hour, over = {}) {
  return {
    time: new Date(`2026-08-20T${String(hour).padStart(2, "0")}:00:00Z`),
    ghi: 500,
    cloudCover: 0.3,
    windSpeedKnots: 10,
    gustSpeedKnots: 15,
    windDirectionDeg: 90,
    tier: 1,
    ...over,
  };
}

async function mkTmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "weather-cache-test-"));
  return dir;
}

test("weatherPositionBucket rounds to ~0.01°", () => {
  const b = weatherPositionBucket(60.1745, 21.3851);
  assert.strictEqual(b.latitude, 60.17);
  assert.strictEqual(b.longitude, 21.39);
});

test("weatherCachePath nests under weather/<date>/ and escapes decimals", () => {
  const p = weatherCachePath("/data", DATE, {
    latitude: 60.17,
    longitude: 21.39,
  });
  assert.ok(p.includes(path.join("weather", DATE)));
  assert.ok(p.endsWith("p60-17_p21-39.json"));
});

test("readWeatherCache returns null when the day isn't cached", async () => {
  const dir = await mkTmpDir();
  const got = await readWeatherCache(dir, DATE, {
    latitude: 60.17,
    longitude: 21.39,
  });
  assert.strictEqual(got, null);
});

test("write then read round-trips with Date objects and tier preserved", async () => {
  const dir = await mkTmpDir();
  const bucket = { latitude: 60.17, longitude: 21.39 };
  await writeWeatherCache(dir, DATE, bucket, [hp(12, { ghi: 800 })], 1);
  const got = await readWeatherCache(dir, DATE, bucket);
  assert.ok(got);
  assert.strictEqual(got.length, 1);
  assert.ok(got[0].time instanceof Date);
  assert.strictEqual(got[0].time.toISOString(), NOON_ISO);
  assert.strictEqual(got[0].ghi, 800);
  assert.strictEqual(got[0].tier, 1);
});

test("better tier wins per hour on overwrite (Clear Sky must not clobber Open-Meteo)", async () => {
  const dir = await mkTmpDir();
  const bucket = { latitude: 60.17, longitude: 21.39 };
  // Seed with a tier-1 Open-Meteo ghi at noon.
  await writeWeatherCache(dir, DATE, bucket, [hp(12, { ghi: 800 })], 1);
  // A later live Clear Sky (tier 4) covers the same hour with a worse value.
  await writeWeatherCache(dir, DATE, bucket, [hp(12, { ghi: 1, tier: 4 })], 4);
  const got = await readWeatherCache(dir, DATE, bucket);
  assert.ok(got);
  assert.strictEqual(got.length, 1);
  // Better (tier 1) ghi is retained; the worse value is discarded.
  assert.strictEqual(got[0].ghi, 800);
  assert.strictEqual(got[0].tier, 1);
});

test("worse tier fills hours the better tier didn't cover", async () => {
  const dir = await mkTmpDir();
  const bucket = { latitude: 60.17, longitude: 21.39 };
  // Tier 1 only has noon.
  await writeWeatherCache(dir, DATE, bucket, [hp(12, { tier: 1 })], 1);
  // Tier 4 fills hour 13 (uncovered).
  await writeWeatherCache(dir, DATE, bucket, [hp(13, { tier: 4, ghi: 1 })], 4);
  const got = await readWeatherCache(dir, DATE, bucket);
  assert.ok(got);
  assert.strictEqual(got.length, 2);
  const byHour = new Map(got.map((p) => [p.time.getUTCHours(), p]));
  assert.strictEqual(byHour.get(12).tier, 1);
  assert.strictEqual(byHour.get(13).tier, 4);
  assert.strictEqual(byHour.get(13).ghi, 1);
});

test("worse tier fills null fields on a better-tier point", async () => {
  const dir = await mkTmpDir();
  const bucket = { latitude: 60.17, longitude: 21.39 };
  // Tier 1 has ghi but no cloudCover.
  await writeWeatherCache(
    dir,
    DATE,
    bucket,
    [hp(12, { tier: 1, ghi: 800, cloudCover: null })],
    1,
  );
  // Tier 2 (SK Weather) has cloudCover but no ghi.
  await writeWeatherCache(
    dir,
    DATE,
    bucket,
    [hp(12, { tier: 2, ghi: null, cloudCover: 0.6 })],
    2,
  );
  const got = await readWeatherCache(dir, DATE, bucket);
  assert.ok(got);
  assert.strictEqual(got.length, 1);
  // Tier 1 ghi stays authoritative; tier 2 fills the missing cloudCover.
  assert.strictEqual(got[0].ghi, 800);
  assert.strictEqual(got[0].cloudCover, 0.6);
  assert.strictEqual(got[0].tier, 1);
});

test("equal tier lets the incoming point refresh existing", async () => {
  const dir = await mkTmpDir();
  const bucket = { latitude: 60.17, longitude: 21.39 };
  await writeWeatherCache(
    dir,
    DATE,
    bucket,
    [hp(12, { tier: 1, ghi: 800 })],
    1,
  );
  await writeWeatherCache(
    dir,
    DATE,
    bucket,
    [hp(12, { tier: 1, ghi: 820 })],
    1,
  );
  const got = await readWeatherCache(dir, DATE, bucket);
  assert.ok(got);
  assert.strictEqual(got[0].ghi, 820);
});

test("mergeHours is a pure function (no I/O) and sorts by time", () => {
  const merged = mergeHours(
    [hp(12, { tier: 4, ghi: 1 })],
    [hp(11, { tier: 1, ghi: 800 }), hp(12, { tier: 1, ghi: 800 })],
  );
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].time.getUTCHours(), 11);
  assert.strictEqual(merged[1].time.getUTCHours(), 12);
  assert.strictEqual(merged[1].tier, 1);
  assert.strictEqual(merged[1].ghi, 800);
});
