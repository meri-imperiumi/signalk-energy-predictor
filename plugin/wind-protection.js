/**
 * Wind Protection Factor (WPF): learns a place-local correction factor
 * between measured and forecast wind while the boat is at rest, then
 * applies it to wind-dependent predictions at that place.
 *
 * The factor absorbs both local shelter (cliffs, forest, terrain) and NWP
 * bias for the site, which is acceptable because it is always applied
 * against the same forecast source.
 *
 * Two factors are learned:
 * - **Speed factor**: measured / forecast wind speed, per (place, wind
 *   direction sector of 45°). Shelter typically depends on where the wind
 *   comes from relative to the terrain, not exact degrees.
 * - **Gust factor**: measured gust / forecast gust, per (place, sector,
 *   day/night bin). Katabatic gusts can push this above 1.0 at night even
 *   where the mean speed factor is well below 1.0.
 *
 * Heights are normalized before learning and before application: the
 * anemometer (masthead) reading is translated to the 10 m forecast
 * reference using a logarithmic wind profile, and after WPF scaling the
 * corrected wind/gusts are translated down to device height (~5 m) for the
 * wind generator curve lookup and FLINsail gust gates.
 *
 * @file wind-protection.js
 */

/**
 * Number of wind direction sectors (8 sectors of 45°: N, NE, E, ..., NW).
 */
const SECTORS = 8;

/**
 * Default EMA smoothing factor for WPF learning.
 */
const DEFAULT_EMA_ALPHA = 0.05;

/**
 * Default factor for unlearned bins (no correction).
 */
const DEFAULT_FACTOR = 1.0;

/**
 * Minimum forecast wind speed (knots) for a sample to be usable. Ratios
 * are meaningless noise in calm conditions.
 */
const DEFAULT_MIN_FORECAST_WIND_KNOTS = 5;

/**
 * Default anemometer height above waterline (masthead), in meters.
 */
const DEFAULT_ANEMOMETER_HEIGHT_M = 13;

/**
 * Default device height (solar panels / wind generator) above waterline,
 * in meters.
 */
const DEFAULT_DEVICE_HEIGHT_M = 5;

/**
 * Default roughness length for the log wind profile (open water).
 */
const DEFAULT_ROUGHNESS_LENGTH = 0.0002;

/**
 * Height that NWP wind (Open-Meteo wind_speed_10m) is referenced to.
 */
const FORECAST_REFERENCE_HEIGHT_M = 10;

/**
 * Bins a wind direction (degrees, true-north, where the wind comes FROM)
 * into one of 8 sectors of 45°. Sector 0 is N [337.5°, 22.5°), then
 * clockwise: 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW.
 *
 * @param {number} dirDeg - Wind direction in degrees (meteorological: where
 *   the wind comes from)
 * @returns {number} Sector index 0–7, or -1 if direction is null/invalid
 */
function sectorFromDeg(dirDeg) {
  if (dirDeg == null || isNaN(dirDeg)) return -1;
  // Normalize to [0, 360)
  let d = dirDeg % 360;
  if (d < 0) d += 360;
  // Shift by -22.5° so sector 0 centers on north
  d = (d + 22.5) % 360;
  return Math.floor(d / 45);
}

/**
 * Bins a Signal K wind direction (radians, true-north, where the wind
 * comes FROM) into one of 8 sectors. Convenience wrapper around
 * `sectorFromDeg` since Signal K reports `environment.wind.directionTrue`
 * in radians.
 *
 * @param {number} dirRad - Wind direction in radians (meteorological)
 * @returns {number} Sector index 0–7, or -1 if direction is null/invalid
 */
function sectorFromRad(dirRad) {
  if (dirRad == null || isNaN(dirRad)) return -1;
  return sectorFromDeg((dirRad * 180) / Math.PI);
}

/**
 * Computes a snapped-to-center grid cell key for a position.
 *
 * The cell size is approximate (meters); the actual cell is derived from
 * the corresponding degree resolution. Latitude is binned directly; the
 * longitude bin width shrinks toward the poles by cos(lat) so cells stay
 * roughly square in meters.
 *
 * Positions are snapped to the **nearest** cell center (round, not floor)
 * so a boat swinging on its anchor — typically within a ~100 m radius —
 * maps to the same cell as long as the swing stays within half a cell of a
 * center. With the default 500 m cell this gives a ~250 m margin, large
 * enough that a normal anchor swing doesn't fragment one anchorage across
 * cell boundaries. (Snapping to the center, rather than the floor, avoids
 * the worst-case where a boat anchored near a boundary flips between two
 * cells on every swing.)
 *
 * @param {number} lat - Latitude in degrees
 * @param {number} lon - Longitude in degrees
 * @param {number} cellSizeM - Approximate cell size in meters
 * @returns {string} Cell key, e.g. "60.125_21.875"
 */
