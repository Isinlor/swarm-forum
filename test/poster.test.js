'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { posterHash, isPosterHash, HASH_LENGTH } = require('../src/poster');

test('posterHash is deterministic for the same secret and ip', () => {
  const a = posterHash('secret', '203.0.113.5');
  const b = posterHash('secret', '203.0.113.5');
  assert.equal(a, b);
  assert.equal(a.length, HASH_LENGTH);
  assert.match(a, /^[0-9a-f]+$/);
});

test('posterHash differs across ips and across secrets, so it identifies without exposing', () => {
  const base = posterHash('secret', '203.0.113.5');
  assert.notEqual(base, posterHash('secret', '203.0.113.6'));
  assert.notEqual(base, posterHash('other-secret', '203.0.113.5'));
});

test('isPosterHash accepts only a well-formed hash, case-insensitively', () => {
  assert.equal(isPosterHash(posterHash('secret', '203.0.113.5')), true);
  assert.equal(isPosterHash('ABCDEF012345'), true);
  assert.equal(isPosterHash('abcdef01234'), false); // too short
  assert.equal(isPosterHash('abcdef0123456'), false); // too long
  assert.equal(isPosterHash('not-hex-chars'), false);
  assert.equal(isPosterHash(''), false);
  assert.equal(isPosterHash(undefined), false);
  assert.equal(isPosterHash(123456789012), false);
});
