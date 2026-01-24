SRC = noshitproxy
RUN_DIR = .run

BACKEND_HOST = 127.0.0.1
BACKEND_PORT = 8000
PROXY_HOST = 127.0.0.1
PROXY_PORT = 8080
UPSTREAM_PROXY ?=

BACKEND_PID = $(RUN_DIR)/backend.pid
PROXY_PID = $(RUN_DIR)/proxy.pid
BACKEND_LOG = $(RUN_DIR)/backend.log
PROXY_LOG = $(RUN_DIR)/proxy.log

.PHONY: help
help:
	@sed -n 's/:.*  #''# /#/p' $(MAKEFILE_LIST) | column -s'#' -t

.PHONY: check
check:  ## Run static code checkers (linter, formatter, type checker)
	uv run mypy --no-error-summary $(SRC)
	uv run ruff check $(SRC)
	uv run ruff format --check $(SRC)

.PHONY: fmt
fmt:  ## Automatically re-format the code
	uv run ruff check --select I --fix $(SRC)
	uv run ruff format $(SRC)

.PHONY: up
up:  ## Start backend and proxy in Docker
	@UPSTREAM_PROXY="$(UPSTREAM_PROXY)" docker compose up -d

.PHONY: down
down:  ## Stop Docker services
	@docker compose down

.PHONY: status
status:  ## Show Docker container status
	@docker compose ps

.PHONY: logs
logs:  ## Show Docker logs
	@docker compose logs -f

.PHONY: run
run: up  ## Alias for up

.PHONY: up-local
up-local:  ## Start backend and proxy locally (no Docker)
	@mkdir -p $(RUN_DIR)
	@$(MAKE) _start-backend
	@$(MAKE) _start-proxy
	@$(MAKE) status-local

.PHONY: down-local
down-local:  ## Stop local services
	@$(MAKE) _stop-proxy
	@$(MAKE) _stop-backend

.PHONY: status-local
status-local:  ## Show running PIDs for local services
	@sh -c 'if [ -f "$(BACKEND_PID)" ] && kill -0 "$$(cat "$(BACKEND_PID)")" 2>/dev/null; then echo "backend: $$(cat "$(BACKEND_PID)") (http://$(BACKEND_HOST):$(BACKEND_PORT))"; else echo "backend: stopped"; fi'
	@sh -c 'if [ -f "$(PROXY_PID)" ] && kill -0 "$$(cat "$(PROXY_PID)")" 2>/dev/null; then echo "proxy:   $$(cat "$(PROXY_PID)") ($(PROXY_HOST):$(PROXY_PORT))"; else echo "proxy:   stopped"; fi'
	@echo "logs:    $(BACKEND_LOG) $(PROXY_LOG)"

.PHONY: _start-backend
_start-backend:
	@sh -c 'pidfile="$(BACKEND_PID)"; logfile="$(BACKEND_LOG)"; if [ -f "$$pidfile" ] && kill -0 "$$(cat "$$pidfile")" 2>/dev/null; then echo "backend already running: $$(cat "$$pidfile")"; exit 1; fi; rm -f "$$pidfile"; uv run uvicorn noshitproxy.backend.app:app --host $(BACKEND_HOST) --port $(BACKEND_PORT) > "$$logfile" 2>&1 & echo $$! > "$$pidfile"'

.PHONY: _start-proxy
_start-proxy:
	@sh -c 'pidfile="$(PROXY_PID)"; logfile="$(PROXY_LOG)"; if [ -f "$$pidfile" ] && kill -0 "$$(cat "$$pidfile")" 2>/dev/null; then echo "proxy already running: $$(cat "$$pidfile")"; exit 1; fi; rm -f "$$pidfile"; PYTHONPATH="$(CURDIR)" PROXY_HOST=$(PROXY_HOST) PROXY_PORT=$(PROXY_PORT) UPSTREAM_PROXY="$(UPSTREAM_PROXY)" ./start-proxy.sh > "$$logfile" 2>&1 & echo $$! > "$$pidfile"'

.PHONY: _stop-backend
_stop-backend:
	@sh -c 'pidfile="$(BACKEND_PID)"; if [ ! -f "$$pidfile" ]; then exit 0; fi; pid="$$(cat "$$pidfile")"; rm -f "$$pidfile"; if kill -0 "$$pid" 2>/dev/null; then kill "$$pid" 2>/dev/null || true; fi'

.PHONY: _stop-proxy
_stop-proxy:
	@sh -c 'pidfile="$(PROXY_PID)"; if [ ! -f "$$pidfile" ]; then exit 0; fi; pid="$$(cat "$$pidfile")"; rm -f "$$pidfile"; if kill -0 "$$pid" 2>/dev/null; then kill "$$pid" 2>/dev/null || true; fi'
