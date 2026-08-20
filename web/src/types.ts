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

export interface BackendSummary {
  clientVersion: string;
  libraryVersion: string;
  apiVersion: string;
  flavor: string;
  methodCount: number;
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
  encrypted: boolean;
  obfuscated: boolean;
  incoming: boolean;
  snubbed: boolean;
}

export interface Tracker {
  index: number;
  url: string;
  type: number;
  group: number;
  enabled: boolean;
  usable: boolean;
  open: boolean;
  seeders: number;
  leechers: number;
  downloaded: number;
  lastScrape: number;
  successes: number;
  failures: number;
  interval: number;
  lastActivity: number;
}

export interface Settings {
  downloadRate?: number;
  uploadRate?: number;
  maxUploads?: number;
  maxUploadsGlobal?: number;
  maxDownloads?: number;
  maxDownloadsGlobal?: number;
  maxPeers?: number;
  minPeers?: number;
  maxPeersSeed?: number;
  minPeersSeed?: number;
  maxOpenFiles?: number;
  maxHttpOpen?: number;
  memoryMax?: number;
  portRange?: string;
  portRandom?: boolean;
  dhtMode?: string;
  dhtPort?: number;
  pex?: boolean;
  udpTrackers?: boolean;
  encryption?: string;
  preallocate?: boolean;
  checkHashOnCompletion?: boolean;
  directory?: string;
  sessionDirectory?: string;
}
