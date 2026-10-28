// SPDX-License-Identifier: MIT

/**
 * The sidebar filter and the search decide what the list shows, and the
 * counts beside each status must agree with what clicking it would show.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATUS_FILTERS, countByStatus, filterTorrents, matchesStatus } from './filter.ts';
import type { Torrent } from './types.ts';

let seq = 0;
function torrent(over: Partial<Torrent>): Torrent {
  seq += 1;
  return {
    hash: `${seq}`.padStart(40, '0'),
    name: `torrent ${seq}`,
    status: 'downloading',
    progress: 0,
    size: 0,
    completed: 0,
    left: 0,
    downRate: 0,
    upRate: 0,
    downTotal: 0,
    upTotal: 0,
    ratio: 0,
    eta: null,
    priority: 2,
    label: '',
    message: '',
    directory: '',
    basePath: '',
    throttle: '',
    isOpen: true,
    isActive: true,
    isPrivate: false,
    isMultiFile: false,
    isMeta: false,
    hashing: 0,
    chunkSize: 0,
    chunksDone: 0,
    chunksTotal: 0,
    peersConnected: 0,
    peersNotConnected: 0,
    peersComplete: 0,
    trackerCount: 0,
    addedAt: 0,
    startedAt: 0,
    finishedAt: 0,
    createdAt: 0,
    ...over,
  };
}

const list = [
  torrent({ name: 'Alpha Release', status: 'downloading', downRate: 100, label: 'tv' }),
  torrent({ name: 'beta', status: 'seeding', upRate: 0, label: 'tv' }),
  torrent({ name: 'Gamma', status: 'seeding', upRate: 50, label: 'films' }),
  torrent({ name: 'delta', status: 'stopped' }),
  torrent({ name: 'epsilon', status: 'error' }),
];
const hosts = { [list[0].hash]: 'a.example', [list[1].hash]: 'a.example', [list[2].hash]: 'b.example' };

test('"active" means traffic, not state', () => {
  assert.equal(matchesStatus(list[0], 'active'), true); // downloading with a rate
  assert.equal(matchesStatus(list[1], 'active'), false); // seeding, idle
  assert.equal(matchesStatus(list[2], 'active'), true); // seeding, uploading
  assert.equal(matchesStatus(list[3], 'all'), true);
  assert.equal(matchesStatus(list[3], 'stopped'), true);
  assert.equal(matchesStatus(list[3], 'seeding'), false);
});

test('the counts agree with what each filter shows', () => {
  const counts = countByStatus(list);
  for (const value of STATUS_FILTERS) {
    const shown = filterTorrents(list, { kind: 'status', value }, '', {}).length;
    assert.equal(counts[value], shown, value);
  }
  assert.equal(counts.all, 5);
  assert.equal(counts.seeding, 2);
  assert.equal(counts.active, 2);
  assert.equal(counts.paused, 0);
});

test('label and tracker filters match exactly', () => {
  assert.deepEqual(
    filterTorrents(list, { kind: 'label', value: 'tv' }, '', hosts).map((t) => t.name),
    ['Alpha Release', 'beta'],
  );
  assert.deepEqual(
    filterTorrents(list, { kind: 'tracker', value: 'b.example' }, '', hosts).map((t) => t.name),
    ['Gamma'],
  );
  // A torrent whose tracker is not known yet matches no tracker filter.
  assert.equal(filterTorrents(list, { kind: 'tracker', value: 'a.example' }, '', {}).length, 0);
});

test('search is case-insensitive over name and hash, and stacks on the filter', () => {
  assert.deepEqual(
    filterTorrents(list, { kind: 'status', value: 'all' }, '  ALPHA ', {}).map((t) => t.name),
    ['Alpha Release'],
  );
  assert.equal(filterTorrents(list, { kind: 'status', value: 'all' }, list[3].hash.slice(-6), {}).length, 1);
  assert.equal(filterTorrents(list, { kind: 'label', value: 'tv' }, 'gamma', {}).length, 0);
  assert.equal(filterTorrents(list, { kind: 'status', value: 'all' }, '', {}).length, 5);
});

const all = { kind: 'status', value: 'all' } as const;

test('search matches every word in any order, including fragments and punctuation-separated names', () => {
  const bunny = torrent({ name: 'Big.Buck_Bunny-1080p.mkv' });
  const other = torrent({ name: 'Big Buck Bunny 720p' });
  const torrents = [bunny, other];
  for (const search of ['bunny 1080', '1080 BUNNY', '  buck\t1080\n', 'bunn.1080', 'bunny-1080']) {
    assert.deepEqual(filterTorrents(torrents, all, search, {}), [bunny], search);
  }
  for (const search of ['bunny absent', 'big 2160']) {
    assert.deepEqual(filterTorrents(torrents, all, search, {}), [], search);
  }
  for (const search of ['', ' \t\n ', ' .-_ ']) {
    assert.deepEqual(filterTorrents(torrents, all, search, {}), torrents, search);
  }
});

test('search preserves non-English letters and digits', () => {
  const named = torrent({ name: 'Été_日本語_١٢' });
  for (const search of ['日本 ÉTÉ', '١٢ été', '日本語']) {
    assert.deepEqual(filterTorrents([named], all, search, {}), [named], search);
  }
  assert.deepEqual(filterTorrents([named], all, 'Русский', {}), []);
});

test('words can match across a torrent’s name, files, trackers and other metadata', () => {
  const named = torrent({
    name: 'Open Movie', hash: 'ABCDEF1234567890'.padEnd(40, '0'), label: 'Cinema',
    directory: '/downloads/Archive', basePath: '/downloads/Archive/Collection',
    status: 'paused', throttle: 'Overnight', message: 'Tracker timed out',
  });
  const torrents = [named, torrent({ name: 'Unrelated Interview', label: 'other' })];
  const hosts = { [named.hash]: 'primary.example.org' };
  const metadata = { [named.hash]: 'extras/director-interview.srt\nhttps://backup.example.org/announce\nfestival' };
  for (const search of [
    'movie interview', 'cinema srt', 'backup movie', 'festival director',
    'primary abcdef', 'archive paused', 'collection overnight', 'timed movie',
  ]) {
    assert.deepEqual(filterTorrents(torrents, all, search, hosts, metadata), [named], search);
  }
  assert.deepEqual(filterTorrents(torrents, all, 'movie other', hosts, metadata), []);
  assert.deepEqual(filterTorrents(torrents, { kind: 'label', value: 'other' }, 'interview backup', hosts, metadata), []);
  assert.deepEqual(filterTorrents(torrents, { kind: 'status', value: 'seeding' }, 'interview backup', hosts, metadata), []);
  assert.deepEqual(filterTorrents(torrents, { kind: 'tracker', value: 'primary.example.org' }, 'interview backup', hosts, metadata), [named]);
});

test('search does not match credentials hidden in tracker messages', () => {
  const named = torrent({ message: 'Failed https://tracker.example/announce?passkey=secretvalue' });
  assert.deepEqual(filterTorrents([named], all, 'tracker example', {}), [named]);
  assert.deepEqual(filterTorrents([named], all, 'secretvalue', {}), []);
});
