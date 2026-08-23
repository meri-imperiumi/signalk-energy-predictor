/**
 * Advisory publisher for Signal K deltas and notifications.
 *
 * Broadcasts actionable energy advisories to the Signal K tree.
 *
 * @file advisory.js
 */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */

const { formatWh } = require("./format.js");

/**
 * FLINsail deployment advisory states.
 * @enum {string}
 */
const DeployState = {
  NORMAL: "normal",
  ALERT: "alert",
  WARN: "warn",
};

/**
 * Advisory types.
 * @enum {string}
 */
const AdvisoryType = {
  STOW_NOW: "stow_now",
  STOW_SOON: "stow_soon",
  DEPLOY_NOW: "deploy_now",
  DEPLOY_SOON: "deploy_soon",
  ENGINE_RUN: "engine_run",
  TIME_TO_FULL: "time_to_full",
  TIME_TO_EMPTY: "time_to_empty",
  DEPLOY_INFO: "deploy_info",
};

/**
 * Base path for energy prediction in Signal K tree.
 */
const PREDICTION_BASE = "electrical.energy.prediction";

/**
 * Base path for notifications.
 */
const NOTIFICATIONS_BASE = "notifications.electrical.energy";

/**
 * Minimum time between notifications for the same system (milliseconds).
 */
const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Advisory publisher.
 */
class AdvisoryPublisher {
  /**
   * @param {ServerAPI} app - Signal K server API
   */
  constructor(app, pluginId = "signalk-energy-predictor") {
    this.app = app;
    this.pluginId = pluginId;
    this.lastAdvisories = new Map(); // Tracks last advisory to avoid duplicates
    this.activeNotifications = new Map(); // Tracks active notification states
    this.debounceTimers = new Map(); // Per-system debounce timers
    this.lastNotificationTimes = new Map(); // When each system was last notified
  }

  /**
   * Publishes a delta to the Signal K tree.
   *
   * @param {object} updates - Updates to publish
   * @param {string} source - Source identifier
   * @returns {void}
   */
  publishDelta(updates, source = "energy-predictor") {
    const delta = {
      context: `vessels.${this.app.selfId}`,
      updates: [
        {
          source: {
            label: this.pluginId,
          },
          timestamp: new Date().toISOString(),
          values: Object.entries(updates).map(([path, value]) => ({
            path,
            value,
          })),
        },
      ],
    };

    this.app.handleMessage(this.pluginId, delta);
  }

