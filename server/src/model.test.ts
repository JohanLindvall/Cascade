/**
 * mapTorrent turns raw multicall rows into what the whole UI shows. The
 * status derivation is the part with real branches — and the part where a
 * transient tracker message must not paint a healthy torrent red.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TORRENT_FIELDS, mapTorrent, trackerHost } from './model';
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
