import assert from 'node:assert/strict';
import { test } from 'node:test';
import { focusOnMenu, focusOnSelection } from './rowFocus.ts';

test('on a wide screen the menu focuses its row, filling the details pane', () => {
  assert.equal(focusOnMenu(false, null, 'a'), 'a');
  assert.equal(focusOnMenu(false, 'b', 'a'), 'a');
});

test('on a compact screen it leaves the focus alone, so no details sheet covers the list', () => {
  assert.equal(focusOnMenu(true, null, 'a'), null);
  // The menu key on the row already open in the sheet.
  assert.equal(focusOnMenu(true, 'a', 'a'), 'a');
});

test('checkbox and range selection leave compact cards available for more selections', () => {
  for (const mods of [{ ctrl: true, shift: false }, { ctrl: false, shift: true }]) {
    assert.equal(focusOnSelection(true, null, 'a', mods), null);
    assert.equal(focusOnSelection(false, 'b', 'a', mods), 'a');
  }
  assert.equal(focusOnSelection(true, null, 'a', { ctrl: false, shift: false }), 'a');
});
