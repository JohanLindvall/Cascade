// SPDX-License-Identifier: MIT

/**
 * An expanded peer or tracker row's block (MiniKv) sits in a cell that spans
 * the whole table, 1000px at least: wider than the detail pane on a phone and
 * on a desktop window below about 1280px. Sized to that cell, the block had
 * its later columns off-screen, and a peer ID ended in an ellipsis. The node
 * runner has no layout to check the fix against (it was measured in a
 * browser), so this reads the stylesheet for the rules it rests on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const css = fs.readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

/** The declarations of the top-level rule with exactly this selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(css);
  assert.ok(match, `no top-level rule for ${selector}`);
  return match[1];
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
