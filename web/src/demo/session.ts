// SPDX-License-Identifier: MIT

/**
 * The simulated rtorrent: torrents that download, seed, check and announce
 * over time, with peers, trackers, a log and the counters the badges grow
 * from. Pure and DOM-free — the clock is whatever the caller says it is — so
 * the node test runner drives it through simulated hours in a moment.
 *
 * Time moves in fixed steps from the moment the session was made, however
 * often it is read, and everything that varies with the clock — the rates'
 * swings, which peers are connected, the DHT's size — runs from that moment
 * rather than from the epoch: the same seed and the same actions give the
 * same session whenever it starts.
 * Everything shown is derived from one model, so the numbers agree with each
 * other: a torrent's completed bytes are its files', its ratio its own totals',
 * the global rates the sum of the torrents', and the badges' lifetime totals
 * grow by exactly what the torrents move.
 */
import type {
  GameState, GameStats, GlobalSettings, GlobalStatus, LogScopeChange, LogScopeState, Peer, RateSample,
  ThrottleGroup, ThrottleRate, Torrent, TorrentFile, TorrentStatus, Tracker,
} from '../contracts.ts';
import { CATALOG, HISTORY, THROTTLES, type CatalogFile, type CatalogTorrent } from './catalog.ts';
import { buildGame, newlyUnlocked } from './game.ts';
import { fitComponent } from './pathfit.ts';
import { seeded, type Random } from './random.ts';
import { defaultSettings } from './settings.ts';
import { sha1Hex } from './sha1.ts';
import type { Magnet, TorrentInfo } from './torrentfile.ts';
import { Fault, HttpError } from './validate.ts';

/** How far one step moves the clock, ms. */
export const STEP_MS = 250;
/** Rate samples kept for the header graph, one a second: lifecycle.go's historyLength. */
export const HISTORY_LENGTH = 180;
/** A gap longer than this (a tab hidden for a while) is crossed in coarse steps. */
const CATCH_UP_MS = 10 * 60 * 1000;
const LOG_KEEP = 3000;
const DAY = 86_400;
const KiB = 1024;
const MiB = 1024 * KiB;

export const DOWNLOAD_DIR = '/downloads';
export const SESSION_DIR = '/config/session';
/** CASCADE_DELETE_ROOTS as a stock container has them: the download directory. */
const DELETE_ROOTS = [DOWNLOAD_DIR];

const NOT_FOUND = 'invalid parameters: info-hash not found';
const NO_INDEX = 'invalid parameters: index not found';
/** The most upload or download slots rtorrent gives one torrent: 2^16. */
const MAX_SLOTS = 65_536;

/** rtorrent 0.16 dropped these subsystem groups (service/logs.go), so it refuses to attach them. */
const MISSING_SCOPES = new Set(['connection_debug', 'dht_debug', 'peer_debug', 'tracker_debug']);
export const LOG_SCOPES = [
  'critical', 'error', 'warn', 'notice', 'info', 'debug', 'connection_debug', 'dht_debug', 'peer_debug',
  'rpc_events', 'storage_debug', 'torrent_debug', 'tracker_debug', 'tracker_events',
];
const SEVERITIES = ['critical', 'error', 'warn', 'notice', 'info', 'debug'];
const LETTERS = 'CEWNID';

/** d.priority's share of the bandwidth: off, low, normal, high. */
const PRIORITY_WEIGHT = [0, 0.55, 1, 1.35];

/** libtorrent's start and stop flags, which the log prints in hex. */
const START_NO_CREATE = 0x2;
const START_KEEP_BASELINE = 0x4;
const START_SKIP_TRACKER = 0x8;
const STOP_SKIP_TRACKER = 0x1;
/** A check of what was just written reads from the page cache: a real 0.16.24 checked 6 GiB in about 5 s. */
const CACHED_CHECK_SPEED = 1024 * MiB;

/* --------------------------------- model --------------------------------- */

interface Wave {
  amp: number[];
  period: number[];
  phase: number[];
}

export interface SimFile {
  path: string;
  size: number;
  offset: number;
  /** f.priority: 0 skip, 1 normal, 2 high. */
  priority: number;
  /** Verified bytes; fractional while a step's share is spread over files. */
  done: number;
}

export interface SimPeer {
  id: string;
  /** As p.address answers it: an IPv6 address in brackets. */
  address: string;
  port: number;
  client: string;
  options: string;
  seed: boolean;
  /** A leecher's progress when it connected, and how fast it gains, per hour. */
  start: number;
  growth: number;
  encrypted: boolean;
  obfuscated: boolean;
  incoming: boolean;
  snubbed: boolean;
  preferred: boolean;
  weight: number;
  /** What the peer pulls from the swarm as a whole, bytes/s. */
  swarmRate: number;
  /** Connected for as long as the torrent runs, not in turn with the rest of the pool. */
  steady: boolean;
}

type AnnounceEvent = 'started' | 'completed' | 'updated';
const EVENT_CODE: Record<AnnounceEvent, number> = { updated: 0, completed: 1, started: 2 };

export interface SimTracker {
  url: string;
  /** 1 HTTP, 2 UDP, 3 DHT. */
  type: number;
  group: number;
  enabled: boolean;
  extra: boolean;
  scrapable: boolean;
  /** What every announce answers with, for a tracker that is down; "" when it works. */
  failure: string;
  requester: string;
  interval: number;
  minInterval: number;
  successes: number;
  failures: number;
  scrapes: number;
  lastSuccess: number;
  lastFailure: number;
  nextFailure: number;
  lastScrape: number;
  lastActivity: number;
  /** When the next announce goes out, unix seconds; 0 while the torrent is not announcing. */
  nextActivity: number;
  latestEvent: number;
  pending: AnnounceEvent;
  newPeers: number;
  sumPeers: number;
  seeders: number;
  leechers: number;
  downloaded: number;
  busyUntil: number;
}

interface Swarm {
  down: number;
  up: number;
  seeds: number;
  leechers: number;
  peers: number;
  downWave: Wave;
  upWave: Wave;
  phase: number;
}

export interface SimTorrent {
  hash: string;
  name: string;
  files: SimFile[];
  size: number;
  multi: boolean;
  isPrivate: boolean;
  chunk: number;
  createdAt: number;
  label: string;
  /** Where the torrent goes: its files' directory, or for a multi-file torrent its own directory's parent. */
  parent: string;
  /** parent as of the last open: libtorrent freezes the paths there, so d.base_path follows a move only once reopened. */
  frozen: string;
  throttle: string;
  priority: number;
  maxUploads: number;
  maxDownloads: number;
  message: string;
  /** d.state: whether it should be running. */
  state: number;
  /**
   * d.complete: a stored flag, set when a download is confirmed finished or a
   * check ends with every piece; a recheck leaves it alone, so a complete
   * torrent reads complete while its data is checked again.
   */
  complete: boolean;
  open: boolean;
  active: boolean;
  /** d.hashing: 1 the first check, 2 the one on completion, 3 a recheck. */
  hashing: number;
  check: { pos: number; speed: number; target: number[]; restart: boolean } | null;
  /** What a check stopped part way left unverified, for the next start to check again. */
  unchecked: number[] | null;
  /** A magnet still fetching its metadata. */
  meta: { readyAt: number; name: string; directory: string } | null;
  everOpened: boolean;
  /** When it last began transferring, unix seconds: the oldest a connected peer can be. */
  activeSince: number;
  addedAt: number;
  /** d.timestamp.started and .finished: each set once, the first time, and kept. */
  startedAt: number;
  finishedAt: number;
  downTotal: number;
  upTotal: number;
  downRate: number;
  upRate: number;
  peersConnected: number;
  swarm: Swarm;
  pool: SimPeer[];
  trackers: SimTracker[];
  rng: Random;
}

/* ------------------------------ derived values ---------------------------- */

export function completedBytes(t: SimTorrent): number {
  let done = 0;
  for (const file of t.files) done += Math.floor(file.done);
  return done;
}

export function isComplete(t: SimTorrent): boolean {
  return t.files.every((file) => file.done >= file.size);
}

/** What is still wanted: files set to skip are not. */
function wantedLeft(t: SimTorrent): number {
  let left = 0;
  for (const file of t.files) if (file.priority > 0) left += file.size - file.done;
  return left;
}

