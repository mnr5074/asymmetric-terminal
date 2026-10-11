#!/bin/sh
# DEPRECATED shim: the old loop here did `pkill -f "node server.js"`, which also killed other workers' test servers on other ports.
# It now just runs the PID-exact supervisor (scripts/supervisor.js). Optional TUNNEL=1 keeps the old cloudflared quick-tunnel loop.
cd "$(dirname "$0")/.."
if [ "${TUNNEL:-0}" = 1 ]; then
  CF=${CF:-$HOME/.local/bin/cloudflared}
  ( while true; do
      if ! pgrep -f "cloudflared tunnel --url http://localhost:8000" > /dev/null; then
        nohup "$CF" tunnel --url http://localhost:8000 > tunnel.log 2>&1 &
        sleep 15; grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log | head -1 > PUBLIC_URL.txt
        echo "$(date) restarted tunnel $(cat PUBLIC_URL.txt)" >> watchdog.log
      fi; sleep 20
    done ) &
fi
exec node scripts/supervisor.js
