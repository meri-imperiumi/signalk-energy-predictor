/**
 * Multi-level notification urgency calculation.
 *
 * Urgency builds up gradually from four inputs:
 *  - **Intensity** — how severe the condition is (how far over the limit, or
 *    how low the battery SoC is).
 *  - **Time proximity** — how soon action is needed.
 *  - **Event duration** — short gusts vs sustained exceedances.
 *  - **State confidence** — how certain we are about the current deployment
 *    state. Low confidence in "deployed" boosts urgency (assume the worst
 *    case); a confident "stowed" state removes urgency entirely.
 *
 * The urgency ladder (info → low → medium → high) is designed to *prevent*
 * ever reaching `alarm`, which is reserved for situations where the vessel
 * becomes a hazard (e.g. BMS low-voltage cutoff about to take nav lights,
 * AIS and VHF offline). On vessels where `alarm` notifications buzz every
 * crew member's pocket even when ashore, `alarm` must be reserved for
 * safety-compromised situations.
 *
 * Two cross-cutting factors modulate the base score for deployables:
 *  - **Reluctance** (from #11): high-reluctance deployables (wind
 *    generator — "go on deck and rig it") dampen urgency escalation, so we
 *    don't bark for conditions the crew can't usefully act on. Easy sources
 *    (hydro, FLINsail) act on urgency promptly. One per-deployable
 *    `reluctance` knob feeds both #11 (hysteresis widening) and this module
 *    (urgency dampening).
 *  - **Navigation-state gating** (#2): underway, a watch is on duty 24/7,
 *    so activity suggestions emit at any hour (day/night only adjusts
 *    *methods*). At rest + night, non-urgent (`info`/`low`) deployable
 *    activity suggestions are held for the morning — they're mostly
 *    actionable at sunrise anyway. Safety-critical notifications (battery
 *    going dark) always emit per the existing day/night method table.
 *
 * @file urgency.js
 */

/**
 * Internal urgency levels, ordered low → high.
 * @enum {string}
 */
const Urgency = {
  NORMAL: "normal",
  INFO: "info",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  ALARM: "alarm",
};

/** Ordered list, lowest to highest. Used for capping and indexing. */
const URGENCY_ORDER = [
  Urgency.NORMAL,
  Urgency.INFO,
  Urgency.LOW,
  Urgency.MEDIUM,
  Urgency.HIGH,
  Urgency.ALARM,
];

/**
 * State-confidence values. Higher is more certain. See the confidence
 * scoring table in the work document.
 * @enum {number}
 */
const StateConfidence = {
  HIGH: 1.0,
  MEDIUM: 0.7,
  LOW: 0.5,
  NONE: 0.0,
};

/**
 * Reluctance levels for deployables — the minimum good-output hours to
 * justify a deploy. Exposed in the config schema as a human-readable
 * pulldown (Low / Medium / High) rather than a raw number, so the crew
 * picks "how willing am I to act on this source" without doing math.
 * Per-device `reluctance` overrides the type default.
 * @enum {number}
 */
const Reluctance = {
  /** Low: deploy even for an hour of output (e.g. hydrogenerator). */
  LOW: 1,
  /** Medium: deploy when a couple hours of output are available (e.g. FLINsail). */
  MEDIUM: 2,
  /** High: deploy only when you can get most of a day of output (e.g. wind generator). */
  HIGH: 8,
};

/**
 * Maps an internal urgency level to a Signal K notification state and the
 * notification methods to use. The methods here are the *daytime* defaults;
 * nighttime downgrades `medium`/`high` to visual-only for deployables (see
 * {@link methodsFor}).
 */
const URGENCY_TO_SK = {
  [Urgency.NORMAL]: { state: "normal", methods: [] },
  [Urgency.INFO]: { state: "alert", methods: ["visual"] },
  [Urgency.LOW]: { state: "alert", methods: ["visual"] },
  [Urgency.MEDIUM]: { state: "warn", methods: ["visual", "sound"] },
  [Urgency.HIGH]: { state: "warn", methods: ["visual", "sound"] },
  [Urgency.ALARM]: { state: "alarm", methods: ["visual", "sound"] },
};

/**
 * Default urgency configuration. Callers may override any field via the
 * plugin's `notification.urgency` config block.
 */
