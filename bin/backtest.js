#!/usr/bin/env node
/**
 * Backtesting CLI for Energy Predictor.
 *
 * Replays historical data through a sandboxed EMA matrix and outputs
 * statistical validation (MAE, drift analysis).
 *
 * Usage: node bin/backtest.js --from="2024-01-01" --to="2024-01-07" --provider="signalk-to-influxdb2"
 *
 * @file backtest.js
 */

import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SolarMatrix } from "../plugin/learning.js";
import { sunPosition, maxIrradiance, irradianceFromCloudCover } from "../plugin/solar.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Parses command line arguments.
 *
 * @returns {{from: Date, to: Date, provider: string, config: object, output: string|null}}
 */
function parseArguments() {
  const { values } = parseArgs({
    options: {
      from: {
        type: "string",
        default: new Date(Date.now() - 7 * 24 * 3600000).toISOString().split("T")[0],
      },
      to: {
        type: "string",
        default: new Date().toISOString().split("T")[0],
      },
      provider: {
        type: "string",
        default: "",
      },
      config: {
        type: "string",
        default: join(__dirname, "../config.json"),
      },
      output: {
        type: "string",
        default: null,
      },
    },
  });

  return {
    from: new Date(values.from),
    to: new Date(values.to),
    provider: values.provider,
    configPath: values.config,
    outputPath: values.output,
  };
}

/**
 * Reads the plugin configuration.
 *
 * @param {string} path - Path to config file
 * @returns {Promise<object>}
 */
async function readConfig(path) {
  const content = await readFile(path, "utf-8");
  return JSON.parse(content);
}

/**
 * Queries Signal K History API for historical data.
 *
 * @param {string} baseUrl - Signal K server base URL
 * @param {string} provider - History provider ID
 * @param {Date} from - Start date
 * @param {Date} to - End date
 * @param {string[]} paths - Signal K paths to query
 * @param {number} resolution - Resolution in seconds
 * @returns {Promise<object>} Historical data
 */
async function queryHistory(baseUrl, provider, from, to, paths, resolution = 300) {
  const url = new URL(`${baseUrl}/signalk/v2/api/history/values`);
  url.searchParams.set("paths", paths.join(","));
  url.searchParams.set("from", from.toISOString());
  url.searchParams.set("to", to.toISOString());
  url.searchParams.set("resolution", resolution.toString());

  if (provider) {
    url.searchParams.set("provider", provider);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`History API returned ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Fetches historical weather data from Open-Meteo.
 *
 * @param {number} latitude - Latitude in degrees
 * @param {number} longitude - Longitude in degrees
 * @param {Date} from - Start date
 * @param {Date} to - End date
 * @returns {Promise<Array<{time: Date, ghi: number, cloudCover: number}>>}
 */
async function fetchHistoricalWeather(latitude, longitude, from, to) {
  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.searchParams.set("latitude", latitude.toString());
  url.searchParams.set("longitude", longitude.toString());
  url.searchParams.set("start_date", from.toISOString().split("T")[0]);
  url.searchParams.set("end_date", to.toISOString().split("T")[0]);
  url.searchParams.set("hourly", "shortwave_radiation,total_cloud_cover");
  url.searchParams.set("timezone", "UTC");

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Open-Meteo Archive API returned ${response.status}`);
  }

  const data = await response.json();

  if (!data.hourly || !data.hourly.time) {
    return [];
  }

  return data.hourly.time.map((time, i) => ({
    time: new Date(time),
    ghi: data.hourly.shortwave_radiation?.[i] ?? null,
    cloudCover: data.hourly.total_cloud_cover?.[i] ?? null,
  }));
}

/**
 * Interpolates weather data for a specific time.
 *
 * @param {Array<{time: Date, ghi: number|null, cloudCover: number|null}>} weather
 * @param {Date} time - Target time
 * @returns {{ghi: number, cloudCover: number|null}}
 */
