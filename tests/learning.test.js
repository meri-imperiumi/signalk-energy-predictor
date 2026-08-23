/**
 * Tests for the learning module.
 * @file learning.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SolarMatrix,
  anchoredKey,
  sailingKey,
  theoreticalPower,
  observedEfficiency,
  emaUpdate,
  isValidTick,
} = require("../plugin/learning.js");

test.describe("SolarMatrix", () => {
  test.describe("anchoredKey", () => {
    test("generates consistent keys for same azimuth/elevation", () => {
      const key1 = anchoredKey(0, Math.PI / 4);
      const key2 = anchoredKey(0.001, Math.PI / 4 + 0.001);
      assert.strictEqual(key1, key2);
    });

    test("bins azimuth in 15° increments", () => {
      const key0 = anchoredKey(0, 0);
      const key7 = anchoredKey((7 * Math.PI) / 180, 0);
      const key30 = anchoredKey((30 * Math.PI) / 180, 0);
      const keyNeg7 = anchoredKey((-7 * Math.PI) / 180, 0);
      const keyNeg30 = anchoredKey((-30 * Math.PI) / 180, 0);

      assert.ok(typeof key0 === "string" && key0.includes("_"));
      assert.strictEqual(key0, key7);
      assert.notStrictEqual(key30, key0);
      assert.strictEqual(keyNeg7, "-15_0");
      assert.notStrictEqual(keyNeg30, key0);
    });

    test("bins elevation in 10° increments", () => {
      const key1 = anchoredKey(0, 0);
      const key2 = anchoredKey(0, (5 * Math.PI) / 180);
      assert.ok(key1.includes("_"));
      assert.strictEqual(key1.split("_")[1], "0");
      assert.strictEqual(key2.split("_")[1], "0");
    });
  });

  test.describe("sailingKey", () => {
    test("includes AWA in the key", () => {
      const key = sailingKey(0, Math.PI / 4, Math.PI / 2);
      assert.match(key, /\d+_\d+_\d+/);
    });

    test("bins AWA in 30° increments", () => {
      const key15 = sailingKey(0, 0, (15 * Math.PI) / 180);
      const key45 = sailingKey(0, 0, (45 * Math.PI) / 180);
      const key90 = sailingKey(0, 0, (90 * Math.PI) / 180);
      const key120 = sailingKey(0, 0, (120 * Math.PI) / 180);

      const parts15 = key15.split("_");
      const parts45 = key45.split("_");
      const parts90 = key90.split("_");
      const parts120 = key120.split("_");

      assert.strictEqual(parts15.length, 3);
      assert.strictEqual(parts45.length, 3);
      assert.strictEqual(parts90.length, 3);
      assert.strictEqual(parts120.length, 3);
    });
  });

  test.describe("theoreticalPower", () => {
    test("scales nameplate by GHI/1000 (STC rated at 1000 W/m²)", () => {
      // 100 Wp panel at 683.5 W/m² -> 68.35 W theoretical
      assert.strictEqual(theoreticalPower(100, 683.5, Math.PI / 6), 68.35);
    });

    test("does not double-discount sun elevation (GHI already encodes it)", () => {
      // Same GHI at two different sun elevations must give the same power:
      // the old formula multiplied by sin(elevation), making low-sun output
      // ~2× too low and pushing observed efficiency past 1.0.
      const high = theoreticalPower(100, 800, Math.PI / 2);
      const low = theoreticalPower(100, 800, Math.PI / 6);
      assert.strictEqual(high, 80);
      assert.strictEqual(low, 80);
    });

    test("returns zero when elevation is negative (night gate)", () => {
      const power = theoreticalPower(100, 1367, -Math.PI / 6);
      assert.strictEqual(power, 0);
    });

    test("returns zero when elevation is zero (night gate)", () => {
      const power = theoreticalPower(100, 1367, 0);
      assert.strictEqual(power, 0);
    });

    test("returns zero when GHI is zero", () => {
      const power = theoreticalPower(100, 0, Math.PI / 4);
      assert.strictEqual(power, 0);
    });
  });

  test.describe("observedEfficiency", () => {
    test("calculates efficiency as actual/theoretical", () => {
      const eff = observedEfficiency(50, 100);
      assert.strictEqual(eff, 0.5);
    });

    test("clamps to 0 when below", () => {
      assert.strictEqual(observedEfficiency(-10, 100), 0);
    });

    test("clamps to 1 when above", () => {
      assert.strictEqual(observedEfficiency(150, 100), 1);
    });

    test("returns 0 when theoretical power is zero", () => {
      assert.strictEqual(observedEfficiency(50, 0), 0);
    });
  });

  test.describe("emaUpdate", () => {
    test("applies EMA formula correctly", () => {
      const updated = emaUpdate(0.5, 0.8, 0.1);
      assert.strictEqual(updated, 0.53);
    });

    test("uses default alpha when not specified", () => {
      const updated = emaUpdate(0.5, 0.8);
      assert.strictEqual(updated, 0.515);
    });
  });

  test.describe("isValidTick", () => {
    test("passes valid tick", () => {
      const readings = {
        engineRunning: false,
        batterySoc: 0.6,
        shorePowerConnected: false,
        controllerMode: "bulk",
      };
      assert.strictEqual(isValidTick(readings), true);
    });

    test("rejects when engine is running", () => {
      const readings = {
        engineRunning: true,
        batterySoc: 0.6,
        shorePowerConnected: false,
      };
      assert.strictEqual(isValidTick(readings), false);
    });

    test("rejects when battery is full", () => {
      const readings = {
        engineRunning: false,
        batterySoc: 0.9,
        shorePowerConnected: false,
      };
      assert.strictEqual(isValidTick(readings), false);
    });

    test("rejects when shore power is connected", () => {
      const readings = {
        engineRunning: false,
        batterySoc: 0.6,
        shorePowerConnected: true,
      };
      assert.strictEqual(isValidTick(readings), false);
    });

    test("rejects when controller mode is not bulk", () => {
      const readings = {
        engineRunning: false,
        batterySoc: 0.6,
        shorePowerConnected: false,
        controllerMode: "absorption",
      };
      assert.strictEqual(isValidTick(readings), false);
    });

    test("accepts operationMode 'mppt active' as bulk-equivalent", () => {
      // Victron `operationMode` uses a different vocabulary than
      // `controllerMode`: 'mppt active' is the freely-tracking (bulk)
      // state. The deployable FLINsail array reports operationMode, so the
      // gate must accept it or every flinsail tick is dropped.
      for (const mode of ["mppt active"]) {
        assert.strictEqual(
          isValidTick({
            engineRunning: false,
            batterySoc: 0.6,
            shorePowerConnected: false,
            controllerMode: mode,
          }),
          true,
          `${mode} should be bulk-equivalent`,
        );
      }
    });

    test("rejects limited/off operationMode values", () => {
      for (const mode of [
        "voltage/current limited",
        "off",
        "external control",
        "not charging",
        "float",
      ]) {
        assert.strictEqual(
          isValidTick({
            engineRunning: false,
            batterySoc: 0.6,
            shorePowerConnected: false,
            controllerMode: mode,
          }),
          false,
          `${mode} should be rejected`,
        );
      }
    });

    test("passes when controller mode is null", () => {
      const readings = {
        engineRunning: false,
        batterySoc: 0.6,
        shorePowerConnected: false,
        controllerMode: null,
      };
      assert.strictEqual(isValidTick(readings), true);
    });
  });

  test.describe("SolarMatrix class", () => {
    test("creates matrix with given ID", () => {
      const matrix = new SolarMatrix("test-array");
      assert.strictEqual(matrix.arrayId, "test-array");
    });

    test("returns default efficiency for unknown anchored bin", () => {
      const matrix = new SolarMatrix("test-array");
      const eff = matrix.getAnchored(0, Math.PI / 4);
      assert.strictEqual(eff, 0.7);
    });

    test("returns default efficiency for unknown sailing bin", () => {
      const matrix = new SolarMatrix("test-array");
      // No anchored bin learned either -> flat default
      const eff = matrix.getSailing(0, Math.PI / 4, Math.PI / 2);
      assert.strictEqual(eff, 0.7);
    });

    test("falls back to anchored bin for unknown sailing bin", () => {
      // Rig shading is shared between at-rest and under-sail conditions, so
      // an unlearned sailing bin inherits the anchored eta for the same sun
      // position instead of the flat 0.7 default. This avoids over-prediction
      // on sparse sailing bins (the anchored matrix converges faster because
      // it sees far more ticks).
      const matrix = new SolarMatrix("test-array");
      matrix.anchored.set("0_40", 0.42);
      const eff = matrix.getSailing(0, Math.PI / 4, Math.PI / 2);
      assert.strictEqual(eff, 0.42);
    });

    test("updates anchored matrix on valid tick", () => {
      const matrix = new SolarMatrix("test-array");
      const result = matrix.update({
        navState: "anchored",
        actualPowerW: 50,
        capacityWp: 100,
        ghi: 683.5,
        sunAzimuthRad: 0,
        sunElevationRad: Math.PI / 6,
        awaRad: null,
        readings: {
          engineRunning: false,
          batterySoc: 0.6,
          shorePowerConnected: false,
        },
      });
      assert.strictEqual(result, true);
    });

    test("does not update on invalid tick", () => {
      const matrix = new SolarMatrix("test-array");
      const result = matrix.update({
        navState: "anchored",
        actualPowerW: 50,
        capacityWp: 100,
        ghi: 683.5,
        sunAzimuthRad: 0,
        sunElevationRad: Math.PI / 6,
        awaRad: null,
        readings: {
          engineRunning: true,
          batterySoc: 0.6,
          shorePowerConnected: false,
        },
      });
      assert.strictEqual(result, false);
    });

    test("serializes to JSON", () => {
      const matrix = new SolarMatrix("test-array");
      matrix.update({
        navState: "anchored",
        actualPowerW: 50,
        capacityWp: 100,
        ghi: 683.5,
        sunAzimuthRad: 0,
        sunElevationRad: Math.PI / 6,
        awaRad: null,
        readings: {
          engineRunning: false,
          batterySoc: 0.6,
          shorePowerConnected: false,
        },
      });

      const json = matrix.toJSON();
      assert.strictEqual(json.arrayId, "test-array");
      assert.ok(typeof json.anchored === "object");
      assert.ok(typeof json.sailing === "object");
    });

    test("deserializes from JSON", () => {
      const json = {
        arrayId: "test-array",
        anchored: { "0_30": 0.6 },
        sailing: { "0_30_90": 0.55 },
      };

      const matrix = SolarMatrix.fromJSON(json);
      assert.strictEqual(matrix.arrayId, "test-array");
      assert.strictEqual(matrix.anchored.get("0_30"), 0.6);
      assert.strictEqual(matrix.sailing.get("0_30_90"), 0.55);
    });
  });
});
