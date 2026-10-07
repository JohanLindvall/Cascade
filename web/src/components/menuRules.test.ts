// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextMenuVerdict, placeMenu } from './menuRules.ts';

const desktop = { width: 1280, height: 800 };

test('a menu that fits opens where the pointer is', () => {
  assert.deepEqual(placeMenu({ x: 100, y: 120 }, { width: 200, height: 300 }, desktop), {
    left: 100,
    top: 120,
    maxHeight: 784,
  });
});

test('a menu opened near the right or bottom edge moves in from it', () => {
  const placed = placeMenu({ x: 1200, y: 700 }, { width: 200, height: 300 }, desktop);
  assert.equal(placed.left, 1280 - 200 - 8);
  assert.equal(placed.top, 800 - 300 - 8);
});

test('a menu taller than the window ends inside it, however it was measured', () => {
  // A phone held sideways: 356px show while the URL bar is up, and the
  // stylesheet's 100vh is 412px. The torrent menu is about 700px of items
  // under a coarse pointer, and was measured either uncapped or under 100vh.
  const phone = { width: 800, height: 356 };
  for (const height of [700, 412 - 16]) {
    const placed = placeMenu({ x: 300, y: 200 }, { width: 220, height }, phone);
    assert.equal(placed.top, 8, `measured at ${height}px`);
    assert.equal(placed.maxHeight, 356 - 16, `measured at ${height}px`);
    assert.equal(placed.top + placed.maxHeight, phone.height - 8, `measured at ${height}px`);
  }
});

test('the cap never goes negative in a window smaller than the margins', () => {
  assert.equal(placeMenu({ x: 0, y: 0 }, { width: 10, height: 10 }, { width: 10, height: 10 }).maxHeight, 0);
});

test('a context-menu event inside the menu keeps it and holds the browser’s back', () => {
  // The keyboard's menu key: its contextmenu lands on the focused item.
  assert.equal(contextMenuVerdict(true, false), 'hold');
  assert.equal(contextMenuVerdict(true, true), 'hold');
});

test('a right-click another handler claimed is left to it', () => {
  // Another row, whose handler moves the menu there; closing here left the
  // row selected and no menu at all. The opening right-click itself also
  // reaches the window once the menu is listening.
  assert.equal(contextMenuVerdict(false, true), 'ignore');
});

test('a right-click anywhere else closes the menu', () => {
  assert.equal(contextMenuVerdict(false, false), 'close');
});
