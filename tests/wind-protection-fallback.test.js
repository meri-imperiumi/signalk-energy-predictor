/**
 * Smoketests for the Wind Protection Factor **sector fallback** (work doc
 * #16): when a (place, sector[, night]) bin is unlearned, the resolver
 * borrows from a *learned* neighbor instead of dropping to 1.0, with a
 * precedence of adjacent-sector → place-average → none, and (gust only,
 * opt-in) a same-sector day↔night cross-bin fallback clamped to ≤ 1.0.
 *
 * The central invariant under test: the fallback is **non-cascading**. A
 * fallback may only borrow from a genuinely *learned* bin, never from a
 * neighbor that is itself a fallback. So if sector 2 inherits sector 1's
 * value, sector 3 must not then inherit sector 2's borrowed value — it
 * looks at its other neighbor (sector 4) and the place average instead.
 *
 * @file wind-protection-fallback.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WindProtectionStore,
  placeSectorKey,
  placeSectorNightKey,
  DEFAULT_FACTOR,
  SOURCE_LEARNED,
  SOURCE_ADJACENT,
  SOURCE_PLACE_AVERAGE,
  SOURCE_CROSS_BIN,
  SOURCE_NONE,
} = require("../plugin/wind-protection.js");

/** Pins a speed factor for a bin by learning with alpha=1. */
function pinSpeed(store, placeKey, sector, ratio) {
  const forecast = 10;
  store.learn({
    placeKey,
    sector,
    night: false,
    measuredSpeed: forecast * ratio,
    forecastSpeed: forecast,
  });
}

/** Pins a gust factor for a (place, sector, night) bin by learning with alpha=1. */
function pinGust(store, placeKey, sector, night, ratio) {
  // Speed must pass its gate too (forecastSpeed >= minForecastWindKnots);
  // pin a harmless speed factor alongside.
  const forecast = 10;
  store.learn({
    placeKey,
    sector,
    night,
    measuredSpeed: forecast, // ratio 1.0, harmless
    forecastSpeed: forecast,
    measuredGust: forecast * ratio,
    forecastGust: forecast,
  });
}

/**
 * Pins a gust factor *without* marking the speed bin as learned — for tests
 * that need "gust learned, speed unlearned" at the same sector. This calls
 * the store's internal gust-learning path directly (the same state a real
 * `learn()` produces on the gust side), so the gust map entry and the
 * `learnedGustKeys` set match what production learning would write.
 */
function pinGustOnly(store, placeKey, sector, night, ratio) {
  const forecast = 10;
  store._learnGust(placeKey, sector, night, forecast * ratio, forecast);
}

test.describe("getFactors reports the source", () => {
  test("a learned bin resolves as learned", () => {
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 2, 0.5);
    const r = store.getFactorsWithFallback("p", 2, false);
    assert.strictEqual(r.speedSource, SOURCE_LEARNED);
    assert.ok(Math.abs(r.speed - 0.5) < 1e-9);
    // Gust bin unlearned, cross-bin off by default → none
    assert.strictEqual(r.gustSource, SOURCE_NONE);
    assert.strictEqual(r.gust, DEFAULT_FACTOR);
  });

  test("a fully unknown place resolves to none for both factors", () => {
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    const r = store.getFactorsWithFallback("nowhere", 2, false);
    assert.strictEqual(r.speedSource, SOURCE_NONE);
    assert.strictEqual(r.gustSource, SOURCE_NONE);
    assert.strictEqual(r.speed, DEFAULT_FACTOR);
    assert.strictEqual(r.gust, DEFAULT_FACTOR);
  });

  test("a bin with any accepted sample never uses a fallback", () => {
    // Sector 2 learned; its neighbor sector 1 is also learned. Sector 2
    // must report learned, not adjacent-sector, even though a neighbor
    // exists.
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 1, 0.7);
    pinSpeed(store, "p", 2, 0.5);
    const r = store.getFactorsWithFallback("p", 2, false);
    assert.strictEqual(r.speedSource, SOURCE_LEARNED);
    assert.ok(Math.abs(r.speed - 0.5) < 1e-9);
  });
});

