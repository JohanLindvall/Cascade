#!/bin/sh
# SPDX-License-Identifier: MIT
# cascade-move check|move SOURCE DESTINATION: the completion move
# (d.move_to_complete in docker/entrypoint.sh). rtorrent calls it with separate
# argv entries, never through a shell string, and hands it the paths as bytes,
# which need not be UTF-8. The data keeps its name in DESTINATION byte for
# byte: rtorrent is pointed at it afterwards by that name, which for a
# multi-file torrent need not be the torrent's own.
set -eu
mode="$1"
source="$2"
destination="$3"
fail() { printf '[cascade] completion move: %s\n' "$*" >&2; exit 1; }
# The name by expansion, not basename(1): a command substitution drops the
# newlines a name may end in.
source="${source%"${source##*[!/]}"}"
name="${source##*/}"
case "$source" in
  */*) parent="${source%/*}" ;;
  *) parent=. ;;
esac
[ -n "$name" ] || fail "no source to move: $2"
[ -e "$source" ] || [ -L "$source" ] || fail "source is missing: $source"
mkdir -p "$destination"
source="$(CDPATH='' cd -- "${parent:-/}" && pwd -P)"
source="${source%/}/$name"
destination="$(CDPATH='' cd -- "$destination" && pwd -P)"
target="${destination%/}/$name"
[ "$source" != "$target" ] || exit 0
case "$destination/" in "$source/"*) fail 'destination is inside the source' ;; esac
[ ! -e "$target" ] && [ ! -L "$target" ] || fail "destination already exists: $target"
[ -w "$destination" ] || fail "destination is not writable: $destination"
case "$mode" in
  check) exit 0 ;;
  move)
    # BusyBox has no mv -u. -n protects existing data, including a destination
    # that appeared after the check; a skipped move must not report success.
    mv -n -- "$source" "$destination/"
    [ ! -e "$source" ] && [ ! -L "$source" ] || fail "move did not finish: $source"
    ;;
  *) fail "unknown mode: $mode" ;;
esac
