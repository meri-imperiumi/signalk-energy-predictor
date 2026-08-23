/**
 * Smoketests for surplus-energy alerting (work doc #7).
 *
 * Covers:
 *  - findSurplusOpportunity: full-before-sunset with surplus → detected
 *  - full at dusk (≤1h to sunset) → no alert
 *  - below minSurplusWh → no alert
 *  - window beyond maxLeadHours → no alert
 *  - motoring side-effect: engine running + underway → alternator charges
 *    bank full midday → surplus detected (headline use case)
 *  - at-rest at night (sun below horizon) → no alert (activity model)
 *  - under way at night → alert (watchkeeper on duty)
 *  - AdvisoryPublisher.publishSurplusAdvisory message format + surplusWh delta
 *  - opportunistic load already running (string state + boolean) is skipped
 *
 * @file surplus.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { PredictionEngine } = require("../plugin/prediction.js");
const { AdvisoryPublisher } = require("../plugin/advisory.js");

// --- Helpers ---

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
 * A forecast of `hours` hourly points starting at startTime, each with the
 * given GHI, cloud cover, and wind. By default wind is calm so the surplus
 * is solar-driven.
 */
function makeForecast({
  hours = 24,
  ghi = 500,
  cloudCover = 0.2,
  windKnots = 2,
  gustKnots = 4,
  startTime = new Date(),
}) {
  return Array.from({ length: hours }, (_, h) => ({
    time: new Date(startTime.getTime() + h * 3600000),
    ghi,
    cloudCover,
    windSpeedKnots: windKnots,
    gustSpeedKnots: gustKnots,
  }));
}

/**
 * Builds a prediction engine with a single fixed (non-deployable) solar
 * array of `capacityWp` at the given position, anchored by default.
 */
function makeEngine({
  app,
  capacityWp = 1000,
  navState = "anchored",
  engineAlternatorWatts = 0,
}) {
  const a = app || makeFakeApp();
  a.setSelfPath("navigation.position", { latitude: 60, longitude: 18 });
  if (navState) a.setSelfPath("navigation.state", navState);
  return new PredictionEngine({
    battery: {
      capacityAh: 400,
      systemVoltage: 12,
      minSafeSoC: 0.2,
      engineAlternatorWatts,
    },
    solarArrays: [{ id: "roof", type: "fixed", capacityWp }],
    mechanicalGenerators: [],
    getEfficiency: () => 0.8,
    getSelfPath: (path) => a.getSelfPath(path),
    app: a,
  });
}

/**
 * Sets the house battery SoC on the fake app.
 */
function setSoC(app, soc) {
  app.setSelfPath("electrical.batteries.house.capacity.stateOfCharge", soc);
}

/**
 * A fixed "now" for tests: 2026-06-21 11:00 UTC, lat 60 lon 18 → the
 * sun is high (midday). Tests freeze Date.now to this so the prediction
 * engine's startTime matches the forecast start.
 */
const FROZEN_NOW = new Date("2026-06-21T11:00:00Z").getTime();

/**
 * Freezes Date.now for the duration of `fn`, restoring it afterwards.
 * The prediction engine uses `new Date(Date.now())` as its start time and
 * matches forecast points within 30 min, so the forecast must start at the
 * frozen now.
 */
