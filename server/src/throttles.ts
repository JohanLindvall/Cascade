import type { ThrottleGroup } from './contracts';
export type { ThrottleGroup } from './contracts';

import { HttpError } from './errors';
import type { MulticallEntry } from './rtorrent';
import { requireInt } from './validation';

export const THROTTLE_NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;

export function normalizeThrottle(group: ThrottleGroup): ThrottleGroup {
  if (!THROTTLE_NAME_RE.test(group.name) || group.name === 'NULL') {
    throw new HttpError(400, 'throttle name must be 1-32 chars of [A-Za-z0-9_.-] and cannot be NULL');
  }
  // Round up so a positive sub-KiB limit never becomes 0 (unlimited).
  const rate = (value: number, field: string) =>
    Math.ceil(requireInt(value, field, 0, Number.MAX_SAFE_INTEGER - 1023) / 1024) * 1024;
  return { name: group.name, up: rate(group.up, 'up'), down: rate(group.down, 'down') };
}

/** Unlike global .max_rate.set, throttle.up/down take whole KiB/s strings. */
export function throttleEntries(group: ThrottleGroup): MulticallEntry[] {
  const normalized = normalizeThrottle(group);
  return (['up', 'down'] as const).map((direction) => ({
    methodName: `throttle.${direction}`,
    params: ['', group.name, String(normalized[direction] / 1024)],
  }));
}
