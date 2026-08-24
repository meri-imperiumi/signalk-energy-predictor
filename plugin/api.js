/**
 * REST API for recorded predictions and measured values.
 *
 * Read-only endpoints under the plugin router root
 * (`/plugins/<id>/api/...`), all taking ISO-8601 `from`/`to` query
 * parameters with a capped window length:
 *
 * - `GET /api/predictions` — recorded prediction cycles (day window:
 *   raw cycle forecasts; week/month: daily predicted totals per source)
 * - `GET /api/actuals` — measured series with server-side downsampling
 *   and trapezoidal W→Wh integration for totals
 * - `GET /api/environment` — wind samples alongside the recordings
 * - `GET /api/summary` — headline figures including prediction accuracy
 *
 * @file api.js
 */

/**
 * Maximum query window length in days (bounds file scans).
 */
const MAX_WINDOW_DAYS = 92;

/**
 * Windows up to this length return raw 5-minute samples.
 */
const RAW_WINDOW_DAYS = 2;

/**
 * Windows up to this length downsample to 15-minute averages.
 */
const QUARTER_HOUR_WINDOW_DAYS = 16;

/** Milliseconds per hour */
const MS_PER_HOUR = 3600000;

/** Milliseconds per day */
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** @returns {number} Solar-local UTC offset in minutes from a longitude. */
const solarOffsetMinutesFromLongitude = (longitude) => {
  if (longitude == null || Number.isNaN(longitude)) return null;
  return Math.round((longitude / 15) * 60);
};

/**
 * Derives the vessel's solar-local UTC offset (minutes) from recorded
 * sample positions, taking the most recent in-window sample with a
 * usable longitude. Used to key advisory dedup on the solar-local calendar
 * day (sun-day) rather than UTC, so a surplus window straddling the UTC
 * midnight boundary doesn't split into two events.
 * @param {object[]} samples - Recorded sample records
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @returns {number|null} offset in minutes, or null if no position
 */
function offsetMinutesFromSamples(samples, from, to) {
  let best = null;
  let bestMs = -Infinity;
  for (const s of samples) {
    const tMs = new Date(s.timestamp).getTime();
    if (Number.isNaN(tMs) || tMs < from.getTime() || tMs > to.getTime()) {
      continue;
    }
    const lon = s.position?.longitude;
    if (lon == null || Number.isNaN(lon)) continue;
    if (tMs > bestMs) {
      bestMs = tMs;
      best = lon;
    }
  }
  return solarOffsetMinutesFromLongitude(best);
}

/**
 * API error carrying an HTTP status code.
 */
class ApiError extends Error {
  /**
   * @param {number} status - HTTP status code
   * @param {string} message - Error description
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Parses and validates the `from`/`to` query parameters.
 *
 * @param {object} query - Express query object
 * @param {string} [query.from] - ISO-8601 start timestamp (inclusive)
 * @param {string} [query.to] - ISO-8601 end timestamp (inclusive)
 * @returns {{from: Date, to: Date}} Validated window
 * @throws {ApiError} 400 on missing, unparsable or oversized windows
 */
function parseTimeWindow(query) {
  const { from, to } = query || {};
  if (!from || !to) {
    throw new ApiError(
      400,
      "Both 'from' and 'to' query parameters are required",
    );
  }
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new ApiError(400, "'from' and 'to' must be ISO-8601 timestamps");
  }
  if (fromDate >= toDate) {
    throw new ApiError(400, "'from' must be before 'to'");
  }
  if (toDate - fromDate > MAX_WINDOW_DAYS * MS_PER_DAY) {
    throw new ApiError(
      400,
      `Query window must not exceed ${MAX_WINDOW_DAYS} days`,
    );
  }
  return { from: fromDate, to: toDate };
}

/**
 * Downsampling granularity for a query window.
 *
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @returns {{intervalMs: number|null, label: string}} Bucket interval
 *   (null = raw samples) and a human-readable label
 */
function granularityForWindow(from, to) {
  const spanDays = (to - from) / MS_PER_DAY;
  if (spanDays <= RAW_WINDOW_DAYS) {
    return { intervalMs: null, label: "5min" };
  }
  if (spanDays <= QUARTER_HOUR_WINDOW_DAYS) {
    return { intervalMs: 15 * 60000, label: "15min" };
  }
  return { intervalMs: MS_PER_HOUR, label: "60min" };
}

/**
 * Indexes configured devices by yield source from plugin configuration.
 *
 * @param {object|null} config - Plugin configuration
 * @param {object[]} [config.solarArrays] - Solar array configurations
 * @param {object[]} [config.mechanicalGenerators] - Generator configurations
 * @returns {{solarIds: Set<string>, windIds: Set<string>, hydroIds: Set<string>}}
 */
function sourceTypesFromConfig(config) {
  const solarIds = new Set((config?.solarArrays || []).map((a) => a.id));
  const windIds = new Set();
  const hydroIds = new Set();
  for (const gen of config?.mechanicalGenerators || []) {
    if (gen.type === "wind") {
      windIds.add(gen.id);
    } else if (gen.type === "hydro") {
      hydroIds.add(gen.id);
    }
  }
  return { solarIds, windIds, hydroIds };
}

/**
 * Resolves the navigation state for a retro-predicted hour.
 *
 * `stateAt` returns the latest sample at or before the hour, or null before
 * the first recorded sample. A hardcoded "anchored" default would let a
 * deployable wind generator (which only produces at anchor — or moored when
 * allowed) spuriously predict yield for the gap hours at the start of the
 * window when the vessel is actually moored. Fall back to the first sample's
 * state instead, assuming state continuity up to the first observation.
 *
 * @param {object|null} state - Sample at or before the hour, or null
 * @param {object[]} sorted - Samples sorted ascending by timestamp
 * @returns {string} Resolved navigation state
 */
function resolveNavState(state, sorted) {
  return state?.navState ?? sorted?.[0]?.navState ?? "anchored";
}

