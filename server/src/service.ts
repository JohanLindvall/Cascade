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
import { HttpError } from './errors';
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
import {
  RtorrentClient,
  settledNumber,
  type MulticallEntry,
  type RpcClient,
} from './rtorrent';
import {
  decodeSettingValue,
  readableSettings,
  settingEntries,
  unsupportedSettingKeys,
  type GlobalSettings,
} from './settings';
import { Store, type ThrottleGroup } from './store';
import { magnetInfoHash, parseTorrentFile } from './torrentfile';
import type { XValue } from './xmlrpc';

export type { GlobalSettings };

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
  /** Free bytes on the download volume; null when it cannot be determined. */
  diskFree: number | null;
  /** rtorrent's default download directory, shown as the Add dialog's default. */
  downloadDir: string;
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

/** How a torrent is added: started or not, and where and under what label. */
export interface LoadOptions {
  start: boolean;
  directory?: string;
  label?: string;
}

/** The log-verbosity state the dialog shows. */
export interface LogScopeState {
  /** Baked into rtorrent.rc by RT_LOG_LEVEL; fixed until the container restarts. */
  boot: string[];
  /** Raised from the UI on top of that; live, persisted, re-applied. */
  extra: string[];
  available: string[];
  supported: boolean;
}

const HISTORY_LENGTH = 180;
const THROTTLE_NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;

/**
 * The log scopes the UI may attach at runtime, which is also the input
 * allowlist: rtorrent faults on a name it does not know, and there is no
 * reason to let arbitrary strings ride to it.
 *
 * This is a union across the supported releases, because the subsystem
 * groups moved — measured against real builds rather than guessed at:
 * 0.9.8 has connection/dht/peer/tracker_debug and no tracker_events, while
 * 0.16.20 dropped those four and offers tracker_events instead; the six
 * severities plus storage_debug, torrent_debug and rpc_events exist in
 * both. There is no command that lists groups and attaching is the only
 * probe (and cannot be undone), so the offer is the union and a scope this
 * build refuses is reported by name rather than sinking the batch.
 */
export const LOG_SCOPES = [
  'critical',
  'error',
  'warn',
  'notice',
  'info',
  'debug',
  'connection_debug',
  'dht_debug',
  'peer_debug',
  'rpc_events',
  'storage_debug',
  'torrent_debug',
  'tracker_debug',
  'tracker_events',
] as const;

/** Keep the known scopes of a request, in catalog order, deduplicated. */
export function sanitizeLogScopes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const wanted = new Set(input.map(String));
  return LOG_SCOPES.filter((scope) => wanted.has(scope));
}

/**
 * Torrents to start again once their hash check finishes.
 *
 * "Recheck & restart" exists for rtorrent's own dead end: "Download
 * registered as completed, but hash check returned unfinished chunks" stops
 * the torrent, and a plain recheck leaves it stopped when the check ends —
 * so fixing it by hand is two actions timed around a progress bar. The
 * check itself can run for however long the disk takes, far past any HTTP
 * request, so the action only *registers* the wish here and the poll tick
 * feeds readings in until one of them says start.
 *
 * The decision is pure so it can be tested: feed it d.hashing readings and
 * it answers wait, start or drop. A reading above zero proves the check is
 * running (rtorrent marks even a queued check); the first zero after that
 * means it finished. A check so fast every poll missed it entirely is
 * covered by the zero-reading floor — after a few polls of nothing, the
 * only explanation left is that it already ran.
 */
export class PendingRestarts {
  private readonly entries = new Map<
    string,
    { sawHashing: boolean; zeroReads: number; since: number }
  >();

  /** How long a pending restart may wait: a full rehash of a huge torrent
   *  on a slow disk is hours, so the ceiling is generous. */
  static readonly MAX_AGE_MS = 24 * 60 * 60 * 1000;
  /** Zero readings that mean "the check came and went between polls". */
  static readonly ZERO_READS_FLOOR = 3;

