// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SearchResult } from './contracts.ts';
import { INITIAL_SEARCH, hasSearchWords, pollSearch, reduceSearch } from './search.ts';
import { ManualClock } from './demo/fixtures.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const done = { hashes: ['a'], pending: 0, failed: 0 };

test('typing keeps the last result until the current query answers, including no matches', () => {
  let state = reduceSearch(INITIAL_SEARCH, { type: 'query', query: 'movie' });
  assert.equal(state.hashes, null, 'the first search keeps the unfiltered list while waiting');
  state = reduceSearch(state, { type: 'result', query: 'movie', result: done });
  for (const query of ['l', 'li', 'linux']) {
    state = reduceSearch(state, { type: 'query', query });
    assert.equal(state.hashes, done.hashes, 'typing keeps the same matches and their identity');
    assert.equal(state.pending, 1);
  }
  const waiting = state;
  state = reduceSearch(state, { type: 'result', query: 'li', result: { ...done, hashes: ['old'] } });
  assert.equal(state, waiting, 'a late answer cannot replace the displayed matches');
  state = reduceSearch(state, { type: 'error', query: 'li', error: 'old failure' });
  assert.equal(state, waiting, 'a late failure cannot change the current query');
  state = reduceSearch(state, { type: 'result', query: 'linux', result: { ...done, hashes: ['b'] } });
  assert.deepEqual(state.hashes, ['b']);
  state = reduceSearch(state, { type: 'query', query: 'missing' });
  assert.deepEqual(state.hashes, ['b']);
  state = reduceSearch(state, { type: 'result', query: 'missing', result: { ...done, hashes: [] } });
  assert.deepEqual(state.hashes, [], 'a successful empty answer replaces old matches');
});

test('clearing restores all torrents, and the next query keeps them while it waits or fails', () => {
  for (const query of ['', ' .-_ ']) {
    let state = reduceSearch(INITIAL_SEARCH, { type: 'query', query: 'movie' });
    state = reduceSearch(state, { type: 'result', query: 'movie', result: done });
    state = reduceSearch(state, { type: 'query', query });
    assert.equal(state.hashes, null);
    assert.equal(state.pending, 0);
    state = reduceSearch(state, { type: 'query', query: 'linux' });
    assert.equal(state.hashes, null, 'an older filtered result must not reappear after clearing');
    state = reduceSearch(state, { type: 'error', query: 'linux', error: 'offline' });
    assert.equal(state.hashes, null);
    assert.equal(state.failed, 1);
  }
});

test('empty and punctuation-only queries read nothing; Unicode words still search', () => {
  for (const query of ['', ' .-_ ', '\t\n', '🎞️']) {
    const clock = new ManualClock(0);
    const stop = pollSearch(query, {
      read: async () => { assert.fail('an idle search made a request'); },
      changed: () => assert.fail('an idle search changed matches'), setTimer: clock.set, clearTimer: clock.clear,
      failed: (error) => assert.fail(error),
    });
    assert.equal(clock.pending, 0);
    stop();
  }
  for (const query of ['movie', '日本語', 'ÉTÉ', '١٢', '𐐀']) assert.ok(hasSearchWords(query));
});

test('typing is debounced, slow responses cannot stack, and progress is polled sooner', async () => {
  const clock = new ManualClock(0);
  const held = deferred<SearchResult>();
  const answers: SearchResult[] = [];
  let reads = 0;
  const stop = pollSearch('movie backup', {
    read: async (query) => { assert.equal(query, 'movie backup'); reads++; return reads === 1 ? held.promise : done; },
    changed: (result) => answers.push(result), setTimer: clock.set, clearTimer: clock.clear,
    failed: (error) => assert.fail(error),
  });
  clock.advance(199);
  assert.equal(reads, 0);
  clock.advance(1);
  assert.equal(reads, 1);
  clock.advance(30_000);
  assert.equal(reads, 1);
  held.resolve({ ...done, pending: 3 });
  await settle(); await settle();
  clock.advance(200);
  await settle();
  assert.equal(reads, 2);
  clock.advance(1999);
  assert.equal(reads, 2);
  clock.advance(1);
  assert.equal(reads, 3);
  assert.equal(answers[0].pending, 3);
  stop();
});

test('changing, clearing, hiding and unmounting abort and discard late answers', async () => {
  const clock = new ManualClock(0);
  const held = deferred<SearchResult>();
  let signal: AbortSignal | undefined;
  const answers: SearchResult[] = [];
  const deps = {
    read: async (_query: string, cancel: AbortSignal) => { signal = cancel; return held.promise; },
    changed: (result: SearchResult) => answers.push(result), setTimer: clock.set, clearTimer: clock.clear,
    failed: (error: string) => assert.fail(error),
  };
  const stopTyping = pollSearch('m', deps);
  stopTyping();
  clock.advance(1000);
  assert.equal(signal, undefined);
  const stop = pollSearch('movie', deps);
  clock.advance(200);
  stop();
  assert.equal(signal!.aborted, true);
  held.resolve(done);
  await settle(); await settle();
  assert.deepEqual(answers, []);
  assert.equal(clock.pending, 0);
  const resume = pollSearch('movie', deps);
  clock.advance(200);
  await settle(); await settle();
  assert.deepEqual(answers, [done]);
  resume();
});

test('a failure retains partial matches, redacts its message and retries', async () => {
  const clock = new ManualClock(0);
  let state = reduceSearch(INITIAL_SEARCH, { type: 'query', query: 'movie' });
  let reads = 0;
  const stop = pollSearch('movie', {
    read: async () => {
      reads++;
      if (reads === 2) throw new Error('failed https://tracker.example/?passkey=secretvalue');
      return { ...done, pending: reads === 1 ? 1 : 0 };
    },
    changed: (result) => { state = reduceSearch(state, { type: 'result', query: 'movie', result }); },
    failed: (error) => { state = reduceSearch(state, { type: 'error', query: 'movie', error }); },
    setTimer: clock.set, clearTimer: clock.clear,
  });
  clock.advance(200); await settle();
  clock.advance(200); await settle();
  assert.deepEqual(state.hashes, ['a']);
  assert.equal(state.pending, 0);
  assert.equal(state.failed, 1);
  assert.ok(!state.error?.includes('secretvalue'));
  clock.advance(4999);
  assert.equal(reads, 2);
  clock.advance(1); await settle();
  assert.deepEqual(state, { query: 'movie', ...done });
  stop();
});

test('the first failed request for a new query keeps the previous query’s result through retry', async () => {
  const clock = new ManualClock(0);
  let state = reduceSearch(INITIAL_SEARCH, { type: 'query', query: 'movie' });
  state = reduceSearch(state, { type: 'result', query: 'movie', result: done });
  state = reduceSearch(state, { type: 'query', query: 'linux' });
  let reads = 0;
  const stop = pollSearch('linux', {
    read: async () => {
      if (++reads === 1) throw new Error('offline');
      return { ...done, hashes: ['b'] };
    },
    changed: (result) => { state = reduceSearch(state, { type: 'result', query: 'linux', result }); },
    failed: (error) => { state = reduceSearch(state, { type: 'error', query: 'linux', error }); },
    setTimer: clock.set, clearTimer: clock.clear,
  });
  clock.advance(200); await settle();
  assert.equal(state.hashes, done.hashes);
  assert.equal(state.failed, 1);
  assert.equal(state.error, 'offline');
  clock.advance(4999);
  assert.equal(state.hashes, done.hashes);
  clock.advance(1); await settle();
  assert.deepEqual(state.hashes, ['b']);
  assert.equal(state.failed, 0);
  assert.equal(state.error, undefined);
  stop();
});