const DEFAULT_CONFIG = {
  // Score weights. The body formula is
  //   score = (intensity*w_i + time*w_t) * duration * confidence * reluctance
  weights: { intensity: 0.4, time: 0.6 },

  // Score thresholds mapping to urgency levels.
  thresholds: {
    normal: 0.1,
    info: 0.3,
    low: 0.5,
    medium: 0.7,
    high: 0.85,
  },

  // Event-duration factors and the minute boundaries that select them.
  durationFactor: {
    transient: 0.1, // < 2 min: caps at info even for extreme intensity
    brief: 1.0, // short event: normal calculation
    sustained: 1.2, // clearly worthwhile duration: slightly higher urgency
  },
  durationMinutes: {
    transient: 2,
  },

  // Battery SoC tiers (fraction 0–1). Confidence does not apply to battery
  // — we read SoC directly from the BMS.
  batterySoCTiers: {
    alarm: 0.1,
    high: 0.2,
    medium: 0.35,
    low: 0.5,
    info: 0.65,
  },

  // Maximum urgency per advisory type. Deployables cap at `high` (equipment
  // damage is expensive but doesn't compromise vessel safety when the crew
  // are ashore); engine/battery may reach `alarm` (boat going dark);
  // opportunity advisories (surplus, drag reduction) cap at `medium` — they
  // are gains from acting, not losses from not acting, so they are never
  // urgent.
  maxUrgencyByType: {
    deployable: Urgency.HIGH,
    engine: Urgency.ALARM,
    opportunity: Urgency.MEDIUM,
  },

  // Reluctance: the minimum good-output *hours* a forecast must offer
  // before deploying a source is worth the effort. Per-device `reluctance`
  // (on the solar array / generator config) overrides this type default;
  // the per-device value is the canonical knob. This is the primary
  // reluctance lever for deployables (update #1, point 2): you wouldn't go
  // on deck to rig the Superwind for a 1h window, but you'd deploy a
  // hydrogenerator for an hour and a FLINsail for a couple of hours.
  //
  //   hydrogenerator (easy)    → 1h
  //   FLINsail (solar-deployable) → 2h
  //   wind generator (hard)    → 8h
  //
  // The urgency duration gate compares the forecast good-output window
  // (in minutes) to `reluctance × 60`: below it, a deploy suggestion
  // caps at `low` (visual — "there's wind, not enough to justify rigging
  // yet"); at or above it, normal calculation applies. Hysteresis (#11,
  // the gust-margin in knots) handles recommendation flapping; reluctance
  // handles "is the window long enough to be worth the deck trip."
  minGoodOutputHoursByType: {
    hydro: Reluctance.LOW,
    "solar-deployable": Reluctance.MEDIUM,
    wind: Reluctance.HIGH,
  },
};

/**
 * Deep-merges a caller config on top of the defaults. Only the supplied
 * leaves override; nested objects are merged so a partial config (e.g.
 * only `thresholds`) doesn't erase the rest.
 *
 * @param {object} [override] - Caller config
 * @param {object} [base] - Base config (defaults to DEFAULT_CONFIG)
 * @returns {object} Merged config
 */
