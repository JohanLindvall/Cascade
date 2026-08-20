/**
 * Light gamification layer: lifetime stats distilled into a level and a set of
 * badges. Everything is derived from real rtorrent numbers — nothing here is
 * invented, and the whole feature can be switched off with CASCADE_GAMIFY=0.
 */

export type Tier = 'bronze' | 'silver' | 'gold';

/** Lifetime counters, accumulated in the store so they survive restarts. */
export interface GameStats {
  lifetimeUp: number;
  lifetimeDown: number;
  completed: number;
  everAdded: number;
  peakDownRate: number;
  peakUpRate: number;
  peakPeers: number;
  bestRatio: number;
  longestSeed: number;
  maxSeeding: number;
  maxLabels: number;
}

export const EMPTY_STATS: GameStats = {
  lifetimeUp: 0,
  lifetimeDown: 0,
  completed: 0,
  everAdded: 0,
  peakDownRate: 0,
  peakUpRate: 0,
  peakPeers: 0,
  bestRatio: 0,
  longestSeed: 0,
  maxSeeding: 0,
  maxLabels: 0,
};

export interface AchievementDef {
  id: string;
  title: string;
  description: string;
  tier: Tier;
  icon: string;
  /** [current, target]; unlocked once current >= target. */
  progress: (stats: GameStats) => [number, number];
}

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;
const DAY = 24 * 60 * 60;

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: 'first-contact',
    title: 'First Contact',
    description: 'Add your first torrent',
    tier: 'bronze',
    icon: 'download',
    progress: (s) => [s.everAdded, 1],
  },
  {
    id: 'touchdown',
    title: 'Touchdown',
    description: 'Finish your first download',
    tier: 'bronze',
    icon: 'target',
    progress: (s) => [s.completed, 1],
  },
  {
    id: 'serial-downloader',
    title: 'Serial Downloader',
    description: 'Finish 10 downloads',
    tier: 'silver',
    icon: 'target',
    progress: (s) => [s.completed, 10],
  },
  {
    id: 'century',
    title: 'Century',
    description: 'Finish 100 downloads',
    tier: 'gold',
    icon: 'trophy',
    progress: (s) => [s.completed, 100],
  },
  {
    id: 'gigabyte-club',
    title: 'Gigabyte Club',
    description: 'Download 1 GiB',
    tier: 'bronze',
    icon: 'download',
    progress: (s) => [s.lifetimeDown, GIB],
  },
  {
    id: 'terabyte-club',
    title: 'Terabyte Club',
    description: 'Download 1 TiB',
    tier: 'gold',
    icon: 'trophy',
    progress: (s) => [s.lifetimeDown, TIB],
  },
  {
    id: 'giving-back',
    title: 'Giving Back',
    description: 'Upload 1 GiB',
    tier: 'bronze',
    icon: 'upload',
    progress: (s) => [s.lifetimeUp, GIB],
  },
  {
    id: 'pillar-of-the-swarm',
    title: 'Pillar of the Swarm',
    description: 'Upload 100 GiB',
    tier: 'gold',
    icon: 'medal',
    progress: (s) => [s.lifetimeUp, 100 * GIB],
  },
  {
    id: 'break-even',
    title: 'Break Even',
    description: 'Reach a lifetime ratio of 1.00',
    tier: 'silver',
    icon: 'star',
    progress: (s) => [
      s.lifetimeDown > 0 ? Math.min(1, s.lifetimeUp / s.lifetimeDown) : 0,
      1,
    ],
  },
  {
    id: 'overachiever',
    title: 'Overachiever',
    description: 'Seed a single torrent to a ratio of 5.00',
    tier: 'silver',
    icon: 'star',
    progress: (s) => [s.bestRatio, 5],
  },
  {
    id: 'seed-farm',
    title: 'Seed Farm',
    description: 'Seed 10 torrents at once',
    tier: 'silver',
    icon: 'upload',
    progress: (s) => [s.maxSeeding, 10],
  },
  {
    id: 'swarm-master',
    title: 'Swarm Master',
    description: 'Hold 50 peer connections at once',
    tier: 'silver',
    icon: 'users',
    progress: (s) => [s.peakPeers, 50],
  },
  {
    id: 'speed-demon',
    title: 'Speed Demon',
    description: 'Hit 10 MiB/s of download',
    tier: 'silver',
    icon: 'bolt',
    progress: (s) => [s.peakDownRate, 10 * MIB],
  },
  {
    id: 'curator',
    title: 'Curator',
    description: 'Organise torrents under 5 labels',
    tier: 'bronze',
    icon: 'tag',
    progress: (s) => [s.maxLabels, 5],
  },
  {
    id: 'marathon',
    title: 'Marathon Seeder',
    description: 'Keep a torrent seeding for 7 days',
    tier: 'gold',
    icon: 'clock',
    progress: (s) => [s.longestSeed, 7 * DAY],
  },
];