/**
 * Converts a recorded sample into a normalized actuals point with
 * per-source power in watts.
 *
 * @param {object} sample - Recorded sample record
 * @param {{solarIds: Set<string>, windIds: Set<string>, hydroIds: Set<string>}} sourceTypes
 * @returns {{time: string, solarW: number, windW: number, hydroW: number, houseLoadW: number, soc: number|null, windSpeedKnots: number|null, navState: string|null}}
 */
function sampleToActualPoint(sample, sourceTypes) {
  const sumPower = (ids, readings) => {
    let total = 0;
    for (const id of ids) {
      const v = readings?.[id];
      if (typeof v === "number" && v > 0) {
        total += v;
      }
    }
    return total;
  };
  return {
    time: sample.timestamp,
    solarW: sumPower(sourceTypes.solarIds, sample.arrays),
    windW: sumPower(sourceTypes.windIds, sample.generators),
    hydroW: sumPower(sourceTypes.hydroIds, sample.generators),
    houseLoadW: typeof sample.houseLoadW === "number" ? sample.houseLoadW : 0,
    soc: typeof sample.soc === "number" ? sample.soc : null,
    windSpeedKnots:
      typeof sample.windSpeedKnots === "number" ? sample.windSpeedKnots : null,
    navState: sample.navState ?? null,
  };
}

/**
 * Rounds a timestamp down to the hour.
 *
 * @param {Date|string} time - Timestamp
 * @returns {number} Hour bucket start in epoch milliseconds
 */
function hourBucket(time) {
  const ms = time instanceof Date ? time.getTime() : new Date(time).getTime();
  return Math.floor(ms / MS_PER_HOUR) * MS_PER_HOUR;
}

/**
 * Trapezoidal integration of power samples into watt-hours, attributed
 * to the hour bucket of each interval midpoint.
 *
 * Energy between two samples five minutes apart undercounts gaps (no
 * interpolation across missing samples); with regular 5-minute recording
 * the effect is negligible.
 *
 * @param {object[]} points - Actuals points sorted by time
 * @param {string[]} fields - Power fields to integrate
 * @returns {Map<number, object>} Hour bucket → per-field Wh
 */
function integratePerHour(points, fields) {
  const result = new Map();
  const ensure = (bucket) => {
    let entry = result.get(bucket);
    if (!entry) {
      entry = Object.fromEntries(fields.map((f) => [f, 0]));
      result.set(bucket, entry);
    }
    return entry;
  };

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const t0 = new Date(prev.time).getTime();
    const t1 = new Date(curr.time).getTime();
    if (!(t1 > t0)) {
      continue;
    }
    const hours = (t1 - t0) / MS_PER_HOUR;
    const bucket = hourBucket(new Date((t0 + t1) / 2));
    const entry = ensure(bucket);
    for (const field of fields) {
      entry[field] += (((prev[field] || 0) + (curr[field] || 0)) / 2) * hours;
    }
  }
  return result;
}

/**
 * Downsamples actuals points into fixed time buckets, averaging numeric
 * fields and carrying the last observed value for state fields.
 *
 * @param {object[]} points - Actuals points sorted by time
 * @param {number} intervalMs - Bucket length in milliseconds
 * @returns {object[]} Downsampled points
 */
function downsamplePoints(points, intervalMs) {
  const buckets = new Map();
  for (const p of points) {
    const bucket =
      Math.floor(new Date(p.time).getTime() / intervalMs) * intervalMs;
    let entry = buckets.get(bucket);
    if (!entry) {
      entry = {
        bucket,
        count: 0,
        sums: { solarW: 0, windW: 0, hydroW: 0, houseLoadW: 0 },
        socSum: 0,
        socCount: 0,
        windSum: 0,
        windCount: 0,
        navState: null,
      };
      buckets.set(bucket, entry);
    }
    entry.count++;
    for (const field of Object.keys(entry.sums)) {
      entry.sums[field] += p[field] || 0;
    }
    if (p.soc != null) {
      entry.socSum += p.soc;
      entry.socCount++;
    }
    if (p.windSpeedKnots != null) {
      entry.windSum += p.windSpeedKnots;
      entry.windCount++;
    }
    if (p.navState != null) {
      entry.navState = p.navState;
    }
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.bucket - b.bucket)
    .map((entry) => ({
      time: new Date(entry.bucket).toISOString(),
      solarW: entry.sums.solarW / entry.count,
      windW: entry.sums.windW / entry.count,
      hydroW: entry.sums.hydroW / entry.count,
      houseLoadW: entry.sums.houseLoadW / entry.count,
      soc: entry.socCount > 0 ? entry.socSum / entry.socCount : null,
      windSpeedKnots:
        entry.windCount > 0 ? entry.windSum / entry.windCount : null,
      navState: entry.navState,
    }));
}

/**
 * Builds the /api/actuals response.
 *
 * @param {object[]} samples - Recorded samples within the window
 * @param {{solarIds: Set<string>, windIds: Set<string>, hydroIds: Set<string>}} sourceTypes
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @returns {object} Response body
 */
function buildActuals(samples, sourceTypes, from, to) {
  const points = samples
    .slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map((s) => sampleToActualPoint(s, sourceTypes));

  const { intervalMs, label } = granularityForWindow(from, to);
  const series = intervalMs ? downsamplePoints(points, intervalMs) : points;

  const fields = ["solarW", "windW", "hydroW", "houseLoadW"];
  const hourly = integratePerHour(points, fields);
  const totals = { solarWh: 0, windWh: 0, hydroWh: 0, houseLoadWh: 0 };
  const fieldToTotal = {
    solarW: "solarWh",
    windW: "windWh",
    hydroW: "hydroWh",
    houseLoadW: "houseLoadWh",
  };
  for (const entry of hourly.values()) {
    for (const [field, total] of Object.entries(fieldToTotal)) {
      totals[total] += entry[field];
    }
  }

  const round = (v) => Math.round(v * 10) / 10;
  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    granularity: label,
    points: series,
    totals: {
      solarWh: Math.round(totals.solarWh),
      windWh: Math.round(totals.windWh),
      hydroWh: Math.round(totals.hydroWh),
      houseLoadWh: Math.round(totals.houseLoadWh),
    },
    averageW: {
      solar:
        series.length > 0
          ? round(series.reduce((sum, p) => sum + p.solarW, 0) / series.length)
          : 0,
      wind:
        series.length > 0
          ? round(series.reduce((sum, p) => sum + p.windW, 0) / series.length)
          : 0,
      houseLoad:
        series.length > 0
          ? round(
              series.reduce((sum, p) => sum + p.houseLoadW, 0) / series.length,
            )
          : 0,
    },
  };
}

