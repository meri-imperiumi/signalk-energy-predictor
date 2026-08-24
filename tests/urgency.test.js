/**
 * Smoketests for the urgency calculation module and the urgency-aware
 * notification state/method mapping.
 * @file urgency.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateUrgency,
  urgencyToNotification,
  Urgency,
  StateConfidence,
  Reluctance,
  URGENCY_TO_SK,
  DEFAULT_CONFIG,
  mergeConfig,
} = require("../plugin/urgency.js");
const { AdvisoryPublisher } = require("../plugin/advisory.js");

test("URGENCY_TO_SK maps levels to SK states and methods", () => {
  assert.deepStrictEqual(URGENCY_TO_SK[Urgency.NORMAL], {
    state: "normal",
    methods: [],
  });
  assert.deepStrictEqual(URGENCY_TO_SK[Urgency.MEDIUM], {
    state: "warn",
    methods: ["visual", "sound"],
  });
  assert.deepStrictEqual(URGENCY_TO_SK[Urgency.ALARM], {
    state: "alarm",
    methods: ["visual", "sound"],
  });
});

test("Reluctance enum encodes minimum good-output hours", () => {
  assert.strictEqual(Reluctance.LOW, 1, "low = 1h");
  assert.strictEqual(Reluctance.MEDIUM, 2, "medium = 2h");
  assert.strictEqual(Reluctance.HIGH, 8, "high = 8h");
});

test("calculateUrgency: reluctance accepts string keys (low/medium/high) and numeric hours", () => {
  // The config schema exposes reluctance as a pulldown storing "low"/
  // "medium"/"high". A 3h window for a wind gen (default 8h) caps at low
  // whether the override is a string key or a number of hours.
  const base = {
    advisoryType: "deployable",
    severityRatio: 2.0,
    timeToActionHours: 0,
    isActual: false,
    detectedState: "stowed",
    recommendedState: "deployed",
    stateConfidence: StateConfidence.HIGH,
    deployableType: "wind",
    eventDurationMinutes: 180, // 3h
  };
  const viaStringLow = calculateUrgency({ ...base, reluctance: "low" });
  const viaNumber1 = calculateUrgency({ ...base, reluctance: 1 });
  const viaStringHigh = calculateUrgency({ ...base, reluctance: "high" });
  assert.strictEqual(
    viaStringLow,
    Urgency.HIGH,
    "low (1h): 3h window reaches high",
  );
  assert.strictEqual(
    viaNumber1,
    Urgency.HIGH,
    "1 (hours): 3h window reaches high",
  );
  assert.strictEqual(
    viaStringHigh,
    Urgency.LOW,
    "high (8h): 3h window caps at low",
  );
});

test("calculateUrgency: confident stowed + stow recommendation is normal (already safe)", () => {
  const u = calculateUrgency({
    severityRatio: 2.0, // well over the limit
    timeToActionHours: 0,
    isActual: true,
    advisoryType: "deployable",
    detectedState: "stowed",
    recommendedState: "stowed",
    stateConfidence: StateConfidence.HIGH,
    deployableType: "wind",
  });
  assert.strictEqual(u, Urgency.NORMAL);
});

test("calculateUrgency: medium-confidence stowed + stow recommendation is also normal", () => {
  const u = calculateUrgency({
    severityRatio: 2.0,
    timeToActionHours: 0,
    isActual: true,
    advisoryType: "deployable",
    detectedState: "stowed",
    recommendedState: "stowed",
    stateConfidence: StateConfidence.MEDIUM,
    deployableType: "wind",
  });
  assert.strictEqual(u, Urgency.NORMAL);
});

test("calculateUrgency: stowed + deploy recommendation is NOT normal (missing yield)", () => {
  // A deploy recommendation when stowed is an activity suggestion — the
  // crew is missing yield — so it should still warrant urgency, unlike the
  // "already safe" stow-when-stowed case.
  const u = calculateUrgency({
    severityRatio: 0.2, // below limit, but deploy is recommended
    timeToActionHours: 2,
    isActual: false,
    advisoryType: "deployable",
    detectedState: "stowed",
    recommendedState: "deployed",
    stateConfidence: StateConfidence.HIGH,
    deployableType: "wind",
  });
  assert.notStrictEqual(
    u,
    Urgency.NORMAL,
    "deploy-when-stowed should not be no-op",
  );
});

test("calculateUrgency: deployed with high confidence, sustained over-limit reaches high", () => {
  const u = calculateUrgency({
    severityRatio: 2.0, // intensity log2(2) = 1.0
    timeToActionHours: 0, // act now
    isActual: true,
    advisoryType: "deployable",
    detectedState: "deployed",
    stateConfidence: StateConfidence.HIGH,
    deployableType: "solar-deployable",
    eventDurationMinutes: 30, // sustained
  });
  // score = (1*0.4 + 1*0.6) * 1.2 * 1.0 * 1.0 = 1.2 → capped at HIGH
  assert.strictEqual(u, Urgency.HIGH);
});

test("calculateUrgency: deployed never reaches alarm (deployable cap)", () => {
  const u = calculateUrgency({
    severityRatio: 8.0, // extreme intensity
    timeToActionHours: 0,
    isActual: true,
    advisoryType: "deployable",
    detectedState: "deployed",
    stateConfidence: StateConfidence.NONE, // max confidence boost
    deployableType: "wind",
    eventDurationMinutes: 30,
  });
  assert.strictEqual(u, Urgency.HIGH, "deployables cap at high, not alarm");
});

test("calculateUrgency: battery (engine) can reach alarm", () => {
  const u = calculateUrgency({
    advisoryType: "engine",
    batterySoC: 0.05, // below alarm tier
    timeToActionHours: 0.5,
    isActual: false,
  });
  assert.strictEqual(u, Urgency.ALARM);
});

test("calculateUrgency: battery at moderate SoC stays below alarm", () => {
  const u = calculateUrgency({
    advisoryType: "engine",
    batterySoC: 0.55, // above low tier (0.5), below info (0.65)
    timeToActionHours: 6,
    isActual: false,
  });
  assert.ok(
    [Urgency.INFO, Urgency.LOW, Urgency.NORMAL].includes(u),
    `expected at most low, got ${u}`,
  );
});

test("calculateUrgency: transient actual event caps at info", () => {
  const u = calculateUrgency({
    severityRatio: 4.0,
    timeToActionHours: 0,
    isActual: true,
    advisoryType: "deployable",
    detectedState: "deployed",
    stateConfidence: StateConfidence.HIGH,
    deployableType: "wind",
    eventDurationMinutes: 1, // < 2 min transient
  });
  assert.strictEqual(u, Urgency.INFO);
});

test("calculateUrgency: lower confidence boosts urgency for deployed", () => {
  const base = {
    severityRatio: 1.5,
    timeToActionHours: 2,
    isActual: true,
    advisoryType: "deployable",
    detectedState: "deployed",
    deployableType: "solar-deployable",
    eventDurationMinutes: 30,
  };
  const high = calculateUrgency({
    ...base,
    stateConfidence: StateConfidence.HIGH,
  });
  const none = calculateUrgency({
    ...base,
    stateConfidence: StateConfidence.NONE,
  });
  assert.ok(
    none !== Urgency.NORMAL,
    "none-confidence should not be normal for a deployed device",
  );
  // NONE has a higher confidence factor (1.3) than HIGH (1.0), so its score
  // is higher → urgency is at least as high.
  assert.ok(
    URGENCY_ORDER_INDEX(none) >= URGENCY_ORDER_INDEX(high),
    `none (${none}) should be >= high (${high})`,
  );
});

test("calculateUrgency: per-device reluctance (hours) overrides type default for deploy suggestions", () => {
  // Reluctance is now the minimum good-output hours to justify deploy.
  // A per-device override ("low"/"medium"/"high" or a number of hours)
  // takes precedence over the type default. Here a wind generator
  // (default 8h) overridden to "low" (1h) should let a 2h window reach
  // high, while the type default (8h) caps the same 2h window at low.
  const base = {
    advisoryType: "deployable",
    severityRatio: 2.0,
    timeToActionHours: 0,
    isActual: false,
    detectedState: "stowed",
    recommendedState: "deployed",
    stateConfidence: StateConfidence.HIGH,
    deployableType: "wind",
    eventDurationMinutes: 120, // 2h good-output window
  };
  const easy = calculateUrgency({ ...base, reluctance: "low" }); // 1h
  const hard = calculateUrgency({ ...base }); // type default 8h
  assert.strictEqual(
    easy,
    Urgency.HIGH,
    "1h-reluctance wind with 2h window reaches high",
  );
  assert.strictEqual(
    hard,
    Urgency.LOW,
    "8h-reluctance wind with 2h window caps at low",
  );
});

test("calculateUrgency: reluctance does not apply to engine/battery", () => {
  const withReluctance = calculateUrgency({
    advisoryType: "engine",
    batterySoC: 0.15,
    timeToActionHours: 1,
    isActual: false,
    reluctance: "high", // would gate if applied
  });
  const without = calculateUrgency({
    advisoryType: "engine",
    batterySoC: 0.15,
    timeToActionHours: 1,
    isActual: false,
  });
  assert.strictEqual(withReluctance, without);
});

test("calculateUrgency: high-reluctance deploy suggestion caps at low until the window is long enough", () => {
  // Update #1, point 2: a high-reluctance source (wind gen — go on deck
  // and rig) is only worth deploying for a clearly worthwhile, *hours-long*
  // forecast good-output window. A short window caps at `low` (visual —
  // "there's wind, not enough to justify rigging yet"); only a window
  // reaching the reluctance threshold (8h for wind) reaches `high`. Easy
  // hydro (1h) reaches `high` on a 2h window.
  const base = {
    advisoryType: "deployable",
    severityRatio: 2.0,
    timeToActionHours: 0,
    isActual: false,
    detectedState: "stowed",
    recommendedState: "deployed",
    stateConfidence: StateConfidence.HIGH,
  };
  // 2h window: under wind's 8h, under... no, hydro's 1h is satisfied.
  const wind2h = calculateUrgency({
    ...base,
    eventDurationMinutes: 120,
    deployableType: "wind",
  });
  const hydro2h = calculateUrgency({
    ...base,
    eventDurationMinutes: 120,
    deployableType: "hydro",
  });
  assert.strictEqual(
    wind2h,
    Urgency.LOW,
    "2h wind window caps at low (needs 8h)",
  );
  assert.strictEqual(
    hydro2h,
    Urgency.HIGH,
    "2h hydro window reaches high (needs 1h)",
  );
  // 8h window finally lets wind reach high:
  const wind8h = calculateUrgency({
    ...base,
    eventDurationMinutes: 480,
    deployableType: "wind",
  });
  assert.strictEqual(wind8h, Urgency.HIGH, "8h wind window reaches high");
  // Just-shy (7h59m) still caps at low:
  const wind479 = calculateUrgency({
    ...base,
    eventDurationMinutes: 479,
    deployableType: "wind",
  });
  assert.strictEqual(wind479, Urgency.LOW, "just-shy wind stays low");
});

test("mergeConfig: partial override merges, doesn't erase siblings", () => {
  const merged = mergeConfig({ thresholds: { high: 0.9 } });
  assert.strictEqual(merged.thresholds.high, 0.9, "override applied");
  assert.strictEqual(merged.thresholds.medium, 0.7, "sibling retained");
  assert.strictEqual(merged.weights.intensity, 0.4, "other section retained");
});

test("mergeConfig: undefined override returns defaults clone", () => {
  const merged = mergeConfig(undefined);
  assert.strictEqual(merged.thresholds.high, DEFAULT_CONFIG.thresholds.high);
});

// --- urgencyToNotification ---

test("urgencyToNotification: daytime deployable medium uses visual+sound", () => {
  const n = urgencyToNotification(Urgency.MEDIUM, {
    isNight: false,
    advisoryType: "deployable",
  });
  assert.deepStrictEqual(n, { state: "warn", methods: ["visual", "sound"] });
});

test("urgencyToNotification: nighttime deployable downgrades to visual-only", () => {
  const n = urgencyToNotification(Urgency.HIGH, {
    isNight: true,
    advisoryType: "deployable",
  });
  assert.strictEqual(n.state, "warn");
  assert.deepStrictEqual(n.methods, ["visual"]);
});

test("urgencyToNotification: nighttime battery alarm keeps sound", () => {
  const n = urgencyToNotification(Urgency.ALARM, {
    isNight: true,
    advisoryType: "engine",
  });
  assert.strictEqual(n.state, "alarm");
  assert.deepStrictEqual(n.methods, ["visual", "sound"]);
});

test("urgencyToNotification: nighttime battery high (<1h) keeps sound", () => {
  const n = urgencyToNotification(Urgency.HIGH, {
    isNight: true,
    advisoryType: "engine",
  });
  assert.deepStrictEqual(n.methods, ["visual", "sound"]);
});

test("urgencyToNotification: nighttime battery medium is visual-only", () => {
  const n = urgencyToNotification(Urgency.MEDIUM, {
    isNight: true,
    advisoryType: "engine",
  });
  assert.deepStrictEqual(n.methods, ["visual"]);
});

test("urgencyToNotification: underway + night + low urgency deployable emits (visual-only)", () => {
  const n = urgencyToNotification(Urgency.LOW, {
    isNight: true,
    isUnderway: true,
    advisoryType: "deployable",
  });
  assert.ok(n != null, "underway always emits");
  assert.strictEqual(n.state, "alert");
  assert.deepStrictEqual(n.methods, ["visual"], "still visual-only at night");
});

test("urgencyToNotification: at-rest + night + low urgency deployable is held (null)", () => {
  const n = urgencyToNotification(Urgency.LOW, {
    isNight: true,
    isUnderway: false,
    advisoryType: "deployable",
  });
  assert.strictEqual(
    n,
    null,
    "low-urgency activity suggestion held for the morning",
  );
});

test("urgencyToNotification: at-rest + night + info urgency deployable is held (null)", () => {
  const n = urgencyToNotification(Urgency.INFO, {
    isNight: true,
    isUnderway: false,
    advisoryType: "deployable",
  });
  assert.strictEqual(
    n,
    null,
    "info-urgency activity suggestion held for the morning",
  );
});

test("urgencyToNotification: at-rest + night + medium urgency activity still emits", () => {
  const n = urgencyToNotification(Urgency.MEDIUM, {
    isNight: true,
    isUnderway: false,
    advisoryType: "deployable",
  });
  assert.ok(n != null, "medium+ is safety-relevant, not held");
  assert.deepStrictEqual(n.methods, ["visual"]);
});

test("urgencyToNotification: at-rest + night + low urgency engine is held (null)", () => {
  // A low-urgency "run the genset" suggestion at rest + night is held
  // for the morning per update #2 — it can wait for a civilized hour.
  // Only battery alarm/high (medium+ here) bypass the gate and emit
  // (with sound, since the boat going dark is urgent regardless of time).
  const n = urgencyToNotification(Urgency.LOW, {
    isNight: true,
    isUnderway: false,
    advisoryType: "engine",
  });
  assert.strictEqual(
    n,
    null,
    "low-urgency engine suggestion held for the morning",
  );
});

test("urgencyToNotification: normal always clears regardless of context", () => {
  const n = urgencyToNotification(Urgency.NORMAL, {
    isNight: true,
    isUnderway: false,
    advisoryType: "deployable",
  });
  assert.deepStrictEqual(n, { state: "normal", methods: [] });
});

test("urgencyToNotification: opportunity daytime medium uses visual+sound", () => {
  const n = urgencyToNotification(Urgency.MEDIUM, {
    isNight: false,
    advisoryType: "opportunity",
  });
  assert.strictEqual(n.state, "warn");
  assert.deepStrictEqual(n.methods, ["visual", "sound"]);
});

test("urgencyToNotification: opportunity nighttime always visual-only", () => {
  // Even high-ish opportunity urgency (which the cap prevents) would be
  // visual-only at night — it's a gain, not safety.
  const n = urgencyToNotification(Urgency.MEDIUM, {
    isNight: true,
    advisoryType: "opportunity",
  });
  assert.deepStrictEqual(n.methods, ["visual"]);
});

test("urgencyToNotification: at-rest + night + low urgency opportunity is held (null)", () => {
  const n = urgencyToNotification(Urgency.LOW, {
    isNight: true,
    isUnderway: false,
    advisoryType: "opportunity",
  });
  assert.strictEqual(n, null, "low-urgency opportunity held for the morning");
});

test("urgencyToNotification: underway + night + low urgency opportunity emits (visual-only)", () => {
  const n = urgencyToNotification(Urgency.LOW, {
    isNight: true,
    isUnderway: true,
    advisoryType: "opportunity",
  });
  assert.ok(n != null, "underway always emits");
  assert.deepStrictEqual(n.methods, ["visual"]);
});

test("calculateUrgency: opportunity never exceeds medium (cap)", () => {
  // Immediate action, no reluctance dampening on opportunity type → max
  // time score, but intensity is 0 (no severity input) so the score is
  // time-only and lands in the medium band at most.
  const u = calculateUrgency({
    advisoryType: "opportunity",
    timeToActionHours: 0,
    isActual: false,
  });
  assert.ok(
    URGENCY_ORDER_INDEX(u) <= URGENCY_ORDER_INDEX(Urgency.MEDIUM),
    `opportunity capped at medium, got ${u}`,
  );
});

/** Helper: numeric index of an urgency level (low→high). */
function URGENCY_ORDER_INDEX(u) {
  return [
    Urgency.NORMAL,
    Urgency.INFO,
    Urgency.LOW,
    Urgency.MEDIUM,
    Urgency.HIGH,
    Urgency.ALARM,
  ].indexOf(u);
}

