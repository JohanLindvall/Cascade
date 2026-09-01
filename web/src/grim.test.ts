/**
 * The black metal theme re-carves every badge title and rank name. A badge
 * or level title added on the server without a matching entry here shows
 * its plain name in that theme — so the two tables are checked against the
 * server's own definitions rather than a copy of them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACHIEVEMENTS, titleFor } from '../../server/src/achievements.ts';
import { grimAchievement, grimGame } from './grim.ts';
import type { Achievement, GameState } from './types.ts';

function badge(id: string): Achievement {
  return { id, title: 'plain', description: 'plain', tier: 'bronze', icon: 'trophy', current: 0, target: 1, unlockedAt: null };
}

test('every server achievement has a carved title and description', () => {
  for (const def of ACHIEVEMENTS) {
    const carved = grimAchievement(badge(def.id));
    assert.notEqual(carved.title, 'plain', `${def.id} has no grim title`);
    assert.notEqual(carved.description, 'plain', `${def.id} has no grim description`);
    assert.equal(carved.id, def.id); // the id is what unlock state keys on
  }
});

test('every level title has a rank', () => {
  const titles = new Set(Array.from({ length: 60 }, (_, level) => titleFor(level + 1)));
  assert.ok(titles.size >= 8, 'the server should hand out several titles across 60 levels');
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
