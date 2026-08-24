/**
 * Window selector: day/week/month presets with prev/next navigation and a
 * date picker. Emits `ep-window-change` events with {mode, from, to}.
 *
 * Windows are anchored to the vessel's solar-local midnight so "a day" is
 * the sun-day the crew actually experiences (what the advisory dedup keys
 * on) — not the browser's civil timezone. The solar-local UTC offset
 * (minutes, east positive) is supplied by the app from `/api/vessel`;
 * when unknown (null) the browser timezone is used as a fallback.
 *
 * - Day: a single sun-day.
 * - Week: Monday to Sunday (the week containing the anchor date).
 * - Month: the 1st to the last day of the calendar month containing the
 *   anchor date.
 *
 * Stepping (prev/next) and "Today" move by whole calendar units, so a
 * month steps to the previous/next calendar month and a week steps to
 * the previous/next Monday-anchored week.
 *
 * The selected preset persists in localStorage (ep:prefs) so the webapp
 * reopens on the last used window.
 */
const MODES = /** @type {const} */ (["day", "week", "month"]);

/** Milliseconds per day */
const MS_PER_DAY = 24 * 3600000;

/** JS getDay(): 0 = Sunday … 6 = Saturday; Monday is day 1. */
const MONDAY = 1;

/**
 * Solar-local wall-clock date (y, m, d) of an instant under the given
 * offset. `offsetMinutes` is east-positive; null falls back to the
 * browser's local date. Mirrors `solarDayKey` in ep-solar-time.js but
 * returns the numeric fields for calendar arithmetic.
 * @param {Date} inst
 * @param {number|null} offsetMinutes
 * @returns {{y: number, m: number, d: number}}
 */
