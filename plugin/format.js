/**
 * Formatting helpers for human-readable values in advisories and status.
 *
 * @file format.js
 */

/**
 * Derives a solar-local UTC offset (minutes, east positive) from a
 * longitude. The crew experiences time relative to the sun, not the
 * server's or browser's civil timezone, and a vessel's civil zone (if set
 * at all) can lag the sun by up to an hour on a schedule the predictor
 * doesn't control. Longitude-derived solar-local is used as a stand-in
 * until Signal K exposes a vessel timezone / ship's-time offset.
 *
 * Rounded to the nearest whole minute so 25.0°E -> +01:40 exactly and a
 * vessel drifting a few hundred metres doesn't churn the rendered time.
 *
 * @param {number|null|undefined} longitude - Longitude in degrees, or
 *        null/NaN when the position is unknown
 * @returns {number|null} Offset in minutes, or null (no position)
 */
function solarOffsetMinutesFromLongitude(longitude) {
  if (longitude == null || Number.isNaN(longitude)) return null;
  return Math.round((longitude / 15) * 60);
}

/**
 * Formats a `Date` as `HH:MM` (24h) in solar-local time given a UTC offset
 * in minutes, using UTC getters against the shifted instant. This avoids
 * any dependency on the host's `Intl` timezone database (which on a
 * UTC-locked marine server would otherwise render everything in UTC).
 *
 * @param {Date|number} when - Instant to format
 * @param {number} [offsetMinutes=0] - Solar-local offset from UTC in minutes
 * @returns {string}
 */
function formatLocalHHMM(when, offsetMinutes = 0) {
  const t = when instanceof Date ? when.getTime() : when;
  const shifted = new Date(t + offsetMinutes * 60 * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Formats a `Date`'s local calendar day as `Mon D` in solar-local time.
 *
 * @param {Date|number} when - Instant to format
 * @param {number} [offsetMinutes=0] - Solar-local offset from UTC in minutes
 * @returns {string}
 */
function formatLocalMonthDay(when, offsetMinutes = 0) {
  const t = when instanceof Date ? when.getTime() : when;
  const shifted = new Date(t + offsetMinutes * 60 * 1000);
  const month = shifted.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  const day = shifted.getUTCDate();
  return `${month} ${day}`;
}

/**
 * Formats an energy value in watt-hours for display.
 * Whole watt-hours below 1 kWh, one-decimal kWh at and above.
 *
 * @param {number} wh - Energy in watt-hours
 * @returns {string} e.g. "850Wh", "3.5kWh"
 */
function formatWh(wh) {
  if (wh >= 1000) {
    return `${(wh / 1000).toFixed(1)}kWh`;
  }
  return `${Math.round(wh)}Wh`;
}

module.exports = {
  formatWh,
  solarOffsetMinutesFromLongitude,
  formatLocalHHMM,
  formatLocalMonthDay,
};
