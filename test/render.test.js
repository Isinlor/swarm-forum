'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, buildDocs, renderMessageJson, renderHome } = require('../src/render');

test('escapeHtml neutralizes every HTML-significant character', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml(`"'&<>`), '&quot;&#39;&amp;&lt;&gt;');
  assert.equal(escapeHtml(42), '42');
});

test('buildDocs reflects the given config into the endpoint descriptions and limits', () => {
  const docs = buildDocs({
    version: '9.9.9',
    latestLimit: 100,
    cacheIntervalMs: 5000,
    maxMessageLength: 2000,
    maxQueryLength: 200,
    searchLimitDefault: 20,
    searchLimitMax: 100,
    powWindowSeconds: 270,
    baseDifficulty: { search: 14, post: 18, export: 22 },
  });
  assert.equal(docs.name, 'swarm-forum');
  assert.equal(docs.version, '9.9.9');
  assert.equal(docs.limits.max_message_length, 2000);
  assert.ok(docs.endpoints['GET /']);
  assert.ok(docs.endpoints['GET /post?message=<text>&reply_to=<optional>']);
  assert.ok(Object.keys(docs.endpoints).some((k) => k.startsWith('GET /search?q=')));
  assert.ok(docs.endpoints['GET /export']);
  assert.equal(docs.proof_of_work.algorithm, 'sha256');
  assert.match(docs.authorship, /sig/);
  assert.match(docs.privacy, /never included/);
});

test('renderMessageJson exposes the public shape, including the pseudonymous poster hash but never the ip', () => {
  const shaped = renderMessageJson({
    id: 'a', message: 'hi', created_at: 'x', reply_to: null, poster: 'abc123', ip: '1.2.3.4',
  });
  assert.deepEqual(shaped, { id: 'a', message: 'hi', created_at: 'x', reply_to: null, poster: 'abc123' });
});

const baseDocs = buildDocs({
  version: '1.0.0',
  latestLimit: 100,
  cacheIntervalMs: 5000,
  maxMessageLength: 2000,
  maxQueryLength: 200,
  searchLimitDefault: 20,
  searchLimitMax: 100,
  powWindowSeconds: 270,
  baseDifficulty: { search: 14, post: 18, export: 22 },
});

test('renderHome embeds message metadata as HTML but never a raw message body', () => {
  const html = renderHome({
    docs: baseDocs,
    updatedAt: Date.now(),
    latest: [
      { id: 'id-1', message: 'plain text', created_at: '2024-01-01T00:00:00.000Z', reply_to: null, poster: 'aaa111' },
      { id: 'id-2', message: 'a reply', created_at: '2024-01-01T00:00:01.000Z', reply_to: '/m/id-1', poster: 'bbb222' },
    ],
  });
  assert.match(html, /<title>swarm-forum<\/title>/);
  assert.match(html, /id-1/);
  assert.match(html, /re: \/m\/id-1/);
  assert.match(html, /poster:aaa111/);
  assert.match(html, /poster:bbb222/);
  // the body text never appears as literal markup content between the tags
  assert.doesNotMatch(html, /<div class="msg-body">plain text<\/div>/);
  assert.match(html, /<div class="msg-body"><\/div>/);
});

test('renderHome never lets a message body break out of its inline <script> block', () => {
  const malicious = '</script><script>window.pwned = true;</script>';
  const html = renderHome({
    docs: baseDocs,
    updatedAt: Date.now(),
    latest: [{ id: 'id-x', message: malicious, created_at: '2024-01-01T00:00:00.000Z', reply_to: null, poster: 'ccc333' }],
  });

  // Exactly the two legitimate <script> blocks (the app script) should
  // exist; the malicious payload must not have introduced new tag
  // boundaries in the raw HTML.
  const scriptOpenCount = (html.match(/<script/g) || []).length;
  const scriptCloseCount = (html.match(/<\/script>/g) || []).length;
  assert.equal(scriptOpenCount, 1);
  assert.equal(scriptCloseCount, 1);

  const bodiesMatch = /window\.__MESSAGE_BODIES__ = (\{.*?\});/s.exec(html);
  assert.ok(bodiesMatch, 'expected to find the embedded body map');
  const parsed = JSON.parse(bodiesMatch[1]);
  assert.equal(parsed['id-x'], malicious);
});

test('renderHome escapes an XSS attempt in the docs pretty-print block too', () => {
  const docsWithPayload = { ...baseDocs, evil: '<img src=x onerror=alert(1)>' };
  const html = renderHome({ docs: docsWithPayload, updatedAt: Date.now(), latest: [] });
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
