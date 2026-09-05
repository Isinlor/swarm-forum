'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Loads a persisted secret from `filePath`, or generates and writes a new
 * one (mode 0600, so only the owner can read it) if none exists yet.
 * Used for the poster-hashing secret, which — unlike the proof-of-work
 * secret — it must survive restarts to keep future hashes consistent.
 */
function loadOrCreateSecret(filePath) {
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (!existing) throw new Error(`secret file is empty: ${filePath}`);
    return { secret: existing, generated: false };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, secret);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    try {
      fs.linkSync(temporary, filePath);
      return { secret, generated: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const winner = fs.readFileSync(filePath, 'utf8').trim();
      if (!winner) throw new Error(`secret file is empty: ${filePath}`);
      return { secret: winner, generated: false };
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { loadOrCreateSecret };
