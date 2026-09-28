/**
 * Smoketests for human-facing notification time scoping.
 *
 * The server on a vessel is typically clocked in UTC, but the crew reads
 * times in ship's time — the onboard timezone published as
 * `environment.time.timezoneOffset` by @meri-imperiumi/signalk-ships-time.
 * The advisory text renders against that offset rather than relying on the
 * host's timezone setting. Emitted deltas stay in UTC (ISO 8601) — only
 * the message text is localised.
 *
 * @file local-time.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AdvisoryPublisher,
  formatWindowTime,
} = require("../plugin/advisory.js");
const { offsetMinutesFromHhmm } = require("../plugin/format.js");

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

function findSurplus(app) {
  return getNotifications(app).find((v) =>
    v.path.startsWith("notifications.electrical.energy.surplus"),
  );
}

function findEngineRun(app) {
  return getNotifications(app).find((v) =>
    v.path.startsWith("notifications.electrical.energy.engine_run"),
  );
}

// --- offsetMinutesFromHhmm ---

test("offsetMinutesFromHhmm: 0 -> 0", () => {
  assert.strictEqual(offsetMinutesFromHhmm(0), 0);
});

test("offsetMinutesFromHhmm: 200 (+02:00) -> 120", () => {
  assert.strictEqual(offsetMinutesFromHhmm(200), 120);
});

test("offsetMinutesFromHhmm: 930 (+09:30) -> 570 (sub-hour zone)", () => {
  assert.strictEqual(offsetMinutesFromHhmm(930), 570);
});

test("offsetMinutesFromHhmm: -930 (-09:30) -> -570", () => {
  assert.strictEqual(offsetMinutesFromHhmm(-930), -570);
});

test("offsetMinutesFromHhmm: -500 (-05:00) -> -300", () => {
  assert.strictEqual(offsetMinutesFromHhmm(-500), -300);
});

test("offsetMinutesFromHhmm: 545 (+05:45, Kathmandu) -> 345", () => {
  assert.strictEqual(offsetMinutesFromHhmm(545), 345);
});

test("offsetMinutesFromHhmm: null/undefined/NaN/'' -> null (unpublished)", () => {
  assert.strictEqual(offsetMinutesFromHhmm(null), null);
  assert.strictEqual(offsetMinutesFromHhmm(undefined), null);
  assert.strictEqual(offsetMinutesFromHhmm(NaN), null);
  assert.strictEqual(offsetMinutesFromHhmm(""), null);
});

test("offsetMinutesFromHhmm: numeric string is tolerated", () => {
  assert.strictEqual(offsetMinutesFromHhmm("200"), 120);
});

// --- formatWindowTime (ship's-time rendering) ---

test("formatWindowTime: renders HH:MM in ship's time, not UTC", () => {
  // 23:01 UTC at +02:00 should read 01:01 local (next day).
  const when = new Date("2025-08-25T23:01:00Z");
  assert.strictEqual(formatWindowTime(when, undefined, 120), "01:01");
});

test("formatWindowTime: west offset shifts earlier", () => {
  // 23:01 UTC at -03:00 should read 20:01 same local day.
  const when = new Date("2025-08-25T23:01:00Z");
  assert.strictEqual(formatWindowTime(when, undefined, -180), "20:01");
});

test("formatWindowTime: +1 marker when endpoint crosses local midnight", () => {
  // A 26h window from 14:46 -> 16:46 next-day at UTC+0.
  const from = new Date("2025-08-25T14:46:00Z");
  const to = new Date("2025-08-26T16:46:00Z");
  const rendered = formatWindowTime(to, from, 0);
  assert.match(rendered, /16:46\+1/);
});

test("formatWindowTime: null offset preserves host-timezone (legacy) path", () => {
  // With no offset the function must behave as before: a same-instant
  // render via toLocaleTimeString. We can't assert an exact value
  // (host tz dependent), but it must match the host render and contain
  // a colon-delimited HH:MM.
  const when = new Date("2025-08-25T23:01:00Z");
  const legacy = when.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  assert.strictEqual(formatWindowTime(when, undefined, null), legacy);
  assert.match(formatWindowTime(when, undefined, null), /^\d\d:\d\d$/);
});

// --- publishSurplusAdvisory: end-to-end ship's-time text ---

test("publishSurplusAdvisory: message times are ship's time, deltas stay UTC", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test-plugin");
  // A surplus window 23:01-03:01 UTC on 25 Aug, onboard UTC+02:00.
  // Crew-local: 01:01 (26 Aug) - 05:01 (26 Aug).
  const from = new Date("2025-08-25T23:01:00Z");
  const to = new Date("2025-08-26T03:01:00Z");
  pub.publishSurplusAdvisory(
    { surplusWh: 1700, from, to, suggestedLoadW: 58 },
    [],
    { localOffsetMinutes: offsetMinutesFromHhmm(200) },
  );
  const n = findSurplus(app);
  assert.ok(n, "surplus notification published");
  assert.match(
    n.value.message,
    /01:01-05:01/,
    "window times should be ship's time (01:01-05:01), not UTC (23:01-03:01)",
  );
  assert.match(n.value.message, /~58W sustained/);

  // Emitted deltas must remain ISO 8601 UTC — consumers parse these.
  const deltas = app.handleMessageCalls
    .filter((c) => c.msg.updates)
    .flatMap((c) => c.msg.updates[0].values);
  const fromDelta = deltas.find(
    (v) => v.path === "electrical.energy.prediction.surplus.from",
  );
  const toDelta = deltas.find(
    (v) => v.path === "electrical.energy.prediction.surplus.to",
  );
  assert.ok(fromDelta, "surplus.from delta emitted");
  assert.ok(toDelta, "surplus.to delta emitted");
  assert.strictEqual(fromDelta.value, from.toISOString());
  assert.strictEqual(toDelta.value, to.toISOString());
});

test("publishSurplusAdvisory: +1 day marker for cross-midnight window in local time", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test-plugin");
  // 22:00 UTC 25 Aug -> 00:30 UTC 26 Aug, at +02:00 → 00:00-02:30 26 Aug.
  const from = new Date("2025-08-25T22:00:00Z");
  const to = new Date("2025-08-26T00:30:00Z");
  pub.publishSurplusAdvisory(
    { surplusWh: 500, from, to, suggestedLoadW: 0 },
    [],
    { localOffsetMinutes: offsetMinutesFromHhmm(200) },
  );
  const n = findSurplus(app);
  assert.ok(n);
  // Both endpoints fall on the same ship's-time day (26 Aug), so no +1.
  assert.match(n.value.message, /00:00-02:30/);
  assert.doesNotMatch(n.value.message, /\+1/);
});

test("publishSurplusAdvisory: default (no offset) keeps legacy host-timezone behaviour", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test-plugin");
  const from = new Date("2025-08-25T23:01:00Z");
  const to = new Date("2025-08-26T03:01:00Z");
  pub.publishSurplusAdvisory(
    { surplusWh: 1700, from, to, suggestedLoadW: 58 },
    [],
  );
  const n = findSurplus(app);
  assert.ok(n);
  // The legacy render of `from` in the host tz must appear verbatim.
  const legacyFrom = from.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  assert.ok(
    n.value.message.includes(legacyFrom),
    `message should contain host-tz render "${legacyFrom}": ${n.value.message}`,
  );
});

// --- publishCombustionAdvisories: ship's-time text ---

test("publishCombustionAdvisories: window times are ship's time", () => {
  const app = makeFakeApp();
  const pub = new AdvisoryPublisher(app, "test-plugin");
  // Engine window 23:00-01:00 UTC at +02:00 → 01:00-03:00 local.
  const start = new Date("2025-08-25T23:00:00Z");
  const end = new Date("2025-08-26T01:00:00Z");
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
        runHours: 2,
        windowStart: start,
        windowEnd: end,
      },
    ],
    {
      batterySoC: 0.1,
      isNight: false,
      localOffsetMinutes: offsetMinutesFromHhmm(200),
    },
  );
  const n = findEngineRun(app);
  assert.ok(n);
  assert.match(
    n.value.message,
    /01:00-03:00/,
    "engine window should be ship's time (01:00-03:00)",
  );
});
