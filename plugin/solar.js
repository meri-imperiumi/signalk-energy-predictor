/**
 * Solar position calculations using @openwaters/almanac.
 * Computes sun position (altitude, azimuth) for a given time and location.
 *
 * All angles are in radians, altitudes in range [-π/2, π/2],
 * azimuths in range [-π, π] where 0 is north, positive eastward.
 *
 * Almanac covers 1950-01-01 through 2100-01-01 UTC; instants outside that
 * interval, and invalid dates, produce NaN from sunPosition() and null from
 * the sunrise/sunset searches, instead of throwing.
 *
 * @file solar.js
 */

const { sunAltAz, sunEvents, sunTransits } = require("@openwaters/almanac");

/**
 * Solar constant (W/m² at mean Earth-Sun distance)
 */
const SOLAR_CONSTANT = 1367;

/**
 * Earth's atmospheric transmittance at sea level for clear sky
 */
const CLEAR_SKY_TRANSMITTANCE = 0.75;

/**
 * How far from the given instant to search for the next sunrise or sunset.
 * Two days covers every non-polar case; polar day or night returns null
 * exactly like the old SunCalc-based behavior did.
 */
const EVENT_SEARCH_WINDOW_MS = 48 * 3600000;

const DEG_TO_RAD = Math.PI / 180;

/**
 * How far the Sun's center sits below its upper limb, for telling polar day
 * from polar night.
 */
const SUN_SEMIDIAMETER_DEG = 0.27;

/**
 * Calculates solar altitude (elevation) and azimuth using Almanac.
 *
 * Almanac returns degrees, azimuth measured from north clockwise through
 * east (0 = north, π/2 = east), which already is the nautical convention.
 * We convert to radians and normalize to [-π, π).
 *
 * @param {Date} date - Date/time (UTC)
 * @param {number} latitude - Latitude in degrees (positive north)
 * @param {number} longitude - Longitude in degrees (positive east)
 * @returns {{altitude: number, azimuth: number}} Altitude in radians (0 at horizon, positive upward),
 *          azimuth in radians (0 = north, π/2 = east, π/-π = south, -π/2 = west).
 *          NaN for both when the date is invalid or outside Almanac's
 *          supported range.
 */
function sunPosition(date, latitude, longitude) {
  try {
    const { azDeg, altDeg } = sunAltAz(date, {
      latitudeDeg: latitude,
      longitudeDeg: longitude,
    });

    // Almanac azimuth: 0 = north, clockwise positive in degrees [0, 360)
    // nautical azimuth: 0 = north, clockwise positive, normalized to [-π, π)
    let azimuth = azDeg * DEG_TO_RAD;
    while (azimuth >= Math.PI) {
      azimuth -= 2 * Math.PI;
    }
    while (azimuth < -Math.PI) {
      azimuth += 2 * Math.PI;
    }

    return { altitude: altDeg * DEG_TO_RAD, azimuth };
  } catch (err) {
    // AlmanacOutOfRangeError extends RangeError; invalid dates also throw
    // RangeError. SunCalc degraded to NaN in these cases, so we do too.
    if (err instanceof RangeError) {
      return { altitude: NaN, azimuth: NaN };
    }
    throw err;
  }
}

/**
 * The solar day around a date, in the SunCalc `getTimes(date, lat, lng)`
 * sense: from the Sun's lower transit before the upper transit nearest the
 * date to the lower transit after it. A day can hold two of an event; like
 * SunCalc's one-field-per-name shape, only the first is reported.
 *
 * @param {Date} date - Date the day is centered on (UTC)
 * @param {{latitudeDeg: number, longitudeDeg: number}} observer
 * @returns {{start: Date, end: Date, noon: Date}|null} Half-open window
 *          bounds and the upper transit at the middle, or null when Almanac
 *          finds no transit in range
 */
function solarDay(date, observer) {
  const DAY_MS = 24 * 3600000;
  const t = date.getTime();
  const transits = sunTransits(
    new Date(t - 1.5 * DAY_MS),
    new Date(t + 1.5 * DAY_MS),
    observer,
  );
  const uppers = transits.filter((e) => e.kind === "upper");
  if (uppers.length === 0) {
    return null;
  }
  const noon = uppers.reduce((best, e) =>
    Math.abs(e.time.getTime() - t) < Math.abs(best.time.getTime() - t)
      ? e
      : best,
  ).time;
  const lowers = transits.filter((e) => e.kind === "lower").map((e) => e.time);
  const start = lowers.filter((d) => d < noon).at(-1);
  const end = lowers.find((d) => d > noon);
  if (!start || !end) {
    return null;
  }
  return { start, end, noon };
}

/**
 * Sunrise and sunset for the solar day around the given date, mirroring the
 * part of SunCalc's `getTimes(date, lat, lng)` this plugin used.
 *
 * @param {Date} date - Date the day is centered on (UTC)
 * @param {number} latitude - Latitude in degrees (positive north)
 * @param {number} longitude - Longitude in degrees (positive east)
 * @returns {{sunrise: Date|null, sunset: Date|null, alwaysUp: boolean, alwaysDown: boolean}}
 *          Event times, null when the Sun does not reach the horizon that
 *          day; `alwaysUp`/`alwaysDown` tell polar day from polar night.
 *          Null sunrise/sunset and false flags when the date is invalid or
 *          outside Almanac's supported range.
 */
