#!/usr/bin/env python3
"""Fetch Nansen TGM dex-trades 'tape' (first 1000 DEX trades from creation, ascending) for the core50 test set, using the exact
same request body as research/patternlab/pl_fetch_nansen.py so both workers share one cache entry (1 credit/call, own ledger).
Iterates in reverse order to avoid colliding with the Pattern Lab worker's forward pass. Usage: fetch_tape.py [tape|sells]"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extcommon as E
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'patternlab'))
import pl_fetch_nansen as F
kind = sys.argv[1] if len(sys.argv) > 1 else 'tape'
E.log('balance start', E.nbalance())
for t in reversed(E.core50()):
    try:
        j = E.nansen('tgm/dex-trades', F.body(kind, t), purpose='ext-' + kind)
        n = len((j or {}).get('data') or []) if isinstance(j, dict) else None
        E.log(kind, t['cohort'], t['symbol'], 'rows', n, (j or {}).get('_error'))
    except E.NansenStop as e: E.log('STOP', e); break
E.log('balance end', E.NL['remaining'], 'ext used total', E.NL['used'])
