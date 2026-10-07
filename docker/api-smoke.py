#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Exercise a disposable Cascade container against the rtorrent inside it.

usage: python3 docker/api-smoke.py <base-url>[/base-path] [container]

What it holds the image to: readiness, the XML-RPC passthrough, validation and
error shapes, the cross-site guard, compression and caching headers, setting
and throttle round trips in rtorrent's own units, the state stream, and the
libtorrent path patch (a torrent named past Linux's 255-byte limit must start).
Given the container's name it gives up as soon as the container exits rather
than waiting out the readiness timeout.

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


def check_long_file_name(cascade):
    """The image's libtorrent shortens a name longer than Linux allows (see
    docker/patches/path_fit.h); unpatched, this torrent fails every open with
    "Filename too long" and never starts."""
    name = 'หลวงพ่อ' * 20 + f'-{uuid.uuid4().hex[:8]}.mp4'  # over 420 bytes of UTF-8
    assert len(name.encode()) > 255
    data = b'7' * (256 * 1024)
    info = {'name': name, 'length': len(data), 'piece length': 262144, 'pieces': hashlib.sha1(data).digest()}
    torrent = bencode({'announce': 'http://tracker.invalid/announce', 'info': info})
    boundary = 'cascade-smoke-' + uuid.uuid4().hex
    form = (f'--{boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="long.torrent"\r\n'
            'Content-Type: application/x-bittorrent\r\n\r\n').encode() + torrent + f'\r\n--{boundary}--\r\n'.encode()

    def upload():
        status, _, body = cascade.fetch('/api/torrents/upload', form, 'POST',
                                        {'content-type': f'multipart/form-data; boundary={boundary}'})
        assert status == 200, (status, body)
        return json.loads(body)

    result = upload()
    assert result['added'] == 1, result

    info_hash = hashlib.sha1(bencode(info)).hexdigest().upper()
    try:
        # rtorrent drops a second load of a hash without a word; Cascade asks
        # the session first and says so, where it used to report success.
        again = upload()
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
        status, _, _ = cascade.fetch(f'/api/torrents/{info_hash}?deleteData=true', method='DELETE')
        if status == 403:  # CASCADE_ALLOW_DATA_DELETE=0: leave the data, drop the torrent
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
    check_long_file_name(cascade)
    check_stream(cascade)
    print(f'API smoke test passed on rtorrent {version}')


if __name__ == '__main__':
    main(*sys.argv[1:3]) if len(sys.argv) > 1 else main('http://127.0.0.1:18080')
