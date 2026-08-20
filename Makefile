# Cascade — build, run and test targets.
#
# Everything runs through Docker: no local Node toolchain is required.

IMAGE            ?= cascade
TAG              ?= latest
CONTAINER        ?= cascade
PORT             ?= 8080
PEER_PORT        ?= 50000
DATA             ?= $(CURDIR)/data

# Which rtorrent ends up in the image.
#   ALPINE_VERSION 3.19/3.20 -> 0.9.8 | 3.21 -> 0.10.0 | 3.22 -> 0.15.2
ALPINE_VERSION   ?= 3.21
RTORRENT_FLAVOR  ?= package
RTORRENT_VERSION ?= 0.9.8
LIBTORRENT_VERSION ?=

BUILD_ARGS = --build-arg ALPINE_VERSION=$(ALPINE_VERSION) \
             --build-arg RTORRENT_FLAVOR=$(RTORRENT_FLAVOR) \
             --build-arg RTORRENT_VERSION=$(RTORRENT_VERSION) \
             $(if $(LIBTORRENT_VERSION),--build-arg LIBTORRENT_VERSION=$(LIBTORRENT_VERSION),)

REF = $(IMAGE):$(TAG)

.DEFAULT_GOAL := help
.PHONY: help build build-source matrix run stop logs shell attach rtorrent-log \
        smoke up down clean distclean dev version

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nCascade\n\nUsage: make \033[36m<target>\033[0m [VAR=value]\n\nTargets:\n"} \
	  /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)
	@printf "\nVariables: IMAGE=%s TAG=%s PORT=%s ALPINE_VERSION=%s RTORRENT_FLAVOR=%s\n\n" \
	  "$(IMAGE)" "$(TAG)" "$(PORT)" "$(ALPINE_VERSION)" "$(RTORRENT_FLAVOR)"

##@ Build

build: ## Build the image (also typechecks both TypeScript halves)
	docker build $(BUILD_ARGS) -t $(REF) .

build-source: ## Compile rtorrent from an upstream tag (RTORRENT_VERSION=0.9.8)
	$(MAKE) build RTORRENT_FLAVOR=source TAG=$(RTORRENT_VERSION)-src

matrix: ## Build against every packaged rtorrent version
	@for v in 3.20 3.21 3.22; do \
	  echo "==> alpine $$v"; \
	  docker build --build-arg ALPINE_VERSION=$$v -t $(IMAGE):alpine$$v . || exit 1; \
	done
	@echo "==> built: $(IMAGE):alpine3.20 (0.9.8), alpine3.21 (0.10.0), alpine3.22 (0.15.2)"

##@ Run

run: ## Run the container in the background (PORT=8080)
	@mkdir -p $(DATA)/downloads $(DATA)/config $(DATA)/watch
	docker rm -f $(CONTAINER) >/dev/null 2>&1 || true
	docker run -d --name $(CONTAINER) \
	  -p $(PORT):8080 -p $(PEER_PORT):50000 -p $(PEER_PORT):50000/udp \
	  -v $(DATA)/downloads:/downloads \
	  -v $(DATA)/config:/config \
	  -v $(DATA)/watch:/watch \
	  -e PUID=$(shell id -u) -e PGID=$(shell id -g) \
	  $(REF)
	@echo "Cascade is starting on http://localhost:$(PORT)"

stop: ## Stop and remove the container
	docker rm -f $(CONTAINER) >/dev/null 2>&1 || true

logs: ## Follow the container log
	docker logs -f $(CONTAINER)

rtorrent-log: ## Tail rtorrent's own log
	docker exec $(CONTAINER) tail -n 100 -f /config/rtorrent.log

shell: ## Open a shell inside the container
	docker exec -it $(CONTAINER) sh

attach: ## Attach to rtorrent's curses UI (detach with ctrl-a d)
	docker exec -it $(CONTAINER) sh -c 'SCREENDIR=/run/rtorrent/screen screen -r rtorrent'

up: ## Start via docker compose
	docker compose up -d --build

down: ## Stop the compose stack
	docker compose down

##@ Develop

dev: ## Run the Vite dev server against a running container
	cd web && npm install && npm run dev

version: ## Report which rtorrent the built image contains
	@docker run --rm --entrypoint rtorrent $(REF) -h 2>&1 | head -n1

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

clean: ## Remove containers built from this image
	docker rm -f $(CONTAINER) cascade-smoke >/dev/null 2>&1 || true

distclean: clean ## Also remove the images
	docker rmi -f $(REF) $(IMAGE):alpine3.20 $(IMAGE):alpine3.21 $(IMAGE):alpine3.22 >/dev/null 2>&1 || true
