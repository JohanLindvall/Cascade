/**
 * The cached preferences come out of localStorage, which anything — an older
 * build, a hand edit, another app on the same origin — may have written. A
 * stray value must fall back to its default instead of reaching the UI as an
 * unknown theme or sort key.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PREFERENCES, DETAIL_HEIGHT, normalizePreferences } from './preferences.ts';

test('nothing at all is the defaults', () => {
  assert.deepEqual(normalizePreferences(undefined), DEFAULT_PREFERENCES);
  assert.deepEqual(normalizePreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(normalizePreferences('a string'), DEFAULT_PREFERENCES);
  assert.deepEqual(normalizePreferences({}), DEFAULT_PREFERENCES);
});

test('valid values pass through', () => {
  const prefs = {
    theme: 'retro',
    sortKey: 'name',
    sortDir: 'asc',
    detailHeight: 400,
    seenBadges: ['touchdown'],
  };
  assert.deepEqual(normalizePreferences(prefs), prefs);
});

test('unknown enums fall back rather than reaching the UI', () => {
  const prefs = normalizePreferences({ theme: 'chrome-vomit', sortKey: 'hash', sortDir: 'sideways' });
  assert.equal(prefs.theme, DEFAULT_PREFERENCES.theme);
  assert.equal(prefs.sortKey, DEFAULT_PREFERENCES.sortKey);
  assert.equal(prefs.sortDir, 'desc');
});

test('the detail height is clamped and a non-number defaults', () => {
  assert.equal(normalizePreferences({ detailHeight: 5 }).detailHeight, DETAIL_HEIGHT.min);
  assert.equal(normalizePreferences({ detailHeight: 99999 }).detailHeight, DETAIL_HEIGHT.max);
  assert.equal(normalizePreferences({ detailHeight: 'tall' }).detailHeight, DEFAULT_PREFERENCES.detailHeight);
  assert.equal(normalizePreferences({ detailHeight: 300.6 }).detailHeight, 301);
});

test('seenBadges is always a list of strings', () => {
  assert.deepEqual(normalizePreferences({ seenBadges: 'touchdown' }).seenBadges, []);
  assert.deepEqual(normalizePreferences({ seenBadges: ['a', 2] }).seenBadges, ['a', '2']);
});

test('extra keys are dropped, not carried into the cache', () => {
  assert.ok(!('evil' in normalizePreferences({ evil: true })));
});
