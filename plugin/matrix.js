/**
 * Matrix persistence operations for learning matrices.
 *
 * Matrices are stored as JSON files with human-readable names in the plugin's data directory.
 *
 * @file matrix.js
 */

const { open, readFile, rename, mkdir } = require("node:fs/promises");
const { randomBytes } = require("node:crypto");
const { dirname, join } = require("node:path");

/**
 * Reads and parses a JSON file.
 *
 * @param {string} path - File path
 * @returns {Promise<object|null>} Parsed object, or null if file doesn't exist
 */
async function readJsonFile(path) {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Reads and parses a JSON file, tolerating a corrupted file.
 *
 * A file left truncated by a power loss (or otherwise invalid JSON) is
 * moved aside with a `.corrupt-<timestamp>` suffix so it remains available
 * for inspection, and null is returned so callers start fresh instead of
 * crashing the server at startup.
 *
 * @param {string} path - File path
 * @returns {Promise<object|null>} Parsed object, or null if file doesn't exist or is corrupt
 */
async function readJsonFileSafe(path) {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      const quarantine = `${path}.corrupt-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}`;
      try {
        await rename(path, quarantine);
      } catch (_renameError) {
        // Best effort; if the rename fails we still start fresh
      }
      return null;
    }
    throw error;
  }
}

/**
 * Writes an object as JSON to a file.
 * Creates parent directories if needed.
 *
 * The write is atomic: data is written to a uniquely named temp file in
 * the target directory, flushed to disk, then renamed over the target.
 * rename(2) is atomic, so a crash or power loss mid-write can never leave
 * a truncated or partial JSON file at the target path — the plugin either
 * sees the previous complete file or the new complete file.
 *
 * @param {string} path - File path
 * @param {object} data - Data to write
 * @returns {Promise<void>}
 */
async function writeJsonFile(path, data) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  // Unique temp name so overlapping writers (periodic save cycle racing a
  // save on stop) can never interleave into a shared temp file
  const tmpPath = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, path);
}

/**
 * Generates a human-readable filename for a solar array matrix.
 *
 * @param {string} arrayId - Array identifier (e.g., "solar_cabin", "flinsail")
 * @returns {string} Filename (e.g., "solar-matrix-solar-cabin.json")
 */
function matrixFilename(arrayId) {
  // Sanitize arrayId for use in filename
  const sanitized = arrayId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `solar-matrix-${sanitized}.json`;
}

/**
 * Loads a solar matrix from disk.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {string} arrayId - Array identifier
 * @returns {Promise<object|null>} Matrix data, or null if file doesn't exist
 */
async function loadMatrix(dataDir, arrayId) {
  const path = join(dataDir, matrixFilename(arrayId));
  return await readJsonFileSafe(path);
}

/**
 * Saves a solar matrix to disk.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {object} matrixData - Matrix data to save
 * @returns {Promise<void>}
 */
async function saveMatrix(dataDir, matrixData) {
  const path = join(dataDir, matrixFilename(matrixData.arrayId));
  await writeJsonFile(path, matrixData);
}

/**
 * Lists all saved matrix files in the data directory.
 *
 * @param {string} dataDir - Plugin data directory
 * @returns {Promise<string[]>} Array of array IDs
 */
async function listSavedMatrices(dataDir) {
  const manifest = await readJsonFileSafe(join(dataDir, ".matrices-manifest"));
  return manifest?.arrays || [];
}

/**
 * Updates the manifest of saved matrices.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {string[]} arrayIds - Array IDs to record
 * @returns {Promise<void>}
 */
