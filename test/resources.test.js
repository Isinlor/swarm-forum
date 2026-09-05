'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const resources = require('../src/resources');

test('freeDiskBytes returns a real number and fails closed on error', () => {
  const free = resources.freeDiskBytes('.');
  assert.equal(typeof free, 'number');
  assert.ok(free > 0);
  assert.throws(() => resources.freeDiskBytes('/path/does/not/exist/at/all'), /ENOENT/);
});

test('diskPressureRatio ramps continuously from four times the floor to the hard cutoff', () => {
  assert.equal(resources.diskPressureRatio(5000, 0), 0);
  assert.equal(resources.diskPressureRatio(4000, 1000), 0);
  assert.equal(resources.diskPressureRatio(2500, 1000), 0.5);
  assert.equal(resources.diskPressureRatio(1000, 1000), 1);
  assert.equal(resources.diskPressureRatio(0, 1000), 1);
});
test('extraBits stays zero at or below threshold, ramps up above it, and is clamped to maxBits', () => {
  assert.equal(resources.extraBits(0, 0.5, 2, 10), 0);
  assert.equal(resources.extraBits(0.5, 0.5, 2, 10), 0);
  assert.ok(resources.extraBits(0.75, 0.5, 2, 10) > 0);
  assert.ok(resources.extraBits(0.75, 0.5, 2, 10) <= 10);
  // span = (ratio - threshold) / (1 - threshold) saturates at 1.5, and
  // 1.5**1.5 > 1 — without an explicit clamp this would overshoot maxBits.
  assert.equal(resources.extraBits(1.2, 0.6, 1.5, 8), 8);
  assert.equal(resources.extraBits(5, 0.6, 1.5, 8), 8);
});

test('computeDifficulty adds load and post-only disk pressure, clamped to maxDifficulty', () => {
  const idle = { loadRatio: 0, diskPressureRatio: 0 };
  assert.equal(resources.computeDifficulty('search', idle), resources.BASE_DIFFICULTY.search);
  assert.equal(resources.computeDifficulty('post', idle), resources.BASE_DIFFICULTY.post);

  const loaded = { loadRatio: 2, diskPressureRatio: 0.9 };
  assert.ok(resources.computeDifficulty('post', loaded) > resources.BASE_DIFFICULTY.post);
  assert.equal(resources.computeDifficulty('search', { loadRatio: 0, diskPressureRatio: 1 }),
    resources.BASE_DIFFICULTY.search);

  // The total stays within MAX_DIFFICULTY when pressure sources stack.
  const maxed = { loadRatio: 5, diskPressureRatio: 2 };
  assert.equal(resources.computeDifficulty('post', maxed), resources.MAX_DIFFICULTY.post);
  assert.equal(resources.computeDifficulty('search', maxed), resources.MAX_DIFFICULTY.search);

  assert.throws(() => resources.computeDifficulty('unknown', idle), /unknown endpoint/);
});

test('computeDifficulty accepts custom base/max difficulty tables', () => {
  const idle = { loadRatio: 0, diskPressureRatio: 0 };
  const value = resources.computeDifficulty('post', idle, { post: 3 }, { post: 30 });
  assert.equal(value, 3);
});

test('post difficulty is uncapped for an endpoint with no entry in the max-difficulty table', () => {
  const maxed = { loadRatio: 5, diskPressureRatio: 2 };
  const value = resources.computeDifficulty('post', maxed, { post: 3 }, {});
  assert.ok(value > 3); // load(8) + disk(12) extra bits, nothing capping the total
});

test('difficulty rises immediately and decays by one bit every ten seconds', () => {
  const required = { search: 3, post: 4 };
  const controller = resources.createDifficultyController((endpoint) => required[endpoint], 1000);
  assert.equal(controller.get('search', 1000), 3);
  required.search = 8;
  assert.equal(controller.get('search', 10_999), 8);
  required.search = 3;
  assert.equal(controller.get('search', 11_000), 8);
  assert.equal(controller.get('search', 20_998), 8);
  assert.equal(controller.get('search', 20_999), 7);
  assert.equal(controller.get('search', 50_000), 5);
  required.search = 9;
  assert.equal(controller.get('search', 50_001), 9);
  required.post = 2;
  assert.equal(controller.get('post', 50_001), 2);
});

test('isOverCapacity compares raw free bytes, not the normalized ratio', () => {
  // fires the moment free space drops below the floor, not only at exactly zero
  assert.equal(resources.isOverCapacity({ freeBytes: 999, minFreeBytes: 1000 }), true);
  assert.equal(resources.isOverCapacity({ freeBytes: 1000, minFreeBytes: 1000 }), false);
  // an unconfigured (0) ceiling never trips
  assert.equal(resources.isOverCapacity({ freeBytes: 0, minFreeBytes: 0 }), false);
});

test('currentState assembles ratios from raw inputs, including the given loadRatio', () => {
  const state = resources.currentState({
    dataDir: '.',
    minFreeBytes: 0,
    loadRatio: 0.42,
  });
  assert.equal(state.diskPressureRatio, 0);
  assert.equal(state.loadRatio, 0.42);
  assert.equal(typeof state.freeBytes, 'number');
});
