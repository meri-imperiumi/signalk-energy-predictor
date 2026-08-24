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
 * `calculateEngineRunTime`, `findStowageOpportunity`) can't be reused
 * directly for history because they gate on `Date.now()` (lead-time horizon)
 * and read live position/underway state. These helpers take the cycle
 * timestamp and an optional position as explicit inputs instead.
 *
 * @file advisory-recompute.js
 */

const { formatWh } = require("./format.js");
const { sunPosition, nextSunset } = require("./solar.js");

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
 * Recomputes the engine-run (deficit) advisory from a forecast track,
 * gated against the cycle timestamp. Mirrors the corrected
 * {@link PredictionEngine#calculateEngineRunTime}: the run time is the
 * energy to lift the projected minimum SoC back above the floor (not to
 * 100%), capped to the horizon, and a degenerate no-solar track is rejected
 * as a transient.
 *
 * @param {ForecastPoint[]} forecast - Hourly forecast points
 * @param {number} engineWatts - Alternator output in watts
 * @param {object} [opts]
 * @param {number} opts.minSafeSoC - Minimum safe SoC [0,1]
 * @param {number} opts.capacityWh - Battery capacity in Wh
 * @param {Date} [opts.cycleTime=new Date()] - When the cycle ran
 * @returns {{hours: number, optimalWindow: {start: Date, end: Date}}|null}
 */
function recomputeEngineRun(forecast, engineWatts, opts = {}) {
  if (!forecast || forecast.length === 0 || !engineWatts || engineWatts <= 0) {
    return null;
  }
  const { minSafeSoC, capacityWh, cycleTime = new Date() } = opts;
  if (minSafeSoC == null || capacityWh == null) return null;

  // Gate: does the track reach the floor at all?
  const reachesFloor = forecast.some((p) => p.idealSoC <= minSafeSoC);
  if (!reachesFloor) return null;

  // Degenerate transient guard: no solar at all → empty-weather glitch.
  const totalSolar = forecast.reduce(
    (sum, p) => sum + (p.idealSolarYieldWh || 0),
    0,
  );
  if (totalSolar === 0) return null;

  const minSoC = forecast.reduce((min, p) => Math.min(min, p.idealSoC), 1);
  const shortfallWh = Math.max(0, (minSafeSoC - minSoC) * capacityWh);
  if (shortfallWh === 0) return null;

  const horizonHours = forecast.length;
  const hoursNeeded =
    Math.round(Math.min(shortfallWh / engineWatts, horizonHours) * 10) / 10;

  // Optimal window: the lowest-solar hour within the run time
  let minSolarIndex = 0;
  let minSolarYield = Number.POSITIVE_INFINITY;
  const scanHours = Math.min(forecast.length, Math.ceil(hoursNeeded) + 1);
  for (let i = 0; i < scanHours; i++) {
    if (forecast[i].idealSolarYieldWh < minSolarYield) {
      minSolarYield = forecast[i].idealSolarYieldWh;
      minSolarIndex = i;
    }
  }

  const windowStart = new Date(cycleTime.getTime() + minSolarIndex * 3600000);
  const windowEnd = new Date(windowStart.getTime() + hoursNeeded * 3600000);
  return {
    hours: hoursNeeded,
    optimalWindow: { start: windowStart, end: windowEnd },
  };
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
 * @param {number} opts.engineAlternatorWatts - Alternator output (W)
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
    engineAlternatorWatts,
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

  const engine = recomputeEngineRun(forecast, engineAlternatorWatts, {
    minSafeSoC,
    capacityWh,
    cycleTime,
  });
  if (engine) {
    const { formatWindowTime } = require("./advisory.js");
    const start = formatWindowTime(
      engine.optimalWindow.start,
      undefined,
      localOffsetMinutes,
    );
    const end = formatWindowTime(
      engine.optimalWindow.end,
      undefined,
      localOffsetMinutes,
    );
    advisories.push({
      type: "engine_run",
      time: engine.optimalWindow.start.toISOString(),
      message: `Run engine for ${engine.hours}h between ${start}-${end} to avoid low battery`,
      engineHours: engine.hours,
      windowStart: engine.optimalWindow.start.toISOString(),
      windowEnd: engine.optimalWindow.end.toISOString(),
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
  recomputeEngineRun,
  recomputeStowage,
  recomputeAdvisories,
};
