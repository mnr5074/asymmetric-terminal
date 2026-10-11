#!/usr/bin/env python3
"""Options screener: every listed Derive.xyz option + delayed CBOE chains for a broad US stock/ETF universe.
Long calls/puts only (defined max loss = premium). All numbers are model ESTIMATES, not advice.
Sources (keyless, verified 2026-10-11): api.lyra.finance/public (Derive: get_all_instruments, get_ticker),
cdn-api.cboe.com delayed_quotes/options/<SYM>.json (~15 min delayed, last session volume),
query1.finance.yahoo.com v8 chart (daily closes for realized vol), api.nasdaq.com earnings calendar,
api.exchange.coinbase.com candles (crypto realized vol).
Output: data/options.json"""
import json, math, os, sys, time, urllib.request, concurrent.futures as cf, datetime as dt, threading
from common import DATA_DIR
from calltrack import Tracker

UA = {'user-agent': 'Mozilla/5.0 (asymmetric-terminal research)', 'accept': 'application/json'}
def get(url, data=None, timeout=25, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers={**UA, **({'content-type': 'application/json'} if data is not None else {})})
            return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(1.5 * (i + 1))

STOCKS = os.environ.get('OPT_UNIVERSE', 'SPY,QQQ,IWM,AAPL,MSFT,NVDA,TSLA,AMZN,META,GOOGL,AMD,NFLX,AVGO,PLTR,COIN,MSTR,HOOD,SMCI,ARM,MU,INTC,UBER,SHOP,XYZ,PYPL,BABA,NIO,SOFI,RIVN,LCID,GME,AMC,DKNG,RBLX,SNAP,CRWD,SNOW,PANW,ORCL,CRM,ADBE,JPM,BAC,XOM,CVX,BA,DIS,WMT,COST,LLY,UNH,PFE,MRNA,TSM,ASML,MARA,RIOT,CLSK,IBIT,GLD,SLV,TLT,XLE,ARKK').split(',')
R_STOCK, R_CRYPTO = 0.04, 0.0

# ---------------- Black-Scholes ----------------
N = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))
def bs(S, K, T, v, r, cp):
    if T <= 0 or v <= 0: return max(0.0, (S - K) if cp == 'C' else (K - S))
    sq = v * math.sqrt(T); d1 = (math.log(S / K) + (r + v * v / 2) * T) / sq; d2 = d1 - sq
    return S * N(d1) - K * math.exp(-r * T) * N(d2) if cp == 'C' else K * math.exp(-r * T) * N(-d2) - S * N(-d1)
def p_itm(S, K, T, v, cp, mu=0.0):
    """P(S_T beyond strike) under lognormal with drift mu (0 = no drift; risk-neutral-ish)."""
    if T <= 0 or v <= 0: return float((S > K) if cp == 'C' else (S < K))
    d2 = (math.log(S / K) + (mu - v * v / 2) * T) / (v * math.sqrt(T))
    return N(d2) if cp == 'C' else N(-d2)
def p_touch(S, B, T, v, cp):
    """P(price touches barrier B before expiry), driftless reflection approximation = 2*P(S_T beyond B)."""
    if (cp == 'C' and B <= S) or (cp == 'P' and B >= S): return 1.0
    if B <= 0: return 0.0
    return min(1.0, 2 * p_itm(S, B, T, v, cp))
def theta_day(S, K, T, v, r, cp):
    h = 1 / 365
    return bs(S, K, max(T - h, 1e-6), v, r, cp) - bs(S, K, T, v, r, cp)
def solve_price(target_val, K, T, v, r, cp, S0):
    """Underlying price at which the option is worth target_val with T years left (bisection)."""
    lo, hi = (S0 * 0.2, S0 * 20) if cp == 'C' else (S0 * 0.01, S0 * 3)
    f = lambda s: bs(s, K, T, v, r, cp) - target_val
    if f(lo) * f(hi) > 0: return None
    for _ in range(60):
        m = (lo + hi) / 2
        if (f(m) > 0) == (cp == 'C'): hi = m
        else: lo = m
    return (lo + hi) / 2