/**
 * Collapses recorded cycles into per-hour predictions, keeping the freshest
 * cycle for each hour bucket (the prediction made closest to the hour).
 *
 * @param {object[]} cycles - Recorded cycle records
 * @returns {Map<number, {hour: number, solarWh: number, windWh: number, loadWh: number, netWh: number, weatherTier: number, cycleTimestamp: string}>}
 */
function hourlyPredictions(cycles) {
  const result = new Map();
  for (const cycle of cycles) {
    for (const point of cycle.forecast || []) {
      const bucket = hourBucket(point.time);
      const candidate = {
        hour: bucket,
        solarWh: point.idealSolarYieldWh || 0,
        windWh: point.idealWindYieldWh || 0,
        hydroWh: point.idealHydroYieldWh || 0,
        loadWh: point.houseLoadWh || 0,
        netWh: point.idealNetWh || 0,
        soc: point.idealSoC ?? null,
        weatherTier: cycle.weatherTier,
        cycleTimestamp: cycle.timestamp,
      };
      const existing = result.get(bucket);
      if (
        !existing ||
        new Date(candidate.cycleTimestamp).getTime() >=
          new Date(existing.cycleTimestamp).getTime()
      ) {
        result.set(bucket, candidate);
      }
    }
  }
  return result;
}

/**
 * Builds the /api/predictions response.
 *
 * Day windows (≤ 2 days) return raw cycles whose horizon overlaps the
 * window, for forecast-curve vs actual overlays. Longer windows return
 * daily predicted totals per source from the freshest hourly predictions.
 *
 * @param {object[]} cycles - Recorded cycle records
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @returns {object} Response body
 */
function buildPredictions(cycles, from, to) {
  const { intervalMs } = granularityForWindow(from, to);

  if (intervalMs === null) {
    // Raw day window: cycles overlapping [from, to]. A cycle overlaps when
    // it was recorded within the window or its own horizon reaches into it.
    const overlapping = cycles
      .filter((c) => {
        const t = new Date(c.timestamp).getTime();
        return t >= from.getTime() - cycleHorizonMs(c) && t <= to.getTime();
      })
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      granularity: "raw",
      cycles: overlapping,
    };
  }

  const hourly = hourlyPredictions(
    cycles.filter((c) => {
      const t = new Date(c.timestamp).getTime();
      return t >= from.getTime() - cycleHorizonMs(c) && t <= to.getTime();
    }),
  );

  const days = [];
  let cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = to.getTime();
  while (cursor.getTime() <= end) {
    const next = new Date(cursor.getTime() + MS_PER_DAY);
    const day = {
      date: cursor.toISOString().slice(0, 10),
      solarWh: 0,
      windWh: 0,
      hydroWh: 0,
      loadWh: 0,
      netWh: 0,
      hours: 0,
      socSum: 0,
      socCount: 0,
    };
    for (const entry of hourly.values()) {
      if (entry.hour >= cursor.getTime() && entry.hour < next.getTime()) {
        day.solarWh += entry.solarWh;
        day.windWh += entry.windWh;
        day.hydroWh += entry.hydroWh;
        day.loadWh += entry.loadWh;
        day.netWh += entry.netWh;
        day.hours++;
        if (entry.soc != null) {
          day.socSum += entry.soc;
          day.socCount++;
        }
      }
    }
    if (day.hours > 0) {
      days.push({
        date: day.date,
        solarWh: Math.round(day.solarWh),
        windWh: Math.round(day.windWh),
        hydroWh: Math.round(day.hydroWh),
        loadWh: Math.round(day.loadWh),
        netWh: Math.round(day.netWh),
        hours: day.hours,
        soc: day.socCount > 0 ? day.socSum / day.socCount : null,
      });
    }
    cursor = next;
  }

  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    granularity: "daily",
    days,
  };
}

/**
 * Builds the /api/environment response from recorded samples.
 *
 * Wind direction and cloud cover/GHI are reserved fields: the recorder
 * does not persist them yet, so they are reported as null until it does.
 *
 * @param {object[]} samples - Recorded samples within the window
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @returns {object} Response body
 */
function buildEnvironment(samples, from, to) {
  const { intervalMs, label } = granularityForWindow(from, to);
  const points = samples
    .slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map((s) => ({
      time: s.timestamp,
      windSpeedKnots:
        typeof s.windSpeedKnots === "number" ? s.windSpeedKnots : null,
      windDirectionDeg: null,
      cloudCover: null,
      ghi: null,
      navState: s.navState ?? null,
      position: s.position ?? null,
    }));

  let series = points;
  if (intervalMs) {
    const buckets = new Map();
    for (const p of points) {
      const bucket =
        Math.floor(new Date(p.time).getTime() / intervalMs) * intervalMs;
      let entry = buckets.get(bucket);
      if (!entry) {
        entry = {
          bucket,
          windSum: 0,
          windCount: 0,
          navState: null,
          position: null,
        };
        buckets.set(bucket, entry);
      }
      if (p.windSpeedKnots != null) {
        entry.windSum += p.windSpeedKnots;
        entry.windCount++;
      }
      if (p.navState != null) {
        entry.navState = p.navState;
      }
      if (p.position != null) {
        entry.position = p.position;
      }
    }
    series = Array.from(buckets.values())
      .sort((a, b) => a.bucket - b.bucket)
      .map((entry) => ({
        time: new Date(entry.bucket).toISOString(),
        windSpeedKnots:
          entry.windCount > 0
            ? Math.round((entry.windSum / entry.windCount) * 10) / 10
            : null,
        windDirectionDeg: null,
        cloudCover: null,
        ghi: null,
        navState: entry.navState,
        position: entry.position,
      }));
  }

  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    granularity: label,
    points: series,
  };
}

