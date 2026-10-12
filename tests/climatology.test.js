/**
 * Tests for the climatology module (NASA POWER monthly Kc) and its wiring
 * into the ingestion FSM's fallback floor.
 * @file climatology.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const climatology = require("../plugin/climatology.js");
const {
  IngestionFSM,
  Tier,
  generateClearSkyForecast,
} = require("../plugin/ingestion.js");
const { maxIrradiance } = require("../plugin/solar.js");

function makeApp() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    getSelfPath: () => null,
  };
}

function makeFSM() {
  const fsm = new IngestionFSM(makeApp());
  fsm.position = { latitude: 60.17, longitude: 24.94 };
  return fsm;
}

async function mkTmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ep-climatology-"));
}

/** A plausible NASA POWER monthly climatology point response. */
function nasaPowerResponse(overrides = {}) {
  const allsky = {
    JAN: 3.2,
    FEB: 4.8,
    MAR: 6.1,
    APR: 7.4,
    MAY: 8.0,
    JUN: 8.2,
    JUL: 7.9,
    AUG: 7.5,
    SEP: 6.2,
    OCT: 4.4,
    NOV: 2.9,
    DEC: 2.4,
    ANN: 5.75,
    ...overrides.allsky,
  };
  const clrsky = {
    JAN: 4.0,
    FEB: 6.0,
    MAR: 7.4,
    APR: 8.6,
    MAY: 9.0,
    JUN: 9.0,
    JUL: 8.8,
    AUG: 8.6,
    SEP: 7.4,
    OCT: 5.5,
    NOV: 3.8,
    DEC: 3.4,
    ANN: 6.81,
    ...overrides.clrsky,
  };
  return {
    properties: {
      parameter: {
        ALLSKY_SFC_SW_DWN: allsky,
        CLRSKY_SFC_SW_DWN: clrsky,
      },
    },
  };
}

test.describe("fetchKc", () => {
  test("parses NASA POWER monthly response into a Kc map", async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => nasaPowerResponse(),
    });
    const { kc } = await climatology.fetchKc(60.17, 21.39, fetchImpl);
    // JAN: 3.2/4.0 = 0.8
    assert.ok(Math.abs(kc[1] - 0.8) < 1e-9);
    // AUG: 7.5/8.6
    assert.ok(Math.abs(kc[8] - 7.5 / 8.6) < 1e-9);
    assert.strictEqual(Object.keys(kc).length, 12);
  });

  test("requests the climatology point endpoint with both parameters", async () => {
    let requested = null;
    const fetchImpl = async (url) => {
      requested = url;
      return { ok: true, json: async () => nasaPowerResponse() };
    };
    await climatology.fetchKc(60.17, 21.39, fetchImpl);
    assert.ok(requested.includes("power.larc.nasa.gov"));
    assert.ok(requested.includes("temporal/climatology/point"));
    assert.ok(requested.includes("ALLSKY_SFC_SW_DWN"));
    assert.ok(requested.includes("CLRSKY_SFC_SW_DWN"));
  });

  test("clamps Kc above 1 and skips fill values and zero-clear months", async () => {
    const overrides = {
      allsky: { JAN: 5.0, FEB: -999 }, // JAN all > clear; FEB fill
      clrsky: { JAN: 4.0, FEB: 6.0, MAR: 0 }, // MAR clear = 0
    };
    const fetchImpl = async () => ({
      ok: true,
      json: async () => nasaPowerResponse(overrides),
    });
    const { kc } = await climatology.fetchKc(60.17, 21.39, fetchImpl);
    assert.strictEqual(kc[1], 1, "all-sky above clear-sky clamps to 1");
    assert.strictEqual(kc[2], undefined, "fill month skipped");
    assert.strictEqual(kc[3], undefined, "zero clear-sky month skipped");
    assert.strictEqual(kc[4], 7.4 / 8.6, "healthy months intact");
  });

  test("HTTP error and missing parameters throw", async () => {
    const failing = async () => ({ ok: false, status: 500 });
    await assert.rejects(() => climatology.fetchKc(60.17, 21.39, failing));
    const empty = async () => ({
      ok: true,
      json: async () => ({ properties: { parameter: {} } }),
    });
    await assert.rejects(() => climatology.fetchKc(60.17, 21.39, empty));
  });
});

