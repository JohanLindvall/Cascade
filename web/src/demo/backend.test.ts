/**
 * The simulated server route by route: the shapes the UI reads, the checks the
 * Go server makes and the words it refuses with, and rtorrent's own faults
 * relayed as the server relays them — a 502 with the fault, or a bulk route's
 * per-hash error. The messages here were taken from a running 0.16.24.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LogScopeChange, StateResponse, Torrent, TorrentFile, Tracker, UploadResult } from '../contracts.ts';
import { DEFAULT_PREFERENCES } from '../preferences.ts';
import { DEFAULT_POLL_MS, DemoServer, type DemoRequest, type DemoResponse, type UploadPart } from './backend.ts';
import { ManualClock, torrentFile } from './fixtures.ts';

const START = Date.UTC(2026, 9, 6, 19, 0, 0) + 503;
const UNKNOWN = '0000000000000000000000000000000000000000';

function setup() {
  const clock = new ManualClock(START);
  const saved: unknown[] = [];
  const server = new DemoServer({
    now: () => clock.now, timers: clock, seed: 5, version: '0.16.24', onPreferences: (prefs) => saved.push(prefs),
  });
  const call = (method: string, path: string, body?: unknown, query = ''): DemoResponse => server.handle({
    method,
    path,
    query: new URLSearchParams(query),
    contentType: body === undefined ? '' : 'application/json',
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const ok = <T>(method: string, path: string, body?: unknown, query = ''): T => {
    const answer = call(method, path, body, query);
    assert.equal(answer.status, 200, `${method} ${path}: ${JSON.stringify(answer.body)}`);
    return answer.body as T;
  };
  const refused = (method: string, path: string, body: unknown, status: number, error: string) => {
    const answer = call(method, path, body);
    assert.equal(answer.status, status, `${method} ${path}: ${JSON.stringify(answer.body)}`);
    assert.equal((answer.body as { error: string }).error, error);
    return answer.body as { error: string; faultCode?: number };
  };
  const upload = (parts: UploadPart[]): DemoResponse => server.handle({
    method: 'POST', path: 'torrents/upload', query: new URLSearchParams(), contentType: 'multipart/form-data; boundary=x', parts,
  } satisfies DemoRequest);
  const torrents = () => ok<StateResponse>('GET', 'state').torrents;
  const named = (prefix: string): Torrent => {
    const found = torrents().find((t) => t.name.startsWith(prefix));
    assert.ok(found, `no torrent named ${prefix}`);
    return found;
  };
  return { clock, server, saved, call, ok, refused, upload, torrents, named };
}

test('the state: the real contract, the demo policy, the release from the Dockerfile', () => {
  const { ok } = setup();
  const state = ok<StateResponse>('GET', 'state');
  assert.deepEqual(Object.keys(state).sort(), ['game', 'status', 'throttles', 'torrents']);
  assert.deepEqual(state.status.policy, { rawRpc: true, deleteData: true });
  assert.equal(state.status.statePollMs, DEFAULT_POLL_MS);
  assert.equal(state.status.statePollDefaultMs, DEFAULT_POLL_MS);
  assert.equal(state.status.backend.clientVersion, '0.16.24');
  assert.equal(state.status.backend.libraryVersion, '0.16.24');
  assert.ok(Object.values(state.status.backend.supports).every(Boolean), 'every control is offered');
  assert.equal(state.status.backend.methodCount, ok<{ methods: string[] }>('GET', 'rpc/methods').methods.length);
  assert.equal(state.status.downloadDir, '/downloads');
  assert.equal(state.game.enabled, true);
  assert.deepEqual(ok('GET', 'status'), state.status);
  assert.deepEqual(ok('GET', 'game'), state.game);
  assert.deepEqual(ok('GET', 'capabilities'), state.status.backend);
});

test('preferences: repaired as the shared schema repairs them, kept for next time, and the pace taken up', () => {
  const { ok, saved } = setup();
  assert.deepEqual(ok('GET', 'prefs'), DEFAULT_PREFERENCES);
  const next = ok<typeof DEFAULT_PREFERENCES>('PATCH', 'prefs', { theme: 'retro', sortKey: 'bogus', statePollMs: 50, unknown: 1 });
  assert.equal(next.theme, 'retro');
  assert.equal(next.sortKey, DEFAULT_PREFERENCES.sortKey);
  assert.equal(next.statePollMs, 100);
  assert.ok(!('unknown' in next));
  assert.deepEqual(saved, [next]);
  assert.equal(ok<StateResponse>('GET', 'state').status.statePollMs, 100);
  ok('PATCH', 'prefs', { theme: 'retro' });
  assert.equal(saved.length, 1, 'an unchanged PATCH saved again');
});

test('unknown paths, malformed bodies and bad hashes are refused as the server refuses them', () => {
  const { call, refused } = setup();
  refused('GET', 'nothing', undefined, 404, 'no such endpoint: GET /nothing');
  refused('PUT', 'state', undefined, 404, 'no such endpoint: PUT /state');
  refused('GET', 'torrents/zz/files', undefined, 400, 'invalid info hash');
  refused('PATCH', `torrents/${UNKNOWN}`, '[1, 2]', 400, '"body" must be an object');
  refused('PATCH', `torrents/${UNKNOWN}`, '5', 400, 'request body must be a JSON object, not "5"');
  assert.match((call('PATCH', `torrents/${UNKNOWN}`, '{"priority":') .body as { error: string }).error, /^malformed JSON body: /);
  const latin = { method: 'PATCH', path: 'prefs', query: new URLSearchParams(), contentType: 'application/json; charset=latin1', body: '{}' };
  assert.equal(setup().server.handle(latin).status, 415);
});

test('a hash rtorrent does not hold: a 502 carrying its fault, or the bulk route\'s per-hash error', () => {
  const { ok, refused } = setup();
  const fault = 'invalid parameters: info-hash not found';
  for (const tab of ['files', 'peers', 'trackers']) {
    assert.equal(refused('GET', `torrents/${UNKNOWN}/${tab}`, undefined, 502, fault).faultCode, -503);
  }
  refused('PATCH', `torrents/${UNKNOWN}`, { priority: 3 }, 502, fault);
  refused('PATCH', `torrents/${UNKNOWN}`, { maxUploads: 3 }, 502, `d.uploads_max.set: ${fault}`);
  refused('POST', `torrents/${UNKNOWN}/files/0/priority`, { priority: 1 }, 502, `f.priority.set: ${fault}`);
  refused('POST', `torrents/${UNKNOWN}/trackers`, { url: 'http://tracker.example.org/announce' }, 502, `d.tracker.insert: ${fault}`);
  assert.deepEqual(ok('POST', 'torrents/action/start', { hashes: [UNKNOWN] }), {
    ok: false, errors: [`${UNKNOWN}: rtorrent fault -503: ${fault}`],
  });
  assert.deepEqual(ok('POST', 'torrents/action/frob', { hashes: [UNKNOWN] }), { ok: false, errors: [`${UNKNOWN}: unknown action "frob"`] });
  assert.deepEqual(ok('POST', 'torrents/remove', { hashes: [UNKNOWN] }), {
    ok: false, errors: [`${UNKNOWN}: rtorrent fault -503: ${fault}`],
  });
  assert.deepEqual(ok('GET', 'trackers', undefined, `hashes=${UNKNOWN},zz`), { [UNKNOWN]: 'unknown' });
});

test('fields are checked before anything changes, and named when refused', () => {
  const { refused, named } = setup();
  const hash = named('ubuntu').hash;
  refused('PATCH', `torrents/${hash}`, { priority: 7 }, 400, '"priority" must be a whole number from 0 to 3');
  refused('PATCH', `torrents/${hash}`, { priority: null }, 400, '"priority" must be a whole number from 0 to 3');
  refused('PATCH', `torrents/${hash}`, { label: 5 }, 400, '"label" must be a string');
  refused('PATCH', `torrents/${hash}`, { label: 'ok', directory: '' }, 400, '"directory" must be a non-empty string');
  assert.equal(named('ubuntu').label, 'linux', 'a refused patch changed a field before the bad one');
  refused('POST', `torrents/${hash}/files/0/priority`, { priority: 5 }, 400, '"priority" must be a whole number from 0 to 2');
  refused('POST', `torrents/${hash}/files/9/priority`, { priority: 1 }, 502, 'f.priority.set: invalid parameters: index not found');
  refused('POST', `torrents/${hash}/trackers/9/enabled`, { enabled: true }, 502, 'invalid parameters: index not found');
  refused('POST', `torrents/${hash}/trackers/0/enabled`, { enabled: 'maybe' }, 400, '"enabled" must be a boolean');
  refused('POST', `torrents/${hash}/trackers`, { url: 'ftp://x' }, 400, '"url" must be an http(s):// or udp:// announce URL');
  refused('POST', 'torrents/action/start', { hashes: [] }, 400, '"hashes" must be a non-empty array of 40-digit hexadecimal info hashes');
  refused('POST', 'torrents/remove', { hashes: [hash], deleteData: 'maybe' }, 400, '"deleteData" must be a boolean');
});

test('actions change the torrent: stop, start, pause, resume, announce', () => {
  const { ok, named } = setup();
  const { hash } = named('FreeBSD');
  const act = (action: string) => assert.deepEqual(ok('POST', 'torrents/action/' + action, { hashes: [hash, hash.toLowerCase()] }), { ok: true, errors: [] });
  act('stop');
  assert.equal(named('FreeBSD').status, 'stopped');
  assert.equal(named('FreeBSD').isOpen, false);
  act('start');
  assert.equal(named('FreeBSD').status, 'seeding');
  act('pause');
  assert.equal(named('FreeBSD').status, 'paused');
  act('resume');
  assert.equal(named('FreeBSD').status, 'seeding');
  assert.deepEqual(ok('POST', `torrents/${hash}/action/announce`), { ok: true });
});

test('a torrent\'s fields: priority, label, throttle group, directory, slots, file priority, trackers', () => {
  const { ok, named, clock } = setup();
  const { hash } = named('Sintel');
  ok('PATCH', `torrents/${hash}`, { priority: 3, label: 'films', throttle: 'seedbox', maxUploads: 7 });
  let t = named('Sintel');
  assert.equal(t.priority, 3);
  assert.equal(t.label, 'films');
  assert.equal(t.throttle, 'seedbox');
  assert.equal(t.status, 'downloading', 'a throttle change stops and restarts a running download');
  ok('PATCH', `torrents/${hash}`, { directory: '/downloads/films/' });
  t = named('Sintel');
  assert.equal(t.status, 'stopped', 'a directory change leaves the torrent stopped');
  assert.equal(t.directory, '/downloads/films/Sintel (2010)');
  assert.equal(t.basePath, '/downloads/films/Sintel (2010)');

  ok('POST', `torrents/${hash}/files/1/priority`, { priority: 0 });
  assert.equal(ok<TorrentFile[]>('GET', `torrents/${hash}/files`)[1].priority, 0);

  const trackers = () => ok<Tracker[]>('GET', `torrents/${hash}/trackers`);
  const count = trackers().length;
  ok('POST', `torrents/${hash}/trackers/0/enabled`, { enabled: false });
  assert.equal(trackers()[0].enabled, false);
  ok('POST', `torrents/${hash}/trackers`, { url: 'udp://extra.example.net:6969/announce', group: 0 });
  const after = trackers();
  assert.equal(after.length, count + 1);
  assert.equal(after[1].url, 'udp://extra.example.net:6969/announce');
  assert.equal(after[1].extra, true);
  clock.advance(1000);
  assert.equal(named('Sintel').trackerCount, count + 1);
});

test('removing: the data goes only from inside the data roots, refused before the torrent is erased', () => {
  const { ok, named, torrents } = setup();
  const before = ok<StateResponse>('GET', 'state');
  const netbsd = named('NetBSD');
  ok('DELETE', `torrents/${netbsd.hash}`, undefined, 'deleteData=1');
  assert.ok(!torrents().some((t) => t.hash === netbsd.hash));
  const freed = ok<StateResponse>('GET', 'state').status.diskFree! - before.status.diskFree!;
  assert.ok(Math.abs(freed - netbsd.completed) < 1024 * 1024, `freed ${freed} for ${netbsd.completed}`);

  const cosmos = named('Cosmos');
  ok('PATCH', `torrents/${cosmos.hash}`, { directory: '/mnt/elsewhere' });
  assert.deepEqual(ok('POST', 'torrents/remove', { hashes: [cosmos.hash], deleteData: true }), {
    ok: false,
    errors: [`${cosmos.hash}: refusing to delete "/mnt/elsewhere/Cosmos Laundromat (2015)": it is outside the permitted data roots or would delete a data root (/downloads)`],
  });
  assert.ok(torrents().some((t) => t.hash === cosmos.hash), 'refused, yet erased');
});

test('uploads: torrents parsed and added, junk refused with the reason, failures reported by index', () => {
  const { upload, named, clock } = setup();
  const file = torrentFile({ name: 'Elephants-Dream-cc-by.mkv', length: 50_000, private: 1 });
  const answer = upload([
    { name: 'torrents', filename: 'ed.torrent', data: file },
    { name: 'torrents', filename: 'notes.torrent', data: new TextEncoder().encode('hello\n') },
    { name: 'urls', value: 'magnet:?xt=urn:btih:89abcdef0123456789abcdef0123456789abcdef&dn=open-movie.mkv\n  ftp//bad\nhttps://downloads.example.org/files/freebsd-dvd1.iso.torrent\n' },
    { name: 'label', value: 'films' },
    { name: 'start', value: '1' },
  ]);
  assert.equal(answer.status, 200);
  const result = answer.body as UploadResult;
  assert.deepEqual(result.failedFiles, [1]);
  assert.deepEqual(result.failedUrls, [1]);
  assert.equal(result.added, 3);
  assert.deepEqual(result.errors, [
    'notes.torrent: not a valid .torrent file (bad string length)',
    'ftp//bad: "ftp//bad" is not a magnet link or a torrent URL (magnet:, http(s):, ftp:)',
  ]);
  const added = named('Elephants-Dream-cc-by.mkv');
  assert.equal(added.size, 50_000);
  assert.equal(added.isPrivate, true);
  assert.equal(added.label, 'films');
  assert.equal(added.status, 'downloading');
  assert.equal(named('freebsd-dvd1.iso').label, 'films');
  // A magnet is <HASH>.meta until its metadata arrives, then named by its dn.
  const meta = named('89ABCDEF0123456789ABCDEF0123456789ABCDEF.meta');
  assert.equal(meta.size, 1);
  assert.equal(meta.directory, '/config/session');
  clock.advance(8000);
  const fetched = named('open-movie.mkv');
  assert.equal(fetched.hash, meta.hash);
  assert.ok(fetched.size > 1024 ** 2);
  assert.equal(fetched.directory, '/downloads');

  // The same torrent again is a 409 naming it, collected like any other failure.
  const again = upload([{ name: 'torrents', filename: 'ed.torrent', data: file }]).body as UploadResult;
  assert.deepEqual(again.errors, ['ed.torrent: "Elephants-Dream-cc-by.mkv" is already loaded']);
});

test('upload options and limits: stopped adds, refused directories, empty and oversized forms', () => {
  const { upload, named } = setup();
  const data = torrentFile({ name: 'quiet.iso', length: 20_000 });
  const stopped = upload([
    { name: 'torrents', filename: 'quiet.torrent', data },
    { name: 'start', value: '0' },
    { name: 'directory', value: '/downloads/iso' },
  ]);
  assert.equal((stopped.body as UploadResult).added, 1);
  const quiet = named('quiet.iso');
  assert.equal(quiet.status, 'stopped');
  assert.equal(quiet.directory, '/downloads/iso');
  assert.equal(quiet.basePath, '', 'never opened, so no base path yet');

  const refusedDirectory = (directory: string) => (upload([
    { name: 'urls', value: 'magnet:?xt=urn:btih:1123456789abcdef0123456789abcdef01234567' },
    { name: 'directory', value: directory },
  ]).body as UploadResult).errors[0];
  assert.match(refusedDirectory('$(id)'), /"directory" must be a literal path, not an rtorrent command/);
  assert.match(refusedDirectory('/downloads/a\tb'), /"directory" contains control characters/);

  assert.equal(upload([]).status, 400);
  assert.deepEqual(upload([]).body, { error: 'no .torrent files or URLs supplied' });
  const tooMany = upload(['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, value: '' })));
  assert.deepEqual([tooMany.status, tooMany.body], [400, { error: 'Too many fields' }]);
  const stray = upload([{ name: 'file', filename: 'x.torrent', data }]);
  assert.deepEqual([stray.status, stray.body], [400, { error: 'Unexpected field' }]);
  const repeated = upload([{ name: 'urls', value: 'a' }, { name: 'urls', value: 'b' }]);
  assert.deepEqual([repeated.status, repeated.body], [400, { error: '"urls" must be a string' }]);
});

test('settings: every readable one reported, a bad value refused by name, a good one applied live', () => {
  const { ok, refused } = setup();
  const settings = ok<Record<string, unknown>>('GET', 'settings');
  assert.ok(!('dhtMode' in settings) && !('encryption' in settings), 'write-only settings cannot be read back');
  assert.equal(settings.directory, '/downloads');
  assert.equal(settings.sessionDirectory, '/config/session/');
  refused('POST', 'settings', { maxPeers: 10, downloadRate: -5 }, 400, '"downloadRate" must be a whole number from 0 to 9007199254740991');
  assert.equal(ok<Record<string, unknown>>('GET', 'settings').maxPeers, 200, 'a refused patch applied part of itself');
  const updated = ok<Record<string, unknown>>('POST', 'settings', { downloadRate: 1048576, pex: 'off', encryption: 'require, require_RC4', sessionDirectory: '/x' });
  assert.equal(updated.downloadRate, 1048576);
  assert.equal(updated.pex, false);
  assert.equal(updated.sessionDirectory, '/config/session/');
  const state = ok<StateResponse>('GET', 'state');
  assert.equal(state.status.downLimit, 1048576);
  // What rtorrent refuses itself is its fault, relayed with the command that raised it.
  refused('POST', 'settings', { encryption: 'bogus' }, 502, "protocol.encryption.set: Invalid encryption option: 'bogus'");
  refused('POST', 'settings', { portRange: '6881' }, 502, 'network.listen.port.range.set: Invalid port_range argument.');
});

test('throttle groups: names checked, rates rounded up to whole KiB/s, unknown ones a 404', () => {
  const { ok, refused, call } = setup();
  refused('POST', 'throttles', { name: 'bad name', up: 1, down: 1 }, 400, 'throttle name must be 1-32 chars of [A-Za-z0-9_.-] and cannot be NULL, . or ..');
  refused('POST', 'throttles', { name: 'night', up: 1.5, down: 1 }, 400, '"up" must be a whole number from 0 to 9007199254740991');
  ok('POST', 'throttles', { name: 'night', up: 1000, down: 1500 });
  const groups = () => ok<{ groups: Array<{ name: string; up: number; down: number }>; rates: Record<string, unknown> }>('GET', 'throttles');
  assert.deepEqual(groups().groups.find((group) => group.name === 'night'), { name: 'night', up: 1024, down: 2048 });
  assert.ok('night' in groups().rates);
  refused('PATCH', 'throttles/nope', { up: 5 }, 404, 'no throttle group named "nope"');
  refused('PATCH', 'throttles/night', undefined, 400, '"body" must be an object');
  refused('PATCH', 'throttles/night', {}, 400, 'supply an up or down rate');
  ok('PATCH', 'throttles/night', { down: 4096 });
  assert.deepEqual(groups().groups.find((group) => group.name === 'night'), { name: 'night', up: 1024, down: 4096 });
  refused('DELETE', 'throttles/nope', undefined, 404, 'no throttle group named "nope"');
  assert.equal(call('DELETE', 'throttles/night').status, 200);
  assert.ok(!groups().groups.some((group) => group.name === 'night'));
});

test('the log: its tail on request, scopes raised live, a lowered one still writing until a restart', () => {
  const { ok, refused } = setup();
  assert.equal(ok<{ lines: string[] }>('GET', 'log', undefined, 'lines=5').lines.length, 5);
  assert.ok(ok<{ lines: string[] }>('GET', 'log', undefined, 'lines=x').lines.length > 5, 'Number(lines) || 300');
  const scopes = ok<LogScopeChange>('GET', 'log/scopes');
  assert.deepEqual(scopes.boot, ['info']);
  assert.deepEqual(scopes.extra, ['tracker_events']);
  refused('POST', 'log/scopes', { scopes: 'debug' }, 400, '"scopes" must be an array of log scope names');
  const raised = ok<LogScopeChange>('POST', 'log/scopes', { scopes: ['dht_debug', 'debug', 'nonsense'] });
  assert.deepEqual(raised.extra, ['debug']);
  assert.deepEqual(raised.failed, ['dht_debug']);
  assert.deepEqual(raised.stillActive, ['tracker_events']);
  const lowered = ok<LogScopeChange>('POST', 'log/scopes', { scopes: [] });
  assert.deepEqual(lowered.extra, []);
  assert.deepEqual(lowered.stillActive, ['debug']);
});

test('the API console: commands that answer from the session, rtorrent\'s faults for the rest', () => {
  const { ok, refused, named } = setup();
  const rpc = (method: string, params?: unknown[]) => ok<{ ok: boolean; result?: unknown; fault?: { code: number; message: string } }>(
    'POST', 'rpc', params === undefined ? { method } : { method, params });
  const methods = ok<{ methods: string[] }>('GET', 'rpc/methods').methods;
  assert.deepEqual(methods, [...methods].sort());
  assert.deepEqual(rpc('system.listMethods'), { ok: true, result: methods });
  assert.deepEqual(rpc('system.client_version'), { ok: true, result: '0.16.24' });
  assert.deepEqual(rpc('system.listMethodz'), { ok: false, fault: { code: -506, message: "Method 'system.listMethodz' not defined" } });
  const ubuntu = named('ubuntu');
  assert.deepEqual(rpc('d.name', [ubuntu.hash]), { ok: true, result: ubuntu.name });
  assert.deepEqual(rpc('d.name', []), { ok: false, fault: { code: -503, message: 'Target of wrong type to generic command.' } });
  assert.deepEqual(rpc('d.name', [UNKNOWN]), { ok: false, fault: { code: -503, message: 'invalid parameters: info-hash not found' } });
  const rows = rpc('d.multicall2', ['', 'main', 'd.hash=', 'd.size_bytes=']).result as Array<[string, number]>;
  assert.equal(rows.length, ok<StateResponse>('GET', 'state').torrents.length);
  assert.ok(rows.some(([hash, size]) => hash === ubuntu.hash && size === ubuntu.size));
  assert.deepEqual(rpc('d.multicall2', ['', 'nosuchview', 'd.name=']).fault, { code: -503, message: 'Could not find view.' });
  assert.deepEqual(rpc('d.multicall2', ['', 'main', 'd.nosuch=']).fault, { code: -503, message: 'Command "d.nosuch" does not exist.' });
  assert.deepEqual(rpc('throttle.global_down.max_rate.set', [0]).fault, { code: -503, message: 'invalid parameters: target must be a string' });
  assert.deepEqual(rpc('throttle.global_down.max_rate.set', ['', 524288]), { ok: true, result: 0 });
  assert.equal(ok<Record<string, unknown>>('GET', 'settings').downloadRate, 524288);
  assert.deepEqual(rpc('d.stop', [ubuntu.hash]), { ok: true, result: 0 });
  assert.equal(named('ubuntu').status, 'paused', 'd.stop alone leaves the download open');
  // Refusals in rtorrent's own words.
  const fault = (method: string, params: unknown[]) => rpc(method, params).fault?.message;
  assert.equal(fault('d.multicall2', ['', 'main', 'd.name']), "Could not find '=' in command 'd.name'.");
  assert.equal(fault('d.custom1.set', [ubuntu.hash]), 'Wrong object type: expected: string actual: none');
  assert.equal(fault('d.custom1.set', [ubuntu.hash, 5]), 'Wrong object type: expected: string actual: value');
  assert.equal(fault('d.priority.set', [ubuntu.hash, 'abc']), 'Not a value.');
  assert.equal(fault('d.uploads_max.set', [ubuntu.hash, -1]), 'Max uploads must be between 0 and 2^16.');
  assert.equal(fault('d.tracker.insert', [ubuntu.hash, '0']), 'Wrong argument count.');
  assert.equal(fault(`f.priority.set`, [`${ubuntu.hash}:f0`, 7]), 'Invalid value.');
  assert.equal(fault('f.path', [`${ubuntu.hash}:f9`]), 'invalid parameters: index not found');
  assert.equal(fault('protocol.encryption.set', ['', 'bogus']), "Invalid encryption option: 'bogus'");
  assert.equal(fault('log.add_output', ['', 'dht_debug', 'cascade']), "invalid option name : enum:11 name:'dht_debug'");
  // rtorrent keeps a priority's low two bits.
  rpc('d.priority.set', [ubuntu.hash, 9]);
  assert.equal(named('ubuntu').priority, 1);

  assert.deepEqual(ok('POST', 'rpc/help', { method: 'system.listMethods' }), {
    method: 'system.listMethods', help: 'Return an array of all available XML-RPC methods on this server.', signature: [['array']],
  });
  assert.deepEqual(ok('POST', 'rpc/help', { method: 'd.name' }), { method: 'd.name', help: 'No help is available for this method.', signature: 'undef' });
  assert.deepEqual(ok('POST', 'rpc/help', { method: 'nope.nothing' }), { method: 'nope.nothing', help: '', signature: '' });
  refused('POST', 'rpc', { method: '' }, 400, '"method" must be a non-empty string');
  refused('POST', 'rpc', { method: 'd.name', params: 'x' }, 400, '"params" must be an array');
});
