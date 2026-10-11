#!/usr/bin/env python3
"""Historical liquidation / OI-flush study vs the crash catalog (free data only).

Sources (all free, no keys):
  * Binance USDT-M daily `metrics` files on data.binance.vision (5-minute open interest in coins + USD since ~Dec 2021, incl. delisted symbols).
    Implied price = sum_open_interest_value / sum_open_interest, so one file gives 5-min price AND OI.
  * Binance monthly fundingRate files (data.binance.vision) for funding flips.
  * Binance futures daily klines (www.binance.com/fapi, falls back to data.binance.vision monthly kline zips for delisted symbols).
  * Gate.io /futures/usdt/contract_stats (daily long/short liquidation USD + OI, last 180 days) = the only free per-asset liquidation history we found.
  * OKX liquidation-orders REST only returns the latest ~100 orders per underlying (no depth), so it is not usable historically.

Questions:
  1) How many catalog crashes had perps (listed before the ATH, i.e. during the crash)?
  2) Amplify: on big down days inside the crash (daily return <= -15% within 180d after ATH), is there an OI flush (coin OI drop) vs control days?
  3) Precede: does an OI drop / funding flip show up BEFORE the crash day or the steepest intraday hour?
  4) Gate liquidation history: are crash days liquidation-heavy, and do liquidation spikes precede crash days (lift vs base rate)?
Writes data/liquidations_history.json. Not financial advice.
"""
import csv, io, json, math, os, random, re, sys, time, urllib.request, zipfile, datetime as dt
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get('DATA_DIR', os.path.join(ROOT, 'data'))
CACHE = os.environ.get('BV_CACHE', '/workspace/cache/bv')
os.makedirs(CACHE, exist_ok=True)
UA = {'User-Agent': 'Mozilla/5.0 (asymmetric-terminal research)'}
S3 = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision'
BV = 'https://data.binance.vision'
DROP = -15.0
random.seed(7)

def get(url, timeout=30, tries=3):
    for i in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()
        except urllib.error.HTTPError as e:
            if e.code in (404, 403, 400, 451): raise
            time.sleep(1 + i * 2)
        except Exception:
            time.sleep(1 + i * 2)
    raise RuntimeError('fail ' + url)

def cached(name, url):
    p = os.path.join(CACHE, name)
    if os.path.exists(p):
        return open(p, 'rb').read() if os.path.getsize(p) else None
    try:
        b = get(url)
    except Exception:
        b = b''
    open(p, 'wb').write(b)
    return b or None

def s3_keys(prefix):
    keys, marker = [], ''
    while True:
        x = get(f'{S3}?prefix={prefix}&max-keys=1000' + (f'&marker={marker}' if marker else '')).decode()
        ks = re.findall(r'<Key>([^<]+)</Key>', x)
        keys += ks
        if '<IsTruncated>true</IsTruncated>' not in x or not ks: return keys
        marker = ks[-1]

def metrics_range(sym):
    p = os.path.join(CACHE, f'range_{sym}.json')
    if os.path.exists(p): return json.load(open(p))
    try:
        ks = [k for k in s3_keys(f'data/futures/um/daily/metrics/{sym}/') if k.endswith('.zip')]
        ds = sorted(re.search(r'(\d{4}-\d{2}-\d{2})\.zip$', k).group(1) for k in ks)
        r = {'first': ds[0], 'last': ds[-1], 'n': len(ds)} if ds else None
    except Exception:
        r = None
    json.dump(r, open(p, 'w'))
    return r

def metrics_day(sym, day):
    b = cached(f'm_{sym}_{day}.zip', f'{BV}/data/futures/um/daily/metrics/{sym}/{sym}-metrics-{day}.zip')
    if not b: return None
    try:
        z = zipfile.ZipFile(io.BytesIO(b)); rows = list(csv.DictReader(io.StringIO(z.read(z.namelist()[0]).decode())))
    except Exception:
        return None
    out = []
    for r in rows:
        try:
            oi, oiv = float(r['sum_open_interest']), float(r['sum_open_interest_value'])
            if oi > 0 and oiv > 0:
                out.append((r['create_time'], oi, oiv, oiv / oi))
        except Exception:
            pass
    return out or None

