/**
 * The client sits between every service call and the socket: it queues
 * requests behind a concurrency cap (rtorrent is single-threaded), names the
 * failing command in a multicall fault, and zips the flat multicall rows into
 * records. All of it is exercised here through a scripted transport.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CONCURRENCY, RtorrentClient, XmlRpcFault, settledNumber } from './rtorrent';
import { serializeCall, type XValue } from './xmlrpc';

const TARGET = { kind: 'unix' as const, path: '/nowhere/rpc.socket' };

/** Serialize a value the way rtorrent would answer it, by borrowing the call encoder. */
function respond(value: XValue): Buffer {
  const call = serializeCall('x', [value]).toString('utf8');
  const body = /<params><param>(.*)<\/param><\/params>/s.exec(call);
  assert.ok(body);
  return Buffer.from(
    `Status: 200 OK\r\nContent-Type: text/xml\r\n\r\n<?xml version="1.0"?><methodResponse><params><param>${body[1]}</param></params></methodResponse>`,
  );
}

/** The method name out of a serialized call, so a transport can script by it. */
function methodOf(body: Buffer): string {
  return /<methodName>([^<]+)<\/methodName>/.exec(body.toString('utf8'))?.[1] ?? '';
}

test('call round-trips through the transport and decodes the answer', async () => {
  const seen: string[] = [];
  const client = new RtorrentClient(TARGET, async (body) => {
    seen.push(methodOf(body));
    return respond('0.16.20');
  });
  assert.equal(await client.call('system.client_version'), '0.16.20');
  assert.deepEqual(seen, ['system.client_version']);
  assert.equal(client.endpoint, 'unix:/nowhere/rpc.socket');
});

test('never more than MAX_CONCURRENCY requests are in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  const client = new RtorrentClient(TARGET, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return respond(1);
  });
  await Promise.all(Array.from({ length: MAX_CONCURRENCY * 3 }, () => client.call('d.hash')));
  assert.equal(peak, MAX_CONCURRENCY);
  assert.equal(inFlight, 0);
});

test('a fault inside a multicall names the command that faulted', async () => {
  const client = new RtorrentClient(TARGET, async () =>
    respond([['ok'], { faultCode: -503, faultString: 'Wrong object type.' }]),
  );
  const settled = await client.multicallSettled([
    { methodName: 'd.name', params: ['A'] },
    { methodName: 'throttle.global_up.max_rate.set', params: [1] },
  ]);
  assert.equal(settled[0], 'ok');
  const fault = settled[1];
  assert.ok(fault instanceof XmlRpcFault);
  assert.equal(fault.faultCode, -503);
  assert.match(fault.faultString, /^throttle\.global_up\.max_rate\.set: Wrong object type/);

  // multicall() surfaces the same fault by throwing it.
  await assert.rejects(
    client.multicall([
      { methodName: 'd.name', params: ['A'] },
      { methodName: 'throttle.global_up.max_rate.set', params: [1] },
    ]),
    (error: unknown) => error instanceof XmlRpcFault && error.faultCode === -503,
  );
});

test('an empty multicall never touches the transport', async () => {
  let calls = 0;
  const client = new RtorrentClient(TARGET, async () => {
    calls += 1;
    return respond([]);
  });
  assert.deepEqual(await client.multicallSettled([]), []);
  assert.equal(calls, 0);
});

test('fieldMulticall asks for each field with "=" and zips the rows back', async () => {
  let sent: Buffer = Buffer.alloc(0);
  const client = new RtorrentClient(TARGET, async (body) => {
    sent = body;
    return respond([
      ['AAA', 'first', 100],
      ['BBB', 'second'], // a short row: the missing field reads as ''
    ]);
  });
  const rows = await client.fieldMulticall('d.multicall2', ['', 'main'], [
    'd.hash',
    'd.name',
    'd.size_bytes',
  ]);
  assert.match(sent.toString('utf8'), /d\.hash=.*d\.name=.*d\.size_bytes=/s);
  assert.deepEqual(rows, [
    { 'd.hash': 'AAA', 'd.name': 'first', 'd.size_bytes': 100 },
    { 'd.hash': 'BBB', 'd.name': 'second', 'd.size_bytes': '' },
  ]);
});

test('settledNumber reads faults and junk as zero', () => {
  assert.equal(settledNumber(42), 42);
  assert.equal(settledNumber('17'), 17);
  assert.equal(settledNumber(new XmlRpcFault(-1, 'x')), 0);
  assert.equal(settledNumber('junk'), 0);
  assert.equal(settledNumber(undefined), 0);
});
