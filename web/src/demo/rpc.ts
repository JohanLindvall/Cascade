// SPDX-License-Identifier: MIT

/**
 * The API console's rtorrent: every command system.listMethods lists answers
 * as rtorrent 0.16 does, from the simulated session — getters with the
 * session's own values, setters and lifecycle commands changing it — and any
 * other name faults the way xmlrpc-c does ("Method 'x' not defined", -506).
 * The command names, the help texts and the faults for a missing, mistyped or
 * refused argument are copied from a running 0.16.25 wherever one was checked
 * (0.16.24 answered alike, but for the value checks 0.16.25 added).
 */
import {
  type Session, type SimTorrent, SESSION_DIR, VIEWS, basePathOf, completedBytes, directoryOf, ratioPermille, viewsOf,
} from './session.ts';
import { SETTINGS, applySetting } from './settings.ts';
import { HttpError } from './validate.ts';

export class RpcFault extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** What the console needs besides the session: the versions it reports and the add path. */
export interface RpcHost {
  session: Session;
  clientVersion: string;
  libraryVersion: string;
  apiVersion: string;
  /** load.*: a magnet or URL added as the upload route adds one. */
  load(link: string, start: boolean, directory: string, label: string): void;
}

type Value = unknown;
type Handler = (params: unknown[]) => Value;

const WRONG_TARGET = 'Target of wrong type to generic command.';
const NOT_FOUND = 'invalid parameters: info-hash not found';
const NO_INDEX = 'invalid parameters: index not found';
const NO_HELP = 'No help is available for this method.';

/** xmlrpc-c's own help for the system methods it provides, typos and all; rtorrent's commands have none. */
const SYSTEM_HELP: Record<string, [help: string, signature: string[][]]> = {
  'system.listMethods': ['Return an array of all available XML-RPC methods on this server.', [['array']]],
  'system.methodExist': ['Tell whether a method by a specified name exists on this server', [['string', 'boolean']]],
  'system.methodHelp': ['Given the name of a method, return a help string.', [['string', 'string']]],
  'system.methodSignature': [
    'Given the name of a method, return an array of legal signatures. Each signature is an array of strings.  ' +
      'The first item of each signature is the return type, and any others items are parameter types.',
    [['array', 'string']],
  ],
  'system.multicall': [
    'Process an array of calls, and return an array of results.  Calls should be structs of the form ' +
      "{'methodName': string, 'params': array}. Each result will either be a single-item array containg the " +
      "result value, or a struct of the form {'faultCode': int, 'faultString': string}.  This is useful when you " +
      'need to make lots of small calls without lots of round trips.',
    [['array', 'array']],
  ],
  'system.capabilities': [
    'Return the capabilities of XML-RPC server.  This includes the version number of the XML-RPC For C/C++ software',
    [['struct']],
  ],
  'system.getCapabilities': [
    'Return the list of standard capabilities of XML-RPC server.  See http://tech.groups.yahoo.com/group/xml-rpc/message/2897',
    [['struct']],
  ],
};

const flag = (value: boolean) => (value ? 1 : 0);

/** A value argument as rtorrent reads one: a whole number, or a string that spells one. */
function value(params: unknown[], at = 1): number {
  if (params.length <= at) throw new RpcFault(-503, 'Wrong object type: expected: value actual: none');
  const raw = params[at];
  const n = typeof raw === 'number' ? raw
    : typeof raw === 'boolean' ? Number(raw)
      : typeof raw === 'string' && /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n)) throw new RpcFault(-503, 'Not a value.');
  return n;
}

function string(params: unknown[], at = 1): string {
  if (params.length <= at) throw new RpcFault(-503, 'Wrong object type: expected: string actual: none');
  const raw = params[at];
  if (typeof raw !== 'string') throw new RpcFault(-503, 'Wrong object type: expected: string actual: value');
  return raw;
}

