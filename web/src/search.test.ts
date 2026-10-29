// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SearchResult } from './contracts.ts';
import { hasSearchWords, pollSearch } from './search.ts';
import { ManualClock } from './demo/fixtures.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const done = { hashes: ['a'], pending: 0, failed: 0 };

test('empty and punctuation-only queries read nothing; Unicode words still search', () => {
  for (const query of ['', ' .-_ ', '\t\n', '🎞️']) {
    const clock = new ManualClock(0);
    const stop = pollSearch(query, {
      read: async () => { assert.fail('an idle search made a request'); },
      changed: () => assert.fail('an idle search changed matches'), setTimer: clock.set, clearTimer: clock.clear,
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
  const answers: SearchResult[] = [];
  let reads = 0;
  const stop = pollSearch('movie', {
    read: async () => {
      reads++;
      if (reads === 2) throw new Error('failed https://tracker.example/?passkey=secretvalue');
      return { ...done, pending: reads === 1 ? 1 : 0 };
    },
    changed: (result) => answers.push(result), setTimer: clock.set, clearTimer: clock.clear,
  });
  clock.advance(200); await settle();
  clock.advance(200); await settle();
  assert.deepEqual(answers[1].hashes, ['a']);
  assert.equal(answers[1].pending, 0);
  assert.equal(answers[1].failed, 1);
  assert.ok(!answers[1].error?.includes('secretvalue'));
  clock.advance(4999);
  assert.equal(reads, 2);
  clock.advance(1); await settle();
  assert.deepEqual(answers[2], done);
  stop();
});
