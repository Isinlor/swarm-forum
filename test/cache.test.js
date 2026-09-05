'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { uuidv7 } = require('../src/uuid');
const { createLatestCache } = require('../src/cache');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('createLatestCache snapshots on creation and via manual refresh', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-cache-'));
  const db = openDb(path.join(dir, 'test.db'));
  const cache = createLatestCache(db, { intervalMs: 60_000, limit: 10,
    serialize: ({ messages }) => ({ count: messages.length }),
    render: ({ messages }) => `<p>${messages.length}</p>` });
  try {
    assert.deepEqual(cache.get().messages, []);
    assert.equal(cache.get().json, '{"count":0}');
    assert.equal(cache.get().html, '<p>0</p>');

    db.insertMessage({ id: uuidv7(), message: 'hi', poster: 'poster00000000ab' });
    assert.deepEqual(cache.get().messages, []); // not yet refreshed

    const snapshot = cache.refresh();
    assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.json, '{"count":1}');
    assert.equal(snapshot.html, '<p>1</p>');
    assert.equal(cache.get().messages.length, 1);
  } finally {
    cache.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createLatestCache refreshes automatically on its interval and stops on demand', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-cache-auto-'));
  const db = openDb(path.join(dir, 'test.db'));
  const cache = createLatestCache(db, { intervalMs: 20, limit: 10 });
  try {
    db.insertMessage({ id: uuidv7(), message: 'auto', poster: 'poster00000000ab' });
    await sleep(100);
    assert.equal(cache.get().messages.length, 1);

    cache.stop();
    db.insertMessage({ id: uuidv7(), message: 'after stop', poster: 'poster00000000ab' });
    await sleep(100);
    assert.equal(cache.get().messages.length, 1); // no further auto refresh
  } finally {
    cache.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('automatic refresh logs failures and retains the last snapshot', async () => {
  let calls = 0; const errors = [];
  const db = { walk() { calls += 1; if (calls > 1) throw new Error('sqlite failed'); return [{ id: 'old' }]; } };
  const cache = createLatestCache(db, { intervalMs: 10, onError: (err) => errors.push(err) });
  try { await sleep(35); assert.deepEqual(cache.get().messages, [{ id: 'old' }]); assert.ok(errors.length > 0); }
  finally { cache.stop(); }
});

for (const failingStep of ['serialize', 'render']) {
  test(`a ${failingStep} failure retains the complete previous snapshot`, () => {
    let fail = false;
    const db = { walk: () => fail ? [{ id: 'new' }] : [{ id: 'old' }] };
    const cache = createLatestCache(db, {
      intervalMs: 60_000,
      serialize(snapshot) {
        if (fail && failingStep === 'serialize') throw new Error('serialize failed');
        return { id: snapshot.messages[0].id };
      },
      render(snapshot) {
        if (fail && failingStep === 'render') throw new Error('render failed');
        return `<p>${snapshot.messages[0].id}</p>`;
      },
    });
    try {
      const previous = cache.get();
      fail = true;
      assert.throws(() => cache.refresh(), new RegExp(`${failingStep} failed`));
      assert.strictEqual(cache.get(), previous);
      assert.equal(cache.get().json, '{"id":"old"}');
      assert.equal(cache.get().html, '<p>old</p>');
    } finally { cache.stop(); }
  });
}
