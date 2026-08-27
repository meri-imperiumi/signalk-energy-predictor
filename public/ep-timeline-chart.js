/**
 * Timeline chart: hand-rolled SVG with dual y-axis (W left, % / kn right).
 *
 * Day window: actual series (solar/wind/hydro yield, house load, SoC,
 * wind speed) with the freshest prediction cycle overlaid as dashed
 * hourly curves. Week/month windows: daily predicted-vs-actual totals as
 * grouped bars, plus SoC and wind speed lines.
 *
 * Legend toggles and enabled-series state persist in localStorage.
 *
 * All user-facing times (axis labels, tooltip, day bucketing) render in
 * the vessel's solar-local frame (offset from `/api/vessel`) so the chart
 * agrees with the window selector and the Events list — a surplus at
 * solar 14:12 shows as 14:12 everywhere, not shifted by the browser's
 * civil timezone.
 */

import {
  formatDayMonth,
  formatHHMM,
  formatShortDateTime,
  solarDayKey,
  solarDayStart,
} from "./ep-solar-time.js";

/** Chart drawing area size */
const WIDTH = 1000;
const HEIGHT = 420;
const MARGIN = { top: 14, right: 54, bottom: 28, left: 54 };

/**
 * Series colors as CSS custom properties (defined in styles.css with
 * day/night variants); SVG strokes/fills are applied via inline style
 * because presentation attributes cannot resolve var().
 */
