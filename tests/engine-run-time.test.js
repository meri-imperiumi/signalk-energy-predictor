/**
 * Tests for the combustion tier model (#11): genset and engine as
 * high-reluctance deployable generators.
 *
 * The engine-run (deficit) advisory must report the run time needed to
 * lift the bank past the minimum safe floor by the batch margin — NOT the
 * time to charge to 100% — and must respect the tier discipline:
 * sustained-violation gating (no marginal midnight dips), minimum useful
 * run, batching while running, cooldown after a run, and the night hold
 * (prefer the morning solar window when the floor isn't breached before
 * sunrise). The genset tier deploys at a lower bar than the engine tier,
 * so a deficit escalates renewables → genset → engine.
 *
 * @file engine-run-time.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PredictionEngine } = require("../plugin/prediction.js");
const {
  evaluateCombustionTier,
  updateCombustionRuns,
  resolveTierSettings,
  DEFAULT_TIER_SETTINGS,
} = require("../plugin/combustion.js");

function makeFakeApp() {
  const pathValues = new Map();
  return {
    selfId: "self",
    debug() {},
    info() {},
    warn() {},
    error() {},
    getSelfPath(path) {
      return pathValues.get(path);
    },
    setSelfPath(path, value) {
      pathValues.set(path, value);
    },
  };
}

const ENGINE_SETTINGS = resolveTierSettings("engine");
const GENSET_SETTINGS = resolveTierSettings("genset");
const NOW = new Date("2026-08-23T12:00:00Z");

/**
 * Builds a track like the prediction engine's lastPrediction.
 * @param {Array<{soc: number, solarWh?: number}>} points
 */
function makeTrack(points) {
  return points.map((p, i) => ({
    time: new Date(NOW.getTime() + i * 3600000),
    idealSoC: p.soc,
    idealSolarYieldWh: p.solarWh ?? 0,
  }));
}

/** A genuine sustained deficit: bank drains below the floor for hours. */
function deficitTrack() {
  // 4800 Wh bank, 0.2 floor. Drains from 0.5 to 0.10 over 8 hours with
  // a little solar (so the degenerate no-solar guard doesn't reject),
  // then recovers.
  return makeTrack([
    { soc: 0.5, solarWh: 10 },
    { soc: 0.42, solarWh: 10 },
    { soc: 0.33, solarWh: 10 },
    { soc: 0.24, solarWh: 10 },
    { soc: 0.18, solarWh: 10 }, // below floor from here — 5 consecutive
    { soc: 0.14, solarWh: 10 },
    { soc: 0.1, solarWh: 10 },
    { soc: 0.12, solarWh: 200 },
    { soc: 0.2, solarWh: 300 },
    { soc: 0.35, solarWh: 300 },
  ]);
}

// --- evaluateCombustionTier: gating ------------------------------------

test("engine tier: null when the bank never hits the floor", () => {
  const result = evaluateCombustionTier({
    track: makeTrack([
      { soc: 0.6, solarWh: 300 },
      { soc: 0.65, solarWh: 350 },
      { soc: 0.7, solarWh: 400 },
    ]),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.6,
    now: NOW,
  });
  assert.strictEqual(result, null);
});

test("engine tier: null on a degenerate transient (no solar, SoC crashes to floor)", () => {
  const track = [];
  let soc = 0.502;
  for (let i = 0; i < 24; i++) {
    track.push({ soc: Math.max(0, soc), solarWh: 0 });
    soc -= 0.026;
  }
  const result = evaluateCombustionTier({
    track: makeTrack(track.slice(0, 24).map((p) => ({ ...p }))),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.5,
    now: NOW,
  });
  assert.strictEqual(result, null);
});

test("engine tier: sustained gate rejects a marginal dip", () => {
  // Only one hour dips below the floor — below the engine tier's
  // sustainedHours default of 3.
  assert.ok(ENGINE_SETTINGS.sustainedHours >= 2);
  const result = evaluateCombustionTier({
    track: makeTrack([
      { soc: 0.35, solarWh: 100 },
      { soc: 0.28, solarWh: 100 },
      { soc: 0.19, solarWh: 100 }, // single marginal dip
      { soc: 0.3, solarWh: 200 },
      { soc: 0.4, solarWh: 300 },
    ]),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.35,
    now: NOW,
  });
  assert.strictEqual(result, null);
});

