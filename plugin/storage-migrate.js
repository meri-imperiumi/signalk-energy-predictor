/**
 * One-time import of pre-existing NDJSON day recordings into the SQLite
 * record store (work doc #21, step 2).
 *
 * Runs on plugin start when `<dataDir>/recordings/` exists; a no-op
 * otherwise. Files are never imported more than once:
 *
 *  1. Done-list first: each filename is committed to the `meta` table in
 *     the same transaction as its rows, so a restart skips completed
 *     files entirely.
 *  2. Rename when complete: once every file has imported, the directory
 *     becomes `recordings-ndjson/` (kept as a backup — file storage is
 *     cheap); subsequent starts never scan it.
 *  3. UPSERT keys (`(type, ts)` / `(cycle_ts, h)`) remain as crash
 *     safety for the commit window.
 *
 * Line tolerance mirrors the old reader: blank lines, torn/unparseable
 * lines, and unknown record types are skipped and counted, never fail a
 * file. A file whose *transaction* fails is logged and left off the
 * done-list (retried next start) and blocks the rename; a mid-migration
 * crash resumes where it stopped.
 *
 * @file storage-migrate.js
 */

const fs = require("node:fs");
const path = require("node:path");

/** Done-list key prefix in the meta table */
const DONE_PREFIX = "imported:";

/** Backup directory name after a complete import */
const BACKUP_DIR_NAME = "recordings-ndjson";

/** Day-file name pattern (same as the old recorder's prune scan) */
const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/** @returns {Promise<void>} */
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Imports all NDJSON day files from `<dataDir>/recordings/` into `store`.
 *
 * @param {object} params
 * @param {object} params.app - Signal K server API (for logging)
 * @param {import("./storage.js").RecordStore} params.store - Opened store
 * @param {string} params.dataDir - Plugin data directory
 * @returns {Promise<{files: number, imported: number, skipped: number,
 *                    failed: string[], renamed: boolean}>}
 */
async function migrateNdjsonRecordings({ app, store, dataDir }) {
  const recordingsDir = path.join(dataDir, "recordings");

  let entries;
  try {
    entries = fs.readdirSync(recordingsDir);
  } catch (_error) {
    // No legacy recordings: nothing to do
    return { files: 0, imported: 0, skipped: 0, failed: [], renamed: false };
  }
  const dayFiles = entries.filter((f) => DAY_FILE.test(f)).sort();
  if (dayFiles.length === 0) {
    return { files: 0, imported: 0, skipped: 0, failed: [], renamed: false };
  }

  const result = {
    files: 0,
    imported: 0,
    skipped: 0,
    failed: [],
    renamed: false,
  };

  for (const file of dayFiles) {
    if (store.getMeta(DONE_PREFIX + file) != null) {
      continue; // already imported — never again
    }
    try {
      const { imported, skipped } = importDayFile(store, recordingsDir, file);
      result.files += 1;
      result.imported += imported;
      result.skipped += skipped;
      if (skipped > 0) {
        app.debug?.(
          `Imported ${file}: ${imported} records, ${skipped} lines skipped`,
        );
      }
    } catch (error) {
      result.failed.push(file);
      app.error?.(`Failed to import ${file}: ${error.message} (will retry)`);
    }
    await yieldToLoop();
  }

  if (result.failed.length === 0) {
    const backupDir = path.join(dataDir, BACKUP_DIR_NAME);
    try {
      if (fs.existsSync(backupDir)) {
        app.error?.(
          `Cannot rename ${recordingsDir}: ${BACKUP_DIR_NAME} already exists ` +
            `(files stay imported and done-listed; remove the old backup to ` +
            `retry the rename)`,
        );
      } else {
        fs.renameSync(recordingsDir, backupDir);
        result.renamed = true;
      }
    } catch (error) {
      app.error?.(
        `Failed to rename ${recordingsDir} to ${BACKUP_DIR_NAME}: ${error.message}`,
      );
    }
  }

  app.debug?.(
    `NDJSON import: ${result.files} files, ${result.imported} records, ` +
      `${result.skipped} lines skipped, ${result.failed.length} failed, ` +
      `renamed=${result.renamed}`,
  );
  return result;
}

/**
 * Imports one day file in a single transaction (rows + done-list entry).
 *
 * @param {import("./storage.js").RecordStore} store
 * @param {string} dir - Recordings directory
 * @param {string} file - Day file name
 * @returns {{imported: number, skipped: number}}
 */
function importDayFile(store, dir, file) {
  const content = fs.readFileSync(path.join(dir, file), {
    encoding: "utf-8",
  });
  const lines = content.split("\n");
  let imported = 0;
  let skipped = 0;

  store.db.exec("BEGIN");
  try {
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch (_parseError) {
        skipped += 1; // torn line (e.g. power loss mid-append)
        continue;
      }
      const ts = Date.parse(record.timestamp);
      if (
        !Number.isFinite(ts) ||
        (record.type !== "sample" &&
          record.type !== "cycle" &&
          record.type !== "wind-protection")
      ) {
        skipped += 1;
        continue;
      }
      if (record.type === "cycle") {
        // Strip the forecast: metadata goes to records, hours to points.
        // Rest-spread keeps any extra legacy fields verbatim.
        const { forecast, ...metadata } = record;
        store.insertCycleRows(ts, metadata, forecast || []);
      } else {
        store.statements.putRecord.run(record.type, ts, JSON.stringify(record));
      }
      imported += 1;
    }
    store.statements.putMeta.run(DONE_PREFIX + file, new Date().toISOString());
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return { imported, skipped };
}

module.exports = {
  migrateNdjsonRecordings,
  DONE_PREFIX,
  BACKUP_DIR_NAME,
};
