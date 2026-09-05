'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { loadConfig, start, createServer } = require('../src/server');
const { startTestServer, powFetch, solvePow } = require('./helpers');

test('loadConfig applies overrides and reads env', () => {
  const cfg = loadConfig({ port: 1234, env: {} });
  assert.equal(cfg.port, 1234);

  const fromEnv = loadConfig({ env: { PORT: '9999', MAX_MESSAGE_BYTES: '500' } });
  assert.equal(fromEnv.port, 9999);
  assert.equal(fromEnv.maxMessageBytes, 500);

  const defaultDataDir = loadConfig({ env: {} });
  assert.equal(defaultDataDir.dataDir, path.join(process.cwd(), 'data'));
  assert.equal(defaultDataDir.posterSecret, null);
  assert.equal(defaultDataDir.clientIpHops, 0);
  assert.equal(defaultDataDir.resultLimit, 100);
  assert.equal(defaultDataDir.maxPostsPerSecond, 100);
  assert.equal(defaultDataDir.minFreeBytes, 100 * 1024 * 1024);
  assert.equal(defaultDataDir.powWindowSeconds, 600);
  assert.equal(defaultDataDir.targetSearchRequestsPerSecond, 100);
  assert.equal(defaultDataDir.targetPostRequestsPerSecond, 5);
  assert.equal(defaultDataDir.maxDbSizeBytes, undefined);

  const defaultBaseDifficulty = loadConfig({ env: {} });
  assert.equal(defaultBaseDifficulty.baseDifficulty.post, 17);
  assert.equal(defaultBaseDifficulty.maxDifficulty.search, 21);
  assert.equal(defaultBaseDifficulty.maxDifficulty.post, 23);

  const envOverrides = loadConfig({ env: {
    BASE_DIFFICULTY_POST: '30',
    MAX_DIFFICULTY_POST: '40',
    CLIENT_IP_HEADER: 'x-real-ip',
    CLIENT_IP_HOPS: '2',
    POSTER_SECRET: 'from-env',
    RESULT_LIMIT: '50',
    MAX_POSTS_PER_SECOND: '25',
    POW_WINDOW_SECONDS: '600',
    TARGET_SEARCH_REQUESTS_PER_SECOND: '200',
    TARGET_POST_REQUESTS_PER_SECOND: '10',
  } });
  assert.equal(envOverrides.baseDifficulty.post, 30);
  assert.equal(envOverrides.maxDifficulty.post, 40);
  assert.equal(envOverrides.clientIpHops, 2);
  assert.equal(envOverrides.clientIpHeader, 'x-real-ip');
  assert.equal(envOverrides.posterSecret, 'from-env');
  assert.equal(envOverrides.resultLimit, 50);
  assert.equal(envOverrides.maxPostsPerSecond, 25);
  assert.equal(envOverrides.powWindowSeconds, 600);
  assert.equal(envOverrides.targetSearchRequestsPerSecond, 200);
  assert.equal(envOverrides.targetPostRequestsPerSecond, 10);

  const overrideBaseDifficulty = loadConfig({ baseDifficulty: { search: 1, post: 2 }, maxDifficulty: { search: 10, post: 20 } });
  assert.deepEqual(overrideBaseDifficulty.baseDifficulty, { search: 1, post: 2 });
  assert.deepEqual(overrideBaseDifficulty.maxDifficulty, { search: 10, post: 20 });
});

