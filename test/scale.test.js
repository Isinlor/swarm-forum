'use strict';

// Checks intended plans and guards timing regressions: id/poster lookups
// go through indexed b-trees, and free-text search goes through the
// FTS5 inverted index ordered by rowid (recency) rather than BM25 rank
// — avoiding a relevance sort. A common term should stay near the
// single-match baseline in this fixture, and
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
const SANITY_POSTER = 'sanitypost000001';

function avgMs(fn, samples) {
  const start = process.hrtime.bigint();
  for (let i = 0; i < samples; i += 1) fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / 1e6 / samples;
}

/**
 * A handful of rows through the exact code path a real `/post` uses —
 * `insertMessage()`, which stores the body and (via the schema's
 * `messages_ai` trigger) populates the FTS index — checked before any
 * bulk data exists. This is what keeps the fast bulk loader below
 * honest: if it ever silently drifted from what production actually
 * writes, this would be where that surfaces, not somewhere buried in a
 * 500k-row timing number.
 */
function sanityCheckProductionInsertPath(db) {
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    const { id } = db.insertMessage({
      id: uuidv7(),
      message: `sanity check row ${i}`,
      poster: SANITY_POSTER,
    });
    ids.push(id);
  }
  for (const id of ids) {
    const row = db.getById(id);
    assert.ok(row, `sanity row ${id} was not retrievable via getById`);
    assert.match(row.message, /^sanity check row \d$/);
  }
  const found = db.search('sanity check', 10);
  assert.equal(found.length, ids.length);
  const byPoster = db.listByPoster(SANITY_POSTER, 10);
  assert.equal(byPoster.length, ids.length);
  return ids.length;
}

/**
 * Inserts `count` filler rows (offset by `offset`) entirely inside
 * SQLite via a recursive CTE, chunked so no single statement has to
 * hold 500k pending rows in memory at once. This exists purely to make
 * the test fast: a per-row `insertMessage()` loop pays a prepared-statement round trip 500,000 times, which is what
 * actually made this test slow — not the row count SQLite has to serve
 * queries against afterward. Ids are `printf`-built from a plain
 * incrementing counter, zero-padded into the id's leading 8 hex digits,
 * so id order stays monotonic with insertion order (rowid order) the
 * same way real UUIDv7 ids are — everything this test asserts about
 * ORDER BY and recency depends on that holding.
 */
function bulkInsertFiller(db, count, offset) {
  const CHUNK = 50_000;
  const stmt = db.raw.prepare(`
    WITH RECURSIVE seq(n) AS (
      SELECT ?
      UNION ALL
      SELECT n + 1 FROM seq WHERE n < ?
    )
    INSERT INTO messages (id, body, poster)
    SELECT
      printf('%08x-0000-7000-8000-%012x', n, n),
      printf('%s chatter about agents and forums uniquetag%d', ?, n),
      CASE WHEN n % 5000 = 0 THEN ? ELSE printf('poster%d', n % 1000) END
    FROM seq
  `);
  for (let chunkStart = 0; chunkStart < count; chunkStart += CHUNK) {
    const start = offset + chunkStart;
    const end = offset + Math.min(chunkStart + CHUNK, count) - 1;
    db.raw.exec('BEGIN');
    try {
      stmt.run(start, end, COMMON_TERM, SPARSE_POSTER);
    } finally {
      db.raw.exec('COMMIT');
    }
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
    const sanityCount = sanityCheckProductionInsertPath(db);

    bulkInsertFiller(db, SMALL_N, 0);
    const smallSearchMs = avgMs(() => db.search(`uniquetag${SMALL_N - 1}`, 20), SAMPLES);
    const smallGetMs = avgMs(() => db.getById(db.walk(1)[0].id), SAMPLES);

    bulkInsertFiller(db, LARGE_N - SMALL_N, SMALL_N);
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n, LARGE_N + sanityCount);

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

    // Guard the common-term path against a large regression relative to
    // the single-match baseline in this fixture.
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
