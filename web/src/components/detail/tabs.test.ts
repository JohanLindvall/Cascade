// SPDX-License-Identifier: MIT

/**
 * The fetched detail tabs are memoized, and the panel hands them props that
 * keep their identity. The app redraws on every stream delta — at least once
 * a second while idle — and a tab drawn along with it reconciled every one of
 * its rows each time: an 8000-file torrent's Files tab stalled the page for
 * about 200 ms per delta, though its rows change only on the tab's own poll.
 *
 * The node runner strips types but does not compile JSX, so it cannot render
 * a component; this reads the source for the two things the fix rests on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const source = (path: string) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const TABS = ['FilesTab', 'PeersTab', 'TrackersTab'];

test('the fetched tabs are memoized', () => {
  for (const tab of TABS) {
    assert.match(source(`./${tab}.tsx`), new RegExp(`export const ${tab} = memo\\(function ${tab}\\(`), tab);
  }
});

test('the panel hands them no function made during its render', () => {
  const panel = source('../DetailPanel.tsx');
  const uses = [...panel.matchAll(/<(FilesTab|PeersTab|TrackersTab)\b([\s\S]*?)\/>/g)];
  assert.deepEqual(uses.map(([, tab]) => tab).sort(), [...TABS].sort());
  for (const [, tab, props] of uses) {
    // `name={(…) => …}` or `name={x => …}`: a new function, so a new prop, every render.
    assert.doesNotMatch(props, /=\{\s*(\([^)]*\)|\w+)\s*=>/, `${tab} is handed an inline function`);
  }
});

test('the trackers tab still counts its announce times down between polls', () => {
  // Memoized, it would otherwise redraw only when the next poll replaced its rows.
  assert.match(source('./TrackersTab.tsx'), /\buseClock\(\)/);
});
