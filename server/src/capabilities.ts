/**
 * Backend capability probing.
 *
 * rtorrent's command set differs noticeably between releases: 0.9.6 has
 * `d.multicall` but not `d.multicall2`, the `*_verbose` load variants arrived in
 * 0.9.7, `d.throttle_name` and the `throttle.*` group commands are not present
 * everywhere, and forks (jesec/rtorrent 0.10.x) add commands of their own.
 *
 * Rather than hard-coding a version matrix we ask the running instance what it
 * supports via system.listMethods and pick command names from what is actually
 * there. Unsupported settings are reported to the UI so it can hide them.
 */
import type { RtorrentClient } from './rtorrent';

export interface Dialect {
  /** Multicall over the download list, plus the params that precede the fields. */
  downloadMulticall: string;
  downloadMulticallPrefix: (view: string) => string[];
  /** Load a torrent from raw bytes / from a URL or magnet link. */
  loadRaw: string;
  loadRawStart: string;
  loadUrl: string;
  loadUrlStart: string;
  /** Field commands that this backend actually implements. */
  torrentFields: string[];
  fileFields: string[];
  peerFields: string[];
  trackerFields: string[];
}

export interface BackendInfo {
  clientVersion: string;
  libraryVersion: string;
  apiVersion: string;
  methodCount: number;
  flavor: string;
  /** RPC facility reported by system.capabilities (0.16+), e.g. "xmlrpc-c 1.51.8". */
  rpcFacility: string;
  supports: Record<string, boolean>;
}

/** Feature -> command that implements it; a list when the name changed between releases. */
const FEATURE_METHODS: Record<string, string | string[]> = {
  labels: 'd.custom1.set',
  throttleGroups: 'throttle.up',
  perTorrentThrottle: 'd.throttle_name.set',
  dht: 'dht.mode.set',
  dhtStatistics: 'dht.statistics',
  pex: 'protocol.pex.set',
  encryption: 'protocol.encryption.set',
  udpTrackers: 'trackers.use_udp.set',
  portRange: ['network.listen.port.range.set', 'network.port_range.set'],
  preallocate: 'system.file.allocate.set',
  checkHashOnCompletion: 'pieces.hash.on_completion.set',
  memoryLimit: 'pieces.memory.max.set',
  maxOpenFiles: 'network.max_open_files.set',
  httpMaxOpen: 'network.http.max_open.set',
  httpMaxHostConnections: 'network.http.max_host_connections.set',
  blockOutgoing: 'network.block.outgoing.set',
  dhtOverridePort: 'dht.override_port.set',
  proxyGlobal: 'network.proxy.global.set',
  dualStackBind: 'network.bind_address.ipv4.set',
  adviseRandomHashing: 'system.files.advise_random.hashing.set',
  minPeers: 'throttle.min_peers.normal.set',
  maxPeers: 'throttle.max_peers.normal.set',
  seedPeers: 'throttle.max_peers.seed.set',
  maxUploadsGlobal: 'throttle.max_uploads.global.set',
  maxDownloadsGlobal: 'throttle.max_downloads.global.set',
  perTorrentMaxUploads: 'd.uploads_max.set',
  perTorrentMaxDownloads: 'd.downloads_max.set',
  moveFiles: 'd.directory.set',
  trackerInsert: 'd.tracker.insert',
  trackerToggle: 't.is_enabled.set',
  fileHashing: 'd.check_hash',
  sessionSave: 'session.save',
  logging: 'log.open_file',
  bindAddress: 'network.bind_address.set',
  peerExchangeInfo: 'd.peer_exchange',
  scrape: 'd.tracker_announce',
};

/** Candidate field commands, filtered down to those the backend implements. */
function pickAvailable(available: Set<string>, candidates: readonly string[]): string[] {
  return candidates.filter((name) => available.has(name));
}

function firstAvailable(available: Set<string>, candidates: readonly string[], fallback: string): string {
  return candidates.find((name) => available.has(name)) ?? fallback;
}

export class Capabilities {
  private methods = new Set<string>();
  private probedAt = 0;
  private probing: Promise<void> | null = null;

  dialect: Dialect = defaultDialect();
  info: BackendInfo = {
    clientVersion: 'unknown',
    libraryVersion: 'unknown',
    apiVersion: '0',
    methodCount: 0,
    flavor: 'unknown',
    rpcFacility: '',
    supports: {},
  };
  ready = false;

  constructor(
    private readonly client: RtorrentClient,
    private readonly torrentFields: readonly string[],
    private readonly fileFields: readonly string[],
    private readonly peerFields: readonly string[],
    private readonly trackerFields: readonly string[],
  ) {}

