/**
 * Pure recompute of the per-cycle advisories (surplus / engine-run deficit /
 * stowage) from a recorded cycle's forecast track, with no dependency on the
 * live Signal K tree or the wall clock.
 *
 * Used by the backfill CLI to retroactively populate the `advisories` array
 * on historical cycle records so the webapp's Events list can show
 * surplus/deficit history for verification — and so a transient cycle that
 * recorded a bogus advisory (e.g. an empty-weather + SoC-fallback glitch
 * producing a 24h "run the engine") gets overwritten with the corrected
 * (or null) result.
 *
 * The live prediction engine methods (`findSurplusOpportunity`,
 * `getCombustionRecommendations`, `findStowageOpportunity`) can't be reused
 * directly for history because they gate on `Date.now()` (lead-time horizon)
 * and read live position/underway state. These helpers take the cycle
 * timestamp and an optional position as explicit inputs instead.
 *
 * @file advisory-recompute.js
 */

const { formatWh } = require("./format.js");
const { sunPosition, nextSunset, nextSunrise } = require("./solar.js");
const {
  evaluateCombustionTier,
  resolveTierSettings,
} = require("./combustion.js");

/**
 * @typedef {Object} ForecastPoint
 * @property {string|Date} time - Hour timestamp
 * @property {number} idealSoC - Ideal state of charge [0,1]
 * @property {number} idealSolarYieldWh - Solar yield (Wh)
 * @property {number} idealWindYieldWh - Mechanical (wind/hydro) yield (Wh)
 * @property {number} idealNetWh - Net energy (Wh)
 * @property {number} [alternatorWh] - Alternator input (Wh)
 * @property {number} [houseLoadWh] - House load (Wh)
 */

/**
 * Recomputes the surplus-energy opportunity from a forecast track, gated
 * against the cycle timestamp (not the wall clock) and an optional position.
 *
 * Mirrors {@link PredictionEngine#findSurplusOpportunity} but is pure: the
 * lead-time horizon is measured from `cycleTime`, and day/night gating uses
 * the supplied position (falls back to "always daytime" when unknown, since
 * a missing historical position shouldn't silently suppress a surplus).
 *
 * @param {ForecastPoint[]} forecast - Hourly forecast points
 * @param {object} [opts]
 * @param {Date} [opts.cycleTime=new Date()] - When the cycle ran
 * @param {{latitude: number, longitude: number}|null} [opts.position] -
 *        Vessel position for sunset/night gating; null skips night gating
 * @param {number} [opts.fullThreshold=0.95] - SoC considered full
 * @param {number} [opts.minSurplusWh=300] - Minimum wasted energy to alert
 * @param {number} [opts.maxLeadHours=36] - Max hours from cycleTime for the
 *        window to start
 * @param {boolean} [opts.underway=false] - Whether under way (disables
 *        night gating)
 * @param {number} [opts.capacityWh=0] - Battery capacity in Wh, needed
 *        to quantify surplus from hours that spill over from a partial SoC.
 *        When 0/unknown, only hours that start with the bank already at 100%
 *        count as surplus (a conservative under-count).
 * @returns {{surplusWh: number, from: Date, to: Date, suggestedLoadW: number}|null}
 */
