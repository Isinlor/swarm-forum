'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { posterHash, HASH_LENGTH } = require('../src/poster');

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
