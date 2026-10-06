/**
 * The session the live demo opens on: legally redistributable torrents only
 * (Linux and BSD images, Blender's open movies, public-domain films, audio
 * and texts, Creative Commons music, open datasets) in a mix of states, every
 * tracker on a reserved example domain (RFC 2606). Times are relative to the
 * moment the page loads, so the session always looks current.
 *
 * Downloads with finishIn complete that many seconds after the page loads:
 * the first inside a minute, so a visitor sees the celebration.
 */

export type InitialState = 'seeding' | 'downloading' | 'paused' | 'stopped' | 'checking';

/** A file: its path under the torrent's directory, its size, and its priority when not normal. */
export type CatalogFile = [path: string, size: number, priority?: number];

export interface CatalogTorrent {
  name: string;
  label: string;
  /** A multi-file torrent's files; a single-file torrent gives its size instead. */
  files?: CatalogFile[];
  size?: number;
  pieceLength: number;
  state: InitialState;
  /** The share of the wanted data on disk; 1 for a complete torrent. */
  progress: number;
  /** Seconds after load the download completes, which fixes its progress instead. */
  finishIn?: number;
  addedDays: number;
  createdDays: number;
  finishedDays?: number;
  /** Uploaded, as a share of what is on disk. */
  ratio: number;
  /** What the swarm gives and takes at the mean, bytes/s. */
  down: number;
  up: number;
  /** The swarm as the trackers' scrapes report it. */
  seeds: number;
  leechers: number;
  /** Peers typically connected while active. */
  peers: number;
  /** Announce tiers; public torrents also get rtorrent's dht:// pseudo-tracker. */
  trackers: string[][];
  isPrivate?: boolean;
  throttle?: string;
  /** d.priority: 0 off, 1 low, 2 normal, 3 high. */
  priority?: number;
  /** What the first tracker answers every announce with. */
  failure?: string;
  /** A checking torrent's hash check: how far it is at load, and how fast it reads. */
  checked?: number;
  hashSpeed?: number;
  /** How much the rates swing around their mean: 1 is the usual. */
  swing?: number;
}

export interface CatalogThrottle {
  name: string;
  up: number;
  down: number;
}

const KiB = 1024;
const MiB = 1024 * KiB;

export const THROTTLES: CatalogThrottle[] = [
  { name: 'background', up: 1 * MiB, down: 4 * MiB },
  { name: 'seedbox', up: 1 * MiB, down: 0 },
];

/** Thirty-six tracks, nine to a part, as the release names them. */
function ghosts(): CatalogFile[] {
  const parts = ['I', 'II', 'III', 'IV'];
  const sizes = [
    31.2, 24.9, 38.7, 19.4, 27.3, 44.1, 22.8, 35.6, 29.9, 26.4, 41.3, 18.7, 33.5, 23.6, 46.2, 28.8, 21.5, 37.9,
    30.4, 25.7, 39.8, 20.6, 34.2, 27.7, 43.4, 24.3, 32.9, 36.8, 22.1, 40.6, 26.9, 29.3, 45.7, 19.9, 35.1, 47.4,
  ];
  return [
    ...sizes.map((size, i): CatalogFile => [
      `${String(i + 1).padStart(2, '0')} ${i + 1} Ghosts ${parts[Math.floor(i / 9)]}.flac`,
      Math.round(size * MiB + i * 7919),
    ]),
    ['Ghosts I-IV.pdf', 14_268_710],
    ['cover.jpg', 1_103_211],
    ['license.txt', 1_244],
  ];
}

const MACLEOD = [
  'Monkeys Spinning Monkeys', 'Sneaky Snitch', 'Fluffing a Duck', 'Carefree', 'Investigations', 'Wallpaper',
  'Scheming Weasel (faster version)', 'Local Forecast - Elevator', 'Cipher', 'Pixel Peeker Polka - faster',
  'Merry Go', 'Hyperfun',
];

