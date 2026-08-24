#!/usr/bin/env node

/**
 * Backfill CLI for cycle advisories.
 *
 * Recomputes the surplus/engine-run/stowage advisories for recorded cycle
 * records across a date range and writes them back into the JSONL day-files
 * in place. This both retroactively populates the `advisories` field on old
 * cycles (so the webapp Events list shows surplus/deficit history for
 * verification) and overwrites any transient advisory a glitchy cycle may
 * have recorded (e.g. an empty-weather + SoC-fallback transient producing
 * a bogus 24h "run the engine" — recomputed with the corrected shortfall-
 * to-floor logic, that cycle now yields no engine-run advisory).
 *
 * The recompute is pure: it works from each cycle's stored forecast track
 * with no dependency on the live Signal K tree or the wall clock, so it is
 * deterministic and safe to re-run.
 *
 * Usage:
 *   node bin/backfill-advisories.js \
 *     --data-dir=~/.signalk/plugin-config-data/signalk-energy-predictor \
 *     --from=2026-08-01 --to=2026-08-31
 *   node bin/backfill-advisories.js \
 *     --data-dir=~/.signalk/plugin-config-data/signalk-energy-predictor \
 *     --from=2026-08-23 --to=2026-08-23 --dry-run
 *
 * Args:
 *   --data-dir=<path>  Plugin data directory (recordings/ lives under it)
 *   --from=YYYY-MM-DD  Start date (inclusive, UTC). Default: earliest file
 *   --to=YYYY-MM-DD    End date (inclusive, UTC). Default: latest file
 *   --config=<path>    Plugin config JSON (for battery/surplus settings).
 *                      Default: <data-dir>/../signalk-energy-predictor.json
 *   --dry-run          Recompute and print a summary, don't write files
 *
 * @file backfill-advisories.js
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const { recomputeAdvisories } = require("../plugin/advisory-recompute.js");
const { getRecordingsPath } = require("../plugin/recorder.js");

function expandPath(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function parseDateArg(s) {
  // YYYY-MM-DD, interpreted as UTC midnight
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

async function findDateRange(recordingsDir) {
  const files = (await readdir(recordingsDir))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  if (files.length === 0) return null;
  const from = parseDateArg(basename(files[0], ".jsonl"));
  const to = parseDateArg(basename(files[files.length - 1], ".jsonl"));
  return { from, to };
}

function loadConfig(configPath) {
  // Mirrors the plugin's DEFAULT_CONFIG merge for the fields the recompute
  // needs. Only the battery + surplus subsections matter here.
  const batteryDefaults = {
    capacityAh: 400,
    systemVoltage: 12,
    minSafeSoC: 0.2,
  };
  const surplusDefaults = {
    fullThreshold: 0.95,
    minSurplusWh: 300,
    maxLeadHours: 36,
    opportunisticLoads: [],
  };
  if (!existsSync(configPath)) {
    return {
      battery: batteryDefaults,
      surplus: surplusDefaults,
      engines: [{ id: "main", name: "Engine", alternatorWatts: 100 }],
      gensets: [],
      combustion: {},
    };
  }
  const raw = JSON.parse(readFileSyncSafe(configPath));
  const cfg = raw.configuration || raw || {};
  const battery = { ...batteryDefaults, ...(cfg.battery || {}) };
  const surplus = { ...surplusDefaults, ...(cfg.surplus || {}) };
  // Combustion sources (#11): engines with their alternators, gensets,
  // and per-tier run discipline. Pre-#11 configs carry a single
  // battery.engineAlternatorWatts — normalized into a default "main"
  // engine when no engines array is configured (mirrors the plugin's
  // getActiveEngines).
  let engines = Array.isArray(cfg.engines)
    ? cfg.engines.filter((e) => e && e.id)
    : [];
  if (
    engines.length === 0 &&
    typeof cfg.battery?.engineAlternatorWatts === "number" &&
    cfg.battery.engineAlternatorWatts > 0 &&
    !Array.isArray(cfg.engines)
  ) {
    engines = [
      {
        id: "main",
        name: "Engine",
        alternatorWatts: cfg.battery.engineAlternatorWatts,
      },
    ];
  }
  const gensets = (cfg.gensets || []).filter(
    (g) => g && g.id && typeof g.outputWatts === "number",
  );
  return {
    battery,
    surplus,
    engines,
    gensets,
    combustion: cfg.combustion || {},
  };
}

function readFileSyncSafe(p) {
  // sync read for simplicity in a one-shot CLI
  const { readFileSync } = require("node:fs");
  return readFileSync(p, { encoding: "utf-8" });
}

async function processDayFile(filePath, opts) {
  let lines;
  try {
    lines = (await readFile(filePath, { encoding: "utf-8" })).split("\n");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let cycles = 0;
  let changed = 0;
  let added = 0;
  let removed = 0;
  const out = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    if (record.type !== "cycle") {
      out.push(line);
      continue;
    }
    cycles++;
    const cycleTime = new Date(record.timestamp);
    const forecast = (record.forecast || []).map((p) => ({
      ...p,
      time: p.time,
    }));
    const oldAdvisories = record.advisories || [];
    const advisories = recomputeAdvisories(forecast, {
      cycleTime,
      minSafeSoC: opts.battery.minSafeSoC,
      capacityWh: opts.battery.capacityAh * opts.battery.systemVoltage,
      engines: opts.engines || [],
      gensets: opts.gensets || [],
      combustion: opts.combustion || {},
      localOffsetMinutes: opts.localOffsetMinutes ?? null,
      opportunisticLoads: opts.surplus.opportunisticLoads || [],
    });
    record.advisories = advisories;
    changed++;
    if (oldAdvisories.length === 0 && advisories.length > 0) added++;
    if (oldAdvisories.length > 0 && advisories.length === 0) removed++;
    out.push(JSON.stringify(record));
  }
  return { cycles, changed, added, removed, out, changedAny: changed > 0 };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      config: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const dataDir = expandPath(values["data-dir"]);
  if (!dataDir) {
    console.error("Error: --data-dir is required");
    process.exit(1);
  }
  const recordingsDir = join(dataDir, "recordings");
  if (!existsSync(recordingsDir)) {
    console.error(`Error: recordings dir not found: ${recordingsDir}`);
    process.exit(1);
  }

  let from = values.from ? parseDateArg(values.from) : null;
  let to = values.to ? parseDateArg(values.to) : null;
  if (!from || !to) {
    const range = await findDateRange(recordingsDir);
    if (!range) {
      console.error("No recording day-files found.");
      process.exit(1);
    }
    from = from || range.from;
    to = to || range.to;
  }

  const configPath = expandPath(
    values.config || join(dirname(dataDir), "signalk-energy-predictor.json"),
  );
  const { battery, surplus, engines, gensets, combustion } =
    loadConfig(configPath);
  const engineList =
    engines.map((e) => `${e.id}:${e.alternatorWatts}W`).join(", ") || "none";

  console.error(
    `Backfilling advisories ${from.toISOString()} → ${to.toISOString()}`,
  );
  console.error(`  data-dir: ${dataDir}`);
  console.error(`  config:   ${configPath}`);
  console.error(
    `  battery:  ${battery.capacityAh}Ah @ ${battery.systemVoltage}V, floor ${battery.minSafeSoC}, engines ${engineList}`,
  );
  console.error(`  dry-run:  ${values["dry-run"] ? "yes" : "no"}`);

  const opts = {
    battery,
    surplus,
    engines,
    gensets,
    combustion,
    localOffsetMinutes: null,
  };

  let totalCycles = 0;
  let totalChanged = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  let filesWritten = 0;

  const current = new Date(from);
  while (current <= to) {
    const filePath = getRecordingsPath(dataDir, current);
    const result = await processDayFile(filePath, opts);
    if (result) {
      totalCycles += result.cycles;
      totalChanged += result.changed;
      totalAdded += result.added;
      totalRemoved += result.removed;
      if (result.changedAny && !values["dry-run"]) {
        await writeFile(filePath, result.out.join("\n"), { encoding: "utf-8" });
        filesWritten++;
      }
      if (result.cycles > 0) {
        console.error(
          `  ${current.toISOString().slice(0, 10)}: ${result.cycles} cycles, ${result.changed} rewritten (+${result.added} added, -${result.removed} cleared)`,
        );
      }
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  console.error(
    `\nDone: ${totalCycles} cycles, ${totalChanged} rewritten, +${totalAdded} advisories added, -${totalRemoved} cleared, ${filesWritten} files written.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