/**
 * Builds the /api/summary response: headline figures over the window
 * including prediction accuracy (predicted vs actual yield per hour).
 *
 * @param {object[]} cycles - Recorded cycle records overlapping the window
 * @param {object[]} samples - Recorded samples within the window
 * @param {{solarIds: Set<string>, windIds: Set<string>, hydroIds: Set<string>}} sourceTypes
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @returns {object} Response body
 */
function buildSummary(cycles, samples, sourceTypes, from, to) {
  const actuals = buildActuals(samples, sourceTypes, from, to);
  const points = samples
    .slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map((s) => sampleToActualPoint(s, sourceTypes));

  // SoC statistics
  const socValues = points.map((p) => p.soc).filter((v) => v != null);
  const soc = {
    min: socValues.length > 0 ? Math.min(...socValues) : null,
    average:
      socValues.length > 0
        ? socValues.reduce((a, b) => a + b, 0) / socValues.length
        : null,
    max: socValues.length > 0 ? Math.max(...socValues) : null,
  };

  // Prediction accuracy: freshest predicted yield per hour vs integrated
  // actual yield for the same hour, over hours where both exist
  const hourlyActual = integratePerHour(points, [
    "solarW",
    "windW",
    "hydroW",
    "houseLoadW",
  ]);
  const hourlyPred = hourlyPredictions(
    cycles.filter((c) => {
      const t = new Date(c.timestamp).getTime();
      return t >= from.getTime() - cycleHorizonMs(c) && t <= to.getTime();
    }),
  );

  let hoursCompared = 0;
  let apeSum = 0;
  let predictedTotal = 0;
  let actualTotal = 0;
  for (const [bucket, pred] of hourlyPred.entries()) {
    const actual = hourlyActual.get(bucket);
    if (!actual) {
      continue;
    }
    const predictedWh = pred.solarWh + pred.windWh;
    const actualWh = actual.solarW + actual.windW + actual.hydroW;
    if (actualWh <= 0.01) {
      continue; // Nothing measured to compare against
    }
    hoursCompared++;
    predictedTotal += predictedWh;
    actualTotal += actualWh;
    apeSum += (Math.abs(predictedWh - actualWh) / actualWh) * 100;
  }

  const round1 = (v) => Math.round(v * 10) / 10;
  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    consumption: {
      totalWh: actuals.totals.houseLoadWh,
      averageW: actuals.averageW.houseLoad,
    },
    yield: {
      solar: {
        totalWh: actuals.totals.solarWh,
        averageW: actuals.averageW.solar,
      },
      wind: {
        totalWh: actuals.totals.windWh,
        averageW: actuals.averageW.wind,
      },
      hydro: { totalWh: actuals.totals.hydroWh, averageW: null },
      combined: {
        totalWh:
          actuals.totals.solarWh +
          actuals.totals.windWh +
          actuals.totals.hydroWh,
        averageW: null,
      },
    },
    soc,
    predictionAccuracy:
      hoursCompared > 0
        ? {
            hoursCompared,
            meanAbsoluteErrorPercent: round1(apeSum / hoursCompared),
            totalPredictedWh: Math.round(predictedTotal),
            totalActualWh: Math.round(actualTotal),
            totalErrorPercent: round1(
              (Math.abs(predictedTotal - actualTotal) / actualTotal) * 100,
            ),
          }
        : {
            hoursCompared: 0,
            meanAbsoluteErrorPercent: null,
            totalPredictedWh: null,
            totalActualWh: null,
            totalErrorPercent: null,
          },
  };
}

/** Default cycle lookback in hours when records carry no forecast */
const DEFAULT_CYCLE_HORIZON_HOURS = 24;

/**
 * A cycle's forecast horizon in milliseconds (from its own record).
 * @param {object} cycle
 * @returns {number}
 */
function cycleHorizonMs(cycle) {
  const hours = cycle.forecast?.length || DEFAULT_CYCLE_HORIZON_HOURS;
  return hours * MS_PER_HOUR;
}

/**
 * Reads recordings for a window, filtered by type.
 *
 * Cycles get an adaptive lookback: start with the default 24h, and if the
 * loaded cycles carry longer horizons (configurable prediction horizon),
 * re-read with the largest horizon so cycles recorded further back — whose
 * forecasts still reach into the window — are included.
 *
 * @param {Function} readRecordings - `(from, to, type) => Promise<object[]>`
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @param {string} type - Record type ("cycle" or "sample")
 * @returns {Promise<object[]>}
 */
async function loadRecords(readRecordings, from, to, type) {
  // Samples are filtered to the window by the recorder itself
  if (type !== "cycle") {
    return readRecordings(from, to, type);
  }

  const initialFrom = new Date(
    from.getTime() - DEFAULT_CYCLE_HORIZON_HOURS * MS_PER_HOUR,
  );
  const initial = await readRecordings(initialFrom, to, type);

  let maxHorizonMs = DEFAULT_CYCLE_HORIZON_HOURS * MS_PER_HOUR;
  for (const cycle of initial) {
    maxHorizonMs = Math.max(maxHorizonMs, cycleHorizonMs(cycle));
  }
  if (maxHorizonMs <= DEFAULT_CYCLE_HORIZON_HOURS * MS_PER_HOUR) {
    return initial;
  }
  return readRecordings(new Date(from.getTime() - maxHorizonMs), to, type);
}

/**
 * Registers the REST API routes on the plugin router.
 *
 * @param {object} router - Express router mounted at the plugin root
 * @param {object} params
 * @param {object} params.app - Signal K server API (for logging)
 * @param {() => object|null} params.getConfig - Returns current plugin
 *   configuration (for device→source typing)
 * @param {string} params.dataDir - Plugin data directory with recordings
 */