/** The per-torrent getters, as raw rtorrent values: flags as 0/1, the ratio per mille. */
function torrentGetters(session: Session): Record<string, (t: SimTorrent) => Value> {
  const row = (t: SimTorrent) => session.row(t);
  return {
    'd.base_filename': (t) => t.name,
    'd.base_path': (t) => basePathOf(t),
    'd.bytes_done': (t) => completedBytes(t),
    'd.chunk_size': (t) => t.chunk,
    'd.chunks_hashed': (t) => (t.check ? Math.floor(t.check.pos / t.chunk) : Math.ceil(t.size / t.chunk)),
    'd.complete': (t) => flag(t.complete),
    'd.completed_bytes': (t) => completedBytes(t),
    'd.completed_chunks': (t) => row(t).chunksDone,
    'd.creation_date': (t) => t.createdAt,
    'd.custom1': (t) => encodeURIComponent(t.label),
    'd.directory': (t) => directoryOf(t),
    'd.down.rate': (t) => t.downRate,
    'd.down.total': (t) => Math.round(t.downTotal),
    'd.downloads_max': (t) => t.maxDownloads,
    'd.downloads_min': () => 0,
    'd.hash': (t) => t.hash,
    'd.hashing': (t) => t.hashing,
    'd.hashing_failed': () => 0,
    'd.incomplete': (t) => flag(!t.complete),
    'd.is_active': (t) => flag(t.active),
    'd.is_hash_checked': (t) => flag(t.hashing === 0 && t.unchecked === null),
    'd.is_hash_checking': (t) => flag(t.hashing > 0),
    'd.is_meta': (t) => flag(t.meta !== null),
    'd.is_multi_file': (t) => flag(t.multi),
    'd.is_open': (t) => flag(t.open),
    'd.is_private': (t) => flag(t.isPrivate),
    'd.left_bytes': (t) => row(t).left,
    'd.load_date': (t) => t.addedAt,
    'd.loaded_file': (t) => `${SESSION_DIR}/${t.hash}.torrent`,
    'd.message': (t) => t.message,
    'd.name': (t) => t.name,
    'd.peers_accounted': (t) => t.peersConnected,
    'd.peers_complete': (t) => row(t).peersComplete,
    'd.peers_connected': (t) => t.peersConnected,
    'd.peers_max': () => session.settings.maxPeers,
    'd.peers_min': () => session.settings.minPeers,
    'd.peers_not_connected': (t) => row(t).peersNotConnected,
    'd.priority': (t) => t.priority,
    'd.priority_str': (t) => ['off', 'low', 'normal', 'high'][t.priority] ?? 'normal',
    'd.ratio': (t) => ratioPermille(t),
    'd.size_bytes': (t) => t.size,
    'd.size_chunks': (t) => Math.ceil(t.size / t.chunk),
    'd.size_files': (t) => t.files.length,
    'd.state': (t) => t.state,
    'd.throttle_name': (t) => t.throttle,
    'd.tied_to_file': () => '',
    'd.timestamp.finished': (t) => t.finishedAt,
    'd.timestamp.started': (t) => t.startedAt,
    'd.tracker_size': (t) => t.trackers.length,
    'd.up.rate': (t) => t.upRate,
    'd.up.total': (t) => Math.round(t.upTotal),
    'd.uploads_max': (t) => t.maxUploads,
    'd.uploads_min': () => 0,
    // The custom views a torrent was put in; the built-in ones are not listed.
    'd.views': () => [],
    'd.wanted_chunks': (t) => Math.ceil(t.files.reduce((sum, f) => sum + (f.priority > 0 ? f.size - f.done : 0), 0) / t.chunk),
  };
}

function trackerGetters(session: Session): Record<string, (t: SimTorrent, index: number) => Value> {
  const row = (t: SimTorrent, index: number) => session.trackerRow(t, t.trackers[index], index);
  const field = (name: keyof ReturnType<typeof row>) => (t: SimTorrent, index: number): Value => {
    const read = row(t, index)[name];
    return typeof read === 'boolean' ? flag(read) : read;
  };
  return {
    't.activity_time_last': field('lastActivity'),
    't.activity_time_next': field('nextActivity'),
    't.can_scrape': field('canScrape'),
    't.failed_counter': field('failures'),
    't.failed_time_last': field('lastFailure'),
    't.failed_time_next': field('nextFailure'),
    't.group': field('group'),
    't.id': field('trackerId'),
    't.is_busy': field('busy'),
    't.is_enabled': field('enabled'),
    't.is_extra_tracker': field('extra'),
    't.is_open': field('open'),
    't.is_scrapable': field('canScrape'),
    't.is_usable': field('usable'),
    't.latest_event': field('latestEvent'),
    't.latest_new_peers': field('newPeers'),
    't.latest_sum_peers': field('sumPeers'),
    't.min_interval': field('minInterval'),
    't.normal_interval': field('interval'),
    't.scrape_complete': field('seeders'),
    't.scrape_counter': field('scrapes'),
    't.scrape_downloaded': field('downloaded'),
    't.scrape_incomplete': field('leechers'),
    't.scrape_time_last': field('lastScrape'),
    't.success_counter': field('successes'),
    't.success_time_last': field('lastSuccess'),
    't.success_time_next': field('nextSuccess'),
    't.type': field('type'),
    't.url': field('url'),
  };
}

