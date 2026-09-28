/**
 * Ship's-time formatter smoketests. The offset rendered against is the
 * vessel's onboard timezone (`environment.time.timezoneOffset`) surfaced
 * by `/api/vessel`. The formatter module is a pure ES module (no browser
 * APIs), so it can be exercised directly under node.
 * @file ship-time.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

// ES module under a CommonJS test file: dynamic import by absolute path.
const PUBLIC = require("path").join(__dirname, "..", "public");

test("formatHHMM shifts by the ship's-time offset (east positive)", async () => {
  const { formatHHMM } = await import(
    `file://${require("path").join(PUBLIC, "ep-ship-time.js")}`
  );
  // 2026-08-23T12:12:00Z, +2h offset -> 14:12 ship's-time
  const t = Date.UTC(2026, 7, 23, 12, 12, 0);
  assert.strictEqual(formatHHMM(t, 120), "14:12");
  // West offset: -10h -> 02:12 ship's-time (still Aug 23)
  assert.strictEqual(formatHHMM(t, -600), "02:12");
});

test("formatHHMM falls back to the browser timezone when offset is null", async () => {
  const { formatHHMM } = await import(
    `file://${require("path").join(PUBLIC, "ep-ship-time.js")}`
  );
  // Null offset must not throw and must produce an HH:MM-shaped string.
  const t = Date.UTC(2026, 7, 23, 12, 12, 0);
  assert.match(formatHHMM(t, null), /^\d\d:\d\d$/);
});

test("formatDayMonth renders ship's-time D/M", async () => {
  const { formatDayMonth } = await import(
    `file://${require("path").join(PUBLIC, "ep-ship-time.js")}`
  );
  // 2026-08-23T22:00:00Z at +2h -> Aug 24 00:00 ship's-time -> 24/8
  const t = Date.UTC(2026, 7, 23, 22, 0, 0);
  assert.strictEqual(formatDayMonth(t, 120), "24/8");
  // Same instant at -10h -> Aug 23 12:00 ship's-time -> 23/8
  assert.strictEqual(formatDayMonth(t, -600), "23/8");
});

test("shipDayKey + shipDayStart round-trip a ship's-time day in UTC", async () => {
  const { shipDayKey, shipDayStart } = await import(
    `file://${require("path").join(PUBLIC, "ep-ship-time.js")}`
  );
  // +2h: ship's-time Aug 23 spans [2026-08-22T22:00Z, 2026-08-23T22:00Z)
  const t = Date.UTC(2026, 7, 23, 12, 12, 0);
  const key = shipDayKey(t, 120);
  assert.strictEqual(key, "2026-08-23");
  assert.strictEqual(
    new Date(shipDayStart(key, 120)).toISOString(),
    "2026-08-22T22:00:00.000Z",
  );
  // A UTC instant just before ship's-time midnight Aug 23 (21:59Z = 23:59 local)
  // is still Aug 23; just after (23:00Z = 01:00 next day) is Aug 24.
  assert.strictEqual(
    shipDayKey(Date.UTC(2026, 7, 23, 21, 59, 0), 120),
    "2026-08-23",
  );
  assert.strictEqual(
    shipDayKey(Date.UTC(2026, 7, 23, 23, 0, 0), 120),
    "2026-08-24",
  );
});

test("formatShortDateTime renders ship's-time date+time", async () => {
  const { formatShortDateTime } = await import(
    `file://${require("path").join(PUBLIC, "ep-ship-time.js")}`
  );
  // 2026-08-23T12:12:00Z at +2h -> 23/08/2026, 14:12
  const t = Date.UTC(2026, 7, 23, 12, 12, 0);
  assert.strictEqual(formatShortDateTime(t, 120), "23/08/2026, 14:12");
  // -10h -> 23/08/2026, 02:12
  assert.strictEqual(formatShortDateTime(t, -600), "23/08/2026, 02:12");
});

test("formatters handle a day straddling UTC midnight without splitting", async () => {
  const { shipDayKey } = await import(
    `file://${require("path").join(PUBLIC, "ep-ship-time.js")}`
  );
  // -10h offset: ship's-time Aug 23 spans [2026-08-23T10:00Z, 2026-08-24T10:00Z).
  // 23:46Z Aug 23 and 00:05Z Aug 24 are both ship's-time Aug 23 (the straddle case
  // the advisory dedup keys on).
  assert.strictEqual(
    shipDayKey(Date.UTC(2026, 7, 23, 23, 46, 0), -600),
    "2026-08-23",
  );
  assert.strictEqual(
    shipDayKey(Date.UTC(2026, 7, 24, 0, 5, 0), -600),
    "2026-08-23",
  );
});

test("shipMidnightOf computes true ship's-time midnight (offset subtracted)", async () => {
  const { shipMidnightOf } = await import(
    `file://${require("path").join(PUBLIC, "ep-ship-time.js")}`
  );
  // At UTC−10, ship's-time midnight of Aug 23 is 10:00 UTC — not 00:00 UTC
  assert.strictEqual(
    new Date(shipMidnightOf(2026, 7, 23, -600)).toISOString(),
    "2026-08-23T10:00:00.000Z",
  );
  // +02:00 moves the instant back into the previous UTC day
  assert.strictEqual(
    shipMidnightOf(2026, 7, 23, 120),
    Date.UTC(2026, 7, 22, 22, 0, 0),
  );
});

test("shipDateOf returns ship's-time calendar fields for ms and Date inputs", async () => {
  const { shipDateOf } = await import(
    `file://${require("path").join(PUBLIC, "ep-ship-time.js")}`
  );
  // 2026-09-14T13:00Z at +11:32 (+692 min) is Sep 15 00:32 ship's-time
  assert.deepStrictEqual(shipDateOf(Date.UTC(2026, 8, 14, 13, 0, 0), 692), {
    y: 2026,
    m: 8,
    d: 15,
  });
  // Same instant at −11:32 is Sep 14 01:28 ship's-time; Date input works
  assert.deepStrictEqual(
    shipDateOf(new Date(Date.UTC(2026, 8, 14, 13, 0, 0)), -692),
    { y: 2026, m: 8, d: 14 },
  );
});

test("shipMidnightToday follows the calendar-date jump across a large offset change", async () => {
  const { shipDayKey, shipMidnightToday } = await import(
    `file://${require("path").join(PUBLIC, "ep-ship-time.js")}`
  );
  // The onboard timezone can jump far when the crew re-sets their clocks
  // (or the ships-time plugin's auto mode follows a zone crossing): here
  // −11:32 → +11:32 flips the offset by ~23h. The ship's-time day containing
  // the same instant moves to the next calendar date, and the live-day
  // anchor must be resolved against the *current* offset — never carried
  // over as a date number from the pre-change frame.
  const now = Date.UTC(2026, 8, 14, 13, 0, 0);
  assert.strictEqual(shipDayKey(now, -692), "2026-09-14");
  assert.strictEqual(shipDayKey(now, 692), "2026-09-15");
  const west = shipMidnightToday(-692, now);
  const east = shipMidnightToday(692, now);
  // West side: 13:00Z − 11:32 = 01:28 Sep 14 ship's-time, so the live
  // ship's-time day starts at Sep 14 00:00 local = 11:32Z
  assert.strictEqual(new Date(west).toISOString(), "2026-09-14T11:32:00.000Z");
  // East side: 13:00Z + 11:32 = 00:32 Sep 15 ship's-time — a full
  // calendar day ahead of the west side (the ship's-time day spans overlap by
  // ~23h around the change, which is exactly why a carried-over date
  // number lands on the wrong day)
  assert.strictEqual(new Date(east).toISOString(), "2026-09-14T12:28:00.000Z");
  assert.strictEqual(east - west, 56 * 60 * 1000);
});

test("shipMidnightToday rolls over at ship's-time midnight, not UTC midnight", async () => {
  const { shipMidnightToday } = await import(
    `file://${require("path").join(PUBLIC, "ep-ship-time.js")}`
  );
  // +692: ship's-time midnight of Sep 14 is 2026-09-13T12:28Z, of Sep 15 is
  // 2026-09-14T12:28Z. At 12:27Z "now" is still the Sep 14 ship's-time day; one
  // local minute later it belongs to Sep 15 (long before UTC midnight).
  const before = shipMidnightToday(692, Date.UTC(2026, 8, 14, 12, 27, 0));
  const after = shipMidnightToday(692, Date.UTC(2026, 8, 14, 12, 29, 0));
  assert.strictEqual(
    new Date(before).toISOString(),
    "2026-09-13T12:28:00.000Z",
  );
  assert.strictEqual(new Date(after).toISOString(), "2026-09-14T12:28:00.000Z");
});

test("shipMidnightToday falls back to browser-local midnight when offset is null", async () => {
  const { shipMidnightToday } = await import(
    `file://${require("path").join(PUBLIC, "ep-ship-time.js")}`
  );
  const noon = new Date(2026, 8, 14, 13, 0, 0).getTime();
  assert.strictEqual(
    shipMidnightToday(null, noon),
    new Date(2026, 8, 14).getTime(),
  );
});