function registerApiRoutes(
  router,
  { app, getConfig, dataDir, getWindProtection },
) {
  const readRecordings = (from, to, type) =>
    require("./recorder.js").getRecordings(dataDir, from, to, type);

  /**
   * Shared handler wrapper: window parsing, record loading, response.
   *
   * @param {object} req - Express request
   * @param {object} res - Express response
   * @param {string} type - Record type to load
   * @param {(records: object[], from: Date, to: Date) => object} build -
   *        Response builder
   * @returns {Promise<void>}
   */
  async function handle(req, res, type, build) {
    const { from, to } = parseTimeWindow(req.query);
    const records = await loadRecords(readRecordings, from, to, type);
    const config = getConfig();
    const sourceTypes = sourceTypesFromConfig(config);
    res.json(await build(records, sourceTypes, from, to));
  }

  router.get("/api/predictions", (req, res) =>
    handle(req, res, "cycle", (records, _sourceTypes, from, to) =>
      buildPredictions(records, from, to),
    ).catch((error) => handleError(error, res)),
  );

  router.get("/api/actuals", (req, res) =>
    handle(req, res, "sample", buildActuals).catch((error) =>
      handleError(error, res),
    ),
  );

  router.get("/api/environment", (req, res) =>
    handle(req, res, "sample", (records, _sourceTypes, from, to) =>
      buildEnvironment(records, from, to),
    ).catch((error) => handleError(error, res)),
  );

  router.get("/api/retro-predicted", (req, res) => {
    const { from, to } = parseTimeWindow(req.query);
    const config = getConfig();
    loadRecords(readRecordings, from, to, "sample")
      .then((samples) =>
        buildRetroPredicted(samples, config, dataDir, from, to, app),
      )
      .then((body) => res.json(body))
      .catch((error) => handleError(error, res));
  });

  router.get("/api/summary", (req, res) =>
    handle(req, res, "sample", (samples, sourceTypes, from, to) =>
      // Summary also needs cycles for accuracy; load them here
      loadRecords(readRecordings, from, to, "cycle").then((cycles) =>
        buildSummary(cycles, samples, sourceTypes, from, to),
      ),
    ).catch((error) => handleError(error, res)),
  );

  // Deploy/stow state transitions (detected) and recommendations in window
  router.get("/api/deploy-states", (req, res) => {
    const { from, to } = parseTimeWindow(req.query);
    // Fetch from before the window so the first sample inside the window
    // doesn't appear as a spurious "None -> X" transition: the prior state
    // is established from earlier samples, and only transitions within
    // [from, to] are emitted.
    const lookbackFrom = new Date(from.getTime() - 7 * 24 * 3600000);
    Promise.all([
      readRecordings(lookbackFrom, to, "sample"),
      loadRecords(readRecordings, from, to, "cycle"),
    ])
      .then(([allSamples, cycles]) =>
        res.json(
          buildDeployStates(allSamples, cycles, from, to, {
            solarOffsetMinutes: offsetMinutesFromSamples(allSamples, from, to),
          }),
        ),
      )
      .catch((error) => handleError(error, res));
  });

  // Wind Protection Factor: the live learned store (all places/sectors)
  router.get("/api/wind-protection", (_req, res) => {
    const store = getWindProtection?.();
    if (!store) {
      res.json({
        enabled: false,
        places: [],
        speedFactors: {},
        gustFactors: {},
      });
      return;
    }
    res.json(store.toJSON());
  });

  // Wind Protection Factor: recorded learning observations in a window
  router.get("/api/wind-protection/history", (req, res) =>
    handle(req, res, "wind-protection", (records, _sourceTypes, from, to) =>
      buildWindProtectionHistory(records, from, to),
    ).catch((error) => handleError(error, res)),
  );

  /**
   * Error responder following the logbook conventions.
   *
   * @param {Error & {status?: number}} error
   * @param {object} res - Express response
   */
  function handleError(error, res) {
    if (error instanceof ApiError) {
      res.status(error.status).json({ message: error.message });
      return;
    }
    app.debug?.(error.stack || error.message);
    res.status(500).json({ message: error.message });
  }
}

/**
 * Builds the /api/retro-predicted response: what the current learned model
 * would have predicted for each hour in the window, using archive weather
 * and the vessel's recorded state (nav state, position).
 *
 * Unlike /api/predictions (which serves recorded prediction cycles), this
 * computes yield retroactively from the backfilled matrices + generator
 * curves, so the webapp can overlay predicted-vs-actual for the past.
 *
 * @param {object[]} samples - Recorded samples within the window (for state)
 * @param {object} config - Plugin configuration
 * @param {string} dataDir - Plugin data directory (for matrices)
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @returns {Promise<object>} Response body
 */