test('start() boots a listening server from defaults, reachable over HTTP', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-start-'));
  const server = start({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    dbFile: path.join(dataDir, 'db.sqlite'),
    powSecret: 'start-test',
    posterSecret: 'start-test-poster',
    baseDifficulty: { search: 1, post: 1 },
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

test('a poster secret is generated and persisted across restarts when not provided', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-poster-secret-'));
  try {
    const s1 = createServer({
      dataDir, dbFile: path.join(dataDir, 'db.sqlite'), port: 0, powSecret: 'x',
      baseDifficulty: { search: 1, post: 1 }, maxDifficulty: { search: 10, post: 10 },
    });
    await new Promise((resolve) => s1.listen(0, '127.0.0.1', resolve));
    const base1 = `http://127.0.0.1:${s1.address().port}`;
    const p1 = await powFetch(base1, '/post?' + new URLSearchParams({ message: 'persist test' }));
    const poster1 = (await p1.json()).message.poster;
    await new Promise((resolve) => s1.close(resolve));

    const secretFile = path.join(dataDir, '.poster-secret');
    assert.ok(fs.existsSync(secretFile));
    assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);

    const s2 = createServer({
      dataDir, dbFile: path.join(dataDir, 'db.sqlite'), port: 0, powSecret: 'x',
      baseDifficulty: { search: 1, post: 1 }, maxDifficulty: { search: 10, post: 10 },
    });
    await new Promise((resolve) => s2.listen(0, '127.0.0.1', resolve));
    const base2 = `http://127.0.0.1:${s2.address().port}`;
    const p2 = await powFetch(base2, '/post?' + new URLSearchParams({ message: 'persist test 2' }));
    const poster2 = (await p2.json()).message.poster;
    await new Promise((resolve) => s2.close(resolve));

    assert.equal(poster1, poster2); // same IP, same persisted secret -> same hash
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('GET / defaults to JSON (agents), and serves HTML only when explicitly requested', async () => {
  const ctx = await startTestServer();
  try {
    const jsonByDefault = await fetch(ctx.base + '/');
    assert.equal(jsonByDefault.status, 200);
    assert.match(jsonByDefault.headers.get('content-type'), /application\/json/);
    assert.match(jsonByDefault.headers.get('cache-control'), /public, max-age=/);
    assert.equal(jsonByDefault.headers.get('vary'), 'Accept');
    const data = await jsonByDefault.json();
    assert.equal(data.name, 'swarm-forum');
    assert.deepEqual(data.latest_messages, []);
    assert.equal(typeof data.proof_of_work.base_difficulty.post, 'number');
    assert.equal(typeof data.proof_of_work.max_difficulty.post, 'number');
    assert.equal(data.limits.max_posts_per_second, 100);

    const html = await fetch(ctx.base + '/', { headers: { Accept: 'text/html' } });
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(html.headers.get('vary'), 'Accept');
    const body = await html.text();
    assert.match(body, /swarm-forum/);
  } finally {
    await ctx.close();
  }
});

test('/post and /search responses are never cached; static assets revalidate', async () => {
  const ctx = await startTestServer();
  try {
    const post402 = await fetch(ctx.base + '/post?message=hi');
    assert.equal(post402.headers.get('cache-control'), 'no-store');

    const search400 = await fetch(ctx.base + '/search');
    assert.equal(search400.headers.get('cache-control'), 'no-store');

    for (const file of ['/client.js', '/pow-worker.js', '/sha256.js']) {
      const res = await fetch(ctx.base + file);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /javascript/);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      const cached = await fetch(ctx.base + file, { headers: { 'If-None-Match': res.headers.get('etag') } });
      assert.equal(cached.status, 304);
    }
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

test('unknown paths return 404, including the removed /export endpoint', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(ctx.base + '/nope');
    assert.equal(res.status, 404);
    const exportRes = await fetch(ctx.base + '/export');
    assert.equal(exportRes.status, 404);
  } finally {
    await ctx.close();
  }
});

test('a request sent without an Accept or Host header still resolves via the URL fallback, defaulting to JSON', async () => {
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
    assert.match(response, /content-type: application\/json/i);
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

test('POST /post without proof-of-work is challenged with 402, before any validation runs', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(ctx.base + '/post?message=hello');
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error, 'proof_of_work_required');
    assert.equal(typeof body.ticket, 'string');
    assert.equal(typeof body.difficulty, 'number');
    assert.equal(body.expires_in, 600);

    // Even a request with no `message` at all is gated first: nothing
    // about the request's validity is inspected before payment.
    const missing = await fetch(ctx.base + '/post');
    assert.equal(missing.status, 402);
  } finally {
    await ctx.close();
  }
});

test('an invalid pow nonce is rejected and a fresh challenge is reissued', async () => {
  // A high post difficulty here isn't about solve time (nothing in this
  // test ever solves it) — it's what makes an arbitrary garbage nonce
  // astronomically unlikely to satisfy by pure chance. The test's own
  // default (a handful of bits, tuned for fast legitimate solving
  // elsewhere) leaves a real few-percent chance that "not-a-real-nonce"
  // coincidentally meets it for whatever slot happens to be current.
  const ctx = await startTestServer({ baseDifficulty: { search: 4, post: 32 }, maxDifficulty: { search: 18, post: 32 } });
  try {
    const res = await fetch(ctx.base + '/post?message=hello&pow=not-a-real-nonce');
    assert.equal(res.status, 402);
  } finally {
    await ctx.close();
  }
});

test('a malformed PoW signature is challenged without logging an internal error', async () => {
  const ctx = await startTestServer();
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    // This has the expected JS character count but a different UTF-8 byte
    // count, the boundary that crypto.timingSafeEqual requires callers to check.
    const ticket = `x.${'é'.repeat(43)}`;
    const res = await fetch(ctx.base + '/search?' + new URLSearchParams({ q: 'x', ticket, pow: 'n' }));
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, 'proof_of_work_required');
    assert.deepEqual(errors, []);
  } finally {
    console.error = originalError;
    await ctx.close();
  }
});

test('tickets must meet current difficulty, while harder tickets remain valid', async () => {
  const ctx = await startTestServer({
    baseDifficulty: { search: 1, post: 1 },
    maxDifficulty: { search: 8, post: 8 },
  });
  try {
    const path = '/search?q=difficulty-change';
    const easyResponse = await fetch(ctx.base + path);
    const easy = await easyResponse.json();
    const easyNonce = solvePow(easy.ticket, easy.difficulty);

    ctx.server.swarmForum.config.baseDifficulty.search = 8;
    const rejected = await fetch(`${ctx.base}${path}&ticket=${encodeURIComponent(easy.ticket)}&pow=${easyNonce}`);
    assert.equal(rejected.status, 402);
    const hard = await rejected.json();
    assert.equal(hard.difficulty, 8);

    const hardNonce = solvePow(hard.ticket, hard.difficulty);
    ctx.server.swarmForum.config.baseDifficulty.search = 1;
    const accepted = await fetch(`${ctx.base}${path}&ticket=${encodeURIComponent(hard.ticket)}&pow=${hardNonce}`);
    assert.equal(accepted.status, 200);
  } finally {
    await ctx.close();
  }
});

test('posting requires message and enforces the byte limit (checked after proof-of-work)', async () => {
  const ctx = await startTestServer();
  try {
    const missing = await powFetch(ctx.base, '/post');
    assert.equal(missing.status, 400);

    const empty = await powFetch(ctx.base, '/post?message=');
    assert.equal(empty.status, 400);

    const tooLong = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'x'.repeat(2049) }));
    assert.equal(tooLong.status, 400);
    assert.match((await tooLong.json()).detail, /2048 bytes/);
  } finally {
    await ctx.close();
  }
});

