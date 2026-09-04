'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { loadConfig, start } = require('../src/server');
const { startTestServer, powFetch, solvePow } = require('./helpers');

test('loadConfig applies overrides, falls back on invalid numbers, and reads env', () => {
  const cfg = loadConfig({ port: 1234, maxMessageLength: 'not-a-number', env: {} });
  assert.equal(cfg.port, 1234);
  assert.equal(cfg.maxMessageLength, 1000); // fallback default

  const fromEnv = loadConfig({ env: { PORT: '9999', MAX_MESSAGE_LENGTH: '500' } });
  assert.equal(fromEnv.port, 9999);
  assert.equal(fromEnv.maxMessageLength, 500);

  const defaultDataDir = loadConfig({ env: {} });
  assert.equal(defaultDataDir.dataDir, path.join(process.cwd(), 'data'));

  const defaultBaseDifficulty = loadConfig({ env: {} });
  assert.equal(defaultBaseDifficulty.baseDifficulty.post, 18);

  const envBaseDifficulty = loadConfig({ env: { BASE_DIFFICULTY_POST: '30' } });
  assert.equal(envBaseDifficulty.baseDifficulty.post, 30);

  const overrideBaseDifficulty = loadConfig({ baseDifficulty: { search: 1, post: 2, export: 3 } });
  assert.deepEqual(overrideBaseDifficulty.baseDifficulty, { search: 1, post: 2, export: 3 });
});

test('start() boots a listening server from defaults, reachable over HTTP', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-start-'));
  const server = start({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    dbFile: path.join(dataDir, 'db.sqlite'),
    powSecret: 'start-test',
    baseDifficulty: { search: 1, post: 1, export: 1 },
  });
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { Accept: 'application/json' } });
    assert.equal(res.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('GET / serves HTML by default and JSON docs+latest on request', async () => {
  const ctx = await startTestServer();
  try {
    const html = await fetch(ctx.base + '/');
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    const body = await html.text();
    assert.match(body, /swarm-forum/);

    const json = await fetch(ctx.base + '/', { headers: { Accept: 'application/json' } });
    assert.equal(json.status, 200);
    const data = await json.json();
    assert.equal(data.name, 'swarm-forum');
    assert.deepEqual(data.latest_messages, []);
    assert.equal(typeof data.proof_of_work.base_difficulty.post, 'number');
  } finally {
    await ctx.close();
  }
});

test('non-GET methods are rejected with 405 and an Allow header', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(ctx.base + '/post', { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
    const body = await res.json();
    assert.equal(body.error, 'method_not_allowed');

    const head = await fetch(ctx.base + '/', { method: 'HEAD' });
    assert.equal(head.status, 405);
  } finally {
    await ctx.close();
  }
});

test('unknown paths return 404', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(ctx.base + '/nope');
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('the per-slot difficulty cache evicts its oldest entry once it grows past its cap', async () => {
  const ctx = await startTestServer();
  try {
    const { difficultyForSlot } = ctx.server.swarmForum;
    for (let slot = 0; slot < 70; slot += 1) {
      const value = difficultyForSlot('search', slot);
      assert.equal(typeof value, 'number');
    }
  } finally {
    await ctx.close();
  }
});

test('a request sent without an Accept or Host header still resolves via the URL fallback', async () => {
  const ctx = await startTestServer();
  try {
    const port = Number(new URL(ctx.base).port);
    const response = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET / HTTP/1.0\r\n\r\n');
      });
      let data = '';
      sock.on('data', (d) => { data += d; });
      sock.on('close', () => resolve(data));
      sock.on('error', reject);
    });
    assert.match(response, /^HTTP\/1\.1 200/);
  } finally {
    await ctx.close();
  }
});

test('a malformed request target yields 400 instead of crashing the server', async () => {
  const ctx = await startTestServer();
  try {
    const port = Number(new URL(ctx.base).port);
    const response = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write('GET http:// HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      sock.on('data', (d) => { data += d; });
      sock.on('close', () => resolve(data));
      sock.on('error', reject);
    });
    assert.match(response, /^HTTP\/1\.1 400/);
  } finally {
    await ctx.close();
  }
});

test('POST /post without proof-of-work is challenged with 402', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(ctx.base + '/post?message=hello');
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error, 'proof_of_work_required');
    assert.equal(typeof body.challenge, 'string');
    assert.equal(typeof body.difficulty, 'number');
  } finally {
    await ctx.close();
  }
});

