// SPDX-License-Identifier: MIT

/**
 * What a menu marks as current and a prompt starts from when it acts on
 * several torrents at once: their common value, and nothing when they differ.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedValue } from './sharedValue.ts';
import type { Torrent } from './types';

const torrent = (hash: string, fields: Partial<Torrent>) => ({ hash, ...fields }) as Torrent;
const byHash = new Map([
  ['a', torrent('a', { label: 'music', priority: 3, throttle: '' })],
  ['b', torrent('b', { label: 'music', priority: 2, throttle: '' })],
  ['c', torrent('c', { label: '', priority: 3, throttle: 'slow' })],
]);

test('the value all the torrents share', () => {
  assert.equal(sharedValue(byHash, ['a', 'b'], (t) => t.label), 'music');
  assert.equal(sharedValue(byHash, ['a', 'c'], (t) => t.priority), 3);
});

test('nothing when they differ', () => {
  assert.equal(sharedValue(byHash, ['a', 'b'], (t) => t.priority), undefined);
  assert.equal(sharedValue(byHash, ['a', 'b', 'c'], (t) => t.label), undefined);
});

test('a shared empty value is still shared: the global throttle group, no label', () => {
  assert.equal(sharedValue(byHash, ['a', 'b'], (t) => t.throttle), '');
  assert.equal(sharedValue(byHash, ['c'], (t) => t.label), '');
});

test('nothing for no torrents, or for one the list no longer has', () => {
  assert.equal(sharedValue(byHash, [], (t) => t.label), undefined);
  assert.equal(sharedValue(byHash, ['a', 'gone'], (t) => t.label), undefined);
});
