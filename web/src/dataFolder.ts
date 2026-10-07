// SPDX-License-Identifier: MIT

import { sharedValue } from './sharedValue.ts';
import type { Torrent } from './types';

/**
 * The directory a torrent's data goes into — what the Add dialog's directory
 * names, and what "Change directory" offers and sends: the one a single file
 * is in, or the one holding a multi-file torrent's own folder. `directory` is
 * rtorrent's d.directory, which for a multi-file torrent is that folder
 * itself; sent back as it was, the torrent moved into a folder of its own
 * name inside it. The directory above the folder is read without trailing
 * slashes, as rtorrent keeps a directory: d.directory.set keeps the ones it
 * was given before the name it appends ("/downloads//X"). The server reads
 * the listing the same way (DataDirectory in internal/rtorrent/directory.go),
 * keeps the folder's name, and leaves a torrent whose data already goes there
 * alone.
 */
export function dataFolder(torrent: Pick<Torrent, 'directory' | 'isMultiFile'>): string {
  if (!torrent.isMultiFile) return torrent.directory;
  const cut = torrent.directory.lastIndexOf('/');
  return cut < 0 ? '' : torrent.directory.slice(0, cut).replace(/\/+$/, '') || '/';
}

/** What "Change directory" starts from: the directory the torrents' data shares, or nothing when it differs. */
export function sharedDataFolder(byHash: ReadonlyMap<string, Torrent>, hashes: readonly string[]): string {
  return sharedValue(byHash, hashes, dataFolder) ?? '';
}

/**
 * Why "Change directory" leaves a magnet alone while it fetches its metadata
 * (isMeta, rtorrent's d.is_meta): what is listed until then is a download of
 * the metadata alone, and once that is complete rtorrent loads the torrent
 * anew with the commands the add carried, so a directory set meanwhile would
 * be lost. The server refuses it with these words, a 409 (FetchingMetadata in
 * server/internal/service/torrents.go).
 */
export const FETCHING_METADATA =
  'this torrent is still fetching its metadata, and once that arrives rtorrent loads it anew into the directory it was added with — a directory changed now would be lost, so wait for the metadata, then change it';

/** What the "Change directory" prompt says of the torrents it leaves out for fetching their metadata. */
export function leftOutFetching(count: number): string {
  return count === 1
    ? 'Left out: one torrent still fetching its metadata, which rtorrent puts in the directory it was added with once that arrives.'
    : `Left out: ${count} torrents still fetching their metadata, which rtorrent puts in the directory each was added with once it arrives.`;
}
