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
 *  - Wind generator: power > 0 → deployed; 0 W with wind ≥ startup → stowed;
 *    underway → stowed.
 *  - Hydro generator: not sailing → stowed; sailing ≥ minSpeed with 0 W →
 *    stowed; power > 0 → deployed.
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
 * @returns {"deployed"|"stowed"|null} Inferred state, or null if unknown
 */
function detectGeneratorState(gen, ctx) {
  if (!gen.deployable) return null;
  const sensor = normalizeDeployState(ctx.deployStateRaw);
  if (sensor != null) return sensor;
  const { powerW, windKnots, stwKnots, navState, underway } = ctx;
  if (powerW != null && powerW > 0) return "deployed";
  if (gen.type === "wind") {
    if (underway) return "stowed";
    const startupSpeed = gen.startupSpeedKnots ?? 5;
    if (
      powerW != null &&
      powerW === 0 &&
      windKnots != null &&
      windKnots >= startupSpeed
    ) {
      return "stowed";
    }
    return null;
  }
  if (gen.type === "hydro") {
    if (navState !== "sailing") return "stowed";
    const minSpeed = gen.minSpeedKnots ?? 3;
    if (
      powerW != null &&
      powerW === 0 &&
      stwKnots != null &&
      stwKnots >= minSpeed
    ) {
      return "stowed";
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
  deployConfirmThresholdW,
  STOW_INFERENCE_MIN_SUN_ALT_RAD,
};
