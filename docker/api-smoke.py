#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Exercise a disposable Cascade container against the rtorrent inside it.

usage: python3 docker/api-smoke.py <base-url>[/base-path] [container]

What it holds the image to: readiness, the XML-RPC passthrough, validation and
error shapes, the cross-site guard, compression and caching headers, setting
and throttle round trips in rtorrent's own units, a setting offered only where
its setter works, which names the legacy-name switch saves a torrent under,
the state stream, the libtorrent path patch (a torrent named past Linux's
255-byte limit must start), deleting the data of a torrent whose name is not
UTF-8, and a directory change, which must not nest a multi-file torrent inside
its own folder. Given the container's name it gives up as soon as the container
exits rather than waiting out the readiness timeout, and looks at its disk
where a check needs to; without it, such a check is skipped.

Standard library only. It restores what it changes and removes what it adds,
but it does change a live rtorrent: point it at a disposable container.
"""
import gzip
import hashlib
import http.client
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib

READY_SECONDS = 90


class Cascade:
    def __init__(self, base, container=None):
        self.base = base.rstrip('/')
        self.container = container

    def fetch(self, path, data=None, method=None, headers=None):
        """(status, headers, raw body) of one request, errors included."""
        request = urllib.request.Request(self.base + path, data, headers or {}, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=40)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def api(self, path, data=None, method=None, expected=200, headers=None):
        payload = None if data is None else json.dumps(data).encode()
        all_headers = {'content-type': 'application/json', **(headers or {})}
        status, _, body = self.fetch(path, payload, method, all_headers)
        assert status == expected, (method or 'GET', path, status, body[:300])
        return json.loads(body) if body else None

    def rpc(self, method, *params):
        reply = self.api('/api/rpc', {'method': method, 'params': params})
        assert reply['ok'], reply
        return reply['result']

    def run(self, *argv, user=None):
        """A command's output in the container, as bytes. Arguments travel to
        Docker as JSON strings, so bytes that are not UTF-8 have to come from
        the command itself, never from an argument."""
        command = ['docker', 'exec', *(['-u', user] if user else []), self.container, *argv]
        return subprocess.run(command, capture_output=True, check=True).stdout

    def names(self, directory):
        """The entries of a directory in the container, as the bytes on disk."""
        listing = self.run('sh', '-c', 'for f in "$1"/* "$1"/.[!.]*; do [ -e "$f" ] || [ -L "$f" ] && '
                           'printf "%s\\0" "${f##*/}"; done; true', 'sh', directory)
        return set(name for name in listing.split(b'\0') if name)

    def alive(self):
        if not self.container:
            return True
        state = subprocess.run(['docker', 'inspect', '-f', '{{.State.Running}}', self.container],
                               capture_output=True, text=True)
        return state.stdout.strip() == 'true'

    def wait_ready(self):
        deadline = time.monotonic() + READY_SECONDS
        while time.monotonic() < deadline:
            assert self.alive(), f'the container {self.container} exited'
            try:
                if self.api('/api/state')['status']['connected']:
                    return
            except (OSError, AssertionError, ValueError):
                pass
            time.sleep(1)
        raise AssertionError(f'Cascade did not become ready within {READY_SECONDS} seconds')


def check_basics(cascade):
    version = cascade.api('/api/capabilities')['clientVersion']
    assert version == cascade.rpc('system.client_version')
    assert cascade.api('/healthz')['ok']
    call = (b'<?xml version="1.0"?><methodCall><methodName>system.client_version'
            b'</methodName></methodCall>')
    status, _, body = cascade.fetch('/RPC2', call, 'POST', {'content-type': 'text/xml'})
    assert status == 200 and f'<string>{version}</string>'.encode() in body, (status, body[:300])
    return version


def check_refusals(cascade):
    cascade.api('/api/torrents/action/stop', {'hashes': ['invalid']}, expected=400)
    cascade.api('/api/settings', {'downloadRate': None}, expected=400)
    # rtorrent crashes on a global proxy named by host (AGENTS.md quirk 14).
    if cascade.api('/api/capabilities')['supports']['proxyGlobal']:
        pid = cascade.rpc('system.pid')
        cascade.api('/api/settings', {'proxyGlobal': 'socks5://localhost:1080'}, expected=400)
        assert cascade.rpc('system.pid') == pid, 'rtorrent restarted'
    missing = cascade.api('/api/nothing/here', expected=404)
    assert 'no such endpoint' in missing['error'], missing
    # A write another site made the browser send is refused before anything else.
    refused = cascade.api('/api/torrents/action/stop', {'hashes': ['A' * 40]}, expected=403,
                          headers={'sec-fetch-site': 'cross-site', 'origin': 'https://evil.example'})
    assert refused == {'error': 'cross-site request refused'}, refused


def check_page_and_headers(cascade):
    status, headers, body = cascade.fetch('/')
    page = body.decode()
    assert status == 200 and '<title>Cascade</title>' in page, (status, page[:200])
    # The shell revalidates on every load; the hashed assets it names never do.
    assert headers['cache-control'] == 'no-cache', headers['cache-control']
    script = re.search(r'src="\.?/?(assets/[^"]+\.js)"', page)
    assert script, 'the page names no hashed script'
    path = '/' + script.group(1)
    status, headers, plain = cascade.fetch(path)
    assert status == 200 and 'immutable' in headers['cache-control'], (status, headers['cache-control'])

    # zstd when offered, else gzip; the script is well over the size floor.
    for offered, expected in (('gzip', 'gzip'), ('gzip, zstd', 'zstd'), ('identity', None)):
        status, headers, body = cascade.fetch(path, headers={'accept-encoding': offered})
        assert status == 200 and headers['content-encoding'] == expected, (offered, headers['content-encoding'])
        assert 'Accept-Encoding' in (headers['vary'] or ''), (offered, headers['vary'])
        if expected == 'gzip':
            assert gzip.decompress(body) == plain


def check_settings_and_throttles(cascade):
    original = cascade.api('/api/settings')
    patch = {'downloadRate': 512 * 1024, 'uploadRate': 256 * 1024,
             'pex': not original['pex'], 'maxPeersSeed': -1}
    group = 'smoke-' + uuid.uuid4().hex[:12]
    try:
        actual = cascade.api('/api/settings', patch)
        for key, value in patch.items():
            assert actual[key] == value, (key, actual.get(key), value)
        # rtorrent keeps a global rate in whole KiB/s and would drop 800 B/s
        # to 0, unlimited; the server rounds it up instead, and refuses a rate
        # past 4 GiB/s, which 0.16.25 refuses and older releases wrapped.
        assert cascade.api('/api/settings', {'uploadRate': 800})['uploadRate'] == 1024
        cascade.api('/api/settings', {'uploadRate': 4 * 1024 ** 3}, expected=400)
        assert cascade.rpc('throttle.global_up.max_rate') == 1024

        # Global setters take bytes/s, but named group setters take KiB/s.
        # A nonzero global limit is required to observe group .max in rtorrent.
        cascade.api('/api/throttles', {'name': group, 'up': 800, 'down': 1025})
        assert cascade.rpc('throttle.up.max', '', group) == 1024
        assert cascade.rpc('throttle.down.max', '', group) == 2048
        cascade.api('/api/throttles/' + group, {'up': 3072}, 'PATCH')
        saved = next(g for g in cascade.api('/api/throttles')['groups'] if g['name'] == group)
        assert saved == {'name': group, 'up': 3072, 'down': 2048}, saved
        assert cascade.rpc('throttle.up.max', '', group) == 3072
        cascade.api('/api/throttles', {'name': group, 'up': 'typo', 'down': 0}, expected=400)
        assert cascade.rpc('throttle.up.max', '', group) == 3072
    finally:
        cascade.api('/api/throttles/' + group, method='DELETE')
        cascade.api('/api/settings', {key: original[key] for key in patch})


def check_inert_setters(cascade):
    """Each setter a release keeps listing but may ignore is offered only where
    it works (AGENTS.md quirk 7): network.max_open_files.set from 0.16.15,
    dht.port.set from 0.16.1 and trackers.use_udp.set from 0.16.12 are stubs
    that change nothing, so what the server decided by release has to match
    what the command does on this one."""
    supports = cascade.api('/api/capabilities')['supports']
    for key, getter in (('maxOpenFiles', 'network.max_open_files'), ('dhtPort', 'dht.port'),
                        ('udpTrackers', 'trackers.use_udp')):
        offered = supports[key]
        before = cascade.rpc(getter)
        switch = key == 'udpTrackers'
        first, second = (1 - before, bool(1 - before)) if switch else (before + 1, before + 2)
        try:
            cascade.rpc(getter + '.set', '', first)
            works = cascade.rpc(getter) == first
            assert works == offered, f'{getter}.set works: {works}, {key} offered: {offered}'
            # Back again, so the change through the API is a change.
            cascade.rpc(getter + '.set', '', before)
            after = cascade.api('/api/settings', {key: second})[key]
            assert after == (second if offered else (bool(before) if switch else before)), (key, offered, before, after)
        finally:
            if offered:
                cascade.rpc(getter + '.set', '', before)


def check_name_switches(cascade):
    """The torrent-name switches of 0.16.22 and 0.16.25 are offered where this
    rtorrent lists their setters, and round-trip there; elsewhere they are
    neither read nor written, and a change to one is skipped, not refused."""
    supports = cascade.api('/api/capabilities')['supports']
    methods = set(cascade.api('/api/rpc/methods')['methods'])
    settings = cascade.api('/api/settings')
    for key, command in (('useSanitizedName', 'system.torrent_name.use_sanitized'),
                         ('allowLegacyUtf8', 'system.file_name.allow_legacy_utf8')):
        listed = command + '.set' in methods
        assert supports[key] == listed, (key, supports[key], listed)
        if not listed:
            assert key not in settings, (key, settings[key])
            assert key not in cascade.api('/api/settings', {key: False}), key
            continue
        before = settings[key]
        try:
            after = cascade.api('/api/settings', {key: not before})[key]
            assert after == (not before) and cascade.rpc(command) == int(not before), (key, before, after)
        finally:
            cascade.api('/api/settings', {key: before})


def bencode(value):
    if isinstance(value, int):
        return b'i%de' % value
    if isinstance(value, str):
        value = value.encode()
    if isinstance(value, bytes):
        return b'%d:' % len(value) + value
    if isinstance(value, list):
        return b'l' + b''.join(map(bencode, value)) + b'e'
    return b'd' + b''.join(bencode(key) + bencode(value[key]) for key in sorted(value)) + b'e'


def upload_torrent(cascade, info):
    """Uploads a torrent of this info dictionary: the upload's answer."""
    torrent = bencode({'announce': 'http://tracker.invalid/announce', 'info': info})
    boundary = 'cascade-smoke-' + uuid.uuid4().hex
    form = (f'--{boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="smoke.torrent"\r\n'
            'Content-Type: application/x-bittorrent\r\n\r\n').encode() + torrent + f'\r\n--{boundary}--\r\n'.encode()
    status, _, body = cascade.fetch('/api/torrents/upload', form, 'POST',
                                    {'content-type': f'multipart/form-data; boundary={boundary}'})
    assert status == 200, (status, body)
    return json.loads(body)


