/**
 * Tests for history backfill: weather parsing, replay branching,
 * generator validation, recordings gap-fill, and populate integration.
 * @file backfill.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  fetchHistoricalWeather,
  interpolateWeather,
  carryForwardSticky,
  replayHistory,
  replayGenerators,
  replayLoadProfile,
  replayWindProtection,
  backfillSamples,
  populateFromHistory,
  historyHeaders,
  queryHistory,
} = require("../plugin/history-backfill.js");
const { SolarMatrix } = require("../plugin/learning.js");
const {
  LoadProfile,
  StateClass,
  SunPhase,
} = require("../plugin/prediction.js");
const { getRecordings } = require("../plugin/recorder.js");

/** Latitude/longitude with a high sun at fixture noon (French Polynesia) */
const LAT = -18.86;
const LON = -159.8;
/** 2026-08-20T22:00Z = local noon */
const NOON = Date.parse("2026-08-20T22:00:00Z");

function makeWeather(t) {
  return [
    {
      time: new Date(t - 3600000),
      ghi: 700,
      cloudCover: null,
      windSpeedKnots: 15,
      gustSpeedKnots: 20,
      windDirectionDeg: 90,
    },
    {
      time: new Date(t),
      ghi: 800,
      cloudCover: null,
      windSpeedKnots: 15,
      gustSpeedKnots: 20,
      windDirectionDeg: 90,
    },
  ];
}

/** History /values fixture (anchored, no AWA, no power) */
function makeHistoryData() {
  return {
    values: [
      { path: "electrical.solar.test.power" },
      { path: "electrical.batteries.house.capacity.stateOfCharge" },
      { path: "navigation.state" },
      { path: "environment.wind.angleApparent" },
      { path: "navigation.speedThroughWater" },
      { path: "electrical.dcsource.wind.power" },
      { path: "electrical.venus.dcPower" },
      { path: "electrical.venus.acPower" },
      { path: "navigation.position" },
    ],
    data: [],
  };
}

/** Column order in makeHistoryData fixtures */
const COL = {
  solar: 1,
  soc: 2,
  navState: 3,
  awa: 4,
  stw: 5,
  windGen: 6,
  house: 7,
  ac: 8,
  position: 9,
};

/**
 * Pushes a history tick with named fields so column order can't be misread.
 * @param {object} historyData
 * @param {number} minutes - Offset from NOON in minutes
 * @param {object} vals - { solar, soc, navState, awa, stw, windGen, house, ac, position }
 */
function pushTick(historyData, minutes, vals) {
  const row = [new Date(NOON + minutes * 60000).toISOString()];
  row[COL.solar] = vals.solar ?? null;
  row[COL.soc] = vals.soc ?? null;
  row[COL.navState] = vals.navState ?? null;
  row[COL.awa] = vals.awa ?? null;
  row[COL.stw] = vals.stw ?? null;
  row[COL.windGen] = vals.windGen ?? null;
  row[COL.house] = vals.house ?? null;
  row[COL.ac] = vals.ac ?? null;
  row[COL.position] = vals.position ?? [LON, LAT];
  historyData.data.push(row);
}

test.describe("carryForwardSticky", () => {
  test("carries navigation.state forward across null gaps", () => {
    const hd = {
      values: [{ path: "navigation.state", method: "last" }],
      data: [
        ["t1", "moored"],
        ["t2", null],
        ["t3", null],
        ["t4", "sailing"],
        ["t5", null],
      ],
    };
    carryForwardSticky(hd, new Map([["navigation.state", 1]]));
    assert.deepStrictEqual(
      hd.data.map((r) => r[1]),
      ["moored", "moored", "moored", "sailing", "sailing"],
    );
  });

  test("carries propulsion.*.state and navigation.position forward", () => {
    const hd = {
      values: [
        { path: "propulsion.main.state", method: "last" },
        { path: "navigation.position", method: "first" },
      ],
      data: [
        ["t1", "started", [-159.8, -18.86]],
        ["t2", null, null],
        ["t3", "stopped", null],
        ["t4", null, [-159.81, -18.87]],
        ["t5", null, null],
      ],
    };
    carryForwardSticky(
      hd,
      new Map([
        ["propulsion.main.state", 1],
        ["navigation.position", 2],
      ]),
    );
    assert.deepStrictEqual(
      hd.data.map((r) => r[1]),
      ["started", "started", "stopped", "stopped", "stopped"],
    );
    assert.deepStrictEqual(
      hd.data.map((r) => r[2]),
      [
        [-159.8, -18.86],
        [-159.8, -18.86],
        [-159.8, -18.86],
        [-159.81, -18.87],
        [-159.81, -18.87],
      ],
    );
  });

  test("does not touch non-sticky columns", () => {
    const hd = {
      values: [
        { path: "navigation.state", method: "last" },
        { path: "electrical.venus.dcPower", method: "average" },
      ],
      data: [
        ["t1", "moored", 100],
        ["t2", null, 110],
        ["t3", null, null],
      ],
    };
    carryForwardSticky(
      hd,
      new Map([
        ["navigation.state", 1],
        ["electrical.venus.dcPower", 2],
      ]),
    );
    // dcPower (a continuous measurement) is NOT carried forward
    assert.deepStrictEqual(
      hd.data.map((r) => r[2]),
      [100, 110, null],
    );
    // navigation.state IS carried forward
    assert.deepStrictEqual(
      hd.data.map((r) => r[1]),
      ["moored", "moored", "moored"],
    );
  });
});

