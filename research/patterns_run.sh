#!/bin/sh
# Rebuild all pattern detectors (free data only; NANSEN_API_KEY / X_BEARER_TOKEN stripped).
cd "$(dirname "$0")"
env -u NANSEN_API_KEY -u X_BEARER_TOKEN python3 patterns_hours.py && \
env -u NANSEN_API_KEY -u X_BEARER_TOKEN python3 patterns_stocks.py
env -u NANSEN_API_KEY -u X_BEARER_TOKEN python3 patterns_wallets.py backtest 30
env -u NANSEN_API_KEY -u X_BEARER_TOKEN python3 patterns_flows.py backtest 30 20
# live passes (re-run every ~30 min for fresh flags)
env -u NANSEN_API_KEY -u X_BEARER_TOKEN python3 patterns_wallets.py live 10
env -u NANSEN_API_KEY -u X_BEARER_TOKEN python3 patterns_flows.py live 8
# detectors 7-9 backtest uses Nansen (separate ledger data/patterns_nansen_ledger_extra.json, soft cap PATTERNS_EXTRA_MAX=100 cumulative):
#   python3 patterns_extra.py backtest && python3 patterns_extra.py control
# periodic live passes (2, 3/5, 6, 7, 9; free only): setsid nohup ./patterns_live_loop.sh &   (pid in data/patterns_live_loop.pid)
