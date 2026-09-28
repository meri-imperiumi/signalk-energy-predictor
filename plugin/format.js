/**
 * Formatting helpers for human-readable values in advisories and status.
 *
 * @file format.js
 */

/**
 * Parses the `(-)hhmm` encoding the Signal K `environment.json` schema
 * uses for `environment.time.timezoneOffset` into a UTC offset in
 * minutes east of UTC: 200 -> 120, -930 -> -570, 0 -> 0. This is the
 * ship's time published by `@meri-imperiumi/signalk-ships-time` — the
 * timezone the crew's clocks aboard keep — not the server's or browser's
 * civil zone.
 *
 * @param {number|string|null|undefined} hhmm - Offset in `(-)hhmm`
 *        encoding, or null/NaN when unpublished
 * @returns {number|null} Offset in minutes, or null (no value)
 */
function offsetMinutesFromHhmm(hhmm) {
  if (hhmm == null || hhmm === "") return null;
  const encoded = Number(hhmm);
  if (Number.isNaN(encoded)) return null;
  const sign = encoded < 0 ? -1 : 1;
  const abs = Math.abs(Math.round(encoded));
  return sign * (Math.floor(abs / 100) * 60 + (abs % 100));
}

/**
 * Formats a `Date` as `HH:MM` (24h) in ship's time given a UTC offset in
 * minutes, using UTC getters against the shifted instant. This avoids any
 * dependency on the host's `Intl` timezone database (which on a UTC-locked
 * marine server would otherwise render everything in UTC).
 *
 * @param {Date|number} when - Instant to format
 * @param {number} [offsetMinutes=0] - Ship's-time offset from UTC in minutes
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
 * Formats a `Date`'s local calendar day as `Mon D` in ship's time.
 *
 * @param {Date|number} when - Instant to format
 * @param {number} [offsetMinutes=0] - Ship's-time offset from UTC in minutes
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
  offsetMinutesFromHhmm,
  formatLocalHHMM,
  formatLocalMonthDay,
};
