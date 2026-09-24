/**
 * Weather data ingestion using a 4-tier fallback FSM.
 *
 * Tiers:
 * 1. Direct NWP (Open-Meteo REST API) - shortwave_radiation
 * 2. Signal K Weather API (in-process) - cloudCover (0-1)
 * 3. Logbook (on-disk YAML store) - cloudCover (oktas 0-8)
 * 4. Clear Sky Baseline - theoretical max from sun position
 *
 * Tiers 2-3 always talk to the Signal K server the plugin runs inside:
 * tier 2 calls `app.weatherApi.getForecasts()` directly (the same object
 * the server's `/signalk/v2/api/weather` REST routes wrap) and tier 3 reads
 * signalk-logbook's YAML day files from the server's plugin data directory.
 * No loopback HTTP, ports, auth tokens or TLS involved (the previous
 * localhost-HTTP reader guessed the listen port and failed silently against
 * an unrelated service, degrading a whole offshore passage to Clear Sky).
 *
 * On a metered uplink (`network.internet.state` = `metered`) tier 1 is
 * skipped in favor of tier 2: an in-process provider read instead of a
 * volume-billed WAN download (work doc #19).
 *
 * @file ingestion.js
 */

const {
  sunPosition,
  maxIrradiance,
  irradianceFromCloudCover,
  oktasToFraction,
} = require("./solar.js");
const weatherCache = require("./weather-cache.js");
const fs = require("node:fs/promises");
const path = require("node:path");
const { parse: parseYaml } = require("yaml");

/**
 * Unwraps a Signal K path value to a number, handling both the bare number
 * (as stored in live delta state) and the wrapped `{value: number}` form
 * returned by `app.getSelfPath`. Returns null for missing/non-numeric data.
 * @param {unknown} v
 * @returns {number|null}
 */
function toNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v === "object" && typeof v.value === "number")
    return Number.isNaN(v.value) ? null : v.value;
  return null;
}

/**
 * Normalizes a Signal K wind speed (m/s) to the engine's canonical m/s,
 * or null if missing. Signal K already carries wind in m/s, so this is a
 * tolerant passthrough that handles both bare numbers and the wrapped
 * `{value: number}` form from `app.getSelfPath`.
 * @param {unknown} v
 * @returns {number|null}
 */
function toMs(v) {
  const ms = toNumber(v);
  return ms == null ? null : ms;
}

/**
 * Converts a Signal K wind direction (radians, true) to degrees, or null.
 * @param {unknown} v
 * @returns {number|null}
 */
function windDirectionDeg(v) {
  const rad = toNumber(v);
  return rad == null ? null : (rad * 180) / Math.PI;
}

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */

/**
 * Fetch timeout in milliseconds. Applies to Open-Meteo fetches and, as a
 * safety net, to in-process Weather API reads (a wedged provider must not
 * stall the prediction cycle).
 */
const FETCH_TIMEOUT = 10000;

/**
 * Races a promise against a timeout. Unlike an AbortController this cannot
 * cancel the underlying work — in-process calls have no request to abort —
 * but it keeps the FSM moving when one hangs.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label - Context for the rejection message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Open-Meteo fetch attempts (initial try + retries) before giving up.
 * Retrying matters: a single transient failure would otherwise drop the
 * FSM to lower tiers, and the clear-sky fallback carries no wind data.
 */
const OPEN_METEO_MAX_ATTEMPTS = 3;

/**
 * Base delay between Open-Meteo retry attempts in milliseconds.
 * Attempts back off linearly (1x, 2x, ...).
 */
const OPEN_METEO_RETRY_DELAY_MS = 1000;

/**
 * Default number of forecast hours to request. Override via the FSM's
 * `forecastHours` option (from the `weather.forecastHours` config).
 */
const FORECAST_HOURS = 48;

/** Maximum configurable forecast horizon in hours (matches schema) */
const MAX_FORECAST_HOURS = 168;

/**
 * How long a tier-1/tier-2 forecast (live or restored from disk) stays usable
 * as the primary in-memory source before the FSM tries to re-fetch. Sailing
 * offshore typically has Internet once per day, so the default keeps a
 * real forecast for 24 h after it was fetched (work doc #15). Tier-3/4 keep
 * the short reuse window — they are cheap to regenerate and carry no
 * forward-looking wind.
 */
const DEFAULT_FORECAST_CACHE_HOURS = 24;

/**
 * Reuse window for low-quality tiers (logbook oktas, clear sky). Short: they
 * are cheap to regenerate and carry no forward-looking wind, so there is no
 * value in caching them long. In minutes to match `getForecast`'s units.
 */
const LOW_TIER_CACHE_MINUTES = 15;

/**
 * Fetch-cadence constants driven by uplink status (work doc #15 update #1).
 * The uplink signal decides how often to *attempt* a fetch; the staleness
 * window decides whether a refresh is *eligible*. These are the *maximum*
 * attempt frequency above the 60 s `minFetchIntervalMs` floor.
 */
/** While an uplink is online, refetch at most this often (ms). */
const UPLINK_ONLINE_FETCH_INTERVAL_MS = 60 * 60 * 1000; // 1 h
/** With no uplink, probe the network at most this often (ms) — a safety net. */
const UPLINK_OFFLINE_PROBE_MS = 24 * 60 * 60 * 1000; // 24 h

/**
 * Current tier in the fallback FSM.
 * @enum {number}
 */
const Tier = {
  OPEN_METEO: 1,
  SIGNAL_K_WEATHER: 2,
  LOGBOOK: 3,
  CLEAR_SKY: 4,
};

/**
 * Weather forecast data point.
 * @typedef {{time: Date, ghi: number, cloudCover: number|null, gustSpeedMs: number|null, windSpeedMs: number|null, windDirectionDeg: number|null}} ForecastPoint
 */

/**
 * Weather source metadata.
 * @typedef {{tier: number, source: string, lastFetch: Date|null, available: boolean}} WeatherSource
 */

/**
 * Network status for fallback decision.
 * @typedef {{wanOnline: boolean}} NetworkStatus
 */

/**
 * Whether a forecast carries no weather signal at all: every hour has
 * no GHI, no wind and no gust (null or ≤ 0).
 *
 * A real forecast always has *something*: nonzero radiation in daylight
 * (Open-Meteo reports zeros for night hours, not nulls), or nonzero wind
 * in polar night. An all-zero forecast is a broken payload (observed in
 * the wild: a tier-1 "success" with 0 kn wind and 0 Wh solar for the whole
 * horizon, published and cached). Callers treat such a forecast as a
 * failed fetch so the fallback chain serves an honest degraded source
 * (stale cache, hybrid, Clear Sky) instead of confident garbage.
 *
 * The one theoretical false positive — 48 h of dead calm during polar
 * night — is not something NWP APIs produce; rejecting it only means we
 * fall to Clear Sky, which is equally uninformative there.
 *
 * @param {ForecastPoint[]|null|undefined} points
 * @returns {boolean}
 */
