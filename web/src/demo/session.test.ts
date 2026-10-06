/**
 * The simulation over simulated hours: what it shows must hold together the
 * way a real rtorrent's numbers do, and move only forward.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Torrent } from '../contracts.ts';
import { parseLogLine } from '../format.ts';
import { CATALOG, LONG_NAME } from './catalog.ts';
import { HISTORY_LENGTH, Session } from './session.ts';

const START = Date.UTC(2026, 9, 6, 19, 0, 0) + 437;
const SEED = 0xca5cade;

function byName(torrents: Torrent[], prefix: string): Torrent {
  const found = torrents.find((t) => t.name.startsWith(prefix));
  assert.ok(found, `no torrent named ${prefix}`);
  return found;
}

test('the session opens as the catalogue describes: 18-24 torrents, every state, one private, one tracker message', () => {
  const session = new Session({ seed: SEED, now: START });
  const { torrents, status } = session.snapshot();
  assert.ok(torrents.length >= 18 && torrents.length <= 24, `${torrents.length} torrents`);
  assert.equal(torrents.length, CATALOG.length);
  const statuses = new Set(torrents.map((t) => t.status));
  for (const wanted of ['downloading', 'seeding', 'paused', 'stopped', 'checking'] as const) assert.ok(statuses.has(wanted), wanted);
  assert.equal(torrents.filter((t) => t.isPrivate).length, 1);
  assert.equal(torrents.filter((t) => t.message !== '').length, 1);
  assert.ok(torrents.every((t) => t.status !== 'error'), 'a tracker message is not an error');
  assert.ok(torrents.some((t) => t.isMultiFile));
  assert.ok(new Set(torrents.map((t) => t.label).filter(Boolean)).size >= 5);
  assert.equal(new Set(torrents.map((t) => t.hash)).size, torrents.length);
  assert.ok(torrents.every((t) => /^[0-9A-F]{40}$/.test(t.hash)));
  // The header graph starts full.
  assert.equal(status.history.length, HISTORY_LENGTH);
  assert.ok(status.downRate > 0 && status.upRate > 0);
});

test('one download completes within a minute of loading, moves to seeding and unlocks Seed Farm', () => {
  const session = new Session({ seed: SEED, now: START });
  const before = session.snapshot().torrents;
  const downloading = new Set(before.filter((t) => t.status === 'downloading').map((t) => t.hash));
  assert.equal(session.game().achievements.find((item) => item.id === 'seed-farm')?.unlockedAt, null);
  let finished: Torrent | undefined;
  let at = 0;
  for (let s = 1; s <= 60 && !finished; s++) {
    session.advance(START + s * 1000);
    finished = session.snapshot().torrents.find((t) => downloading.has(t.hash) && t.progress >= 1);
    at = s;
  }
  assert.ok(finished, 'nothing finished within a minute');
  assert.ok(at >= 30, `finished after only ${at}s`);
  assert.equal(finished.status, 'seeding');
  assert.equal(finished.left, 0);
  assert.equal(finished.completed, finished.size);
  assert.equal(finished.eta, 0);
  assert.ok(finished.finishedAt >= Math.floor(START / 1000) + 29 && finished.finishedAt <= Math.floor((START + at * 1000) / 1000));
  const badge = session.game().achievements.find((item) => item.id === 'seed-farm');
  assert.ok(badge?.unlockedAt, 'the tenth seeding torrent earns Seed Farm');
});

test('over simulated hours: progress only grows and stays within the size, totals only grow, the graph stays bounded', () => {
  const session = new Session({ seed: SEED, now: START });
  let previous = session.snapshot();
  let previousGame = session.game();
  let finishedSeen = 0;
  for (let step = 1; step <= 2 * 3600 / 7; step++) {
    session.advance(START + step * 7000);
    const next = session.snapshot();
    const game = session.game();
    const before = new Map(previous.torrents.map((t) => [t.hash, t]));
    for (const t of next.torrents) {
      assert.ok(t.completed >= 0 && t.completed <= t.size, `${t.name}: ${t.completed} of ${t.size}`);
      assert.equal(t.left, t.size - t.completed);
      assert.ok(t.progress >= 0 && t.progress <= 1);
      assert.ok(t.chunksDone >= 0 && t.chunksDone <= t.chunksTotal);
      if (t.eta !== null && t.progress < 1) assert.equal(t.eta, Math.round(t.left / t.downRate));
      if (t.progress >= 1) assert.ok(t.finishedAt > 0, `${t.name} complete without finishedAt`);
      if (t.status === 'downloading' || t.status === 'seeding') assert.equal(t.isActive && t.isOpen, true);
      const old = before.get(t.hash);
      if (!old) continue;
      assert.ok(t.progress >= old.progress, `${t.name} went back from ${old.progress} to ${t.progress}`);
      assert.ok(t.downTotal >= old.downTotal && t.upTotal >= old.upTotal, `${t.name} totals shrank`);
      if (old.progress < 1 && t.progress >= 1) {
        finishedSeen += 1;
        assert.equal(t.status, 'seeding');
      }
    }
    assert.ok(next.status.downTotal >= previous.status.downTotal && next.status.upTotal >= previous.status.upTotal);
    assert.ok(game.stats.lifetimeDown >= previousGame.stats.lifetimeDown && game.stats.lifetimeUp >= previousGame.stats.lifetimeUp);
    assert.ok(game.xp >= previousGame.xp);
    assert.equal(next.status.downRate, next.torrents.reduce((sum, t) => sum + t.downRate, 0));
    assert.equal(next.status.upRate, next.torrents.reduce((sum, t) => sum + t.upRate, 0));
    const history = next.status.history;
    assert.ok(history.length <= HISTORY_LENGTH);
    for (let i = 1; i < history.length; i++) assert.ok(history[i].t > history[i - 1].t, 'history out of order');
    previous = next;
    previousGame = game;
  }
  assert.ok(finishedSeen >= 4, `only ${finishedSeen} downloads finished in two hours`);
});

test('a page back after hours catches up in one read, its graph the last three minutes, second by second', () => {
  const session = new Session({ seed: SEED, now: START });
  const started = performance.now();
  const back = START + 8 * 3600_000;
  session.advance(back);
  assert.ok(performance.now() - started < 5000, 'catching up took too long');
  const { torrents, status } = session.snapshot();
  assert.equal(status.history.length, HISTORY_LENGTH);
  const last = Math.floor(back / 1000);
  assert.equal(status.history.at(-1)?.t, last);
  status.history.forEach((sample, i) => assert.equal(sample.t, last - HISTORY_LENGTH + 1 + i));
  assert.ok(torrents.every((t) => t.completed <= t.size && t.progress <= 1));
  assert.ok(torrents.filter((t) => t.status === 'seeding').length > 12, 'eight hours finished hardly anything');
});

test('what the torrents move is what the lifetime counters and the session totals gain', () => {
  const session = new Session({ seed: SEED, now: START });
  const before = session.snapshot();
  const game = session.game();
  session.advance(START + 600_000);
  const after = session.snapshot();
  const moved = (pick: (t: Torrent) => number) => {
    const old = new Map(before.torrents.map((t) => [t.hash, pick(t)]));
    return after.torrents.reduce((sum, t) => sum + pick(t) - (old.get(t.hash) ?? 0), 0);
  };
  const tolerance = after.torrents.length * 2;
  const down = moved((t) => t.downTotal);
  assert.ok(down > 1024 ** 3, 'ten minutes moved less than a GiB');
  assert.ok(Math.abs(session.game().stats.lifetimeDown - game.stats.lifetimeDown - down) <= tolerance);
  assert.ok(Math.abs(session.game().stats.lifetimeUp - game.stats.lifetimeUp - moved((t) => t.upTotal)) <= tolerance);
  assert.ok(Math.abs(after.status.downTotal - before.status.downTotal - down) <= tolerance);
});

test('the same seed is the same session; another seed another one', () => {
  const run = (seed: number) => {
    const session = new Session({ seed, now: START });
    for (const ms of [1500, 9000, 61_000, 300_000]) session.advance(START + ms);
    return { ...session.snapshot(), game: session.game(), log: session.logTail(400), peers: session.peers(session.list()[3].hash) };
  };
  assert.deepEqual(run(SEED), run(SEED));
  assert.notDeepEqual(run(SEED).torrents.map((t) => t.hash), run(SEED + 1).torrents.map((t) => t.hash));
});

test('throttle groups and the global limit hold the rates', () => {
  const session = new Session({ seed: SEED, now: START });
  session.settings.downloadRate = 2 * 1024 * 1024;
  session.saveThrottle({ name: 'seedbox', up: 64 * 1024, down: 0 });
  for (let s = 1; s <= 120; s++) {
    session.advance(START + s * 1000);
    const { status } = session.snapshot();
    // Each torrent's rate is rounded to a byte on its own.
    assert.ok(status.downRate <= 2 * 1024 * 1024 + 30, `${status.downRate} over the global limit`);
    assert.ok(session.groupRate('seedbox').up <= 64 * 1024 + 30, 'over the group limit');
  }
});

test('peers, trackers and files hang together with the listing', () => {
  const session = new Session({ seed: SEED, now: START });
  session.advance(START + 20_000);
  const documentation = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$|^2001:db8:/;
  for (const t of session.list()) {
    const peers = session.peers(t.hash);
    assert.equal(peers.length, t.peersConnected, t.name);
    assert.ok(peers.every((peer) => documentation.test(peer.address)), 'a peer outside the documentation ranges');
    assert.equal(new Set(peers.map((peer) => `${peer.address}:${peer.port}`)).size, peers.length, 'two peers share an address');
    if (t.progress >= 1) assert.ok(peers.every((peer) => peer.progress < 1), 'a seed connected to a seed');
    const trackers = session.trackers(t.hash);
    assert.equal(trackers.length, t.trackerCount);
    for (const tracker of trackers) {
      assert.ok(tracker.url === 'dht://' || /^(https?|udp):\/\/([a-z0-9-]+\.)*example\.(org|net|com)[:/]/.test(tracker.url), tracker.url);
      assert.equal(tracker.type, tracker.url.startsWith('dht:') ? 3 : tracker.url.startsWith('udp:') ? 2 : 1);
    }
    if (t.isPrivate) assert.ok(trackers.every((tracker) => tracker.type !== 3), 'a private torrent on DHT');
    const files = session.files(t.hash);
    assert.equal(files.reduce((sum, file) => sum + file.size, 0), t.size);
    assert.ok(files.every((file) => file.completedChunks <= file.sizeChunks && file.progress <= 1));
  }
  const aozora = session.list().find((t) => t.name.startsWith('青空文庫'));
  const long = session.files(aozora?.hash ?? '').find((file) => file.path === LONG_NAME);
  assert.ok(long?.onDisk && long.onDisk !== LONG_NAME && new TextEncoder().encode(long.onDisk).length <= 255);
  assert.ok(new TextEncoder().encode(LONG_NAME).length > 255);
});

test('the log is rtorrent\'s format throughout, and in order', () => {
  const session = new Session({ seed: SEED, now: START });
  session.advance(START + 900_000);
  const lines = session.logTail(2000);
  assert.ok(lines.length > 50, `only ${lines.length} lines`);
  let last = 0;
  for (const line of lines) {
    const parsed = parseLogLine(line);
    assert.ok(parsed.at, `not a log line: ${line}`);
    assert.ok(parsed.at.getTime() >= last, `out of order: ${line}`);
    last = parsed.at.getTime();
  }
  assert.ok(lines.some((line) => / I [0-9A-F]{40}->download_list: Confirming finished download\.$/.test(line)));
  assert.ok(lines.some((line) => /->tracker_list: received \d+ peers : /.test(line)));
  assert.ok(lines.some((line) => /->tracker_list: received failure : .* msg:'/.test(line)));
});

test('the checking torrent finishes its check and starts; a recheck clears the message and ends paused', () => {
  const session = new Session({ seed: SEED, now: START });
  const checking = session.list().find((t) => t.status === 'checking');
  assert.ok(checking);
  session.advance(START + 120_000);
  assert.equal(byName(session.list(), checking.name).status, 'downloading');
  const failing = session.list().find((t) => t.message !== '');
  assert.ok(failing);
  session.action(failing.hash, 'recheck');
  let t = byName(session.list(), failing.name);
  assert.equal(t.status, 'checking');
  assert.equal(t.message, '');
  assert.ok(t.progress < 1, 'a recheck starts from nothing verified');
  session.advance(START + 300_000);
  t = byName(session.list(), failing.name);
  assert.equal(t.status, 'paused');
  assert.equal(t.progress, 1);
  session.action(t.hash, 'recheck-restart');
  session.advance(START + 500_000);
  assert.equal(byName(session.list(), failing.name).status, 'seeding');
});
