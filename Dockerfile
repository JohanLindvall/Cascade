# syntax=docker/dockerfile:1
# SPDX-License-Identifier: MIT
#
# Cascade — a web UI for rtorrent, with rtorrent itself baked into the image.
#
# rtorrent is always compiled from an upstream tag, so the version in the image
# is exactly the one you asked for rather than whatever a distro happens to
# package:
#
#     docker build -t cascade .                                  # the default
#     docker build --build-arg RTORRENT_VERSION=0.15.2 -t cascade:0.15.2 .
#     docker build --build-arg RTORRENT_VERSION=0.9.8  -t cascade:0.9.8 .
#
# The default is RTORRENT_VERSION below — the one place it is written: the
# Makefile and the release workflow read it from here, and
# docker/bump-rtorrent.sh moves it to a newer upstream release.
#
# USER_AGENT and PEER_NAME override what the client calls itself; a release
# newer than 0.16.20 presents itself as 0.16.20 by default, because private
# trackers refuse versions they have not whitelisted yet. See
# docker/patches/apply-rtorrent.sh and apply-libtorrent.sh.
#
# libtorrent is pinned to the matching release automatically (rtorrent 0.9.x
# pairs with libtorrent 0.13.x, 0.10.x with 0.14.x, and from 0.15 onwards the
# two share a version). Override it with LIBTORRENT_VERSION when a pairing is
# unusual, and point RTORRENT_REPO/LIBTORRENT_REPO at a fork if needed.
#
# The server discovers what the backend supports at runtime (system.list-
# Methods), so one build of the UI drives any of these versions.
#
# Node is a build tool here and nothing more: the web UI is compiled to static
# files, and the server is a single Go binary.

ARG ALPINE_VERSION=3.22
ARG NODE_VERSION=24
ARG GO_VERSION=1.26

# --------------------------------------------------------------------------
# 1a. build the web UI
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS web
WORKDIR /src

# The lockfile pins every package, transitive ones included, so the image
# builds from exactly what CI tested.
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --no-audit --no-fund --loglevel=error

COPY web/ web/
# The client's half of the delta protocol is tested against the server's
# golden patches, so both sides are held to the same cases.
COPY server/internal/stream/testdata/ server/internal/stream/testdata/

# Unit tests run inside the build, so a red suite is a failed image — the
# same contract as the typecheck. They use node's own runner: no frameworks.
RUN cd web && npm test && npm run build

# --------------------------------------------------------------------------
# 1b. build the server
# --------------------------------------------------------------------------
FROM golang:${GO_VERSION}-alpine AS server
WORKDIR /src

# Modules first, so a source change does not download them again.
COPY server/go.mod server/go.sum server/
RUN --mount=type=cache,target=/go/pkg/mod cd server && go mod download

COPY server/ server/
# What the server's tests hold it to besides its own code: the README and
# the entrypoint (the option catalog is checked against both) and the web's
# copy of the badge table.
COPY README.md ./
COPY docker/ docker/
COPY web/src/game-catalog.json web/src/

# The same contract as the web: vet and the unit suites run in the build. The
# binary is static, so the runtime image needs nothing to run it.
RUN sh docker/scripts.test.sh
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    cd server && go vet ./... && go test ./... && \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/cascade . && \
    # The license of everything compiled in, taken while the module cache is
    # mounted. A module without a license file stops the build.
    mkdir -p /out/licenses/go && cp "$(go env GOROOT)/LICENSE" /out/licenses/go/ && \
    CGO_ENABLED=0 go list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}} {{.Dir}}{{end}}{{end}}' . | \
      sort -u | while read -r path dir; do \
        mkdir -p "/out/licenses/$path" && \
        find "$dir" -maxdepth 1 \( -iname 'licen[cs]e*' -o -iname 'copying*' -o -iname 'notice*' \) \
          -exec cp {} "/out/licenses/$path/" \; && \
        [ -n "$(ls "/out/licenses/$path")" ] || { echo "no license file in $path" >&2; exit 1; }; \
      done

# --------------------------------------------------------------------------
# 2. compile libtorrent and rtorrent from upstream tags
# --------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION} AS rtorrent
ARG RTORRENT_VERSION=0.16.24
ARG LIBTORRENT_VERSION=
ARG RTORRENT_REPO=https://github.com/rakshasa/rtorrent
ARG LIBTORRENT_REPO=https://github.com/rakshasa/libtorrent
# What the client calls itself: the HTTP User-Agent rtorrent announces with,
# and the peer id prefix libtorrent gives every peer and tracker. Empty means
# each keeps its own version. Set them together — half an identity is worse
# than none, since a tracker that checks both sees the mismatch.
ARG USER_AGENT=
ARG PEER_NAME=

RUN apk add --no-cache \
      libstdc++ libcurl ncurses-libs zlib openssl xmlrpc-c

# Source patches, applied per repository before configure (apply-<repo>.sh).
# libtorrent's shortens path components that are longer than Linux allows (see
# docker/patches/path_fit.h); rtorrent's sets the announced User-Agent.
COPY docker/patches /tmp/patches

