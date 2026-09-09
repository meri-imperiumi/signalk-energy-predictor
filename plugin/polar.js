/**
 * Polar-based boat speed estimation from the vessel's active polar.
 *
 * Consumes the Signal K `polars` resource contract published by polar
 * tools (e.g. signalk-polar-management): the `polars.activePolar` delta
 * points at the selected polar resource, and `polars.performanceFactor`
 * carries a crew-set derating multiplier. When no polar is selected (or
 * no provider is installed), everything here degrades to null and the
 * prediction engine falls back to its observed-speed behavior.
 *
 * The canonical polar resource is a TWS × TWA table in SI units
 * (m/s, rad) with a port/starboard symmetry flag:
 *
 *   { kind: 'polarTable', axes: { tws: [...], twa: [...] },
 *     values: { boatSpeedMatrix: [twsIdx][twaIdx] },
 *     symmetry: { portStarboardSymmetric: true } }
 *
 * @file polar.js
 */

/** Resource type of the polar contract. */
const POLAR_RESOURCE_TYPE = "polars";

/**
 * Extracts the resource id from a `polars.activePolar` value.
 *
 * Accepts the plain delta form (`{href: "/resources/polars/<id>"}`), the
 * `app.getSelfPath`-wrapped form (`{value: {href: ...}}`), and full API
 * URLs (`/signalk/v1/api/resources/polars/<id>`).
 *
 * @param {unknown} value - Signal K value of `polars.activePolar`
 * @returns {string|null} Resource id, or null when unset/malformed
 */
