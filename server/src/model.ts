import type { XValue } from './xmlrpc';

export type TorrentStatus =
  | 'downloading'
  | 'seeding'
  | 'paused'
  | 'stopped'
  | 'checking'
  | 'error';

export interface Torrent {
  hash: string;
  name: string;
  status: TorrentStatus;
  progress: number;
  size: number;
  completed: number;
  left: number;
  downRate: number;
  upRate: number;
  downTotal: number;
  upTotal: number;
  ratio: number;
  eta: number | null;
  priority: number;
  label: string;
  message: string;
  directory: string;
  basePath: string;
  throttle: string;
  isOpen: boolean;
  isActive: boolean;
  isPrivate: boolean;
  isMultiFile: boolean;
  hashing: number;
  chunkSize: number;
  chunksDone: number;
  chunksTotal: number;
  peersConnected: number;
  peersNotConnected: number;
  peersComplete: number;
  seedersConnected: number;
  trackerCount: number;
  addedAt: number;
  startedAt: number;
  finishedAt: number;
  createdAt: number;
  tracker: string;
}

export const TORRENT_FIELDS = [
  'd.hash',
  'd.name',
  'd.size_bytes',
  'd.completed_bytes',
  'd.left_bytes',
  'd.down.rate',
  'd.up.rate',
  'd.down.total',
  'd.up.total',
  'd.ratio',
  'd.is_open',
  'd.is_active',
  'd.is_private',
  'd.is_multi_file',
  'd.complete',
  'd.hashing',
  'd.hashing_failed',
  'd.message',
  'd.priority',
  'd.directory',
  'd.base_path',
  'd.custom1',
  'd.throttle_name',
  'd.chunk_size',
  'd.completed_chunks',
  'd.size_chunks',
  'd.peers_connected',
  'd.peers_not_connected',
  'd.peers_complete',
  'd.peers_accounted',
  'd.tracker_size',
  'd.timestamp.started',
  'd.timestamp.finished',
  'd.creation_date',
  'd.state',
] as const;

type Row = Record<string, XValue>;

function int(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (value === undefined || value === null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'object') return '';
  return String(value);
}

/** rtorrent reports a tracker "message" for transient announce failures too. */
function isRealError(message: string, hashingFailed: number): boolean {
  if (hashingFailed) return true;
  if (!message) return false;
  return !/^Tracker:/i.test(message);
}

export function mapTorrent(row: Row, addedAt: number, tracker: string): Torrent {
  const size = int(row, 'd.size_bytes');
  const completed = int(row, 'd.completed_bytes');
  const left = int(row, 'd.left_bytes');
  const downRate = int(row, 'd.down.rate');
  const isOpen = int(row, 'd.is_open') !== 0;
  const isActive = int(row, 'd.is_active') !== 0;
  const complete = int(row, 'd.complete') !== 0;
  const hashing = int(row, 'd.hashing');
  const message = text(row, 'd.message');
  const hashingFailed = int(row, 'd.hashing_failed');

  let status: TorrentStatus;
  if (isRealError(message, hashingFailed)) status = 'error';
  else if (hashing > 0) status = 'checking';
  else if (!isOpen) status = 'stopped';
  else if (!isActive) status = 'paused';
  else if (complete) status = 'seeding';
  else status = 'downloading';

  const eta =
    !complete && downRate > 0 && left > 0 ? Math.round(left / downRate) : complete ? 0 : null;

  return {
    hash: text(row, 'd.hash'),
    name: text(row, 'd.name'),
    status,
    progress: size > 0 ? Math.min(1, completed / size) : 0,
    size,
    completed,
    left,
    downRate,
    upRate: int(row, 'd.up.rate'),
    downTotal: int(row, 'd.down.total'),
    upTotal: int(row, 'd.up.total'),
    ratio: int(row, 'd.ratio') / 1000,
    eta,
    priority: int(row, 'd.priority'),
    label: decodeURIComponent(text(row, 'd.custom1') || ''),
    message,
    directory: text(row, 'd.directory'),
    basePath: text(row, 'd.base_path'),
    throttle: text(row, 'd.throttle_name'),
    isOpen,
    isActive,
    isPrivate: int(row, 'd.is_private') !== 0,
    isMultiFile: int(row, 'd.is_multi_file') !== 0,
    hashing,
    chunkSize: int(row, 'd.chunk_size'),
    chunksDone: int(row, 'd.completed_chunks'),
    chunksTotal: int(row, 'd.size_chunks'),
    peersConnected: int(row, 'd.peers_connected'),
    peersNotConnected: int(row, 'd.peers_not_connected'),
    peersComplete: int(row, 'd.peers_complete'),
    seedersConnected: int(row, 'd.peers_complete'),
    trackerCount: int(row, 'd.tracker_size'),
    addedAt,
    startedAt: int(row, 'd.timestamp.started'),
    finishedAt: int(row, 'd.timestamp.finished'),
    createdAt: int(row, 'd.creation_date'),
    tracker,
  };
}

/* ------------------------------ sub-resources ---------------------------- */

export const FILE_FIELDS = [
  'f.path',
  'f.size_bytes',
  'f.completed_chunks',
  'f.size_chunks',
  'f.priority',
  'f.is_created',
  'f.offset',
] as const;

export interface TorrentFile {
  index: number;
  path: string;
  size: number;
  completedChunks: number;
  sizeChunks: number;
  priority: number;
  progress: number;
  created: boolean;
}

