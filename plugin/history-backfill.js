/**
 * Replays remote Signal K History API data through the learning matrices.
 *
 * Shared by the backtesting CLI (sandboxed matrix, validation only) and the
 * populate mode (seeds and persists the live learning matrices).
 *
 * @file history-backfill.js
 */

const { SolarMatrix, theoreticalPower } = require("./learning.js");
const fs = require("node:fs/promises");
const { sunPosition, irradianceFromCloudCover } = require("./solar.js");
const {
  predictWindHour,
  predictHydroHour,
  LoadProfile,
  StateClass,
} = require("./prediction.js");
const matrixPersistence = require("./matrix.js");
const { parseManufacturerCurve } = require("./schema.js");
const recorderModule = require("./recorder.js");
const {
  detectSolarArrayState,
  detectGeneratorState,
  STOW_INFERENCE_MIN_SUN_ALT_RAD,
} = require("./deploy-state.js");
const {
  WindProtectionStore,
  sectorFromDeg,
  isNight: wpfIsNight,
  toForecastReference,
  DEFAULT_ANEMOMETER_HEIGHT_M,
  DEFAULT_ROUGHNESS_LENGTH,
} = require("./wind-protection.js");

/**
 * Default history query resolution in seconds (5 minutes).
 */
const DEFAULT_RESOLUTION = 300;

/**
 * Speed-through-water threshold (knots) above which the vessel is considered
 * underway when `navigation.state` is unavailable. Chosen above typical
 * current/leeway drift so a vessel at anchor isn't mistaken for sailing.
 */
const SAILING_STW_KN = 2;

/** Conversion factor: 1 m/s = 1.943844 kn */
const MS_TO_KN = 1.943844;

/**
 * Signal K paths for engine running detection (any engine instance).
 * State is preferred (`started`/`stopped`); revolutions is the fallback
 * for engines without state instrumentation, mirroring
 * signalk-autostate's detection.
 */
const PROPULSION_STATE_RE = /^propulsion\.([A-Za-z0-9]+)\.state$/;
const PROPULSION_REVOLUTIONS_RE = /^propulsion\.([A-Za-z0-9]+)\.revolutions$/;

/**
 * Collects propulsion state and revolution paths for history queries.
 *
 * @param {object} historyData - History API /values response
 * @returns {Array<{path: string, kind: "state"|"revolutions", instance: string}>}
 */
function propulsionColumns(historyData) {
  const columns = [];
  for (const valueDef of historyData.values || []) {
    const stateMatch = PROPULSION_STATE_RE.exec(valueDef.path);
    if (stateMatch) {
      columns.push({
        path: valueDef.path,
        kind: "state",
        instance: stateMatch[1],
      });
      continue;
    }
    const revMatch = PROPULSION_REVOLUTIONS_RE.exec(valueDef.path);
    if (revMatch) {
      columns.push({
        path: valueDef.path,
        kind: "revolutions",
        instance: revMatch[1],
      });
    }
  }
  return columns;
}

/**
 * Discovers propulsion paths with historical data via the History API
 * /paths endpoint, so engine instance names (`main`, `port`, `starboard`,
 * ...) don't need to be configured.
 *
 * @param {object} params
 * @param {string} params.baseUrl - Signal K server base URL
 * @param {string} [params.token] - Bearer token (defaults to SIGNALK_TOKEN)
 * @param {string} [params.provider] - History provider ID
 * @param {Date} params.from - Start date
 * @param {Date} params.to - End date
 * @param {typeof fetch} [params.fetchImpl] - Fetch implementation (tests)
 * @returns {Promise<string[]>} Discovered propulsion state/revolutions paths
 */
async function discoverPropulsionPaths({
  baseUrl,
  token,
  provider,
  from,
  to,
  fetchImpl = fetch,
}) {
  const url = new URL("/signalk/v2/api/history/paths", baseUrl);
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", to.toISOString());
  if (provider) {
    url.searchParams.set("provider", provider);
  }

  const response = await fetchImpl(url, { headers: historyHeaders(token) });
  if (!response.ok) {
    throw new Error(
      `History paths API returned ${response.status}: ${response.statusText}`,
    );
  }

  const paths = await response.json();
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths.filter(
    (p) => PROPULSION_STATE_RE.test(p) || PROPULSION_REVOLUTIONS_RE.test(p),
  );
}

/**
 * Reads a raw column value from a history data point.
 *
 * @param {Array} point - History data point
 * @param {number|null} column - Column index, or null when path was not queried
 * @returns {unknown}
 */
function columnValue(point, column) {
  if (column == null) {
    return null;
  }
  const raw = point[column];
  if (raw == null) {
    return null;
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "object") {
    return raw.value ?? null;
  }
  return raw;
}

/**
 * Resolves a method-specific column index, preferring the explicit
 * `path:method` key set by pathColumns and falling back to the bare path
 * (for paths requested without a method suffix).
 *
 * @param {Map<string, number>} columns - From pathColumns
 * @param {string} path - Bare Signal K path
 * @param {string} [method] - Aggregate method (e.g. "max")
 * @returns {number|null}
 */
function columnFor(columns, path, method) {
  if (method) {
    const specific = columns.get(`${path}:${method}`);
    if (specific != null) return specific;
  }
  return columns.get(path) ?? null;
}

/**
 * Default SoC path when the configuration does not define one.
 */
const DEFAULT_SOC_PATH = "electrical.batteries.house.capacity.stateOfCharge";

/**
 * Builds headers for Signal K History API requests.
 *
 * The History API specification declares no security schemes, but servers
 * running with security enabled require a token for /signalk/v2/api/* routes.
 *
 * @param {string} [token] - Bearer token; defaults to SIGNALK_TOKEN env var
 * @returns {Record<string, string>} Request headers
 */