function parseActivePolarId(value) {
  if (!value || typeof value !== "object") return null;
  const v =
    value.value && typeof value.value === "object" ? value.value : value;
  const href = typeof v.href === "string" ? v.href : null;
  if (!href) return null;
  const m = href.match(/\/resources\/polars\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Reads the `polars.performanceFactor` delta value.
 *
 * @param {unknown} value - Signal K value of `polars.performanceFactor`
 * @returns {number} Factor clamped to [0, 1] (1 when unset/invalid —
 *          polar-management publishes 1 as its default)
 */
function parsePerformanceFactor(value) {
  const v =
    value && typeof value === "object" && typeof value.value === "number"
      ? value.value
      : typeof value === "number"
        ? value
        : null;
  if (v == null || !Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

/**
 * Validates the shape of a canonical polar table enough for
 * interpolation: ascending non-empty axes and a matrix matching the
 * axes' dimensions.
 *
 * @param {unknown} table - Candidate polar resource
 * @returns {boolean} True when interpolatable
 */
function isInterpolatableTable(table) {
  if (!table || typeof table !== "object") return false;
  const { axes, values } = table;
  if (!Array.isArray(axes?.tws) || !Array.isArray(axes?.twa)) return false;
  if (axes.tws.length < 1 || axes.twa.length < 1) return false;
  if (!Array.isArray(values?.boatSpeedMatrix)) return false;
  if (values.boatSpeedMatrix.length !== axes.tws.length) return false;
  for (let i = 0; i < axes.tws.length; i++) {
    const row = values.boatSpeedMatrix[i];
    if (!Array.isArray(row) || row.length !== axes.twa.length) return false;
    for (let j = 0; j < axes.twa.length; j++) {
      if (typeof row[j] !== "number" || !Number.isFinite(row[j])) return false;
    }
    if (i > 0 && !(axes.tws[i] > axes.tws[i - 1])) return false;
  }
  for (let j = 1; j < axes.twa.length; j++) {
    if (!(axes.twa[j] > axes.twa[j - 1])) return false;
  }
  return true;
}

/** @typedef {{tws: number[], twa: number[], matrix: number[][], symmetric: boolean}} PolarGrid */

/**
 * Normalizes a canonical polar table into an interpolation grid.
 *
 * @param {object} table - Canonical polar resource
 * @returns {PolarGrid|null} Grid, or null when the table is malformed
 */
function toGrid(table) {
  if (!isInterpolatableTable(table)) return null;
  return {
    tws: table.axes.tws,
    twa: table.axes.twa,
    matrix: table.values.boatSpeedMatrix,
    symmetric: table.symmetry?.portStarboardSymmetric !== false,
  };
}

/**
 * Interpolates boat speed from a polar grid.
 *
 * Bilinear over the TWS × TWA grid. Outside the table's range:
 * - TWA below the minimum (pinching): scales linearly toward zero at
 *   TWA 0 — close-hauled speeds fall off toward head-to-wind.
 * - TWA above the maximum: clamps to the last column (dead run).
 * - TWS below the minimum: scales linearly toward zero at 0 m/s.
 * - TWS above the maximum: clamps to the last row — conservative for
 *   hydro stow calls (a boat at hull speed does not get faster with
 *   more wind; overestimating speed there would delay a stow).
 *
 * @param {PolarGrid} grid - Normalized polar grid
 * @param {number} twsMs - True wind speed in m/s
 * @param {number} twaRad - True wind angle in radians (signed ok)
 * @returns {number} Boat speed in m/s (0 when below the table's floor)
 */
function interpolatePolarSpeed(grid, twsMs, twaRad) {
  if (!Number.isFinite(twsMs) || !Number.isFinite(twaRad)) return 0;
  let twa = grid.symmetric ? Math.abs(twaRad) : twaRad;

  // --- TWS axis ---
  let twsScale = 1;
  let tws = twsMs;
  if (tws <= 0) return 0;
  if (tws < grid.tws[0]) {
    // Below the table's lightest wind: scale the first column down
    // linearly toward zero.
    twsScale = tws / grid.tws[0];
    tws = grid.tws[0];
  } else if (tws > grid.tws[grid.tws.length - 1]) {
    tws = grid.tws[grid.tws.length - 1];
  }

  // --- TWA axis ---
  let twaScale = 1;
  if (twa < 0) twa = 0;
  if (twa < grid.twa[0]) {
    // Pinching below the table's closest-winded angle: scale toward
    // zero at head-to-wind.
    twaScale = grid.twa[0] > 0 ? twa / grid.twa[0] : 0;
    twa = grid.twa[0];
  } else if (twa > grid.twa[grid.twa.length - 1]) {
    twa = grid.twa[grid.twa.length - 1];
  }

  // --- Bilinear on the clamped point ---
  const speed = bilinear(grid, tws, twa);
  return Math.max(0, speed * twsScale * twaScale);
}

/**
 * Plain bilinear interpolation inside the grid bounds.
 *
 * @param {PolarGrid} grid - Polar grid
 * @param {number} tws - TWS in m/s, clamped into [first, last]
 * @param {number} twa - TWA in rad, clamped into [first, last]
 * @returns {number} Boat speed in m/s
 */
function bilinear(grid, tws, twa) {
  const { tws: twsAxis, twa: twaAxis, matrix } = grid;
  const i = upperIndex(twsAxis, tws);
  const j = upperIndex(twaAxis, twa);
  const i0 = Math.max(0, i - 1);
  const j0 = Math.max(0, j - 1);
  const i1 = Math.min(twsAxis.length - 1, i0 + 1);
  const j1 = Math.min(twaAxis.length - 1, j0 + 1);

  const tw =
    twsAxis[i1] > twsAxis[i0]
      ? (tws - twsAxis[i0]) / (twsAxis[i1] - twsAxis[i0])
      : 0;
  const ta =
    twaAxis[j1] > twaAxis[j0]
      ? (twa - twaAxis[j0]) / (twaAxis[j1] - twaAxis[j0])
      : 0;

  const s00 = matrix[i0][j0];
  const s01 = matrix[i0][j1];
  const s10 = matrix[i1][j0];
  const s11 = matrix[i1][j1];
  return (
    s00 * (1 - tw) * (1 - ta) +
    s01 * (1 - tw) * ta +
    s10 * tw * (1 - ta) +
    s11 * tw * ta
  );
}

/**
 * First index whose axis value is >= target (axis.length when above all).
 *
 * @param {number[]} axis - Ascending axis values
 * @param {number} target - Value to locate
 * @returns {number} Index in [0, axis.length]
 */
function upperIndex(axis, target) {
  let lo = 0;
  let hi = axis.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A loaded polar ready for speed lookups.
 * @typedef {{available: true, id: string, performanceFactor: number, speedAt: (twsMs: number, twaRad: number) => number}} PolarSpeedModel
 */

/**
 * Builds a polar speed model from a canonical table.
 *
 * @param {object} params
 * @param {string} params.id - Resource id (for logging)
 * @param {object} params.table - Canonical polar resource
 * @param {number} [params.performanceFactor=1] - Derating multiplier [0, 1]
 * @returns {PolarSpeedModel|null} Model, or null when the table is malformed
 */
function createPolarSpeedModel({ id, table, performanceFactor = 1 }) {
  const grid = toGrid(table);
  if (!grid) return null;
  const pf = parsePerformanceFactor(performanceFactor);
  return {
    available: true,
    id,
    performanceFactor: pf,
    /**
     * Boat speed at a wind state.
     *
     * @param {number} twsMs - True wind speed in m/s
     * @param {number} twaRad - True wind angle in radians
     * @returns {number} Speed in m/s
     */
    speedAt(twsMs, twaRad) {
      return interpolatePolarSpeed(grid, twsMs, twaRad) * pf;
    },
  };
}

/**
 * Loads the active polar from the Signal K resource provider.
 *
 * Reads the `polars.activePolar` pointer via `readValue` (a
 * deltaState-first getter), fetches the referenced resource in-process,
 * and applies the published `polars.performanceFactor`. Returns null —
 * never throws — when no polar is active, no provider is installed, or
 * the fetch/shape fails: the caller degrades to observed-speed
 * behavior.
 *
 * @param {object} params
 * @param {object} params.app - Signal K server API
 * @param {(path: string) => unknown} params.readValue - Path reader
 *        (deltaState-first, getSelfPath fallback)
 * @param {string} [params.cachedId] - Resource id already loaded (skips
 *        the fetch when unchanged)
 * @param {object} [params.cachedTable] - Table for `cachedId`
 * @returns {Promise<{model: PolarSpeedModel|null, id: string|null, table: object|null}>}
 *          Loaded model plus the (possibly cached) table for reuse
 */
async function loadActivePolarModel({ app, readValue, cachedId, cachedTable }) {
  const id = parseActivePolarId(readValue("polars.activePolar"));
  if (id == null) {
    return { model: null, id: null, table: null };
  }
  const performanceFactor = parsePerformanceFactor(
    readValue("polars.performanceFactor"),
  );

  let table = null;
  if (id === cachedId && cachedTable) {
    table = cachedTable;
  } else if (typeof app?.resourcesApi?.getResource !== "function") {
    // No resource provider API (or none registered for polars): the
    // feature is simply unavailable on this server.
    return { model: null, id: null, table: null };
  } else {
    try {
      table = await app.resourcesApi.getResource(POLAR_RESOURCE_TYPE, id);
    } catch (err) {
      app?.debug?.(`Polar load failed for '${id}': ${err?.message ?? err}`);
      return { model: null, id: null, table: null };
    }
  }

  const model = createPolarSpeedModel({ id, table, performanceFactor });
  if (!model) {
    app?.debug?.(`Active polar '${id}' has an unusable table shape`);
    return { model: null, id: null, table: null };
  }
  return { model, id, table };
}

module.exports = {
  POLAR_RESOURCE_TYPE,
  parseActivePolarId,
  parsePerformanceFactor,
  isInterpolatableTable,
  interpolatePolarSpeed,
  createPolarSpeedModel,
  loadActivePolarModel,
};
