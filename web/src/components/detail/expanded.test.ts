// SPDX-License-Identifier: MIT

/**
 * An expanded peer or tracker row's block (MiniKv) sits in a cell that spans
 * the whole table, 1000px at least: wider than the detail pane on a phone and
 * on a desktop window below about 1280px. Sized to that cell, the block had
 * its later columns off-screen, and a peer ID ended in an ellipsis. The node
 * runner has no layout to check the fix against (it was measured in a
 * browser), so this reads the stylesheet for the rules it rests on, and
 * counts the letters a value that changes with the polls may take.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { announcePeers, bytes, duration, rate, relative, until } from '../../format.ts';

const css = fs.readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
const source = (path: string) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

/** The declarations of the top-level rule with exactly this selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(css);
  assert.ok(match, `no top-level rule for ${selector}`);
  return match[1];
}

/** The first length in px a declaration of that rule holds. */
function px(selector: string, property: string): number {
  const match = new RegExp(`(?:^|[;\\s])${property}:[^;]*?(\\d+(?:\\.\\d+)?)px`).exec(rule(selector));
  assert.ok(match, `${selector} has no ${property} in px`);
  return Number(match[1]);
}

test('the block is as wide as the pane on screen, and stays there while the table scrolls', () => {
  // The scroll container is what 100cqw measures.
  assert.match(rule('.detail-body'), /container-type:\s*inline-size/);
  const block = rule('.mini-kv');
  assert.match(block, /max-width:\s*calc\(100cqw\b/);
  assert.match(block, /position:\s*sticky/);
});

test('its values wrap rather than end in an ellipsis', () => {
  const value = rule('.mini-kv b');
  // The table's cells do not wrap, which the value would otherwise inherit.
  assert.match(value, /white-space:\s*normal/);
  assert.match(value, /overflow-wrap:\s*anywhere/);
  for (const match of css.matchAll(/([^{}]*\.mini-kv[^{}]*)\{([^}]*)\}/g)) {
    assert.doesNotMatch(match[2], /text-overflow/, match[1].trim());
  }
});

test('a value that changes with the polls fits beside its key without wrapping', () => {
  // Wrapped, it would give its block a line and take it away again with a
  // later poll, and every row below would jump with it. The narrowest column
  // is the grid's minimum. Retro draws the widest letters, its keys in the
  // mono font as well and every letter spaced 0.02em apart: "Peers last
  // announce" measured 136.5px in Firefox, 7.18px a letter at the block's
  // 11.5px, rounded up here. A change of size needs measuring again.
  const letter = 7.2;
  assert.equal(px('.mini-kv span', 'font-size'), 11.5);
  assert.equal(px('.mini-kv b', 'font-size'), 11.5);
  assert.match(rule(":root[data-theme='retro']"), /--sans:\s*var\(--mono\)/);
  const column = px('.mini-kv', 'grid-template-columns');
  const room = column - px('.mini-kv > div', 'gap');

  // Each at its longest: a time or a countdown under a year, a rate or a
  // size a hair short of the next unit, and four digits each of the peers an
  // announce brought, which are tens or hundreds.
  const now = Date.now() / 1000;
  const year = 364 * 86_400 + 23 * 3_600 + 59 * 60;
  const [ago, ahead, span] = [relative(now - year), until(now + year + 30), duration(year)];
  assert.deepEqual([ago, ahead, span], ['364d 23h ago', 'in 364d 23h', '364d 23h']);
  const pairs: Array<[tab: 'Trackers' | 'Peers', key: string, value: string]> = [
    ['Trackers', 'Latest event', 'completed'],
    ['Trackers', 'Last announce', ago],
    ['Trackers', 'Next announce', ahead],
    ['Trackers', 'Last success', ago],
    ['Trackers', 'Next success', ahead],
    ['Trackers', 'Last failure', ago],
    ['Trackers', 'Next retry', ahead],
    ['Trackers', 'Announce interval', span],
    ['Trackers', 'Min interval', span],
    ['Trackers', 'Peers last announce', announcePeers(9999, 9999)],
    ['Trackers', 'Scrapes', String(99_999_999)],
    ['Trackers', 'Last scrape', ago],
    ['Trackers', 'Usable', 'yes'],
    ['Trackers', 'Announcing', 'yes'],
    ['Trackers', 'Connection open', 'yes'],
    ['Trackers', 'Added at runtime', 'yes'],
    ['Peers', 'Preferred', 'yes'],
    ['Peers', 'Snubbed', 'yes'],
    ['Peers', 'Unwanted', 'yes'],
    ['Peers', 'Banned', 'yes'],
    ['Peers', 'Swarm rate', rate(1023.6 * 1024)],
    ['Peers', 'Swarm total', bytes(1023.6 * 1024 ** 3)],
  ];
  for (const [tab, key, value] of pairs) {
    assert.ok(source(`./${tab}Tab.tsx`).includes(`['${key}', `), `the ${tab} tab's block has no ${key}`);
    const width = (key.length + value.length) * letter;
    assert.ok(width <= room, `"${key}" and "${value}": ${width.toFixed(1)}px, in ${room}px of a ${column}px column`);
  }
  // The count above is this helper's, not a figure written out in the tab.
  assert.match(source('./TrackersTab.tsx'), /\['Peers last announce', announcePeers\(/);
});
