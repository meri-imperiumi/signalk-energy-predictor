/**
 * Combustion sources (genset, main engine) as high-reluctance deployable
 * generators (#11).
 *
 * The engine+alternator and a dedicated genset are modeled as deployable
 * generators with a **reluctance tier** — a cost-class ordering:
 *
 *   1. renewables (solar, wind, hydro) — always preferred when available
 *   2. genset — the designated charger; fuel cost and low-load wear remain
 *      (batch/minimum-run discipline applies), but night runs and
 *      at-anchor charging are unremarkable for it
 *   3. main engine/alternator — highest reluctance: noise at anchor,
 *      propulsion-hours wear, low-load wear; the last resort
 *
 * Deployment is gated per tier so a deficit escalates gradually instead of
 * jumping to the engine:
 *
 *   - Sustained violation: the projected SoC must be below `minSafeSoC`
 *     for ≥ N consecutive forecast hours (N per tier), so a marginal
 *     midnight dip doesn't trigger a run. A bank that is *already* below
 *     the floor is an actual violation and deploys immediately.
 *   - No renewable recovery path: the ideal SoC track already nets
 *     forecast renewables against the load, so any below-floor dip in the
 *     track is by definition a deficit renewables cannot cover in time.
 *   - Minimum useful run: the shortfall must be worth at least
 *     `minRunMinutes` at the source's output — never start an engine for
 *     8 minutes.
 *
 * Once running, the source finishes its batch (run until SoC ≥
 * `minSafeSoC + socMargin`, never shorter than `minRunMinutes`), and after
 * a detected run ends, new run recommendations are suppressed for
 * `cooldownHours` (engines dislike frequent cold starts).
 *
 * All functions here are pure (no Signal K, no wall clock unless passed),
 * so they can be unit-tested and reused by the backfill recompute.
 *
 * @file combustion.js
 */

const { resolveReluctance, Reluctance } = require("./urgency.js");

/**
 * Default per-tier settings. The genset deploys at a *lower* deficit
 * threshold than the main engine (it's what it's for); the engine keeps
 * the strict "really really needed" criteria, including holding at night
 * when the SoC floor won't be breached before sunrise (prefer waiting for
 * the morning solar window).
 */
const DEFAULT_TIER_SETTINGS = {
  genset: {
    sustainedHours: 2,
    minRunMinutes: 45,
    cooldownHours: 2,
    socMargin: 0.05,
    nightHold: false,
  },
  engine: {
    sustainedHours: 3,
    minRunMinutes: 60,
    cooldownHours: 6,
    socMargin: 0.1,
    nightHold: true,
  },
};

/**
 * Default flip-cooldown hours per reluctance level — the renewables
 * hysteresis band (#11). Matches the urgency module's reluctance values
 * (minimum good-output hours): a low-reluctance source (hydro) responds
 * to marginal swings, a high-reluctance source (wind generator) gets a
 * wide band so we don't keep nagging to deploy/stow it for transient
 * conditions.
 */
const DEFAULT_FLIP_COOLDOWN_HOURS = 2;

/**
 * Merges user tier settings over the defaults for a tier ("genset" or
 * "engine"). Only numeric leaves the user supplied override; anything
 * invalid falls back to the default.
 *
 * @param {string} tier - "genset" or "engine"
 * @param {object} [userSettings] - User config for this tier
 * @returns {object} Resolved settings
 */
function resolveTierSettings(tier, userSettings) {
  const defaults = DEFAULT_TIER_SETTINGS[tier] || DEFAULT_TIER_SETTINGS.engine;
  const out = { ...defaults };
  if (userSettings && typeof userSettings === "object") {
    for (const key of Object.keys(defaults)) {
      const v = userSettings[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        out[key] = v;
      } else if (typeof v === "boolean" && typeof defaults[key] === "boolean") {
        out[key] = v;
      }
    }
  }
  return out;
}

/**
 * Rounds hours to 0.1h (the precision the advisories display).
 * @param {number} h
 * @returns {number}
 */
function roundHours(h) {
  return Math.round(h * 10) / 10;
}

