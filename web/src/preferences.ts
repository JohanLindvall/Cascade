/**
 * The shape of the UI preferences and how a stray value is repaired.
 *
 * Pure, and kept apart from prefs.ts (which talks to the server and to
 * localStorage) so the node test runner can reach it: importing prefs.ts
 * touches `window` and `document` at load time.
 */
// Spelled with .ts: the node test runner imports this file directly and
// resolves specifiers literally (Vite and tsc accept either form).
import { isSortKey, type SortDir, type SortKey } from './sort.ts';
import { isThemeMode, type ThemeMode } from './theme.ts';

export interface Preferences {
  theme: ThemeMode;
  sortKey: SortKey;
  sortDir: SortDir;
  detailHeight: number;
  seenBadges: string[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  sortKey: 'addedAt',
  sortDir: 'desc',
  detailHeight: 280,
  seenBadges: [],
};

/** The detail pane's height range; mirrors sanitizePreferences in the server's prefs.ts. */
export const DETAIL_HEIGHT = { min: 140, max: 2000 } as const;

/**
 * Fill a possibly partial, stale or hand-edited record out to a full
 * Preferences. The server sanitises what it stores, but the cache is a
 * browser's localStorage, and an enum-valued field is exactly what a stray
 * value breaks.
 */
export function normalizePreferences(input: unknown): Preferences {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof Preferences, unknown>>;
  const height = Math.round(Number(raw.detailHeight));
  return {
    theme: isThemeMode(raw.theme) ? raw.theme : DEFAULT_PREFERENCES.theme,
    sortKey: isSortKey(raw.sortKey) ? raw.sortKey : DEFAULT_PREFERENCES.sortKey,
    sortDir: raw.sortDir === 'asc' ? 'asc' : 'desc',
    detailHeight: Number.isFinite(height)
      ? Math.min(DETAIL_HEIGHT.max, Math.max(DETAIL_HEIGHT.min, height))
      : DEFAULT_PREFERENCES.detailHeight,
    seenBadges: Array.isArray(raw.seenBadges) ? raw.seenBadges.map(String) : [],
  };
}
