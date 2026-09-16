/**
 * Server-impact benchmark: measures the plugin's cost on the host process
 * while a realistic instrumented-boat delta stream is fed through it.
 *
 * Simulates ~15 deltas/sec across the plugin's subscribed paths (NMEA-typical
 * rates: wind 4 Hz, position/SoC/power 1 Hz, etc.) and reports:
 *
 *  - CPU time (user+sys) consumed while feeding the stream
 *  - event-loop lag distribution (p50/p95/max) during the feed
 *  - per-delta wall cost
 *  - heap growth
 *
 * Usage: node tests/bench-server-impact.mjs [seconds]
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import makePlugin from "../plugin/index.js";

const SECONDS = Number.parseInt(process.argv[2] || "30", 10);
const GC = typeof globalThis.gc === "function";
const heapPoint = () => {
  if (GC) globalThis.gc();
  return Math.round(process.memoryUsage().heapUsed / 1024);
};

class FakeSubscriptionManager {
  constructor() {
    this.subscriptions = [];
  }

  subscribe(subscription, unsubscribes, _errorHandler, deltaHandler) {
    this.subscriptions.push({ subscription, deltaHandler });
    unsubscribes.push(() => {});
  }

  emitDelta(delta) {
    for (const { deltaHandler } of this.subscriptions) {
      try {
        deltaHandler(delta);
      } catch {
        /* ignore */
      }
    }
  }
}

class FakeApp extends EventEmitter {
  constructor({ verboseDebug = false } = {}) {
    super();
    this.selfId = "urn:mrn:imo:mmsi:123456789";
    this.subscriptionmanager = new FakeSubscriptionManager();
    this.pathValues = new Map();
    this.debugCalls = 0;
    this.verboseDebug = verboseDebug;
  }

  getSelfPath(p) {
    return this.pathValues.get(p);
  }

  getDataDirPath() {
    return this.dataPath;
  }

  setPluginStatus() {}

  debug(msg) {
    this.debugCalls += 1;
    if (this.verboseDebug)
      console.log(`  [debug ${performance.now().toFixed(0)}ms] ${msg}`);
  }

  error(msg) {
    console.error("  app.error:", msg);
  }

  warn() {}