  add(hash: string, now = Date.now()): void {
    this.entries.set(hash, { sawHashing: false, zeroReads: 0, since: now });
  }

  get size(): number {
    return this.entries.size;
  }

  hashes(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Fold one d.hashing reading in. null means the torrent could not be
   * asked (erased, or the call faulted): nothing left to restart.
   */
  step(hash: string, hashing: number | null, now = Date.now()): 'wait' | 'start' | 'drop' {
    const entry = this.entries.get(hash);
    if (!entry) return 'drop';
    if (hashing === null || now - entry.since > PendingRestarts.MAX_AGE_MS) {
      this.entries.delete(hash);
      return 'drop';
    }
    if (hashing > 0) {
      entry.sawHashing = true;
      entry.zeroReads = 0;
      return 'wait';
    }
    entry.zeroReads += 1;
    if (entry.sawHashing || entry.zeroReads >= PendingRestarts.ZERO_READS_FLOOR) {
      this.entries.delete(hash);
      return 'start';
    }
    return 'wait';
  }
}

export class RtorrentService {
  readonly client: RpcClient;
  readonly capabilities: Capabilities;
  private readonly history: RateSample[] = [];
  private lastError: string | undefined;
  private connected = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private throttlesApplied = false;
  private bootSettingsApplied = false;
  private lastGameUpdate = 0;
  private readonly pendingRestarts = new PendingRestarts();
  /** Scopes attached to the log during this rtorrent session. Reset when the
   *  connection drops: a restarted rtorrent has forgotten them. */
  private attachedScopes = new Set<string>();
  private logScopesApplied = false;

  /** The client defaults to the configured SCGI endpoint; tests pass a scripted one. */
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    client: RpcClient = new RtorrentClient(config.scgi),
  ) {
    this.client = client;
    this.capabilities = new Capabilities(client, {
      torrent: TORRENT_FIELDS,
      file: FILE_FIELDS,
      peer: PEER_FIELDS,
      tracker: TRACKER_FIELDS,
    });
  }

  /* ----------------------------- lifecycle ------------------------------ */

