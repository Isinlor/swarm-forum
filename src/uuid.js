'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatUuidBytes(bytes) {
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function timestampBytes(ms) {
  const ts = BigInt(ms);
  return [
    Number((ts >> 40n) & 0xffn),
    Number((ts >> 32n) & 0xffn),
    Number((ts >> 24n) & 0xffn),
    Number((ts >> 16n) & 0xffn),
    Number((ts >> 8n) & 0xffn),
    Number(ts & 0xffn),
  ];
}

/**
 * Generates a UUIDv7 (RFC 9562): a 48-bit millisecond timestamp followed by
 * random bits, so ids sort chronologically and double as a time index —
 * there is deliberately no separate stored timestamp column; see
 * `timestampFromUuidv7`.
 */
function uuidv7(now = Date.now()) {
  const bytes = crypto.randomBytes(16);
  timestampBytes(now).forEach((byte, i) => {
    bytes[i] = byte;
  });

  bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 10

  return formatUuidBytes(bytes);
}

/** Decodes the millisecond timestamp embedded in a UUIDv7's leading 6 bytes. */
function timestampFromUuidv7(id) {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return Number(BigInt(`0x${hex}`));
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

module.exports = { uuidv7, isUuid, UUID_RE, timestampFromUuidv7 };
