#!/bin/sh
# Pure shell regressions; network calls are replaced with a tiny git stub.
set -eu
root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
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
echo 'container script tests passed'
