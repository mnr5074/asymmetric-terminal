#!/usr/bin/env python3
"""Base stock-paired launchpads: The Stonks Exchange ($STONKEX, Aerodrome Slipstream pools priced off Chainlink stock feeds) and BaseStonk
($BSTONK, Uniswap v4, also on Robinhood Chain). Finds every pool against Base tokenized stocks (Coinbase 'c' stocks, wt* wrapped stocks) and
the two platform tokens via GeckoTerminal token->pools, then daily closes for the biggest. Pad attribution by DEX is a heuristic
(aerodrome-slipstream -> Stonks Exchange, uniswap-v4 -> BaseStonk). Appends to data/launchpad_extra.json. Zero Nansen/X."""
import json, os, time
from crash_lab import get, COUNTS, log, D
from common import DATA_DIR
GT = 'https://api.geckoterminal.com/api/v2'
SYMS = ['NVDAc', 'GOOGLc', 'AAPLc', 'METAc', 'COINc', 'TSLAc', 'MSTRc', 'wtNVDA', 'wtCOIN', 'wtMSTR', 'wtSPCX', 'STONKEX', 'BSTONK']
def main():
    f = os.path.join(DATA_DIR, 'launchpad_extra.json'); ex = json.load(open(f)); have = {(t['chain'], t['address'].lower()) for t in ex['tokens']}
    anchors = {}
    for s in SYMS:
        try: r = get('https://api.dexscreener.com/latest/dex/search?q=' + s, gap=0.4)
        except Exception: continue
        for p in r.get('pairs') or []:
            if p['chainId'] == 'base' and p['baseToken']['symbol'] == s: anchors[p['baseToken']['address'].lower()] = s
    log('anchors', anchors)
    new = {}; QUOTE = {a.lower() for a in anchors} | {'0x4200000000000000000000000000000000000006', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'}
    for a, s in anchors.items():
        for pg in range(1, 6):
            try: d = get(f'{GT}/networks/base/tokens/{a}/pools?page={pg}&sort=h24_volume_usd_desc', gap=2.2)
            except Exception: break
            ps = d.get('data') or []
            for pl in ps:
                at = pl['attributes']; b = pl['relationships']['base_token']['data']['id'].split('_', 1)[1].lower(); q = pl['relationships']['quote_token']['data']['id'].split('_', 1)[1].lower()
                tok = b if b not in QUOTE else (q if q not in QUOTE else None)
                if not tok or ('base', tok) in have: continue
                dex = pl['relationships']['dex']['data']['id']
                pad = 'stonks-exchange (aerodrome-slipstream)' if 'slipstream' in dex else 'basestonk (uniswap-v4)' if 'v4' in dex else 'base-stock-paired:' + dex
                t = new.setdefault(tok, {'chain': 'base', 'address': tok, 'pad': pad, 'quote': s, 'symbol': at['name'].split(' / ')[0] if b == tok else at['name'].split(' / ')[-1].split(' ')[0], 'pools': []})
                t['pools'].append({'id': at['address'], 'liq': float(at.get('reserve_in_usd') or 0), 'fdv': float(at.get('fdv_usd') or 0) or None, 'created': (at.get('pool_created_at') or '')[:10]})
            if len(ps) < 20: break
    log('stock-paired base tokens', len(new))
    ks = list(new.values())
    for i in range(0, len(ks), 30):
        try: ps = get(f"https://api.dexscreener.com/tokens/v1/base/{','.join(x['address'] for x in ks[i:i + 30])}", gap=0.3) or []
        except Exception: continue
        for p in ps:
            t = new.get(p['baseToken']['address'].lower())
            if t and (p.get('liquidity') or {}).get('usd', 0) >= (t.get('liq_now') or 0): t.update({'price_now': float(p.get('priceUsd') or 0) or None, 'mcap_now': p.get('marketCap') or p.get('fdv'), 'liq_now': (p.get('liquidity') or {}).get('usd')})
    for t in sorted(ks, key=lambda t: -max(t.get('mcap_now') or 0, max([p.get('fdv') or 0 for p in t['pools']] or [0])))[:40]:
        pool = max(t['pools'], key=lambda q: q['liq'])['id']
        try: L = sorted(get(f'{GT}/networks/base/pools/{pool}/ohlcv/day?aggregate=1&limit=180&currency=usd', gap=2.2)['data']['attributes']['ohlcv_list'])
        except Exception: continue
        if len(L) >= 2: t['ohlcv'] = {'dates': [D(c[0]) for c in L], 'closes': [c[4] for c in L], 'truncated_180d': len(L) >= 180}
    ex['tokens'] += ks; ex['stats']['base_stock_paired_tokens'] = len(ks); ex['stats']['base_stock_anchors'] = sorted(set(anchors.values()))
    from collections import Counter; ex['stats']['base_stock_by_pad'] = dict(Counter(t['pad'] for t in ks))
    ex.setdefault('billing', {}).setdefault('hosts', {})
    for h, c in COUNTS.items(): ex['billing']['hosts'][h] = ex['billing']['hosts'].get(h, 0) + c
    json.dump(ex, open(f, 'w')); log('done', ex['stats'].get('base_stock_by_pad'))
if __name__ == '__main__': main()
