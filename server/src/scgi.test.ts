/**
 * parseScgiTarget accepts every way an endpoint is written in the wild, and
 * scgiRequest frames a request the way rtorrent's SCGI reader expects.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { describeTarget, parseScgiTarget, scgiRequest } from './scgi';

test('unix socket forms', () => {
  assert.deepEqual(parseScgiTarget('unix:/run/rt/rpc.socket'), {
    kind: 'unix',
    path: '/run/rt/rpc.socket',
  });
  assert.deepEqual(parseScgiTarget('/run/rt/rpc.socket'), {
    kind: 'unix',
    path: '/run/rt/rpc.socket',
  });
  assert.deepEqual(parseScgiTarget('./rpc.socket'), { kind: 'unix', path: './rpc.socket' });
});

test('tcp forms', () => {
  assert.deepEqual(parseScgiTarget('rt.internal:5000'), {
    kind: 'tcp',
    host: 'rt.internal',
    port: 5000,
  });
  assert.deepEqual(parseScgiTarget('scgi://rt.internal:5000'), {
    kind: 'tcp',
    host: 'rt.internal',
    port: 5000,
  });
  assert.deepEqual(parseScgiTarget('[::1]:5000'), { kind: 'tcp', host: '::1', port: 5000 });
  assert.deepEqual(parseScgiTarget('5000'), { kind: 'tcp', host: '127.0.0.1', port: 5000 });
});

test('describeTarget round-trips into log lines', () => {
  assert.equal(describeTarget(parseScgiTarget('unix:/a/b')), 'unix:/a/b');
  assert.equal(describeTarget(parseScgiTarget('h:1')), 'h:1');
});

/* ------------------------------ the wire ------------------------------- */

/**
 * A one-shot SCGI server on a unix socket: records the request it was sent
 * and answers with the given bytes, so the framing on both sides is checked
 * against something that reads it like rtorrent does.
 */
function fakeScgi(reply: Buffer): Promise<{ path: string; received: () => Buffer; close: () => void }> {
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-scgi-')), 'rpc.socket');
  const chunks: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      // Netstring header, then CONTENT_LENGTH bytes of body: answer once all of it is in.
      const raw = Buffer.concat(chunks);
      const colon = raw.indexOf(':');
      if (colon < 0) return;
      const headerLength = Number(raw.subarray(0, colon).toString());
      const headers = raw.subarray(colon + 1, colon + 1 + headerLength).toString('latin1').split('\0');
      const bodyLength = Number(headers[headers.indexOf('CONTENT_LENGTH') + 1]);
      if (raw.length >= colon + 1 + headerLength + 1 + bodyLength) {
        socket.end(reply);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () =>
      resolve({ path: socketPath, received: () => Buffer.concat(chunks), close: () => server.close() }),
    );
  });
}

test('a request is framed as a netstring and the HTTP-ish headers are stripped from the reply', async () => {
  const body = Buffer.from('<methodCall><methodName>system.pid</methodName></methodCall>');
  const server = await fakeScgi(Buffer.from('Status: 200 OK\r\nContent-Type: text/xml\r\n\r\n<methodResponse/>'));
  try {
    const reply = await scgiRequest({ kind: 'unix', path: server.path }, body);
    assert.equal(reply.toString(), '<methodResponse/>');
    const sent = server.received().toString('latin1');
    // CONTENT_LENGTH must lead, per the SCGI spec, and the body must follow the comma.
    assert.match(sent, /^\d+:CONTENT_LENGTH\0\d+\0SCGI\x001\0/);
    assert.ok(sent.endsWith(`,${body.toString()}`));
  } finally {
    server.close();
  }
});

test('an empty reply is reported as rtorrent dropping the request', async () => {
  const server = await fakeScgi(Buffer.alloc(0));
  try {
    await assert.rejects(
      scgiRequest({ kind: 'unix', path: server.path }, Buffer.from('x')),
      /closed the SCGI connection .* without responding/,
    );
  } finally {
    server.close();
  }
});

test('a missing socket says rtorrent is not running, with the path', async () => {
  const missing = path.join(os.tmpdir(), 'cascade-no-such-socket');
  await assert.rejects(
    scgiRequest({ kind: 'unix', path: missing }, Buffer.from('x')),
    (error: unknown) => error instanceof Error && error.message.includes('rtorrent is not running') && error.message.includes(missing),
  );
});
