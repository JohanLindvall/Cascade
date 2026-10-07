// SPDX-License-Identifier: MIT

import { parseRate } from './format.ts';
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

/**
 * The highest global rate the server takes, bytes/s (MaxRate in
 * server/internal/rtorrent/settings.go): rtorrent keeps the global rates in
 * whole KiB/s in 32 bits, and this is the most whole KiB/s under the
 * 4294967294 bytes/s that 0.16.25 refuses past and earlier releases wrapped
 * around (4 GiB/s became 0, unlimited).
 */
export const MAX_RATE = 4194303 * 1024;

/**
 * A global rate as the server applies it: rounded up to the next whole KiB/s,
 * since rtorrent drops the fraction and a positive rate under 1 KiB/s would
 * otherwise become 0, unlimited.
 */
export function appliedRate(bytesPerSecond: number): number {
  return Math.ceil(bytesPerSecond / 1024) * 1024;
}

/** A global rate field's text: what parseRate reads, as long as the server takes it. */
export function parseGlobalRate(text: string): number | null {
  const value = parseRate(text);
  return value !== null && value <= MAX_RATE ? value : null;
}
