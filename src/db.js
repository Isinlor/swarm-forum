'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ip TEXT NOT NULL,
    poster TEXT NOT NULL,
    reply_to TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);
  CREATE INDEX IF NOT EXISTS idx_messages_body_created_at ON messages(body, created_at);
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
 * in any order.
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
    created_at: new Date(row.created_at).toISOString(),
    reply_to: row.reply_to ? `/m/${row.reply_to}` : null,
    poster: row.poster,
  };
}

function openDb(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const stmts = {
    insert: db.prepare(
      'INSERT INTO messages (id, body, created_at, ip, poster, reply_to) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    getById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    getRepliesTo: db.prepare(
      'SELECT * FROM messages WHERE reply_to = ? ORDER BY created_at ASC LIMIT ?',
    ),
    latest: db.prepare('SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM messages'),
    search: db.prepare(`
      SELECT m.* FROM messages_fts f
      JOIN messages m ON m.rowid = f.rowid
      WHERE messages_fts MATCH ?
      ORDER BY f.rank
      LIMIT ?
    `),
    recentDuplicate: db.prepare(
      'SELECT 1 FROM messages WHERE body = ? AND created_at > ? LIMIT 1',
    ),
  };

  return {
    raw: db,
    filePath,

    insertMessage({ id, message, createdAt, ip, poster, replyTo }) {
      stmts.insert.run(id, message, createdAt, ip, poster, replyTo ?? null);
      return { id, message, createdAt, ip, poster, replyTo: replyTo ?? null };
    },

    getById(id) {
      return rowToMessage(stmts.getById.get(id));
    },

    exists(id) {
      return stmts.getById.get(id) !== undefined;
    },

    getRepliesTo(id, limit = 100) {
      return stmts.getRepliesTo.all(id, limit).map(rowToMessage);
    },

    latest(limit = 100) {
      return stmts.latest.all(limit).map(rowToMessage);
    },

    count() {
      return stmts.count.get().n;
    },

    /** True if the exact same text was already posted after `sinceMs`,
     * via the (body, created_at) index — used to reject proof-of-work
     * replay rather than tracking spent nonces server-side. */
    recentDuplicate(body, sinceMs) {
      return stmts.recentDuplicate.get(body, sinceMs) !== undefined;
    },

    /**
     * Direct id lookup and reply-thread lookup both hit indexed columns
     * (PRIMARY KEY / idx_messages_reply_to), i.e. O(log n) per row found.
     * Free-text search goes through the FTS5 inverted index instead,
     * which resolves each term via its own O(log n) b-tree lookup.
     */
    search(query, limit = 20) {
      const ftsQuery = toFtsQuery(query);
      if (!ftsQuery) return [];
      return stmts.search.all(ftsQuery, limit).map(rowToMessage);
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
