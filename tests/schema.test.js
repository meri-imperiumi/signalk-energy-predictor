/**
 * Tests for the schema validation.
 * @file schema.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPluginSchema,
  parseManufacturerCurve,
  getActiveCapacity,
  getDisplayName,
  validateConfig,
} = require("../plugin/schema.js");

test.describe("validateConfig", () => {
  test("passes with valid config with unique paths", () => {
    const config = {
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
        socPath: "electrical.batteries.house.capacity.stateOfCharge",
        engineAlternatorWatts: 100,
      },
      solarArrays: [
        {
          id: "cabin-roof",
          name: "Cabin Roof",
          type: "fixed",
          powerPath: "electrical.solar.cabin.roof.power",
          capacityWp: 200,
          enabled: true,
        },
        {
          id: "flinsail",
          name: "FLINsail",
          type: "deployable",
          powerPath: "electrical.solar.flinsail.power",
          gustLimitKnots: 20,
          capacityWp: 150,
          enabled: true,
        },
      ],
      mechanicalGenerators: [
        {
          id: "hydro-shaft",
          name: "HydroGenerator",
          type: "hydro",
          deployable: true,
          minSpeedKnots: 3,
          maxSpeedKnots: 12,
          powerPath: "electrical.hydro.shaft.power",
          manufacturerCurve: "2,10,3,30,4,50,5,70,6,80,7,90,8,100",
          enabled: true,
        },
      ],
    };

    const result = validateConfig(config);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.warnings.length, 0);
  });

  test("warns about duplicate power paths", () => {
    const config = {
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
      },
      solarArrays: [
        {
          id: "cabin-roof",
          type: "fixed",
          powerPath: "electrical.solar.cabin.roof.power",
          capacityWp: 200,
          enabled: true,
        },
        {
          id: "cockpit-roof",
          type: "fixed",
          powerPath: "electrical.solar.cabin.roof.power", // Duplicate!
          capacityWp: 100,
          enabled: true,
        },
      ],
      mechanicalGenerators: [],
    };

    const result = validateConfig(config);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /Duplicate power path.*cabin-roof/);
  });

  test("warns about duplicate controller mode paths", () => {
    const config = {
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
      },
      solarArrays: [
        {
          id: "cabin-roof",
          type: "fixed",
          powerPath: "electrical.solar.cabin.roof.power",
          capacityWp: 200,
          enabled: true,
          controllerModePath: "electrical.solar.cabin-roof.mode",
        },
        {
          id: "flinsail",
          type: "deployable",
          powerPath: "electrical.solar.flinsail.power",
          capacityWp: 150,
          enabled: true,
          controllerModePath: "electrical.solar.cabin-roof.mode", // Duplicate!
        },
      ],
      mechanicalGenerators: [],
    };

    const result = validateConfig(config);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /Duplicate controller mode path/);
  });

  test("warns about generator sharing power path", () => {
    const config = {
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
      },
      solarArrays: [],
      mechanicalGenerators: [
        {
          id: "wind-aft",
          type: "wind",
          powerPath: "electrical.generator.wind-aft.power",
          manufacturerCurve: "5,10,10,50,15,120,20,200",
          enabled: true,
        },
        {
          id: "wind-cockpit",
          type: "wind",
          powerPath: "electrical.generator.wind-aft.power", // Duplicate!
          manufacturerCurve: "5,10,10,50,15,120,20,200",
          enabled: true,
        },
      ],
    };

    const result = validateConfig(config);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.warnings.length, 1);
    assert.match(result.warnings[0], /Generator shares power path.*wind-aft/);
  });

  test("handles empty config gracefully", () => {
    const result = validateConfig({});
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.warnings.length, 0);
  });

  test("handles missing solar arrays", () => {
    const result = validateConfig({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      mechanicalGenerators: [],
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.warnings.length, 0);
  });

  test("handles missing mechanical generators", () => {
    const result = validateConfig({
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [],
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.warnings.length, 0);
  });

  test("handles null/undefined values for paths", () => {
    const config = {
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [
        {
          id: "cabin-roof",
          type: "fixed",
          powerPath: null, // Null - no warnings expected
          capacityWp: 200,
          enabled: true,
        },
        {
          id: "cockpit-roof",
          type: "fixed",
          controllerModePath: null, // Null - no warnings expected
          capacityWp: 100,
          enabled: true,
        },
      ],
      mechanicalGenerators: [
        {
          id: "wind-aft",
          type: "wind",
          powerPath: null, // Null - no warnings expected
          manufacturerCurve: "5,10,10,50,15,120,20,200",
          enabled: true,
        },
      ],
    };

    const result = validateConfig(config);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.warnings.length, 0);
  });

  test("allows same path on disabled devices", () => {
    const config = {
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [
        {
          id: "cabin-roof",
          type: "fixed",
          powerPath: "electrical.solar.cabin.roof.power",
          capacityWp: 200,
          enabled: true,
        },
        {
          id: "old-roof",
          type: "fixed",
          powerPath: "electrical.solar.cabin.roof.power", // Same path but different ID
          capacityWp: 150,
          enabled: false, // Disabled - no warning
        },
      ],
      mechanicalGenerators: [],
    };

    const result = validateConfig(config);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.warnings.length, 0);
  });
});

test.describe("parseManufacturerCurve", () => {
  test("parses the documented Superwind 350 power curve", () => {
    // Matches the curve documented in README.md as the primary example.
    const curve = parseManufacturerCurve(
      "5,5,10,15,15,55,20,140,25,250,28,350,30,300",
    );
    assert.deepEqual(curve, [
      { speed: 5, watts: 5 },
      { speed: 10, watts: 15 },
      { speed: 15, watts: 55 },
      { speed: 20, watts: 140 },
      { speed: 25, watts: 250 },
      { speed: 28, watts: 350 },
      { speed: 30, watts: 300 },
    ]);
  });

  test("sorts curve points by speed regardless of input order", () => {
    const curve = parseManufacturerCurve(
      "28,350,5,5,20,140,10,15,30,300,25,250,15,55",
    );
    assert.deepEqual(
      curve.map((p) => p.speed),
      [5, 10, 15, 20, 25, 28, 30],
    );
  });

  test("manufacturerCurve pattern tolerates whitespace and decimals", () => {
    const schema = buildPluginSchema();
    const pattern =
      schema.properties.mechanicalGenerators.items.properties.manufacturerCurve
        .pattern;
    const re = new RegExp(pattern);
    const accepted = [
      "5,5,10,15,15,55,20,140,25,250,28,350,30,300",
      " 5,5,10,15,15,55,20,140,25,250,28,350,30,300 ",
      "5, 5, 10, 15, 15, 55, 20, 140, 25, 250, 28, 350, 30, 300",
      "5,5,10,15,15,55,20,140,25,250,28,350,30,300\n",
      "5.5,10.5,10,50",
    ];
    for (const v of accepted) {
      assert.ok(re.test(v), `pattern should accept ${JSON.stringify(v)}`);
    }
    const rejected = [
      "5,abc,10,50",
      "5,10,10,50,",
      ",5,10",
      "5",
      '5,5,10,15,15,55,20,140,25,250,28,350,30,300"',
    ];
    for (const v of rejected) {
      assert.ok(!re.test(v), `pattern should reject ${JSON.stringify(v)}`);
    }
  });
});