async function updateMatrixManifest(dataDir, arrayIds) {
  const path = join(dataDir, ".matrices-manifest");
  await writeJsonFile(path, {
    version: 1,
    arrays: arrayIds,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Persists multiple matrices atomically.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {object[]} matrices - Array of matrix data objects
 * @returns {Promise<void>}
 */
async function saveMatrices(dataDir, matrices) {
  // Save each matrix
  for (const matrix of matrices) {
    await saveMatrix(dataDir, matrix);
  }

  // Update manifest
  const arrayIds = matrices.map((m) => m.arrayId);
  await updateMatrixManifest(dataDir, arrayIds);
}

/**
 * Loads all saved matrices from disk.
 *
 * @param {string} dataDir - Plugin data directory
 * @returns {Promise<object[]>} Array of matrix data objects
 */
async function loadAllMatrices(dataDir) {
  const arrayIds = await listSavedMatrices(dataDir);
  const matrices = [];

  for (const id of arrayIds) {
    const data = await loadMatrix(dataDir, id);
    if (data) {
      matrices.push(data);
    }
  }

  return matrices;
}

/**
 * Deletes a matrix file.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {string} arrayId - Array identifier
 * @returns {Promise<boolean>} True if deleted, false if didn't exist
 */
async function deleteMatrix(dataDir, arrayId) {
  const { unlink } = require("node:fs/promises");
  const path = join(dataDir, matrixFilename(arrayId));

  try {
    await unlink(path);

    // Update manifest
    const arrayIds = await listSavedMatrices(dataDir);
    const updated = arrayIds.filter((id) => id !== arrayId);
    await updateMatrixManifest(dataDir, updated);

    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Backs up all matrices to a timestamped archive.
 *
 * @param {string} dataDir - Plugin data directory
 * @returns {Promise<string>} Path to backup file
 */
async function backupMatrices(dataDir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(dataDir, `matrices-backup-${timestamp}.json`);
  const matrices = await loadAllMatrices(dataDir);

  await writeJsonFile(backupPath, {
    version: 1,
    timestamp: new Date().toISOString(),
    matrices,
  });

  return backupPath;
}

/**
 * Restores matrices from a backup file.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {string} backupPath - Path to backup file
 * @returns {Promise<number>} Number of matrices restored
 */
async function restoreMatrices(dataDir, backupPath) {
  const data = await readJsonFile(backupPath);

  if (!data.matrices || !Array.isArray(data.matrices)) {
    throw new Error("Invalid backup file format");
  }

  for (const matrix of data.matrices) {
    await saveMatrix(dataDir, matrix);
  }

  const arrayIds = data.matrices.map((m) => m.arrayId);
  await updateMatrixManifest(dataDir, arrayIds);

  return data.matrices.length;
}

/**
 * Gets the load profile file path.
 *
 * @param {string} dataDir - Plugin data directory
 * @returns {string} File path
 */
function loadProfilePath(dataDir) {
  return join(dataDir, "load-profile.json");
}

/**
 * Loads the load profile from disk.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {object} loadProfile - LoadProfile instance to populate
 * @returns {Promise<boolean>} True if loaded, false if file doesn't exist
 */
async function loadLoadProfile(dataDir, loadProfile) {
  const path = loadProfilePath(dataDir);
  const data = await readJsonFileSafe(path);

  if (data) {
    loadProfile.fromJSON(data);
    return true;
  }
  return false;
}

/**
 * Saves the load profile to disk.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {object} loadProfile - LoadProfile instance
 * @returns {Promise<void>}
 */
async function saveLoadProfile(dataDir, loadProfile) {
  const path = loadProfilePath(dataDir);
  await writeJsonFile(path, loadProfile.toJSON());
}

/**
 * Gets the wind protection store file path.
 *
 * @param {string} dataDir - Plugin data directory
 * @returns {string} File path
 */
function windProtectionPath(dataDir) {
  return join(dataDir, "wind-protection.json");
}

/**
 * Loads the wind protection store from disk.
 *
 * @param {string} dataDir - Plugin data directory
 * @returns {Promise<object|null>} Store data, or null if file doesn't exist
 */
async function loadWindProtection(dataDir) {
  const path = windProtectionPath(dataDir);
  return await readJsonFileSafe(path);
}

/**
 * Saves the wind protection store to disk.
 *
 * @param {string} dataDir - Plugin data directory
 * @param {object} storeData - Store data to save
 * @returns {Promise<void>}
 */
async function saveWindProtection(dataDir, storeData) {
  const path = windProtectionPath(dataDir);
  await writeJsonFile(path, storeData);
}

module.exports = {
  matrixFilename,
  loadMatrix,
  saveMatrix,
  saveMatrices,
  loadAllMatrices,
  deleteMatrix,
  listSavedMatrices,
  backupMatrices,
  restoreMatrices,
  loadProfilePath,
  loadLoadProfile,
  saveLoadProfile,
  windProtectionPath,
  loadWindProtection,
  saveWindProtection,
};