  has(method: string): boolean {
    return this.methods.has(method);
  }

  supports(feature: string): boolean {
    return this.info.supports[feature] === true;
  }

  /** Probe once; concurrent callers share the in-flight probe. */
  async ensure(): Promise<void> {
    if (this.ready && Date.now() - this.probedAt < 5 * 60_000) return;
    if (this.probing) return this.probing;
    this.probing = this.probe().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  invalidate(): void {
    this.ready = false;
  }

  private async probe(): Promise<void> {
    const listed = await this.client.call('system.listMethods');
    const methods = new Set<string>(
      Array.isArray(listed) ? listed.map((name) => String(name)) : [],
    );
    this.methods = methods;

    const probes = [
      { methodName: 'system.client_version', params: [] },
      { methodName: 'system.library_version', params: [] },
      { methodName: 'system.api_version', params: [] },
    ];
    // 0.16 describes its RPC layer through system.capabilities.
    if (methods.has('system.capabilities')) {
      probes.push({ methodName: 'system.capabilities', params: [] });
    }
    const versions = await this.client.multicallSettled(probes);
    const value = (index: number): string => {
      const item = versions[index];
      return item instanceof Error ? 'unknown' : String(item ?? 'unknown');
    };

    const clientVersion = value(0);
    this.dialect = {
      downloadMulticall: methods.has('d.multicall2') ? 'd.multicall2' : 'd.multicall',
      downloadMulticallPrefix: methods.has('d.multicall2')
        ? (view: string) => ['', view]
        : (view: string) => [view],
      loadRaw: firstAvailable(methods, ['load.raw_verbose', 'load.raw'], 'load.raw'),
      loadRawStart: firstAvailable(
        methods,
        ['load.raw_start_verbose', 'load.raw_start'],
        'load.raw_start',
      ),
      loadUrl: firstAvailable(methods, ['load.verbose', 'load.normal'], 'load.normal'),
      loadUrlStart: firstAvailable(methods, ['load.start_verbose', 'load.start'], 'load.start'),
      torrentFields: pickAvailable(methods, this.torrentFields),
      fileFields: pickAvailable(methods, this.fileFields),
      peerFields: pickAvailable(methods, this.peerFields),
      trackerFields: pickAvailable(methods, this.trackerFields),
    };

    // A backend that answers listMethods but exposes none of our fields is not
    // something we can drive; fall back to the full list and let calls fault.
    if (this.dialect.torrentFields.length === 0) {
      this.dialect.torrentFields = [...this.torrentFields];
    }

    const supports: Record<string, boolean> = {};
    for (const [feature, method] of Object.entries(FEATURE_METHODS)) {
      const candidates = Array.isArray(method) ? method : [method];
      supports[feature] = candidates.some((name) => methods.has(name));
    }

    let rpcFacility = '';
    const capabilities = versions[3];
    if (capabilities && !(capabilities instanceof Error) && typeof capabilities === 'object' &&
        !Array.isArray(capabilities)) {
      const record = capabilities as Record<string, unknown>;
      const parts = [record.version_major, record.version_minor, record.version_point]
        .filter((part) => part !== undefined)
        .join('.');
      rpcFacility = `${String(record.facility ?? 'unknown')}${parts ? ` ${parts}` : ''}`;
    }

    this.info = {
      clientVersion,
      libraryVersion: value(1),
      apiVersion: value(2),
      methodCount: methods.size,
      flavor: detectFlavor(clientVersion, methods),
      rpcFacility,
      supports,
    };
    this.probedAt = Date.now();
    this.ready = true;
  }

  methodNames(): string[] {
    return [...this.methods].sort();
  }
}

/**
 * Describe the command dialect rather than guessing at a fork: several builds
 * report indistinguishable version strings, and naming the wrong upstream is
 * worse than naming none.
 */
function detectFlavor(_clientVersion: string, methods: Set<string>): string {
  if (!methods.has('d.multicall2')) return 'legacy dialect (pre-0.9.7)';
  if (methods.has('load.raw_start_verbose')) return 'modern dialect (0.9.7+)';
  return 'modern dialect';
}

function defaultDialect(): Dialect {
  return {
    downloadMulticall: 'd.multicall2',
    downloadMulticallPrefix: (view: string) => ['', view],
    loadRaw: 'load.raw',
    loadRawStart: 'load.raw_start',
    loadUrl: 'load.normal',
    loadUrlStart: 'load.start',
    torrentFields: [],
    fileFields: [],
    peerFields: [],
    trackerFields: [],
  };
}
