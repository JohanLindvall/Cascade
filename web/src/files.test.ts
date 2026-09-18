/**
 * Both ways files arrive — a drop on the window and the Add dialog's picker —
 * decide what is a torrent with this, and tell the user about the rest with
 * the same words.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptTorrents, droppedFiles, isTorrentFile } from './files.ts';

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

const fileItem = (f: File) => ({ kind: 'file', getAsFile: () => f });

test('droppedFiles reads dataTransfer.files', () => {
  const a = file('a.torrent');
  assert.deepEqual(droppedFiles({ files: [a] }), [a]);
  assert.deepEqual(droppedFiles(null), []);
  assert.deepEqual(droppedFiles({}), []);
});

test('droppedFiles also reads file-kind items when .files is empty', () => {
  // The Linux drag source the field bug came from: the overlay accepts the
  // drop (items has a file) but .files is empty, so reading only .files turned
  // a real .torrent away.
  const a = file('Blodtår - Discography.torrent');
  const got = droppedFiles({ files: [], items: [{ kind: 'string', getAsFile: () => null }, fileItem(a)] });
  assert.deepEqual(got, [a]);
});

test('droppedFiles does not double-count a file both sources report', () => {
  const a = file('a.torrent');
  // A fresh File with the same name/size/mtime is the same drop, deduped.
  const same = new File([], 'a.torrent');
  const got = droppedFiles({ files: [a], items: [fileItem(same)] });
  assert.equal(got.length, 1);
});
