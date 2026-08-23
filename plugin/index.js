/**
 * Signal K Predictive Energy Management Plugin.
 *
 * Offline-first incremental learning for solar/wind yield efficiency prediction.
 * Provides 24-hour energy balance forecasts and actionable advisories.
 *
 * @file index.js
 */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */
/** @typedef {import("@signalk/server-api").Plugin} Plugin */

const { IngestionFSM, Tier } = require("./ingestion.js");
const { SolarMatrix } = require("./learning.js");
const matrixModule = require("./matrix.js");
const { PredictionEngine, toNumber, toKnots } = require("./prediction.js");
const { AdvisoryPublisher } = require("./advisory.js");
const {
  buildPluginSchema,
  parseManufacturerCurve,
  getActiveCapacity,
  getDisplayName,
  validateConfig,
} = require("./schema.js");
const { sunPosition } = require("./solar.js");
const { formatWh } = require("./format.js");
const { Recorder } = require("./recorder.js");
const { registerApiRoutes } = require("./api.js");
const openApiSpec = require("../schema/openapi.json");

/**
 * Matches propulsion instance paths, e.g. `propulsion.main.state`.
 * Instance names follow the signalk-autostate convention (letters/digits).
 */
const PROPULSION_STATE_RE = /^propulsion\.([A-Za-z0-9]+)\.state$/;
const PROPULSION_REVOLUTIONS_RE = /^propulsion\.([A-Za-z0-9]+)\.revolutions$/;

/**
 * Detects whether any engine is running from per-instance propulsion
 * values, mirroring signalk-autostate's detection: an engine counts as
 * running when its `state` is `started`, or when `revolutions` > 0 (not
 * all engines instrument state). Multi-engine vessels (catamarans, larger
 * power boats) are handled by scanning all instances.
 *
 * @param {Map<string, unknown>} pathValues - Path → value map (delta state)
 * @returns {boolean|null} true if any engine runs, false if all stopped, null if unknown
 */