def remove_torrent(cascade, info_hash):
    status, _, _ = cascade.fetch(f'/api/torrents/{info_hash}?deleteData=true', method='DELETE')
    if status == 403:  # CASCADE_ALLOW_DATA_DELETE=0: leave the data, drop the torrent
        cascade.fetch(f'/api/torrents/{info_hash}', method='DELETE')


def check_legacy_names(cascade):
    """Where 0.16.25's system.file_name.allow_legacy_utf8 is offered, it picks
    between the name.utf-8 and path.utf-8 older torrent makers wrote and the
    names beside them, and the settings dialog says how: a torrent is listed
    under the names it picks, and a multi-file torrent's directory and files
    are saved under them, but a single-file torrent's file keeps its plain
    name either way (libtorrent's parse_single_file reads only "name")."""
    if not cascade.api('/api/capabilities')['supports']['allowLegacyUtf8']:
        return
    before = cascade.api('/api/settings')['allowLegacyUtf8']
    tag = uuid.uuid4().hex[:8]
    data = tag.encode() * 2048
    added = []
    try:
        for switch in (True, False):
            assert cascade.api('/api/settings', {'allowLegacyUtf8': switch})['allowLegacyUtf8'] == switch
            mark = f'{tag}-{"on" if switch else "off"}'
            picked = 'utf8' if switch else 'legacy'
            # rtorrent picks by key, not by encoding, so ASCII stands in for a
            # legacy name: one that is not UTF-8 would come back escaped (%E9
            # for a Latin-1 é) rather than as the path on disk.
            single = {'name': f'legacy {mark}.bin', 'name.utf-8': f'utf8 {mark}.bin',
                      'length': len(data), 'piece length': len(data), 'pieces': hashlib.sha1(data).digest()}
            multi = {'name': f'legacy {mark}', 'name.utf-8': f'utf8 {mark}',
                     'piece length': len(data), 'pieces': hashlib.sha1(data).digest(),
                     'files': [{'length': len(data), 'path': ['legacy.bin'], 'path.utf-8': ['utf8.bin']}]}
            for info, listed, saved in ((single, f'{picked} {mark}.bin', f'legacy {mark}.bin'),
                                        (multi, f'{picked} {mark}', f'{picked} {mark}/{picked}.bin')):
                result = upload_torrent(cascade, info)
                assert result['added'] == 1, result
                info_hash = hashlib.sha1(bencode(info)).hexdigest().upper()
                added.append(info_hash)
                # The file's path on disk is known once rtorrent has opened it.
                for _ in range(30):
                    on_disk = cascade.rpc('f.frozen_path', info_hash + ':f0')
                    if on_disk:
                        break
                    time.sleep(1)
                name = cascade.rpc('d.name', info_hash)
                assert name == listed and on_disk.endswith('/' + saved), (switch, name, listed, on_disk, saved)
    finally:
        for info_hash in added:
            remove_torrent(cascade, info_hash)
        cascade.api('/api/settings', {'allowLegacyUtf8': before})


