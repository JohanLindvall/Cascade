/**
 * The HTTP contract: input that is not what a route expects must come back as
 * a 400 that names the problem rather than reaching rtorrent and returning as
 * an opaque fault, bulk routes must report per-hash failures instead of
 * stopping, unknown API paths must answer JSON, and Basic auth must guard
 * everything but /healthz. The service underneath is a stub that records what
 * it was asked.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApp } from './app';
import type { Config } from './config';
import { HttpError } from './errors';
import type { RtorrentService } from './service';
import { tempStore, testConfig } from './testing/fakes';

const HASH = 'A'.repeat(40);
const OTHER = 'B'.repeat(40);

/** A service that records what it was asked and fails on demand. */
function stubService() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string, result: unknown = { ok: true }) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      if (args[0] === OTHER) throw new HttpError(502, 'rtorrent said no');
      return result;
    };
  const service = {
    calls,
    capabilities: { ready: false, ensure: async () => {}, methodNames: () => ['a', 'b'] },
    state: record('state', { status: {}, torrents: [] }),
    action: record('action'),
    remove: record('remove'),
    setPriority: record('setPriority'),
    setLabel: record('setLabel'),
    setFilePriority: record('setFilePriority'),
    addTracker: record('addTracker'),
    game: () => ({ enabled: true }),
    logScopes: () => ({ boot: [], extra: [], available: [], supported: true }),
    client: { call: record('rpc', 'pong') },
  };
  return service as typeof service & RtorrentService;
}

interface Harness {
  base: string;
  service: ReturnType<typeof stubService>;
  close: () => Promise<void>;
}

