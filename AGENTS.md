# AGENTS.md

Guidance for working in this repository.

## What this is

A web UI for rtorrent, shipped as one Docker image that also contains rtorrent. The server is Go,
the UI TypeScript and React. The server talks XML-RPC over SCGI to a local rtorrent, serves the
SPA, and streams the state to every open page as deltas.

```
server/                   the Go module: main.go serves, and answers the entrypoint's
                          subcommands (help, boot-settings, log-scopes, options-docs)
  internal/xmlrpc/        XML-RPC encode/decode, hand-written: a single-pass fast path for
                          rtorrent's plain answers, a permissive parser for everything else
  internal/scgi/          SCGI framing over a unix socket or TCP
  internal/rtorrent/      client.go: request queue + multicall helpers; Client, the interface
                          everything above it depends on (a Transport can be injected).
                          capabilities.go: probes system.listMethods, picks a command dialect.
                          settings.go: every rtorrent global setting as one declarative table.
                          model.go: rtorrent fields -> Torrent/File/Peer/Tracker
  internal/rtorrent/rtorrenttest/  FakeClient, the scripted rtorrent the tests use
  internal/contracts/     the HTTP data shapes (web/src/contracts.ts mirrors them)
  internal/options/       every environment variable as one catalog; renders --help and the
                          README's generated regions, and checks both against the container
  internal/config/        Load(env) -> Config, defaults taken from the catalog; the validated
                          startup settings the entrypoint stages for the server
  internal/service/       all application behaviour, with the per-torrent and per-group
                          mutation queues, the recheck & restart state machine and the
                          delete-data path checks
  internal/store/         the one JSON state file; throttle group validation
  internal/game/          badge definitions, XP and level curve
  internal/torrentfile/   bencode parse: reject non-torrents, derive the info hash
  internal/prefs/         UI preference shape and repair (web/src/preferences.ts mirrors it)
  internal/stream/        the delta stream: the state held as raw leaves, diffs, and the hub
                          that reads it once for every open page
  internal/httpapi/       routes, /api/stream, /RPC2, the static SPA, auth, the cross-site
                          guard, uploads, compression (zstd/gzip), error mapping
  internal/httperr/, validate/  errors that carry an HTTP status; input checks at the edge
  internal/jsnum/         the browser's Number(), for values defined in its terms
web/src/                  React UI: components/, one styles.css of design tokens,
                          theme.ts (themes + effect flavors), grim.ts (black metal
                          copy), assets/ (the retro and black metal wordmarks),
                          useStateStream.ts (the live state), hooks.ts (usePolling,
                          useLatest), prefs.ts (the fetch and the cache); stream.ts,
                          sort.ts, filter.ts, files.ts, format.ts, selection.ts,
                          redact.ts and preferences.ts are the pure logic the node
                          runner can reach
docker/entrypoint.sh      renders rtorrent.rc, supervises rtorrent + the server
docker/move-completed.sh validates completion moves and refuses destination collisions
docker/api-smoke.py       real backend setting, throttle and stream round trips
docker/scripts.test.sh    shell regression checks, also run in the image build
docker/bump-rtorrent.sh   moves the default rtorrent to a newer upstream release
.github/workflows/ci.yml  Go and web tests, options check, Docker build + API smoke
.github/workflows/release.yml  multi-arch GHCR publish, tags every main push
.github/workflows/rtorrent-update.yml  daily: a pull request per new rtorrent
.github/dependabot.yml    Go modules, npm packages and Actions (rtorrent is the workflow's)
```

