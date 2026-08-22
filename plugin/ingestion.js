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
   */
  constructor(app, { forecastHours } = {}) {
    this.app = app;
    this.currentTier = Tier.OPEN_METEO;
    this.forecastHours = Math.min(
      MAX_FORECAST_HOURS,
      Math.max(FORECAST_HOURS, forecastHours ?? FORECAST_HOURS),
    );
    this.lastForecast = [];
    this.lastFetchTime = null;
    this.lastFetchAttempt = null; // Timestamp of last fetch attempt (even if failed)
    this.minFetchIntervalMs = 60000; // Don't retry more often than once per minute
    this.position = { latitude: null, longitude: null };
    this.cachedCloudCover = []; // From logbook, used as fallback for future hours
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

    // Try tiers in order until one succeeds with actual data.
    // Note: empty forecast counts as failure (an empty array is truthy in JS,
    // but carries no data - fall through to the next tier instead).
    for (let tier = Tier.OPEN_METEO; tier <= Tier.CLEAR_SKY; tier++) {
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
        return this.lastForecast;
      }
    }

    // All tiers failed - generate clear sky fallback
    this.app.debug("All forecast tiers failed, falling back to clear sky");
    this.currentTier = Tier.CLEAR_SKY;
    this.lastFetchTime = new Date();
    this.lastForecast = generateClearSkyForecast(
      new Date(),
      this.forecastHours,
      this.position.latitude,
      this.position.longitude,
    );
    this.app.debug(`Generated ${this.lastForecast.length} clear sky points`);
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
   * @param {number} maxAgeMinutes - Maximum age of cached forecast in minutes
   * @returns {Promise<ForecastPoint[]>} Forecast points
   */
  async getForecast(maxAgeMinutes = 15) {
    const maxAge = maxAgeMinutes * 60000;

    // Return cached forecast if still fresh
    if (
      this.lastFetchTime &&
      this.lastForecast.length > 0 &&
      Date.now() - this.lastFetchTime.getTime() < maxAge
    ) {
      this.app.debug(
        `Using cached forecast (age: ${Math.round((Date.now() - this.lastFetchTime.getTime()) / 60000)}min, points: ${this.lastForecast.length}, first: ${this.lastForecast[0]?.time.toISOString()})`,
      );
      return this.lastForecast;
    }

    // Rate limit fetch attempts to avoid spamming the API
    if (
      this.lastFetchAttempt &&
      Date.now() - this.lastFetchAttempt.getTime() < this.minFetchIntervalMs
    ) {
      // We recently tried to fetch, return whatever we have
      return this.lastForecast;
    }

    this.lastFetchAttempt = new Date();
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
};
