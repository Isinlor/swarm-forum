'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { timestampFromUuidv7 } = require('./uuid');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    poster TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_poster ON messages(poster, id);
  CREATE INDEX IF NOT EXISTS idx_messages_body_hash ON messages(body_hash, id);
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    body,
    poster,
    content='messages',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body, poster) VALUES (new.rowid, new.body, new.poster);
  END;
`;

function hashBody(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

/** Builds the FTS5 MATCH expression `search()` runs, exposed so tests can
 * run `EXPLAIN QUERY PLAN` against precisely what production executes. */
function buildSearchMatch(query, poster = null) {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return null;
  return poster ? `poster:"${poster}" AND ${ftsQuery}` : ftsQuery;
}

/**
 * Turns free text into a safe, sanitized FTS5 MATCH expression: every
 * token is individually quoted (neutralizing FTS operators like AND/OR/*)
 * and the tokens are ANDed together, so a search must contain every word,
 * in any order. A message id passed as `text` tokenizes into its hyphen-
 * separated hex groups, which is what lets a plain text search surface
 * messages that reference that id (see the `threading` note in the docs).
 */
function toFtsQuery(text) {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ');
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    message: row.body,
    created_at: new Date(timestampFromUuidv7(row.id)).toISOString(),
    poster: row.poster,
  };
}

// Named so scale.test.js can run `EXPLAIN QUERY PLAN` against the exact
// same SQL the server executes, rather than a hand-copied approximation
// of it that could silently drift out of sync.
const SQL = {
  walk: 'SELECT * FROM messages ORDER BY id DESC LIMIT ?',
  walkBefore: 'SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?',
  listByPoster: 'SELECT * FROM messages WHERE poster = ? ORDER BY id DESC LIMIT ?',
  listByPosterBefore: 'SELECT * FROM messages WHERE poster = ? AND id < ? ORDER BY id DESC LIMIT ?',
  search: `
    SELECT m.* FROM messages_fts f
    JOIN messages m ON m.rowid = f.rowid
    WHERE messages_fts MATCH ?
    ORDER BY f.rowid DESC
    LIMIT ?
  `,
};

function openDb(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA busy_timeout = 5000');
  // WAL: readers aren't blocked for the duration of a write, and writes
  // fsync less often — the right tradeoff for a read-heavy board. Its
  // usual downside (the live file alone isn't a consistent snapshot) no
  // longer matters here since there's no file-copying /export anymore.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);

  const stmts = {
    insert: db.prepare('INSERT INTO messages (id, body, body_hash, poster) VALUES (?, ?, ?, ?)'),
    getById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    walk: db.prepare(SQL.walk),
    walkBefore: db.prepare(SQL.walkBefore),
    listByPoster: db.prepare(SQL.listByPoster),
    listByPosterBefore: db.prepare(SQL.listByPosterBefore),
    count: db.prepare('SELECT COUNT(*) AS n FROM messages'),
    search: db.prepare(SQL.search),
    recentDuplicate: db.prepare(
      'SELECT 1 FROM messages WHERE body_hash = ? AND id > ? LIMIT 1',
    ),
  };

  return {
    raw: db,
    filePath,

    insertMessage({ id, message, poster }) {
      stmts.insert.run(id, message, hashBody(message), poster);
      return { id, message, poster };
    },

    getById(id) {
      return rowToMessage(stmts.getById.get(id));
    },

    /** Newest-first walk of the whole board, optionally resuming after a
     * given id — a pure PRIMARY KEY range scan, O(log n) to seek plus
     * O(limit) to read. This is the bulk-access path (replacing a whole-
     * database download): callers page through it with their own cursor,
     * no server-side state involved. */
    walk(limit = 100, beforeId = null) {
      const rows = beforeId ? stmts.walkBefore.all(beforeId, limit) : stmts.walk.all(limit);
      return rows.map(rowToMessage);
    },

    /** All messages from one poster, most recent first — an exact,
     * indexed lookup (composite index on (poster, id), so both the
     * filter and the ORDER BY are satisfied by one b-tree walk with no
     * separate sort step), since `poster` (unlike message text) is a
     * server-generated, trustworthy identifier. */
    listByPoster(poster, limit = 20, beforeId = null) {
      const rows = beforeId
        ? stmts.listByPosterBefore.all(poster, beforeId, limit)
        : stmts.listByPoster.all(poster, limit);
      return rows.map(rowToMessage);
    },

    count() {
      return stmts.count.get().n;
    },

    /** True if the exact same text was already posted at or after
     * `sinceId` (a uuidv7 lower bound, see uuid.js) — via a hash of the
     * body rather than the body itself, so duplicate detection doesn't
     * cost a second on-disk copy of every message. Used to reject
     * proof-of-work replay rather than tracking spent nonces server-side. */
    recentDuplicate(body, sinceId) {
      return stmts.recentDuplicate.get(hashBody(body), sinceId) !== undefined;
    },

    /**
     * Direct id lookup and poster lookup both hit indexed columns
     * (PRIMARY KEY / idx_messages_poster), i.e. O(log n) per row found.
     * Free-text search goes through the FTS5 inverted index instead,
     * ordered by rowid (recency) rather than BM25 rank so cost is
     * bounded by the LIMIT rather than the total number of matches; pass
     * `poster` to additionally restrict results to one poster — folded
     * into the same MATCH expression as a `poster:"<hash>"` column
     * filter, so FTS5 intersects both doclists directly instead of
     * filtering after the fact.
     */
    search(query, limit = 20, poster = null) {
      const matchExpr = buildSearchMatch(query, poster);
      if (!matchExpr) return [];
      return stmts.search.all(matchExpr, limit).map(rowToMessage);
    },

    fileSizeBytes() {
      let total = 0;
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          total += fs.statSync(filePath + suffix).size;
        } catch {
          // that file doesn't exist (yet, or anymore) — contributes 0
        }
      }
      return total;
    },

    close() {
      db.close();
    },
  };
}

module.exports = { openDb, toFtsQuery, rowToMessage, buildSearchMatch, SQL };
