/**
 * Tests for the shared deploy-state detection module.
 * @file deploy-state.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeDeployState,
  detectSolarArrayState,
  detectGeneratorState,
  carryForwardStates,
  sustainedStowEvidenceMs,
  deployConfirmThresholdW,
  windStowConfirmKnots,
  hydroStowConfirmKnots,
  STOW_EVIDENCE_MIN_MS,
  STOW_EVIDENCE_GAP_MS,
} = require("../plugin/deploy-state.js");

test("normalizeDeployState: maps sensor strings", () => {
  assert.strictEqual(normalizeDeployState("deployed"), "deployed");
  assert.strictEqual(normalizeDeployState("Deploy"), "deployed");
  assert.strictEqual(normalizeDeployState("stowed"), "stowed");
  assert.strictEqual(normalizeDeployState("retracted"), "stowed");
  assert.strictEqual(normalizeDeployState(null), null);
  assert.strictEqual(normalizeDeployState(undefined), null);
  assert.strictEqual(normalizeDeployState({ value: "deployed" }), "deployed");
  assert.strictEqual(normalizeDeployState("nonsense"), null);
});

test("detectSolarArrayState: deployed when producing power", () => {
  const array = { id: "flinsail", type: "deployable" };
  assert.strictEqual(
    detectSolarArrayState(array, { powerW: 50, sunUp: true, underway: false }),
    "deployed",
  );
});

test("detectSolarArrayState: stowed when 0 W in daytime", () => {
  const array = { id: "flinsail", type: "deployable" };
  assert.strictEqual(
    detectSolarArrayState(array, { powerW: 0, sunUp: true, underway: false }),
    "stowed",
  );
});

test("detectSolarArrayState: unknown at night with 0 W (could just be dark)", () => {
  const array = { id: "flinsail", type: "deployable" };
  assert.strictEqual(
    detectSolarArrayState(array, { powerW: 0, sunUp: false, underway: false }),
    null,
  );
});

test("detectSolarArrayState: 0 W at low sun (near sunset) is unknown, not stowed", () => {
  const array = { id: "flinsail", type: "deployable" };
  // `sunUp` means "sun high enough that a deployed panel would produce
  // measurable power" (above ~5°). Near sunrise/sunset a deployed panel
  // naturally reads ~0 W, so 0 W alone is not evidence of stowing — the
  // caller carries the last known state forward.
  assert.strictEqual(
    detectSolarArrayState(array, { powerW: 0, sunUp: false, underway: false }),
    null,
  );
});

test("detectSolarArrayState: deployed when producing power, even when underway", () => {
  const array = { id: "flinsail", type: "deployable" };
  // Power output is ground truth: a panel producing watts IS deployed,
  // regardless of nav state (owner may motor 150 m to a fuel dock with
  // panels up). The underway inference only applies when power is 0.
  assert.strictEqual(
    detectSolarArrayState(array, { powerW: 50, sunUp: true, underway: true }),
    "deployed",
  );
});

test("detectSolarArrayState: stowed when underway with no power", () => {
  const array = { id: "flinsail", type: "deployable" };
  assert.strictEqual(
    detectSolarArrayState(array, { powerW: 0, sunUp: true, underway: true }),
    "stowed",
  );
});

test("detectSolarArrayState: sensor wins over inference", () => {
  const array = { id: "flinsail", type: "deployable" };
  assert.strictEqual(
    detectSolarArrayState(array, {
      powerW: 50,
      sunUp: true,
      underway: false,
      deployStateRaw: "stowed",
    }),
    "stowed",
  );
});

test("detectSolarArrayState: sub-threshold power holds the previous state (overcast dead band)", () => {
  const array = { id: "flinsail", type: "deployable", capacityWp: 600 };
  // 0.4 W on a 600 Wp array is quantization noise in low irradiance
  // (overcast, rain, just after sunrise) — not evidence of deployment
  assert.strictEqual(
    detectSolarArrayState(array, {
      powerW: 0.4,
      sunUp: true,
      underway: false,
      previousState: "stowed",
    }),
    "stowed",
  );
  assert.strictEqual(
    detectSolarArrayState(array, {
      powerW: 0.4,
      sunUp: true,
      underway: false,
      previousState: "deployed",
    }),
    "deployed",
  );
  // No previous state: ambiguous evidence stays unknown (carry-forward)
  assert.strictEqual(
    detectSolarArrayState(array, { powerW: 0.4, sunUp: true, underway: false }),
    null,
  );
});

test("detectSolarArrayState: deploy confirm threshold scales with capacityWp", () => {
  // 600 Wp * 0.5% = 3 W: 2 W is noise, 4 W confirms deployment
  const array = { id: "flinsail", type: "deployable", capacityWp: 600 };
  assert.strictEqual(
    detectSolarArrayState(array, {
      powerW: 2,
      sunUp: true,
      underway: false,
      previousState: "stowed",
    }),
    "stowed",
  );
  assert.strictEqual(
    detectSolarArrayState(array, { powerW: 4, sunUp: true, underway: false }),
    "deployed",
  );
});

test("detectSolarArrayState: threshold clamps to 1-5 W without extreme capacities", () => {
  const tiny = { id: "tilt", type: "deployable", capacityWp: 50 };
  // 50 Wp * 0.5% = 0.25 W → clamped up to 1 W: 0.9 W holds, 1.1 W deploys
  assert.strictEqual(
    detectSolarArrayState(tiny, {
      powerW: 0.9,
      sunUp: true,
      underway: false,
      previousState: "stowed",
    }),
    "stowed",
  );
  assert.strictEqual(
    detectSolarArrayState(tiny, { powerW: 1.1, sunUp: true, underway: false }),
    "deployed",
  );
  const huge = { id: "sail", type: "deployable", capacityWp: 4000 };
  // 4000 Wp * 0.5% = 20 W → clamped down to 5 W: 4 W holds, 6 W deploys
  assert.strictEqual(
    detectSolarArrayState(huge, {
      powerW: 4,
      sunUp: true,
      underway: false,
      previousState: "stowed",
    }),
    "stowed",
  );
  assert.strictEqual(
    detectSolarArrayState(huge, { powerW: 6, sunUp: true, underway: false }),
    "deployed",
  );
  // Missing capacityWp: defaults to the 1 W floor
  const bare = { id: "bare", type: "deployable" };
  assert.strictEqual(
    detectSolarArrayState(bare, {
      powerW: 0.9,
      sunUp: true,
      underway: false,
      previousState: "stowed",
    }),
    "stowed",
  );
});

test("detectSolarArrayState: 0↔0.4 W overcast flicker does not flap the state", () => {
  const array = { id: "flinsail", type: "deployable", capacityWp: 600 };
  // Rainy overcast morning just after sunrise: the sail is deployed but
  // its output flickers around zero. Pre-hysteresis this produced multiple
  // deploy/stow detections; now the readings settle after at most one
  // transition (0 W with the sun up still confirms stowed).
  let state = "deployed";
  const flips = [];
  for (const powerW of [0.4, 0, 0.4, 0, 0, 0.3, 0.4, 0]) {
    const next = detectSolarArrayState(array, {
      powerW,
      sunUp: true,
      underway: false,
      previousState: state,
    });
    if (next !== state) flips.push(next);
    state = next;
  }
  assert.deepStrictEqual(flips, ["stowed"]);
  assert.strictEqual(state, "stowed");
});

test("detectSolarArrayState: strict 0 W with sun up still confirms stowed", () => {
  const array = { id: "flinsail", type: "deployable", capacityWp: 600 };
  // The dead band only mutes positive noise: a solid 0 W reading with the
  // sun high enough for measurable output remains definite stow evidence
  assert.strictEqual(
    detectSolarArrayState(array, {
      powerW: 0,
      sunUp: true,
      underway: false,
      previousState: "deployed",
    }),
    "stowed",
  );
});

test("detectGeneratorState: wind deployed when producing power", () => {
  const gen = {
    id: "superwind",
    type: "wind",
    deployable: true,
    startupSpeedKnots: 5,
  };
  assert.strictEqual(
    detectGeneratorState(gen, { powerW: 40, windKnots: 15, underway: false }),
    "deployed",
  );
});

test("detectGeneratorState: wind stowed when 0 W with wind above startup and sustained evidence", () => {
  const gen = {
    id: "superwind",
    type: "wind",
    deployable: true,
    startupSpeedKnots: 5,
  };
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      windKnots: 15,
      underway: false,
      stowEvidenceMs: STOW_EVIDENCE_MIN_MS,
      previousState: "deployed",
    }),
    "stowed",
  );
  // Same conditions, but the zero has not persisted yet: a single quiet
  // window is not proof — a deployed unit's regulator can throttle it on
  // a full battery and it sits still through lulls around cut-in.
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      windKnots: 15,
      underway: false,
      previousState: "deployed",
    }),
    "deployed",
  );
});

test("detectGeneratorState: wind 0 W in marginal gusty wind holds the previous state", () => {
  const gen = {
    id: "superwind",
    type: "wind",
    deployable: true,
    startupSpeedKnots: 5,
  };
  // Confirm threshold is 5 kn * 1.5 = 7.5 kn; 6 kn is marginal. A
  // deployed wind generator's high starting reluctance keeps it still
  // through lulls in gusty conditions — 0 W there is not stow evidence.
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      windKnots: 6,
      underway: false,
      previousState: "deployed",
    }),
    "deployed",
  );
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      windKnots: 6,
      underway: false,
      previousState: "stowed",
    }),
    "stowed",
  );
  // No previous state: marginal evidence stays unknown (carry-forward)
  assert.strictEqual(
    detectGeneratorState(gen, { powerW: 0, windKnots: 6, underway: false }),
    null,
  );
});

test("detectGeneratorState: wind 0 W confirms stowed clearly above startup once sustained", () => {
  const gen = {
    id: "superwind",
    type: "wind",
    deployable: true,
    startupSpeedKnots: 5,
  };
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      windKnots: 8,
      underway: false,
      stowEvidenceMs: STOW_EVIDENCE_MIN_MS,
      previousState: "deployed",
    }),
    "stowed",
  );
  // Barely above the confirm threshold: without the sustained evidence
  // the deployed state is held.
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      windKnots: 8,
      underway: false,
      previousState: "deployed",
    }),
    "deployed",
  );
});

test("detectGeneratorState: gusty lull sequence does not flap the wind state", () => {
  const gen = {
    id: "superwind",
    type: "wind",
    deployable: true,
    startupSpeedKnots: 5,
  };
  // The observed wild case: gusts spin the unit up (positive samples →
  // "deployed"), lulls read 0 W with the average wind still at/above
  // startup → pre-hysteresis "stowed" five minutes later. Now the
  // marginal lulls hold the state.
  let state = null;
  const flips = [];
  const sequence = [
    [0, 6],
    [20, 7],
    [0, 6],
    [0, 6.5],
    [15, 7],
    [0, 6],
    [0, 5.5],
  ];
  for (const [powerW, windKnots] of sequence) {
    const next = detectGeneratorState(gen, {
      powerW,
      windKnots,
      underway: false,
      previousState: state,
    });
    if (next != null && next !== state) flips.push(next);
    if (next != null) state = next;
  }
  assert.deepStrictEqual(flips, ["deployed"]);
  assert.strictEqual(state, "deployed");
});

test("detectGeneratorState: hydro marginal speed holds previous; clear speed stows", () => {
  const gen = {
    id: "hydrogen",
    type: "hydro",
    deployable: true,
    minSpeedKnots: 3,
  };
  // Confirm threshold is 3 kn * 1.25 = 3.75 kn
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      stwKnots: 3.4,
      navState: "sailing",
      previousState: "deployed",
    }),
    "deployed",
  );
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      stwKnots: 4,
      navState: "sailing",
      stowEvidenceMs: STOW_EVIDENCE_MIN_MS,
      previousState: "deployed",
    }),
    "stowed",
  );
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      stwKnots: 4,
      navState: "sailing",
      previousState: "deployed",
    }),
    "deployed",
  );
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      stwKnots: 3.4,
      navState: "sailing",
    }),
    null,
  );
});

test("windStowConfirmKnots / hydroStowConfirmKnots: scale with configured speeds", () => {
  assert.strictEqual(
    windStowConfirmKnots({ type: "wind", startupSpeedKnots: 5 }),
    7.5,
  );
  assert.strictEqual(windStowConfirmKnots({ type: "wind" }), 7.5); // default 5 kn
  assert.strictEqual(
    hydroStowConfirmKnots({ type: "hydro", minSpeedKnots: 4 }),
    5,
  );
  assert.strictEqual(hydroStowConfirmKnots({ type: "hydro" }), 3.75); // default 3 kn
});

test("detectGeneratorState: wind unknown when 0 W but calm (no evidence)", () => {
  const gen = {
    id: "superwind",
    type: "wind",
    deployable: true,
    startupSpeedKnots: 5,
  };
  assert.strictEqual(
    detectGeneratorState(gen, { powerW: 0, windKnots: 2, underway: false }),
    null,
  );
});

test("detectGeneratorState: wind stowed when underway", () => {
  const gen = {
    id: "superwind",
    type: "wind",
    deployable: true,
    startupSpeedKnots: 5,
  };
  assert.strictEqual(
    detectGeneratorState(gen, { powerW: 0, windKnots: 15, underway: true }),
    "stowed",
  );
});

test("detectGeneratorState: hydro stowed when not sailing", () => {
  const gen = {
    id: "hydrogen",
    type: "hydro",
    deployable: true,
    minSpeedKnots: 3,
  };
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      stwKnots: 0,
      navState: "anchored",
      underway: false,
    }),
    "stowed",
  );
});

test("detectGeneratorState: hydro stowed when sailing fast but no output, evidence sustained", () => {
  const gen = {
    id: "hydrogen",
    type: "hydro",
    deployable: true,
    minSpeedKnots: 3,
  };
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      stwKnots: 5,
      navState: "sailing",
      stowEvidenceMs: STOW_EVIDENCE_MIN_MS,
      underway: false,
    }),
    "stowed",
  );
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 0,
      stwKnots: 5,
      navState: "sailing",
      underway: false,
    }),
    null,
  );
});

test("detectGeneratorState: hydro deployed when producing power", () => {
  const gen = {
    id: "hydrogen",
    type: "hydro",
    deployable: true,
    minSpeedKnots: 3,
  };
  assert.strictEqual(
    detectGeneratorState(gen, {
      powerW: 30,
      stwKnots: 5,
      navState: "sailing",
      underway: false,
    }),
    "deployed",
  );
});

test("carryForwardStates: fills nulls from last known", () => {
  const samples = [
    { states: new Map([["flinsail", "deployed"]]) },
    { states: new Map([["flinsail", null]]) },
    { states: new Map([["flinsail", "stowed"]]) },
    { states: new Map([["flinsail", null]]) },
  ];
  const out = carryForwardStates(samples);
  assert.strictEqual(out[0].get("flinsail"), "deployed");
  assert.strictEqual(out[1].get("flinsail"), "deployed"); // carried forward
  assert.strictEqual(out[2].get("flinsail"), "stowed");
  assert.strictEqual(out[3].get("flinsail"), "stowed"); // carried forward
});

test("sustainedStowEvidenceMs: builds across consecutive zero-wind-above-threshold samples", () => {
  const gen = { type: "wind", startupSpeedKnots: 10, regulationSoC: null };
  const base = Date.UTC(2026, 9, 17, 23, 0, 0);
  const step = (k) => 5 * 60 * 1000 * k;
  const trail = [];
  for (let k = 0; k < 7; k++) {
    trail.push({ timeMs: base + step(k), powerW: 0, windKnots: 16 });
    const ms = sustainedStowEvidenceMs(gen, trail, null);
    if (k < 6) {
      // 5 samples span 20 min, 6 span 25 min — below the 30-min minimum
      assert.ok(ms !== null && ms < STOW_EVIDENCE_MIN_MS, `k=${k} ms=${ms}`);
    } else {
      // 7 samples 5 min apart span 30 min — sustained
      assert.strictEqual(ms, 30 * 60 * 1000);
    }
  }
});

test("sustainedStowEvidenceMs: positive power resets the streak", () => {
  const gen = { type: "wind", startupSpeedKnots: 10 };
  const base = Date.UTC(2026, 9, 17, 23, 0, 0);
  const step = 5 * 60 * 1000;
  const trail = [];
  for (let k = 0; k < 6; k++) {
    trail.push({ timeMs: base + k * step, powerW: 0, windKnots: 16 });
  }
  // Production in the middle: the streak restarts after it
  trail[2] = { timeMs: base + 2 * step, powerW: 12.5, windKnots: 16 };
  const ms = sustainedStowEvidenceMs(gen, trail, null);
  // Evidence from the 4th sample to the 6th: 2 gaps = 10 min
  assert.strictEqual(ms, 10 * 60 * 1000);
});

test("sustainedStowEvidenceMs: wind below the confirm threshold resets", () => {
  const gen = { type: "wind", startupSpeedKnots: 10 };
  const base = Date.UTC(2026, 9, 17, 23, 0, 0);
  const step = 5 * 60 * 1000;
  const trail = [];
  for (let k = 0; k < 8; k++) {
    trail.push({
      timeMs: base + k * step,
      powerW: 0,
      windKnots: k === 3 ? 9 : 16, // lull below the 15 kn confirm
    });
  }
  // Evidence from the 5th sample onward only: 3 gaps = 15 min
  assert.strictEqual(sustainedStowEvidenceMs(gen, trail, null), 15 * 60 * 1000);
});

test("sustainedStowEvidenceMs: recording gap longer than the tolerance restarts", () => {
  const gen = { type: "wind", startupSpeedKnots: 10 };
  const base = Date.UTC(2026, 9, 17, 23, 0, 0);
  const step = 5 * 60 * 1000;
  const trail = [];
  for (let k = 0; k < 4; k++) {
    trail.push({ timeMs: base + k * step, powerW: 0, windKnots: 16 });
  }
  // Recorder down for 20 min (> STOW_EVIDENCE_GAP_MS), then resumes
  trail.push({
    timeMs: base + 3 * step + 20 * 60 * 1000,
    powerW: 0,
    windKnots: 16,
  });
  const ms = sustainedStowEvidenceMs(gen, trail, null);
  assert.strictEqual(ms, 0); // streak restarted at the resumed sample
});

test("sustainedStowEvidenceMs: regulation SoC blocks evidence", () => {
  const gen = { type: "wind", startupSpeedKnots: 10, regulationSoC: 0.95 };
  const base = Date.UTC(2026, 9, 17, 23, 0, 0);
  const step = 5 * 60 * 1000;
  const trail = [];
  for (let k = 0; k < 10; k++) {
    trail.push({ timeMs: base + k * step, powerW: 0, windKnots: 16 });
  }
  // Battery full: a regulator may be throttling a deployed unit — no
  // evidence, however long the zero has persisted.
  assert.strictEqual(sustainedStowEvidenceMs(gen, trail, 0.981), null);
  // Below the threshold the same trail is fully sustained evidence.
  assert.strictEqual(sustainedStowEvidenceMs(gen, trail, 0.9), 45 * 60 * 1000);
  // Unknown SoC does not block the evidence.
  assert.strictEqual(sustainedStowEvidenceMs(gen, trail, null), 45 * 60 * 1000);
});

test("sustainedStowEvidenceMs: missing power reading is not evidence", () => {
  const gen = { type: "wind", startupSpeedKnots: 10 };
  const base = Date.UTC(2026, 9, 17, 23, 0, 0);
  const step = 5 * 60 * 1000;
  const trail = [];
  for (let k = 0; k < 4; k++) {
    trail.push({ timeMs: base + k * step, powerW: 0, windKnots: 16 });
  }
  // Power sensor went silent: no zero reading, streak breaks
  trail.push({ timeMs: base + 4 * step, powerW: null, windKnots: 16 });
  assert.strictEqual(sustainedStowEvidenceMs(gen, trail, null), null);
});

test("sustainedStowEvidenceMs: hydro uses speed through water", () => {
  const gen = { type: "hydro", minSpeedKnots: 3 };
  const base = Date.UTC(2026, 9, 17, 23, 0, 0);
  const step = 5 * 60 * 1000;
  const trail = [];
  for (let k = 0; k < 8; k++) {
    trail.push({
      timeMs: base + k * step,
      powerW: 0,
      windKnots: 20,
      stwKnots: 4.5,
    });
  }
  assert.strictEqual(sustainedStowEvidenceMs(gen, trail, null), 35 * 60 * 1000);
  // Drop below the 3.75 kn confirm at the last step: no current evidence
  // at all (the streak would restart once the speed recovers).
  const last = trail[trail.length - 1];
  last.stwKnots = 3.5;
  assert.strictEqual(sustainedStowEvidenceMs(gen, trail, null), null);
});