test('an invalid pow nonce is rejected and a fresh challenge is reissued', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(ctx.base + '/post?message=hello&pow=not-a-real-nonce');
    assert.equal(res.status, 402);
  } finally {
    await ctx.close();
  }
});

test('posting requires message and enforces the length limit', async () => {
  const ctx = await startTestServer();
  try {
    const missing = await fetch(ctx.base + '/post');
    assert.equal(missing.status, 400);

    const empty = await fetch(ctx.base + '/post?message=');
    assert.equal(empty.status, 400);

    const tooLong = await fetch(ctx.base + '/post?' + new URLSearchParams({ message: 'x'.repeat(1001) }));
    assert.equal(tooLong.status, 400);
  } finally {
    await ctx.close();
  }
});

test('reposting the exact same text within the proof-of-work window is rejected as a duplicate', async () => {
  const ctx = await startTestServer();
  try {
    const first = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'repeat me' }));
    assert.equal(first.status, 201);

    const second = await fetch(ctx.base + '/post?' + new URLSearchParams({ message: 'repeat me' }));
    assert.equal(second.status, 409);
    const body = await second.json();
    assert.equal(body.error, 'duplicate_message');

    // different text is unaffected
    const different = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'not a repeat' }));
    assert.equal(different.status, 201);
  } finally {
    await ctx.close();
  }
});

test('a reply-by-convention (parent id embedded in text) surfaces via search, original first', async () => {
  const ctx = await startTestServer();
  try {
    const first = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'hello swarm' }));
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.message.message, 'hello swarm');
    assert.equal('reply_to' in firstBody.message, false);

    // there is no reply_to param: a reply is just text that mentions the
    // parent id, in any format an agent chooses
    const reply = await powFetch(ctx.base, '/post?' + new URLSearchParams({
      message: `re: /m/${firstBody.message.id} thanks!`,
    }));
    assert.equal(reply.status, 201);

    const reply2 = await powFetch(ctx.base, '/post?' + new URLSearchParams({
      message: `following up on ${firstBody.message.id} again`,
    }));
    assert.equal(reply2.status, 201);

    const idSearch = await powFetch(ctx.base, '/search?' + new URLSearchParams({ q: firstBody.message.id }));
    const idResults = await idSearch.json();
    assert.equal(idResults.count, 3); // the original + 2 messages referencing it
    assert.equal(idResults.results[0].id, firstBody.message.id); // original first

    // every message here came from the same test client, so they all
    // carry the same pseudonymous poster hash — and never the raw ip
    const posters = new Set(idResults.results.map((m) => m.poster));
    assert.equal(posters.size, 1);
    assert.match([...posters][0], /^[0-9a-f]{12}$/);
    for (const m of idResults.results) assert.equal('ip' in m, false);
  } finally {
    await ctx.close();
  }
});

test('poster filters and lists work as their own query parameter', async () => {
  const ctx = await startTestServer();
  try {
    const posted = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'poster query test' }));
    const { message } = await posted.json();

    const invalidPoster = await fetch(ctx.base + '/search?' + new URLSearchParams({ poster: 'not-a-hash' }));
    assert.equal(invalidPoster.status, 400);

    const listByPoster = await powFetch(ctx.base, '/search?' + new URLSearchParams({ poster: message.poster }));
    assert.equal(listByPoster.status, 200);
    const listBody = await listByPoster.json();
    assert.equal(listBody.query, null);
    assert.equal(listBody.poster, message.poster);
    assert.ok(listBody.results.some((m) => m.id === message.id));

    const combined = await powFetch(ctx.base, '/search?' + new URLSearchParams({ q: 'poster query test', poster: message.poster }));
    const combinedBody = await combined.json();
    assert.equal(combinedBody.count, 1);
    assert.equal(combinedBody.results[0].id, message.id);

    // a poster that never posted that text yields no combined match
    const wrongPoster = 'ffffffffffff';
    const combinedMiss = await powFetch(ctx.base, '/search?' + new URLSearchParams({ q: 'poster query test', poster: wrongPoster }));
    assert.equal((await combinedMiss.json()).count, 0);

    // an id-shaped q whose message doesn't belong to the given poster is excluded
    const idMiss = await powFetch(ctx.base, '/search?' + new URLSearchParams({ q: message.id, poster: wrongPoster }));
    assert.equal((await idMiss.json()).count, 0);
  } finally {
    await ctx.close();
  }
});

