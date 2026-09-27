/**
 * Application service: everything the HTTP layer needs, expressed in terms of
 * rtorrent commands chosen through the capability probe.
 */
import fs from 'node:fs/promises';
import {
  buildGameState,
  newlyUnlocked,
} from './achievements';
import { Capabilities } from './capabilities';
import type { Config } from './config';
import type {
  BackendSummary, GameState, GlobalStatus, LoadOptions, LogScopeState, Peer,
  RateSample, StateResponse, ThrottleGroup, Torrent, TorrentFile, Tracker,
} from './contracts';
import { assertDeletable } from './dataPaths';
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
} from './model';
import { PendingRestarts } from './pendingRestarts';
import {
  RtorrentClient,
  settledNumber,
  type MulticallEntry,
  type RpcClient,
} from './rtorrent';
import { SerialTasks } from './serialTasks';
import {
  decodeSettingValue,
  readableSettings,
  settingEntries,
  unsupportedSettingKeys,
  type GlobalSettings,
} from './settings';
import { Store } from './store';
import { normalizeThrottle, throttleEntries } from './throttles';
import { magnetInfoHash, parseTorrentFile } from './torrentfile';
import { requireRecord } from './validation';
import type { XValue } from './xmlrpc';

export type { GlobalSettings };
export type {
  GlobalStatus, Policy, BackendSummary, RateSample, StateResponse,
  LoadOptions, LogScopeState,
} from './contracts';

const HISTORY_LENGTH = 180;

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

