#!/usr/bin/env python3
"""Summarize data/nansen_crash_raw.json (approved Nansen crash forensics) -> data/nansen_crash.json. No API calls."""
import json, re, os, datetime as dt
from common import DATA_DIR
R = json.load(open(os.path.join(DATA_DIR, 'nansen_crash_raw.json')))
SUP = {'LAB': 1e9, 'VELVET': 1e9, 'SIREN': 723454942.95, 'ALLINU': None, 'STONK': None, 'ANSEM': 997360745.15}
CEX = re.compile(r'binance|bybit|okx|okex|gate|bitget|mexc|kucoin|coinbase|htx|huobi|kraken|bingx|lbank|xt\.com|bitmart|upbit|crypto\.com|weex|phemex|blofin|hyperliquid|exchange|deposit|hot wallet|cex', re.I)
def cat(l):
    l = l or ''
    if CEX.search(l): return 'CEX'
    if re.search(r'mev|bot|sniper|arbitrage', l, re.I): return 'bot/MEV'
    if re.search(r'smart|fund|capital|ventures|labs?\b|research', l, re.I): return 'smart money/fund'
    if re.search(r'deployer|creator|dev\b|team|treasury|vesting|multisig|safe', l, re.I): return 'team/deployer/multisig'
    if re.search(r'burn', l, re.I): return 'burn'
    if re.search(r'pool|pair|lp|router|dex|raydium|meteora|pancake|uniswap|pump', l, re.I): return 'DEX/pool'
    if re.search(r'whale', l, re.I): return 'whale'
    if re.search(r'\[', l) and not re.search(r'[a-z]{3,}', re.sub(r'\[.*?\]', '', l), re.I): return 'unlabeled'
    return 'other labeled'
def exch(l):
    m = re.search(r'(binance|bybit|okx|gate|bitget|mexc|kucoin|coinbase|htx|huobi|kraken|bingx|lbank|bitmart|upbit|weex|phemex|blofin)', l or '', re.I); return m.group(1).title() if m else ('CEX (unnamed)' if CEX.search(l or '') else None)
def series(sym):
    cid = {'LAB': 'lab', 'VELVET': 'velvet', 'SIREN': 'siren-2', 'ANSEM': 'the-black-bull'}.get(sym)
    if not cid: return {}
    d = json.load(open(os.path.join(DATA_DIR, 'cg_series', cid + '.json')))
    return {dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).date().isoformat(): p for t, p in d['prices']}
out = {'accountBefore': R.get('accountBefore'), 'accountAfter': R.get('accountAfter'), 'creditsUsed': R.get('creditsUsedByHeaders'), 'tokens': {}}
for sym, t in R['tokens'].items():
    S = (t['sellers'].get('data') or {}).get('data') or []; X = (t['transfers'].get('data') or {}).get('data') or []
    sup = SUP.get(sym); px = series(sym)
    sellers = []
    for s in S[:12]:
        net = (s.get('sold_token_volume') or 0) - (s.get('bought_token_volume') or 0)
        sellers.append({'address': s['address'], 'label': s.get('address_label'), 'type': cat(s.get('address_label')), 'sold_usd': round(s.get('sold_volume_usd') or 0), 'bought_usd': round(s.get('bought_volume_usd') or 0),
                        'net_sold_tokens': round(net), 'net_sold_pct_supply': round(net / sup * 100, 3) if sup else None})
    by = {}; cexd = []; big = []
    for x in X:
        c = cat(x.get('to_address_label')); b = by.setdefault(c, {'usd': 0, 'tokens': 0, 'n': 0}); b['usd'] += x.get('transfer_value_usd') or 0; b['tokens'] += x.get('transfer_amount') or 0; b['n'] += 1
        if c == 'CEX': cexd.append(x)
    for x in X[:8]:
        d = x['block_timestamp'][:10]
        big.append({'time': x['block_timestamp'], 'from': x.get('from_address_label'), 'to': x.get('to_address_label'), 'tokens': round(x.get('transfer_amount') or 0), 'pct_supply': round((x.get('transfer_amount') or 0) / sup * 100, 3) if sup else None, 'usd': round(x.get('transfer_value_usd') or 0), 'price_that_day': px.get(d)})
    ex = {}
    for x in cexd: k = exch(x.get('to_address_label')); e = ex.setdefault(k, {'usd': 0, 'tokens': 0, 'n': 0, 'first': x['block_timestamp']}); e['usd'] += x.get('transfer_value_usd') or 0; e['tokens'] += x.get('transfer_amount') or 0; e['n'] += 1; e['first'] = min(e['first'], x['block_timestamp'])
    seller_set = {s['address'] for s in S}
    cex_from_sellers = sum(x.get('transfer_value_usd') or 0 for x in cexd if x['from_address'] in seller_set)
    types = {}
    for s in sellers: types[s['type']] = types.get(s['type'], 0) + s['sold_usd']
    out['tokens'][sym] = {'chain': t['chain'], 'address': t['a'], 'window': [t['from'], t['to']], 'transfers_window_from': t.get('tfrom') or t['from'], 'transfer_min_usd': t.get('minUsd') or 10000,
                          'top_sellers': sellers, 'top12_sold_usd_by_type': {k: round(v) for k, v in types.items()},
                          'transfers_n': len(X), 'transfers_by_destination': {k: {kk: round(vv) for kk, vv in v.items()} for k, v in by.items()},
                          'cex_deposits_by_exchange': {k: {**{kk: round(vv) if isinstance(vv, float) else vv for kk, vv in v.items()}} for k, v in ex.items()}, 'cex_deposit_usd_from_top_sellers': round(cex_from_sellers),
                          'largest_transfers': big, 'note': 'Transfers = top 100 by USD value (non-DEX, incl. CEX) in the window; sellers = top 25 by sold USD (DEX trades).'}
json.dump(out, open(os.path.join(DATA_DIR, 'nansen_crash.json'), 'w'), indent=1)
for sym, v in out['tokens'].items():
    print('=====', sym, v['window'], 'transfers', v['transfers_n'])
    for s in v['top_sellers'][:6]: print('  S', s['type'], (s['label'] or '')[:42], 'sold $%s bought $%s net %s tok (%s%%)' % (f"{s['sold_usd']:,}", f"{s['bought_usd']:,}", f"{s['net_sold_tokens']:,}", s['net_sold_pct_supply']))
    print('  types', v['top12_sold_usd_by_type'])
    print('  dest', v['transfers_by_destination']); print('  CEX', v['cex_deposits_by_exchange'], 'from top sellers $', v['cex_deposit_usd_from_top_sellers'])
    for b in v['largest_transfers'][:5]: print('  T', b['time'], (b['from'] or '')[:34], '->', (b['to'] or '')[:34], f"{b['tokens']:,}", b['pct_supply'], f"${b['usd']:,}", b['price_that_day'])
print('credits', out['creditsUsed'], out['accountBefore'], out['accountAfter'])
