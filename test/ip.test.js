'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clientIp } = require('../src/ip');

function fakeReq(remoteAddress, forwardedFor) {
  return {
    socket: { remoteAddress },
    headers: forwardedFor !== undefined ? { 'x-forwarded-for': forwardedFor } : {},
  };
}

test('with trustProxyHops 0, the header is never consulted even if present', () => {
  const req = fakeReq('10.0.0.1', '203.0.113.5');
  assert.equal(clientIp(req, 0), '10.0.0.1');
});

test('with one trusted hop, the rightmost X-Forwarded-For entry is the client', () => {
  // client -> proxy -> us: proxy appends what it saw the connection from
  const req = fakeReq('10.0.0.1', '203.0.113.5');
  assert.equal(clientIp(req, 1), '203.0.113.5');
});

test('with two trusted hops, the second-from-right entry is the client', () => {
  // client -> proxy1 -> proxy2 -> us: proxy2's own address (rightmost) is
  // not the client; proxy1's view of the connection (second-from-right) is
  const req = fakeReq('10.0.0.2', 'attacker-supplied, 203.0.113.5, 10.0.0.1');
  assert.equal(clientIp(req, 2), '203.0.113.5');
});

test('an attacker cannot spoof by prepending fake entries, only trusted hops matter', () => {
  const req = fakeReq('10.0.0.1', '1.2.3.4, 5.6.7.8, 203.0.113.9');
  // whatever an untrusted client prepends, only the rightmost hop (the
  // one our own trusted proxy appended) is used
  assert.equal(clientIp(req, 1), '203.0.113.9');
});

test('falls back to the socket address if the header has fewer entries than trusted hops', () => {
  const req = fakeReq('10.0.0.1', '203.0.113.5');
  assert.equal(clientIp(req, 3), '10.0.0.1');
});

test('falls back to the socket address if the header is missing entirely', () => {
  const req = fakeReq('10.0.0.1');
  assert.equal(clientIp(req, 1), '10.0.0.1');
});

test('tolerates extra whitespace around entries', () => {
  const req = fakeReq('10.0.0.1', '  1.2.3.4 ,  203.0.113.5  ');
  assert.equal(clientIp(req, 1), '203.0.113.5');
});
