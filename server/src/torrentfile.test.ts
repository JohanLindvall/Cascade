/**
 * The bencode gate: rtorrent's load.raw reports success for any payload, so
 * this parser is the only thing standing between a junk upload and a torrent
 * that silently never appears. The info hash must match what rtorrent will
 * compute, which is why it is hashed from the verbatim byte span.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { magnetInfoHash, parseTorrentFile } from './torrentfile';

/** A minimal bencode encoder, independent of the parser under test. */
function ben(value: unknown): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === 'string') return ben(Buffer.from(value));
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from('l'), ...value.map(ben), Buffer.from('e')]);
  }
  const record = value as Record<string, unknown>;
  const parts: Buffer[] = [Buffer.from('d')];
  for (const key of Object.keys(record).sort()) {
    parts.push(ben(key), ben(record[key]));
  }
  parts.push(Buffer.from('e'));
  return Buffer.concat(parts);
}

const PIECES = Buffer.alloc(20, 7);

function singleFile(): Buffer {
  return ben({
    announce: 'http://tracker.invalid/announce',
    info: { 'piece length': 262144, length: 12345, name: 'a file.bin', pieces: PIECES },
  });
}

test('a single-file torrent parses with the right hash, name and size', () => {
  const data = singleFile();
  const parsed = parseTorrentFile(data);
  assert.equal(parsed.name, 'a file.bin');
  assert.equal(parsed.size, 12345);
  const info = ben({ 'piece length': 262144, length: 12345, name: 'a file.bin', pieces: PIECES });
  const expected = crypto.createHash('sha1').update(info).digest('hex').toUpperCase();
  assert.equal(parsed.infoHash, expected);
});

test('a multi-file torrent sums its file lengths', () => {
  const data = ben({
    info: {
      name: 'release',
      'piece length': 262144,
      pieces: PIECES,
      files: [
        { length: 100, path: ['a.bin'] },
        { length: 250, path: ['sub', 'b.bin'] },
      ],
    },
  });
  assert.equal(parseTorrentFile(data).size, 350);
});

test('junk, truncation and wrong shapes are refused with a reason', () => {
  assert.throws(() => parseTorrentFile(Buffer.from('not a torrent')), /not a valid \.torrent/);
  assert.throws(() => parseTorrentFile(singleFile().subarray(0, 20)), /not a valid \.torrent/);
  assert.throws(() => parseTorrentFile(ben([1, 2, 3])), /expected a dictionary/);
  assert.throws(() => parseTorrentFile(ben({ announce: 'x' })), /no info dictionary/);
});

test('a dictionary key named __proto__ is data, not a prototype', () => {
  // Null-prototyped dicts keep a hostile key inert; before that, assigning it
  // rewired the object mid-parse.
  const data = ben({
    __proto__x: 'ignored', // sorted before "info"
    info: { 'piece length': 1, length: 1, name: 'x', pieces: PIECES },
  });
  // Splice the key into a literal __proto__ (the encoder cannot write one
  // through an object literal, which is rather the point).
  const patched = Buffer.from(data.toString('latin1').replace('10:__proto__x7:ignored', '9:__proto__7:ignored'), 'latin1');
  const parsed = parseTorrentFile(patched);
  assert.equal(parsed.name, 'x');
});

test('magnet info hashes read in hex and base32', () => {
  const hex = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';
  assert.equal(magnetInfoHash(`magnet:?xt=urn:btih:${hex.toLowerCase()}&dn=x`), hex);
  // The same 20 bytes, base32 encoded by hand for the fixture.
  const bytes = Buffer.from(hex, 'hex');
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let b32 = '';
  for (let i = 0; i < 160; i += 5) b32 += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  assert.equal(magnetInfoHash(`magnet:?xt=urn:btih:${b32}`), hex);
});

test('a magnet without a usable hash is undefined', () => {
  assert.equal(magnetInfoHash('magnet:?dn=nameless'), undefined);
  assert.equal(magnetInfoHash('magnet:?xt=urn:btih:tooshort'), undefined);
  assert.equal(magnetInfoHash('https://example.invalid/file.torrent'), undefined);
});

test('magnet topics are URL-decoded, fully matched and scoped to the xt parameter', () => {
  const hash = 'A'.repeat(40);
  assert.equal(magnetInfoHash(`magnet:?xt=urn%3Abtih%3A${hash}`), hash);
  assert.equal(magnetInfoHash(`magnet:?xt=urn:btmh:123&xt=urn:btih:${hash}`), hash);
  assert.equal(magnetInfoHash(`magnet:?dn=xt=urn:btih:${hash}`), undefined);
  assert.equal(magnetInfoHash(`magnet:?xt=urn:btih:${hash}!`), undefined);
  assert.equal(magnetInfoHash(`https://example.org/?xt=urn:btih:${hash}`), undefined);
});

test('malformed bencode and incomplete metadata are rejected before load', () => {
  const info = { name: 'file', length: 1, 'piece length': 1, pieces: PIECES };
  for (const patch of [
    { name: '' }, { length: -1 }, { length: 1.5 }, { 'piece length': 0 },
    { pieces: Buffer.alloc(19) }, { pieces: Buffer.alloc(40) }, { files: [] },
  ]) assert.throws(() => parseTorrentFile(ben({ info: { ...info, ...patch } })), /not a valid/);
  for (const key of Object.keys(info)) {
    const partial: Record<string, unknown> = { ...info };
    delete partial[key];
    assert.throws(() => parseTorrentFile(ben({ info: partial })), /not a valid/);
  }
  assert.throws(() => parseTorrentFile(Buffer.concat([singleFile(), Buffer.from('junk')])), /trailing data/);
  for (const integer of ['ie', 'i01e', 'i-0e', 'i1.5e', 'i1e3e']) {
    assert.throws(() => parseTorrentFile(Buffer.from(`d4:info${integer}e`)), /not a valid/);
  }
  assert.throws(() => parseTorrentFile(Buffer.from('d4:infode4:infodee')), /duplicate/);
  assert.throws(() => parseTorrentFile(Buffer.from('l'.repeat(200) + 'e'.repeat(200))), /nesting too deep/);
});

test('metadata keys cannot impersonate the info byte span', () => {
  const data = ben({ __span_info: 'ordinary data', info: { name: 'x', length: 1, 'piece length': 1, pieces: PIECES } });
  assert.equal(parseTorrentFile(data).name, 'x');
});
