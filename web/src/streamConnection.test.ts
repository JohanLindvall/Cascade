/**
 * When the stream opens, gives up and tries again is where a live page goes
 * quietly stale, so it is pinned here with a fake link and a fake clock: a
 * working stream that ends reopens at once and says nothing, one that never
 * worked backs off and says why, a hidden page reads nothing, and a stopped
 * connection leaves nothing behind.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamEvent } from './stream.ts';
import {
  QUIET_RETRY_MS, REASSERT_MS, STEADY_MS, StreamConnection, backoff,
  type LinkHandlers, type StreamView,
} from './streamConnection.ts';

interface FakeLink {
  since: string;
  on: LinkHandlers;
  closed: boolean;
}

/** A clock whose timers run only when the test advances it. */
class Clock {
  now = 0;
  private next = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  set = (run: () => void, ms: number): number => {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, run });
    return id;
  };

  clear = (id: unknown): void => {
    this.timers.delete(id as number);
  };

  get pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      let due: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= until && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].run();
    }
    this.now = until;
  }
}

function setup(options: { diagnose?: () => Promise<string | null> } = {}) {
  const clock = new Clock();
  const links: FakeLink[] = [];
  const views: StreamView[] = [];
  const page = { hidden: false };
  const connection = new StreamConnection({
    connect: (since, on) => {
      const link: FakeLink = { since, on, closed: false };
      links.push(link);
      return { close: () => { link.closed = true; } };
    },
    diagnose: options.diagnose ?? (() => Promise.resolve(null)),
    hidden: () => page.hidden,
    now: () => clock.now,
    setTimer: clock.set,
    clearTimer: clock.clear,
    onChange: (view) => views.push(view),
  });
  const last = () => links[links.length - 1];
  const open = () => links.filter((link) => !link.closed);
  const send = (type: string, data: unknown, id = '') =>
    last().on.event({ type, data: JSON.stringify(data), id } satisfies StreamEvent);
  return { clock, links, views, page, connection, last, open, send };
}

