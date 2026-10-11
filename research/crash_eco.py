#!/usr/bin/env python3
"""Crash/moon sweep for StonkFun (stonk eco, Solana), PONS launchpad and ALL Robinhood Chain launches.
Free sources: stonkfun.xyz public API v1, GeckoTerminal (all Robinhood dexes, daily OHLCV <= 180 days), DexScreener, Robinhood Chain public RPC (pons factory logs).
Zero Nansen / X calls (same guarded get() as crash_lab). Output data/crash_eco.json."""
import json, os, sys, time
from crash_lab import get, COUNTS, D, log
from common import DATA_DIR
GT = 'https://api.geckoterminal.com/api/v2'; RPC = 'https://rpc.mainnet.chain.robinhood.com'
FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'; T_LAUNCH = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607'; T_GRAD = '0x308c390ed1ab5873392818e036cabdf408bc8ad042fbaead3108954ff75ba980'
gt = lambda p: get(GT + p, gap=2.2)
def rpc(method, params):
    import urllib.request
    COUNTS['rpc.mainnet.chain.robinhood.com'] = COUNTS.get('rpc.mainnet.chain.robinhood.com', 0) + 1
    r = urllib.request.urlopen(urllib.request.Request(RPC, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(), headers={'content-type': 'application/json', 'User-Agent': 'Mozilla/5.0 asymmetric-terminal research'}), timeout=60)
    d = json.loads(r.read());
    if 'error' in d: raise RuntimeError(str(d['error'])[:120])
    return d['result']
