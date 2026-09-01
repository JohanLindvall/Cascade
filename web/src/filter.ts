/**
 * Which torrents the list shows: the sidebar's status/label/tracker filter
 * and the search box, plus the counts the sidebar prints beside each status.
 * Pure, so the node test runner can reach it; the components only render.
 */
import type { Torrent, TorrentStatus } from './types';

export interface Filter {
  kind: 'status' | 'label' | 'tracker';
  value: string;
}

/** A status the sidebar offers: the real ones plus two views across them. */
export type StatusFilter = 'all' | 'active' | TorrentStatus;

export const STATUS_FILTERS: readonly StatusFilter[] = [
  'all',
  'downloading',
  'seeding',
  'active',
  'paused',
  'stopped',
  'checking',
  'error',
];

export function matchesStatus(torrent: Torrent, value: string): boolean {
  if (value === 'all') return true;
  // "Active" is about traffic, not state: a seeding torrent nobody is
  // pulling from is not active, a stopped one cannot be.
  if (value === 'active') return torrent.downRate > 0 || torrent.upRate > 0;
  return torrent.status === value;
}

export function matchesFilter(
  torrent: Torrent,
  filter: Filter,
  trackerHosts: Record<string, string>,
): boolean {
  switch (filter.kind) {
    case 'status':
      return matchesStatus(torrent, filter.value);
    case 'label':
      return torrent.label === filter.value;
    case 'tracker':
      return trackerHosts[torrent.hash] === filter.value;
  }
}

/** The list after the sidebar filter and the search box, in the input order. */
export function filterTorrents(
  torrents: Torrent[],
  filter: Filter,
  search: string,
  trackerHosts: Record<string, string>,
): Torrent[] {
  const needle = search.trim().toLowerCase();
  return torrents.filter((torrent) => {
    if (!matchesFilter(torrent, filter, trackerHosts)) return false;
    if (!needle) return true;
    return torrent.name.toLowerCase().includes(needle) || torrent.hash.toLowerCase().includes(needle);
  });
}

/** How many torrents each status filter would show, in one pass over the list. */
export function countByStatus(torrents: Torrent[]): Record<StatusFilter, number> {
  const counts = Object.fromEntries(STATUS_FILTERS.map((value) => [value, 0])) as Record<
    StatusFilter,
    number
  >;
  for (const torrent of torrents) {
    counts.all += 1;
    counts[torrent.status] += 1;
    if (matchesStatus(torrent, 'active')) counts.active += 1;
  }
  return counts;
}
