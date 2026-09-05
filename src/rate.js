'use strict';

function createRequestRateTracker() {
  const buckets = new Uint32Array(5);
  const seconds = new Float64Array(5);
  return {
    record(now = Date.now()) {
      const second = Math.floor(now / 1000);
      const index = second % 5;
      if (seconds[index] !== second) { seconds[index] = second; buckets[index] = 0; }
      buckets[index] += 1;
    },
    ratePerSecond(now = Date.now()) {
      const second = Math.floor(now / 1000);
      let total = 0;
      for (let i = 0; i < 5; i += 1) if (second - seconds[i] >= 0 && second - seconds[i] < 5) total += buckets[i];
      return total / 5;
    },
  };
}

module.exports = { createRequestRateTracker };