function join(parent: string, name: string): string {
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`;
}

/** d.directory: a multi-file torrent's own directory, else the one its file is in. */
export function directoryOf(t: SimTorrent): string {
  return t.multi ? join(t.parent, t.name) : t.parent;
}

/** d.base_path: where the torrent was last opened, and empty until it first is. */
export function basePathOf(t: SimTorrent): string {
  return t.everOpened ? join(t.frozen, t.name) : '';
}

/**
 * d.ratio: uploaded per mille of what is done, as rtorrent's integer division
 * leaves it — and 0 during a check, as retrieve_d_ratio has it, rather than
 * the upload over the few bytes checked so far.
 */
export function ratioPermille(t: SimTorrent): number {
  if (t.hashing > 0) return 0;
  const done = completedBytes(t);
  return done > 0 ? Math.floor((t.upTotal * 1000) / done) : 0;
}

/** As MapTorrent derives it: a real error first, then checking, stopped, paused, seeding. */
export function statusOf(t: SimTorrent): TorrentStatus {
  if (t.message !== '' && !/^tracker:/i.test(t.message)) return 'error';
  if (t.hashing > 0) return 'checking';
  if (!t.open) return 'stopped';
  if (!t.active) return 'paused';
  return t.complete ? 'seeding' : 'downloading';
}

/** The listing's progress, as MapTorrent derives it: 1 for d.complete, else the bytes done. */
export function progressOf(t: SimTorrent): number {
  if (t.complete) return 1;
  return t.size > 0 ? Math.min(1, Math.max(0, completedBytes(t) / t.size)) : 0;
}

/** The views rtorrent lists a torrent in, for d.multicall2 and the listing's ?view=. */
export const VIEWS = ['main', 'default', 'name', 'active', 'started', 'stopped', 'complete', 'incomplete', 'hashing', 'seeding', 'leeching'];

export function viewsOf(t: SimTorrent): string[] {
  const out = ['main', 'default', 'name', t.state === 1 ? 'started' : 'stopped', t.complete ? 'complete' : 'incomplete'];
  if (t.hashing > 0) out.push('hashing');
  if (t.open && t.active) out.push(t.complete ? 'seeding' : 'leeching', 'active');
  return out;
}

function level(wave: Wave, at: number): number {
  let value = 1;
  for (let i = 0; i < wave.amp.length; i++) value += wave.amp[i] * Math.sin((2 * Math.PI * at) / wave.period[i] + wave.phase[i]);
  return Math.max(0.1, value);
}

function makeWave(rng: Random, swing: number): Wave {
  return {
    amp: [0.12 * swing, 0.18 * swing, 0.22 * swing],
    period: [rng.range(17, 29), rng.range(41, 67), rng.range(120, 300)],
    phase: [rng.range(0, 6.3), rng.range(0, 6.3), rng.range(0, 6.3)],
  };
}

const CLIENTS: ReadonlyArray<[name: string, prefix: string, weight: number]> = [
  ['qBittorrent 5.0.4', '-qB5040-', 22],
  ['qBittorrent 4.6.7', '-qB4670-', 9],
  ['Transmission 4.0.6', '-TR4060-', 14],
  ['Transmission 3.00', '-TR3000-', 4],
  ['libTorrent 0.16.20', '-lt1014-', 7],
  ['libTorrent 0.13.8', '-lt0D80-', 4],
  ['Deluge 2.1.1', '-DE211s-', 6],
  ['µTorrent 3.6.0', '-UT360S-', 5],
  ['Azureus 5.7.7.0', '-AZ5770-', 2],
  ['libtorrent 2.0.11', '-LT20B0-', 3],
];
const CLIENT_WEIGHT = CLIENTS.reduce((sum, [, , weight]) => sum + weight, 0);
const PORTS = [51413, 6881, 50000, 49160, 6889];
const OPTIONS = ['0000000000100005', '0000000000100005', '0000000000180005', '0000000000100004'];

function asciiHex(text: string): string {
  return [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

/** An address as p.address answers it: rtorrent brackets an IPv6 one itself (command_peer.cc, every release). */
function peerAddress(address: string): string {
  return address.includes(':') ? `[${address}]` : address;
}

function makePeer(rng: Random, seed: boolean): SimPeer {
  let pick = rng.range(0, CLIENT_WEIGHT);
  let client = CLIENTS[0];
  for (const candidate of CLIENTS) {
    pick -= candidate[2];
    if (pick < 0) {
      client = candidate;
      break;
    }
  }
  // Documentation ranges only: RFC 5737 for IPv4, RFC 3849 for IPv6.
  const address = rng.chance(0.15)
    ? `2001:db8::${rng.int(0x10, 0xffff).toString(16)}`
    : `${rng.pick(['192.0.2', '198.51.100', '203.0.113'])}.${rng.int(1, 254)}`;
  const encrypted = rng.chance(0.7);
  return {
    id: (asciiHex(client[1]) + rng.hex(24)).toUpperCase(),
    address: peerAddress(address),
    port: rng.chance(0.55) ? rng.pick(PORTS) : rng.int(10_000, 65_000),
    client: client[0],
    options: rng.pick(OPTIONS),
    seed,
    start: rng.range(0.02, 0.9),
    growth: rng.range(0.05, 0.6),
    encrypted,
    obfuscated: encrypted && rng.chance(0.15),
    incoming: rng.chance(0.35),
    snubbed: !seed && rng.chance(0.05),
    preferred: rng.chance(0.03),
    weight: rng.range(0.3, 1.7),
    swarmRate: rng.range(40 * KiB, 2.2 * MiB),
    steady: false,
  };
}

/** A catalogue torrent's steady peer: a leecher, so it stays once the torrent is complete too. */
function steadyPeer(rng: Random, address: string): SimPeer {
  return { ...makePeer(rng, false), address: peerAddress(address), steady: true };
}

/** Piece length as torrent creators pick it: a few thousand pieces at most. */
function pieceLengthFor(size: number): number {
  let length = 256 * KiB;
  while (length < 16 * MiB && size / length > 2000) length *= 2;
  return length;
}

function trackerType(url: string): number {
  if (url.startsWith('dht:')) return 3;
  return /^udp:/i.test(url) ? 2 : 1;
}

/** A tracker_events line about one tracker, in 0.16's words. */
function sending(t: SimTorrent, tracker: SimTracker, event: string): string {
  return `${t.hash}->tracker_list: sending ${event} : requester:${tracker.requester} url:${tracker.url}`;
}

function received(t: SimTorrent, tracker: SimTracker, what: string): string {
  return `${t.hash}->tracker_list: received ${what} : requester:${tracker.requester} group:${tracker.group} url:${tracker.url}`;
}

/* -------------------------------- session -------------------------------- */

/** What the session knows of the global status; the server adds its own policy and settings. */
export type SessionStatus = Omit<GlobalStatus, 'policy' | 'statePollMs' | 'statePollDefaultMs' | 'backend'>;

export interface AddOptions {
  start: boolean;
  directory: string;
  label: string;
}

export interface SessionOptions {
  seed: number;
  /** The clock at creation, epoch ms; the session is current as of then. */
  now: number;
}

export class Session {
  settings: GlobalSettings = defaultSettings();
  /** The rtorrent process: when it started, its pid and the container's hostname. */
  readonly startedAt: number;
  readonly pid: number;
  readonly hostname: string;
  private time: number;
  /** When the session started, epoch seconds: what every clock-driven swing is measured from. */
  private readonly origin: number;
  private readonly rng: Random;
  private readonly torrents = new Map<string, SimTorrent>();
  /** Cascade's saved groups, which the throttle dialog lists. */
  private groups: ThrottleGroup[];
  /** rtorrent's own, which do the limiting: the saved ones and any the console made. */
  private readonly rtGroups = new Map<string, { up: number; down: number }>();
  private readonly history: RateSample[] = [];
  private downRate = 0;
  private upRate = 0;
  private sessionDown: number;
  private sessionUp: number;
  private diskFree: number;
  private readonly stats: GameStats;
  private readonly unlockedAt: Record<string, number> = {};
  private readonly completedHashes = new Set<string>();
  private readonly seenHashes = new Set<string>();
  private lines: string[] = [];
  private readonly boot = ['info'];
  /** Raised from the UI (the store's copy), and what this rtorrent has attached. */
  private extra: string[] = ['tracker_events'];
  private readonly attached = new Set<string>(['tracker_events']);
  /** Announces scheduled at load, spaced so the log has something to show at once. */
  private stagger = 0;

  constructor({ seed, now: given }: SessionOptions) {
    // On a whole second, so the steps and the graph's once-a-second samples
    // fall alike whatever fraction of a second the page loaded at.
    const now = Math.floor(given / 1000) * 1000;
    this.rng = seeded(seed);
    this.time = now;
    this.origin = now / 1000;
    const nowS = Math.floor(now / 1000);
    this.startedAt = nowS - Math.round(HISTORY.uptimeDays * DAY);
    this.pid = this.rng.int(140, 190);
    this.hostname = this.rng.hex(12);
    this.sessionDown = HISTORY.sessionDown;
    this.sessionUp = HISTORY.sessionUp;
    this.diskFree = HISTORY.diskFree;
    this.groups = THROTTLES.map((group) => ({ ...group }));
    for (const group of this.groups) this.rtGroups.set(group.name, { up: group.up, down: group.down });
    for (const entry of CATALOG) {
      const torrent = this.fromCatalog(entry, now);
      this.torrents.set(torrent.hash, torrent);
      this.seenHashes.add(torrent.hash);
      if (torrent.complete) this.completedHashes.add(torrent.hash);
    }
    this.stats = {
      lifetimeUp: HISTORY.lifetimeUp,
      lifetimeDown: HISTORY.lifetimeDown,
      completed: HISTORY.completed,
      everAdded: HISTORY.everAdded,
      peakDownRate: HISTORY.peakDownRate,
      peakUpRate: HISTORY.peakUpRate,
      peakPeers: HISTORY.peakPeers,
      bestRatio: 0,
      longestSeed: 0,
      maxSeeding: HISTORY.maxSeeding,
      maxLabels: 0,
    };
    for (const [id, days] of Object.entries(HISTORY.unlocked)) {
      this.unlockedAt[id] = nowS - Math.round(days * DAY) - this.rng.int(0, 40_000);
    }
    for (const torrent of this.torrents.values()) {
      if (torrent.trackers.some((tracker) => tracker.failure)) torrent.message = `Tracker: [${torrent.trackers[0].failure}]`;
    }
    this.prefillHistory(nowS);
    this.prefillLog(nowS);
    this.applyRates(now / 1000);
    this.fold(nowS);
  }

  /** The clock the session has reached, epoch ms. */
  get now(): number {
    return this.time;
  }

  /** Run the simulation up to the clock: in steps, so a reading's timing changes nothing. */
  advance(to: number): void {
    if (to - this.time > CATCH_UP_MS) {
      // A hidden tab reads nothing; coming back after hours must not mean
      // replaying them in quarter seconds. The last stretch runs at the usual
      // pace, so the graph is whole.
      const until = to - (HISTORY_LENGTH + 5) * 1000;
      const coarse = Math.max(STEP_MS, Math.ceil((until - this.time) / 2000 / STEP_MS) * STEP_MS);
      while (this.time + coarse <= until) this.step(coarse);
    }
    while (this.time + STEP_MS <= to) this.step(STEP_MS);
  }

  /* ------------------------------- reading ------------------------------- */

  /** The listing, as MapTorrent builds it from d.multicall2. */
  list(): Torrent[] {
    return [...this.torrents.values()].map((t) => this.row(t));
  }

  /** The torrent a hash names, or rtorrent's fault for one it does not hold. */
  get(hash: string, command?: string): SimTorrent {
    const torrent = this.torrents.get(hash.toUpperCase());
    if (!torrent) throw new Fault(-503, command ? `${command}: ${NOT_FOUND}` : NOT_FOUND);
    return torrent;
  }

  has(hash: string): boolean {
    return this.torrents.has(hash.toUpperCase());
  }

  all(): SimTorrent[] {
    return [...this.torrents.values()];
  }

  /** The listing and the global figures, read together as the state route reads them. */
  snapshot(): { torrents: Torrent[]; status: SessionStatus } {
    const torrents = this.list();
    return {
      torrents,
      status: {
        connected: true,
        downRate: this.downRate,
        upRate: this.upRate,
        downTotal: Math.round(this.sessionDown),
        upTotal: Math.round(this.sessionUp),
        downLimit: this.settings.downloadRate,
        upLimit: this.settings.uploadRate,
        torrentCount: torrents.length,
        activeCount: torrents.filter((t) => t.status === 'downloading' || t.status === 'seeding').length,
        dhtNodes: this.dhtNodes(),
        listenPort: this.listenPort(),
        diskFree: Math.round(this.diskFree),
        downloadDir: this.settings.directory,
        history: this.history.map((sample) => ({ ...sample })),
      },
    };
  }

  /** The global rates and totals, as throttle.global_*.rate and .total report them. */
  globalRates(): { down: number; up: number; downTotal: number; upTotal: number } {
    return { down: this.downRate, up: this.upRate, downTotal: Math.round(this.sessionDown), upTotal: Math.round(this.sessionUp) };
  }

  /** rtorrent binds once, at start: a port range changed live does not move it (quirk 6). */
  listenPort(): number {
    return 50_000;
  }

  /**
   * dht.port as 0.16.1 and later report it: no longer a setting, but the port
   * the running DHT has — the listening port, or dht.override_port — and 0
   * while it is off.
   */
  dhtPort(): number {
    if (this.dhtNodes() === 0) return 0;
    return this.settings.dhtOverridePort || this.listenPort();
  }

  /** A setting as its getter reads it: as kept, but for dht.port. */
  readSetting(key: keyof GlobalSettings): number | boolean | string {
    return key === 'dhtPort' ? this.dhtPort() : this.settings[key];
  }

  dhtNodes(): number {
    if (this.settings.dhtMode === 'disable' || this.settings.dhtMode === 'off') return 0;
    const at = this.time / 1000 - this.origin;
    return Math.round(262 + 31 * Math.sin(at / 300) + 12 * Math.sin(at / 47 + 1.3));
  }

  /**
   * dht.statistics as 0.16 answers it. While DHT runs: its counters, the
   * routing table's size as "nodes" (what the status reads), a bucket for
   * every eight nodes at most, cycle 1 until the first refreshes, and the
   * byte counts 0.16 no longer keeps. While it does not: only the mode, the
   * flag and the throttle name.
   */
  dhtStatistics(): Record<string, number | string> {
    const nodes = this.dhtNodes();
    if (nodes === 0) return { active: 0, dht: this.settings.dhtMode, throttle: '' };
    return {
      active: 1, buckets: Math.ceil(nodes / 7), bytes_read: 0, bytes_written: 0,
      cycle: Math.max(1, Math.floor((this.time / 1000 - this.startedAt) / 900)),
      dht: this.settings.dhtMode, errors_caught: 2, errors_received: 37, nodes, peers: nodes * 3 + 41, peers_max: 412,
      queries_received: 18_211, queries_sent: 25_904, replies_received: 21_337, throttle: '', torrents: this.all().filter((t) => !t.isPrivate).length,
    };
  }

  game(): GameState {
    // The store counts whole bytes; the steps move fractions of one.
    const stats = this.stats;
    return buildGame({
      ...stats,
      lifetimeUp: Math.round(stats.lifetimeUp),
      lifetimeDown: Math.round(stats.lifetimeDown),
      peakDownRate: Math.round(stats.peakDownRate),
      peakUpRate: Math.round(stats.peakUpRate),
    }, this.unlockedAt);
  }

  throttles(): ThrottleGroup[] {
    return this.groups.map((group) => ({ ...group }));
  }

  /** Each saved group's throughput: what its torrents move now. */
  throttleRates(): Record<string, ThrottleRate> {
    const rates: Record<string, ThrottleRate> = {};
    for (const group of this.groups) rates[group.name] = this.groupRate(group.name);
    return rates;
  }

  groupRate(name: string): ThrottleRate {
    let up = 0;
    let down = 0;
    for (const t of this.torrents.values()) {
      if (t.throttle !== name) continue;
      up += t.upRate;
      down += t.downRate;
    }
    return { up, down };
  }

  /** rtorrent's own group table, bytes/s; 0 is unlimited. */
  rtGroup(name: string): { up: number; down: number } | undefined {
    return this.rtGroups.get(name);
  }

  /** throttle.up / throttle.down: create or change a group in rtorrent alone. */
  setRtGroup(name: string, direction: 'up' | 'down', bytes: number): void {
    const group = this.rtGroups.get(name) ?? { up: 0, down: 0 };
    group[direction] = bytes;
    this.rtGroups.set(name, group);
  }

  files(hash: string): TorrentFile[] {
    const t = this.get(hash);
    return t.files.map((file, index) => this.fileRow(t, file, index));
  }

  fileRow(t: SimTorrent, file: SimFile, index: number): TorrentFile {
    const first = Math.floor(file.offset / t.chunk);
    const sizeChunks = file.size > 0 ? Math.floor((file.offset + file.size - 1) / t.chunk) - first + 1 : 0;
    const done = Math.floor(file.done);
    const completedChunks = done >= file.size ? sizeChunks : Math.floor((done / file.size) * sizeChunks);
    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    const fitted = fitComponent(name);
    return {
      index,
      path: file.path,
      onDisk: t.everOpened && fitted !== name ? fitted : '',
      size: file.size,
      completedChunks,
      sizeChunks,
      priority: file.priority,
      progress: sizeChunks > 0 ? Math.min(1, completedChunks / sizeChunks) : 0,
      created: done > 0 || (t.everOpened && file.priority > 0),
    };
  }

  /**
   * The peers connected now: the steady ones, there since the torrent last
   * started, then a window over the rest of its pool that slides as peers
   * come and go.
   */
  connected(t: SimTorrent, at = this.time / 1000): Array<{ peer: SimPeer; since: number }> {
    const count = this.peerCount(t, at);
    if (count === 0) return [];
    const pool = isComplete(t) ? t.pool.filter((peer) => !peer.seed) : t.pool;
    const out = pool.filter((peer) => peer.steady).slice(0, count).map((peer) => ({ peer, since: t.activeSince }));
    const turns = pool.filter((peer) => !peer.steady);
    const slots = count - out.length;
    const rotate = 53;
    const turn = Math.floor((at - this.origin) / rotate + t.swarm.phase);
    for (let i = 0; i < Math.min(slots, turns.length); i++) {
      // When the peer joined, back in epoch seconds: its age and totals count from there.
      const joined = this.origin + (turn + i - slots + 1 - t.swarm.phase) * rotate;
      out.push({ peer: turns[(turn + i) % turns.length], since: Math.max(t.activeSince, Math.floor(joined)) });
    }
    return out;
  }

  peers(hash: string): Peer[] {
    const t = this.get(hash);
    const at = this.time / 1000;
    const peers = this.connected(t, at);
    const wanting = wantedLeft(t) > 0;
    const downWeight = (peer: SimPeer) => (peer.snubbed ? 0 : peer.weight * (peer.seed ? 1.6 : 0.6));
    const upWeight = (peer: SimPeer) => (peer.seed ? 0 : peer.weight);
    const downSum = peers.reduce((sum, { peer }) => sum + downWeight(peer), 0);
    const upSum = peers.reduce((sum, { peer }) => sum + upWeight(peer), 0);
    return peers.map(({ peer, since }) => {
      const age = Math.max(1, at - since);
      const progress = peer.seed ? 1 : Math.min(0.995, peer.start + (peer.growth * age) / 3600);
      const shareDown = wanting && downSum > 0 ? downWeight(peer) / downSum : 0;
      const shareUp = upSum > 0 ? upWeight(peer) / upSum : 0;
      // Totals at the peer's nominal rate, so they only ever grow while it stays.
      const nominal = Math.max(1, t.swarm.peers);
      return {
        id: peer.id,
        address: peer.address,
        port: peer.port,
        client: peer.client,
        progress,
        upRate: Math.round(t.upRate * shareUp),
        downRate: Math.round(t.downRate * shareDown),
        upTotal: peer.seed ? 0 : Math.round(((t.swarm.up * peer.weight) / nominal) * age),
        downTotal: wanting ? Math.round(((t.swarm.down * downWeight(peer)) / nominal) * age) : 0,
        peerRate: peer.seed ? 0 : Math.round(peer.swarmRate * (0.8 + 0.2 * Math.sin((at - this.origin) / 13 + peer.weight * 7))),
        peerTotal: Math.round(peer.swarmRate * (age + 900 * peer.weight)),
        encrypted: peer.encrypted,
        obfuscated: peer.obfuscated,
        incoming: peer.incoming,
        snubbed: peer.snubbed,
        preferred: peer.preferred,
        unwanted: false,
        banned: false,
        options: peer.options,
      };
    });
  }

  trackers(hash: string): Tracker[] {
    const t = this.get(hash);
    return t.trackers.map((tracker, index) => this.trackerRow(t, tracker, index));
  }

  trackerRow(t: SimTorrent, tracker: SimTracker, index: number): Tracker {
    const nowS = Math.floor(this.time / 1000);
    const announcing = t.open && t.active && tracker.enabled;
    const busy = tracker.busyUntil > nowS;
    return {
      index,
      url: tracker.url,
      type: tracker.type,
      group: tracker.group,
      trackerId: '',
      enabled: tracker.enabled,
      usable: tracker.enabled,
      open: busy && tracker.type === 2,
      busy,
      extra: tracker.extra,
      canScrape: tracker.scrapable,
      seeders: tracker.seeders,
      leechers: tracker.leechers,
      downloaded: tracker.downloaded,
      lastScrape: tracker.lastScrape,
      scrapes: tracker.scrapes,
      successes: tracker.successes,
      lastSuccess: tracker.lastSuccess,
      nextSuccess: announcing && !tracker.failure ? tracker.nextActivity : 0,
      failures: tracker.failures,
      lastFailure: tracker.lastFailure,
      nextFailure: tracker.failures > 0 ? tracker.nextFailure : 0,
      latestEvent: tracker.latestEvent,
      newPeers: tracker.newPeers,
      sumPeers: tracker.sumPeers,
      interval: tracker.interval,
      minInterval: tracker.minInterval,
      lastActivity: tracker.lastActivity,
      nextActivity: announcing ? tracker.nextActivity : 0,
    };
  }

  /** The host the sidebar groups a torrent under: its first tracker's, as TrackerHost reads it. */
  trackerHost(hash: string): string {
    const t = this.torrents.get(hash.toUpperCase());
    const url = t?.trackers[0]?.url ?? '';
    try {
      const parsed = new URL(url);
      if (!parsed.hostname) return 'unknown';
      return parsed.hostname;
    } catch {
      return 'unknown';
    }
  }

  logTail(lines: number): string[] {
    return this.lines.slice(Math.max(0, this.lines.length - lines));
  }

  logScopes(): LogScopeState {
    return { boot: [...this.boot], extra: [...this.extra], available: [...LOG_SCOPES], supported: true };
  }

  /* ------------------------------- changing ------------------------------- */

  /** A torrent action as performAction runs it: unknown actions are refused before rtorrent is asked. */
  action(hash: string, action: string): void {
    if (!['start', 'stop', 'pause', 'resume', 'recheck', 'recheck-restart', 'announce'].includes(action)) {
      throw new HttpError(400, `unknown action "${action}"`);
    }
    const t = this.get(hash);
    const nowS = Math.floor(this.time / 1000);
    switch (action) {
      case 'start':
        this.open(t, nowS);
        this.start(t, nowS);
        break;
      case 'stop':
        this.stop(t, nowS);
        this.close(t, nowS);
        break;
      case 'pause':
        this.pause(t, nowS);
        break;
      case 'resume':
        this.resume(t, nowS);
        break;
      case 'recheck':
      case 'recheck-restart':
        this.stop(t, nowS);
        t.message = '';
        this.checkHash(t, nowS, action === 'recheck-restart');
        break;
      case 'announce':
        for (const tracker of t.trackers) {
          if (tracker.enabled && t.open && t.active) tracker.nextActivity = nowS;
        }
        break;
    }
  }

  /** One lifecycle command as the console sends it, without the action's pairing (start is d.open + d.start). */
  command(hash: string, command: string): void {
    const t = this.get(hash);
    const nowS = Math.floor(this.time / 1000);
    switch (command) {
      case 'd.open':
        this.open(t, nowS);
        break;
      case 'd.close':
        this.pause(t, nowS);
        this.close(t, nowS);
        break;
      case 'd.start':
        this.start(t, nowS);
        break;
      case 'd.stop':
        this.stop(t, nowS);
        break;
      case 'd.pause':
        this.pause(t, nowS);
        break;
      case 'd.resume':
        this.resume(t, nowS);
        break;
      case 'd.check_hash':
        this.checkHash(t, nowS, false);
        break;
      case 'd.erase':
        this.remove(t.hash, false);
        break;
      case 'd.tracker_announce':
        this.action(t.hash, 'announce');
        break;
    }
  }

  /** d.erase, after the data path is checked when the data goes too. */
  remove(hash: string, deleteData: boolean): void {
    const t = this.get(hash);
    const base = basePathOf(t);
    // Checked before the erase, as the server does; a torrent never opened has nothing on disk.
    if (deleteData && base !== '') {
      const inRoot = DELETE_ROOTS.some((root) => base.startsWith(`${root}/`) && !base.slice(root.length + 1).split('/').includes('..'));
      if (!inRoot) {
        throw new HttpError(403,
          `refusing to delete "${base}": it is outside the permitted data roots or would delete a data root (${DELETE_ROOTS.join(', ')})`);
      }
    }
    const nowS = Math.floor(this.time / 1000);
    if (t.open && t.active) this.pause(t, nowS);
    this.info(t, 'download_list: Erasing download.', nowS);
    this.info(t, 'download_list: Closing download with throw.', nowS);
    this.torrents.delete(t.hash);
    if (deleteData && base !== '') this.diskFree += completedBytes(t);
  }

  setPriority(hash: string, priority: number): void {
    const t = this.get(hash);
    t.priority = priority;
    this.info(t, `resource_manager: set priority: ${priority}`, Math.floor(this.time / 1000));
  }

  setLabel(hash: string, label: string): void {
    this.get(hash).label = label;
  }

  /** A running download refuses a throttle change (quirk 4), so it is stopped around the change. */
  setThrottle(hash: string, name: string): void {
    const t = this.get(hash);
    const nowS = Math.floor(this.time / 1000);
    const wasActive = t.active;
    if (wasActive) this.stop(t, nowS);
    t.throttle = name;
    if (wasActive) this.start(t, nowS);
  }

  /**
   * Stopped and closed first, as SetDirectory does; the data itself is not
   * moved. Only d.directory changes: d.base_path follows at the next open.
   */
  setDirectory(hash: string, directory: string): void {
    const t = this.get(hash);
    const nowS = Math.floor(this.time / 1000);
    this.stop(t, nowS);
    this.close(t, nowS);
    t.parent = directory.length > 1 ? directory.replace(/\/+$/, '') : directory;
  }

  /**
   * d.uploads_max.set and d.downloads_max.set, sent together as the server
   * sends them: each applied unless rtorrent refuses it, the first refusal
   * reported, named after its command.
   */
  setSlots(hash: string, uploads: number | null, downloads: number | null): void {
    const t = this.get(hash, uploads !== null ? 'd.uploads_max.set' : 'd.downloads_max.set');
    let refused: Fault | null = null;
    if (uploads !== null) {
      if (uploads > MAX_SLOTS) refused = new Fault(-503, 'd.uploads_max.set: Max uploads must be between 0 and 2^16.');
      else t.maxUploads = uploads;
    }
    if (downloads !== null) {
      if (downloads > MAX_SLOTS) refused ??= new Fault(-503, 'd.downloads_max.set: Max downloads must be between 0 and 2^16.');
      else t.maxDownloads = downloads;
    }
    if (refused) throw refused;
  }

  setFilePriority(hash: string, index: number, priority: number): void {
    const t = this.get(hash, 'f.priority.set');
    const file = t.files[index];
    if (!file) throw new Fault(-503, `f.priority.set: ${NO_INDEX}`);
    file.priority = priority;
  }

  setTrackerEnabled(hash: string, index: number, enabled: boolean): void {
    const t = this.get(hash);
    const tracker = t.trackers[index];
    if (!tracker) throw new Fault(-503, NO_INDEX);
    if (tracker.enabled === enabled) return;
    tracker.enabled = enabled;
    tracker.nextActivity = enabled && t.open && t.active ? Math.floor(this.time / 1000) + 2 : 0;
    if (enabled) tracker.pending = 'started';
  }

  /** d.tracker.insert: into its tier, after the trackers already there. */
  addTracker(hash: string, url: string, group: number): void {
    const t = this.get(hash, 'd.tracker.insert');
    const nowS = Math.floor(this.time / 1000);
    const tracker = this.makeTracker(t, url, group, true);
    tracker.pending = 'started';
    tracker.nextActivity = t.open && t.active ? nowS + 1 : 0;
    const at = t.trackers.findIndex((existing) => existing.group > group);
    if (at < 0) t.trackers.push(tracker);
    else t.trackers.splice(at, 0, tracker);
    this.track(`${t.hash}->tracker_list: added tracker : requester:${tracker.requester} group:${group} url:${url}`, nowS);
  }

  /** A .torrent the server has parsed and found new. */
  addTorrent(info: TorrentInfo, options: AddOptions): SimTorrent {
    const rng = this.rng.fork(`added:${info.infoHash}`);
    const files: CatalogFile[] = info.files.map((file) => [file.path, file.size]);
    const t = this.blank(info.infoHash, info.name, files, info.isMultiFile, info.pieceLength, rng);
    t.isPrivate = info.isPrivate;
    t.createdAt = info.createdAt;
    this.attach(t, info.trackers, options);
    return t;
  }

  /** A magnet: listed as <HASH>.meta until its metadata arrives, a few seconds after it starts. */
  addMagnet(magnet: Magnet, options: AddOptions): SimTorrent {
    const rng = this.rng.fork(`magnet:${magnet.infoHash}`);
    const name = `${magnet.infoHash}.meta`;
    const t = this.blank(magnet.infoHash, name, [[name, 1]], false, 1, rng);
    t.parent = SESSION_DIR;
    t.createdAt = 0;
    t.meta = {
      readyAt: this.time + rng.range(3_000, 6_500),
      name: magnet.name || magnet.infoHash,
      directory: options.directory,
    };
    this.attach(t, magnet.trackers.map((url) => [url]), { ...options, directory: SESSION_DIR });
    return t;
  }

  /**
   * A link to a .torrent: there is no network here to fetch it from, so the
   * file is taken to be what its name says. The hash comes from the link, so
   * adding the same one twice behaves as rtorrent does with a duplicate.
   */
  addUrl(link: string, options: AddOptions): SimTorrent | null {
    const hash = sha1Hex(new TextEncoder().encode(link)).toUpperCase();
    if (this.torrents.has(hash)) return null;
    let name = 'download';
    try {
      const path = new URL(link).pathname;
      name = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1)).replace(/\.torrent$/i, '') || name;
    } catch {
      // The name stays generic.
    }
    const rng = this.rng.fork(`url:${hash}`);
    const size = Math.round(rng.range(0.4, 4.2) * 1024 * MiB);
    const t = this.blank(hash, name, [[name, size]], false, pieceLengthFor(size), rng);
    t.createdAt = Math.floor(this.time / 1000) - rng.int(2, 900) * DAY;
    this.attach(t, [[`udp://tracker.example.net:6969/announce`]], options);
    return t;
  }

  saveThrottle(group: ThrottleGroup): void {
    const at = this.groups.findIndex((existing) => existing.name === group.name);
    if (at >= 0) this.groups[at] = { ...group };
    else this.groups.push({ ...group });
    this.rtGroups.set(group.name, { up: group.up, down: group.down });
  }

  throttle(name: string): ThrottleGroup | undefined {
    return this.groups.find((group) => group.name === name);
  }

  /** rtorrent cannot drop a group: it is unlimited instead, and forgotten by the store. */
  deleteThrottle(name: string): void {
    this.rtGroups.set(name, { up: 0, down: 0 });
    this.groups = this.groups.filter((group) => group.name !== name);
  }

  /** SetLogScopes: raising is live, lowering lasts only until rtorrent restarts. */
  setLogScopes(requested: string[]): LogScopeChange {
    const scopes = LOG_SCOPES.filter((scope) => requested.includes(scope));
    const previous = this.extra;
    const failed: string[] = [];
    for (const scope of scopes) {
      if (this.attached.has(scope)) continue;
      if (MISSING_SCOPES.has(scope)) failed.push(scope);
      else this.attached.add(scope);
    }
    this.extra = scopes.filter((scope) => !failed.includes(scope));
    const stillActive = previous.filter((scope) => !scopes.includes(scope) && this.attached.has(scope));
    return { ...this.logScopes(), stillActive, failed };
  }

  /** log.add_output: attach one scope, or refuse one this build does not have. */
  attachScope(scope: string): boolean {
    if (!LOG_SCOPES.includes(scope) || MISSING_SCOPES.has(scope)) return false;
    if (!this.boot.includes(scope)) this.attached.add(scope);
    return true;
  }

  /* ----------------------------- lifecycle ------------------------------ */

  private open(t: SimTorrent, nowS: number): void {
    if (t.open) return;
    t.open = true;
    t.everOpened = true;
    t.frozen = t.parent;
    this.info(t, 'download_list: Opening download.', nowS);
    this.info(t, 'download: Opening torrent: flags:fffffffe.', nowS);
    this.info(t, 'file_list: Opening.', nowS);
  }

  private start(t: SimTorrent, nowS: number): void {
    t.state = 1;
    if (!t.open) this.open(t, nowS);
    if (t.unchecked) {
      // A check that was stopped part way is run again before anything moves.
      const target = t.unchecked;
      t.unchecked = null;
      this.beginCheck(t, nowS, 1, target, false);
      return;
    }
    if (t.hashing > 0 || t.active) return;
    this.activate(t, nowS);
  }

  /**
   * Resuming, which starts the transfer: a plain start announces "started"
   * to every tracker, while confirm_finished's resume skips the trackers and
   * keeps the baseline, leaving them their queued "completed".
   */
  private activate(t: SimTorrent, nowS: number, flags = 0): void {
    t.active = true;
    // event.download.resumed: d.timestamp.started.set_if_z.
    if (t.startedAt === 0) t.startedAt = nowS;
    t.activeSince = nowS;
    if (t.meta) t.meta.readyAt = Math.max(t.meta.readyAt, this.time + 3_000);
    this.info(t, `download_list: Resuming download: flags:${flags.toString(16)}.`, nowS);
    this.info(t, `download: Starting torrent: flags:${flags.toString(16)}.`, nowS);
    this.track(`${t.hash}->tracker_controller: enabled : trackers:${t.trackers.length}`, nowS);
    if (!(flags & START_KEEP_BASELINE)) {
      this.track(`${t.hash}->download: Setting new baseline on start: uploaded:${Math.round(t.upTotal)} completed:${completedBytes(t)}.`, nowS);
    }
    if (flags & START_SKIP_TRACKER) return;
    this.track(`${t.hash}->tracker_controller: sending start event : requesting`, nowS);
    for (const tracker of t.trackers) {
      if (!tracker.enabled) continue;
      tracker.pending = 'started';
      tracker.nextActivity = nowS;
    }
  }

  /**
   * d.pause, and the first half of d.stop: inactive, stopped announced, still
   * open. The hash queue pauses without a word to the trackers, which keep
   * their schedule for when it resumes.
   */
  private pause(t: SimTorrent, nowS: number, flags = 0): void {
    if (!t.active) return;
    t.active = false;
    t.downRate = 0;
    t.upRate = 0;
    t.peersConnected = 0;
    this.info(t, `download_list: Pausing download: flags:${flags.toString(16)}.`, nowS);
    this.info(t, `download: Stopping torrent: flags:${flags.toString(16)}.`, nowS);
    if (flags & STOP_SKIP_TRACKER) {
      this.track(`${t.hash}->tracker_controller: disabled : trackers:${t.trackers.length}`, nowS);
      return;
    }
    this.track(`${t.hash}->tracker_controller: sending stop event : requesting`, nowS);
    for (const tracker of t.trackers) {
      if (!tracker.enabled || tracker.lastActivity === 0 || tracker.failure) {
        tracker.nextActivity = 0;
        continue;
      }
      this.track(sending(t, tracker, 'stopped'), nowS);
      tracker.latestEvent = 3;
      tracker.lastActivity = nowS;
      tracker.nextActivity = 0;
      tracker.pending = 'started';
    }
    this.track(`${t.hash}->tracker_controller: disabled : trackers:${t.trackers.length}`, nowS);
  }

  private resume(t: SimTorrent, nowS: number): void {
    if (!t.open || t.active || t.hashing > 0) return;
    this.activate(t, nowS);
  }

  private stop(t: SimTorrent, nowS: number): void {
    t.state = 0;
    this.pause(t, nowS);
  }

  private close(t: SimTorrent, nowS: number): void {
    if (!t.open) return;
    if (t.check) {
      // Closing ends a check where it stands; the next start checks again.
      this.info(t, 'download: Hashing stopped.', nowS);
      t.unchecked = t.check.target;
      t.check = null;
      t.hashing = 0;
    }
    t.open = false;
    t.active = false;
    this.info(t, 'download_list: Closing download with throw.', nowS);
    this.info(t, 'download: Closing torrent: flags:0.', nowS);
    this.info(t, 'file_list: Closing.', nowS);
  }

  private checkHash(t: SimTorrent, nowS: number, restart: boolean): void {
    const target = t.check?.target ?? t.unchecked ?? t.files.map((file) => file.done);
    t.unchecked = null;
    this.info(t, 'download_list: Checking hash.', nowS);
    this.info(t, 'download_list: Hash queue.', nowS);
    if (!t.open) this.open(t, nowS);
    this.beginCheck(t, nowS, 3, target, restart);
  }

  /** A check from the first piece; it leaves d.complete as it was until it ends. */
  private beginCheck(t: SimTorrent, nowS: number, kind: number, target: number[], restart: boolean, speed = t.check?.speed ?? 90 * MiB): void {
    t.hashing = kind;
    t.active = false;
    t.check = { pos: 0, speed, target, restart };
    for (const file of t.files) file.done = 0;
    const chunks = Math.ceil(t.size / t.chunk);
    this.info(t, `download: Checking hash: allocated:1 try_quick:${kind === 1 ? 1 : 0}.`, nowS);
    this.info(t, `hash_torrent: start : position:0 size:${chunks} quick:${kind === 1 ? 1 : 0}.`, nowS);
  }

  private hashStep(t: SimTorrent, dt: number, nowS: number): void {
    const check = t.check;
    if (!check) return;
    check.pos = Math.min(t.size, check.pos + (check.speed * dt) / 1000);
    t.files.forEach((file, i) => {
      const read = file.size > 0 ? Math.min(1, Math.max(0, (check.pos - file.offset) / file.size)) : 1;
      file.done = check.target[i] * read;
    });
    if (check.pos < t.size) return;
    t.files.forEach((file, i) => (file.done = check.target[i]));
    t.check = null;
    const kind = t.hashing;
    t.hashing = 0;
    const chunks = Math.ceil(t.size / t.chunk);
    const wanted = t.files.some((file) => file.priority > 0 && file.done < file.size) ? Math.ceil(wantedLeft(t) / t.chunk) : 0;
    this.info(t, `hash_torrent: completed : position:${chunks}`, nowS);
    this.info(t, 'hash_torrent: confirmed checked', nowS);
    this.info(t, `download: update priorities: chunks_selected:${chunks} wanted_chunks:${wanted}`, nowS);
    this.info(t, 'download_list: Hash done.', nowS);
    if (kind === 2) {
      // The check pieces.hash.on_completion asked for: the data it read is
      // what was just downloaded, so it confirms the finish.
      if (isComplete(t)) this.confirmFinished(t, nowS);
      return;
    }
    // d.complete.set(is_done), then event.download.hash_done stamps a complete one's finish if it has none.
    t.complete = isComplete(t);
    if (t.complete && t.finishedAt === 0) t.finishedAt = nowS;
    // recheck-restart's second half is the server's housekeeping: d.open and d.start, once the check ends.
    if (check.restart) {
      this.open(t, nowS);
      this.start(t, nowS);
    } else if (t.state === 1 && t.open) {
      this.activate(t, nowS);
    }
  }

  /** The metadata arrived: the .meta stand-in becomes the torrent it describes. */
  private materialize(t: SimTorrent, nowS: number): void {
    const meta = t.meta;
    if (!meta) return;
    const rng = t.rng.fork('metadata');
    const name = meta.name;
    const size = Math.round(rng.range(0.35, 3.8) * 1024 * MiB);
    const multi = !/\.[A-Za-z0-9]{2,4}$/.test(name);
    const files: CatalogFile[] = multi
      ? [[`${name}.mkv`, size - 8_192 - 312_771], [`${name}.nfo`, 8_192], ['cover.jpg', 312_771]]
      : [[name, size]];
    t.meta = null;
    t.name = name;
    t.multi = multi;
    t.files = this.layout(files);
    t.size = t.files.reduce((sum, file) => sum + file.size, 0);
    t.chunk = pieceLengthFor(t.size);
    t.parent = meta.directory || this.settings.directory;
    t.frozen = t.parent;
    t.createdAt = nowS - rng.int(3, 2000) * DAY;
    t.everOpened = true;
    this.info(t, 'download_list: Inserting download.', nowS);
    this.info(t, `chunk_list: Resizing: from:1 to:${Math.ceil(t.size / t.chunk)}.`, nowS);
    this.info(t, 'download_list: Hash done.', nowS);
  }

  /* ------------------------------- stepping ------------------------------- */

  private step(dt: number): void {
    const from = this.time;
    this.time += dt;
    const at = this.time / 1000;
    const nowS = Math.floor(at);
    for (const t of this.torrents.values()) {
      if (t.meta && t.open && t.active && this.time >= t.meta.readyAt) this.materialize(t, nowS);
      if (t.check) this.hashStep(t, dt, nowS);
    }
    const rates = this.rates(at);
    let down = 0;
    let up = 0;
    for (const t of this.torrents.values()) {
      const rate = rates.get(t) ?? { down: 0, up: 0 };
      const wanting = wantedLeft(t) > 0;
      const got = this.receive(t, (rate.down * dt) / 1000);
      const sent = (rate.up * dt) / 1000;
      t.downRate = Math.round(rate.down);
      t.upRate = Math.round(rate.up);
      t.downTotal += got;
      t.upTotal += sent;
      this.sessionDown += got;
      this.sessionUp += sent;
      this.diskFree = Math.max(0, this.diskFree - got);
      this.stats.lifetimeDown += got;
      this.stats.lifetimeUp += sent;
      // A finish that goes to the hash queue pauses the torrent, so it counts nothing towards the global rates.
      if (wanting && wantedLeft(t) <= 0) this.finished(t, nowS);
      down += t.downRate;
      up += t.upRate;
      t.peersConnected = this.peerCount(t, at);
    }
    this.downRate = down;
    this.upRate = up;
    for (const t of this.torrents.values()) this.announces(t, nowS);
    if (Math.floor(from / 1000) !== nowS) this.sample(nowS);
    this.fold(nowS);
  }

  /** What each torrent moves now, within its group's and the global limits. */
  private rates(at: number): Map<SimTorrent, { down: number; up: number }> {
    const rates = new Map<SimTorrent, { down: number; up: number }>();
    for (const t of this.torrents.values()) rates.set(t, this.rawRates(t, at));
    for (const [name, limit] of this.rtGroups) {
      const members = [...rates.entries()].filter(([t]) => t.throttle === name);
      for (const direction of ['down', 'up'] as const) {
        const cap = limit[direction];
        const sum = members.reduce((total, [, rate]) => total + rate[direction], 0);
        if (cap > 0 && sum > cap) for (const [, rate] of members) rate[direction] *= cap / sum;
      }
    }
    const global = { down: this.settings.downloadRate, up: this.settings.uploadRate };
    for (const direction of ['down', 'up'] as const) {
      const cap = global[direction];
      let sum = 0;
      for (const rate of rates.values()) sum += rate[direction];
      if (cap > 0 && sum > cap) for (const rate of rates.values()) rate[direction] *= cap / sum;
    }
    return rates;
  }

  private rawRates(t: SimTorrent, at: number): { down: number; up: number } {
    if (!t.open || !t.active || t.hashing > 0 || t.meta || t.priority === 0) return { down: 0, up: 0 };
    const weight = PRIORITY_WEIGHT[t.priority] ?? 1;
    const wanting = wantedLeft(t) > 0;
    const up = t.swarm.leechers > 0 ? t.swarm.up * level(t.swarm.upWave, at - this.origin) * weight : 0;
    if (!wanting) return { down: 0, up: isComplete(t) ? up : up * 0.5 };
    const progress = t.size > 0 ? completedBytes(t) / t.size : 0;
    return { down: t.swarm.down * level(t.swarm.downWave, at - this.origin) * weight, up: up * (0.35 + 0.65 * progress) };
  }

  /** Bytes in, spread over the wanted files: high priority first, then in proportion to what each lacks. */
  private receive(t: SimTorrent, bytes: number): number {
    let left = bytes;
    let written = 0;
    for (const priority of [2, 1]) {
      if (left <= 0) break;
      const open = t.files.filter((file) => file.priority === priority && file.done < file.size);
      const lacking = open.reduce((sum, file) => sum + (file.size - file.done), 0);
      if (lacking <= 0) continue;
      const share = Math.min(left, lacking);
      for (const file of open) {
        file.done += ((file.size - file.done) / lacking) * share;
        // Fractions of a byte left by the arithmetic are not a missing piece.
        if (file.size - file.done < 0.5) file.done = file.size;
      }
      written += share;
      left -= share;
    }
    return written;
  }

  /**
   * The last wanted piece arrived. libtorrent signals a finish only when
   * every file is complete, so one with files skipped stays a download. With
   * pieces.hash.on_completion on, as it is by default, the hash queue pauses
   * it, closes and reopens it and checks the data again; the check's end
   * confirms the finish.
   */
  private finished(t: SimTorrent, nowS: number): void {
    if (!isComplete(t)) return;
    this.info(t, 'download_list: Received finished.', nowS);
    if (!this.settings.checkHashOnCompletion) {
      this.confirmFinished(t, nowS);
      return;
    }
    this.info(t, 'download_list: Hash queue.', nowS);
    this.pause(t, nowS, STOP_SKIP_TRACKER);
    this.info(t, 'download: Closing torrent: flags:0.', nowS);
    this.info(t, 'file_list: Closing.', nowS);
    t.open = false;
    this.open(t, nowS);
    this.beginCheck(t, nowS, 2, t.files.map((file) => file.done), false, CACHED_CHECK_SPEED);
  }

  /**
   * confirm_finished: d.complete set, the finish stamped if it has no stamp,
   * the completed event sent — or queued, for a download the hash queue
   * paused, which then resumes without announcing again.
   */
  private confirmFinished(t: SimTorrent, nowS: number): void {
    this.info(t, 'download_list: Confirming finished.', nowS);
    t.complete = true;
    if (t.finishedAt === 0) t.finishedAt = nowS;
    this.track(`${t.hash}->tracker_controller: sending completed event : ${t.active ? 'requesting' : 'queued'}`, nowS);
    for (const tracker of t.trackers) {
      if (!tracker.enabled || tracker.failure) continue;
      tracker.pending = 'completed';
      if (t.active) tracker.nextActivity = nowS;
    }
    if (!t.active && t.open && t.state === 1) this.activate(t, nowS, START_NO_CREATE | START_SKIP_TRACKER | START_KEEP_BASELINE);
  }

  private peerCount(t: SimTorrent, at: number): number {
    if (!t.open || !t.active) return 0;
    if (t.meta) return 2 + (Math.floor((at - this.origin) / 7) % 3);
    const seeding = isComplete(t);
    if (seeding && t.swarm.leechers === 0) return 0;
    const cap = seeding && this.settings.maxPeersSeed >= 0 ? this.settings.maxPeersSeed : this.settings.maxPeers;
    const pool = seeding ? t.pool.filter((peer) => !peer.seed).length : t.pool.length;
    const typical = t.swarm.peers * (0.86 + 0.14 * Math.sin((at - this.origin) / 97 + t.swarm.phase * 6));
    return Math.max(0, Math.min(cap, pool, Math.round(typical)));
  }

  private announces(t: SimTorrent, nowS: number): void {
    if (!t.open || !t.active) return;
    for (const tracker of t.trackers) {
      if (!tracker.enabled || tracker.nextActivity === 0 || nowS < tracker.nextActivity) continue;
      this.announce(t, tracker, nowS);
    }
  }

  private announce(t: SimTorrent, tracker: SimTracker, nowS: number): void {
    const event = tracker.pending;
    const { rng } = t;
    this.track(sending(t, tracker, event), nowS);
    tracker.lastActivity = nowS;
    tracker.busyUntil = nowS + 1;
    if (tracker.failure) {
      tracker.failures += 1;
      tracker.lastFailure = nowS;
      const wait = Math.min(tracker.minInterval, 5 * 2 ** Math.min(10, tracker.failures - 1));
      tracker.nextFailure = tracker.nextActivity = nowS + wait;
      t.message = `Tracker: [${tracker.failure}]`;
      this.track(`${received(t, tracker, 'failure')} msg:'${tracker.failure}'`, nowS);
      this.track(
        `tracker_next_timeout_promiscuous: min_interval:${tracker.minInterval} use_interval:${wait} ` +
          `since_last:0 failed_counter:${tracker.failures} result:${wait}`,
        nowS,
      );
      return;
    }
    tracker.successes += 1;
    tracker.failures = 0;
    tracker.lastSuccess = nowS;
    tracker.nextActivity = nowS + tracker.interval;
    tracker.latestEvent = EVENT_CODE[event];
    tracker.pending = 'updated';
    tracker.sumPeers = tracker.type === 3 ? rng.int(6, 38) : Math.min(50, rng.int(18, 50));
    tracker.newPeers = rng.int(0, Math.ceil(tracker.sumPeers / 4));
    if (tracker.type !== 3) this.scrapeCounts(t, tracker);
    this.track(received(t, tracker, `${tracker.sumPeers} peers`), nowS);
    if (tracker.scrapable && tracker.successes % 2 === 1) {
      tracker.scrapes += 1;
      tracker.lastScrape = nowS;
      this.track(sending(t, tracker, 'scrape'), nowS);
    }
  }

  private scrapeCounts(t: SimTorrent, tracker: SimTracker): void {
    const drift = (n: number) => Math.max(0, Math.round(n * t.rng.range(0.96, 1.04)));
    tracker.seeders = drift(t.swarm.seeds);
    tracker.leechers = drift(t.swarm.leechers);
    tracker.downloaded = Math.max(tracker.downloaded, Math.round(t.swarm.seeds * 6.3 + t.swarm.leechers * 2));
  }

  private sample(nowS: number): void {
    this.history.push({ t: nowS, down: this.downRate, up: this.upRate });
    if (this.history.length > HISTORY_LENGTH) this.history.splice(0, this.history.length - HISTORY_LENGTH);
    // RecordRates: the peaks the badges look at are the sampled ones.
    this.stats.peakDownRate = Math.max(this.stats.peakDownRate, this.downRate);
    this.stats.peakUpRate = Math.max(this.stats.peakUpRate, this.upRate);
  }

  /** RecordTorrents: fold the listing into the lifetime counters, then unlock what they now earn. */
  private fold(nowS: number): void {
    const stats = this.stats;
    let seeding = 0;
    let peers = 0;
    const labels = new Set<string>();
    for (const t of this.torrents.values()) {
      // What the store goes by: the listing's progress.
      const complete = progressOf(t) >= 1;
      if (statusOf(t) === 'seeding') seeding += 1;
      peers += t.peersConnected;
      if (t.label) labels.add(t.label);
      stats.bestRatio = Math.max(stats.bestRatio, ratioPermille(t) / 1000);
      if (complete && !this.completedHashes.has(t.hash)) {
        this.completedHashes.add(t.hash);
        stats.completed += 1;
      }
      if (complete && t.finishedAt > 0 && nowS - t.finishedAt > stats.longestSeed + 60) stats.longestSeed = nowS - t.finishedAt;
    }
    stats.maxSeeding = Math.max(stats.maxSeeding, seeding);
    stats.peakPeers = Math.max(stats.peakPeers, peers);
    stats.maxLabels = Math.max(stats.maxLabels, labels.size);
    for (const id of newlyUnlocked(stats, this.unlockedAt)) this.unlockedAt[id] = nowS;
  }

  private applyRates(at: number): void {
    const rates = this.rates(at);
    let down = 0;
    let up = 0;
    for (const t of this.torrents.values()) {
      const rate = rates.get(t) ?? { down: 0, up: 0 };
      t.downRate = Math.round(rate.down);
      t.upRate = Math.round(rate.up);
      t.peersConnected = this.peerCount(t, at);
      down += t.downRate;
      up += t.upRate;
    }
    this.downRate = down;
    this.upRate = up;
  }

  /* --------------------------------- log ---------------------------------- */

  /** Whether a line reaches the log: its group attached, or for a severity, one at least as verbose. */
  private logging(group: string, letter: string): boolean {
    const on = (scope: string) => this.boot.includes(scope) || this.attached.has(scope);
    if (letter && SEVERITIES.includes(group)) {
      const rank = LETTERS.indexOf(letter);
      return SEVERITIES.some((scope, i) => i >= rank && on(scope));
    }
    return on(group) || (letter === 'D' && on('debug'));
  }

  private write(group: string, letter: string, text: string, at: number): void {
    if (!this.logging(group, letter)) return;
    this.lines.push(`${at} ${letter ? `${letter} ` : ''}${text}`);
    if (this.lines.length > LOG_KEEP * 1.5) this.lines = this.lines.slice(this.lines.length - LOG_KEEP);
  }

  private info(t: SimTorrent, text: string, at: number): void {
    this.write('info', 'I', `${t.hash}->${text}`, at);
  }

  private track(text: string, at: number): void {
    this.write('tracker_events', '', text, at);
  }

  /** A line of rtorrent's own, at the current time: an error severity, say, for a load it could not use. */
  note(letter: string, text: string): void {
    this.write(SEVERITIES[LETTERS.indexOf(letter)] ?? 'info', letter, text, Math.floor(this.time / 1000));
  }

  /* -------------------------------- seeding -------------------------------- */

  private layout(files: CatalogFile[]): SimFile[] {
    let offset = 0;
    return files.map(([path, size, priority]) => {
      const file = { path, size, offset, priority: priority ?? 1, done: 0 };
      offset += size;
      return file;
    });
  }

  /** A torrent with nothing known yet beyond its files: what an add starts from. */
  private blank(hash: string, name: string, files: CatalogFile[], multi: boolean, chunk: number, rng: Random): SimTorrent {
    const laid = this.layout(files);
    const size = laid.reduce((sum, file) => sum + file.size, 0);
    const swarmDown = rng.range(0.6, 3.2) * MiB;
    return {
      hash, name, files: laid, size, multi, isPrivate: false, chunk, createdAt: 0, label: '', parent: DOWNLOAD_DIR,
      frozen: DOWNLOAD_DIR, throttle: '', priority: 2, maxUploads: this.settings.maxUploads, maxDownloads: this.settings.maxDownloads,
      message: '', state: 0, complete: false, open: false, active: false, hashing: 0, check: null, unchecked: null, meta: null, everOpened: false,
      activeSince: 0, addedAt: 0, startedAt: 0, finishedAt: 0, downTotal: 0, upTotal: 0, downRate: 0, upRate: 0,
      peersConnected: 0,
      swarm: {
        down: swarmDown, up: swarmDown * rng.range(0.08, 0.2), seeds: rng.int(20, 900), leechers: rng.int(3, 120),
        peers: rng.int(6, 30), downWave: makeWave(rng, 1), upWave: makeWave(rng, 1), phase: rng.next(),
      },
      pool: [],
      trackers: [],
      rng,
    };
  }

  /** Into the session as a load does it: listed, its trackers added, started when asked. */
  private attach(t: SimTorrent, tiers: string[][], options: AddOptions): void {
    const nowS = Math.floor(this.time / 1000);
    if (!t.meta) t.parent = options.directory || this.settings.directory;
    t.label = options.label;
    t.addedAt = nowS;
    t.pool = this.peerPool(t, 0.6);
    tiers.forEach((tier, group) => tier.forEach((url) => t.trackers.push(this.makeTracker(t, url, group, false))));
    if (!t.isPrivate) t.trackers.push(this.makeTracker(t, 'dht://', tiers.length, false));
    for (const tracker of t.trackers) {
      this.track(`${t.hash}->tracker_list: added tracker : requester:${tracker.requester} group:${tracker.group} url:${tracker.url}`, nowS);
    }
    this.torrents.set(t.hash, t);
    this.info(t, 'download_list: Inserting download.', nowS);
    if (!this.seenHashes.has(t.hash)) {
      this.seenHashes.add(t.hash);
      this.stats.everAdded += 1;
    }
    if (options.start) {
      this.open(t, nowS);
      this.info(t, 'download: Checking hash: allocated:0 try_quick:1.', nowS);
      this.info(t, 'download_list: Hash done.', nowS);
      this.start(t, nowS);
    }
  }

  private makeTracker(t: SimTorrent, url: string, group: number, extra: boolean): SimTracker {
    const type = trackerType(url);
    return {
      url, type, group, enabled: true, extra,
      scrapable: type === 1 && /\/announce/i.test(url),
      failure: '',
      requester: `0x7c04${t.rng.hex(8)}`,
      interval: type === 3 ? 1200 : 1800,
      minInterval: type === 3 ? 300 : 900,
      successes: 0, failures: 0, scrapes: 0, lastSuccess: 0, lastFailure: 0, nextFailure: 0, lastScrape: 0,
      lastActivity: 0, nextActivity: 0, latestEvent: 0, pending: 'started', newPeers: 0, sumPeers: 0,
      seeders: 0, leechers: 0, downloaded: 0, busyUntil: 0,
    };
  }

  private peerPool(t: SimTorrent, seedShare: number): SimPeer[] {
    const rng = t.rng.fork('peers');
    const size = Math.max(10, t.swarm.peers * 2 + 6);
    const pool: SimPeer[] = [];
    const taken = new Set<string>();
    while (pool.length < size) {
      const peer = makePeer(rng, rng.chance(seedShare));
      // The Peers tab knows a peer by its address and port.
      if (taken.has(`${peer.address}:${peer.port}`)) continue;
      taken.add(`${peer.address}:${peer.port}`);
      pool.push(peer);
    }
    return pool;
  }

  private fromCatalog(entry: CatalogTorrent, now: number): SimTorrent {
    const nowS = Math.floor(now / 1000);
    const rng = this.rng.fork(`torrent:${entry.name}`);
    const hash = rng.hex(40).toUpperCase();
    const multi = entry.files !== undefined;
    const t = this.blank(hash, entry.name, entry.files ?? [[entry.name, entry.size ?? 0]], multi, entry.pieceLength, rng);
    const swing = entry.swing ?? 1;
    t.swarm = {
      down: entry.down, up: entry.up, seeds: entry.seeds, leechers: entry.leechers, peers: entry.peers,
      downWave: makeWave(rng, swing), upWave: makeWave(rng, swing), phase: rng.next(),
    };
    t.isPrivate = entry.isPrivate === true;
    t.label = entry.label;
    t.throttle = entry.throttle ?? '';
    t.priority = entry.priority ?? 2;
    t.createdAt = nowS - Math.round(entry.createdDays * DAY) - rng.int(0, 20_000);
    t.addedAt = nowS - Math.round(entry.addedDays * DAY);
    t.everOpened = true;
    const state = entry.state;
    t.state = state === 'stopped' ? 0 : 1;
    t.open = state !== 'stopped';
    t.active = state === 'seeding' || state === 'downloading';
    t.complete = entry.progress >= 1;
    // Started once, when it was added — but the one still on its first check has not started yet.
    t.startedAt = state === 'checking' ? 0 : t.addedAt;
    // The last resume, which no connected peer predates: this rtorrent's start, for one running since before it.
    t.activeSince = t.active ? Math.max(t.addedAt, this.startedAt) : 0;

    // What is on disk.
    if (entry.progress >= 1) {
      for (const file of t.files) file.done = file.size;
    } else {
      // Rarest first spreads a download over its files; a file set to high goes ahead of the rest.
      for (const file of t.files) {
        if (file.priority === 0) continue;
        const share = entry.progress * (file.priority === 2 ? 1.8 : 1) * rng.range(0.9, 1.1);
        file.done = file.size < t.chunk ? (rng.chance(share) ? file.size : 0) : Math.round(file.size * Math.min(1, share));
      }
    }
    if (entry.finishedDays !== undefined) {
      t.finishedAt = Math.min(nowS - 60, t.addedAt + rng.int(1_200, 10_800));
    }
    if (state === 'checking') {
      const target = t.files.map((file) => file.done);
      t.hashing = 1;
      t.active = false;
      t.check = { pos: (entry.checked ?? 0) * t.size, speed: entry.hashSpeed ?? 90 * MiB, target, restart: false };
      for (const file of t.files) {
        const read = file.size > 0 ? Math.min(1, Math.max(0, (t.check.pos - file.offset) / file.size)) : 1;
        file.done = file.done * read;
      }
    }

    t.pool = this.peerPool(t, state === 'downloading' ? 0.6 : 0.15);
    if (entry.steadyPeer) t.pool.unshift(steadyPeer(rng.fork('steady peer'), entry.steadyPeer));
    entry.trackers.forEach((tier, group) => tier.forEach((url) => t.trackers.push(this.makeTracker(t, url, group, false))));
    if (!t.isPrivate) t.trackers.push(this.makeTracker(t, 'dht://', entry.trackers.length, false));
    if (entry.failure) {
      // A tracker that never answered keeps rtorrent's defaults for both intervals.
      Object.assign(t.trackers[0], { failure: entry.failure, interval: 600, minInterval: 300 });
    }
    for (const tracker of t.trackers) this.historyOf(t, tracker, nowS, state);

    if (entry.finishIn !== undefined) {
      // Exactly what the steps between now and then will deliver, so it
      // completes on time: the rates are a function of the clock.
      let remaining = 0;
      const steps = Math.round((entry.finishIn * 1000) / STEP_MS);
      for (let i = 1; i <= steps; i++) remaining += (this.rawRates(t, (now + i * STEP_MS) / 1000).down * STEP_MS) / 1000;
      const share = Math.max(0, 1 - remaining / t.size);
      for (const file of t.files) file.done = file.size * share;
    }

    // A check under way has the data it is verifying on disk already.
    const done = t.check ? t.check.target.reduce((sum, n) => sum + n, 0) : completedBytes(t);
    t.downTotal = Math.round(done * rng.range(1.002, 1.012));
    t.upTotal = Math.round(entry.ratio * completedBytes(t) + rng.int(0, 1_000_000));
    return t;
  }

  /** A tracker's past, consistent with its torrent's: announces at its interval since it started. */
  private historyOf(t: SimTorrent, tracker: SimTracker, nowS: number, state: string): void {
    const rng = t.rng;
    tracker.seeders = 0;
    tracker.leechers = 0;
    if (state === 'checking') return; // The trackers start once the first check is done.
    const running = state === 'seeding' || state === 'downloading';
    const since = Math.max(t.startedAt, this.startedAt);
    if (tracker.failure) {
      tracker.failures = rng.int(31, 58);
      tracker.lastFailure = tracker.lastActivity = nowS - rng.int(15, 200);
      tracker.nextFailure = tracker.nextActivity = running ? tracker.lastActivity + tracker.minInterval : 0;
      tracker.latestEvent = 2;
      tracker.pending = 'started';
      return;
    }
    const elapsed = Math.max(0, (running ? nowS : t.finishedAt || t.addedAt + DAY) - since);
    const announces = 1 + Math.floor(elapsed / tracker.interval);
    tracker.successes = announces;
    tracker.latestEvent = announces > 1 ? 0 : 2;
    tracker.pending = 'updated';
    if (running) {
      // Spread over the coming interval, the first few within a minute or two.
      const next = this.stagger < 9 ? nowS + 7 + this.stagger * 11 : nowS + rng.int(120, tracker.interval);
      this.stagger += 1;
      tracker.lastActivity = tracker.lastSuccess = Math.max(since, next - tracker.interval);
      tracker.nextActivity = next;
    } else {
      tracker.lastActivity = tracker.lastSuccess = Math.max(t.addedAt, nowS - rng.int(2, 40) * DAY);
      tracker.latestEvent = 3;
      tracker.nextActivity = 0;
      tracker.pending = 'started';
    }
    tracker.sumPeers = tracker.type === 3 ? rng.int(6, 38) : rng.int(18, 50);
    tracker.newPeers = rng.int(0, 6);
    if (tracker.type !== 3) this.scrapeCounts(t, tracker);
    if (tracker.scrapable) {
      tracker.scrapes = Math.ceil(announces / 2);
      tracker.lastScrape = tracker.lastActivity;
    }
  }

  /** The graph's first three minutes, from the same rates the steps will use. */
  private prefillHistory(nowS: number): void {
    for (let s = nowS - HISTORY_LENGTH + 1; s <= nowS; s++) {
      const rates = this.rates(s);
      let down = 0;
      let up = 0;
      for (const rate of rates.values()) {
        down += Math.round(rate.down);
        up += Math.round(rate.up);
      }
      this.history.push({ t: s, down, up });
    }
  }

  /** The log's last hour: the announces the trackers' histories say happened, in order. */
  private prefillLog(nowS: number): void {
    const events: Array<[at: number, group: string, letter: string, text: string]> = [];
    const hour = nowS - 3600;
    const info = (at: number, t: SimTorrent, text: string) => events.push([at, 'info', 'I', `${t.hash}->${text}`]);
    const track = (at: number, text: string) => events.push([at, 'tracker_events', '', text]);
    for (const t of this.torrents.values()) {
      if (t.addedAt > hour) {
        info(t.addedAt, t, 'download_list: Inserting download.');
        // The one still on its first check has not started yet.
        if (t.startedAt > 0) {
          info(t.addedAt, t, 'download_list: Hash done.');
          info(t.addedAt, t, 'download: Starting torrent: flags:0.');
        }
      }
      if (t.check) {
        const began = nowS - Math.round(t.check.pos / t.check.speed);
        info(began, t, 'download_list: Checking hash.');
        info(began, t, `hash_torrent: start : position:0 size:${Math.ceil(t.size / t.chunk)} quick:1.`);
      }
      for (const tracker of t.trackers) {
        if (tracker.lastActivity <= hour || tracker.lastActivity > nowS) continue;
        if (tracker.failure) {
          for (let at = tracker.lastActivity; at > hour; at -= tracker.minInterval) {
            track(at, sending(t, tracker, 'updated'));
            track(at, `${received(t, tracker, 'failure')} msg:'${tracker.failure}'`);
          }
          continue;
        }
        const event = tracker.latestEvent === 3 ? 'stopped' : tracker.latestEvent === 2 ? 'started' : 'updated';
        track(tracker.lastActivity, sending(t, tracker, event));
        if (event !== 'stopped') track(tracker.lastActivity, received(t, tracker, `${tracker.sumPeers} peers`));
      }
    }
    events.sort((a, b) => a[0] - b[0]);
    for (const [at, group, letter, text] of events) this.write(group, letter, text, at);
  }

  /** The torrent's row as the listing maps it: progress and ETA from d.complete, the pieces from the data. */
  row(t: SimTorrent): Torrent {
    const completed = completedBytes(t);
    const left = t.size - completed;
    const allChunks = isComplete(t);
    const chunksTotal = Math.ceil(t.size / t.chunk);
    const peers = this.connected(t);
    const status = statusOf(t);
    return {
      hash: t.hash,
      name: t.name,
      status,
      progress: progressOf(t),
      size: t.size,
      completed,
      left,
      downRate: t.downRate,
      upRate: t.upRate,
      downTotal: Math.round(t.downTotal),
      upTotal: Math.round(t.upTotal),
      ratio: ratioPermille(t) / 1000,
      eta: t.complete ? 0 : t.downRate > 0 && left > 0 ? Math.round(left / t.downRate) : null,
      priority: t.priority,
      label: t.label,
      message: t.message,
      directory: directoryOf(t),
      basePath: basePathOf(t),
      throttle: t.throttle,
      isOpen: t.open,
      isActive: t.active,
      isPrivate: t.isPrivate,
      isMultiFile: t.multi,
      hashing: t.hashing,
      chunkSize: t.chunk,
      chunksDone: allChunks ? chunksTotal : Math.max(0, Math.min(chunksTotal - 1, Math.floor(completed / t.chunk))),
      chunksTotal,
      peersConnected: t.peersConnected,
      peersNotConnected: t.active ? Math.round(t.peersConnected * 0.6) + 3 : t.open ? 4 : 0,
      peersComplete: allChunks ? 0 : peers.filter(({ peer }) => peer.seed).length,
      trackerCount: t.trackers.length,
      addedAt: t.addedAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      createdAt: t.createdAt,
    };
  }
}
