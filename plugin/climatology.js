/**
 * Monthly climatology for the clear-sky fallback: a regional, seasonal
 * cloud factor learned from NASA POWER's historical satellite record.
 *
 * The Clear Sky tier assumes 0 % cloud everywhere, always — a systematically
 * optimistic fallback of last resort, exactly in the situations where solar
 * prediction matters most (mid-passage with no uplink). This module supplies
 * the missing regional/seasonal axis: the all-sky/clear-sky ratio
 * `Kc(month, cell)` from NASA POWER's monthly climatology (a ~1° grid,
 * 1981–present, no API key, US-government public domain). A cached cell's
 * 12 ratio values scale the clear-sky curve into a *typical* expectation for
 * the region and month instead of a fantasy upper bound.
 *
 * The data is static (a multi-decade monthly mean), so a fetched cell never
 * expires — refetch only when the vessel crosses into another cell. After the
 * first fetch per cell the tier works fully offline.
 *
 * Data source: https://power.larc.nasa.gov/ (public domain, see
 * https://power.larc.nasa.gov/docs/methodology/). Values are
 * MJ/m²/day; the Kc ratio is unitless, so no conversion is needed.
 *
 * @file climatology.js
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

/** NASA POWER monthly climatology point API endpoint */
const NASA_POWER_URL =
  "https://power.larc.nasa.gov/api/temporal/climatology/point";

/** Cell resolution in decimal degrees (~1° ≈ ~60 NM) */
const CELL_DECIMALS = 0;

/** NASA POWER request timeout in ms */
const FETCH_TIMEOUT = 30000;

/** NASA POWER monthly value encoding "no data" */
const NASA_POWER_FILL = -999;

/**
 * NASA POWER month column names, indexed 1–12.
 */
const MONTH_KEYS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

/**
 * UTC month (1–12) of a Date. The climatology statistic is coarse enough
 * that UTC-month edges are noise.
 *
 * @param {Date} date
 * @returns {number}
 */
function monthOf(date) {
  return date.getUTCMonth() + 1;
}

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
 * Climatology cell key (~1°) for a position, in the weather cache's
 * `lat_lon` bucket style (`.` → `-`).
 *
 * @param {number} latitude
 * @param {number} longitude
 * @returns {string}
 */
function cellKey(latitude, longitude) {
  const lat = roundTo(latitude, CELL_DECIMALS).toString().replace(".", "-");
  const lon = roundTo(longitude, CELL_DECIMALS).toString().replace(".", "-");
  return `${lat}_${lon}`;
}

/**
 * File path for a cell's cached climatology.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {number} latitude
 * @param {number} longitude
 * @returns {string}
 */
function cellFilePath(dataDir, latitude, longitude) {
  return path.join(
    dataDir,
    "climatology",
    `${cellKey(latitude, longitude)}.json`,
  );
}

/**
 * Validates a parsed NASA POWER monthly parameter object.
 *
 * @param {unknown} series
 * @returns {Record<string, number>|null} Valid month map, or null
 */
