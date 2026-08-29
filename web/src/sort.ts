/**
 * How the torrent list is ordered. Lifted out of TorrentTable so the node
 * test runner can reach it — the component pulls in React, which the runner
 * cannot load, and a wrong sort here is rows that jump on every poll rather
 * than anything a typecheck would catch.
 */
import type { Torrent } from './types';

export type SortKey =
  | 'name'
  | 'size'
  | 'progress'
  | 'status'
  | 'downRate'
  | 'upRate'
  | 'ratio'
  | 'eta'
  | 'peers'
  | 'addedAt'
  | 'label';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
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

function sortValue(torrent: Torrent, key: SortKey): number | string {
  switch (key) {
    case 'name':
      return torrent.name.toLowerCase();
    case 'label':
      return torrent.label.toLowerCase();
    case 'status':
      return STATUS_RANK[torrent.status];
    case 'peers':
      return torrent.peersConnected;
    case 'eta':
      return torrent.eta === null ? Number.MAX_SAFE_INTEGER : torrent.eta;
    default:
      return torrent[key] as number;
  }
}

export function sortTorrents(torrents: Torrent[], sort: SortState): Torrent[] {
  const factor = sort.dir === 'asc' ? 1 : -1;
  return [...torrents].sort((a, b) => {
    const left = sortValue(a, sort.key);
    const right = sortValue(b, sort.key);
    if (typeof left === 'string' || typeof right === 'string') {
      return String(left).localeCompare(String(right)) * factor;
    }
    return (left - right) * factor;
  });
}