  /**
   * Publishes metadata (units, display name, description) for the Signal K
   * paths this plugin emits, so consumers and instrument panels can render
   * them with correct units and labels.
   *
   * Mirrors the `sendMeta` pattern from signalk-meshtastic: emitted once at
   * startup. Per-device deployment paths are emitted for each configured
   * device so their meta resolves to concrete paths.
   *
   * @param {Array<{id: string, type: string}>} [devices=[]] - Configured deployable devices to emit deployment meta for
   * @returns {void}
   */
  sendMeta(devices = []) {
    const meta = [
      {
        path: `${PREDICTION_BASE}.forecast.hourly`,
        value: {
          displayName: "Hourly energy forecast",
          description:
            "Predicted energy per hour for the configured forecast horizon. Each entry is an object with ideal/detected yield (Wh), house load (Wh), net energy (Wh) and state of charge per hour.",
        },
      },
      {
        path: `${PREDICTION_BASE}.timeToFull`,
        value: {
          displayName: "Time to full",
          description:
            "Predicted time when the battery will be fully charged, or null",
          units: "timestamp",
        },
      },
      {
        path: `${PREDICTION_BASE}.timeToEmpty`,
        value: {
          displayName: "Time to empty",
          description:
            "Predicted time when the battery will be depleted, or null",
          units: "timestamp",
        },
      },
      {
        path: `${PREDICTION_BASE}.windProtection.enabled`,
        value: {
          displayName: "Wind protection enabled",
          description: "Whether wind protection factor correction is active",
        },
      },
      {
        path: `${PREDICTION_BASE}.windProtection.placeKey`,
        value: {
          displayName: "Wind protection place",
          description:
            "Learned place key the current wind protection factor applies to",
        },
      },
      {
        path: `${PREDICTION_BASE}.windProtection.sector`,
        value: {
          displayName: "Wind protection sector",
          description: "Apparent wind sector bin the current factor applies to",
          units: "deg",
        },
      },
      {
        path: `${PREDICTION_BASE}.windProtection.night`,
        value: {
          displayName: "Wind protection night",
          description:
            "Whether the current wind protection factor is the night-time variant",
        },
      },
      {
        path: `${PREDICTION_BASE}.windProtection.speedFactor`,
        value: {
          displayName: "Wind protection speed factor",
          description:
            "Multiplier applied to forecast wind speed for the current place and sector",
          units: "ratio",
        },
      },
      {
        path: `${PREDICTION_BASE}.windProtection.gustFactor`,
        value: {
          displayName: "Wind protection gust factor",
          description:
            "Multiplier applied to forecast wind gust for the current place and sector",
          units: "ratio",
        },
      },
      {
        path: `${PREDICTION_BASE}.windProtection.forecastSpeedKnots`,
        value: {
          displayName: "Forecast wind speed",
          description:
            "Raw forecast wind speed at the current position before wind protection correction",
          units: "knots",
        },
      },
      {
        path: `${PREDICTION_BASE}.windProtection.forecastGustKnots`,
        value: {
          displayName: "Forecast wind gust",
          description:
            "Raw forecast wind gust at the current position before wind protection correction",
          units: "knots",
        },
      },
      {
        path: `${PREDICTION_BASE}.windProtection.correctedSpeedKnots`,
        value: {
          displayName: "Corrected wind speed",
          description:
            "Forecast wind speed after applying the learned wind protection factor",
          units: "knots",
        },
      },
      {
        path: `${PREDICTION_BASE}.windProtection.correctedGustKnots`,
        value: {
          displayName: "Corrected wind gust",
          description:
            "Forecast wind gust after applying the learned wind protection factor",
          units: "knots",
        },
      },
      {
        path: `${PREDICTION_BASE}.windProtection.position`,
        value: {
          displayName: "Wind protection position",
          description:
            "Vessel position used to resolve the current wind protection place and sector",
        },
      },
    ];

    // Per-device deployment meta. Emitted for each configured deployable
    // device so the leaf paths resolve to concrete Signal K paths.
    for (const device of devices) {
      const base = `${PREDICTION_BASE}.deployment.${device.id}`;
      meta.push(
        {
          path: `${base}.recommendedState`,
          value: {
            displayName: `Recommended state (${device.id})`,
            description: `Recommended deployment state for ${device.id}: "deployed" or "stowed"`,
          },
        },
        {
          path: `${base}.detectedState`,
          value: {
            displayName: `Detected state (${device.id})`,
            description: `Currently detected deployment state for ${device.id}: "deployed", "stowed" or null when unknown`,
          },
        },
        {
          path: `${base}.reason`,
          value: {
            displayName: `Recommendation reason (${device.id})`,
            description: `Human-readable reason for the current ${device.id} deployment recommendation`,
          },
        },
        {
          path: `${base}.missedYieldWh`,
          value: {
            displayName: `Missed yield (${device.id})`,
            description: `Energy yield missed by not deploying ${device.id} over the recommendation horizon`,
            units: "Wh",
          },
        },
        {
          path: `${base}.recommendedStateTime`,
          value: {
            displayName: `Recommended state time (${device.id})`,
            description: `Time at which ${device.id} should change state, or null if it should change now`,
            units: "timestamp",
          },
        },
      );
      if (device.type === "solar-deployable") {
        meta.push(
          {
            path: `${base}.recommendedSide`,
            value: {
              displayName: `Recommended side (${device.id})`,
              description: `Side of the vessel ${device.id} should face to maximise yield, when applicable`,
            },
          },
          {
            path: `${base}.recommendedSideTime`,
            value: {
              displayName: `Recommended side time (${device.id})`,
              description: `Time at which ${device.id} should change side, or null if it should change now`,
              units: "timestamp",
            },
          },
        );
      }
    }

    this.app.handleMessage(this.pluginId, {
      context: `vessels.${this.app.selfId}`,
      updates: [
        {
          meta,
        },
      ],
    });
  }

  /**
   * Applies hysteresis to a value to prevent threshold flapping.
   *
   * @param {number} value - Current value
   * @param {number} raiseThreshold - Threshold for raising alarm
   * @param {number} clearThreshold - Threshold for clearing alarm (lower than raise)
   * @param {boolean} currentState - Current alarm state
   * @returns {boolean} New alarm state
   */
  applyHysteresis(value, raiseThreshold, clearThreshold, currentState) {
    if (currentState) {
      // Must drop below clear threshold to clear
      return value > clearThreshold;
    } else {
      // Must rise above raise threshold to set
      return value >= raiseThreshold;
    }
  }

  /**
   * Checks if a notification is debounced.
   *
   * @param {string} type - Notification type
   * @returns {boolean} True if within debounce period
   */
  isDebounced(type) {
    const lastTime = this.lastNotificationTimes.get(type);
    if (!lastTime) {
      return false;
    }
    return Date.now() - lastTime < DEBOUNCE_MS;
  }

