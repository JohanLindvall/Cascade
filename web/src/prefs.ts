/**
 * UI preferences live in a JSON file on the server so they follow the install
 * rather than the browser.
 *
 * A localStorage copy is kept purely as a cache: it lets the theme apply on the
 * first paint instead of flashing the default while the fetch is in flight. The
 * file is the source of truth and overwrites the cache once it arrives. The
 * shape and its repair live in preferences.ts, where the tests can reach them.
 */
import { request } from './api';
import { normalizePreferences, type Preferences } from './preferences';

export { DEFAULT_PREFERENCES, type Preferences } from './preferences';

// Also read by the inline pre-paint script in index.html — keep them in step.
const CACHE_KEY = 'cascade.prefs';

export function readCache(): Preferences {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return normalizePreferences(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizePreferences({});
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
  const prefs = normalizePreferences(await request<unknown>('prefs'));
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
  // keepalive lets a save fired just before the tab closes still reach the
  // server; a failure (offline, signed out) leaves the cache consistent.
  request('prefs', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

// The debounce buys nothing if the tab closes inside it: a theme picked and
// the window shut within half a second used to reach only the cache. pagehide
// is the last reliable moment, and keepalive lets the request outlive the tab.
window.addEventListener('pagehide', send);

/**
 * Merge a change into the cache now and into the server file shortly,
 * coalescing rapid changes such as dragging the detail pane. Call it from an
 * event handler, not from inside a state updater — React may run those twice.
 */
export function savePreferences(patch: Partial<Preferences>): void {
  writeCache({ ...readCache(), ...patch });
  pending = { ...pending, ...patch };
  window.clearTimeout(timer);
  timer = window.setTimeout(send, 400);
}