The server has two dependencies, both chosen by the owner:
[lightning](https://github.com/JohanLindvall/lightning) (the owner's own), through whose
`pkg/json` every JSON decode goes — request bodies, the state and boot-settings files, and above
all the stream's reads of the state — while encoding stays with `encoding/json`; and
[klauspost/compress](https://github.com/klauspost/compress), whose `gzhttp` compresses every
response. The client's only runtime dependency is react. Keep it that way unless there is a real
reason.

## Build and test

No local Go or Node is needed — the toolchains live in the image:

```bash
docker build -t cascade:test .        # vets and tests the server, typechecks and tests the web
```

The web's `tsc` is strict, with `noUnusedLocals` and `noUnusedParameters`, so a build is a real
typecheck — and it also runs both unit suites (`go test ./...` in `server/`, `web/src/*.test.ts`
under node's built-in runner, no frameworks), so a red test is a failed build. The web suite
runs the `.ts` files directly under `--experimental-strip-types`; those files are excluded from
the build tsconfig, which is why the DOM-flavoured web typecheck does not need node types. Pure
logic belongs where the runner can reach it — sorting, filtering, the `.torrent` file check and
drop parsing, the selection rules, redaction, the preference shape and the stream's patching live
in `web/src/sort.ts`, `filter.ts`, `files.ts`, `selection.ts`, `redact.ts`, `preferences.ts` and
`stream.ts` rather than in the components for exactly that reason. A pure module that imports
another spells the specifier with `.ts` (`preferences.ts` → `'./sort.ts'`): the runner resolves
specifiers literally, and Vite and tsc accept either. A module that touches `window` or
`document` at load time cannot be imported by a test at all, which is why `preferences.ts` (the
shape and its repair) is apart from `prefs.ts` (the fetch, the cache, the `pagehide` flush).

Go runs in Docker too, as uid 1000 so the files it writes keep their owner:

```bash
docker run --rm --user 1000:1000 -e HOME=/tmp -v "$PWD":/r -w /r/server golang:1.26-alpine \
  sh -c 'gofmt -l . ; go vet ./... && go test ./... && go run . options-docs'
```

(`golang:1.26`, the Debian image, for `go test -race`, which needs cgo.) The whole repository is
mounted because the server's tests read beyond `server/`: the option catalog is checked against
`docker/entrypoint.sh` and the README, and `internal/game` keeps `web/src/game-catalog.json` —
the badge ids and level titles `grim.test.ts` checks for a black metal entry — in step with its
table (`go test ./internal/game -run Catalog -update` rewrites it). The image's build stage copies
those files in for the same reason.

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
level.

Run it and exercise the API:

```bash
docker run -d --name cascade-test -p 18080:8080 cascade:test
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
the Go modules, the npm packages and the Actions). When such a pull request comes in, read the release notes for
renamed commands and check settings still round-trip (quirk 7) before merging.

Old tags need `-include algorithm -include cstdint` to compile against a current libstdc++; the
Dockerfile passes that to every source build.

A full end-to-end transfer can be staged with two containers and a throwaway tracker: seed a real
file from one, download it in the other, and watch progress, peers and rates in the UI. A
completion — and so the finish animation — can be forced without a swarm: put the payload in
`/downloads` first, then upload its `.torrent`, and rtorrent's hash check completes it outright.

**Check UI work by looking at it.** A build only proves it typechecks; CSS regressions do not
fail a build. Boot the image, seed a few torrents through the API, set the theme with
`PATCH /api/prefs`, and screenshot with headless Chrome at desktop and 390px widths. For anything
that needs interaction or measurement (an open drawer, a dialog, whether a column moved between
polls) drive the same browser over the DevTools protocol — `--remote-debugging-port` — and assert
on `getBoundingClientRect()` rather than on how it looks.

## rtorrent quirks that cost time to discover

These are load-bearing. Breaking them produces faults or, worse, a crashed rtorrent.

1. **Commands take a target argument.** Global setters are
   `throttle.global_up.max_rate.set("", value)`, not `(value)`. Passing the value alone makes
   rtorrent read it as a target and fault with `-503 Wrong object type` (or `-501 Could not find
   info-hash`). `SettingEntries` in `internal/rtorrent/settings.go` adds the `""` for you. Getters are fine with no
   arguments. Per-torrent commands take the info hash as that target, and file/tracker commands
   take `"<hash>:f<index>"` / `"<hash>:t<index>"`.

2. **`protocol.encryption.set` takes one argument per flag** — `("", "allow_incoming",
   "try_outgoing")`, not one comma-joined string.

3. **Throttle groups.** rtorrent has no per-torrent rate limit; it has named groups created with
   `throttle.up("", name, rate)` and assigned with `d.throttle_name.set`. The group setters take
   **whole KiB/s strings**, unlike global setters' bytes/s. `store.NormalizeThrottle` rounds a
   positive fractional KiB up and stores the actual byte value; never feed API bytes directly to
   these setters. Groups do not survive an rtorrent restart, so they are persisted in the store
   and re-applied on reconnect. They also
   cannot be deleted at runtime — deleting sets them to unlimited.

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
   mode 0700 or screen refuses to start.

10. **Some settings are write-only** — `dht.mode` has `.set` but no getter, and while 0.16 grew a
   `protocol.encryption` getter it reports internal flag names (`handshake_allow`, …) that the
   setter refuses, so neither value can round-trip and the UI shows "(leave unchanged)" instead.

11. **Labels live in `d.custom1`**, URL-encoded (the ruTorrent convention), which is why
   `MapTorrent` decodes and `SetLabel` encodes.

12. **libtorrent opens files under the exact name in the torrent, and Linux caps a path
   component at 255 bytes** — so a Thai or CJK title of ~85 characters fails every open with
   `ENAMETOOLONG`, which reaches the UI as "Hash check I/O error at chunk 0: Filename too long"
   and a torrent that can never start. The image patches libtorrent at build time
   (`docker/patches/`): `path_fit.h` shortens an over-long component to fit — stem cut at a
   UTF-8 boundary, `~` plus an 8-hex FNV-1a tag of the original so two names differing past the
   cut usually remain distinct (a finite hash cannot guarantee no collisions), extension kept —
   and `apply-libtorrent.sh` wires it into the three
   places that turn names into filesystem paths: `Path::as_string` (the file), 
   `FileList::make_directory` (each directory), and `FileList::set_root_dir` (the root rtorrent
   composes from the download directory and the torrent's *name* — for a multi-file torrent
   that name is a directory and never passes through `Path`, which is how the first cut of the
   patch still failed multi-file torrents). It is pattern-based rather than a diff per release,
   knows the spellings of 0.13.x/0.15.x/0.16.x, and fails the build if a spelling is missing; it
   also compiles and runs `path_fit_test.cc` with the same toolchain first. What reports what:
   `d.name` and `f.path` keep the torrent's own names (rtorrent joins `f.path` from the
   components itself, deliberately left alone); `frozen_path`, `d.base_path` and `d.directory`
   are the on-disk truth, so delete-data is right. The Files tab fetches `f.frozen_path` and
   shows "on disk as …" when the two differ (`MapFile`'s `OnDisk`). `docker/patches/apply-<repo>.sh`
   is the general hook — one per repository, run after clone and before configure.

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
   tracker checking both sees a mismatch otherwise. Prefixes: 0.13.8 `-lt0D80-`; from 0.15 on,
   `-lt` and the minor and patch release as two hex digits each (0.15.2 `-lt0F02-`, 0.16.20
   `-lt1014-`, 0.16.23 `-lt1017-`, 0.16.24 `-lt1018-`).

## Adding support for a new backend command

Never call a command unconditionally.

- **A global setting** is one entry in the table in `internal/rtorrent/settings.go` — getter, setter (with
  alternates, newest first, when a release renamed it), and a coercion kind — plus a form field in
  `SettingsDialog.tsx`. The table drives `/api/settings` reads, writes, the boot-settings warning,
  and the `supports` map: every setting key automatically becomes a feature that is true when the
  backend has a working setter, and the dialog greys the control out by that same key. Remember
  quirk 7: set the value and read it back on the oldest and newest rtorrent before trusting it.
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
- **Counters keep moving with no browser open**: the poll tick refreshes them every 30s, and
  every read of the state refreshes them while a page is open.

Badges are pure functions of the stats (`game.Achievements` in `internal/game`), so adding one is a
single entry — with a `unit` (`count`, `bytes`, `rate`, `ratio`, `duration`), which is how the UI
formats its progress (`progressText` in `format.ts`) instead of guessing from the id — but the
unlock timestamp is persisted, so a badge whose condition later stops holding stays earned. `CASCADE_GAMIFY=0` disables the whole layer; the UI keys off
`game.enabled`, so anything you add must be behind that flag too.

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

## Persistence

Everything Cascade remembers is in one JSON file, `/config/cascade-state.json`, owned by
`internal/store`: UI preferences, gamification counters and unlocked badges, per-torrent add times and
last-seen totals, and throttle groups. Writes are debounced and go through a temp file plus rename,
so add state there rather than introducing another file.

**Only a real change may dirty the store.** `RecordTorrents` folds the whole list in on every
poll, and an unconditional `scheduleFlush` there meant an idle session rewrote the JSON file
every two seconds for as long as a browser was open. Every mutation site now sets a `changed`
flag first (the ever-growing seed clock coarsens to the minute for the same reason), and the
store test pins it: fold the same list twice, and the second fold must not recreate a deleted
state file. Keep that property when adding counters.

Preferences are validated in `internal/prefs` (`Sanitize`) before being stored — an unknown
theme or sort key falls back to the default instead of reaching the UI. The browser keeps a
localStorage copy of the preferences, but only as a cache so the theme can apply on first paint;
the file always wins once it loads, and the cache is repaired on read (`normalizePreferences`)
because a browser's storage can hold anything. Browser-side writes are debounced and flushed on
`pagehide` with `keepalive`. `web/src/preferenceSync.ts` orders saves, retries failures without
dropping newer edits, and protects edits made while the initial server copy is loading. The
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
touching four places: the token block in `styles.css`, `THEME_MODES`/`THEME_COLORS` in `theme.ts`,
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
`addTorrentFile` has to be trustworthy:

- `load.raw_start` returns 0 for **any** payload — a corrupt file only shows up in rtorrent's log —
  so `internal/torrentfile` parses the bencode first and rejects what is not a torrent, with the
  reason.
- The same parse yields the info hash, and the load is confirmed by waiting for that hash to appear
  in the session. `load.*` is queued, not immediate, so "the call returned" is not "it loaded".

Failures come back per file in the upload response and are toasted by the UI.
The response also identifies failed file and URL indices, so the Add dialog retains only failures
for retry. The upload ceiling is for the combined file bytes, including chunked requests; a
per-file limit alone cannot bound a 50-file batch's memory use.

Two things about the drop handling are load-bearing:

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

Both read their `onDone` through `useLatest` (`hooks.ts`) and depend only on the trigger id. That
is not incidental — the app re-renders on every update of the state, so an inline `onDone={() => ...}` in the
dependency array tears the effect down and restarts the sequence one and a half seconds in. The
visible symptom is subtle (the tail of the animation silently never runs), so if you add another
timed effect, follow the same pattern. `useLatest` writes its ref in a layout effect, not during
render — a render React throws away would otherwise leave its values behind — and the app's
global keydown listener is attached once and reads its handler the same way.

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
close the menu the instant it opened.

**Nothing that updates on the poll may size its own container.** Both tables run
`table-layout: fixed` with per-column widths (`th.col-*`), the header's rate readouts and level
chip have fixed widths, and the card layout's rate spans have a `min-width` — because an ETA
ticking from `2m 54s` to `2m 9s` is one character narrower, and with content-sized columns the
name column absorbs the difference and the whole table steps sideways twice a second. Column
widths are percentages so narrow windows squeeze rather than scroll; check with
`getBoundingClientRect()` on the `th`s before and after a value change, not by eye.

Two other things are easy to get wrong here:

- **Button labels must be wrapped in a `<span>`.** The compact rules hide labels to leave icons;
  a bare text node inside a button cannot be targeted. An icon-only button carries an
  `aria-label`; the icons themselves are `aria-hidden`.
- **Do not let anything scroll the page sideways.** `html, body` are capped at `100%` with
  `overflow-x: hidden`; wide content scrolls inside its own container instead. Check new layout
  work at 360px before calling it done.

## Conventions

- Comments explain *why*, especially where the code works around one of the quirks above. Do not
  narrate what the next line does.
- Errors surfaced to the user should name the cause (`httperr.Error` with a real status; XML-RPC
  faults become 502 with rtorrent's own message, prefixed with the command that failed when it
  came out of a multicall).
- Anything that deletes data must stay inside `config.deleteRoots`.
- A per-torrent directory change stops and closes the torrent before setting its path, and leaves
  it stopped for the owner to move the data and recheck it. Keep those lifecycle commands separate
  and in the per-torrent mutation queue, as for recheck and throttle changes.
- Log lines are parsed by `parseLogLine` (`web/src/format.ts`, tested): rtorrent writes
  `<epoch seconds> <level letter> <text>` for the severity scopes and `<epoch seconds> <text>`
  (no level) for the subsystem scopes such as `tracker_events` — the same two shapes on 0.9.8,
  0.16.20 and 0.16.22, checked — and the dialog renders the time in the viewer's timezone.
  Anything that does not match is shown verbatim rather than mangled to fit, which is what
  keeps a crash dump or a future format readable. Note that rtorrent buffers the log: right
  after boot the file is empty on every release, so read it after some activity before
  concluding a build does not log. The day separator exists because the row shows only a clock: without it, a log
  spanning midnight is ambiguous — and being sticky, it must be painted in `--bg` rather than
  one of the `--panel-*` washes: those are transparent overlays meant to sit on a solid
  surface, and one used here let every scrolled row show straight through the heading.
- Log scopes raised in the UI are written **twice**: the entrypoint reads them out of the state
  file and emits `log.add_output` lines into the generated rc (so they cover rtorrent's own
  startup — the session load and the first announces happen before the web server has
  connected), and the server re-attaches them on connect (so a mid-run rtorrent restart, which
  the supervisor performs without regenerating the rc, gets them back too). Attaching a scope
  twice is a no-op in rtorrent — measured, three attaches still yield one line — so the belt and
  the braces cannot double anything.
- Log verbosity is asymmetric on purpose: `log.add_output` attaches a scope to the running log
  (empty-string target, then scope and output name — the output is the "cascade" file the
  entrypoint opened), but **no release has a command to detach one**, so lowering only means
  "stop re-attaching after the next rtorrent restart" and the UI says so. UI-raised scopes
  persist in the store and are re-applied on reconnect exactly like throttle groups; the boot
  scopes come back by themselves, being baked into rtorrent.rc from `RT_LOG_LEVEL` (which the
  entrypoint now exports so the server can show them as fixed). `service.LogScopes` is both the
  offer and the input allowlist — rtorrent faults on unknown names. The entrypoint reads the
  saved scopes with `cascade log-scopes`, which prints nothing for a missing or corrupt file.
- "Recheck & restart" is two halves on purpose: the action stops, clears the stale
  `d.message` (which otherwise outranks everything in the status derivation and hides the
  running check) and queues `d.check_hash`; the poll tick then feeds `d.hashing` readings into
  `PendingRestarts` (pure, tested) and issues `d.open`/`d.start` as separate calls when a check
  ends — never batched with anything, per quirk 5 (`pendingRestarts` in
  `internal/service/restarts.go`). The check can outlive any HTTP request,
  which is why the restart cannot live in the handler; pending entries survive only in memory
  and expire after a day.
- **The UI watches one stream rather than polling.** `GET /api/stream` (server-sent events)
  sends a page a snapshot of the state, then only what changed. `internal/stream`'s hub reads the
  state once per interval however many pages are open, not at all while none is, and straight
  after any request that may have changed something (the HTTP layer wakes it after every
  non-GET), so an action's effect arrives without the page asking. The interval is
  `status.statePollMs` — the user's preference, else `CASCADE_STATE_POLL_MS` (100 ms) — within
  100 ms to a minute. The state is held as a tree whose branches are decoded and whose leaves (a
  torrent, a history sample, a status value) stay raw JSON until their bytes differ, so a read of
  500 torrents diffs in about a millisecond; `torrents` and `status.history` travel keyed by hash
  and by `t`. The patch rules are in `patch.go`'s header, `web/src/stream.ts` applies them, and
  both are tested against `internal/stream/testdata/patches.json`. Every event but `failure`/`ok`
  carries an id (`<epoch>-<rev>`); a page back from a hidden tab reopens with `?since=` (a
  reconnecting EventSource sends `Last-Event-ID`, which wins) and gets the deltas it missed when
  they are still kept, else a snapshot. The browser reconnects by hand from the last event it
  applied, never through EventSource's own retry, which would replay from the URL's stale
  `since`.
- rtorrent is single threaded and does not enjoy being hammered: `MaxConcurrency` in
  `internal/rtorrent/client.go` caps the requests in flight, and every repeating reader — the
  stream's hub, the server's rate sampler, the browser's `usePolling` — waits for one answer
  before scheduling the next, so a slow response never stacks requests (the SCGI timeout is 30s;
  an interval would queue ticks behind a hung rtorrent). A listing read costs rtorrent about 1 ms
  per hundred torrents; at 100 ms that is a tenth of its time with 1,000 torrents, paid only while
  a page is open. `usePolling` (`hooks.ts`) is left for what the state does not carry — the
  detail pane, the throttle dialog and the log — and pauses while the tab is hidden. Its task
  gets `isCurrent()`: an answer that arrives after the inputs changed (another torrent, another
  tab) or the component closed is for the old question and is dropped, which is also why the
  detail pane keys what it shows by hash and renders "Loading…" rather than the last torrent's
  files.
- The XML-RPC decoder has two paths. rtorrent's answers are plain, well-formed XML, and the
  listing multicall is half a megabyte of it per read, so `decodeFast` reads that shape in one
  pass; anything off it (comments, CDATA, attributes, an unknown type, an int past int64) is
  declined and the permissive parser reads the document instead. `fast_test.go` holds the two to
  the same answer on every input, including 3,000 random values through the encoder.
- `status` looks its multicall answers up by command name, not position, so adding a probe
  cannot shift another into the wrong slot. Optional probes (`dht.statistics`) are only asked
  for when `supports()` says so; the same goes for actions — `announce` and the tracker toggle
  are refused with a 501 on a backend without the command, which is what the `trackerAnnounce`
  and `trackerToggle` entries in `featureMethods` exist for.
- Input is validated at the API edge (`internal/validate`, and `requireHash`/`requireIndex` in
  `internal/httpapi/api.go`) and answered with a 400 that names the field. A field that is
  absent is left alone and one that is `null` is refused like any other wrong type — look fields
  up with the comma-ok form, never by reading a missing key as its zero value. An unchecked `NaN` priority or index used to
  reach rtorrent and come back as an opaque 502 fault. Bulk routes go through `bulk()`, which
  applies the action per hash and collects failures by hash instead of stopping at the first.
- `DELETE /api/throttles/:name` is a 404 for a group the store never saved: `throttle.up` on an
  unknown name would *create* that group in rtorrent rather than remove anything.
- Confirmations and text prompts are in-app (`components/dialogs.tsx`, promise-shaped:
  `await dialogs.confirm(...)` / `await dialogs.prompt(...)`), not `window.confirm`/`prompt`:
  they follow the theme, list the torrents an action applies to (`items`, on both), offer
  existing labels, and do not block the poll. A request that arrives while another is showing
  answers the first as cancelled — left unanswered, its caller would wait forever. While one is
  open `dialogs.open` is true and the app's global shortcuts stand down, so Escape closes it
  without also clearing the selection and Delete cannot stack a second confirmation. The
  right-click menu is `components/TorrentMenu.tsx`; every item closes the menu before acting.
- Modals stack (`Modal` in `ui.tsx`): a confirmation over the throttle dialog is two, Escape
  closes only the top one, Tab stays inside it, and focus goes back where it came from — or, when
  that element is gone, into the dialog underneath. Menus (`ContextMenu`, the theme picker) share
  `useMenuKeys`: the first item takes focus, arrows/Home/End move, Escape or Tab closes. A
  `contextmenu` event landing *inside* an open menu is the keyboard's menu key arriving after the
  keydown that opened it, so the menu stays and the browser's is held back.
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
- Forms go through `Field` (`ui.tsx`), which ties the label to the first control by id and wires
  its hint or error in as `aria-describedby`, and values that must parse go through
  `ParsedInput`: the text is kept as typed, `aria-invalid` flags what does not parse, and the
  dialog holds its Apply until it does. Never coerce a typo to a default — `parseRate` used to
  read "12 parsecs" as 0, which rtorrent takes as *unlimited*. `parseRate` and
  `parseWholeNumber` answer `null` for anything they do not understand.
- **Secrets never reach the screen.** Tracker URLs, `d.message` and log lines pass through
  `redactUrl` / `redactSecrets` (`redact.ts`): passkey-style query parameters, long token path
  segments and `user:pass@` are masked, and only inside `scheme://` spans, so an info hash in the
  same text is untouched. Copied magnet links carry the hash and name, never the trackers.
- `status.policy` mirrors the `CASCADE_ALLOW_*` switches, and the UI stops offering what the
  server forbids: no API console with raw RPC off, no *Remove + delete data* (and a toast for
  Shift+Delete) with data deletion off. The server still refuses both; hiding them only spares
  the user a 403.
- Browser writes must be same-origin (`internal/httpapi/crosssite.go`, checked after `/healthz`
  and before Basic
  auth). A multipart upload is a "simple" request any page can send without a CORS preflight, and
  the browser attaches Basic credentials to it by itself, so without the guard a hostile page
  could add torrents or rewrite settings. It trusts `Sec-Fetch-Site` when present, else `Origin`
  against `Host` (the first `X-Forwarded-Host` behind a proxy), and passes requests with neither —
  `curl` and scripts are not browsers.
- Inline `style` is for computed values only — a bar's width, a colour from data. Anything static
  is a class; the utilities (`.right`, `.faint`, `.dim`, `.warn-text`, `.grow`,
  `.visually-hidden`, …) sit at the end of `styles.css` so they win a tie with a component
  rule.
- `/healthz` is deliberately outside Basic auth (container healthchecks and orchestrator probes
  must work with `WEB_USER`/`WEB_PASS` set) and reveals nothing but liveness.
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
  command per torrent per poll on a single-threaded rtorrent.
- CI (`.github/workflows/ci.yml`) checks the server's formatting, vets and tests it under the race
  detector, checks the option catalog, typechecks and tests the web, and smoke-tests the built
  image on pull requests; the 0.9.8/0.15.2 compat matrix runs on manual dispatch. Main pushes skip the smoke
  job because `release.yml` builds and probes those commits on both architectures anyway.
- `release.yml` publishes to GHCR. Every push to main is a release: it tags the commit
  `v0.1.<run_number>` and publishes `cascade:<version>-<rtorrent-version>` (plus the bare
  `<version>` and `latest` for the default rtorrent, which its first job reads from the
  Dockerfile); pushing a `vX.Y.Z` tag publishes under that name instead. Builds run per platform on native amd64/arm64 runners, are pushed **by digest**,
  smoke-tested on their own architecture, and only then joined into a tagged manifest — so a
  broken or half-built release never claims a tag. The tag the workflow pushes does not
  re-trigger it (GitHub does not run workflows for refs created with `GITHUB_TOKEN`), which is
  why tagging lives in that workflow rather than a separate one.
