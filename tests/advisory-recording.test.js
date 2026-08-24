/**
 * Tests for the per-cycle advisory recording helper (`buildCycleAdvisories`)
 * that produces the `advisories` array written into each recorded cycle and
 * later surfaced by /api/deploy-states.
 *
 * @file advisory-recording.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const makePlugin = require("../plugin/index.js");

function makeApp() {
  return {
    debug() {},
    error() {},
    warn() {},
    setPluginStatus() {},
    getSelfPath: () => null,
    getDataDirPath: () => "/tmp",
    subscriptionmanager: { subscribe() {} },
    on: () => {},
  };
}

test("buildCycleAdvisories: records surplus, engine-run (deficit) and stowage advisories", () => {
  const plugin = makePlugin(makeApp());
  const { buildCycleAdvisories } = plugin.__getInternals();

  const advisories = buildCycleAdvisories({
    surplusOpportunity: {
      surplusWh: 1200,
      from: new Date("2026-08-23T14:00:00Z"),
      to: new Date("2026-08-23T18:00:00Z"),
      suggestedLoadW: 150,
    },
    combustionRecommendations: [
      {
        id: "main",
        name: "Engine",
        type: "engine",
        tier: 3,
        recommendedState: "deployed",
        reason: "bank projected below the 20% floor for 4h",
        detectedState: "stowed",
        watts: 100,
        runHours: 1.5,
        windowStart: new Date("2026-08-23T06:00:00Z"),
        windowEnd: new Date("2026-08-23T07:30:00Z"),
      },
    ],
    stowageOpportunity: {
      hour: 3,
      reason: "Deficit covered by hour 3, 800Wh solar remaining",
    },
    localOffsetMinutes: 0,
  });

  assert.deepStrictEqual(
    advisories.map((a) => ({ type: a.type, message: a.message })),
    [
      {
        type: "surplus",
        message: "1.2kWh surplus available 14:00-18:00 (~150W sustained)",
      },
      {
        type: "engine_run",
        message: "Run Engine for 1.5h between 06:00-07:30 to avoid low battery",
      },
      {
        type: "stow_soon",
        message:
          "Stow mechanical generators in 3h to reduce drag - Deficit covered by hour 3, 800Wh solar remaining",
      },
    ],
  );
  // Surplus/engine advisories carry the action time; stowage carries the
  // cycle timestamp (an ISO string).
  assert.strictEqual(advisories[0].time, "2026-08-23T14:00:00.000Z");
  assert.strictEqual(advisories[1].time, "2026-08-23T06:00:00.000Z");
  assert.strictEqual(advisories[2].type, "stow_soon");
});

test("buildCycleAdvisories: omits null opportunities", () => {
  const plugin = makePlugin(makeApp());
  const { buildCycleAdvisories } = plugin.__getInternals();

  const advisories = buildCycleAdvisories({
    surplusOpportunity: null,
    combustionRecommendations: [],
    stowageOpportunity: null,
    localOffsetMinutes: 0,
  });
  assert.deepStrictEqual(advisories, []);
});

test("buildCycleAdvisories: surplus message omits sustained wattage when zero", () => {
  const plugin = makePlugin(makeApp());
  const { buildCycleAdvisories } = plugin.__getInternals();

  const advisories = buildCycleAdvisories({
    surplusOpportunity: {
      surplusWh: 300,
      from: new Date("2026-08-23T14:00:00Z"),
      to: new Date("2026-08-23T16:00:00Z"),
      suggestedLoadW: 0,
    },
    combustionRecommendations: [],
    stowageOpportunity: null,
    localOffsetMinutes: 0,
  });
  assert.strictEqual(advisories.length, 1);
  assert.strictEqual(
    advisories[0].message,
    "300Wh surplus available 14:00-16:00",
  );
});

test("buildCycleAdvisories: surplus carries structured data + elective-load suggestions", () => {
  const plugin = makePlugin(makeApp());
  const { buildCycleAdvisories } = plugin.__getInternals();

  const advisories = buildCycleAdvisories({
    surplusOpportunity: {
      // 1.2 kWh over a 4h window
      surplusWh: 1200,
      from: new Date("2026-08-23T14:00:00Z"),
      to: new Date("2026-08-23T18:00:00Z"),
      suggestedLoadW: 150,
    },
    combustionRecommendations: [],
    stowageOpportunity: null,
    opportunisticLoads: [
      { name: "Watermaker", watts: 150 },
      { name: "Ice maker", watts: 400 },
      // A load already running is not suggested
      {
        name: "Starlink",
        watts: 50,
        statePath: "network.providers.starlink.state",
      },
    ],
    // Simulate Starlink already running
    isLoadRunning: (load) => load.name === "Starlink",
    localOffsetMinutes: 0,
  });
  assert.strictEqual(advisories.length, 1);
  const surplus = advisories[0];
  assert.strictEqual(surplus.type, "surplus");
  assert.strictEqual(surplus.surplusWh, 1200);
  assert.strictEqual(surplus.sustainedW, 150);
  assert.strictEqual(surplus.from, "2026-08-23T14:00:00.000Z");
  assert.strictEqual(surplus.to, "2026-08-23T18:00:00.000Z");
  // Watermaker: 1200Wh / 150W = 8h, capped to 4h window
  // Ice maker: 1200Wh / 400W = 3h (under the 4h window)
  // Starlink: filtered out (already running)
  assert.deepStrictEqual(
    surplus.loads.map((l) => ({
      name: l.name,
      watts: l.watts,
      runHours: l.runHours,
    })),
    [
      { name: "Watermaker", watts: 150, runHours: 4 },
      { name: "Ice maker", watts: 400, runHours: 3 },
    ],
  );
});

test("buildCycleAdvisories: engine-run advisory carries structured window data", () => {
  const plugin = makePlugin(makeApp());
  const { buildCycleAdvisories } = plugin.__getInternals();

  const advisories = buildCycleAdvisories({
    surplusOpportunity: null,
    combustionRecommendations: [
      {
        id: "main",
        name: "Engine",
        type: "engine",
        tier: 3,
        recommendedState: "deployed",
        reason: "bank projected below the 20% floor for 4h",
        detectedState: "stowed",
        watts: 100,
        runHours: 1.5,
        windowStart: new Date("2026-08-23T06:00:00Z"),
        windowEnd: new Date("2026-08-23T07:30:00Z"),
      },
    ],
    stowageOpportunity: null,
    localOffsetMinutes: 0,
  });
  assert.strictEqual(advisories.length, 1);
  const engine = advisories[0];
  assert.strictEqual(engine.type, "engine_run");
  assert.strictEqual(engine.engineHours, 1.5);
  assert.strictEqual(engine.windowStart, "2026-08-23T06:00:00.000Z");
  assert.strictEqual(engine.windowEnd, "2026-08-23T07:30:00.000Z");
});
