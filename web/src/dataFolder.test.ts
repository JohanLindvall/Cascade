// SPDX-License-Identifier: MIT

/**
 * "Change directory" offers the directory a torrent's data goes into, as the
 * Add dialog names it. It used to offer d.directory, a multi-file torrent's
 * own folder, which sent back as it was moved the torrent to "X/X".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dataFolder, sharedDataFolder } from './dataFolder.ts';
import type { Torrent } from './types';

const torrent = (hash: string, name: string, directory: string, isMultiFile: boolean) =>
  ({ hash, name, directory, isMultiFile }) as Torrent;

test('a single file goes into its directory, a multi-file torrent\'s folder into the one above it', () => {
  assert.equal(dataFolder(torrent('a', 'film.mkv', '/downloads', false)), '/downloads');
  assert.equal(dataFolder(torrent('b', 'Show S01', '/downloads/Show S01', true)), '/downloads');
  assert.equal(dataFolder(torrent('c', 'Show S01', '/Show S01', true)), '/');
});

test('the folder\'s own name plays no part: one named otherwise, or shortened to fit', () => {
  assert.equal(dataFolder(torrent('a', 'Show S01', '/media/tv/Season One', true)), '/media/tv');
  assert.equal(dataFolder(torrent('b', 'x'.repeat(300), `/downloads/${'x'.repeat(246)}~1a2b3c4d`, true)), '/downloads');
});

test('the directory above a folder is read without the slashes d.directory.set may leave before it', () => {
  // Given "/d//", d.directory.set appends the name after both slashes.
  assert.equal(dataFolder(torrent('a', 'Show', '/d//Show', true)), '/d');
  assert.equal(dataFolder(torrent('b', 'Show', '//Show', true)), '/');
  // So the selection shares one directory with a file rtorrent keeps at "/d".
  const byHash = new Map([
    ['multi', torrent('multi', 'Show', '/d//Show', true)],
    ['single', torrent('single', 'film.mkv', '/d', false)],
  ]);
  assert.equal(sharedDataFolder(byHash, ['multi', 'single']), '/d');
});

test('nothing to offer where rtorrent names no directory', () => {
  assert.equal(dataFolder(torrent('a', 'Show S01', '', true)), '');
  assert.equal(dataFolder(torrent('b', 'Show S01', '.', true)), '');
  assert.equal(dataFolder(torrent('c', 'film.mkv', '', false)), '');
});

test('a selection offers the directory its torrents\' data shares, single and multi-file alike', () => {
  const byHash = new Map([
    ['single', torrent('single', 'film.mkv', '/downloads', false)],
    ['multi', torrent('multi', 'Show S01', '/downloads/Show S01', true)],
    ['renamed', torrent('renamed', 'Show S02', '/downloads/Season Two', true)],
    ['elsewhere', torrent('elsewhere', 'Show S03', '/media/tv/Show S03', true)],
  ]);
  assert.equal(sharedDataFolder(byHash, ['single', 'multi', 'renamed']), '/downloads');
  assert.equal(sharedDataFolder(byHash, ['multi', 'elsewhere']), '');
  assert.equal(sharedDataFolder(byHash, ['elsewhere']), '/media/tv');
  assert.equal(sharedDataFolder(byHash, ['single', 'gone']), '');
  assert.equal(sharedDataFolder(byHash, []), '');
});
