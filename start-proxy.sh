#!/bin/bash
set -e

PROXY_HOST=${PROXY_HOST:-127.0.0.1}
PROXY_PORT=${PROXY_PORT:-8080}
UPSTREAM_PROXY=${UPSTREAM_PROXY:-}

cmd="uv run mitmdump -q -s noshitproxy/proxy/bridge_addon.py --listen-host $PROXY_HOST --listen-port $PROXY_PORT"

if [ -n "$UPSTREAM_PROXY" ]; then
    if [[ "$UPSTREAM_PROXY" == socks* ]]; then
        if ! command -v proxychains4 &> /dev/null; then
            echo "Error: proxychains4 not found. Install it: sudo apt install proxychains4" >&2
            exit 1
        fi

        proxy_type=$(echo "$UPSTREAM_PROXY" | cut -d: -f1)
        proxy_addr=$(echo "$UPSTREAM_PROXY" | sed 's|.*://||' | cut -d: -f1)
        proxy_port=$(echo "$UPSTREAM_PROXY" | sed 's|.*:||')

        conf_file=".run/proxychains.conf"
        mkdir -p .run
        cat > "$conf_file" <<EOF
strict_chain
quiet_mode
localnet 127.0.0.0/255.0.0.0
localnet ::1/128
[ProxyList]
$proxy_type $proxy_addr $proxy_port
EOF
        exec proxychains4 -f "$conf_file" $cmd
    else
        exec $cmd --mode upstream:"$UPSTREAM_PROXY"
    fi
else
    exec $cmd
fi
