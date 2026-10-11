#!/usr/bin/env python3
"""Extra launchpads: Hooked (hookedpad.com public API), Seven (seven.fun /api/launches), x7 / stock-paired memecoins (DexScreener search by
tokenized-stock quote symbols), plus GeckoTerminal dex sweeps for launchpad dex ids. Daily closes (GT, <=180d) for the biggest of each.
Free only; zero Nansen/X (guarded get). Output data/launchpad_extra.json"""
import json, os, time, datetime as dt
from crash_lab import get, COUNTS, log, D
from common import DATA_DIR
GT = 'https://api.geckoterminal.com/api/v2'
PADS = {'solana': ['pump-fun', 'pumpswap', 'letsbonk-fun', 'raydium-launchlab', 'moonshot', 'moonit', 'meteora-dbc', 'bags-fm', 'heaven', 'boop-fun', 'daos-fun', 'memefun', 'stonkfun', 'zora', 'clanker-solana', 'virtuals-solana'],
        'bsc': ['four-meme', 'tiktokfun'], 'base': ['virtuals-base', 'o1-launchpad', 'moonbase'], 'ton': ['stonks-pump'], 'sui-network': ['turbos-finance']}
STOCKS = ['SPYx', 'TSLAx', 'NVDAx', 'AAPLx', 'GOOGLx', 'METAx', 'AMZNx', 'COINx', 'MSTRx', 'HOODx', 'CRCLx', 'SPCXX', 'DKNG', 'GMEX', 'QQQx', 'MSFTx', 'OPENAI', 'ANTHROPIC', 'SpaceX', 'NVIDIA']
def main():
    toks = {}; stats = {}; skipped = []
    def put(chain, addr, pad, **kw):
        k = f'{chain}:{addr}'; t = toks.setdefault(k, {'chain': chain, 'address': addr, 'pad': pad, 'pools': []}); t.update({k2: v for k2, v in kw.items() if v is not None}); return t
    # Hooked
    try:
        L = get('https://www.hookedpad.com/api/launches', gap=1).get('launches', [])
        for x in L: put('solana', x['mint'], 'hooked', symbol=x.get('symbol'), hooked_rule=x.get('ruleName'), ds_pair=x.get('pool'))
        S = get('https://www.hookedpad.com/api/std/launches', gap=1).get('launches', [])
        stats['hooked_token2022_launches'] = len(L); stats['hooked_standard_launches'] = len(S)
        skipped.append(f'Hooked standard ({len(S)} launches) uses its own token program/DEX; not indexed by DexScreener/GeckoTerminal, so no price history.')
    except Exception as e: skipped.append('hooked: ' + str(e)[:60])
    # Seven
    try: s7 = get('https://www.seven.fun/api/launches', gap=1); stats['seven_launches_public_api'] = len(s7) if isinstance(s7, list) else None
    except Exception as e: skipped.append('seven: ' + str(e)[:60])
    if not stats.get('seven_launches_public_api'): skipped.append('Seven (seven.fun): public /api/launches returns an empty list; no launches discoverable from free sources yet.')
    skipped.append('x7 (x7pad.com): no public API; frontend reads the chain directly and its program id is not published. Stock-paired coins are covered by the DexScreener quote-symbol sweep (labeled by dexId).')
    # stock-paired memecoins on any launchpad (DexScreener search by quote symbol)
    for q in STOCKS:
        try: r = get('https://api.dexscreener.com/latest/dex/search?q=' + q, gap=0.4)
        except Exception as e: skipped.append(f'ds search {q}: {str(e)[:40]}'); continue
        for p in r.get('pairs') or []:
            if p['quoteToken']['symbol'].upper() == q.upper() and p['baseToken']['symbol'].upper() != q.upper():
                put(p['chainId'], p['baseToken']['address'], 'stock-paired:' + p['dexId'], symbol=p['baseToken']['symbol'], quote=p['quoteToken']['symbol'], ds_pair=p['pairAddress'],
                    mcap_now=p.get('marketCap') or p.get('fdv'), price_now=float(p.get('priceUsd') or 0) or None, liq_now=(p.get('liquidity') or {}).get('usd'), created=D(p['pairCreatedAt']) if p.get('pairCreatedAt') else None)
    stats['stock_paired_tokens'] = sum(1 for t in toks.values() if t['pad'].startswith('stock-paired'))
    # GT launchpad dex sweeps (3 pages x 20 pools by 24h volume each)
    for net, dexes in PADS.items():
        for dx in dexes:
            n = 0
            for pg in (1, 2, 3):
                try: d = get(f'{GT}/networks/{net}/dexes/{dx}/pools?page={pg}&sort=h24_volume_usd_desc', gap=2.2)
                except Exception as e: skipped.append(f'GT {net}/{dx}: {str(e)[:40]}'); break
                for pl in d.get('data') or []:
                    a = pl['attributes']; base = pl['relationships']['base_token']['data']['id'].split('_', 1)[1]
                    t = put('solana' if net == 'solana' else net.replace('sui-network', 'sui'), base, f'gt:{net}/{dx}', symbol=a['name'].split(' / ')[0]); t['gt_net'] = net
                    t['pools'].append({'id': a['address'], 'liq': float(a.get('reserve_in_usd') or 0), 'fdv': float(a.get('fdv_usd') or 0) or None, 'created': (a.get('pool_created_at') or '')[:10]}); n += 1
                if len(d.get('data') or []) < 20: break
            stats[f'gt:{net}/{dx}'] = n
    log('universe', len(toks), stats)
    # DexScreener market for Solana/EVM tokens lacking it (batches of 30)
    for chain in {t['chain'] for t in toks.values()}:
        ks = [t for t in toks.values() if t['chain'] == chain and not t.get('mcap_now')]
        for i in range(0, len(ks), 30):
            try: ps = get(f"https://api.dexscreener.com/tokens/v1/{chain}/{','.join(x['address'] for x in ks[i:i + 30])}", gap=0.3) or []
            except Exception: continue
            best = {}
            for p in ps:
                a = p['baseToken']['address'].lower()
                if a not in best or ((p.get('liquidity') or {}).get('usd') or 0) > ((best[a].get('liquidity') or {}).get('usd') or 0): best[a] = p
            for x in ks[i:i + 30]:
                p = best.get(x['address'].lower())
                if p: x.update({'price_now': float(p.get('priceUsd') or 0) or None, 'mcap_now': p.get('marketCap') or p.get('fdv'), 'liq_now': (p.get('liquidity') or {}).get('usd'), 'ds_pair': x.get('ds_pair') or p['pairAddress']})
    # daily closes for the top 12 per pad by current/pool FDV
    by = {}
    for t in toks.values(): by.setdefault(t['pad'] if not t['pad'].startswith('stock-paired') else 'stock-paired', []).append(t)
    NET = {'solana': 'solana', 'bsc': 'bsc', 'base': 'base', 'ton': 'ton', 'sui': 'sui-network', 'robinhood': 'robinhood', 'ethereum': 'eth'}
    for pad, L in by.items():
        for t in sorted(L, key=lambda t: -max(t.get('mcap_now') or 0, max([p.get('fdv') or 0 for p in t['pools']] or [0])))[:25 if pad == 'stock-paired' else 12]:
            pool = max(t['pools'], key=lambda q: q['liq'])['id'] if t['pools'] else str(t.get('ds_pair') or '').split(':')[0]
            net = NET.get(t['chain'])
            if not pool or not net: continue
            try: L2 = sorted(get(f'{GT}/networks/{net}/pools/{pool}/ohlcv/day?aggregate=1&limit=180&currency=usd', gap=2.2)['data']['attributes']['ohlcv_list'])
            except Exception as e: skipped.append(f"GT ohlcv {t.get('symbol')}: {str(e)[:30]}"); continue
            if len(L2) >= 2: t['ohlcv'] = {'dates': [D(c[0]) for c in L2], 'closes': [c[4] for c in L2], 'truncated_180d': len(L2) >= 180}
    billing = {'nansen_calls': 0 if not any('nansen' in h for h in COUNTS) else 'NONZERO', 'x_calls': 0 if not any('x.com' in h or 'twitter' in h for h in COUNTS) else 'NONZERO', 'hosts': COUNTS}
    json.dump({'generatedAt': int(time.time() * 1000), 'stats': stats, 'tokens': list(toks.values()), 'skipped': skipped, 'billing': billing}, open(os.path.join(DATA_DIR, 'launchpad_extra.json'), 'w'))
    log('done', stats, billing)
if __name__ == '__main__': main()
