# Contributing to Cascade

You can help with bug reports, documentation, accessibility, UI design or code. Small,
focused changes are welcome. For a substantial feature, open an issue describing the problem
first so we can discuss the scope before you spend time implementing it.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). For installation questions, see
[Support](SUPPORT.md); report vulnerabilities through the private path in [SECURITY.md](SECURITY.md).

## Pick a starting point

- Try the [live demo](https://johanlindvall.github.io/Cascade/) and report a confusing interaction.
- Improve a setup instruction you had trouble following.
- Look through [good first issues](https://github.com/JohanLindvall/Cascade/labels/good%20first%20issue)
  and [help wanted](https://github.com/JohanLindvall/Cascade/labels/help%20wanted).
- Reproduce an existing bug and add the version, steps and results to its issue.

You can submit a small fix directly. If you pick up a larger issue, a comment saying what you
plan to work on helps avoid duplicated effort. Labels are suggestions, not a prerequisite.

## Get the code

Fork the repository on GitHub, then clone your fork and create a branch:

```bash
git clone https://github.com/YOUR-USERNAME/Cascade.git
cd Cascade
git remote add upstream https://github.com/JohanLindvall/Cascade.git
git switch -c fix/describe-your-change
```

The [Dockerfile](Dockerfile) defines the Go and Node versions used by CI. Docker runs the build
and test toolchains, so you do not need either installed locally for the full application.
The Makefile needs `make`; `make help` lists its commands.

## Work on the UI without rtorrent

With the Dockerfile's Node version installed:

```bash
make demo
```

Open <http://localhost:5173>. This starts the real UI with simulated torrents, live updates and
API responses in the browser. It needs no Docker container, tracker or real download. Changes
to the UI reload while you work.

Without local Node, run the same demo in Docker from the repository root:

```bash
docker run --rm -it --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -p 127.0.0.1:5173:5173 -v "$PWD:/src" -w /src/web \
  "node:$(sed -n 's/^ARG NODE_VERSION=//p' Dockerfile)-alpine" \
  sh -c 'npm ci && npm run dev:demo -- --host 0.0.0.0'
```

The demo is useful for UI work. Backend behaviour needs a real rtorrent too.

## Work on the full application

Build a local image, then run it with the repository's Compose setup:

```bash
make build
cp .env.example .env
```

Set your own `WEB_PASS` and `CASCADE_IMAGE=cascade:latest` in `.env`, then:

```bash
mkdir -p data/config data/downloads data/watch
docker compose up -d
```

Open <http://localhost:8080>. Use a disposable data directory for development; the default is
`./data`. After rebuilding the image, `docker compose up -d` recreates the service with it.
`docker compose down` stops and removes the service while keeping those bind-mounted files.

For frontend live reload against that container, `make dev` serves the UI on port 5173 and
proxies `/api` to port 8080. It needs local Node. `CASCADE_DEV_TARGET` selects another backend;
the browser uses the backend's Basic-auth credentials.

## Find the right code

| Area | Start here |
| --- | --- |
| React UI and shared components | `web/src/App.tsx`, `web/src/app/`, `web/src/components/` |
| Themes and responsive layout | `web/src/styles.css`, `web/src/theme.ts` |
| HTTP routes and contracts | `server/internal/httpapi/`, `server/internal/contracts/`, `web/src/contracts.ts` |
| Application behaviour | `server/internal/service/` |
| rtorrent commands and compatibility | `server/internal/rtorrent/` |
| Container configuration and lifecycle | `docker/entrypoint.sh`, `server/internal/options/` |
| Browser demo | `web/src/demo/` |

[AGENTS.md](AGENTS.md) explains the architecture and the rtorrent behaviours that constrain it.
Read the relevant section before changing commands, paths, settings or lifecycle operations.

## Check your change

| Change | Checks |
| --- | --- |
| Documentation | Preview Markdown, follow the links, and try any changed commands |
| Go, web or container code | `make test` runs Go vet/tests, web tests/build and shell tests in Docker |
| Go concurrency or state | `make race` |
| UI, CSS or interaction | Inspect desktop and 390px layouts; use the keyboard and check the affected themes |
| API, settings or rtorrent behaviour | `make smoke` and `make smoke RTORRENT_VERSION=0.9.8` |

`make smoke` needs Python 3 and Docker. It builds and exercises a disposable container, then
removes it. Check backend changes against the oldest supported rtorrent and the default;
`make matrix` also builds the intermediate compatibility version.

For a focused web change, run `npm test`, `npm run build` and `npm run build:demo` in `web/`.
CI builds the demo as well as the production UI. Tests use Node's built-in runner and live next
to the code; pure logic belongs in `.ts` modules that the runner can import.

Keep these paired parts in step:

- Changed routes, contracts or stream behaviour need the same change in `web/src/demo/`.
- UI preferences are mirrored in Go and `web/src/preferences.ts`.
- Environment options live in `server/internal/options/options.go`. Regenerate the README's
  marked regions with `go run . options-docs --write` from `server/`, and update its golden files
  with `go test ./internal/options -update`. Do not edit those README regions by hand.
- Format Go with `gofmt`. Match the surrounding TypeScript and shell style. New source files
  need an `SPDX-License-Identifier: MIT` comment, as described in [AGENTS.md](AGENTS.md).

Keep runtime dependencies small: React and React DOM in the browser, and the existing Go
dependencies on the server. Explain the need before adding another.

## Open a pull request

Push your branch to your fork and open a pull request against `main`. Describe the problem,
the resulting behaviour and how you checked it. Link any related issue; include screenshots
for visual changes and note checks you could not run. A draft is welcome for work in progress.

Keep unrelated cleanup separate so the change is easy to review. A bug fix should include a
regression test where practical. Reviews are best effort; there is no response-time guarantee.
Contributions are made under the project's [MIT License](LICENSE).
