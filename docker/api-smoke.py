#!/usr/bin/env python3
"""Exercise a disposable Cascade container, including real rtorrent setter units.

Usage: python3 docker/api-smoke.py http://127.0.0.1:18080[/base]
Uses only the Python standard library. Restores settings and removes its group.
"""
import json
import sys
import time
import urllib.error
import urllib.request
import uuid


def main(base):
    base = base.rstrip('/')

    def request(path, data=None, method=None, expected=200):
        headers = {'content-type': 'application/json'}
        payload = None if data is None else json.dumps(data).encode()
        req = urllib.request.Request(base + path, payload, headers, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=40)
        except urllib.error.HTTPError as error:
            response = error
        body = response.read().decode()
        assert response.code == expected, (path, response.code, body)
        return json.loads(body)

    for _ in range(90):
        try:
            state = request('/api/state')
            assert state['status']['connected']
            break
        except (OSError, AssertionError):
            time.sleep(1)
    else:
        raise AssertionError('Cascade did not become ready within 90 seconds')

    def rpc(method, *params):
        reply = request('/api/rpc', {'method': method, 'params': params})
        assert reply['ok'], reply
        return reply['result']

    capabilities = request('/api/capabilities')
    assert capabilities['clientVersion'] == rpc('system.client_version')
    assert request('/healthz')['ok']
    with urllib.request.urlopen(base + '/', timeout=10) as page:
        assert '<title>Cascade</title>' in page.read().decode()
    request('/api/torrents/action/stop', {'hashes': ['invalid']}, expected=400)
    request('/api/settings', {'downloadRate': None}, expected=400)

    original = request('/api/settings')
    patch = {'downloadRate': 512 * 1024, 'uploadRate': 256 * 1024,
             'pex': not original['pex'], 'maxPeersSeed': -1}
    group = 'smoke-' + uuid.uuid4().hex[:12]
    try:
        actual = request('/api/settings', patch)
        for key, value in patch.items():
            assert actual[key] == value, (key, actual.get(key), value)

        # Global setters take bytes/s, but named group setters take KiB/s.
        # A nonzero global limit is required to observe group .max in rtorrent.
        request('/api/throttles', {'name': group, 'up': 800, 'down': 1025})
        assert rpc('throttle.up.max', '', group) == 1024
        assert rpc('throttle.down.max', '', group) == 2048
        request('/api/throttles/' + group, {'up': 3072}, 'PATCH')
        saved = next(g for g in request('/api/throttles')['groups'] if g['name'] == group)
        assert saved == {'name': group, 'up': 3072, 'down': 2048}, saved
        assert rpc('throttle.up.max', '', group) == 3072
        request('/api/throttles', {'name': group, 'up': 'typo', 'down': 0}, expected=400)
        assert rpc('throttle.up.max', '', group) == 3072
    finally:
        request('/api/throttles/' + group, method='DELETE')
        request('/api/settings', {key: original[key] for key in patch})

    print('API, settings and throttle round trips passed on rtorrent ' + capabilities['clientVersion'])


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:18080')
