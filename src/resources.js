'use strict';

const fs = require('node:fs');

// Base difficulty (required leading zero bits of sha256) per endpoint,
// under idle conditions, and the highest total difficulty each endpoint
// can ever reach regardless of how much pressure stacks. Both are
// calibrated against a deliberately measured, conservative client hash
// rate (~50,000 sha256/s for the pure-JS worker on a slow device — this
// project's own implementation measured ~120,000/s in Node on ordinary
// hardware) so "typical" and "worst case" mean actual seconds, not an
// accident of how the ramp happens to compound:
// At the conservative 50,000 hashes/s rate, the default expected times are:
//   post:   base 17 bits ≈ 2.6s; capped at 23 bits ≈ 167.8s
//   search: base 14 bits ≈ 0.3s; capped at 21 bits ≈ 41.9s
const BASE_DIFFICULTY = {
  search: 14,
  post: 17,
};

const MAX_DIFFICULTY = {
  search: 21,
  post: 23,
};

function freeDiskBytes(dir) {
  const stats = fs.statfsSync(dir);
  return stats.bavail * stats.bsize;
}

function diskPressureRatio(freeBytes, minFreeBytes) {
  if (!minFreeBytes) return 0;
  return Math.min(Math.max((4 * minFreeBytes - freeBytes) / (3 * minFreeBytes), 0), 1);
}

/**
 * Maps a 0..2 "pressure" ratio to extra proof-of-work bits, clamped to
 * `maxBits` regardless of how the intermediate math works out — `span`
 * raised to `power` can otherwise overshoot the stated cap (e.g. 1.5**1.5
 * ≈ 1.84x, not 1x) and silently drive difficulty far past what was
 * intended. Below `threshold` no extra work is demanded; beyond it the
 * penalty ramps up with `power`, so difficulty rises gently at first and
 * steeply near the configured resource ceiling.
 */
function extraBits(ratio, threshold, power, maxBits) {
  if (ratio <= threshold) return 0;
  const span = Math.min((ratio - threshold) / (1 - threshold), 1.5);
  return Math.min(Math.round(span ** power * maxBits), maxBits);
}

/**
 * Total difficulty is also clamped per endpoint (`maxDifficulty`), on
 * top of each component already being clamped — belt and suspenders:
 * the per-component clamp bounds any one pressure source, the total
 * clamp bounds what happens when several stack at once, so worst-case
 * solve time is a number that was actually chosen, not whatever the sum
 * of independent ramps happens to produce.
 */
function computeDifficulty(endpoint, state, baseDifficulty = BASE_DIFFICULTY, maxDifficulty = MAX_DIFFICULTY) {
  const base = baseDifficulty[endpoint];
  if (base === undefined) throw new Error(`unknown endpoint: ${endpoint}`);
  const load = extraBits(state.loadRatio, 0.6, 1.5, 8);
  const disk = extraBits(state.diskPressureRatio, 0.5, 2, 12);
  const total = base + load + disk;
  const cap = maxDifficulty[endpoint];
  return cap === undefined ? total : Math.min(total, cap);
}

/** Refuses posting on raw byte comparisons, not on the normalized ratios
 * above: diskPressureRatio reaches its own "1" only once free space is
 * exactly zero, by which point SQLite is already failing writes. Compare
 * the real numbers so the ceiling fires while there's still headroom
 * equal to the configured floor. */
function isOverCapacity(state) {
  const diskOverCap = state.minFreeBytes > 0 && state.freeBytes < state.minFreeBytes;
  return diskOverCap;
}

function currentState({ dataDir, minFreeBytes, loadRatio }) {
  const freeBytes = freeDiskBytes(dataDir);
  return {
    loadRatio,
    freeBytes,
    minFreeBytes,
    diskPressureRatio: diskPressureRatio(freeBytes, minFreeBytes),
  };
}

module.exports = {
  BASE_DIFFICULTY,
  MAX_DIFFICULTY,
  freeDiskBytes,
  diskPressureRatio,
  extraBits,
  computeDifficulty,
  isOverCapacity,
  currentState,
};
