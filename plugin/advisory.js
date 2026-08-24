/**
 * Advisory publisher for Signal K deltas and notifications.
 *
 * Broadcasts actionable energy advisories to the Signal K tree.
 *
 * @file advisory.js
 */

/** @typedef {import("@signalk/server-api").ServerAPI} ServerAPI */

const {
  formatWh,
  solarOffsetMinutesFromLongitude,
  formatLocalHHMM,
  formatLocalMonthDay,
} = require("./format.js");
const {
  calculateUrgency,
  urgencyToNotification,
  Urgency,
  StateConfidence,
} = require("./urgency.js");

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
  SURPLUS_OPPORTUNITY: "surplus",
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

// solarOffsetMinutesFromLongitude, formatLocalHHMM and formatLocalMonthDay
// live in ./format.js (shared with the prediction engine, which builds the
// deployment reason strings that end up in these notifications). Re-exported
// below for existing callers.

/**
 * Formats a surplus-window endpoint as `HH:MM`, adding a day marker when
 * it falls on a different day than the window start — a 26h window from
 * 14:46 today to 16:46 tomorrow must not render as the ambiguous
 * `14:46-16:46` (which reads as a 2h same-day span).
 *
 * When `offsetMinutes` is null the host's own timezone is used (legacy
 * behaviour); when provided, times render in solar-local time derived from
 * the vessel's longitude, independent of the server's clock setting.
 *
 * @param {Date} when - Endpoint to format
 * @param {Date} [start] - Window start, to detect a day rollover
 * @param {number|null} [offsetMinutes=null] - Solar-local UTC offset in min
 * @returns {string}
 */
function formatWindowTime(when, start, offsetMinutes = null) {
  if (offsetMinutes == null) {
    const hm = when.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    if (start == null || when.toDateString() === start.toDateString()) {
      return hm;
    }
    const tomorrow = new Date(start);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (when.toDateString() === tomorrow.toDateString()) {
      return `${hm}+1`;
    }
    return `${hm} ${when.toLocaleDateString([], {
      month: "short",
      day: "numeric",
    })}`;
  }

  const hm = formatLocalHHMM(when, offsetMinutes);
  if (start == null) {
    return hm;
  }
  // Compare local calendar days (not UTC) so a window crossing solar
  // midnight is flagged regardless of the absolute longitude.
  const startDay = formatLocalMonthDay(start, offsetMinutes);
  const whenDay = formatLocalMonthDay(when, offsetMinutes);
  if (whenDay === startDay) {
    return hm;
  }
  const tomorrow = new Date(start.getTime() + 24 * 3600 * 1000);
  if (formatLocalMonthDay(tomorrow, offsetMinutes) === whenDay) {
    return `${hm}+1`;
  }
  return `${hm} ${whenDay}`;
}

/**
 * Computes the severity ratio (`currentValue / limit`) for a deployment
 * recommendation. For gust-driven recommendations (FLINsail, wind gen) it is
 * `currentGustKnots / limitKnots`; for hydro (speed-driven) it is
 * `currentSpeedKnots / limitKnots`. Returns null when neither a current
 * reading nor a limit is present (no intensity evidence).
 *
 * @param {object} rec - Deployment recommendation
 * @returns {number|null}
 */
function severityRatioFor(rec) {
  const limit = rec.limitKnots;
  if (limit == null || limit <= 0) return null;
  const current =
    rec.currentGustKnots != null ? rec.currentGustKnots : rec.currentSpeedKnots;
  if (current == null) return null;
  return current / limit;
}

/**
 * Converts a future recommended-state-change time into hours from now.
 * A `null` time means "change now" (per the advisory contract), which
 * maps to 0 hours (maximum time score). A past time also maps to 0.
 * Returns null only when the value is unparseable.
 *
 * @param {Date|string|number|null} when
 * @returns {number|null}
 */
function hoursUntil(when) {
  if (when == null) return 0;
  const t = when instanceof Date ? when.getTime() : new Date(when).getTime();
  if (Number.isNaN(t)) return null;
  const diff = (t - Date.now()) / (60 * 60 * 1000);
  return diff > 0 ? diff : 0;
}

/**
 * Whether a recommendation's triggering condition is happening now (actual)
 * versus forecast. We treat it as actual when there is a *current* reading
 * already at or above the limit (e.g. gusts already hitting the limit), and
 * forecast otherwise (the condition is expected later).
 *
 * @param {object} rec - Deployment recommendation
 * @returns {boolean}
 */