// --- AdvisoryPublisher integration (urgency → SK state + methods) ---

function makeFakeApp() {
  return {
    selfId: "self",
    debug() {},
    info() {},
    warn() {},
    error() {},
    getSelfPath() {
      return null;
    },
    handleMessageCalls: [],
    handleMessage(source, msg) {
      this.handleMessageCalls.push({ source, msg });
    },
  };
}

/** Extracts the notification value at a path prefix, or null. */
function findNotif(app, pathPrefix) {
  const calls = app.handleMessageCalls.filter(
    (c) =>
      c.msg.updates &&
      c.msg.updates[0].values.some((v) => v.path.startsWith(pathPrefix)),
  );
  if (calls.length === 0) return null;
  return calls[calls.length - 1].msg.updates[0].values.find((v) =>
    v.path.startsWith(pathPrefix),
  ).value;
}

test("publishDeploymentStates: daytime sustained over-limit → warn + visual/sound", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  pub.publishDeploymentStates(
    [
      {
        id: "windgen",
        name: "Wind Gen",
        type: "wind",
        recommendedState: "stowed",
        reason: "gusts 50kn exceed limit 30kn",
        currentGustKnots: 50,
        limitKnots: 30,
      },
    ],
    new Map([["windgen", "deployed"]]),
    {
      isNight: false,
      isUnderway: false,
      confidences: new Map([["windgen", StateConfidence.HIGH]]),
    },
  );
  const n = findNotif(app, "notifications.electrical.energy.deploy_windgen");
  assert.ok(n, "notification published");
  assert.ok(n.state !== "normal", "should be an active state");
  assert.deepStrictEqual(n.method, ["visual", "sound"]);
});

