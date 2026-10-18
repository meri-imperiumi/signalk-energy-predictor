/**
 * Deploy/stow state detection for deployable solar arrays and mechanical
 * generators.
 *
 * The state is inferred from power output and ambient conditions (wind,
 * sun, boat speed, nav state), with hysteresis on the power evidence:
 *  - Deployable solar: power above a capacity-scaled confirm threshold →
 *    deployed; sub-threshold positive power → hold the previous state
 *    (quantization noise in low irradiance must not flap the state);
 *    0 W in daytime → stowed; underway → stowed.
 *  - Wind generator: power > 0 → deployed (immediate); 0 W with wind
 *    clearly above startup (≥ 1.5×) confirms stowed only once the
 *    evidence has persisted (STOW_EVIDENCE_MIN_MS of consecutive zero
 *    samples — the recorded 5-minute granularity — and not while the
 *    battery is at the generator's regulation SoC, where a regulator may
 *    throttle a deployed unit to zero); 0 W in the marginal band
 *    around startup → hold the previous state (a deployed unit's high
 *    starting reluctance keeps it still through lulls in gusty
 *    conditions); underway → stowed.
 *  - Hydro generator: not sailing → stowed; power > 0 → deployed;
 *    0 W sailing clearly above min speed (≥ 1.25×) → stowed once the
 *    evidence has persisted; marginal speed → hold the previous state.
 *
 * The state detection is deliberately asymmetric: deployment is confirmed
 * immediately by any positive power, while stowage needs conditions that
 * leave no doubt a deployed generator would be producing.
 *
 * A sensor-provided deployStatePath, when present, always wins over the
 * inference.
 *
 * Unknown (null) results do NOT overwrite a previous known state — callers
 * apply carry-forward so a device that produced no power and had no wind
 * evidence keeps its last known state (e.g. a wind generator stowed for
 * repair reads 0 W in calm conditions, staying "stowed" rather than
 * dropping to "unknown").
 */

/**
 * Minimum sun elevation (radians) for the 0 W → stowed inference. Below
 * this angle a deployed panel naturally produces ~0 W (near sunrise/sunset),
 * so 0 W alone is not evidence of stowing. ~5°.
 */
const STOW_INFERENCE_MIN_SUN_ALT_RAD = (5 * Math.PI) / 180;

/**
 * Fraction of an array's nameplate capacity that confirms deployment.
 * See `deployConfirmThresholdW`.
 */
const DEPLOY_CONFIRM_FRACTION = 0.005;

/** Lower/upper clamp (W) for the deploy-confirm threshold. */
const DEPLOY_CONFIRM_MIN_W = 1;
const DEPLOY_CONFIRM_MAX_W = 5;

/**
 * Multiplier on a wind generator's startup speed for the 0 W → stowed
 * inference. Wind generators have high starting reluctance (cogging
 * torque): in gusty winds around cut-in a deployed unit only spins up in
 * the gusts and sits still through the lulls, so 0 W at barely-startup
 * wind is not stow evidence. See `windStowConfirmKnots`.
 */
const WIND_STOW_CONFIRM_FACTOR = 1.5;

/**
 * Multiplier on a hydro generator's minimum speed for the 0 W → stowed
 * inference. Water is ~800× denser than air, so a towed generator is far
 * more deterministic at its cut-in than a wind one; the margin is smaller
 * but the same lull protection applies while speed hovers around minimum.
 * See `hydroStowConfirmKnots`.
 */
const HYDRO_STOW_CONFIRM_FACTOR = 1.25;

/**
 * Minimum duration (ms) the stow evidence — zero output with the wind
 * (or boat speed) clearly above the generator's cut-in — must persist
 * before it confirms stowage. A single quiet window is not proof: a
 * deployed wind generator's regulator can throttle it to 0 W for a while
 * (battery nearly full), and around cut-in it sits still through lulls
 * between gusts. Thirty minutes of continuous zero with conditions well
 * above cut-in leaves no doubt the turbine is not turning.
 */
const STOW_EVIDENCE_MIN_MS = 30 * 60 * 1000;

/**
 * Maximum gap (ms) between consecutive stow-evidence samples before the
 * streak is considered broken. At the 5-minute recording cadence this
 * tolerates two missed samples; a longer recording gap (plugin down,
 * recorder paused) restarts the evidence count instead of pretending the
 * zero persisted through it.
 */
const STOW_EVIDENCE_GAP_MS = 15 * 60 * 1000;

