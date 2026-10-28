// SPDX-License-Identifier: MIT

import { useCallback, useMemo, useState } from 'react';
import { api } from '../api';
import { searchWords } from '../filter';
import { useLatest, usePolling } from '../hooks';
import { SearchMetadata, searchMetadataKey } from '../searchMetadata';
import type { Torrent } from '../types';

/** Fetch details only for an active search in a visible page, retrying partial failures. */
export function useSearchMetadata(torrents: Torrent[], search: string) {
  const [cache] = useState(() => new SearchMetadata(api));
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((value) => value + 1), []);
  const latest = useLatest(torrents);
  const active = searchWords(search).length > 0;
  const key = useMemo(() => torrents.map(searchMetadataKey).sort().join('\n'), [torrents]);

  const load = useCallback(async (isCurrent: () => boolean) => {
    cache.sync(latest.current);
    if (!active) return;
    changed();
    await cache.load(() => isCurrent() && !document.hidden, changed);
    if (isCurrent() && !document.hidden) changed();
  }, [cache, latest, active, key, changed]);
  usePolling(load, 5000);

  const state = useMemo(() => cache.snapshot(torrents), [cache, torrents, revision]);
  return { ...state, pending: active ? state.pending : 0, failed: active ? state.failed : 0 };
}
