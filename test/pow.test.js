'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const pow = require('../src/pow');

test('canonicalRequest sorts params, drops pow, and omits the query string when empty', () => {
  const withParams = new URLSearchParams('b=2&a=1&pow=ignored');
  assert.equal(pow.canonicalRequest('/search', withParams), '/search?a=1&b=2');

  const empty = new URLSearchParams();
  assert.equal(pow.canonicalRequest('/export', empty), '/export');

  const onlyPow = new URLSearchParams('pow=x');
  assert.equal(pow.canonicalRequest('/post', onlyPow), '/post');
});

test('challengeFor is deterministic for the same inputs and changes with any input', () => {
  const a = pow.challengeFor('secret', '/post?message=hi', 100);
  const b = pow.challengeFor('secret', '/post?message=hi', 100);
  assert.equal(a, b);
  assert.notEqual(a, pow.challengeFor('other-secret', '/post?message=hi', 100));
  assert.notEqual(a, pow.challengeFor('secret', '/post?message=bye', 100));
  assert.notEqual(a, pow.challengeFor('secret', '/post?message=hi', 101));
});

test('leadingZeroBits counts bits across every nibble value', () => {
  assert.equal(pow.leadingZeroBits('0000ff'), 16);
  assert.equal(pow.leadingZeroBits('1fff'), 3);
  assert.equal(pow.leadingZeroBits('2fff'), 2);
  assert.equal(pow.leadingZeroBits('3fff'), 2);
  assert.equal(pow.leadingZeroBits('4fff'), 1);
  assert.equal(pow.leadingZeroBits('7fff'), 1);
  assert.equal(pow.leadingZeroBits('8fff'), 0);
  assert.equal(pow.leadingZeroBits('ffff'), 0);
  assert.equal(pow.leadingZeroBits('00000000'), 32);
});

test('meetsDifficulty is true only when the hash clears the bar', () => {
  const challenge = 'fixed-challenge';
  let nonce = 0;
  while (!pow.meetsDifficulty(challenge, String(nonce), 8)) nonce += 1;
  assert.ok(pow.meetsDifficulty(challenge, String(nonce), 8));
  assert.ok(pow.meetsDifficulty(challenge, String(nonce), 0));
  assert.equal(pow.meetsDifficulty(challenge, String(nonce), 256), false);
});

test('issueChallenge returns a self-consistent challenge for the current window', () => {
  const now = Date.now();
  const searchParams = new URLSearchParams('message=hi');
  const issued = pow.issueChallenge('secret', '/post', searchParams, 10, now);
  assert.equal(issued.algorithm, 'sha256');
  assert.equal(issued.difficulty, 10);
  assert.equal(typeof issued.challenge, 'string');
  assert.equal(issued.challenge.length, 64);
  assert.equal(issued.expires_in, Math.round((pow.WINDOW_MS * pow.WINDOW_TOLERANCE) / 1000));

  const expected = pow.challengeFor('secret', '/post?message=hi', pow.timeslotFor(now));
  assert.equal(issued.challenge, expected);
});

function solveFor(secret, pathname, searchParams, difficulty, slot) {
  const challenge = pow.challengeFor(secret, pow.canonicalRequest(pathname, searchParams), slot);
  let nonce = 0;
  for (;;) {
    const digest = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest('hex');
    if (pow.leadingZeroBits(digest) >= difficulty) return String(nonce);
    nonce += 1;
  }
}

test('verifyProof rejects missing, empty, and oversized nonces without hashing', () => {
  const searchParams = new URLSearchParams('message=hi');
  const alwaysZero = () => 0;
  assert.equal(pow.verifyProof('secret', '/post', searchParams, undefined, alwaysZero), false);
  assert.equal(pow.verifyProof('secret', '/post', searchParams, '', alwaysZero), false);
  assert.equal(pow.verifyProof('secret', '/post', searchParams, 'x'.repeat(129), alwaysZero), false);
});

test('verifyProof accepts a nonce solved for the current window', () => {
  const now = Date.now();
  const searchParams = new URLSearchParams('message=hi');
  const slot = pow.timeslotFor(now);
  const nonce = solveFor('secret', '/post', searchParams, 8, slot);
  const difficultyForSlot = () => 8;
  assert.equal(pow.verifyProof('secret', '/post', searchParams, nonce, difficultyForSlot, now), true);
});

test('verifyProof accepts a nonce solved for a previous window within tolerance', () => {
  const now = Date.now();
  const searchParams = new URLSearchParams('message=hi');
  const previousSlot = pow.timeslotFor(now) - (pow.WINDOW_TOLERANCE - 1);
  const nonce = solveFor('secret', '/post', searchParams, 8, previousSlot);
  const difficultyForSlot = () => 8;
  assert.equal(pow.verifyProof('secret', '/post', searchParams, nonce, difficultyForSlot, now), true);
});

test('verifyProof rejects a nonce solved outside the tolerance window', () => {
  const now = Date.now();
  const searchParams = new URLSearchParams('message=hi');
  const tooOldSlot = pow.timeslotFor(now) - pow.WINDOW_TOLERANCE;
  const nonce = solveFor('secret', '/post', searchParams, 8, tooOldSlot);
  const difficultyForSlot = () => 8;
  assert.equal(pow.verifyProof('secret', '/post', searchParams, nonce, difficultyForSlot, now), false);
});

test('verifyProof rejects a nonce that never meets any window difficulty', () => {
  const now = Date.now();
  const searchParams = new URLSearchParams('message=hi');
  const difficultyForSlot = () => 64; // effectively unsatisfiable in a test
  assert.equal(pow.verifyProof('secret', '/post', searchParams, '0', difficultyForSlot, now), false);
});

test('verifyProof binds the proof to the exact request parameters', () => {
  const now = Date.now();
  const params = new URLSearchParams('message=hi');
  const slot = pow.timeslotFor(now);
  const nonce = solveFor('secret', '/post', params, 8, slot);
  const differentParams = new URLSearchParams('message=bye');
  const difficultyForSlot = () => 8;
  assert.equal(pow.verifyProof('secret', '/post', differentParams, nonce, difficultyForSlot, now), false);
});
