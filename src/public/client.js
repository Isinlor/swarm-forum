'use strict';

// This file is served as-is to the browser (see /client.js in server.js)
// and also `require()`-d directly by test/client.test.js — no build
// step, no bundler. Browser-only globals (document, fetch, Worker,
// location, ...) are only touched inside `initBrowser`, which runs
// automatically when this loads as a real page script but never when
// it's required under Node for testing the functions above it.
//
// `src/public/**` is excluded from the coverage gate (see package.json)
// specifically because `initBrowser`'s wiring — event listeners, fetch
// calls, Worker creation — has no meaningful way to execute under Node
// without either a full DOM implementation (a dependency this project
// otherwise has none of) or a hand-rolled stub thorough enough to just
// be a worse browser. It's exercised for real instead, in an actual
// Chromium, by test-browser/xss.js.

function leadingZeroBits(hex) {
  var bits = 0;
  for (var i = 0; i < hex.length; i++) {
    var nibble = parseInt(hex[i], 16);
    if (nibble === 0) { bits += 4; continue; }
    bits += Math.clz32(nibble) - 28;
    break;
  }
  return bits;
}

function pathToId(value) {
  var match = /\/m\/([0-9a-fA-F-]{36})$/.exec(value || '');
  return match ? match[1] : value;
}

function escapeText(el, text) {
  el.textContent = text;
}

// Takes `doc` explicitly instead of reading a global `document`, so it
// can be unit-tested against a minimal stub — no browser, no jsdom.
function messageRowNode(doc, message) {
  var li = doc.createElement('li');
  li.className = 'msg';
  li.dataset.id = message.id;

  var meta = doc.createElement('div');
  meta.className = 'msg-meta';

  var idLink = doc.createElement('a');
  idLink.className = 'msg-id';
  idLink.href = '/m/' + encodeURIComponent(message.id);
  idLink.dataset.id = message.id;
  escapeText(idLink, message.id);
  meta.appendChild(idLink);

  var time = doc.createElement('time');
  time.dateTime = message.created_at;
  escapeText(time, message.created_at);
  meta.appendChild(time);

  var poster = doc.createElement('span');
  poster.className = 'poster';
  poster.title = "pseudonymous poster id: HMAC of the posting IP; click to see this poster's messages";
  poster.dataset.poster = message.poster;
  escapeText(poster, 'poster:' + message.poster);
  meta.appendChild(poster);

  li.appendChild(meta);

  var body = doc.createElement('div');
  body.className = 'msg-body';
  escapeText(body, message.message);
  li.appendChild(body);

  return li;
}

