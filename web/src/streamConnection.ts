/**
 * The life of the state stream's connection: when it opens, when it gives up
 * and tries again, and what the page is told meanwhile. The React hook
 * (useStateStream.ts) only wires this to its state and to the document; the
 * decisions all live here, in plain code the node test runner drives with a
 * fake link and a fake clock.
 */
import { EMPTY_MODEL, reduce, type StreamEvent, type StreamModel } from './stream.ts';

/** The events the server sends; see stream.ts for what each carries. */
export const STREAM_EVENTS = ['snapshot', 'delta', 'failure', 'ok'] as const;

/** A connection that stayed open this long was working, and its end is not yet a failure. */
export const STEADY_MS = 5_000;
/** How soon a working stream that ended is reopened, before anything is said. */
export const QUIET_RETRY_MS = 500;
/** How long after opening the server has to repeat a failure that still holds. */
export const REASSERT_MS = 1_000;

/** The wait before another attempt: the server's own retry of 3s, doubling to 30s. */
export function backoff(failures: number): number {
  return Math.min(30_000, 3_000 * 2 ** Math.max(0, failures - 1));
}

/** What a link reports back: it opened, an event arrived, it failed. */
export interface LinkHandlers {
  open(): void;
  event(event: StreamEvent): void;
  error(): void;
}

/** What the page shows of the stream. */
export interface StreamView {
  model: StreamModel;
  /** Why the stream is not connected, when it is not; null while it is. */
  linkError: string | null;
}

export const INITIAL_VIEW: StreamView = { model: EMPTY_MODEL, linkError: null };

export interface StreamDeps {
  /** Open the stream from the event `since` names ('' for a fresh snapshot). */
  connect(since: string, on: LinkHandlers): { close(): void };
  /**
   * Why the stream cannot be opened: the API's own answer when it fails the
   * same way (the server is down, the password changed), null when the API
   * answers and only the stream is broken. EventSource cannot say why itself.
   */
  diagnose(): Promise<string | null>;
  /** Whether the page is hidden: nothing is drawn then, so nothing is read. */
  hidden(): boolean;
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Called with the new view whenever the model or the link error changes. */
  onChange(view: StreamView): void;
}

/**
 * One page's connection to the state stream.
 *
 * EventSource would reconnect by itself, but to the URL it was first opened
 * with: a stale ?since= would replay deltas the page has already applied.
 * So every reconnect is made here, from the last event applied — at once
 * after a working stream ends, with a growing wait after one that never
 * worked — and the stream is closed while the page is hidden.
 */
export class StreamConnection {
  private view: StreamView = INITIAL_VIEW;
  private link: { close(): void } | undefined;
  /** The attempt the current link belongs to; handlers of an older one are ignored. */
  private attempt = 0;
  private timer: unknown;
  private retract: unknown;
  private openedAt: number | undefined;
  private failures = 0;
  /**
   * Links that have opened so far. An outage is known by the count at its
   * start: a diagnosis answers for that outage only, however late it comes.
   */
  private opens = 0;
  /** The outage a diagnosis is out for, if one is. */
  private diagnosing: number | undefined;
  private stopped = true;
  private readonly deps: StreamDeps;

  // A plain field, not a parameter property: the node test runner strips
  // types and cannot run those.
  constructor(deps: StreamDeps) {
    this.deps = deps;
  }

  get current(): StreamView {
    return this.view;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.close();
  }

  /** Reconnect now rather than at the next scheduled attempt. */
  retry(): void {
    this.open();
  }

  visibilityChanged(): void {
    if (this.deps.hidden()) this.close();
    else if (!this.link) this.open();
  }

  private update(change: Partial<StreamView>): void {
    const next = { ...this.view, ...change };
    if (next.model === this.view.model && next.linkError === this.view.linkError) return;
    this.view = next;
    this.deps.onChange(next);
  }

  private close(): void {
    this.deps.clearTimer(this.timer);
    this.deps.clearTimer(this.retract);
    this.timer = this.retract = undefined;
    this.attempt += 1;
    this.link?.close();
    this.link = undefined;
    this.openedAt = undefined;
  }

  private open(fresh = false): void {
    this.close();
    if (this.stopped || this.deps.hidden()) return;
    const attempt = this.attempt;
    const current = () => attempt === this.attempt;
    let reasserted = false;
    this.link = this.deps.connect(fresh ? '' : this.view.model.lastId, {
      open: () => {
        if (!current()) return;
        this.opens += 1;
        this.openedAt = this.deps.now();
        this.update({ linkError: null });
        // A failure that ended while this page was away is never retracted
        // by an ok — that went to the pages that were connected — so it is
        // dropped here unless the server says it again.
        this.retract = this.deps.setTimer(() => {
          const { model } = this.view;
          if (current() && !reasserted && model.failure !== null) this.update({ model: { ...model, failure: null } });
        }, REASSERT_MS);
      },
      event: (event) => {
        if (!current()) return;
        if (event.type === 'failure') reasserted = true;
        const next = reduce(this.view.model, event);
        if (next === 'resync') this.open(true);
        else this.update({ model: next });
      },
      error: () => {
        if (!current()) return;
        const steady = this.openedAt !== undefined && this.deps.now() - this.openedAt >= STEADY_MS;
        this.close();
        if (steady) {
          // A stream that was working ended — the server restarting, a
          // proxy's idle limit. Reopen at once and speak up only if that
          // fails. One that opens and drops straight away is not working,
          // so it keeps counting towards the longer waits.
          this.failures = 0;
          this.timer = this.deps.setTimer(() => this.open(), QUIET_RETRY_MS);
          return;
        }
        this.failures += 1;
        this.update({ linkError: this.view.linkError ?? 'cannot reach the Cascade server' });
        void this.diagnose();
        this.timer = this.deps.setTimer(() => this.open(), backoff(this.failures));
      },
    });
  }

  private async diagnose(): Promise<void> {
    const outage = this.opens;
    // One question per outage. One still out for an earlier outage must not
    // hold this one's back: its answer will be dropped.
    if (this.diagnosing === outage) return;
    this.diagnosing = outage;
    let reason: string | null;
    try {
      reason = await this.deps.diagnose();
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.diagnosing === outage) this.diagnosing = undefined;
    }
    // Only while the same outage lasts. An open in the meantime said all was
    // well, and "no link now" is not enough: a later link may have worked and
    // ended, and the quiet retry that follows says nothing unless it fails.
    if (!this.stopped && this.opens === outage && !this.deps.hidden()) {
      this.update({ linkError: reason ?? 'cannot open the live update stream' });
    }
  }
}
