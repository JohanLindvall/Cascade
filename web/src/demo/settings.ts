// SPDX-License-Identifier: MIT

/**
 * The global settings as the server's table has them
 * (server/internal/rtorrent/settings.go), resolved against the release the
 * demo presents, 0.16.24: each key's getter and setter there, and how its
 * value is checked. A key with no getter is not reported, one with no setter
 * is not supported, and the dialog greys it out as it does against a real
 * install. The REST settings routes and the console's commands both go
 * through it, so a value set in one reads back in the other.
 */
import type { GlobalSettings } from '../contracts.ts';
import { bool, int, text } from './validate.ts';

export type SettingKind = 'uint' | 'int' | 'bool' | 'string' | 'flags';
export type SettingKey = keyof GlobalSettings;
type SettingValue = number | boolean | string;

export interface SettingSpec {
  key: SettingKey;
  /** The command that reads it, null for a write-only setting: the settings route reports only what has one. */
  get: string | null;
  /** The command that sets it, null where the release has none that works: what supports[key] reports. */
  set: string | null;
  kind: SettingKind;
}

const spec = (key: SettingKey, get: string | null, set: string | null, kind: SettingKind): SettingSpec => ({ key, get, set, kind });
const both = (key: SettingKey, command: string, kind: SettingKind) => spec(key, command, `${command}.set`, kind);

