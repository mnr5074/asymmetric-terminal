#!/usr/bin/env python3
"""Historical cross-exchange price gap study (free public klines only).

For every perp-universe token (data/perps_universe.json / perps.json) pull ~1 year of DAILY candles from:
  spot: Binance (data-api.binance.vision), OKX, Gate, Coinbase (USD), Kraken (USD)   perps: Binance (www.binance.com/fapi), OKX swap, Gate futures, Hyperliquid
USD venues are converted to USDT with Kraken's daily USDT/USD close. Venue-days with < $50K quote volume are dropped.
Daily measures (spot venues compared with spot, perps with perps; needs >= 2 venues):
  close gap  = max |venue close / median close - 1|  (gap day if > 2%)
  wick gap   = max |venue high / median high - 1| or low equivalent (wick day if > 5%) = one venue spiking alone
Test: rolling 30-day anchors. Feature = share of gap days in the prior 60 days. Outcome over the next 30 days on the median series:
  pump = max high >= +50% above anchor close, dump = min low <= -40%, plus the 30d return. Gap-prone (>= 10% gap days) vs aligned (0 gap days).
Plus a token-level Spearman (one row per token) to avoid counting the same token many times.
Writes data/pricegaps_history.json. Not financial advice.
"""
import json, math, os, random, sys, time, urllib.request, datetime as dt
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get('DATA_DIR', os.path.join(ROOT, 'data'))
UA = {'User-Agent': 'Mozilla/5.0 (asymmetric-terminal research)'}
DAYS = 400
GAP, WICK, MINVOL = 2.0, 5.0, 50e3

def get(url, timeout=25, tries=3):
    for i in range(tries):
        try:
            return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read())
        except urllib.error.HTTPError as e:
            if e.code in (400, 403, 404, 451): return None
            time.sleep(1 + 2 * i)
        except Exception:
            time.sleep(1 + 2 * i)
    return None

D = lambda ms: dt.datetime.utcfromtimestamp(ms / 1000).strftime('%Y-%m-%d')

def binance_spot(s):
    d = get(f'https://data-api.binance.vision/api/v3/klines?symbol={s}USDT&interval=1d&limit=1000')
    return {D(x[0]): (float(x[2]), float(x[3]), float(x[4]), float(x[7])) for x in d or []}
def binance_perp(s, c, m):
    d = get(f'https://www.binance.com/fapi/v1/klines?symbol={c}&interval=1d&limit={DAYS}')
    return {D(x[0]): (float(x[2]) / m, float(x[3]) / m, float(x[4]) / m, float(x[7])) for x in d or []}
def okx(inst):
    out, after = {}, ''
    for _ in range(5):
        d = get(f'https://www.okx.com/api/v5/market/history-candles?instId={inst}&bar=1Dutc&limit=100' + (f'&after={after}' if after else ''))
        rows = (d or {}).get('data') or []
        if not rows: break
        for x in rows: out[D(int(x[0]))] = (float(x[2]), float(x[3]), float(x[4]), float(x[7]))
        after = rows[-1][0]; time.sleep(0.12)
    return out
def okx_spot(s): return okx(f'{s}-USDT')
def okx_perp(s, c, m):
    o = okx(c); return {k: (h / m, l / m, cl / m, v) for k, (h, l, cl, v) in o.items()}
def gate_spot(s):
    d = get(f'https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair={s}_USDT&interval=1d&limit={DAYS}')
    return {D(int(x[0]) * 1000): (float(x[3]), float(x[4]), float(x[2]), float(x[1])) for x in d or []}
def gate_perp(s, c, m):
    d = get(f'https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract={c}&interval=1d&limit={DAYS}')
    return {D(int(x['t']) * 1000): (float(x['h']) / m, float(x['l']) / m, float(x['c']) / m, float(x.get('sum') or 0)) for x in d or []}
def hl_perp(s, c, m):
    now = int(time.time() * 1000)
    try:
        req = urllib.request.Request('https://api.hyperliquid.xyz/info', data=json.dumps({'type': 'candleSnapshot', 'req': {'coin': c, 'interval': '1d', 'startTime': now - DAYS * 864e5, 'endTime': now}}).encode(), headers={'content-type': 'application/json', **UA})
        d = json.loads(urllib.request.urlopen(req, timeout=25).read())
    except Exception:
        return {}
    return {D(x['t']): (float(x['h']) / m, float(x['l']) / m, float(x['c']) / m, float(x['v']) * float(x['c'])) for x in d or []}
