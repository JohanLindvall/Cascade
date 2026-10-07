// SPDX-License-Identifier: MIT

/**
 * The simulated server route by route: the shapes the UI reads, the checks the
 * Go server makes and the words it refuses with, and rtorrent's own faults
 * relayed as the server relays them — a 502 with the fault, or a bulk route's
 * per-hash error. The messages here were taken from a running 0.16.25, which
 * words them as 0.16.24 did but for the value checks it added.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LogScopeChange, StateResponse, Torrent, TorrentFile, Tracker, UploadResult } from '../contracts.ts';
import { FETCHING_METADATA, dataFolder, sharedDataFolder } from '../dataFolder.ts';
import { DEFAULT_PREFERENCES } from '../preferences.ts';
import { DEFAULT_POLL_MS, DemoServer, type DemoRequest, type DemoResponse, type UploadPart } from './backend.ts';
import { ManualClock, torrentFile } from './fixtures.ts';

const START = Date.UTC(2026, 9, 6, 19, 0, 0) + 503;
const UNKNOWN = '0000000000000000000000000000000000000000';

function setup() {
  const clock = new ManualClock(START);
  const saved: unknown[] = [];
  const server = new DemoServer({
    now: () => clock.now, timers: clock, seed: 5, version: '0.16.25', onPreferences: (prefs) => saved.push(prefs),
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
  assert.equal(state.status.backend.clientVersion, '0.16.25');
  assert.equal(state.status.backend.libraryVersion, '0.16.25');
  // What a real 0.16.25 has no working setter for, so the dialog greys out or hides the same controls.
  const { supports } = state.status.backend;
  assert.deepEqual(Object.keys(supports).filter((key) => !supports[key]).sort(), [
    'dhtPort', 'maxHttpOpen', 'maxOpenFiles', 'portOpen', 'sessionDirectory', 'udpTrackers',
  ]);
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
  const { ok, refused, named } = setup();
  const hash = named('ubuntu').hash;
  refused('PATCH', `torrents/${hash}`, { priority: 7 }, 400, '"priority" must be a whole number from 0 to 3');
  refused('PATCH', `torrents/${hash}`, { priority: null }, 400, '"priority" must be a whole number from 0 to 3');
  refused('PATCH', `torrents/${hash}`, { label: 5 }, 400, '"label" must be a string');
  refused('PATCH', `torrents/${hash}`, { label: 'ok', directory: '' }, 400, '"directory" must be a non-empty string');
  assert.equal(named('ubuntu').label, 'linux', 'a refused patch changed a field before the bad one');
  // rtorrent's own bound on slots: refused by the setter, the other one of the pair applied.
  refused('PATCH', `torrents/${hash}`, { maxUploads: 70_000, maxDownloads: 9 }, 502, 'd.uploads_max.set: Max uploads must be between 0 and 2^16.');
  refused('PATCH', `torrents/${hash}`, { maxDownloads: 65_537 }, 502, 'd.downloads_max.set: Max downloads must be between 0 and 2^16.');
  ok('PATCH', `torrents/${hash}`, { maxUploads: 65_536 });
  const slots = (command: string) => ok<{ result: unknown }>('POST', 'rpc', { method: command, params: [hash] }).result;
  assert.deepEqual([slots('d.uploads_max'), slots('d.downloads_max')], [65_536, 9]);
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
  // libtorrent froze the paths when it last opened the torrent; they move with the next open.
  assert.equal(t.basePath, '/downloads/Sintel (2010)');
  ok('POST', `torrents/${hash}/action/start`);
  assert.equal(named('Sintel').basePath, '/downloads/films/Sintel (2010)');

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

test('a directory change takes the directory the data goes into, as an add does', () => {
  const { ok, named, torrents } = setup();
  const rpc = (method: string, ...params: unknown[]) => ok('POST', 'rpc', { method, params });
  const bunny = named('Big Buck Bunny');
  const ubuntu = named('ubuntu');
  const byHash = new Map(torrents().map((t) => [t.hash, t]));
  // A multi-file torrent's folder is inside it, so the two share one.
  assert.equal(bunny.directory, '/downloads/Big Buck Bunny');
  assert.equal(sharedDataFolder(byHash, [bunny.hash, ubuntu.hash]), '/downloads');

  // What the prompt offers, sent back as it is: nothing changes, nothing even stops.
  for (const before of [bunny, ubuntu]) {
    ok('PATCH', `torrents/${before.hash}`, { directory: dataFolder(before) });
    const after = named(before.name);
    assert.deepEqual([after.directory, after.status], [before.directory, before.status]);
  }

  // A new one: the file goes into it, the multi-file torrent's folder inside it.
  for (const t of [bunny, ubuntu]) ok('PATCH', `torrents/${t.hash}`, { directory: '/media/new/' });
  assert.equal(named('ubuntu').directory, '/media/new');
  const moved = named('Big Buck Bunny');
  assert.deepEqual([moved.directory, moved.status], ['/media/new/Big Buck Bunny', 'stopped']);
  // libtorrent froze the paths when it last opened the torrent; they move with the next open.
  assert.equal(moved.basePath, '/downloads/Big Buck Bunny');
  ok('POST', `torrents/${bunny.hash}/action/start`);
  assert.equal(named('Big Buck Bunny').basePath, '/media/new/Big Buck Bunny');

  // A folder named otherwise, as d.directory_base.set leaves one, keeps its name.
  const cosmos = named('Cosmos');
  rpc('d.directory_base.set', cosmos.hash, '/downloads/Cosmos/');
  assert.equal(named('Cosmos').directory, '/downloads/Cosmos');
  ok('PATCH', `torrents/${cosmos.hash}`, { directory: dataFolder(named('Cosmos')) });
  assert.equal(named('Cosmos').directory, '/downloads/Cosmos');
  ok('PATCH', `torrents/${cosmos.hash}`, { directory: '/media/films' });
  assert.equal(named('Cosmos').directory, '/media/films/Cosmos');
  ok('POST', `torrents/${cosmos.hash}/action/start`);
  assert.deepEqual(rpc('d.base_filename', cosmos.hash), { ok: true, result: 'Cosmos' });
  ok('POST', `torrents/${cosmos.hash}/action/stop`);
  // d.directory.set names it after the torrent again, inside what it is given:
  // given d.directory, the torrent's own folder, it nests.
  rpc('d.directory.set', cosmos.hash, named('Cosmos').directory);
  assert.equal(named('Cosmos').directory, '/media/films/Cosmos/Cosmos Laundromat (2015)');
});

test('a directory change reads the directory above a folder without trailing slashes, as the server does', () => {
  const { ok, named } = setup();
  const rpc = (method: string, ...params: unknown[]) => ok('POST', 'rpc', { method, params });
  // Typed with a doubled trailing slash, the directory is sent without it.
  const bunny = named('Big Buck Bunny');
  ok('PATCH', `torrents/${bunny.hash}`, { directory: '/media/new//' });
  assert.equal(named('Big Buck Bunny').directory, '/media/new/Big Buck Bunny');
  // A root set with one leaves its folder in the directory without it: what
  // the prompt offers changes nothing, and a running torrent keeps running.
  const cosmos = named('Cosmos');
  ok('POST', `torrents/${cosmos.hash}/action/stop`);
  rpc('d.directory_base.set', cosmos.hash, '/downloads//Cosmos');
  ok('POST', `torrents/${cosmos.hash}/action/start`);
  const before = named('Cosmos');
  assert.notEqual(before.status, 'stopped');
  assert.equal(dataFolder(before), '/downloads');
  ok('PATCH', `torrents/${cosmos.hash}`, { directory: dataFolder(before) });
  const after = named('Cosmos');
  assert.deepEqual([after.directory, after.status], [before.directory, before.status]);
});

const CLAPPER = '🎬';
const BEYOND = `contains "${CLAPPER}" (U+1F3AC): rtorrent's XML-RPC layer takes no character beyond U+FFFF, such as an emoji`;
const ROOT = '"directory" cannot be "/": rtorrent strips a directory\'s trailing slashes and would put a single file in ".", the directory it runs in';

test('a directory change refuses what rtorrent cannot take before the torrent stops: an emoji, the root', () => {
  const { ok, refused, named } = setup();
  const before = named('ubuntu');
  assert.equal(before.status, 'seeding');
  refused('PATCH', `torrents/${before.hash}`, { priority: 0, directory: `/media/films ${CLAPPER}` }, 400, `"directory" ${BEYOND}`);
  refused('PATCH', `torrents/${before.hash}`, { directory: '/' }, 400, ROOT);
  refused('PATCH', `torrents/${before.hash}`, { directory: ' // ' }, 400, ROOT);
  refused('PATCH', `torrents/${before.hash}`, { directory: '/media\r\nfilms' }, 400, '"directory" contains a carriage return, which XML reads as a line feed');
  refused('PATCH', `torrents/${before.hash}`, { throttle: `slow ${CLAPPER}` }, 400, `"throttle" ${BEYOND}`);
  const after = named('ubuntu');
  assert.deepEqual([after.status, after.directory, after.priority], [before.status, before.directory, before.priority]);
  // A label goes URL-encoded, whatever it holds.
  ok('PATCH', `torrents/${before.hash}`, { label: `linux ${CLAPPER}` });
  assert.equal(named('ubuntu').label, `linux ${CLAPPER}`);
});

test('a magnet still fetching its metadata keeps the directory it was added with: refused, running on', () => {
  const { ok, refused, named, clock } = setup();
  ok('POST', 'torrents/url', { url: 'magnet:?xt=urn:btih:89abcdef0123456789abcdef0123456789abcdef&dn=open-movie.mkv', directory: '/downloads/fromadd' });
  const meta = named('89ABCDEF0123456789ABCDEF0123456789ABCDEF.meta');
  assert.deepEqual([meta.isMeta, meta.status], [true, 'downloading']);
  refused('PATCH', `torrents/${meta.hash}`, { directory: '/media' }, 409, FETCHING_METADATA);
  assert.deepEqual([named(meta.name).status, named(meta.name).directory], [meta.status, meta.directory]);
  // Refused before the fields ahead of it change: a 409 must not follow a change, which no page would be told of.
  refused('PATCH', `torrents/${meta.hash}`, { priority: 0, label: 'changed', throttle: 'slow', directory: '/media' }, 409,
    FETCHING_METADATA);
  const still = named(meta.name);
  assert.deepEqual([still.priority, still.label, still.throttle, still.status, still.directory],
    [meta.priority, meta.label, meta.throttle, meta.status, meta.directory]);
  assert.notEqual(meta.priority, 0);
  // Once the metadata is in, rtorrent has loaded the torrent with the add's directory, and it moves.
  clock.advance(8000);
  const fetched = named('open-movie.mkv');
  assert.deepEqual([fetched.hash, fetched.isMeta, fetched.directory], [meta.hash, false, '/downloads/fromadd']);
  ok('PATCH', `torrents/${fetched.hash}`, { directory: '/media' });
  assert.deepEqual([named('open-movie.mkv').directory, named('open-movie.mkv').status], ['/media', 'stopped']);
});

test('an add refuses a directory or a link rtorrent cannot take, the whole batch before any of it', () => {
  const { ok, call, refused, upload, torrents, named } = setup();
  const count = torrents().length;
  const file = { name: 'torrents', filename: 'held.torrent', data: torrentFile({ name: 'held.iso', length: 20_000 }) };
  const magnet = 'magnet:?xt=urn:btih:1123456789abcdef0123456789abcdef01234567';
  for (const [parts, error] of [
    [[file, { name: 'directory', value: `/downloads/${CLAPPER}` }], `"directory" ${BEYOND}`],
    [[file, { name: 'directory', value: '/' }], ROOT],
    [[file, { name: 'urls', value: `https://example.org/a.torrent\n${magnet}&dn=${CLAPPER}` }], `"urls" ${BEYOND}`],
  ] as Array<[UploadPart[], string]>) {
    const answer = upload(parts);
    assert.deepEqual([answer.status, answer.body], [400, { error }]);
  }
  assert.equal(torrents().length, count, 'a refused batch added something');
  refused('POST', 'torrents/url', { url: `${magnet}&dn=${CLAPPER}` }, 400, `"url" ${BEYOND}`);
  refused('POST', 'torrents/url', { url: magnet, directory: '//' }, 400, ROOT);
  const hash = named('ubuntu').hash;
  refused('POST', `torrents/${hash}/trackers`, { url: `udp://tracker.example.org:6969/${CLAPPER}` }, 400, `"url" ${BEYOND}`);
  const view = call('GET', 'torrents', undefined, `view=${encodeURIComponent(CLAPPER)}`);
  assert.deepEqual([view.status, view.body], [400, { error: `"view" ${BEYOND}` }]);
  assert.equal(torrents().length, count);
  // No directory, or an empty one, is rtorrent's default.
  const added = upload([file, { name: 'directory', value: '' }, { name: 'start', value: '0' }]);
  assert.deepEqual((added.body as UploadResult).errors, []);
  assert.equal(named('held.iso').directory, '/downloads');
  ok('POST', 'torrents/url', { url: `${magnet}&dn=quiet.iso`, directory: '  ', start: false });
  assert.equal(named('1123456789ABCDEF0123456789ABCDEF01234567.meta').directory, '/config/session');
});

test('a setting\'s text rtorrent cannot take is refused by name, and the patch with it', () => {
  const { ok, refused } = setup();
  const before = ok<Record<string, unknown>>('GET', 'settings');
  refused('POST', 'settings', { pex: !before.pex, directory: `/downloads/${CLAPPER}` }, 400, `"directory" ${BEYOND}`);
  refused('POST', 'settings', { encryption: `allow_incoming,${CLAPPER}` }, 400, `"encryption" ${BEYOND}`);
  assert.deepEqual(ok('GET', 'settings'), before);
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
  // What is checked is d.base_path, which moves only when the torrent is opened there.
  assert.equal(named('Cosmos').basePath, '/downloads/Cosmos Laundromat (2015)');
  ok('POST', `torrents/${cosmos.hash}/action/start`);
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
  assert.ok(!('portOpen' in settings), '0.16 has no network.port_open');
  assert.equal(settings.maxHttpOpen, 32);
  refused('POST', 'settings', { maxPeers: 10, downloadRate: -5 }, 400, '"downloadRate" must be a whole number from 0 to 4294966272');
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
  // A key the release has no working setter for is skipped, as the server's table skips it —
  // the open-file limit, the DHT port and the UDP tracker switch included, whose setters
  // 0.16.15, 0.16.1 and 0.16.12 still list but ignore.
  ok('POST', 'settings', { maxHttpOpen: 40, portOpen: false, maxOpenFiles: 1234, dhtPort: 7000, udpTrackers: false });
  const after = ok<Record<string, unknown>>('GET', 'settings');
  assert.equal(after.maxHttpOpen, 32);
  assert.equal(after.maxOpenFiles, 128);
  assert.equal(after.dhtPort, 50_000, 'the running DHT has the listening port');
  assert.equal(after.udpTrackers, true);
  assert.ok(!('portOpen' in after));
});

test('settings: the torrent-name switches of 0.16.22 and 0.16.25, on by default, set alike from the dialog and the console', () => {
  const { ok, call } = setup();
  const rpc = (method: string, params: unknown[]) => ok<{ ok: boolean; result?: unknown; fault?: { code: number; message: string } }>(
    'POST', 'rpc', { method, params });
  const { supports } = ok<StateResponse>('GET', 'state').status.backend;
  assert.equal(supports.useSanitizedName, true);
  assert.equal(supports.allowLegacyUtf8, true);
  const settings = ok<Record<string, unknown>>('GET', 'settings');
  assert.deepEqual([settings.useSanitizedName, settings.allowLegacyUtf8], [true, true]);
  const updated = ok<Record<string, unknown>>('POST', 'settings', { useSanitizedName: false, allowLegacyUtf8: 'off' });
  assert.deepEqual([updated.useSanitizedName, updated.allowLegacyUtf8], [false, false]);
  assert.equal(call('POST', 'settings', { allowLegacyUtf8: 2 }).status, 400);
  assert.deepEqual(rpc('system.file_name.allow_legacy_utf8', ['']), { ok: true, result: 0 });
  // rtorrent keeps any value but 0 as on.
  assert.deepEqual(rpc('system.file_name.allow_legacy_utf8.set', ['', 2]), { ok: true, result: 0 });
  assert.deepEqual(rpc('system.file_name.allow_legacy_utf8', ['']), { ok: true, result: 1 });
  assert.equal(ok<Record<string, unknown>>('GET', 'settings').allowLegacyUtf8, true);
  // In 0.16.25's words: a value that is not one, one with a sign 0.16.25 no longer reads, and none at all.
  assert.deepEqual(rpc('system.file_name.allow_legacy_utf8.set', ['', 'abc']).fault, { code: -503, message: 'Not a value.' });
  assert.deepEqual(rpc('system.torrent_name.use_sanitized.set', ['', '+1']).fault, { code: -503, message: 'Not a value.' });
  assert.deepEqual(rpc('system.torrent_name.use_sanitized.set', ['']).fault, {
    code: -503, message: 'Wrong object type: expected: value actual: none',
  });
  assert.deepEqual(rpc('system.torrent_name.use_sanitized', ['']), { ok: true, result: 0 });
});

test('settings: a global rate is kept in whole KiB/s under 4 GiB/s and a DHT port in 16 bits, as 0.16.25 checks them', () => {
  const { ok, refused } = setup();
  const rpc = (method: string, params: unknown[]) => ok<{ ok: boolean; result?: unknown; fault?: { code: number; message: string } }>(
    'POST', 'rpc', { method, params });
  const setting = (key: string) => ok<Record<string, unknown>>('GET', 'settings')[key];
  // Rounded up to whole KiB/s, where rtorrent would drop 800 B/s to 0: unlimited.
  assert.equal(ok<Record<string, unknown>>('POST', 'settings', { downloadRate: 800 }).downloadRate, 1024);
  assert.equal(ok<Record<string, unknown>>('POST', 'settings', { uploadRate: 1025 }).uploadRate, 2048);
  assert.equal(ok<Record<string, unknown>>('POST', 'settings', { downloadRate: 4_294_966_272 }).downloadRate, 4_294_966_272);
  refused('POST', 'settings', { downloadRate: 4_294_966_273 }, 400, '"downloadRate" must be a whole number from 0 to 4294966272');
  refused('POST', 'settings', { dhtOverridePort: 65_536 }, 400, '"dhtOverridePort" must be a whole number from 0 to 65535');
  // The console reaches rtorrent's own checks and its truncation to whole KiB/s.
  assert.deepEqual(rpc('throttle.global_down.max_rate.set', ['', 4_294_967_295]).fault, {
    code: -503, message: 'Throttle rate must be between 0 and 4294967294.',
  });
  assert.deepEqual(rpc('throttle.global_down.max_rate.set', ['', 4_294_967_294]), { ok: true, result: 0 });
  assert.deepEqual(rpc('throttle.global_down.max_rate', ['']), { ok: true, result: 4_294_966_272 });
  assert.deepEqual(rpc('throttle.global_up.max_rate.set', ['', 1000]), { ok: true, result: 0 });
  assert.equal(setting('uploadRate'), 0, 'rtorrent drops a fraction of a KiB, down to unlimited');
  assert.deepEqual(rpc('dht.override_port.set', ['', 65_536]).fault, { code: -503, message: 'Invalid DHT override port number.' });
  assert.deepEqual(rpc('dht.override_port.set', ['', 6882]), { ok: true, result: 0 });
  assert.equal(setting('dhtOverridePort'), 6882);
});

test('settings: what 0.16.25 refuses, in its words, and what it takes, as it reads it back', () => {
  const { ok, refused } = setup();
  const before = ok<Record<string, unknown>>('GET', 'settings');
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ memoryMax: 536_870_911 }, 'pieces.memory.max.set: set_max_memory_usage: memory limit too low, must be at least 512 MB : 536870911'],
    [{ syncTimeout: 3601 }, 'pieces.sync.timeout.set: set_timeout_sync: invalid timeout, must be between 0 and 3600 seconds : 3601'],
    [{ preloadType: 3 }, 'pieces.preload.type.set: set_preload_type: invalid type : 3'],
    [{ preloadMinSize: 1023 }, 'pieces.preload.min_size.set: set_preload_min_size: invalid size, must be at least 1 KB : 1023'],
    [{ preloadMinRate: 1023 }, 'pieces.preload.min_rate.set: set_preload_required_rate: invalid rate, must be at least 1 KB/s : 1023'],
    [{ maxOpenSockets: 511 }, 'network.max_open_sockets.set: set_max_size_and_adjust: max_open too low, minimum is 512'],
    [{ xmlrpcSizeLimit: 1023 }, 'network.xmlrpc.size_limit.set: XMLRPC size limit is too small to hold a request.'],
    [{ xmlrpcSizeLimit: 67_108_865 }, 'network.xmlrpc.size_limit.set: XMLRPC size limit cannot exceed the SCGI content size limit.'],
    [{ portRange: '0-10' }, 'network.listen.port.range.set: Invalid listen port range.'],
    [{ portRange: '7000-6000' }, 'network.listen.port.range.set: Invalid listen port range.'],
    [{ portRange: '70000-70001' }, 'network.listen.port.range.set: Port range out-of-bounds.'],
    [{ bindAddress: 'not-an-address' }, 'network.bind_address.set: Could not get address info: not-an-address: Name does not resolve'],
    [{ bindAddress: '::1' }, 'network.bind_address.set: Tried to set a bind address that is not an unspec/inet address.'],
    [{ bindAddress: 'localhost' }, 'network.bind_address.set: Tried to set a bind address that is not an unspec/inet address.'],
    [{ bindAddressV4: '::1' }, 'network.bind_address.ipv4.set: Could not get address info: ::1: Name has no usable address'],
    [{ bindAddressV6: '127.0.0.1' }, 'network.bind_address.ipv6.set: Could not get address info: 127.0.0.1: Name has no usable address'],
    [{ localAddress: '' }, 'network.local_address.set: Tried to set local address to an any address.'],
    [{ localAddress: 'not-an-address' }, 'network.local_address.set: Could not get address info: not-an-address: Name does not resolve'],
    [{ proxyAddress: 'bogus' }, 'network.http.proxy_address.set: Unsupported proxy scheme: '],
    [{ proxyHttp: '' }, 'network.proxy.http.set: Unsupported proxy scheme: '],
    [{ proxyHttp: 'ftp://10.0.0.1:21' }, 'network.proxy.http.set: Unsupported proxy scheme: ftp'],
    [{ proxyGlobal: 'bogus' }, 'network.proxy.global.set: Proxy address must include a scheme.'],
    [{ proxyGlobal: 'http://10.0.0.1' }, 'network.proxy.global.set: Proxy address must include a port.'],
    [{ proxyGlobal: 'ftp://10.0.0.1:21' }, 'network.proxy.global.set: Unsupported proxy scheme: ftp'],
    [{ dhtMode: 'bogus' }, 'dht.mode.set: Invalid dht mode: bogus'],
  ];
  for (const [body, error] of cases) assert.equal(refused('POST', 'settings', body, 502, error).faultCode, -503);
  // 0.16.24 and 0.16.25 die on a global proxy named by host or by IPv6 address,
  // so the server refuses one before it is sent; the console, which sends it,
  // gives the refusal rtorrent's code means.
  const crashes = '"proxyGlobal" must give the proxy by its IPv4 address: rtorrent crashes on a host name or an IPv6 address there';
  for (const proxyGlobal of ['http://proxy.example.org:3128', 'socks5://[::1]:1080', 'http:///localhost:3128']) {
    refused('POST', 'settings', { proxyGlobal }, 400, crashes);
  }
  const viaConsole = ok<{ fault?: { message: string } }>('POST', 'rpc', { method: 'network.proxy.global.set', params: ['', 'socks5://[::1]:1080'] });
  assert.equal(viaConsole.fault?.message, 'Proxy address numeric lookup failed: [::1]');
  assert.deepEqual(ok('GET', 'settings'), before, 'a refused value was kept');

  const taken = ok<Record<string, unknown>>('POST', 'settings', {
    memoryMax: 536_870_912, syncTimeout: 3600, preloadType: 2, maxOpenSockets: 512, portRange: '6881-6889x', encryption: 'require_RC4,bogus',
    bindAddress: '0.0.0.0', bindAddressV4: '', bindAddressV6: '::1', localAddress: '192.0.2.10', proxyHttp: 'http://proxy.example.org:3128',
    proxyGlobal: 'socks5://10.0.0.1:1080',
  });
  assert.equal(taken.portRange, '6881-6889', 'sscanf reads two numbers and ignores the rest');
  assert.equal(taken.memoryMax, 536_870_912);
  assert.equal(taken.bindAddressV6, '::1');
  assert.equal(taken.proxyAddress, 'http://proxy.example.org:3128', '0.16 keeps the HTTP proxy under both names');
  assert.equal(taken.proxyGlobal, 'socks5://10.0.0.1:1080');
  assert.equal(ok<Record<string, unknown>>('POST', 'settings', { proxyGlobal: '' }).proxyGlobal, '');
});

test('settings: a patch is one multicall — every setter runs, and the first refusal in the table\'s order is reported', () => {
  const { ok, refused } = setup();
  refused('POST', 'settings', { downloadRate: 123_904, encryption: 'bogus', checkHashOnCompletion: false }, 502,
    "protocol.encryption.set: Invalid encryption option: 'bogus'");
  const settings = ok<Record<string, unknown>>('GET', 'settings');
  assert.equal(settings.downloadRate, 123_904);
  assert.equal(settings.checkHashOnCompletion, false, 'a setter after the refused one ran too');
  refused('POST', 'settings', { syncTimeout: 4000, memoryMax: 1, pex: false }, 502,
    'pieces.memory.max.set: set_max_memory_usage: memory limit too low, must be at least 512 MB : 1');
  assert.equal(ok<Record<string, unknown>>('GET', 'settings').pex, false);
});

test('dht.statistics: the shape 0.16 answers, and the routing table size the status reports from it', () => {
  const { ok } = setup();
  const statistics = () => ok<{ ok: boolean; result: Record<string, unknown> }>('POST', 'rpc', { method: 'dht.statistics' }).result;
  const running = statistics();
  assert.deepEqual(Object.keys(running).sort(), [
    'active', 'buckets', 'bytes_read', 'bytes_written', 'cycle', 'dht', 'errors_caught', 'errors_received', 'nodes', 'peers',
    'peers_max', 'queries_received', 'queries_sent', 'replies_received', 'throttle', 'torrents',
  ]);
  assert.equal(running.active, 1);
  assert.ok(Number(running.nodes) > 0 && Number(running.nodes) <= 8 * Number(running.buckets));
  assert.deepEqual([running.bytes_read, running.bytes_written], [0, 0], '0.16 no longer counts them');
  assert.equal(ok<StateResponse>('GET', 'state').status.dhtNodes, running.nodes);
  // Stopped, rtorrent leaves the counters out, and the status reads no nodes.
  ok('POST', 'settings', { dhtMode: 'off' });
  assert.deepEqual(statistics(), { active: 0, dht: 'off', throttle: '' });
  assert.equal(ok<StateResponse>('GET', 'state').status.dhtNodes, 0);
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
  assert.deepEqual(rpc('system.client_version'), { ok: true, result: '0.16.25' });
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
  assert.equal(fault('protocol.encryption.set', ['']), 'No encryption options specified.');
  assert.equal(fault('network.listen.port.range.set', ['', '70000-70001']), 'Port range out-of-bounds.');
  // 0.16 keeps the old HTTP limit's setter and the open-file limit's as ones that only warn,
  // and has no port_open at all.
  assert.deepEqual(rpc('network.http.max_total_connections.set', ['', 40]), { ok: true, result: 0 });
  assert.equal(rpc('network.http.max_total_connections').result, 32);
  assert.ok(ok<{ lines: string[] }>('GET', 'log', undefined, 'lines=5').lines.some((line) =>
    / W network\.http\.max_total_connections\.set is deprecated, use system\.sockets\.http\.min_alloc\.set instead\.$/.test(line)));
  assert.deepEqual(rpc('network.max_open_files.set', ['', 1234]), { ok: true, result: 0 });
  assert.equal(rpc('network.max_open_files').result, 128);
  assert.ok(ok<{ lines: string[] }>('GET', 'log', undefined, 'lines=5').lines.some((line) =>
    / W network\.max_open_files\.set is deprecated, use system\.sockets\.files\.min_alloc\.set instead\.$/.test(line)));
  assert.equal(fault('network.max_open_files.set', ['', 'abc']), 'Not a value.');
  assert.equal(rpc('network.port_open').fault?.code, -506);
  // And the DHT port's and the UDP tracker switch's, which take a value and change nothing: dht.port
  // is the running DHT's (the listening port, 0 while DHT is off), and UDP trackers stay on.
  assert.deepEqual(rpc('dht.port.set', ['', 7000]), { ok: true, result: 0 });
  assert.equal(rpc('dht.port').result, 50_000);
  assert.equal(fault('dht.port.set', ['', 'abc']), 'Not a value.');
  assert.deepEqual(rpc('trackers.use_udp.set', ['', 0]), { ok: true, result: 0 });
  assert.equal(rpc('trackers.use_udp').result, 1);
  assert.ok(ok<{ lines: string[] }>('GET', 'log', undefined, 'lines=5').lines.some((line) =>
    / E trackers\.use_udp\.set is no longer supported$/.test(line)));
  rpc('dht.mode.set', ['', 'off']);
  assert.equal(rpc('dht.port').result, 0);
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