def check_long_file_name(cascade):
    """The image's libtorrent shortens a name longer than Linux allows (see
    docker/patches/path_fit.h); unpatched, this torrent fails every open with
    "Filename too long" and never starts."""
    name = 'หลวงพ่อ' * 20 + f'-{uuid.uuid4().hex[:8]}.mp4'  # over 420 bytes of UTF-8
    assert len(name.encode()) > 255
    data = b'7' * (256 * 1024)
    info = {'name': name, 'length': len(data), 'piece length': 262144, 'pieces': hashlib.sha1(data).digest()}
    result = upload_torrent(cascade, info)
    assert result['added'] == 1, result

    info_hash = hashlib.sha1(bencode(info)).hexdigest().upper()
    try:
        # rtorrent drops a second load of a hash without a word; Cascade asks
        # the session first and says so, where it used to report success.
        again = upload_torrent(cascade, info)
        assert again['added'] == 0 and again['failedFiles'] == [0], again
        assert f'"{name}" is already loaded' in again['errors'][0], again
        for _ in range(30):
            torrent = next((t for t in cascade.api('/api/state')['torrents'] if t['hash'] == info_hash), None)
            files = cascade.api(f'/api/torrents/{info_hash}/files') if torrent else []
            if torrent and torrent['status'] != 'checking' and files and files[0]['onDisk']:
                break
            time.sleep(1)
        assert torrent, 'the torrent never appeared'
        assert torrent['status'] != 'error', torrent['message']
        # On disk it is the shortened name: "~" and a tag, within the limit.
        on_disk = files[0]['onDisk']
        assert '~' in on_disk and len(on_disk.encode()) <= 255, (on_disk, files)
    finally:
        remove_torrent(cascade, info_hash)


