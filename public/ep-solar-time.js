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
 * Why solar-local and not a civil zone: the crew lives by the sun, and a
 * vessel's civil zone offset (if one is even set) can lag the sun by up to
 * an hour and changes on a schedule the predictor doesn't control. There
 * is currently no "ship's time" / on-board local-clock source exposed by
 * Signal K, so longitude-derived solar-local is used as a stand-in. If
 * Signal K later exposes a vessel timezone or an explicit ship's-time
 * offset, this module and `/api/vessel` should switch to it without
 * changing any formatter signatures — the offset is the only thing that
 * needs to be sourced differently.
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
 * Solar-local wall-clock calendar date of an instant under the given
 * offset. `offsetMinutes` is east positive; null falls back to the
 * browser's local date. Returns the numeric fields (m 0-based per JS
 * convention) for the calendar arithmetic the window selector does
 * (stepping days, week/month anchoring) — the numeric counterpart of
 * {@link solarDayKey}'s YYYY-MM-DD string.
 * @param {Date|number} t - epoch ms or Date
 * @param {number|null} offsetMinutes
 * @returns {{y: number, m: number, d: number}}
 */
export function solarDateOf(t, offsetMinutes) {
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
 * Epoch-ms instant of solar-local midnight for a solar-local calendar
 * date (m 0-based). At UTC−10, solar midnight of Aug 23 is 10:00 UTC:
 * `Date.UTC(y, m, d) − offset·60·1000` — the offset is *subtracted* to
 * move the wall clock back to UTC. Null offset falls back to
 * browser-local midnight.
 * @param {number} y - solar-local full year
 * @param {number} m - solar-local month (0-based, JS convention)
 * @param {number} d - solar-local day-of-month
 * @param {number|null} offsetMinutes
 * @returns {number}
 */
export function solarMidnightOf(y, m, d, offsetMinutes) {
  if (offsetMinutes == null) {
    return new Date(y, m, d).getTime();
  }
  return Date.UTC(y, m, d) - offsetMinutes * 60 * 1000;
}

/**
 * Epoch-ms instant of solar-local midnight for the sun-day containing
 * `now` — the live-day anchor the window selector follows. `now` is
 * injectable so the rollover arithmetic is testable without a clock.
 * Null offset falls back to browser-local midnight.
 *
 * Across the date line the longitude-derived offset flips by ~24h, so
 * the sun-day containing a fixed instant moves to a different calendar
 * date: the anchor must be resolved against the *current* offset, never
 * carried over as a date number.
 * @param {number|null} offsetMinutes
 * @param {Date|number} [now=Date.now()]
 * @returns {number}
 */
export function solarMidnightToday(offsetMinutes, now = Date.now()) {
  const inst = now instanceof Date ? now : new Date(now);
  const { y, m, d } = solarDateOf(inst, offsetMinutes);
  return solarMidnightOf(y, m, d, offsetMinutes);
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
  const { y, m, d } = solarDateOf(t, offsetMinutes);
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
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
  return solarMidnightOf(y, m - 1, d, offsetMinutes);
}
