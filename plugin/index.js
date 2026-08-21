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
const { PredictionEngine } = require("./prediction.js");
const { AdvisoryPublisher } = require("./advisory.js");
const { buildPluginSchema, parseManufacturerCurve, getActiveCapacity, getDisplayName, validateConfig } = require("./schema.js");
const { sunPosition } = require("./solar.js");

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
    saveIntervalMinutes: 60,
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
  "electrical.batteries.house.current",
  "electrical.batteries.house.load",
  "network.wan.status",
];

/**
 * Overridable dependencies for testing.
 */
const deps = {
  SolarMatrix,
  IngestionFSM,
  PredictionEngine,
  AdvisoryPublisher,
  loadMatrices: matrixModule.loadAllMatrices,
  saveMatrices: matrixModule.saveMatrices,
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

  /** @type {number|null} */
  let updateIntervalId = null;

  /** @type {number|null} */
  let saveIntervalId = null;

  /** @type {Function[]} */
  const unsubscribes = [];

  /** @type {object|null} */
  let pluginConfig = null;

  /** @type {Function} */
  const setStatus = app.setPluginStatus || app.setProviderStatus;

  /** @type {{lastPrediction: object, lastForecastTime: Date|null, sourceInfo: object}|null} */
  let statusCache = null;

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
    const dataDir = app.getDataPath?.() || ".";

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
   * Builds and updates the plugin status line.
   *
   * @returns {void}
   */
  function updateStatus() {
    if (!setStatus) {
      return;
    }

    try {
      const currentSoC = app.getSelfPath(pluginConfig?.battery?.socPath || "electrical.batteries.house.capacity.stateOfCharge");
      const socPercent = currentSoC != null ? Math.round(currentSoC * 100) : null;

      const sourceInfo = ingestionFSM?.getSourceInfo();
      const timeToFull = predictionEngine?.getTimeToFull();
      const timeToEmpty = predictionEngine?.getTimeToEmpty();

      let status = "Ready.";

      // Add SoC and time predictions
      if (socPercent != null) {
        status += ` SoC: ${socPercent}%`;

        if (timeToFull) {
          const hoursToFull = Math.ceil((timeToFull.getTime() - Date.now()) / 3600000);
          status += ` → full (${hoursToFull}h)`;
        } else if (timeToEmpty) {
          const hoursToEmpty = Math.ceil((timeToEmpty.getTime() - Date.now()) / 3600000);
          status += ` ↓ empty (${hoursToEmpty}h)`;
        }
      }

      // Add current generation (current hour from forecast)
      if (predictionEngine?.lastPrediction?.length > 0) {
        const current = predictionEngine.lastPrediction[0];
        const solarGen = Math.round(current.solarYieldWh);
        const windGen = Math.round(current.windYieldWh);
        const totalGen = solarGen + windGen;
        if (totalGen > 0) {
          const genParts = [];
          if (solarGen > 0) genParts.push(`${solarGen}W solar`);
          if (windGen > 0) genParts.push(`${windGen}W wind/hydro`);
          status += ` Generating: ${genParts.join(", ")}`;
        }

        // Add 24h forecast summary
        const totalYield24h = predictionEngine.lastPrediction
          .reduce((sum, p) => sum + p.solarYieldWh + p.windYieldWh, 0);
        status += ` 24h: ${Math.round(totalYield24h)}Wh`;
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
      const activeNotifications = advisoryPublisher?.getActiveNotifications?.() ?? new Map();
      const activeCount = Array.from(activeNotifications.values()).filter((n) => n.state !== "normal").length;
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
      return;
    }

    try {
      // Get weather forecast
      const forecast = await ingestionFSM.getForecast();

      // Run prediction engine
      const hourly = predictionEngine.runPrediction(forecast);

      // Calculate advisories
      const timeToFull = predictionEngine.getTimeToFull();
      const timeToEmpty = predictionEngine.getTimeToEmpty();
      const stowageOpportunity = predictionEngine.findStowageOpportunity();
      const deploymentOpportunities = predictionEngine.findDeploymentOpportunities();

      const engineRunTime = predictionEngine.calculateEngineRunTime(pluginConfig.battery?.engineAlternatorWatts || 100);

      // Check FLINsail risk
      const flinSailArray = getActiveSolarArrays(pluginConfig).find((a) => a.type === "deployable");
      const currentGHI = await ingestionFSM.getCurrentGHI();
      const flinSailStowNeeded =
        flinSailArray &&
        flinSailArray.gustLimitKnots != null &&
        currentGHI.gustSpeedKnots != null &&
        currentGHI.gustSpeedKnots >= flinSailArray.gustLimitKnots;

      // Publish all advisories
      advisoryPublisher.publishAll({
        hourlyForecast: hourly,
        timeToFull,
        timeToEmpty,
        stowageOpportunity,
        engineRunTime,
        flinSailStowNeeded,
        flinSailName: flinSailArray ? getDisplayName(flinSailArray) : "",
        currentGustKnots: currentGHI.gustSpeedKnots ?? 0,
        gustLimitKnots: flinSailArray?.gustLimitKnots ?? 20,
        deploymentOpportunities,
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
    const dataDir = app.getDataPath?.() || ".";

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
  }

  /**
   * Processes a Signal K delta update for learning.
   *
   * @param {object} delta - Signal K delta
   * @returns {Promise<void>}
   */
  async function processDelta(delta) {
    const learning = pluginConfig?.learning || DEFAULT_CONFIG.learning;

    if (!learning.enabled) {
      return;
    }

    if (!ingestionFSM) {
      return;
    }

    try {
      // Get current GHI
      const currentGHI = await ingestionFSM.getCurrentGHI();

      // Get navigation state
      const navState = app.getSelfPath("navigation.state") || "unknown";
      const isSailing = navState === "sailing";

      // Get AWA if sailing
      let awa = null;
      if (isSailing) {
        awa = app.getSelfPath("environment.wind.angleApparent");
      }

      // Update each solar array
      const arrays = getActiveSolarArrays(pluginConfig);
      for (const array of arrays) {
        const powerPath = array.powerPath;
        if (!powerPath) {
          continue;
        }

        // Read current power output
        const powerReading = app.getSelfPath(powerPath);
        const actualPowerW = typeof powerReading === "number" ? powerReading : null;

        if (actualPowerW == null || actualPowerW <= 0) {
          continue;
        }

        // Get sun position
        const pos = app.getSelfPath("navigation.position");
        if (!pos || pos.latitude == null || pos.longitude == null) {
          continue;
        }

        const { sunPosition } = await import("./solar.js");
        const sunPos = sunPosition(new Date(), pos.latitude, pos.longitude);

        // Get matrix
        const matrix = solarMatrices.get(array.id);
        if (!matrix) {
          continue;
        }

        // Build sanitization gate readings
        const readings = {
          engineRpm: app.getSelfPath("propulsion.engine.revolutions"),
          batterySoc: app.getSelfPath(pluginConfig.battery?.socPath || "electrical.batteries.house.capacity.stateOfCharge"),
          shorePowerConnected: app.getSelfPath("electrical.shore.power.connected"),
          controllerMode: array.controllerModePath ? app.getSelfPath(array.controllerModePath) : null,
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
      }
    } catch (error) {
      app.error(`Failed to process delta for learning: ${error.message}`);
    }
  }

  /**
   * Subscribes to Signal K delta updates.
   *
   * @returns {void}
   */
  function subscribeToDeltas() {
    const subscription = {
      context: "vessels.self",
      subscribe: SUBSCRIPTION_PATHS.map((path) => ({ path })),
    };

    const unsubscribe = app.subscriptionmanager.subscribe(
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

    unsubscribes.push(unsubscribe);
  }

  /** @type {Plugin} */
  const plugin = {
    id: "signalk-energy-predictor",
    name: "Energy Predictor",
    description: "Predictive energy management with offline-first incremental learning",

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

      // Initialize components
      ingestionFSM = new deps.IngestionFSM(app);
      advisoryPublisher = new deps.AdvisoryPublisher(app);

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
        getSelfPath: (path) => app.getSelfPath(path),
        getDisplayName,
      });

      // Subscribe to Signal K updates
      subscribeToDeltas();

      // Start periodic update cycle
      const updateInterval = (config.updateIntervalMinutes || DEFAULT_CONFIG.updateIntervalMinutes) * 60000;
      updateIntervalId = setInterval(() => {
        runPredictionCycle().catch((error) => {
          app.error(`Prediction cycle error: ${error.message}`);
        });
      }, updateInterval);

      // Start periodic save cycle
      const learning = config.learning || DEFAULT_CONFIG.learning;
      const saveInterval = (learning.saveIntervalMinutes || DEFAULT_CONFIG.learning.saveIntervalMinutes) * 60000;
      saveIntervalId = setInterval(() => {
        saveMatricesToDisk().catch((error) => {
          app.error(`Save cycle error: ${error.message}`);
        });
      }, saveInterval);

      // Run initial prediction
      await runPredictionCycle();

      // Set initial status
      const activeSolar = getActiveSolarArrays(pluginConfig).filter((a) => a.enabled !== false).length;
      const activeGenerators = getActiveGenerators(pluginConfig).filter((g) => g.enabled !== false).length;
      setStatus(`Ready. Learning: ${activeSolar} solar array${activeSolar !== 1 ? "s" : ""}, ${solarMatrices.size} matrices, ${activeGenerators} generator${activeGenerators !== 1 ? "s" : ""} configured`);

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
      const finalStatus = totalBins > 0
        ? `Stopped. Learning: ${solarMatrices.size} arrays, ${totalBins} efficiency bins saved`
        : "Stopped";
      setStatus(finalStatus);

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
  };

  // Export dependencies for testing
  plugin.deps = deps;

  return plugin;
};