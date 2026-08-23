/**
 * Offline-first cache for historical archive weather and live forecasts.
 *
 * Weather for a given (UTC date, ~0.01° position bucket, hour) is immutable in
 * the sense that a better-quality source never becomes worse by being
 * overwritten by a fallback. This module persists each day's hourly weather
 * to its own file keyed by UTC date + position bucket, and merges writes by
 * **tier**: a higher-quality (lower tier number) point always wins, and a
 * worse tier only fills the hours (and the null fields) a better one didn't
 * cover. This makes the cache work the same way regardless of source:
 *
 *  - **Backfill**: Open-Meteo archive (tier 1) is the best, so it effectively
 *    seeds each day; re-runs read from disk (zero network, works offline).
 *  - **Live forecast**: any tier writes; a later Clear Sky (tier 4) only fills
 *    hours a real forecast (tier 1-3) didn't cover, and a later real forecast
 *    overwrites Clear Sky values for its hours.
 *
 * File layout: `<dataDir>/weather/<YYYY-MM-DD>/<lat>_<lon>.json`, where
 * `<lat>`/`<lon>` are the bucket coordinates with `.` → `-` (e.g.
 * `60-17_21-38.json`). One file per (date, bucket) holds the day's hourly
 * points as a JSON array, each tagged with the tier that produced it.
 *
 * The cache lives outside the recordings store, so sample retention never
 * evicts weather (retention is a separate decision — see work doc #14).
 *
 * @file weather-cache.js
 */

/**
 * @typedef {Object} WeatherPoint
 * @property {Date} time
 * @property {number|null} ghi
 * @property {number|null} cloudCover
 * @property {number|null} windSpeedKnots
 * @property {number|null} gustSpeedKnots
 * @property {number|null} windDirectionDeg
 * @property {number|null} [tier] - 1=Open-Meteo, 2=SK Weather, 3=Logbook,
 *           4=Clear Sky. Lower is better quality. Absent on legacy reads.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

/**
 * Bucket precision in decimal degrees (~0.01° ≈ ~1 km). Coarse enough that an
 * anchored vessel hits the same bucket across days, fine enough that a
 * passage gets distinct weather along the track.
 */
const BUCKET_DECIMALS = 2;

/**
 * Rounds a number to a fixed precision.
 * @param {number} v
 * @param {number} decimals
 * @returns {number}
 */
function roundTo(v, decimals) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/**
 * Position bucket (~0.01°) used as the cache key.
 * @param {number} latitude
 * @param {number} longitude
 * @returns {{latitude: number, longitude: number}}
 */
function weatherPositionBucket(latitude, longitude) {
  return {
    latitude: roundTo(latitude, BUCKET_DECIMALS),
    longitude: roundTo(longitude, BUCKET_DECIMALS),
  };
}

/**
 * Sanitizes a coordinate for use in a filename. The sign is encoded as a
 * leading `m` (minus) / `p` (plus) prefix so the filename never starts with
 * a bare `-` (which looks like a CLI flag and makes paths confusing), and
 * the decimal point becomes `-`. e.g. `-16.05` → `m16-05`, `142.38` →
 * `p142-38`.
 * @param {number} v
 * @returns {string}
 */
function coordToFile(v) {
  const sign = v < 0 ? "m" : "p";
  return `${sign}${String(Math.abs(v)).replace(".", "-")}`;
}

/**
 * File path for a (date, bucket) cache entry.
 * @param {string} dataDir
 * @param {string} dateKey - YYYY-MM-DD
 * @param {{latitude: number, longitude: number}} bucket
 * @returns {string}
 */
function weatherCachePath(dataDir, dateKey, bucket) {
  const name = `${coordToFile(bucket.latitude)}_${coordToFile(bucket.longitude)}.json`;
  return path.join(dataDir, "weather", dateKey, name);
}

/**
 * Serializes hourly weather points for storage. Dates become ISO strings so
 * the file is plain JSON; the cache read side parses them back to Dates. The
 * per-hour `tier` records which forecast tier produced the point so a later,
 * worse-tier write can't overwrite a better one.
 * @param {WeatherPoint[]} hours
 * @returns {object[]}
 */
function serializeHours(hours) {
  return hours.map((h) => ({
    time: h.time instanceof Date ? h.time.toISOString() : h.time,
    ghi: h.ghi ?? null,
    cloudCover: h.cloudCover ?? null,
    windSpeedKnots: h.windSpeedKnots ?? null,
    gustSpeedKnots: h.gustSpeedKnots ?? null,
    windDirectionDeg: h.windDirectionDeg ?? null,
    tier: h.tier ?? null,
  }));
}

/**
 * Parses cached hourly weather points back to the shape callers expect (with
 * `Date` objects for `time`). The `tier` field is preserved so callers can
 * tell a measured/forecast value from a Clear Sky fallback.
 * @param {object[]} raw
 * @returns {WeatherPoint[]}
 */
