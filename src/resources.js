'use strict';

const fs = require('node:fs');

// Base difficulty (required leading zero bits of sha256) per endpoint,
// under idle conditions, and the highest total difficulty each endpoint
// can ever reach regardless of how much pressure stacks. Both are
// calibrated against a deliberately measured, conservative client hash
// rate of 50,000 sha256/s; solve times are expected values and actual
// attempts vary:
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
 * clamp bounds what happens when several stack at once.
 */
function computeDifficulty(endpoint, state, baseDifficulty = BASE_DIFFICULTY, maxDifficulty = MAX_DIFFICULTY) {
  const base = baseDifficulty[endpoint];
  if (base === undefined) throw new Error(`unknown endpoint: ${endpoint}`);
  const load = extraBits(state.loadRatio, 0.6, 1.5, 8);
  // Search cannot consume disk capacity, so disk pressure only makes the
  // operation that writes to disk more expensive.
  const disk = endpoint === 'post' ? extraBits(state.diskPressureRatio, 0.5, 2, 12) : 0;
  const total = base + load + disk;
  const cap = maxDifficulty[endpoint];
  return cap === undefined ? total : Math.min(total, cap);
}

/** Raises synchronously but applies elapsed ten-second decay steps one bit at
 * a time. Updating lazily avoids a timer while preserving the same observable
 * difficulty whenever a request actually needs it. */
function createDifficultyController(requiredDifficulty, now = Date.now()) {
  const stored = { search: requiredDifficulty('search'), post: requiredDifficulty('post') };
  const decayAt = { search: now + 10_000, post: now + 10_000 };
  return {
    get(endpoint, currentNow = Date.now()) {
      const required = requiredDifficulty(endpoint);
      if (required > stored[endpoint]) {
        stored[endpoint] = required;
        decayAt[endpoint] = currentNow + 10_000;
      }
      if (currentNow >= decayAt[endpoint]) {
        const intervals = Math.floor((currentNow - decayAt[endpoint]) / 10_000) + 1;
        stored[endpoint] = Math.max(required, stored[endpoint] - intervals);
        decayAt[endpoint] += intervals * 10_000;
      }
      return stored[endpoint];
    },
  };
}

/** Refuses posting on raw byte comparisons, not on normalized ratios:
 * diskPressureRatio reaches 1 at the configured free-space floor. Comparing
 * the real numbers keeps this capacity boundary explicit. */
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
  createDifficultyController,
  isOverCapacity,
  currentState,
};
