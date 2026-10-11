#!/usr/bin/env bash
# Periodic research refresh: gather+enrich (incremental, all research chains), analyze, live screener, macro event study.
cd "$(dirname "$0")"
while true; do
  python3 collect.py --chains ${CHAINS:-all} --max ${MAX:-150} --workers 2 >> "${DATA_DIR:-../data}/collect.log" 2>&1
  python3 analyze.py > "${DATA_DIR:-../data}/analyze.log" 2>&1
  python3 screener.py > "${DATA_DIR:-../data}/screener.log" 2>&1
  python3 macro_events.py > "${DATA_DIR:-../data}/macro_events.log" 2>&1
  sleep ${SLEEP:-1800}
done
