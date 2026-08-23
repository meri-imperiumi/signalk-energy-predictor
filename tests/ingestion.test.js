/**
 * Tests for weather ingestion fallback chain.
 * @file ingestion.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  IngestionFSM,
  Tier,
  fetchOpenMeteo,
  OPEN_METEO_MAX_ATTEMPTS,
} = require("../plugin/ingestion.js");

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
    // Use today's date so the day is always within the 48h lookback window
    const today = new Date().toISOString().split("T")[0];
    // Open-Meteo down, logbook has one entry with 4 oktas (0.5) cloud cover
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("open-meteo")) throw new Error("network down");
      if (u.includes("signalk-logbook")) {
        if (new URL(u).pathname.endsWith("/logs")) {
          return { ok: true, json: async () => [today] };
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

  test("Signal K Weather API fields map to forecast points", async () => {
    const fsm = makeFSM();
    const origFetch = globalThis.fetch;
    // WeatherData uses wind.speedTrue (m/s), wind.gust, wind.directionTrue (rad)
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("open-meteo")) throw new Error("network down");
      if (u.includes("/signalk/v2/api/weather")) {
        return {
          ok: true,
          json: async () => [
            {
              date: new Date(Date.now() + 3600000).toISOString(),
              type: "point",
              wind: {
                speedTrue: 10, // m/s
                directionTrue: Math.PI, // 180 deg
                gust: 15, // m/s
              },
              outside: { cloudCover: 0.5 },
            },
            {
              date: new Date(Date.now() + 7200000).toISOString(),
              type: "point",
              wind: { speedTrue: 0 }, // calm must not become null
            },
          ],
        };
      }
      throw new Error("network down");
    };

    try {
      const forecast = await fsm.fetchForecast();
      assert.strictEqual(fsm.currentTier, Tier.SIGNAL_K_WEATHER);
      assert.strictEqual(forecast.length, 2);

      const [first, calm] = forecast;
      assert.ok(Math.abs(first.windSpeedKnots - 10 * 1.94384) < 0.01);
      assert.ok(Math.abs(first.gustSpeedKnots - 15 * 1.94384) < 0.01);
      assert.ok(Math.abs(first.windDirectionDeg - 180) < 0.01);
      assert.strictEqual(first.cloudCover, 0.5);
      // Cloud cover must yield a synthesized GHI
      assert.ok(first.ghi != null);

      // Calm wind: 0 m/s is a valid reading, not missing data
      assert.strictEqual(calm.windSpeedKnots, 0);
      assert.strictEqual(calm.gustSpeedKnots, null);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("logbook without observations falls through to Clear Sky", async () => {
    const fsm = makeFSM();
    const origFetch = globalThis.fetch;
    const today = new Date().toISOString().split("T")[0];
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("open-meteo")) throw new Error("network down");
      if (u.includes("signalk-logbook")) {
        if (new URL(u).pathname.endsWith("/logs")) {
          return { ok: true, json: async () => [today] };
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

test.describe("Open-Meteo fetch error handling", () => {
  const validPayload = {
    hourly: {
      time: ["2026-08-22T21:00", "2026-08-22T22:00"],
      shortwave_radiation: [100, 50],
      wind_speed_10m: [18, 16],
      wind_gusts_10m: [27, 25],
      wind_direction_10m: [90, 95],
    },
  };

  function withFetch(impl, fn) {
    const origFetch = globalThis.fetch;
    globalThis.fetch = impl;
    return fn().finally(() => {
      globalThis.fetch = origFetch;
    });
  }

  test("transient network failure is retried and succeeds", async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        if (calls < 2) {
          throw new TypeError("fetch failed"); // fetch() rejects with TypeError on network errors
        }
        return { ok: true, json: async () => validPayload };
      },
      async () => {
        const points = await fetchOpenMeteo(60.17, 24.94, { retryDelayMs: 1 });
        assert.strictEqual(calls, 2);
        assert.strictEqual(points.length, 2);
        // km/h -> knots conversion preserved
        assert.ok(Math.abs(points[0].windSpeedKnots - 18 * 0.539957) < 0.01);
        assert.ok(Math.abs(points[0].gustSpeedKnots - 27 * 0.539957) < 0.01);
        // Naive UTC timestamps parsed as UTC
        assert.strictEqual(
          points[0].time.toISOString(),
          "2026-08-22T21:00:00.000Z",
        );
      },
    );
  });

  test("timeout is retried", async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        throw error;
      },
      async () => {
        await assert.rejects(
          fetchOpenMeteo(60.17, 24.94, { retryDelayMs: 1 }),
          /timed out|aborted/,
        );
        assert.strictEqual(calls, OPEN_METEO_MAX_ATTEMPTS);
      },
    );
  });

  test("server errors are retried, then surface", async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return { ok: false, status: 503 };
      },
      async () => {
        await assert.rejects(
          fetchOpenMeteo(60.17, 24.94, { retryDelayMs: 1 }),
          /Open-Meteo returned 503/,
        );
        assert.strictEqual(calls, OPEN_METEO_MAX_ATTEMPTS);
      },
    );
  });

  test("client errors are not retried", async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return { ok: false, status: 400 };
      },
      async () => {
        await assert.rejects(
          fetchOpenMeteo(60.17, 24.94, { retryDelayMs: 1 }),
          /Open-Meteo returned 400/,
        );
        assert.strictEqual(calls, 1);
      },
    );
  });

  test("mismatched hourly arrays are rejected without retry", async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return {
          ok: true,
          json: async () => ({
            hourly: {
              time: ["2026-08-22T21:00", "2026-08-22T22:00"],
              shortwave_radiation: [100],
            },
          }),
        };
      },
      async () => {
        await assert.rejects(
          fetchOpenMeteo(60.17, 24.94, { retryDelayMs: 1 }),
          /arrays mismatch/,
        );
        assert.strictEqual(calls, 1);
      },
    );
  });

  test("all-null values are rejected as a data gap without retry", async () => {
    // Open-Meteo returns null for unavailable hours; an all-null array must
    // not become a confident zero-wind, zero-solar forecast
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return {
          ok: true,
          json: async () => ({
            hourly: {
              time: ["2026-08-22T21:00", "2026-08-22T22:00"],
              shortwave_radiation: [null, null],
              wind_speed_10m: [null, null],
              wind_gusts_10m: [null, null],
            },
          }),
        };
      },
      async () => {
        await assert.rejects(
          fetchOpenMeteo(60.17, 24.94, { retryDelayMs: 1 }),
          /no usable shortwave_radiation/,
        );
        assert.strictEqual(calls, 1);
      },
    );
  });

  test("partial nulls are preserved, not treated as a data gap", async () => {
    await withFetch(
      async () => ({
        ok: true,
        json: async () => ({
          hourly: {
            time: ["2026-08-22T21:00", "2026-08-22T22:00"],
            shortwave_radiation: [100, null],
            wind_speed_10m: [18, null],
          },
        }),
      }),
      async () => {
        const points = await fetchOpenMeteo(60.17, 24.94, { retryDelayMs: 1 });
        assert.strictEqual(points.length, 2);
        assert.strictEqual(points[0].ghi, 100);
        assert.strictEqual(points[1].ghi, 0); // isolated null maps to zero
        assert.strictEqual(points[1].windSpeedKnots, null);
      },
    );
  });

  test("all-null Open-Meteo payload falls through to the next tier", async () => {
    const fsm = makeFSM();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("open-meteo")) {
        return {
          ok: true,
          json: async () => ({
            hourly: {
              time: ["2026-08-22T21:00", "2026-08-22T22:00"],
              shortwave_radiation: [null, null],
            },
          }),
        };
      }
      throw new Error("network down"); // lower tiers unavailable
    };

    try {
      const forecast = await fsm.fetchForecast();
      // Must not stay on tier 1 serving zeros - clear sky is honest fallback
      assert.strictEqual(fsm.currentTier, Tier.CLEAR_SKY);
      assert.ok(forecast.some((p) => (p.ghi ?? 0) > 0));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("FSM stays on Open-Meteo tier across a transient failure", async () => {
    const fsm = makeFSM();
    let calls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("open-meteo")) {
        calls++;
        if (calls < 2) {
          throw new TypeError("fetch failed");
        }
        return { ok: true, json: async () => validPayload };
      }
      throw new Error("network down");
    };

    try {
      const forecast = await fsm.fetchForecast();
      assert.strictEqual(fsm.currentTier, Tier.OPEN_METEO);
      assert.strictEqual(forecast.length, 2);
      assert.ok(forecast.every((p) => p.windSpeedKnots != null));
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
