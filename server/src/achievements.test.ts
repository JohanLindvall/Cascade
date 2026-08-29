/**
 * The gamification numbers are derived, never invented — so the derivations
 * are pinned: the level curve, the titles, and the unlock edge.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACHIEVEMENTS,
  EMPTY_STATS,
  buildGameState,
  levelFor,
  newlyUnlocked,
  titleFor,
  xpAtLevel,
  xpFor,
  type GameStats,
} from './achievements';

const GIB = 1024 * 1024 * 1024;

function stats(over: Partial<GameStats> = {}): GameStats {
  return { ...EMPTY_STATS, ...over };
}

test('levelFor and xpAtLevel agree at every boundary', () => {
  for (let level = 1; level <= 50; level++) {
    const floor = xpAtLevel(level);
    assert.equal(levelFor(floor), level, `xp ${floor} should open level ${level}`);
    if (floor > 0) assert.equal(levelFor(floor - 1), level - 1);
  }
  assert.equal(levelFor(-5), 1);
});

test('titles rank upward', () => {
  assert.equal(titleFor(1), 'Newcomer');
  assert.equal(titleFor(10), 'Seeder');
  assert.equal(titleFor(40), 'Legend');
  assert.equal(titleFor(0), 'Newcomer');
});

test('xp rewards sharing over taking', () => {
  const upheavy = xpFor(stats({ lifetimeUp: GIB }), 0);
  const downheavy = xpFor(stats({ lifetimeDown: GIB }), 0);
  assert.ok(upheavy > downheavy);
});

test('newlyUnlocked fires exactly at the target and never twice', () => {
  const nearly = newlyUnlocked(stats({ completed: 0, everAdded: 0 }), {});
  assert.ok(!nearly.includes('first-contact'));
  const now = newlyUnlocked(stats({ everAdded: 1 }), {});
  assert.ok(now.includes('first-contact'));
  const again = newlyUnlocked(stats({ everAdded: 1 }), { 'first-contact': 123 });
  assert.ok(!again.includes('first-contact'));
});

test('buildGameState carries every achievement with sane progress', () => {
  const game = buildGameState(stats({ lifetimeUp: GIB, everAdded: 3 }), { 'first-contact': 9 }, true);
  assert.equal(game.total, ACHIEVEMENTS.length);
  assert.equal(game.unlocked, 1);
  assert.ok(game.progress >= 0 && game.progress < 1);
  const first = game.achievements.find((item) => item.id === 'first-contact');
  assert.equal(first?.unlockedAt, 9);
});

test('every achievement id is unique and has a progress pair', () => {
  const ids = new Set(ACHIEVEMENTS.map((item) => item.id));
  assert.equal(ids.size, ACHIEVEMENTS.length);
  for (const def of ACHIEVEMENTS) {
    const [current, target] = def.progress(EMPTY_STATS);
    assert.equal(current, 0, def.id);
    assert.ok(target > 0, def.id);
  }
});
