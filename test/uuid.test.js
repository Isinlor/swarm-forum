'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { uuidv7, isUuid, UUID_RE, timestampFromUuidv7, minUuidv7ForTimestamp } = require('../src/uuid');

test('uuidv7 produces a well-formed, RFC 9562 version-7 uuid', () => {
  const id = uuidv7();
  assert.match(id, UUID_RE);
  assert.equal(id[14], '7');
  const variantNibble = parseInt(id[19], 16);
  assert.equal(variantNibble & 0b1100, 0b1000);
});

test('uuidv7 embeds the given timestamp and sorts chronologically', () => {
  const t0 = Date.parse('2024-01-01T00:00:00.000Z');
  const t1 = t0 + 1000;
  const a = uuidv7(t0);
  const b = uuidv7(t1);
  assert.ok(a < b, `${a} should sort before ${b}`);

  const hex = a.replace(/-/g, '');
  const embeddedMs = parseInt(hex.slice(0, 12), 16);
  assert.equal(embeddedMs, t0);
});

test('uuidv7 ids are unique across rapid calls', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(uuidv7());
  assert.equal(ids.size, 200);
});

test('timestampFromUuidv7 decodes exactly what was embedded, for many timestamps', () => {
  for (const ms of [0, 1, Date.now(), Date.parse('2024-01-01T00:00:00.000Z'), 2 ** 47]) {
    assert.equal(timestampFromUuidv7(uuidv7(ms)), ms);
  }
});

test('minUuidv7ForTimestamp is a valid uuid and a tight lower bound on real ids at that timestamp', () => {
  const ms = Date.parse('2024-06-15T12:00:00.000Z');
  const floor = minUuidv7ForTimestamp(ms);
  assert.match(floor, UUID_RE);
  assert.equal(timestampFromUuidv7(floor), ms);

  for (let i = 0; i < 200; i += 1) {
    assert.ok(uuidv7(ms) >= floor, 'every real id at ms should sort at or after the floor');
  }
  assert.ok(uuidv7(ms - 1) < floor, 'an id from 1ms earlier should sort before the floor');
});

test('isUuid accepts valid uuids and rejects everything else', () => {
  assert.equal(isUuid(uuidv7()), true);
  assert.equal(isUuid('01890a5d-ac96-774b-bcce-b302099a8057'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(''), false);
  assert.equal(isUuid(123), false);
  assert.equal(isUuid(undefined), false);
  assert.equal(isUuid(null), false);
  assert.equal(isUuid('01890a5d-ac96-774b-bcce-b302099a805'), false); // too short
  assert.equal(isUuid('01890a5d-ac96-774b-bcce-b302099a80577'), false); // too long
});
