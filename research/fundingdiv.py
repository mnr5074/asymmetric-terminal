#!/usr/bin/env python3
"""Historical funding-rate divergence study (free funding history endpoints, no keys).

Per perp-universe token with >= 2 venues, ~90 days of funding prints from:
  Binance www.binance.com/fapi/v1/fundingRate · OKX /public/funding-rate-history (~3 months) · Gate /futures/usdt/funding_rate · Hyperliquid fundingHistory
Each print is annualized with its own interval (rate * 24/intervalH * 365 * 100; interval inferred from print spacing) and averaged into 8h UTC buckets.
Divergence per bucket = max |venue - cross-venue median| (%/yr), outlier venue = the venue furthest from the median.
Rates sitting exactly on the default interest clamp (0.01%/8h == 10.95%/yr) are marked 'default' (premium inside the clamp band).
Episode = bucket where divergence >= max(30%/yr, token mean + 2.5 sd) after >= 1 calm bucket; ends when divergence < half the trigger.
Forward test with 1h candles (Gate futures, else Binance perps): return 1h/4h/24h after episode start, 7d max-up/max-down (pump >= +20%, dump <= -20%),
vs the same measures from every bucket (base rate). Direction hypothesis: when the outlier venue pays MORE (positive outlier) longs are crowded there -> expect down.
Writes data/fundingdiv_history.json. Not financial advice.
"""
import json, math, os, sys, time, urllib.request, datetime as dt
from concurrent.futures import ThreadPoolExecutor
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get('DATA_DIR', os.path.join(ROOT, 'data'))
UA = {'User-Agent': 'Mozilla/5.0 (asymmetric-terminal research)', 'content-type': 'application/json'}
DAYS = 90; H8 = 8 * 3600e3
NOW = int(time.time() * 1000); START = int(NOW - DAYS * 864e5)

def get(url, body=None, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, headers=UA)
            return json.loads(urllib.request.urlopen(req, timeout=25).read())
        except urllib.error.HTTPError as e:
            if e.code in (400, 403, 404, 451): return None
            time.sleep(1 + 2 * i)
        except Exception:
            time.sleep(1 + 2 * i)
    return None

def f_binance(c):
    d = get(f'https://www.binance.com/fapi/v1/fundingRate?symbol={c}&startTime={START}&limit=1000') or []
    if not isinstance(d, list): return []
    return [(int(x['fundingTime']), float(x['fundingRate'])) for x in d]
def f_okx(c):
    out, after = [], ''
    for _ in range(6):
        d = get(f'https://www.okx.com/api/v5/public/funding-rate-history?instId={c}&limit=100' + (f'&after={after}' if after else ''))
        rows = (d or {}).get('data') or []
        if not rows: break
        out += [(int(x['fundingTime']), float(x.get('realizedRate') or x['fundingRate'])) for x in rows]
        after = rows[-1]['fundingTime']
        if int(after) < START: break
        time.sleep(0.15)
    return out
def f_gate(c):
    d = get(f'https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract={c}&limit=1000&from={START // 1000}') or []
    return [(int(x['t']) * 1000, float(x['r'])) for x in d]
def f_hl(c):
    out, st = [], START
    for _ in range(6):
        d = get('https://api.hyperliquid.xyz/info', {'type': 'fundingHistory', 'coin': c, 'startTime': st}) or []
        if not d: break
        out += [(int(x['time']), float(x['fundingRate'])) for x in d]
        st = int(d[-1]['time']) + 1
        if len(d) < 500: break
    return out
FN = {'binance': f_binance, 'okx': f_okx, 'gate': f_gate, 'hyperliquid': f_hl}

def annualize(pr, venue):
    pr = sorted(set(p for p in pr if p[0] >= START))
    out = []
    for i, (t, r) in enumerate(pr):
        if venue == 'hyperliquid': ih = 1
        else:
            gap = (t - pr[i - 1][0]) / 3600e3 if i else ((pr[1][0] - t) / 3600e3 if len(pr) > 1 else 8)
            ih = min([1, 2, 4, 8], key=lambda x: abs(x - gap))
        out.append((t, r * 24 / ih * 365 * 100, abs(r * 8 / ih - 0.0001) < 1e-7))
    return out

def candles(tok):
    V = tok['venues']
    if 'gate' in V:
        d = get(f"https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract={V['gate']['contract']}&interval=1h&from={START // 1000}&to={NOW // 1000}")
        if d: return {int(x['t']) * 1000: float(x['c']) for x in d}
    if 'binance' in V:
        out, st = {}, START
        for _ in range(3):
            d = get(f"https://www.binance.com/fapi/v1/klines?symbol={V['binance']['contract']}&interval=1h&startTime={st}&limit=1500") or []
            if not d: break
            for x in d: out[int(x[0])] = float(x[4])
            st = int(d[-1][0]) + 3600e3
            if len(d) < 1500: break
        return out
    return {}

