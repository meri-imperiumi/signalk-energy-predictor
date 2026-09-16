/**
 * SQLite-backed recording store for cycles, samples, and wind-protection
 * observations (replaces the NDJSON day-file recorder; see work doc #21).
 *
 * Layout:
 *  - `records`: one JSON row per sample / wind-protection observation /
 *    cycle *metadata* (cycles store their forecast as point rows instead,
 *    so windowed reads never parse out-of-window forecast JSON).
 *  - `forecast_points`: one row per forecast hour per cycle, keyed
 *    `(cycle_ts, h)` with an index on the point's own timestamp for
 *    windowed queries and SQL aggregation.
 *
 * Loop discipline: `node:sqlite` is synchronous, so every windowed read
 * is keyset-paginated (`WHERE (ts, cycle_ts) > (last)` with `ORDER BY`)
 * and yields to the event loop between pages — a large window costs many
 * short stalls instead of one multi-hundred-ms parse storm. Keyset
 * pagination (rather than `StatementSync.iterate()`) also works on every
 * Node >= 22.5 the plugin supports.
 *
 * Transaction discipline: every write transaction (recordCycle, the
 * NDJSON importer's per-file transaction) is fully synchronous — no
 * `await` may occur between BEGIN and COMMIT, which is what keeps the
 * single shared connection free of nested transactions.
 *
 * Requires the `node:sqlite` builtin: Node >= 23.4, or Node >= 22.5 with
 * the server started with `--experimental-sqlite` (installer's choice).
 * `open()` fails fast with both remedies in the message when missing.
 *
 * @file storage.js
 */

/** Forecast-point columns, mapped to the engine's getHourlyForecast() output */
const POINT_COLUMNS = [
  ["ideal_solar", "idealSolarYieldWh"],
  ["ideal_wind", "idealWindYieldWh"],
  ["ideal_hydro", "idealHydroYieldWh"],
  ["alternator", "alternatorWh"],
  ["house_load", "houseLoadWh"],
  ["ideal_net", "idealNetWh"],
  ["ideal_soc", "idealSoC"],
  ["detected_yield", "detectedYieldWh"],
  ["detected_net", "detectedNetWh"],
  ["detected_soc", "detectedSoC"],
  ["wind_kn", "windSpeedKnots"],
  ["gust_kn", "gustSpeedKnots"],
  ["forecast_wind_kn", "forecastWindSpeedKnots"],
  ["forecast_gust_kn", "forecastGustKnots"],
  ["wind_dir_deg", "windDirectionDeg"],
];

const MS_PER_HOUR = 3600000;

/**
 * Loads the node:sqlite builtin or fails with an actionable message.
 *
 * @returns {{DatabaseSync: typeof import("node:sqlite").DatabaseSync}}
 */
function loadSqlite() {
  try {
    // eslint-disable-next-line n/no-unpublished-require
    return require("node:sqlite");
  } catch (error) {
    throw new Error(
      `energy-predictor: SQLite storage requires the node:sqlite builtin ` +
        `(Node >= 23.4, or Node >= 22.5 with the server started with ` +
        `--experimental-sqlite): ${error.message}`,
    );
  }
}

/**
 * Coerces a timestamp (Date, epoch ms, or ISO string) to epoch ms.
 *
 * @param {Date|number|string} value
 * @returns {number}
 */
function toMs(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  return Date.parse(value);
}

/**
 * Shallow position equality (mirrors the old recorder's overwrite check).
 * @param {{latitude: number, longitude: number}} a
 * @param {{latitude: number, longitude: number}|null} b
 * @returns {boolean}
 */
function deepEqualPos(a, b) {
  return b != null && a.latitude === b.latitude && a.longitude === b.longitude;
}

/** @returns {Promise<void>} */
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Maps a forecast_points row to the engine's point field names.
 * @param {object} row
 * @returns {object}
 */
function mapPointRow(row) {
  const point = {
    cycleTs: row.cycle_ts,
    h: row.h,
    ts: row.ts,
    hour: row.hour,
    weatherTier: row.weather_tier,
  };
  for (const [col, field] of POINT_COLUMNS) {
    point[field] = row[col];
  }
  point.actions = JSON.parse(row.actions ?? "[]");
  return point;
}

