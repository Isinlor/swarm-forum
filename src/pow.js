'use strict';

const crypto = require('node:crypto');

// Each time-window a fresh HMAC challenge is derivable for any request.
// Verification tolerates the current window plus the two before it, so a
// client has up to ~3 windows to find a nonce and resubmit.
const WINDOW_MS = 90_000;
const WINDOW_TOLERANCE = 3;

function timeslotFor(ts) {
  return Math.floor(ts / WINDOW_MS);
}

/**
 * Builds a stable string identifying "this request" (path + sorted query,
 * excluding `pow`), so a solved proof is only valid for the exact
 * parameters it was solved against.
 */
function canonicalRequest(pathname, searchParams) {
  const entries = [...searchParams.entries()]
    .filter(([key]) => key !== 'pow')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return qs ? `${pathname}?${qs}` : pathname;
}

function challengeFor(secret, canonical, slot) {
  return crypto.createHmac('sha256', secret).update(`${canonical}:${slot}`).digest('hex');
}

/** Counts leading zero bits of a hex digest string. */
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

function meetsDifficulty(challenge, nonce, difficulty) {
  const digest = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest('hex');
  return leadingZeroBits(digest) >= difficulty;
}

function issueChallenge(secret, pathname, searchParams, difficulty, now = Date.now()) {
  const canonical = canonicalRequest(pathname, searchParams);
  const slot = timeslotFor(now);
  return {
    challenge: challengeFor(secret, canonical, slot),
    difficulty,
    algorithm: 'sha256',
    expires_in: Math.round((WINDOW_MS * WINDOW_TOLERANCE) / 1000),
  };
}

/**
 * Verifies a client-supplied nonce against every window still in
 * tolerance, using whatever difficulty was in force for that window
 * (passed in via `difficultyForSlot`, since difficulty can itself drift
 * with load between issuance and verification).
 */
function verifyProof(secret, pathname, searchParams, nonce, difficultyForSlot, now = Date.now()) {
  if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) return false;
  const canonical = canonicalRequest(pathname, searchParams);
  const currentSlot = timeslotFor(now);
  for (let i = 0; i < WINDOW_TOLERANCE; i += 1) {
    const slot = currentSlot - i;
    const difficulty = difficultyForSlot(slot);
    const challenge = challengeFor(secret, canonical, slot);
    if (meetsDifficulty(challenge, nonce, difficulty)) return true;
  }
  return false;
}

module.exports = {
  WINDOW_MS,
  WINDOW_TOLERANCE,
  timeslotFor,
  canonicalRequest,
  challengeFor,
  leadingZeroBits,
  meetsDifficulty,
  issueChallenge,
  verifyProof,
};
