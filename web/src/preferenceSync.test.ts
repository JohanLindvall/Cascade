import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreferenceSync } from './preferenceSync.ts';
import type { Preferences } from './preferences.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('an initial read cannot overwrite a theme picked while it was in flight', async () => {
  const sync = new PreferenceSync(async () => {});
  const read = deferred<unknown>();
  const loaded = sync.load(() => read.promise);
  sync.update({ theme: 'retro' });
  await sync.flush(); // even a save that already completed must beat the old read
  read.resolve({ theme: 'light', detailHeight: 500 });
  assert.equal((await loaded).theme, 'retro');
  assert.equal((await loaded).detailHeight, 500);
});

test('writes are ordered and changes during a write drain afterwards', async () => {
  const first = deferred<void>();
  const writes: Partial<Preferences>[] = [];
  const sync = new PreferenceSync(async (patch) => {
    writes.push(patch);
    if (writes.length === 1) await first.promise;
  });
  sync.update({ theme: 'light' });
  const flushed = sync.flush();
  sync.update({ theme: 'retro', detailHeight: 420 });
  void sync.flush();
  assert.equal(writes.length, 1);
  first.resolve();
  await flushed;
  assert.deepEqual(writes, [{ theme: 'light' }, { theme: 'retro', detailHeight: 420 }]);
});

test('failed writes retry without losing newer changes', async () => {
  const writes: Partial<Preferences>[] = [];
  const sync = new PreferenceSync(async (patch) => {
    writes.push(patch);
    if (writes.length === 1) throw new Error('offline');
  });
  sync.update({ theme: 'light', detailHeight: 320 });
  await assert.rejects(sync.flush(), /offline/);
  sync.update({ theme: 'dark' });
  await sync.flush();
  assert.deepEqual(writes[1], { theme: 'dark', detailHeight: 320 });
});
