#!/bin/sh
# Cascade container entrypoint: render rtorrent's config from the environment,
# supervise rtorrent and the web server, and forward shutdown signals.
set -eu

log() { printf '[cascade] %s\n' "$*"; }
die() { printf '[cascade] FATAL: %s\n' "$*" >&2; exit 1; }

# `docker run --rm cascade --help` lists every option. Answered first, before
# any user, directory or rtorrent setup, so it works in any environment. The
# text is rendered from the option catalog in the server (src/options.ts).
case "${1:-}" in
  -h | --help | help)
    exec node /app/server/index.js --help
    ;;
esac

# --------------------------------------------------------------------------
# defaults
# --------------------------------------------------------------------------

: "${PUID:=1000}"
: "${PGID:=1000}"
: "${TZ:=UTC}"

: "${RT_DOWNLOAD_DIR:=/downloads}"
: "${RT_SESSION_DIR:=/config/session}"
: "${RT_WATCH_DIR:=/watch}"
: "${RT_LOG_FILE:=/config/rtorrent.log}"
: "${RT_LOG_LEVEL:=info}"
: "${RT_PORT_RANGE:=50000-50000}"
: "${RT_PORT_RANDOM:=no}"
: "${RT_UMASK:=0022}"
: "${RT_SCGI_SOCKET:=/run/rtorrent/rpc.socket}"
: "${RT_WATCH_INTERVAL:=10}"
: "${RT_XMLRPC_SIZE_LIMIT:=16777216}"

: "${WEB_PORT:=8080}"
: "${CASCADE_STATE_FILE:=/config/cascade-state.json}"

BOOT_SETTINGS="${CASCADE_BOOT_SETTINGS:-/run/cascade/boot-settings.json}"
RC_FILE="${RT_CONFIG_FILE:-/config/rtorrent.rc}"
RUN_USER=rtorrent

export TZ RT_LOG_FILE RT_LOG_LEVEL CASCADE_STATE_FILE CASCADE_BOOT_SETTINGS="$BOOT_SETTINGS"
export CASCADE_SCGI="${CASCADE_SCGI:-$RT_SCGI_SOCKET}"

rtorrent -h >/dev/null 2>&1 || die "the rtorrent binary will not run: $(rtorrent -h 2>&1 | head -n2)"
RT_VERSION="$(rtorrent -h 2>&1 | sed -n 's/.*version \([0-9][0-9.]*[0-9]\).*/\1/p' | head -n1)"
[ -n "$RT_VERSION" ] || RT_VERSION="unknown"

# --------------------------------------------------------------------------
# user + directories
# --------------------------------------------------------------------------

if [ "$(id -u)" = "0" ]; then
  if ! getent group "$PGID" >/dev/null 2>&1; then
    addgroup -g "$PGID" "$RUN_USER" 2>/dev/null || true
  fi
  GROUP_NAME="$(getent group "$PGID" | cut -d: -f1)"
  : "${GROUP_NAME:=$RUN_USER}"
  if ! getent passwd "$PUID" >/dev/null 2>&1; then
    adduser -D -H -u "$PUID" -G "$GROUP_NAME" "$RUN_USER" 2>/dev/null || true
  fi
  USER_NAME="$(getent passwd "$PUID" | cut -d: -f1)"
  : "${USER_NAME:=$RUN_USER}"
else
  USER_NAME="$(id -un)"
  GROUP_NAME="$(id -gn)"
  PUID="$(id -u)"
  PGID="$(id -g)"
fi

SCGI_DIR="$(dirname "$RT_SCGI_SOCKET")"
SCREEN_DIR="$SCGI_DIR/screen"
export SCREENDIR="$SCREEN_DIR"
for dir in "$RT_DOWNLOAD_DIR" "$RT_SESSION_DIR" "$RT_WATCH_DIR" "$SCGI_DIR" "$SCREEN_DIR" \
           "$(dirname "$RC_FILE")" "$(dirname "$RT_LOG_FILE")" \
           "$(dirname "$BOOT_SETTINGS")" "$(dirname "$CASCADE_STATE_FILE")" \
           ${RT_COMPLETED_DIR:+"$RT_COMPLETED_DIR"}; do
  mkdir -p "$dir"
done

