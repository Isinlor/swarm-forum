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
  assert.equal(toFtsQuery('Hello, World!'), 'body:"hello" AND body:"world"');
  assert.equal(toFtsQuery('one "two" three'), 'body:"one" AND body:"two" AND body:"three"');
  assert.equal(toFtsQuery('   '), null);
  assert.equal(toFtsQuery('!!!'), null);
});

test('free-text terms match only message bodies, never the indexed poster column', () => {
  withDb((db) => {
    db.insertMessage({ id: uuidv7(), message: 'ordinary body', poster: 'deadbeefdeadbeef' });
    assert.deepEqual(db.search('deadbeefdeadbeef'), []);
    assert.deepEqual(db.search('deadbeefdeadbeef ordinary'), []);
    assert.equal(db.search('ordinary', 20, 'deadbeefdeadbeef').length, 1);
  });
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

test('search matches complete tokens without stemming', () => {
  withDb((db) => {
    const id = uuidv7();
    db.insertMessage({ id, message: 'running', poster: 'poster00000000ab' });

    assert.equal(db.search('running')[0].id, id);
    assert.deepEqual(db.search('run'), []);
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
