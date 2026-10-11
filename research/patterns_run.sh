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
