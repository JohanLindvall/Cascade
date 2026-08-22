# Cascade

A modern web UI for [rtorrent](https://github.com/rakshasa/rtorrent), packaged as a single
Docker image with rtorrent baked in. TypeScript end to end — React on the front, a
dependency-light Node backend that speaks rtorrent's XML-RPC over SCGI.

![Main view](docs/screenshot-main.png)

## Highlights

- **One container, batteries included** — rtorrent, its config, and the UI. Nothing else to run,
  published for amd64 and arm64, and buildable from source in one command.
- **rtorrent 0.16.20, compiled from source** — the version in the image is exactly the upstream
  tag you asked for, not whatever a distro packaged. Any other tag builds with one build arg.
- **Works across backend versions** — the server probes `system.listMethods` on connect and picks
  command names from what the running rtorrent actually implements, hiding unsupported controls
  in the UI instead of failing.
- **Everything rtorrent exposes** — upload `.torrent` files, magnet links and URLs, global and
  per-torrent throttling, file priorities, tracker management, peers, labels, plus a raw API
  console and an XML-RPC passthrough for anything the UI does not wrap. The settings dialog
  covers the full tunable surface: slots, peer ranges, ports, binds, proxies, encryption,
  DHT, tracker TLS verification, disk preload/sync, socket buffers and resource limits —
  each control greyed out when the running rtorrent lacks it.
- **Drop torrents anywhere** — drag `.torrent` files onto the window and they are added and
  started on the spot, no dialog in the way.
- **Lightly gamified** — a level and a set of badges earned from real transfer totals, with a
  confetti burst when a download lands (stepped pixel rain in retro; falling ash, embers and
  distant lightning in black metal). Off with one environment variable if it is not for you.
- **Five themes** — system, light, dark, a retro 8-bit CRT mode, and a grim, frostbitten black
  metal mode. Preferences are stored on the server, so they follow the install rather than the
  browser.
- **Works on a phone** — the table becomes cards with their own sort control, the sidebar becomes
  a drawer that also carries the tools, and detail and dialogs become full-screen sheets.
- **Configured entirely from `docker run`** — the rtorrent backend options are environment
  variables.

## Quick start

Images are published to GitHub Container Registry for **linux/amd64** and **linux/arm64**
(so a Raspberry Pi 4/5 or an Apple-silicon Docker host works the same as an x86 server):

<!-- generated: usage -->
```bash
docker run \
  -d \
  --name=cascade \
  -e PUID=1000 \
  -e PGID=1000 \
  -e TZ=Europe/Stockholm \
  -e WEB_USER=admin \
  -e WEB_PASS=change-me \
  -e RT_PORT_RANGE=50000-50000 \
  -p 8080:8080 \
  -p 50000:50000 \
  -p 50000:50000/udp \
  -v /home/torrent/config:/config \
  -v /home/torrent/downloads:/downloads \
  -v /home/torrent/watch:/watch \
  --restart unless-stopped \
  ghcr.io/johanlindvall/cascade:latest
```
<!-- /generated -->

Open <http://localhost:8080>.

Two volumes matter: `/config` holds rtorrent's session, its log and
`cascade-state.json` (preferences, progress, throttle groups) and should be persistent;
`/downloads` is where the data lands. Port 50000 is the peer port — publish it on TCP **and** UDP
so DHT works — and `PUID`/`PGID` should match the owner of your download directory.

Stop it with `docker stop cascade` rather than `docker rm -f`: rtorrent only releases its session
lock on a clean shutdown.

### Image tags

Every push to `main` is published, so tags are cheap and specific:

| Tag | Points at |
| --- | --- |
| `latest` | The newest published build |
| `v0.1.42` | One exact release, built against the default rtorrent |
| `v0.1.42-0.16.20` | The same release, naming the rtorrent version explicitly |

The `-<rtorrent-version>` suffix is always present so that builds against other rtorrent releases
can be published under the same scheme later. Pin `vX.Y.Z-<rtorrent>` for anything you care about
keeping still; `latest` moves with `main`.

```bash
docker pull ghcr.io/johanlindvall/cascade:v0.1.42-0.16.20   # pin a release
docker pull ghcr.io/johanlindvall/cascade:latest            # follow main
```

> No login is needed — the package is public. If a pull ever comes back `denied`, check
> **Packages → cascade → Package settings → Change visibility**.

Upgrading is a pull and a re-create; all state lives in the two volumes:

```bash
docker pull ghcr.io/johanlindvall/cascade:latest
docker stop cascade && docker rm cascade
docker run -d --name cascade ...   # same flags as before
```

### Building it yourself

Nothing here needs the published image — the whole thing builds from source, and that is also how
you get an rtorrent version other than the default:

```bash
docker build -t cascade .
make build && make run     # build, run against ./data, open a browser
```

## Choosing the rtorrent version

The published images carry the default rtorrent; for any other version, build it yourself.
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

The image lists them all itself, so you never need this page to be up to date:

```bash
docker run --rm ghcr.io/johanlindvall/cascade:latest --help
```

Both that output and the tables below are generated from one catalog in the source
(`server/src/options.ts`), and CI fails if either drifts from what the container actually reads.

<!-- generated: options -->
### Paths and identity

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUID` | `1000` | User id rtorrent and the web server run as |
| `PGID` | `1000` | Group id rtorrent and the web server run as |
| `TZ` | `UTC` | Container timezone |
| `RT_DOWNLOAD_DIR` | `/downloads` | Default download directory |
| `RT_COMPLETED_DIR` | unset | Move finished downloads here |
| `RT_SESSION_DIR` | `/config/session` | rtorrent's session state |
| `RT_WATCH_DIR` | `/watch` | .torrent files dropped here are loaded and started |
| `RT_WATCH_ENABLE` | `1` | Set 0 to ignore the watch directory |
| `RT_WATCH_INTERVAL` | `10` | Watch-directory poll interval, seconds |
| `RT_LOG_FILE` | `/config/rtorrent.log` | rtorrent's log file, surfaced in the UI |
| `RT_LOG_LEVEL` | `info` | Log scopes: info, debug, dht_debug, tracker_debug, … |
| `RT_UMASK` | `0022` | umask rtorrent creates files with |
| `CASCADE_STATE_FILE` | `/config/cascade-state.json` | Preferences, progress, add times and throttle groups |
| `CASCADE_CHOWN_DOWNLOADS` | `0` | Set 1 to chown the download directory at startup (slow on large libraries) |
| `RT_SESSION_LOCK_KEEP` | `0` | Set 1 to keep a leftover rtorrent.lock instead of clearing it |

### Bandwidth and slots

Rates are in KiB/s; 0 means unlimited.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RT_DOWNLOAD_RATE` | rtorrent default | Global download limit |
| `RT_UPLOAD_RATE` | rtorrent default | Global upload limit |
| `RT_MAX_UPLOADS` | rtorrent default | Upload slots per torrent |
| `RT_MIN_UPLOADS` | rtorrent default | Minimum upload slots per torrent |
| `RT_MAX_UPLOADS_GLOBAL` | rtorrent default | Upload slots across all torrents |
| `RT_MAX_DOWNLOADS` | rtorrent default | Download slots per torrent |
| `RT_MIN_DOWNLOADS` | rtorrent default | Minimum download slots per torrent |
| `RT_MAX_DOWNLOADS_GLOBAL` | rtorrent default | Download slots across all torrents |

### Peers

| Variable | Default | Meaning |
| --- | --- | --- |
| `RT_MIN_PEERS` | rtorrent default | Minimum peers while leeching |
| `RT_MAX_PEERS` | rtorrent default | Maximum peers while leeching |
| `RT_MIN_PEERS_SEED` | rtorrent default | Minimum peers while seeding (-1 disables) |
| `RT_MAX_PEERS_SEED` | rtorrent default | Maximum peers while seeding (-1 disables) |
| `RT_PEX` | rtorrent default | Peer exchange, yes/no |

### Network

| Variable | Default | Meaning |
| --- | --- | --- |
| `RT_PORT_RANGE` | `50000-50000` | Incoming peer port range |
| `RT_PORT_RANDOM` | `no` | Pick a random port from the range, yes/no |
| `RT_PORT_OPEN` | rtorrent default | Open the listening port, yes/no (removed in rtorrent 0.16) |
| `RT_ENCRYPTION` | rtorrent default | e.g. allow_incoming,try_outgoing,enable_retry |
| `RT_BIND` | unset | Bind address for outgoing connections |
| `RT_IP` | unset | Address reported to trackers |
| `RT_BIND_IPV4` | unset | IPv4 bind address (rtorrent 0.16+) |
| `RT_BIND_IPV6` | unset | IPv6 bind address (rtorrent 0.16+) |
| `RT_PROXY` | unset | HTTP proxy for tracker announces |
| `RT_PROXY_HTTP` | unset | Proxy for all HTTP traffic (rtorrent 0.16+) |
| `RT_PROXY_GLOBAL` | unset | Proxy for all traffic (rtorrent 0.16+) |
| `RT_BLOCK_OUTGOING` | rtorrent default | yes refuses outgoing connections (rtorrent 0.16+) |

### Trackers and DHT

| Variable | Default | Meaning |
| --- | --- | --- |
| `RT_DHT` | rtorrent default | disable, off, auto or on |
| `RT_DHT_PORT` | rtorrent default | DHT UDP port |
| `RT_DHT_OVERRIDE_PORT` | rtorrent default | Announce a different DHT port (rtorrent 0.16+) |
| `RT_UDP_TRACKERS` | rtorrent default | Allow UDP trackers, yes/no |
| `RT_TRACKER_NUMWANT` | rtorrent default | Peers requested per announce (-1 leaves it to the tracker) |
| `RT_HTTP_CAPATH` | unset | Directory of CA certificates for tracker TLS |
| `RT_HTTP_CACERT` | unset | CA bundle file for tracker TLS |
| `RT_SSL_VERIFY_PEER` | rtorrent default | Verify tracker TLS certificates, yes/no |
| `RT_SSL_VERIFY_HOST` | rtorrent default | Verify tracker TLS hostnames, yes/no |

### Storage

| Variable | Default | Meaning |
| --- | --- | --- |
| `RT_PREALLOCATE` | rtorrent default | Preallocate files, yes/no |
| `RT_HASH_ON_COMPLETION` | rtorrent default | Re-verify on completion, yes/no |
| `RT_ADVISE_RANDOM_HASHING` | rtorrent default | Random-access hint while hashing, yes/no (rtorrent 0.16+) |
| `RT_MEMORY_MAX` | rtorrent default | Piece memory cap, bytes |
| `RT_MAX_FILE_SIZE` | rtorrent default | Largest accepted file, bytes |
| `RT_SYNC_TIMEOUT` | rtorrent default | Piece disk-sync timeout, seconds |
| `RT_PRELOAD_TYPE` | rtorrent default | Piece preload: 0 off, 1 madvise, 2 direct paging |
| `RT_PRELOAD_MIN_SIZE` | rtorrent default | Only preload torrents above this piece size, bytes |
| `RT_PRELOAD_MIN_RATE` | rtorrent default | Only preload above this upload rate, bytes/s |

### Resource limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `RT_MAX_OPEN_FILES` | rtorrent default | Open file handle cap |
| `RT_MAX_OPEN_SOCKETS` | rtorrent default | Open socket cap |
| `RT_MAX_HTTP_OPEN` | rtorrent default | Concurrent HTTP requests (read-only on rtorrent 0.16+) |
| `RT_HTTP_MAX_HOST` | rtorrent default | HTTP connections per host (rtorrent 0.16+) |
| `RT_DNS_CACHE_TIMEOUT` | rtorrent default | DNS cache lifetime, seconds |
| `RT_RECEIVE_BUFFER` | rtorrent default | Socket receive buffer, bytes |
| `RT_SEND_BUFFER` | rtorrent default | Socket send buffer, bytes |

### RPC

| Variable | Default | Meaning |
| --- | --- | --- |
| `RT_SCGI_SOCKET` | `/run/rtorrent/rpc.socket` | Unix socket rtorrent listens on |
| `RT_SCGI_PORT` | unset | Also listen for SCGI on this TCP port (unauthenticated — keep it private) |
| `RT_SCGI_BIND` | `127.0.0.1` | Interface for RT_SCGI_PORT |
| `RT_XMLRPC_SIZE_LIMIT` | `16777216` | Max XML-RPC request size, bytes (raises the .torrent upload ceiling) |
| `CASCADE_SCGI` | RT_SCGI_SOCKET | Endpoint the web server talks to — a path, or host:port for a remote rtorrent |

### Web server

| Variable | Default | Meaning |
| --- | --- | --- |
| `WEB_PORT` | `8080` | HTTP port |
| `WEB_HOST` | `0.0.0.0` | Bind address |
| `WEB_USER` | unset (no auth) | Basic-auth user; auth is enabled only when both are set |
| `WEB_PASS` | unset (no auth) | Basic-auth password |
| `WEB_BASE_PATH` | `/` | Serve under a sub-path, e.g. /rtorrent |
| `CASCADE_ALLOW_RAW_RPC` | `1` | Set 0 to disable the API console and /RPC2 |
| `CASCADE_ALLOW_DATA_DELETE` | `1` | Set 0 to forbid deleting downloaded data |
| `CASCADE_DELETE_ROOTS` | download + completed dirs | Extra :-separated roots data may be deleted from |
| `CASCADE_MAX_UPLOAD_MB` | `64` | Largest accepted .torrent upload, MiB |
| `CASCADE_POLL_MS` | `1000` | Backend sampling interval for the rate graph, ms |
| `CASCADE_GAMIFY` | `1` | Set 0 to remove levels, badges and celebrations |
| `CASCADE_WEB_ROOT` | `/app/web` | Directory the built UI is served from |

### Escape hatches

Settings given as environment variables are applied over XML-RPC at startup rather than written into rtorrent.rc, so changes made in the UI last until the container restarts.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RT_EXTRA_CONFIG` | unset | Raw rtorrent.rc lines appended to the generated config |
| `RT_EXTRA_CONFIG_FILE` | unset | File of extra rtorrent.rc lines to append |
| `RT_CONFIG_FILE` | `/config/rtorrent.rc` | Use this rtorrent.rc verbatim instead of generating one |
| `RT_CONFIG_KEEP` | `1` | Set 0 to regenerate RT_CONFIG_FILE on every start |
| `CASCADE_BOOT_SETTINGS` | `/run/cascade/boot-settings.json` | Where the entrypoint stages the settings it hands the server |
<!-- /generated -->

## The UI

Click a torrent for details — general, files with per-file priority, live peers and trackers. Peer
and tracker rows expand for everything rtorrent knows: peer id, protocol extensions, direction,
encryption and the preferred/snubbed/unwanted/banned flags.

![Peers](docs/screenshot-peers.png)

Trackers show type, state, scrape counts and the peers returned by the last announce, with a
countdown to the next one; expanding a row adds announce intervals, success and failure timings,
and the latest event.

![Trackers](docs/screenshot-trackers.png)

Files can be prioritised individually — skip, normal or high — with per-file progress.

![Files](docs/screenshot-files.png)

Drag `.torrent` files onto the window — anywhere — and drop to add them. Magnet links and torrent
URLs can be dragged in the same way, straight from another browser tab.

![Drag and drop](docs/screenshot-drop.png)

Dropped files are added and started immediately — no dialog, no questions. The confirmation is a
pickup: a shockwave and sparks at the point of impact, a `+N torrents` score, and the payload
flying up into the Add button, which takes the hit. In the retro theme the pickup goes full
arcade — pixel rings, an eight-way pixel burst and points on the score; in black metal the drop
becomes a summoning — a sigil cast at the impact point, shards of ash and ember that fall as
they die, and the score counted in offerings.

![Drop pickup](docs/screenshot-drop-burst.png)

Torrents are checked before rtorrent sees them, so a file that is not really a torrent tells you
so instead of vanishing.

Use the **Add torrent** button when you want to choose a destination directory or label first, or
to paste magnet links and URLs.

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

Themes are chosen from the header: **System** (follows the OS), **Light**, **Dark**, a
**Retro 8-bit** mode with CRT phosphor colours, hard pixel edges, stepped progress bars,
scanlines and a pixel-art arcade wordmark — and **Black Metal**: flat black, bone lettering,
blood accents, film grain, torn
sawtooth edges, jagged progress bars, and the wordmark replaced by a properly unreadable band
logo. The gamification layer is re-carved to match — levels become ranks like *Sower of Plagues*,
and the badges become sigils such as *First Blood* and *Eternal Winter*.

![Black metal theme](docs/screenshot-blackmetal.png)

![The Grimoire](docs/screenshot-blackmetal-grimoire.png)

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

### On small screens

The layout adapts rather than shrinking. Columns drop by usefulness as the window narrows, and
below 720px the table becomes a card list with its own sort control in the toolbar, the sidebar
becomes a drawer behind the filter button — carrying the settings, throttle and console tools as
well as the filters — and the detail pane and dialogs become full-screen sheets. The live
transfer rates stay in the header. Touch gets larger targets, a long press stands in for
right-click, and polling pauses while the tab is in the background.

<p>
  <img src="docs/screenshot-mobile.png" alt="Mobile layout" width="290">
  <img src="docs/screenshot-mobile-drawer.png" alt="Filter drawer" width="290">
</p>

Keyboard: `n` add torrents · `/` search · `↑`/`↓` move through the list · `Ctrl/⌘+A` select all ·
`Delete` remove · `Shift+Delete` remove with data · `Esc` close details and clear the selection.
Rows support `Ctrl`-click and `Shift`-click ranges, and the right-click menu can copy a torrent's
magnet link.

## API

All endpoints live under `/api` and honour the same Basic auth as the UI.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness (deliberately outside Basic auth, for healthchecks) |
| `GET` | `/api/state` | Torrents, global status, throttle groups (the UI's poll) |
| `GET` | `/api/torrents?view=main` | Torrent list for an rtorrent view |
| `GET` | `/api/status` | Global rates, limits and backend summary on their own |
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
| `POST` | `/api/rpc/help` | `system.methodHelp` / `methodSignature` for one command |
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
- rtorrent locks its session directory and only releases the lock on a clean shutdown, so a killed
  container (`docker rm -f`, OOM, host reboot) leaves one behind and every later start fails. The
  entrypoint clears a lock that no live process in the container holds; set
  `RT_SESSION_LOCK_KEEP=1` if you deliberately share a session directory and want the check to
  refuse instead. Stop the container with `docker stop` (as `make stop` does) to avoid it entirely.

## Development

The whole toolchain lives in the image; no local Node is required. The Makefile wraps the usual
work — `make` on its own lists every target.

```bash
make build                  # build the image (typechecks both TypeScript halves)
make run PORT=8080          # run it, mounting ./data, then open it in a browser
make run OPEN=0             # ...without launching a browser
make open                   # wait for it to answer, then open it
make smoke                  # build, boot, exercise the API, tear down
make matrix                 # build against 0.9.8, 0.15.2 and 0.16.20
make build RTORRENT_VERSION=0.9.8
make attach                 # attach to rtorrent's curses UI
make logs / shell / stop
```

CI (GitHub Actions) runs the same checks: a fast typecheck of both TypeScript halves on every
push and pull request, plus a full image build with an API smoke test on pull requests. A
compatibility matrix against rtorrent 0.9.8 and 0.15.2 can be run from the Actions tab
(**Run workflow → full-matrix**).

Pushing to `main` releases. The release workflow tags the commit `v0.1.<run number>`, builds the
image for amd64 and arm64 on native runners, boots each one and probes its API, and only then
joins them into the tagged manifests described under [Image tags](#image-tags) — so a build that
does not run never claims a tag. Pushing a `vX.Y.Z` tag yourself publishes under that name
instead of an auto-generated one.

`make run` waits for `/healthz` before launching the browser, so it opens on a working page rather
than a connection error. The launcher is `xdg-open` (`BROWSER=` overrides it, `open` is used as a
fallback on macOS); with no display detected it just prints the URL.

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
