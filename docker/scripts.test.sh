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
# pidof says whether an rtorrent runs (STUB_RUNNING), and sleep returns at
# once, so the wait's 30 seconds pass in no time.
cat > "$entry/bin/pidof" <<'STUB'
#!/bin/sh
[ "${STUB_RUNNING:-0}" = 1 ]
STUB
printf '#!/bin/sh\n' > "$entry/bin/sleep"
chmod +x "$entry/bin/rtorrent" "$entry/bin/cascade" "$entry/bin/pidof" "$entry/bin/sleep"
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
# refused_by <variable> <shell code>: a case the entrypoint must stop, naming
# that variable.
refused_by() {
  if with_entrypoint "$2" >/dev/null 2>"$fixture/stderr"; then
    echo "accepted: $2" >&2
    exit 1
  fi
  if ! grep -q "FATAL: $1 must be" "$fixture/stderr"; then
    cat "$fixture/stderr" >&2
    echo "refused, but not for $1: $2" >&2
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

# rtorrent takes one SCGI listener and stops its rc at a second, so
# RT_SCGI_PORT replaces the unix socket, and the server follows it there: a
# wildcard bind on the loopback, any other address as it is, unless
# CASCADE_SCGI names an endpoint itself. scgi <assignments> prints the
# CASCADE_SCGI the entrypoint exports, and renders rtorrent.rc on the way.
scgi() {
  with_entrypoint "$1
    { apply_defaults; validate_options; pick_port_commands; write_rc; } >/dev/null
    printf '%s\n' \"\$CASCADE_SCGI\"" 2>"$fixture/stderr" ||
    { cat "$fixture/stderr" >&2; echo "failed: $1" >&2; exit 1; }
}
# check_scgi <assignments> <CASCADE_SCGI> <the one SCGI line of rtorrent.rc>
check_scgi() {
  got="$(scgi "$1")"
  [ "$got" = "$2" ] || { echo "$1: CASCADE_SCGI is \"$got\", not \"$2\"" >&2; exit 1; }
  [ "$(grep -c '^network\.scgi\.open' "$rc")" = 1 ] || { echo "$1: not one SCGI listener" >&2; cat "$rc" >&2; exit 1; }
  grep -Fxq -- "$3" "$rc" || { echo "$1: rtorrent.rc lacks: $3" >&2; cat "$rc" >&2; exit 1; }
}
check_scgi : /run/rtorrent/rpc.socket 'network.scgi.open_local = "/run/rtorrent/rpc.socket"'
check_scgi 'RT_SCGI_SOCKET=/srv/rt.sock' /srv/rt.sock 'network.scgi.open_local = "/srv/rt.sock"'
check_scgi 'RT_SCGI_PORT=5000' 127.0.0.1:5000 'network.scgi.open_port = "127.0.0.1:5000"'
check_scgi 'RT_SCGI_PORT=5000 RT_SCGI_BIND=' 127.0.0.1:5000 'network.scgi.open_port = "127.0.0.1:5000"'
check_scgi 'RT_SCGI_PORT=5000 RT_SCGI_BIND=0.0.0.0' 127.0.0.1:5000 'network.scgi.open_port = "0.0.0.0:5000"'
check_scgi 'RT_SCGI_PORT=5000 RT_SCGI_BIND=::' 127.0.0.1:5000 'network.scgi.open_port = "[::]:5000"'
check_scgi 'RT_SCGI_PORT=65535 RT_SCGI_BIND=[::]' 127.0.0.1:65535 'network.scgi.open_port = "[::]:65535"'
check_scgi 'RT_SCGI_PORT=5000 RT_SCGI_BIND=10.0.0.5' 10.0.0.5:5000 'network.scgi.open_port = "10.0.0.5:5000"'
check_scgi 'RT_SCGI_PORT=5000 RT_SCGI_BIND=::1' '[::1]:5000' 'network.scgi.open_port = "[::1]:5000"'
check_scgi 'RT_SCGI_PORT=1 RT_SCGI_BIND=rtorrent.lan' rtorrent.lan:1 'network.scgi.open_port = "rtorrent.lan:1"'
check_scgi 'RT_SCGI_PORT=5000 RT_SCGI_BIND=0.0.0.0 CASCADE_SCGI=rt.internal:6000' rt.internal:6000 \
  'network.scgi.open_port = "0.0.0.0:5000"'
check_scgi 'CASCADE_SCGI=unix:/elsewhere.sock' unix:/elsewhere.sock 'network.scgi.open_local = "/run/rtorrent/rpc.socket"'
# A supplied rc is not read for its listener: it has to open the one these
# describe, which the wait and the server follow all the same, so they are
# checked with it too, unlike what only a generated rc carries.
got="$(scgi "RT_CONFIG_FILE=\"$mine\" RT_CONFIG_KEEP=1 RT_SCGI_PORT=5000 RT_SCGI_BIND=0.0.0.0")"
[ "$got" = 127.0.0.1:5000 ] || { echo "a kept rc with RT_SCGI_PORT: CASCADE_SCGI is \"$got\"" >&2; exit 1; }
[ "$(cat "$mine")" = '# my own rtorrent.rc' ] || { echo 'RT_SCGI_PORT rewrote a kept rc' >&2; exit 1; }
refused_by RT_SCGI_PORT "RT_CONFIG_FILE=\"$mine\" RT_CONFIG_KEEP=1 RT_SCGI_PORT=x; apply_defaults; validate_options"

