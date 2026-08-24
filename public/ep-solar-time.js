/**
 * Solar-local time formatting for the webapp.
 *
 * The crew experiences time relative to the sun, not the server's or
 * browser's civil timezone. A surplus at solar 14:12 must render as
 * 14:12 everywhere — the window selector's day boundaries, the chart
 * axis, the tooltip, and the Events list — or the pieces disagree and
 * "today" doesn't match what the crew sees on deck.
 *
 * The solar-local UTC offset (minutes, east positive) comes from the
 * plugin's `/api/vessel` endpoint (derived from the vessel's longitude).
 * When it is null (position unknown) the browser's own timezone is used
 * as a fallback so the UI still works.
 *
 * All formatters take an epoch-ms instant and return a string in the
 * solar-local frame. They shift the instant by the offset and format
 * with UTC getters — avoiding any dependency on the host's Intl
 * timezone database (which on a UTC-locked marine server would render
 * everything in UTC). This mirrors the plugin's server-side
 * `formatLocalHHMM` / `formatLocalMonthDay` helpers.
 */

/**
 * Formats an instant as `HH:MM` (24h) in solar-local time.
 * @param {number} t - epoch ms
 * @param {number|null} offsetMinutes - solar-local UTC offset (min, east
 *        positive); null uses the browser timezone
 * @returns {string}
 */
export function formatHHMM(t, offsetMinutes) {
  if (offsetMinutes == null) {
    return new Date(t).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  const shifted = new Date(t + offsetMinutes * 60 * 1000);
  return `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(
    shifted.getUTCMinutes(),
  ).padStart(2, "0")}`;
}

/**
 * Formats an instant as `D/M` (solar-local) for chart axis day labels.
 * @param {number} t - epoch ms
 * @param {number|null} offsetMinutes
 * @returns {string}
 */
export function formatDayMonth(t, offsetMinutes) {
  if (offsetMinutes == null) {
    const d = new Date(t);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  }
  const shifted = new Date(t + offsetMinutes * 60 * 1000);
  return `${shifted.getUTCDate()}/${shifted.getUTCMonth() + 1}`;
}

/**
 * Formats an instant as a short date+time string (solar-local), matching
 * `toLocaleString({ dateStyle: "short", timeStyle: "short" })` shape for
 * the Events list and chart tooltip. Falls back to the browser's
 * `toLocaleString` when the offset is unknown.
 * @param {number} t - epoch ms
 * @param {number|null} offsetMinutes
 * @returns {string}
 */
export function formatShortDateTime(t, offsetMinutes) {
  if (offsetMinutes == null) {
    return new Date(t).toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  }
  const shifted = new Date(t + offsetMinutes * 60 * 1000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mi = String(shifted.getUTCMinutes()).padStart(2, "0");
  // Mirror the common short shape `D/M/YYYY, HH:MM` used by en-GB locales;
  // consumers that need a specific locale order can fall back to the
  // null-offset branch above.
  return `${dd}/${mm}/${yyyy}, ${hh}:${mi}`;
}

/**
 * Solar-local calendar-day key (YYYY-MM-DD) for a timestamp — for daily
 * bucketing and bar labels so a sun-day straddling UTC midnight stays in
 * one bucket. Falls back to the browser's local day when the offset is
 * unknown.
 * @param {number} t - epoch ms
 * @param {number|null} offsetMinutes
 * @returns {string}
 */
export function solarDayKey(t, offsetMinutes) {
  if (offsetMinutes == null) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  }
  const shifted = new Date(t + offsetMinutes * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(
    shifted.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Solar-local midnight (epoch ms) for a YYYY-MM-DD key — the inverse of
 * {@link solarDayKey}. Falls back to browser-local midnight.
 * @param {string} day - YYYY-MM-DD (solar-local)
 * @param {number|null} offsetMinutes
 * @returns {number}
 */
export function solarDayStart(day, offsetMinutes) {
  const [y, m, d] = day.split("-").map(Number);
  if (offsetMinutes == null) {
    return new Date(y, m - 1, d).getTime();
  }
  // solar-local midnight shifted back to UTC
  return Date.UTC(y, m - 1, d) - offsetMinutes * 60 * 1000;
}
