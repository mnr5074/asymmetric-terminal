"""(5) Oracle manipulation detection -> data/riskinfra_oracles.json (+ riskinfra_oracles_history.json).
Universe: majors + priority (NEAR, ZEC) + top perp-desk tokens by OI + collateral assets of the major lending markets
(Aave v3, Kamino, Venus, Morpho listed markets).
Sources (all free/keyless):
  oracles  : Chainlink (latestRoundData on Ethereum proxies via public RPC; heartbeat/deviation from Chainlink's feed directory),
             Pyth (Hermes v2 latest), RedStone (api.redstone.finance primary-prod), and the lending protocols' own oracle prices
             (AaveOracle via Aave API, Kamino Scope = totalSupplyUsd/totalSupply, Venus ResilientOracle).
  CEX      : Binance (data-api.binance.vision), OKX, Coinbase Exchange, Kraken spot tickers (USDT legs converted to USD).
  DEX      : Jupiter price v3 (Solana), DexScreener deepest-pool spot + liquidity, GeckoTerminal 15m OHLCV TWAP for collateral pools.
  Switchboard: crossbar.switchboard.xyz unreachable from here -> not used (listed under unavailable).
Flags: deviation (>2% majors, >5% alts, >1% stables, vs CEX median), stale (Chainlink age > heartbeat, Pyth publish > 120s,
RedStone > 10min), thin DEX pools behind lending collateral (cost to push +10% vs collateral exposure), DEX spot vs 2h TWAP spikes,
probable ticker collisions (>40% off) reported separately, never as manipulation."""
import time, math, re, json, sys
from common import fetch, gt_get, eth_batch, readj, writej, Ctx, median, pmap, int256, hexint
from lending import get_lending

