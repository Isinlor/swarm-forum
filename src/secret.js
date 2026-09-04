'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Loads a persisted secret from `filePath`, or generates and writes a new
 * one (mode 0600, so only the owner can read it) if none exists yet.
 * Used for the poster-hashing secret, which — unlike the proof-of-work
 * secret — must survive restarts: rotating it would silently reassign
 * every poster hash on the board.
 */
function loadOrCreateSecret(filePath) {
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (existing) return { secret: existing, generated: false };
  } catch {
    // no file yet, or unreadable — fall through and generate one
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, secret, { mode: 0o600 });
  return { secret, generated: true };
}

module.exports = { loadOrCreateSecret };
