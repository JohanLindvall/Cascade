/**
 * Every environment variable Cascade understands, in one place.
 *
 * This catalog is the single source of truth, not a copy of one:
 *
 *   - `config.ts` takes its defaults from here, so a server option cannot be
 *     read without being documented (the lookup throws on an unknown name).
 *   - `--help` renders it, which is what `docker run cascade --help` prints.
 *   - The README's configuration tables are generated from it.
 *   - `optionsdoc.ts` fails the build if `entrypoint.sh` reads a variable that
 *     is missing here, or if the README has drifted.
 *
 * Adding an option means adding it here; there is nowhere else to update.
 */

export interface OptionDef {
  name: string;
  section: string;
  summary: string;
  /** The value the code falls back to when unset. */
  default?: string;
  /** Shown in place of a default when the code has none. */
  note?: string;
}

/** Section order, which is also the order everything is rendered in. */
export const SECTIONS = [
  'Paths and identity',
  'Bandwidth and slots',
  'Peers',
  'Network',
  'Trackers and DHT',
  'Storage',
  'Resource limits',
  'RPC',
  'Web server',
  'Escape hatches',
] as const;

export type Section = (typeof SECTIONS)[number];

/** Shown under the section heading, where a whole group needs one caveat. */
export const SECTION_NOTES: Partial<Record<Section, string>> = {
  'Bandwidth and slots': 'Rates are in KiB/s; 0 means unlimited.',
  'Escape hatches':
    'Settings given as environment variables are applied over XML-RPC at startup rather than ' +
    'written into rtorrent.rc, so changes made in the UI last until the container restarts.',
};

const RTORRENT_DEFAULT = 'rtorrent default';

