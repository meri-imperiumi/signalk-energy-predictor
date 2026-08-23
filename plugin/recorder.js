/**
 * Recorder for energy predictions and measured values.
 *
 * Stores cycle records (prediction runs) and sample records (5-minute buckets)
 * in daily JSONL files for later query by the timeline webapp API.
 *
 * @file recorder.js
 */

const fs = require("node:fs/promises");
const path = require("node:path");

/**
 * Gets the current date's recording file path.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {Date} [date] - Date to get file for (defaults to now)
 * @returns {string} File path
 */
function getRecordingsPath(dataDir, date = new Date()) {
  // Use UTC methods to ensure consistent filenames regardless of local timezone
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return path.join(dataDir, "recordings", `${year}-${month}-${day}.jsonl`);
}

/**
 * Ensures the recordings directory exists.
 *
 * @param {string} dataDir - Plugin data directory
 * @returns {Promise<void>}
 */
async function ensureRecordingsDir(dataDir) {
  const recordingsDir = path.join(dataDir, "recordings");
  try {
    await fs.mkdir(recordingsDir, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

/**
 * Records a cycle (prediction run).
 *
 * @param {object} app - Signal K server API (for logging)
 * @param {string} dataDir - Plugin data directory
 * @param {object} cycle - Cycle data to record
 * @param {Date} cycle.timestamp - Prediction timestamp
 * @param {number} cycle.weatherTier - Weather tier (1-4)
 * @param {object[]} cycle.forecast - Hourly forecast objects
 * @param {object} cycle.actions - Advisory actions for the cycle
 * @returns {Promise<void>}
 */
async function recordCycle(app, dataDir, cycle) {
  await ensureRecordingsDir(dataDir);

  const filePath = getRecordingsPath(dataDir, cycle.timestamp);
  const record = {
    type: "cycle",
    timestamp: cycle.timestamp.toISOString(),
    weatherTier: cycle.weatherTier,
    forecast: cycle.forecast,
    actions: cycle.actions,
  };

  const line = `${JSON.stringify(record)}\n`;

  try {
    await fs.appendFile(filePath, line, { encoding: "utf-8" });
    app.debug?.(`Recorded cycle at ${cycle.timestamp.toISOString()}`);
  } catch (error) {
    app.error?.(`Failed to record cycle: ${error.message}`);
  }
}

/**
 * Records a sample (5-minute bucket of measured values).
 *
 * @param {object} app - Signal K server API (for logging)
 * @param {string} dataDir - Plugin data directory
 * @param {object} sample - Sample data to record
 * @param {Date} sample.timestamp - Sample timestamp
 * @param {object} sample.arrays - Per-array power readings (W)
 * @param {object} sample.generators - Per-generator power readings (W)
 * @param {number} sample.soc - Battery state of charge [0-1]
 * @param {number} sample.houseLoadW - House load in watts
 * @param {number} sample.windSpeedKnots - Wind speed in knots
 * @param {string} sample.navState - Navigation state
 * @param {object|null} sample.position - Position {latitude, longitude}
 * @param {number|null} [sample.stwKnots] - Speed through water in knots
 * @returns {Promise<void>}
 */
async function recordSample(app, dataDir, sample) {
  await ensureRecordingsDir(dataDir);

  const filePath = getRecordingsPath(dataDir, sample.timestamp);
  const record = {
    type: "sample",
    timestamp: sample.timestamp.toISOString(),
    arrays: sample.arrays,
    generators: sample.generators,
    soc: sample.soc,
    houseLoadW: sample.houseLoadW,
    windSpeedKnots: sample.windSpeedKnots,
    navState: sample.navState,
    position: sample.position,
    stwKnots: sample.stwKnots ?? null,
  };

  const line = `${JSON.stringify(record)}\n`;

  try {
    await fs.appendFile(filePath, line, { encoding: "utf-8" });
    app.debug?.(`Recorded sample at ${sample.timestamp.toISOString()}`);
  } catch (error) {
    app.error?.(`Failed to record sample: ${error.message}`);
  }
}

/**
 * Records a Wind Protection Factor learning observation.
 *
 * Each time the WPF engine updates a bin, we persist the raw comparison
 * (measured vs forecast, normalized to the 10 m reference) so the factor
 * history for a place is queryable later — both for the webapp timeline
 * and as material for offline backfilling of factors from archived wind.
 *
 * @param {object} app - Signal K server API (for logging)
 * @param {string} dataDir - Plugin data directory
 * @param {object} obs - Observation
 * @param {Date} obs.timestamp - Observation timestamp
 * @param {string} obs.placeKey - Place cell key
 * @param {number} obs.sector - Wind direction sector 0–7 (-1 unknown)
 * @param {boolean} obs.night - Day/night bin
 * @param {number} obs.measuredSpeedKnots - Measured wind at 10 m ref (knots)
 * @param {number} obs.forecastSpeedKnots - Forecast wind speed (knots)
 * @param {number|null} [obs.measuredGustKnots] - Measured gust at 10 m ref
 * @param {number|null} [obs.forecastGustKnots] - Forecast gust (knots)
 * @param {number|null} [obs.windDirectionDeg] - Forecast wind direction (deg)
 * @param {number} obs.speedFactor - Resulting speed factor (post-update)
 * @param {number} obs.gustFactor - Resulting gust factor (post-update)
 * @param {{latitude: number, longitude: number}} obs.position - Vessel position
 * @param {string} obs.navState - Navigation state
 * @param {number} obs.anemometerHeightM - Anemometer height used (m)
 * @returns {Promise<void>}
 */
async function recordWindProtection(app, dataDir, obs) {
  await ensureRecordingsDir(dataDir);

  const filePath = getRecordingsPath(dataDir, obs.timestamp);
  const record = {
    type: "wind-protection",
    timestamp: obs.timestamp.toISOString(),
    placeKey: obs.placeKey,
    sector: obs.sector,
    night: obs.night,
    measuredSpeedKnots: round4(obs.measuredSpeedKnots),
    forecastSpeedKnots: round4(obs.forecastSpeedKnots),
    measuredGustKnots:
      obs.measuredGustKnots != null ? round4(obs.measuredGustKnots) : null,
    forecastGustKnots:
      obs.forecastGustKnots != null ? round4(obs.forecastGustKnots) : null,
    windDirectionDeg: obs.windDirectionDeg ?? null,
    speedFactor: round4(obs.speedFactor),
    gustFactor: round4(obs.gustFactor),
    position: obs.position,
    navState: obs.navState,
    anemometerHeightM: obs.anemometerHeightM,
  };

  const line = `${JSON.stringify(record)}\n`;

  try {
    await fs.appendFile(filePath, line, { encoding: "utf-8" });
    app.debug?.(
      `Recorded wind-protection observation at ${obs.timestamp.toISOString()}`,
    );
  } catch (error) {
    app.error?.(
      `Failed to record wind-protection observation: ${error.message}`,
    );
  }
}

/**
 * Rounds to 4 decimal places.
 * @param {number} v
 * @returns {number}
 */
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/**
 * Prunes old recordings based on retention days.
 *
 * @param {object} app - Signal K server API (for logging)
 * @param {string} dataDir - Plugin data directory
 * @param {number} retentionDays - Days to retain
 * @returns {Promise<{deleted: number, errors: string[]}>}
 */
async function pruneOldRecordings(app, dataDir, retentionDays) {
  const recordingsDir = path.join(dataDir, "recordings");
  // Use current UTC date for cutoff to match file naming
  const now = new Date();
  const cutoffDate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - retentionDays,
    ),
  );

  const result = {
    deleted: 0,
    errors: [],
  };

  try {
    const files = await fs.readdir(recordingsDir);

    for (const file of files) {
      // Parse date from filename (YYYY-MM-DD.jsonl)
      const match = file.match(/^(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
      if (!match) {
        continue;
      }

      // Parse file date as UTC to match getRecordingsPath behavior
      const fileDate = new Date(
        Date.UTC(
          parseInt(match[1], 10),
          parseInt(match[2], 10) - 1,
          parseInt(match[3], 10),
        ),
      );

      if (fileDate < cutoffDate) {
        const filePath = path.join(recordingsDir, file);
        try {
          await fs.unlink(filePath);
          result.deleted++;
          app.debug?.(`Pruned old recording: ${file}`);
        } catch (error) {
          result.errors.push(`Failed to delete ${file}: ${error.message}`);
          app.error?.(`Failed to prune ${file}: ${error.message}`);
        }
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      app.error?.(`Failed to prune recordings: ${error.message}`);
      result.errors.push(error.message);
    }
  }

  return result;
}

/**
 * Overwrites sticky signal fields (navState, position) on existing sample
 * records across a window, rewriting each affected day-file in place.
 *
 * Sticky signals (navigation.state, navigation.position) are unreliable
 * in the live delta stream — they flap between values (e.g. anchored ↔
 * moored) when a source drops out or an autostate plugin toggles. The
 * History API's :last aggregate is the stable source of truth. During
 * backfill we resolve each sample's sticky fields from the history-derived
 * carry-forward map and overwrite the live values, while leaving the
 * continuous measurements (power, SoC, load) intact.
 *
 * @param {object} app - Signal K server API (for logging)
 * @param {string} dataDir - Plugin data directory
 * @param {Date} from - Window start
 * @param {Date} to - Window end
 * @param {(tsMs: number) => {navState: string|null, position: {latitude: number, longitude: number}|null}} resolve
 *        Returns the sticky values to write for a sample timestamp
 * @returns {Promise<{updated: number, files: number}>} Counts
 */
async function overwriteStickyFields(app, dataDir, from, to, resolve) {
  const recordingsDir = path.join(dataDir, "recordings");
  let updated = 0;
  let files = 0;
  const current = new Date(from);
  const endDate = new Date(to);
  while (current <= endDate) {
    const filePath = getRecordingsPath(dataDir, current);
    let lines;
    try {
      lines = (await fs.readFile(filePath, { encoding: "utf-8" })).split("\n");
    } catch (error) {
      if (error.code === "ENOENT") {
        current.setUTCDate(current.getUTCDate() + 1);
        continue;
      }
      throw error;
    }
    let changed = false;
    const out = [];
    for (const line of lines) {
      if (!line.trim()) {
        out.push(line);
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch (_parseError) {
        out.push(line);
        continue;
      }
      if (
        record.type === "sample" &&
        record.timestamp &&
        new Date(record.timestamp) >= from &&
        new Date(record.timestamp) <= to
      ) {
        const r = resolve(new Date(record.timestamp).getTime());
        if (r.navState != null && r.navState !== record.navState) {
          record.navState = r.navState;
          changed = true;
        }
        if (r.position && !deepEqualPos(r.position, record.position)) {
          record.position = r.position;
          changed = true;
        }
        if (changed) updated++;
        out.push(JSON.stringify(record));
      } else {
        out.push(line);
      }
    }
    if (changed) {
      await fs.writeFile(filePath, out.join("\n"), { encoding: "utf-8" });
      files++;
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  app.debug?.(
    `Overwrote sticky fields on ${updated} samples in ${files} files`,
  );
  return { updated, files };
}

/**
 * Shallow position equality for overwrite decisions.
 * @param {{latitude: number, longitude: number}} a
 * @param {{latitude: number, longitude: number}|null} b
 * @returns {boolean}
 */
function deepEqualPos(a, b) {
  return b != null && a.latitude === b.latitude && a.longitude === b.longitude;
}

/**
 * Reads records from a file within a time window.
 *
 * @param {string} filePath - File path to read
 * @param {Date} from - Start of window
 * @param {Date} to - End of window
 * @param {string} [type] - Optional record type filter ("cycle" or "sample")
 * @returns {Promise<object[]>} Array of parsed records
 */
async function readRecords(filePath, from, to, type) {
  const records = [];

  try {
    const content = await fs.readFile(filePath, { encoding: "utf-8" });
    const lines = content.split("\n").filter((line) => line.trim());

    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch (_parseError) {
        continue;
      }

      // Filter by type if specified
      if (type && record.type !== type) {
        continue;
      }

      // Filter by time window
      const recordTime = new Date(record.timestamp);
      if (recordTime >= from && recordTime <= to) {
        records.push(record);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  return records;
}

/**
 * Gets recordings for a date range.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {Date} from - Start of range
 * @param {Date} to - End of range
 * @param {string} [type] - Optional record type filter
 * @returns {Promise<object[]>} Array of records
 */
async function getRecordings(dataDir, from, to, type) {
  const recordings = [];
  const _recordingsDir = path.join(dataDir, "recordings");

  const current = new Date(from);
  const endDate = new Date(to);

  while (current <= endDate) {
    const filePath = getRecordingsPath(dataDir, current);
    const dayRecords = await readRecords(filePath, from, to, type);
    recordings.push(...dayRecords);

    current.setDate(current.getDate() + 1);
  }

  // Sort by timestamp
  recordings.sort((a, b) => {
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  return recordings;
}

/**
 * Recorder class with config-aware lifecycle.
 */
class Recorder {
  /**
   * Creates a new Recorder instance.
   *
   * @param {object} app - Signal K server API
   * @param {string} dataDir - Plugin data directory
   * @param {object} config - Recording configuration
   * @param {boolean} [config.enabled=true] - Whether recording is enabled
   * @param {number} [config.retentionDays=90] - Retention period in days
   */
  constructor(app, dataDir, config = {}) {
    this.app = app;
    this.dataDir = dataDir;
    this.enabled = config.enabled !== false;
    this.retentionDays = config.retentionDays ?? 90;
    this.pruneIntervalId = null;
  }

  /**
   * Updates the recorder configuration.
   *
   * @param {object} config - New configuration
   */
  updateConfig(config) {
    this.enabled = config.enabled !== false;
    this.retentionDays = config.retentionDays ?? 90;
    this.app.debug?.(
      `Recorder config updated: enabled=${this.enabled}, retentionDays=${this.retentionDays}`,
    );
  }

  /**
   * Records a cycle if enabled.
   *
   * @param {object} cycle - Cycle data
   * @returns {Promise<void>}
   */
  async recordCycle(cycle) {
    if (!this.enabled) {
      return;
    }
    return recordCycle(this.app, this.dataDir, cycle);
  }

  /**
   * Records a sample if enabled.
   *
   * @param {object} sample - Sample data
   * @returns {Promise<void>}
   */
  async recordSample(sample) {
    if (!this.enabled) {
      return;
    }
    return recordSample(this.app, this.dataDir, sample);
  }

  /**
   * Records a Wind Protection Factor learning observation if enabled.
   *
   * @param {object} obs - Observation (see recordWindProtection)
   * @returns {Promise<void>}
   */
  async recordWindProtection(obs) {
    if (!this.enabled) {
      return;
    }
    return recordWindProtection(this.app, this.dataDir, obs);
  }

  /**
   * Prunes old recordings if enabled.
   *
   * @returns {Promise<{deleted: number, errors: string[]}>}
   */
  async prune() {
    if (!this.enabled) {
      return { deleted: 0, errors: [] };
    }
    return pruneOldRecordings(this.app, this.dataDir, this.retentionDays);
  }

  /**
   * Starts daily prune interval.
   *
   * @returns {void}
   */
  startPruneInterval() {
    if (!this.enabled) {
      return;
    }

    // Prune once per day at midnight (approximately)
    const msPerDay = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const nextMidnight = new Date();
    nextMidnight.setHours(24, 0, 0, 0);
    const initialDelay = Math.max(0, nextMidnight.getTime() - now);

    this.pruneIntervalId = setTimeout(async () => {
      await this.prune();
      // Then run daily
      this.pruneIntervalId = setInterval(async () => {
        await this.prune();
      }, msPerDay);
    }, initialDelay);

    this.app.debug?.("Prune interval started");
  }

  /**
   * Stops prune interval.
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
   * Gets recordings for a date range.
   *
   * @param {Date} from - Start of range
   * @param {Date} to - End of range
   * @param {string} [type] - Optional record type filter
   * @returns {Promise<object[]>} Array of records
   */
  async getRecordings(from, to, type) {
    if (!this.enabled) {
      return [];
    }
    return getRecordings(this.dataDir, from, to, type);
  }
}

module.exports = {
  Recorder,
  recordCycle,
  recordSample,
  recordWindProtection,
  pruneOldRecordings,
  overwriteStickyFields,
  getRecordings,
  getRecordingsPath,
  ensureRecordingsDir,
};
