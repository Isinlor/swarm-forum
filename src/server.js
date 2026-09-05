'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { openDb } = require('./db');
const { createLatestCache } = require('./cache');
const { uuidv7, isUuid } = require('./uuid');
const pow = require('./pow');
const resources = require('./resources');
const { posterHash, isPosterHash } = require('./poster');
const { loadOrCreateSecret } = require('./secret');
const { clientIp } = require('./ip');
const { createRequestRateTracker, createPerSecondLimiter } = require('./rate');
const { buildDocs, renderHome, renderMessageJson } = require('./render');

const STATIC_FILES = {
  '/client.js': { path: path.join(__dirname, 'public', 'client.js'), type: 'text/javascript; charset=utf-8' },
  '/pow-worker.js': { path: path.join(__dirname, 'public', 'pow-worker.js'), type: 'text/javascript; charset=utf-8' },
  '/sha256.js': { path: path.join(__dirname, 'sha256.js'), type: 'text/javascript; charset=utf-8' },
};
const STATIC_FILE_CONTENTS = Object.fromEntries(
  Object.entries(STATIC_FILES).map(([route, { path: filePath, type }]) => [
    route,
    (() => { const body = fs.readFileSync(filePath, 'utf8'); return {
      body, type, etag: `"${crypto.createHash('sha256').update(body).digest('base64url')}"`,
    }; })(),
  ]),
);
// worker-src 'self': the PoW worker is a same-origin file (/pow-worker.js
// importScripts()-ing /sha256.js), not a blob: URL, so no relaxation of
// the default script-loading rules is needed beyond same-origin.
// style-src allows 'unsafe-inline' because the page's CSS lives in one
// inline <style> block rather than a separate file — inline *styles*
// don't get the same allowance in this policy as inline *scripts* would
// (which stay forbidden): a CSS injection is a much weaker primitive
// than script execution, and no user content is ever written into style
// context here.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "object-src 'none'; base-uri 'none'; worker-src 'self'";
function loadConfig(overrides = {}) {
  const env = overrides.env || process.env;
  const num = (name, fallback) => {
    const raw = overrides[name] ?? env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
    return parsed;
  };
  const dataDir = overrides.dataDir || env.DATA_DIR || path.join(process.cwd(), 'data');
  const config = {
    port: num('port', num('PORT', 8080)),
    host: overrides.host || env.HOST || '0.0.0.0',
    dataDir,
    dbFile: overrides.dbFile || path.join(dataDir, 'swarm-forum.db'),
    powSecret: overrides.powSecret || env.POW_SECRET || crypto.randomBytes(32).toString('hex'),
    // Unlike powSecret, this has no in-process fallback: it must survive
    // restarts (rotating it reassigns every poster hash on the board), so
    // when it isn't explicitly provided, createServer loads or creates a
    // persisted one from disk (see secret.js) rather than generating a
    // fresh, unpersisted one here.
    posterSecret: overrides.posterSecret || env.POSTER_SECRET || null,
    clientIpHeader: overrides.clientIpHeader ?? env.CLIENT_IP_HEADER ?? 'x-forwarded-for',
    clientIpHops: num('clientIpHops', num('CLIENT_IP_HOPS', 0)),
    maxMessageBytes: num('maxMessageBytes', num('MAX_MESSAGE_BYTES', 2048)),
    maxQueryLength: num('maxQueryLength', num('MAX_QUERY_LENGTH', 200)),
    resultLimit: num('resultLimit', num('RESULT_LIMIT', 100)),
    latestLimit: num('latestLimit', num('LATEST_LIMIT', 100)),
    cacheIntervalMs: num('cacheIntervalMs', num('CACHE_INTERVAL_MS', 5000)),
    powWindowSeconds: num('powWindowSeconds', num('POW_WINDOW_SECONDS', 300)),
    minFreeBytes: num('minFreeBytes', num('MIN_FREE_BYTES', 100 * 1024 * 1024)),
    targetRequestsPerSecond: num('targetRequestsPerSecond', num('TARGET_REQUESTS_PER_SECOND', 5)),
    maxPostsPerSecond: num('maxPostsPerSecond', num('MAX_POSTS_PER_SECOND', 100)),
    baseDifficulty: overrides.baseDifficulty || {
      search: num('baseDifficultySearch', num('BASE_DIFFICULTY_SEARCH', resources.BASE_DIFFICULTY.search)),
      post: num('baseDifficultyPost', num('BASE_DIFFICULTY_POST', resources.BASE_DIFFICULTY.post)),
    },
    maxDifficulty: overrides.maxDifficulty || {
      search: num('maxDifficultySearch', num('MAX_DIFFICULTY_SEARCH', resources.MAX_DIFFICULTY.search)),
      post: num('maxDifficultyPost', num('MAX_DIFFICULTY_POST', resources.MAX_DIFFICULTY.post)),
    },
  };
  const positive = ['maxMessageBytes', 'maxQueryLength', 'resultLimit', 'latestLimit',
    'cacheIntervalMs', 'powWindowSeconds', 'targetRequestsPerSecond', 'maxPostsPerSecond'];
  const nonnegative = ['port', 'minFreeBytes'];
  const integers = [...positive, ...nonnegative, 'clientIpHops'];
  for (const name of integers) if (!Number.isInteger(config[name])) throw new Error(`${name} must be an integer`);
  for (const name of positive) if (config[name] <= 0) throw new Error(`${name} must be positive`);
  for (const name of nonnegative) if (config[name] < 0) throw new Error(`${name} must be nonnegative`);
  if (config.clientIpHops < 0) throw new Error('clientIpHops must be nonnegative');
  if (typeof config.clientIpHeader !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(config.clientIpHeader))
    throw new Error('clientIpHeader must be a valid HTTP header name');
  for (const endpoint of ['search', 'post']) {
    const base = config.baseDifficulty[endpoint]; const max = config.maxDifficulty[endpoint];
    if (!Number.isInteger(base) || !Number.isInteger(max) || base < 0 || base > max || max > 256)
      throw new Error(`difficulty for ${endpoint} must satisfy 0 <= base <= max <= 256`);
  }
  return config;
}

