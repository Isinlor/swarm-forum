'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { timestampFromUuidv7 } = require('./uuid');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    poster TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_poster ON messages(poster, id);
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    body,
    poster,
    content='messages',
    content_rowid='rowid',
    tokenize='unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body, poster) VALUES (new.rowid, new.body, new.poster);
  END;
`;

/** Builds the FTS5 MATCH expression `search()` runs, exposed so tests can
 * run `EXPLAIN QUERY PLAN` against precisely what production executes. */
function buildSearchMatch(query, poster = null) {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return null;
  return poster ? `poster:"${poster}" AND ${ftsQuery}` : ftsQuery;
}

function searchTokens(text) {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
}

/**
 * Turns free text into a safe, sanitized FTS5 MATCH expression: every
 * token is individually quoted (neutralizing FTS operators like AND/OR/*)
 * and the tokens are ANDed together, so a message body must contain every FTS term,
 * in any order. A message id passed as `text` tokenizes into its hyphen-
 * separated hex groups, which is what lets a plain text search surface
 * messages that reference that id (see the `threading` note in the docs).
 */
function toFtsQuery(text) {
  const tokens = searchTokens(text);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `body:"${token.replace(/"/g, '""')}"`).join(' AND ');
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
  // fsync less often — the right tradeoff for a read-heavy board. WAL's
  // usual downside — the live file alone isn't a consistent snapshot —
  // doesn't apply here, since nothing in this design copies that file.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);

  const stmts = {
    insert: db.prepare('INSERT INTO messages (id, body, poster) VALUES (?, ?, ?)'),
    getById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    walk: db.prepare(SQL.walk),
    walkBefore: db.prepare(SQL.walkBefore),
    listByPoster: db.prepare(SQL.listByPoster),
    listByPosterBefore: db.prepare(SQL.listByPosterBefore),
    search: db.prepare(SQL.search),
  };

  return {
    raw: db,
    filePath,

    insertMessage({ id, message, poster }) {
      stmts.insert.run(id, message, poster);
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

    /**
     * Direct id lookup and poster lookup both hit indexed columns
     * (PRIMARY KEY / idx_messages_poster), i.e. O(log n) per row found.
     * Free-text search goes through the FTS5 inverted index instead,
     * ordered by rowid (recency) rather than BM25 rank and limited; pass
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

    close() {
      db.close();
    },
  };
}

module.exports = { openDb, searchTokens, toFtsQuery, buildSearchMatch, SQL };
