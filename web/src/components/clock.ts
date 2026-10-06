// SPDX-License-Identifier: MIT

import { useSyncExternalStore } from 'react';

/**
 * One timer for every relative time on screen ("2m 54s ago"). The table's rows
 * are memoized so that the state stream, at up to ten updates a second,
 * redraws only the torrents that changed; a time that moves with the clock
 * subscribes here instead, so it keeps moving without dragging its row along.
 */
const listeners = new Set<() => void>();
let now = Date.now();
let timer: number | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.clearInterval(timer);
  };
}

/** The current time, in milliseconds, updated once a second while anything reads it. */
export function useClock(): number {
  return useSyncExternalStore(subscribe, () => now);
}