async function boot(over: Partial<Config> = {}): Promise<Harness> {
  const service = stubService();
  const config = testConfig(over);
  const app = createApp(service, config, tempStore().store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    service,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function json(base: string, path: string, init?: RequestInit) {
  const response = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

let open: Harness;
before(async () => {
  open = await boot();
});
after(async () => {
  await open.close();
});

test('healthz answers without auth and reports rtorrent readiness', async () => {
  const { status, body } = await json(open.base, '/healthz');
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, rtorrent: false });
});

test('an unknown API path is a JSON 404, not the SPA shell', async () => {
  const { status, body } = await json(open.base, '/api/nothing/here');
  assert.equal(status, 404);
  assert.match(String(body.error), /no such endpoint: GET \/nothing\/here/);
});

test('a malformed info hash is refused before the service is asked', async () => {
  const { status, body } = await json(open.base, '/api/torrents/not-a-hash/action/start', {
    method: 'POST',
  });
  assert.equal(status, 400);
  assert.equal(body.error, 'invalid info hash');
  assert.equal(open.service.calls.filter((call) => call.method === 'action').length, 0);
});

test('a lowercase hash is accepted and normalised', async () => {
  const { status } = await json(open.base, `/api/torrents/${HASH.toLowerCase()}/action/stop`, {
    method: 'POST',
  });
  assert.equal(status, 200);
  const call = open.service.calls.find((item) => item.method === 'action');
  assert.deepEqual(call?.args, [HASH, 'stop']);
});

test('bulk actions skip junk hashes and collect failures by hash', async () => {
  const { status, body } = await json(open.base, '/api/torrents/action/start', {
    method: 'POST',
    body: JSON.stringify({ hashes: [HASH, 'junk', OTHER] }),
  });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.deepEqual(body.errors, [`${OTHER}: rtorrent said no`]);
  const asked = open.service.calls.filter((call) => call.method === 'action').map((call) => call.args[0]);
  assert.ok(asked.includes(HASH));
  assert.ok(!asked.includes('junk'));
});

test('PATCH validates priority and slot counts instead of forwarding NaN', async () => {
  for (const patch of [{ priority: 'high' }, { priority: 7 }, { maxUploads: -1 }, { maxDownloads: 1.5 }]) {
    const { status, body } = await json(open.base, `/api/torrents/${HASH}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    assert.equal(status, 400, JSON.stringify(patch));
    assert.match(String(body.error), /must be a whole number/);
  }
  const { status } = await json(open.base, `/api/torrents/${HASH}`, {
    method: 'PATCH',
    body: JSON.stringify({ priority: 3 }),
  });
  assert.equal(status, 200);
  assert.deepEqual(open.service.calls.find((call) => call.method === 'setPriority')?.args, [HASH, 3]);
});

test('a file index and priority are validated', async () => {
  let result = await json(open.base, `/api/torrents/${HASH}/files/abc/priority`, {
    method: 'POST',
    body: JSON.stringify({ priority: 1 }),
  });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /"index"/);
  result = await json(open.base, `/api/torrents/${HASH}/files/2/priority`, {
    method: 'POST',
    body: JSON.stringify({ priority: 3 }),
  });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error), /"priority"/);
});

test('an added tracker must be an announce URL', async () => {
  const add = (url: unknown) =>
    json(open.base, `/api/torrents/${HASH}/trackers`, { method: 'POST', body: JSON.stringify({ url }) });
  for (const url of ['tracker.example.org/announce', 'ftp://example.org/announce', 'http://', 42]) {
    const { status } = await add(url);
    assert.equal(status, 400, String(url));
  }
  assert.equal(open.service.calls.filter((call) => call.method === 'addTracker').length, 0);
  const { status } = await add(' udp://tracker.example.org:6969/announce ');
  assert.equal(status, 200);
  assert.deepEqual(open.service.calls.find((call) => call.method === 'addTracker')?.args, [
    HASH,
    'udp://tracker.example.org:6969/announce',
    0,
  ]);
});

test('a malformed JSON body is a 400, not a stack trace', async () => {
  const { status, body } = await json(open.base, '/api/torrents/action/start', {
    method: 'POST',
    body: '{not json',
  });
  assert.equal(status, 400);
  assert.ok(typeof body.error === 'string');
});

test('a service HttpError keeps its status and message', async () => {
  const { status, body } = await json(open.base, `/api/torrents/${OTHER}/action/start`, {
    method: 'POST',
  });
  assert.equal(status, 502);
  assert.equal(body.error, 'rtorrent said no');
});

test('raw RPC is a 403 when switched off', async () => {
  const closed = await boot({ allowRawRpc: false });
  try {
    for (const path of ['/api/rpc/methods', '/api/rpc']) {
      const { status } = await json(closed.base, path, path === '/api/rpc' ? { method: 'POST', body: '{}' } : undefined);
      assert.equal(status, 403, path);
    }
  } finally {
    await closed.close();
  }
});

test('Basic auth guards the API but not /healthz', async () => {
  const locked = await boot({ user: 'admin', password: 'secret' });
  try {
    assert.equal((await fetch(`${locked.base}/healthz`)).status, 200);
    const denied = await fetch(`${locked.base}/api/game`);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate') ?? '', /Basic realm="Cascade"/);
    const wrong = await fetch(`${locked.base}/api/game`, {
      headers: { authorization: `Basic ${Buffer.from('admin:nope').toString('base64')}` },
    });
    assert.equal(wrong.status, 401);
    const allowed = await fetch(`${locked.base}/api/game`, {
      headers: { authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await locked.close();
  }
});

test('the SPA fallback says where it looked when the build is missing', async () => {
  const response = await fetch(`${open.base}/some/client/route`);
  assert.equal(response.status, 500);
  assert.match(await response.text(), /web assets not found/);
});

test('a cross-site form post is refused before it reaches the service', async () => {
  const before = open.service.calls.length;
  const form = new FormData();
  form.append('urls', 'magnet:?xt=urn:btih:' + 'c'.repeat(40));
  const response = await fetch(`${open.base}/api/torrents/upload`, {
    method: 'POST',
    body: form,
    headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'cross-site request refused' });
  assert.equal(open.service.calls.length, before);
});

test('same-origin and non-browser posts still go through', async () => {
  const cases: Array<Record<string, string>> = [{ 'sec-fetch-site': 'same-origin' }, {}];
  for (const headers of cases) {
    const { status } = await json(open.base, `/api/torrents/${HASH}/action/stop`, { method: 'POST', headers });
    assert.equal(status, 200, JSON.stringify(headers));
  }
});

test('every response carries the hardening headers', async () => {
  const response = await fetch(`${open.base}/healthz`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'same-origin');
});
