/**
 * EMA matrix learning engine for profiling solar/wind yield efficiency.
 *
 * Stores efficiency data in matrices binned by:
 * - Anchored matrix key: `Azimuth_Elevation` (e.g., "-45_30")
 * - Sailing matrix key: `Azimuth_Elevation_AWA` (e.g., "-45_30_120")
 *
 * Binning: Azimuth 15°, Elevation 10°, AWA 30°
 *
 * @file learning.js
 */

const solar = require("./solar.js");

/**
 * Smoothing factor for EMA update (low inertia)
 */
const EMA_ALPHA = 0.05;

/**
 * Bin sizes in degrees
 */
const AZIMUTH_BIN = 15;
const ELEVATION_BIN = 10;
const AWA_BIN = 30;

/**
 * Default efficiency value for uninitialized bins
 */
const DEFAULT_EFFICIENCY = 0.7;

/**
 * Bins a value into discrete buckets.
 *
 * @param {number} value - Value in degrees
 * @param {number} binSize - Size of each bin in degrees
 * @returns {number} Binned value (rounded down to nearest bin)
 */
function bin(value, binSize) {
  return Math.floor(value / binSize) * binSize;
}

/**
 * Bins azimuth (-180 to 180) to nearest bin.
 *
 * @param {number} azimuthRad - Azimuth in radians
 * @returns {number} Binned azimuth in degrees
 */
function binAzimuth(azimuthRad) {
  const azimuthDeg = (azimuthRad * 180) / Math.PI;
  const binned = bin(azimuthDeg, AZIMUTH_BIN);
  // Normalize to -180..180 range
  if (binned > 180) {
    return binned - 360;
  }
  if (binned <= -180) {
    return binned + 360;
  }
  return binned;
}

/**
 * Bins elevation (-90 to 90) to nearest bin.
 *
 * @param {number} elevationRad - Elevation in radians
 * @returns {number} Binned elevation in degrees
 */
function binElevation(elevationRad) {
  const elevationDeg = (elevationRad * 180) / Math.PI;
  return bin(elevationDeg, ELEVATION_BIN);
}

/**
 * Bins Apparent Wind Angle (0 to 180) to nearest bin.
 *
 * @param {number} awaRad - AWA in radians
 * @returns {number} Binned AWA in degrees
 */
function binAWA(awaRad) {
  const awaDeg = Math.abs((awaRad * 180) / Math.PI);
  return bin(Math.min(awaDeg, 180), AWA_BIN);
}

/**
 * Generates the matrix key for anchored state.
 *
 * @param {number} azimuthRad - Sun azimuth in radians
 * @param {number} elevationRad - Sun elevation in radians
 * @returns {string} Matrix key (e.g., "-45_30")
 */
function anchoredKey(azimuthRad, elevationRad) {
  const az = binAzimuth(azimuthRad);
  const el = binElevation(elevationRad);
  return `${az}_${el}`;
}

/**
 * Generates the matrix key for sailing state.
 *
 * @param {number} azimuthRad - Sun azimuth in radians
 * @param {number} elevationRad - Sun elevation in radians
 * @param {number} awaRad - Apparent Wind Angle in radians
 * @returns {string} Matrix key (e.g., "-45_30_120")
 */
function sailingKey(azimuthRad, elevationRad, awaRad) {
  const az = binAzimuth(azimuthRad);
  const el = binElevation(elevationRad);
  const awa = binAWA(awaRad);
  return `${az}_${el}_${awa}`;
}

/**
 * Calculates theoretical maximum power output for a horizontal solar array
 * from Global Horizontal Irradiance (GHI).
 *
 * GHI already accounts for the sun's elevation (a low sun delivers less
 * irradiance to a horizontal surface by definition), so the panel output is
 * the nameplate capacity (rated at 1000 W/m² STC) scaled by the irradiance
 * ratio. Do NOT multiply by sin(elevation) here — that double-discounts the
 * angle and makes every real panel look ~2× efficient at low sun.
 *
 * @param {number} capacityWp - Array capacity in peak watts (rated at 1000 W/m²)
 * @param {number} ghi - Global Horizontal Irradiance in W/m²
 * @param {number} elevationRad - Sun elevation in radians (only used to gate night)
 * @returns {number} Theoretical power in watts
 */
