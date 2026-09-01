/**
 * Both ways files arrive — a drop on the window and the Add dialog's picker —
 * decide what is a torrent with this, and tell the user about the rest with
 * the same words.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptTorrents, isTorrentFile } from './files.ts';

const file = (name: string, type = '') => new File([], name, { type });

test('a .torrent is recognised by extension (any case) or by MIME type', () => {
  assert.equal(isTorrentFile(file('release.torrent')), true);
  assert.equal(isTorrentFile(file('RELEASE.TORRENT')), true);
  assert.equal(isTorrentFile(file('blob', 'application/x-bittorrent')), true);
  assert.equal(isTorrentFile(file('release.torrent.txt')), false);
  assert.equal(isTorrentFile(file('notes.txt', 'text/plain')), false);
});

test('acceptTorrents keeps the torrents and counts the rest, in the right grammar', () => {
  const all = acceptTorrents([file('a.torrent'), file('b.torrent')]);
  assert.equal(all.accepted.length, 2);
  assert.equal(all.ignored, null);

  const one = acceptTorrents([file('a.torrent'), file('readme.md')]);
  assert.equal(one.accepted.length, 1);
  assert.equal(one.ignored, '1 file ignored — only .torrent files are accepted');

  const two = acceptTorrents([file('x.png'), file('y.png')]);
  assert.equal(two.accepted.length, 0);
  assert.equal(two.ignored, '2 files ignored — only .torrent files are accepted');
});
