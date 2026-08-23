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

    shadow.append(header, statusPanel, selector, figures, chart);

    /** @type {ShadowRoot} */
    this.errorEl = error;
    /** @type {HTMLElement} */
    this.figuresEl = figures;
    /** @type {HTMLElement} */
    this.chartEl = chart;

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

    // Initial load with selector defaults (restored prefs)
    const spec = selector.windowSpec();
    this.mode = spec.mode;
    this.lastSpec = spec;
    this.refresh(spec);
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
    try {
      const [summary, actuals, predictions, retroPredicted] = await Promise.all(
        [
          this.fetchApi("/api/summary", spec.from, spec.to).catch(() => null),
          this.fetchApi("/api/actuals", spec.from, spec.to),
          this.fetchApi("/api/predictions", spec.from, spec.to),
          this.fetchApi("/api/retro-predicted", spec.from, spec.to).catch(
            () => null,
          ),
        ],
      );
      this.figuresEl.data = summary;
      this.chartEl.data = {
        mode: spec.mode,
        actuals,
        predictions,
        retroPredicted,
      };
    } catch (error) {
      this.errorEl.textContent = `Failed to load data: ${error.message}`;
      this.figuresEl.data = null;
      this.chartEl.data = {
        mode: spec.mode,
        actuals: null,
        predictions: null,
        retroPredicted: null,
      };
    }
  }
}

customElements.define("ep-app", EpApp);

export { API_BASE, EpApp };
