/**
 * The service is where rtorrent's quirks are worked around, so what these pin
 * is mostly what must *not* reach rtorrent: an erase before the data path was
 * checked, a load of something unfetchable, an unlimit that would conjure a
 * throttle group, a setter without its empty-string target. The restart half
 * of "recheck & restart" is a pure decision fed by d.hashing readings, with
 * its own timing traps below.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { HttpError } from './errors';
import { LOG_SCOPES, PendingRestarts, RtorrentService, sanitizeLogScopes } from './service';
import { FakeClient, methodList, tempStore, testConfig } from './testing/fakes';
import { XmlRpcFault } from './xmlrpc';

const HASH = 'A'.repeat(40);

function backend(extraMethods: string[] = []): FakeClient {
  return new FakeClient({
    'system.listMethods': methodList(extraMethods),
    'system.client_version': '0.16.20',
    'system.library_version': '0.16.20',
    'system.api_version': '12',
    'throttle.global_down.rate': 1200,
    'throttle.global_up.rate': 300,
    'throttle.global_down.total': 5000,
    'throttle.global_up.total': 2000,
    'throttle.global_down.max_rate': 0,
    'throttle.global_up.max_rate': 1024,
    'network.listen.port': 50000,
    'directory.default': '/downloads',
    'protocol.pex': 1,
    'd.multicall2': [],
  });
}

function service(client: FakeClient, over: Parameters<typeof testConfig>[0] = {}) {
  const config = testConfig(over);
  const { store } = tempStore();
  return { service: new RtorrentService(config, store, client), config, store };
}

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error.status;
    throw error;
  }
  return 200;
}

/* ----------------------------- pending restarts ----------------------------- */

test('the ordinary arc: queued, checking, finished, started once', () => {
  const pending = new PendingRestarts();
  pending.add(HASH);
  assert.equal(pending.step(HASH, 1), 'wait'); // queued counts as running
  assert.equal(pending.step(HASH, 3), 'wait'); // checking
  assert.equal(pending.step(HASH, 0), 'start'); // first zero after that: done
  assert.equal(pending.step(HASH, 0), 'drop'); // never twice
  assert.equal(pending.size, 0);
});

test('a check faster than the poll still restarts, after the zero floor', () => {
  const pending = new PendingRestarts();
  pending.add(HASH);
  for (let i = 1; i < PendingRestarts.ZERO_READS_FLOOR; i++) {
    assert.equal(pending.step(HASH, 0), 'wait', `zero reading ${i} must still wait`);
  }
  assert.equal(pending.step(HASH, 0), 'start');
});

test('a slow queue does not trip the floor once hashing is seen', () => {
  const pending = new PendingRestarts();
  pending.add(HASH);
  assert.equal(pending.step(HASH, 0), 'wait');
  assert.equal(pending.step(HASH, 0), 'wait');
  assert.equal(pending.step(HASH, 2), 'wait'); // the check finally started
  assert.equal(pending.step(HASH, 0), 'start'); // zero counter was reset
});

test('a torrent that cannot be asked is dropped, not restarted', () => {
  const pending = new PendingRestarts();
  pending.add(HASH);
  assert.equal(pending.step(HASH, null), 'drop'); // erased, or the call faulted
  assert.equal(pending.size, 0);
});

test('a wait past the ceiling expires instead of lingering forever', () => {
  const pending = new PendingRestarts();
  pending.add(HASH, 1_000);
  assert.equal(pending.step(HASH, 2, 2_000), 'wait');
  assert.equal(pending.step(HASH, 2, 1_000 + PendingRestarts.MAX_AGE_MS + 1), 'drop');
});

test('an unknown hash answers drop and disturbs nothing', () => {
  const pending = new PendingRestarts();
  pending.add(HASH);
  assert.equal(pending.step('B'.repeat(40), 0), 'drop');
  assert.equal(pending.size, 1);
});

test('log scopes: only the catalog passes, in catalog order, once', () => {
  assert.deepEqual(
    sanitizeLogScopes(['tracker_debug', 'debug', 'tracker_debug', 'made_up', 42]),
    ['debug', 'tracker_debug'],
  );
  assert.deepEqual(sanitizeLogScopes('debug'), []); // not an array: nothing
  assert.deepEqual(sanitizeLogScopes(undefined), []);
  assert.deepEqual(sanitizeLogScopes([...LOG_SCOPES]), [...LOG_SCOPES]);
});

/* --------------------------------- reads --------------------------------- */

test('status reads the gauges by command and the download directory', async () => {
  const { service: svc } = service(backend());
  const result = await svc.status([]);
  assert.equal(result.downRate, 1200);
  assert.equal(result.upRate, 300);
  assert.equal(result.downTotal, 5000);
  assert.equal(result.upLimit, 1024);
  assert.equal(result.listenPort, 50000);
  assert.equal(result.downloadDir, '/downloads');
  assert.equal(result.dhtNodes, 0); // no dht.statistics on this backend
  assert.equal(result.backend.clientVersion, '0.16.20');
  assert.equal(result.backend.supports.labels, true);
  assert.deepEqual(result.policy, { rawRpc: true, deleteData: true });
});