function fileGetters(session: Session): Record<string, (t: SimTorrent, index: number) => Value> {
  const row = (t: SimTorrent, index: number) => session.fileRow(t, t.files[index], index);
  return {
    'f.completed_chunks': (t, i) => row(t, i).completedChunks,
    'f.frozen_path': (t, i) => {
      if (!t.everOpened) return '';
      const name = row(t, i).onDisk || t.files[i].path.slice(t.files[i].path.lastIndexOf('/') + 1);
      const dirs = t.files[i].path.split('/').slice(0, -1);
      return [t.multi ? basePathOf(t) : t.frozen, ...dirs, name].join('/');
    },
    'f.is_created': (t, i) => flag(row(t, i).created),
    'f.is_open': () => 0,
    'f.last_touched': (t) => Math.max(t.activeSince, t.startedAt) * 1_000_000,
    'f.offset': (t, i) => t.files[i].offset,
    'f.path': (t, i) => t.files[i].path,
    'f.path_components': (t, i) => t.files[i].path.split('/'),
    'f.path_depth': (t, i) => t.files[i].path.split('/').length,
    'f.priority': (t, i) => t.files[i].priority,
    'f.range_first': (t, i) => Math.floor(t.files[i].offset / t.chunk),
    'f.range_second': (t, i) => {
      const file = t.files[i];
      return Math.floor((file.offset + Math.max(0, file.size - 1)) / t.chunk) + (file.size > 0 ? 1 : 0);
    },
    'f.size_bytes': (t, i) => t.files[i].size,
    'f.size_chunks': (t, i) => row(t, i).sizeChunks,
  };
}

function peerGetters(): Record<string, (peer: Record<string, unknown>) => Value> {
  const field = (name: string) => (peer: Record<string, unknown>) => {
    const read = peer[name];
    return typeof read === 'boolean' ? flag(read) : read;
  };
  return {
    'p.address': field('address'),
    'p.banned': field('banned'),
    'p.client_version': field('client'),
    'p.completed_percent': (peer) => Math.floor((peer.progress as number) * 100),
    'p.down_rate': field('downRate'),
    'p.down_total': field('downTotal'),
    'p.id': field('id'),
    'p.is_encrypted': field('encrypted'),
    'p.is_incoming': field('incoming'),
    'p.is_obfuscated': field('obfuscated'),
    'p.is_preferred': field('preferred'),
    'p.is_snubbed': field('snubbed'),
    'p.is_unwanted': field('unwanted'),
    'p.options_str': field('options'),
    'p.peer_rate': field('peerRate'),
    'p.peer_total': field('peerTotal'),
    'p.port': field('port'),
    'p.up_rate': field('upRate'),
    'p.up_total': field('upTotal'),
  };
}

export class Rpc {
  private readonly handlers = new Map<string, Handler>();
  private readonly host: RpcHost;

  constructor(host: RpcHost) {
    this.host = host;
    this.registerSystem();
    this.registerTorrents();
    this.registerItems();
    this.registerGlobal();
  }