function placeKey(lat, lon, cellSizeM = 500) {
  // 1° of latitude ≈ 111 320 m
  const latStepDeg = cellSizeM / 111320;
  // Round to nearest cell center so a swinging boat snaps to one anchorage
  const latBin = Math.round(lat / latStepDeg) * latStepDeg;

  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Longitude degrees per meter shrinks toward the poles; clamp to avoid
  // division collapse at the poles (where WPF is irrelevant anyway)
  const lonMetersPerDeg = 111320 * Math.max(cosLat, 0.01);
  const lonStepDeg = cellSizeM / lonMetersPerDeg;
  const lonBin = Math.round(lon / lonStepDeg) * lonStepDeg;

  // Round to a fixed precision so the key is stable and human-readable
  const precision = 6;
  return `${round(latBin, precision)}_${round(lonBin, precision)}`;
}

/**
 * Rounds to a fixed number of decimal places, trimming trailing zeros.
 * @param {number} v
 * @param {number} decimals
 * @returns {number}
 */
function round(v, decimals) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/**
 * Determines the day/night bin from the sun elevation.
 * Night is elevation ≤ 0 (sun on or below horizon).
 *
 * @param {number} sunElevationRad - Sun elevation in radians
 * @returns {boolean} true if night
 */
function isNight(sunElevationRad) {
  return sunElevationRad <= 0;
}

/**
 * Translates a wind speed from one height to another using the logarithmic
 * wind profile v(z) = v_ref · ln(z/z₀) / ln(z_ref/z₀).
 *
 * This is a standard log-law approximation, not physics — obstacles and
 * canopy break it inside harbors, but it beats ignoring height entirely.
 * Heights below 1 m are clamped to 1 m to avoid ln(≤0).
 *
 * @param {number} speed - Wind speed at zFrom
 * @param {number} zFrom - Source height in meters
 * @param {number} zTo - Target height in meters
 * @param {number} z0 - Roughness length in meters
 * @returns {number} Wind speed at zTo
 */
function translateWindSpeed(speed, zFrom, zTo, z0 = DEFAULT_ROUGHNESS_LENGTH) {
  if (speed == null || isNaN(speed)) return speed;
  if (zFrom == null || zTo == null || zFrom <= 0 || zTo <= 0) return speed;
  const zf = Math.max(zFrom, 1);
  const zt = Math.max(zTo, 1);
  const z = Math.max(z0, 1e-6);
  const ratio = Math.log(zt / z) / Math.log(zf / z);
  return speed * ratio;
}

/**
 * Normalizes an anemometer reading to the 10 m forecast reference height.
 *
 * @param {number} speed - Wind speed at the anemometer
 * @param {number} anemometerHeightM - Anemometer height in meters
 * @param {number} z0 - Roughness length in meters
 * @returns {number} Wind speed at 10 m
 */
function toForecastReference(speed, anemometerHeightM, z0) {
  return translateWindSpeed(
    speed,
    anemometerHeightM,
    FORECAST_REFERENCE_HEIGHT_M,
    z0,
  );
}

/**
 * Translates a 10 m-reference wind speed down to device height.
 *
 * After WPF scaling at the 10 m reference, the corrected wind/gusts are
 * translated down to device height for the wind generator curve lookup and
 * FLINsail gust gates — the panels and wind gen never see masthead wind.
 *
 * @param {number} speed - Wind speed at 10 m
 * @param {number} deviceHeightM - Device height in meters
 * @param {number} z0 - Roughness length in meters
 * @returns {number} Wind speed at device height
 */
function toDeviceHeight(speed, deviceHeightM, z0) {
  return translateWindSpeed(
    speed,
    FORECAST_REFERENCE_HEIGHT_M,
    deviceHeightM,
    z0,
  );
}

