/**
 * The demo's differ against the client's applyPatch: every golden case the Go
 * server and stream.ts are held to, then random states, so that whatever the
 * simulated stream sends is exactly the change applyPatch makes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { applyPatch, type Json, type JsonObject } from '../stream.ts';
import { diff, normalize } from './diff.ts';
import { seeded, type Random } from './random.ts';

interface GoldenCase {
  name: string;
  prev: JsonObject;
  next: JsonObject;
  patch: Json;
}

const golden = JSON.parse(
  fs.readFileSync(new URL('../../../server/internal/stream/testdata/patches.json', import.meta.url), 'utf8'),
) as GoldenCase[];

test('the golden cases are there to run', () => {
  assert.ok(golden.length >= 10, `only ${golden.length} golden cases`);
});

for (const item of golden) {
  test(`golden: ${item.name}`, () => {
    const patch = diff(item.prev, item.next);
    if (item.patch === null) {
      assert.equal(patch, undefined, 'a state that did not change gave a delta');
      return;
    }
    // The server's own patch, key for key (the gone list sorted as patch.go sorts it).
    assert.deepEqual(patch, item.patch);
    assert.deepEqual(applyPatch(structuredClone(item.prev), patch as Json), item.next);
  });
}

/** Round trip: what diff writes, applyPatch reads back as the new state; no change, no patch. */
function roundTrip(prev: Json, next: Json): void {
  const before = structuredClone(prev);
  const patch = diff(prev, next);
  if (patch === undefined) {
    assert.deepEqual(prev, next);
    return;
  }
  assert.deepEqual(applyPatch(prev, JSON.parse(JSON.stringify(patch)) as Json), next);
  assert.deepEqual(prev, before, 'diff changed the state it read');
  assert.equal(diff(next, structuredClone(next)), undefined);
}

function value(rng: Random, depth: number): Json {
  const roll = rng.int(0, depth > 3 ? 4 : 7);
  switch (roll) {
    case 0:
      return null;
    case 1:
      return rng.chance(0.5);
    case 2:
      return rng.int(-3, 3);
    case 3:
      return rng.pick(['', 'a', 'b', '-', '=', '__proto__']);
    case 4:
      return rng.range(-1, 1);
    case 5:
      return Array.from({ length: rng.int(0, 3) }, () => value(rng, depth + 1));
    default: {
      const out: JsonObject = {};
      for (let i = rng.int(0, 4); i > 0; i--) {
        const key = rng.pick(['a', 'b', 'c', 'hash', '0', '1', '-', '=', '__proto__']);
        Object.defineProperty(out, key, { value: value(rng, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
  }
}

/** A change to a value: one leaf replaced, a key added or dropped, an array grown. */
function mutate(rng: Random, current: Json, depth = 0): Json {
  if (current === null || typeof current !== 'object' || depth > 4 || rng.chance(0.15)) return value(rng, depth);
  if (Array.isArray(current)) {
    const out = current.slice();
    if (out.length > 0 && rng.chance(0.7)) {
      const i = rng.int(0, out.length - 1);
      out[i] = mutate(rng, out[i], depth + 1);
    } else {
      out.push(value(rng, depth + 1));
    }
    return out;
  }
  const out: JsonObject = {};
  for (const key of Object.keys(current)) {
    Object.defineProperty(out, key, { value: current[key], enumerable: true, writable: true, configurable: true });
  }
  const keys = Object.keys(out);
  const pick = rng.int(0, 2);
  if (pick === 0 && keys.length > 0) {
    const key = rng.pick(keys);
    out[key] = mutate(rng, out[key], depth + 1);
  } else if (pick === 1 && keys.length > 0) {
    delete out[rng.pick(keys)];
  } else {
    const key = rng.pick(['a', 'b', 'x', 'y', '-', '=']);
    Object.defineProperty(out, key, { value: value(rng, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

test('random values round-trip, "-" and "=" keys and "__proto__" among them', () => {
  const rng = seeded(7);
  for (let i = 0; i < 4000; i++) {
    const prev = value(rng, 0);
    roundTrip(prev, mutate(rng, prev));
    roundTrip(prev, value(rng, 0));
  }
});

test('state-shaped edits round-trip: torrents keyed by hash, the history keyed by t', () => {
  const rng = seeded(11);
  const state = (): JsonObject => normalize({
    status: {
      connected: true,
      downRate: rng.int(0, 3),
      statePollMs: 1000,
      history: Array.from({ length: rng.int(0, 4) }, (_, i) => ({ t: 100 + i + rng.int(0, 1), down: rng.int(0, 2), up: 0 })),
    },
    torrents: Array.from({ length: rng.int(0, 5) }, () => ({
      hash: `H${rng.int(0, 6)}`, upRate: rng.int(0, 2), eta: rng.pick([null, 5, 1.5]), name: rng.pick(['a', 'b']),
    })),
    throttles: Array.from({ length: rng.int(0, 2) }, () => ({ name: rng.pick(['slow', 'fast']), up: rng.int(0, 2) })),
    game: { xp: rng.int(0, 2), achievements: [{ id: 'a', current: rng.int(0, 2) }] },
  });
  for (let i = 0; i < 3000; i++) roundTrip(state(), state());
});

test('normalize keys the listed arrays, and leaves one it cannot key', () => {
  const state = normalize({
    status: { history: [{ t: 100, up: 1 }, { t: 101, up: 2 }] },
    torrents: [{ hash: 'AA', name: 'a' }, { hash: 'BB', name: 'b' }],
    throttles: [{ name: 'slow' }],
  });
  assert.deepEqual(state, {
    status: { history: { 100: { t: 100, up: 1 }, 101: { t: 101, up: 2 } } },
    torrents: { AA: { hash: 'AA', name: 'a' }, BB: { hash: 'BB', name: 'b' } },
    throttles: [{ name: 'slow' }],
  });
  for (const torrents of [[{ hash: 'AA' }, { name: 'no hash' }], [{ hash: 'AA' }, { hash: 'AA' }], [{ hash: '' }], ['x']]) {
    assert.ok(Array.isArray(normalize({ torrents } as JsonObject).torrents), JSON.stringify(torrents));
  }
});

test('normalize copies rather than changing the state it was given', () => {
  const input: JsonObject = { status: { history: [{ t: 1 }] }, torrents: [{ hash: 'AA' }] };
  const before = structuredClone(input);
  normalize(input);
  assert.deepEqual(input, before);
});
