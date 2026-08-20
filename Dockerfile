# syntax=docker/dockerfile:1
#
# Cascade — a web UI for rtorrent, with rtorrent itself baked into the image.
#
# Choosing the rtorrent version at build time
# -------------------------------------------
#   Distro packages (fast, no compiler, the default). ALPINE_VERSION picks it:
#     3.19 / 3.20  ->  rtorrent 0.9.8  + libtorrent 0.13.8
#     3.21         ->  rtorrent 0.10.0 + libtorrent 0.14.0
#     3.22         ->  rtorrent 0.15.2 + libtorrent 0.15.2
#
#     docker build --build-arg ALPINE_VERSION=3.22 -t cascade:0.15 .
#
#   Any upstream tag, compiled from source:
#     docker build --build-arg RTORRENT_FLAVOR=source \
#                  --build-arg RTORRENT_VERSION=0.9.8 \
#                  --build-arg LIBTORRENT_VERSION=0.13.8 -t cascade:0.9.8 .
#
# The web server discovers what the backend supports at runtime (system.list-
# Methods), so a single build of the UI drives any of these versions.

ARG ALPINE_VERSION=3.21
ARG NODE_VERSION=22
ARG RTORRENT_FLAVOR=package

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
# 2a. rtorrent from the alpine package repository (default)
# --------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION} AS rtorrent-package
ARG RTORRENT_APK_VERSION=
RUN apk add --no-cache "rtorrent${RTORRENT_APK_VERSION:+=$RTORRENT_APK_VERSION}"

# --------------------------------------------------------------------------
# 2b. rtorrent compiled from an upstream tag
# --------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION} AS rtorrent-source
ARG RTORRENT_VERSION=0.9.8
ARG LIBTORRENT_VERSION=
ARG RTORRENT_REPO=https://github.com/rakshasa/rtorrent
ARG LIBTORRENT_REPO=https://github.com/rakshasa/libtorrent

RUN apk add --no-cache \
      libstdc++ libcurl ncurses-libs zlib openssl xmlrpc-c

RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    set -eux; \
    apk add --no-cache --virtual .build \
      build-base autoconf automake libtool pkgconf cmake git linux-headers \
      curl curl-dev openssl-dev zlib-dev ncurses-dev xmlrpc-c-dev; \
    # cppunit is deliberately absent: configure would link the test framework
    # into the binaries, which then fail at runtime once the build deps go.
    \
    # libtorrent and rtorrent version numbers track each other:
    #   rtorrent 0.9.x -> libtorrent 0.13.x, 0.10.x -> 0.14.x, 0.15.x -> 0.15.x
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
      if [ -f autogen.sh ]; then \
        ./autogen.sh; \
        ./configure --prefix=/usr/local --disable-debug "$@"; \
        make -j"$(nproc)"; \
        make install; \
      else \
        cmake -B build -DCMAKE_INSTALL_PREFIX=/usr/local -DCMAKE_BUILD_TYPE=Release "$@"; \
        cmake --build build -j"$(nproc)"; \
        cmake --install build; \
      fi; \
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
FROM rtorrent-${RTORRENT_FLAVOR} AS runtime

RUN apk add --no-cache \
      nodejs tini su-exec screen ca-certificates curl tzdata

COPY --from=build /src/server/dist       /app/server
COPY --from=build /src/server/node_modules /app/node_modules
COPY --from=build /src/web/dist          /app/web
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    RTWEB_WEB_ROOT=/app/web \
    RT_DOWNLOAD_DIR=/downloads \
    RT_SESSION_DIR=/config/session \
    RT_WATCH_DIR=/watch \
    RT_SCGI_SOCKET=/run/rtorrent/rpc.socket \
    WEB_PORT=8080 \
    PUID=1000 \
    PGID=1000 \
    TZ=UTC

VOLUME ["/config", "/downloads", "/watch"]
EXPOSE 8080 50000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${WEB_PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
