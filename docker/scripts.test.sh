#!/bin/sh
# SPDX-License-Identifier: MIT
# Pure shell regressions; network calls are replaced with a tiny git stub.
# shellcheck disable=SC2016 # single-quoted snippets are code, expanded where they run
set -eu
root="$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT HUP INT TERM
mkdir -p "$fixture/repo/docker" "$fixture/bin" "$fixture/source/src"
cp "$root/docker/bump-rtorrent.sh" "$fixture/repo/docker/"
cat > "$fixture/bin/git" <<'EOF'
#!/bin/sh
[ "${FAIL_GIT:-0}" = 0 ] || exit 9
printf 'deadbeef refs/tags/v0.16.24\ndeadbeef refs/tags/v0.16.25\n'
EOF
chmod +x "$fixture/bin/git"
export PATH="$fixture/bin:$PATH"
printf 'ARG RTORRENT_VERSION=0.16.24\n' > "$fixture/repo/Dockerfile"
printf '**rtorrent 0.16.24, compiled from source**\nThe default is **0.16.24**\n' > "$fixture/repo/README.md"
if FAIL_GIT=1 sh "$fixture/repo/docker/bump-rtorrent.sh" >/dev/null 2>&1; then
  echo 'failed git discovery was swallowed' >&2; exit 1
fi
grep -Fq 'ARG RTORRENT_VERSION=0.16.24' "$fixture/repo/Dockerfile"
sh "$fixture/repo/docker/bump-rtorrent.sh" > "$fixture/version"
[ "$(cat "$fixture/version")" = '0.16.25' ]
grep -Fq 'The default is **0.16.25**' "$fixture/repo/README.md"
# A documentation mismatch must leave the Dockerfile untouched.
printf 'ARG RTORRENT_VERSION=0.16.24\n' > "$fixture/repo/Dockerfile"
if sh "$fixture/repo/docker/bump-rtorrent.sh" >/dev/null 2>&1; then
  echo 'documentation drift was accepted' >&2; exit 1
fi
grep -Fq 'ARG RTORRENT_VERSION=0.16.24' "$fixture/repo/Dockerfile"
# Valid C++ string characters also have to survive sed's replacement grammar.
printf 'set_user_agent(USER_AGENT);\n' > "$fixture/source/src/main.cc"
(cd "$fixture/source" && USER_AGENT='Example/1.0 (a&b|c)' sh "$root/docker/patches/apply-rtorrent.sh")
grep -Fq 'set_user_agent(std::string("Example/1.0 (a&b|c)"));' "$fixture/source/src/main.cc"
# Completion moves must work on BusyBox, preserve data at collisions, and
# tolerate a repeated completion of an already-moved torrent.
mkdir -p "$fixture/downloads/album name" "$fixture/completed"
printf 'payload' > "$fixture/downloads/album name/track.txt"
sh "$root/docker/move-completed.sh" check "$fixture/downloads/album name" "$fixture/completed"
sh "$root/docker/move-completed.sh" move "$fixture/downloads/album name" "$fixture/completed"
[ "$(cat "$fixture/completed/album name/track.txt")" = payload ]
sh "$root/docker/move-completed.sh" move "$fixture/completed/album name" "$fixture/completed"
printf 'original' > "$fixture/completed/file.txt"
printf 'new' > "$fixture/downloads/file.txt"
if sh "$root/docker/move-completed.sh" move "$fixture/downloads/file.txt" "$fixture/completed" >/dev/null 2>&1; then
  echo 'completion collision was accepted' >&2; exit 1
fi
[ "$(cat "$fixture/completed/file.txt")" = original ]
[ "$(cat "$fixture/downloads/file.txt")" = new ]
# The entrypoint, sourced as a library: stub rtorrent and cascade commands
# script which rc commands a probe finds and which log scopes the state file
# holds, and each case runs in a shell of its own.
entry="$fixture/entry"
mkdir -p "$entry/bin" "$entry/watch" "$entry/session"
cat > "$entry/bin/rtorrent" <<'STUB'
#!/bin/sh
# A probe passes import=<file>; answer as rtorrent does for a name it lacks.
for arg; do
  case "$arg" in
    import=*)
      for missing in ${STUB_MISSING:-}; do
        if grep -q -- "$missing" "${arg#import=}"; then
          echo "Command \"$missing\" does not exist."
          exit 1
        fi
      done
      ;;
  esac