function theoreticalPower(capacityWp, ghi, elevationRad) {
  if (ghi <= 0) {
    return 0;
  }
  // Sun below horizon means no generation. (ghi<=0 already implies this,
  // but the explicit check keeps the night gate when called with a clear-sky
  // GHI that may carry a tiny residual at low altitude.)
  if (Math.sin(elevationRad) <= 0) {
    return 0;
  }
  return (capacityWp * ghi) / 1000;
}

/**
 * Clamps a value between 0 and 1.
 *
 * @param {number} value
 * @returns {number} Clamped value
 */
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * Calculates observed efficiency for a tick.
 *
 * @param {number} actualPowerW - Actual measured power in watts
 * @param {number} theoreticalPowerW - Theoretical power in watts
 * @returns {number} Efficiency [0, 1]
 */
function observedEfficiency(actualPowerW, theoreticalPowerW) {
  if (theoreticalPowerW <= 0) {
    return 0;
  }
  return clamp01(actualPowerW / theoreticalPowerW);
}

/**
 * Applies EMA update to a bin.
 *
 * η_new = α * η_observed + (1 - α) * η_existing
 *
 * @param {number} existingEfficiency - Current efficiency [0, 1]
 * @param {number} observedEfficiency - Observed efficiency [0, 1]
 * @param {number} alpha - Smoothing factor (default 0.05)
 * @returns {number} Updated efficiency [0, 1]
 */
function emaUpdate(existingEfficiency, observedEfficiency, alpha = EMA_ALPHA) {
  return alpha * observedEfficiency + (1 - alpha) * existingEfficiency;
}

/**
 * Default state-of-charge learning gate: ticks at or above this SoC are
 * dropped because the charge controller may be limiting output near full.
 * Configurable via `learning.maxSoc` (GitHub #3) — LiFePO4 banks stay in
 * bulk nearly to full, where a 0.8 gate would discard the best-learning
 * hours of the season.
 */
const DEFAULT_MAX_SOC = 0.8;

/**
 * Victron solar charger operation-mode codes (VE.Direct `OperationMode`,
 * as published by e.g. bt-sensors-plugin-sk as `{ code, message }`).
 * Only code 3 (BULK) is bulk-equivalent; anything else is limiting or off.
 */
const VICTRON_OPERATION_MODE_LABELS = {
  0: "off",
  2: "fault",
  3: "bulk",
  4: "absorption",
  5: "float",
  6: "storage",
  7: "equalize",
  8: "external control",
  9: "external control",
};

/**
 * Normalizes a raw Signal K controller-mode reading into the lower-case
 * vocabulary the learning gate understands (`bulk`, `absorption`, `float`,
 * `off`, `mppt active`, ...).
 *
 * Handles the shapes met in the wild:
 * - a plain string ("BULK", "bulk ") → trimmed and lower-cased
 * - the getSelfPath wrapper (`{ value: "BULK" }`) → unwrapped one level
 * - a bt-sensors-plugin-sk charge-state object
 *   (`{ code: 3, message: "BULK" }`) → the `message` label, or the
 *   Victron operation-mode `code` when there is no label
 * - a bare Victron operation-mode code (3) → the label
 *
 * @param {unknown} raw - Raw value from a delta, getSelfPath or history column
 * @returns {string|null} Normalized mode, or null when nothing usable
 */
