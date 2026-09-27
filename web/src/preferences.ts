/**
 * The preference schema and its repair: what the server stores in its state
 * file, and what the browser's cached copy is checked against before use. The
 * Go server mirrors it in server/internal/prefs; keep the two in step. No DOM
 * access at module load, so the node test runner can reach it.
 */
export const THEMES = ['system', 'light', 'dark', 'retro', 'blackmetal'] as const;
export type ThemeMode = (typeof THEMES)[number];
export const SORT_KEYS = [
  'name', 'size', 'progress', 'status', 'downRate', 'upRate', 'ratio', 'eta', 'peers', 'addedAt', 'label',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';
export const DETAIL_HEIGHT = { min: 140, max: 2000 } as const;
/** How often the server may read the state, ms: faster than a tenth of a second shows nothing
 *  new and costs rtorrent. Mirrors internal/prefs on the server. */
export const STATE_POLL_MS = { min: 100, max: 60_000 } as const;

export interface Preferences {
  theme: ThemeMode;
  sortKey: SortKey;
  sortDir: SortDir;
  detailHeight: number;
  /** Badge ids the user has already been shown a toast for. */
  seenBadges: string[];
  /** How often the state is read, ms; null leaves it to CASCADE_STATE_POLL_MS. */
  statePollMs: number | null;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system', sortKey: 'addedAt', sortDir: 'desc', detailHeight: 280, seenBadges: [], statePollMs: null,
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
  const numeric = (value: unknown) =>
    typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
  const height = numeric(merged.detailHeight);
  const poll = numeric(merged.statePollMs);
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
    // Anything that is not a number, null included, means "the server's default".
    statePollMs: Number.isFinite(poll)
      ? Math.min(STATE_POLL_MS.max, Math.max(STATE_POLL_MS.min, Math.round(poll)))
      : null,
  };
}

export function normalizePreferences(value: unknown): Preferences {
  return sanitizePreferences(DEFAULT_PREFERENCES, value);
}