function recomputeSurplus(forecast, opts = {}) {
  if (!forecast || forecast.length === 0) return null;
  const {
    cycleTime = new Date(),
    position = null,
    fullThreshold = 0.95,
    minSurplusWh = 300,
    maxLeadHours = 36,
    underway = false,
    capacityWh = 0,
  } = opts;

  const maxStart = new Date(cycleTime.getTime() + maxLeadHours * 3600000);

  const fullHourIndex = forecast.findIndex((p) => p.idealSoC >= fullThreshold);
  if (fullHourIndex === -1) return null;

  const fullHour = forecast[fullHourIndex];
  const fullHourTime = new Date(fullHour.time);
  if (fullHourTime.getTime() > maxStart.getTime()) return null;

  // Day/night gating (at-rest only). Without a position we can't compute
  // the sun, so we don't gate — better to show a historical surplus than
  // silently drop it for lack of recorded position.
  if (!underway && position) {
    const sunAlt = sunPosition(
      fullHourTime,
      position.latitude,
      position.longitude ?? 0,
    ).altitude;
    if (sunAlt <= 0) return null;
    const sunset = nextSunset(
      fullHourTime,
      position.latitude,
      position.longitude ?? 0,
    );
    if (sunset) {
      const hoursToSunset =
        (sunset.getTime() - fullHourTime.getTime()) / 3600000;
      if (hoursToSunset <= 1) return null;
    }
  }

  // Surplus is *precisely* the production that would not be stored into
  // the battery because SoC is at 100%: each hour, the bank can absorb
  // (1.0 - socStartOfHour) * capacityWh before it's full, and any net yield
  // beyond that is curtailed. We read socStartOfHour directly from the
  // clamped track (the previous hour's idealSoC; the full hour's own
  // idealSoC is end-of-hour, already clamped to 1.0). Using the track's SoC
  // — rather than a parallel headroom state machine — makes the surplus
  // exact: it is whatever the prediction's own SoC clamp threw away. This
  // automatically handles the absorption tail (hours at 0.96/0.98… still
  // absorb, so not surplus) and overnight drawdowns (clamped SoC drops, so
  // next-morning solar has real headroom and refills, not surplus) without
  // the over-counting of the old one-time tail grant.
  const startSoC = forecast[0].idealSoC;
  let surplusWh = 0;
  let firstSurplusIndex = -1;
  let lastSurplusIndex = -1;
  for (let i = fullHourIndex; i < forecast.length; i++) {
    const p = forecast[i];
    const net =
      (p.idealSolarYieldWh || 0) +
      (p.idealWindYieldWh || 0) +
      (p.alternatorWh || 0) -
      (p.houseLoadWh != null ? p.houseLoadWh : 0);
    if (net <= 0) continue; // not producing → nothing to curtail
    const socStartOfHour = i > 0 ? forecast[i - 1].idealSoC : startSoC;
    // Headroom the bank can absorb before hitting 100%: (1.0 - socStartOfHour)
    // * capacity. When capacity is unknown, the only case we can be certain
    // about is a bank already at 1.0 (headroom 0) — anything below 1.0 has
    // real headroom we can't quantify, so we conservatively treat it as no
    // curtailment rather than risk over-counting (the prior bug).
    const headroom =
      socStartOfHour >= 1.0
        ? 0
        : capacityWh > 0
          ? Math.max(0, (1.0 - socStartOfHour) * capacityWh)
          : net; // unknown capacity → assume the whole hour absorbs
    const curtailed = Math.max(0, net - headroom);
    if (curtailed > 0) {
      surplusWh += curtailed;
      if (firstSurplusIndex === -1) firstSurplusIndex = i;
      lastSurplusIndex = i;
    }
  }

  if (surplusWh < minSurplusWh || lastSurplusIndex < 0) return null;

  const from = new Date(forecast[firstSurplusIndex].time);
  const to = new Date(
    new Date(forecast[lastSurplusIndex].time).getTime() + 3600000,
  );
  // Sustained wattage: average curtailed power over the window hours
  const windowHours = Math.max(1, (to.getTime() - from.getTime()) / 3600000);
  const suggestedLoadW = Math.round(surplusWh / windowHours);

  return { surplusWh: Math.round(surplusWh), from, to, suggestedLoadW };
}

/**
 * Recomputes the combustion run advisories (genset/engine deficit
 * response, #11) from a forecast track, gated against the cycle
 * timestamp. Mirrors the live tier evaluation
 * ({@link module:combustion~evaluateCombustionTier}): sustained-violation
 * gate, minimum useful run, batch margin, horizon cap, and the
 * degenerate no-solar transient guard.
 *
 * @param {ForecastPoint[]} forecast - Hourly forecast points
 * @param {Array<{id: string, name?: string, alternatorWatts: number}>} engines -
 *        Configured engines (largest alternator wins the recommendation)
 * @param {Array<{id: string, name?: string, outputWatts: number}>} gensets -
 *        Configured gensets (largest output wins the recommendation)
 * @param {object} [opts]
 * @param {number} opts.minSafeSoC - Minimum safe SoC [0,1]
 * @param {number} opts.capacityWh - Battery capacity in Wh
 * @param {Date} [opts.cycleTime=new Date()] - When the cycle ran
 * @param {object} [opts.combustion] - Per-tier settings overrides
 * @param {{latitude: number, longitude: number}|null} [opts.position] -
 *        Vessel position for the engine tier's night hold
 * @returns {Array<{source: object, tier: "genset"|"engine", result: object}>}
 */