ctx = Ctx('oracles'); T0 = time.time(); NOWMS = int(T0 * 1000)
MAJORS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TRX', 'TON', 'SUI', 'LTC', 'BCH', 'DOT']
PRIORITY = ['NEAR', 'ZEC']
STABLES = {'USDC', 'USDT', 'DAI', 'USDS', 'USDE', 'PYUSD', 'FDUSD', 'USDG', 'RLUSD', 'GHO', 'FRAX', 'LUSD', 'USD1', 'TUSD', 'USDC.E', 'USDT0', 'USDBC', 'CRVUSD', 'SUSDE', 'USDY', 'USDTB'}
ALIAS = {'WETH': 'ETH', 'WBTC': 'BTC', 'CBBTC': 'BTC', 'TBTC': 'BTC', 'BTCB': 'BTC', 'BTC.B': 'BTC', 'KBTC': 'BTC', 'WBNB': 'BNB', 'WSOL': 'SOL', 'WAVAX': 'AVAX', 'WPOL': 'POL', 'XBT': 'BTC', 'XDG': 'DOGE', 'ETH.E': 'ETH', 'WETH.E': 'ETH'}
MAJOR_LIKE = set(MAJORS) | {'WETH', 'WBTC', 'CBBTC', 'TBTC', 'BTCB', 'WBNB', 'WSTETH', 'WEETH', 'RETH', 'CBETH', 'JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'STETH'}
U = lambda s: (s or '').upper()


def thr(sym):
    s = U(sym)
    if s in STABLES: return 0.01
    return 0.02 if s in MAJOR_LIKE else 0.05


# ---------- universe ----------
lend = get_lending(ctx)
reserves = lend.get('reserves', [])
perps = readj('perps.json', {}) or {}
perp_syms = [t['sym'] for t in sorted(perps.get('tokens', []), key=lambda t: -(t.get('oiUsd') or 0))[:40]]
assets = {}  # sym -> {sym, roles:set, addrs:{chain:addr}, lending:[...]}
def add(sym, role):
    s = U(sym)
    if not s or len(s) > 14: return None
    a = assets.setdefault(s, {'sym': s, 'display': sym, 'roles': set(), 'addrs': {}, 'lending': []}); a['roles'].add(role); return a
for s in MAJORS: add(s, 'major')
for s in PRIORITY: add(s, 'priority')
for s in perp_syms: add(s, 'perp')
CH = {1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 56: 'bsc', 'solana': 'solana'}
for r in reserves:
    if r['protocol'] == 'morpho-blue':
        if (r.get('collateralUsd') or 0) >= 20e6 and r.get('collateralSymbol'):
            a = add(r['collateralSymbol'], 'collateral')
            if a:
                ch = CH.get(r['chainId'])
                if ch and r.get('collateralAddress'): a['addrs'].setdefault(ch, r['collateralAddress'])
                a['lending'].append({'protocol': 'morpho-blue', 'chain': ch, 'market': r['market'], 'exposureUsd': r.get('collateralUsd'), 'oracleType': r.get('oracleType'), 'oracle': r.get('oracleAddress')})
        continue
    ch = CH.get(r['chainId'])
    if r.get('collateral') and (r.get('supplyUsd') or 0) >= 5e6:
        a = add(r['symbol'], 'collateral')
    else:
        a = assets.get(U(r['symbol']))
    if not a: continue
    if ch and r.get('address'): a['addrs'].setdefault(ch, r['address'])
    a['lending'].append({'protocol': r['protocol'], 'chain': ch, 'market': r['market'], 'exposureUsd': r.get('supplyUsd') if r.get('collateral') else 0,
                         'oraclePrice': r.get('oraclePrice'), 'oracleName': r.get('oracleName'), 'supplyUsd': r.get('supplyUsd')})
syms = sorted(assets)

# ---------- Chainlink ----------
def chainlink():
    feeds = fetch('https://reference-data-directory.vercel.app/feeds-mainnet.json', ctx=ctx, timeout=40)
    cands = {}
    for f in feeds:
        dd = f.get('docs') or {}
        if not f.get('proxyAddress') or f.get('feedCategory') == 'deprecating' or dd.get('productType') not in ('Price',): continue
        base, quote = U(dd.get('baseAsset')), U(dd.get('quoteAsset'))
        if quote not in ('USD', 'ETH', 'BTC') or not base: continue
        if base in assets or base in ('ETH', 'BTC'):
            cands.setdefault((base, quote), []).append(f)
    flat = [(k, f) for k, fs in cands.items() for f in fs[:4]]
    res = eth_batch([('eth_call', [{'to': f['proxyAddress'], 'data': '0xfeaf968c'}, 'latest']) for _, f in flat], ctx=ctx)
    raw = {}
    for (k, f), h in zip(flat, res):
        if not h or len(h) < 2 + 64 * 5: continue
        w = [h[2 + 64 * i: 2 + 64 * (i + 1)] for i in range(5)]
        ans = int256(w[1]) / 10 ** int(f.get('decimals') or 8); upd = int(w[3], 16)
        if ans <= 0: continue
        v = {'price': ans, 'updatedAt': upd * 1000, 'heartbeatS': f.get('heartbeat'), 'deviationPct': f.get('threshold'), 'proxy': f['proxyAddress'], 'feed': f.get('name'), 'variants': len(cands[k])}
        if k not in raw or v['updatedAt'] > raw[k]['updatedAt']: raw[k] = v
    usd = {}
    ethusd = (raw.get(('ETH', 'USD')) or {}).get('price'); btcusd = (raw.get(('BTC', 'USD')) or {}).get('price')
    for (b, q), v in sorted(raw.items(), key=lambda kv: kv[0][1] != 'USD'):
        conv = 1 if q == 'USD' else ethusd if q == 'ETH' else btcusd
        if not conv or b in usd: continue
        usd[b] = dict(v, priceUsd=v['price'] * conv, quote=q)
    return usd


# ---------- Pyth ----------
def pyth():
    """Hermes price endpoints now return 401 without a key, so read Pyth's on-chain *sponsored push feeds* on Solana
    (PriceUpdateV2 accounts, shard 0) - the exact values Solana lending protocols consume."""
    import base64, struct
    from solkeys import pyth_feed_account
    from common import sol_rpc
    lst = fetch('https://hermes.pyth.network/v2/price_feeds?asset_type=crypto', ctx=ctx, timeout=40)
    ids = {}
    for f in lst:
        m = re.match(r'CRYPTO\.([A-Z0-9.]+)/USD$', f['attributes'].get('symbol', '').upper())
        if m and m.group(1) in assets and m.group(1) not in ids: ids[m.group(1)] = f['id']
    items = [(s_, fid, pyth_feed_account(fid)) for s_, fid in ids.items()]
    out = {}
    for i in range(0, len(items), 100):
        part = items[i:i + 100]
        r = ctx.tryf('pyth solana getMultipleAccounts', lambda: sol_rpc('getMultipleAccounts', [[a for _, _, a in part], {'encoding': 'base64'}], ctx=ctx), None)
        for (s_, fid, acct), v in zip(part, (r or {}).get('value') or []):
            if not v: continue
            b = base64.b64decode(v['data'][0]); o = 8 + 32
            o += 2 if b[o] == 0 else 1
            feed = b[o:o + 32].hex(); o += 32
            price, conf, expo, pt = struct.unpack_from('<qQiq', b, o)
            if feed != fid.replace('0x', ''): continue
            px = price * 10 ** expo; cf = conf * 10 ** expo
            if px > 0: out[s_] = {'priceUsd': px, 'conf': cf, 'confPct': cf / px * 100, 'publishTime': pt * 1000, 'id': fid, 'account': acct}
    ctx.pythListed = len(ids)
    return out


# ---------- RedStone ----------
def redstone():
    out = {}; ss = [x for x in syms if re.fullmatch(r'[A-Z0-9.]+', x)]
    for i in range(0, len(ss), 40):
        part = ss[i:i + 40]
        part = [p for p in part if re.fullmatch(r'[A-Z0-9.]+', p)]
        d = ctx.tryf('redstone', lambda: fetch('https://api.redstone.finance/prices?symbols=' + ','.join(part) + '&provider=redstone-primary-prod', ctx=ctx), {})
        items = d.values() if isinstance(d, dict) else (d or [])
        for v in items:
            if isinstance(v, dict) and v.get('value') and v.get('symbol'):
                out[U(v['symbol'])] = {'priceUsd': float(v['value']), 'timestamp': v.get('timestamp')}
    return out


# ---------- CEX ----------
def cex():
    res = {}
    def binance():
        d = fetch('https://data-api.binance.vision/api/v3/ticker/24hr', ctx=ctx, timeout=40)
        return {x['symbol']: float(x['lastPrice']) for x in d if float(x.get('lastPrice') or 0) > 0 and int(x.get('count') or 0) > 50 and NOWMS - int(x.get('closeTime') or 0) < 3600e3}
    def okx():
        d = fetch('https://www.okx.com/api/v5/market/tickers?instType=SPOT', ctx=ctx); return {x['instId']: float(x['last']) for x in d['data'] if x.get('last')}
    def kraken():
        ap = fetch('https://api.kraken.com/0/public/AssetPairs', ctx=ctx)['result']
        want = {}
        for k, v in ap.items():
            ws = v.get('wsname') or ''
            if '/' not in ws: continue
            b, q = ws.split('/'); b = ALIAS.get(b, b) if b in ('XBT', 'XDG') else b
            if q in ('USD', 'USDT') and (b in assets or b in ('USDT', 'USDC')): want[k] = (b, q)
        out = {}; keys = list(want)
        for i in range(0, len(keys), 60):
            t = fetch('https://api.kraken.com/0/public/Ticker?pair=' + ','.join(keys[i:i + 60]), ctx=ctx).get('result', {})
            for k, v in t.items():
                if k in want: out[want[k]] = float(v['c'][0])
        return out
    def coinbase():
        prods = fetch('https://api.exchange.coinbase.com/products', ctx=ctx)
        ids = [p['id'] for p in prods if p.get('quote_currency') == 'USD' and p.get('status') == 'online' and not p.get('trading_disabled') and (U(p['base_currency']) in assets or p['base_currency'] in ('USDT',))]
        def one(i):
            try: return i, float(fetch(f'https://api.exchange.coinbase.com/products/{i}/ticker', ctx=ctx, retries=1)['price'])
            except Exception: return i, None
        return {i.split('-')[0].upper(): p for i, p in pmap(one, ids, 5) if p}
    fns = {'binance': binance, 'okx': okx, 'kraken': kraken, 'coinbase': coinbase}
    raw = dict(zip(fns, pmap(lambda k: ctx.tryf('cex ' + k, fns[k], {}), list(fns), 4)))
    usdt = median([raw['coinbase'].get('USDT'), raw['kraken'].get(('USDT', 'USD'))]) or 1.0
    for s in syms:
        r = ALIAS.get(s, s); row = {}
        for cand in ([s, r] if r != s else [s]):
            if 'binance' not in row and raw['binance'].get(cand + 'USDT'): row['binance'] = raw['binance'][cand + 'USDT'] * usdt
            if 'okx' not in row and raw['okx'].get(cand + '-USDT'): row['okx'] = raw['okx'][cand + '-USDT'] * usdt
            if 'kraken' not in row:
                if raw['kraken'].get((cand, 'USD')): row['kraken'] = raw['kraken'][(cand, 'USD')]
                elif raw['kraken'].get((cand, 'USDT')): row['kraken'] = raw['kraken'][(cand, 'USDT')] * usdt
            if 'coinbase' not in row and raw['coinbase'].get(cand): row['coinbase'] = raw['coinbase'][cand]
        if s in STABLES and s not in ('USDT',): row.pop('binance', None) if s == 'USDC' else None
        res[s] = row
    return res, usdt, {k: len(v) for k, v in raw.items()}


# ---------- DEX ----------
def dex():
    out = {}
    by = {}
    for s, a in assets.items():
        for ch, ad in a['addrs'].items(): by.setdefault(ch, []).append((s, ad))
    def ds(ch, lst):
        res = {}
        for i in range(0, len(lst), 30):
            part = lst[i:i + 30]
            pairs = ctx.tryf('dexscreener ' + ch, lambda: fetch(f"https://api.dexscreener.com/tokens/v1/{ch}/{','.join(a for _, a in part)}", ctx=ctx), []) or []
            for s, ad in part:
                ps = [p for p in pairs if U(p.get('baseToken', {}).get('address')) == U(ad) and p.get('priceUsd')]
                if not ps: continue
                ps.sort(key=lambda p: -(p.get('liquidity') or {}).get('usd', 0) or 0)
                top = ps[0]
                res[s] = {'chain': ch, 'address': ad, 'priceUsd': float(top['priceUsd']), 'pool': top.get('pairAddress'), 'dex': top.get('dexId'), 'labels': top.get('labels') or [],
                          'quote': top.get('quoteToken', {}).get('symbol'), 'poolLiqUsd': (top.get('liquidity') or {}).get('usd'),
                          'totalLiqUsd': sum((p.get('liquidity') or {}).get('usd', 0) or 0 for p in ps), 'pools': len(ps), 'vol24': (top.get('volume') or {}).get('h24')}
        return res
    for ch, lst in by.items():
        for s, v in ds(ch, lst).items(): out.setdefault(s, {})[ch] = v
    # Jupiter (Solana aggregated price)
    sol = by.get('solana', [])
    jup = {}
    for i in range(0, len(sol), 50):
        part = sol[i:i + 50]
        d = ctx.tryf('jupiter price', lambda: fetch('https://lite-api.jup.ag/price/v3?ids=' + ','.join(a for _, a in part), ctx=ctx), {}) or {}
        for s, a in part:
            if d.get(a, {}).get('usdPrice'): jup[s] = {'priceUsd': d[a]['usdPrice'], 'address': a}
    return out, jup


def twap(ch, pool, token=None):
    net = {'ethereum': 'eth', 'solana': 'solana', 'bsc': 'bsc', 'base': 'base', 'arbitrum': 'arbitrum'}[ch]
    d = gt_get(f'/networks/{net}/pools/{pool}/ohlcv/minute?aggregate=15&limit=8&currency=usd' + (f'&token={token}' if token else ''), ctx=ctx)
    L = sorted(d['data']['attributes']['ohlcv_list'], key=lambda x: x[0])
    if len(L) < 4: return None
    closes = [float(x[4]) for x in L]; vols = [float(x[5] or 0) for x in L]
    tw = sum(closes) / len(closes)
    return {'twap2h': tw, 'last': closes[-1], 'bars': len(L), 'vol2hUsd': sum(vols), 'from': L[0][0] * 1000, 'to': L[-1][0] * 1000}


jobs = {'chainlink': chainlink, 'pyth': pyth, 'redstone': redstone, 'cex': cex, 'dex': dex}
R = dict(zip(jobs, pmap(lambda k: ctx.tryf(k, jobs[k], None), list(jobs), 5)))
CL, PY, RS = R['chainlink'] or {}, R['pyth'] or {}, R['redstone'] or {}
CX, USDT, CEXN = R['cex'] or ({}, 1.0, {})
DX, JUP = R['dex'] or ({}, {})

# ---------- assemble ----------
rows, flags, collisions, inactive = [], [], [], []
def flag(sym, typ, sev, src, detail, **kw):
    flags.append(dict({'asset': sym, 'type': typ, 'severity': sev, 'source': src, 'detail': detail}, **kw))

def robust_ref(srcs):
    """Largest cluster of sources agreeing within 3% (CEX weighted x2, DEX x0.5); reference = CEX median inside that cluster
    if it has >=2 CEX, else median of the cluster. Protects against ticker collisions (e.g. two different 'U' tokens)."""
    W = {'cex': 2, 'oracle': 1.5, 'lending_oracle': 1, 'dex': 0.5}
    pts = [x for x in srcs if x.get('price')]
    best, bw = None, -1
    for p in pts:
        cl = [q for q in pts if abs(q['price'] / p['price'] - 1) <= 0.03]
        w = sum(W[q['kind']] for q in cl)
        if w > bw: best, bw = cl, w
    if not best: return None, None
    cx = [q['price'] for q in best if q['kind'] == 'cex']
    if len(cx) >= 2: return median(cx), f'median of {len(cx)} CEX (agreeing cluster)'
    nd = [q['price'] for q in best if q['kind'] != 'dex']
    if len(best) < 2: return None, None
    return median(nd or [q['price'] for q in best]), f'median of agreeing cluster ({len(best)} sources)'


for s in syms:
    a = assets[s]; srcs = []
    for ex, px in (CX.get(s) or {}).items(): srcs.append({'src': ex, 'kind': 'cex', 'price': px})
    if s in CL: c = CL[s]; srcs.append({'src': 'chainlink', 'kind': 'oracle', 'price': c['priceUsd'], 'updatedAt': c['updatedAt'], 'heartbeatS': c['heartbeatS'], 'deviationPct': c['deviationPct'], 'feed': c['feed'], 'proxy': c['proxy']})
    if s in PY:
        p = PY[s]
        if NOWMS - p['publishTime'] > 6 * 3600e3:
            inactive.append({'asset': s, 'account': p['account'], 'price': p['priceUsd'], 'lastPublishAgeH': round((NOWMS - p['publishTime']) / 3600e3, 1)})
        else: srcs.append({'src': 'pyth', 'kind': 'oracle', 'price': p['priceUsd'], 'updatedAt': p['publishTime'], 'confPct': p['confPct'], 'account': p['account']})
    if s in RS: r = RS[s]; srcs.append({'src': 'redstone', 'kind': 'oracle', 'price': r['priceUsd'], 'updatedAt': r.get('timestamp')})
    seen = set()
    for l in a['lending']:
        k = (l['protocol'], l.get('chain'))
        if l.get('oraclePrice') and k not in seen:
            seen.add(k); srcs.append({'src': f"{l['protocol']}:{l.get('chain')}", 'kind': 'lending_oracle', 'price': l['oraclePrice'], 'oracleName': l.get('oracleName'), 'reserveSupplyUsd': max([q.get('supplyUsd') or 0 for q in a['lending'] if (q['protocol'], q.get('chain')) == k] or [0])})
    if s in JUP: srcs.append({'src': 'jupiter', 'kind': 'dex', 'price': JUP[s]['priceUsd']})
    for ch, d in (DX.get(s) or {}).items():
        srcs.append({'src': f'dex:{ch}:{d["dex"]}', 'kind': 'dex', 'price': d['priceUsd'], 'poolLiqUsd': d['poolLiqUsd'], 'pool': d['pool']})
    cexp = [x['price'] for x in srcs if x['kind'] == 'cex']
    ref, refsrc = robust_ref(srcs)
    t = thr(s); mx = 0
    for x in srcs:
        if not ref: break
        x['devPct'] = (x['price'] / ref - 1) * 100
        if abs(x['devPct']) >= 30:
            x['suspectTickerCollision'] = True; collisions.append({'asset': s, 'source': x['src'], 'price': x['price'], 'ref': ref, 'devPct': round(x['devPct'], 1)}); continue
        thin_dex = x['kind'] == 'dex' and (x.get('poolLiqUsd') or 0) < 50000 and x['src'] != 'jupiter'
        if abs(x['devPct']) / 100 > t and not thin_dex and not (x['kind'] == 'cex' and len(cexp) < 3) and not (x['kind'] == 'lending_oracle' and s in STABLES):
            typ = {'oracle': 'oracle_deviation', 'lending_oracle': 'lending_oracle_deviation', 'dex': 'dex_dislocation', 'cex': 'cex_outlier'}[x['kind']]
            sev = 'high' if abs(x['devPct']) / 100 > 2 * t else 'medium'
            dust = x['kind'] == 'lending_oracle' and (x.get('reserveSupplyUsd') or 0) < 10000
            if dust: sev = 'low'
            flag(s, typ, sev, x['src'], ('[dust reserve, supply $%.0f - price probably not refreshed] ' % (x.get('reserveSupplyUsd') or 0) if dust else '') + f"{x['src']} {x['price']:.6g} vs {refsrc} {ref:.6g} ({x['devPct']:+.2f}%, threshold {t*100:.0f}%)", devPct=round(x['devPct'], 3), thresholdPct=t * 100)
        if x['kind'] in ('oracle', 'lending_oracle'): mx = max(mx, abs(x['devPct']))
    # staleness
    for x in srcs:
        up = x.get('updatedAt')
        if not up: continue
        age = (NOWMS - up) / 1000; x['ageS'] = round(age)
        if x['src'] == 'chainlink' and x.get('heartbeatS') and age > x['heartbeatS'] * 1.05 + 120:
            x['stale'] = True; flag(s, 'stale_oracle', 'high' if age > 2 * x['heartbeatS'] else 'medium', 'chainlink', f"Chainlink {x['feed']} last update {age/3600:.2f}h ago > heartbeat {x['heartbeatS']/3600:.2f}h", ageS=round(age), heartbeatS=x['heartbeatS'])
        elif x['src'] == 'pyth' and age > 600:
            x['stale'] = True; flag(s, 'stale_oracle', 'high' if age > 3600 else 'medium', 'pyth', f'Pyth Solana push feed last publish {age/60:.0f} min ago (>10 min)', ageS=round(age))
        elif x['src'] == 'redstone' and age > 600:
            x['stale'] = True; flag(s, 'stale_oracle', 'medium', 'redstone', f'RedStone price {age/60:.0f} min old (>10 min)', ageS=round(age))
        if x['src'] == 'pyth' and (x.get('confPct') or 0) > 2:
            flag(s, 'wide_confidence', 'low', 'pyth', f"Pyth confidence ±{x['confPct']:.2f}% of price (publishers disagree / thin market)", confPct=round(x['confPct'], 3))
    rows.append({'sym': s, 'roles': sorted(a['roles']), 'ref': ref, 'refSource': refsrc, 'thresholdPct': t * 100, 'maxOracleDevPct': round(mx, 3), 'nSources': len(srcs), 'sources': srcs,
                 'lending': a['lending'], 'cexCount': len(cexp)})

# ---------- thin pools behind lending collateral ----------
def is_wrapped(sym):
    s = U(sym)
    return bool(re.search(r'(SOL|ETH|BTC|XRP|USD|BNB)$', s) and s not in ('SOL', 'ETH', 'BTC', 'XRP', 'BNB')) or s.startswith(('PT-', 'ST', 'W', 'CB', 'SY')) and len(s) > 3 or s in ('JLP', 'INF', 'PAXG', 'XAUT', 'SYRUPUSDC', 'SDEUSD')


thin = []
for r in rows:
    a = assets[r['sym']]
    if 'collateral' not in a['roles'] or U(r['sym']) in STABLES or 'USD' in U(r['sym']) or not re.fullmatch(r'[A-Z0-9.\-]+', U(r['sym'])): continue
    byc = {}
    for l in a['lending']: byc[l.get('chain')] = byc.get(l.get('chain'), 0) + (l.get('exposureUsd') or 0)
    for ch, exp in byc.items():
        if exp < 1e6: continue
        d = (DX.get(r['sym']) or {}).get(ch)
        if not d: continue
        L = d['poolLiqUsd'] or 0
        cost10 = L / 2 * (math.sqrt(1.10) - 1); cost50 = L / 2 * (math.sqrt(1.5) - 1)
        ratio = exp / cost10 if cost10 else None
        oracle_types = sorted({l.get('oracleType') or l.get('oracleName') or l['protocol'] for l in a['lending'] if l.get('chain') == ch})
        wrapped = is_wrapped(r['sym'])
        sev = None
        if wrapped: sev = None
        elif r['cexCount'] >= 3: sev = 'low' if (L < 1e6 or (ratio and ratio > 50)) else None
        elif L < 250e3 or (ratio and ratio > 200): sev = 'high' if r['cexCount'] == 0 else 'medium'
        elif L < 1e6 or (ratio and ratio > 50): sev = 'medium' if r['cexCount'] == 0 else 'low'
        e = {'asset': r['sym'], 'chain': ch, 'collateralExposureUsd': exp, 'deepestPool': d['pool'], 'dex': d['dex'], 'poolLiqUsd': L, 'totalDexLiqUsd': d['totalLiqUsd'],
             'pools': d['pools'], 'costToPush10PctUsd': cost10, 'costToPush50PctUsd': cost50, 'exposureToCost10': ratio, 'cexListings': r['cexCount'], 'lendingOracles': oracle_types, 'severity': sev, 'wrappedOrLst': wrapped,
             'note': 'LST/LRT/wrapped/yield token: lending oracles normally price it from the underlying feed x exchange rate, so DEX pushes do not move the oracle; thin DEX depth still limits liquidations' if wrapped else None}
        thin.append(e)
        if sev:
            flag(r['sym'], 'thin_dex_liquidity', sev, f'dex:{ch}:{d["dex"]}', f"${exp/1e6:.1f}M lent against {r['sym']} on {ch}; deepest pool ${L/1e3:.0f}K liq -> ~${cost10/1e3:.0f}K pushes it +10% (CPMM est.); {r['cexCount']} CEX listings", chain=ch)
thin.sort(key=lambda e: -(e['exposureToCost10'] or 0))

# ---------- TWAP vs spot on the collateral pools most at risk + all collateral pools with highest exposure ----------
tw = []
cand = ([e for e in thin if e['deepestPool'] and e['severity']] + [e for e in thin if e['deepestPool'] and not e['severity']])[:14]
for e in cand:
    try:
        t = twap(e['chain'], e['deepestPool'], (assets[e['asset']]['addrs'] or {}).get(e['chain']))
    except Exception as ex:
        ctx.err('gt twap ' + e['asset'], ex); continue
    if not t: continue
    spot = (DX.get(e['asset']) or {}).get(e['chain'], {}).get('priceUsd')
    dev = (spot / t['twap2h'] - 1) * 100 if spot and t['twap2h'] else None
    row = dict(t, asset=e['asset'], chain=e['chain'], pool=e['deepestPool'], spot=spot, spotVsTwapPct=dev)
    tw.append(row); e['twap'] = row
    if dev is not None and abs(dev) / 100 > thr(e['asset']):
        flag(e['asset'], 'dex_twap_spike', 'medium', f"dex:{e['chain']}", f"{e['asset']} DEX spot {spot:.6g} vs 2h TWAP {t['twap2h']:.6g} ({dev:+.2f}%)", devPct=round(dev, 2))

SEV = {'high': 0, 'medium': 1, 'low': 2}
flags.sort(key=lambda f: (SEV.get(f['severity'], 3), f['type']))
doc = {'generatedAt': NOWMS, 'elapsedS': round(time.time() - T0, 1), 'universe': len(rows), 'usdtUsd': USDT,
       'coverage': {'chainlink': len(CL), 'pyth': len(PY), 'pythListedCrypto': getattr(ctx, 'pythListed', None), 'pythMode': 'Solana sponsored push feeds (Hermes latest-price endpoints need a key now)', 'redstone': len(RS), 'cex': CEXN, 'dexAssets': len(DX), 'jupiter': len(JUP), 'lendingReserves': lend.get('sources')},
       'thresholds': {'majorsPct': 2, 'altsPct': 5, 'stablesPct': 1, 'pythStaleS': 120, 'redstoneStaleS': 600, 'chainlink': 'heartbeat*1.05+120s'},
       'summary': {'flags': len(flags), 'byType': {t: sum(1 for f in flags if f['type'] == t) for t in sorted({f['type'] for f in flags})}, 'high': sum(1 for f in flags if f['severity'] == 'high')},
       'flags': flags, 'tickerCollisions': collisions, 'pythInactiveFeeds': inactive, 'thinPools': thin, 'twap': tw, 'assets': rows,
       'unavailable': {'switchboard': 'crossbar.switchboard.xyz unreachable; on-chain Switchboard pull feeds need per-feed account decoding (not done)',
                       'chainlink_other_chains': 'only Ethereum mainnet proxies are read', 'marginfi': (lend.get('unavailable') or {}).get('marginfi')},
       'method': __doc__, 'errors': ctx.errors, 'calls': ctx.calls}
writej('riskinfra_oracles.json', doc)
hist = readj('riskinfra_oracles_history.json', {'runs': []}) or {'runs': []}
hist['runs'] = (hist['runs'] + [{'t': NOWMS, 'flags': len(flags), 'byType': doc['summary']['byType'], 'maxDev': max([r['maxOracleDevPct'] for r in rows] or [0])}])[-500:]
writej('riskinfra_oracles_history.json', hist)
print(json.dumps({'elapsed': doc['elapsedS'], 'coverage': doc['coverage'], 'summary': doc['summary'], 'errors': len(ctx.errors)}, default=str))