test.describe("weather fetch", () => {
  test("archive query includes wind and parses UTC timestamps", async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: ["2026-08-20T22:00", "2026-08-20T23:00"],
            shortwave_radiation: [800, 750],
            cloud_cover: [null, null],
            wind_speed_10m: [27.782, 25.928], // → ~15 kn, ~14 kn
            wind_gusts_10m: [37.0, 35.0],
            wind_direction_10m: [90, 95],
          },
        }),
      };
    };

    const weather = await fetchHistoricalWeather({
      latitude: LAT,
      longitude: LON,
      from: new Date(NOON),
      to: new Date(NOON + 3600000),
      fetchImpl,
    });

    assert.match(urls[0], /wind_speed_10m/);
    assert.match(urls[0], /shortwave_radiation/);
    assert.strictEqual(weather.length, 2);
    // Naive timestamps parsed as UTC regardless of host timezone
    assert.strictEqual(
      weather[0].time.toISOString(),
      "2026-08-20T22:00:00.000Z",
    );
    // km/h → knots
    assert.ok(Math.abs(weather[0].windSpeedKnots - 15) < 0.01);
    assert.ok(Math.abs(weather[0].gustSpeedKnots - 19.98) < 0.01);
    assert.strictEqual(weather[0].windDirectionDeg, 90);
  });

  test("interpolation carries wind fields and rejects far matches", () => {
    const weather = makeWeather(NOON);
    const at = interpolateWeather(weather, new Date(NOON + 60000));
    assert.strictEqual(at.windSpeedKnots, 15);
    assert.strictEqual(at.gustSpeedKnots, 20);

    const far = interpolateWeather(weather, new Date(NOON + 5 * 3600000));
    assert.strictEqual(far.ghi, null);
    assert.strictEqual(far.windSpeedKnots, null);
  });
});

test.describe("replayHistory", () => {
  const array = {
    id: "test-array",
    powerPath: "electrical.solar.test.power",
    capacityWp: 100,
  };

  test("anchored ticks update the anchored matrix", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, { solar: 50, soc: 0.5, navState: "anchored" });
    }
    const matrix = new SolarMatrix("test-array");
    const stats = replayHistory({
      matrix,
      array,
      socPath: "electrical.batteries.house.capacity.stateOfCharge",
      historyData,
      weather: makeWeather(NOON),
      latitude: LAT,
      longitude: LON,
      resolution: 300,
    });

    assert.ok(stats.dataPoints > 0);
    assert.strictEqual(stats.sailingTicks, 0);
    assert.ok(stats.binUpdates > 0);
    assert.ok(stats.totalActualWh > 0);
    assert.ok(matrix.anchored.size > 0);
    assert.strictEqual(matrix.sailing.size, 0);
  });

  test("sailing ticks with AWA update the sailing matrix", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 50,
        soc: 0.5,
        navState: "sailing",
        awa: 0.5,
      });
    }
    const matrix = new SolarMatrix("test-array");
    const stats = replayHistory({
      matrix,
      array,
      socPath: "electrical.batteries.house.capacity.stateOfCharge",
      historyData,
      weather: makeWeather(NOON),
      latitude: LAT,
      longitude: LON,
      resolution: 300,
    });

    assert.strictEqual(stats.sailingTicks, stats.dataPoints);
    assert.ok(stats.sailingTicks > 0);
    assert.ok(matrix.sailing.size > 0);
  });

  test("navState is inferred from STW when navigation.state is absent", () => {
    // Many vessels never report navigation.state; without inference the
    // backfill treats every tick as anchored, killing sailing solar bins
    // and hydro predictions even while STW shows the boat underway.
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 50,
        soc: 0.5,
        navState: null, // no explicit nav state
        awa: 0.5,
        stw: 2.57222, // 5 knots in m/s
      });
    }
    const matrix = new SolarMatrix("test-array");
    const stats = replayHistory({
      matrix,
      array,
      socPath: "electrical.batteries.house.capacity.stateOfCharge",
      historyData,
      weather: makeWeather(NOON),
      latitude: LAT,
      longitude: LON,
      resolution: 300,
    });

    // Inferred as sailing from STW >= 2 kn, so sailing bins update
    assert.strictEqual(stats.sailingTicks, stats.dataPoints);
    assert.ok(matrix.sailing.size > 0);
  });

  test("navState defaults to anchored when STW is below threshold", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 50,
        soc: 0.5,
        navState: null,
        stw: 0.514444, // 1 knot in m/s, below 2 kn threshold
      });
    }
    const matrix = new SolarMatrix("test-array");
    const stats = replayHistory({
      matrix,
      array,
      socPath: "electrical.batteries.house.capacity.stateOfCharge",
      historyData,
      weather: makeWeather(NOON),
      latitude: LAT,
      longitude: LON,
      resolution: 300,
    });

    // Below 2 kn → anchored, no sailing bins
    assert.strictEqual(stats.sailingTicks, 0);
    assert.strictEqual(matrix.sailing.size, 0);
  });

  test("night ticks produce no theoretical power", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, { solar: 50, soc: 0.5, navState: "anchored" });
    }
    const night = Date.parse("2026-08-20T10:00:00Z"); // local midnight
    const matrix = new SolarMatrix("test-array");
    const stats = replayHistory({
      matrix,
      array,
      socPath: "electrical.batteries.house.capacity.stateOfCharge",
      historyData,
      weather: makeWeather(night),
      latitude: LAT,
      longitude: LON,
      resolution: 300,
    });
    assert.strictEqual(stats.dataPoints, 0);
  });
});

