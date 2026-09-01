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
