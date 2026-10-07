#!/bin/sh
# SPDX-License-Identifier: MIT
# Cascade container entrypoint: render rtorrent's config from the environment,
# supervise rtorrent and the web server, and forward shutdown signals.
#
# Everything is a function and main runs last, so docker/scripts.test.sh can
# source this file with ENTRYPOINT_LIBRARY=1 and test the pieces (a name
# outside the RT_/WEB_/CASCADE_ families, which the option catalog owns).
set -eu
# Scope lists are split into words below; a word must never become a glob.
set -f

log() { printf '[cascade] %s\n' "$*"; }
die() { printf '[cascade] FATAL: %s\n' "$*" >&2; exit 1; }
am_root() { [ "$(id -u)" = "0" ]; }

# --------------------------------------------------------------------------
# defaults
# --------------------------------------------------------------------------

apply_defaults() {
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
  SCGI_DIR="$(dirname "$RT_SCGI_SOCKET")"
  # Where screen keeps its session socket; cascade-attach looks in the same
  # place.
  SCREEN_DIR="$SCGI_DIR/screen"
  RUN_USER=rtorrent

  export TZ RT_LOG_FILE RT_LOG_LEVEL CASCADE_STATE_FILE CASCADE_BOOT_SETTINGS="$BOOT_SETTINGS"
  export CASCADE_SCGI="${CASCADE_SCGI:-$RT_SCGI_SOCKET}"
  export SCREENDIR="$SCREEN_DIR"
}

# enabled <name> <value>: the boolean options, spelled as the server spells
# them (internal/validate.Bool): 1/true/yes/on or 0/false/no/off, in any case,
# and anything else stops the start by name. Comparing with "1" alone read
# RT_CONFIG_KEEP=true as "regenerate" and overwrote the owner's own rc.
# Call it with "${NAME:-default}" spelled out — that is how the options check
# (server/internal/options) sees the variable being read — and never inside
# $(...), where die would only end the subshell.
enabled() {
  case "$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on) return 0 ;;
    0 | false | no | off) return 1 ;;
    *) die "$1 must be one of 1/true/yes/on or 0/false/no/off, not \"$2\"" ;;
  esac
}

# The supplied RT_CONFIG_FILE is used as it is, and nothing is generated.
keeps_supplied_rc() {
  [ -n "${RT_CONFIG_FILE:-}" ] && [ -f "$RT_CONFIG_FILE" ] && enabled RT_CONFIG_KEEP "${RT_CONFIG_KEEP:-1}"
}

# check_rc_value <name> <value> <extended regex> <what it should be>
#
# These go into rtorrent.rc as they are. A malformed one used to stop rtorrent
# with a parse error thirty seconds later, reported as a bare "failed to
# start", and one with a newline in it would have started a line of its own.
# The patterns follow what rtorrent's rc parser takes (checked on 0.9.8 and
# 0.16.24) rather than a tidier subset, so a value that started rtorrent
# before does not stop the start now: 0, 22 and 00:00:10 are all fine.
check_rc_value() {
  case "$2" in
    *'
'*) die "$1 must be $4, on one line" ;;
  esac
  printf '%s\n' "$2" | grep -Eqx -- "$3" || die "$1 must be $4, not \"$2\""
}

# Runs before anything is written, so a bad value stops the start by name.
validate_options() {
  # Read whether or not an rc is generated; `|| :` because only a refusal
  # matters here.
  enabled RT_CONFIG_KEEP "${RT_CONFIG_KEEP:-1}" || :
  enabled RT_WATCH_ENABLE "${RT_WATCH_ENABLE:-1}" || :
  enabled RT_SESSION_LOCK_KEEP "${RT_SESSION_LOCK_KEEP:-0}" || :
  enabled CASCADE_CHOWN_DOWNLOADS "${CASCADE_CHOWN_DOWNLOADS:-0}" || :
  # pick_port_commands writes the range into a probe rc whatever rc is used.
  check_rc_value RT_PORT_RANGE "$RT_PORT_RANGE" '[0-9]{1,5}-[0-9]{1,5}' 'a port range like 50000-50000'
  # The rest only reach a generated rc; a supplied one never reads them.
  if keeps_supplied_rc; then
    return 0
  fi
  enabled RT_PORT_RANDOM "$RT_PORT_RANDOM" || :
  # The torrent-name switches reach the rc only when set (pick_name_switches).
  if [ -n "${RT_USE_SANITIZED_NAME:-}" ]; then
    enabled RT_USE_SANITIZED_NAME "$RT_USE_SANITIZED_NAME" || :
  fi
  if [ -n "${RT_ALLOW_LEGACY_UTF8:-}" ]; then
    enabled RT_ALLOW_LEGACY_UTF8 "$RT_ALLOW_LEGACY_UTF8" || :
  fi
  check_rc_value RT_UMASK "$RT_UMASK" '[0-7]{1,4}' 'an octal umask like 0022'
  check_rc_value RT_WATCH_INTERVAL "$RT_WATCH_INTERVAL" '[0-9]+(:[0-9]{1,2}){0,2}' 'a number of seconds, or a time like 00:00:10'
  if [ -n "${RT_SCGI_PORT:-}" ]; then
    check_rc_value RT_SCGI_PORT "$RT_SCGI_PORT" '[0-9]{1,5}' 'a TCP port'
  fi
}

