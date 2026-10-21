#!/usr/bin/env python3
"""Waking Up scanner + honest backtest (signal and test fixed in research/waking/PREDECLARED.md before any outcome was computed).

Pools: majors (Binance daily, data/flatbase_series), solana (GeckoTerminal daily, research/waking/cache via fetch.py),
robinhood (rhscan 4h bars summed to UTC days). Free data only; nothing is fetched here except the few live-context calls for
current cards (GeckoTerminal pool + token info, DexScreener pairs), all cached.
Output: data/waking.json (served at /api/waking; works from the frozen snapshot on Render) + research/waking/WAKING.md.
usage: python3 research/waking/waking.py [--no-live]"""
import json, os, sys, time, glob, math, hashlib, argparse, urllib.request, statistics as st
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
DATA = os.environ.get('DATA_DIR', os.path.join(ROOT, 'data')); CACHE = os.path.join(HERE, 'cache'); RHC = os.path.join(ROOT, 'research', 'rhscan', 'cache')
sys.path.insert(0, os.path.join(ROOT, 'research', 'rhscan'))
DAY = 86400
# ---- pre-declared parameters (PREDECLARED.md) ----
HIST, QN, WN, DEAD, DD, FLAT, VM, VDAYS, NEAR, DEDUPE, FWD = 45, 21, 4, 0.35, 0.40, 1.6, 1.5, 3, 1.10, 30, 30
FLOOR = {'majors': 100000, 'solana': 5000, 'robinhood': 5000}
POOLS = ['solana', 'robinhood', 'majors']
NAMED_RAW = {'6AUURRdHb9TrfPHv9AMofa8NEVoZDXcsbWKcUBpFSRXs': 'CYPHERCAT (CypherCat)', 'EosbW31T1WAQSiHUErogcaNHd8FBZDbjPPgQMJzXARNV': 'QCAT (dead rug)',
         '0x5173d45a1191ee33cbb7d8c7e65f21b04ed54802': 'RAM (Ramses)'}
NAMED = {k.lower(): v for k, v in NAMED_RAW.items()}  # Solana addresses are case-sensitive: display NAMED_RAW keys, match lowercased
CALLS = {'gt': 0, 'ds': 0, 'cache': 0}

# ---------------- series loading ----------------
def contiguous(rows):
    """rows: [(day, close, volume)] -> day0, closes, volumes with no-trade days filled (prev close, volume 0)."""
    d = {}
    for day, c, v in rows:
        if c and c > 0: d[day] = (c, (d.get(day, (0, 0))[1]) + (v or 0))
    if not d: return None
    d0, d1 = min(d), max(d); c = np.empty(d1 - d0 + 1); v = np.zeros(d1 - d0 + 1); last = None
    for k in range(d1 - d0 + 1):
        x = d.get(d0 + k)
        if x: last = x[0]; v[k] = x[1]
        c[k] = last
    return d0, c, v

