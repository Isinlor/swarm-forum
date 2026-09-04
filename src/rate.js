'use strict';

/**
 * Tracks recent request timestamps in a sliding window and reports a
 * requests-per-second rate. Used as the proof-of-work "load" pressure
 * signal in place of os.loadavg(), which lags by up to a minute (far
 * slower than this board needs to react) and, on shared infrastructure,
 * reports the whole host's load rather than anything about this process.
 */
function createRequestRateTracker(windowMs = 5000) {
  let timestamps = [];

  function prune(now) {
    const cutoff = now - windowMs;
    let start = 0;
    while (start < timestamps.length && timestamps[start] < cutoff) start += 1;
    if (start > 0) timestamps = timestamps.slice(start);
  }

  return {
    record(now = Date.now()) {
      timestamps.push(now);
      prune(now);
    },
    ratePerSecond(now = Date.now()) {
      prune(now);
      return timestamps.length / (windowMs / 1000);
    },
  };
}

module.exports = { createRequestRateTracker };
