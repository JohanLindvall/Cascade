import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, request } from './api';
import { EMPTY_MODEL, denormalizer, reduce, type StreamModel } from './stream';
import type { StateResponse } from './types';

/** The events the server sends; see stream.ts for what each carries. */
const EVENTS = ['snapshot', 'delta', 'failure', 'ok'] as const;

/** A connection that stayed open this long was working, and its end is not yet a failure. */
const STEADY_MS = 5_000;
/** How soon a working stream that ended is reopened, before anything is said. */
const QUIET_RETRY_MS = 500;
/** The server re-sends a failure that still holds as soon as a connection opens. */
const REASSERT_MS = 1_000;

/** The wait before another attempt: the server's own retry of 3s, doubling to 30s. */
function backoff(failures: number): number {
  return Math.min(30_000, 3_000 * 2 ** Math.max(0, failures - 1));
}

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
 * rtorrent once for every open page, and reads it again straight after any
 * change made through the API, so an action's effect arrives without the
 * page asking.
 *
 * The stream is closed while the tab is hidden — nothing is drawn, and a page
 * nobody looks at should not keep rtorrent busy — and reopened from the last
 * event applied when it is shown again; the server replays what was missed,
 * or sends a snapshot when it no longer has all of it.
 */
export function useStateStream(): StateStream {
  const [model, setModel] = useState<StreamModel>(EMPTY_MODEL);
  const [linkError, setLinkError] = useState<string | null>(null);
  // The model the next event applies to. Events arrive outside render, one at
  // a time, so the ref — not a state updater, which React may run twice — is
  // where they are folded in.
  const modelRef = useRef(model);
  const reopen = useRef<() => void>(() => {});
  const toState = useMemo(denormalizer, []);

  useEffect(() => {
    let source: EventSource | undefined;
    let timer: number | undefined;
    let retract: number | undefined;
    let openedAt: number | undefined;
    let failures = 0;
    let probing = false;
    let stopped = false;

    const commit = (next: StreamModel) => {
      modelRef.current = next;
      setModel(next);
    };

    const close = () => {
      window.clearTimeout(timer);
      window.clearTimeout(retract);
      source?.close();
      source = undefined;
      openedAt = undefined;
    };

    /**
     * EventSource cannot say why a connection failed, so ask the API the
     * same way everything else does: its answer names the cause (the server
     * is down, the password changed); a success means only the stream failed.
     */
    const explain = async () => {
      if (probing) return;
      probing = true;
      let message = 'cannot open the live update stream';
      try {
        await request('prefs', { timeoutMs: 10_000 });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      } finally {
        probing = false;
      }
      if (!stopped && openedAt === undefined && !document.hidden) setLinkError(message);
    };

    const open = (fresh = false) => {
      close();
      if (stopped || document.hidden) return;
      const since = fresh ? '' : modelRef.current.lastId;
      const events = new EventSource(`${API_BASE}stream${since ? `?since=${encodeURIComponent(since)}` : ''}`);
      source = events;
      let reasserted = false;

      events.onopen = () => {
        if (source !== events) return;
        openedAt = Date.now();
        setLinkError(null);
        // A failure that ended while this page was away is never retracted by
        // an ok (that went to the pages that were connected), so it is dropped
        // here unless the server says it again.
        retract = window.setTimeout(() => {
          if (source === events && !reasserted && modelRef.current.failure !== null) {
            commit({ ...modelRef.current, failure: null });
          }
        }, REASSERT_MS);
      };

      const onEvent = (event: MessageEvent<string>) => {
        if (source !== events) return;
        if (event.type === 'failure') reasserted = true;
        const next = reduce(modelRef.current, { type: event.type, data: event.data, id: event.lastEventId });
        if (next === 'resync') open(true);
        else if (next !== modelRef.current) commit(next);
      };
      for (const name of EVENTS) events.addEventListener(name, onEvent);

      events.onerror = () => {
        if (source !== events) return;
        // EventSource would reconnect by itself, but to the URL it was opened
        // with: a stale ?since= would replay deltas this page has already
        // applied. Every reconnect is made here instead, from the last event
        // applied.
        const steady = openedAt !== undefined && Date.now() - openedAt >= STEADY_MS;
        close();
        if (steady) {
          // A stream that was working ended — the server restarting, a
          // proxy's idle limit. Reopen at once, and speak up only if that
          // fails. A connection that opens and drops straight away is not
          // working, so it keeps counting towards the longer waits.
          failures = 0;
          timer = window.setTimeout(() => open(), QUIET_RETRY_MS);
          return;
        }
        failures += 1;
        setLinkError((current) => current ?? 'cannot reach the Cascade server');
        void explain();
        timer = window.setTimeout(() => open(), backoff(failures));
      };
    };

    const onVisibility = () => {
      if (document.hidden) close();
      else if (!source) open();
    };

    reopen.current = () => open();
    document.addEventListener('visibilitychange', onVisibility);
    open();
    return () => {
      stopped = true;
      close();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const retry = useCallback(() => reopen.current(), []);
  const state = useMemo(() => (model.state ? toState(model.state) : null), [model.state, toState]);
  return { state, error: linkError ?? model.failure, retry };
}
