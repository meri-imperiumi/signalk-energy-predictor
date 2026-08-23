/**
 * Window selector: day/week/month presets with prev/next navigation and a
 * date picker. Emits `ep-window-change` events with {mode, from, to}.
 *
 * Windows are anchored to the browser's local midnight so "a day" is the
 * user's actual day; the API receives UTC ISO timestamps as usual.
 *
 * The selected preset persists in localStorage (ep:prefs) so the webapp
 * reopens on the last used window.
 */
const MODES = /** @type {const} */ (["day", "week", "month"]);

/** Milliseconds per day */
const MS_PER_DAY = 24 * 3600000;

/**
 * Window span in days for each mode.
 * @param {string} mode
 * @returns {number}
 */
function modeDays(mode) {
  if (mode === "week") {
    return 7;
  }
  if (mode === "month") {
    return 30;
  }
  return 1;
}

class EpWindowSelector extends HTMLElement {
  constructor() {
    super();
    /** @type {string} */
    this.mode = "day";
    /** @type {Date} Local-midnight start of window */
    this.from = EpWindowSelector.todayLocal();
  }

  static todayLocal() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
        this.from = new Date(y, m - 1, d);
      }
    }
  }

  /** Write the current selection to the URL hash. */
  saveHash() {
    const date = `${this.from.getFullYear()}-${String(this.from.getMonth() + 1).padStart(2, "0")}-${String(this.from.getDate()).padStart(2, "0")}`;
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
    const days = modeDays(this.mode);
    return {
      mode: this.mode,
      from: this.from.toISOString(),
      to: new Date(this.from.getTime() + days * MS_PER_DAY).toISOString(),
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
   * Steps the window by whole days, keeping the local-midnight anchor.
   * @param {number} direction - +1 forward, -1 back
   */
  step(direction) {
    const days = modeDays(this.mode) * direction;
    this.from = new Date(
      this.from.getFullYear(),
      this.from.getMonth(),
      this.from.getDate() + days,
    );
    this.render();
    this.emit();
  }

  /** Jump the window to today (local midnight). */
  today() {
    this.from = EpWindowSelector.todayLocal();
    this.render();
    this.emit();
  }

  /** @param {string} isoDate - YYYY-MM-DD from the date picker */
  jumpTo(isoDate) {
    const [y, m, d] = isoDate.split("-").map(Number);
    if (!y || !m || !d) {
      return;
    }
    this.from = new Date(y, m - 1, d);
    this.render();
    this.emit();
  }

  render() {
    const inputDate = `${this.from.getFullYear()}-${String(this.from.getMonth() + 1).padStart(2, "0")}-${String(this.from.getDate()).padStart(2, "0")}`;
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

export { EpWindowSelector, modeDays };
