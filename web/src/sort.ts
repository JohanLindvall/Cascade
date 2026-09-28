/**
 * How the torrent list is ordered. Lifted out of TorrentTable so the node
 * test runner can reach it — the component pulls in React, which the runner
 * cannot load, and a wrong sort here is rows that jump on every poll rather
 * than anything a typecheck would catch.
 */
import type { Torrent } from './types';

import type { SortKey, SortDir } from './preferences.ts';
export { SORT_KEYS, isSortKey, type SortKey, type SortDir } from './preferences.ts';

export interface SortState {
  key: SortKey;
  dir: SortDir;
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

/**
 * Every name's place in natural order. The list is re-sorted on every update
 * of the state — ten times a second at the fastest interval — while the names
 * in it almost never change, and on most columns most rows tie and fall back
 * to their names: the collator ran thousands of times per sort. Ranked once,
 * a tie is a comparison of two numbers until a name comes or goes.
 */
let rankedNames: readonly string[] = [];
let nameRanks = new Map<string, number>();

function rankNames(torrents: readonly Torrent[]): Map<string, number> {
  const same = torrents.length === rankedNames.length &&
    torrents.every((torrent, index) => torrent.name === rankedNames[index]);
  if (!same) {
    rankedNames = torrents.map((torrent) => torrent.name);
    nameRanks = new Map();
    // Names the collator calls equal ("Movie" and "movie", "Episode 07" and
    // "Episode 7") share a rank, so the hash settles them. Ranked apart, their
    // order would be the stable sort's — whichever the server listed first —
    // and would flip with the direction of the name column.
    let rank = -1;
    let previous: string | undefined;
    for (const name of [...new Set(rankedNames)].sort(collator.compare)) {
      if (previous === undefined || collator.compare(previous, name) !== 0) rank += 1;
      nameRanks.set(name, rank);
      previous = name;
    }
  }
  return nameRanks;
}

function sortValue(torrent: Torrent, key: SortKey, ranks: Map<string, number>): number | string {
  switch (key) {
    case 'name':
      return ranks.get(torrent.name) ?? 0;
    case 'label':
      return torrent.label;
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
  const ranks = rankNames(torrents);
  // Each row's value is read once rather than in every comparison.
  const rows = torrents.map((torrent) => ({
    torrent,
    value: sortValue(torrent, sort.key, ranks),
    name: ranks.get(torrent.name) ?? 0,
  }));
  rows.sort(
    (a, b) =>
      compare(a.value, b.value) * factor ||
      a.name - b.name ||
      // Plain code-unit order: the collator's numeric mode can call "07" and
      // "7" equal, and the last resort has to tell every pair apart.
      (a.torrent.hash < b.torrent.hash ? -1 : a.torrent.hash > b.torrent.hash ? 1 : 0),
  );
  return rows.map((row) => row.torrent);
}
