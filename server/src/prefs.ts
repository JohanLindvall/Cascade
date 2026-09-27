/** Shared preference schema and repair, used for both persisted state and the browser cache. */
export const THEMES = ['system', 'light', 'dark', 'retro', 'blackmetal'] as const;
export type ThemeMode = (typeof THEMES)[number];
export const SORT_KEYS = [
  'name', 'size', 'progress', 'status', 'downRate', 'upRate', 'ratio', 'eta', 'peers', 'addedAt', 'label',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';
export const DETAIL_HEIGHT = { min: 140, max: 2000 } as const;

export interface Preferences {
  theme: ThemeMode;
  sortKey: SortKey;
  sortDir: SortDir;
  detailHeight: number;
  /** Badge ids the user has already been shown a toast for. */
  seenBadges: string[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system', sortKey: 'addedAt', sortDir: 'desc', detailHeight: 280, seenBadges: [],
};

export function isThemeMode(value: unknown): value is ThemeMode {
  return (THEMES as readonly unknown[]).includes(value);
}

export function isSortKey(value: unknown): value is SortKey {
  return (SORT_KEYS as readonly unknown[]).includes(value);
}

/** Merge a patch over current values, repairing invalid fields without retaining unknown keys. */
export function sanitizePreferences(current: Preferences, patch: unknown): Preferences {
  const raw = patch && typeof patch === 'object' && !Array.isArray(patch)
    ? patch as Record<string, unknown> : {};
  const merged: Record<string, unknown> = { ...current, ...raw };
  const height = typeof merged.detailHeight === 'number' ||
    (typeof merged.detailHeight === 'string' && merged.detailHeight.trim() !== '')
    ? Number(merged.detailHeight) : NaN;
  return {
    theme: isThemeMode(merged.theme) ? merged.theme : DEFAULT_PREFERENCES.theme,
    sortKey: isSortKey(merged.sortKey) ? merged.sortKey : DEFAULT_PREFERENCES.sortKey,
    sortDir: merged.sortDir === 'asc' ? 'asc' : 'desc',
    detailHeight: Number.isFinite(height)
      ? Math.min(DETAIL_HEIGHT.max, Math.max(DETAIL_HEIGHT.min, Math.round(height)))
      : DEFAULT_PREFERENCES.detailHeight,
    seenBadges: Array.isArray(merged.seenBadges)
      ? [...new Set(merged.seenBadges.filter((item) => typeof item === 'string' || typeof item === 'number').map(String))].slice(0, 200)
      : [],
  };
}

export function normalizePreferences(value: unknown): Preferences {
  return sanitizePreferences(DEFAULT_PREFERENCES, value);
}
