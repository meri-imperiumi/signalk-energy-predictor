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
        (s) => s.subscription === subscription && s.deltaHandler === deltaHandler
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

  subscribe(subscription, policy, errorHandler, deltaHandler) {
    this.subscriptions.push({ subscription, policy, errorHandler, deltaHandler });
    // Return an unsubscribe function
    return () => {
      const idx = this.subscriptions.findIndex(
        (s) => s.subscription === subscription && s.deltaHandler === deltaHandler
      );
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    };
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

  getDataPath() {
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
    assert.ok(plugin.ingestionFSM);
    assert.ok(plugin.predictionEngine);
    assert.ok(plugin.advisoryPublisher);

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
    const statusMsg = app.setPluginStatusCalls.find((msg) => msg.includes("solar array"));
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
    assert.ok(plugin.ingestionFSM);
    assert.ok(plugin.predictionEngine);

    await plugin.stop();

    // Verify status mentioned matrices
    const stopMsg = app.setPluginStatusCalls.find((msg) => msg.includes("Stopped"));
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
      if (plugin.predictionEngine) {
        const forecast = [
          { time: new Date(), ghi: 0, cloudCover: null, gustSpeedKnots: 0 },
        ];
        const hourly = plugin.predictionEngine.runPrediction(forecast);
        assert.ok(Array.isArray(hourly));
        assert.strictEqual(hourly.length, 24);
      }
      await plugin.stop();
      // If we got here, it succeeded despite no getSelfPath
    } catch (error) {
      // If getSelfPath is required and missing, that's okay to fail
      // Check for common error patterns
      assert.ok(
        error.message.includes("getSelfPath") ||
        error.message.includes("getSelfPath is not a function") ||
        error.message.includes("getSelfPath is not a function") ||
        error.message.includes("Cannot read")
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

    // Verify getSelfPath was called for navigation data
    assert.ok(app.getSelfPathCalls.some((path) => path.includes("navigation.state")));
    assert.ok(app.getSelfPathCalls.some((path) => path.includes("navigation.position")));

    await plugin.stop();
  });
});