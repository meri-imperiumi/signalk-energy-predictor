/**
 * Tests for display formatting helpers.
 * @file format.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { formatWh } = require("../plugin/format.js");

test.describe("formatWh", () => {
  test("keeps whole watt-hours below 1 kWh", () => {
    assert.strictEqual(formatWh(42), "42Wh");
    assert.strictEqual(formatWh(850), "850Wh");
    assert.strictEqual(formatWh(999), "999Wh");
  });

  test("switches to one-decimal kWh at 1 kWh and above", () => {
    assert.strictEqual(formatWh(1000), "1.0kWh");
    assert.strictEqual(formatWh(3470), "3.5kWh");
    assert.strictEqual(formatWh(12400), "12.4kWh");
  });

  test("rounds to nearest whole watt-hour below 1 kWh", () => {
    assert.strictEqual(formatWh(849.6), "850Wh");
  });
});