/**
 * Hour-bucket floor (epoch ms) for winner queries — the bucket a point
 * at `ms` belongs to. Positive-timestamp safe integer division.
 * @param {Date} date
 * @returns {number}
 */
function hourFloor(date) {
  const ms = toMs(date);
  return Math.floor(ms / 3600000) * 3600000;
}

/**
 * SQLite record store with the recorder's config-aware lifecycle
 * (enabled / retentionDays / daily prune timer).
 */
class RecordStore {
  /**
   * @param {object} app - Signal K server API (for logging)
   * @param {string} dataDir - Plugin data directory
   * @param {object} [config]
   * @param {boolean} [config.enabled=true] - Whether recording is enabled
   * @param {number} [config.retentionDays=90] - Retention period in days
   * @param {number} [config.pageSize=2000] - Keyset page size (tests tune
   *        this down to exercise the yield path)
   */
  constructor(app, dataDir, config = {}) {
    this.app = app;
    this.dataDir = dataDir;
    this.enabled = config.enabled !== false;
    this.retentionDays = config.retentionDays ?? 90;
    this.pageSize = config.pageSize ?? 2000;
    /** @type {import("node:sqlite").DatabaseSync|null} */
    this.db = null;
    /** @type {Record<string, import("node:sqlite").StatementSync>} */
    this.statements = {};
    this.pruneIntervalId = null;
  }