test("publishDeploymentStates: nighttime deployable downgrade to visual-only", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  pub.publishDeploymentStates(
    [
      {
        id: "windgen",
        name: "Wind Gen",
        type: "wind",
        recommendedState: "stowed",
        reason: "gusts 50kn exceed limit 30kn",
        currentGustKnots: 50,
        limitKnots: 30,
      },
    ],
    new Map([["windgen", "deployed"]]),
    {
      isNight: true,
      isUnderway: false,
      confidences: new Map([["windgen", StateConfidence.HIGH]]),
    },
  );
  const n = findNotif(app, "notifications.electrical.energy.deploy_windgen");
  assert.ok(n, "notification published");
  assert.ok(n.state !== "normal");
  assert.deepStrictEqual(
    n.method,
    ["visual"],
    "night deployables are visual-only",
  );
});

test("publishDeploymentStates: at-rest + night + low-urgency deploy suggestion is held (no notification)", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  // Mild over-limit, far future → low urgency deploy suggestion, at rest at night.
  pub.publishDeploymentStates(
    [
      {
        id: "windgen",
        name: "Wind Gen",
        type: "wind",
        recommendedState: "deployed",
        reason: "light wind 6kn",
        currentGustKnots: 6,
        limitKnots: 30,
        recommendedStateTime: new Date(Date.now() + 12 * 3600 * 1000),
      },
    ],
    new Map([["windgen", "stowed"]]),
    {
      isNight: true,
      isUnderway: false,
      confidences: new Map([["windgen", StateConfidence.HIGH]]),
    },
  );
  const n = findNotif(app, "notifications.electrical.energy.deploy_windgen");
  assert.strictEqual(
    n,
    null,
    "low-urgency at-rest night suggestion held — no notification published",
  );
});