async function buildRetroPredicted(samples, config, dataDir, from, to, app) {
  const backfill = require("./history-backfill.js");
  const { SolarMatrix, theoreticalPower } = require("./learning.js");
  const { sunPosition, irradianceFromCloudCover } = require("./solar.js");
  const { predictWindHour, predictHydroHour } = require("./prediction.js");
  const { parseManufacturerCurve } = require("./schema.js");
  const matrixPersistence = require("./matrix.js");

  const arrays = (config.solarArrays || []).filter(
    (a) => a.enabled !== false && a.powerPath && a.capacityWp,
  );
  const generators = (config.mechanicalGenerators || [])
    .filter((g) => g.enabled !== false && g.powerPath)
    .map((g) => ({
      ...g,
      curve: Array.isArray(g.curve)
        ? g.curve
        : parseManufacturerCurve(g.manufacturerCurve),
    }));

  // Load backfilled matrices
  const saved = await matrixPersistence.loadAllMatrices(dataDir);
  const matrices = new Map();
  for (const array of arrays) {
    const found = saved.find((m) => m.arrayId === array.id);
    matrices.set(array.id, found ? SolarMatrix.fromJSON(found) : null);
  }

  // Build per-day positions from samples for the weather track
  const byDate = new Map();
  for (const s of samples) {
    const time = new Date(s.timestamp);
    if (time < from || time > to) continue;
    const pos = s.position;
    if (!pos || pos.latitude == null || pos.longitude == null) continue;
    const date = time.toISOString().split("T")[0];
    const noonDist = Math.abs((time.getTime() % 86400000) - 12 * 3600000);
    const existing = byDate.get(date);
    if (!existing || noonDist < existing.noonDist) {
      byDate.set(date, { noonDist, position: pos });
    }
  }
  const dailyPositions = [...byDate.entries()]
    .map(([date, { position }]) => ({
      date,
      latitude: position.latitude,
      longitude: position.longitude,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const weather =
    dailyPositions.length > 0
      ? await backfill.fetchHistoricalWeatherTrack({
          dailyPositions,
          dataDir,
          app,
        })
      : [];

  // Per-hour state: take the latest sample at or before each hour
  const sorted = samples
    .slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  // navigation.state and navigation.position are sticky: the last reported
  // value persists until a new one arrives. navStateAt/posAt carry the most
  // recent non-null value forward across gaps (a sample with a null navState
  // does not reset the state to "unknown"; the prior known state holds).
  // stateAt returns the latest sample at/before t for continuous signals
  // (e.g. speed through water) where carry-forward would be wrong.
  const stateAt = (t) => {
    let lo = 0;
    let hi = sorted.length - 1;
    let best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (new Date(sorted[mid].timestamp) <= t) {
        best = sorted[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  };
  // Carry-forward navState: scan backward from the sample at/before t for
  // the first with a non-null navState, so a null reading does not reset
  // the sticky state. Returns the carrying sample (with .navState set) or
  // null if no sample has a known state.
  const navStateAt = (t) => {
    let lo = 0;
    let hi = sorted.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (new Date(sorted[mid].timestamp) <= t) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    for (let i = idx; i >= 0; i--) {
      if (sorted[i].navState != null) return sorted[i];
    }
    return null;
  };
  // Carry-forward position: latest known position at or before t (sticky,
  // not nearest) — the boat does not teleport back to an earlier fix during
  // a gap. Falls back to the earliest known position before t ever existed.
  const posAt = (t) => {
    let lo = 0;
    let hi = sorted.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (new Date(sorted[mid].timestamp) <= t) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    for (let i = idx; i >= 0; i--) {
      if (sorted[i].position) return sorted[i].position;
    }
    // No prior position: use the earliest known position so the window start
    // still has a fix to anchor sun/weather to.
    for (const s of sorted) if (s.position) return s.position;
    return null;
  };

  const points = [];
  const fromMs = from.getTime();
  const toMs = to.getTime();
  for (let t = Math.ceil(fromMs / 3600000) * 3600000; t <= toMs; t += 3600000) {
    const time = new Date(t);
    const w = backfill.interpolateWeather(weather, time);
    const state = navStateAt(time);
    const navState = resolveNavState(state, sorted);
    const pos = posAt(time);

    let idealSolarYieldWh = 0;
    if (pos) {
      const sunPos = sunPosition(time, pos.latitude, pos.longitude);
      let ghi = w.ghi;
      if (ghi == null && w.cloudCover != null) {
        ghi = irradianceFromCloudCover(sunPos.altitude, w.cloudCover);
      }
      if (ghi != null && ghi > 0) {
        for (const array of arrays) {
          const matrix = matrices.get(array.id);
          if (!matrix) continue;
          const th = theoreticalPower(array.capacityWp, ghi, sunPos.altitude);
          if (th <= 0) continue;
          const eff = matrix.getAnchored(sunPos.azimuth, sunPos.altitude);
          idealSolarYieldWh += th * eff;
        }
      }
    }

    let idealWindYieldWh = 0;
    let idealHydroYieldWh = 0;
    for (const g of generators) {
      if (g.type === "wind") {
        idealWindYieldWh += predictWindHour({
          generator: g,
          windSpeedKnots: w.windSpeedKnots ?? 0,
          gustSpeedKnots: w.gustSpeedKnots ?? 0,
          navState,
        });
      } else if (g.type === "hydro") {
        const stwState = stateAt(time);
        const stwKn =
          stwState && typeof stwState.stwKnots === "number"
            ? stwState.stwKnots
            : 0;
        idealHydroYieldWh += predictHydroHour({
          generator: g,
          speedThroughWaterKnots: stwKn,
          isSailing: navState === "sailing",
        });
      }
    }

    points.push({
      time: time.toISOString(),
      idealSolarYieldWh: Math.round(idealSolarYieldWh),
      idealWindYieldWh: Math.round(idealWindYieldWh + idealHydroYieldWh),
      idealHydroYieldWh: Math.round(idealHydroYieldWh),
    });
  }

  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    points,
  };
}

/**
 * Builds the /api/wind-protection/history response: the raw WPF learning
 * observations recorded while at rest, each carrying the measured vs
 * forecast comparison and the resulting factors.
 *
 * Observations are returned in time order, filtered to the query window
 * by the recorder. They are the material for the webapp timeline and for
 * offline backfilling of factors from archived wind.
 *
 * @param {object[]} records - wind-protection records from the recorder
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @returns {{window: {from: string, to: string}, observations: object[]}}
 */
function buildWindProtectionHistory(records, from, to) {
  const observations = records
    .filter((r) => r.type === "wind-protection")
    .map((r) => ({
      timestamp: r.timestamp,
      placeKey: r.placeKey,
      sector: r.sector,
      night: r.night,
      measuredSpeedKnots: r.measuredSpeedKnots,
      forecastSpeedKnots: r.forecastSpeedKnots,
      measuredGustKnots: r.measuredGustKnots ?? null,
      forecastGustKnots: r.forecastGustKnots ?? null,
      windDirectionDeg: r.windDirectionDeg ?? null,
      speedFactor: r.speedFactor,
      gustFactor: r.gustFactor,
      position: r.position,
      navState: r.navState,
      anemometerHeightM: r.anemometerHeightM,
    }))
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    observations,
  };
}

/**
 * Builds the /api/deploy-states response: detected deploy/stow state
 * transitions and predictor recommendations within the window.
 *
 * Detected states are inferred per sample (from power output + conditions)
 * and carried forward across unknown gaps, so a device that produced no
 * power and had no wind evidence keeps its last known state (e.g. a wind
 * generator stowed for repair reads 0 W in calm conditions, staying
 * "stowed"). Only state transitions are emitted.
 *
 * Recommendations come from each recorded cycle's per-hour idealAction
 * events (state changes only, already shifted to sun boundaries at
 * night). Consecutive same-device same-action advisories from successive
 * cycles are collapsed into the first.
 *
 * @param {object[]} samples - Recorded samples with deployStates
 * @param {object[]} cycles - Recorded prediction cycles
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @param {object} [opts]
 * @param {number|null} [opts.solarOffsetMinutes=null] - Vessel solar-local
 *        UTC offset in minutes; when known, advisory dedup keys on the
 *        solar-local calendar day (sun-day) rather than UTC, so a surplus
 *        window straddling UTC midnight doesn't split into two events.
 * @returns {{window: {from: string, to: string}, detected: object[], recommendations: object[], advisories: object[]}}
 */
function buildDeployStates(samples, cycles, from, to, opts = {}) {
  const { solarOffsetMinutes = null } = opts;
  // Detected transitions: carry forward last known state per device across
  // unknown (null/absent) gaps, then emit only state changes. Samples before
  // the window establish the prior state so the first in-window sample doesn't
  // appear as a spurious "None -> X" transition; only transitions within
  // [from, to] are emitted.
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const sorted = samples
    .slice()
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  const lastEmitted = new Map(); // id -> last emitted state
  const detected = [];
  for (const s of sorted) {
    const tMs = new Date(s.timestamp).getTime();
    const states = s.deployStates || {};
    for (const [id, state] of Object.entries(states)) {
      if (state == null) continue;
      if (lastEmitted.get(id) === state) continue;
      lastEmitted.set(id, state);
      // Only emit transitions that fall within the queried window.
      if (tMs >= fromMs && tMs <= toMs) {
        detected.push({ time: s.timestamp, id, state });
      }
    }
  }

  // Recommendations: from each cycle's per-hour idealAction events, keyed
  // by the forecast hour (when the action should happen). Collapse across
  // cycles by rounding to the hour and keeping the first, then collapse
  // consecutive same-device same-action advisories into the first.
  //
  // Suppress advisories that match the device's current detected state:
  // recommending "stow" on an already-stowed device (or "deploy" on an
  // already-deployed one) is noise. The current state is the last known
  // detected state at/before the advisory time (carried forward across
  // unknown gaps, same as the detected-transition pass above).
  const stateTimeline = new Map(); // id -> [{time, state}], sorted
  for (const s of sorted) {
    const t = new Date(s.timestamp).getTime();
    const states = s.deployStates || {};
    for (const [id, state] of Object.entries(states)) {
      if (state == null) continue;
      if (!stateTimeline.has(id)) stateTimeline.set(id, []);
      const arr = stateTimeline.get(id);
      if (arr.length === 0 || arr[arr.length - 1].state !== state) {
        arr.push({ time: t, state });
      }
    }
  }
  /**
   * Last known detected state for a device at/before time t (ms).
   * @returns {string|null|undefined} state, or undefined if unknown
   */
  function detectedStateAt(id, tMs) {
    const arr = stateTimeline.get(id);
    if (!arr || arr.length === 0) return undefined;
    // Binary search for the last entry with time <= tMs
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].time <= tMs) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return undefined; // first state is after tMs
    return arr[lo - 1].state;
  }

  // Recommendations: from each cycle's per-hour idealAction events, keyed
  // by the forecast hour (when the action should happen). A new forecast
  // (or new WPF learning that changes the corrected gusts) can overturn a
  // prior cycle's recommendation for a future hour — e.g. a stow advised at
  // 05:00 for tonight's 22:00 must disappear once the 11:00 forecast (with
  // WPF applied) no longer breaches the gust limit. So the recommendation
  // for a given (hour, device) is authoritative only from the *newest* cycle
  // that covers that hour: if the newest covering cycle still issues the
  // action, keep it; if it covers the hour but has no action for the device
  // (the device's ideal state is steady — no transition), the prior
  // recommendation is withdrawn. Hours no cycle covers keep the oldest
  // surviving action (pure history, nothing newer to revise it).
  //
  // Coverage is per wall-clock hour: a cycle covers hour H if any of its
  // forecast points rounds to H (it has a verdict for that hour) OR its
  // forecast span [firstPoint, lastPoint] contains H (a newer forecast
  // that spans the hour but, due to a minute-offset drift, has no point
  // rounding exactly to H still supersedes the older cycle's rec there).
  // Sorted oldest→newest so the last matching cycle wins.
  const cyclesIndexed = cycles
    .map((cycle) => {
      const hourSet = new Set(); // wall-clock hours this cycle has a point for
      const acts = new Map(); // `${hourTs}|${id}` -> ev (last per hour+device)
      let startMs = Number.POSITIVE_INFINITY;
      let endMs = Number.NEGATIVE_INFINITY;
      for (const point of cycle.forecast || []) {
        const t = new Date(point.time).getTime();
        const hourTs = Math.round(t / 3600000) * 3600000;
        hourSet.add(hourTs);
        if (t < startMs) startMs = t;
        if (t > endMs) endMs = t;
        for (const a of point.actions || []) {
          if (a.idealAction !== "deploy" && a.idealAction !== "stow") continue;
          if (a.detectedAction === "stay") continue;
          // Last action for this (hour, device) within the cycle wins
          // (a later point in the same cycle rounding to the same hour
          // is the more precise verdict).
          acts.set(`${hourTs}|${a.id}`, {
            time: hourTs,
            id: a.id,
            action: a.idealAction,
            reason: a.reason || "",
          });
        }
      }
      return {
        ts: new Date(cycle.timestamp).getTime(),
        startMs,
        endMs,
        hourSet,
        acts,
        advisories: cycle.advisories || [],
      };
    })
    .sort((a, b) => a.ts - b.ts);

  // Recommendations are only relevant for the recent past — a stow advised
  // days ago is stale history that doesn't help the crew now. Only cycles
  // run within the past 24h of the latest cycle contribute recommendations;
  // older cycles are ignored entirely (their detected states still feed
  // the detected-transition timeline above, which is genuine history).
  const latestCycleTs =
    cyclesIndexed.length > 0 ? cyclesIndexed[cyclesIndexed.length - 1].ts : 0;
  const recentCycles = cyclesIndexed.filter(
    (c) => c.ts >= latestCycleTs - MS_PER_DAY,
  );

  /** Newest cycle covering wall-clock hour H (ms), or null. */
  const newestCovering = (hourTs) => {
    for (let i = recentCycles.length - 1; i >= 0; i--) {
      const c = recentCycles[i];
      if (c.hourSet.has(hourTs)) return c;
      if (hourTs >= c.startMs && hourTs <= c.endMs) return c;
    }
    return null;
  };

  const recsByHour = new Map(); // `${hourTs}|${id}` -> ev
  for (const cycle of recentCycles) {
    for (const [key, ev] of cycle.acts) {
      // Only keep this cycle's action if it IS the newest cycle covering
      // the hour. A newer cycle covering the hour but having no action
      // for this device withdraws the recommendation (we simply don't
      // add it).
      const newest = newestCovering(ev.time);
      if (newest && newest.ts !== cycle.ts) continue;
      recsByHour.set(key, ev);
    }
  }
  // Collapse consecutive same-device same-action advisories into the first,
  // and suppress advisories that match the state the device is already in
  // (or would be in after acting on a prior advisory). The "current ideal
  // state" per device starts from the last detected state at/before the
  // advisory time, and is updated by each emitted advisory so a
  // stow→deploy sequence still shows both (they are real ideal-state
  // changes), while a steady "already stowed" device gets no "stow" spam.
  // Detected states are "deployed"/"stowed" (past tense); advisory actions
  // are "deploy"/"stow" (imperative). Normalize for comparison.
  const actionToState = { deploy: "deployed", stow: "stowed" };
  const recommendations = [];
  const idealState = new Map(); // id -> current ideal state (tracked)
  for (const ev of [...recsByHour.values()].sort((a, b) => a.time - b.time)) {
    // Only emit recommendations that fall within the queried window. A rec
    // just before the window (e.g. a stow advised at 20:00 last night, now
    // outside the "today" day-view) is history for a past hour and must not
    // leak into the current view as if still actionable. The ideal-state
    // tracker still walks every rec in order so an in-window transition
    // is correctly compared against the prior ideal state.
    const inWindow = ev.time >= fromMs && ev.time <= toMs;
    const target = actionToState[ev.action];
    // Initialize ideal state from detected state the first time we see a
    // device, at the time of this advisory.
    if (!idealState.has(ev.id)) {
      const detected = detectedStateAt(ev.id, ev.time);
      idealState.set(ev.id, detected || null);
    }
    if (idealState.get(ev.id) === target) continue; // no change
    idealState.set(ev.id, target);
    if (inWindow) recommendations.push(ev);
  }
  // Also collapse: if the first emitted advisory for a device matches the
  // detected state at its time, it was already filtered above. Consecutive
  // same-action was handled by the idealState check.

  // Advisories (surplus / engine-run deficit / stowage) recorded per
  // cycle. A given advisory event (e.g. a surplus window starting at
  // 14:00) is reported by every cycle whose forecast covers it, so we
  // dedupe keeping the newest cycle's version — the newest forecast is
  // authoritative (a later cycle can move or resize the window, mirroring
  // the recommendation-withdrawal logic above). Only advisories whose
  // action time falls within [from, to] are emitted.
  //
  // The dedup key is the solar-local calendar day of the advisory's
  // action time (a "sun-day"). There is at most one surplus and one
  // deficit event per sun-day (the bank hits full-and-curtails once per
  // charging phase; a deficit advisory is the day's low point), so keying
  // on the local date collapses the near-duplicates that flood the Events
  // list otherwise: each cycle's forecast is anchored at its own run
  // timestamp, so the window start drifts by minutes between consecutive
  // cycles even though it is the *same* logical event, and a window
  // straddling UTC midnight would otherwise split into two. Using the
  // solar-local day (shifted by the vessel's longitude-derived offset)
  // keeps a single charging phase in one bucket. The newest cycle's
  // version (cyclesIndexed is oldest→newest, so the last `.set` wins) is
  // the most accurate forecast.
  const offsetMs = (solarOffsetMinutes || 0) * 60 * 1000;
  const advisoriesByKey = new Map(); // `${type}|${localDateMs}` -> adv
  for (const cycle of cyclesIndexed) {
    for (const adv of cycle.advisories || []) {
      const tMs = new Date(adv.time).getTime();
      if (Number.isNaN(tMs)) continue;
      const localDateMs = new Date(tMs + offsetMs).setUTCHours(0, 0, 0, 0);
      advisoriesByKey.set(`${adv.type}|${localDateMs}`, adv);
    }
  }
  const advisories = [...advisoriesByKey.values()]
    .filter((adv) => {
      const t = new Date(adv.time).getTime();
      return t >= fromMs && t <= toMs;
    })
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    detected,
    recommendations,
    advisories,
  };
}

module.exports = {
  MAX_WINDOW_DAYS,
  ApiError,
  parseTimeWindow,
  granularityForWindow,
  sourceTypesFromConfig,
  resolveNavState,
  sampleToActualPoint,
  integratePerHour,
  downsamplePoints,
  hourlyPredictions,
  buildActuals,
  buildPredictions,
  buildEnvironment,
  buildSummary,
  buildRetroPredicted,
  buildWindProtectionHistory,
  buildDeployStates,
  registerApiRoutes,
  cycleHorizonMs,
  offsetMinutesFromSamples,
};