detect_rtorrent() {
  rtorrent -h >/dev/null 2>&1 || die "the rtorrent binary will not run: $(rtorrent -h 2>&1 | head -n2)"
  RT_VERSION="$(rtorrent -h 2>&1 | sed -n 's/.*version \([0-9][0-9.]*[0-9]\).*/\1/p' | head -n1)"
  [ -n "$RT_VERSION" ] || RT_VERSION="unknown"
}

# --------------------------------------------------------------------------
# user + directories
# --------------------------------------------------------------------------

setup_user() {
  if am_root; then
    if ! getent group "$PGID" >/dev/null 2>&1; then
      addgroup -g "$PGID" "$RUN_USER" 2>/dev/null || true
    fi
    GROUP_NAME="$(getent group "$PGID" | cut -d: -f1)"
    : "${GROUP_NAME:=$RUN_USER}"
    if ! getent passwd "$PUID" >/dev/null 2>&1; then
      adduser -D -H -u "$PUID" -G "$GROUP_NAME" "$RUN_USER" 2>/dev/null || true
    fi
  else
    PUID="$(id -u)"
    PGID="$(id -g)"
  fi
}

# own [-R] <owner> <path>...: hand paths to the run user; nothing to do
# unless running as root.
own() {
  am_root || return 0
  chown "$@" 2>/dev/null || true
}

prepare_dirs() {
  for dir in "$RT_DOWNLOAD_DIR" "$RT_SESSION_DIR" "$RT_WATCH_DIR" "$SCGI_DIR" "$SCREEN_DIR" \
             "$(dirname "$RC_FILE")" "$(dirname "$RT_LOG_FILE")" \
             "$(dirname "$BOOT_SETTINGS")" "$(dirname "$CASCADE_STATE_FILE")" \
             ${RT_COMPLETED_DIR:+"$RT_COMPLETED_DIR"}; do
    mkdir -p "$dir"
  done

  # screen refuses a socket directory that is not 0700 and owned by the user.
  chmod 0700 "$SCREEN_DIR"

  own -R "$PUID:$PGID" "$RT_SESSION_DIR" "$SCGI_DIR" "$(dirname "$BOOT_SETTINGS")"
  own "$PUID:$PGID" "$RT_DOWNLOAD_DIR" "$RT_WATCH_DIR" "$(dirname "$RC_FILE")" \
    "$(dirname "$RT_LOG_FILE")" "$(dirname "$CASCADE_STATE_FILE")" ${RT_COMPLETED_DIR:+"$RT_COMPLETED_DIR"}
  for file in "$RT_LOG_FILE" "$CASCADE_STATE_FILE"; do
    [ ! -e "$file" ] || own "$PUID:$PGID" "$file"
  done
  if am_root && enabled CASCADE_CHOWN_DOWNLOADS "${CASCADE_CHOWN_DOWNLOADS:-0}"; then
    log "taking ownership of $RT_DOWNLOAD_DIR (this can take a while)"
    own -R "$PUID:$PGID" "$RT_DOWNLOAD_DIR"
  fi
}

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
  lock="$RT_SESSION_DIR/rtorrent.lock"
  [ -f "$lock" ] || return 0
  lock_holder="$(cat "$lock" 2>/dev/null || true)"
  lock_host="${lock_holder%%:*}"
  lock_pid="${lock_holder##*+}"
  if enabled RT_SESSION_LOCK_KEEP "${RT_SESSION_LOCK_KEEP:-0}"; then
    log "keeping session lock held by ${lock_holder:-unknown} (RT_SESSION_LOCK_KEEP=$RT_SESSION_LOCK_KEEP)"
  elif [ "$lock_host" = "$(hostname)" ] && [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    die "session $RT_SESSION_DIR is locked by a running rtorrent (pid $lock_pid)"
  else
    log "clearing stale session lock left by ${lock_holder:-unknown}"
    rm -f "$lock"
  fi
}