export function mapFile(row: Row, index: number): TorrentFile {
  const sizeChunks = int(row, 'f.size_chunks');
  const done = int(row, 'f.completed_chunks');
  return {
    index,
    path: text(row, 'f.path'),
    size: int(row, 'f.size_bytes'),
    completedChunks: done,
    sizeChunks,
    priority: int(row, 'f.priority'),
    progress: sizeChunks > 0 ? Math.min(1, done / sizeChunks) : 0,
    created: int(row, 'f.is_created') !== 0,
  };
}

export const PEER_FIELDS = [
  'p.id',
  'p.address',
  'p.port',
  'p.client_version',
  'p.completed_percent',
  'p.up_rate',
  'p.down_rate',
  'p.up_total',
  'p.down_total',
  'p.peer_rate',
  'p.peer_total',
  'p.is_encrypted',
  'p.is_obfuscated',
  'p.is_incoming',
  'p.is_snubbed',
  'p.is_preferred',
  'p.is_unwanted',
  'p.banned',
  'p.options_str',
] as const;

export interface Peer {
  id: string;
  address: string;
  port: number;
  client: string;
  progress: number;
  upRate: number;
  downRate: number;
  upTotal: number;
  downTotal: number;
  /** What the peer is pulling from the swarm as a whole, not from us. */
  peerRate: number;
  peerTotal: number;
  encrypted: boolean;
  obfuscated: boolean;
  incoming: boolean;
  snubbed: boolean;
  preferred: boolean;
  unwanted: boolean;
  banned: boolean;
  /** Reserved-bytes/extension string as rtorrent formats it. */
  options: string;
}

export function mapPeer(row: Row): Peer {
  return {
    id: text(row, 'p.id'),
    address: text(row, 'p.address'),
    port: int(row, 'p.port'),
    client: text(row, 'p.client_version'),
    progress: int(row, 'p.completed_percent') / 100,
    upRate: int(row, 'p.up_rate'),
    downRate: int(row, 'p.down_rate'),
    upTotal: int(row, 'p.up_total'),
    downTotal: int(row, 'p.down_total'),
    peerRate: int(row, 'p.peer_rate'),
    peerTotal: int(row, 'p.peer_total'),
    encrypted: int(row, 'p.is_encrypted') !== 0,
    obfuscated: int(row, 'p.is_obfuscated') !== 0,
    incoming: int(row, 'p.is_incoming') !== 0,
    snubbed: int(row, 'p.is_snubbed') !== 0,
    preferred: int(row, 'p.is_preferred') !== 0,
    unwanted: int(row, 'p.is_unwanted') !== 0,
    banned: int(row, 'p.banned') !== 0,
    options: text(row, 'p.options_str'),
  };
}

export const TRACKER_FIELDS = [
  't.url',
  't.type',
  't.group',
  't.id',
  't.is_enabled',
  't.is_usable',
  't.is_open',
  't.is_busy',
  't.is_extra_tracker',
  't.can_scrape',
  't.scrape_complete',
  't.scrape_incomplete',
  't.scrape_downloaded',
  't.scrape_time_last',
  't.scrape_counter',
  't.success_counter',
  't.success_time_last',
  't.success_time_next',
  't.failed_counter',
  't.failed_time_last',
  't.failed_time_next',
  't.latest_event',
  't.latest_new_peers',
  't.latest_sum_peers',
  't.normal_interval',
  't.min_interval',
  't.activity_time_last',
  't.activity_time_next',
] as const;

export interface Tracker {
  index: number;
  url: string;
  type: number;
  group: number;
  trackerId: string;
  enabled: boolean;
  usable: boolean;
  open: boolean;
  busy: boolean;
  extra: boolean;
  canScrape: boolean;
  seeders: number;
  leechers: number;
  downloaded: number;
  lastScrape: number;
  scrapes: number;
  successes: number;
  lastSuccess: number;
  nextSuccess: number;
  failures: number;
  lastFailure: number;
  nextFailure: number;
  latestEvent: number;
  newPeers: number;
  sumPeers: number;
  interval: number;
  minInterval: number;
  lastActivity: number;
  nextActivity: number;
}

export function mapTracker(row: Row, index: number): Tracker {
  return {
    index,
    url: text(row, 't.url'),
    type: int(row, 't.type'),
    group: int(row, 't.group'),
    trackerId: text(row, 't.id'),
    enabled: int(row, 't.is_enabled') !== 0,
    usable: int(row, 't.is_usable') !== 0,
    open: int(row, 't.is_open') !== 0,
    busy: int(row, 't.is_busy') !== 0,
    extra: int(row, 't.is_extra_tracker') !== 0,
    canScrape: int(row, 't.can_scrape') !== 0,
    seeders: int(row, 't.scrape_complete'),
    leechers: int(row, 't.scrape_incomplete'),
    downloaded: int(row, 't.scrape_downloaded'),
    lastScrape: int(row, 't.scrape_time_last'),
    scrapes: int(row, 't.scrape_counter'),
    successes: int(row, 't.success_counter'),
    lastSuccess: int(row, 't.success_time_last'),
    nextSuccess: int(row, 't.success_time_next'),
    failures: int(row, 't.failed_counter'),
    lastFailure: int(row, 't.failed_time_last'),
    nextFailure: int(row, 't.failed_time_next'),
    latestEvent: int(row, 't.latest_event'),
    newPeers: int(row, 't.latest_new_peers'),
    sumPeers: int(row, 't.latest_sum_peers'),
    interval: int(row, 't.normal_interval'),
    minInterval: int(row, 't.min_interval'),
    lastActivity: int(row, 't.activity_time_last'),
    nextActivity: int(row, 't.activity_time_next'),
  };
}

export function trackerHost(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host || 'unknown';
  } catch {
    return 'unknown';
  }
}