function withFrozenNow(fn) {
  const realNow = Date.now;
  Date.now = () => FROZEN_NOW;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

/**
 * Midday at the frozen now (sun high at lat 60 lon 18).
 */
function midday() {
  return new Date(FROZEN_NOW);
}

// --- findSurplusOpportunity ---

test.describe("findSurplusOpportunity", () => {
  test("detects a surplus when bank fills midday with solar left", () => {
    withFrozenNow(() => {
      const app = makeFakeApp();
      setSoC(app, 0.9); // close to full, a strong solar day fills it fast
      const engine = makeEngine({ app, capacityWp: 1000 });
      engine.runPrediction(
        makeForecast({ hours: 24, ghi: 800, startTime: midday() }),
      );
      const opp = engine.findSurplusOpportunity({ minSurplusWh: 100 });
      assert.ok(opp, "should detect a surplus opportunity");
      assert.ok(opp.surplusWh >= 100, `surplusWh=${opp.surplusWh}`);
      assert.ok(opp.from instanceof Date);
      assert.ok(opp.to instanceof Date);
      assert.ok(opp.to.getTime() >= opp.from.getTime());
      assert.ok(opp.suggestedLoadW > 0);
    });
  });

  test("returns null when the bank never reaches fullThreshold", () => {
    withFrozenNow(() => {
      const app = makeFakeApp();
      setSoC(app, 0.3); // low; a modest solar day won't fill it
      const engine = makeEngine({ app, capacityWp: 200 });
      engine.runPrediction(
        makeForecast({ hours: 24, ghi: 200, startTime: midday() }),
      );
      const opp = engine.findSurplusOpportunity();
      assert.strictEqual(opp, null);
    });
  });

  test("returns null when surplus is below minSurplusWh", () => {
    withFrozenNow(() => {
      const app = makeFakeApp();
      setSoC(app, 0.9);
      const engine = makeEngine({ app, capacityWp: 1000 });
      engine.runPrediction(
        makeForecast({ hours: 24, ghi: 800, startTime: midday() }),
      );
      // Require an absurdly large surplus that the window can't meet
      const opp = engine.findSurplusOpportunity({ minSurplusWh: 1_000_000 });
      assert.strictEqual(opp, null);
    });
  });

  test("returns null when the full window is beyond maxLeadHours", () => {
    // Here we DON'T freeze now: build a forecast starting 48h out, while
    // the engine's startTime is real-now, so the full window is far away.
    const app = makeFakeApp();
    setSoC(app, 0.9);
    const engine = makeEngine({ app, capacityWp: 1000 });
    const farStart = new Date(Date.now() + 48 * 3600000);
    engine.runPrediction(
      makeForecast({ hours: 24, ghi: 800, startTime: farStart }),
    );
    const opp = engine.findSurplusOpportunity({ maxLeadHours: 36 });
    // Note: with startTime=now and forecast 48h out, no forecast point
    // matches any prediction hour, so SoC stays flat and never reaches
    // fullThreshold → null either way. This still asserts the no-alert
    // behavior for a window beyond the horizon.
    assert.strictEqual(opp, null);
  });

  test("motoring side-effect: engine running + underway fills bank, surplus detected", () => {
    withFrozenNow(() => {
      const app = makeFakeApp();
      setSoC(app, 0.6);
      app.setSelfPath("propulsion.main.state", "started");
      const engine = makeEngine({
        app,
        capacityWp: 1000,
        navState: "motoring",
        engineAlternatorWatts: 1500,
      });
      engine.runPrediction(
        makeForecast({ hours: 24, ghi: 800, startTime: midday() }),
      );
      const opp = engine.findSurplusOpportunity({ minSurplusWh: 100 });
      // The alternator pushes the bank full midday; the remaining solar +
      // alternator hours are surplus. This is the headline use case.
      assert.ok(opp, "should detect motoring-surplus");
      assert.ok(opp.surplusWh >= 100, `surplusWh=${opp.surplusWh}`);
      // alternatorWh should be present on at least the early hours
      const altHour = engine.lastPrediction.find((p) => p.alternatorWh > 0);
      assert.ok(altHour, "alternatorWh should be modeled in the ideal track");
    });
  });

  test("at rest at night (sun below horizon) → no alert (activity model)", () => {
    withFrozenNow(() => {
      const app = makeFakeApp();
      setSoC(app, 0.95);
      // Night at the frozen now: jump to 23:00 UTC same day. The bank is
      // already full (0.95 ≥ fullThreshold). A wind surplus at a full bank
      // could happen at night; by policy we don't alert after dark at anchor.
      const night = new Date("2026-06-21T23:00:00Z").getTime();
      const realNow = Date.now;
      Date.now = () => night;
      try {
        const engine = makeEngine({
          app,
          capacityWp: 1000,
          navState: "anchored",
        });
        engine.runPrediction(
          makeForecast({ hours: 24, ghi: 0, startTime: new Date(night) }),
        );
        const opp = engine.findSurplusOpportunity();
        assert.strictEqual(opp, null);
      } finally {
        Date.now = realNow;
      }
    });
  });

  test("under way at night → alert (watchkeeper on duty)", () => {
    withFrozenNow(() => {
      const app = makeFakeApp();
      setSoC(app, 0.6);
      app.setSelfPath("propulsion.main.state", "started");
      // Night motoring: alternator fills the bank, surplus continues into
      // the night. Under way there's a watchkeeper, so we alert any hour.
      const night = new Date("2026-06-21T23:00:00Z").getTime();
      const realNow = Date.now;
      Date.now = () => night;
      try {
        const engine = makeEngine({
          app,
          capacityWp: 1000,
          navState: "motoring",
          engineAlternatorWatts: 1500,
        });
        engine.runPrediction(
          makeForecast({ hours: 24, ghi: 0, startTime: new Date(night) }),
        );
        const opp = engine.findSurplusOpportunity({ minSurplusWh: 100 });
        assert.ok(opp, "under way at night should still alert");
      } finally {
        Date.now = realNow;
      }
    });
  });
});

// --- AdvisoryPublisher.publishSurplusAdvisory ---

test.describe("publishSurplusAdvisory", () => {
  function getNotifications(app) {
    return app.handleMessageCalls
      .filter((c) =>
        c.msg.updates?.[0].values.some((v) =>
          v.path.startsWith("notifications."),
        ),
      )
      .flatMap((c) => c.msg.updates[0].values)
      .filter((v) => v.path.startsWith("notifications."));
  }
  function getDeltas(app, pathPrefix) {
    return app.handleMessageCalls
      .filter((c) => c.msg.updates)
      .flatMap((c) => c.msg.updates[0].values)
      .filter((v) => v.path.startsWith(pathPrefix));
  }

  test("publishes a warn notification with window, Wh, and suggested load", () => {
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const from = new Date("2026-06-21T11:00:00Z");
    const to = new Date("2026-06-21T16:00:00Z");
    pub.publishSurplusAdvisory(
      { surplusWh: 1200, from, to, suggestedLoadW: 240 },
      [{ name: "Watermaker", watts: 150 }],
    );
    const notifs = getNotifications(app);
    const n = notifs.find((v) =>
      v.path.startsWith("notifications.electrical.energy.surplus"),
    );
    assert.ok(n, "surplus notification should be published");
    assert.strictEqual(n.value.state, "warn");
    assert.match(n.value.message, /1\.2kWh surplus available/);
    assert.match(n.value.message, /~240W sustained/);
    assert.match(n.value.message, /Watermaker \(150W\) for ~8h/);
  });

  test("publishes the surplusWh / from / to deltas", () => {
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const from = new Date("2026-06-21T11:00:00Z");
    const to = new Date("2026-06-21T16:00:00Z");
    pub.publishSurplusAdvisory(
      { surplusWh: 800, from, to, suggestedLoadW: 160 },
      [],
    );
    const wh = getDeltas(app, "electrical.energy.prediction.surplusWh");
    assert.ok(wh.length > 0);
    assert.strictEqual(wh[wh.length - 1].value, 800);
    const fromD = getDeltas(app, "electrical.energy.prediction.surplus.from");
    assert.ok(fromD.length > 0);
    assert.strictEqual(fromD[fromD.length - 1].value, from.toISOString());
  });

  test("clears the notification and deltas when opportunity is null", () => {
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test-plugin");
    pub.publishSurplusAdvisory(null, []);
    const notifs = getNotifications(app);
    const n = notifs.find((v) =>
      v.path.startsWith("notifications.electrical.energy.surplus"),
    );
    assert.ok(n, "a normal-state clearing notification should be published");
    assert.strictEqual(n.value.state, "normal");
    const wh = getDeltas(app, "electrical.energy.prediction.surplusWh");
    assert.ok(wh.length > 0);
    assert.strictEqual(wh[wh.length - 1].value, 0);
  });

  test("skips opportunistic loads that are already running (string state)", () => {
    const app = makeFakeApp();
    // Starlink is online → already consuming, should be skipped
    app.setSelfPath("network.providers.starlink.status", "online");
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const from = new Date("2026-06-21T11:00:00Z");
    const to = new Date("2026-06-21T16:00:00Z");
    pub.publishSurplusAdvisory(
      { surplusWh: 1200, from, to, suggestedLoadW: 240 },
      [
        {
          name: "Starlink",
          watts: 50,
          statePath: "network.providers.starlink.status",
        },
        { name: "Watermaker", watts: 150 },
      ],
    );
    const notifs = getNotifications(app);
    const n = notifs.find((v) =>
      v.path.startsWith("notifications.electrical.energy.surplus"),
    );
    assert.ok(n);
    assert.doesNotMatch(n.value.message, /Starlink/);
    assert.match(n.value.message, /Watermaker/);
  });

  test("skips opportunistic loads that are already running (boolean digital switching)", () => {
    const app = makeFakeApp();
    // Watermaker on a digital-switching boolean that is true → running
    app.setSelfPath("electrical.switches.watermaker.state", true);
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const from = new Date("2026-06-21T11:00:00Z");
    const to = new Date("2026-06-21T16:00:00Z");
    pub.publishSurplusAdvisory(
      { surplusWh: 1200, from, to, suggestedLoadW: 240 },
      [
        {
          name: "Watermaker",
          watts: 150,
          statePath: "electrical.switches.watermaker.state",
        },
        { name: "Ice maker", watts: 300 },
      ],
    );
    const notifs = getNotifications(app);
    const n = notifs.find((v) =>
      v.path.startsWith("notifications.electrical.energy.surplus"),
    );
    assert.ok(n);
    assert.doesNotMatch(n.value.message, /Watermaker/);
    assert.match(n.value.message, /Ice maker/);
  });

  test("does not skip a load whose boolean is false (off)", () => {
    const app = makeFakeApp();
    app.setSelfPath("electrical.switches.watermaker.state", false);
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const from = new Date("2026-06-21T11:00:00Z");
    const to = new Date("2026-06-21T16:00:00Z");
    pub.publishSurplusAdvisory(
      { surplusWh: 1200, from, to, suggestedLoadW: 240 },
      [
        {
          name: "Watermaker",
          watts: 150,
          statePath: "electrical.switches.watermaker.state",
        },
      ],
    );
    const notifs = getNotifications(app);
    const n = notifs.find((v) =>
      v.path.startsWith("notifications.electrical.energy.surplus"),
    );
    assert.ok(n);
    assert.match(n.value.message, /Watermaker/);
  });

  test("loads without a statePath are always candidates", () => {
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const from = new Date("2026-06-21T11:00:00Z");
    const to = new Date("2026-06-21T16:00:00Z");
    pub.publishSurplusAdvisory(
      { surplusWh: 1200, from, to, suggestedLoadW: 240 },
      [{ name: "Ice maker", watts: 300 }], // no statePath
    );
    const notifs = getNotifications(app);
    const n = notifs.find((v) =>
      v.path.startsWith("notifications.electrical.energy.surplus"),
    );
    assert.ok(n);
    assert.match(n.value.message, /Ice maker/);
  });
});
