/**
 * Smoketests for the Wind Protection Factor module.
 *
 * Covers: direction sector binning, place cell keys, day/night bin, log-profile
 * height translation, the learning store's EMA update + sanitization gates +
 * LRU eviction + persistence, and recording of learning observations.
 *
 * @file wind-protection.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WindProtectionStore,
  sectorFromDeg,
  sectorFromRad,
  placeKey,
  isNight,
  translateWindSpeed,
  toForecastReference,
  toDeviceHeight,
  DEFAULT_FACTOR,
  DEFAULT_ANEMOMETER_HEIGHT_M,
} = require("../plugin/wind-protection.js");

test.describe("sectorFromDeg", () => {
  test("bins the 8 cardinal/intercardinal directions", () => {
    assert.strictEqual(sectorFromDeg(0), 0); // N
    assert.strictEqual(sectorFromDeg(45), 1); // NE
    assert.strictEqual(sectorFromDeg(90), 2); // E
    assert.strictEqual(sectorFromDeg(135), 3); // SE
    assert.strictEqual(sectorFromDeg(180), 4); // S
    assert.strictEqual(sectorFromDeg(225), 5); // SW
    assert.strictEqual(sectorFromDeg(270), 6); // W
    assert.strictEqual(sectorFromDeg(315), 7); // NW
  });

  test("wraps 360° back to N and centers sectors on the cardinal", () => {
    assert.strictEqual(sectorFromDeg(360), 0);
    assert.strictEqual(sectorFromDeg(22.4), 0); // just inside N
    assert.strictEqual(sectorFromDeg(22.5), 1); // boundary → NE
    assert.strictEqual(sectorFromDeg(337.5), 0); // boundary → N
  });

  test("normalizes negatives", () => {
    assert.strictEqual(sectorFromDeg(-45), 7); // NW
    assert.strictEqual(sectorFromDeg(-90), 6); // W
  });

  test("returns -1 for null/invalid direction", () => {
    assert.strictEqual(sectorFromDeg(null), -1);
    assert.strictEqual(sectorFromDeg(NaN), -1);
    assert.strictEqual(sectorFromDeg(undefined), -1);
  });
});

test.describe("sectorFromRad", () => {
  test("wraps a Signal K radians direction to the same sector as degrees", () => {
    // 90° (east) = π/2 rad → sector 2 (E)
    assert.strictEqual(sectorFromRad(Math.PI / 2), 2);
    // 0 (north) → sector 0
    assert.strictEqual(sectorFromRad(0), 0);
    // 180° (south) = π rad → sector 4 (S)
    assert.strictEqual(sectorFromRad(Math.PI), 4);
    // 315° (NW) = 5.4978 rad → sector 7
    assert.ok(Math.abs((315 * Math.PI) / 180 - 5.497787143782138) < 1e-3);
    assert.strictEqual(sectorFromRad((315 * Math.PI) / 180), 7);
  });

  test("returns -1 for null/invalid direction", () => {
    assert.strictEqual(sectorFromRad(null), -1);
    assert.strictEqual(sectorFromRad(NaN), -1);
  });
});

test.describe("placeKey", () => {
  test("is stable for nearby positions (same cell)", () => {
    const a = placeKey(60.1234, 21.8765, 500);
    const b = placeKey(60.1234, 21.8766, 500); // ~7 m east
    assert.strictEqual(a, b);
  });

  test("differs across cell boundaries", () => {
    const a = placeKey(60.1234, 21.8765, 500);
    const b = placeKey(60.1234, 21.98, 500); // > 500 m east
    assert.notStrictEqual(a, b);
  });

  test("shrinks longitude bins toward the poles", () => {
    // At 60°N, 1° longitude ≈ 55 km, so a 500 m cell is much narrower in
    // degrees than at the equator. Two points 0.01° apart in longitude
    // should land in different cells at 60°N but the same cell at the
    // equator for a large-ish cell.
    const poleA = placeKey(60, 21.0, 500);
    const poleB = placeKey(60, 21.01, 500);
    assert.notStrictEqual(poleA, poleB);

    const eqA = placeKey(0, 21.0, 50000); // 50 km cell
    const eqB = placeKey(0, 21.01, 50000); // ~1.1 km apart
    assert.strictEqual(eqA, eqB);
  });

  test("survives an anchor swing: a ~100 m radius stays one cell", () => {
    // A boat swinging on its anchor moves within a small radius (~100 m)
    // but the wind protection is a property of the anchorage, not the
    // instantaneous position. With a 500 m cell snapped to the nearest
    // center, a 100 m swing around a point well inside the cell maps to a
    // single key. Center the swing on a cell center (so the swing is
    // symmetric) at lat 0, lon 0.
    const cx = 0;
    const cy = 0;
    const rDeg = 100 / 111320; // ~100 m in degrees
    const center = placeKey(cx, cy, 500);
    // 8 points around a ~100 m circle
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 2 * Math.PI;
      const key = placeKey(
        cx + Math.cos(a) * rDeg,
        cy + Math.sin(a) * rDeg,
        500,
      );
      assert.strictEqual(
        key,
        center,
        `swing point ${i} (${a}rad) fragmented into ${key} != ${center}`,
      );
    }
  });

  test("anchor swing near a cell edge can split cells (expected trade-off)", () => {
    // Snapping to the nearest center halves the worst-case boundary
    // distance vs floor binning, but a boat anchored *exactly* on a cell
    // edge can still flip as it swings. This test documents the boundary
    // by placing a swing straddling a cell center line and showing that at
    // least some points fall into the neighbor cell — confirming cells
    // are still distinct (we're not collapsing everything to one key).
    // Pick a cell edge at the equator: lonStepDeg = 500/111320 ≈ 0.00449°
    const lonStepDeg = 500 / 111320;
    const edgeLon = lonStepDeg / 2; // halfway between two centers
    const a = placeKey(0, edgeLon - 0.00001, 500); // just west of edge
    const b = placeKey(0, edgeLon + 0.00001, 500); // just east of edge
    assert.notStrictEqual(a, b, "points across a cell edge must differ");
  });
});

test.describe("isNight", () => {
  test("night is elevation ≤ 0", () => {
    assert.strictEqual(isNight(0), true);
    assert.strictEqual(isNight(-0.01), true);
    assert.strictEqual(isNight(0.01), false);
    assert.strictEqual(isNight(Math.PI / 4), false);
  });
});

test.describe("height translation (log profile)", () => {
  test("is identity when zFrom === zTo", () => {
    const v = translateWindSpeed(10, 10, 10, 0.0002);
    assert.ok(Math.abs(v - 10) < 1e-9);
  });

  test("translates masthead (13 m) down to 10 m reference (small reduction)", () => {
    // Open water z0=0.0002: 13→10 is ~2% reduction
    const v = toForecastReference(10, 13, 0.0002);
    assert.ok(v < 10 && v > 9.7, `expected ~9.8, got ${v}`);
  });

  test("reduction is larger at rougher terrain", () => {
    // Reference (10 m) → device (5 m). The reduction grows with roughness.
    // 10→5 at z0=0.0002 ≈ 9.36; at z0=0.1 ≈ 8.50.
    const vRough = toDeviceHeight(10, 5, 0.1);
    const vOpen = toDeviceHeight(10, 5, 0.0002);
    assert.ok(
      vRough < 9 && vRough > 8,
      `expected ~8.5 at rough, got ${vRough}`,
    );
    assert.ok(vOpen > 9 && vOpen < 10, `expected ~9.36 at open, got ${vOpen}`);
    assert.ok(vRough < vOpen, "rougher terrain should reduce more");
  });

  test("round-trips through reference and device height", () => {
    const orig = 10;
    const ref = toForecastReference(orig, 13, 0.0002);
    const back = translateWindSpeed(ref, 10, 13, 0.0002);
    assert.ok(Math.abs(back - orig) < 1e-9);
  });

  test("passes through for invalid/zero heights", () => {
    assert.strictEqual(translateWindSpeed(10, 0, 10, 0.0002), 10);
    assert.strictEqual(translateWindSpeed(10, 10, 0, 0.0002), 10);
    assert.strictEqual(translateWindSpeed(null, 10, 5, 0.0002), null);
  });
});

test.describe("WindProtectionStore.learn", () => {
  test("updates the speed factor via EMA toward the observed ratio", () => {
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 10 });
    // measured 5 / forecast 10 → observed 0.5; default 1.0
    // EMA: 0.5*0.5 + 0.5*1.0 = 0.75
    const updated = store.learn({
      placeKey: "p",
      sector: 0,
      night: false,
      measuredSpeed: 5,
      forecastSpeed: 10,
    });
    assert.strictEqual(updated, true);
    const { speed } = store.getFactors("p", 0, false);
    assert.ok(Math.abs(speed - 0.75) < 1e-9, `got ${speed}`);
  });

  test("converges toward the observed ratio over many samples", () => {
    const store = new WindProtectionStore({ alpha: 0.3, maxPlaces: 10 });
    for (let i = 0; i < 50; i++) {
      store.learn({
        placeKey: "p",
        sector: 2,
        night: false,
        measuredSpeed: 3,
        forecastSpeed: 10, // ratio 0.3
      });
    }
    const { speed } = store.getFactors("p", 2, false);
    assert.ok(Math.abs(speed - 0.3) < 0.02, `converged to ${speed}`);
  });

  test("keeps speed and gust factors in separate bins (sector + day/night)", () => {
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 10 });
    store.learn({
      placeKey: "p",
      sector: 0,
      night: false,
      measuredSpeed: 5,
      forecastSpeed: 10,
      measuredGust: 12,
      forecastGust: 20,
    });
    store.learn({
      placeKey: "p",
      sector: 0,
      night: true,
      measuredSpeed: 8,
      forecastSpeed: 10,
      measuredGust: 30, // katabatic: gust > forecast
      forecastGust: 20,
    });
    const day = store.getFactors("p", 0, false);
    const night = store.getFactors("p", 0, true);
    // Speed factor is per sector only → same for day and night
    assert.ok(Math.abs(day.speed - night.speed) < 1e-9);
    // Gust factor is per sector+night → different
    assert.ok(
      day.gust < 1 && night.gust > 1,
      `day=${day.gust} night=${night.gust}`,
    );
  });

  test("gates: drops samples when forecast wind is below the minimum", () => {
    const store = new WindProtectionStore({
      alpha: 0.5,
      maxPlaces: 10,
      minForecastWindKnots: 5,
    });
    const updated = store.learn({
      placeKey: "p",
      sector: 0,
      night: false,
      measuredSpeed: 1,
      forecastSpeed: 2, // below 5 kn threshold
    });
    assert.strictEqual(updated, false);
    assert.strictEqual(store.sizeSpeed, 0);
  });

  test("gates: drops gust learning when either gust is missing", () => {
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 10 });
    // Speed still learned, gust skipped (no measured gust)
    const updated = store.learn({
      placeKey: "p",
      sector: 0,
      night: false,
      measuredSpeed: 5,
      forecastSpeed: 10,
      measuredGust: null,
      forecastGust: 20,
    });
    assert.strictEqual(updated, true);
    assert.strictEqual(store.sizeSpeed, 1);
    assert.strictEqual(store.sizeGust, 0);
  });

  test("gates: drops samples with null/invalid measured speed", () => {
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 10 });
    assert.strictEqual(
      store.learn({
        placeKey: "p",
        sector: 0,
        night: false,
        measuredSpeed: null,
        forecastSpeed: 10,
      }),
      false,
    );
    assert.strictEqual(
      store.learn({
        placeKey: "p",
        sector: 0,
        night: false,
        measuredSpeed: 5,
        forecastSpeed: null,
      }),
      false,
    );
    assert.strictEqual(store.sizeSpeed, 0);
  });

  test("still learns with unknown sector (-1), bucketed separately", () => {
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 10 });
    store.learn({
      placeKey: "p",
      sector: -1,
      night: false,
      measuredSpeed: 5,
      forecastSpeed: 10,
    });
    const { speed } = store.getFactors("p", -1, false);
    assert.ok(Math.abs(speed - 0.75) < 1e-9);
    // A known sector at the same place is a different bin (still default)
    const other = store.getFactors("p", 3, false);
    assert.strictEqual(other.speed, DEFAULT_FACTOR);
  });
});

test.describe("WindProtectionStore.getFactors", () => {
  test("returns default 1.0 for unknown place/sector", () => {
    const store = new WindProtectionStore();
    const { speed, gust } = store.getFactors("nope", 0, false);
    assert.strictEqual(speed, DEFAULT_FACTOR);
    assert.strictEqual(gust, DEFAULT_FACTOR);
  });

  test("returns default for null place key", () => {
    const store = new WindProtectionStore();
    const { speed, gust } = store.getFactors(null, 0, false);
    assert.strictEqual(speed, DEFAULT_FACTOR);
    assert.strictEqual(gust, DEFAULT_FACTOR);
  });
});

test.describe("WindProtectionStore LRU", () => {
  test("evicts the oldest place when the cap is exceeded", () => {
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 2 });
    store.learn({
      placeKey: "a",
      sector: 0,
      night: false,
      measuredSpeed: 5,
      forecastSpeed: 10,
    });
    store.learn({
      placeKey: "b",
      sector: 0,
      night: false,
      measuredSpeed: 5,
      forecastSpeed: 10,
    });
    store.learn({
      placeKey: "c",
      sector: 0,
      night: false,
      measuredSpeed: 5,
      forecastSpeed: 10,
    });
    // "a" was evicted → back to default
    assert.strictEqual(store.getFactors("a", 0, false).speed, DEFAULT_FACTOR);
    assert.notStrictEqual(
      store.getFactors("b", 0, false).speed,
      DEFAULT_FACTOR,
    );
    assert.notStrictEqual(
      store.getFactors("c", 0, false).speed,
      DEFAULT_FACTOR,
    );
    assert.strictEqual(store.sizePlaces, 2);
  });

  test("touching an existing place moves it to most-recently-used", () => {
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 2 });
    store.learn({
      placeKey: "a",
      sector: 0,
      night: false,
      measuredSpeed: 5,
      forecastSpeed: 10,
    });
    store.learn({
      placeKey: "b",
      sector: 0,
      night: false,
      measuredSpeed: 5,
      forecastSpeed: 10,
    });
    // Re-learn "a" → it's now MRU, so "b" gets evicted next
    store.learn({
      placeKey: "a",
      sector: 0,
      night: false,
      measuredSpeed: 5,
      forecastSpeed: 10,
    });
    store.learn({
      placeKey: "c",
      sector: 0,
      night: false,
      measuredSpeed: 5,
      forecastSpeed: 10,
    });
    assert.notStrictEqual(
      store.getFactors("a", 0, false).speed,
      DEFAULT_FACTOR,
    );
    assert.strictEqual(store.getFactors("b", 0, false).speed, DEFAULT_FACTOR);
  });
});

test.describe("WindProtectionStore persistence", () => {
  test("toJSON / fromJSON round-trips the learned state", () => {
    const store = new WindProtectionStore({
      alpha: 0.3,
      maxPlaces: 50,
      learnGusts: true,
      minForecastWindKnots: 6,
    });
    store.learn({
      placeKey: "home",
      sector: 2,
      night: false,
      measuredSpeed: 4,
      forecastSpeed: 10,
      measuredGust: 8,
      forecastGust: 20,
    });
    store.learn({
      placeKey: "home",
      sector: 2,
      night: true,
      measuredSpeed: 4,
      forecastSpeed: 10,
      measuredGust: 25,
      forecastGust: 20,
    });

    const json = store.toJSON();
    const restored = WindProtectionStore.fromJSON(json);

    assert.strictEqual(restored.sizePlaces, store.sizePlaces);
    assert.strictEqual(restored.sizeSpeed, store.sizeSpeed);
    assert.strictEqual(restored.sizeGust, store.sizeGust);
    const day = restored.getFactors("home", 2, false);
    const night = restored.getFactors("home", 2, true);
    assert.ok(
      Math.abs(day.speed - store.getFactors("home", 2, false).speed) < 1e-9,
    );
    assert.ok(
      Math.abs(night.gust - store.getFactors("home", 2, true).gust) < 1e-9,
    );
    assert.strictEqual(restored.minForecastWindKnots, 6);
  });

  test("fromJSON tolerates empty/null data", () => {
    const store = WindProtectionStore.fromJSON(null);
    assert.strictEqual(store.sizeSpeed, 0);
    assert.strictEqual(store.sizeGust, 0);
  });
});

test.describe("WindProtectionStore gust learning disabled", () => {
  test("does not learn gusts when learnGusts is false", () => {
    const store = new WindProtectionStore({
      alpha: 0.5,
      maxPlaces: 10,
      learnGusts: false,
    });
    const updated = store.learn({
      placeKey: "p",
      sector: 0,
      night: false,
      measuredSpeed: 5,
      forecastSpeed: 10,
      measuredGust: 12,
      forecastGust: 20,
    });
    assert.strictEqual(updated, true);
    assert.strictEqual(store.sizeSpeed, 1);
    assert.strictEqual(store.sizeGust, 0);
    // Gust factor stays at default even though gusts were provided
    assert.strictEqual(store.getFactors("p", 0, false).gust, DEFAULT_FACTOR);
  });
});

test.describe("resolvePlace (anchorage matching)", () => {
  test("survives a swing on the anchor: ~100 m radius stays one place", () => {
    // The boat swings on its anchor within a ~100 m radius, but the wind
    // protection is a property of the anchorage. Samples taken across the
    // swing must map to a single place key so the EMA converges instead
    // of fragmenting across grid cells.
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 10 });
    // Drop at lat 60 (near a cell boundary for a 500 m grid with floor
    // binning — exactly the case that used to fragment).
    const dropLat = 60;
    const dropLon = 21.8765;
    const drop = store.resolvePlace(dropLat, dropLon, 500);
    const r = 100 / 111320; // 100 m in latitude degrees
    let fragmented = 0;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 2 * Math.PI;
      // Swing point ~80 m from the drop, in any direction
      const k = store.resolvePlace(
        dropLat + Math.cos(a) * r * 0.8,
        dropLon + Math.sin(a) * r * 0.8,
        500,
      );
      if (k !== drop) fragmented++;
    }
    assert.strictEqual(
      fragmented,
      0,
      `swing fragmented into ${fragmented} other cells`,
    );
  });

  test("re-anchoring nearby resolves to the same anchorage", () => {
    // On a revisit you don't drop the hook in the exact same spot, but
    // within ~100 m. The second drop must resolve to the existing
    // anchorage so the learned factors carry over.
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 10 });
    const first = store.resolvePlace(-18.86, -159.8, 500);
    // Re-drop ~80 m north and ~60 m east
    const rLat = 80 / 111320;
    const rLon = 60 / (111320 * Math.cos((-18.86 * Math.PI) / 180));
    const second = store.resolvePlace(-18.86 + rLat, -159.8 + rLon, 500);
    assert.strictEqual(second, first, "revisit should reuse the anchorage");
  });

  test("a distant drop registers a new anchorage", () => {
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 10 });
    const a = store.resolvePlace(-18.86, -159.8, 500);
    // 1 km away — well outside the 500 m match radius
    const far = 1000 / 111320;
    const b = store.resolvePlace(-18.86 + far, -159.8, 500);
    assert.notStrictEqual(a, b, "distant drop should be a new place");
    assert.strictEqual(store.sizePlaces, 0, "no factors learned yet");
  });

  test("returns null for an invalid position", () => {
    const store = new WindProtectionStore();
    assert.strictEqual(store.resolvePlace(null, 0, 500), null);
    assert.strictEqual(store.resolvePlace(NaN, NaN, 500), null);
  });

  test("real marina relocation: 143 m move and 144 m return stay one anchorage", () => {
    // Recorded data from 2026-08-17..22: the boat moored at a slip, then
    // relocated ~143 m to another slip within the same marina (state stayed
    // "moored" the whole time), stayed two days, then moved ~144 m back to
    // the original area. These are the same anchorage from a wind-protection
    // standpoint (same surrounding terrain), so they must resolve to one
    // place key and share the learned factors.
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 20 });
    const original = store.resolvePlace(-18.8639961, -159.8000363, 500);
    const moved = store.resolvePlace(-18.8644468, -159.8013448, 500);
    const returned = store.resolvePlace(-18.8640618, -159.8000556, 500);
    assert.strictEqual(
      moved,
      original,
      "143 m relocation within the marina should stay one anchorage",
    );
    assert.strictEqual(
      returned,
      original,
      "returning 144 m to the original area should reuse the anchorage",
    );
    assert.strictEqual(
      store.anchorages.size,
      1,
      "only one anchorage should be registered",
    );
    // Factors learned at the moved spot apply back at the original spot
    store.learn({
      placeKey: moved,
      sector: 2,
      night: false,
      measuredSpeed: 6,
      forecastSpeed: 15,
    });
    assert.ok(store.getFactors(original, 2, false).speed < 1);
  });
});

test.describe("anchorage persistence", () => {
  test("toJSON/fromJSON round-trips the anchorage registry", () => {
    const store = new WindProtectionStore({ alpha: 0.5, maxPlaces: 10 });
    store.resolvePlace(60, 21.8765, 500);
    store.resolvePlace(40, -122.42, 500);
    const json = store.toJSON();
    assert.ok(json.anchorages, "anchorages persisted");
    assert.strictEqual(Object.keys(json.anchorages).length, 2);

    const restored = WindProtectionStore.fromJSON(json);
    assert.strictEqual(restored.anchorages.size, 2);
    // A swing around the first anchorage still resolves to the same key
    const drop = [...restored.anchorages.keys()][0];
    const c = restored.anchorages.get(drop);
    const r = 80 / 111320;
    const k = restored.resolvePlace(c.lat + r, c.lon + r, 500);
    assert.strictEqual(k, drop, "restored anchorage still matches a swing");
  });
});