function recomputeCombustion(forecast, engines, gensets, opts = {}) {
  if (!forecast || forecast.length === 0) return [];
  const {
    minSafeSoC,
    capacityWh,
    cycleTime = new Date(),
    combustion = {},
    position = null,
  } = opts;
  if (minSafeSoC == null || capacityWh == null) return [];

  // Night context for the engine tier's night hold, from the recorded
  // position when available.
  let isNight = false;
  let sunrise = null;
  if (position && position.latitude != null) {
    isNight =
      sunPosition(cycleTime, position.latitude, position.longitude ?? 0)
        .altitude <= 0;
    sunrise = nextSunrise(
      cycleTime,
      position.latitude,
      position.longitude ?? 0,
    );
  }

  const evaluate = (sources, tier, wattsOf) => {
    const settings = resolveTierSettings(tier, combustion?.[tier]);
    return sources
      .map((source) => ({
        source,
        tier,
        result: evaluateCombustionTier({
          track: forecast,
          minSafeSoC,
          capacityWh,
          watts: wattsOf(source),
          settings,
          currentSoC: forecast[0]?.idealSoC,
          now: cycleTime,
          isNight,
          sunrise,
        }),
      }))
      .filter(
        (x) => x.result != null && x.result.recommendedState === "deployed",
      )
      .sort((a, b) => wattsOf(b.source) - wattsOf(a.source));
  };

  const out = [];
  const gensetRuns = evaluate(gensets, "genset", (g) => g.outputWatts);
  if (gensetRuns.length > 0) out.push(gensetRuns[0]);
  const engineRuns = evaluate(engines, "engine", (e) => e.alternatorWatts);
  if (engineRuns.length > 0) out.push(engineRuns[0]);
  return out;
}

/**
 * Recomputes the stowage (drag-reduction) opportunity from a forecast track.
 * Mirrors {@link PredictionEngine#findStowageOpportunity}: mechanicals are
 * active and the deficit is covered with enough remaining solar.
 *
 * @param {ForecastPoint[]} forecast - Hourly forecast points
 * @param {object} opts
 * @param {number} opts.minSafeSoC - Minimum safe SoC [0,1]
 * @param {number} opts.capacityWh - Battery capacity in Wh
 * @param {number} [opts.currentSoC] - SoC at cycle time [0,1]; defaults to
 *        the first forecast point's idealSoC
 * @returns {{hour: number, reason: string}|null}
 */
