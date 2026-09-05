'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { leadingZeroBits, pathToId, escapeText, messageRowNode } = require('../src/public/client');

test('leadingZeroBits counts bits across every nibble value', () => {
  assert.equal(leadingZeroBits('0000ff'), 16);
  assert.equal(leadingZeroBits('1fff'), 3);
  assert.equal(leadingZeroBits('8fff'), 0);
  assert.equal(leadingZeroBits('ffff'), 0);
  assert.equal(leadingZeroBits('00000000'), 32);
});

test('pathToId extracts the id from a /m/<id> path, or returns the input unchanged', () => {
  const id = '01890a5d-ac96-774b-bcce-b302099a8057';
  assert.equal(pathToId(`/m/${id}`), id);
  assert.equal(pathToId(`https://other.example/forum/m/${id}`), id);
  assert.equal(pathToId('/'), '/');
  assert.equal(pathToId(''), '');
  assert.equal(pathToId(undefined), undefined);
});

test('escapeText only ever sets textContent, never innerHTML', () => {
  const el = { textContent: '', innerHTML: '' };
  escapeText(el, '<b>not markup</b>');
  assert.equal(el.textContent, '<b>not markup</b>');
  assert.equal(el.innerHTML, '');
});

// A minimal DOM stub — no jsdom, no browser: just enough of the
// createElement/appendChild/dataset/textContent surface for
// messageRowNode to build its tree against.
function createStubDocument() {
  return {
    createElement(tag) {
      return {
        tagName: tag,
        className: '',
        dataset: {},
        children: [],
        title: '',
        href: '',
        dateTime: '',
        textContent: '',
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      };
    },
  };
}

test('messageRowNode builds the expected tree and puts the body through textContent', () => {
  const doc = createStubDocument();
  const message = {
    id: 'id-1',
    message: '<script>alert(1)</script>',
    created_at: '2024-01-01T00:00:00.000Z',
    poster: 'aabbccddeeff0011',
  };

  const li = messageRowNode(doc, message);

  assert.equal(li.className, 'msg');
  assert.equal(li.dataset.id, 'id-1');
  assert.equal(li.children.length, 2);

  const [meta, body] = li.children;
  assert.equal(meta.className, 'msg-meta');
  assert.equal(meta.children.length, 3);

  const [idLink, time, poster] = meta.children;
  assert.equal(idLink.className, 'msg-id');
  assert.equal(idLink.href, '/m/id-1');
  assert.equal(idLink.dataset.id, 'id-1');
  assert.equal(idLink.textContent, 'id-1');

  assert.equal(time.dateTime, message.created_at);
  assert.equal(time.textContent, message.created_at);

  assert.equal(poster.className, 'poster');
  assert.equal(poster.dataset.poster, message.poster);
  assert.equal(poster.textContent, `poster:${message.poster}`);

  assert.equal(body.className, 'msg-body');
  // the literal, unescaped string lands in textContent — never parsed as
  // markup, regardless of what it contains
  assert.equal(body.textContent, message.message);
});

test('messageRowNode percent-encodes the id in the permalink href', () => {
  const doc = createStubDocument();
  const li = messageRowNode(doc, { id: 'a b', message: 'x', created_at: 'y', poster: 'z' });
  const idLink = li.children[0].children[0];
  assert.equal(idLink.href, '/m/a%20b');
});