# A port is decimal and from 1 to 65535: rtorrent reads it as C does, so
# 05000 would be port 2560 to it and 0x1388 port 5000, against the server's
# reading. A bind address is an address or a name — not one with its port,
# not a wildcard rtorrent cannot resolve, not an IPv4 spelling the two read
# apart — and both are checked only once RT_SCGI_PORT asks for a port.
for good in 1 5000 65535; do
  expect_ok "RT_SCGI_PORT=$good" "RT_SCGI_PORT=$good; apply_defaults; validate_options"
done
for bad in x 0 65536 99999 05000 0x1388 -1 5000x ' 5000' "5000${nl}execute=x"; do
  refused_by RT_SCGI_PORT "RT_SCGI_PORT='$bad'; apply_defaults; validate_options"
done
for good in 0.0.0.0 127.0.0.1 255.255.255.255 :: '[::]' ::1 '[::1]' 'fe80::1%eth0' ::ffff:10.0.0.1 localhost \
            rtorrent.lan my_host; do
  expect_ok "RT_SCGI_BIND=$good" "RT_SCGI_PORT=5000 RT_SCGI_BIND='$good'; apply_defaults; validate_options"
done
for bad in 0.0.0.0:5000 '[::]:5000' localhost:5000 '*' 'local host' 256.0.0.1 127.1 0 01.2.3.4 '[]' \
           '[localhost]' '::1]' 'a;b' "::${nl}execute=x"; do
  refused_by RT_SCGI_BIND "RT_SCGI_PORT=5000 RT_SCGI_BIND='$bad'; apply_defaults; validate_options"
done
expect_ok 'RT_SCGI_BIND without RT_SCGI_PORT' "RT_SCGI_BIND='not used'; apply_defaults; validate_options"

# The wait wants a running rtorrent and, for a port, a listener on it in the
# kernel's tables, IPv4 or IPv6. What a restart finds there must not pass for
# one: the last rtorrent's connections on 5000 (1388) in TIME_WAIT, and the
# server's to it, beside the web server listening on 8080 (1F90).
net="$entry/net"
mkdir -p "$net"
header='  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
stale='   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 101 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1388 0100007F:C350 06 00000000:00000000 03:000016A8 00000000     0        0 0 3 0000000000000000
   2: 0100007F:C351 0100007F:1388 01 00000000:00000000 00:00000000 00000000  1000        0 102 1 0000000000000000 20 4 30 10 -1'
listen4='   3: 00000000:1388 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 103 1 0000000000000000 100 0 0 10 0'
listen6='   0: 00000000000000000000000000000000:1388 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 104 1 0000000000000000 100 0 0 10 0'
echo 'the last line of the log' > "$entry/rtorrent.log"
# wait_case <up|down> <tcp entries> <tcp6 entries> <shell code>
wait_case() {
  printf '%s\n%s\n' "$header" "$2" > "$net/tcp"
  printf '%s\n%s\n' "$header" "$3" > "$net/tcp6"
  if with_entrypoint "PROC_NET='$net' RT_LOG_FILE='$entry/rtorrent.log'; $4; apply_defaults; wait_for_socket" \
       >"$fixture/out" 2>&1; then
    came=up
  else
    came=down
  fi
  [ "$came" = "$1" ] || { cat "$fixture/out" >&2; echo "the wait came $came, not $1: $4" >&2; exit 1; }
}
wait_case up "$stale$nl$listen4" '' 'export STUB_RUNNING=1; RT_SCGI_PORT=5000'
wait_case up "$stale" "$listen6" 'export STUB_RUNNING=1; RT_SCGI_PORT=5000 RT_SCGI_BIND=::'
wait_case down "$stale" '' 'export STUB_RUNNING=1; RT_SCGI_PORT=5000 RT_SCGI_BIND=0.0.0.0'
for said in 'rtorrent did not listen on 0.0.0.0:5000 within 30s' 'the last line of the log'; do
  grep -Fq "$said" "$fixture/out" || { cat "$fixture/out" >&2; echo "a failed wait did not say: $said" >&2; exit 1; }
done
# Nor does anything count without a running rtorrent: one that stopped at a
# later rc line leaves its socket file behind, which is how the rc with two
# listeners passed for a start. The socket is waited for, and named, by path.
wait_case down "$listen4" '' 'export STUB_RUNNING=0; RT_SCGI_PORT=5000'
wait_case down '' '' "export STUB_RUNNING=1; RT_SCGI_SOCKET='$entry/no.socket'"
grep -Fq "did not listen on $entry/no.socket" "$fixture/out" || { cat "$fixture/out" >&2; echo 'the wait named no socket' >&2; exit 1; }

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
