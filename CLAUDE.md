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

To test against a different rtorrent, rebuild with `--build-arg ALPINE_VERSION=3.19|3.21|3.22`
(0.9.8 / 0.10.0 / 0.15.2). **Changes to the backend should be checked against at least the oldest
and newest**, because the command set genuinely differs.

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

7. **rtorrent needs a pty**, so it runs inside a detached `screen` session. `SCREENDIR` must be
   mode 0700 or screen refuses to start.

8. **Some settings are write-only** — `dht.mode` and `protocol.encryption` have `.set` but no
   getter, so the UI cannot show their current value.

9. **Labels live in `d.custom1`**, URL-encoded (the ruTorrent convention), which is why
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

## Conventions

- Comments explain *why*, especially where the code works around one of the quirks above. Do not
  narrate what the next line does.
- Errors surfaced to the user should name the cause (`HttpError` with a real status; XML-RPC
  faults become 502 with rtorrent's own message).
- Anything that deletes data must stay inside `config.deleteRoots`.
- The UI polls `/api/state` once per interval rather than issuing many calls; rtorrent is single
  threaded and does not enjoy being hammered (`MAX_CONCURRENCY` in `rtorrent.ts` caps it).