/**
 * Evaluates whether a combustion source should run (deploy) now.
 *
 * @param {object} params
 * @param {Array<{time: Date|string, idealSoC: number, idealSolarYieldWh?: number}>} params.track -
 *        Hourly ideal-track points (the prediction engine's
 *        `lastPrediction`); SoC must already net forecast renewables
 * @param {number} params.minSafeSoC - Battery floor [0–1]
 * @param {number} params.capacityWh - Battery capacity in Wh
 * @param {number} params.watts - Source output in watts
 * @param {object} params.settings - Resolved tier settings
 *        (see {@link DEFAULT_TIER_SETTINGS})
 * @param {number|null} [params.currentSoC] - Live SoC [0–1]; a bank
 *        already below the floor is an actual violation (immediate)
 * @param {boolean} [params.running=false] - Whether the source is
 *        detected running now (batching applies instead of deploy gating)
 * @param {Date|null} [params.runningSince=null] - When the current run
 *        started (batch minimum-run accounting)
 * @param {Date|null} [params.lastRunEnd=null] - When the previous run
 *        ended (cooldown suppression)
 * @param {Date} [params.now=new Date()] - Current time
 * @param {boolean} [params.isNight=false] - Whether it is currently night
 *        (night-hold gate)
 * @param {Date|null} [params.sunrise=null] - Next sunrise; when null the
 *        night-hold gate is skipped (position unknown)
 * @returns {{recommendedState: "deployed"|"stowed", reason: string, runHours: number|null, windowStart: Date|null, windowEnd: Date|null}|null}
 *          Recommendation, or null when no run is warranted. A running
 *          source returns "deployed" (keep running) until its batch is
 *          complete, then "stowed" (stop).
 */