def coinbase(s, usdt):
    out = {}; end = int(time.time())
    for _ in range(2):
        start = end - 299 * 86400
        d = get(f'https://api.exchange.coinbase.com/products/{s}-USD/candles?granularity=86400&start={dt.datetime.utcfromtimestamp(start).isoformat()}&end={dt.datetime.utcfromtimestamp(end).isoformat()}')
        if not d: break
        for t, lo, hi, op, cl, v in d:
            k = D(t * 1000); u = usdt.get(k, 1.0); out[k] = (hi / u, lo / u, cl / u, v * cl)
        end = start - 86400; time.sleep(0.15)
    return out
KR = {}
def kraken(s, usdt):
    pair = KR.get(s)
    if not pair: return {}
    d = get(f'https://api.kraken.com/0/public/OHLC?pair={pair}&interval=1440')
    if not d or d.get('error'): return {}
    rows = [v for k, v in d['result'].items() if k != 'last'][0]
    out = {}
    for x in rows:
        k = D(int(x[0]) * 1000); u = usdt.get(k, 1.0); out[k] = (float(x[2]) / u, float(x[3]) / u, float(x[4]) / u, float(x[6]) * float(x[4]))
    return out

def med(a):
    a = sorted(a); n = len(a)
    return None if not n else a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2
def ncdf(z): return 0.5 * (1 + math.erf(z / math.sqrt(2)))
def prop_test(x1, n1, x2, n2):
    if not n1 or not n2: return None
    p1, p2 = x1 / n1, x2 / n2; p = (x1 + x2) / (n1 + n2); se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)) if 0 < p < 1 else 0
    z = (p1 - p2) / se if se else 0
    return {'a': f'{x1}/{n1}', 'b': f'{x2}/{n2}', 'pctA': round(100 * p1, 1), 'pctB': round(100 * p2, 1), 'diff_pp': round(100 * (p1 - p2), 1), 'lift': round(p1 / p2, 2) if p2 else None, 'p': round(2 * (1 - ncdf(abs(z))), 6)}
def mannwhitney(a, b):
    n1, n2 = len(a), len(b)
    if n1 < 3 or n2 < 3: return None
    allv = sorted([(v, 0) for v in a] + [(v, 1) for v in b]); ranks = [0.0] * len(allv); i = 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]: j += 1
        for k in range(i, j + 1): ranks[k] = (i + j) / 2 + 1
        i = j + 1
    r1 = sum(r for r, (v, g) in zip(ranks, allv) if g == 0); u = r1 - n1 * (n1 + 1) / 2
    sd = math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12); z = (u - n1 * n2 / 2) / sd if sd else 0
    return {'n1': n1, 'n2': n2, 'auc': round(u / (n1 * n2), 3), 'median_a': round(med(a), 2), 'median_b': round(med(b), 2), 'p': round(2 * (1 - ncdf(abs(z))), 6)}
def spearman(x, y):
    n = len(x)
    if n < 6: return None
    def rk(a):
        o = sorted(range(n), key=lambda i: a[i]); r = [0.0] * n; i = 0
        while i < n:
            j = i
            while j + 1 < n and a[o[j + 1]] == a[o[i]]: j += 1
            for k in range(i, j + 1): r[o[k]] = (i + j) / 2
            i = j + 1
        return r
    rx, ry = rk(x), rk(y); mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry)); sx = math.sqrt(sum((a - mx) ** 2 for a in rx)); sy = math.sqrt(sum((b - my) ** 2 for b in ry))
    rho = cov / (sx * sy) if sx and sy else 0; z = rho * math.sqrt(n - 1)
    return {'rho': round(rho, 3), 'n': n, 'p': round(2 * (1 - ncdf(abs(z))), 6)}

def one(tok, usdt, cb):
    s = tok['sym']; V = tok.get('venues', {})
    spot = {'binance': binance_spot(s), 'okx': okx_spot(s), 'gate': gate_spot(s), 'kraken': kraken(s, usdt)}
    if s in cb: spot['coinbase'] = coinbase(s, usdt)
    perp = {}
    for v, f in (('binance', binance_perp), ('okx', okx_perp), ('gate', gate_perp), ('hyperliquid', hl_perp)):
        if v in V: perp[v] = f(s, V[v]['contract'], V[v].get('mult') or 1)
    days = sorted(set(k for g in (spot, perp) for m in g.values() for k in m))
    today = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d')
    rows = []
    for d in days:
        if d >= today: continue
        r = {'d': d}
        for name, g in (('spot', spot), ('perp', perp)):
            q = [(v, m[d]) for v, m in g.items() if d in m and m[d][3] >= MINVOL and m[d][2] > 0]
            if len(q) >= 2:
                mc = med([x[2] for _, x in q]); mh = med([x[0] for _, x in q]); ml = med([x[1] for _, x in q])
                cg = max(q, key=lambda vx: abs(vx[1][2] / mc - 1)); r[name + '_gap'] = abs(cg[1][2] / mc - 1) * 100; r[name + '_gapv'] = cg[0]
                r[name + '_wick'] = max(max(abs(x[0] / mh - 1), abs(x[1] / ml - 1)) for _, x in q) * 100
                r[name + '_n'] = len(q)
            if q and name == 'spot' or (q and 'mc' not in r):
                r['mc'] = med([x[2] for _, x in q]); r['mh'] = med([x[0] for _, x in q]); r['ml'] = med([x[1] for _, x in q])
        if 'mc' in r: rows.append(r)
    return s, rows, {k: len(v) for k, v in spot.items()}, {k: len(v) for k, v in perp.items()}

