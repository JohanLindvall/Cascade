/**
 * The list order is state the whole table hangs off. Status sorts by
 * lifecycle rather than alphabet, and a missing ETA must sink to the end
 * instead of masquerading as "almost done".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SORT_KEYS, defaultSortDir, isSortKey, sortTorrents } from './sort.ts';
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

test('names sort case-insensitively, both directions', () => {
  const list = [torrent({ name: 'beta' }), torrent({ name: 'Alpha' }), torrent({ name: 'gamma' })];
  assert.deepEqual(
    sortTorrents(list, { key: 'name', dir: 'asc' }).map((t) => t.name),
    ['Alpha', 'beta', 'gamma'],
  );
  assert.deepEqual(
    sortTorrents(list, { key: 'name', dir: 'desc' }).map((t) => t.name),
    ['gamma', 'beta', 'Alpha'],
  );
});

test('status sorts by lifecycle, not alphabet', () => {
  const list = [
    torrent({ status: 'error' }),
    torrent({ status: 'seeding' }),
    torrent({ status: 'downloading' }),
    torrent({ status: 'stopped' }),
  ];
  assert.deepEqual(
    sortTorrents(list, { key: 'status', dir: 'asc' }).map((t) => t.status),
    ['downloading', 'seeding', 'stopped', 'error'],
  );
});

test('an unknown ETA sinks below every known one', () => {
  const list = [torrent({ eta: null }), torrent({ eta: 30 }), torrent({ eta: 999999 })];
  const sorted = sortTorrents(list, { key: 'eta', dir: 'asc' });
  assert.equal(sorted[0].eta, 30);
  assert.equal(sorted[2].eta, null);
});

test('numeric keys sort numerically and the input is left untouched', () => {
  const list = [torrent({ size: 30 }), torrent({ size: 200 }), torrent({ size: 9 })];
  const sorted = sortTorrents(list, { key: 'size', dir: 'desc' });
  assert.deepEqual(sorted.map((t) => t.size), [200, 30, 9]);
  assert.deepEqual(list.map((t) => t.size), [30, 200, 9]); // no mutation
});

test('a column opens in its natural direction; only known keys pass the guard', () => {
  assert.equal(defaultSortDir('name'), 'asc');
  assert.equal(defaultSortDir('label'), 'asc');
  assert.equal(defaultSortDir('size'), 'desc');
  assert.equal(defaultSortDir('addedAt'), 'desc');
  for (const key of SORT_KEYS) assert.ok(isSortKey(key), key);
  assert.ok(!isSortKey('hash'));
  assert.ok(!isSortKey(undefined));
});

test('names sort naturally: episode 2 before episode 10', () => {
  const list = [torrent({ name: 'Show S01E10' }), torrent({ name: 'Show S01E2' }), torrent({ name: 'show S01E1' })];
  assert.deepEqual(
    sortTorrents(list, { key: 'name', dir: 'asc' }).map((t) => t.name),
    ['show S01E1', 'Show S01E2', 'Show S01E10'],
  );
});

test('ties keep a fixed order by name, whichever way the column runs', () => {
  // Every row shares the sort value; the server's listing order must not leak through.
  const list = [torrent({ name: 'charlie' }), torrent({ name: 'alpha' }), torrent({ name: 'bravo' })];
  for (const dir of ['asc', 'desc'] as const) {
    assert.deepEqual(
      sortTorrents(list, { key: 'status', dir }).map((t) => t.name),
      ['alpha', 'bravo', 'charlie'],
      dir,
    );
  }
});
