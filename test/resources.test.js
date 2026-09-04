'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const resources = require('../src/resources');

test('dbUsageRatio: zero when uncapped, proportional otherwise, capped at 2', () => {
  assert.equal(resources.dbUsageRatio(1000, 0), 0);
  assert.equal(resources.dbUsageRatio(50, 100), 0.5);
  assert.equal(resources.dbUsageRatio(1000, 100), 2);
});

test('freeDiskBytes returns a real number for a real dir, Infinity on error', () => {
  const free = resources.freeDiskBytes('.');
  assert.equal(typeof free, 'number');
  assert.ok(free > 0);
  assert.equal(resources.freeDiskBytes('/path/does/not/exist/at/all'), Infinity);
});

test('diskPressureRatio: zero when unconfigured, proportional otherwise, capped at 2', () => {
  assert.equal(resources.diskPressureRatio(5000, 0), 0);
  assert.equal(resources.diskPressureRatio(Infinity, 1000), 0); // unmeasurable -> no pressure
  assert.equal(resources.diskPressureRatio(500, 1000), 0.5);
  assert.equal(resources.diskPressureRatio(0, 1000), 1);
  assert.equal(resources.diskPressureRatio(-1000, 1000), 2); // clamped
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

test('computeDifficulty adds load/db/disk pressure on top of each endpoint base, clamped to maxDifficulty', () => {
  const idle = { loadRatio: 0, dbUsageRatio: 0, diskPressureRatio: 0 };
  assert.equal(resources.computeDifficulty('search', idle), resources.BASE_DIFFICULTY.search);
  assert.equal(resources.computeDifficulty('post', idle), resources.BASE_DIFFICULTY.post);

  const loaded = { loadRatio: 2, dbUsageRatio: 0.9, diskPressureRatio: 0.9 };
  assert.ok(resources.computeDifficulty('post', loaded) > resources.BASE_DIFFICULTY.post);

  // The total is bounded by MAX_DIFFICULTY regardless of how many
  // pressure sources stack — this is what keeps worst-case solve time a
  // deliberately chosen number rather than whatever the ramp compounds to.
  const maxed = { loadRatio: 5, dbUsageRatio: 2, diskPressureRatio: 2 };
  assert.equal(resources.computeDifficulty('post', maxed), resources.MAX_DIFFICULTY.post);
  assert.equal(resources.computeDifficulty('search', maxed), resources.MAX_DIFFICULTY.search);

  assert.throws(() => resources.computeDifficulty('unknown', idle), /unknown endpoint/);
});

test('computeDifficulty accepts custom base/max difficulty tables', () => {
  const idle = { loadRatio: 0, dbUsageRatio: 0, diskPressureRatio: 0 };
  const value = resources.computeDifficulty('post', idle, { post: 3 }, { post: 30 });
  assert.equal(value, 3);
});

test('computeDifficulty is uncapped for an endpoint with no entry in the max-difficulty table', () => {
  const maxed = { loadRatio: 5, dbUsageRatio: 2, diskPressureRatio: 2 };
  const value = resources.computeDifficulty('post', maxed, { post: 3 }, {});
  assert.ok(value > 3); // load(8) + db(12) + disk(12) extra bits, nothing capping the total
});

test('isOverCapacity compares raw byte counts, not the normalized ratios', () => {
  assert.equal(resources.isOverCapacity({ dbSizeBytes: 50, maxDbSizeBytes: 100, freeBytes: 2000, minFreeBytes: 1000 }), false);
  assert.equal(resources.isOverCapacity({ dbSizeBytes: 100, maxDbSizeBytes: 100, freeBytes: 2000, minFreeBytes: 1000 }), true);
  // fires the moment free space drops below the floor, not only at exactly zero
  assert.equal(resources.isOverCapacity({ dbSizeBytes: 0, maxDbSizeBytes: 0, freeBytes: 999, minFreeBytes: 1000 }), true);
  assert.equal(resources.isOverCapacity({ dbSizeBytes: 0, maxDbSizeBytes: 0, freeBytes: 1000, minFreeBytes: 1000 }), false);
  // an unconfigured (0) ceiling never trips
  assert.equal(resources.isOverCapacity({ dbSizeBytes: 1e12, maxDbSizeBytes: 0, freeBytes: 0, minFreeBytes: 0 }), false);
});

test('currentState assembles ratios from raw inputs, including the given loadRatio', () => {
  const state = resources.currentState({
    dbSizeBytes: 10,
    maxDbSizeBytes: 100,
    dataDir: '.',
    minFreeBytes: 0,
    loadRatio: 0.42,
  });
  assert.equal(state.dbUsageRatio, 0.1);
  assert.equal(state.diskPressureRatio, 0);
  assert.equal(state.loadRatio, 0.42);
  assert.equal(state.dbSizeBytes, 10);
  assert.equal(state.maxDbSizeBytes, 100);
  assert.equal(typeof state.freeBytes, 'number');
});
