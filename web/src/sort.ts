/**
 * How the torrent list is ordered. Lifted out of TorrentTable so the node
 * test runner can reach it — the component pulls in React, which the runner
 * cannot load, and a wrong sort here is rows that jump on every poll rather
 * than anything a typecheck would catch.
 */
import type { Torrent } from './types';

/** Keep in step with SORT_KEYS in the server's prefs.ts, which validates the stored preference. */
export const SORT_KEYS = [
  'name',
  'size',
  'progress',
  'status',
  'downRate',
  'upRate',
  'ratio',
  'eta',
  'peers',
  'addedAt',
  'label',
] as const;

export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export function isSortKey(value: unknown): value is SortKey {
  return (SORT_KEYS as readonly unknown[]).includes(value);
}

/** Text columns open A→Z; everything numeric opens with the largest first. */
export function defaultSortDir(key: SortKey): SortDir {
  return key === 'name' || key === 'label' ? 'asc' : 'desc';
}

/** Sorting by status should follow the lifecycle, not the alphabet. */
const STATUS_RANK: Record<Torrent['status'], number> = {
  downloading: 0,
  seeding: 1,
  checking: 2,
  paused: 3,
  stopped: 4,
  error: 5,
};

/**
 * Natural, case-insensitive text order: "Episode 2" before "Episode 10",
 * "alpha" beside "Alpha". One collator for every comparison — building the
 * options for each localeCompare call is what makes sorting a big list slow.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortValue(torrent: Torrent, key: SortKey): number | string {
  switch (key) {
    case 'name':
    case 'label':
      return torrent[key];
    case 'status':
      return STATUS_RANK[torrent.status];
    case 'peers':
      return torrent.peersConnected;
    case 'eta':
      return torrent.eta === null ? Number.MAX_SAFE_INTEGER : torrent.eta;
    default:
      return torrent[key];
  }
}

function compare(left: number | string, right: number | string): number {
  return typeof left === 'string' || typeof right === 'string'
    ? collator.compare(String(left), String(right))
    : left - right;
}

/**
 * The list in the requested order. Ties fall back to the name and then the
 * hash, ascending whichever way the column runs, so rows that share a value
 * (every stopped torrent under "status", every idle one under "down") keep a
 * fixed order instead of depending on how the server happened to list them.
 */
export function sortTorrents(torrents: Torrent[], sort: SortState): Torrent[] {
  const factor = sort.dir === 'asc' ? 1 : -1;
  return [...torrents].sort(
    (a, b) =>
      compare(sortValue(a, sort.key), sortValue(b, sort.key)) * factor ||
      collator.compare(a.name, b.name) ||
      // Plain code-unit order: the collator's numeric mode can call "07" and
      // "7" equal, and the last resort has to tell every pair apart.
      (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0),
  );
}
