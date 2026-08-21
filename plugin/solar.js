/**
 * Solar position calculations using suncalc.
 * Computes sun position (altitude, azimuth) for a given time and location.
 *
 * All angles are in radians, altitudes in range [-π/2, π/2],
 * azimuths in range [-π, π] where 0 is north, positive eastward.
 *
 * @file solar.js
 */

const SunCalc = require("suncalc");

/**
 * Solar constant (W/m² at mean Earth-Sun distance)
 */
const SOLAR_CONSTANT = 1367;

/**
 * Earth's atmospheric transmittance at sea level for clear sky
 */
const CLEAR_SKY_TRANSMITTANCE = 0.75;

/**
 * Calculates solar altitude (elevation) and azimuth using suncalc.
 *
 * Suncalc returns azimuth in radians measured from south, clockwise
 * (0 = south, π/2 = west, π/-π = north, -π/2 = east).
 * We convert to nautical convention: 0 = north, positive clockwise (toward east).
 * This is equivalent to adding π to suncalc's azimuth and normalizing to [-π, π].
 *
 * @param {Date} date - Date/time (UTC)
 * @param {number} latitude - Latitude in degrees (positive north)
 * @param {number} longitude - Longitude in degrees (positive east)
 * @returns {{altitude: number, azimuth: number}} Altitude in radians (0 at horizon, positive upward),
 *          azimuth in radians (0 = north, π/2 = east, π/-π = south, -π/2 = west)
 */
function sunPosition(date, latitude, longitude) {
  const pos = SunCalc.getPosition(date, latitude, longitude);

  // suncalc azimuth: 0 = south, measured clockwise (π/2 = west, π = north, -π/2 = east)
  // nautical azimuth: 0 = north, clockwise positive (π/2 = east, π = south, -π/2 = west)
  // => nautical = suncalc + π
  let azimuth = pos.azimuth + Math.PI;

  // Normalize to [-π, π)
  while (azimuth >= Math.PI) {
    azimuth -= 2 * Math.PI;
  }
  while (azimuth < -Math.PI) {
    azimuth += 2 * Math.PI;
  }

  return { altitude: pos.altitude, azimuth };
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
 * Converts cloud cover from oktas (0-8) to fraction (0-1).
 *
 * @param {number} oktas - Cloud cover in oktas (0-8)
 * @returns {number} Cloud cover fraction (0-1)
 */
function oktasToFraction(oktas) {
  return Math.max(0, Math.min(8, oktas)) / 8;
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
  // Check today and tomorrow: when called after today's sunrise, the next
  // one is tomorrow's (SunCalc returns same-day times for a given date)
  for (const d of [date, new Date(date.getTime() + 24 * 3600000)]) {
    const t = SunCalc.getTimes(d, latitude, longitude).sunrise;
    if (isValidDate(t) && t > date) return t;
  }
  return null;
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
  for (const d of [date, new Date(date.getTime() + 24 * 3600000)]) {
    const t = SunCalc.getTimes(d, latitude, longitude).sunset;
    if (isValidDate(t) && t > date) return t;
  }
  return null;
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
  const t = SunCalc.getTimes(date, latitude, longitude).sunset;
  if (isValidDate(t) && t <= date) return t;
  const prev = SunCalc.getTimes(
    new Date(date.getTime() - 24 * 3600000),
    latitude,
    longitude,
  ).sunset;
  if (isValidDate(prev) && prev <= date) return prev;
  return null;
}

/**
 * Checks whether a value is a valid (non-NaN) Date.
 * SunCalc returns Date objects with NaN time in polar day/night.
 *
 * @param {unknown} d - Value to check
 * @returns {boolean}
 */
function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

module.exports = {
  sunPosition,
  nextSunrise,
  nextSunset,
  lastSunset,
  maxIrradiance,
  irradianceFromCloudCover,
  oktasToFraction,
  SOLAR_CONSTANT,
  CLEAR_SKY_TRANSMITTANCE,
};