def main():
    t0 = time.time()
    try: toks = json.load(open(os.path.join(DATA, 'perps.json')))['tokens']
    except Exception: toks = []
    stats = {}
    try: stats = json.load(open(os.path.join(DATA, 'perps_universe.json')))
    except Exception: pass
    # contract + multiplier per venue from the live perp snapshot
    U = []
    for t in toks:
        vs = {}
        for v in t.get('venues', []):
            c = v['contract']; m = 1e6 if c.startswith('1000000') else 1000 if c.startswith('1000') or (v['venue'] == 'hyperliquid' and c.startswith('k')) else 1
            vs[v['venue']] = {'contract': c, 'mult': m}
        U.append({'sym': t['sym'], 'venues': vs})
    if len(sys.argv) > 1: U = U[:int(sys.argv[1])]
    kr = get('https://api.kraken.com/0/public/AssetPairs') or {}
    for k, v in (kr.get('result') or {}).items():
        b, _, q = (v.get('wsname') or '').partition('/')
        if q == 'USD': KR[{'XBT': 'BTC', 'XDG': 'DOGE'}.get(b, b)] = k
    usdt = {}
    d = get('https://api.kraken.com/0/public/OHLC?pair=USDTZUSD&interval=1440') or {}
    for k, rows in (d.get('result') or {}).items():
        if k != 'last':
            for x in rows: usdt[D(int(x[0]) * 1000)] = float(x[4])
    cbp = get('https://api.exchange.coinbase.com/products') or []
    cb = {p['base_currency'] for p in cbp if p.get('quote_currency') == 'USD' and p.get('status') == 'online'}
    print('tokens', len(U), 'kraken pairs', len(KR), 'coinbase', len(cb), 'usdt days', len(usdt), file=sys.stderr)
    with ThreadPoolExecutor(6) as ex: res = list(ex.map(lambda t: one(t, usdt, cb), U))
    per_token, panel = {}, []
    for s, rows, sc, pc in res:
        if len(rows) < 90: continue
        gd = [r for r in rows if 'spot_gap' in r or 'perp_gap' in r]
        isgap = lambda r: r.get('spot_gap', 0) > GAP or r.get('perp_gap', 0) > GAP
        iswick = lambda r: r.get('spot_wick', 0) > WICK or r.get('perp_wick', 0) > WICK
        if not gd: continue
        venues_g = {}
        for r in gd:
            if isgap(r):
                v = r.get('spot_gapv') if r.get('spot_gap', 0) > GAP else r.get('perp_gapv'); venues_g[v] = venues_g.get(v, 0) + 1
        # monthly pump/dump counts for token-level analysis + anchor panel
        idx = {r['d']: i for i, r in enumerate(rows)}
        pumps = dumps = anchors = 0
        for i in range(60, len(rows) - 30, 30):
            past = [r for r in rows[i - 60:i] if 'spot_gap' in r or 'perp_gap' in r]
            if len(past) < 30: continue
            g1share = sum(1 for r in past if r.get('spot_gap', 0) > 1 or r.get('perp_gap', 0) > 1) / len(past) * 100
            gshare = sum(map(isgap, past)) / len(past) * 100; wshare = sum(map(iswick, past)) / len(past) * 100
            c0 = rows[i]['mc']; fut = rows[i + 1:i + 31]
            mx = max(r['mh'] for r in fut) / c0 - 1; mn = min(r['ml'] for r in fut) / c0 - 1; ret = fut[-1]['mc'] / c0 - 1
            pump, dump = mx >= 0.5, mn <= -0.4
            pumps += pump; dumps += dump; anchors += 1
            panel.append({'sym': s, 'd': rows[i]['d'], 'gap_share': gshare, 'gap1_share': g1share, 'wick_share': wshare, 'pump': pump, 'dump': dump, 'ret30': ret * 100, 'absret30': abs(ret) * 100, 'maxup': mx * 100, 'maxdn': mn * 100})
        per_token[s] = {'days': len(gd), 'gapDayPct': round(sum(map(isgap, gd)) / len(gd) * 100, 2), 'wickDayPct': round(sum(map(iswick, gd)) / len(gd) * 100, 2),
                        'medianSpotGap': round(med([r['spot_gap'] for r in gd if 'spot_gap' in r]) or 0, 3), 'gapVenues': venues_g, 'spotVenues': sc, 'perpVenues': pc,
                        'pumpRate': round(pumps / anchors * 100, 1) if anchors else None, 'dumpRate': round(dumps / anchors * 100, 1) if anchors else None, 'anchors': anchors,
                        'recentGapDays': [r['d'] for r in gd if isgap(r)][-5:]}
    hi = [p for p in panel if p['gap_share'] >= 10]; lo = [p for p in panel if p['gap_share'] == 0]; mid = [p for p in panel if 0 < p['gap_share'] < 10]
    g1hi = [p for p in panel if p['gap1_share'] >= 20]; g1lo = [p for p in panel if p['gap1_share'] == 0]
    whi = [p for p in panel if p['wick_share'] >= 10]; wlo = [p for p in panel if p['wick_share'] == 0]
    T = lambda A, B, k: prop_test(sum(p[k] for p in A), len(A), sum(p[k] for p in B), len(B))
    tl = [(v['gapDayPct'], v['pumpRate'], v['dumpRate'], v['wickDayPct']) for v in per_token.values() if v['anchors'] >= 3]
    out = {'generatedAt': int(time.time() * 1000), 'elapsed_s': round(time.time() - t0, 1),
           'method': f'daily candles, ~{DAYS} days; gap day = some venue close > {GAP}% from the cross-venue median (spot vs spot, perp vs perp, >= 2 venues with >= $50K volume); wick day = a venue high/low > {WICK}% from the median high/low. Anchors every 30 days; feature = share of gap days in prior 60 days; pump = +50% max within next 30 days; dump = -40% min within next 30 days.',
           'n_tokens': len(per_token), 'n_anchors': len(panel),
           'tests': {
               'gap_prone_ge10pct_vs_zero': {'n_hi': len(hi), 'n_lo': len(lo), 'n_mid': len(mid), 'pump': T(hi, lo, 'pump'), 'dump': T(hi, lo, 'dump'),
                                              'absret30_mw': mannwhitney([p['absret30'] for p in hi], [p['absret30'] for p in lo]), 'ret30_mw': mannwhitney([p['ret30'] for p in hi], [p['ret30'] for p in lo])},
               'any_gap_vs_zero': {'pump': T(hi + mid, lo, 'pump'), 'dump': T(hi + mid, lo, 'dump'), 'absret30_mw': mannwhitney([p['absret30'] for p in hi + mid], [p['absret30'] for p in lo])},
               'sensitivity_gap1pct_ge20pct_days_vs_zero': {'n_hi': len(g1hi), 'n_lo': len(g1lo), 'pump': T(g1hi, g1lo, 'pump'), 'dump': T(g1hi, g1lo, 'dump'), 'absret30_mw': mannwhitney([p['absret30'] for p in g1hi], [p['absret30'] for p in g1lo])},
               'wick_prone_ge10pct_vs_zero': {'n_hi': len(whi), 'n_lo': len(wlo), 'pump': T(whi, wlo, 'pump'), 'dump': T(whi, wlo, 'dump'), 'absret30_mw': mannwhitney([p['absret30'] for p in whi], [p['absret30'] for p in wlo])},
               'token_level_spearman': {'gapDayPct_vs_pumpRate': spearman([x[0] for x in tl], [x[1] for x in tl]), 'gapDayPct_vs_dumpRate': spearman([x[0] for x in tl], [x[2] for x in tl]),
                                        'wickDayPct_vs_pumpRate': spearman([x[3] for x in tl], [x[1] for x in tl]), 'wickDayPct_vs_dumpRate': spearman([x[3] for x in tl], [x[2] for x in tl])},
               'caveat': 'anchors from the same token are not independent (p-values optimistic); token-level Spearman is the conservative check; survivorship: only tokens still listed today.'},
           'base_rates': {'pump': round(100 * sum(p['pump'] for p in panel) / max(1, len(panel)), 1), 'dump': round(100 * sum(p['dump'] for p in panel) / max(1, len(panel)), 1)},
           'tokens': per_token}
    json.dump(out, open(os.path.join(DATA, 'pricegaps_history.json'), 'w'))
    print(json.dumps({k: v for k, v in out.items() if k != 'tokens'}, indent=1))
    top = sorted(per_token.items(), key=lambda kv: -kv[1]['gapDayPct'])[:15]
    for s, v in top: print(s, v['gapDayPct'], v['wickDayPct'], v['gapVenues'], v['pumpRate'], v['dumpRate'])

if __name__ == '__main__':
    main()
