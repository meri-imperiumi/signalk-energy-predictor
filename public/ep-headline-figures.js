/**
 * Headline figures strip fed by /api/summary.
 *
 * Shows consumption and yield totals, SoC range, and prediction accuracy
 * for the selected window.
 */
class EpHeadlineFigures extends HTMLElement {
  constructor() {
    super();
    /** @type {object|null} */
    this.summary = null;
  }

  /**
   * @param {object|null} summary
   */
  set data(summary) {
    this.summary = summary;
    this.render();
  }

  /**
   * Formats watt-hours for display with SI prefixes.
   * @param {number|null} wh
   * @returns {string}
   */
  formatWh(wh) {
    if (wh == null) {
      return "—";
    }
    if (Math.abs(wh) >= 1000000) {
      return `${(wh / 1000000).toFixed(1)} MWh`;
    }
    if (Math.abs(wh) >= 1000) {
      return `${(wh / 1000).toFixed(1)} kWh`;
    }
    return `${Math.round(wh)} Wh`;
  }

  /**
   * Formats watts for display with SI prefixes.
   * @param {number|null} w
   * @returns {string}
   */
  formatW(w) {
    if (w == null) {
      return "—";
    }
    if (Math.abs(w) >= 1000) {
      return `${(w / 1000).toFixed(1)} kW`;
    }
    return `${Math.round(w)} W`;
  }

  /**
   * Formats a percentage value.
   * @param {number|null} v
   * @returns {string}
   */
  formatPercent(v) {
    return v == null ? "—" : `${Math.round(v)}%`;
  }

  /**
   * @param {string} label
   * @param {string} value
   * @param {string|null} sub
   * @param {string} [theme] - theme class (theme-red, theme-orange, …)
   * @returns {HTMLElement}
   */
  figure(label, value, sub, theme) {
    const div = document.createElement("div");
    div.className = `figure sk-card ${theme || "theme-grey"}`;
    const labelEl = document.createElement("div");
    labelEl.className = "label";
    labelEl.textContent = label;
    const valueEl = document.createElement("div");
    valueEl.className = "value";
    valueEl.textContent = value;
    div.append(labelEl, valueEl);
    if (sub != null) {
      const subEl = document.createElement("div");
      subEl.className = "sub";
      subEl.textContent = sub;
      div.appendChild(subEl);
    }
    return div;
  }

  render() {
    this.innerHTML = "";
    const s = this.summary;
    if (!s) {
      this.appendChild(this.figure("Summary", "—", "no data"));
      return;
    }

    const socSub =
      s.soc?.min != null && s.soc?.max != null
        ? `min ${Math.round(s.soc.min * 100)}% · max ${Math.round(s.soc.max * 100)}%`
        : null;
    const socValue =
      s.soc?.min != null && s.soc?.max != null
        ? `${Math.round(s.soc.min * 100)}–${Math.round(s.soc.max * 100)}%`
        : "—";
    const acc = s.predictionAccuracy;
    const hasAcc = acc && acc.hoursCompared > 0;
    const accValue = hasAcc
      ? `±${acc.meanAbsoluteErrorPercent?.toFixed?.(0) ?? acc.meanAbsoluteErrorPercent}%`
      : "—";
    const accSub = hasAcc ? "mean abs. error" : "no predictions recorded";

    this.append(
      this.figure(
        "Consumption",
        this.formatWh(s.consumption?.totalWh),
        s.consumption?.averageW != null
          ? `avg ${this.formatW(s.consumption.averageW)}`
          : null,
        "theme-red",
      ),
      this.figure(
        "Solar yield",
        this.formatWh(s.yield?.solar?.totalWh),
        s.yield?.solar?.averageW != null
          ? `avg ${this.formatW(s.yield.solar.averageW)}`
          : null,
        "theme-orange",
      ),
      this.figure(
        "Wind yield",
        this.formatWh(s.yield?.wind?.totalWh),
        s.yield?.wind?.averageW != null
          ? `avg ${this.formatW(s.yield.wind.averageW)}`
          : null,
        "theme-teal",
      ),
      this.figure(
        "Hydro yield",
        this.formatWh(s.yield?.hydro?.totalWh),
        s.yield?.hydro?.averageW != null
          ? `avg ${this.formatW(s.yield.hydro.averageW)}`
          : null,
        "theme-blue",
      ),
      this.figure(
        "Combined yield",
        this.formatWh(s.yield?.combined?.totalWh),
        null,
        "theme-grey",
      ),
      this.figure("Battery SoC", socValue, socSub, "theme-green"),
      this.figure("Prediction accuracy", accValue, accSub, "theme-violet"),
    );
  }
}

customElements.define("ep-headline-figures", EpHeadlineFigures);

export { EpHeadlineFigures };
