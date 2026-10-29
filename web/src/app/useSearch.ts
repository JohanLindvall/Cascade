// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useReducer } from 'react';
import { api } from '../api';
import { INITIAL_SEARCH, hasSearchWords, pollSearch, reduceSearch } from '../search';

/** The browser keeps only matching IDs; file and tracker text stays on the server. */
export function useSearch(query: string) {
  const [state, dispatch] = useReducer(reduceSearch, INITIAL_SEARCH);
  useEffect(() => {
    dispatch({ type: 'query', query });
    let stop: (() => void) | undefined;
    const visible = () => {
      stop?.();
      stop = undefined;
      if (document.hidden) return;
      stop = pollSearch(query, {
        read: api.search,
        changed: (result) => dispatch({ type: 'result', query, result }),
        failed: (error) => dispatch({ type: 'error', query, error }),
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

  const hashes = useMemo(() => state.hashes === null ? null : new Set(state.hashes), [state.hashes]);
  if (!hasSearchWords(query)) return { hashes: null, pending: 0, failed: 0 };
  return { hashes, pending: state.pending, failed: state.failed, error: state.error };
}
