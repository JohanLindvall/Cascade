/**
 * How a request that goes wrong is reported. The request's signal stays armed
 * until the body is read, so a deadline or a cancel can land after the
 * headers; it must read the same as one before them, not as a server that
 * answered with something other than JSON. Driven against a real local
 * server, since the body-phase abort is fetch's own behaviour.
 */
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';

/** Headers and the start of a body, then nothing: a stall mid-body. */
function stall(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.write('{"lines": [');
}

const server = createServer((req, response) => {
  switch (new URL(req.url ?? '', 'http://x').pathname) {
    case '/api/ok':
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    case '/api/login':
      response.writeHead(200, { 'content-type': 'text/html' }).end('<html>sign in</html>');
      return;
    case '/api/stall':
      stall(response, 200);
      return;
    case '/api/stall-error':
      stall(response, 500);
      return;
    case '/api/drop':
      stall(response, 200);
      setTimeout(() => response.socket?.destroy(), 20);
      return;
    case '/api/silent':
      return; // never even the headers
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => {
  server.closeAllConnections();
  server.close();
});

// api.ts resolves its base against the document at load time.
Object.assign(globalThis, { document: { baseURI: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` } });
const { ApiError, request } = await import('./api.ts');

// Tells a test when the headers are in, so what it does next lands mid-body.
let headersIn: () => void = () => {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await realFetch(input, init);
  headersIn();
  return response;
};
const nextHeaders = () => new Promise<void>((resolve) => { headersIn = resolve; });

function apiError(message: RegExp, status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof ApiError, `an ApiError, not ${String(error)}`);
    assert.match(error.message, message);
    assert.equal(error.status, status);
    return true;
  };
}

test('an answer is parsed, and a page that is not JSON is named as such', async () => {
  assert.deepEqual(await request('ok'), { ok: true });
  await assert.rejects(request('login?x=1'), apiError(/^the server answered login with something other than JSON$/, 200));
});

test('a deadline reads the same before the headers and after them', async () => {
  await assert.rejects(request('silent', { timeoutMs: 200 }), apiError(/^no response after \d+s/, 0));
  const headers = nextHeaders();
  await assert.rejects(request('stall', { timeoutMs: 200 }), apiError(/^no response after \d+s/, 0));
  await headers; // it was the body that stalled
  // A failed status had arrived before the deadline, and says more than "no response".
  await assert.rejects(request('stall-error', { timeoutMs: 200 }), apiError(/^500 Internal Server Error$/, 500));
});

test('a cancel after the headers rejects with the AbortError itself', async () => {
  for (const path of ['stall', 'stall-error']) {
    const controller = new AbortController();
    void nextHeaders().then(() => controller.abort());
    await assert.rejects(request(path, { signal: controller.signal }), (error: unknown) => {
      assert.ok(error instanceof DOMException, `${path}: a DOMException, not ${String(error)}`);
      assert.equal(error.name, 'AbortError', path);
      return true;
    });
  }
});

test('a connection that drops mid-body is not blamed on the content', async () => {
  await assert.rejects(request('drop'), apiError(/^cannot reach the Cascade server$/, 0));
});
