/**
 * Advisory publisher for Signal K deltas and notifications.
 *
 * Broadcasts actionable energy advisories to the Signal K tree.
 *
 * @file advisory.js
 */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */

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
   * Publishes FLINsail stowage advisory based on wind gust forecast.
   *
   * @param {boolean} shouldStow - Whether the array should be stowed
   * @param {string} arrayName - Name of the deployable array
   * @param {number} gustSpeedKnots - Current gust speed
   * @param {number} gustLimitKnots - Gust limit
   * @returns {void}
   */
  publishFLINsailAdvisory(
    shouldStow,
    arrayName,
    gustSpeedKnots,
    gustLimitKnots,
  ) {
    const type = AdvisoryType.STOW_NOW;
    let message;
    if (shouldStow) {
      message = `${arrayName}: Stow immediately - wind gusts at ${Math.round(gustSpeedKnots)}kn exceed limit of ${gustLimitKnots}kn`;
    } else if (gustSpeedKnots == null || gustSpeedKnots <= 0) {
      message = `${arrayName}: No stowage needed - no wind gusts detected`;
    } else {
      message = `${arrayName}: No stowage needed - gusts ${Math.round(gustSpeedKnots)}kn below limit of ${gustLimitKnots}kn`;
    }

    this.publishNotification(
      type,
      shouldStow ? DeployState.ALERT : DeployState.NORMAL,
      message,
    );
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
      const start = runTime.optimalWindow.start.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      const end = runTime.optimalWindow.end.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
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
   * Publishes deployment advisories for mechanical generators with debouncing.
   *
   * @param {Array<{generatorId: string, generatorName: string, type: string, hour: number, reason: string, action?: string, currentSpeed?: number, maxWindKnots?: number, maxSpeedKnots?: number, minSpeedKnots?: number}>} opportunities - Deployment opportunities
   * @returns {void}
   */
  publishDeploymentAdvisories(opportunities) {
    const deployType = AdvisoryType.DEPLOY_NOW;
    const stowType = AdvisoryType.STOW_SOON;
    const infoType = AdvisoryType.DEPLOY_INFO;

    for (const opp of opportunities) {
      const key = `${opp.type}_${opp.generatorId}`;
      const currentState =
        this.activeNotifications.get(key)?.state !== DeployState.NORMAL;

      if (opp.action === "stow") {
        // Use hysteresis for stow decisions: stow at max, clear at max - 5
        const maxWind = opp.maxWindKnots ?? 30;
        const isOverLimit =
          opp.currentSpeed != null &&
          this.applyHysteresis(
            opp.currentSpeed,
            maxWind,
            maxWind - 5,
            currentState,
          );

        if (isOverLimit) {
          this.publishNotification(
            `${stowType}_${opp.generatorId}`,
            DeployState.ALERT,
            `${opp.generatorName}: ${opp.reason}`,
          );
        } else {
          this.publishNotification(
            `${stowType}_${opp.generatorId}`,
            DeployState.NORMAL,
            "",
          );
        }
      } else if (opp.action === "info") {
        this.publishNotification(
          `${infoType}_${opp.generatorId}`,
          DeployState.NORMAL,
          opp.reason,
        );
      } else if (opp.reason && opp.currentSpeed != null) {
        // Deploy advisory with hysteresis
        if (opp.type === "hydro") {
          const minSpeed = opp.minSpeedKnots ?? 3;
          const shouldDeploy = this.applyHysteresis(
            opp.currentSpeed,
            minSpeed,
            minSpeed - 1,
            currentState,
          );

          if (shouldDeploy) {
            this.publishNotification(
              `${deployType}_${opp.generatorId}`,
              DeployState.WARN,
              `${opp.generatorName}: ${opp.reason}`,
            );
          } else {
            this.publishNotification(
              `${deployType}_${opp.generatorId}`,
              DeployState.NORMAL,
              "",
            );
          }
        } else if (opp.type === "wind") {
          const maxWind = opp.maxWindKnots ?? 30;
          const isOverLimit = this.applyHysteresis(
            opp.currentSpeed,
            maxWind,
            maxWind - 5,
            currentState,
          );

          if (isOverLimit) {
            this.publishNotification(
              `${stowType}_${opp.generatorId}`,
              DeployState.ALERT,
              `${opp.generatorName}: Stow - wind ${opp.currentSpeed.toFixed(1)}kn exceeds limit of ${maxWind}kn`,
            );
          } else {
            const deployThreshold = maxWind * 0.7; // Deploy when below 70% of max
            const shouldDeploy = this.applyHysteresis(
              opp.currentSpeed,
              deployThreshold,
              deployThreshold - 2,
              currentState,
            );

            if (shouldDeploy && currentState) {
              // Clear stow notification
              this.publishNotification(
                `${stowType}_${opp.generatorId}`,
                DeployState.NORMAL,
                "",
              );
            } else if (shouldDeploy) {
              this.publishNotification(
                `${deployType}_${opp.generatorId}`,
                DeployState.WARN,
                `${opp.generatorName}: ${opp.reason}`,
              );
            } else {
              this.publishNotification(
                `${deployType}_${opp.generatorId}`,
                DeployState.NORMAL,
                "",
              );
            }
          }
        }
      } else if (opp.reason) {
        this.publishNotification(
          `${deployType}_${opp.generatorId}`,
          DeployState.WARN,
          `${opp.generatorName}: ${opp.reason}`,
        );
      } else {
        this.publishNotification(
          `${deployType}_${opp.generatorId}`,
          DeployState.NORMAL,
          "",
        );
      }
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
   * @param {boolean} params.flinSailStowNeeded - Whether FLINsail should be stowed
   * @param {string} params.flinSailName - FLINsail array name
   * @param {number} params.currentGustKnots - Current gust speed
   * @param {number} params.gustLimitKnots - FLINsail gust limit
   * @returns {void}
   */
  publishAll({
    hourlyForecast,
    timeToFull,
    timeToEmpty,
    stowageOpportunity,
    engineRunTime,
    flinSailStowNeeded,
    flinSailName,
    currentGustKnots,
    gustLimitKnots,
    deploymentOpportunities = [],
  }) {
    this.app.debug(
      `Publishing advisories for ${hourlyForecast.length} forecast hours`,
    );

    // Publish forecast and time predictions
    this.publishHourlyForecast(hourlyForecast);
    this.publishTimePredictions(timeToFull, timeToEmpty);

    // Publish FLINsail advisory
    this.publishFLINsailAdvisory(
      flinSailStowNeeded,
      flinSailName,
      currentGustKnots,
      gustLimitKnots,
    );

    // Publish deployment advisories for mechanical generators
    this.publishDeploymentAdvisories(deploymentOpportunities);

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