/**
 * Power (W) that a deployable array must produce before a stowed→deployed
 * transition is confirmed. Positive output below this threshold is treated
 * as ambiguous (the dead band of the hysteresis): in low-irradiance
 * conditions — overcast, rain, just after sunrise — a deployed panel's
 * output hovers around zero, flickering between 0 W and fractions of a
 * watt that differ only by quantization noise. Reading such flicker as
 * "deployed" on every positive sample flaps the detected state (multiple
 * deploy/stow detections over one rainy morning in the wild). The dead
 * band holds the previous state instead; 0 W with the sun up still
 * confirms stowed, and only real output above the threshold confirms
 * deployed.
 *
 * The threshold scales with the array's nameplate capacity (0.5%, clamped
 * to 1–5 W) so it stays noise-level for a small tilting panel and remains
 * well under genuine dawn output for a large sail.
 *
 * @param {object} array - Solar array config (capacityWp optional)
 * @returns {number} Confirm threshold in watts
 */
function deployConfirmThresholdW(array) {
  const cap =
    typeof array?.capacityWp === "number" && array.capacityWp > 0
      ? array.capacityWp
      : null;
  if (cap == null) return DEPLOY_CONFIRM_MIN_W;
  return Math.min(
    DEPLOY_CONFIRM_MAX_W,
    Math.max(DEPLOY_CONFIRM_MIN_W, cap * DEPLOY_CONFIRM_FRACTION),
  );
}

/**
 * Sustained wind speed (knots) above which 0 W confirms a wind generator
 * is stowed. At or above this a deployed unit produces — its high
 * starting reluctance only matters around cut-in. Between the startup
 * speed and this threshold conditions are marginal: 0 W is ambiguous and
 * the previous state is held (assume still deployed).
 *
 * @param {object} gen - Wind generator config (startupSpeedKnots optional)
 * @returns {number} Stow-confirm wind speed in knots
 */
function windStowConfirmKnots(gen) {
  return (gen.startupSpeedKnots ?? 5) * WIND_STOW_CONFIRM_FACTOR;
}

/**
 * Sustained speed through water (knots) above which 0 W confirms a hydro
 * generator is stowed. Between the minimum speed and this threshold
 * conditions are marginal: 0 W holds the previous state.
 *
 * @param {object} gen - Hydro generator config (minSpeedKnots optional)
 * @returns {number} Stow-confirm speed in knots
 */
function hydroStowConfirmKnots(gen) {
  return (gen.minSpeedKnots ?? 3) * HYDRO_STOW_CONFIRM_FACTOR;
}

/**
 * Sustained stow-evidence duration (ms) at the end of a time-ordered trail
 * of generator readings. Evidence at a step means the generator read
 * exactly 0 W while its condition input (sustained wind for a wind
 * generator, sustained speed through water for a hydro) was at or above
 * the stow-confirm threshold — i.e. conditions that would spin a deployed
 * unit, and no output. The trail is the 5-minute-granularity sample record
 * the rest of the detection uses, so "sustained" means consecutive
 * recorded samples agreeing, not one lucky window.
 *
 * A positive reading (any production), a missing reading, or a condition
 * below the confirm threshold breaks the streak; so does a gap between
 * consecutive evidence samples larger than `STOW_EVIDENCE_GAP_MS` (a
 * recording outage must not pretend the zero persisted through it).
 *
 * @param {object} gen - Generator config (type, startupSpeedKnots,
 *        minSpeedKnots, regulationSoC)
 * @param {Array<{timeMs: number, powerW: number|null, windKnots: number|null, stwKnots: number|null}>} trail
 *        Time-ordered sample steps, oldest first; the last entry is the
 *        instant being evaluated
 * @param {number|null} socNow - Battery state of charge (0–1) at the
 *        evaluation instant. When the generator declares a regulation SoC
 *        (its regulator throttles output to zero on a full battery) and
 *        the battery is at or above it, zero output is uninformative and
 *        no evidence accrues — a deployed, throttled turbine must not read
 *        as stowed. Unknown SoC does not block evidence.
 * @returns {number|null} Milliseconds the current evidence streak has
 *          persisted (0 when it just started), or null when there is no
 *          evidence at the trail's end
 */
