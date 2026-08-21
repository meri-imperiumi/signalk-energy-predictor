/**
 * 24-hour prediction engine for energy balance forecasting.
 *
 * Combines weather forecasts, learning matrix efficiencies, and load profiles
 * to predict future SoC and generate advisories.
 *
 * @file prediction.js
 */

const { sunPosition, nextSunrise, lastSunset } = require("./solar.js");

/**
 * Prediction horizon in hours
 */
const PREDICTION_HOURS = 24;

/**
 * House load smoothing window in hours
 */
const LOAD_SMOOTHING_HOURS = 3;

/**
 * Hourly prediction result.
 * @typedef {{hour: number, time: Date, idealSolarYieldWh: number, idealWindYieldWh: number, houseLoadWh: number, idealNetWh: number, idealSoC: number, detectedYieldWh: number, detectedNetWh: number, detectedSoC: number, actions: Array<{id: string, idealAction: string, detectedAction: string|null, reason: string}>}} HourlyPrediction
 */

/**
 * Wind generator curve point.
 * @typedef {{speed: number, watts: number}} CurvePoint
 */

/**
 * Interpolates power from a wind generator curve.
 *
 * @param {CurvePoint[]} curve - Array of [speed, watts] points, sorted by speed
 * @param {number} speedKnots - Wind speed in knots
 * @returns {number} Power in watts
 */
function interpolateWindPower(curve, speedKnots) {
  if (curve.length === 0) {
    return 0;
  }

  if (speedKnots <= curve[0].speed) {
    return 0; // Below cut-in
  }

  if (speedKnots >= curve[curve.length - 1].speed) {
    return curve[curve.length - 1].watts; // Above last point (should be rated power)
  }

  // Find the interval containing speedKnots
  for (let i = 1; i < curve.length; i++) {
    if (speedKnots <= curve[i].speed) {
      const t =
        (speedKnots - curve[i - 1].speed) /
        (curve[i].speed - curve[i - 1].speed);
      return curve[i - 1].watts + t * (curve[i].watts - curve[i - 1].watts);
    }
  }

  return 0;
}

/**
 * Calculates predicted solar yield for an hour.
 *
 * @param {object} params
 * @param {object} params.array - Solar array configuration
 * @param {string} params.array.id - Array ID
 * @param {string} params.array.type - "fixed" or "deployable"
 * @param {number} params.array.capacityWp - Capacity in peak watts
 * @param {number|null} params.array.gustLimitKnots - Gust limit for deployable arrays
 * @param {object} params.sunPosition - Sun position {azimuth, altitude}
 * @param {number} params.ghi - Global Horizontal Irradiance in W/m²
 * @param {number} params.windGustKnots - Wind gust speed in knots
 * @param {number} params.efficiency - Array efficiency [0, 1] from learning matrix
 * @returns {number} Predicted yield in watt-hours for the hour
 */
function predictSolarHour({
  array,
  sunPosition,
  ghi,
  windGustKnots,
  efficiency,
}) {
  // Check FLINsail risk for deployable arrays
  if (array.type === "deployable" && array.gustLimitKnots != null) {
    if (windGustKnots >= array.gustLimitKnots) {
      return 0; // Should be stowed, no yield
    }
  }

  // Calculate instantaneous power
  const sinElevation = Math.sin(sunPosition.altitude);
  if (sinElevation <= 0 || ghi <= 0) {
    return 0;
  }

  const irradianceFactor = ghi / 1367;
  const theoreticalPower = array.capacityWp * irradianceFactor * sinElevation;
  const actualPower = theoreticalPower * efficiency;

  // Convert to watt-hours for the hour
  return actualPower;
}

/**
 * Calculates predicted wind generator yield for an hour.
 *
 * @param {object} params
 * @param {object} params.generator - Generator configuration
 * @param {string} params.generator.id - Generator ID
 * @param {string} params.generator.type - "wind" or "hydro"
 * @param {boolean} params.generator.deployable - Whether generator is deployable
 * @param {CurvePoint[]} params.generator.curve - Power curve
 * @param {number} params.windSpeedKnots - Average wind speed in knots
 * @param {number} [params.gustSpeedKnots] - Gust speed in knots (deployable: stow if exceeds max)
 * @param {boolean} params.isSailing - Whether vessel is sailing (affects deployable yield)
 * @returns {number} Predicted yield in watt-hours for the hour
 */
function predictWindHour({
  generator,
  windSpeedKnots,
  gustSpeedKnots,
  isSailing = false,
  navState = "unknown",
}) {
  if (generator.type !== "wind") {
    return 0;
  }

  const maxWind = generator.maxWindKnots ?? 30;

  // Apply wind speed limit
  if (windSpeedKnots > maxWind) {
    return 0; // Exceeds limit, would be stowed
  }

  // Deployable wind generators: stow if gusts exceed the max limit
  if (
    generator.deployable &&
    gustSpeedKnots != null &&
    gustSpeedKnots >= maxWind
  ) {
    return 0; // Gusts exceed limit, would be stowed
  }

  // Deployable wind generators are used at anchor/moored, NOT under way
  if (generator.deployable) {
    if (navState === "sailing" || navState === "motoring") {
      return 0; // Stowed when under way (hydro or engine are available)
    }
    // When anchored/moored, assume deployed
  }

  const power = interpolateWindPower(generator.curve, windSpeedKnots);
  return power; // Watts -> Wh for the hour
}

/**
 * Calculates predicted hydro generator yield for an hour.
 *
 * @param {object} params
 * @param {object} params.generator - Generator configuration
 * @param {string} params.generator.id - Generator ID
 * @param {string} params.generator.type - "wind" or "hydro"
 * @param {boolean} params.generator.deployable - Whether generator is deployable
 * @param {CurvePoint[]} params.generator.curve - Power curve
 * @param {number} params.speedThroughWaterKnots - Vessel speed through water in knots
 * @param {boolean} params.isSailing - Whether vessel is sailing
 * @returns {number} Predicted yield in watt-hours for the hour
 */
function predictHydroHour({
  generator,
  speedThroughWaterKnots,
  isSailing = false,
}) {
  if (generator.type !== "hydro") {
    return 0;
  }

  const minSpeed = generator.minSpeedKnots ?? 3;
  const maxSpeed = generator.maxSpeedKnots ?? 12;

  // Hydro generators only work when the vessel is moving through water
  // Apply min/max limits
  if (speedThroughWaterKnots < minSpeed) {
    return 0; // Too slow, not generating
  }
  if (speedThroughWaterKnots > maxSpeed) {
    return 0; // Too fast, would be stowed for safety
  }

  // If the forecast doesn't include speed data, assume sailing for hydro prediction
  // (since that's when hydro makes sense) or use a conservative estimate
  if (!isSailing && speedThroughWaterKnots > 0) {
    // Vessel is moving but not explicitly sailing (could be motoring)
    // Assume hydro is deployed half the time
    speedThroughWaterKnots *= 0.5;
  } else if (!isSailing && speedThroughWaterKnots === 0) {
    return 0; // Not moving, no hydro yield
  }

  // Hydro generators use water speed (speed through water) instead of wind speed
  const power = interpolateWindPower(generator.curve, speedThroughWaterKnots);
  return power; // Watts -> Wh for the hour
}