OUT = os.path.join(DATA_DIR, 'crash_eco.json')
def save(o): json.dump(o, open(OUT, 'w'))
def main(max_ohlcv=int(os.environ.get('MAX_OHLCV', '260'))):
    t0 = time.time(); toks = {}; skipped = []; stats = {}
    # 1) StonkFun: every token via all three sorts, paged
    n = 0
    for sort in ('marketCap', 'volume', 'newest'):
        for page in range(1, 31):
            try: d = get(f'https://www.stonkfun.xyz/api/public/v1/tokens?sort={sort}&pageSize=100&page={page}', gap=0.5)
            except Exception as e: skipped.append(f'stonkfun {sort} p{page}: {str(e)[:60]}'); break
            ts = d.get('data', {}).get('tokens') or []
            for t in ts:
                m = t.get('market') or {}; k = 'solana:' + t['mint']
                toks.setdefault(k, {'chain': 'solana', 'address': t['mint'], 'symbol': t.get('symbol'), 'name': t.get('name'), 'eco': 'stonkfun', 'created': (t.get('createdAt') or '')[:10],
                                    'mcap_now': m.get('marketCapUsd'), 'peak_mcap_src': m.get('peakMarketCapUsd'), 'liq_now': m.get('liquidityUsd'), 'vol24': m.get('volume24hUsd'), 'quote': (t.get('quote') or {}).get('symbol'), 'status': t.get('status')})
            n += len(ts)
            if len(ts) < 100: break
    stats['stonkfun_tokens'] = sum(1 for v in toks.values() if v['eco'] == 'stonkfun'); log('stonkfun', stats['stonkfun_tokens'])
    # 2) Robinhood Chain: every GeckoTerminal dex on the network, pools pages 1..10 (GT max), + network top/new pools
    try: dexes = [x['id'] for x in gt('/networks/robinhood/dexes?page=1')['data']]
    except Exception as e: dexes = []; skipped.append('GT robinhood dexes: ' + str(e)[:60])
    paths = [f'/networks/robinhood/dexes/{dx}/pools?page={{p}}&sort=h24_volume_usd_desc' for dx in dexes] + ['/networks/robinhood/pools?page={p}&sort=h24_volume_usd_desc', '/networks/robinhood/new_pools?page={p}']
    pools_seen = 0; QUOTES = {'WETH', 'ETH', 'USDG', 'USDC', 'USDT', 'WBTC'}
    for pth in paths:
        for p in range(1, 11):
            try: d = gt(pth.format(p=p))
            except Exception as e: skipped.append(f'GT {pth.split("/")[4] if "/dexes/" in pth else pth[:30]} p{p}: {str(e)[:40]}'); break
            ps = d.get('data') or []; pools_seen += len(ps)
            for pl in ps:
                a = pl['attributes']; base = pl['relationships']['base_token']['data']['id'].split('_', 1)[1]; quote = pl['relationships']['quote_token']['data']['id'].split('_', 1)[1]
                nm = a.get('name', ''); sym = nm.split(' / ')[0].strip()
                if sym.upper() in QUOTES: base, sym = quote, nm.split(' / ')[1].split(' ')[0] if ' / ' in nm else sym
                k = 'robinhood:' + base.lower(); dexid = pl['relationships']['dex']['data']['id']
                e = toks.setdefault(k, {'chain': 'robinhood', 'address': base, 'symbol': sym, 'eco': 'pons' if 'pons' in dexid else 'robinhood', 'dex': dexid, 'pools': []})
                e['pools'].append({'id': a['address'], 'liq': float(a.get('reserve_in_usd') or 0), 'created': (a.get('pool_created_at') or '')[:10], 'fdv': float(a.get('fdv_usd') or 0) or None, 'mcap': float(a.get('market_cap_usd') or 0) or None})
            if len(ps) < 20: break
    stats['robinhood_dexes'] = len(dexes); stats['robinhood_pools_listed'] = pools_seen; stats['robinhood_tokens'] = sum(1 for v in toks.values() if v['chain'] == 'robinhood')
    log('robinhood', stats)
    # 3) PONS factory: every launch + graduation since genesis (public RPC logs, chunked)
    try:
        head = int(rpc('eth_blockNumber', []), 16); launches, grads = [], []; step = 2_000_000; frm = 0
        while frm <= head:
            to = min(head, frm + step - 1)
            try:
                for topic, acc in ((T_LAUNCH, launches), (T_GRAD, grads)):
                    acc += rpc('eth_getLogs', [{'address': FACTORY, 'topics': [topic], 'fromBlock': hex(frm), 'toBlock': hex(to)}])
                frm = to + 1
            except Exception as e:
                if step > 50_000: step //= 4; continue
                skipped.append(f'pons logs {frm}-{to}: {str(e)[:60]}'); frm = to + 1
        stats['pons_launches_total'] = len(launches); stats['pons_graduations_total'] = len(grads)
        ga = {'0x' + l['topics'][1][-40:] for l in grads}
        for l in launches:
            a = '0x' + l['topics'][1][-40:]; e = toks.setdefault('robinhood:' + a.lower(), {'chain': 'robinhood', 'address': a, 'eco': 'pons', 'pools': []}); e['eco'] = 'pons'; e['pons_graduated'] = a in ga; e['pons_block'] = int(l['blockNumber'], 16)
    except Exception as e: skipped.append('pons factory logs: ' + str(e)[:80])
    log('pons', stats.get('pons_launches_total'), stats.get('pons_graduations_total'))
    save({'partial': True, 'stats': stats, 'tokens': list(toks.values()), 'skipped': skipped, 'billing_hosts': COUNTS})
    # 4) DexScreener current market (batches of 30) for everything
    for chain in ('solana', 'robinhood'):
        ks = [v for v in toks.values() if v['chain'] == chain]
        for i in range(0, len(ks), 30):
            try: ps = get(f"https://api.dexscreener.com/tokens/v1/{chain}/{','.join(x['address'] for x in ks[i:i + 30])}", gap=0.3) or []
            except Exception as e: skipped.append(f'dexscreener {chain} batch {i}: {str(e)[:40]}'); continue
            best = {}
            for p in ps:
                a = p['baseToken']['address'].lower()
                if a not in best or ((p.get('liquidity') or {}).get('usd') or 0) > ((best[a].get('liquidity') or {}).get('usd') or 0): best[a] = p
            for x in ks[i:i + 30]:
                p = best.get(x['address'].lower())
                if p: x.update({'symbol': x.get('symbol') or p['baseToken']['symbol'], 'price_now': float(p.get('priceUsd') or 0), 'mcap_now': p.get('marketCap') or p.get('fdv') or x.get('mcap_now'), 'liq_now': (p.get('liquidity') or {}).get('usd'), 'ds_pair': p['pairAddress'], 'ds_created': D(p['pairCreatedAt']) if p.get('pairCreatedAt') else None})
    # 5) daily OHLCV (GT, <= 180d) for the biggest names: run multiple, peak, crash depth, dates
    def rank(v): return max(v.get('peak_mcap_src') or 0, max([pl.get('fdv') or 0 for pl in v.get('pools', [])] or [0]), v.get('mcap_now') or 0, 1e6 * bool(v.get('pons_graduated')))
    cands = sorted([v for v in toks.values() if (v.get('pools') or v.get('ds_pair'))], key=rank, reverse=True)[:max_ohlcv]
    for j, v in enumerate(cands):
        pool = (max(v['pools'], key=lambda q: q['liq'])['id'] if v.get('pools') else str(v.get('ds_pair')).split(':')[0])
        net = 'solana' if v['chain'] == 'solana' else 'robinhood'
        try: L = sorted(gt(f'/networks/{net}/pools/{pool}/ohlcv/day?aggregate=1&limit=180&currency=usd')['data']['attributes']['ohlcv_list'])
        except Exception as e: skipped.append(f"GT ohlcv {v.get('symbol')}: {str(e)[:40]}"); continue
        if len(L) < 3: continue
        hi = max(L, key=lambda c: c[2]); pi = L.index(hi); lo = min(L[:pi + 1], key=lambda c: c[3] if c[3] > 0 else 9e99)
        last = L[-1][4]; supply = (v['mcap_now'] / v['price_now']) if v.get('mcap_now') and v.get('price_now') else None
        v['ohlcv'] = {'days': len(L), 'first_day': D(L[0][0]), 'run_low': lo[3], 'run_low_date': D(lo[0]), 'peak': hi[2], 'peak_date': D(hi[0]), 'run_multiple': hi[2] / lo[3] if lo[3] > 0 else None,
                      'last': last, 'crash_depth_pct': (last / hi[2] - 1) * 100, 'peak_mcap_est': hi[2] * supply if supply else None, 'truncated_180d': len(L) >= 180,
                      'closes': [c[4] for c in L], 'vols': [c[5] for c in L], 'dates': [D(c[0]) for c in L]}
        if j % 40 == 39: save({'partial': True, 'stats': stats, 'tokens': list(toks.values()), 'skipped': skipped, 'billing_hosts': COUNTS}); log('ohlcv', j + 1)
    for v in toks.values():   # unify peak / crash numbers
        o = v.get('ohlcv') or {}; pm = max(v.get('peak_mcap_src') or 0, o.get('peak_mcap_est') or 0) or None
        v['peak_mcap'] = pm; v['run_multiple'] = o.get('run_multiple'); v['peak_date'] = o.get('peak_date')
        v['crash_depth_pct'] = o.get('crash_depth_pct') if o else ((v['mcap_now'] / pm - 1) * 100 if pm and v.get('mcap_now') else None)
    billing = {'nansen_calls': sum(c for h, c in COUNTS.items() if 'nansen' in h), 'x_calls': sum(c for h, c in COUNTS.items() if h in ('api.x.com', 'x.com', 'twitter.com', 'api.twitter.com')), 'hosts': COUNTS}
    save({'partial': False, 'generatedAt': int(time.time() * 1000), 'elapsed_s': round(time.time() - t0), 'stats': stats, 'tokens': list(toks.values()), 'skipped': skipped, 'billing': billing})
    log('done', json.dumps(stats), json.dumps(billing))
if __name__ == '__main__': main()
