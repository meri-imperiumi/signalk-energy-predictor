/**
 * Timeline chart: hand-rolled SVG with dual y-axis (W left, % / kn right).
 *
 * Day window: actual series (solar/wind/hydro yield, house load, SoC,
 * wind speed) with the freshest prediction cycle overlaid as dashed
 * hourly curves. Week/month windows: daily predicted-vs-actual totals as
 * grouped bars, plus SoC and wind speed lines.
 *
 * Legend toggles and enabled-series state persist in localStorage.
 */

/** Chart drawing area size */
const WIDTH = 1000;
const HEIGHT = 420;
const MARGIN = { top: 14, right: 54, bottom: 28, left: 54 };

/** Series colors shared with styles.css custom properties */
const COLORS = {
  solar: "#f5b942",
  wind: "#4fc3f7",
  hydro: "#26c6aa",
  load: "#ef5b7b",
  soc: "#9ccc65",
  windKn: "#b39ddb",
};

const PREFS_KEY = "ep:series";

/**
 * @typedef {{id: string, label: string, color: string, predicted?: boolean, kind: "line"|"bar", axis: "left"|"right"}} SeriesDef
 */

/** @type {SeriesDef[]} */
const DAY_SERIES = [
  {
    id: "solar",
    label: "Solar",
    color: COLORS.solar,
    kind: "line",
    axis: "left",
  },
  { id: "wind", label: "Wind", color: COLORS.wind, kind: "line", axis: "left" },
  {
    id: "hydro",
    label: "Hydro",
    color: COLORS.hydro,
    kind: "line",
    axis: "left",
  },
  {
    id: "load",
    label: "House load",
    color: COLORS.load,
    kind: "line",
    axis: "left",
  },
  { id: "soc", label: "SoC %", color: COLORS.soc, kind: "line", axis: "right" },
  {
    id: "windKn",
    label: "Wind kn",
    color: COLORS.windKn,
    kind: "line",
    axis: "right",
  },
  {
    id: "predSolar",
    label: "Pred. solar",
    color: COLORS.solar,
    predicted: true,
    kind: "line",
    axis: "left",
  },
  {
    id: "predWind",
    label: "Pred. wind",
    color: COLORS.wind,
    predicted: true,
    kind: "line",
    axis: "left",
  },
  {
    id: "predSoC",
    label: "Pred. SoC %",
    color: COLORS.soc,
    predicted: true,
    kind: "line",
    axis: "right",
  },
];

/** @type {SeriesDef[]} */
const PERIOD_SERIES = [
  {
    id: "solarActual",
    label: "Solar actual",
    color: COLORS.solar,
    kind: "bar",
    axis: "left",
  },
  {
    id: "solarPred",
    label: "Solar pred.",
    color: COLORS.solar,
    predicted: true,
    kind: "bar",
    axis: "left",
  },
  {
    id: "windActual",
    label: "Wind actual",
    color: COLORS.wind,
    kind: "bar",
    axis: "left",
  },
  {
    id: "windPred",
    label: "Wind pred.",
    color: COLORS.wind,
    predicted: true,
    kind: "bar",
    axis: "left",
  },
  {
    id: "socPred",
    label: "SoC pred.",
    color: COLORS.soc,
    predicted: true,
    kind: "line",
    axis: "right",
  },
  { id: "soc", label: "SoC %", color: COLORS.soc, kind: "line", axis: "right" },
  {
    id: "windKn",
    label: "Wind kn",
    color: COLORS.windKn,
    kind: "line",
    axis: "right",
  },
];

/**
 * Local calendar key (YYYY-MM-DD) for a timestamp — the browser's day,
 * used for daily bucketing and bar labels.
 * @param {number} t - epoch ms
 * @returns {string}
 */
function localDayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Local midnight (epoch ms) for a YYYY-MM-DD key.
 * @param {string} day
 * @returns {number}
 */
