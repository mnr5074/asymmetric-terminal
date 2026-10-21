#!/usr/bin/env python3
"""Waking Up data fetch (free GeckoTerminal only, cached under research/waking/cache; never fetches a file twice inside its TTL).
Solana: pool pages (default sort 1-10, 24h-volume sort 1-5, trending 1-3) + named tokens -> deepest pool per base token -> daily OHLCV.
Robinhood: RAM pool list + 4h OHLCV written into the rhscan cache naming (research/rhscan/cache) so the RH scanner reuses it.
usage: python3 research/waking/fetch.py [--min-liq 50000]"""
import json, os, sys, time, urllib.request, argparse
HERE = os.path.dirname(os.path.abspath(__file__)); CACHE = os.path.join(HERE, 'cache'); RHC = os.path.join(os.path.dirname(HERE), 'rhscan', 'cache')
GT = 'https://api.geckoterminal.com/api/v2'
NAMED_SOL = {'6AUURRdHb9TrfPHv9AMofa8NEVoZDXcsbWKcUBpFSRXs': 'CYPHERCAT (CypherCat, pool vs CYPH)', 'EosbW31T1WAQSiHUErogcaNHd8FBZDbjPPgQMJzXARNV': 'QCAT (StonkFun reward coin; dead rug)'}
# Quotes whose USD conversion GeckoTerminal gets right; any other quote (e.g. CYPH, a tokenized stock) gets quote-denominated candles
# + the quote token's own USD candles so waking.py can detect a stale/flat USD series and rebuild it (CYPHERCAT: GT USD flat ~$0.00065 for days).
SAFE_QUOTES = {'So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'}
NAMED_RH = {'0x5173d45a1191ee33cbb7d8c7e65f21b04ed54802': 'RAM (Ramses)'}
QUOTES = {'SOL', 'WSOL', 'USDC', 'USDT', 'USD1', 'JITOSOL', 'MSOL', 'WETH', 'ETH', 'USDG', 'HOOD', 'BSOL', 'JUPSOL', 'INF', 'PYUSD'}
CALLS = {'gt': 0, 'cache': 0, 'fail': 0}; _last = [0.0]
def get(url, tries=4):
    for k in range(tries):
        w = _last[0] + 2.2 - time.time()
        if w > 0: time.sleep(w)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={'accept': 'application/json', 'user-agent': 'asymmetric-terminal/waking'})
            with urllib.request.urlopen(req, timeout=25) as r: CALLS['gt'] += 1; return json.load(r)
        except Exception as e:
            code = getattr(e, 'code', None)
            if code == 404: return None
            time.sleep(10 * (k + 1) if code == 429 else 2)
    CALLS['fail'] += 1; return None
def cached(path, ttl, fn):
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < ttl: CALLS['cache'] += 1; return json.load(open(path))
    v = fn()
    if v is not None:
        os.makedirs(os.path.dirname(path), exist_ok=True); json.dump(v, open(path, 'w'))
    return v
def pools_of(d):
    out = []
    for p in (d or {}).get('data', []) or []:
        a = p['attributes']; rel = p.get('relationships', {})
        base = ((rel.get('base_token', {}) or {}).get('data', {}) or {}).get('id', '').split('_', 1)[-1]
        quote = ((rel.get('quote_token', {}) or {}).get('data', {}) or {}).get('id', '').split('_', 1)[-1]
        out.append({'pool': a['address'], 'name': a.get('name'), 'base': base, 'quote': quote, 'priceUsd': float(a.get('base_token_price_usd') or 0) or None, 'liq': float(a.get('reserve_in_usd') or 0),
                    'created': a.get('pool_created_at'), 'symbol': (a.get('name') or '').split('/')[0].strip().upper()})
    return out
