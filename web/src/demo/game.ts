/**
 * The gamification layer as the server computes it (server/internal/game):
 * the badge table, the XP weighting and the level curve, ported so the demo's
 * level and badges follow from its own transfer totals rather than being
 * painted on. game.test.ts holds the ids and titles to web/src/game-catalog.json,
 * which the Go tests hold to the server's table.
 */
import type { Achievement, GameState, GameStats, ProgressUnit, Tier } from '../contracts.ts';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const TIB = 1024 * GIB;
const DAY = 24 * 60 * 60;

interface Def {
  id: string;
  title: string;
  description: string;
  tier: Tier;
  icon: string;
  unit: ProgressUnit;
  progress: (stats: GameStats) => [current: number, target: number];
}

export const ACHIEVEMENTS: readonly Def[] = [
  { id: 'first-contact', title: 'First Contact', description: 'Add your first torrent', tier: 'bronze', icon: 'download', unit: 'count', progress: (s) => [s.everAdded, 1] },
  { id: 'touchdown', title: 'Touchdown', description: 'Finish your first download', tier: 'bronze', icon: 'target', unit: 'count', progress: (s) => [s.completed, 1] },
  { id: 'serial-downloader', title: 'Serial Downloader', description: 'Finish 10 downloads', tier: 'silver', icon: 'target', unit: 'count', progress: (s) => [s.completed, 10] },
  { id: 'century', title: 'Century', description: 'Finish 100 downloads', tier: 'gold', icon: 'trophy', unit: 'count', progress: (s) => [s.completed, 100] },
  { id: 'gigabyte-club', title: 'Gigabyte Club', description: 'Download 1 GiB', tier: 'bronze', icon: 'download', unit: 'bytes', progress: (s) => [s.lifetimeDown, GIB] },
  { id: 'terabyte-club', title: 'Terabyte Club', description: 'Download 1 TiB', tier: 'gold', icon: 'trophy', unit: 'bytes', progress: (s) => [s.lifetimeDown, TIB] },
  { id: 'giving-back', title: 'Giving Back', description: 'Upload 1 GiB', tier: 'bronze', icon: 'upload', unit: 'bytes', progress: (s) => [s.lifetimeUp, GIB] },
  { id: 'pillar-of-the-swarm', title: 'Pillar of the Swarm', description: 'Upload 100 GiB', tier: 'gold', icon: 'medal', unit: 'bytes', progress: (s) => [s.lifetimeUp, 100 * GIB] },
  {
    id: 'break-even', title: 'Break Even', description: 'Reach a lifetime ratio of 1.00', tier: 'silver', icon: 'star', unit: 'ratio',
    progress: (s) => [s.lifetimeDown > 0 ? Math.min(1, s.lifetimeUp / s.lifetimeDown) : 0, 1],
  },
  { id: 'overachiever', title: 'Overachiever', description: 'Seed a single torrent to a ratio of 5.00', tier: 'silver', icon: 'star', unit: 'ratio', progress: (s) => [s.bestRatio, 5] },
  { id: 'seed-farm', title: 'Seed Farm', description: 'Seed 10 torrents at once', tier: 'silver', icon: 'upload', unit: 'count', progress: (s) => [s.maxSeeding, 10] },
  { id: 'swarm-master', title: 'Swarm Master', description: 'Hold 50 peer connections at once', tier: 'silver', icon: 'users', unit: 'count', progress: (s) => [s.peakPeers, 50] },
  { id: 'speed-demon', title: 'Speed Demon', description: 'Hit 10 MiB/s of download', tier: 'silver', icon: 'bolt', unit: 'rate', progress: (s) => [s.peakDownRate, 10 * MIB] },
  { id: 'curator', title: 'Curator', description: 'Organise torrents under 5 labels', tier: 'bronze', icon: 'tag', unit: 'count', progress: (s) => [s.maxLabels, 5] },
  { id: 'marathon', title: 'Marathon Seeder', description: 'Keep a torrent seeding for 7 days', tier: 'gold', icon: 'clock', unit: 'duration', progress: (s) => [s.longestSeed, 7 * DAY] },
];

/** Level titles, highest threshold first. */
export const TITLES: ReadonlyArray<{ from: number; name: string }> = [
  { from: 40, name: 'Legend' },
  { from: 30, name: 'Torrent Warden' },
  { from: 22, name: 'Swarm Keeper' },
  { from: 15, name: 'Archivist' },
  { from: 10, name: 'Seeder' },
  { from: 6, name: 'Sharer' },
  { from: 3, name: 'Leecher' },
  { from: 1, name: 'Newcomer' },
];

const LEVEL_STEP = 150;

/** XP leans towards uploading: sharing is the part worth rewarding. */
export function xpFor(stats: GameStats, unlocked: number): number {
  const xp = Math.floor(stats.lifetimeUp / MIB * 2 + stats.lifetimeDown / MIB * 0.5 + stats.completed * 100 + unlocked * 250);
  return Math.min(xp, Number.MAX_SAFE_INTEGER);
}

export function levelFor(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / LEVEL_STEP)) + 1;
}

export function xpAtLevel(level: number): number {
  const steps = Math.max(1, level) - 1;
  return LEVEL_STEP * steps * steps;
}

export function titleFor(level: number): string {
  return TITLES.find((title) => level >= title.from)?.name ?? 'Newcomer';
}

/** The ids whose progress has reached the target but are not yet recorded. */
export function newlyUnlocked(stats: GameStats, unlockedAt: Readonly<Record<string, number>>): string[] {
  return ACHIEVEMENTS.filter((def) => {
    if (Object.hasOwn(unlockedAt, def.id)) return false;
    const [current, target] = def.progress(stats);
    return current >= target;
  }).map((def) => def.id);
}

/** The game as the UI shows it, built as BuildState builds it. */
export function buildGame(stats: GameStats, unlockedAt: Readonly<Record<string, number>>): GameState {
  let unlocked = 0;
  const achievements: Achievement[] = ACHIEVEMENTS.map((def) => {
    const [current, target] = def.progress(stats);
    const at = Object.hasOwn(unlockedAt, def.id) ? unlockedAt[def.id] : null;
    if (at !== null) unlocked++;
    return {
      id: def.id, title: def.title, description: def.description, tier: def.tier,
      icon: def.icon, unit: def.unit, current, target, unlockedAt: at,
    };
  });
  const xp = xpFor(stats, unlocked);
  const level = levelFor(xp);
  const levelXp = xpAtLevel(level);
  const nextLevelXp = xpAtLevel(level + 1);
  return {
    enabled: true,
    xp,
    level,
    title: titleFor(level),
    levelXp,
    nextLevelXp,
    progress: nextLevelXp > levelXp ? (xp - levelXp) / (nextLevelXp - levelXp) : 0,
    stats: { ...stats },
    unlocked,
    total: achievements.length,
    achievements,
  };
}
