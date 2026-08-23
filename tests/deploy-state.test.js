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

test("detectGeneratorState: wind stowed when 0 W with wind above startup", () => {
  const gen = {
    id: "superwind",
    type: "wind",
    deployable: true,
    startupSpeedKnots: 5,
  };
  assert.strictEqual(
    detectGeneratorState(gen, { powerW: 0, windKnots: 15, underway: false }),
    "stowed",
  );
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

test("detectGeneratorState: hydro stowed when sailing fast but no output", () => {
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
      underway: false,
    }),
    "stowed",
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
