'use strict';

// Empirically confirms the design's complexity claims: id/poster lookups
// go through indexed b-trees, and free-text search goes through the
// FTS5 inverted index ordered by rowid (recency) rather than BM25 rank
// — so cost is bounded by how many results are *returned*, not by how
// many rows *match*. A term that matches virtually every row should
// therefore cost about the same as a term that matches exactly one, and
// no query plan should ever need to materialize-then-sort ("USE TEMP
// B-TREE FOR ORDER BY") to satisfy an ORDER BY that a composite index
// already produces for free.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, SQL, buildSearchMatch } = require('../src/db');
const { uuidv7 } = require('../src/uuid');

const SMALL_N = 500;
const LARGE_N = 500_000;
const SAMPLES = 200;
const COMMON_TERM = 'filler';
const SPARSE_POSTER = 'sparseposter0001'; // ~1 in 5000 rows

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
      const poster = n % 5000 === 0 ? SPARSE_POSTER : `poster${n % 1000}`;
      db.insertMessage({
        id: uuidv7(),
        message: `${COMMON_TERM} chatter about agents and forums uniquetag${n}`,
        poster,
      });
    }
  } finally {
    db.raw.exec('COMMIT');
  }
}

function usesTempBtreeForOrder(db, sql, params) {
  const rows = db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  return rows.some((row) => /TEMP B-TREE/i.test(row.detail));
}

test('search and lookup cost stay bounded as the table scales to 500k rows', { timeout: 180_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-scale-'));
  const db = openDb(path.join(dir, 'scale.db'));
  try {
    insertBatch(db, SMALL_N, 0);
    const smallSearchMs = avgMs(() => db.search(`uniquetag${SMALL_N - 1}`, 20), SAMPLES);
    const smallGetMs = avgMs(() => db.getById(db.walk(1)[0].id), SAMPLES);

    insertBatch(db, LARGE_N - SMALL_N, SMALL_N);
    assert.equal(db.count(), LARGE_N);

    const largeId = db.walk(1)[0].id;
    const largeGetMs = avgMs(() => db.getById(largeId), SAMPLES);
    const largeSearchMs = avgMs(() => db.search(`uniquetag${LARGE_N - 1}`, 20), SAMPLES);
    const walkMs = avgMs(() => db.walk(20), SAMPLES);
    const posterListMs = avgMs(() => db.listByPoster(SPARSE_POSTER, 20), SAMPLES);
    // COMMON_TERM matches essentially all 500k rows; combining it with a
    // poster used by only ~100 of them is the one case the design's own
    // complexity claim admits isn't purely index-seek cheap (FTS5 still
    // has to intersect both doclists) — it should still be fast, just
    // not asserted at the same tight bound as the others.
    const commonMs = avgMs(() => db.search(COMMON_TERM, 20), SAMPLES);
    const combinedMs = avgMs(() => db.search(COMMON_TERM, 20, SPARSE_POSTER), SAMPLES);

    // Absolute bounds at 500k rows.
    assert.ok(largeGetMs < 5, `id lookup at N=${LARGE_N} took ${largeGetMs}ms`);
    assert.ok(largeSearchMs < 25, `narrow search at N=${LARGE_N} took ${largeSearchMs}ms`);
    assert.ok(walkMs < 5, `walk at N=${LARGE_N} took ${walkMs}ms`);
    assert.ok(posterListMs < 5, `listByPoster at N=${LARGE_N} took ${posterListMs}ms`);
    assert.ok(combinedMs < 50, `common-term + sparse-poster search took ${combinedMs}ms`);

    // Relative: a 1000x row increase (SMALL_N -> LARGE_N) shouldn't
    // translate into anything close to a 1000x increase in query time.
    const getGrowth = largeGetMs / Math.max(smallGetMs, 0.001);
    const searchGrowth = largeSearchMs / Math.max(smallSearchMs, 0.001);
    assert.ok(getGrowth < 15, `getById slowed ${getGrowth}x for a 1000x larger table`);
    assert.ok(searchGrowth < 15, `narrow search slowed ${searchGrowth}x for a 1000x larger table`);

    // Bounded by results returned, not rows matched: a term matching
    // ~all 500k rows should cost close to a term matching exactly one,
    // proving the ordering is index-driven rather than "rank everything
    // that matched, then take the top 20".
    const commonGrowth = commonMs / Math.max(largeSearchMs, 0.001);
    assert.ok(commonGrowth < 10, `common-term search cost ${commonGrowth}x the single-match search`);

    // EXPLAIN QUERY PLAN: run against the exact SQL production executes
    // (db.js's SQL/buildSearchMatch exports), so this can't silently
    // drift from what's actually shipped.
    const plans = [
      ['walk', SQL.walk, [20]],
      ['listByPoster', SQL.listByPoster, [SPARSE_POSTER, 20]],
      ['search (common term)', SQL.search, [buildSearchMatch(COMMON_TERM), 20]],
      ['search (common term + sparse poster)', SQL.search, [buildSearchMatch(COMMON_TERM, SPARSE_POSTER), 20]],
    ];
    for (const [label, sql, params] of plans) {
      assert.equal(usesTempBtreeForOrder(db, sql, params), false, `${label} used a temp b-tree to order results`);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
