/**
 * Deploy/stow state detection for deployable solar arrays and mechanical
 * generators.
 *
 * The state is inferred from power output and ambient conditions (wind,
 * sun, boat speed, nav state):
 *  - Deployable solar: power > 0 → deployed; 0 W in daytime → stowed;
 *    underway → stowed.
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
 * @returns {"deployed"|"stowed"|null} Inferred state, or null if unknown
 */
function detectSolarArrayState(array, ctx) {
  if (array.type !== "deployable") return null;
  const sensor = normalizeDeployState(ctx.deployStateRaw);
  if (sensor != null) return sensor;
  const { powerW, sunUp, underway } = ctx;
  // Power output is ground truth: a panel producing watts IS deployed,
  // regardless of nav state. The underway inference only applies when
  // there is no power evidence (0 W) — then we assume the panel was
  // stowed because the boat was moving and the owner would have stowed
  // it for the passage.
  if (powerW != null && powerW > 0) return "deployed";
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
  STOW_INFERENCE_MIN_SUN_ALT_RAD,
};
