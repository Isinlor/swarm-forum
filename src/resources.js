'use strict';

const os = require('node:os');
const fs = require('node:fs');

// Base difficulty (required leading zero bits of sha256) per endpoint,
// under idle conditions. These scale up automatically as resources tighten.
const BASE_DIFFICULTY = {
  search: 14,
  post: 18,
  export: 22,
};

function loadRatio() {
  return os.loadavg()[0] / os.cpus().length;
}

function dbUsageRatio(dbSizeBytes, maxDbSizeBytes) {
  if (!maxDbSizeBytes) return 0;
  return Math.min(dbSizeBytes / maxDbSizeBytes, 2);
}

function diskPressureRatio(dir, minFreeBytes) {
  if (!minFreeBytes) return 0;
  try {
    const stats = fs.statfsSync(dir);
    const freeBytes = stats.bavail * stats.bsize;
    return Math.min(Math.max(1 - freeBytes / minFreeBytes, 0), 2);
  } catch {
    return 0;
  }
}

/**
 * Maps a 0..2 "pressure" ratio to extra proof-of-work bits. Below
 * `threshold` no extra work is demanded; beyond it the penalty ramps up
 * with `power`, so difficulty rises gently at first and steeply near
 * the configured resource ceiling.
 */
function extraBits(ratio, threshold, power, maxBits) {
  if (ratio <= threshold) return 0;
  const span = Math.min((ratio - threshold) / (1 - threshold), 1.5);
  return Math.round(span ** power * maxBits);
}

function computeDifficulty(endpoint, state, baseDifficulty = BASE_DIFFICULTY) {
  const base = baseDifficulty[endpoint];
  if (base === undefined) throw new Error(`unknown endpoint: ${endpoint}`);
  const load = extraBits(state.loadRatio, 0.6, 1.5, 8);
  const db = extraBits(state.dbUsageRatio, 0.5, 2, 12);
  const disk = extraBits(state.diskPressureRatio, 0.5, 2, 12);
  return base + load + db + disk;
}

function isOverCapacity(state) {
  return state.dbUsageRatio >= 1 || state.diskPressureRatio >= 1;
}

/**
 * Extra bits for /export specifically: downloading the whole database is
 * inherently heavier the bigger it is, independent of load or the
 * capacity ceiling, so it gets its own logarithmic ramp on top of the
 * shared difficulty above `referenceBytes`.
 */
function exportSizeBits(dbSizeBytes, referenceBytes, maxBits = 16) {
  if (!referenceBytes || dbSizeBytes <= referenceBytes) return 0;
  const bits = Math.log2(dbSizeBytes / referenceBytes);
  return Math.min(Math.max(Math.round(bits), 0), maxBits);
}

function currentState({ dbSizeBytes, maxDbSizeBytes, dataDir, minFreeBytes }) {
  return {
    loadRatio: loadRatio(),
    dbUsageRatio: dbUsageRatio(dbSizeBytes, maxDbSizeBytes),
    diskPressureRatio: diskPressureRatio(dataDir, minFreeBytes),
  };
}

module.exports = {
  BASE_DIFFICULTY,
  loadRatio,
  dbUsageRatio,
  diskPressureRatio,
  extraBits,
  computeDifficulty,
  isOverCapacity,
  currentState,
  exportSizeBits,
};