function isDegenerateForecast(points) {
  if (!points || points.length === 0) return false; // emptiness ≠ degenerate
  return points.every(
    (p) =>
      (p.ghi == null || p.ghi <= 0) &&
      (p.windSpeedMs == null || p.windSpeedMs <= 0) &&
      (p.gustSpeedMs == null || p.gustSpeedMs <= 0),
  );
}

/**
 * Whether a forecast still covers future hours: at least one point at or
 * after `now - pastGraceMs`. Used at three gates that must agree that a
 * forecast whose hours have all passed is not "fresh", no matter how
 * recently it was fetched or restored:
 *
 *  - `getForecast`'s in-memory cache hit (an exhausted restored forecast
 *    must not be served for the rest of its staleness window),
 *  - the live tier acceptance (a provider dataset whose newest point is
 *    hours old is a stale cache, not a forecast),
 *  - the on-disk restore (cached hours still in the future are real
 *    predictions; ones in the past are not).
 *
 * The default 30 min grace matches `runPrediction`'s forecast-point
 * matching window (a prediction hour consumes points within ±30 min), so
 * "coverage" means exactly "some hour of the coming prediction can use
 * this forecast". The tier acceptance passes a wider 2 h grace instead:
 * there the question is whether a *dataset* is current (Open-Meteo hours
 * start on the hour, so the first point of a just-fetched forecast can be
 * up to an hour old), not whether it serves this cycle.
 *
 * @param {ForecastPoint[]|null|undefined} points
 * @param {number} [nowMs]
 * @param {number} [pastGraceMs]
 * @returns {boolean}
 */
function hasFutureCoverage(points, nowMs = Date.now(), pastGraceMs = 1800000) {
  if (!points || points.length === 0) return false;
  const cutoff = nowMs - pastGraceMs;
  return points.some((p) => {
    const t =
      p.time instanceof Date ? p.time.getTime() : new Date(p.time).getTime();
    return !Number.isNaN(t) && t >= cutoff;
  });
}

/**
 * Parses and validates an Open-Meteo hourly response into forecast points.
 *
 * Open-Meteo returns `null` for hours where a variable is unavailable. That
 * is a data gap, not a forecast: mapping it to zero would publish calm-wind,
 * dark-sky predictions with full confidence (observed in the wild: a tier-1
 * "success" with 0 kn wind and 0 Wh solar for all 24 h, cached for 15 min).
 * An all-null primary variable is therefore treated as a failed fetch so the
 * FSM falls through to the next tier.
 *
 * @param {object} data - Parsed JSON response body
 * @returns {ForecastPoint[]} Array of forecast points
 * @throws {Error} if the payload is malformed or carries no usable data
 */
