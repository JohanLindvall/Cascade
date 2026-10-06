/**
 * The simulated stream against the client's own reducer: a snapshot, then
 * deltas with consecutive revisions, which folded through reduce() and the
 * denormalizer give exactly the state the server would answer GET api/state
 * with — at the interval the preference asks for, at once after a change, not
 * at all for a request refused as sent, and resumable from the last id.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StateResponse } from '../contracts.ts';
import { EMPTY_MODEL, denormalizer, reduce, type StreamEvent, type StreamModel } from '../stream.ts';
import { DemoServer, type DemoRequest } from './backend.ts';
import { ManualClock } from './fixtures.ts';
import { Hub } from './hub.ts';

const START = Date.UTC(2026, 9, 6, 19, 0, 0) + 211;

function demo(clock: ManualClock): DemoServer {
  return new DemoServer({ now: () => clock.now, timers: clock, seed: 3, version: '0.16.24' });
}

function request(method: string, path: string, body?: unknown): DemoRequest {
  return {
    method,
    path,
    query: new URLSearchParams(),
    contentType: body === undefined ? '' : 'application/json',
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/** A page's view of the stream: the events folded as useStateStream folds them. */
class Page {
  model: StreamModel = EMPTY_MODEL;
  events: StreamEvent[] = [];
  private readonly toState = denormalizer();

  receive = (event: StreamEvent): void => {
    this.events.push(event);
    const next = reduce(this.model, event);
    assert.notEqual(next, 'resync', `the page lost track at ${event.type} ${event.id}`);
    this.model = next as StreamModel;
  };

  get state(): StateResponse {
    assert.ok(this.model.state, 'no snapshot yet');
    return this.toState(this.model.state);
  }
}

/** Two states as JSON, the torrents in hash order: the stream keys them, so their order is not its to keep. */
function canonical(state: StateResponse): unknown {
  return JSON.parse(JSON.stringify({ ...state, torrents: [...state.torrents].sort((a, b) => a.hash.localeCompare(b.hash)) }));
}

test('a snapshot, then consecutive deltas that fold into the state the server answers with', () => {
  const clock = new ManualClock(START);
  const server = demo(clock);
  const page = new Page();
  server.stream('', page.receive);
  assert.equal(page.events[0].type, 'snapshot');
  const epoch = page.events[0].id.slice(0, page.events[0].id.lastIndexOf('-'));
  for (let i = 0; i < 90; i++) clock.advance(1000);
  const deltas = page.events.slice(1);
  assert.ok(deltas.length >= 85, `${deltas.length} deltas in 90 seconds`);
  const first = Number(page.events[0].id.slice(epoch.length + 1));
  deltas.forEach((event, i) => {
    assert.equal(event.type, 'delta');
    assert.equal(event.id, `${epoch}-${first + i + 1}`);
  });
  assert.deepEqual(canonical(page.state), canonical(server.state()));
  // A delta carries what changed, not the state again.
  assert.ok(deltas.every((event) => event.data.length < page.events[0].data.length / 2));
});

test('the reading pace follows the preference, and a change shows at once', () => {
  const clock = new ManualClock(START);
  const server = demo(clock);
  const page = new Page();
  server.stream('', page.receive);
  clock.advance(1000);
  const atDefault = page.events.length;
  assert.equal(server.handle(request('PATCH', 'prefs', { statePollMs: 250 })).status, 200);
  clock.advance(0); // the wake after the PATCH
  const afterWake = page.events.length;
  clock.advance(1000);
  assert.ok(page.events.length - afterWake >= 3, 'the faster pace was not taken up');
  assert.ok(afterWake > atDefault);
  assert.equal(page.state.status.statePollMs, 250);

  const target = page.state.torrents.find((t) => t.status === 'seeding');
  assert.ok(target);
  const before = page.events.length;
  const answer = server.handle(request('POST', 'torrents/action/stop', { hashes: [target.hash] }));
  assert.deepEqual(answer.body, { ok: true, errors: [] });
  clock.advance(0);
  assert.equal(page.events.length, before + 1, 'the change did not wake the stream');
  assert.equal(page.state.torrents.find((t) => t.hash === target.hash)?.status, 'stopped');
});

