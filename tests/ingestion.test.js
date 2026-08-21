/**
 * Tests for weather ingestion fallback chain.
 * @file ingestion.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { IngestionFSM, Tier } = require("../plugin/ingestion.js");

function makeApp() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    getSelfPath: () => null,
  };
}

function makeFSM() {
  const fsm = new IngestionFSM(makeApp());
  fsm.position = { latitude: 60.17, longitude: 24.94 };
  return fsm;
}

test.describe("Ingestion fallback chain", () => {
  test("network error in Open-Meteo falls through to Clear Sky", async () => {
    const fsm = makeFSM();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    try {
      const forecast = await fsm.fetchForecast();
      assert.strictEqual(fsm.currentTier, Tier.CLEAR_SKY);
      assert.ok(forecast.length > 0);
      assert.ok(forecast.some((p) => (p.ghi ?? 0) > 0));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("empty forecast from a tier does not count as success", async () => {
    const fsm = makeFSM();
    const origFetch = globalThis.fetch;
    // Open-Meteo times out (throws), Signal K Weather returns empty array
    // (previously a truthy [] "success" that zeroed all predictions)
    globalThis.fetch = async (url) => {
      if (String(url).includes("open-meteo")) {
        throw new Error("timeout");
      }
      if (String(url).includes("/signalk/v2/api/weather")) {
        return { ok: true, json: async () => [] };
      }
      throw new Error("network down");
    };

    try {
      const forecast = await fsm.fetchForecast();
      // Must NOT stop at the empty Weather/Logbook tier
      assert.strictEqual(fsm.currentTier, Tier.CLEAR_SKY);
      assert.ok(forecast.length > 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("logbook cloud observations generate a forecast with attenuated GHI", async () => {
    const fsm = makeFSM();
    const origFetch = globalThis.fetch;
    // Open-Meteo down, logbook has one entry with 4 oktas (0.5) cloud cover
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("open-meteo")) throw new Error("network down");
      if (u.includes("signalk-logbook")) {
        if (new URL(u).pathname.endsWith("/logs")) {
          return { ok: true, json: async () => ["2026-08-21"] };
        }
        return {
          ok: true,
          json: async () => [
            {
              datetime: new Date(Date.now() - 3600000).toISOString(),
              observations: { cloudCoverage: 4 },
            },
          ],
        };
      }
      throw new Error("network down");
    };

    try {
      const forecast = await fsm.fetchForecast();
      assert.strictEqual(fsm.currentTier, Tier.LOGBOOK);
      assert.ok(forecast.length > 0);
      // Cloud cover from observation should be applied
      assert.ok(forecast.every((p) => p.cloudCover === 0.5));
      // GHI should be attenuated but present during daytime
      assert.ok(forecast.some((p) => (p.ghi ?? 0) > 0));
      // Wind data honestly absent
      assert.ok(forecast.every((p) => p.windSpeedKnots == null));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("logbook without observations falls through to Clear Sky", async () => {
    const fsm = makeFSM();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("open-meteo")) throw new Error("network down");
      if (u.includes("signalk-logbook")) {
        if (new URL(u).pathname.endsWith("/logs")) {
          return { ok: true, json: async () => ["2026-08-21"] };
        }
        return { ok: true, json: async () => [] }; // day with no entries
      }
      throw new Error("network down");
    };

    try {
      const forecast = await fsm.fetchForecast();
      assert.strictEqual(fsm.currentTier, Tier.CLEAR_SKY);
      assert.ok(forecast.length > 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