function evaluateCombustionTier({
  track,
  minSafeSoC,
  capacityWh,
  watts,
  settings,
  currentSoC = null,
  running = false,
  runningSince = null,
  lastRunEnd = null,
  now = new Date(),
  isNight = false,
  sunrise = null,
}) {
  if (!track || track.length === 0 || !watts || watts <= 0) return null;
  if (minSafeSoC == null || capacityWh == null) return null;

  // Degenerate-forecast transient guard (mirrors calculateEngineRunTime):
  // a track with zero solar at all is the signature of a shunt-synchronize
  // / empty-weather transient, not a discharge worth nagging about.
  const totalSolar = track.reduce(
    (sum, p) => sum + (p.idealSolarYieldWh || 0),
    0,
  );
  if (totalSolar === 0) return null;

  const floorPct = Math.round(minSafeSoC * 100);

  // --- Running source: batching --------------------------------------
  if (running) {
    const socPct = currentSoC != null ? Math.round(currentSoC * 100) : null;
    const elapsedMinutes =
      runningSince != null
        ? Math.max(
            0,
            (now.getTime() - new Date(runningSince).getTime()) / 60000,
          )
        : null;
    const socReached =
      currentSoC != null && currentSoC >= minSafeSoC + settings.socMargin;
    const minRunReached =
      elapsedMinutes == null || elapsedMinutes >= settings.minRunMinutes;
    if (socReached && minRunReached) {
      return {
        recommendedState: "stowed",
        reason: `batch complete — bank at ${socPct}%`,
        runHours: null,
        windowStart: null,
        windowEnd: null,
      };
    }
    const parts = [];
    if (!socReached) {
      parts.push(
        `bank at ${socPct ?? "?"}% (target ${floorPct + Math.round(settings.socMargin * 100)}%)`,
      );
    }
    if (!minRunReached && elapsedMinutes != null) {
      parts.push(
        `${Math.round(elapsedMinutes)} of ${settings.minRunMinutes}min minimum run`,
      );
    }
    return {
      recommendedState: "deployed",
      reason: `keep running to finish the batch — ${parts.join(", ")}`,
      runHours: null,
      windowStart: null,
      windowEnd: null,
    };
  }

  // --- Cooldown after a detected run ---------------------------------
  if (
    lastRunEnd != null &&
    (now.getTime() - new Date(lastRunEnd).getTime()) / 3600000 <
      settings.cooldownHours
  ) {
    return null;
  }

  // --- Deficit gating -------------------------------------------------
  const firstViolation = track.findIndex((p) => p.idealSoC < minSafeSoC);
  if (firstViolation === -1) return null; // Battery won't reach the floor

  const belowFloorNow =
    currentSoC != null && currentSoC <= minSafeSoC ? true : false;

  // Sustained-violation gate: N consecutive below-floor hours (an actual
  // violation — bank already below the floor — is urgent regardless).
  let consecutive = 0;
  for (let i = firstViolation; i < track.length; i++) {
    if (track[i].idealSoC < minSafeSoC) consecutive++;
    else break;
  }
  if (!belowFloorNow && consecutive < settings.sustainedHours) return null;

  // Night hold (engine): at night, prefer waiting for the morning solar
  // window when the SoC floor isn't breached before sunrise. Only applies
  // to a *forecast* violation — a bank already below the floor at night
  // cannot wait for sunrise.
  if (settings.nightHold && isNight && sunrise != null && !belowFloorNow) {
    const violationTime = new Date(track[firstViolation].time);
    if (violationTime.getTime() > new Date(sunrise).getTime()) {
      return null;
    }
  }

  // Energy needed to lift the projected minimum SoC to floor + margin
  // (batching: recover past the floor, never a marginal top-up).
  const minSoC = track.reduce((min, p) => Math.min(min, p.idealSoC), 1);
  const targetSoC = minSafeSoC + settings.socMargin;
  const shortfallWh = Math.max(0, (targetSoC - minSoC) * capacityWh);
  if (shortfallWh === 0) return null;

  // Minimum useful run: never start the source for a few minutes.
  const minUsefulWh = watts * (settings.minRunMinutes / 60);
  if (shortfallWh < minUsefulWh) return null;

  // Run length: cover the shortfall, capped to the forecast horizon.
  const horizonHours = track.length;
  const hours = roundHours(Math.min(shortfallWh / watts, horizonHours));

  // Optimal window: the lowest-solar period within the run time (don't
  // run while the sun could carry the charge instead).
  let minSolarIndex = 0;
  let minSolarYield = Number.POSITIVE_INFINITY;
  const scanHours = Math.min(track.length, Math.ceil(hours) + 1);
  for (let i = 0; i < scanHours; i++) {
    if ((track[i].idealSolarYieldWh || 0) < minSolarYield) {
      minSolarYield = track[i].idealSolarYieldWh || 0;
      minSolarIndex = i;
    }
  }
  const windowStart = new Date(track[minSolarIndex].time);
  const windowEnd = new Date(windowStart.getTime() + hours * 3600000);

  return {
    recommendedState: "deployed",
    reason: belowFloorNow
      ? `bank already below the ${floorPct}% floor`
      : `bank projected below the ${floorPct}% floor for ${consecutive}h`,
    runHours: hours,
    windowStart,
    windowEnd,
  };
}

/**
 * Updates the per-source run-transition state from detected states.
 *
 * A stowed→deployed transition stamps `runningSince` (batch minimum-run
 * accounting); deployed→stowed stamps `lastRunEnd` (cooldown). Mutates the
 * map in place — the caller owns its lifecycle across cycles.
 *
 * @param {Map<string, {runningSince: Date|null, lastRunEnd: Date|null}>} runs -
 *        Per-source run state (keyed by source id)
 * @param {Map<string, string|null>} detectedStates - Detected state per
 *        source id ("deployed" = running)
 * @param {Date} [now=new Date()]
 * @returns {void}
 */
function updateCombustionRuns(runs, detectedStates, now = new Date()) {
  for (const [id, state] of detectedStates) {
    if (state !== "deployed" && state !== "stowed") continue;
    const r = runs.get(id) || { runningSince: null, lastRunEnd: null };
    if (state === "deployed") {
      if (r.runningSince == null) r.runningSince = now;
    } else if (r.runningSince != null) {
      r.lastRunEnd = now;
      r.runningSince = null;
    }
    runs.set(id, r);
  }
}