def rv_blend(cl, ann):
    """Mean of 30/90/180-day close-to-close vols (where available): less sensitive to one recent shock."""
    xs = [v for v in (rv_from_closes(cl, n) for n in (30, 90, 180)) if v]
    return (sum(xs) / len(xs)) * math.sqrt(ann) if xs else None
def rv_from_closes(cl, n=30):
    cl = [c for c in cl if c and c > 0]
    if len(cl) < n + 1: return None
    rets = [math.log(cl[i] / cl[i - 1]) for i in range(len(cl) - n, len(cl))]
    m = sum(rets) / len(rets)
    return math.sqrt(sum((x - m) ** 2 for x in rets) / (len(rets) - 1))

# ---------------- grading ----------------
GRADE_DOC = ('Score 0-100 = 30*EV + 25*touch + 20*convexity + 15*cheapness + 10*liquidity. '
             'EV: clip((EV%+25)/225) where EV% = (Black-Scholes value with realized vol - premium)/premium; realized vol = mean of 30/90/180-day close-to-close vol. '
             'touch: clip(P(touch 3x-payoff price before expiry, realized vol)/0.5). '
             'convexity: clip(ln(1+R)/ln(11)), R = payoff multiple at a +2 sigma (IV) move by expiry. '
             'cheapness: clip((1.3 - IV/RV)/0.6). liquidity: clip(1 - spread/30% of mid), 0 if no bid/ask or no open interest. '
             'Grade A>=75, B>=60, C>=45, D>=30, else F. Caps: mark-only quote (no live bid/ask) max C; under 3 days to expiry max D; under 7 days or theta >20%/day max C; theta >10%/day max B; earnings before expiry and IV/RV > 1.5 max C (IV crush).')
def clip(x): return max(0.0, min(1.0, x))
def grade_of(score):
    return 'A' if score >= 75 else 'B' if score >= 60 else 'C' if score >= 45 else 'D' if score >= 30 else 'F'
CAP = {'A': 4, 'B': 3, 'C': 2, 'D': 1, 'F': 0}