def upload_torrents(cascade, *torrents, **fields):
    boundary = 'cascade-smoke-' + uuid.uuid4().hex
    form = b''.join(
        (f'--{boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="t{i}.torrent"\r\n'
         'Content-Type: application/x-bittorrent\r\n\r\n').encode() + torrent + b'\r\n'
        for i, torrent in enumerate(torrents)) + b''.join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        for name, value in fields.items()) + f'--{boundary}--\r\n'.encode()
    status, _, body = cascade.fetch('/api/torrents/upload', form, 'POST',
                                    {'content-type': f'multipart/form-data; boundary={boundary}'})
    assert status == 200, (status, body)
    return json.loads(body)


def check_names_that_are_not_text(cascade):
    """A name that is not UTF-8 cannot travel as XML-RPC text, so rtorrent
    reports a stand-in: "Caf%E9" from 0.16.7, "Caf?" before 0.16.3 (0.16.3 to
    0.16.6 garble it into a fault, and crash on it in a list, the torrent list
    included, so this check cannot pass there). Deleting with data used to
    remove the path the stand-in spells, which is nothing — or another file of
    that name. The data must go, and a file named like the stand-in must stay
    unless the server cannot tell the two apart, when it refuses."""
    if not cascade.container:
        print('skipped deleting a name that is not UTF-8: it needs the container, to look at its disk')
        return
    directory = cascade.rpc('directory.default').rstrip('/') or '/'
    owner = cascade.run('stat', '-c', '%u:%g', directory).decode().strip()
    tag = uuid.uuid4().hex[:8]
    data = b'\xe9' * (256 * 1024)
    common = {'piece length': 262144, 'pieces': hashlib.sha1(data).digest()}
    single = {**common, 'name': b'Caf\xe9 smoke-' + tag.encode() + b'.bin', 'length': len(data)}
    # A UTF-8 name inside a directory that is not: escaped with its path, but
    # the same name, not one the filesystem made it shorten.
    multi = {**common, 'name': b'Caf\xe9 smoke-' + tag.encode(),
             'files': [{'length': len(data), 'path': ['Café.txt']}]}
    hashes = [hashlib.sha1(bencode(info)).hexdigest().upper() for info in (single, multi)]
    torrents = [bencode({'announce': 'http://tracker.invalid/announce', 'info': info}) for info in (single, multi)]
    try:
        result = upload_torrents(cascade, *torrents)
        assert result['added'] == 2, result
        files = {}
        for _ in range(30):
            listed = {t['hash']: t for t in cascade.api('/api/state')['torrents']}
            for info_hash in hashes:
                if info_hash in listed:
                    status, _, body = cascade.fetch(f'/api/torrents/{info_hash}/files')
                    files[info_hash] = json.loads(body) if status == 200 else []
            if all(files.get(h) and all(f['created'] for f in files[h]) for h in hashes):
                break
            time.sleep(1)
        on_disk = cascade.names(directory)
        if single['name'] not in on_disk or multi['name'] not in on_disk:
            print(f'skipped deleting a name that is not UTF-8: this rtorrent did not write it as given ({files})')
            return
        inside = files.get(hashes[1]) or [{}]
        assert inside[0].get('path') == 'Café.txt' and inside[0].get('onDisk') == '', inside

        methods = cascade.rpc('system.listMethods')
        exact = 'd.base_path.base64' in methods
        if exact:  # the list shows the bytes, read the way a browser reads them
            assert listed[hashes[0]]['name'] == f'Caf\ufffd smoke-{tag}.bin', listed[hashes[0]]['name']
        reported = cascade.rpc('d.base_path', hashes[0])
        stand_in = reported.rsplit('/', 1)[1].encode()
        assert stand_in != single['name'], reported
        cascade.run('sh', '-c', 'printf other > "$1"', 'sh', reported, user=owner)

        status, _, body = cascade.fetch(f'/api/torrents/{hashes[0]}?deleteData=true', method='DELETE')
        if status == 403 and b'disabled' in body:
            print('skipped deleting a name that is not UTF-8: data deletion is switched off')
            return
        if not exact:
            # Two paths fit the stand-in; which one rtorrent means it cannot say.
            assert status == 409 and b'more than one path' in body, (status, body)
            assert {single['name'], stand_in} <= cascade.names(directory), 'a refused delete removed something'
            cascade.run('rm', '--', reported)
            status, _, body = cascade.fetch(f'/api/torrents/{hashes[0]}?deleteData=true', method='DELETE')
        assert status == 200, (status, body)
        left = cascade.names(directory)
        assert single['name'] not in left, 'the data is still on disk'
        assert stand_in in left or not exact, 'a file named like the stand-in was deleted'

        status, _, body = cascade.fetch(f'/api/torrents/{hashes[1]}?deleteData=true', method='DELETE')
        assert status == 200, (status, body)
        assert multi['name'] not in cascade.names(directory), 'the directory is still on disk'
    finally:
        for info_hash in hashes:
            cascade.fetch(f'/api/torrents/{info_hash}', method='DELETE')
        cascade.run('sh', '-c', 'rm -rf -- "$1"/*"$2"*', 'sh', directory, tag)


