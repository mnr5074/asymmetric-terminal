#!/bin/sh
# Keeps the server (and, if TUNNEL=1, a cloudflared quick tunnel) alive; updates PUBLIC_URL.txt.
cd "$(dirname "$0")/.."
CF=${CF:-$HOME/.local/bin/cloudflared}
while true; do
  if ! curl -s -m 5 -o /dev/null http://localhost:8000/api/health; then
    pkill -f "node server.js"; sleep 1
    nohup scripts/run-server.sh >> data/server.log 2>&1 &
    echo "$(date) restarted server" >> watchdog.log
  fi
  if [ "${TUNNEL:-0}" = 1 ] && ! pgrep -f "cloudflared tunnel" > /dev/null; then
    nohup "$CF" tunnel --url http://localhost:8000 > tunnel.log 2>&1 &
    sleep 15
    grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' tunnel.log | head -1 > PUBLIC_URL.txt
    echo "$(date) restarted tunnel $(cat PUBLIC_URL.txt)" >> watchdog.log
  fi
  sleep 20
done
