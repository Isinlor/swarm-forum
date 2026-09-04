'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadOrCreateSecret } = require('../src/secret');

test('loadOrCreateSecret generates, persists (mode 0600), and reuses a secret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-secret-'));
  try {
    const file = path.join(dir, 'nested', '.secret');
    const first = loadOrCreateSecret(file);
    assert.equal(first.generated, true);
    assert.match(first.secret, /^[0-9a-f]{64}$/);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), first.secret);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const second = loadOrCreateSecret(file);
    assert.equal(second.generated, false);
    assert.equal(second.secret, first.secret);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadOrCreateSecret regenerates if the file exists but is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-secret-empty-'));
  try {
    const file = path.join(dir, '.secret');
    fs.writeFileSync(file, '   \n');
    const result = loadOrCreateSecret(file);
    assert.equal(result.generated, true);
    assert.match(result.secret, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
