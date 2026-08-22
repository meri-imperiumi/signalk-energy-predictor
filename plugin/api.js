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
function registerApiRoutes(router, { app, getConfig, dataDir }) {
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

  router.get("/api/summary", (req, res) =>
    handle(req, res, "sample", (samples, sourceTypes, from, to) =>
      // Summary also needs cycles for accuracy; load them here
      loadRecords(readRecordings, from, to, "cycle").then((cycles) =>
        buildSummary(cycles, samples, sourceTypes, from, to),
      ),
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

module.exports = {
  MAX_WINDOW_DAYS,
  ApiError,
  parseTimeWindow,
  granularityForWindow,
  sourceTypesFromConfig,
  sampleToActualPoint,
  integratePerHour,
  downsamplePoints,
  hourlyPredictions,
  buildActuals,
  buildPredictions,
  buildEnvironment,
  buildSummary,
  registerApiRoutes,
  cycleHorizonMs,
};
