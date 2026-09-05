'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { openDb } = require('./db');
const { createLatestCache } = require('./cache');
const { uuidv7, isUuid, minUuidv7ForTimestamp } = require('./uuid');
const pow = require('./pow');
const resources = require('./resources');
const { posterHash, isPosterHash } = require('./poster');
const { loadOrCreateSecret } = require('./secret');
const { clientIp } = require('./ip');
const { createRequestRateTracker } = require('./rate');
const { buildDocs, renderHome, renderMessageJson } = require('./render');

const PERMALINK_RE = /^\/m\/([0-9a-f-]{36})$/i;
const STATIC_FILES = {
  '/client.js': { path: path.join(__dirname, 'public', 'client.js'), type: 'text/javascript; charset=utf-8' },
  '/pow-worker.js': { path: path.join(__dirname, 'public', 'pow-worker.js'), type: 'text/javascript; charset=utf-8' },
  '/sha256.js': { path: path.join(__dirname, 'sha256.js'), type: 'text/javascript; charset=utf-8' },
};
const STATIC_FILE_CONTENTS = Object.fromEntries(
  Object.entries(STATIC_FILES).map(([route, { path: filePath, type }]) => [
    route,
    { body: fs.readFileSync(filePath, 'utf8'), type },
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
// How long a solved proof-of-work nonce stays valid. A client that solves
// a challenge for text T can replay that same nonce to repost T again
// within this window at zero extra cost (verification is stateless, see
// pow.js) — the duplicate-text check in handlePost is what actually
// closes that hole, by rejecting a repost of identical text within it.
const POW_VALIDITY_MS = pow.WINDOW_MS * pow.WINDOW_TOLERANCE;

function loadConfig(overrides = {}) {
  const env = overrides.env || process.env;
  const num = (name, fallback) => {
    const raw = overrides[name] ?? env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const dataDir = overrides.dataDir || env.DATA_DIR || path.join(process.cwd(), 'data');
  return {
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
    trustProxyHops: num('trustProxyHops', num('TRUST_PROXY_HOPS', 0)),
    maxMessageBytes: num('maxMessageBytes', num('MAX_MESSAGE_BYTES', 2048)),
    maxQueryLength: num('maxQueryLength', num('MAX_QUERY_LENGTH', 200)),
    resultLimit: num('resultLimit', num('RESULT_LIMIT', 100)),
    latestLimit: num('latestLimit', num('LATEST_LIMIT', 100)),
    cacheIntervalMs: num('cacheIntervalMs', num('CACHE_INTERVAL_MS', 5000)),
    maxDbSizeBytes: num('maxDbSizeBytes', num('MAX_DB_SIZE_BYTES', 500 * 1024 * 1024)),
    minFreeBytes: num('minFreeBytes', num('MIN_FREE_BYTES', 1024 * 1024 * 1024)),
    targetRequestsPerSecond: num('targetRequestsPerSecond', num('TARGET_REQUESTS_PER_SECOND', 5)),
    baseDifficulty: overrides.baseDifficulty || {
      search: num('baseDifficultySearch', num('BASE_DIFFICULTY_SEARCH', resources.BASE_DIFFICULTY.search)),
      post: num('baseDifficultyPost', num('BASE_DIFFICULTY_POST', resources.BASE_DIFFICULTY.post)),
    },
    maxDifficulty: overrides.maxDifficulty || {
      search: num('maxDifficultySearch', num('MAX_DIFFICULTY_SEARCH', resources.MAX_DIFFICULTY.search)),
      post: num('maxDifficultyPost', num('MAX_DIFFICULTY_POST', resources.MAX_DIFFICULTY.post)),
    },
  };
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
  return (req.headers.accept || '').includes('text/html');
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

/**
 * Tracks, per (endpoint, time-window) slot, the lowest difficulty ever
 * advertised in that slot. `issue()` — called when sending a 402 —
 * always computes a fresh value from current load, so the ramp reacts
 * within the request that triggers it rather than lagging up to a whole
 * slot behind; folding that value into the slot's running minimum is
 * what `verify()` then checks a submitted nonce against. Judging by the
 * minimum (not the first-seen or the latest value) means a nonce solved
 * against whatever a client was actually told is never later rejected
 * just because load moved between issuance and verification — every
 * value the tracker recorded for a slot is a real number this process
 * advertised to someone in it, so honoring the easiest of them costs
 * nothing verification is meant to protect. Bounded size, no disk usage.
 */
function createDifficultyTracker(computeState, baseDifficulty, maxDifficulty) {
  const minSeen = new Map();

  function freshDifficulty(endpoint) {
    return resources.computeDifficulty(endpoint, computeState(), baseDifficulty, maxDifficulty);
  }

  function recordMin(key, value) {
    const existing = minSeen.get(key);
    if (existing === undefined || value < existing) minSeen.set(key, value);
    if (minSeen.size > 64) minSeen.delete(minSeen.keys().next().value);
  }

  return {
    // Always the number this specific request is told to solve — never
    // diluted down to the slot's historical minimum, or the ramp could
    // never actually advertise a harder value once an easy one occurred.
    issue(endpoint, slot) {
      const value = freshDifficulty(endpoint);
      recordMin(`${endpoint}:${slot}`, value);
      return value;
    },
    verify(endpoint, slot) {
      const key = `${endpoint}:${slot}`;
      if (minSeen.has(key)) return minSeen.get(key);
      const value = freshDifficulty(endpoint);
      recordMin(key, value);
      return value;
    },
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

  const computeState = memoize(() => resources.currentState({
    dbSizeBytes: db.fileSizeBytes(),
    maxDbSizeBytes: config.maxDbSizeBytes,
    dataDir: config.dataDir,
    minFreeBytes: config.minFreeBytes,
    loadRatio: rateTracker.ratePerSecond() / config.targetRequestsPerSecond,
  }), 1000);

  const difficulty = createDifficultyTracker(computeState, config.baseDifficulty, config.maxDifficulty);

  const docs = () => buildDocs({
    version: require('../package.json').version,
    latestLimit: config.latestLimit,
    cacheIntervalMs: config.cacheIntervalMs,
    maxMessageBytes: config.maxMessageBytes,
    maxQueryLength: config.maxQueryLength,
    resultLimit: config.resultLimit,
    powWindowSeconds: Math.round(POW_VALIDITY_MS / 1000),
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
    const verifySlot = (slot) => difficulty.verify(endpoint, slot);
    if (nonce && pow.verifyProof(config.powSecret, url.pathname, url.searchParams, nonce, verifySlot, now)) {
      return true;
    }
    const currentSlot = pow.timeslotFor(now);
    const difficultyValue = difficulty.issue(endpoint, currentSlot);
    const challenge = pow.issueChallenge(config.powSecret, url.pathname, url.searchParams, difficultyValue, now);
    sendJson(res, 402, { error: 'proof_of_work_required', ...challenge });
    return false;
  }

  const homeCacheControl = () => `public, max-age=${Math.round(config.cacheIntervalMs / 1000)}, stale-while-revalidate=30`;

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
    if (!gate(req, res, url, 'post')) return;

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
    const dedupSinceId = minUuidv7ForTimestamp(Date.now() - POW_VALIDITY_MS);
    if (db.recentDuplicate(message, dedupSinceId)) {
      sendJson(res, 409, {
        error: 'duplicate_message',
        detail: 'this exact text was already posted recently; edit it or wait for the proof-of-work window to pass',
      });
      return;
    }

    const ip = clientIp(req, config.trustProxyHops);
    const id = uuidv7();
    db.insertMessage({ id, message, poster: posterHash(config.posterSecret, ip) });
    const saved = db.getById(id);
    sendJson(res, 201, { message: renderMessageJson(saved) });
  }

  function handleSearch(req, res, url, overrideQuery) {
    if (!gate(req, res, url, 'search')) return;

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
    rateTracker.record();

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
        const { body, type } = STATIC_FILE_CONTENTS[url.pathname];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
        res.end(body);
        return;
      }
      const permalink = PERMALINK_RE.exec(url.pathname);
      if (permalink) {
        if (wantsHtml(req)) {
          handlePermalinkHtml(res, permalink[1]);
        } else {
          handleSearch(req, res, url, permalink[1]);
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
      sendJson(res, 500, { error: 'internal_error', detail: err.message });
    }
  });

  server.swarmForum = { config, db, cache, computeState, difficulty };
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

module.exports = { createServer, start, loadConfig, createDifficultyTracker };