function mergeConfig(override, base = DEFAULT_CONFIG) {
  if (!override || typeof override !== "object") return clone(base);
  const out = clone(base);
  for (const [key, val] of Object.entries(override)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      out[key] = mergeConfig(val, out[key]);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** @returns {object} A deep copy of `obj` (plain objects only). */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Clamps a number to [min, max].
 * @param {number} x
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

/**
 * Computes the intensity score.
 *
 * For deployables the score is logarithmic in the severity ratio
 * (`currentValue / limit`): 1.0 → 0, 1.5 → ~0.58, 2.0 → 1.0. For battery
 * depletion it uses fixed SoC tiers (confidence is not applicable — we
 * read SoC directly).
 *
 * @param {object} params
 * @param {number|null} params.severityRatio - currentValue / limit (null
 *        for battery/engine advisories)
 * @param {number|null} params.batterySoC - Current SoC [0–1] for engine
 *        advisories
 * @param {string} params.advisoryType - "deployable" or "engine"
 * @param {object} config - Merged urgency config
 * @returns {number} Intensity score ≥ 0
 */
function intensityScore({ severityRatio, batterySoC, advisoryType }, config) {
  if (advisoryType === "engine" && batterySoC != null) {
    const t = config.batterySoCTiers;
    if (batterySoC <= t.alarm) return 1.0;
    if (batterySoC <= t.high) return 0.9;
    if (batterySoC <= t.medium) return 0.7;
    if (batterySoC <= t.low) return 0.5;
    if (batterySoC <= t.info) return 0.3;
    return 0.1;
  }
  if (severityRatio != null && severityRatio >= 1) {
    return Math.log2(severityRatio);
  }
  return 0;
}

/**
 * Computes the time score.
 *
 * `timeScore = 1 - log2(hours) / log2(24)`, clamped to [0, 1]. 24h → 0,
 * 1h → ~0.79, now → 1. Null (no time-to-action) → 0.
 *
 * @param {number|null} hours - Hours until action is needed
 * @returns {number} Time score in [0, 1]
 */
function timeScore(hours) {
  if (hours == null) return 0;
  if (hours <= 0) return 1;
  return clamp(1 - Math.log2(hours) / Math.log2(24), 0, 1);
}

/**
 * Selects the duration factor for an *actual* sustained event (e.g. a
 * stow warning for an over-limit gust that has persisted). Forecast
 * events (deploy suggestions) use the reluctance gate in
 * {@link module:urgency~calculateUrgency} instead, keyed on the forecast
 * good-output window.
 *
 * @param {number|null} minutes - How long the actual event has persisted
 * @param {boolean} isActual - True if happening now vs forecast
 * @param {object} config - Merged urgency config
 * @returns {number} Duration factor
 */
function durationFactorFor(minutes, isActual, config) {
  if (!isActual || minutes == null) return config.durationFactor.sustained;
  if (minutes < config.durationMinutes.transient)
    return config.durationFactor.transient;
  if (minutes < config.durationMinutes.brief)
    return config.durationFactor.brief;
  return config.durationFactor.sustained;
}

/**
 * Computes the confidence factor for a deployable. Lower confidence in
 * "deployed" boosts urgency (assume the worst case); "stowed" needs no
 * boost — if it's actually deployed, the low confidence already reflects
 * that. Battery/engine advisories ignore confidence (SoC is read directly).
 *
 * @param {string|null} detectedState - "deployed", "stowed", or null
 * @param {number} confidence - StateConfidence value
 * @param {string} advisoryType - "deployable" or "engine"
 * @returns {number} Confidence factor
 */
function confidenceFactorFor(detectedState, confidence, advisoryType) {
  if (advisoryType !== "deployable") return 1.0;
  if (detectedState !== "deployed") return 1.0;
  if (confidence >= StateConfidence.HIGH) return 1.0;
  if (confidence >= StateConfidence.MEDIUM) return 1.1;
  if (confidence >= StateConfidence.LOW) return 1.2;
  return 1.3; // NONE
}

/**
 * Looks up the minimum good-output hours for a deployable — the
 * reluctance gate. A per-device `reluctance` (from the deployable's
 * config, in hours) takes precedence; the type default from config is
 * the fallback.
 *
 * @param {string} deployableType - "hydro", "solar-deployable", or "wind"
 * @param {object} config - Merged urgency config
 * @param {number|string} [deviceReluctance] - Per-device override: a
 *        Reluctance enum value (hours), a string key ("low"/"medium"/
 *        "high" from the config pulldown), or a raw number of hours.
 * @returns {number} Minimum good-output hours to justify deploying
 */
function minGoodOutputHoursFor(deployableType, config, deviceReluctance) {
  const resolved = resolveReluctance(deviceReluctance);
  if (resolved != null) return resolved;
  return (
    resolveReluctance(config.minGoodOutputHoursByType?.[deployableType]) ?? 1
  );
}

/**
 * Resolves a reluctance value to hours. Accepts a Reluctance enum value
 * (number), a string key ("low"/"medium"/"high"), or a raw number of hours.
 * Returns null for null/undefined/unrecognized strings.
 *
 * @param {number|string|null|undefined} value
 * @returns {number|null}
 */
function resolveReluctance(value) {
  if (value == null || Number.isNaN(value)) return null;
  if (typeof value === "number") return value;
  const key = String(value).toLowerCase();
  const match = Object.entries(Reluctance).find(
    ([k]) => k.toLowerCase() === key,
  );
  if (match) return match[1];
  const parsed = Number.parseFloat(key);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Maps a raw urgency level to the Signal K notification state and methods,
 * applying the day/night and advisory-type rules.
 *
 * Day/night:
 *  - At night, deployables use visual-only (can't safely stow in the dark,
 *    don't wake the crew). Battery `alarm`/`high` (<1h to empty) still
 *    sounds — the boat going dark is urgent regardless of time.
 *  - Daytime uses the {@link URGENCY_TO_SK} defaults.
 *
 * Navigation state (update #2):
 *  - Underway, a watch is on duty 24/7: emit at any hour, day/night only
 *    adjusts methods (above).
 *  - At rest + night: **hold** non-critical activity suggestions whose
 *    urgency is only `info`/`low` (return `null` so the caller skips
 *    publishing and the last notification stands — the suggestion is
 *    actionable at sunrise anyway). `medium`/`high`/`alarm` still emit
 *    (those are "act soon or it gets bad"), using the nighttime method
 *    table (visual-only for deployables/opportunity, sound for battery
 *    alarm/high).
 *
 * @param {string} urgency - Urgency level
 * @param {object} ctx
 * @param {boolean} [ctx.isNight] - Whether it is currently nighttime
 * @param {string} [ctx.advisoryType] - "deployable", "engine", or "opportunity"
 * @param {boolean} [ctx.isUnderway] - Whether the vessel is under way
 * @returns {{state: string, methods: string[]}|null} SK notification
 *         descriptor, or `null` to hold (skip publishing) under the
 *         at-rest + night + low-urgency gate.
 */
function urgencyToNotification(urgency, ctx = {}) {
  if (urgency === Urgency.NORMAL) return URGENCY_TO_SK[Urgency.NORMAL];

  const { isNight, advisoryType, isUnderway } = ctx;

  // At-rest + night + low-urgency (info/low) activity suggestion: hold
  // for the morning. The caller skips publishing entirely so the last
  // notification stands — we neither emit a new alert nor falsely clear
  // to "all clear". Medium+ is "act soon or it gets bad" and still emits.
  if (
    isNight &&
    !isUnderway &&
    (urgency === Urgency.INFO || urgency === Urgency.LOW)
  ) {
    return null;
  }

  const base = URGENCY_TO_SK[urgency] ?? URGENCY_TO_SK[Urgency.NORMAL];

  // Day/night method adjustment. At night we downgrade to visual-only for
  // deployables and opportunity advisories (can't safely stow/deploy in
  // the dark, and a surplus opportunity isn't worth waking the crew), but
  // keep sound for battery alarm/high (boat going dark is urgent regardless
  // of time).
  let methods = base.methods.slice();
  if (isNight) {
    if (advisoryType === "deployable") {
      // Deployables: visual-only at night (can't safely stow in the dark).
      methods = ["visual"];
    } else if (advisoryType === "engine") {
      // Battery: alarm/high (<1h to empty) still sounds at night — the
      // boat going dark is urgent regardless of time. Medium and below
      // are visual-only (can run the engine at sunrise).
      if (urgency !== Urgency.ALARM && urgency !== Urgency.HIGH) {
        methods = ["visual"];
      }
    } else if (advisoryType === "opportunity") {
      // Opportunity advisories (surplus, drag reduction) are visual-only
      // at night — they're gains, not safety; no reason to wake the crew.
      methods = ["visual"];
    }
  }

  return { state: base.state, methods };
}

/**
 * Calculates the urgency level from intensity, time, duration, and state
 * confidence.
 *
 * The score is
 * ```
 * score = (intensity*w_i + time*w_t) * durationFactor * confidenceFactor
 * ```
 * mapped to levels via `config.thresholds`, then capped by
 * `config.maxUrgencyByType[advisoryType]` and, for deploy suggestions with
 * a forecast good-output window shorter than the source's reluctance, capped
 * at `low`.
 *
 * Special cases:
 *  - A confident-enough "stowed" state returns `NORMAL` (already safe).
 *  - A transient *actual* event (duration < 2 min) caps at `INFO` — the
 *    event is over before the crew can react.
 *
 * @param {object} params
 * @param {number|null} [params.severityRatio] - currentValue / limit
 *        (null for battery/engine)
 * @param {number|null} [params.timeToActionHours] - Hours until action
 *        needed
 * @param {boolean} [params.isActual=false] - True if happening now vs
 *        forecast
 * @param {string} params.advisoryType - "deployable" or "engine"
 * @param {number|null} [params.batterySoC] - Current SoC [0–1] for engine
 *        advisories
 * @param {number|null} [params.eventDurationMinutes] - How long the
 *        condition has persisted
 * @param {string|null} [params.detectedState] - "deployed", "stowed", or
 *        null (unknown)
 * @param {string} [params.recommendedState] - "deployed" or "stowed"
 *        (the recommendation direction; used to distinguish a safety state
 *        from an activity suggestion)
 * @param {number} [params.stateConfidence] - StateConfidence value
 * @param {string} [params.deployableType] - "hydro", "solar-deployable",
 *        or "wind" (for the reluctance factor)
 * @param {number} [params.reluctance] - Per-device reluctance override
 * @param {object} [params.config] - Urgency config override
 * @returns {string} Urgency level from {@link Urgency}
 */
function calculateUrgency({
  severityRatio = null,
  timeToActionHours = null,
  isActual = false,
  advisoryType,
  batterySoC = null,
  eventDurationMinutes = null,
  detectedState = null,
  recommendedState = null,
  stateConfidence = StateConfidence.HIGH,
  deployableType = null,
  reluctance = null,
  config: override = null,
}) {
  const config = mergeConfig(override);

  // A confident-enough "stowed" state with a "stow" recommendation means
  // we're already in the safe state for the condition being warned about
  // (e.g. over-limit gusts but the FLINsail is already stowed) → no
  // urgency. This does NOT apply to a "deploy" recommendation when
  // stowed: that's an activity suggestion (missing yield), not a safety
  // state, and still warrants urgency.
  if (
    advisoryType === "deployable" &&
    recommendedState === "stowed" &&
    detectedState === "stowed" &&
    stateConfidence >= StateConfidence.MEDIUM
  ) {
    return Urgency.NORMAL;
  }

  const inten = intensityScore(
    { severityRatio, batterySoC, advisoryType },
    config,
  );
  const tScore = timeScore(timeToActionHours);
  const dFactor = durationFactorFor(eventDurationMinutes, isActual, config);

  // Transient actual events cap at info, regardless of intensity.
  if (isActual && dFactor === config.durationFactor.transient) {
    return Urgency.INFO;
  }

  // Reluctance gate for deploy suggestions (update #1, point 2): the
  // "duration" of a deploy suggestion is the forecast good-output window
  // (passed in as `eventDurationMinutes`). If the window is shorter than
  // the source's reluctance (minimum good-output hours × 60), the deploy
  // isn't worth the deck trip yet — cap at `low` (visual, no sound) so the
  // crew sees the opportunity but isn't nudged to act on a short window.
  // Hysteresis (#11) handles recommendation flapping; this handles "is
  // the window long enough to be worth acting on."
  const isDeploySuggestion =
    advisoryType === "deployable" && recommendedState === "deployed";
  let reluctanceCapped = false;
  if (isDeploySuggestion && eventDurationMinutes != null && deployableType) {
    const minMinutes =
      minGoodOutputHoursFor(deployableType, config, reluctance) * 60;
    if (eventDurationMinutes < minMinutes) reluctanceCapped = true;
  }

  const cFactor = confidenceFactorFor(
    detectedState,
    stateConfidence,
    advisoryType,
  );

  const score =
    (inten * config.weights.intensity + tScore * config.weights.time) *
    dFactor *
    cFactor;

  const th = config.thresholds;
  let urgency;
  if (score < th.normal) urgency = Urgency.NORMAL;
  else if (score < th.info) urgency = Urgency.INFO;
  else if (score < th.low) urgency = Urgency.LOW;
  else if (score < th.medium) urgency = Urgency.MEDIUM;
  else if (score < th.high) urgency = Urgency.HIGH;
  else urgency = Urgency.ALARM;

  // Cap by advisory type (deployables never reach alarm).
  const maxUrgency = config.maxUrgencyByType[advisoryType] ?? Urgency.HIGH;
  const maxIndex = URGENCY_ORDER.indexOf(maxUrgency);
  let curIndex = URGENCY_ORDER.indexOf(urgency);
  if (curIndex > maxIndex) curIndex = maxIndex;

  // Apply the reluctance cap: a short good-output window for a hard
  // source caps at `low` regardless of intensity.
  if (reluctanceCapped) {
    const capIndex = URGENCY_ORDER.indexOf(Urgency.LOW);
    if (curIndex > capIndex) curIndex = capIndex;
  }

  return URGENCY_ORDER[curIndex];
}

module.exports = {
  Urgency,
  StateConfidence,
  Reluctance,
  URGENCY_TO_SK,
  URGENCY_ORDER,
  DEFAULT_CONFIG,
  calculateUrgency,
  urgencyToNotification,
  resolveReluctance,
  mergeConfig,
};