function historyHeaders(token = process.env.SIGNALK_TOKEN) {
  const headers = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Parses a timestamp that is UTC when it carries no explicit offset.
 *
 * Open-Meteo returns naive timestamps even with timezone=UTC, and Date
 * parsing treats those as the host's local time.
 *
 * @param {string} time - ISO 8601 timestamp, possibly without an offset
 * @returns {Date}
 */
function parseUtcTimestamp(time) {
  const hasOffset = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(time);
  return new Date(hasOffset ? time : `${time}Z`);
}

/**
 * Queries the Signal K History API for historical data.
 *
 * @param {object} params
 * @param {string} params.baseUrl - Signal K server base URL
 * @param {string} [params.token] - Bearer token (defaults to SIGNALK_TOKEN)
 * @param {string} [params.provider] - History provider ID
 * @param {Date} params.from - Start date
 * @param {Date} params.to - End date
 * @param {string[]} params.paths - Signal K paths to query
 * @param {number} [params.resolution] - Resolution in seconds
 * @param {typeof fetch} [params.fetchImpl] - Fetch implementation (tests)
 * @returns {Promise<object>} History API /values response
 */
async function queryHistory({
  baseUrl,
  token,
  provider,
  from,
  to,
  paths,
  resolution = DEFAULT_RESOLUTION,
  fetchImpl = fetch,
}) {
  const url = new URL("/signalk/v2/api/history/values", baseUrl);
  // Textual paths (navigation.state, propulsion.*.state, charge
  // controller mode/operationMode) cannot be averaged — the default method
  // returns 0 rows for strings. Use :last for these so enum values come
  // through. The API reports the method back in values[].method and strips
  // it from values[].path, so pathColumns maps by the bare path unchanged.
  const queryPaths = paths.map((p) =>
    /\.(state|controllerMode|operationMode)$/.test(p) && !p.includes(":")
      ? `${p}:last`
      : p,
  );
  url.searchParams.set("paths", queryPaths.join(","));
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", to.toISOString());
  url.searchParams.set("resolution", String(resolution));

  if (provider) {
    url.searchParams.set("provider", provider);
  }

  const response = await fetchImpl(url, { headers: historyHeaders(token) });

  if (!response.ok) {
    throw new Error(
      `History API returned ${response.status}: ${response.statusText}`,
    );
  }

  return await response.json();
}

/**
 * Fetches historical weather data from the Open-Meteo archive API.
 *
 * @param {object} params
 * @param {number} params.latitude - Latitude in degrees
 * @param {number} params.longitude - Longitude in degrees
 * @param {Date} params.from - Start date
 * @param {Date} params.to - End date
 * @param {typeof fetch} [params.fetchImpl] - Fetch implementation (tests)
 * @returns {Promise<Array<{time: Date, ghi: number|null, cloudCover: number|null}>>}
 */
async function fetchHistoricalWeather({
  latitude,
  longitude,
  from,
  to,
  fetchImpl = fetch,
}) {
  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("start_date", from.toISOString().split("T")[0]);
  url.searchParams.set("end_date", to.toISOString().split("T")[0]);
  url.searchParams.set(
    "hourly",
    "shortwave_radiation,cloud_cover,wind_speed_10m,wind_gusts_10m,wind_direction_10m",
  );
  url.searchParams.set("timezone", "UTC");

  const response = await fetchImpl(url);

  if (!response.ok) {
    throw new Error(`Open-Meteo Archive API returned ${response.status}`);
  }

  const data = await response.json();

  if (!data.hourly?.time) {
    return [];
  }

  /** km/h → knots */
  const kmhToKn = (v) => (v == null ? null : v * 0.539957);

  return data.hourly.time.map((time, i) => ({
    time: parseUtcTimestamp(time),
    ghi: data.hourly.shortwave_radiation?.[i] ?? null,
    cloudCover: data.hourly.cloud_cover?.[i] ?? null,
    windSpeedKnots: kmhToKn(data.hourly.wind_speed_10m?.[i] ?? null),
    gustSpeedKnots: kmhToKn(data.hourly.wind_gusts_10m?.[i] ?? null),
    windDirectionDeg: data.hourly.wind_direction_10m?.[i] ?? null,
  }));
}

/**
 * Fetches historical weather along a vessel track, one archive query per day
 * at that day's position (Open-Meteo archive is daily-granular and location-
 * specific). Calls run in parallel; results merge into a single time-sorted
 * array. The boat's daily displacement is small relative to the model grid.
 *
 * @param {object} params
 * @param {Array<{date: string, latitude: number, longitude: number}>} params.dailyPositions - UTC date → position
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<Array<{time: Date, ghi: number|null, cloudCover: number|null, windSpeedKnots: number|null, gustSpeedKnots: number|null, windDirectionDeg: number|null}>>}
 */
async function fetchHistoricalWeatherTrack({
  dailyPositions,
  fetchImpl = fetch,
}) {
  // Serialize per-day calls to stay within Open-Meteo's rate limit
  // (parallel calls get 429). Daily archive queries are cheap.
  const all = [];
  for (const { date, latitude, longitude } of dailyPositions) {
    const dayWeather = await fetchHistoricalWeather({
      latitude,
      longitude,
      from: new Date(`${date}T00:00:00Z`),
      to: new Date(`${date}T23:59:59Z`),
      fetchImpl,
    });
    all.push(...dayWeather);
  }
  return all.sort((a, b) => a.time - b.time);
}

/**
 * Builds a per-UTC-date position map from history data, using the position
 * closest to each date's noon. Used to fetch weather along the track.
 *
 * @param {object} historyData - History API /values response with navigation.position
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @returns {Array<{date: string, latitude: number, longitude: number}>}
 */
function dailyPositionsFromHistory(historyData, from, to) {
  const columns = pathColumns(historyData);
  const positionColumn = columns.get("navigation.position");
  if (positionColumn == null) {
    return [];
  }

  // Collect the position sample nearest noon for each UTC date in range
  const byDate = new Map();
  for (const point of historyData.data || []) {
    const time = parseUtcTimestamp(point[0]);
    if (time < from || time > to) continue;
    const pos = columnValue(point, positionColumn);
    if (!Array.isArray(pos) || pos.length < 2) continue;
    const date = time.toISOString().split("T")[0];
    const noonDist = Math.abs((time.getTime() % 86400000) - 12 * 3600000);
    const existing = byDate.get(date);
    if (!existing || noonDist < existing.noonDist) {
      byDate.set(date, {
        noonDist,
        position: pos,
      });
    }
  }

  return [...byDate.entries()]
    .map(([date, { position }]) => ({
      date,
      longitude: position[0],
      latitude: position[1],
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Interpolates weather data for a specific time.
 *
 * @param {Array<{time: Date, ghi: number|null, cloudCover: number|null}>} weather
 * @param {Date} time - Target time
 * @returns {{ghi: number|null, cloudCover: number|null}}
 */
/**
 * Vessel-history paths queried alongside power/SoC: navigation state for
 * matrix branching, apparent wind angle for sailing bins, speed through
 * water for hydro generators, and position for recordings samples.
 */
const CONTEXT_PATHS = [
  "navigation.state",
  "environment.wind.angleApparent",
  "environment.wind.speedTrue",
  "environment.wind.speedApparent",
  "environment.wind.directionTrue",
  "navigation.speedThroughWater",
  "navigation.position",
];

function interpolateWeather(weather, time) {
  let closest = null;
  let minDiff = Infinity;

  for (const point of weather) {
    const diff = Math.abs(point.time.getTime() - time.getTime());
    if (diff < minDiff) {
      minDiff = diff;
      closest = point;
    }
  }

  if (!closest || minDiff > 3600000) {
    // No data within 1 hour
    return {
      ghi: null,
      cloudCover: null,
      windSpeedKnots: null,
      gustSpeedKnots: null,
      windDirectionDeg: null,
    };
  }

  return {
    ghi: closest.ghi ?? null,
    cloudCover: closest.cloudCover ?? null,
    windSpeedKnots: closest.windSpeedKnots ?? null,
    gustSpeedKnots: closest.gustSpeedKnots ?? null,
    windDirectionDeg: closest.windDirectionDeg ?? null,
  };
}

/**
 * Indexes the columns of a History API /values response by path.
 *
 * @param {{values?: Array<{path: string, method?: string}>}} historyData
 * @returns {Map<string, number>} path -> column index (after the timestamp)
 */
function pathColumns(historyData) {
  const columns = new Map();
  for (const [i, valueDef] of (historyData.values || []).entries()) {
    // Bare path key: the default/average column (or the last column for a
    // path that only ever appears with a method). Callers that don't care
    // about the method keep using columns.get(path).
    columns.set(valueDef.path, i + 1);
    // Method-specific key: lets callers request e.g. speedTrue with method
    // "max" without colliding with its average column. Only set when the
    // API reports a method.
    if (valueDef.method) {
      columns.set(`${valueDef.path}:${valueDef.method}`, i + 1);
    }
  }
  return columns;
}

/**
 * Infers a navigation state from available motion signals when
 * `navigation.state` is absent from history. Many vessels never report a
 * nav state, so without inference the backfill would treat every tick as
 * "anchored" — killing hydro predictions and skipping sailing solar bins
 * even while the boat is clearly underway (STW > 0, hydro producing).
 *
 * Carry-forward: `navigation.state` is a sticky state, not a continuous
 * measurement. When history has an explicit state for some ticks and gaps
 * (null) for others, a gap carries the last explicit state forward instead
 * of falling back to STW inference. STW inference only runs when no
 * explicit state has been seen yet for the run (vessels that never report
 * navigation.state at all).
 *
 * Inference priority:
 * - explicit `navigation.state` wins when present
 * - otherwise, if a previous explicit state was carried forward, reuse it
 * - STW ≥ SAILING_STW_KN and engine not running → "sailing"
 * - STW ≥ SAILING_STW_KN and engine running → "motoring"
 * - STW < SAILING_STW_KN → "anchored"
 *
 * @param {Array} point - History data point
 * @param {number|null} navStateColumn - Column index for navigation.state
 * @param {number|null} stwColumn - Column index for speedThroughWater (m/s)
 * @param {Array} propulsionCols - Propulsion column descriptors
 * @param {Map<string, number>} columns - Path → column index map
 * @param {string|null} [previousExplicit] - Last explicitly-seen state to
 *        carry forward across gaps
 * @returns {{state: string, explicit: boolean}} The inferred state and
 *          whether it came from an explicit navigation.state value
 */
function inferNavState(
  point,
  navStateColumn,
  stwColumn,
  propulsionCols,
  columns,
  previousExplicit = null,
) {
  const explicit = columnValue(point, navStateColumn);
  if (
    explicit === "sailing" ||
    explicit === "motoring" ||
    explicit === "anchored" ||
    explicit === "moored" ||
    explicit === "docked"
  ) {
    return { state: explicit, explicit: true };
  }
  // Carry the last explicit state forward across gaps
  if (previousExplicit) {
    return { state: previousExplicit, explicit: false };
  }
  const stwMs = columnNumber(point, stwColumn);
  const stwKn = stwMs != null ? stwMs / 0.514444 : 0;
  if (stwKn >= SAILING_STW_KN) {
    const engineRunning = engineRunningAt(point, propulsionCols, columns);
    return {
      state: engineRunning === true ? "motoring" : "sailing",
      explicit: false,
    };
  }
  return { state: "anchored", explicit: false };
}

/**
 * Reads a numeric column value from a history data point.
 *
 * @param {Array} point - History data point
 * @param {number|null} column - Column index, or null when path was not queried
 * @returns {number|null}
 */
function columnNumber(point, column) {
  if (column == null) {
    return null;
  }
  const raw = point[column];
  if (raw == null) {
    return null;
  }
  if (typeof raw === "number") {
    return raw;
  }
  if (typeof raw === "object" && typeof raw.value === "number") {
    return raw.value;
  }
  return null;
}

/**
 * Rounds to two decimal places.
 *
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Derives engine running from a history data point across all queried
 * propulsion instances.
 *
 * @param {Array} point - History data point
 * @param {Array<{kind: string, instance: string}>} columns - Propulsion columns with index
 * @param {Map<string, number>} columnIndexes - path -> column index
 * @returns {boolean|null} true if any engine ran, false if all stopped, null if unknown
 */
function engineRunningAt(point, columns, columnIndexes) {
  let anyRunning = false;
  let anySignal = false;

  for (const col of columns) {
    const value = columnValue(point, columnIndexes.get(col.path));
    if (value == null) {
      continue;
    }
    anySignal = true;
    if (col.kind === "state" ? value === "started" : value > 0) {
      anyRunning = true;
    }
  }

  return anySignal ? anyRunning : null;
}

/**
 * Replays history through a learning matrix, updating it in place.
 *
 * Ticks failing the sanitization gate (high SoC, engine running) still count
 * towards prediction accuracy statistics but do not update the matrix.
 *
 * @param {object} params
 * @param {SolarMatrix} params.matrix - Matrix to update (in place)
 * @param {object} params.array - Solar array configuration
 * @param {string} params.array.powerPath - Signal K power path
 * @param {number} params.array.capacityWp - Array peak wattage
 * @param {string} params.socPath - Signal K SoC path for the gate
 * @param {object} params.historyData - History API /values response
 * @param {Array<{time: Date, ghi: number|null, cloudCover: number|null}>} params.weather
 * @param {number} [params.latitude] - Fallback latitude when position history is absent
 * @param {number} [params.longitude] - Fallback longitude when position history is absent
 * @param {number} [params.resolution] - Sample resolution in seconds
 * @returns {{dataPoints: number, binUpdates: number, droppedTicks: number, totalActualWh: number, totalPredictedWh: number, mae: number, rmse: number}}
 */
function replayHistory({
  matrix,
  array,
  socPath,
  historyData,
  weather,
  latitude,
  longitude,
  resolution = DEFAULT_RESOLUTION,
}) {
  if (!array.powerPath) {
    throw new Error(`Array ${array.id} has no power path configured`);
  }
  if (!array.capacityWp) {
    throw new Error(`Array ${array.id} has no capacityWp configured`);
  }

  const columns = pathColumns(historyData);
  const powerColumn = columns.get(array.powerPath);
  if (powerColumn == null) {
    throw new Error(`No history data for path ${array.powerPath}`);
  }
  const socColumn = columns.get(socPath);
  const propulsionCols = propulsionColumns(historyData);
  const navStateColumn = columns.get("navigation.state");
  const stwColumn = columns.get("navigation.speedThroughWater");
  const awaColumn = columns.get("environment.wind.angleApparent");
  // Charge controller mode for this array (string enum): bulk/absorption/
  // float. The learning gate drops non-bulk ticks, so reading it from history
  // keeps absorption/float-limited output out of the matrix. null when the
  // array has no controllerModePath or the path had no history data.
  const controllerModeColumn = array.controllerModePath
    ? columns.get(array.controllerModePath)
    : null;
  const positionColumn = columns.get("navigation.position");

  let dataPoints = 0;
  let binUpdates = 0;
  let droppedTicks = 0;
  let sailingTicks = 0;
  let totalActualWh = 0;
  let totalPredictedWh = 0;
  const errors = [];
  const intervalHours = resolution / 3600;
  /** Last explicit navigation.state, carried forward across gaps */
  let lastExplicitNavState = null;

  for (const point of historyData.data || []) {
    const time = parseUtcTimestamp(point[0]);
    const actualPowerW = columnNumber(point, powerColumn);
    if (actualPowerW == null || actualPowerW <= 0) {
      continue;
    }

    // Per-tick vessel position (boat may move over the window); fall back
    // to the supplied lat/lon when position history is absent
    const posValue = columnValue(point, positionColumn);
    const tickLat =
      Array.isArray(posValue) && posValue.length >= 2 ? posValue[1] : latitude;
    const tickLon =
      Array.isArray(posValue) && posValue.length >= 2 ? posValue[0] : longitude;

    const sunPos = sunPosition(time, tickLat, tickLon);
    const weatherPoint = interpolateWeather(weather, time);

    let ghi = weatherPoint.ghi;
    if (ghi == null && weatherPoint.cloudCover != null) {
      ghi = irradianceFromCloudCover(sunPos.altitude, weatherPoint.cloudCover);
    }
    if (ghi == null || ghi <= 0) {
      continue;
    }

    const theoretical = theoreticalPower(
      array.capacityWp,
      ghi,
      sunPos.altitude,
    );
    if (theoretical <= 0) {
      continue;
    }

    // Matrix branching: sailing bins when under sail with an AWA reading,
    // anchored/moored/motoring bins otherwise (sailing without AWA falls
    // back to anchored bins). Infer navState from STW when history has no
    // explicit navigation.state (common: many vessels never report it).
    const awaRad = columnNumber(point, awaColumn);
    const inferredState = inferNavState(
      point,
      navStateColumn,
      stwColumn,
      propulsionCols,
      columns,
      lastExplicitNavState,
    );
    if (inferredState.explicit) {
      lastExplicitNavState = inferredState.state;
    }
    const isSailing = inferredState.state === "sailing" && awaRad != null;
    if (isSailing) {
      sailingTicks++;
    }

    dataPoints++;

    // Predict with the pre-update efficiency (walk-forward, no lookahead)
    const predictedPower = isSailing
      ? theoretical * matrix.getSailing(sunPos.azimuth, sunPos.altitude, awaRad)
      : theoretical * matrix.getAnchored(sunPos.azimuth, sunPos.altitude);

    const updated = matrix.update({
      navState: isSailing ? "sailing" : "anchored",
      actualPowerW,
      capacityWp: array.capacityWp,
      ghi,
      sunAzimuthRad: sunPos.azimuth,
      sunElevationRad: sunPos.altitude,
      awaRad: isSailing ? awaRad : null,
      readings: {
        engineRunning: engineRunningAt(point, propulsionCols, columns),
        batterySoc: columnNumber(point, socColumn),
        shorePowerConnected: null,
        controllerMode: columnValue(point, controllerModeColumn),
      },
    });

    if (updated) {
      binUpdates++;
    } else {
      droppedTicks++;
    }

    totalActualWh += actualPowerW * intervalHours;
    totalPredictedWh += predictedPower * intervalHours;
    errors.push(Math.abs(predictedPower - actualPowerW));
  }

  const mae =
    errors.length > 0 ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
  const rmse =
    errors.length > 0
      ? Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length)
      : 0;

  return {
    dataPoints,
    binUpdates,
    droppedTicks,
    sailingTicks,
    totalActualWh: Math.round(totalActualWh),
    totalPredictedWh: Math.round(totalPredictedWh),
    mae: round2(mae),
    rmse: round2(rmse),
  };
}

/**
 * Replays mechanical generators (wind/hydro) over history for validation
 * stats. Uses the same power-curve and stow-gate logic as the live
 * prediction engine, so replayed predictions match what the engine would
 * have predicted for the recorded conditions.
 *
 * @param {object} params
 * @param {object[]} params.generators - Generator configurations (parsed curves)
 * @param {object} params.historyData - History API /values response
 * @param {Array<object>} params.weather - Historical weather points
 * @param {number} [params.resolution] - Sample resolution in seconds
 * @returns {Array<{id: string, type: string, dataPoints: number, totalActualWh: number, totalPredictedWh: number, mae: number, rmse: number}>}
 */
function replayGenerators({
  generators,
  historyData,
  weather,
  resolution = DEFAULT_RESOLUTION,
}) {
  const columns = pathColumns(historyData);
  const navStateColumn = columns.get("navigation.state");
  const stwColumn = columns.get("navigation.speedThroughWater");
  const propulsionCols = propulsionColumns(historyData);
  const intervalHours = resolution / 3600;

  const results = [];
  for (const generator of generators) {
    const powerColumn = columns.get(generator.powerPath);
    if (powerColumn == null) {
      continue; // No history for this generator
    }

    let dataPoints = 0;
    let totalActualWh = 0;
    let totalPredictedWh = 0;
    const errors = [];
    /** Last explicit navigation.state, carried forward across gaps */
    let lastExplicitNavState = null;

    for (const point of historyData.data || []) {
      const time = parseUtcTimestamp(point[0]);
      const actualPowerW = columnNumber(point, powerColumn);
      if (actualPowerW == null || actualPowerW < 0) {
        continue;
      }
      const weatherPoint = interpolateWeather(weather, time);
      const navStateResult = inferNavState(
        point,
        navStateColumn,
        stwColumn,
        propulsionCols,
        columns,
        lastExplicitNavState,
      );
      if (navStateResult.explicit) {
        lastExplicitNavState = navStateResult.state;
      }
      const navState = navStateResult.state;
      dataPoints++;

      let predictedW = 0;
      if (generator.type === "wind") {
        predictedW = predictWindHour({
          generator,
          windSpeedKnots: weatherPoint.windSpeedKnots ?? 0,
          gustSpeedKnots: weatherPoint.gustSpeedKnots ?? 0,
          navState,
        });
      } else if (generator.type === "hydro") {
        const stwKn =
          columnNumber(point, stwColumn) != null
            ? columnNumber(point, stwColumn) * 1.94384
            : 0;
        predictedW = predictHydroHour({
          generator,
          speedThroughWaterKnots: stwKn,
          isSailing: navState === "sailing",
        });
      }

      totalActualWh += actualPowerW * intervalHours;
      totalPredictedWh += predictedW * intervalHours;
      if (actualPowerW > 0 || predictedW > 0) {
        errors.push(Math.abs(predictedW - actualPowerW));
      }
    }

    const mae =
      errors.length > 0 ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
    const rmse =
      errors.length > 0
        ? Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length)
        : 0;

    results.push({
      id: generator.id,
      type: generator.type,
      dataPoints,
      totalActualWh: Math.round(totalActualWh),
      totalPredictedWh: Math.round(totalPredictedWh),
      mae: round2(mae),
      rmse: round2(rmse),
    });
  }

  return results;
}

/**
 * Populates learning matrices from a remote Signal K History API.
 *
 * Existing matrices in dataDir are used as the seed so replay continues from
 * current learning instead of starting from defaults. Results are persisted
 * with the standard matrix persistence (manifest included).
 *
 * @param {object} params
 * @param {object} params.config - Plugin configuration (solarArrays, battery)
 * @param {string} params.baseUrl - Signal K server base URL
 * @param {string} [params.token] - Bearer token (defaults to SIGNALK_TOKEN)
 * @param {string} [params.provider] - History provider ID
 * @param {Date} params.from - Start date
 * @param {Date} params.to - End date
 * @param {string} params.dataDir - Plugin data directory for matrices
 * @param {boolean} [params.fresh] - Wipe existing matrices before replay (clean EMA weighting)
 * @param {number} [params.resolution] - Resolution in seconds
 * @param {typeof fetch} [params.fetchImpl] - Fetch implementation (tests)
 * @returns {Promise<Array<{arrayId: string, seeded: boolean, dataPoints: number, binUpdates: number, droppedTicks: number, totalActualWh: number, totalPredictedWh: number, mae: number, rmse: number}>>}
 */
async function populateFromHistory({
  config,
  baseUrl,
  token,
  provider,
  from,
  to,
  dataDir,
  fresh = false,
  resolution = DEFAULT_RESOLUTION,
  fetchImpl = fetch,
}) {
  const socPath = config.battery?.socPath || DEFAULT_SOC_PATH;
  const arrays = (config.solarArrays || []).filter(
    (a) => a.enabled !== false && a.powerPath,
  );

  const seeded = new Map();
  if (!fresh) {
    for (const [id, m] of (
      await matrixPersistence.loadAllMatrices(dataDir)
    ).map((m) => [m.arrayId, m])) {
      seeded.set(id, m);
    }
  } else {
    // Wipe existing matrices so the EMA runs once over the full window
    for (const array of arrays) {
      try {
        await matrixPersistence.deleteMatrix(dataDir, array.id);
      } catch (_error) {
        // File may not exist; ignore
      }
    }
  }
  const generators = (config.mechanicalGenerators || [])
    .filter((g) => g.enabled !== false && g.powerPath)
    .map((g) => ({
      ...g,
      curve: Array.isArray(g.curve)
        ? g.curve
        : parseManufacturerCurve(g.manufacturerCurve),
    }));

  // One /values query for everything: array + generator power, SoC, nav
  // state, AWA, speed through water, house load (DC + AC for the load
  // profile replay)
  const queryPaths = Array.from(
    new Set([
      ...arrays.map((a) => a.powerPath),
      ...arrays
        .map((a) => a.controllerModePath)
        .filter((p) => typeof p === "string" && p.length > 0),
      ...generators.map((g) => g.powerPath),
      socPath,
      ...CONTEXT_PATHS,
      // Measured gust source: there is no environment.wind.gust sensor, so
      // the gust is taken as the max of true wind speed over each resolution
      // bucket (History API :max aggregate).
      "environment.wind.speedTrue:max",
      "electrical.venus.dcPower",
      "electrical.venus.acPower",
    ]),
  );

  // Discover propulsion instances (main/port/starboard/...) once; if the
  // discovery endpoint is unavailable, engine gating degrades to unknown
  let discoveredPropulsionPaths = [];
  try {
    discoveredPropulsionPaths = await discoverPropulsionPaths({
      baseUrl,
      token,
      provider,
      from,
      to,
      fetchImpl,
    });
  } catch (_error) {
    // Leave empty: engineRunning will be null (unknown) during replay
  }

  // History first (synchronously): we need vessel positions to fetch
  // weather along the track
  const historyData = await queryHistory({
    baseUrl,
    token,
    provider,
    from,
    to,
    paths: [...queryPaths, ...discoveredPropulsionPaths],
    resolution,
    fetchImpl,
  });

  // Vessel state map: walk history forward, carrying every value forward
  // (sticky nav/position/propulsion AND continuous power/stw/soc/house
  // load) so downstream consumers — matrix/generator/load/WPF replay and
  // the sample writer — all read the same carried-forward state. Mirrors
  // the live deltaState Map: different sensors publish at different
  // intervals, so a bucket where a sensor didn't report keeps the
  // last-known value. This replaces the old carryForwardSticky mutation.
  const columns = pathColumns(historyData);
  const navStateColumn = columns.get("navigation.state");
  const positionColumn = columns.get("navigation.position");
  const stwColumn = columns.get("navigation.speedThroughWater");
  const propulsionCols = propulsionColumns(historyData);
  const houseLoadColumn = columns.get("electrical.venus.dcPower");
  const socColumn = columns.get(socPath);
  const arrayColumns = new Map(
    arrays
      .map((a) => [a.id, columns.get(a.powerPath)])
      .filter(([, col]) => col != null),
  );
  const generatorColumns = new Map(
    generators
      .map((g) => [g.id, columns.get(g.powerPath)])
      .filter(([, col]) => col != null),
  );
  const carried = buildCarriedState(
    historyData,
    columns,
    navStateColumn,
    stwColumn,
    propulsionCols,
    arrayColumns,
    generatorColumns,
    socColumn,
    houseLoadColumn,
    positionColumn,
  );
  // Write carried nav/position/propulsion back into historyData so the
  // replay functions (which read columns directly) see carried-forward
  // sticky values without each one re-implementing carry-forward.
  writeCarriedStickyBack(historyData, columns, carried);

  const dailyPositions = dailyPositionsFromHistory(historyData, from, to);
  const weather =
    dailyPositions.length > 0
      ? await fetchHistoricalWeatherTrack({ dailyPositions, fetchImpl })
      : [];

  const results = [];
  const matrices = [];

  for (const array of arrays) {
    const matrix = seeded.has(array.id)
      ? SolarMatrix.fromJSON(seeded.get(array.id))
      : new SolarMatrix(array.id);

    const stats = replayHistory({
      matrix,
      array,
      socPath,
      historyData,
      weather,
      resolution,
    });

    matrices.push(matrix.toJSON());
    results.push({ arrayId: array.id, seeded: seeded.has(array.id), ...stats });
  }

  if (matrices.length > 0) {
    await matrixPersistence.saveMatrices(dataDir, matrices);
  }

  // Mechanical generators: validation stats only (no learning model)
  const generatorResults = replayGenerators({
    generators,
    historyData,
    weather,
    resolution,
  });

  // Replay history through the load profile so the sun-phase EMA bins are
  // seeded (otherwise the forecast house load stays flat until enough live
  // samples accumulate). Load the existing profile to build on it, or start
  // fresh under --fresh. Falls back to the config's loadProfile section.
  const loadProfile = new LoadProfile({
    config: config.loadProfile || {},
    getSelfPath: () => undefined,
    app: undefined,
  });
  let loadProfileSeeded = false;
  if (!fresh) {
    try {
      loadProfileSeeded = await matrixPersistence.loadLoadProfile(
        dataDir,
        loadProfile,
      );
    } catch (_error) {
      // No existing profile: start fresh
    }
  }
  // Uncounted charging sources (wind, hydro) whose output flows through the
  // battery shunt but is NOT added back into dcPower by Venus (unlike solar).
  // Adding them back reconstructs gross house consumption for the bins.
  // Alternator is excluded: it only produces while motoring, and those
  // samples are gated as engine-running before reaching the bins anyway.
  const uncountedChargingPaths = generators
    .filter((g) => g.type === "wind" || g.type === "hydro")
    .map((g) => g.powerPath);

  const loadProfileStats = replayLoadProfile({
    loadProfile,
    historyData,
    resolution,
    uncountedChargingPaths,
  });
  await matrixPersistence.saveLoadProfile(dataDir, loadProfile);

  // Replay history through the Wind Protection Factor store so the
  // per-place/per-sector EMAs are seeded from past anchorages (otherwise
  // a revisited anchorage starts at factor 1.0 until enough live samples
  // accumulate). Seed from disk to build on the live EMA, or start fresh
  // under --fresh. Only runs when windProtection is enabled in config.
  let windProtection = null;
  let windProtectionSeeded = false;
  let windProtectionStats = null;
  if (config.windProtection?.enabled !== false) {
    const wpfConfig = config.windProtection || {};
    windProtection = new WindProtectionStore({
      alpha: wpfConfig.emaAlpha,
      maxPlaces: wpfConfig.maxPlaces,
      learnGusts: wpfConfig.learnGusts !== false,
      minForecastWindKnots: wpfConfig.minForecastWindKnots,
    });
    if (!fresh) {
      try {
        const saved = await matrixPersistence.loadWindProtection(dataDir);
        if (saved) {
          windProtection = WindProtectionStore.fromJSON(saved);
          windProtectionSeeded = true;
        }
      } catch (_error) {
        // No existing store: start fresh
      }
    }
    windProtectionStats = replayWindProtection({
      store: windProtection,
      config,
      historyData,
      weather,
      resolution,
    });
    await matrixPersistence.saveWindProtection(
      dataDir,
      windProtection.toJSON(),
    );
  }

  // Seed recordings with pre-install actuals (gap-fill merge: live
  // samples win, replayed ticks only fill the holes)
  const samplesWritten = await backfillSamples({
    app: { debug() {} },
    dataDir,
    historyData,
    weather,
    arrays,
    generators,
    socPath,
    from,
    to,
    carried,
  });

  // Backfill deploy/stow states onto existing samples that predate the
  // deployStates field (or were gap-fill-skipped above). Live samples for
  // the window already exist, so backfillSamples skipped them; this pass
  // recomputes deployStates from each sample's own power/wind/nav data and
  // rewrites the file in place. Carry-forward of the last known state
  // across unknown gaps is applied at read time (API), so the raw
  // per-sample inference is stored here.
  const deployStatesBackfilled = await augmentSamplesDeployStates({
    app: { debug() {} },
    dataDir,
    arrays,
    generators,
    from,
    to,
  });

  return {
    arrays: results,
    generators: generatorResults,
    samplesWritten,
    deployStatesBackfilled,
    loadProfile: {
      seeded: loadProfileSeeded,
      ...loadProfileStats,
      learnedBins: loadProfile.learnedBins().length,
    },
    windProtection:
      windProtection == null
        ? null
        : {
            seeded: windProtectionSeeded,
            ...windProtectionStats,
          },
  };
}

/** Tolerance for considering two samples the same moment */
const SAMPLE_MERGE_TOLERANCE_MS = 150000;

/**
 * Walks history points forward, carrying every value forward in a vessel
 * state map (mirrors the live `deltaState` Map). Sticky signals
 * (navigation.state, navigation.position, propulsion.*.state) and continuous
 * measurements (array/generator power, SoC, house load, STW) all persist
 * from the last bucket that reported them, so a bucket where a sensor
 * didn't report still sees the last-known value — exactly like the live
 * delta handler, where a wind generator that read 0 W stays 0 W until a
 * new reading arrives.
 *
 * The carried state is what deploy-state detection reads; without it, gaps
 * suppress the "stowed" transition (power reads null → unknown) and the
 * carry-forward at read time (API) can't recover the lost transition.
 *
 * @param {object} historyData - History API /values response
 * @param {Map<string, number>} columns - path -> column index
 * @param {number|null} navStateColumn
 * @param {number|null} stwColumn
 * @param {Array} propulsionCols
 * @param {Map<string, number|null>} arrayColumns - id -> column index
 * @param {Map<string, number|null>} generatorColumns - id -> column index
 * @param {number|null} socColumn
 * @param {number|null} houseLoadColumn
 * @param {number|null} positionColumn
 * @returns {Array<object>} Per-point carried state, aligned with historyData.data
 */
function buildCarriedState(
  historyData,
  columns,
  navStateColumn,
  stwColumn,
  propulsionCols,
  arrayColumns,
  generatorColumns,
  socColumn,
  houseLoadColumn,
  positionColumn,
) {
  const points = historyData.data || [];
  const out = [];
  // Carry-forward accumulators
  let lastNav = null; // last explicit navigation.state
  let lastPos = null; // {longitude, latitude}
  let lastStw = null; // m/s
  let lastSoc = null;
  let lastHouseLoad = null;
  const lastArrayPower = new Map(); // id -> W
  const lastGenPower = new Map(); // id -> W
  for (const point of points) {
    // navState: explicit wins, else carry forward, else infer from STW
    const explicitNav = columnValue(point, navStateColumn);
    let navState;
    if (
      explicitNav === "sailing" ||
      explicitNav === "motoring" ||
      explicitNav === "anchored" ||
      explicitNav === "moored" ||
      explicitNav === "docked" ||
      explicitNav === "under way"
    ) {
      navState = explicitNav;
      lastNav = explicitNav;
    } else if (lastNav) {
      navState = lastNav;
    } else {
      const r = inferNavState(
        point,
        navStateColumn,
        stwColumn,
        propulsionCols,
        columns,
        null,
      );
      navState = r.state;
      if (r.explicit) lastNav = r.state;
    }
    // position: carry forward (sticky)
    const posRaw = columnValue(point, positionColumn);
    if (Array.isArray(posRaw) && posRaw.length >= 2) {
      lastPos = { longitude: posRaw[0], latitude: posRaw[1] };
    }
    // stw: carry forward (continuous but last-known is better than null)
    const stwRaw = columnNumber(point, stwColumn);
    if (stwRaw != null) lastStw = stwRaw;
    // soc, houseLoad: carry forward
    const socRaw = columnNumber(point, socColumn);
    if (socRaw != null) lastSoc = socRaw;
    const houseRaw = columnNumber(point, houseLoadColumn);
    if (houseRaw != null) lastHouseLoad = houseRaw;
    // array/generator power: carry forward
    const arrayPower = {};
    for (const [id, col] of arrayColumns) {
      const v = columnNumber(point, col);
      if (v != null) lastArrayPower.set(id, v);
      if (lastArrayPower.has(id)) arrayPower[id] = lastArrayPower.get(id);
    }
    const generatorPower = {};
    for (const [id, col] of generatorColumns) {
      const v = columnNumber(point, col);
      if (v != null) lastGenPower.set(id, v);
      if (lastGenPower.has(id)) generatorPower[id] = lastGenPower.get(id);
    }
    out.push({
      navState,
      position: lastPos,
      stwKnots: lastStw != null ? lastStw / 0.514444 : null,
      soc: lastSoc,
      houseLoadW: lastHouseLoad,
      arrayPower,
      generatorPower,
    });
  }
  return out;
}

/**
 * Writes the carried-forward sticky signals (navigation.state,
 * navigation.position, propulsion.*.state) back into the history data array
 * in place, so replay functions that read columns directly see carried-
 * forward values. Continuous measurements (power, SoC, STW) are NOT
 * written back — replay functions read those from the raw columns and only
 * the sample writer uses the full carried state for deploy detection.
 *
 * @param {object} historyData - History API /values response (mutated)
 * @param {Map<string, number>} columns - path -> column index
 * @param {Array<object>} carried - Per-point carried state from buildCarriedState
 * @returns {void}
 */
function writeCarriedStickyBack(historyData, columns, carried) {
  const navStateColumn = columns.get("navigation.state");
  const positionColumn = columns.get("navigation.position");
  const stickyPropulsionCols = [];
  for (const [path, col] of columns) {
    if (PROPULSION_STATE_RE.test(path)) stickyPropulsionCols.push([path, col]);
  }
  const points = historyData.data || [];
  for (let i = 0; i < points.length; i++) {
    const st = carried[i];
    if (!st) continue;
    if (navStateColumn != null && st.navState != null) {
      points[i][navStateColumn] = st.navState;
    }
    if (positionColumn != null && st.position) {
      points[i][positionColumn] = [st.position.longitude, st.position.latitude];
    }
  }
  // Propulsion states are already carried by the same logic buildCarriedState
  // uses for nav; but buildCarriedState doesn't track them separately. Use the
  // simple last-known carry for propulsion state columns (they're sticky).
  if (stickyPropulsionCols.length > 0) {
    const last = new Map();
    for (const point of points) {
      for (const [, col] of stickyPropulsionCols) {
        const v = point[col];
        if (v != null) last.set(col, v);
        else if (last.has(col)) point[col] = last.get(col);
      }
    }
  }
}

/**
 * Writes replayed history into the recordings store as `sample` records,
 * skipping ticks where a live recording already exists (gap-fill merge —
 * live samples win).
 *
 * @param {object} params
 * @param {object} params.app - Logger (for recorder)
 * @param {string} params.dataDir - Plugin data directory
 * @param {object} params.historyData - History API /values response
 * @param {Array<object>} params.weather - Historical weather points
 * @param {object[]} params.arrays - Solar array configs
 * @param {object[]} params.generators - Generator configs (parsed curves)
 * @param {string} params.socPath - SoC path
 * @param {Date} params.from - Window start
 * @param {Date} params.to - Window end
 * @returns {Promise<number>} Number of samples written
 */
async function backfillSamples({
  app,
  dataDir,
  historyData,
  weather,
  arrays,
  generators,
  socPath,
  from,
  to,
  carried,
}) {
  // Existing live samples: skip any replayed tick near one of these
  const existing = await recorderModule.getRecordings(
    dataDir,
    from,
    to,
    "sample",
  );
  const existingTimes = existing
    .map((s) => new Date(s.timestamp).getTime())
    .sort((a, b) => a - b);
  const nearLiveSample = (t) => {
    // Binary search for the closest live sample
    let lo = 0;
    let hi = existingTimes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (existingTimes[mid] < t) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    for (const idx of [hi, lo]) {
      if (idx >= 0 && idx < existingTimes.length) {
        if (Math.abs(existingTimes[idx] - t) <= SAMPLE_MERGE_TOLERANCE_MS) {
          return true;
        }
      }
    }
    return false;
  };

  const columns = pathColumns(historyData);

  // `carried` is the vessel state map built once in populateFromHistory
  // and passed in. It carries every value forward (sticky nav/position /
  // propulsion AND continuous power/stw/soc) so each bucket's deploy-state
  // detection sees the last-known reading when a sensor didn't report —
  // mirroring the live deltaState map. Different sensors publish at
  // different intervals, so a bucket where a sensor was silent keeps the
  // last-known value. When not passed (standalone/test use), compute it.
  const navStateColumn = columns.get("navigation.state");
  const positionColumn = columns.get("navigation.position");
  const stwColumn = columns.get("navigation.speedThroughWater");
  const propulsionCols = propulsionColumns(historyData);
  const houseLoadColumn = columns.get("electrical.venus.dcPower");
  const socColumn = columns.get(socPath);
  const arrayColumns = new Map(
    arrays
      .map((a) => [a.id, columns.get(a.powerPath)])
      .filter(([, col]) => col != null),
  );
  // Per-array charge controller mode columns (string enums; :last method).
  // Used to record controllerModes on gap-filled samples so offline eval can
  // apply the bulk-only learning gate.
  const controllerModeColumns = new Map(
    arrays
      .map((a) => [
        a.id,
        a.controllerModePath ? columns.get(a.controllerModePath) : null,
      ])
      .filter(([, col]) => col != null),
  );
  const awaColumn = columns.get("environment.wind.angleApparent");
  const generatorColumns = new Map(
    generators
      .map((g) => [g.id, columns.get(g.powerPath)])
      .filter(([, col]) => col != null),
  );
  const carriedState =
    carried ||
    buildCarriedState(
      historyData,
      columns,
      navStateColumn,
      stwColumn,
      propulsionCols,
      arrayColumns,
      generatorColumns,
      socColumn,
      houseLoadColumn,
      positionColumn,
    );

  // Overwrite sticky fields (navState, position) on existing live samples
  // from the carried vessel state map. The live delta stream flaps these
  // sticky signals (e.g. anchored ↔ moored); the History API :last
  // aggregate is stable, so history wins for sticky fields even over
  // existing live samples, while continuous measurements stay as recorded.
  const carriedTimes = (historyData.data || []).map((p) =>
    parseUtcTimestamp(p[0]).getTime(),
  );
  if (carriedState.length > 0) {
    const resolveSticky = (tsMs) => {
      // Latest history point at or before tsMs (sticky carry-forward)
      let lo = 0;
      let hi = carriedTimes.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (carriedTimes[mid] <= tsMs) {
          idx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (idx < 0) {
        // Before first history point: use the earliest (state continuity)
        return {
          navState: carriedState[0].navState,
          position: carriedState[0].position,
        };
      }
      return {
        navState: carriedState[idx].navState,
        position: carriedState[idx].position,
      };
    };
    await recorderModule.overwriteStickyFields(
      app,
      dataDir,
      from,
      to,
      resolveSticky,
    );
  }

  let written = 0;
  const dataPoints = historyData.data || [];
  for (let i = 0; i < dataPoints.length; i++) {
    const point = dataPoints[i];
    const st = carriedState[i];
    const time = parseUtcTimestamp(point[0]);
    if (nearLiveSample(time.getTime())) {
      continue;
    }

    const weatherPoint = interpolateWeather(weather, time);
    // Per-array charge controller mode at this tick (carried-forward via
    // the :last aggregate; null where the array has no mode path).
    const controllerModes = {};
    for (const [id, col] of controllerModeColumns) {
      const mode = columnValue(point, col);
      if (mode != null) controllerModes[id] = mode;
    }
    // Apparent wind angle (radians) for the sailing matrix. Read raw from
    // the bucket; the live recorder stores the raw delta value the same way.
    const awaRad = columnNumber(point, awaColumn);
    const sample = {
      timestamp: time,
      arrays: st.arrayPower,
      generators: st.generatorPower,
      soc: st.soc,
      houseLoadW: st.houseLoadW,
      // Wind comes from weather interpolation (continuous), not history carry-forward
      windSpeedKnots: weatherPoint.windSpeedKnots,
      navState: st.navState,
      position: st.position,
      stwKnots: st.stwKnots,
      controllerModes,
      awaRad: awaRad ?? null,
    };

    // Detect deploy/stow states for deployable devices from the carried-
    // forward readings (same logic as live currentDeployStates, via the
    // shared module). Because power/wind/stw/nav are carried forward, a
    // bucket where a sensor didn't report still sees the last-known value,
    // so a wind generator that read 0 W with adequate wind stays "stowed"
    // across silent buckets instead of dropping to "unknown".
    const underway =
      sample.navState === "sailing" ||
      sample.navState === "motoring" ||
      sample.navState === "under way";
    let sunUp = false;
    if (sample.position && sample.position.latitude != null) {
      // Only treat 0 W as "stowed" when the sun is high enough that a
      // deployed panel would produce power. Near sunrise/sunset a deployed
      // panel naturally reads ~0 W.
      sunUp =
        sunPosition(
          time,
          sample.position.latitude,
          sample.position.longitude ?? 0,
        ).altitude > STOW_INFERENCE_MIN_SUN_ALT_RAD;
    }
    const deployStates = {};
    for (const array of arrays) {
      if (array.type !== "deployable") continue;
      const powerW = sample.arrays[array.id] ?? null;
      const state = detectSolarArrayState(array, {
        powerW,
        sunUp,
        underway,
      });
      if (state != null) deployStates[array.id] = state;
    }
    for (const gen of generators) {
      if (!gen.deployable) continue;
      const powerW = sample.generators[gen.id] ?? null;
      const state = detectGeneratorState(gen, {
        powerW,
        windKnots: sample.windSpeedKnots ?? null,
        stwKnots: sample.stwKnots,
        navState: sample.navState,
        underway,
      });
      if (state != null) deployStates[gen.id] = state;
    }
    sample.deployStates = deployStates;

    await recorderModule.recordSample(app, dataDir, sample);
    written++;
  }

  return written;
}

/**
 * Augments existing sample records that lack a `deployStates` field by
 * recomputing it from each sample's own power/wind/nav/stw/position data
 * using the shared deploy-state detector, then rewriting the recording
 * file in place.
 *
 * This backfills the detected-state field onto samples written before the
 * field existed (and onto live samples that `backfillSamples` gap-fill
 * skipped). It reuses the same inference as live `recordSample` and the
 * replayed-tick path, so detected timelines are consistent across the
 * whole window.
 *
 * @param {object} params
 * @param {object} params.app - Signal K server API (for logging)
 * @param {string} params.dataDir - Plugin data directory
 * @param {object[]} params.arrays - Active solar array configs
 * @param {object[]} params.generators - Active generator configs
 * @param {Date} params.from - Window start
 * @param {Date} params.to - Window end
 * @returns {Promise<number>} Number of sample records augmented
 */
async function augmentSamplesDeployStates({
  app,
  dataDir,
  arrays,
  generators,
  from,
  to,
}) {
  const samples = await recorderModule.getRecordings(
    dataDir,
    from,
    to,
    "sample",
  );
  if (samples.length === 0) return 0;

  // Sort all samples in time order so carry-forward is continuous across days.
  samples.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Walk forward carrying power/wind/stw/nav across gaps, mirroring the live
  // deltaState map and buildCarriedState. A sensor that didn't report in a
  // 5-min bucket keeps the last-known value, so deploy-state detection sees
  // a wind generator that read 0 W as still 0 W (stowed) rather than unknown.
  let lastNav = null;
  let lastWind = null;
  let lastStw = null;
  const lastArrayPower = new Map();
  const lastGenPower = new Map();
  const computed = new Map(); // ts -> deployStates
  for (const sample of samples) {
    const navState = sample.navState || lastNav || "unknown";
    if (sample.navState) lastNav = sample.navState;
    const windKnots =
      sample.windSpeedKnots != null ? sample.windSpeedKnots : lastWind;
    if (sample.windSpeedKnots != null) lastWind = sample.windSpeedKnots;
    const stwKnots = sample.stwKnots != null ? sample.stwKnots : lastStw;
    if (sample.stwKnots != null) lastStw = sample.stwKnots;
    const arraysPower = sample.arrays || {};
    const gensPower = sample.generators || {};
    for (const array of arrays) {
      if (arraysPower[array.id] != null) {
        lastArrayPower.set(array.id, arraysPower[array.id]);
      }
    }
    for (const gen of generators) {
      if (gensPower[gen.id] != null) {
        lastGenPower.set(gen.id, gensPower[gen.id]);
      }
    }
    const underway =
      navState === "sailing" ||
      navState === "motoring" ||
      navState === "under way";
    const pos = sample.position;
    let sunUp = false;
    if (pos && pos.latitude != null) {
      // Only treat 0 W as "stowed" when the sun is high enough that a
      // deployed panel would produce power. Near sunrise/sunset a deployed
      // panel naturally reads ~0 W.
      sunUp =
        sunPosition(
          new Date(sample.timestamp),
          pos.latitude,
          pos.longitude ?? 0,
        ).altitude > STOW_INFERENCE_MIN_SUN_ALT_RAD;
    }
    const deployStates = {};
    for (const array of arrays) {
      if (array.type !== "deployable") continue;
      const powerW = lastArrayPower.has(array.id)
        ? lastArrayPower.get(array.id)
        : null;
      const state = detectSolarArrayState(array, {
        powerW,
        sunUp,
        underway,
      });
      if (state != null) deployStates[array.id] = state;
    }
    for (const gen of generators) {
      if (!gen.deployable) continue;
      const powerW = lastGenPower.has(gen.id) ? lastGenPower.get(gen.id) : null;
      const state = detectGeneratorState(gen, {
        powerW,
        windKnots,
        stwKnots,
        navState,
        underway,
      });
      if (state != null) deployStates[gen.id] = state;
    }
    computed.set(new Date(sample.timestamp).getTime(), deployStates);
  }

  // Group by recording file so each file is rewritten once.
  const byFile = new Map(); // filePath -> sample[]
  for (const s of samples) {
    const filePath = recorderModule.getRecordingsPath(
      dataDir,
      new Date(s.timestamp),
    );
    if (!byFile.has(filePath)) byFile.set(filePath, []);
    byFile.get(filePath).push(s);
  }

  let augmented = 0;
  for (const [filePath, fileSamples] of byFile) {
    // Read all lines (including non-sample records) to rewrite the file.
    let lines;
    try {
      lines = (await fs.readFile(filePath, "utf-8")).split("\n");
    } catch (_error) {
      continue; // file may have been pruned
    }
    const byTimestamp = new Map(
      fileSamples.map((s) => [new Date(s.timestamp).getTime(), s]),
    );
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type !== "sample") continue;
      const ts = new Date(record.timestamp).getTime();
      if (!byTimestamp.has(ts)) continue;
      if (record.deployStates && Object.keys(record.deployStates).length) {
        // Already has deployStates. Recompute to stay consistent with the
        // current detection logic (the live recording may have used an
        // older inference — e.g. 0 W near sunset was once "stowed"). The
        // carried-forward power at this timestamp is the same the live path
        // saw, so the result is at least as good and uses the latest rules.
        const fresh = computed.get(ts) || {};
        if (JSON.stringify(fresh) !== JSON.stringify(record.deployStates)) {
          record.deployStates = fresh;
          changed = true;
        }
        continue;
      }
      const deployStates = computed.get(ts) || {};
      record.deployStates = deployStates;
      lines[i] = JSON.stringify(record);
      changed = true;
      augmented++;
    }
    if (changed) {
      await fs.writeFile(filePath, lines.join("\n"), { encoding: "utf-8" });
    }
  }
  app.debug?.(`Augmented ${augmented} samples with deployStates`);
  return augmented;
}

/**
 * Maps an inferred nav state string to a LoadProfile state class.
 *
 * Mirrors LoadProfile.getStateClass() but for historical replay where the
 * nav state comes from the history API rather than the live Signal K path.
 *
 * @param {string} navState - Inferred nav state (sailing/motoring/anchored/moored/docked)
 * @returns {string} StateClass.UNDERWAY or StateClass.AT_REST
 */
function stateClassFromNavState(navState) {
  return ["sailing", "motoring", "under way"].includes(navState)
    ? StateClass.UNDERWAY
    : StateClass.AT_REST;
}

/**
 * Replays history through the load profile, populating the sun-phase EMA
 * bins in place.
 *
 * Unlike addSample() (which reads the live nav state, engine state, and
 * shore-power state), this classifies each historical tick from the
 * history record itself: sun phase from the tick timestamp + position,
 * state class from the inferred nav state, and the engine-running gate
 * from the propulsion columns. Shore power isn't in the history query, so
 * it's treated as not connected during replay.
 *
 * Ticks with no DC or AC load reading are skipped (nothing to learn).
 *
 * @param {object} params
 * @param {object} params.loadProfile - LoadProfile instance to update (in place)
 * @param {object} params.historyData - History API /values response
 * @param {number} [params.resolution] - Sample resolution in seconds
 * @returns {{dataPoints: number, ingested: number, gated: number}}
 */
function replayLoadProfile({
  loadProfile,
  historyData,
  resolution = DEFAULT_RESOLUTION,
  uncountedChargingPaths = [],
}) {
  const columns = pathColumns(historyData);
  const dcColumn = columns.get("electrical.venus.dcPower");
  const acColumn = columns.get("electrical.venus.acPower");
  const navStateColumn = columns.get("navigation.state");
  const positionColumn = columns.get("navigation.position");
  const stwColumn = columns.get("navigation.speedThroughWater");
  const propulsionCols = propulsionColumns(historyData);
  // Charging-source power columns whose output flows through the battery
  // shunt but is NOT added back into dcPower (wind, hydro, alternator).
  // Venus computes dcPower = shunt + solar, so these uncounted chargers
  // make dcPower understate real consumption when they produce. Adding
  // them back reconstructs gross house load for the load-profile bins.
  const chargingColumns = uncountedChargingPaths
    .map((p) => columns.get(p))
    .filter((c) => c != null);

  let dataPoints = 0;
  let ingested = 0;
  let gated = 0;
  /** Last explicit navigation.state, carried forward across gaps */
  let lastExplicitNavState = null;

  for (const point of historyData.data || []) {
    const time = parseUtcTimestamp(point[0]);
    const dcLoadW = columnNumber(point, dcColumn);
    const acLoadW = columnNumber(point, acColumn);
    if (dcLoadW == null && acLoadW == null) {
      continue;
    }
    dataPoints++;

    // Reconstruct gross DC consumption by adding back wind/hydro/alternator
    // charging (they flow through the shunt but Venus doesn't add them to
    // dcPower, unlike solar which is already added back).
    let chargingW = 0;
    for (const c of chargingColumns) {
      const v = columnNumber(point, c);
      if (v != null) chargingW += v;
    }
    const grossDc = (dcLoadW ?? 0) + chargingW;

    const navStateResult = inferNavState(
      point,
      navStateColumn,
      stwColumn,
      propulsionCols,
      columns,
      lastExplicitNavState,
    );
    if (navStateResult.explicit) {
      lastExplicitNavState = navStateResult.state;
    }
    const stateClass = stateClassFromNavState(navStateResult.state);

    const posValue = columnValue(point, positionColumn);
    const position =
      Array.isArray(posValue) && posValue.length >= 2
        ? { longitude: posValue[0], latitude: posValue[1] }
        : null;

    const gate = loadProfile.ingestSample({
      time,
      dcLoadW: Math.max(0, grossDc),
      acLoadW: Math.max(0, acLoadW ?? 0),
      position,
      stateClass,
      engineRunning: engineRunningAt(point, propulsionCols, columns),
      // Shore power isn't queried from history; treat as absent during replay
      shorePowerConnected: false,
    });

    if (gate) {
      gated++;
    } else {
      ingested++;
    }
  }

  return { dataPoints, ingested, gated };
}

/**
 * Replays history through the Wind Protection Factor store.
 *
 * For each resolution bucket where the vessel was at rest (anchored or
 * moored) and dwelled long enough in a place cell, the measured wind
 * (height-normalized to the 10 m forecast reference) is compared against
 * the interpolated archive weather and the per-(place, sector) EMA is
 * updated. Gusts are learned when both a measured gust and a forecast gust
 * are present.
 *
 * The store is seeded from disk so backfill continues from the live EMA,
 * unless `fresh` is set by the caller (handled in populateFromHistory).
 *
 * @param {object} params
 * @param {WindProtectionStore} params.store - WPF store (mutated in place)
 * @param {object} params.config - Plugin configuration (windProtection block)
 * @param {object} params.historyData - History API /values response
 * @param {Array} params.weather - Archive weather track (from
 *        fetchHistoricalWeatherTrack)
 * @param {number} [params.resolution=DEFAULT_RESOLUTION] - Bucket seconds
 * @returns {{dataPoints: number, samples: number, skippedUnderway: number,
 *          skippedDwell: number, places: number}}
 */
function replayWindProtection({
  store,
  config,
  historyData,
  weather,
  resolution = DEFAULT_RESOLUTION,
}) {
  const columns = pathColumns(historyData);
  const navStateColumn = columns.get("navigation.state");
  const stwColumn = columns.get("navigation.speedThroughWater");
  const propulsionCols = propulsionColumns(historyData);
  const positionColumn = columns.get("navigation.position");
  const speedTrueColumn = columns.get("environment.wind.speedTrue");
  const speedApparentColumn = columns.get("environment.wind.speedApparent");
  // Measured gust source: there is no environment.wind.gust sensor, so the
  // gust is the max of true wind speed over the resolution bucket (History
  // API :max aggregate, requested as environment.wind.speedTrue:max).
  const gustMaxColumn = columnFor(columns, "environment.wind.speedTrue", "max");
  const directionTrueColumn = columns.get("environment.wind.directionTrue");

  const cfg = config?.windProtection || {};
  const cellSizeM = cfg.cellSizeM ?? 500;
  const dwellMinutes = cfg.dwellMinutes ?? 15;
  const anemometerHeightM =
    cfg.anemometerHeightM && cfg.anemometerHeightM > 0
      ? cfg.anemometerHeightM
      : DEFAULT_ANEMOMETER_HEIGHT_M;
  const z0 = cfg.roughnessLength ?? DEFAULT_ROUGHNESS_LENGTH;

  let dataPoints = 0;
  let samples = 0;
  let skippedUnderway = 0;
  let skippedDwell = 0;
  let lastExplicitNavState = null;

  /** Pinned place key for the current at-rest session. */
  let currentPlace = null;
  let arrivedAt = null;
  const bucketMs = resolution * 1000;
  const dwellMs = dwellMinutes * 60000;

  for (const point of historyData.data || []) {
    const time = parseUtcTimestamp(point[0]);
    if (time == null) continue;

    const navStateResult = inferNavState(
      point,
      navStateColumn,
      stwColumn,
      propulsionCols,
      columns,
      lastExplicitNavState,
    );
    if (navStateResult.explicit) {
      lastExplicitNavState = navStateResult.state;
    }
    const navState = navStateResult.state;
    if (navState !== "anchored" && navState !== "moored") {
      // Leaving rest resets the dwell window
      currentPlace = null;
      arrivedAt = null;
      skippedUnderway++;
      continue;
    }

    // Position (required for the place cell)
    const posValue = columnValue(point, positionColumn);
    if (!Array.isArray(posValue) || posValue.length < 2) continue;
    const lat = posValue[1];
    const lon = posValue[0];
    if (lat == null || lon == null) continue;

    // Resolve the anchorage for the current bucket. resolvePlace matches
    // to the nearest known anchorage within the match radius, so a swing
    // on the anchor (or a nearby re-drop / marina relocation) keeps the
    // same key, while a real relocation beyond the match radius (e.g. the
    // state flipping to moored during an approach, then moving 1.5 km to
    // the slip) resolves to a different key and restarts the dwell window.
    const key = store.resolvePlace(lat, lon, cellSizeM);

    // Dwell gating: reset when the resolved place changes; only learn after
    // the boat has been at this anchorage long enough to settle.
    if (currentPlace !== key) {
      currentPlace = key;
      // The first bucket of a new place starts the dwell clock; we don't
      // know precisely when the boat arrived within that bucket, so we
      // start the clock at the bucket timestamp.
      arrivedAt = time.getTime();
      continue;
    }
    if (arrivedAt == null || time.getTime() - arrivedAt < dwellMs) {
      skippedDwell++;
      continue;
    }

    // Measured wind. Prefer true wind (current can bias apparent at
    // anchor), then apparent, then over-ground-ish (not in history here).
    const measuredMs =
      columnNumber(point, speedTrueColumn) ??
      columnNumber(point, speedApparentColumn);
    if (measuredMs == null || !isFinite(measuredMs)) continue;
    const measuredKnots = measuredMs * MS_TO_KN;

    // Measured gust (optional): max of true wind speed over the bucket.
    // Fall back to the average true speed when no :max column was returned.
    const gustMs =
      columnNumber(point, gustMaxColumn) ??
      columnNumber(point, speedTrueColumn);
    const measuredGustKnots =
      gustMs != null && isFinite(gustMs) ? gustMs * MS_TO_KN : null;

    // Forecast for this bucket
    const wx = interpolateWeather(weather, time);
    const forecastSpeed = wx.windSpeedKnots;
    const forecastGust = wx.gustSpeedKnots;
    // Forecast direction is degrees; fall back to the measured SK
    // directionTrue (radians) when the forecast lacks it
    let dirDeg = wx.windDirectionDeg;
    if (dirDeg == null) {
      const dirRad = columnNumber(point, directionTrueColumn);
      if (dirRad != null && isFinite(dirRad)) {
        dirDeg = (dirRad * 180) / Math.PI;
      }
    }
    if (forecastSpeed == null) continue;

    // Height-normalize the measured reading to the 10 m reference
    const measured10m = toForecastReference(
      measuredKnots,
      anemometerHeightM,
      z0,
    );
    const measuredGust10m =
      measuredGustKnots != null
        ? toForecastReference(measuredGustKnots, anemometerHeightM, z0)
        : null;

    const sector = sectorFromDeg(dirDeg);
    const { altitude } = sunPosition(time, lat, lon);
    const night = wpfIsNight(altitude);

    const updated = store.learn({
      placeKey: currentPlace,
      sector,
      night,
      measuredSpeed: measured10m,
      forecastSpeed,
      measuredGust: measuredGust10m,
      forecastGust,
    });

    dataPoints++;
    if (updated) samples++;
  }

  return {
    dataPoints,
    samples,
    skippedUnderway,
    skippedDwell,
    places: store.sizePlaces,
  };
}

module.exports = {
  DEFAULT_RESOLUTION,
  DEFAULT_SOC_PATH,
  discoverPropulsionPaths,
  historyHeaders,
  queryHistory,
  fetchHistoricalWeather,
  fetchHistoricalWeatherTrack,
  dailyPositionsFromHistory,
  interpolateWeather,
  buildCarriedState,
  replayHistory,
  replayGenerators,
  replayLoadProfile,
  replayWindProtection,
  backfillSamples,
  populateFromHistory,
};
