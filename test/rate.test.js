'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { createRequestRateTracker } = require('../src/rate');
test('five circular one-second buckets count recent paid operations at fixed cost', () => {
  const t = createRequestRateTracker(); for (let i = 0; i < 5; i += 1) t.record(10_000);
  assert.equal(t.ratePerSecond(10_000), 1); t.record(11_000); assert.equal(t.ratePerSecond(11_000), 1.2);
  assert.equal(t.ratePerSecond(15_000), 0.2); assert.equal(t.ratePerSecond(16_000), 0);
});
test('tracker defaults to the current time', () => { const t = createRequestRateTracker(); t.record(); assert.ok(t.ratePerSecond() > 0); });
