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
 * Suncalc returns azimuth in radians from south (π = south, 0 = north positive eastward).
 * We convert to nautical convention: 0 = north, positive eastward.
 *
 * @param {Date} date - Date/time (UTC)
 * @param {number} latitude - Latitude in degrees (positive north)
 * @param {number} longitude - Longitude in degrees (positive east)
 * @returns {{altitude: number, azimuth: number}} Altitude in radians (0 at horizon, positive upward),
 *          azimuth in radians (0 = north, π/2 = east, π = south, -π/2 = west)
 */
function sunPosition(date, latitude, longitude) {
  const pos = SunCalc.getPosition(date, latitude, longitude);

  // suncalc returns azimuth from south clockwise (π = south, π/2 = west, 3π/2 = east)
  // Convert to nautical: 0 = north, positive eastward
  let azimuth = pos.azimuth - Math.PI / 2;

  // Normalize to [-π, π]
  while (azimuth > Math.PI) {
    azimuth -= 2 * Math.PI;
  }
  while (azimuth <= -Math.PI) {
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
  const attenuation = 1 - 0.75 * Math.pow(c, 3.4);
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

module.exports = {
  sunPosition,
  maxIrradiance,
  irradianceFromCloudCover,
  oktasToFraction,
  SOLAR_CONSTANT,
  CLEAR_SKY_TRANSMITTANCE,
};