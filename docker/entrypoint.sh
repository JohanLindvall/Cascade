#!/bin/sh
# Cascade container entrypoint: render rtorrent's config from the environment,
# supervise rtorrent and the web server, and forward shutdown signals.
set -eu

log() { printf '[cascade] %s\n' "$*"; }
die() { printf '[cascade] FATAL: %s\n' "$*" >&2; exit 1; }

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

export TZ RT_LOG_FILE CASCADE_STATE_FILE CASCADE_BOOT_SETTINGS="$BOOT_SETTINGS"
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
  chown "$PUID:$PGID" "$RT_DOWNLOAD_DIR" "$RT_WATCH_DIR" "$(dirname "$RC_FILE")" 2>/dev/null || true
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

SESSION_LOCK="$RT_SESSION_DIR/rtorrent.lock"
if [ -f "$SESSION_LOCK" ]; then
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
fi

# --------------------------------------------------------------------------
# rtorrent.rc
#
# Only commands that exist in every rtorrent from 0.9.x through 0.15.x go in
# here — rtorrent aborts on an unknown command in its config file. Everything
# version-dependent is applied afterwards over XML-RPC by the web server, which
# probes the command table first and skips what this build does not have.
# --------------------------------------------------------------------------

quote() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

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

if [ -n "${RT_CONFIG_FILE:-}" ] && [ -f "$RT_CONFIG_FILE" ] && [ "${RT_CONFIG_KEEP:-1}" = "1" ]; then
  log "using the supplied rtorrent config at $RT_CONFIG_FILE verbatim"
else
  log "generating $RC_FILE for rtorrent $RT_VERSION"
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
    for scope in $(echo "$RT_LOG_LEVEL" | tr ',' ' '); do
      echo "log.add_output = \"$scope\", \"cascade\""
    done
    echo
    if [ -d "$RT_WATCH_DIR" ] && [ "${RT_WATCH_ENABLE:-1}" = "1" ]; then
      echo "# Auto-load anything dropped into the watch directory."
      # The string form of 'schedule' works on every release; 'schedule2' was
      # dropped in 0.16.
      echo "schedule = watch_directory, $RT_WATCH_INTERVAL, $RT_WATCH_INTERVAL, \"load.start=${RT_WATCH_DIR}/*.torrent\""
      echo
    fi
    if [ -n "${RT_COMPLETED_DIR:-}" ]; then
      echo "# Move data to RT_COMPLETED_DIR once a download finishes."
      echo "method.insert = d.data_path, simple, \"if=(d.is_multi_file), (cat, (d.directory)), (cat, (d.directory), /, (d.name))\""
      echo "method.insert = d.move_to_complete, simple, \"d.directory.set=\$argument.1= ; execute=mkdir,-p,\$argument.1= ; execute=mv,-u,\$argument.0=,\$argument.1= ; d.save_full_session=\""
      echo "method.set_key = event.download.finished, move_complete, \"d.move_to_complete=\$d.data_path=, $(quote "$RT_COMPLETED_DIR")\""
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

emit() { # emit <json-key> <env-value> <json|string>
  [ -n "$2" ] || return 0
  [ -n "$SETTINGS_BUF" ] && SETTINGS_BUF="$SETTINGS_BUF,"
  if [ "${3:-json}" = "string" ]; then
    SETTINGS_BUF="$SETTINGS_BUF\"$1\":\"$2\""
  else
    SETTINGS_BUF="$SETTINGS_BUF\"$1\":$2"
  fi
}

# Rates are given in KiB/s (0 = unlimited), like every other rtorrent front end.
kib() { [ -n "${1:-}" ] || return 0; echo $(( $1 * 1024 )); }
yesno() { case "$(echo "${1:-}" | tr 'A-Z' 'a-z')" in yes|true|1|on) echo true ;; no|false|0|off) echo false ;; *) echo "" ;; esac; }

