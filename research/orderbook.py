#!/usr/bin/env python3
"""Historical thin-book / transient-wall study from FREE Binance USDT-M archives (data.binance.vision).

`bookDepth` daily files: every ~30 s, cumulative bid/ask depth (coins + USD notional) within ±0.2/1/2/3/4/5 % of mid (since 2023).
`klines 1m` daily files: price path for forward returns.
This is coarse (30 s snapshots, cumulative bands): individual spoof orders, cancels and queue positions are NOT visible; it supports
  (a) THIN-BOOK test: USD depth within ±1 % drops to z <= -3 vs the prior 30 min (log scale) AND < 50 % of its 30-min median
      -> forward |return| 15/60 min vs all other snapshots, and does it show up more often in the 6 h before crash days' steepest hour?
  (b) TRANSIENT-WALL proxy: the 1-2 % band on one side jumps >= 3x its 30-min median and is gone (< 1.5x) within 2 snapshots (<= 60 s)
      without price reaching the band -> forward signed return (toward / away from the wall side) vs control.
Days: crash days (daily close-to-close <= -15 %) for catalog tokens with Binance perps + priority tokens, plus random calm days.
Writes data/orderbook_history.json. Not financial advice.
"""
import csv, io, json, math, os, random, re, sys, time, urllib.request, zipfile, datetime as dt
from concurrent.futures import ThreadPoolExecutor
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get('DATA_DIR', os.path.join(ROOT, 'data'))
CACHE = os.environ.get('BV_CACHE', '/workspace/cache/bv')
BV = 'https://data.binance.vision'
UA = {'User-Agent': 'Mozilla/5.0 (asymmetric-terminal research)'}
random.seed(11)
PRIORITY = ['NEAR', 'ZEC', 'STRK', 'BTC', 'ETH', 'SOL']

def zrows(name, url):
    p = os.path.join(CACHE, name)
    if not os.path.exists(p):
        try: b = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40).read()
        except Exception: b = b''
        open(p, 'wb').write(b)
    b = open(p, 'rb').read()
    if not b: return None
    try:
        z = zipfile.ZipFile(io.BytesIO(b)); return list(csv.reader(io.StringIO(z.read(z.namelist()[0]).decode())))
    except Exception: return None

def book(sym, day):
    r = zrows(f'bd_{sym}_{day}.zip', f'{BV}/data/futures/um/daily/bookDepth/{sym}/{sym}-bookDepth-{day}.zip')
    if not r: return None
    S = {}
    for x in r[1:]:
        try: S.setdefault(x[0], {})[float(x[1])] = float(x[3])
        except Exception: pass
    out = []
    for ts in sorted(S):
        d = S[ts]
        if all(k in d for k in (-1.0, 1.0, -2.0, 2.0)):
            t = int(dt.datetime.strptime(ts, '%Y-%m-%d %H:%M:%S').replace(tzinfo=dt.timezone.utc).timestamp())
            out.append((t, d[-1.0] + d[1.0], d[-2.0] - d[-1.0], d[2.0] - d[1.0]))
    return out
def k1m(sym, day):
    r = zrows(f'k1m_{sym}_{day}.zip', f'{BV}/data/futures/um/daily/klines/{sym}/1m/{sym}-1m-{day}.zip')
    if not r: return None
    out = {}
    for x in r:
        try:
            t = int(x[0]); t = t // 1000 if t > 1e14 else t  # µs since 2025 in some archives
            out[t // 1000 // 60 * 60] = (float(x[2]), float(x[3]), float(x[4]))
        except Exception: pass
    return out

def med(a):
    a = sorted(a); n = len(a)
    return None if not n else a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2
def ncdf(z): return 0.5 * (1 + math.erf(z / math.sqrt(2)))
def mw(a, b):
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
    return {'n1': n1, 'n2': n2, 'median_a': round(med(a), 3), 'median_b': round(med(b), 3), 'auc': round(u / (n1 * n2), 3), 'p': round(2 * (1 - ncdf(abs(z))), 6)}
def prop(x1, n1, x2, n2):
    if not n1 or not n2: return None
    p1, p2 = x1 / n1, x2 / n2; p = (x1 + x2) / (n1 + n2); se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)) if 0 < p < 1 else 0
    z = (p1 - p2) / se if se else 0
    return {'a': f'{x1}/{n1}', 'b': f'{x2}/{n2}', 'pctA': round(100 * p1, 1), 'pctB': round(100 * p2, 1), 'lift': round(p1 / p2, 2) if p2 else None, 'p': round(2 * (1 - ncdf(abs(z))), 6)}

