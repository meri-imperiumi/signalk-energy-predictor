/**
 * Tests for matrix persistence resilience (plugin/matrix.js): atomic
 * writes and recovery from corrupted (e.g. power-loss-truncated) JSON
 * files instead of crashing the server at startup.
 *
 * @file matrix-persistence.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  loadMatrix,
  loadAllMatrices,
  saveMatrix,
  saveMatrices,
  loadLoadProfile,
  saveLoadProfile,
  loadWindProtection,
  saveWindProtection,
  restoreMatrices,
} = require("../plugin/matrix.js");
const { LoadProfile } = require("../plugin/prediction.js");

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ep-matrix-"));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test("loadMatrix returns null and quarantines a truncated matrix file", async () => {
  const dir = makeDataDir();
  try {
    const file = path.join(dir, "solar-matrix-cabin-roof.json");
    fs.writeFileSync(
      file,
      '{"arrayId":"cabin-roof","version":1,"anchored":{"abc":{"samples"',
    );

    const data = await loadMatrix(dir, "cabin-roof");

    assert.strictEqual(data, null, "corrupt file must read as missing");
    assert.strictEqual(
      fs.existsSync(file),
      false,
      "corrupt file must be moved aside",
    );
    const quarantined = fs
      .readdirSync(dir)
      .filter((f) => f.includes(".corrupt-"));
    assert.strictEqual(quarantined.length, 1, "exactly one quarantine file");
    const kept = fs.readFileSync(path.join(dir, quarantined[0]), "utf-8");
    assert.ok(kept.includes('"cabin-roof"'), "original content preserved");
  } finally {
    cleanup(dir);
  }
});

test("loadAllMatrices returns empty when the manifest is corrupt", async () => {
  const dir = makeDataDir();
  try {
    fs.writeFileSync(path.join(dir, ".matrices-manifest"), '{"arrays":["cabin');

    const matrices = await loadAllMatrices(dir);

    assert.deepStrictEqual(matrices, []);
    const quarantined = fs
      .readdirSync(dir)
      .filter((f) => f.includes(".corrupt-"));
    assert.strictEqual(quarantined.length, 1);
  } finally {
    cleanup(dir);
  }
});

test("loadAllMatrices skips a corrupt matrix but loads valid ones", async () => {
  const dir = makeDataDir();
  try {
    fs.writeFileSync(
      path.join(dir, ".matrices-manifest"),
      JSON.stringify({ version: 1, arrays: ["cabin-roof", "deck"] }),
    );
    fs.writeFileSync(
      path.join(dir, "solar-matrix-cabin-roof.json"),
      '{"arrayId":"cabin-roof",',
    );
    const good = {
      arrayId: "deck",
      version: 1,
      anchored: {},
      underway: {},
    };
    fs.writeFileSync(
      path.join(dir, "solar-matrix-deck.json"),
      JSON.stringify(good),
    );

    const matrices = await loadAllMatrices(dir);

    assert.strictEqual(matrices.length, 1);
    assert.strictEqual(matrices[0].arrayId, "deck");
  } finally {
    cleanup(dir);
  }
});

test("loadLoadProfile reports fresh on a corrupt profile file", async () => {
  const dir = makeDataDir();
  try {
    fs.writeFileSync(path.join(dir, "load-profile.json"), '{"hours":[');

    const profile = new LoadProfile();
    const loaded = await loadLoadProfile(dir, profile);

    assert.strictEqual(loaded, false);
    assert.strictEqual(
      fs.readdirSync(dir).filter((f) => f.includes(".corrupt-")).length,
      1,
    );
  } finally {
    cleanup(dir);
  }
});

test("loadWindProtection returns null on a corrupt store file", async () => {
  const dir = makeDataDir();
  try {
    fs.writeFileSync(path.join(dir, "wind-protection.json"), '{"places":{"x"');

    const data = await loadWindProtection(dir);

    assert.strictEqual(data, null);
    assert.strictEqual(
      fs.readdirSync(dir).filter((f) => f.includes(".corrupt-")).length,
      1,
    );
  } finally {
    cleanup(dir);
  }
});

test("save round-trips leave no temp files behind", async () => {
  const dir = makeDataDir();
  try {
    const matrix = { arrayId: "cabin-roof", version: 1, anchored: {} };
    await saveMatrix(dir, matrix);
    await saveMatrix(dir, { ...matrix, version: 2 });

    const data = await loadMatrix(dir, "cabin-roof");
    assert.strictEqual(data.version, 2, "last write wins");
    assert.strictEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length,
      0,
      "no leftover temp files",
    );

    await saveMatrices(dir, [matrix]);
    const profile = new LoadProfile();
    await saveLoadProfile(dir, profile);
    assert.deepStrictEqual(await loadWindProtection(dir), null);

    const wps = { version: 1, places: {}, winds: {} };
    await saveWindProtection(dir, wps);
    assert.deepStrictEqual(await loadWindProtection(dir), wps);
    assert.strictEqual(
      fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length,
      0,
    );
  } finally {
    cleanup(dir);
  }
});

test("restoreMatrices still rejects an invalid backup file", async () => {
  const dir = makeDataDir();
  try {
    const backup = path.join(dir, "backup.json");
    fs.writeFileSync(backup, "not json at all");

    await assert.rejects(() => restoreMatrices(dir, backup));
  } finally {
    cleanup(dir);
  }
});