SETTINGS_BUF=""
emit downloadRate "$(kib "${RT_DOWNLOAD_RATE:-}")"
emit uploadRate "$(kib "${RT_UPLOAD_RATE:-}")"
emit maxUploads "${RT_MAX_UPLOADS:-}"
emit minUploads "${RT_MIN_UPLOADS:-}"
emit maxUploadsGlobal "${RT_MAX_UPLOADS_GLOBAL:-}"
emit maxDownloads "${RT_MAX_DOWNLOADS:-}"
emit minDownloads "${RT_MIN_DOWNLOADS:-}"
emit maxDownloadsGlobal "${RT_MAX_DOWNLOADS_GLOBAL:-}"
emit minPeers "${RT_MIN_PEERS:-}"
emit maxPeers "${RT_MAX_PEERS:-}"
emit minPeersSeed "${RT_MIN_PEERS_SEED:-}"
emit maxPeersSeed "${RT_MAX_PEERS_SEED:-}"
emit maxOpenFiles "${RT_MAX_OPEN_FILES:-}"
emit maxOpenSockets "${RT_MAX_OPEN_SOCKETS:-}"
emit maxHttpOpen "${RT_MAX_HTTP_OPEN:-}"
emit dnsCacheTimeout "${RT_DNS_CACHE_TIMEOUT:-}"
emit memoryMax "${RT_MEMORY_MAX:-}"
emit syncTimeout "${RT_SYNC_TIMEOUT:-}"
emit preloadType "${RT_PRELOAD_TYPE:-}"
emit preloadMinSize "${RT_PRELOAD_MIN_SIZE:-}"
emit preloadMinRate "${RT_PRELOAD_MIN_RATE:-}"
emit dhtPort "${RT_DHT_PORT:-}"
emit trackersNumwant "${RT_TRACKER_NUMWANT:-}"
emit receiveBuffer "${RT_RECEIVE_BUFFER:-}"
emit sendBuffer "${RT_SEND_BUFFER:-}"
emit maxFileSize "${RT_MAX_FILE_SIZE:-}"
emit xmlrpcSizeLimit "${RT_XMLRPC_SIZE_LIMIT:-}"
emit pex "$(yesno "${RT_PEX:-}")"
emit udpTrackers "$(yesno "${RT_UDP_TRACKERS:-}")"
emit preallocate "$(yesno "${RT_PREALLOCATE:-}")"
emit checkHashOnCompletion "$(yesno "${RT_HASH_ON_COMPLETION:-}")"
emit sslVerifyPeer "$(yesno "${RT_SSL_VERIFY_PEER:-}")"
emit sslVerifyHost "$(yesno "${RT_SSL_VERIFY_HOST:-}")"
emit portOpen "$(yesno "${RT_PORT_OPEN:-}")"
emit dhtMode "${RT_DHT:-}" string
emit encryption "${RT_ENCRYPTION:-}" string
emit bindAddress "${RT_BIND:-}" string
emit localAddress "${RT_IP:-}" string
emit proxyAddress "${RT_PROXY:-}" string
emit httpCapath "${RT_HTTP_CAPATH:-}" string
emit httpCacert "${RT_HTTP_CACERT:-}" string
# rtorrent 0.16 additions — skipped automatically on older backends.
emit httpMaxHostConnections "${RT_HTTP_MAX_HOST:-}"
emit dhtOverridePort "${RT_DHT_OVERRIDE_PORT:-}"
emit blockOutgoing "$(yesno "${RT_BLOCK_OUTGOING:-}")"
emit adviseRandomHashing "$(yesno "${RT_ADVISE_RANDOM_HASHING:-}")"
emit proxyGlobal "${RT_PROXY_GLOBAL:-}" string
emit proxyHttp "${RT_PROXY_HTTP:-}" string
emit bindAddressV4 "${RT_BIND_IPV4:-}" string
emit bindAddressV6 "${RT_BIND_IPV6:-}" string

printf '{%s}\n' "$SETTINGS_BUF" > "$BOOT_SETTINGS"
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
  rm -f "$RT_SCGI_SOCKET"
  # rtorrent is a curses application: it needs a pty even when nothing is
  # attached, so it runs inside a detached screen session. That also means
  # `docker exec -it <container> screen -r rtorrent` gives you the real UI.
  as_user env TERM="${TERM:-screen}" HOME=/config SCREENDIR="$SCREEN_DIR" \
    screen -dmS rtorrent rtorrent -n -o import="$RC_FILE"
}

stop_all() {
  STOPPING=1
  log "shutting down"
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null || true
  if pidof rtorrent >/dev/null 2>&1; then
    # SIGINT is rtorrent's clean-shutdown signal; it saves the session first.
    kill -INT "$(pidof rtorrent)" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pidof rtorrent >/dev/null 2>&1 || break
      sleep 1
    done
    pidof rtorrent >/dev/null 2>&1 && kill -TERM "$(pidof rtorrent)" 2>/dev/null || true
  fi
  exit 0
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

as_user node /app/server/index.js &
NODE_PID=$!

while [ "$STOPPING" = "0" ]; do
  sleep 5 &
  wait $! 2>/dev/null || true
  [ "$STOPPING" = "1" ] && break

  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    log "web server exited — stopping container"
    stop_all
  fi
  if ! pidof rtorrent >/dev/null 2>&1; then
    log "rtorrent died, restarting it"
    start_rtorrent
  fi
done