export const OPTIONS: OptionDef[] = [
  /* --------------------------- paths and identity -------------------------- */
  {
    name: 'PUID',
    section: 'Paths and identity',
    summary: 'User id rtorrent and the web server run as',
    default: '1000',
  },
  {
    name: 'PGID',
    section: 'Paths and identity',
    summary: 'Group id rtorrent and the web server run as',
    default: '1000',
  },
  { name: 'TZ', section: 'Paths and identity', summary: 'Container timezone', default: 'UTC' },
  {
    name: 'RT_DOWNLOAD_DIR',
    section: 'Paths and identity',
    summary: 'Default download directory',
    default: '/downloads',
  },
  {
    name: 'RT_COMPLETED_DIR',
    section: 'Paths and identity',
    summary: 'Move finished downloads here',
    note: 'unset',
  },
  {
    name: 'RT_SESSION_DIR',
    section: 'Paths and identity',
    summary: "rtorrent's session state",
    default: '/config/session',
  },
  {
    name: 'RT_WATCH_DIR',
    section: 'Paths and identity',
    summary: '.torrent files dropped here are loaded and started',
    default: '/watch',
  },
  {
    name: 'RT_WATCH_ENABLE',
    section: 'Paths and identity',
    summary: 'Set 0 to ignore the watch directory',
    default: '1',
  },
  {
    name: 'RT_WATCH_INTERVAL',
    section: 'Paths and identity',
    summary: 'Watch-directory poll interval, seconds',
    default: '10',
  },
  {
    name: 'RT_LOG_FILE',
    section: 'Paths and identity',
    summary: "rtorrent's log file, surfaced in the UI",
    default: '/config/rtorrent.log',
  },
  {
    name: 'RT_LOG_LEVEL',
    section: 'Paths and identity',
    summary: 'Log scopes: info, debug, dht_debug, tracker_debug, …',
    default: 'info',
  },
  {
    name: 'RT_UMASK',
    section: 'Paths and identity',
    summary: 'umask rtorrent creates files with',
    default: '0022',
  },
  {
    name: 'CASCADE_STATE_FILE',
    section: 'Paths and identity',
    summary: 'Preferences, progress, add times and throttle groups',
    default: '/config/cascade-state.json',
  },
  {
    name: 'CASCADE_CHOWN_DOWNLOADS',
    section: 'Paths and identity',
    summary: 'Set 1 to chown the download directory at startup (slow on large libraries)',
    default: '0',
  },
  {
    name: 'RT_SESSION_LOCK_KEEP',
    section: 'Paths and identity',
    summary: 'Set 1 to keep a leftover rtorrent.lock instead of clearing it',
    default: '0',
  },

  /* --------------------------- bandwidth and slots ------------------------- */
  {
    name: 'RT_DOWNLOAD_RATE',
    section: 'Bandwidth and slots',
    summary: 'Global download limit',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_UPLOAD_RATE',
    section: 'Bandwidth and slots',
    summary: 'Global upload limit',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MAX_UPLOADS',
    section: 'Bandwidth and slots',
    summary: 'Upload slots per torrent',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MIN_UPLOADS',
    section: 'Bandwidth and slots',
    summary: 'Minimum upload slots per torrent',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MAX_UPLOADS_GLOBAL',
    section: 'Bandwidth and slots',
    summary: 'Upload slots across all torrents',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MAX_DOWNLOADS',
    section: 'Bandwidth and slots',
    summary: 'Download slots per torrent',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MIN_DOWNLOADS',
    section: 'Bandwidth and slots',
    summary: 'Minimum download slots per torrent',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MAX_DOWNLOADS_GLOBAL',
    section: 'Bandwidth and slots',
    summary: 'Download slots across all torrents',
    note: RTORRENT_DEFAULT,
  },

  /* --------------------------------- peers --------------------------------- */
  {
    name: 'RT_MIN_PEERS',
    section: 'Peers',
    summary: 'Minimum peers while leeching',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MAX_PEERS',
    section: 'Peers',
    summary: 'Maximum peers while leeching',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MIN_PEERS_SEED',
    section: 'Peers',
    summary: 'Minimum peers while seeding (-1 disables)',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MAX_PEERS_SEED',
    section: 'Peers',
    summary: 'Maximum peers while seeding (-1 disables)',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_PEX',
    section: 'Peers',
    summary: 'Peer exchange, yes/no',
    note: RTORRENT_DEFAULT,
  },

  /* -------------------------------- network -------------------------------- */
  {
    name: 'RT_PORT_RANGE',
    section: 'Network',
    summary: 'Incoming peer port range',
    default: '50000-50000',
  },
  {
    name: 'RT_PORT_RANDOM',
    section: 'Network',
    summary: 'Pick a random port from the range, yes/no',
    default: 'no',
  },
  {
    name: 'RT_PORT_OPEN',
    section: 'Network',
    summary: 'Open the listening port, yes/no (removed in rtorrent 0.16)',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_ENCRYPTION',
    section: 'Network',
    summary: 'e.g. allow_incoming,try_outgoing,enable_retry',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_BIND',
    section: 'Network',
    summary: 'Bind address for outgoing connections',
    note: 'unset',
  },
  { name: 'RT_IP', section: 'Network', summary: 'Address reported to trackers', note: 'unset' },
  {
    name: 'RT_BIND_IPV4',
    section: 'Network',
    summary: 'IPv4 bind address (rtorrent 0.16+)',
    note: 'unset',
  },
  {
    name: 'RT_BIND_IPV6',
    section: 'Network',
    summary: 'IPv6 bind address (rtorrent 0.16+)',
    note: 'unset',
  },
  {
    name: 'RT_PROXY',
    section: 'Network',
    summary: 'HTTP proxy for tracker announces',
    note: 'unset',
  },
  {
    name: 'RT_PROXY_HTTP',
    section: 'Network',
    summary: 'Proxy for all HTTP traffic (rtorrent 0.16+)',
    note: 'unset',
  },
  {
    name: 'RT_PROXY_GLOBAL',
    section: 'Network',
    summary: 'Proxy for all traffic (rtorrent 0.16+)',
    note: 'unset',
  },
  {
    name: 'RT_BLOCK_OUTGOING',
    section: 'Network',
    summary: 'yes refuses outgoing connections (rtorrent 0.16+)',
    note: RTORRENT_DEFAULT,
  },

  /* ----------------------------- trackers and DHT --------------------------- */
  {
    name: 'RT_DHT',
    section: 'Trackers and DHT',
    summary: 'disable, off, auto or on',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_DHT_PORT',
    section: 'Trackers and DHT',
    summary: 'DHT UDP port',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_DHT_OVERRIDE_PORT',
    section: 'Trackers and DHT',
    summary: 'Announce a different DHT port (rtorrent 0.16+)',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_UDP_TRACKERS',
    section: 'Trackers and DHT',
    summary: 'Allow UDP trackers, yes/no',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_TRACKER_NUMWANT',
    section: 'Trackers and DHT',
    summary: 'Peers requested per announce (-1 leaves it to the tracker)',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_HTTP_CAPATH',
    section: 'Trackers and DHT',
    summary: 'Directory of CA certificates for tracker TLS',
    note: 'unset',
  },
  {
    name: 'RT_HTTP_CACERT',
    section: 'Trackers and DHT',
    summary: 'CA bundle file for tracker TLS',
    note: 'unset',
  },
  {
    name: 'RT_SSL_VERIFY_PEER',
    section: 'Trackers and DHT',
    summary: 'Verify tracker TLS certificates, yes/no',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_SSL_VERIFY_HOST',
    section: 'Trackers and DHT',
    summary: 'Verify tracker TLS hostnames, yes/no',
    note: RTORRENT_DEFAULT,
  },

  /* -------------------------------- storage -------------------------------- */
  {
    name: 'RT_PREALLOCATE',
    section: 'Storage',
    summary: 'Preallocate files, yes/no',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_HASH_ON_COMPLETION',
    section: 'Storage',
    summary: 'Re-verify on completion, yes/no',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_ADVISE_RANDOM_HASHING',
    section: 'Storage',
    summary: 'Random-access hint while hashing, yes/no (rtorrent 0.16+)',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MEMORY_MAX',
    section: 'Storage',
    summary: 'Piece memory cap, bytes',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MAX_FILE_SIZE',
    section: 'Storage',
    summary: 'Largest accepted file, bytes',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_SYNC_TIMEOUT',
    section: 'Storage',
    summary: 'Piece disk-sync timeout, seconds',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_PRELOAD_TYPE',
    section: 'Storage',
    summary: 'Piece preload: 0 off, 1 madvise, 2 direct paging',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_PRELOAD_MIN_SIZE',
    section: 'Storage',
    summary: 'Only preload torrents above this piece size, bytes',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_PRELOAD_MIN_RATE',
    section: 'Storage',
    summary: 'Only preload above this upload rate, bytes/s',
    note: RTORRENT_DEFAULT,
  },

  /* ----------------------------- resource limits ---------------------------- */
  {
    name: 'RT_MAX_OPEN_FILES',
    section: 'Resource limits',
    summary: 'Open file handle cap',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MAX_OPEN_SOCKETS',
    section: 'Resource limits',
    summary: 'Open socket cap',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_MAX_HTTP_OPEN',
    section: 'Resource limits',
    summary: 'Concurrent HTTP requests (read-only on rtorrent 0.16+)',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_HTTP_MAX_HOST',
    section: 'Resource limits',
    summary: 'HTTP connections per host (rtorrent 0.16+)',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_DNS_CACHE_TIMEOUT',
    section: 'Resource limits',
    summary: 'DNS cache lifetime, seconds',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_RECEIVE_BUFFER',
    section: 'Resource limits',
    summary: 'Socket receive buffer, bytes',
    note: RTORRENT_DEFAULT,
  },
  {
    name: 'RT_SEND_BUFFER',
    section: 'Resource limits',
    summary: 'Socket send buffer, bytes',
    note: RTORRENT_DEFAULT,
  },

  /* ---------------------------------- RPC ---------------------------------- */
  {
    name: 'RT_SCGI_SOCKET',
    section: 'RPC',
    summary: 'Unix socket rtorrent listens on',
    default: '/run/rtorrent/rpc.socket',
  },
  {
    name: 'RT_SCGI_PORT',
    section: 'RPC',
    summary: 'Also listen for SCGI on this TCP port (unauthenticated — keep it private)',
    note: 'unset',
  },
  {
    name: 'RT_SCGI_BIND',
    section: 'RPC',
    summary: 'Interface for RT_SCGI_PORT',
    default: '127.0.0.1',
  },
  {
    name: 'RT_XMLRPC_SIZE_LIMIT',
    section: 'RPC',
    summary: 'Max XML-RPC request size, bytes (raises the .torrent upload ceiling)',
    default: '16777216',
  },
  {
    name: 'CASCADE_SCGI',
    section: 'RPC',
    summary: 'Endpoint the web server talks to — a path, or host:port for a remote rtorrent',
    note: 'RT_SCGI_SOCKET',
  },

  /* ------------------------------- web server ------------------------------- */
  { name: 'WEB_PORT', section: 'Web server', summary: 'HTTP port', default: '8080' },
  { name: 'WEB_HOST', section: 'Web server', summary: 'Bind address', default: '0.0.0.0' },
  {
    name: 'WEB_USER',
    section: 'Web server',
    summary: 'Basic-auth user; auth is enabled only when both are set',
    note: 'unset (no auth)',
  },
  {
    name: 'WEB_PASS',
    section: 'Web server',
    summary: 'Basic-auth password',
    note: 'unset (no auth)',
  },
  {
    name: 'WEB_BASE_PATH',
    section: 'Web server',
    summary: 'Serve under a sub-path, e.g. /rtorrent',
    default: '/',
  },
  {
    name: 'CASCADE_ALLOW_RAW_RPC',
    section: 'Web server',
    summary: 'Set 0 to disable the API console and /RPC2',
    default: '1',
  },
  {
    name: 'CASCADE_ALLOW_DATA_DELETE',
    section: 'Web server',
    summary: 'Set 0 to forbid deleting downloaded data',
    default: '1',
  },
  {
    name: 'CASCADE_DELETE_ROOTS',
    section: 'Web server',
    summary: 'Extra :-separated roots data may be deleted from',
    note: 'download + completed dirs',
  },
  {
    name: 'CASCADE_MAX_UPLOAD_MB',
    section: 'Web server',
    summary: 'Largest accepted .torrent upload, MiB',
    default: '64',
  },
  {
    name: 'CASCADE_POLL_MS',
    section: 'Web server',
    summary: 'Backend sampling interval for the rate graph, ms',
    default: '1000',
  },
  {
    name: 'CASCADE_GAMIFY',
    section: 'Web server',
    summary: 'Set 0 to remove levels, badges and celebrations',
    default: '1',
  },
  {
    name: 'CASCADE_WEB_ROOT',
    section: 'Web server',
    summary: 'Directory the built UI is served from',
    default: '/app/web',
  },

  /* ----------------------------- escape hatches ----------------------------- */
  {
    name: 'RT_EXTRA_CONFIG',
    section: 'Escape hatches',
    summary: 'Raw rtorrent.rc lines appended to the generated config',
    note: 'unset',
  },
  {
    name: 'RT_EXTRA_CONFIG_FILE',
    section: 'Escape hatches',
    summary: 'File of extra rtorrent.rc lines to append',
    note: 'unset',
  },
  {
    name: 'RT_CONFIG_FILE',
    section: 'Escape hatches',
    summary: 'Use this rtorrent.rc verbatim instead of generating one',
    default: '/config/rtorrent.rc',
  },
  {
    name: 'RT_CONFIG_KEEP',
    section: 'Escape hatches',
    summary: 'Set 0 to regenerate RT_CONFIG_FILE on every start',
    default: '1',
  },
  {
    name: 'CASCADE_BOOT_SETTINGS',
    section: 'Escape hatches',
    summary: 'Where the entrypoint stages the settings it hands the server',
    default: '/run/cascade/boot-settings.json',
  },
];

