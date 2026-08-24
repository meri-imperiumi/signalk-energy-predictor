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
  weatherRestoreBucket,
  weatherCachePath,
  mergeHours,
  readWeatherCache,
  readWeatherCacheCoarse,
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
    windSpeedMs: 10,
    gustSpeedMs: 15,
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

test("readWeatherCache converts legacy *Knots wind fields to m/s", async () => {
  // Pre-m/s caches stored wind in knots under `windSpeedKnots`/
  // `gustSpeedKnots`. New reads must convert those to m/s so old on-disk
  // caches stay readable without a re-fetch.
  const dir = await mkTmpDir();
  const bucket = { latitude: 60.17, longitude: 21.39 };
  const filePath = weatherCachePath(dir, DATE, bucket);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // 10 kn ≈ 5.144 m/s, 15 kn ≈ 7.716 m/s
  await fs.writeFile(
    filePath,
    JSON.stringify([
      {
        time: NOON_ISO,
        ghi: 500,
        cloudCover: 0.3,
        windSpeedKnots: 10,
        gustSpeedKnots: 15,
        windDirectionDeg: 90,
        tier: 1,
      },
    ]),
  );
  const got = await readWeatherCache(dir, DATE, bucket);
  assert.ok(got);
  assert.strictEqual(got.length, 1);
  assert.ok(Math.abs(got[0].windSpeedMs - 10 / 1.94384) < 1e-9);
  assert.ok(Math.abs(got[0].gustSpeedMs - 15 / 1.94384) < 1e-9);
  // New field name is what callers see; the legacy key must not leak through.
  assert.strictEqual("windSpeedKnots" in got[0], false);
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

test("weatherRestoreBucket rounds to ~1° for offline restore keying", () => {
  // A vessel at 60.17/21.39 and another at 60.42/21.48 both fall in the
  // same ~1° restore bucket (60/21), so a forecast fetched at either can be
  // restored at the other after a ~15 nm move. (roundTo uses Math.round, so
  // 0.5 and above rounds away from zero; stay below .5 to share a bucket.)
  const a = weatherRestoreBucket(60.17, 21.39);
  const b = weatherRestoreBucket(60.42, 21.48);
  assert.deepStrictEqual(a, { latitude: 60, longitude: 21 });
  assert.deepStrictEqual(a, b);
  // Negative coordinates round toward zero like roundTo (Math.round).
  const neg = weatherRestoreBucket(-16.27, -142.38);
  assert.deepStrictEqual(neg, { latitude: -16, longitude: -142 });
});

test("readWeatherCacheCoarse returns null when the day isn't cached", async () => {
  const dir = await mkTmpDir();
  const got = await readWeatherCacheCoarse(dir, DATE, {
    latitude: 60,
    longitude: 21,
  });
  assert.strictEqual(got, null);
});

test("readWeatherCacheCoarse merges fine-bucket files within a ~1° square and returns the newest mtime", async () => {
  // Simulate a track: the boat fetched a tier-1 forecast at 60.17/21.39
  // (noon hour) earlier, then moved ~0.2° and fetched again at 60.38/21.42
  // (hour 13). Both fall in the 60/21 restore bucket. A restore at the
  // boat's current position (60.27/21.40) must merge both and report the
  // newer file's mtime as fetchedAt.
  const dir = await mkTmpDir();
  await writeWeatherCache(
    dir,
    DATE,
    { latitude: 60.17, longitude: 21.39 },
    [hp(12, { tier: 1, ghi: 800 })],
    1,
  );
  const firstFile = weatherCachePath(
    dir,
    DATE,
    weatherPositionBucket(60.17, 21.39),
  );
  const firstMtime = (await fs.stat(firstFile)).mtimeMs;
  // Force the second file to be newer than the first. Use a gap large
  // enough to exceed filesystem mtime resolution on CI runners (ext4 can
  // round to whole seconds), then record the actual second file's mtime
  // rather than the wall clock — `readWeatherCacheCoarse` returns the
  // inode mtime, which the kernel may assign slightly before/after
  // `Date.now()` at write time, so asserting against the wall clock is
  // inherently flaky.
  await new Promise((r) => setTimeout(r, 1100));
  await writeWeatherCache(dir, DATE, { latitude: 60.38, longitude: 21.42 }, [
    hp(13, { tier: 1, ghi: 760 }),
  ]);
  const secondFile = weatherCachePath(
    dir,
    DATE,
    weatherPositionBucket(60.38, 21.42),
  );
  const secondMtime = (await fs.stat(secondFile)).mtimeMs;

  const got = await readWeatherCacheCoarse(dir, DATE, {
    latitude: 60,
    longitude: 21,
  });
  assert.ok(got, "restore hit within the coarse bucket");
  assert.strictEqual(got.hours.length, 2);
  const byHour = new Map(got.hours.map((p) => [p.time.getUTCHours(), p]));
  assert.strictEqual(byHour.get(12).ghi, 800);
  assert.strictEqual(byHour.get(13).ghi, 760);
  // The restore must pick the newest of the merged files' mtimes, and the
  // second write (after the gap) must have produced a strictly newer file.
  // `readWeatherCacheCoarse` builds `fetchedAt` via `new Date(mtimeMs)`,
  // which truncates the sub-millisecond mtime to whole milliseconds, so
  // compare against the truncated value rather than the raw float.
  assert.ok(secondMtime > firstMtime, "second fetch wrote a newer file");
  assert.ok(
    got.fetchedAt instanceof Date &&
      got.fetchedAt.getTime() === Math.trunc(secondMtime),
    "fetchedAt is the newest file mtime",
  );
});

test("readWeatherCacheCoarse ignores fine buckets outside the restore square", async () => {
  const dir = await mkTmpDir();
  // 60.17/21.39 is in the 60/21 restore bucket.
  await writeWeatherCache(
    dir,
    DATE,
    { latitude: 60.17, longitude: 21.39 },
    [hp(12, { tier: 1, ghi: 800 })],
    1,
  );
  // 60.17/22.40 is in the 60/22 restore bucket — must be excluded.
  await writeWeatherCache(
    dir,
    DATE,
    { latitude: 60.17, longitude: 22.4 },
    [hp(12, { tier: 1, ghi: 1 })],
    1,
  );
  const got = await readWeatherCacheCoarse(dir, DATE, {
    latitude: 60,
    longitude: 21,
  });
  assert.ok(got);
  assert.strictEqual(got.hours.length, 1);
  assert.strictEqual(got.hours[0].ghi, 800);
});

test("readWeatherCacheCoarse degrades to null on a corrupt file (keeps the good ones)", async () => {
  const dir = await mkTmpDir();
  await writeWeatherCache(
    dir,
    DATE,
    { latitude: 60.17, longitude: 21.39 },
    [hp(12, { tier: 1, ghi: 800 })],
    1,
  );
  // Drop a non-JSON file in the same directory; it must be skipped, not fatal.
  await fs.writeFile(
    path.join(dir, "weather", DATE, "junk.json"),
    "not json at all",
    "utf-8",
  );
  const got = await readWeatherCacheCoarse(dir, DATE, {
    latitude: 60,
    longitude: 21,
  });
  assert.ok(got, "good file still merged despite a corrupt sibling");
  assert.strictEqual(got.hours.length, 1);
  assert.strictEqual(got.hours[0].ghi, 800);
});