test.describe("replayGenerators", () => {
  test("wind generator prediction uses archive wind through the curve", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 0,
        soc: 0.5,
        navState: "anchored",
        windGen: 10,
      });
    }
    const results = replayGenerators({
      generators: [
        {
          id: "windgen",
          type: "wind",
          deployable: true,
          powerPath: "electrical.dcsource.wind.power",
          curve: [
            { speed: 5, watts: 5 },
            { speed: 10, watts: 15 },
            { speed: 15, watts: 55 },
            { speed: 20, watts: 140 },
          ],
        },
      ],
      historyData,
      weather: makeWeather(NOON), // 15 kn
      resolution: 300,
    });

    assert.strictEqual(results.length, 1);
    const r = results[0];
    assert.strictEqual(r.id, "windgen");
    assert.strictEqual(r.dataPoints, 6);
    // 6 ticks × 5 min at 55 W → 27.5 Wh → 28 rounded
    assert.ok(
      Math.abs(r.totalPredictedWh - 28) <= 1,
      `got ${r.totalPredictedWh}`,
    );
  });

  test("wind generator stows at moored when deployableAtMoored is false", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 0,
        soc: 0.5,
        navState: "moored",
        windGen: 0,
      });
    }
    const gen = {
      id: "windgen",
      type: "wind",
      deployable: true,
      deployableAtMoored: false,
      powerPath: "electrical.dcsource.wind.power",
      curve: [
        { speed: 5, watts: 5 },
        { speed: 10, watts: 15 },
        { speed: 15, watts: 55 },
      ],
    };
    const results = replayGenerators({
      generators: [gen],
      historyData,
      weather: makeWeather(NOON), // 15 kn
      resolution: 300,
    });
    // Moored + deployableAtMoored:false → stowed → 0 Wh
    assert.strictEqual(results[0].totalPredictedWh, 0);
  });

  test("wind generator deploys at moored when deployableAtMoored is true (default)", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 0,
        soc: 0.5,
        navState: "moored",
        windGen: 10,
      });
    }
    const gen = {
      id: "windgen",
      type: "wind",
      deployable: true,
      // deployableAtMoored omitted → default true
      powerPath: "electrical.dcsource.wind.power",
      curve: [
        { speed: 5, watts: 5 },
        { speed: 10, watts: 15 },
        { speed: 15, watts: 55 },
      ],
    };
    const results = replayGenerators({
      generators: [gen],
      historyData,
      weather: makeWeather(NOON),
      resolution: 300,
    });
    // Moored + default deployableAtMoored → deployed → 55 W × 6 ticks × 5min
    assert.ok(results[0].totalPredictedWh > 0);
  });

  test("navigation.state carries forward across gaps in backfill replay", () => {
    // First tick is explicitly moored; subsequent ticks have no nav state
    // and STW=0 (which would otherwise infer "anchored"). Carry-forward
    // must keep the wind generator stowed (deployableAtMoored:false) for
    // the whole run instead of flipping to anchored→deployed at the gaps.
    const historyData = makeHistoryData();
    pushTick(historyData, 0, {
      solar: 0,
      soc: 0.5,
      navState: "moored",
      windGen: 0,
      stw: 0,
    });
    for (let m = 5; m < 30; m += 5) {
      pushTick(historyData, m, {
        solar: 0,
        soc: 0.5,
        navState: null, // gap: should carry "moored" forward
        windGen: 0,
        stw: 0,
      });
    }
    const gen = {
      id: "windgen",
      type: "wind",
      deployable: true,
      deployableAtMoored: false,
      powerPath: "electrical.dcsource.wind.power",
      curve: [
        { speed: 5, watts: 5 },
        { speed: 10, watts: 15 },
        { speed: 15, watts: 55 },
      ],
    };
    const results = replayGenerators({
      generators: [gen],
      historyData,
      weather: makeWeather(NOON), // 15 kn — enough to deploy if at anchor
      resolution: 300,
    });
    // Carried moored → stowed for every tick → 0 Wh. Without carry-forward
    // the gaps would infer anchored and produce >0 Wh.
    assert.strictEqual(results[0].totalPredictedWh, 0);
  });

  test("hydro generator requires sailing and speed", () => {
    const historyData = makeHistoryData();
    for (let m = 0; m < 30; m += 5) {
      // stw column = 4 m/s ≈ 7.8 kn (above min)
      pushTick(historyData, m, { stw: 4, soc: 0.5, navState: "anchored" });
    }
    const results = replayGenerators({
      generators: [
        {
          id: "hydrogen",
          type: "hydro",
          deployable: true,
          powerPath: "electrical.dcsource.wind.power",
          curve: [
            { speed: 4, watts: 24 },
            { speed: 5, watts: 48 },
          ],
        },
      ],
      historyData,
      weather: makeWeather(NOON),
      resolution: 300,
    });
    // Not sailing → engine predicts stowed → 0
    assert.strictEqual(results[0].totalPredictedWh, 0);
  });
});