function detectEngineRunning(pathValues) {
  let anyRunning = false;
  let anySignal = false;

  for (const [path, value] of pathValues) {
    if (value == null) {
      continue;
    }
    const stateMatch = PROPULSION_STATE_RE.exec(path);
    if (stateMatch) {
      anySignal = true;
      if (value === "started") {
        anyRunning = true;
      }
      continue;
    }
    const revMatch = PROPULSION_REVOLUTIONS_RE.exec(path);
    if (revMatch) {
      const rpm = toNumber(value);
      if (rpm != null) {
        anySignal = true;
        if (rpm > 0) {
          anyRunning = true;
        }
      }
    }
  }

  return anySignal ? anyRunning : null;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG = {
  updateIntervalMinutes: 15,
  battery: {
    capacityAh: 400,
    systemVoltage: 12,
    minSafeSoC: 0.2,
    socPath: "electrical.batteries.house.capacity.stateOfCharge",
    engineAlternatorWatts: 100,
  },
  solarArrays: [],
  mechanicalGenerators: [],
  learning: {
    enabled: true,
    saveIntervalMinutes: 15,
    emaAlpha: 0.05,
    defaultEfficiency: 0.7,
  },
  weather: {
    preferredProvider: "",
    openMeteoEnabled: true,
    useLogbook: true,
    forecastHours: 48,
  },
};

/**
 * Paths to subscribe to from Signal K.
 */
const SUBSCRIPTION_PATHS = [
  "navigation.state",
  "navigation.position",
  "navigation.headingTrue",
  "navigation.speedThroughWater",
  "navigation.courseOverGroundTrue",
  "environment.wind.angleApparent",
  "environment.wind.speedApparent",
  "environment.wind.speedOverGround",
  "electrical.batteries.house.capacity.stateOfCharge",
  "electrical.venus.dcPower",
  "electrical.venus.acPower",
  "propulsion.*.state",
  "propulsion.*.revolutions",
];

/**
 * Overridable dependencies for testing.
 */
const deps = {
  SolarMatrix,
  IngestionFSM,
  PredictionEngine,
  AdvisoryPublisher,
  Recorder,
  registerApiRoutes,
  loadMatrices: matrixModule.loadAllMatrices,
  saveMatrices: matrixModule.saveMatrices,
  loadLoadProfile: matrixModule.loadLoadProfile,
  saveLoadProfile: matrixModule.saveLoadProfile,
  validateConfig,
};

/**
 * Main plugin function.
 *
 * @param {ServerAPI} app - Signal K server API
 * @returns {Plugin} Plugin instance
 */
module.exports = (app) => {
  /** @type {Map<string, SolarMatrix>} */
  const solarMatrices = new Map();

  /** @type {IngestionFSM|null} */
  let ingestionFSM = null;

  /** @type {PredictionEngine|null} */
  let predictionEngine = null;

  /** @type {AdvisoryPublisher|null} */
  let advisoryPublisher = null;

  /** @type {Recorder|null} */
  let recorder = null;

  /** @type {number|null} */
  let updateIntervalId = null;

  /** @type {number|null} */
  let saveIntervalId = null;

  /** @type {number|null} */
  let sampleIntervalId = null;

  /** @type {Function[]} */
  const unsubscribes = [];

  /** @type {object|null} */
  let pluginConfig = null;

  /** @type {boolean} */
  let hasPosition = false;

  /** @type {boolean} */
  let hasRunPredictionWithPosition = false;

  /** @type {Function} */
  const setStatus = (app.setPluginStatus || app.setProviderStatus)?.bind(app);

  /** @type {{lastPrediction: object, lastForecastTime: Date|null, sourceInfo: object}|null} */
  const statusCache = null;

  /**
   * Normalizes a deploy state value to "deployed" or "stowed" or null.
   * Handles various Signal K value formats (string, object with .value).
   * @param {unknown} val
   * @returns {string|null}
   */
  function normalizeDeployState(val) {
    if (val == null) return null;
    if (typeof val === "object" && typeof val.value === "string")
      val = val.value;
    if (typeof val === "string") {
      const lower = val.toLowerCase();
      if (lower === "deployed" || lower === "deploy") return "deployed";
      if (lower === "stowed" || lower === "stow" || lower === "retracted")
        return "stowed";
    }
    return null;
  }

  /**
   * Gets active solar arrays from configuration.
   *
   * @param {object} config - Plugin configuration
   * @returns {Array<object>}
   */
  function getActiveSolarArrays(config) {
    const arrays = config?.solarArrays || [];
    return arrays.filter((a) => a.enabled !== false);
  }

  /**
   * Gets active mechanical generators from configuration.
   *
   * @param {object} config - Plugin configuration
   * @returns {Array<object>}
   */
  function getActiveGenerators(config) {
    const generators = config?.mechanicalGenerators || [];
    return generators
      .filter((g) => g.enabled !== false)
      .map((g) => ({
        ...g,
        curve: parseManufacturerCurve(g.manufacturerCurve),
      }));
  }

  /**
   * Gets efficiency from the appropriate learning matrix.
   *
   * @param {string} arrayId - Array identifier
   * @param {boolean} isSailing - Whether vessel is sailing
   * @param {number} azimuth - Sun azimuth in radians
   * @param {number} elevation - Sun elevation in radians
   * @param {number|null} awa - Apparent wind angle in radians (sailing only)
   * @returns {number} Efficiency [0, 1]
   */
  function getEfficiency(arrayId, isSailing, azimuth, elevation, awa) {
    const matrix = solarMatrices.get(arrayId);

    if (!matrix) {
      const learning = pluginConfig?.learning || DEFAULT_CONFIG.learning;
      return learning.defaultEfficiency || 0.7;
    }

    if (isSailing && awa != null) {
      return matrix.getSailing(azimuth, elevation, awa);
    }

    return matrix.getAnchored(azimuth, elevation);
  }

  /**
   * Creates or updates solar matrices for configured arrays.
   *
   * @param {object} config - Plugin configuration
   * @returns {Promise<void>}
   */
  async function initializeMatrices(config) {
    const arrays = getActiveSolarArrays(config);
    const dataDir = app.getDataDirPath();

    // Load existing matrices
    const existing = await deps.loadMatrices(dataDir);

    // Create matrix instances
    for (const array of arrays) {
      const id = array.id;

      // Check if already loaded
      if (solarMatrices.has(id)) {
        continue;
      }

      // Try to load from saved data
      const saved = existing.find((m) => m.arrayId === id);
      if (saved) {
        solarMatrices.set(id, deps.SolarMatrix.fromJSON(saved));
        app.debug(`Loaded solar matrix for ${id}`);
      } else {
        solarMatrices.set(id, new deps.SolarMatrix(id));
        app.debug(`Created new solar matrix for ${id}`);
      }
    }
  }

  /**
   * Initializes the load profile from disk.
   *
   * @returns {Promise<void>}
   */
  async function initializeLoadProfile() {
    const dataDir = app.getDataDirPath();

    try {
      if (predictionEngine?.loadProfile) {
        const loaded = await deps.loadLoadProfile(
          dataDir,
          predictionEngine.loadProfile,
        );
        if (loaded) {
          app.debug(`Loaded load profile from disk`);
        } else {
          app.debug(`No load profile found on disk, starting fresh`);
        }
      }
    } catch (error) {
      app.error(`Failed to load load profile: ${error.message}`);
    }
  }

  /**
   * Builds and updates the plugin status line.
   *
   * @returns {void}
   */
  function updateStatus() {
    if (!setStatus) {
      return;
    }

    try {
      let currentSoC = app.getSelfPath(
        pluginConfig?.battery?.socPath ||
          "electrical.batteries.house.capacity.stateOfCharge",
      );
      // Handle Signal K object-structured values
      if (
        currentSoC &&
        typeof currentSoC === "object" &&
        typeof currentSoC.value === "number"
      ) {
        currentSoC = currentSoC.value;
      }
      const socPercent =
        currentSoC != null && !isNaN(currentSoC)
          ? Math.round(currentSoC * 100)
          : null;

      const sourceInfo = ingestionFSM?.getSourceInfo();
      const timeToFull = predictionEngine?.getTimeToFull();
      const timeToEmpty = predictionEngine?.getTimeToEmpty();

      let status = "Ready.";

      // Add SoC and time predictions
      if (socPercent != null) {
        status += ` SoC: ${socPercent}%`;

        if (timeToFull) {
          const hoursToFull = Math.ceil(
            (timeToFull.getTime() - Date.now()) / 3600000,
          );
          status += ` → full (${hoursToFull}h)`;
        } else if (timeToEmpty) {
          const hoursToEmpty = Math.ceil(
            (timeToEmpty.getTime() - Date.now()) / 3600000,
          );
          status += ` ↓ empty (${hoursToEmpty}h)`;
        }
      }

      // Add current generation (current hour from forecast)
      if (predictionEngine?.lastPrediction?.length > 0) {
        const current = predictionEngine.lastPrediction[0];
        const solarGen = Math.round(current.idealSolarYieldWh);
        const windGen = Math.round(current.idealWindYieldWh);
        const totalGen = solarGen + windGen;
        if (totalGen > 0) {
          const genParts = [];
          if (solarGen > 0) genParts.push(`${solarGen}W solar`);
          if (windGen > 0) genParts.push(`${windGen}W wind/hydro`);
          status += ` Generating: ${genParts.join(", ")}`;
        }

        // Add forecast horizon summary
        const totalYield = predictionEngine.lastPrediction.reduce(
          (sum, p) => sum + p.idealSolarYieldWh + p.idealWindYieldWh,
          0,
        );
        status += ` ${predictionEngine.predictionHours}h: ${formatWh(totalYield)}`;
      }

      // Add weather source
      if (sourceInfo?.available) {
        status += ` Weather: ${sourceInfo.source}`;
      }

      // Add matrix info
      const matrixCount = solarMatrices.size;
      if (matrixCount > 0) {
        let totalBins = 0;
        for (const matrix of solarMatrices.values()) {
          totalBins += matrix.anchored.size + matrix.sailing.size;
        }
        status += ` Learning: ${matrixCount} array${matrixCount > 1 ? "s" : ""}, ${totalBins} bins`;
      }

      // Add active advisories count
      const activeNotifications =
        advisoryPublisher?.getActiveNotifications?.() ?? new Map();
      const activeCount = Array.from(activeNotifications.values()).filter(
        (n) => n.state !== "normal",
      ).length;
      if (activeCount > 0) {
        status += ` [${activeCount} active]`;
      }

      setStatus(status);
    } catch (error) {
      app.error(`Failed to update status: ${error.message}`);
    }
  }

  /**
   * Runs the prediction cycle.
   *
   * @returns {Promise<void>}
   */
  async function runPredictionCycle() {
    if (!ingestionFSM || !predictionEngine || !advisoryPublisher) {
      app.debug(
        `Prediction cycle skipped: components not ready (ingestionFSM: ${!!ingestionFSM}, predictionEngine: ${!!predictionEngine}, advisoryPublisher: ${!!advisoryPublisher})`,
      );
      return;
    }

    // Skip if we don't have a valid GPS position yet
    if (
      ingestionFSM.position.latitude == null ||
      ingestionFSM.position.longitude == null
    ) {
      app.debug("Prediction cycle skipped: no GPS position yet");
      return;
    }

    app.debug("Starting prediction cycle...");

    try {
      // Get weather forecast
      app.debug("Fetching weather forecast...");
      const forecast = await ingestionFSM.getForecast();
      app.debug(
        `Got forecast with ${forecast.length} points, source: ${ingestionFSM.getSourceInfo().source}`,
      );

      // Build map of current deploy states from deltaState (before runPrediction
      // so the detected-state yield track can use it)
      const navState = deltaState.get("navigation.state");
      const underway =
        navState === "sailing" ||
        navState === "motoring" ||
        navState === "under way";

      const currentDeployStates = new Map();
      for (const array of getActiveSolarArrays(pluginConfig)) {
        if (array.deployStatePath) {
          const val = deltaState.get(array.deployStatePath);
          currentDeployStates.set(array.id, normalizeDeployState(val));
        }
        // For deployable solar arrays, infer from power output during daytime
        if (array.type === "deployable" && array.powerPath) {
          const powerVal = toNumber(deltaState.get(array.powerPath));
          if (powerVal != null && powerVal > 0) {
            currentDeployStates.set(array.id, "deployed");
          }
          // No solar output during daytime means array is stowed
          if (powerVal != null && powerVal === 0) {
            const pos = deltaState.get("navigation.position");
            if (pos && pos.latitude != null) {
              const { sunPosition } = require("./solar.js");
              const sunPos = sunPosition(
                new Date(),
                pos.latitude,
                pos.longitude ?? 0,
              );
              if (sunPos.altitude > 0) {
                currentDeployStates.set(array.id, "stowed");
              }
            }
          }
        }
        // FLINsail always stowed when underway
        if (array.type === "deployable" && underway) {
          currentDeployStates.set(array.id, "stowed");
        }
      }
      for (const gen of getActiveGenerators(pluginConfig)) {
        if (gen.deployStatePath) {
          const val = deltaState.get(gen.deployStatePath);
          currentDeployStates.set(gen.id, normalizeDeployState(val));
        }
        // For deployable generators, infer from power output
        if (gen.deployable && gen.powerPath) {
          const powerVal = toNumber(deltaState.get(gen.powerPath));
          if (powerVal != null && powerVal > 0) {
            currentDeployStates.set(gen.id, "deployed");
          }
        }
        // Wind generator: if there is wind but no power output, it is stowed
        if (
          gen.deployable &&
          gen.type === "wind" &&
          !currentDeployStates.has(gen.id)
        ) {
          const powerVal = toNumber(deltaState.get(gen.powerPath));
          const startupSpeed = gen.startupSpeedKnots ?? 5;
          // Use average wind speed over recent history to avoid false positives
          // from brief gusts - wind generators need sustained wind to spin up
          const currentWind = toKnots(
            deltaState.get("environment.wind.speedApparent") ||
              deltaState.get("environment.wind.speedOverGround") ||
              deltaState.get("environment.wind.speedTrue") ||
              app.getSelfPath("environment.wind.speedApparent") ||
              app.getSelfPath("environment.wind.speedOverGround") ||
              app.getSelfPath("environment.wind.speedTrue"),
          );
          const allWindHistory = [
            ...(windHistory.get("environment.wind.speedApparent") || []),
            ...(windHistory.get("environment.wind.speedOverGround") || []),
            ...(windHistory.get("environment.wind.speedTrue") || []),
          ];
          // Use the most recent sample time as reference, falling back to Date.now()
          // This allows tests to "time travel" via delta timestamps
          const refTime =
            allWindHistory.length > 0
              ? Math.max(...allWindHistory.map((s) => s.time))
              : Date.now();
          const recentWind = allWindHistory.filter(
            (s) => s.time >= refTime - WIND_HISTORY_MS,
          );
          // Include current reading as an additional sample
          const samples =
            currentWind != null
              ? [...recentWind, { speed: currentWind }]
              : recentWind;
          const avgWind =
            samples.length > 0
              ? samples.reduce((sum, s) => sum + s.speed, 0) / samples.length
              : null;
          app.debug(
            `Wind gen ${gen.id}: avgWind=${avgWind?.toFixed(1) ?? "null"}kn (${recentWind.length} samples), powerVal=${powerVal}, startupSpeed=${startupSpeed}kn`,
          );
          if (
            powerVal != null &&
            powerVal === 0 &&
            avgWind != null &&
            avgWind >= startupSpeed &&
            recentWind.length >= 2
          ) {
            currentDeployStates.set(gen.id, "stowed");
          }
        }
        // Hydro is stowed when not sailing
        if (gen.deployable && gen.type === "hydro" && navState !== "sailing") {
          currentDeployStates.set(gen.id, "stowed");
        }
        // Hydro: if sailing above min speed but no power output, it is stowed
        if (
          gen.deployable &&
          gen.type === "hydro" &&
          !currentDeployStates.has(gen.id)
        ) {
          const powerVal = toNumber(deltaState.get(gen.powerPath));
          const speed = toKnots(deltaState.get("navigation.speedThroughWater"));
          const minSpeed = gen.minSpeedKnots ?? 3;
          if (
            powerVal != null &&
            powerVal === 0 &&
            speed != null &&
            speed >= minSpeed
          ) {
            currentDeployStates.set(gen.id, "stowed");
          }
        }
        // Wind generators stowed when underway (like FLINsail)
        if (gen.deployable && gen.type === "wind" && underway) {
          currentDeployStates.set(gen.id, "stowed");
        }
      }

      // Run prediction engine (with detected deploy states for the detected track)
      const hourly = predictionEngine.runPrediction(
        forecast,
        currentDeployStates,
      );
      app.debug(`Prediction complete: ${hourly.length} hours forecasted`);

      // Calculate advisories
      const timeToFull = predictionEngine.getTimeToFull();
      const timeToEmpty = predictionEngine.getTimeToEmpty();
      const stowageOpportunity = predictionEngine.findStowageOpportunity();

      const engineRunTime = predictionEngine.calculateEngineRunTime(
        pluginConfig.battery?.engineAlternatorWatts || 100,
      );

      // Get unified deployment recommendations for all deployable systems
      const deploymentRecommendations =
        predictionEngine.getDeploymentRecommendations();

      // Publish all advisories
      app.debug("Publishing advisories...");
      advisoryPublisher.publishAll({
        hourlyForecast: hourly,
        timeToFull,
        timeToEmpty,
        stowageOpportunity,
        engineRunTime,
        deploymentRecommendations,
        currentDeployStates,
      });
      app.debug(`Advisories published successfully`);

      // Record the prediction cycle
      const forecastObjects = predictionEngine.getHourlyForecast();
      const sourceInfo = ingestionFSM.getSourceInfo();
      const weatherTier = sourceInfo.tier || 1;
      await recorder?.recordCycle({
        timestamp: new Date(),
        weatherTier,
        forecast: forecastObjects,
        actions: hourly.flatMap((h) => h.actions || []),
      });

      app.debug(`Prediction cycle complete: ${hourly.length} hours forecasted`);

      // Update status line
      updateStatus();
    } catch (error) {
      app.error(`Prediction cycle failed: ${error.message}`);
    }
  }

  /**
   * Saves learning matrices to disk.
   *
   * @returns {Promise<void>}
   */
  async function saveMatricesToDisk() {
    const dataDir = app.getDataDirPath();

    try {
      const matrices = [];
      for (const [id, matrix] of solarMatrices) {
        matrices.push(matrix.toJSON());
      }

      await deps.saveMatrices(dataDir, matrices);
      app.debug(`Saved ${matrices.length} solar matrices`);
    } catch (error) {
      app.error(`Failed to save matrices: ${error.message}`);
    }

    // Save load profile
    try {
      await deps.saveLoadProfile(dataDir, predictionEngine?.loadProfile);
      app.debug(`Saved load profile`);
    } catch (error) {
      app.error(`Failed to save load profile: ${error.message}`);
    }
  }

  /**
   * Processes a Signal K delta update for learning.
   *
   * @param {object} delta - Signal K delta
   * @returns {Promise<void>}
   */
  /** @type {Map<string, any>} */
  const deltaState = new Map();

  /** @type {Set<string>} */
  const solarPowerPaths = new Set();

  /** @type {Map<string, {speed: number, time: number}[]>} */
  const windHistory = new Map();
  const WIND_HISTORY_MS = 5 * 60 * 1000; // 5 minutes
  const WIND_SAMPLE_INTERVAL_MS = 30 * 1000; // 30 seconds

  /**
   * Rolling solar power samples per path for running averages.
   * @type {Map<string, {value: number, time: number}[]>}
   */
  const solarPowerHistory = new Map();
  const DEFAULT_LEARNING_INTERVAL_MS = 60 * 1000;
  const DEFAULT_POWER_AVERAGE_WINDOW_MS = 5 * 60 * 1000;

  let lastLearningRun = 0;
  let learningRunning = false;
  let learningPending = false;
  let learningTimer = null;
  let learningCycleCount = 0;

  /**
   * Processes a delta update.
   * Reads values from the delta and stores them in deltaState for later use.
   * Only triggers learning when solar power values are received.
   *
   * @param {object} delta - Signal K delta
   * @returns {Promise<void>}
   */
  async function processDelta(delta) {
    const learning = pluginConfig?.learning || DEFAULT_CONFIG.learning;

    try {
      // Track which solar power paths we saw in this delta
      const solarPowerDelta = [];

      // Update state from delta values - always cache, regardless of learning
      if (delta.updates) {
        for (const update of delta.updates) {
          if (!update.values) {
            continue;
          }

          for (const v of update.values) {
            // navigation.state is a sticky state: an empty/null update
            // (some providers emit "" when the source drops out) must not
            // clear a previously known state. Carry the last valid value
            // forward until a real new state arrives.
            if (
              v.path === "navigation.state" &&
              (v.value == null || v.value === "") &&
              deltaState.has("navigation.state")
            ) {
              continue;
            }
            deltaState.set(v.path, v.value);

            if (v.path === "navigation.position" && v.value) {
              // Update ingestionFSM position immediately
              if (ingestionFSM) {
                ingestionFSM.position = {
                  latitude: v.value.latitude,
                  longitude: v.value.longitude,
                };
              }

              // Trigger first prediction cycle once we have GPS
              if (!hasPosition) {
                hasPosition = true;
                app.debug(
                  `Got first GPS position: ${v.value.latitude.toFixed(4)}, ${v.value.longitude.toFixed(4)}, triggering prediction cycle`,
                );
                if (!hasRunPredictionWithPosition) {
                  hasRunPredictionWithPosition = true;
                  runPredictionCycle().catch((error) => {
                    app.error(
                      `Initial prediction cycle error: ${error.message}`,
                    );
                  });
                }
              }
            }

            // Track if this is a solar power path we care about
            if (solarPowerPaths.has(v.path)) {
              solarPowerDelta.push(v.path);

              // Record sample for running average (learning uses the
              // averaged value instead of the instantaneous reading)
              const powerW = toNumber(v.value);
              if (powerW != null) {
                const sampleTime = update.timestamp
                  ? new Date(update.timestamp).getTime()
                  : Date.now();
                const samples = solarPowerHistory.get(v.path) || [];
                samples.push({ value: powerW, time: sampleTime });
                const cutoff = sampleTime - DEFAULT_POWER_AVERAGE_WINDOW_MS;
                while (samples.length > 0 && samples[0].time < cutoff) {
                  samples.shift();
                }
                solarPowerHistory.set(v.path, samples);
              }
            }

            // Track wind speed history for wind generator spin-up detection
            if (
              v.path === "environment.wind.speedApparent" ||
              v.path === "environment.wind.speedOverGround" ||
              v.path === "environment.wind.speedTrue"
            ) {
              // Use update timestamp if available, otherwise Date.now()
              const now = update.timestamp
                ? new Date(update.timestamp).getTime()
                : Date.now();
              const history = windHistory.get(v.path) || [];
              // Only sample if enough time since last sample
              if (
                history.length === 0 ||
                now - history[history.length - 1].time >=
                  WIND_SAMPLE_INTERVAL_MS
              ) {
                history.push({
                  speed: toKnots(v.value),
                  time: now,
                });
                // Trim to window
                const cutoff = now - WIND_HISTORY_MS;
                while (history.length > 0 && history[0].time < cutoff) {
                  history.shift();
                }
                windHistory.set(v.path, history);
              }
            }
          }
        }
      }

      // Only run learning if learning is enabled and we got a solar power reading
      if (!learning.enabled || !ingestionFSM) {
        return;
      }

      if (solarPowerDelta.length === 0) {
        return;
      }

      scheduleLearning();
    } catch (error) {
      app.error(`Failed to process delta for learning: ${error.message}`);
    }
  }

  /**
   * Schedules a learning cycle, throttled to the configured minimum
   * interval. Deltas arriving while a cycle is in progress or within the
   * throttle window set the pending flag so a trailing cycle runs with the
   * latest averaged values.
   *
   * @returns {void}
   */
  function scheduleLearning() {
    const learning = pluginConfig?.learning || DEFAULT_CONFIG.learning;
    const minIntervalMs =
      (learning.minIntervalSeconds ?? DEFAULT_LEARNING_INTERVAL_MS / 1000) *
      1000;

    if (learningTimer != null) {
      // A cycle is already scheduled; it will pick up the latest samples
      learningPending = true;
      return;
    }

    const wait = Math.max(0, lastLearningRun + minIntervalMs - Date.now());
    learningTimer = setTimeout(() => {
      learningTimer = null;
      runLearningCycle().catch((error) => {
        app.error(`Learning cycle error: ${error.message}`);
      });
    }, wait);
  }

  /**
   * Runs a single learning cycle, guarding against concurrent runs.
   *
   * @returns {Promise<void>}
   */
  async function runLearningCycle() {
    if (learningRunning) {
      learningPending = true;
      return;
    }
    learningRunning = true;
    lastLearningRun = Date.now();
    try {
      await processSolarLearning();
    } catch (error) {
      app.error(`Failed to process delta for learning: ${error.message}`);
    } finally {
      learningRunning = false;
      if (learningPending) {
        learningPending = false;
        scheduleLearning();
      }
    }
  }

  /**
   * Runs one learning pass over all configured solar arrays using the
   * running-average power values.
   *
   * @returns {Promise<void>}
   */
  async function processSolarLearning() {
    try {
      app.debug("Learning cycle starting...");

      // Get current GHI (will use cached forecast if available)
      const currentGHI = await ingestionFSM.getCurrentGHI();
      app.debug(
        `Current GHI: ${currentGHI.ghi.toFixed(0)} W/m², tier: ${currentGHI.tier}`,
      );

      // Get navigation state from delta state
      const navStateRaw =
        deltaState.get("navigation.state") ||
        app.getSelfPath("navigation.state");
      const navState =
        typeof navStateRaw === "string" ? navStateRaw : "unknown";
      const isSailing = navState === "sailing";

      // Get AWA if sailing
      let awa = null;
      if (isSailing) {
        awa =
          deltaState.get("environment.wind.angleApparent") ||
          app.getSelfPath("environment.wind.angleApparent");
      }

      // Update each solar array
      const arrays = getActiveSolarArrays(pluginConfig);
      let updatedArrays = 0;
      app.debug(
        `Checking ${arrays.length} configured solar arrays for learning...`,
      );
      for (const array of arrays) {
        const powerPath = array.powerPath;
        if (!powerPath) {
          app.debug(`Array ${array.id}: no powerPath, skipping`);
          continue;
        }

        // Use running average of recent samples instead of the
        // instantaneous reading (cloud transients and fast MPPT swings
        // would otherwise dominate the EMA update)
        const samples = solarPowerHistory.get(powerPath) || [];
        const windowMs =
          (pluginConfig?.learning?.averageWindowSeconds ??
            DEFAULT_POWER_AVERAGE_WINDOW_MS / 1000) * 1000;
        const windowSamples = samples.filter(
          (s) => s.time >= Date.now() - windowMs,
        );
        const actualPowerW =
          windowSamples.length > 0
            ? windowSamples.reduce((sum, s) => sum + s.value, 0) /
              windowSamples.length
            : toNumber(deltaState.get(powerPath) || app.getSelfPath(powerPath));

        if (actualPowerW == null || actualPowerW <= 0) {
          app.debug(
            `Array ${array.id}: powerPath="${powerPath}" -> ${actualPowerW == null ? "null/no data" : actualPowerW + "W"}, skipping`,
          );
          continue;
        }

        app.debug(`Array ${array.id}: learning with ${actualPowerW}W output`);

        // Get sun position (prefer delta state, fall back to app.getSelfPath)
        const pos =
          deltaState.get("navigation.position") ||
          app.getSelfPath("navigation.position");
        if (!pos || pos.latitude == null || pos.longitude == null) {
          app.debug(`Array ${array.id}: no GPS position, skipping learning`);
          continue;
        }

        const { sunPosition } = await import("./solar.js");
        const sunPos = sunPosition(new Date(), pos.latitude, pos.longitude);
        const deg = (rad) => ((rad * 180) / Math.PI).toFixed(1);
        app.debug(
          `Array ${array.id}: sun at ${deg(sunPos.azimuth)}° azimuth, ${deg(sunPos.altitude)}° altitude`,
        );

        // Get matrix
        const matrix = solarMatrices.get(array.id);
        if (!matrix) {
          continue;
        }

        // Build sanitization gate readings (prefer delta state, fall back to app.getSelfPath)
        const readings = {
          engineRunning: detectEngineRunning(deltaState),
          batterySoc:
            deltaState.get(
              pluginConfig.battery?.socPath ||
                "electrical.batteries.house.capacity.stateOfCharge",
            ) ||
            app.getSelfPath(
              pluginConfig.battery?.socPath ||
                "electrical.batteries.house.capacity.stateOfCharge",
            ),
          shorePowerConnected:
            deltaState.get("electrical.shore.power.connected") ||
            app.getSelfPath("electrical.shore.power.connected"),
          controllerMode: array.controllerModePath
            ? deltaState.get(array.controllerModePath) ||
              app.getSelfPath(array.controllerModePath)
            : null,
        };

        // Update matrix
        matrix.update({
          navState,
          actualPowerW,
          capacityWp: getActiveCapacity(array),
          ghi: currentGHI.ghi,
          sunAzimuthRad: sunPos.azimuth,
          sunElevationRad: sunPos.altitude,
          awaRad: awa,
          readings,
        });
        updatedArrays++;
      }

      if (updatedArrays > 0) {
        app.debug(`Learning cycle complete: updated ${updatedArrays} arrays`);
      }
      learningCycleCount++;
    } catch (error) {
      app.error(`Failed to process learning cycle: ${error.message}`);
    }
  }

  /**
   * Records a 5-minute sample of current measured values.
   * Captures per-array power, per-generator power, SoC, house load, wind speed,
   * navigation state, and position.
   *
   * @returns {Promise<void>}
   */
  async function recordSample() {
    if (!recorder) {
      return;
    }

    // Get per-array power readings
    const arrays = {};
    for (const array of getActiveSolarArrays(pluginConfig)) {
      if (array.powerPath) {
        const powerW = toNumber(
          deltaState.get(array.powerPath) || app.getSelfPath(array.powerPath),
        );
        if (powerW != null) {
          arrays[array.id] = powerW;
        }
      }
    }

    // Get per-generator power readings
    const generators = {};
    for (const gen of getActiveGenerators(pluginConfig)) {
      if (gen.powerPath) {
        const powerW = toNumber(
          deltaState.get(gen.powerPath) || app.getSelfPath(gen.powerPath),
        );
        if (powerW != null) {
          generators[gen.id] = powerW;
        }
      }
    }

    // Get battery SoC
    const socPath =
      pluginConfig?.battery?.socPath ||
      "electrical.batteries.house.capacity.stateOfCharge";
    let soc = deltaState.get(socPath) || app.getSelfPath(socPath);
    // Handle Signal K object-structured values
    if (soc && typeof soc === "object" && typeof soc.value === "number") {
      soc = soc.value;
    }
    soc = toNumber(soc);

    // Get house load (sum of all dcPower readings from venus)
    const houseLoadW =
      toNumber(
        deltaState.get("electrical.venus.dcPower") ||
          app.getSelfPath("electrical.venus.dcPower"),
      ) || 0;

    // Get wind speed
    const windSpeedKnots =
      toKnots(
        deltaState.get("environment.wind.speedApparent") ||
          app.getSelfPath("environment.wind.speedApparent"),
      ) ||
      toKnots(
        deltaState.get("environment.wind.speedOverGround") ||
          app.getSelfPath("environment.wind.speedOverGround"),
      ) ||
      toKnots(
        deltaState.get("environment.wind.speedTrue") ||
          app.getSelfPath("environment.wind.speedTrue"),
      ) ||
      null;

    // Get navigation state
    const navState =
      deltaState.get("navigation.state") ||
      app.getSelfPath("navigation.state") ||
      "unknown";

    // Get position
    const position =
      deltaState.get("navigation.position") ||
      app.getSelfPath("navigation.position") ||
      null;

    // Get speed through water (for hydro generator prediction)
    const stwKnots =
      toKnots(
        deltaState.get("navigation.speedThroughWater") ||
          app.getSelfPath("navigation.speedThroughWater"),
      ) || null;

    await recorder.recordSample({
      timestamp: new Date(),
      arrays,
      generators,
      soc,
      houseLoadW,
      windSpeedKnots,
      navState,
      position,
      stwKnots,
    });
  }

  /**
   * Subscribes to Signal K delta updates.
   *
   * @returns {void}
   */
  function subscribeToDeltas() {
    // Collect deploy state and power paths from configured devices
    const extraPaths = [];
    for (const array of getActiveSolarArrays(pluginConfig)) {
      if (array.deployStatePath) {
        extraPaths.push(array.deployStatePath);
      }
      if (array.powerPath) {
        extraPaths.push(array.powerPath);
      }
    }
    for (const gen of getActiveGenerators(pluginConfig)) {
      if (gen.deployStatePath) {
        extraPaths.push(gen.deployStatePath);
      }
      if (gen.powerPath) {
        extraPaths.push(gen.powerPath);
      }
    }

    const allPaths = [...SUBSCRIPTION_PATHS, ...extraPaths];
    const subscription = {
      context: "vessels.self",
      subscribe: allPaths.map((path) => ({ path })),
    };

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (subscriptionError) => {
        app.error(`Subscription error: ${subscriptionError}`);
      },
      (delta) => {
        processDelta(delta).catch((error) => {
          app.error(`Delta processing error: ${error.message}`);
        });
      },
    );
    app.debug(
      `Delta subscription established, ${unsubscribes.length} unsubscribes registered`,
    );
  }

  /** @type {Plugin} */
  const plugin = {
    id: "signalk-energy-predictor",
    name: "Energy Predictor",
    description:
      "Predictive energy management with offline-first incremental learning",

    /**
     * Starts the plugin.
     *
     * @param {object} config - Plugin configuration
     * @param {Function} restart - Restart callback
     */
    async start(config, restart) {
      app.debug("Starting Energy Predictor plugin");

      // Validate configuration
      const { warnings } = deps.validateConfig(config);

      // Log validation warnings
      for (const warning of warnings) {
        app.warn(warning);
      }

      // Store config for later use
      pluginConfig = config || DEFAULT_CONFIG;

      // Reset position tracking flags
      hasPosition = false;
      hasRunPredictionWithPosition = false;

      // Populate solar power paths set for delta filtering
      solarPowerPaths.clear();
      solarPowerHistory.clear();
      lastLearningRun = 0;
      learningRunning = false;
      learningPending = false;
      learningCycleCount = 0;
      if (learningTimer != null) {
        clearTimeout(learningTimer);
        learningTimer = null;
      }
      for (const array of getActiveSolarArrays(config)) {
        if (array.powerPath) {
          solarPowerPaths.add(array.powerPath);
        }
      }
      app.debug(
        `Tracking ${solarPowerPaths.size} solar power paths for learning triggers`,
      );

      // Initialize components
      ingestionFSM = new deps.IngestionFSM(app, {
        forecastHours: config.weather?.forecastHours,
      });
      advisoryPublisher = new deps.AdvisoryPublisher(app, plugin.id);

      // Initialize recorder
      const dataDir = app.getDataDirPath();
      const recordingConfig = config.recording || {};
      recorder = new deps.Recorder(app, dataDir, recordingConfig);
      recorder.startPruneInterval();
      app.debug(
        `Recorder initialized: enabled=${recorder.enabled}, retentionDays=${recorder.retentionDays}`,
      );

      await initializeMatrices(config);

      // Configure prediction engine
      const battery = config.battery || DEFAULT_CONFIG.battery;
      predictionEngine = new deps.PredictionEngine({
        battery,
        solarArrays: getActiveSolarArrays(config).map((a) => ({
          ...a,
          capacityWp: getActiveCapacity(a),
        })),
        mechanicalGenerators: getActiveGenerators(config),
        getEfficiency,
        getSelfPath: (path) => deltaState.get(path) ?? app.getSelfPath(path),
        getDisplayName,
        app,
        loadProfileConfig: config.loadProfile || {},
        predictionHours: config.weather?.forecastHours,
      });

      await initializeLoadProfile();

      // Subscribe to Signal K updates
      subscribeToDeltas();

      // Start periodic update cycle
      const updateInterval =
        (config.updateIntervalMinutes || DEFAULT_CONFIG.updateIntervalMinutes) *
        60000;
      app.debug(
        `Scheduling prediction cycle every ${updateInterval / 60000} minutes`,
      );
      updateIntervalId = setInterval(() => {
        app.debug(`Running scheduled prediction cycle...`);
        runPredictionCycle().catch((error) => {
          app.error(`Prediction cycle error: ${error.message}`);
        });
      }, updateInterval);

      // Start periodic save cycle
      const learning = config.learning || DEFAULT_CONFIG.learning;
      const saveInterval =
        (learning.saveIntervalMinutes ||
          DEFAULT_CONFIG.learning.saveIntervalMinutes) * 60000;
      app.debug(`Scheduling matrix save every ${saveInterval / 60000} minutes`);
      saveIntervalId = setInterval(() => {
        app.debug(`Saving matrices to disk...`);
        saveMatricesToDisk().catch((error) => {
          app.error(`Save cycle error: ${error.message}`);
        });
      }, saveInterval);

      // Start 5-minute sample recording interval
      const sampleIntervalMs = 5 * 60 * 1000;
      app.debug(
        `Scheduling sample recording every ${sampleIntervalMs / 1000} seconds`,
      );
      sampleIntervalId = setInterval(() => {
        recordSample().catch((error) => {
          app.error(`Sample recording error: ${error.message}`);
        });
      }, sampleIntervalMs);

      // Run initial prediction
      app.debug(`Running initial prediction cycle...`);
      await runPredictionCycle();

      // Set initial status
      const activeSolar = getActiveSolarArrays(pluginConfig).filter(
        (a) => a.enabled !== false,
      ).length;
      const activeGenerators = getActiveGenerators(pluginConfig).filter(
        (g) => g.enabled !== false,
      ).length;
      if (setStatus) {
        setStatus(
          `Ready. Learning: ${activeSolar} solar array${activeSolar !== 1 ? "s" : ""}, ${solarMatrices.size} matrices, ${activeGenerators} generator${activeGenerators !== 1 ? "s" : ""} configured`,
        );
      }

      app.debug("Energy Predictor plugin started");
    },

    /**
     * Stops the plugin.
     */
    async stop() {
      app.debug("Stopping Energy Predictor plugin");

      // Clear intervals
      if (updateIntervalId) {
        clearInterval(updateIntervalId);
        updateIntervalId = null;
      }

      if (saveIntervalId) {
        clearInterval(saveIntervalId);
        saveIntervalId = null;
      }

      if (learningTimer != null) {
        clearTimeout(learningTimer);
        learningTimer = null;
      }

      if (sampleIntervalId) {
        clearInterval(sampleIntervalId);
        sampleIntervalId = null;
      }

      // Stop recorder
      if (recorder) {
        recorder.stopPruneInterval();
        recorder = null;
      }

      // Unsubscribe from deltas
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      unsubscribes.length = 0;

      // Clear notifications
      if (advisoryPublisher) {
        advisoryPublisher.clearAll();
      }

      // Save matrices on shutdown and build final status
      await saveMatricesToDisk();

      // Build final status
      let totalBins = 0;
      for (const matrix of solarMatrices.values()) {
        totalBins += matrix.anchored.size + matrix.sailing.size;
      }
      const finalStatus =
        totalBins > 0
          ? `Stopped. Learning: ${solarMatrices.size} arrays, ${totalBins} efficiency bins saved`
          : "Stopped";
      if (setStatus) {
        setStatus(finalStatus);
      }

      app.debug("Energy Predictor plugin stopped");
    },

    /**
     * Returns the JSON Schema for configuration.
     *
     * @returns {object} JSON Schema
     */
    schema() {
      return buildPluginSchema();
    },

    /**
     * Registers REST API routes under the plugin router root
     * (`/plugins/<id>/api/...`).
     *
     * @param {object} router - Express router
     * @returns {void}
     */
    registerWithRouter(router) {
      deps.registerApiRoutes(router, {
        app,
        getConfig: () => pluginConfig,
        dataDir: app.getDataDirPath(),
      });
      app.debug("REST API routes registered");
    },

    /**
     * Returns the plugin's OpenAPI specification.
     *
     * @returns {object} OpenAPI 3 document
     */
    getOpenApi() {
      return openApiSpec;
    },
  };

  // Expose internals for testing
  plugin.__getInternals = () => ({
    ingestionFSM,
    predictionEngine,
    advisoryPublisher,
    recorder,
    solarMatrices,
    runPredictionCycle,
    recordSample,
    get learningCycleCount() {
      return learningCycleCount;
    },
  });

  // Export dependencies for testing
  plugin.deps = deps;

  return plugin;
};
