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
const {
  WindProtectionStore,
  sectorFromDeg,
  isNight: wpfIsNight,
  toForecastReference,
  toDeviceHeight,
  DEFAULT_FACTOR,
  DEFAULT_ANEMOMETER_HEIGHT_M,
  DEFAULT_DEVICE_HEIGHT_M,
  DEFAULT_ROUGHNESS_LENGTH,
  SOURCE_NONE,
} = require("./wind-protection.js");
const matrixModule = require("./matrix.js");
const {
  PredictionEngine,
  toNumber,
  toKnots,
  unwrapPosition,
} = require("./prediction.js");
const {
  AdvisoryPublisher,
  AdvisoryType,
  solarOffsetMinutesFromLongitude,
  formatWindowTime,
} = require("./advisory.js");
const { StateConfidence } = require("./urgency.js");
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
const {
  detectSolarArrayState,
  detectGeneratorState,
  STOW_INFERENCE_MIN_SUN_ALT_RAD,
} = require("./deploy-state.js");
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
 * Builds the recorded `advisories` list for a prediction cycle from the
 * surplus/deficit/stowage opportunities. Each entry carries a stable
 * `type` ("surplus"/"engine"/"stowage"), the cycle timestamp, a
 * human-readable message mirroring the Signal K notification text, and —
 * for the surplus advisory — the structured window data plus a list of
 * elective-load suggestions the webapp can render in more detail than the
 * terse notification.
 *
 * Deficit is represented by the engine-run advisory (run the engine to
 * avoid a flat bank); surplus by the surplus-opportunity advisory.
 * `null` opportunities are omitted (nothing to record).
 *
 * @param {object} opts
 * @param {{surplusWh: number, from: Date, to: Date, suggestedLoadW: number}|null} opts.surplusOpportunity
 * @param {{hours: number, optimalWindow: {start: Date, end: Date}}|null} opts.engineRunTime
 * @param {{hour: number, reason: string}|null} opts.stowageOpportunity
 * @param {Array<{name: string, watts: number, statePath?: string, onValues?: string}>} [opts.opportunisticLoads=[]] -
 *        Configured elective loads; those already running are skipped
 * @param {((load: object) => boolean)|null} [opts.isLoadRunning=null] -
 *        Predicate from `AdvisoryPublisher.isLoadRunning`; null treats
 *        all loads as not-running (always suggested)
 * @param {number|null} [opts.localOffsetMinutes=null] - Solar-local UTC
 *        offset (min) for human-facing times; null uses host timezone
 * @returns {Array<{type: string, time: string, message: string}>}
 */
