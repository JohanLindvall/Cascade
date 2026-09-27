import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { THEMES } from '../../server/src/prefs.ts';
import { THEME_MODES, fxFlavor, isThemeMode } from './theme.ts';

test('every listed mode passes the guard and matches the shared schema; junk does not', () => {
  assert.deepEqual(THEME_MODES.map((item) => item.mode), [...THEMES]);
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

const script = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);

function prepaint(cache: string, dark = false) {
  const dataset: { theme?: string } = {};
  let color = '';
  vm.runInNewContext(script!, {
    localStorage: { getItem: () => cache },
    window: { matchMedia: () => ({ matches: dark }) },
    document: { documentElement: { dataset }, querySelector: () => ({ setAttribute: (_: string, value: string) => { color = value; } }) },
  });
  return { theme: dataset.theme, color };
}

test('every supported theme applies before paint, including the browser theme color', () => {
  const colors = { light: '#f4f6fb', dark: '#0b0d13', retro: '#12082a', blackmetal: '#000000' };
  for (const mode of THEMES) {
    const resolved = mode === 'system' ? 'light' : mode;
    assert.deepEqual(prepaint(JSON.stringify({ theme: mode })), { theme: resolved, color: colors[resolved] });
  }
});

test('broken or unknown cached preferences follow the operating system', () => {
  for (const cache of ['null', '[]', 'broken', '{"theme":"unknown"}']) {
    assert.equal(prepaint(cache).theme, 'light');
    assert.equal(prepaint(cache, true).theme, 'dark');
  }
});
