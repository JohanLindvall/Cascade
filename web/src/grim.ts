/**
 * The black metal theme's text skin for the gamification layer.
 *
 * Purely presentational: achievement ids, progress numbers and unlock state
 * come from the server untouched — only titles, descriptions and rank names
 * are re-carved when the theme is active, so switching themes never changes
 * what is earned.
 */
import type { Achievement, GameState } from './types';

const ACHIEVEMENTS: Record<string, { title: string; description: string }> = {
  'first-contact': {
    title: 'First Blood',
    description: 'Summon your first torrent from the void',
  },
  touchdown: {
    title: 'Ritual Complete',
    description: 'Drag your first download into the mortal realm',
  },
  'serial-downloader': {
    title: 'Harvester of Bits',
    description: 'Complete 10 unholy downloads',
  },
  century: {
    title: 'Hundredfold Damnation',
    description: 'Complete 100 downloads in darkness',
  },
  'gigabyte-club': {
    title: 'Gigabyte Grimoire',
    description: 'Devour 1 GiB from the frozen north',
  },
  'terabyte-club': {
    title: 'Terabyte Throne',
    description: 'Devour a full TiB of forbidden knowledge',
  },
  'giving-back': {
    title: 'Blood Tribute',
    description: 'Offer 1 GiB back to the horde',
  },
  'pillar-of-the-swarm': {
    title: 'Obelisk of the Horde',
    description: 'Offer 100 GiB upon the altar',
  },
  'break-even': {
    title: 'Balance of Souls',
    description: 'Return as much as you have taken',
  },
  overachiever: {
    title: 'Fivefold Sacrifice',
    description: 'Seed a single torrent to a ratio of 5.00',
  },
  'seed-farm': {
    title: 'Necroseeder',
    description: 'Keep 10 torrents seeding as one legion',
  },
  'swarm-master': {
    title: 'Legion of Fifty',
    description: 'Bind 50 peers to your will at once',
  },
  'speed-demon': {
    title: 'Speed Daemon',
    description: 'Ride the storm at 10 MiB/s',
  },
  curator: {
    title: 'Runecarver',
    description: 'Carve your hoard under 5 runes',
  },
  marathon: {
    title: 'Eternal Winter',
    description: 'Seed one torrent for 7 nights unbroken',
  },
};

/** Rank names, keyed by the server's level titles. */
const RANKS: Record<string, string> = {
  Newcomer: 'Mortal',
  Leecher: 'Crypt Leech',
  Sharer: 'Frostbitten',
  Seeder: 'Sower of Plagues',
  Archivist: 'Kvlt Archivist',
  'Swarm Keeper': 'Lord of the Swarm',
  'Torrent Warden': 'Warden of the Abyss',
  Legend: 'Trve Kvlt Legend',
};

export function grimAchievement(item: Achievement): Achievement {
  const carved = ACHIEVEMENTS[item.id];
  return carved ? { ...item, ...carved } : item;
}

/** Re-skin a game state for the black metal theme. */
export function grimGame(game: GameState): GameState {
  return {
    ...game,
    title: RANKS[game.title] ?? game.title,
    achievements: game.achievements.map(grimAchievement),
  };
}
