// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, request } from './api';
import { denormalizer } from './stream';
import { INITIAL_VIEW, STREAM_EVENTS, StreamConnection } from './streamConnection';
import type { StateResponse } from './types';

export interface StateStream {
  /** The latest state; null until the first snapshot. */
  state: StateResponse | null;
  /** Why the state on screen may be stale: the connection's trouble, else the server's. */
  error: string | null;
  /** Reconnect now rather than at the next scheduled attempt. */
  retry: () => void;
}

/**
 * The server's state as it changes, over GET api/stream (server-sent events):
 * a snapshot, then a delta whenever something changed. The server reads
 * rtorrent once for every open page, and again straight after any change made
 * through the API, so an action's effect arrives without the page asking.
 * When the connection opens, closes and retries is StreamConnection's
 * business; this wires it to the browser and to React.
 */
export function useStateStream(): StateStream {
  const [view, setView] = useState(INITIAL_VIEW);
  const connection = useRef<StreamConnection | null>(null);
  const toState = useMemo(denormalizer, []);

  useEffect(() => {
    const stream = new StreamConnection({
      connect: (since, on) => {
        const source = new EventSource(`${API_BASE}stream${since ? `?since=${encodeURIComponent(since)}` : ''}`);
        source.onopen = () => on.open();
        source.onerror = () => on.error();
        for (const name of STREAM_EVENTS) {
          source.addEventListener(name, (event: MessageEvent<string>) =>
            on.event({ type: event.type, data: event.data, id: event.lastEventId }));
        }
        return source;
      },
      // Any answer from the API proves the server is up and only the stream
      // failed; its failure names the cause.
      diagnose: () => request('prefs', { timeoutMs: 10_000 }).then(() => null),
      hidden: () => document.hidden,
      now: () => Date.now(),
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number | undefined),
      onChange: setView,
    });
    const onVisibility = () => stream.visibilityChanged();
    connection.current = stream;
    document.addEventListener('visibilitychange', onVisibility);
    stream.start();
    return () => {
      stream.stop();
      document.removeEventListener('visibilitychange', onVisibility);
      if (connection.current === stream) connection.current = null;
    };
  }, []);

  const retry = useCallback(() => connection.current?.retry(), []);
  const { model, linkError } = view;
  const state = useMemo(() => (model.state ? toState(model.state) : null), [model.state, toState]);
  return { state, error: linkError ?? model.failure, retry };
}
