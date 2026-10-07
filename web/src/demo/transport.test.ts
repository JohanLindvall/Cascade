// SPDX-License-Identifier: MIT

/**
 * The page's side of the demo: the real api.ts over the fetch stand-in, and
 * the real StreamConnection over the EventSource stand-in — what the app runs,
 * minus React. Real timers here, with a latency of a millisecond or two.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StateResponse, UploadResult } from '../contracts.ts';
import { denormalizer } from '../stream.ts';
import { STREAM_EVENTS, StreamConnection, type StreamView } from '../streamConnection.ts';
import { DemoServer } from './backend.ts';
import { torrentFile } from './fixtures.ts';
import { demoEventSource, demoFetch, type Transport } from './transport.ts';

const BASE = 'https://demo.example.org/Cascade/';
const API = `${BASE}api/`;

// api.ts resolves its base against the document when it loads.
Object.assign(globalThis, { document: { baseURI: BASE } });
const passed: string[] = [];
const kept: Array<{ theme: string }> = [];
const server = new DemoServer({
  now: () => Date.now(),
  timers: { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
  seed: 9,
  version: '0.16.25',
  onPreferences: (preferences) => kept.push(preferences),
});
let latency = 2;
const transport: Transport = { server, apiBase: API, baseUri: BASE, latency: () => latency };
globalThis.fetch = demoFetch(transport, async (input) => {
  passed.push(String(input));
  return new Response('elsewhere', { status: 200 });
});
const { api, request, ApiError } = await import('../api.ts');

test('the API is answered with real responses that api.ts reads as it reads the server\'s', async () => {
  const state = await request<StateResponse>('state');
  assert.equal(state.status.backend.clientVersion, '0.16.25');
  const hash = state.torrents[0].hash;
  assert.ok((await api.files(hash)).length > 0);
  assert.equal((await api.trackers(hash)).length, state.torrents[0].trackerCount);
  assert.ok(Array.isArray(await api.peers(hash)));
  assert.ok((await api.rpcMethods()).methods.includes('system.listMethods'));

  const raw = await fetch(`${API}torrents/${hash}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"priority": 9}' });
  assert.equal(raw.status, 400);
  assert.equal(raw.statusText, 'Bad Request');
  assert.equal(raw.headers.get('content-type'), 'application/json; charset=utf-8');
  await assert.rejects(api.patch(hash, { priority: 9 }), (error: unknown) =>
    error instanceof ApiError && error.status === 400 && error.message === '"priority" must be a whole number from 0 to 3');
  await assert.rejects(api.files('0000000000000000000000000000000000000000'), (error: unknown) =>
    error instanceof ApiError && error.status === 502 && error.message === 'invalid parameters: info-hash not found');
});

test('a keepalive save reaches the server before fetch first waits, as the one prefs.ts sends on pagehide must', async () => {
  const save = (theme: string, keepalive: boolean) => request<{ theme: string }>('prefs', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme }),
    keepalive,
  });
  const flushed = save('retro', true);
  // Nothing after an await runs once the page is going: the server has it, and has kept it, already.
  assert.equal(server.preferences().theme, 'retro');
  assert.equal(kept.at(-1)?.theme, 'retro');
  const plain = save('light', false);
  assert.equal(server.preferences().theme, 'retro', 'any other request waits half a round trip first');
  assert.equal((await flushed).theme, 'retro');
  assert.equal((await plain).theme, 'light');
});

test('other URLs go to the network as before', async () => {
  const response = await fetch('https://elsewhere.example.org/thing.json');
  assert.equal(await response.text(), 'elsewhere');
  assert.deepEqual(passed, ['https://elsewhere.example.org/thing.json']);
});

test('a cancel or a deadline cuts a request short as fetch\'s own does', async () => {
  latency = 60;
  try {
    const controller = new AbortController();
    const pending = request('state', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
    await assert.rejects(request('state', { timeoutMs: 10 }), (error: unknown) =>
      error instanceof ApiError && error.status === 0 && error.message.startsWith('no response after'));
  } finally {
    latency = 2;
  }
});

test('an upload goes through as a multipart form, files and fields', async () => {
  const form = new FormData();
  form.append('torrents', new File([torrentFile({ name: 'cc0-sounds.flac', length: 30_000 })], 'cc0-sounds.torrent'));
  form.append('torrents', new File(['not a torrent'], 'notes.torrent'));
  form.append('urls', '');
  form.append('label', 'music');
  const result: UploadResult = await api.upload(form);
  assert.deepEqual(result, {
    added: 1,
    errors: ['notes.torrent: not a valid .torrent file (bad string length)'],
    failedFiles: [1],
    failedUrls: [],
  });
  const state = await request<StateResponse>('state');
  assert.equal(state.torrents.find((t) => t.name === 'cc0-sounds.flac')?.label, 'music');
});

test('the stream: the real StreamConnection opens it, gets the state, and sees a change at once', async () => {
  const EventSourceShim = demoEventSource(transport, undefined);
  const toState = denormalizer();
  let view: StreamView | undefined;
  let changed: () => void = () => {};
  const connection = new StreamConnection({
    connect: (since, on) => {
      const source = new EventSourceShim(`${API}stream${since ? `?since=${encodeURIComponent(since)}` : ''}`);
      source.onopen = () => on.open();
      source.onerror = () => on.error();
      for (const name of STREAM_EVENTS) {
        source.addEventListener(name, (event) => {
          const message = event as MessageEvent<string>;
          on.event({ type: message.type, data: message.data, id: message.lastEventId });
        });
      }
      return source;
    },
    diagnose: async () => null,
    hidden: () => false,
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onChange: (next) => {
      view = next;
      changed();
    },
  });
  const until = (check: () => boolean) => new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('the stream did not get there')), 5000);
    const look = () => {
      if (!check()) return;
      clearTimeout(deadline);
      changed = () => {};
      resolve();
    };
    changed = look;
    look();
  });
  const state = () => (view?.model.state ? toState(view.model.state) : null);
  connection.start();
  try {
    await until(() => state() !== null);
    assert.equal(view?.linkError, null);
    const seeding = state()?.torrents.find((t) => t.status === 'seeding');
    assert.ok(seeding);
    const opened = Date.now();
    await api.bulkAction([seeding.hash], 'stop');
    await until(() => state()?.torrents.find((t) => t.hash === seeding.hash)?.status === 'stopped');
    // Woken by the change rather than at the next second's read.
    assert.ok(Date.now() - opened < 900, `the change took ${Date.now() - opened} ms to show`);
  } finally {
    connection.stop();
  }
});

test('anything else under the API is not a stream: it errors, as a 404 would', async () => {
  const EventSourceShim = demoEventSource(transport, undefined);
  const source = new EventSourceShim(`${API}state`);
  await new Promise<void>((resolve) => {
    source.onerror = () => resolve();
  });
  assert.equal(source.readyState, 2);
});