/**
 * The canonical `docker run` invocation, shown by --help and pasted into the
 * README by `npm run options:docs` so the two can never disagree.
 */
export const USAGE_EXAMPLE = [
  'docker run \\',
  '  -d \\',
  '  --name=cascade \\',
  '  -e PUID=1000 \\',
  '  -e PGID=1000 \\',
  '  -e TZ=Europe/Stockholm \\',
  '  -e WEB_USER=admin \\',
  '  -e WEB_PASS=change-me \\',
  '  -e RT_PORT_RANGE=50000-50000 \\',
  '  -p 8080:8080 \\',
  '  -p 50000:50000 \\',
  '  -p 50000:50000/udp \\',
  '  -v /home/torrent/config:/config \\',
  '  -v /home/torrent/downloads:/downloads \\',
  '  -v /home/torrent/watch:/watch \\',
  '  --restart unless-stopped \\',
  '  ghcr.io/johanlindvall/cascade:latest',
].join('\n');

const BY_NAME = new Map(OPTIONS.map((option) => [option.name, option]));

/**
 * The documented default for an option.
 *
 * Throws for a name that is not catalogued, which is what stops the server
 * reading an undocumented environment variable: `config.ts` goes through here.
 */
export function documentedDefault(name: string): string | undefined {
  const option = BY_NAME.get(name);
  if (!option) {
    throw new Error(`${name} is read but not listed in options.ts — add it there`);
  }
  return option.default;
}

