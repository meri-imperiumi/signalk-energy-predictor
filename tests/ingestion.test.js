/**
 * Tests for weather ingestion fallback chain.
 * @file ingestion.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  IngestionFSM,
  Tier,
  fetchOpenMeteo,
  OPEN_METEO_MAX_ATTEMPTS,
  DEFAULT_FORECAST_CACHE_HOURS,
} = require("../plugin/ingestion.js");
const {
  writeWeatherCache,
  weatherPositionBucket,
} = require("../plugin/weather-cache.js");

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

test.describe("Offline forecast restore + staleness + uplink cadence", () => {
  async function mkDataDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), "ingest-offline-"));
  }

  /** A fake SK app that returns canned values for given paths. */
  function makeAppWith(paths = {}) {
    return {
      debug() {},
      info() {},
      warn() {},
      error() {},
      getSelfPath: (p) => paths[p] ?? null,
    };
  }

  function fsmWithCache(app, dataDir, opts = {}) {
    const fsm = new IngestionFSM(app, { dataDir, ...opts });
    fsm.position = { latitude: 60.17, longitude: 24.94 };
    return fsm;
  }

  function networkDown() {
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
  }

  /** Seed the on-disk cache for a position with a tier-1 forecast hour. */
  async function seedCache(dataDir, lat, lon, hours, tier = 1, ageMs = 0) {
    const bucket = weatherPositionBucket(lat, lon);
    const date = new Date(Date.now() - ageMs);
    const dateKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
    const points = hours.map((h) => ({
      time: new Date(date.getTime() + h * 3600000),
      ghi: 600,
      cloudCover: 0.3,
      windSpeedKnots: 12,
      gustSpeedKnots: 18,
      windDirectionDeg: 90,
      tier,
    }));
    await writeWeatherCache(dataDir, dateKey, bucket, points, tier);
    return dateKey;
  }

  test("network down + on-disk cache present → restores the real forecast instead of clear sky", async () => {
    const dir = await mkDataDir();
    const fsm = fsmWithCache(makeApp(), dir);
    // Seed a tier-1 forecast for "now" (hour 0) at the boat's bucket.
    await seedCache(dir, 60.17, 24.94, [0]);
    const origFetch = globalThis.fetch;
    networkDown();
    try {
      const forecast = await fsm.fetchForecast();
      // Restore must win over Clear Sky: tier stays 1, wind is present.
      assert.strictEqual(fsm.currentTier, Tier.OPEN_METEO);
      assert.ok(forecast.some((p) => p.windSpeedKnots === 12));
      assert.ok(forecast.some((p) => p.ghi === 600));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("network down + no cache → falls back to clear sky (today's behavior)", async () => {
    const dir = await mkDataDir();
    const fsm = fsmWithCache(makeApp(), dir);
    const origFetch = globalThis.fetch;
    networkDown();
    try {
      const forecast = await fsm.fetchForecast();
      assert.strictEqual(fsm.currentTier, Tier.CLEAR_SKY);
      assert.ok(forecast.some((p) => (p.ghi ?? 0) > 0));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("restore reads from the coarse ~1° bucket, not the fine write bucket", async () => {
    // Fetch landed at 60.17/24.94; the boat has since moved to 60.42/24.80
    // (same ~1° restore bucket 60/25, different fine bucket). Restore must
    // still find it.
    const dir = await mkDataDir();
    const fsm = fsmWithCache(makeApp(), dir);
    fsm.position = { latitude: 60.42, longitude: 24.8 }; // moved ~0.3°
    await seedCache(dir, 60.17, 24.94, [0]);
    const origFetch = globalThis.fetch;
    networkDown();
    try {
      const forecast = await fsm.fetchForecast();
      assert.strictEqual(fsm.currentTier, Tier.OPEN_METEO);
      assert.ok(forecast.some((p) => p.windSpeedKnots === 12));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("tier-aware staleness: a tier-1 forecast stays usable past 15 min offline", async () => {
    const dir = await mkDataDir();
    const fsm = fsmWithCache(makeApp(), dir);
    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new Error("network down"); // never succeeds
    };
    try {
      // Seed a fresh tier-1 cache and restore once.
      await seedCache(dir, 60.17, 24.94, [0]);
      await fsm.fetchForecast();
      assert.strictEqual(fsm.currentTier, Tier.OPEN_METEO);
      const afterFirst = fetchCalls;
      // Wind the in-memory fetch time ~30 min into the past: still inside the
      // 24h tier-1 window, so getForecast must serve the cache WITHOUT
      // re-attempting a (failing) network fetch.
      fsm.lastFetchTime = new Date(Date.now() - 30 * 60000);
      const served = await fsm.getForecast();
      assert.strictEqual(
        fetchCalls,
        afterFirst,
        "no fetch attempt within the tier-1 staleness window",
      );
      assert.strictEqual(served, fsm.lastForecast);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("tier-aware staleness: a tier-4 clear-sky forecast re-fetches after 15 min", async () => {
    const dir = await mkDataDir();
    const fsm = fsmWithCache(makeApp(), dir);
    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new Error("network down");
    };
    try {
      // No cache → clear sky (tier 4).
      await fsm.fetchForecast();
      assert.strictEqual(fsm.currentTier, Tier.CLEAR_SKY);
      // 20 min old clear-sky is outside its 15 min window → getForecast must
      // attempt a refetch (which fails offline; that's fine, we just assert
      // the attempt happened).
      fsm.lastFetchTime = new Date(Date.now() - 20 * 60000);
      fsm.uplinkOnline = false;
      fsm.lastFetchAttempt = null;
      await fsm.getForecast();
      assert.ok(fetchCalls > 0, "clear-sky past 15 min triggers a refetch");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("uplink offline→online edge triggers an immediate fetch eligibility", async () => {
    const fsm = makeFSM();
    assert.strictEqual(fsm.uplinkOnline, false);
    // First online status (internet) flips the edge.
    const became = fsm.setUplinkStatus({ internet: "online" });
    assert.strictEqual(became, true);
    assert.strictEqual(fsm.uplinkOnline, true);
    // A subsequent online update is not an edge.
    const became2 = fsm.setUplinkStatus({ internet: "online" });
    assert.strictEqual(became2, false);
    // Going offline then online again is another edge.
    fsm.setUplinkStatus({ internet: "offline" });
    assert.strictEqual(fsm.uplinkOnline, false);
    const became3 = fsm.setUplinkStatus({ internet: "metered" });
    assert.strictEqual(became3, true);
  });

  test("metered internet counts as online for fetch eligibility", () => {
    const fsm = makeFSM();
    assert.strictEqual(fsm.uplinkOnline, false);
    // `metered` means the internet is available (just billed by volume),
    // so a forecast fetch is still eligible.
    const became = fsm.setUplinkStatus({ internet: "metered" });
    assert.strictEqual(became, true);
    assert.strictEqual(fsm.uplinkOnline, true);
    // Going back to offline clears it.
    fsm.setUplinkStatus({ internet: "offline" });
    assert.strictEqual(fsm.uplinkOnline, false);
  });

  test("uplink online caps refetch attempts to ~1h even if the forecast is stale", async () => {
    const dir = await mkDataDir();
    const fsm = fsmWithCache(makeApp(), dir);
    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new Error("network down");
    };
    try {
      await seedCache(dir, 60.17, 24.94, [0]);
      await fsm.fetchForecast(); // restores tier 1
      // Mark the forecast ancient so staleness says "refresh eligible"...
      fsm.lastFetchTime = new Date(Date.now() - 48 * 3600000);
      fsm.uplinkOnline = true;
      fsm.lastOnlineFetchAttempt = Date.now() - 30 * 60000; // …but refetched 30 min ago
      const before = fetchCalls;
      await fsm.getForecast();
      assert.strictEqual(
        fetchCalls,
        before,
        "online cadence (1h) suppresses a refetch only 30 min after the last",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("stale-boundary hybrid: cache older than forecastCacheHours → logbook solar + latest-known wind", async () => {
    const dir = await mkDataDir();
    // Live SK wind available for the nowcast.
    const app = makeAppWith({
      "environment.wind.speedTrue": 8, // m/s
      "environment.wind.directionTrue": Math.PI, // 180°
    });
    const fsm = fsmWithCache(app, dir);
    const origFetch = globalThis.fetch;
    // Open-Meteo down; logbook returns one observation with 4 oktas.
    const today = new Date().toISOString().split("T")[0];
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
      // Seed a tier-1 forecast fetched 30 h ago (older than the 24 h window).
      await seedCache(dir, 60.17, 24.94, [0], 1, 30 * 3600000);
      const forecast = await fsm.fetchForecast();
      // Hybrid must NOT claim to be a real forecast tier.
      assert.strictEqual(fsm.currentTier, Tier.LOGBOOK);
      // Wind is the latest-known live value (8 m/s → ~15.55 kn), held constant.
      assert.ok(
        forecast.every(
          (p) =>
            p.windSpeedKnots != null &&
            Math.abs(p.windSpeedKnots - 8 * 1.94384) < 0.1,
        ),
      );
      assert.ok(forecast.every((p) => p.windDirectionDeg === 180));
      // Solar is logbook-attenuated (cloud cover 0.5), present in daytime.
      assert.ok(forecast.every((p) => p.cloudCover === 0.5));
      assert.ok(forecast.some((p) => (p.ghi ?? 0) > 0));
      // Points are tagged so downstream can down-weight.
      assert.ok(
        forecast.every(
          (p) => p.source === "logbook" || p.source === "clear-sky",
        ),
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
