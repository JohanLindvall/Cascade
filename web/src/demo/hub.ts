// SPDX-License-Identifier: MIT

/**
 * The state stream as server/internal/stream/hub.go serves it: the state read
 * once per interval while anyone is watching and not at all while nobody is,
 * a snapshot for a new subscriber (or the deltas it missed, when they are
 * still kept), then a delta with the next revision whenever something changed.
 * Ids are "<epoch>-<rev>", the epoch one per page load as it is one per server
 * run. A read is woken early after a request that may have changed something.
 */
import type { JsonObject, StreamEvent } from '../stream.ts';
import { diff, normalize } from './diff.ts';

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface Subscription {
  close(): void;
}

/** Deltas kept for a subscriber that reconnects with ?since=, as hub.go keeps them. */
const KEPT_DELTAS = 200;
const MIN_INTERVAL = 100;
const MAX_INTERVAL = 60_000;

export class Hub {
  readonly epoch: string;
  private readonly read: () => JsonObject;
  private readonly timers: Timers;
  private interval: number;
  private readonly subscribers = new Set<(event: StreamEvent) => void>();
  private state: JsonObject | null = null;
  private rev = 0;
  private recent: Array<{ rev: number; event: StreamEvent }> = [];
  private timer: unknown = undefined;
  /** What the last read failed with, until a read works again. */
  private failure = '';
  /** Subscribers that came while there was no state yet: their snapshot follows the first good read. */
  private readonly waiting = new Set<(event: StreamEvent) => void>();

  constructor(read: () => JsonObject, timers: Timers, epoch: string, interval: number) {
    this.read = read;
    this.timers = timers;
    this.epoch = epoch;
    this.interval = interval;
  }

  /** Watch the state: what the subscriber missed since `since`, else a snapshot, then every delta. */
  subscribe(since: string, send: (event: StreamEvent) => void): Subscription {
    // A read first, so the snapshot is current; the subscribers already
    // watching get the change as a delta, the new one does not.
    this.poll();
    this.subscribers.add(send);
    const replay = this.replayAfter(since);
    if (replay) for (const event of replay) send(event);
    else if (this.state) send(this.snapshot());
    else this.waiting.add(send);
    if (this.failure) send(this.failureEvent());
    this.schedule();
    return {
      close: () => {
        this.subscribers.delete(send);
        this.waiting.delete(send);
        if (this.subscribers.size === 0) {
          this.timers.clear(this.timer);
          this.timer = undefined;
        }
      },
    };
  }

  /** Read now rather than at the next tick, as after a request that changed something; idle while nobody watches. */
  wake(): void {
    if (this.subscribers.size === 0) return;
    this.timers.clear(this.timer);
    this.timer = this.timers.set(() => this.tick(), 0);
  }

  private tick(): void {
    this.timer = undefined;
    if (this.subscribers.size === 0) return;
    this.poll();
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined || this.subscribers.size === 0) return;
    this.timer = this.timers.set(() => this.tick(), this.interval);
  }

  private id(rev: number): string {
    return `${this.epoch}-${rev}`;
  }

  private snapshot(): StreamEvent {
    return { type: 'snapshot', id: this.id(this.rev), data: JSON.stringify(this.state) };
  }

  private failureEvent(): StreamEvent {
    return { type: 'failure', id: '', data: JSON.stringify({ error: this.failure }) };
  }

  private broadcast(event: StreamEvent): void {
    for (const send of this.subscribers) send(event);
  }

  private poll(): void {
    let next: JsonObject;
    try {
      next = normalize(this.read());
    } catch (error) {
      // As hub.go does when the state cannot be read: say so once, keep the
      // last state, and say ok when a read works again.
      const message = error instanceof Error && error.message ? error.message : 'the server cannot read the state';
      if (message !== this.failure) {
        this.failure = message;
        this.broadcast(this.failureEvent());
      }
      return;
    }
    if (this.failure) {
      this.failure = '';
      this.broadcast({ type: 'ok', id: '', data: '{}' });
    }
    // The state names its own interval: the preference, else the default.
    const status = next.status;
    const ms = status !== null && typeof status === 'object' && !Array.isArray(status) ? status.statePollMs : undefined;
    if (typeof ms === 'number' && ms > 0) this.interval = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, ms));
    if (this.state === null) {
      this.state = next;
      this.rev += 1;
      for (const send of this.waiting) send(this.snapshot());
      this.waiting.clear();
      return;
    }
    const patch = diff(this.state, next);
    if (patch === undefined) return;
    this.rev += 1;
    this.state = next;
    const event: StreamEvent = { type: 'delta', id: this.id(this.rev), data: JSON.stringify(patch) };
    this.recent.push({ rev: this.rev, event });
    if (this.recent.length > KEPT_DELTAS) this.recent = this.recent.slice(this.recent.length - KEPT_DELTAS);
    this.broadcast(event);
  }

  /** The deltas after the event `since` names, or null when they cannot bring a subscriber up to date. */
  private replayAfter(since: string): StreamEvent[] | null {
    const cut = since.lastIndexOf('-');
    if (cut <= 0 || since.slice(0, cut) !== this.epoch || this.state === null) return null;
    const rev = Number(since.slice(cut + 1));
    if (!Number.isSafeInteger(rev) || rev < 0 || rev > this.rev) return null;
    if (rev === this.rev) return [];
    if (this.recent.length === 0 || this.recent[0].rev > rev + 1) return null;
    return this.recent.filter((entry) => entry.rev > rev).map((entry) => entry.event);
  }
}
