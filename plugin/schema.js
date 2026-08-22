/**
 * JSON Schema for Signal K Energy Predictor plugin configuration.
 * Generates Admin UI form for configuring battery, solar arrays, and generators.
 *
 * @file schema.js
 */

/**
 * Builds the JSON Schema for the plugin configuration.
 *
 * @returns {object} JSON Schema object
 */
function buildPluginSchema() {
  return {
    type: "object",
    title: "Energy Predictor Configuration",
    description:
      "Configure battery, solar arrays, and mechanical generators for energy prediction",
    properties: {
      updateIntervalMinutes: {
        type: "number",
        title: "Update Interval",
        description: "How often to recalculate forecasts (minutes)",
        default: 15,
        minimum: 5,
        maximum: 60,
      },
      battery: {
        type: "object",
        title: "Battery Configuration",
        properties: {
          capacityAh: {
            type: "number",
            title: "Battery Capacity",
            description: "House battery capacity in amp-hours",
            default: 400,
            minimum: 1,
          },
          systemVoltage: {
            type: "number",
            title: "System Voltage",
            description: "System voltage in volts (12, 24, or 48)",
            default: 12,
            enum: [12, 24, 48],
          },
          minSafeSoC: {
            type: "number",
            title: "Minimum Safe SoC",
            description: "Minimum safe state of charge (0-1, where 1 is full)",
            default: 0.2,
            minimum: 0.05,
            maximum: 0.5,
          },
          socPath: {
            type: "string",
            title: "SoC Path",
            description: "Signal K path for battery state of charge",
            default: "electrical.batteries.house.capacity.stateOfCharge",
          },
          engineAlternatorWatts: {
            type: "number",
            title: "Engine Alternator Output",
            description:
              "Expected alternator output when engine is running (watts)",
            default: 100,
            minimum: 50,
          },
        },
        required: ["capacityAh", "systemVoltage", "minSafeSoC"],
      },
      solarArrays: {
        type: "array",
        title: "Solar Arrays",
        description: "Configure your solar panels and deployable arrays",
        items: {
          type: "object",
          title: "Solar Array",
          properties: {
            id: {
              type: "string",
              title: "Array ID",
              description: "Unique identifier (e.g., 'cabin-roof', 'flinsail')",
              minLength: 1,
            },
            name: {
              type: "string",
              title: "Display Name",
              description: "Human-readable name for advisories",
              default: "",
            },
            type: {
              type: "string",
              title: "Array Type",
              description: "Fixed panels or deployable sail-like array",
              enum: ["fixed", "deployable"],
              default: "fixed",
            },
            powerPath: {
              type: "string",
              title: "Power Path",
              description: "Signal K path for power output reading (watts)",
            },
            controllerModePath: {
              type: "string",
              title: "Controller Mode Path",
              description:
                "Signal K path for charge controller mode (optional, for sanitization)",
            },
            deployStatePath: {
              type: "string",
              title: "Deploy State Path",
              description:
                "Signal K path for current deploy/stow state (optional). Used to detect if change is needed.",
            },
            gustLimitKnots: {
              type: "number",
              title: "Gust Limit",
              description:
                "Wind gust threshold for stowing deployable arrays (knots)",
              default: 20,
              minimum: 10,
              maximum: 50,
            },
            hardwareEpochs: {
              type: "array",
              title: "Hardware Epochs",
              description:
                "Periods when this array was active with different capacity",
              items: {
                type: "object",
                properties: {
                  startDate: {
                    type: "string",
                    format: "date-time",
                    title: "Start Date",
                  },
                  endDate: {
                    type: "string",
                    format: "date-time",
                    title: "End Date",
                  },
                  capacityWp: {
                    type: "number",
                    title: "Capacity",
                    description: "Peak wattage for this period",
                    minimum: 1,
                  },
                },
                required: ["startDate", "capacityWp"],
              },
            },
            capacityWp: {
              type: "number",
              title: "Current Capacity",
              description: "Current peak wattage of the array",
              minimum: 1,
            },
            enabled: {
              type: "boolean",
              title: "Enabled",
              description: "Enable this array for prediction",
              default: true,
            },
          },
          required: ["id", "type", "capacityWp"],
        },
      },
      mechanicalGenerators: {
        type: "array",
        title: "Mechanical Generators",
        description: "Wind and hydro generators",
        items: {
          type: "object",
          title: "Generator",
          properties: {
            id: {
              type: "string",
              title: "Generator ID",
              description:
                "Unique identifier (e.g., 'wind-aft', 'hydro-shaft')",
              minLength: 1,
            },
            name: {
              type: "string",
              title: "Display Name",
              description: "Human-readable name for advisories",
              default: "",
            },
            type: {
              type: "string",
              title: "Generator Type",
              enum: ["wind", "hydro"],
            },
            deployable: {
              type: "boolean",
              title: "Deployable",
              description:
                "Generator can be deployed/retracted (hydrogenerators are typically deployable)",
              default: false,
            },
            maxWindKnots: {
              type: "number",
              title: "Max Wind Speed",
              description:
                "Maximum safe wind speed (knots) - stow above this (wind generators only)",
              default: 30,
              minimum: 20,
              maximum: 60,
            },
            startupSpeedKnots: {
              type: "number",
              title: "Startup Wind Speed",
              description:
                "Minimum wind speed (knots) for the generator to produce power (wind generators only)",
              default: 5,
              minimum: 0,
            },
            minSpeedKnots: {
              type: "number",
              title: "Min Speed",
              description:
                "Minimum boat speed to start generating (knots) - hydro generators only",
              default: 3,
              minimum: 1,
              maximum: 10,
            },
            maxSpeedKnots: {
              type: "number",
              title: "Max Speed",
              description:
                "Maximum safe boat speed (knots) - stow above this (hydro generators only)",
              default: 12,
              minimum: 8,
              maximum: 20,
            },
            powerPath: {
              type: "string",
              title: "Power Path",
              description: "Signal K path for power output reading (watts)",
            },
            deployStatePath: {
              type: "string",
              title: "Deploy State Path",
              description:
                "Signal K path for current deploy/stow state (optional). Used to detect if change is needed.",
            },
            manufacturerCurve: {
              type: "string",
              title: "Power Curve",
              description:
                "Comma-separated pairs of speed (knots) and power (watts), e.g., '5,10,10,50,20,100'",
              pattern:
                "^\\s*\\d+(\\.\\d+)?\\s*,\\s*\\d+(\\.\\d+)?\\s*(,\\s*\\d+(\\.\\d+)?\\s*,\\s*\\d+(\\.\\d+)?\\s*)*$",
            },
            enabled: {
              type: "boolean",
              title: "Enabled",
              description: "Enable this generator for prediction",
              default: true,
            },
          },
          required: ["id", "type", "manufacturerCurve"],
        },
      },
      learning: {
        type: "object",
        title: "Learning Configuration",
        description: "Machine learning parameters for efficiency profiling",
        properties: {
          enabled: {
            type: "boolean",
            title: "Enable Learning",
            description:
              "Continuously update efficiency matrices from actual output",
            default: true,
          },
          saveIntervalMinutes: {
            type: "number",
            title: "Save Interval",
            description:
              "How often to save learning matrices to disk (minutes)",
            default: 60,
            minimum: 10,
            maximum: 1440,
          },
          minIntervalSeconds: {
            type: "number",
            title: "Minimum Learning Interval",
            description:
              "Minimum time between learning cycles (seconds). Solar power deltas arriving within the interval are accumulated into the running average",
            default: 60,
            minimum: 5,
            maximum: 3600,
          },
          averageWindowSeconds: {
            type: "number",
            title: "Power Averaging Window",
            description:
              "Running-average window for solar power values fed to learning (seconds)",
            default: 300,
            minimum: 60,
            maximum: 1800,
          },
          emaAlpha: {
            type: "number",
            title: "EMA Smoothing Factor",
            description:
              "Exponential moving average alpha (lower = slower learning, higher = faster adaptation)",
            default: 0.05,
            minimum: 0.01,
            maximum: 0.2,
          },
          defaultEfficiency: {
            type: "number",
            title: "Default Efficiency",
            description:
              "Starting efficiency for unlearned matrix bins (0.1-1.0)",
            default: 0.7,
            minimum: 0.1,
            maximum: 1.0,
          },
        },
      },
      weather: {
        type: "object",
        title: "Weather Configuration",
        description: "Weather data source preferences",
        properties: {
          preferredProvider: {
            type: "string",
            title: "Preferred Provider",
            description:
              "Signal K Weather plugin ID to use (fallback to Open-Meteo if unavailable)",
            default: "",
          },
          openMeteoEnabled: {
            type: "boolean",
            title: "Enable Open-Meteo",
            description: "Use Open-Meteo as direct NWP source when online",
            default: true,
          },
          useLogbook: {
            type: "boolean",
            title: "Use Logbook Fallback",
            description:
              "Use signalk-logbook entries for cloud cover when no forecast available",
            default: true,
          },
          forecastHours: {
            type: "number",
            title: "Forecast Horizon",
            description: "Hours to fetch and predict",
            default: 48,
            minimum: 24,
            maximum: 168,
          },
        },
      },
      recording: {
        type: "object",
        title: "Recording Configuration",
        description:
          "Store predictions and measured values for the timeline webapp",
        properties: {
          enabled: {
            type: "boolean",
            title: "Enable Recording",
            description:
              "Record prediction cycles and measured samples to disk",
            default: true,
          },
          retentionDays: {
            type: "number",
            title: "Retention Days",
            description: "Number of days to keep recordings before pruning",
            default: 90,
            minimum: 1,
            maximum: 365,
          },
        },
      },
      loadProfile: {
        type: "object",
        title: "Load Profile Configuration",
        description: "Learn sun-phase-based load patterns",
        properties: {
          enabled: {
            type: "boolean",
            title: "Enable Load Profile Learning",
            description:
              "Learn sun-phase-based load patterns instead of using flat averages",
            default: true,
          },
          alpha: {
            type: "number",
            title: "EMA Alpha",
            description:
              "Exponential moving average smoothing factor (lower = slower learning)",
            default: 0.05,
            minimum: 0.01,
            maximum: 0.2,
          },
          minDaysPerBin: {
            type: "number",
            title: "Minimum Days per Bin",
            description:
              "Minimum number of distinct days a bin needs samples from before it's used for prediction",
            default: 3,
            minimum: 1,
            maximum: 10,
          },
          outlierFactor: {
            type: "number",
            title: "Spike Gate Factor",
            description:
              "Samples above this factor × bin EMA are dropped as outliers",
            default: 3,
            minimum: 2,
            maximum: 10,
          },
        },
      },
    },
    required: ["battery", "solarArrays"],
  };
}

