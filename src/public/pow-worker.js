'use strict';

// A classic (non-module) worker, loaded directly as /pow-worker.js — so
// the page's Content-Security-Policy needs only `worker-src 'self'`, no
// blob: URL or inline script construction.
importScripts('/sha256.js');

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

self.onmessage = function (e) {
  var ticket = e.data.ticket;
  var difficulty = e.data.difficulty;
  var nonce = 0;
  for (;;) {
    var candidate = String(nonce);
    var digest = sha256Hex(ticket + ':' + candidate);
    if (leadingZeroBits(digest) >= difficulty) {
      postMessage({ nonce: candidate });
      return;
    }
    nonce++;
  }
};
