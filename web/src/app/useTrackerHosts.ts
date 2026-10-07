// SPDX-License-Identifier: MIT

import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { Torrent } from '../types';

/** Group by primary tracker, including trackers discovered after a magnet loads. */
export function useTrackerHosts(torrents: Torrent[]): Record<string, string> {
  const [hosts, setHosts] = useState<Record<string, string>>({});
  const fetched = useRef('');
  const key = useMemo(
    () => torrents.map((torrent) => `${torrent.hash}:${torrent.trackerCount}`).join(','),
    [torrents],
  );
  const load = useCallback(async (isCurrent: () => boolean) => {
    if (key === fetched.current) return;
    const hashes = key ? key.split(',').map((entry) => entry.split(':')[0]) : [];
    const next = hashes.length ? await api.trackerHosts(hashes) : {};
    if (!isCurrent()) return;
    fetched.current = key;
    setHosts(next);
  }, [key]);
  // Retry transient failures; a successful read costs no more requests until
  // the torrent set or its tracker counts change.
  usePolling(load, 5000);
  return hosts;
}
