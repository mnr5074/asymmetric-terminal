#!/bin/sh
# Periodic live passes for pattern detectors 2, 3/5, 6, 7, 9 (free data only: Nansen/X keys stripped, so no recurring credit spend).
# Start:  setsid nohup research/patterns_live_loop.sh >/dev/null 2>&1 &   Stop: kill $(cat data/patterns_live_loop.pid)
# Interval: PATTERNS_LIVE_EVERY seconds (default 1800). Passes run sequentially to stay under public RPC rate limits.
cd "$(dirname "$0")"
echo $$ > ../data/patterns_live_loop.pid
EVERY=${PATTERNS_LIVE_EVERY:-1800}
while true; do
  T0=$(date +%s)
  echo "$(date -u +%FT%TZ) pass start" >> ../data/patterns_live_loop.log
  env -u NANSEN_API_KEY -u X_BEARER_TOKEN timeout 900 python3 patterns_wallets.py live 10 >> ../data/patterns_live_loop.log 2>&1
  env -u NANSEN_API_KEY -u X_BEARER_TOKEN timeout 900 python3 patterns_flows.py live 8   >> ../data/patterns_live_loop.log 2>&1
  env -u NANSEN_API_KEY -u X_BEARER_TOKEN timeout 900 python3 patterns_aging.py live 6   >> ../data/patterns_live_loop.log 2>&1
  env -u NANSEN_API_KEY -u X_BEARER_TOKEN PATTERNS_EXTRA_LIVE_KEEP_CONC=1 timeout 900 python3 patterns_extra.py live 8 0 >> ../data/patterns_live_loop.log 2>&1
  echo "$(date -u +%FT%TZ) pass done in $(( $(date +%s) - T0 ))s" >> ../data/patterns_live_loop.log
  tail -n 4000 ../data/patterns_live_loop.log > ../data/patterns_live_loop.log.tmp && mv ../data/patterns_live_loop.log.tmp ../data/patterns_live_loop.log
  S=$(( EVERY - ($(date +%s) - T0) )); [ $S -lt 60 ] && S=60; sleep $S
done
