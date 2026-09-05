'use strict';

const crypto = require('node:crypto');

// A short keyed pseudonym for the observed network source. It stays
// stable while the persisted secret does; compromise permits guessing
// candidate addresses. The source itself is never stored (see db.js).
const HASH_LENGTH = 16; // hex chars = 64 bits: public and permanent, so collisions must stay negligible
const POSTER_RE = new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`, 'i');

function posterHash(secret, ip) {
  return crypto.createHmac('sha256', secret).update(`poster:${ip}`).digest('hex').slice(0, HASH_LENGTH);
}

function isPosterHash(value) {
  return typeof value === 'string' && POSTER_RE.test(value);
}

module.exports = { posterHash, isPosterHash, HASH_LENGTH };