function normalizeControllerMode(raw) {
  let value = raw;
  if (value != null && typeof value === "object" && "value" in value) {
    value = value.value; // getSelfPath shape
  }
  if (value != null && typeof value === "object") {
    if (typeof value.message === "string") {
      value = value.message;
    } else if (typeof value.code === "number") {
      value = value.code;
    } else {
      return null;
    }
  }
  if (typeof value === "number") {
    return VICTRON_OPERATION_MODE_LABELS[value] ?? `code ${value}`;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

/**
 * Data sanitization gate - checks if telemetry tick should be used for learning.
 *
 * @param {object} readings - Telemetry readings
 * @param {boolean|null} readings.engineRunning - Any engine running (started state or revolutions > 0)
 * @param {number|null} readings.batterySoc - Battery state of charge [0, 1]
 * @param {boolean|null} readings.shorePowerConnected - Shore power connected
 * @param {string|null} readings.controllerMode - Charge controller mode.
 *        Accepts two vocabularies: `controllerMode` (Victron: `bulk` /
 *        `absorption` / `float` / `not charging` / `off`) and `operationMode`
 *        (Victron: `mppt active` / `voltage/current limited` / `off` /
 *        `external control`). A tick is bulk-equivalent — i.e. the controller
 *        is tracking the max power point freely, not limiting output — when
 *        the mode is `bulk` (controllerMode) or `mppt active` (operationMode).
 *        Any other non-null value means the controller is limiting or off,
 *        so the tick is dropped (a limited tick would be mis-learned as
 *        "low efficiency at this sun angle"). The value is normalized via
 *        `normalizeControllerMode` first, so raw bt-sensors-style
 *        `{ code, message }` objects, upper-case labels and Victron numeric
 *        codes are all handled.
 * @param {object} [options] - Gate options
 * @param {number} [options.maxSoc=DEFAULT_MAX_SOC] - Drop ticks at or above
 *        this state of charge [0, 1]. Raise it for chemistries whose
 *        controllers stop limiting only near full (e.g. LiFePO4 at 0.98).
 * @returns {boolean} True if tick is valid for learning
 */
function isValidTick(readings, { maxSoc = DEFAULT_MAX_SOC } = {}) {
  const { engineRunning, batterySoc, shorePowerConnected, controllerMode } =
    readings;

  // Engine running - drop tick (alternator charging confounds solar reading)
  if (engineRunning === true) {
    return false;
  }

  // Battery (nearly) full - drop tick (controller may be limiting)
  if (batterySoc != null && batterySoc >= maxSoc) {
    return false;
  }

  // Shore power connected - drop tick
  if (shorePowerConnected === true) {
    return false;
  }

  // Controller not in a bulk-equivalent mode - drop tick. Both charge-
  // controller vocabularies are accepted: `bulk` (controllerMode) and
  // `mppt active` (operationMode) mean the MPPT tracker is running freely;
  // anything else (absorption, float, voltage/current limited, off, not
  // charging) means output is limited or absent and would corrupt the bin.
  const mode = normalizeControllerMode(controllerMode);
  if (mode != null && mode !== "bulk" && mode !== "mppt active") {
    return false;
  }

  return true;
}

/**
 * Learning matrix for a solar array.
 */
class SolarMatrix {
  /**
   * @param {string} arrayId - Array identifier
   */
  constructor(arrayId) {
    this.arrayId = arrayId;
    this.anchored = new Map(); // Key: "azimuth_elevation", Value: efficiency [0, 1]
    this.sailing = new Map(); // Key: "azimuth_elevation_awa", Value: efficiency [0, 1]
  }

  /**
   * Gets efficiency from anchored matrix.
   *
   * @param {number} azimuthRad - Sun azimuth in radians
   * @param {number} elevationRad - Sun elevation in radians
   * @returns {number} Efficiency [0, 1]
   */
  getAnchored(azimuthRad, elevationRad) {
    const key = anchoredKey(azimuthRad, elevationRad);
    return this.anchored.get(key) ?? DEFAULT_EFFICIENCY;
  }

  /**
   * Gets efficiency from sailing matrix.
   *
   * The sailing matrix is sparsely populated (few under-sail ticks per
   * az/elev/AWA bin) and an unlearned bin used to fall back to the flat
   * DEFAULT_EFFICIENCY (0.7), which over-predicts: the rig shading that's
   * already encoded in the anchored matrix for the same sun position is
   * ignored, and 0.7 is higher than the true under-sail efficiency of a
   * shade-affected array. Instead we fall back to the anchored bin for the
   * same azimuth/elevation first — that carries the shared rig shading
   * (mast, boom, standing rigging present whether sailing or not) — and
   * only use DEFAULT_EFFICIENCY when the anchored bin is also unlearned.
   * Sailing then only needs to learn the *delta* from sail-cloth shading
   * and heeling (which can be positive when heeling sun-side), not the
   * whole shading profile from scratch.
   *
   * @param {number} azimuthRad - Sun azimuth in radians
   * @param {number} elevationRad - Sun elevation in radians
   * @param {number} awaRad - Apparent Wind Angle in radians
   * @returns {number} Efficiency [0, 1]
   */
  getSailing(azimuthRad, elevationRad, awaRad) {
    const key = sailingKey(azimuthRad, elevationRad, awaRad);
    const learned = this.sailing.get(key);
    if (learned != null) {
      return learned;
    }
    return this.getAnchored(azimuthRad, elevationRad);
  }

  /**
   * Updates the learning matrix with new telemetry.
   *
   * @param {object} params
   * @param {string} params.navState - Navigation state ('sailing', 'anchored', 'moored', 'motoring')
   * @param {number} params.actualPowerW - Actual solar output in watts
   * @param {number} params.capacityWp - Array capacity in peak watts
   * @param {number} params.ghi - Global Horizontal Irradiance in W/m²
   * @param {number} params.sunAzimuthRad - Sun azimuth in radians
   * @param {number} params.sunElevationRad - Sun elevation in radians
   * @param {number|null} params.awaRad - Apparent Wind Angle in radians (for sailing state)
   * @param {object} params.readings - Telemetry readings for sanitization gate
   * @param {number} [params.maxSoc] - Learning SoC gate override (see isValidTick)
   * @returns {boolean} True if matrix was updated
   */
  update(params) {
    const {
      navState,
      actualPowerW,
      capacityWp,
      ghi,
      sunAzimuthRad,
      sunElevationRad,
      awaRad,
      readings,
      maxSoc,
    } = params;

    // Pass through sanitization gate
    if (!isValidTick(readings, { maxSoc })) {
      return false;
    }

    // Calculate theoretical power
    const theoretical = theoreticalPower(capacityWp, ghi, sunElevationRad);
    if (theoretical <= 0) {
      return false;
    }

    // Calculate observed efficiency
    const etaObserved = observedEfficiency(actualPowerW, theoretical);

    // Update appropriate matrix based on navigation state
    if (navState === "sailing" && awaRad != null) {
      const key = sailingKey(sunAzimuthRad, sunElevationRad, awaRad);
      // Seed from the anchored bin for the same sun position: the rig
      // shading is already learned there, so the sailing EMA only needs to
      // pick up the delta from sail-cloth shading and heeling (see
      // getSailing). Falls back to DEFAULT_EFFICIENCY when the anchored bin
      // is also unlearned.
      const existing =
        this.sailing.get(key) ??
        this.anchored.get(anchoredKey(sunAzimuthRad, sunElevationRad)) ??
        DEFAULT_EFFICIENCY;
      const updated = emaUpdate(existing, etaObserved);
      this.sailing.set(key, updated);
    } else {
      // anchored, moored, or motoring (engine should be filtered by sanitization gate)
      const key = anchoredKey(sunAzimuthRad, sunElevationRad);
      const existing = this.anchored.get(key) ?? DEFAULT_EFFICIENCY;
      const updated = emaUpdate(existing, etaObserved);
      this.anchored.set(key, updated);
    }

    return true;
  }

  /**
   * Serializes the matrix to a plain object.
   *
   * @returns {{arrayId: string, anchored: Record<string, number>, sailing: Record<string, number>}}
   */
  toJSON() {
    return {
      arrayId: this.arrayId,
      anchored: Object.fromEntries(this.anchored),
      sailing: Object.fromEntries(this.sailing),
    };
  }

  /**
   * Creates a SolarMatrix from a plain object.
   *
   * @param {{arrayId: string, anchored?: Record<string, number>, sailing?: Record<string, number>}} data
   * @returns {SolarMatrix}
   */
  static fromJSON(data) {
    const matrix = new SolarMatrix(data.arrayId);
    if (data.anchored) {
      matrix.anchored = new Map(Object.entries(data.anchored));
    }
    if (data.sailing) {
      matrix.sailing = new Map(Object.entries(data.sailing));
    }
    return matrix;
  }
}

module.exports = {
  SolarMatrix,
  anchoredKey,
  sailingKey,
  theoreticalPower,
  observedEfficiency,
  emaUpdate,
  isValidTick,
  normalizeControllerMode,
  EMA_ALPHA,
  DEFAULT_EFFICIENCY,
  DEFAULT_MAX_SOC,
  AZIMUTH_BIN,
  ELEVATION_BIN,
  AWA_BIN,
};
