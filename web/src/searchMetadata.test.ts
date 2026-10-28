// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchMetadata, searchMetadataKey } from './searchMetadata.ts';

const torrent = {
  hash: 'A'.repeat(40), name: 'Movie', directory: '/downloads', basePath: '/downloads/Movie',
  isMeta: false, trackerCount: 2, addedAt: 1,
};
const current = () => true;
const changed = () => {};
const files = [{ path: 'Extras/Interview.srt', onDisk: '/downloads/Movie/Extras/Interview.srt' }];
const trackers = [
  { url: 'https://primary.example/announce?passkey=secretvalue', trackerId: '' },
  { url: 'https://username:password@backup.example/announce', trackerId: 'Festival' },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('files and every tracker are searchable, cached across queries, and secrets are excluded', async () => {
  const calls: string[] = [];
  let now = 0;
  const cache = new SearchMetadata({
    files: async () => { calls.push('files'); return files; },
    trackers: async () => { calls.push('trackers'); return trackers; },
  }, () => now);
  cache.sync([torrent]);
  assert.deepEqual(calls, [], 'an idle search reads nothing');
  assert.equal(cache.snapshot([torrent]).pending, 1);
  await cache.load(current, changed);
  const state = cache.snapshot([torrent]);
  assert.equal(state.pending, 0);
  assert.equal(state.failed, 0);
  for (const word of ['extras/interview.srt', '/downloads/movie', 'primary.example', 'backup.example', 'festival']) {
    assert.ok(state.text[torrent.hash].includes(word), word);
  }
  for (const word of ['secretvalue', 'username', 'password']) assert.ok(!state.text[torrent.hash].includes(word));
  await cache.load(current, changed);
  assert.deepEqual(calls, ['files', 'trackers']);
  now = 60_000;
  await cache.load(current, changed);
  assert.deepEqual(calls, ['files', 'trackers', 'trackers'], 'only trackers need periodic refresh');
});

test('paths, arriving magnet metadata and tracker changes invalidate cached details; rates do not', async () => {
  let reads = 0;
  const cache = new SearchMetadata({
    files: async () => { reads++; return files; },
    trackers: async () => trackers,
  });
  const original = { ...torrent, downRate: 100 };
  const faster = { ...original, downRate: 200 };
  assert.equal(searchMetadataKey(original), searchMetadataKey(faster));
  const variants = [
    original, { ...original, directory: '/archive' }, { ...original, basePath: '/archive/Movie' },
    { ...original, isMeta: true }, { ...original, name: 'Metadata arrived' },
    { ...original, trackerCount: 3 }, { ...original, addedAt: 2 },
  ];
  for (const item of variants) {
    cache.sync([item]);
    assert.equal(cache.snapshot([item]).pending, 1);
    await cache.load(current, changed);
    assert.equal(cache.snapshot([item]).pending, 0);
  }
  assert.equal(reads, variants.length);
  cache.sync([]);
  assert.deepEqual(cache.snapshot([]).text, {});
  cache.sync([torrent]);
  assert.equal(cache.snapshot([torrent]).pending, 1, 'a re-added torrent is read again');
});

test('one failed source keeps the other’s results and retries without rereading successful files', async () => {
  for (const failed of ['files', 'trackers']) {
    let offline = true;
    let fileReads = 0;
    const cache = new SearchMetadata({
      files: async () => {
        fileReads++;
        if (offline && failed === 'files') throw new Error('offline');
        return files;
      },
      trackers: async () => {
        if (offline && failed === 'trackers') throw new Error('offline');
        return trackers;
      },
    });
    cache.sync([torrent]);
    await cache.load(current, changed);
    const state = cache.snapshot([torrent]);
    assert.equal(state.failed, 1);
    assert.equal(state.pending, 0);
    assert.equal(state.error, 'offline');
    assert.ok(state.text[torrent.hash].includes(failed === 'files' ? 'backup.example' : 'interview.srt'));
    offline = false;
    await cache.load(current, changed);
    assert.equal(cache.snapshot([torrent]).failed, 0);
    assert.equal(cache.snapshot([torrent]).error, undefined);
    assert.equal(fileReads, failed === 'files' ? 2 : 1);
  }
});

test('clearing or hiding a search stops the queue; resuming shares the pending read', async () => {
  const held = deferred<typeof files>();
  const second = { ...torrent, hash: 'B'.repeat(40) };
  const calls: string[] = [];
  let alive = true;
  let oldNotifications = 0;
  const cache = new SearchMetadata({
    files: async (hash) => { calls.push(`files:${hash}`); return hash === torrent.hash ? held.promise : files; },
    trackers: async (hash) => { calls.push(`trackers:${hash}`); return trackers; },
  });
  cache.sync([torrent, second]);
  const loading = cache.load(() => alive, () => oldNotifications++);
  assert.equal(calls.length, 2, 'only one torrent is read at a time');
  alive = false;
  const resumed = cache.load(current, changed);
  assert.equal(calls.length, 2, 'resuming cannot start a second queue');
  held.resolve(files);
  await Promise.all([loading, resumed]);
  assert.equal(oldNotifications, 0);
  assert.equal(calls.length, 4);
  assert.equal(cache.snapshot([torrent, second]).pending, 0);
});

test('a cleared search launches no more reads after the outstanding request finishes', async () => {
  const held = deferred<typeof files>();
  let alive = true;
  let reads = 0;
  const cache = new SearchMetadata({
    files: async () => { reads++; return held.promise; },
    trackers: async () => trackers,
  });
  cache.sync([torrent, { ...torrent, hash: 'B'.repeat(40) }]);
  const loading = cache.load(() => alive, changed);
  alive = false;
  held.resolve(files);
  await loading;
  assert.equal(reads, 1);
});

test('responses for a removed torrent or an old directory cannot restore stale matches', async () => {
  for (const next of [[], [{ ...torrent, directory: '/archive' }]]) {
    const held = deferred<typeof files>();
    let alive = true;
    const cache = new SearchMetadata({ files: () => held.promise, trackers: async () => trackers });
    cache.sync([torrent]);
    const loading = cache.load(() => alive, changed);
    cache.sync(next);
    alive = false;
    held.resolve(files);
    await loading;
    assert.deepEqual(cache.snapshot(next).text, {});
  }
});