test.describe("speed fallback precedence", () => {
  test("unlearned sector borrows the average of two learned neighbors", () => {
    // Sector 2 (E) unlearned; neighbors 1 (NE) and 3 (SE) learned.
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 1, 0.6);
    pinSpeed(store, "p", 3, 0.8);
    const r = store.getFactorsWithFallback("p", 2, false);
    assert.strictEqual(r.speedSource, SOURCE_ADJACENT);
    assert.ok(Math.abs(r.speed - 0.7) < 1e-9, `got ${r.speed}`);
  });

  test("uses the single learned neighbor when only one exists", () => {
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 1, 0.6);
    const r = store.getFactorsWithFallback("p", 2, false);
    assert.strictEqual(r.speedSource, SOURCE_ADJACENT);
    assert.ok(Math.abs(r.speed - 0.6) < 1e-9);
  });

  test("wraps around: sector 0's neighbors are 7 (NW) and 1 (NE)", () => {
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 7, 0.5);
    pinSpeed(store, "p", 1, 0.7);
    const r = store.getFactorsWithFallback("p", 0, false);
    assert.strictEqual(r.speedSource, SOURCE_ADJACENT);
    assert.ok(Math.abs(r.speed - 0.6) < 1e-9);
  });

  test("falls back to the place-wide average when no neighbor is learned", () => {
    // Sector 2 unlearned; sectors 4 and 5 learned (not adjacent). The
    // place average is the mean of all learned speed factors here.
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 4, 0.6);
    pinSpeed(store, "p", 5, 0.8);
    const r = store.getFactorsWithFallback("p", 2, false);
    assert.strictEqual(r.speedSource, SOURCE_PLACE_AVERAGE);
    assert.ok(Math.abs(r.speed - 0.7) < 1e-9, `got ${r.speed}`);
  });

  test("place average is preferred over a non-adjacent learned bin only when no neighbor is learned", () => {
    // Adjacent neighbor present (sector 3) → adjacent wins over the place
    // average even when more distant bins exist.
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 3, 0.66); // adjacent to sector 2
    pinSpeed(store, "p", 6, 0.3); // distant, drags the place average down
    const r = store.getFactorsWithFallback("p", 2, false);
    assert.strictEqual(r.speedSource, SOURCE_ADJACENT);
    assert.ok(Math.abs(r.speed - 0.66) < 1e-9);
  });

  test("returns 1.0 / none when nothing is learned for the place", () => {
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    // A different place has data; place "p" is empty.
    pinSpeed(store, "other", 2, 0.5);
    const r = store.getFactorsWithFallback("p", 2, false);
    assert.strictEqual(r.speedSource, SOURCE_NONE);
    assert.strictEqual(r.speed, DEFAULT_FACTOR);
  });

  test("unknown sector (-1) has no neighbors → falls through to place average / none", () => {
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 2, 0.5);
    // Unknown sector can't pick neighbors; place average is the only signal.
    const r = store.getFactorsWithFallback("p", -1, false);
    assert.strictEqual(r.speedSource, SOURCE_PLACE_AVERAGE);
    assert.ok(Math.abs(r.speed - 0.5) < 1e-9);
  });
});

test.describe("non-cascading fallback", () => {
  test("a sector that only has a fallback value is NOT a valid donor", () => {
    // Sector 2 unlearned; only neighbor sector 1 is learned → sector 2
    // gets sector 1's value via adjacent-sector fallback.
    // Sector 3 (the other neighbor of 2) is unlearned. Its neighbor sector 2
    // is now *populated* (carrying the fallback) but NOT learned. Sector 3
    // must NOT borrow sector 2's borrowed value; with its other neighbor
    // (sector 4) also unlearned, it falls through to place average (which
    // is sector 1's value, since that's the only learned bin).
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 1, 0.6); // only learned bin
    // Sector 2 borrows from 1 (adjacent)
    const r2 = store.getFactorsWithFallback("p", 2, false);
    assert.strictEqual(r2.speedSource, SOURCE_ADJACENT);
    assert.ok(Math.abs(r2.speed - 0.6) < 1e-9);

    // Sector 3's neighbors: 2 (a fallback bin, NOT a donor) and 4 (unlearned).
    // So adjacent resolves to nothing; place average = 0.6 (the one learned).
    const r3 = store.getFactorsWithFallback("p", 3, false);
    assert.strictEqual(r3.speedSource, SOURCE_PLACE_AVERAGE);
    assert.ok(Math.abs(r3.speed - 0.6) < 1e-9, `got ${r3.speed}`);
    // Critically, sector 3 did NOT report adjacent-sector (which would mean
    // it borrowed sector 2's fallback value).
    assert.notStrictEqual(r3.speedSource, SOURCE_ADJACENT);
  });

  test("the learned-set (not the factor map) gates adjacency", () => {
    // Belt-and-braces: directly assert that a fallback bin's key is absent
    // from learnedSpeedKeys even though its factor map entry exists from
    // the getFactors call path. (getFactors never writes the factor map;
    // only learn() does. So this also documents that the read path does
    // not pollute the learned set.)
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 1, 0.6);
    store.getFactorsWithFallback("p", 2, false); // would-be donor for sector 3
    assert.ok(
      !store.learnedSpeedKeys.has(placeSectorKey("p", 2)),
      "fallback bin must not be marked learned",
    );
    assert.ok(store.learnedSpeedKeys.has(placeSectorKey("p", 1)));
  });

  test("once a bin gets a real sample, it becomes a valid donor", () => {
    // Sector 2 was a fallback; learning one real sample flips it to learned,
    // after which sector 3 may borrow from it (adjacent).
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 1, 0.6);
    // Before: sector 3 → place average (sector 2 is a fallback, not a donor)
    assert.strictEqual(
      store.getFactorsWithFallback("p", 3, false).speedSource,
      SOURCE_PLACE_AVERAGE,
    );
    // Learn sector 2 for real
    pinSpeed(store, "p", 2, 0.9);
    // After: sector 3's neighbor 2 is now learned → adjacent
    const r3 = store.getFactorsWithFallback("p", 3, false);
    assert.strictEqual(r3.speedSource, SOURCE_ADJACENT);
    assert.ok(Math.abs(r3.speed - 0.9) < 1e-9);
  });
});