function sendJson(res, status, body, cacheControl = 'no-store', extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': cacheControl,
    ...extraHeaders,
  });
  res.end(payload);
}

function sendHtml(res, status, html, cacheControl = 'no-store', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': cacheControl,
    'Content-Security-Policy': CSP,
    ...extraHeaders,
  });
  res.end(html);
}

// Agents are the primary audience, and every HTTP client defaults to
// `Accept: */*` (or sends nothing) unless told otherwise — only an actual
// browser sends a literal `text/html`. So JSON is the default; HTML is
// the special case that has to ask for itself explicitly.
function wantsHtml(req) {
  const ranges = (req.headers.accept || '').split(',').map((part) => {
    const [type, ...params] = part.trim().toLowerCase().split(';');
    let q = 1;
    for (const param of params) if (param.trim().startsWith('q=')) {
      const parsed = Number(param.trim().slice(2)); q = Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
    }
    return { type, q };
  });
  const match = ranges.find((range) => range.type === 'text/html');
  return Boolean(match && match.q > 0);
}

/** Runs `fn` at most once per `ttlMs`, returning the cached value
 * otherwise — used to keep the O(1)-per-request resource-pressure read
 * from becoming a syscall-per-request one. */
function memoize(fn, ttlMs) {
  let cached;
  let cachedAt = 0;
  return () => {
    const now = Date.now();
    if (cachedAt === 0 || now - cachedAt >= ttlMs) {
      cached = fn();
      cachedAt = now;
    }
    return cached;
  };
}