def release(version):
    """The numbers a version starts with, compared as the server compares them."""
    numbers = []
    for part in version.split('.'):
        digits = re.match(r'\d*', part).group()
        if not digits:
            break
        numbers.append(int(digits))
        if digits != part:
            break
    return tuple(numbers)


def check_directory_change(cascade):
    """A directory change takes the directory the data goes into, as an add
    does. d.directory is a multi-file torrent's own folder, and d.directory.set
    appends the torrent's name to what it is given, so the directory the UI
    offered back used to nest the torrent inside itself. The offer must change
    nothing, and a new directory get the folder, by the name it has — a '?' in
    it included, from 0.16.3, where a '?' no longer stands in for a byte.
    Trailing slashes, which d.directory.set keeps before the name it appends
    ("e//multi"), must not turn the offer into a change, and Cascade sends a
    directory without them."""
    tag = uuid.uuid4().hex[:8]
    root = cascade.rpc('directory.default').rstrip('/') + f'/smoke-dir-{tag}'
    data = tag.encode() * 2048
    common = {'piece length': len(data), 'pieces': hashlib.sha1(data).digest()}
    single = {**common, 'name': f'single {tag}.bin', 'length': len(data)}
    multi = {**common, 'name': f'multi {tag}', 'files': [{'length': len(data), 'path': ['a.bin']}]}
    hashes = [hashlib.sha1(bencode(info)).hexdigest().upper() for info in (single, multi)]
    torrents = [bencode({'announce': 'http://tracker.invalid/announce', 'info': info}) for info in (single, multi)]

    def directories():
        listed = {t['hash']: t['directory'] for t in cascade.api('/api/state')['torrents']}
        return [listed.get(info_hash) for info_hash in hashes]

    def move(directory):
        for info_hash in hashes:
            cascade.api(f'/api/torrents/{info_hash}', {'directory': directory}, 'PATCH')

    try:
        # Never started, so nothing reaches the disk.
        result = upload_torrents(cascade, *torrents, directory=f'{root}/a', start='false')
        assert result['added'] == 2, result
        offered = [f'{root}/a', f'{root}/a/multi {tag}']
        assert directories() == offered, directories()
        move(f'{root}/a')
        assert directories() == offered, f'the directory offered moved them: {directories()}'
        move(f'{root}/b/')
        assert directories() == [f'{root}/b', f'{root}/b/multi {tag}'], directories()
        # A folder named otherwise, as another tool leaves one, keeps its name.
        cascade.rpc('d.directory_base.set', hashes[1], f'{root}/b/Other {tag}')
        move(f'{root}/c')
        assert directories() == [f'{root}/c', f'{root}/c/Other {tag}'], directories()
        # Never opened, so no base path vouches for the name: before 0.16.3 its
        # '?' may be a byte, and a folder not named after the torrent cannot
        # be kept; from 0.16.3 it is the name's own.
        cascade.rpc('d.directory_base.set', hashes[1], f'{root}/c/What? {tag}')
        if release(cascade.api('/api/capabilities')['clientVersion']) >= (0, 16, 3):
            move(f'{root}/d')
            assert directories() == [f'{root}/d', f'{root}/d/What? {tag}'], directories()
        else:
            status, _, body = cascade.fetch(f'/api/torrents/{hashes[1]}', json.dumps({'directory': f'{root}/d'}).encode(),
                                            'PATCH', {'content-type': 'application/json'})
            assert status == 502 and directories()[1] == f'{root}/c/What? {tag}', (status, body, directories())
        # Typed as "e//", the multi-file torrent's root is "e//multi …": the
        # directory offered is "e", and changes nothing.
        for info_hash in hashes:
            cascade.rpc('d.directory.set', info_hash, f'{root}/e//')
        assert directories() == [f'{root}/e', f'{root}/e//multi {tag}'], directories()
        move(f'{root}/e')
        assert directories() == [f'{root}/e', f'{root}/e//multi {tag}'], f'the directory offered moved them: {directories()}'
        # Cascade sends a directory without them.
        move(f'{root}/f//')
        assert directories() == [f'{root}/f', f'{root}/f/multi {tag}'], directories()
    finally:
        for info_hash in hashes:
            cascade.fetch(f'/api/torrents/{info_hash}', method='DELETE')