function interpolateWeather(weather, time) {
  // Find closest point
  let closest = null;
  let minDiff = Infinity;

  for (const point of weather) {
    const diff = Math.abs(point.time.getTime() - time.getTime());
    if (diff < minDiff) {
      minDiff = diff;
      closest = point;
    }
  }

  if (!closest || minDiff > 3600000) {
    // No data within 1 hour
    return { ghi: 0, cloudCover: null };
  }

  // If we have direct GHI, use it
  if (closest.ghi != null) {
    return { ghi: closest.ghi, cloudCover: closest.cloudCover };
  }

  // Otherwise synthesize from cloud cover
  if (closest.cloudCover != null) {
    // Need position for sun position
    // This will be provided by the caller in a real implementation
    return { ghi: null, cloudCover: closest.cloudCover };
  }

  return { ghi: 0, cloudCover: null };
}

/**
 * Backtests a solar array against historical data.
 *
 * @param {object} params
 * @param {object} params.array - Solar array configuration
 * @param {string} params.baseUrl - Signal K server base URL
 * @param {string} params.provider - History provider ID
 * @param {Date} params.from - Start date
 * @param {Date} params.to - End date
 * @param {number} params.latitude - Latitude
 * @param {number} params.longitude - Longitude
 * @returns {Promise<object>} Backtest results
 */
async function backtestArray({ array, baseUrl, provider, from, to, latitude, longitude }) {
  const powerPath = array.powerPath;
  if (!powerPath) {
    throw new Error(`Array ${array.id} has no power path configured`);
  }

  // Fetch historical solar output and weather
  const [historyData, weather] = await Promise.all([
    queryHistory(baseUrl, provider, from, to, [powerPath], 300),
    fetchHistoricalWeather(latitude, longitude, from, to),
  ]);

  // Create sandboxed matrix
  const matrix = new SolarMatrix(array.id);

  let totalPredictedWh = 0;
  let totalActualWh = 0;
  let errors = [];
  let binUpdates = 0;

  // Replay data
  const { data: dataPoints, values: valueDefs } = historyData;
  const powerDef = valueDefs.find((v) => v.path === powerPath);
  const powerIndex = valueDefs.indexOf(powerDef);

  for (const point of dataPoints) {
    const time = new Date(point[0]);
    const powerRaw = point[powerIndex + 1];

    if (powerRaw == null) {
      continue;
    }

    const actualPowerW = typeof powerRaw === "number" ? powerRaw : powerRaw.value || 0;

    if (actualPowerW <= 0) {
      continue;
    }

    // Get weather for this time
    const weatherData = interpolateWeather(weather, time);
    let ghi = weatherData.ghi;

    if (ghi == null && weatherData.cloudCover != null) {
      const sunPos = sunPosition(time, latitude, longitude);
      ghi = irradianceFromCloudCover(sunPos.altitude, weatherData.cloudCover);
    }

    if (ghi == null || ghi <= 0) {
      continue;
    }

    // Calculate theoretical power
    const sunPos = sunPosition(time, latitude, longitude);
    const capacityWp = array.capacityWp;
    const sinElevation = Math.sin(sunPos.altitude);

    if (sinElevation <= 0) {
      continue;
    }

    const theoreticalPower = capacityWp * (ghi / 1367) * sinElevation;
    const efficiency = matrix.getAnchored(sunPos.azimuth, sunPos.altitude);
    const predictedPower = theoreticalPower * efficiency;

    // Update matrix
    matrix.update({
      navState: "anchored",
      actualPowerW,
      capacityWp,
      ghi,
      sunAzimuthRad: sunPos.azimuth,
      sunElevationRad: sunPos.altitude,
      awaRad: null,
      readings: {
        engineRpm: 0,
        batterySoc: 0.5,
        shorePowerConnected: false,
      },
    });

    binUpdates++;

    // Accumulate values (assuming 5-minute intervals for Wh calculation)
    const intervalHours = 300 / 3600;
    totalActualWh += actualPowerW * intervalHours;
    totalPredictedWh += predictedPower * intervalHours;

    // Track error
    errors.push(Math.abs(predictedPower - actualPowerW));
  }

  // Calculate statistics
  const mae = errors.length > 0 ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;
  const maeRelative = errors.length > 0 && totalActualWh > 0 ? mae / (totalActualWh / (errors.length * 300 / 3600)) : 0;
  const rmse = errors.length > 0 ? Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length) : 0;

  // Check for bin drift
  const anchoredBins = matrix.toJSON().anchored;
  const binEfficiencies = Object.values(anchoredBins);
  const avgBinEfficiency = binEfficiencies.length > 0 ? binEfficiencies.reduce((a, b) => a + b, 0) / binEfficiencies.length : 0.7;
  const binDrift = binEfficiencies.length > 0 ? Math.max(...binEfficiencies) - Math.min(...binEfficiencies) : 0;

  return {
    arrayId: array.id,
    from: from.toISOString(),
    to: to.toISOString(),
    dataPoints: errors.length,
    binUpdates,
    totalActualWh: Math.round(totalActualWh),
    totalPredictedWh: Math.round(totalPredictedWh),
    accuracy: totalActualWh > 0 ? totalPredictedWh / totalActualWh : 0,
    mae: Math.round(mae * 100) / 100,
    maeRelative: Math.round(maeRelative * 100) / 100,
    rmse: Math.round(rmse * 100) / 100,
    avgBinEfficiency: Math.round(avgBinEfficiency * 100) / 100,
    binDrift: Math.round(binDrift * 100) / 100,
    matrix: matrix.toJSON(),
  };
}

