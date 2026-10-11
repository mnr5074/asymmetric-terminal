#!/bin/sh
# Container entrypoint: seed research outputs if the data dir is empty, optionally run the research loop, start the server.
mkdir -p "${DATA_DIR:-/app/data}"
for f in analysis.json screener.json macro_events.json options.json airdrops.json; do [ -f "${DATA_DIR:-/app/data}/$f" ] || cp "${SEED_DIR:-/app/seed}/$f" "${DATA_DIR:-/app/data}/$f" 2>/dev/null; done
if [ "${RUN_RESEARCH:-0}" = "1" ]; then
  (cd "$(dirname "$0")/../research" && MAX=${RESEARCH_MAX:-80} SLEEP=${RESEARCH_SLEEP:-3600} sh ./run.sh > "${DATA_DIR:-/app/data}/run.log" 2>&1 &)
fi
exec node server.js
