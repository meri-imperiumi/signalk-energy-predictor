/**
 * Tests for the SQLite-backed record store (plugin/storage.js).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RecordStore } = require("../plugin/storage.js");

const HOUR = 3600000;

function makeStore(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-storage-"));
  const app = {
    debug() {},
    error(msg) {
      throw new Error(`unexpected app.error: ${msg}`);
    },
  };
  const store = new RecordStore(app, dir, config);
  store.open();
  return {
    store,
    dir,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeCycle(at, hours = 3, overrides = {}) {
  const base = at.getTime();
  const solar = overrides.solar ?? 100;
  const tier = overrides.tier ?? 2;
  return {
    timestamp: at,
    weatherTier: tier,
    forecast: Array.from({ length: hours }, (_, h) => ({
      time: new Date(base + h * HOUR).toISOString(),
      idealSolarYieldWh: solar + h,
      idealWindYieldWh: 50,
      idealHydroYieldWh: 5,
      alternatorWh: 0,
      houseLoadWh: 120,
      idealNetWh: 35 + h,
      idealSoC: 0.8,
      detectedYieldWh: 60,
      detectedNetWh: -10,
      detectedSoC: 0.79,
      windSpeedKnots: 12.1,
      gustSpeedKnots: 18.2,
      forecastWindSpeedKnots: 11.0,
      forecastGustKnots: 16.0,
      windDirectionDeg: 215,
      actions: [
        {
          id: "wind-1",
          idealAction: "stay",
          detectedAction: null,
          reason: "light",
        },
      ],
    })),
    actions: { wind1: "stay" },
    advisories: [
      { type: "surplus", time: at.toISOString(), message: "m", wh: 10 },
    ],
  };
}

function makeSample(at, overrides = {}) {
  return {
    timestamp: at,
    arrays: { "sol-1": { powerW: 180, soc: 0.8 } },
    generators: { "wind-1": { powerW: 40, deployState: "deployed" } },
    soc: 0.8,
    houseLoadW: 130,
    windSpeedKnots: 12.1,
    navState: "anchored",
    position: { latitude: 60.15, longitude: 24.9 },
    stwKnots: 0.2,
    deployStates: { "wind-1": "deployed" },
    controllerModes: { "sol-1": "bulk" },
    awaRad: 1.2,
    ...overrides,
  };
}

test("open creates a persistent database file; reopen sees prior data", async () => {
  const { store, dir, cleanup } = makeStore();
  const at = new Date("2026-09-01T12:00:00Z");
  store.recordSample(makeSample(at));
  const file = path.join(dir, "records.db");
  assert.ok(fs.existsSync(file));
  store.close();

  const reopened = new RecordStore({ debug() {} }, dir, {});
  reopened.open();
  const rows = await reopened.getRecords(
    "sample",
    new Date(at.getTime() - HOUR),
    new Date(at.getTime() + HOUR),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].navState, "anchored");
  reopened.close();
  cleanup();
});

test("sample round-trips with full fidelity", async () => {
  const { store, cleanup } = makeStore();
  const at = new Date("2026-09-01T12:00:00Z");
  await store.recordSample(makeSample(at));
  const [row] = await store.getRecords(
    "sample",
    new Date(at.getTime() - 1),
    new Date(at.getTime() + 1),
  );
  assert.deepEqual(row, {
    type: "sample",
    timestamp: at.toISOString(),
    arrays: { "sol-1": { powerW: 180, soc: 0.8 } },
    generators: { "wind-1": { powerW: 40, deployState: "deployed" } },
    soc: 0.8,
    houseLoadW: 130,
    windSpeedKnots: 12.1,
    navState: "anchored",
    position: { latitude: 60.15, longitude: 24.9 },
    stwKnots: 0.2,
    deployStates: { "wind-1": "deployed" },
    controllerModes: { "sol-1": "bulk" },
    awaRad: 1.2,
  });
  cleanup();
});

test("cycle stores metadata row plus point rows; points map back to engine fields", async () => {
  const { store, cleanup } = makeStore();
  const at = new Date("2026-09-01T12:00:00Z");
  await store.recordCycle(makeCycle(at, 3));

  // Metadata: one row, no forecast inside
  const cycles = await store.getRecords(
    "cycle",
    new Date(at.getTime() - 1),
    new Date(at.getTime() + 1),
  );
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].weatherTier, 2);
  assert.deepEqual(cycles[0].advisories, [
    { type: "surplus", time: at.toISOString(), message: "m", wh: 10 },
  ]);
  assert.equal("forecast" in cycles[0], false);

  // Points: one per hour, keyed by their own timestamp
  const points = await store.getForecastPoints(
    new Date(at.getTime()),
    new Date(at.getTime() + 3 * HOUR),
  );
  assert.equal(points.length, 3);
  assert.equal(points[0].cycleTs, at.getTime());
  assert.equal(points[0].h, 0);
  assert.equal(points[0].ts, at.getTime());
  assert.equal(points[0].idealSolarYieldWh, 100);
  assert.equal(points[1].idealSolarYieldWh, 101);
  assert.equal(points[0].windSpeedKnots, 12.1);
  assert.deepEqual(points[0].actions, [
    {
      id: "wind-1",
      idealAction: "stay",
      detectedAction: null,
      reason: "light",
    },
  ]);
  // Missing optional fields store as null, not undefined
  await store.recordCycle({
    timestamp: new Date(at.getTime() + 10 * HOUR),
    weatherTier: 1,
    forecast: [{ time: new Date(at.getTime() + 10 * HOUR).toISOString() }],
    actions: {},
  });
  const bare = await store.getForecastPoints(
    new Date(at.getTime() + 10 * HOUR),
    new Date(at.getTime() + 10 * HOUR),
  );
  assert.equal(bare.length, 1);
  assert.equal(bare[0].idealSolarYieldWh, null);
  assert.deepEqual(bare[0].actions, []);
  cleanup();
});

test("wind-protection observation round-trips", async () => {
  const { store, cleanup } = makeStore();
  const at = new Date("2026-09-01T12:00:00Z");
  await store.recordWindProtection({
    timestamp: at,
    placeKey: "60_24",
    sector: 3,
    night: false,
    measuredSpeedKnots: 15.2,
    forecastSpeedKnots: 12.0,
    measuredGustKnots: 20.1,
    forecastGustKnots: 17.0,
    windDirectionDeg: 215,
    speedFactor: 1.25,
    gustFactor: 1.18,
    position: { latitude: 60.15, longitude: 24.9 },
    navState: "anchored",
    anemometerHeightM: 16,
  });
  const [row] = await store.getRecords(
    "wind-protection",
    new Date(at.getTime() - 1),
    new Date(at.getTime() + 1),
  );
  assert.equal(row.placeKey, "60_24");
  assert.equal(row.sector, 3);
  assert.equal(row.speedFactor, 1.25);
  assert.equal(row.anemometerHeightM, 16);
  cleanup();
});

test("windowed reads filter by type and time, ascending order", async () => {
  const { store, cleanup } = makeStore();
  const base = Date.UTC(2026, 8, 1);
  for (let i = 0; i < 10; i++) {
    await store.recordSample(makeSample(new Date(base + i * 300000)));
  }
  await store.recordCycle(makeCycle(new Date(base + 3600000), 1));
  await store.recordWindProtection({
    timestamp: new Date(base),
    placeKey: "p",
    sector: 0,
    night: true,
    measuredSpeedKnots: 1,
    forecastSpeedKnots: 1,
    speedFactor: 1,
    gustFactor: 1,
    position: { latitude: 1, longitude: 1 },
    navState: "anchored",
    anemometerHeightM: 10,
  });

  const mid = new Date(base + 5 * 300000);
  const samples = await store.getRecords(
    "sample",
    mid,
    new Date(base + 10 * 300000),
  );
  assert.equal(samples.length, 5);
  assert.ok(samples[0].timestamp >= mid.toISOString());

  // Types never leak into each other's reads
  const onlySamples = await store.getRecords(
    "sample",
    new Date(base - 1),
    new Date(base + 10 * 300000),
  );
  assert.equal(onlySamples.length, 10);
  const cycles = await store.getRecords(
    "cycle",
    new Date(base - 1),
    new Date(base + 2 * HOUR),
  );
  assert.equal(cycles.length, 1);
  const wp = await store.getRecords(
    "wind-protection",
    new Date(base - 1),
    new Date(base + 2 * HOUR),
  );
  assert.equal(wp.length, 1);
  cleanup();
});

test("re-recording a cycle replaces its points without stale rows", async () => {
  const { store, cleanup } = makeStore();
  const at = new Date("2026-09-01T12:00:00Z");
  await store.recordCycle(makeCycle(at, 5));
  assert.equal(store.countForecastPoints(), 5);
  await store.recordCycle(makeCycle(at, 2));
  assert.equal(store.countForecastPoints(), 2);
  assert.equal(store.countRecords("cycle"), 1);
  // Upsert keeps the newest content
  const points = await store.getForecastPoints(
    at,
    new Date(at.getTime() + 5 * HOUR),
  );
  assert.equal(points.length, 2);
  cleanup();
});

test("keyset-paginated reads yield to the event loop between pages", async () => {
  const { store, cleanup } = makeStore({ pageSize: 5 });
  const base = Date.UTC(2026, 8, 1);
  for (let i = 0; i < 12; i++) {
    await store.recordSample(makeSample(new Date(base + i * 300000)));
  }
  let loopTurns = 0;
  const countingImmediate = setImmediate(function tick() {
    loopTurns++;
    if (loopTurns < 100) setImmediate(tick);
  });
  const rows = await store.getRecords(
    "sample",
    new Date(base),
    new Date(base + 12 * 300000),
  );
  clearImmediate(countingImmediate);
  assert.equal(rows.length, 12);
  // 12 rows at page size 5 = 3 pages = at least 2 yields; the counting
  // immediate must have run while the read was pending
  assert.ok(
    loopTurns >= 2,
    `expected loop turns during read, got ${loopTurns}`,
  );
  cleanup();
});

test("latestRecords returns newest-first within the since window", async () => {
  const { store, cleanup } = makeStore();
  const base = Date.UTC(2026, 8, 1);
  for (let i = 0; i < 5; i++) {
    await store.recordSample(makeSample(new Date(base + i * 300000)));
  }
  const latest = store.latestRecords("sample", new Date(base), 2);
  assert.equal(latest.length, 2);
  assert.equal(latest[0].timestamp, new Date(base + 4 * 300000).toISOString());
  assert.equal(latest[1].timestamp, new Date(base + 3 * 300000).toISOString());
  cleanup();
});

test("summaryTotals aggregates winner points in SQL", async () => {
  const { store, cleanup } = makeStore();
  const at = new Date("2026-09-01T12:00:00Z");
  // Older cycle covers hours 12-14; newer cycle (recorded 2h later)
  // re-covers hours 14-16 — hour 14's winner must be the newer cycle
  await store.recordCycle(makeCycle(at, 3)); // solar 100,101,102
  await store.recordCycle(
    makeCycle(new Date(at.getTime() + 2 * HOUR), 3, { solar: 200 }),
  ); // solar 200,201,202 from 14:00

  const totals = store.summaryTotals(at, new Date(at.getTime() + 5 * HOUR));
  // Winners: 12:00→100, 13:00→101, 14:00→200, 15:00→201, 16:00→202
  assert.equal(totals.hours, 5);
  assert.equal(totals.idealSolarWh, 100 + 101 + 200 + 201 + 202);
  assert.equal(totals.houseLoadWh, 5 * 120);

  // Empty window aggregates to zeros, not NULLs
  const empty = store.summaryTotals(
    new Date(at.getTime() - 10 * HOUR),
    new Date(at.getTime() - 9 * HOUR),
  );
  assert.equal(empty.hours, 0);
  assert.equal(empty.idealSolarWh, 0);
  cleanup();
});

test("getHourlyWinners returns the newest cycle's point per hour bucket", async () => {
  const { store, cleanup } = makeStore();
  const at = new Date("2026-09-01T12:00:00Z");
  await store.recordCycle(makeCycle(at, 4)); // covers 12:00-15:00, tier 2
  await store.recordCycle(
    makeCycle(new Date(at.getTime() + 2 * HOUR), 4, {
      solar: 200,
      tier: 1,
    }),
  ); // covers 14:00-17:00, tier 1

  const winners = await store.getHourlyWinners(
    at,
    new Date(at.getTime() + 6 * HOUR),
  );
  assert.equal(winners.length, 6); // hours 12:00 through 17:00
  assert.deepEqual(
    winners.map((w) => w.idealSolarYieldWh),
    [100, 101, 200, 201, 202, 203],
  );
  // Hour buckets are epoch-ms hour starts, ascending
  assert.equal(winners[0].hour, at.getTime());
  assert.equal(winners[5].hour, at.getTime() + 5 * HOUR);
  // The winning row carries its owning cycle's identity
  assert.equal(winners[0].cycleTs, at.getTime());
  assert.equal(winners[0].weatherTier, 2);
  assert.equal(winners[2].cycleTs, at.getTime() + 2 * HOUR);
  assert.equal(winners[2].weatherTier, 1);
  // Points off hour boundaries bucket to their hour
  const odd = new Date("2026-09-01T18:15:00Z");
  await store.recordCycle(makeCycle(odd, 1, { solar: 50, tier: 1 }));
  const late = await store.getHourlyWinners(
    new Date("2026-09-01T18:00:00Z"),
    new Date("2026-09-01T19:00:00Z"),
  );
  assert.equal(late.length, 1);
  assert.equal(late[0].hour, Date.UTC(2026, 8, 1, 18));
  assert.equal(late[0].idealSolarYieldWh, 50);
  cleanup();
});

test("deploy actions and spans are normalized at write time", async () => {
  const { store, cleanup } = makeStore();
  const at = new Date("2026-09-01T12:00:00Z");
  const mk = (actions) => ({
    timestamp: at,
    weatherTier: 1,
    forecast: [
      {
        time: new Date(at.getTime()).toISOString(),
        actions,
      },
      {
        time: new Date(at.getTime() + 2 * HOUR).toISOString(),
        actions: [],
      },
    ],
    actions: {},
  });
  await store.recordCycle(
    mk([
      {
        id: "wind-1",
        idealAction: "deploy",
        detectedAction: null,
        reason: "builds",
      },
      { id: "sol-1", idealAction: "stow", detectedAction: "stay", reason: "x" },
      {
        id: "sol-2",
        idealAction: "stow",
        detectedAction: null,
        reason: "gusts",
      },
      { type: "engine_run", hour: 0, message: "m" },
    ]),
  );

  // Only deploy/stow with non-stay detected survive normalization
  const points = store.getDeployActionPoints(at.getTime(), at.getTime());
  const slim = points.get(at.getTime());
  assert.ok(slim, "expected action points for the cycle");
  assert.equal(slim.length, 1);
  assert.deepEqual(
    slim[0].actions.map((a) => `${a.id}:${a.idealAction}`).sort(),
    ["sol-2:stow", "wind-1:deploy"],
  );

  // Span covers first..last point
  const spans = store.getDeploySpans(at.getTime(), at.getTime());
  assert.deepEqual(spans.get(at.getTime()), {
    startMs: at.getTime(),
    endMs: at.getTime() + 2 * HOUR,
  });

  // Re-recording replaces rows (no stale actions; the fresh span
  // reflects the new forecast)
  await store.recordCycle(mk([]));
  assert.equal(store.getDeployActionPoints(at.getTime(), at.getTime()).size, 0);
  assert.equal(store.getDeploySpans(at.getTime(), at.getTime()).size, 1);
  cleanup();
});

test("getPointsByCycle reassembles a cycle's forecast curve in order", async () => {
  const { store, cleanup } = makeStore();
  const at = new Date("2026-09-01T12:00:00Z");
  await store.recordCycle(makeCycle(at, 3));
  await store.recordCycle(makeCycle(new Date(at.getTime() + 6 * HOUR), 2));

  const points = store.getPointsByCycle(at.getTime());
  assert.equal(points.length, 3);
  assert.deepEqual(
    points.map((p) => p.h),
    [0, 1, 2],
  );
  assert.equal(points[0].cycleTs, at.getTime());
  assert.equal(points[0].weatherTier, 2);
  assert.deepEqual(
    points.map((p) => p.idealSolarYieldWh),
    [100, 101, 102],
  );
  cleanup();
});

test("overwriteStickyFields updates only changed samples", async () => {
  const { store, cleanup } = makeStore();
  const base = Date.UTC(2026, 8, 1);
  for (let i = 0; i < 4; i++) {
    await store.recordSample(makeSample(new Date(base + i * 300000)));
  }
  const resolve = (tsMs) => ({
    navState: tsMs <= base + 300000 ? "moored" : null,
    position: tsMs === base ? { latitude: 61.0, longitude: 25.0 } : null,
  });
  const { updated } = await store.overwriteStickyFields(
    new Date(base),
    new Date(base + 3 * 300000),
    resolve,
  );
  assert.equal(updated, 2);
  const rows = await store.getRecords(
    "sample",
    new Date(base),
    new Date(base + 4 * 300000),
  );
  assert.equal(rows[0].navState, "moored");
  assert.deepEqual(rows[0].position, { latitude: 61.0, longitude: 25.0 });
  assert.equal(rows[1].navState, "moored");
  assert.deepEqual(rows[1].position, { latitude: 60.15, longitude: 24.9 });
  // null resolve results leave fields untouched
  assert.equal(rows[2].navState, "anchored");
  // Position equal to the stored one is not a change
  assert.deepEqual(rows[2].position, { latitude: 60.15, longitude: 24.9 });
  cleanup();
});

test("prune removes old records and their points but keeps recent ones", async () => {
  const { store, cleanup } = makeStore({ retentionDays: 7 });
  const now = Date.now();
  const old = new Date(now - 10 * 24 * HOUR);
  const fresh = new Date(now - 24 * HOUR);
  await store.recordCycle(makeCycle(old, 2));
  await store.recordCycle(makeCycle(fresh, 2));
  await store.recordSample(makeSample(old));
  await store.recordSample(makeSample(fresh));

  const { deleted } = await store.prune();
  // 1 cycle metadata + 2 points + 1 span + 1 sample from the old day
  assert.equal(deleted, 5);
  assert.equal(store.countRecords("cycle"), 1);
  assert.equal(store.countForecastPoints(), 2);
  assert.equal(store.countRecords("sample"), 1);
  cleanup();
});

test("disabled store writes nothing; reads still serve existing data", async () => {
  const { store, cleanup } = makeStore({ enabled: false });
  const at = new Date("2026-09-01T12:00:00Z");
  await store.recordSample(makeSample(at));
  await store.recordCycle(makeCycle(at, 2));
  assert.equal(store.countRecords("sample"), 0);
  assert.equal(store.countForecastPoints(), 0);

  // Re-enable: reads reflect whatever is stored
  store.updateConfig({ enabled: true });
  await store.recordSample(makeSample(at));
  const rows = await store.getRecords(
    "sample",
    new Date(at.getTime() - 1),
    new Date(at.getTime() + 1),
  );
  assert.equal(rows.length, 1);
  cleanup();
});

test("unclean close (no checkpoint) still recovers via WAL on next open", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-storage-wal-"));
  const writer = new RecordStore({ debug() {} }, dir, {});
  writer.open();
  const at = new Date("2026-09-01T12:00:00Z");
  writer.recordSample(makeSample(at));
  // Simulate a crash: never call close(), just drop the handle
  // (a second connection reads through the WAL)
  const reader = new RecordStore({ debug() {} }, dir, {});
  reader.open();
  const rows = await reader.getRecords(
    "sample",
    new Date(at.getTime() - 1),
    new Date(at.getTime() + 1),
  );
  assert.equal(rows.length, 1);
  reader.close();
  writer.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
