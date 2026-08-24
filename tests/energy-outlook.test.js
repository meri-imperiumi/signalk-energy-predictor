/**
 * Smoketests for the 24h energy outlook (PredictionEngine.getEnergyOutlook)
 * and the corresponding advisory publisher methods:
 * publishEnergyOutlook, publishForecastYield, publishEnvironmentGust, and
 * the forecast-status validTo extension.
 *
 * @file energy-outlook.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PredictionEngine, msFromKnots } = require("../plugin/prediction.js");
const { AdvisoryPublisher } = require("../plugin/advisory.js");

function makeFakeApp() {
  const pathValues = new Map();
  return {
    selfId: "self",
    debug() {},
    info() {},
    warn() {},
    error() {},
    getSelfPath(path) {
      return pathValues.get(path);
    },
    setSelfPath(path, value) {
      pathValues.set(path, value);
    },
    handleMessageCalls: [],
    handleMessage(source, msg) {
      this.handleMessageCalls.push({ source, msg });
    },
  };
}

/**
 * Builds an engine with a controllable house load (venus.dcPower) and a
 * SoC seed. Capacity is 400 Ah × 12 V = 4800 Wh.
 */
function makeEngine({
  chemistry,
  dcPowerW = 0,
  soc = 0.5,
  ghi = 0,
  capacityWp = 1000,
} = {}) {
  const app = makeFakeApp();
  app.setSelfPath("navigation.state", "anchored");
  app.setSelfPath("electrical.batteries.house.capacity.stateOfCharge", soc);
  if (dcPowerW) app.setSelfPath("electrical.venus.dcPower", dcPowerW);

  const engine = new PredictionEngine({
    battery: {
      capacityAh: 400,
      systemVoltage: 12,
      minSafeSoC: 0.2,
      ...(chemistry ? { chemistry } : {}),
    },
    solarArrays: ghi ? [{ id: "fixed", type: "fixed", capacityWp }] : [],
    mechanicalGenerators: [],
    getEfficiency: () => 0.7,
    getSelfPath: (path) => app.getSelfPath(path),
    app,
  });
  return { engine, app };
}

/** Daytime forecast (GHI set per hour via solar array present). */
function dayForecast(ghi) {
  const now = new Date();
  return Array.from({ length: 24 }, (_, h) => ({
    time: new Date(now.getTime() + h * 3600000),
    ghi,
    cloudCover: 0,
    gustSpeedMs: null,
    windSpeedMs: null,
  }));
}

