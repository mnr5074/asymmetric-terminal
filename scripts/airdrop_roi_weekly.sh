#!/usr/bin/env bash
# Weekly Airdrop ROI refresh: re-prices calibration drops, live pool prices and TVL (DefiLlama, free),
# recomputes EV/ROI/saturation into data/airdrop_roi.json (part of the Render snapshot data).
# Seed facts (data/airdrop_roi_seed.json) and X counts (data/airdrop_roi_xcounts.json) are reviewed by hand; their dates are shown in the UI.
# Cron example (Mondays 06:00 PT):  0 6 * * 1  /path/to/repo/scripts/airdrop_roi_weekly.sh
set -euo pipefail
cd "$(dirname "$0")/../research"
python3 airdrops_roi.py --refresh
