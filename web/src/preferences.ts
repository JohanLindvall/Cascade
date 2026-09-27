/** Browser-safe schema shared with the server; no DOM access at module load. */
export {
  DEFAULT_PREFERENCES, DETAIL_HEIGHT, normalizePreferences,
  type Preferences,
} from '../../server/src/prefs.ts';
