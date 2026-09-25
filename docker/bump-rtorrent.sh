#!/bin/sh
# Move the default rtorrent build to a newer upstream release.
#
#   docker/bump-rtorrent.sh            # the newest release both projects tagged
#   docker/bump-rtorrent.sh 0.16.25    # a particular one
#
# The default lives in one place, the Dockerfile's ARG RTORRENT_VERSION — the
# Makefile and release.yml read it from there — and the README names it in two
# (the highlights and "Choosing the rtorrent version"). This rewrites those
# three and nothing else: every other version in the docs is history and
# stays put. What the new release presents itself as needs no edit either;
# the Dockerfile's rule covers every release past 0.16.20.
#
# A release counts once libtorrent carries the same tag: from 0.15 on the two
# ship together, and the build needs both.
#
# Prints the version it moved to. Prints nothing, and succeeds, when the
# default is already that release or newer — which is what lets the scheduled
# workflow (.github/workflows/rtorrent-update.yml) run it every day.
set -eu
cd "$(dirname "$0")/.."

# Stable release tags only (vX.Y.Z), no release candidates.
tags() {
  git ls-remote --tags --refs "https://github.com/rakshasa/$1.git" 'v*' |
    sed -n 's#.*refs/tags/v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$#\1#p'
}

# The highest of the versions on stdin, compared field by field as numbers.
highest() {
  sort -t. -k1,1n -k2,2n -k3,3n | tail -n1
}

current="$(sed -n 's/^ARG RTORRENT_VERSION=//p' Dockerfile)"
[ -n "$current" ] || {
  echo "bump-rtorrent: no ARG RTORRENT_VERSION in the Dockerfile" >&2
  exit 1
}

# Tagged in both repositories: uniq -d keeps what appears in each list.
released="$( { tags rtorrent; tags libtorrent; } | sort | uniq -d)"
target="${1:-$(printf '%s\n' "$released" | highest)}"
printf '%s\n' "$released" | grep -qx "$(printf '%s' "$target" | sed 's/\./\\./g')" || {
  echo "bump-rtorrent: ${target:-no release} is not tagged in both rtorrent and libtorrent" >&2
  exit 1
}

if [ "$(printf '%s\n%s\n' "$current" "$target" | highest)" = "$current" ]; then
  echo "bump-rtorrent: the default is already $current" >&2
  exit 0
fi

old="$(printf '%s' "$current" | sed 's/\./\\./g')"
sed -i.bak "s/^ARG RTORRENT_VERSION=$old\$/ARG RTORRENT_VERSION=$target/" Dockerfile
sed -i.bak \
  -e "s/\*\*rtorrent $old, compiled from source\*\*/**rtorrent $target, compiled from source**/" \
  -e "s/The default is \*\*$old\*\*/The default is **$target**/" \
  README.md
rm -f Dockerfile.bak README.md.bak

# Every edit has to have taken: a README reworded by hand would otherwise go
# on naming the old default without anyone noticing.
if ! grep -q "^ARG RTORRENT_VERSION=$target\$" Dockerfile ||
  ! grep -q "\*\*rtorrent $target, compiled from source\*\*" README.md ||
  ! grep -q "The default is \*\*$target\*\*" README.md; then
  echo "bump-rtorrent: an edit did not take — check the Dockerfile and README by hand" >&2
  exit 1
fi
echo "$target"
