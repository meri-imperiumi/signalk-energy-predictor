/**
 * 24-hour prediction engine for energy balance forecasting.
 *
 * Combines weather forecasts, learning matrix efficiencies, and load profiles
 * to predict future SoC and generate advisories.
 *
 * @file prediction.js
 */

const { sunPosition, nextSunrise, nextSunset, lastSunset } =
  require("./solar.js");
const {
  evaluateCombustionTier,
  updateCombustionRuns,
  resolveGensetRunning,
  detectEngineRunning,
  resolveTierSettings,
} = require("./combustion.js");
const { theoreticalPower } = require("./learning.js");
const { formatWh, solarOffsetMinutesFromLongitude, formatLocalHHMM } =
  require("./format.js");
const SunCalc = require("suncalc");

/**
 * Default prediction horizon in hours. Override via the engine's
 * `predictionHours` option (from the `weather.forecastHours` config).
 */
const PREDICTION_HOURS = 24;

/** Maximum configurable prediction horizon in hours (matches schema) */
const MAX_PREDICTION_HOURS = 168;

/**
 * Critical SoC thresholds for the 24h energy outlook, by battery
 * chemistry: LiFePO4 tolerates deep discharge, lead-acid sulfates below
 * ~50% (we trip "critical" at 45% to leave margin).
 */
const CRITICAL_SOC_LIFEPO4 = 0.3;
const CRITICAL_SOC_LEAD_ACID = 0.45;

/**
 * House load smoothing window in hours
 */
const LOAD_SMOOTHING_HOURS = 3;

/**
 * Hourly prediction result.
 * @typedef {{hour: number, time: Date, idealSolarYieldWh: number, idealWindYieldWh: number, idealHydroYieldWh: number, houseLoadWh: number, idealNetWh: number, idealSoC: number, detectedYieldWh: number, detectedNetWh: number, detectedSoC: number, actions: Array<{id: string, idealAction: string, detectedAction: string|null, reason: string}>}} HourlyPrediction
 */

/**
 * Wind generator curve point.
 * @typedef {{speed: number, watts: number}} CurvePoint
 */

/**
 * Interpolates power from a wind generator curve.
 *
 * @param {CurvePoint[]} curve - Array of [speed, watts] points (speeds in m/s), sorted by speed
 * @param {number} speedMs - Wind speed in m/s
 * @returns {number} Power in watts
 */
function interpolateWindPower(curve, speedMs) {
  if (curve.length === 0) {
    return 0;
  }

  if (speedMs <= curve[0].speed) {
    return 0; // Below cut-in
  }

  if (speedMs >= curve[curve.length - 1].speed) {
    return curve[curve.length - 1].watts; // Above last point (should be rated power)
  }

  // Find the interval containing speedMs
  for (let i = 1; i < curve.length; i++) {
    if (speedMs <= curve[i].speed) {
      const t =
        (speedMs - curve[i - 1].speed) / (curve[i].speed - curve[i - 1].speed);
      return curve[i - 1].watts + t * (curve[i].watts - curve[i - 1].watts);
    }
  }

  return 0;
}

/**
 * Calculates predicted solar yield for an hour.
 *
 * @param {object} params
 * @param {object} params.array - Solar array configuration
 * @param {string} params.array.id - Array ID
 * @param {string} params.array.type - "fixed" or "deployable"
 * @param {number} params.array.capacityWp - Capacity in peak watts
 * @param {number|null} params.array.gustLimitMs - Gust limit for deployable arrays (m/s)
 * @param {object} params.sunPosition - Sun position {azimuth, altitude}
 * @param {number} params.ghi - Global Horizontal Irradiance in W/m²
 * @param {number} params.windGustMs - Wind gust speed in m/s
 * @param {number} params.efficiency - Array efficiency [0, 1] from learning matrix
 * @param {boolean} [params.skipStowGate] - Skip the gust stow gate (detected track:
 *   the array is actually deployed, so it produces even when the ideal
 *   track would stow it)
 * @returns {number} Predicted yield in watt-hours for the hour
 */
function predictSolarHour({
  array,
  sunPosition,
  ghi,
  windGustMs,
  efficiency,
  skipStowGate = false,
}) {
  // Check FLINsail risk for deployable arrays
  if (
    !skipStowGate &&
    array.type === "deployable" &&
    array.gustLimitMs != null
  ) {
    if (windGustMs >= array.gustLimitMs) {
      return 0; // Should be stowed, no yield
    }
  }

  // Theoretical power from GHI (horizontal panel, STC rated at 1000 W/m²).
  // the theoreticalPower handles the night gate (sun below horizon).
  const theoretical = theoreticalPower(
    array.capacityWp,
    ghi,
    sunPosition.altitude,
  );
  if (theoretical <= 0) {
    return 0;
  }
  const actualPower = theoretical * efficiency;

  // Convert to watt-hours for the hour
  return actualPower;
}

/**
 * Calculates predicted wind generator yield for an hour.
 *
 * @param {object} params
 * @param {object} params.generator - Generator configuration
 * @param {string} params.generator.id - Generator ID
 * @param {string} params.generator.type - "wind" or "hydro"
 * @param {boolean} params.generator.deployable - Whether generator is deployable
 * @param {CurvePoint[]} params.generator.curve - Power curve (speeds in m/s)
 * @param {number} params.windSpeedMs - Average wind speed in m/s
 * @param {number} [params.gustSpeedMs] - Gust speed in m/s (deployable: stow if exceeds max)
 * @param {boolean} params.isSailing - Whether vessel is sailing (affects deployable yield)
 * @param {boolean} [params.skipStowGate] - Skip the stow gates (detected track:
 *   the generator is actually up, so it produces even when the ideal track
 *   would stow it)
 * @returns {number} Predicted yield in watt-hours for the hour
 */
function predictWindHour({
  generator,
  windSpeedMs,
  gustSpeedMs,
  isSailing = false,
  navState = "unknown",
  skipStowGate = false,
}) {
  if (generator.type !== "wind") {
    return 0;
  }

  const maxWind = generator.maxWindMs ?? msFromKnots(30);

  // Apply wind speed limit
  if (!skipStowGate && windSpeedMs > maxWind) {
    return 0; // Exceeds limit, would be stowed
  }

  // Deployable wind generators: stow if gusts exceed the max limit
  if (
    !skipStowGate &&
    generator.deployable &&
    gustSpeedMs != null &&
    gustSpeedMs >= maxWind
  ) {
    return 0; // Gusts exceed limit, would be stowed
  }

  // Deployable wind generators are used at anchor, NOT under way.
  // Some vessels cannot deploy at a mooring (proximity to dock/other
  // boats) — gated by generator.deployableAtMoored (default true).
  // When the navigation state is unknown we cannot confirm we are at
  // anchor, so be conservative and stow (only confirmed anchor/mooring
  // counts as deployable).
  if (generator.deployable) {
    if (navState === "sailing" || navState === "motoring") {
      return 0; // Stowed when under way (hydro or engine are available)
    }
    const deployAtMoored = generator.deployableAtMoored !== false;
    const atAnchor = navState === "anchored";
    const atMooring = navState === "moored" && deployAtMoored;
    if (!atAnchor && !atMooring) {
      return 0; // Stowed: under way, at a mooring that can't deploy, or unknown
    }
  }

  const power = interpolateWindPower(generator.curve, windSpeedMs);
  return power; // Watts -> Wh for the hour
}

/**
 * Calculates predicted hydro generator yield for an hour.
 *
 * @param {object} params
 * @param {object} params.generator - Generator configuration
 * @param {string} params.generator.id - Generator ID
 * @param {string} params.generator.type - "wind" or "hydro"
 * @param {boolean} params.generator.deployable - Whether generator is deployable
 * @param {CurvePoint[]} params.generator.curve - Power curve (speeds in m/s)
 * @param {number} params.speedThroughWaterMs - Vessel speed through water in m/s
 * @param {boolean} params.isSailing - Whether vessel is sailing
 * @returns {number} Predicted yield in watt-hours for the hour
 */
function predictHydroHour({
  generator,
  speedThroughWaterMs,
  isSailing = false,
}) {
  if (generator.type !== "hydro") {
    return 0;
  }

  const minSpeed = generator.minSpeedMs ?? msFromKnots(3);
  const maxSpeed = generator.maxSpeedMs ?? msFromKnots(12);

  // Hydro generators only work when the vessel is moving through water
  // Apply min/max limits
  if (speedThroughWaterMs < minSpeed) {
    return 0; // Too slow, not generating
  }
  if (speedThroughWaterMs > maxSpeed) {
    return 0; // Too fast, would be stowed for safety
  }

  // If the forecast doesn't include speed data, assume sailing for hydro prediction
  // (since that's when hydro makes sense) or use a conservative estimate
  if (!isSailing && speedThroughWaterMs > 0) {
    // Vessel is moving but not explicitly sailing (could be motoring)
    // Assume hydro is deployed half the time
    speedThroughWaterMs *= 0.5;
  } else if (!isSailing && speedThroughWaterMs === 0) {
    return 0; // Not moving, no hydro yield
  }

  // Hydro generators use water speed (speed through water) instead of wind speed
  const power = interpolateWindPower(generator.curve, speedThroughWaterMs);
  return power; // Watts -> Wh for the hour
}

/**
 * Maintains a rolling average of house loads.
 */
/**
 * Sun phase classification.
 * @enum {string}
 */
const SunPhase = {
  DAWN: "dawn",
  DAY: "day",
  DUSK: "dusk",
  NIGHT: "night",
};

/**
 * State class classification.
 * @enum {string}
 */
const StateClass = {
  UNDERWAY: "underway",
  AT_REST: "at-rest",
};

/**
 * Load profile with sun-phase binned EMA for AC and DC loads.
 */
class LoadProfile {
  /**
   * Creates a new LoadProfile instance.
   *
   * @param {object} params
   * @param {object} [params.config] - Load profile configuration
   * @param {boolean} [params.config.enabled=true] - Whether learning is enabled
   * @param {number} [params.config.alpha=0.05] - EMA alpha
   * @param {number} [params.config.minDaysPerBin=3] - Minimum days before bin is used
   * @param {number} [params.config.outlierFactor=3] - Factor for spike gate
   * @param {(path: string) => unknown} params.getSelfPath - Function to read Signal K values
   * @param {object} params.app - Signal K server API (for logging)
   * @param {Array<{id: string}>} [params.engines] - Configured engines
   *        (ids are Signal K propulsion instance names, e.g. "port"),
   *        used as the fallback for engine-running detection
   * @param {() => (boolean|null)} [params.getEngineRunning] - Dynamic
   *        engine-running detector (scans all propulsion instances); wins
   *        over the configured-engines fallback
   */
  constructor({
    config = {},
    getSelfPath,
    app,
    engines,
    getEngineRunning,
  } = {}) {
    // Configuration
    this.enabled = config.enabled !== false;
    this.alpha = config.alpha ?? 0.05;
    this.minDaysPerBin = config.minDaysPerBin ?? 3;
    this.outlierFactor = config.outlierFactor ?? 3;

    this.getSelfPath = getSelfPath;
    this.app = app;
    this.engines = engines || [];
    this.getEngineRunning = getEngineRunning || null;

    // 8 bins: 2 state classes × 4 sun phases
    // Each bin tracks AC and DC separately
    this.bins = new Map();
    this.samplesPerBin = new Map(); // Track number of days for minSamples gate

    // Current rolling average (fallback for unlearned bins)
    this.samples = []; // {time: Date, dcLoadW: number, acLoadW: number}
  }

  /**
   * Gets the bin key for a given state class and sun phase.
   *
   * @param {string} stateClass - State class (underway or at-rest)
   * @param {string} sunPhase - Sun phase (dawn, day, dusk, night)
   * @returns {string} Bin key
   */
  getBinKey(stateClass, sunPhase) {
    return `${stateClass}:${sunPhase}`;
  }

  /**
   * Gets the sun phase for a given timestamp and position.
   *
   * @param {Date} timestamp - Timestamp to evaluate
   * @param {{latitude: number, longitude: number}|null} position - Position
   * @returns {string} Sun phase
   */
  getSunPhase(timestamp, position) {
    if (!position || position.latitude == null || position.longitude == null) {
      return SunPhase.DAY; // Default to day if no position
    }

    const date = new Date(timestamp);
    const times = SunCalc.getTimes(date, position.latitude, position.longitude);

    if (!times.sunrise || !times.sunset) {
      return SunPhase.DAY;
    }

    const sunrise = new Date(times.sunrise);
    const sunset = new Date(times.sunset);

    const dawnStart = new Date(sunrise.getTime() - 2 * 3600000);
    const duskEnd = new Date(sunset.getTime() + 2 * 3600000);

    if (timestamp >= dawnStart && timestamp < sunrise) {
      return SunPhase.DAWN;
    }
    if (timestamp >= sunrise && timestamp < sunset) {
      return SunPhase.DAY;
    }
    if (timestamp >= sunset && timestamp < duskEnd) {
      return SunPhase.DUSK;
    }
    return SunPhase.NIGHT;
  }

  /**
   * Gets the current state class (underway or at-rest).
   *
   * @returns {string} State class
   */
  getStateClass() {
    const state = this.getSelfPath("navigation.state");
    if (
      typeof state === "string" &&
      ["sailing", "motoring", "under way"].includes(state)
    ) {
      return StateClass.UNDERWAY;
    }
    return StateClass.AT_REST;
  }

  /**
   * Checks if any engine is currently running.
   *
   * The dynamic detector (when injected — it scans every subscribed
   * propulsion instance, whatever the names) wins. Otherwise the
   * configured engines are probed individually: each id is a Signal K
   * propulsion instance name ("main", "port", "starboard", …), so a
   * catamaran with port/starboard engines is fully covered by config.
   * An engine with no alternator (electric drive) still counts as an
   * engine here — running means "consumer active", which the learning
   * gates must exclude.
   *
   * @returns {boolean|null} true if any engine is running, false if all stopped, null if unknown
   */
  isEngineRunning() {
    if (this.getEngineRunning) {
      const v = this.getEngineRunning();
      if (v != null) return v;
    }
    let anyRunning = false;
    let anySignal = false;
    for (const engine of this.engines) {
      const v = detectEngineRunning(engine, this.getSelfPath);
      if (v != null) {
        anySignal = true;
        if (v === true) anyRunning = true;
      }
    }
    return anySignal ? anyRunning : null;
  }

  /**
   * Checks if shore power is connected.
   *
   * @returns {boolean}
   */
  isShorePowerConnected() {
    const val = this.getSelfPath("electrical.shore.power.connected");
    if (val == null) {
      return false;
    }
    return val === true || (typeof val === "object" && val.value === true);
  }

  /**
   * Checks if a sample should be gated out (not learned).
   *
   * Gates use explicit overrides when provided (historical replay); otherwise
   * they read the live Signal K state via getSelfPath (live prediction path).
   *
   * @param {number} dcLoadW - DC load in watts
   * @param {number} acLoadW - AC load in watts
   * @param {string} binKey - Bin key for the sample
   * @param {{shorePowerConnected?: boolean|null, engineRunning?: boolean|null}} [overrides] - Historical state overrides
   * @returns {string|null} Gate name if gated, null if should sample
   */
  shouldGate(dcLoadW, acLoadW, binKey, overrides = {}) {
    const shorePower =
      overrides.shorePowerConnected ?? this.isShorePowerConnected();
    if (shorePower) {
      return "shore-power";
    }

    const engineRunning = overrides.engineRunning ?? this.isEngineRunning();
    if (engineRunning === true) {
      return "engine-running";
    }

    // Spike/outlier gate (only check if we have an EMA value).
    // Symmetric: rejects samples that are far ABOVE or far BELOW the current
    // EMA. The high gate catches sensor spikes (e.g. a momentary 500W blip);
    // the low gate catches charging artifacts and sensor dropouts that would
    // otherwise drag a healthy bin down and lock it there (a collapsed EMA
    // then rejects all real samples via the high gate). A 3x factor allows
    // gradual seasonal drift while blocking single-sample poisoning.
    const bin = this.bins.get(binKey);
    const totalLoadW = dcLoadW + acLoadW;
    if (bin && bin.dcEma != null) {
      const currentEma = bin.dcEma + bin.acEma;
      const upper = currentEma * this.outlierFactor;
      const lower = currentEma / this.outlierFactor;
      if (totalLoadW > upper) {
        return "spike-outlier";
      }
      if (totalLoadW < lower) {
        return "low-outlier";
      }
    }

    return null;
  }