# --------------------------------------------------------------------------
# rtorrent.rc
#
# Only commands that exist in every supported rtorrent (0.9.x to 0.16.x) go in
# here — rtorrent aborts on an unknown command in its config file — and the
# few that must be in force before rtorrent starts, each asked of this build
# first (rc_command_exists). Everything else version-dependent is applied
# afterwards over XML-RPC by the web server, which probes the command table
# first and skips what this build does not have.
# --------------------------------------------------------------------------

quote() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

# Log scopes the UI raised in an earlier run, read out of the state file the
# server owns. Anything unreadable — no file yet, corrupt JSON — yields
# nothing rather than failing the start, and the server filters the names to
# the shape a scope has so a hand-edited file cannot inject rc lines.
stored_log_scopes() {
  [ -f "$CASCADE_STATE_FILE" ] || return 0
  cascade log-scopes "$CASCADE_STATE_FILE" 2>/dev/null || true
}

# Ask this rtorrent whether it knows a command, by feeding it a one-line option
# file. Used for the few settings that must be in rtorrent.rc — the listening
# port has to be right before rtorrent binds, and 0.16 renamed the commands
# from network.port_range to network.listen.port.range; the torrent-name
# switches have to be right before the session loads, and arrived in 0.16.22
# and 0.16.25.
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

pick_port_commands() {
  if rc_command_exists "network.listen.port.range.set = $RT_PORT_RANGE"; then
    PORT_RANGE_CMD="network.listen.port.range.set"
    PORT_RANDOM_CMD="network.listen.port.random.set"
  else
    PORT_RANGE_CMD="network.port_range.set"
    PORT_RANDOM_CMD="network.port_random.set"
  fi
  log "listen port commands: $PORT_RANGE_CMD / $PORT_RANDOM_CMD"
}

# The torrent-name switches go into the rc as well as the startup settings:
# rtorrent names a torrent as it loads it, and it loads the session before the
# server can apply anything. Applied only afterwards, a switch would name the
# session's torrents one way and new ones another — and RT_ALLOW_LEGACY_UTF8
# would have rtorrent look for a multi-file torrent's files, after every
# restart, under other names than it saved them under (a single-file torrent's
# file keeps its legacy name either way). Only a build that knows the command
# gets the line, since rtorrent aborts on an unknown one; the server's
# startup settings name what this build lacks.
pick_name_switches() {
  NAME_SWITCHES=""
  if [ -n "${RT_USE_SANITIZED_NAME:-}" ]; then
    add_name_switch system.torrent_name.use_sanitized.set RT_USE_SANITIZED_NAME "$RT_USE_SANITIZED_NAME"
  fi
  if [ -n "${RT_ALLOW_LEGACY_UTF8:-}" ]; then
    add_name_switch system.file_name.allow_legacy_utf8.set RT_ALLOW_LEGACY_UTF8 "$RT_ALLOW_LEGACY_UTF8"
  fi
}

# add_name_switch <command> <name> <value>
add_name_switch() {
  if enabled "$2" "$3"; then switch=1; else switch=0; fi
  if rc_command_exists "$1 = $switch"; then
    NAME_SWITCHES="$NAME_SWITCHES$1 = $switch
"
  fi
}

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

# One line of rtorrent.rc. Not echo: some shells' echo reads the backslashes
# quote() writes as escapes of its own.
rc_line() { printf '%s\n' "$*"; }