# screen refuses to use a socket directory that is not 0700 and owned by the user.
chmod 0700 "$SCREEN_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R "$PUID:$PGID" "$RT_SESSION_DIR" "$SCGI_DIR" "$(dirname "$BOOT_SETTINGS")" 2>/dev/null || true
  chown "$PUID:$PGID" "$RT_DOWNLOAD_DIR" "$RT_WATCH_DIR" "$(dirname "$RC_FILE")" \
    "$(dirname "$RT_LOG_FILE")" "$(dirname "$CASCADE_STATE_FILE")" 2>/dev/null || true
  for file in "$RT_LOG_FILE" "$CASCADE_STATE_FILE"; do
    [ ! -e "$file" ] || chown "$PUID:$PGID" "$file"
  done
  [ -n "${RT_COMPLETED_DIR:-}" ] && chown "$PUID:$PGID" "$RT_COMPLETED_DIR" 2>/dev/null || true
  if [ "${CASCADE_CHOWN_DOWNLOADS:-0}" = "1" ]; then
    log "taking ownership of $RT_DOWNLOAD_DIR (this can take a while)"
    chown -R "$PUID:$PGID" "$RT_DOWNLOAD_DIR" 2>/dev/null || true
  fi
fi

# --------------------------------------------------------------------------
# stale session lock
#
# rtorrent locks its session directory and only releases the lock on a clean
# shutdown. A killed container (docker rm -f, OOM, host reboot) leaves the file
# behind and every later start fails with "Could not lock session directory",
# which surfaces as an unexplained connection error in the UI.
#
# The lock records "<hostname>:+<pid>". If that is this container and the
# process is alive the lock is real and we must not touch it; anything else is
# a leftover and is cleared.
# --------------------------------------------------------------------------

clear_session_lock() {
  SESSION_LOCK="$RT_SESSION_DIR/rtorrent.lock"
  [ -f "$SESSION_LOCK" ] || return 0
  lock_holder="$(cat "$SESSION_LOCK" 2>/dev/null || true)"
  lock_host="${lock_holder%%:*}"
  lock_pid="${lock_holder##*+}"
  if [ "${RT_SESSION_LOCK_KEEP:-0}" = "1" ]; then
    log "keeping session lock held by ${lock_holder:-unknown} (RT_SESSION_LOCK_KEEP=1)"
  elif [ "$lock_host" = "$(hostname)" ] && [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    die "session $RT_SESSION_DIR is locked by a running rtorrent (pid $lock_pid)"
  else
    log "clearing stale session lock left by ${lock_holder:-unknown}"
    rm -f "$SESSION_LOCK"
  fi
}

# --------------------------------------------------------------------------
# rtorrent.rc
#
# Only commands that exist in every supported rtorrent (0.9.x to 0.16.x) go in
# here — rtorrent aborts on an unknown command in its config file. Everything
# version-dependent is applied afterwards over XML-RPC by the web server, which
# probes the command table first and skips what this build does not have.
# --------------------------------------------------------------------------

quote() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

# Log scopes the UI raised in an earlier run, read out of the state file the
# server owns. Anything unreadable — no file yet, corrupt JSON, no node —
# yields nothing rather than failing the start, and the names are filtered to
# the shape a scope has so a hand-edited file cannot inject rc lines.
stored_log_scopes() {
  [ -f "$CASCADE_STATE_FILE" ] || return 0
  node -e '
    try {
      const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const scopes = Array.isArray(data.logScopes) ? data.logScopes : [];
      console.log(scopes.filter((s) => /^[a-z][a-z_]{1,30}$/.test(s)).join(" "));
    } catch { /* nothing to add */ }
  ' "$CASCADE_STATE_FILE" 2>/dev/null || true
}

# Ask this rtorrent whether it knows a command, by feeding it a one-line option
# file. Used for the few settings that must be in rtorrent.rc — the listening
# port has to be right before rtorrent binds, and 0.16 renamed the commands
# from network.port_range to network.listen.port.range.
rc_command_exists() {
  probe_rc="$(mktemp)"
  printf '%s\n' "$1" > "$probe_rc"
  probe_out="$(TERM=unknown timeout 20 rtorrent -n -o import="$probe_rc" 2>&1 || true)"
  rm -f "$probe_rc"
  case "$probe_out" in
    *"does not exist"*|*"Error in option file"*) return 1 ;;
    *) return 0 ;;
  esac
}

if rc_command_exists "network.listen.port.range.set = $RT_PORT_RANGE"; then
  PORT_RANGE_CMD="network.listen.port.range.set"
  PORT_RANDOM_CMD="network.listen.port.random.set"
else
  PORT_RANGE_CMD="network.port_range.set"
  PORT_RANDOM_CMD="network.port_random.set"
fi
log "listen port commands: $PORT_RANGE_CMD / $PORT_RANDOM_CMD"