/**
 * Parses a manufacturer curve string into an array of points.
 *
 * @param {string} curveStr - Comma-separated pairs: "5,10,10,50,20,100"
 * @returns {Array<{speed: number, watts: number}>} Array of curve points
 */
function parseManufacturerCurve(curveStr) {
  if (!curveStr) {
    return [];
  }

  const parts = curveStr.split(",").map((s) => parseFloat(s.trim()));

  if (parts.length === 0 || parts.some((p) => isNaN(p))) {
    return [];
  }

  const curve = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (i + 1 < parts.length) {
      curve.push({
        speed: parts[i],
        watts: parts[i + 1],
      });
    }
  }

  return curve.sort((a, b) => a.speed - b.speed);
}

/**
 * Gets the active capacity for a solar array based on hardware epochs.
 *
 * @param {object} array - Solar array configuration
 * @param {number[]} array.hardwareEpochs - Hardware epoch configurations
 * @param {number} array.capacityWp - Default current capacity
 * @returns {number} Active capacity in peak watts
 */
function getActiveCapacity(array) {
  if (!array.hardwareEpochs || array.hardwareEpochs.length === 0) {
    return array.capacityWp;
  }

  const now = new Date();

  for (const epoch of array.hardwareEpochs) {
    const start = new Date(epoch.startDate);
    const end = epoch.endDate
      ? new Date(epoch.endDate)
      : new Date("2099-12-31");

    if (now >= start && now <= end) {
      return epoch.capacityWp;
    }
  }

  return array.capacityWp;
}

