/**
 * The global settings as the server's table has them
 * (server/internal/rtorrent/settings.go): each key's getter and setter on the
 * release the demo presents, and how its value is checked. The REST settings
 * routes and the console's commands both go through it, so a value set in one
 * reads back in the other.
 */
import type { GlobalSettings } from '../contracts.ts';
import { bool, int, text } from './validate.ts';

export type SettingKind = 'uint' | 'int' | 'bool' | 'string' | 'flags';
export type SettingKey = keyof GlobalSettings;

export interface SettingSpec {
  key: SettingKey;
  /** The console's getter and setter, null where the release has none. */
  get: string | null;
  set: string | null;
  kind: SettingKind;
  /** What the settings route does with the key: write-only ones cannot be read back. */
  readable: boolean;
  writable: boolean;
}

const spec = (key: SettingKey, get: string | null, set: string | null, kind: SettingKind, readable = true, writable = true): SettingSpec =>
  ({ key, get, set, kind, readable, writable });
const both = (key: SettingKey, command: string, kind: SettingKind) => spec(key, command, `${command}.set`, kind);

/** In the table's order, which is also the order a patch is checked in. */
export const SETTINGS: readonly SettingSpec[] = [
  both('downloadRate', 'throttle.global_down.max_rate', 'uint'),
  both('uploadRate', 'throttle.global_up.max_rate', 'uint'),
  both('maxUploads', 'throttle.max_uploads', 'uint'),
  both('minUploads', 'throttle.min_uploads', 'uint'),
  both('maxDownloads', 'throttle.max_downloads', 'uint'),
  both('minDownloads', 'throttle.min_downloads', 'uint'),
  both('maxUploadsGlobal', 'throttle.max_uploads.global', 'uint'),
  both('maxDownloadsGlobal', 'throttle.max_downloads.global', 'uint'),
  both('maxUploadsDiv', 'throttle.max_uploads.div', 'uint'),
  both('maxDownloadsDiv', 'throttle.max_downloads.div', 'uint'),
  both('maxPeers', 'throttle.max_peers.normal', 'uint'),
  both('minPeers', 'throttle.min_peers.normal', 'uint'),
  both('maxPeersSeed', 'throttle.max_peers.seed', 'int'),
  both('minPeersSeed', 'throttle.min_peers.seed', 'int'),
  both('maxOpenFiles', 'network.max_open_files', 'uint'),
  both('maxOpenSockets', 'network.max_open_sockets', 'uint'),
  // The demo offers every control, so this one is writable where 0.16 only reads it.
  both('maxHttpOpen', 'network.http.max_total_connections', 'uint'),
  both('httpMaxHostConnections', 'network.http.max_host_connections', 'uint'),
  both('dnsCacheTimeout', 'network.http.dns_cache_timeout', 'uint'),
  both('memoryMax', 'pieces.memory.max', 'uint'),
  both('syncTimeout', 'pieces.sync.timeout', 'uint'),
  both('preloadType', 'pieces.preload.type', 'uint'),
  both('preloadMinSize', 'pieces.preload.min_size', 'uint'),
  both('preloadMinRate', 'pieces.preload.min_rate', 'uint'),
  both('portRange', 'network.listen.port.range', 'string'),
  both('portRandom', 'network.listen.port.random', 'bool'),
  // Gone in 0.16, where the port is always open: kept here without a command.
  spec('portOpen', null, null, 'bool'),
  // Write-only, as on the server: rtorrent has no getter that round-trips them.
  spec('dhtMode', null, 'dht.mode.set', 'string', false),
  both('dhtPort', 'dht.port', 'uint'),
  both('dhtOverridePort', 'dht.override_port', 'uint'),
  both('pex', 'protocol.pex', 'bool'),
  both('udpTrackers', 'trackers.use_udp', 'bool'),
  both('trackersNumwant', 'trackers.numwant', 'int'),
  spec('encryption', null, 'protocol.encryption.set', 'flags', false),
  both('preallocate', 'system.file.allocate', 'bool'),
  both('checkHashOnCompletion', 'pieces.hash.on_completion', 'bool'),
  both('adviseRandomHashing', 'system.files.advise_random.hashing', 'bool'),
  both('directory', 'directory.default', 'string'),
  spec('sessionDirectory', 'session.path', null, 'string', true, false),
  both('bindAddress', 'network.bind_address', 'string'),
  both('bindAddressV4', 'network.bind_address.ipv4', 'string'),
  both('bindAddressV6', 'network.bind_address.ipv6', 'string'),
  both('localAddress', 'network.local_address', 'string'),
  both('proxyAddress', 'network.http.proxy_address', 'string'),
  both('proxyHttp', 'network.proxy.http', 'string'),
  both('proxyGlobal', 'network.proxy.global', 'string'),
  both('httpCapath', 'network.http.capath', 'string'),
  both('httpCacert', 'network.http.cacert', 'string'),
  both('sslVerifyPeer', 'network.http.ssl_verify_peer', 'bool'),
  both('sslVerifyHost', 'network.http.ssl_verify_host', 'bool'),
  both('xmlrpcSizeLimit', 'network.xmlrpc.size_limit', 'uint'),
  both('receiveBuffer', 'network.receive_buffer.size', 'uint'),
  both('sendBuffer', 'network.send_buffer.size', 'uint'),
  both('maxFileSize', 'system.file.max_size', 'uint'),
  both('blockOutgoing', 'network.block.outgoing', 'bool'),
];