test("publishDeploymentStates: underway + night still emits deploy suggestion", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  pub.publishDeploymentStates(
    [
      {
        id: "windgen",
        name: "Wind Gen",
        type: "wind",
        recommendedState: "stowed",
        reason: "gusts 50kn exceed limit 30kn",
        currentGustKnots: 50,
        limitKnots: 30,
      },
    ],
    new Map([["windgen", "deployed"]]),
    {
      isNight: true,
      isUnderway: true,
      confidences: new Map([["windgen", StateConfidence.HIGH]]),
    },
  );
  const n = findNotif(app, "notifications.electrical.energy.deploy_windgen");
  assert.ok(n && n.state !== "normal", "underway never suppresses");
});

test("publishCombustionAdvisories: low battery at night → alarm keeps sound", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  pub.publishCombustionAdvisories(
    [
      {
        id: "main",
        name: "Engine",
        type: "engine",
        tier: 3,
        recommendedState: "deployed",
        reason: "bank projected below the 20% floor for 4h",
        detectedState: "stowed",
        watts: 100,
        runHours: 1,
        windowStart: new Date(Date.now() + 60 * 60 * 1000),
        windowEnd: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    ],
    { batterySoC: 0.08, isNight: true },
  );
  const n = findNotif(app, "notifications.electrical.energy.engine_run");
  assert.ok(n);
  assert.strictEqual(n.state, "alarm");
  assert.deepStrictEqual(
    n.method,
    ["visual", "sound"],
    "battery alarm sounds at night",
  );
});

