# CLAUDE.md

Guidance for working in this repository.

## What this is

A web UI for rtorrent, shipped as one Docker image that also contains rtorrent. TypeScript on
both sides. The backend talks XML-RPC over SCGI to a local rtorrent; the frontend is a React SPA
served by that same backend.

```
server/src/
  xmlrpc.ts       XML-RPC encode/decode, hand-written (no dependency)
  scgi.ts         SCGI framing over a unix socket or TCP
  rtorrent.ts     request queue + multicall helpers
  capabilities.ts probes system.listMethods, picks a command dialect
  model.ts        rtorrent fields -> Torrent/File/Peer/Tracker
  settings.ts     every global setting as one declarative table (see below)
  service.ts      all application behaviour
  achievements.ts badge definitions, XP and level curve
  api.ts          REST routes + /RPC2 passthrough
  index.ts        express wiring, static SPA, auth, error mapping
web/src/          React UI; components/ + one styles.css of design tokens
docker/entrypoint.sh  renders rtorrent.rc, supervises rtorrent + node
.github/workflows/ci.yml  typecheck + Docker build + API smoke on every push
```

There are no runtime dependencies beyond express and multer on the server, and react on the
client. Keep it that way unless there is a real reason.

## Build and test

No local Node is needed — the toolchain lives in the image:

```bash
docker build -t cascade:test .        # typechecks server and web, fails the build on errors
```

Both `tsc` runs are strict (`noUnusedLocals` on the web side), so a build is a real typecheck.

Run it and exercise the API:

```bash
docker run -d --name cascade-test -p 18080:8080 cascade:test
curl -s localhost:18080/api/capabilities        # which backend am I talking to
curl -s localhost:18080/api/state               # what the UI polls
```

rtorrent is always compiled from an upstream tag; there is no distro-package path. To test against
a different one, rebuild with `--build-arg RTORRENT_VERSION=0.9.8` (or `make matrix`, which builds
0.9.8, 0.15.2 and 0.16.20). **Changes to the backend should be checked against at least the oldest
and newest**, because the command set genuinely differs.

Old tags need `-include algorithm -include cstdint` to compile against a current libstdc++; the
Dockerfile passes that to every source build.

A full end-to-end transfer can be staged with two containers and a throwaway tracker: seed a real
file from one, download it in the other, and watch progress, peers and rates in the UI.

## rtorrent quirks that cost time to discover

These are load-bearing. Breaking them produces faults or, worse, a crashed rtorrent.

1. **Commands take a target argument.** Global setters are
   `throttle.global_up.max_rate.set("", value)`, not `(value)`. Passing the value alone makes
   rtorrent read it as a target and fault with `-503 Wrong object type` (or `-501 Could not find
   info-hash`). `service.updateSettings`'s `push()` helper adds the `''` for you. Getters are fine
   with no arguments. Per-torrent commands take the info hash as that target, and file/tracker
   commands take `"<hash>:f<index>"` / `"<hash>:t<index>"`.

2. **`protocol.encryption.set` takes one argument per flag** — `("", "allow_incoming",
   "try_outgoing")`, not one comma-joined string.

3. **Throttle groups.** rtorrent has no per-torrent rate limit; it has named groups created with
   `throttle.up("", name, rate)` and assigned with `d.throttle_name.set`. Groups do not survive an
   rtorrent restart, so they are persisted in `store.ts` and re-applied on reconnect. They also
   cannot be deleted at runtime — deleting sets them to unlimited.

4. **A running download rejects a throttle change** ("Cannot set throttle on active download"), so
   `setTorrentThrottle` stops it, sets, and restarts.

5. **Do not batch stop/set/start into one `system.multicall`** — it segfaults rtorrent 0.15.2.
   `setTorrentThrottle` deliberately issues separate requests. Be suspicious of any multicall that
   mixes lifecycle changes with other commands.

6. **`rtorrent.rc` must only contain commands that exist in every supported version** — rtorrent
   aborts on an unknown command in its config file. That is why the entrypoint writes a minimal rc
   (paths, port, scgi, log, watch dir) and hands everything else to the server as
   `/run/cascade/boot-settings.json`, which goes through the same capability-filtered
   `updateSettings` path. **Add new tunables there, not to the rc.**

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

9. **rtorrent needs a pty**, so it runs inside a detached `screen` session. `SCREENDIR` must be
   mode 0700 or screen refuses to start.

10. **Some settings are write-only** — `dht.mode` has `.set` but no getter, and while 0.16 grew a
   `protocol.encryption` getter it reports internal flag names (`handshake_allow`, …) that the
   setter refuses, so neither value can round-trip and the UI shows "(leave unchanged)" instead.

