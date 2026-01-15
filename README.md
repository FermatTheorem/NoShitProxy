# NoShitProxy

Lightweight HTTP(S) interception web UI proxy with no shit.

## Requirements

- Python (see `.python-version`)
- `uv`

## Quick start

Start backend + proxy (in background):

```bash
make up
```

Check status / PIDs:

```bash
make status
```

Stop everything:

```bash
make down
```

Open the UI:

- `http://127.0.0.1:8000/`

Proxy address:

- `http://127.0.0.1:8080`

Open this link with proxy to install ca certificates:

- `http://mitm.it/`

## License

MIT License. See `LICENSE`.