test("publishDragReductionAdvisory: near-term stowage → active notification", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  pub.publishDragReductionAdvisory(
    { hour: 1, reason: "deficit covered by hour 1" },
    { isNight: false, isUnderway: false },
  );
  const n = findNotif(app, "notifications.electrical.energy.stow_soon");
  assert.ok(n);
  assert.ok(n.state !== "normal", "near-term stowage should notify");
});

test("publishDragReductionAdvisory: far-future stowage at rest + night is held (no notification)", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  // 12h out → low urgency; at rest + night → held for the morning.
  pub.publishDragReductionAdvisory(
    { hour: 12, reason: "deficit covered by hour 12" },
    { isNight: true, isUnderway: false },
  );
  const n = findNotif(app, "notifications.electrical.energy.stow_soon");
  assert.strictEqual(n, null, "low-urgency at-rest night suggestion held");
});

test("publishDragReductionAdvisory: null opportunity clears", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  pub.publishDragReductionAdvisory(null, { isNight: false });
  const n = findNotif(app, "notifications.electrical.energy.stow_soon");
  assert.ok(n);
  assert.strictEqual(n.state, "normal");
});

test("publishSurplusAdvisory: near-term surplus → active notification with methods", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  const from = new Date(Date.now() + 60 * 60 * 1000);
  const to = new Date(Date.now() + 4 * 60 * 60 * 1000);
  pub.publishSurplusAdvisory(
    { surplusWh: 1200, from, to, suggestedLoadW: 300 },
    [],
    { isNight: false, isUnderway: false },
  );
  const n = findNotif(app, "notifications.electrical.energy.surplus");
  assert.ok(n);
  assert.ok(n.state !== "normal", "near-term surplus should notify");
  assert.ok(n.method.includes("visual"), "daytime surplus includes visual");
});