function validMonthlySeries(series) {
  if (series == null || typeof series !== "object") {
    return null;
  }
  const out = {};
  for (const key of MONTH_KEYS) {
    const v = series[key];
    if (typeof v !== "number" || Number.isNaN(v) || v === NASA_POWER_FILL) {
      continue;
    }
    out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Fetches the monthly all-sky/clear-sky ratio (Kc) for a cell from NASA
 * POWER. Months where either series is missing (polar winter, fill values)
 * or clear-sky is zero are omitted — the caller treats a missing month as
 * "no scaling".
 *
 * @param {number} latitude
 * @param {number} longitude
 * @param {typeof fetch} [fetchImpl] - Injectable fetch (tests)
 * @returns {Promise<{kc: Record<number, number>, fetchedAt: Date, cell: string}>}
 */
async function fetchKc(latitude, longitude, fetchImpl = fetch) {
  const url = new URL(NASA_POWER_URL);
  url.searchParams.set("parameters", "ALLSKY_SFC_SW_DWN,CLRSKY_SFC_SW_DWN");
  url.searchParams.set("community", "RE");
  url.searchParams.set("latitude", latitude.toString());
  url.searchParams.set("longitude", longitude.toString());
  url.searchParams.set("format", "JSON");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetchImpl(url.toString(), {
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`NASA POWER returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    const params = data?.properties?.parameter;
    const all = validMonthlySeries(params?.ALLSKY_SFC_SW_DWN);
    const clear = validMonthlySeries(params?.CLRSKY_SFC_SW_DWN);
    if (!all || !clear) {
      throw new Error("NASA POWER response missing solar flux parameters");
    }
    const kc = {};
    for (const key of MONTH_KEYS) {
      const c = clear[key];
      const a = all[key];
      if (c == null || a == null || c <= 0) {
        continue; // polar winter / fill month: no scaling
      }
      // Data quirks can push all-sky slightly above clear-sky; clamp.
      kc[MONTH_KEYS.indexOf(key) + 1] = Math.max(0, Math.min(1, a / c));
    }
    if (Object.keys(kc).length === 0) {
      throw new Error("NASA POWER returned no usable months");
    }
    return {
      kc,
      fetchedAt: new Date(),
      cell: cellKey(latitude, longitude),
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(
        `NASA POWER fetch timed out after ${FETCH_TIMEOUT}ms`,
      );
      timeoutError.timeout = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Loads a cached cell's Kc from disk. Returns null when absent or unreadable.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Promise<{kc: Record<number, number>, fetchedAt: Date, cell: string}|null>}
 */
async function loadCachedKc(dataDir, latitude, longitude) {
  if (!dataDir) return null;
  try {
    const raw = await fs.readFile(
      cellFilePath(dataDir, latitude, longitude),
      "utf8",
    );
    const data = JSON.parse(raw);
    if (!data || typeof data.kc !== "object" || data.kc == null) {
      return null;
    }
    const kc = {};
    for (const key of Object.keys(data.kc)) {
      const m = Number(key);
      const v = data.kc[key];
      if (Number.isInteger(m) && m >= 1 && m <= 12 && typeof v === "number") {
        kc[m] = v;
      }
    }
    if (Object.keys(kc).length === 0) {
      return null;
    }
    return {
      kc,
      fetchedAt: data.fetchedAt ? new Date(data.fetchedAt) : new Date(0),
      cell: cellKey(latitude, longitude),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Saves a cell's Kc to disk (atomic: unique temp file + fsync + rename, same
 * discipline as the weather cache — a power loss must not leave a truncated
 * file behind, though a missing one merely costs a refetch).
 *
 * @param {string} dataDir - Plugin data directory
 * @param {number} latitude
 * @param {number} longitude
 * @param {{kc: Record<number, number>, fetchedAt: Date, cell: string}} data
 * @returns {Promise<void>}
 */
async function saveKc(dataDir, latitude, longitude, data) {
  const file = cellFilePath(dataDir, latitude, longitude);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({
    cell: data.cell,
    fetchedAt: data.fetchedAt.toISOString(),
    kc: data.kc,
    schemaVersion: 1,
  });
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

/**
 * Maps a cloud factor to the equivalent Kasten-Czeplak cloud cover, so
 * climatology points carry a consistent `cloudCover` instead of clear sky's
 * fake 0. Inverse of `irradianceFromCloudCover`'s attenuation
 * `1 - 0.75·C^3.4`: `C = ((1-Kc)/0.75)^(1/3.4)`, clamped to [0, 1].
 *
 * @param {number} kc - All-sky/clear-sky ratio [0, 1]
 * @returns {number} Equivalent cloud cover [0, 1]
 */
function kcToCloudCover(kc) {
  if (kc >= 1) return 0;
  const c = ((1 - kc) / 0.75) ** (1 / 3.4);
  return Math.max(0, Math.min(1, c));
}

/**
 * Looks up the Kc for a month; null means "no scaling for this month"
 * (missing in the NASA POWER record, e.g. polar winter).
 *
 * @param {{kc: Record<number, number>}|null} climatology - Cached cell data
 * @param {number} month - UTC month 1–12
 * @returns {number|null}
 */
function monthKc(climatology, month) {
  if (!climatology?.kc) return null;
  const v = climatology.kc[month];
  return typeof v === "number" ? v : null;
}

module.exports = {
  NASA_POWER_URL,
  CELL_DECIMALS,
  monthOf,
  cellKey,
  cellFilePath,
  fetchKc,
  loadCachedKc,
  saveKc,
  kcToCloudCover,
  monthKc,
};
