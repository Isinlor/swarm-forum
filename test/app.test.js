const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, leadingZeroBits, normalizeReplyTarget, computeDifficulty, createChallenge, isChallengeValid } = require('../src/app');
const { uuidv7 } = require('../src/uuidv7');

function mine(pathname, payload, challenge, difficulty) {
  for (let i = 0; i < 2_000_000; i += 1) {
    const nonce = i.toString(16);
    const hash = crypto.createHash('sha256').update(`${pathname}|${payload}|${challenge}|${nonce}`).digest('hex');
    if (leadingZeroBits(hash) >= difficulty) {
      return { powNonce: nonce, powHash: hash, powChallenge: challenge };
    }
  }
  throw new Error('failed to mine proof');
}

async function withServer(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-'));
  const dbPath = path.join(tempDir, 'messages.sqlite');
  const state = createApp({
    dbPath,
    cacheIntervalMs: 60_000,
    baseDifficulty: 8,
    minDifficulty: 8,
    maxDifficulty: 20,
    getResourcePressure: () => ({ cpuLoad: 0.2, diskRatio: 0.1 }),
    secret: 'test-secret-key'
  });
  const server = state.app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  async function req(route, params) {
    const query = params ? `?${new URLSearchParams(params)}` : '';
    const response = await fetch(`${base}${route}${query}`);
    return response;
  }

  async function callPow(route, params = {}) {
    const noPow = await req(route, params);
    assert.equal(noPow.status, 402);
    const bootstrap = await noPow.json();
    const payload = new URLSearchParams(params).toString();
    const proof = mine(route, payload, bootstrap.challenge, bootstrap.difficulty);
    const response = await req(route, { ...params, ...proof });
    return response;
  }

  try {
    await fn({ req, callPow, state, dbPath });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    state.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('uuidv7 creates valid sortable id', () => {
  const id1 = uuidv7(1_700_000_000_000);
  const id2 = uuidv7(1_700_000_000_001);
  assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(id1 < id2);
});

test('helper functions handle edge cases', () => {
  assert.equal(leadingZeroBits('ffffffff'), 0);
  assert.equal(leadingZeroBits('0fffffff'), 4);
  assert.equal(leadingZeroBits('00ffffff'), 8);
  assert.equal(leadingZeroBits('0000'), 16);
  assert.equal(leadingZeroBits('1fffffff'), 3);
  assert.equal(normalizeReplyTarget(''), null);
  const id = '018f6ea8-4f89-7f5f-8fd7-6ce8fc8dc001';
  assert.equal(normalizeReplyTarget(id), id);
  assert.equal(normalizeReplyTarget('/?m=' + id), id);
  assert.equal(normalizeReplyTarget('/?reply=' + id), id);
  assert.equal(normalizeReplyTarget('/m/' + id), id);
  assert.equal(normalizeReplyTarget('/m/not-an-id'), null);
  assert.equal(normalizeReplyTarget('/m/aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa'), null);
});

test('challenge validation and difficulty bounds work', () => {
  const now = Date.now();
  const token = createChallenge('secret', '127.0.0.1', now);
  assert.equal(isChallengeValid('secret', '127.0.0.1', token, now), true);
  assert.equal(isChallengeValid('secret', '127.0.0.2', token, now), false);
  assert.equal(isChallengeValid('secret', '127.0.0.1', token, now + 11 * 60 * 1000), false);
  assert.equal(isChallengeValid('secret', '127.0.0.1', 'bad.token', now), false);
  assert.equal(isChallengeValid('secret', '127.0.0.1', undefined, now), false);
  assert.equal(isChallengeValid('secret', '127.0.0.1', '123.bad.123', now), false);

  const cfg = { baseDifficulty: 5, minDifficulty: 4, maxDifficulty: 12, maxDbBytes: 100 };
  assert.equal(computeDifficulty(cfg, '/no-file', () => ({ cpuLoad: 0.95, diskRatio: 0.96 })), 12);
  assert.equal(computeDifficulty(cfg, '/no-file', () => ({ cpuLoad: 0.65, diskRatio: 0.81 })), 10);
  assert.equal(computeDifficulty(cfg, '/no-file', () => ({ cpuLoad: 0.35, diskRatio: 0.61 })), 8);
  assert.equal(computeDifficulty(cfg, '/no-file', () => ({ cpuLoad: 0.1, diskRatio: 0.41 })), 6);
  assert.equal(computeDifficulty(cfg, '/no-file', () => ({ cpuLoad: 0.1, diskRatio: 0.1 })), 5);
  assert.equal(computeDifficulty({ ...cfg, maxDbBytes: 0 }, '/no-file', () => ({ cpuLoad: 0.1 })), 5);
  assert.equal(typeof computeDifficulty(cfg, '/no-file'), 'number');
});

test('root and cache are public and self documenting', async () => {
  await withServer(async ({ req }) => {
    const root = await req('/');
    assert.equal(root.status, 200);
    const html = await root.text();
    assert.match(html, /GET-only AI message board/);
    assert.match(html, /\/api\/post\?msg=/);

    const cache = await req('/cache/latest.json');
    assert.equal(cache.status, 200);
    const data = await cache.json();
    assert.ok(Array.isArray(data.messages));
  });
});

test('posting, replying, searching and message reads require valid proof', async () => {
  await withServer(async ({ req, callPow }) => {
    const noPow = await req('/api/post', { msg: 'hello' });
    assert.equal(noPow.status, 402);

    const created = await callPow('/api/post', { msg: 'hello world' });
    assert.equal(created.status, 200);
    const postBody = await created.json();
    assert.match(postBody.id, /^[0-9a-f-]{36}$/);

    const tooLong = await callPow('/api/post', { msg: 'x'.repeat(600) });
    assert.equal(tooLong.status, 400);

    const badReply = await callPow('/api/post', { msg: 'reply', reply: '/m/not-id' });
    assert.equal(badReply.status, 400);

    const missingReply = await callPow('/api/post', {
      msg: 'reply',
      reply: '/?m=018f6ea8-4f89-7f5f-8fd7-6ce8fc8dc001'
    });
    assert.equal(missingReply.status, 400);

    const postedReply = await callPow('/api/post', { msg: 'reply ok', reply: `/?m=${postBody.id}` });
    assert.equal(postedReply.status, 200);

    const missingQuery = await callPow('/api/search', {});
    assert.equal(missingQuery.status, 400);

    const results = await callPow('/api/search', { q: 'hello', limit: '200' });
    assert.equal(results.status, 200);
    const searchBody = await results.json();
    assert.equal(searchBody.limit, 50);
    assert.equal(searchBody.messages.length, 1);

    const badId = await callPow('/api/message', { id: 'nope' });
    assert.equal(badId.status, 400);

    const notFound = await callPow('/api/message', { id: '018f6ea8-4f89-7f5f-8fd7-6ce8fc8dc001' });
    assert.equal(notFound.status, 404);

    const found = await callPow('/api/message', { id: postBody.id });
    assert.equal(found.status, 200);
    const foundBody = await found.json();
    assert.equal(foundBody.message.message, 'hello world');
  });
});

test('proof cannot be replayed and db download works with heavier proof', async () => {
  await withServer(async ({ req }) => {
    const challengeRes = await req('/api/search', { q: 'a' });
    const boot = await challengeRes.json();
    const payload = new URLSearchParams({ q: 'a' }).toString();
    const proof = mine('/api/search', payload, boot.challenge, boot.difficulty);

    const ok = await req('/api/search', { q: 'a', ...proof });
    assert.equal(ok.status, 200);
    const replay = await req('/api/search', { q: 'a', ...proof });
    assert.equal(replay.status, 402);

    const dbNoPow = await req('/api/db');
    const dbBoot = await dbNoPow.json();
    const dbProof = mine('/api/db', 'download=1', dbBoot.challenge, dbBoot.difficulty);
    const dbRes = await req('/api/db', dbProof);
    assert.equal(dbRes.status, 200);
    assert.match(dbRes.headers.get('content-disposition') || '', /swarm-forum\.sqlite/);
  });

  test('pow validation failure branches and defaults are covered', async () => {
    const originalCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-defaults-'));
    try {
      process.chdir(tempDir);
      const defaultState = createApp({ secret: 'defaults-secret', cacheIntervalMs: 60_000 });
      defaultState.close();
      const randomSecretState = createApp();
      randomSecretState.close();
    } finally {
      process.chdir(originalCwd);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });

    await withServer(async ({ req, callPow }) => {
      const missingMsg = await callPow('/api/post', {});
      assert.equal(missingMsg.status, 400);

      const blank = await callPow('/api/post', { msg: '   ' });
      assert.equal(blank.status, 400);

      const searchWithBadLimit = await callPow('/api/search', { q: 'x', limit: 'abc' });
      assert.equal(searchWithBadLimit.status, 200);
      const parsedLimit = await searchWithBadLimit.json();
      assert.equal(parsedLimit.limit, 20);

      const messageWithoutId = await callPow('/api/message', {});
      assert.equal(messageWithoutId.status, 400);

      const noPow = await req('/api/search', { q: 'x' });
      const boot = await noPow.json();
      const payload = new URLSearchParams({ q: 'x' }).toString();
      const lowNonce = '0';
      const lowHash = crypto.createHash('sha256').update(`/api/search|${payload}|${boot.challenge}|${lowNonce}`).digest('hex');
      const weak = await req('/api/search', { q: 'x', powChallenge: boot.challenge, powNonce: lowNonce, powHash: lowHash });
      assert.equal(weak.status, 402);

      const badHash = await req('/api/search', { q: 'x', powChallenge: boot.challenge, powNonce: '1', powHash: 'zz' });
      assert.equal(badHash.status, 402);

      const longNonce = await req('/api/search', {
        q: 'x',
        powChallenge: boot.challenge,
        powNonce: 'a'.repeat(65),
        powHash: '0'.repeat(64)
      });
      assert.equal(longNonce.status, 402);

      const mismatch = mine('/api/search', payload, boot.challenge, boot.difficulty);
      const mismatchHash = `${mismatch.powHash.slice(0, 63)}${mismatch.powHash.endsWith('0') ? '1' : '0'}`;
      const mismatched = await req('/api/search', { q: 'x', powChallenge: boot.challenge, powNonce: mismatch.powNonce, powHash: mismatchHash });
      assert.equal(mismatched.status, 402);

      const brokenChallenge = await req('/api/search', { q: 'x', powChallenge: 'broken', powNonce: '1', powHash: '0'.repeat(64) });
      assert.equal(brokenChallenge.status, 402);

      const ok = await req('/api/search', { q: 'x', ...mismatch });
      assert.equal(ok.status, 200);
      const originalNow = Date.now;
      Date.now = () => originalNow() + 11 * 60 * 1000;
      try {
        const future = await req('/api/search', { q: 'x' });
        assert.equal(future.status, 402);
      } finally {
        Date.now = originalNow;
      }
    });
  });
});

test('search stays indexed at scale', async () => {
  await withServer(async ({ callPow, state }) => {
    const insert = state.db.prepare('INSERT INTO messages (id, message, message_norm, timestamp, ip, reply_to) VALUES (?, ?, ?, ?, ?, NULL)');
    state.db.exec('BEGIN');
    for (let i = 0; i < 5000; i += 1) {
      const msg = `seed-${i.toString().padStart(4, '0')}`;
      insert.run(uuidv7(), msg, msg, Date.now() + i, '127.0.0.1');
    }
    state.db.exec('COMMIT');

    const plan = state.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM messages WHERE message_norm >= ? AND message_norm < ? LIMIT 20`).all('seed-', 'seed-\uffff');
    assert.ok(plan.some((row) => /idx_messages_norm/.test(row.detail)));

    const response = await callPow('/api/search', { q: 'seed-1', limit: '20' });
    const body = await response.json();
    assert.ok(body.messages.length > 0);
  });
});
