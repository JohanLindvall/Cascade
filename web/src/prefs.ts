/**
 * UI preferences live in a JSON file on the server so they follow the install
 * rather than the browser.
 *
 * A localStorage copy is kept purely as a cache: it lets the theme apply on the
 * first paint instead of flashing the default while the fetch is in flight. The
 * file is the source of truth and overwrites the cache once it arrives.
 */
import { API_BASE } from './api';
import { isSortKey, type SortDir, type SortKey } from './sort';
import { isThemeMode, type ThemeMode } from './theme';

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

// Also read by the inline pre-paint script in index.html — keep them in step.
const CACHE_KEY = 'cascade.prefs';

/**
 * Fill a possibly partial or hand-edited record out to a full Preferences.
 * The server sanitises what it stores, but the cache is a browser's
 * localStorage and the enum-valued fields are the ones a stray value breaks.
 */
function complete(partial: Partial<Preferences>): Preferences {
  const merged = { ...DEFAULT_PREFERENCES, ...partial };
  return {
    ...merged,
    theme: isThemeMode(merged.theme) ? merged.theme : DEFAULT_PREFERENCES.theme,
    sortKey: isSortKey(merged.sortKey) ? merged.sortKey : DEFAULT_PREFERENCES.sortKey,
    sortDir: merged.sortDir === 'asc' ? 'asc' : 'desc',
    seenBadges: Array.isArray(merged.seenBadges) ? merged.seenBadges.map(String) : [],
  };
}

export function readCache(): Preferences {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return complete(raw ? (JSON.parse(raw) as Partial<Preferences>) : {});
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function writeCache(prefs: Preferences): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or a full quota; the server copy still holds.
  }
}

export async function fetchPreferences(): Promise<Preferences> {
  const response = await fetch(`${API_BASE}prefs`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`could not load preferences (${response.status})`);
  const prefs = complete((await response.json()) as Partial<Preferences>);
  writeCache(prefs);
  return prefs;
}

let pending: Partial<Preferences> = {};
let timer: number | undefined;

function send(): void {
  window.clearTimeout(timer);
  timer = undefined;
  if (Object.keys(pending).length === 0) return;
  const body = pending;
  pending = {};
  void fetch(`${API_BASE}prefs`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // Let a save fired just before the tab closes still reach the server.
    keepalive: true,
  }).catch(() => {
    // Offline or unauthenticated: the cache keeps the UI consistent.
  });
}

// The debounce buys nothing if the tab closes inside it: a theme picked and
// the window shut within half a second used to reach only the cache. pagehide
// is the last reliable moment, and keepalive lets the request outlive the tab.
window.addEventListener('pagehide', send);

/** Merge-and-save, coalescing rapid changes such as dragging the detail pane. */
export function savePreferences(patch: Partial<Preferences>, current: Preferences): void {
  writeCache({ ...current, ...patch });
  pending = { ...pending, ...patch };
  window.clearTimeout(timer);
  timer = window.setTimeout(send, 400);
}
