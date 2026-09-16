/**
 * Tests for the NDJSON -> SQLite import (plugin/storage-migrate.js).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RecordStore } = require("../plugin/storage.js");
const {
  migrateNdjsonRecordings,
  DONE_PREFIX,
  BACKUP_DIR_NAME,
} = require("../plugin/storage-migrate.js");

const HOUR = 3600000;

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-migrate-"));
  const recordings = path.join(dir, "recordings");
  fs.mkdirSync(recordings, { recursive: true });
  const logs = { errors: [], debugs: [] };
  const app = {
    debug(msg) {
      logs.debugs.push(msg);
    },
    error(msg) {
      logs.errors.push(msg);
    },
  };
  const store = new RecordStore(app, dir, {});
  store.open();
  return {
    dir,
    recordings,
    store,
    app,
    logs,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeDay(env, date, records, { trailingTorn = false } = {}) {
  const lines = records.map((r) => JSON.stringify(r));
  if (trailingTorn) {
    lines.push('{"type":"sample","timestamp":"2026-09-01T0'); // torn append
  }
  fs.writeFileSync(
    path.join(env.recordings, `${date}.jsonl`),
    lines.join("\n") + "\n",
  );
}

const cycleAt = (ms, hours = 2) => ({
  type: "cycle",
  timestamp: new Date(ms).toISOString(),
  weatherTier: 2,
  forecast: Array.from({ length: hours }, (_, h) => ({
    time: new Date(ms + h * HOUR).toISOString(),
    idealSolarYieldWh: 100 + h,
    idealWindYieldWh: 50,
    idealHydroYieldWh: 0,
    houseLoadWh: 120,
    idealNetWh: 30,
    idealSoC: 0.8,
    detectedYieldWh: 60,
    detectedNetWh: -10,
    detectedSoC: 0.79,
    windSpeedKnots: 12,
    gustSpeedKnots: 18,
    actions: [{ id: "wind-1", idealAction: "stay", reason: "light" }],
  })),
  actions: { wind1: "stay" },
  advisories: [],
});

const sampleAt = (ms, navState = "anchored") => ({
  type: "sample",
  timestamp: new Date(ms).toISOString(),
  arrays: { "sol-1": { powerW: 180, soc: 0.8 } },
  generators: {},
  soc: 0.8,
  houseLoadW: 130,
  windSpeedKnots: 12.1,
  navState,
  position: { latitude: 60.15, longitude: 24.9 },
  stwKnots: 0.2,
  deployStates: {},
  controllerModes: {},
  awaRad: 1.2,
});

const wpAt = (ms) => ({
  type: "wind-protection",
  timestamp: new Date(ms).toISOString(),
  placeKey: "60_24",
  sector: 3,
  night: false,
  measuredSpeedKnots: 15.2,
  forecastSpeedKnots: 12,
  measuredGustKnots: null,
  forecastGustKnots: null,
  windDirectionDeg: 215,
  speedFactor: 1.25,
  gustFactor: 1.18,
  position: { latitude: 60.15, longitude: 24.9 },
  navState: "anchored",
  anemometerHeightM: 16,
});

test("absent recordings dir is a no-op", async () => {
  const env = makeEnv();
  fs.rmSync(env.recordings, { recursive: true });
  const result = await migrateNdjsonRecordings({
    app: { debug() {}, error() {} },
    store: env.store,
    dataDir: env.dir,
  });
  assert.deepEqual(result, {
    files: 0,
    imported: 0,
    skipped: 0,
    failed: [],
    renamed: false,
  });
  env.cleanup();
});

test("empty recordings dir is a no-op", async () => {
  const env = makeEnv();
  const result = await migrateNdjsonRecordings({
    app: { debug() {}, error() {} },
    store: env.store,
    dataDir: env.dir,
  });
  assert.equal(result.files, 0);
  assert.equal(result.renamed, false);
  assert.ok(fs.existsSync(env.recordings));
  env.cleanup();
});

test("imports mixed records with tolerance, then renames to backup", async () => {
  const env = makeEnv();
  const base = Date.UTC(2026, 8, 1);
  writeDay(
    env,
    "2026-09-01",
    [
      cycleAt(base),
      sampleAt(base + 300000),
      wpAt(base + 600000),
      { type: "mystery", timestamp: new Date(base).toISOString() }, // unknown type
    ],
    { trailingTorn: true },
  );

  const result = await migrateNdjsonRecordings({
    app: env.app,
    store: env.store,
    dataDir: env.dir,
  });

  // 3 valid records; unknown type + torn line skipped
  assert.equal(result.imported, 3);
  assert.equal(result.skipped, 2);
  assert.equal(result.files, 1);
  assert.deepEqual(result.failed, []);
  assert.equal(result.renamed, true);

  // Dir renamed, backup holds the original bytes
  assert.ok(!fs.existsSync(env.recordings));
  const backup = path.join(env.dir, BACKUP_DIR_NAME);
  assert.ok(fs.existsSync(path.join(backup, "2026-09-01.jsonl")));

  // Fidelity: sample fields survive verbatim
  const samples = await env.store.getRecords(
    "sample",
    new Date(base),
    new Date(base + HOUR),
  );
  assert.equal(samples.length, 1);
  assert.equal(samples[0].houseLoadW, 130);
  assert.deepEqual(samples[0].position, { latitude: 60.15, longitude: 24.9 });

  // Cycle: metadata row + point rows
  const cycles = await env.store.getRecords(
    "cycle",
    new Date(base),
    new Date(base + HOUR),
  );
  assert.equal(cycles.length, 1);
  assert.equal("forecast" in cycles[0], false);
  const points = await env.store.getForecastPoints(
    new Date(base),
    new Date(base + 2 * HOUR),
  );
  assert.equal(points.length, 2);
  assert.equal(points[1].idealSolarYieldWh, 101);

  // Wind-protection observation
  const wp = await env.store.getRecords(
    "wind-protection",
    new Date(base),
    new Date(base + HOUR),
  );
  assert.equal(wp.length, 1);
  assert.equal(wp[0].speedFactor, 1.25);

  // Second run: dir is gone, nothing happens
  const again = await migrateNdjsonRecordings({
    app: { debug() {}, error() {} },
    store: env.store,
    dataDir: env.dir,
  });
  assert.equal(again.files, 0);
  env.cleanup();
});

test("crash mid-migration: done files are skipped, failed file retried once", async () => {
  const env = makeEnv();
  const base = Date.UTC(2026, 8, 1);
  writeDay(env, "2026-09-01", [sampleAt(base)]);
  writeDay(env, "2026-09-02", [sampleAt(base + 86400000)]);

  // Simulate a crash on the first file: make the first insert fail once.
  // File 1 fails and rolls back; file 2 imports normally in the same run.
  const realPutRecord = env.store.statements.putRecord.run.bind(
    env.store.statements.putRecord,
  );
  let poisoned = false;
  env.store.statements.putRecord.run = (...args) => {
    if (!poisoned) {
      poisoned = true;
      throw new Error("simulated crash");
    }
    return realPutRecord(...args);
  };

  const first = await migrateNdjsonRecordings({
    app: { debug() {}, error() {} },
    store: env.store,
    dataDir: env.dir,
  });
  assert.deepEqual(first.failed, ["2026-09-01.jsonl"]);
  assert.equal(first.imported, 1); // file 2 made it
  assert.equal(first.renamed, false);
  assert.ok(fs.existsSync(env.recordings));

  // The failed file is not done-listed
  assert.equal(env.store.getMeta(DONE_PREFIX + "2026-09-01.jsonl"), null);
  assert.ok(env.store.getMeta(DONE_PREFIX + "2026-09-02.jsonl") != null);

  // Retry after the "crash": only the failed file imports, rename happens
  env.store.statements.putRecord.run = realPutRecord;
  const second = await migrateNdjsonRecordings({
    app: { debug() {}, error() {} },
    store: env.store,
    dataDir: env.dir,
  });
  assert.equal(second.imported, 1);
  assert.equal(second.files, 1);
  assert.equal(second.renamed, true);

  // No duplicates: each sample appears once despite the poisoned attempt
  const samples = await env.store.getRecords(
    "sample",
    new Date(base),
    new Date(base + 2 * 86400000),
  );
  assert.equal(samples.length, 2);
  env.cleanup();
});

test("done-listed files are never re-imported (even before rename)", async () => {
  const env = makeEnv();
  const base = Date.UTC(2026, 8, 1);
  writeDay(env, "2026-09-01", [sampleAt(base)]);

  // First run imports + renames
  await migrateNdjsonRecordings({
    app: { debug() {}, error() {} },
    store: env.store,
    dataDir: env.dir,
  });

  // Recreate the dir (e.g. user restores a copy): the done-list must
  // prevent a second import
  fs.mkdirSync(env.recordings, { recursive: true });
  writeDay(env, "2026-09-01", [sampleAt(base)]);
  const again = await migrateNdjsonRecordings({
    app: { debug() {}, error() {} },
    store: env.store,
    dataDir: env.dir,
  });
  assert.equal(again.imported, 0);
  assert.equal(again.files, 0);
  assert.equal(again.renamed, false); // nothing new to import; dir left alone
  const samples = await env.store.getRecords(
    "sample",
    new Date(base),
    new Date(base + HOUR),
  );
  assert.equal(samples.length, 1);
  env.cleanup();
});

test("existing backup dir blocks rename but not import", async () => {
  const env = makeEnv();
  const base = Date.UTC(2026, 8, 1);
  writeDay(env, "2026-09-01", [sampleAt(base)]);
  fs.mkdirSync(path.join(env.dir, BACKUP_DIR_NAME));

  const result = await migrateNdjsonRecordings({
    app: env.app,
    store: env.store,
    dataDir: env.dir,
  });
  assert.equal(result.imported, 1);
  assert.equal(result.renamed, false);
  assert.ok(fs.existsSync(env.recordings));
  assert.ok(env.logs.errors.length >= 1);
  assert.ok(env.logs.errors[0].includes("already exists"));
  env.cleanup();
});

test("empty day file imports as done (no eternal retry)", async () => {
  const env = makeEnv();
  fs.writeFileSync(path.join(env.recordings, "2026-09-01.jsonl"), "\n\n");
  const result = await migrateNdjsonRecordings({
    app: { debug() {}, error() {} },
    store: env.store,
    dataDir: env.dir,
  });
  assert.equal(result.imported, 0);
  assert.equal(result.files, 1);
  assert.equal(result.renamed, true);
  assert.equal(
    env.store.getMeta(DONE_PREFIX + "2026-09-01.jsonl") != null,
    true,
  );
  env.cleanup();
});