export function optionsIn(section: string): OptionDef[] {
  return OPTIONS.filter((option) => option.section === section);
}

/** What is shown in the "default" column when the code has no fallback. */
function defaultLabel(option: OptionDef): string {
  return option.default ?? option.note ?? '—';
}

/* -------------------------------- rendering ------------------------------- */

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** `docker run --rm cascade --help`. */
export function renderHelp(width = 96): string {
  const nameWidth = Math.max(...OPTIONS.map((option) => option.name.length));
  // The default rides at the end of the description rather than in a column of
  // its own: one long note would otherwise squeeze every summary on the page.
  const textWidth = Math.max(32, width - nameWidth - 4);

  const out: string[] = [
    'Cascade — a web UI for rtorrent, with rtorrent itself in the image.',
    '',
    'Usage:',
    ...USAGE_EXAMPLE.split('\n').map((line) => `  ${line}`),
    '',
    'Volumes:',
    '  /config     rtorrent session, log, and Cascade state — keep this one',
    '  /downloads  where the data lands',
    '  /watch      .torrent files dropped here are loaded and started',
    '',
    'Ports:',
    '  8080        the web UI and API (WEB_PORT)',
    '  50000       peer traffic, TCP and UDP (RT_PORT_RANGE)',
    '',
    'Everything else is an environment variable (-e NAME=value). Only what you',
    'set is applied; anything left unset keeps the default shown below.',
  ];

  for (const section of SECTIONS) {
    const options = optionsIn(section);
    if (options.length === 0) continue;
    out.push('', section.toUpperCase());
    const note = SECTION_NOTES[section];
    if (note) for (const line of wrap(note, width - 2)) out.push(`  ${line}`);
    for (const option of options) {
      const lines = wrap(`${option.summary} [${defaultLabel(option)}]`, textWidth);
      out.push(`  ${option.name.padEnd(nameWidth)}  ${lines[0]}`);
      for (const extra of lines.slice(1)) {
        out.push(`  ${' '.repeat(nameWidth)}  ${extra}`);
      }
    }
  }

  out.push('', 'Full documentation: https://github.com/JohanLindvall/Cascade');
  return out.join('\n');
}

/** The README's configuration tables. */
export function renderMarkdown(): string {
  const out: string[] = [];
  for (const section of SECTIONS) {
    const options = optionsIn(section);
    if (options.length === 0) continue;
    out.push(`### ${section}`, '');
    const note = SECTION_NOTES[section];
    if (note) out.push(note, '');
    out.push('| Variable | Default | Meaning |', '| --- | --- | --- |');
    for (const option of options) {
      const value = option.default ? `\`${option.default}\`` : (option.note ?? '—');
      out.push(`| \`${option.name}\` | ${value} | ${option.summary} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}
