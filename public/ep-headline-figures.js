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
   * Formats watt-hours for display.
   * @param {number|null} wh
   * @returns {string}
   */
  formatWh(wh) {
    if (wh == null) {
      return "—";
    }
    if (Math.abs(wh) >= 1000) {
      return `${(wh / 1000).toFixed(1)} kWh`;
    }
    return `${Math.round(wh)} Wh`;
  }

  /**
   * Formats a percentage value.
   * @param {number|null} v
   * @returns {string}
   */
  formatPercent(v) {
    return v == null ? "—" : `${Math.round(v)}%`;
  }

  figure(label, value, sub) {
    const div = document.createElement("div");
    div.className = "figure";
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
        ? `SoC ${Math.round(s.soc.min * 100)}–${Math.round(s.soc.max * 100)}%`
        : null;
    const acc = s.predictionAccuracy;
    const accSub =
      acc && acc.hoursCompared > 0
        ? `pred. error ${acc.meanAbsoluteErrorPercent?.toFixed?.(0) ?? acc.meanAbsoluteErrorPercent}%`
        : "no predictions recorded";

    this.append(
      this.figure(
        "Consumption",
        this.formatWh(s.consumption?.totalWh),
        s.consumption?.averageW != null
          ? `avg ${Math.round(s.consumption.averageW)} W`
          : null,
      ),
      this.figure(
        "Solar yield",
        this.formatWh(s.yield?.solar?.totalWh),
        s.yield?.solar?.averageW != null
          ? `avg ${Math.round(s.yield.solar.averageW)} W`
          : null,
      ),
      this.figure(
        "Wind yield",
        this.formatWh(s.yield?.wind?.totalWh),
        s.yield?.wind?.averageW != null
          ? `avg ${Math.round(s.yield.wind.averageW)} W`
          : null,
      ),
      this.figure(
        "Hydro yield",
        this.formatWh(s.yield?.hydro?.totalWh),
        s.yield?.hydro?.averageW != null
          ? `avg ${Math.round(s.yield.hydro.averageW)} W`
          : null,
      ),
      this.figure(
        "Combined yield",
        this.formatWh(s.yield?.combined?.totalWh),
        null,
      ),
      this.figure("Battery", "", socSub),
      this.figure("Prediction accuracy", "", accSub),
    );
  }
}

customElements.define("ep-headline-figures", EpHeadlineFigures);

export { EpHeadlineFigures };
