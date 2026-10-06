// SPDX-License-Identifier: MIT

/**
 * The demo's badge table and level curve are a port of the server's
 * (server/internal/game): held here to the catalogue the Go tests hold the
 * server's table to, and to the curve's own fixed points.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import type { GameStats } from '../contracts.ts';
import { ACHIEVEMENTS, TITLES, buildGame, levelFor, newlyUnlocked, titleFor, xpAtLevel, xpFor } from './game.ts';

const catalog = JSON.parse(fs.readFileSync(new URL('../game-catalog.json', import.meta.url), 'utf8')) as {
  achievements: string[];
  titles: string[];
};

const ZERO: GameStats = {
  lifetimeUp: 0, lifetimeDown: 0, completed: 0, everAdded: 0, peakDownRate: 0, peakUpRate: 0,
  peakPeers: 0, bestRatio: 0, longestSeed: 0, maxSeeding: 0, maxLabels: 0,
};

test('the badges and titles are the catalogue the server keeps, in its order', () => {
  assert.deepEqual(ACHIEVEMENTS.map((def) => def.id), catalog.achievements);
  assert.deepEqual([...TITLES].reverse().map((title) => title.name), catalog.titles);
});

test('the level curve: 150 XP a step, squared; titles from their thresholds', () => {
  assert.equal(levelFor(0), 1);
  assert.equal(levelFor(149), 1);
  assert.equal(levelFor(150), 2);
  assert.equal(xpAtLevel(1), 0);
  assert.equal(xpAtLevel(2), 150);
  assert.equal(xpAtLevel(11), 15_000);
  for (let level = 1; level < 60; level++) assert.equal(levelFor(xpAtLevel(level)), level);
  assert.equal(titleFor(1), 'Newcomer');
  assert.equal(titleFor(10), 'Seeder');
  assert.equal(titleFor(39), 'Torrent Warden');
  assert.equal(titleFor(400), 'Legend');
});

test('XP leans towards uploading', () => {
  const MiB = 1024 * 1024;
  assert.equal(xpFor({ ...ZERO, lifetimeUp: 10 * MiB }, 0), 20);
  assert.equal(xpFor({ ...ZERO, lifetimeDown: 10 * MiB }, 0), 5);
  assert.equal(xpFor({ ...ZERO, completed: 2 }, 3), 950);
});

test('a badge unlocks once its progress reaches the target, and is recorded once', () => {
  const stats = { ...ZERO, everAdded: 1, maxSeeding: 10 };
  assert.deepEqual(newlyUnlocked(stats, {}), ['first-contact', 'seed-farm']);
  assert.deepEqual(newlyUnlocked(stats, { 'first-contact': 5 }), ['seed-farm']);
  const game = buildGame(stats, { 'first-contact': 5 });
  assert.equal(game.unlocked, 1);
  assert.equal(game.total, catalog.achievements.length);
  assert.equal(game.achievements.find((item) => item.id === 'first-contact')?.unlockedAt, 5);
  assert.equal(game.achievements.find((item) => item.id === 'seed-farm')?.unlockedAt, null);
  assert.equal(game.xp, 250);
  assert.ok(game.progress >= 0 && game.progress < 1);
});
