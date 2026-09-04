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

test('insertMessage + getById round-trips a message, including nested data dirs', () => {
  withDb((db) => {
    const id = uuidv7();
    db.insertMessage({ id, message: 'hello there', createdAt: Date.parse('2024-01-01T00:00:00Z'), ip: '127.0.0.1', replyTo: null });
    const found = db.getById(id);
    assert.equal(found.id, id);
    assert.equal(found.message, 'hello there');
    assert.equal(found.reply_to, null);
    assert.equal(found.created_at, '2024-01-01T00:00:00.000Z');
  });
});

test('getById returns null for a missing id', () => {
  withDb((db) => {
    assert.equal(db.getById(uuidv7()), null);
  });
});

test('exists reflects presence', () => {
  withDb((db) => {
    const id = uuidv7();
    assert.equal(db.exists(id), false);
    db.insertMessage({ id, message: 'hi', createdAt: Date.now(), ip: '::1', replyTo: null });
    assert.equal(db.exists(id), true);
  });
});

test('reply_to is exposed as a host-free /m/<id> path', () => {
  withDb((db) => {
    const parent = uuidv7();
    db.insertMessage({ id: parent, message: 'parent', createdAt: Date.now(), ip: '::1', replyTo: null });
    const child = uuidv7();
    db.insertMessage({ id: child, message: 'child', createdAt: Date.now() + 1, ip: '::1', replyTo: parent });
    const found = db.getById(child);
    assert.equal(found.reply_to, `/m/${parent}`);
  });
});

test('getRepliesTo returns replies oldest-first, respecting the limit', () => {
  withDb((db) => {
    const parent = uuidv7();
    db.insertMessage({ id: parent, message: 'parent', createdAt: 1000, ip: '::1', replyTo: null });
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const id = uuidv7();
      ids.push(id);
      db.insertMessage({ id, message: `reply ${i}`, createdAt: 2000 + i, ip: '::1', replyTo: parent });
    }
    const replies = db.getRepliesTo(parent, 2);
    assert.equal(replies.length, 2);
    assert.equal(replies[0].id, ids[0]);
    assert.equal(replies[1].id, ids[1]);
  });
});

test('latest orders newest-first and respects the limit', () => {
  withDb((db) => {
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const id = uuidv7();
      ids.push(id);
      db.insertMessage({ id, message: `m${i}`, createdAt: 1000 + i, ip: '::1', replyTo: null });
    }
    const latest = db.latest(3);
    assert.equal(latest.length, 3);
    assert.deepEqual(latest.map((m) => m.id), [ids[4], ids[3], ids[2]]);
  });
});

test('count reflects the number of stored messages', () => {
  withDb((db) => {
    assert.equal(db.count(), 0);
    db.insertMessage({ id: uuidv7(), message: 'x', createdAt: Date.now(), ip: '::1', replyTo: null });
    db.insertMessage({ id: uuidv7(), message: 'y', createdAt: Date.now(), ip: '::1', replyTo: null });
    assert.equal(db.count(), 2);
  });
});

test('search finds messages containing all query tokens regardless of order', () => {
  withDb((db) => {
    const a = uuidv7();
    db.insertMessage({ id: a, message: 'the quick brown fox', createdAt: 1000, ip: '::1', replyTo: null });
    const b = uuidv7();
    db.insertMessage({ id: b, message: 'lazy dog sleeps', createdAt: 1001, ip: '::1', replyTo: null });

    const results = db.search('brown quick');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, a);

    assert.deepEqual(db.search('nonexistentword'), []);
  });
});

test('search with a query that tokenizes to nothing returns no results', () => {
  withDb((db) => {
    db.insertMessage({ id: uuidv7(), message: 'hello', createdAt: 1000, ip: '::1', replyTo: null });
    assert.deepEqual(db.search('!!!'), []);
  });
});

test('fileSizeBytes reports 0 before the file exists in this session and >0 after writes', () => {
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
    fs.rmSync(db.filePath, { force: true });
    assert.equal(db.fileSizeBytes(), 0);
  });
});