function localDayStart(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

class EpTimelineChart extends HTMLElement {
  constructor() {
    super();
    /** @type {{mode: string, actuals: object|null, predictions: object|null, retroPredicted: object|null}|null} */
    this._data = null;
    /** @type {Record<string, boolean>} */
    this.enabled = {};
    /** @type {SVGSVGElement|null} */
    this.svg = null;
    /** @type {HTMLElement|null} */
    this.tooltip = null;
    /** Hover rows: [{t, values: Record<string, number>}] */
    this.hoverRows = [];
    /** @type {{from: number, to: number}|null} drawing domain (hover inversion) */
    this.modelDomain = null;
    /** @type {{x0: number, x1: number}|null} plot x range in px */
    this.plotX = null;
  }

  /**
   * Assigning data re-renders the chart.
   * @param {{mode: string, actuals: object|null, predictions: object|null, retroPredicted: object|null}|null} value
   */
  set data(value) {
    this._data = value;
    if (this.isConnected) {
      this.render();
    }
  }

  get data() {
    return this._data;
  }

  connectedCallback() {
    this.style.position = "relative";
    this.loadPrefs();
    this.render();
  }

  loadPrefs() {
    try {
      this.enabled = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    } catch {
      this.enabled = {};
    }
  }

  savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.enabled));
    } catch {
      // localStorage unavailable: session-only toggles
    }
  }

  isEnabled(id) {
    // Default on unless explicitly disabled
    return this.enabled[id] !== false;
  }

  toggle(id) {
    this.enabled[id] = !this.isEnabled(id);
    this.savePrefs();
    this.render();
  }

  get seriesDefs() {
    return this._data?.mode === "day" ? DAY_SERIES : PERIOD_SERIES;
  }

  // --- geometry helpers ---

  get plotWidth() {
    return WIDTH - MARGIN.left - MARGIN.right;
  }

  get plotHeight() {
    return HEIGHT - MARGIN.top - MARGIN.bottom;
  }

  /**
   * Nice axis maximum for a value range.
   * @param {number} max
   * @returns {number}
   */
  niceMax(max) {
    if (max <= 0) {
      return 100;
    }
    const pow = 10 ** Math.floor(Math.log10(max));
    for (const m of [1, 2, 2.5, 5, 10]) {
      if (max <= m * pow) {
        return m * pow;
      }
    }
    return 10 * pow;
  }

  /**
   * Builds an SVG element.
   * @param {string} name
   * @param {Record<string, string|number>} attrs
   * @returns {SVGElement}
   */
  svgEl(name, attrs = {}) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, String(v));
    }
    return el;
  }

  // --- data shaping ---

  /**
   * Day view: maps actuals points and the freshest cycle into a shared
   * time-sorted series model.
   * @returns {{model: object, rows: object[]}}
   */
  buildDayModel() {
    const { actuals, predictions, retroPredicted } = this._data;
    const points = actuals?.points || [];
    const cycles = predictions?.cycles || [];
    const cycle = cycles.length > 0 ? cycles[cycles.length - 1] : null;

    const from = new Date(this._data.actuals?.window?.from || 0).getTime();
    const to = new Date(this._data.actuals?.window?.to || Date.now()).getTime();

    // Pred series: stepped hourly segments from the freshest cycle.
    // Falls back to retro-predicted (backfilled model over archive weather)
    // when no recorded cycle covers the window.
    const pred = [];
    if (cycle) {
      for (const hour of cycle.forecast || []) {
        const t = new Date(hour.time).getTime();
        pred.push({
          t,
          predSolar: hour.idealSolarYieldWh || 0,
          predWind: hour.idealWindYieldWh || 0,
          predSoC:
            hour.idealSoC != null
              ? Math.round(hour.idealSoC * 1000) / 10
              : null,
        });
      }
    } else {
      for (const hour of retroPredicted?.points || []) {
        const t = new Date(hour.time).getTime();
        pred.push({
          t,
          predSolar: hour.idealSolarYieldWh || 0,
          predWind: hour.idealWindYieldWh || 0,
          predSoC: null,
        });
      }
    }

    const model = {
      from,
      to,
      lines: {
        solar: points.map((p) => ({ t: +new Date(p.time), v: p.solarW || 0 })),
        wind: points.map((p) => ({ t: +new Date(p.time), v: p.windW || 0 })),
        hydro: points.map((p) => ({ t: +new Date(p.time), v: p.hydroW || 0 })),
        load: points.map((p) => ({
          t: +new Date(p.time),
          v: p.houseLoadW || 0,
        })),
        soc: points
          .filter((p) => p.soc != null)
          .map((p) => ({ t: +new Date(p.time), v: p.soc * 100 })),
        windKn: points
          .filter((p) => p.windSpeedKnots != null)
          .map((p) => ({ t: +new Date(p.time), v: p.windSpeedKnots })),
        predSolar: pred.map((p) => ({ t: p.t, v: p.predSolar })),
        predWind: pred.map((p) => ({ t: p.t, v: p.predWind })),
        predSoC: pred
          .filter((p) => p.predSoC != null)
          .map((p) => ({ t: p.t, v: p.predSoC })),
      },
    };

    const rows = new Map();
    const rowAt = (t) => {
      let row = rows.get(t);
      if (!row) {
        row = { t, values: {} };
        rows.set(t, row);
      }
      return row;
    };
    for (const p of points) {
      const row = rowAt(+new Date(p.time));
      row.values.solar = p.solarW;
      row.values.wind = p.windW;
      row.values.hydro = p.hydroW;
      row.values.load = p.houseLoadW;
      if (p.soc != null) row.values.soc = Math.round(p.soc * 100);
      if (p.windSpeedKnots != null) {
        row.values.windKn = Math.round(p.windSpeedKnots * 10) / 10;
      }
    }
    for (const p of pred) {
      const row = rowAt(p.t);
      row.values.predSolar = p.predSolar;
      row.values.predWind = p.predWind;
      if (p.predSoC != null) row.values.predSoC = p.predSoC;
    }

    return {
      model,
      rows: Array.from(rows.values()).sort((a, b) => a.t - b.t),
    };
  }

  /**
   * Week/month view: daily actual Wh (integrated from downsampled points)
   * vs predicted Wh from /api/predictions daily totals.
   * @returns {{model: object, rows: object[]}}
   */
  buildPeriodModel() {
    const { actuals, predictions, retroPredicted } = this._data;
    const points = actuals?.points || [];
    const days = predictions?.days || [];

    // Integrate downsampled averages per local day: avg W × bucket hours
    const daily = new Map();
    for (let i = 1; i < points.length; i++) {
      const t0 = +new Date(points[i - 1].time);
      const t1 = +new Date(points[i].time);
      if (!(t1 > t0)) continue;
      const hours = (t1 - t0) / 3600000;
      const day = localDayKey((t0 + t1) / 2);
      let entry = daily.get(day);
      if (!entry) {
        entry = {
          day,
          solarWh: 0,
          windWh: 0,
          socSum: 0,
          socCount: 0,
          windSum: 0,
          windCount: 0,
        };
        daily.set(day, entry);
      }
      entry.solarWh +=
        (((points[i - 1].solarW || 0) + (points[i].solarW || 0)) / 2) * hours;
      entry.windWh +=
        (((points[i - 1].windW || 0) + (points[i].windW || 0)) / 2) * hours;
      for (const p of [points[i - 1], points[i]]) {
        if (p.soc != null) {
          entry.socSum += p.soc * 100;
          entry.socCount++;
        }
        if (p.windSpeedKnots != null) {
          entry.windSum += p.windSpeedKnots;
          entry.windCount++;
        }
      }
    }

    const predByDay = new Map(days.map((d) => [d.date, d]));
    // Fall back to retro-predicted hourly points aggregated to daily totals
    // when no recorded prediction days cover the window.
    if (days.length === 0 && retroPredicted?.points) {
      const retroDaily = new Map();
      for (const hour of retroPredicted.points) {
        const day = localDayKey(new Date(hour.time).getTime());
        let entry = retroDaily.get(day);
        if (!entry) {
          entry = { date: day, solarWh: 0, windWh: 0 };
          retroDaily.set(day, entry);
        }
        entry.solarWh += hour.idealSolarYieldWh || 0;
        entry.windWh += hour.idealWindYieldWh || 0;
      }
      for (const entry of retroDaily.values()) {
        entry.solarWh = Math.round(entry.solarWh);
        entry.windWh = Math.round(entry.windWh);
      }
      for (const [date, entry] of retroDaily) {
        predByDay.set(date, entry);
      }
    }
    const allDays = Array.from(
      new Set([...daily.keys(), ...days.map((d) => d.date)]),
    ).sort();

    const bars = allDays.map((day) => {
      const actual = daily.get(day) || {
        solarWh: 0,
        windWh: 0,
        socSum: 0,
        socCount: 0,
        windSum: 0,
        windCount: 0,
      };
      const pred = predByDay.get(day);
      return {
        day,
        solarActual: actual.solarWh,
        solarPred: pred?.solarWh ?? 0,
        windActual: actual.windWh,
        windPred: pred?.windWh ?? 0,
        soc: actual.socCount > 0 ? actual.socSum / actual.socCount : null,
        socPred: pred?.soc != null ? pred.soc * 100 : null,
        windKn: actual.windCount > 0 ? actual.windSum / actual.windCount : null,
      };
    });

    const from = bars.length > 0 ? localDayStart(bars[0].day) : 0;
    const to =
      bars.length > 0
        ? localDayStart(bars[bars.length - 1].day) + 24 * 3600000
        : 1;

    return {
      model: {
        from,
        to,
        bars,
        soc: bars
          .filter((b) => b.soc != null)
          .map((b) => ({ t: localDayStart(b.day) + 12 * 3600000, v: b.soc })),
        socPred: bars
          .filter((b) => b.socPred != null)
          .map((b) => ({
            t: localDayStart(b.day) + 12 * 3600000,
            v: b.socPred,
          })),
        windKn: bars
          .filter((b) => b.windKn != null)
          .map((b) => ({
            t: localDayStart(b.day) + 12 * 3600000,
            v: b.windKn,
          })),
      },
      rows: bars.map((b) => ({
        t: localDayStart(b.day) + 12 * 3600000,
        values: {
          solarActual: Math.round(b.solarActual),
          solarPred: b.solarPred,
          windActual: Math.round(b.windActual),
          windPred: b.windPred,
          soc: b.soc != null ? Math.round(b.soc) : null,
          socPred: b.socPred != null ? Math.round(b.socPred) : null,
          windKn: b.windKn != null ? Math.round(b.windKn * 10) / 10 : null,
        },
      })),
    };
  }

  // --- rendering ---

  render() {
    if (this.tooltip) {
      // Keep the tooltip element across re-renders (innerHTML reset below
      // would otherwise detach it from the DOM)
      this.tooltip.remove();
    }
    this.innerHTML = "";
    if (!this._data) {
      const loading = document.createElement("div");
      loading.className = "ep-loading";
      loading.textContent = "Loading…";
      this.appendChild(loading);
      return;
    }

    const isDay = this._data.mode === "day";
    const { model, rows } = isDay
      ? this.buildDayModel()
      : this.buildPeriodModel();
    this.hoverRows = rows;

    const defs = this.seriesDefs;
    const enabledDefs = defs.filter((d) => this.isEnabled(d.id));

    // Left axis scale from enabled left-axis sources
    let leftMax = 0;
    if (isDay) {
      for (const d of enabledDefs.filter((s) => s.axis === "left")) {
        for (const pt of model.lines[d.id] || []) {
          leftMax = Math.max(leftMax, pt.v);
        }
      }
    } else {
      for (const b of model.bars || []) {
        for (const id of enabledDefs
          .filter((s) => s.axis === "left")
          .map((s) => s.id)) {
          leftMax = Math.max(leftMax, b[id] || 0);
        }
      }
    }
    leftMax = this.niceMax(leftMax);

    const x0 = MARGIN.left;
    const x1 = WIDTH - MARGIN.right;
    this.plotX = { x0, x1 };
    // Hover inversion must use the same domain as the drawing scale,
    // not the first→last data row span (rows can lie outside the window,
    // e.g. prediction hours beyond the window edge)
    this.modelDomain = { from: model.from, to: model.to };
    const span = Math.max(1, model.to - model.from);
    const xScale = (t) => x0 + ((t - model.from) / span) * (x1 - x0);
    const yLeft = (v) =>
      MARGIN.top + this.plotHeight * (1 - Math.min(v, leftMax) / leftMax);
    const yRight = (v) =>
      MARGIN.top + this.plotHeight * (1 - Math.max(0, Math.min(v, 100)) / 100);

    const svg = this.svgEl("svg", {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      class: "ep-chart-svg",
    });
    svg.setAttribute("width", "100%");
    this.svg = svg;

    // Grid + left axis labels
    for (let i = 0; i <= 4; i++) {
      const v = (leftMax / 4) * i;
      const y = yLeft(v);
      svg.appendChild(
        this.svgEl("line", {
          x1: x0,
          x2: x1,
          y1: y,
          y2: y,
          stroke: "#2a2f42",
          "stroke-width": 0.5,
        }),
      );
      const label = this.svgEl("text", {
        x: x0 - 6,
        y: y + 4,
        "text-anchor": "end",
      });
      label.textContent = Math.round(v).toString();
      svg.appendChild(label);
    }

    // Right axis: % and kn share the 0–100 scale
    for (const v of [0, 50, 100]) {
      const label = this.svgEl("text", {
        x: x1 + 6,
        y: yRight(v) + 4,
      });
      label.textContent = String(v);
      svg.appendChild(label);
    }
    const rightUnit = this.svgEl("text", {
      x: x1 + 6,
      y: MARGIN.top - 2,
    });
    rightUnit.textContent = "% / kn";
    svg.appendChild(rightUnit);
    const leftUnit = this.svgEl("text", {
      x: x0 - 6,
      y: MARGIN.top - 2,
      "text-anchor": "end",
    });
    leftUnit.textContent = isDay ? "W" : "Wh";
    svg.appendChild(leftUnit);

    // X axis ticks
    const tickStep = isDay
      ? 3 * 3600000
      : Math.max(1, Math.round(model.bars.length / 8)) * 24 * 3600000;
    for (let t = model.from; t <= model.to; t += tickStep) {
      const x = xScale(t);
      svg.appendChild(
        this.svgEl("line", {
          x1: x,
          x2: x,
          y1: MARGIN.top,
          y2: MARGIN.top + this.plotHeight,
          stroke: "#232739",
          "stroke-width": 0.5,
        }),
      );
      const label = this.svgEl("text", {
        x,
        y: HEIGHT - 8,
        "text-anchor": "middle",
      });
      const d = new Date(t);
      label.textContent = isDay
        ? `${String(d.getHours()).padStart(2, "0")}:00`
        : `${d.getDate()}/${d.getMonth() + 1}`;
      svg.appendChild(label);
    }

    if (isDay) {
      this.renderDaySeries(svg, model, xScale, yLeft, yRight, enabledDefs);
    } else {
      this.renderPeriodBars(svg, model, xScale, yLeft, enabledDefs);
      this.renderLines(
        svg,
        [
          { id: "soc", points: model.soc },
          { id: "socPred", points: model.socPred },
          { id: "windKn", points: model.windKn },
        ].filter((s) => this.isEnabled(s.id)),
        xScale,
        yRight,
      );
    }

    // Hover rule
    const rule = this.svgEl("line", {
      class: "ep-hover-rule",
      x1: 0,
      x2: 0,
      y1: MARGIN.top,
      y2: MARGIN.top + this.plotHeight,
      stroke: "#8a90a3",
      "stroke-width": 0.75,
      visibility: "hidden",
    });
    svg.appendChild(rule);
    svg.addEventListener("mousemove", (e) => this.onHover(e, xScale, rule));
    svg.addEventListener("mouseleave", () => {
      rule.setAttribute("visibility", "hidden");
      if (this.tooltip) this.tooltip.style.display = "none";
    });

    this.appendChild(svg);

    // Legend
    const legend = document.createElement("div");
    legend.className = "ep-legend";
    for (const d of defs) {
      const btn = document.createElement("button");
      const swatch = document.createElement("span");
      swatch.className = `swatch${d.predicted ? " predicted" : ""}`;
      swatch.style.background = d.color;
      if (d.predicted) {
        swatch.style.background = `repeating-linear-gradient(45deg, ${d.color}, ${d.color} 3px, transparent 3px, transparent 6px)`;
      }
      btn.append(swatch, document.createTextNode(d.label));
      if (!this.isEnabled(d.id)) {
        btn.classList.add("off");
      }
      btn.addEventListener("click", () => this.toggle(d.id));
      legend.appendChild(btn);
    }
    this.appendChild(legend);

    if (this.hoverRows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ep-loading";
      empty.textContent = "No recordings in this window";
      this.appendChild(empty);
    }

    if (!this.tooltip) {
      const tooltip = document.createElement("div");
      tooltip.className = "ep-tooltip";
      this.tooltip = tooltip;
    }
    this.appendChild(this.tooltip);
  }

  /**
   * @param {SVGSVGElement} svg
   * @param {object} model
   * @param {(t: number) => number} xScale
   * @param {(v: number) => number} yLeft
   * @param {(v: number) => number} yRight
   * @param {SeriesDef[]} enabledDefs
   */
  renderDaySeries(svg, model, xScale, yLeft, yRight, enabledDefs) {
    for (const d of enabledDefs) {
      const points = model.lines[d.id] || [];
      if (points.length === 0) continue;
      const y = d.axis === "left" ? yLeft : yRight;
      const path = points
        .map(
          (p, i) =>
            `${i === 0 ? "M" : "L"}${xScale(p.t).toFixed(1)},${y(p.v).toFixed(1)}`,
        )
        .join("");
      svg.appendChild(
        this.svgEl("path", {
          d: path,
          fill: "none",
          stroke: d.color,
          "stroke-width": d.predicted ? 1.5 : 2,
          "stroke-dasharray": d.predicted ? "5 4" : undefined,
          opacity: d.predicted ? 0.75 : 1,
        }),
      );
    }
  }

  /**
   * @param {SVGSVGElement} svg
   * @param {object} model
   * @param {(t: number) => number} xScale
   * @param {(v: number) => number} yLeft
   * @param {SeriesDef[]} enabledDefs
   */
  renderPeriodBars(svg, model, xScale, yLeft, enabledDefs) {
    const bars = model.bars || [];
    if (bars.length === 0) return;
    const dayWidth = (xScale(model.to) - xScale(model.from)) / bars.length;
    const barIds = enabledDefs.filter((d) => d.kind === "bar").map((d) => d.id);
    const barWidth = Math.max(1, (dayWidth * 0.7) / Math.max(1, barIds.length));

    bars.forEach((b) => {
      const dayX = xScale(localDayStart(b.day));
      barIds.forEach((id, j) => {
        const v = b[id] || 0;
        const y = yLeft(v);
        const def = this.seriesDefs.find((d) => d.id === id);
        svg.appendChild(
          this.svgEl("rect", {
            x: dayX + j * barWidth,
            y,
            width: barWidth - 1,
            height: Math.max(0, MARGIN.top + this.plotHeight - y),
            fill: def?.color || "#fff",
            opacity: def?.predicted ? 0.45 : 0.9,
          }),
        );
      });
    });
  }

  /**
   * @param {SVGSVGElement} svg
   * @param {Array<{id: string, points: Array<{t: number, v: number}>}>} series
   * @param {(t: number) => number} xScale
   * @param {(v: number) => number} y
   */
  renderLines(svg, series, xScale, y) {
    for (const s of series) {
      const def = this.seriesDefs.find((d) => d.id === s.id);
      if (!def || s.points.length === 0) continue;
      const path = s.points
        .map(
          (p, i) =>
            `${i === 0 ? "M" : "L"}${xScale(p.t).toFixed(1)},${y(p.v).toFixed(1)}`,
        )
        .join("");
      svg.appendChild(
        this.svgEl("path", {
          d: path,
          fill: "none",
          stroke: def.color,
          "stroke-width": 2,
        }),
      );
    }
  }

  /**
   * Hover handler: nearest row by time.
   * @param {MouseEvent} e
   * @param {(t: number) => number} xScale
   * @param {SVGElement} rule
   */
  onHover(e, xScale, rule) {
    if (this.hoverRows.length === 0 || !this.tooltip) return;
    const rect = this.svg.getBoundingClientRect();
    const pxPerUnit = rect.width / WIDTH;
    const svgX = (e.clientX - rect.left) / pxPerUnit;
    const { from, to } = this.modelDomain;
    const frac = (svgX - MARGIN.left) / this.plotWidth;
    const t = from + Math.min(1, Math.max(0, frac)) * (to - from);
    let nearest = this.hoverRows[0];
    let best = Infinity;
    for (const row of this.hoverRows) {
      const d = Math.abs(row.t - t);
      if (d < best) {
        best = d;
        nearest = row;
      }
    }

    const x = xScale(nearest.t);
    rule.setAttribute("x1", x);
    rule.setAttribute("x2", x);
    rule.setAttribute("visibility", "visible");

    const timeEl = document.createElement("div");
    timeEl.className = "time";
    timeEl.textContent = new Date(nearest.t).toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
    this.tooltip.replaceChildren(timeEl);
    for (const d of this.seriesDefs) {
      if (!this.isEnabled(d.id)) continue;
      const shown = nearest.values[d.id];
      if (shown == null) continue;
      const line = document.createElement("div");
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = d.color;
      swatch.style.width = "8px";
      swatch.style.height = "8px";
      swatch.style.marginRight = "4px";
      swatch.style.display = "inline-block";
      line.append(
        swatch,
        document.createTextNode(`${d.label}: ${Math.round(shown * 10) / 10}`),
      );
      this.tooltip.appendChild(line);
    }
    this.tooltip.style.display = "block";
    const hostRect = this.getBoundingClientRect();
    this.tooltip.style.left = `${Math.min(e.clientX - hostRect.left + 12, hostRect.width - 180)}px`;
    this.tooltip.style.top = `${e.clientY - hostRect.top + 12}px`;
  }
}

customElements.define("ep-timeline-chart", EpTimelineChart);

export { DAY_SERIES, EpTimelineChart, PERIOD_SERIES };
