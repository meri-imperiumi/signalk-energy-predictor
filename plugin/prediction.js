/**
 * 24-hour prediction engine for energy balance forecasting.
 *
 * Combines weather forecasts, learning matrix efficiencies, and load profiles
 * to predict future SoC and generate advisories.
 *
 * @file prediction.js
 */

const { sunPosition, maxIrradiance, irradianceFromCloudCover } = require("./solar.js");

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
 * @typedef {{hour: number, time: Date, solarYieldWh: number, windYieldWh: number, houseLoadWh: number, netWh: number, soc: number}} HourlyPrediction
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
      const t = (speedKnots - curve[i - 1].speed) / (curve[i].speed - curve[i - 1].speed);
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
function predictSolarHour({ array, sunPosition, ghi, windGustKnots, efficiency }) {
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
 * @param {boolean} params.isSailing - Whether vessel is sailing (affects deployable yield)
 * @returns {number} Predicted yield in watt-hours for the hour
 */
function predictWindHour({ generator, windSpeedKnots, isSailing = false, navState = "unknown" }) {
  if (generator.type !== "wind") {
    return 0;
  }

  const maxWind = generator.maxWindKnots ?? 30;

  // Apply wind speed limit
  if (windSpeedKnots > maxWind) {
    return 0; // Exceeds limit, would be stowed
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
function predictHydroHour({ generator, speedThroughWaterKnots, isSailing = false }) {
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
  constructor({ battery, solarArrays, mechanicalGenerators, getEfficiency, getSelfPath, getDisplayName }) {
    this.battery = battery;
    this.solarArrays = solarArrays;
    this.mechanicalGenerators = mechanicalGenerators;
    this.getEfficiency = getEfficiency;
    this.getSelfPath = getSelfPath;
    this.getDisplayName = getDisplayName || ((config) => config.name || config.id);

    this.capacityWh = battery.capacityAh * battery.systemVoltage;
    this.loadProfile = new LoadProfile();
    this.lastPrediction = [];
  }

  /**
   * Updates the load profile with current house load.
   *
   * @returns {void}
   */
  updateLoadProfile() {
    // Read instantaneous house load (convert watts to Wh for hourly rate)
    const houseLoadW = this.getSelfPath("electrical.batteries.house.load");

    if (houseLoadW != null && typeof houseLoadW === "number") {
      this.loadProfile.addSample(houseLoadW);
    }
  }

  /**
   * Gets the current navigation state.
   *
   * @returns {string} Navigation state
   */
  getNavState() {
    const state = this.getSelfPath("navigation.state");
    return state || "unknown";
  }

  /**
   * Gets the current apparent wind angle.
   *
   * @returns {number|null} AWA in radians
   */
  getAWA() {
    const awa = this.getSelfPath("environment.wind.angleApparent");
    return awa != null ? awa : null;
  }

  /**
   * Gets the current speed through water.
   *
   * @returns {number|null} Speed in knots
   */
  getSpeedThroughWater() {
    const stw = this.getSelfPath("navigation.speedThroughWater");
    return stw != null ? stw : null;
  }

  /**
   * Gets the current battery SoC.
   *
   * @returns {number} SoC [0, 1]
   */
  getCurrentSoC() {
    const soc = this.getSelfPath(this.battery.socPath || "electrical.batteries.house.capacity.stateOfCharge");
    return soc != null ? soc : 0.5;
  }

  /**
   * Runs the 24-hour prediction.
   *
   * @param {Array<{time: Date, ghi: number|null, cloudCover: number|null, gustSpeedKnots: number|null}>} forecast - Weather forecast
   * @returns {HourlyPrediction[]} Hourly predictions
   */
  runPrediction(forecast) {
    this.updateLoadProfile();

    const currentSoC = this.getCurrentSoC();
    const navState = this.getNavState();
    const awa = this.getAWA();
    const isSailing = navState === "sailing";

    const predictions = [];
    let runningSoC = currentSoC;
    const averageLoad = this.loadProfile.getAverageLoad();

    // Get current position
    const pos = this.getSelfPath("navigation.position");
    const latitude = pos?.latitude ?? 0;
    const longitude = pos?.longitude ?? 0;

    const startTime = new Date();

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
      const windSpeedKnots = forecastPoint?.cloudCover ?? 0; // Will need separate wind data

      // Get sun position
      const sunPos = sunPosition(time, latitude, longitude);

      // Calculate solar yield
      let solarYieldWh = 0;
      for (const array of this.solarArrays) {
        // Get efficiency from learning matrix
        const efficiency = this.getEfficiency(
          array.id,
          isSailing,
          sunPos.azimuth,
          sunPos.altitude,
          isSailing ? awa : undefined,
        );

        solarYieldWh += predictSolarHour({
          array,
          sunPosition: sunPos,
          ghi,
          windGustKnots,
          efficiency,
        });
      }

      // Calculate wind/hydro yield
      let mechanicalYieldWh = 0;
      const speedThroughWater = this.getSpeedThroughWater();

      for (const generator of this.mechanicalGenerators) {
        if (generator.type === "wind") {
          mechanicalYieldWh += predictWindHour({
            generator,
            windSpeedKnots,
            isSailing,
          });
        } else if (generator.type === "hydro") {
          mechanicalYieldWh += predictHydroHour({
            generator,
            speedThroughWaterKnots: speedThroughWater ?? 0,
            isSailing,
          });
        }
      }

      const netWh = solarYieldWh + mechanicalYieldWh - averageLoad;
      const socChange = netWh / this.capacityWh;
      runningSoC = Math.max(0, Math.min(1, runningSoC + socChange));

      predictions.push({
        hour: h,
        time,
        solarYieldWh,
        windYieldWh: mechanicalYieldWh,
        houseLoadWh: averageLoad,
        netWh,
        soc: runningSoC,
      });
    }

    this.lastPrediction = predictions;
    return predictions;
  }

  /**
   * Calculates time to full (SoC = 1.0).
   *
   * @returns {Date|null} Timestamp when battery will be full, or null if never
   */
  getTimeToFull() {
    const full = this.lastPrediction.find((p) => p.soc >= 1.0);
    return full ? full.time : null;
  }

  /**
   * Calculates time to empty (SoC reaches minSafeSoC).
   *
   * @returns {Date|null} Timestamp when battery will be depleted, or null if never
   */
  getTimeToEmpty() {
    const depleted = this.lastPrediction.find((p) => p.soc <= this.battery.minSafeSoC);
    return depleted ? depleted.time : null;
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

      if (p.windYieldWh > 0) {
        mechanicalActive = true;
      }

      cumulativeNet += p.netWh;

      // Check if deficit covered and mechanicals are still active
      if (mechanicalActive && cumulativeNet >= deficit) {
        // Check if remaining solar is sufficient
        const remainingSolar = this.lastPrediction
          .slice(i)
          .reduce((sum, rp) => sum + rp.solarYieldWh, 0);

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

    for (let i = 0; i < Math.min(this.lastPrediction.length, Math.ceil(hoursNeeded) + 1); i++) {
      const p = this.lastPrediction[i];
      if (p.solarYieldWh < minSolarYield) {
        minSolarYield = p.solarYieldWh;
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
   * Finds deployment opportunities for deployable generators.
   *
   * @returns {Array<{generatorId: string, generatorName: string, type: string, hour: number, reason: string}>} Deployment recommendations
   */
  findDeploymentOpportunities() {
    const opportunities = [];
    const isSailing = this.getNavState() === "sailing";
    const currentSpeed = this.getSpeedThroughWater() ?? 0;

    for (const generator of this.mechanicalGenerators) {
      if (!generator.deployable) {
        continue;
      }

      const name = this.getDisplayName(generator);

      if (generator.type === "hydro") {
        const minSpeedKnots = generator.minSpeedKnots ?? 3;
        const maxSpeedKnots = generator.maxSpeedKnots ?? 12;

        if (isSailing && currentSpeed >= minSpeedKnots) {
          // Check if approaching max speed limit
          if (currentSpeed >= maxSpeedKnots) {
            opportunities.push({
              generatorId: generator.id,
              generatorName: name,
              type: "hydro",
              hour: 0,
              reason: `Stow hydro - boat speed ${currentSpeed.toFixed(1)}kts exceeds limit of ${maxSpeedKnots}kts`,
              action: "stow",
              currentSpeed,
              maxSpeedKnots,
            });
          } else {
            // Check if hydro would be beneficial
            const firstBenefitHour = this.lastPrediction.findIndex((p) => p.windYieldWh > 50); // Hydro contributes to windYieldWh
            if (firstBenefitHour >= 0) {
              opportunities.push({
                generatorId: generator.id,
                generatorName: name,
                type: "hydro",
                hour: firstBenefitHour,
                reason: `Deploy hydro - sailing at ${currentSpeed.toFixed(1)}kts (min ${minSpeedKnots}kts, max ${maxSpeedKnots}kts)`,
                currentSpeed,
                minSpeedKnots,
                maxSpeedKnots,
              });
            }
          }
        } else if (!isSailing && currentSpeed < minSpeedKnots) {
          // Energy deficit when not sailing, hydro can't help
          opportunities.push({
            generatorId: generator.id,
            generatorName: name,
            type: "hydro",
            hour: 0,
            reason: "Hydro not applicable - vessel not sailing fast enough",
            action: "info",
            currentSpeed,
            minSpeedKnots,
          });
        }
      } else if (generator.type === "wind") {
        // Wind generators are used at anchor/moored, stowed when under way
        // Deploy when wind is favorable (above minimum but below max)
        const currentWindSpeed = this.getSelfPath("environment.wind.speedOverGround") ?? 0;
        const currentGust = this.getSelfPath("environment.wind.gust") ?? currentWindSpeed;
        const maxWindKnots = generator.maxWindKnots ?? 30;
        const minDeployWind = 5; // Minimum wind to make deployment worthwhile

        // Find forecast wind speeds
        let maxForecastWind = 0;
        let maxForecastGust = 0;
        for (const p of this.lastPrediction) {
          // Use current wind as proxy for forecast (wind forecast integration needed)
          maxForecastWind = Math.max(maxForecastWind, currentWindSpeed);
          maxForecastGust = Math.max(maxForecastGust, currentGust);
        }

        if (maxForecastGust >= maxWindKnots) {
          // Exceeds limit, stow immediately
          opportunities.push({
            generatorId: generator.id,
            generatorName: name,
            type: "wind",
            hour: 0,
            reason: `Gusts ${maxForecastGust.toFixed(1)}kts exceed limit of ${maxWindKnots}kts`,
            action: "stow",
            currentSpeed: maxForecastGust,
            maxWindKnots,
          });
        } else if (maxForecastWind >= minDeployWind && maxForecastWind < maxWindKnots * 0.7) {
          // Favorable wind conditions, recommend deployment
          const hour = this.lastPrediction.findIndex((p) => p.windYieldWh > 50);
          if (hour >= 0) {
            opportunities.push({
              generatorId: generator.id,
              generatorName: name,
              type: "wind",
              hour,
              reason: `Wind ${maxForecastWind.toFixed(1)}kts (within safe range ${minDeployWind}-${maxWindKnots}kts)`,
              currentSpeed: maxForecastWind,
              maxWindKnots,
            });
          }
        } else if (maxForecastWind >= maxWindKnots * 0.7) {
          // Approaching limit, warn to stow soon
          opportunities.push({
            generatorId: generator.id,
            generatorName: name,
            type: "wind",
            hour: 0,
            reason: `Wind approaching limit (${maxForecastWind.toFixed(1)}kts, limit ${maxWindKnots}kts), consider stowing`,
            action: "stow",
            currentSpeed: maxForecastWind,
            maxWindKnots,
          });
        }
      }
    }

    return opportunities;
  }

  /**
   * Gets hourly forecast data for Signal K delta.
   *
   * @returns {Array<{time: string, solarYieldWh: number, windYieldWh: number, houseLoadWh: number, netWh: number, soc: number}>}
   */
  getHourlyForecast() {
    return this.lastPrediction.map((p) => ({
      time: p.time.toISOString(),
      solarYieldWh: Math.round(p.solarYieldWh),
      windYieldWh: Math.round(p.windYieldWh),
      houseLoadWh: Math.round(p.houseLoadWh),
      netWh: Math.round(p.netWh),
      soc: Math.round(p.soc * 1000) / 1000,
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
};