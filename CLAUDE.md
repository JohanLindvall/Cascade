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
  service.ts      all application behaviour
  achievements.ts badge definitions, XP and level curve
  api.ts          REST routes + /RPC2 passthrough
  index.ts        express wiring, static SPA, auth, error mapping
web/src/          React UI; components/ + one styles.css of design tokens
docker/entrypoint.sh  renders rtorrent.rc, supervises rtorrent + node
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

10. **Some settings are write-only** — `dht.mode` and `protocol.encryption` have `.set` but no
   getter, so the UI cannot show their current value.

11. **Labels live in `d.custom1`**, URL-encoded (the ruTorrent convention), which is why
   `mapTorrent` decodes and `setLabel` encodes.

## Adding support for a new backend command

Never call a command unconditionally. Add it to `FEATURE_METHODS` in `capabilities.ts`, guard the
call with `capabilities.supports('yourFeature')`, and let the UI grey out the control via the
`supports` map returned by `/api/capabilities`. Field commands in `model.ts` are filtered against
`system.listMethods` automatically — a field the backend lacks simply maps to `0`/`''`.

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

Four modes: `system`, `light`, `dark`, `retro`. `system` resolves through `prefers-color-scheme` in
`theme.ts`, and the resolved value goes on `<html data-theme>`. Themes are pure token overrides in
`styles.css` — components carry no per-theme markup, so a new theme is a block of custom properties
plus, for retro, a set of shape overrides (zero radius, offset shadows, stepped bars). Keep it that
way.

## Adding torrents

Dropping on the window adds immediately; the **Add torrent** button is the path for choosing a
directory or label, or for magnets and URLs. Because the drop path has no dialog to report into,
`addTorrentFile` has to be trustworthy:

- `load.raw_start` returns 0 for **any** payload — a corrupt file only shows up in rtorrent's log —
  so `torrentfile.ts` parses the bencode first and rejects what is not a torrent, with the reason.
- The same parse yields the info hash, and the load is confirmed by waiting for that hash to appear
  in the session. `load.*` is queued, not immediate, so "the call returned" is not "it loaded".

Failures come back per file in the upload response and are toasted by the UI.

## Animations

`Celebrate` (download finished) and `DropBurst` (files dropped) are fire-and-forget: the parent
hands them a trigger and they clean themselves up on a timer.

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
fixed drawer, and detail/modals become full-screen sheets.

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
  faults become 502 with rtorrent's own message).
- Anything that deletes data must stay inside `config.deleteRoots`.
- The UI polls `/api/state` once per interval rather than issuing many calls; rtorrent is single
  threaded and does not enjoy being hammered (`MAX_CONCURRENCY` in `rtorrent.ts` caps it).
