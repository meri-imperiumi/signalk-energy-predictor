const { test } = require("node:test");
const assert = require("node:assert");

const {
  sunPosition,
  sunTimes,
  nextSunrise,
  nextSunset,
  lastSunset,
  maxIrradiance,
} = require("../plugin/solar.js");

test("sunPosition returns north-based azimuth in radians", () => {
  // Helsinki, 2026-06-21 12:00 UTC: sun in the southwest, well above horizon
  const { altitude, azimuth } = sunPosition(
    new Date("2026-06-21T12:00:00Z"),
    60.17,
    24.94,
  );
  assert.ok(altitude > 0, "sun above horizon at noon");
  assert.ok(altitude < Math.PI / 2);
  // Almanac azimuth is north-based clockwise; 15:00 local sun in Helsinki
  // is southwest (~216°), which normalizes to about -2.5 rad in [-π, π)
  assert.ok(
    azimuth > -2.8 && azimuth < -2.2,
    `azimuth near southwest, got ${azimuth}`,
  );
});

test("sunPosition degrades to NaN outside the supported range", () => {
  assert.ok(Number.isNaN(sunPosition(new Date("1900-01-01"), 60, 25).altitude));
  assert.ok(Number.isNaN(sunPosition(new Date("2200-01-01"), 60, 25).azimuth));
  assert.ok(Number.isNaN(sunPosition(new Date("not a date"), 60, 25).altitude));
});

test("sunTimes returns rise and set for the solar day", () => {
  const times = sunTimes(new Date("2024-06-21T12:00:00Z"), 37.77, -122.42);
  assert.ok(times.sunrise instanceof Date);
  assert.ok(times.sunset instanceof Date);
  assert.ok(times.sunrise < times.sunset);
  assert.strictEqual(times.alwaysUp, false);
  assert.strictEqual(times.alwaysDown, false);
});

test("sunTimes tells polar day from polar night", () => {
  // Svalbard midsummer: sun never sets
  const polarDay = sunTimes(new Date("2024-06-21T12:00:00Z"), 78.22, 15.63);
  assert.strictEqual(polarDay.sunrise, null);
  assert.strictEqual(polarDay.sunset, null);
  assert.strictEqual(polarDay.alwaysUp, true);

  // Svalbard midwinter: sun never rises
  const polarNight = sunTimes(new Date("2024-01-01T12:00:00Z"), 78.22, 15.63);
  assert.strictEqual(polarNight.sunrise, null);
  assert.strictEqual(polarNight.sunset, null);
  assert.strictEqual(polarNight.alwaysDown, true);
});

test("sunTimes boundary: noon altitude alone does not decide polar day", () => {
  // 70.55N on 2024-11-22: the Sun's refracted centre altitude at upper
  // transit is about -0.22°, above -0.27° but below the horizon. The
  // sunrise/set horizon convention must win over the raw altitude, so
  // this is polar night, not polar day.
  const times = sunTimes(new Date("2024-11-22T12:00:00Z"), 70.55, 0);
  assert.strictEqual(times.sunrise, null);
  assert.strictEqual(times.sunset, null);
  assert.strictEqual(times.alwaysUp, false);
  assert.strictEqual(times.alwaysDown, true);
});

test("sunTimes degrades to nulls outside the supported range", () => {
  const times = sunTimes(new Date("1900-01-01"), 60, 25);
  assert.strictEqual(times.sunrise, null);
  assert.strictEqual(times.sunset, null);
  assert.strictEqual(times.alwaysUp, false);
  assert.strictEqual(times.alwaysDown, false);
});

test("nextSunrise and nextSunset find the following events", () => {
  const start = new Date("2026-03-20T12:00:00Z");
  const sunrise = nextSunrise(start, 48.4284, -123.3656);
  const sunset = nextSunset(start, 48.4284, -123.3656);
  assert.ok(sunrise > start, "next sunrise is in the future");
  assert.ok(sunset > start, "next sunset is in the future");
  // Equinox: roughly 12 hours apart
  const dayLength = sunset - sunrise;
  assert.ok(
    dayLength > 11 * 3600000 && dayLength < 13 * 3600000,
    `day length near 12 h, got ${dayLength / 3600000} h`,
  );
});

test("lastSunset finds the sunset that started the night", () => {
  // Local midnight at Victoria BC (UTC-7): the previous evening's sunset
  const midnight = new Date("2026-03-21T07:00:00Z");
  const sunset = lastSunset(midnight, 48.4284, -123.3656);
  assert.ok(sunset instanceof Date);
  assert.ok(sunset <= midnight);
  assert.ok(sunset > new Date(midnight.getTime() - 24 * 3600000));
  // For a time in the afternoon, the most recent sunset is the previous day's
  const afternoon = new Date("2026-03-20T22:00:00Z");
  const prev = lastSunset(afternoon, 48.4284, -123.3656);
  assert.ok(prev <= new Date("2026-03-20T14:00:00Z"));
});

test("event searches return null in polar conditions", () => {
  const midsummer = new Date("2024-06-21T12:00:00Z");
  assert.strictEqual(nextSunrise(midsummer, 78.22, 15.63), null);
  assert.strictEqual(nextSunset(midsummer, 78.22, 15.63), null);
  assert.strictEqual(lastSunset(midsummer, 78.22, 15.63), null);
  assert.strictEqual(nextSunrise(new Date("1900-01-01"), 60, 25), null);
});

test("maxIrradiance stays zero below the horizon", () => {
  assert.strictEqual(maxIrradiance(-0.1), 0);
  assert.strictEqual(maxIrradiance(0), 0);
  assert.ok(maxIrradiance(Math.PI / 2) > 900);
});
