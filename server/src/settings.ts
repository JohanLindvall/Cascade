/**
 * The rtorrent global-settings surface, as one declarative table.
 *
 * Each entry names the getter and setter commands (with alternates, newest
 * first, where a release renamed them) and how to coerce the value. The table
 * drives reading `/api/settings`, applying updates, the boot-settings warning
 * for unsupported keys, and the per-setting `supports` map the UI uses to grey
 * out controls — so a new knob is one line here plus a form field.
 *
 * Command names are never called blindly: the capability probe resolves each
 * against `system.listMethods` first, so a setting this backend lacks simply
 * disappears instead of faulting.
 */
import type { MulticallEntry } from './rtorrent';
import type { XValue } from './xmlrpc';

export interface GlobalSettings {
  downloadRate: number;
  uploadRate: number;
  maxUploads: number;
  minUploads: number;
  maxDownloads: number;
  minDownloads: number;
  maxUploadsGlobal: number;
  maxDownloadsGlobal: number;
  maxUploadsDiv: number;
  maxDownloadsDiv: number;
  maxPeers: number;
  minPeers: number;
  maxPeersSeed: number;
  minPeersSeed: number;
  maxOpenFiles: number;
  maxOpenSockets: number;
  maxHttpOpen: number;
  httpMaxHostConnections: number;
  dnsCacheTimeout: number;
  memoryMax: number;
  syncTimeout: number;
  preloadType: number;
  preloadMinSize: number;
  preloadMinRate: number;
  portRange: string;
  portRandom: boolean;
  portOpen: boolean;
  dhtMode: string;
  dhtPort: number;
  dhtOverridePort: number;
  pex: boolean;
  udpTrackers: boolean;
  trackersNumwant: number;
  encryption: string;
  preallocate: boolean;
  checkHashOnCompletion: boolean;
  adviseRandomHashing: boolean;
  directory: string;
  sessionDirectory: string;
  bindAddress: string;
  bindAddressV4: string;
  bindAddressV6: string;
  localAddress: string;
  proxyAddress: string;
  proxyHttp: string;
  proxyGlobal: string;
  httpCapath: string;
  httpCacert: string;
  sslVerifyPeer: boolean;
  sslVerifyHost: boolean;
  xmlrpcSizeLimit: number;
  receiveBuffer: number;
  sendBuffer: number;
  maxFileSize: number;
  blockOutgoing: boolean;
}

/** How a value is coerced on its way to (and from) rtorrent. */
type SettingKind =
  | 'uint' // non-negative integer
  | 'int' // integer, -1 allowed ("use the default" / "disabled")
  | 'bool' // 0/1 on the wire
  | 'string'
  | 'flags'; // comma-separated list, one argument per flag

interface SettingSpec {
  /** Getter command(s); omitted for write-only settings. */
  get?: string | string[];
  /** Setter command(s); omitted for read-only settings. */
  set?: string | string[];
  kind: SettingKind;
}