function createServer(overrides = {}) {
  const config = loadConfig(overrides);
  if (!config.posterSecret) {
    const secretFile = path.join(config.dataDir, '.poster-secret');
    const { secret, generated } = loadOrCreateSecret(secretFile);
    config.posterSecret = secret;
    if (generated) {
      // eslint-disable-next-line no-console
      console.log(
        `swarm-forum: generated a new poster secret at ${secretFile}. If you run more than one ` +
        'instance, set POSTER_SECRET to the same value on all of them so poster hashes agree.',
      );
    }
  }

  const db = openDb(config.dbFile);
  const cache = createLatestCache(db, { intervalMs: config.cacheIntervalMs, limit: config.latestLimit });
  const rateTracker = createRequestRateTracker();
  const postRateLimiter = createPerSecondLimiter(config.maxPostsPerSecond);
  const instanceId = crypto.randomBytes(16).toString('base64url');
  const tickets = pow.createTicketStore(config.powWindowSeconds * 1000);

  const computeState = memoize(() => resources.currentState({
    dataDir: config.dataDir,
    minFreeBytes: config.minFreeBytes,
    loadRatio: rateTracker.ratePerSecond() / config.targetRequestsPerSecond,
  }), 1000);

  const docs = () => buildDocs({
    version: require('../package.json').version,
    latestLimit: config.latestLimit,
    cacheIntervalMs: config.cacheIntervalMs,
    maxMessageBytes: config.maxMessageBytes,
    maxQueryLength: config.maxQueryLength,
    resultLimit: config.resultLimit,
    maxPostsPerSecond: config.maxPostsPerSecond,
    powWindowSeconds: config.powWindowSeconds,
    baseDifficulty: config.baseDifficulty,
    maxDifficulty: config.maxDifficulty,
  });

  /** Returns true (request may proceed) once a valid proof is present;
   * otherwise sends a 402 challenge and returns false. This is always
   * the first real work either handler below does — before any
   * validation or database access — so an unauthenticated request never
   * costs the server anything beyond reading its own query string. */
  function gate(req, res, url, endpoint) {
    const now = Date.now();
    const nonce = url.searchParams.get('pow');
    const ticket = url.searchParams.get('ticket');
    const verified = ticket && nonce && pow.verifyTicket(config.powSecret, instanceId,
      url.pathname, url.searchParams, ticket, nonce, { now });
    const difficultyValue = resources.computeDifficulty(endpoint, computeState(), config.baseDifficulty, config.maxDifficulty);
    // A signed ticket proves what difficulty was advertised, but an old easy
    // ticket must not become a way to bypass a load-driven increase. Tickets
    // from a harder period remain valid when pressure falls.
    if (verified && verified.d >= difficultyValue) return verified;
    const challenge = pow.issueTicket(config.powSecret, instanceId, url.pathname, url.searchParams,
      difficultyValue, { now, lifetimeMs: config.powWindowSeconds * 1000 });
    sendJson(res, 402, { error: 'proof_of_work_required', ...challenge });
    return null;
  }

  function consume(ticket) {
    if (!tickets.consume(ticket.j)) return false;
    rateTracker.record();
    return true;
  }

  const homeCacheControl = () => `public, max-age=${Math.round(config.cacheIntervalMs / 1000)}`;

  function handleHome(req, res) {
    const snapshot = cache.get();
    if (!wantsHtml(req)) {
      sendJson(res, 200, {
        ...docs(),
        updated_at: new Date(snapshot.updatedAt).toISOString(),
        latest_messages: snapshot.messages.map(renderMessageJson),
      }, homeCacheControl(), { Vary: 'Accept' });
      return;
    }
    const html = renderHome({ docs: docs(), latest: snapshot.messages, updatedAt: snapshot.updatedAt });
    sendHtml(res, 200, html, homeCacheControl(), { Vary: 'Accept' });
  }

  function handlePermalinkHtml(res, id) {
    const message = db.getById(id);
    if (!message) {
      sendJson(res, 404, { error: 'not_found', detail: 'no such message' });
      return;
    }
    const html = renderHome({
      docs: docs(),
      latest: [message],
      updatedAt: Date.now(),
      canonicalPath: `/m/${id}`,
    });
    sendHtml(res, 200, html, undefined, { Vary: 'Accept' });
  }

  function handlePost(req, res, url) {
    // A cheap, cached read — refusing outright when the board is over
    // capacity costs nothing worth gating, so it can run ahead of gate().
    if (resources.isOverCapacity(computeState())) {
      sendJson(res, 507, { error: 'insufficient_storage', detail: 'the board is at capacity; try again later' });
      return;
    }
    const paid = gate(req, res, url, 'post');
    if (!paid) return;

    const message = url.searchParams.get('message');
    if (!message) {
      sendJson(res, 400, { error: 'bad_request', detail: 'message is required' });
      return;
    }
    // Belt check ahead of the precise byte count: an encoded query string
    // wildly out of proportion to the byte budget it could legitimately
    // encode isn't worth decoding further.
    if (url.search.length > config.maxMessageBytes * 3 + 64) {
      sendJson(res, 400, { error: 'bad_request', detail: 'request too large' });
      return;
    }
    if (Buffer.byteLength(message, 'utf8') > config.maxMessageBytes) {
      sendJson(res, 400, { error: 'bad_request', detail: `message exceeds ${config.maxMessageBytes} bytes` });
      return;
    }
    let finalState;
    try { finalState = resources.currentState({ dataDir: config.dataDir,
      minFreeBytes: config.minFreeBytes, loadRatio: rateTracker.ratePerSecond() / config.targetRequestsPerSecond }); }
    catch (err) { console.error('swarm-forum: final capacity measurement failed', err);
      sendJson(res, 507, { error: 'insufficient_storage', detail: 'capacity could not be verified' }); return; }
    if (resources.isOverCapacity(finalState)) { sendJson(res, 507, { error: 'insufficient_storage', detail: 'the board is at capacity; try again later' }); return; }
    if (!consume(paid)) { sendJson(res, 409, { error: 'ticket_already_used' }); return; }
    if (!postRateLimiter.take()) {
      sendJson(res, 429, { error: 'rate_limit_exceeded', detail: `at most ${config.maxPostsPerSecond} posts are accepted per second` },
        'no-store', { 'Retry-After': '1' });
      return;
    }
    const ip = clientIp(req, config.clientIpHeader, config.clientIpHops);
    const id = uuidv7();
    db.insertMessage({ id, message, poster: posterHash(config.posterSecret, ip) });
    const saved = db.getById(id);
    sendJson(res, 201, { message: renderMessageJson(saved) });
  }

  function handleSearch(req, res, url, overrideQuery) {
    const paid = gate(req, res, url, 'search');
    if (!paid) return;

    const rawQ = overrideQuery ?? url.searchParams.get('q');
    const q = rawQ ? rawQ.trim() : null;
    const poster = url.searchParams.get('poster');
    const before = url.searchParams.get('before');

    if (poster !== null && !isPosterHash(poster)) {
      sendJson(res, 400, { error: 'bad_request', detail: 'poster must be a valid poster hash' });
      return;
    }
    if (before !== null && !isUuid(before)) {
      sendJson(res, 400, { error: 'bad_request', detail: 'before must be a message id' });
      return;
    }
    // `before` paginates a plain (q-less) walk; combined with `q` it would
    // silently do nothing (see the dispatch below), which would look to a
    // paginating caller like every page after the first came back empty
    // or repeated. Refusing the combination is better than honoring one
    // and pretending the other still took effect.
    if (q && before) {
      sendJson(res, 400, { error: 'bad_request', detail: 'before cannot be combined with q; before paginates a plain walk' });
      return;
    }
    if (!q && !poster && !before) {
      sendJson(res, 400, { error: 'bad_request', detail: 'q, poster, or before is required' });
      return;
    }
    if (q && q.length > config.maxQueryLength) {
      sendJson(res, 400, { error: 'bad_request', detail: `q exceeds ${config.maxQueryLength} characters` });
      return;
    }

    if (!consume(paid)) { sendJson(res, 409, { error: 'ticket_already_used' }); return; }
    let results;
    if (q && isUuid(q)) {
      // The id itself is an exact, indexed lookup. Anything *referencing*
      // that id — a reply, in convention — is just text containing it,
      // so it's found the same way any other text is: through FTS.
      let direct = db.getById(q);
      if (direct && poster && direct.poster !== poster) direct = null;
      const mentions = db.search(q, config.resultLimit, poster);
      results = direct ? [direct, ...mentions.filter((m) => m.id !== direct.id)] : mentions;
      results = results.slice(0, config.resultLimit);
    } else if (q) {
      results = db.search(q, config.resultLimit, poster);
    } else if (poster) {
      results = db.listByPoster(poster, config.resultLimit, before);
    } else {
      results = db.walk(config.resultLimit, before);
    }
    sendJson(res, 200, { query: q, poster, before, count: results.length, results: results.map(renderMessageJson) });
  }

  const server = http.createServer((req, res) => {
    // GET only, deliberately: HEAD would need to carry a 402 challenge
    // body, but HEAD responses have no body by definition (fetch/undici
    // discard it client-side even if a server writes one), so it can
    // never actually deliver a challenge. Keeping the contract to GET
    // avoids a request type that would silently fail to work.
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'method_not_allowed', detail: 'this API only accepts GET requests' }));
      return;
    }

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendJson(res, 400, { error: 'bad_request', detail: 'malformed URL' });
      return;
    }

    try {
      if (url.pathname === '/') {
        handleHome(req, res);
        return;
      }
      if (STATIC_FILE_CONTENTS[url.pathname]) {
        const { body, type, etag } = STATIC_FILE_CONTENTS[url.pathname];
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { 'Cache-Control': 'no-cache', ETag: etag }); res.end(); return; }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag });
        res.end(body);
        return;
      }
      let permalink = null;
      if (url.pathname.startsWith('/m/')) {
        // WHATWG URL parsing deliberately preserves malformed percent escapes.
        // Decode only this bounded route component, and classify URIError as bad
        // client input rather than letting it reach the logged 500 fallback.
        try { permalink = decodeURIComponent(url.pathname.slice(3)); }
        catch {
          sendJson(res, 400, { error: 'bad_request', detail: 'malformed permalink' });
          return;
        }
      }
      if (permalink && isUuid(permalink)) {
        if (wantsHtml(req)) {
          handlePermalinkHtml(res, permalink);
        } else {
          handleSearch(req, res, url, permalink);
        }
        return;
      }
      if (url.pathname === '/post') {
        handlePost(req, res, url);
        return;
      }
      if (url.pathname === '/search') {
        handleSearch(req, res, url);
        return;
      }
      sendJson(res, 404, { error: 'not_found', detail: 'unknown endpoint; see GET /' });
    } catch (err) {
      console.error('swarm-forum: request failed', err);
      sendJson(res, 500, { error: 'internal_error' });
    }
  });

  server.swarmForum = { config, db, cache, computeState, tickets, instanceId, postRateLimiter };
  server.on('close', () => {
    cache.stop();
    db.close();
  });
  return server;
}

function start(overrides = {}) {
  const server = createServer(overrides);
  const { config } = server.swarmForum;
  server.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`swarm-forum listening on http://${config.host}:${config.port}`);
  });
  return server;
}

module.exports = { createServer, start, loadConfig, wantsHtml };