test.describe("cell cache", () => {
  test("cellKey buckets to 1° with file-safe coordinate tokens", () => {
    assert.strictEqual(climatology.cellKey(60.17, 21.39), "60_21");
    assert.strictEqual(climatology.cellKey(-16.05, -179.9), "-16_-180");
  });

  test("saveKc/loadCachedKc round-trip", async () => {
    const dir = await mkTmpDir();
    const data = {
      kc: { 1: 0.8, 7: 0.9 },
      fetchedAt: new Date("2026-10-11T00:00:00Z"),
      cell: "60_21",
    };
    await climatology.saveKc(dir, 60.17, 21.39, data);
    const loaded = await climatology.loadCachedKc(dir, 60.17, 21.39);
    assert.ok(loaded);
    assert.strictEqual(loaded.kc[1], 0.8);
    assert.strictEqual(loaded.kc[7], 0.9);
    assert.strictEqual(loaded.cell, "60_21");

    // A different cell in the same dataDir does not collide
    assert.strictEqual(await climatology.loadCachedKc(dir, 61.2, 21.4), null);
  });

  test("loadCachedKc returns null for missing dir/cell and survives corruption", async () => {
    const dir = await mkTmpDir();
    assert.strictEqual(await climatology.loadCachedKc(dir, 60.17, 21.39), null);
    const file = climatology.cellFilePath(dir, 60.17, 21.39);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ truncated", "utf-8");
    await assert.rejects(() => climatology.loadCachedKc(dir, 60.17, 21.39));
  });

  test("loadCachedKc without dataDir returns null", async () => {
    assert.strictEqual(
      await climatology.loadCachedKc(null, 60.17, 21.39),
      null,
    );
  });
});

test.describe("Kc helpers", () => {
  test("monthOf uses the UTC month", () => {
    assert.strictEqual(
      climatology.monthOf(new Date("2026-01-15T10:00:00Z")),
      1,
    );
    assert.strictEqual(
      climatology.monthOf(new Date("2026-12-31T23:30:00Z")),
      12,
    );
  });

  test("monthKc: null climatology or missing month means no scaling", () => {
    assert.strictEqual(climatology.monthKc(null, 5), null);
    assert.strictEqual(climatology.monthKc({ kc: { 5: 0.7 } }, 5), 0.7);
    assert.strictEqual(climatology.monthKc({ kc: { 5: 0.7 } }, 6), null);
  });

  test("kcToCloudCover inverts Kasten-Czeplak and clamps", () => {
    assert.strictEqual(climatology.kcToCloudCover(1), 0);
    // C=0.5 → attenuation 1-0.75·0.5^3.4 ≈ 0.929 → Kc 0.929 ↔ C 0.5
    const c = climatology.kcToCloudCover(1 - 0.75 * 0.5 ** 3.4);
    assert.ok(Math.abs(c - 0.5) < 1e-6);
    assert.strictEqual(climatology.kcToCloudCover(0), 1);
  });
});