export const SETTING_SPECS: Record<keyof GlobalSettings, SettingSpec> = {
  downloadRate: {
    get: 'throttle.global_down.max_rate',
    set: 'throttle.global_down.max_rate.set',
    kind: 'uint',
  },
  uploadRate: {
    get: 'throttle.global_up.max_rate',
    set: 'throttle.global_up.max_rate.set',
    kind: 'uint',
  },
  maxUploads: { get: 'throttle.max_uploads', set: 'throttle.max_uploads.set', kind: 'uint' },
  minUploads: { get: 'throttle.min_uploads', set: 'throttle.min_uploads.set', kind: 'uint' },
  maxDownloads: { get: 'throttle.max_downloads', set: 'throttle.max_downloads.set', kind: 'uint' },
  minDownloads: { get: 'throttle.min_downloads', set: 'throttle.min_downloads.set', kind: 'uint' },
  maxUploadsGlobal: {
    get: 'throttle.max_uploads.global',
    set: 'throttle.max_uploads.global.set',
    kind: 'uint',
  },
  maxDownloadsGlobal: {
    get: 'throttle.max_downloads.global',
    set: 'throttle.max_downloads.global.set',
    kind: 'uint',
  },
  maxUploadsDiv: {
    get: 'throttle.max_uploads.div',
    set: 'throttle.max_uploads.div.set',
    kind: 'uint',
  },
  maxDownloadsDiv: {
    get: 'throttle.max_downloads.div',
    set: 'throttle.max_downloads.div.set',
    kind: 'uint',
  },
  maxPeers: { get: 'throttle.max_peers.normal', set: 'throttle.max_peers.normal.set', kind: 'uint' },
  minPeers: { get: 'throttle.min_peers.normal', set: 'throttle.min_peers.normal.set', kind: 'uint' },
  // -1 disables the seeding peer range, so these must not be clamped to zero.
  maxPeersSeed: { get: 'throttle.max_peers.seed', set: 'throttle.max_peers.seed.set', kind: 'int' },
  minPeersSeed: { get: 'throttle.min_peers.seed', set: 'throttle.min_peers.seed.set', kind: 'int' },
  maxOpenFiles: { get: 'network.max_open_files', set: 'network.max_open_files.set', kind: 'uint' },
  maxOpenSockets: {
    get: 'network.max_open_sockets',
    set: 'network.max_open_sockets.set',
    kind: 'uint',
  },
  // 0.16 dropped network.http.max_open; its max_total_connections successor
  // registers a .set that has no effect, so the value is read-only there and
  // the UI greys the field out rather than pretending it applied.
  maxHttpOpen: {
    get: ['network.http.max_open', 'network.http.max_total_connections'],
    set: 'network.http.max_open.set',
    kind: 'uint',
  },
  httpMaxHostConnections: {
    get: 'network.http.max_host_connections',
    set: 'network.http.max_host_connections.set',
    kind: 'uint',
  },
  dnsCacheTimeout: {
    get: 'network.http.dns_cache_timeout',
    set: 'network.http.dns_cache_timeout.set',
    kind: 'uint',
  },
  memoryMax: { get: 'pieces.memory.max', set: 'pieces.memory.max.set', kind: 'uint' },
  syncTimeout: { get: 'pieces.sync.timeout', set: 'pieces.sync.timeout.set', kind: 'uint' },
  preloadType: { get: 'pieces.preload.type', set: 'pieces.preload.type.set', kind: 'uint' },
  preloadMinSize: {
    get: 'pieces.preload.min_size',
    set: 'pieces.preload.min_size.set',
    kind: 'uint',
  },
  preloadMinRate: {
    get: 'pieces.preload.min_rate',
    set: 'pieces.preload.min_rate.set',
    kind: 'uint',
  },
  // 0.16 moved the listen-port commands under network.listen.*.
  portRange: {
    get: ['network.listen.port.range', 'network.port_range'],
    set: ['network.listen.port.range.set', 'network.port_range.set'],
    kind: 'string',
  },
  portRandom: {
    get: ['network.listen.port.random', 'network.port_random'],
    set: ['network.listen.port.random.set', 'network.port_random.set'],
    kind: 'bool',
  },
  // Removed in 0.16 (the listening port is always open there).
  portOpen: { get: 'network.port_open', set: 'network.port_open.set', kind: 'bool' },
  // dht.mode has a setter but no getter, so its current value cannot be shown.
  dhtMode: { set: 'dht.mode.set', kind: 'string' },
  dhtPort: { get: 'dht.port', set: 'dht.port.set', kind: 'uint' },
  dhtOverridePort: { get: 'dht.override_port', set: 'dht.override_port.set', kind: 'uint' },
  pex: { get: 'protocol.pex', set: 'protocol.pex.set', kind: 'bool' },
  udpTrackers: { get: 'trackers.use_udp', set: 'trackers.use_udp.set', kind: 'bool' },
  trackersNumwant: { get: 'trackers.numwant', set: 'trackers.numwant.set', kind: 'int' },
  // Write-only on purpose: 0.16 grew a getter, but it reports internal flag
  // names (handshake_allow, ...) that the setter refuses, so the value cannot
  // round-trip.
  encryption: { set: 'protocol.encryption.set', kind: 'flags' },
  preallocate: { get: 'system.file.allocate', set: 'system.file.allocate.set', kind: 'bool' },
  checkHashOnCompletion: {
    get: 'pieces.hash.on_completion',
    set: 'pieces.hash.on_completion.set',
    kind: 'bool',
  },
  adviseRandomHashing: {
    get: 'system.files.advise_random.hashing',
    set: 'system.files.advise_random.hashing.set',
    kind: 'bool',
  },
  directory: { get: 'directory.default', set: 'directory.default.set', kind: 'string' },
  // Changing the session directory of a running rtorrent is not supported.
  sessionDirectory: { get: 'session.path', kind: 'string' },
  bindAddress: { get: 'network.bind_address', set: 'network.bind_address.set', kind: 'string' },
  bindAddressV4: {
    get: 'network.bind_address.ipv4',
    set: 'network.bind_address.ipv4.set',
    kind: 'string',
  },
  bindAddressV6: {
    get: 'network.bind_address.ipv6',
    set: 'network.bind_address.ipv6.set',
    kind: 'string',
  },
  localAddress: { get: 'network.local_address', set: 'network.local_address.set', kind: 'string' },
  proxyAddress: {
    get: 'network.http.proxy_address',
    set: 'network.http.proxy_address.set',
    kind: 'string',
  },
  proxyHttp: { get: 'network.proxy.http', set: 'network.proxy.http.set', kind: 'string' },
  proxyGlobal: { get: 'network.proxy.global', set: 'network.proxy.global.set', kind: 'string' },
  httpCapath: { get: 'network.http.capath', set: 'network.http.capath.set', kind: 'string' },
  httpCacert: { get: 'network.http.cacert', set: 'network.http.cacert.set', kind: 'string' },
  sslVerifyPeer: {
    get: 'network.http.ssl_verify_peer',
    set: 'network.http.ssl_verify_peer.set',
    kind: 'bool',
  },
  sslVerifyHost: {
    get: 'network.http.ssl_verify_host',
    set: 'network.http.ssl_verify_host.set',
    kind: 'bool',
  },
  xmlrpcSizeLimit: {
    get: 'network.xmlrpc.size_limit',
    set: 'network.xmlrpc.size_limit.set',
    kind: 'uint',
  },
  receiveBuffer: {
    get: 'network.receive_buffer.size',
    set: 'network.receive_buffer.size.set',
    kind: 'uint',
  },
  sendBuffer: { get: 'network.send_buffer.size', set: 'network.send_buffer.size.set', kind: 'uint' },
  maxFileSize: { get: 'system.file.max_size', set: 'system.file.max_size.set', kind: 'uint' },
  blockOutgoing: {
    get: 'network.block.outgoing',
    set: 'network.block.outgoing.set',
    kind: 'bool',
  },
};

