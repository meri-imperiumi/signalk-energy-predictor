/**
 * Tests for plugin API surface and dependency correctness.
 * These tests verify that the plugin's external APIs are properly implemented.
 * @file api-surface.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const matrixModule = require("../plugin/matrix.js");
const schemaModule = require("../plugin/schema.js");
const makePlugin = require("../plugin/index.js");

class FakeStreamBundle {
  constructor() {
    this.subscriptions = [];
    this.bus = {
      getdelta: (subscription, deltaHandler) => {
        this.subscriptions.push({ subscription, deltaHandler });
        return () => {
          const idx = this.subscriptions.findIndex(
            (s) =>
              s.subscription === subscription &&
              s.deltaHandler === deltaHandler,
          );
          if (idx >= 0) this.subscriptions.splice(idx, 1);
        };
      },
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

class FakeSignalKApp extends require("node:events") {
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
    this.debugCalls = [];
    this.infoCalls = [];
    this.warnCalls = [];
    this.errorCalls = [];
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

  getSelfContext(path) {
    return this.selfId + "." + path;
  }

  setPluginStatus(status) {
    this.setPluginStatusCalls.push(status);
  }

  debug(msg) {
    this.debugCalls.push(msg);
  }

  info(msg) {
    this.infoCalls.push(msg);
  }

  warn(msg) {
    this.warnCalls.push(msg);
  }

  error(msg) {
    this.errorCalls.push(msg);
  }
}

test.describe("API Surface Tests", () => {
  test("matrix module exports required functions", () => {
    // These functions are required by the plugin's deps object
    assert.strictEqual(
      typeof matrixModule.loadAllMatrices,
      "function",
      "matrixModule.loadAllMatrices must be a function (used by deps.loadMatrices)",
    );
    assert.strictEqual(
      typeof matrixModule.saveMatrices,
      "function",
      "matrixModule.saveMatrices must be a function (used by deps.saveMatrices)",
    );
    assert.strictEqual(
      typeof matrixModule.loadMatrix,
      "function",
      "matrixModule.loadMatrix must be a function",
    );
    assert.strictEqual(
      typeof matrixModule.saveMatrix,
      "function",
      "matrixModule.saveMatrix must be a function",
    );
  });

  test("schema module exports validateConfig", () => {
    assert.strictEqual(
      typeof schemaModule.validateConfig,
      "function",
      "schemaModule.validateConfig must be a function (used by deps.validateConfig)",
    );
  });

  test("schema validateConfig returns expected structure", () => {
    const result = schemaModule.validateConfig({});
    assert.ok(typeof result === "object", "validateConfig returns an object");
    assert.strictEqual(
      typeof result.valid,
      "boolean",
      "result.valid is a boolean",
    );
    assert.ok(Array.isArray(result.warnings), "result.warnings is an array");
    assert.strictEqual(result.valid, true, "Empty config is valid");
    assert.strictEqual(
      result.warnings.length,
      0,
      "Empty config has no warnings",
    );
  });

  test("schema validateConfig detects duplicate paths", () => {
    const config = {
      solarArrays: [
        { id: "a1", powerPath: "electrical.solar.1.power", enabled: true },
        { id: "a2", powerPath: "electrical.solar.1.power", enabled: true },
      ],
    };
    const result = schemaModule.validateConfig(config);
    assert.strictEqual(result.valid, true);
    assert.ok(result.warnings.length > 0, "Should warn about duplicate paths");
    assert.ok(
      result.warnings.some((w) => w.includes("Duplicate power path")),
      "Warning should mention duplicate power path",
    );
  });

  test("fake app implements required Signal K API", () => {
    const app = new FakeSignalKApp();

    // These are the minimum methods the plugin requires
    assert.strictEqual(
      typeof app.getSelfPath,
      "function",
      "app.getSelfPath must be a function",
    );
    assert.strictEqual(
      typeof app.setSelfPath,
      "function",
      "app.setSelfPath must be a function",
    );
    assert.strictEqual(
      typeof app.getDataPath,
      "function",
      "app.getDataPath must be a function",
    );
    assert.strictEqual(
      typeof app.debug,
      "function",
      "app.debug must be a function",
    );
    assert.strictEqual(
      typeof app.info,
      "function",
      "app.info must be a function",
    );
    assert.strictEqual(
      typeof app.warn,
      "function",
      "app.warn must be a function",
    );
    assert.strictEqual(
      typeof app.error,
      "function",
      "app.error must be a function",
    );
    assert.strictEqual(
      typeof app.setPluginStatus,
      "function",
      "app.setPluginStatus must be a function",
    );
    assert.strictEqual(
      typeof app.subscriptionmanager,
      "object",
      "app.subscriptionmanager must be an object",
    );
    assert.strictEqual(
      typeof app.subscriptionmanager.subscribe,
      "function",
      "app.subscriptionmanager.subscribe must be a function",
    );
  });

  test("subscriptionmanager.subscribe adds unsubscribe to array", () => {
    const app = new FakeSignalKApp();
    const subscription = {
      context: "vessels.self",
      subscribe: [{ path: "test.path" }],
    };
    const unsubscribes = [];

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      () => {},
      () => {},
    );
    assert.strictEqual(
      unsubscribes.length,
      1,
      "subscribe should add unsubscribe function to array",
    );
    assert.strictEqual(
      typeof unsubscribes[0],
      "function",
      "unsubscribes[0] should be a function",
    );

    // Calling unsubscribe should remove the subscription
    unsubscribes[0]();
    assert.strictEqual(
      app.subscriptionmanager.subscriptions.length,
      0,
      "Unsubscribe should remove the subscription",
    );
  });

  test("plugin can be created with fake app", () => {
    const app = new FakeSignalKApp();
    const plugin = makePlugin(app);

    assert.ok(plugin, "Plugin should be created");
    assert.strictEqual(
      typeof plugin.start,
      "function",
      "Plugin must have start method",
    );
    assert.strictEqual(
      typeof plugin.stop,
      "function",
      "Plugin must have stop method",
    );
  });
});
