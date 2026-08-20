/**
 * Application service: everything the HTTP layer needs, expressed in terms of
 * rtorrent commands chosen through the capability probe.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildGameState,
  newlyUnlocked,
  type GameState,
} from './achievements';
import { Capabilities } from './capabilities';
import type { Config } from './config';
import {
  FILE_FIELDS,
  PEER_FIELDS,
  TORRENT_FIELDS,
  TRACKER_FIELDS,
  mapFile,
  mapPeer,
  mapTorrent,
  mapTracker,
  trackerHost,
  type Peer,
  type Torrent,
  type TorrentFile,
  type Tracker,
} from './model';
import { RtorrentClient, type MulticallEntry } from './rtorrent';
import { Store, type ThrottleGroup } from './store';
import type { XValue } from './xmlrpc';

export interface GlobalSettings {
  downloadRate: number;
  uploadRate: number;
  maxUploads: number;
  maxUploadsGlobal: number;
  maxDownloads: number;
  maxDownloadsGlobal: number;
  maxPeers: number;
  minPeers: number;
  maxPeersSeed: number;
  minPeersSeed: number;
  maxOpenFiles: number;
  maxHttpOpen: number;
  memoryMax: number;
  portRange: string;
  portRandom: boolean;
  dhtMode: string;
  dhtPort: number;
  pex: boolean;
  udpTrackers: boolean;
  encryption: string;
  preallocate: boolean;
  checkHashOnCompletion: boolean;
  directory: string;
  sessionDirectory: string;
  bindAddress: string;
  localAddress: string;
  proxyAddress: string;
  httpCapath: string;
  httpCacert: string;
  xmlrpcSizeLimit: number;
  receiveBuffer: number;
  sendBuffer: number;
  maxFileSize: number;
  // Added in rtorrent 0.16; absent elsewhere and hidden by the capability probe.
  httpMaxHostConnections: number;
  blockOutgoing: boolean;
  dhtOverridePort: number;
  proxyGlobal: string;
  bindAddressV4: string;
  bindAddressV6: string;
  adviseRandomHashing: boolean;
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

export interface StateResponse {
  status: GlobalStatus;
  torrents: Torrent[];
  throttles: ThrottleGroup[];
  game: GameState;
}

const HISTORY_LENGTH = 180;

/** Settings exposed to the UI, keyed by the rtorrent command family behind them. */
/**
 * Getter command per setting. Some settings were renamed between releases —
 * 0.16 moved the listen-port commands under network.listen.* — so a setting can
 * list alternates, newest first, and the probe picks whichever exists.
 */
const SETTING_GETTERS: Array<[keyof GlobalSettings, string | string[]]> = [
  ['downloadRate', 'throttle.global_down.max_rate'],
  ['uploadRate', 'throttle.global_up.max_rate'],
  ['maxUploads', 'throttle.max_uploads'],
  ['maxUploadsGlobal', 'throttle.max_uploads.global'],
  ['maxDownloads', 'throttle.max_downloads'],
  ['maxDownloadsGlobal', 'throttle.max_downloads.global'],
  ['maxPeers', 'throttle.max_peers.normal'],
  ['minPeers', 'throttle.min_peers.normal'],
  ['maxPeersSeed', 'throttle.max_peers.seed'],
  ['minPeersSeed', 'throttle.min_peers.seed'],
  ['maxOpenFiles', 'network.max_open_files'],
  ['maxHttpOpen', ['network.http.max_open', 'network.http.max_total_connections']],
  ['memoryMax', 'pieces.memory.max'],
  ['portRange', ['network.listen.port.range', 'network.port_range']],
  ['portRandom', ['network.listen.port.random', 'network.port_random']],
  ['dhtMode', 'dht.mode'],
  ['dhtPort', 'dht.port'],
  ['pex', 'protocol.pex'],
  ['udpTrackers', 'trackers.use_udp'],
  ['encryption', 'protocol.encryption'],
  ['preallocate', 'system.file.allocate'],
  ['checkHashOnCompletion', 'pieces.hash.on_completion'],
  ['directory', 'directory.default'],
  ['sessionDirectory', 'session.path'],
  ['bindAddress', 'network.bind_address'],
  ['localAddress', 'network.local_address'],
  ['proxyAddress', 'network.http.proxy_address'],
  ['httpCapath', 'network.http.capath'],
  ['httpCacert', 'network.http.cacert'],
  ['receiveBuffer', 'network.receive_buffer.size'],
  ['sendBuffer', 'network.send_buffer.size'],
  ['maxFileSize', 'system.file.max_size'],
  ['httpMaxHostConnections', 'network.http.max_host_connections'],
  ['blockOutgoing', 'network.block.outgoing'],
  ['dhtOverridePort', 'dht.override_port'],
  ['proxyGlobal', 'network.proxy.global'],
  ['bindAddressV4', 'network.bind_address.ipv4'],
  ['bindAddressV6', 'network.bind_address.ipv6'],
  ['adviseRandomHashing', 'system.files.advise_random.hashing'],
];