/**
 * Reads a numeric value from a possibly Signal K-wrapped reading.
 * @param {unknown} v
 * @returns {number|null}
 */
function toNumber(v) {
  if (v && typeof v === "object" && typeof v.value === "number") v = v.value;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Detects whether a propulsion engine is currently running, from its
 * Signal K propulsion instance (e.g. "main", "port", "starboard").
 *
 * `propulsion.<id>.state` === "started" or revolutions > 0 means running;
 * definite signals that say neither mean stopped; no signals at all mean
 * unknown (null). Engines are propulsion first — this only detects, it
 * never recommends running an engine whose `alternatorWatts` is 0
 * (electric drives are consumers, not generators).
 *
 * @param {object} engine - Engine config (id / propulsionId)
 * @param {(path: string) => unknown} getSelfPath - Signal K read function
 * @returns {boolean|null}
 */
function detectEngineRunning(engine, getSelfPath) {
  const inst = engine.propulsionId || engine.id;
  if (!inst) return null;
  let anySignal = false;
  const rawState = getSelfPath(`propulsion.${inst}.state`);
  if (rawState != null) {
    anySignal = true;
    const v =
      typeof rawState === "object" && "value" in rawState
        ? rawState.value
        : rawState;
    if (v === "started") return true;
  }
  const rpm = toNumber(getSelfPath(`propulsion.${inst}.revolutions`));
  if (rpm != null) {
    anySignal = true;
    if (rpm > 0) return true;
  }
  return anySignal ? false : null;
}

/**
 * Detects whether a genset is currently running.
 *
 * A `statePath` (string state or boolean) wins; otherwise a `powerPath`
 * with positive watts means running, exactly zero means stopped. Unknown
 * readings return null (no evidence).
 *
 * @param {object} genset - Genset config (statePath, onValues, powerPath)
 * @param {(path: string) => unknown} getSelfPath - Signal K read function
 * @returns {boolean|null}
 */
function resolveGensetRunning(genset, getSelfPath) {
  if (genset.statePath) {
    const raw = getSelfPath(genset.statePath);
    if (raw != null) {
      const v =
        typeof raw === "object" && raw != null && "value" in raw
          ? raw.value
          : raw;
      if (typeof v === "boolean") return v;
      if (v != null) {
        const s = String(v).toLowerCase().trim();
        if (s !== "") {
          const onValues =
            genset.onValues != null && genset.onValues !== ""
              ? genset.onValues
              : "started,on,online,running,active";
          const accepted = onValues
            .toLowerCase()
            .split(",")
            .map((x) => x.trim())
            .filter((x) => x !== "");
          return accepted.includes(s);
        }
      }
    }
  }
  if (genset.powerPath) {
    const w = toNumber(getSelfPath(genset.powerPath));
    if (w != null) return w > 0;
  }
  return null;
}

/**
 * Resolves the renewables flip-cooldown (hysteresis band) in hours for a
 * deployable. An explicit per-device `flipCooldownHours` wins; otherwise
 * the device's `reluctance` (low/medium/high, or raw hours) is used —
 * reluctance widens the hysteresis band (#11).
 *
 * @param {number|string|null} reluctance - Per-device reluctance
 * @param {number|null} [flipCooldownHours] - Explicit per-device override
 * @returns {number} Cooldown hours
 */
function flipCooldownHoursFor(reluctance, flipCooldownHours) {
  if (
    typeof flipCooldownHours === "number" &&
    Number.isFinite(flipCooldownHours) &&
    flipCooldownHours >= 0
  ) {
    return flipCooldownHours;
  }
  const fromReluctance = resolveReluctance(reluctance);
  if (fromReluctance != null && fromReluctance >= 0) return fromReluctance;
  return DEFAULT_FLIP_COOLDOWN_HOURS;
}

module.exports = {
  DEFAULT_TIER_SETTINGS,
  DEFAULT_FLIP_COOLDOWN_HOURS,
  resolveTierSettings,
  evaluateCombustionTier,
  updateCombustionRuns,
  resolveGensetRunning,
  detectEngineRunning,
  flipCooldownHoursFor,
  Reluctance,
};
