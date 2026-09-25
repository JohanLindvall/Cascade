import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';

/**
 * A ref that always holds the latest value, for callbacks read from inside a
 * long-lived effect (a timer, a window listener) that must not restart every
 * time the parent re-renders — and the app re-renders on every poll. The ref
 * is written in a layout effect rather than during render, which React
 * forbids: a render may be thrown away, and its writes with it.
 */
export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Run `task` now and then every `intervalMs` after it settles.
 *
 * Chained timeouts rather than setInterval, so a slow server never has two
 * requests for the same thing in flight; skipped while the tab is hidden and
 * run at once when it comes back. `isCurrent` tells the task whether its
 * answer is still wanted: when the inputs change (another torrent, another
 * tab) or the component unmounts, a response still in flight is for the old
 * question and must not land on the new one.
 *
 * `task` must be stable — wrap it in useCallback — or every render restarts
 * the loop.
 */
export function usePolling(
  task: (isCurrent: () => boolean) => Promise<unknown> | void,
  intervalMs: number,
): void {
  useEffect(() => {
    let alive = true;
    let running = false;
    let timer: number | undefined;
    const isCurrent = () => alive;

    const tick = async () => {
      window.clearTimeout(timer);
      if (running) return; // The tick in flight schedules the next one.
      running = true;
      try {
        if (!document.hidden) await task(isCurrent);
      } catch {
        // The task reports its own failures; the loop must outlive them.
      } finally {
        running = false;
      }
      if (alive) timer = window.setTimeout(() => void tick(), intervalMs);
    };

    const onVisible = () => {
      if (!document.hidden && alive) void tick();
    };

    void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [task, intervalMs]);
}
