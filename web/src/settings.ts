import type { Settings } from './types.ts';

/** Only edited settings are sent. Empty write-only choices mean leave unchanged. */
export function settingsPatch(stored: Settings, draft: Settings): Settings {
  const patch: Settings = {};
  for (const key of Object.keys(draft) as Array<keyof Settings>) {
    const value = draft[key];
    if (value === undefined || value === stored[key]) continue;
    if ((key === 'encryption' || key === 'dhtMode') && value === '') continue;
    (patch as Record<string, unknown>)[key] = value;
  }
  return patch;
}
