// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FILE_COLUMNS, PEER_COLUMNS, THROTTLE_COLUMNS, TRACKER_COLUMNS,
  fileIdentity, peerIdentity, throttleIdentity, trackerIdentity, type ThrottleRow,
} from './detailSort.ts';
import { sortRows } from './tableSort.ts';
import type { Peer, TorrentFile, Tracker } from './types.ts';

function peer(overrides: Partial<Peer> = {}): Peer {
  return {
    id: '', address: '10.0.0.1', port: 1234, client: '', progress: 0,
    upRate: 0, downRate: 0, upTotal: 0, downTotal: 0, peerRate: 0, peerTotal: 0,
    encrypted: false, obfuscated: false, incoming: false, snubbed: false,
    preferred: false, unwanted: false, banned: false, options: '', ...overrides,
  };
}

function file(overrides: Partial<TorrentFile> = {}): TorrentFile {
  return {
    index: 0, path: 'file', onDisk: '', size: 0, completedChunks: 0, sizeChunks: 0,
    priority: 1, progress: 0, created: false, ...overrides,
  };
}

function tracker(overrides: Partial<Tracker> = {}): Tracker {
  return {
    index: 0, url: '', type: 1, group: 0, trackerId: '', enabled: true, usable: true,
    open: false, busy: false, extra: false, canScrape: true, seeders: 0, leechers: 0,
    downloaded: 0, lastScrape: 0, scrapes: 0, successes: 0, lastSuccess: 0, nextSuccess: 0,
    failures: 0, lastFailure: 0, nextFailure: 0, latestEvent: 0, newPeers: 0, sumPeers: 0,
    interval: 0, minInterval: 0, lastActivity: 0, nextActivity: 0, ...overrides,
  };
}

test('peer addresses and ports use natural order, including IPv6', () => {
  const rows = [
    peer({ address: '10.0.0.10', port: 9 }),
    peer({ address: '10.0.0.2', port: 100 }),
    peer({ address: '10.0.0.2', port: 9 }),
    peer({ address: '2001:db8::2', port: 9 }),
  ];
  assert.deepEqual(sortRows(rows, { key: 'address', dir: 'asc' }, PEER_COLUMNS, peerIdentity),
    [rows[2], rows[1], rows[0], rows[3]]);
});

test('peer clients sort by name/version, and flags by their visible labels', () => {
  const rows = [
    peer({ address: 'a', client: 'qBittorrent 5.10', snubbed: true }),
    peer({ address: 'b', client: 'qBittorrent 5.2', encrypted: true }),
    peer({ address: 'c', client: 'Deluge', incoming: true }),
  ];
  assert.deepEqual(sortRows(rows, { key: 'client', dir: 'asc' }, PEER_COLUMNS, peerIdentity),
    [rows[2], rows[1], rows[0]]);
  assert.deepEqual(sortRows(rows, { key: 'flags', dir: 'asc' }, PEER_COLUMNS, peerIdentity),
    [rows[1], rows[2], rows[0]]);
});

test('every peer rate, transfer total and progress column sorts numerically both ways', () => {
  for (const key of ['progress', 'downRate', 'upRate', 'peerRate', 'downTotal', 'upTotal'] as const) {
    const rows = [9, 2048, 100].map((value, i) => peer({ address: String(i), [key]: value }));
    assert.deepEqual(sortRows(rows, { key, dir: 'desc' }, PEER_COLUMNS, peerIdentity),
      [rows[1], rows[2], rows[0]], key);
    assert.deepEqual(sortRows(rows, { key, dir: 'asc' }, PEER_COLUMNS, peerIdentity),
      [rows[0], rows[2], rows[1]], key);
  }
});

test('files sort by displayed filename then path, with original action indices preserved', () => {
  const rows = [
    file({ index: 4, path: 'alpha/episode10.mkv' }),
    file({ index: 8, path: 'zeta/episode2.mkv' }),
    file({ index: 2, path: 'beta/episode2.mkv' }),
  ];
  assert.deepEqual(sortRows(rows, { key: 'path', dir: 'asc' }, FILE_COLUMNS, fileIdentity).map(fileIdentity), [2, 8, 4]);
});

test('file size, progress and priority sort by their underlying numbers', () => {
  for (const [key, values] of [
    ['size', [9, 2048, 100]], ['progress', [0.25, 1, 0.5]], ['priority', [0, 2, 1]],
  ] as const) {
    const rows = values.map((value, index) => file({ index, [key]: value }));
    assert.deepEqual(sortRows(rows, { key, dir: 'desc' }, FILE_COLUMNS, fileIdentity), [rows[1], rows[2], rows[0]]);
    assert.deepEqual(sortRows(rows, { key, dir: 'asc' }, FILE_COLUMNS, fileIdentity), [rows[0], rows[2], rows[1]]);
  }
});

test('tracker URL order follows redacted URLs, without ordering by hidden credentials', () => {
  const rows = [
    tracker({ index: 2, url: 'https://tracker2.test/announce?passkey=aaa' }),
    tracker({ index: 1, url: 'https://tracker2.test/announce?passkey=zzz' }),
    tracker({ index: 0, url: 'https://tracker10.test/announce' }),
  ];
  assert.deepEqual(sortRows(rows, { key: 'url', dir: 'asc' }, TRACKER_COLUMNS, trackerIdentity),
    [rows[1], rows[0], rows[2]]);
});

