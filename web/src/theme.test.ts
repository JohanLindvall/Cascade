/**
 * The theme table drives the picker, the pre-paint script and the effect
 * flavors; each theme must resolve, colour the browser chrome and name a
 * flavor, or one of those surfaces silently falls back.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { THEME_MODES, fxFlavor, isThemeMode } from './theme.ts';

test('every listed mode passes the guard; junk does not', () => {
  for (const item of THEME_MODES) assert.ok(isThemeMode(item.mode), item.mode);
  assert.ok(!isThemeMode('chrome-vomit'));
  assert.ok(!isThemeMode(undefined));
});

test('each resolved theme has an effect flavor', () => {
  assert.equal(fxFlavor('blackmetal'), 'grim');
  assert.equal(fxFlavor('retro'), 'arcade');
  assert.equal(fxFlavor('dark'), 'party');
  assert.equal(fxFlavor('light'), 'party');
});
