/**
 * Application shell: header, reserved status panel slot, window selector,
 * headline figures and the timeline chart. Fetches all API endpoints on
 * window changes and distributes data to the child components.
 *
 * Live updates: subscribes to the plugin's prediction cycle delta via the
 * Signal K stream and refreshes automatically when a new cycle lands.
 */

import { SignalKStream } from "./ep-signalk-stream.js";

const API_BASE = "/plugins/signalk-energy-predictor";

/**
 * Timeout for window-data API fetches. The server-side handlers are
 * local/bounded, but a response can still never land (wedged connection,
 * event loop starved by a heavy cycle): without a client-side deadline
 * `Promise.all` in `refresh()` awaits forever and the chart stays on
 * "Loading…" with no error. On timeout the banner names the endpoint so
 * the culprit is visible, and the stream-driven refresh retries on the
 * next prediction cycle. Generous enough for month windows (92 days of
 * recordings) on a slow single-board computer.
 */
const API_TIMEOUT_MS = 30000;

/** Timeout for the /api/vessel meta fetch (a tiny response). */
const VESSEL_TIMEOUT_MS = 10000;

class EpApp extends HTMLElement {
  constructor() {
    super();
    /** @type {string} */
    this.mode = "day";
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    // Day/night theme reactivity: the host (Signal K shell) normally
    // applies data-mode to the document root from the environment.mode
    // delta; default to day until a delta lands so the UI never renders
    // without a theme.
    if (!document.documentElement.dataset.mode) {
      document.documentElement.dataset.mode = "day";
    }

    const shadow = this.shadowRoot;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "./styles.css";
    shadow.appendChild(link);

    const header = document.createElement("header");
    header.className = "ep-header";
    const h1 = document.createElement("h1");
    h1.textContent = "Energy Predictor";
    const conn = document.createElement("span");
    conn.className = "ep-conn-chip theme-offline";
    conn.textContent = "[ OFFLINE ]";
    const titleWrap = document.createElement("div");
    titleWrap.className = "ep-title";
    titleWrap.append(h1, conn);
    const error = document.createElement("div");
    error.className = "ep-error";
    header.append(titleWrap, error);

    // Reserved for the future status panel (current forecast, weather
    // tier, live advisories — work doc #8 v1 non-goal)
    const statusPanel = document.createElement("div");
    statusPanel.className = "ep-status-panel";

    const selector = document.createElement("ep-window-selector");
    const figures = document.createElement("ep-headline-figures");
    const chart = document.createElement("ep-timeline-chart");
    chart.className = "sk-card theme-teal";
    const actions = document.createElement("ep-actions-list");
    actions.className = "sk-card theme-teal";

    shadow.append(header, statusPanel, selector, figures, chart, actions);

    /** @type {HTMLElement} */
    this.connEl = conn;
    /** @type {ShadowRoot} */
    this.errorEl = error;
    /** @type {HTMLElement} */
    this.figuresEl = figures;
    /** @type {HTMLElement} */
    this.chartEl = chart;
    /** @type {HTMLElement} */
    this.actionsEl = actions;
    /** @type {HTMLElement} */
    this.selectorEl = selector;
    /** @type {number|null} */
    this.timezoneOffsetMinutes = null;
    /** @type {{mode: string, from: string, to: string}|null} Window spec
     *  of the data currently rendered by the chart/actions (null = none,
     *  e.g. after a failed refresh): refresh() keeps the rendered data
     *  visible when re-fetching the same window instead of flashing
     *  "Loading…" over it. */
    this.renderedSpec = null;
    /** @type {number} Monotonic counter for refresh() calls: only the
     *  latest call may apply its result, so a slow response from a
     *  superseded window can't overwrite newer data (or its error banner
     *  clobber the fresher state). */
    this.refreshSeq = 0;

    selector.addEventListener("ep-window-change", (e) => {
      this.onWindowChange(e.detail);
    });

    // Auto-refresh when a new prediction cycle is published; the same
    // stream drives day/night theme reactivity (environment.mode) and the
    // header's connection indicator. Each cycle also re-tracks the
    // vessel's ship's-time frame (see onLiveCycle): the offset follows the
    // onboard timezone, and the live day window rolls over at ship's-time
    // midnight instead of showing yesterday on a long-lived session.
    this.stream = new SignalKStream({
      onCycle: () => this.onLiveCycle(),
      onMode: (mode) => this.applyEnvironmentMode(mode),
      onStatus: (online) => this.applyConnectionStatus(online),
    });
    this.stream.connect();

    // Initial load with selector defaults (restored prefs). The ship's-time
    // offset is fetched from /api/vessel and pushed to the selector (so the
    // day/week/month window anchors on the vessel's ship's-time midnight),
    // the chart (axis labels, tooltips, day buckets) and the Events list
    // (event times) — so every user-facing time renders in the crew's
    // ship's-time frame, agreeing with the advisory dedup's local day.
    //
    // The offset resolves BEFORE the first window fetch: refreshing in
    // parallel fetched the browser-timezone window, then the offset landed,
    // re-anchored the selector and blanked the chart back to "Loading…"
    // for a second fetch — data flashed for a moment and went back to
    // Loading on every open. When the offset applies, the selector re-emits
    // a window change and that (correctly anchored) refresh is already in
    // flight; only refresh here when it was not — vessel meta unavailable
    // (kept fallback) or the offset already matched.
    const spec = selector.windowSpec();
    this.mode = spec.mode;
    this.lastSpec = spec;
    this.refreshVesselMeta().then((applied) => {
      if (!applied) {
        this.refresh(spec);
      }
    });
  }