def analyze(c, now):
    """c: dict(underlying, venue, name, cp, K, expiry_ts, S, bid, ask, mark, iv, oi, vol, mult, rv, r, earnings)."""
    S, K, cp, r = c['S'], c['K'], c['cp'], c['r']
    T = (c['expiry_ts'] - now) / (365 * 86400)
    if T <= 1 / 365 or not S: return None
    bid, ask = c.get('bid') or 0, c.get('ask') or 0
    live = bid > 0 and ask > 0 and ask >= bid
    mid = (bid + ask) / 2 if live else (ask if ask > 0 else (c.get('mark') or 0))
    if mid <= 0: return None
    iv = c.get('iv') or None; rv = c.get('rv') or None
    if not iv or iv <= 0.01: return None
    vol_rv = rv or iv
    spread = (ask - bid) / mid if live else None
    fv_rv = bs(S, K, T, vol_rv, r, cp)
    fv_iv = bs(S, K, T, iv, r, cp)
    be = K + mid if cp == 'C' else K - mid
    _sq = iv * math.sqrt(T); _d1 = (math.log(S / K) + (r + iv * iv / 2) * T) / _sq; _pdf = math.exp(-_d1 * _d1 / 2) / math.sqrt(2 * math.pi)
    greeks = {'delta': round(N(_d1) if cp == 'C' else N(_d1) - 1, 4), 'gamma': _pdf / (S * _sq), 'vega_1pt': S * _pdf * math.sqrt(T) / 100}
    sig1 = (S * math.exp(-iv * math.sqrt(T)), S * math.exp(iv * math.sqrt(T)))
    sig2 = (S * math.exp(-2 * iv * math.sqrt(T)), S * math.exp(2 * iv * math.sqrt(T)))
    tgt = {}
    for m in (3, 5, 10):
        p = K + m * mid if cp == 'C' else K - m * mid
        tgt[f'{m}x'] = p if p > 0 else None
    fav2 = sig2[1] if cp == 'C' else sig2[0]
    payoff2 = max(0.0, fav2 - K) if cp == 'C' else max(0.0, K - fav2)
    R = payoff2 / mid
    t3 = tgt['3x']
    touch_rv = p_touch(S, t3, T, vol_rv, cp) if t3 else 0.0
    touch_iv = p_touch(S, t3, T, iv, cp) if t3 else 0.0
    pitm_iv, pitm_rv = p_itm(S, K, T, iv, cp), p_itm(S, K, T, vol_rv, cp)
    ev = fv_rv * math.exp(r * T) - mid  # undiscounted expected payoff (driftless lognormal, realized vol) minus cost
    ev_pct = ev / mid
    ivrv = iv / rv if rv else None
    s_ev = clip((ev_pct * 100 + 25) / 225)
    s_touch = clip(touch_rv / 0.5)
    s_conv = clip(math.log(1 + R) / math.log(11))
    s_cheap = clip((1.3 - ivrv) / 0.6) if ivrv else 0.5
    s_liq = 0.0 if not live or not (c.get('oi') or 0) > 0 else clip(1 - spread / 0.3)
    score = 30 * s_ev + 25 * s_touch + 20 * s_conv + 15 * s_cheap + 10 * s_liq
    g = grade_of(score); why = []
    days = T * 365
    earn_before = c.get('earnings') and c['earnings'] <= dt.datetime.utcfromtimestamp(c['expiry_ts']).strftime('%Y-%m-%d')
    if not live and CAP[g] > 2: g = 'C'; why.append('mark-only quote (no live bid/ask)')
    if days < 3 and CAP[g] > 1: g = 'D'; why.append('under 3 days to expiry')
    if earn_before and ivrv and ivrv > 1.5 and CAP[g] > 2: g = 'C'; why.append('earnings before expiry with rich IV (crush risk)')
    th_pct = -theta_day(S, K, T, iv, r, cp) / mid * 100
    if (days < 7 or th_pct > 20) and CAP[g] > 2: g = 'C'; why.append(f'fast decay: {days:.0f}d left, theta {th_pct:.0f}%/day')
    elif th_pct > 10 and CAP[g] > 3: g = 'B'; why.append(f'theta {th_pct:.0f}%/day')
    # timing: suggested exit keeps >=40% of the original time left (theta accelerates late)
    exit_T = T * 0.4 if days > 14 else max(T * 0.25, 1 / 365)  # time REMAINING at the suggested exit
    exit_ts = c['expiry_ts'] - exit_T * 365 * 86400
    need3_exit = solve_price(3 * mid, K, exit_T, iv, r, cp, S)
    # chance of profit + chance of hitting the take-profit levels (2x, 3x) before the time stop (~21 DTE rule)
    p_profit = p_itm(S, be, T, vol_rv, cp) if be > 0 else 0.0
    stop_T = 21 / 365 if days > 35 else exit_T          # time remaining at the time stop
    hold_T = max(T - stop_T, 1 / 365)                     # time we hold
    stop_ts = c['expiry_ts'] - stop_T * 365 * 86400
    tp_need = {m: solve_price(m * mid, K, stop_T, iv, r, cp, S) for m in (2, 3)}
    p_tp = {f'{m}x': (p_touch(S, b, hold_T, vol_rv, cp) if b else 0.0) for m, b in tp_need.items()}
    vol_oi = (c['vol'] / c['oi']) if c.get('oi') and c.get('vol') is not None else None
    unusual = bool(c.get('vol') and c['vol'] >= 500 and c['vol'] >= 1.5 * (c.get('oi') or 0))
    th = theta_day(S, K, T, iv, r, cp)
    mult = c.get('mult', 1)
    return {
        'id': c['name'], 'venue': c['venue'], 'underlying': c['underlying'], 'type': 'call' if cp == 'C' else 'put', 'strike': K,
        'expiry': dt.datetime.utcfromtimestamp(c['expiry_ts']).strftime('%Y-%m-%d'), 'days': round(days, 1), 'spot': S,
        'bid': bid or None, 'ask': ask or None, 'mid': mid, 'live_quote': live, 'spread_pct': spread, 'oi': c.get('oi'), 'volume': c.get('vol'), 'vol_oi': vol_oi, 'unusual': unusual,
        'iv': iv, 'rv30': rv, 'iv_rv': ivrv, 'fair_rv': fv_rv, 'fair_iv': fv_iv, 'prem_vs_fair': (mid / fv_rv - 1) if fv_rv > 0 else None,
        'max_loss': mid * mult, 'mult': mult, 'breakeven': be, 'move_to_be_pct': (be / S - 1) * 100,
        'sigma1': sig1, 'sigma2': sig2, 'targets': tgt, 'exit_by': dt.datetime.utcfromtimestamp(exit_ts).strftime('%Y-%m-%d'), 'need_for_3x_at_exit': need3_exit,
        'p_itm_iv': pitm_iv, 'p_itm_rv': pitm_rv, 'p_profit_rv': p_profit, 'p_tp_before_stop': p_tp, 'tp_need': {f'{m}x': v for m, v in tp_need.items()}, 'time_stop': dt.datetime.utcfromtimestamp(stop_ts).strftime('%Y-%m-%d'), 'p_touch3x_iv': touch_iv, 'p_touch3x_rv': touch_rv,
        'ev': ev * mult, 'ev_pct': ev_pct * 100, 'rr_2sigma': R, 'theta_day': th * mult, 'delta': greeks['delta'], 'gamma': greeks['gamma'], 'vega_1pt': greeks['vega_1pt'] * mult, 'theta_pct_day': th / mid * 100,
        'earnings': c.get('earnings'), 'earnings_before_expiry': bool(earn_before),
        'score': round(score, 1), 'grade': g, 'caps': why,
        'parts': {'ev': round(s_ev, 2), 'touch': round(s_touch, 2), 'convexity': round(s_conv, 2), 'cheapness': round(s_cheap, 2), 'liquidity': round(s_liq, 2)},
    }

