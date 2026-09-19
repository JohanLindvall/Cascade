#!/bin/sh
# Applied to the rtorrent checkout before it is configured and built (the
# Dockerfile's build() runs apply-<repo>.sh from this directory if one exists).
#
# Sets the HTTP User-Agent rtorrent announces with, when USER_AGENT is given.
# rtorrent bakes it in at compile time — configure.ac's AC_DEFINE(USER_AGENT)
# from PACKAGE and VERSION, applied once at startup — and exposes no command to
# change it at runtime, so a build argument is the only lever.
#
# Why anyone would: private trackers whitelist client versions, and a release
# newer than their list is refused ("this version has not yet been
# whitelisted"), which rtorrent reports as a plain announce failure. Note this
# changes only the HTTP header; the BitTorrent peer_id still carries
# libtorrent's own prefix (-lt1016- for 0.16.x), so a tracker that checks the
# peer_id still sees the real version.
#
# Unset means untouched: the stock build announces its true version.
set -eu

[ -n "${USER_AGENT:-}" ] || exit 0

# The value becomes a C++ string literal, so refuse anything that could end it
# early or smuggle in an escape. Ordinary agents ("rtorrent/0.16.20") pass.
case "$USER_AGENT" in
  *\"* | *\\* | *'
'*)
    echo "apply-rtorrent: USER_AGENT may not contain quotes, backslashes or newlines" >&2
    exit 1
    ;;
esac

# 0.16.x sets it in src/main.cc, 0.9.x in src/control.cc — both through the
# same call, which is what this matches rather than either file's name.
target="$(grep -rl 'set_user_agent(USER_AGENT)' src 2>/dev/null | head -n1 || true)"
[ -n "$target" ] || {
  echo "apply-rtorrent: no set_user_agent(USER_AGENT) call found — rtorrent changed shape" >&2
  exit 1
}

sed -i "s|set_user_agent(USER_AGENT)|set_user_agent(std::string(\"${USER_AGENT}\"))|" "$target"

grep -q "set_user_agent(std::string(\"${USER_AGENT}\"))" "$target" || {
  echo "apply-rtorrent: the User-Agent edit did not take in $target" >&2
  exit 1
}

echo "apply-rtorrent: announcing as \"${USER_AGENT}\" (patched into $target)"
