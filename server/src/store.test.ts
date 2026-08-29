/**
 * The store holds everything Cascade remembers, and its two hard rules are
 * pinned here: lifetime counters accumulate as deltas (removal erases
 * nothing, re-adding double-counts nothing), and an idle poll must not dirty
 * the file — unchanged counters used to rewrite the JSON every two seconds
 * for as long as a browser was open.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Store } from './store';

function tempStore(): { store: Store; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-store-'));
  const file = path.join(dir, 'state.json');
  return { store: new Store(file), file };
}

function torrent(over: Record<string, unknown> = {}) {
  return {
    hash: 'A'.repeat(40),
    upTotal: 0,
    downTotal: 0,
    progress: 0,
    ratio: 0,
    status: 'downloading',
    peersConnected: 0,
    label: '',
    finishedAt: 0,
    ...over,
  } as never;
}

test('totals accumulate as deltas and survive removal', () => {
  const { store } = tempStore();
  store.recordTorrents([torrent({ upTotal: 100, downTotal: 50 })]);
  assert.equal(store.stats.lifetimeUp, 100); // first sight credits the whole total
  store.recordTorrents([torrent({ upTotal: 150, downTotal: 75 })]);
  assert.equal(store.stats.lifetimeUp, 150);
  assert.equal(store.stats.lifetimeDown, 75);
  store.forget('A'.repeat(40));
  assert.equal(store.stats.lifetimeUp, 150); // removal erases nothing
  // Re-added: its totals are "new" again, which credits a fresh session once.
  store.recordTorrents([torrent({ upTotal: 10 })]);
  assert.equal(store.stats.lifetimeUp, 160);
});

test('a completion is counted once, even across remove and re-add', () => {
  const { store } = tempStore();
  store.recordTorrents([torrent({ progress: 1 })]);
  assert.equal(store.stats.completed, 1);
  store.forget('A'.repeat(40));
  store.recordTorrents([torrent({ progress: 1 })]);
  assert.equal(store.stats.completed, 1);
});

test('an unchanged poll does not re-dirty the file', () => {
  const { store, file } = tempStore();
  const list = [torrent({ upTotal: 5, status: 'seeding', peersConnected: 2, label: 'tv' })];
  store.recordTorrents(list);
  store.flush();
  assert.ok(fs.existsSync(file));
  fs.rmSync(file);
  // The same numbers again: nothing moved, so nothing to write.
  store.recordTorrents(list);
  store.flush();
  assert.ok(!fs.existsSync(file), 'an idle poll rewrote the state file');
  // But a real movement dirties it again.
  store.recordTorrents([torrent({ upTotal: 6, status: 'seeding' })]);
  store.flush();
  assert.ok(fs.existsSync(file));
});

test('addedAt records first sight and then holds still', () => {
  const { store } = tempStore();
  const first = store.addedAt('B'.repeat(40), 1000);
  assert.equal(first, 1000);
  assert.equal(store.addedAt('B'.repeat(40), 2000), 1000);
});

test('prune drops bookkeeping for vanished torrents only', () => {
  const { store } = tempStore();
  store.addedAt('C'.repeat(40), 1);
  store.addedAt('D'.repeat(40), 2);
  store.prune(new Set(['C'.repeat(40)]));
  assert.equal(store.addedAt('C'.repeat(40), 9), 1);
  assert.equal(store.addedAt('D'.repeat(40), 9), 9); // was pruned, re-recorded
});

test('the file survives a round trip', () => {
  const { store, file } = tempStore();
  store.upsertThrottle({ name: 'slow', up: 1024, down: 2048 });
  store.unlock('first-contact', 42);
  store.updatePreferences({ theme: 'dark' });
  store.flush();
  const reloaded = new Store(file);
  assert.deepEqual(reloaded.throttles(), [{ name: 'slow', up: 1024, down: 2048 }]);
  assert.equal(reloaded.unlockedAchievements['first-contact'], 42);
  assert.equal(reloaded.preferences().theme, 'dark');
});

test('log scopes persist and survive a reload', () => {
  const { store, file } = tempStore();
  assert.deepEqual(store.logScopes(), []);
  store.setLogScopes(['debug', 'tracker_debug']);
  store.flush();
  assert.deepEqual(new Store(file).logScopes(), ['debug', 'tracker_debug']);
});

test('a corrupt file starts clean instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-store-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{not json');
  const store = new Store(file);
  assert.equal(store.stats.lifetimeUp, 0);
  assert.deepEqual(store.throttles(), []);
});
