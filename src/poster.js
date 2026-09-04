'use strict';

const crypto = require('node:crypto');

// A short, non-reversible stand-in for the posting IP: same IP always
// yields the same hash (so readers can tell "same source" apart), but the
// IP itself is never exposed — in fact it's never stored at all (see
// db.js), only this hash is. Keyed by a dedicated, persisted secret (see
// secret.js) so it can't be brute-forced from the ~4 billion IPv4 address
// space the way an unsalted hash could.
const HASH_LENGTH = 16; // hex chars = 64 bits: public and permanent, so collisions must stay negligible
const POSTER_RE = new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`, 'i');

function posterHash(secret, ip) {
  return crypto.createHmac('sha256', secret).update(`poster:${ip}`).digest('hex').slice(0, HASH_LENGTH);
}

function isPosterHash(value) {
  return typeof value === 'string' && POSTER_RE.test(value);
}

module.exports = { posterHash, isPosterHash, HASH_LENGTH };
