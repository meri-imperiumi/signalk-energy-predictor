/**
 * Replays remote Signal K History API data through the learning matrices.
 *
 * Shared by the backtesting CLI (sandboxed matrix, validation only) and the
 * populate mode (seeds and persists the live learning matrices).
 *
 * @file history-backfill.js
 */

const { SolarMatrix, theoreticalPower } = require("./learning.js");
const { sunPosition, irradianceFromCloudCover } = require("./solar.js");
const { predictWindHour, predictHydroHour } = require("./prediction.js");
const matrixPersistence = require("./matrix.js");
const { parseManufacturerCurve } = require("./schema.js");
const recorderModule = require("./recorder.js");

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
  // Textual paths (e.g. navigation.state, propulsion.*.state) cannot be
  // averaged — the default method returns 0 rows for strings. Use :last
  // for these so enum values come through. The API reports the method
  // back in values[].method and strips it from values[].path, so
  // pathColumns maps by the bare path unchanged.
  const queryPaths = paths.map((p) =>
    p.endsWith(".state") && !p.includes(":") ? `${p}:last` : p,
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
    columns.set(valueDef.path, i + 1);
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
        controllerMode: null,
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
  // state, AWA, speed through water, house load
  const queryPaths = Array.from(
    new Set([
      ...arrays.map((a) => a.powerPath),
      ...generators.map((g) => g.powerPath),
      socPath,
      ...CONTEXT_PATHS,
      "electrical.venus.dcPower",
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
  });

  return { arrays: results, generators: generatorResults, samplesWritten };
}

/** Tolerance for considering two samples the same moment */
const SAMPLE_MERGE_TOLERANCE_MS = 150000;

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

  let written = 0;
  /** Last explicit navigation.state, carried forward across gaps */
  let lastExplicitNavState = null;
  for (const point of historyData.data || []) {
    const time = parseUtcTimestamp(point[0]);
    if (nearLiveSample(time.getTime())) {
      continue;
    }

    const weatherPoint = interpolateWeather(weather, time);
    const sample = {
      timestamp: time,
      arrays: {},
      generators: {},
      soc: columnNumber(point, socColumn),
      houseLoadW: columnNumber(point, houseLoadColumn),
      windSpeedKnots: weatherPoint.windSpeedKnots,
      navState: (() => {
        const r = inferNavState(
          point,
          navStateColumn,
          stwColumn,
          propulsionCols,
          columns,
          lastExplicitNavState,
        );
        if (r.explicit) {
          lastExplicitNavState = r.state;
        }
        return r.state;
      })(),
      position: (() => {
        const pos = columnValue(point, positionColumn);
        if (!Array.isArray(pos) || pos.length < 2) return null;
        return { longitude: pos[0], latitude: pos[1] };
      })(),
      stwKnots: (() => {
        const v = columnNumber(point, stwColumn);
        return v != null ? v / 0.514444 : null;
      })(),
    };
    for (const [id, col] of arrayColumns) {
      const v = columnNumber(point, col);
      if (v != null) {
        sample.arrays[id] = v;
      }
    }
    for (const [id, col] of generatorColumns) {
      const v = columnNumber(point, col);
      if (v != null) {
        sample.generators[id] = v;
      }
    }

    await recorderModule.recordSample(app, dataDir, sample);
    written++;
  }

  return written;
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
  replayHistory,
  replayGenerators,
  backfillSamples,
  populateFromHistory,
};
