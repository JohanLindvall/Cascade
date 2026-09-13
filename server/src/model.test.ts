/**
 * mapTorrent turns raw multicall rows into what the whole UI shows. The
 * status derivation is the part with real branches — and the part where a
 * transient tracker message must not paint a healthy torrent red.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TORRENT_FIELDS, mapFile, mapPeer, mapTorrent, mapTracker, trackerHost } from './model';
import type { XValue } from './xmlrpc';

function row(over: Record<string, XValue> = {}): Record<string, XValue> {
  return {
    'd.hash': 'A'.repeat(40),
    'd.name': 'a release',
    'd.size_bytes': 1000,
    'd.completed_bytes': 500,
    'd.left_bytes': 500,
    'd.down.rate': 100,
    'd.up.rate': 0,
    'd.is_open': 1,
    'd.is_active': 1,
    'd.complete': 0,
    'd.hashing': 0,
    'd.hashing_failed': 0,
    'd.message': '',
    'd.ratio': 1500,
    ...over,
  };
}

test('status follows the lifecycle', () => {
  assert.equal(mapTorrent(row(), 0).status, 'downloading');
  assert.equal(mapTorrent(row({ 'd.complete': 1 }), 0).status, 'seeding');
  assert.equal(mapTorrent(row({ 'd.is_active': 0 }), 0).status, 'paused');
  assert.equal(mapTorrent(row({ 'd.is_open': 0, 'd.is_active': 0 }), 0).status, 'stopped');
  assert.equal(mapTorrent(row({ 'd.hashing': 2 }), 0).status, 'checking');
  assert.equal(mapTorrent(row({ 'd.hashing_failed': 1 }), 0).status, 'error');
});

test('a tracker whinge is not an error; anything else is', () => {
  assert.equal(
    mapTorrent(row({ 'd.message': 'Tracker: [Timeout was reached]' }), 0).status,
    'downloading',
  );
  assert.equal(mapTorrent(row({ 'd.message': 'Storage error: no space' }), 0).status, 'error');
});

test('eta needs a rate and something left; done means zero', () => {
  assert.equal(mapTorrent(row(), 0).eta, 5); // 500 left at 100/s
  assert.equal(mapTorrent(row({ 'd.down.rate': 0 }), 0).eta, null);
  assert.equal(mapTorrent(row({ 'd.complete': 1, 'd.left_bytes': 0 }), 0).eta, 0);
});

test('ratio is scaled from mille, progress is clamped', () => {
  const torrent = mapTorrent(row(), 0);
  assert.equal(torrent.ratio, 1.5);
  assert.equal(torrent.progress, 0.5);
  assert.equal(mapTorrent(row({ 'd.completed_bytes': 2000 }), 0).progress, 1);
  assert.equal(mapTorrent(row({ 'd.size_bytes': 0 }), 0).progress, 0);
});

test('labels decode the ruTorrent way, and bad escapes survive', () => {
  assert.equal(mapTorrent(row({ 'd.custom1': 'tv%20shows' }), 0).label, 'tv shows');
  assert.equal(mapTorrent(row({ 'd.custom1': '100%' }), 0).label, '100%');
});

test('every declared field is asked for at most once', () => {
  assert.equal(new Set(TORRENT_FIELDS).size, TORRENT_FIELDS.length);
});

test('trackerHost reads hostnames from tracker URLs of any scheme', () => {
  assert.equal(trackerHost('http://t.example.net:6969/announce'), 't.example.net');
  assert.equal(trackerHost('udp://t.example.net:6969'), 't.example.net');
  assert.equal(trackerHost('not a url'), 'unknown');
});

test('files, peers and trackers map their booleans and scaled numbers', () => {
  const file = mapFile({ 'f.path': 'dir/a.bin', 'f.size_bytes': 10, 'f.completed_chunks': 1, 'f.size_chunks': 4, 'f.priority': 2, 'f.is_created': 1 }, 3);
  assert.equal(file.index, 3);
  assert.equal(file.progress, 0.25);
  assert.equal(file.created, true);
  assert.equal(mapFile({ 'f.size_chunks': 0 }, 0).progress, 0);
  assert.equal(file.onDisk, '');

  // The on-disk name is reported only when libtorrent shortened it.
  const same = mapFile({ 'f.path': 'dir/a.bin', 'f.frozen_path': '/downloads/rel/dir/a.bin' }, 0);
  assert.equal(same.onDisk, '');
  const cut = mapFile({ 'f.path': 'dir/' + 'x'.repeat(300) + '.bin', 'f.frozen_path': '/downloads/rel/dir/xxx~1a2b3c4d.bin' }, 0);
  assert.equal(cut.onDisk, 'xxx~1a2b3c4d.bin');
  assert.equal(mapFile({ 'f.path': 'a.bin', 'f.frozen_path': '' }, 0).onDisk, ''); // never opened

  const peer = mapPeer({ 'p.address': '10.0.0.1', 'p.port': 6881, 'p.completed_percent': 50, 'p.is_encrypted': 1, 'p.is_incoming': 0 });
  assert.equal(peer.progress, 0.5);
  assert.equal(peer.encrypted, true);
  assert.equal(peer.incoming, false);
  assert.equal(peer.client, '');

  const tracker = mapTracker({ 't.url': 'udp://t/x', 't.is_enabled': 1, 't.scrape_complete': 7, 't.type': 2 }, 1);
  assert.equal(tracker.index, 1);
  assert.equal(tracker.enabled, true);
  assert.equal(tracker.seeders, 7);
  assert.equal(tracker.type, 2);
});

test('8-bit strings arrive as Buffers and read as text; junk numbers read as zero', () => {
  const torrent = mapTorrent(row({ 'd.name': Buffer.from('nämn', 'utf8'), 'd.size_bytes': 'lots' }), 0);
  assert.equal(torrent.name, 'nämn');
  assert.equal(torrent.size, 0);
});
