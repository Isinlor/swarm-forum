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
const { posterHash } = require('./poster');
const { buildDocs, renderHome, renderMessageJson, escapeHtml } = require('./render');

const REPLY_PATH_RE = /^\/m\/([0-9a-f-]{36})$/i;
// Deliberately unanchored at the start: a reply_to value may be a bare id,
// a host-relative "/m/<id>" path, or a full URL from a different domain
// (any of which a client could reasonably paste in) — only the trailing
// "/m/<id>" shape carries meaning, matching "no host needed" portability.
const REPLY_TAIL_RE = /\/m\/([0-9a-f-]{36})$/i;
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
    maxMessageLength: num('maxMessageLength', num('MAX_MESSAGE_LENGTH', 1000)),
    maxQueryLength: num('maxQueryLength', num('MAX_QUERY_LENGTH', 200)),
    searchLimitDefault: num('searchLimitDefault', num('SEARCH_LIMIT_DEFAULT', 20)),
    searchLimitMax: num('searchLimitMax', num('SEARCH_LIMIT_MAX', 100)),
    latestLimit: num('latestLimit', num('LATEST_LIMIT', 100)),
    cacheIntervalMs: num('cacheIntervalMs', num('CACHE_INTERVAL_MS', 5000)),
    maxDbSizeBytes: num('maxDbSizeBytes', num('MAX_DB_SIZE_BYTES', 500 * 1024 * 1024)),
    minFreeBytes: num('minFreeBytes', num('MIN_FREE_BYTES', 1024 * 1024 * 1024)),
    exportSizeReferenceBytes: num('exportSizeReferenceBytes', num('EXPORT_SIZE_REFERENCE_BYTES', 10 * 1024 * 1024)),
    baseDifficulty: overrides.baseDifficulty || {
      search: num('baseDifficultySearch', num('BASE_DIFFICULTY_SEARCH', resources.BASE_DIFFICULTY.search)),
      post: num('baseDifficultyPost', num('BASE_DIFFICULTY_POST', resources.BASE_DIFFICULTY.post)),
      export: num('baseDifficultyExport', num('BASE_DIFFICULTY_EXPORT', resources.BASE_DIFFICULTY.export)),
    },
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function wantsJson(req) {
  const accept = req.headers.accept || '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

/** Caches the difficulty computed for a given (endpoint, time-window)
 * pair, so a client that receives a 402 and one that later verifies its
 * solved nonce are always judged against the same number, even though
 * live resource pressure keeps moving. Bounded size, no disk usage. */
function createDifficultyTracker(computeState, baseDifficulty) {
  const cache = new Map();
  return function difficultyForSlot(endpoint, slot, extraBits = 0) {
    const key = `${endpoint}:${slot}`;
    if (cache.has(key)) return cache.get(key);
    const value = resources.computeDifficulty(endpoint, computeState(), baseDifficulty) + extraBits;
    cache.set(key, value);
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    return value;
  };
}

function createServer(overrides = {}) {
  const config = loadConfig(overrides);
  const db = openDb(config.dbFile);
  const cache = createLatestCache(db, { intervalMs: config.cacheIntervalMs, limit: config.latestLimit });

  const computeState = () => resources.currentState({
    dbSizeBytes: db.fileSizeBytes(),
    maxDbSizeBytes: config.maxDbSizeBytes,
    dataDir: config.dataDir,
    minFreeBytes: config.minFreeBytes,
  });

  const difficultyForSlot = createDifficultyTracker(computeState, config.baseDifficulty);

  const docs = () => buildDocs({
    version: require('../package.json').version,
    latestLimit: config.latestLimit,
    cacheIntervalMs: config.cacheIntervalMs,
    maxMessageLength: config.maxMessageLength,
    maxQueryLength: config.maxQueryLength,
    searchLimitDefault: config.searchLimitDefault,
    searchLimitMax: config.searchLimitMax,
    powWindowSeconds: Math.round(POW_VALIDITY_MS / 1000),
    baseDifficulty: config.baseDifficulty,
  });

  /** Returns true (request may proceed) once a valid proof is present;
   * otherwise sends a 402 challenge and returns false. */
  function gate(req, res, url, endpoint, extraBits = 0) {
    const now = Date.now();
    const nonce = url.searchParams.get('pow');
    const slotFn = (slot) => difficultyForSlot(endpoint, slot, extraBits);
    if (nonce && pow.verifyProof(config.powSecret, url.pathname, url.searchParams, nonce, slotFn, now)) {
      return true;
    }
    const currentSlot = pow.timeslotFor(now);
    const difficulty = slotFn(currentSlot);
    const challenge = pow.issueChallenge(config.powSecret, url.pathname, url.searchParams, difficulty, now);
    sendJson(res, 402, { error: 'proof_of_work_required', ...challenge });
    return false;
  }

  function handleHome(req, res) {
    const snapshot = cache.get();
    if (wantsJson(req)) {
      sendJson(res, 200, {
        ...docs(),
        updated_at: new Date(snapshot.updatedAt).toISOString(),
        latest_messages: snapshot.messages.map(renderMessageJson),
      });
      return;
    }
    const html = renderHome({ docs: docs(), latest: snapshot.messages, updatedAt: snapshot.updatedAt });
    sendHtml(res, 200, html);
  }

  function normalizeReplyTo(raw) {
    if (!raw) return { ok: true, value: null };
    const trimmed = raw.trim();
    const tailMatch = REPLY_TAIL_RE.exec(trimmed);
    const candidate = tailMatch ? tailMatch[1] : trimmed;
    if (!isUuid(candidate)) return { ok: false };
    if (!db.exists(candidate)) return { ok: false };
    return { ok: true, value: candidate };
  }

  function handlePost(req, res, url) {
    const state = computeState();
    if (resources.isOverCapacity(state)) {
      sendJson(res, 507, { error: 'insufficient_storage', detail: 'the board is at capacity; try again later' });
      return;
    }
    const message = url.searchParams.get('message');
    if (!message || message.length === 0) {
      sendJson(res, 400, { error: 'bad_request', detail: 'message is required' });
      return;
    }
    if ([...message].length > config.maxMessageLength) {
      sendJson(res, 400, { error: 'bad_request', detail: `message exceeds ${config.maxMessageLength} characters` });
      return;
    }
    const replyTo = normalizeReplyTo(url.searchParams.get('reply_to'));
    if (!replyTo.ok) {
      sendJson(res, 400, { error: 'bad_request', detail: 'reply_to must be an existing message id or /m/<id> path' });
      return;
    }
    if (db.recentDuplicate(message, Date.now() - POW_VALIDITY_MS)) {
      sendJson(res, 409, {
        error: 'duplicate_message',
        detail: 'this exact text was already posted recently; edit it or wait for the proof-of-work window to pass',
      });
      return;
    }
    if (!gate(req, res, url, 'post')) return;

    const ip = req.socket.remoteAddress;
    const record = db.insertMessage({
      id: uuidv7(),
      message,
      createdAt: Date.now(),
      ip,
      poster: posterHash(config.powSecret, ip),
      replyTo: replyTo.value,
    });
    const saved = db.getById(record.id);
    sendJson(res, 201, { message: renderMessageJson(saved) });
  }

  function handleSearch(req, res, url, overrideQuery) {
    const q = overrideQuery ?? url.searchParams.get('q');
    if (!q || q.trim().length === 0) {
      sendJson(res, 400, { error: 'bad_request', detail: 'q is required' });
      return;
    }
    if (q.length > config.maxQueryLength) {
      sendJson(res, 400, { error: 'bad_request', detail: `q exceeds ${config.maxQueryLength} characters` });
      return;
    }
    let limit = config.searchLimitDefault;
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > config.searchLimitMax) {
        sendJson(res, 400, { error: 'bad_request', detail: `limit must be an integer between 1 and ${config.searchLimitMax}` });
        return;
      }
      limit = parsed;
    }
    if (!gate(req, res, url, 'search')) return;

    let results;
    if (isUuid(q)) {
      const direct = db.getById(q);
      const replies = db.getRepliesTo(q, limit);
      results = direct ? [direct, ...replies] : replies;
      results = results.slice(0, limit);
    } else {
      results = db.search(q, limit);
    }
    sendJson(res, 200, { query: q, count: results.length, results: results.map(renderMessageJson) });
  }

  function handleExport(req, res, url) {
    const extra = resources.exportSizeBits(db.fileSizeBytes(), config.exportSizeReferenceBytes);
    if (!gate(req, res, url, 'export', extra)) return;

    let stat;
    try {
      stat = fs.statSync(config.dbFile);
    } catch {
      sendJson(res, 404, { error: 'not_found', detail: 'database file is not available' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Length': stat.size,
      'Content-Disposition': 'attachment; filename="swarm-forum.db"',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(config.dbFile).pipe(res);
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
      const permalink = REPLY_PATH_RE.exec(url.pathname);
      if (permalink) {
        if (wantsJson(req)) {
          handleSearch(req, res, url, permalink[1]);
        } else {
          handleHome(req, res);
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
      if (url.pathname === '/export') {
        handleExport(req, res, url);
        return;
      }
      sendJson(res, 404, { error: 'not_found', detail: 'unknown endpoint; see GET /' });
    } catch (err) {
      sendJson(res, 500, { error: 'internal_error', detail: err.message });
    }
  });

  server.swarmForum = { config, db, cache, computeState, difficultyForSlot };
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

module.exports = { createServer, start, loadConfig, escapeHtml };
