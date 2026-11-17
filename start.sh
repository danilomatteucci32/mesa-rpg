#!/bin/bash
# Inicia servidor + túnel público (cloudflared quick tunnel)
cd "$(dirname "$0")"
PORT=${PORT:-3777}
pgrep -f "node server.js" >/dev/null || PORT=$PORT setsid nohup node server.js > server.log 2>&1 < /dev/null &
sleep 1
pgrep -f "cloudflared tunnel --url http://localhost:$PORT" >/dev/null || setsid nohup cloudflared tunnel --url http://localhost:$PORT --no-autoupdate --protocol http2 > tunnel.log 2>&1 < /dev/null &
sleep 8
grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log | head -1