# Log groups also changed between releases. A scope saved by another version
# must not abort startup before the server can report that it is unsupported.
filter_log_scopes() {
  for scope in "$@"; do
    case "$scope" in
      ''|*[!a-z_]*) log "ignoring invalid log scope: $scope" >&2; continue ;;
    esac
    if rc_command_exists "log.open_file = \"cascade\", \"/dev/null\"
log.add_output = \"$scope\", \"cascade\""; then
      printf '%s ' "$scope"
    else
      log "rtorrent $RT_VERSION does not support log scope: $scope" >&2
    fi
  done
}

if [ -n "${RT_CONFIG_FILE:-}" ] && [ -f "$RT_CONFIG_FILE" ] && [ "${RT_CONFIG_KEEP:-1}" = "1" ]; then
  log "using the supplied rtorrent config at $RT_CONFIG_FILE verbatim"
else
  log "generating $RC_FILE for rtorrent $RT_VERSION"
  RT_LOG_LEVEL="$(filter_log_scopes $(printf '%s' "$RT_LOG_LEVEL" | tr ',' ' '))"
  EXTRA_LOG_SCOPES="$(filter_log_scopes $(stored_log_scopes))"
  {
    echo "# Generated by the Cascade entrypoint on container start."
    echo "# Edits are overwritten; mount your own file and set RT_CONFIG_FILE to keep it."
    echo
    echo "system.umask.set = $RT_UMASK"
    echo "directory.default.set = $(quote "$RT_DOWNLOAD_DIR")"
    echo "session.path.set = $(quote "$RT_SESSION_DIR")"
    echo
    echo "$PORT_RANGE_CMD = $RT_PORT_RANGE"
    echo "$PORT_RANDOM_CMD = $RT_PORT_RANDOM"
    echo
    echo "# XML-RPC over SCGI — this is what the web UI and any external client talk to."
    echo "network.scgi.open_local = $(quote "$RT_SCGI_SOCKET")"
    if [ -n "${RT_SCGI_PORT:-}" ]; then
      echo "network.scgi.open_port = $(quote "${RT_SCGI_BIND:-127.0.0.1}:${RT_SCGI_PORT}")"
    fi
    echo
    echo "log.open_file = \"cascade\", $(quote "$RT_LOG_FILE")"
    # RT_LOG_LEVEL's scopes, plus the ones raised from the log dialog and
    # remembered in the state file. The server re-attaches those on connect
    # anyway, but only once it has connected — writing them here as well is
    # what covers rtorrent's own startup: the session load, the first
    # announces, anything that goes wrong before the web server is up.
    # Attaching a scope twice is a no-op in rtorrent (measured), so the two
    # paths cannot double a line.
    for scope in $RT_LOG_LEVEL $EXTRA_LOG_SCOPES; do
      echo "log.add_output = \"$scope\", \"cascade\""
    done
    echo
    if [ -d "$RT_WATCH_DIR" ] && [ "${RT_WATCH_ENABLE:-1}" = "1" ]; then
      echo "# Auto-load anything dropped into the watch directory."
      # The string form of 'schedule' works on every release; 'schedule2' was
      # dropped in 0.16.
      echo "schedule = watch_directory, $RT_WATCH_INTERVAL, $RT_WATCH_INTERVAL, $(quote "load.start=$(quote "$RT_WATCH_DIR/*.torrent")")"
      echo
    fi
    if [ -n "${RT_COMPLETED_DIR:-}" ]; then
      echo "# Move data to RT_COMPLETED_DIR once a download finishes."
      # d.name is metadata; d.base_path includes libtorrent's filename fitting.
      echo "method.insert = d.data_path, simple, \"d.base_path=\""
      # Close before moving so frozen paths refresh when reopened. Check for
      # collisions first, and change the directory only after the move succeeds.
      echo "method.insert = d.move_to_complete, simple, \"execute=/usr/local/bin/cascade-move,check,\$argument.0=,\$argument.1= ; d.stop= ; d.close= ; execute=/usr/local/bin/cascade-move,move,\$argument.0=,\$argument.1= ; d.directory.set=\$argument.1= ; d.open= ; d.start= ; d.save_full_session=\""
      echo "method.set_key = event.download.finished, move_complete, $(quote "d.move_to_complete=\$d.data_path=, $(quote "$RT_COMPLETED_DIR")")"
      echo
    fi
    if [ -n "${RT_EXTRA_CONFIG:-}" ]; then
      echo "# RT_EXTRA_CONFIG"
      printf '%s\n' "$RT_EXTRA_CONFIG"
      echo
    fi
    if [ -n "${RT_EXTRA_CONFIG_FILE:-}" ] && [ -f "$RT_EXTRA_CONFIG_FILE" ]; then
      echo "# $RT_EXTRA_CONFIG_FILE"
      cat "$RT_EXTRA_CONFIG_FILE"
    fi
  } > "$RC_FILE"
  [ "$(id -u)" = "0" ] && chown "$PUID:$PGID" "$RC_FILE" || true
