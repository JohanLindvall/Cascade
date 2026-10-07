#!/bin/sh
# SPDX-License-Identifier: MIT
# Attach to rtorrent's curses UI in its screen session (detach with ctrl-a d):
#
#   docker exec -it cascade cascade-attach
#
# screen serves a session only to the user who started it, and rtorrent runs
# as PUID:PGID — so a plain `screen -r` from docker exec, which runs as root,
# finds nothing to attach to. -d detaches a terminal that went away without
# detaching first, which would otherwise leave the session unattachable.
set -eu
SCREENDIR="$(dirname "${RT_SCGI_SOCKET:-/run/rtorrent/rpc.socket}")/screen"
export SCREENDIR
if [ "$(id -u)" = "0" ]; then
  exec su-exec "${PUID:-1000}:${PGID:-1000}" screen -d -r rtorrent
fi
exec screen -d -r rtorrent