done
STUB
cat > "$entry/bin/cascade" <<'STUB'
#!/bin/sh
[ "$1" = log-scopes ] && echo "${STUB_SCOPES:-}"
STUB
chmod +x "$entry/bin/rtorrent" "$entry/bin/cascade"
echo '{}' > "$entry/state.json"
# with_entrypoint <shell code>: run it with the functions loaded. A shell of
# its own rather than a subshell: under `if`, a subshell runs with set -e
# suspended, and a step that failed would not end the case.
with_entrypoint() {
  env PATH="$entry/bin:$PATH" ENTRYPOINT_LIBRARY=1 RT_VERSION=test \
    RT_SESSION_DIR="$entry/session" RT_WATCH_DIR="$entry/watch" \
    CASCADE_STATE_FILE="$entry/state.json" RT_CONFIG_FILE="$entry/rtorrent.rc" RT_CONFIG_KEEP=0 \
    sh -c '. "$1"; eval "$2"' with_entrypoint "$root/docker/entrypoint.sh" "$1"
}
# expect_ok <what> <shell code>: a case that must pass. Its stderr is shown
# only when it fails: a passing case prints the warnings it provokes on
# purpose, and a failing one has to say what went wrong.
expect_ok() {
  if ! with_entrypoint "$2" >/dev/null 2>"$fixture/stderr"; then
    cat "$fixture/stderr" >&2
    echo "failed: $1" >&2
    exit 1
  fi
}
# expect_refused <what> <shell code>: a case the entrypoint must stop.
expect_refused() {
  if with_entrypoint "$2" >/dev/null 2>&1; then
    echo "accepted: $1" >&2
    exit 1
  fi
}

# A 0.9-era build (no network.listen.*), quoting, scopes from both sources,
# the watch directory and the completion move.
expect_ok 'generating rtorrent.rc' '
  RT_DOWNLOAD_DIR="/data/\"quoted\" \\back"
  RT_COMPLETED_DIR=/done
  RT_LOG_LEVEL="info,Bad Scope,tracker_debug"
  STUB_MISSING="network.listen.port.range.set tracker_debug"
  STUB_SCOPES="debug evil;line tracker_events"
  export STUB_MISSING STUB_SCOPES
  apply_defaults
  pick_port_commands
  write_rc
  [ "$RT_LOG_LEVEL" = "info " ] || { echo "RT_LOG_LEVEL left as \"$RT_LOG_LEVEL\"" >&2; exit 1; }
'
rc="$entry/rtorrent.rc"
for line in \
  'system.umask.set = 0022' \
  'network.port_range.set = 50000-50000' \
  'network.port_random.set = no' \
  'directory.default.set = "/data/\"quoted\" \\back"' \
  'log.add_output = "info", "cascade"' \
  'log.add_output = "debug", "cascade"' \
  'log.add_output = "tracker_events", "cascade"' \
  "schedule = watch_directory, 10, 10, \"load.start=\\\"$entry/watch/*.torrent\\\"\"" \
  'method.set_key = event.download.finished, move_complete, "d.move_to_complete=$d.data_path=, \"/done\""'; do
  grep -Fxq -- "$line" "$rc" || { echo "rtorrent.rc lacks: $line" >&2; cat "$rc" >&2; exit 1; }
done
if grep -Eq 'tracker_debug|Bad|evil' "$rc"; then
  echo 'a scope rtorrent refused, or an invalid one, reached rtorrent.rc' >&2; exit 1
fi

# Values that go into the rc verbatim must be well formed, on one line —
# but whatever rtorrent itself parses must still pass (0.9.8 and 0.16.24
# take all of these), and a boolean is spelled as the server spells one.
expect_ok 'the defaults' 'apply_defaults; validate_options'
for good in RT_PORT_RANDOM=Yes RT_PORT_RANDOM=TRUE RT_PORT_RANDOM=off RT_UMASK=22 RT_UMASK=0 \
            RT_WATCH_INTERVAL=00:00:10 RT_WATCH_INTERVAL=00:10 RT_CONFIG_KEEP=No RT_WATCH_ENABLE=on \
            RT_SESSION_LOCK_KEEP=False CASCADE_CHOWN_DOWNLOADS=yes; do
  expect_ok "$good" "export \"$good\"; apply_defaults; validate_options"
done
nl='
'
for bad in RT_PORT_RANGE=50000:50000 "RT_PORT_RANGE=1-2${nl}execute=x" RT_PORT_RANDOM=maybe RT_UMASK=abc \
           RT_UMASK=8 RT_WATCH_INTERVAL=soon RT_WATCH_INTERVAL=10s RT_SCGI_PORT=x RT_CONFIG_KEEP=ture \
           RT_WATCH_ENABLE=ture RT_SESSION_LOCK_KEEP=ture CASCADE_CHOWN_DOWNLOADS=ture; do
  expect_refused "$bad" "export \"$bad\"; apply_defaults; validate_options"
done
# A supplied rc that is kept never reads the rc values, so a leftover one
# cannot stop the start; the port range still feeds the probe, and is checked.
mine="$entry/mine.rc"
echo '# my own rtorrent.rc' > "$mine"
expect_ok 'unused rc values with a kept rc' "
  RT_CONFIG_FILE=\"$mine\" RT_CONFIG_KEEP=1 RT_UMASK=abc RT_WATCH_INTERVAL=soon RT_PORT_RANDOM=maybe
  apply_defaults; validate_options"
