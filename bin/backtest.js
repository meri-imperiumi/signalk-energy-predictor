#!/usr/bin/env node

/**
 * Backtesting and backfill CLI for Energy Predictor.
 *
 * Replays remote Signal K history through the learning machinery.
 *
 * Modes:
 * - Backtest (default): sandboxed matrices, validation stats only,
 *   nothing persisted
 * - Populate: `--populate --data-dir=<plugin data dir>` seeds matrices
 *   from existing files in the data dir, replays the remote history
 *   through them, persists results via the standard matrix persistence,
 *   and gap-fills the recordings store with pre-install samples
 *
 * Usage:
 *   node bin/backtest.js --from=2026-08-01 --to=2026-08-21 \
 *     --provider=signalk-history-sqlite
 *   node bin/backtest.js --populate --data-dir=~/.signalk/plugin-config-data/signalk-energy-predictor
 *
 * Environment:
 *   SIGNALK_TOKEN   bearer token for the History API (security-enabled servers)
 *   SIGNALK_URL     server base URL (default http://localhost:3000)
 *
 * @file backtest.js
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const {
  DEFAULT_RESOLUTION,
  discoverPropulsionPaths,
  queryHistory,
  fetchHistoricalWeatherTrack,
  dailyPositionsFromHistory,
  replayHistory,
  replayGenerators,
  populateFromHistory,
} = require("../plugin/history-backfill.js");
const { SolarMatrix } = require("../plugin/learning.js");
const { parseManufacturerCurve } = require("../plugin/schema.js");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Parses command line arguments.
 */
function parseArguments() {
  const { values } = parseArgs({
    options: {
      from: {
        type: "string",
        default: new Date(Date.now() - 7 * 24 * 3600000)
          .toISOString()
          .split("T")[0],
      },
      to: {
        type: "string",
        default: new Date().toISOString().split("T")[0],
      },
      provider: { type: "string", default: "" },
      config: {
        type: "string",
        default: join(__dirname, "../plugin-config.json"),
      },
      output: { type: "string" },
      populate: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      "data-dir": { type: "string" },
      "base-url": {
        type: "string",
        default: process.env.SIGNALK_URL || "http://localhost:3000",
      },
      resolution: { type: "string", default: String(DEFAULT_RESOLUTION) },
    },
  });
  return values;
}

/**
 * Loads the plugin configuration (solar arrays, generators, battery).
 *
 * @param {string} configPath
 * @returns {Promise<object>}
 */
async function loadConfig(configPath) {
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8"));
    return raw.configuration || raw;
  } catch (_error) {
    console.error(
      `Could not read config at ${configPath} — pass --config=<path>`,
    );
    process.exit(1);
  }
}

/**
 * Prints replay results as a table.
 *
 * @param {Array<object>} results
 */
function printResults(results) {
  for (const r of results) {
    const name = r.arrayId || r.id;
    console.log(`\n${name} (${r.type ?? "solar"}):`);
    console.log(`  data points:  ${r.dataPoints}`);
    if (r.binUpdates != null) {
      console.log(
        `  bin updates:  ${r.binUpdates} (dropped: ${r.droppedTicks})`,
      );
      console.log(`  sailing bins: ${r.sailingTicks ?? 0}`);
    }
    console.log(`  actual:       ${r.totalActualWh} Wh`);
    console.log(`  predicted:    ${r.totalPredictedWh} Wh`);
    console.log(`  MAE:          ${r.mae} W`);
    console.log(`  RMSE:         ${r.rmse} W`);
  }
}

/**
 * Runs backtest mode: sandboxed matrices, stats only.
 */