test.describe("PredictionEngine.getEnergyOutlook", () => {
  test("returns null before any prediction has run", () => {
    const { engine } = makeEngine();
    assert.strictEqual(engine.getEnergyOutlook(), null);
  });

  test("reports critical when the track dips below the LiFePO4 threshold", () => {
    // 500 W constant draw, no production, start at 50%:
    // 24 h × 500 Wh = 12 kWh > available 2.4 kWh → SoC floor reached.
    const { engine } = makeEngine({ dcPowerW: 500, soc: 0.5 });
    engine.runPrediction(dayForecast(0));
    const outlook = engine.getEnergyOutlook();
    assert.strictEqual(outlook.status, "critical");
    assert.strictEqual(outlook.criticalSoC, 0.3);
    assert.ok(outlook.minSoC < 0.3);
  });

  test("lead-acid chemistry raises the critical threshold to 45%", () => {
    // Modest draw that bottoms out between 30% and 45%: critical for
    // lead-acid, merely deficit for LiFePO4.
    // Start 50%, drain ~1.1 kWh (≈23 pts) → ends ~27%... too deep; tune:
    // 46 W × 24 h = 1.1 kWh → 50% - 23% = 27%? Use 40 W → 0.96 kWh ≈ 20 pts.
    const { engine: la } = makeEngine({
      chemistry: "lead-acid",
      dcPowerW: 40,
      soc: 0.5,
    });
    la.runPrediction(dayForecast(0));
    const outlook = la.getEnergyOutlook();
    assert.strictEqual(outlook.criticalSoC, 0.45);
    // Ends ~30%: below 45% for lead-acid but above LiFePO4's 30%.
    assert.strictEqual(outlook.status, "critical");

    const { engine: li } = makeEngine({ dcPowerW: 40, soc: 0.5 });
    li.runPrediction(dayForecast(0));
    const liOutlook = li.getEnergyOutlook();
    assert.strictEqual(liOutlook.criticalSoC, 0.3);
    assert.notStrictEqual(liOutlook.status, "critical");
  });

  test("reports deficit when SoC is falling beyond the stable band", () => {
    // 40 W draw from 50%: ends ~20 points lower → deficit (LiFePO4 above).
    const { engine } = makeEngine({ dcPowerW: 40, soc: 0.5 });
    engine.runPrediction(dayForecast(0));
    const outlook = engine.getEnergyOutlook();
    assert.strictEqual(outlook.status, "deficit");
    assert.ok(outlook.endSoC < outlook.currentSoC - 0.05);
    // Net balance is negative and matches the SoC drop × capacity.
    assert.ok(outlook.net24hWh < 0, `net24hWh=${outlook.net24hWh}`);
    assert.strictEqual(
      outlook.net24hWh,
      Math.round((outlook.endSoC - outlook.currentSoC) * 4800),
    );
  });

  test("reports stable when SoC ends within 5 points of now", () => {
    // Tiny draw: 10 W × 24 h = 240 Wh = 5 pts exactly — use 8 W to stay
    // inside the band.
    const { engine } = makeEngine({ dcPowerW: 8, soc: 0.5 });
    engine.runPrediction(dayForecast(0));
    const outlook = engine.getEnergyOutlook();
    assert.strictEqual(outlook.status, "stable");
    assert.ok(Math.abs(outlook.endSoC - outlook.currentSoC) <= 0.05);
    // Stable → net balance near zero (within rounding of the small draw).
    assert.ok(
      Math.abs(outlook.net24hWh) <= 240,
      `net24hWh=${outlook.net24hWh}`,
    );
  });

  test("reports rising when production outpaces consumption", () => {
    // 300 Wp × 0.7 efficiency with decent sun from 40%: climbs well past
    // the 5-point band during daylight without reaching the 100% clamp
    // (~1.2 kWh over the day ≈ 25 points) — and stays above the 30%
    // critical threshold the whole time.
    const { engine } = makeEngine({ soc: 0.4, ghi: 500, capacityWp: 300 });
    engine.runPrediction(dayForecast(500));
    const outlook = engine.getEnergyOutlook();
    assert.strictEqual(outlook.status, "rising");
    assert.ok(outlook.endSoC > outlook.currentSoC + 0.05);
    assert.strictEqual(outlook.surplusWh, 0);
    // Rising without hitting the 100% clamp still reads as a positive
    // net balance — the whole point of the new path.
    assert.ok(outlook.net24hWh > 0, `net24hWh=${outlook.net24hWh}`);
    assert.strictEqual(
      outlook.net24hWh,
      Math.round((outlook.endSoC - outlook.currentSoC) * 4800),
    );
  });

  test("reports surplus when the 100% clamp curtails production", () => {
    // Full battery + strong sun: curtailed energy accumulates.
    const { engine } = makeEngine({ soc: 1.0, ghi: 500 });
    engine.runPrediction(dayForecast(500));
    const outlook = engine.getEnergyOutlook();
    assert.strictEqual(outlook.status, "surplus");
    assert.ok(outlook.surplusWh > 0, `surplus ${outlook.surplusWh} Wh`);
    assert.strictEqual(outlook.hours, 24);
    // Bank starts full and the clamp holds it at 100%, so the stored
    // energy doesn't change — net balance is ~0 even though curtailment
    // surplus is positive (reported separately at surplusWh).
    assert.strictEqual(outlook.net24hWh, 0);
  });

  test("critical outranks surplus", () => {
    // Full now, but heavy overnight draw first drags SoC below threshold
    // before solar refills: physics says warn. Night forecast (GHI 0) with
    // 400 W drain from 35% dips below 30% within a few hours.
    const { engine } = makeEngine({ soc: 0.35, dcPowerW: 400 });
    engine.runPrediction(dayForecast(0));
    const outlook = engine.getEnergyOutlook();
    assert.strictEqual(outlook.status, "critical");
  });
});

function makePublisher() {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test-plugin");
  return { app, pub };
}

