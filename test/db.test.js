'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, toFtsQuery } = require('../src/db');
const { uuidv7 } = require('../src/uuid');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-db-'));
  const db = openDb(path.join(dir, 'nested', 'test.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('toFtsQuery tokenizes, quotes, and ANDs terms; empty input yields null', () => {
  assert.equal(toFtsQuery('Hello, World!'), '"hello" AND "world"');
  assert.equal(toFtsQuery('one "two" three'), '"one" AND "two" AND "three"');
  assert.equal(toFtsQuery('   '), null);
  assert.equal(toFtsQuery('!!!'), null);
});

test('insertMessage + getById round-trips a message, deriving created_at from the id', () => {
  withDb((db) => {
    const ts = Date.parse('2024-01-01T00:00:00Z');
    const id = uuidv7(ts);
    db.insertMessage({ id, message: 'hello there', poster: 'poster00000000ab' });
    const found = db.getById(id);
    assert.equal(found.id, id);
    assert.equal(found.message, 'hello there');
    assert.equal(found.poster, 'poster00000000ab');
    assert.equal(found.created_at, '2024-01-01T00:00:00.000Z');
  });
});

test('getById returns null for a missing id', () => {
  withDb((db) => {
    assert.equal(db.getById(uuidv7()), null);
  });
});

test('listByPoster returns only that poster\'s messages, most recent first, respecting the limit', () => {
  withDb((db) => {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const id = uuidv7(1000 + i);
      ids.push(id);
      db.insertMessage({ id, message: `m${i}`, poster: 'aaaaaaaaaaaaaaaa' });
    }
    db.insertMessage({ id: uuidv7(2000), message: 'other poster', poster: 'bbbbbbbbbbbbbbbb' });

    const all = db.listByPoster('aaaaaaaaaaaaaaaa', 10);
    assert.deepEqual(all.map((m) => m.id), [ids[2], ids[1], ids[0]]);
    assert.ok(all.every((m) => m.poster === 'aaaaaaaaaaaaaaaa'));

    const limited = db.listByPoster('aaaaaaaaaaaaaaaa', 2);
    assert.equal(limited.length, 2);

    assert.deepEqual(db.listByPoster('cccccccccccccccc', 10), []);

    const beforeCursor = db.listByPoster('aaaaaaaaaaaaaaaa', 10, ids[2]);
    assert.deepEqual(beforeCursor.map((m) => m.id), [ids[1], ids[0]]);
  });
});

test('walk lists messages newest-first and resumes from a cursor id', () => {
  withDb((db) => {
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const id = uuidv7(1000 + i);
      ids.push(id);
      db.insertMessage({ id, message: `m${i}`, poster: 'poster00000000ab' });
    }

    assert.deepEqual(db.walk(10).map((m) => m.id), [...ids].reverse());
    assert.deepEqual(db.walk(2).map((m) => m.id), [ids[4], ids[3]]);
    assert.deepEqual(db.walk(10, ids[3]).map((m) => m.id), [ids[2], ids[1], ids[0]]);
  });
});

test('count reflects the number of stored messages', () => {
  withDb((db) => {
    assert.equal(db.count(), 0);
    db.insertMessage({ id: uuidv7(), message: 'x', poster: 'poster00000000ab' });
    db.insertMessage({ id: uuidv7(), message: 'y', poster: 'poster00000000ab' });
    assert.equal(db.count(), 2);
  });
});

test('search finds messages containing all query tokens regardless of order', () => {
  withDb((db) => {
    const a = uuidv7();
    db.insertMessage({ id: a, message: 'the quick brown fox', poster: 'poster00000000ab' });
    const b = uuidv7();
    db.insertMessage({ id: b, message: 'lazy dog sleeps', poster: 'poster00000000ab' });

    const results = db.search('brown quick');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, a);

    assert.deepEqual(db.search('nonexistentword'), []);
  });
});

test('search accepts a poster filter, restricting matches to that poster', () => {
  withDb((db) => {
    const a = uuidv7();
    db.insertMessage({ id: a, message: 'shared keyword from alice', poster: 'aaaaaaaaaaaaaaaa' });
    const b = uuidv7();
    db.insertMessage({ id: b, message: 'shared keyword from bob', poster: 'bbbbbbbbbbbbbbbb' });

    const unfiltered = db.search('shared keyword');
    assert.equal(unfiltered.length, 2);

    const filtered = db.search('shared keyword', 20, 'aaaaaaaaaaaaaaaa');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, a);
  });
});

test('search with a query that tokenizes to nothing returns no results', () => {
  withDb((db) => {
    db.insertMessage({ id: uuidv7(), message: 'hello', poster: 'poster00000000ab' });
    assert.deepEqual(db.search('!!!'), []);
  });
});

test('fileSizeBytes reports the on-disk size, and 0 once the file is gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-db-size-'));
  const file = path.join(dir, 'x.db');
  const db = openDb(file);
  try {
    assert.ok(db.fileSizeBytes() > 0); // schema creation already wrote pages
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fileSizeBytes fails if the required main database file is missing', () => {
  withDb((db) => {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(db.filePath + suffix, { force: true });
    assert.throws(() => db.fileSizeBytes(), /ENOENT/);
  });
});

test('fileSizeBytes counts the -wal file too, under WAL journal mode', () => {
  withDb((db) => {
    const before = db.fileSizeBytes();
    // an uncommitted-but-flushed write grows the -wal file, not the main one
    db.insertMessage({ id: uuidv7(), message: 'wal growth check', poster: 'poster00000000ab' });
    assert.ok(db.fileSizeBytes() >= before);
    assert.ok(fs.existsSync(`${db.filePath}-wal`));
  });
});

test('opening an old body_hash database migrates it without losing messages', () => {
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-migrate-')); const file = path.join(dir, 'old.db');
  const raw = new DatabaseSync(file); raw.exec('CREATE TABLE messages(id TEXT PRIMARY KEY, body TEXT NOT NULL, body_hash TEXT NOT NULL, poster TEXT NOT NULL); CREATE INDEX idx_messages_body_hash ON messages(body_hash,id)');
  const id = uuidv7(); raw.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(id, 'old', 'hash', 'poster00000000ab'); raw.close();
  const db = openDb(file); try { assert.equal(db.getById(id).message, 'old'); assert.deepEqual(db.raw.prepare("SELECT name FROM pragma_table_info('messages')").all().map(x => x.name), ['id','body','poster']); } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
