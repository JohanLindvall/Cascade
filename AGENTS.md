# AGENTS.md

Guidance for working in this repository.

## What this is

A web UI for rtorrent, shipped as one Docker image that also contains rtorrent. The server is Go,
the UI TypeScript and React. The server talks XML-RPC over SCGI to a local rtorrent, serves the
SPA, and streams the state to every open page as deltas.

```
server/                   the Go module: main.go serves, and answers the entrypoint's and
                          the image's subcommands (help, boot-settings, log-scopes FILE,
                          health, options-docs)
  internal/xmlrpc/        XML-RPC encode/decode, hand-written: a single-pass fast path for
                          rtorrent's plain answers, a permissive parser for everything else
  internal/scgi/          SCGI framing over a unix socket or TCP
  internal/rtorrent/      client.go: request queue + multicall helpers; Client, the interface
                          everything above it depends on (a Transport can be injected).
                          capabilities.go: probes system.listMethods, picks a command dialect.
                          settings.go: every rtorrent global setting as one declarative table.
                          model.go: rtorrent fields -> Torrent/File/Peer/Tracker.
                          standin.go: what rtorrent sends for a name XML-RPC cannot carry
  internal/rtorrent/rtorrenttest/  FakeClient, the scripted rtorrent the tests use
  internal/contracts/     the HTTP data shapes (web/src/contracts.ts mirrors them)
  internal/options/       every environment variable as one catalog; renders --help and the
                          README's generated regions, and checks both against the container
  internal/config/        Load(env) -> Config, defaults taken from the catalog; the validated
                          startup settings the entrypoint stages for the server
  internal/service/       all application behaviour: lifecycle.go (the housekeeping tick —
                          rates, re-applying what a restarted rtorrent forgot, restarts
                          after a recheck), state.go (the shared state read), details.go
                          (files, peers, trackers), load.go (adding), torrents.go
                          (per-torrent changes), settings.go, throttles.go, logs.go,
                          restarts.go (the recheck & restart decision, pure), serial.go
                          (the per-torrent and per-group mutation queues, shared reads),
                          datapaths.go (the delete-data path checks, and the bytes on
                          disk a reported path stands for)
  internal/store/         the one JSON state file; throttle group validation
  internal/game/          badge definitions, XP and level curve
  internal/torrentfile/   bencode parse: reject non-torrents, derive the info hash
  internal/prefs/         UI preference shape and repair (web/src/preferences.ts mirrors it)
  internal/stream/        the delta stream: the state held as raw leaves, diffs, and the hub
                          that reads it once for every open page
  internal/httpapi/       server.go (base path, /healthz, the cross-site guard, auth, waking
                          the stream), router.go, routes.go (the API table), request.go
                          (the call adapter, body field readers, requireHash/requireIndex),
                          rpc.go (the console and /RPC2), sse.go (/api/stream), static.go
                          (the SPA, through os.Root), compress.go (zstd/gzip via gzhttp),
                          upload.go, body.go, respond.go (JSON, ETags, error mapping)
  internal/httperr/, validate/  errors that carry an HTTP status; input checks at the edge
  internal/jsnum/         the browser's Number(), String() and Math.round (Parse, OrZero,
                          Format, Round) and the whitespace Number() skips (IsSpace), for
                          values defined in the browser's terms
  internal/utf8text/      browser-compatible decoding of malformed UTF-8, shared by XML-RPC
                          and torrent metadata
web/src/                  React UI. App.tsx composes it from app/ (Toolbar.tsx,
                          useTorrentActions.ts, useDropToAdd.ts, useShortcuts.ts, dom.ts)
                          and components/: modal.tsx, form.tsx, menu.tsx, toast.tsx and
                          focus.ts are the shared primitives, ui.tsx the small
                          presentational pieces, detail/ the detail pane's tabs, clock.ts
                          the one-second clock. useStateStream.ts wires
                          streamConnection.ts (the stream's reconnects) to React;
                          hooks.ts (usePolling, useLatest), prefs.ts (the fetch and the
                          cache), one styles.css of design tokens, theme.ts (themes +
                          effect flavors), grim.ts (black metal copy), assets/ (the retro
                          and black metal wordmarks)
web/src/demo/             the live demo: a simulated rtorrent and Cascade server that run in
                          the browser, which the app is booted over in demo mode only
docker/entrypoint.sh      checks the options, renders rtorrent.rc, supervises rtorrent + the
                          server; functions plus main, so the shell tests can source it
docker/attach.sh          cascade-attach (make attach): rtorrent's curses UI, as the user
                          rtorrent runs as
docker/move-completed.sh validates completion moves and refuses destination collisions
docker/api-smoke.py       probes a running image: API, headers, round trips, stream, patch
docker/scripts.test.sh    shell regression checks, also run in the image build
docker/bump-rtorrent.sh   moves the default rtorrent to a newer upstream release
.github/workflows/ci.yml  Go and web tests, options check, Docker build + API smoke
.github/workflows/release.yml  multi-arch GHCR publish, tags every main push
.github/workflows/rtorrent-update.yml  daily: a pull request per new rtorrent
.github/workflows/pages.yml  publishes the live demo to GitHub Pages on main pushes
.github/dependabot.yml    Go modules, npm packages and Actions (rtorrent is the workflow's)
```