  disconnectedCallback() {
    this.stream?.close();
  }

  /**
   * Applies the Signal K environment.mode ("day" | "night") to the
   * document root so the CSS variables shift intensity. Anything other
   * than "night" falls back to day visibility.
   * @param {string} mode
   */
  applyEnvironmentMode(mode) {
    document.documentElement.dataset.mode = mode === "night" ? "night" : "day";
  }

  /**
   * Flips the header's connection chip between [ LIVE ] and [ OFFLINE ].
   * @param {boolean} online
   */
  applyConnectionStatus(online) {
    if (!this.connEl) return;
    this.connEl.className = `ep-conn-chip ${online ? "theme-green" : "theme-offline"}`;
    this.connEl.textContent = online ? "[ LIVE ]" : "[ OFFLINE ]";
  }

  /**
   * @param {{mode: string, from: string, to: string}} spec
   */
  onWindowChange(spec) {
    this.mode = spec.mode;
    this.lastSpec = spec;
    this.refresh(spec);
  }

  /**
   * A prediction cycle landed on a live session. Besides refreshing the
   * current window, this is the hook that keeps the webapp in the crew's
   * *current* ship's-time frame:
   *
   * - the onboard timezone offset is re-fetched, so a zone crossing or a
   *   manual clock change moves the day the window anchors on instead of
   *   leaving the webapp rendering in the previous frame
   * - the live day window rolls over at ship's-time midnight
   *
   * When either re-anchoring fired, the selector re-emitted a window
   * change and the refresh already ran — skip the duplicate.
   * @returns {Promise<void>}
   */
  async onLiveCycle() {
    if (!this.lastSpec) {
      return;
    }
    const offsetMoved = await this.refreshVesselMeta();
    const dayMoved = this.selectorEl.followToday();
    if (!offsetMoved && !dayMoved) {
      this.refresh(this.lastSpec);
    }
  }

  /**
   * Fetches the vessel meta (`/api/vessel`) and applies the ship's-time
   * UTC offset to the selector, chart and Events list. Called on load and
   * on every prediction cycle — the offset follows the onboard timezone
   * (updated by @meri-imperiumi/signalk-ships-time on zone crossings), so
   * it must not be cached for the session. A failed fetch keeps the last
   * known offset (or the browser-timezone fallback) and retries on the
   * next cycle.
   * @returns {Promise<boolean>} whether the offset changed and was applied
   */
  async refreshVesselMeta() {
    let body;
    try {
      const response = await fetch(`${API_BASE}/api/vessel`, {
        signal: AbortSignal.timeout(VESSEL_TIMEOUT_MS),
      });
      if (!response.ok) {
        return false;
      }
      body = await response.json();
    } catch {
      // Vessel meta unavailable: keep the current offset, retry next cycle
      return false;
    }
    const offset =
      body && typeof body.timezoneOffsetMinutes === "number"
        ? body.timezoneOffsetMinutes
        : null;
    return this.applyTimezoneOffset(offset);
  }

