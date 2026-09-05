'use strict';

const crypto = require('node:crypto');

const TICKET_LIFETIME_MS = 600_000;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;
const ENCODED_RE = /^[A-Za-z0-9_-]+$/;

function canonicalRequest(pathname, searchParams) {
  const entries = [...searchParams.entries()]
    .filter(([key]) => key !== 'pow' && key !== 'ticket')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = entries.map(([key, value]) =>
    `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  return qs ? `${pathname}?${qs}` : pathname;
}

function leadingZeroBits(hexDigest) {
  let bits = 0;
  for (const character of hexDigest) {
    const nibble = parseInt(character, 16);
    if (nibble === 0) { bits += 4; continue; }
    bits += Math.clz32(nibble) - 28;
    break;
  }
  return bits;
}

function meetsDifficulty(ticket, nonce, difficulty) {
  const digest = crypto.createHash('sha256').update(`${ticket}:${nonce}`).digest('hex');
  return leadingZeroBits(digest) >= difficulty;
}

function signature(secret, encoded) {
  return crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
}

function issueTicket(secret, instanceId, pathname, searchParams, difficulty, options = {}) {
  const now = options.now ?? Date.now();
  const payload = {
    r: crypto.createHash('sha256').update(canonicalRequest(pathname, searchParams)).digest('base64url'),
    d: difficulty,
    e: now + (options.lifetimeMs ?? TICKET_LIFETIME_MS),
    j: crypto.randomBytes(16).toString('base64url'),
    i: instanceId,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const ticket = `${encoded}.${signature(secret, encoded)}`;
  return { ticket, difficulty, algorithm: 'sha256', expires_at: payload.e,
    expires_in: Math.max(0, Math.ceil((payload.e - now) / 1000)) };
}

function authenticateTicket(secret, ticket) {
  if (typeof ticket !== 'string' || ticket.length > 1024) return null;
  const separator = ticket.indexOf('.');
  // Reject non-canonical base64url before hashing or allocating Buffers. In
  // particular, JS string length is not byte length for Unicode, which would
  // otherwise make timingSafeEqual throw on an attacker-controlled signature.
  if (separator < 1 || separator !== ticket.lastIndexOf('.')) return null;
  const encoded = ticket.slice(0, separator);
  const supplied = ticket.slice(separator + 1);
  if (!ENCODED_RE.test(encoded) || !SIGNATURE_RE.test(supplied)) return null;
  const expected = signature(secret, encoded);
  if (!crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return null; }
  return payload && typeof payload.j === 'string' ? payload : null;
}

function verifyAuthenticatedTicket(instanceId, pathname, searchParams, ticket, nonce, payload, options = {}) {
  if (!payload || typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 128) return null;
  const now = options.now ?? Date.now();
  const requestHash = crypto.createHash('sha256')
    .update(canonicalRequest(pathname, searchParams)).digest('base64url');
  if (!payload || payload.i !== instanceId || payload.r !== requestHash ||
      !Number.isInteger(payload.d) || payload.d < 0 || payload.d > 256 ||
      !Number.isFinite(payload.e) || payload.e <= now || typeof payload.j !== 'string' ||
      !meetsDifficulty(ticket, nonce, payload.d)) return null;
  return payload;
}

function verifyTicket(secret, instanceId, pathname, searchParams, ticket, nonce, options = {}) {
  return verifyAuthenticatedTicket(instanceId, pathname, searchParams, ticket, nonce,
    authenticateTicket(secret, ticket), options);
}

function createTicketStore(lifetimeMs = TICKET_LIFETIME_MS) {
  let fresh = new Set();
  let stale = new Set();
  let rotateAt = 0;
  return {
    consume(id, now = Date.now()) {
      if (!rotateAt) rotateAt = now + lifetimeMs;
      if (now >= rotateAt) {
        stale = now >= rotateAt + lifetimeMs ? new Set() : fresh;
        fresh = new Set();
        rotateAt = now + lifetimeMs;
      }
      if (fresh.has(id) || stale.has(id)) return false;
      fresh.add(id);
      return true;
    },
    has(id) { return fresh.has(id) || stale.has(id); },
    get size() { return fresh.size + stale.size; },
  };
}

module.exports = { TICKET_LIFETIME_MS, canonicalRequest, leadingZeroBits, meetsDifficulty,
  issueTicket, authenticateTicket, verifyAuthenticatedTicket, verifyTicket, createTicketStore };
