'use strict';

// Empirically confirms the O(log n) design claim: id/reply lookups go
// through SQLite's PRIMARY KEY / index b-trees, and free-text search goes
// through the FTS5 inverted index, so query latency for a narrow query
// should stay roughly flat as the table grows from hundreds to tens of
// thousands of rows, well within a CI job's resource budget.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { uuidv7 } = require('../src/uuid');

const SMALL_N = 500;
const LARGE_N = 20_000;
const SAMPLES = 200;

function avgMs(fn, samples) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < samples; i += 1) fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6 / samples;
}

function insertBatch(db, count, offset) {
  db.raw.exec('BEGIN');
  try {
    for (let i = 0; i < count; i += 1) {
      const n = offset + i;
      db.insertMessage({
        id: uuidv7(),
        message: `general chatter filler words about agents and forums uniquetag${n}`,
        createdAt: Date.now(),
        ip: '::1',
        poster: 'poster0000',
        replyTo: null,
      });
    }
  } finally {
    db.raw.exec('COMMIT');
  }
}

test('id lookup and narrow full-text search stay fast as the table scales 40x', { timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-scale-'));
  const db = openDb(path.join(dir, 'scale.db'));
  try {
    insertBatch(db, SMALL_N, 0);
    const smallId = db.latest(1)[0].id;
    const smallGetMs = avgMs(() => db.getById(smallId), SAMPLES);
    const smallSearchMs = avgMs(() => db.search(`uniquetag${Math.floor(SMALL_N / 2)}`, 20), SAMPLES);

    insertBatch(db, LARGE_N - SMALL_N, SMALL_N);
    assert.equal(db.count(), LARGE_N);

    const largeId = db.latest(1)[0].id;
    const largeGetMs = avgMs(() => db.getById(largeId), SAMPLES);
    const largeSearchMs = avgMs(() => db.search(`uniquetag${LARGE_N - 1}`, 20), SAMPLES);

    // Absolute bounds: both operations should be sub-millisecond-to-few-ms
    // even at 20k rows, regardless of how the small-N baseline behaved.
    assert.ok(largeGetMs < 5, `id lookup at N=${LARGE_N} took ${largeGetMs}ms`);
    assert.ok(largeSearchMs < 25, `search at N=${LARGE_N} took ${largeSearchMs}ms`);

    // Relative bound: a 40x increase in row count should not translate
    // into anything close to a 40x increase in query time. A generous
    // 15x ceiling absorbs CI noise while still ruling out linear scans.
    const getGrowth = largeGetMs / Math.max(smallGetMs, 0.001);
    const searchGrowth = largeSearchMs / Math.max(smallSearchMs, 0.001);
    assert.ok(getGrowth < 15, `getById slowed ${getGrowth}x for a 40x larger table`);
    assert.ok(searchGrowth < 15, `search slowed ${searchGrowth}x for a 40x larger table`);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
