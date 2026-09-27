/**
 * The black metal theme re-carves every badge title and rank name. A badge
 * or level title added on the server without a matching entry here shows
 * its plain name in that theme — so the two tables are checked against the
 * server's own definitions rather than a copy of them: game-catalog.json is
 * written from the Go achievement table by a test in server/internal/game,
 * which fails whenever the file and the table disagree.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { grimAchievement, grimGame } from './grim.ts';
import type { Achievement, GameState } from './types.ts';

const catalog = JSON.parse(fs.readFileSync(new URL('./game-catalog.json', import.meta.url), 'utf8')) as {
  achievements: string[];
  titles: string[];
};

function badge(id: string): Achievement {
  return { id, title: 'plain', description: 'plain', tier: 'bronze', icon: 'trophy', current: 0, target: 1, unlockedAt: null };
}

test('every server achievement has a carved title and description', () => {
  assert.ok(catalog.achievements.length > 0, 'the catalog lists no achievements');
  for (const id of catalog.achievements) {
    const carved = grimAchievement(badge(id));
    assert.notEqual(carved.title, 'plain', `${id} has no grim title`);
    assert.notEqual(carved.description, 'plain', `${id} has no grim description`);
    assert.equal(carved.id, id); // the id is what unlock state keys on
  }
});

test('every level title has a rank', () => {
  const titles = new Set(catalog.titles);
  assert.ok(titles.size >= 8, 'the server should hand out several titles');
  for (const title of titles) {
    const game = { title, achievements: [], enabled: true } as unknown as GameState;
    assert.notEqual(grimGame(game).title, title, `"${title}" has no grim rank`);
  }
});

test('an unknown badge or title passes through unchanged', () => {
  assert.equal(grimAchievement(badge('not-a-badge')).title, 'plain');
  const game = { title: 'Nobody', achievements: [badge('x')], enabled: true } as unknown as GameState;
  assert.equal(grimGame(game).title, 'Nobody');
});
