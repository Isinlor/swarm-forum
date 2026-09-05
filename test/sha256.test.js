'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sha256Hex } = require('../src/sha256');

function nodeSha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

test('sha256Hex matches node:crypto across block-boundary edge cases', () => {
  const cases = [
    '',
    'abc',
    'hello world',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(57),
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(65),
    'a'.repeat(1000),
    'unicode: é中文😀',
    'challenge:12345',
  ];
  for (const c of cases) {
    assert.equal(sha256Hex(c), nodeSha256(c), `mismatch for ${JSON.stringify(c.slice(0, 20))}`);
  }
});