/**
 * Maintains a rolling average of house loads.
 */
class LoadProfile {
  constructor() {
    this.samples = []; // Array of {time: Date, loadWh}
  }

  /**
   * Adds a load sample.
   *
   * @param {number} loadWh - Load in watt-hours (instantaneous, convert if reading is watts)
   */
  addSample(loadWh) {
    this.samples.push({
      time: new Date(),
      loadWh,
    });

    // Keep samples within smoothing window
    const cutoff = Date.now() - LOAD_SMOOTHING_HOURS * 3600000;
    this.samples = this.samples.filter((s) => s.time.getTime() > cutoff);
  }

  /**
   * Gets the average hourly load.
   *
   * @returns {number} Average load in watt-hours per hour
   */
  getAverageLoad() {
    if (this.samples.length === 0) {
      return 0;
    }

    const total = this.samples.reduce((sum, s) => sum + s.loadWh, 0);
    return total / this.samples.length;
  }
}

/**
 * Extracts a numeric value from a Signal K value that may be a number or an object with .value.
 * @param {unknown} v
 * @returns {number|null}
 */
function toNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return isNaN(v) ? null : v;
  if (typeof v === "object" && typeof v.value === "number")
    return isNaN(v.value) ? null : v.value;
  return null;
}

/** Conversion factor: 1 m/s = 1.94384 knots */
const MS_TO_KN = 1.94384;

/**
 * Normalizes an angle to [-π, π).
 * @param {number} a - Angle in radians
 * @returns {number} Normalized angle
 */
