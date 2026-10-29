// SPDX-License-Identifier: MIT

import type { SearchResult } from './contracts.ts';
import { redactSecrets } from './redact.ts';

export function hasSearchWords(query: string): boolean {
  return /[\p{L}\p{Nd}]/u.test(query);
}

export interface SearchState {
  query: string;
  /** null is the unfiltered list, also kept until the first search answers. */
  hashes: string[] | null;
  pending: number;
  failed: number;
  error?: string;
}

export const INITIAL_SEARCH: SearchState = { query: '', hashes: null, pending: 0, failed: 0 };

type SearchAction =
  | { type: 'query'; query: string }
  | { type: 'result'; query: string; result: SearchResult }
  | { type: 'error'; query: string; error: string };

/** Keep the last returned matches while typing, waiting or retrying a failed read. */
export function reduceSearch(state: SearchState, action: SearchAction): SearchState {
  if (action.type === 'query') {
    const active = hasSearchWords(action.query);
    return { query: action.query, hashes: active ? state.hashes : null, pending: active ? 1 : 0, failed: 0 };
  }
  if (action.query !== state.query) return state;
  if (action.type === 'result') return { query: action.query, ...action.result };
  return { ...state, pending: 0, failed: Math.max(1, state.failed), error: action.error };
}

interface SearchDeps {
  read(query: string, signal: AbortSignal): Promise<SearchResult>;
  changed(result: SearchResult): void;
  failed(error: string): void;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

/**
 * One visible page's search. Debounce typing, poll partial results quickly,
 * and wait for each response before scheduling another. Stopping aborts the
 * request and ignores late answers, even if the transport ignores the abort.
 */
export function pollSearch(query: string, deps: SearchDeps): () => void {
  const controller = new AbortController();
  let timer: unknown;
  const tick = async () => {
    let delay = 2000;
    try {
      const result = await deps.read(query, controller.signal);
      if (controller.signal.aborted) return;
      deps.changed(result);
      if (result.pending > 0) delay = 200;
    } catch (error) {
      if (controller.signal.aborted) return;
      // A failure supplies no new matches. The caller keeps the last result,
      // including one returned before this query or polling loop started.
      deps.failed(redactSecrets(error instanceof Error ? error.message : String(error)));
      delay = 5000;
    }
    if (!controller.signal.aborted) timer = deps.setTimer(() => void tick(), delay);
  };
  if (hasSearchWords(query)) timer = deps.setTimer(() => void tick(), 200);
  return () => {
    controller.abort();
    deps.clearTimer(timer);
  };
}
