#!/usr/bin/env node

/**
 * Backfill CLI for cycle advisories.
 *
 * Recomputes the surplus/engine-run/stowage advisories for recorded cycle
 * records across a date range and writes them back into the SQLite record
 * store in place. This both retroactively populates the `advisories` field
 * on old cycles (so the webapp Events list shows surplus/deficit history
 * for verification) and overwrites any transient advisory a glitchy cycle
 * may have recorded (e.g. an empty-weather + SoC-fallback transient
 * producing a bogus 24h "run the engine" — recomputed with the corrected
 * shortfall-to-floor logic, that cycle now yields no engine-run advisory).
 *
 * The recompute is pure: it works from each cycle's stored forecast track
 * with no dependency on the live Signal K tree or the wall clock, so it is
 * deterministic and safe to re-run.
 *
 * Legacy NDJSON day files are imported first when `recordings/` still
 * exists (same idempotent importer the plugin start runs).
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
 *   --data-dir=<path>  Plugin data directory (records.db lives under it)
 *   --from=YYYY-MM-DD  Start date (inclusive, UTC). Default: earliest cycle
 *   --to=YYYY-MM-DD    End date (inclusive, UTC). Default: latest cycle
 *   --config=<path>    Plugin config JSON (for battery/surplus settings).
 *                      Default: <data-dir>/../signalk-energy-predictor.json
 *   --dry-run          Recompute and print a summary, don't write rows
 *
 * @file backfill-advisories.js
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const { recomputeAdvisories } = require("../plugin/advisory-recompute.js");
const { RecordStore } = require("../plugin/storage.js");
const { migrateNdjsonRecordings } = require("../plugin/storage-migrate.js");
const { attachForecasts } = require("../plugin/api.js");

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

async function processWindow(store, from, to, opts, dryRun) {
  const cycles = await store.getRecords("cycle", from, to);
  await attachForecasts(store, cycles);
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const record of cycles) {
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
    if (!dryRun) {
      store.writeRecord("cycle", record.timestamp, record);
    }
  }
  return { cycles: cycles.length, changed, added, removed };
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

  const store = new RecordStore({ debug() {}, error() {} }, dataDir, {});
  store.open();

  // Import legacy NDJSON first when present (idempotent; same as plugin
  // start would do)
  if (existsSync(join(dataDir, "recordings"))) {
    const migration = await migrateNdjsonRecordings({
      app: {
        debug() {},
        error(msg) {
          console.error(`  import: ${msg}`);
        },
      },
      store,
      dataDir,
    });
    if (migration.imported > 0) {
      console.error(
        `  imported ${migration.imported} NDJSON records from ${migration.files} day file(s)`,
      );
    }
  }

  // A store with no cycles at all means a wrong --data-dir (or a
  // recorder that never ran): recomputing nothing is never intended
  if (!store.recordsRange("cycle")) {
    console.error("No recorded cycles found.");
    store.close();
    process.exit(1);
  }

  let from = values.from ? parseDateArg(values.from) : null;
  let to = values.to ? parseDateArg(values.to) : null;
  if (!from || !to) {
    const range = store.recordsRange("cycle");
    if (!range) {
      console.error("No recorded cycles found.");
      store.close();
      process.exit(1);
    }
    from = from || new Date(range.from);
    to = to || new Date(range.to);
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

  const current = new Date(from);
  while (current <= to) {
    const dayEnd = new Date(current.getTime() + 86400000 - 1);
    const result = await processWindow(
      store,
      current,
      dayEnd,
      opts,
      values["dry-run"],
    );
    totalCycles += result.cycles;
    totalChanged += result.changed;
    totalAdded += result.added;
    totalRemoved += result.removed;
    if (result.cycles > 0) {
      console.error(
        `  ${current.toISOString().slice(0, 10)}: ${result.cycles} cycles, ${result.changed} rewritten (+${result.added} added, -${result.removed} cleared)`,
      );
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }

  store.close();

  console.error(
    `\nDone: ${totalCycles} cycles, ${totalChanged} rewritten, +${totalAdded} advisories added, -${totalRemoved} cleared${values["dry-run"] ? " (dry run)" : ""}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