test.describe("gust fallback", () => {
  test("cross-bin gust fallback is off by default", () => {
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    // Day bin learned, night bin unlearned. Without cross-bin, night → none.
    pinGust(store, "p", 2, false, 0.4);
    const night = store.getFactorsWithFallback("p", 2, true);
    assert.strictEqual(night.gustSource, SOURCE_NONE);
    assert.strictEqual(night.gust, DEFAULT_FACTOR);
  });

  test("cross-bin gust fallback borrows the same sector's other bin when enabled", () => {
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinGust(store, "p", 2, false, 0.4); // day
    const night = store.getFactorsWithFallback("p", 2, true, {
      crossBinGustFallback: true,
    });
    assert.strictEqual(night.gustSource, SOURCE_CROSS_BIN);
    assert.ok(Math.abs(night.gust - 0.4) < 1e-9);
  });

  test("cross-bin borrowed factor is clamped to ≤ 1.0 (never inflates a night gust)", () => {
    // A daytime gust factor > 1.0 (e.g. a gusty day) must NOT be borrowed
    // into a night bin to inflate the forecast — katabatic risk lives in
    // the night bin and cross-bin borrowing only ever reduces.
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinGust(store, "p", 2, false, 1.5); // day gust factor above 1.0
    const night = store.getFactorsWithFallback("p", 2, true, {
      crossBinGustFallback: true,
    });
    assert.strictEqual(night.gustSource, SOURCE_CROSS_BIN);
    assert.strictEqual(night.gust, 1.0, `clamped to 1.0, got ${night.gust}`);
  });

  test("adjacent-sector gust fallback (same night bin) when cross-bin is off", () => {
    // Night bins for sectors 1 and 3 learned; sector 2 night unlearned.
    // Cross-bin off → sector 2 night borrows the night average of 1 & 3.
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinGust(store, "p", 1, true, 0.5);
    pinGust(store, "p", 3, true, 0.7);
    const r = store.getFactorsWithFallback("p", 2, true);
    assert.strictEqual(r.gustSource, SOURCE_ADJACENT);
    assert.ok(Math.abs(r.gust - 0.6) < 1e-9, `got ${r.gust}`);
  });

  test("place-average gust fallback (same night bin) when no neighbor learned", () => {
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinGust(store, "p", 4, true, 0.5);
    pinGust(store, "p", 6, true, 0.7); // both non-adjacent to sector 2
    const r = store.getFactorsWithFallback("p", 2, true);
    assert.strictEqual(r.gustSource, SOURCE_PLACE_AVERAGE);
    assert.ok(Math.abs(r.gust - 0.6) < 1e-9, `got ${r.gust}`);
  });

  test("gust fallback is also non-cascading", () => {
    // Only sector 1 night is learned. Sector 2 night borrows it (adjacent).
    // Sector 3 night must not borrow sector 2's borrowed value; with its
    // other neighbor (4) unlearned, it falls to place average (= sector 1).
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinGust(store, "p", 1, true, 0.5);
    const r2 = store.getFactorsWithFallback("p", 2, true);
    assert.strictEqual(r2.gustSource, SOURCE_ADJACENT);

    const r3 = store.getFactorsWithFallback("p", 3, true);
    assert.notStrictEqual(r3.gustSource, SOURCE_ADJACENT);
    assert.strictEqual(r3.gustSource, SOURCE_PLACE_AVERAGE);
    assert.ok(Math.abs(r3.gust - 0.5) < 1e-9);
  });

  test("cross-bin takes precedence over adjacent-sector when enabled", () => {
    // Same-sector other-bin (cross-bin) is more specific than a neighbor
    // sector, so it wins when both are available.
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinGust(store, "p", 2, false, 0.4); // cross-bin donor
    pinGust(store, "p", 1, true, 0.9); // adjacent-sector donor (same night)
    const r = store.getFactorsWithFallback("p", 2, true, {
      crossBinGustFallback: true,
    });
    assert.strictEqual(r.gustSource, SOURCE_CROSS_BIN);
    assert.ok(Math.abs(r.gust - 0.4) < 1e-9);
  });
});

