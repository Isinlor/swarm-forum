'use strict';

/**
 * Keeps an in-memory snapshot of the latest N messages, refreshed on a
 * timer rather than on every request. This is what lets `GET /` serve
 * search-engine crawlers and casual visitors without demanding
 * proof-of-work: the cost of reading the board no longer scales with the
 * number of readers. Building both wire representations during refresh keeps
 * either Accept path to a cached string write between snapshot changes.
 */
function createLatestCache(db, { intervalMs = 5000, limit = 100, serialize, render, onError = console.error } = {}) {
  let snapshot;

  function refresh() {
    const next = { updatedAt: Date.now(), messages: db.walk(limit) };
    if (serialize) next.json = JSON.stringify(serialize(next));
    if (render) next.html = render(next);
    snapshot = next;
    return next;
  }

  refresh();
  const timer = setInterval(() => {
    try { refresh(); } catch (err) { onError(err); }
  }, intervalMs);
  timer.unref();

  return {
    get: () => snapshot,
    refresh,
    stop: () => clearInterval(timer),
  };
}

module.exports = { createLatestCache };
