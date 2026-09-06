'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pow = require('../src/pow');
function solve(ticket, difficulty) { for (let n = 0;; n += 1) if (pow.meetsDifficulty(ticket, String(n), difficulty)) return String(n); }
function reject(ticket, difficulty) { for (let n = 0;; n += 1) if (!pow.meetsDifficulty(ticket, String(n), difficulty)) return String(n); }
test('leadingZeroBits and meetsDifficulty count exact leading bits', () => {
  assert.equal(pow.leadingZeroBits('000f'), 12); assert.equal(pow.leadingZeroBits('8fff'), 0);
  assert.equal(pow.meetsDifficulty('x', 'n', 0), true);
});
test('signed tickets enforce difficulty, expiry, signing key, and nonce', () => {
  const issued = pow.issueTicket('secret', 4, { now: 1000, lifetimeMs: 100 });
  const nonce = solve(issued.ticket, issued.difficulty);
  assert.equal(issued.expires_at, 1100); assert.equal(issued.expires_in, 1);
  assert.ok(pow.verifyTicket('secret', issued.ticket, nonce, { now: 1050 }));
  assert.equal(pow.verifyTicket('wrong', issued.ticket, nonce, { now: 1050 }), null);
  assert.equal(pow.verifyTicket('secret', issued.ticket, nonce, { now: 1100 }), null);
  // Derive a failing nonce because at this intentionally cheap difficulty an
  // arbitrary value has a 1-in-16 chance of being a valid proof by accident.
  const invalidNonce = reject(issued.ticket, issued.difficulty);
  assert.equal(pow.verifyTicket('secret', issued.ticket, invalidNonce, { now: 1050 }), null);
});
test('tickets are request-independent bearer credentials', () => {
  const issued = pow.issueTicket('secret', 0);
  assert.ok(pow.verifyTicket('secret', issued.ticket, 'n'));
});
test('default ticket and consumed-id lifetime is ten minutes', () => {
  const issued = pow.issueTicket('secret', 0, { now: 1000 });
  assert.equal(pow.TICKET_LIFETIME_MS, 600_000);
  assert.equal(issued.expires_at, 601_000);
  assert.equal(issued.expires_in, 600);
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
  assert.equal(pow.verifyTicket('s', 'bad', 'n'), null);
  assert.equal(pow.verifyTicket('s', 'x.y', ''), null);
  assert.equal(pow.verifyTicket('s', 'x'.repeat(1025), 'n'), null);
  assert.equal(pow.verifyTicket('s', 'x.y', 3), null);
  assert.equal(pow.verifyTicket('s', '.x', 'n'), null);
  assert.equal(pow.verifyTicket('s', `x.${'é'.repeat(43)}`, 'n'), null);
  assert.equal(pow.verifyTicket('s', `x.${'a'.repeat(43)}.extra`, 'n'), null);
});

test('every malformed signed ticket contract fails closed', () => {
  const crypto = require('node:crypto');
  function signed(payload) { const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url'); return encoded + '.' + crypto.createHmac('sha256', 's').update(encoded).digest('base64url'); }
  const good = { d: 0, e: Date.now() + 10000, j: 'id' };
  for (const bad of [null, { ...good, d: 1.5 }, { ...good, d: -1 }, { ...good, d: 257 },
    { ...good, e: 'later' }, { ...good, j: 3 }])
    assert.equal(pow.verifyTicket('s', signed(bad), 'n'), null);
  const encoded = Buffer.from('{').toString('base64url'); const malformed = encoded + '.' + crypto.createHmac('sha256', 's').update(encoded).digest('base64url');
  assert.equal(pow.verifyTicket('s', malformed, 'n'), null);
  assert.equal(pow.verifyTicket('s', signed(good) + 'extra', 'n'), null);
  assert.equal(pow.verifyTicket('s', signed(good), 'x'.repeat(129)), null);
});
