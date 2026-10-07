// SPDX-License-Identifier: MIT

/**
 * "Change directory" starts from the directory the selection's data goes
 * into (sharedDataFolder, tested in dataFolder.test.ts), never from
 * d.directory: for a multi-file torrent that is its own folder, and the
 * server moves a torrent handed its own folder into it, as asked, so the
 * pre-fill confirmed unchanged used to move the torrent to "X/X".
 *
 * The hook imports .tsx modules, which the node runner cannot load, so this
 * reads its source for the line the fix rests on — as detail/tabs.test.ts
 * does for the detail tabs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('./useTorrentActions.ts', import.meta.url), 'utf8');

/** The promptDirectory callback, from its declaration to the end of its useCallback, without comments. */
function promptDirectory(): string {
  const callback = /const promptDirectory = useCallback\(([\s\S]*?)\n {2}\);\n/.exec(source);
  assert.ok(callback, 'no promptDirectory useCallback in useTorrentActions.ts');
  return callback[1].replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

test('"Change directory" is pre-filled with the directory the data goes into', () => {
  assert.match(promptDirectory(), /\binitial: sharedDataFolder\(byHash, moving\),/);
});

test('and reads no torrent\'s directory for it', () => {
  // `torrent.directory`, `t.directory` or `({ directory }) =>`: d.directory, a multi-file torrent's own folder.
  assert.doesNotMatch(promptDirectory(), /\.directory\b|\{\s*directory\s*\}\s*\)\s*=>/);
});

test('a magnet still fetching its metadata is left out, in the server\'s words', () => {
  // rtorrent loads it anew, with the add's directory, once the metadata
  // arrives; the server refuses the change with FETCHING_METADATA (a 409).
  const source = promptDirectory();
  assert.match(source, /const moving = hashes\.filter\(\(hash\) => !byHash\.get\(hash\)\?\.isMeta\);/);
  assert.match(source, /`\$\{name\}: \$\{FETCHING_METADATA\}`/);
  assert.match(source, /items: names\(moving\),/);
  assert.match(source, /await patch\(\{ directory: directory\.trim\(\) \}, moving\);/);
});