function isActualCondition(rec) {
  const ratio = severityRatioFor(rec);
  return ratio != null && ratio >= 1;
}

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
        path: `${PREDICTION_BASE}.surplusWh`,
        value: {
          displayName: "Surplus energy",
          description:
            "Forecast energy the charge controller would curtail because the battery is full while yield continues — available to run opportunistic loads. 0 when no surplus opportunity is forecast.",
          units: "Wh",
        },
      },
      {
        path: `${PREDICTION_BASE}.surplus.from`,
        value: {
          displayName: "Surplus window start",
          description:
            "Start of the forecast surplus-energy window (the first hour that actually curtails energy), or null",
          units: "timestamp",
        },
      },
      {
        path: `${PREDICTION_BASE}.surplus.to`,
        value: {
          displayName: "Surplus window end",
          description:
            "End of the forecast surplus-energy window (the last hour that curtails energy), or null",
          units: "timestamp",
        },
      },
      {
        path: `${PREDICTION_BASE}.weather.source`,
        value: {
          displayName: "Forecast source",
          description:
            "Which weather-forecast source the current prediction is built on (e.g. \"Open-Meteo\", \"Signal K Weather API\", \"Signal K Logbook\", \"Clear Sky Baseline\"), or null when no forecast is available",
        },
      },
      {
        path: `${PREDICTION_BASE}.weather.validHours`,
        value: {
          displayName: "Forecast valid hours",
          description:
            "Hours the current forecast actually covers (the prediction's effective horizon). Can be shorter than the configured horizon when a tier returns fewer hours or a stale cache is partially consumed. 0 when no forecast is available.",
          units: "h",
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
   * @param {string} state - "normal", "alert", "warn", "alarm"
   * @param {string} message - Human-readable message
   * @param {object} [opts]
   * @param {boolean} [opts.force=false] - Force notification even if
   *        debounced
   * @param {string[]} [opts.methods] - Notification methods (e.g.
   *        `["visual", "sound"]`). Defaults to `["visual", "sound"]` for
   *        active states; `[]` for `normal`.
   * @returns {void}
   */
  publishNotification(type, state, message, opts = {}) {
    const { force = false, methods } = opts;
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
          method: methods ?? ["visual", "sound"],
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
   * Urgency (and thus the Signal K notification state + methods) is computed
   * via {@link module:urgency~calculateUrgency} from the recommendation's
   * severity ratio, time-to-action, duration, detected state, and state
   * confidence, then mapped through the day/night and navigation-state
   * rules in {@link module:urgency~urgencyToNotification}.
   *
   * @param {Array<object>} recommendations - Deployment recommendations
   * @param {Map<string, string|null>} currentStates - Map of device ID to
   *        current state (deployed/stowed/null)
   * @param {object} [opts]
   * @param {boolean} [opts.isNight=false] - Whether it is currently nighttime
   * @param {boolean} [opts.isUnderway=false] - Whether the vessel is under way
   * @param {Map<string, number>} [opts.confidences] - Map of device ID to
   *        StateConfidence value (defaults to HIGH)
   * @param {object} [opts.urgencyConfig] - Urgency config override
   * @returns {void}
   */
  publishDeploymentStates(recommendations, currentStates, opts = {}) {
    const {
      isNight = false,
      isUnderway = false,
      confidences,
      urgencyConfig,
    } = opts;
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
      const confidence = confidences?.get(rec.id) ?? StateConfidence.HIGH;
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
        // For a deploy suggestion, the "duration" feeding the urgency
        // duration gate is the forecast good-output window (the crew is
        // deciding whether the window is long enough to justify the deck
        // trip). For a stow recommendation, duration is about how long the
        // over-limit condition has persisted (an actual-event signal we
        // don't track per-recommendation yet — pass null so the sustained
        // default applies).
        const eventDurationMinutes =
          rec.recommendedState === "deployed" && rec.goodOutputHours != null
            ? rec.goodOutputHours * 60
            : null;
        let urgency = calculateUrgency({
          severityRatio: severityRatioFor(rec),
          timeToActionHours: hoursUntil(rec.recommendedStateTime),
          isActual: isActualCondition(rec),
          advisoryType: "deployable",
          detectedState: currentState,
          recommendedState: rec.recommendedState,
          stateConfidence: confidence,
          deployableType: rec.type,
          reluctance: rec.reluctance,
          eventDurationMinutes,
          config: urgencyConfig,
        });
        // A detected/recommended mismatch always warrants at least an
        // informational alert so the crew knows a state change is advised.
        // Reluctance and confidence can dampen the *level* (toward visual/
        // info) but should not suppress the notification entirely (that
        // would read as "all clear").
        if (urgency === Urgency.NORMAL) urgency = Urgency.INFO;
        const notif = urgencyToNotification(urgency, {
          isNight,
          advisoryType: "deployable",
          isUnderway,
        });
        // null = held for the morning (at-rest + night + low urgency):
        // skip publishing entirely so the last notification stands.
        if (notif != null) {
          this.publishNotification(
            `deploy_${rec.id}`,
            notif.state,
            `${rec.name}: ${action} now, ${rec.reason}${yieldSuffix}`,
            { methods: notif.methods },
          );
        }
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
   * Publishes the weather-forecast status the current prediction is built
   * on: which forecast tier is in use and how many hours it actually
   * covers (the effective horizon, which can be shorter than the
   * configured one when a tier returns fewer hours or a stale cache is
   * partially consumed). Lets the crew see at a glance whether they're
   * on a real forecast ("Open-Meteo, valid 48h") or a degraded fallback
   * ("Clear Sky, valid 2h").
   *
   * Both are data, not a nudge, so they're emitted as plain deltas (no
   * notification) for the instrument panel / webapp to render.
   *
   * @param {string|null} weatherSource - Human-readable source name
   *        (e.g. "Open-Meteo", "Clear Sky"), or null when no forecast is
   *        available this cycle
   * @param {number} validHours - Hours the current forecast actually covers
   *        (the prediction's effective horizon); 0 when no forecast
   * @returns {void}
   */
  publishForecastStatus(weatherSource, validHours) {
    this.publishDelta({
      [`${PREDICTION_BASE}.weather.source`]: weatherSource ?? null,
      [`${PREDICTION_BASE}.weather.validHours`]:
        Number.isFinite(validHours) && validHours > 0 ? validHours : 0,
    });
  }

  /**
   * Publishes drag reduction advisory (stowage when sufficient solar forecast).
   *
   * Urgency is time-driven (the stowage opportunity is hours away) and
   * capped at `medium` — it's a fuel/drag saving opportunity, not a safety
   * matter. At rest + night + low urgency it's held for the morning.
   *
   * @param {{hour: number, reason: string}|null} opportunity - Stowage opportunity from prediction engine
   * @param {object} [opts]
   * @param {boolean} [opts.isNight=false] - Whether it is currently nighttime
   * @param {boolean} [opts.isUnderway=false] - Whether the vessel is under way
   * @param {object} [opts.urgencyConfig] - Urgency config override
   * @returns {void}
   */
  publishDragReductionAdvisory(opportunity, opts = {}) {
    const type = AdvisoryType.STOW_SOON;

    if (opportunity) {
      const message = `Stow mechanical generators in ${opportunity.hour}h to reduce drag - ${opportunity.reason}`;
      let urgency = calculateUrgency({
        advisoryType: "opportunity",
        timeToActionHours: opportunity.hour,
        isActual: false,
        config: opts.urgencyConfig,
      });
      // A real stowage opportunity always warrants at least an info alert.
      if (urgency === Urgency.NORMAL) urgency = Urgency.INFO;
      const notif = urgencyToNotification(urgency, {
        isNight: opts.isNight ?? false,
        isUnderway: opts.isUnderway ?? false,
        advisoryType: "opportunity",
      });
      // null = held for the morning (at-rest + night + low urgency):
      // skip publishing so the last notification stands.
      if (notif != null) {
        this.publishNotification(type, notif.state, message, {
          methods: notif.methods,
        });
      }
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
   * Urgency is computed from the current battery SoC and the hours until
   * the optimal window closes (the latest sensible start time), then
   * mapped through the day/night method table. Battery `alarm`/`high`
   * (<1h to empty) sound even at night — the boat going dark is urgent
   * regardless of time.
   *
   * @param {{hours: number, optimalWindow: {start: Date, end: Date}}|null} runTime - Engine run time calculation
   * @param {object} [opts]
   * @param {number} [opts.batterySoC] - Current battery SoC [0–1]
   * @param {boolean} [opts.isNight=false] - Whether it is currently nighttime
   * @param {boolean} [opts.isUnderway=false] - Whether the vessel is
   *        under way (at-rest + night holds low-urgency "run the genset"
   *        suggestions for the morning; battery alarm/high always emit)
   * @param {number|null} [opts.localOffsetMinutes=null] - Solar-local UTC
   *        offset (min) for human-facing times; null uses host timezone
   * @param {object} [opts.urgencyConfig] - Urgency config override
   * @returns {void}
   */
  publishEngineRunAdvisory(runTime, opts = {}) {
    const type = AdvisoryType.ENGINE_RUN;

    if (runTime) {
      const hours = Math.round(runTime.hours * 10) / 10;
      const off = opts.localOffsetMinutes ?? null;
      const end = formatWindowTime(runTime.optimalWindow.end, undefined, off);
      const start = formatWindowTime(
        runTime.optimalWindow.start,
        undefined,
        off,
      );
      const message = `Run engine for ${hours}h between ${start}-${end} to avoid low battery`;
      const urgency = calculateUrgency({
        advisoryType: "engine",
        batterySoC: opts.batterySoC ?? null,
        timeToActionHours: hoursUntil(runTime.optimalWindow.end),
        isActual: false,
        config: opts.urgencyConfig,
      });
      const notif = urgencyToNotification(urgency, {
        isNight: opts.isNight ?? false,
        isUnderway: opts.isUnderway ?? false,
        advisoryType: "engine",
      });
      // null = held for the morning (at-rest + night + low urgency):
      // skip so the last notification stands. Battery alarm/high never
      // hit this path (they're medium+ and always emit, with sound).
      if (notif != null) {
        this.publishNotification(type, notif.state, message, {
          methods: notif.methods,
        });
      }
    } else {
      this.publishNotification(
        type,
        DeployState.NORMAL,
        "No engine run needed",
      );
    }
  }

  /**
   * Checks whether an opportunistic load is already running, so a richer
   * suggestion surface (e.g. the webapp) can skip loads that are already
   * consuming power (e.g. Starlink online, watermaker started).
   *
   * Detection is optional: a load without a `statePath` is never
   * considered running (we have no signal), so it's always a candidate.
   * Loads that are instrumented but whose state can't be read or whose
   * value is null/unknown are also treated as not-running — we only
   * suppress a suggestion when we have a positive "it's on" reading.
   *
   * @param {{statePath?: string, onValues?: string}} load - Load config
   * @returns {boolean} True if the load is detected as running
   */
  isLoadRunning(load) {
    if (!load.statePath) return false;
    const raw = this.app.getSelfPath
      ? this.app.getSelfPath(load.statePath)
      : null;
    if (raw == null) return false;
    // Tolerate both bare values and {value: ...} wrapper objects
    const v =
      typeof raw === "object" && raw != null && "value" in raw
        ? raw.value
        : raw;
    if (v == null) return false;
    // Digital-switching loads expose a boolean: true means running,
    // false means off. String state paths (e.g. Starlink
    // "online") go through the onValues check below.
    if (typeof v === "boolean") return v;
    const s = String(v).toLowerCase().trim();
    if (s === "") return false;
    const onValues =
      load.onValues != null && load.onValues !== ""
        ? load.onValues
        : "started,on,online,running,active";
    const accepted = onValues
      .toLowerCase()
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "");
    return accepted.includes(s);
  }

  /**
   * Publishes a surplus-energy opportunity advisory: the battery is
   * forecast full while yield continues, so the charge controller would
   * curtail energy that could instead run opportunistic loads (watermaker,
   * ice maker, …). Includes the classic motoring side-effect case.
   *
   * Urgency is time-driven (the surplus window is hours away) and capped
   * at `medium` — it's a gain from acting, not a safety matter. At rest +
   * night + low urgency it's held for the morning (the window is daytime
   * anyway, since the prediction engine already suppresses nighttime
   * surplus windows at rest).
   *
   * @param {{surplusWh: number, from: Date, to: Date, suggestedLoadW: number}|null} opportunity -
   *        Surplus window from findSurplusOpportunity, or null to clear
   * @param {Array<{name: string, watts: number}>} [opportunisticLoads] -
   *        Configured loads used to suggest uses for the surplus
   * @param {object} [opts]
   * @param {boolean} [opts.isNight=false] - Whether it is currently nighttime
   * @param {boolean} [opts.isUnderway=false] - Whether the vessel is under way
   * @param {number|null} [opts.localOffsetMinutes=null] - Solar-local UTC
   *        offset (min) for human-facing times; null uses host timezone
   * @param {object} [opts.urgencyConfig] - Urgency config override
   * @returns {void}
   */
  publishSurplusAdvisory(opportunity, opportunisticLoads = [], opts = {}) {
    const type = AdvisoryType.SURPLUS_OPPORTUNITY;

    if (opportunity) {
      const off = opts.localOffsetMinutes ?? null;
      const from = formatWindowTime(opportunity.from, undefined, off);
      const to = formatWindowTime(opportunity.to, opportunity.from, off);
      let message = `${formatWh(opportunity.surplusWh)} surplus available ${from}-${to}`;
      if (opportunity.suggestedLoadW > 0) {
        message += ` (~${opportunity.suggestedLoadW}W sustained)`;
      }
      let urgency = calculateUrgency({
        advisoryType: "opportunity",
        timeToActionHours: hoursUntil(opportunity.from),
        isActual: false,
        config: opts.urgencyConfig,
      });
      // A real surplus opportunity always warrants at least an
      // informational alert (far-future windows would otherwise compute
      // to normal and read as "all clear"). The time score only dampens
      // the *level* toward visual/info; it never suppresses the
      // notification entirely.
      if (urgency === Urgency.NORMAL) urgency = Urgency.INFO;
      const notif = urgencyToNotification(urgency, {
        isNight: opts.isNight ?? false,
        isUnderway: opts.isUnderway ?? false,
        advisoryType: "opportunity",
      });
      // null = held for the morning (at-rest + night + low urgency):
      // skip the notification so the last one stands. Still publish the
      // surplus Wh/window deltas — those are data, not a nudge, and
      // consumers (dashboards) want them regardless of whether the crew
      // is being nudged right now.
      if (notif != null) {
        this.publishNotification(type, notif.state, message, {
          methods: notif.methods,
        });
      }
      // Also expose the value as a delta so consumers can act without
      // parsing the notification.
      this.publishDelta({
        [`${PREDICTION_BASE}.surplusWh`]: opportunity.surplusWh,
        [`${PREDICTION_BASE}.surplus.from`]: opportunity.from.toISOString(),
        [`${PREDICTION_BASE}.surplus.to`]: opportunity.to.toISOString(),
      });
    } else {
      this.publishNotification(
        type,
        DeployState.NORMAL,
        "No surplus opportunity",
      );
      this.publishDelta({
        [`${PREDICTION_BASE}.surplusWh`]: 0,
        [`${PREDICTION_BASE}.surplus.from`]: null,
        [`${PREDICTION_BASE}.surplus.to`]: null,
      });
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
   * @param {boolean} [params.isNight=false] - Whether it is currently nighttime
   * @param {boolean} [params.isUnderway=false] - Whether the vessel is under way
   * @param {Map<string, number>} [params.deployConfidences] - Map of device ID to StateConfidence
   * @param {number} [params.batterySoC] - Current battery SoC [0–1]
   * @param {string|null} [params.weatherSource=null] - Human-readable
   *        forecast source name in use this cycle (e.g. "Open-Meteo",
   *        "Signal K Weather API", "Signal K Logbook", "Clear Sky
   *        Baseline"), or null when no forecast is available
   * @param {number} [params.validHours=0] - Hours the current forecast
   *        actually covers (the prediction's effective horizon)
   * @param {number|null} [params.localOffsetMinutes=null] - Solar-local UTC
   *        offset (min) for human-facing times; null uses host timezone
   * @param {object} [params.urgencyConfig] - Urgency config override
   * @returns {void}
   */
  publishAll({
    hourlyForecast,
    timeToFull,
    timeToEmpty,
    stowageOpportunity,
    engineRunTime,
    surplusOpportunity,
    opportunisticLoads = [],
    deploymentRecommendations = [],
    currentDeployStates = new Map(),
    isNight = false,
    isUnderway = false,
    deployConfidences,
    batterySoC,
    weatherSource = null,
    validHours = 0,
    localOffsetMinutes = null,
    urgencyConfig,
  }) {
    this.app.debug(
      `Publishing advisories for ${hourlyForecast.length} forecast hours`,
    );

    // Publish forecast and time predictions
    this.publishHourlyForecast(hourlyForecast);
    this.publishTimePredictions(timeToFull, timeToEmpty);
    this.publishForecastStatus(weatherSource, validHours);

    // Publish deployment state recommendations and notifications
    this.publishDeploymentStates(
      deploymentRecommendations,
      currentDeployStates,
      {
        isNight,
        isUnderway,
        confidences: deployConfidences,
        urgencyConfig,
      },
    );

    // Publish drag reduction advisory
    this.publishDragReductionAdvisory(stowageOpportunity, {
      isNight,
      isUnderway,
      urgencyConfig,
    });

    // Publish engine run advisory
    this.publishEngineRunAdvisory(engineRunTime, {
      batterySoC,
      isNight,
      isUnderway,
      localOffsetMinutes,
      urgencyConfig,
    });

    // Publish surplus opportunity advisory (battery full while yield
    // continues — watermaker/ice-maker case; motoring side-effect)
    this.publishSurplusAdvisory(surplusOpportunity, opportunisticLoads, {
      isNight,
      isUnderway,
      localOffsetMinutes,
      urgencyConfig,
    });

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
  severityRatioFor,
  hoursUntil,
  isActualCondition,
  solarOffsetMinutesFromLongitude,
  formatWindowTime,
};