test("publishSurplusAdvisory: at-rest + night + far-future surplus is held (no notification)", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  const from = new Date(Date.now() + 12 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 16 * 60 * 60 * 1000);
  pub.publishSurplusAdvisory(
    { surplusWh: 1200, from, to, suggestedLoadW: 300 },
    [],
    { isNight: true, isUnderway: false },
  );
  const n = findNotif(app, "notifications.electrical.energy.surplus");
  assert.strictEqual(
    n,
    null,
    "low-urgency at-rest night surplus held — no notification, last one stands",
  );
});

test("publishSurplusAdvisory: very-far-future (20h) surplus at night is held, not normal", () => {
  // Regression: a surplus window ~20h out used to compute to `normal` and
  // publish a confusing "NORMAL: ... surplus available" notification.
  // Floored at info, then held by the at-rest + night + low gate → no
  // notification is published (last one stands), neither a false "all
  // clear" nor a buzzing nudge.
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  const from = new Date(Date.now() + 20 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 22 * 60 * 60 * 1000);
  pub.publishSurplusAdvisory(
    { surplusWh: 1600, from, to, suggestedLoadW: 61 },
    [
      { name: "Watermaker", watts: 31 },
      { name: "Starlink", watts: 20 },
    ],
    { isNight: true, isUnderway: false },
  );
  const n = findNotif(app, "notifications.electrical.energy.surplus");
  assert.strictEqual(
    n,
    null,
    "far-future surplus at rest + night is held, not a confusing normal",
  );
});