11. **Labels live in `d.custom1`**, URL-encoded (the ruTorrent convention), which is why
   `mapTorrent` decodes and `setLabel` encodes.

## Adding support for a new backend command

Never call a command unconditionally.

- **A global setting** is one entry in `SETTING_SPECS` (`settings.ts`) — getter, setter (with
  alternates, newest first, when a release renamed it), and a coercion kind — plus a form field in
  `SettingsDialog.tsx`. The table drives `/api/settings` reads, writes, the boot-settings warning,
  and the `supports` map: every setting key automatically becomes a feature that is true when the
  backend has a working setter, and the dialog greys the control out by that same key. Remember
  quirk 7: set the value and read it back on the oldest and newest rtorrent before trusting it.
- **Anything else** (per-torrent commands, probes) goes in `FEATURE_METHODS` in `capabilities.ts`,
  guarded with `capabilities.supports('yourFeature')`.

Field commands in `model.ts` are filtered against `system.listMethods` automatically — a field the
backend lacks simply maps to `0`/`''`.

## The gamification layer

Levels and badges are derived from lifetime counters in `store.ts`, not from anything invented.
Three things are worth knowing before touching it:

- **Totals accumulate as deltas.** `recordTorrents` compares each torrent's `up.total`/`down.total`
  against the last seen value, so removing a torrent does not erase the traffic it contributed. A
  torrent seen for the first time contributes its whole total, which credits a pre-existing
  rtorrent session.
- **Completions are counted once**, via the `everCompleted` tombstone list — otherwise removing
  and re-adding a torrent would inflate the count.
- **Counters keep moving with no browser open**: the poll tick refreshes them every 30s, and
  `state()` refreshes them on every UI poll.

Badges are pure functions of the stats (`ACHIEVEMENTS` in `achievements.ts`), so adding one is a
single entry — but the unlock timestamp is persisted, so a badge whose condition later stops
holding stays earned. `CASCADE_GAMIFY=0` disables the whole layer; the UI keys off
`game.enabled`, so anything you add must be behind that flag too.

The black metal theme re-carves all gamification copy client-side (`web/src/grim.ts`, keyed by
achievement id and level title). It is a pure text skin — never branch unlock logic on it — and a
new badge or level title needs a matching entry there or it shows its plain name in that theme.

## Options and their documentation

Every environment variable the container understands is declared once, in `server/src/options.ts`.
That catalog is load-bearing rather than descriptive:

- `config.ts` looks each default up **by name**, and the lookup throws for a name the catalog does
  not list — so the server cannot read an undocumented variable.
- `docker run --rm cascade --help` renders it (the entrypoint answers `-h`/`--help`/`help` before
  any setup, so it works in any environment).
- The README's `<!-- generated: … -->` regions — the sample `docker run` and the whole
  Configuration section — are produced from it by `npm run options:docs`.
- `npm run options:check` (in CI) fails if the entrypoint reads a variable missing from the
  catalog, if a catalogued option is read by nothing, or if the README has drifted.

Adding an option therefore means adding it to `options.ts` and nowhere else; hand-editing the
generated README regions will fail CI.

## Persistence

Everything Cascade remembers is in one JSON file, `/config/cascade-state.json`, owned by
`store.ts`: UI preferences, gamification counters and unlocked badges, per-torrent add times and
last-seen totals, and throttle groups. Writes are debounced and go through a temp file plus rename,
so add state there rather than introducing another file.

Preferences are validated in `prefs.ts` (`sanitizePreferences`) before being stored — an unknown
theme or sort key falls back to the default instead of reaching the UI. The browser keeps a
localStorage copy of the preferences, but only as a cache so the theme can apply on first paint;
the file always wins once it loads.

## Themes

Five modes: `system`, `light`, `dark`, `retro`, `blackmetal`. `system` resolves through
`prefers-color-scheme` in `theme.ts`, and the resolved value goes on `<html data-theme>`. Themes
are pure token overrides in `styles.css` — components carry no per-theme markup, so a new theme is
a block of custom properties plus, for retro and black metal, a set of shape overrides (zero
radius, offset shadows, stepped bars / grain and vignette). Keep it that way. Adding a theme means
touching four places: the token block in `styles.css`, `THEME_MODES`/`THEME_COLORS` in `theme.ts`,
a glyph in `ThemePicker.tsx`, and the `THEMES` allowlist in the server's `prefs.ts`.

An inline script in `index.html` applies the cached theme before first paint (no dark flash for
light-theme users) and `applyTheme` mirrors the page background into `<meta name="theme-color">`;
both must stay in step with the theme list.