test.describe("speed and gust resolve independently", () => {
  test("speed can be a fallback while gust is learned, and vice versa", () => {
    // Sector 2: speed unlearned (neighbor 1 learned → adjacent), gust
    // learned directly. pinGustOnly keeps the speed bin unlearned so the
    // speed fallback path is actually exercised at sector 2.
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 1, 0.6); // speed donor for sector 2
    pinGustOnly(store, "p", 2, false, 0.4); // sector 2 gust learned
    const r = store.getFactorsWithFallback("p", 2, false);
    assert.strictEqual(r.speedSource, SOURCE_ADJACENT);
    assert.ok(Math.abs(r.speed - 0.6) < 1e-9);
    assert.strictEqual(r.gustSource, SOURCE_LEARNED);
    assert.ok(Math.abs(r.gust - 0.4) < 1e-9);
  });

  test("one factor none and the other learned still applies the learned one", () => {
    // Speed fully unlearned everywhere (none); gust learned at this bin.
    // The bin should still apply the gust correction, with speed at 1.0.
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinGustOnly(store, "p", 2, false, 0.4);
    const r = store.getFactorsWithFallback("p", 2, false);
    assert.strictEqual(r.speedSource, SOURCE_NONE);
    assert.strictEqual(r.speed, DEFAULT_FACTOR);
    assert.strictEqual(r.gustSource, SOURCE_LEARNED);
    assert.ok(Math.abs(r.gust - 0.4) < 1e-9);
  });
});

test.describe("persistence round-trips the learned sets", () => {
  test("learned key sets survive toJSON/fromJSON", () => {
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 1, 0.6);
    pinGustOnly(store, "p", 2, true, 0.4);
    const json = store.toJSON();
    assert.ok(json.learnedSpeedKeys.includes(placeSectorKey("p", 1)));
    assert.ok(json.learnedGustKeys.includes(placeSectorNightKey("p", 2, true)));

    const restored = WindProtectionStore.fromJSON(json);
    // Sector 2 (unlearned) still borrows from restored sector 1
    const r = restored.getFactorsWithFallback("p", 2, false);
    assert.strictEqual(r.speedSource, SOURCE_ADJACENT);
    assert.ok(Math.abs(r.speed - 0.6) < 1e-9);
    // The restored learned gust bin is still learned
    const g = restored.getFactorsWithFallback("p", 2, true);
    assert.strictEqual(g.gustSource, SOURCE_LEARNED);
    assert.ok(Math.abs(g.gust - 0.4) < 1e-9);
  });

  test("old persisted stores (no learned sets) are backfilled as fully learned", () => {
    // Simulate a pre-fallback store: factor maps but no learned key arrays.
    const store = new WindProtectionStore({ alpha: 1, maxPlaces: 10 });
    pinSpeed(store, "p", 2, 0.5);
    const json = store.toJSON();
    delete json.learnedSpeedKeys;
    delete json.learnedGustKeys;

    const restored = WindProtectionStore.fromJSON(json);
    // Every existing speed factor is treated as learned so the fallback
    // doesn't classify a populated bin as a gap.
    assert.ok(restored.learnedSpeedKeys.has(placeSectorKey("p", 2)));
    const r = restored.getFactorsWithFallback("p", 2, false);
    assert.strictEqual(r.speedSource, SOURCE_LEARNED);
  });
});