  /**
   * Records that a notification was sent.
   *
   * @param {string} type - Notification type
   */
  recordNotification(type) {
    this.lastNotificationTimes.set(type, Date.now());
  }

  /**
   * Publishes or clears a notification with debouncing.
   *
   * @param {string} type - Advisory/notification type
   * @param {string} state - "normal", "alert", or "warn"
   * @param {string} message - Human-readable message
   * @param {boolean} [force=false] - Force notification even if debounced
   * @returns {void}
   */
  publishNotification(type, state, message, force = false) {
    const path = `${NOTIFICATIONS_BASE}.${type}`;
    const now = new Date().toISOString();

    // Check debounce for non-force notifications
    if (!force && state !== "normal" && this.isDebounced(type)) {
      return;
    }

    // Record notification time
    if (state !== "normal") {
      this.recordNotification(type);
    }

    // Store for deduplication
    const key = `${type}:${state}:${message}`;
    if (this.lastAdvisories.get(type) === key) {
      return; // Already sent
    }
    this.lastAdvisories.set(type, key);

    if (state === "normal") {
      // Clear the notification by setting state to normal
      this.publishDelta({
        [path]: {
          state: "normal",
          method: [],
          message: message || "OK",
        },
      });
      this.activeNotifications.delete(type);
    } else {
      // Publish active notification
      this.publishDelta({
        [path]: {
          state,
          method: ["visual", "sound"],
          message,
          timestamp: now,
        },
      });
      this.activeNotifications.set(type, { state, message, timestamp: now });
    }
  }

  /**
   * Publishes hourly forecast to Signal K.
   *
   * @param {Array<object>} hourlyForecast - Hourly forecast data
   * @returns {void}
   */
  publishHourlyForecast(hourlyForecast) {
    this.publishDelta({
      [`${PREDICTION_BASE}.forecast.hourly`]: hourlyForecast,
    });
  }

  /**
   * Publishes deployment state recommendations for all deployable systems.
   * Publishes the recommended state as a delta value, and sends a notification
   * only if the current state differs from the recommended state.
   *
   * @param {Array<{id: string, name: string, type: string, recommendedState: string, reason: string}>} recommendations - Deployment recommendations
   * @param {Map<string, string|null>} currentStates - Map of device ID to current state (deployed/stowed/null)
   * @returns {void}
   */
  publishDeploymentStates(recommendations, currentStates) {
    const updates = {};

    for (const rec of recommendations) {
      // Publish the recommended state as a delta value
      updates[`${PREDICTION_BASE}.deployment.${rec.id}.recommendedState`] =
        rec.recommendedState;
      updates[`${PREDICTION_BASE}.deployment.${rec.id}.detectedState`] =
        currentStates.get(rec.id) ?? null;
      updates[`${PREDICTION_BASE}.deployment.${rec.id}.reason`] = rec.reason;
      updates[`${PREDICTION_BASE}.deployment.${rec.id}.missedYieldWh`] =
        rec.missedYieldWh ?? 0;
      updates[`${PREDICTION_BASE}.deployment.${rec.id}.recommendedStateTime`] =
        rec.recommendedStateTime ?? null;
      // Pointing recommendation only applies to deployable solar arrays
      if (rec.type === "solar-deployable") {
        updates[`${PREDICTION_BASE}.deployment.${rec.id}.recommendedSide`] =
          rec.recommendedSide ?? null;
        updates[`${PREDICTION_BASE}.deployment.${rec.id}.recommendedSideTime`] =
          rec.recommendedSideTime ?? null;
      }

      // Check current state to decide if notification is needed
      const currentState = currentStates.get(rec.id) ?? null;
      const needsChange =
        currentState !== null && currentState !== rec.recommendedState;

      // Potential yield when deployed - shown both for deploy prompts and
      // normal-state informational messages
      const yieldSuffix =
        rec.recommendedState === "deployed" && rec.missedYieldWh > 0
          ? ` (${formatWh(rec.missedYieldWh)} in ${rec.horizonHours ?? 24}h)`
          : "";

      if (needsChange) {
        const action = rec.recommendedState === "deployed" ? "Deploy" : "Stow";
        const state =
          rec.recommendedState === "deployed"
            ? DeployState.WARN
            : DeployState.ALERT;
        this.publishNotification(
          `deploy_${rec.id}`,
          state,
          `${rec.name}: ${action} now, ${rec.reason}${yieldSuffix}`,
        );
      } else {
        // State matches or unknown - clear any existing notification
        this.publishNotification(
          `deploy_${rec.id}`,
          DeployState.NORMAL,
          `${rec.name}: ${rec.reason}${yieldSuffix}`,
        );
      }
    }

    if (Object.keys(updates).length > 0) {
      this.publishDelta(updates);
    }
  }