function sunTimes(date, latitude, longitude) {
  const observer = { latitudeDeg: latitude, longitudeDeg: longitude };
  try {
    const day = solarDay(date, observer);
    if (!day) {
      return {
        sunrise: null,
        sunset: null,
        alwaysUp: false,
        alwaysDown: false,
      };
    }
    const events = sunEvents(day.start, day.end, observer);
    const sunrise = events.find((e) => e.kind === "rise")?.time ?? null;
    const sunset = events.find((e) => e.kind === "set")?.time ?? null;
    if (sunrise === null || sunset === null) {
      // No rise or set all day, so the Sun stays on one side of the horizon:
      // look at the upper transit to tell polar day from polar night.
      const up = sunAltAz(day.noon, observer).altDeg + SUN_SEMIDIAMETER_DEG > 0;
      return {
        sunrise: null,
        sunset: null,
        alwaysUp: up,
        alwaysDown: !up,
      };
    }
    return { sunrise, sunset, alwaysUp: false, alwaysDown: false };
  } catch (err) {
    // AlmanacOutOfRangeError extends RangeError; invalid dates also throw
    // RangeError. SunCalc returned invalid dates here, which callers of
    // getSunPhase treated as "no usable times".
    if (err instanceof RangeError) {
      return {
        sunrise: null,
        sunset: null,
        alwaysUp: false,
        alwaysDown: false,
      };
    }
    throw err;
  }
}

/**
 * Calculates the maximum clear-sky Global Horizontal Irradiance (GHI)
 * for a given solar altitude.
 *
 * @param {number} altitudeRad - Solar altitude in radians
 * @returns {number} GHI in W/m²
 */
function maxIrradiance(altitudeRad) {
  const sinAlt = Math.sin(altitudeRad);
  if (sinAlt <= 0) {
    return 0;
  }
  return SOLAR_CONSTANT * CLEAR_SKY_TRANSMITTANCE * sinAlt;
}

/**
 * Calculates GHI from cloud cover using Kasten-Czeplak attenuation.
 *
 * Formula: GHI = GHI_clear * (1 - 0.75 * C^3.4)
 * Where C is cloud cover fraction [0, 1]
 *
 * @param {number} altitudeRad - Solar altitude in radians
 * @param {number} cloudCover - Cloud cover fraction [0, 1]
 * @returns {number} GHI in W/m²
 */
function irradianceFromCloudCover(altitudeRad, cloudCover) {
  const ghiClear = maxIrradiance(altitudeRad);
  const c = Math.max(0, Math.min(1, cloudCover));
  const attenuation = 1 - 0.75 * c ** 3.4;
  return ghiClear * attenuation;
}

/**
 * Searches a window for the first event of a kind strictly after a given
 * instant, or the last one at or before it.
 *
 * Almanac reports a missing event by leaving it out of the list, so polar
 * day or night simply yields no matching event and null is returned.
 *
 * @param {Date} date - Boundary instant (UTC)
 * @param {"rise"|"set"} kind - Event kind to look for
 * @param {"after"|"before"} direction - Whether to find the first event
 *        strictly after or the last event at or before the boundary
 * @param {number} latitude - Latitude in degrees (positive north)
 * @param {number} longitude - Longitude in degrees (positive east)
 * @returns {Date|null} Event time, or null when none exists in the window
 *          (polar regions, or dates outside Almanac's supported range)
 */
function findSunEvent(date, kind, direction, latitude, longitude) {
  const observer = { latitudeDeg: latitude, longitudeDeg: longitude };
  try {
    const events =
      direction === "after"
        ? sunEvents(
            date,
            new Date(date.getTime() + EVENT_SEARCH_WINDOW_MS),
            observer,
          )
        : sunEvents(
            new Date(date.getTime() - EVENT_SEARCH_WINDOW_MS),
            date,
            observer,
          );
    const matches = events.filter((event) => event.kind === kind);
    const event =
      direction === "after"
        ? matches.find((e) => e.time > date)
        : matches.findLast((e) => e.time <= date);
    return event ? event.time : null;
  } catch (err) {
    // AlmanacOutOfRangeError extends RangeError; invalid dates also throw
    // RangeError. Missing events are absent from Almanac's lists, so null
    // covers polar day and night the same way as out-of-range dates.
    if (err instanceof RangeError) {
      return null;
    }
    throw err;
  }
}

/**
 * Calculates the next sunrise time after the given date.
 *
 * @param {Date} date - Starting date (typically now or sunset)
 * @param {number} latitude - Latitude in degrees (positive north)
 * @param {number} longitude - Longitude in degrees (positive east)
 * @returns {Date|null} Next sunrise time, or null if no sunrise in near future (polar regions)
 */
function nextSunrise(date, latitude, longitude) {
  return findSunEvent(date, "rise", "after", latitude, longitude);
}

/**
 * Calculates the next sunset time after the given date.
 *
 * @param {Date} date - Starting date
 * @param {number} latitude - Latitude in degrees (positive north)
 * @param {number} longitude - Longitude in degrees (positive east)
 * @returns {Date|null} Next sunset time, or null if no sunset in near future (polar regions)
 */
function nextSunset(date, latitude, longitude) {
  return findSunEvent(date, "set", "after", latitude, longitude);
}

/**
 * Calculates the most recent sunset at or before the given date.
 * For a time at night, this is the sunset that started that night.
 *
 * @param {Date} date - Starting date
 * @param {number} latitude - Latitude in degrees (positive north)
 * @param {number} longitude - Longitude in degrees (positive east)
 * @returns {Date|null} Previous sunset time, or null if none found (polar regions)
 */
function lastSunset(date, latitude, longitude) {
  return findSunEvent(date, "set", "before", latitude, longitude);
}

module.exports = {
  sunPosition,
  sunTimes,
  nextSunrise,
  nextSunset,
  lastSunset,
  maxIrradiance,
  irradianceFromCloudCover,
  SOLAR_CONSTANT,
  CLEAR_SKY_TRANSMITTANCE,
};