function buildCycleAdvisories({
  surplusOpportunity,
  engineRunTime,
  stowageOpportunity,
  opportunisticLoads = [],
  isLoadRunning = null,
  localOffsetMinutes = null,
}) {
  const now = new Date().toISOString();
  const advisories = [];
  if (surplusOpportunity) {
    const from = formatWindowTime(
      surplusOpportunity.from,
      undefined,
      localOffsetMinutes,
    );
    const to = formatWindowTime(
      surplusOpportunity.to,
      surplusOpportunity.from,
      localOffsetMinutes,
    );
    let message = `${formatWh(surplusOpportunity.surplusWh)} surplus available ${from}-${to}`;
    if (surplusOpportunity.suggestedLoadW > 0) {
      message += ` (~${surplusOpportunity.suggestedLoadW}W sustained)`;
    }
    // Elective-load suggestions: the surplus could run each configured
    // load (if it isn't already running) for `surplusWh / watts` hours,
    // capped by the window length so we don't suggest running a load past
    // the moment the bank stops being full.
    const windowHours =
      (surplusOpportunity.to.getTime() - surplusOpportunity.from.getTime()) /
      (3600 * 1000);
    const loads = (opportunisticLoads || [])
      .filter((load) => !isLoadRunning?.(load))
      .filter((load) => load.watts > 0)
      .map((load) => {
        const runHours = Math.min(
          windowHours,
          surplusOpportunity.surplusWh / load.watts,
        );
        return {
          name: load.name,
          watts: load.watts,
          runHours: Math.round(runHours * 10) / 10,
        };
      });
    advisories.push({
      type: AdvisoryType.SURPLUS_OPPORTUNITY,
      time: surplusOpportunity.from.toISOString(),
      message,
      surplusWh: surplusOpportunity.surplusWh,
      from: surplusOpportunity.from.toISOString(),
      to: surplusOpportunity.to.toISOString(),
      sustainedW: surplusOpportunity.suggestedLoadW,
      loads,
    });
  }
  if (engineRunTime) {
    const hours = Math.round(engineRunTime.hours * 10) / 10;
    const start = formatWindowTime(
      engineRunTime.optimalWindow.start,
      undefined,
      localOffsetMinutes,
    );
    const end = formatWindowTime(
      engineRunTime.optimalWindow.end,
      undefined,
      localOffsetMinutes,
    );
    advisories.push({
      type: AdvisoryType.ENGINE_RUN,
      time: engineRunTime.optimalWindow.start.toISOString(),
      message: `Run engine for ${hours}h between ${start}-${end} to avoid low battery`,
      engineHours: hours,
      windowStart: engineRunTime.optimalWindow.start.toISOString(),
      windowEnd: engineRunTime.optimalWindow.end.toISOString(),
    });
  }
  if (stowageOpportunity) {
    advisories.push({
      type: AdvisoryType.STOW_SOON,
      time: now,
      message: `Stow mechanical generators in ${stowageOpportunity.hour}h to reduce drag - ${stowageOpportunity.reason}`,
      inHours: stowageOpportunity.hour,
      reason: stowageOpportunity.reason,
    });
  }
  return advisories;
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
    forecastCacheHours: 24,
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
  "environment.wind.speedTrue",
  "environment.wind.directionTrue",
  "electrical.batteries.house.capacity.stateOfCharge",
  "electrical.venus.dcPower",
  "electrical.venus.acPower",
  "propulsion.*.state",
  "propulsion.*.revolutions",
  "network.internet.state",
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
  loadWindProtection: matrixModule.loadWindProtection,
  saveWindProtection: matrixModule.saveWindProtection,
  WindProtectionStore,
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

  /** @type {WindProtectionStore|null} */
  let windProtection = null;

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
   * Resolves the anemometer height in meters.
   *
   * Preference order: explicit config override, then the Signal K
   * `design.airHeight` path (the standard path for mast height above
   * waterline, where the anemometer typically sits at the masthead), then
   * the built-in default.
   *
   * @returns {number} Anemometer height in meters
   */
  function resolveAnemometerHeight() {
    const cfg = pluginConfig?.windProtection || {};
    if (cfg.anemometerHeightM && cfg.anemometerHeightM > 0) {
      return cfg.anemometerHeightM;
    }
    const airHeight = toNumber(app.getSelfPath("design.airHeight"));
    if (airHeight != null && airHeight > 0) {
      return airHeight;
    }
    return DEFAULT_ANEMOMETER_HEIGHT_M;
  }

  /**
   * Resolves the full Wind Protection Factor context for the vessel's
   * current place and a forecast wind direction.
   *
   * Shared by getWindProtection (which needs only the corrected wind/gusts)
   * and publishWindProtection (which also needs the place/sector/factors for
   * the Signal K paths).
   *
   * @param {number} forecastSpeedKnots - Forecast wind speed in knots
   * @param {number|null} forecastGustKnots - Forecast gust in knots
   * @param {number} windDirectionDeg - Forecast wind direction in degrees
   *   (where the wind comes FROM)
   * @param {number} sunElevationRad - Sun elevation in radians (day/night)
   * @returns {{applies: boolean, placeKey: string|null, sector: number,
   *           night: boolean, speedFactor: number, gustFactor: number,
   *           correctedSpeed: number, correctedGust: number|null}|
   *          {applies: false}}
   */
  function resolveWindProtectionContext(
    forecastSpeedKnots,
    forecastGustKnots,
    windDirectionDeg,
    sunElevationRad,
  ) {
    const disabled = {
      applies: false,
      placeKey: null,
      sector: -1,
      night: false,
      speedFactor: DEFAULT_FACTOR,
      gustFactor: DEFAULT_FACTOR,
      speedSource: SOURCE_NONE,
      gustSource: SOURCE_NONE,
      correctedSpeed: forecastSpeedKnots,
      correctedGust: forecastGustKnots,
    };
    if (!windProtection) return disabled;

    const pos = unwrapPosition(
      deltaState.get("navigation.position") ||
        app.getSelfPath("navigation.position"),
    );
    if (!pos || pos.latitude == null || pos.longitude == null) return disabled;

    const navStateRaw =
      deltaState.get("navigation.state") || app.getSelfPath("navigation.state");
    const navState =
      navStateRaw && typeof navStateRaw === "object"
        ? navStateRaw.value
        : navStateRaw;
    if (
      navState === "sailing" ||
      navState === "motoring" ||
      navState === "under way"
    ) {
      return disabled;
    }

    const cfg = pluginConfig?.windProtection || {};
    const cellSizeM = cfg.cellSizeM ?? 500;
    const deviceHeightM = cfg.deviceHeightM ?? DEFAULT_DEVICE_HEIGHT_M;
    const z0 = cfg.roughnessLength ?? DEFAULT_ROUGHNESS_LENGTH;

    const key =
      wpfState.placeKey ??
      windProtection.resolvePlace(pos.latitude, pos.longitude, cellSizeM);
    const sector = sectorFromDeg(windDirectionDeg);
    const night = wpfIsNight(sunElevationRad);

    // Resolve with the sector fallback: an unlearned bin borrows from a
    // *learned* neighbor (never from a neighbor that is itself a fallback)
    // so a wind shift into an unsampled sector keeps the shelter the user
    // already has, instead of dropping to 1.0 for the whole tail of the
    // forecast. Each factor is resolved independently and scaled only when
    // its source is not "none".
    const {
      speed: speedFactor,
      gust: gustFactor,
      speedSource,
      gustSource,
    } = windProtection.getFactorsWithFallback(key, sector, night, {
      crossBinGustFallback: cfg.crossBinGustFallback === true,
    });

    // No correction of any kind for this place/sector → pass through.
    if (speedSource === SOURCE_NONE && gustSource === SOURCE_NONE) {
      return {
        applies: false,
        placeKey: key,
        sector,
        night,
        speedFactor,
        gustFactor,
        speedSource,
        gustSource,
        correctedSpeed: forecastSpeedKnots,
        correctedGust: forecastGustKnots,
      };
    }

    // Scale at the 10 m reference, then translate down to device height.
    // A factor whose source is "none" stays at 1.0 so it doesn't move the
    // forecast; the other factor (learned or fallback) still applies.
    const speedScale =
      speedSource === SOURCE_NONE ? DEFAULT_FACTOR : speedFactor;
    const gustScale = gustSource === SOURCE_NONE ? DEFAULT_FACTOR : gustFactor;
    const correctedSpeed10m = forecastSpeedKnots * speedScale;
    const correctedGust10m =
      forecastGustKnots != null ? forecastGustKnots * gustScale : null;

    const correctedSpeed = toDeviceHeight(correctedSpeed10m, deviceHeightM, z0);
    const correctedGust =
      correctedGust10m != null
        ? toDeviceHeight(correctedGust10m, deviceHeightM, z0)
        : null;

    // A gust is, by definition, a wind speed peak above the mean — the
    // forecasted gust can never be smaller than the forecasted base wind.
    // The factors can push the corrected gust below the corrected speed
    // (e.g. a small gust factor with a large speed factor, or just forecast
    // rounding), so floor the corrected gust at the corrected speed.
    const flooredGust =
      correctedGust != null ? Math.max(correctedGust, correctedSpeed) : null;

    return {
      applies: true,
      placeKey: key,
      sector,
      night,
      speedFactor,
      gustFactor,
      speedSource,
      gustSource,
      correctedSpeed,
      correctedGust: flooredGust,
    };
  }

  /**
   * Gets wind protection correction for the current place.
   *
   * Returns null when WPF is disabled, the boat is under way, there is no
   * position, or no factor (learned or sector fallback) exists for this
   * place/sector — in all those cases the prediction engine applies no
   * correction (factor 1.0).
   *
   * @param {number} forecastSpeedKnots - Forecast wind speed in knots
   * @param {number|null} forecastGustKnots - Forecast gust in knots
   * @param {number} windDirectionDeg - Forecast wind direction in degrees
   *   (where the wind comes FROM)
   * @param {number} sunElevationRad - Sun elevation in radians (day/night)
   * @returns {{speed: number, gust: number}|null} corrected wind/gusts at
   *   device height, in knots; null means "no correction"
   */
  function getWindProtection(
    forecastSpeedKnots,
    forecastGustKnots,
    windDirectionDeg,
    sunElevationRad,
  ) {
    const ctx = resolveWindProtectionContext(
      forecastSpeedKnots,
      forecastGustKnots,
      windDirectionDeg,
      sunElevationRad,
    );
    if (!ctx.applies) return null;
    return { speed: ctx.correctedSpeed, gust: ctx.correctedGust };
  }

  /**
   * Publishes the current Wind Protection Factor at Signal K paths under
   * `electrical.energy.prediction.windProtection.*` so other consumers and
   * the instrument panel can see the learned correction for this place.
   *
   * Only meaningful at rest with a learned place; under way or with no
   * learned factor the paths are cleared (values set to null) so stale
   * numbers don't linger.
   *
   * @returns {void}
   */
  function publishWindProtection() {
    if (!advisoryPublisher) return;
    const base = "electrical.energy.prediction.windProtection";

    // Resolve the current forecast point (nearest now) for direction + sun
    const forecast = predictionEngine?.lastForecast || [];
    const now = new Date();
    const current = forecast.find(
      (p) => Math.abs(p.time.getTime() - now.getTime()) < 1800000,
    );
    const pos = unwrapPosition(
      deltaState.get("navigation.position") ||
        app.getSelfPath("navigation.position"),
    );

    const updates = {
      [`${base}.enabled`]: windProtection ? true : false,
      [`${base}.placeKey`]: null,
      [`${base}.sector`]: null,
      [`${base}.night`]: null,
      [`${base}.speedFactor`]: null,
      [`${base}.gustFactor`]: null,
      [`${base}.speedFactorSource`]: null,
      [`${base}.gustFactorSource`]: null,
      [`${base}.forecastSpeedKnots`]: null,
      [`${base}.forecastGustKnots`]: null,
      [`${base}.correctedSpeedKnots`]: null,
      [`${base}.correctedGustKnots`]: null,
      [`${base}.position`]: pos || null,
    };

    if (windProtection && current && pos) {
      const { sunPosition } = require("./solar.js");
      const sunPos = sunPosition(now, pos.latitude, pos.longitude);
      const ctx = resolveWindProtectionContext(
        current.windSpeedKnots ?? 0,
        current.gustSpeedKnots ?? null,
        current.windDirectionDeg ?? 0,
        sunPos.altitude,
      );
      if (ctx.placeKey != null) {
        updates[`${base}.placeKey`] = ctx.placeKey;
        updates[`${base}.sector`] = ctx.sector >= 0 ? ctx.sector : null;
        updates[`${base}.night`] = ctx.night;
        updates[`${base}.speedFactor`] = ctx.speedFactor;
        updates[`${base}.gustFactor`] = ctx.gustFactor;
        updates[`${base}.speedFactorSource`] = ctx.speedSource;
        updates[`${base}.gustFactorSource`] = ctx.gustSource;
        updates[`${base}.forecastSpeedKnots`] = current.windSpeedKnots ?? null;
        updates[`${base}.forecastGustKnots`] = current.gustSpeedKnots ?? null;
        updates[`${base}.correctedSpeedKnots`] = ctx.applies
          ? ctx.correctedSpeed
          : null;
        updates[`${base}.correctedGustKnots`] = ctx.applies
          ? ctx.correctedGust
          : null;
      }
    }

    advisoryPublisher.publishDelta(updates);
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
   * Initializes the wind protection factor store from disk.
   *
   * @param {object} config - Plugin configuration
   * @returns {Promise<void>}
   */
  async function initializeWindProtection(config) {
    const wpfConfig = config.windProtection || {};
    if (wpfConfig.enabled === false) {
      windProtection = null;
      app.debug("Wind Protection Factor disabled in config");
      return;
    }

    const dataDir = app.getDataDirPath();
    try {
      const saved = await deps.loadWindProtection(dataDir);
      if (saved) {
        windProtection = deps.WindProtectionStore.fromJSON(saved);
        app.debug(
          `Loaded wind protection store: ${windProtection.sizePlaces} places, ${windProtection.sizeSpeed} speed bins, ${windProtection.sizeGust} gust bins`,
        );
      } else {
        windProtection = new deps.WindProtectionStore({
          alpha: wpfConfig.emaAlpha,
          maxPlaces: wpfConfig.maxPlaces,
          learnGusts: wpfConfig.learnGusts !== false,
          minForecastWindKnots: wpfConfig.minForecastWindKnots,
        });
        app.debug(`No wind protection store found, starting fresh`);
      }
    } catch (error) {
      app.error(`Failed to load wind protection store: ${error.message}`);
      windProtection = new deps.WindProtectionStore({
        alpha: wpfConfig.emaAlpha,
        maxPlaces: wpfConfig.maxPlaces,
        learnGusts: wpfConfig.learnGusts !== false,
        minForecastWindKnots: wpfConfig.minForecastWindKnots,
      });
    }
  }

  /**
   * Loads the last recorded per-device deploy states (carry-forward
   * fallback for the live detection).
   *
   * `runPredictionCycle` rebuilds `currentDeployStates` fresh each cycle
   * from live power + conditions. At night a deployable solar array
   * (FLINsail) naturally produces ~0 W, so neither "power > 0" nor "0 W in
   * daytime" yields a definite state — after a server restart the Map is
   * empty and `detectedState` publishes as `null` even though the array
   * was last known to be, say, "deployed". The 5-minute sample recordings
   * already persist `deployStates` per device, so we recover the last
   * known state per device as a fallback.
   *
   * The most recent sample may lack a device whose state can't be
   * inferred right now (e.g. FLINsail at night), so rather than only reading
   * the single newest sample we walk backwards through the recent samples
   * and take, per device, the most recent definite entry within
   * `SEED_FRESHNESS_MS`. This recovers a device that last produced a
   * definite reading a few hours ago (e.g. the last daytime "deployed"
   * before sunset) without carrying forward indefinitely across a
   * multi-day outage.
   *
   * @returns {Promise<object|null>} `{ deviceId: "deployed"|"stowed" }` or null
   */
  async function getLastDeployStates() {
    if (!recorder) return null;
    try {
      const now = Date.now();
      const from = new Date(now - 2 * 24 * 3600000);
      const to = new Date(now);
      const samples = await recorder.getRecordings(from, to, "sample");
      if (samples.length === 0) return null;
      // Walk newest-first; take the most recent definite state per device
      // within the freshness window. A device absent from the newest sample
      // (e.g. FLINsail at night) is recovered from an earlier sample.
      const result = {};
      const cutoff = now - SEED_FRESHNESS_MS;
      for (let i = samples.length - 1; i >= 0; i--) {
        const s = samples[i];
        const ts = new Date(s.timestamp).getTime();
        if (Number.isNaN(ts) || ts < cutoff) break; // older than freshness
        const states = s.deployStates;
        if (!states || typeof states !== "object") continue;
        for (const [id, state] of Object.entries(states)) {
          if (state === "deployed" || state === "stowed") {
            if (result[id] == null) result[id] = state;
          }
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    } catch (error) {
      app.debug(`getLastDeployStates: failed (${error.message})`);
      return null;
    }
  }

  /**
   * Seeds deltaState with the last-known sticky signals (navigation.state,
   * navigation.position) from the most recent sample recording.
   *
   * On a fresh server start, deltaState is empty and signalk-autostate may
   * not have published navigation.state yet, so the first prediction cycle
   * would read "unknown" — producing "vessel nav state unknown" wind-gen
   * recommendations and skipping WPF application. The last recorded sample
   * carries the carried-forward sticky state from before the restart.
   *
   * Only seeds if the server (app.getSelfPath) does not already have a
   * current value, so we never override a live reading.
   *
   * @returns {Promise<void>}
   */
  async function seedStickyStateFromRecordings() {
    if (!recorder) return;
    try {
      const now = Date.now();
      // Look back up to 2 days for the most recent sample
      const from = new Date(now - 2 * 24 * 3600000);
      const to = new Date(now);
      const samples = await recorder.getRecordings(from, to, "sample");
      if (samples.length === 0) {
        app.debug("seedStickyState: no recent samples found, skipping seed");
        return;
      }
      const last = samples[samples.length - 1];
      // Seed navState only if the server doesn't have it
      if (
        last.navState &&
        last.navState !== "unknown" &&
        !deltaState.has("navigation.state")
      ) {
        const serverNav = app.getSelfPath("navigation.state");
        const serverNavVal =
          serverNav && typeof serverNav === "object"
            ? serverNav.value
            : serverNav;
        if (!serverNavVal) {
          deltaState.set("navigation.state", last.navState);
          app.debug(
            `seedStickyState: seeded navigation.state = ${last.navState} from sample at ${last.timestamp}`,
          );
        }
      }
      // Seed position only if the server doesn't have it
      if (
        last.position &&
        last.position.latitude != null &&
        !deltaState.has("navigation.position")
      ) {
        const serverPos = app.getSelfPath("navigation.position");
        const serverPosVal =
          serverPos && typeof serverPos === "object"
            ? (serverPos.value ?? serverPos)
            : serverPos;
        if (!serverPosVal) {
          deltaState.set("navigation.position", last.position);
          app.debug(
            `seedStickyState: seeded navigation.position from sample at ${last.timestamp}`,
          );
        }
      }
    } catch (error) {
      app.debug(`seedStickyState: failed (${error.message})`);
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

      // Add load-profile learned bins so the flat-fallback vs learned-bin
      // state is visible (predicted house load is flat until bins pass the
      // min-days gate)
      const learnedBins = predictionEngine?.loadProfile?.learnedBins?.() ?? [];
      if (learnedBins.length > 0) {
        status += ` Load: ${learnedBins.length} bins`;
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

      // navigation.state drives WPF application (only at rest) and deploy
      // recommendations (can't deploy while under way or when state is
      // unknown). signalk-autostate derives it from GPS movement shortly
      // after position arrives; until it's known, skip the prediction
      // output but keep the forecast cached (the learning cycle's GHI
      // lookup depends on it).
      const navState = predictionEngine
        ? predictionEngine.getNavState()
        : "unknown";
      if (navState === "unknown") {
        app.debug(
          "Prediction output skipped: navigation.state unknown yet (forecast cached)",
        );
        return;
      }
      const underway =
        navState === "sailing" ||
        navState === "motoring" ||
        navState === "under way";

      // Recover the last known deploy states from the most recent sample
      // recording as a carry-forward fallback. At night a deployable solar
      // array produces ~0 W, so the live inference below yields null and a
      // fresh-restart Map would publish `detectedState: null` even though
      // the array was last known to be deployed/stowed. The seeded entries
      // are only a fallback: every definite live inference below overwrites
      // them, and entries the live inference leaves null keep the seed.
      const seededDeployStates = await getLastDeployStates();
      const seededDeployStateIds = new Set();
      const currentDeployStates = new Map();
      if (seededDeployStates) {
        for (const [id, state] of Object.entries(seededDeployStates)) {
          if (state === "deployed" || state === "stowed") {
            currentDeployStates.set(id, state);
            seededDeployStateIds.add(id);
          }
        }
      }
      for (const array of getActiveSolarArrays(pluginConfig)) {
        if (array.deployStatePath) {
          const val = deltaState.get(array.deployStatePath);
          const sensorState = normalizeDeployState(val);
          if (sensorState != null) {
            currentDeployStates.set(array.id, sensorState);
            seededDeployStateIds.delete(array.id);
          }
        }
        // For deployable solar arrays, infer from power output during daytime
        if (array.type === "deployable" && array.powerPath) {
          const powerVal = toNumber(deltaState.get(array.powerPath));
          if (powerVal != null && powerVal > 0) {
            currentDeployStates.set(array.id, "deployed");
            seededDeployStateIds.delete(array.id);
          }
          // No solar output during daytime means array is stowed
          if (powerVal != null && powerVal === 0) {
            const pos = unwrapPosition(
              deltaState.get("navigation.position") ||
                app.getSelfPath("navigation.position"),
            );
            if (pos && pos.latitude != null) {
              const { sunPosition } = require("./solar.js");
              const sunPos = sunPosition(
                new Date(),
                pos.latitude,
                pos.longitude ?? 0,
              );
              if (sunPos.altitude > 0) {
                currentDeployStates.set(array.id, "stowed");
                seededDeployStateIds.delete(array.id);
              }
            }
          }
        }
        // FLINsail stowed when underway ONLY if not producing power.
        // A deployable panel that is outputting watts IS deployed — the
        // owner may motor 150 m to a fuel dock with panels up. Only when
        // there is no power evidence do we infer stowed from being underway.
        if (array.type === "deployable" && underway) {
          const powerVal =
            array.powerPath != null
              ? toNumber(deltaState.get(array.powerPath))
              : null;
          if (!(powerVal != null && powerVal > 0)) {
            currentDeployStates.set(array.id, "stowed");
            seededDeployStateIds.delete(array.id);
          }
        }
      }
      for (const gen of getActiveGenerators(pluginConfig)) {
        if (gen.deployStatePath) {
          const val = deltaState.get(gen.deployStatePath);
          const sensorState = normalizeDeployState(val);
          if (sensorState != null) {
            currentDeployStates.set(gen.id, sensorState);
            seededDeployStateIds.delete(gen.id);
          }
        }
        // For deployable generators, infer from power output
        if (gen.deployable && gen.powerPath) {
          const powerVal = toNumber(deltaState.get(gen.powerPath));
          if (powerVal != null && powerVal > 0) {
            currentDeployStates.set(gen.id, "deployed");
            seededDeployStateIds.delete(gen.id);
          }
        }
        // Wind generator: if there is wind but no power output, it is stowed.
        // Runs even when a seed is present: a definite live "stowed" reading
        // overwrites the carried-forward state; no wind evidence leaves the
        // seed in place.
        if (gen.deployable && gen.type === "wind") {
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
            seededDeployStateIds.delete(gen.id);
          }
        }
        // Hydro is stowed when not sailing
        if (gen.deployable && gen.type === "hydro" && navState !== "sailing") {
          currentDeployStates.set(gen.id, "stowed");
          seededDeployStateIds.delete(gen.id);
        }
        // Hydro: if sailing above min speed but no power output, it is stowed.
        // Runs even when a seed is present (definite live reading wins).
        if (gen.deployable && gen.type === "hydro") {
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
            seededDeployStateIds.delete(gen.id);
          }
        }
        // Wind generators stowed when underway ONLY if not producing
        // power. A wind generator spinning and charging while motoring
        // (e.g. a short hop) IS deployed.
        if (gen.deployable && gen.type === "wind" && underway) {
          const powerVal =
            gen.powerPath != null
              ? toNumber(deltaState.get(gen.powerPath))
              : null;
          if (!(powerVal != null && powerVal > 0)) {
            currentDeployStates.set(gen.id, "stowed");
            seededDeployStateIds.delete(gen.id);
          }
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

      // Find a surplus-energy opportunity (battery forecast full while
      // yield continues — watermaker/ice-maker case; motoring side-effect).
      // Day/night gated: under way alerts any hour (watchkeeper on duty),
      // at rest only during daytime.
      const surplusConfig = pluginConfig.surplus || {};
      const surplusOpportunity =
        surplusConfig.enabled === false
          ? null
          : predictionEngine.findSurplusOpportunity({
              fullThreshold: surplusConfig.fullThreshold,
              minSurplusWh: surplusConfig.minSurplusWh,
              maxLeadHours: surplusConfig.maxLeadHours,
            });

      // Get unified deployment recommendations for all deployable systems
      const deploymentRecommendations =
        predictionEngine.getDeploymentRecommendations();

      // Day/night and navigation-state context for urgency-aware
      // notifications. At night, deployables use visual-only and at-rest
      // non-urgent activity suggestions are held for the morning.
      let isNight = false;
      const posForNight = unwrapPosition(
        deltaState.get("navigation.position") ||
          app.getSelfPath("navigation.position"),
      );
      if (posForNight && posForNight.latitude != null) {
        const sunPos = sunPosition(
          new Date(),
          posForNight.latitude,
          posForNight.longitude ?? 0,
        );
        isNight = wpfIsNight(sunPos.altitude);
      }

      // Per-device state confidence for urgency. A positive power reading
      // or a sensor-provided state is HIGH confidence; an inferred stowed
      // state is MEDIUM; a state recovered from the last recording as a
      // carry-forward fallback (live inference yielded null, e.g. at night)
      // is LOW; a genuinely-unknown state with no history is NONE (worst
      // case — assume deployed).
      const deployConfidences = new Map();
      for (const rec of deploymentRecommendations) {
        const state = currentDeployStates.get(rec.id) ?? null;
        if (seededDeployStateIds.has(rec.id)) {
          // Carried forward from the last recording: stale but not unknown.
          deployConfidences.set(rec.id, StateConfidence.LOW);
        } else if (state === "deployed") {
          // Deployed inference is only set from positive power / sensor —
          // both are HIGH confidence.
          deployConfidences.set(rec.id, StateConfidence.HIGH);
        } else if (state === "stowed") {
          // Stowed is inferred (no power + conditions favourable) — MEDIUM.
          deployConfidences.set(rec.id, StateConfidence.MEDIUM);
        } else {
          // Unknown: worst case for urgency (assume deployed).
          deployConfidences.set(rec.id, StateConfidence.NONE);
        }
      }

      // Publish all advisories
      app.debug("Publishing advisories...");
      // Render human-facing notification times in solar-local time
      // derived from the vessel's longitude, so a UTC-locked server still
      // surfaces crew-local clock times. Falls back to the host timezone
      // when longitude is unknown. Reused for the recorded advisory
      // messages below.
      const solarOffsetMinutes = solarOffsetMinutesFromLongitude(
        ingestionFSM.position.longitude,
      );
      advisoryPublisher.publishAll({
        hourlyForecast: hourly,
        timeToFull,
        timeToEmpty,
        stowageOpportunity,
        engineRunTime,
        surplusOpportunity,
        opportunisticLoads: surplusConfig.opportunisticLoads || [],
        deploymentRecommendations,
        currentDeployStates,
        isNight,
        isUnderway: underway,
        deployConfidences,
        batterySoC: predictionEngine.getCurrentSoC(),
        localOffsetMinutes: solarOffsetMinutes,
        urgencyConfig: pluginConfig.notification?.urgency,
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
        // Record the surplus/deficit/stowage advisories computed for this
        // cycle so the webapp's Events list can surface them per window.
        // Mirrors the messages broadcast as Signal K notifications above.
        advisories: buildCycleAdvisories({
          surplusOpportunity,
          engineRunTime,
          stowageOpportunity,
          opportunisticLoads: surplusConfig.opportunisticLoads || [],
          isLoadRunning: (load) => advisoryPublisher.isLoadRunning(load),
          localOffsetMinutes: solarOffsetMinutes,
        }),
      });

      app.debug(`Prediction cycle complete: ${hourly.length} hours forecasted`);

      // Publish the current Wind Protection Factor at its own Signal K
      // path so other consumers and the instrument panel can see the
      // learned correction for this place. Only meaningful at rest; under
      // way the paths are cleared (no correction).
      publishWindProtection();

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

    // Save wind protection store
    if (windProtection) {
      try {
        await deps.saveWindProtection(dataDir, windProtection.toJSON());
        app.debug(
          `Saved wind protection store: ${windProtection.sizePlaces} places`,
        );
      } catch (error) {
        app.error(`Failed to save wind protection store: ${error.message}`);
      }
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
   * Last known detected deploy state per device, carried forward across
   * null (unknown) inference gaps. At night a deployable solar array
   * produces ~0 W so the per-sample inference yields null; without
   * carry-forward the 5-minute recordings would lose the pre-sunset state,
   * and a restart's recovery window would find no state to seed. We keep
   * the last known state here and write it into every recorded sample so
   * the recordings (and thus the restart seed) reflect the carried-forward
   * state rather than the raw per-sample inference.
   */
  const lastKnownDeployStates = new Map();

  /**
   * Wind Protection Factor learning state.
   *
   * Tracks the place the boat is currently resting in and when it arrived,
   * so learning only starts after the configured dwell time (excluding
   * arrival maneuvers). Reset whenever the boat leaves the resting state
   * or moves to a different place cell.
   */
  const wpfState = {
    /** @type {string|null} place key resolved at anchor-drop */
    placeKey: null,
    /** @type {number|null} timestamp (ms) the boat settled in this place */
    arrivedAt: null,
    /** @type {number|null} last WPF learning tick (ms), throttled */
    lastLearn: 0,
  };
  const WPF_LEARN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Delay before the first prediction cycle at startup, so
   * signalk-autostate has time to derive and publish navigation.state.
   * Without a known nav state the prediction is skipped (WPF only applies
   * at rest, and deploy recommendations need a known state).
   */
  const INITIAL_PREDICTION_DELAY_MS = 10 * 1000; // 10 seconds

  /**
   * Maximum age of a recorded sample whose deploy states are trusted as a
   * carry-forward fallback after a restart. Samples older than this are
   * ignored (the device may have changed state since), so a stale value
   * from a multi-day outage is not carried forward indefinitely. Six hours
   * covers a night-time restart (the common case: solar produces ~0 W at
   * night so the live inference yields null) while bounding staleness.
   */
  const SEED_FRESHNESS_MS = 6 * 60 * 60 * 1000; // 6 hours

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
            // Sticky signals (navigation.state, propulsion.*.state,
            // navigation.position) persist until a new value arrives: an
            // empty/null update (some providers emit "" when the source drops
            // out) must not clear a previously known value. Carry the last
            // valid value forward until a real new value arrives.
            const sticky =
              v.path === "navigation.state" ||
              v.path === "navigation.position" ||
              PROPULSION_STATE_RE.test(v.path);
            // Sticky signals persist until a real new value arrives: an
            // empty/null update (some providers emit "" when the source
            // drops out) must never clear or initialize a sticky value,
            // otherwise downstream `?? app.getSelfPath(...)` falls through
            // to the (wrapped) server value while `deltaState` holds "".
            if (sticky && (v.value == null || v.value === "")) {
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

            // Mirror uplink status into the ingestion FSM and trigger a
            // forecast fetch on the offline→online edge (work doc #15
            // update #1). Internet online = `network.internet.state` is
            // `online` or `metered`.
            if (ingestionFSM && v.path === "network.internet.state") {
              const becameOnline = ingestionFSM.setUplinkStatus({
                internet:
                  deltaState.get("network.internet.state") ??
                  app.getSelfPath("network.internet.state"),
              });
              if (becameOnline) {
                app.debug("Uplink came online — triggering forecast fetch");
                runPredictionCycle().catch((error) => {
                  app.error(
                    `Uplink-online prediction cycle error: ${error.message}`,
                  );
                });
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

      // Wind Protection Factor learning: triggered by any wind reading
      // (speed, gust, or direction) while at rest. Throttled and
      // dwell-gated inside the learning function itself.
      const wpfConfig = pluginConfig?.windProtection;
      if (wpfConfig?.enabled !== false && ingestionFSM && windProtection) {
        const sawWind = delta.updates?.some((u) =>
          u.values?.some((v) => v.path.startsWith("environment.wind.")),
        );
        if (sawWind) {
          runWindProtectionLearning().catch((error) => {
            app.error(`Wind protection learning error: ${error.message}`);
          });
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

      // Resolve position once: needed both for the night gate below and
      // for the per-array sun position in the loop. Resolving it here (vs.
      // per-array inside the loop) avoids 5x duplicate work and lets us
      // short-circuit the whole cycle at night before fetching GHI or
      // iterating arrays. At night the sun is below the horizon, GHI is 0,
      // and every panel reads 0W — there is nothing to learn, so running
      // the cycle just emits a wall of "skipping" debug lines per delta.
      const pos = unwrapPosition(
        deltaState.get("navigation.position") ||
          app.getSelfPath("navigation.position"),
      );
      if (!pos || pos.latitude == null || pos.longitude == null) {
        app.debug("No GPS position, skipping learning cycle");
        return;
      }

      // Night gate: skip the whole cycle when the sun is at or below the
      // horizon. theoreticalPower() already returns 0 then and the
      // per-array `actualPowerW <= 0` guard would skip every array anyway,
      // but computing that requires fetching GHI and iterating all arrays —
      // pure noise on a cycle that fires on every solar-power delta.
      const sunPos = sunPosition(new Date(), pos.latitude, pos.longitude);
      if (wpfIsNight(sunPos.altitude)) {
        app.debug(
          `Sun below horizon (${((sunPos.altitude * 180) / Math.PI).toFixed(1)}°), skipping learning cycle`,
        );
        return;
      }

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
        navStateRaw && typeof navStateRaw === "object"
          ? navStateRaw.value
          : navStateRaw;
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
   * Runs one Wind Protection Factor learning pass: compares measured wind
   * (height-normalized to the 10 m forecast reference) against the current
   * forecast for this hour and updates the per-place/per-sector EMA.
   *
   * Only learns while at rest (anchored or moored) and only after the boat
   * has dwelled in the current place cell for the configured dwell time,
   * so arrival maneuvers don't contaminate the factor. Under way, no
   * learning and no application (getWindProtection returns null).
   *
   * @returns {Promise<void>}
   */
  async function runWindProtectionLearning() {
    if (!windProtection || !ingestionFSM) return;

    const cfg = pluginConfig?.windProtection || {};

    // Only learn at rest
    const navStateRaw =
      deltaState.get("navigation.state") || app.getSelfPath("navigation.state");
    const navState =
      navStateRaw && typeof navStateRaw === "object"
        ? navStateRaw.value
        : navStateRaw;
    if (navState !== "anchored" && navState !== "moored") {
      wpfState.placeKey = null;
      wpfState.arrivedAt = null;
      return;
    }

    // Throttle: don't learn more often than the WPF interval
    const now = Date.now();
    if (now - wpfState.lastLearn < WPF_LEARN_INTERVAL_MS) {
      return;
    }

    // Resolve position
    const pos = unwrapPosition(
      deltaState.get("navigation.position") ||
        app.getSelfPath("navigation.position"),
    );
    if (!pos || pos.latitude == null || pos.longitude == null) {
      return;
    }

    const cellSizeM = cfg.cellSizeM ?? 500;

    // Resolve the anchorage for the current position. resolvePlace matches
    // to the nearest known anchorage within the match radius, so a swing
    // on the anchor (or a nearby re-drop on a revisit) keeps the same key,
    // while a real relocation within a continuous at-rest session (e.g.
    // motoring into a marina, state flipping to moored early, then moving
    // to the slip 1.5 km away) resolves to a different key and restarts
    // the dwell window.
    const key = windProtection.resolvePlace(
      pos.latitude,
      pos.longitude,
      cellSizeM,
    );

    // Dwell gating: reset when the resolved place changes (the boat moved
    // to a different anchorage); only learn after the boat has been at this
    // anchorage long enough to exclude maneuvers and settle on the rode.
    const dwellMinutes = cfg.dwellMinutes ?? 15;
    if (wpfState.placeKey !== key) {
      wpfState.placeKey = key;
      wpfState.arrivedAt = now;
      app.debug(
        `WPF: at anchorage ${key} (${navState}), dwelling ${dwellMinutes}min before learning`,
      );
      return;
    }
    if (
      wpfState.arrivedAt == null ||
      now - wpfState.arrivedAt < dwellMinutes * 60000
    ) {
      return;
    }

    // Resolve measured wind. Preference chain (mirrors the rest of the
    // plugin): true wind first (at anchor apparent≈true, but current can
    // bias apparent wind, so true is preferred), then over-ground, then
    // apparent. All converted to knots.
    const measuredSpeedKnots =
      toKnots(
        deltaState.get("environment.wind.speedTrue") ||
          app.getSelfPath("environment.wind.speedTrue"),
      ) ??
      toKnots(
        deltaState.get("environment.wind.speedOverGround") ||
          app.getSelfPath("environment.wind.speedOverGround"),
      ) ??
      toKnots(
        deltaState.get("environment.wind.speedApparent") ||
          app.getSelfPath("environment.wind.speedApparent"),
      );
    if (measuredSpeedKnots == null) return;

    // Measured gust: there is no environment.wind.gust sensor on this
    // vessel, so the gust is taken as the max of recent wind speed
    // samples (mirroring signalk-meshtastic, which reports windGust as the
    // max of its speedOverGround sample window). We use the rolling
    // windHistory buffer across all wind speed paths, limited to a gust
    // window comparable to a forecast gust.
    const allWindHistory = [
      ...(windHistory.get("environment.wind.speedTrue") || []),
      ...(windHistory.get("environment.wind.speedOverGround") || []),
      ...(windHistory.get("environment.wind.speedApparent") || []),
    ];
    const gustWindowSamples = allWindHistory.filter(
      (s) => s.time >= now - WIND_HISTORY_MS,
    );
    const measuredGustKnots =
      gustWindowSamples.length >= 2
        ? Math.max(...gustWindowSamples.map((s) => s.speed))
        : null;

    // Forecast for the current hour: fetch (cached, fresh) and find the
    // point nearest now
    let forecast;
    try {
      forecast = await ingestionFSM.getForecast();
    } catch (error) {
      app.debug(`WPF: forecast unavailable, skipping: ${error.message}`);
      return;
    }
    const current = forecast.find(
      (p) => Math.abs(p.time.getTime() - now) < 1800000, // within 30 min
    );
    if (!current) return;

    const forecastSpeed = current.windSpeedKnots;
    const forecastGust = current.gustSpeedKnots;
    const windDirectionDeg = current.windDirectionDeg;
    if (forecastSpeed == null) return;

    // Height-normalize the measured reading from anemometer height to the
    // 10 m forecast reference before taking the ratio, so the factor
    // reflects place shelter rather than the masthead→10m offset
    const anemometerHeightM = resolveAnemometerHeight();
    const z0 = cfg.roughnessLength ?? DEFAULT_ROUGHNESS_LENGTH;
    const measuredSpeed10m = toForecastReference(
      measuredSpeedKnots,
      anemometerHeightM,
      z0,
    );
    const measuredGust10m =
      measuredGustKnots != null
        ? toForecastReference(measuredGustKnots, anemometerHeightM, z0)
        : null;

    // Day/night bin from the sun elevation at the vessel
    const { sunPosition } = require("./solar.js");
    const sunPos = sunPosition(new Date(now), pos.latitude, pos.longitude);
    const night = wpfIsNight(sunPos.altitude);

    const sector = sectorFromDeg(windDirectionDeg);

    const updated = windProtection.learn({
      placeKey: wpfState.placeKey,
      sector,
      night,
      measuredSpeed: measuredSpeed10m,
      forecastSpeed,
      measuredGust: measuredGust10m,
      forecastGust,
    });

    wpfState.lastLearn = now;
    if (updated) {
      // Pull the post-update factors so the record shows the learned
      // state of this place/sector after absorbing this observation
      const { speed: speedFactor, gust: gustFactor } =
        windProtection.getFactors(wpfState.placeKey, sector, night);
      app.debug(
        `WPF: learned ${wpfState.placeKey} sector ${sector} ${night ? "night" : "day"}: measured ${measuredSpeed10m.toFixed(1)}kn vs forecast ${forecastSpeed.toFixed(1)}kn (dir ${windDirectionDeg != null ? Math.round(windDirectionDeg) : "?"}°) → speed×${speedFactor.toFixed(2)} gust×${gustFactor.toFixed(2)}`,
      );

      // Record the observation so past anchorage wind protection is
      // queryable later (timeline webapp + offline backfill material)
      if (recorder) {
        await recorder.recordWindProtection({
          timestamp: new Date(now),
          placeKey: wpfState.placeKey,
          sector,
          night,
          measuredSpeedKnots: measuredSpeed10m,
          forecastSpeedKnots: forecastSpeed,
          measuredGustKnots: measuredGust10m,
          forecastGustKnots: forecastGust,
          windDirectionDeg: windDirectionDeg ?? null,
          speedFactor,
          gustFactor,
          position: { latitude: pos.latitude, longitude: pos.longitude },
          navState: navState,
          anemometerHeightM,
        });
      }
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
    const navStateRaw =
      deltaState.get("navigation.state") || app.getSelfPath("navigation.state");
    const navState =
      navStateRaw && typeof navStateRaw === "object"
        ? navStateRaw.value
        : navStateRaw || "unknown";

    // Get position
    const position = unwrapPosition(
      deltaState.get("navigation.position") ||
        app.getSelfPath("navigation.position"),
    );

    // Get speed through water (for hydro generator prediction)
    const stwKnots =
      toKnots(
        deltaState.get("navigation.speedThroughWater") ||
          app.getSelfPath("navigation.speedThroughWater"),
      ) || null;

    // Compute detected deploy/stow states for deployable devices using the
    // shared inference (same logic as runPredictionCycle's
    // currentDeployStates, but per-sample for persistence). Carry-forward
    // of the last known state across unknown (null) gaps is applied here so
    // the recording reflects the carried-forward state: a night-time sample
    // (0 W, sun down) keeps the last known deploy state instead of dropping
    // it, so a restart's recovery window can reseed it.
    const underway =
      navState === "sailing" ||
      navState === "motoring" ||
      navState === "under way";
    let sunUp = false;
    if (position && position.latitude != null) {
      const { sunPosition } = require("./solar.js");
      // Only treat 0 W as "stowed" when the sun is high enough that a
      // deployed panel would produce power. Near sunrise/sunset a deployed
      // panel naturally reads ~0 W.
      sunUp =
        sunPosition(new Date(), position.latitude, position.longitude ?? 0)
          .altitude > STOW_INFERENCE_MIN_SUN_ALT_RAD;
    }
    const deployStates = {};
    for (const array of getActiveSolarArrays(pluginConfig)) {
      if (array.type !== "deployable") continue;
      const powerW =
        array.powerPath != null
          ? toNumber(
              deltaState.get(array.powerPath) ||
                app.getSelfPath(array.powerPath),
            )
          : null;
      const deployStateRaw =
        array.deployStatePath != null
          ? deltaState.get(array.deployStatePath) ||
            app.getSelfPath(array.deployStatePath)
          : null;
      const state = detectSolarArrayState(array, {
        powerW,
        deployStateRaw,
        sunUp,
        underway,
      });
      if (state != null) {
        deployStates[array.id] = state;
        lastKnownDeployStates.set(array.id, state);
      } else if (lastKnownDeployStates.has(array.id)) {
        deployStates[array.id] = lastKnownDeployStates.get(array.id);
      }
    }
    for (const gen of getActiveGenerators(pluginConfig)) {
      if (!gen.deployable) continue;
      const powerW =
        gen.powerPath != null
          ? toNumber(
              deltaState.get(gen.powerPath) || app.getSelfPath(gen.powerPath),
            )
          : null;
      const deployStateRaw =
        gen.deployStatePath != null
          ? deltaState.get(gen.deployStatePath) ||
            app.getSelfPath(gen.deployStatePath)
          : null;
      const state = detectGeneratorState(gen, {
        powerW,
        deployStateRaw,
        windKnots: windSpeedKnots,
        stwKnots,
        navState,
        underway,
      });
      if (state != null) {
        deployStates[gen.id] = state;
        lastKnownDeployStates.set(gen.id, state);
      } else if (lastKnownDeployStates.has(gen.id)) {
        deployStates[gen.id] = lastKnownDeployStates.get(gen.id);
      }
    }

    // Per-array charge controller modes (for the learning sanitization gate).
    // Recorded so offline backfill/eval can drop non-bulk ticks — the SoC
    // gate alone is unreliable because the shunt SoC drifts.
    const controllerModes = {};
    for (const array of getActiveSolarArrays(pluginConfig)) {
      if (!array.controllerModePath) continue;
      const modeRaw =
        deltaState.get(array.controllerModePath) ||
        app.getSelfPath(array.controllerModePath);
      const mode =
        modeRaw && typeof modeRaw === "object" ? modeRaw.value : modeRaw;
      if (mode != null) controllerModes[array.id] = mode;
    }

    // Apparent wind angle (sailing matrix input). Recorded so the sailing
    // bins can be validated against actuals offline. Stored in radians to
    // match the learning matrix API.
    const awaRaw =
      deltaState.get("environment.wind.angleApparent") ||
      app.getSelfPath("environment.wind.angleApparent");
    const awaRad = toNumber(
      awaRaw && typeof awaRaw === "object" ? awaRaw.value : awaRaw,
    );

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
      deployStates,
      controllerModes,
      awaRad,
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
        forecastCacheHours: config.weather?.forecastCacheHours,
        dataDir: app.getDataDirPath(),
      });
      advisoryPublisher = new deps.AdvisoryPublisher(app, plugin.id);
      // Publish metadata (units, labels, descriptions) for the paths this
      // plugin emits, once at startup. Per-device deployment meta is emitted
      // for each configured deployable device.
      const metaDevices = [
        ...getActiveSolarArrays(config).map((a) => ({
          id: a.id,
          type: "solar-deployable",
        })),
        ...getActiveGenerators(config).map((g) => ({
          id: g.id,
          type: "mechanical",
        })),
      ];
      advisoryPublisher.sendMeta(metaDevices);

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
        getWindProtection,
        getDisplayName,
        app,
        loadProfileConfig: config.loadProfile || {},
        windProtectionConfig: config.windProtection || {},
        predictionHours: config.weather?.forecastHours,
      });

      await initializeLoadProfile();
      await initializeWindProtection(config);

      // Seed deltaState with the last-known sticky signals (nav state,
      // position) from the most recent recording so the first prediction
      // cycle (10 s from now) doesn't read "unknown" before a
      // signalk-autostate delta has arrived. Sticky signals persist until a
      // real new value arrives, so a fresh server start would otherwise
      // lose the carried-forward state the plugin had before the restart.
      // app.getSelfPath may also be empty if autostate hasn't published yet.
      await seedStickyStateFromRecordings(config);

      // Seed the in-memory carry-forward for detected deploy states from
      // the most recent sample recording, so the post-restart 5-minute
      // samples continue the carried-forward chain (a night-time sample
      // with no live evidence keeps the last known state). Without this,
      // a restart at night would lose the chain until the next definite
      // (daytime) reading.
      const seededDeploy = await getLastDeployStates();
      if (seededDeploy) {
        for (const [id, state] of Object.entries(seededDeploy)) {
          if (state === "deployed" || state === "stowed") {
            lastKnownDeployStates.set(id, state);
          }
        }
      }

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

      // Run initial prediction after a short delay so signalk-autostate
      // (which derives navigation.state from GPS movement) has had time to
      // start and publish. Without nav state the prediction would be
      // skipped (WPF only applies at rest, deploy recommendations need a
      // known state) and the first cycle would emit nothing useful.
      app.debug(
        `Scheduling initial prediction in ${INITIAL_PREDICTION_DELAY_MS}ms...`,
      );
      setTimeout(() => {
        runPredictionCycle().catch((error) => {
          app.error(`Initial prediction cycle error: ${error.message}`);
        });
      }, INITIAL_PREDICTION_DELAY_MS);

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
        getWindProtection: () => windProtection,
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
    resolveWindProtectionContext,
    publishWindProtection,
    buildCycleAdvisories,
    get windProtection() {
      return windProtection;
    },
    get learningCycleCount() {
      return learningCycleCount;
    },
  });

  // Export dependencies for testing
  plugin.deps = deps;

  return plugin;
};