  /**
   * Publishes time to full/empty predictions.
   *
   * @param {Date|null} timeToFull - Time when battery will be full
   * @param {Date|null} timeToEmpty - Time when battery will be depleted
   * @returns {void}
   */
  publishTimePredictions(timeToFull, timeToEmpty) {
    this.publishDelta({
      [`${PREDICTION_BASE}.timeToFull`]: timeToFull
        ? timeToFull.toISOString()
        : null,
      [`${PREDICTION_BASE}.timeToEmpty`]: timeToEmpty
        ? timeToEmpty.toISOString()
        : null,
    });
  }

  /**
   * Publishes drag reduction advisory (stowage when sufficient solar forecast).
   *
   * @param {{hour: number, reason: string}|null} opportunity - Stowage opportunity from prediction engine
   * @returns {void}
   */
  publishDragReductionAdvisory(opportunity) {
    const type = AdvisoryType.STOW_SOON;

    if (opportunity) {
      const message = `Stow mechanical generators in ${opportunity.hour}h to reduce drag - ${opportunity.reason}`;
      this.publishNotification(type, DeployState.WARN, message);
    } else {
      this.publishNotification(
        type,
        DeployState.NORMAL,
        "No drag reduction opportunity",
      );
    }
  }

  /**
   * Publishes engine run advisory when battery depletion is projected.
   *
   * @param {{hours: number, optimalWindow: {start: Date, end: Date}}|null} runTime - Engine run time calculation
   * @returns {void}
   */
  publishEngineRunAdvisory(runTime) {
    const type = AdvisoryType.ENGINE_RUN;

    if (runTime) {
      const hours = Math.round(runTime.hours * 10) / 10;
      const end = runTime.optimalWindow.end.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const start = runTime.optimalWindow.start.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const message = `Run engine for ${hours}h between ${start}-${end} to avoid low battery`;
      this.publishNotification(type, DeployState.WARN, message);
    } else {
      this.publishNotification(
        type,
        DeployState.NORMAL,
        "No engine run needed",
      );
    }
  }

  /**
   * Publishes all advisories based on prediction results.
   *
   * @param {object} params
   * @param {Array<object>} params.hourlyForecast - Hourly forecast data
   * @param {Date|null} params.timeToFull - Time when battery will be full
   * @param {Date|null} params.timeToEmpty - Time when battery will be depleted
   * @param {{hour: number, reason: string}|null} params.stowageOpportunity - Mechanical stowage opportunity
   * @param {{hours: number, optimalWindow: {start: Date, end: Date}}|null} params.engineRunTime - Engine run time
   * @param {Array<{id: string, name: string, type: string, recommendedState: string, reason: string}>} params.deploymentRecommendations - Deployment recommendations
   * @param {Map<string, string|null>} params.currentDeployStates - Map of device ID to current state
   * @returns {void}
   */
  publishAll({
    hourlyForecast,
    timeToFull,
    timeToEmpty,
    stowageOpportunity,
    engineRunTime,
    deploymentRecommendations = [],
    currentDeployStates = new Map(),
  }) {
    this.app.debug(
      `Publishing advisories for ${hourlyForecast.length} forecast hours`,
    );

    // Publish forecast and time predictions
    this.publishHourlyForecast(hourlyForecast);
    this.publishTimePredictions(timeToFull, timeToEmpty);

    // Publish deployment state recommendations and notifications
    this.publishDeploymentStates(
      deploymentRecommendations,
      currentDeployStates,
    );

    // Publish drag reduction advisory
    this.publishDragReductionAdvisory(stowageOpportunity);

    // Publish engine run advisory
    this.publishEngineRunAdvisory(engineRunTime);

    this.app.debug(
      `Advisories published: ${this.activeNotifications.size} active notifications`,
    );
  }

  /**
   * Clears all active notifications.
   *
   * @returns {void}
   */
  clearAll() {
    for (const type of Object.values(AdvisoryType)) {
      this.publishNotification(type, DeployState.NORMAL, "");
    }
  }

  /**
   * Gets the current active notifications for diagnostics.
   *
   * @returns {Map<string, {state: string, message: string, timestamp: string}>}
   */
  getActiveNotifications() {
    return new Map(this.activeNotifications);
  }
}

module.exports = {
  AdvisoryPublisher,
  DeployState,
  AdvisoryType,
  PREDICTION_BASE,
  NOTIFICATIONS_BASE,
  DEBOUNCE_MS,
};