/**
 * Gets the display name for an array or generator.
 *
 * @param {object} config - Array or generator configuration
 * @param {string} config.id - ID
 * @param {string} config.name - Display name
 * @returns {string} Display name
 */
function getDisplayName(config) {
  return config.name || config.id;
}

/**
 * Validates plugin configuration for common issues.
 * Warns about duplicate power paths and controller mode paths.
 *
 * @param {object} config - Plugin configuration
 * @returns {{valid: boolean, warnings: string[]}} Validation result
 */
function validateConfig(config) {
  const warnings = [];
  const powerPaths = new Map(); // path -> owner ID
  const controllerModePaths = new Map(); // path -> owner ID

  // Check solar arrays for duplicate power paths
  if (config.solarArrays) {
    for (const array of config.solarArrays) {
      // Skip disabled arrays
      if (array.enabled === false) {
        continue;
      }

      if (array.powerPath) {
        const ownerId = powerPaths.get(array.powerPath);
        if (ownerId) {
          warnings.push(
            "Duplicate power path: " +
              array.powerPath +
              " (already used by " +
              ownerId +
              ")",
          );
        }
        powerPaths.set(array.powerPath, array.id);
      }

      if (array.controllerModePath) {
        const ownerId = controllerModePaths.get(array.controllerModePath);
        if (ownerId) {
          warnings.push(
            "Duplicate controller mode path: " +
              array.controllerModePath +
              " (already used by " +
              ownerId +
              ")",
          );
        }
        controllerModePaths.set(array.controllerModePath, array.id);
      }
    }
  }

  // Check mechanical generators for duplicate power paths
  if (config.mechanicalGenerators) {
    for (const gen of config.mechanicalGenerators) {
      // Skip disabled generators
      if (gen.enabled === false) {
        continue;
      }

      if (gen.powerPath) {
        const ownerId = powerPaths.get(gen.powerPath);
        if (ownerId) {
          warnings.push(
            "Generator shares power path: " +
              gen.powerPath +
              " (already used by " +
              ownerId +
              ")",
          );
        }
        powerPaths.set(gen.powerPath, gen.id);
      }
    }
  }

  return {
    valid: true,
    warnings,
  };
}

module.exports = {
  buildPluginSchema,
  parseManufacturerCurve,
  getActiveCapacity,
  getDisplayName,
  validateConfig,
};
