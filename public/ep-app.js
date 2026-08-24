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

class EpApp extends HTMLElement {
  constructor() {
    super();
    /** @type {string} */
    this.mode = "day";
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    const shadow = this.shadowRoot;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "./styles.css";
    shadow.appendChild(link);

    const header = document.createElement("header");
    header.className = "ep-header";
    const h1 = document.createElement("h1");
    h1.textContent = "Energy Predictor";
    const error = document.createElement("div");
    error.className = "ep-error";
    header.append(h1, error);

    // Reserved for the future status panel (current forecast, weather
    // tier, live advisories — work doc #8 v1 non-goal)
    const statusPanel = document.createElement("div");
    statusPanel.className = "ep-status-panel";

    const selector = document.createElement("ep-window-selector");
    const figures = document.createElement("ep-headline-figures");
    const chart = document.createElement("ep-timeline-chart");
    const actions = document.createElement("ep-actions-list");

    shadow.append(header, statusPanel, selector, figures, chart, actions);

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
    this.solarOffsetMinutes = null;

    selector.addEventListener("ep-window-change", (e) => {
      this.onWindowChange(e.detail);
    });

    // Auto-refresh when a new prediction cycle is published
    this.stream = new SignalKStream(() => {
      if (this.lastSpec) {
        this.refresh(this.lastSpec);
      }
    });
    this.stream.connect();

    // Initial load with selector defaults (restored prefs). The solar
    // offset is fetched from /api/vessel and pushed to the selector (so the
    // day/week/month window anchors on the vessel's solar-local midnight),
    // the chart (axis labels, tooltips, day buckets) and the Events list
    // (event times) — so every user-facing time renders in the crew's
    // solar-local frame, agreeing with the advisory dedup's sun-day.
    const spec = selector.windowSpec();
    this.mode = spec.mode;
    this.lastSpec = spec;
    this.refresh(spec);
    fetch(`${API_BASE}/api/vessel`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => {
        const off =
          v && typeof v.solarOffsetMinutes === "number"
            ? v.solarOffsetMinutes
            : null;
        this.applySolarOffset(off);
      })
      .catch(() => {
        // Vessel meta unavailable: keep the browser-timezone fallback
      });
  }

  disconnectedCallback() {
    this.stream?.close();
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
   * Pushes the vessel's solar-local UTC offset (from `/api/vessel`) to
   * the selector, chart and Events list so every user-facing time renders
   * in the crew's solar-local frame. The selector re-emits a window-change
   * (re-anchored on solar-local midnight), which triggers a refresh; the
   * chart and Events list re-render with the new offset. Stored so later
   * refreshes (live cycle stream) keep using it.
   * @param {number|null} offsetMinutes
   */
  applySolarOffset(offsetMinutes) {
    if (offsetMinutes === this.solarOffsetMinutes) return;
    this.solarOffsetMinutes = offsetMinutes;
    this.chartEl.setSolarOffsetMinutes?.(offsetMinutes);
    this.actionsEl.setSolarOffsetMinutes?.(offsetMinutes);
    this.selectorEl.setSolarOffsetMinutes?.(offsetMinutes);
  }

  /**
   * @param {string} path
   * @param {string} from
   * @param {string} to
   * @returns {Promise<object|null>}
   */
  async fetchApi(path, from, to) {
    const url = `${API_BASE}${path}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const response = await fetch(url);
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
    this.errorEl.textContent = "";
    this.chartEl.data = null;
    this.actionsEl.data = null;
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
      this.figuresEl.data = summary;
      this.chartEl.data = {
        mode: spec.mode,
        actuals,
        predictions,
        retroPredicted,
      };
      this.actionsEl.data = deployStates;
    } catch (error) {
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
