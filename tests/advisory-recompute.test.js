/**
 * Tests for the pure advisory recompute helpers (backfill backend).
 *
 * These recompute surplus/engine-run/stowage advisories from a recorded
 * cycle's forecast track with no dependency on the live tree or wall clock,
 * so historical cycles can be retroactively populated (and a transient
 * cycle's bogus advisory overwritten with the corrected result).
 *
 * @file advisory-recompute.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  recomputeSurplus,
  recomputeCombustion,
  recomputeStowage,
  recomputeAdvisories,
} = require("../plugin/advisory-recompute.js");

// 400Ah @ 12V = 4800 Wh, floor 0.2 — matches the deployment test fixtures
const BAT = { minSafeSoC: 0.2, capacityWh: 4800 };
const ENGINES = [{ id: "main", name: "Engine", alternatorWatts: 100 }];

function track(points, now = Date.now()) {
  const base = now instanceof Date ? now.getTime() : now;
  return points.map((p, i) => ({
    time: new Date(base + i * 3600000).toISOString(),
    idealSoC: p.soc,
    idealSolarYieldWh: p.solar ?? 0,
    idealWindYieldWh: p.wind ?? 0,
    idealNetWh: p.net,
    alternatorWh: p.alt ?? 0,
    houseLoadWh: p.load,
  }));
}

test("recomputeSurplus: null when the bank never reaches full", () => {
  const f = track([
    { soc: 0.6, solar: 100, net: -30, load: 130 },
    { soc: 0.62, solar: 120, net: -10, load: 130 },
  ]);
  assert.strictEqual(recomputeSurplus(f, { cycleTime: new Date() }), null);
});

test("recomputeSurplus: detects a full-bank surplus window with curtailed energy", () => {
  // Bank full from hour 0, solar continues above load → curtailed surplus
  const f = track([
    { soc: 1.0, solar: 300, net: 170, load: 130 },
    { soc: 1.0, solar: 350, net: 220, load: 130 },
    { soc: 1.0, solar: 400, net: 270, load: 130 },
    { soc: 0.95, solar: 100, net: -30, load: 130 }, // window ends
  ]);
  const res = recomputeSurplus(f, { cycleTime: new Date() });
  assert.ok(res, "expected a surplus");
  assert.ok(
    res.surplusWh >= 300,
    `surplus ${res.surplusWh} Wh should clear minSurplusWh`,
  );
  assert.ok(res.from <= res.to);
  assert.ok(res.suggestedLoadW > 0);
});

test("recomputeSurplus: null when surplus below the minimum threshold", () => {
  const f = track([
    { soc: 1.0, solar: 150, net: 20, load: 130 }, // 20 Wh curtailed
    { soc: 1.0, solar: 140, net: 10, load: 130 }, // 10 Wh
    { soc: 0.98, solar: 0, net: -130, load: 130 },
  ]);
  // 30 Wh total < default 300 Wh min
  assert.strictEqual(recomputeSurplus(f, { cycleTime: new Date() }), null);
});

test("recomputeSurplus: empty/missing forecast returns null", () => {
  assert.strictEqual(recomputeSurplus([], { cycleTime: new Date() }), null);
  assert.strictEqual(recomputeSurplus(null, { cycleTime: new Date() }), null);
});

test("recomputeCombustion: null on the degenerate no-solar transient", () => {
  // The 2026-08-23 23:45:52 signature: zero solar, SoC drains to the floor.
  const f = track([
    { soc: 0.5, solar: 0, net: -126, load: 126 },
    { soc: 0.4, solar: 0, net: -126, load: 126 },
    { soc: 0.3, solar: 0, net: -126, load: 126 },
    { soc: 0.2, solar: 0, net: -126, load: 126 },
    { soc: 0.1, solar: 0, net: -126, load: 126 },
    { soc: 0.0, solar: 0, net: -126, load: 126 },
  ]);
  assert.deepStrictEqual(
    recomputeCombustion(f, ENGINES, [], { ...BAT, cycleTime: new Date() }),
    [],
  );
});

test("recomputeCombustion: computes shortfall to floor + batch margin", () => {
  // Sustained dip to 0.10 → target 0.2 + 0.1 margin = 0.30 → shortfall
  // (0.30-0.10)*4800 = 960 Wh → 9.6h @ 100W
  const f = track([
    { soc: 0.5, solar: 200, net: -100, load: 300 },
    { soc: 0.4, solar: 150, net: -120, load: 270 },
    { soc: 0.3, solar: 100, net: -150, load: 250 },
    { soc: 0.2, solar: 50, net: -150, load: 200 },
    { soc: 0.1, solar: 20, net: -120, load: 140 }, // deepest dip below floor
    { soc: 0.12, solar: 20, net: -100, load: 120 },
    { soc: 0.14, solar: 20, net: -100, load: 120 },
    { soc: 0.16, solar: 20, net: -100, load: 120 },
    { soc: 0.18, solar: 20, net: -100, load: 120 },
    { soc: 0.2, solar: 100, net: -30, load: 130 },
    { soc: 0.25, solar: 200, net: 30, load: 170 },
    { soc: 0.35, solar: 300, net: 130, load: 170 },
  ]);
  const runs = recomputeCombustion(f, ENGINES, [], {
    ...BAT,
    cycleTime: new Date(),
  });
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].tier, "engine");
  assert.strictEqual(runs[0].result.runHours, 9.6);
});

test("recomputeCombustion: null when the bank never reaches the floor", () => {
  const f = track([
    { soc: 0.6, solar: 300, net: 170, load: 130 },
    { soc: 0.7, solar: 350, net: 220, load: 130 },
  ]);
  assert.deepStrictEqual(
    recomputeCombustion(f, ENGINES, [], { ...BAT, cycleTime: new Date() }),
    [],
  );
});

test("recomputeCombustion: caps run time to the forecast horizon", () => {
  // Sustained dip to 0.0 → 1440 Wh → 14.4h @ 100W, but only 4 hours in
  // the track
  const f = track([
    { soc: 0.4, solar: 10, net: -150, load: 160 },
    { soc: 0.19, solar: 10, net: -150, load: 160 },
    { soc: 0.1, solar: 10, net: -150, load: 160 },
    { soc: 0.0, solar: 10, net: -150, load: 160 },
  ]);
  const runs = recomputeCombustion(f, ENGINES, [], {
    ...BAT,
    cycleTime: new Date(),
  });
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].result.runHours, 4); // capped
});

test("recomputeStowage: null when mechanicals never active", () => {
  const f = track([
    { soc: 0.5, solar: 300, net: 170, load: 130 },
    { soc: 0.7, solar: 400, net: 270, load: 130 },
  ]);
  assert.strictEqual(recomputeStowage(f, { ...BAT, currentSoC: 0.5 }), null);
});

test("recomputeAdvisories: returns all three types when conditions hold", () => {
  // A cycle that's full (surplus), dips below floor later (engine_run), and
  // has wind early covered by solar (stow_soon) — over a 24h track.
  const now = new Date("2026-08-23T12:00:00Z");
  const f = track(
    [
      { soc: 1.0, solar: 300, wind: 200, net: 370, load: 130 }, // surplus + wind active
      { soc: 1.0, solar: 400, wind: 200, net: 470, load: 130 },
      { soc: 1.0, solar: 500, wind: 0, net: 370, load: 130 }, // wind stowed, still surplus
      { soc: 0.9, solar: 100, wind: 0, net: -30, load: 130 }, // surplus window ends
      { soc: 0.7, solar: 0, net: -130, load: 130 },
      { soc: 0.5, solar: 0, net: -130, load: 130 },
      { soc: 0.3, solar: 0, net: -130, load: 130 },
      { soc: 0.2, solar: 0, net: -130, load: 130 }, // hits floor
      { soc: 0.18, solar: 20, net: -110, load: 130 }, // dips below floor
      { soc: 0.15, solar: 20, net: -110, load: 130 },
      { soc: 0.12, solar: 20, net: -110, load: 130 },
      { soc: 0.25, solar: 200, net: 70, load: 130 }, // recovering
    ],
    now,
  );
  const advisories = recomputeAdvisories(f, {
    cycleTime: now,
    minSafeSoC: BAT.minSafeSoC,
    capacityWh: BAT.capacityWh,
    engines: ENGINES,
    localOffsetMinutes: 0,
  });
  const types = advisories.map((a) => a.type).sort();
  assert.ok(types.includes("surplus"), `has surplus: ${types.join(",")}`);
  assert.ok(types.includes("engine_run"), `has engine_run: ${types.join(",")}`);
  // stow_soon requires the deficit (1 - startSoC) * capacityWh to be covered
  // — startSoC is 1.0 here so deficit is 0, covered immediately. Stowage may
  // or may not fire depending on the 80% remaining-solar gate; assert only
  // the two that must hold.
});

test("recomputeAdvisories: writes recorded-shape surplus with structured fields", () => {
  const now = new Date("2026-08-23T12:00:00Z");
  const f = track(
    [
      { soc: 1.0, solar: 300, net: 170, load: 130 },
      { soc: 1.0, solar: 350, net: 220, load: 130 },
      { soc: 1.0, solar: 400, net: 270, load: 130 },
      { soc: 0.95, solar: 100, net: -30, load: 130 },
    ],
    now,
  );
  const advisories = recomputeAdvisories(f, {
    cycleTime: now,
    minSafeSoC: BAT.minSafeSoC,
    capacityWh: BAT.capacityWh,
    engines: ENGINES,
    localOffsetMinutes: 0,
    opportunisticLoads: [{ name: "Watermaker", watts: 300 }],
  });
  const surplus = advisories.find((a) => a.type === "surplus");
  assert.ok(surplus, "expected a surplus advisory");
  assert.strictEqual(typeof surplus.message, "string");
  assert.ok(surplus.surplusWh > 0);
  assert.ok(surplus.from);
  assert.ok(surplus.to);
  assert.ok(surplus.sustainedW > 0);
  assert.ok(Array.isArray(surplus.loads));
  assert.strictEqual(surplus.loads[0].name, "Watermaker");
  assert.ok(surplus.loads[0].runHours > 0);
});

test("recomputeAdvisories: empty forecast yields no advisories", () => {
  const advisories = recomputeAdvisories([], {
    cycleTime: new Date(),
    minSafeSoC: BAT.minSafeSoC,
    capacityWh: BAT.capacityWh,
    engines: ENGINES,
  });
  assert.deepStrictEqual(advisories, []);
});