def funding_month(sym, ym):
    b = cached(f'f_{sym}_{ym}.zip', f'{BV}/data/futures/um/monthly/fundingRate/{sym}/{sym}-fundingRate-{ym}.zip')
    if not b: return []
    try:
        z = zipfile.ZipFile(io.BytesIO(b)); rows = list(csv.reader(io.StringIO(z.read(z.namelist()[0]).decode())))
    except Exception:
        return []
    out = []
    for r in rows:
        try: out.append((int(r[0]), float(r[2])))
        except Exception: pass
    return out

def klines(sym, first, last):
    p = os.path.join(CACHE, f'k_{sym}.json')
    if os.path.exists(p): return json.load(open(p))
    rows = []
    try:
        d = json.loads(get(f'https://www.binance.com/fapi/v1/klines?symbol={sym}&interval=1d&limit=1500'))
        rows = [(dt.datetime.utcfromtimestamp(x[0] / 1000).strftime('%Y-%m-%d'), float(x[1]), float(x[2]), float(x[3]), float(x[4])) for x in d]
    except Exception:
        rows = []
    if not rows or rows[0][0] > first:  # delisted or older history: monthly zips
        a = dt.date.fromisoformat(first).replace(day=1); b = dt.date.fromisoformat(last)
        got = {r[0]: r for r in rows}
        while a <= b:
            ym = a.strftime('%Y-%m')
            z = cached(f'k1d_{sym}_{ym}.zip', f'{BV}/data/futures/um/monthly/klines/{sym}/1d/{sym}-1d-{ym}.zip')
            if z:
                try:
                    zz = zipfile.ZipFile(io.BytesIO(z))
                    for r in csv.reader(io.StringIO(zz.read(zz.namelist()[0]).decode())):
                        try:
                            day = dt.datetime.utcfromtimestamp(int(r[0]) / 1000).strftime('%Y-%m-%d'); got.setdefault(day, (day, float(r[1]), float(r[2]), float(r[3]), float(r[4])))
                        except Exception: pass
                except Exception: pass
            a = (a + dt.timedelta(days=32)).replace(day=1)
        rows = sorted(got.values())
    json.dump(rows, open(p, 'w'))
    return rows

# ---------- stats helpers (no scipy) ----------
def ncdf(z): return 0.5 * (1 + math.erf(z / math.sqrt(2)))
def mannwhitney(a, b):
    a, b = [x for x in a if x is not None], [x for x in b if x is not None]
    n1, n2 = len(a), len(b)
    if n1 < 3 or n2 < 3: return None
    allv = sorted([(v, 0) for v in a] + [(v, 1) for v in b]); ranks = [0.0] * len(allv); i = 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]: j += 1
        for k in range(i, j + 1): ranks[k] = (i + j) / 2 + 1
        i = j + 1
    r1 = sum(r for r, (v, g) in zip(ranks, allv) if g == 0)
    u = r1 - n1 * (n1 + 1) / 2; mu = n1 * n2 / 2; sd = math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12)
    z = (u - mu) / sd if sd else 0
    return {'n1': n1, 'n2': n2, 'auc': round(u / (n1 * n2), 3), 'p': round(2 * (1 - ncdf(abs(z))), 6)}
def prop_test(x1, n1, x2, n2):
    if not n1 or not n2: return None
    p1, p2 = x1 / n1, x2 / n2; p = (x1 + x2) / (n1 + n2); se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)) if 0 < p < 1 else 0
    z = (p1 - p2) / se if se else 0
    return {'a': f'{x1}/{n1}', 'b': f'{x2}/{n2}', 'pctA': round(100 * p1, 1), 'pctB': round(100 * p2, 1), 'lift': round(p1 / p2, 2) if p2 else None, 'p': round(2 * (1 - ncdf(abs(z))), 6)}