expect_refused 'a bad port range with a kept rc' "
  RT_CONFIG_FILE=\"$mine\" RT_CONFIG_KEEP=1 RT_PORT_RANGE=x; apply_defaults; validate_options"

# RT_CONFIG_KEEP=true keeps the owner's rc; comparing with "1" used to
# overwrite it with a generated one.
expect_ok 'RT_CONFIG_KEEP=true' "
  RT_CONFIG_FILE=\"$mine\" RT_CONFIG_KEEP=true; apply_defaults; validate_options; pick_port_commands; write_rc"
[ "$(cat "$mine")" = '# my own rtorrent.rc' ] || { echo 'RT_CONFIG_KEEP=true overwrote the supplied rc' >&2; exit 1; }

# What a spelling rtorrent reads differently from the server means in the rc:
# on/off become yes/no, which rtorrent takes, and a umask is octal however it
# is written — rtorrent reads a bare 22 as decimal.
expect_ok 'rc spellings' 'RT_PORT_RANDOM=On RT_UMASK=22 RT_WATCH_ENABLE=off; apply_defaults; pick_port_commands; write_rc'
for line in 'network.listen.port.random.set = yes' 'system.umask.set = 022'; do
  grep -Fxq -- "$line" "$rc" || { echo "rtorrent.rc lacks: $line" >&2; cat "$rc" >&2; exit 1; }
done
if grep -q watch_directory "$rc"; then
  echo 'RT_WATCH_ENABLE=off still wrote the watch directory' >&2; exit 1
fi
expect_ok 'RT_WATCH_ENABLE=Yes' 'RT_WATCH_ENABLE=Yes; apply_defaults; pick_port_commands; write_rc'
grep -q watch_directory "$rc" || { echo 'RT_WATCH_ENABLE=Yes wrote no watch directory' >&2; exit 1; }

# The torrent-name switches must be in force before rtorrent loads its
# session, so they go into the rc when set — as 1/0 — and only where this
# build has the command; unset, rtorrent keeps its own default.
if grep -q '_name\.' "$rc"; then
  echo 'an unset torrent-name switch reached rtorrent.rc' >&2; cat "$rc" >&2; exit 1
fi
expect_ok 'the torrent-name switches' '
  RT_USE_SANITIZED_NAME=No RT_ALLOW_LEGACY_UTF8=on; apply_defaults; validate_options; pick_port_commands; write_rc'
for line in 'system.torrent_name.use_sanitized.set = 0' 'system.file_name.allow_legacy_utf8.set = 1'; do
  grep -Fxq -- "$line" "$rc" || { echo "rtorrent.rc lacks: $line" >&2; cat "$rc" >&2; exit 1; }
done
expect_ok 'a torrent-name switch this build lacks' '
  STUB_MISSING=system.file_name.allow_legacy_utf8.set; export STUB_MISSING
  RT_USE_SANITIZED_NAME=yes RT_ALLOW_LEGACY_UTF8=off; apply_defaults; pick_port_commands; write_rc'
grep -Fxq 'system.torrent_name.use_sanitized.set = 1' "$rc" || { echo 'use_sanitized was not written' >&2; exit 1; }
if grep -q allow_legacy_utf8 "$rc"; then
  echo 'a command this build lacks reached rtorrent.rc' >&2; exit 1
fi
for bad in RT_USE_SANITIZED_NAME=maybe RT_ALLOW_LEGACY_UTF8=2; do
  expect_refused "$bad" "export \"$bad\"; apply_defaults; validate_options"
done

# A lock held by another host (or a dead process) is cleared; one held by a
# live process here is not, and RT_SESSION_LOCK_KEEP keeps any.
lock="$entry/session/rtorrent.lock"
echo 'elsewhere:+1' > "$lock"
with_entrypoint 'apply_defaults; clear_session_lock' >/dev/null
[ ! -e "$lock" ] || { echo 'a stale lock was kept' >&2; exit 1; }
echo "$(hostname):+$$" > "$lock"
if with_entrypoint 'apply_defaults; clear_session_lock' >/dev/null 2>&1; then
  echo 'a live lock was cleared' >&2; exit 1
fi
[ -e "$lock" ] || { echo 'a live lock was removed' >&2; exit 1; }
for keep in 1 true; do
  echo 'elsewhere:+1' > "$lock"
  with_entrypoint "RT_SESSION_LOCK_KEEP=$keep; apply_defaults; clear_session_lock" >/dev/null
  [ -e "$lock" ] || { echo "RT_SESSION_LOCK_KEEP=$keep did not keep the lock" >&2; exit 1; }
done

echo 'container script tests passed'