# ---------------- data: Derive ----------------
DERIVE = 'https://api.lyra.finance/public/'
CB_MAP = {'XAUT': 'PAXG-USD'}
def coinbase_rv(base, index_px=None):
    prod = CB_MAP.get(base, f'{base}-USD')
    try:
        d = get(f'https://api.exchange.coinbase.com/products/{prod}/candles?granularity=86400')
        cl = [x[4] for x in sorted(d, key=lambda x: x[0])]
        if index_px and cl and abs(cl[-1] / index_px - 1) > 0.15:  # same ticker, different asset (e.g. LIT) -> reject
            return None, f'{prod} rejected (price {cl[-1]:.4g} vs Derive index {index_px:.4g})'
        return rv_blend(cl, 365), prod
    except Exception: return None, None

def derive_contracts(log):
    ins, page = [], 1
    while True:
        d = get(DERIVE + 'get_all_instruments', {'instrument_type': 'option', 'expired': False, 'page_size': 1000, 'page': page})['result']
        ins += d['instruments']
        if page >= d['pagination']['num_pages']: break
        page += 1
    log(f'derive: {len(ins)} listed options')
    lock = threading.Lock(); last = [0.0]
    def tick(n):
        with lock:  # ~25 req/s
            w = last[0] + 0.04 - time.time()
            if w > 0: time.sleep(w)
            last[0] = time.time()
        try: return get(DERIVE + 'get_ticker', {'instrument_name': n}, timeout=20)['result']
        except Exception: return None
    with cf.ThreadPoolExecutor(8) as ex: ticks = list(ex.map(tick, [x['instrument_name'] for x in ins]))
    rvs = {}
    out = []; failed = 0
    for x, t in zip(ins, ticks):
        if not t: failed += 1; continue
        base = x['base_currency']
        if base not in rvs: rvs[base] = coinbase_rv(base, float(t.get('index_price') or 0) or None)
        op = t.get('option_pricing') or {}
        oi = sum(float(e.get('current_open_interest') or 0) for v in (t.get('open_interest') or {}).values() for e in v)
        od = x['option_details']
        out.append({'underlying': base, 'venue': 'Derive', 'name': x['instrument_name'], 'cp': od['option_type'], 'K': float(od['strike']), 'expiry_ts': od['expiry'],
                    'S': float(t.get('index_price') or 0), 'bid': float(t.get('best_bid_price') or 0), 'ask': float(t.get('best_ask_price') or 0), 'mark': float(t.get('mark_price') or 0),
                    'iv': float(op.get('iv') or 0), 'oi': oi, 'vol': None, 'mult': 1, 'rv': rvs[base][0], 'r': R_CRYPTO, 'earnings': None})
    log(f'derive: tickers ok {len(out)}, failed {failed}; realized-vol sources: ' + ', '.join(f'{k}={v[1] or "none"}' for k, v in rvs.items()))
    return out, len(ins), {k: v[1] for k, v in rvs.items()}

