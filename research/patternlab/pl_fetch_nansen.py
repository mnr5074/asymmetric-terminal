#!/usr/bin/env python3
"""Fetch (and cache) Nansen TGM dex-trades for the 50-token test set. 1 credit per call (quoted cost checked per call).
 tape  : all DEX trades from created-1h, ascending, first 1000 rows (launch/early tape: snipers, bundles, copy clusters, wash, sandwiches)
 sm    : only_smart_money=true, [created-1h, peak+3d] (smart-money entries/exits: patterns #1, #2)
 sells : all SELL trades in [peak-12h, peak+12h] by value desc (labelled-wallet exits around the top: pattern #1 broad)
Usage: pl_fetch_nansen.py tape|sm|sells [run_cap]"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plcommon as P

def body(kind, t):
    c = t['created_t'] or t['peak_t'] - 86400
    if kind == 'tape':
        return {'chain': 'solana', 'token_address': t['mint'], 'only_smart_money': False, 'date': {'from': P.iso(c - 3600), 'to': P.iso(t['peak_t'] + 3 * 86400)},
                'pagination': {'page': 1, 'per_page': 1000}, 'order_by': [{'field': 'block_timestamp', 'direction': 'ASC'}]}
    if kind == 'sm':
        return {'chain': 'solana', 'token_address': t['mint'], 'only_smart_money': True, 'date': {'from': P.iso(c - 3600), 'to': P.iso(t['peak_t'] + 3 * 86400)},
                'pagination': {'page': 1, 'per_page': 1000}, 'order_by': [{'field': 'block_timestamp', 'direction': 'ASC'}]}
    if kind == 'sells':
        return {'chain': 'solana', 'token_address': t['mint'], 'only_smart_money': False, 'date': {'from': P.iso(max(c - 3600, t['peak_t'] - 12 * 3600)), 'to': P.iso(t['peak_t'] + 12 * 3600)},
                'filters': {'action': 'SELL'}, 'pagination': {'page': 1, 'per_page': 1000}, 'order_by': [{'field': 'estimated_value_usd', 'direction': 'DESC'}]}

def get(kind, t, cap=0):
    """cache-only when cap=0 (raises NansenStop on miss)."""
    return P.nansen('tgm/dex-trades', body(kind, t), cap, kind)

if __name__ == '__main__':
    kind = sys.argv[1]; cap = float(sys.argv[2]) if len(sys.argv) > 2 else 55
    P.balance(); P.log('balance start', P.NL['remaining'])
    for t in P.test_set():
        try:
            j = get(kind, t, cap)
            n = len((j or {}).get('data') or []) if isinstance(j, dict) else None
            P.log(kind, t['cohort'], t['symbol'], 'rows', n, (j or {}).get('_error'))
        except P.NansenStop as e: P.log('STOP', e); break
    P.balance(); P.log('balance end', P.NL['remaining'], 'run used', P.RUN['used'])