def gt_rows(path, scale=None):
    try: rows = json.load(open(path))['data']['attributes']['ohlcv_list']
    except Exception: return []
    return [(int(r[0]) // DAY, float(r[4]), float(r[5])) for r in rows if r[4]]

SAFE_QUOTES = {'So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'}
def usd_guard(tok, pool, rows):
    """Stale/flat USD guard for pools quoted in anything but SOL/USDC/USDT (e.g. CYPHERCAT vs CYPH, a tokenized stock): GeckoTerminal's
    USD candles for such pools can sit flat for days (CYPHERCAT ~$0.00065) while the quote-denominated candles are right. So the USD
    series is ALWAYS rebuilt as quote-denominated close (and volume) x the quote token's own USD close for that day (nearest earlier
    day within 5, since tokenized stocks skip days). If the quote token has no USD series the token is excluded, never scored on
    the GT USD figure. Returns (rows, note, stats)."""
    q = pool.get('quote')
    if not q or q in SAFE_QUOTES: return rows, None, None
    qf = f'{CACHE}/sol_ohlcvq_{pool["pool"]}.json'; qp = pool.get('quotePool')
    qrows = gt_rows(qf)
    qusd = {d: c for d, c, _ in gt_rows(f'{CACHE}/sol_ohlcvd_{qp}.json')} if qp else {}
    if not qrows or not qusd: return [], 'quoted in a non-SOL/USDC token and no quote-denominated or quote-USD series: excluded (GeckoTerminal USD candles for such pools can be stale)', None
    out = []
    for d, c, v in sorted(qrows):
        k = d
        while k not in qusd and k > d - 5: k -= 1
        if k in qusd: out.append((d, c * qusd[k], v * qusd[k]))
    gt = {d: c for d, c, _ in rows}; diffs = [abs(c / gt[d] - 1) for d, c, _ in out[-10:] if gt.get(d)]
    ur = sorted(rows)[-8:]; flat = sum(1 for x, y in zip(ur, ur[1:]) if abs(y[1] / x[1] - 1) < 0.001)
    stats = {'gtFlatDaysLast7': flat, 'maxDiffVsGtLast10dPct': round(100 * max(diffs), 1) if diffs else None}
    bad = flat >= 3 or (stats['maxDiffVsGtLast10dPct'] or 0) > 25
    note = 'USD rebuilt from quote-denominated candles x quote-token USD (non-SOL/USDC quote)' + ('; GeckoTerminal USD candles disagree with that by up to %.0f%% over the last 10 days%s' % (stats['maxDiffVsGtLast10dPct'] or 0, (' and sat unchanged on %d of the last 7' % flat) if flat >= 3 else '') if bad else '')
    return out, note, stats

def load_solana():
    try: uni = json.load(open(f'{CACHE}/sol_universe.json'))
    except Exception: return {}, {}
    out, notes = {}, {}
    for addr, p in uni['tokens'].items():
        f = f'{CACHE}/sol_ohlcvd_{p["pool"]}.json'
        rows = gt_rows(f)
        if not rows: continue
        rows, note, gst = usd_guard(addr, p, rows)
        if note: notes[addr] = {'symbol': p['symbol'], 'note': note, **(gst or {})}
        s = contiguous(rows)
        if s: out[addr] = {'symbol': p['symbol'], 'chain': 'solana', 'contract': addr, 'pool': p['pool'], 'quote': p.get('quote'), 'liq': p['liq'],
                           'fetchedAt': int(os.path.getmtime(f) * 1000), 's': s, 'usdNote': note, 'gtPriceUsd': p.get('priceUsd')}
    return out, notes

def load_robinhood():
    import rh_scan as R
    pools = {}
    for f in glob.glob(f'{RHC}/pools_*.json') + glob.glob(f'{RHC}/trending_*.json') + glob.glob(f'{RHC}/tokpools_*.json') + glob.glob(f'{RHC}/pool_*.json'):
        try: d = json.load(open(f))
        except Exception: continue
        lst = d.get('data') if isinstance(d, dict) else None
        if isinstance(lst, dict): lst = [lst]
        for p in lst or []:
            a = p['attributes']; rel = p.get('relationships', {})
            base = ((rel.get('base_token', {}) or {}).get('data', {}) or {}).get('id', '').split('_', 1)[-1].lower()
            sym = (a.get('name') or '').split('/')[0].strip().upper()
            if sym in R.QUOTES or not base or base in R.IMPOSTORS: continue
            liq = float(a.get('reserve_in_usd') or 0)
            if base not in pools or liq > pools[base]['liq'] or R.PINNED.get(base) == a['address'].lower():
                if base in pools and R.PINNED.get(base) == pools[base]['pool'].lower() and R.PINNED.get(base) != a['address'].lower(): continue
                pools[base] = {'pool': a['address'], 'symbol': sym, 'liq': liq}
    out, bars4h = {}, {}
    for addr, p in pools.items():
        f = f'{RHC}/ohlcv4h_{p["pool"].lower()}.json'
        if not os.path.exists(f): continue
        b = R.ohlcv(p['pool'], True)
        if not b: continue
        s = contiguous([(x['t'] // DAY, x['c'], x['v']) for x in b])  # 4h close of the last bar in the day = daily close; volumes summed
        # contiguous() keeps the LAST close seen per day only if rows are sorted; they are (ohlcv sorts)
        if s: out[addr] = {'symbol': p['symbol'], 'chain': 'robinhood', 'contract': addr, 'pool': p['pool'], 'liq': p['liq'], 'fetchedAt': int(os.path.getmtime(f) * 1000), 's': s}
        bars4h[addr] = (p['symbol'], b)
    return out, bars4h

def load_majors():
    out = {}
    for f in glob.glob(os.path.join(DATA, 'flatbase_series', 'bn_*.json')):
        try: d = json.load(open(f))
        except Exception: continue
        s = contiguous([(r[0], r[1], r[2]) for r in d.get('s', [])])
        if s: out[d['id']] = {'symbol': d['symbol'], 'chain': 'majors (Binance spot)', 'contract': None, 'pair': d.get('pair'), 'status': d.get('status'), 'fetchedAt': d.get('at'), 's': s}
    return out

# ---------------- signal (vectorised; bars <= i only) ----------------
def features(c, v, floor):
    n = len(c); idx = np.arange(n); res = {'n': n}
    if n < HIST + 2: return None
    med21 = np.full(n, np.nan); mean21 = np.full(n, np.nan); mx21 = np.full(n, np.nan); mn21 = np.full(n, np.nan)
    W = swv(v, QN); med21[QN - 1:] = np.median(W, axis=1); mean21[QN - 1:] = W.mean(axis=1)
    Wc = swv(c, QN); mx21[QN - 1:] = Wc.max(axis=1); mn21[QN - 1:] = Wc.min(axis=1)
    v7 = np.full(n, np.nan); v7[6:] = swv(v, 7).mean(axis=1); pm7 = np.fmax.accumulate(np.nan_to_num(v7, nan=0.0))
    cmx = np.maximum.accumulate(c)
    v4 = np.full((n, WN), np.nan); v4[WN - 1:] = swv(v, WN); c4min = np.full(n, np.nan); c4min[WN - 1:] = swv(c, WN).min(axis=1)
    m30 = np.full(n, np.nan); m30[29:] = swv(v, 30).mean(axis=1)
    i = idx; qe = i - 4; ok = i >= max(HIST, 31)
    qe_ = np.clip(qe, 0, n - 1); pr = np.clip(i - 25, 0, n - 1)
    qbase = np.where(med21[qe_] > 0, med21[qe_], mean21[qe_])
    tradable = ok & (np.nan_to_num(m30) >= floor)
    dead = ok & (qbase > 0) & (qbase <= DEAD * pm7[pr]) & (i - 25 >= 6)
    down = ok & (1 - c[qe_] / cmx[qe_] >= DD)
    flat = ok & (mx21[qe_] / mn21[qe_] <= FLAT)
    thr = VM * qbase
    cnt = (v4 >= thr[:, None]).sum(axis=1)
    nospike = (np.nansum(v4, axis=1) - np.nanmax(np.nan_to_num(v4), axis=1)) / (WN - 1) >= thr
    rising = ok & (cnt >= VDAYS) & nospike & (qbase > 0)
    hl = ok & (c4min > mn21[qe_])
    near = ok & (c <= NEAR * mx21[qe_])
    sig = tradable & dead & down & flat & rising & hl & near
    quiet = tradable & dead & down & flat & ~sig
    return {'sig': sig, 'quiet': quiet, 'tradable': tradable, 'dead': dead, 'down': down, 'flat': flat, 'rising': rising, 'hl': hl, 'near': near,
            'qbase': qbase, 'qmean': mean21[qe_], 'top': mx21[qe_], 'low': mn21[qe_], 'cnt': cnt, 'm30': m30, 'peak7': pm7[pr], 'cmx': cmx[qe_]}

def outcomes(c, last_complete):
    """Per bar i with a complete 30-day forward window (i + FWD <= last_complete)."""
    n = len(c); out = {}
    if n <= FWD + 1: return None
    F = swv(c[1:], FWD)  # F[i] = c[i+1 .. i+FWD]
    m = min(len(F), max(0, last_complete - FWD + 1))
    e = c[:m]; Fm = F[:m]
    hit = Fm.max(axis=1) >= 2 * e; drop = Fm.min(axis=1) <= 0.5 * e
    f2 = np.where(hit, np.argmax(Fm >= 2 * e[:, None], axis=1), 999); fd = np.where(drop, np.argmax(Fm <= 0.5 * e[:, None], axis=1), 999)
    return {'m': m, 'hit': hit, 'drop': drop, 'dropFirst': drop & (fd < f2), 'r7': Fm[:, 6] / e - 1, 'r14': Fm[:, 13] / e - 1, 'r30': Fm[:, 29] / e - 1, 'F': Fm}

def dedupe(mask):
    keep = []; last = -10**9
    for i in np.flatnonzero(mask):
        if i - last >= DEDUPE: keep.append(int(i)); last = i
    return keep

# ---------------- backtest ----------------
def run_pool(name, series, today):
    floor = FLOOR[name]; sigs = []; tradable_days = {}; per = {}
    for tid, x in series.items():
        d0, c, v = x['s']
        last_complete = min(len(c) - 1, today - 1 - d0)  # never the current UTC day
        if last_complete < HIST + 5: continue
        c, v = c[:last_complete + 1], v[:last_complete + 1]
        f = features(c, v, floor)
        if f is None: continue
        o = outcomes(c, last_complete)
        per[tid] = (d0, c, v, f, o)
        if o:
            for i in np.flatnonzero(f['tradable'][:o['m']]): tradable_days.setdefault(d0 + int(i), []).append((tid, int(i)))
        for i in dedupe(f['sig']):
            r = {'token': tid, 'symbol': x['symbol'], 'day': d0 + i, 'i': i, 'price': float(c[i]), 'top': float(f['top'][i]), 'low': float(f['low'][i])}
            if o and i < o['m']:
                fw = o['F'][i]; e = c[i]; walk = max(0.97 * f['low'][i], 0.65 * e)
                jw = next((k for k in range(FWD) if fw[k] <= walk), 999); j2 = next((k for k in range(FWD) if fw[k] >= 2 * e), 999)
                # daily analogue of the breakout Trigger: close > base top on 3-day volume >= 1.5x the quiet average
                jb = None
                for j in range(i + 1, i + FWD + 1):
                    if c[j] > f['top'][i] and v[max(0, j - 2):j + 1].mean() >= 1.5 * f['qmean'][i]: jb = j; break
                r.update({'complete': True, 'hit': bool(o['hit'][i]), 'drop': bool(o['drop'][i]), 'dropFirst': bool(o['dropFirst'][i]),
                          'r7': float(o['r7'][i]), 'r14': float(o['r14'][i]), 'r30': float(o['r30'][i]), 'walkFirst': jw < j2,
                          'breakoutLagDays': (jb - i) if jb else None, 'breakoutVsFlag': (float(c[jb] / e - 1)) if jb else None,
                          'breakoutR30': (float(c[min(jb + FWD, len(c) - 1)] / c[jb] - 1)) if jb and jb + FWD <= len(c) - 1 else None,
                          'breakoutHit': (bool(c[jb + 1:jb + FWD + 1].max() >= 2 * c[jb])) if jb and jb + FWD <= len(c) - 1 else None,
                          'breakoutDrop': (bool(c[jb + 1:jb + FWD + 1].min() <= 0.5 * c[jb])) if jb and jb + FWD <= len(c) - 1 else None})
            else: r['complete'] = False
            sigs.append(r)
    days = sorted(d for d, l in tradable_days.items() for _ in l)
    split = days[len(days) // 2] if days else None
    def rand_for(day, exclude):
        L = [(t, i) for t, i in tradable_days.get(day, []) if t != exclude]
        if not L: return None
        h = np.mean([per[t][4]['hit'][i] for t, i in L]); dr = np.mean([per[t][4]['drop'][i] for t, i in L])
        r30 = [per[t][4]['r30'][i] for t, i in L]; r7 = [per[t][4]['r7'][i] for t, i in L]; r14 = [per[t][4]['r14'][i] for t, i in L]
        q = [(t, i) for t, i in L if per[t][3]['quiet'][i]]
        qh = np.mean([per[t][4]['hit'][i] for t, i in q]) if q else None; qd = np.mean([per[t][4]['drop'][i] for t, i in q]) if q else None
        qr = [per[t][4]['r30'][i] for t, i in q]
        return {'hit': h, 'drop': dr, 'r7': r7, 'r14': r14, 'r30': r30, 'n': len(L), 'qhit': qh, 'qdrop': qd, 'qr30': qr, 'qn': len(q)}
    for s in sigs:
        s['rand'] = rand_for(s['day'], s['token']) if s.get('complete') else None
    def summ(S):
        S = [s for s in S if s.get('complete') and s.get('rand')]
        n = len(S)
        if not n: return {'n': 0, 'tokens': 0}
        pct = lambda k: round(100 * sum(1 for s in S if s[k]) / n, 1)
        med = lambda k: round(100 * float(np.median([s[k] for s in S])), 1)
        R = [s['rand'] for s in S]; Rq = [r for r in R if r['qn']]
        rr = lambda k: round(100 * float(np.median([x for r in R for x in r[k]])), 1)
        bo = [s for s in S if s['breakoutLagDays']]
        bo2 = [s for s in bo if s['breakoutR30'] is not None]
        out = {'n': n, 'tokens': len({s['token'] for s in S}), 'hit2xPct': pct('hit'), 'drop50Pct': pct('drop'), 'drop50FirstPct': pct('dropFirst'), 'walkAwayFirstPct': pct('walkFirst'),
               'medR7': med('r7'), 'medR14': med('r14'), 'medR30': med('r30'),
               'random': {'pairs': sum(r['n'] for r in R), 'hit2xPct': round(100 * float(np.mean([r['hit'] for r in R])), 1), 'drop50Pct': round(100 * float(np.mean([r['drop'] for r in R])), 1),
                          'medR7': rr('r7'), 'medR14': rr('r14'), 'medR30': rr('r30')},
               'quietNotWaking': {'pairs': sum(r['qn'] for r in Rq), 'hit2xPct': round(100 * float(np.mean([r['qhit'] for r in Rq])), 1) if Rq else None,
                                  'drop50Pct': round(100 * float(np.mean([r['qdrop'] for r in Rq])), 1) if Rq else None,
                                  'medR30': round(100 * float(np.median([x for r in Rq for x in r['qr30']])), 1) if Rq else None},
               'breakout': {'followedPct': round(100 * len(bo) / n, 1), 'n': len(bo), 'medLeadDays': float(np.median([s['breakoutLagDays'] for s in bo])) if bo else None,
                            'medCheaperPct': round(100 * float(np.median([s['breakoutVsFlag'] for s in bo])), 1) if bo else None,
                            'fromBreakout': {'n': len(bo2), 'hit2xPct': round(100 * sum(1 for s in bo2 if s['breakoutHit']) / len(bo2), 1) if bo2 else None,
                                             'drop50Pct': round(100 * sum(1 for s in bo2 if s['breakoutDrop']) / len(bo2), 1) if bo2 else None,
                                             'medR30': round(100 * float(np.median([s['breakoutR30'] for s in bo2])), 1) if bo2 else None},
                            'sameEventsFromFlag': {'hit2xPct': round(100 * sum(1 for s in bo2 if s['hit']) / len(bo2), 1) if bo2 else None,
                                                   'drop50Pct': round(100 * sum(1 for s in bo2 if s['drop']) / len(bo2), 1) if bo2 else None,
                                                   'medR30': round(100 * float(np.median([s['r30'] for s in bo2])), 1) if bo2 else None}}}
        net, rnet = out['hit2xPct'] - out['drop50Pct'], out['random']['hit2xPct'] - out['random']['drop50Pct']
        out['net'] = round(net, 1); out['randomNet'] = round(rnet, 1)
        out['beats'] = bool(n >= 30 and out['tokens'] >= 15 and net >= rnet + 5 and out['medR30'] > out['random']['medR30'])
        out['why'] = ('n %d on %d tokens; net (2x%% - drop%%) %.1f vs random %.1f; median 30d %.1f%% vs random %.1f%%' % (n, out['tokens'], net, rnet, out['medR30'], out['random']['medR30']))
        return out
    early = summ([s for s in sigs if split and s['day'] < split]); late = summ([s for s in sigs if split and s['day'] >= split]); allp = summ(sigs)
    strength = 'backtested' if early.get('beats') and late.get('beats') else 'weak' if late.get('beats') else 'unproven'
    if strength == 'unproven':
        swhy = ('too few completed signals on the later period (n=%d on %d tokens; need >= 30 on >= 15)' % (late.get('n', 0), late.get('tokens', 0))) if late.get('n', 0) < 30 or late.get('tokens', 0) < 15 else 'did not beat random on the later period: ' + late.get('why', '')
    else: swhy = ('beat random on both periods' if strength == 'backtested' else 'beat random on the later period only') + ': later ' + late.get('why', '')
    return {'pool': name, 'tokens': len(per), 'splitDay': split, 'splitUtc': time.strftime('%Y-%m-%d', time.gmtime(split * DAY)) if split else None,
            'firstDay': time.strftime('%Y-%m-%d', time.gmtime(min(tradable_days) * DAY)) if tradable_days else None,
            'lastDay': time.strftime('%Y-%m-%d', time.gmtime(max(tradable_days) * DAY)) if tradable_days else None,
            'earlier': early, 'later': late, 'all': allp, 'strength': strength, 'strengthWhy': swhy, 'alerts': strength in ('backtested', 'weak'),
            'signals': [{k: s.get(k) for k in ('symbol', 'token', 'day', 'price', 'hit', 'drop', 'r30', 'breakoutLagDays', 'breakoutVsFlag', 'complete')} for s in sorted(sigs, key=lambda s: -s['day'])][:80]}, per, sigs

def rh_trigger_match(rh_sigs, bars4h):
    """Robinhood: compare each Waking signal with the RH scanner's real 4h Trigger replay (research/rhscan/rh_scan.py)."""
    try:
        import rh_scan as R
        trig, _ = R.backtest(bars4h)
    except Exception as e: return {'error': str(e)}
    by = {}
    for t in trig: by.setdefault(t['token'], []).append(t['t'])
    m = []
    for s in rh_sigs:
        t0 = (s['day'] + 1) * DAY  # signal day close
        nxt = [t for t in by.get(s['token'], []) if t0 <= t <= t0 + FWD * DAY]
        if nxt:
            sym, b = bars4h[s['token']]; tc = next(x['c'] for x in b if x['t'] == nxt[0])
            m.append({'symbol': s['symbol'], 'leadDays': round((nxt[0] - t0) / DAY + 0.0, 1), 'cheaperPct': round(100 * (tc / s['price'] - 1), 1)})
    return {'signals': len(rh_sigs), 'followedByRealTrigger': len(m), 'medLeadDays': float(np.median([x['leadDays'] for x in m])) if m else None,
            'medCheaperPct': float(np.median([x['cheaperPct'] for x in m])) if m else None, 'matches': m[:20], 'triggerReplayN': len(trig)}

# ---------------- live context (current cards only; cached) ----------------
_last = [0.0]
def get(url, gt=True):
    for k in range(3):
        if gt:
            w = _last[0] + 2.2 - time.time()
            if w > 0: time.sleep(w)
            _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={'accept': 'application/json', 'user-agent': 'asymmetric-terminal/waking'})
            with urllib.request.urlopen(req, timeout=25) as r: CALLS['gt' if gt else 'ds'] += 1; return json.load(r)
        except Exception as e:
            if getattr(e, 'code', None) == 404: return None
            time.sleep(8 * (k + 1))
    return None
def cached(name, ttl, fn):
    p = os.path.join(CACHE, name)
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < ttl: CALLS['cache'] += 1; return json.load(open(p))
    v = fn()
    if v is not None: json.dump(v, open(p, 'w'))
    return v
NET = {'solana': 'solana', 'robinhood': 'robinhood'}
def live_context(x):
    net = NET.get(x['chain']); ctx = {'signs': [], 'flags': [], 'veto': None}
    if not net: return ctx
    pd = cached(f'live_pool_{net}_{x["pool"]}.json', 3000, lambda: get(f'https://api.geckoterminal.com/api/v2/networks/{net}/pools/{x["pool"]}'))
    info = cached(f'live_info_{net}_{x["contract"]}.json', 6 * 3600, lambda: get(f'https://api.geckoterminal.com/api/v2/networks/{net}/tokens/{x["contract"]}/info'))
    ds = cached(f'live_ds_{net}_{x["contract"]}.json', 3000, lambda: get(f'https://api.dexscreener.com/tokens/v1/{net}/{x["contract"]}', gt=False))
    try: a = pd['data']['attributes']
    except Exception: a = {}
    try: ia = info['data']['attributes']
    except Exception: ia = {}
    tx = a.get('transactions') or {}
    h6, h24 = tx.get('h6') or {}, tx.get('h24') or {}
    if h24.get('buyers'):
        r = (h6.get('buyers') or 0) * 4 / h24['buyers']
        ctx['buyers'] = {'h6': h6.get('buyers'), 'h24': h24.get('buyers'), 'buysH24': h24.get('buys'), 'sellsH24': h24.get('sells'), 'rate6vs24': round(r, 2)}
        if r >= 1.3: ctx['signs'].append('unique buyers accelerating: last 6h pace %.1fx the 24h pace (%s buyers in 6h, %s in 24h)' % (r, h6.get('buyers'), h24.get('buyers')))
    ctx['liqUsd'] = float(a['reserve_in_usd']) if a.get('reserve_in_usd') else x.get('liq')
    ctx['priceUsdGt'] = float(a['base_token_price_usd']) if a.get('base_token_price_usd') else None
    hold = ia.get('holders') or {}
    ctx['holders'] = hold.get('count'); top10 = None
    try: top10 = float((hold.get('distribution_percentage') or {}).get('top_10'))
    except Exception: pass
    if top10 is not None and top10 > 100: top10 = None
    ctx['top10'] = top10; ctx['honeypot'] = ia.get('is_honeypot')
    ctx['mintAuthority'] = ia.get('mint_authority'); ctx['freezeAuthority'] = ia.get('freeze_authority')
    # DexScreener: price cross-check + quote-side liquidity
    best = None
    for p in ds or []:
        if (p.get('baseToken') or {}).get('address', '').lower() != x['contract'].lower(): continue
        if not best or ((p.get('liquidity') or {}).get('usd') or 0) > ((best.get('liquidity') or {}).get('usd') or 0): best = p
    if best:
        L = best.get('liquidity') or {}; pu = float(best.get('priceUsd') or 0) or None
        ctx['priceUsdDs'] = pu; ctx['dsPair'] = best.get('pairAddress'); ctx['dsQuote'] = (best.get('quoteToken') or {}).get('symbol')
        if L.get('usd') and L.get('base') is not None and pu:
            qside = L['usd'] - L['base'] * pu; ctx['quoteSideUsd'] = round(qside)
            if L['usd'] > 0 and qside / L['usd'] < 0.2: ctx['flags'].append('fake liquidity: quote side only %.0f%% of the $%s pool' % (100 * qside / L['usd'], format(round(L['usd']), ',')))
    if net == 'solana':  # Jupiter price (free lite API): second cross-check for Solana tokens
        jp = cached(f'live_jup_{x["contract"]}.json', 3000, lambda: get(f'https://lite-api.jup.ag/price/v3?ids={x["contract"]}', gt=False))
        try: ctx['priceUsdJup'] = float((jp or {})[x['contract']]['usdPrice'])
        except Exception: pass
    if top10 is not None and top10 > 60: ctx['flags'].append('top-10 wallets hold %.1f%%' % top10)
    if ia.get('is_honeypot') is True: ctx['flags'].append('honeypot flagged (GeckoTerminal)')
    if ia.get('freeze_authority'): ctx['flags'].append('freeze authority still set')
    if ctx['flags']: ctx['veto'] = '; '.join(ctx['flags'])
    return ctx

def xmentions(sym):
    """X mentions from the sentiment collector (free X reads) + research/waking/xcounts.json (free reads made for this desk)."""
    src = []
    try: src.append(json.load(open(os.path.join(DATA, 'sentiment_counts.json'))).get('tokens', {}))
    except Exception: pass
    try: src.append(json.load(open(os.path.join(HERE, 'xcounts.json'))).get('tokens', {}))
    except Exception: pass
    for s in src:
        c = s.get(sym) or s.get(sym.upper())
        if not c or not c.get('hourly'): continue
        T = max(r[1] for r in c['hourly']); day = [0] * 7
        for r in c['hourly']:
            k = int((T - r[1]) // (86400e3))
            if 0 <= k < 7: day[k] += r[2]
        base = sum(day[1:]) / 6
        return {'last24h': day[0], 'avgPrior6d': round(base, 1), 'ratio': round(day[0] / base, 2) if base else None, 'asOf': T, 'query': c.get('query'),
                'turningUp': bool(base and day[0] >= 1.5 * base and base < 200 and not c.get('note')), 'daily': day[::-1], 'note': c.get('note')}
    return None

# ---------------- live cards ----------------
def plan(price, top, low, liq, alerts_on):
    walk = max(0.97 * low, 0.65 * price)
    size = 0.5 if alerts_on else 0.25
    cap = round(0.01 * liq) if liq else None
    return {'entry': 'Starter only at or below the flag zone: buy up to %s (the base top); never chase above %s (10%% over the base top).' % (fmt(top), fmt(top * NEAR)),
            'size': '%s%% of portfolio%s (%s)' % (size, (', and never more than $%s (1%% of pool liquidity)' % format(cap, ',')) if cap else '', 'experimental watch list: did not beat random' if not alerts_on else 'small: weak evidence'),
            'sizePct': size, 'maxUsdByLiquidity': cap,
            'sells': ['Sell 1/3 at %s (2x the flag price)' % fmt(2 * price), 'Sell 1/3 at %s (3x)' % fmt(3 * price), 'Trail the last 1/3: exit on a daily close 35% below the highest close since entry'],
            'sellLevels': [2 * price, 3 * price],
            'walkAway': ['Daily close below %s: exit all (%s)' % (fmt(walk), 'just under the quiet-base low' if walk == 0.97 * low else '-35% from the flag price; the base low is deeper'),
                         'No close above the base top %s within 30 days of the flag: exit (time stop)' % fmt(top),
                         'Pool liquidity down 40%+ since the flag, top-10 holders above 60%, fake-liquidity or honeypot flag: exit'],
            'walkAwayLevel': walk}
def fmt(x):
    return ('%.4g' % x) if x is not None else '—'

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--no-live', action='store_true'); a = ap.parse_args()
    t0 = time.time(); now = int(time.time() * 1000); today = int(time.time() // DAY)
    spec = open(os.path.join(HERE, 'PREDECLARED.md'), 'rb').read()
    sol, usdnotes = load_solana(); rh, bars4h = load_robinhood(); maj = load_majors()
    series = {'solana': sol, 'robinhood': rh, 'majors': maj}
    res, pers, sigsall = {}, {}, {}
    for p in POOLS:
        r, per, sigs = run_pool(p, series[p], today); res[p] = r; pers[p] = per; sigsall[p] = sigs
    rhm = rh_trigger_match([s for s in sigsall['robinhood']], bars4h)
    # previous snapshot -> first-flag ledger (kept inside waking.json so the frozen Render snapshot carries it)
    try: prev = json.load(open(os.path.join(DATA, 'waking.json')))
    except Exception: prev = {}
    ledger = prev.get('ledger', {})
    try: longbook = {str(c.get('symbol') or c.get('sym') or '').upper() for c in json.load(open(os.path.join(DATA, 'longbook.json'))).get('candidates', [])} - {''}
    except Exception: longbook = set()
    cards = []; named_rows = []
    for p in POOLS:
        alerts_on = res[p]['alerts']
        for tid, (d0, c, v, f, o) in pers[p].items():
            x = series[p][tid]; i_last = len(c) - 1
            if d0 + i_last < today - 3: continue  # stale / delisted series (e.g. halted Binance pairs): no live card
            recent = [s for s in sigsall[p] if s['token'] == tid and s['i'] >= i_last - 13]  # flagged within the last 14 days
            is_named = tid.lower() in NAMED
            if not recent and not is_named: continue
            # current (partial-day) price from the full series (backtest dropped today's bar)
            fd0, fc, fv = x['s']; price_now = float(fc[-1])
            # last bar is today's partial day: the price is as of the fetch; a completed day closes at the next UTC midnight
            price_at = min(int(x.get('fetchedAt') or now), (fd0 + len(fc)) * DAY * 1000)
            row = {'token': tid, 'symbol': x['symbol'], 'chain': x['chain'], 'pool': x.get('pool'), 'contract': x.get('contract'), 'pair': x.get('pair'), 'named': NAMED.get(tid.lower()),
                   'longbook': x['symbol'].upper() in longbook if p == 'majors' else False, 'priceNow': price_now, 'priceNowBarUtcDay': time.strftime('%Y-%m-%d', time.gmtime((fd0 + len(fc) - 1) * DAY)), 'priceNowAt': price_at, 'liq': x.get('liq'),
                   'fetchedAt': x.get('fetchedAt'), 'usdNote': x.get('usdNote'), 'pool_': p}
            il = i_last
            row['now'] = {k: bool(f[k][il]) for k in ('tradable', 'dead', 'down', 'flat', 'rising', 'hl', 'near')}
            row['nowM'] = {'qbase': float(f['qbase'][il]), 'volW': [float(z) for z in v[il - 3:il + 1]], 'top': float(f['top'][il]), 'low': float(f['low'][il]),
                           'ddPct': round(100 * (1 - c[il - 4] / f['cmx'][il]), 1), 'qRange': round(float(f['top'][il] / f['low'][il]), 2), 'deadPct': round(100 * float(f['qbase'][il] / f['peak7'][il]), 1) if f['peak7'][il] else None,
                           'avgVol30': float(f['m30'][il]) if not math.isnan(f['m30'][il]) else None}
            if recent:
                s = recent[-1]; key = '%s:%s:%d' % (p, tid, s['day'])
                L = ledger.get(key) or {'firstFlaggedAt': now if s['i'] == i_last else (s['day'] + 1) * DAY * 1000, 'how': 'live' if s['i'] == i_last else 'replay (signal day close; the scanner was built after it)',
                                       'flagPrice': s['price'], 'signalDay': time.strftime('%Y-%m-%d', time.gmtime(s['day'] * DAY))}
                ledger[key] = L
                row.update({'flag': L, 'flagKey': key, 'top': s['top'], 'low': s['low'], 'changePct': round(100 * (price_now / s['price'] - 1), 1)})
                si = s['i']
                row['signs'] = [
                    'long quiet stretch: 21-day median volume %.0f%% of its busiest week before it' % (100 * f['qbase'][si] / f['peak7'][si]),
                    'price %.0f%% below its high, flat base (21-day closes inside %.2fx)' % (100 * (1 - c[si - 4] / f['cmx'][si]), f['top'][si] / f['low'][si]),
                    'volume up %d of the last 4 days at >= 1.5x the quiet baseline (not one spike)' % int(f['cnt'][si]),
                    'higher low: lowest close of the wake days above the base low %s' % fmt(s['low']),
                    'still near the base: close %s vs base top %s (no breakout yet)' % (fmt(s['price']), fmt(s['top']))]
            else:
                row['signs'] = []
            cards.append(row)
    # live context + status for cards
    for row in cards:
        ctx = live_context(row) if not a.no_live and row['chain'] in NET else {'signs': [], 'flags': [], 'veto': None}
        row['ctx'] = ctx
        xm = xmentions(row['symbol'])
        if xm: row['x'] = xm
        if xm and xm['turningUp']: ctx['signs'].append('X mentions turning up: %d in the last 24h vs %.0f/day the prior 6 days' % (xm['last24h'], xm['avgPrior6d']))
        # stale USD guard on the live price: pools quoted in anything but SOL/USDC/USDT take DexScreener/Jupiter as 'now'
        ref = ctx.get('priceUsdDs') or ctx.get('priceUsdJup')
        q = (series.get('solana', {}).get(row['token']) or {}).get('quote')
        if ref and row['chain'] == 'solana' and q and q not in SAFE_QUOTES:
            row['priceSeries'] = row['priceNow']; row['priceNow'] = ref; row['priceSource'] = 'DexScreener' if ctx.get('priceUsdDs') else 'Jupiter'
            row['priceNowAt'] = now
            if row.get('flag'): row['changePct'] = round(100 * (ref / row['flag']['flagPrice'] - 1), 1)
        if ctx.get('priceUsdDs') and row['priceNow']:
            dev = ctx['priceUsdDs'] / (row.get('priceSeries') or row['priceNow']) - 1
            row['priceCheck'] = {'dexscreener': ctx['priceUsdDs'], 'jupiter': ctx.get('priceUsdJup'), 'gtPool': ctx.get('priceUsdGt'), 'series': row.get('priceSeries') or row['priceNow'], 'devPct': round(100 * dev, 1)}
            if abs(dev) > 0.25: row['priceCheck']['warn'] = 'scanner series price differs from DexScreener by %.0f%%%s' % (100 * dev, ': using the DexScreener price as now' if row.get('priceSource') else ': treat the USD figure as unreliable')
        if row.get('flag'):
            L = row['flag']
            if 'flagLiq' not in L and ctx.get('liqUsd'): L['flagLiq'] = ctx['liqUsd']
            if 'flagHolders' not in L and ctx.get('holders'): L['flagHolders'] = ctx['holders']
            if L.get('flagHolders') and ctx.get('holders') and ctx['holders'] != L['flagHolders']:
                g = ctx['holders'] / L['flagHolders'] - 1
                if g > 0.02: ctx['signs'].append('holders growing: %s now vs %s at flag (+%.0f%%)' % (format(ctx['holders'], ','), format(L['flagHolders'], ','), 100 * g))
            liqch = (ctx['liqUsd'] / L['flagLiq'] - 1) if ctx.get('liqUsd') and L.get('flagLiq') else None
            row['liqChangePct'] = round(100 * liqch, 1) if liqch is not None else None
            if liqch is not None and liqch > 0.10: ctx['signs'].append('liquidity added: +%.0f%% since the flag' % (100 * liqch))
            pl = plan(L['flagPrice'], row['top'], row['low'], ctx.get('liqUsd') or row.get('liq'), res[row['pool_']]['alerts'])
            row['plan'] = pl
            pn = row['priceNow']
            inval = []
            if pn <= pl['walkAwayLevel']: inval.append('price %s is under the walk-away level %s' % (fmt(pn), fmt(pl['walkAwayLevel'])))
            if ctx.get('veto'): inval.append('safety veto (grade F): ' + ctx['veto'])
            if liqch is not None and liqch <= -0.40: inval.append('liquidity pulled %.0f%% since the flag' % (100 * liqch))
            if row.get('usdNote') and 'excluded' in (row['usdNote'] or ''): inval.append(row['usdNote'])
            row['status'] = ('invalidated' if inval else 'broke out' if pn > row['top'] * NEAR else 'cheaper than flag' if pn <= L['flagPrice'] else 'above flag')
            row['statusWhy'] = '; '.join(inval) if inval else {'broke out': 'now above the base top +10%%: past the cheap zone, do not chase (breakout entry %s would apply)' % fmt(row['top']),
                                                               'cheaper than flag': 'price is at or below the flag price and the base is intact',
                                                               'above flag': 'above the flag price but still inside the buy zone (under the base top)'}[row['status']]
        row['grade'] = 'F' if ctx.get('veto') else ('safety checks pass' if row['chain'] in NET and (ctx.get('top10') is not None or ctx.get('honeypot') is not None) else 'n/a' if row['chain'] not in NET else 'safety data incomplete')
        row['updatedAt'] = now
        row['strength'] = res[row['pool_']]['strength']
        row['dexscreener'] = ('https://dexscreener.com/%s/%s' % (row['chain'], row['pool'])) if row['chain'] in NET else None
    order = {'cheaper than flag': 0, 'above flag': 1, 'broke out': 2, 'invalidated': 3}
    flagged = [r for r in cards if r.get('flag')]
    flagged.sort(key=lambda r: (order.get(r['status'], 9), -(r['flag']['firstFlaggedAt'])))
    named = []
    for tid_raw, lbl in NAMED_RAW.items():
        tid = tid_raw.lower()
        r = next((c for c in cards if c['token'].lower() == tid), None)
        if r: named.append({'label': lbl, 'token': tid_raw, 'inScan': True, 'passed': sum(1 for v in r['now'].values() if v), 'flagged': bool(r.get('flag')), 'status': r.get('status'), 'now': r['now'], 'nowM': r['nowM'], 'priceNow': r['priceNow'],
                            'usdNote': r.get('usdNote'), 'grade': r['grade'], 'ctx': {k: r['ctx'].get(k) for k in ('holders', 'top10', 'liqUsd', 'buyers', 'flags', 'priceUsdDs', 'priceUsdGt')}, 'priceCheck': r.get('priceCheck'), 'x': r.get('x'),
                            'card': r if r.get('flag') else None})
        else:
            why = None
            for p in POOLS:
                for k, x in series[p].items():
                    if k.lower() != tid: continue
                    d0_, c_, v_ = x['s']; ld = d0_ + len(c_) - 1; age = len(c_)
                    if ld < today - 3: why = 'no trades/candles since %s UTC (stale or dead pool): not scored' % time.strftime('%Y-%m-%d', time.gmtime(ld * DAY))
                    elif age < HIST + 6: why = 'only %d days of daily history (the signal needs >= 45 days before the wake window + the current day excluded)' % age
                    if (usdnotes.get(k) or {}).get('note'): why = (why + '; ' if why else '') + usdnotes[k]['note']
            desc = None
            for p in POOLS:
                for k, x in series[p].items():
                    if k.lower() == tid:
                        d0_, c_, v_ = x['s']
                        if len(c_) >= 10:
                            pk = float(c_.max()); lw = float(c_[-21:].min()); hi21 = float(c_[-22:-1].max()) if len(c_) > 22 else float(c_[:-1].max())
                            vb = float(np.median(v_[-25:-4])) if len(v_) > 25 else float(np.median(v_[:-4]))
                            desc = {'priceNow': float(c_[-1]), 'belowPeakPct': round(100 * (1 - c_[-1] / pk), 1), 'peakDay': time.strftime('%Y-%m-%d', time.gmtime((d0_ + int(c_.argmax())) * DAY)),
                                    'vsRecentTopPct': round(100 * (c_[-1] / hi21 - 1), 1), 'last4dVolVsBaselineX': [round(float(z) / vb, 2) if vb else None for z in v_[-4:]],
                                    'days': len(c_), 'lastDay': time.strftime('%Y-%m-%d', time.gmtime((d0_ + len(c_) - 1) * DAY)), 'usdNote': x.get('usdNote'),
                                    'read': 'descriptive only (not a signal): %.0f%% below its %s peak; last 4 daily volumes %s x its prior median' % (100 * (1 - c_[-1] / pk), time.strftime('%b %d', time.gmtime((d0_ + int(c_.argmax())) * DAY)), [round(float(z) / vb, 1) if vb else None for z in v_[-4:]])}
            why = why or (usdnotes.get(tid) or {}).get('note') or ('no daily series loaded (not in the fetched universe, or under 45 days of history)')
            nctx = None
            for p in ('solana', 'robinhood'):
                for k, x in series[p].items():
                    if k.lower() == tid and not a.no_live:
                        nctx = live_context({'chain': x['chain'], 'pool': x['pool'], 'contract': k, 'liq': x.get('liq')})
                        nctx = {kk: nctx.get(kk) for kk in ('holders', 'top10', 'liqUsd', 'buyers', 'flags', 'veto', 'priceUsdDs', 'priceUsdJup', 'priceUsdGt', 'signs')}
                        if desc and nctx.get('priceUsdDs'): desc['priceCheck'] = {'dexscreener': nctx['priceUsdDs'], 'jupiter': nctx.get('priceUsdJup'), 'gtPool': nctx.get('priceUsdGt'), 'series': desc['priceNow'], 'devPct': round(100 * (nctx['priceUsdDs'] / desc['priceNow'] - 1), 1)}
            named.append({'label': lbl, 'token': tid_raw, 'inScan': False, 'why': why, 'desc': desc, 'ctx': nctx, 'grade': ('F' if nctx and nctx.get('veto') else 'safety checks pass' if nctx else None), 'x': xmentions(lbl.split()[0])})
    for r in cards: r.pop('pool_', None)
    nowcounts = {p: int(sum(1 for t, (d0, c, v, f, o) in pers[p].items() if f['sig'][len(c) - 1] and d0 + len(c) - 1 >= today - 1)) for p in POOLS}
    # closest to waking on the DEX chains (descriptive only, NOT flagged): >= 5 of the 7 conditions on the last complete day
    LBL = {'tradable': 'volume floor', 'dead': 'dead stretch', 'down': '40%+ down', 'flat': 'flat base (<=1.6x)', 'rising': 'volume up 3 of 4 days', 'hl': 'higher low', 'near': 'still at the base'}
    near = []
    for p in ('solana', 'robinhood'):
        for tid, (d0, c, v, f, o) in pers[p].items():
            il = len(c) - 1
            if d0 + il < today - 1 or f['sig'][il] or not f['tradable'][il]: continue
            ok = {k: bool(f[k][il]) for k in LBL}
            if sum(ok.values()) < 5: continue
            x = series[p][tid]
            near.append({'symbol': x['symbol'], 'chain': x['chain'], 'contract': x.get('contract'), 'pool': x.get('pool'), 'passed': sum(ok.values()), 'of': 7,
                         'missing': [LBL[k] for k, vv in ok.items() if not vv], 'priceSeries': float(x['s'][1][-1]), 'liq': x.get('liq'), 'usdNote': x.get('usdNote'),
                         'baseTop': float(f['top'][il]), 'baseLow': float(f['low'][il]), 'qRange': round(float(f['top'][il] / f['low'][il]), 2),
                         'volLast4VsBase': [round(float(z / f['qbase'][il]), 2) if f['qbase'][il] else None for z in v[il - 3:il + 1]], 'dayUtc': time.strftime('%Y-%m-%d', time.gmtime((d0 + il) * DAY))})
    near.sort(key=lambda r: (-r['passed'], -(r['liq'] or 0)))
    out = {'v': 1, 'generatedAt': now, 'elapsedSec': round(time.time() - t0), 'experimental': not any(res[p]['alerts'] for p in POOLS),
           'alertsOn': {p: res[p]['alerts'] for p in POOLS},
           'predeclared': {'file': 'research/waking/PREDECLARED.md', 'sha256': hashlib.sha256(spec).hexdigest(), 'text': spec.decode()},
           'params': {'historyDays': HIST, 'quietDays': QN, 'wakeDays': WN, 'deadMaxVsPeakWeek': DEAD, 'minDrawdown': DD, 'maxBaseRange': FLAT, 'volMult': VM, 'volDays': VDAYS, 'nearTop': NEAR, 'dedupeDays': DEDUPE, 'fwdDays': FWD, 'floorUsd': FLOOR},
           'backtest': {p: {k: v for k, v in res[p].items()} for p in POOLS}, 'rhRealTrigger': rhm,
           'universe': {p: len(series[p]) for p in POOLS}, 'signalsOnLastDay': nowcounts,
           'items': flagged, 'named': named, 'closest': near[:15], 'usdGuard': usdnotes, 'calls': CALLS, 'ledger': ledger,
           'sources': ['Binance spot daily (data-api.binance.vision mirror, via data/flatbase_series)', 'GeckoTerminal API v2 daily/4h OHLCV, pools, token info (free)', 'DexScreener tokens API (free)', 'X mention counts: free X read tools (sentiment collector)'],
           'caveats': ['Universes are today\'s survivors (listed pools / Binance pairs incl. halted ones): dead tokens are under-represented, so DEX results are biased upward.',
                       'Liquidity at signal time is unknown for DEX pools; a 30-day average volume floor is used instead.',
                       'Buyers, holders, liquidity-added, X mentions and smart money cannot be replayed with free data: they are shown as live context only and never scored.',
                       'Daily closes only (Binance series has no intraday highs), so 2x / -50% are close-to-close.']}
    tmp = os.path.join(DATA, 'waking.json.tmp'); json.dump(out, open(tmp, 'w'), default=lambda o: o.item() if hasattr(o, 'item') else str(o)); os.replace(tmp, os.path.join(DATA, 'waking.json'))
    print(json.dumps({p: {'tokens': res[p]['tokens'], 'split': res[p]['splitUtc'], 'earlier': {k: res[p]['earlier'].get(k) for k in ('n', 'tokens', 'hit2xPct', 'drop50Pct', 'medR30', 'net', 'randomNet', 'beats')},
                          'later': {k: res[p]['later'].get(k) for k in ('n', 'tokens', 'hit2xPct', 'drop50Pct', 'medR30', 'net', 'randomNet', 'beats')}, 'strength': res[p]['strength']} for p in POOLS}, indent=1))
    print('cards', len(flagged), [(r['symbol'], r['chain'], r['status']) for r in flagged][:30], 'calls', CALLS, file=sys.stderr)

if __name__ == '__main__': main()