def fwd(K, t, mins):
    m0 = t // 60 * 60; a = K.get(m0); b = K.get(m0 + mins * 60)
    return (b[2] / a[2] - 1) * 100 if a and b else None

def day_study(sym, day, kind):
    B, K = book(sym, day), k1m(sym, day)
    if not B or not K or len(B) < 400: return None
    thin, walls, ctrl = [], [], []
    last_thin = -1e9
    worst = None  # steepest 60-min drop in the day
    ks = sorted(K)
    for i in range(len(ks) - 60):
        r = K[ks[i + 60]][2] / K[ks[i]][2] - 1
        if worst is None or r < worst[0]: worst = (r, ks[i])
    for i in range(60, len(B) - 2):
        t, d1, bb, ab = B[i]
        win = B[i - 60:i]
        L = [math.log(max(x[1], 1)) for x in win]; m = sum(L) / len(L); sd = math.sqrt(sum((x - m) ** 2 for x in L) / len(L)) or 1e-9
        z = (math.log(max(d1, 1)) - m) / sd; mdd = med([x[1] for x in win])
        f15, f60 = fwd(K, t, 15), fwd(K, t, 60)
        if f15 is None or f60 is None: continue
        if i % 20 == 0: ctrl.append({'t': t, 'f15': f15, 'f60': f60})
        if z <= -3 and d1 < 0.5 * mdd and t - last_thin > 1800:
            last_thin = t; thin.append({'t': t, 'z': round(z, 2), 'drop': round(d1 / mdd, 3), 'f15': f15, 'f60': f60})
        for side, idx in (('bid', 2), ('ask', 3)):
            mb = med([x[idx] for x in win]) or 0
            if mb > 0 and B[i][idx] >= 3 * mb and B[i][idx] - mb >= 50e3 and (B[i + 1][idx] < 1.5 * mb or B[i + 2][idx] < 1.5 * mb):
                walls.append({'t': t, 'side': side, 'size_x': round(B[i][idx] / mb, 2), 'usd': round(B[i][idx] - mb), 'f15': f15, 'f60': f60})
    pre = None
    if worst:
        w0 = worst[1]; pre = any(w0 - 6 * 3600 <= e['t'] < w0 for e in thin)
    return {'sym': sym, 'day': day, 'kind': kind, 'thin': thin, 'walls': walls, 'ctrl': ctrl, 'thin_before_worst_hour': pre, 'worst_1h_pct': round(worst[0] * 100, 2) if worst else None}

