# Security policy

## Reporting a vulnerability

Please report security problems **privately**, through GitHub's private vulnerability reporting:
[open a draft advisory](https://github.com/JohanLindvall/Cascade/security/advisories/new) (the
*Report a vulnerability* button under the repository's *Security* tab). Do not open a public
issue, pull request or discussion for a vulnerability.

A useful report says:

- the image tag or commit (`docker inspect --format '{{ index .Config.Labels
  "org.opencontainers.image.version" }}' <container>` prints it for a published image), and the
  rtorrent version the UI's header shows;
- how Cascade is reached: directly or behind a reverse proxy, with or without `WEB_USER` and
  `WEB_PASS`, under a `WEB_BASE_PATH`, and the `CASCADE_ALLOW_*` settings;
- the steps that reproduce it and what an attacker gains.

Cascade is maintained by one person, so replies are best effort. The report is answered in the
advisory, the fix ships as a new image, and the advisory is published once that image is out,
crediting you unless you would rather it did not.

## Supported versions

Every push to `main` is a release: it is tagged `v0.1.<n>` and published as
`ghcr.io/johanlindvall/cascade:latest`. Only the newest image is supported — fixes are not
backported to older tags, so update to `latest` (or the newest `v0.1.<n>`) first.

Problems in rtorrent, libtorrent or the Alpine packages themselves belong upstream
([rtorrent](https://github.com/rakshasa/rtorrent), [libtorrent](https://github.com/rakshasa/libtorrent),
[Alpine](https://security.alpinelinux.org/)); a report here is still welcome when the image ships
an affected version and needs a rebuild.

## What Cascade protects, and what it does not

Whoever can reach Cascade's port — and holds the credentials, when `WEB_USER` and `WEB_PASS` are
set — controls the rtorrent behind it. That is by design, and it shapes what counts as a
vulnerability:

- **There is no authentication unless both `WEB_USER` and `WEB_PASS` are set**, and without it
  the network is not the only way in: any web page a visitor opens can reach Cascade through DNS
  rebinding, even on `127.0.0.1`, because the browser then counts that page as Cascade's own
  origin and the cross-site guard has nothing to refuse. Set them even on a machine of your own,
  and put Cascade behind a TLS-terminating reverse proxy or keep the port private: Basic auth
  over plain HTTP can be read by anyone on the network path.
- **Raw RPC is shell access.** The API console and `/RPC2` pass any XML-RPC command to rtorrent,
  including `execute.*`, which runs programs as the user rtorrent runs as (`PUID`) inside the
  container, with its volumes. It is on by default, because existing rtorrent tooling talks to
  `/RPC2`; set `CASCADE_ALLOW_RAW_RPC=0` if nothing needs it.
- **rtorrent's own SCGI socket has no authentication at all.** It is a unix socket inside the
  container (`RT_SCGI_SOCKET`); whoever reaches it has raw RPC without Cascade in the way. When
  `CASCADE_SCGI` points Cascade at an rtorrent elsewhere, that link is unauthenticated SCGI over
  the network.
- **Deleting data is confined** to `RT_DOWNLOAD_DIR`, `RT_COMPLETED_DIR` and
  `CASCADE_DELETE_ROOTS`, as set when the container starts (a default directory changed in the
  settings dialog is not added); `CASCADE_ALLOW_DATA_DELETE=0` forbids it altogether. The check is
  made on the path as bytes on disk, the same bytes that are then deleted: a name rtorrent can only
  report by a stand-in (`%E9` or `?` for a byte that is not UTF-8) is resolved first, and refused
  when it could be more than one path. That covers deletion only: a torrent's directory may be any
  path rtorrent's user can write.
- **Tracker secrets are hidden on screen, not from the API.** The UI masks passkeys and
  credentials in tracker URLs, messages and log lines; the API returns them as rtorrent stores
  them, because clients need them.
- `/healthz` answers without authentication on purpose (container health checks) and reveals
  only whether the server is alive and rtorrent has answered.

So a report is expected behaviour when it achieves no more than an authenticated user — anyone,
when no credentials are set — can already do with the `CASCADE_ALLOW_*` switches as configured
(raw RPC, while it is on, is shell access), or when it needs access to the Docker host. These are
vulnerabilities, and the kind of report this policy is for:

- reaching the API, the stream or `/RPC2` without the configured credentials;
- a page on another origin making a browser change anything — Cascade refuses requests the
  browser marks as cross-site (DNS rebinding with no credentials set is the gap described above);
- deleting files outside `RT_DOWNLOAD_DIR`, `RT_COMPLETED_DIR` and `CASCADE_DELETE_ROOTS`;
- the static file server serving anything outside `CASCADE_WEB_ROOT`, or a dotfile;
- the API returning the contents of a file it is not meant to show (it shows rtorrent's log,
  `RT_LOG_FILE`, and Cascade's own state);
- running rtorrent commands with raw RPC disabled — through a torrent's directory, label, tracker
  URL, an uploaded `.torrent` or any other field;
- a secret the UI shows unmasked, or anything reachable without authentication that should not be;
- crashing rtorrent or the server, or exhausting memory, with input the API accepts.
