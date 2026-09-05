'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pow = require('../src/pow');
function solve(ticket, difficulty) { for (let n = 0;; n += 1) if (pow.meetsDifficulty(ticket, String(n), difficulty)) return String(n); }
function reject(ticket, difficulty) { for (let n = 0;; n += 1) if (!pow.meetsDifficulty(ticket, String(n), difficulty)) return String(n); }
test('canonicalRequest sorts parameters and excludes payment fields', () => {
  assert.equal(pow.canonicalRequest('/x', new URLSearchParams('z=2&pow=n&a=1&ticket=t')), '/x?a=1&z=2');
  assert.equal(pow.canonicalRequest('/x', new URLSearchParams('a=2&a=1')), '/x?a=2&a=1');
});
test('leadingZeroBits and meetsDifficulty count exact leading bits', () => {
  assert.equal(pow.leadingZeroBits('000f'), 12); assert.equal(pow.leadingZeroBits('8fff'), 0);
  assert.equal(pow.meetsDifficulty('x', 'n', 0), true);
});
test('signed tickets enforce request, difficulty, expiry, instance, and nonce', () => {
  const params = new URLSearchParams('message=hi');
  const issued = pow.issueTicket('secret', 'instance', '/post', params, 4, { now: 1000, lifetimeMs: 100 });
  const nonce = solve(issued.ticket, issued.difficulty);
  assert.equal(issued.expires_at, 1100); assert.equal(issued.expires_in, 1);
  assert.ok(pow.verifyTicket('secret', 'instance', '/post', params, issued.ticket, nonce, { now: 1050 }));
  assert.equal(pow.verifyTicket('wrong', 'instance', '/post', params, issued.ticket, nonce, { now: 1050 }), null);
  assert.equal(pow.verifyTicket('secret', 'other', '/post', params, issued.ticket, nonce, { now: 1050 }), null);
  assert.equal(pow.verifyTicket('secret', 'instance', '/post', new URLSearchParams('message=no'), issued.ticket, nonce, { now: 1050 }), null);
  assert.equal(pow.verifyTicket('secret', 'instance', '/post', params, issued.ticket, nonce, { now: 1100 }), null);
  // Derive a failing nonce because at this intentionally cheap difficulty an
  // arbitrary value has a 1-in-16 chance of being a valid proof by accident.
  const invalidNonce = reject(issued.ticket, issued.difficulty);
  assert.equal(pow.verifyTicket('secret', 'instance', '/post', params, issued.ticket, invalidNonce, { now: 1050 }), null);
});
test('tickets deliberately remain valid across network-source changes', () => {
  const params = new URLSearchParams('message=hi');
  const issued = pow.issueTicket('secret', 'i', '/post', params, 0);
  assert.ok(pow.verifyTicket('secret', 'i', '/post', params, issued.ticket, 'n'));
});
test('ticket store consumes each id once and prunes expired ids', () => {
  const store = pow.createTicketStore(10); assert.equal(store.consume('a', 10), true);
  assert.equal(store.consume('a', 10), false); assert.equal(store.size, 1);
  assert.equal(store.consume('b', 20), true); assert.equal(store.size, 2);
  assert.equal(store.consume('c', 30), true); assert.equal(store.size, 2);
  assert.equal(store.consume('b', 30), false);
  assert.equal(store.consume('d', 100), true); assert.equal(store.size, 1);
});
test('malformed tickets and nonces fail closed', () => {
  assert.equal(pow.verifyTicket('s', 'i', '/', new URLSearchParams(), 'bad', 'n'), null);
  assert.equal(pow.verifyTicket('s', 'i', '/', new URLSearchParams(), 'x.y', ''), null);
  assert.equal(pow.verifyTicket('s', 'i', '/', new URLSearchParams(), 'x'.repeat(1025), 'n'), null);
  assert.equal(pow.verifyTicket('s', 'i', '/', new URLSearchParams(), 'x.y', 3), null);
  assert.equal(pow.verifyTicket('s', 'i', '/', new URLSearchParams(), '.x', 'n'), null);
});

test('every malformed signed ticket contract fails closed', () => {
  const crypto = require('node:crypto'); const params = new URLSearchParams();
  function signed(payload) { const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url'); return encoded + '.' + crypto.createHmac('sha256', 's').update(encoded).digest('base64url'); }
  const r = crypto.createHash('sha256').update('/').digest('base64url');
  const good = { r, d: 0, e: Date.now() + 10000, j: 'id', i: 'i' };
  for (const bad of [null, { ...good, d: 1.5 }, { ...good, d: -1 }, { ...good, d: 257 },
    { ...good, e: 'later' }, { ...good, j: 3 }])
    assert.equal(pow.verifyTicket('s', 'i', '/', params, signed(bad), 'n'), null);
  const encoded = Buffer.from('{').toString('base64url'); const malformed = encoded + '.' + crypto.createHmac('sha256', 's').update(encoded).digest('base64url');
  assert.equal(pow.verifyTicket('s', 'i', '/', params, malformed, 'n'), null);
  assert.equal(pow.verifyTicket('s', 'i', '/', params, signed(good) + 'extra', 'n'), null);
  assert.equal(pow.verifyTicket('s', 'i', '/', params, signed(good), 'x'.repeat(129)), null);
});