/**
 * Key combining a place and a wind direction sector: `"<placeKey>_<sector>"`.
 *
 * @param {string} key - Place key
 * @param {number} sector - Sector index 0–7, or -1 for unknown
 * @returns {string} Combined key
 */
function placeSectorKey(key, sector) {
  return `${key}_${sector < 0 ? "?" : sector}`;
}

/**
 * Key combining place, sector, and day/night bin.
 *
 * @param {string} key - Place key
 * @param {number} sector - Sector index 0–7, or -1
 * @param {boolean} night - Day/night bin
 * @returns {string} Combined key
 */
function placeSectorNightKey(key, sector, night) {
  return `${placeSectorKey(key, sector)}_${night ? "n" : "d"}`;
}

/**
 * Clamp a factor to a sane range. The speed factor is bounded below by 0
 * (no negative wind) and above by a generous ceiling so a single bad
 * sample can't blow it to absurdity. Katabatic gusts legitimately exceed
 * 1.0, so the gust ceiling is higher than the speed ceiling.
 */
const SPEED_FACTOR_MIN = 0;
const SPEED_FACTOR_MAX = 2.5;
const GUST_FACTOR_MIN = 0;
const GUST_FACTOR_MAX = 4;

function clampSpeedFactor(v) {
  return Math.max(SPEED_FACTOR_MIN, Math.min(SPEED_FACTOR_MAX, v));
}

function clampGustFactor(v) {
  return Math.max(GUST_FACTOR_MIN, Math.min(GUST_FACTOR_MAX, v));
}

/**
 * Great-circle distance between two lat/lon points, in meters.
 *
 * Used to resolve a live position to the nearest known anchorage so a
 * boat swinging on its anchor — or re-anchoring nearby — maps back to the
 * same anchorage instead of fragmenting across grid-cell boundaries.
 *
 * @param {number} lat1 - Degrees
 * @param {number} lon1 - Degrees
 * @param {number} lat2 - Degrees
 * @param {number} lon2 - Degrees
 * @returns {number} Distance in meters
 */
function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius, m
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Wind Protection Factor learning store.
 *
 * Holds two EMAs per (place, sector) and per (place, sector, day/night):
 * a speed factor and a gust factor. Places are kept in an LRU so the
 * favorite anchorages and the home marina converge quickly while a cap
 * prevents unbounded growth from one-off stops.
 */
class WindProtectionStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.alpha] - EMA smoothing factor
   * @param {number} [opts.maxPlaces] - LRU cap on stored places
   * @param {boolean} [opts.learnGusts] - Whether to learn the gust factor
   *   (the measured gust is the max of recent wind speed samples — no
   *   gust sensor is required; when disabled only the speed factor is
   *   learned)
   * @param {number} [opts.minForecastWindKnots] - Minimum forecast wind
   *   for a sample to be used
   */
  constructor({
    alpha = DEFAULT_EMA_ALPHA,
    maxPlaces = 100,
    learnGusts = true,
    minForecastWindKnots = DEFAULT_MIN_FORECAST_WIND_KNOTS,
  } = {}) {
    this.alpha = alpha;
    this.maxPlaces = maxPlaces;
    this.learnGusts = learnGusts;
    this.minForecastWindKnots = minForecastWindKnots;

    /** @type {Map<string, number>} placeSectorKey → speed factor */
    this.speedFactors = new Map();
    /** @type {Map<string, number>} placeSectorNightKey → gust factor */
    this.gustFactors = new Map();

    /** LRU of place keys (most-recently-used at the end) */
    /** @type {string[]} */
    this.placeLru = [];

    /**
     * Registry of known anchorage centroids: placeKey →
     * {lat, lon, count}. A live position resolves to the nearest anchorage
     * within the match radius so a boat swinging on its anchor (or
     * re-anchoring nearby) keeps mapping to the same place instead of
     * fragmenting across grid-cell boundaries.
     * @type {Map<string, {lat: number, lon: number, count: number}>}
     */
    this.anchorages = new Map();
  }

  /**
   * Resolves a live position to a place key.
   *
   * If the position is within `matchRadiusM` of a known anchorage's
   * centroid, that anchorage's key is reused (and its centroid is nudged
   * toward the new position). Otherwise a new anchorage is registered with
   * a grid-snapped key. This is what makes a swing on the anchor and a
   * nearby re-anchoring land in the same place.
   *
   * @param {number} lat - Latitude in degrees
   * @param {number} lon - Longitude in degrees
   * @param {number} [matchRadiusM] - Max distance to reuse an existing
   *   anchorage. Defaults to the configured cell size.
   * @returns {string|null} Place key, or null when the position is invalid
   */
  resolvePlace(lat, lon, matchRadiusM = 500) {
    if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return null;
    let bestKey = null;
    let bestDist = Infinity;
    for (const [key, c] of this.anchorages) {
      const d = distanceM(lat, lon, c.lat, c.lon);
      if (d < bestDist) {
        bestDist = d;
        bestKey = key;
      }
    }
    if (bestKey != null && bestDist <= matchRadiusM) {
      // Nudge the centroid toward the new observation (running mean)
      const c = this.anchorages.get(bestKey);
      const n = c.count + 1;
      c.lat = (c.lat * c.count + lat) / n;
      c.lon = (c.lon * c.count + lon) / n;
      c.count = n;
      return bestKey;
    }
    // Register a new anchorage with a grid-snapped key
    const key = placeKey(lat, lon, matchRadiusM);
    this.anchorages.set(key, { lat, lon, count: 1 });
    return key;
  }

  /**
   * Learns from a single observation, applying the sanitization gates.
   *
   * Gates (analogous to the solar learning gate):
   * - Only when forecast wind ≥ minForecastWindKnots (ratios are noise in
   *   calm)
   * - The measured and forecast speeds must be positive and finite
   * - Gust learning is skipped if either gust value is missing or below the
   *   gate
   *
   * @param {object} p
   * @param {string} p.placeKey - Place cell key
   * @param {number} p.sector - Wind direction sector 0–7 (-1 = unknown; the
   *   sample is still used, bucketed under "?")
   * @param {boolean} p.night - Day/night bin (for the gust factor)
   * @param {number} p.measuredSpeed - Measured wind speed at the 10 m
   *   reference (already height-normalized by the caller), in knots
   * @param {number} p.forecastSpeed - Forecast wind speed in knots
   * @param {number|null} [p.measuredGust] - Measured gust at the 10 m
   *   reference, in knots (optional)
   * @param {number|null} [p.forecastGust] - Forecast gust in knots (optional)
   * @returns {boolean} true if the store was updated
   */
  learn({
    placeKey,
    sector,
    night,
    measuredSpeed,
    forecastSpeed,
    measuredGust,
    forecastGust,
  }) {
    if (placeKey == null) return false;

    // Speed factor gate
    const speedUpdated = this._learnSpeed(
      placeKey,
      sector,
      measuredSpeed,
      forecastSpeed,
    );

    // Gust factor gate (only if enabled and both gusts present and above the
    // same min-wind threshold — a forecast gust below the threshold means
    // the ratio is noise)
    let gustUpdated = false;
    if (
      this.learnGusts &&
      measuredGust != null &&
      forecastGust != null &&
      isFinite(measuredGust) &&
      isFinite(forecastGust) &&
      forecastGust >= this.minForecastWindKnots &&
      measuredGust >= 0
    ) {
      gustUpdated = this._learnGust(
        placeKey,
        sector,
        night,
        measuredGust,
        forecastGust,
      );
    }

    if (speedUpdated || gustUpdated) {
      this._touchPlace(placeKey);
      return true;
    }
    return false;
  }

  /**
   * @private
   */
  _learnSpeed(placeKey, sector, measuredSpeed, forecastSpeed) {
    if (
      measuredSpeed == null ||
      forecastSpeed == null ||
      !isFinite(measuredSpeed) ||
      !isFinite(forecastSpeed) ||
      forecastSpeed < this.minForecastWindKnots ||
      measuredSpeed < 0
    ) {
      return false;
    }
    const observed = clampSpeedFactor(measuredSpeed / forecastSpeed);
    const key = placeSectorKey(placeKey, sector);
    const existing = this.speedFactors.get(key) ?? DEFAULT_FACTOR;
    const updated = this.alpha * observed + (1 - this.alpha) * existing;
    this.speedFactors.set(key, clampSpeedFactor(updated));
    return true;
  }

  /**
   * @private
   */
  _learnGust(placeKey, sector, night, measuredGust, forecastGust) {
    const observed = clampGustFactor(measuredGust / forecastGust);
    const key = placeSectorNightKey(placeKey, sector, night);
    const existing = this.gustFactors.get(key) ?? DEFAULT_FACTOR;
    const updated = this.alpha * observed + (1 - this.alpha) * existing;
    this.gustFactors.set(key, clampGustFactor(updated));
    return true;
  }

  /**
   * Marks a place as most-recently-used, evicting the oldest if over the cap.
   *
   * @private
   */
  _touchPlace(placeKey) {
    const i = this.placeLru.indexOf(placeKey);
    if (i >= 0) this.placeLru.splice(i, 1);
    this.placeLru.push(placeKey);

    while (this.placeLru.length > this.maxPlaces) {
      const evicted = this.placeLru.shift();
      this._evictPlace(evicted);
    }
  }

  /**
   * Removes all factors for a place and drops its anchorage centroid.
   * @private
   */
  _evictPlace(placeKey) {
    const prefix = `${placeKey}_`;
    for (const k of [...this.speedFactors.keys()]) {
      if (k.startsWith(prefix)) this.speedFactors.delete(k);
    }
    for (const k of [...this.gustFactors.keys()]) {
      if (k.startsWith(prefix)) this.gustFactors.delete(k);
    }
    this.anchorages.delete(placeKey);
  }

  /**
   * Gets the correction factors for a place/sector/night bin.
   *
   * Unknown place, unknown sector, or unlearned bins return the default
   * (1.0 — no correction).
   *
   * @param {string} key - Place cell key
   * @param {number} sector - Wind direction sector 0–7, or -1
   * @param {boolean} night - Day/night bin (for the gust factor)
   * @returns {{speed: number, gust: number}}
   */
  getFactors(key, sector, night) {
    if (key == null) return { speed: DEFAULT_FACTOR, gust: DEFAULT_FACTOR };
    const speed =
      this.speedFactors.get(placeSectorKey(key, sector)) ?? DEFAULT_FACTOR;
    const gust =
      this.gustFactors.get(placeSectorNightKey(key, sector, night)) ??
      DEFAULT_FACTOR;
    return { speed, gust };
  }

  /**
   * @returns {number} number of learned speed bins
   */
  get sizeSpeed() {
    return this.speedFactors.size;
  }

  /**
   * @returns {number} number of learned gust bins
   */
  get sizeGust() {
    return this.gustFactors.size;
  }

  /**
   * @returns {number} number of distinct known places
   */
  get sizePlaces() {
    return this.placeLru.length;
  }

  /**
   * Serializes the store for persistence.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      version: 1,
      alpha: this.alpha,
      maxPlaces: this.maxPlaces,
      learnGusts: this.learnGusts,
      minForecastWindKnots: this.minForecastWindKnots,
      speedFactors: Object.fromEntries(this.speedFactors),
      gustFactors: Object.fromEntries(this.gustFactors),
      placeLru: this.placeLru,
      anchorages: Object.fromEntries(this.anchorages),
    };
  }

  /**
   * Hydrates a store from persisted data.
   *
   * @param {object} data
   * @returns {WindProtectionStore}
   */
  static fromJSON(data) {
    const store = new WindProtectionStore({
      alpha: data?.alpha,
      maxPlaces: data?.maxPlaces,
      learnGusts: data?.learnGusts,
      minForecastWindKnots: data?.minForecastWindKnots,
    });
    if (data?.speedFactors) {
      store.speedFactors = new Map(Object.entries(data.speedFactors));
    }
    if (data?.gustFactors) {
      store.gustFactors = new Map(Object.entries(data.gustFactors));
    }
    if (Array.isArray(data?.placeLru)) {
      store.placeLru = [...data.placeLru];
    }
    if (data?.anchorages) {
      store.anchorages = new Map(Object.entries(data.anchorages));
    }
    return store;
  }
}

module.exports = {
  WindProtectionStore,
  sectorFromDeg,
  sectorFromRad,
  placeKey,
  isNight,
  translateWindSpeed,
  toForecastReference,
  toDeviceHeight,
  placeSectorKey,
  placeSectorNightKey,
  SECTORS,
  DEFAULT_EMA_ALPHA,
  DEFAULT_FACTOR,
  DEFAULT_MIN_FORECAST_WIND_KNOTS,
  DEFAULT_ANEMOMETER_HEIGHT_M,
  DEFAULT_DEVICE_HEIGHT_M,
  DEFAULT_ROUGHNESS_LENGTH,
  FORECAST_REFERENCE_HEIGHT_M,
};
