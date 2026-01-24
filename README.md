# NoShitProxy

Lightweight HTTP(S) interception web UI proxy with no shit.

## Quick Start (Docker)

```bash
# Start everything
make up

# Show container info
make status

# Show logs
make logs

# Stop everything
make down
```

Web UI: http://127.0.0.1:8000

Proxy address: http://127.0.0.1:8080

CA certificates: http://mitm.it (open with proxy enabled)

### With Upstream Proxy (SOCKS5/HTTP)

Route traffic through another proxy:

```bash
# SOCKS5 (e.g., SSH tunnel)
UPSTREAM_PROXY=socks5://127.0.0.1:1080 make up

# HTTP proxy
UPSTREAM_PROXY=http://proxy.example.com:8080 make up
```

## Data Persistence

When using Docker, the following data is persisted across container restarts:
- **Database**: `./data/noshitproxy.sqlite3` - Request history and settings
- **Certificates**: `./mitmproxy-certs/` - mitmproxy CA certificates

You only need to install the CA certificate in your browser once. All request history is preserved between restarts.

## License

MIT License. See `LICENSE`.