function parseOpenMeteoResponse(data) {
  const { hourly } = data || {};
  if (
    !hourly ||
    !Array.isArray(hourly.time) ||
    !Array.isArray(hourly.shortwave_radiation)
  ) {
    throw new Error("Open-Meteo response missing hourly data");
  }
  if (hourly.time.length === 0) {
    throw new Error("Open-Meteo response contains no forecast hours");
  }
  if (hourly.time.length !== hourly.shortwave_radiation.length) {
    throw new Error(
      `Open-Meteo hourly arrays mismatch: ${hourly.time.length} times vs ${hourly.shortwave_radiation.length} radiation values`,
    );
  }
  if (!hourly.shortwave_radiation.some((v) => v != null)) {
    throw new Error(
      "Open-Meteo returned no usable shortwave_radiation values (all null)",
    );
  }
  // A payload whose every variable is null-or-zero carries no weather
  // signal at all (see isDegenerateForecast): reject it here so the FSM
  // falls through to the next tier instead of publishing calm-wind,
  // dark-sky predictions with full confidence.
  const hasPositive = (arr) =>
    Array.isArray(arr) && arr.some((v) => v != null && v > 0);
  if (
    !hasPositive(hourly.shortwave_radiation) &&
    !hasPositive(hourly.wind_speed_10m) &&
    !hasPositive(hourly.wind_gusts_10m)
  ) {
    throw new Error(
      "Open-Meteo payload carries no usable values (radiation, wind and gusts all zero)",
    );
  }

  return hourly.time.map((time, i) => {
    // Open-Meteo returns times without timezone; force UTC
    const date = new Date(`${time}Z`);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Open-Meteo returned invalid timestamp: ${time}`);
    }
    return {
      time: date,
      ghi: hourly.shortwave_radiation[i] ?? 0,
      cloudCover: null,
      gustSpeedMs:
        hourly.wind_gusts_10m?.[i] != null
          ? hourly.wind_gusts_10m[i] / 3.6 // km/h to m/s
          : null,
      windSpeedMs:
        hourly.wind_speed_10m?.[i] != null
          ? hourly.wind_speed_10m[i] / 3.6 // km/h to m/s
          : null,
      windDirectionDeg: hourly.wind_direction_10m?.[i] ?? null,
    };
  });
}

/**
 * Performs a single Open-Meteo fetch attempt.
 *
 * @param {number} latitude - Latitude in degrees
 * @param {number} longitude - Longitude in degrees
 * @returns {Promise<ForecastPoint[]>} Array of forecast points
 */
async function fetchOpenMeteoOnce(latitude, longitude, hours = FORECAST_HOURS) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", latitude.toString());
  url.searchParams.set("longitude", longitude.toString());
  url.searchParams.set(
    "hourly",
    "shortwave_radiation,wind_gusts_10m,wind_speed_10m,wind_direction_10m",
  );
  url.searchParams.set("forecast_hours", hours.toString());
  url.searchParams.set("timezone", "UTC");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = new Error(`Open-Meteo returned ${response.status}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    return parseOpenMeteoResponse(data);
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(
        `Open-Meteo fetch timed out after ${FETCH_TIMEOUT}ms`,
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
 * Whether an Open-Meteo failure is transient and worth retrying:
 * timeouts, network-level errors (fetch rejects with TypeError),
 * rate limiting (429) and server errors (5xx). Client errors (4xx)
 * and malformed payloads are permanent for our request.
 *
 * @param {Error & {status?: number, timeout?: boolean}} error
 * @returns {boolean}
 */
function isOpenMeteoRetryable(error) {
  if (error?.timeout === true || error?.name === "AbortError") return true;
  if (error?.status != null) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError; // Network failure
}

/**
 * Fetches forecast data from Open-Meteo API, retrying transient failures.
 *
 * @param {number} latitude - Latitude in degrees
 * @param {number} longitude - Longitude in degrees
 * @param {object} [options]
 * @param {number} [options.retryDelayMs] - Base delay between attempts (tests)
 * @param {(error: Error, attempt: number) => void} [options.onRetry] - Called before each retry
 * @returns {Promise<ForecastPoint[]>} Array of forecast points
 */
async function fetchOpenMeteo(
  latitude,
  longitude,
  {
    retryDelayMs = OPEN_METEO_RETRY_DELAY_MS,
    onRetry,
    hours = FORECAST_HOURS,
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= OPEN_METEO_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchOpenMeteoOnce(latitude, longitude, hours);
    } catch (error) {
      lastError = error;
      if (attempt === OPEN_METEO_MAX_ATTEMPTS || !isOpenMeteoRetryable(error)) {
        throw error;
      }
      onRetry?.(error, attempt);
      await new Promise((resolve) =>
        setTimeout(resolve, retryDelayMs * attempt),
      );
    }
  }
  throw lastError;
}

/**
 * Fetches forecast data from the Signal K Weather API **in-process** (work
 * doc #17 follow-up). The plugin always talks to the Signal K server it
 * runs inside: `app.weatherApi` is the same WeatherApi instance the
 * server's `/signalk/v2/api/weather` REST routes wrap, so weather
 * providers (e.g. a GRIB provider) registered by other plugins answer
 * without HTTP, auth tokens or port guessing. On servers without the
 * Weather API this throws and the FSM falls through to the next tier.
 *
 * @param {ServerAPI} app - Signal K server API
 * @param {number} latitude - Latitude in degrees
 * @param {number} longitude - Longitude in degrees
 * @param {object} [opts]
 * @param {number} [opts.hours] - Forecast intervals to request
 * @returns {Promise<ForecastPoint[]>} Array of forecast points
 */
async function fetchSignalKWeather(app, latitude, longitude, { hours } = {}) {
  const weatherApi = app.weatherApi;
  if (!weatherApi || typeof weatherApi.getForecasts !== "function") {
    throw new Error("This Signal K server has no Weather API");
  }

  const data = await withTimeout(
    weatherApi.getForecasts({ latitude, longitude }, "point", {
      maxCount: hours ?? FORECAST_HOURS,
    }),
    FETCH_TIMEOUT,
    "Signal K Weather API",
  );

  if (!Array.isArray(data)) {
    throw new Error("Signal K Weather API response is not an array");
  }

  return data
    .filter((point) => point.date != null)
    .map((point) => ({
      time: new Date(point.date),
      ghi: null,
      cloudCover: point.outside?.cloudCover ?? null,
      gustSpeedMs: point.wind?.gust != null ? point.wind.gust : null,
      windSpeedMs: point.wind?.speedTrue != null ? point.wind.speedTrue : null,
      windDirectionDeg:
        point.wind?.directionTrue != null
          ? (point.wind.directionTrue * 180) / Math.PI // radians to degrees
          : null,
    }));
}

/**
 * Reads recent cloud coverage from signalk-logbook's on-disk store,
 * in-process. The logbook keeps one YAML file per UTC day at
 * `<configPath>/plugin-config-data/signalk-logbook/<YYYY-MM-DD>.yml`
 * (parsed with the same `yaml` package the logbook itself writes with), so
 * this reads the very data the logbook's REST routes would serve — minus
 * HTTP, auth tokens and port guessing. Only entries with valid
 * cloudCoverage observations are used; a corrupt day file is skipped, not
 * fatal. A missing store (logbook not installed) rejects so the caller can
 * fall through the same way it did on a 404.
 *
 * @param {ServerAPI} app - Signal K server API
 * @param {number} hoursBack - Hours to look back for logbook entries
 * @returns {Promise<Array<{time: Date, cloudCover: number}>>} Cloud coverage readings
 */
async function fetchLogbookCloudCover(app, hoursBack = 48) {
  const configPath = app.config?.configPath;
  if (!configPath) {
    throw new Error("Cannot locate the server's plugin data directory");
  }
  const dir = path.join(configPath, "plugin-config-data", "signalk-logbook");

  const days = await fs.readdir(dir); // ENOENT: logbook absent, tier fails
  const dayRe = /^\d{4}-([0]\d|1[0-2])-([0-2]\d|3[01])\.yml$/;
  const cutoff = new Date(Date.now() - hoursBack * 3600000);
  const entries = [];

  for (const file of days.filter((f) => dayRe.test(f)).sort()) {
    const day = file.slice(0, 10);
    const dayStart = new Date(`${day}T00:00:00.000Z`);
    if (dayStart < cutoff) {
      continue; // Day entirely before the lookback window
    }

    let dayEntries;
    try {
      const content = await fs.readFile(path.join(dir, file), "utf-8");
      dayEntries = content ? parseYaml(content) : [];
    } catch (error) {
      app.debug?.(`Logbook: skipping unreadable day ${day}: ${error.message}`);
      continue;
    }
    if (!Array.isArray(dayEntries)) {
      continue;
    }

    for (const entry of dayEntries) {
      const entryTime = new Date(entry.datetime);
      if (entryTime >= cutoff && entry.observations?.cloudCoverage != null) {
        entries.push({
          time: entryTime,
          cloudCover: oktasToFraction(entry.observations.cloudCoverage),
        });
      }
    }
  }

  return entries.sort((a, b) => a.time - b.time);
}

/**
 * Generates clear sky baseline forecast.
 *
 * @param {Date} startTime - Start time
 * @param {number} hours - Number of hours to forecast
 * @param {number} latitude - Latitude in degrees
 * @param {number} longitude - Longitude in degrees
 * @returns {ForecastPoint[]} Array of forecast points
 */
function generateClearSkyForecast(startTime, hours, latitude, longitude) {
  const points = [];
  const now = startTime.getTime();

  for (let i = 0; i < hours; i++) {
    const time = new Date(now + i * 3600000);
    const { altitude } = sunPosition(time, latitude, longitude);
    points.push({
      time,
      ghi: maxIrradiance(altitude),
      cloudCover: 0,
      gustSpeedMs: null,
      windSpeedMs: null,
      windDirectionDeg: null,
    });
  }

  return points;
}

/**
 * Synthesizes GHI from cloud cover using Kasten-Czeplak attenuation.
 * Returns null if cloud cover is not available.
 *
 * @param {ForecastPoint} point - Forecast point with cloudCover
 * @param {number} latitude - Latitude in degrees
 * @param {number} longitude - Longitude in degrees
 * @returns {number|null} GHI in W/m², or null if cannot synthesize
 */
function synthesizeGHI(point, latitude, longitude) {
  if (point.cloudCover == null) {
    return null;
  }

  const { altitude } = sunPosition(point.time, latitude, longitude);
  return irradianceFromCloudCover(altitude, point.cloudCover);
}

/**
 * Weather ingestion FSM.
 */
class IngestionFSM {
  /**
   * @param {ServerAPI} app - Signal K server API
   * @param {object} [opts]
   * @param {number} [opts.forecastHours]
   * @param {number} [opts.forecastCacheHours] - How long a tier-1/tier-2
   *        forecast (live or restored from disk) stays usable as the primary
   *        in-memory source before the FSM tries to re-fetch. Default 24 h
   *        (offshore: Internet once per day). Tier-3/4 keep a short window.
   * @param {string} [opts.dataDir] - Plugin data directory; when set, freshly
   *        fetched forecasts are cached to disk so retro-predicted can reuse
   *        them offline (same store/format as the historical backfill cache),
   *        and a cold-start/offline FSM can restore the last good forecast
   *        from it instead of falling straight to clear-sky (work doc #15).
   */
  constructor(app, { forecastHours, forecastCacheHours, dataDir } = {}) {
    this.app = app;
    this.currentTier = Tier.OPEN_METEO;
    this.forecastHours = Math.min(
      MAX_FORECAST_HOURS,
      Math.max(FORECAST_HOURS, forecastHours ?? FORECAST_HOURS),
    );
    this.forecastCacheHours =
      forecastCacheHours ?? DEFAULT_FORECAST_CACHE_HOURS;
    this.lastForecast = [];
    this.lastFetchTime = null;
    this.lastFetchAttempt = null; // Timestamp of last fetch attempt (even if failed)
    this.minFetchIntervalMs = 60000; // Don't retry more often than once per minute
    this.position = { latitude: null, longitude: null };
    this.cachedCloudCover = []; // From logbook, used as fallback for future hours
    this.dataDir = dataDir || null;
    /**
     * Uplink status driving fetch cadence (work doc #15 update #1). True if
     * internet is available (`network.internet.state` is `online` or
     * `metered`). Mirrored from deltas via `setUplinkStatus`.
     */
    this.uplinkOnline = false;
    /**
     * True when the current uplink is `metered` (volume-billed: satellite,
     * roaming LTE). On a metered link the FSM skips the tier-1 Open-Meteo
     * download and reads tier 2 (Signal K Weather provider) — a same-server
     * localhost request — instead, reusing forecasts a provider plugin has
     * already fetched under its own data budget. Never downloads to WAN on
     * our own initiative while set. Reset together with `uplinkOnline`
     * (work doc #19).
     */
    this.uplinkMetered = false;
    /**
     * Timestamp (ms) of the last fetch attempt made *while uplink was online*.
     * Used to cap online refetches to ~1 h even if the staleness window would
     * allow a fetch sooner.
     */
    this.lastOnlineFetchAttempt = 0;
    /**
     * Whether we've already announced the current "serving stale" stretch
     * since the last successful fetch. These paths return a cached forecast
     * on *every* getForecast() call, so logging each one would spam the
     * debug stream; we log once per fetch and stay quiet until the next
     * actual fetch resets the flag.
     */
    this.announcedStaleServe = false;
    /**
     * Whether we've already logged the current within-window cache-hit
     * stretch since the last fetch. Logged once per fetch, then quiet.
     */
    this.announcedCacheHit = false;
  }

  /**
   * Updates the current position from Signal K.
   */
  updatePosition() {
    const pos = this.app.getSelfPath("navigation.position");
    if (pos && pos.latitude != null && pos.longitude != null) {
      this.position = {
        latitude: pos.latitude,
        longitude: pos.longitude,
      };
    }
  }

  /**
   * Mirrors uplink status from deltas (work doc #15 update #1).
   *
   * Online if internet is available (`network.internet.state` is `online`
   * or `metered`). A `metered` link additionally sets `uplinkMetered`, which
   * suppresses the tier-1 Open-Meteo download in favor of the same-server
   * Signal K Weather provider (work doc #19). Returns true if the
   * offline→online edge happened on this call so the caller can trigger an
   * immediate fetch.
   *
   * @param {object} status
   * @param {unknown} [status.internet] - `network.internet.state`
   * @returns {boolean} true if this call flipped uplink from offline to online
   */
  setUplinkStatus({ internet } = {}) {
    const internetOnline =
      typeof internet === "string" &&
      (internet.trim() === "online" || internet.trim() === "metered");
    const online = internetOnline;
    const becameOnline = online && !this.uplinkOnline;
    this.uplinkOnline = online;
    this.uplinkMetered =
      online && typeof internet === "string" && internet.trim() === "metered";
    if (becameOnline) {
      this.app.debug(
        `Uplink came online (${this.uplinkMetered ? "metered" : "unmetered"}) — fetch eligible immediately`,
      );
      // Reset the online-cadence cap so the transition triggers a fetch now.
      this.lastOnlineFetchAttempt = 0;
    }
    return becameOnline;
  }

  /**
   * Returns the in-memory reuse window (ms) for the current tier.
   *
   * Tier 1/2 (real forecasts, incl. restored-from-disk) stay usable for
   * `forecastCacheHours`; tier 3/4 (logbook oktas, clear sky) keep the short
   * window — cheap to regenerate and carry no forward-looking wind.
   *
   * @returns {number} max age in ms
   */
  forecastMaxAgeMs() {
    const lowTier =
      this.currentTier === Tier.LOGBOOK || this.currentTier === Tier.CLEAR_SKY;
    const hours = lowTier
      ? LOW_TIER_CACHE_MINUTES / 60
      : this.forecastCacheHours;
    return hours * 3600000;
  }

  /**
   * Checks network status by attempting a simple fetch.
   *
   * @returns {Promise<NetworkStatus>}
   */
  async getNetworkStatus() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(
        "https://dns.google/resolve?name=example.com",
        {
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);
      return { wanOnline: response.ok };
    } catch (error) {
      return { wanOnline: false };
    }
  }

  /**
   * Attempts to fetch forecast from a specific tier.
   *
   * @param {number} tier - Tier to fetch from
   * @returns {Promise<ForecastPoint[]|null>} Forecast points, or null if failed
   */
  async fetchFromTier(tier) {
    const { latitude, longitude } = this.position;

    if (latitude == null || longitude == null) {
      return null;
    }

    switch (tier) {
      case Tier.OPEN_METEO: {
        this.app.debug("Open-Meteo: fetching from API");
        // No network pre-check: just try. The fetch has its own timeout,
        // and a pre-check (e.g. dns.google) can wrongly skip a reachable API.
        return await fetchOpenMeteo(latitude, longitude, {
          hours: this.forecastHours,
          onRetry: (error, attempt) =>
            this.app.debug(
              `Open-Meteo attempt ${attempt} failed: ${error.message}, retrying`,
            ),
        });
      }

      case Tier.SIGNAL_K_WEATHER: {
        this.app.debug("Signal K Weather: reading provider in-process");
        return await fetchSignalKWeather(this.app, latitude, longitude, {
          hours: this.forecastHours,
        });
      }

      case Tier.LOGBOOK: {
        this.app.debug("Logbook: reading recent cloud cover");
        // Logbook has no forward-looking data - use recent observed cloud
        // cover as a proxy and combine with sun position for a forecast
        const cloudReadings = await fetchLogbookCloudCover(this.app, 48);
        this.cachedCloudCover = cloudReadings;
        this.app.debug(
          `Logbook: got ${cloudReadings.length} cloud cover readings`,
        );

        if (cloudReadings.length === 0) {
          return null; // No recent observations, no basis for a forecast
        }

        // Use the most recent reading as the cloud cover assumption
        const latestCloudCover =
          cloudReadings[cloudReadings.length - 1].cloudCover;
        this.app.debug(
          `Logbook: assuming cloud cover ${Math.round(latestCloudCover * 100)}% from latest observation`,
        );

        const points = [];
        const nowMs = Date.now();
        for (let i = 0; i < this.forecastHours; i++) {
          const time = new Date(nowMs + i * 3600000);
          const { altitude } = sunPosition(time, latitude, longitude);
          points.push({
            time,
            ghi: irradianceFromCloudCover(altitude, latestCloudCover),
            cloudCover: latestCloudCover,
            gustSpeedMs: null,
            windSpeedMs: null,
            windDirectionDeg: null,
          });
        }
        return points;
      }

      case Tier.CLEAR_SKY: {
        this.app.debug("Clear Sky: generating forecast");
        return generateClearSkyForecast(
          new Date(),
          this.forecastHours,
          latitude,
          longitude,
        );
      }

      default:
        return null;
    }
  }

  /**
   * Post-processes forecast points to fill missing GHI values.
   *
   * @param {ForecastPoint[]} forecast - Raw forecast points
   * @returns {ForecastPoint[]} Processed forecast with GHI filled where possible
   */
  postProcessForecast(forecast) {
    const { latitude, longitude } = this.position;

    return forecast.map((point) => {
      if (point.ghi != null && point.ghi > 0) {
        return point; // Already have direct GHI measurement
      }

      // Try to synthesize from cloud cover
      const synthesizedGHI = synthesizeGHI(point, latitude, longitude);
      if (synthesizedGHI != null) {
        return { ...point, ghi: synthesizedGHI };
      }

      // Fallback to clear sky if we have cloudCover=0 from somewhere
      if (point.cloudCover === 0) {
        const { altitude } = sunPosition(point.time, latitude, longitude);
        return { ...point, ghi: maxIrradiance(altitude) };
      }

      return point;
    });
  }

  /**
   * Caches the freshly fetched forecast into the on-disk weather store so
   * retro-predicted can reuse it offline. Points are grouped by UTC date and
   * written at the vessel's current position bucket — the same store/format
   * the historical backfill uses — so live forecasts (any tier, including
   * Clear Sky) and backfilled archive weather are interchangeable.
   *
   * Best-effort: a cache write failure must not break the prediction cycle.
   * @returns {Promise<void>}
   */
  async cacheForecast() {
    if (!this.dataDir || this.lastForecast.length === 0) return;
    const { latitude, longitude } = this.position;
    if (latitude == null || longitude == null) return;
    const bucket = weatherCache.weatherPositionBucket(latitude, longitude);
    // Group points by UTC date (YYYY-MM-DD) so each day lands in its own file.
    const byDate = new Map();
    for (const p of this.lastForecast) {
      const d = p.time;
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      let arr = byDate.get(key);
      if (!arr) {
        arr = [];
        byDate.set(key, arr);
      }
      arr.push({
        time: d,
        ghi: p.ghi ?? null,
        cloudCover: p.cloudCover ?? null,
        windSpeedMs: p.windSpeedMs ?? null,
        gustSpeedMs: p.gustSpeedMs ?? null,
        windDirectionDeg: p.windDirectionDeg ?? null,
      });
    }
    try {
      for (const [dateKey, hours] of byDate) {
        await weatherCache.writeWeatherCache(
          this.dataDir,
          dateKey,
          bucket,
          hours,
          this.currentTier,
        );
      }
    } catch (error) {
      this.app.debug?.(`Failed to cache forecast weather: ${error.message}`);
    }
  }

  /**
   * Fetches a new forecast using the fallback FSM.
   *
   * @returns {Promise<ForecastPoint[]>} Forecast points
   */
  async fetchForecast() {
    this.updatePosition();

    const { latitude, longitude } = this.position;

    if (latitude == null || longitude == null) {
      this.app.debug("No GPS position yet, skipping forecast");
      return [];
    }
    this.app.debug(
      `Fetching forecast for position: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
    );

    // Network attempts are rate-limited by uplink cadence (work doc #15
    // update #1): immediate on the offline→online edge, ~1 h while online,
    // ~24 h probe while offline, with the 60 s failure floor. Only the
    // *network* half is suppressed, though — the offline ladder below is
    // local and cheap, so it runs on every fetchForecast call: a
    // rate-limited cycle must still be able to swap an exhausted
    // in-memory forecast for the on-disk cache or the hybrid instead of
    // serving hours that have already passed (the dead zone observed in
    // the wild: offline, cache coverage spent, "rate-limited" kept
    // returning the past-only forecast until the next probe).
    const attemptNow = Date.now();
    let networkAllowed = true;
    if (this.uplinkOnline) {
      if (
        attemptNow - this.lastOnlineFetchAttempt <
        UPLINK_ONLINE_FETCH_INTERVAL_MS
      ) {
        networkAllowed = false;
        this.announceRateLimited("uplink refetched recently");
      }
    } else if (
      this.lastFetchAttempt &&
      attemptNow - this.lastFetchAttempt.getTime() < UPLINK_OFFLINE_PROBE_MS
    ) {
      networkAllowed = false;
      this.announceRateLimited("offline probe rate-limited");
    }
    if (
      networkAllowed &&
      this.lastFetchAttempt &&
      attemptNow - this.lastFetchAttempt.getTime() < this.minFetchIntervalMs
    ) {
      networkAllowed = false; // 60 s floor: a failed fetch is not retried within a minute
    }

    if (networkAllowed) {
      this.lastFetchAttempt = new Date(attemptNow);
      if (this.uplinkOnline) this.lastOnlineFetchAttempt = attemptNow;

      // Try real network forecast tiers in order until one succeeds with
      // actual data. Note: empty forecast counts as failure (an empty array is
      // truthy in JS, but carries no data - fall through to the next tier
      // instead). Tier 3 (Logbook) and tier 4 (Clear Sky) are intentionally NOT
      // in this loop:
      //   - Logbook carries no wind, so a logbook-only "success" would shadow
      //     the on-disk restore path, which can produce logbook solar *plus*
      //     latest-known wind (the stale-boundary hybrid, work doc #15 update
      //     #2) — strictly better. Logbook cloud cover is still used as the
      //     hybrid's solar source.
      //   - Clear Sky always succeeds (pure sun geometry), so it would shadow
      //     a restored real (stale) forecast, which is strictly better.
      // Both are reached only via the restore/hybrid/clear-sky fallback below.
      for (let tier = Tier.OPEN_METEO; tier < Tier.LOGBOOK; tier++) {
        // On a metered (volume-billed) uplink, skip the tier-1 Open-Meteo
        // download and read tier 2 instead: the Signal K Weather API is a
        // same-server localhost request serving forecasts a provider plugin
        // has already fetched under its own data budget (work doc #19). If
        // tier 2 yields nothing, fall through to the offline ladder below —
        // do not buy a WAN download the user did not opt into.
        if (tier === Tier.OPEN_METEO && this.uplinkMetered) {
          this.app.debug(
            "Uplink is metered — skipping Open-Meteo download, reading Signal K Weather provider",
          );
          continue;
        }
        this.app.debug(`Trying tier ${tier}: ${this.getTierName(tier)}`);
        let forecast;
        try {
          forecast = await this.fetchFromTier(tier);
        } catch (error) {
          // A failing tier (network error, timeout) must not abort the
          // fallback chain - try the next tier instead
          this.app.debug(
            `Tier ${this.getTierName(tier)} failed: ${error.message}`,
          );
          continue;
        }
        // A tier "success" must carry hours that are still in the future:
        // a Signal K Weather provider serving its own stale dataset answers
        // with points that are all in the past, which would otherwise be
        // published as a fresh tier-2 forecast with zero future coverage
        // (shadowing the on-disk restore). The 2 h grace absorbs
        // hour-truncated timestamps, not stale datasets.
        if (
          forecast &&
          forecast.length > 0 &&
          !isDegenerateForecast(forecast) &&
          hasFutureCoverage(forecast, attemptNow, 2 * 3600000)
        ) {
          this.currentTier = tier;
          this.lastFetchTime = new Date();
          this.lastForecast = this.postProcessForecast(forecast);
          this.announcedStaleServe = false;
          this.announcedCacheHit = false;
          this.app.debug(
            `Got ${this.lastForecast.length} forecast points from ${this.getTierName(tier)}`,
          );
          await this.cacheForecast();
          return this.lastForecast;
        }
        if (forecast && forecast.length > 0) {
          // Degenerate (all-zero) or all-past payload: a "success" that
          // carries no usable forecast. Treat as a failed tier, never cache
          // it.
          this.app.debug(
            `Tier ${this.getTierName(tier)} returned a degenerate or all-past forecast — trying next tier`,
          );
        }
      }
    }

    // All real network tiers failed (or are rate-limited). Fall through the
    // offline ladder (work doc #15) — local, cheap, runs on every call:
    //   1. Restore the cached real forecast from the on-disk cache for the
    //      hours that are still in the future (coverage-based: a cached
    //      hour is a real prediction until its valid time passes, however
    //      long ago it was fetched). Hours beyond the cache's coverage are
    //      filled with the hybrid so the horizon stays complete.
    //   2. No future coverage on disk → the stale-boundary hybrid in full:
    //      solar from logbook oktas, wind from latest-known live SK. Runs
    //      even with no on-disk cache (logbook doesn't need it); it falls
    //      to Clear Sky internally when logbook has no observations.
    //   3. If even logbook is empty, the hybrid produces Clear Sky (the floor).
    const restored = await this.restoreForecastFromCache();
    if (restored) {
      return restored;
    }
    return this.buildStaleHybridForecast();
  }

  /**
   * Logs the network-attempt rate-limit skip once per stretch (every
   * fetchForecast call while rate-limited would spam the debug stream;
   * the offline ladder still runs and logs its own outcome).
   * @param {string} reason
   */
  announceRateLimited(reason) {
    if (!this.announcedStaleServe) {
      this.app.debug(
        `Forecast refresh rate-limited (${reason}) — skipping network tiers, trying the offline ladder`,
      );
      this.announcedStaleServe = true;
    }
  }

  /**
   * Restores the cached forecast from the on-disk weather cache for the
   * vessel's current ~1° restore bucket, filtered to the live forecast
   * horizon [now, now + forecastHours] (work doc #15).
   *
   * Used when all live network tiers fail: a stale real forecast (any tier)
   * found on disk is preferred over a synthesized Clear Sky one. Reads every
   * fine-bucket cache file that falls inside the coarse restore bucket across
   * the horizon's UTC dates and merges them by tier (best wins per hour).
   *
   * The gate is **coverage-based**, not fetch-age-based: cached hours that
   * are still in the future are real predictions regardless of how long
   * ago the fetch that wrote them ran, so they are served (tagged
   * `source: "forecast-cache"`) until their valid time passes. Hours of
   * the horizon the cache no longer covers are filled with the stale
   * hybrid (logbook solar + latest-known wind) so the published horizon
   * stays complete with honest per-hour provenance. Only when the cache
   * has no future hours at all does this return `null` and let the caller
   * build the full hybrid.
   *
   * Sets `currentTier` to the best (lowest) tier present across the restored
   * points so diagnostics reflect that this is a real (if stale) forecast.
   *
   * Never throws: a missing/empty/corrupt cache degrades to `null`.
   *
   * @returns {Promise<ForecastPoint[]|null>} Restored forecast, or null
   */
  async restoreForecastFromCache() {
    if (!this.dataDir) return null;
    const { latitude, longitude } = this.position;
    if (latitude == null || longitude == null) return null;

    const coarse = weatherCache.weatherRestoreBucket(latitude, longitude);
    const now = Date.now();
    const horizonEnd = now + this.forecastHours * 3600000;

    // Enumerate the UTC dates that the horizon spans and restore each.
    const dateKeys = new Set();
    for (let t = now; t <= horizonEnd; t += 3600000) {
      const d = new Date(t);
      dateKeys.add(
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
      );
    }

    let merged = null;
    let newestFetchAt = 0;
    for (const dateKey of dateKeys) {
      try {
        const got = await weatherCache.readWeatherCacheCoarse(
          this.dataDir,
          dateKey,
          coarse,
        );
        if (!got) continue;
        merged = weatherCache.mergeHours(merged, got.hours);
        if (got.fetchedAt.getTime() > newestFetchAt) {
          newestFetchAt = got.fetchedAt.getTime();
        }
      } catch (error) {
        this.app.debug?.(
          `Restore: failed to read cache for ${dateKey}: ${error.message}`,
        );
      }
    }
    if (!merged || merged.length === 0) {
      this.app.debug("Restore: no on-disk forecast found in restore bucket");
      return null;
    }

    // Filter to the live horizon and skip points already in the past.
    const inHorizon = merged.filter(
      (p) =>
        p.time.getTime() >= now - 3600000 && p.time.getTime() <= horizonEnd,
    );
    if (inHorizon.length === 0) {
      this.app.debug(
        "Restore: cached forecast is entirely outside the horizon",
      );
      return null;
    }

    // A poisoned cache (all-zero hours written by a broken fetch) must not
    // be served as a real forecast — leave it for the stale hybrid.
    if (isDegenerateForecast(inHorizon)) {
      this.app.debug(
        "Restore: cached forecast is degenerate (all-zero) — ignoring",
      );
      return null;
    }

    // Best (lowest) tier present — this is a real forecast, not Clear Sky.
    let bestTier = Infinity;
    for (const p of inHorizon) {
      const t = p.tier ?? Infinity;
      if (t < bestTier) bestTier = t;
    }
    if (bestTier === Infinity) bestTier = Tier.CLEAR_SKY;

    // Coverage-based gate (follow-up to work doc #15 update #2): a cached
    // forecast hour is a real prediction until its valid time passes — it
    // does not rot `forecastCacheHours` after the fetch that produced it.
    // The previous fetch-age (mtime) gate discarded a 48 h forecast 24 h
    // after its fetch even when ~24 h of its hours were still ahead,
    // degrading to a zero-information Clear Sky (observed in the wild:
    // anchored, Internet down for 2 h, cache mtime a day old → Clear Sky,
    // no wind). `inHorizon` above has already dropped past hours, so
    // reaching here means there is real forecast data still ahead. Hours
    // beyond the cache's coverage get the hybrid tail below so the
    // horizon stays complete; per-hour `source` tags keep provenance
    // honest for downstream consumers.
    const lastCachedMs = inHorizon.reduce(
      (max, p) => Math.max(max, p.time.getTime()),
      0,
    );
    const cached = inHorizon.map((p) => ({ ...p, source: "forecast-cache" }));
    let points = cached;
    if (lastCachedMs < horizonEnd) {
      const { points: tail } = await this.buildHybridHours(now);
      points = cached
        .concat(tail.filter((p) => p.time.getTime() > lastCachedMs))
        .sort((a, b) => a.time.getTime() - b.time.getTime());
    }

    this.currentTier = bestTier;
    // Anchor the in-memory reuse window at serve time: the window governs
    // how long these hours may keep being served, not how old the fetch
    // was (the cache stores no fetch timestamp; the newest file mtime is
    // only used for the diagnostic below). `getForecast`'s future-coverage
    // cache-hit check re-runs the ladder once the last cached hour passes.
    this.lastFetchTime = new Date(now);
    this.lastForecast = this.postProcessForecast(points);
    this.announcedStaleServe = false;
    this.announcedCacheHit = false;
    this.app.debug(
      `Restored ${cached.length} cached forecast hours from disk (best tier ${bestTier}, fetched ~${Math.round((now - (newestFetchAt || now)) / 3600000)}h ago)${points.length > cached.length ? `, + ${points.length - cached.length} hybrid hours past cache coverage` : ""}`,
    );
    return this.lastForecast;
  }

  /**
   * Builds hybrid "what we know now" forecast hours (work doc #15 update #2):
   *
   *   - **Solar (GHI):** synthesized from the latest logbook cloud-cover
   *     observation via Kasten-Czeplak (reuses the tier-3 logbook path). Falls
   *     to Clear Sky if logbook has no observations.
   *   - **Wind:** latest-known live Signal K wind (`environment.wind.speedTrue`,
   *     `directionTrue`, gust) held constant across the horizon. Not a
   *     forecast — a nowcast assumed to persist — so downstream consumers
   *     (WPF, advisories) can down-weight.
   *
   * Each point carries a `source` field (`"logbook"` / `"clear-sky"`;
   * the wind fields themselves are the latest-known nowcast) so callers can
   * distinguish a real prediction from this hybrid.
   *
   * Pure with respect to FSM bookkeeping (sets no tier/fetch/announcement
   * state) so it serves both the stale-boundary floor
   * (`buildStaleHybridForecast`) and the restore path's tail-fill for hours
   * beyond the on-disk cache's coverage.
   *
   * @param {number} nowMs - Horizon start (ms epoch)
   * @returns {Promise<{points: ForecastPoint[], cloudCover: number|null}>}
   */
  async buildHybridHours(nowMs) {
    const { latitude, longitude } = this.position;

    // Latest-known wind from live SK state (held constant across horizon).
    const latestWind = {
      speedMs: toMs(this.app.getSelfPath("environment.wind.speedTrue")),
      gustMs: toMs(this.app.getSelfPath("environment.wind.gust")),
      directionDeg: windDirectionDeg(
        this.app.getSelfPath("environment.wind.directionTrue"),
      ),
    };

    // Solar: try logbook cloud cover first (tier-3 path reuses cached).
    let cloudCover = null;
    try {
      // Reuse any cached cloud cover from a prior logbook fetch this session.
      if (this.cachedCloudCover.length > 0) {
        cloudCover =
          this.cachedCloudCover[this.cachedCloudCover.length - 1].cloudCover;
      } else {
        const readings = await fetchLogbookCloudCover(this.app, 48);
        this.cachedCloudCover = readings;
        if (readings.length > 0) {
          cloudCover = readings[readings.length - 1].cloudCover;
        }
      }
    } catch (error) {
      this.app.debug?.(`Hybrid hours: logbook unavailable: ${error.message}`);
    }

    const points = [];
    for (let i = 0; i < this.forecastHours; i++) {
      const time = new Date(nowMs + i * 3600000);
      const { altitude } = sunPosition(time, latitude, longitude);
      let ghi;
      let source;
      if (cloudCover != null) {
        ghi = irradianceFromCloudCover(altitude, cloudCover);
        source = "logbook";
      } else {
        ghi = maxIrradiance(altitude);
        source = "clear-sky";
      }
      points.push({
        time,
        ghi,
        cloudCover,
        windSpeedMs: latestWind.speedMs,
        gustSpeedMs: latestWind.gustMs,
        windDirectionDeg: latestWind.directionDeg,
        source,
      });
    }
    return { points, cloudCover };
  }

  /**
   * Builds and adopts the stale-boundary hybrid forecast (work doc #15
   * update #2): the offline-ladder floor used when there is no real
   * forecast coverage left — neither live tiers nor future hours on disk.
   * See `buildHybridHours` for what the hours contain.
   *
   * `currentTier` is set to LOGBOOK (or CLEAR_SKY if no logbook), never to
   * a real-forecast tier.
   *
   * @returns {Promise<ForecastPoint[]>} Hybrid forecast points
   */
  async buildStaleHybridForecast() {
    const nowMs = Date.now();
    const { points, cloudCover } = await this.buildHybridHours(nowMs);

    this.currentTier = cloudCover != null ? Tier.LOGBOOK : Tier.CLEAR_SKY;
    this.lastFetchTime = new Date(nowMs);
    this.lastForecast = points;
    this.announcedStaleServe = false;
    this.announcedCacheHit = false;
    this.app.debug(
      `Stale hybrid: ${points.length} points (solar: ${cloudCover != null ? "logbook oktas" : "clear sky"}, wind: latest-known ${points[0]?.windSpeedMs ?? "?"}m/s)`,
    );
    return this.lastForecast;
  }

  /**
   * Gets the tier name for debug logging.
   */
  getTierName(tier) {
    switch (tier) {
      case Tier.OPEN_METEO:
        return "Open-Meteo";
      case Tier.SIGNAL_K_WEATHER:
        return "Signal K Weather";
      case Tier.LOGBOOK:
        return "Logbook";
      case Tier.CLEAR_SKY:
        return "Clear Sky";
      default:
        return `Tier ${tier}`;
    }
  }

  /**
   * Gets the current forecast (cached if fresh, otherwise fetches new).
   *
   * Freshness gate (work doc #15): the in-memory forecast is served while it
   * is younger than its tier's staleness window (`forecastMaxAgeMs`: tier-1/2
   * `forecastCacheHours`, default 24 h; tier-3/4 15 min) **and** still covers
   * future hours. The coverage clause closes the end-of-offline-stretch dead
   * zone: a restored forecast whose last cached hour has passed must not be
   * served as "fresh" for the rest of its window — the ladder in
   * `fetchForecast` rebuilds from the disk cache / hybrid instead. Uplink
   * cadence (how often the *network* tiers may be attempted) is applied
   * inside `fetchForecast` and never blocks the local ladder.
   *
   * The `maxAgeMinutes` argument is kept for backward compatibility but
   * ignored in favor of the tier-aware window — callers should not pass it.
   *
   * @param {number} [_maxAgeMinutes] - ignored (tier-aware window is used)
   * @returns {Promise<ForecastPoint[]>} Forecast points
   */
  async getForecast(_maxAgeMinutes) {
    const maxAge = this.forecastMaxAgeMs();

    // Return cached forecast if still within its tier's staleness window
    // and not yet exhausted (still has hours a prediction hour can use —
    // hasFutureCoverage's grace matches runPrediction's ±30 min point
    // matching, so "fresh but all-past" fails here and re-runs the ladder).
    if (
      this.lastFetchTime &&
      this.lastForecast.length > 0 &&
      Date.now() - this.lastFetchTime.getTime() < maxAge &&
      hasFutureCoverage(this.lastForecast)
    ) {
      if (!this.announcedCacheHit) {
        this.app.debug(
          `Using cached forecast (age: ${Math.round((Date.now() - this.lastFetchTime.getTime()) / 60000)}min, tier: ${this.currentTier}, points: ${this.lastForecast.length}, first: ${this.lastForecast[0]?.time.toISOString()})`,
        );
        this.announcedCacheHit = true;
      }
      return this.lastForecast;
    }

    return await this.fetchForecast();
  }

  /**
   * Gets the current GHI at the vessel's position and time.
   *
   * @returns {Promise<{ghi: number, cloudCover: number|null, tier: number}>} Current conditions
   */
  async getCurrentGHI() {
    const { latitude, longitude } = this.position;
    const now = new Date();

    // Try to get current value from forecast
    const forecast = await this.getForecast();
    const current = forecast.find(
      (p) => Math.abs(p.time.getTime() - now.getTime()) < 1800000, // Within 30 minutes
    );

    if (current && current.ghi != null) {
      return {
        ghi: current.ghi,
        cloudCover: current.cloudCover,
        gustSpeedMs: current.gustSpeedMs,
        tier: this.currentTier,
      };
    }

    // Fallback to clear sky
    const { altitude } = sunPosition(now, latitude, longitude);
    return {
      ghi: maxIrradiance(altitude),
      cloudCover: 0,
      gustSpeedMs: null,
      tier: Tier.CLEAR_SKY,
    };
  }

  /**
   * Gets weather source metadata for diagnostics.
   *
   * @returns {WeatherSource}
   */
  getSourceInfo() {
    const tierNames = {
      [Tier.OPEN_METEO]: "Open-Meteo",
      [Tier.SIGNAL_K_WEATHER]: "Signal K Weather API",
      [Tier.LOGBOOK]: "Signal K Logbook",
      [Tier.CLEAR_SKY]: "Clear Sky Baseline",
    };

    return {
      tier: this.currentTier,
      source: tierNames[this.currentTier] || "Unknown",
      lastFetch: this.lastFetchTime,
      available: this.lastForecast.length > 0,
    };
  }
}

module.exports = {
  IngestionFSM,
  Tier,
  fetchOpenMeteo,
  fetchSignalKWeather,
  fetchLogbookCloudCover,
  generateClearSkyForecast,
  synthesizeGHI,
  isDegenerateForecast,
  hasFutureCoverage,
  OPEN_METEO_MAX_ATTEMPTS,
  FORECAST_HOURS,
  MAX_FORECAST_HOURS,
  DEFAULT_FORECAST_CACHE_HOURS,
  UPLINK_ONLINE_FETCH_INTERVAL_MS,
  UPLINK_OFFLINE_PROBE_MS,
};