def median(a):
    a = sorted(x for x in a if x is not None)
    if not a: return None
    n = len(a); return a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2
def q(a, p):
    a = sorted(x for x in a if x is not None)
    return a[min(len(a) - 1, int(p * len(a)))] if a else None

# ---------- per-event features ----------
def day_feats(sym, day):
    """OI coin change over the day, steepest 1h implied-price drop, OI change in the hour before and during that drop."""
    prev = (dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat()
    a, b = metrics_day(sym, prev), metrics_day(sym, day)
    if not a or not b or len(b) < 200: return None
    oi0 = a[-1][1]; oi1 = b[-1][1]; px0 = a[-1][3]; px1 = b[-1][3]
    seq = a[-12:] + b  # previous hour + the day, 5-minute steps
    best = None
    for i in range(12, len(seq) - 12):
        r = seq[i + 12][3] / seq[i][3] - 1
        if best is None or r < best[0]: best = (r, i)
    r1h, i = best
    pre = seq[i][1] / seq[i - 12][1] - 1
    during = seq[i + 12][1] / seq[i][1] - 1
    # where in the day's drop did OI fall: share of the day's coin-OI decline that happened before the steepest hour
    return {'oi_coin_chg': (oi1 / oi0 - 1) * 100, 'oi_usd_chg': (b[-1][2] / a[-1][2] - 1) * 100, 'px_chg_metrics': (px1 / px0 - 1) * 100,
            'worst_1h_pct': r1h * 100, 'oi_pre_1h_pct': pre * 100, 'oi_during_1h_pct': during * 100, 'oi_usd_start': a[-1][2]}

def prior_day_oi(sym, day):
    d1 = (dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat(); d2 = (dt.date.fromisoformat(day) - dt.timedelta(days=2)).isoformat()
    a, b = metrics_day(sym, d2), metrics_day(sym, d1)
    if not a or not b: return None
    return {'oi_coin_chg_prev': (b[-1][1] / a[-1][1] - 1) * 100, 'px_chg_prev': (b[-1][3] / a[-1][3] - 1) * 100}

def funding_ctx(sym, day):
    d = dt.date.fromisoformat(day); t = int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp() * 1000)
    yms = {(d - dt.timedelta(days=4)).strftime('%Y-%m'), d.strftime('%Y-%m'), (d + dt.timedelta(days=4)).strftime('%Y-%m')}
    f = sorted(x for ym in yms for x in funding_month(sym, ym))
    before = [r for ts, r in f if t - 3 * 864e5 <= ts < t]; after = [r for ts, r in f if t + 864e5 <= ts < t + 4 * 864e5]
    if not before or not after: return None
    mb, ma = sum(before) / len(before), sum(after) / len(after)
    return {'f_before': mb * 100, 'f_after': ma * 100, 'flip_pos_to_neg': mb > 0 and ma < 0}

def analyse_token(c, sym, rng):
    rows = klines(sym, rng['first'], min(rng['last'], (dt.date.fromisoformat(c['ath_date']) + dt.timedelta(days=200)).isoformat()))
    if len(rows) < 30: return None
    mult = 1000 if sym.startswith('1000') else 1
    # identity check: Binance high near the catalog ATH date within 2.5x of the catalog ATH
    near = [r for r in rows if abs((dt.date.fromisoformat(r[0]) - dt.date.fromisoformat(c['ath_date'])).days) <= 3]
    if not near: return {'sym': sym, 'id': c['id'], 'skip': 'no kline at ATH'}
    hi = max(r[2] for r in near) / mult
    if not c.get('ath'): return {'sym': sym, 'id': c['id'], 'skip': 'catalog has no ATH price'}
    if not (c['ath'] / 2.5 <= hi <= c['ath'] * 2.5): return {'sym': sym, 'id': c['id'], 'skip': f'price mismatch (binance {hi:.6g} vs catalog ATH {c["ath"]:.6g})'}
    ath = dt.date.fromisoformat(c['ath_date']); end = ath + dt.timedelta(days=180)
    rets = []
    for i in range(1, len(rows)):
        d = dt.date.fromisoformat(rows[i][0])
        if ath <= d <= end and rows[i][0] >= rng['first'] and rows[i][0] <= rng['last']:
            rets.append((rows[i][0], (rows[i][4] / rows[i - 1][4] - 1) * 100))
    if not rets: return None
    crash = [d for d, r in rets if r <= DROP]
    calm = [d for d, r in rets if abs(r) < 3]
    ctrl = random.sample(calm, min(len(calm), max(2, 2 * len(crash))))
    # forward-looking test: days with an OI flush (coin OI -10% and price down) -> next-day crash rate vs base rate
    return {'sym': sym, 'id': c['id'], 'crash_days': crash, 'ctrl_days': ctrl, 'days': [d for d, _ in rets], 'rets': dict(rets)}

def main():
    t0 = time.time()
    cat = json.load(open(os.path.join(DATA, 'crash_catalog.json')))['catalog']
    cat = [c for c in cat if c.get('symbol') and c.get('ath_date')]
    syms = {}
    for c in cat:
        s = re.sub(r'[^A-Z0-9]', '', c['symbol'].upper())
        if s: syms.setdefault(s, []).append(c)
    print('catalog with ATH dates', len(cat), 'unique symbols', len(syms), file=sys.stderr)
    def rng_for(s):
        for cand in (f'{s}USDT', f'1000{s}USDT'):
            r = metrics_range(cand)
            if r: return s, cand, r
        return s, None, None
    with ThreadPoolExecutor(12) as ex: ranges = list(ex.map(rng_for, syms))
    perp_live = set()
    try: perp_live = {t['sym'] for t in json.load(open(os.path.join(DATA, 'perps.json')))['tokens']}
    except Exception: pass
    cover = {'catalog_tokens': len(cat), 'binance_um_perp_ever': 0, 'binance_perp_before_ath': 0, 'binance_perp_after_ath_only': 0, 'live_perp_any_venue_now': 0}
    tasks = []
    for s, sym, r in ranges:
        for c in syms[s]:
            if s in perp_live: cover['live_perp_any_venue_now'] += 1
            if not r: continue
            cover['binance_um_perp_ever'] += 1
            if r['first'] <= c['ath_date']: cover['binance_perp_before_ath'] += 1; tasks.append((c, sym, r))
            else: cover['binance_perp_after_ath_only'] += 1
    print('coverage', cover, file=sys.stderr)
    with ThreadPoolExecutor(8) as ex: toks = [x for x in ex.map(lambda a: analyse_token(*a), tasks) if x]
    skipped = [t for t in toks if t.get('skip')]; toks = [t for t in toks if not t.get('skip')]
    cover['identity_mismatch_skipped'] = len(skipped)
    cover['tokens_analysed'] = len(toks)
    ev = [(t['sym'], d, 'crash') for t in toks for d in t['crash_days']] + [(t['sym'], d, 'ctrl') for t in toks for d in t['ctrl_days']]
    print('events', len(ev), file=sys.stderr)
    def feat(e):
        sym, d, kind = e
        f = day_feats(sym, d)
        if not f: return None
        f.update(prior_day_oi(sym, d) or {}); f.update(funding_ctx(sym, d) or {})
        return {'sym': sym, 'day': d, 'kind': kind, **f}
    with ThreadPoolExecutor(12) as ex: rows = [x for x in ex.map(feat, ev) if x]
    C = [r for r in rows if r['kind'] == 'crash']; K = [r for r in rows if r['kind'] == 'ctrl']
    g = lambda R, k: [r.get(k) for r in R if r.get(k) is not None]
    res = {'n_crash_days': len(C), 'n_control_days': len(K), 'n_tokens_with_events': len({r['sym'] for r in C})}
    for k in ['oi_coin_chg', 'oi_usd_chg', 'worst_1h_pct', 'oi_pre_1h_pct', 'oi_during_1h_pct', 'oi_coin_chg_prev', 'px_chg_prev', 'f_before', 'f_after']:
        res[k] = {'crash_median': median(g(C, k)), 'crash_p25': q(g(C, k), .25), 'crash_p75': q(g(C, k), .75), 'ctrl_median': median(g(K, k)), 'mw': mannwhitney(g(C, k), g(K, k))}
    flush = lambda r: r['oi_coin_chg'] <= -10
    res['oi_flush_10pct_same_day'] = prop_test(sum(map(flush, C)), len(C), sum(map(flush, K)), len(K))
    res['oi_drop_3pct_in_hour_before_worst_hour'] = prop_test(sum(r['oi_pre_1h_pct'] <= -3 for r in C), len(C), sum(r['oi_pre_1h_pct'] <= -3 for r in K), len(K))
    res['oi_drop_3pct_during_worst_hour'] = prop_test(sum(r['oi_during_1h_pct'] <= -3 for r in C), len(C), sum(r['oi_during_1h_pct'] <= -3 for r in K), len(K))
    Cp = [r for r in C if 'oi_coin_chg_prev' in r]; Kp = [r for r in K if 'oi_coin_chg_prev' in r]
    res['oi_drop_10pct_previous_day'] = prop_test(sum(r['oi_coin_chg_prev'] <= -10 for r in Cp), len(Cp), sum(r['oi_coin_chg_prev'] <= -10 for r in Kp), len(Kp))
    res['oi_rise_10pct_previous_day'] = prop_test(sum(r['oi_coin_chg_prev'] >= 10 for r in Cp), len(Cp), sum(r['oi_coin_chg_prev'] >= 10 for r in Kp), len(Kp))
    Cf = [r for r in C if 'flip_pos_to_neg' in r]; Kf = [r for r in K if 'flip_pos_to_neg' in r]
    res['funding_flip_pos_to_neg_around_day'] = prop_test(sum(r['flip_pos_to_neg'] for r in Cf), len(Cf), sum(r['flip_pos_to_neg'] for r in Kf), len(Kf))
    # amplification: within crash days, do bigger OI flushes go with bigger price drops?
    def spearman(x, y):
        if len(x) < 5: return None
        rk = lambda a: {i: r for r, i in enumerate(sorted(range(len(a)), key=lambda i: a[i]))}
        rx, ry = rk(x), rk(y); n = len(x)
        d2 = sum((rx[i] - ry[i]) ** 2 for i in range(n)); rho = 1 - 6 * d2 / (n * (n * n - 1))
        z = rho * math.sqrt(n - 1)
        return {'rho': round(rho, 3), 'n': n, 'p': round(2 * (1 - ncdf(abs(z))), 6)}
    res['crash_day_oi_flush_vs_price_drop_spearman'] = spearman([r['oi_coin_chg'] for r in C], [r['px_chg_metrics'] for r in C])
    # predictive: all days in the crash windows: does a coin-OI drop >=10% with price down on day D-1 raise P(D is a crash day)?
    pred_days = []
    for t in toks:
        ds = t['days']
        for d in random.sample(ds, min(len(ds), 25)): pred_days.append((t['sym'], d, t['rets'][d]))
    def pf(e):
        sym, d, r = e; p = prior_day_oi(sym, d)
        return None if not p else (p['oi_coin_chg_prev'] <= -10 and p['px_chg_prev'] < 0, p['oi_coin_chg_prev'] >= 10, r <= DROP)
    with ThreadPoolExecutor(12) as ex: P = [x for x in ex.map(pf, pred_days) if x]
    a = [x for x in P if x[0]]; b = [x for x in P if not x[0]]
    res['predict_next_day_crash_after_oi_flush'] = prop_test(sum(x[2] for x in a), len(a), sum(x[2] for x in b), len(b))
    a = [x for x in P if x[1]]; b = [x for x in P if not x[1]]
    res['predict_next_day_crash_after_oi_build_10pct'] = prop_test(sum(x[2] for x in a), len(a), sum(x[2] for x in b), len(b))
    # series cases (big collapses with a collapse date)
    sc_out = []
    for s in json.load(open(os.path.join(DATA, 'crash_catalog.json'))).get('series_cases', []):
        name = (s.get('name') or '').split(' ')[0].upper(); d = s.get('collapse_date')
        if not d: continue
        for cand in (f'{name}USDT', f'1000{name}USDT'):
            r = metrics_range(cand)
            if r and r['first'] <= d <= r['last']:
                f = day_feats(cand, d)
                if f: sc_out.append({'name': s['name'], 'sym': cand, 'day': d, **{k: round(v, 2) for k, v in f.items() if isinstance(v, float)}})
                break
    res['series_cases_with_binance_metrics'] = sc_out
    gate = gate_study(cat)
    out = {'generatedAt': int(time.time() * 1000), 'elapsed_s': round(time.time() - t0, 1), 'definition': f'crash day = daily close-to-close <= {DROP}% within 180 days after the catalog ATH, while a Binance USDT-M perp existed; control = same-token days with |return| < 3% in the same window (2 per crash day, random). OI in coins (not USD) so price moves do not fake a flush.',
           'coverage': cover, 'binance_metrics': res, 'gate_liquidations': gate, 'skipped_examples': skipped[:15],
           'sample_crash_days': sorted(C, key=lambda r: r['oi_coin_chg'])[:25],
           'paid_sources': PAID, 'free_limits': FREE_LIMITS}
    json.dump(out, open(os.path.join(DATA, 'liquidations_history.json'), 'w'), default=float)
    print(json.dumps({k: out[k] for k in ['coverage', 'elapsed_s']}, indent=1))
    print(json.dumps(res, indent=1, default=float)[:6000])
    print(json.dumps(gate, indent=1, default=float)[:3000])

def gate_study(cat):
    try:
        cs = json.loads(get('https://api.gateio.ws/api/v4/futures/usdt/contracts'))
    except Exception as e:
        return {'error': str(e)}
    names = {c['name'] for c in cs}
    symset = {re.sub(r'[^A-Z0-9]', '', c['symbol'].upper()) for c in cat if c.get('symbol')}
    todo = [s for s in symset if f'{s}_USDT' in names]
    now = int(time.time())
    def one(s):
        try:
            d = json.loads(get(f'https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract={s}_USDT&interval=1d&from={now - 179 * 86400}&limit=180'))
        except Exception:
            return None
        d = [x for x in d if x.get('mark_price')]
        rows = []
        for i in range(1, len(d)):
            p0, p1 = d[i - 1]['mark_price'], d[i]['mark_price']
            if not p0: continue
            oi = d[i - 1].get('open_interest_usd') or 0
            liq = (d[i].get('long_liq_usd') or 0) + (d[i].get('short_liq_usd') or 0)
            rows.append({'t': d[i]['time'], 'ret': (p1 / p0 - 1) * 100, 'long_liq': d[i].get('long_liq_usd') or 0, 'short_liq': d[i].get('short_liq_usd') or 0, 'liq': liq, 'oi': oi, 'oi_chg': ((d[i].get('open_interest_usd') or 0) / oi - 1) * 100 if oi else None})
        return s, rows
    with ThreadPoolExecutor(6) as ex: R = [x for x in ex.map(one, todo) if x and x[1]]
    crash, ctrl, pred = [], [], []
    for s, rows in R:
        liqs = [r['liq'] for r in rows]
        for i, r in enumerate(rows):
            if r['oi'] < 50e3: continue
            r['liq_pct_oi'] = r['liq'] / r['oi'] * 100; r['long_share'] = r['long_liq'] / r['liq'] if r['liq'] else None
            if r['ret'] <= DROP: crash.append(r)
            elif abs(r['ret']) < 3: ctrl.append(r)
            if i >= 15:
                base = liqs[i - 15:i]; m = sum(base) / 15; sd = math.sqrt(sum((x - m) ** 2 for x in base) / 15)
                spike = sd > 0 and (r['liq'] - m) / sd >= 3 and r['ret'] < 0
                if i + 1 < len(rows): pred.append((spike, rows[i + 1]['ret'] <= DROP))
    g = lambda R, k: [r.get(k) for r in R if r.get(k) is not None]
    a = [x for x in pred if x[0]]; b = [x for x in pred if not x[0]]
    return {'contracts_studied': len(R), 'window_days': 180, 'n_crash_days': len(crash), 'n_control_days': len(ctrl),
            'liq_pct_oi': {'crash_median': median(g(crash, 'liq_pct_oi')), 'crash_p75': q(g(crash, 'liq_pct_oi'), .75), 'ctrl_median': median(g(ctrl, 'liq_pct_oi')), 'mw': mannwhitney(g(crash, 'liq_pct_oi'), g(ctrl, 'liq_pct_oi'))},
            'long_share_on_crash_days_median': median(g(crash, 'long_share')),
            'oi_chg': {'crash_median': median(g(crash, 'oi_chg')), 'ctrl_median': median(g(ctrl, 'oi_chg')), 'mw': mannwhitney(g(crash, 'oi_chg'), g(ctrl, 'oi_chg'))},
            'next_day_crash_after_liq_spike_z3_down_day': prop_test(sum(x[1] for x in a), len(a), sum(x[1] for x in b), len(b)),
            'note': 'Gate share of market only; liquidation USD from Gate contract_stats (free, 180 days max).'}

PAID = [  # checked 2026-10-11 (coinglass.com/pricing, tardis.dev); NOT used
    {'source': 'CoinGlass API (aggregated liquidation history, OI, funding across ~30 venues)', 'cost': 'Hobbyist $29/mo (liquidation history >=4h bars, 180d at 4h; daily all-time), Startup $79/mo (>=30m bars), Standard $299/mo (any interval, 1h bars 360d; first commercial tier), Professional $699/mo (1h bars 720d)', 'used': False},
    {'source': 'Tardis.dev (tick-level liquidations from exchange websockets since 2019-2020)', 'cost': 'from $350/mo (Academic Perpetuals, quarterly/yearly), Solo $700/mo, Pro $1,000/mo, Business $3,000+/mo; monthly billing only unlocks 4 months of history, full history needs yearly Business. Free sample: first day of each month without a key', 'used': False},
    {'source': 'Kaiko / Amberdata derivatives', 'cost': 'enterprise quotes', 'used': False},
    {'source': 'CryptoQuant / Glassnode derivatives (liquidations, OI)', 'cost': 'paid tiers; API access on higher plans (not checked in detail)', 'used': False},
]
FREE_LIMITS = {
    'binance': 'forceOrder websocket live only (works via fstream /market/stream path; /ws and /stream paths silent from this US box); REST allForceOrders retired (404); data.binance.vision has no liquidationSnapshot files for USDT-M (empty prefix); metrics (OI) files are the proxy',
    'okx': 'REST liquidation-orders returns only the latest ~100 orders per underlying (no paging back); websocket live only',
    'gate': 'REST liq_orders all contracts in 1-hour windows back ~6 months; contract_stats daily/hourly liquidation USD 180 days',
    'bybit': 'REST geo-blocked (403); public websocket allLiquidation reachable, live only',
    'hyperliquid': 'no public liquidation feed',
}
if __name__ == '__main__':
    main()