test('tracker types and states sort by visible labels', () => {
  const rows = [
    tracker({ index: 0, type: 2, successes: 1 }),
    tracker({ index: 1, type: 1, failures: 2 }),
    tracker({ index: 2, type: 3, busy: true }),
  ];
  for (const key of ['type', 'state'] as const) {
    assert.deepEqual(sortRows(rows, { key, dir: 'asc' }, TRACKER_COLUMNS, trackerIdentity),
      [rows[2], rows[1], rows[0]], key);
  }
});

test('tracker counts are numeric, including the secondary counts of compound columns', () => {
  for (const key of ['seeders', 'leechers', 'downloaded'] as const) {
    const rows = [100, 9, 2048].map((value, index) => tracker({ index, [key]: value }));
    assert.deepEqual(sortRows(rows, { key, dir: 'desc' }, TRACKER_COLUMNS, trackerIdentity),
      [rows[2], rows[0], rows[1]], key);
  }
  const rows = [
    tracker({ index: 0, sumPeers: 20, newPeers: 2, successes: 20, failures: 2 }),
    tracker({ index: 1, sumPeers: 20, newPeers: 10, successes: 20, failures: 10 }),
    tracker({ index: 2, sumPeers: 9, newPeers: 9, successes: 9, failures: 9 }),
  ];
  for (const key of ['peers', 'attempts'] as const) {
    assert.deepEqual(sortRows(rows, { key, dir: 'desc' }, TRACKER_COLUMNS, trackerIdentity),
      [rows[1], rows[0], rows[2]], key);
    assert.deepEqual(sortRows(rows, { key, dir: 'asc' }, TRACKER_COLUMNS, trackerIdentity),
      [rows[2], rows[0], rows[1]], key);
  }
});

test('tracker announce times order chronologically with unknown times last', () => {
  const rows = [
    tracker({ index: 0, nextActivity: 0 }),
    tracker({ index: 1, nextActivity: 100 }),
    tracker({ index: 2, nextActivity: 200 }),
  ];
  assert.deepEqual(sortRows(rows, { key: 'nextActivity', dir: 'asc' }, TRACKER_COLUMNS, trackerIdentity),
    [rows[1], rows[2], rows[0]]);
  assert.deepEqual(sortRows(rows, { key: 'nextActivity', dir: 'desc' }, TRACKER_COLUMNS, trackerIdentity),
    [rows[2], rows[1], rows[0]]);
});

test('enabled trackers come first on the first click, then disabled trackers', () => {
  const rows = [tracker({ index: 0, enabled: false }), tracker({ index: 1, enabled: true })];
  assert.deepEqual(sortRows(rows, { key: 'enabled', dir: 'desc' }, TRACKER_COLUMNS, trackerIdentity), [rows[1], rows[0]]);
  assert.deepEqual(sortRows(rows, { key: 'enabled', dir: 'asc' }, TRACKER_COLUMNS, trackerIdentity), rows);
});

test('throttle limits treat zero as unlimited; current rates still treat zero as idle', () => {
  const rows: ThrottleRow[] = [
    { name: 'group10', down: 0, up: 0, downRate: 0, upRate: 0 },
    { name: 'group2', down: 2048, up: 2048, downRate: 2048, upRate: 2048 },
    { name: 'group1', down: 512, up: 512, downRate: 512, upRate: 512 },
  ];
  assert.deepEqual(sortRows(rows, { key: 'name', dir: 'asc' }, THROTTLE_COLUMNS, throttleIdentity),
    [rows[2], rows[1], rows[0]]);
  for (const key of ['down', 'up'] as const) {
    assert.deepEqual(sortRows(rows, { key, dir: 'desc' }, THROTTLE_COLUMNS, throttleIdentity),
      [rows[0], rows[1], rows[2]], key);
    assert.deepEqual(sortRows(rows, { key, dir: 'asc' }, THROTTLE_COLUMNS, throttleIdentity),
      [rows[2], rows[1], rows[0]], key);
  }
  for (const key of ['downRate', 'upRate'] as const) {
    assert.deepEqual(sortRows(rows, { key, dir: 'desc' }, THROTTLE_COLUMNS, throttleIdentity),
      [rows[1], rows[2], rows[0]], key);
  }
});

test('refreshed peers retain the chosen order and deterministic ties', () => {
  const a = peer({ address: '10.0.0.2', downRate: 100 });
  const b = peer({ address: '10.0.0.10', downRate: 100 });
  const c = peer({ address: '10.0.0.3', downRate: 10 });
  assert.deepEqual(sortRows([b, a, c], { key: 'downRate', dir: 'desc' }, PEER_COLUMNS, peerIdentity), [a, b, c]);
  const refreshed = { ...c, downRate: 200 };
  assert.deepEqual(sortRows([b, refreshed, a], { key: 'downRate', dir: 'desc' }, PEER_COLUMNS, peerIdentity),
    [refreshed, a, b]);
});
