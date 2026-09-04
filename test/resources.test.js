'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const resources = require('../src/resources');

test('loadRatio returns a non-negative finite number', () => {
  const ratio = resources.loadRatio();
  assert.equal(typeof ratio, 'number');
  assert.ok(ratio >= 0);
});

test('dbUsageRatio: zero when uncapped, proportional otherwise, capped at 2', () => {
  assert.equal(resources.dbUsageRatio(1000, 0), 0);
  assert.equal(resources.dbUsageRatio(50, 100), 0.5);
  assert.equal(resources.dbUsageRatio(1000, 100), 2);
});

test('diskPressureRatio: zero when unconfigured, computed for a real dir, zero on error', () => {
  assert.equal(resources.diskPressureRatio('.', 0), 0);
  const ratio = resources.diskPressureRatio('.', 1);
  assert.equal(typeof ratio, 'number');
  assert.ok(ratio >= 0 && ratio <= 2);
  assert.equal(resources.diskPressureRatio('/path/does/not/exist/at/all', 1024), 0);
});

test('extraBits stays zero at or below threshold and ramps up above it', () => {
  assert.equal(resources.extraBits(0, 0.5, 2, 10), 0);
  assert.equal(resources.extraBits(0.5, 0.5, 2, 10), 0);
  assert.ok(resources.extraBits(0.75, 0.5, 2, 10) > 0);
  // span = (ratio - threshold) / (1 - threshold) saturates at 1.5, so with
  // threshold 0.5 that happens at ratio 1.25; anything beyond is clamped
  // to the same extra-bits value.
  const atCap = resources.extraBits(1.25, 0.5, 2, 10);
  const wayOver = resources.extraBits(5, 0.5, 2, 10);
  assert.equal(atCap, wayOver);
  assert.ok(resources.extraBits(1, 0.5, 2, 10) < atCap);
});

test('computeDifficulty adds load/db/disk pressure on top of each endpoint base', () => {
  const idle = { loadRatio: 0, dbUsageRatio: 0, diskPressureRatio: 0 };
  assert.equal(resources.computeDifficulty('search', idle), resources.BASE_DIFFICULTY.search);
  assert.equal(resources.computeDifficulty('post', idle), resources.BASE_DIFFICULTY.post);
  assert.equal(resources.computeDifficulty('export', idle), resources.BASE_DIFFICULTY.export);

  const loaded = { loadRatio: 2, dbUsageRatio: 0.9, diskPressureRatio: 0.9 };
  assert.ok(resources.computeDifficulty('post', loaded) > resources.BASE_DIFFICULTY.post);

  assert.throws(() => resources.computeDifficulty('unknown', idle), /unknown endpoint/);
});

test('isOverCapacity trips on either db or disk pressure reaching the ceiling', () => {
  assert.equal(resources.isOverCapacity({ dbUsageRatio: 0.5, diskPressureRatio: 0.5 }), false);
  assert.equal(resources.isOverCapacity({ dbUsageRatio: 1, diskPressureRatio: 0.5 }), true);
  assert.equal(resources.isOverCapacity({ dbUsageRatio: 0.5, diskPressureRatio: 1 }), true);
});

test('currentState assembles the three ratios', () => {
  const state = resources.currentState({
    dbSizeBytes: 10,
    maxDbSizeBytes: 100,
    dataDir: '.',
    minFreeBytes: 0,
  });
  assert.equal(state.dbUsageRatio, 0.1);
  assert.equal(state.diskPressureRatio, 0);
  assert.equal(typeof state.loadRatio, 'number');
});

test('exportSizeBits is zero below the reference size and grows logarithmically above it', () => {
  assert.equal(resources.exportSizeBits(1000, 0), 0);
  assert.equal(resources.exportSizeBits(500, 1000), 0);
  assert.equal(resources.exportSizeBits(1000, 1000), 0);
  assert.equal(resources.exportSizeBits(2000, 1000), 1);
  assert.equal(resources.exportSizeBits(4000, 1000), 2);
  assert.equal(resources.exportSizeBits(1_000_000_000, 1000, 16), 16);
});
