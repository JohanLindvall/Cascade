/**
 * Preference sanitizing is the wall between a hand-edited state file (or a
 * hostile PATCH body) and the UI: anything malformed falls back rather than
 * reaching the browser.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PREFERENCES, sanitizePreferences } from './prefs';

test('a clean patch merges over the current values', () => {
  const next = sanitizePreferences(DEFAULT_PREFERENCES, { theme: 'retro', sortDir: 'asc' });
  assert.equal(next.theme, 'retro');
  assert.equal(next.sortDir, 'asc');
  assert.equal(next.sortKey, DEFAULT_PREFERENCES.sortKey);
});

test('unknown themes and sort keys fall back to the defaults', () => {
  const next = sanitizePreferences(DEFAULT_PREFERENCES, {
    theme: 'chrome-vomit',
    sortKey: 'nonsense',
  } as never);
  assert.equal(next.theme, 'system');
  assert.equal(next.sortKey, 'addedAt');
});

test('detailHeight is clamped into its livable range', () => {
  assert.equal(sanitizePreferences(DEFAULT_PREFERENCES, { detailHeight: 5 }).detailHeight, 140);
  assert.equal(sanitizePreferences(DEFAULT_PREFERENCES, { detailHeight: 99999 }).detailHeight, 2000);
  assert.equal(
    sanitizePreferences(DEFAULT_PREFERENCES, { detailHeight: Number.NaN }).detailHeight,
    DEFAULT_PREFERENCES.detailHeight,
  );
});

test('seenBadges deduplicates, stringifies and caps', () => {
  const next = sanitizePreferences(DEFAULT_PREFERENCES, {
    seenBadges: ['a', 'a', 1 as never, ...Array.from({ length: 500 }, (_, i) => `x${i}`)],
  });
  assert.equal(next.seenBadges.length, 200);
  assert.equal(next.seenBadges[0], 'a');
  assert.equal(next.seenBadges[1], '1');
  assert.deepEqual(sanitizePreferences(DEFAULT_PREFERENCES, { seenBadges: 'no' as never }).seenBadges, []);
});