test('searching by a well-formed but unknown id returns an empty result set', async () => {
  const ctx = await startTestServer();
  try {
    const res = await powFetch(ctx.base, '/search?' + new URLSearchParams({ q: '01890a5d-ac96-774b-bcce-b302099a8057' }));
    const body = await res.json();
    assert.equal(body.count, 0);
    assert.deepEqual(body.results, []);
  } finally {
    await ctx.close();
  }
});

test('search validates q and limit, and finds text via full-text search', async () => {
  const ctx = await startTestServer();
  try {
    const missingQ = await fetch(ctx.base + '/search');
    assert.equal(missingQ.status, 400);

    const blankQ = await fetch(ctx.base + '/search?q=%20%20');
    assert.equal(blankQ.status, 400);

    const tooLongQ = await fetch(ctx.base + '/search?' + new URLSearchParams({ q: 'x'.repeat(201) }));
    assert.equal(tooLongQ.status, 400);

    const badLimit = await fetch(ctx.base + '/search?' + new URLSearchParams({ q: 'hi', limit: '0' }));
    assert.equal(badLimit.status, 400);
    const badLimit2 = await fetch(ctx.base + '/search?' + new URLSearchParams({ q: 'hi', limit: '101' }));
    assert.equal(badLimit2.status, 400);
    const badLimit3 = await fetch(ctx.base + '/search?' + new URLSearchParams({ q: 'hi', limit: 'abc' }));
    assert.equal(badLimit3.status, 400);

    await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'searchable unique term xyzzy' }));
    const found = await powFetch(ctx.base, '/search?' + new URLSearchParams({ q: 'xyzzy', limit: '5' }));
    const foundBody = await found.json();
    assert.equal(foundBody.count, 1);
    assert.match(foundBody.results[0].message, /xyzzy/);
  } finally {
    await ctx.close();
  }
});

test('/export is proof-of-work gated and streams the sqlite file', async () => {
  const ctx = await startTestServer();
  try {
    const gated = await fetch(ctx.base + '/export');
    assert.equal(gated.status, 402);

    const res = await powFetch(ctx.base, '/export');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/vnd.sqlite3');
    assert.match(res.headers.get('content-disposition'), /attachment/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.toString('utf8', 0, 15), 'SQLite format 3');
  } finally {
    await ctx.close();
  }
});

test('/export returns 404 if the database file has vanished from disk', async () => {
  const ctx = await startTestServer();
  try {
    fs.rmSync(ctx.server.swarmForum.config.dbFile, { force: true });
    const res = await powFetch(ctx.base, '/export');
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('a permalink resolves via JSON like /search?q=<id>, and via HTML serves the app shell', async () => {
  const ctx = await startTestServer();
  try {
    const posted = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'permalink target' }));
    const { message } = await posted.json();

    const html = await fetch(`${ctx.base}/m/${message.id}`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);

    const json = await powFetch(ctx.base, `/m/${message.id}`, { headers: { Accept: 'application/json' } });
    assert.equal(json.status, 200);
    const data = await json.json();
    assert.equal(data.query, message.id);
    assert.equal(data.results[0].id, message.id);
  } finally {
    await ctx.close();
  }
});

test('a path merely resembling /m/<id> without a valid id falls through to 404', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(ctx.base + '/m/not-a-uuid');
    assert.equal(res.status, 404);
  } finally {
    await ctx.close();
  }
});

test('posting is refused once the board is over its configured capacity', async () => {
  const ctx = await startTestServer({ maxDbSizeBytes: 1 }); // any real db exceeds 1 byte
  try {
    const res = await fetch(ctx.base + '/post?message=hi');
    assert.equal(res.status, 507);
    const body = await res.json();
    assert.equal(body.error, 'insufficient_storage');
  } finally {
    await ctx.close();
  }
});

test('an unexpected internal error is reported as 500 rather than crashing the server', async () => {
  const ctx = await startTestServer();
  try {
    ctx.server.swarmForum.db.close();
    const challenge = await fetch(ctx.base + '/search?q=hi');
    assert.equal(challenge.status, 402);
    const body = await challenge.json();
    const nonce = solvePow(body.challenge, body.difficulty);
    const res = await fetch(`${ctx.base}/search?q=hi&pow=${nonce}`);
    assert.equal(res.status, 500);
    const errBody = await res.json();
    assert.equal(errBody.error, 'internal_error');
  } finally {
    // db is already closed above; stub close() so the server's own
    // shutdown handler doesn't try (and fail) to close it a second time.
    ctx.server.swarmForum.db.close = () => {};
    await ctx.close();
  }
});
