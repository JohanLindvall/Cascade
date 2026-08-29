/**
 * The settings table drives reads, writes and the supports map, and its one
 * absolute rule is the empty-string target: a setter called without it makes
 * rtorrent read the value as the target and fault (quirk 1 in CLAUDE.md).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SETTING_KEYS,
  SETTING_SPECS,
  decodeSettingValue,
  readableSettings,
  settingEntries,
  unsupportedSettingKeys,
} from './settings';

const resolveAll = (candidates: string | string[]): string | undefined =>
  Array.isArray(candidates) ? candidates[0] : candidates;

test('every setter is invoked against the empty-string target', () => {
  const entries = settingEntries(
    { downloadRate: 1024, pex: true, encryption: 'allow_incoming,try_outgoing', directory: '/d' },
    resolveAll,
  );
  assert.ok(entries.length >= 4);
  for (const entry of entries) {
    assert.equal(entry.params[0], '', `${entry.methodName} lost its target argument`);
  }
});

test('coercion by kind: clamps, booleans, flags', () => {
  const entry = (patch: Record<string, unknown>) =>
    settingEntries(patch, resolveAll)[0];

  assert.deepEqual(entry({ downloadRate: -5 })?.params, ['', 0]); // uint clamps at 0
  assert.deepEqual(entry({ maxPeersSeed: -1 })?.params, ['', -1]); // int keeps -1
  assert.deepEqual(entry({ maxPeersSeed: -9 })?.params, ['', -1]);
  assert.deepEqual(entry({ pex: true })?.params, ['', 1]);
  assert.deepEqual(entry({ pex: false })?.params, ['', 0]);
  // One argument per flag — quirk 2: a joined string is refused by rtorrent.
  assert.deepEqual(entry({ encryption: 'allow_incoming, try_outgoing' })?.params, [
    '',
    'allow_incoming',
    'try_outgoing',
  ]);
  assert.deepEqual(entry({ encryption: '' })?.params, ['', 'none']);
});

test('a key with no setter never produces an entry', () => {
  assert.deepEqual(settingEntries({ sessionDirectory: '/x' }, resolveAll), []);
});

test('readableSettings skips write-only keys and unresolved getters', () => {
  const pairs = readableSettings(resolveAll);
  const keys = pairs.map(([key]) => key);
  assert.ok(!keys.includes('encryption')); // write-only
  assert.ok(!keys.includes('dhtMode')); // write-only
  assert.ok(keys.includes('downloadRate'));
  // A backend with nothing resolves nothing.
  assert.deepEqual(readableSettings(() => undefined), []);
});

test('decodeSettingValue follows the declared kind', () => {
  assert.equal(decodeSettingValue('pex', '1'), true);
  assert.equal(decodeSettingValue('pex', '0'), false);
  assert.equal(decodeSettingValue('downloadRate', '2048'), 2048);
  assert.equal(decodeSettingValue('downloadRate', 'junk'), 0);
  assert.equal(decodeSettingValue('directory', Buffer.from('/dl')), '/dl');
  assert.equal(decodeSettingValue('portRange', '50000-50000'), '50000-50000');
});

test('unsupportedSettingKeys names what this backend cannot set', () => {
  const none = unsupportedSettingKeys(['downloadRate', 'sessionDirectory', 'unknown'], resolveAll);
  assert.deepEqual(none, ['sessionDirectory']); // read-only; unknown keys pass silently
  const all = unsupportedSettingKeys(['downloadRate'], () => undefined);
  assert.deepEqual(all, ['downloadRate']);
});

test('the spec table is internally consistent', () => {
  for (const key of SETTING_KEYS) {
    const spec = SETTING_SPECS[key];
    assert.ok(spec.get || spec.set, `${key} has neither getter nor setter`);
  }
});