test('a request refused as sent wakes nothing', () => {
  const clock = new ManualClock(START);
  const server = demo(clock);
  const page = new Page();
  server.stream('', page.receive);
  const pending = clock.pending;
  for (const [method, path, body] of [
    ['POST', 'torrents/action/stop', { hashes: [] }],
    ['PATCH', 'torrents/nothex', { priority: 1 }],
    ['DELETE', 'throttles/nope', undefined],
  ] as const) {
    const status = server.handle(request(method, path, body)).status;
    assert.ok(status === 400 || status === 404, `${method} ${path}: ${status}`);
  }
  const before = page.events.length;
  clock.advance(0);
  assert.equal(clock.pending, pending);
  assert.equal(page.events.length, before);
});

test('a page that comes back with its last id gets what it missed, or a snapshot when that is not possible', () => {
  const clock = new ManualClock(START);
  const server = demo(clock);
  const page = new Page();
  const first = server.stream('', page.receive);
  clock.advance(5000);
  first.close();
  assert.equal(clock.pending, 0, 'reading went on with nobody watching');
  clock.advance(5000);
  const missed = page.events.length;
  server.stream(page.model.lastId, page.receive);
  const replayed = page.events.slice(missed);
  assert.ok(replayed.length >= 1 && replayed.every((event) => event.type === 'delta'));
  assert.deepEqual(canonical(page.state), canonical(server.state()));

  const stranger = new Page();
  server.stream('0-1', stranger.receive);
  assert.equal(stranger.events[0].type, 'snapshot');
});

test('a state that cannot be read is a failure event, retracted by ok once it can', () => {
  const clock = new ManualClock(START);
  let broken = false;
  const hub = new Hub(() => {
    if (broken) throw new Error('rtorrent is not responding');
    return { status: { statePollMs: 1000, downRate: clock.now }, torrents: [] };
  }, clock, 'e', 1000);
  const page = new Page();
  hub.subscribe('', page.receive);
  broken = true;
  clock.advance(3000);
  assert.equal(page.model.failure, 'rtorrent is not responding');
  assert.equal(page.events.filter((event) => event.type === 'failure').length, 1, 'the same failure said twice');
  const late = new Page();
  hub.subscribe('', late.receive);
  assert.deepEqual(late.events.map((event) => event.type), ['snapshot', 'failure'], 'a page joining during the outage is told');
  broken = false;
  clock.advance(1000);
  assert.equal(page.model.failure, null);
  assert.deepEqual(page.events.slice(-2).map((event) => event.type), ['ok', 'delta']);
});

test('a page that came before the first good read gets its snapshot after it', () => {
  const clock = new ManualClock(START);
  let broken = true;
  const hub = new Hub(() => {
    if (broken) throw new Error('rtorrent is not responding');
    return { status: { statePollMs: 1000 }, torrents: [] };
  }, clock, 'e', 1000);
  const page = new Page();
  hub.subscribe('', page.receive);
  assert.deepEqual(page.events.map((event) => event.type), ['failure']);
  broken = false;
  clock.advance(1000);
  assert.deepEqual(page.events.map((event) => event.type), ['failure', 'ok', 'snapshot']);
  assert.equal(page.model.failure, null);
  assert.deepEqual(page.state.torrents, []);
});

test('a plain fetch of the stream gets its first event as text/event-stream', () => {
  const clock = new ManualClock(START);
  const answer = demo(clock).handle(request('GET', 'stream'));
  assert.equal(answer.status, 200);
  assert.equal(answer.contentType, 'text/event-stream');
  assert.match(answer.text ?? '', /^id: [0-9a-z]+-\d+\nevent: snapshot\ndata: \{/);
});