test("engine tier: a bank already below the floor deploys immediately", () => {
  const result = evaluateCombustionTier({
    track: makeTrack([
      { soc: 0.15, solarWh: 100 },
      { soc: 0.12, solarWh: 100 },
    ]),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.15,
    now: NOW,
  });
  assert.ok(result, "actual violation deploys without waiting");
  assert.strictEqual(result.recommendedState, "deployed");
  assert.match(result.reason, /already below/);
});

test("engine tier: computes run time to floor + batch margin, not to 100%", () => {
  // Deepest dip 0.10; target = 0.2 + 0.1 margin = 0.30 → shortfall
  // (0.30 − 0.10) × 4800 = 960 Wh → 9.6h at 100 W.
  const result = evaluateCombustionTier({
    track: deficitTrack(),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.5,
    now: NOW,
  });
  assert.ok(result);
  assert.strictEqual(result.recommendedState, "deployed");
  assert.strictEqual(result.runHours, 9.6);
});

test("engine tier: never recommends a run shorter than the minimum", () => {
  // Dip to 0.16 with default margin 0.1 → target 0.30 → shortfall
  // 0.14 × 4800 = 672 Wh — big enough. Now shrink the bank so the
  // shortfall is tiny: 200 Wh bank → 0.14 × 200 = 28 Wh < 100 W × 1h.
  const track = makeTrack([
    { soc: 0.5, solarWh: 10 },
    { soc: 0.3, solarWh: 10 },
    { soc: 0.16, solarWh: 10 },
    { soc: 0.16, solarWh: 10 },
    { soc: 0.16, solarWh: 10 },
    { soc: 0.3, solarWh: 10 },
  ]);
  const result = evaluateCombustionTier({
    track,
    minSafeSoC: 0.2,
    capacityWh: 200,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.5,
    now: NOW,
  });
  assert.strictEqual(result, null, "sub-minimum run is not worth starting");
});

test("engine tier: caps the run time to the forecast horizon", () => {
  const result = evaluateCombustionTier({
    track: makeTrack([
      { soc: 0.3, solarWh: 10 },
      { soc: 0.19, solarWh: 10 },
      { soc: 0.15, solarWh: 10 },
      { soc: 0.1, solarWh: 10 },
    ]), // 4-hour horizon
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.3,
    now: NOW,
  });
  assert.ok(result);
  assert.strictEqual(result.runHours, 4); // capped to horizon
});

test("engine tier: null when watts is missing or non-positive", () => {
  const common = {
    track: deficitTrack(),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.5,
    now: NOW,
  };
  assert.strictEqual(evaluateCombustionTier({ ...common, watts: 0 }), null);
  assert.strictEqual(evaluateCombustionTier({ ...common, watts: null }), null);
});

test("engine tier: null on an empty forecast", () => {
  const result = evaluateCombustionTier({
    track: [],
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    now: NOW,
  });
  assert.strictEqual(result, null);
});

test("engine tier: night hold defers a forecast violation that sunrise would beat", () => {
  // Night now (23:00), violation projected at 09:00 — after the 05:00
  // sunrise. The engine tier holds (prefer the morning solar window).
  const night = new Date("2026-08-23T23:00:00Z");
  const sunrise = new Date("2026-08-24T05:00:00Z");
  const track = [];
  for (let i = 0; i < 10; i++) {
    track.push({ soc: i < 9 ? 0.5 - i * 0.03 : 0.14, solarWh: 10 });
  }
  // Violation starts at hour 9 (08:00) — 3+ hours below floor by the end
  const result = evaluateCombustionTier({
    track: makeTrack(track),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.5,
    now: night,
    isNight: true,
    sunrise,
  });
  assert.strictEqual(result, null, "night hold defers to sunrise");
});

test("engine tier: night hold does not defer an actual violation", () => {
  const night = new Date("2026-08-23T23:00:00Z");
  const sunrise = new Date("2026-08-24T05:00:00Z");
  const result = evaluateCombustionTier({
    track: makeTrack([
      { soc: 0.18, solarWh: 10 },
      { soc: 0.15, solarWh: 10 },
      { soc: 0.12, solarWh: 10 },
      { soc: 0.1, solarWh: 10 },
    ]),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.18,
    now: night,
    isNight: true,
    sunrise,
  });
  assert.ok(result, "a bank already below the floor cannot wait for sunrise");
});