function sustainedStowEvidenceMs(gen, trail, socNow) {
  if (gen.type !== "wind" && gen.type !== "hydro") return null;
  if (
    gen.regulationSoC != null &&
    socNow != null &&
    socNow >= gen.regulationSoC
  ) {
    return null;
  }
  const conditionKey = gen.type === "wind" ? "windKnots" : "stwKnots";
  const confirmKnots =
    gen.type === "wind"
      ? windStowConfirmKnots(gen)
      : hydroStowConfirmKnots(gen);
  const isEvidence = (step) =>
    step.powerW === 0 &&
    step[conditionKey] != null &&
    step[conditionKey] >= confirmKnots;
  const last = trail.length - 1;
  if (last < 0 || !isEvidence(trail[last])) return null;
  let start = last;
  while (
    start > 0 &&
    isEvidence(trail[start - 1]) &&
    trail[start].timeMs - trail[start - 1].timeMs <= STOW_EVIDENCE_GAP_MS
  ) {
    start--;
  }
  return trail[last].timeMs - trail[start].timeMs;
}

/**
 * Normalises a raw deploy-state sensor value to "deployed"/"stowed"/null.
 * @param {string|object|null|undefined} val
 * @returns {"deployed"|"stowed"|null}
 */
function normalizeDeployState(val) {
  if (val == null) return null;
  if (typeof val === "object" && typeof val.value === "string") val = val.value;
  if (typeof val === "string") {
    const lower = val.toLowerCase();
    if (lower === "deployed" || lower === "deploy") return "deployed";
    if (lower === "stowed" || lower === "stow" || lower === "retracted")
      return "stowed";
  }
  return null;
}

/**
 * Infers the deploy state for a single deployable solar array from one
 * sample's readings.
 *
 * @param {object} array - Solar array config (id, type, powerPath,
 *        deployStatePath)
 * @param {object} ctx - Sample context
 * @param {number|null} [ctx.powerW] - Array power output (W)
 * @param {string|null} [ctx.deployStateRaw] - Raw sensor value at
 *        array.deployStatePath (wins over inference)
 * @param {boolean} [ctx.sunUp] - Whether the sun is high enough that a
 *        deployed panel would produce measurable power (above ~5°). At
 *        low sun angles a deployed panel naturally produces ~0 W, so 0 W
 *        alone is not evidence of stowing.
 * @param {boolean} [ctx.underway] - Whether the vessel is under way
 * @param {string|null} [ctx.previousState] - Last known state for this
 *        array ("deployed"/"stowed"); sub-threshold positive power holds
 *        it instead of flipping the state (hysteresis dead band)
 * @returns {"deployed"|"stowed"|null} Inferred state, or null if unknown
 */
function detectSolarArrayState(array, ctx) {
  if (array.type !== "deployable") return null;
  const sensor = normalizeDeployState(ctx.deployStateRaw);
  if (sensor != null) return sensor;
  const { powerW, sunUp, underway } = ctx;
  const previousState =
    ctx.previousState === "deployed" || ctx.previousState === "stowed"
      ? ctx.previousState
      : null;
  // Power output is ground truth: a panel producing real watts IS
  // deployed, regardless of nav state. The underway inference only applies
  // when there is no power evidence (0 W) — then we assume the panel was
  // stowed because the boat was moving and the owner would have stowed
  // it for the passage.
  if (powerW != null && powerW > deployConfirmThresholdW(array)) {
    return "deployed";
  }
  // Hysteresis dead band: positive but sub-threshold output is ambiguous
  // in low irradiance (overcast dawn flicker around 0 W). Hold the last
  // known state rather than flapping between deployed and stowed.
  if (powerW != null && powerW > 0) {
    return previousState;
  }
  if (underway) return "stowed";
  // 0 W with the sun high enough to produce power means the panel is
  // stowed. At low sun angles (near sunrise/sunset) a deployed panel
  // naturally produces ~0 W, so 0 W is not evidence of stowing.
  if (powerW != null && powerW === 0 && sunUp) return "stowed";
  return null;
}

