/**
 * The selection rules the list is operated by. The one that matters most is
 * the last: an action never reaches a row the current filter hides, so a
 * Delete after narrowing the list cannot take out torrents that scrolled out
 * of sight.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMPTY_SELECTION,
  actionTargets,
  hiddenSelected,
  selectOnly,
  selectRow,
  stepRow,
} from './selection.ts';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const plain = { ctrl: false, shift: false };
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };
const list = (selection: { selected: ReadonlySet<string> }) => [...selection.selected].sort();

test('a plain click selects only that row and anchors there', () => {
  const next = selectRow({ selected: new Set(['a', 'b']), anchor: 'a' }, ORDER, 'c', plain);
  assert.deepEqual(list(next), ['c']);
  assert.equal(next.anchor, 'c');
});

test('Ctrl toggles one row in or out, and moves the anchor', () => {
  let current = selectOnly('a');
  current = selectRow(current, ORDER, 'c', ctrl);
  assert.deepEqual(list(current), ['a', 'c']);
  assert.equal(current.anchor, 'c');
  current = selectRow(current, ORDER, 'a', ctrl);
  assert.deepEqual(list(current), ['c']);
});

test('Shift selects the range from the anchor in either direction, keeping the anchor', () => {
  const down = selectRow(selectOnly('b'), ORDER, 'd', shift);
  assert.deepEqual(list(down), ['b', 'c', 'd']);
  assert.equal(down.anchor, 'b');
  const up = selectRow(selectOnly('d'), ORDER, 'b', shift);
  assert.deepEqual(list(up), ['b', 'c', 'd']);
  // The next Shift-click measures from the same anchor, growing or shrinking.
  assert.deepEqual(list(selectRow(down, ORDER, 'e', shift)), ['b', 'c', 'd', 'e']);
  assert.deepEqual(list(selectRow(down, ORDER, 'c', shift)), ['b', 'c']);
});

test('Shift replaces the selection with the range; Ctrl+Shift adds to it', () => {
  const picked = { selected: new Set(['a', 'e']), anchor: 'c' };
  assert.deepEqual(list(selectRow(picked, ORDER, 'd', shift)), ['c', 'd']);
  assert.deepEqual(list(selectRow(picked, ORDER, 'd', { ctrl: true, shift: true })), ['a', 'c', 'd', 'e']);
});

test('Shift with no anchor, or an anchor filtered out of view, acts as a plain click', () => {
  assert.deepEqual(list(selectRow(EMPTY_SELECTION, ORDER, 'c', shift)), ['c']);
  assert.deepEqual(list(selectRow(selectOnly('zz'), ORDER, 'c', shift)), ['c']);
});

test('arrow keys step through the visible rows and stop at the ends', () => {
  assert.equal(stepRow(ORDER, 'b', 1), 'c');
  assert.equal(stepRow(ORDER, 'b', -1), 'a');
  assert.equal(stepRow(ORDER, 'e', 1), 'e');
  assert.equal(stepRow(ORDER, 'a', -1), 'a');
  // From nothing (or a row the filter hid): Down starts at the top, Up at the bottom.
  assert.equal(stepRow(ORDER, null, 1), 'a');
  assert.equal(stepRow(ORDER, 'gone', -1), 'e');
  assert.equal(stepRow([], null, 1), null);
});

test('actions reach the visible selected rows, in list order', () => {
  assert.deepEqual(actionTargets(new Set(['d', 'b']), ORDER, null), ['b', 'd']);
});

test('selected rows the filter hides are not action targets', () => {
  const visible = ['a', 'b'];
  assert.deepEqual(actionTargets(new Set(['a', 'x', 'y']), visible, null), ['a']);
  // With every selected row hidden, the focused row stands in only if visible.
  assert.deepEqual(actionTargets(new Set(['x']), visible, 'b'), ['b']);
  assert.deepEqual(actionTargets(new Set(['x']), visible, 'x'), []);
  assert.deepEqual(actionTargets(new Set(), visible, null), []);
});

test('hidden selected rows are counted, removed torrents are not', () => {
  const exists = (hash: string) => hash !== 'removed';
  assert.equal(hiddenSelected(new Set(['a', 'x', 'y', 'removed']), ['a', 'b'], exists), 2);
  assert.equal(hiddenSelected(new Set(), ['a'], exists), 0);
});
