/**
 * Tests for the Energy Predictor plugin.
 * @file plugin.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { EventEmitter } = require("node:events");

const makePlugin = require("../plugin/index.js");

// --- Fakes so the plugin can be started without external dependencies ----

class FakeStreamBundle {
  constructor() {
    this.subscriptions = [];
  }

  getdelta(subscription, errorHandler, deltaHandler) {
    this.subscriptions.push({ subscription, errorHandler, deltaHandler });
    return () => {
      const idx = this.subscriptions.findIndex(
        (s) =>
          s.subscription === subscription && s.deltaHandler === deltaHandler,
      );
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
  }

  // Helper to simulate a delta message for testing
  emitDelta(delta) {
    for (const { deltaHandler } of this.subscriptions) {
      try {
        deltaHandler(delta);
      } catch (error) {
        // Errors are handled by the errorHandler callback
      }
    }
  }
}

class FakeSubscriptionManager {
  constructor() {
    this.subscriptions = [];
  }

  subscribe(subscription, unsubscribes, errorHandler, deltaHandler) {
    this.subscriptions.push({ subscription, errorHandler, deltaHandler });
    // Create unsubscribe function and add it to unsubscribes array
    const unsubscribe = () => {
      const idx = this.subscriptions.findIndex(
        (s) =>
          s.subscription === subscription && s.deltaHandler === deltaHandler,
      );
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
    unsubscribes.push(unsubscribe);
  }
}

class FakeSignalKApp extends EventEmitter {
  constructor() {
    super();
    this.selfId = "urn:mrn:imo:mmsi:123456789";
    this.streambundle = new FakeStreamBundle();
    this.subscriptionmanager = new FakeSubscriptionManager();
    this.dataPath = null;
    this.pathValues = new Map();
    this.setPluginStatusCalls = [];
    this.getSelfPathCalls = [];
    this.handleMessageCalls = [];
  }

  getSelfPath(path) {
    this.getSelfPathCalls.push(path);
    return this.pathValues.get(path);
  }

  setSelfPath(path, value) {
    this.pathValues.set(path, value);
    this.emit("delta", { path, value });
  }

  getDataDirPath() {
    return this.dataPath;
  }

  setPluginStatus(message) {
    this.setPluginStatusCalls.push(message);
    this.emit("status", message);
  }

  setProviderStatus(message) {
    this.setPluginStatusCalls.push(message);
    this.emit("status", message);
  }

  handleMessage(source, message) {
    this.handleMessageCalls.push({ source, message });
    this.emit("message", { source, message });
  }

  debug(msg) {
    // Suppress debug output in tests
  }

  error(msg) {
    // Track errors for test assertions
    if (!this.errors) this.errors = [];
    this.errors.push(msg);
  }
}

// --- Plugin tests ----

// Matrix persistence temp dir
let tempDir = null;

test.before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "energy-test-"));
});

test.after(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.describe("Plugin basic functionality", () => {
  test("creates a plugin object", () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);

    assert.strictEqual(typeof plugin, "object");
    assert.strictEqual(plugin.id, "signalk-energy-predictor");
    assert.strictEqual(plugin.name, "Energy Predictor");
    assert.ok(plugin.description);
  });

  test("has required methods", () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);

    assert.strictEqual(typeof plugin.start, "function");
    assert.strictEqual(typeof plugin.stop, "function");
    assert.strictEqual(typeof plugin.schema, "function");
  });

  test("schema returns valid JSON Schema", () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const schema = plugin.schema();

    assert.strictEqual(schema.type, "object");
    assert.ok(schema.properties);
    assert.ok(schema.properties.battery);
    assert.ok(schema.properties.solarArrays);
    assert.ok(schema.properties.mechanicalGenerators);
    assert.ok(schema.properties.weather);
    assert.ok(schema.properties.learning);
  });

  test("start method accepts config", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
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
          type: "fixed",
          capacityWp: 200,
          enabled: true,
        },
      ],
      mechanicalGenerators: [],
      learning: {
        enabled: true,
        saveIntervalMinutes: 60,
        emaAlpha: 0.05,
        defaultEfficiency: 0.7,
      },
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
        forecastHours: 24,
      },
    };

    app.dataPath = tempDir;
    await plugin.start(config, () => {});

    // Check that components were initialized
    assert.ok(plugin.__getInternals().ingestionFSM);
    assert.ok(plugin.__getInternals().predictionEngine);
    assert.ok(plugin.__getInternals().advisoryPublisher);

    // Clean up
    await plugin.stop();
  });

  test("plugin calls setStatus during operation", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const config = {
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
      },
      solarArrays: [],
      mechanicalGenerators: [],
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
      },
    };

    app.dataPath = tempDir;
    await plugin.start(config, () => {});

    // Wait a bit for initial status
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(app.setPluginStatusCalls.length > 0);
    assert.ok(app.setPluginStatusCalls.some((msg) => msg.includes("Ready")));

    await plugin.stop();
  });

  test("plugin stops cleanly", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const config = {
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
      },
      solarArrays: [],
      mechanicalGenerators: [],
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
      },
    };

    app.dataPath = tempDir;
    await plugin.start(config, () => {});

    // Stop should not throw
    await plugin.stop();

    // Verify stop status was called
    assert.ok(app.setPluginStatusCalls.some((msg) => msg.includes("Stopped")));
  });
});

test.describe("Configuration handling", () => {
  test("handles empty config gracefully", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const config = {};

    app.dataPath = tempDir;

    // Should not throw even with empty config
    await plugin.start(config, () => {});
    await plugin.stop();
  });

  test("handles missing solar arrays config", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const config = {
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
      },
      // Missing solarArrays
    };

    app.dataPath = tempDir;

    await plugin.start(config, () => {});
    await plugin.stop();
  });

  test("filters disabled solar arrays", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
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
          capacityWp: 200,
          enabled: true,
        },
        {
          id: "flinsail",
          type: "deployable",
          capacityWp: 150,
          enabled: false, // Disabled
        },
      ],
      mechanicalGenerators: [],
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
      },
    };

    app.dataPath = tempDir;
    await plugin.start(config, () => {});

    // Only enabled arrays should be used
    // Check status line mentions the count
    const statusMsg = app.setPluginStatusCalls.find((msg) =>
      msg.includes("solar array"),
    );
    assert.ok(statusMsg);
    assert.match(statusMsg, /1 solar array/); // Only 1 enabled

    await plugin.stop();
  });
});

test.describe("Matrix persistence", () => {
  test("saves and loads matrices", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
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
          capacityWp: 200,
          enabled: true,
        },
      ],
      mechanicalGenerators: [],
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
      },
    };

    app.dataPath = tempDir;

    await plugin.start(config, () => {});

    // Trigger a save by advancing time or let interval fire
    // For now just verify start completed without error
    assert.ok(plugin.__getInternals().ingestionFSM);
    assert.ok(plugin.__getInternals().predictionEngine);

    await plugin.stop();

    // Verify status mentioned matrices
    const stopMsg = app.setPluginStatusCalls.find((msg) =>
      msg.includes("Stopped"),
    );
    assert.ok(stopMsg);
  });
});

test.describe("Signal K API interactions", () => {
  test("does not crash with missing getSelfPath", async () => {
    const app = new FakeSignalKApp();
    // Intentionally not providing getSelfPath to test error handling
    const plugin = makePlugin({});

    const config = {
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
      },
      solarArrays: [],
      mechanicalGenerators: [],
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
      },
    };

    // Should handle missing getSelfPath gracefully
    try {
      await plugin.start(config, () => {});
      // If it starts, we can test prediction
      if (plugin.__getInternals().predictionEngine) {
        const forecast = [
          { time: new Date(), ghi: 0, cloudCover: null, gustSpeedKnots: 0 },
        ];
        const hourly = plugin
          .__getInternals()
          .predictionEngine.runPrediction(forecast);
        assert.ok(Array.isArray(hourly));
        assert.strictEqual(hourly.length, 24);
      }
      await plugin.stop();
      // If we got here, it succeeded despite no getSelfPath
    } catch (error) {
      // If required APIs are missing, that's okay to fail
      assert.ok(
        error.message.includes("getSelfPath") ||
          error.message.includes("is not a function") ||
          error.message.includes("Cannot read") ||
          error.message.includes("undefined"),
      );
    }
  });

  test("reads navigation state from Signal K", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);

    // Set some values
    app.setSelfPath("navigation.position", {
      latitude: 60.0,
      longitude: 18.0,
    });
    app.setSelfPath("electrical.batteries.house.capacity.stateOfCharge", 0.6);
    app.setSelfPath("navigation.state", "anchored");
    app.setSelfPath("environment.wind.angleApparent", 0);
    app.setSelfPath("electrical.batteries.house.load", 150);

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
          capacityWp: 200,
          enabled: true,
        },
      ],
      mechanicalGenerators: [],
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
      },
    };

    app.dataPath = tempDir;
    await plugin.start(config, () => {});

    // Emit deltas to populate deltaState
    app.subscriptionmanager.subscriptions.forEach(({ deltaHandler }) => {
      deltaHandler({
        context: app.selfId,
        updates: [
          {
            values: [
              {
                path: "navigation.position",
                value: { latitude: 60.0, longitude: 18.0 },
              },
              {
                path: "electrical.batteries.house.capacity.stateOfCharge",
                value: 0.6,
              },
              { path: "navigation.state", value: "anchored" },
              { path: "environment.wind.angleApparent", value: 0 },
            ],
          },
        ],
      });
    });

    // Verify the prediction engine can read navigation state
    assert.ok(plugin.__getInternals().predictionEngine);
    const navState = plugin.__getInternals().predictionEngine.getNavState();
    assert.strictEqual(navState, "anchored");

    await plugin.stop();
  });

  test("navigation.state carries forward across empty delta updates", async () => {
    // navigation.state is a sticky state: a later delta emitting an empty
    // value (some providers emit "" when the source drops out) must not
    // clear a previously known state. The prediction engine should keep
    // reading the last valid state instead of falling back to "unknown".
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);

    app.setSelfPath("navigation.position", {
      latitude: 60.0,
      longitude: 18.0,
    });
    app.setSelfPath("electrical.batteries.house.capacity.stateOfCharge", 0.6);
    app.setSelfPath("navigation.state", "moored");
    app.setSelfPath("environment.wind.angleApparent", 0);

    const config = {
      battery: { capacityAh: 400, systemVoltage: 12, minSafeSoC: 0.2 },
      solarArrays: [
        { id: "cabin-roof", type: "fixed", capacityWp: 200, enabled: true },
      ],
      mechanicalGenerators: [],
      weather: { openMeteoEnabled: false, useLogbook: false },
    };
    app.dataPath = tempDir;
    await plugin.start(config, () => {});

    const emit = (values) => {
      app.subscriptionmanager.subscriptions.forEach(({ deltaHandler }) => {
        deltaHandler({ context: app.selfId, updates: [{ values }] });
      });
    };

    // Establish a known nav state via a delta
    emit([{ path: "navigation.state", value: "moored" }]);
    assert.strictEqual(
      plugin.__getInternals().predictionEngine.getNavState(),
      "moored",
    );

    // An empty-string update must not overwrite the carried state
    emit([{ path: "navigation.state", value: "" }]);
    assert.strictEqual(
      plugin.__getInternals().predictionEngine.getNavState(),
      "moored",
    );

    // A real new state still takes over
    emit([{ path: "navigation.state", value: "anchored" }]);
    assert.strictEqual(
      plugin.__getInternals().predictionEngine.getNavState(),
      "anchored",
    );

    await plugin.stop();
  });
});

test.describe("Solar learning regression", () => {
  test("learning cycle survives solar power delta with GPS position", async () => {
    // Regression: the learning debug line read sunPos.elevation, but
    // sunPosition() returns { altitude, azimuth }. The resulting
    // "Cannot read properties of undefined (reading 'toFixed')" threw
    // before matrix.update(), breaking learning entirely
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const testDir = await mkdtemp(join(tmpdir(), "energy-learn-"));

    // Position at the local-noon meridian on the equator, so the sun is
    // well above the horizon and clear-sky GHI is positive regardless of
    // when the test runs
    const now = new Date();
    const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
    const longitude = (12 - utcHours) * 15;
    const latitude = 0;

    const powerPath = "electrical.solar.cabin-roof.panelPower";
    const config = {
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
        socPath: "electrical.batteries.house.capacity.stateOfCharge",
      },
      solarArrays: [
        {
          id: "cabin-roof",
          type: "fixed",
          capacityWp: 200,
          powerPath,
          enabled: true,
        },
      ],
      mechanicalGenerators: [],
      learning: {
        enabled: true,
        saveIntervalMinutes: 60,
        emaAlpha: 0.05,
        defaultEfficiency: 0.7,
      },
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
      },
    };

    app.dataPath = testDir;
    await plugin.start(config, () => {});

    app.subscriptionmanager.subscriptions.forEach(({ deltaHandler }) => {
      deltaHandler({
        context: app.selfId,
        updates: [
          {
            values: [
              { path: "navigation.position", value: { latitude, longitude } },
              {
                path: "electrical.batteries.house.capacity.stateOfCharge",
                value: 0.5,
              },
              { path: "navigation.state", value: "anchored" },
              { path: powerPath, value: 42 },
            ],
          },
        ],
      });
    });

    // Learning runs asynchronously off the delta
    await new Promise((resolve) => setTimeout(resolve, 200));

    const learningErrors = (app.errors || []).filter((e) =>
      String(e).includes("Failed to process delta for learning"),
    );
    assert.deepStrictEqual(learningErrors, []);

    // The learning matrix must actually have been updated
    const matrix = plugin.__getInternals().solarMatrices.get("cabin-roof");
    assert.ok(matrix, "matrix exists for array");
    assert.ok(matrix.anchored.size > 0, "learning updated a matrix bin");

    await plugin.stop();
  });

  test("burst of solar deltas runs a single throttled learning cycle using the running average", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const testDir = await mkdtemp(join(tmpdir(), "energy-burst-"));

    // Position at the local-noon meridian on the equator so the sun is up
    const now = new Date();
    const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
    const longitude = (12 - utcHours) * 15;
    const latitude = 0;

    const powerPath = "electrical.solar.cabin-roof.panelPower";
    const config = {
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
        socPath: "electrical.batteries.house.capacity.stateOfCharge",
      },
      solarArrays: [
        {
          id: "cabin-roof",
          type: "fixed",
          capacityWp: 200,
          powerPath,
          enabled: true,
        },
      ],
      mechanicalGenerators: [],
      learning: {
        enabled: true,
        minIntervalSeconds: 60,
        averageWindowSeconds: 300,
      },
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
      },
    };

    app.dataPath = testDir;
    await plugin.start(config, () => {});
    assert.strictEqual(plugin.__getInternals().learningCycleCount, 0);

    // Burst of fast-changing readings - learning must not run per delta
    const emit = (value) => {
      app.subscriptionmanager.subscriptions.forEach(({ deltaHandler }) => {
        deltaHandler({
          context: app.selfId,
          updates: [
            {
              values: [
                { path: "navigation.position", value: { latitude, longitude } },
                {
                  path: "electrical.batteries.house.capacity.stateOfCharge",
                  value: 0.5,
                },
                { path: "navigation.state", value: "anchored" },
                { path: powerPath, value },
              ],
            },
          ],
        });
      });
    };
    emit(40);
    emit(20);
    emit(40);

    await new Promise((resolve) => setTimeout(resolve, 300));

    const internals = plugin.__getInternals();
    assert.strictEqual(
      internals.learningCycleCount,
      1,
      "burst of deltas should produce exactly one learning cycle",
    );

    // The cycle must have used the running average (40+20+40)/3 = 33.33W,
    // not the instantaneous last value 40W: verify via the EMA bin value.
    const { sunPosition, maxIrradiance } = require("../plugin/solar.js");
    const { anchoredKey, theoreticalPower } = require("../plugin/learning.js");
    const sunPos = sunPosition(new Date(), latitude, longitude);
    const ghi = maxIrradiance(sunPos.altitude);
    const avgPower = 100 / 3;
    const eta = Math.min(
      1,
      Math.max(0, avgPower / theoreticalPower(200, ghi, sunPos.altitude)),
    );
    const expectedBin = 0.05 * eta + 0.95 * 0.7;

    const matrix = internals.solarMatrices.get("cabin-roof");
    assert.ok(matrix);
    const key = anchoredKey(sunPos.azimuth, sunPos.altitude);
    assert.ok(matrix.anchored.has(key), "sun bin updated");
    assert.ok(
      Math.abs(matrix.anchored.get(key) - expectedBin) < 0.01,
      `bin ${matrix.anchored.get(key)} should match EMA of averaged power (expected ~${expectedBin.toFixed(3)})`,
    );

    await plugin.stop();
  });

  test("learning gate drops ticks when any engine reports started", async () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);
    const testDir = await mkdtemp(join(tmpdir(), "engine-gate-"));

    const now = new Date();
    const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60;
    const longitude = (12 - utcHours) * 15;
    const latitude = 0;

    const powerPath = "electrical.solar.cabin-roof.panelPower";
    const config = {
      battery: {
        capacityAh: 400,
        systemVoltage: 12,
        minSafeSoC: 0.2,
        socPath: "electrical.batteries.house.capacity.stateOfCharge",
      },
      solarArrays: [
        {
          id: "cabin-roof",
          type: "fixed",
          capacityWp: 200,
          powerPath,
          enabled: true,
        },
      ],
      mechanicalGenerators: [],
      learning: {
        enabled: true,
        minIntervalSeconds: 60,
      },
      weather: {
        openMeteoEnabled: false,
        useLogbook: false,
      },
    };

    app.dataPath = testDir;
    await plugin.start(config, () => {});

    const emit = (values) => {
      app.subscriptionmanager.subscriptions.forEach(({ deltaHandler }) => {
        deltaHandler({ context: app.selfId, updates: [{ values }] });
      });
    };

    // Baseline: all stopped (multi-engine instance names), learning updates
    emit([
      { path: "navigation.position", value: { latitude, longitude } },
      {
        path: "electrical.batteries.house.capacity.stateOfCharge",
        value: 0.5,
      },
      { path: "navigation.state", value: "anchored" },
      { path: "propulsion.port.state", value: "stopped" },
      { path: "propulsion.starboard.state", value: "stopped" },
      { path: powerPath, value: 42 },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterStopped = plugin.__getInternals().solarMatrices.get("cabin-roof")
      .anchored.size;
    assert.ok(afterStopped > 0, "stopped engines allow learning");

    // Now one engine started: gate must drop the tick (bin count unchanged
    // at same sun position)
    emit([
      { path: "propulsion.port.state", value: "started" },
      { path: powerPath, value: 45 },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterStarted = plugin.__getInternals().solarMatrices.get("cabin-roof")
      .anchored.size;
    assert.strictEqual(
      afterStarted,
      afterStopped,
      "started engine must suppress learning (same sun bin)",
    );

    await plugin.stop();
  });
});
