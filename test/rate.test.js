'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequestRateTracker } = require('../src/rate');

test('ratePerSecond reflects requests recorded within the window', () => {
  const tracker = createRequestRateTracker(1000);
  const base = 1_000_000;
  for (let i = 0; i < 5; i += 1) tracker.record(base + i);
  assert.equal(tracker.ratePerSecond(base + 5), 5);
});

test('entries older than the window are pruned and stop counting', () => {
  const tracker = createRequestRateTracker(1000);
  const base = 1_000_000;
  tracker.record(base);
  tracker.record(base + 100);
  assert.equal(tracker.ratePerSecond(base + 2000), 0);
});

test('a mix of old and recent entries only counts the recent ones', () => {
  const tracker = createRequestRateTracker(1000);
  const base = 1_000_000;
  tracker.record(base);
  tracker.record(base + 1500);
  tracker.record(base + 1600);
  // window is [base+600, base+1600]; only the last two are inside it
  assert.equal(tracker.ratePerSecond(base + 1600), 2);
});

test('defaults to Date.now() when no timestamp is given', () => {
  const tracker = createRequestRateTracker(5000);
  tracker.record();
  assert.ok(tracker.ratePerSecond() > 0);
});
