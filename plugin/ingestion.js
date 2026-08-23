/**
 * Weather data ingestion using a 4-tier fallback FSM.
 *
 * Tiers:
 * 1. Direct NWP (Open-Meteo REST API) - shortwave_radiation
 * 2. Signal K Weather API - cloudCover (0-1)
 * 3. Logbook Persistence - cloudCover (oktas 0-8)
 * 4. Clear Sky Baseline - theoretical max from sun position
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

/** m/s → knots, matching prediction.js's MS_TO_KN. */
const MS_TO_KN = 1.94384;

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
 * Converts a Signal K wind speed (m/s) to knots, or null if missing.
 * @param {unknown} v
 * @returns {number|null}
 */
function toKnots(v) {
  const ms = toNumber(v);
  return ms == null ? null : ms * MS_TO_KN;
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
 * Fetch timeout in milliseconds
 */
const FETCH_TIMEOUT = 10000;

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
 * @typedef {{time: Date, ghi: number, cloudCover: number|null, gustSpeedKnots: number|null, windSpeedKnots: number|null, windDirectionDeg: number|null}} ForecastPoint
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
      gustSpeedKnots:
        hourly.wind_gusts_10m?.[i] != null
          ? hourly.wind_gusts_10m[i] * 0.539957 // km/h to knots
          : null,
      windSpeedKnots:
        hourly.wind_speed_10m?.[i] != null
          ? hourly.wind_speed_10m[i] * 0.539957 // km/h to knots
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
 * Fetches forecast data from Signal K Weather API.
 *
 * @param {ServerAPI} app - Signal K server API
 * @param {number} latitude - Latitude in degrees
 * @param {number} longitude - Longitude in degrees
 * @returns {Promise<ForecastPoint[]>} Array of forecast points
 */
async function fetchSignalKWeather(app, latitude, longitude) {
  const baseUrl = app.getSelfPath("system.host") || "http://localhost:3000";
  const url = new URL(`${baseUrl}/signalk/v2/api/weather/forecasts/point`);
  url.searchParams.set("lat", latitude.toString());
  url.searchParams.set("lon", longitude.toString());
  url.searchParams.set("count", FORECAST_HOURS.toString());

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Signal K Weather API returned ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error("Signal K Weather API response is not an array");
    }

    return data
      .filter((point) => point.date != null)
      .map((point) => ({
        time: new Date(point.date),
        ghi: null,
        cloudCover: point.outside?.cloudCover ?? null,
        gustSpeedKnots:
          point.wind?.gust != null
            ? point.wind.gust * 1.94384 // m/s to knots
            : null,
        windSpeedKnots:
          point.wind?.speedTrue != null
            ? point.wind.speedTrue * 1.94384 // m/s to knots
            : null,
        windDirectionDeg:
          point.wind?.directionTrue != null
            ? (point.wind.directionTrue * 180) / Math.PI // radians to degrees
            : null,
      }));
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetches recent cloud coverage from Signal K Logbook API.
 * Note: Only entries with valid cloudCoverage observations are used.
 *
 * @param {ServerAPI} app - Signal K server API
 * @param {number} hoursBack - Hours to look back for logbook entries
 * @returns {Promise<Array<{time: Date, cloudCover: number}>>} Cloud coverage readings
 */
async function fetchLogbookCloudCover(app, hoursBack = 48) {
  const baseUrl = app.getSelfPath("system.host") || "http://localhost:3000";
  const url = new URL(`${baseUrl}/plugins/signalk-logbook/logs`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    // First, get list of days with entries
    const response = await fetch(url.toString(), {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Logbook API returned ${response.status}`);
    }

    const days = await response.json();
    if (!Array.isArray(days)) {
      return [];
    }

    const cutoff = new Date(Date.now() - hoursBack * 3600000);
    const entries = [];

    // Fetch each day's entries within the time window
    for (const day of days) {
      const dayDate = new Date(day);
      if (dayDate < cutoff) {
        continue;
      }

      const dayUrl = new URL(`${url}/${day}`);
      const dayResponse = await fetch(dayUrl.toString(), {
        signal: controller.signal,
      });

      if (dayResponse.ok) {
        const dayEntries = await dayResponse.json();
        if (Array.isArray(dayEntries)) {
          for (const entry of dayEntries) {
            const entryTime = new Date(entry.datetime);
            if (
              entryTime >= cutoff &&
              entry.observations?.cloudCoverage != null
            ) {
              entries.push({
                time: entryTime,
                cloudCover: oktasToFraction(entry.observations.cloudCoverage),
              });
            }
          }
        }
      }
    }

    return entries.sort((a, b) => a.time - b.time);
  } finally {
    clearTimeout(timeoutId);
  }
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
      gustSpeedKnots: null,
      windSpeedKnots: null,
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
     * either Starlink (`network.providers.starlink.status === "online"`) or
     * LTE (`networking.lte.connectionText` not `No service`) is online.
     * Mirrored from deltas via `setUplinkStatus`.
     */
    this.uplinkOnline = false;
    /**
     * Timestamp (ms) of the last fetch attempt made *while uplink was online*.
     * Used to cap online refetches to ~1 h even if the staleness window would
     * allow a fetch sooner.
     */
    this.lastOnlineFetchAttempt = 0;
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
   * Online if either Starlink (`network.providers.starlink.status ===
   * "online"`) or LTE (`networking.lte.connectionText` not `No service`,
   * case-insensitive) is online. Returns true if the offline→online edge
   * happened on this call so the caller can trigger an immediate fetch.
   *
   * @param {object} status
   * @param {unknown} [status.starlink] - `network.providers.starlink.status`
   * @param {unknown} [status.lte] - `networking.lte.connectionText`
   * @returns {boolean} true if this call flipped uplink from offline to online
   */
  setUplinkStatus({ starlink, lte } = {}) {
    const starlinkOnline =
      typeof starlink === "string" && starlink.trim() === "online";
    const lteOnline =
      typeof lte === "string" &&
      lte.trim().length > 0 &&
      lte.trim().toLowerCase() !== "no service";
    const online = starlinkOnline || lteOnline;
    const becameOnline = online && !this.uplinkOnline;
    this.uplinkOnline = online;
    if (becameOnline) {
      this.app.debug("Uplink came online — fetch eligible immediately");
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
        this.app.debug("Signal K Weather: checking for plugin");
        return await fetchSignalKWeather(this.app, latitude, longitude);
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
            gustSpeedKnots: null,
            windSpeedKnots: null,
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
        windSpeedKnots: p.windSpeedKnots ?? null,
        gustSpeedKnots: p.gustSpeedKnots ?? null,
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
      if (forecast && forecast.length > 0) {
        this.currentTier = tier;
        this.lastFetchTime = new Date();
        this.lastForecast = this.postProcessForecast(forecast);
        this.app.debug(
          `Got ${this.lastForecast.length} forecast points from ${this.getTierName(tier)}`,
        );
        await this.cacheForecast();
        return this.lastForecast;
      }
    }

    // All real network tiers failed. Fall through the offline ladder
    // (work doc #15):
    //   1. Restore the last real forecast from the on-disk cache if it is
    //      still within its staleness window (a stale tier-1/2 forecast is
    //      strictly better than the synthesized alternatives below).
    //   2. Otherwise build the stale-boundary hybrid: solar from logbook
    //      oktas, wind from latest-known live SK. This runs even with no
    //      on-disk cache (logbook doesn't need it); it falls to Clear Sky
    //      internally when logbook has no observations.
    //   3. If even logbook is empty, the hybrid produces Clear Sky (the floor).
    const restored = await this.restoreForecastFromCache();
    if (restored) {
      return restored;
    }
    return this.buildStaleHybridForecast();
  }

  /**
   * Restores the most recent forecast from the on-disk weather cache for the
   * vessel's current ~1° restore bucket, filtered to the live forecast
   * horizon [now, now + forecastHours] (work doc #15).
   *
   * Used when all live network tiers fail: a stale real forecast (any tier)
   * found on disk is preferred over a synthesized Clear Sky one. Reads every
   * fine-bucket cache file that falls inside the coarse restore bucket across
   * the horizon's UTC dates, merges them by tier (best wins per hour), and
   * takes the newest file `mtime` as the fetch-time proxy for staleness.
   *
   * Sets `currentTier` to the best (lowest) tier present across the restored
   * points so diagnostics reflect that this is a real (if stale) forecast.
   *
   * Never throws: a missing/empty/corrupt cache degrades to `null`, letting
   * the caller fall through to Clear Sky.
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

    // Best (lowest) tier present — this is a real forecast, not Clear Sky.
    let bestTier = Infinity;
    for (const p of inHorizon) {
      const t = p.tier ?? Infinity;
      if (t < bestTier) bestTier = t;
    }
    if (bestTier === Infinity) bestTier = Tier.CLEAR_SKY;

    // Stale-boundary gate (work doc #15 update #2). If the restored forecast
    // is older than `forecastCacheHours`, it has outlived its useful life as
    // a real prediction — return null so the caller builds the stale hybrid
    // (logbook solar + latest-known wind) instead of serving a stale real
    // forecast as if it were fresh.
    const fetchedAt = newestFetchAt || now;
    if (now - fetchedAt > this.forecastCacheHours * 3600000) {
      this.app.debug(
        `Restore: cached forecast is ${Math.round((now - fetchedAt) / 3600000)}h old (older than ${this.forecastCacheHours}h) — leaving for the stale hybrid`,
      );
      return null;
    }

    this.currentTier = bestTier;
    // Use the newest file mtime as the fetch-time proxy (the cache stores no
    // fetch timestamp; writeWeatherCache rewrites the file on every fetch).
    this.lastFetchTime = new Date(fetchedAt);
    this.lastForecast = this.postProcessForecast(inHorizon);
    this.app.debug(
      `Restored ${this.lastForecast.length} forecast points from disk (best tier ${bestTier}, fetched ~${Math.round((now - this.lastFetchTime.getTime()) / 3600000)}h ago)`,
    );
    return this.lastForecast;
  }

  /**
   * Builds the stale-boundary hybrid forecast (work doc #15 update #2).
   *
   * Used when the on-disk cache is older than `forecastCacheHours` and there
   * is no uplink: no real (forward) forecast is available, so we produce an
   * honest "what we know now" forecast:
   *
   *   - **Solar (GHI):** synthesized from the latest logbook cloud-cover
   *     observation via Kasten-Czeplak (reuses the tier-3 logbook path). Falls
   *     to Clear Sky if logbook has no observations.
   *   - **Wind:** latest-known live Signal K wind (`environment.wind.speedTrue`,
   *     `directionTrue`, gust) held constant across the horizon. Not a
   *     forecast — a nowcast assumed to persist — tagged `source: "latest-known"`
   *     so downstream consumers (WPF, advisories) can down-weight.
   *
   * Each point carries a `source` field (`"logbook"` / `"latest-known"` /
   * `"clear-sky"`) so callers can distinguish a real prediction from this
   * nowcast. `currentTier` is set to LOGBOOK (or CLEAR_SKY if no logbook),
   * never to a real-forecast tier.
   *
   * @returns {Promise<ForecastPoint[]>} Hybrid forecast points
   */
  async buildStaleHybridForecast() {
    const { latitude, longitude } = this.position;
    const now = new Date();
    const nowMs = now.getTime();

    // Latest-known wind from live SK state (held constant across horizon).
    const latestWind = {
      speedKnots: toKnots(this.app.getSelfPath("environment.wind.speedTrue")),
      gustKnots: toKnots(this.app.getSelfPath("environment.wind.gust")),
      directionDeg: windDirectionDeg(
        this.app.getSelfPath("environment.wind.directionTrue"),
      ),
    };

    // Solar: try logbook cloud cover first (tier-3 path reuses cached).
    let cloudCover = null;
    let tier = Tier.CLEAR_SKY;
    try {
      // Reuse any cached cloud cover from a prior logbook fetch this session.
      if (this.cachedCloudCover.length > 0) {
        cloudCover =
          this.cachedCloudCover[this.cachedCloudCover.length - 1].cloudCover;
        tier = Tier.LOGBOOK;
      } else {
        const readings = await fetchLogbookCloudCover(this.app, 48);
        this.cachedCloudCover = readings;
        if (readings.length > 0) {
          cloudCover = readings[readings.length - 1].cloudCover;
          tier = Tier.LOGBOOK;
        }
      }
    } catch (error) {
      this.app.debug?.(`Stale hybrid: logbook unavailable: ${error.message}`);
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
        windSpeedKnots: latestWind.speedKnots,
        gustSpeedKnots: latestWind.gustKnots,
        windDirectionDeg: latestWind.directionDeg,
        source,
      });
    }

    this.currentTier = tier;
    this.lastFetchTime = new Date(nowMs);
    this.lastForecast = points;
    this.app.debug(
      `Stale hybrid: ${points.length} points (solar: ${cloudCover != null ? "logbook oktas" : "clear sky"}, wind: latest-known ${latestWind.speedKnots ?? "?"}kn)`,
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
   * Two-layer freshness gate (work doc #15):
   *
   * 1. **Staleness window** (`forecastMaxAgeMs`): tier-1/2 stay usable for
   *    `forecastCacheHours` (default 24 h); tier-3/4 for 15 min. If the
   *    in-memory forecast is younger than its window, serve it.
   * 2. **Uplink cadence**: when the window says a refresh is eligible, the
   *    *attempt* frequency is capped by uplink status — immediate on the
   *    offline→online edge, ~1 h while online, ~24 h probe while offline.
   *    The 60 s `minFetchIntervalMs` floor still applies.
   *
   * The `maxAgeMinutes` argument is kept for backward compatibility but
   * ignored in favor of the tier-aware window — callers should not pass it.
   *
   * @param {number} [_maxAgeMinutes] - ignored (tier-aware window is used)
   * @returns {Promise<ForecastPoint[]>} Forecast points
   */
  async getForecast(_maxAgeMinutes) {
    const maxAge = this.forecastMaxAgeMs();

    // Return cached forecast if still within its tier's staleness window.
    if (
      this.lastFetchTime &&
      this.lastForecast.length > 0 &&
      Date.now() - this.lastFetchTime.getTime() < maxAge
    ) {
      this.app.debug(
        `Using cached forecast (age: ${Math.round((Date.now() - this.lastFetchTime.getTime()) / 60000)}min, tier: ${this.currentTier}, points: ${this.lastForecast.length}, first: ${this.lastForecast[0]?.time.toISOString()})`,
      );
      return this.lastForecast;
    }

    // A refresh is eligible. Gate the *attempt* by uplink cadence so we
    // don't hammer a dead network all day offshore (work doc #15 update #1).
    const now = Date.now();
    if (this.uplinkOnline) {
      if (now - this.lastOnlineFetchAttempt < UPLINK_ONLINE_FETCH_INTERVAL_MS) {
        this.app.debug(
          `Forecast eligible but uplink refetched recently; serving stale in-memory forecast`,
        );
        return this.lastForecast;
      }
    } else {
      if (
        this.lastFetchAttempt &&
        now - this.lastFetchAttempt.getTime() < UPLINK_OFFLINE_PROBE_MS
      ) {
        this.app.debug(
          `Forecast eligible but no uplink and offline probe rate-limited; serving stale in-memory forecast`,
        );
        return this.lastForecast;
      }
    }

    // 60 s floor: a failed fetch must not be retried more than once a minute.
    if (
      this.lastFetchAttempt &&
      now - this.lastFetchAttempt.getTime() < this.minFetchIntervalMs
    ) {
      return this.lastForecast;
    }

    this.lastFetchAttempt = new Date(now);
    if (this.uplinkOnline) this.lastOnlineFetchAttempt = now;
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
        gustSpeedKnots: current.gustSpeedKnots,
        tier: this.currentTier,
      };
    }

    // Fallback to clear sky
    const { altitude } = sunPosition(now, latitude, longitude);
    return {
      ghi: maxIrradiance(altitude),
      cloudCover: 0,
      gustSpeedKnots: null,
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
  OPEN_METEO_MAX_ATTEMPTS,
  FORECAST_HOURS,
  MAX_FORECAST_HOURS,
  DEFAULT_FORECAST_CACHE_HOURS,
  UPLINK_ONLINE_FETCH_INTERVAL_MS,
  UPLINK_OFFLINE_PROBE_MS,
};