RUN set -eux; \
    apk add --no-cache --virtual .build \
      build-base autoconf automake libtool pkgconf git linux-headers \
      curl curl-dev openssl-dev zlib-dev ncurses-dev xmlrpc-c-dev; \
    # cppunit is deliberately absent: configure would link the test framework
    # into the binaries, which then fail at runtime once the build deps go.
    \
    if [ -z "${LIBTORRENT_VERSION}" ]; then \
      case "${RTORRENT_VERSION}" in \
        0.9.*)  LIBTORRENT_VERSION="$(echo "${RTORRENT_VERSION}" | sed 's/^0\.9\./0.13./')" ;; \
        0.10.*) LIBTORRENT_VERSION="$(echo "${RTORRENT_VERSION}" | sed 's/^0\.10\./0.14./')" ;; \
        *)      LIBTORRENT_VERSION="${RTORRENT_VERSION}" ;; \
      esac; \
    fi; \
    # Private trackers whitelist client versions and refuse anything newer
    # than their list, which surfaces only as a failed announce. A release
    # newer than 0.16.20 therefore presents itself as 0.16.20 unless told
    # otherwise — a rule rather than a list, so a new default release does not
    # start failing announces the day it lands — and older ones present
    # themselves as what they are. The peer id prefix moves with the
    # User-Agent: libtorrent 0.16.20 is -lt1014-. Override with --build-arg
    # USER_AGENT=... and PEER_NAME=... (or make build USER_AGENT=...
    # PEER_NAME=...); to present the real version, pass it and its prefix
    # (from 0.15 on, -lt and then the minor and patch release as two hex
    # digits each: 0.16.24 is -lt1018-).
    if [ -z "${USER_AGENT}" ] && [ -z "${PEER_NAME}" ] && \
       echo "${RTORRENT_VERSION} 0.16.20" | awk '{ \
         split($1, have, "."); split($2, known, "."); \
         for (i = 1; i <= 3; i++) if (have[i] != known[i]) exit !(have[i] + 0 > known[i] + 0); \
         exit 1 }'; then \
      USER_AGENT="rtorrent/0.16.20"; PEER_NAME="-lt1014-"; \
    fi; \
    export USER_AGENT PEER_NAME; \
    echo "building rtorrent ${RTORRENT_VERSION} against libtorrent ${LIBTORRENT_VERSION}"; \
    \
    build() { \
      repo="$1"; tag="$2"; shift 2; \
      mkdir -p /tmp/src && cd /tmp/src; \
      git clone --depth 1 --branch "v${tag}" "${repo}" "$(basename "${repo}")"; \
      cd "$(basename "${repo}")"; \
      if [ -f "/tmp/patches/apply-$(basename "${repo}").sh" ]; then \
        sh "/tmp/patches/apply-$(basename "${repo}").sh"; \
      fi; \
      # 0.9.x/0.13.x ship autogen.sh; 0.15+ expects autoreconf directly.
      if [ -f autogen.sh ]; then ./autogen.sh; else autoreconf -fiv; fi; \
      # Releases before 0.16 relied on headers that newer libstdc++ no longer
      # pulls in transitively; pre-including them keeps old tags buildable on a
      # current toolchain.
      ./configure --prefix=/usr/local --disable-debug \
        CXXFLAGS="${CXXFLAGS:--g -O2} -include algorithm -include cstdint" "$@"; \
      make -j"$(nproc)"; \
      make install; \
      # The GPL asks for its text to go with the binaries.
      install -Dm644 COPYING "/usr/local/share/licenses/$(basename "${repo}")/COPYING"; \
    }; \
    build "${LIBTORRENT_REPO}" "${LIBTORRENT_VERSION}"; \
    ldconfig /usr/local/lib || true; \
    PKG_CONFIG_PATH=/usr/local/lib/pkgconfig \
      build "${RTORRENT_REPO}" "${RTORRENT_VERSION}" --with-xmlrpc-c; \
    \
    strip /usr/local/bin/rtorrent || true; \
    rm -rf /tmp/src /tmp/patches /tmp/path_fit_test; \
    apk del .build
ENV LD_LIBRARY_PATH=/usr/local/lib

# --------------------------------------------------------------------------
# 3. runtime — inherits whichever rtorrent stage was selected
# --------------------------------------------------------------------------
FROM rtorrent AS runtime

RUN apk add --no-cache \
      tini su-exec screen ca-certificates tzdata

COPY --from=server /out/cascade /usr/local/bin/cascade
COPY --from=server /out/licenses /usr/local/share/licenses/cascade/
COPY LICENSE /usr/local/share/licenses/cascade/LICENSE
COPY --from=web /src/web/dist /app/web
# An explicit mode rather than the checkout's: a umask 002 clone would
# otherwise ship group-writable scripts.
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chmod=0755 docker/move-completed.sh /usr/local/bin/cascade-move
COPY --chmod=0755 docker/attach.sh /usr/local/bin/cascade-attach

ENV CASCADE_WEB_ROOT=/app/web \
    RT_DOWNLOAD_DIR=/downloads \
    RT_SESSION_DIR=/config/session \
    RT_WATCH_DIR=/watch \
    RT_SCGI_SOCKET=/run/rtorrent/rpc.socket \
    WEB_PORT=8080 \
    PUID=1000 \
    PGID=1000 \
    TZ=UTC

VOLUME ["/config", "/downloads", "/watch"]
EXPOSE 8080 50000 50000/udp

# The server asks itself: `cascade health` requests /healthz on the address it
# listens on, whatever WEB_BASE_PATH and Basic auth are.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["cascade", "health"]

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