/**
 * Runs the backtest for all configured solar arrays.
 *
 * @returns {Promise<void>}
 */
async function main() {
  try {
    console.log("Signal K Energy Predictor - Backtesting Tool");
    console.log("=".repeat(50));

    const args = parseArguments();
    const config = await readConfig(args.configPath);

    // Get Signal K server URL
    const baseUrl = process.env.SIGNALK_SERVER_URL || "http://localhost:3000";

    // Get position from config or environment
    const latitude = Number(process.env.LATITUDE || 0);
    const longitude = Number(process.env.LONGITUDE || 0);

    if (latitude === 0 && longitude === 0) {
      console.warn("Warning: No position set (LATITUDE/LONGITUDE env vars), using 0,0");
    }

    console.log(`\nConfiguration:`);
    console.log(`  Server: ${baseUrl}`);
    console.log(`  Provider: ${args.provider || "(default)"}`);
    console.log(`  Period: ${args.from.toISOString().split("T")[0]} to ${args.to.toISOString().split("T")[0]}`);
    console.log(`  Position: ${latitude}°, ${longitude}°`);
    console.log(`  Solar Arrays: ${config.solarArrays?.length || 0}`);

    const results = [];

    for (const array of config.solarArrays || []) {
      if (!array.enabled !== false && array.powerPath) {
        console.log(`\nBacktesting ${array.id}...`);
        const result = await backtestArray({
          array,
          baseUrl,
          provider: args.provider,
          from: args.from,
          to: args.to,
          latitude,
          longitude,
        });
        results.push(result);

        console.log(`  Data points: ${result.dataPoints}`);
        console.log(`  Bin updates: ${result.binUpdates}`);
        console.log(`  Actual yield: ${result.totalActualWh} Wh`);
        console.log(`  Predicted yield: ${result.totalPredictedWh} Wh`);
        console.log(`  Accuracy: ${(result.accuracy * 100).toFixed(1)}%`);
        console.log(`  MAE: ${result.mae} W`);
        console.log(`  Bin drift: ${result.binDrift}`);
      }
    }

    // Summary
    console.log(`\n${"=".repeat(50)}`);
    console.log("SUMMARY");
    console.log("=".repeat(50));

    if (results.length === 0) {
      console.log("No arrays backtested");
    } else {
      const avgAccuracy = results.reduce((a, b) => a + b.accuracy, 0) / results.length;
      const avgMAE = results.reduce((a, b) => a + b.mae, 0) / results.length;

      console.log(`Arrays tested: ${results.length}`);
      console.log(`Average accuracy: ${(avgAccuracy * 100).toFixed(1)}%`);
      console.log(`Average MAE: ${avgMAE.toFixed(2)} W`);

      const driftResults = results.filter((r) => r.binDrift > 0.3);
      if (driftResults.length > 0) {
        console.log(`\nWarning: High bin drift detected on:`);
        for (const r of driftResults) {
          console.log(`  ${r.arrayId}: ${r.binDrift} (consider tuning bin resolution)`);
        }
      }
    }

    // Output to file if requested
    if (args.outputPath) {
      const output = {
        config: args,
        results,
        timestamp: new Date().toISOString(),
      };
      await writeFile(args.outputPath, JSON.stringify(output, null, 2), "utf-8");
      console.log(`\nResults saved to ${args.outputPath}`);
    }
  } catch (error) {
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  }
}

main();