export class RtorrentService {
  readonly client: RtorrentClient;
  readonly capabilities: Capabilities;
  private readonly history: RateSample[] = [];
  private lastError: string | undefined;
  private connected = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private throttlesApplied = false;
  private bootSettingsApplied = false;
  private lastGameUpdate = 0;

  constructor(private readonly config: Config, private readonly store: Store) {
    this.client = new RtorrentClient(config.scgi);
    this.capabilities = new Capabilities(
      this.client,
      TORRENT_FIELDS,
      FILE_FIELDS,
      PEER_FIELDS,
      TRACKER_FIELDS,
    );
  }

  /* ----------------------------- lifecycle ------------------------------ */

  startPolling(): void {
    if (this.pollTimer) return;
    const tick = async () => {
      try {
        await this.sampleRates();
        this.connected = true;
        this.lastError = undefined;
        if (!this.bootSettingsApplied) await this.applyBootSettings();
        if (!this.throttlesApplied) await this.reapplyThrottles();
        // Keep lifetime counters moving even when no browser is watching.
        if (this.config.gamify && Date.now() - this.lastGameUpdate > 30_000) {
          this.updateGame(await this.torrents());
        }
      } catch (error) {
        this.connected = false;
        this.throttlesApplied = false;
        this.bootSettingsApplied = false;
        this.capabilities.invalidate();
        this.lastError = (error as Error).message;
      }
    };
    void tick();
    this.pollTimer = setInterval(tick, this.config.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async sampleRates(): Promise<void> {
    const [down, up] = await this.client.multicall([
      { methodName: 'throttle.global_down.rate', params: [] },
      { methodName: 'throttle.global_up.rate', params: [] },
    ]);
    const downRate = Number(down) || 0;
    const upRate = Number(up) || 0;
    this.history.push({ t: Math.floor(Date.now() / 1000), down: downRate, up: upRate });
    if (this.config.gamify) this.store.recordRates(downRate, upRate);
    while (this.history.length > HISTORY_LENGTH) this.history.shift();
  }

  /**
   * Apply the settings passed as docker env vars.
   *
   * These deliberately do not go into rtorrent.rc: rtorrent aborts on an
   * unknown command in its config file, and the available commands differ
   * between 0.9.x, 0.10.x and 0.15.x. Routing them through updateSettings()
   * means the capability probe silently drops whatever this build lacks.
   */
  private async applyBootSettings(): Promise<void> {
    this.bootSettingsApplied = true;
    let raw: string;
    try {
      raw = await fs.readFile(this.config.bootSettingsFile, 'utf8');
    } catch {
      return; // Nothing to apply.
    }
    let patch: Partial<GlobalSettings>;
    try {
      patch = JSON.parse(raw) as Partial<GlobalSettings>;
    } catch (error) {
      console.warn(`[cascade] ignoring malformed ${this.config.bootSettingsFile}:`, (error as Error).message);
      return;
    }
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    await this.capabilities.ensure();
    const unsupported = keys.filter((key) => {
      const methods = SETTING_GETTERS.find(([name]) => name === key)?.[1];
      if (methods === undefined) return false;
      const candidates = Array.isArray(methods) ? methods : [methods];
      return !candidates.some((name) => this.capabilities.has(`${name}.set`));
    });
    try {
      await this.updateSettings(patch);
      console.log(
        `[cascade] applied ${keys.length - unsupported.length} startup setting(s) from the environment`,
      );
      if (unsupported.length > 0) {
        console.warn(
          `[cascade] rtorrent ${this.capabilities.info.clientVersion} does not support: ${unsupported.join(', ')}`,
        );
      }
    } catch (error) {
      console.warn('[cascade] could not apply startup settings:', (error as Error).message);
    }
  }

  /** rtorrent drops throttle groups on restart; put ours back. */
  private async reapplyThrottles(): Promise<void> {
    await this.capabilities.ensure();
    if (!this.capabilities.supports('throttleGroups')) {
      this.throttlesApplied = true;
      return;
    }
    const groups = this.store.throttles();
    if (groups.length > 0) {
      const entries: MulticallEntry[] = [];
      for (const group of groups) {
        entries.push({ methodName: 'throttle.up', params: ['', group.name, `${group.up}`] });
        entries.push({ methodName: 'throttle.down', params: ['', group.name, `${group.down}`] });
      }
      await this.client.multicallSettled(entries);
    }
    this.throttlesApplied = true;
  }

  /* ------------------------------- reads -------------------------------- */

  async state(): Promise<StateResponse> {
    await this.capabilities.ensure();
    const torrents = await this.torrents();
    const status = await this.status(torrents);
    this.updateGame(torrents);
    return {
      status,
      torrents,
      throttles: this.store.throttles(),
      game: this.game(),
    };
  }

  /* -------------------------------- game -------------------------------- */

  /** Fold the current list into the lifetime stats and unlock what is earned. */
  private updateGame(torrents: Torrent[]): void {
    if (!this.config.gamify) return;
    this.lastGameUpdate = Date.now();
    this.store.recordTorrents(torrents);
    for (const id of newlyUnlocked(this.store.stats, this.store.unlockedAchievements)) {
      this.store.unlock(id);
    }
  }

  game(): GameState {
    return buildGameState(
      this.store.stats,
      this.store.unlockedAchievements,
      this.config.gamify,
    );
  }

  async torrents(view = 'main'): Promise<Torrent[]> {
    await this.capabilities.ensure();
    const dialect = this.capabilities.dialect;
    const rows = await this.client.fieldMulticall(
      dialect.downloadMulticall,
      dialect.downloadMulticallPrefix(view),
      dialect.torrentFields,
    );
    const hashes = new Set<string>();
    const torrents = rows.map((row) => {
      const hash = String(row['d.hash'] ?? '');
      hashes.add(hash);
      return mapTorrent(row, this.store.addedAt(hash), '');
    });
    this.store.prune(hashes);
    return torrents;
  }

  async status(torrents?: Torrent[]): Promise<GlobalStatus> {
    await this.capabilities.ensure();
    const list = torrents ?? (await this.torrents());
    const entries: MulticallEntry[] = [
      { methodName: 'throttle.global_down.rate', params: [] },
      { methodName: 'throttle.global_up.rate', params: [] },
      { methodName: 'throttle.global_down.total', params: [] },
      { methodName: 'throttle.global_up.total', params: [] },
      { methodName: 'throttle.global_down.max_rate', params: [] },
      { methodName: 'throttle.global_up.max_rate', params: [] },
      { methodName: 'network.listen.port', params: [] },
    ];
    if (this.capabilities.supports('dhtStatistics')) {
      entries.push({ methodName: 'dht.statistics', params: [] });
    }
    const results = await this.client.multicallSettled(entries);
    const number = (index: number): number => {
      const value = results[index];
      return value instanceof Error ? 0 : Number(value) || 0;
    };
    let dhtNodes = 0;
    const dht = results[7];
    if (dht && !(dht instanceof Error) && typeof dht === 'object' && !Array.isArray(dht)) {
      dhtNodes = Number((dht as Record<string, XValue>).active_nodes ?? 0) || 0;
    }

    return {
      connected: this.connected,
      error: this.lastError,
      downRate: number(0),
      upRate: number(1),
      downTotal: number(2),
      upTotal: number(3),
      downLimit: number(4),
      upLimit: number(5),
      listenPort: number(6),
      dhtNodes,
      torrentCount: list.length,
      activeCount: list.filter((item) => item.status === 'downloading' || item.status === 'seeding')
        .length,
      backend: this.backendSummary(),
      history: [...this.history],
    };
  }

  /** First command name from the candidates that this backend implements. */
  private resolve(methods: string | string[]): string | undefined {
    const candidates = Array.isArray(methods) ? methods : [methods];
    return candidates.find((name) => this.capabilities.has(name));
  }

  backendSummary(): BackendSummary {
    const info = this.capabilities.info;
    return {
      clientVersion: info.clientVersion,
      libraryVersion: info.libraryVersion,
      apiVersion: info.apiVersion,
      flavor: info.flavor,
      methodCount: info.methodCount,
      rpcFacility: info.rpcFacility,
      endpoint: this.client.endpoint,
      supports: info.supports,
    };
  }

  async files(hash: string): Promise<TorrentFile[]> {
    await this.capabilities.ensure();
    const rows = await this.client.fieldMulticall(
      'f.multicall',
      [hash, ''],
      this.capabilities.dialect.fileFields,
    );
    return rows.map((row, index) => mapFile(row, index));
  }

  async peers(hash: string): Promise<Peer[]> {
    await this.capabilities.ensure();
    const rows = await this.client.fieldMulticall(
      'p.multicall',
      [hash, ''],
      this.capabilities.dialect.peerFields,
    );
    return rows.map(mapPeer);
  }

  async trackers(hash: string): Promise<Tracker[]> {
    await this.capabilities.ensure();
    const rows = await this.client.fieldMulticall(
      't.multicall',
      [hash, ''],
      this.capabilities.dialect.trackerFields,
    );
    return rows.map((row, index) => mapTracker(row, index));
  }

  /** Primary tracker host per torrent, used for the sidebar grouping. */
  async trackerHosts(hashes: string[]): Promise<Record<string, string>> {
    await this.capabilities.ensure();
    const entries: MulticallEntry[] = hashes.map((hash) => ({
      methodName: 't.multicall',
      params: [hash, '', 't.url='],
    }));
    const results = await this.client.multicallSettled(entries);
    const map: Record<string, string> = {};
    hashes.forEach((hash, index) => {
      const value = results[index];
      if (value instanceof Error || !Array.isArray(value) || value.length === 0) {
        map[hash] = 'unknown';
        return;
      }
      const first = value[0];
      const url = Array.isArray(first) ? String(first[0] ?? '') : String(first ?? '');
      map[hash] = trackerHost(url);
    });
    return map;
  }

  /* ------------------------------- writes ------------------------------- */

  async addTorrentFile(
    data: Buffer,
    options: { start: boolean; directory?: string; label?: string },
  ): Promise<void> {
    await this.capabilities.ensure();
    const method = options.start
      ? this.capabilities.dialect.loadRawStart
      : this.capabilities.dialect.loadRaw;
    await this.client.call(method, ['', data, ...this.loadCommands(options)]);
  }

  async addTorrentUrl(
    url: string,
    options: { start: boolean; directory?: string; label?: string },
  ): Promise<void> {
    await this.capabilities.ensure();
    const method = options.start
      ? this.capabilities.dialect.loadUrlStart
      : this.capabilities.dialect.loadUrl;
    await this.client.call(method, ['', url, ...this.loadCommands(options)]);
  }

  private loadCommands(options: { directory?: string; label?: string }): string[] {
    const commands: string[] = [];
    if (options.directory) commands.push(`d.directory.set="${escapeArg(options.directory)}"`);
    if (options.label && this.capabilities.supports('labels')) {
      commands.push(`d.custom1.set="${escapeArg(encodeURIComponent(options.label))}"`);
    }
    return commands;
  }

  async action(hash: string, action: string): Promise<void> {
    await this.capabilities.ensure();
    const entries: MulticallEntry[] = [];
    switch (action) {
      case 'start':
        entries.push({ methodName: 'd.open', params: [hash] });
        entries.push({ methodName: 'd.start', params: [hash] });
        break;
      case 'stop':
        entries.push({ methodName: 'd.stop', params: [hash] });
        entries.push({ methodName: 'd.close', params: [hash] });
        break;
      case 'pause':
        entries.push({ methodName: 'd.pause', params: [hash] });
        break;
      case 'resume':
        entries.push({ methodName: 'd.resume', params: [hash] });
        break;
      case 'recheck':
        entries.push({ methodName: 'd.stop', params: [hash] });
        entries.push({ methodName: 'd.check_hash', params: [hash] });
        break;
      case 'announce':
        entries.push({ methodName: 'd.tracker_announce', params: [hash] });
        break;
      default:
        throw new HttpError(400, `unknown action "${action}"`);
    }
    await this.client.multicall(entries);
  }

  async remove(hash: string, deleteData: boolean): Promise<void> {
    await this.capabilities.ensure();
    let basePath = '';
    if (deleteData) {
      if (!this.config.allowDataDelete) {
        throw new HttpError(403, 'deleting torrent data is disabled (CASCADE_ALLOW_DATA_DELETE=0)');
      }
      basePath = String(await this.client.call('d.base_path', [hash]));
    }
    await this.client.call('d.erase', [hash]);
    this.store.forget(hash);
    if (deleteData && basePath) await this.deleteData(basePath);
  }

  /** Only ever unlink paths that live inside a configured data root. */
  private async deleteData(basePath: string): Promise<void> {
    const resolved = path.resolve(basePath);
    const allowed = this.config.deleteRoots.some(
      (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
    );
    if (!allowed) {
      throw new HttpError(
        403,
        `refusing to delete "${resolved}": it is outside the permitted data roots (${this.config.deleteRoots.join(', ') || 'none'})`,
      );
    }
    if (this.config.deleteRoots.includes(resolved)) {
      throw new HttpError(403, `refusing to delete the data root itself (${resolved})`);
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }

  async setPriority(hash: string, priority: number): Promise<void> {
    await this.client.call('d.priority.set', [hash, priority]);
  }

  async setLabel(hash: string, label: string): Promise<void> {
    await this.capabilities.ensure();
    if (!this.capabilities.supports('labels')) {
      throw new HttpError(501, 'this rtorrent build does not expose d.custom1');
    }
    await this.client.call('d.custom1.set', [hash, encodeURIComponent(label)]);
  }

  async setTorrentThrottle(hash: string, name: string): Promise<void> {
    await this.capabilities.ensure();
    if (!this.capabilities.supports('perTorrentThrottle')) {
      throw new HttpError(501, 'this rtorrent build does not expose d.throttle_name');
    }
    // rtorrent rejects a throttle change while the download is running
    // ("Cannot set throttle on active download"), so bounce it around the set.
    // These go out as separate requests on purpose: batching stop/set/start
    // into one system.multicall segfaults rtorrent 0.15.2.
    const state = await this.client.call('d.is_active', [hash]);
    const wasActive = Number(state) !== 0;
    if (wasActive) await this.client.call('d.stop', [hash]);
    await this.client.call('d.throttle_name.set', [hash, name]);
    if (wasActive) await this.client.call('d.start', [hash]);
    await this.client.call('d.save_full_session', [hash]);
  }

  async setTorrentSlots(hash: string, uploads?: number, downloads?: number): Promise<void> {
    await this.capabilities.ensure();
    const entries: MulticallEntry[] = [];
    if (uploads !== undefined && this.capabilities.supports('perTorrentMaxUploads')) {
      entries.push({ methodName: 'd.uploads_max.set', params: [hash, uploads] });
    }
    if (downloads !== undefined && this.capabilities.supports('perTorrentMaxDownloads')) {
      entries.push({ methodName: 'd.downloads_max.set', params: [hash, downloads] });
    }
    if (entries.length > 0) await this.client.multicall(entries);
  }

  async moveDirectory(hash: string, directory: string): Promise<void> {
    await this.client.multicall([
      { methodName: 'd.directory.set', params: [hash, directory] },
      { methodName: 'd.save_full_session', params: [hash] },
    ]);
  }

  async setFilePriority(hash: string, index: number, priority: number): Promise<void> {
    await this.client.multicall([
      { methodName: 'f.priority.set', params: [`${hash}:f${index}`, priority] },
      { methodName: 'd.update_priorities', params: [hash] },
    ]);
  }

  async setTrackerEnabled(hash: string, index: number, enabled: boolean): Promise<void> {
    await this.client.call('t.is_enabled.set', [`${hash}:t${index}`, enabled ? 1 : 0]);
  }

  async addTracker(hash: string, url: string, group = 0): Promise<void> {
    await this.capabilities.ensure();
    if (!this.capabilities.supports('trackerInsert')) {
      throw new HttpError(501, 'this rtorrent build does not expose d.tracker.insert');
    }
    await this.client.multicall([
      { methodName: 'd.tracker.insert', params: [hash, group, url] },
      { methodName: 'd.save_full_session', params: [hash] },
    ]);
  }

  /* ------------------------------ settings ------------------------------ */

  async settings(): Promise<Partial<GlobalSettings>> {
    await this.capabilities.ensure();
    const usable = SETTING_GETTERS.map(([key, methods]) => [key, this.resolve(methods)] as const)
      .filter((entry): entry is readonly [keyof GlobalSettings, string] => entry[1] !== undefined);
    const results = await this.client.multicallSettled(
      usable.map(([, method]) => ({ methodName: method, params: [] })),
    );
    const settings: Record<string, XValue> = {};
    usable.forEach(([key], index) => {
      const value = results[index];
      if (value instanceof Error) return;
      settings[key] = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    });
    // Normalise the boolean-ish values rtorrent returns as 0/1.
    for (const key of [
      'portRandom',
      'pex',
      'udpTrackers',
      'preallocate',
      'checkHashOnCompletion',
      'blockOutgoing',
      'adviseRandomHashing',
    ]) {
      if (key in settings) settings[key] = Number(settings[key]) !== 0;
    }
    return settings as Partial<GlobalSettings>;
  }

  async updateSettings(patch: Partial<GlobalSettings>): Promise<void> {
    await this.capabilities.ensure();
    const entries: MulticallEntry[] = [];
    // rtorrent commands are invoked against a target; the empty string selects
    // the global/"download-less" target that these settings live on. Omitting
    // it makes rtorrent read the value as a target and fault with -503.
    const push = (method: string | string[], ...values: XValue[]) => {
      const resolved = this.resolve(method);
      if (resolved) entries.push({ methodName: resolved, params: ['', ...values] });
    };

    const number = (value: unknown): number => Math.max(0, Math.trunc(Number(value) || 0));

    if (patch.downloadRate !== undefined)
      push('throttle.global_down.max_rate.set', number(patch.downloadRate));
    if (patch.uploadRate !== undefined)
      push('throttle.global_up.max_rate.set', number(patch.uploadRate));
    if (patch.maxUploads !== undefined) push('throttle.max_uploads.set', number(patch.maxUploads));
    if (patch.maxUploadsGlobal !== undefined)
      push('throttle.max_uploads.global.set', number(patch.maxUploadsGlobal));
    if (patch.maxDownloads !== undefined)
      push('throttle.max_downloads.set', number(patch.maxDownloads));
    if (patch.maxDownloadsGlobal !== undefined)
      push('throttle.max_downloads.global.set', number(patch.maxDownloadsGlobal));
    if (patch.maxPeers !== undefined) push('throttle.max_peers.normal.set', number(patch.maxPeers));
    if (patch.minPeers !== undefined) push('throttle.min_peers.normal.set', number(patch.minPeers));
    if (patch.maxPeersSeed !== undefined)
      push('throttle.max_peers.seed.set', number(patch.maxPeersSeed));
    if (patch.minPeersSeed !== undefined)
      push('throttle.min_peers.seed.set', number(patch.minPeersSeed));
    if (patch.maxOpenFiles !== undefined)
      push('network.max_open_files.set', number(patch.maxOpenFiles));
    // 0.16 dropped network.http.max_open; its max_total_connections successor
    // registers a .set that has no effect, so the value is read-only there and
    // the UI greys the field out rather than pretending it applied.
    if (patch.maxHttpOpen !== undefined) push('network.http.max_open.set', number(patch.maxHttpOpen));
    if (patch.memoryMax !== undefined) push('pieces.memory.max.set', number(patch.memoryMax));
    if (patch.portRange !== undefined) {
      push(['network.listen.port.range.set', 'network.port_range.set'], String(patch.portRange));
    }
    if (patch.portRandom !== undefined) {
      push(['network.listen.port.random.set', 'network.port_random.set'], patch.portRandom ? 1 : 0);
    }
    if (patch.dhtMode !== undefined) push('dht.mode.set', String(patch.dhtMode));
    if (patch.dhtPort !== undefined) push('dht.port.set', number(patch.dhtPort));
    if (patch.pex !== undefined) push('protocol.pex.set', patch.pex ? 1 : 0);
    if (patch.udpTrackers !== undefined) push('trackers.use_udp.set', patch.udpTrackers ? 1 : 0);
    if (patch.encryption !== undefined) {
      // rtorrent takes each encryption flag as its own argument, mirroring the
      // comma-separated form used in rtorrent.rc.
      const flags = String(patch.encryption)
        .split(',')
        .map((flag) => flag.trim())
        .filter(Boolean);
      push('protocol.encryption.set', ...(flags.length > 0 ? flags : ['none']));
    }
    if (patch.preallocate !== undefined) push('system.file.allocate.set', patch.preallocate ? 1 : 0);
    if (patch.checkHashOnCompletion !== undefined)
      push('pieces.hash.on_completion.set', patch.checkHashOnCompletion ? 1 : 0);
    if (patch.directory !== undefined) push('directory.default.set', String(patch.directory));
    if (patch.bindAddress !== undefined) push('network.bind_address.set', String(patch.bindAddress));
    if (patch.localAddress !== undefined)
      push('network.local_address.set', String(patch.localAddress));
    if (patch.proxyAddress !== undefined)
      push('network.http.proxy_address.set', String(patch.proxyAddress));
    if (patch.httpCapath !== undefined) push('network.http.capath.set', String(patch.httpCapath));
    if (patch.httpCacert !== undefined) push('network.http.cacert.set', String(patch.httpCacert));
    if (patch.xmlrpcSizeLimit !== undefined)
      push('network.xmlrpc.size_limit.set', number(patch.xmlrpcSizeLimit));
    if (patch.receiveBuffer !== undefined)
      push('network.receive_buffer.size.set', number(patch.receiveBuffer));
    if (patch.sendBuffer !== undefined) push('network.send_buffer.size.set', number(patch.sendBuffer));
    if (patch.maxFileSize !== undefined) push('system.file.max_size.set', number(patch.maxFileSize));
    if (patch.httpMaxHostConnections !== undefined) {
      push('network.http.max_host_connections.set', number(patch.httpMaxHostConnections));
    }
    if (patch.blockOutgoing !== undefined) {
      push('network.block.outgoing.set', patch.blockOutgoing ? 1 : 0);
    }
    if (patch.dhtOverridePort !== undefined) {
      push('dht.override_port.set', number(patch.dhtOverridePort));
    }
    if (patch.proxyGlobal !== undefined) push('network.proxy.global.set', String(patch.proxyGlobal));
    if (patch.bindAddressV4 !== undefined) {
      push('network.bind_address.ipv4.set', String(patch.bindAddressV4));
    }
    if (patch.bindAddressV6 !== undefined) {
      push('network.bind_address.ipv6.set', String(patch.bindAddressV6));
    }
    if (patch.adviseRandomHashing !== undefined) {
      push('system.files.advise_random.hashing.set', patch.adviseRandomHashing ? 1 : 0);
    }

    if (entries.length === 0) return;
    await this.client.multicall(entries);
  }

  /* ---------------------------- throttle groups -------------------------- */

  async saveThrottle(group: ThrottleGroup): Promise<void> {
    await this.capabilities.ensure();
    if (!this.capabilities.supports('throttleGroups')) {
      throw new HttpError(501, 'this rtorrent build does not support throttle groups');
    }
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(group.name)) {
      throw new HttpError(400, 'throttle name must be 1-32 chars of [A-Za-z0-9_.-]');
    }
    await this.client.multicall([
      { methodName: 'throttle.up', params: ['', group.name, `${Math.max(0, group.up)}`] },
      { methodName: 'throttle.down', params: ['', group.name, `${Math.max(0, group.down)}`] },
    ]);
    this.store.upsertThrottle(group);
  }

  async deleteThrottle(name: string): Promise<void> {
    await this.capabilities.ensure();
    if (this.capabilities.supports('throttleGroups')) {
      // rtorrent cannot drop a throttle group at runtime; unlimit it instead so
      // torrents still assigned to it are no longer restricted.
      await this.client.multicallSettled([
        { methodName: 'throttle.up', params: ['', name, '0'] },
        { methodName: 'throttle.down', params: ['', name, '0'] },
      ]);
    }
    this.store.removeThrottle(name);
  }

  async throttleRates(): Promise<Record<string, { up: number; down: number }>> {
    await this.capabilities.ensure();
    const groups = this.store.throttles();
    if (groups.length === 0 || !this.capabilities.has('throttle.up.rate')) return {};
    const entries: MulticallEntry[] = [];
    for (const group of groups) {
      entries.push({ methodName: 'throttle.up.rate', params: ['', group.name] });
      entries.push({ methodName: 'throttle.down.rate', params: ['', group.name] });
    }
    const results = await this.client.multicallSettled(entries);
    const rates: Record<string, { up: number; down: number }> = {};
    groups.forEach((group, index) => {
      const up = results[index * 2];
      const down = results[index * 2 + 1];
      rates[group.name] = {
        up: up instanceof Error ? 0 : Number(up) || 0,
        down: down instanceof Error ? 0 : Number(down) || 0,
      };
    });
    return rates;
  }

  /* -------------------------------- misc -------------------------------- */

  async log(lines: number): Promise<string[]> {
    try {
      const content = await fs.readFile(this.config.logFile, 'utf8');
      return content.split('\n').filter(Boolean).slice(-lines);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw error;
    }
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** rtorrent's command parser uses double quotes around loading commands. */
function escapeArg(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
