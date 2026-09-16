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

test("solarMidnightOf computes true solar midnight (offset subtracted)", async () => {
  const { solarMidnightOf } = await import(
    `file://${require("path").join(PUBLIC, "ep-solar-time.js")}`
  );
  // At UTC−10, solar midnight of Aug 23 is 10:00 UTC — not 00:00 UTC
  assert.strictEqual(
    new Date(solarMidnightOf(2026, 7, 23, -600)).toISOString(),
    "2026-08-23T10:00:00.000Z",
  );
  // +02:00 moves the instant back into the previous UTC day
  assert.strictEqual(
    solarMidnightOf(2026, 7, 23, 120),
    Date.UTC(2026, 7, 22, 22, 0, 0),
  );
});

test("solarDateOf returns solar-local calendar fields for ms and Date inputs", async () => {
  const { solarDateOf } = await import(
    `file://${require("path").join(PUBLIC, "ep-solar-time.js")}`
  );
  // 2026-09-14T13:00Z at +11:32 (+692 min) is Sep 15 00:32 solar-local
  assert.deepStrictEqual(solarDateOf(Date.UTC(2026, 8, 14, 13, 0, 0), 692), {
    y: 2026,
    m: 8,
    d: 15,
  });
  // Same instant at −11:32 is Sep 14 01:28 solar-local; Date input works
  assert.deepStrictEqual(
    solarDateOf(new Date(Date.UTC(2026, 8, 14, 13, 0, 0)), -692),
    { y: 2026, m: 8, d: 14 },
  );
});

test("solarMidnightToday follows the calendar-date jump at the date line", async () => {
  const { solarDayKey, solarMidnightToday } = await import(
    `file://${require("path").join(PUBLIC, "ep-solar-time.js")}`
  );
  // Crossing the date line at ~173°W flips the longitude-derived offset
  // by ~24h: 173°W → −692 min, 173°E → +692 min. The sun-day containing
  // the same instant moves to the next calendar date, and the live-day
  // anchor must be resolved against the *current* offset — never carried
  // over as a date number from the pre-crossing frame.
  const now = Date.UTC(2026, 8, 14, 13, 0, 0);
  assert.strictEqual(solarDayKey(now, -692), "2026-09-14");
  assert.strictEqual(solarDayKey(now, 692), "2026-09-15");
  const west = solarMidnightToday(-692, now);
  const east = solarMidnightToday(692, now);
  // West side: 13:00Z − 11:32 = 01:28 Sep 14 solar-local, so the live
  // sun-day starts at Sep 14 00:00 solar = 11:32Z
  assert.strictEqual(new Date(west).toISOString(), "2026-09-14T11:32:00.000Z");
  // East side: 13:00Z + 11:32 = 00:32 Sep 15 solar-local — a full
  // calendar day ahead of the west side (the sun-day spans overlap by
  // ~23h around the line, which is exactly why a carried-over date
  // number lands on the wrong day)
  assert.strictEqual(new Date(east).toISOString(), "2026-09-14T12:28:00.000Z");
  assert.strictEqual(east - west, 56 * 60 * 1000);
});

test("solarMidnightToday rolls over at solar midnight, not UTC midnight", async () => {
  const { solarMidnightToday } = await import(
    `file://${require("path").join(PUBLIC, "ep-solar-time.js")}`
  );
  // +692: solar midnight of Sep 14 is 2026-09-13T12:28Z, of Sep 15 is
  // 2026-09-14T12:28Z. At 12:27Z "now" is still the Sep 14 sun-day; one
  // solar minute later it belongs to Sep 15 (long before UTC midnight).
  const before = solarMidnightToday(692, Date.UTC(2026, 8, 14, 12, 27, 0));
  const after = solarMidnightToday(692, Date.UTC(2026, 8, 14, 12, 29, 0));
  assert.strictEqual(
    new Date(before).toISOString(),
    "2026-09-13T12:28:00.000Z",
  );
  assert.strictEqual(new Date(after).toISOString(), "2026-09-14T12:28:00.000Z");
});

test("solarMidnightToday falls back to browser-local midnight when offset is null", async () => {
  const { solarMidnightToday } = await import(
    `file://${require("path").join(PUBLIC, "ep-solar-time.js")}`
  );
  const noon = new Date(2026, 8, 14, 13, 0, 0).getTime();
  assert.strictEqual(
    solarMidnightToday(null, noon),
    new Date(2026, 8, 14).getTime(),
  );
});
