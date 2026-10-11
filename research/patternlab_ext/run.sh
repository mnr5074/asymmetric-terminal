#!/usr/bin/env bash
# Pattern Lab EXPANSION pipeline (free data + cached Nansen tapes; no paid X, no Grok spend).
# fetch_tape.py spends Nansen credits (1/token, own ledger, cap EXT_NANSEN_CAP=200, floor 300) only for tapes not already cached.
set -e
cd "$(dirname "$0")"
[ "$1" = "--fetch" ] && python3 fetch_tape.py tape
python3 fairvalue_majors.py
python3 rules_38_42.py
python3 cats_gen.py
python3 build.py
python3 gen_md.py
