'use strict';

function createRequestRateTracker() {
  const recordedAt = [];
  let first = 0;
  function prune(now) {
    while (first < recordedAt.length && recordedAt[first] <= now - 1000) first += 1;
    // Compact only after enough expired entries accumulate, keeping normal
    // recording O(1) without retaining burst history indefinitely.
    if (first > 1024 && first * 2 > recordedAt.length) {
      recordedAt.splice(0, first);
      first = 0;
    }
  }
  return {
    record(now = Date.now()) {
      prune(now);
      recordedAt.push(now);
    },
    ratePerSecond(now = Date.now()) {
      prune(now);
      return recordedAt.length - first;
    },
  };
}

function createPerSecondLimiter(limit) {
  const acceptedAt = new Float64Array(limit);
  let first = 0;
  let count = 0;
  return {
    take(now = Date.now()) {
      while (count > 0 && acceptedAt[first] <= now - 1000) {
        first = (first + 1) % limit;
        count -= 1;
      }
      if (count >= limit) return false;
      acceptedAt[(first + count) % limit] = now;
      count += 1;
      return true;
    },
  };
}

module.exports = { createRequestRateTracker, createPerSecondLimiter };
