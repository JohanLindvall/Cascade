// SPDX-License-Identifier: MIT

/**
 * What the demo takes from an upload: the info hash (its own SHA-1, held to
 * node's), the files and trackers, the server's refusals word for word, the
 * magnet reading, and the shortened on-disk names of the patched libtorrent.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { bencode, torrentFile } from './fixtures.ts';
import { fitComponent } from './pathfit.ts';
import { sha1Hex } from './sha1.ts';
import { parseMagnet, parseTorrent, type TorrentInfo } from './torrentfile.ts';

const encoder = new TextEncoder();

function parsed(data: Uint8Array): TorrentInfo {
  const result = parseTorrent(data);
  assert.ok(!('error' in result), JSON.stringify(result));
  return result;
}

test('SHA-1 agrees with node on the standard vectors and on odd lengths', () => {
  assert.equal(sha1Hex(new Uint8Array()), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(sha1Hex(encoder.encode('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(sha1Hex(new Uint8Array(1_000_000).fill(0x61)), '34aa973cd4c4daa4f61eeb2bdbad27316534016f');
  for (const length of [55, 56, 63, 64, 65, 119, 120, 1000]) {
    const data = new Uint8Array(length).map((_, i) => (i * 31 + length) & 0xff);
    assert.equal(sha1Hex(data), createHash('sha1').update(data).digest('hex'), `length ${length}`);
  }
});

test('a single-file torrent: name, size, info hash of the info dictionary, trackers, private flag', () => {
  const data = torrentFile(
    { name: 'debian-13.1.0-amd64-netinst.iso', length: 40_000, private: 1 },
    { 'creation date': 1_759_000_000, 'announce-list': [['http://a.example.org/announce'], ['udp://b.example.net:6969/announce']] },
  );
  const info = parsed(data);
  const start = new TextDecoder('latin1').decode(data).indexOf('4:infod') + 6;
  const expected = createHash('sha1').update(data.subarray(start, data.length - 1)).digest('hex').toUpperCase();
  assert.equal(info.infoHash, expected);
  assert.equal(info.name, 'debian-13.1.0-amd64-netinst.iso');
  assert.equal(info.size, 40_000);
  assert.equal(info.isPrivate, true);
  assert.equal(info.isMultiFile, false);
  assert.deepEqual(info.files, [{ path: 'debian-13.1.0-amd64-netinst.iso', size: 40_000 }]);
  assert.deepEqual(info.trackers, [['http://a.example.org/announce'], ['udp://b.example.net:6969/announce']]);
  assert.equal(info.createdAt, 1_759_000_000);
});

test('a multi-file torrent: paths joined from their components, sizes summed', () => {
  const info = parsed(torrentFile({
    name: 'Big Buck Bunny',
    files: [
      { length: 30_000, path: ['big_buck_bunny_1080p_h264.mov'] },
      { length: 1_208, path: ['extras', 'readme.txt'] },
    ],
  }));
  assert.equal(info.isMultiFile, true);
  assert.equal(info.size, 31_208);
  assert.deepEqual(info.files, [
    { path: 'big_buck_bunny_1080p_h264.mov', size: 30_000 },
    { path: 'extras/readme.txt', size: 1_208 },
  ]);
  assert.deepEqual(info.trackers, [['http://tracker.example.org/announce']]);
  assert.equal(info.isPrivate, false);
});

test('what is not a torrent is refused with the server reason', () => {
  const refused = (data: Uint8Array | string, reason: string) => {
    const result = parseTorrent(typeof data === 'string' ? encoder.encode(data) : data);
    assert.deepEqual(result, { error: `not a valid .torrent file (${reason})` });
  };
  refused('hello\n', 'bad string length');
  refused('', 'truncated');
  refused('i42e', 'expected a dictionary');
  refused('de', 'no info dictionary');
  refused('d4:infod4:name1:xee', 'invalid piece length');
  refused('d1:b0:1:a0:e', 'duplicate or unsorted dictionary key');
  refused('i03e', 'bad integer');
  refused('d4:infodee junk', 'trailing data');
  refused(torrentFile({ name: 'x', length: 40_000, pieces: new Uint8Array(20) }), 'piece count does not match torrent size');
  refused(torrentFile({ name: '..', length: 10 }), 'invalid path component');
  refused(torrentFile({ name: 'x', files: [{ length: 10, path: ['a/b'] }] }), 'invalid path component');
  refused(torrentFile({ name: 'x', length: 10, files: [{ length: 10, path: ['a'] }] }), 'expected either length or files');
  refused(bencode({ info: { name: 'x', 'piece length': 16_384, 'meta version': 2, 'file tree': {} } }), 'v2-only torrents are not supported by rtorrent');
});

test('magnets: a hex or base32 hash, the name and trackers; anything else carries no hash', () => {
  assert.deepEqual(parseMagnet('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Probe+Magnet&tr=udp%3A%2F%2Ftracker.example.net%3A6969%2Fannounce'), {
    infoHash: '0123456789ABCDEF0123456789ABCDEF01234567',
    name: 'Probe Magnet',
    trackers: ['udp://tracker.example.net:6969/announce'],
  });
  // Base32 of the same twenty bytes.
  assert.equal(parseMagnet('magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH')?.infoHash, '0123456789ABCDEF0123456789ABCDEF01234567');
  assert.equal(parseMagnet('magnet:?dn=no-hash')?.infoHash, '');
  assert.equal(parseMagnet('magnet:?xt=urn:sha1:0123456789abcdef0123456789abcdef01234567')?.infoHash, '');
  assert.equal(parseMagnet('https://example.org/x.torrent'), null);
  assert.equal(parseMagnet('not a link'), null);
});

test('over-long names are shortened as the patched libtorrent does', () => {
  assert.equal(fitComponent(''), '');
  assert.equal(fitComponent('Some.Series.S01E01.mkv'), 'Some.Series.S01E01.mkv');
  assert.equal(fitComponent('a'.repeat(255)), 'a'.repeat(255));
  // FNV-1a of the original, computed independently.
  assert.equal(fitComponent(`${'a'.repeat(300)}.bin`), `${'a'.repeat(242)}~d9bcc566.bin`);
  const thai = `${'หลวง'.repeat(30)}.mp4`;
  const fitted = fitComponent(thai);
  const bytes = encoder.encode(fitted).length;
  assert.ok(bytes <= 255 && bytes > 251, `${bytes} bytes`);
  assert.ok(fitted.endsWith('.mp4') && fitted.includes('~') && fitted.startsWith('ห'));
  assert.ok(!fitted.includes('�'), 'a character was split');
  assert.notEqual(fitComponent(`${'x'.repeat(300)}A.bin`), fitComponent(`${'x'.repeat(300)}B.bin`));
  assert.ok(!fitComponent(`${'y'.repeat(300)}.${'z'.repeat(40)}`).endsWith('z'), 'a long "extension" is not one');
  const emoji = fitComponent(`${'🎵'.repeat(80)}.flac`);
  assert.ok(emoji.endsWith('.flac') && !emoji.includes('�') && encoder.encode(emoji).length <= 255);
  assert.ok(!fitComponent(`${'w'.repeat(240)}${' '.repeat(30)}tail.mkv`).includes(' ~'));
});
