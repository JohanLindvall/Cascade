# Cascade — build, run and test targets.
#
# Everything runs through Docker: no local Node toolchain is required.

IMAGE            ?= cascade
TAG              ?= latest
CONTAINER        ?= cascade
PORT             ?= 8080
PEER_PORT        ?= 50000
DATA             ?= $(CURDIR)/data

# `make run` opens the UI once it answers. OPEN=0 skips it; BROWSER picks the
# launcher (xdg-open on Linux, open on macOS).
OPEN             ?= 1
BROWSER          ?= xdg-open
URL               = http://localhost:$(PORT)

# rtorrent is always compiled from an upstream tag. The default release is
# the Dockerfile's ARG RTORRENT_VERSION, read from there rather than repeated
# (make bump-rtorrent moves it).
ALPINE_VERSION   ?= 3.22
DEFAULT_RTORRENT := $(shell sed -n 's/^ARG RTORRENT_VERSION=//p' Dockerfile)
RTORRENT_VERSION ?= $(DEFAULT_RTORRENT)
LIBTORRENT_VERSION ?=

# What the client calls itself: USER_AGENT is the HTTP header trackers read,
# PEER_NAME the peer id prefix peers and trackers see. Left empty the
# Dockerfile decides: a release newer than 0.16.20 presents itself as 0.16.20
# (USER_AGENT rtorrent/0.16.20, PEER_NAME -lt1014-), because private trackers
# refuse versions they have not whitelisted yet and say so only as a failed
# announce; older releases present themselves as what they are. Set them
# together — a tracker that checks both sees a mismatch:
#   make build USER_AGENT=rtorrent/0.16.24 PEER_NAME=-lt1018-   # be 0.16.24
#   make build USER_AGENT=rtorrent/0.9.8   PEER_NAME=-lt0D80-
# The prefix: 0.13.8 is -lt0D80-; from 0.15 on it is -lt and the minor and
# patch release as two hex digits each (0.15.2 -lt0F02-, 0.16.20 -lt1014-,
# 0.16.24 -lt1018-).
USER_AGENT       ?=
PEER_NAME        ?=

BUILD_ARGS = --build-arg ALPINE_VERSION=$(ALPINE_VERSION) \
             --build-arg RTORRENT_VERSION=$(RTORRENT_VERSION) \
             $(if $(LIBTORRENT_VERSION),--build-arg LIBTORRENT_VERSION=$(LIBTORRENT_VERSION),) \
             $(if $(USER_AGENT),--build-arg USER_AGENT=$(USER_AGENT),) \
             $(if $(PEER_NAME),--build-arg PEER_NAME=$(PEER_NAME),)

REF = $(IMAGE):$(TAG)

