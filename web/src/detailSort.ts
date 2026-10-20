// SPDX-License-Identifier: MIT

import { fileName } from './format.ts';
import { redactUrl } from './redact.ts';
import { peerFlags, trackerFlags, type Flag } from './components/detail/flags.ts';
import type { SortColumn } from './tableSort.ts';
import type { Peer, ThrottleGroup, TorrentFile, Tracker } from './types.ts';

const flagText = (flags: Flag[]): string => flags.map(({ label }) => label).join(' ');
/** Shared with the cell so the type's name, rather than its enum value, determines the order. */
const TRACKER_TYPES: Record<number, string> = { 1: 'HTTP', 2: 'UDP', 3: 'DHT' };
export const trackerType = (tracker: Tracker): string => TRACKER_TYPES[tracker.type] ?? `type ${tracker.type}`;

export const peerIdentity = (peer: Peer): string => `${peer.address}:${peer.port}`;
export const fileIdentity = (file: TorrentFile): number => file.index;
export const trackerIdentity = (tracker: Tracker): number => tracker.index;
export const throttleIdentity = (group: ThrottleGroup): string => group.name;

export const PEER_COLUMNS = {
  address: { label: 'Address', value: (p) => [p.address, p.port], dir: 'asc', className: 'col-address' },
  client: { label: 'Client', value: (p) => p.client, dir: 'asc' },
  progress: { label: 'Progress', value: (p) => p.progress, dir: 'desc', className: 'col-progress' },
  downRate: { label: 'Down', value: (p) => p.downRate, dir: 'desc', className: 'right col-down' },
  upRate: { label: 'Up', value: (p) => p.upRate, dir: 'desc', className: 'right col-up' },
  peerRate: {
    label: 'Swarm', value: (p) => p.peerRate, dir: 'desc', className: 'right col-swarm',
    title: 'What this peer is pulling from the swarm',
  },
  downTotal: { label: 'Downloaded', value: (p) => p.downTotal, dir: 'desc', className: 'right col-down-total' },
  upTotal: { label: 'Uploaded', value: (p) => p.upTotal, dir: 'desc', className: 'right col-up-total' },
  flags: { label: 'Flags', value: (p) => flagText(peerFlags(p)), dir: 'asc', className: 'col-flags' },
} satisfies Record<string, SortColumn<Peer>>;

export const FILE_COLUMNS = {
  path: { label: 'File', value: (f) => [fileName(f.path), f.path], dir: 'asc' },
  size: { label: 'Size', value: (f) => f.size, dir: 'desc', className: 'right col-size' },
  progress: { label: 'Progress', value: (f) => f.progress, dir: 'desc', className: 'col-progress' },
  priority: { label: 'Priority', value: (f) => f.priority, dir: 'desc', className: 'col-priority' },
} satisfies Record<string, SortColumn<TorrentFile>>;

export const TRACKER_COLUMNS = {
  url: { label: 'URL', value: (t) => redactUrl(t.url), dir: 'asc' },
  type: { label: 'Type', value: trackerType, dir: 'asc', className: 'col-type' },
  state: { label: 'State', value: (t) => flagText(trackerFlags(t)), dir: 'asc', className: 'col-state' },
  seeders: { label: 'Seeders', value: (t) => t.seeders, dir: 'desc', className: 'right col-seeders' },
  leechers: { label: 'Leechers', value: (t) => t.leechers, dir: 'desc', className: 'right col-leechers' },
  downloaded: { label: 'Downloaded', value: (t) => t.downloaded, dir: 'desc', className: 'right col-downloaded' },
  peers: {
    label: 'Peers', value: (t) => [t.sumPeers, t.newPeers], dir: 'desc', className: 'right col-peers',
    title: 'Peers returned by the last announce; ties sort by new peers',
  },
  nextActivity: {
    label: 'Next announce', value: (t) => t.nextActivity > 0 ? t.nextActivity : null,
    dir: 'asc', className: 'col-next',
  },
  attempts: {
    label: 'OK / fail', value: (t) => [t.successes, t.failures], dir: 'desc', className: 'right col-attempts',
    title: 'Successful announces, then failed announces',
  },
  enabled: { label: 'Enabled', value: (t) => Number(t.enabled), dir: 'desc', className: 'col-enabled' },
} satisfies Record<string, SortColumn<Tracker>>;

export interface ThrottleRow extends ThrottleGroup {
  downRate: number;
  upRate: number;
}

export const THROTTLE_COLUMNS = {
  name: { label: 'Group', value: (g) => g.name, dir: 'asc' },
  down: { label: 'Download limit', value: (g) => g.down || Infinity, dir: 'desc', className: 'col-limit' },
  up: { label: 'Upload limit', value: (g) => g.up || Infinity, dir: 'desc', className: 'col-limit' },
  downRate: { label: 'Current down', value: (g) => g.downRate, dir: 'desc', className: 'right' },
  upRate: { label: 'Current up', value: (g) => g.upRate, dir: 'desc', className: 'right' },
} satisfies Record<string, SortColumn<ThrottleRow>>;