def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--min-liq', type=float, default=50000); a = ap.parse_args()
    T = 20 * 3600; pools = []
    for pg in range(1, 11): pools += pools_of(cached(f'{CACHE}/sol_pools_{pg}.json', T, lambda pg=pg: get(f'{GT}/networks/solana/pools?page={pg}')))
    for pg in range(1, 6): pools += pools_of(cached(f'{CACHE}/sol_poolsvol_{pg}.json', T, lambda pg=pg: get(f'{GT}/networks/solana/pools?page={pg}&sort=h24_volume_usd_desc')))
    for pg in range(1, 4): pools += pools_of(cached(f'{CACHE}/sol_trending_{pg}.json', T, lambda pg=pg: get(f'{GT}/networks/solana/trending_pools?page={pg}')))
    named = []
    for addr in NAMED_SOL:
        ps = pools_of(cached(f'{CACHE}/sol_tokpools_{addr}.json', T, lambda addr=addr: get(f'{GT}/networks/solana/tokens/{addr}/pools?page=1')))
        ps = [p for p in ps if p['base'] == addr]; pools += ps; named += [p['base'] for p in ps]
    # Launchpad (stonkfun) tokens from data/crash_eco.json created >= 45 days ago, INCLUDING dead/crashed ones (reduces survivorship
    # bias); their DexScreener pair is used as the pool. No liquidity filter: the backtest's volume floor decides tradability per day.
    extra = set()
    try:
        eco = json.load(open(os.path.join(os.path.dirname(os.path.dirname(HERE)), 'data', 'crash_eco.json')))['tokens']
        for x in eco:
            if x['chain'] == 'solana' and x.get('ds_pair') and (x.get('created') or '9') <= '2026-09-05':
                pools.append({'pool': x['ds_pair'], 'name': (x.get('symbol') or '') + ' / ' + (x.get('quote') or ''), 'base': x['address'], 'quote': None, 'quoteSym': x.get('quote'),
                              'liq': float(x.get('liq_now') or 0), 'created': x.get('created'), 'symbol': (x.get('symbol') or '').upper(), 'extra': True})
                extra.add(x['address'])
    except Exception as e: print('crash_eco', e, file=sys.stderr)
    best = {}
    for p in pools:
        if p['symbol'] in QUOTES or not p['base']: continue
        if p['base'] not in best or p['liq'] > best[p['base']]['liq']: best[p['base']] = p
    toks = {k: v for k, v in best.items() if v['liq'] >= a.min_liq or k in NAMED_SOL or k in extra}
    print('solana pools', len(pools), 'tokens', len(best), 'with liq', len(toks), file=sys.stderr)
    for k, (addr, p) in enumerate(toks.items()):
        cached(f'{CACHE}/sol_ohlcvd_{p["pool"]}.json', T, lambda p=p: get(f'{GT}/networks/solana/pools/{p["pool"]}/ohlcv/day?limit=1000&currency=usd&token=base'))
        if k % 25 == 0: print(k, CALLS, file=sys.stderr, flush=True)
    # stale-USD guard inputs (non-SOL/USDC/USDT quotes only): quote-denominated candles + the quote token's own USD candles
    qpools = {}
    for addr, p in toks.items():
        if p.get('extra') and not p.get('quote'):
            d = cached(f'{CACHE}/sol_pool_{p["pool"]}.json', 7 * 86400, lambda p=p: get(f'{GT}/networks/solana/pools/{p["pool"]}'))
            try: p['quote'] = d['data']['relationships']['quote_token']['data']['id'].split('_', 1)[-1]; p['liq'] = float(d['data']['attributes'].get('reserve_in_usd') or 0)
            except Exception: pass
        if not p.get('quote') or p['quote'] in SAFE_QUOTES: continue
        cached(f'{CACHE}/sol_ohlcvq_{p["pool"]}.json', T, lambda p=p: get(f'{GT}/networks/solana/pools/{p["pool"]}/ohlcv/day?limit=1000&currency=token&token=base'))
        q = p['quote']
        if q not in qpools:
            qs = sorted([x for x in pools_of(cached(f'{CACHE}/sol_tokpools_{q}.json', T, lambda q=q: get(f'{GT}/networks/solana/tokens/{q}/pools?page=1'))) if x['base'] == q], key=lambda x: -x['liq'])
            qs = [x for x in qs if x['quote'] in SAFE_QUOTES] or qs
            qpools[q] = qs[0]['pool'] if qs else None
            if qpools[q]: cached(f'{CACHE}/sol_ohlcvd_{qpools[q]}.json', T, lambda pl=qpools[q]: get(f'{GT}/networks/solana/pools/{pl}/ohlcv/day?limit=1000&currency=usd&token=base'))
        p['quotePool'] = qpools[q]
    json.dump({'at': int(time.time() * 1000), 'tokens': toks, 'named': NAMED_SOL}, open(f'{CACHE}/sol_universe.json', 'w'))
    # Robinhood RAM (and any other named RH token): pool list + 4h bars in the rhscan cache naming
    for addr in NAMED_RH:
        d = cached(f'{RHC}/tokpools_{addr}.json', 3.5 * 3600, lambda addr=addr: get(f'{GT}/networks/robinhood/tokens/{addr}/pools?page=1'))
        ps = sorted([p for p in pools_of(d) if p['base'].lower() == addr], key=lambda p: -p['liq'])
        if ps: cached(f'{RHC}/ohlcv4h_{ps[0]["pool"].lower()}.json', 3.5 * 3600, lambda pl=ps[0]['pool']: get(f'{GT}/networks/robinhood/pools/{pl}/ohlcv/hour?aggregate=4&limit=1000&currency=usd'))
        print('RH named', addr, ps[:1], file=sys.stderr)
    print(json.dumps(CALLS))
if __name__ == '__main__': main()