.DEFAULT_GOAL := help
.PHONY: help build matrix bump-rtorrent run open stop logs shell attach \
        rtorrent-log smoke clean distclean dev version

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nCascade\n\nUsage: make \033[36m<target>\033[0m [VAR=value]\n\nTargets:\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)
	@printf "\nVariables: IMAGE=%s TAG=%s PORT=%s RTORRENT_VERSION=%s ALPINE_VERSION=%s OPEN=%s\n" \
	  "$(IMAGE)" "$(TAG)" "$(PORT)" "$(RTORRENT_VERSION)" "$(ALPINE_VERSION)" "$(OPEN)"
	@printf "           USER_AGENT=%s PEER_NAME=%s\n\n" \
	  "$(if $(USER_AGENT),$(USER_AGENT),(past 0.16.20 presents as 0.16.20))" "$(if $(PEER_NAME),$(PEER_NAME),(likewise))"

##@ Build

build: ## Build the image (also typechecks both TypeScript halves)
	docker build $(BUILD_ARGS) -t $(REF) .

matrix: ## Build the rtorrent versions the UI is tested against
	@for v in 0.9.8 0.15.2 $(DEFAULT_RTORRENT); do \
	  echo "==> rtorrent $$v"; \
	  docker build --build-arg RTORRENT_VERSION=$$v -t $(IMAGE):$$v . || exit 1; \
	done
	@echo "==> built: $(IMAGE):0.9.8 $(IMAGE):0.15.2 $(IMAGE):$(DEFAULT_RTORRENT)"

bump-rtorrent: ## Move the default rtorrent to the newest upstream release (TO=x.y.z for another)
	@docker/bump-rtorrent.sh $(TO)

##@ Run

run: stop ## Run the container in the background and open it (PORT=8080, OPEN=0 to skip)
	@mkdir -p $(DATA)/downloads $(DATA)/config $(DATA)/watch
	docker run -d --name $(CONTAINER) \
	  -p $(PORT):8080 -p $(PEER_PORT):50000 -p $(PEER_PORT):50000/udp \
	  -v $(DATA)/downloads:/downloads \
	  -v $(DATA)/config:/config \
	  -v $(DATA)/watch:/watch \
	  -e PUID=$(shell id -u) -e PGID=$(shell id -g) \
	  $(REF)
	@if [ "$(OPEN)" = "1" ]; then $(MAKE) --no-print-directory open; \
	 else echo "Cascade is starting on $(URL)"; fi

open: ## Wait for Cascade to answer, then open it in a browser
	@printf 'waiting for Cascade on $(URL)'
	@ready=0; \
	for i in $$(seq 1 60); do \
	  if curl -fsS $(URL)/healthz >/dev/null 2>&1; then ready=1; break; fi; \
	  if [ -n "$$(docker ps -aq --filter name=^$(CONTAINER)$$ --filter status=exited)" ]; then \
	    printf '\n'; echo "container exited — last lines:"; docker logs --tail 15 $(CONTAINER); exit 1; \
	  fi; \
	  printf '.'; sleep 1; \
	done; \
	printf '\n'; \
	if [ "$$ready" != "1" ]; then \
	  echo "Cascade did not answer in 60s; last lines:"; docker logs --tail 15 $(CONTAINER); exit 1; \
	fi; \
	if [ -z "$$DISPLAY$$WAYLAND_DISPLAY" ] && [ "$$(uname)" != "Darwin" ]; then \
	  echo "no display detected — browse to $(URL)"; \
	elif command -v $(BROWSER) >/dev/null 2>&1; then \
	  echo "opening $(URL)"; $(BROWSER) $(URL) >/dev/null 2>&1 & \
	elif command -v open >/dev/null 2>&1; then \
	  echo "opening $(URL)"; open $(URL) >/dev/null 2>&1 & \
	else \
	  echo "no $(BROWSER) on PATH — browse to $(URL)"; \
	fi

stop: ## Stop and remove the container
	@# SIGTERM rather than SIGKILL: the entrypoint shuts rtorrent down cleanly,
	@# which releases the session lock. A killed rtorrent leaves it behind.
	@docker stop -t 20 $(CONTAINER) >/dev/null 2>&1 || true
	@docker rm -f $(CONTAINER) >/dev/null 2>&1 || true

logs: ## Follow the container log
	docker logs -f $(CONTAINER)

rtorrent-log: ## Tail rtorrent's own log
	docker exec $(CONTAINER) tail -n 100 -f /config/rtorrent.log

shell: ## Open a shell inside the container
	docker exec -it $(CONTAINER) sh

attach: ## Attach to rtorrent's curses UI (detach with ctrl-a d)
	docker exec -it $(CONTAINER) sh -c 'SCREENDIR=/run/rtorrent/screen screen -r rtorrent'

##@ Develop

dev: ## Run the Vite dev server against a running container
	cd web && npm install && npm run dev

version: ## Report which rtorrent the built image contains, and how it presents itself
	@docker run --rm --entrypoint rtorrent $(REF) -h 2>&1 | head -n1
	@printf 'announces as : '; docker run --rm --entrypoint sh $(REF) -c \
	  'strings /usr/local/bin/rtorrent | grep -oE "^rtorrent/[0-9][0-9.]*" | head -n1'
	@printf 'peer id      : '; docker run --rm --entrypoint sh $(REF) -c \
	  'strings /usr/local/lib/libtorrent.so 2>/dev/null | grep -oE "^-[A-Za-z]{2}[0-9A-Za-z]{4}-" | head -n1'

smoke: ## Build, boot, exercise the API, then tear down
	@$(MAKE) --no-print-directory build
	@docker rm -f cascade-smoke >/dev/null 2>&1 || true
	@docker run -d --name cascade-smoke -p 18999:8080 -e RT_DHT=off $(REF) >/dev/null
	@echo "waiting for rtorrent..."
	@for i in $$(seq 1 30); do \
	  curl -fsS http://127.0.0.1:18999/healthz >/dev/null 2>&1 && break; sleep 1; \
	done
	@printf 'healthz      : '; curl -fsS http://127.0.0.1:18999/healthz || exit 1; echo
	@printf 'backend      : '; curl -fsS http://127.0.0.1:18999/api/capabilities \
	  | sed 's/.*"clientVersion":"\([^"]*\)".*"flavor":"\([^"]*\)".*/\1 (\2)/' | tr -d '\n'; echo
	@printf 'settings read: '; curl -fsS http://127.0.0.1:18999/api/settings >/dev/null && echo ok || exit 1
	@printf 'state read   : '; curl -fsS http://127.0.0.1:18999/api/state >/dev/null && echo ok || exit 1
	@printf 'xml-rpc /RPC2: '; curl -fsS -X POST http://127.0.0.1:18999/RPC2 -H 'content-type: text/xml' \
	  --data '<?xml version="1.0"?><methodCall><methodName>system.client_version</methodName></methodCall>' \
	  | grep -o '<string>[^<]*</string>' || exit 1
	@printf 'ui served    : '; curl -fsS http://127.0.0.1:18999/ | grep -o '<title>[^<]*</title>' || exit 1
	@docker rm -f cascade-smoke >/dev/null
	@echo "smoke test passed"

##@ Clean

clean: stop ## Remove containers built from this image
	@docker rm -f cascade-smoke >/dev/null 2>&1 || true

distclean: clean ## Also remove the images
	docker rmi -f $(REF) $(IMAGE):0.9.8 $(IMAGE):0.15.2 $(IMAGE):$(DEFAULT_RTORRENT) >/dev/null 2>&1 || true