## Adding torrents

Dropping on the window adds immediately; the **Add torrent** button is the path for choosing a
directory or label, or for magnets and URLs. Because the drop path has no dialog to report into,
`addTorrentFile` has to be trustworthy:

- `load.raw_start` returns 0 for **any** payload — a corrupt file only shows up in rtorrent's log —
  so `torrentfile.ts` parses the bencode first and rejects what is not a torrent, with the reason.
- The same parse yields the info hash, and the load is confirmed by waiting for that hash to appear
  in the session. `load.*` is queued, not immediate, so "the call returned" is not "it loaded".

Failures come back per file in the upload response and are toasted by the UI.

Two things about the drop handling are load-bearing:

- **`dragover` is cancelled unconditionally**, and a window-level listener cancels stray drops as
  well. A drag the handler does not recognise must still be cancelled, because the browser's
  default action for an uncancelled drop is to navigate to the dropped file — which throws the
  whole UI away and looks to the user like the file being rejected.
- **The Add dialog's dropzone stops propagation.** Otherwise a drop inside the dialog both stages
  the file there and adds it immediately via the window handler.

A drop with no file payload falls back to `text/uri-list` / `text/plain`, so magnets and URLs work;
a `file://` URI cannot be read by the browser and says so rather than failing quietly.

## Animations

`Celebrate` (download finished) and `DropBurst` (files dropped) are fire-and-forget: the parent
hands them a trigger and they clean themselves up on a timer. Both take an effect `flavor`
(`fxFlavor` in `theme.ts` maps the resolved theme): `party` is the default, `grim` (black metal)
mourns — ash, embers, a lightning flash, a closing pall, a summoning sigil, an "offering" score —
and `arcade` (retro) plays it 8-bit: stepped pixel rain with a CRT flicker, pixel rings, an
eight-way burst and points on the score. The flavor is latched at launch (ref/memo) so a theme
flip mid-flight cannot restyle or restart a sequence, and every variant keeps the same trigger
contract and reduced-motion skip.

Both keep their `onDone` in a ref and depend only on the trigger id. That is not incidental — the
app re-renders on every poll, so an inline `onDone={() => ...}` in the dependency array tears the
effect down and restarts the sequence one and a half seconds in. The visible symptom is subtle
(the tail of the animation silently never runs), so if you add another timed effect, follow the
same pattern.

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

Two things are easy to get wrong here:

- **Button labels must be wrapped in a `<span>`.** The compact rules hide labels to leave icons;
  a bare text node inside a button cannot be targeted.
- **Do not let anything scroll the page sideways.** `html, body` are capped at `100%` with
  `overflow-x: hidden`; wide content scrolls inside its own container instead. Check new layout
  work at 360px before calling it done.

## Conventions

- Comments explain *why*, especially where the code works around one of the quirks above. Do not
  narrate what the next line does.
- Errors surfaced to the user should name the cause (`HttpError` with a real status; XML-RPC
  faults become 502 with rtorrent's own message, prefixed with the command that failed when it
  came out of a multicall).
- Anything that deletes data must stay inside `config.deleteRoots`.
- The UI polls `/api/state` once per interval rather than issuing many calls; rtorrent is single
  threaded and does not enjoy being hammered (`MAX_CONCURRENCY` in `rtorrent.ts` caps it). The
  poll chains timeouts rather than using an interval, so a slow response never stacks requests,
  and it pauses entirely while the tab is hidden.
- `/healthz` is deliberately outside Basic auth (container healthchecks and orchestrator probes
  must work with `WEB_USER`/`WEB_PASS` set) and reveals nothing but liveness.
- CI (`.github/workflows/ci.yml`) typechecks both halves and smoke-tests the built image on pull
  requests; the 0.9.8/0.15.2 compat matrix runs on manual dispatch. Main pushes skip the smoke
  job because `release.yml` builds and probes those commits on both architectures anyway.
- `release.yml` publishes to GHCR. Every push to main is a release: it tags the commit
  `v0.1.<run_number>` and publishes `cascade:<version>-<rtorrent-version>` (plus the bare
  `<version>` and `latest` for `DEFAULT_RTORRENT`); pushing a `vX.Y.Z` tag publishes under that
  name instead. Builds run per platform on native amd64/arm64 runners, are pushed **by digest**,
  smoke-tested on their own architecture, and only then joined into a tagged manifest — so a
  broken or half-built release never claims a tag. The tag the workflow pushes does not
  re-trigger it (GitHub does not run workflows for refs created with `GITHUB_TOKEN`), which is
  why tagging lives in that workflow rather than a separate one.
