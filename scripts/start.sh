#!/bin/sh
# Container entrypoint: seed research outputs if the data dir is empty, optionally run the research loop, start the server.
mkdir -p "${DATA_DIR:-/app/data}"
for f in "${SEED_DIR:-/app/seed}"/*.json; do b=$(basename "$f"); [ -f "${DATA_DIR:-/app/data}/$b" ] || cp "$f" "${DATA_DIR:-/app/data}/$b" 2>/dev/null; done
if [ -d "${SEED_DIR:-/app/seed}/birthphase" ]; then mkdir -p "${DATA_DIR:-/app/data}/birthphase"; cp -n "${SEED_DIR:-/app/seed}"/birthphase/*.json "${DATA_DIR:-/app/data}/birthphase/" 2>/dev/null; fi
if [ "${RUN_RESEARCH:-0}" = "1" ]; then
  (cd "$(dirname "$0")/../research" && MAX=${RESEARCH_MAX:-80} SLEEP=${RESEARCH_SLEEP:-3600} sh ./run.sh > "${DATA_DIR:-/app/data}/run.log" 2>&1 &)
fi
exec node server.js
