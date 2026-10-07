# Cascade

[![CI](https://github.com/JohanLindvall/Cascade/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JohanLindvall/Cascade/actions/workflows/ci.yml?query=branch%3Amain)
[![Image](https://img.shields.io/github/v/tag/JohanLindvall/Cascade?label=image)](https://github.com/JohanLindvall/Cascade/pkgs/container/cascade)
[![License](https://img.shields.io/github/license/JohanLindvall/Cascade)](LICENSE)
[![Live demo](https://img.shields.io/badge/demo-live-7c9bff)](https://johanlindvall.github.io/Cascade/)

**Cascade** is a web UI for [rtorrent](https://github.com/rakshasa/rtorrent), shipped as one
Docker image for linux/amd64 and linux/arm64 with rtorrent compiled from its upstream release tag
inside. A small Go server speaks rtorrent's XML-RPC over SCGI and streams every open page a
snapshot and then only what changed, as server-sent events; the same server and React UI drive
every rtorrent from 0.9.8 to the release the image ships, because they ask the running one which
commands it has. Everything is configured with environment variables on `docker run`.

**[Try the live demo](https://johanlindvall.github.io/Cascade/)** — the real UI against a
simulated rtorrent, in your browser — or run it:

```bash
docker run -d --name cascade --stop-timeout 60 \
  -e WEB_USER=admin -e WEB_PASS=change-me \
  -p 127.0.0.1:8080:8080 -p 50000:50000 -p 50000:50000/udp \
  -v cascade-config:/config -v cascade-downloads:/downloads \
  ghcr.io/johanlindvall/cascade
```

and open <http://localhost:8080>. Choose your own password, and keep one even on your own machine:
without it, any web page you visit could reach Cascade
([SECURITY.md](SECURITY.md#what-cascade-protects-and-what-it-does-not)). The
[quick start](#quick-start) has the full command: your own folders, the time zone.

![Main view](docs/screenshot-main.png)

## Highlights

- **One container, batteries included** — rtorrent, its config, and the UI. Nothing else to run,
  published for amd64 and arm64, and buildable from source in one command.
- **rtorrent 0.16.25, compiled from source** — the version in the image is exactly the upstream
  tag you asked for, not whatever a distro packaged. Any other tag builds with one build arg.
- **Live, and light on rtorrent** — open pages watch one server-sent event stream: a snapshot,
  then only what changed, compressed. rtorrent is read once per interval however many pages are
  open, not at all while none is, and straight after every change made in the UI, so an action
  shows at once. Watching 500 torrents costs well under a kilobyte a second on the wire.
- **Works across backend versions** — the server probes `system.listMethods` on connect and picks
  command names from what the running rtorrent actually implements, hiding unsupported controls
  in the UI instead of failing.
- **Private-tracker aware** — a release newer than 0.16.20 announces itself as 0.16.20, User-Agent
  and peer id together, because private trackers refuse client versions they have not whitelisted
  yet; two build arguments [choose another identity](#the-version-presented-to-trackers).
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
  --stop-timeout 60 \
  ghcr.io/johanlindvall/cascade:latest
```
<!-- /generated -->

Open <http://localhost:8080>.

Two volumes matter: `/config` holds rtorrent's session, its log and
`cascade-state.json` (preferences, progress, throttle groups) and should be persistent;
`/downloads` is where the data lands. Port 50000 is the peer port — publish it on TCP **and** UDP
so DHT works — and `PUID`/`PGID` should match the owner of your download directory.

Stop it with `docker stop cascade` rather than `docker rm -f`. Only a clean shutdown tells the
trackers the client is leaving, saves the session and releases rtorrent's lock, and with a tracker
that is slow to answer that takes ten seconds or more — which is why the container is created with
`--stop-timeout 60` (under Compose, `stop_grace_period: 60s`). Without it, `docker stop` gives up
after Docker's default ten seconds and kills rtorrent mid-shutdown.

### Image tags

Every push to `main` is published, so tags are cheap and specific:

| Tag | Points at |
| --- | --- |
| `latest` | The newest published build |
| `v0.1.42` | One exact release, built against the default rtorrent |
| `v0.1.42-0.16.23` | The same release, naming the rtorrent version explicitly |

The `-<rtorrent-version>` suffix is always present so that builds against other rtorrent releases
can be published under the same scheme later. Pin `vX.Y.Z-<rtorrent>` for anything you care about
keeping still; `latest` moves with `main`.

```bash
docker pull ghcr.io/johanlindvall/cascade:v0.1.42-0.16.23   # pin a release
docker pull ghcr.io/johanlindvall/cascade:latest            # follow main
```

> No login is needed — the package is public. If a pull ever comes back `denied`, check
> **Packages → cascade → Package settings → Change visibility**.

Upgrading is a pull and a re-create; all state lives in the two volumes:

```bash
docker pull ghcr.io/johanlindvall/cascade:latest
docker stop -t 60 cascade && docker rm cascade
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
rtorrent and libtorrent are always compiled from upstream tags. The default is **0.16.25**:

```bash
docker build -t cascade .                                       # the default
docker build --build-arg RTORRENT_VERSION=0.15.2 -t cascade:0.15.2 .
docker build --build-arg RTORRENT_VERSION=0.9.8  -t cascade:0.9.8 .
make matrix                                                     # 0.9.8, 0.15.2 and the default
```

New releases arrive on their own: a scheduled workflow (`.github/workflows/rtorrent-update.yml`)
looks upstream every morning and, once rtorrent and libtorrent have both tagged a newer release,
opens a pull request moving the default to it; merging it publishes the images. `make bump-rtorrent`
makes the same edit by hand (`TO=x.y.z` for a particular release). The default is written once, in
the Dockerfile's `RTORRENT_VERSION` — the Makefile and the release workflow read it from there.

libtorrent is pinned to the matching release automatically — rtorrent 0.9.x pairs with libtorrent
0.13.x, 0.10.x with 0.14.x, and from 0.15 the two share a version. `LIBTORRENT_VERSION` overrides
that, and `RTORRENT_REPO`/`LIBTORRENT_REPO` point at forks. `ALPINE_VERSION` (default 3.22) picks
the base image.

### The version presented to trackers

A client identifies itself twice: the HTTP `User-Agent` rtorrent sends to a tracker, and the peer
id prefix libtorrent gives every peer and tracker. Private trackers whitelist client versions and
refuse anything newer than their list, which rtorrent surfaces only as a failed announce — so
**any release newer than 0.16.20 presents itself as 0.16.20 by default**
(`USER_AGENT=rtorrent/0.16.20`, `PEER_NAME=-lt1014-`). It is a rule rather than a list, so a new
default release does not start failing announces the day it lands; older releases present
themselves as what they are. Both are build arguments, because rtorrent and libtorrent bake them in
at compile time and expose no command to change them while running:

```bash
make build RTORRENT_VERSION=0.16.24 USER_AGENT=rtorrent/0.16.24 PEER_NAME=-lt1018-  # 0.16.24, as itself
make build USER_AGENT=rtorrent/0.9.8 PEER_NAME=-lt0D80-
docker build --build-arg USER_AGENT=rtorrent/0.9.8 --build-arg PEER_NAME=-lt0D80- -t cascade .
make version                                                # what the image presents
```

Set the two together: a tracker that checks both sees a mismatch if only one moves. The peer id
prefix is `-lt0D80-` for 0.13.8 (with rtorrent 0.9.8); from 0.15 on it is `-lt` and the minor and
patch release as two hex digits each — `-lt0F02-` (0.15.2), `-lt1014-` (0.16.20), `-lt1018-`
(0.16.24).

The UI adapts at runtime, so one build of the frontend drives any of them — 0.9.8, 0.15.2 and the
default are all exercised by the same API suite. Which backend you got is shown under the logo and
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
blocking, and a random-access hint for hashing. On older backends unsupported controls are disabled.

0.16.24 dropped rtorrent's `address%device` form of a bind address in favour of separate
`network.bind_device` commands, so from that release `RT_BIND`, `RT_BIND_IPV4` and `RT_BIND_IPV6`
take a plain address.

## Configuration

Everything is an environment variable on `docker run`. Only what you set is applied — anything
left unset keeps rtorrent's own default.

The image lists them all itself, so you never need this page to be up to date:

```bash
docker run --rm ghcr.io/johanlindvall/cascade:latest --help
```

Both that output and the tables below are generated from one catalog in the source
(`server/internal/options/options.go`), and CI fails if either drifts from what the container
actually reads.

A value that does not parse stops the container at start, with a message naming the variable,
rather than quietly becoming a default. Every on/off option — the `Set 0`/`Set 1` switches and
the rtorrent settings marked yes/no — takes `1`, `true`, `yes` or `on` and `0`, `false`, `no` or
`off`, in any case. `RT_UMASK` is octal, as `umask` reads it (`22` means `0022`),
`RT_WATCH_INTERVAL` takes seconds or a time such as `00:00:10`, and `RT_SCGI_PORT` is decimal
(`05000` is port 5000). With your own `RT_CONFIG_FILE` kept, what only the generated `rtorrent.rc`
would carry — the umask, the watch interval, the random-port switch — is ignored rather than
checked. The SCGI settings are not: Cascade waits for your rc to open the socket at
`RT_SCGI_SOCKET` or, when `RT_SCGI_PORT` is set, that port on `RT_SCGI_BIND`, and connects to the
one it opened. Earlier releases ignored `RT_SCGI_PORT` and `RT_SCGI_BIND` with a kept rc; now that
they are read, a leftover `RT_SCGI_PORT` that is not a port, or a bind beside it that is not an
address, stops the start until it is corrected or unset.

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
| `RT_WATCH_INTERVAL` | `10` | Watch-directory poll interval: seconds, MM:SS or HH:MM:SS |
| `RT_LOG_FILE` | `/config/rtorrent.log` | rtorrent's log file, surfaced in the UI |
| `RT_LOG_LEVEL` | `info` | Log scopes: info, debug, dht_debug, tracker_debug, … (more can be raised live from the log dialog) |
| `RT_UMASK` | `0022` | umask rtorrent creates files with, in octal |
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
| `RT_SCGI_SOCKET` | `/run/rtorrent/rpc.socket` | Unix socket rtorrent listens on, unless RT_SCGI_PORT is set |
| `RT_SCGI_PORT` | unset | Listen for SCGI on this TCP port instead of the socket (unauthenticated — keep it private) |
| `RT_SCGI_BIND` | `127.0.0.1` | Address RT_SCGI_PORT listens on; 0.0.0.0 lets a published port reach it |
| `RT_XMLRPC_SIZE_LIMIT` | `16777216` | Max XML-RPC request size, bytes (raises the .torrent upload ceiling) |
| `CASCADE_SCGI` | RT_SCGI_SOCKET, or RT_SCGI_PORT (on 127.0.0.1 for a wildcard RT_SCGI_BIND) | Endpoint the web server talks to — a path, or host:port for a remote rtorrent |

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
| `CASCADE_MAX_UPLOAD_MB` | `64` | Maximum combined .torrent file size per upload batch, MiB |
| `CASCADE_POLL_MS` | `1000` | Backend sampling interval for the rate graph, ms |
| `CASCADE_STATE_POLL_MS` | `500` | How often the torrent list is read while a page is open, ms (100-60000; the UI can override it) |
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

The keyboard works throughout: `/` focuses search (`Esc` there clears it), `n` opens the Add
dialog, `↑`/`↓` walk the list and `Home`/`End` jump to its ends — with `Shift` held they extend
the selection, as `Shift`-click does from the last row clicked, while `Ctrl/⌘`-click toggles one
row and `Ctrl/⌘+Shift`-click adds a range. `Ctrl/⌘-A` selects everything visible, `Delete` (or
`⌘⌫`) removes the selection and `Shift-Delete` also deletes its data, and the menu key or
`Shift-F10` opens the right-click menu on the current row, arrow keys moving through it. `Esc`
closes one thing at a time: a menu, a dialog (only the top one, when a confirmation sits on
another), the filter drawer, then the selection. The column headers sort from the keyboard, the
detail tabs follow the arrow keys, and the detail pane's resize handle takes `↑`/`↓`. Removing
asks first, in a dialog that lists what is about to go; setting a label or a directory lists the
torrents it applies to and offers the labels already in use.

On a phone, a card opens its details; its checkbox selects it for bulk actions without opening
the details sheet. The filters drawer and details sheet keep keyboard focus inside while open;
`Esc` closes them and returns focus to the opener.

Actions reach only what is on screen. A selection survives a search or a filter change —
narrowing the list to find one more torrent does not drop the ones already picked — but the rows
it hides are left alone until they are shown again: the selection pill counts them
(`2 selected +1 hidden`), and `Delete` cannot reach a torrent you cannot see.

Private trackers put your passkey in the announce URL, so the UI masks it wherever a URL is
shown — the Trackers tab, tracker messages, the log — as `passkey=•••`, along with other
credential-looking parameters and `user:password@`. Copied magnet links leave trackers out
altogether.

The log reads as a log: rtorrent's raw epoch seconds become clock times in your own timezone,
with the level shown as colour (warnings amber, errors red) and a separator wherever the log
crosses midnight. A line that is not in rtorrent's format is shown exactly as written.

The log dialog carries a **Verbosity** row: the scopes `RT_LOG_LEVEL` baked in at container start
show as fixed tags, and the rest — `debug`, `tracker_debug`, `dht_debug` and friends — toggle live,
no restart. Raising one takes effect immediately and is remembered (re-attached after every
rtorrent restart, like throttle groups). After switching one off, restart the **container** to
stop it: rtorrent has no command to detach a log scope, and a scope saved before boot also lives
in the generated rc until the container regenerates it. The toast explains this. The
subsystem groups moved between releases (0.9.x has `tracker_debug` and friends, 0.16 replaced
them with `tracker_events`), so the row offers the union and a scope this build does not have is
refused by name. A raised scope is remembered in the state file, so it survives a container
restart as well — written straight into the generated `rtorrent.rc`, which is what lets it cover
rtorrent's own startup rather than starting once the web server has connected.

A torrent that rtorrent has stopped with an error — most famously *"Download registered as
completed, but hash check returned unfinished chunks"* — carries a **Recheck & restart** button on
the error banner in its details (and in the right-click menu): the data is rechecked and the
torrent started again the moment the check completes, so the missing chunks are fetched instead of
the torrent sitting stopped behind a finished progress bar. A plain **Force recheck** still leaves
the torrent stopped for inspection.

Click a torrent for details — general, files with per-file priority, live peers and trackers. Peer
and tracker rows expand for everything rtorrent knows: peer id, protocol extensions, direction,
encryption and the preferred/snubbed/unwanted/banned flags.

![Peers](docs/screenshot-peers.png)

Trackers show type, state, scrape counts and the peers returned by the last announce, with a
countdown to the next one; expanding a row adds announce intervals, success and failure timings,
and the latest event. An announce URL (`http(s)://` or `udp://`) can be added at the foot of the
tab.

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
to paste magnet links and URLs. Its dropzone takes links as well as files: a magnet dragged onto it
joins the link list.

![Add torrents](docs/screenshot-add.png)

Sharing earns levels and badges. Every number behind them is a real transfer total pulled from
rtorrent — uploaded bytes, completed downloads, peak rates — accumulated across restarts, and XP
leans on uploading rather than downloading. Set `CASCADE_GAMIFY=0` and the whole layer disappears.

![Progress and badges](docs/screenshot-progress.png)

rtorrent's live settings are editable, with anything the running version does not support greyed
out. Rate fields take `500k`, `2M`, `1.5 MiB/s` or `800 B/s` — a bare number is KiB/s, empty is
unlimited — and anything else is flagged at the field and holds **Apply** back, rather than being
read as "unlimited". The same dialog's **Interface** section sets how often the list refreshes,
from 100 ms to a minute; the server's default is `CASCADE_STATE_POLL_MS`. Each refresh reads every
torrent from rtorrent, which is single-threaded, so the cost grows with both the rate and the
library. Measured with 110 torrents, refreshing every 100 ms took about 9% of a CPU core in
rtorrent and the 500 ms default about 2%; 500 torrents cost roughly four times as much. Nothing
is read for it while no page is open.

![Settings](docs/screenshot-settings.png)

rtorrent has no per-torrent rate limit — it throttles by *named group*. Create groups here and
assign torrents to them from the right-click menu; deleting one asks first.
Group limits round up to whole KiB/s, rtorrent's precision for named groups: `800 B/s` becomes
`1 KiB/s`. Global limits retain byte precision. The dialog shows the saved value after an edit.

![Throttle groups](docs/screenshot-throttles.png)

Anything not wrapped by the UI is reachable from the API console, which lists every command the
backend exposes with its help text. With `CASCADE_ALLOW_RAW_RPC=0` the console leaves the UI, and
with `CASCADE_ALLOW_DATA_DELETE=0` so does *Remove + delete data*: the server refuses both
regardless, and the UI stops offering them.

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
persistent state, and deleting it resets everything. A file Cascade cannot read is not
overwritten: it is kept as `cascade-state.json.corrupt` (or `.corrupt.1`, `.corrupt.2`, … when
one is already there) and Cascade starts from an empty state.

### On small screens

The layout adapts rather than shrinking. Columns drop by usefulness as the window narrows, and
below 720px the table becomes a card list with its own sort control in the toolbar, the sidebar
becomes a drawer behind the filter button — carrying the settings, throttle and console tools as
well as the filters — and the detail pane and dialogs become full-screen sheets. The live
transfer rates stay in the header. Touch gets larger targets, a long press stands in for
right-click, and the live stream pauses while the tab is in the background.

<p>
  <img src="docs/screenshot-mobile.png" alt="Mobile layout" width="290">
  <img src="docs/screenshot-mobile-drawer.png" alt="Filter drawer" width="290">
</p>

## API

All endpoints live under `/api` and honour the same Basic auth as the UI.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness (outside Basic auth and always available at the root, even with `WEB_BASE_PATH`) |
| `GET` | `/api/state` | Torrents, global status, throttle groups and the game, all at once |
| `GET` | `/api/stream` | The same state as server-sent events: a snapshot, then deltas ([below](#the-state-stream)) |
| `GET` | `/api/torrents?view=main` | Torrent list for an rtorrent view |
| `GET` | `/api/status` | Global rates, limits, backend summary and policy on their own |
| `GET` | `/api/capabilities` | Backend version and supported feature map |
| `GET` | `/api/game` | Level, XP and badge progress, each badge with its unit |
| `GET`/`PATCH` | `/api/prefs` | UI preferences (theme, sort, layout, refresh interval) |
| `GET` | `/api/torrents/:hash/files` \| `/peers` \| `/trackers` | Per-torrent detail |
| `GET` | `/api/trackers?hashes=` | The main tracker's host for each of a comma-separated list of hashes |
| `POST` | `/api/torrents/upload` | Multipart: repeated `torrents` file fields, `urls`, `start`, `directory`, `label` |
| `POST` | `/api/torrents/url` | Add one magnet/URL as JSON |
| `POST` | `/api/torrents/:hash/action/:action` | `start`, `stop`, `pause`, `resume`, `recheck`, `recheck-restart`, `announce` |
| `POST` | `/api/torrents/action/:action` | Same, for a list of hashes |
| `PATCH` | `/api/torrents/:hash` | `priority` (0 off … 3 high), `label`, `throttle`, `directory`, `maxUploads`, `maxDownloads` |
| `POST` | `/api/torrents/remove` | Remove hashes, optionally `deleteData` |
| `DELETE` | `/api/torrents/:hash?deleteData=false` | Remove one torrent, optionally its data |
| `POST` | `/api/torrents/:hash/files/:index/priority` | `0` skip, `1` normal, `2` high |
| `POST` | `/api/torrents/:hash/trackers` | Add an announce URL: `url` (`http(s)://`, `udp://`), optional `group` |
| `POST` | `/api/torrents/:hash/trackers/:index/enabled` | Enable/disable a tracker |
| `GET`/`POST` | `/api/settings` | Read/write rtorrent's live settings |
| `GET`/`POST` | `/api/throttles` | List or save groups: `name`, `up`, `down` (bytes/s) |
| `PATCH`/`DELETE` | `/api/throttles/:name` | Change either limit without replacing the other, or delete a group |
| `GET` | `/api/log?lines=300` | Tail of the rtorrent log (1-2000 lines) |
| `GET`/`POST` | `/api/log/scopes` | Log verbosity: raise scopes live, on top of `RT_LOG_LEVEL` |
| `GET` | `/api/rpc/methods`, `POST` `/api/rpc` | Every rtorrent command, as JSON |
| `POST` | `/api/rpc/help` | `system.methodHelp` / `methodSignature` for one command |
| `POST` | `/RPC2` | Raw XML-RPC passthrough |

Malformed input — a hash that is not forty hex digits, a priority outside its range, a file
index that is not a number, a tracker that is not an announce URL — is answered with a `400`
naming the field. Adding a torrent the session already holds — a `.torrent` or a magnet
with the same info hash — is a `409` naming it rather than a success: rtorrent would drop the load,
and its label and directory, without a word. In an upload batch it is one of the per-file
`errors`. Bulk routes validate every hash before applying anything, normalize case and
deduplicate, then return runtime failures by hash in `errors`. Numeric settings reject null,
booleans, fractions, unsafe integers and malformed strings; a typo cannot become unlimited.

Uploads accept up to 50 files and URLs combined. `CASCADE_MAX_UPLOAD_MB` bounds the combined
file bytes in a batch. The response contains `added`, `errors`, `failedFiles` and `failedUrls`;
the last two are zero-based indices into the submitted files and non-empty URL lines. The Add
dialog keeps failed items for retry and removes successful ones. Uploaded v1 and hybrid torrents
are structurally validated before loading; v2-only torrents are rejected with an explanation. A
`directory` with a control character in it (a line break, say) is refused: it would reach
rtorrent inside a command.

A change, once sent, is carried through even if the client goes away, `/RPC2` included: a closed
tab does not leave a torrent stopped halfway through a throttle change.

A browser only gets to change things from the UI's own origin. A `POST`, `PATCH` or `DELETE` that
the browser marks as cross-site — by `Sec-Fetch-Site`, or an `Origin` with another scheme, host or
port — is refused with a `403` before auth is even considered, so a page elsewhere cannot use a
signed-in browser (Basic credentials ride along automatically) to add torrents or change settings.
Requests without those headers — `curl`, scripts, other tools — are unaffected. Every response
also carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.

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

`/RPC2` also takes a JSON body — `{"method": "...", "params": [...]}` — which Cascade encodes
for you (the answer is still XML-RPC), as the API console's `POST /api/rpc` does (that one
answers in JSON). Either refuses a whole number outside the 64-bit range with a `400` naming it:
rtorrent crashes on such an `<i8>` rather than faulting, and refuses `<double>` altogether, so
there is nothing safe to send.

To expose rtorrent's own SCGI interface instead, set `RT_SCGI_PORT=5000` and
`RT_SCGI_BIND=0.0.0.0`, then publish the port (`-p 127.0.0.1:5000:5000` keeps it to the host).
rtorrent takes a single SCGI listener, so the port replaces the unix socket rather than joining
it, and Cascade follows it there — over `127.0.0.1:5000` for a wildcard bind like this one, unless
`CASCADE_SCGI` says otherwise. The bind defaults to `127.0.0.1`, the loopback, which a published
port does not reach — it arrives on the container's own address — hence `0.0.0.0`, which also
opens the port to the container's network. Even the loopback is shared by everything in the
container's network namespace, whatever its user: the host's processes under `--network host`,
and every container joined to it with `--network container:…`, such as a VPN sidecar; the unix
socket, with the default umask, admits only `PUID` and root. **SCGI is unauthenticated** — anyone
who reaches it has full control of rtorrent and can run commands in the container, with its
volumes, through `execute`. Keep it on a private network, or prefer `/RPC2`, which sits behind
Basic auth.

### The state stream

`GET /api/stream` is what the UI watches, and anything else may watch it too. It is a
server-sent event stream (compressed with zstd or gzip when the client takes either) with four
events:

- `snapshot` — the whole state, as `/api/state` would answer, except that `torrents` is an object
  keyed by info hash and `status.history` one keyed by `t`, so an entry added or removed patches
  that one entry instead of every index after it;
- `delta` — a patch that turns the previous state into the next: an object patches an object key
  by key (its `"-"` member lists the keys that are gone), an object patches a same-length array
  index by index, `{"=": value}` replaces whatever was there, and anything else replaces the old
  value;
- `failure` — `{"error": "…"}`: rtorrent cannot be read right now; the stream stays open;
- `ok` — `{}`: it can again.

Each `snapshot` and `delta` carries an id. A client that reconnects with `Last-Event-ID` (as
`EventSource` does by itself) or `?since=<id>` is sent the deltas it missed while the server still
has them, and a snapshot otherwise. The state is read once per interval — `CASCADE_STATE_POLL_MS`,
or the interval chosen in the UI's settings — however many clients are watching, not at all while
none is, and at once after any change made through the API. A comment line every 20 seconds keeps
an idle stream open through proxies.

A browser may open the stream only from the UI's own origin, like a change (see above): an open
stream keeps rtorrent busy. At most 100 streams are open at once; one more is answered `503` with
`Retry-After`.

```bash
curl -N --compressed -u admin:change-me http://localhost:8080/api/stream
```

## Notes and limitations

- File names longer than Linux allows are shortened to fit. A path component is capped at 255
  bytes on ext4/xfs/btrfs and libtorrent opens files under the exact name from the torrent, so a
  Thai, CJK or emoji-heavy title of ~85 characters used to fail with *"Hash check I/O error at
  chunk 0: Filename too long"* and never start. The rtorrent in the image is built with a small
  libtorrent patch (`docker/patches/`) that cuts such a name at a character boundary, keeps the
  extension, and appends `~` plus a short hash of the original to distinguish long names;
  the torrent keeps its own names in the list and the Files tab, which notes *on disk as …*
  where the two differ.
- Global settings changed in the UI are not persisted to `rtorrent.rc`; the environment is the
  source of truth on restart.
- "Change directory" stops the torrent and updates its saved path. Move already-downloaded files
  yourself, then use **Recheck & restart** before transferring at the new location.
- Deleting torrent data is confined to `RT_DOWNLOAD_DIR`, `RT_COMPLETED_DIR` and any
  `CASCADE_DELETE_ROOTS`. Paths are checked before removing metadata, and deletion stays anchored
  to an open root directory even if symlinks change. A root itself cannot be deleted.
- Completion moves use the actual on-disk filename, refuse existing destinations, and reopen
  the torrent at its new location. A failed move leaves the source data in place.
- Throttle groups cannot be removed from a running rtorrent — deleting one sets it to unlimited
  and drops it from the UI list.
- rtorrent runs inside a detached `screen` session, so `docker exec -it cascade cascade-attach`
  gives you the real curses UI (detach with ctrl-a d). If rtorrent dies, the entrypoint restarts
  it.
- The image has a `HEALTHCHECK` of its own: `cascade health` asks the server's `/healthz`, which
  answers outside Basic auth and at the root whatever `WEB_BASE_PATH` is. There is no `curl` in
  the image, so a Compose `healthcheck:` of your own should run `cascade health` too.
- rtorrent locks its session directory and only releases the lock on a clean shutdown, so a killed
  container (`docker rm -f`, OOM, host reboot) leaves one behind and every later start fails. The
  entrypoint clears a lock that no live process in the container holds; set
  `RT_SESSION_LOCK_KEEP=1` if you deliberately share a session directory and want the check to
  refuse instead. Stop the container with `docker stop` and a minute to spare (`--stop-timeout 60`
  when it is created, or `docker stop -t 60`, as `make stop` does) to avoid it entirely.
  The same lock check runs before an automatic in-container rtorrent restart. Saved log scopes
  unsupported by a different rtorrent version are skipped with a container-log message.

## Development

The whole toolchain lives in the image; no local Go or Node is required (bar `make dev` and
`make demo`, below).
The Makefile wraps the usual work — `make` on its own lists every target.

```bash
make build                  # build the image (Go vet + tests, web typecheck + tests)
make test                   # just the suites: Go, web and shell, without compiling rtorrent
make race                   # the Go suites under the race detector
make run PORT=8080          # run it, mounting ./data, then open it in a browser
make run OPEN=0             # ...without launching a browser
make open                   # wait for it to answer, then open it
make smoke                  # build, boot, exercise the API, tear down (Python 3 required)
make matrix                 # build against 0.9.8, 0.15.2 and the default
make build RTORRENT_VERSION=0.9.8
make bump-rtorrent          # move the default to the newest upstream release
make attach                 # attach to rtorrent's curses UI
make logs / shell / stop
```

Both halves carry unit tests beside their sources. The server (`server/`, a Go module) is tested
from the XML-RPC codec up to the HTTP routes: the client and the capability probe run against a
scripted transport, the service against a fake client that records what would have reached
rtorrent, and the HTTP layer is mounted on a spare port and driven over real requests. The web's
tests (`web/src/**/*.test.ts`) are typechecked, then run by node's built-in runner — no
frameworks. `docker/scripts.test.sh` covers the shell: the release bump, User-Agent escaping,
completion moves, and the entrypoint's rc rendering, value checks and session-lock handling. All
three run inside every image build, so a red test fails the build exactly as a type error does;
`make test` runs them alone.

`docker/api-smoke.py` (Python 3's standard library only) exercises a running container against
the rtorrent inside it: readiness, the `/RPC2` passthrough, validation and error shapes, the
cross-site guard, compression and cache headers, setting and throttle round trips in rtorrent's
own units, the state stream, and the long file name patch. It restores what it changes, but
point it at a disposable container — `make smoke` makes one and removes it even when a check
fails, and CI and the release run the same script against every image they build:

```bash
python3 docker/api-smoke.py http://127.0.0.1:18080 [container-name]
```

The server has two dependencies: [lightning](https://github.com/JohanLindvall/lightning), which
decodes its JSON, and [klauspost/compress](https://github.com/klauspost/compress), which
compresses its responses with zstd or gzip.

CI (GitHub Actions) runs the same checks — gofmt, the server's vet and tests under the race
detector, the option catalog check, the shell tests, and the web's typecheck and tests — on every
push and pull request, plus a full image build with the API smoke test on pull requests. A
compatibility matrix against rtorrent 0.9.8 and 0.15.2 can be run from the Actions tab (**Run
workflow → full-matrix**). Dependencies are kept up by two bots: Dependabot for the Go modules,
the npm packages and the Actions, and the daily rtorrent workflow described under
[Choosing the rtorrent version](#choosing-the-rtorrent-version).

Pushing to `main` releases. The release workflow builds the image for amd64 and arm64 on native
runners, boots each one and probes its API, joins them into the tagged manifests described under
[Image tags](#image-tags), and only then tags the commit `v0.1.<run number>` — so a build that does
not run never claims a tag, in the registry or in git. Pushing a `vX.Y.Z` tag yourself publishes under that name
instead of an auto-generated one. A push that touches the web UI also republishes the
[live demo](https://johanlindvall.github.io/Cascade/) to GitHub Pages (`pages.yml`), after running
the web's tests.

`make run` waits for `/healthz` before launching the browser, so it opens on a working page rather
than a connection error. The launcher is `xdg-open` (`BROWSER=` overrides it, `open` is used as a
fallback on macOS); with no display detected it just prints the URL.

Working on the frontend with live reload, against a running container — one of the two targets
that need a local Node:

```bash
make dev                                 # cd web && npm ci && npm run dev
                                         # proxies /api to localhost:8080
CASCADE_DEV_TARGET=http://nas:8080 make dev   # ...or to a container elsewhere
make demo                                # the live demo instead: no container at all
```

The demo (`web/src/demo`) is the same app over a simulated rtorrent that runs in the browser; it
answers every route the UI calls as the server does, so it has to follow API changes (AGENTS.md,
*Live demo*).

Layout:

```
Makefile       build/run/test wrappers around Docker
server/        the Go server: XML-RPC codec, SCGI transport, capability probe, REST API, state stream
web/src/       React UI (app/, components/, styles.css), and demo/: the live demo's simulated server
docker/        entrypoint that renders rtorrent.rc and supervises both processes,
               cascade-attach and the completion-move helper, the libtorrent/rtorrent
               patches, and the smoke and shell tests
```

See [AGENTS.md](AGENTS.md) for the architecture details and the rtorrent quirks worth knowing
before changing the backend.

## Security

Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes. It also sets out what
Cascade protects and what it leaves to you: authentication, raw RPC access, an exposed SCGI port.

## License

Cascade is released under the [MIT License](LICENSE); every source file carries its SPDX
identifier. The image also contains:

- rtorrent and libtorrent, under the GNU GPL (version 2 or later), compiled from their upstream
  release tags with the patches in [`docker/patches`](docker/patches);
- the Go modules compiled into the server — klauspost/compress (BSD-3-Clause, its `gzhttp`
  package Apache-2.0), golang.org/x/sys and the Go standard library (BSD-3-Clause), lightning and
  arena (MIT);
- React, React DOM and scheduler in the web UI (MIT);
- Alpine Linux packages, under their own licenses.

Their license texts travel with them: in the image under `/usr/local/share/licenses/`, and for the
web UI's packages in `licenses.txt` beside it (`/app/web/licenses.txt`, and in the live demo).

Citing Cascade in a paper or a course? GitHub's **Cite this repository** button, fed by
[CITATION.cff](CITATION.cff), gives the reference in APA and BibTeX.

## Star history

<a href="https://star-history.com/#johanlindvall/cascade&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=johanlindvall/cascade&type=Date&theme=dark" />
    <img alt="Cascade's GitHub stars over time" src="https://api.star-history.com/svg?repos=johanlindvall/cascade&type=Date" />
  </picture>
</a>
