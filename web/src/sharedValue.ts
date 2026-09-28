import type { Torrent } from './types';

/**
 * The value every one of `hashes` shares for a field, or undefined when they
 * differ, when one is not in the list, or when there are none. A shared empty
 * value is still a value: no label, the global throttle group.
 */
export function sharedValue<T>(
  byHash: ReadonlyMap<string, Torrent>,
  hashes: readonly string[],
  pick: (torrent: Torrent) => T,
): T | undefined {
  let value: T | undefined;
  for (const [index, hash] of hashes.entries()) {
    const torrent = byHash.get(hash);
    if (!torrent) return undefined;
    const next = pick(torrent);
    if (index > 0 && next !== value) return undefined;
    value = next;
  }
  return value;
}