export interface Achievement {
  id: string;
  title: string;
  description: string;
  tier: Tier;
  icon: string;
  current: number;
  target: number;
  unlockedAt: number | null;
}

/* --------------------------------- levels -------------------------------- */

/** XP is weighted towards uploading: sharing is the part worth rewarding. */
export function xpFor(stats: GameStats, unlockedCount: number): number {
  return Math.floor(
    (stats.lifetimeUp / MIB) * 2 +
      (stats.lifetimeDown / MIB) * 0.5 +
      stats.completed * 100 +
      unlockedCount * 250,
  );
}

const LEVEL_STEP = 150;

export function levelFor(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / LEVEL_STEP)) + 1;
}

export function xpAtLevel(level: number): number {
  return LEVEL_STEP * Math.pow(Math.max(1, level) - 1, 2);
}

const TITLES: Array<[number, string]> = [
  [40, 'Legend'],
  [30, 'Torrent Warden'],
  [22, 'Swarm Keeper'],
  [15, 'Archivist'],
  [10, 'Seeder'],
  [6, 'Sharer'],
  [3, 'Leecher'],
  [1, 'Newcomer'],
];

export function titleFor(level: number): string {
  return TITLES.find(([threshold]) => level >= threshold)?.[1] ?? 'Newcomer';
}

export interface GameState {
  enabled: boolean;
  xp: number;
  level: number;
  title: string;
  levelXp: number;
  nextLevelXp: number;
  progress: number;
  stats: GameStats;
  unlocked: number;
  total: number;
  achievements: Achievement[];
}

export function buildGameState(
  stats: GameStats,
  unlockedAt: Record<string, number>,
  enabled: boolean,
): GameState {
  const achievements: Achievement[] = ACHIEVEMENTS.map((def) => {
    const [current, target] = def.progress(stats);
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      tier: def.tier,
      icon: def.icon,
      current,
      target,
      unlockedAt: unlockedAt[def.id] ?? null,
    };
  });

  const unlocked = achievements.filter((item) => item.unlockedAt !== null).length;
  const xp = xpFor(stats, unlocked);
  const level = levelFor(xp);
  const levelXp = xpAtLevel(level);
  const nextLevelXp = xpAtLevel(level + 1);

  return {
    enabled,
    xp,
    level,
    title: titleFor(level),
    levelXp,
    nextLevelXp,
    progress: nextLevelXp > levelXp ? (xp - levelXp) / (nextLevelXp - levelXp) : 0,
    stats,
    unlocked,
    total: achievements.length,
    achievements,
  };
}

/** Ids whose progress has reached the target but that are not yet recorded. */
export function newlyUnlocked(
  stats: GameStats,
  unlockedAt: Record<string, number>,
): string[] {
  return ACHIEVEMENTS.filter((def) => {
    if (unlockedAt[def.id] !== undefined) return false;
    const [current, target] = def.progress(stats);
    return current >= target;
  }).map((def) => def.id);
}