# render_rc prints the generated rtorrent.rc. The log scopes come in as
# LOG_SCOPES, already filtered down to what this build accepts.
render_rc() {
  rc_line "# Generated by the Cascade entrypoint on container start."
  rc_line "# Edits are overwritten; mount your own file and set RT_CONFIG_FILE to keep it."
  echo
  # rtorrent reads a number the way C does, so a bare 22 was decimal (umask
  # 0026) and 777 came out as 0411. A umask is octal, as umask(1) reads it;
  # a leading 0 makes rtorrent agree.
  rc_line "system.umask.set = 0${RT_UMASK#0}"
  rc_line "directory.default.set = $(quote "$RT_DOWNLOAD_DIR")"
  rc_line "session.path.set = $(quote "$RT_SESSION_DIR")"
  echo
  rc_line "$PORT_RANGE_CMD = $RT_PORT_RANGE"
  # rtorrent refuses on/off, which the server's booleans take.
  if enabled RT_PORT_RANDOM "$RT_PORT_RANDOM"; then port_random=yes; else port_random=no; fi
  rc_line "$PORT_RANDOM_CMD = $port_random"
  echo
  if [ -n "${NAME_SWITCHES:-}" ]; then
    rc_line "# RT_USE_SANITIZED_NAME / RT_ALLOW_LEGACY_UTF8, in force before the session loads."
    printf '%s' "$NAME_SWITCHES"
    echo
  fi
  rc_line "# XML-RPC over SCGI — this is what the web UI and any external client talk to."
  rc_line "network.scgi.open_local = $(quote "$RT_SCGI_SOCKET")"
  if [ -n "${RT_SCGI_PORT:-}" ]; then
    rc_line "network.scgi.open_port = $(quote "${RT_SCGI_BIND:-127.0.0.1}:${RT_SCGI_PORT}")"
  fi
  echo
  rc_line "log.open_file = \"cascade\", $(quote "$RT_LOG_FILE")"
  # RT_LOG_LEVEL's scopes, plus the ones raised from the log dialog and
  # remembered in the state file. The server re-attaches those on connect
  # anyway, but only once it has connected — writing them here as well is what
  # covers rtorrent's own startup: the session load, the first announces,
  # anything that goes wrong before the web server is up. Attaching a scope
  # twice is a no-op in rtorrent (measured), so the two paths cannot double a
  # line.
  for scope in $LOG_SCOPES; do
    rc_line "log.add_output = \"$scope\", \"cascade\""
  done
  echo
  if [ -d "$RT_WATCH_DIR" ] && enabled RT_WATCH_ENABLE "${RT_WATCH_ENABLE:-1}"; then
    rc_line "# Auto-load anything dropped into the watch directory."
    # The string form of 'schedule' works on every release; 'schedule2' was
    # dropped in 0.16.
    rc_line "schedule = watch_directory, $RT_WATCH_INTERVAL, $RT_WATCH_INTERVAL, $(quote "load.start=$(quote "$RT_WATCH_DIR/*.torrent")")"
    echo
  fi
  if [ -n "${RT_COMPLETED_DIR:-}" ]; then
    rc_line "# Move data to RT_COMPLETED_DIR once a download finishes."
    # d.name is metadata; d.base_path includes libtorrent's filename fitting.
    rc_line "method.insert = d.data_path, simple, \"d.base_path=\""
    # Close before moving so frozen paths refresh when reopened. Check for
    # collisions first, and change the directory only after the move succeeds.
    rc_line "method.insert = d.move_to_complete, simple, \"execute=/usr/local/bin/cascade-move,check,\$argument.0=,\$argument.1= ; d.stop= ; d.close= ; execute=/usr/local/bin/cascade-move,move,\$argument.0=,\$argument.1= ; d.directory.set=\$argument.1= ; d.open= ; d.start= ; d.save_full_session=\""
    rc_line "method.set_key = event.download.finished, move_complete, $(quote "d.move_to_complete=\$d.data_path=, $(quote "$RT_COMPLETED_DIR")")"
    echo
  fi
  if [ -n "${RT_EXTRA_CONFIG:-}" ]; then
    rc_line "# RT_EXTRA_CONFIG"
    printf '%s\n' "$RT_EXTRA_CONFIG"
    echo
  fi
  if [ -n "${RT_EXTRA_CONFIG_FILE:-}" ] && [ -f "$RT_EXTRA_CONFIG_FILE" ]; then
    rc_line "# $RT_EXTRA_CONFIG_FILE"
    cat "$RT_EXTRA_CONFIG_FILE"
  fi
}

write_rc() {
  if keeps_supplied_rc; then
    log "using the supplied rtorrent config at $RT_CONFIG_FILE verbatim"
    return 0
  fi
  log "generating $RC_FILE for rtorrent $RT_VERSION"
  # The server shows RT_LOG_LEVEL's scopes as the fixed ones, so it gets the
  # filtered list too.
  # shellcheck disable=SC2046 # one word per scope; set -f stops globbing
  RT_LOG_LEVEL="$(filter_log_scopes $(printf '%s' "$RT_LOG_LEVEL" | tr ',' ' '))"
  # shellcheck disable=SC2046
  LOG_SCOPES="$RT_LOG_LEVEL $(filter_log_scopes $(stored_log_scopes))"
  pick_name_switches
  render_rc > "$RC_FILE"
  own "$PUID:$PGID" "$RC_FILE"
}

