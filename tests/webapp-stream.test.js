/**
 * Stream smoketests: the webapp's Signal K stream module subscribes to
 * both the prediction path and environment.mode with minPeriod
 * throttling, drives day/night reactivity, reconnects with exponential
 * backoff and reports connection state. Exercised against a fake
 * WebSocket since the module only touches browser globals in connect().
 * @file webapp-stream.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");
const path = require("node:path");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

/** Capturing stand-in for the browser WebSocket. */
class FakeSocket extends EventTarget {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    /** @type {string[]} */
    this.sent = [];
    FakeSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.dispatchEvent(new Event("close"));
  }

  emitOpen() {
    this.dispatchEvent(new Event("open"));
  }

  emitDelta(path, value) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          updates: [{ values: [{ path, value }] }],
        }),
      }),
    );
  }
}

/**
 * Runs the async body with the browser globals the stream module reads
 * (WebSocket, window.location) faked for the whole duration — connect()
 * touches them at call time, not just at import time.
 * @param {() => Promise<void>} body
 */
async function withFakes(body) {
  const RealWebSocket = globalThis.WebSocket;
  const realWindow = globalThis.window;
  globalThis.WebSocket = FakeSocket;
  globalThis.window = { location: { protocol: "http:", host: "localhost" } };
  try {
    await body();
  } finally {
    globalThis.WebSocket = RealWebSocket;
    globalThis.window = realWindow;
  }
}

test("stream subscribes to forecast and environment.mode with minPeriod", async () => {
  await withFakes(async () => {
    const { SignalKStream } = await import(
      `file://${path.join(PUBLIC_DIR, "ep-signalk-stream.js")}`
    );
    FakeSocket.instances = [];
    const stream = new SignalKStream({});
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stream.connect();
      const socket = FakeSocket.instances.at(-1);
      socket.emitOpen();
      assert.strictEqual(socket.sent.length, 1, "one subscription message");
      const msg = JSON.parse(socket.sent[0]);
      const paths = msg.subscribe.map((s) => s.path);
      assert.ok(paths.includes("electrical.energy.prediction.forecast.hourly"));
      assert.ok(paths.includes("environment.mode"));
      for (const sub of msg.subscribe) {
        assert.ok(
          typeof sub.minPeriod === "number" && sub.minPeriod >= 1000,
          `subscription for ${sub.path} must be throttled with minPeriod`,
        );
      }
    } finally {
      stream.close();
      mock.timers.reset();
    }
  });
});

test("stream forwards environment.mode deltas and cycles", async () => {
  await withFakes(async () => {
    const { SignalKStream } = await import(
      `file://${path.join(PUBLIC_DIR, "ep-signalk-stream.js")}`
    );
    FakeSocket.instances = [];
    const modes = [];
    let cycles = 0;
    const stream = new SignalKStream({
      onMode: (m) => modes.push(m),
      onCycle: () => cycles++,
    });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stream.connect();
      const socket = FakeSocket.instances.at(-1);
      socket.emitOpen();
      socket.emitDelta("environment.mode", "night");
      socket.emitDelta("environment.mode", "day");
      assert.deepStrictEqual(modes, ["night", "day"]);
      socket.emitDelta("electrical.energy.prediction.forecast.hourly", [
        { time: "2026-08-25T12:00:00Z" },
      ]);
      assert.strictEqual(cycles, 0, "cycle refresh is debounced");
      mock.timers.tick(2100);
      assert.strictEqual(cycles, 1);
    } finally {
      stream.close();
      mock.timers.reset();
    }
  });
});

test("stream reports connection status and backs off exponentially", async () => {
  await withFakes(async () => {
    const { SignalKStream } = await import(
      `file://${path.join(PUBLIC_DIR, "ep-signalk-stream.js")}`
    );
    FakeSocket.instances = [];
    const statuses = [];
    const stream = new SignalKStream({ onStatus: (s) => statuses.push(s) });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stream.connect();
      let socket = FakeSocket.instances.at(-1);
      socket.emitOpen();
      assert.deepStrictEqual(statuses, [true]);

      // Drop #1: reconnect after 1s, next backoff doubles to 2s
      socket.close();
      assert.deepStrictEqual(statuses, [true, false]);
      mock.timers.tick(1000);
      socket = FakeSocket.instances.at(-1);
      assert.notStrictEqual(socket, FakeSocket.instances[0], "reconnected");

      // Drop #2 before a successful open: backoff continues 2s → 4s
      socket.close();
      mock.timers.tick(2000);
      socket = FakeSocket.instances.at(-1);
      socket.emitOpen();
      socket.close();
      // The open above resets the backoff: next retry waits only 1s
      mock.timers.tick(999);
      assert.strictEqual(
        FakeSocket.instances.length,
        3,
        "no reconnect before the reset 1s delay",
      );
      mock.timers.tick(1);
      assert.strictEqual(FakeSocket.instances.length, 4, "reconnected at 1s");
    } finally {
      stream.close();
      mock.timers.reset();
    }
  });
});
