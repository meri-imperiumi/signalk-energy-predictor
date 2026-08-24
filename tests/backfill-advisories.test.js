/**
 * Smoketest for the backfill-advisories CLI.
 *
 * Spins up a temp data dir with a synthetic cycle record (a surplus
 * scenario), runs the CLI, and asserts the cycle's `advisories` field is
 * populated with a surplus advisory. Also checks the degenerate transient
 * cycle gets NO engine-run advisory (the cleanup case).
 *
 * @file backfill-advisories.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

function makeCycleRecord(timestamp, forecast) {
  return {
    type: "cycle",
    timestamp,
    weatherTier: 1,
    forecast,
    actions: [],
    advisories: [],
  };
}

function surplusForecast() {
  // Bank full from hour 0, solar continues above load → curtailed surplus
  const now = "2026-08-23T12:00:00.000Z";
  const points = [];
  for (let i = 0; i < 4; i++) {
    points.push({
      time: new Date(Date.parse(now) + i * 3600000).toISOString(),
      idealSoC: i < 3 ? 1.0 : 0.95,
      idealSolarYieldWh: [300, 350, 400, 100][i],
      idealWindYieldWh: 0,
      idealHydroYieldWh: 0,
      houseLoadWh: 130,
      idealNetWh: [170, 220, 270, -30][i],
    });
  }
  return points;
}

function transientForecast() {
  // Degenerate: zero solar, SoC drains to the floor (the 2026-08-23 23:45
  // glitch signature). Should produce NO engine-run advisory after recompute.
  const now = "2026-08-23T23:45:00.000Z";
  const points = [];
  let soc = 0.5;
  for (let i = 0; i < 24; i++) {
    points.push({
      time: new Date(Date.parse(now) + i * 3600000).toISOString(),
      idealSoC: Math.max(0, soc),
      idealSolarYieldWh: 0,
      idealWindYieldWh: 0,
      idealHydroYieldWh: 0,
      houseLoadWh: 126,
      idealNetWh: -126,
    });
    soc -= 0.026;
  }
  return points;
}

function runCLI(dataDir, { from, to, dryRun = false } = {}) {
  const args = ["bin/backfill-advisories.js", `--data-dir=${dataDir}`];
  if (from) args.push(`--from=${from}`);
  if (to) args.push(`--to=${to}`);
  if (dryRun) args.push("--dry-run");
  return spawnSync(process.execPath, args, {
    encoding: "utf-8",
    cwd: process.cwd(),
  });
}

test("backfill-advisories: populates surplus advisory on a cycle record", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ep-backfill-"));
  mkdirSync(join(tmp, "recordings"), { recursive: true });
  const file = join(tmp, "recordings", "2026-08-23.jsonl");
  const cycle = makeCycleRecord("2026-08-23T12:00:00.000Z", surplusForecast());
  // Add a transient cycle too, to verify cleanup
  const transient = makeCycleRecord(
    "2026-08-23T23:45:00.000Z",
    transientForecast(),
  );
  // Give the transient a bogus pre-existing engine_run advisory (simulating
  // the recorded bug) so we can assert it gets cleared.
  transient.advisories = [
    {
      type: "engine_run",
      time: "2026-08-24T00:00:00.000Z",
      message: "Run engine for 24h (BOGUS)",
      engineHours: 24,
    },
  ];
  writeFileSync(
    file,
    `${JSON.stringify(cycle)}\n${JSON.stringify(transient)}\n`,
  );

  const res = runCLI(tmp, { from: "2026-08-23", to: "2026-08-23" });
  assert.strictEqual(res.status, 0, `CLI failed: ${res.stderr}`);

  // Re-read and parse
  const lines = readFileSync(file, { encoding: "utf-8" })
    .split("\n")
    .filter((l) => l.trim());
  assert.strictEqual(lines.length, 2);
  const c1 = JSON.parse(lines[0]);
  const c2 = JSON.parse(lines[1]);

  // Surplus cycle: should now have a surplus advisory
  assert.ok(Array.isArray(c1.advisories), "advisories should be an array");
  const surplus = c1.advisories.find((a) => a.type === "surplus");
  assert.ok(
    surplus,
    `surplus cycle should have a surplus advisory: ${JSON.stringify(c1.advisories)}`,
  );
  assert.ok(surplus.surplusWh > 0);
  assert.match(surplus.message, /surplus/);

  // Transient cycle: the bogus engine_run advisory must be GONE (cleaned up)
  const engineRun = c2.advisories.find((a) => a.type === "engine_run");
  assert.strictEqual(
    engineRun,
    undefined,
    `transient cycle should have NO engine_run advisory after recompute: ${JSON.stringify(c2.advisories)}`,
  );
});

test("backfill-advisories: --dry-run does not modify files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ep-backfill-dry-"));
  mkdirSync(join(tmp, "recordings"), { recursive: true });
  const file = join(tmp, "recordings", "2026-08-23.jsonl");
  const cycle = makeCycleRecord("2026-08-23T12:00:00.000Z", surplusForecast());
  const original = `${JSON.stringify(cycle)}\n`;
  writeFileSync(file, original);

  const res = runCLI(tmp, {
    from: "2026-08-23",
    to: "2026-08-23",
    dryRun: true,
  });
  assert.strictEqual(res.status, 0, `CLI failed: ${res.stderr}`);

  const after = readFileSync(file, { encoding: "utf-8" });
  assert.strictEqual(after, original, "dry-run must not modify the file");
});

test("backfill-advisories: missing --data-dir exits non-zero", () => {
  const res = spawnSync(process.execPath, ["bin/backfill-advisories.js"], {
    encoding: "utf-8",
  });
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /--data-dir is required/);
});

test("backfill-advisories: missing recordings dir exits non-zero", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ep-backfill-empty-"));
  const res = runCLI(tmp, { from: "2026-08-23", to: "2026-08-23" });
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /recordings dir not found/);
});
