// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { SearchResult } from '../contracts';
import { hasSearchWords, pollSearch } from '../search';

const EMPTY_HASHES: ReadonlySet<string> = new Set();

/** The browser keeps only matching IDs; file and tracker text stays on the server. */
export function useSearch(query: string) {
  const [answer, setAnswer] = useState<{ query: string; result: SearchResult }>();
  useEffect(() => {
    let stop: (() => void) | undefined;
    const visible = () => {
      stop?.();
      stop = undefined;
      if (document.hidden) return;
      stop = pollSearch(query, {
        read: api.search,
        changed: (result) => setAnswer({ query, result }),
        setTimer: (run, ms) => window.setTimeout(run, ms),
        clearTimer: (timer) => window.clearTimeout(timer as number | undefined),
      });
    };
    visible();
    document.addEventListener('visibilitychange', visible);
    return () => {
      stop?.();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [query]);

  const result = answer?.query === query ? answer.result : undefined;
  const hashes = useMemo(() => result ? new Set(result.hashes) : EMPTY_HASHES, [result]);
  if (!hasSearchWords(query)) return { hashes: null, pending: 0, failed: 0 };
  // Never apply a previous query's matches while waiting for the new one:
  // bulk actions are restricted to the rows this query has actually shown.
  return { hashes, pending: result?.pending ?? 1, failed: result?.failed ?? 0, error: result?.error };
}
