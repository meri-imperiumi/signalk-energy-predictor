/**
 * Smoketests for the drag-reduction (stow_soon) opportunity gating.
 *
 * Incident (2026-09, Lille Ø, at anchor): the advisory "Stow mechanical
 * generators in Xh to reduce drag" fired while anchored with the wind
 * generator producing — but there is no drag at rest, and the towed
 * hydrogenerator was stowed anyway. The opportunity must only exist for
 * a deployable hydrogenerator that is actually down while sailing.
 *
 * @file stowage-opportunity.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PredictionEngine } = require("../plugin/prediction.js");
const { parseManufacturerCurve } = require("../plugin/schema.js");

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
    handleMessageCalls: [],
    handleMessage(source, msg) {
      this.handleMessageCalls.push({ source, msg });
    },
  };
}

const HYDRO = {
  id: "sailinggen",
  name: "SailinGen Hydrogenerator",
  type: "hydro",
  deployable: true,
  minSpeedKnots: 3,
  maxSpeedKnots: 12,
  manufacturerCurve: "4,24,5,48,6,67",
};

function makeEngine({ navState, gens = [HYDRO] } = {}) {
  const app = makeFakeApp();
  app.setSelfPath("navigation.state", navState);
  app.setSelfPath("electrical.batteries.house.capacity.stateOfCharge", 0.5);
  return new PredictionEngine({
    battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
    solarArrays: [],
    mechanicalGenerators: gens.map((g) => ({
      ...g,
      curve: parseManufacturerCurve(g.manufacturerCurve),
    })),
    getEfficiency: () => 0.7,
    getSelfPath: (path) => app.getSelfPath(path),
    app,
  });
}

// 400Ah @ 12V = 4800 Wh, SoC 0.5 → deficit 2400 Wh. Net 600 Wh/h covers
// it at hour 3 (cumulative 2400); remaining solar from hour 3 is
// 5 × 500 = 2500 Wh ≥ 80% gate (1920 Wh).
function hydroTrack(hours = 8) {
  return Array.from({ length: hours }, (_, h) => ({
    hour: h,
    time: new Date(Date.now() + h * 3600000),
    idealSolarYieldWh: 500,
    idealWindYieldWh: 100, // combined mechanical field (wind + hydro)
    idealHydroYieldWh: 100,
    idealNetWh: 600,
    idealSoC: 0.5,
  }));
}

// Same shape but the mechanical yield is wind-only (at anchor the hydro
// cannot produce: no flow).
function windOnlyTrack(hours = 8) {
  return hydroTrack(hours).map((p) => ({
    ...p,
    idealWindYieldWh: 100,
    idealHydroYieldWh: 0,
  }));
}

test("drag reduction: never fires at anchor, even with wind yield", () => {
  const engine = makeEngine({ navState: "anchored" });
  engine.lastPrediction = windOnlyTrack();
  // Wind generator producing in the ideal track + solar covers the
  // deficit — the old false positive ("no drag at anchor").
  assert.strictEqual(engine.findStowageOpportunity(), null);
});

test("drag reduction: fires when sailing with the hydro down", () => {
  const engine = makeEngine({ navState: "sailing" });
  engine.lastPrediction = hydroTrack();
  const opp = engine.findStowageOpportunity(
    new Map([["sailinggen", "deployed"]]),
  );
  assert.ok(opp, "expected a stowage opportunity");
  assert.strictEqual(opp.hour, 3);
  assert.match(opp.reason, /Deficit covered by hour 3/);
});

test("drag reduction: hydro already stowed while sailing → no opportunity", () => {
  const engine = makeEngine({ navState: "sailing" });
  engine.lastPrediction = hydroTrack();
  assert.strictEqual(
    engine.findStowageOpportunity(new Map([["sailinggen", "stowed"]])),
    null,
  );
});

test("drag reduction: unknown detected state assumes deployed (worst case)", () => {
  const engine = makeEngine({ navState: "sailing" });
  engine.lastPrediction = hydroTrack();
  assert.ok(engine.findStowageOpportunity(new Map()));
});

test("drag reduction: never fires while motoring (that is a violation, not an opportunity)", () => {
  const engine = makeEngine({ navState: "motoring" });
  engine.lastPrediction = hydroTrack();
  assert.strictEqual(
    engine.findStowageOpportunity(new Map([["sailinggen", "deployed"]])),
    null,
  );
});

test("drag reduction: fixed (non-deployable) hydro cannot be stowed", () => {
  const engine = makeEngine({
    navState: "sailing",
    gens: [{ ...HYDRO, deployable: false }],
  });
  engine.lastPrediction = hydroTrack();
  assert.strictEqual(engine.findStowageOpportunity(), null);
});

test("drag reduction: wind-only yield while sailing does not count", () => {
  const engine = makeEngine({ navState: "sailing" });
  engine.lastPrediction = windOnlyTrack();
  assert.strictEqual(engine.findStowageOpportunity(), null);
});
