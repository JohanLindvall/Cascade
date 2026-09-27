#!/bin/sh
# Called by rtorrent with separate argv entries, never through a shell string.
set -eu
mode="$1"
source="$2"
destination="$3"
fail() { printf '[cascade] completion move: %s\n' "$*" >&2; exit 1; }
[ -e "$source" ] || [ -L "$source" ] || fail "source is missing: $source"
mkdir -p "$destination"
source="$(cd -- "$(dirname "$source")" && pwd -P)/$(basename "$source")"
destination="$(cd -- "$destination" && pwd -P)"
target="$destination/$(basename "$source")"
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
