/**
 * Solar-local time formatter smoketests. The formatter is a pure ES module
 * (no browser APIs), so it can be exercised directly under node.
 * @file solar-time.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

// ES module under a CommonJS test file: dynamic import by absolute path.
const PUBLIC = require("path").join(__dirname, "..", "public");

test("formatHHMM shifts by the solar-local offset (east positive)", async () => {
  const { formatHHMM } = await import(
    `file://${require("path").join(PUBLIC, "ep-solar-time.js")}`
  );
  // 2026-08-23T12:12:00Z, +2h offset -> 14:12 solar-local
  const t = Date.UTC(2026, 7, 23, 12, 12, 0);
  assert.strictEqual(formatHHMM(t, 120), "14:12");
  // West offset: -10h -> 02:12 solar-local (still Aug 23)
  assert.strictEqual(formatHHMM(t, -600), "02:12");
});

test("formatHHMM falls back to the browser timezone when offset is null", async () => {
  const { formatHHMM } = await import(
    `file://${require("path").join(PUBLIC, "ep-solar-time.js")}`
  );
  // Null offset must not throw and must produce an HH:MM-shaped string.
  const t = Date.UTC(2026, 7, 23, 12, 12, 0);
  assert.match(formatHHMM(t, null), /^\d\d:\d\d$/);
});

test("formatDayMonth renders solar-local D/M", async () => {
  const { formatDayMonth } = await import(
    `file://${require("path").join(PUBLIC, "ep-solar-time.js")}`
  );
  // 2026-08-23T22:00:00Z at +2h -> Aug 24 00:00 solar-local -> 24/8
  const t = Date.UTC(2026, 7, 23, 22, 0, 0);
  assert.strictEqual(formatDayMonth(t, 120), "24/8");
  // Same instant at -10h -> Aug 23 12:00 solar-local -> 23/8
  assert.strictEqual(formatDayMonth(t, -600), "23/8");
});

test("solarDayKey + solarDayStart round-trip a sun-day in UTC", async () => {
  const { solarDayKey, solarDayStart } = await import(
    `file://${require("path").join(PUBLIC, "ep-solar-time.js")}`
  );
  // +2h: solar Aug 23 spans [2026-08-22T22:00Z, 2026-08-23T22:00Z)
  const t = Date.UTC(2026, 7, 23, 12, 12, 0);
  const key = solarDayKey(t, 120);
  assert.strictEqual(key, "2026-08-23");
  assert.strictEqual(
    new Date(solarDayStart(key, 120)).toISOString(),
    "2026-08-22T22:00:00.000Z",
  );
  // A UTC instant just before solar midnight Aug 23 (21:59Z = 23:59 local)
  // is still Aug 23; just after (23:00Z = 01:00 next day) is Aug 24.
  assert.strictEqual(
    solarDayKey(Date.UTC(2026, 7, 23, 21, 59, 0), 120),
    "2026-08-23",
  );
  assert.strictEqual(
    solarDayKey(Date.UTC(2026, 7, 23, 23, 0, 0), 120),
    "2026-08-24",
  );
});

test("formatShortDateTime renders solar-local date+time", async () => {
  const { formatShortDateTime } = await import(
    `file://${require("path").join(PUBLIC, "ep-solar-time.js")}`
  );
  // 2026-08-23T12:12:00Z at +2h -> 23/08/2026, 14:12
  const t = Date.UTC(2026, 7, 23, 12, 12, 0);
  assert.strictEqual(formatShortDateTime(t, 120), "23/08/2026, 14:12");
  // -10h -> 23/08/2026, 02:12
  assert.strictEqual(formatShortDateTime(t, -600), "23/08/2026, 02:12");
});

test("formatters handle a day straddling UTC midnight without splitting", async () => {
  const { solarDayKey } = await import(
    `file://${require("path").join(PUBLIC, "ep-solar-time.js")}`
  );
  // -10h offset: solar Aug 23 spans [2026-08-23T10:00Z, 2026-08-24T10:00Z).
  // 23:46Z Aug 23 and 00:05Z Aug 24 are both solar Aug 23 (the straddle case
  // the advisory dedup keys on).
  assert.strictEqual(
    solarDayKey(Date.UTC(2026, 7, 23, 23, 46, 0), -600),
    "2026-08-23",
  );
  assert.strictEqual(
    solarDayKey(Date.UTC(2026, 7, 24, 0, 5, 0), -600),
    "2026-08-23",
  );
});