  /**
   * Pushes the vessel's ship's-time UTC offset (from `/api/vessel`) to
   * the selector, chart and Events list so every user-facing time renders
   * in the crew's ship's-time frame. The selector re-emits a window-change
   * (re-anchored on the vessel's ship's-time midnight — or, when following
   * the live day, on the day containing now under the new offset),
   * which triggers a refresh; the chart and Events list re-render with
   * the new offset. Stored so later refreshes (live cycle stream) keep
   * using it.
   * @param {number|null} offsetMinutes
   * @returns {boolean} whether the offset changed and was applied
   */
  applyTimezoneOffset(offsetMinutes) {
    if (offsetMinutes === this.timezoneOffsetMinutes) return false;
    this.timezoneOffsetMinutes = offsetMinutes;
    this.chartEl.setTimezoneOffsetMinutes?.(offsetMinutes);
    this.actionsEl.setTimezoneOffsetMinutes?.(offsetMinutes);
    this.selectorEl.setTimezoneOffsetMinutes?.(offsetMinutes);
    return true;
  }

  /**
   * @param {string} path
   * @param {string} from
   * @param {string} to
   * @returns {Promise<object|null>}
   */
  async fetchApi(path, from, to) {
    const url = `${API_BASE}${path}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    let response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch (error) {
      // AbortSignal.timeout rejects with a TimeoutError DOMException;
      // surface it as a readable, endpoint-named message instead of the
      // bare "The operation was aborted" so the banner says what hung
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new Error(`${path} timed out after ${API_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `${path} returned ${response.status}`);
    }
    return response.json();
  }

  /**
   * @param {{mode: string, from: string, to: string}} spec
   */
  async refresh(spec) {
    const seq = ++this.refreshSeq;
    this.errorEl.textContent = "";
    // Re-fetching the window already on screen (a live prediction cycle,
    // or the stream replaying the current cycle right after connect) keeps
    // the rendered data visible while the fresh copy loads: blanking first
    // flashed "Loading…" over good data on every cycle. A different window
    // (mode switch, navigation, re-anchor) still blanks up front so the
    // previous window's data never lingers under the new one.
    const rendered = this.renderedSpec;
    const sameWindow =
      rendered !== null &&
      rendered.mode === spec.mode &&
      rendered.from === spec.from &&
      rendered.to === spec.to;
    if (!sameWindow) {
      this.chartEl.data = null;
      this.actionsEl.data = null;
    }
    try {
      const [summary, actuals, predictions, retroPredicted, deployStates] =
        await Promise.all([
          this.fetchApi("/api/summary", spec.from, spec.to).catch(() => null),
          this.fetchApi("/api/actuals", spec.from, spec.to),
          this.fetchApi("/api/predictions", spec.from, spec.to),
          this.fetchApi("/api/retro-predicted", spec.from, spec.to).catch(
            () => null,
          ),
          this.fetchApi("/api/deploy-states", spec.from, spec.to).catch(
            () => null,
          ),
        ]);
      // A newer refresh (window switch, cycle re-anchor) superseded this
      // one: its response is stale, discard it instead of overwriting the
      // newer window's data
      if (seq !== this.refreshSeq) return;
      this.renderedSpec = spec;
      this.figuresEl.data = summary;
      this.chartEl.data = {
        mode: spec.mode,
        actuals,
        predictions,
        retroPredicted,
      };
      this.actionsEl.data = deployStates;
    } catch (error) {
      if (seq !== this.refreshSeq) return;
      this.renderedSpec = null;
      this.errorEl.textContent = `Failed to load data: ${error.message}`;
      this.figuresEl.data = null;
      this.chartEl.data = {
        mode: spec.mode,
        actuals: null,
        predictions: null,
        retroPredicted: null,
      };
      this.actionsEl.data = null;
    }
  }
}

customElements.define("ep-app", EpApp);

export { API_BASE, EpApp };