test("genset tier: deploys at a lower bar than the engine tier", () => {
  assert.ok(
    GENSET_SETTINGS.sustainedHours < ENGINE_SETTINGS.sustainedHours,
    "genset sustained threshold is lower",
  );
  // A 2-hour dip: below the engine's sustained bar, at the genset's.
  // The genset is 600 W so the 480 Wh batch clears its 45-minute
  // minimum-run gate (a 3 kW genset would finish in minutes and
  // correctly wouldn't be started).
  const track = makeTrack([
    { soc: 0.35, solarWh: 10 },
    { soc: 0.19, solarWh: 10 },
    { soc: 0.15, solarWh: 10 },
    { soc: 0.3, solarWh: 200 },
  ]);
  const base = {
    track,
    minSafeSoC: 0.2,
    capacityWh: 4800,
    currentSoC: 0.35,
    now: NOW,
  };
  const engineResult = evaluateCombustionTier({
    ...base,
    watts: 100,
    settings: ENGINE_SETTINGS,
  });
  const gensetResult = evaluateCombustionTier({
    ...base,
    watts: 600,
    settings: GENSET_SETTINGS,
  });
  assert.strictEqual(engineResult, null, "engine holds for a short dip");
  assert.ok(gensetResult, "genset (sustained 2h) responds to the same dip");
  assert.strictEqual(gensetResult.recommendedState, "deployed");
});

// --- evaluateCombustionTier: batching & cooldown -------------------------

test("batching: keep running until floor + margin and the minimum run", () => {
  const started = new Date(NOW.getTime() - 30 * 60000); // 30 min ago
  // Below target (0.30) and under the 60 min minimum → keep running
  const keep = evaluateCombustionTier({
    track: deficitTrack(),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.22,
    running: true,
    runningSince: started,
    now: NOW,
  });
  assert.strictEqual(keep.recommendedState, "deployed");
  assert.match(keep.reason, /keep running/);

  // Target reached but minimum run not yet → still keep running
  const short = evaluateCombustionTier({
    track: deficitTrack(),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.35,
    running: true,
    runningSince: started,
    now: NOW,
  });
  assert.strictEqual(short.recommendedState, "deployed");
  assert.match(short.reason, /minimum run/);

  // Target reached and minimum run done → stop, batch complete
  const done = evaluateCombustionTier({
    track: deficitTrack(),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.35,
    running: true,
    runningSince: new Date(NOW.getTime() - 90 * 60000),
    now: NOW,
  });
  assert.strictEqual(done.recommendedState, "stowed");
  assert.match(done.reason, /batch complete/);
});

test("cooldown: a just-ended run suppresses new recommendations", () => {
  const result = evaluateCombustionTier({
    track: deficitTrack(),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.25,
    lastRunEnd: new Date(NOW.getTime() - 1 * 3600000), // 1h ago (< 6h)
    now: NOW,
  });
  assert.strictEqual(result, null);

  // After the cooldown window, the deficit surfaces again
  const after = evaluateCombustionTier({
    track: deficitTrack(),
    minSafeSoC: 0.2,
    capacityWh: 4800,
    watts: 100,
    settings: ENGINE_SETTINGS,
    currentSoC: 0.25,
    lastRunEnd: new Date(NOW.getTime() - 7 * 3600000), // 7h ago (> 6h)
    now: NOW,
  });
  assert.ok(after);
});

// --- updateCombustionRuns ------------------------------------------------

test("updateCombustionRuns tracks run start and end transitions", () => {
  const runs = new Map();
  const t0 = new Date("2026-08-23T10:00:00Z");
  const t1 = new Date("2026-08-23T12:00:00Z");
  const t2 = new Date("2026-08-23T14:00:00Z");

  updateCombustionRuns(runs, new Map([["dc-generator", "deployed"]]), t0);
  assert.strictEqual(runs.get("dc-generator").runningSince, t0);

  // Still running: runningSince unchanged
  updateCombustionRuns(runs, new Map([["dc-generator", "deployed"]]), t1);
  assert.strictEqual(runs.get("dc-generator").runningSince, t0);

  // Stopped: lastRunEnd stamped, runningSince cleared
  updateCombustionRuns(runs, new Map([["dc-generator", "stowed"]]), t2);
  assert.strictEqual(runs.get("dc-generator").runningSince, null);
  assert.strictEqual(runs.get("dc-generator").lastRunEnd, t2);
});

// --- PredictionEngine.getCombustionRecommendations ------------------------