  /**
   * Opens (or creates) the database and prepares statements. Idempotent.
   *
   * @returns {void}
   */
  open() {
    if (this.db) {
      return;
    }
    const fs = require("node:fs");
    const path = require("node:path");
    const { DatabaseSync } = loadSqlite();
    fs.mkdirSync(this.dataDir, { recursive: true });
    const db = new DatabaseSync(path.join(this.dataDir, "records.db"));
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    // Applies to freshly created files; existing files keep their mode
    // (retained space is reclaimed on migration-time creation anyway)
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        type TEXT NOT NULL,
        ts INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (type, ts)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS forecast_points (
        cycle_ts INTEGER NOT NULL,
        h INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        hour INTEGER NOT NULL,
        weather_tier INTEGER,
        ${POINT_COLUMNS.map(([col]) => `${col} REAL`).join(",\n        ")},
        actions TEXT,
        PRIMARY KEY (cycle_ts, h)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_points_ts_cycle
        ON forecast_points (ts, cycle_ts);
      CREATE INDEX IF NOT EXISTS idx_points_hour_cycle
        ON forecast_points (hour, cycle_ts);
      CREATE TABLE IF NOT EXISTS deploy_actions (
        cycle_ts INTEGER NOT NULL,
        h INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        PRIMARY KEY (cycle_ts, h, id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS deploy_spans (
        cycle_ts INTEGER PRIMARY KEY,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const pointCols = POINT_COLUMNS.map(([col]) => col);
    this.statements = {
      putRecord: db.prepare(
        `INSERT INTO records (type, ts, json) VALUES (?, ?, ?)
         ON CONFLICT (type, ts) DO UPDATE SET json = excluded.json`,
      ),
      deletePoints: db.prepare(
        "DELETE FROM forecast_points WHERE cycle_ts = ?",
      ),
      deleteDeployActions: db.prepare(
        "DELETE FROM deploy_actions WHERE cycle_ts = ?",
      ),
      putSpan: db.prepare(
        `INSERT INTO deploy_spans (cycle_ts, start_ms, end_ms) VALUES (?, ?, ?)
         ON CONFLICT (cycle_ts) DO UPDATE SET
           start_ms = excluded.start_ms,
           end_ms = excluded.end_ms`,
      ),
      putDeployAction: db.prepare(
        `INSERT INTO deploy_actions (cycle_ts, h, ts, id, action, reason)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (cycle_ts, h, id) DO UPDATE SET
           ts = excluded.ts,
           action = excluded.action,
           reason = excluded.reason`,
      ),
      deploySpans: db.prepare(
        `SELECT cycle_ts, start_ms, end_ms FROM deploy_spans
         WHERE cycle_ts >= ? AND cycle_ts <= ?`,
      ),
      deployActionRows: db.prepare(
        `SELECT cycle_ts, ts, id, action, reason FROM deploy_actions
         WHERE cycle_ts >= ? AND cycle_ts <= ?
         ORDER BY cycle_ts, h`,
      ),
      putPoint: db.prepare(
        `INSERT INTO forecast_points
           (cycle_ts, h, ts, hour, weather_tier, ${pointCols.join(", ")}, actions)
         VALUES (?, ?, ?, ?, ?, ${pointCols.map(() => "?").join(", ")}, ?)
         ON CONFLICT (cycle_ts, h) DO UPDATE SET
           ${pointCols.map((c) => `${c} = excluded.${c}`).join(", ")},
           ts = excluded.ts,
           hour = excluded.hour,
           weather_tier = excluded.weather_tier,
           actions = excluded.actions`,
      ),
      recordsPage: db.prepare(
        `SELECT ts, json FROM records
         WHERE type = ? AND ts >= ? AND ts <= ? AND ts > ?
         ORDER BY ts LIMIT ?`,
      ),
      pointsPage: db.prepare(
        `SELECT * FROM forecast_points
         WHERE (ts, cycle_ts) > (?, ?) AND ts >= ? AND ts <= ?
         ORDER BY ts, cycle_ts LIMIT ?`,
      ),
      hourlyWinners: db.prepare(
        `SELECT f.*
         FROM forecast_points f
         JOIN (
           SELECT hour, MAX(cycle_ts) AS cycle_ts
           FROM forecast_points
           WHERE hour >= ? AND hour <= ?
           GROUP BY hour
         ) w ON f.hour = w.hour AND f.cycle_ts = w.cycle_ts
         ORDER BY f.hour`,
      ),
      pointsByCycle: db.prepare(
        `SELECT * FROM forecast_points WHERE cycle_ts = ? ORDER BY h`,
      ),
      pointsForCycles: db.prepare(
        `SELECT * FROM forecast_points
         WHERE cycle_ts >= ? AND cycle_ts <= ? AND (cycle_ts, h) > (?, ?)
         ORDER BY cycle_ts, h LIMIT ?`,
      ),
      updateRecordJson: db.prepare(
        "UPDATE records SET json = ? WHERE type = ? AND ts = ?",
      ),
      latestRecords: db.prepare(
        "SELECT ts, json FROM records WHERE type = ? AND ts >= ? ORDER BY ts DESC LIMIT ?",
      ),
      recordsRange: db.prepare(
        "SELECT MIN(ts) AS min, MAX(ts) AS max FROM records WHERE type = ?",
      ),
      countRecords: db.prepare(
        "SELECT COUNT(*) AS n FROM records WHERE type = ?",
      ),
      countPoints: db.prepare("SELECT COUNT(*) AS n FROM forecast_points"),
      deletePointsBeforeCycle: db.prepare(
        "DELETE FROM forecast_points WHERE cycle_ts < ?",
      ),
      deleteDeployActionsBefore: db.prepare(
        "DELETE FROM deploy_actions WHERE cycle_ts < ?",
      ),
      deleteDeploySpansBefore: db.prepare(
        "DELETE FROM deploy_spans WHERE cycle_ts < ?",
      ),
      deleteRecordsBefore: db.prepare("DELETE FROM records WHERE ts < ?"),
      summaryTotals: db.prepare(
        `SELECT COUNT(*) AS hours,
                COALESCE(SUM(f.ideal_solar), 0) AS idealSolarWh,
                COALESCE(SUM(f.ideal_wind), 0) AS idealWindWh,
                COALESCE(SUM(f.ideal_hydro), 0) AS idealHydroWh,
                COALESCE(SUM(f.alternator), 0) AS alternatorWh,
                COALESCE(SUM(f.house_load), 0) AS houseLoadWh,
                COALESCE(SUM(f.ideal_net), 0) AS idealNetWh
         FROM forecast_points f
         JOIN (
           SELECT hour, MAX(cycle_ts) AS cycle_ts
           FROM forecast_points
           WHERE hour >= ? AND hour <= ?
           GROUP BY hour
         ) w ON f.hour = w.hour AND f.cycle_ts = w.cycle_ts`,
      ),
      putMeta: db.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      ),
      getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    };
    this.db = db;
  }

  /**
   * Checkpoints the WAL and closes the database.
   *
   * @returns {void}
   */
  close() {
    if (!this.db) {
      return;
    }
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (_error) {
      /* checkpoint is best-effort */
    }
    this.db.close();
    this.db = null;
    this.statements = {};
  }

  /** @returns {boolean} */
  #ensureOpen() {
    if (!this.db) {
      throw new Error("RecordStore is not open (call open() first)");
    }
    return true;
  }

  /**
   * Writes a cycle's metadata row and point rows. Internal: assumes an
   * open transaction (used by recordCycle and the NDJSON importer so the
   * two write paths cannot drift).
   *
   * @param {number} ts - Cycle timestamp (epoch ms)
   * @param {object} metadata - Cycle record without the forecast
   * @param {object[]} forecast - Hourly points (getHourlyForecast shape)
   * @returns {void}
   */
  insertCycleRows(ts, metadata, forecast) {
    this.#ensureOpen();
    this.statements.putRecord.run("cycle", ts, JSON.stringify(metadata));
    this.statements.deletePoints.run(ts);
    this.statements.deleteDeployActions.run(ts);
    const putPoint = this.statements.putPoint;
    const putDeployAction = this.statements.putDeployAction;
    const putSpan = this.statements.putSpan;
    const tier =
      metadata.weatherTier == null ? null : Number(metadata.weatherTier);
    let startMs = Number.POSITIVE_INFINITY;
    let endMs = Number.NEGATIVE_INFINITY;
    for (const [h, point] of forecast.entries()) {
      const pointTs =
        point.time != null ? Date.parse(point.time) : ts + h * MS_PER_HOUR;
      const hour = Math.floor(pointTs / MS_PER_HOUR) * MS_PER_HOUR;
      if (pointTs < startMs) startMs = pointTs;
      if (pointTs > endMs) endMs = pointTs;
      const values = POINT_COLUMNS.map(([, field]) =>
        point[field] == null ? null : Number(point[field]),
      );
      putPoint.run(
        ts,
        h,
        pointTs,
        hour,
        tier,
        ...values,
        JSON.stringify(point.actions ?? []),
      );
      // Write-time normalization for the deploy-state pass: only
      // deploy/stow actions with a non-"stay" detected action reach the
      // table (same filter the reader applied), so the endpoint's read
      // is a tiny range scan instead of a json_each sweep of every
      // point row
      for (const action of point.actions ?? []) {
        if (
          (action.idealAction === "deploy" || action.idealAction === "stow") &&
          action.detectedAction !== "stay" &&
          action.id != null
        ) {
          putDeployAction.run(
            ts,
            h,
            pointTs,
            String(action.id),
            action.idealAction,
            action.reason || "",
          );
        }
      }
    }
    if (Number.isFinite(startMs)) {
      putSpan.run(ts, startMs, endMs);
    }
  }

  /**
   * Records a cycle (prediction run): one metadata row plus one row per
   * forecast hour, replaced atomically (a re-recorded cycle never leaves
   * stale points from a longer previous forecast).
   *
   * @param {object} cycle
   * @param {Date} cycle.timestamp
   * @param {number} cycle.weatherTier
   * @param {object[]} cycle.forecast - Hourly points (getHourlyForecast shape)
   * @param {object} cycle.actions - Advisory actions for the cycle
   * @param {object[]} [cycle.advisories]
   * @returns {Promise<void>}
   */
  async recordCycle(cycle) {
    if (!this.enabled) {
      return;
    }
    this.#ensureOpen();
    const ts = toMs(cycle.timestamp);
    const metadata = {
      type: "cycle",
      timestamp: new Date(ts).toISOString(),
      weatherTier: cycle.weatherTier,
      actions: cycle.actions,
      advisories: cycle.advisories || [],
    };
    const forecast = Array.isArray(cycle.forecast) ? cycle.forecast : [];

    this.db.exec("BEGIN");
    try {
      this.insertCycleRows(ts, metadata, forecast);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.app.debug?.(`Recorded cycle at ${metadata.timestamp}`);
  }

  /**
   * Records a sample (5-minute bucket of measured values). Same record
   * shape the NDJSON recorder wrote.
   *
   * @param {object} sample - See the old recorder's recordSample docs
   * @returns {Promise<void>}
   */
  async recordSample(sample) {
    if (!this.enabled) {
      return;
    }
    this.#ensureOpen();
    const ts = toMs(sample.timestamp);
    const record = {
      type: "sample",
      timestamp: new Date(ts).toISOString(),
      arrays: sample.arrays,
      generators: sample.generators,
      soc: sample.soc,
      houseLoadW: sample.houseLoadW,
      windSpeedKnots: sample.windSpeedKnots,
      navState: sample.navState,
      position: sample.position,
      stwKnots: sample.stwKnots ?? null,
      deployStates: sample.deployStates || {},
      controllerModes: sample.controllerModes || {},
      awaRad: sample.awaRad ?? null,
    };
    this.statements.putRecord.run("sample", ts, JSON.stringify(record));
    this.app.debug?.(`Recorded sample at ${record.timestamp}`);
  }

  /**
   * Records a Wind Protection Factor learning observation.
   *
   * @param {object} obs - See the old recorder's recordWindProtection docs
   * @returns {Promise<void>}
   */
  async recordWindProtection(obs) {
    if (!this.enabled) {
      return;
    }
    this.#ensureOpen();
    const ts = toMs(obs.timestamp);
    const record = {
      type: "wind-protection",
      timestamp: new Date(ts).toISOString(),
      placeKey: obs.placeKey,
      sector: obs.sector,
      night: obs.night,
      measuredSpeedKnots: obs.measuredSpeedKnots,
      forecastSpeedKnots: obs.forecastSpeedKnots,
      measuredGustKnots: obs.measuredGustKnots ?? null,
      forecastGustKnots: obs.forecastGustKnots ?? null,
      windDirectionDeg: obs.windDirectionDeg ?? null,
      speedFactor: obs.speedFactor,
      gustFactor: obs.gustFactor,
      position: obs.position,
      navState: obs.navState,
      anemometerHeightM: obs.anemometerHeightM,
    };
    this.statements.putRecord.run(
      "wind-protection",
      ts,
      JSON.stringify(record),
    );
    this.app.debug?.(
      `Recorded wind-protection observation at ${record.timestamp}`,
    );
  }

  /**
   * Reads records of one type within a time window, ascending by
   * timestamp. Yields to the event loop between keyset pages.
   *
   * Note: reads are not gated by `enabled` — pausing recording keeps the
   * timeline readable on already-stored data (the old recorder returned
   * [] when disabled only because it had no data to read).
   *
   * @param {string} type - "sample" | "wind-protection" | "cycle"
   *        (cycle rows are metadata only — use getForecastPoints for
   *        forecast data)
   * @param {Date} from
   * @param {Date} to
   * @returns {Promise<object[]>}
   */
  async getRecords(type, from, to) {
    this.#ensureOpen();
    const out = [];
    let after = from.getTime() - 1;
    for (;;) {
      const rows = this.statements.recordsPage.all(
        type,
        from.getTime(),
        to.getTime(),
        after,
        this.pageSize,
      );
      for (const row of rows) {
        out.push(JSON.parse(row.json));
      }
      if (rows.length < this.pageSize) {
        return out;
      }
      after = rows[rows.length - 1].ts;
      await yieldToLoop();
    }
  }

  /**
   * Reads forecast points whose own timestamp falls in the window,
   * ascending. Rows map back to getHourlyForecast() field names, with
   * `cycleTs`, `h`, and `ts` added; `actions` is parsed.
   *
   * @param {Date} from
   * @param {Date} to
   * @returns {Promise<object[]>}
   */
  async getForecastPoints(from, to) {
    this.#ensureOpen();
    const out = [];
    // Cursor init: (from-1, 0) precedes every row inside [from, to]
    // (finite values only — SQLite cannot bind Infinity)
    let lastTs = from.getTime() - 1;
    let lastCycle = 0;
    for (;;) {
      const rows = this.statements.pointsPage.all(
        lastTs,
        lastCycle,
        from.getTime(),
        to.getTime(),
        this.pageSize,
      );
      for (const row of rows) {
        out.push(mapPointRow(row));
      }
      if (rows.length < this.pageSize) {
        return out;
      }
      lastTs = rows[rows.length - 1].ts;
      lastCycle = rows[rows.length - 1].cycle_ts;
      await yieldToLoop();
    }
  }

  /**
   * The freshest hourly prediction per hour bucket in the window: for
   * each hour, the forecast point from the newest cycle that covers it
   * (mirrors the webapp builders' winner rule: greatest cycle timestamp
   * per bucket). Returns one row per hour bucket, ascending.
   *
   * This is the week/month-view read: overlapping forecasts are resolved
   * inside SQLite, so ~O(hours) rows cross into JS instead of every
   * point of every overlapping cycle. The window is processed in
   * bounded hour chunks with a yield between them, so the synchronous
   * GROUP BY scans stay short even on month windows.
   *
   * @param {Date} from
   * @param {Date} to
   * @returns {Promise<{hour: number}[] & object[]>} - Winner points with
   *          `hour` (bucket start, epoch ms) plus the mapped point fields
   */
  async getHourlyWinners(from, to) {
    this.#ensureOpen();
    const out = [];
    const chunkMs = 12 * MS_PER_HOUR;
    let cursor = hourFloor(from);
    const end = hourFloor(to);
    while (cursor <= end) {
      const chunkEnd = Math.min(cursor + chunkMs - 1, end);
      for (const row of this.statements.hourlyWinners.all(cursor, chunkEnd)) {
        out.push(mapPointRow(row));
      }
      cursor = chunkEnd + 1;
      if (cursor <= end) {
        await yieldToLoop();
      }
    }
    return out;
  }

  /**
   * All forecast points of one cycle, ascending by hour offset — the
   * day-view raw path reassembles a cycle's forecast curve from these.
   *
   * @param {number|Date} cycleTs - Cycle timestamp (epoch ms or Date)
   * @returns {object[]}
   */
  getPointsByCycle(cycleTs) {
    this.#ensureOpen();
    const ts = toMs(cycleTs);
    return this.statements.pointsByCycle.all(ts).map(mapPointRow);
  }

  /**
   * All forecast points of every cycle in a cycle-timestamp range,
   * grouped per cycle — one PK range scan (keyset-paginated, yielding
   * between pages) instead of per-cycle queries. Used by the API layer
   * to reassemble legacy cycle records with their forecast arrays.
   *
   * @param {number} fromCycleTs - Cycle timestamp range start (epoch ms)
   * @param {number} toCycleTs - Cycle timestamp range end (epoch ms)
   * @returns {Promise<Map<number, object[]>>} cycle_ts → mapped points
   *          (h order)
   */
  async getPointsByCycleRange(fromCycleTs, toCycleTs) {
    this.#ensureOpen();
    const stmt = this.statements.pointsForCycles;
    const byCycle = new Map();
    let afterCycle = fromCycleTs - 1;
    let afterH = 0;
    for (;;) {
      const rows = stmt.all(
        fromCycleTs,
        toCycleTs,
        afterCycle,
        afterH,
        this.pageSize,
      );
      for (const row of rows) {
        const ts = row.cycle_ts;
        let list = byCycle.get(ts);
        if (!list) {
          list = [];
          byCycle.set(ts, list);
        }
        list.push(mapPointRow(row));
      }
      if (rows.length < this.pageSize) {
        return byCycle;
      }
      afterCycle = rows[rows.length - 1].cycle_ts;
      afterH = rows[rows.length - 1].h;
      await yieldToLoop();
    }
  }

  /**
   * Aggregated forecast totals over the freshest hourly prediction per
   * hour bucket (the same winner rule the webapp summary builder uses),
   * computed entirely in SQL — this is what makes month views cheap.
   *
   * @param {Date} from
   * @param {Date} to
   * @returns {{hours: number, idealSolarWh: number, idealWindWh: number,
   *           idealHydroWh: number, alternatorWh: number,
   *           houseLoadWh: number, idealNetWh: number}}
   */
  summaryTotals(from, to) {
    this.#ensureOpen();
    return this.statements.summaryTotals.get(hourFloor(from), hourFloor(to));
  }

  /**
   * Newest records of one type since a timestamp, descending.
   *
   * @param {string} type
   * @param {Date} since
   * @param {number} [limit=1]
   * @returns {object[]}
   */
  latestRecords(type, since, limit = 1) {
    this.#ensureOpen();
    return this.statements.latestRecords
      .all(type, since.getTime(), limit)
      .map((row) => JSON.parse(row.json));
  }

  /**
   * Writes (upserts) a record as-is — used by tooling that rewrites
   * stored records (advisory backfill CLI).
   *
   * @param {string} type
   * @param {Date|number} timestamp
   * @param {object} record - Full record (its `type` must match)
   * @returns {void}
   */
  writeRecord(type, timestamp, record) {
    this.#ensureOpen();
    this.statements.putRecord.run(
      type,
      toMs(timestamp),
      JSON.stringify(record),
    );
  }

  /**
   * The [min, max] timestamp extent of a record type, or null when empty
   * (advisory backfill CLI's default date range).
   *
   * @param {string} type
   * @returns {{from: number, to: number}|null} epoch ms
   */
  recordsRange(type) {
    this.#ensureOpen();
    const row = this.statements.recordsRange.get(type);
    if (row == null || row.min == null) {
      return null;
    }
    return { from: row.min, to: row.max };
  }

  /**
   * Per-cycle point spans (first/last point timestamps) for the
   * deploy-state coverage pass — maintained at write time, so the read
   * is a tiny range scan over `deploy_spans` instead of aggregating
   * every point row.
   *
   * @param {number} fromCycleTs
   * @param {number} toCycleTs
   * @returns {Map<number, {startMs: number, endMs: number}>}
   */
  getDeploySpans(fromCycleTs, toCycleTs) {
    this.#ensureOpen();
    const spans = new Map();
    for (const row of this.statements.deploySpans.all(fromCycleTs, toCycleTs)) {
      spans.set(row.cycle_ts, { startMs: row.start_ms, endMs: row.end_ms });
    }
    return spans;
  }

  /**
   * Per-cycle forecast points carrying deploy/stow actions (normalized
   * at write time into `deploy_actions`), ordered by cycle then hour so
   * last-wins Map semantics match the in-memory builder. Actions are
   * reconstructed in the slim shape the deploy-states loader attaches.
   *
   * @param {number} fromCycleTs
   * @param {number} toCycleTs
   * @returns {Map<number, Array<{ts: number, actions: object[]}>>}
   */
  getDeployActionPoints(fromCycleTs, toCycleTs) {
    this.#ensureOpen();
    const byCycle = new Map();
    for (const row of this.statements.deployActionRows.all(
      fromCycleTs,
      toCycleTs,
    )) {
      let list = byCycle.get(row.cycle_ts);
      if (!list) {
        list = [];
        byCycle.set(row.cycle_ts, list);
      }
      // Group rows of the same point (same ts) into one slim point
      let point = list.length > 0 ? list[list.length - 1] : null;
      if (!point || point.ts !== row.ts) {
        point = { ts: row.ts, actions: [] };
        list.push(point);
      }
      point.actions.push({
        id: row.id,
        idealAction: row.action,
        detectedAction: null,
        reason: row.reason ?? "",
      });
    }
    return byCycle;
  }

  /**
   * Reads a meta value (migration done-list, schema version, ...).
   *
   * @param {string} key
   * @returns {string|null}
   */
  getMeta(key) {
    this.#ensureOpen();
    const row = this.statements.getMeta.get(key);
    return row ? row.value : null;
  }

  /**
   * Number of stored rows for a record type (migration/tests).
   *
   * @param {string} type
   * @returns {number}
   */
  countRecords(type) {
    this.#ensureOpen();
    return this.statements.countRecords.get(type).n;
  }

  /**
   * Total forecast point rows (tests).
   * @returns {number}
   */
  countForecastPoints() {
    this.#ensureOpen();
    return this.statements.countPoints.get().n;
  }

  /**
   * Overwrites sticky signal fields (navState, position) on samples in a
   * window — a streamed UPDATE replacing the old whole-file rewrite.
   * Same semantics as the NDJSON recorder's helper: fields are only
   * written when the resolver returns a different value.
   *
   * @param {Date} from - Window start
   * @param {Date} to - Window end
   * @param {(tsMs: number) => {navState: string|null, position: {latitude: number, longitude: number}|null}} resolve
   * @returns {Promise<{updated: number}>} Count of changed samples
   */
  async overwriteStickyFields(from, to, resolve) {
    let updated = 0;
    const result = await this.updateSamples(from, to, (record) => {
      const ts = Date.parse(record.timestamp);
      const r = resolve(ts);
      let changed = false;
      if (r.navState != null && r.navState !== record.navState) {
        record.navState = r.navState;
        changed = true;
      }
      if (r.position && !deepEqualPos(r.position, record.position)) {
        record.position = r.position;
        changed = true;
      }
      if (!changed) {
        return null;
      }
      updated += 1;
      return record;
    });
    this.app.debug?.(`Overwrote sticky fields on ${result.updated} samples`);
    return result;
  }

  /**
   * Rewrites samples in a window through a mutate callback: for each
   * sample (ascending), `mutate(record)` returns the modified record or
   * null/undefined to leave it untouched. The callback runs exactly once
   * per row, sequentially, so closure counters are safe. Replaces the
   * NDJSON era's whole-day-file rewrites (backfill deploy-state
   * augmentation and friends).
   *
   * @param {Date} from - Window start
   * @param {Date} to - Window end
   * @param {(record: object) => object|null|undefined} mutate
   * @returns {Promise<{updated: number}>} Count of rewritten samples
   */
  async updateSamples(from, to, mutate) {
    this.#ensureOpen();
    let updated = 0;
    let after = from.getTime() - 1;
    for (;;) {
      const rows = this.statements.recordsPage.all(
        "sample",
        from.getTime(),
        to.getTime(),
        after,
        this.pageSize,
      );
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        const record = JSON.parse(row.json);
        const modified = mutate(record);
        if (modified != null) {
          this.statements.updateRecordJson.run(
            JSON.stringify(modified),
            "sample",
            row.ts,
          );
          updated++;
        }
      }
      if (rows.length < this.pageSize) {
        break;
      }
      after = rows[rows.length - 1].ts;
      await yieldToLoop();
    }
    return { updated };
  }

  /**
   * Prunes records older than the retention window (points go with
   * their owning cycle, even when a point's own ts is newer).
   *
   * @returns {Promise<{deleted: number}>}
   */
  async prune() {
    if (!this.enabled) {
      return { deleted: 0 };
    }
    this.#ensureOpen();
    const cutoff = Date.now() - this.retentionDays * 86400000;
    this.db.exec("BEGIN");
    try {
      const points = this.statements.deletePointsBeforeCycle.run(cutoff);
      const deployActions =
        this.statements.deleteDeployActionsBefore.run(cutoff);
      const deploySpans = this.statements.deleteDeploySpansBefore.run(cutoff);
      const records = this.statements.deleteRecordsBefore.run(cutoff);
      this.db.exec("COMMIT");
      try {
        this.db.exec("PRAGMA incremental_vacuum");
      } catch (_vacuumError) {
        /* best-effort space reclaim */
      }
      const deleted =
        (points.changes ?? 0) +
        (deployActions.changes ?? 0) +
        (deploySpans.changes ?? 0) +
        (records.changes ?? 0);
      this.app.debug?.(`Pruned ${deleted} rows before retention cutoff`);
      return { deleted };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Starts the daily prune interval (mirrors the old recorder).
   *
   * @returns {void}
   */
  startPruneInterval() {
    if (!this.enabled || this.pruneIntervalId !== null) {
      return;
    }
    const msPerDay = 24 * 60 * 60 * 1000;
    const now = new Date();
    const nextMidnight = new Date();
    nextMidnight.setHours(24, 0, 0, 0);
    const initialDelay = Math.max(0, nextMidnight.getTime() - now.getTime());
    this.pruneIntervalId = setTimeout(async () => {
      await this.prune().catch(() => {});
      this.pruneIntervalId = setInterval(async () => {
        await this.prune().catch(() => {});
      }, msPerDay);
    }, initialDelay);
    this.app.debug?.("Prune interval started");
  }

  /**
   * Stops the prune interval.
   *
   * @returns {void}
   */
  stopPruneInterval() {
    if (this.pruneIntervalId !== null) {
      clearTimeout(this.pruneIntervalId);
      clearInterval(this.pruneIntervalId);
      this.pruneIntervalId = null;
      this.app.debug?.("Prune interval stopped");
    }
  }

  /**
   * Updates the store configuration.
   *
   * @param {object} config
   */
  updateConfig(config) {
    this.enabled = config.enabled !== false;
    this.retentionDays = config.retentionDays ?? 90;
    this.app.debug?.(
      `RecordStore config updated: enabled=${this.enabled}, retentionDays=${this.retentionDays}`,
    );
  }
}

module.exports = {
  RecordStore,
  loadSqlite,
  POINT_COLUMNS,
};