/** In the table's order, which is also the order a patch is checked and applied in. */
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
  // 0.16 dropped network.http.max_open; the table reads its successor, whose
  // .set only warns (the console keeps it so), so the dialog greys this out.
  spec('maxHttpOpen', 'network.http.max_total_connections', null, 'uint'),
  both('httpMaxHostConnections', 'network.http.max_host_connections', 'uint'),
  both('dnsCacheTimeout', 'network.http.dns_cache_timeout', 'uint'),
  both('memoryMax', 'pieces.memory.max', 'uint'),
  both('syncTimeout', 'pieces.sync.timeout', 'uint'),
  both('preloadType', 'pieces.preload.type', 'uint'),
  both('preloadMinSize', 'pieces.preload.min_size', 'uint'),
  both('preloadMinRate', 'pieces.preload.min_rate', 'uint'),
  both('portRange', 'network.listen.port.range', 'string'),
  both('portRandom', 'network.listen.port.random', 'bool'),
  // Gone in 0.16, where the listening port is always open: neither reported nor offered.
  spec('portOpen', null, null, 'bool'),
  // Write-only, as on the server: rtorrent has no getter that round-trips them.
  spec('dhtMode', null, 'dht.mode.set', 'string'),
  both('dhtPort', 'dht.port', 'uint'),
  both('dhtOverridePort', 'dht.override_port', 'uint'),
  both('pex', 'protocol.pex', 'bool'),
  both('udpTrackers', 'trackers.use_udp', 'bool'),
  both('trackersNumwant', 'trackers.numwant', 'int'),
  spec('encryption', null, 'protocol.encryption.set', 'flags'),
  both('preallocate', 'system.file.allocate', 'bool'),
  both('checkHashOnCompletion', 'pieces.hash.on_completion', 'bool'),
  both('adviseRandomHashing', 'system.files.advise_random.hashing', 'bool'),
  both('directory', 'directory.default', 'string'),
  // A running rtorrent cannot move its session: reported, never set.
  spec('sessionDirectory', 'session.path', null, 'string'),
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
export function coerce(kind: SettingKind, value: unknown, key: string): SettingValue {
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

const MiB = 1024 * 1024;
const DHT_MODES = ['disable', 'off', 'auto', 'on'];
const ENCRYPTION_MODES = ['deny', 'allow', 'prefer', 'require'];
const HTTP_PROXY_SCHEMES = ['http', 'https', 'socks4', 'socks4a', 'socks5', 'socks5h'];
/** The demo has no resolver: only what a container's /etc/hosts answers, in the order 0.16.24 got it. */
const HOSTS: Record<string, string[]> = { localhost: ['::1', '127.0.0.1'] };

/**
 * protocol.encryption.set: one of the new mode names, or a handshake and a
 * stream mode; anything else is read as the old flags, in order, where
 * "none" and "require_RC4" end the list unread — so a bad flag after them
 * passes.
 */
function encryptionRefusal(value: string): string | null {
  const flags = value === '' ? [] : value.split(',');
  if (flags.length === 0) return 'No encryption options specified.';
  if (flags.length === 1 && ENCRYPTION_MODES.includes(flags[0])) return null;
  if (flags.length === 2 && /^handshake_(deny|allow|prefer|require)$/.test(flags[0]) && /^stream_(deny|allow|prefer|require)$/.test(flags[1])) {
    return null;
  }
  for (const flag of flags) {
    if (flag === 'none' || flag === 'require_RC4' || flag === 'require_rc4') return null;
    if (!['allow_incoming', 'try_outgoing', 'require', 'enable_retry', 'prefer_plaintext'].includes(flag)) {
      return `Invalid encryption option: '${flag}'`;
    }
  }
  return null;
}

/** sscanf's %i from a position: space and a sign, then hex after 0x, octal after 0, else decimal. */
function scanInt(text: string, from: number): { value: number; end: number } | null {
  let at = from;
  while (at < text.length && ' \t\n\v\f\r'.includes(text[at])) at++;
  let sign = 1;
  if (text[at] === '+' || text[at] === '-') sign = text[at++] === '-' ? -1 : 1;
  let base = 10;
  let digit = /[0-9]/;
  if (text[at] === '0' && /[xX]/.test(text[at + 1] ?? '') && /[0-9A-Fa-f]/.test(text[at + 2] ?? '')) {
    base = 16;
    digit = /[0-9A-Fa-f]/;
    at += 2;
  } else if (text[at] === '0') {
    base = 8;
    digit = /[0-7]/;
  }
  const start = at;
  while (at < text.length && digit.test(text[at])) at++;
  return at === start ? null : { value: sign * parseInt(text.slice(start, at), base), end: at };
}

/**
 * network.listen.port.range.set: sscanf("%i-%i") into unsigned ints — so
 * whatever follows the second number is ignored and a negative one wraps out
 * of range — then libtorrent's own check. Read back as "<first>-<last>".
 */
function portRange(value: string): [first: number, last: number] | string {
  const first = scanInt(value, 0);
  const last = first && value[first.end] === '-' ? scanInt(value, first.end + 1) : null;
  if (!first || !last) return 'Invalid port_range argument.';
  const unsigned = (n: number) => (n < 0 ? 2 ** 32 + n : n);
  const [low, high] = [unsigned(first.value), unsigned(last.value)];
  if (low >= 65_536 || high >= 65_536) return 'Port range out-of-bounds.';
  if (low === 0 || low > high) return 'Invalid listen port range.';
  return [low, high];
}

function isIPv4(text: string): boolean {
  return /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(text);
}

/** An IPv6 literal, normalized as the URL parser writes it ("::" for any), or null. */
function ipv6(text: string): string | null {
  if (!text.includes(':') || /[^0-9A-Fa-f:.]/.test(text)) return null;
  try {
    return new URL(`http://[${text}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/**
 * The bind and local address setters: getaddrinfo for the family each asks
 * for (unspecified, inet or inet6), then libtorrent's checks of what it got.
 * An empty value is the unspecified address.
 */
function addressRefusal(key: SettingKey, value: string): string | null {
  const family = key === 'bindAddressV4' ? 4 : key === 'bindAddressV6' ? 6 : 0;
  let address = '';
  if (value !== '') {
    const candidates = isIPv4(value) || ipv6(value) !== null ? [value] : HOSTS[value.toLowerCase()];
    if (!candidates) return `Could not get address info: ${value}: Name does not resolve`;
    const found = candidates.find((candidate) => family === 0 || (family === 4) === isIPv4(candidate));
    if (found === undefined) return `Could not get address info: ${value}: Name has no usable address`;
    address = found;
  }
  if (key === 'localAddress') {
    if (address === '' || address === '0.0.0.0' || ipv6(address) === '::') return 'Tried to set local address to an any address.';
    return isIPv4(address) ? null : 'Tried to set a local address that is not an unspec/inet address.';
  }
  if (key === 'bindAddress' && address !== '' && !isIPv4(address)) return 'Tried to set a bind address that is not an unspec/inet address.';
  return null;
}

interface ProxyUrl {
  scheme: string;
  user: string;
  password: string;
  host: string;
  port: number;
  /** A path, query or fragment after the authority. */
  rest: string;
}

/** A proxy URL as curl's parser reads it, or null where it refuses the URL — which the setters read as no scheme. */
function parseUrl(value: string): ProxyUrl | null {
  if (/\s/.test(value)) return null;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:([^@/?#]*)@)?(\[[^\]/?#]*\]|[^:/?#]*)(?::(\d*))?([/?#].*)?$/s.exec(value);
  if (!match) return null;
  const [, scheme, userinfo = '', host, port = '', rest = ''] = match;
  // Only a file: URL may leave the host out; a port must fit in 16 bits.
  if ((host === '' && scheme.toLowerCase() !== 'file') || (port !== '' && Number(port) > 65_535)) return null;
  const colon = userinfo.indexOf(':');
  return {
    scheme: scheme.toLowerCase(),
    user: colon < 0 ? userinfo : userinfo.slice(0, colon),
    password: colon < 0 ? '' : userinfo.slice(colon + 1),
    host,
    port: port === '' ? 0 : Number(port),
    rest,
  };
}

/** network.proxy.http.set (and network.http.proxy_address.set, its alias): any of curl's proxy schemes, with a host. */
function httpProxyRefusal(value: string): string | null {
  const url = parseUrl(value);
  if (!url || !HTTP_PROXY_SCHEMES.includes(url.scheme)) return `Unsupported proxy scheme: ${url?.scheme ?? ''}`;
  return url.host === '' ? 'Proxy address must include a host.' : null;
}

/**
 * network.proxy.global.set, in ProxyManager::set_proxy_url's order. "" clears
 * it. 0.16.24 dies on a host that is not an address literal instead of
 * refusing it; the demo answers with the refusal the code means to give.
 */
function globalProxyRefusal(value: string): string | null {
  if (value === '') return null;
  const url = parseUrl(value);
  if (!url) return 'Proxy address must include a scheme.';
  if (url.host === '') return 'Proxy address must include a host.';
  if (url.port === 0) return 'Proxy address must include a port.';
  if (url.rest !== '' && url.rest !== '/') return 'Proxy address must not include a path, query, or fragment.';
  const host = url.host.replace(/^\[(.*)\]$/, '$1');
  if (!isIPv4(host) && ipv6(host) === null) return `Proxy address numeric lookup failed: ${url.host}`;
  if (url.scheme === 'http') {
    return url.user || url.password ? "Proxy address for 'http://' must not include a user or password." : null;
  }
  if (url.scheme === 'socks5' || url.scheme === 'socks5h') {
    // As 0.16.24 has it: a user with a password is refused, under the other message.
    if (url.user && url.password) return `Proxy address for '${url.scheme}://' must not include a password without a user.`;
    return null;
  }
  return `Unsupported proxy scheme: ${url.scheme}`;
}

/**
 * What rtorrent itself refuses of a value the checks above let through, in
 * its own words (taken from 0.16.24 and its sources), or null for one it
 * takes. The settings route reports it as the server reports a faulting
 * setter: a 502 naming the command.
 */
export function refusal(key: SettingKey, value: SettingValue): string | null {
  const n = Number(value);
  switch (key) {
    case 'encryption':
      return encryptionRefusal(String(value));
    case 'dhtMode':
      return DHT_MODES.includes(String(value)) ? null : `Invalid dht mode: ${String(value)}`;
    case 'portRange': {
      const range = portRange(String(value));
      return typeof range === 'string' ? range : null;
    }
    case 'memoryMax':
      return n < 512 * MiB ? `set_max_memory_usage: memory limit too low, must be at least 512 MB : ${n}` : null;
    case 'syncTimeout':
      return n > 3600 ? `set_timeout_sync: invalid timeout, must be between 0 and 3600 seconds : ${n}` : null;
    case 'preloadType':
      return n > 2 ? `set_preload_type: invalid type : ${n}` : null;
    case 'preloadMinSize':
      return n < 1024 ? `set_preload_min_size: invalid size, must be at least 1 KB : ${n}` : null;
    case 'preloadMinRate':
      return n < 1024 ? `set_preload_required_rate: invalid rate, must be at least 1 KB/s : ${n}` : null;
    case 'maxOpenSockets':
      return n < 512 ? 'set_max_size_and_adjust: max_open too low, minimum is 512' : null;
    case 'xmlrpcSizeLimit':
      if (n > 64 * MiB) return 'XMLRPC size limit cannot exceed the SCGI content size limit.';
      return n < 1024 ? 'XMLRPC size limit is too small to hold a request.' : null;
    case 'bindAddress':
    case 'bindAddressV4':
    case 'bindAddressV6':
    case 'localAddress':
      return addressRefusal(key, String(value));
    case 'proxyAddress':
    case 'proxyHttp':
      return httpProxyRefusal(String(value));
    case 'proxyGlobal':
      return globalProxyRefusal(String(value));
    default:
      return null;
  }
}

/**
 * One setter, as rtorrent runs it: the value refused in its words, or taken
 * and kept as the getter reads it back. Answers the refusal, or null.
 */
export function applySetting(settings: GlobalSettings, key: SettingKey, value: SettingValue): string | null {
  const refused = refusal(key, value);
  if (refused !== null) return refused;
  if (key === 'portRange') {
    const [first, last] = portRange(String(value)) as [number, number];
    settings.portRange = `${first}-${last}`;
  } else if (key === 'proxyAddress' || key === 'proxyHttp') {
    // 0.16 made network.http.proxy_address an alias of network.proxy.http: one value.
    settings.proxyAddress = settings.proxyHttp = String(value);
  } else {
    Object.assign(settings, { [key]: value });
  }
  return null;
}

/** What a backend supports: every per-torrent feature here, and each setting the release has a working setter for. */
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
  for (const setting of SETTINGS) supports[setting.key] = setting.set !== null;
  return supports;
}