The server has two dependencies, both chosen by the owner:
[lightning](https://github.com/JohanLindvall/lightning) (the owner's own), through whose
`pkg/json` every JSON decode goes — request bodies, the state and boot-settings files, and above
all the stream's reads of the state — while encoding stays with `encoding/json`; and
[klauspost/compress](https://github.com/klauspost/compress), whose `gzhttp` compresses every
response. The client's only runtime dependencies are react and react-dom. Keep it that way unless
there is a real reason.

## Build and test

No local Go or Node is needed — the toolchains live in the image:

```bash
docker build -t cascade:test .        # vets and tests the server, typechecks and tests the web
make test                             # the same suites, without compiling rtorrent
make race                             # the Go suites under the race detector
```

The web's `tsc` is strict, with `noUnusedLocals` and `noUnusedParameters`, so a build is a real
typecheck — and the image build also runs every suite (`go test ./...` in `server/`, `npm test`
in `web/`, `docker/scripts.test.sh`), so a red test is a failed build. `npm run build` is
`tsc -p tsconfig.json && vite build`; that config excludes the tests, so the DOM-flavoured app
typecheck never sees node's types. `npm test` typechecks the tests on their own first
(`tsconfig.test.json`: the same options, node's types in place of Vite's) and then runs every
`src/**/*.test.ts` under node's built-in runner — no frameworks — with
`--experimental-strip-types`.

The runner strips types but does not compile JSX, so a test reaches `.ts` modules only, and pure
logic belongs where it can reach it. The stream's patching and reconnects (`stream.ts`,
`streamConnection.ts`), sorting, filtering, the `.torrent` file check and drop parsing
(`files.ts`), the selection rules, the value a selection shares for a field (`sharedValue.ts`),
formatting and parsing, redaction, the preference shape and its syncing, the menu's placement and
right-click rule (`components/menuRules.ts`), the toast hold (`components/toastHold.ts`) and where
focus goes on selection or menu opening (`app/rowFocus.ts`) live apart from the components for exactly
that reason. What cannot be split off is pinned by reading the source instead:
`components/detail/tabs.test.ts` checks the detail tabs stay memoized. A pure module
that imports another spells the specifier with `.ts` (`preferences.ts` → `'./sort.ts'`): the
runner resolves specifiers literally, and Vite and tsc accept either. A module that touches
`window` or `document` at load time cannot be imported statically: `api.test.ts` stubs
`document.baseURI` and then imports `api.ts` dynamically, and `preferences.ts` (the shape and its
repair) is kept apart from `prefs.ts` (the fetch, the cache, the `pagehide` flush) so its tests
need no stub at all.

Go runs in Docker too, as uid 1000 so the files it writes keep their owner:

```bash
docker run --rm --user 1000:1000 -e HOME=/tmp -v "$PWD":/r -w /r/server golang:1.26-alpine \
  sh -c 'gofmt -l . ; go vet ./... && go test ./... && go run . options-docs'
```

(`golang:1.26`, the Debian image, for `go test -race`, which needs cgo — `make race` runs that one.)
The whole repository is mounted because the server's tests read beyond `server/`: the option catalog
is checked against `docker/entrypoint.sh` and the README, and `internal/game` keeps
`web/src/game-catalog.json` — the badge ids and level titles `grim.test.ts` checks for a black metal
entry — in step with its table (`go test ./internal/game -run Catalog -update` rewrites it). The
image's build stage copies those files in for the same reason.

The shell has its suite too, `docker/scripts.test.sh`, run in the image build and in CI. It
sources the entrypoint with `ENTRYPOINT_LIBRARY=1`, which defines its functions without running
`main` (a name outside the option families, so the options check does not take it for a
setting), and drives the rc rendering, the value checks (`validate_options`, `enabled`) and the
session-lock handling against stub `rtorrent` and `cascade` binaries. Each case runs in a shell of
its own (`with_entrypoint` uses `sh -c`, not a subshell: under `if`, a subshell runs with `set -e`
suspended and a failed step would not end the case), through `expect_ok` or `expect_refused`,
which show a case's stderr only when it fails. New entrypoint behaviour belongs in a function, and
in a case there. Run it under `dash` as well as BusyBox: dash's `echo` reads backslashes, which is
why rc lines go through `printf`.

The server suite reaches everything above the socket without one: `rtorrent.NewClient` takes an
optional `Transport`, and `service.Service` and `Capabilities` depend on the `rtorrent.Client`
interface rather than the concrete client, so `rtorrenttest.FakeClient` stands in for rtorrent —
it answers from a table and records every call. A command the fake lists in `system.listMethods`
but has no answer for returns `0`, as rtorrent's setters do; an unlisted one faults. Most
service tests assert on what did *not* reach rtorrent — an erase before the data path was
checked, a load of something unfetchable — which is the property that matters. `httpapi.New`
mounts on an `httptest` server with a stub `Service`, so the HTTP contract (validation, bulk
error collection, auth, JSON 404s, the stream) is tested end to end over real requests. The
suite was ported case for case from the TypeScript server it replaced, and the two were run side
by side against one rtorrent and answered every route alike; keep new behaviour tested at that
level. The read every open page pays for is benchmarked: `go test -run '^$' -bench Listing
./internal/...` decodes (`xmlrpc`), maps (`rtorrent`) and diffs (`stream`) a 500-torrent listing.

Run it and exercise the API:

```bash
docker run -d --name cascade-test --stop-timeout 60 -p 18080:8080 cascade:test
curl -s localhost:18080/api/capabilities        # which backend am I talking to
curl -s localhost:18080/api/state               # the whole state at once
curl -sN --compressed localhost:18080/api/stream # what the UI watches: a snapshot, then deltas
```

rtorrent is always compiled from an upstream tag; there is no distro-package path. To test against
a different one, rebuild with `--build-arg RTORRENT_VERSION=0.9.8` (or `make matrix`, which builds
0.9.8, 0.15.2 and the default). **Changes to the backend should be checked against at least the
oldest and newest**, because the command set genuinely differs.

The default release is written once, as the Dockerfile's `ARG RTORRENT_VERSION`: the Makefile and
`release.yml` read it from there, and other docs say "the default" rather than a number. The README
names it in two phrases — the highlights' "**rtorrent X, compiled from source**" and "The default
is **X**" — which `docker/bump-rtorrent.sh` rewrites along with the Dockerfile and checks it did;
reword either and the script has to follow. That script is `make bump-rtorrent`, and it is what
`.github/workflows/rtorrent-update.yml` runs every morning to open a pull request per new upstream
release (Dependabot cannot follow a git tag compiled from source; `.github/dependabot.yml` covers
the Go modules, the npm packages and the Actions). When such a pull request comes in, read the
release notes for renamed commands and check settings still round-trip (quirk 7) before merging.

Old tags need `-include algorithm -include cstdint` to compile against a current libstdc++; the
Dockerfile passes that to every source build.

A full end-to-end transfer can be staged with two containers and a throwaway tracker: seed a real
file from one, download it in the other, and watch progress, peers and rates in the UI. A
completion — and so the finish animation — can be forced without a swarm: put the payload in
`/downloads` first, then upload its `.torrent`, and rtorrent's hash check completes it outright.

**Check UI work by looking at it.** A build only proves it typechecks; CSS regressions do not
fail a build. Boot the image, seed a few torrents through the API, set the theme with
`PATCH /api/prefs`, and screenshot with a headless browser at desktop and 390px widths. For
anything that needs interaction or measurement (an open drawer, a dialog, whether a column moved
between updates) drive the same browser remotely — Chrome's DevTools protocol
(`--remote-debugging-port`), or Firefox's Marionette where there is no Chrome — and assert on
`getBoundingClientRect()` rather than on how it looks.

## Live demo

`web/src/demo/` is a public demo of the real UI — https://johanlindvall.github.io/Cascade/ — that
needs nothing installed: the unmodified app over a simulated rtorrent and Cascade server running in
the visitor's browser. In `vite --mode demo` a plugin in `vite.config.ts` swaps index.html's
`/src/main.tsx` for `src/demo/entry.ts`, which installs `install.ts` (fetch and EventSource
stand-ins for the API's URLs, `transport.ts`) before it imports the app. `backend.ts` answers every
route the UI calls as the Go server does — the shapes typed with `contracts.ts`, the same checks
and messages, rtorrent's faults as 502s, the settings and `supports` of the release it presents —
over `session.ts`, the simulation (seeded from `catalog.ts` and stepped every 250 ms from its
start, which every clock-driven swing is measured from, so one seed is one session whenever it
runs); `hub.ts` and `diff.ts` speak the stream's protocol and `rpc.ts` is the console's rtorrent.
The session starts at the first request, not at load: a tab opened in the background asks for
nothing until it is shown, and the finish a minute in must not have passed unseen by then — so
nothing may ask the demo for anything before the page is first shown. It presents the Dockerfile's
`RTORRENT_VERSION`, read at build time, so the daily bump keeps it current. Its catalogue stays
legally redistributable — distribution images, open movies, public-domain and Creative Commons
works, open datasets — with trackers on RFC 2606 example domains and peers on documentation
addresses.

`npm run dev:demo` serves it and `npm run build:demo` writes `web/dist-demo/`, which
`.github/workflows/pages.yml` publishes from main; CI builds it on every pull request. Nothing
outside `src/demo/` imports it and the production config adds nothing, so `npm run build` never
bundles it. The demo build also gives the page its own title, a description, a canonical URL and
the Open Graph and Twitter tags a shared link unfurls with — absolute URLs, so they name the
published site (`CASCADE_DEMO_URL` for a fork's) — and emits `docs/social-preview.png` as the
preview image: the 1280×640 picture that is also the one to upload as the repository's social
preview.

**It has to keep up with the API**: a changed route, contract or stream rule needs the same change
in `src/demo/`. The typecheck catches contract drift; `diff.test.ts` holds the differ to
`patches.json`, `hub.test.ts` folds the simulated stream through the real `reduce()`,
`transport.test.ts` drives the real `api.ts` and `StreamConnection` over the stand-ins,
`install.test.ts` holds the session's start to the first request, `backend.test.ts` pins each
route's answers and refusals (worded as a running 0.16.24 words them), and `game.test.ts` holds
the ported badge table to `game-catalog.json`.

## rtorrent quirks that cost time to discover

These are load-bearing. Breaking them produces faults or, worse, a crashed rtorrent.

1. **Commands take a target argument.** Global setters are `throttle.global_up.max_rate.set("",
   value)`, not `(value)`. Passing the value alone makes rtorrent read it as a target and fault with
   `-503 Wrong object type` (or `-501 Could not find info-hash`). `SettingEntries` in
   `internal/rtorrent/settings.go` adds the `""` for you. Getters are fine with no arguments.
   Per-torrent commands take the info hash as that target, and file/tracker commands take
   `"<hash>:f<index>"` / `"<hash>:t<index>"`.

2. **`protocol.encryption.set` takes one argument per flag** — `("", "allow_incoming",
   "try_outgoing")`, not one comma-joined string.

3. **Throttle groups.** rtorrent has no per-torrent rate limit; it has named groups created with
   `throttle.up("", name, rate)` and assigned with `d.throttle_name.set`. The group setters take
   **whole KiB/s strings**, unlike global setters' bytes/s. `store.NormalizeThrottle` rounds a
   positive fractional KiB up and stores the actual byte value; never feed API bytes directly to
   these setters. Groups do not survive an rtorrent restart, so they are persisted in the store
   and re-applied once rtorrent has restarted (see *What a restarted rtorrent forgets* under
   Conventions). They also cannot be deleted at runtime — deleting sets them to unlimited.

4. **A running download rejects a throttle change** ("Cannot set throttle on active download"), so
   `SetTorrentThrottle` stops it, sets, and restarts.

5. **Do not batch stop/set/start into one `system.multicall`** — it segfaults rtorrent 0.15.2.
   `SetTorrentThrottle` deliberately issues separate requests. Be suspicious of any multicall that
   mixes lifecycle changes with other commands.

6. **`rtorrent.rc` must only contain commands that exist in every supported version** — rtorrent
   aborts on an unknown command in its config file. That is why the entrypoint writes a minimal rc
   (paths, port, scgi, log, watch dir) and hands everything else to the server as
   `/run/cascade/boot-settings.json` (written by `cascade boot-settings`), which goes through
   the same capability-filtered `UpdateSettings` path. **Add new tunables there, not to the rc.**

   The listening port is the exception: it has to be right before rtorrent binds, and applying it
   over XML-RPC afterwards does not rebind. 0.16 renamed those commands, so the entrypoint asks
   rtorrent which name it knows (`rc_command_exists`, a one-line option file) and writes that one.
   Use the same trick for anything else that genuinely must be in the rc.

   The few values the rc carries as they are — `RT_PORT_RANGE`, `RT_UMASK`, `RT_WATCH_INTERVAL`,
   `RT_SCGI_PORT` — are checked by `validate_options` before anything is written, so a bad one
   stops the start by name rather than as a parse error thirty seconds later. The patterns follow
   what rtorrent's rc parser takes (checked on 0.9.8 and 0.16.24), not a tidier subset, so nothing
   that started rtorrent before is refused now. rtorrent reads a number the way C does: a bare
   `22` was decimal (umask 0026), so `render_rc` writes the umask with a leading `0`, and
   `RT_PORT_RANDOM` is written as `yes`/`no` because rtorrent refuses `on`/`off`. With a supplied
   rc kept (`keeps_supplied_rc`), only `RT_PORT_RANGE` (which the port probe uses either way) and
   the booleans are checked.

7. **A setter existing does not mean it works.** 0.16 registers
   `network.http.max_total_connections.set` but the value never changes, so `maxHttpOpen` maps only
   to the legacy command and the UI greys the field out there. When adding a setting, set it and
   read it back before believing it.

8. **rtorrent locks its session directory** and only releases the lock on a clean shutdown. A
   SIGKILLed container leaves `rtorrent.lock` behind and every later start dies with "Could not
   lock session directory", which reaches the user as a bare connection error. The entrypoint
   clears a lock unless this container's hostname *and* a live pid still hold it. Do not remove
   that check without replacing it — and prefer `docker stop` over `docker rm -f` in tooling.

   A clean shutdown is slower than it looks: on SIGINT rtorrent announces "stopped" to every tracker
   and only drops the unanswered requests after about ten seconds (`handle_shutdown` in its
   control.cc, in rounds), so 100 torrents behind a hung tracker took 12–21s, measured. The
   entrypoint's `stop_all` gives it 30s, then SIGTERM (quick shutdown) and 10s more, and must never
   exit while rtorrent still runs: the container goes with the script and the kernel kills what is
   left. It used to allow 10s and exit, so every `docker stop` left the lock behind and a stale peer
   in the trackers' tables ("Got multiple targets in peer table!"). Docker's own timeout has to
   outlast that, hence `--stop-timeout 60` in every `docker run` the docs show and `-t 60` in `make
   stop` — a plain `docker stop` otherwise kills at Docker's default ten seconds.

9. **rtorrent needs a pty**, so it runs inside a detached `screen` session. `SCREENDIR` must be
   mode 0700 or screen refuses to start. screen also serves a session only to the user who
   started it — rtorrent's `PUID`, while `docker exec` is root — so attaching goes through
   `cascade-attach` (`docker/attach.sh`), which switches user first; a bare `screen -r` finds
   nothing.

10. **Some settings are write-only** — `dht.mode` has `.set` but no getter, and while 0.16 grew a
   `protocol.encryption` getter it reports internal flag names (`handshake_allow`, …) that the
   setter refuses, so neither value can round-trip and the UI shows "(leave unchanged)" instead.

11. **Labels live in `d.custom1`**, URL-encoded (the ruTorrent convention), which is why
   `MapTorrent` decodes and `SetLabel` encodes.

12. **libtorrent opens files under the exact name in the torrent, and Linux caps a path component at
   255 bytes** — so a Thai or CJK title of ~85 characters fails every open with `ENAMETOOLONG`,
   which reaches the UI as "Hash check I/O error at chunk 0: Filename too long" and a torrent that
   can never start. The image patches libtorrent at build time (`docker/patches/`): `path_fit.h`
   shortens an over-long component to fit — stem cut at a UTF-8 boundary, `~` plus an 8-hex FNV-1a
   tag of the original so two names differing past the cut usually remain distinct (a finite hash
   cannot guarantee no collisions), extension kept — and `apply-libtorrent.sh` wires it into the
   three places that turn names into filesystem paths: `Path::as_string` (the file),
   `FileList::make_directory` (each directory), and `FileList::set_root_dir` (the root rtorrent
   composes from the download directory and the torrent's *name* — for a multi-file torrent that
   name is a directory and never passes through `Path`, which is how the first cut of the patch
   still failed multi-file torrents). It is pattern-based rather than a diff per release, knows the
   spellings of 0.13.x/0.15.x/0.16.x, and fails the build if a spelling is missing; it also compiles
   and runs `path_fit_test.cc` with the same toolchain first. What reports what: `d.name` and
   `f.path` keep the torrent's own names (rtorrent joins `f.path` from the components itself,
   deliberately left alone); `frozen_path`, `d.base_path` and `d.directory` are the on-disk truth,
   so delete-data is right — as bytes, which XML-RPC cannot always carry (below). The Files tab
   fetches `f.frozen_path` and shows "on disk as …" when the two differ (`MapFile`'s `OnDisk`),
   which is also what the API smoke test checks. `docker/patches/apply-<repo>.sh` is the general
   hook — one per repository, run after clone and before configure.

   **Nor does anything make those names UTF-8, and XML-RPC text must be.** An old torrent names its
   files in Latin-1 and libtorrent writes those bytes as they are — 0.16.25 still names a single
   file by its legacy `name`, whatever `name.utf-8` says. xmlrpc-c, every image's RPC layer, takes a
   string only if it is UTF-8 inside the Basic Multilingual Plane, so an emoji fails as well (1.51,
   and the current release still); rtorrent then sends a stand-in for the whole string
   (`internal/rtorrent/standin.go`): from 0.16.3 every byte outside printable ASCII as `%XX`,
   upper-case (libtorrent's `string_with_escape_codes`), before that every non-ASCII byte as `?`.
   `%` is not escaped and `?` stands for itself, so neither can be undone from the text, and a
   delete that took `d.base_path` at its word removed nothing and answered 200 — or removed a file
   that really is called `Caf%E9 …`. `dataPath` (`service/datapaths.go`) asks 0.16.13 and later for
   `d.base_path.base64`, the bytes exactly. On older releases it matches the stand-in against the
   disk, a component at a time, and refuses with a 409 before the erase when two paths fit, or when
   the one that fits is not confirmed by rtorrent: `f.is_created` stats the real bytes, and a
   torrent whose own data is gone must not take a namesake with it. Padding confirms nothing: from
   0.15 a file whose BEP 47 `attr` holds a `p` is padding whatever it is called, and `f.is_created`
   answers 1 for it without a stat — but it is never opened, so its frozen path stays empty, and
   `filesPresent` counts only a file that has one. It asks for both as numbers (`f.is_created`,
   `not=$f.frozen_path`), never for a name: the files under a base path that reads as plain text
   can still be named in a way that crashes 0.16.3 to 0.16.6. The root checks then apply to the
   bytes found. The listing and the Files tab ask for the `.base64` variants of `d.name`,
   `d.base_path`, `f.path_components` and `f.frozen_path` where the backend has them
   (`ExactFields`), so an emoji shows as itself and a stray byte as U+FFFD; `d.directory` has no
   variant and borrows the base path's bytes when its stand-in fits them, and before 0.16.13 the UI
   shows rtorrent's stand-ins. A stand-in is chosen per string, so a UTF-8 file name under a Latin-1
   directory arrives escaped in `f.frozen_path` and as itself in `f.path`: `MapFile` does not take
   that for a shortened name (it used to say "on disk as Caf%C3%A9.txt"). The completion move gets
   the path from rtorrent as an argument, bytes and all, and never sees a stand-in; a directory
   change takes a path from the user and can only set one that is UTF-8.

13. **What the client calls itself is compile-time, in two places.** The HTTP `User-Agent`
   (`USER_AGENT`, patched into rtorrent's `set_user_agent(USER_AGENT)` call by
   `apply-rtorrent.sh`) and the peer id prefix (`PEER_NAME`, patched into libtorrent's
   `configure.ac` by `apply-libtorrent.sh`). Both are build args, not environment variables —
   neither project exposes a command for them. The Dockerfile has every release newer than
   0.16.20 present itself as 0.16.20 (`rtorrent/0.16.20` + `-lt1014-`) — a version comparison,
   not a list, so a bumped default keeps the whitelisted identity without an edit — because
   private trackers whitelist client versions and refuse anything newer, which reaches the UI
   only as a failed announce (and, on 0.16.22, only as `v6 : Could not resolve hostname`, since
   libtorrent prefers a failed AAAA lookup over the real reply). Move the two together: a
   tracker checking both sees a mismatch otherwise. The prefix of each release is spelled out in
   the README's *The version presented to trackers*.

## Adding support for a new backend command

Never call a command unconditionally.

- **A global setting** is one entry in the table in `internal/rtorrent/settings.go` — getter, setter
  (with alternates, newest first, when a release renamed it), and a coercion kind — plus a form
  field in `SettingsDialog.tsx`. The table drives `/api/settings` reads, writes, the boot-settings
  warning, and the `supports` map: every setting key automatically becomes a feature that is true
  when the backend has a working setter, and the dialog greys the control out by that same key.
  Remember quirk 7: set the value and read it back on the oldest and newest rtorrent before trusting
  it.
- **Anything else** (per-torrent commands, probes) goes in `featureMethods` in
  `internal/rtorrent/capabilities.go`, guarded with `caps.Supports("yourFeature")`.

Field commands in `model.go` are filtered against `system.listMethods` automatically — a field the
backend lacks simply maps to `0`/`''`.

## The gamification layer

Levels and badges are derived from lifetime counters in the store, not from anything invented.
Three things are worth knowing before touching it:

- **Totals accumulate as deltas.** `RecordTorrents` compares each torrent's `up.total`/`down.total`
  against the last seen value, so removing a torrent does not erase the traffic it contributed. A
  torrent seen for the first time contributes its whole total, which credits a pre-existing
  rtorrent session.
- **Completions are counted once**, via the `everCompleted` tombstone list — otherwise removing
  and re-adding a torrent would inflate the count.
- **Counters keep moving with no browser open**: every read of the state refreshes them while a
  page is open, and the housekeeping tick reads the list itself once 30s pass without such a
  read. That read is the loop's own — under the tick's context, so `Stop` abandons it, and
  skipped when another read is already in flight (`doIfIdle` in `serial.go`), since that one
  updates the counters too.

Badges are pure functions of the stats (`game.Achievements` in `internal/game`), so adding one is a
single entry — with a `unit` (`count`, `bytes`, `rate`, `ratio`, `duration`), which is how the UI
formats its progress (`progressText` in `format.ts`) instead of guessing from the id — but the
unlock timestamp is persisted, so a badge whose condition later stops holding stays earned.
`CASCADE_GAMIFY=0` disables the whole layer; the UI keys off `game.enabled`, so anything you add
must be behind that flag too.

The black metal theme re-carves all gamification copy client-side (`web/src/grim.ts`, keyed by
achievement id and level title). It is a pure text skin — never branch unlock logic on it — and a
new badge or level title needs a matching entry there or it shows its plain name in that theme.
`grim.test.ts` checks every id and title in `web/src/game-catalog.json`, which the Go test in
`internal/game` fails on when it drifts from the table and rewrites with `-update` — so a new
badge is: the entry, `go test ./internal/game -run Catalog -update`, and the grim copy.

## Options and their documentation

Every environment variable the container understands is declared once, in
`server/internal/options/options.go`. That catalog is load-bearing rather than descriptive:

- `internal/config` looks each default up **by name** (through its `str`, `num`, `flag` and
  `optional` readers), and the lookup panics for a name the catalog does not list — so the
  server cannot read an undocumented variable.
- `docker run --rm cascade --help` renders it (the entrypoint answers `-h`/`--help`/`help` before
  any setup, so it works in any environment).
- The README's `<!-- generated: … -->` regions — the sample `docker run` and the whole
  Configuration section — are produced from it by `cascade options-docs --write` (`go run .
  options-docs --write` in `server/`).
- `cascade options-docs` (in CI, and a test of the options package) fails if the entrypoint or
  `internal/config` reads a variable missing from the catalog, if a catalogued option is read by
  nothing, or if the README has drifted.

Adding an option therefore means adding it to `options.go` and regenerating: the README with
`options-docs --write`, and the golden `--help` and README renderings in
`internal/options/testdata` with `go test ./internal/options -update`. Hand-editing the generated
README regions will fail CI.

A value that does not parse stops the start with the variable's name rather than falling back to
a default. Booleans are the case that bit: `flag` in `internal/config`, the startup settings
(`cascade boot-settings`) and the entrypoint's `enabled` all take 1/true/yes/on or 0/false/no/off
in any case (`validate.Bool`'s spellings) and nothing else — comparing with "1" used to read
`RT_CONFIG_KEEP=true` as "regenerate" and overwrite the owner's rc, and a misspelled
`CASCADE_ALLOW_RAW_RPC` must not quietly mean off. In the entrypoint, call
`enabled NAME "${NAME:-default}"` with the expansion spelled out — that is how the options check
sees the variable read — and never inside `$(...)`, where `die` would end only the subshell.

## Persistence

Everything Cascade remembers is in one JSON file, `/config/cascade-state.json`, owned by
`internal/store`: UI preferences, gamification counters and unlocked badges, per-torrent add times
and last-seen totals, throttle groups and raised log scopes. Add state there rather than
introducing another file.

Writes are debounced (two seconds) and go through a temp file that is fsynced before the rename,
with the directory synced after it, so a crash or a full disk leaves the old file or the new one.
`Flush` encodes under the store's lock and writes outside it, one write at a time: a slow disk
must not hold up the state reads that fold the list in many times a second. A file that cannot be
read or is not JSON at all is set aside as `cascade-state.json.corrupt` (then `.corrupt.1`,
`.corrupt.2`, …, never over an earlier copy) and Cascade starts clean; one that parses keeps
whatever of it is valid, field by field.

**Only a real change may dirty the store.** `RecordTorrents` folds the whole list in on every read,
and an unconditional flush (`scheduleFlushLocked`) there meant an idle session rewrote the JSON file
every two seconds for as long as a browser was open. Every mutation site now sets a `changed` flag
first (the ever-growing seed clock coarsens to the minute for the same reason), and the store test
pins it: fold the same list twice, and the second fold must not recreate a deleted state file. Keep
that property when adding counters.

Listings and erases also share `Service.listingGate` across the RPC and bookkeeping update. A
listing started before an erase must finish folding before `Forget`, or it would credit the
removed torrent as newly added and count its traffic again. The gate is cancellable for the
housekeeping's own read, so stopping the loop never waits on a queued read behind a removal.

Preferences are validated in `internal/prefs` (`Sanitize`) before being stored — an unknown
theme or sort key falls back to the default instead of reaching the UI. The browser keeps a
localStorage copy of the preferences, but only as a cache so the theme can apply on first paint;
the file always wins once it loads, and the cache is repaired on read (`normalizePreferences`)
because a browser's storage can hold anything. Browser-side writes are debounced and flushed on
`pagehide` with `keepalive`. `web/src/preferenceSync.ts` orders saves, retries failures without
dropping newer edits, and protects edits made while the initial server copy is loading. The
initial read retries transient failures; badge announcements wait for that saved copy. The
browser's copy of the schema (`web/src/preferences.ts`) mirrors `internal/prefs` — the same
allowlists, bounds and repair — and the two must change together. The refresh interval
(`statePollMs`, null for the server's `CASCADE_STATE_POLL_MS`) is one of them: the status
reports the effective value and the default, and the stream's reader picks a change up on its
next read.

## Themes

Five modes: `system`, `light`, `dark`, `retro`, `blackmetal`. `system` resolves through
`prefers-color-scheme` in `theme.ts`, and the resolved value goes on `<html data-theme>`. Themes
are pure token overrides in `styles.css` — components carry no per-theme markup, so a new theme is
a block of custom properties plus, for retro and black metal, a set of shape overrides (zero
radius, offset shadows, stepped bars / grain and vignette). Keep it that way. Adding a theme means
touching five places: the token block in `styles.css`, `THEME_MODES`/`THEME_COLORS` in `theme.ts`,
a glyph in `ThemePicker.tsx`, and the theme allowlists in `internal/prefs` and
`web/src/preferences.ts`.

An inline script in `index.html` applies the cached theme before first paint (no dark flash for
light-theme users) and `applyTheme` mirrors the page background into `<meta name="theme-color">`;
both must stay in step with the theme list. A theme also declares `color-scheme` — dark in the
default block (which retro and black metal inherit), light in light's. Without it Firefox draws
its own parts for a light page: a white scrollbar track down the middle of every dark theme, which
headless screenshots show plainly. Firefox's scrollbar colours are set under
`@supports (-moz-appearance: none)`, because Chrome ignores the `::-webkit-scrollbar` rules
altogether once `scrollbar-color` is set.

Retro and black metal each replace the wordmark with an image from `web/src/assets/`, swapped in
by CSS on `.brand-name` — a generated pixel grid for retro, a deliberately illegible band logo for
black metal, which is also why that theme runs a taller header. They are intentional, not
placeholders; black metal's was supplied by the user, so regenerate it only on request.

## Adding torrents

Dropping on the window adds immediately; the **Add torrent** button is the path for choosing a
directory or label, or for magnets and URLs. Because the drop path has no dialog to report into,
`Service.AddTorrentFile` has to be trustworthy:

- `load.raw_start` returns 0 for **any** payload — a corrupt file only shows up in rtorrent's log —
  so `internal/torrentfile` parses the bencode first and rejects what is not a torrent, with the
  reason.
- The same parse yields the info hash, and the load is confirmed by waiting for that hash to appear
  in the session. `load.*` is queued, not immediate, so "the call returned" is not "it loaded".
- That wait cannot tell a new torrent from one already there, and rtorrent drops a second load of
  a hash without a word — the label and directory it carried with it. So the session is asked
  first (`refuseLoaded`), and a torrent it already holds is a `409` naming it, for a file and a
  magnet alike. A fetched URL has no hash until rtorrent has fetched it; its wait for a new torrent
  fails instead, and the message lists "already loaded" among the reasons.
- The directory rides into rtorrent inside a command string (`d.directory.set="…"`), where
  quotes and backslashes are escaped but a line break could end the command and start another,
  so a directory with a control character is refused (`checkLoadOptions`); the label goes in
  URL-encoded and cannot carry one.

Failures come back per file in the upload response and are toasted by the UI.
The response also identifies failed file and URL indices, so the Add dialog retains only failures
for retry. The upload ceiling is for the combined file bytes, including chunked requests; a
per-file limit alone cannot bound a 50-file batch's memory use.

Two things about the drop handling (`app/useDropToAdd.ts`) are load-bearing:

- **`dragover` is cancelled unconditionally**, and a window-level listener cancels stray drops as
  well. A drag the handler does not recognise must still be cancelled, because the browser's
  default action for an uncancelled drop is to navigate to the dropped file — which throws the
  whole UI away and looks to the user like the file being rejected.
- **The Add dialog's dropzone stops propagation.** Otherwise a drop inside the dialog both stages
  the file there and adds it immediately via the window handler.

A drop with no file payload falls back to `text/uri-list` / `text/plain`, so magnets and URLs work;
a `file://` URI cannot be read by the browser and says so rather than failing quietly. That reading
is `dropText` + `linksFromDrop` in `files.ts`, shared with the Add dialog's dropzone (where a
dropped link joins the link list), so both places accept and refuse the same things in the same
words. Text dropped on a text field — a magnet into the link box, a name into the search — is the
field's: the window handler lets it through rather than cancelling it, while a *file* dropped
there is still taken, or the browser would navigate to it.

## Animations

`Celebrate` (download finished) and `DropBurst` (files dropped) are fire-and-forget: the parent
hands them a trigger and they clean themselves up on a timer. Both take an effect `flavor`
(`fxFlavor` in `theme.ts` maps the resolved theme): `party` is the default, `grim` (black metal)
mourns — ash, embers, a lightning flash, a closing pall, a summoning sigil, an "offering" score —
and `arcade` (retro) plays it 8-bit: stepped pixel rain with a CRT flicker, pixel rings, an
eight-way burst and points on the score. The flavor is latched at launch (ref/memo) so a theme
flip mid-flight cannot restyle or restart a sequence, and every variant keeps the same trigger
contract and reduced-motion skip.

Both read their `onDone` through `useLatest` (`hooks.ts`) and depend only on the trigger id. That is
not incidental — the app re-renders on every update of the state, so an inline `onDone={() => ...}`
in the dependency array tears the effect down and restarts the sequence one and a half seconds in.
The visible symptom is subtle (the tail of the animation silently never runs), so if you add another
timed effect, follow the same pattern. `useLatest` writes its ref in a layout effect, not during
render — a render React throws away would otherwise leave its values behind — and the app's global
keydown listener (`app/useShortcuts.ts`) is attached once and reads its targets the same way.

Both are also skipped under `prefers-reduced-motion`, in the component *and* in CSS, and both
render above the modal layer so a dialog opening underneath does not cut them off.

## Responsive layout

Breakpoints live in `styles.css` and, where a component has to change rather than restyle, in
`useMediaQuery.ts` — keep the two in step (`COMPACT_QUERY` is the 720px one). Columns drop by
usefulness through 1280/1140/1024px via per-column classes (`col-added`, `col-ratio`, `col-eta`,
`col-peers`); below 720px `TorrentTable` renders cards instead of a table, the sidebar becomes a
fixed drawer, and detail/modals become full-screen sheets. On compact layouts the throttle,
console and settings buttons leave the header (`.compact-hide`) and reappear as the drawer's
Tools group, the toolbar gains a sort dropdown (cards have no headers to click), and the live
rates stay in the header in a slimmed form. Long-press opens the context menu on touch; the
synthesized click that follows the press is deliberately swallowed in `TorrentCard`, or it would
close the menu the instant it opened. On the compact layout opening the menu (long-press or
right-click) selects the row but leaves focus alone (`focusOnMenu`, `app/rowFocus.ts`): a
focused row there is the full-screen details sheet, which would otherwise open behind the menu
and stay after it closed. Checkbox and modifier selections likewise leave compact details closed
(`focusOnSelection`). The drawer and compact details use `useFocusRegion` and `trapTab` to take
and return keyboard focus; dialogs must paint above both sheets. The menu's height is capped
inline from `innerHeight` by the same
measure that clamps its top (`placeMenu`, `components/menuRules.ts`); the stylesheet's `100vh`
is only the cap it is first measured under, and on a phone it is the viewport with the URL bar
hidden, which left the last item — *Remove + delete data* — below the screen.

**Nothing that updates with the state may size its own container.** Both tables run
`table-layout: fixed` with per-column widths (`th.col-*`), the header's rate readouts and level
chip have fixed widths, and the card layout's rate spans have a `min-width` — because an ETA
ticking from `2m 54s` to `2m 9s` is one character narrower, and with content-sized columns the
name column absorbs the difference and the whole table steps sideways on every update. Column
widths are percentages so narrow windows squeeze rather than scroll; check with
`getBoundingClientRect()` on the `th`s before and after a value change, not by eye. Rows must not
trade places either: `sortTorrents` breaks every tie by name and then hash, and names the collator
calls equal ("Movie"/"movie", "Episode 07"/"Episode 7") share a rank, so the hash decides rather
than the order rtorrent listed them in.

**What the stream redraws must stay cheap.** The app renders on every delta, up to ten a second.
The table's rows (`TorrentRow`, `TorrentCard`) and the fetched detail tabs (`FilesTab`, `PeersTab`,
`TrackersTab`) are memoized, so anything handed to them must keep its identity between renders —
`useCallback`, never an inline lambda; an 8000-file Files tab redrawn with each delta stalled the
page for about 200 ms at a time. A time that moves with the clock (a row's *Added*, a tracker's
next announce) reads `useClock` (`components/clock.ts`, one shared one-second timer) instead of
riding on its parent's redraws; `TrackersTab` does, or its countdowns would move only on its
2.5 s poll.

Two other things are easy to get wrong here:

- **Button labels must be wrapped in a `<span>`.** The compact rules hide labels to leave icons;
  a bare text node inside a button cannot be targeted. An icon-only button carries an
  `aria-label`; the icons themselves are `aria-hidden`.
- **Do not let anything scroll the page sideways.** `html, body` are capped at `100%` with
  `overflow-x: hidden`; wide content scrolls inside its own container instead. Check new layout
  work at 360px before calling it done.

## The project's public face

What a visitor sees decides whether the code gets read, so it is held to the code's standard:

- **The README's first screen** is the five-second pitch: the badges (CI on main, the newest git
  tag — which the release pushes last, so it always names a published image — the license, the
  live demo), one paragraph of specific claims — each one checkable — the demo link, a `docker
  run` that works as written (named volumes, the UI bound to 127.0.0.1, credentials, because
  without them any page the visitor opens can reach Cascade through DNS rebinding; `--stop-timeout
  60`; checked against the published image), then `docs/screenshot-main.png`, taken from the demo.
  Keep every claim true when behaviour changes. The pitch names no rtorrent release but the
  oldest it supports and "the release the image ships", so no bump can make it stale, not even
  one into a new series; the release number itself lives in the two phrases `bump-rtorrent.sh`
  rewrites, in the highlights and under *Choosing the rtorrent version*.
- **Licensing is MIT** (`LICENSE`), and every source file says so in its first line — `//`, `#`,
  `/* */` or `<!-- -->` around `SPDX-License-Identifier: MIT`, after a shebang, the Dockerfile's
  `# syntax=` directive or the HTML doctype, which must stay first, and followed by a blank line in
  Go, where a comment touching `package` would become the package's documentation. CI's *License
  identifiers* step fails on a tracked source file without it, so give a new file the line when
  you create it. The image also ships rtorrent and libtorrent (GPL-2.0-or-later), the Go modules
  compiled into the server and the packages bundled into the UI, and the README's License section
  names them all. Their texts go with them: the Dockerfile installs rtorrent's and libtorrent's
  `COPYING`, Cascade's `LICENSE` and every compiled-in Go module's license under
  `/usr/local/share/licenses/` (a module without one stops the build), and Vite's `build.license`
  writes the UI's as `licenses.txt` beside it, in the demo too. The release's labels and index
  annotations say `MIT AND GPL-2.0-or-later`, which is what the image contains.
- **`SECURITY.md`** is the private disclosure path (GitHub's private vulnerability reporting must
  stay enabled for its link to work) and the security model: what is a vulnerability and what is
  Cascade working as designed. A new trust boundary, default or switch belongs there too.
- **`CITATION.cff`** has no version or release date on purpose: every push to main is a release,
  so either would be stale within the day. `cffconvert --validate` checks it.
- **Outside the repository**: the GitHub description and topics, private vulnerability reporting,
  Pages (source: GitHub Actions) and the website field (the demo, once Pages has deployed it) are
  settings, changed with `gh repo edit` or the API; the social preview has no API and is uploaded
  by hand under *Settings → General* (`docs/social-preview.png`). GHCR's package page reads the
  description and license from the annotations `release.yml` writes on the image index. When the
  pitch changes, change those too.

## Conventions

- Comments explain *why*, especially where the code works around one of the quirks above. Do not
  narrate what the next line does.
- Errors surfaced to the user should name the cause (`httperr.Error` with a real status; XML-RPC
  faults become 502 with rtorrent's own message, prefixed with the command that failed when it
  came out of a multicall).
- Anything that deletes data must stay inside `Config.DeleteRoots` (checked by `assertDeletable`).
- A per-torrent directory change stops and closes the torrent before setting its path, and leaves
  it stopped for the owner to move the data and recheck it. Keep those lifecycle commands separate
  and in the per-torrent mutation queue, as for recheck and throttle changes.
- Log lines are parsed by `parseLogLine` (`web/src/format.ts`, tested): rtorrent writes `<epoch
  seconds> <level letter> <text>` for the severity scopes and `<epoch seconds> <text>` (no level)
  for the subsystem scopes such as `tracker_events` — the same two shapes on 0.9.8, 0.16.20 and
  0.16.22, checked — and the dialog renders the time in the viewer's timezone. Anything that does
  not match is shown verbatim rather than mangled to fit, which is what keeps a crash dump or a
  future format readable. Note that rtorrent buffers the log: right after boot the file is empty on
  every release, so read it after some activity before concluding a build does not log. The day
  separator exists because the row shows only a clock: without it, a log spanning midnight is
  ambiguous — and being sticky, it must be painted in `--bg` rather than one of the `--panel-*`
  washes: those are transparent overlays meant to sit on a solid surface, and one used here let
  every scrolled row show straight through the heading.
- Log scopes raised in the UI are written **twice**: the entrypoint reads them out of the state
  file and emits `log.add_output` lines into the generated rc (so they cover rtorrent's own
  startup — the session load and the first announces happen before the web server has
  connected), and the server re-attaches them once rtorrent has restarted (so a mid-run restart,
  which the supervisor performs without regenerating the rc, gets them back too). Attaching a scope
  twice is a no-op in rtorrent — measured, three attaches still yield one line — so the belt and
  the braces cannot double anything.
- Log verbosity is asymmetric on purpose: `log.add_output` attaches a scope to the running log
  (empty-string target, then scope and output name — the output is the "cascade" file the
  entrypoint opened), but **no release has a command to detach one**, so lowering only means
  "stop re-attaching". The UI asks for a container restart, since an automatic rtorrent restart
  reuses the generated rc and can re-attach a scope saved before boot. UI-raised scopes
  persist in the store and are re-applied after a restart exactly like throttle groups; the boot
  scopes come back by themselves, being baked into rtorrent.rc from `RT_LOG_LEVEL` (which the
  entrypoint exports, filtered to what this build accepts, so the server can show them as fixed).
  `service.LogScopes` is both the offer and the input allowlist — rtorrent faults on unknown
  names. The entrypoint reads the saved scopes with `cascade log-scopes FILE`, which prints
  nothing for a missing or corrupt file and only names shaped like a scope, so a hand-edited file
  cannot inject rc lines; without its argument it is a usage error.
- **What a restarted rtorrent forgets** — the throttle groups, the UI's log scopes and the
  startup settings — is put back by the housekeeping tick (`lifecycle.go`). The tick samples the
  rates and `system.pid` in one multicall, and `noteSession` marks all three for re-applying when
  the pid changes, or, on a build without `system.pid`, when contact was lost and came back. A
  passing failure against the same rtorrent re-applies nothing: the startup settings would undo
  whatever was changed in the UI since. Of the startup settings, a refusal (an rtorrent fault or
  a 4xx from the settings table, told apart by `refused`) is logged once and not retried; a
  failure to get an answer is retried on the next tick even with the same pid, since a dropped
  request is lost and sending the same values again is harmless.
- "Recheck & restart" is two halves on purpose: the action stops, clears the stale `d.message`
  (which otherwise outranks everything in the status derivation and hides the running check) and
  queues `d.check_hash`; the housekeeping tick then feeds `d.hashing` readings into
  `pendingRestarts` (`internal/service/restarts.go`, a pure decision, tested) and issues
  `d.open`/`d.start` as separate calls when a check ends — never batched with anything, per
  quirk 5. The check can outlive any HTTP request, which is why the restart cannot live in the
  handler; pending entries survive only in memory and expire after a day.
- **The UI watches one stream rather than polling.** `GET /api/stream` sends a page a snapshot of
  the state, then only what changed; the wire format is in the README (*The state stream*).
  `internal/stream`'s hub reads the state once per interval however many pages are open, not at
  all while none is, and straight after any request that may have changed something, so an
  action's effect arrives without the page asking. That wake is in `route` (`server.go`): every
  request but GET, HEAD and OPTIONS wakes the hub unless it was answered 400, 404, 409, 413 or
  415 (`refusedAsSent`) — refusals the API and the service make before asking rtorrent to change
  anything. A 403 or a 5xx still wakes it: a data delete is refused with 403 *after* the torrent
  was erased, and a failure can follow half a change. So a 400, 404, 409, 413 or 415 must never follow
  a change — keep that true when adding one deep in the service. The interval is
  `status.statePollMs` — the user's preference, else
  `CASCADE_STATE_POLL_MS` (500 ms) — within 100 ms to a minute. The state is held as a tree whose
  branches are decoded and whose leaves (a torrent, a history sample, a status value) stay raw
  JSON until their bytes differ, so a read of 500 torrents diffs in about a millisecond. The patch
  rules are in `patch.go`'s header, `web/src/stream.ts` applies them, and both are tested against
  `internal/stream/testdata/patches.json`.

  The stream is held to the cross-site rule although it is a GET — it keeps rtorrent busy for as
  long as it is open — and to 100 open at once (`maxSubscribers`; one more is a 503 with
  `Retry-After`), since each holds a goroutine, a queue and a compressor and, without Basic auth,
  anyone who reaches the port can open them. Every write has a 30 s deadline: a client that stops
  reading is dropped by the hub once its queue fills, but a write blocked on a full socket would
  never see that. In the browser, `streamConnection.ts` owns the connection (DOM-free and tested;
  `useStateStream` only wires it to React and the document): it reconnects by hand from the last
  event applied, never through EventSource's own retry, which would replay from the URL's stale
  `since`; reopens quietly half a second after a working stream ends, and backs off (3 s doubling
  to 30 s) after one that never worked; closes while the page is hidden; and, since EventSource
  says nothing about why it failed, asks the API — whose answer counts only for the outage it was
  asked about (the `opens` counter).
- rtorrent is single threaded and does not enjoy being hammered: `MaxConcurrency` in
  `internal/rtorrent/client.go` caps the requests in flight, and every repeating reader — the
  stream's hub, the server's rate sampler, the browser's `usePolling` — waits for one answer before
  scheduling the next, so a slow response never stacks requests (the SCGI timeout is 30s; an
  interval would queue ticks behind a hung rtorrent). What the reads cost rtorrent, measured with
  110 torrents and a page open: about 9% of a core at the 100 ms floor and about 2% at the 500 ms
  default; 500 torrents cost roughly four times as much. Nothing is read for the stream while no
  page is open. `usePolling` (`hooks.ts`) is left for what the state does not carry — the
  detail pane, the throttle dialog and the log — and pauses while the tab is hidden. Its task gets
  `isCurrent()`: an answer that arrives after the inputs changed (another torrent, another tab) or
  the component closed is for the old question and is dropped, which is also why the detail pane
  keys what it shows by hash and renders "Loading…" rather than the last torrent's files.
- The XML-RPC decoder has two paths. rtorrent's answers are plain, well-formed XML, and the
  listing multicall is half a megabyte of it per read, so `decodeFast` reads that shape in one
  pass; anything off it (comments, CDATA, attributes, an unknown type, an int past int64) is
  declined and the permissive parser reads the document instead. `fast_test.go` holds the two to
  the same answer on every input, including 3,000 random values through the encoder — a
  processing instruction, for one, ends at `?>` in both, not at the first `>` a quoted value may
  hold. The encoder refuses what XML-RPC cannot carry rather than sending it: a non-finite number,
  and a whole number outside int64. The second is not pedantry: an `<i8>` past int64 does not
  fault, it kills rtorrent (xmlrpc-c 1.51.8, 0.16.24), and rtorrent refuses `<double>` (-501), so
  there is no other encoding to fall back on. `rtorrent.Client.Call` turns any encode failure into
  a 400, which is what the console's `POST /api/rpc` and a JSON body to `/RPC2` answer with.
  Whole numbers are written with their exact integer digits, not the browser's shortest form.
- `status` looks its multicall answers up by command name, not position, so adding a probe cannot
  shift another into the wrong slot. Optional probes (`dht.statistics`) are only asked for when
  `Capabilities.Supports` says so; the same goes for actions — `announce` and the tracker toggle are
  refused with a 501 on a backend without the command, which is what the `trackerAnnounce` and
  `trackerToggle` entries in `featureMethods` exist for.
- Input is validated at the API edge (`internal/validate`, and `requireHash`/`requireIndex` in
  `internal/httpapi/request.go`) and answered with a 400 that names the field. A field that is
  absent is left alone and one that is `null` is refused like any other wrong type — look fields up
  with the comma-ok form, never by reading a missing key as its zero value. An unchecked `NaN`
  priority or index used to reach rtorrent and come back as an opaque 502 fault. Bulk routes go
  through `bulk()`, which applies the action per hash and collects failures by hash instead of
  stopping at the first. Whitespace is the browser's: `validate.Trim` trims by `jsnum.IsSpace`,
  as `String.prototype.trim` does (the byte order mark goes, U+0085 stays).
- **A change runs to its end once it is sent.** The `api` adapter (`request.go`) detaches every
  request but GET, HEAD and OPTIONS from its context (`context.WithoutCancel`), `/RPC2` does the
  same, and the service's mutations detach again (`detached`): a throttle change stops the torrent,
  sets it and starts it again, and a closed tab abandoning that halfway would leave it stopped; a
  load dropped while it waited would let the next add in the queue take the torrent for its own.
  The SCGI timeout still bounds every call. Reads stay cancellable — except the shared state and
  listing reads, which outlive any one caller. On shutdown `main.go` stops the housekeeping (a
  read in flight is abandoned, a restart after a recheck seen through), cancels the base context,
  which ends the open streams (a graceful shutdown would otherwise wait on them forever), gives
  requests five seconds to drain and then flushes the store once more.
- `DELETE /api/throttles/:name` is a 404 for a group the store never saved: `throttle.up` on an
  unknown name would *create* that group in rtorrent rather than remove anything.
- Confirmations and text prompts are in-app (`components/dialogs.tsx`, promise-shaped:
  `await dialogs.confirm(...)` / `await dialogs.prompt(...)`), not `window.confirm`/`prompt`:
  they follow the theme, list the torrents an action applies to (`items`, on both), offer
  existing labels, and do not hold up the stream. A request that arrives while another is showing
  answers the first as cancelled — left unanswered, its caller would wait forever. While one is
  open `dialogs.open` is true and the app's global shortcuts stand down, so Escape closes it
  without also clearing the selection and Delete cannot stack a second confirmation. The
  right-click menu is `components/TorrentMenu.tsx`; every item closes the menu before acting.
- Modals stack (`Modal` in `modal.tsx`): a confirmation over the throttle dialog is two, Escape
  closes only the top one, Tab stays inside it, and focus goes back where it came from — or, when
  that element is gone, into the dialog underneath (`focus.ts`). Menus (`ContextMenu`, the theme
  picker) share `useMenuKeys` (`menu.tsx`): the first item takes focus, arrows/Home/End move,
  Escape or Tab closes. What an open menu does with a `contextmenu` event is
  `contextMenuVerdict` (`menuRules.ts`): one landing *inside* it is the keyboard's menu key
  arriving after the keydown that opened it, so the menu stays and the browser's is held back;
  one outside that a handler already claimed (`defaultPrevented`) is left to that handler — a
  right-click on another row, which moves the menu there, and also the very right-click that
  opened this menu, which reaches `window` after it has mounted. Closing on those left no menu at
  all. Any other right-click closes it.
- Toasts (`toast.tsx`) wait while a mouse rests on the stack or the keyboard is in it
  (`toastsHeld`, `toastHold.ts`). Only a mouse counts: a touch screen leaves `:hover` on whatever
  was tapped last, which used to keep every toast from the first tap on.
- **A component that handles a key claims it with `preventDefault()`.** The app's global keydown
  handler returns on `defaultPrevented`, in a text field, while a modal is open and while a menu
  is — that is what stops the detail pane's resize handle (↑/↓) or the tab list (←/→) from also
  moving the row selection.
- Selection lives in `selection.ts` (pure, tested). **Actions reach only visible rows**:
  `actionTargets` is the selected rows the current filter shows, else the focused row if shown.
  A selection survives a filter or search change, but the rows it hides are counted in the pill
  (`+N hidden`) and never acted on — Delete after narrowing the list used to remove torrents that
  had scrolled out of sight. Shift ranges replace the selection from the anchor (so Shift+↑ can
  shrink one), Ctrl/⌘+Shift adds the range.
- Forms go through `Field` (`form.tsx`), which ties the label to the first control by id and wires
  its hint or error in as `aria-describedby`, and values that must parse go through
  `ParsedInput`: the text is kept as typed, `aria-invalid` flags what does not parse, and the
  dialog holds its Apply until it does. Never coerce a typo to a default — `parseRate` used to
  read "12 parsecs" as 0, which rtorrent takes as *unlimited*. `parseRate` and
  `parseWholeNumber` answer `null` for anything they do not understand.
- **Secrets never reach the screen.** Tracker URLs, `d.message` and log lines pass through
  `redactUrl` / `redactSecrets` (`redact.ts`): passkey-style query parameters, long token path
  segments and `user:pass@` are masked, and only inside `scheme://` spans, so an info hash in the
  same text is untouched. Copied magnet links carry the hash and name, never the trackers.
- Everything that talks to `/api` goes through `request` (`api.ts`), which bounds it with a
  timeout and names what went wrong: a deadline, before the headers or while the body is read,
  is `no response after Ns`; a connection that drops is `cannot reach the Cascade server`;
  "something other than JSON" means only that the body did not parse; a failed status carries
  the server's JSON `error`, else the status line (kept even when the deadline lands while that
  body is read). A caller's own cancel always rejects with the `AbortError` itself, so it can be
  told from a failure.
- `status.policy` mirrors the `CASCADE_ALLOW_*` switches, and the UI stops offering what the
  server forbids: no API console with raw RPC off, no *Remove + delete data* (and a toast for
  Shift+Delete) with data deletion off. The server still refuses both; hiding them only spares
  the user a 403.
- Browser writes must be same-origin (`internal/httpapi/crosssite.go`, checked after `/healthz`
  and before Basic auth; the stream is held to it too, see above). A multipart upload is a
  "simple" request any page can send without a CORS preflight, and the browser attaches Basic
  credentials to it by itself, so without the guard a hostile page could add torrents or rewrite
  settings. It trusts `Sec-Fetch-Site` when present, else `Origin` against `Host` (the first
  `X-Forwarded-Host` behind a proxy), and passes requests with neither — `curl` and scripts are
  not browsers.
- Inline `style` is for computed values only — a bar's width, a colour from data. Anything static
  is a class; the utilities (`.right`, `.faint`, `.dim`, `.warn-text`, `.grow`,
  `.visually-hidden`, …) sit at the end of `styles.css` so they win a tie with a component
  rule.
- `/healthz` is deliberately outside Basic auth and the base path (container healthchecks and
  orchestrator probes must work with `WEB_USER`/`WEB_PASS` and `WEB_BASE_PATH` set) and reveals
  nothing but liveness and whether rtorrent has answered the probe. The image's `HEALTHCHECK` is
  `cascade health`, which asks it on the address the server listens on, directly rather than
  through any proxy in the environment, and gives up inside the check's own five seconds — which
  is why the runtime image has no curl.
- The SPA is served through an `os.Root` on `CASCADE_WEB_ROOT` (`static.go`), so neither a path
  nor a symlink inside the root can lead out of it, and dotfiles are never served. The image has
  no `/etc/mime.types`, so the types of what the UI is built from are registered in code rather
  than left to content sniffing, which `nosniff` forbids.
- Static caching is split by what can change: Vite's content-hashed `assets/` are served
  immutable for a year, and everything else — above all the `index.html` that names those
  hashes — is `no-cache`, so it revalidates (304) on every load. A heuristically cached shell
  used to survive a redeploy and ask for hashed files that no longer existed, which looks like
  a blank page until a hard reload. Every compressible response of 1 KiB or more is compressed
  (`internal/httpapi/compress.go`, klauspost's `gzhttp`): zstd when the client offers it — browsers
  do over HTTPS, so behind a TLS proxy — else gzip, the stream included (one compressed stream,
  flushed after each event). Validators are left alone rather than suffixed per encoding: the
  server's are weak, and a suffix would turn every revalidating poll into a full response. JSON
  reads carry a weak ETag and answer an unchanged poll with a bodiless 304.
- Routes match in the order they are added, first match wins (`internal/httpapi/router.go`), the
  rule the API was defined under: `POST /api/torrents/action/trackers` is the bulk action named
  "trackers", not the tracker list of a torrent whose hash is "action". `http.ServeMux` refuses
  such overlapping patterns outright, which is why it is not used.
- The listing multicall asks only for fields something maps: `d.state` and `d.peers_accounted`
  were fetched on every poll for years and read by nothing, and every stray field is one more
  command per torrent per read on a single-threaded rtorrent.
- CI and releases are described in the README (*Development*); what a maintainer needs beyond
  that: every probe of a running image is `docker/api-smoke.py` — CI's smoke and compat jobs,
  `make smoke` and the release — so they cannot drift apart, and it takes the container's name
  to give up as soon as the container exits. Main pushes skip CI's smoke job because
  `release.yml` builds and probes those commits on both architectures anyway. The smoke and compat
  jobs read the release's `<default>-linux-amd64` build cache: the smoke job reuses main's
  compiled rtorrent from it, the compat job the server and web stages, which do not depend on the
  rtorrent version. The release pushes each platform's image **by digest** and joins them into a
  tagged manifest only after both passed, and pushes the git tag last, in a job of its own: the
  README's image badge reads git tags, so a tag must never name a release that did not publish.
  The tag it pushes does not re-trigger it (GitHub does not run workflows for refs created with
  `GITHUB_TOKEN`), which is why tagging lives in that workflow rather than a separate one.