/**
 * Infers the deploy state for a single mechanical generator from one
 * sample's readings.
 *
 * @param {object} gen - Generator config (id, type, deployable, powerPath,
 *        deployStatePath, startupSpeedKnots, minSpeedKnots)
 * @param {object} ctx - Sample context
 * @param {number|null} [ctx.powerW] - Generator power output (W)
 * @param {string|null} [ctx.deployStateRaw] - Raw sensor value at
 *        gen.deployStatePath (wins over inference)
 * @param {number|null} [ctx.windKnots] - Wind speed in knots (sustained
 *        average for live; bucket value for backfill)
 * @param {number|null} [ctx.stwKnots] - Speed through water in knots
 * @param {string|null} [ctx.navState] - Navigation state
 * @param {boolean} [ctx.underway] - Whether the vessel is under way
 * @param {string|null} [ctx.previousState] - Last known state for this
 *        generator ("deployed"/"stowed"); in marginal conditions (wind or
 *        boat speed in the band between the generator's startup/minimum
 *        speed and its stow-confirm threshold) 0 W holds it instead of
 *        flipping to stowed — a deployed unit's starting reluctance keeps
 *        it still through lulls in gusty conditions
 * @param {number|null} [ctx.stowEvidenceMs] - Milliseconds the current
 *        stow evidence (0 W with conditions at or above the stow-confirm
 *        threshold) has persisted continuously, from
 *        `sustainedStowEvidenceMs()`. Stowage confirms only after
 *        `STOW_EVIDENCE_MIN_MS`; before that the previous state is held.
 *        Null when there is no current evidence (conditions below the
 *        confirm threshold, a positive/missing power reading, or the
 *        generator's regulation SoC reached — a throttled deployed unit).
 * @returns {"deployed"|"stowed"|null} Inferred state, or null if unknown
 */
function detectGeneratorState(gen, ctx) {
  if (!gen.deployable) return null;
  const sensor = normalizeDeployState(ctx.deployStateRaw);
  if (sensor != null) return sensor;
  const { powerW, windKnots, stwKnots, navState, underway, stowEvidenceMs } =
    ctx;
  const previousState =
    ctx.previousState === "deployed" || ctx.previousState === "stowed"
      ? ctx.previousState
      : null;
  // Power output is ground truth and confirms deployment immediately: a
  // generator producing watts IS deployed, whatever the conditions.
  if (powerW != null && powerW > 0) return "deployed";
  if (gen.type === "wind") {
    if (underway) return "stowed";
    if (powerW != null && powerW === 0 && windKnots != null) {
      // Stowage detection is deliberately slow: 0 W is only stow evidence
      // when the wind is clearly above the startup speed — and even then
      // only once the evidence has persisted (STOW_EVIDENCE_MIN_MS of
      // consecutive zero samples with the wind at or above the confirm
      // threshold, per `sustainedStowEvidenceMs`). In gusty, marginal
      // winds around cut-in a deployed unit sits still through the lulls
      // and only spins up in gusts; a regulator can throttle a deployed
      // unit to zero on a full battery — assume it is still deployed and
      // hold the previous state until the zero has proven sustained.
      if (
        windKnots >= windStowConfirmKnots(gen) &&
        stowEvidenceMs != null &&
        stowEvidenceMs >= STOW_EVIDENCE_MIN_MS
      ) {
        return "stowed";
      }
      if (windKnots >= (gen.startupSpeedKnots ?? 5)) return previousState;
    }
    return null;
  }
  if (gen.type === "hydro") {
    if (navState !== "sailing") return "stowed";
    if (powerW != null && powerW === 0 && stwKnots != null) {
      // Same asymmetric hysteresis as wind: clear speed above minimum
      // confirms stowed, but only once the evidence has persisted;
      // marginal speed around the minimum holds the previous state.
      if (
        stwKnots >= hydroStowConfirmKnots(gen) &&
        stowEvidenceMs != null &&
        stowEvidenceMs >= STOW_EVIDENCE_MIN_MS
      ) {
        return "stowed";
      }
      if (stwKnots >= (gen.minSpeedKnots ?? 3)) return previousState;
    }
    return null;
  }
  return null;
}

/**
 * Carries forward the last known state across unknown (null) gaps per device.
 *
 * @param {Array<{states: Map<string, "deployed"|"stowed"|null>}>} samples -
 *        Time-ordered samples, each carrying a per-device state map
 * @returns {Array<Map<string, "deployed"|"stowed">>} Same length; each map
 *          has carry-forward applied (nulls filled from the last known)
 */
function carryForwardStates(samples) {
  const last = new Map();
  return samples.map((s) => {
    const out = new Map();
    for (const [id, state] of s.states) {
      if (state != null) {
        last.set(id, state);
        out.set(id, state);
      } else {
        out.set(id, last.get(id) ?? null);
      }
    }
    return out;
  });
}

module.exports = {
  normalizeDeployState,
  detectSolarArrayState,
  detectGeneratorState,
  carryForwardStates,
  sustainedStowEvidenceMs,
  deployConfirmThresholdW,
  windStowConfirmKnots,
  hydroStowConfirmKnots,
  STOW_INFERENCE_MIN_SUN_ALT_RAD,
  STOW_EVIDENCE_MIN_MS,
  STOW_EVIDENCE_GAP_MS,
};