test.describe("replayLoadProfile", () => {
  test("replays history into the sun-phase bins so getLoad returns a value", () => {
    // Noon ticks across 4 distinct UTC days, anchored, with DC + AC load.
    // The fixture position is local noon, so every tick classifies as DAY.
    const historyData = makeHistoryData();
    for (let day = 0; day < 4; day++) {
      const t = NOON + day * 24 * 3600000;
      const row = [new Date(t).toISOString()];
      row[COL.soc] = 0.5;
      row[COL.navState] = "anchored";
      row[COL.house] = 60;
      row[COL.ac] = 40;
      row[COL.position] = [LON, LAT];
      historyData.data.push(row);
    }

    const loadProfile = new LoadProfile({
      config: { minDaysPerBin: 3 },
      getSelfPath: () => undefined,
      app: undefined,
    });
    const stats = replayLoadProfile({
      loadProfile,
      historyData,
      resolution: 300,
    });

    assert.strictEqual(stats.dataPoints, 4);
    assert.strictEqual(stats.ingested, 4);
    assert.strictEqual(stats.gated, 0);
    // The at-rest:day bin is now past the 3-day gate
    const load = loadProfile.getLoad(SunPhase.DAY, StateClass.AT_REST);
    assert.ok(load, "getLoad should return a value after replay");
    assert.ok(load.dcWh > 0);
    assert.ok(load.acWh > 0);
    assert.strictEqual(loadProfile.learnedBins().length, 1);
  });

  test("engine-running ticks are gated out", () => {
    const historyData = makeHistoryData();
    // propulsion.main.state = started on every tick
    historyData.values.push({ path: "propulsion.main.state" });
    // Re-point columns: add propulsion column after position
    const propCol = COL.position + 1;
    for (let day = 0; day < 4; day++) {
      const t = NOON + day * 24 * 3600000;
      const row = [new Date(t).toISOString()];
      row[COL.soc] = 0.5;
      row[COL.navState] = "anchored";
      row[COL.house] = 60;
      row[COL.position] = [LON, LAT];
      row[propCol] = "started";
      historyData.data.push(row);
    }

    const loadProfile = new LoadProfile({
      config: { minDaysPerBin: 1 },
      getSelfPath: () => undefined,
      app: undefined,
    });
    const stats = replayLoadProfile({
      loadProfile,
      historyData,
      resolution: 300,
    });

    // All ticks gated as engine-running, nothing ingested
    assert.strictEqual(stats.ingested, 0);
    assert.strictEqual(stats.gated, 4);
    assert.strictEqual(loadProfile.learnedBins().length, 0);
  });

  test("adds uncounted wind/hydro charging back to reconstruct gross load", () => {
    // dcPower = shunt + solar. Wind charging flows through the shunt but is
    // NOT added back by Venus, so a tick with dcPower=-50 and wind=60 should
    // ingest gross=10W, not -50 (clamped to 0).
    const historyData = makeHistoryData();
    for (let day = 0; day < 4; day++) {
      const t = NOON + day * 24 * 3600000;
      const row = [new Date(t).toISOString()];
      row[COL.soc] = 0.5;
      row[COL.navState] = "anchored";
      row[COL.windGen] = 60;
      row[COL.house] = -50;
      row[COL.position] = [LON, LAT];
      historyData.data.push(row);
    }

    const loadProfile = new LoadProfile({
      config: { minDaysPerBin: 3 },
      getSelfPath: () => undefined,
      app: undefined,
    });
    const stats = replayLoadProfile({
      loadProfile,
      historyData,
      resolution: 300,
      uncountedChargingPaths: ["electrical.dcsource.wind.power"],
    });

    assert.strictEqual(stats.ingested, 4);
    assert.strictEqual(stats.gated, 0);
    const load = loadProfile.getLoad(SunPhase.DAY, StateClass.AT_REST);
    assert.ok(load, "getLoad should return a value after replay");
    // Gross = -50 + 60 = 10W. EMA seeded at 10 and unchanged (all samples 10).
    assert.ok(
      load.dcWh > 0 && load.dcWh <= 11,
      `expected gross ~10W, got ${load.dcWh}`,
    );
  });

  test("without uncountedChargingPaths, negative dcPower clamps to 0", () => {
    // Same ticks but no wind path passed: gross = max(0, -50) = 0W.
    const historyData = makeHistoryData();
    for (let day = 0; day < 4; day++) {
      const t = NOON + day * 24 * 3600000;
      const row = [new Date(t).toISOString()];
      row[COL.soc] = 0.5;
      row[COL.navState] = "anchored";
      row[COL.windGen] = 60;
      row[COL.house] = -50;
      row[COL.position] = [LON, LAT];
      historyData.data.push(row);
    }

    const loadProfile = new LoadProfile({
      config: { minDaysPerBin: 3 },
      getSelfPath: () => undefined,
      app: undefined,
    });
    const stats = replayLoadProfile({
      loadProfile,
      historyData,
      resolution: 300,
    });

    assert.strictEqual(stats.ingested, 4);
    const load = loadProfile.getLoad(SunPhase.DAY, StateClass.AT_REST);
    assert.ok(load, "getLoad should return a value");
    assert.ok(load.dcWh <= 1, `expected ~0W, got ${load.dcWh}`);
  });
});

