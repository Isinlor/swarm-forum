'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { timestampFromUuidv7 } = require('./uuid');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    ip TEXT NOT NULL,
    poster TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_poster ON messages(poster);
  CREATE INDEX IF NOT EXISTS idx_messages_body_id ON messages(body, id);
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    body,
    content='messages',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
  END;
`;

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

function openDb(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const stmts = {
    insert: db.prepare('INSERT INTO messages (id, body, ip, poster) VALUES (?, ?, ?, ?)'),
    getById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    latest: db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?'),
    listByPoster: db.prepare('SELECT * FROM messages WHERE poster = ? ORDER BY id DESC LIMIT ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM messages'),
    search: db.prepare(`
      SELECT m.* FROM messages_fts f
      JOIN messages m ON m.rowid = f.rowid
      WHERE messages_fts MATCH ?
      ORDER BY f.rank
      LIMIT ?
    `),
    searchByPoster: db.prepare(`
      SELECT m.* FROM messages_fts f
      JOIN messages m ON m.rowid = f.rowid
      WHERE messages_fts MATCH ? AND m.poster = ?
      ORDER BY f.rank
      LIMIT ?
    `),
    recentDuplicate: db.prepare(
      'SELECT 1 FROM messages WHERE body = ? AND id > ? LIMIT 1',
    ),
  };

  return {
    raw: db,
    filePath,

    insertMessage({ id, message, ip, poster }) {
      stmts.insert.run(id, message, ip, poster);
      return { id, message, ip, poster };
    },

    getById(id) {
      return rowToMessage(stmts.getById.get(id));
    },

    exists(id) {
      return stmts.getById.get(id) !== undefined;
    },

    latest(limit = 100) {
      return stmts.latest.all(limit).map(rowToMessage);
    },

    /** All messages from one poster, most recent first — an exact,
     * indexed lookup, since `poster` (unlike message text) is a
     * server-generated, trustworthy identifier. */
    listByPoster(poster, limit = 20) {
      return stmts.listByPoster.all(poster, limit).map(rowToMessage);
    },

    count() {
      return stmts.count.get().n;
    },

    /** True if the exact same text was already posted at or after
     * `sinceId` (a uuidv7 lower bound, see uuid.js) — via the
     * (body, id) index — used to reject proof-of-work replay rather
     * than tracking spent nonces server-side. */
    recentDuplicate(body, sinceId) {
      return stmts.recentDuplicate.get(body, sinceId) !== undefined;
    },

    /**
     * Direct id lookup and poster lookup both hit indexed columns
     * (PRIMARY KEY / idx_messages_poster), i.e. O(log n) per row found.
     * Free-text search goes through the FTS5 inverted index instead,
     * which resolves each term via its own O(log n) b-tree lookup;
     * pass `poster` to additionally restrict results to one poster.
     */
    search(query, limit = 20, poster = null) {
      const ftsQuery = toFtsQuery(query);
      if (!ftsQuery) return [];
      const rows = poster
        ? stmts.searchByPoster.all(ftsQuery, poster, limit)
        : stmts.search.all(ftsQuery, limit);
      return rows.map(rowToMessage);
    },

    fileSizeBytes() {
      try {
        return fs.statSync(filePath).size;
      } catch {
        return 0;
      }
    },

    close() {
      db.close();
    },
  };
}

module.exports = { openDb, toFtsQuery, rowToMessage };