test('the message limit is counted in UTF-8 bytes, not characters', async () => {
  const ctx = await startTestServer();
  try {
    // Each of these emoji is 1 JS "character" pair worth of surrogate but
    // 4 UTF-8 bytes; 600 of them is 2400 bytes, over the 2048 default.
    const message = '🚀'.repeat(600);
    assert.ok(Buffer.byteLength(message, 'utf8') > 2048);
    const res = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message }));
    assert.equal(res.status, 400);
  } finally {
    await ctx.close();
  }
});

test('a maximally percent-encoded message at the byte limit is accepted', async () => {
  const ctx = await startTestServer();
  try {
    // Encode every byte even though ASCII needs no escaping: request-line
    // representation is the sender's concern, while the server enforces the
    // exact decoded UTF-8 byte limit.
    const message = 'x'.repeat(2048);
    const encodedMessage = '%78'.repeat(2048);
    const challenge = await fetch(`${ctx.base}/post?message=${encodedMessage}`);
    const body = await challenge.json();
    const nonce = solvePow(body.ticket, body.difficulty);
    const res = await fetch(`${ctx.base}/post?message=${encodedMessage}` +
      `&ticket=${encodeURIComponent(body.ticket)}&pow=${nonce}`);
    assert.equal(res.status, 201);
    assert.equal((await res.json()).message.message, message);
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
    assert.equal(idResults.count, 3);
    assert.equal(idResults.results[0].id, firstBody.message.id);

    const posters = new Set(idResults.results.map((m) => m.poster));
    assert.equal(posters.size, 1);
    assert.match([...posters][0], /^[0-9a-f]{16}$/);
    for (const m of idResults.results) assert.equal('ip' in m, false);
  } finally {
    await ctx.close();
  }
});

test('a padded uppercase UUID query is canonicalized before the direct id lookup', async () => {
  const ctx = await startTestServer();
  try {
    const posted = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'trim me' }));
    const { message } = await posted.json();

    const padded = await powFetch(ctx.base, '/search?' + new URLSearchParams({ q: `  ${message.id.toUpperCase()}  ` }));
    const body = await padded.json();
    assert.equal(body.count, 1);
    assert.equal(body.query, message.id);
    assert.equal(body.results[0].id, message.id);
  } finally {
    await ctx.close();
  }
});