function normalizeAngle(a) {
  let r = a;
  while (r >= Math.PI) r -= 2 * Math.PI;
  while (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

/**
 * Inserts an action into the hourly bucket containing the target time.
 * Targets before the forecast window clamp to hour 0; targets beyond the
 * window are dropped. Replaces an existing action for the same device in
 * the bucket.
 *
 * @param {HourlyPrediction[]} predictions - Hourly predictions (mutated)
 * @param {number} startTimeMs - First bucket time in milliseconds
 * @param {Date} targetTime - Exact time the action should occur
 * @param {object} action - Action object (its `time` field is updated)
 * @returns {void}
 */
function insertActionIntoBucket(predictions, startTimeMs, targetTime, action) {
  let h = Math.floor((targetTime.getTime() - startTimeMs) / 3600000);
  if (h < 0) {
    // Target is before the forecast window (e.g. sunset already passed):
    // the right advice is to act now, so stamp with the current hour's time
    h = 0;
    action.time = predictions[0].time.toISOString();
  } else {
    action.time = targetTime.toISOString();
  }
  if (h >= predictions.length) return;
  const bucket = predictions[h].actions;
  const idx = bucket.findIndex((a) => a.id === action.id);
  if (idx >= 0) {
    bucket[idx] = action;
  } else {
    bucket.push(action);
  }
}

/**
 * Formats a bearing (radians) as a compass bearing string (e.g. "090°").
 * @param {number} rad - Bearing in radians
 * @returns {string} Bearing in degrees, 3-digit
 */
function formatBearing(rad) {
  const deg = ((rad * 180) / Math.PI + 360) % 360;
  return `${Math.round(deg).toString().padStart(3, "0")}°`;
}

/**
 * Formats a Date as a 24-hour time string (HH:MM).
 * @param {Date} date - Date to format
 * @returns {string} Formatted time
 */
function formatTime(date) {
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Converts a Signal K speed value (m/s) to knots.
 * Handles plain numbers and {value: number} objects.
 * @param {number|object|null} v - Speed in m/s
 * @returns {number|null} Speed in knots, or null
 */
function toKnots(v) {
  const ms = toNumber(v);
  return ms == null ? null : ms * MS_TO_KN;
}

/**
 * Prediction engine.
 */
class PredictionEngine {
  /**
   * @param {object} params
   * @param {object} params.battery - Battery configuration
   * @param {number} params.battery.capacityAh - Battery capacity in Ah
   * @param {number} params.battery.systemVoltage - System voltage in volts
   * @param {number} params.battery.minSafeSoC - Minimum safe SoC [0, 1]
   * @param {object[]} params.solarArrays - Solar array configurations
   * @param {object[]} params.mechanicalGenerators - Wind/hydro generator configurations
   * @param {(arrayId: string, isSailing: boolean, azimuth: number, elevation: number, awa?: number) => number} getEfficiency - Function to get efficiency from learning matrix
   * @param {(path: string) => unknown} getSelfPath - Function to read Signal K values
   */
  constructor({
    battery,
    solarArrays,
    mechanicalGenerators,
    getEfficiency,
    getSelfPath,
    getDisplayName,
    app,
  }) {
    this.battery = battery;
    this.solarArrays = solarArrays;
    this.mechanicalGenerators = mechanicalGenerators;
    this.getEfficiency = getEfficiency;
    this.getSelfPath = getSelfPath;
    this.getDisplayName =
      getDisplayName || ((config) => config.name || config.id);
    this.app = app;

    this.capacityWh = battery.capacityAh * battery.systemVoltage;
    this.loadProfile = new LoadProfile();
    this.lastPrediction = [];
    this.lastForecast = [];
  }

  /**
   * Updates the load profile with current house load.
   *
   * @returns {void}
   */
  updateLoadProfile() {
    // Read actual consumption from Victron Venus
    // dcPower and acPower are already net consumption (producers removed)
    const rawDc = this.getSelfPath("electrical.venus.dcPower");
    const rawAc = this.getSelfPath("electrical.venus.acPower");
    const dcPowerW = toNumber(rawDc);
    const acPowerW = toNumber(rawAc);

    this.app?.debug?.(
      `updateLoadProfile: dcPower=${JSON.stringify(rawDc)} (${dcPowerW}), acPower=${JSON.stringify(rawAc)} (${acPowerW}), samples=${this.loadProfile.samples.length}`,
    );

    if (dcPowerW != null || acPowerW != null) {
      const totalConsumptionW = (dcPowerW ?? 0) + (acPowerW ?? 0);
      this.loadProfile.addSample(totalConsumptionW);
    }
  }

  /**
   * Gets the current apparent wind angle.
   *
   * @returns {number|null} AWA in radians
   */
  getAWA() {
    return toNumber(this.getSelfPath("environment.wind.angleApparent"));
  }

  /**
   * Gets the current speed through water.
   *
   * @returns {number|null} Speed in knots
   */
  getSpeedThroughWater() {
    return toKnots(this.getSelfPath("navigation.speedThroughWater"));
  }

  /**
   * Gets the current true heading in radians.
   * Signal K heading is in radians (0 = north, positive clockwise).
   * @returns {number|null} Heading in radians, or null if unavailable
   */
  getHeadingTrue() {
    const h = this.getSelfPath("navigation.headingTrue");
    const val = toNumber(h);
    if (val == null || isNaN(val)) return null;
    // Normalize to [-π, π)
    let heading = val;
    while (heading >= Math.PI) heading -= 2 * Math.PI;
    while (heading < -Math.PI) heading += 2 * Math.PI;
    return heading;
  }

  /**
   * Gets the current navigation state.
   * @returns {string} One of: sailing, motoring, anchored, moored, under way, unknown
   */
  getNavState() {
    const state = this.getSelfPath("navigation.state");
    return state || "unknown";
  }

  /**
   * Determines if the vessel is under way (sailing, motoring, or under way).
   * @returns {boolean}
   */
  isUnderway() {
    const state = this.getNavState();
    return ["sailing", "motoring", "under way"].includes(state);
  }

  /**
   * Gets the current gust speed from forecast (first forecast point near now).
   * @returns {number|null} Gust speed in knots
   */
  getCurrentGustKnots() {
    if (this.lastPrediction.length === 0) return null;
    const now = new Date();
    const current = this.lastPrediction.find(
      (p) => Math.abs(p.time.getTime() - now.getTime()) < 1800000,
    );
    return current?.gustSpeedKnots ?? null;
  }

  /**
   * Gets the current wind speed from forecast (first forecast point near now).
   * @returns {number|null} Wind speed in knots
   */
  getCurrentWindKnots() {
    if (this.lastPrediction.length === 0) return null;
    const now = new Date();
    const current = this.lastPrediction.find(
      (p) => Math.abs(p.time.getTime() - now.getTime()) < 1800000,
    );
    return current?.windSpeedKnots ?? null;
  }

  /**
   * Gets the maximum forecast gust over the prediction window.
   * @returns {number} Max gust in knots
   */
  getMaxForecastGust() {
    return this.lastPrediction.reduce((max, p) => {
      return Math.max(max, p.gustSpeedKnots ?? 0);
    }, 0);
  }

  /**
   * Gets the maximum forecast wind speed over the prediction window.
   * @returns {number} Max wind speed in knots
   */
  getMaxForecastWind() {
    return this.lastPrediction.reduce((max, p) => {
      return Math.max(max, p.windSpeedKnots ?? 0);
    }, 0);
  }

  /**
   * Computes the potential 24h yield (in Wh) for a deployable device if it were deployed.
   * Uses the last forecast and prediction data.
   *
   * @param {string} deviceId - Device ID
   * @returns {number} Potential yield in watt-hours over the prediction window
   */
  getPotentialYieldWh(deviceId) {
    if (this.lastForecast.length === 0) return 0;

    const array = this.solarArrays.find((a) => a.id === deviceId);
    if (array && array.type === "deployable") {
      const pos = this.getSelfPath("navigation.position");
      const lat = pos?.latitude ?? 0;
      const lon = pos?.longitude ?? 0;
      let total = 0;
      for (const point of this.lastForecast) {
        const time = new Date(
          point.time.getTime
            ? point.time.getTime()
            : new Date(point.time).getTime(),
        );
        const sunPos = sunPosition(time, lat, lon);
        const ghi = point.ghi ?? 0;
        const windGustKnots = point.gustSpeedKnots ?? 0;
        const efficiency = this.getEfficiency(
          array.id,
          false,
          sunPos.azimuth,
          sunPos.altitude,
        );
        total += predictSolarHour({
          array,
          sunPosition: sunPos,
          ghi,
          windGustKnots,
          efficiency,
        });
      }
      return Math.round(total);
    }

    const generator = this.mechanicalGenerators.find((g) => g.id === deviceId);
    if (generator) {
      let total = 0;
      const isSailing = this.getNavState() === "sailing";
      const speedThroughWater = this.getSpeedThroughWater() ?? 0;
      for (const point of this.lastForecast) {
        if (generator.type === "wind") {
          const windSpeedKnots = point.windSpeedKnots ?? 0;
          const gustSpeedKnots = point.gustSpeedKnots ?? 0;
          total += predictWindHour({
            generator,
            windSpeedKnots,
            gustSpeedKnots,
            isSailing,
          });
        } else if (generator.type === "hydro") {
          total += predictHydroHour({
            generator,
            speedThroughWaterKnots: speedThroughWater,
            isSailing,
          });
        }
      }
      return Math.round(total);
    }

    return 0;
  }

  /**
   * Computes a pointing recommendation (port/starboard) for a deployable solar array.
   *
   * During daytime (sun above horizon), side is based on the sun's current
   * azimuth relative to the boat's heading. After sunset, it targets the next
   * sunrise so the crew can set the sail overnight for first light.
   *
   * For the morning case, if the boat is anchored/moored the predicted heading
   * at sunrise is estimated from the forecast wind direction (boats point into
   * the wind). Falls back to current heading if no wind direction forecast
   * is available.
   *
   * @param {object} _array - Solar array config (must be type "deployable")
   * @returns {{side: string|null, targetTime: string|null, reason: string|null}|null}
   */
  getPointingRecommendation(_array) {
    const pos = this.getSelfPath("navigation.position");
    const lat = pos?.latitude;
    const lon = pos?.longitude;
    if (lat == null || lon == null) {
      return { side: null, targetTime: null, reason: "No GPS position" };
    }

    const now = new Date(Date.now());
    const sunPos = sunPosition(now, lat, lon);

    // Threshold: altitude > ~1° → daytime; ≤ 0° → morning; (0°, 1°] ambiguous → day
    const DAYTIME_THRESHOLD = 0.0175; // ~1 degree in radians

    // Sun above ~1° → clear daytime; ≤ 0° → morning; (0°, 1°] ambiguous → day
    if (sunPos.altitude > DAYTIME_THRESHOLD) {
      // Daytime: use current heading
      const heading = this.getHeadingTrue();
      if (heading == null) {
        return {
          side: null,
          targetTime: null,
          reason: "No heading — cannot determine side",
        };
      }
      const rel = normalizeAngle(sunPos.azimuth - heading);
      const side = rel > 0 ? "starboard" : rel < 0 ? "port" : null;
      if (side == null) {
        return {
          side: null,
          targetTime: now.toISOString(),
          reason: "Sun near dead ahead/astern, no side preference",
        };
      }
      return {
        side,
        targetTime: now.toISOString(),
        reason: `Point ${side}, sun at ${formatBearing(sunPos.azimuth)}`,
      };
    }

    // Morning: compute next sunrise
    const sunrise = nextSunrise(now, lat, lon);
    if (!sunrise) {
      return {
        side: null,
        targetTime: null,
        reason: "No sunrise in near future",
      };
    }
    const sunrisePos = sunPosition(sunrise, lat, lon);

    // For anchored/moored boats, predict heading from forecast wind direction
    let predictedHeading = this.getForecastWindDirectionAt(sunrise);
    if (predictedHeading == null) {
      predictedHeading = this.getHeadingTrue();
    }
    if (predictedHeading == null) {
      return {
        side: null,
        targetTime: sunrise.toISOString(),
        reason: `No heading — cannot determine side for morning (sunrise ${formatTime(sunrise)})`,
      };
    }

    const rel = normalizeAngle(sunrisePos.azimuth - predictedHeading);
    const side = rel > 0 ? "starboard" : rel < 0 ? "port" : null;
    if (side == null) {
      return {
        side: null,
        targetTime: sunrise.toISOString(),
        reason: `Sun rises near dead ahead/astern, no side preference (${formatTime(sunrise)})`,
      };
    }
    return {
      side,
      targetTime: sunrise.toISOString(),
      reason: `Point ${side} for morning, sun rises ${formatTime(sunrise)}`,
    };
  }

  /**
   * Gets the forecast wind direction (radians, true-north) nearest the given time.
   * @param {Date} time - Target time
   * @returns {number|null} Wind direction in radians, or null if not available
   */
  getForecastWindDirectionAt(time) {
    if (this.lastForecast.length === 0) return null;
    const nearest = this.lastForecast.reduce((best, p) => {
      const dt = Math.abs(
        (p.time instanceof Date ? p.time : new Date(p.time)).getTime() -
          time.getTime(),
      );
      if (!best || dt < best.dt) {
        return { dt, point: p };
      }
      return best;
    }, null);
    const dirDeg = nearest?.point?.windDirectionDeg;
    if (dirDeg == null) return null;
    return (dirDeg * Math.PI) / 180; // degrees → radians
  }

  /**
   * Scans the forecast for when a deployable device's recommendation would flip.
   *
   * For FLINsail and wind generators, the deciding factor is forecast gusts vs
   * the gust/wind limit. For wind generators deployed, we also watch for wind
   * dropping below startup speed. Returns the first forecast time when the
   * state would differ from the current recommendation, or null if it stays
   * the same through the forecast window.
   *
   * Not applicable to hydro generators (depends on boat speed, not forecast)
   * or underway/not-sailing cases (depends on nav state, not forecast).
   *
   * @param {string} id - Device ID
   * @param {string} currentState - Current recommended state ("deployed"/"stowed")
   * @returns {string|null} ISO timestamp when state would change, or null
   */
  getRecommendedStateChangeTime(id, currentState) {
    if (this.lastForecast.length === 0) return null;

    const array = this.solarArrays.find((a) => a.id === id);
    const generator = this.mechanicalGenerators.find((g) => g.id === id);

    // FLINsail (deployable solar): gust limit is the deciding factor.
    // Night-time changes shift to sun boundaries (stow → sunset, deploy → sunrise)
    if (array && array.type === "deployable") {
      const gustLimit = array.gustLimitKnots ?? 20;
      const pos = this.getSelfPath("navigation.position");
      const lat = pos?.latitude;
      const lon = pos?.longitude;
      for (const point of this.lastForecast) {
        const gust = point.gustSpeedKnots ?? 0;
        const wouldStow = gust >= gustLimit;
        const wouldDeploy = !wouldStow;
        let changeTime = null;
        if (currentState === "deployed" && wouldStow) {
          changeTime = point.time;
        } else if (currentState === "stowed" && wouldDeploy) {
          changeTime = point.time;
        }
        if (changeTime) {
          const t =
            changeTime instanceof Date ? changeTime : new Date(changeTime);
          if (lat != null && lon != null) {
            const { altitude } = sunPosition(t, lat, lon);
            if (altitude <= 0) {
              // Change triggers at night: report at the sun boundary instead
              const target =
                currentState === "deployed"
                  ? lastSunset(t, lat, lon) // Stow before dark, not at 2 AM
                  : nextSunrise(t, lat, lon); // Deploy at sunrise, not at night
              if (target) {
                const clamped = new Date(
                  Math.max(target.getTime(), Date.now()),
                );
                return this.toISOString(clamped);
              }
            }
          }
          return this.toISOString(t);
        }
      }
      return null;
    }

    // Wind generators: gust limit (stow) and startup speed (too low to deploy)
    if (generator && generator.type === "wind") {
      const maxWindKnots = generator.maxWindKnots ?? 30;
      const minDeployWind = generator.startupSpeedKnots ?? 5;
      for (const point of this.lastForecast) {
        const gust = point.gustSpeedKnots ?? 0;
        const wind = point.windSpeedKnots ?? 0;
        if (currentState === "deployed") {
          // Would stow if gusts exceed limit
          if (gust >= maxWindKnots) {
            return this.toISOString(point.time);
          }
        } else if (currentState === "stowed") {
          // Would deploy if wind ≥ startup and gusts < limit
          if (wind >= minDeployWind && gust < maxWindKnots) {
            return this.toISOString(point.time);
          }
        }
      }
      return null;
    }

    return null;
  }

  /**
   * Converts a Date or date-like value to ISO string.
   * @param {Date|string|number} time - Time value
   * @returns {string|null} ISO string, or null if invalid
   */
  toISOString(time) {
    const d = time instanceof Date ? time : new Date(time);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  /**
   * Computes per-hour ideal states for deployable solar arrays with
   * sunrise/sunset-aware night handling.
   *
   * Day hours: deployed iff gusts are below the array's gust limit.
   * Night hours: stowed if any hour of the night block has gusts at/above
   * the limit (the sail should be secured before dark); otherwise the state
   * carries over from the previous day - deploying at night gains nothing,
   * so no state flip happens until sunrise.
   *
   * @param {Array<{time: Date, gustSpeedKnots: number|null}>} forecast - Weather forecast
   * @param {number} latitude - Latitude in degrees
   * @param {number} longitude - Longitude in degrees
   * @param {Date} startTime - First hour bucket time
   * @param {number} hours - Number of hourly buckets
   * @param {boolean} underway - Whether vessel is under way
   * @returns {Array<Map<string, {state: string, reason: string}>>} Per-hour states per array ID
   */
  computeDeployableSolarStates(
    forecast,
    latitude,
    longitude,
    startTime,
    hours,
    underway,
  ) {
    const deployable = this.solarArrays.filter((a) => a.type === "deployable");
    if (deployable.length === 0) return [];

    // Per-hour sun altitude and matched forecast gust
    const hourInfo = [];
    for (let h = 0; h < hours; h++) {
      const time = new Date(startTime.getTime() + h * 3600000);
      const { altitude } = sunPosition(time, latitude, longitude);
      const fp = forecast.find(
        (p) =>
          Math.abs(
            (p.time instanceof Date
              ? p.time.getTime()
              : new Date(p.time).getTime()) - time.getTime(),
          ) < 1800000,
      );
      hourInfo.push({
        time,
        isNight: altitude <= 0,
        gust: fp?.gustSpeedKnots ?? 0,
      });
    }

    // Annotate each night hour with its night block's max gust
    const nightBlockMax = new Array(hours).fill(null);
    let blockStart = -1;
    let blockMax = 0;
    const flushBlock = (end) => {
      if (blockStart >= 0) {
        for (let i = blockStart; i < end; i++) nightBlockMax[i] = blockMax;
      }
      blockStart = -1;
      blockMax = 0;
    };
    for (let h = 0; h < hours; h++) {
      if (hourInfo[h].isNight) {
        if (blockStart < 0) {
          blockStart = h;
          blockMax = 0;
        }
        blockMax = Math.max(blockMax, hourInfo[h].gust);
      } else {
        flushBlock(h);
      }
    }
    flushBlock(hours);

    // Per-hour states, carrying the previous state through gust-free nights
    const result = [];
    const prevState = new Map();
    for (let h = 0; h < hours; h++) {
      const info = hourInfo[h];
      const states = new Map();
      for (const array of deployable) {
        const gustLimit = array.gustLimitKnots ?? 20;
        let state;
        let reason;
        if (underway) {
          state = "stowed";
          reason = "vessel under way";
        } else if (info.isNight) {
          const nightMax = nightBlockMax[h] ?? 0;
          if (nightMax >= gustLimit) {
            state = "stowed";
            reason = `night gusts up to ${Math.round(nightMax)}kn ≥ limit ${gustLimit}kn`;
          } else {
            // No night gust risk: keep the previous state until sunrise
            state = prevState.get(array.id) ?? "deployed";
            reason = "no night gusts";
          }
        } else if (info.gust >= gustLimit) {
          state = "stowed";
          reason = `gusts ${Math.round(info.gust)}kn ≥ limit ${gustLimit}kn`;
        } else {
          state = "deployed";
          reason = `gusts ${Math.round(info.gust)}kn < limit ${gustLimit}kn`;
        }
        states.set(array.id, { state, reason });
        prevState.set(array.id, state);
      }
      result.push(states);
    }
    return result;
  }

  /**
   * Computes per-device deploy/stow actions for a given hour's conditions.
   *
   * Each action is:
   * - `ideal`: what the device should be ("deploy"/"stow"/"stay") based on
   *   this hour's forecast conditions.
   * - `detected`: what action is needed to close the gap between the detected
   *   state and the ideal state ("deploy"/"stow"/"stay"/null if unknown).
   *
   * @param {number} gustKnots - Gust speed in knots for this hour
   * @param {number} windKnots - Wind speed in knots for this hour
   * @param {boolean} underway - Whether vessel is under way this hour
   * @param {boolean} isSailing - Whether vessel is sailing this hour
   * @param {number|null} speedThroughWaterKnots - Boat speed in knots
   * @param {Map<string, string|null>} [detectedDeployStates] - Detected states
   * @param {Map<string, {state: string, reason: string}>} [solarStates] - Precomputed
   *        deployable solar states for this hour (from computeDeployableSolarStates)
   * @returns {Array<{id: string, type: string, idealState: string, idealAction: string, detectedAction: string|null, reason: string}>}
   */
  getHourlyActions(
    gustKnots,
    windKnots,
    underway,
    isSailing,
    speedThroughWaterKnots,
    detectedDeployStates,
    solarStates,
  ) {
    const actions = [];

    // Deployable solar arrays (FLINsail) - states precomputed with
    // sunrise/sunset-aware night handling
    for (const array of this.solarArrays) {
      if (array.type !== "deployable") continue;
      const s = solarStates?.get(array.id) ?? {
        state: "deployed",
        reason: "",
      };
      const idealState = s.state;
      const reason = s.reason;
      const idealAction = idealState === "deployed" ? "deploy" : "stow";
      const detectedState = detectedDeployStates?.get(array.id) ?? null;
      const detectedAction =
        detectedState == null
          ? null
          : detectedState === idealState
            ? "stay"
            : idealState === "deployed"
              ? "deploy"
              : "stow";
      actions.push({
        id: array.id,
        type: "solar-deployable",
        idealState,
        idealAction,
        detectedAction,
        reason,
      });
    }

    // Mechanical generators
    for (const generator of this.mechanicalGenerators) {
      if (!generator.deployable) continue;
      let idealState;
      let reason;
      if (generator.type === "wind") {
        const maxWindKnots = generator.maxWindKnots ?? 30;
        const minDeployWind = generator.startupSpeedKnots ?? 5;
        if (underway) {
          idealState = "stowed";
          reason = "vessel under way";
        } else if (gustKnots >= maxWindKnots) {
          idealState = "stowed";
          reason = `gusts ${Math.round(gustKnots)}kn ≥ limit ${maxWindKnots}kn`;
        } else if (windKnots >= minDeployWind) {
          idealState = "deployed";
          reason = `wind ${Math.round(windKnots)}kn ≥ startup ${minDeployWind}kn`;
        } else {
          idealState = "stowed";
          reason = `wind ${Math.round(windKnots)}kn < startup ${minDeployWind}kn`;
        }
      } else if (generator.type === "hydro") {
        const minSpeed = generator.minSpeedKnots ?? 3;
        const maxSpeed = generator.maxSpeedKnots ?? 12;
        const speed = speedThroughWaterKnots ?? 0;
        if (!isSailing) {
          idealState = "stowed";
          reason = "not sailing";
        } else if (speed >= maxSpeed) {
          idealState = "stowed";
          reason = `boat speed ${speed.toFixed(1)}kn ≥ max ${maxSpeed}kn`;
        } else if (speed >= minSpeed) {
          idealState = "deployed";
          reason = `sailing ${speed.toFixed(1)}kn (min ${minSpeed}kn)`;
        } else {
          idealState = "stowed";
          reason = `sailing too slow (${speed.toFixed(1)}kn < ${minSpeed}kn)`;
        }
      } else {
        continue;
      }
      const idealAction = idealState === "deployed" ? "deploy" : "stow";
      const detectedState = detectedDeployStates?.get(generator.id) ?? null;
      const detectedAction =
        detectedState == null
          ? null
          : detectedState === idealState
            ? "stay"
            : idealState === "deployed"
              ? "deploy"
              : "stow";
      actions.push({
        id: generator.id,
        type: generator.type,
        idealState,
        idealAction,
        detectedAction,
        reason,
      });
    }

    return actions;
  }

  /**
   * Computes deployment recommendations for all deployable systems (FLINsail + generators).
   * Each recommendation says whether the device should be deployed or stowed, and why.
   *
   * @returns {Array<{id: string, name: string, type: string, recommendedState: string, reason: string, currentGustKnots?: number, currentSpeedKnots?: number, limitKnots?: number}>}
   */
  getDeploymentRecommendations() {
    const recommendations = [];
    const navState = this.getNavState();
    const underway = this.isUnderway();
    const isSailing = navState === "sailing";
    const speedThroughWater = this.getSpeedThroughWater() ?? 0;
    const maxGust = this.getMaxForecastGust();
    const maxWind = this.getMaxForecastWind();

    // FLINsail (deployable solar arrays)
    for (const array of this.solarArrays) {
      if (array.type !== "deployable") continue;

      const name = this.getDisplayName(array);
      const gustLimit = array.gustLimitKnots ?? 20;

      if (underway) {
        // FLINsail is always stowed when underway
        recommendations.push({
          id: array.id,
          name,
          type: "solar-deployable",
          recommendedState: "stowed",
          reason: "Stow - vessel under way",
          recommendedSide: null,
          recommendedSideTime: null,
        });
      } else if (maxGust >= gustLimit) {
        recommendations.push({
          id: array.id,
          name,
          type: "solar-deployable",
          recommendedState: "stowed",
          reason: `Stow - gusts ${Math.round(maxGust)}kn exceed limit of ${gustLimit}kn`,
          currentGustKnots: maxGust,
          limitKnots: gustLimit,
          recommendedSide: null,
          recommendedSideTime: null,
        });
      } else {
        // Deployed - compute pointing recommendation (port/starboard)
        const pointing = this.getPointingRecommendation(array);
        let reason =
          maxGust > 0
            ? `Deploy - gusts ${Math.round(maxGust)}kn below limit of ${gustLimit}kn`
            : "Deploy - no significant gusts forecast";
        if (pointing) {
          if (pointing.side) {
            reason += `. ${pointing.reason}`;
          } else if (pointing.reason) {
            reason += `. ${pointing.reason}`;
          }
        }
        recommendations.push({
          id: array.id,
          name,
          type: "solar-deployable",
          recommendedState: "deployed",
          reason,
          currentGustKnots: maxGust,
          limitKnots: gustLimit,
          recommendedSide: pointing?.side ?? null,
          recommendedSideTime: pointing?.targetTime ?? null,
        });
      }
    }

    // Mechanical generators
    for (const generator of this.mechanicalGenerators) {
      if (!generator.deployable) continue;

      const name = this.getDisplayName(generator);

      if (generator.type === "hydro") {
        const minSpeed = generator.minSpeedKnots ?? 3;
        const maxSpeed = generator.maxSpeedKnots ?? 12;

        if (!isSailing) {
          // Hydro can only be deployed when sailing (not motoring)
          recommendations.push({
            id: generator.id,
            name,
            type: "hydro",
            recommendedState: "stowed",
            reason: underway
              ? `Stow - vessel ${navState}, hydro requires sailing`
              : "Stow - vessel not sailing",
          });
        } else if (speedThroughWater >= maxSpeed) {
          recommendations.push({
            id: generator.id,
            name,
            type: "hydro",
            recommendedState: "stowed",
            reason: `Stow - boat speed ${speedThroughWater.toFixed(1)}kn exceeds limit of ${maxSpeed}kn`,
            currentSpeedKnots: speedThroughWater,
            limitKnots: maxSpeed,
          });
        } else if (speedThroughWater >= minSpeed) {
          recommendations.push({
            id: generator.id,
            name,
            type: "hydro",
            recommendedState: "deployed",
            reason: `Deploy - sailing at ${speedThroughWater.toFixed(1)}kn (min ${minSpeed}kn, max ${maxSpeed}kn)`,
            currentSpeedKnots: speedThroughWater,
            limitKnots: maxSpeed,
          });
        } else {
          recommendations.push({
            id: generator.id,
            name,
            type: "hydro",
            recommendedState: "stowed",
            reason: `Stow - sailing too slow (${speedThroughWater.toFixed(1)}kn < ${minSpeed}kn)`,
            currentSpeedKnots: speedThroughWater,
            limitKnots: minSpeed,
          });
        }
      } else if (generator.type === "wind") {
        const maxWindKnots = generator.maxWindKnots ?? 30;
        const minDeployWind = generator.startupSpeedKnots ?? 5;

        if (underway) {
          // Wind generators stowed when under way (like FLINsail)
          recommendations.push({
            id: generator.id,
            name,
            type: "wind",
            recommendedState: "stowed",
            reason: "Stow - vessel under way",
          });
        } else if (maxGust >= maxWindKnots) {
          recommendations.push({
            id: generator.id,
            name,
            type: "wind",
            recommendedState: "stowed",
            reason: `Stow - gusts ${Math.round(maxGust)}kn exceed limit of ${maxWindKnots}kn`,
            currentGustKnots: maxGust,
            limitKnots: maxWindKnots,
          });
        } else if (maxWind >= minDeployWind) {
          recommendations.push({
            id: generator.id,
            name,
            type: "wind",
            recommendedState: "deployed",
            reason: `Deploy - wind ${Math.round(maxWind)}kn (gusts ${Math.round(maxGust)}kn, limit ${maxWindKnots}kn)`,
            currentGustKnots: maxGust,
            limitKnots: maxWindKnots,
          });
        } else {
          recommendations.push({
            id: generator.id,
            name,
            type: "wind",
            recommendedState: "stowed",
            reason: `Stow - wind too low (${Math.round(maxWind)}kn < ${minDeployWind}kn)`,
          });
        }
      }
    }

    return recommendations.map((rec) => ({
      ...rec,
      missedYieldWh:
        rec.recommendedState === "deployed"
          ? this.getPotentialYieldWh(rec.id)
          : 0,
      recommendedStateTime: this.getRecommendedStateChangeTime(
        rec.id,
        rec.recommendedState,
      ),
    }));
  }

  /**
   * Gets the current battery SoC.
   *
   * @returns {number} SoC [0, 1]
   */
  getCurrentSoC() {
    let soc = this.getSelfPath(
      this.battery.socPath ||
        "electrical.batteries.house.capacity.stateOfCharge",
    );
    // Handle Signal K object-structured values
    if (soc && typeof soc === "object" && typeof soc.value === "number") {
      soc = soc.value;
    }
    return soc != null && !isNaN(soc) ? soc : 0.5;
  }

  /**
   * Runs the 24-hour prediction.
   *
   * Produces two yield tracks:
   * - **Ideal** (idealSolarYieldWh/idealWindYieldWh/idealNetWh/idealSoC): yield if deployable
   *   devices are deployed/stowed as recommended by conditions.
   * - **Detected** (detectedYieldWh/detectedNetWh/detectedSoC): yield if
   *   deployable devices stay as they are *detected right now*. Devices
   *   detected as stowed contribute 0 yield for all hours.
   *
   * @param {Array<{time: Date, ghi: number|null, cloudCover: number|null, gustSpeedKnots: number|null}>} forecast - Weather forecast
   * @param {Map<string, string|null>} [detectedDeployStates] - Map of deviceId → "deployed"/"stowed"/null
   * @returns {HourlyPrediction[]} Hourly predictions
   */
  runPrediction(forecast, detectedDeployStates) {
    this.updateLoadProfile();

    const currentSoC = this.getCurrentSoC();
    const navState = this.getNavState();
    const awa = this.getAWA();
    const isSailing = navState === "sailing";
    const underway = this.isUnderway();

    const predictions = [];
    let runningSoC = currentSoC;
    let detectedRunningSoC = currentSoC;
    const averageLoad = this.loadProfile.getAverageLoad();

    // Get current position
    const pos = this.getSelfPath("navigation.position");
    const latitude = pos?.latitude ?? 0;
    const longitude = pos?.longitude ?? 0;

    this.app?.debug?.(
      `runPrediction: SoC=${Math.round(currentSoC * 100)}%, load=${Math.round(averageLoad)}W, pos=${latitude.toFixed(2)},${longitude.toFixed(2)}, sailing=${isSailing}, forecast=${forecast.length}pts`,
    );
    if (forecast.length > 0) {
      this.app?.debug?.(
        `  forecast[0]: ${forecast[0].time.toISOString()} ghi=${forecast[0].ghi}`,
      );
      this.app?.debug?.(
        `  forecast[12]: ${forecast[12].time.toISOString()} ghi=${forecast[12].ghi}`,
      );
      this.app?.debug?.(
        `  forecast[24]: ${forecast[24]?.time.toISOString()} ghi=${forecast[24]?.ghi}`,
      );
    }

    const startTime = new Date(Date.now());
    // Track previous hour's ideal states to emit actions only on change
    let prevIdealStates = new Map();
    // Deployable solar states with sunrise/sunset-aware night handling
    const solarStatesPerHour = this.computeDeployableSolarStates(
      forecast,
      latitude,
      longitude,
      startTime,
      PREDICTION_HOURS,
      underway,
    );
    this.app?.debug?.(`  prediction[0]: ${startTime.toISOString()}`);

    for (let h = 0; h < PREDICTION_HOURS; h++) {
      const time = new Date(startTime.getTime() + h * 3600000);

      // Find corresponding forecast point
      const forecastPoint = forecast.find((fp) => {
        const diff = Math.abs(fp.time.getTime() - time.getTime());
        return diff < 1800000; // Within 30 minutes
      });

      const ghi = forecastPoint?.ghi ?? 0;
      const cloudCover = forecastPoint?.cloudCover ?? 0;
      const windGustKnots = forecastPoint?.gustSpeedKnots ?? 0;
      const windSpeedKnots = forecastPoint?.windSpeedKnots ?? 0;

      // Get sun position
      const sunPos = sunPosition(time, latitude, longitude);

      // Calculate solar yield
      let idealSolarYieldWh = 0;
      let detectedSolarYieldWh = 0;
      for (const array of this.solarArrays) {
        // Get efficiency from learning matrix
        const efficiency = this.getEfficiency(
          array.id,
          isSailing,
          sunPos.azimuth,
          sunPos.altitude,
          isSailing ? awa : undefined,
        );

        const arrayYield = predictSolarHour({
          array,
          sunPosition: sunPos,
          ghi,
          windGustKnots,
          efficiency,
        });
        idealSolarYieldWh += arrayYield;

        // Detected track: 0 yield if deployable array detected as stowed
        const detectedState = detectedDeployStates?.get(array.id);
        if (array.type === "deployable" && detectedState === "stowed") {
          detectedSolarYieldWh += 0;
        } else {
          detectedSolarYieldWh += arrayYield;
        }

        if (h === 12 || h === 22) {
          const extra =
            array.type === "deployable"
              ? ` gust=${windGustKnots.toFixed(0)}kn limit=${array.gustLimitKnots ?? "n/a"}kn`
              : "";
          this.app?.debug?.(
            `  h=${h} array=${array.id}: alt=${((sunPos.altitude * 180) / Math.PI).toFixed(1)}° ghi=${ghi.toFixed(0)} eff=${efficiency.toFixed(2)} cap=${array.capacityWp}Wp yield=${arrayYield.toFixed(1)}Wh${extra}`,
          );
        }
      }

      // Calculate wind/hydro yield
      let mechanicalYieldWh = 0;
      let detectedMechanicalYieldWh = 0;
      const speedThroughWater = this.getSpeedThroughWater();

      for (const generator of this.mechanicalGenerators) {
        let genYield = 0;
        if (generator.type === "wind") {
          genYield = predictWindHour({
            generator,
            windSpeedKnots,
            gustSpeedKnots: windGustKnots,
            isSailing,
            navState,
          });
        } else if (generator.type === "hydro") {
          genYield = predictHydroHour({
            generator,
            speedThroughWaterKnots: speedThroughWater ?? 0,
            isSailing,
          });
        }
        mechanicalYieldWh += genYield;

        // Detected track: 0 yield if deployable generator detected as stowed
        const detectedState = detectedDeployStates?.get(generator.id);
        if (generator.deployable && detectedState === "stowed") {
          detectedMechanicalYieldWh += 0;
        } else {
          detectedMechanicalYieldWh += genYield;
        }
      }

      const idealNetWh = idealSolarYieldWh + mechanicalYieldWh - averageLoad;
      const socChange = idealNetWh / this.capacityWh;
      runningSoC = Math.max(0, Math.min(1, runningSoC + socChange));

      const detectedYieldWh = detectedSolarYieldWh + detectedMechanicalYieldWh;
      const detectedNetWh = detectedYieldWh - averageLoad;
      const detectedSocChange = detectedNetWh / this.capacityWh;
      detectedRunningSoC = Math.max(
        0,
        Math.min(1, detectedRunningSoC + detectedSocChange),
      );

      // Compute per-device deploy/stow actions for this hour,
      // emitting only when the ideal state changes. At hour 0, emit only
      // devices that actually need something done (detected state differs
      // from ideal, or is unknown) - a device already in its ideal state
      // ("stay") needs no action entry.
      const allActions = this.getHourlyActions(
        windGustKnots,
        windSpeedKnots,
        underway,
        isSailing,
        speedThroughWater ?? null,
        detectedDeployStates,
        solarStatesPerHour[h],
      );
      const actions = allActions.filter(
        (a) =>
          (h === 0 && a.detectedAction !== "stay") ||
          (h > 0 && prevIdealStates.get(a.id) !== a.idealState),
      );
      for (const a of actions) {
        a.time = time.toISOString();
      }
      prevIdealStates = new Map(allActions.map((a) => [a.id, a.idealState]));

      predictions.push({
        hour: h,
        time,
        idealSolarYieldWh: Math.round(idealSolarYieldWh),
        idealWindYieldWh: Math.round(mechanicalYieldWh),
        houseLoadWh: Math.round(averageLoad),
        idealNetWh: Math.round(idealNetWh),
        idealSoC: Math.round(runningSoC * 1000) / 1000,
        detectedYieldWh: Math.round(detectedYieldWh),
        detectedNetWh: Math.round(detectedNetWh),
        detectedSoC: Math.round(detectedRunningSoC * 1000) / 1000,
        gustSpeedKnots: Math.round((windGustKnots || 0) * 10) / 10,
        windSpeedKnots: Math.round((windSpeedKnots || 0) * 10) / 10,
        actions,
      });
    }

    // FLINsail produces nothing at night: move night actions to sun boundaries
    // (stow during night → at sunset, deploy during night → at sunrise)
    this.shiftSolarActionsToSunBoundaries(predictions, latitude, longitude);

    this.lastPrediction = predictions;
    this.lastForecast = forecast;
    return predictions;
  }

  /**
   * Moves deployable solar actions that occur during night hours to the
   * surrounding sun boundary: a stow triggered at night is reported at the
   * sunset that started the night (stow before dark, no 2 AM surprises), and
   * a deploy triggered at night is reported at the next sunrise (deploying
   * at night gains nothing since the array produces no power).
   *
   * Each shifted action carries the exact boundary time in its `time` field
   * and is placed in the hourly bucket containing that time. Targets before
   * the forecast window clamp to hour 0 ("do it now"); targets beyond the
   * window are dropped.
   *
   * @param {HourlyPrediction[]} predictions - Hourly predictions (mutated)
   * @param {number} latitude - Latitude in degrees
   * @param {number} longitude - Longitude in degrees
   * @returns {void}
   */
  shiftSolarActionsToSunBoundaries(predictions, latitude, longitude) {
    if (predictions.length === 0) return;
    const startTime = predictions[0].time.getTime();

    for (const p of predictions) {
      const { altitude } = sunPosition(p.time, latitude, longitude);
      if (altitude > 0) continue; // Day hour: keep as-is

      const solarActions = p.actions.filter(
        (a) => a.type === "solar-deployable",
      );
      if (solarActions.length === 0) continue;
      p.actions = p.actions.filter((a) => a.type !== "solar-deployable");

      for (const action of solarActions) {
        const target =
          action.idealAction === "stow"
            ? lastSunset(p.time, latitude, longitude)
            : nextSunrise(p.time, latitude, longitude);
        if (!target) continue; // Polar edge case: leave in place
        insertActionIntoBucket(predictions, startTime, target, action);
      }
    }
  }

  /**
   * Calculates time to full (SoC = 1.0).
   * Extrapolates beyond 24h if the trend is consistently upward.
   *
   * @returns {Date|null} Timestamp when battery will be full, or null if not trending toward full
   */
  getTimeToFull() {
    if (this.lastPrediction.length === 0) return null;

    const full = this.lastPrediction.find((p) => p.idealSoC >= 1.0);
    if (full) return full.time;

    // Extrapolate: if average net is positive, estimate when SoC reaches 1.0
    const currentSoC = this.getCurrentSoC();
    if (currentSoC >= 1.0) return new Date(); // Already full

    const avgNetWh =
      this.lastPrediction.reduce((sum, p) => sum + p.idealNetWh, 0) /
      this.lastPrediction.length;
    if (avgNetWh <= 0) return null; // Not charging

    const deficitWh = (1.0 - currentSoC) * this.capacityWh;
    const hoursToFull = deficitWh / avgNetWh;
    if (hoursToFull > 72) return null; // Too far to be useful

    return new Date(Date.now() + hoursToFull * 3600000);
  }

  /**
   * Calculates time to empty (SoC reaches minSafeSoC).
   * Extrapolates beyond 24h if the trend is consistently downward.
   *
   * @returns {Date|null} Timestamp when battery will be depleted, or null if not trending toward empty
   */
  getTimeToEmpty() {
    if (this.lastPrediction.length === 0) return null;

    const depleted = this.lastPrediction.find(
      (p) => p.idealSoC <= this.battery.minSafeSoC,
    );
    if (depleted) return depleted.time;

    // Extrapolate: if average net is negative, estimate when SoC reaches minSafeSoC
    const currentSoC = this.getCurrentSoC();
    if (currentSoC <= this.battery.minSafeSoC) return new Date(); // Already depleted

    const avgNetWh =
      this.lastPrediction.reduce((sum, p) => sum + p.idealNetWh, 0) /
      this.lastPrediction.length;
    if (avgNetWh >= 0) return null; // Not discharging

    const surplusWh = (currentSoC - this.battery.minSafeSoC) * this.capacityWh;
    const hoursToEmpty = surplusWh / Math.abs(avgNetWh);
    if (hoursToEmpty > 72) return null; // Too far to be useful

    return new Date(Date.now() + hoursToEmpty * 3600000);
  }

  /**
   * Calculates energy deficit from current SoC to full.
   *
   * @returns {number} Deficit in watt-hours
   */
  getDeficit() {
    const currentSoC = this.getCurrentSoC();
    return (1 - currentSoC) * this.capacityWh;
  }

  /**
   * Finds stowage opportunity when mechanical generators are active
   * and remaining solar forecast is sufficient.
   *
   * @returns {{hour: number, reason: string}|null} Stowage recommendation or null
   */
  findStowageOpportunity() {
    let cumulativeNet = 0;
    const deficit = this.getDeficit();
    let mechanicalActive = false;

    for (let i = 0; i < this.lastPrediction.length; i++) {
      const p = this.lastPrediction[i];

      if (p.idealWindYieldWh > 0) {
        mechanicalActive = true;
      }

      cumulativeNet += p.idealNetWh;

      // Check if deficit covered and mechanicals are still active
      if (mechanicalActive && cumulativeNet >= deficit) {
        // Check if remaining solar is sufficient
        const remainingSolar = this.lastPrediction
          .slice(i)
          .reduce((sum, rp) => sum + rp.idealSolarYieldWh, 0);

        if (remainingSolar >= deficit * 0.8) {
          return {
            hour: i,
            reason: `Deficit covered by hour ${i}, ${Math.round(remainingSolar)}Wh solar remaining`,
          };
        }
      }
    }

    return null;
  }

  /**
   * Calculates engine run time needed to avoid SoC dropping below minimum.
   *
   * @param {number} engineWatts - Expected alternator output in watts
   * @returns {{hours: number, optimalWindow: {start: Date, end: Date}}|null} Run time recommendation or null
   */
  calculateEngineRunTime(engineWatts) {
    const timeToEmpty = this.getTimeToEmpty();

    if (!timeToEmpty) {
      return null; // Battery won't reach minimum
    }

    const deficit = this.getDeficit();
    const hoursNeeded = deficit / engineWatts;

    // Find optimal window (lowest solar yield period)
    let minSolarIndex = 0;
    let minSolarYield = Infinity;

    for (
      let i = 0;
      i < Math.min(this.lastPrediction.length, Math.ceil(hoursNeeded) + 1);
      i++
    ) {
      const p = this.lastPrediction[i];
      if (p.idealSolarYieldWh < minSolarYield) {
        minSolarYield = p.idealSolarYieldWh;
        minSolarIndex = i;
      }
    }

    const now = new Date();
    const windowStart = new Date(now.getTime() + minSolarIndex * 3600000);
    const windowEnd = new Date(windowStart.getTime() + hoursNeeded * 3600000);

    return {
      hours: hoursNeeded,
      optimalWindow: {
        start: windowStart,
        end: windowEnd,
      },
    };
  }

  /**
   * Gets hourly forecast data for Signal K delta.
   *
   * @returns {Array<{time: string, idealSolarYieldWh: number, idealWindYieldWh: number, houseLoadWh: number, idealNetWh: number, idealSoC: number, detectedYieldWh: number, detectedNetWh: number, detectedSoC: number, actions: Array}>}
   */
  getHourlyForecast() {
    return this.lastPrediction.map((p) => ({
      time: p.time.toISOString(),
      idealSolarYieldWh: Math.round(p.idealSolarYieldWh),
      idealWindYieldWh: Math.round(p.idealWindYieldWh),
      houseLoadWh: Math.round(p.houseLoadWh),
      idealNetWh: Math.round(p.idealNetWh),
      idealSoC: Math.round(p.idealSoC * 1000) / 1000,
      detectedYieldWh: Math.round(p.detectedYieldWh),
      detectedNetWh: Math.round(p.detectedNetWh),
      detectedSoC: Math.round(p.detectedSoC * 1000) / 1000,
      actions: p.actions,
    }));
  }
}

module.exports = {
  PredictionEngine,
  LoadProfile,
  interpolateWindPower,
  predictSolarHour,
  predictWindHour,
  predictHydroHour,
  PREDICTION_HOURS,
  toNumber,
  toKnots,
  MS_TO_KN,
};