def check_stream(cascade):
    """The state stream: a compressed snapshot first, then a delta once a
    change lands — here a preference, which the status carries."""
    url = urllib.parse.urlsplit(cascade.base)
    conn = http.client.HTTPConnection(url.hostname, url.port or 80, timeout=20)
    conn.request('GET', url.path + '/api/stream', headers={'accept-encoding': 'gzip'})
    response = conn.getresponse()
    assert response.status == 200, response.status
    assert response.getheader('content-type', '').startswith('text/event-stream')
    assert response.getheader('content-encoding') == 'gzip', response.getheaders()
    inflate = zlib.decompressobj(wbits=31)
    pending = b''

    def next_event():
        # Bytes until an event is whole: a chunk can end inside a character.
        nonlocal pending
        while True:
            while b'\n\n' in pending:
                block, pending = pending.split(b'\n\n', 1)
                fields = dict(line.split(': ', 1) for line in block.decode().split('\n') if ': ' in line)
                if 'event' in fields:
                    return fields['event'], json.loads(fields['data'])
            chunk = response.read1(65536)
            assert chunk, 'the stream ended'
            pending += inflate.decompress(chunk)

    name, snapshot = next_event()
    assert name == 'snapshot', name
    assert isinstance(snapshot['torrents'], dict), type(snapshot['torrents'])
    assert snapshot['status']['connected'], snapshot['status']
    before = cascade.api('/api/prefs')['statePollMs']
    wanted = 2000 if snapshot['status']['statePollMs'] != 2000 else 3000
    try:
        cascade.api('/api/prefs', {'statePollMs': wanted}, 'PATCH')
        for _ in range(50):
            name, delta = next_event()
            if name == 'delta' and delta.get('status', {}).get('statePollMs') == wanted:
                break
        else:
            raise AssertionError('no delta carried the new interval')
    finally:
        cascade.api('/api/prefs', {'statePollMs': before}, 'PATCH')
        conn.close()


def main(base, container=None):
    cascade = Cascade(base, container)
    cascade.wait_ready()
    version = check_basics(cascade)
    check_refusals(cascade)
    check_page_and_headers(cascade)
    check_settings_and_throttles(cascade)
    check_inert_setters(cascade)
    check_name_switches(cascade)
    check_legacy_names(cascade)
    check_long_file_name(cascade)
    check_names_that_are_not_text(cascade)
    check_directory_change(cascade)
    check_stream(cascade)
    print(f'API smoke test passed on rtorrent {version}')


if __name__ == '__main__':
    main(*sys.argv[1:3]) if len(sys.argv) > 1 else main('http://127.0.0.1:18080')