  handleMessage() {}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-impact-"));
const app = new FakeApp({ verboseDebug: process.env.EP_BENCH_DEBUG === "1" });
app.dataPath = path.join(dir, "data");
fs.mkdirSync(app.dataPath, { recursive: true });

const config = {
  battery: {
    capacityAh: 400,
    systemVoltage: 12,
    minSafeSoC: 0.2,
    socPath: "electrical.batteries.house.capacity.stateOfCharge",
  },
  solarArrays: [
    {
      id: "cabin-roof",
      type: "fixed",
      capacityWp: 400,
      enabled: true,
      powerPath: "electrical.solar.cabin.power",
    },
  ],
  mechanicalGenerators: [
    {
      id: "windgenny",
      type: "wind",
      enabled: true,
      powerPath: "electrical.wind.power",
      deployable: true,
    },
  ],
  learning: { enabled: true, saveIntervalMinutes: 60, minIntervalSeconds: 60 },
  weather: { openMeteoEnabled: false, useLogbook: false, forecastHours: 24 },
  windProtection: { enabled: true },
};

const plugin = makePlugin(app);
await plugin.start(config, () => {});
const internals = plugin.__getInternals();

// Retained-heap baselines (forced GC so we measure live data, not garbage)
const heapBaseline = heapPoint();
const heapMarks = [];

// Wrap the periodic async cycles with timing so stalls can be attributed
for (const name of [
  "runPredictionCycle",
  "recordSample",
  "runWindProtectionLearning",
]) {
  const orig = internals[name];
  internals[name] = async (...args) => {
    const t0 = performance.now();
    try {
      return await orig(...args);
    } finally {
      const dt = performance.now() - t0;
      if (dt > 20) console.log(`  !! ${name} took ${dt.toFixed(0)}ms`);
    }
  };
}

// Seed server-side state so the plugin doesn't skip work
app.pathValues.set("navigation.state", { value: "anchored" });
app.pathValues.set("navigation.position", {
  value: { latitude: 60.15, longitude: 24.9 },
});

const sm = app.subscriptionmanager;

// Pre-wind the rolling histories so per-delta work runs at steady state
for (let i = 0; i < 60; i++) {
  const t = Date.now() - (60 - i) * 1000;
  sm.emitDelta({
    updates: [
      {
        timestamp: new Date(t).toISOString(),
        values: [
          { path: "environment.wind.speedApparent", value: 12 + Math.random() },
        ],
      },
    ],
  });
  sm.emitDelta({
    updates: [
      {
        timestamp: new Date(t).toISOString(),
        values: [
          {
            path: "electrical.solar.cabin.power",
            value: 100 + Math.random() * 50,
          },
        ],
      },
    ],
  });
}

// Event loop lag monitor: 10ms timer
const lags = [];
let lastTick = performance.now();
const t0 = performance.now();
const lagTimer = setInterval(() => {
  const now = performance.now();
  const lag = now - lastTick - 10;
  lags.push(lag);
  if (lag > 20) {
    console.log(
      `  ~~ lag ${lag.toFixed(0)}ms at t=${(now - t0).toFixed(0)}ms (bench t=${(now - startWall).toFixed(0)}ms)`,
    );
  }
  lastTick = now;
}, 10);

// Delta stream generator: NMEA-typical rates
function makeDelta(path, value) {
  return {
    context: "vessels.self",
    updates: [
      { timestamp: new Date().toISOString(), values: [{ path, value }] },
    ],
  };
}

const streams = [];
const addStream = (hz, fn) =>
  streams.push({ interval: 1000 / hz, fn, next: performance.now() });
addStream(4, () =>
  makeDelta("environment.wind.speedApparent", 12 + Math.random() * 5),
);
addStream(4, () =>
  makeDelta("environment.wind.angleApparent", Math.random() * 6.28),
);
addStream(1, () =>
  makeDelta("navigation.position", {
    latitude: 60.15 + Math.random() * 1e-4,
    longitude: 24.9,
  }),
);
addStream(1, () =>
  makeDelta("navigation.headingTrue", 1.2 + Math.random() * 0.1),
);
addStream(1, () =>
  makeDelta("navigation.speedThroughWater", 0.2 + Math.random() * 0.05),
);
addStream(1, () => makeDelta("navigation.courseOverGroundTrue", 1.2));
addStream(1, () =>
  makeDelta("navigation.speedOverGround", 0.3 + Math.random() * 0.1),
);
addStream(1, () =>
  makeDelta("electrical.batteries.house.capacity.stateOfCharge", 0.82),
);
addStream(1, () =>
  makeDelta("electrical.venus.dcPower", -80 + Math.random() * 20),
);
addStream(1, () =>
  makeDelta("electrical.solar.cabin.power", 100 + Math.random() * 50),
);
addStream(1, () => makeDelta("electrical.wind.power", 20 + Math.random() * 10));

let deltaCount = 0;
const startWall = performance.now();
const startCpu = process.cpuUsage();
const startHeap = process.memoryUsage().heapUsed;

await new Promise((resolve) => {
  const feedEnd = startWall + SECONDS * 1000;
  let lastMark = 0;
  const feeder = setInterval(() => {
    const now = performance.now();
    for (const s of streams) {
      while (s.next <= now && s.next <= feedEnd) {
        sm.emitDelta(s.fn());
        deltaCount += 1;
        s.next += s.interval;
      }
    }
    if (now - lastMark >= 15000) {
      lastMark = now;
      heapMarks.push({
        t: Math.round((now - startWall) / 1000),
        heap: heapPoint(),
      });
    }
    if (now >= feedEnd) {
      clearInterval(feeder);
      resolve();
    }
  }, 5);
});

// Let pending async work (learning cycle etc.) settle
await new Promise((resolve) => setTimeout(resolve, 500));

clearInterval(lagTimer);
const cpu = process.cpuUsage(startCpu);
const wall = performance.now() - startWall;
const heap = process.memoryUsage().heapUsed;
lags.sort((a, b) => a - b);
const pct = (p) =>
  lags[Math.min(lags.length - 1, Math.floor((p / 100) * lags.length))];

console.log(
  `\n=== Server impact benchmark (${SECONDS}s, ${deltaCount} deltas, ${app.debugCalls} debug logs) ===`,
);
console.log(
  `heap retained:    start=${heapBaseline}KiB ${heapMarks.map((m) => `t${m.t}s=${m.heap}KiB`).join(" ")}`,
);
console.log(`wall:            ${(wall / 1000).toFixed(2)}s`);
console.log(
  `cpu (user+sys):  ${((cpu.user + cpu.system) / 1000).toFixed(1)}ms  (${(((cpu.user + cpu.system) / 1000 / wall) * 100).toFixed(1)}% of one core)`,
);
console.log(
  `per delta:       ${((cpu.user + cpu.system) / 1000 / deltaCount).toFixed(3)}ms cpu`,
);
console.log(`heap growth:     ${((heap - startHeap) / 1024).toFixed(0)} KiB`);
console.log(
  `event-loop lag:  p50=${pct(50).toFixed(1)}ms p95=${pct(95).toFixed(1)}ms max=${lags[lags.length - 1].toFixed(1)}ms`,
);

await plugin.stop();
fs.rmSync(dir, { recursive: true, force: true });
