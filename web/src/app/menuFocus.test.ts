import assert from 'node:assert/strict';
import { test } from 'node:test';
import { focusOnMenu } from './menuFocus.ts';

test('on a wide screen the menu focuses its row, filling the details pane', () => {
  assert.equal(focusOnMenu(false, null, 'a'), 'a');
  assert.equal(focusOnMenu(false, 'b', 'a'), 'a');
});

test('on a compact screen it leaves the focus alone, so no details sheet covers the list', () => {
  assert.equal(focusOnMenu(true, null, 'a'), null);
  // The menu key on the row already open in the sheet.
  assert.equal(focusOnMenu(true, 'a', 'a'), 'a');
});