test("publishSurplusAdvisory: held notification leaves a prior alert standing", () => {
  // The "hold" contract: when a surplus is held at-rest+night, the caller
  // skips publishing so the *last* notification stands (not cleared to
  // normal). Verify by publishing a daytime alert first, then a held one.
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  // Day, near-term → warn.
  const from1 = new Date(Date.now() + 60 * 60 * 1000);
  const to1 = new Date(Date.now() + 3 * 60 * 60 * 1000);
  pub.publishSurplusAdvisory(
    { surplusWh: 800, from: from1, to: to1, suggestedLoadW: 200 },
    [],
    { isNight: false, isUnderway: false },
  );
  const first = findNotif(app, "notifications.electrical.energy.surplus");
  assert.ok(first && first.state === "warn", "prior alert published");

  // Now night falls, window is far out → held (no new publish).
  const from2 = new Date(Date.now() + 20 * 60 * 60 * 1000);
  const to2 = new Date(Date.now() + 22 * 60 * 60 * 1000);
  pub.publishSurplusAdvisory(
    { surplusWh: 1600, from: from2, to: to2, suggestedLoadW: 70 },
    [],
    { isNight: true, isUnderway: false },
  );
  // findNotif returns the *last* matching value; a held call publishes
  // no surplus notification, so the last one is still the daytime warn.
  const last = findNotif(app, "notifications.electrical.energy.surplus");
  assert.ok(
    last,
    "holding did not publish a clearing notification — prior alert stands",
  );
  assert.strictEqual(last.state, "warn", "prior alert retained, not cleared");
});

test("publishSurplusAdvisory: held notification still publishes surplus Wh/window deltas", () => {
  // Deltas are data for dashboards, not a crew nudge — they publish
  // regardless of whether the notification is held at night.
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test");
  const from = new Date(Date.now() + 20 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 22 * 60 * 60 * 1000);
  pub.publishSurplusAdvisory(
    { surplusWh: 1600, from, to, suggestedLoadW: 70 },
    [],
    { isNight: true, isUnderway: false },
  );
  const wh = app.handleMessageCalls
    .flatMap((c) => (c.msg.updates || []).flatMap((u) => u.values || []))
    .find((v) => v.path === "electrical.energy.prediction.surplusWh");
  assert.ok(wh, "surplusWh delta published even when notification held");
  assert.strictEqual(wh.value, 1600);
});
