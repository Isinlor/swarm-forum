'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { clientIp } = require('../src/ip');
const req = (value) => ({ socket: { remoteAddress: 'socket' }, headers: value === undefined ? {} : { 'x-client-ip': value } });
test('configured client header selects the requested value from the right', () => {
  assert.equal(clientIp(req('fake, client, proxy'), 'x-client-ip', 2), 'client');
  assert.equal(clientIp(req('  client  '), 'X-Client-IP', 1), 'client');
});
test('client source falls back to socket when configured value is unavailable', () => {
  assert.equal(clientIp(req(), 'x-client-ip', 1), 'socket');
  assert.equal(clientIp(req('one'), 'x-client-ip', 2), 'socket');
  assert.equal(clientIp(req('one'), '', 1), 'socket');
});
