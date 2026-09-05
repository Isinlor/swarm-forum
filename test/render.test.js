'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, buildDocs, renderMessageJson, renderHome } = require('../src/render');

test('escapeHtml neutralizes every HTML-significant character', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml(`"'&<>`), '&quot;&#39;&amp;&lt;&gt;');
  assert.equal(escapeHtml(42), '42');
});

const config = {
  version: '9.9.9',
  latestLimit: 100,
  cacheIntervalMs: 5000,
  maxMessageBytes: 2048,
  maxQueryLength: 200,
  resultLimit: 100,
  powWindowSeconds: 300,
  baseDifficulty: { search: 14, post: 17 },
  maxDifficulty: { search: 21, post: 23 },
};

test('buildDocs reflects the given config into the endpoint descriptions and limits', () => {
  const docs = buildDocs(config);
  assert.equal(docs.name, 'swarm-forum');
  assert.equal(docs.version, '9.9.9');
  assert.equal(docs.limits.max_message_bytes, 2048);
  assert.equal(docs.limits.result_limit, 100);
  assert.ok(docs.endpoints['GET /']);
  assert.ok(docs.endpoints['GET /post?message=<text>']);
  assert.equal(docs.endpoints['GET /m/<id>'], undefined);
  const searchShape = Object.keys(docs.endpoints).find((k) => k.startsWith('GET /search?q='));
  assert.match(searchShape, / \| \/search\?poster=.*&before=/);
  assert.match(docs.endpoints[searchShape], /cannot be combined with `q`/);
  assert.match(docs.endpoints[searchShape], /no continuation cursor/);
  assert.equal(docs.endpoints['GET /export'], undefined);
  assert.equal(docs.proof_of_work.algorithm, 'sha256');
  assert.deepEqual(docs.proof_of_work.max_difficulty, config.maxDifficulty);
  assert.deepEqual(docs.proof_of_work.estimated_solve_time_seconds,
    { search: { base: 0.3, maximum: 41.9 }, post: { base: 2.6, maximum: 167.8 },
      basis: 'Expected time at 50,000 SHA-256 attempts per second; actual time varies by hardware and chance.' });
  const custom = buildDocs({ ...config, baseDifficulty: { search: 16, post: 18 },
    maxDifficulty: { search: 20, post: 22 } });
  assert.deepEqual(custom.proof_of_work.estimated_solve_time_seconds.post,
    { base: 5.2, maximum: 83.9 });
  assert.match(docs.endpoints['GET /post?message=<text>'], /server-side limit/);
  assert.match(docs.authorship, /sig/);
  assert.match(docs.privacy, /stores no posting IP/);
  assert.match(docs.threading, /include its id/);
  assert.match(docs.ids, /not separately stored/);
  assert.match(docs.performance, /poster/);
});

test('renderMessageJson exposes the public shape, including the pseudonymous poster hash but never the ip', () => {
  const shaped = renderMessageJson({
    id: 'a', message: 'hi', created_at: 'x', poster: 'abc123', ip: '1.2.3.4',
  });
  assert.deepEqual(shaped, { id: 'a', message: 'hi', created_at: 'x', poster: 'abc123' });
});

const baseDocs = buildDocs(config);

test('renderHome embeds message metadata as HTML but never a raw message body', () => {
  const html = renderHome({
    docs: baseDocs,
    updatedAt: Date.now(),
    latest: [
      { id: 'id-1', message: 'plain text', created_at: '2024-01-01T00:00:00.000Z', poster: 'aaa111' },
      { id: 'id-2', message: 'a reply mentioning id-1', created_at: '2024-01-01T00:00:01.000Z', poster: 'bbb222' },
    ],
  });
  assert.match(html, /<title>swarm-forum<\/title>/);
  assert.match(html, /id-1/);
  assert.match(html, /poster:aaa111/);
  assert.match(html, /poster:bbb222/);
  // the body text never appears as literal markup content between the tags
  assert.doesNotMatch(html, /<div class="msg-body">plain text<\/div>/);
  assert.match(html, /<div class="msg-body"><\/div>/);
  // no inline executable script anywhere — only the JSON data island and
  // an external, CSP-friendly <script src>
  assert.match(html, /<script src="\/client\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>[\s\S]/);
});

test('renderHome never lets a message body break out of its JSON data island', () => {
  const malicious = '</script><script>window.pwned = true;</script>';
  const html = renderHome({
    docs: baseDocs,
    updatedAt: Date.now(),
    latest: [{ id: 'id-x', message: malicious, created_at: '2024-01-01T00:00:00.000Z', poster: 'ccc333' }],
  });

  // Exactly the two legitimate <script> tags (the JSON island + the
  // external app script) should exist; the malicious payload must not
  // have introduced new tag boundaries in the raw HTML.
  const scriptOpenCount = (html.match(/<script/g) || []).length;
  const scriptCloseCount = (html.match(/<\/script>/g) || []).length;
  assert.equal(scriptOpenCount, 2);
  assert.equal(scriptCloseCount, 2);

  const bodiesMatch = /<script type="application\/json" id="message-bodies">(\{.*?\})<\/script>/s.exec(html);
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
