#!/bin/sh
# Applied to the libtorrent checkout before it is configured and built (the
# Dockerfile's build() runs apply-<repo>.sh from this directory if one exists).
#
# What it changes is small and the same across every supported release: the
# three places that turn names into filesystem paths gain a call into
# path_fit.h, so a component longer than Linux allows is shortened to fit
# instead of failing every open with ENAMETOOLONG. The rule lives in the
# header; this only wires it in.
#
# Rather than a unified diff per release, the edits are pattern substitutions
# that know the spellings the code has had (0.13.x, 0.15.x, 0.16.x) and refuse
# to continue if none of them matched — a libtorrent that changed shape must
# fail the build here, not silently ship without the fix.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
[ -f src/torrent/path.cc ] || { echo "apply-libtorrent: run from the libtorrent source root" >&2; exit 1; }

# The rule is checked with the toolchain that is about to build libtorrent.
g++ -std=c++11 -Wall -I "$here" -o /tmp/path_fit_test "$here/path_fit_test.cc"
/tmp/path_fit_test

cp "$here/path_fit.h" src/torrent/path_fit.h

nl='
'

# Add an include after an existing one; the file must have that include.
add_include() { # add_include <file> <after-include> <new-include>
  grep -q "^#include \"$2\"" "$1" || { echo "apply-libtorrent: $1 lacks #include \"$2\"" >&2; exit 1; }
  sed -i "s|^#include \"$2\"\$|#include \"$2\"\\${nl}#include \"$3\"|" "$1"
}

# Substitute one of several spellings; exactly one must take, measured by how
# many more times the marker (the helper being called) appears afterwards.
substitute() { # substitute <file> <what> <marker> <sed s-expression>...
  file="$1"; what="$2"; marker="$3"; shift 3
  before="$(grep -c "$marker" "$file" || true)"
  for expr in "$@"; do
    sed -i "$expr" "$file"
  done
  after="$(grep -c "$marker" "$file" || true)"
  if [ "$((after - before))" -ne 1 ]; then
    echo "apply-libtorrent: expected exactly one $what edit in $file, made $((after - before)) — libtorrent changed shape" >&2
    exit 1
  fi
}

# Path::as_string(): the joined file path.
add_include src/torrent/path.cc path.h path_fit.h
substitute src/torrent/path.cc "Path::as_string" path_fit_component \
  's|^\(  *s += \)\*itr;$|\1path_fit_component(*itr);|' \
  's|^\(  *s += \)c;$|\1path_fit_component(c);|' \
  's|^\(  *s += \)c\.str();$|\1path_fit_component(c.str());|'

# FileList::make_directory(): each directory component on the way to the file.
add_include src/torrent/data/file_list.cc config.h ../path_fit.h
substitute src/torrent/data/file_list.cc "FileList::make_directory" path_fit_component \
  's|^\(  *path += "/" + \)\*pathBegin;$|\1path_fit_component(*pathBegin);|' \
  's|^\(  *path += "/" + \)path_begin->str();$|\1path_fit_component(path_begin->str());|'

# FileList::set_root_dir(): the root rtorrent composes from the download
# directory and the torrent's name (a directory, for a multi-file torrent).
substitute src/torrent/data/file_list.cc "FileList::set_root_dir" path_fit_path \
  's|^\(  *m_rootDir = \)path\.substr(0, last + 1);$|\1path_fit_path(path.substr(0, last + 1));|' \
  's|^\(  *m_root_dir = \)path\.substr(0, last + 1);$|\1path_fit_path(path.substr(0, last + 1));|'

# PEER_NAME: the prefix of the peer id every peer and tracker sees.
#
# libtorrent bakes it into configure.ac as an Azureus-style "-ltXXXX-", where
# XXXX encodes the release — from 0.15 on, the minor and patch release as two
# hex digits each (0.16.20 is -lt1014-, 0.16.24 -lt1018-). It is the other
# half of the client's identity: changing only rtorrent's HTTP User-Agent
# leaves a peer id that still names the real version, which a tracker
# checking both would see straight through.
#
# Unset means untouched. The two AC_DEFINE spellings (0.13.x bare, 0.15+
# double-bracketed) both carry the value as a quoted "-lt....-", so the edit
# targets that string on the PEER_NAME line rather than either spelling.
if [ -n "${PEER_NAME:-}" ]; then
  # Azureus-style and safe as a C string: -XXdddd- with nothing exotic in it.
  case "$PEER_NAME" in
    -[A-Za-z][A-Za-z][0-9A-Za-z][0-9A-Za-z][0-9A-Za-z][0-9A-Za-z]-) ;;
    *)
      echo "apply-libtorrent: PEER_NAME must look like -lt1014- (8 chars, -XXnnnn-)" >&2
      exit 1
      ;;
  esac

  grep -q 'PEER_NAME' configure.ac || {
    echo "apply-libtorrent: configure.ac has no PEER_NAME — libtorrent changed shape" >&2
    exit 1
  }
  sed -i "/PEER_NAME/ s|\"-[0-9A-Za-z]*-\"|\"${PEER_NAME}\"|" configure.ac
  grep -q "\"${PEER_NAME}\"" configure.ac || {
    echo "apply-libtorrent: the PEER_NAME edit did not take" >&2
    exit 1
  }
  echo "apply-libtorrent: peer id prefix is \"${PEER_NAME}\""
fi

echo "apply-libtorrent: long path components will be shortened to fit (path_fit.h)"