export class RtorrentService {
  readonly client: RpcClient;
  readonly capabilities: Capabilities;
  private readonly history: RateSample[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private throttlesApplied = false;
  private bootSettingsApplied = false;
  private lastGameUpdate = 0;
  private readonly pendingRestarts = new PendingRestarts();
  private readonly torrentWrites = new SerialTasks();
  private readonly throttleWrites = new SerialTasks();
  private readonly loads = new SerialTasks();
  private torrentRead: Promise<Torrent[]> | null = null;
  private stateRead: Promise<StateResponse> | null = null;
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
        if (!this.bootSettingsApplied) await this.applyBootSettings();
        if (!this.throttlesApplied) await this.reapplyThrottles();
        if (!this.logScopesApplied) await this.reapplyLogScopes();
        await this.processPendingRestarts();
        // Keep lifetime counters moving even when no browser is watching.
        if (this.config.gamify && Date.now() - this.lastGameUpdate > 30_000) {
          await this.torrents();
        }
      } catch {
        this.throttlesApplied = false;
        this.bootSettingsApplied = false;
        this.logScopesApplied = false;
        this.attachedScopes.clear();
        this.capabilities.invalidate();
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
      patch = requireRecord(JSON.parse(raw), 'startup settings');
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
      await Promise.all(groups.map(({ name }) => this.throttleWrites.run(name, async () => {
        const group = this.store.throttles().find((item) => item.name === name);
        if (group) await this.client.multicall(throttleEntries(group));
      })));
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
        .split(/[,\s]+/)
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

  state(): Promise<StateResponse> {
    // Several browsers can poll together; share the expensive snapshot and
    // never fold the same, delayed counters into the store out of order.
    if (!this.stateRead) {
      this.stateRead = this.readState().finally(() => { this.stateRead = null; });
    }
    return this.stateRead;
  }

  private async readState(): Promise<StateResponse> {
    await this.capabilities.ensure();
    const torrents = await this.torrents();
    const status = await this.status(torrents);
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

  torrents(view = 'main'): Promise<Torrent[]> {
    if (view !== 'main') return this.readTorrents(view);
    if (!this.torrentRead) {
      this.torrentRead = this.readTorrents(view).finally(() => { this.torrentRead = null; });
    }
    return this.torrentRead;
  }

  private async readTorrents(view: string): Promise<Torrent[]> {
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
    if (view === 'main') {
      this.store.prune(hashes);
      this.updateGame(torrents);
    }
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
      // A successful read proves the connection is up even before the first
      // background tick or just after recovery.
      connected: true,
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
      policy: { rawRpc: this.config.allowRawRpc, deleteData: this.config.allowDataDelete },
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

  addTorrentFile(data: Buffer, options: LoadOptions): Promise<void> {
    return this.loads.run('session', () => this.loadTorrentFile(data, options));
  }

  private async loadTorrentFile(data: Buffer, options: LoadOptions): Promise<void> {
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

  addTorrentUrl(url: string, options: LoadOptions): Promise<void> {
    // URL loads have no known hash. Concurrent additions through this service
    // must not satisfy another URL's "a new torrent appeared" confirmation.
    return this.loads.run('session', () => this.loadTorrentUrl(url, options));
  }

  private async loadTorrentUrl(url: string, options: LoadOptions): Promise<void> {
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
    if (/^magnet:/i.test(link) && !wanted) {
      throw new HttpError(400, 'magnet link must contain a valid xt=urn:btih: info hash');
    }
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

  action(hash: string, action: string): Promise<void> {
    return this.torrentWrites.run(hash, () => this.performAction(hash, action));
  }

  private async performAction(hash: string, action: string): Promise<void> {
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
        // A stale error ("registered as completed, but hash check returned
        // unfinished chunks") outranks everything in the status derivation,
        // so left in place it hides the very check the user just started.
        // The check writes its own message if it fails again.
        if (this.capabilities.has('d.message.set')) {
          entries.push({ methodName: 'd.message.set', params: [hash, ''] });
        }
        entries.push({ methodName: 'd.check_hash', params: [hash] });
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
    const missing = entries.find((entry) => !this.capabilities.has(entry.methodName));
    if (missing) throw new HttpError(501, `this rtorrent build does not expose ${missing.methodName}`);
    if (action !== 'announce') this.pendingRestarts.cancel(hash);
    // Lifecycle commands must be separate, ordered requests (rtorrent 0.15.2
    // can crash when lifecycle changes and setters share a multicall).
    for (const entry of entries) await this.client.call(entry.methodName, entry.params);
    // The restart half cannot happen here: the check runs for as long as the
    // disk takes, far past this request. The poll tick watches for the end.
    if (action === 'recheck-restart') this.pendingRestarts.add(hash);
  }

  /**
   * Start whatever finished its recheck since the last tick — the second
   * half of "recheck & restart". Reads and starts share the torrent's mutation
   * queue so a later stop cannot be overtaken. Starts remain separate calls
   * (quirk 5: lifecycle mixes in one multicall have segfaulted rtorrent).
   */
  private async processPendingRestarts(): Promise<void> {
    if (this.pendingRestarts.size === 0) return;
    for (const hash of this.pendingRestarts.hashes()) await this.torrentWrites.run(hash, async () => {
      if (!this.pendingRestarts.has(hash)) return;
      const [value] = await this.client.multicallSettled([{ methodName: 'd.hashing', params: [hash] }]);
      const hashing = value instanceof Error ? null : settledNumber(value);
      if (this.pendingRestarts.step(hash, hashing) !== 'start') return;
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
    });
  }

  remove(hash: string, deleteData: boolean): Promise<void> {
    return this.torrentWrites.run(hash, () => this.removeTorrent(hash, deleteData));
  }

  private async removeTorrent(hash: string, deleteData: boolean): Promise<void> {
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
      if (basePath) dataPath = await assertDeletable(basePath, this.config.deleteRoots);
    }
    await this.client.call('d.erase', [hash]);
    this.pendingRestarts.cancel(hash);
    this.store.forget(hash);
    if (dataPath) {
      await assertDeletable(dataPath, this.config.deleteRoots);
      await fs.rm(dataPath, { recursive: true, force: true });
    }
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

  setTorrentThrottle(hash: string, name: string): Promise<void> {
    return this.torrentWrites.run(hash, () => this.changeTorrentThrottle(hash, name));
  }

  private async changeTorrentThrottle(hash: string, name: string): Promise<void> {
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
    try {
      await this.client.call('d.throttle_name.set', [hash, name]);
    } catch (error) {
      if (wasActive) await this.client.call('d.start', [hash]).catch(() => {});
      throw error;
    }
    if (wasActive) await this.client.call('d.start', [hash]);
    await this.client.call('d.save_full_session', [hash]);
  }

  async setTorrentSlots(hash: string, uploads?: number, downloads?: number): Promise<void> {
    await this.capabilities.ensure();
    const entries: MulticallEntry[] = [];
    if ((uploads !== undefined && !this.capabilities.supports('perTorrentMaxUploads')) ||
        (downloads !== undefined && !this.capabilities.supports('perTorrentMaxDownloads'))) {
      throw new HttpError(501, 'this rtorrent build does not support the requested per-torrent slot setting');
    }
    if (uploads !== undefined) {
      entries.push({ methodName: 'd.uploads_max.set', params: [hash, uploads] });
    }
    if (downloads !== undefined) {
      entries.push({ methodName: 'd.downloads_max.set', params: [hash, downloads] });
    }
    if (entries.length > 0) await this.client.multicall(entries);
  }

  setDirectory(hash: string, directory: string): Promise<void> {
    return this.torrentWrites.run(hash, async () => {
      await this.capabilities.ensure();
      if (!this.capabilities.supports('perTorrentDirectory')) {
        throw new HttpError(501, 'this rtorrent build does not support changing a torrent directory');
      }
      // Close before changing paths: rtorrent refuses an open download whose
      // files were moved, and frozen file paths must be rebuilt on next open.
      // Leave it stopped so the owner can move the data and recheck it first.
      await this.performAction(hash, 'stop');
      await this.client.call('d.directory.set', [hash, directory]);
      await this.client.call('d.save_full_session', [hash]);
    });
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

  saveThrottle(group: ThrottleGroup): Promise<void> {
    return this.throttleWrites.run(group.name, () => this.writeThrottle(group));
  }

  patchThrottle(name: string, patch: Partial<Pick<ThrottleGroup, 'up' | 'down'>>): Promise<void> {
    return this.throttleWrites.run(name, async () => {
      const group = this.store.throttles().find((item) => item.name === name);
      if (!group) throw new HttpError(404, `no throttle group named "${name}"`);
      await this.writeThrottle({ ...group, ...patch });
    });
  }

  private async writeThrottle(group: ThrottleGroup): Promise<void> {
    const normalized = normalizeThrottle(group);
    await this.capabilities.ensure();
    if (!this.capabilities.supports('throttleGroups')) {
      throw new HttpError(501, 'this rtorrent build does not support throttle groups');
    }
    await this.client.multicall(throttleEntries(normalized));
    this.store.upsertThrottle(normalized);
  }

  deleteThrottle(name: string): Promise<void> {
    return this.throttleWrites.run(name, () => this.removeThrottle(name));
  }

  private async removeThrottle(name: string): Promise<void> {
    await this.capabilities.ensure();
    // throttle.up creates a group it does not know, so unlimiting a name the
    // store never saved would conjure one up rather than remove anything.
    if (!this.store.throttles().some((group) => group.name === name)) {
      throw new HttpError(404, `no throttle group named "${name}"`);
    }
    if (this.capabilities.supports('throttleGroups')) {
      // rtorrent cannot drop a throttle group at runtime; unlimit it instead so
      // torrents still assigned to it are no longer restricted.
      await this.client.multicall([
        { methodName: 'throttle.up', params: ['', name, '0'] },
        { methodName: 'throttle.down', params: ['', name, '0'] },
      ]);
    }
    this.store.removeThrottle(name);
  }

  async throttleRates(): Promise<Record<string, { up: number; down: number }>> {
    await this.capabilities.ensure();
    const groups = this.store.throttles();
    if (groups.length === 0 || !this.capabilities.has('throttle.up.rate') ||
        !this.capabilities.has('throttle.down.rate')) return {};
    const entries: MulticallEntry[] = [];
    for (const group of groups) {
      entries.push({ methodName: 'throttle.up.rate', params: ['', group.name] });
      entries.push({ methodName: 'throttle.down.rate', params: ['', group.name] });
    }
    const results = await this.client.multicallSettled(entries);
    const rates: Record<string, { up: number; down: number }> = Object.create(null);
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
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const rows = buffer.subarray(0, bytesRead).toString('utf8').split('\n').filter(Boolean);
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