test('poster filters and lists work as their own query parameter, gated before validation', async () => {
  const ctx = await startTestServer();
  try {
    const posted = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'poster query test' }));
    const { message } = await posted.json();

    // An invalid poster is still gated first, not surfaced for free.
    const invalidPosterNoPow = await fetch(ctx.base + '/search?' + new URLSearchParams({ poster: 'not-a-hash' }));
    assert.equal(invalidPosterNoPow.status, 402);
    const invalidPoster = await powFetch(ctx.base, '/search?' + new URLSearchParams({ poster: 'not-a-hash' }));
    assert.equal(invalidPoster.status, 400);

    const listByPoster = await powFetch(ctx.base, '/search?' + new URLSearchParams({ poster: message.poster.toUpperCase() }));
    assert.equal(listByPoster.status, 200);
    const listBody = await listByPoster.json();
    assert.equal(listBody.query, null);
    assert.equal(listBody.poster, message.poster);
    assert.ok(listBody.results.some((m) => m.id === message.id));

    const combined = await powFetch(ctx.base, '/search?' + new URLSearchParams({
      q: 'poster query test', poster: message.poster.toUpperCase(),
    }));
    const combinedBody = await combined.json();
    assert.equal(combinedBody.count, 1);
    assert.equal(combinedBody.results[0].id, message.id);

    const wrongPoster = 'ffffffffffffffff';
    const combinedMiss = await powFetch(ctx.base, '/search?' + new URLSearchParams({ q: 'poster query test', poster: wrongPoster }));
    assert.equal((await combinedMiss.json()).count, 0);

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

test('search requires q, poster, or before; a stray `limit` param has no effect (it is not a thing anymore)', async () => {
  const ctx = await startTestServer();
  try {
    const missingAll = await powFetch(ctx.base, '/search');
    assert.equal(missingAll.status, 400);
    assert.match((await missingAll.json()).detail, /q, poster, or before/);

    const blankQ = await powFetch(ctx.base, '/search?q=%20%20');
    assert.equal(blankQ.status, 400);

    const tooLongQ = await powFetch(ctx.base, '/search?' + new URLSearchParams({ q: 'x'.repeat(201) }));
    assert.equal(tooLongQ.status, 400);

    await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'searchable unique term xyzzy' }));
    const found = await powFetch(ctx.base, '/search?' + new URLSearchParams({ q: 'xyzzy', limit: '999999' }));
    const foundBody = await found.json();
    assert.equal(foundBody.count, 1);
    assert.match(foundBody.results[0].message, /xyzzy/);
  } finally {
    await ctx.close();
  }
});

test('search rejects a malformed `before` cursor, and walks the board newest-first when given a valid one', async () => {
  const ctx = await startTestServer();
  try {
    const badBefore = await powFetch(ctx.base, '/search?before=not-a-uuid');
    assert.equal(badBefore.status, 400);

    const first = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'walk one' }));
    const m1 = (await first.json()).message;
    const second = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'walk two' }));
    const m2 = (await second.json()).message;

    const page1 = await powFetch(ctx.base, '/search?' + new URLSearchParams({ before: m2.id.toUpperCase() }));
    const page1Body = await page1.json();
    assert.equal(page1Body.before, m2.id);
    assert.deepEqual(page1Body.results.map((m) => m.id), [m1.id]);
  } finally {
    await ctx.close();
  }
});

test('combining q with before is rejected instead of silently ignoring the cursor', async () => {
  const ctx = await startTestServer();
  try {
    const posted = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'paginate me' }));
    const { message } = await posted.json();

    const combined = await powFetch(ctx.base, '/search?' + new URLSearchParams({ q: 'paginate', before: message.id }));
    assert.equal(combined.status, 400);
    assert.match((await combined.json()).detail, /before cannot be combined with q/);
  } finally {
    await ctx.close();
  }
});