async function runBacktest(args) {
  const config = await loadConfig(args.config);
  const from = new Date(`${args.from}T00:00:00Z`);
  const to = new Date(`${args.to}T23:59:59Z`);

  const arrays = (config.solarArrays || []).filter(
    (a) => a.enabled !== false && a.powerPath,
  );
  const generators = (config.mechanicalGenerators || [])
    .filter((g) => g.enabled !== false && g.powerPath)
    .map((g) => ({
      ...g,
      curve: Array.isArray(g.curve)
        ? g.curve
        : parseManufacturerCurve(g.manufacturerCurve),
    }));

  const socPath =
    config.battery?.socPath ||
    "electrical.batteries.house.capacity.stateOfCharge";

  let propulsionPaths = [];
  try {
    propulsionPaths = await discoverPropulsionPaths({
      baseUrl: args["base-url"],
      from,
      to,
      provider: args.provider || undefined,
    });
  } catch (_error) {
    // Engine gating degrades to unknown
  }

  const paths = Array.from(
    new Set([
      ...arrays.map((a) => a.powerPath),
      ...generators.map((g) => g.powerPath),
      socPath,
      "navigation.state",
      "environment.wind.angleApparent",
      "navigation.speedThroughWater",
      "navigation.position",
      ...propulsionPaths,
    ]),
  );

  // History first: vessel positions drive the weather-track fetch
  const historyData = await queryHistory({
    baseUrl: args["base-url"],
    provider: args.provider || undefined,
    from,
    to,
    paths,
    resolution: parseInt(args.resolution, 10),
  });
  const dailyPositions = dailyPositionsFromHistory(historyData, from, to);
  const weather =
    dailyPositions.length > 0
      ? await fetchHistoricalWeatherTrack({ dailyPositions })
      : [];

  const results = [];
  for (const array of arrays) {
    // Sandboxed: a fresh matrix, never persisted
    const matrix = new SolarMatrix(array.id);
    const stats = replayHistory({
      matrix,
      array,
      socPath,
      historyData,
      weather,
      resolution: parseInt(args.resolution, 10),
    });
    results.push({ arrayId: array.id, type: "solar", ...stats });
  }

  const genResults = replayGenerators({
    generators,
    historyData,
    weather,
    resolution: parseInt(args.resolution, 10),
  });

  printResults([...results, ...genResults]);

  if (args.output) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      args.output,
      JSON.stringify({ arrays: results, generators: genResults }, null, 2),
    );
    console.error(`\nResults written to ${args.output}`);
  }
}

/**
 * Runs populate mode: seeds, replays, persists, and gap-fills recordings.
 */
async function runPopulate(args) {
  if (!args["data-dir"]) {
    console.error("Populate mode needs --data-dir=<plugin data dir>");
    process.exit(1);
  }

  const config = await loadConfig(args.config);
  const result = await populateFromHistory({
    config,
    baseUrl: args["base-url"],
    provider: args.provider || undefined,
    from: new Date(`${args.from}T00:00:00Z`),
    to: new Date(`${args.to}T23:59:59Z`),
    dataDir: args["data-dir"].replace("~", process.env.HOME || "~"),
    fresh: args.fresh,
    resolution: parseInt(args.resolution, 10),
  });

  printResults([...result.arrays, ...result.generators]);
  console.log(`\nSamples written to recordings: ${result.samplesWritten}`);
  if (result.deployStatesBackfilled != null) {
    console.log(
      `Samples augmented with deploy states: ${result.deployStatesBackfilled}`,
    );
  }
  if (result.loadProfile) {
    const lp = result.loadProfile;
    console.log(
      `Load profile: ${lp.ingested} ingested, ${lp.gated} gated (${lp.learnedBins} bins learned${lp.seeded ? ", built on saved profile" : ", fresh"})`,
    );
  }
  if (result.windProtection) {
    const wp = result.windProtection;
    console.log(
      `Wind protection: ${wp.samples} samples learned (${wp.dataPoints} data points, ${wp.skippedUnderway} under-way, ${wp.skippedDwell} dwell-skipped) across ${wp.places} anchorage(s)${wp.seeded ? ", built on saved store" : ", fresh"}`,
    );
  } else {
    console.log("Wind protection: disabled in config");
  }
  if (args.fresh) {
    console.log("Matrices rebuilt from scratch (fresh)");
  } else {
    console.log("Matrices persisted to plugin data dir");
  }
}

const args = parseArguments();
if (args.populate) {
  await runPopulate(args);
} else {
  await runBacktest(args);
}
