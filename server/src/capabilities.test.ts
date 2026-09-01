/**
 * The capability probe is what lets one UI drive rtorrent 0.9.8 and 0.16.20:
 * it picks command names from system.listMethods and turns them into the
 * supports map the UI greys controls out by. These pin the dialect choices
 * and the map against scripted command tables.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Capabilities } from './capabilities';
import { FILE_FIELDS, PEER_FIELDS, TORRENT_FIELDS, TRACKER_FIELDS } from './model';
import { FakeClient } from './testing/fakes';

const FIELDS = { torrent: TORRENT_FIELDS, file: FILE_FIELDS, peer: PEER_FIELDS, tracker: TRACKER_FIELDS };

function backend(methods: string[], extra: Record<string, unknown> = {}): FakeClient {
  return new FakeClient({
    'system.listMethods': methods,
    'system.client_version': '0.15.2',
    'system.library_version': '0.15.2',
    'system.api_version': '11',
    ...(extra as Record<string, never>),
  });
}

test('a modern backend gets multicall2 and the verbose loaders', async () => {
  const caps = new Capabilities(
    backend(['d.multicall2', 'load.raw_start_verbose', 'load.raw_verbose', 'load.verbose', 'load.start_verbose', 'd.hash', 'd.name']),
    FIELDS,
  );
  await caps.ensure();
  assert.equal(caps.ready, true);
  assert.equal(caps.dialect.downloadMulticall, 'd.multicall2');
  assert.deepEqual(caps.dialect.downloadMulticallPrefix('main'), ['', 'main']);
  assert.equal(caps.dialect.loadRawStart, 'load.raw_start_verbose');
  assert.equal(caps.dialect.loadUrl, 'load.verbose');
  assert.equal(caps.info.flavor, 'modern dialect (0.9.7+)');
  assert.equal(caps.info.clientVersion, '0.15.2');
  assert.equal(caps.info.methodCount, 7);
});

test('a legacy backend falls back to d.multicall with the view first', async () => {
  const caps = new Capabilities(backend(['d.multicall', 'load.raw_start', 'd.hash']), FIELDS);
  await caps.ensure();
  assert.equal(caps.dialect.downloadMulticall, 'd.multicall');
  assert.deepEqual(caps.dialect.downloadMulticallPrefix('main'), ['main']);
  assert.equal(caps.dialect.loadRawStart, 'load.raw_start');
  assert.equal(caps.info.flavor, 'legacy dialect (pre-0.9.7)');
});

test('field lists are filtered to what the backend implements', async () => {
  const caps = new Capabilities(backend(['d.multicall2', 'd.hash', 'd.name', 'f.path', 'p.address']), FIELDS);
  await caps.ensure();
  assert.deepEqual(caps.dialect.torrentFields, ['d.hash', 'd.name']);
  assert.deepEqual(caps.dialect.fileFields, ['f.path']);
  assert.deepEqual(caps.dialect.peerFields, ['p.address']);
  assert.deepEqual(caps.dialect.trackerFields, []);
});

test('a backend exposing none of the torrent fields gets the full list, to fault loudly', async () => {
  const caps = new Capabilities(backend(['d.multicall2']), FIELDS);
  await caps.ensure();
  assert.deepEqual(caps.dialect.torrentFields, [...TORRENT_FIELDS]);
});

test('supports covers features and every setting key', async () => {
  const caps = new Capabilities(
    backend(['d.multicall2', 'd.custom1.set', 'throttle.global_up.max_rate.set', 'network.port_range.set']),
    FIELDS,
  );
  await caps.ensure();
  assert.equal(caps.supports('labels'), true);
  assert.equal(caps.supports('throttleGroups'), false);
  assert.equal(caps.supports('uploadRate'), true);
  assert.equal(caps.supports('downloadRate'), false);
  // An alternate setter name (the pre-0.16 one here) is enough.
  assert.equal(caps.supports('portRange'), true);
  // Read-only settings never claim support.
  assert.equal(caps.supports('sessionDirectory'), false);
  assert.equal(caps.supports('never-heard-of-it'), false);
  assert.equal(caps.has('d.custom1.set'), true);
});

test('system.capabilities (0.16) fills in the RPC facility', async () => {
  const caps = new Capabilities(
    backend(['d.multicall2', 'system.capabilities'], {
      'system.capabilities': { facility: 'xmlrpc-c', version_major: 1, version_minor: 51, version_point: 8 },
    }),
    FIELDS,
  );
  await caps.ensure();
  assert.equal(caps.info.rpcFacility, 'xmlrpc-c 1.51.8');
});

test('a version probe that faults reads as unknown rather than failing the probe', async () => {
  const client = new FakeClient({ 'system.listMethods': ['d.multicall2'] });
  const caps = new Capabilities(client, FIELDS);
  await caps.ensure();
  assert.equal(caps.info.clientVersion, 'unknown');
  assert.equal(caps.info.rpcFacility, '');
});

test('ensure probes once and shares the in-flight probe; invalidate probes again', async () => {
  const client = backend(['d.multicall2']);
  const caps = new Capabilities(client, FIELDS);
  await Promise.all([caps.ensure(), caps.ensure(), caps.ensure()]);
  assert.equal(client.callsTo('system.listMethods').length, 1);
  await caps.ensure();
  assert.equal(client.callsTo('system.listMethods').length, 1);
  caps.invalidate();
  await caps.ensure();
  assert.equal(client.callsTo('system.listMethods').length, 2);
});

test('methodNames is sorted, for the console', async () => {
  const caps = new Capabilities(backend(['z.last', 'a.first', 'd.multicall2']), FIELDS);
  await caps.ensure();
  assert.deepEqual(caps.methodNames(), ['a.first', 'd.multicall2', 'z.last']);
});
