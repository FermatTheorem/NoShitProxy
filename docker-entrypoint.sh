#!/bin/bash
set -e

mkdir -p /app/data
mkdir -p /root/.mitmproxy

uv run uvicorn noshitproxy.backend.app:app --host "$BACKEND_HOST" --port "$BACKEND_PORT" &
BACKEND_PID=$!

PYTHONPATH=/app ./start-proxy.sh &
PROXY_PID=$!

trap "kill $BACKEND_PID $PROXY_PID 2>/dev/null || true" EXIT TERM INT

wait
