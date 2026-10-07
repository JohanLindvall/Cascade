// SPDX-License-Identifier: MIT

/**
 * The stream's patches are written by the Go server and applied here, so the
 * two sides are held to the same golden cases: the Go tests check that diff
 * writes each patch, these that applying it gives the next state.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  EMPTY_MODEL, applyPatch, denormalizer, reduce,
  type Json, type JsonObject, type StreamModel,
} from './stream.ts';

interface GoldenCase {
  name: string;
  prev: JsonObject;
  next: JsonObject;
  patch: Json;
}

const golden = JSON.parse(
  fs.readFileSync(new URL('../../server/internal/stream/testdata/patches.json', import.meta.url), 'utf8'),
) as GoldenCase[];

test('the golden cases are there to run', () => {
  assert.ok(golden.length >= 10, `only ${golden.length} golden cases`);
});

for (const item of golden) {
  test(`golden: ${item.name}`, () => {
    // null is what the server sends nothing for: the state did not change.
    if (item.patch === null) {
      assert.deepEqual(item.prev, item.next);
      return;
    }
    const before = structuredClone(item.prev);
    assert.deepEqual(applyPatch(item.prev, item.patch), item.next);
    assert.deepEqual(item.prev, before, 'the patch changed the state it was applied to');
  });
}

test('"-" deletes the listed keys and ignores ones already gone', () => {
  assert.deepEqual(applyPatch({ a: 1, b: 2, c: 3 }, { '-': ['a', 'c', 'zz'] }), { b: 2 });
  assert.deepEqual(applyPatch({ a: 1 }, { '-': ['a'], d: { x: 1 } }), { d: { x: 1 } });
});

test('"=" replaces outright, and only when it stands alone', () => {
  assert.deepEqual(applyPatch([{ name: 'x' }], { '=': { AA: { hash: 'AA' } } }), { AA: { hash: 'AA' } });
  assert.deepEqual(applyPatch({ keep: 1 }, { '=': [1, 2] }), [1, 2]);
  // Beside other keys it is an ordinary key of an object patch.
  assert.deepEqual(applyPatch({ keep: 1 }, { '=': 5, b: 2 }), { keep: 1, '=': 5, b: 2 });
});

test('an object patches an array index by index, leaving the rest as they were', () => {
  const first = { id: 'a', current: 1 };
  const third = { id: 'c', current: 3 };
  const list = [first, { id: 'b', current: 2 }, third];
  const out = applyPatch(list, { 1: { current: 7 }, 9: { current: 1 }, x: 5 }) as JsonObject[];
  assert.deepEqual(out, [first, { id: 'b', current: 7 }, third]);
  assert.notEqual(out, list);
  assert.equal(out[0], first);
  assert.equal(out[2], third);
  // An index patch that reaches nothing is no change at all.
  assert.equal(applyPatch(list, { 5: 1 }), list);
});

test('what a patch does not touch keeps its identity', () => {
  const state: JsonObject = {
    status: { upRate: 1, backend: { supports: { labels: true } } },
    torrents: { AA: { hash: 'AA', upRate: 0 }, BB: { hash: 'BB', upRate: 5 } },
    throttles: [{ name: 'slow', up: 1024 }],
  };
  const before = structuredClone(state);
  const next = applyPatch(state, { torrents: { AA: { upRate: 2048 } } }) as JsonObject;
  const torrents = next.torrents as JsonObject;
  const oldTorrents = state.torrents as JsonObject;
  assert.equal(next.status, state.status);
  assert.equal(next.throttles, state.throttles);
  assert.equal(torrents.BB, oldTorrents.BB);
  assert.notEqual(torrents.AA, oldTorrents.AA);
  assert.deepEqual(torrents.AA, { hash: 'AA', upRate: 2048 });
  assert.deepEqual(state, before);
});

test('a key named __proto__ is data, not the prototype', () => {
  const out = applyPatch({}, JSON.parse('{"__proto__": {"hash": "x"}}') as Json) as JsonObject;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.ok(Object.hasOwn(out, '__proto__'));
  const patched = applyPatch(out, JSON.parse('{"__proto__": {"up": 1}}') as Json) as JsonObject;
  assert.deepEqual(Object.getOwnPropertyDescriptor(patched, '__proto__')?.value, { hash: 'x', up: 1 });
  assert.equal(Object.getPrototypeOf(patched), Object.prototype);
});

test('the denormalizer gives the keyed arrays back, history in time order', () => {
  const toState = denormalizer();
  const state = toState({
    status: {
      connected: true,
      // Past 2^32 these are not array indices, so the object keeps the order
      // they arrived in and only the sort puts them right.
      history: { 5000000001: { t: 5000000001, down: 2, up: 0 }, 5000000000: { t: 5000000000, down: 1, up: 0 } },
    },
    torrents: { BB: { hash: 'BB' }, AA: { hash: 'AA' } },
    throttles: [],
  });
  assert.deepEqual(state.torrents.map((torrent) => torrent.hash).sort(), ['AA', 'BB']);
  assert.deepEqual(state.status.history.map((sample) => sample.t), [5000000000, 5000000001]);
  assert.equal(state.status.connected, true);
});

test('the denormalizer passes through a list the server could not key', () => {
  const toState = denormalizer();
  const torrents = [{ name: 'no hash yet' }];
  assert.equal(toState({ torrents, status: { history: [] } }).torrents, torrents);
});

test('the denormalizer reuses every branch that did not change', () => {
  const toState = denormalizer();
  const first: JsonObject = {
    status: { upRate: 1, history: { 100: { t: 100, down: 0, up: 1 } } },
    torrents: { AA: { hash: 'AA', upRate: 0 } },
    game: { level: 1 },
  };
  const a = toState(first);
  assert.equal(toState(first), a, 'the same state twice is the same answer');

  // Only the rates moved: the torrent list is the same array, so nothing
  // keyed on it filters or sorts again.
  const second = applyPatch(first, { status: { upRate: 2 } }) as JsonObject;
  const b = toState(second);
  assert.equal(b.torrents, a.torrents);
  assert.equal(b.game, a.game);
  assert.notEqual(b.status, a.status);
  assert.equal(b.status.history, a.status.history);

  // A torrent changed: the status is the same object as before.
  const third = applyPatch(second, { torrents: { AA: { upRate: 5 } } }) as JsonObject;
  const c = toState(third);
  assert.equal(c.status, b.status);
  assert.notEqual(c.torrents, b.torrents);
  assert.equal(c.torrents[0].upRate, 5);
});

function event(type: string, data: unknown, id = ''): { type: string; data: string; id: string } {
  return { type, data: typeof data === 'string' ? data : JSON.stringify(data), id };
}

function step(model: StreamModel, ...events: Array<ReturnType<typeof event>>): StreamModel {
  let current = model;
  for (const item of events) {
    const next = reduce(current, item);
    assert.notEqual(next, 'resync', `${item.type} ${item.id} asked for a resync`);
    current = next as StreamModel;
  }
  return current;
}

test('a snapshot, then deltas in order', () => {
  const model = step(
    EMPTY_MODEL,
    event('snapshot', { torrents: { AA: { hash: 'AA', upRate: 0 } } }, 'k1-4'),
    event('delta', { torrents: { AA: { upRate: 9 } } }, 'k1-5'),
    event('delta', { torrents: { BB: { hash: 'BB' } } }, 'k1-6'),
  );
  assert.equal(model.lastId, 'k1-6');
  assert.deepEqual(model.state, { torrents: { AA: { hash: 'AA', upRate: 9 }, BB: { hash: 'BB' } } });
});

test('a delta that cannot be trusted asks for a fresh snapshot', () => {
  const model = step(EMPTY_MODEL, event('snapshot', { n: 1 }, 'k1-4'));
  assert.equal(reduce(EMPTY_MODEL, event('delta', { n: 2 }, 'k1-5')), 'resync', 'nothing to apply it to');
  assert.equal(reduce(model, event('delta', { n: 2 }, 'k1-6')), 'resync', 'a revision was skipped');
  assert.equal(reduce(model, event('delta', { n: 2 }, 'k2-5')), 'resync', 'another server run');
  assert.equal(reduce(model, event('delta', '{"n": ', 'k1-5')), 'resync', 'it does not parse');
  assert.equal(reduce(model, event('snapshot', '[1, 2]', 'k1-5')), 'resync', 'a snapshot that is not a state');
});

test('failure is said until ok, and a snapshot does not retract it', () => {
  let model = step(EMPTY_MODEL, event('failure', { error: 'rtorrent is not responding' }));
  assert.equal(model.failure, 'rtorrent is not responding');
  // The server re-sends a failure that still holds after every snapshot.
  model = step(model, event('snapshot', { n: 1 }, 'k1-1'));
  assert.equal(model.failure, 'rtorrent is not responding');
  assert.equal(reduce(model, event('failure', { error: 'rtorrent is not responding' })), model);
  model = step(model, event('ok', {}));
  assert.equal(model.failure, null);
  assert.equal(reduce(model, event('ok', {})), model, 'nothing to clear is no change');
  assert.equal(step(model, event('failure', 'not json')).failure, 'the server cannot read the state');
  assert.equal(reduce(model, event('heartbeat', '')), model);
});