test('a permalink serves the app shell with that message rendered when HTML is explicitly requested, JSON (via /search) otherwise', async () => {
  const ctx = await startTestServer();
  try {
    const posted = await powFetch(ctx.base, '/post?' + new URLSearchParams({ message: 'permalink target' }));
    const { message } = await posted.json();

    const jsonByDefault = await fetch(`${ctx.base}/m/${message.id}`);
    assert.match(jsonByDefault.headers.get('content-type'), /application\/json/);

    const html = await fetch(`${ctx.base}/m/${message.id}`, { headers: { Accept: 'text/html' } });
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.equal(html.headers.get('vary'), 'Accept');
    const htmlBody = await html.text();
    assert.match(htmlBody, new RegExp(`rel="canonical" href="/m/${message.id}"`));
    assert.match(htmlBody, new RegExp(message.id));

    const uppercase = await fetch(`${ctx.base}/m/${message.id.toUpperCase()}`, { headers: { Accept: 'text/html' } });
    assert.equal(uppercase.status, 200);
    assert.match(await uppercase.text(), new RegExp(`rel="canonical" href="/m/${message.id}"`));

    const json = await powFetch(ctx.base, `/m/${message.id.toUpperCase()}`, { headers: { Accept: 'application/json' } });
    assert.equal(json.status, 200);
    const data = await json.json();
    assert.equal(data.query, message.id);
    assert.equal(data.results[0].id, message.id);
  } finally {
    await ctx.close();
  }
});

