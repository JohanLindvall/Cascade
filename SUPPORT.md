# Getting help with Cascade

Start with the [quick start](README.md#quick-start), [Compose setup](README.md#docker-compose)
or [configuration reference](README.md#configuration). The
[live demo](https://johanlindvall.github.io/Cascade/) lets you check how the UI behaves without
changing your installation.

For help, [search existing issues](https://github.com/JohanLindvall/Cascade/issues) or
[open a question](https://github.com/JohanLindvall/Cascade/issues/new?template=question.yml).
Use the [bug report](https://github.com/JohanLindvall/Cascade/issues/new?template=bug_report.yml)
for reproducible failures, and the
[feature request](https://github.com/JohanLindvall/Cascade/issues/new?template=feature_request.yml)
for improvements. Support is provided by the community and maintainer on a best-effort basis.

Report security problems **privately**, following [SECURITY.md](SECURITY.md).

## Troubleshooting

The commands below use the repository's Compose setup. For a `docker run` installation named
`cascade`, use `docker logs --tail=100 cascade` and `docker exec cascade …` instead.

### The container will not start

```bash
docker compose ps -a
docker compose logs --tail=100 cascade
```

An error naming `WEB_PASS` before the container starts means you need to set a nonempty password
in `.env`. An error naming another setting usually includes the expected format. Check it
against the [configuration table](README.md#configuration), then run `docker compose up -d`.

If Docker reports a port is already allocated, change `WEB_PORT` or `PEER_PORT` in `.env`.
Changing `PEER_PORT` updates both rtorrent's listening port and the TCP/UDP mappings.

### The page will not open, or asks for a password

The example binds the UI to the Docker host's `127.0.0.1`. Open
<http://localhost:8080> **on that host**; `localhost` on your phone is your phone. Use the port
from `.env` if you changed `WEB_PORT`. For access from elsewhere, configure a TLS reverse proxy
and an appropriate bind address, keeping authentication enabled.

Sign in with `WEB_USER` and `WEB_PASS`. After editing `.env`, run `docker compose up -d`;
`docker compose restart` alone does not load the new environment.

Check the health endpoint on the Docker host:

```bash
curl -fsS http://localhost:8080/healthz
```

It needs no credentials. If it fails, check the container logs; if it succeeds but the UI does
not load, check the browser's network errors and any reverse proxy configuration.

### Downloads fail with permission errors

Torrent paths refer to the container: `/downloads` maps to `./data/downloads` in the default
Compose setup. On Linux, match `PUID` and `PGID` to the owner of your data directory:

```bash
id -u
id -g
ls -ld data/config data/downloads data/watch
```

The configured user needs permission to write to those directories. Update the ownership or
permissions of the intended folders, and recreate the service after changing `.env`.
Avoid making the whole data directory world-writable as a workaround.

### The page loads, but live updates stop behind a proxy

Cascade streams updates over `GET /api/stream` (under `WEB_BASE_PATH`, if set). The proxy must
pass the response as it arrives and allow a long-lived HTTP connection. Disable buffering for
that route and check its read timeout. The browser's Network panel should show an open
`text/event-stream` response. WebSockets are not required.

If using a sub-path, set `WEB_BASE_PATH` and preserve that prefix when forwarding requests.
See the [state stream](README.md#the-state-stream) for the protocol.

### A setting is greyed out

Cascade checks the running rtorrent's supported commands. Some newer versions still list setters
that no longer work, so those controls are disabled too. Check **Settings → Backend** and the
[version notes](README.md#what-changed-in-016). This is usually a backend limitation.

### A torrent is stopped, or has no peers

Read the torrent's error message and the Trackers tab first. A failed announce may indicate a
tracker or client-version restriction; see
[the version presented to trackers](README.md#the-version-presented-to-trackers).
For incoming connections, publish the peer port and allow it through the host firewall and,
where applicable, router or VPN.

For a hash-check error, confirm that the data is present and readable before using
**Recheck & restart**. **Change directory** changes where rtorrent looks; it does not move the
files. Move the data yourself before rechecking.

Stop with `docker compose stop` or `docker stop -t 60 cascade`. A clean stop saves the session
and releases its lock; do not delete a lock while rtorrent is running.

## What to include in a report

- What you expected, what happened, and steps someone else can follow.
- The image tag or commit and rtorrent version shown in **Settings → Backend**.
- Host OS and CPU architecture; browser and device for UI issues.
- Whether you use Compose, a reverse proxy, VPN or a custom rtorrent config.
- The relevant error message and a short, redacted log excerpt.

For the exact published image version:

```bash
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
  "$(docker compose ps -q cascade)"
```

Review anything you share. Remove passwords, tracker passkeys, private URLs and personal file
paths from logs or screenshots. Do not attach your `.env`, a full `docker inspect` result or an
unedited `docker compose config`: those can contain credentials. Cascade masks tracker secrets
in the UI, but raw logs and API responses can still contain them.
