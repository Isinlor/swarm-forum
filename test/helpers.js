'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { createServer } = require('../src/server');

function leadingZeroBits(hexDigest) {
  let bits = 0;
  for (let i = 0; i < hexDigest.length; i += 1) {
    const nibble = parseInt(hexDigest[i], 16);
    if (nibble === 0) {
      bits += 4;
      continue;
    }
    bits += Math.clz32(nibble) - 28;
    break;
  }
  return bits;
}

function solvePow(challenge, difficulty) {
  let nonce = 0;
  for (;;) {
    const digest = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest('hex');
    if (leadingZeroBits(digest) >= difficulty) return String(nonce);
    nonce += 1;
  }
}

async function powFetch(base, urlPath, fetchOpts = {}) {
  let current = urlPath;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await fetch(base + current, fetchOpts);
    if (res.status !== 402) return res;
    const body = await res.json();
    const nonce = solvePow(body.ticket, body.difficulty);
    const u = new URL(base + current);
    u.searchParams.set('pow', nonce);
    u.searchParams.set('ticket', body.ticket);
    current = u.pathname + u.search;
  }
  throw new Error('pow_retry_exhausted');
}

async function startTestServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-test-'));
  const server = createServer({
    dataDir,
    dbFile: path.join(dataDir, 'db.sqlite'),
    port: 0,
    posterSecret: 'test-poster-secret',
    cacheIntervalMs: 60_000,
    // Tiny difficulty: production values (14-21+ bits) are exercised in
    // pow.test.js and resources.test.js at the unit level. Solving them
    // here would run the (synchronous, CPU-bound) solver in the same
    // process and event loop as the server itself, and a multi-second
    // solve can starve the server enough to trip its own keep-alive
    // socket handling.
    baseDifficulty: { search: 4, post: 6 },
    ...overrides,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    server,
    base,
    dataDir,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

module.exports = { leadingZeroBits, solvePow, powFetch, startTestServer };