test.describe("AdvisoryPublisher outlook/yield/gust deltas", () => {
  test("publishEnergyOutlook publishes the status string and net24hWh", () => {
    const { app, pub } = makePublisher();
    pub.publishEnergyOutlook({ status: "critical", net24hWh: -1200 });
    const call = app.handleMessageCalls.at(-1);
    const values = call.msg.updates[0].values;
    assert.strictEqual(
      values.find((v) => v.path === "electrical.energy.prediction.status")
        .value,
      "critical",
    );
    assert.strictEqual(
      values.find((v) => v.path === "electrical.energy.prediction.net").value,
      -1200,
    );
  });

  test("publishEnergyOutlook degrades to null/0 without a prediction", () => {
    const { app, pub } = makePublisher();
    pub.publishEnergyOutlook(null);
    const call = app.handleMessageCalls.at(-1);
    const values = call.msg.updates[0].values;
    assert.strictEqual(
      values.find((v) => v.path === "electrical.energy.prediction.status")
        .value,
      null,
    );
    assert.strictEqual(
      values.find((v) => v.path === "electrical.energy.prediction.net").value,
      0,
    );
  });

  test("publishForecastYield publishes rounded Wh totals", () => {
    const { app, pub } = makePublisher();
    pub.publishForecastYield(1234.6, 987.4);
    const values = app.handleMessageCalls.at(-1).msg.updates[0].values;
    assert.strictEqual(
      values.find(
        (v) => v.path === "electrical.energy.prediction.forecast.solar",
      ).value,
      1235,
    );
    assert.strictEqual(
      values.find(
        (v) => v.path === "electrical.energy.prediction.forecast.consumption",
      ).value,
      987,
    );
  });

  test("publishEnvironmentGust publishes m/s rounded to one decimal", () => {
    const { app, pub } = makePublisher();
    pub.publishEnvironmentGust(msFromKnots(22)); // ≈ 11.33 m/s
    const values = app.handleMessageCalls.at(-1).msg.updates[0].values;
    const gust = values.find((v) => v.path === "environment.wind.gust");
    assert.ok(gust, "environment.wind.gust published");
    assert.strictEqual(gust.value, 11.3);
  });

  test("publishEnvironmentGust degrades to null without samples", () => {
    const { app, pub } = makePublisher();
    pub.publishEnvironmentGust(null);
    const values = app.handleMessageCalls.at(-1).msg.updates[0].values;
    assert.strictEqual(
      values.find((v) => v.path === "environment.wind.gust").value,
      null,
    );
  });

  test("publishForecastStatus includes the validTo timestamp", () => {
    const { app, pub } = makePublisher();
    const validTo = new Date("2026-08-25T12:00:00Z");
    pub.publishForecastStatus("Open-Meteo", 24, validTo);
    const values = app.handleMessageCalls.at(-1).msg.updates[0].values;
    assert.strictEqual(
      values.find(
        (v) => v.path === "electrical.energy.prediction.weather.validTo",
      ).value,
      "2026-08-25T12:00:00.000Z",
    );
  });

  test("sendMeta covers the new paths with units", () => {
    const { app, pub } = makePublisher();
    pub.sendMeta([]);
    const metaCall = app.handleMessageCalls.find(
      (c) => c.msg.updates?.[0]?.meta,
    );
    const byPath = {};
    for (const m of metaCall.msg.updates[0].meta) byPath[m.path] = m.value;

    assert.strictEqual(
      byPath["electrical.energy.prediction.status"].displayName,
      "Energy outlook status",
    );
    assert.strictEqual(
      byPath["electrical.energy.prediction.weather.validTo"].units,
      "timestamp",
    );
    assert.strictEqual(
      byPath["electrical.energy.prediction.forecast.solar"].units,
      "Wh",
    );
    assert.strictEqual(
      byPath["electrical.energy.prediction.forecast.consumption"].units,
      "Wh",
    );
    assert.strictEqual(byPath["electrical.energy.prediction.net"].units, "Wh");
    assert.strictEqual(
      byPath["electrical.energy.prediction.net"].displayName,
      "Net energy balance 24h",
    );
    assert.strictEqual(byPath["environment.wind.gust"].units, "m/s");
  });
});
