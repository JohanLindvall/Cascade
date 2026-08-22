# syntax=docker/dockerfile:1
#
# Cascade — a web UI for rtorrent, with rtorrent itself baked into the image.
#
# rtorrent is always compiled from an upstream tag, so the version in the image
# is exactly the one you asked for rather than whatever a distro happens to
# package:
#
#     docker build -t cascade .                                  # 0.16.20
#     docker build --build-arg RTORRENT_VERSION=0.15.2 -t cascade:0.15.2 .
#     docker build --build-arg RTORRENT_VERSION=0.9.8  -t cascade:0.9.8 .
#
# libtorrent is pinned to the matching release automatically (rtorrent 0.9.x
# pairs with libtorrent 0.13.x, 0.10.x with 0.14.x, and from 0.15 onwards the
# two share a version). Override it with LIBTORRENT_VERSION when a pairing is
# unusual, and point RTORRENT_REPO/LIBTORRENT_REPO at a fork if needed.
#
# The web server discovers what the backend supports at runtime (system.list-
# Methods), so one build of the UI drives any of these versions.

ARG ALPINE_VERSION=3.22
ARG NODE_VERSION=22

# --------------------------------------------------------------------------
# 1. build the TypeScript frontend and backend
# --------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /src

COPY web/package.json web/
RUN cd web && npm install --no-audit --no-fund --loglevel=error

COPY server/package.json server/
RUN cd server && npm install --no-audit --no-fund --loglevel=error

COPY web/ web/
COPY server/ server/

RUN cd web && npm run build
RUN cd server && npm run build && npm prune --omit=dev

# --------------------------------------------------------------------------
# 2. compile libtorrent and rtorrent from upstream tags
# --------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION} AS rtorrent
ARG RTORRENT_VERSION=0.16.20
ARG LIBTORRENT_VERSION=
ARG RTORRENT_REPO=https://github.com/rakshasa/rtorrent
ARG LIBTORRENT_REPO=https://github.com/rakshasa/libtorrent

RUN apk add --no-cache \
      libstdc++ libcurl ncurses-libs zlib openssl xmlrpc-c

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
    echo "building rtorrent ${RTORRENT_VERSION} against libtorrent ${LIBTORRENT_VERSION}"; \
    \
    build() { \
      repo="$1"; tag="$2"; shift 2; \
      mkdir -p /tmp/src && cd /tmp/src; \
      git clone --depth 1 --branch "v${tag}" "${repo}" "$(basename "${repo}")"; \
      cd "$(basename "${repo}")"; \
      # 0.9.x/0.13.x ship autogen.sh; 0.15+ expects autoreconf directly.
      if [ -f autogen.sh ]; then ./autogen.sh; else autoreconf -fiv; fi; \
      # Releases before 0.16 relied on headers that newer libstdc++ no longer
      # pulls in transitively; pre-including them keeps old tags buildable on a
      # current toolchain.
      ./configure --prefix=/usr/local --disable-debug \
        CXXFLAGS="${CXXFLAGS:--g -O2} -include algorithm -include cstdint" "$@"; \
      make -j"$(nproc)"; \
      make install; \
    }; \
    build "${LIBTORRENT_REPO}" "${LIBTORRENT_VERSION}"; \
    ldconfig /usr/local/lib || true; \
    PKG_CONFIG_PATH=/usr/local/lib/pkgconfig \
      build "${RTORRENT_REPO}" "${RTORRENT_VERSION}" --with-xmlrpc-c; \
    \
    strip /usr/local/bin/rtorrent || true; \
    rm -rf /tmp/src; \
    apk del .build
ENV LD_LIBRARY_PATH=/usr/local/lib

# --------------------------------------------------------------------------
# 3. runtime — inherits whichever rtorrent stage was selected
# --------------------------------------------------------------------------
FROM rtorrent AS runtime

RUN apk add --no-cache \
      nodejs tini su-exec screen ca-certificates curl tzdata

COPY --from=build /src/server/dist       /app/server
COPY --from=build /src/server/node_modules /app/node_modules
COPY --from=build /src/web/dist          /app/web
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    CASCADE_WEB_ROOT=/app/web \
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

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${WEB_PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
