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
  trackerCount: number;
  addedAt: number;
  startedAt: number;
  finishedAt: number;
  createdAt: number;
}

export interface BackendSummary {
  clientVersion: string;
  libraryVersion: string;
  apiVersion: string;
  flavor: string;
  methodCount: number;
  rpcFacility: string;
  endpoint: string;
  supports: Record<string, boolean>;
}

export interface RateSample {
  t: number;
  down: number;
  up: number;
}

export interface GlobalStatus {
  connected: boolean;
  error?: string;
  downRate: number;
  upRate: number;
  downTotal: number;
  upTotal: number;
  downLimit: number;
  upLimit: number;
  torrentCount: number;
  activeCount: number;
  dhtNodes: number;
  listenPort: number;
  /** Free bytes on the download volume; null when the server cannot tell. */
  diskFree: number | null;
  backend: BackendSummary;
  history: RateSample[];
}

export interface ThrottleGroup {
  name: string;
  up: number;
  down: number;
}

export type Tier = 'bronze' | 'silver' | 'gold';

export interface Achievement {
  id: string;
  title: string;
  description: string;
  tier: Tier;
  icon: string;
  current: number;
  target: number;
  unlockedAt: number | null;
}

export interface GameStats {
  lifetimeUp: number;
  lifetimeDown: number;
  completed: number;
  everAdded: number;
  peakDownRate: number;
  peakUpRate: number;
  peakPeers: number;
  bestRatio: number;
  longestSeed: number;
  maxSeeding: number;
  maxLabels: number;
}

export interface GameState {
  enabled: boolean;
  xp: number;
  level: number;
  title: string;
  levelXp: number;
  nextLevelXp: number;
  progress: number;
  stats: GameStats;
  unlocked: number;
  total: number;
  achievements: Achievement[];
}

export interface StateResponse {
  status: GlobalStatus;
  torrents: Torrent[];
  throttles: ThrottleGroup[];
  game: GameState;
}

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
  peerRate: number;
  peerTotal: number;
  encrypted: boolean;
  obfuscated: boolean;
  incoming: boolean;
  snubbed: boolean;
  preferred: boolean;
  unwanted: boolean;
  banned: boolean;
  options: string;
}

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

/** Mirrors the server's GlobalSettings; everything is optional because the
 *  backend only reports what this rtorrent build implements. */
export interface Settings {
  downloadRate?: number;
  uploadRate?: number;
  maxUploads?: number;
  minUploads?: number;
  maxDownloads?: number;
  minDownloads?: number;
  maxUploadsGlobal?: number;
  maxDownloadsGlobal?: number;
  maxUploadsDiv?: number;
  maxDownloadsDiv?: number;
  maxPeers?: number;
  minPeers?: number;
  maxPeersSeed?: number;
  minPeersSeed?: number;
  maxOpenFiles?: number;
  maxOpenSockets?: number;
  maxHttpOpen?: number;
  httpMaxHostConnections?: number;
  dnsCacheTimeout?: number;
  memoryMax?: number;
  syncTimeout?: number;
  preloadType?: number;
  preloadMinSize?: number;
  preloadMinRate?: number;
  portRange?: string;
  portRandom?: boolean;
  portOpen?: boolean;
  dhtMode?: string;
  dhtPort?: number;
  dhtOverridePort?: number;
  pex?: boolean;
  udpTrackers?: boolean;
  trackersNumwant?: number;
  encryption?: string;
  preallocate?: boolean;
  checkHashOnCompletion?: boolean;
  adviseRandomHashing?: boolean;
  directory?: string;
  sessionDirectory?: string;
  bindAddress?: string;
  bindAddressV4?: string;
  bindAddressV6?: string;
  localAddress?: string;
  proxyAddress?: string;
  proxyHttp?: string;
  proxyGlobal?: string;
  httpCapath?: string;
  httpCacert?: string;
  sslVerifyPeer?: boolean;
  sslVerifyHost?: boolean;
  xmlrpcSizeLimit?: number;
  receiveBuffer?: number;
  sendBuffer?: number;
  maxFileSize?: number;
  blockOutgoing?: boolean;
}