  /**
   * Sample rates and run the housekeeping on a timer. Ticks are chained rather
   * than scheduled on an interval: a slow or hung rtorrent (the SCGI timeout
   * is 30s) would otherwise stack a tick per second behind the request queue.
   */
  startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    const tick = async () => {
      try {
        await this.sampleRates();
        this.connected = true;
        this.lastError = undefined;
        if (!this.bootSettingsApplied) await this.applyBootSettings();
        if (!this.throttlesApplied) await this.reapplyThrottles();
        if (!this.logScopesApplied) await this.reapplyLogScopes();
        await this.processPendingRestarts();
        // Keep lifetime counters moving even when no browser is watching.
        if (this.config.gamify && Date.now() - this.lastGameUpdate > 30_000) {
          this.updateGame(await this.torrents());
        }
      } catch (error) {
        this.connected = false;
        this.throttlesApplied = false;
        this.bootSettingsApplied = false;
        this.logScopesApplied = false;
        this.attachedScopes.clear();
        this.capabilities.invalidate();
        this.lastError = (error as Error).message;
      }
      if (!this.polling) return;
      this.pollTimer = setTimeout(tick, this.config.pollIntervalMs);
      this.pollTimer.unref?.();
    };
    void tick();
  }

  stopPolling(): void {
    this.polling = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
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
    const unsupported = unsupportedSettingKeys(keys, this.resolveMethod);
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

  /** rtorrent forgets runtime log outputs on restart; put ours back. */
  private async reapplyLogScopes(): Promise<void> {
    await this.capabilities.ensure();
    this.logScopesApplied = true;
    if (!this.capabilities.supports('logScopes')) return;
    const extra = sanitizeLogScopes(this.store.logScopes());
    if (extra.length === 0) return;
    const failed = await this.attachScopes(extra);
    if (failed.length > 0) {
      // Kept in the store all the same: a scope this build refuses may be
      // one the next build accepts, and losing the owner's choice over a
      // version change would be the quieter, worse failure.
      console.warn(`[cascade] this rtorrent has no log scope(s): ${failed.join(', ')}`);
    }
  }

  logScopes(): LogScopeState {
    return {
      // What RT_LOG_LEVEL baked into rtorrent.rc at container start — shown
      // as fixed, since the rc reasserts it on every rtorrent start.
      boot: this.config.logLevel
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean),
      extra: sanitizeLogScopes(this.store.logScopes()),
      available: [...LOG_SCOPES],
      supported: this.capabilities.supports('logScopes'),
    };
  }

  /**
   * Set the scopes raised on top of RT_LOG_LEVEL.
   *
   * Raising is live: log.add_output attaches a scope to the running log.
   * Lowering is not — rtorrent has no command to detach one — so a removed
   * scope keeps writing until rtorrent restarts, and is simply not put back
   * afterwards. The dialog says as much rather than pretending.
   */
  async setLogScopes(requested: unknown): Promise<{ stillActive: string[]; failed: string[] }> {
    await this.capabilities.ensure();
    if (!this.capabilities.supports('logScopes')) {
      throw new HttpError(501, 'this rtorrent build does not expose log.add_output');
    }
    const scopes = sanitizeLogScopes(requested);
    const previous = new Set(this.store.logScopes());
    // A scope this build refuses must not sink the rest: the subsystem
    // groups differ between releases (see LOG_SCOPES), so one stale name is
    // ordinary, not exceptional. What took is kept; what did not is named.
    const failed = await this.attachScopes(scopes);
    this.store.setLogScopes(scopes.filter((scope) => !failed.includes(scope)));
    // What was on and stays on for this rtorrent session despite being
    // switched off — there is nothing to detach it with.
    const stillActive = [...previous].filter(
      (scope) => !scopes.includes(scope) && this.attachedScopes.has(scope),
    );
    return { stillActive, failed };
  }

  /** Attach scopes to the running log; returns the ones this build refused. */
  private async attachScopes(scopes: string[]): Promise<string[]> {
    const missing = scopes.filter((scope) => !this.attachedScopes.has(scope));
    if (missing.length === 0) return [];
    const results = await this.client.multicallSettled(
      // "cascade" is the output the entrypoint opened in rtorrent.rc.
      missing.map((scope) => ({ methodName: 'log.add_output', params: ['', scope, 'cascade'] })),
    );
    const failed: string[] = [];
    missing.forEach((scope, index) => {
      if (results[index] instanceof Error) failed.push(scope);
      else this.attachedScopes.add(scope);
    });
    return failed;
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
      return mapTorrent(row, this.store.addedAt(hash));
    });
    // Only the complete list may drive pruning: a filtered view would look
    // like every other torrent had been removed and erase its bookkeeping.
    if (view === 'main') this.store.prune(hashes);
    return torrents;
  }

  async status(torrents?: Torrent[]): Promise<GlobalStatus> {
    await this.capabilities.ensure();
    const list = torrents ?? (await this.torrents());
    const methods = [
      'throttle.global_down.rate',
      'throttle.global_up.rate',
      'throttle.global_down.total',
      'throttle.global_up.total',
      'throttle.global_down.max_rate',
      'throttle.global_up.max_rate',
      'network.listen.port',
      'directory.default',
    ];
    if (this.capabilities.supports('dhtStatistics')) methods.push('dht.statistics');
    const results = await this.client.multicallSettled(
      methods.map((methodName) => ({ methodName, params: [] })),
    );
    // Answers are looked up by command rather than by position, so an entry
    // added above another cannot silently shift it into the wrong slot.
    const answer = (method: string) => results[methods.indexOf(method)];
    const number = (method: string) => settledNumber(answer(method));

    let dhtNodes = 0;
    const dht = answer('dht.statistics');
    if (dht && !(dht instanceof Error) && typeof dht === 'object' && !Array.isArray(dht)) {
      dhtNodes = Number((dht as Record<string, XValue>).active_nodes ?? 0) || 0;
    }
    const directory = answer('directory.default');

    return {
      connected: this.connected,
      error: this.lastError,
      downRate: number('throttle.global_down.rate'),
      upRate: number('throttle.global_up.rate'),
      downTotal: number('throttle.global_down.total'),
      upTotal: number('throttle.global_up.total'),
      downLimit: number('throttle.global_down.max_rate'),
      upLimit: number('throttle.global_up.max_rate'),
      listenPort: number('network.listen.port'),
      dhtNodes,
      diskFree: await this.freeSpace(),
      downloadDir: Buffer.isBuffer(directory)
        ? directory.toString('utf8')
        : typeof directory === 'string'
          ? directory
          : '',
      torrentCount: list.length,
      activeCount: list.filter((item) => item.status === 'downloading' || item.status === 'seeding')
        .length,
      backend: this.backendSummary(),
      history: [...this.history],
    };
  }

  /** Free space on the download volume, or null where statfs is unavailable. */
  private async freeSpace(): Promise<number | null> {
    try {
      const stats = await fs.statfs(this.config.downloadDir);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return null;
    }
  }

  /** First command name from the candidates that this backend implements. */
  private readonly resolveMethod = (methods: string | string[]): string | undefined => {
    const candidates = Array.isArray(methods) ? methods : [methods];
    return candidates.find((name) => this.capabilities.has(name));
  };

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

  async addTorrentFile(data: Buffer, options: LoadOptions): Promise<void> {
    await this.capabilities.ensure();

    // rtorrent reports success for anything, so reject junk before handing it
    // over — otherwise a mistyped file just vanishes.
    let parsed;
    try {
      parsed = parseTorrentFile(data);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }

    const method = options.start
      ? this.capabilities.dialect.loadRawStart
      : this.capabilities.dialect.loadRaw;
    await this.client.call(method, ['', data, ...this.loadCommands(options)]);

    // load.* is queued rather than immediate, so confirm the torrent actually
    // landed instead of assuming it did.
    if (!(await this.waitForTorrent(parsed.infoHash))) {
      throw new HttpError(
        502,
        `rtorrent did not accept "${parsed.name || parsed.infoHash}" — see the rtorrent log`,
      );
    }
  }

  /** Poll briefly for a hash to appear in the session. */
  private async waitForTorrent(hash: string, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [result] = await this.client.multicallSettled([
        { methodName: 'd.hash', params: [hash] },
      ]);
      if (!(result instanceof Error) && String(result).toUpperCase() === hash) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async addTorrentUrl(url: string, options: LoadOptions): Promise<void> {
    await this.capabilities.ensure();
    // load.* silently queues whatever it is given; a link rtorrent cannot fetch
    // would just vanish, so refuse anything that is not fetchable up front.
    const link = url.trim();
    if (!/^(magnet:\?|https?:\/\/|ftp:\/\/)/i.test(link)) {
      throw new HttpError(
        400,
        `"${link.slice(0, 80)}" is not a magnet link or a torrent URL (magnet:, http(s):, ftp:)`,
      );
    }
    const method = options.start
      ? this.capabilities.dialect.loadUrlStart
      : this.capabilities.dialect.loadUrl;

    // A magnet carries its own info hash, so the load can be confirmed exactly.
    // For a fetched URL there is nothing to compare against, so note what the
    // session held first and watch for something new to appear.
    const wanted = magnetInfoHash(link);
    if (wanted) {
      await this.client.call(method, ['', link, ...this.loadCommands(options)]);
      if (await this.waitForTorrent(wanted)) return;
      throw new HttpError(
        502,
        `rtorrent did not accept the magnet for ${wanted} \u2014 see the rtorrent log`,
      );
    }

    const before = await this.sessionHashes();
    await this.client.call(method, ['', link, ...this.loadCommands(options)]);

    // rtorrent has to fetch the file first, so allow longer than a raw upload.
    // The wait is bounded, so the wording admits that a slow fetch may still
    // land rather than claiming the link is definitely broken.
    if (await this.waitForNewTorrent(before, 10_000)) return;
    throw new HttpError(
      502,
      `rtorrent loaded nothing from "${link.slice(0, 120)}" within 10s \u2014 the link may need ` +
        'a login, may not point at a .torrent, or may already be loaded. Check the rtorrent log; ' +
        'if it was merely slow it may still appear.',
    );
  }

  /** Every info hash currently in the session. */
  private async sessionHashes(): Promise<Set<string>> {
    const dialect = this.capabilities.dialect;
    const rows = await this.client.fieldMulticall(
      dialect.downloadMulticall,
      dialect.downloadMulticallPrefix('main'),
      ['d.hash'],
    );
    return new Set(rows.map((row) => String(row['d.hash'] ?? '').toUpperCase()));
  }

  /** Poll until a hash the session did not have before turns up. */
  private async waitForNewTorrent(before: Set<string>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (const hash of await this.sessionHashes()) {
        if (!before.has(hash)) return true;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private loadCommands(options: LoadOptions): string[] {
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
      case 'recheck-restart':
        entries.push({ methodName: 'd.stop', params: [hash] });
        entries.push({ methodName: 'd.check_hash', params: [hash] });
        // A stale error ("registered as completed, but hash check returned
        // unfinished chunks") outranks everything in the status derivation,
        // so left in place it hides the very check the user just started.
        // The check writes its own message if it fails again.
        if (this.capabilities.has('d.message.set')) {
          entries.push({ methodName: 'd.message.set', params: [hash, ''] });
        }
        break;
      case 'announce':
        if (!this.capabilities.supports('trackerAnnounce')) {
          throw new HttpError(501, 'this rtorrent build does not expose d.tracker_announce');
        }
        entries.push({ methodName: 'd.tracker_announce', params: [hash] });
        break;
      default:
        throw new HttpError(400, `unknown action "${action}"`);
    }
    await this.client.multicall(entries);
    // The restart half cannot happen here: the check runs for as long as the
    // disk takes, far past this request. The poll tick watches for the end.
    if (action === 'recheck-restart') this.pendingRestarts.add(hash);
  }

  /**
   * Start whatever finished its recheck since the last tick — the second
   * half of "recheck & restart". One read-only multicall for every pending
   * hash; the starts go out as their own calls, never batched with anything
   * else (quirk 5: lifecycle mixes in one multicall have segfaulted
   * rtorrent).
   */
  private async processPendingRestarts(): Promise<void> {
    if (this.pendingRestarts.size === 0) return;
    const hashes = this.pendingRestarts.hashes();
    const readings = await this.client.multicallSettled(
      hashes.map((hash) => ({ methodName: 'd.hashing', params: [hash] })),
    );
    for (const [index, hash] of hashes.entries()) {
      const value = readings[index];
      const hashing = value instanceof Error ? null : settledNumber(value);
      if (this.pendingRestarts.step(hash, hashing) !== 'start') continue;
      try {
        await this.client.call('d.open', [hash]);
        await this.client.call('d.start', [hash]);
        console.log(`[cascade] recheck finished, restarted ${hash}`);
      } catch (error) {
        console.warn(
          `[cascade] recheck finished but ${hash} would not start:`,
          (error as Error).message,
        );
      }
    }
  }

  async remove(hash: string, deleteData: boolean): Promise<void> {
    await this.capabilities.ensure();
    let dataPath: string | undefined;
    if (deleteData) {
      if (!this.config.allowDataDelete) {
        throw new HttpError(403, 'deleting torrent data is disabled (CASCADE_ALLOW_DATA_DELETE=0)');
      }
      const basePath = String(await this.client.call('d.base_path', [hash]));
      // Refused before the torrent is erased: rejecting the path afterwards
      // left the metadata gone and the data behind — the one combination the
      // user did not ask for. An empty base path (never started) has nothing
      // to check or delete.
      if (basePath) dataPath = this.assertDeletable(basePath);
    }
    await this.client.call('d.erase', [hash]);
    this.store.forget(hash);
    if (dataPath) await fs.rm(dataPath, { recursive: true, force: true });
  }

  /** Only ever unlink paths that live inside a configured data root. */
  private assertDeletable(basePath: string): string {
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
    return resolved;
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
    await this.capabilities.ensure();
    if (!this.capabilities.supports('trackerToggle')) {
      throw new HttpError(501, 'this rtorrent build does not expose t.is_enabled.set');
    }
    await this.client.call('t.is_enabled.set', [`${hash}:t${index}`, enabled ? 1 : 0]);
  }

  async addTracker(hash: string, url: string, group = 0): Promise<void> {
    await this.capabilities.ensure();
    if (!this.capabilities.supports('trackerInsert')) {
      throw new HttpError(501, 'this rtorrent build does not expose d.tracker.insert');
    }
    await this.client.multicall([
      { methodName: 'd.tracker.insert', params: [hash, Math.max(0, Number(group) || 0), url] },
      { methodName: 'd.save_full_session', params: [hash] },
    ]);
  }

  /* ------------------------------ settings ------------------------------ */

  async settings(): Promise<Partial<GlobalSettings>> {
    await this.capabilities.ensure();
    const usable = readableSettings(this.resolveMethod);
    const results = await this.client.multicallSettled(
      usable.map(([, method]) => ({ methodName: method, params: [] })),
    );
    const settings: Record<string, XValue> = {};
    usable.forEach(([key], index) => {
      const value = results[index];
      if (value instanceof Error) return;
      settings[key] = decodeSettingValue(key, value);
    });
    return settings as Partial<GlobalSettings>;
  }

  async updateSettings(patch: Partial<GlobalSettings>): Promise<void> {
    await this.capabilities.ensure();
    const entries = settingEntries(patch, this.resolveMethod);
    if (entries.length === 0) return;
    await this.client.multicall(entries);
  }

  /* ---------------------------- throttle groups -------------------------- */

  async saveThrottle(group: ThrottleGroup): Promise<void> {
    await this.capabilities.ensure();
    if (!this.capabilities.supports('throttleGroups')) {
      throw new HttpError(501, 'this rtorrent build does not support throttle groups');
    }
    if (!THROTTLE_NAME_RE.test(group.name)) {
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
    // throttle.up creates a group it does not know, so unlimiting a name the
    // store never saved would conjure one up rather than remove anything.
    if (!this.store.throttles().some((group) => group.name === name)) {
      throw new HttpError(404, `no throttle group named "${name}"`);
    }
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
      rates[group.name] = {
        up: settledNumber(results[index * 2]),
        down: settledNumber(results[index * 2 + 1]),
      };
    });
    return rates;
  }

  /* -------------------------------- misc -------------------------------- */

  /** Tail of the rtorrent log. Reads only the end — the log grows without bound. */
  async log(lines: number): Promise<string[]> {
    const TAIL_BYTES = 512 * 1024;
    let handle;
    try {
      handle = await fs.open(this.config.logFile, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const rows = buffer.toString('utf8').split('\n').filter(Boolean);
      if (start > 0) rows.shift(); // The first row is almost certainly cut mid-line.
      return rows.slice(-lines);
    } finally {
      await handle.close();
    }
  }
}

/** rtorrent's command parser uses double quotes around loading commands. */
function escapeArg(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