function deserializeHours(raw) {
  return (raw || []).map((h) => ({
    time: new Date(h.time),
    ghi: h.ghi ?? null,
    cloudCover: h.cloudCover ?? null,
    windSpeedKnots: h.windSpeedKnots ?? null,
    gustSpeedKnots: h.gustSpeedKnots ?? null,
    windDirectionDeg: h.windDirectionDeg ?? null,
    tier: h.tier ?? null,
  }));
}

/** Fields that may be filled from a worse-tier point when the better one lacks them. */
const MERGE_FIELDS = [
  "ghi",
  "cloudCover",
  "windSpeedKnots",
  "gustSpeedKnots",
  "windDirectionDeg",
];

/**
 * Hour key for merge dedup: ISO string of the UTC hour. Two points for the
 * same hour merge regardless of tier.
 * @param {Date|string} time
 * @returns {string}
 */
function hourKey(time) {
  const d = time instanceof Date ? time : new Date(time);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}:00:00Z`;
}

/**
 * Merges two points for the same hour by tier. The better (lower) tier is the
 * base; any of its null fields are filled from the worse tier so e.g. a
 * tier-1 point missing cloudCover still benefits from a tier-2 point that
 * has it. The better tier is always retained.
 * @param {WeatherPoint} better - lower tier number (better quality)
 * @param {WeatherPoint} worse - higher tier number (worse quality)
 * @returns {WeatherPoint}
 */
function mergeHour(better, worse) {
  const base = { ...better };
  for (const f of MERGE_FIELDS) {
    if (base[f] == null && worse[f] != null) {
      base[f] = worse[f];
    }
  }
  base.tier = better.tier ?? worse.tier;
  return base;
}

/**
 * Merges an incoming set of hours into existing cached hours by hour. Better
 * (lower) tier wins per hour; equal tier lets the incoming point refresh
 * existing (so a re-fetch updates stale values). Hours present in only one
 * side are preserved. Result is sorted by time.
 * @param {WeatherPoint[]|null} existing - may be null
 * @param {WeatherPoint[]} incoming
 * @param {number} [incomingTier] - tier applied to incoming points that lack
 *        their own `tier` field
 * @returns {WeatherPoint[]}
 */
function mergeHours(existing, incoming, incomingTier) {
  const byHour = new Map();
  const tag = (p) =>
    p.tier == null && incomingTier != null ? { ...p, tier: incomingTier } : p;
  for (const p of existing || []) byHour.set(hourKey(p.time), p);
  for (const p of incoming) {
    const np = tag(p);
    const key = hourKey(np.time);
    const cur = byHour.get(key);
    if (!cur) {
      byHour.set(key, np);
      continue;
    }
    const curTier = cur.tier ?? Infinity;
    const newTier = np.tier ?? Infinity;
    if (newTier < curTier) byHour.set(key, mergeHour(np, cur));
    else if (newTier === curTier) byHour.set(key, np);
    else byHour.set(key, mergeHour(cur, np));
  }
  return Array.from(byHour.values()).sort(
    (a, b) => a.time.getTime() - b.time.getTime(),
  );
}

/**
 * Reads a day's cached weather for a position bucket.
 * @param {string} dataDir
 * @param {string} dateKey - YYYY-MM-DD
 * @param {{latitude: number, longitude: number}} bucket
 * @returns {Promise<WeatherPoint[]|null>} Hourly points, or null if not cached
 */
async function readWeatherCache(dataDir, dateKey, bucket) {
  const filePath = weatherCachePath(dataDir, dateKey, bucket);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return deserializeHours(JSON.parse(content));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    // Corrupt cache file: treat as a miss (caller will re-fetch + overwrite)
    return null;
  }
}

/**
 * Merges a day's weather for a position bucket into the cache, keyed by
 * hour. Better (lower) tier wins per hour; equal tier lets the incoming
 * point refresh. This makes a live Clear Sky forecast fill only the hours a
 * real forecast didn't cover, while a later real forecast overwrites the
 * Clear Sky values for its hours.
 *
 * @param {string} dataDir
 * @param {string} dateKey - YYYY-MM-DD
 * @param {{latitude: number, longitude: number}} bucket
 * @param {WeatherPoint[]} hours - incoming points to merge in
 * @param {number} [tier] - tier of the incoming points (defaults to each
 *        point's own `tier`); Open-Meteo archive = 1, SK Weather = 2,
 *        Logbook = 3, Clear Sky = 4
 * @returns {Promise<void>}
 */
async function writeWeatherCache(dataDir, dateKey, bucket, hours, tier) {
  const filePath = weatherCachePath(dataDir, dateKey, bucket);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let existing = null;
  try {
    existing = deserializeHours(
      JSON.parse(await fs.readFile(filePath, "utf-8")),
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      // Corrupt: start fresh rather than lose the incoming write
      existing = null;
    }
  }
  const merged = mergeHours(existing, hours, tier);
  await fs.writeFile(filePath, JSON.stringify(serializeHours(merged)), "utf-8");
}

module.exports = {
  BUCKET_DECIMALS,
  weatherPositionBucket,
  weatherCachePath,
  mergeHours,
  readWeatherCache,
  writeWeatherCache,
};