const COLORS = {
  solar: "var(--series-solar)",
  wind: "var(--series-wind)",
  hydro: "var(--series-hydro)",
  load: "var(--series-load)",
  soc: "var(--series-soc)",
  windKn: "var(--series-gust)",
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
    id: "predHydro",
    label: "Pred. hydro",
    color: COLORS.hydro,
    predicted: true,
    kind: "line",
    axis: "left",
  },
  {
    id: "predLoad",
    label: "Pred. house load",
    color: COLORS.load,
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
    id: "hydroActual",
    label: "Hydro actual",
    color: COLORS.hydro,
    kind: "bar",
    axis: "left",
  },
  {
    id: "hydroPred",
    label: "Hydro pred.",
    color: COLORS.hydro,
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
 * Solar-local UTC offset (minutes, east positive) for rendering axis
 * labels, tooltips and day buckets in the crew's frame. Set by the app
 * from `/api/vessel`; null = use the browser timezone (fallback).
 */
let solarOffsetMinutes = null;

/**
 * Local calendar key (YYYY-MM-DD) for a timestamp — the solar-local
 * sun-day, used for daily bucketing and bar labels so a sun-day
 * straddling UTC midnight stays in one bucket.
 * @param {number} t - epoch ms
 * @returns {string}
 */
function localDayKey(t) {
  return solarDayKey(t, solarOffsetMinutes);
}

/**
 * Local midnight (epoch ms) for a YYYY-MM-DD key — solar-local midnight
 * when the offset is known, browser-local midnight otherwise.
 * @param {string} day
 * @returns {number}
 */
function localDayStart(day) {
  return solarDayStart(day, solarOffsetMinutes);
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

  /**
   * Sets the vessel's solar-local UTC offset (from `/api/vessel`) and
   * re-renders so axis labels, tooltips and day buckets move to the
   * solar-local frame. No-op when unchanged.
   * @param {number|null} offsetMinutes
   */
  setSolarOffsetMinutes(offsetMinutes) {
    if (offsetMinutes === solarOffsetMinutes) return;
    solarOffsetMinutes = offsetMinutes;
    if (this.isConnected) this.render();
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
   * Builds the predicted-SoC line points for the day view.
   *
   * Predicted SoC is only meaningful in the future (the recorded cycle's
   * forecast starts at "now"), so points before now are dropped. To avoid a
   * visible gap between the actual SoC line (which ends at the last sample)
   * and the predicted SoC line (which starts at the first forecast hour ≥
   * now), prepend an anchor point at the last actual SoC sample so the two
   * lines connect.
   * @param {Array<{t: number, predSoC: number|null}>} pred
   * @param {Array<{soc: number|null, time: string}>} actualsPoints
   * @returns {Array<{t: number, v: number}>}
   */
  _predSoCPoints(pred, actualsPoints) {
    const future = pred
      .filter((p) => p.predSoC != null && p.t >= Date.now())
      .map((p) => ({ t: p.t, v: p.predSoC }));
    if (future.length === 0) return future;
    const lastActual = actualsPoints
      .filter((p) => p.soc != null)
      .map((p) => ({ t: +new Date(p.time), v: Math.round(p.soc * 1000) / 10 }))
      .sort((a, b) => a.t - b.t)
      .pop();
    if (!lastActual) return future;
    // Anchor at the last actual sample so the predicted line continues from
    // where the actual line ends, closing the gap at the now boundary.
    return [{ t: lastActual.t, v: lastActual.v }, ...future];
  }

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

    // Pred series: stepped hourly segments.
    //
    // The freshest recorded cycle covers from its record time forward (its
    // forecast starts at "now" and runs predictionHours into the future).
    // For the current day that leaves the hours before the cycle's start
    // without any predicted yield, so the day view would show predicted
    // solar/wind/hydro only in the future — unlike past days, which have no
    // recorded cycles and fall back to the retro-predicted backfill covering
    // the whole window.
    //
    // To keep the current day consistent with past days, stitch the two
    // sources: use retro-predicted points for hours before the freshest
    // cycle's first forecast hour, and the cycle's forecast from there on.
    // predLoad and predSoC only come from the cycle (retro-predicted has no
    // load/SoC), so they remain forecast-only.
    const pred = [];
    const retroByTime = new Map();
    for (const hour of retroPredicted?.points || []) {
      retroByTime.set(new Date(hour.time).getTime(), hour);
    }
    const cycleStart =
      cycle && (cycle.forecast || []).length > 0
        ? new Date(cycle.forecast[0].time).getTime()
        : Number.POSITIVE_INFINITY;
    if (cycle) {
      for (const hour of cycle.forecast || []) {
        const t = new Date(hour.time).getTime();
        const hydroWh = hour.idealHydroYieldWh || 0;
        const windCombined = hour.idealWindYieldWh || 0;
        pred.push({
          t,
          predSolar: hour.idealSolarYieldWh || 0,
          predWind: Math.max(0, windCombined - hydroWh),
          predHydro: hydroWh,
          predLoad: hour.houseLoadWh ?? null,
          predSoC:
            hour.idealSoC != null
              ? Math.round(hour.idealSoC * 1000) / 10
              : null,
        });
      }
    }
    // Fill the past portion (before the freshest cycle) from retro-predicted
    // so the current day shows predicted yield across its whole span, matching
    // past days that rely on the backfill.
    for (const [t, hour] of retroByTime) {
      if (t >= cycleStart) continue;
      const hydroWh = hour.idealHydroYieldWh || 0;
      const windCombined = hour.idealWindYieldWh || 0;
      pred.push({
        t,
        predSolar: hour.idealSolarYieldWh || 0,
        predWind: Math.max(0, windCombined - hydroWh),
        predHydro: hydroWh,
        predLoad: null,
        predSoC: null,
      });
    }
    pred.sort((a, b) => a.t - b.t);

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
        predHydro: pred.map((p) => ({ t: p.t, v: p.predHydro })),
        predLoad: pred
          .filter((p) => p.predLoad != null)
          .map((p) => ({ t: p.t, v: p.predLoad })),
        predSoC: this._predSoCPoints(pred, points),
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
      row.values.predHydro = p.predHydro;
      if (p.predLoad != null) row.values.predLoad = p.predLoad;
      if (p.predSoC != null && p.t >= Date.now()) {
        row.values.predSoC = p.predSoC;
      }
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
          hydroWh: 0,
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
      entry.hydroWh +=
        (((points[i - 1].hydroW || 0) + (points[i].hydroW || 0)) / 2) * hours;
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
    // Fill predicted Wh for days the recorded cycles don't cover from
    // retro-predicted hourly points aggregated to daily totals. Past months
    // have no recorded cycles so every day falls back here; the current
    // month has cycles only from today forward, so its past days fall back
    // here too — otherwise those days would show zero predicted bars.
    if (retroPredicted?.points) {
      const retroDaily = new Map();
      for (const hour of retroPredicted.points) {
        const day = localDayKey(new Date(hour.time).getTime());
        let entry = retroDaily.get(day);
        if (!entry) {
          entry = { date: day, solarWh: 0, windWh: 0, hydroWh: 0 };
          retroDaily.set(day, entry);
        }
        entry.solarWh += hour.idealSolarYieldWh || 0;
        const hydroWh = hour.idealHydroYieldWh || 0;
        entry.hydroWh += hydroWh;
        entry.windWh += Math.max(0, (hour.idealWindYieldWh || 0) - hydroWh);
      }
      for (const entry of retroDaily.values()) {
        entry.solarWh = Math.round(entry.solarWh);
        entry.windWh = Math.round(entry.windWh);
        entry.hydroWh = Math.round(entry.hydroWh);
      }
      for (const [date, entry] of retroDaily) {
        // Don't clobber a recorded prediction day (the freshest cycle's
        // forecast is authoritative for the days it covers)
        if (!predByDay.has(date)) {
          predByDay.set(date, entry);
        }
      }
    }
    const allDays = Array.from(
      new Set([...daily.keys(), ...days.map((d) => d.date)]),
    ).sort();

    const bars = allDays.map((day) => {
      const actual = daily.get(day) || {
        solarWh: 0,
        windWh: 0,
        hydroWh: 0,
        socSum: 0,
        socCount: 0,
        windSum: 0,
        windCount: 0,
      };
      const pred = predByDay.get(day);
      const predHydro = pred?.hydroWh ?? 0;
      return {
        day,
        solarActual: actual.solarWh,
        solarPred: pred?.solarWh ?? 0,
        windActual: actual.windWh,
        windPred: Math.max(0, (pred?.windWh ?? 0) - predHydro),
        hydroActual: actual.hydroWh,
        hydroPred: predHydro,
        soc: actual.socCount > 0 ? actual.socSum / actual.socCount : null,
        socPred:
          pred?.soc != null && localDayStart(day) + 24 * 3600000 > Date.now()
            ? pred.soc * 100
            : null,
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
          hydroActual: Math.round(b.hydroActual),
          hydroPred: b.hydroPred,
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
      const grid = this.svgEl("line", {
        x1: x0,
        x2: x1,
        y1: y,
        y2: y,
        "stroke-width": 0.5,
      });
      grid.style.stroke = "var(--chart-grid)";
      svg.appendChild(grid);
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
      const tick = this.svgEl("line", {
        x1: x,
        x2: x,
        y1: MARGIN.top,
        y2: MARGIN.top + this.plotHeight,
        "stroke-width": 0.5,
      });
      tick.style.stroke = "var(--chart-grid)";
      svg.appendChild(tick);
      const label = this.svgEl("text", {
        x,
        y: HEIGHT - 8,
        "text-anchor": "middle",
      });
      label.textContent = isDay
        ? formatHHMM(t, solarOffsetMinutes)
        : formatDayMonth(t, solarOffsetMinutes);
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
      "stroke-width": 0.75,
      visibility: "hidden",
    });
    rule.style.stroke = "var(--text-muted)";
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
      const line = this.svgEl("path", {
        d: path,
        fill: "none",
        "stroke-width": d.predicted ? 1.5 : 2,
        "stroke-dasharray": d.predicted ? "5 4" : undefined,
        opacity: d.predicted ? "var(--predicted-opacity)" : 1,
      });
      line.style.stroke = d.color;
      svg.appendChild(line);
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
        const rect = this.svgEl("rect", {
          x: dayX + j * barWidth,
          y,
          width: barWidth - 1,
          height: Math.max(0, MARGIN.top + this.plotHeight - y),
          opacity: def?.predicted ? 0.45 : 0.9,
        });
        rect.style.fill = def?.color || "var(--text-main)";
        svg.appendChild(rect);
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
      const line = this.svgEl("path", {
        d: path,
        fill: "none",
        "stroke-width": def.predicted ? 1.5 : 2,
        "stroke-dasharray": def.predicted ? "5 4" : undefined,
        opacity: def.predicted ? "var(--predicted-opacity)" : 1,
      });
      line.style.stroke = def.color;
      svg.appendChild(line);
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
    timeEl.textContent = formatShortDateTime(nearest.t, solarOffsetMinutes);
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