  /**
   * Tracks days sampled per bin for the minSamples gate.
   *
   * @param {string} binKey - Bin key
   * @param {Date} [when] - Sample timestamp (defaults to now, live path)
   * @returns {void}
   */
  trackSampleDay(binKey, when = new Date()) {
    const day = new Date(when).toISOString().split("T")[0];
    const key = `${binKey}:${day}`;
    if (!this.samplesPerBin.has(key)) {
      this.samplesPerBin.set(key, true);
    }
  }

  /**
   * Gets the number of distinct days a bin has samples from.
   *
   * @param {string} binKey - Bin key
   * @returns {number} Number of days
   */
  getSampleDays(binKey) {
    let count = 0;
    for (const key of this.samplesPerBin.keys()) {
      if (key.startsWith(`${binKey}:`)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Adds a load sample to the appropriate bin (live prediction path).
   *
   * Reads the current nav state, engine state, and shore-power state from
   * Signal K via getSelfPath. For historical replay, call ingestSample()
   * directly with explicit overrides.
   *
   * @param {number} dcLoadW - DC load in watts
   * @param {number} acLoadW - AC load in watts
   * @param {{latitude: number, longitude: number}|null} position - Current position
   * @returns {void}
   */
  addSample(dcLoadW, acLoadW, position) {
    const now = new Date();

    // Track in rolling average (fallback)
    this.samples.push({
      time: now,
      dcLoadW,
      acLoadW,
    });
    const cutoff = Date.now() - LOAD_SMOOTHING_HOURS * 3600000;
    this.samples = this.samples.filter((s) => s.time.getTime() > cutoff);

    if (!this.enabled) {
      return;
    }

    this.ingestSample({
      time: now,
      dcLoadW,
      acLoadW,
      position,
      stateClass: this.getStateClass(),
      engineRunning: this.isEngineRunning(),
      shorePowerConnected: this.isShorePowerConnected(),
    });
  }

  /**
   * Ingests a load sample with explicit classification state.
   *
   * Core binning routine shared by the live path (addSample) and historical
   * replay (replayLoadProfile). Skips the rolling-average tracking, which
   * only the live path needs.
   *
   * @param {object} params
   * @param {Date} params.time - Sample timestamp
   * @param {number} params.dcLoadW - DC load in watts
   * @param {number} params.acLoadW - AC load in watts
   * @param {{latitude: number, longitude: number}|null} params.position - Position at sample time
   * @param {string} params.stateClass - State class (underway or at-rest)
   * @param {boolean|null} [params.engineRunning] - Engine running at sample time
   * @param {boolean|null} [params.shorePowerConnected] - Shore power at sample time
   * @returns {string|null} Gate name if the sample was gated, null if ingested
   */
  ingestSample({
    time,
    dcLoadW,
    acLoadW,
    position,
    stateClass,
    engineRunning = null,
    shorePowerConnected = null,
  }) {
    if (!this.enabled) {
      return null;
    }

    const sunPhase = this.getSunPhase(time, position);
    const binKey = this.getBinKey(stateClass, sunPhase);

    const gate = this.shouldGate(dcLoadW, acLoadW, binKey, {
      engineRunning,
      shorePowerConnected,
    });
    if (gate) {
      this.app?.debug?.(
        `Load profile gated: ${gate}, state=${stateClass}, phase=${sunPhase}`,
      );
      return gate;
    }

    // Track sample day for minSamples gate
    this.trackSampleDay(binKey, time);

    // Get or create bin
    let bin = this.bins.get(binKey);
    if (!bin) {
      bin = { dcEma: null, acEma: null };
      this.bins.set(binKey, bin);
    }

    // Update EMAs
    if (bin.dcEma == null) {
      bin.dcEma = dcLoadW;
      bin.acEma = acLoadW;
    } else {
      bin.dcEma = this.alpha * dcLoadW + (1 - this.alpha) * bin.dcEma;
      bin.acEma = this.alpha * acLoadW + (1 - this.alpha) * bin.acEma;
    }

    this.app?.debug?.(
      `Load profile sample: state=${stateClass}, phase=${sunPhase}, dc=${Math.round(dcLoadW)}W, ac=${Math.round(acLoadW)}W`,
    );
    return null;
  }

  /**
   * Gets the load for a given sun phase and state class.
   *
   * @param {string} sunPhase - Sun phase
   * @param {string} stateClass - State class
   * @returns {{dcWh: number, acWh: number}|null} Load in Wh per hour, or null if bin not ready
   */
  getLoad(sunPhase, stateClass) {
    const binKey = this.getBinKey(stateClass, sunPhase);
    const bin = this.bins.get(binKey);

    // Check if bin has enough samples
    if (
      !bin ||
      bin.dcEma == null ||
      this.getSampleDays(binKey) < this.minDaysPerBin
    ) {
      return null; // Fall back to rolling average
    }

    // Return EMAs as Wh per hour (they're stored as W)
    return {
      dcWh: bin.dcEma,
      acWh: bin.acEma,
    };
  }

  /**
   * Lists learned bins (those past the min-days gate).
   *
   * @returns {Array<{binKey: string, stateClass: string, sunPhase: string, dcWh: number, acWh: number, days: number}>}
   */
  learnedBins() {
    const out = [];
    for (const [binKey, bin] of this.bins) {
      if (bin.dcEma == null) continue;
      const days = this.getSampleDays(binKey);
      if (days < this.minDaysPerBin) continue;
      const [stateClass, sunPhase] = binKey.split(":");
      out.push({
        binKey,
        stateClass,
        sunPhase,
        dcWh: bin.dcEma,
        acWh: bin.acEma,
        days,
      });
    }
    return out;
  }

  /**
   * Gets the average hourly load from rolling average (fallback).
   *
   * @returns {{dcWh: number, acWh: number}} Average load in Wh per hour
   */
  getAverageLoad() {
    if (this.samples.length === 0) {
      return { dcWh: 0, acWh: 0 };
    }

    const dcTotal = this.samples.reduce((sum, s) => sum + s.dcLoadW, 0);
    const acTotal = this.samples.reduce((sum, s) => sum + s.acLoadW, 0);
    return {
      dcWh: dcTotal / this.samples.length,
      acWh: acTotal / this.samples.length,
    };
  }

  /**
   * Serializes the load profile for persistence.
   *
   * @returns {object} Serialized profile
   */
  toJSON() {
    return {
      bins: Object.fromEntries(this.bins),
      samplesPerBin: Array.from(this.samplesPerBin.keys()),
    };
  }

  /**
   * Loads a serialized load profile.
   *
   * @param {object} data - Serialized profile
   * @returns {void}
   */
  fromJSON(data) {
    if (data.bins) {
      this.bins = new Map(Object.entries(data.bins));
    }
    if (data.samplesPerBin && Array.isArray(data.samplesPerBin)) {
      this.samplesPerBin = new Map(data.samplesPerBin.map((k) => [k, true]));
    }
  }
}

/**
 * Extracts a numeric value from a Signal K value that may be a number or an object with .value.
 * @param {unknown} v
 * @returns {number|null}
 */
function toNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return isNaN(v) ? null : v;
  if (typeof v === "object" && typeof v.value === "number")
    return isNaN(v.value) ? null : v.value;
  return null;
}

/**
 * Normalizes a Signal K navigation.position value into {latitude, longitude}.
 * Handles both the unwrapped form ({latitude, longitude}, as stored in the
 * live deltaState) and the wrapped form ({value: {latitude, longitude}}, as
 * returned by app.getSelfPath when no recent delta is available).
 * @param {unknown} pos
 * @returns {{latitude: number, longitude: number}|null}
 */
function unwrapPosition(pos) {
  if (!pos || typeof pos !== "object") return null;
  const v = pos.value && typeof pos.value === "object" ? pos.value : pos;
  if (typeof v.latitude === "number" && typeof v.longitude === "number") {
    return { latitude: v.latitude, longitude: v.longitude };
  }
  return null;
}

/** Conversion factor: 1 m/s = 1.94384 knots */
const MS_TO_KN = 1.94384;
/** Conversion factor: 1 knot = 0.514444 m/s */
const KN_TO_MS = 1 / MS_TO_KN;

/**
 * Normalizes an angle to [-π, π).
 * @param {number} a - Angle in radians
 * @returns {number} Normalized angle
 */
function normalizeAngle(a) {
  let r = a;
  while (r >= Math.PI) r -= 2 * Math.PI;
  while (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

/**
 * Inserts an action into the hourly bucket containing the target time.
 * Targets before the forecast window clamp to hour 0; targets beyond the
 * window are dropped. Replaces an existing action for the same device in
 * the bucket.
 *
 * @param {HourlyPrediction[]} predictions - Hourly predictions (mutated)
 * @param {number} startTimeMs - First bucket time in milliseconds
 * @param {Date} targetTime - Exact time the action should occur
 * @param {object} action - Action object (its `time` field is updated)
 * @returns {void}
 */
function insertActionIntoBucket(predictions, startTimeMs, targetTime, action) {
  let h = Math.floor((targetTime.getTime() - startTimeMs) / 3600000);
  if (h < 0) {
    // Target is before the forecast window (e.g. sunset already passed):
    // the right advice is to act now, so stamp with the current hour's time
    h = 0;
    action.time = predictions[0].time.toISOString();
  } else {
    action.time = targetTime.toISOString();
  }
  if (h >= predictions.length) return;
  const bucket = predictions[h].actions;
  const idx = bucket.findIndex((a) => a.id === action.id);
  if (idx >= 0) {
    bucket[idx] = action;
  } else {
    bucket.push(action);
  }
}

/**
 * Rephrases a deployable-solar action's reason after it has been shifted
 * from a night hour to a sun boundary (deploy → next sunrise, stow → last
 * sunset). The night-hour reason (e.g. "no night gusts" for a carry-over
 * deploy, or "forecast night gusts up to 23kn ≥ limit 20kn" for a before-
 * dark stow) is phrased for the dark hours; at the boundary it would read
 * oddly (a *morning* deploy saying "no night gusts"). This keeps the gust
 * figure where present and reframes the reason for the boundary hour.
 *
 * @param {string} reason - The night-hour reason to rephrase
 * @param {boolean} isStow - Whether the shifted action is a stow (to sunset)
 * @returns {string} Reason rephrased for the sun-boundary hour
 */
function rephraseShiftedSolarReason(reason, isStow) {
  if (!reason) return reason;
  // Pull any gust figure (e.g. "23kn") out of the night reason so the
  // rephrased reason keeps the concrete number the crew cares about.
  const gustMatch = reason.match(/(\d+)kn/);
  const gust = gustMatch ? gustMatch[1] : null;
  if (isStow) {
    // Stow moved to the sunset that starts the night: the point is to
    // secure the sail before dark because of the night's gusts.
    return gust
      ? `stow before dark — night gusts up to ${gust}kn`
      : "stow before dark — night gusts forecast";
  }
  // Deploy moved to the next sunrise: the sail was safe overnight, deploy
  // at first light. "no night gusts" and neutral carry-forward reasons
  // ("no forecast for this hour") both collapse to this.
  return gust
    ? `no overnight gusts (max ${gust}kn) — deploy at sunrise`
    : "no overnight gusts — deploy at sunrise";
}

/**
 * Formats a bearing (radians) as a compass bearing string (e.g. "090°").
 * @param {number} rad - Bearing in radians
 * @returns {string} Bearing in degrees, 3-digit
 */
function formatBearing(rad) {
  const deg = ((rad * 180) / Math.PI + 360) % 360;
  return `${Math.round(deg).toString().padStart(3, "0")}°`;
}

/**
 * Converts a Signal K speed value (m/s) to knots.
 * Handles plain numbers and {value: number} objects.
 * @param {number|object|null} v - Speed in m/s
 * @returns {number|null} Speed in knots, or null
 */
function toKnots(v) {
  const ms = toNumber(v);
  return ms == null ? null : ms * MS_TO_KN;
}

/**
 * Normalizes a Signal K speed value to m/s (the engine's canonical unit).
 * Handles plain numbers and {value: number} objects. Signal K already
 * carries wind/STW in m/s, so this is mostly a tolerant passthrough;
 * it exists so call sites read clearly as "give me m/s".
 * @param {number|object|null} v - Speed in m/s
 * @returns {number|null} Speed in m/s, or null
 */
function toMs(v) {
  const ms = toNumber(v);
  return ms == null ? null : ms;
}

/**
 * Converts a knots value to m/s. Used to convert sailor-configured knot
 * thresholds/defaults into the engine's canonical m/s at the config-read
 * boundary.
 * @param {number} kn - Speed in knots
 * @returns {number} Speed in m/s
 */
function msFromKnots(kn) {
  return kn * KN_TO_MS;
}

/**
 * Normalizes a solar-array config's wind thresholds from the schema's
 * knots keys to the engine's canonical m/s. Accepts either `*Knots`
 * (schema/tests) or pre-converted `*Ms` keys; `*Ms` wins if both present.
 * @param {object} a - Solar array config
 * @returns {object} Config with `gustLimitMs` / `gustHysteresisMs` set
 */
function normalizeArrayWindConfig(a) {
  const out = { ...a };
  if (out.gustLimitMs == null && out.gustLimitKnots != null) {
    out.gustLimitMs = msFromKnots(out.gustLimitKnots);
  }
  if (out.gustHysteresisMs == null && out.gustHysteresisKnots != null) {
    out.gustHysteresisMs = msFromKnots(out.gustHysteresisKnots);
  }
  return out;
}

/**
 * Normalizes a wind/hydro generator config's wind/water-speed thresholds
 * from the schema's knots keys to the engine's canonical m/s. Accepts
 * either `*Knots` (schema/tests) or pre-converted `*Ms` keys; `*Ms` wins.
 * @param {object} g - Generator config
 * @returns {object} Config with `maxWindMs` / `startupSpeedMs` /
 *          `minSpeedMs` / `maxSpeedMs` set
 */
function normalizeGeneratorWindConfig(g) {
  const out = { ...g };
  if (out.maxWindMs == null && out.maxWindKnots != null) {
    out.maxWindMs = msFromKnots(out.maxWindKnots);
  }
  if (out.startupSpeedMs == null && out.startupSpeedKnots != null) {
    out.startupSpeedMs = msFromKnots(out.startupSpeedKnots);
  }
  if (out.minSpeedMs == null && out.minSpeedKnots != null) {
    out.minSpeedMs = msFromKnots(out.minSpeedKnots);
  }
  if (out.maxSpeedMs == null && out.maxSpeedKnots != null) {
    out.maxSpeedMs = msFromKnots(out.maxSpeedKnots);
  }
  // Manufacturer curves are also knot-calibrated in the schema; convert the
  // speed axis to m/s so the engine's m/s wind values land on the right
  // interval. (Watts are unchanged.)
  if (Array.isArray(out.curve)) {
    out.curve = out.curve.map((pt) => ({
      speed: msFromKnots(pt.speed),
      watts: pt.watts,
    }));
  }
  return out;
}

/**
 * Prediction engine.
 */
class PredictionEngine {
  /**
   * @param {object} params
   * @param {object} params.battery - Battery configuration
   * @param {number} params.battery.capacityAh - Battery capacity in Ah
   * @param {number} params.battery.systemVoltage - System voltage in volts
   * @param {number} params.battery.minSafeSoC - Minimum safe SoC [0, 1]
   * @param {object[]} params.solarArrays - Solar array configurations
   * @param {object[]} params.mechanicalGenerators - Wind/hydro generator configurations
   * @param {object[]} [params.gensets] - Dedicated generators (diesel/DC
   *        generator, fuel cell) — tier-2 combustion sources (#11)
   * @param {object[]} [params.engines] - Propulsion engines — tier-3
   *        combustion sources (#11). Each `{id, name?, alternatorWatts}`;
   *        ids are Signal K propulsion instance names ("main", "port",
   *        "starboard", …). An engine with `alternatorWatts` 0 (electric
   *        drive, no alternator) is a consumer, never a generator
   * @param {() => (boolean|null)} [params.getEngineRunning] - Dynamic
   *        engine-running detector (scans all propulsion instances,
   *        whatever their names); wins over configured-engine probing
   * @param {object} [params.combustionConfig] - Per-tier reluctance settings
   *        (`{genset: {...}, engine: {...}}`); see plugin/combustion.js
   * @param {(arrayId: string, isSailing: boolean, azimuth: number, elevation: number, awa?: number) => number} getEfficiency - Function to get efficiency from learning matrix
   * @param {(path: string) => unknown} getSelfPath - Function to read Signal K values
   * @param {(forecastSpeedMs: number, forecastGustMs: number|null, windDirectionDeg: number, sunElevationRad: number) => {speed: number, gust: number}|null} [params.getWindProtection] -
   *   Returns the WPF-corrected wind/gusts at device height for the current
   *   place, or null for "no correction" (under way, unknown place, or no
   *   learned factor). When null, the forecast values pass through unchanged.
   * @param {number} [params.predictionHours] - Prediction horizon in hours
   *   (24–168; from `weather.forecastHours`, defaults to 24)
   */
  constructor({
    battery,
    solarArrays,
    mechanicalGenerators,
    gensets,
    engines,
    combustionConfig,
    getEngineRunning,
    getObservedGustMs,
    getEfficiency,
    getSelfPath,
    getWindProtection,
    getDisplayName,
    app,
    loadProfileConfig,
    windProtectionConfig,
    predictionHours,
  }) {
    this.battery = battery;
    // Config thresholds come from the schema in knots (sailor-friendly).
    // Normalize them to the engine's canonical m/s here so every internal
    // consumer reads `*Ms` and never has to re-convert. Accepts either the
    // legacy `*Knots` keys (schema/tests) or pre-converted `*Ms` keys.
    this.solarArrays = (solarArrays || []).map(normalizeArrayWindConfig);
    this.mechanicalGenerators = (mechanicalGenerators || []).map(
      normalizeGeneratorWindConfig,
    );
    // Combustion sources (#11): gensets (tier 2) and the main engine
    // (tier 3) are deployable generators with per-tier reluctance
    // settings. "deployed" means running.
    this.gensets = (gensets || []).filter(
      (g) => g && typeof g.outputWatts === "number" && g.outputWatts > 0,
    );
    // Engines are propulsion first: arbitrary Signal K instance names
    // ("main", "port", "starboard", …), 0+ per vessel. An engine only
    // counts as a generator when its alternatorWatts > 0 — electric
    // drives and alternator-less engines are consumers, not chargers.
    this.engines = (engines || []).filter(
      (e) => e && typeof e.id === "string" && e.id !== "",
    );
    this.combustionSettings = {
      genset: resolveTierSettings("genset", combustionConfig?.genset),
      engine: resolveTierSettings("engine", combustionConfig?.engine),
    };
    /** Run-transition state per combustion source id: runningSince
     * (batching minimum-run accounting) and lastRunEnd (cooldown). */
    this.combustionRuns = new Map();
    this.getEfficiency = getEfficiency;
    this.getSelfPath = getSelfPath;
    // Observed (live) wind gust in m/s — reality overrides forecast for
    // the current-hour stow verdict (a real gust at the limit must drive
    // a "stow now" even when the forecast is calm).
    this.getObservedGustMs = getObservedGustMs || null;
    this.getWindProtection = getWindProtection || (() => null);
    this.windProtectionConfig = windProtectionConfig || {};
    this.getDisplayName =
      getDisplayName || ((config) => config.name || config.id);
    this.app = app;

    this.predictionHours = Math.min(
      MAX_PREDICTION_HOURS,
      Math.max(PREDICTION_HOURS, predictionHours ?? PREDICTION_HOURS),
    );

    this.capacityWh = battery.capacityAh * battery.systemVoltage;
    // Critical SoC threshold for the 24h energy outlook: LiFePO4 can be
    // drawn to 30% without harm, lead-acid should stay above ~50% (we use
    // 45% as the "will be critical" trip point). Chemistry comes from the
    // config schema; anything unrecognized falls back to LiFePO4.
    this.criticalSoC =
      battery.chemistry === "lead-acid"
        ? CRITICAL_SOC_LEAD_ACID
        : CRITICAL_SOC_LIFEPO4;
    this.loadProfile = new LoadProfile({
      config: loadProfileConfig,
      getSelfPath,
      app,
      engines: this.engines,
      getEngineRunning,
    });
    this.lastPrediction = [];
    /** Raw (pre-WPF) forecast from the last run, for publishing raw values */
    this.lastRawForecast = [];
    this.lastForecast = [];
  }

  /**
   * Updates the load profile with current house load.
   *
   * @returns {void}
   */
  /**
   * Updates the load profile with current house load.
   *
   * @returns {void}
   */
  /**
   * Sums the live power output of charging sources that flow through the
   * battery shunt but are NOT added back into `electrical.venus.dcPower`.
   *
   * The Victron Venus `dcPower` value is computed as `shunt + solar`, where
   * `shunt` is the net battery flow (positive when discharging to loads,
   * negative when charging from any source). Solar is added back because it
   * feeds the DC bus directly, but wind, hydro, and alternator charging also
   * flow through the shunt and are NOT added back — so when they produce,
   * `dcPower` understates (or goes negative for) real house consumption.
   *
   * True gross consumption (DC bus power balance) is:
   *   consumption = shunt + solar + wind + hydro + alternator
   *              = dcPower + wind + hydro + alternator
   *
   * So we add wind + hydro + alternator back to dcPower to reconstruct it.
   * These are the configured mechanical generators of type wind/hydro plus
   * the alternator input power path.
   *
   * @returns {number} Total uncounted charging output in watts
   */
  uncountedChargingW() {
    let w = 0;
    for (const gen of this.mechanicalGenerators) {
      // Hydro and wind charge via the battery shunt but Venus doesn't add
      // them back into dcPower (unlike solar), so they must be added here
      // to reconstruct gross consumption. Alternator is excluded: it only
      // produces while motoring, and those samples are gated as
      // engine-running before reaching the bins anyway.
      if (gen.type === "hydro" || gen.type === "wind") {
        const v = toNumber(this.getSelfPath(gen.powerPath));
        if (v != null) w += v;
      }
    }
    return w;
  }

  updateLoadProfile() {
    // Read consumption from Victron Venus.
    // dcPower = shunt + solar, so wind/hydro/alternator charging (which flow
    // through the shunt but aren't added back) make it understate real load.
    // Add those back to reconstruct gross house consumption.
    // acPower is AC consumption (inverter/shore), independent of the bus.
    const rawDc = this.getSelfPath("electrical.venus.dcPower");
    const rawAc = this.getSelfPath("electrical.venus.acPower");
    const dcPowerW = toNumber(rawDc);
    const acPowerW = toNumber(rawAc);
    const chargingW = this.uncountedChargingW();

    this.app?.debug?.(
      `updateLoadProfile: dcPower=${JSON.stringify(rawDc)} (${dcPowerW}), uncountedCharging=${chargingW}, gross=${dcPowerW != null ? dcPowerW + chargingW : null}, acPower=${JSON.stringify(rawAc)} (${acPowerW})`,
    );

    if (dcPowerW != null || acPowerW != null) {
      // Reconstruct gross DC consumption; clamp at 0 (a negative gross means
      // charging exceeded load, i.e. the battery was net charging, which is
      // not a consumption sample).
      const dc = Math.max(0, (dcPowerW ?? 0) + chargingW);
      const ac = Math.max(0, acPowerW ?? 0);

      // Get current position for sun phase classification. unwrapPosition
      // handles both the live deltaState form ({latitude, longitude}) and the
      // app.getSelfPath fallback form ({value: {latitude, longitude}}).
      const position = unwrapPosition(this.getSelfPath("navigation.position"));

      this.loadProfile.addSample(dc, ac, position);
    }
  }

  /**
   * Gets the current apparent wind angle.
   *
   * @returns {number|null} AWA in radians
   */
  getAWA() {
    return toNumber(this.getSelfPath("environment.wind.angleApparent"));
  }

  /**
   * Gets the current speed through water.
   *
   * @returns {number|null} Speed in m/s
   */
  getSpeedThroughWater() {
    return toMs(this.getSelfPath("navigation.speedThroughWater"));
  }

  /**
   * Gets the current true heading in radians.
   * Signal K heading is in radians (0 = north, positive clockwise).
   * @returns {number|null} Heading in radians, or null if unavailable
   */
  getHeadingTrue() {
    const h = this.getSelfPath("navigation.headingTrue");
    const val = toNumber(h);
    if (val == null || isNaN(val)) return null;
    // Normalize to [-π, π)
    let heading = val;
    while (heading >= Math.PI) heading -= 2 * Math.PI;
    while (heading < -Math.PI) heading += 2 * Math.PI;
    return heading;
  }

  /**
   * Gets the current navigation state.
   * @returns {string} One of: sailing, motoring, anchored, moored, under way, unknown
   */
  getNavState() {
    const state = this.getSelfPath("navigation.state");
    // Signal K may deliver either a bare string (from deltaState) or a
    // wrapped value object (from app.getSelfPath). Unwrap and coerce:
    // an empty string or null/undefined means "no state known".
    const v = state && typeof state === "object" ? state.value : state;
    return v || "unknown";
  }

  /**
   * Determines if the vessel is under way (sailing, motoring, or under way).
   * @returns {boolean}
   */
  isUnderway() {
    const state = this.getNavState();
    return ["sailing", "motoring", "under way"].includes(state);
  }

  /**
   * Gets the current gust speed from forecast (first forecast point near now).
   * @returns {number|null} Gust speed in m/s
   */
  getCurrentGustMs() {
    if (this.lastPrediction.length === 0) return null;
    const now = new Date();
    const current = this.lastPrediction.find(
      (p) => Math.abs(p.time.getTime() - now.getTime()) < 1800000,
    );
    return current?.gustSpeedMs ?? null;
  }

  /**
   * Gets the current wind speed from forecast (first forecast point near now).
   * @returns {number|null} Wind speed in m/s
   */
  getCurrentWindMs() {
    if (this.lastPrediction.length === 0) return null;
    const now = new Date();
    const current = this.lastPrediction.find(
      (p) => Math.abs(p.time.getTime() - now.getTime()) < 1800000,
    );
    return current?.windSpeedMs ?? null;
  }

  /**
   * Gets the maximum forecast gust over the prediction window.
   * @returns {number} Max gust in m/s
   */
  getMaxForecastGust() {
    return this.lastPrediction.reduce((max, p) => {
      return Math.max(max, p.gustSpeedMs ?? 0);
    }, 0);
  }

  /**
   * Gets the maximum forecast wind speed over the prediction window.
   * @returns {number} Max wind speed in m/s
   */
  getMaxForecastWind() {
    return this.lastPrediction.reduce((max, p) => {
      return Math.max(max, p.windSpeedMs ?? 0);
    }, 0);
  }

  /**
   * Applies the Wind Protection Factor to a single forecast point, returning
   * a copy with wind/gusts corrected for the current place.
   *
   * At rest at a learned place, the forecast wind speed and gust are scaled
   * by the learned factor (per place and wind-direction sector; gusts also
   * per day/night) at the 10 m reference, then translated down to device
   * height. Under way, unknown place, missing position, or unlearned bins,
   * the point passes through unchanged.
   *
   * Wind direction is preserved as-is: the WPF factor is selected *by*
   * direction but does not rotate it.
   *
   * @param {object} fp - Forecast point with time/windSpeedMs/gustSpeedMs/windDirectionDeg
   * @param {number} latitude - Vessel latitude (degrees)
   * @param {number} longitude - Vessel longitude (degrees)
   * @returns {object} Corrected forecast point (shallow copy)
   */
  applyWindProtection(fp, latitude, longitude) {
    const rawSpeed = fp.windSpeedMs ?? null;
    const rawGust = fp.gustSpeedMs ?? null;
    const dirDeg = fp.windDirectionDeg ?? null;

    if (
      rawSpeed == null ||
      dirDeg == null ||
      latitude == null ||
      longitude == null
    ) {
      return fp;
    }

    const { sunPosition } = require("./solar.js");
    const sunPos = sunPosition(fp.time, latitude, longitude);
    const corrected = this.getWindProtection(
      rawSpeed,
      rawGust,
      dirDeg,
      sunPos.altitude,
    );
    if (!corrected) {
      return fp;
    }

    return {
      ...fp,
      windSpeedMs: corrected.speed,
      gustSpeedMs: corrected.gust ?? rawGust,
    };
  }

  /**
   * Computes the potential 24h yield (in Wh) for a deployable device if it were deployed.
   * Uses the last forecast and prediction data.
   *
   * @param {string} deviceId - Device ID
   * @returns {number} Potential yield in watt-hours over the prediction window
   */
  getPotentialYieldWh(deviceId) {
    if (this.lastForecast.length === 0) return 0;

    const array = this.solarArrays.find((a) => a.id === deviceId);
    if (array && array.type === "deployable") {
      const pos = this.getSelfPath("navigation.position");
      const lat = pos?.latitude ?? 0;
      const lon = pos?.longitude ?? 0;
      let total = 0;
      for (const point of this.lastForecast) {
        const time = new Date(
          point.time.getTime
            ? point.time.getTime()
            : new Date(point.time).getTime(),
        );
        const sunPos = sunPosition(time, lat, lon);
        const ghi = point.ghi ?? 0;
        const windGustMs = point.gustSpeedMs ?? 0;
        const efficiency = this.getEfficiency(
          array.id,
          false,
          sunPos.azimuth,
          sunPos.altitude,
        );
        total += predictSolarHour({
          array,
          sunPosition: sunPos,
          ghi,
          windGustMs,
          efficiency,
        });
      }
      return Math.round(total);
    }

    const generator = this.mechanicalGenerators.find((g) => g.id === deviceId);
    if (generator) {
      let total = 0;
      const navState = this.getNavState();
      const isSailing = navState === "sailing";
      const speedThroughWater = this.getSpeedThroughWater() ?? 0;
      for (const point of this.lastForecast) {
        if (generator.type === "wind") {
          const windSpeedMs = point.windSpeedMs ?? 0;
          const gustSpeedMs = point.gustSpeedMs ?? 0;
          total += predictWindHour({
            generator,
            windSpeedMs,
            gustSpeedMs,
            isSailing,
            navState,
          });
        } else if (generator.type === "hydro") {
          total += predictHydroHour({
            generator,
            speedThroughWaterMs: speedThroughWater,
            isSailing,
          });
        }
      }
      return Math.round(total);
    }

    return 0;
  }

  /**
   * Whether the battery is projected to reach full (100% SoC) over the
   * prediction horizon using only solar and hydro yield — i.e. without
   * any deployable wind generator. When this is true, deploying a wind
   * generator adds no useful energy: solar already covers the load and
   * charges the bank to full, so the wind gen recommendation is suppressed
   * (recommend stow instead) to save the crew a deck trip for nothing.
   *
   * This is the recommendation-side companion to the urgency model's
   * reluctance gate: reluctance asks "is it worth the effort *if we need
   * the energy*"; this asks "do we even need the energy."
   *
   * @returns {boolean} True if solar+hydro alone fill the battery during
   *          the horizon.
   */
  wouldSolarFillBattery() {
    if (this.lastPrediction.length === 0) return false;
    const startSoC = this.lastPrediction[0].idealSoC;
    if (startSoC == null) return false;
    let soc = startSoC;
    for (const p of this.lastPrediction) {
      const netWithoutWind =
        (p.idealSolarYieldWh || 0) +
        (p.idealHydroYieldWh || 0) -
        (p.houseLoadWh || 0);
      if (this.capacityWh > 0) {
        soc = Math.max(0, Math.min(1, soc + netWithoutWind / this.capacityWh));
      }
      if (soc >= 1) return true;
    }
    return false;
  }

  /**
   * How many consecutive forecast hours a deployable source would produce
   * good output starting from the current hour — the "good-output window"
   * length. This feeds the urgency model's duration gate: a deploy
   * suggestion is only worth acting on if the forecast offers a long enough
   * window (1h for hydro, ~2h for FLINsail, 8h+ for a wind generator).
   *
   * For a wind generator, "good output" means wind ≥ startup speed and
   * gusts below the max. For a deployable solar array (FLINsail), it means
   * the sun is up and gusts are below the limit. The count starts from the
   * current hour and continues while conditions hold; a later lull ends
   * the window (we don't skip gaps — a discontinuous window isn't a single
   * good-output run the crew can plan a deck trip around).
   *
   * @param {string} deviceId - Device ID
   * @returns {number} Consecutive good-output hours from now (0 if none)
   */
  getGoodOutputHours(deviceId) {
    if (this.lastForecast.length === 0) return 0;
    const generator = this.mechanicalGenerators.find((g) => g.id === deviceId);
    const array = this.solarArrays.find((a) => a.id === deviceId);

    if (generator && generator.type === "wind") {
      const maxWindMs = generator.maxWindMs ?? msFromKnots(30);
      const minDeployWind = generator.startupSpeedMs ?? msFromKnots(5);
      let hours = 0;
      for (const point of this.lastForecast) {
        const gust = point.gustSpeedMs ?? null;
        const wind = point.windSpeedMs ?? null;
        if (
          wind != null &&
          wind >= minDeployWind &&
          (gust == null || gust < maxWindMs)
        ) {
          hours++;
        } else {
          break;
        }
      }
      return hours;
    }

    if (array && array.type === "deployable") {
      const gustLimit = array.gustLimitMs ?? msFromKnots(20);
      const pos = this.getSelfPath("navigation.position");
      const lat = pos?.latitude ?? 0;
      const lon = pos?.longitude ?? 0;
      let hours = 0;
      for (const point of this.lastForecast) {
        const t = new Date(point.time);
        const gust = point.gustSpeedMs ?? 0;
        const { altitude } = sunPosition(t, lat, lon);
        if (altitude > 0 && gust < gustLimit) {
          hours++;
        } else {
          break;
        }
      }
      return hours;
    }

    // Hydro: good output while there's boat speed. Count hours with
    // speedThroughWater above the generator's startup (default 0).
    if (generator && generator.type === "hydro") {
      const minSpeed = generator.startupSpeedMs ?? 0;
      let hours = 0;
      for (const point of this.lastForecast) {
        // Forecast doesn't carry speedThroughWater; use the current
        // reading as a proxy for the near-term window.
        const speed = this.getSpeedThroughWater() ?? 0;
        if (speed >= minSpeed) {
          hours++;
        } else {
          break;
        }
      }
      return hours;
    }

    return 0;
  }

  /**
   * Computes a pointing recommendation (port/starboard) for a deployable solar array.
   *
   * During daytime (sun above horizon), side is based on the sun's current
   * azimuth relative to the boat's heading. After sunset, it targets the next
   * sunrise so the crew can set the sail overnight for first light.
   *
   * For the morning case, an anchored boat's predicted heading at sunrise
   * is estimated from the forecast wind direction (the bow swings into the
   * wind). A moored boat keeps a fixed heading, so its current heading is
   * used instead. Falls back to current heading if no wind direction forecast
   * is available.
   *
   * @param {object} _array - Solar array config (must be type "deployable")
   * @returns {{side: string|null, targetTime: string|null, reason: string|null}|null}
   */
  getPointingRecommendation(_array) {
    const pos = this.getSelfPath("navigation.position");
    const lat = pos?.latitude;
    const lon = pos?.longitude;
    if (lat == null || lon == null) {
      return { side: null, targetTime: null, reason: "No GPS position" };
    }

    const now = new Date(Date.now());
    const sunPos = sunPosition(now, lat, lon);

    // Threshold: altitude > ~1° → daytime; ≤ 0° → morning; (0°, 1°] ambiguous → day
    const DAYTIME_THRESHOLD = 0.0175; // ~1 degree in radians

    // Sun above ~1° → clear daytime; ≤ 0° → morning; (0°, 1°] ambiguous → day
    if (sunPos.altitude > DAYTIME_THRESHOLD) {
      // Daytime: use current heading
      const heading = this.getHeadingTrue();
      if (heading == null) {
        return {
          side: null,
          targetTime: null,
          reason: "No heading — cannot determine side",
        };
      }
      const rel = normalizeAngle(sunPos.azimuth - heading);
      const side = rel > 0 ? "starboard" : rel < 0 ? "port" : null;
      if (side == null) {
        return {
          side: null,
          targetTime: now.toISOString(),
          reason: "Sun near dead ahead/astern, no side preference",
        };
      }
      return {
        side,
        targetTime: now.toISOString(),
        reason: `Point ${side}, sun at ${formatBearing(sunPos.azimuth)}`,
      };
    }

    // Morning: compute next sunrise
    const sunrise = nextSunrise(now, lat, lon);
    if (!sunrise) {
      return {
        side: null,
        targetTime: null,
        reason: "No sunrise in near future",
      };
    }
    // Render the sunrise instant in solar-local time (the crew's clock),
    // not the server's host timezone or UTC. We have lon in scope here.
    const sunriseLocal = formatLocalHHMM(
      sunrise,
      solarOffsetMinutesFromLongitude(lon),
    );
    const sunrisePos = sunPosition(sunrise, lat, lon);

    // For anchored boats, the bow swings into the wind, so predict the
    // heading at sunrise from the forecast wind direction (direction the
    // wind comes from = where the bow points). Moored boats are tied to a
    // fixed heading that will not change, so use the current heading instead.
    const navState = this.getNavState();
    let predictedHeading;
    if (navState === "anchored") {
      predictedHeading = this.getForecastWindDirectionAt(sunrise);
    }
    if (predictedHeading == null) {
      predictedHeading = this.getHeadingTrue();
    }
    if (predictedHeading == null) {
      return {
        side: null,
        targetTime: sunrise.toISOString(),
        reason: `No heading — cannot determine side for morning (sunrise ${sunriseLocal})`,
      };
    }

    const rel = normalizeAngle(sunrisePos.azimuth - predictedHeading);
    const side = rel > 0 ? "starboard" : rel < 0 ? "port" : null;
    if (side == null) {
      return {
        side: null,
        targetTime: sunrise.toISOString(),
        reason: `Sun rises near dead ahead/astern, no side preference (${sunriseLocal})`,
      };
    }
    return {
      side,
      targetTime: sunrise.toISOString(),
      reason: `Point ${side} for morning, sun rises ${sunriseLocal}`,
    };
  }

  /**
   * Gets the forecast wind direction (radians, true-north) nearest the given time.
   * @param {Date} time - Target time
   * @returns {number|null} Wind direction in radians, or null if not available
   */
  getForecastWindDirectionAt(time) {
    if (this.lastForecast.length === 0) return null;
    const nearest = this.lastForecast.reduce((best, p) => {
      const dt = Math.abs(
        (p.time instanceof Date ? p.time : new Date(p.time)).getTime() -
          time.getTime(),
      );
      if (!best || dt < best.dt) {
        return { dt, point: p };
      }
      return best;
    }, null);
    const dirDeg = nearest?.point?.windDirectionDeg;
    if (dirDeg == null) return null;
    return (dirDeg * Math.PI) / 180; // degrees → radians
  }

  /**
   * Scans the forecast for when a deployable device's recommendation would flip.
   *
   * For FLINsail and wind generators, the deciding factor is forecast gusts vs
   * the gust/wind limit. For wind generators deployed, we also watch for wind
   * dropping below startup speed. Returns the first forecast time when the
   * state would differ from the current recommendation, or null if it stays
   * the same through the forecast window.
   *
   * Not applicable to hydro generators (depends on boat speed, not forecast)
   * or underway/not-sailing cases (depends on nav state, not forecast).
   *
   * @param {string} id - Device ID
   * @param {string} currentState - Current recommended state ("deployed"/"stowed")
   * @returns {string|null} ISO timestamp when state would change, or null
   */
  getRecommendedStateChangeTime(id, currentState) {
    if (this.lastForecast.length === 0) return null;

    const array = this.solarArrays.find((a) => a.id === id);
    const generator = this.mechanicalGenerators.find((g) => g.id === id);

    // FLINsail (deployable solar): gust limit is the deciding factor.
    // Night-time changes shift to sun boundaries (stow → sunset, deploy → sunrise)
    if (array && array.type === "deployable") {
      const gustLimit = array.gustLimitMs ?? msFromKnots(20);
      const pos = this.getSelfPath("navigation.position");
      const lat = pos?.latitude;
      const lon = pos?.longitude;
      for (const point of this.lastForecast) {
        const gust = point.gustSpeedMs ?? null;
        // A missing forecast (null gust) is not evidence of calm: skip it
        // rather than triggering a fabricated stow.
        if (gust == null) continue;
        // `currentState` is the recommendation direction. We want the time
        // of the trigger that *motivates* that recommendation, so the
        // published `recommendedStateTime` (and the urgency `hoursUntil`)
        // answer "by when must the crew act", not "when can they undo it":
        //  - recommending "deployed": the next stow trigger — "deploy now,
        //    you'll need to stow at X".
        //  - recommending "stowed": the stow trigger — "stow by X". The
        //    redeploy time is a separate concern and not exposed here;
        //    surfacing it would mislead urgency into thinking the action
        //    is far off when it's actually due now/tonight.
        const wouldStow = gust >= gustLimit;
        let changeTime = null;
        if (wouldStow) {
          changeTime = point.time;
        }
        if (changeTime) {
          const t =
            changeTime instanceof Date ? changeTime : new Date(changeTime);
          if (lat != null && lon != null) {
            const { altitude } = sunPosition(t, lat, lon);
            if (altitude <= 0) {
              // Stow trigger at night: report at the preceding sunset
              // ("stow before dark, not at 2 AM") for both recommendation
              // directions, since the motivating trigger is a stow in
              // both cases. Clamped to now, so a trigger already past
              // reads as "act now".
              const target = lastSunset(t, lat, lon);
              if (target) {
                const clamped = new Date(
                  Math.max(target.getTime(), Date.now()),
                );
                return this.toISOString(clamped);
              }
            }
          }
          return this.toISOString(t);
        }
      }
      return null;
    }

    // Wind generators: gust limit (stow) and startup speed (too low to deploy)
    if (generator && generator.type === "wind") {
      const maxWindMs = generator.maxWindMs ?? msFromKnots(30);
      const minDeployWind = generator.startupSpeedMs ?? msFromKnots(5);
      for (const point of this.lastForecast) {
        const gust = point.gustSpeedMs ?? null;
        const wind = point.windSpeedMs ?? null;
        // A missing forecast is not evidence of calm: skip it.
        if (gust == null && wind == null) continue;
        if (currentState === "deployed") {
          // Would stow if gusts exceed limit
          if (gust != null && gust >= maxWindMs) {
            return this.toISOString(point.time);
          }
        } else if (currentState === "stowed") {
          // Would deploy if wind ≥ startup and gusts < limit
          if (
            wind != null &&
            wind >= minDeployWind &&
            (gust == null || gust < maxWindMs)
          ) {
            return this.toISOString(point.time);
          }
        }
      }
      return null;
    }

    return null;
  }

  /**
   * Converts a Date or date-like value to ISO string.
   * @param {Date|string|number} time - Time value
   * @returns {string|null} ISO string, or null if invalid
   */
  toISOString(time) {
    const d = time instanceof Date ? time : new Date(time);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  /**
   * Computes per-hour ideal states for deployable solar arrays with
   * sunrise/sunset-aware night handling.
   *
   * Day hours: deployed iff gusts are below the array's gust limit.
   * Night hours: stowed if any hour of the night block has gusts at/above
   * the limit (the sail should be secured before dark); otherwise the state
   * carries over from the previous day - deploying at night gains nothing,
   * so no state flip happens until sunrise.
   *
   * @param {Array<{time: Date, gustSpeedMs: number|null}>} forecast - Weather forecast
   * @param {number} latitude - Latitude in degrees
   * @param {number} longitude - Longitude in degrees
   * @param {Date} startTime - First hour bucket time
   * @param {number} hours - Number of hourly buckets
   * @param {boolean} underway - Whether vessel is under way
   * @returns {Array<Map<string, {state: string, reason: string}>>} Per-hour states per array ID
   */
  computeDeployableSolarStates(
    forecast,
    latitude,
    longitude,
    startTime,
    hours,
    underway,
  ) {
    const deployable = this.solarArrays.filter((a) => a.type === "deployable");
    if (deployable.length === 0) return [];

    // Per-hour sun altitude and matched forecast gust. A null gust means
    // no forecast point covers that hour (beyond the horizon or a gap):
    // it must NOT be treated as calm (0 kn), otherwise the array would
    // be recommended to deploy on a fabricated windless day. Downstream
    // logic carries the previous state forward across such hours.
    const hourInfo = [];
    for (let h = 0; h < hours; h++) {
      const time = new Date(startTime.getTime() + h * 3600000);
      const { altitude } = sunPosition(time, latitude, longitude);
      const fp = forecast.find(
        (p) =>
          Math.abs(
            (p.time instanceof Date
              ? p.time.getTime()
              : new Date(p.time).getTime()) - time.getTime(),
          ) < 1800000,
      );
      hourInfo.push({
        time,
        isNight: altitude <= 0,
        hasForecast: fp != null,
        gust: fp?.gustSpeedMs ?? null,
      });
    }

    // Annotate each night hour with its night block's max gust. Hours
    // without a forecast point (null gust) are skipped — a missing forecast
    // must not count as a calm night (which would wrongly deploy).
    const nightBlockMax = new Array(hours).fill(null);
    let blockStart = -1;
    let blockMax = null; // null = no forecast seen yet in this block
    const flushBlock = (end) => {
      if (blockStart >= 0) {
        for (let i = blockStart; i < end; i++) nightBlockMax[i] = blockMax;
      }
      blockStart = -1;
      blockMax = null;
    };
    for (let h = 0; h < hours; h++) {
      if (hourInfo[h].isNight) {
        if (blockStart < 0) {
          blockStart = h;
          blockMax = null;
        }
        const g = hourInfo[h].gust;
        if (g != null) {
          blockMax = blockMax == null ? g : Math.max(blockMax, g);
        }
      } else {
        flushBlock(h);
      }
    }
    flushBlock(hours);

    // Per-hour states, carrying the previous state through gust-free nights
    const result = [];
    const prevState = new Map();
    for (let h = 0; h < hours; h++) {
      const info = hourInfo[h];
      const states = new Map();
      for (const array of deployable) {
        const gustLimit = array.gustLimitMs ?? msFromKnots(20);
        const hysteresis = array.gustHysteresisMs ?? msFromKnots(2);
        // Hysteresis: once stowed, only redeploy when gusts drop below
        // (limit - hysteresis). This prevents flapping when the forecast
        // hovers right at the limit (e.g. 19.8 / 20.2 / 19.8 alternating).
        const prev = prevState.get(array.id) ?? "deployed";
        const deployThreshold = gustLimit - hysteresis;
        let state;
        let reason;
        if (underway) {
          state = "stowed";
          reason = "vessel under way";
        } else if (!info.hasForecast) {
          // No forecast point covers this hour (beyond the horizon or a
          // gap). Do not fabricate a calm-day deploy: carry the previous
          // state forward with a neutral reason so no misleading gust
          // figure is reported.
          state = prev;
          reason = "no forecast for this hour";
        } else if (info.isNight) {
          const nightMax = nightBlockMax[h] ?? 0;
          if (nightMax >= gustLimit) {
            state = "stowed";
            reason = `forecast night gusts up to ${Math.round(nightMax * MS_TO_KN)}kn ≥ limit ${Math.round(gustLimit * MS_TO_KN)}kn`;
          } else if (prev === "stowed" && nightMax >= deployThreshold) {
            // Gusts dropped below the stow limit but not by the full
            // hysteresis: stay stowed for the rest of the night
            state = "stowed";
            reason = `forecast night gusts ${Math.round(nightMax * MS_TO_KN)}kn within hysteresis of limit ${Math.round(gustLimit * MS_TO_KN)}kn`;
          } else {
            // No night gust risk: keep the previous state until sunrise
            state = prevState.get(array.id) ?? "deployed";
            reason = "no night gusts";
          }
        } else if (info.gust == null) {
          // Forecast point exists but carries no gust value: do not
          // treat as calm. Carry the previous state forward.
          state = prev;
          reason = "forecast gust unavailable";
        } else if (info.gust >= gustLimit) {
          state = "stowed";
          reason = `forecast gusts ${Math.round(info.gust * MS_TO_KN)}kn ≥ limit ${Math.round(gustLimit * MS_TO_KN)}kn`;
        } else if (prev === "stowed" && info.gust >= deployThreshold) {
          // Daytime: gusts dropped below the stow limit but not by the full
          // hysteresis: stay stowed to avoid flapping
          state = "stowed";
          reason = `forecast gusts ${Math.round(info.gust * MS_TO_KN)}kn within hysteresis of limit ${Math.round(gustLimit * MS_TO_KN)}kn`;
        } else {
          state = "deployed";
          reason = `forecast gusts ${Math.round(info.gust * MS_TO_KN)}kn < limit ${Math.round(gustLimit * MS_TO_KN)}kn`;
        }
        states.set(array.id, { state, reason });
        prevState.set(array.id, state);
      }
      result.push(states);
    }
    return result;
  }

  /**
   * Computes per-device deploy/stow actions for a given hour's conditions.
   *
   * Each action is:
   * - `ideal`: what the device should be ("deploy"/"stow"/"stay") based on
   *   this hour's forecast conditions.
   * - `detected`: what action is needed to close the gap between the detected
   *   state and the ideal state ("deploy"/"stow"/"stay"/null if unknown).
   *
   * @param {number} gustMs - Gust speed in m/s for this hour
   * @param {number} windMs - Wind speed in m/s for this hour
   * @param {boolean} underway - Whether vessel is under way this hour
   * @param {boolean} isSailing - Whether vessel is sailing this hour
   * @param {number|null} speedThroughWaterMs - Boat speed in m/s
   * @param {Map<string, string|null>} [detectedDeployStates] - Detected states
   * @param {Map<string, {state: string, reason: string}>} [solarStates] - Precomputed
   *        deployable solar states for this hour (from computeDeployableSolarStates)
   * @param {string} [navState] - Navigation state (anchored/moored/...)
   * @returns {Array<{id: string, type: string, idealState: string, idealAction: string, detectedAction: string|null, reason: string}>}
   */
  getHourlyActions(
    gustMs,
    windMs,
    underway,
    isSailing,
    speedThroughWaterMs,
    detectedDeployStates,
    solarStates,
    navState = "unknown",
  ) {
    const actions = [];

    // Deployable solar arrays (FLINsail) - states precomputed with
    // sunrise/sunset-aware night handling
    for (const array of this.solarArrays) {
      if (array.type !== "deployable") continue;
      const s = solarStates?.get(array.id) ?? {
        state: "deployed",
        reason: "",
      };
      const idealState = s.state;
      const reason = s.reason;
      const idealAction = idealState === "deployed" ? "deploy" : "stow";
      const detectedState = detectedDeployStates?.get(array.id) ?? null;
      const detectedAction =
        detectedState == null
          ? null
          : detectedState === idealState
            ? "stay"
            : idealState === "deployed"
              ? "deploy"
              : "stow";
      actions.push({
        id: array.id,
        type: "solar-deployable",
        idealState,
        idealAction,
        detectedAction,
        reason,
      });
    }

    // Mechanical generators
    for (const generator of this.mechanicalGenerators) {
      if (!generator.deployable) continue;
      let idealState;
      let reason;
      if (generator.type === "wind") {
        const maxWindMs = generator.maxWindMs ?? msFromKnots(30);
        const minDeployWind = generator.startupSpeedMs ?? msFromKnots(5);
        // User-facing reasons render knots (sailors read knots); the engine
        // works in m/s, so convert at this display boundary.
        const maxWindKn = maxWindMs * MS_TO_KN;
        const minDeployWindKn = minDeployWind * MS_TO_KN;
        const gustKn = gustMs != null ? gustMs * MS_TO_KN : null;
        const windKn = windMs != null ? windMs * MS_TO_KN : null;
        if (underway) {
          idealState = "stowed";
          reason = "vessel under way";
        } else {
          // Only deployed where the vessel can deploy (anchor, or mooring
          // when allowed). Unknown nav state -> stowed (conservative).
          const deployAtMoored = generator.deployableAtMoored !== false;
          const deployableHere =
            navState === "anchored" ||
            (navState === "moored" && deployAtMoored);
          if (!deployableHere) {
            idealState = "stowed";
            reason =
              navState === "unknown"
                ? "vessel nav state unknown"
                : `cannot deploy while ${navState}`;
          } else if (gustMs == null && windMs == null) {
            // No forecast point covers this hour (beyond the horizon or a
            // gap). Do not fabricate a calm-day stow/deploy: carry the
            // previous state forward with a neutral reason.
            idealState = "deployed"; // carry-forward handled by caller's prevIdealStates
            reason = "no forecast for this hour";
          } else if (gustMs != null && gustMs >= maxWindMs) {
            idealState = "stowed";
            reason = `forecast gusts ${Math.round(gustKn)}kn ≥ limit ${Math.round(maxWindKn)}kn`;
          } else if (windMs != null && windMs >= minDeployWind) {
            idealState = "deployed";
            reason = `forecast wind ${Math.round(windKn)}kn ≥ startup ${Math.round(minDeployWindKn)}kn`;
          } else {
            idealState = "stowed";
            reason =
              windMs != null
                ? `forecast wind ${Math.round(windKn)}kn < startup ${Math.round(minDeployWindKn)}kn`
                : "forecast wind unavailable";
          }
        }
      } else if (generator.type === "hydro") {
        const minSpeed = generator.minSpeedMs ?? msFromKnots(3);
        const maxSpeed = generator.maxSpeedMs ?? msFromKnots(12);
        const speed = speedThroughWaterMs ?? 0;
        // User-facing reasons render knots.
        const speedKn = speed * MS_TO_KN;
        const minSpeedKn = minSpeed * MS_TO_KN;
        const maxSpeedKn = maxSpeed * MS_TO_KN;
        if (!isSailing) {
          idealState = "stowed";
          reason = "not sailing";
        } else if (speed >= maxSpeed) {
          idealState = "stowed";
          reason = `boat speed ${speedKn.toFixed(1)}kn ≥ max ${maxSpeedKn.toFixed(1)}kn`;
        } else if (speed >= minSpeed) {
          idealState = "deployed";
          reason = `sailing ${speedKn.toFixed(1)}kn (min ${minSpeedKn.toFixed(1)}kn)`;
        } else {
          idealState = "stowed";
          reason = `sailing too slow (${speedKn.toFixed(1)}kn < ${minSpeedKn.toFixed(1)}kn)`;
        }
      } else {
        continue;
      }
      const idealAction = idealState === "deployed" ? "deploy" : "stow";
      const detectedState = detectedDeployStates?.get(generator.id) ?? null;
      const detectedAction =
        detectedState == null
          ? null
          : detectedState === idealState
            ? "stay"
            : idealState === "deployed"
              ? "deploy"
              : "stow";
      actions.push({
        id: generator.id,
        type: generator.type,
        idealState,
        idealAction,
        detectedAction,
        reason,
      });
    }

    return actions;
  }

  /**
   * Computes deployment recommendations for all deployable systems (FLINsail + generators).
   * Each recommendation says whether the device should be deployed or stowed, and why.
   *
   * @returns {Array<{id: string, name: string, type: string, recommendedState: string, reason: string, currentGustMs?: number, currentSpeedMs?: number, limitMs?: number}>}}
   */
  getDeploymentRecommendations() {
    const recommendations = [];
    const navState = this.getNavState();
    const underway = this.isUnderway();
    const isSailing = navState === "sailing";
    const speedThroughWater = this.getSpeedThroughWater() ?? 0;
    const maxGust = this.getMaxForecastGust();
    const maxWind = this.getMaxForecastWind();
    // Observed (live) gust overrides forecast for the current-hour stow
    // verdict: a real gust at or above the limit must drive a "stow now"
    // even when the forecast says it's calm. The forecast still governs
    // the *window* (tonight's worst) and the deploy/stow planning horizon.
    const observedGustMs = this.getObservedGustMs?.() ?? null;
    // Effective current gust for the stow verdict = the worse of observed
    // and the current forecast hour.
    const forecastCurrentGust = this.getCurrentGustMs() ?? 0;
    const effectiveCurrentGust =
      observedGustMs != null
        ? Math.max(observedGustMs, forecastCurrentGust)
        : forecastCurrentGust;

    // FLINsail (deployable solar arrays). The current recommendedState is
    // the *current hour's* ideal state (from computeDeployableSolarStates,
    // which uses the WPF-corrected current gust and the night-block max).
    //
    // The window is sized to cover the rest of the *current* night block
    // (until next sunrise), not the whole forecast: a night hour's verdict
    // must reflect the worst gust over the upcoming night (stow before dark
    // if any hour of tonight breaches the limit), but a gust in a *later*
    // night — after a full day — must NOT drive a "stow now". So if the
    // current hour is night, extend the window to the next sunrise; for a
    // daytime hour a single hour suffices (night-block logic only applies
    // to night hours). When the state should change later,
    // recommendedStateTime (computed below) carries the future timestamp.
    const startTime = this.lastPrediction[0].time;
    const recLat = this.getSelfPath("navigation.position")?.latitude ?? 0;
    const recLon = this.getSelfPath("navigation.position")?.longitude ?? 0;
    let currentHours = 1;
    const startSun = sunPosition(startTime, recLat, recLon);
    if (startSun.altitude <= 0) {
      // Current hour is night: include the rest of this night so the
      // night-block max captures tonight's worst gust. Cap at the
      // forecast horizon so we never scan beyond available data.
      const sunrise = nextSunrise(startTime, recLat, recLon);
      if (sunrise) {
        const untilSunrise = Math.ceil(
          (sunrise.getTime() - startTime.getTime()) / 3600000,
        );
        if (untilSunrise > currentHours) currentHours = untilSunrise;
      }
    }
    const currentSolarStates =
      this.lastPrediction.length > 0
        ? this.computeDeployableSolarStates(
            this.lastForecast,
            recLat,
            recLon,
            startTime,
            currentHours,
            underway,
          )
        : null;

    for (const array of this.solarArrays) {
      if (array.type !== "deployable") continue;

      const name = this.getDisplayName(array);
      const gustLimit = array.gustLimitMs ?? msFromKnots(20);
      // Observed gust overrides forecast for the stow verdict: a real gust
      // at/above the limit must read as "stow now" even if the forecast is
      // calm. computeDeployableSolarStates still uses the WPF-corrected
      // forecast for the night-block max, so we pass the effective current
      // gust into the fallback verdict below.
      const currentGust = effectiveCurrentGust;
      const observedOverLimit =
        observedGustMs != null && observedGustMs >= gustLimit;
      // User-facing reasons render knots (sailors read knots).
      const gustLimitKn = gustLimit * MS_TO_KN;
      const currentGustKn = currentGust * MS_TO_KN;

      if (underway) {
        // FLINsail is always stowed when underway
        recommendations.push({
          id: array.id,
          name,
          type: "solar-deployable",
          recommendedState: "stowed",
          reason: "vessel under way",
          currentGustMs: currentGust,
          limitMs: gustLimit,
          recommendedSide: null,
          recommendedSideTime: null,
        });
      } else {
        // Observed gusts at/above the limit override the forecast verdict:
        // reality beats forecast for a "stow now" safety call.
        if (observedOverLimit) {
          recommendations.push({
            id: array.id,
            name,
            type: "solar-deployable",
            recommendedState: "stowed",
            reason: `observed gusts ${Math.round(observedGustMs * MS_TO_KN)}kn ≥ limit ${Math.round(gustLimitKn)}kn`,
            currentGustMs: observedGustMs,
            limitMs: gustLimit,
            recommendedSide: null,
            recommendedSideTime: null,
          });
          continue;
        }
        // Current hour's ideal state (accounts for WPF + night block)
        const currentState =
          currentSolarStates?.[0]?.get(array.id) ??
          (currentGust >= gustLimit
            ? {
                state: "stowed",
                reason: `forecast gusts ${Math.round(currentGustKn)}kn ≥ limit ${Math.round(gustLimitKn)}kn`,
              }
            : {
                state: "deployed",
                reason: `forecast gusts ${Math.round(currentGustKn)}kn < limit ${Math.round(gustLimitKn)}kn`,
              });

        if (currentState.state === "stowed") {
          recommendations.push({
            id: array.id,
            name,
            type: "solar-deployable",
            recommendedState: "stowed",
            reason: currentState.reason,
            currentGustMs: currentGust,
            limitMs: gustLimit,
            recommendedSide: null,
            recommendedSideTime: null,
          });
        } else {
          // Deployed - compute pointing recommendation (port/starboard)
          const pointing = this.getPointingRecommendation(array);
          let reason =
            currentGust > 0
              ? `forecast gusts ${Math.round(currentGustKn)}kn below limit of ${Math.round(gustLimitKn)}kn`
              : "no significant gusts forecast";
          if (pointing) {
            if (pointing.side) {
              reason += `. ${pointing.reason}`;
            } else if (pointing.reason) {
              reason += `. ${pointing.reason}`;
            }
          }
          recommendations.push({
            id: array.id,
            name,
            type: "solar-deployable",
            recommendedState: "deployed",
            reason,
            currentGustMs: currentGust,
            limitMs: gustLimit,
            recommendedSide: pointing?.side ?? null,
            recommendedSideTime: pointing?.targetTime ?? null,
          });
        }
      }
    }

    // Mechanical generators
    for (const generator of this.mechanicalGenerators) {
      if (!generator.deployable) continue;

      const name = this.getDisplayName(generator);

      if (generator.type === "hydro") {
        const minSpeed = generator.minSpeedMs ?? msFromKnots(3);
        const maxSpeed = generator.maxSpeedMs ?? msFromKnots(12);
        // User-facing reasons render knots.
        const speedKn = speedThroughWater * MS_TO_KN;
        const minSpeedKn = minSpeed * MS_TO_KN;
        const maxSpeedKn = maxSpeed * MS_TO_KN;

        if (!isSailing) {
          // Hydro can only be deployed when sailing (not motoring)
          recommendations.push({
            id: generator.id,
            name,
            type: "hydro",
            recommendedState: "stowed",
            reason: underway
              ? `vessel ${navState}, hydro requires sailing`
              : "vessel not sailing",
          });
        } else if (speedThroughWater >= maxSpeed) {
          recommendations.push({
            id: generator.id,
            name,
            type: "hydro",
            recommendedState: "stowed",
            reason: `boat speed ${speedKn.toFixed(1)}kn exceeds limit of ${maxSpeedKn.toFixed(1)}kn`,
            currentSpeedMs: speedThroughWater,
            limitMs: maxSpeed,
          });
        } else if (speedThroughWater >= minSpeed) {
          recommendations.push({
            id: generator.id,
            name,
            type: "hydro",
            recommendedState: "deployed",
            reason: `sailing at ${speedKn.toFixed(1)}kn (min ${minSpeedKn.toFixed(1)}kn, max ${maxSpeedKn.toFixed(1)}kn)`,
            currentSpeedMs: speedThroughWater,
            limitMs: maxSpeed,
          });
        } else {
          recommendations.push({
            id: generator.id,
            name,
            type: "hydro",
            recommendedState: "stowed",
            reason: `sailing too slow (${speedKn.toFixed(1)}kn < ${minSpeedKn.toFixed(1)}kn)`,
            currentSpeedMs: speedThroughWater,
            limitMs: minSpeed,
          });
        }
      } else if (generator.type === "wind") {
        const maxWindMs = generator.maxWindMs ?? msFromKnots(30);
        const minDeployWind = generator.startupSpeedMs ?? msFromKnots(5);
        // User-facing reasons render knots.
        const maxWindKn = maxWindMs * MS_TO_KN;
        const minDeployWindKn = minDeployWind * MS_TO_KN;
        // Observed gust overrides the forecast max for the stow verdict: a
        // real gust at/above the limit must read as "stow now" even when
        // the forecast window stays under the limit.
        const observedOverLimit =
          observedGustMs != null && observedGustMs >= maxWindMs;
        const effectiveMaxGust =
          observedGustMs != null ? Math.max(observedGustMs, maxGust) : maxGust;
        const maxGustKn = effectiveMaxGust * MS_TO_KN;
        const maxWindValueKn = maxWind * MS_TO_KN;

        if (underway) {
          // Wind generators stowed when under way (like FLINsail)
          recommendations.push({
            id: generator.id,
            name,
            type: "wind",
            recommendedState: "stowed",
            reason: "vessel under way",
          });
        } else {
          // Deployable wind generators are only deployed where the
          // vessel can actually deploy them: at anchor, or at a mooring
          // when deployableAtMoored is set. Unknown nav state is treated
          // conservatively (stowed) so we don't advise deploying without
          // confirmation we are at anchor.
          const deployAtMoored = generator.deployableAtMoored !== false;
          const deployableHere =
            navState === "anchored" ||
            (navState === "moored" && deployAtMoored);
          if (!deployableHere) {
            recommendations.push({
              id: generator.id,
              name,
              type: "wind",
              recommendedState: "stowed",
              reason:
                navState === "unknown"
                  ? "vessel nav state unknown"
                  : `cannot deploy while ${navState}`,
            });
          } else if (effectiveMaxGust >= maxWindMs) {
            recommendations.push({
              id: generator.id,
              name,
              type: "wind",
              recommendedState: "stowed",
              reason: observedOverLimit
                ? `observed gusts ${Math.round(observedGustMs * MS_TO_KN)}kn ≥ limit of ${Math.round(maxWindKn)}kn`
                : `forecast gusts ${Math.round(maxGustKn)}kn exceed limit of ${Math.round(maxWindKn)}kn`,
              currentGustMs: effectiveMaxGust,
              limitMs: maxWindMs,
            });
          } else if (this.wouldSolarFillBattery()) {
            // Solar+hydro alone are projected to fill the battery —
            // deploying the wind gen adds no useful energy, so skip the
            // deck trip. Stow is the cheaper state (no drag, no wear).
            recommendations.push({
              id: generator.id,
              name,
              type: "wind",
              recommendedState: "stowed",
              reason: "solar already sufficient to fill the battery",
              currentGustMs: maxGust,
              limitMs: maxWindMs,
            });
          } else if (maxWind >= minDeployWind) {
            recommendations.push({
              id: generator.id,
              name,
              type: "wind",
              recommendedState: "deployed",
              reason: `forecast wind ${Math.round(maxWindValueKn)}kn (gusts ${Math.round(maxGustKn)}kn)`,
              currentGustMs: maxGust,
              limitMs: maxWindMs,
            });
          } else {
            recommendations.push({
              id: generator.id,
              name,
              type: "wind",
              recommendedState: "stowed",
              reason: `forecast wind too low (${Math.round(maxWindValueKn)}kn < ${Math.round(minDeployWindKn)}kn)`,
            });
          }
        }
      }
    }

    return recommendations.map((rec) => {
      const device =
        this.solarArrays.find((a) => a.id === rec.id) ||
        this.mechanicalGenerators.find((g) => g.id === rec.id);
      return {
        ...rec,
        horizonHours: this.predictionHours,
        missedYieldWh:
          rec.recommendedState === "deployed"
            ? this.getPotentialYieldWh(rec.id)
            : 0,
        recommendedStateTime: this.getRecommendedStateChangeTime(
          rec.id,
          rec.recommendedState,
        ),
        // Forecast good-output window (consecutive hours the source would
        // produce well from now). Feeds the urgency reluctance gate for
        // deploy suggestions: a short window caps at `low` for a
        // high-reluctance source. 0 for stow recommendations (not used).
        goodOutputHours:
          rec.recommendedState === "deployed"
            ? this.getGoodOutputHours(rec.id)
            : 0,
        // Per-device reluctance flows from the device config into urgency
        // (#11/#12 cross-ref). Falls back to undefined so the urgency
        // module's type-level default applies when unset.
        reluctance: device?.reluctance,
        // Per-device flip-cooldown override (#11): when set, widens the
        // deploy/stow hysteresis band for this renewable source beyond the
        // reluctance default. Used by AdvisoryPublisher to hold opposite
        // recommendation notifications during transient condition swings.
        flipCooldownHours: device?.flipCooldownHours,
      };
    });
  }

  /**
   * Computes deployment recommendations for the combustion sources
   * (#11): dedicated gensets (tier 2) and the propulsion engine(s) as a
   * high-reluctance deployable generator (tier 3). "Deployed" means
   * running.
   *
   * The tiers escalate independently at their own deficit thresholds
   * (the genset deploys at a lower sustained-violation bar than the main
   * engine), so a deficit first surfaces the genset, and only a deeper/
   * longer one escalates to the engine. Each tier recommends at most one
   * source — the most capable one available (largest output/alternator):
   * run the charger you have, not everything at once.
   *
   * Engines are propulsion first: only engines with `alternatorWatts > 0`
   * can be recommended as generators (electric drives and
   * alternator-less engines are consumers). Engine detection covers ALL
   * configured engines regardless — a running electric drive must gate
   * load learning and counts as a run for cooldown tracking.
   *
   * The returned recommendations ride the same deployment channel as
   * renewables (same shape, `type` "genset"/"engine", plus run window
   * fields), with combustion-specific fields: `tier` (2 genset / 3
   * engine), `watts`, `runHours`, `windowStart`, `windowEnd`.
   *
   * @param {object} [opts]
   * @param {Date} [opts.now=new Date()] - Current time (overridable for tests)
   * @returns {Array<{id: string, name: string, type: "genset"|"engine", tier: number, recommendedState: "deployed"|"stowed", reason: string, detectedState: "deployed"|"stowed"|null, watts: number, runHours: number|null, windowStart: Date|null, windowEnd: Date|null}>}
   */
  getCombustionRecommendations(opts = {}) {
    if (this.lastPrediction.length === 0) return [];
    const now = opts.now ?? new Date();
    const currentSoC = this.getCurrentSoC();

    // Night context for the engine tier's night hold (prefer waiting for
    // the morning solar window when the floor isn't breached before
    // sunrise). Computed from the vessel position; unknown position skips
    // the gate (no fabricated sun times).
    const position = unwrapPosition(this.getSelfPath("navigation.position"));
    let isNight = false;
    let sunrise = null;
    if (position && position.latitude != null) {
      const sunAlt = sunPosition(
        now,
        position.latitude,
        position.longitude ?? 0,
      ).altitude;
      isNight = sunAlt <= 0;
      sunrise = nextSunrise(now, position.latitude, position.longitude ?? 0);
    }

    // --- Detected states -------------------------------------------------
    // Gensets: state path or power-path detection. Engines: per-instance
    // propulsion detection (configured ids are the instance names).
    // Booleans normalize to the deployment vocabulary ("deployed" =
    // running) so the recs ride the same channel as renewables.
    const detected = new Map();
    for (const genset of this.gensets) {
      const running = resolveGensetRunning(genset, this.getSelfPath);
      detected.set(
        genset.id,
        running == null ? null : running ? "deployed" : "stowed",
      );
    }
    for (const engine of this.engines) {
      const running = detectEngineRunning(engine, this.getSelfPath);
      detected.set(
        engine.id,
        running == null ? null : running ? "deployed" : "stowed",
      );
    }

    // Track run transitions for batching/cooldown across cycles. Engines
    // started for propulsion count as runs too — frequent cold starts are
    // what the cooldown exists to avoid.
    updateCombustionRuns(this.combustionRuns, detected, now);

    const common = {
      track: this.lastPrediction,
      minSafeSoC: this.battery.minSafeSoC,
      capacityWh: this.capacityWh,
      currentSoC,
      now,
      isNight,
      sunrise,
    };

    const evaluateSource = (source, tier) => {
      const settings =
        tier === "genset"
          ? this.combustionSettings.genset
          : this.combustionSettings.engine;
      const run = this.combustionRuns.get(source.id) ?? {
        runningSince: null,
        lastRunEnd: null,
      };
      return evaluateCombustionTier({
        ...common,
        watts: source.outputWatts ?? source.alternatorWatts,
        settings,
        running: detected.get(source.id) === true,
        runningSince: run.runningSince,
        lastRunEnd: run.lastRunEnd,
      });
    };

    const recs = [];

    // --- Tier 2: gensets --------------------------------------------------
    // At most one run recommendation: the largest-output genset that
    // warrants a run. Other gensets still get state tracking above.
    const gensetCandidates = this.gensets
      .map((g) => ({ g, result: evaluateSource(g, "genset") }))
      .filter((x) => x.result != null)
      .sort((a, b) => (b.g.outputWatts || 0) - (a.g.outputWatts || 0));
    if (gensetCandidates.length > 0) {
      const { g, result } = gensetCandidates[0];
      recs.push({
        id: g.id,
        name: this.getDisplayName(g),
        type: "genset",
        tier: 2,
        recommendedState: result.recommendedState,
        reason: result.reason,
        detectedState: detected.get(g.id) ?? null,
        watts: g.outputWatts,
        runHours: result.runHours,
        windowStart: result.windowStart,
        windowEnd: result.windowEnd,
      });
    }

    // --- Tier 3: engines --------------------------------------------------
    // Only engines with an alternator can be generator candidates; the
    // strongest alternator wins the recommendation.
    const engineCandidates = this.engines
      .filter((e) => e.alternatorWatts > 0)
      .map((e) => ({ e, result: evaluateSource(e, "engine") }))
      .filter((x) => x.result != null)
      .sort((a, b) => b.e.alternatorWatts - a.e.alternatorWatts);
    if (engineCandidates.length > 0) {
      const { e, result } = engineCandidates[0];
      recs.push({
        id: e.id,
        name: this.getDisplayName(e),
        type: "engine",
        tier: 3,
        recommendedState: result.recommendedState,
        reason: result.reason,
        detectedState: detected.get(e.id) ?? null,
        watts: e.alternatorWatts,
        runHours: result.runHours,
        windowStart: result.windowStart,
        windowEnd: result.windowEnd,
      });
    }

    return recs;
  }

  /**
   * Gets the current battery SoC.
   *
   * @returns {number} SoC [0, 1]
   */
  getCurrentSoC() {
    let soc = this.getSelfPath(
      this.battery.socPath ||
        "electrical.batteries.house.capacity.stateOfCharge",
    );
    // Handle Signal K object-structured values
    if (soc && typeof soc === "object" && typeof soc.value === "number") {
      soc = soc.value;
    }
    return soc != null && !isNaN(soc) ? soc : 0.5;
  }

  /**
   * Runs the 24-hour prediction.
   *
   * Produces two yield tracks:
   * - **Ideal** (idealSolarYieldWh/idealWindYieldWh/idealNetWh/idealSoC): yield if deployable
   *   devices are deployed/stowed as recommended by conditions.
   * - **Detected** (detectedYieldWh/detectedNetWh/detectedSoC): yield if
   *   deployable devices stay as they are *detected right now*. Devices
   *   detected as stowed contribute 0 yield for all hours.
   *
   * @param {Array<{time: Date, ghi: number|null, cloudCover: number|null, gustSpeedMs: number|null}>} forecast - Weather forecast
   * @param {Map<string, string|null>} [detectedDeployStates] - Map of deviceId → "deployed"/"stowed"/null
   * @returns {HourlyPrediction[]} Hourly predictions
   */
  runPrediction(forecast, detectedDeployStates) {
    this.updateLoadProfile();

    const currentSoC = this.getCurrentSoC();
    const navState = this.getNavState();
    const awa = this.getAWA();
    const isSailing = navState === "sailing";
    const underway = this.isUnderway();
    // Read engine state once per cycle for the alternator-in-ideal-track
    // addition (motoring side-effect charging). Null (unknown) is treated
    // as not running so we don't fabricate alternator input from a missing
    // signal. isEngineRunning lives on LoadProfile (shared engine-state
    // helper).
    const engineRunning = this.loadProfile.isEngineRunning();

    // Determine state class for forecast hours
    // We use current state for all forecast hours (same assumption as
    // the rest of the engine - a route-aware version is future work)
    const stateClass = underway ? StateClass.UNDERWAY : StateClass.AT_REST;

    const predictions = [];
    let runningSoC = currentSoC;
    let detectedRunningSoC = currentSoC;
    const averageLoad = this.loadProfile.getAverageLoad();

    // Get current position for sun phase classification. unwrapPosition
    // tolerates both the unwrapped delta form and the wrapped app.getSelfPath
    // form so sun-phase classification still works when no position delta has
    // arrived in the current cycle.
    const position = unwrapPosition(this.getSelfPath("navigation.position"));
    const latitude = position?.latitude ?? 0;
    const longitude = position?.longitude ?? 0;

    this.app?.debug?.(
      `runPrediction: SoC=${Math.round(currentSoC * 100)}%, load=${Math.round(averageLoad.dcWh + averageLoad.acWh)}W, pos=${latitude.toFixed(2)},${longitude.toFixed(2)}, sailing=${isSailing}, forecast=${forecast.length}pts`,
    );
    if (forecast.length > 0) {
      this.app?.debug?.(
        `  forecast[0]: ${forecast[0].time.toISOString()} ghi=${forecast[0].ghi}`,
      );
      if (forecast[12]) {
        this.app?.debug?.(
          `  forecast[12]: ${forecast[12].time.toISOString()} ghi=${forecast[12].ghi}`,
        );
      }
      if (forecast[24]) {
        this.app?.debug?.(
          `  forecast[24]: ${forecast[24].time.toISOString()} ghi=${forecast[24].ghi}`,
        );
      }
    }

    const startTime = new Date(Date.now());
    // Track previous hour's ideal states to emit actions only on change
    let prevIdealStates = new Map();

    // Apply the Wind Protection Factor to forecast wind/gusts for the
    // current place before anything consumes them. This is done once,
    // here, so every downstream consumer (predictSolarHour gust gate,
    // predictWindHour curve + max-wind gate, getHourlyActions,
    // computeDeployableSolarStates, getDeploymentRecommendations,
    // getRecommendedStateChangeTime, getPotentialYield) sees consistent
    // corrected values. At rest at a learned place the wind/gusts are
    // scaled at the 10 m reference and translated down to device height;
    // under way, unknown place, or unlearned bins pass through unchanged
    // (getWindProtection returns null).
    const correctedForecast = forecast.map((fp) =>
      this.applyWindProtection(fp, latitude, longitude),
    );

    // Cap the prediction to the forecast horizon. Hours beyond the last
    // forecast point carry no real wind/gust data and only fabricate 0s
    // plus load estimates — they are noise, not predictions. If the
    // forecast is empty, fall back to the configured predictionHours so
    // the SoC projection still runs (load-only forecast).
    let effectiveHours = this.predictionHours;
    if (correctedForecast.length > 0) {
      // Cap to the forecast horizon. Different sources have different
      // horizons (Open-Meteo may return fewer hours than requested, the
      // Signal K Weather API may differ, the clear-sky fallback is fixed)
      // and a source may start later than now or have a non-integer-hour
      // first point. Use the last point's time relative to the prediction
      // start: a prediction hour needs a matching point (within 30 min) to
      // carry real wind/gust data, so hours beyond the last point are
      // no-data noise and are dropped.
      const lastFcstTime = correctedForecast.reduce((max, fp) => {
        const t =
          fp.time instanceof Date
            ? fp.time.getTime()
            : new Date(fp.time).getTime();
        return t > max ? t : max;
      }, 0);
      // Count prediction hours that have a matching forecast point. Hour h
      // is centered on startTime + h·1h and matches any forecast point
      // within 30 min, so the last coverable hour is the one nearest
      // lastFcstTime: round((lastFcstTime - startTime)/1h), not floor. A
      // plain floor+1 drops the final hour whenever the prediction cycle
      // runs even a minute after the forecast's first point (e.g. a 24-point
      // forecast then publishes only hours 0–22, losing hour 23 — and its
      // WPF-corrected wind/gust — entirely).
      const coveredHours =
        Math.floor((lastFcstTime - startTime.getTime()) / 3600000 + 0.5) + 1;
      if (coveredHours > 0 && coveredHours < effectiveHours) {
        effectiveHours = coveredHours;
        this.app?.debug?.(
          `  capping prediction to ${effectiveHours}h (forecast covers ${coveredHours}h of ${this.predictionHours}h)`,
        );
      }
    }

    // Deployable solar states with sunrise/sunset-aware night handling
    const solarStatesPerHour = this.computeDeployableSolarStates(
      correctedForecast,
      latitude,
      longitude,
      startTime,
      effectiveHours,
      underway,
    );
    this.app?.debug?.(`  prediction[0]: ${startTime.toISOString()}`);

    for (let h = 0; h < effectiveHours; h++) {
      const time = new Date(startTime.getTime() + h * 3600000);

      // Find corresponding forecast point (use the WPF-corrected forecast
      // so gates and curves see device-height corrected wind)
      const forecastPoint = correctedForecast.find((fp) => {
        const diff = Math.abs(fp.time.getTime() - time.getTime());
        return diff < 1800000; // Within 30 minutes
      });
      // Raw (pre-WPF) forecast point, so the hourly forecast can show
      // both the original forecast wind/gusts and the WPF-corrected values
      // that actually drive the gates and curves.
      const rawPoint = forecast.find((fp) => {
        const diff = Math.abs(fp.time.getTime() - time.getTime());
        return diff < 1800000;
      });

      const ghi = forecastPoint?.ghi ?? 0;
      const cloudCover = forecastPoint?.cloudCover ?? 0;
      // Wind/gust default to null (not 0) when no forecast point covers
      // this hour: a missing forecast must not be treated as calm, otherwise
      // wind generators would be recommended to stow with "0kn < startup"
      // and the gust gate would fabricate a calm day. Downstream consumers
      // (predictWindHour, getHourlyActions) treat null as no-data.
      const windGustMs = forecastPoint?.gustSpeedMs ?? null;
      const windSpeedMs = forecastPoint?.windSpeedMs ?? null;
      const forecastWindSpeedMs =
        rawPoint?.windSpeedMs != null ? rawPoint.windSpeedMs : null;
      const forecastGustMs =
        rawPoint?.gustSpeedMs != null ? rawPoint.gustSpeedMs : null;
      const windDirectionDeg =
        rawPoint?.windDirectionDeg ?? forecastPoint?.windDirectionDeg ?? null;

      // Get sun position
      const sunPos = sunPosition(time, latitude, longitude);

      // Calculate solar yield
      let idealSolarYieldWh = 0;
      let detectedSolarYieldWh = 0;
      for (const array of this.solarArrays) {
        // Get efficiency from learning matrix
        const efficiency = this.getEfficiency(
          array.id,
          isSailing,
          sunPos.azimuth,
          sunPos.altitude,
          isSailing ? awa : undefined,
        );

        const arrayYield = predictSolarHour({
          array,
          sunPosition: sunPos,
          ghi,
          windGustMs,
          efficiency,
        });

        // Ideal track: a deployable array only contributes in hours whose
        // ideal state is "deployed". computeDeployableSolarStates stows
        // deployable solar when the vessel is under way, in gusts, and
        // before gusty nights — but its output previously fed only the
        // hourly *actions*, never this yield sum, so the ideal track counted
        // FLINsail Wh under way and inflated idealSoC (skewing the outlook
        // status and suppressing the combustion run gates). Fixed arrays
        // always count; under way the hydrogenerator covers generation.
        const idealState = solarStatesPerHour[h]?.get(array.id);
        if (array.type !== "deployable" || idealState?.state !== "stowed") {
          idealSolarYieldWh += arrayYield;
        }

        // Detected track models what each array actually produces given its
        // detected state: stowed -> no yield; actually deployed -> yield
        // without the ideal track's gust stow gate (it is out there
        // producing); unknown -> fall back to the gated estimate
        const detectedState = detectedDeployStates?.get(array.id);
        if (array.type === "deployable" && detectedState === "stowed") {
          detectedSolarYieldWh += 0;
        } else if (
          array.type === "deployable" &&
          detectedState === "deployed"
        ) {
          detectedSolarYieldWh += predictSolarHour({
            array,
            sunPosition: sunPos,
            ghi,
            windGustMs,
            efficiency,
            skipStowGate: true,
          });
        } else {
          detectedSolarYieldWh += arrayYield;
        }

        if (h === 12 || h === 22) {
          const extra =
            array.type === "deployable"
              ? ` gust=${windGustMs != null ? windGustMs.toFixed(0) : "n/a"}m/s limit=${array.gustLimitMs ?? "n/a"}m/s`
              : "";
          this.app?.debug?.(
            `  h=${h} array=${array.id}: alt=${((sunPos.altitude * 180) / Math.PI).toFixed(1)}° ghi=${ghi.toFixed(0)} eff=${efficiency.toFixed(2)} cap=${array.capacityWp}Wp yield=${arrayYield.toFixed(1)}Wh${extra}`,
          );
        }
      }

      // Calculate wind/hydro yield
      let mechanicalYieldWh = 0;
      let hydroYieldWh = 0;
      let detectedMechanicalYieldWh = 0;
      const speedThroughWater = this.getSpeedThroughWater();

      for (const generator of this.mechanicalGenerators) {
        let genYield = 0;
        if (generator.type === "wind") {
          genYield = predictWindHour({
            generator,
            windSpeedMs,
            gustSpeedMs: windGustMs,
            isSailing,
            navState,
          });
        } else if (generator.type === "hydro") {
          genYield = predictHydroHour({
            generator,
            speedThroughWaterMs: speedThroughWater ?? 0,
            isSailing,
          });
        }
        mechanicalYieldWh += genYield;
        if (generator.type === "hydro") {
          hydroYieldWh += genYield;
        }

        // Detected track models what each generator actually produces:
        // stowed -> no yield; actually up (deployed, or a fixed mount that
        // cannot be stowed) -> yield without the ideal track's stow gates;
        // unknown -> fall back to the gated estimate
        const detectedState = detectedDeployStates?.get(generator.id);
        if (generator.deployable && detectedState === "stowed") {
          detectedMechanicalYieldWh += 0;
        } else if (
          generator.type === "wind" &&
          (!generator.deployable || detectedState === "deployed")
        ) {
          detectedMechanicalYieldWh += predictWindHour({
            generator,
            windSpeedMs,
            gustSpeedMs: windGustMs,
            isSailing,
            navState,
            skipStowGate: true,
          });
        } else {
          detectedMechanicalYieldWh += genYield;
        }
      }

      // Get sun-phase aware load for this forecast hour
      const sunPhase = this.loadProfile.getSunPhase(time, position);
      const loadProfile = this.loadProfile.getLoad(sunPhase, stateClass);
      let houseLoadW;
      if (loadProfile) {
        houseLoadW = loadProfile.dcWh + loadProfile.acWh;
      } else {
        // Fall back to rolling average
        houseLoadW = averageLoad.dcWh + averageLoad.acWh;
      }

      // Motoring side-effect: when engines are running for propulsion
      // (under way), their alternators charge the bank as a byproduct. The
      // ideal track must account for this so the SoC projection reflects
      // reality — arriving somewhere by motor at midday almost guarantees a
      // full battery with hours of sun left (the surplus-advisory headline
      // case). At-anchor engine runs are deficit response by definition and
      // are NOT modeled here (the combustion advisory owns those).
      //
      // Engine state is read once per cycle from the configured engines
      // (same assumption as the rest of the engine — a route-aware version
      // is future work); underway is already determined above. Only engines
      // with an alternator contribute — an electric drive motoring is a
      // consumer, not a charger.
      let alternatorWh = 0;
      if (underway && engineRunning === true) {
        for (const engine of this.engines) {
          if (
            engine.alternatorWatts > 0 &&
            detectEngineRunning(engine, this.getSelfPath) === true
          ) {
            alternatorWh += engine.alternatorWatts;
          }
        }
      }

      const idealNetWh =
        idealSolarYieldWh + mechanicalYieldWh + alternatorWh - houseLoadW;
      const socChange = idealNetWh / this.capacityWh;
      runningSoC = Math.max(0, Math.min(1, runningSoC + socChange));

      const detectedYieldWh = detectedSolarYieldWh + detectedMechanicalYieldWh;
      const detectedNetWh = detectedYieldWh - houseLoadW;
      const detectedSocChange = detectedNetWh / this.capacityWh;
      detectedRunningSoC = Math.max(
        0,
        Math.min(1, detectedRunningSoC + detectedSocChange),
      );

      // Compute per-device deploy/stow actions for this hour,
      // emitting only when the ideal state changes. At hour 0, emit only
      // devices that actually need something done (detected state differs
      // from ideal, or is unknown) - a device already in its ideal state
      // ("stay") needs no action entry.
      const allActions = this.getHourlyActions(
        windGustMs,
        windSpeedMs,
        underway,
        isSailing,
        speedThroughWater ?? null,
        detectedDeployStates,
        solarStatesPerHour[h],
        navState,
      );
      const actions = allActions.filter(
        (a) =>
          (h === 0 && a.detectedAction !== "stay") ||
          (h > 0 && prevIdealStates.get(a.id) !== a.idealState),
      );
      for (const a of actions) {
        a.time = time.toISOString();
      }
      prevIdealStates = new Map(allActions.map((a) => [a.id, a.idealState]));

      predictions.push({
        hour: h,
        time,
        idealSolarYieldWh: Math.round(idealSolarYieldWh),
        idealWindYieldWh: Math.round(mechanicalYieldWh),
        idealHydroYieldWh: Math.round(hydroYieldWh),
        alternatorWh: Math.round(alternatorWh),
        houseLoadWh: Math.round(houseLoadW),
        idealNetWh: Math.round(idealNetWh),
        idealSoC: Math.round(runningSoC * 1000) / 1000,
        detectedYieldWh: Math.round(detectedYieldWh),
        detectedNetWh: Math.round(detectedNetWh),
        detectedSoC: Math.round(detectedRunningSoC * 1000) / 1000,
        gustSpeedMs: windGustMs ?? 0,
        windSpeedMs: windSpeedMs ?? 0,
        forecastWindSpeedMs,
        forecastGustMs,
        windDirectionDeg,
        actions,
      });
    }

    // FLINsail produces nothing at night: move night actions to sun boundaries
    // (stow during night → at sunset, deploy during night → at sunrise)
    this.shiftSolarActionsToSunBoundaries(predictions, latitude, longitude);

    this.lastPrediction = predictions;
    this.lastRawForecast = forecast;
    this.lastForecast = correctedForecast;
    return predictions;
  }

  /**
   * Moves deployable solar actions that occur during night hours to the
   * surrounding sun boundary: a stow triggered at night is reported at the
   * sunset that started the night (stow before dark, no 2 AM surprises), and
   * a deploy triggered at night is reported at the next sunrise (deploying
   * at night gains nothing since the array produces no power).
   *
   * Each shifted action carries the exact boundary time in its `time` field
   * and is placed in the hourly bucket containing that time. Targets before
   * the forecast window clamp to hour 0 ("do it now"); targets beyond the
   * window are dropped.
   *
   * @param {HourlyPrediction[]} predictions - Hourly predictions (mutated)
   * @param {number} latitude - Latitude in degrees
   * @param {number} longitude - Longitude in degrees
   * @returns {void}
   */
  shiftSolarActionsToSunBoundaries(predictions, latitude, longitude) {
    if (predictions.length === 0) return;
    const startTime = predictions[0].time.getTime();

    for (const p of predictions) {
      const { altitude } = sunPosition(p.time, latitude, longitude);
      if (altitude > 0) continue; // Day hour: keep as-is

      const solarActions = p.actions.filter(
        (a) => a.type === "solar-deployable",
      );
      if (solarActions.length === 0) continue;
      p.actions = p.actions.filter((a) => a.type !== "solar-deployable");

      for (const action of solarActions) {
        const isStow = action.idealAction === "stow";
        const target = isStow
          ? lastSunset(p.time, latitude, longitude)
          : nextSunrise(p.time, latitude, longitude);
        if (!target) continue; // Polar edge case: leave in place
        // The action was decided at a night hour, where its reason was
        // phrased for the night (e.g. "no night gusts" for a carry-over
        // deploy, or "forecast night gusts ..." for a before-dark stow).
        // Now that the action is moved to a sun boundary — sunrise for a
        // deploy, sunset for a stow — rephrase the reason so it reads
        // correctly at the boundary hour rather than leaking a
        // night-specific explanation into a morning/evening advisory.
        action.reason = rephraseShiftedSolarReason(action.reason, isStow);
        insertActionIntoBucket(predictions, startTime, target, action);
      }
    }
  }

  /**
   * Calculates time to full (SoC = 1.0).
   * Extrapolates beyond 24h if the trend is consistently upward.
   *
   * @returns {Date|null} Timestamp when battery will be full, or null if not trending toward full
   */
  getTimeToFull() {
    if (this.lastPrediction.length === 0) return null;

    const full = this.lastPrediction.find((p) => p.idealSoC >= 1.0);
    if (full) return full.time;

    // Extrapolate: if average net is positive, estimate when SoC reaches 1.0
    const currentSoC = this.getCurrentSoC();
    if (currentSoC >= 1.0) return new Date(); // Already full

    const avgNetWh =
      this.lastPrediction.reduce((sum, p) => sum + p.idealNetWh, 0) /
      this.lastPrediction.length;
    if (avgNetWh <= 0) return null; // Not charging

    const deficitWh = (1.0 - currentSoC) * this.capacityWh;
    const hoursToFull = deficitWh / avgNetWh;
    if (hoursToFull > 72) return null; // Too far to be useful

    return new Date(Date.now() + hoursToFull * 3600000);
  }

  /**
   * Calculates time to empty (SoC reaches minSafeSoC).
   * Extrapolates beyond 24h if the trend is consistently downward.
   *
   * @returns {Date|null} Timestamp when battery will be depleted, or null if not trending toward empty
   */
  getTimeToEmpty() {
    if (this.lastPrediction.length === 0) return null;

    const depleted = this.lastPrediction.find(
      (p) => p.idealSoC <= this.battery.minSafeSoC,
    );
    if (depleted) return depleted.time;

    // Extrapolate: if average net is negative, estimate when SoC reaches minSafeSoC
    const currentSoC = this.getCurrentSoC();
    if (currentSoC <= this.battery.minSafeSoC) return new Date(); // Already depleted

    const avgNetWh =
      this.lastPrediction.reduce((sum, p) => sum + p.idealNetWh, 0) /
      this.lastPrediction.length;
    if (avgNetWh >= 0) return null; // Not discharging

    const surplusWh = (currentSoC - this.battery.minSafeSoC) * this.capacityWh;
    const hoursToEmpty = surplusWh / Math.abs(avgNetWh);
    if (hoursToEmpty > 72) return null; // Too far to be useful

    return new Date(Date.now() + hoursToEmpty * 3600000);
  }

  /**
   * Calculates energy deficit from current SoC to full.
   *
   * @returns {number} Deficit in watt-hours
   */
  getDeficit() {
    const currentSoC = this.getCurrentSoC();
    return (1 - currentSoC) * this.capacityWh;
  }

  /**
   * Finds stowage opportunity when mechanical generators are active
   * and remaining solar forecast is sufficient.
   *
   * @returns {{hour: number, reason: string}|null} Stowage recommendation or null
   */
  findStowageOpportunity() {
    let cumulativeNet = 0;
    const deficit = this.getDeficit();
    let mechanicalActive = false;

    for (let i = 0; i < this.lastPrediction.length; i++) {
      const p = this.lastPrediction[i];

      if (p.idealWindYieldWh > 0) {
        mechanicalActive = true;
      }

      cumulativeNet += p.idealNetWh;

      // Check if deficit covered and mechanicals are still active
      if (mechanicalActive && cumulativeNet >= deficit) {
        // Check if remaining solar is sufficient
        const remainingSolar = this.lastPrediction
          .slice(i)
          .reduce((sum, rp) => sum + rp.idealSolarYieldWh, 0);

        if (remainingSolar >= deficit * 0.8) {
          return {
            hour: i,
            reason: `Deficit covered by hour ${i}, ${formatWh(remainingSolar)} solar remaining`,
          };
        }
      }
    }

    return null;
  }

  /**
   * Finds a surplus-energy opportunity: a window where the battery is
   * forecast full while renewable/alternator yield continues with nowhere
   * for the energy to go (the charge controller would curtail it). This is
   * the "run the watermaker, make ice" case — and the classic motoring
   * side-effect case (arriving by motor at midday, bank full, hours of sun
   * left).
   *
   * Detection over the ideal SoC track (lastPrediction):
   *   1. Find the first hour H where idealSoC >= fullThreshold — the
   *      gating anchor for the window (lead-time, day/night, sunset).
   *   2. H must not be within ~1h of sunset (no point alerting at dusk).
   *   3. From H onward, surplus per hour is the production that would not
   *      be stored because SoC is 100%: max(0, net − (1.0 − socStartOfHour)·
   *      capacityWh), where socStartOfHour is the previous point's clamped
   *      idealSoC (the full hour's own idealSoC is end-of-hour). This is
   *      exactly the energy the prediction's SoC clamp throws away.
   *   4. The window runs from the first hour that actually curtails energy
   *      until the last (typically when the engine stops or the sun sets).
   *   5. Only alert if the window starts within maxLeadHours (beyond that,
   *      forecast uncertainty makes the alert noise).
   *   6. Only alert if total surplusWh >= minSurplusWh.
   *
   * At-anchor engine runs are deficit response by definition and never
   * produce a surplus here (we wouldn't run the engine at anchor if surplus
   * were coming). The motoring case is handled because the alternator input
   * is part of the ideal track (see runPrediction), so the bank is forecast
   * full midday and the post-full alternator hours contribute to surplusWh.
   *
   * @param {object} opts
   * @param {number} [opts.fullThreshold=0.95] - SoC at which the bank is
   *        considered full (absorption/full), [0,1]
   * @param {number} [opts.minSurplusWh=300] - Minimum wasted energy to alert
   * @param {number} [opts.maxLeadHours=36] - Max hours from now for the
   *        window to start; windows further out are ignored until they
   *        enter the horizon
   * @returns {{surplusWh: number, from: Date, to: Date, suggestedLoadW: number}|null}
   */
  findSurplusOpportunity({
    fullThreshold = 0.95,
    minSurplusWh = 300,
    maxLeadHours = 36,
  } = {}) {
    if (this.lastPrediction.length === 0) return null;

    const position = unwrapPosition(this.getSelfPath("navigation.position"));
    const latitude = position?.latitude ?? 0;
    const longitude = position?.longitude ?? 0;

    const now = new Date();
    const maxStart = new Date(now.getTime() + maxLeadHours * 3600000);

    // Find the first hour where the bank is forecast full.
    const fullHourIndex = this.lastPrediction.findIndex(
      (p) => p.idealSoC >= fullThreshold,
    );
    if (fullHourIndex === -1) return null;

    const fullHour = this.lastPrediction[fullHourIndex];
    // Window must start within the configured lead-time horizon.
    if (fullHour.time.getTime() > maxStart.getTime()) return null;

    // Day/night gating by activity model:
    //  - Under way: someone is always on watch, so alert at any hour
    //    (covers motoring charging the bank full at night, with sun left
    //    the next day, or wind surplus while sailing).
    //  - At rest (anchored/moored/unknown): only alert for windows that
    //    start in daytime. A full bank at night (typically wind surplus)
    //    has no one awake to act on it, so we suppress rather than wake
    //    the crew. The window's own surplus is also near-zero then since
    //    there's no solar, but wind surplus at a full bank can be real at
    //    night — by policy we don't alert for it after dark.
    const underway = this.isUnderway();
    if (!underway) {
      const sunAlt = sunPosition(fullHour.time, latitude, longitude).altitude;
      if (sunAlt <= 0) return null; // sun below horizon → nighttime
    }

    // H must not be within ~1h of sunset: a full bank at dusk has little
    // daylight left to waste, so there's nothing to act on. (Under way this
    // also bounds the alert to windows with meaningful remaining yield.)
    const sunset = nextSunset(fullHour.time, latitude, longitude);
    if (sunset) {
      const hoursToSunset =
        (sunset.getTime() - fullHour.time.getTime()) / 3600000;
      if (hoursToSunset <= 1) return null;
    }

    // Sum the energy that has nowhere to go once the bank is full.
    //
    // Surplus is *precisely* the production that would not be stored into
    // the battery because SoC is at 100%: for each hour, the bank can absorb
    // (1.0 - socStartOfHour) * capacityWh before it's full, and anything the
    // hour's net yield produces beyond that is curtailed (has nowhere to go).
    //
    // We read socStartOfHour directly from the clamped ideal track
    // (idealSoC of the previous hour; the full hour's own idealSoC is the
    // end-of-hour value, already clamped to 1.0). Using the track's SoC —
    // rather than a parallel headroom state machine — makes the surplus
    // exact by construction: it is whatever the prediction's own SoC clamp
    // threw away. This automatically accounts for the absorption tail
    // (the bank spends hours at 0.96/0.98… still absorbing, so that energy
    // is not surplus) and for overnight drawdowns (the clamped SoC drops,
    // so the next morning's solar has real headroom and goes into the bank,
    // not surplus) — no separate tail-grant or discharge-grows-headroom
    // bookkeeping, which previously over-counted by granting the tail once
    // then treating the next hour as already-full.
    const capacityWh = this.capacityWh || 0;
    const startSoC = this.lastPrediction[0].idealSoC;
    let surplusWh = 0;
    let firstSurplusIndex = -1;
    let lastSurplusIndex = -1;
    for (let i = fullHourIndex; i < this.lastPrediction.length; i++) {
      const p = this.lastPrediction[i];
      const net =
        p.idealSolarYieldWh +
        p.idealWindYieldWh +
        (p.alternatorWh ?? 0) -
        p.houseLoadWh;
      if (net <= 0) continue; // not producing → nothing to curtail
      const socStartOfHour =
        i > 0 ? this.lastPrediction[i - 1].idealSoC : startSoC;
      // Headroom the bank can absorb before hitting 100%: (1.0 - socStartOfHour)
      // * capacity. When capacity is unknown, the only case we can be certain
      // about is a bank already at 1.0 (headroom 0) — anything below 1.0 has
      // real headroom we can't quantify, so we conservatively treat it as no
      // curtailment rather than risk over-counting (the prior bug).
      const headroomWh =
        socStartOfHour >= 1.0
          ? 0
          : capacityWh > 0
            ? Math.max(0, (1.0 - socStartOfHour) * capacityWh)
            : net; // unknown capacity → assume the whole hour absorbs
      const curtailed = Math.max(0, net - headroomWh);
      if (curtailed > 0) {
        surplusWh += curtailed;
        if (firstSurplusIndex === -1) firstSurplusIndex = i;
        lastSurplusIndex = i;
      }
    }

    if (surplusWh < minSurplusWh) return null;
    if (lastSurplusIndex === -1) return null; // no post-full curtailed surplus

    const from = this.lastPrediction[firstSurplusIndex].time;
    const to = this.lastPrediction[lastSurplusIndex].time;
    const windowHours = (to.getTime() - from.getTime()) / 3600000 + 1; // inclusive of both ends
    const suggestedLoadW =
      windowHours > 0 ? Math.round(surplusWh / windowHours) : 0;

    return { surplusWh: Math.round(surplusWh), from, to, suggestedLoadW };
  }

  /**
   * Computes the overall energy outlook for the next 24 hours — a single
   * glanceable status for instrument panels:
   *
   *  - "critical": the projected SoC dips below the chemistry-specific
   *    critical threshold (LiFePO4 30%, lead-acid 45%) at any point in the
   *    window, including right now
   *  - "surplus":    the bank fills to 100% and production is curtailed
   *    (the same track-derived surplus the surplus advisory uses)
   *  - "rising":     the projected SoC ends more than 5 points above now
   *  - "stable":     the projected SoC ends within 5 points of now
   *  - "deficit":    the projected SoC ends more than 5 points below now
   *
   * Critical is checked before surplus (a full-then-empty day is still a
   * warning). Uses the *ideal* track (everything deployed per the
   * advisories), consistent with the surplus and engine-run advisories.
   *
   * @returns {{status: "surplus"|"rising"|"stable"|"deficit"|"critical",
   *           currentSoC: number, endSoC: number, minSoC: number,
   *           criticalSoC: number, surplusWh: number, net24hWh: number,
   *           hours: number}|null}
   *          null when no prediction has been run
   */
  getEnergyOutlook() {
    if (this.lastPrediction.length === 0) return null;

    const hours = Math.min(24, this.lastPrediction.length);
    const track = this.lastPrediction.slice(0, hours);
    const currentSoC = this.getCurrentSoC();

    // Surplus over the window: same track-clamp math as
    // findSurplusOpportunity (energy the 100% SoC clamp throws away), but
    // without its notification policy gates (min Wh, daytime-only at rest)
    // — the status should state the physics, not the alert policy.
    let surplusWh = 0;
    let socStart = currentSoC;
    for (const p of track) {
      const headroom = (1 - Math.min(socStart, 1)) * this.capacityWh;
      surplusWh += Math.max(0, p.idealNetWh - headroom);
      socStart = p.idealSoC;
    }

    const endSoC = track[track.length - 1].idealSoC;
    const minSoC = Math.min(currentSoC, ...track.map((p) => p.idealSoC));
    // Net energy balance over the window on the ideal track: the change
    // in stored energy, positive when the bank is projected to rise
    // (a surplus even when it never reaches the 100% curtailment clamp)
    // and negative when it is projected to fall (a deficit). This is the
    // physical bank trajectory; the curtailment-only `surplusWh` above is
    // the energy the 100% clamp throws away once the bank is already
    // full — the two are distinct and do not double-count.
    const net24hWh = Math.round((endSoC - currentSoC) * this.capacityWh);

    let status;
    if (minSoC < this.criticalSoC) {
      status = "critical";
    } else if (surplusWh > 0) {
      status = "surplus";
    } else {
      const delta = endSoC - currentSoC;
      if (Math.abs(delta) <= 0.05) {
        status = "stable";
      } else {
        status = delta > 0 ? "rising" : "deficit";
      }
    }

    return {
      status,
      currentSoC,
      endSoC,
      minSoC,
      criticalSoC: this.criticalSoC,
      surplusWh: Math.round(surplusWh),
      net24hWh,
      hours,
    };
  }

  /**
   * Gets hourly forecast data for Signal K delta.
   *
   * @returns {Array<{time: string, idealSolarYieldWh: number, idealWindYieldWh: number, idealHydroYieldWh: number, houseLoadWh: number, idealNetWh: number, idealSoC: number, detectedYieldWh: number, detectedNetWh: number, detectedSoC: number, windSpeedKnots: number, gustSpeedKnots: number, forecastWindSpeedKnots: number, forecastGustKnots: number, windDirectionDeg: number, actions: Array}>}
   */
  getHourlyForecast() {
    // The engine works in m/s; this blob feeds the recorder (on-disk
    // format, knots), the HTTP API (knots), and the `forecast.hourly` delta.
    // Render wind in knots here at the output boundary so those consumers
    // (which all expect knots) stay unchanged.
    return this.lastPrediction.map((p) => ({
      time: p.time.toISOString(),
      idealSolarYieldWh: Math.round(p.idealSolarYieldWh),
      idealWindYieldWh: Math.round(p.idealWindYieldWh),
      idealHydroYieldWh: Math.round(p.idealHydroYieldWh ?? 0),
      alternatorWh: Math.round(p.alternatorWh ?? 0),
      houseLoadWh: Math.round(p.houseLoadWh),
      idealNetWh: Math.round(p.idealNetWh),
      idealSoC: Math.round(p.idealSoC * 1000) / 1000,
      detectedYieldWh: Math.round(p.detectedYieldWh),
      detectedNetWh: Math.round(p.detectedNetWh),
      detectedSoC: Math.round(p.detectedSoC * 1000) / 1000,
      windSpeedKnots:
        p.windSpeedMs != null
          ? Math.round(p.windSpeedMs * MS_TO_KN * 10) / 10
          : null,
      gustSpeedKnots:
        p.gustSpeedMs != null
          ? Math.round(p.gustSpeedMs * MS_TO_KN * 10) / 10
          : null,
      forecastWindSpeedKnots:
        p.forecastWindSpeedMs != null
          ? Math.round(p.forecastWindSpeedMs * MS_TO_KN * 10) / 10
          : null,
      forecastGustKnots:
        p.forecastGustMs != null
          ? Math.round(p.forecastGustMs * MS_TO_KN * 10) / 10
          : null,
      windDirectionDeg: p.windDirectionDeg,
      actions: p.actions,
    }));
  }
}

module.exports = {
  PredictionEngine,
  LoadProfile,
  SunPhase,
  StateClass,
  interpolateWindPower,
  predictSolarHour,
  predictWindHour,
  predictHydroHour,
  PREDICTION_HOURS,
  MAX_PREDICTION_HOURS,
  toNumber,
  toKnots,
  toMs,
  msFromKnots,
  MS_TO_KN,
  KN_TO_MS,
  unwrapPosition,
};