def med(a):
    a = sorted(a); n = len(a)
    return None if not n else a[n // 2] if n % 2 else (a[n // 2 - 1] + a[n // 2]) / 2
def ncdf(z): return 0.5 * (1 + math.erf(z / math.sqrt(2)))
def prop(x1, n1, x2, n2):
    if not n1 or not n2: return None
    p1, p2 = x1 / n1, x2 / n2; p = (x1 + x2) / (n1 + n2); se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)) if 0 < p < 1 else 0
    z = (p1 - p2) / se if se else 0
    return {'a': f'{x1}/{n1}', 'b': f'{x2}/{n2}', 'pctA': round(100 * p1, 1), 'pctB': round(100 * p2, 1), 'lift': round(p1 / p2, 2) if p2 else None, 'p': round(2 * (1 - ncdf(abs(z))), 5)}
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
    return {'n1': n1, 'n2': n2, 'median_a': round(med(a), 3), 'median_b': round(med(b), 3), 'auc': round(u / (n1 * n2), 3), 'p': round(2 * (1 - ncdf(abs(z))), 5)}

def one(tok):
    V = tok['venues']
    if len(V) < 2: return None
    series = {}
    for v, x in V.items():
        if v in FN:
            a = annualize(FN[v](x['contract']), v)
            if a: series[v] = a
    if len(series) < 2: return None
    B = {}
    for v, a in series.items():
        for t, ann, dflt in a:
            b = int(t // H8 * H8)
            B.setdefault(b, {}).setdefault(v, []).append((ann, dflt))
    rows = []
    for b in sorted(B):
        vs = {v: (sum(x[0] for x in L) / len(L), all(x[1] for x in L)) for v, L in B[b].items()}
        if len(vs) < 2: continue
        m = med([x[0] for x in vs.values()])
        out = max(vs, key=lambda v: abs(vs[v][0] - m))
        rows.append({'t': b, 'median': m, 'div': vs[out][0] - m, 'outlier': out, 'default': vs[out][1], 'n': len(vs)})
    if len(rows) < 30: return None
    px = candles(tok)
    return tok['sym'], rows, px

def fwd(px, t, hrs):
    t0 = int(t // 3600e3 * 3600e3)
    a = px.get(t0); b = px.get(t0 + hrs * 3600e3)
    return (b / a - 1) * 100 if a and b else None
def fwd_ext(px, t, hrs):
    t0 = int(t // 3600e3 * 3600e3); a = px.get(t0)
    if not a: return None, None
    seq = [px[k] for k in range(t0 + 3600000, t0 + hrs * 3600000 + 1, 3600000) if k in px]
    if len(seq) < hrs * 0.8: return None, None
    return (max(seq) / a - 1) * 100, (min(seq) / a - 1) * 100

def main():
    t0 = time.time()
    toks = json.load(open(os.path.join(DATA, 'perps.json')))['tokens']
    U = [{'sym': t['sym'], 'venues': {v['venue']: {'contract': v['contract']} for v in t['venues']}} for t in toks]
    if len(sys.argv) > 1: U = U[:int(sys.argv[1])]
    with ThreadPoolExecutor(6) as ex: R = [r for r in ex.map(one, U) if r]
    eps, base, per = [], [], {}
    for sym, rows, px in R:
        ds = [abs(r['div']) for r in rows]; m = sum(ds) / len(ds); sd = math.sqrt(sum((d - m) ** 2 for d in ds) / len(ds))
        trig = max(30.0, m + 2.5 * sd)
        per[sym] = {'buckets': len(rows), 'meanAbsDiv': round(m, 2), 'sdAbsDiv': round(sd, 2), 'trigger': round(trig, 1), 'episodes': 0, 'venues': sorted({r['outlier'] for r in rows})}
        on = None
        for r in rows:
            f24 = fwd(px, r['t'] + H8, 24); up, dn = fwd_ext(px, r['t'] + H8, 168)
            if f24 is not None and up is not None:
                base.append({'f24': f24, 'pump': up >= 20, 'dump': dn <= -20, 'abs24': abs(f24)})
            if on is None and abs(r['div']) >= trig and not r['default']:
                on = {'sym': sym, 'start': r['t'], 'peak': r['div'], 'outlier': r['outlier'], 'median': r['median'], 'buckets': 1}
            elif on is not None:
                if abs(r['div']) >= trig / 2:
                    on['buckets'] += 1
                    if abs(r['div']) > abs(on['peak']): on['peak'] = r['div']; on['outlier'] = r['outlier']
                else:
                    on['end'] = r['t']; eps.append(on); on = None
        if on: on['end'] = None; eps.append(on)
        per[sym]['episodes'] = sum(1 for e in eps if e['sym'] == sym)
    PX = {s: px for s, _, px in R}
    E = []
    for e in eps:
        px = PX[e['sym']]; t = e['start'] + H8  # bucket closes 8h after its start: no look-ahead
        f1, f4, f24 = fwd(px, t, 1), fwd(px, t, 4), fwd(px, t, 24); up, dn = fwd_ext(px, t, 168)
        if f24 is None or up is None: continue
        # realized vol during the episode vs the prior 7 days (hourly abs returns)
        def rv(a, b):
            ks = [k for k in range(int(a // 3600e3 * 3600e3), int(b), 3600000) if k in px and k + 3600000 in px]
            r = [abs(px[k + 3600000] / px[k] - 1) * 100 for k in ks]
            return sum(r) / len(r) if r else None
        endt = e['end'] or (e['start'] + e['buckets'] * H8)
        E.append({**e, 'dur_h': e['buckets'] * 8, 'f1': f1, 'f4': f4, 'f24': f24, 'up7d': up, 'dn7d': dn, 'pump': up >= 20, 'dump': dn <= -20,
                  'rv_during': rv(e['start'], endt + H8), 'rv_before': rv(e['start'] - 7 * 864e5, e['start']),
                  'signed24': -f24 if e['peak'] > 0 else f24})  # positive = moved the way the 'crowded on outlier venue' hypothesis predicts
    pos = [e for e in E if e['peak'] > 0]; neg = [e for e in E if e['peak'] < 0]
    T = lambda A, k: prop(sum(e[k] for e in A), len(A), sum(b[k] for b in base), len(base))
    rvr = [e['rv_during'] / e['rv_before'] for e in E if e['rv_during'] and e['rv_before']]
    res = {'n_tokens': len(R), 'n_buckets': len(base), 'n_episodes': len(E), 'n_pos_outlier': len(pos), 'n_neg_outlier': len(neg),
           'base_rates': {'pump7d_pct': round(100 * sum(b['pump'] for b in base) / max(1, len(base)), 1), 'dump7d_pct': round(100 * sum(b['dump'] for b in base) / max(1, len(base)), 1)},
           'all': {'pump7d': T(E, 'pump'), 'dump7d': T(E, 'dump'), 'abs24_mw': mw([abs(e['f24']) for e in E], [b['abs24'] for b in base])},
           'pos_outlier': {'pump7d': T(pos, 'pump'), 'dump7d': T(pos, 'dump'), 'f24_mw': mw([e['f24'] for e in pos], [b['f24'] for b in base])},
           'neg_outlier': {'pump7d': T(neg, 'pump'), 'dump7d': T(neg, 'dump'), 'f24_mw': mw([e['f24'] for e in neg], [b['f24'] for b in base])},
           'hypothesis_hit_rate_24h': {'hits': sum(e['signed24'] > 0 for e in E), 'n': len(E), 'pct': round(100 * sum(e['signed24'] > 0 for e in E) / max(1, len(E)), 1), 'median_signed24': round(med([e['signed24'] for e in E]) or 0, 2), 'binom_p': None},
           'median_duration_h': med([e['dur_h'] for e in E]), 'median_rv_ratio_during_vs_before': round(med(rvr), 2) if rvr else None,
           'by_outlier_venue': {v: sum(1 for e in E if e['outlier'] == v) for v in sorted({e['outlier'] for e in E})}}
    h = res['hypothesis_hit_rate_24h']
    if h['n']: z = (h['hits'] - h['n'] / 2) / math.sqrt(h['n'] / 4); h['binom_p'] = round(2 * (1 - ncdf(abs(z))), 5)
    out = {'generatedAt': NOW, 'elapsed_s': round(time.time() - t0, 1), 'days': DAYS, 'method': __doc__.strip().split('\n\n')[1] if '\n\n' in __doc__ else '', 'results': res, 'tokens': per,
           'episodes': sorted([{k: (round(v, 3) if isinstance(v, float) else v) for k, v in e.items()} for e in E], key=lambda e: -e['start'])[:200]}
    json.dump(out, open(os.path.join(DATA, 'fundingdiv_history.json'), 'w'))
    print(json.dumps(res, indent=1))

if __name__ == '__main__':
    main()
