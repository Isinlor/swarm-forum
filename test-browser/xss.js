'use strict';

// A real-browser XSS check, kept deliberately separate from `npm test`:
// it needs `playwright` and a downloaded Chromium build, neither of
// which this project otherwise depends on (see README's "zero runtime
// dependencies" claim — this file is the one place that isn't true, and
// it stays opt-in specifically so it never becomes true for anyone who
// doesn't ask for it). Everything else about message-body escaping is
// covered by test/render.test.js and test/client.test.js without a
// browser; this file exists because "the string looks escaped" and
// "nothing actually executed" are different claims, and only a real
// browser can verify the second one.
//
// Run with:
//   npm install --no-save playwright && npx playwright install chromium
//   npm run test:browser
//
// This file is intentionally NOT named *.test.js and NOT under test/,
// so Node's default `--test` file discovery (which is any *.test.js
// anywhere, or any .js file at all under a test/tests directory) never
// picks it up as part of the coverage-gated suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createServer } = require('../src/server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

test(
  'a </script><img onerror> message body renders literally and never executes',
  { skip: chromium ? false : 'playwright not installed — see the comment at the top of this file' },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-browser-test-'));
    const server = createServer({
      dataDir,
      dbFile: path.join(dataDir, 'db.sqlite'),
      port: 0,
      powSecret: 'browser-test',
      posterSecret: 'browser-test-poster',
      baseDifficulty: { search: 2, post: 2 },
      maxDifficulty: { search: 10, post: 10 },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    let browser;
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      let executed = false;
      await page.exposeFunction('__markExecuted', () => { executed = true; });
      page.on('dialog', async (dialog) => {
        executed = true;
        await dialog.dismiss();
      });

      await page.goto(base + '/');

      const payload = '</script><img src=x onerror="window.__markExecuted && window.__markExecuted()">';
      await page.fill('#post-body', payload);
      await page.click('#post-form button[type=submit]');
      await page.waitForFunction(
        () => document.getElementById('post-status').textContent === 'posted.',
        { timeout: 20000 },
      );

      const bodyText = await page.textContent('#messages li.msg:first-child .msg-body');
      assert.equal(bodyText, payload);

      const imgCount = await page.$$eval('#messages li.msg:first-child .msg-body img', (els) => els.length);
      assert.equal(imgCount, 0);

      await page.waitForTimeout(200); // give a real exploit time to fire, if it was going to
      assert.equal(executed, false);
    } finally {
      if (browser) await browser.close();
      server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  'the browser wiring — reply insertion, id search, poster click — works end to end',
  { skip: chromium ? false : 'playwright not installed — see the comment at the top of this file' },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-forum-browser-test-'));
    const server = createServer({
      dataDir,
      dbFile: path.join(dataDir, 'db.sqlite'),
      port: 0,
      powSecret: 'browser-test',
      posterSecret: 'browser-test-poster',
      baseDifficulty: { search: 2, post: 2 },
      maxDifficulty: { search: 10, post: 10 },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    let browser;
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(base + '/');

      await page.fill('#post-body', 'original message');
      await page.click('#post-form button[type=submit]');
      await page.waitForFunction(() => document.getElementById('post-status').textContent === 'posted.', { timeout: 20000 });
      const originalId = await page.getAttribute('#messages li.msg:first-child', 'data-id');
      const originalPoster = await page.getAttribute('#messages li.msg:first-child .poster', 'data-poster');

      // Clicking a message's id inserts a /m/<id> reference (the reply
      // convention) into the compose box, live-wired via /client.js.
      await page.click('#messages li.msg:first-child .msg-id');
      const composed = await page.inputValue('#post-body');
      assert.ok(composed.startsWith(`/m/${originalId}`));

      await page.fill('#post-body', `${composed}a reply`);
      await page.click('#post-form button[type=submit]');
      await page.waitForFunction(() => document.getElementById('post-status').textContent === 'posted.', { timeout: 20000 });

      await page.fill('#search-q', originalId);
      await page.click('#search-form button[type=submit]');
      await page.waitForFunction(() => /result\(s\)/.test(document.getElementById('search-status').textContent), { timeout: 20000 });
      const idOrder = await page.$$eval('#messages li.msg', (els) => els.map((el) => el.dataset.id));
      assert.equal(idOrder[0], originalId); // original surfaces first
      assert.equal(idOrder.length, 2);

      // Clicking a poster hash fills the poster field and re-runs the
      // search restricted to that poster.
      await page.click('#messages li.msg:first-child .poster');
      await page.waitForFunction(() => document.getElementById('search-poster').value.length > 0, { timeout: 20000 });
      await page.waitForFunction(() => /result\(s\)/.test(document.getElementById('search-status').textContent), { timeout: 20000 });
      const posterFieldValue = await page.inputValue('#search-poster');
      assert.equal(posterFieldValue, originalPoster);
    } finally {
      if (browser) await browser.close();
      server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