export const SETTING_KEYS = Object.keys(SETTING_SPECS) as Array<keyof GlobalSettings>;

/** Picks the first command name this backend implements, or undefined. */
export type ResolveMethod = (candidates: string | string[]) => string | undefined;

/** The settings this backend can report, as [key, resolved getter] pairs. */
export function readableSettings(
  resolve: ResolveMethod,
): Array<[keyof GlobalSettings, string]> {
  const pairs: Array<[keyof GlobalSettings, string]> = [];
  for (const key of SETTING_KEYS) {
    const getter = SETTING_SPECS[key].get;
    if (!getter) continue;
    const resolved = resolve(getter);
    if (resolved) pairs.push([key, resolved]);
  }
  return pairs;
}

/** Decode one raw XML-RPC value into the shape the settings API promises. */
export function decodeSettingValue(key: keyof GlobalSettings, value: XValue): XValue {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  switch (SETTING_SPECS[key].kind) {
    case 'bool':
      return Number(text) !== 0;
    case 'uint':
    case 'int':
      return Number(text) || 0;
    default:
      return typeof text === 'string' || typeof text === 'number' ? String(text) : '';
  }
}

function coerce(kind: SettingKind, value: unknown): XValue[] {
  switch (kind) {
    case 'uint':
      return [Math.max(0, Math.trunc(Number(value) || 0))];
    case 'int':
      return [Math.max(-1, Math.trunc(Number(value) || 0))];
    case 'bool':
      return [value ? 1 : 0];
    case 'flags': {
      // rtorrent takes each flag as its own argument, mirroring the
      // comma-separated form used in rtorrent.rc.
      const flags = String(value)
        .split(',')
        .map((flag) => flag.trim())
        .filter(Boolean);
      return flags.length > 0 ? flags : ['none'];
    }
    default:
      return [String(value)];
  }
}

/**
 * Turn a settings patch into multicall entries.
 *
 * Every setter is invoked against the empty-string target: rtorrent commands
 * take a target argument, and omitting it makes rtorrent read the value as the
 * target and fault with -503 "Wrong object type".
 */
export function settingEntries(
  patch: Partial<GlobalSettings>,
  resolve: ResolveMethod,
): MulticallEntry[] {
  const entries: MulticallEntry[] = [];
  for (const key of SETTING_KEYS) {
    if (patch[key] === undefined) continue;
    const spec = SETTING_SPECS[key];
    if (!spec.set) continue;
    const method = resolve(spec.set);
    if (!method) continue;
    entries.push({ methodName: method, params: ['', ...coerce(spec.kind, patch[key])] });
  }
  return entries;
}

/** Patch keys this backend has no working setter for (used for boot warnings). */
export function unsupportedSettingKeys(keys: string[], resolve: ResolveMethod): string[] {
  return keys.filter((key) => {
    const spec = SETTING_SPECS[key as keyof GlobalSettings];
    if (!spec) return false; // Unknown keys are simply ignored.
    return spec.set === undefined || resolve(spec.set) === undefined;
  });
}