fi

# --------------------------------------------------------------------------
# startup settings handed to the web server
# --------------------------------------------------------------------------

# The catalog maps environment options to settings; JSON encoding and input
# validation run once in Node so quoted paths cannot corrupt the whole file.
node /app/server/bootSettings.js > "$BOOT_SETTINGS"
[ "$(id -u)" = "0" ] && chown "$PUID:$PGID" "$BOOT_SETTINGS" || true

# --------------------------------------------------------------------------
# supervision
# --------------------------------------------------------------------------

as_user() {
  if [ "$(id -u)" = "0" ]; then
    su-exec "$PUID:$PGID" "$@"
  else
    "$@"
  fi
}

NODE_PID=""
STOPPING=0

start_rtorrent() {
  # The supervisor can restart a killed process in the same container too.
  clear_session_lock
  rm -f "$RT_SCGI_SOCKET"
  # rtorrent is a curses application: it needs a pty even when nothing is
  # attached, so it runs inside a detached screen session. That also means
  # `docker exec -it <container> screen -r rtorrent` gives you the real UI.
  as_user env TERM="${TERM:-screen}" HOME=/config SCREENDIR="$SCREEN_DIR" \
    screen -dmS rtorrent rtorrent -n -o import="$RC_FILE"
}

# Wait up to $1 seconds for rtorrent to exit; false if it is still running.
# WAITED says how long it took.
wait_rtorrent() {
  WAITED=0
  while pidof rtorrent >/dev/null 2>&1; do
    [ "$WAITED" -lt "$1" ] || return 1
    sleep 1
    WAITED=$((WAITED + 1))
  done
}

# SIGINT is rtorrent's clean shutdown: it announces "stopped" to every
# tracker, drops the requests still unanswered after about ten seconds, then
# saves the session and releases its lock — 12s to 21s, measured, with 100
# torrents behind a tracker that never answers. It used to get 10s, then
# SIGTERM and this script's exit, and the exit is what did the damage: the
# container goes with it and the kernel kills whatever is left, so rtorrent
# died mid-shutdown on every stop — lock left behind, no "stopped" sent, a
# stale peer in every tracker's table. Hence 30s for SIGINT, then SIGTERM (its
# quick shutdown, which skips the trackers) and 10s more for that. Docker's
# stop timeout must outlast both — run the container with --stop-timeout 60.
stop_all() {
  STOPPING=1
  log "shutting down"
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null || true
  if pidof rtorrent >/dev/null 2>&1; then
    kill -INT "$(pidof rtorrent)" 2>/dev/null || true
    if wait_rtorrent 30; then
      log "rtorrent stopped cleanly after ${WAITED}s"
    else
      log "rtorrent is still shutting down after 30s — asking it to hurry"
      kill -TERM "$(pidof rtorrent)" 2>/dev/null || true
      wait_rtorrent 10 || log "rtorrent did not stop; the next start clears its session lock"
    fi
  fi
  [ -z "$NODE_PID" ] || wait "$NODE_PID" 2>/dev/null || true
  exit "${1:-0}"
}

trap stop_all TERM INT

log "rtorrent $RT_VERSION | uid=$PUID gid=$PGID | scgi=$RT_SCGI_SOCKET"
start_rtorrent

waited=0
while [ ! -S "$RT_SCGI_SOCKET" ]; do
  waited=$((waited + 1))
  if [ "$waited" -gt 30 ]; then
    log "rtorrent did not create $RT_SCGI_SOCKET within 30s — recent log:"
    [ -f "$RT_LOG_FILE" ] && tail -n 30 "$RT_LOG_FILE" >&2
    die "rtorrent failed to start (check the config at $RC_FILE)"
  fi
  sleep 1
done
log "rtorrent is up"

if [ $# -gt 0 ]; then
  exec "$@"
fi

if [ "$(id -u)" = "0" ]; then
  su-exec "$PUID:$PGID" node /app/server/index.js &
else
  node /app/server/index.js &
fi
NODE_PID=$!

while [ "$STOPPING" = "0" ]; do
  sleep 5 &
  wait $! 2>/dev/null || true
  [ "$STOPPING" = "1" ] && break

  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    log "web server exited — stopping container"
    # Preserve failure for Docker's on-failure restart policy.
    stop_all 1
  fi
  if ! pidof rtorrent >/dev/null 2>&1; then
    log "rtorrent died, restarting it"
    start_rtorrent
  fi
done