/** Let the promises a diagnosis runs on settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a fresh page asks for a snapshot, and a page back from hiding resumes where it was', () => {
  const t = setup();
  t.connection.start();
  assert.equal(t.last().since, '');
  t.last().on.open();
  t.send('snapshot', { torrents: {} }, 'e1-4');
  t.send('delta', { status: { upRate: 1 } }, 'e1-5');
  assert.equal(t.connection.current.model.lastId, 'e1-5');

  t.page.hidden = true;
  t.connection.visibilityChanged();
  assert.equal(t.open().length, 0, 'a hidden page keeps no stream open');

  t.page.hidden = false;
  t.connection.visibilityChanged();
  assert.equal(t.open().length, 1);
  assert.equal(t.last().since, 'e1-5');
});

test('a working stream that ends is reopened at once, and nothing is said', () => {
  const t = setup();
  t.connection.start();
  t.last().on.open();
  t.clock.advance(STEADY_MS);
  t.last().on.error();
  assert.equal(t.connection.current.linkError, null);
  assert.equal(t.open().length, 0);
  t.clock.advance(QUIET_RETRY_MS);
  assert.equal(t.open().length, 1);
  assert.equal(t.links.length, 2);
});

test('a working stream starts the waits over: a quiet retry that fails speaks up after the first, short one', () => {
  const t = setup();
  t.connection.start();
  t.last().on.error();
  t.clock.advance(backoff(1));
  t.last().on.error();
  t.clock.advance(backoff(2));
  assert.equal(t.links.length, 3, 'two failures behind it');
  t.last().on.open();
  t.clock.advance(STEADY_MS);
  t.last().on.error();
  t.clock.advance(QUIET_RETRY_MS);
  assert.equal(t.links.length, 4, 'the quiet retry');
  t.last().on.error();
  assert.equal(t.connection.current.linkError, 'cannot reach the Cascade server');
  // A routine server restart must not wait out the earlier failures' 12s.
  t.clock.advance(backoff(1) - 1);
  assert.equal(t.links.length, 4);
  t.clock.advance(1);
  assert.equal(t.links.length, 5, 'the first, short wait');
});

test('a late answer about an earlier outage says nothing about a later one', async () => {
  const answers: ((reason: string | null) => void)[] = [];
  const t = setup({ diagnose: () => new Promise((resolve) => { answers.push(resolve); }) });
  t.connection.start();
  t.last().on.error();
  t.clock.advance(backoff(1));
  t.last().on.open();
  t.clock.advance(STEADY_MS);
  t.last().on.error();
  assert.equal(answers.length, 1, 'still out, for the first outage');
  answers[0]('no response after 10s — server busy?');
  await settle();
  assert.equal(t.connection.current.linkError, null, 'the quiet retry says nothing');

  t.clock.advance(QUIET_RETRY_MS);
  t.last().on.error();
  assert.equal(t.connection.current.linkError, 'cannot reach the Cascade server', 'not the stale answer');
  assert.equal(answers.length, 2, 'the new outage is asked about in its own right');
  answers[1]('authentication required');
  await settle();
  assert.equal(t.connection.current.linkError, 'authentication required');
});

test('a question still out about an earlier outage does not hold back the next one', async () => {
  const answers: ((reason: string | null) => void)[] = [];
  const t = setup({ diagnose: () => new Promise((resolve) => { answers.push(resolve); }) });
  t.connection.start();
  t.last().on.error();
  t.clock.advance(backoff(1));
  t.last().on.open();
  t.clock.advance(STEADY_MS);
  t.last().on.error();
  t.clock.advance(QUIET_RETRY_MS);
  t.last().on.error();
  assert.equal(answers.length, 2, 'asked again, though the first answer has not come');
  answers[1]('authentication required');
  await settle();
  answers[0]('no response after 10s — server busy?');
  await settle();
  assert.equal(t.connection.current.linkError, 'authentication required', 'the late answer is dropped');
});

test('a stream that never worked backs off, says why, and clears once it opens', async () => {
  const t = setup({ diagnose: () => Promise.resolve('authentication required') });
  t.connection.start();
  t.last().on.error();
  assert.equal(t.connection.current.linkError, 'cannot reach the Cascade server');
  await settle();
  assert.equal(t.connection.current.linkError, 'authentication required', 'the API names the cause');

  t.clock.advance(backoff(1) - 1);
  assert.equal(t.links.length, 1, 'not before the wait is up');
  t.clock.advance(1);
  assert.equal(t.links.length, 2);
  t.last().on.error();
  t.clock.advance(backoff(2) - 1);
  assert.equal(t.links.length, 2, 'the second wait is longer');
  t.clock.advance(1);
  t.last().on.open();
  assert.equal(t.connection.current.linkError, null);
  assert.deepEqual([backoff(1), backoff(2), backoff(9)], [3_000, 6_000, 30_000]);
});

test('an API that answers means only the stream is broken, and says so', async () => {
  const t = setup();
  t.connection.start();
  t.last().on.error();
  await settle();
  assert.equal(t.connection.current.linkError, 'cannot open the live update stream');
});

test('a delta that cannot be trusted asks for a fresh snapshot', () => {
  const t = setup();
  t.connection.start();
  t.last().on.open();
  t.send('snapshot', { n: 1 }, 'e1-4');
  t.send('delta', { n: 2 }, 'e1-6');
  assert.equal(t.links.length, 2);
  assert.equal(t.links[0].closed, true);
  assert.equal(t.last().since, '', 'a resync starts from a snapshot, not from the gap');
  t.links[0].on.event({ type: 'delta', data: '{"n":3}', id: 'e1-7' });
  assert.deepEqual(t.connection.current.model.state, { n: 1 }, 'the closed link is not listened to');
});

test('a failure that ended while the page was away is dropped unless the server repeats it', () => {
  const t = setup();
  t.connection.start();
  t.last().on.open();
  t.send('snapshot', { n: 1 }, 'e1-1');
  t.send('failure', { error: 'rtorrent is not responding' });
  t.page.hidden = true;
  t.connection.visibilityChanged();
  t.page.hidden = false;
  t.connection.visibilityChanged();

  t.last().on.open();
  t.send('failure', { error: 'rtorrent is not responding' });
  t.clock.advance(REASSERT_MS);
  assert.equal(t.connection.current.model.failure, 'rtorrent is not responding', 'repeated: still true');

  t.connection.retry();
  t.last().on.open();
  t.clock.advance(REASSERT_MS);
  assert.equal(t.connection.current.model.failure, null, 'not repeated: it ended');
});

test('a retry reconnects at once, even in the middle of a wait', () => {
  const t = setup();
  t.connection.start();
  t.last().on.error();
  t.connection.retry();
  assert.equal(t.open().length, 1);
  t.clock.advance(backoff(1));
  assert.equal(t.links.length, 2, 'the cancelled wait does not open another');
});

test('a wait that ends while the page is hidden opens nothing until it is shown', () => {
  const t = setup();
  t.connection.start();
  t.last().on.error();
  t.page.hidden = true;
  t.clock.advance(backoff(1));
  assert.equal(t.links.length, 1);
  t.page.hidden = false;
  t.connection.visibilityChanged();
  assert.equal(t.links.length, 2);
});

test('a stopped connection leaves nothing open or pending, and ignores late answers', async () => {
  let answer: (reason: string | null) => void = () => {};
  const t = setup({ diagnose: () => new Promise((resolve) => { answer = resolve; }) });
  t.connection.start();
  t.last().on.error();
  const before = t.views.length;
  t.connection.stop();
  assert.equal(t.open().length, 0);
  assert.equal(t.clock.pending, 0);
  answer('too late');
  await settle();
  t.links[0].on.open();
  assert.equal(t.views.length, before, 'nothing changes after stop');
});

test('views are only reported when something changed', () => {
  const t = setup();
  t.connection.start();
  t.last().on.open();
  t.send('ok', {});
  t.send('heartbeat', '');
  assert.equal(t.views.length, 0);
  t.send('snapshot', { n: 1 }, 'e1-1');
  assert.equal(t.views.length, 1);
});
