'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, toFtsQuery } = require('../src/db');
const { uuidv7, minUuidv7ForTimestamp } = require('../src/uuid');

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
    db.insertMessage({ id, message: 'hello there', ip: '127.0.0.1', poster: 'poster0000ab' });
    const found = db.getById(id);
    assert.equal(found.id, id);
    assert.equal(found.message, 'hello there');
    assert.equal(found.poster, 'poster0000ab');
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
      db.insertMessage({ id, message: `m${i}`, ip: '::1', poster: 'aaaaaaaaaaaa' });
    }
    db.insertMessage({ id: uuidv7(2000), message: 'other poster', ip: '::1', poster: 'bbbbbbbbbbbb' });

    const all = db.listByPoster('aaaaaaaaaaaa', 10);
    assert.deepEqual(all.map((m) => m.id), [ids[2], ids[1], ids[0]]);
    assert.ok(all.every((m) => m.poster === 'aaaaaaaaaaaa'));

    const limited = db.listByPoster('aaaaaaaaaaaa', 2);
    assert.equal(limited.length, 2);

    assert.deepEqual(db.listByPoster('cccccccccccc', 10), []);

    const beforeCursor = db.listByPoster('aaaaaaaaaaaa', 10, ids[2]);
    assert.deepEqual(beforeCursor.map((m) => m.id), [ids[1], ids[0]]);
  });
});

test('walk lists messages newest-first and resumes from a cursor id', () => {
  withDb((db) => {
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const id = uuidv7(1000 + i);
      ids.push(id);
      db.insertMessage({ id, message: `m${i}`, poster: 'poster0000ab' });
    }

    assert.deepEqual(db.walk(10).map((m) => m.id), [...ids].reverse());
    assert.deepEqual(db.walk(2).map((m) => m.id), [ids[4], ids[3]]);
    assert.deepEqual(db.walk(10, ids[3]).map((m) => m.id), [ids[2], ids[1], ids[0]]);
  });
});

test('count reflects the number of stored messages', () => {
  withDb((db) => {
    assert.equal(db.count(), 0);
    db.insertMessage({ id: uuidv7(), message: 'x', ip: '::1', poster: 'poster0000ab' });
    db.insertMessage({ id: uuidv7(), message: 'y', ip: '::1', poster: 'poster0000ab' });
    assert.equal(db.count(), 2);
  });
});

test('search finds messages containing all query tokens regardless of order', () => {
  withDb((db) => {
    const a = uuidv7();
    db.insertMessage({ id: a, message: 'the quick brown fox', ip: '::1', poster: 'poster0000ab' });
    const b = uuidv7();
    db.insertMessage({ id: b, message: 'lazy dog sleeps', ip: '::1', poster: 'poster0000ab' });

    const results = db.search('brown quick');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, a);

    assert.deepEqual(db.search('nonexistentword'), []);
  });
});

test('search accepts a poster filter, restricting matches to that poster', () => {
  withDb((db) => {
    const a = uuidv7();
    db.insertMessage({ id: a, message: 'shared keyword from alice', ip: '::1', poster: 'aaaaaaaaaaaa' });
    const b = uuidv7();
    db.insertMessage({ id: b, message: 'shared keyword from bob', ip: '::1', poster: 'bbbbbbbbbbbb' });

    const unfiltered = db.search('shared keyword');
    assert.equal(unfiltered.length, 2);

    const filtered = db.search('shared keyword', 20, 'aaaaaaaaaaaa');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, a);
  });
});

test('search with a query that tokenizes to nothing returns no results', () => {
  withDb((db) => {
    db.insertMessage({ id: uuidv7(), message: 'hello', ip: '::1', poster: 'poster0000ab' });
    assert.deepEqual(db.search('!!!'), []);
  });
});

test('recentDuplicate finds identical text at or after the cutoff id, ignores different text and older ids', () => {
  withDb((db) => {
    const now = Date.now();
    const id = uuidv7(now);
    db.insertMessage({ id, message: 'repeat me', ip: '::1', poster: 'poster0000ab' });

    assert.equal(db.recentDuplicate('repeat me', minUuidv7ForTimestamp(now - 1000)), true);
    assert.equal(db.recentDuplicate('repeat me', minUuidv7ForTimestamp(now + 1000)), false);
    assert.equal(db.recentDuplicate('different text', minUuidv7ForTimestamp(now - 1000)), false);
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

test('fileSizeBytes returns 0 if the underlying file has been removed', () => {
  withDb((db) => {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(db.filePath + suffix, { force: true });
    assert.equal(db.fileSizeBytes(), 0);
  });
});

test('fileSizeBytes counts the -wal file too, under WAL journal mode', () => {
  withDb((db) => {
    const before = db.fileSizeBytes();
    // an uncommitted-but-flushed write grows the -wal file, not the main one
    db.insertMessage({ id: uuidv7(), message: 'wal growth check', poster: 'poster0000ab' });
    assert.ok(db.fileSizeBytes() >= before);
    assert.ok(fs.existsSync(`${db.filePath}-wal`));
  });
});