test('status reports the policy the server enforces, so the UI can stop offering it', async () => {
  const { service: svc } = service(backend(), { allowRawRpc: false, allowDataDelete: false });
  assert.deepEqual((await svc.status([])).policy, { rawRpc: false, deleteData: false });
});

test('dht.statistics is only asked for when the backend has it', async () => {
  const client = backend(['dht.statistics']).answer('dht.statistics', { active_nodes: 42 });
  const { service: svc } = service(client);
  assert.equal((await svc.status([])).dhtNodes, 42);
  assert.equal(client.callsTo('dht.statistics').length, 1);

  const bare = backend();
  await service(bare).service.status([]);
  assert.equal(bare.callsTo('dht.statistics').length, 0);
});

test('settings reads only what this backend can report, decoded by kind', async () => {
  const { service: svc } = service(backend());
  const settings = await svc.settings();
  assert.equal(settings.pex, true);
  assert.equal(settings.uploadRate, 1024);
  assert.equal(settings.downloadRate, 0);
  assert.ok(!('maxPeers' in settings)); // no getter on this backend
  assert.ok(!('encryption' in settings)); // write-only
});

/* --------------------------------- writes -------------------------------- */

test('updateSettings sends each setter with the empty-string target and skips the unsupported', async () => {
  const client = backend();
  const { service: svc } = service(client);
  await svc.updateSettings({ downloadRate: 2048, pex: false, dhtMode: 'auto' });
  assert.deepEqual(client.callsTo('throttle.global_down.max_rate.set')[0]?.params, ['', 2048]);
  assert.deepEqual(client.callsTo('protocol.pex.set')[0]?.params, ['', 0]);
  assert.equal(client.callsTo('dht.mode.set').length, 0);
});

test('an unknown action is a 400 and reaches nothing', async () => {
  const client = backend();
  const { service: svc } = service(client);
  assert.equal(await status(svc.action(HASH, 'explode')), 400);
  assert.equal(client.callsTo('d.stop').length, 0);
});

test('start opens then starts; announce is refused where the backend lacks it', async () => {
  const client = backend();
  const { service: svc } = service(client);
  await svc.action(HASH, 'start');
  assert.deepEqual(client.callsTo('d.open')[0]?.params, [HASH]);
  assert.deepEqual(client.callsTo('d.start')[0]?.params, [HASH]);
  assert.equal(await status(svc.action(HASH, 'announce')), 501);
  assert.equal(client.callsTo('d.tracker_announce').length, 0);
});

test('recheck clears the stale message alongside the check, and registers the restart', async () => {
  const client = backend();
  const { service: svc } = service(client);
  await svc.action(HASH, 'recheck-restart');
  assert.equal(client.callsTo('d.check_hash').length, 1);
  assert.deepEqual(client.callsTo('d.message.set')[0]?.params, [HASH, '']);
});

test('a link rtorrent could not fetch is refused before any load', async () => {
  const client = backend();
  const { service: svc } = service(client);
  assert.equal(await status(svc.addTorrentUrl('not a link', { start: true })), 400);
  assert.equal(await status(svc.addTorrentUrl('file:///etc/passwd', { start: true })), 400);
  assert.equal(client.callsTo('load.start').length, 0);
});

test('a magnet load is confirmed by its own hash, with the label URL-encoded', async () => {
  const client = backend().answer('d.hash', HASH);
  const { service: svc } = service(client);
  await svc.addTorrentUrl(`magnet:?xt=urn:btih:${HASH.toLowerCase()}`, {
    start: true,
    label: 'tv shows',
    directory: '/downloads/tv',
  });
  const load = client.callsTo('load.start')[0];
  assert.ok(load);
  assert.equal(load.params[0], ''); // the target argument, quirk 1
  assert.deepEqual(load.params.slice(2), [
    'd.directory.set="/downloads/tv"',
    'd.custom1.set="tv%20shows"',
  ]);
});

test('a magnet rtorrent never lists is a 502 naming the hash', async () => {
  const client = backend().answer('d.hash', new XmlRpcFault(-501, 'Could not find info-hash.'));
  const { service: svc } = service(client);
  await assert.rejects(
    svc.addTorrentUrl(`magnet:?xt=urn:btih:${HASH}`, { start: true }),
    (error: unknown) => error instanceof HttpError && error.status === 502 && error.message.includes(HASH),
  );
});

test('an upload that is not a torrent is a 400 and never reaches load.raw', async () => {
  const client = backend();
  const { service: svc } = service(client);
  assert.equal(await status(svc.addTorrentFile(Buffer.from('junk'), { start: true })), 400);
  assert.equal(client.callsTo('load.raw_start').length, 0);
});

/* -------------------------------- removal -------------------------------- */

