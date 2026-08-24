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
    },
    solarArrays: [{ id: "roof", type: "fixed", capacityWp }],
    mechanicalGenerators: [],
    engines: [{ id: "main", alternatorWatts: engineAlternatorWatts }],
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

  test("does not count next-day refill of an overnight drawdown as surplus", () => {
    // The bank fills midday day 1, discharges overnight, then solar refills
    // it day 2. Only energy produced *while the bank is full* is curtailed
    // surplus; the day-2 solar is refilling the drawdown, not being
    // wasted. The old per-hour max(0, net) sum double-counted the refill
    // and stretched the window across the overnight gap into day 2.
    //
    // We inject a synthetic lastPrediction so the track is exact and the
    // assertion is deterministic (independent of the solar model).
    withFrozenNow(() => {
      const app = makeFakeApp();
      setSoC(app, 0.9);
      const engine = makeEngine({ app, capacityWp: 1000 });
      engine.capacityWh = 400 * 12;
      const start = midday(); // 2026-06-21 11:00 UTC, lat 60 → sun up
      // Hours: 0–4 fill+curtail (bank hits full ~h2), 5–14 overnight
      // drawdown (net negative), 15–23 day-2 solar that refills most of
      // the drawdown but never re-fills to full (SoC peaks ~0.95), so
      // none of day-2 solar is curtailed. The old code summed every
      // net-positive hour and reported day-2 solar as surplus too.
      const track = [
        // [idealSoC, solarWh, houseWh]  (wind/hydro/alt all 0, moored)
        [0.9, 300, 100],
        [0.96, 300, 100],
        [1.0, 300, 100],
        [1.0, 300, 100],
        [1.0, 300, 100],
        [0.98, 0, 100],
        [0.95, 0, 100],
        [0.92, 0, 100],
        [0.89, 0, 100],
        [0.86, 0, 100],
        [0.83, 0, 100],
        [0.8, 0, 100],
        [0.77, 0, 100],
        [0.74, 0, 100],
        [0.71, 0, 100],
        [0.71, 150, 100],
        [0.74, 150, 100],
        [0.77, 150, 100],
        [0.8, 150, 100],
        [0.83, 150, 100],
        [0.86, 150, 100],
        [0.89, 150, 100],
        [0.92, 150, 100],
        [0.94, 150, 100],
        [0.95, 150, 100],
      ];
      engine.lastPrediction = track.map((r, h) => ({
        hour: h,
        time: new Date(start.getTime() + h * 3600000),
        idealSoC: r[0],
        idealSolarYieldWh: r[1],
        idealWindYieldWh: 0,
        idealHydroYieldWh: 0,
        alternatorWh: 0,
        houseLoadWh: r[2],
      }));

      const opp = engine.findSurplusOpportunity({ minSurplusWh: 100 });
      assert.ok(opp, "should detect the day-1 curtailment surplus");
      // The window must end on day 1 (before the overnight drawdown),
      // not stretch into day 2's refill. Hour 4 is the last day-1
      // curtailment hour; the drawdown starts at h5 and day-2 solar never
      // re-fills the bank, so there is no second curtailment window.
      assert.ok(
        opp.to.getTime() <= new Date(start.getTime() + 5 * 3600000).getTime(),
        `window to (${opp.to.toISOString()}) must not cross into the overnight drawdown`,
      );
      // Day-1 curtailment is h2–4 ≈ 600 Wh. Day-2 solar (h15–23, ~900 Wh
      // net positive) must NOT be in the surplus total — it's refilling
      // the overnight drawdown (SoC peaks at 0.95, never full). Cap the
      // asserted surplus well below the refill magnitude to prove the
      // refill isn't counted.
      assert.ok(
        opp.surplusWh < 700,
        `surplusWh=${opp.surplusWh} should exclude the ~900Wh day-2 refill`,
      );
      assert.ok(opp.surplusWh >= 100, `surplusWh=${opp.surplusWh}`);
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

  test("publishes a warn notification with window and Wh amount", () => {
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test-plugin");
    // Window starting ~1h out lands at medium urgency (warn) regardless of
    // when the test runs; older fixed dates made this date-dependent.
    const from = new Date(Date.now() + 60 * 60 * 1000);
    const to = new Date(Date.now() + 6 * 60 * 60 * 1000);
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
    // Consumption suggestions are no longer part of the notification — it
    // just reports when the surplus happens and how much there is.
    assert.doesNotMatch(n.value.message, /Watermaker/);
  });

  test("marks the end time when the surplus window spans midnight", () => {
    // A 26h window (14:46 today → 16:46 tomorrow) must not render as the
    // ambiguous `14:46-16:46` (reads as a 2h same-day span and makes the
    // Wh/W math look impossible).
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test-plugin");
    const from = new Date(Date.now() + 60 * 60 * 1000);
    from.setHours(14, 46, 0, 0);
    const to = new Date(from.getTime() + 26 * 60 * 60 * 1000);
    pub.publishSurplusAdvisory(
      { surplusWh: 1900, from, to, suggestedLoadW: 70 },
      [],
    );
    const notifs = getNotifications(app);
    const n = notifs.find((v) =>
      v.path.startsWith("notifications.electrical.energy.surplus"),
    );
    assert.ok(n);
    assert.match(
      n.value.message,
      /16:46\+1/,
      "tomorrow endpoint should carry a +1 day marker",
    );
    assert.doesNotMatch(
      n.value.message,
      /14:46-16:46 \(/,
      "must not render as a plain same-day 2h span",
    );
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

  test("no longer mentions opportunistic loads (string state)", () => {
    const app = makeFakeApp();
    // Starlink is online — irrelevant now, the message never names loads.
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
    assert.doesNotMatch(n.value.message, /Watermaker/);
  });

  test("no longer mentions opportunistic loads (boolean digital switching)", () => {
    const app = makeFakeApp();
    // Watermaker on a digital-switching boolean that is true — irrelevant
    // now, the message never names loads.
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
    assert.doesNotMatch(n.value.message, /Ice maker/);
  });

  test("no longer mentions a load whose boolean is false (off)", () => {
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
    assert.doesNotMatch(n.value.message, /Watermaker/);
  });

  test("no longer mentions loads without a statePath", () => {
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
    assert.doesNotMatch(n.value.message, /Ice maker/);
  });
});