test.describe("FSM integration", () => {
  test("ensureClimatology loads a cached cell from disk without network", async () => {
    const dir = await mkTmpDir();
    const cell = climatology.cellKey(60.17, 24.94);
    await climatology.saveKc(dir, 60.17, 24.94, {
      kc: { 10: 0.6 },
      fetchedAt: new Date(),
      cell,
    });
    const fsm = new IngestionFSM(makeApp(), { dataDir: dir });
    fsm.position = { latitude: 60.17, longitude: 24.94 };
    await fsm.ensureClimatology();
    assert.ok(fsm.climatology);
    assert.strictEqual(fsm.climatology.kc[10], 0.6);
    assert.strictEqual(fsm.climatologyCell, cell);
  });

  test("floor uses climatology-scaled clear sky when the region is known", async () => {
    const fsm = makeFSM();
    // Inject the cell in memory (as ensureClimatology would after a disk load)
    fsm.climatology = {
      kc: { [climatology.monthOf(new Date())]: 0.5 },
      fetchedAt: new Date(),
      cell: climatology.cellKey(60.17, 24.94),
    };
    fsm.climatologyCell = fsm.climatology.cell;
    const { points } = await fsm.buildHybridHours(Date.now());
    for (const p of points) {
      const { altitude } = (() => {
        const { sunPosition } = require("../plugin/solar.js");
        return { altitude: sunPosition(p.time, 60.17, 24.94).altitude };
      })();
      assert.strictEqual(p.source, "climatology");
      assert.strictEqual(p.tier, Tier.CLIMATOLOGY);
      assert.ok(Math.abs(p.ghi - maxIrradiance(altitude) * 0.5) < 1e-6);
      assert.strictEqual(p.cloudCover, climatology.kcToCloudCover(0.5));
    }
    await fsm.buildStaleHybridForecast();
    assert.strictEqual(fsm.currentTier, Tier.CLIMATOLOGY);
  });

  test("floor stays pure clear sky (tier 5) without climatology data", async () => {
    const fsm = makeFSM();
    const { points } = await fsm.buildHybridHours(Date.now());
    for (const p of points) {
      assert.strictEqual(p.source, "clear-sky");
      assert.strictEqual(p.tier, Tier.CLEAR_SKY);
    }
    await fsm.buildStaleHybridForecast();
    assert.strictEqual(fsm.currentTier, Tier.CLEAR_SKY);
  });

  test("getCurrentGHI floor is climatology-scaled when the region is known", async (t) => {
    // Freeze the clock: getCurrentGHI takes its own timestamps, and the
    // offline ladder (mocked fetch → stale hybrid floor) stamps the served
    // point a few event-loop turns after the test computed its expected
    // altitude. The sun moves enough in those milliseconds (~0.04 W/m² per
    // second GHI change at this latitude) to break the 1e-6 W/m² tolerance
    // — flaky near sunrise/sunset and on loaded CI runners. A fixed noon
    // instant keeps the sun above the horizon so the scaling branch is
    // always the one exercised.
    const now = new Date("2026-07-01T09:00:00Z");
    t.mock.timers.enable({ apis: ["Date"], now });
    const fsm = makeFSM();
    fsm.climatology = {
      kc: { [climatology.monthOf(now)]: 0.75 },
      fetchedAt: now,
      cell: climatology.cellKey(60.17, 24.94),
    };
    fsm.climatologyCell = fsm.climatology.cell;
    // getForecast runs the fetch ladder; keep it off the real network
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    try {
      const { altitude } = require("../plugin/solar.js").sunPosition(
        now,
        60.17,
        24.94,
      );
      const ghi = await fsm.getCurrentGHI();
      assert.strictEqual(ghi.tier, Tier.CLIMATOLOGY);
      assert.ok(Math.abs(ghi.ghi - maxIrradiance(altitude) * 0.75) < 1e-6);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("tier 5 fetch still yields unscaled clear sky (upper bound)", () => {
    const points = generateClearSkyForecast(
      new Date("2026-07-01T09:00:00Z"),
      5,
      60.17,
      24.94,
    );
    const { altitude } = require("../plugin/solar.js").sunPosition(
      new Date("2026-07-01T09:00:00Z"),
      60.17,
      24.94,
    );
    assert.strictEqual(points[0].ghi, maxIrradiance(altitude));
    assert.strictEqual(points[0].cloudCover, 0);
  });

  test("forecastMaxAgeMs treats tiers 3-5 as low tiers", () => {
    const fsm = makeFSM();
    fsm.currentTier = Tier.LOGBOOK;
    assert.strictEqual(fsm.forecastMaxAgeMs(), 15 * 60000);
    fsm.currentTier = Tier.CLIMATOLOGY;
    assert.strictEqual(fsm.forecastMaxAgeMs(), 15 * 60000);
    fsm.currentTier = Tier.CLEAR_SKY;
    assert.strictEqual(fsm.forecastMaxAgeMs(), 15 * 60000);
    fsm.currentTier = Tier.SIGNAL_K_WEATHER;
    assert.strictEqual(fsm.forecastMaxAgeMs(), 24 * 3600000);
  });
});