test('an HTML permalink request for a well-formed but missing id returns 404', async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.base}/m/01890a5d-ac96-774b-bcce-b302099a8057`, { headers: { Accept: 'text/html' } });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not_found');
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

test('malformed permalink encoding is rejected as bad input without logging an internal error', async () => {
  const ctx = await startTestServer();
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    for (const path of ['/m/%', '/m/%C0%AF']) {
      const res = await fetch(ctx.base + path);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'bad_request', detail: 'malformed permalink' });
    }
    assert.deepEqual(errors, []);
  } finally {
    console.error = originalError;
    await ctx.close();
  }
});

test('posting is refused once free disk space drops below the configured floor', async () => {
  // A MIN_FREE_BYTES far above real free disk space simulates "the disk
  // is nearly full" without actually filling it — proving the ceiling
  // fires on raw byte comparisons well before free space hits zero.
  const ctx = await startTestServer({ minFreeBytes: Number.MAX_SAFE_INTEGER });
  try {
    const res = await fetch(ctx.base + '/post?message=hi');
    assert.equal(res.status, 507);
  } finally {
    await ctx.close();
  }
});

test('proxy headers are ignored by default and require trusted hops to opt in', async () => {
  const direct = await startTestServer();
  const proxied = await startTestServer({ clientIpHeader: 'x-forwarded-for', clientIpHops: 1 });
  try {
    const directRes = await powFetch(direct.base, '/post?' + new URLSearchParams({ message: 'direct' }), {
      headers: { 'X-Forwarded-For': '203.0.113.5' },
    });
    const directPoster = (await directRes.json()).message.poster;

    const ignoredRes = await powFetch(direct.base, '/post?' + new URLSearchParams({ message: 'direct again' }), {
      headers: { 'X-Forwarded-For': '203.0.113.99' },
    });
    const ignoredPoster = (await ignoredRes.json()).message.poster;
    assert.equal(directPoster, ignoredPoster); // header differs but direct socket is used when no configured header

    const proxiedRes = await powFetch(proxied.base, '/post?' + new URLSearchParams({ message: 'via proxy' }), {
      headers: { 'X-Forwarded-For': '203.0.113.5' },
    });
    const proxiedPoster = (await proxiedRes.json()).message.poster;
    assert.notEqual(proxiedPoster, directPoster); // different (trusted) claimed origin -> different hash
  } finally {
    await direct.close();
    await proxied.close();
  }
});

test('post payment remains valid when a proxy exit changes between challenge and retry', async () => {
  const ctx = await startTestServer();
  try {
    const challenged = await fetch(ctx.base + '/post?message=mobile-agent', {
      headers: { 'X-Forwarded-For': '203.0.113.10' },
    });
    const body = await challenged.json();
    const nonce = solvePow(body.ticket, body.difficulty);
    const paid = await fetch(`${ctx.base}/post?message=mobile-agent&ticket=${encodeURIComponent(body.ticket)}&pow=${nonce}`, {
      headers: { 'X-Forwarded-For': '203.0.113.20' },
    });
    assert.equal(paid.status, 201);
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
    const nonce = solvePow(body.ticket, body.difficulty);
    const res = await fetch(`${ctx.base}/search?q=hi&ticket=${encodeURIComponent(body.ticket)}&pow=${nonce}`);
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

test('configuration and Accept quality values are validated strictly', () => {
  const { wantsHtml } = require('../src/server');
  for (const overrides of [
    { maxMessageBytes: 0 }, { maxPostsPerSecond: 0 }, { minFreeBytes: -1 },
    { targetSearchRequestsPerSecond: 0 }, { targetPostRequestsPerSecond: 0 },
    { clientIpHops: -1 }, { clientIpHops: 1.5 },
    { clientIpHeader: 'bad header' }, { baseDifficulty: { search: -1, post: 1 } },
    { maxDifficulty: { search: 257, post: 21 } }, { env: { PORT: 'nope' } },
  ]) assert.throws(() => loadConfig(overrides));
  assert.equal(wantsHtml({ headers: { accept: 'text/html;q=0, application/json' } }), false);
  assert.equal(wantsHtml({ headers: { accept: 'text/html; q=0.5' } }), true);
  assert.equal(wantsHtml({ headers: { accept: 'text/html;q=nonsense' } }), false);
  assert.equal(wantsHtml({ headers: { accept: 'text/html;level=1;q=2' } }), true);
  assert.equal(wantsHtml({ headers: { accept: 'text/html;q=-1' } }), false);
});

test('a successful ticket is single-use', async () => {
  const ctx = await startTestServer();
  try {
    const first = await fetch(ctx.base + '/search?q=once'); const body = await first.json();
    const nonce = solvePow(body.ticket, body.difficulty);
    const paid = `${ctx.base}/search?q=once&ticket=${encodeURIComponent(body.ticket)}&pow=${nonce}`;
    assert.equal((await fetch(paid)).status, 200);
    const replay = await fetch(paid); assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error, 'ticket_already_used');
    const noNonce = await fetch(`${ctx.base}/search?q=changed&ticket=${encodeURIComponent(body.ticket)}`);
    assert.equal(noNonce.status, 409);
    assert.equal((await noNonce.json()).error, 'ticket_already_used');
  } finally { await ctx.close(); }
});

test('posting has a hard per-second ceiling even with valid proof-of-work', async () => {
  const ctx = await startTestServer({
    maxPostsPerSecond: 1,
    baseDifficulty: { search: 0, post: 0 },
  });
  try {
    const paidUrl = async (message) => {
      const path = '/post?' + new URLSearchParams({ message });
      const challenge = await fetch(ctx.base + path);
      const body = await challenge.json();
      const url = new URL(ctx.base + path);
      url.searchParams.set('ticket', body.ticket);
      url.searchParams.set('pow', solvePow(body.ticket, body.difficulty));
      return url;
    };
    const firstUrl = await paidUrl('within cap');
    const secondUrl = await paidUrl('over cap');
    while (Date.now() % 1000 > 100) await new Promise((resolve) => setTimeout(resolve, 10));
    const first = await fetch(firstUrl);
    const second = await fetch(secondUrl);
    assert.equal(first.status, 201);
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '1');
    assert.equal((await second.json()).error, 'rate_limit_exceeded');
  } finally { await ctx.close(); }
});

test('post rechecks capacity after payment and post tickets cannot be replayed', async () => {
  const ctx = await startTestServer();
  try {
    const challenge = await fetch(ctx.base + '/post?message=once'); const body = await challenge.json();
    const nonce = solvePow(body.ticket, body.difficulty);
    const paid = `${ctx.base}/post?message=once&ticket=${encodeURIComponent(body.ticket)}&pow=${nonce}`;
    assert.equal((await fetch(paid)).status, 201);
    assert.equal((await fetch(paid)).status, 409);

    const next = await fetch(ctx.base + '/post?message=full'); const nextBody = await next.json();
    const nextNonce = solvePow(nextBody.ticket, nextBody.difficulty);
    ctx.server.swarmForum.config.minFreeBytes = Number.MAX_SAFE_INTEGER;
    const full = await fetch(`${ctx.base}/post?message=full&ticket=${encodeURIComponent(nextBody.ticket)}&pow=${nextNonce}`);
    assert.equal(full.status, 507);
  } finally { await ctx.close(); }
});

test('a paid post fails closed when its final capacity measurement fails', async () => {
  const ctx = await startTestServer();
  try {
    // Prime the memoized approximate state, then make only the mandatory final reading fail.
    ctx.server.swarmForum.computeState('post');
    const challenge = await fetch(ctx.base + '/post?message=capacity-check');
    const body = await challenge.json();
    const nonce = solvePow(body.ticket, body.difficulty);
    ctx.server.swarmForum.config.dataDir = '/path/does/not/exist/at/all';
    const res = await fetch(`${ctx.base}/post?message=capacity-check&ticket=${encodeURIComponent(body.ticket)}&pow=${nonce}`);
    assert.equal(res.status, 507); assert.equal((await res.json()).error, 'insufficient_storage');
  } finally { await ctx.close(); }
});
