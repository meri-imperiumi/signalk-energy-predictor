/**
 * Tests for PredictionEngine.calculateEngineRunTime.
 *
 * The engine-run (deficit) advisory must report the run time needed to
 * keep the bank above the minimum safe floor and recover — NOT the time to
 * charge to 100% (the old `getDeficit`-based math produced a full-charge
 * duration, e.g. 24h for a half-empty bank). It must also reject transient
 * cycles (empty weather forecast + SoC crashing to the floor) so a single
 * bad cycle can't manufacture a multi-day "run the engine" nudge.
 *
 * @file engine-run-time.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PredictionEngine } = require("../plugin/prediction.js");

function makeFakeApp() {
  return {
    selfId: "self",
    debug() {},
    info() {},
    warn() {},
    error() {},
    getSelfPath: () => null,
  };
}

/**
 * Builds a PredictionEngine with a 400Ah @ 12V bank (4800 Wh) and a 20%
 * floor, and injects a synthetic ideal track into `lastPrediction` so
 * `calculateEngineRunTime` can be exercised without running a full
 * forecast.
 * @param {Array<{soc: number, solarWh: number, netWh: number, hour?: number}>} track
 * @returns {PredictionEngine}
 */
function engineWithTrack(track) {
  const engine = new PredictionEngine({
    battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
    solarArrays: [],
    mechanicalGenerators: [],
    getEfficiency: () => 0.7,
    getSelfPath: () => null,
    app: makeFakeApp(),
  });
  const now = Date.now();
  engine.lastPrediction = track.map((p, i) => ({
    hour: p.hour ?? i,
    time: new Date(now + (p.hour ?? i) * 3600000),
    idealSoC: p.soc,
    idealSolarYieldWh: p.solarWh,
    idealNetWh: p.netWh,
  }));
  return engine;
}

test("calculateEngineRunTime: null when the bank never hits the floor", () => {
  // SoC stays well above 0.2 across the whole horizon
  const engine = engineWithTrack([
    { soc: 0.6, solarWh: 300, netWh: 171 },
    { soc: 0.65, solarWh: 350, netWh: 221 },
    { soc: 0.7, solarWh: 400, netWh: 271 },
  ]);
  assert.strictEqual(engine.calculateEngineRunTime(100), null);
});

test("calculateEngineRunTime: null on a degenerate transient (no solar, SoC crashes to floor)", () => {
  // The 2026-08-23 23:45:52 transient signature: zero solar, SoC falls back
  // to ~0.5 and drains to 0 across the whole horizon.
  const track = [];
  let soc = 0.502;
  for (let i = 0; i < 24; i++) {
    track.push({ soc: Math.max(0, soc), solarWh: 0, netWh: -126 });
    soc -= 0.026;
  }
  const engine = engineWithTrack(track);
  assert.strictEqual(engine.calculateEngineRunTime(100), null);
});

test("calculateEngineRunTime: computes run time from the dip below the floor, not to 100%", () => {
  // Bank dips to 0.10 (0.10 below the 0.20 floor) → shortfall = 0.10 × 4800
  // = 480 Wh. At 100W alternator that's 4.8h of engine run, NOT the ~24h a
  // full-charge calculation would give for a half-empty bank.
  const engine = engineWithTrack([
    { soc: 0.5, solarWh: 200, netWh: -100 },
    { soc: 0.4, solarWh: 150, netWh: -120 },
    { soc: 0.3, solarWh: 100, netWh: -150 },
    { soc: 0.2, solarWh: 50, netWh: -150 },
    { soc: 0.1, solarWh: 0, netWh: -120 }, // deepest dip below the floor
    { soc: 0.18, solarWh: 0, netWh: -100 },
    { soc: 0.25, solarWh: 100, netWh: 30 }, // recovering
    { soc: 0.35, solarWh: 200, netWh: 130 },
  ]);
  const run = engine.calculateEngineRunTime(100);
  assert.ok(run, "expected an engine-run recommendation");
  // shortfall = (0.20 - 0.10) * 4800 = 480 Wh → 4.8h at 100W
  assert.strictEqual(run.hours, 4.8);
});

test("calculateEngineRunTime: caps the run time to the forecast horizon", () => {
  // A deep dip (to 0.0) would need 0.20 * 4800 = 960 Wh = 9.6h at 100W, but
  // the horizon is only 4 hours — cap there so a bad input can't request a
  // run longer than we actually forecast. Include a little solar so the
  // degenerate no-solar guard doesn't reject the track.
  const engine = engineWithTrack([
    { soc: 0.4, solarWh: 10, netWh: -150 },
    { soc: 0.25, solarWh: 10, netWh: -150 },
    { soc: 0.1, solarWh: 10, netWh: -150 },
    { soc: 0.0, solarWh: 10, netWh: -150 },
  ]);
  const run = engine.calculateEngineRunTime(100);
  assert.ok(run);
  assert.strictEqual(run.hours, 4); // capped to horizonHours
});

test("calculateEngineRunTime: null when engineWatts is missing or non-positive", () => {
  const engine = engineWithTrack([
    { soc: 0.1, solarWh: 0, netWh: -100 },
    { soc: 0.0, solarWh: 0, netWh: -100 },
  ]);
  assert.strictEqual(engine.calculateEngineRunTime(0), null);
  assert.strictEqual(engine.calculateEngineRunTime(null), null);
});

test("calculateEngineRunTime: null on an empty forecast", () => {
  const engine = engineWithTrack([]);
  assert.strictEqual(engine.calculateEngineRunTime(100), null);
});

test("calculateEngineRunTime: a real overnight drain with some solar still advises", () => {
  // Bank at 0.5 discharging overnight to 0.15 (below the 0.2 floor) before
  // tomorrow's solar recovers it. This is a genuine deficit, not a
  // transient: there IS solar in the track (just later).
  const track = [];
  let soc = 0.5;
  for (let i = 0; i < 6; i++) {
    track.push({ soc, solarWh: 0, netWh: -120 });
    soc -= 0.025;
  }
  track.push({ soc: 0.15, solarWh: 0, netWh: -120 }); // dips below floor
  // Solar returns, bank recovers
  track.push({ soc: 0.18, solarWh: 200, netWh: 70 });
  track.push({ soc: 0.3, solarWh: 400, netWh: 270 });
  track.push({ soc: 0.5, solarWh: 500, netWh: 370 });
  const engine = engineWithTrack(track);
  const run = engine.calculateEngineRunTime(100);
  assert.ok(run, "a genuine overnight deficit should advise an engine run");
  // shortfall = (0.20 - 0.15) * 4800 = 240 Wh → 2.4h at 100W
  assert.strictEqual(run.hours, 2.4);
});
