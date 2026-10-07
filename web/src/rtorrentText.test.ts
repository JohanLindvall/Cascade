// SPDX-License-Identifier: MIT

/**
 * What rtorrent can be sent as text, as the server holds it
 * (server/internal/validate/rtorrent.go) and words its refusals: xmlrpc-c
 * fails a whole call on a character beyond U+FFFF, and a directory change
 * used to stop the torrent before that came back. "/" is no destination:
 * rtorrent strips it to nothing and reads that as its working directory.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROOT_DIRECTORY, directoryProblem, linesProblem, sentence, unsendable } from './rtorrentText.ts';

const char = (code: number) => String.fromCodePoint(code);
const clapper = '🎬';
const beyond = `contains "${clapper}" (U+1F3AC): rtorrent's XML-RPC layer takes no character beyond U+FFFF, such as an emoji`;

test('text within the Basic Multilingual Plane goes as it is', () => {
  for (const text of ['', 'Season One', 'Café 中文 tab\there', 'line\nfeed', `x${char(0xfffd)}y`, `${char(0xd7ff)}${char(0xe000)}`]) {
    assert.equal(unsendable(text), null, text);
  }
});

test('what it cannot carry is named as the server names it', () => {
  assert.equal(unsendable(`/downloads/films ${clapper}`), beyond);
  assert.equal(unsendable(char(0x10000)), `contains "${char(0x10000)}" (U+10000): rtorrent's XML-RPC layer takes no character beyond U+FFFF, such as an emoji`);
  assert.equal(unsendable(`a${char(0xfffe)}b`), 'contains U+FFFE, which XML cannot carry');
  assert.equal(unsendable(char(0xffff)), 'contains U+FFFF, which XML cannot carry');
  assert.equal(unsendable('two\r\nlines'), 'contains a carriage return, which XML reads as a line feed');
  assert.equal(unsendable(`bell${char(7)}`), 'contains U+0007, a control character XML cannot carry');
  // The first problem is the one named.
  assert.equal(unsendable(`${clapper}\r`), beyond);
});

test('a lone surrogate is refused rather than sent as U+FFFD', () => {
  assert.equal(unsendable(`x${String.fromCharCode(0xd83c)}`), 'contains U+D83C, half of a surrogate pair');
  assert.equal(unsendable(String.fromCharCode(0xdfac)), 'contains U+DFAC, half of a surrogate pair');
});

test('a directory is never the root, however many slashes', () => {
  for (const text of ['/', '//', ' /// ']) assert.equal(directoryProblem(text), ROOT_DIRECTORY);
  assert.equal(
    ROOT_DIRECTORY,
    'cannot be "/": rtorrent strips a directory\'s trailing slashes and would put a single file in ".", the directory it runs in',
  );
  for (const text of ['', '  ', '/media', '/media/', '/.', '.', '~', '/downloads/Café 中文']) assert.equal(directoryProblem(text), null, text);
  assert.equal(directoryProblem(` /films ${clapper} `), beyond);
});

test('a list of links names the first line that cannot be sent, by its number in the field', () => {
  assert.equal(linesProblem(''), null);
  assert.equal(linesProblem('magnet:?xt=urn:btih:abc\n\nhttps://example.org/a.torrent'), null);
  assert.equal(linesProblem(`magnet:?xt=urn:btih:abc\n\nmagnet:?dn=${clapper}\nhttps://x/${char(0xffff)}`), `line 3 ${beyond}`);
  assert.equal(linesProblem(`a\r\nb ${clapper}`), `line 2 ${beyond}`);
});

test('a problem beneath a field is a sentence of its own', () => {
  assert.equal(sentence('contains a carriage return'), 'Contains a carriage return');
  assert.equal(sentence(`line 2 ${beyond}`), `Line 2 ${beyond}`);
});