/**
 * Builds a PredictionEngine with a 400Ah @ 12V bank (4800 Wh) and a 20%
 * floor, with configured engines/gensets and a synthetic ideal track
 * (as produced by makeTrack).
 */
function engineWithTrack(track, { engines, gensets, app } = {}) {
  const a = app || makeFakeApp();
  const engine = new PredictionEngine({
    battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
    solarArrays: [],
    mechanicalGenerators: [],
    engines,
    gensets,
    getEfficiency: () => 0.7,
    getSelfPath: (path) => a.getSelfPath(path),
    app: a,
  });
  engine.lastPrediction = track.map((p, i) => ({
    hour: i,
    time: p.time ?? new Date(NOW.getTime() + i * 3600000),
    idealSoC: p.idealSoC,
    idealSolarYieldWh: p.idealSolarYieldWh ?? 0,
    idealNetWh: p.idealNetWh ?? 0,
  }));
  return engine;
}

test("getCombustionRecommendations: sustained deficit recommends an engine run", () => {
  const app = makeFakeApp();
  app.setSelfPath("propulsion.main.state", "stopped");
  const engine = engineWithTrack(deficitTrack(), {
    engines: [{ id: "main", name: "Engine", alternatorWatts: 100 }],
    app,
  });
  const recs = engine.getCombustionRecommendations({ now: NOW });
  assert.strictEqual(recs.length, 1);
  const rec = recs[0];
  assert.strictEqual(rec.type, "engine");
  assert.strictEqual(rec.tier, 3);
  assert.strictEqual(rec.recommendedState, "deployed");
  assert.strictEqual(rec.detectedState, "stowed");
  assert.strictEqual(rec.runHours, 9.6);
  assert.ok(rec.windowStart instanceof Date);
  assert.ok(rec.windowEnd instanceof Date);
});

test("getCombustionRecommendations: genset escalates before the engine", () => {
  const app = makeFakeApp();
  const engine = engineWithTrack(deficitTrack(), {
    engines: [{ id: "main", name: "Engine", alternatorWatts: 100 }],
    gensets: [{ id: "dc-generator", name: "DC generator", outputWatts: 600 }],
    app,
  });
  const recs = engine.getCombustionRecommendations({ now: NOW });
  // Both tiers are warranted on a deep sustained deficit, but the genset
  // (tier 2) comes first — cost-class ordering renewables → genset → engine.
  assert.strictEqual(recs.length, 2);
  assert.strictEqual(recs[0].type, "genset");
  assert.strictEqual(recs[1].type, "engine");
});

test("getCombustionRecommendations: strongest alternator wins the engine rec", () => {
  const app = makeFakeApp();
  const engine = engineWithTrack(deficitTrack(), {
    engines: [
      { id: "port", name: "Port engine", alternatorWatts: 80 },
      { id: "starboard", name: "Starboard engine", alternatorWatts: 150 },
    ],
    app,
  });
  const recs = engine.getCombustionRecommendations({ now: NOW });
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].id, "starboard");
  assert.strictEqual(recs[0].watts, 150);
});

test("getCombustionRecommendations: engines without alternators are never generators", () => {
  const app = makeFakeApp();
  app.setSelfPath("propulsion.port.state", "started");
  const engine = engineWithTrack(deficitTrack(), {
    engines: [
      // Electric drive: consumer, not a generator
      { id: "port", name: "Electric drive", alternatorWatts: 0 },
    ],
    app,
  });
  const recs = engine.getCombustionRecommendations({ now: NOW });
  assert.deepStrictEqual(recs, []);
});

test("getCombustionRecommendations: running engine under way keeps charging (no prompt)", () => {
  const app = makeFakeApp();
  app.setSelfPath("propulsion.main.state", "started");
  const engine = engineWithTrack(deficitTrack(), {
    engines: [{ id: "main", name: "Engine", alternatorWatts: 100 }],
    app,
  });
  const recs = engine.getCombustionRecommendations({ now: NOW });
  assert.strictEqual(recs.length, 1);
  // Detected running matches "deployed" → no state change needed
  assert.strictEqual(recs[0].recommendedState, "deployed");
  assert.strictEqual(recs[0].detectedState, "deployed");
});

test("defaults: genset night runs unremarkable, engine holds at night", () => {
  assert.strictEqual(DEFAULT_TIER_SETTINGS.genset.nightHold, false);
  assert.strictEqual(DEFAULT_TIER_SETTINGS.engine.nightHold, true);
});