# ---------------- data: CBOE + Yahoo + Nasdaq ----------------
def earnings_map(days=60, log=print):
    m = {}
    d0 = dt.date.today()
    for i in range(days):
        d = d0 + dt.timedelta(days=i)
        if d.weekday() >= 5: continue
        try:
            rows = (get(f'https://api.nasdaq.com/api/calendar/earnings?date={d.isoformat()}').get('data') or {}).get('rows') or []
            for r in rows: m.setdefault(r['symbol'], d.isoformat())
        except Exception: pass
        time.sleep(0.25)
    log(f'earnings calendar: {len(m)} symbols reporting in the next {days} days')
    return m

def parse_occ(sym):
    # e.g. AAPL261021C00300000
    i = len(sym) - 15
    root, ymd, cp, k = sym[:i], sym[i:i + 6], sym[i + 6], sym[i + 7:]
    exp = dt.datetime(2000 + int(ymd[:2]), int(ymd[2:4]), int(ymd[4:6]), 20, 0, tzinfo=dt.timezone.utc)  # 4pm ET close
    return root, int(exp.timestamp()), cp, int(k) / 1000

FLOW = {}
OPT_BATCH = int(os.environ.get('OPT_BATCH', '250'))
def pick_symbols(log):
    """Core list every run + a rotating batch from the full optionable universe (data/opt_universe.json)."""
    st_f = os.path.join(DATA_DIR, 'opt_scan_state.json')
    try: st = json.load(open(st_f))
    except Exception: st = {}
    try:
        uf = os.path.join(DATA_DIR, 'opt_universe.json')
        if time.time() - os.path.getmtime(uf) > 7 * 86400: raise FileNotFoundError
        U = json.load(open(uf))
    except Exception:
        try:
            import opt_universe; opt_universe.main(); U = json.load(open(os.path.join(DATA_DIR, 'opt_universe.json')))
        except Exception as e: log('universe build failed:', e); U = {'symbols': []}
    now = time.time(); core = [x for x in STOCKS if x]
    rest = [x['s'] for x in U['symbols'] if x['s'] not in core]
    never = [x for x in rest if x not in st]
    valuable_due = sorted([x for x in rest if x in st and st[x].get('oi', 0) >= 5000 and now - st[x]['t'] > 3600], key=lambda x: st[x]['t'])
    low_due = sorted([x for x in rest if x in st and st[x].get('oi', 0) < 5000 and now - st[x]['t'] > 7 * 86400], key=lambda x: st[x]['t'])
    batch = (never[:OPT_BATCH // 2] + valuable_due + never[OPT_BATCH // 2:] + low_due)[:OPT_BATCH]
    log(f'universe {len(U["symbols"])} optionable; scanned before {len(st)}; this run core {len(core)} + batch {len(batch)} (never-seen {len(never)}, valuable due {len(valuable_due)}, low-OI due {len(low_due)})')
    return core + batch, st, st_f, U

def stock_contracts(log, earn, sink, syms=None, st=None):
    out, ok, fail = [], [], []
    n = 0; st = st if st is not None else {}
    for s in (syms or STOCKS):
        try:
            d = get(f'https://cdn-api.cboe.com/api/global/delayed_quotes/options/{s}.json')['data']
            ch = get(f'https://query1.finance.yahoo.com/v8/finance/chart/{s}?range=1y&interval=1d')['chart']['result'][0]
            closes = ch['indicators']['quote'][0]['close']
            rv = rv_blend(closes, 252)
            S = d.get('current_price') or ch['meta'].get('regularMarketPrice')
            out = []
            for o in d['options']:
                root, exp, cp, K = parse_occ(o['option'])
                if root != s: continue
                out.append({'underlying': s, 'venue': 'CBOE (delayed)', 'name': o['option'], 'cp': cp, 'K': K, 'expiry_ts': exp, 'S': S,
                            'bid': o.get('bid') or 0, 'ask': o.get('ask') or 0, 'mark': o.get('theo') or 0, 'iv': o.get('iv') or 0, 'oi': o.get('open_interest') or 0,
                            'vol': o.get('volume') or 0, 'mult': 100, 'rv': rv, 'r': R_STOCK, 'earnings': earn.get(s), 'quote_time': d.get('last_trade_time')})
            toi = sum(c['oi'] for c in out); st[s] = {'t': time.time(), 'oi': toi, 'n': len(out)}
            cv = sum(c['vol'] or 0 for c in out if c['cp'] == 'C'); pv = sum(c['vol'] or 0 for c in out if c['cp'] == 'P')
            cprem = sum((c['vol'] or 0) * ((c['bid'] + c['ask']) / 2 if c['bid'] and c['ask'] else c['mark']) * 100 for c in out if c['cp'] == 'C')
            pprem = sum((c['vol'] or 0) * ((c['bid'] + c['ask']) / 2 if c['bid'] and c['ask'] else c['mark']) * 100 for c in out if c['cp'] == 'P')
            FLOW[s] = {'call_vol': cv, 'put_vol': pv, 'call_put_vol': cv / pv if pv else None, 'call_premium_usd': cprem, 'put_premium_usd': pprem, 'total_oi': toi, 'spot': S}
            ok.append(s); n += len(out)
            if toi >= 1000 or s in STOCKS: sink(out)  # skip chains with almost no open interest (no real market)
            out = []; del d
        except Exception as e:
            fail.append(f'{s}: {str(e)[:60]}')
        time.sleep(0.6)
    log(f'cboe: {len(ok)} underlyings, {n} contracts; failed: {fail[:5]}')
    return n, ok, fail

def main():
    t0 = time.time()
    log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
    now = time.time()
    def eligible(p):
        # long options that cost something meaningful and are not deep ITM (asymmetric payoff profile)
        mny = p['strike'] / p['spot']
        otm = (p['type'] == 'call' and mny >= 0.97) or (p['type'] == 'put' and mny <= 1.03)
        min_px = 0.05 if p['venue'].startswith('CBOE') else 0.5
        return otm and p['mid'] >= min_px and 2 <= p['days'] <= 400
    tr = Tracker('options'); open_ids = tr.keys_open(400 * 86400); seen_mid = {}
    lock = threading.Lock(); unusual_all = []; analyzed = [0]
    topk, bestsc, grades, n_elig = {}, {}, {}, [0]
    def sink(raws):  # analyze one batch, keep only what is needed (keeps memory well under 512 MB)
        for c in raws:
            a = analyze(c, now)
            if not a: continue
            with lock:
                analyzed[0] += 1
                if a['id'] in open_ids: seen_mid[a['id']] = a['mid']
                if a['unusual']:
                    unusual_all.append(a)
                    if len(unusual_all) > 300: unusual_all.sort(key=lambda p: -(p['vol_oi'] or 0)); del unusual_all[60:]
                if eligible(a):
                    n_elig[0] += 1; grades[a['grade']] = grades.get(a['grade'], 0) + 1
                    u = a['underlying']; b = bestsc.setdefault(u, {}); b[a['expiry']] = max(b.get(a['expiry'], -1), a['score'])
                    L = topk.setdefault(u, []); L.append(a)
                    if len(L) > 80: L.sort(key=lambda p: -p['score']); del L[20:]
    uni_meta = {}
    with cf.ThreadPoolExecutor(2) as ex:
        fd = ex.submit(derive_contracts, log)
        def stocks():
            earn = earnings_map(log=log)
            syms, st, st_f, U = pick_symbols(log); uni_meta.update({k: v for k, v in U.items() if k != 'symbols'}); uni_meta['run_symbols'] = len(syms)
            r = stock_contracts(log, earn, sink, syms, st)
            json.dump(st, open(st_f, 'w')); uni_meta['scanned_total'] = len(st); uni_meta['valuable_oi5000'] = sum(1 for v in st.values() if v.get('oi', 0) >= 5000)
            return r
        fs = ex.submit(stocks)
        dcon, n_derive, rvsrc = fd.result()
        sink(dcon); n_dcon = len(dcon); del dcon
        n_scon, ok, fail = fs.result()
    best_exp = {u: max(b.items(), key=lambda kv: kv[1])[0] for u, b in bestsc.items()}
    per_und = []
    for u, L in topk.items():
        L.sort(key=lambda p: -p['score'])
        for p in L[:(20 if u in STOCKS else 8)]: p['best_expiry'] = best_exp.get(u) == p['expiry']; per_und.append(p)
    # merge cached picks for underlyings scanned in earlier rotations (<= 3 days old), trimmed to top 5 each
    pc_f = os.path.join(DATA_DIR, 'opt_picks_cache.json')
    try: pc = json.load(open(pc_f))
    except Exception: pc = {}
    for u, L in topk.items():
        if not u.endswith('-USD') and '-' not in u: pc[u] = {'t': time.time(), 'picks': sorted(L, key=lambda p: -p['score'])[:5]}
    cutoff = time.time() - 3 * 86400; fresh_u = set(topk)
    for u, v in list(pc.items()):
        if v['t'] < cutoff: del pc[u]; continue
        if u in fresh_u: continue
        for p in v['picks']: p = dict(p); p['from_cache_age_h'] = round((time.time() - v['t']) / 3600, 1); per_und.append(p)
    json.dump(pc, open(pc_f, 'w'), default=lambda o: None)
    per_und.sort(key=lambda p: -p['score'])
    # per-ticker signals (pre/after-hours, insider Form 4, 8-K, news tone, up/down volume, call/put flow) -> score adjustment
    tick_info = {}
    try:
        import stock_signals as SS
        stock_u = [p['underlying'] for p in per_und if not p['venue'].startswith('Derive')]
        tick = list(dict.fromkeys([x for x in STOCKS if x] + stock_u))[:int(os.environ.get('OPT_SIGNAL_TICKERS', '120'))]
        SIG = SS.collect(tick, log)
        for p in per_und:
            u = p['underlying']
            if u not in SIG: continue
            pts, why = SS.adjust(p, SIG[u], FLOW.get(u))
            if pts or why:
                p['signal_pts'] = pts; p['signals'] = why
                if pts:
                    old_g = p['grade']; p['score'] = round(min(100.0, max(0.0, p['score'] + pts)), 1); ng = grade_of(p['score'])
                    if p.get('caps') and CAP[ng] > CAP[old_g]: ng = old_g  # never lift a capped grade
                    p['grade'] = ng
        for u in tick:
            e = SIG.get(u) or {}; sc = e.get('sec') or {}
            tick_info[u] = {'ext': e.get('ext'), 'updown': e.get('flowvol'), 'flow': FLOW.get(u), 'news': (e.get('news') or [])[:5],
                            'insider': {k: sc.get(k) for k in ('insider_buy_usd_30d', 'insider_sell_usd_30d', 'cluster_buying', 'buyers_30d', 'form4_parsed')} if sc else None,
                            'insider_tx': (sc.get('insider_tx_90d') or [])[:6], 'filings_8k': sc.get('filings_8k_14d') or []}
        per_und.sort(key=lambda p: -p['score'])
    except Exception as e: log('signals failed:', e)
    for k, v in seen_mid.items(): tr.update(k, v)
    for p in per_und:
        if p['grade'] in ('A', 'B') or p.get('best_expiry'):
            tr.log(p['id'], p['grade'], p['score'], p['mid'], f"{p['underlying']} {p['type']} {p['strike']} {p['expiry']}", {k: p.get(k) for k in ('iv', 'rv30', 'iv_rv', 'ev_pct', 'p_touch3x_rv', 'rr_2sigma', 'days', 'venue')})
    tr.save()
    unusual = sorted(unusual_all, key=lambda p: -(p['vol_oi'] or 0))[:60]
    out = {'generatedAt': int(time.time() * 1000), 'elapsed_s': round(time.time() - t0),
           'universe': {'derive_listed': n_derive, 'derive_priced': n_dcon, 'stock_underlyings': ok, 'stock_failed': fail, 'stock_contracts': n_scon, 'analyzed': analyzed[0], 'eligible': n_elig[0], 'rotation': uni_meta, 'underlyings_with_picks': len(set(p['underlying'] for p in per_und))},
           'grades': grades, 'grade_formula': GRADE_DOC, 'rv_sources': rvsrc,
           'picks': per_und, 'unusual': unusual, 'tickers': tick_info,
           'best_expiry': best_exp,
           'notes': ['Stock chains: CBOE delayed quotes (about 15 min, and last-session values outside market hours); volume = latest session.',
                     'Derive: live on-chain order book; many strikes have no resting bid/ask, so the mark price is used and the grade is capped at C.',
                     'Fair value = Black-Scholes with realized vol (mean of 30/90/180-day close-to-close) (stocks: Yahoo daily closes; crypto: Coinbase daily candles; XAUT uses PAXG). Rates 4% stocks, 0% crypto. No dividends.',
                     'Probabilities: lognormal, no drift; touch probability uses the reflection approximation (2x the expiry probability). Real returns have fat tails and jumps (earnings, listings), so these are rough.',
                     'Targets: underlying price at expiry where the option pays 3x/5x/10x the premium; "exit by" keeps 40% of the original time to limit late theta; "need for 3x at exit" = underlying price on that date for a 3x mark at current IV.',
                     'Estimates only, not financial advice. Long options can and usually do expire worthless.']}
    with open(os.path.join(DATA_DIR, 'options.json'), 'w') as f: json.dump(out, f, default=lambda o: None)
    log('done', out['universe'], grades)
    for p in per_und[:12]:
        log(p['grade'], p['score'], p['id'], p['venue'], f"mid {p['mid']:.2f} iv {p['iv']:.2f} rv {p['rv30'] or 0:.2f} EV {p['ev_pct']:.0f}% touch3x {p['p_touch3x_rv']:.2f} R2s {p['rr_2sigma']:.1f}")

if __name__ == '__main__': main()