/** What a fresh session reports: 0.16.24's own defaults, with an upload limit set. */
export function defaultSettings(): GlobalSettings {
  return {
    downloadRate: 0,
    uploadRate: 8 * 1024 * 1024,
    maxUploads: 50,
    minUploads: 0,
    maxDownloads: 50,
    minDownloads: 0,
    maxUploadsGlobal: 0,
    maxDownloadsGlobal: 0,
    maxUploadsDiv: 1,
    maxDownloadsDiv: 1,
    maxPeers: 200,
    minPeers: 100,
    maxPeersSeed: -1,
    minPeersSeed: -1,
    maxOpenFiles: 128,
    maxOpenSockets: 1024,
    maxHttpOpen: 32,
    httpMaxHostConnections: 1,
    dnsCacheTimeout: 60,
    memoryMax: 34_359_738_368,
    syncTimeout: 600,
    preloadType: 0,
    preloadMinSize: 262_144,
    preloadMinRate: 5_120,
    portRange: '50000-50000',
    portRandom: false,
    portOpen: true,
    dhtMode: 'auto',
    dhtPort: 6881,
    dhtOverridePort: 0,
    pex: true,
    udpTrackers: true,
    trackersNumwant: -1,
    encryption: 'allow_incoming,try_outgoing,enable_retry',
    preallocate: false,
    checkHashOnCompletion: true,
    adviseRandomHashing: false,
    directory: '/downloads',
    sessionDirectory: '/config/session/',
    bindAddress: '',
    bindAddressV4: '',
    bindAddressV6: '',
    localAddress: '',
    proxyAddress: '',
    proxyHttp: '',
    proxyGlobal: '',
    httpCapath: '',
    httpCacert: '',
    sslVerifyPeer: true,
    sslVerifyHost: true,
    xmlrpcSizeLimit: 16_777_216,
    receiveBuffer: 0,
    sendBuffer: 0,
    maxFileSize: 549_755_813_888,
    blockOutgoing: false,
  };
}

/** One value checked and coerced as the server's coerce() does; throws a 400 naming the key. */
export function coerce(kind: SettingKind, value: unknown, key: string): number | boolean | string {
  switch (kind) {
    case 'uint':
      return int(value, key, 0, Number.MAX_SAFE_INTEGER);
    case 'int':
      return int(value, key, -1, Number.MAX_SAFE_INTEGER);
    case 'bool':
      return bool(value, key);
    case 'flags': {
      // rtorrent takes one argument per flag, which the setting keeps joined.
      const flags = text(value, key, true).split(',').map((flag) => flag.trim()).filter(Boolean);
      return flags.length === 0 ? 'none' : flags.join(',');
    }
    case 'string':
      return text(value, key, true);
  }
}

const ENCRYPTION = ['none', 'allow_incoming', 'try_outgoing', 'require', 'require_RC4', 'require_rc4', 'enable_retry', 'prefer_plaintext'];
const DHT_MODES = ['disable', 'off', 'auto', 'on'];

/**
 * What rtorrent itself refuses of a value the checks above let through, in
 * its own words (taken from 0.16.24), or null for one it takes. The settings
 * route reports it as the server reports a faulting setter: a 502 naming the
 * command.
 */
export function refusal(key: SettingKey, value: number | boolean | string): string | null {
  if (key === 'encryption') {
    const bad = String(value).split(',').find((flag) => !ENCRYPTION.includes(flag));
    return bad === undefined ? null : `Invalid encryption option: '${bad}'`;
  }
  if (key === 'dhtMode') return DHT_MODES.includes(String(value)) ? null : `Invalid dht mode: ${String(value)}`;
  if (key === 'portRange') {
    const match = /^(\d+)-(\d+)$/.exec(String(value));
    const ok = match !== null && Number(match[1]) >= 1 && Number(match[1]) <= Number(match[2]) && Number(match[2]) <= 65_535;
    return ok ? null : 'Invalid port_range argument.';
  }
  return null;
}

/** Every key a backend with a working setter for it supports: here, all of them. */
export function supportsMap(): Record<string, boolean> {
  const supports: Record<string, boolean> = {
    labels: true,
    throttleGroups: true,
    perTorrentThrottle: true,
    perTorrentMaxUploads: true,
    perTorrentMaxDownloads: true,
    perTorrentDirectory: true,
    dhtStatistics: true,
    trackerInsert: true,
    trackerToggle: true,
    trackerAnnounce: true,
    logScopes: true,
  };
  for (const setting of SETTINGS) supports[setting.key] = true;
  return supports;
}
