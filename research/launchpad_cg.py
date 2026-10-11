#!/usr/bin/env python3
"""Launchpad leaderboard inputs from CoinGecko public categories (zero Nansen/X: guarded get from crash_lab)."""
import json, os
from crash_lab import get, COUNTS
from common import DATA_DIR
CG = 'https://api.coingecko.com/api/v3'; SINCE = os.environ.get('SINCE', '2026-04-11')
cats = ['pump-fun', 'letsbonk-fun-ecosystem', 'believe-app-ecosystem', 'moonshot-ecosystem', 'four-meme-ecosystem', 'zora-ecosystem', 'zora-creator-coins', 'clanker-ecosystem', 'virtuals-protocol-ecosystem', 'robinhood-chain-meme', 'pons-launchpad', 'sun-pump-ecosystem', 'base-meme-coins', 'printr-launchpad', 'metadao-launchpad', 'surge-launchpad', 'yoink-fun-launchpad']
allc = {c['id']: c for c in get(CG + '/coins/categories', gap=6.5)}; out = {}
for c in cats:
    try: rows = get(f'{CG}/coins/markets?vs_currency=usd&category={c}&order=market_cap_desc&per_page=250&page=1', gap=6.5)
    except Exception as e: out[c] = {'error': str(e)[:80]}; continue
    R = []
    for r in rows:
        circ = r.get('circulating_supply') or r.get('total_supply') or 0
        if r.get('ath') and circ: R.append({'sym': r['symbol'].upper(), 'id': r['id'], 'athmc': r['ath'] * circ, 'athd': (r.get('ath_date') or '')[:10], 'mc': r.get('market_cap') or 0, 'vol': r.get('total_volume') or 0, 'atl': r.get('atl'), 'atld': (r.get('atl_date') or '')[:10], 'ath': r['ath'], 'px': r.get('current_price')})
    rec = [x for x in R if x['athd'] >= SINCE]; k = allc.get(c, {})
    out[c] = {'coins': len(R), 'cat_mcap': k.get('market_cap'), 'cat_vol24': k.get('volume_24h'), 'recent_ath_count': len(rec),
              'biggest_recent': max(rec, key=lambda x: x['athmc'], default=None), 'notable_recent_ge10M': sorted([x for x in rec if x['athmc'] >= 10e6], key=lambda x: -x['athmc']),
              'all_time_top': sorted(R, key=lambda x: -x['athmc'])[:5], 'sum_mc': sum(x['mc'] for x in R), 'sum_athmc': sum(x['athmc'] for x in R)}
    print(c, len(R), len(rec), flush=True)
out['_billing'] = {'nansen_calls': 0 if not any('nansen' in h for h in COUNTS) else 'NONZERO', 'x_calls': 0 if not any(h.endswith('x.com') or 'twitter' in h for h in COUNTS) else 'NONZERO', 'hosts': COUNTS}
json.dump(out, open(os.path.join(DATA_DIR, 'launchpad_cg.json'), 'w')); print('done')
