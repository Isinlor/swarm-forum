'use strict';

const crypto = require('node:crypto');

// A short, non-reversible stand-in for the posting IP: same IP always
// yields the same hash (so readers can tell "same source" apart), but the
// IP itself is never exposed. Keyed by the server's own secret so it
// can't be brute-forced from the ~4 billion IPv4 address space the way an
// unsalted hash could.
const HASH_LENGTH = 12; // hex chars = 48 bits, enough to make accidental collisions rare

function posterHash(secret, ip) {
  return crypto.createHmac('sha256', secret).update(`poster:${ip}`).digest('hex').slice(0, HASH_LENGTH);
}

module.exports = { posterHash, HASH_LENGTH };
