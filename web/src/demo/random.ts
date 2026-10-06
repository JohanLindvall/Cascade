/**
 * A seeded generator for the simulation, so one seed is one session: the same
 * torrents, hashes, peers and fluctuations on every load. Streams are forked
 * by name rather than drawn from one sequence, so adding a torrent (or a
 * visitor's upload) cannot shift the numbers every other torrent gets.
 */

export interface Random {
  /** A number in [0, 1). */
  next(): number;
  /** A number in [min, max). */
  range(min: number, max: number): number;
  /** A whole number from min to max, both included. */
  int(min: number, max: number): number;
  pick<T>(list: readonly T[]): T;
  chance(probability: number): boolean;
  /** Lower-case hex digits. */
  hex(length: number): string;
  /** An independent stream, the same for the same seed and name. */
  fork(name: string): Random;
}

/** FNV-1a over a string's UTF-16 units: enough to spread names over seeds. */
function hashName(seed: number, name: string): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** mulberry32: small, fast, and good enough for anything that is not cryptography. */
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const random: Random = {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor((max - min + 1) * next()),
    pick: (list) => list[Math.floor(list.length * next())],
    chance: (probability) => next() < probability,
    hex: (length) => {
      let out = '';
      while (out.length < length) out += Math.floor(next() * 16).toString(16);
      return out;
    },
    fork: (name) => seeded(hashName(seed, name)),
  };
  return random;
}