function recomputeStowage(forecast, opts = {}) {
  if (!forecast || forecast.length === 0) return null;
  const { minSafeSoC, capacityWh, currentSoC } = opts;
  if (minSafeSoC == null || capacityWh == null) return null;

  const startSoC = currentSoC != null ? currentSoC : forecast[0].idealSoC;
  const deficit = (1 - startSoC) * capacityWh;

  let cumulativeNet = 0;
  let mechanicalActive = false;
  for (let i = 0; i < forecast.length; i++) {
    const p = forecast[i];
    if (p.idealWindYieldWh > 0) mechanicalActive = true;
    cumulativeNet += p.idealNetWh;
    if (mechanicalActive && cumulativeNet >= deficit) {
      const remainingSolar = forecast
        .slice(i)
        .reduce((sum, rp) => sum + (rp.idealSolarYieldWh || 0), 0);
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
 * Recomputes all three advisories for a recorded cycle and returns them in
 * the recorded shape (matching `buildCycleAdvisories`), so the backfill can
 * write them straight into the cycle record's `advisories` field.
 *
 * @param {ForecastPoint[]} forecast - The cycle's hourly forecast points
 * @param {object} opts
 * @param {Date} opts.cycleTime - When the cycle ran
 * @param {number} opts.minSafeSoC - Battery floor [0,1]
 * @param {number} opts.capacityWh - Battery capacity (Wh)
 * @param {Array<{id: string, name?: string, alternatorWatts: number}>} [opts.engines=[]] - Configured engines
 * @param {Array<{id: string, name?: string, outputWatts: number}>} [opts.gensets=[]] - Configured gensets
 * @param {object} [opts.combustion={}] - Per-tier run-discipline settings
 * @param {{latitude: number, longitude: number}|null} [opts.position] - Vessel position
 * @param {boolean} [opts.underway=false] - Under way (disables surplus night gate)
 * @param {number|null} [opts.localOffsetMinutes=null] - Solar-local UTC offset
 * @param {Array<{name: string, watts: number}>} [opts.opportunisticLoads=[]]
 * @returns {Array<object>} Advisories in the recorded shape
 */
function recomputeAdvisories(forecast, opts) {
  const {
    cycleTime,
    minSafeSoC,
    capacityWh,
    engines = [],
    gensets = [],
    combustion = {},
    position,
    underway = false,
    localOffsetMinutes = null,
    opportunisticLoads = [],
  } = opts;

  const advisories = [];
  const surplus = recomputeSurplus(forecast, {
    cycleTime,
    position,
    underway,
    capacityWh,
  });
  if (surplus) {
    // Reuse the live message format via the same formatting the recorder uses.
    // Inline rather than importing buildCycleAdvisories (which is in index.js
    // and pulls the whole plugin) to keep this module dependency-light.
    const { formatWindowTime } = require("./advisory.js");
    const from = formatWindowTime(surplus.from, undefined, localOffsetMinutes);
    const to = formatWindowTime(surplus.to, surplus.from, localOffsetMinutes);
    let message = `${formatWh(surplus.surplusWh)} surplus available ${from}-${to}`;
    if (surplus.suggestedLoadW > 0) {
      message += ` (~${surplus.suggestedLoadW}W sustained)`;
    }
    const windowHours =
      (surplus.to.getTime() - surplus.from.getTime()) / (3600 * 1000);
    const loads = (opportunisticLoads || [])
      .filter((l) => l.watts > 0)
      .map((l) => ({
        name: l.name,
        watts: l.watts,
        runHours:
          Math.round(Math.min(windowHours, surplus.surplusWh / l.watts) * 10) /
          10,
      }));
    advisories.push({
      type: "surplus",
      time: surplus.from.toISOString(),
      message,
      surplusWh: surplus.surplusWh,
      from: surplus.from.toISOString(),
      to: surplus.to.toISOString(),
      sustainedW: surplus.suggestedLoadW,
      loads,
    });
  }

  for (const run of recomputeCombustion(forecast, engines, gensets, {
    minSafeSoC,
    capacityWh,
    cycleTime,
    combustion,
    position,
  })) {
    const { formatWindowTime } = require("./advisory.js");
    const { source, tier, result } = run;
    const name = source.name || (tier === "genset" ? "genset" : "engine");
    const start = formatWindowTime(
      result.windowStart,
      undefined,
      localOffsetMinutes,
    );
    const end = formatWindowTime(
      result.windowEnd,
      undefined,
      localOffsetMinutes,
    );
    advisories.push({
      type: tier === "genset" ? "genset_run" : "engine_run",
      sourceId: source.id,
      time: result.windowStart.toISOString(),
      message: `Run ${name} for ${result.runHours}h between ${start}-${end} to avoid low battery`,
      engineHours: result.runHours,
      windowStart: result.windowStart.toISOString(),
      windowEnd: result.windowEnd.toISOString(),
    });
  }

  const stowage = recomputeStowage(forecast, {
    minSafeSoC,
    capacityWh,
    currentSoC: forecast[0]?.idealSoC,
  });
  if (stowage) {
    advisories.push({
      type: "stow_soon",
      time: cycleTime.toISOString(),
      message: `Stow mechanical generators in ${stowage.hour}h to reduce drag - ${stowage.reason}`,
      inHours: stowage.hour,
      reason: stowage.reason,
    });
  }

  return advisories;
}

module.exports = {
  recomputeSurplus,
  recomputeCombustion,
  recomputeStowage,
  recomputeAdvisories,
};