function solarDateOf(inst, offsetMinutes) {
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
 * UTC instant of solar-local midnight for a solar-local calendar date.
 * `offsetMinutes` is east-positive; null falls back to browser-local
 * midnight. At UTC−10, solar midnight of Aug 23 is 10:00 UTC
 * (Date.UTC(2026,7,23) − (−600)·60·1000).
 * @param {number} y - solar-local full year
 * @param {number} m - solar-local month (0-based, JS convention)
 * @param {number} d - solar-local day-of-month
 * @param {number|null} offsetMinutes
 * @returns {Date}
 */
function solarMidnightOf(y, m, d, offsetMinutes) {
  if (offsetMinutes == null) {
    return new Date(y, m, d);
  }
  return new Date(Date.UTC(y, m, d) - offsetMinutes * 60 * 1000);
}

/**
 * Local-midnight start of the day, week, or month containing the anchor,
 * as a solar-local-midnight UTC instant. `anchor` is a solar-local-midnight
 * instant; the returned start is the inclusive lower bound of the window.
 * @param {string} mode
 * @param {Date} anchor - solar-local-midnight instant
 * @param {number|null} offsetMinutes
 * @returns {Date}
 */
function windowStart(mode, anchor, offsetMinutes) {
  const { y, m, d } = solarDateOf(anchor, offsetMinutes);
  if (mode === "week") {
    // JS day-of-week of the solar-local date: 0 = Sunday … 6 = Saturday.
    const dow =
      offsetMinutes == null
        ? anchor.getDay()
        : new Date(anchor.getTime() + offsetMinutes * 60 * 1000).getUTCDay();
    const back = (dow - MONDAY + 7) % 7;
    return solarMidnightOf(y, m, d - back, offsetMinutes);
  }
  if (mode === "month") {
    return solarMidnightOf(y, m, 1, offsetMinutes);
  }
  return solarMidnightOf(y, m, d, offsetMinutes);
}

/**
 * Exclusive upper bound (solar-local midnight) of the window starting at
 * `start`.
 * @param {string} mode
 * @param {Date} start - solar-local-midnight window start
 * @param {number|null} offsetMinutes
 * @returns {Date}
 */
function windowEnd(mode, start, offsetMinutes) {
  if (mode === "week") {
    return new Date(start.getTime() + 7 * MS_PER_DAY);
  }
  if (mode === "month") {
    const { y, m } = solarDateOf(start, offsetMinutes);
    return solarMidnightOf(y, m + 1, 1, offsetMinutes);
  }
  return new Date(start.getTime() + MS_PER_DAY);
}

/**
 * Anchor date one calendar unit away from `anchor` in `direction`, as a
 * solar-local-midnight instant.
 * @param {string} mode
 * @param {Date} anchor - solar-local-midnight instant
 * @param {number} direction - +1 forward, -1 back
 * @param {number|null} offsetMinutes
 * @returns {Date}
 */
function stepAnchor(mode, anchor, direction, offsetMinutes) {
  const { y, m, d } = solarDateOf(anchor, offsetMinutes);
  if (mode === "week") {
    return solarMidnightOf(y, m, d + 7 * direction, offsetMinutes);
  }
  if (mode === "month") {
    return solarMidnightOf(y, m + direction, 1, offsetMinutes);
  }
  return solarMidnightOf(y, m, d + direction, offsetMinutes);
}

class EpWindowSelector extends HTMLElement {
  constructor() {
    super();
    /** @type {string} */
    this.mode = "day";
    /** @type {number|null} Solar-local UTC offset in minutes (east
     *  positive). Set by the app from `/api/vessel`. Null = use the
     *  browser's timezone (fallback when the vessel position is unknown). */
    this.solarOffsetMinutes = null;
    /** @type {Date} Solar-local-midnight start of window */
    this.from = EpWindowSelector.solarMidnightToday(this.solarOffsetMinutes);
  }

  /**
   * Solar-local midnight for "now": the start of the sun-day containing
   * the current instant, as a UTC instant (the value sent to the server as
   * the window lower bound). At UTC−10, solar-local midnight is 10:00 UTC,
   * not 00:00 UTC. When `offsetMinutes` is null the browser's local
   * midnight is used (fallback).
   * @param {number|null} offsetMinutes
   * @returns {Date}
   */
  static solarMidnightToday(offsetMinutes) {
    const now = new Date();
    if (offsetMinutes == null) {
      // Browser-local fallback (legacy behaviour)
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    const { y, m, d } = solarDateOf(now, offsetMinutes);
    return solarMidnightOf(y, m, d, offsetMinutes);
  }

  connectedCallback() {
    this.loadPrefs();
    this.loadHash();
    this.render();
    window.addEventListener("hashchange", this.onHashChange);
  }

  disconnectedCallback() {
    window.removeEventListener("hashchange", this.onHashChange);
  }

  onHashChange = () => {
    // Reacting to a hashchange: reload state without writing the hash back
    this.loadHash();
    this.render();
    this.emit(false);
  };

  /** Restore mode and window start from the URL hash, if present. */
  loadHash() {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const mode = params.get("mode");
    if (MODES.includes(mode)) {
      this.mode = mode;
    }
    const date = params.get("date");
    if (date) {
      const [y, m, d] = date.split("-").map(Number);
      if (y && m && d) {
        // Hash date is a solar-local calendar date (YYYY-MM-DD). Build the
        // solar-local-midnight UTC instant for that date.
        this.from = solarMidnightOf(y, m - 1, d, this.solarOffsetMinutes);
      }
    }
  }

  /** Write the current selection to the URL hash. */
  saveHash() {
    const { y, m, d } = solarDateOf(this.from, this.solarOffsetMinutes);
    const date = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const hash = `mode=${this.mode}&date=${date}`;
    if (window.location.hash !== `#${hash}`) {
      window.location.hash = hash;
    }
  }

  loadPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem("ep:prefs") || "{}");
      if (MODES.includes(prefs.mode)) {
        this.mode = prefs.mode;
      }
    } catch {
      // Corrupt prefs: keep defaults
    }
  }

  savePrefs() {
    try {
      localStorage.setItem("ep:prefs", JSON.stringify({ mode: this.mode }));
    } catch {
      // localStorage unavailable: non-fatal
    }
  }

  /** @returns {{mode: string, from: string, to: string}} */
  windowSpec() {
    const start = windowStart(this.mode, this.from, this.solarOffsetMinutes);
    const end = windowEnd(this.mode, start, this.solarOffsetMinutes);
    return {
      mode: this.mode,
      from: start.toISOString(),
      to: end.toISOString(),
    };
  }

  /**
   * Emits a window-change event and persists state.
   * @param {boolean} updateHash - whether to sync the URL hash (false when
   *   reacting to a hashchange so we don't loop)
   */
  emit(updateHash = true) {
    this.savePrefs();
    if (updateHash) {
      this.saveHash();
    }
    this.dispatchEvent(
      new CustomEvent("ep-window-change", { detail: this.windowSpec() }),
    );
  }

  /** @param {string} mode */
  setMode(mode) {
    this.mode = mode;
    this.render();
    this.emit();
  }

  /**
   * Steps the window by one calendar unit (day / week / month), keeping
   * the solar-local-midnight anchor.
   * @param {number} direction - +1 forward, -1 back
   */
  step(direction) {
    this.from = stepAnchor(
      this.mode,
      this.from,
      direction,
      this.solarOffsetMinutes,
    );
    this.render();
    this.emit();
  }

  /** Jump the window to today (solar-local midnight). */
  today() {
    this.from = EpWindowSelector.solarMidnightToday(this.solarOffsetMinutes);
    this.render();
    this.emit();
  }

  /** @param {string} isoDate - YYYY-MM-DD (solar-local) from the date picker */
  jumpTo(isoDate) {
    const [y, m, d] = isoDate.split("-").map(Number);
    if (!y || !m || !d) {
      return;
    }
    this.from = solarMidnightOf(y, m - 1, d, this.solarOffsetMinutes);
    this.render();
    this.emit();
  }

  /**
   * Sets the vessel's solar-local UTC offset (from `/api/vessel`) and
   * re-anchors the current window to solar-local midnight. Called by the
   * app once on load; when the offset is null (position unknown) the
   * browser timezone is kept as a fallback. Re-emits so the app refetches
   * with the corrected window bounds.
   * @param {number|null} offsetMinutes
   */
  setSolarOffsetMinutes(offsetMinutes) {
    if (offsetMinutes === this.solarOffsetMinutes) return;
    // Preserve the picked solar-local calendar date across the offset
    // change: extract the solar-local date under the *old* offset and
    // re-anchor at solar-local midnight under the *new* offset, so the
    // same day stays selected while its UTC instant moves to the correct
    // solar midnight.
    const { y, m, d } = solarDateOf(this.from, this.solarOffsetMinutes);
    this.solarOffsetMinutes = offsetMinutes;
    this.from = solarMidnightOf(y, m, d, offsetMinutes);
    this.render();
    this.emit();
  }

  render() {
    const { y, m, d } = solarDateOf(this.from, this.solarOffsetMinutes);
    const inputDate = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    this.innerHTML = "";

    for (const mode of MODES) {
      const btn = document.createElement("button");
      btn.textContent =
        mode === "day" ? "Day" : mode === "week" ? "Week" : "Month";
      btn.setAttribute("aria-pressed", String(this.mode === mode));
      btn.addEventListener("click", () => this.setMode(mode));
      this.appendChild(btn);
    }

    const prev = document.createElement("button");
    prev.className = "nav";
    prev.textContent = "‹";
    prev.setAttribute("aria-label", "Previous");
    prev.addEventListener("click", () => this.step(-1));
    this.appendChild(prev);

    const picker = document.createElement("input");
    picker.type = "date";
    picker.value = inputDate;
    picker.addEventListener("change", () => this.jumpTo(picker.value));
    this.appendChild(picker);

    const next = document.createElement("button");
    next.className = "nav";
    next.textContent = "›";
    next.setAttribute("aria-label", "Next");
    next.addEventListener("click", () => this.step(1));
    this.appendChild(next);

    const today = document.createElement("button");
    today.textContent = "Today";
    today.setAttribute("aria-label", "Jump to today");
    today.addEventListener("click", () => this.today());
    this.appendChild(today);
  }
}

customElements.define("ep-window-selector", EpWindowSelector);

export { EpWindowSelector };
