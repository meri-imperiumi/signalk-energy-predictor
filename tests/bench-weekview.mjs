/**
 * End-to-end week-view load benchmark: generates production-scale
 * recordings (96 cycles/day with forecastHours-point forecasts, 288
 * samples/day) through the real record store and fires the webapp's 5
 * window endpoints concurrently against real registered routes,
 * reporting per-endpoint wall time and worst event-loop stall.
 *
 * Targets (work doc #21): week view < 300 ms total, no event-loop
 * stall > 50 ms.
 *
 * Usage: node tests/bench-weekview.mjs [days] [forecastHours] [windowDays]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { registerApiRoutes } from "../plugin/api.js";
import { RecordStore } from "../plugin/storage.js";

const DAYS = Number.parseInt(process.argv[2] || "30", 10);
const FORECAST_HOURS = Number.parseInt(process.argv[3] || "48", 10);
const WINDOW_DAYS = Number.parseInt(process.argv[4] || "7", 10);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-bench-"));
fs.mkdirSync(dir, { recursive: true });

const dayStart = Date.UTC(2026, 7, 1);
const store = new RecordStore({ debug() {}, error() {} }, dir, {});
store.open();

const t0 = performance.now();
for (let d = 0; d < DAYS; d++) {
  const base = dayStart + d * 86400000;
  for (let c = 0; c < 96; c++) {
    const ts = base + c * 900000;
    const forecast = [];
    for (let h = 0; h < FORECAST_HOURS; h++) {
      forecast.push({
        time: new Date(ts + h * 3600000).toISOString(),
        idealSolarYieldWh: Math.round(200 * Math.sin((h / 24) * Math.PI)),
        idealWindYieldWh: Math.round(50 + 30 * Math.sin(h)),
        idealHydroYieldWh: 0,
        alternatorWh: 0,
        houseLoadWh: Math.round(120 + 40 * Math.cos(h / 3)),
        idealNetWh: Math.round(-100 + 60 * Math.sin(h / 5)),
        idealSoC: 0.8,
        detectedYieldWh: 0,
        detectedNetWh: 0,
        detectedSoC: 0.8,
        windSpeedKnots: 12.3,
        gustSpeedKnots: 18.1,
        forecastWindSpeedKnots: 11.0,
        forecastGustKnots: 16.5,
        windDirectionDeg: 215,
        actions: [
          {
            type: "engine_run",
            hour: h,
            message: "Run engine 14:00-15:00 to cover evening",
            confidence: 0.7,
          },
        ],
      });
    }
    store.recordCycle({
      timestamp: new Date(ts),
      weatherTier: 2,
      forecast,
      actions: forecast.slice(0, 6).map((p) => p.actions[0]),
      advisories: [
        {
          type: "surplus",
          time: new Date(ts).toISOString(),
          message: "Surplus 300 Wh around noon",
          wh: 300,
        },
      ],
    });
  }
  for (let s = 0; s < 288; s++) {
    store.recordSample({
      timestamp: new Date(base + s * 300000),
      arrays: { "sol-1": { powerW: 180, soc: 0.8 } },
      generators: { "wind-1": { powerW: 40, deployState: "deployed" } },
      soc: 0.8,
      houseLoadW: 130,
      windSpeedKnots: 12.1,
      navState: "anchored",
      position: { latitude: 60.15, longitude: 24.9 },
      stwKnots: 0.2,
      deployStates: { "wind-1": "deployed" },
      controllerModes: { "sol-1": "bulk" },
      awaRad: 1.2,
    });
  }
}
const dbBytes = fs.statSync(path.join(dir, "records.db")).size;
console.log(
  `generated ${DAYS} days @${FORECAST_HOURS}h forecasts into SQLite in ${((performance.now() - t0) / 1000).toFixed(1)}s (${(dbBytes / 1048576).toFixed(1)} MiB)`,
);

const router = {
  routes: new Map(),
  get(p, h) {
    this.routes.set(p, h);
  },
};
registerApiRoutes(router, {
  app: { debug() {}, error() {} },
  getConfig: () => ({
    solarArrays: [{ id: "sol-1" }],
    mechanicalGenerators: [{ id: "wind-1", type: "wind" }],
    weather: { forecastHours: FORECAST_HOURS },
  }),
  store,
  dataDir: dir,
});

const to = new Date(dayStart + DAYS * 86400000);
const from = new Date(to.getTime() - WINDOW_DAYS * 86400000);
const query = { from: from.toISOString(), to: to.toISOString() };

function fetchRoute(p) {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({
          p,
          ms: performance.now() - t0,
          status: this.statusCode,
          body,
        });
        return this;
      },
    };
    const handled = router.routes.get(p)({ query }, res);
    Promise.resolve(handled).catch(reject);
  });
}

// Event-loop stall monitor while the endpoints run
const lags = [];
let lastTick = performance.now();
let maxLag = 0;
const lagTimer = setInterval(() => {
  const now = performance.now();
  const lag = now - lastTick - 10;
  lags.push(lag);
  if (lag > maxLag) maxLag = lag;
  lastTick = now;
}, 10);

// The webapp fires these concurrently (ep-app.js refresh())
const endpoints = [
  "/api/summary",
  "/api/actuals",
  "/api/predictions",
  "/api/retro-predicted",
  "/api/deploy-states",
];
const t1 = performance.now();
const results = await Promise.all(endpoints.map(fetchRoute));
const total = performance.now() - t1;
await new Promise((resolve) => setTimeout(resolve, 50));
clearInterval(lagTimer);
for (const r of results) {
  console.log(
    `${r.p.padEnd(22)} ${(r.ms / 1000).toFixed(2)}s${r.status ? ` (status ${r.status})` : ""}`,
  );
}
console.log(`${WINDOW_DAYS}-day view total: ${(total / 1000).toFixed(2)}s`);
console.log(
  `event-loop stall: max=${maxLag.toFixed(0)}ms (target < 50ms), total ${(total / 1000).toFixed(2)}s (target < 0.3s)`,
);
store.close();
fs.rmSync(dir, { recursive: true, force: true });