test.describe("recordings gap-fill", () => {
  test("replayed ticks skip timestamps near live samples", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-gap-"));
    try {
      const { recordSample } = require("../plugin/recorder.js");
      // Live sample at noon sharp
      await recordSample({ debug() {} }, dataDir, {
        timestamp: new Date(NOON),
        arrays: { live: 1 },
        generators: {},
        soc: 0.5,
        houseLoadW: 50,
        windSpeedKnots: 5,
        navState: "anchored",
        position: null,
      });

      const historyData = makeHistoryData();
      for (let m = -10; m <= 10; m += 5) {
        pushTick(historyData, m, { solar: 50, soc: 0.5, navState: "anchored" });
      }

      const written = await backfillSamples({
        app: { debug() {} },
        dataDir,
        historyData,
        weather: makeWeather(NOON),
        arrays: [
          {
            id: "test-array",
            powerPath: "electrical.solar.test.power",
          },
        ],
        generators: [],
        socPath: "electrical.batteries.house.capacity.stateOfCharge",
        from: new Date(NOON - 3600000),
        to: new Date(NOON + 3600000),
      });

      // 5 ticks, but the one at noon (±2.5 min) is a live sample
      assert.strictEqual(written, 4);

      const samples = await getRecordings(
        dataDir,
        new Date(NOON - 3600000),
        new Date(NOON + 3600000),
        "sample",
      );
      assert.strictEqual(samples.length, 5);
      // The noon bucket keeps the live sample (arrays: {live: 1}), not a replayed one
      const noon = samples.find(
        (s) => Math.abs(Date.parse(s.timestamp) - NOON) < 60000,
      );
      assert.deepStrictEqual(noon.arrays, { live: 1 });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

test.describe("populateFromHistory", () => {
  test("full flow: matrices, generator stats, samples written", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-pop-"));
    try {
      const config = {
        battery: {
          socPath: "electrical.batteries.house.capacity.stateOfCharge",
        },
        solarArrays: [
          {
            id: "test-array",
            powerPath: "electrical.solar.test.power",
            capacityWp: 100,
          },
        ],
        mechanicalGenerators: [
          {
            id: "windgen",
            type: "wind",
            powerPath: "electrical.dcsource.wind.power",
            manufacturerCurve: "5,5,15,55,20,140",
          },
        ],
      };

      const historyData = makeHistoryData();
      for (let m = 0; m < 30; m += 5) {
        // solar 50 W, wind gen 20 W actual, 60 W house load
        pushTick(historyData, m, {
          solar: 50,
          soc: 0.5,
          navState: "anchored",
          windGen: 20,
          house: 60,
        });
      }

      const fetchImpl = async (url) => {
        const u = String(url);
        if (u.includes("/history/values")) {
          return { ok: true, json: async () => historyData };
        }
        if (u.includes("/history/paths")) {
          return { ok: true, json: async () => ["propulsion.main.state"] };
        }
        if (u.includes("archive-api")) {
          return {
            ok: true,
            json: async () => ({
              hourly: {
                time: ["2026-08-20T22:00"],
                shortwave_radiation: [800],
                cloud_cover: [null],
                wind_speed_10m: [27.782], // → ~15 kn
                wind_gusts_10m: [37],
                wind_direction_10m: [90],
              },
            }),
          };
        }
        throw new Error(`unexpected url ${u}`);
      };

      const result = await populateFromHistory({
        config,
        baseUrl: "http://localhost:3000",
        from: new Date(NOON - 3600000),
        to: new Date(NOON + 3600000),
        latitude: LAT,
        longitude: LON,
        dataDir,
        resolution: 300,
        fetchImpl,
      });

      // Solar matrix learned
      assert.strictEqual(result.arrays.length, 1);
      assert.ok(result.arrays[0].binUpdates > 0);
      // Matrix persisted to data dir
      const matrixFile = path.join(dataDir, "solar-matrix-test-array.json");
      const persisted = JSON.parse(await fs.readFile(matrixFile, "utf8"));
      assert.ok(
        persisted.anchored && Object.keys(persisted.anchored).length > 0,
      );

      // Generator replayed with validation stats
      assert.strictEqual(result.generators.length, 1);
      assert.strictEqual(result.generators[0].id, "windgen");
      assert.ok(result.generators[0].totalPredictedWh > 0);

      // Samples gap-filled into recordings
      assert.strictEqual(result.samplesWritten, 6);
      const samples = await getRecordings(
        dataDir,
        new Date(NOON - 3600000),
        new Date(NOON + 3600000),
        "sample",
      );
      assert.strictEqual(samples.length, 6);
      assert.ok(Math.abs(samples[0].windSpeedKnots - 15) < 0.1);
      // Solar power recorded into the sample's arrays map
      assert.strictEqual(samples[0].arrays["test-array"], 50);

      // Load profile replayed and persisted
      assert.ok(
        result.loadProfile,
        "populate should report load-profile stats",
      );
      assert.strictEqual(result.loadProfile.seeded, false);
      assert.ok(result.loadProfile.ingested > 0);
      const lpFile = path.join(dataDir, "load-profile.json");
      const persistedLp = JSON.parse(await fs.readFile(lpFile, "utf8"));
      assert.ok(
        Object.keys(persistedLp.bins).length > 0,
        "load-profile.json should contain learned bins",
      );
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("fresh: true wipes existing matrices and rebuilds from scratch", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-fresh-"));
    try {
      const config = {
        battery: {
          socPath: "electrical.batteries.house.capacity.stateOfCharge",
        },
        solarArrays: [
          {
            id: "test-array",
            powerPath: "electrical.solar.test.power",
            capacityWp: 100,
          },
        ],
        mechanicalGenerators: [],
      };

      const historyData = makeHistoryData();
      for (let m = 0; m < 30; m += 5) {
        pushTick(historyData, m, { solar: 50, soc: 0.5, navState: "anchored" });
      }

      const fetchImpl = async (url) => {
        const u = String(url);
        if (u.includes("/history/values")) {
          return { ok: true, json: async () => historyData };
        }
        if (u.includes("/history/paths")) {
          return { ok: true, json: async () => [] };
        }
        if (u.includes("archive-api")) {
          return {
            ok: true,
            json: async () => ({
              hourly: {
                time: ["2026-08-20T22:00"],
                shortwave_radiation: [800],
                cloud_cover: [null],
                wind_speed_10m: [27.782],
                wind_gusts_10m: [37],
                wind_direction_10m: [90],
              },
            }),
          };
        }
        throw new Error(`unexpected url ${u}`);
      };

      // First run: seeds a matrix from scratch
      await populateFromHistory({
        config,
        baseUrl: "http://localhost:3000",
        from: new Date(NOON - 3600000),
        to: new Date(NOON + 3600000),
        latitude: LAT,
        longitude: LON,
        dataDir,
        resolution: 300,
        fetchImpl,
      });
      const matrixFile = path.join(dataDir, "solar-matrix-test-array.json");
      const firstRun = JSON.parse(await fs.readFile(matrixFile, "utf8"));
      const firstBinCount = Object.keys(firstRun.anchored).length;
      assert.ok(firstBinCount > 0);

      // Second run with fresh: true wipes and rebuilds — same data, same bins
      const result2 = await populateFromHistory({
        config,
        baseUrl: "http://localhost:3000",
        from: new Date(NOON - 3600000),
        to: new Date(NOON + 3600000),
        latitude: LAT,
        longitude: LON,
        dataDir,
        fresh: true,
        resolution: 300,
        fetchImpl,
      });
      assert.strictEqual(result2.arrays[0].seeded, false);
      const secondRun = JSON.parse(await fs.readFile(matrixFile, "utf8"));
      // Rebuilt from scratch: same bin count, not double-applied
      assert.strictEqual(Object.keys(secondRun.anchored).length, firstBinCount);
      // Values should be identical (same input, fresh EMA from default)
      const firstVal = Object.values(firstRun.anchored)[0];
      const secondVal = Object.values(secondRun.anchored)[0];
      assert.ok(Math.abs(firstVal - secondVal) < 0.001);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

test.describe("auth headers", () => {
  test("SIGNALK_TOKEN env becomes a bearer header", () => {
    const saved = process.env.SIGNALK_TOKEN;
    process.env.SIGNALK_TOKEN = "test-token";
    try {
      assert.deepStrictEqual(historyHeaders(), {
        Accept: "application/json",
        Authorization: "Bearer test-token",
      });
      assert.deepStrictEqual(historyHeaders("other"), {
        Accept: "application/json",
        Authorization: "Bearer other",
      });
    } finally {
      if (saved == null) {
        delete process.env.SIGNALK_TOKEN;
      } else {
        process.env.SIGNALK_TOKEN = saved;
      }
    }
  });
});

test.describe("queryHistory", () => {
  test("textual .state paths get :last method, numeric paths stay default", async () => {
    let capturedUrl;
    const fakeFetch = async (input) => {
      capturedUrl = new URL(input);
      return {
        ok: true,
        json: async () => ({
          values: [
            { path: "navigation.state", method: "last" },
            { path: "propulsion.main.state", method: "last" },
            { path: "navigation.speedThroughWater", method: "average" },
          ],
          data: [],
        }),
      };
    };
    await queryHistory({
      baseUrl: "http://example.test",
      from: new Date("2026-08-15T00:00:00Z"),
      to: new Date("2026-08-15T23:59:59Z"),
      paths: [
        "navigation.state",
        "propulsion.main.state",
        "navigation.speedThroughWater",
      ],
      fetchImpl: fakeFetch,
    });
    const pathsParam = capturedUrl.searchParams.get("paths");
    assert.ok(
      pathsParam.includes("navigation.state:last"),
      "navigation.state must get :last",
    );
    assert.ok(
      pathsParam.includes("propulsion.main.state:last"),
      "propulsion state must get :last",
    );
    assert.ok(
      !pathsParam.includes("speedThroughWater:last"),
      "numeric path must not get :last",
    );
  });
});

test.describe("replayWindProtection", () => {
  test("learns speed + gust factors from at-rest history (gust = speed max)", () => {
    // There is no environment.wind.gust sensor; the measured gust is the
    // max of true wind speed over the bucket (History API :max).
    const historyData = {
      values: [
        { path: "navigation.state", method: "last" },
        { path: "navigation.speedThroughWater" },
        { path: "environment.wind.speedTrue" },
        { path: "environment.wind.speedTrue", method: "max" },
        { path: "navigation.position" },
      ],
      data: [],
    };
    // Columns: 0=ts, 1=navState, 2=stw, 3=speedTrue(avg, m/s), 4=speedTrue:max, 5=position
    // Dwell 15 min: first qualifying tick is at +15 min.
    // True wind 4 m/s (~7.77 kn) measured, forecast 15 kn → speed factor < 1.
    // Max over bucket 6 m/s (~11.66 kn) vs forecast gust 20 kn → gust factor < 1.
    const pushTick = (minutes, { speedMs, gustMs }) => {
      historyData.data.push([
        new Date(NOON + minutes * 60000).toISOString(),
        "anchored",
        0,
        speedMs,
        gustMs,
        [LON, LAT],
      ]);
    };
    for (const m of [0, 5, 10, 15, 20, 25]) {
      pushTick(m, { speedMs: 4, gustMs: 6 });
    }

    const weather = makeWeather(NOON);
    const { WindProtectionStore } = require("../plugin/wind-protection.js");
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 10 });
    const stats = replayWindProtection({
      store,
      config: { windProtection: { enabled: true, dwellMinutes: 15 } },
      historyData,
      weather,
      resolution: 300,
    });

    // The drop bucket (0 min, transition into at-rest) resolves the place
    // and is skipped; 5/10 min are dwell-skipped; 15/20/25 min learn.
    assert.ok(stats.samples >= 1, `expected samples, got ${stats.samples}`);
    assert.ok(
      stats.skippedDwell >= 2,
      `expected dwell skips, got ${stats.skippedDwell}`,
    );
    assert.ok(store.sizePlaces === 1);
    assert.ok(store.sizeSpeed >= 1);
    assert.ok(store.sizeGust >= 1);
    // Forecast wind from the east (90°) → sector 2 (E)
    const factors = store.getFactors(store.placeLru[0], 2, false);
    assert.ok(factors.speed < 1, `speed factor ${factors.speed} should be < 1`);
    assert.ok(factors.gust < 1, `gust factor ${factors.gust} should be < 1`);
  });

  test("skips under-way ticks and resets the dwell window", () => {
    const historyData = {
      values: [
        { path: "navigation.state", method: "last" },
        { path: "navigation.speedThroughWater" },
        { path: "environment.wind.speedTrue" },
        { path: "navigation.position" },
      ],
      data: [],
    };
    const pushTick = (minutes, navState, speedMs) => {
      historyData.data.push([
        new Date(NOON + minutes * 60000).toISOString(),
        navState,
        navState === "sailing" ? 3 : 0,
        speedMs,
        [LON, LAT],
      ]);
    };
    // Anchored 0..20 (dwell at 15+), then sailing, then anchored again
    for (const m of [0, 5, 10, 15, 20]) pushTick(m, "anchored", 4);
    pushTick(25, "sailing", 6);
    for (const m of [30, 35, 40, 45, 50]) pushTick(m, "anchored", 4);

    const weather = makeWeather(NOON);
    const { WindProtectionStore } = require("../plugin/wind-protection.js");
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 10 });
    const stats = replayWindProtection({
      store,
      config: { windProtection: { enabled: true, dwellMinutes: 15 } },
      historyData,
      weather,
      resolution: 300,
    });

    assert.ok(stats.skippedUnderway >= 1, "sailing tick skipped");
    // The second anchored window must dwell again before learning
    assert.ok(
      stats.samples < 6,
      `second window should dwell-skip early ticks, samples=${stats.samples}`,
    );
  });

  test("a relocation within a moored session restarts dwell", () => {
    // Real scenario from 2026-08-17: the nav state flipped to "moored" while
    // the boat was still at the approach position, then it moved ~1.5 km to
    // the slip 30 min later — all within one continuous "moored" state.
    // The replay must treat these as two distinct anchorages (the 1.5 km
    // jump exceeds the match radius) and restart the dwell window at the
    // slip, so learning happens at the slip, not the approach.
    const historyData = {
      values: [
        { path: "navigation.state", method: "last" },
        { path: "navigation.speedThroughWater" },
        { path: "environment.wind.speedTrue" },
        { path: "navigation.position" },
      ],
      data: [],
    };
    const approach = [-159.8090204, -18.8528303]; // [lon, lat]
    const slip = [-159.8000228, -18.8638846];
    // 0..25 min at the approach (moored), 30+ min at the slip (moored)
    const pushTick = (minutes, pos, speedMs) => {
      historyData.data.push([
        new Date(NOON + minutes * 60000).toISOString(),
        "moored",
        0,
        speedMs,
        pos,
      ]);
    };
    for (const m of [0, 5, 10, 15, 20, 25]) pushTick(m, approach, 4);
    for (const m of [30, 35, 40, 45, 50, 55]) pushTick(m, slip, 4);

    const weather = makeWeather(NOON);
    const { WindProtectionStore } = require("../plugin/wind-protection.js");
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 10 });
    const stats = replayWindProtection({
      store,
      config: { windProtection: { enabled: true, dwellMinutes: 15 } },
      historyData,
      weather,
      resolution: 300,
    });

    // Two distinct anchorages registered (approach + slip)
    assert.strictEqual(
      store.anchorages.size,
      2,
      "approach and slip should be separate anchorages",
    );
    // Learning happens at the slip (the approach never dwells long enough
    // before the relocation, and even if it did, it's a different place)
    assert.ok(
      stats.samples >= 1,
      `expected samples at the slip, got ${stats.samples}`,
    );
  });
});

test.describe("populateFromHistory: wind protection", () => {
  test("seeds and persists the WPF store from history", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-wpf-"));
    try {
      const config = {
        battery: {
          socPath: "electrical.batteries.house.capacity.stateOfCharge",
        },
        solarArrays: [
          {
            id: "test-array",
            powerPath: "electrical.solar.test.power",
            capacityWp: 100,
          },
        ],
        mechanicalGenerators: [],
        windProtection: { enabled: true, dwellMinutes: 15 },
      };

      // History with wind columns + a :max gust column
      const historyData = {
        values: [
          { path: "electrical.solar.test.power" },
          { path: "electrical.batteries.house.capacity.stateOfCharge" },
          { path: "navigation.state", method: "last" },
          { path: "environment.wind.angleApparent" },
          { path: "navigation.speedThroughWater" },
          { path: "electrical.venus.dcPower" },
          { path: "electrical.venus.acPower" },
          { path: "environment.wind.speedTrue" },
          { path: "environment.wind.speedTrue", method: "max" },
          { path: "navigation.position" },
        ],
        data: [],
      };
      // columns: 0 ts, 1 solar, 2 soc, 3 nav, 4 awa, 5 stw, 6 dc, 7 ac, 8 windAvg, 9 windMax, 10 pos
      for (const m of [0, 5, 10, 15, 20, 25]) {
        historyData.data.push([
          new Date(NOON + m * 60000).toISOString(),
          50, // solar
          0.5, // soc
          "anchored",
          null,
          0,
          60,
          0,
          4, // wind avg m/s
          6, // wind max m/s
          [LON, LAT],
        ]);
      }

      const fetchImpl = async (url) => {
        const u = String(url);
        if (u.includes("/history/values")) {
          return { ok: true, json: async () => historyData };
        }
        if (u.includes("/history/paths")) {
          return { ok: true, json: async () => [] };
        }
        if (u.includes("archive-api")) {
          return {
            ok: true,
            json: async () => ({
              hourly: {
                time: ["2026-08-20T22:00"],
                shortwave_radiation: [800],
                cloud_cover: [null],
                wind_speed_10m: [27.782], // ~15 kn
                wind_gusts_10m: [37], // ~19.98 kn
                wind_direction_10m: [90],
              },
            }),
          };
        }
        throw new Error(`unexpected url ${u}`);
      };

      const result = await populateFromHistory({
        config,
        baseUrl: "http://localhost:3000",
        from: new Date(NOON - 3600000),
        to: new Date(NOON + 3600000),
        latitude: LAT,
        longitude: LON,
        dataDir,
        resolution: 300,
        fetchImpl,
      });

      assert.ok(result.windProtection, "populate should report WPF stats");
      assert.ok(result.windProtection.samples >= 1);
      assert.ok(result.windProtection.places >= 1);

      // Persisted to disk
      const wpfFile = path.join(dataDir, "wind-protection.json");
      const persisted = JSON.parse(await fs.readFile(wpfFile, "utf8"));
      assert.ok(
        Object.keys(persisted.speedFactors || {}).length > 0,
        "speed factors persisted",
      );
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("omits windProtection when disabled in config", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bf-wpf-off-"));
    try {
      const config = {
        battery: {
          socPath: "electrical.batteries.house.capacity.stateOfCharge",
        },
        solarArrays: [
          {
            id: "test-array",
            powerPath: "electrical.solar.test.power",
            capacityWp: 100,
          },
        ],
        mechanicalGenerators: [],
        windProtection: { enabled: false },
      };
      const historyData = makeHistoryData();
      for (let m = 0; m < 30; m += 5) {
        pushTick(historyData, m, { solar: 50, soc: 0.5, navState: "anchored" });
      }
      const fetchImpl = async (url) => {
        const u = String(url);
        if (u.includes("/history/values")) {
          return { ok: true, json: async () => historyData };
        }
        if (u.includes("/history/paths")) {
          return { ok: true, json: async () => [] };
        }
        if (u.includes("archive-api")) {
          return {
            ok: true,
            json: async () => ({
              hourly: {
                time: ["2026-08-20T22:00"],
                shortwave_radiation: [800],
                cloud_cover: [null],
                wind_speed_10m: [27.782],
                wind_gusts_10m: [37],
                wind_direction_10m: [90],
              },
            }),
          };
        }
        throw new Error(`unexpected url ${u}`);
      };
      const result = await populateFromHistory({
        config,
        baseUrl: "http://localhost:3000",
        from: new Date(NOON - 3600000),
        to: new Date(NOON + 3600000),
        latitude: LAT,
        longitude: LON,
        dataDir,
        resolution: 300,
        fetchImpl,
      });
      assert.strictEqual(result.windProtection, null);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
