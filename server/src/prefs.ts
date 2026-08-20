/**
 * UI preference shape and validation.
 *
 * Persistence belongs to the state store — preferences, gamification progress
 * and the per-torrent bookkeeping all live in the same JSON file so there is a
 * single thing to back up or delete.
 */
export interface Preferences {
  /** system | light | dark | retro */
  theme: string;
  sortKey: string;
  sortDir: 'asc' | 'desc';
  detailHeight: number;
  /** Badge ids the user has already been shown a toast for. */
  seenBadges: string[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  sortKey: 'addedAt',
  sortDir: 'desc',
  detailHeight: 280,
  seenBadges: [],
};

const SORT_KEYS = new Set([
  'name',
  'size',
  'progress',
  'status',
  'downRate',
  'upRate',
  'ratio',
  'eta',
  'peers',
  'addedAt',
  'label',
]);
const THEMES = new Set(['system', 'light', 'dark', 'retro']);

/** Merge a patch over the current values, dropping anything malformed. */
export function sanitizePreferences(
  current: Preferences,
  patch: Partial<Preferences>,
): Preferences {
  const merged = { ...current, ...patch };
  return {
    theme: THEMES.has(String(merged.theme)) ? String(merged.theme) : DEFAULT_PREFERENCES.theme,
    sortKey: SORT_KEYS.has(String(merged.sortKey))
      ? String(merged.sortKey)
      : DEFAULT_PREFERENCES.sortKey,
    sortDir: merged.sortDir === 'asc' ? 'asc' : 'desc',
    detailHeight: Math.min(
      2000,
      Math.max(140, Math.round(Number(merged.detailHeight) || DEFAULT_PREFERENCES.detailHeight)),
    ),
    seenBadges: Array.isArray(merged.seenBadges)
      ? [...new Set(merged.seenBadges.map(String))].slice(0, 200)
      : [],
  };
}
