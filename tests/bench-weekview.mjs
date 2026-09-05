/**
 * End-to-end week-view load benchmark: generates production-scale
 * recordings (96 cycles/day with forecastHours-point forecasts, 288
 * samples/day) and fires the webapp's 5 window endpoints concurrently
 * against real registered routes, reporting per-endpoint wall time.
 *
 * Usage: node tests/bench-weekview.mjs [days] [forecastHours]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { registerApiRoutes } from "../plugin/api.js";

const DAYS = Number.parseInt(process.argv[2] || "30", 10);
const FORECAST_HOURS = Number.parseInt(process.argv[3] || "48", 10);
const WINDOW_DAYS = Number.parseInt(process.argv[4] || "7", 10);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-bench-"));
const recDir = path.join(dir, "recordings");
fs.mkdirSync(recDir, { recursive: true });

const dayStart = Date.UTC(2026, 7, 1);
for (let d = 0; d < DAYS; d++) {
  const base = dayStart + d * 86400000;
  const file = path.join(
    recDir,
    new Date(base).toISOString().slice(0, 10) + ".jsonl",
  );
  const lines = [];
  for (let c = 0; c < 96; c++) {
    const ts = new Date(base + c * 900000);
    const forecast = [];
    for (let h = 0; h < FORECAST_HOURS; h++) {
      forecast.push({
        time: new Date(ts.getTime() + h * 3600000).toISOString(),
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
    lines.push(
      JSON.stringify({
        type: "cycle",
        timestamp: ts.toISOString(),
        weatherTier: 2,
        forecast,
        actions: forecast.slice(0, 6).map((p) => p.actions[0]),
        advisories: [
          {
            type: "surplus",
            time: ts.toISOString(),
            message: "Surplus 300 Wh around noon",
            wh: 300,
          },
        ],
      }),
    );
  }
  for (let s = 0; s < 288; s++) {
    const ts = new Date(base + s * 300000);
    lines.push(
      JSON.stringify({
        type: "sample",
        timestamp: ts.toISOString(),
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
      }),
    );
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

const sizes = fs
  .readdirSync(recDir)
  .map((f) => fs.statSync(path.join(recDir, f)).size);
console.log(
  `generated ${DAYS} day-files (${FORECAST_HOURS}h forecasts), avg ${(sizes.reduce((a, b) => a + b, 0) / sizes.length / 1024).toFixed(0)} KiB/file`,
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

// The webapp fires these concurrently (ep-app.js refresh())
const endpoints = [
  "/api/summary",
  "/api/actuals",
  "/api/predictions",
  "/api/retro-predicted",
  "/api/deploy-states",
];
const t0 = performance.now();
const results = await Promise.all(endpoints.map(fetchRoute));
const total = performance.now() - t0;
for (const r of results) {
  console.log(
    `${r.p.padEnd(22)} ${(r.ms / 1000).toFixed(2)}s${r.status ? ` (status ${r.status})` : ""}`,
  );
}
console.log(`${WINDOW_DAYS}-day view total: ${(total / 1000).toFixed(2)}s`);
fs.rmSync(dir, { recursive: true, force: true });