  methods(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** One command: its result, or the fault rtorrent would answer with. */
  call(method: string, params: unknown[]): Value {
    const handler = this.handlers.get(method);
    if (!handler) throw new RpcFault(-506, `Method '${method}' not defined`);
    try {
      return handler(params);
    } catch (error) {
      if (error instanceof RpcFault) throw error;
      // The session's refusals are rtorrent's: its faults keep their code.
      if (error instanceof HttpError) throw new RpcFault(error.faultCode ?? -503, error.message);
      throw error;
    }
  }

  /** system.methodHelp and system.methodSignature, or null for a command there is none of. */
  help(method: string): { help: string; signature: unknown } | null {
    if (!this.handlers.has(method)) return null;
    const known = SYSTEM_HELP[method];
    return known ? { help: known[0], signature: known[1] } : { help: NO_HELP, signature: 'undef' };
  }

  private on(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  /* ------------------------------- system -------------------------------- */

  private registerSystem(): void {
    const { host } = this;
    const nowS = () => Math.floor(host.session.now / 1000);
    const described = (params: unknown[]) => {
      const name = string(params, 0);
      const help = this.help(name);
      if (!help) throw new RpcFault(-506, `Method '${name}' not defined`);
      return help;
    };
    this.on('system.listMethods', () => this.methods());
    this.on('system.methodExist', (params) => this.handlers.has(string(params, 0)));
    this.on('system.methodHelp', (params) => described(params).help);
    this.on('system.methodSignature', (params) => described(params).signature);
    this.on('system.multicall', (params) => {
      const calls = params[0];
      if (!Array.isArray(calls)) throw new RpcFault(-501, 'system.multicall expects an array of calls');
      return calls.map((item) => {
        const { methodName, params: args } = (item ?? {}) as { methodName?: unknown; params?: unknown };
        try {
          if (typeof methodName !== 'string') throw new RpcFault(-501, 'methodName must be a string');
          if (methodName === 'system.multicall') throw new RpcFault(-501, 'Recursive system.multicall forbidden');
          return [this.call(methodName, Array.isArray(args) ? args : [])];
        } catch (error) {
          if (!(error instanceof RpcFault)) throw error;
          return { faultCode: error.code, faultString: error.message };
        }
      });
    });
    this.on('system.capabilities', () => ({ facility: 'xmlrpc-c', protocol_version: 2, version_major: 1, version_minor: 51, version_point: 8 }));
    this.on('system.getCapabilities', () => ({
      introspection: { specUrl: 'http://xmlrpc-c.sourceforge.net/xmlrpc-c/introspection.html', specVersion: 1 },
      faults_interop: { specUrl: 'http://xmlrpc-epi.sourceforge.net/specs/rfc.fault_codes.php', specVersion: 20010516 },
    }));
    this.on('system.client_version', () => host.clientVersion);
    this.on('system.library_version', () => host.libraryVersion);
    this.on('system.api_version', () => host.apiVersion);
    this.on('system.hostname', () => host.session.hostname);
    this.on('system.pid', () => host.session.pid);
    this.on('system.cwd', () => '/');
    this.on('system.time', nowS);
    this.on('system.time_seconds', nowS);
    this.on('system.time_usec', () => host.session.now * 1000);
  }

  /* ------------------------------ torrents ------------------------------- */

  /** The torrent a command's target names. */
  private torrent(params: unknown[]): SimTorrent {
    const target = params[0];
    if (typeof target !== 'string' || target === '') throw new RpcFault(-503, WRONG_TARGET);
    if (!this.host.session.has(target)) throw new RpcFault(-503, NOT_FOUND);
    return this.host.session.get(target);
  }

  private registerTorrents(): void {
    const { session } = this.host;
    const getters = torrentGetters(session);
    for (const [name, get] of Object.entries(getters)) this.on(name, (params) => get(this.torrent(params)));

    const lifecycle = (command: string) => (params: unknown[]) => {
      session.command(this.torrent(params).hash, command);
      return 0;
    };
    for (const command of ['d.open', 'd.close', 'd.start', 'd.stop', 'd.pause', 'd.resume', 'd.check_hash', 'd.erase', 'd.tracker_announce']) {
      this.on(command, lifecycle(command));
    }
    for (const command of ['d.save_full_session', 'd.save_resume', 'd.update_priorities']) {
      this.on(command, (params) => (this.torrent(params), 0));
    }
    // rtorrent keeps the low two bits of whatever priority it is given.
    this.on('d.priority.set', (params) => {
      const t = this.torrent(params);
      session.setPriority(t.hash, value(params) & 3);
      return 0;
    });
    this.on('d.custom1.set', (params) => {
      const t = this.torrent(params);
      const raw = string(params);
      let label = raw;
      try {
        label = decodeURIComponent(raw);
      } catch {
        // Another client's raw text: shown as it is, as MapTorrent shows it.
      }
      session.setLabel(t.hash, label);
      return 0;
    });
    this.on('d.throttle_name.set', (params) => {
      const t = this.torrent(params);
      const name = string(params);
      // What SetTorrentThrottle stops the torrent around (quirk 4).
      if (t.active) throw new RpcFault(-503, 'Cannot set throttle on active download.');
      t.throttle = name;
      return 0;
    });
    this.on('d.directory.set', (params) => {
      const t = this.torrent(params);
      const directory = string(params);
      t.parent = directory.length > 1 ? directory.replace(/\/+$/, '') : directory;
      return 0;
    });
    this.on('d.message.set', (params) => {
      const t = this.torrent(params);
      t.message = string(params);
      return 0;
    });
    const slots = (which: 'uploads' | 'downloads') => (params: unknown[]) => {
      const t = this.torrent(params);
      const count = value(params);
      if (count < 0 || count > 65_536) throw new RpcFault(-503, `Max ${which} must be between 0 and 2^16.`);
      session.setSlots(t.hash, which === 'uploads' ? count : null, which === 'downloads' ? count : null);
      return 0;
    };
    this.on('d.uploads_max.set', slots('uploads'));
    this.on('d.downloads_max.set', slots('downloads'));
    this.on('d.tracker.insert', (params) => {
      const t = this.torrent(params);
      if (params.length !== 3) throw new RpcFault(-503, 'Wrong argument count.');
      session.addTracker(t.hash, string(params, 2), Math.max(0, value(params)));
      return 0;
    });
    this.on('d.multicall2', (params) => {
      const [, view, ...commands] = params;
      if (typeof view !== 'string' || !VIEWS.includes(view)) throw new RpcFault(-503, 'Could not find view.');
      const columns = commands.map((command) => this.column(command, getters));
      return session.all()
        .filter((t) => viewsOf(t).includes(view))
        .map((t) => columns.map((get) => get(t)));
    });
  }

  /** A multicall column: "d.name=" calls the getter; without its "=" it is not a command call. */
  private column<T>(command: unknown, getters: Record<string, T>): T {
    const text = String(command);
    const cut = text.indexOf('=');
    if (cut < 0) throw new RpcFault(-503, `Could not find '=' in command '${text}'.`);
    const name = text.slice(0, cut);
    if (!Object.hasOwn(getters, name)) throw new RpcFault(-503, `Command "${name}" does not exist.`);
    return getters[name];
  }

  /* --------------------------- files, peers, trackers --------------------------- */

  /** "<hash>:f<index>" and the like: the torrent and the item's index or id. */
  private item(params: unknown[], kind: 'f' | 't' | 'p'): { t: SimTorrent; key: string } {
    const target = params[0];
    if (typeof target !== 'string' || target === '') throw new RpcFault(-503, WRONG_TARGET);
    const match = new RegExp(`^([0-9A-Fa-f]{40}):${kind}(.+)$`).exec(target);
    if (!match) throw new RpcFault(-503, WRONG_TARGET);
    if (!this.host.session.has(match[1])) throw new RpcFault(-503, NOT_FOUND);
    return { t: this.host.session.get(match[1]), key: match[2] };
  }

  private index(key: string, length: number): number {
    const index = /^\d+$/.test(key) ? Number(key) : -1;
    if (index < 0 || index >= length) throw new RpcFault(-503, NO_INDEX);
    return index;
  }

  private registerItems(): void {
    const { session } = this.host;
    const files = fileGetters(session);
    for (const [name, get] of Object.entries(files)) {
      this.on(name, (params) => {
        const { t, key } = this.item(params, 'f');
        return get(t, this.index(key, t.files.length));
      });
    }
    this.on('f.priority.set', (params) => {
      const { t, key } = this.item(params, 'f');
      const index = this.index(key, t.files.length);
      const priority = value(params);
      if (priority < 0 || priority > 2) throw new RpcFault(-503, 'Invalid value.');
      session.setFilePriority(t.hash, index, priority);
      return 0;
    });
    this.on('f.multicall', (params) => {
      const t = this.torrent(params);
      const columns = params.slice(2).map((command) => this.column(command, files));
      return t.files.map((_file, i) => columns.map((get) => get(t, i)));
    });

    const trackers = trackerGetters(session);
    for (const [name, get] of Object.entries(trackers)) {
      this.on(name, (params) => {
        const { t, key } = this.item(params, 't');
        return get(t, this.index(key, t.trackers.length));
      });
    }
    const toggle = (enabled: boolean | null) => (params: unknown[]) => {
      const { t, key } = this.item(params, 't');
      const index = this.index(key, t.trackers.length);
      session.setTrackerEnabled(t.hash, index, enabled ?? value(params) !== 0);
      return 0;
    };
    this.on('t.is_enabled.set', toggle(null));
    this.on('t.enable', toggle(true));
    this.on('t.disable', toggle(false));
    this.on('t.multicall', (params) => {
      const t = this.torrent(params);
      const columns = params.slice(2).map((command) => this.column(command, trackers));
      return t.trackers.map((_tracker, i) => columns.map((get) => get(t, i)));
    });

    const peers = peerGetters();
    const peerList = (t: SimTorrent) => session.peers(t.hash) as unknown as Array<Record<string, unknown>>;
    for (const [name, get] of Object.entries(peers)) {
      this.on(name, (params) => {
        const { t, key } = this.item(params, 'p');
        const peer = peerList(t).find((candidate) => candidate.id === key.toUpperCase());
        if (!peer) throw new RpcFault(-503, 'invalid parameters: peer not found');
        return get(peer);
      });
    }
    this.on('p.multicall', (params) => {
      const t = this.torrent(params);
      const columns = params.slice(2).map((command) => this.column(command, peers));
      return peerList(t).map((peer) => columns.map((get) => get(peer)));
    });
  }

  /* ------------------------------- global -------------------------------- */

  private registerGlobal(): void {
    const { session } = this.host;
    for (const setting of SETTINGS) {
      if (setting.get) {
        this.on(setting.get, () => {
          const current = session.settings[setting.key];
          return typeof current === 'boolean' ? flag(current) : current;
        });
      }
      if (setting.set) {
        this.on(setting.set, (params) => {
          if (typeof params[0] !== 'string') throw new RpcFault(-503, 'invalid parameters: target must be a string');
          let next: number | boolean | string;
          switch (setting.kind) {
            case 'uint':
            case 'int':
            case 'rate':
            case 'port':
              next = value(params);
              break;
            case 'bool':
              next = value(params) !== 0;
              break;
            case 'string':
            case 'proxy':
              next = string(params);
              break;
            case 'flags':
              // protocol.encryption.set takes one argument per flag; given none, it refuses.
              next = params.slice(1).map((_flag, i) => string(params, i + 1)).join(',');
              break;
          }
          const refused = applySetting(session.settings, setting.key, next);
          if (refused !== null) throw new RpcFault(-503, refused);
          return 0;
        });
      }
    }
    // From 0.16.15 these setters are stubs that check their value, warn and
    // change nothing, which is why the settings table offers no setter for
    // the HTTP connection limit or the open-file limit.
    const stubs: Array<[command: string, successor: string]> = [
      ['network.http.max_total_connections.set', 'system.sockets.http.min_alloc.set'],
      ['network.max_open_files.set', 'system.sockets.files.min_alloc.set'],
    ];
    for (const [command, successor] of stubs) {
      this.on(command, (params) => {
        if (typeof params[0] !== 'string') throw new RpcFault(-503, 'invalid parameters: target must be a string');
        value(params);
        session.note('W', `${command} is deprecated, use ${successor} instead.`);
        return 0;
      });
    }
    const rates = () => session.globalRates();
    this.on('throttle.global_down.rate', () => rates().down);
    this.on('throttle.global_up.rate', () => rates().up);
    this.on('throttle.global_down.total', () => rates().downTotal);
    this.on('throttle.global_up.total', () => rates().upTotal);
    for (const direction of ['up', 'down'] as const) {
      // throttle.up/down take whole KiB/s (quirk 3); a name rtorrent does not know is created.
      this.on(`throttle.${direction}`, (params) => {
        session.setRtGroup(string(params), direction, value(params, 2) * 1024);
        return 0;
      });
      this.on(`throttle.${direction}.rate`, (params) => session.groupRate(string(params))[direction]);
      this.on(`throttle.${direction}.max`, (params) => session.rtGroup(string(params))?.[direction] ?? -1);
    }
    this.on('network.listen.port', () => session.listenPort());
    this.on('network.open_sockets', () => session.all().reduce((sum, t) => sum + t.peersConnected, 0) + 9);
    this.on('dht.statistics', () => session.dhtStatistics());
    this.on('view.list', () => [...VIEWS]);
    this.on('log.add_output', (params) => {
      const scope = string(params);
      if (!session.attachScope(scope)) throw new RpcFault(-503, `invalid option name : enum:11 name:'${scope}'`);
      return 0;
    });
    const load = (start: boolean) => (params: unknown[]) => {
      const link = string(params);
      // The commands a load runs on the new torrent: its directory and label.
      let directory = '';
      let label = '';
      for (const command of params.slice(2).map(String)) {
        const match = /^(d\.directory\.set|d\.custom1\.set)="?(.*?)"?$/.exec(command);
        if (match?.[1] === 'd.directory.set') directory = match[2];
        if (match?.[1] === 'd.custom1.set') {
          try {
            label = decodeURIComponent(match[2]);
          } catch {
            label = match[2];
          }
        }
      }
      this.host.load(link, start, directory, label);
      return 0;
    };
    this.on('load.normal', load(false));
    this.on('load.verbose', load(false));
    this.on('load.start', load(true));
    this.on('load.start_verbose', load(true));
  }
}
