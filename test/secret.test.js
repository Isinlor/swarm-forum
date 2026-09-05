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

test('loadOrCreateSecret fails closed if the file exists but is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-secret-empty-'));
  try {
    const file = path.join(dir, '.secret');
    fs.writeFileSync(file, '   \n');
    assert.throws(() => loadOrCreateSecret(file), /empty/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent secret creation reads the atomically installed winner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-secret-race-')); const file = path.join(dir, '.secret');
  const original = fs.linkSync;
  fs.linkSync = () => { fs.writeFileSync(file, 'winner'); const err = new Error('exists'); err.code = 'EEXIST'; throw err; };
  try { assert.deepEqual(loadOrCreateSecret(file), { secret: 'winner', generated: false }); }
  finally { fs.linkSync = original; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('secret creation propagates non-EEXIST installation errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-secret-error-')); const original = fs.linkSync;
  fs.linkSync = () => { const err = new Error('denied'); err.code = 'EACCES'; throw err; };
  try { assert.throws(() => loadOrCreateSecret(path.join(dir, '.secret')), /denied/); }
  finally { fs.linkSync = original; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('secret creation closes and removes its temporary file after an early write failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-secret-write-')); const original = fs.writeFileSync;
  fs.writeFileSync = () => { throw new Error('write failed'); };
  try { assert.throws(() => loadOrCreateSecret(path.join(dir, '.secret')), /write failed/); }
  finally { fs.writeFileSync = original; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a concurrent empty winner fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-secret-empty-race-')); const file = path.join(dir, '.secret'); const original = fs.linkSync;
  fs.linkSync = () => { fs.writeFileSync(file, ''); const err = new Error('exists'); err.code = 'EEXIST'; throw err; };
  try { assert.throws(() => loadOrCreateSecret(file), /empty/); }
  finally { fs.linkSync = original; fs.rmSync(dir, { recursive: true, force: true }); }
});
