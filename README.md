# Cascade

A modern web UI for [rtorrent](https://github.com/rakshasa/rtorrent), packaged as a single
Docker image with rtorrent baked in. TypeScript end to end — React on the front, a
dependency-light Node backend that speaks rtorrent's XML-RPC over SCGI.

![Main view](docs/screenshot-main.png)

## Highlights

- **One container, batteries included** — rtorrent, its config, and the UI. Nothing else to run.
- **rtorrent 0.16.20, compiled from source** — the version in the image is exactly the upstream
  tag you asked for, not whatever a distro packaged. Any other tag builds with one build arg.
- **Works across backend versions** — the server probes `system.listMethods` on connect and picks
  command names from what the running rtorrent actually implements, hiding unsupported controls
  in the UI instead of failing.
- **Everything rtorrent exposes** — upload `.torrent` files, magnet links and URLs, global and
  per-torrent throttling, file priorities, tracker management, peers, labels, live settings, plus
  a raw API console and an XML-RPC passthrough for anything the UI does not wrap.
- **Drop torrents anywhere** — drag `.torrent` files onto the window and the add dialog opens
  ready to go.
- **Lightly gamified** — a level and a set of badges earned from real transfer totals, with a
  confetti burst when a download lands. Off with one environment variable if it is not for you.
- **Four themes** — system, light, dark, and a retro 8-bit CRT mode. Preferences are stored on the
  server, so they follow the install rather than the browser.
- **Configured entirely from `docker run`** — the rtorrent backend options are environment
  variables.

## Quick start

```bash
docker build -t cascade .

docker run -d --name cascade \
  -p 8080:8080 -p 50000:50000 \
  -v /srv/downloads:/downloads \
  -v /srv/cascade-config:/config \
  -e RT_DOWNLOAD_RATE=5120 \
  -e RT_UPLOAD_RATE=1024 \
  -e WEB_USER=admin -e WEB_PASS=change-me \
  cascade
```

Open <http://localhost:8080>.

Or with compose:

```bash
docker compose up -d
```

## Choosing the rtorrent version

rtorrent and libtorrent are always compiled from upstream tags. The default is **0.16.20**:

```bash
docker build -t cascade .                                       # 0.16.20
docker build --build-arg RTORRENT_VERSION=0.15.2 -t cascade:0.15.2 .
docker build --build-arg RTORRENT_VERSION=0.9.8  -t cascade:0.9.8 .
make matrix                                                     # 0.9.8, 0.15.2, 0.16.20
```

libtorrent is pinned to the matching release automatically — rtorrent 0.9.x pairs with libtorrent
0.13.x, 0.10.x with 0.14.x, and from 0.15 the two share a version. `LIBTORRENT_VERSION` overrides
that, and `RTORRENT_REPO`/`LIBTORRENT_REPO` point at forks. `ALPINE_VERSION` (default 3.22) picks
the base image.

The UI adapts at runtime, so one build of the frontend drives any of them — 0.9.8, 0.15.2 and
0.16.20 are all exercised by the same API suite. Which backend you got is shown under the logo and
in **Settings → Backend**.

### What changed in 0.16

0.16 renamed and removed a number of commands. Cascade probes for them rather than assuming, so
older backends keep working:

| Area | ≤ 0.15 | 0.16 |
| --- | --- | --- |
| Listening port | `network.port_range` | `network.listen.port.range` |
| Scheduler | `schedule2` | `schedule` (the string form, which all versions accept) |
| HTTP connections | `network.http.max_open` (writable) | `network.http.max_total_connections` (read-only) |
| Proxy | `network.proxy_address` | `network.proxy.global` / `network.proxy.http` |

0.16 also adds options Cascade now exposes when present: per-host HTTP connection limits, a global
proxy, separate IPv4/IPv6 bind addresses, a DHT announce-port override, outgoing-connection
blocking, and a random-access hint for hashing. On older backends those controls are hidden.

## Configuration

Everything is an environment variable on `docker run`. Only what you set is applied — anything
left unset keeps rtorrent's own default.

### Paths and identity

| Variable | Default | Meaning |
| --- | --- | --- |
| `RT_DOWNLOAD_DIR` | `/downloads` | Default download directory |
| `RT_SESSION_DIR` | `/config/session` | rtorrent session state |
| `RT_WATCH_DIR` | `/watch` | `.torrent` files dropped here are loaded and started |
| `RT_WATCH_INTERVAL` | `10` | Watch-directory poll interval, seconds |
| `RT_WATCH_ENABLE` | `1` | Set `0` to disable the watch directory |
| `RT_COMPLETED_DIR` | — | If set, finished downloads are moved here |
| `RT_LOG_FILE` | `/config/rtorrent.log` | rtorrent log file, surfaced in the UI |
| `RT_LOG_LEVEL` | `info` | Log scopes: `info`, `debug`, `dht_debug`, `tracker_debug`, … |
| `RT_UMASK` | `0022` | rtorrent umask |
| `PUID` / `PGID` | `1000` | User/group rtorrent and the server run as |
| `TZ` | `UTC` | Container timezone |

### Bandwidth and slots

Rates are in **KiB/s**; `0` means unlimited.

| Variable | Meaning |
| --- | --- |
| `RT_DOWNLOAD_RATE` | Global download limit |
| `RT_UPLOAD_RATE` | Global upload limit |
| `RT_MAX_UPLOADS` | Upload slots per torrent |
| `RT_MAX_UPLOADS_GLOBAL` | Upload slots across all torrents |
| `RT_MAX_DOWNLOADS` | Download slots per torrent |
| `RT_MAX_DOWNLOADS_GLOBAL` | Download slots across all torrents |
| `RT_MIN_PEERS` / `RT_MAX_PEERS` | Peer range while leeching |
| `RT_MIN_PEERS_SEED` / `RT_MAX_PEERS_SEED` | Peer range while seeding (`-1` disables) |

### Network

| Variable | Default | Meaning |
| --- | --- | --- |
| `RT_PORT_RANGE` | `50000-50000` | Incoming peer port range |
| `RT_PORT_RANDOM` | `no` | Pick a random port in the range |
| `RT_DHT` | rtorrent default | `disable`, `off`, `auto`, `on` |
| `RT_DHT_PORT` | `6881` | DHT UDP port |
| `RT_PEX` | rtorrent default | `yes` / `no` |
| `RT_UDP_TRACKERS` | rtorrent default | `yes` / `no` |
| `RT_ENCRYPTION` | rtorrent default | e.g. `allow_incoming,try_outgoing,enable_retry` |
| `RT_BIND` | — | Bind address for outgoing connections |
| `RT_IP` | — | Address reported to trackers |
| `RT_PROXY` | — | HTTP proxy for tracker announces |
| `RT_HTTP_CAPATH` / `RT_HTTP_CACERT` | — | TLS trust store for announces |
| `RT_MAX_OPEN_FILES` | rtorrent default | Open file handle cap |
| `RT_MAX_HTTP_OPEN` | rtorrent default | Concurrent HTTP requests (read-only on 0.16+) |
| `RT_HTTP_MAX_HOST` | rtorrent default | HTTP connections per host (0.16+) |
| `RT_PROXY_GLOBAL` | — | Global proxy for all traffic (0.16+) |
| `RT_BIND_IPV4` / `RT_BIND_IPV6` | — | Separate bind addresses per family (0.16+) |
| `RT_DHT_OVERRIDE_PORT` | — | Announce a different DHT port (0.16+) |
| `RT_BLOCK_OUTGOING` | — | `yes` refuses outgoing connections (0.16+) |
| `RT_ADVISE_RANDOM_HASHING` | — | Random-access hint while hashing (0.16+) |
| `RT_RECEIVE_BUFFER` / `RT_SEND_BUFFER` | — | Socket buffer sizes in bytes |

### Storage

| Variable | Default | Meaning |
| --- | --- | --- |
| `RT_PREALLOCATE` | rtorrent default | Preallocate files (`yes`/`no`) |
| `RT_HASH_ON_COMPLETION` | rtorrent default | Re-verify on completion (`yes`/`no`) |
| `RT_MEMORY_MAX` | rtorrent default | Piece memory cap, bytes |
| `RT_MAX_FILE_SIZE` | rtorrent default | Largest accepted file, bytes |

### RPC

| Variable | Default | Meaning |
| --- | --- | --- |
| `RT_SCGI_SOCKET` | `/run/rtorrent/rpc.socket` | Unix socket rtorrent listens on |
| `RT_SCGI_PORT` | — | Also listen for SCGI on this TCP port |
| `RT_SCGI_BIND` | `127.0.0.1` | Interface for `RT_SCGI_PORT` |
| `RT_XMLRPC_SIZE_LIMIT` | `16777216` | Max XML-RPC request size (raises the `.torrent` upload ceiling) |

### Web server

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_PORT` | `8080` | HTTP port |
| `WEB_HOST` | `0.0.0.0` | Bind address |
| `WEB_USER` / `WEB_PASS` | — | Enables HTTP Basic auth when **both** are set |
| `WEB_BASE_PATH` | `/` | Serve under a sub-path, e.g. `/rtorrent` (for a reverse proxy) |
| `CASCADE_ALLOW_RAW_RPC` | `1` | `0` disables the API console and `/RPC2` |
| `CASCADE_ALLOW_DATA_DELETE` | `1` | `0` forbids deleting downloaded data |
| `CASCADE_MAX_UPLOAD_MB` | `64` | Max `.torrent` upload size |
| `CASCADE_POLL_MS` | `1000` | Backend sampling interval for the rate graph |
| `CASCADE_GAMIFY` | `1` | `0` removes levels, badges and celebrations |
| `CASCADE_DELETE_ROOTS` | — | Extra `:`-separated roots data may be deleted from |

### Escape hatches

| Variable | Meaning |
| --- | --- |
| `RT_EXTRA_CONFIG` | Raw `rtorrent.rc` lines appended to the generated config |
| `RT_EXTRA_CONFIG_FILE` | Path to a file of extra `rtorrent.rc` lines |
| `RT_CONFIG_FILE` | Use this config file verbatim instead of generating one |

> Settings given as environment variables are applied to rtorrent over XML-RPC at startup rather
> than written into `rtorrent.rc`. rtorrent aborts on an unknown command in its config file and
> the command set differs between versions, so routing them through the capability probe means an
> option your rtorrent lacks is skipped with a warning instead of breaking the container.
> A consequence: changes you make in the UI last until the container restarts, at which point the
> environment wins again.

## The UI

Click a torrent for details — general, files with per-file priority, live peers and trackers. Peer
and tracker rows expand for everything rtorrent knows: peer id, protocol extensions, direction,
encryption and the preferred/snubbed/unwanted/banned flags.

![Peers](docs/screenshot-peers.png)

Trackers show type, state, scrape counts and the peers returned by the last announce, with a
countdown to the next one; expanding a row adds announce intervals, success and failure timings,
and the latest event.

![Trackers](docs/screenshot-trackers.png)

Drag `.torrent` files onto the window — anywhere — and drop to add them.

![Drag and drop](docs/screenshot-drop.png)

The add dialog opens prefilled with what you dropped; magnet links and URLs can be pasted
alongside. Destination directory and label are set at add time.

![Add torrents](docs/screenshot-add.png)

Sharing earns levels and badges. Every number behind them is a real transfer total pulled from
rtorrent — uploaded bytes, completed downloads, peak rates — accumulated across restarts, and XP
leans on uploading rather than downloading. Set `CASCADE_GAMIFY=0` and the whole layer disappears.

![Progress and badges](docs/screenshot-progress.png)

rtorrent's live settings are editable, with anything the running version does not support greyed
out.

![Settings](docs/screenshot-settings.png)

rtorrent has no per-torrent rate limit — it throttles by *named group*. Create groups here and
assign torrents to them from the right-click menu.

![Throttle groups](docs/screenshot-throttles.png)

Anything not wrapped by the UI is reachable from the API console, which lists every command the
backend exposes with its help text.

![API console](docs/screenshot-console.png)

Themes are chosen from the header: **System** (follows the OS), **Light**, **Dark**, and a
**Retro 8-bit** mode with CRT phosphor colours, hard pixel edges, stepped progress bars and
scanlines.

![Theme picker](docs/screenshot-theme-menu.png)

![Retro 8-bit theme](docs/screenshot-retro.png)

The retro treatment is driven entirely by the same design tokens, so it reaches every dialog:

![Retro progress dialog](docs/screenshot-retro-progress.png)

And the light theme:

![Light theme](docs/screenshot-light.png)

UI preferences — theme, sort column, detail-pane height — are saved server-side, so a new browser
or a different machine picks up the same setup. They live in `/config/cascade-state.json` next to
gamification progress, add times and throttle groups; that one file is the whole of Cascade's
persistent state, and deleting it resets everything.

Keyboard: `n` add torrents · `Ctrl/⌘+A` select all · `Delete` remove · `Shift+Delete` remove with
data · `Esc` clear selection. Rows support `Ctrl`-click and `Shift`-click ranges.

## API

All endpoints live under `/api` and honour the same Basic auth as the UI.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | Torrents, global status, throttle groups (the UI's poll) |
| `GET` | `/api/torrents?view=main` | Torrent list for an rtorrent view |
| `GET` | `/api/capabilities` | Backend version and supported feature map |
| `GET` | `/api/game` | Level, XP and badge progress |
| `GET`/`PATCH` | `/api/prefs` | UI preferences (theme, sort, layout) |
| `GET` | `/api/torrents/:hash/files` \| `/peers` \| `/trackers` | Per-torrent detail |
| `POST` | `/api/torrents/upload` | Multipart: `torrents[]`, `urls`, `start`, `directory`, `label` |
| `POST` | `/api/torrents/url` | Add one magnet/URL as JSON |
| `POST` | `/api/torrents/:hash/action/:action` | `start`, `stop`, `pause`, `resume`, `recheck`, `announce` |
| `POST` | `/api/torrents/action/:action` | Same, for a list of hashes |
| `PATCH` | `/api/torrents/:hash` | `priority`, `label`, `throttle`, `directory`, `maxUploads`, `maxDownloads` |
| `POST` | `/api/torrents/remove` | Remove hashes, optionally `deleteData` |
| `POST` | `/api/torrents/:hash/files/:index/priority` | `0` skip, `1` normal, `2` high |
| `POST` | `/api/torrents/:hash/trackers/:index/enabled` | Enable/disable a tracker |
| `GET`/`POST` | `/api/settings` | Read/write rtorrent's live settings |
| `GET`/`POST`/`DELETE` | `/api/throttles` | Manage throttle groups |
| `GET` | `/api/log` | Tail of the rtorrent log |
| `GET` | `/api/rpc/methods`, `POST` `/api/rpc` | Every rtorrent command, as JSON |
| `POST` | `/RPC2` | Raw XML-RPC passthrough |

`/RPC2` lets existing tooling drive rtorrent over HTTP:

```bash
curl -u admin:change-me -X POST http://localhost:8080/RPC2 \
  -H 'content-type: text/xml' \
  --data '<?xml version="1.0"?><methodCall><methodName>system.client_version</methodName></methodCall>'
```

```python
import xmlrpc.client
rt = xmlrpc.client.ServerProxy("http://admin:change-me@localhost:8080/RPC2")
print(rt.system.client_version(), rt.d.multicall2("", "main", "d.name=", "d.down.rate="))
```

To expose rtorrent's own SCGI socket instead, set `RT_SCGI_PORT=5000` and
`RT_SCGI_BIND=0.0.0.0`, then publish the port. **SCGI is unauthenticated** — anyone who reaches
it has full control of rtorrent and can run commands on the host through `execute`. Keep it on a
private network, or prefer `/RPC2`, which sits behind Basic auth.

## Notes and limitations

- Global settings changed in the UI are not persisted to `rtorrent.rc`; the environment is the
  source of truth on restart.
- "Change directory" updates rtorrent's session only. Move already-downloaded files yourself, or
  recheck afterwards.
- Deleting torrent data is confined to `RT_DOWNLOAD_DIR`, `RT_COMPLETED_DIR` and any
  `CASCADE_DELETE_ROOTS`; requests outside those are refused.
- Throttle groups cannot be removed from a running rtorrent — deleting one sets it to unlimited
  and drops it from the UI list.
- rtorrent runs inside a detached `screen` session, so `docker exec -it cascade screen -r rtorrent`
  gives you the real curses UI. If rtorrent dies, the entrypoint restarts it.

## Development

The whole toolchain lives in the image; no local Node is required. The Makefile wraps the usual
work — `make` on its own lists every target.

```bash
make build                  # build the image (typechecks both TypeScript halves)
make run PORT=8080          # run it, mounting ./data
make smoke                  # build, boot, exercise the API, tear down
make matrix                 # build against 0.9.8, 0.10.0 and 0.15.2
make build-source RTORRENT_VERSION=0.9.8
make attach                 # attach to rtorrent's curses UI
make logs / shell / stop
```

Working on the frontend with live reload, against a running container:

```bash
cd web && npm install && npm run dev     # proxies /api to localhost:8080
```

Layout:

```
Makefile       build/run/test wrappers around Docker
server/src/    XML-RPC codec, SCGI transport, capability probe, REST API
web/src/       React UI (components/, styles.css)
docker/        entrypoint that renders rtorrent.rc and supervises both processes
```

See [CLAUDE.md](CLAUDE.md) for the architecture details and the rtorrent quirks worth knowing
before changing the backend.
