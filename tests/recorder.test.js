/**
 * Tests for the recorder module.
 *
 * @file recorder.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  Recorder,
  recordCycle,
  recordSample,
  recordWindProtection,
  pruneOldRecordings,
  overwriteStickyFields,
  getRecordings,
  getRecordingsPath,
  ensureRecordingsDir,
} = require("../plugin/recorder.js");

test.describe("recorder", () => {
  let tempDir;
  let mockApp;

  test.beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `recorder-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    mockApp = {
      debug: () => {},
      error: () => {},
    };
  });

  test.afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test.describe("getRecordingsPath", () => {
    test("returns path for today", () => {
      const today = new Date();
      // getRecordingsPath uses UTC methods
      const expectedPath = path.join(
        tempDir,
        "recordings",
        `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}.jsonl`,
      );
      const result = getRecordingsPath(tempDir, today);
      assert.strictEqual(result, expectedPath);
    });

    test("returns path for specific date", () => {
      const date = new Date("2024-08-21T12:00:00Z");
      const expectedPath = path.join(tempDir, "recordings", "2024-08-21.jsonl");
      const result = getRecordingsPath(tempDir, date);
      assert.strictEqual(result, expectedPath);
    });
  });

  test.describe("ensureRecordingsDir", () => {
    test("creates recordings directory", async () => {
      const recordingsDir = path.join(tempDir, "recordings");
      await ensureRecordingsDir(tempDir);

      const stat = await fs.stat(recordingsDir);
      assert.strictEqual(stat.isDirectory(), true);
    });

    test("does not error if directory exists", async () => {
      const recordingsDir = path.join(tempDir, "recordings");
      await fs.mkdir(recordingsDir, { recursive: true });

      await ensureRecordingsDir(tempDir);

      const stat = await fs.stat(recordingsDir);
      assert.strictEqual(stat.isDirectory(), true);
    });
  });

  test.describe("recordCycle", () => {
    test("writes a cycle record", async () => {
      const cycle = {
        timestamp: new Date("2024-08-21T12:00:00Z"),
        weatherTier: 2,
        forecast: [
          {
            time: "2024-08-21T12:00:00Z",
            idealSolarYieldWh: 100,
            idealWindYieldWh: 50,
            houseLoadWh: 80,
            idealNetWh: 70,
            idealSoC: 0.75,
            detectedYieldWh: 95,
            detectedNetWh: 65,
            detectedSoC: 0.74,
            actions: [],
          },
        ],
        actions: [],
      };

      await recordCycle(mockApp, tempDir, cycle);

      const filePath = getRecordingsPath(tempDir, cycle.timestamp);
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.trim().split("\n");

      assert.strictEqual(lines.length, 1);
      const record = JSON.parse(lines[0]);
      assert.strictEqual(record.type, "cycle");
      assert.strictEqual(record.timestamp, "2024-08-21T12:00:00.000Z");
      assert.strictEqual(record.weatherTier, 2);
      assert.deepStrictEqual(record.forecast, cycle.forecast);
    });

    test("appends to existing file", async () => {
      const cycle1 = {
        timestamp: new Date("2024-08-21T12:00:00Z"),
        weatherTier: 1,
        forecast: [{ time: "2024-08-21T12:00:00Z", idealSolarYieldWh: 50 }],
        actions: [],
      };

      const cycle2 = {
        timestamp: new Date("2024-08-21T12:15:00Z"),
        weatherTier: 2,
        forecast: [{ time: "2024-08-21T12:15:00Z", idealSolarYieldWh: 75 }],
        actions: [],
      };

      await recordCycle(mockApp, tempDir, cycle1);
      await recordCycle(mockApp, tempDir, cycle2);

      const filePath = getRecordingsPath(tempDir, cycle1.timestamp);
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.trim().split("\n");

      assert.strictEqual(lines.length, 2);
      const record1 = JSON.parse(lines[0]);
      const record2 = JSON.parse(lines[1]);
      assert.strictEqual(record1.weatherTier, 1);
      assert.strictEqual(record2.weatherTier, 2);
    });
  });

  test.describe("recordSample", () => {
    test("writes a sample record", async () => {
      const sample = {
        timestamp: new Date("2024-08-21T12:05:00Z"),
        arrays: { "cabin-roof": 120, bimini: 80 },
        generators: { "wind-aft": 45 },
        soc: 0.75,
        houseLoadW: 95,
        windSpeedKnots: 8.5,
        navState: "anchored",
        position: { latitude: 37.77, longitude: -122.42 },
      };

      await recordSample(mockApp, tempDir, sample);

      const filePath = getRecordingsPath(tempDir, sample.timestamp);
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.trim().split("\n");

      assert.strictEqual(lines.length, 1);
      const record = JSON.parse(lines[0]);
      assert.strictEqual(record.type, "sample");
      assert.strictEqual(record.timestamp, "2024-08-21T12:05:00.000Z");
      assert.strictEqual(record.soc, 0.75);
      assert.strictEqual(record.houseLoadW, 95);
      assert.deepStrictEqual(record.arrays, sample.arrays);
      assert.deepStrictEqual(record.generators, sample.generators);
    });

    test("handles null position", async () => {
      const sample = {
        timestamp: new Date("2024-08-21T12:10:00Z"),
        arrays: {},
        generators: {},
        soc: 0.7,
        houseLoadW: 100,
        windSpeedKnots: 10,
        navState: "sailing",
        position: null,
      };

      await recordSample(mockApp, tempDir, sample);

      const filePath = getRecordingsPath(tempDir, sample.timestamp);
      const content = await fs.readFile(filePath, "utf-8");
      const record = JSON.parse(content.trim());

      assert.strictEqual(record.position, null);
    });

    test("persists deployStates in the sample record", async () => {
      const sample = {
        timestamp: new Date("2024-08-21T12:15:00Z"),
        arrays: {},
        generators: {},
        soc: 0.7,
        houseLoadW: 100,
        windSpeedKnots: 10,
        navState: "anchored",
        position: null,
        deployStates: { flinsail: "deployed", superwind: "stowed" },
      };
      await recordSample(mockApp, tempDir, sample);
      const filePath = getRecordingsPath(tempDir, sample.timestamp);
      const content = await fs.readFile(filePath, "utf-8");
      const record = JSON.parse(content.trim());
      assert.deepStrictEqual(record.deployStates, {
        flinsail: "deployed",
        superwind: "stowed",
      });
    });
  });

  test.describe("pruneOldRecordings", () => {
    test("deletes files older than retention days", async () => {
      const recordingsDir = path.join(tempDir, "recordings");
      await fs.mkdir(recordingsDir, { recursive: true });

      // Use relative dates from today
      const today = new Date();
      const formatDate = (daysAgo) => {
        const d = new Date(today);
        d.setDate(d.getDate() - daysAgo);
        return d.toISOString().split("T")[0];
      };

      const dates = [
        formatDate(10), // 10 days ago - should be deleted
        formatDate(6), // 6 days ago - should be deleted
        formatDate(3), // 3 days ago - should be kept
        formatDate(0), // today - should be kept
      ];

      for (const date of dates) {
        const filePath = path.join(recordingsDir, `${date}.jsonl`);
        await fs.writeFile(filePath, `{"type":"test","date":"${date}"}\n`);
      }

      const result = await pruneOldRecordings(mockApp, tempDir, 5);

      assert.strictEqual(result.deleted, 2);
      assert.strictEqual(result.errors.length, 0);

      const remainingFiles = await fs.readdir(recordingsDir);
      assert.strictEqual(remainingFiles.length, 2);
      assert(remainingFiles.includes(`${formatDate(3)}.jsonl`));
      assert(remainingFiles.includes(`${formatDate(0)}.jsonl`));
    });

    test("keeps all files within retention period", async () => {
      const recordingsDir = path.join(tempDir, "recordings");
      await fs.mkdir(recordingsDir, { recursive: true });

      const today = new Date();
      const formatDate = (daysAgo) => {
        const d = new Date(today);
        d.setDate(d.getDate() - daysAgo);
        return d.toISOString().split("T")[0];
      };

      const dates = [
        formatDate(10),
        formatDate(6),
        formatDate(3),
        formatDate(0),
      ];

      for (const date of dates) {
        const filePath = path.join(recordingsDir, `${date}.jsonl`);
        await fs.writeFile(filePath, `{"type":"test","date":"${date}"}\n`);
      }

      const result = await pruneOldRecordings(mockApp, tempDir, 30);

      assert.strictEqual(result.deleted, 0);

      const files = await fs.readdir(recordingsDir);
      assert.strictEqual(files.length, 4);
    });
  });

  test.describe("getRecordings", () => {
    test("smoketest: reads records from a single day file", async () => {
      const recordingsDir = path.join(tempDir, "recordings");
      await fs.mkdir(recordingsDir, { recursive: true });

      const day1Path = path.join(recordingsDir, "2024-08-21.jsonl");

      await fs.writeFile(
        day1Path,
        JSON.stringify({
          type: "cycle",
          timestamp: "2024-08-21T10:00:00.000Z",
          weatherTier: 2,
          forecast: [],
          actions: [],
        }) +
          "\n" +
          JSON.stringify({
            type: "sample",
            timestamp: "2024-08-21T10:05:00.000Z",
            arrays: {},
            generators: {},
            soc: 0.7,
          }) +
          "\n",
      );

      const from = new Date("2024-08-21T00:00:00Z");
      const to = new Date("2024-08-21T23:59:59Z");

      const records = await getRecordings(tempDir, from, to);

      assert.strictEqual(records.length, 2);
    });

    test("returns all records in date range", async () => {
      const recordingsDir = path.join(tempDir, "recordings");
      await fs.mkdir(recordingsDir, { recursive: true });

      const day1Path = path.join(recordingsDir, "2024-08-20.jsonl");
      const day2Path = path.join(recordingsDir, "2024-08-21.jsonl");

      await fs.writeFile(
        day1Path,
        JSON.stringify({
          type: "cycle",
          timestamp: "2024-08-20T12:00:00.000Z",
          weatherTier: 1,
          forecast: [],
          actions: [],
        }) +
          "\n" +
          JSON.stringify({
            type: "sample",
            timestamp: "2024-08-20T12:05:00.000Z",
            arrays: {},
            generators: {},
            soc: 0.8,
          }) +
          "\n",
      );

      await fs.writeFile(
        day2Path,
        JSON.stringify({
          type: "cycle",
          timestamp: "2024-08-21T10:00:00.000Z",
          weatherTier: 2,
          forecast: [],
          actions: [],
        }) +
          "\n" +
          JSON.stringify({
            type: "sample",
            timestamp: "2024-08-21T10:05:00.000Z",
            arrays: {},
            generators: {},
            soc: 0.7,
          }) +
          "\n",
      );

      const from = new Date("2024-08-20T00:00:00Z");
      const to = new Date("2024-08-21T23:59:59Z");

      const records = await getRecordings(tempDir, from, to);

      assert.strictEqual(records.length, 4);
    });

    test("filters by type", async () => {
      const recordingsDir = path.join(tempDir, "recordings");
      await fs.mkdir(recordingsDir, { recursive: true });

      const day1Path = path.join(recordingsDir, "2024-08-20.jsonl");
      const day2Path = path.join(recordingsDir, "2024-08-21.jsonl");

      await fs.writeFile(
        day1Path,
        JSON.stringify({
          type: "cycle",
          timestamp: "2024-08-20T12:00:00.000Z",
          weatherTier: 1,
          forecast: [],
          actions: [],
        }) +
          "\n" +
          JSON.stringify({
            type: "sample",
            timestamp: "2024-08-20T12:05:00.000Z",
            arrays: {},
            generators: {},
            soc: 0.8,
          }) +
          "\n",
      );

      await fs.writeFile(
        day2Path,
        JSON.stringify({
          type: "cycle",
          timestamp: "2024-08-21T10:00:00.000Z",
          weatherTier: 2,
          forecast: [],
          actions: [],
        }) +
          "\n" +
          JSON.stringify({
            type: "sample",
            timestamp: "2024-08-21T10:05:00.000Z",
            arrays: {},
            generators: {},
            soc: 0.7,
          }) +
          "\n",
      );

      const from = new Date("2024-08-20T00:00:00Z");
      const to = new Date("2024-08-21T23:59:59Z");

      const cycles = await getRecordings(tempDir, from, to, "cycle");
      const samples = await getRecordings(tempDir, from, to, "sample");

      assert.strictEqual(cycles.length, 2);
      assert.strictEqual(samples.length, 2);
    });

    test("filters by time window", async () => {
      const recordingsDir = path.join(tempDir, "recordings");
      await fs.mkdir(recordingsDir, { recursive: true });

      const day2Path = path.join(recordingsDir, "2024-08-21.jsonl");

      await fs.writeFile(
        day2Path,
        JSON.stringify({
          type: "cycle",
          timestamp: "2024-08-21T10:00:00.000Z",
          weatherTier: 2,
          forecast: [],
          actions: [],
        }) +
          "\n" +
          JSON.stringify({
            type: "sample",
            timestamp: "2024-08-21T10:05:00.000Z",
            arrays: {},
            generators: {},
            soc: 0.7,
          }) +
          "\n",
      );

      const from = new Date("2024-08-21T10:00:00Z");
      const to = new Date("2024-08-21T11:00:00Z");

      const records = await getRecordings(tempDir, from, to);

      assert.strictEqual(records.length, 2);
      assert.strictEqual(records[0].timestamp, "2024-08-21T10:00:00.000Z");
      assert.strictEqual(records[1].timestamp, "2024-08-21T10:05:00.000Z");
    });

    test("returns empty array for non-existent files", async () => {
      const from = new Date("2024-08-25T00:00:00Z");
      const to = new Date("2024-08-26T23:59:59Z");

      const records = await getRecordings(tempDir, from, to);

      assert.deepStrictEqual(records, []);
    });
  });

  test.describe("Recorder class", () => {
    test("initializes with config", () => {
      const config = { enabled: true, retentionDays: 60 };
      const recorder = new Recorder(mockApp, tempDir, config);

      assert.strictEqual(recorder.enabled, true);
      assert.strictEqual(recorder.retentionDays, 60);
    });

    test("uses defaults when config not provided", () => {
      const recorder = new Recorder(mockApp, tempDir);

      assert.strictEqual(recorder.enabled, true);
      assert.strictEqual(recorder.retentionDays, 90);
    });

    test("respects enabled=false", async () => {
      const recorder = new Recorder(mockApp, tempDir, { enabled: false });

      const cycle = {
        timestamp: new Date(),
        weatherTier: 1,
        forecast: [],
        actions: [],
      };

      await recorder.recordCycle(cycle);

      const recordingsDir = path.join(tempDir, "recordings");
      const files = await fs.readdir(recordingsDir).catch(() => []);
      assert.strictEqual(files.length, 0);
    });

    test("records cycle when enabled", async () => {
      const recorder = new Recorder(mockApp, tempDir, { enabled: true });

      const cycle = {
        timestamp: new Date("2024-08-21T12:00:00Z"),
        weatherTier: 2,
        forecast: [],
        actions: [],
      };

      await recorder.recordCycle(cycle);

      const filePath = getRecordingsPath(tempDir, cycle.timestamp);
      const content = await fs.readFile(filePath, "utf-8");
      const record = JSON.parse(content.trim());

      assert.strictEqual(record.type, "cycle");
      assert.strictEqual(record.weatherTier, 2);
    });

    test("records sample when enabled", async () => {
      const recorder = new Recorder(mockApp, tempDir, { enabled: true });

      const sample = {
        timestamp: new Date("2024-08-21T12:05:00Z"),
        arrays: { test: 100 },
        generators: {},
        soc: 0.75,
        houseLoadW: 90,
        windSpeedKnots: 10,
        navState: "anchored",
        position: null,
      };

      await recorder.recordSample(sample);

      const filePath = getRecordingsPath(tempDir, sample.timestamp);
      const content = await fs.readFile(filePath, "utf-8");
      const record = JSON.parse(content.trim());

      assert.strictEqual(record.type, "sample");
      assert.strictEqual(record.soc, 0.75);
    });

    test("updates config", () => {
      const recorder = new Recorder(mockApp, tempDir);
      assert.strictEqual(recorder.retentionDays, 90);

      recorder.updateConfig({ enabled: false, retentionDays: 30 });
      assert.strictEqual(recorder.enabled, false);
      assert.strictEqual(recorder.retentionDays, 30);
    });

    test("prunes old recordings", async () => {
      const recordingsDir = path.join(tempDir, "recordings");
      await fs.mkdir(recordingsDir, { recursive: true });

      const today = new Date();
      const formatDate = (daysAgo) => {
        const d = new Date(today);
        d.setDate(d.getDate() - daysAgo);
        return d.toISOString().split("T")[0];
      };

      const oldFile = path.join(recordingsDir, `${formatDate(10)}.jsonl`);
      await fs.writeFile(oldFile, "test\n");

      const recentFile = path.join(recordingsDir, `${formatDate(0)}.jsonl`);
      await fs.writeFile(recentFile, "test\n");

      const recorder = new Recorder(mockApp, tempDir, { retentionDays: 5 });

      const result = await recorder.prune();

      assert.strictEqual(result.deleted, 1);

      const files = await fs.readdir(recordingsDir);
      assert.strictEqual(files.length, 1);
      assert(files[0] === `${formatDate(0)}.jsonl`);
    });

    test("stops prune interval", async () => {
      const recorder = new Recorder(mockApp, tempDir);
      recorder.startPruneInterval();

      assert(recorder.pruneIntervalId !== null);

      recorder.stopPruneInterval();

      assert.strictEqual(recorder.pruneIntervalId, null);
    });

    test("returns empty recordings when disabled", async () => {
      const recorder = new Recorder(mockApp, tempDir, { enabled: false });

      const from = new Date("2024-08-20T00:00:00Z");
      const to = new Date("2024-08-21T23:59:59Z");

      const records = await recorder.getRecordings(from, to);

      assert.deepStrictEqual(records, []);
    });
  });

  test.describe("overwriteStickyFields", () => {
    test("overwrites navState and position on existing samples", async () => {
      const day = new Date("2026-08-19T00:00:00Z");
      // Live samples with flapping navState and a stale position
      await recordSample(mockApp, tempDir, {
        timestamp: new Date("2026-08-19T00:05:00Z"),
        navState: "anchored",
        position: { latitude: -18.86, longitude: -159.8 },
        soc: 0.8,
        arrays: {},
        generators: {},
        houseLoadW: 60,
      });
      await recordSample(mockApp, tempDir, {
        timestamp: new Date("2026-08-19T00:10:00Z"),
        navState: "moored",
        position: { latitude: -18.86, longitude: -159.8 },
        soc: 0.79,
        arrays: {},
        generators: {},
        houseLoadW: 62,
      });
      const from = new Date("2026-08-19T00:00:00Z");
      const to = new Date("2026-08-19T23:59:59Z");
      await overwriteStickyFields(mockApp, tempDir, from, to, (_ts) => ({
        navState: "moored",
        position: { latitude: -18.87, longitude: -159.81 },
      }));
      const recs = await getRecordings(tempDir, from, to, "sample");
      assert.deepStrictEqual(
        recs.map((r) => r.navState),
        ["moored", "moored"],
      );
      // Continuous fields are untouched
      assert.deepStrictEqual(
        recs.map((r) => r.soc),
        [0.8, 0.79],
      );
      assert.deepStrictEqual(
        recs.map((r) => r.houseLoadW),
        [60, 62],
      );
      // Position overwritten
      for (const r of recs) {
        assert.deepStrictEqual(r.position, {
          latitude: -18.87,
          longitude: -159.81,
        });
      }
    });

    test("leaves non-sample records and out-of-window samples untouched", async () => {
      const day = new Date("2026-08-19T00:00:00Z");
      await recordSample(mockApp, tempDir, {
        timestamp: new Date("2026-08-19T00:05:00Z"),
        navState: "anchored",
        position: { latitude: -18.86, longitude: -159.8 },
        soc: 0.8,
        arrays: {},
        generators: {},
        houseLoadW: 60,
      });
      // A cycle record (not a sample) in the same file
      const recorder = new Recorder(mockApp, tempDir, {});
      await recorder.recordCycle({
        timestamp: new Date("2026-08-19T00:06:00Z"),
        weatherTier: 1,
        forecast: [],
        actions: [],
      });
      // Out-of-window sample (before `from`)
      await recordSample(mockApp, tempDir, {
        timestamp: new Date("2026-08-18T23:50:00Z"),
        navState: "anchored",
        position: { latitude: -18.86, longitude: -159.8 },
        soc: 0.8,
        arrays: {},
        generators: {},
        houseLoadW: 60,
      });
      const from = new Date("2026-08-19T00:00:00Z");
      const to = new Date("2026-08-19T23:59:59Z");
      await overwriteStickyFields(mockApp, tempDir, from, to, (_ts) => ({
        navState: "moored",
        position: { latitude: -18.87, longitude: -159.81 },
      }));
      const all = await getRecordings(
        tempDir,
        new Date("2026-08-18T00:00:00Z"),
        to,
      );
      const samples = all.filter((r) => r.type === "sample");
      // The 00:05 sample (in window) is overwritten
      const sIn = samples.find(
        (r) => r.timestamp === "2026-08-19T00:05:00.000Z",
      );
      assert.strictEqual(sIn.navState, "moored");
      // The 23:50 sample (previous day, out of window) is untouched
      const sOut = samples.find((r) => r.timestamp.startsWith("2026-08-18"));
      assert.strictEqual(sOut.navState, "anchored");
      // The cycle record survives unchanged
      const cycles = all.filter((r) => r.type === "cycle");
      assert.strictEqual(cycles.length, 1);
    });
  });

  test.describe("recordWindProtection", () => {
    test("writes a wind-protection record with factors and position", async () => {
      const obs = {
        timestamp: new Date("2024-08-21T13:00:00Z"),
        placeKey: "geohash-cell-abc",
        sector: 2,
        night: false,
        measuredSpeedKnots: 7.77,
        forecastSpeedKnots: 15,
        measuredGustKnots: 11.66,
        forecastGustKnots: 20,
        windDirectionDeg: 90,
        speedFactor: 0.5,
        gustFactor: 0.58,
        position: { latitude: -18.86, longitude: -159.8 },
        navState: "anchored",
        anemometerHeightM: 10,
      };
      await recordWindProtection(mockApp, tempDir, obs);
      const filePath = getRecordingsPath(tempDir, obs.timestamp);
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.trim().split("\n");
      assert.strictEqual(lines.length, 1);
      const record = JSON.parse(lines[0]);
      assert.strictEqual(record.type, "wind-protection");
      assert.strictEqual(record.timestamp, "2024-08-21T13:00:00.000Z");
      assert.strictEqual(record.placeKey, "geohash-cell-abc");
      assert.strictEqual(record.sector, 2);
      assert.strictEqual(record.night, false);
      assert.strictEqual(record.measuredSpeedKnots, 7.77);
      assert.strictEqual(record.forecastSpeedKnots, 15);
      assert.strictEqual(record.measuredGustKnots, 11.66);
      assert.strictEqual(record.forecastGustKnots, 20);
      assert.strictEqual(record.windDirectionDeg, 90);
      assert.strictEqual(record.speedFactor, 0.5);
      assert.strictEqual(record.gustFactor, 0.58);
      assert.deepStrictEqual(record.position, obs.position);
      assert.strictEqual(record.navState, "anchored");
      assert.strictEqual(record.anemometerHeightM, 10);
    });

    test("accepts null gusts and null position", async () => {
      const obs = {
        timestamp: new Date("2024-08-21T13:05:00Z"),
        placeKey: "cell-x",
        sector: 0,
        night: true,
        measuredSpeedKnots: 5,
        forecastSpeedKnots: 10,
        measuredGustKnots: null,
        forecastGustKnots: null,
        windDirectionDeg: null,
        speedFactor: 0.5,
        gustFactor: 1,
        position: null,
        navState: "moored",
        anemometerHeightM: 12,
      };
      await recordWindProtection(mockApp, tempDir, obs);
      const filePath = getRecordingsPath(tempDir, obs.timestamp);
      const content = await fs.readFile(filePath, "utf-8");
      const record = JSON.parse(content.trim());
      assert.strictEqual(record.measuredGustKnots, null);
      assert.strictEqual(record.forecastGustKnots, null);
      assert.strictEqual(record.windDirectionDeg, null);
      assert.strictEqual(record.position, null);
      assert.strictEqual(record.navState, "moored");
    });

    test("Recorder.recordWindProtection delegates to the module function", async () => {
      const recorder = new Recorder(mockApp, tempDir);
      await recorder.recordWindProtection({
        timestamp: new Date("2024-08-21T13:10:00Z"),
        placeKey: "cell-y",
        sector: 4,
        night: false,
        measuredSpeedKnots: 3,
        forecastSpeedKnots: 12,
        measuredGustKnots: 4,
        forecastGustKnots: 18,
        windDirectionDeg: 180,
        speedFactor: 0.25,
        gustFactor: 0.2222,
        position: { latitude: 1, longitude: 2 },
        navState: "anchored",
        anemometerHeightM: 10,
      });
      const filePath = getRecordingsPath(
        tempDir,
        new Date("2024-08-21T13:10:00Z"),
      );
      const content = await fs.readFile(filePath, "utf-8");
      const record = JSON.parse(content.trim());
      assert.strictEqual(record.type, "wind-protection");
      assert.strictEqual(record.placeKey, "cell-y");
      assert.strictEqual(record.sector, 4);
      // round4(0.2222) = 0.2222
      assert.strictEqual(record.gustFactor, 0.2222);
    });
  });
});