test('data outside the delete roots is refused before the torrent is erased', async () => {
  const client = backend().answer('d.base_path', '/etc');
  const { service: svc } = service(client);
  assert.equal(await status(svc.remove(HASH, true)), 403);
  assert.equal(client.callsTo('d.erase').length, 0, 'erase must not run for a refused path');
});

test('the data root itself is never deleted', async () => {
  const client = backend();
  const { service: svc, config } = service(client);
  client.answer('d.base_path', config.downloadDir);
  assert.equal(await status(svc.remove(HASH, true)), 403);
  assert.equal(client.callsTo('d.erase').length, 0);
});

test('data inside a root is erased and removed, and the bookkeeping forgotten', async () => {
  const client = backend();
  const { service: svc, config, store } = service(client);
  const release = path.join(config.downloadDir, 'release');
  fs.mkdirSync(release);
  fs.writeFileSync(path.join(release, 'a.bin'), 'x');
  client.answer('d.base_path', release);
  store.addedAt(HASH, 1);

  await svc.remove(HASH, true);
  assert.equal(client.callsTo('d.erase').length, 1);
  assert.ok(!fs.existsSync(release));
  assert.equal(store.addedAt(HASH, 9), 9); // forgotten, so re-recorded
});

test('data deletion can be switched off entirely', async () => {
  const client = backend();
  const { service: svc } = service(client, { allowDataDelete: false });
  assert.equal(await status(svc.remove(HASH, true)), 403);
  assert.equal(client.callsTo('d.base_path').length, 0);
  await svc.remove(HASH, false); // plain removal still works
  assert.equal(client.callsTo('d.erase').length, 1);
});

/* ------------------------------- throttles ------------------------------- */

test('a throttle group is created in rtorrent and remembered; deleting unlimits it', async () => {
  const client = backend();
  const { service: svc, store } = service(client);
  await svc.saveThrottle({ name: 'slow', up: 1024, down: 4096 });
  assert.deepEqual(client.callsTo('throttle.up')[0]?.params, ['', 'slow', '1024']);
  assert.deepEqual(store.throttles(), [{ name: 'slow', up: 1024, down: 4096 }]);

  await svc.deleteThrottle('slow');
  assert.deepEqual(client.callsTo('throttle.up')[1]?.params, ['', 'slow', '0']);
  assert.deepEqual(store.throttles(), []);
});

test('deleting a group the store never saved is a 404, not a new group in rtorrent', async () => {
  const client = backend();
  const { service: svc } = service(client);
  assert.equal(await status(svc.deleteThrottle('phantom')), 404);
  assert.equal(client.callsTo('throttle.up').length, 0);
});

test('a throttle name that rtorrent would choke on is a 400', async () => {
  const { service: svc } = service(backend());
  assert.equal(await status(svc.saveThrottle({ name: 'has space', up: 0, down: 0 })), 400);
  assert.equal(await status(svc.saveThrottle({ name: 'x'.repeat(33), up: 0, down: 0 })), 400);
});

/* ------------------------------- log scopes ------------------------------ */

test('log scopes: what took is kept, what the build refused is named, lowering is honest', async () => {
  const client = backend().answer('log.add_output', (params) =>
    params[1] === 'tracker_debug' ? new XmlRpcFault(-1, 'no such group') : 0,
  );
  const { service: svc, store } = service(client, { logLevel: 'info,notice' });

  const raised = await svc.setLogScopes(['debug', 'tracker_debug', 'made_up']);
  assert.deepEqual(raised.failed, ['tracker_debug']);
  assert.deepEqual(store.logScopes(), ['debug']);
  assert.deepEqual(svc.logScopes().boot, ['info', 'notice']);
  assert.deepEqual(svc.logScopes().extra, ['debug']);

  // Switching debug off cannot detach it: the answer says so.
  const lowered = await svc.setLogScopes([]);
  assert.deepEqual(lowered.stillActive, ['debug']);
  assert.deepEqual(store.logScopes(), []);

  // Raising it again is a no-op on the wire: it is already attached.
  const before = client.callsTo('log.add_output').length;
  await svc.setLogScopes(['debug']);
  assert.equal(client.callsTo('log.add_output').length, before);
});

test('log scopes are refused where the backend has no log.add_output', async () => {
  const client = new FakeClient({
    'system.listMethods': methodList().filter((name) => name !== 'log.add_output'),
  });
  const { service: svc } = service(client);
  assert.equal(await status(svc.setLogScopes(['debug'])), 501);
});

/* ---------------------------------- log ---------------------------------- */

test('the log tail reads the end of the file and drops a cut first line', async () => {
  const { service: svc, config } = service(backend());
  assert.deepEqual(await svc.log(10), []); // no file yet
  const lines = Array.from({ length: 20 }, (_, i) => `1788015928 I line ${i}`);
  fs.writeFileSync(config.logFile, lines.join('\n') + '\n');
  assert.deepEqual(await svc.log(3), lines.slice(-3));
});
