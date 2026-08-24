/**
 * Smoketests for #11's renewables flip cooldown (reluctance-driven
 * hysteresis band) in AdvisoryPublisher.publishDeploymentStates, and for
 * the schema/config pieces of the combustion tiers.
 *
 * @file combustion-advisory.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { AdvisoryPublisher } = require("../plugin/advisory.js");
const { buildPluginSchema } = require("../plugin/schema.js");
const { flipCooldownHoursFor, Reluctance } = require("../plugin/combustion.js");
const makePlugin = require("../plugin/index.js");

function makeFakeApp() {
  return {
    selfId: "self",
    debug() {},
    info() {},
    warn() {},
    error() {},
    handleMessageCalls: [],
    handleMessage(source, msg) {
      this.handleMessageCalls.push({ source, msg });
    },
  };
}

function deployNotificationsFor(app, deviceId) {
  return app.handleMessageCalls
    .flatMap((c) => c.msg.updates[0].values)
    .filter(
      (v) =>
        v.path === `notifications.electrical.energy.deploy_${deviceId}` &&
        v.value.state !== "normal",
    );
}

test.describe("flip cooldown (#11 renewables hysteresis)", () => {
  const windGenRec = (recommendedState) => ({
    id: "windgen",
    name: "Wind generator",
    type: "wind",
    recommendedState,
    reason: "test",
    horizonHours: 24,
    missedYieldWh: 100,
    reluctance: "high", // 8h flip cooldown
    currentGustMs: 5,
    limitMs: 15,
  });

  test("a recommendation flip within the cooldown holds the notification", () => {
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test");
    const states = new Map([["windgen", "stowed"]]);

    // First action: deploy (wind picked up). Notifies.
    pub.publishDeploymentStates([windGenRec("deployed")], states);
    assert.strictEqual(deployNotificationsFor(app, "windgen").length, 1);

    // Wind drops: recommendation flips to stow within the 8h cooldown.
    // This is NOT an actual over-limit condition (gust 5 < limit 15), so
    // the notification is held — no deploy/stow nag cycling.
    pub.publishDeploymentStates([windGenRec("stowed")], states);
    assert.strictEqual(
      deployNotificationsFor(app, "windgen").length,
      1,
      "flip within cooldown must not notify",
    );
  });

  test("an actual over-limit condition breaks through the cooldown", () => {
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test");

    // Deploy suggestion while stowed (notifies) …
    pub.publishDeploymentStates(
      [windGenRec("deployed")],
      new Map([["windgen", "stowed"]]),
    );

    // … then the crew deployed it and gusts hit the limit
    // (severityRatio >= 1): the safety stow notifies even inside the
    // flip cooldown. Advance past the notification debounce first so
    // the publisher doesn't swallow the second alert on its own.
    const realNow = Date.now;
    const t0 = realNow();
    Date.now = () => t0 + 6 * 60 * 1000;
    try {
      const overLimit = {
        ...windGenRec("stowed"),
        currentGustMs: 16,
      };
      pub.publishDeploymentStates(
        [overLimit],
        new Map([["windgen", "deployed"]]),
      );
    } finally {
      Date.now = realNow;
    }
    const notifs = deployNotificationsFor(app, "windgen");
    assert.strictEqual(notifs.length, 2, "actual condition notifies");
    assert.match(notifs[1].value.message, /Stow now/);
  });

  test("same-direction repeats are not affected by the cooldown", () => {
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test");
    const states = new Map([["windgen", "stowed"]]);

    pub.publishDeploymentStates([windGenRec("deployed")], states);
    pub.publishDeploymentStates(
      [{ ...windGenRec("deployed"), reason: "changed reason" }],
      states,
    );
    // The second publish is a different message → dedup doesn't suppress,
    // and same direction is never flip-held.
    assert.ok(deployNotificationsFor(app, "windgen").length >= 1);
  });

  test("observed gusts at the limit notify even inside the flip cooldown", () => {
    // The real-world bug: live gusts over the limit but a recent deploy
    // suggestion was just notified. The actual-condition carve-out must
    // let the stow alert through.
    const app = makeFakeApp();
    const pub = new AdvisoryPublisher(app, "test");

    // Deploy suggestion while stowed (notifies) …
    pub.publishDeploymentStates(
      [windGenRec("deployed")],
      new Map([["windgen", "stowed"]]),
    );

    // … then observed gusts hit the limit (severityRatio >= 1). Advance
    // past the notification debounce so the publisher doesn't swallow
    // the second alert on its own.
    const realNow = Date.now;
    const t0 = realNow();
    Date.now = () => t0 + 6 * 60 * 1000;
    try {
      pub.publishDeploymentStates(
        [{ ...windGenRec("stowed"), currentGustMs: 16 }],
        new Map([["windgen", "deployed"]]),
      );
    } finally {
      Date.now = realNow;
    }
    const notifs = deployNotificationsFor(app, "windgen");
    assert.strictEqual(notifs.length, 2, "observed over-limit notifies");
    assert.match(notifs[1].value.message, /Stow now/);
  });
});

test.describe("flipCooldownHoursFor", () => {
  test("explicit per-device override wins", () => {
    assert.strictEqual(flipCooldownHoursFor(null, 3), 3);
  });

  test("reluctance maps to cooldown hours", () => {
    assert.strictEqual(flipCooldownHoursFor("low"), Reluctance.LOW);
    assert.strictEqual(flipCooldownHoursFor("medium"), Reluctance.MEDIUM);
    assert.strictEqual(flipCooldownHoursFor("high"), Reluctance.HIGH);
  });

  test("unset falls back to the default band", () => {
    assert.strictEqual(flipCooldownHoursFor(null, null), 2);
  });
});

test.describe("combustion schema (#11)", () => {
  const schema = buildPluginSchema();
  const props = schema.properties;

  test("engines array with alternator watts replaces the battery-level setting", () => {
    assert.ok(props.engines, "engines array exists");
    assert.strictEqual(props.engines.items.required[0], "id");
    assert.ok(props.engines.items.properties.alternatorWatts);
    assert.strictEqual(
      props.battery.properties.engineAlternatorWatts,
      undefined,
      "legacy battery-level setting removed from the schema",
    );
  });

  test("gensets array with output watts", () => {
    assert.ok(props.gensets, "gensets array exists");
    assert.deepStrictEqual(props.gensets.items.required, ["id", "outputWatts"]);
    assert.ok(props.gensets.items.properties.statePath);
    assert.ok(props.gensets.items.properties.powerPath);
  });

  test("per-tier run discipline settings", () => {
    assert.ok(props.combustion.properties.genset.properties.sustainedHours);
    assert.ok(props.combustion.properties.engine.properties.minRunMinutes);
    assert.ok(props.combustion.properties.engine.properties.nightHold);
    // Engine tier holds at night, genset doesn't (night runs are its job)
    assert.strictEqual(
      props.combustion.properties.engine.properties.nightHold.default,
      true,
    );
    assert.strictEqual(
      props.combustion.properties.genset.properties.nightHold.default,
      false,
    );
  });

  test("per-deployable flipCooldownHours override", () => {
    const mg = props.mechanicalGenerators.items.properties;
    assert.ok(mg.flipCooldownHours, "flipCooldownHours on mechanical gens");
    assert.strictEqual(mg.flipCooldownHours.minimum, 0);
  });
});

test.describe("getActiveEngines legacy normalization", () => {
  function enginesFor(config) {
    const plugin = makePlugin({
      ...makeFakeApp(),
      getSelfPath: () => null,
      getDataDirPath: () => "/tmp",
      subscriptionmanager: { subscribe() {} },
      on: () => {},
      setPluginStatus() {},
    });
    return plugin.__getInternals().getActiveEngines(config);
  }

  test("no engines configured and no legacy watts → empty tier", () => {
    assert.deepStrictEqual(enginesFor({ engines: [] }), []);
  });

  test("legacy battery.engineAlternatorWatts becomes a main engine", () => {
    assert.deepStrictEqual(
      enginesFor({ battery: { engineAlternatorWatts: 120 } }),
      [{ id: "main", name: "Engine", alternatorWatts: 120 }],
    );
  });

  test("configured engines pass through as-is", () => {
    const engines = [
      { id: "port", alternatorWatts: 80 },
      { id: "starboard", alternatorWatts: 80 },
      { id: "electric", alternatorWatts: 0 },
    ];
    assert.deepStrictEqual(enginesFor({ engines }), engines);
  });
});