# --------------------------------------------------------------------------
# startup settings handed to the web server
# --------------------------------------------------------------------------

# The catalog maps environment options to settings; JSON encoding and input
# validation run once in the server so quoted paths cannot corrupt the whole
# file, and a bad value stops the start here, by its name.
stage_boot_settings() {
  cascade boot-settings > "$BOOT_SETTINGS"
  own "$PUID:$PGID" "$BOOT_SETTINGS"
}

# --------------------------------------------------------------------------
# supervision
# --------------------------------------------------------------------------

as_user() {
  if am_root; then
    su-exec "$PUID:$PGID" "$@"
  else
    "$@"
  fi
}

start_rtorrent() {
  # The supervisor can restart a killed process in the same container too.
  clear_session_lock
  rm -f "$RT_SCGI_SOCKET"
  # rtorrent is a curses application: it needs a pty even when nothing is
  # attached, so it runs inside a detached screen session. That also means
  # `docker exec -it <container> cascade-attach` gives you the real UI.
  as_user env TERM="${TERM:-screen}" HOME=/config SCREENDIR="$SCREEN_DIR" \
    screen -dmS rtorrent rtorrent -n -o import="$RC_FILE"
}

wait_for_socket() {
  waited=0
  while [ ! -S "$RT_SCGI_SOCKET" ]; do
    waited=$((waited + 1))
    if [ "$waited" -gt 30 ]; then
      log "rtorrent did not create $RT_SCGI_SOCKET within 30s — recent log:"
      [ ! -f "$RT_LOG_FILE" ] || tail -n 30 "$RT_LOG_FILE" >&2
      die "rtorrent failed to start (check the config at $RC_FILE)"
    fi
    sleep 1
  done
  log "rtorrent is up"
}

# Started as a simple command rather than through as_user: $! has to be the
# server's own pid (su-exec execs into it), so stop_all's SIGTERM reaches the
# server itself rather than a subshell that would leave it running.
start_server() {
  if am_root; then
    su-exec "$PUID:$PGID" cascade &
  else
    cascade &
  fi
  SERVER_PID=$!
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
  [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null || true
  # The pid lists stay unquoted: pidof names every match, one word each.
  if pids="$(pidof rtorrent)"; then
    # shellcheck disable=SC2086
    kill -INT $pids 2>/dev/null || true
    if wait_rtorrent 30; then
      log "rtorrent stopped cleanly after ${WAITED}s"
    else
      log "rtorrent is still shutting down after 30s — asking it to hurry"
      # shellcheck disable=SC2046
      kill -TERM $(pidof rtorrent) 2>/dev/null || true
      wait_rtorrent 10 || log "rtorrent did not stop; the next start clears its session lock"
    fi
  fi
  [ -z "$SERVER_PID" ] || wait "$SERVER_PID" 2>/dev/null || true
  exit "${1:-0}"
}

supervise() {
  while [ "$STOPPING" = "0" ]; do
    sleep 5 &
    wait $! 2>/dev/null || true
    [ "$STOPPING" = "0" ] || break

    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      log "web server exited — stopping container"
      # Preserve failure for Docker's on-failure restart policy.
      stop_all 1
    fi
    if ! pidof rtorrent >/dev/null 2>&1; then
      log "rtorrent died, restarting it"
      start_rtorrent
    fi
  done
}

main() {
  # `docker run --rm cascade --help` lists every option. Answered first,
  # before any user, directory or rtorrent setup, so it works in any
  # environment. The text is rendered from the option catalog in the server
  # (server/internal/options).
  case "${1:-}" in
    -h | --help | help) exec cascade --help ;;
  esac

  apply_defaults
  validate_options
  detect_rtorrent
  setup_user
  prepare_dirs
  pick_port_commands
  write_rc
  stage_boot_settings

  SERVER_PID=""
  STOPPING=0
  trap stop_all TERM INT

  log "rtorrent $RT_VERSION | uid=$PUID gid=$PGID | scgi=$RT_SCGI_SOCKET"
  start_rtorrent
  wait_for_socket

  if [ $# -gt 0 ]; then
    exec "$@"
  fi
  start_server
  supervise
}

[ "${ENTRYPOINT_LIBRARY:-0}" = "1" ] || main "$@"