def main():
    t0 = time.time()
    days = []
    perps = set()
    for f in os.listdir(CACHE):
        m = re.match(r'k_(.+)\.json$', f)
        if m: perps.add(m.group(1))
    for s in PRIORITY: perps.add(f'{s}USDT')
    for sym in sorted(perps):
        p = os.path.join(CACHE, f'k_{sym}.json')
        rows = json.load(open(p)) if os.path.exists(p) else []
        if not rows:
            try:
                d = json.loads(urllib.request.urlopen(urllib.request.Request(f'https://www.binance.com/fapi/v1/klines?symbol={sym}&interval=1d&limit=1000', headers=UA), timeout=30).read())
                rows = [(dt.datetime.fromtimestamp(x[0] / 1000, dt.timezone.utc).strftime('%Y-%m-%d'), float(x[1]), float(x[2]), float(x[3]), float(x[4])) for x in d]
            except Exception: rows = []
        R = [(rows[i][0], rows[i][4] / rows[i - 1][4] - 1) for i in range(1, len(rows)) if rows[i][0] >= '2023-01-02']
        crash = [d for d, r in R if r <= -0.15]; calm = [d for d, r in R if abs(r) < 0.03]
        for d in random.sample(crash, min(3, len(crash))): days.append((sym, d, 'crash'))
        for d in random.sample(calm, min(2 if crash else 1, len(calm))): days.append((sym, d, 'calm'))
    print('days', len(days), 'symbols', len(perps), file=sys.stderr)
    with ThreadPoolExecutor(10) as ex: D = [x for x in ex.map(lambda a: day_study(*a), days) if x]
    thin = [e for d in D for e in d['thin']]; walls = [e for d in D for e in d['walls']]; ctrl = [e for d in D for e in d['ctrl']]
    A = lambda L, k: [abs(e[k]) for e in L]
    bw = [e for e in walls if e['side'] == 'bid']; aw = [e for e in walls if e['side'] == 'ask']
    C = [d for d in D if d['kind'] == 'crash' and d['thin_before_worst_hour'] is not None]; Q = [d for d in D if d['kind'] == 'calm' and d['thin_before_worst_hour'] is not None]
    res = {'n_days': len(D), 'n_symbols': len({d['sym'] for d in D}), 'n_crash_days': sum(d['kind'] == 'crash' for d in D), 'n_thin_events': len(thin), 'n_transient_walls': len(walls), 'n_control_snapshots': len(ctrl),
           'thin_abs_fwd15': mw(A(thin, 'f15'), A(ctrl, 'f15')), 'thin_abs_fwd60': mw(A(thin, 'f60'), A(ctrl, 'f60')),
           'thin_book_in_6h_before_steepest_hour_crash_vs_calm': prop(sum(d['thin_before_worst_hour'] for d in C), len(C), sum(d['thin_before_worst_hour'] for d in Q), len(Q)),
           'thin_events_per_day_crash_vs_calm': {'crash': round(sum(len(d['thin']) for d in D if d['kind'] == 'crash') / max(1, sum(d['kind'] == 'crash' for d in D)), 2), 'calm': round(sum(len(d['thin']) for d in D if d['kind'] == 'calm') / max(1, sum(d['kind'] == 'calm' for d in D)), 2)},
           'bid_wall_fwd60_signed': mw([e['f60'] for e in bw], [e['f60'] for e in ctrl]), 'ask_wall_fwd60_signed': mw([e['f60'] for e in aw], [e['f60'] for e in ctrl]),
           'wall_abs_fwd15': mw(A(walls, 'f15'), A(ctrl, 'f15')),
           'caveat': '30-second cumulative bands: cannot see individual orders, cancels vs fills, or sub-30s flicker; transient-wall is a proxy only. Events within a day are not independent.'}
    out = {'generatedAt': int(time.time() * 1000), 'elapsed_s': round(time.time() - t0, 1), 'source': 'data.binance.vision futures/um/daily/bookDepth (30 s, ±0.2..5 % cumulative) + klines 1m', 'results': res,
           'paid_l2_sources': [{'source': 'Tardis.dev (tick L2 / book snapshots)', 'cost': 'from $350/mo Academic, Solo $700/mo, Pro $1,000/mo, Business $3,000+/mo; free: first day of each month without a key (verified HTTP 200 for binance-futures book_snapshot_25 2026-10-01)'},
                               {'source': 'Kaiko order book data', 'cost': 'enterprise quote'}, {'source': 'CoinAPI order book (flat files / REST)', 'cost': 'paid plans (metered), L2 history on higher tiers'},
                               {'source': 'CoinGlass L2/L3 order book history', 'cost': 'Standard $299/mo+ (1m interval 6 days history), Professional $699/mo'}],
           'sample_thin': sorted(thin, key=lambda e: e['z'])[:20]}
    json.dump(out, open(os.path.join(DATA, 'orderbook_history.json'), 'w'))
    print(json.dumps(res, indent=1))

if __name__ == '__main__':
    main()