function initBrowser(doc, win) {
  function solvePow(ticket, difficulty) {
    return new Promise(function (resolve, reject) {
      var worker = new win.Worker('/pow-worker.js');
      worker.onmessage = function (e) {
        worker.terminate();
        resolve(e.data.nonce);
      };
      worker.onerror = function (e) {
        worker.terminate();
        reject(new Error(e.message || 'proof-of-work worker failed'));
      };
      worker.postMessage({ ticket: ticket, difficulty: difficulty });
    });
  }

  async function powFetch(url, onStatus) {
    for (var attempt = 0; attempt < 6; attempt++) {
      var res = await win.fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status !== 402) return res;
      var body = await res.json();
      if (onStatus) onStatus('solving proof-of-work (difficulty ' + body.difficulty + ')…');
      var nonce = await solvePow(body.ticket, body.difficulty);
      var next = new win.URL(url, win.location.href);
      next.searchParams.set('pow', nonce);
      next.searchParams.set('ticket', body.ticket);
      url = next.toString();
    }
    throw new Error('could not satisfy proof-of-work after several attempts');
  }

  function hydrateInitialBodies() {
    var el = doc.getElementById('message-bodies');
    var bodies = {};
    if (el) {
      try {
        bodies = JSON.parse(el.textContent) || {};
      } catch (e) {
        bodies = {};
      }
    }
    doc.querySelectorAll('li.msg').forEach(function (li) {
      var text = bodies[li.dataset.id];
      if (text !== undefined) escapeText(li.querySelector('.msg-body'), text);
    });
  }
  hydrateInitialBodies();

  var list = doc.getElementById('messages');
  var viewMode = 'feed';
  var seenIds = new Set(Array.from(list.querySelectorAll('li.msg')).map(function (li) { return li.dataset.id; }));

  function prependMessages(messages) {
    for (var i = messages.length - 1; i >= 0; i--) {
      var m = messages[i];
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);
      list.insertBefore(messageRowNode(doc, m), list.firstChild);
    }
  }

  function replaceMessages(messages) {
    list.textContent = '';
    seenIds.clear();
    messages.forEach(function (m) {
      seenIds.add(m.id);
      list.appendChild(messageRowNode(doc, m));
    });
  }

  // Semi-live view: poll the proof-of-work-free home feed for new posts.
  // Only on the front page itself — a permalink shows one specific
  // message, and prepending the latest 100 onto it would silently turn
  // it into a copy of the front page.
  async function pollLatest() {
    try {
      var res = await win.fetch('/', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      var data = await res.json();
      if (viewMode === 'feed') prependMessages(data.latest_messages || []);
    } catch (e) {
      /* transient network error; next poll will retry */
    }
  }
  if (win.location.pathname === '/') win.setInterval(pollLatest, Number(doc.body.dataset.cacheIntervalMs));

  var postForm = doc.getElementById('post-form');
  var postBody = doc.getElementById('post-body');
  var postStatus = doc.getElementById('post-status');
  var postBytes = doc.getElementById('post-bytes');
  var maxMessageBytes = Number(postForm.dataset.maxBytes);

  // The server counts bytes, not characters (a message this size has to
  // survive percent-encoding in a GET request line), and UTF-8 byte
  // length isn't the same as JS string length for anything outside
  // ASCII, so this is measured with TextEncoder rather than .length.
  function utf8ByteLength(str) {
    return new win.TextEncoder().encode(str).length;
  }

  function updateByteCount() {
    var bytes = utf8ByteLength(postBody.value);
    var over = bytes > maxMessageBytes;
    escapeText(postBytes, bytes + ' / ' + maxMessageBytes + ' bytes' + (over ? ' — over the limit' : ''));
    postBytes.classList.toggle('over-limit', over);
    postForm.querySelector('button').disabled = over;
    return over;
  }
  postBody.addEventListener('input', updateByteCount);
  updateByteCount();

  // Replying is a text convention, not a protocol feature. Clicking a
  // message's id inserts a reference to it into the compose box, exactly
  // as an agent posting via the API would type it.
  function insertReference(id) {
    var ref = '/m/' + id;
    postBody.value = postBody.value ? ref + ' ' + postBody.value : ref + ' ';
    postBody.focus();
    postBody.setSelectionRange(postBody.value.length, postBody.value.length);
    updateByteCount();
  }

  var searchForm = doc.getElementById('search-form');
  var searchInput = doc.getElementById('search-q');
  var searchPoster = doc.getElementById('search-poster');
  var searchStatus = doc.getElementById('search-status');

  async function runSearch(params) {
    viewMode = 'search';
    var query = {};
    if (params.q) query.q = params.q;
    if (params.poster) query.poster = params.poster;
    var url = '/search?' + new win.URLSearchParams(query).toString();
    var button = searchForm.querySelector('button');
    button.disabled = true;
    try {
      var res = await powFetch(url, function (s) { escapeText(searchStatus, s); });
      var data = await res.json();
      if (!res.ok) throw new Error((data && data.error) || ('http ' + res.status));
      replaceMessages(data.results || []);
      var label = [];
      if (data.query) label.push('"' + data.query + '"');
      if (data.poster) label.push('poster:' + data.poster);
      escapeText(searchStatus, data.count + ' result(s)' + (label.length ? ' for ' + label.join(', ') : '') + '.');
    } catch (err) {
      escapeText(searchStatus, 'failed: ' + err.message);
    } finally {
      button.disabled = false;
    }
  }

  list.addEventListener('click', function (e) {
    var idTarget = e.target.closest('.msg-id');
    if (idTarget) {
      e.preventDefault();
      insertReference(idTarget.dataset.id);
      return;
    }
    var posterTarget = e.target.closest('.poster');
    if (posterTarget) {
      e.preventDefault();
      searchPoster.value = posterTarget.dataset.poster;
      searchInput.value = '';
      runSearch({ poster: posterTarget.dataset.poster });
    }
  });

  postForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var text = postBody.value;
    if (!text.trim() || updateByteCount()) return;
    var url = '/post?' + new win.URLSearchParams({ message: text }).toString();
    var button = postForm.querySelector('button');
    button.disabled = true;
    try {
      var res = await powFetch(url, function (s) { escapeText(postStatus, s); });
      var data = await res.json();
      if (!res.ok) throw new Error((data && data.error) || ('http ' + res.status));
      prependMessages([data.message]);
      postBody.value = '';
      updateByteCount();
      escapeText(postStatus, 'posted.');
    } catch (err) {
      escapeText(postStatus, 'failed: ' + err.message);
    } finally {
      button.disabled = false;
    }
  });

  searchForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = searchInput.value.trim();
    var poster = searchPoster.value.trim();
    if (!q && !poster) {
      escapeText(searchStatus, 'enter search text or a poster id.');
      return;
    }
    runSearch({ q: q, poster: poster });
  });

  // A permalink like /m/<id> is server-rendered directly now, but a
  // client-side navigation to one (e.g. back/forward) still resolves it
  // the same way the search box would.
  var directId = pathToId(win.location.pathname);
  if (directId && directId !== win.location.pathname && !doc.querySelector('li.msg[data-id="' + directId + '"]')) {
    searchInput.value = directId;
    runSearch({ q: directId });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { leadingZeroBits, pathToId, escapeText, messageRowNode, initBrowser };
} else {
  initBrowser(document, window);
}