function chapters(): CatalogFile[] {
  const minutes = [52.4, 48.9, 47.1, 51.8, 44.6, 55.2, 49.3, 58.7, 50.1, 46.4, 53.9, 57.3];
  return [
    ...minutes.map((length, i): CatalogFile => [
      `adventuresofsherlockholmes_${String(i + 1).padStart(2, '0')}_doyle_64kb.mp3`,
      Math.round(length * 60 * 8000 + i * 613),
    ]),
    ['adventures_sherlock_holmes_librivox.jpg', 212_773],
  ];
}

/**
 * One name longer than the 255 bytes Linux allows a path component: the
 * image's libtorrent stores it shortened, and the Files tab says so ("on disk
 * as …", AGENTS.md quirk 12).
 */
export const LONG_NAME =
  '芥川龍之介_羅生門・鼻・芋粥・地獄変・蜘蛛の糸・杜子春・トロッコ・藪の中・河童・或阿呆の一生_' +
  '青空文庫版テキスト一式_ルビ付き縦書きXHTMLと横書きプレーンテキストの両形式を収録した完全版アーカイブ.zip';

const ARCHIVE_TRACKERS = [['http://bt1.example.org:6969/announce'], ['http://bt2.example.org:6969/announce']];

export const CATALOG: CatalogTorrent[] = [
  {
    name: 'ubuntu-24.04.3-desktop-amd64.iso', label: 'linux', size: 6_343_219_200, pieceLength: 256 * KiB,
    state: 'seeding', progress: 1, addedDays: 34, createdDays: 425, finishedDays: 34, ratio: 3.42,
    down: 0, up: 1.15 * MiB, seeds: 3120, leechers: 141, peers: 14,
    trackers: [['https://torrent.example.org/announce'], ['https://ipv6.torrent.example.org/announce']],
  },
  {
    name: 'debian-13.1.0-amd64-netinst.iso', label: 'linux', size: 783_286_272, pieceLength: 256 * KiB,
    state: 'seeding', progress: 1, addedDays: 141, createdDays: 395, finishedDays: 141, ratio: 12.84,
    down: 0, up: 380 * KiB, seeds: 1890, leechers: 37, peers: 5,
    trackers: [['http://bttracker.example.org:6969/announce']],
  },
  {
    name: 'Fedora-Workstation-Live-43-1.6.x86_64.iso', label: 'linux', size: 2_742_190_080, pieceLength: 256 * KiB,
    state: 'downloading', progress: 0, finishIn: 370, addedDays: 0.03, createdDays: 340, ratio: 0.08,
    down: 3.1 * MiB, up: 420 * KiB, seeds: 812, leechers: 96, peers: 41,
    trackers: [['http://torrent.example.org:6969/announce']],
  },
  {
    name: 'archlinux-2026.10.01-x86_64.iso', label: 'linux', size: 1_434_976_256, pieceLength: 512 * KiB,
    state: 'downloading', progress: 0, finishIn: 42, addedDays: 0.02, createdDays: 5, ratio: 0.11,
    down: 1.4 * MiB, up: 210 * KiB, seeds: 402, leechers: 58, peers: 23, swing: 0.5,
    trackers: [['http://tracker.example.net:6969/announce']],
  },
  {
    name: 'linuxmint-22.2-cinnamon-64bit.iso', label: 'linux', size: 3_036_676_096, pieceLength: MiB,
    state: 'paused', progress: 0.38, addedDays: 2, createdDays: 70, ratio: 0.21,
    down: 2.4 * MiB, up: 300 * KiB, seeds: 655, leechers: 81, peers: 30,
    trackers: [['udp://tracker.example.com:6969/announce'], ['http://tracker.example.org:6969/announce']],
  },
  {
    name: 'FreeBSD-14.3-RELEASE-amd64-dvd1.iso', label: 'bsd', size: 4_773_314_560, pieceLength: MiB,
    state: 'seeding', progress: 1, addedDays: 9, createdDays: 112, finishedDays: 9, ratio: 0.82,
    down: 0, up: 760 * KiB, seeds: 233, leechers: 19, peers: 9,
    trackers: [['udp://tracker.example.net:6969/announce']],
  },
  {
    name: 'NetBSD-10.1-amd64.iso', label: 'bsd', size: 636_174_336, pieceLength: 256 * KiB,
    state: 'stopped', progress: 1, addedDays: 64, createdDays: 305, finishedDays: 64, ratio: 2.1,
    down: 0, up: 120 * KiB, seeds: 64, leechers: 3, peers: 2,
    trackers: [['http://tracker.example.org:6969/announce']],
  },
  {
    name: 'Big Buck Bunny', label: 'movies', pieceLength: MiB,
    files: [
      ['big_buck_bunny_1080p_h264.mov', 725_106_140],
      ['big_buck_bunny_720p_h264.mov', 416_751_190],
      ['big_buck_bunny_480p_stereo.ogg', 160_872_211],
      ['poster.jpg', 140_213],
      ['readme.txt', 1_208],
    ],
    state: 'seeding', progress: 1, addedDays: 210, createdDays: 2400, finishedDays: 210, ratio: 4.31,
    down: 0, up: 240 * KiB, seeds: 341, leechers: 12, peers: 4, throttle: 'seedbox',
    trackers: [['udp://tracker.example.com:6969/announce'], ['http://tracker.example.org:6969/announce']],
  },
  {
    name: 'Sintel (2010)', label: '', pieceLength: MiB,
    files: [
      ['Sintel.2010.1080p.mkv', 1_216_825_472, 2],
      ['Sintel.2010.720p.mkv', 650_191_617],
      ['Subtitles/sintel_de.srt', 1_441],
      ['Subtitles/sintel_en.srt', 1_652],
      ['Subtitles/sintel_es.srt', 1_589],
      ['Subtitles/sintel_fr.srt', 1_757],
      ['Subtitles/sintel_nl.srt', 1_499],
      ['poster.jpg', 263_520],
    ],
    state: 'downloading', progress: 0.31, addedDays: 0.05, createdDays: 5800, ratio: 0.14,
    down: 1.6 * MiB, up: 250 * KiB, seeds: 288, leechers: 44, peers: 17,
    trackers: [['udp://tracker.example.com:6969/announce'], ['udp://tracker.example.net:6969/announce']],
  },
  {
    name: 'Tears of Steel', label: 'movies', pieceLength: 2 * MiB,
    files: [
      ['tears_of_steel_4k.mkv', 2_894_553_088],
      ['tears_of_steel_1080p.mov', 571_328_224],
      ['tears_of_steel_720p.mov', 372_712_960],
      ['subtitles/TOS-de.srt', 6_820],
      ['subtitles/TOS-en.srt', 6_513],
      ['subtitles/TOS-nl.srt', 6_377],
      ['tos-poster.jpg', 380_134],
    ],
    state: 'checking', progress: 0.64, checked: 0.08, hashSpeed: 45 * MiB, addedDays: 0.01, createdDays: 4900, ratio: 0,
    down: 1.3 * MiB, up: 190 * KiB, seeds: 178, leechers: 31, peers: 14,
    trackers: [['udp://tracker.example.net:6969/announce']],
  },
  {
    name: 'Cosmos Laundromat (2015)', label: 'movies', pieceLength: MiB,
    files: [
      ['Cosmos_Laundromat_1080p.mkv', 1_302_390_528],
      ['subs/cosmos_laundromat_en.srt', 3_420],
      ['subs/cosmos_laundromat_nl.srt', 3_602],
      ['cover.jpg', 412_908],
    ],
    state: 'stopped', progress: 1, addedDays: 48, createdDays: 3950, finishedDays: 48, ratio: 1.31,
    down: 0, up: 150 * KiB, seeds: 122, leechers: 4, peers: 3,
    trackers: [['udp://tracker.example.com:6969/announce']],
  },
  {
    name: 'NightOfTheLivingDead1968', label: 'movies', pieceLength: MiB,
    files: [
      ['NightOfTheLivingDead1968.mp4', 1_086_734_551],
      ['NightOfTheLivingDead1968.ogv', 412_331_904],
      ['NightOfTheLivingDead1968_512kb.mp4', 283_955_210],
      ['NightOfTheLivingDead1968.thumbs/NightOfTheLivingDead1968_000001.jpg', 6_211],
      ['NightOfTheLivingDead1968.thumbs/NightOfTheLivingDead1968_000057.jpg', 7_385],
      ['NightOfTheLivingDead1968.thumbs/NightOfTheLivingDead1968_000113.jpg', 6_998],
      ['NightOfTheLivingDead1968.thumbs/NightOfTheLivingDead1968_000169.jpg', 7_114],
      ['__ia_thumb.jpg', 21_454],
      ['NightOfTheLivingDead1968_files.xml', 5_872],
      ['NightOfTheLivingDead1968_meta.xml', 2_113],
    ],
    state: 'seeding', progress: 1, addedDays: 300, createdDays: 1500, finishedDays: 300, ratio: 1.94,
    down: 0, up: 300 * KiB, seeds: 97, leechers: 6, peers: 3, throttle: 'seedbox',
    trackers: ARCHIVE_TRACKERS,
  },
  {
    name: 'Nosferatu_1922', label: 'movies', pieceLength: MiB,
    files: [
      ['Nosferatu_1922.mp4', 928_449_102],
      ['Nosferatu_1922.ogv', 351_216_640],
      ['Nosferatu_1922_512kb.mp4', 241_890_334],
      ['__ia_thumb.jpg', 19_870],
      ['Nosferatu_1922_files.xml', 4_216],
      ['Nosferatu_1922_meta.xml', 1_984],
    ],
    state: 'stopped', progress: 0.71, addedDays: 12, createdDays: 1900, ratio: 0.09,
    down: 900 * KiB, up: 90 * KiB, seeds: 58, leechers: 9, peers: 8,
    trackers: ARCHIVE_TRACKERS,
  },
  {
    name: 'Nine Inch Nails - Ghosts I-IV', label: 'music', pieceLength: MiB, files: ghosts(),
    state: 'seeding', progress: 1, addedDays: 400, createdDays: 6800, finishedDays: 400, ratio: 2.63,
    down: 0, up: 200 * KiB, seeds: 412, leechers: 9, peers: 2,
    trackers: [['udp://tracker.example.com:6969/announce'], ['http://tracker.example.org:6969/announce']],
  },
  {
    name: 'Kevin MacLeod - incompetech selection [FLAC]', label: 'music', pieceLength: 512 * KiB,
    files: MACLEOD.map((title, i): CatalogFile => [`${String(i + 1).padStart(2, '0')} ${title}.flac`, Math.round((24 + ((i * 17) % 31)) * MiB + i * 4099)]),
    state: 'downloading', progress: 0.72, addedDays: 0.04, createdDays: 900, ratio: 0.05,
    down: 450 * KiB, up: 50 * KiB, seeds: 39, leechers: 7, peers: 8,
    trackers: [['udp://tracker.example.net:6969/announce']],
  },
  {
    name: 'adventures_sherlock_holmes_librivox', label: 'books', pieceLength: 512 * KiB, files: chapters(),
    state: 'seeding', progress: 1, addedDays: 75, createdDays: 3300, finishedDays: 75, ratio: 0.71,
    down: 0, up: 100 * KiB, seeds: 44, leechers: 3, peers: 2,
    trackers: [['http://tracker.example.org:6969/announce']],
    failure: 'v6 : Timeout was reached  |  v4 : Timeout was reached',
  },
  {
    name: 'pgdvd042010.iso', label: 'books', size: 8_581_154_816, pieceLength: 4 * MiB,
    state: 'seeding', progress: 1, addedDays: 180, createdDays: 6000, finishedDays: 180, ratio: 5.62,
    down: 0, up: 620 * KiB, seeds: 31, leechers: 4, peers: 4, throttle: 'seedbox',
    trackers: [['udp://tracker.example.com:6969/announce'], ['http://tracker.example.org:6969/announce']],
  },
  {
    name: '青空文庫 芥川龍之介 作品集', label: 'books', pieceLength: 256 * KiB,
    files: [
      ['README.txt', 2_311],
      ['羅生門.zip', 9_812],
      ['鼻.zip', 8_401],
      ['芋粥.zip', 17_903],
      ['地獄変.zip', 21_556],
      ['蜘蛛の糸.zip', 5_128],
      ['杜子春.zip', 11_740],
      ['藪の中.zip', 10_388],
      ['河童.zip', 41_229],
      [LONG_NAME, 31_457_280],
    ],
    state: 'seeding', progress: 1, addedDays: 40, createdDays: 1200, finishedDays: 40, ratio: 1.12,
    down: 0, up: 40 * KiB, seeds: 14, leechers: 2, peers: 1,
    trackers: [['udp://tracker.example.net:6969/announce']],
  },
  {
    name: 'enwiki-20260901-pages-articles-multistream.xml.bz2', label: 'datasets', size: 24_835_198_976, pieceLength: 16 * MiB,
    state: 'downloading', progress: 0.23, addedDays: 0.3, createdDays: 35, ratio: 0.13,
    down: 6 * MiB, up: 600 * KiB, seeds: 42, leechers: 18, peers: 26, throttle: 'background',
    trackers: [['udp://tracker.example.net:6969/announce'], ['http://tracker.example.org:6969/announce']],
  },
  {
    name: 'planet-260928.osm.pbf', label: 'datasets', size: 86_784_113_664, pieceLength: 16 * MiB,
    state: 'downloading', progress: 0.078, addedDays: 0.12, createdDays: 8, ratio: 0.09,
    down: 7 * MiB, up: 900 * KiB, seeds: 58, leechers: 34, peers: 31, throttle: 'background', priority: 1,
    trackers: [['udp://tracker.example.com:6969/announce']],
  },
  {
    name: 'LibriSpeech', label: 'datasets', pieceLength: 4 * MiB,
    files: [
      ['dev-clean.tar.gz', 337_926_286],
      ['dev-other.tar.gz', 314_305_928],
      ['test-clean.tar.gz', 346_663_984],
      ['test-other.tar.gz', 328_757_843],
      ['train-clean-100.tar.gz', 6_387_309_499],
      ['train-clean-360.tar.gz', 23_049_477_885],
      ['train-other-500.tar.gz', 30_593_501_606, 0],
      ['README.TXT', 6_427],
      ['SPEAKERS.TXT', 113_284],
      ['LICENSE.TXT', 18_607],
    ],
    state: 'downloading', progress: 0.42, addedDays: 1.5, createdDays: 3900, ratio: 0.06,
    down: 2.2 * MiB, up: 300 * KiB, seeds: 27, leechers: 12, peers: 18,
    trackers: [['https://academic.example.org/announce.php']],
  },
  {
    name: 'Elephants Dream (2006) 1080p', label: 'movies', pieceLength: MiB,
    files: [
      ['Elephants.Dream.2006.1080p.mkv', 1_108_869_120],
      ['Elephants.Dream.2006.1080p.nfo', 4_211],
      ['Sample/sample.mkv', 31_457_280],
    ],
    state: 'downloading', progress: 0, finishIn: 160, addedDays: 0.06, createdDays: 610, ratio: 0.12,
    down: 900 * KiB, up: 150 * KiB, seeds: 23, leechers: 5, peers: 11, isPrivate: true,
    trackers: [['https://private.example.net/announce/8f14e45fceea167a5a36dedd4bea2543']],
  },
];

/**
 * What the counters say about the years before this session: everything the
 * badges need beyond the torrents loaded now, which the totals then grow from.
 */
export const HISTORY = {
  lifetimeDown: 0.93 * 1024 ** 4,
  lifetimeUp: 1.27 * 1024 ** 4,
  completed: 43,
  everAdded: 71,
  peakDownRate: 12.4 * MiB,
  peakUpRate: 7.1 * MiB,
  peakPeers: 268,
  maxSeeding: 9,
  /** Badges earned before, by days ago. */
  unlocked: {
    'first-contact': 420,
    'touchdown': 419,
    'gigabyte-club': 418,
    'giving-back': 410,
    'marathon': 380,
    'serial-downloader': 300,
    'swarm-master': 250,
    'pillar-of-the-swarm': 200,
    'break-even': 150,
    'speed-demon': 120,
    'overachiever': 90,
    'curator': 60,
  } as Record<string, number>,
  /** How long this rtorrent has been running, and what it has moved meanwhile. */
  uptimeDays: 3.3,
  sessionDown: 88.4 * 1024 ** 3,
  sessionUp: 141.2 * 1024 ** 3,
  diskFree: 1.37 * 1024 ** 4,
};
