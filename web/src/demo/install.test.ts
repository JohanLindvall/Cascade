/**
 * install.ts in a stand-in page: the session starts with the first request,
 * not when the module loads, so a tab opened in the background and shown
 * minutes later still opens on the download that is about to finish.
 */
/// <reference path="./env.d.ts" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StateResponse } from '../contracts.ts';

const BASE = 'https://demo.example.org/Cascade/';
const realNow = Date.now;
let hiddenFor = 0;
Date.now = () => realNow() + hiddenFor;
const storage = new Map<string, string>();
Object.assign(globalThis, { window: globalThis, document: { baseURI: BASE }, __CASCADE_RTORRENT_VERSION__: '0.16.24' });
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
});
await import('./install.ts');

test('a page first used minutes after it loaded starts its session then, so nothing has finished unseen', async () => {
  hiddenFor = 5 * 60_000;
  const state = (await (await fetch(`${BASE}api/state`)).json()) as StateResponse;
  const arch = state.torrents.find((t) => t.name.startsWith('archlinux'));
  assert.equal(arch?.status, 'downloading');
  assert.ok(arch && arch.progress < 1);
  assert.equal(state.game.achievements.find((item) => item.id === 'seed-farm')?.unlockedAt, null);
  assert.ok(Math.abs(state.status.history.at(-1)!.t - Date.now() / 1000) < 2, 'the session is current');
  // Later requests reach the same session.
  const patched = await fetch(`${BASE}api/prefs`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"theme":"retro"}' });
  assert.equal(((await patched.json()) as { theme: string }).theme, 'retro');
  assert.equal(JSON.parse(storage.get('cascade.demo.prefs') ?? '{}').theme, 'retro');
});
