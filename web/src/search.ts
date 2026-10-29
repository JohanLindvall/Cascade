// SPDX-License-Identifier: MIT

import type { SearchResult } from './contracts.ts';
import { redactSecrets } from './redact.ts';

export function hasSearchWords(query: string): boolean {
  return /[\p{L}\p{Nd}]/u.test(query);
}

interface SearchDeps {
  read(query: string, signal: AbortSignal): Promise<SearchResult>;
  changed(result: SearchResult): void;
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
  let last: SearchResult = { hashes: [], pending: 1, failed: 0 };
  const tick = async () => {
    let delay = 2000;
    try {
      const result = await deps.read(query, controller.signal);
      if (controller.signal.aborted) return;
      last = result;
      deps.changed(result);
      if (result.pending > 0) delay = 200;
    } catch (error) {
      if (controller.signal.aborted) return;
      deps.changed({
        ...last, pending: 0, failed: Math.max(1, last.failed),
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
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
