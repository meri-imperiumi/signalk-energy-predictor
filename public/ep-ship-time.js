/**
 * Ship's-time formatting for the webapp.
 *
 * A surplus at ship's 14:12 must render as 14:12 everywhere — the window
 * selector's day boundaries, the chart axis, the tooltip, and the Events
 * list — or the pieces disagree and "today" doesn't match what the crew
 * sees on deck.
 *
 * The UTC offset (minutes, east positive) is the vessel's onboard timezone
 * (`environment.time.timezoneOffset`, `(-)hhmm` encoding) published by
 * `@meri-imperiumi/signalk-ships-time` and surfaced by the plugin's
 * `/api/vessel` endpoint. When it is null (ships-time plugin absent or not
 * yet published) the browser's own timezone is used as a fallback so the
 * UI still works.
 *
 * All formatters take an epoch-ms instant and return a string in the
 * ship's-time frame. They shift the instant by the offset and format with
 * UTC getters — avoiding any dependency on the host's Intl timezone
 * database (which on a UTC-locked marine server would render everything
 * in UTC). This mirrors the plugin's server-side `formatLocalHHMM` /
 * `formatLocalMonthDay` helpers.
 */

/**
 * Formats an instant as `HH:MM` (24h) in ship's time.
 * @param {number} t - epoch ms
 * @param {number|null} offsetMinutes - UTC offset (min, east positive);
 *        null uses the browser timezone
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
 * Formats an instant as `D/M` (ship's time) for chart axis day labels.
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
 * Formats an instant as a short date+time string (ship's time), matching
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
 * Ship's-time wall-clock calendar date of an instant under the given
 * offset. `offsetMinutes` is east positive; null falls back to the
 * browser's local date. Returns the numeric fields (m 0-based per JS
 * convention) for the calendar arithmetic the window selector does
 * (stepping days, week/month anchoring) — the numeric counterpart of
 * {@link shipDayKey}'s YYYY-MM-DD string.
 * @param {Date|number} t - epoch ms or Date
 * @param {number|null} offsetMinutes
 * @returns {{y: number, m: number, d: number}}
 */
export function shipDateOf(t, offsetMinutes) {
  const inst = t instanceof Date ? t : new Date(t);
  if (offsetMinutes == null) {
    return { y: inst.getFullYear(), m: inst.getMonth(), d: inst.getDate() };
  }
  const shifted = new Date(inst.getTime() + offsetMinutes * 60 * 1000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
  };
}

/**
 * Epoch-ms instant of ship's-time midnight for a ship's-time calendar
 * date (m 0-based). At UTC−10, midnight of Aug 23 is 10:00 UTC:
 * `Date.UTC(y, m, d) − offset·60·1000` — the offset is *subtracted* to
 * move the wall clock back to UTC. Null offset falls back to
 * browser-local midnight.
 * @param {number} y - ship's-time full year
 * @param {number} m - ship's-time month (0-based, JS convention)
 * @param {number} d - ship's-time day-of-month
 * @param {number|null} offsetMinutes
 * @returns {number}
 */
export function shipMidnightOf(y, m, d, offsetMinutes) {
  if (offsetMinutes == null) {
    return new Date(y, m, d).getTime();
  }
  return Date.UTC(y, m, d) - offsetMinutes * 60 * 1000;
}

/**
 * Epoch-ms instant of ship's-time midnight for the ship's-time day
 * containing `now` — the live-day anchor the window selector follows.
 * `now` is injectable so the rollover arithmetic is testable without a
 * clock. Null offset falls back to browser-local midnight.
 *
 * When the crew changes the onboard timezone (or the ships-time plugin's
 * auto mode follows a zone crossing) the day containing a fixed instant
 * moves to a different calendar date: the anchor must be resolved against
 * the *current* offset, never carried over as a date number.
 * @param {number|null} offsetMinutes
 * @param {Date|number} [now=Date.now()]
 * @returns {number}
 */
export function shipMidnightToday(offsetMinutes, now = Date.now()) {
  const inst = now instanceof Date ? now : new Date(now);
  const { y, m, d } = shipDateOf(inst, offsetMinutes);
  return shipMidnightOf(y, m, d, offsetMinutes);
}

/**
 * Ship's-time calendar-day key (YYYY-MM-DD) for a timestamp — for daily
 * bucketing and bar labels so a ship's day straddling UTC midnight stays
 * in one bucket. Falls back to the browser's local day when the offset is
 * unknown.
 * @param {number} t - epoch ms
 * @param {number|null} offsetMinutes
 * @returns {string}
 */
export function shipDayKey(t, offsetMinutes) {
  const { y, m, d } = shipDateOf(t, offsetMinutes);
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Ship's-time midnight (epoch ms) for a YYYY-MM-DD key — the inverse of
 * {@link shipDayKey}. Falls back to browser-local midnight.
 * @param {string} day - YYYY-MM-DD (ship's time)
 * @param {number|null} offsetMinutes
 * @returns {number}
 */
export function shipDayStart(day, offsetMinutes) {
  const [y, m, d] = day.split("-").map(Number);
  return shipMidnightOf(y, m - 1, d, offsetMinutes);
}
