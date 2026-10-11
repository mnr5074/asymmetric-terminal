"""Historical PROXY study for the sentiment oscillator: did extreme attention precede reversals?

X mention counts are only available for the last 7 days on the free tools, so this uses attention proxies with long free history:
  * Wikipedia daily pageviews (Wikimedia REST API, user agent set; canonical article + its redirects summed), daily since 2015-07
  * Google Trends weekly interest (pytrends, 5-year window), when reachable
  * GDELT news volume (DOC 2.0 timelinevolraw), when reachable (often throttled: 'one request every 5 seconds')
  * data/narratives_history.json theme snapshots (checked; too short to test)
Prices: Binance public daily klines (data-api.binance.vision). No X API, no Nansen, no paid sources.
Output: data/sentiment_history.json. Run: python3 research/sentiment.py history [--refresh]
This is a PROXY for X attention, not X itself: Wikipedia/Trends readers skew to newcomers and retail, which is the crowd the
contrarian idea is about, but the mapping to X mention velocity is unverified.
"""
import json, math, os, random, time, urllib.request, urllib.parse, datetime as dt
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); DATA = os.path.join(ROOT, 'data')
CACHE = os.path.join(HERE, 'cache'); os.makedirs(CACHE, exist_ok=True)
UA = {'user-agent': 'asymmetric-terminal-research/1.0 (sentiment proxy study; contact: local research box)'}
# (wiki canonical title, binance spot symbol, Google Trends term, group, ambiguous-proxy flag)
UNIVERSE = [
    ('Bitcoin', 'BTCUSDT', 'bitcoin', 'major', False), ('Ethereum', 'ETHUSDT', 'ethereum', 'major', False), ('Solana (blockchain platform)', 'SOLUSDT', 'solana', 'major', False),
    ('Dogecoin', 'DOGEUSDT', 'dogecoin', 'meme', False), ('Shiba Inu (cryptocurrency)', 'SHIBUSDT', 'shiba inu coin', 'meme', False), ('$Trump', 'TRUMPUSDT', 'trump coin', 'meme', False),
    ('Pudgy Penguins', 'PENGUUSDT', 'pudgy penguins', 'meme', True), ('Peanut (squirrel)', 'PNUTUSDT', 'pnut coin', 'meme', True),
    ('Cardano (blockchain platform)', 'ADAUSDT', 'cardano', 'alt', False), ('Zcash', 'ZECUSDT', 'zcash', 'alt', False), ('NEAR (blockchain platform)', 'NEARUSDT', 'near protocol', 'alt', False),
    ('Litecoin', 'LTCUSDT', 'litecoin', 'alt', False), ('XRP Ledger', 'XRPUSDT', 'xrp', 'alt', False), ('Polkadot (blockchain platform)', 'DOTUSDT', 'polkadot', 'alt', False),
    ('Avalanche (blockchain platform)', 'AVAXUSDT', 'avalanche crypto', 'alt', False), ('Chainlink (blockchain oracle)', 'LINKUSDT', 'chainlink', 'alt', False), ('Tron (blockchain)', 'TRXUSDT', 'tron crypto', 'alt', False),
    ('Ethereum Classic', 'ETCUSDT', 'ethereum classic', 'alt', False), ('Filecoin', 'FILUSDT', 'filecoin', 'alt', False), ('Tezos', 'XTZUSDT', 'tezos', 'alt', False), ('Algorand', 'ALGOUSDT', 'algorand', 'alt', False),
    ('Stellar (payment network)', 'XLMUSDT', 'stellar lumens', 'alt', False), ('Uniswap', 'UNIUSDT', 'uniswap', 'alt', False), ('TON (blockchain)', 'TONUSDT', 'toncoin', 'alt', False),
    ('World (blockchain)', 'WLDUSDT', 'worldcoin', 'alt', False), ('Hedera (distributed ledger)', 'HBARUSDT', 'hedera hbar', 'alt', False), ('Axie Infinity', 'AXSUSDT', 'axie infinity', 'alt', False),
    ('Decentraland', 'MANAUSDT', 'decentraland', 'alt', False), ('IOTA (technology)', 'IOTAUSDT', 'iota crypto', 'alt', False), ('Dash (cryptocurrency)', 'DASHUSDT', 'dash crypto', 'alt', False),
    ('Monero', 'XMRUSDT', 'monero', 'alt', False), ('Hamster Kombat', 'HMSTRUSDT', 'hamster kombat', 'alt', True), ('PancakeSwap', 'CAKEUSDT', 'pancakeswap', 'alt', False),
    ('Aave', 'AAVEUSDT', 'aave', 'alt', False), ('Chiliz', 'CHZUSDT', 'chiliz', 'alt', False), ('Bitcoin Cash', 'BCHUSDT', 'bitcoin cash', 'alt', False), ('EOS.IO', 'EOSUSDT', 'eos crypto', 'alt', False),
]

def get(url, timeout=40, raw=False):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r: b = r.read().decode()
    return b if raw else json.loads(b)
def cached(name, fn, refresh=False, max_age_h=20):
    p = os.path.join(CACHE, name)
    if not refresh and os.path.exists(p) and (time.time() - os.path.getmtime(p)) < max_age_h * 3600:
        with open(p) as f: return json.load(f)
    v = fn()
    with open(p, 'w') as f: json.dump(v, f)
    return v
def safe(s): return ''.join(ch if ch.isalnum() else '_' for ch in s)
def day(ms): return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime('%Y-%m-%d')

# ---------------------------------------------------------------- sources
def wiki_views(title, refresh):
    def f():
        q = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'prop': 'redirects', 'rdnamespace': 0, 'rdlimit': 'max', 'titles': title})
        pages = get('https://en.wikipedia.org/w/api.php?' + q)['query']['pages']
        reds = [r['title'] for p in pages.values() for r in p.get('redirects', [])][:40]
        tot = defaultdict(int); used = []
        end = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)).strftime('%Y%m%d')
        for t in [title] + reds:
            u = f"https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/{urllib.parse.quote(t.replace(' ', '_'), safe='')}/daily/20150701/{end}"
            try: items = get(u).get('items', [])
            except Exception: continue
            if items: used.append(t)
            for it in items: tot[it['timestamp'][:4] + '-' + it['timestamp'][4:6] + '-' + it['timestamp'][6:8]] += it['views']
            time.sleep(0.05)
        return {'title': title, 'titles_summed': used, 'daily': dict(sorted(tot.items()))}
    return cached('wiki_' + safe(title) + '.json', f, refresh)
def binance_daily(sym, refresh):
    def f():
        out = []; start = 1500000000000
        while True:
            k = get(f'https://data-api.binance.vision/api/v3/klines?symbol={sym}&interval=1d&limit=1000&startTime={start}')
            if not k: break
            out += [[int(x[0]), float(x[4])] for x in k]
            if len(k) < 1000: break
            start = int(k[-1][0]) + 86400000
        return {'sym': sym, 'daily': {day(t): c for t, c in out}}
    return cached('bn_' + sym + '.json', f, refresh)
def trends_weekly(term, refresh):
    def f():
        from pytrends.request import TrendReq
        p = TrendReq(hl='en-US', tz=0, timeout=(10, 25)); p.build_payload([term], timeframe='today 5-y')
        d = p.interest_over_time()
        if d is None or d.empty: return {'term': term, 'weekly': {}}
        return {'term': term, 'weekly': {i.strftime('%Y-%m-%d'): int(v) for i, v in d[term].items()}}
    return cached('gt_' + safe(term) + '.json', f, refresh, max_age_h=24 * 7)
def gdelt_probe():
    try:
        b = get('https://api.gdeltproject.org/api/v2/doc/doc?query=bitcoin&mode=timelinevolraw&format=json&timespan=1w', raw=True)
        return 'ok' if b.strip().startswith('{') else 'refused: ' + b[:110]
    except Exception as e: return f'error: {e}'

# ---------------------------------------------------------------- stats helpers
def mean(a): return sum(a) / len(a) if a else None
def sdv(a):
    if len(a) < 2: return None
    m = mean(a); return math.sqrt(sum((x - m) ** 2 for x in a) / (len(a) - 1))
def binom_p_one_sided(k, n, p0, greater=True):
    """exact one-sided binomial tail P(X>=k) (greater) or P(X<=k)."""
    if n == 0: return None
    lg = lambda x: math.lgamma(x + 1)
    pmf = lambda i: math.exp(lg(n) - lg(i) - lg(n - i) + (i * math.log(p0) if i else 0) + ((n - i) * math.log(1 - p0) if n - i else 0))
    rng = range(k, n + 1) if greater else range(0, k + 1)
    return min(1.0, sum(pmf(i) for i in rng))
def cohen_h(p1, p2): return 2 * math.asin(math.sqrt(p1)) - 2 * math.asin(math.sqrt(p2))
def r3(x): return None if x is None else round(x, 3)

# ---------------------------------------------------------------- panel construction
def build_daily_panel(wv, px):
    """per-token aligned daily arrays: dates, attention z vs trailing 30d, low-attention flag, closes."""
    dates = sorted(set(wv) & set(px))
    if len(dates) < 400: return None
    a = [math.log1p(wv[d]) for d in dates]; c = [px[d] for d in dates]
    z = [None] * len(dates); low = [False] * len(dates); a7 = [None] * len(dates)
    for i in range(len(dates)):
        if i >= 30:
            w = a[i - 30:i]; s = sdv(w)
            if s and s > 0.05: z[i] = (a[i] - mean(w)) / s
        if i >= 6: a7[i] = mean(a[i - 6:i + 1])
        if i >= 371:
            hist = sorted(x for x in a7[i - 365:i] if x is not None)
            if len(hist) > 300: low[i] = a7[i] <= hist[int(0.05 * len(hist))]
    return {'dates': dates, 'z': z, 'low': low, 'c': c}
def lr(c, i, j): return math.log(c[j] / c[i]) if 0 <= i < len(c) and 0 <= j < len(c) and c[i] > 0 and c[j] > 0 else None
import numpy as np
def arrays(P):
    if '_np' not in P:
        c = np.array(P['c'], float); z = np.array([np.nan if x is None else x for x in P['z']], float)
        P['_np'] = {'c': c, 'lc': np.log(np.where(c > 0, c, np.nan)), 'z': z, 'low': np.array(P['low'], bool)}
    return P['_np']
def prior_ret(P, k):
    A = arrays(P); lc = A['lc']; r = np.full(len(lc), np.nan); r[k:] = lc[k:] - lc[:-k] if k else 0; return r
def fwd_ret(P, h, btc=None):
    A = arrays(P); lc = A['lc']; n = len(lc); r = np.full(n, np.nan)
    if n > h + 1: r[:n - h - 1] = lc[h + 1:] - lc[1:n - h]   # entry close i+1, exit close i+1+h
    if btc is not None:
        bl = np.array([math.log(btc[d]) if d in btc else np.nan for d in P['dates']]); rb = np.full(n, np.nan)
        if n > h + 1: rb[:n - h - 1] = bl[h + 1:] - bl[1:n - h]
        r = r - rb
    return r
def decluster(idx, gap):
    out = []; last = -10 ** 9
    for i in idx:
        if i - last >= gap: out.append(i); last = i
    return out
def run_test(panels, btc, name, att, base, outcome, horizon, prior, decl, rel=False, perms=1000, seed=7):
    """Event study. att(P)->bool array (attention extreme), base(P)->bool array (price context, e.g. +10% week).
    Events = att & base (declustered); base set = every day with the price context. outcome: 'neg' (fwd<0) or 'pos' (fwd>0).
    Entry at close of day i+1 (pageviews for day i publish after day i ends)."""
    ev = []; basev = []; per = {}
    for sym, P in panels.items():
        if rel and sym == 'BTC': continue
        f = fwd_ret(P, horizon, btc if rel else None); bm = base(P) & ~np.isnan(f); am = att(P)
        o = (f < 0) if outcome == 'neg' else (f > 0)
        basev.append(o[bm]); per[sym] = (am, bm, o, f)
        for i in decluster(np.nonzero(am & bm)[0], decl): ev.append((sym, P['dates'][i], float(f[i]), bool(o[i])))
    allb = np.concatenate(basev) if basev else np.array([])
    n = len(ev); nb = int(allb.size)
    if n == 0 or nb == 0: return {'name': name, 'n': n, 'n_base': nb, 'note': 'no events'}
    hits = sum(e[3] for e in ev); p0 = float(allb.mean()); hr = hits / n
    rnd = random.Random(seed); perm_hr = []
    for _ in range(perms):
        h = m = 0
        for sym, (am, bm, o, f) in per.items():
            L = len(am); off = rnd.randint(60, max(61, L - 60)); sh = np.roll(am, -off)
            idx = decluster(np.nonzero(sh & bm)[0], decl); m += len(idx); h += int(o[idx].sum()) if idx else 0
        if m: perm_hr.append(h / m)
    p_perm = (1 + sum(1 for x in perm_hr if x >= hr)) / (1 + len(perm_hr)) if perm_hr else None
    evr = sorted(e[2] for e in ev); fb = np.concatenate([f[bm] for am, bm, o, f in per.values()])
    return {'name': name, 'horizon': horizon, 'relative_to_btc': rel, 'n': n, 'tokens_with_events': len({e[0] for e in ev}), 'hits': int(hits), 'hit_rate': r3(hr), 'n_base': nb, 'base_rate': r3(p0),
            'lift': r3(hr / p0) if p0 else None, 'diff_pp': r3((hr - p0) * 100), 'cohen_h': r3(cohen_h(hr, p0)), 'p_binomial_one_sided': r3(binom_p_one_sided(int(hits), n, p0)),
            'p_permutation': r3(p_perm), 'perm_mean_hit_rate': r3(mean(perm_hr)) if perm_hr else None,
            'mean_fwd_logret_events': r3(mean(evr)), 'mean_fwd_logret_base': r3(float(np.nanmean(fb))), 'median_fwd_logret_events': r3(evr[len(evr) // 2]),
            'events_sample': [{'sym': s_, 'date': d, 'fwd': r3(f_)} for s_, d, f_, _ in sorted(ev, key=lambda x: x[1])[-12:]]}

def main(kv=None):
    kv = kv or {}; refresh = bool(kv.get('refresh')); t0 = time.time()
    cat = json.load(open(os.path.join(DATA, 'crash_catalog.json'))).get('catalog', [])
    catsyms = {str(c.get('symbol', '')).upper() for c in cat}
    cov = {'universe': len(UNIVERSE), 'wiki_ok': [], 'price_ok': [], 'trends_ok': [], 'trends_failed': [], 'skipped': [], 'catalog_tokens_covered': []}
    panels = {}; panels_unamb = {}; panels_alts = {}; btc = None; wk = {}
    for title, sym, term, grp, amb in UNIVERSE:
        try: w = wiki_views(title, refresh)
        except Exception as e: cov['skipped'].append(f'{sym}: wiki {e}'); continue
        try: p = binance_daily(sym, refresh)
        except Exception as e: cov['skipped'].append(f'{sym}: price {e}'); continue
        if sym == 'BTCUSDT': btc = p['daily']
        P = build_daily_panel(w['daily'], p['daily'])
        if not P: cov['skipped'].append(f'{sym}: <400 overlapping days'); continue
        s = sym[:-4]; panels[s] = P; cov['wiki_ok'].append({'sym': s, 'title': title, 'titles_summed': len(w['titles_summed']), 'days': len(P['dates']), 'from': P['dates'][0], 'group': grp, 'ambiguous_proxy': amb})
        if not amb: panels_unamb[s] = P
        if grp != 'major': panels_alts[s] = P
        if s in catsyms: cov['catalog_tokens_covered'].append(s)
        wk[s] = (term, p['daily'])
    # ---------------- daily Wikipedia tests
    HIGH = 3.0; RALLY = math.log(1.10); DROP = math.log(0.90)
    up = lambda P: np.nan_to_num(prior_ret(P, 7), nan=0) > RALLY
    dn = lambda P: np.nan_to_num(prior_ret(P, 7), nan=0) < DROP
    dn30 = lambda P: np.nan_to_num(prior_ret(P, 30), nan=0) < 0
    hi = lambda th: (lambda P: np.nan_to_num(arrays(P)['z'], nan=-9) >= th)
    lowf = lambda P: arrays(P)['low']
    allp = lambda P: np.ones(len(P['dates']), bool)
    tests = []
    T = lambda *a, **k: tests.append(run_test(*a, **k))
    T(panels, btc, 'A1 euphoria top: attention z>=3 after a +10% week -> next 14d return negative', hi(HIGH), up, 'neg', 14, 7, 14)
    T(panels, btc, 'A2 same, 7d horizon', hi(HIGH), up, 'neg', 7, 7, 14)
    T(panels, btc, 'A3 same, 30d horizon', hi(HIGH), up, 'neg', 30, 7, 14)
    T(panels, btc, 'A4 same, 14d, return relative to BTC (non-BTC tokens)', hi(HIGH), up, 'neg', 14, 7, 14, rel=True)
    T(panels, btc, 'A5 threshold z>=2 (sensitivity), 14d', hi(2.0), up, 'neg', 14, 7, 14)
    T(panels, btc, 'A6 threshold z>=4 (sensitivity), 14d', hi(4.0), up, 'neg', 14, 7, 14)
    T(panels_unamb, btc, 'A7 excluding ambiguous proxies (PNUT/PENGU/HMSTR), 14d', hi(HIGH), up, 'neg', 14, 7, 14)
    T(panels_alts, btc, 'A8 alts+memes only (no BTC/ETH/SOL), 14d', hi(HIGH), up, 'neg', 14, 7, 14)
    T(panels, btc, 'B1 panic spike: attention z>=3 after a -10% week -> next 14d return positive', hi(HIGH), dn, 'pos', 14, 7, 14)
    T(panels, btc, 'B2 same, 30d horizon', hi(HIGH), dn, 'pos', 30, 7, 14)
    T(panels, btc, 'C1 silence bottom: 7d attention in bottom 5% of its trailing year, after a down month -> next 30d positive', lowf, dn30, 'pos', 30, 30, 30)
    T(panels, btc, 'C2 same, 60d horizon', lowf, dn30, 'pos', 60, 30, 30)
    T(panels, btc, 'D1 any attention spike z>=3 (no price filter) -> next 14d negative', hi(HIGH), allp, 'neg', 14, 0, 14)
    # ---------------- weekly Google Trends
    gt_tests = []; gt_status = 'not attempted'
    try:
        series = {}
        tb = time.time() + float(kv.get('trends-budget-s') or 240)   # Google Trends 429s a lot from this box: hard time budget, cached terms always used
        for s, (term, px) in wk.items():
            g = None; err = None
            cachedf = os.path.exists(os.path.join(CACHE, 'gt_' + safe(term) + '.json'))
            if not cachedf and time.time() > tb: cov['trends_failed'].append(f'{s}: skipped (time budget)'); continue
            for attempt in range(3):
                try: g = trends_weekly(term, refresh); break
                except Exception as e:
                    err = e
                    if '429' in str(e) and time.time() < tb: time.sleep(30)
                    else: break
            fresh = not os.path.exists(os.path.join(CACHE, 'gt_' + safe(term) + '.json')) or refresh
            if g and g['weekly']: series[s] = (g['weekly'], px); cov['trends_ok'].append(s)
            else: cov['trends_failed'].append(f'{s}: {str(err)[:60]}' if err else s)
            if not cachedf: time.sleep(4)
        gt_status = f"{len(series)} of {len(wk)} tokens fetched (weekly, 5-year window)"
        gp = {}
        for s, (wkly, px) in series.items():
            dates = [d for d in sorted(wkly) if d in px]
            if len(dates) < 80: continue
            v = [math.log1p(wkly[d]) for d in dates]; c = [px[d] for d in dates]; z = [None] * len(dates)
            for i in range(26, len(dates)):
                w = v[i - 26:i]; sd_ = sdv(w)
                if sd_ and sd_ > 0.05: z[i] = (v[i] - mean(w)) / sd_
            gp[s] = {'dates': dates, 'c': c, 'z': z, 'low': [False] * len(dates)}
        up4 = lambda P: np.nan_to_num(prior_ret(P, 4), nan=0) > math.log(1.2)
        if gp:
            gt_tests.append(run_test(gp, None, 'G1 Google Trends weekly z>=3 after a +20% month -> next 4 weeks negative (entry next weekly close)', hi(3.0), up4, 'neg', 4, 4, 8))
            gt_tests.append(run_test(gp, None, 'G2 same, 8-week horizon', hi(3.0), up4, 'neg', 8, 4, 8))
            gt_tests.append(run_test(gp, None, 'G3 threshold z>=2, 4 weeks', hi(2.0), up4, 'neg', 4, 4, 8))
    except Exception as e: gt_status = f'failed: {e}'
    gd = gdelt_probe()
    nh = json.load(open(os.path.join(DATA, 'narratives_history.json'))).get('snaps', []) if os.path.exists(os.path.join(DATA, 'narratives_history.json')) else []
    nh_status = f"{len(nh)} snapshots spanning {round((nh[-1]['t'] - nh[0]['t']) / 3600, 2) if len(nh) > 1 else 0} h, theme-level only: too short to test (needs months of daily snapshots)"
    a1 = next(t for t in tests if t['name'].startswith('A1'))
    def verdict(t):
        if t.get('n', 0) < 20: return 'too few events'
        sig = (t.get('p_permutation') or 1) < 0.05 and (t.get('p_binomial_one_sided') or 1) < 0.05
        return ('supports' if sig and t['diff_pp'] > 0 else 'no reliable edge' if t['diff_pp'] <= 5 or not sig else 'weak')
    for t in tests + gt_tests: t['verdict'] = verdict(t)
    b1 = next(t for t in tests if t['name'].startswith('B1')); c1 = next(t for t in tests if t['name'].startswith('C1'))
    line = (f"Wikipedia-attention proxy, {len(panels)} tokens since 2015-17: euphoric spikes (z>=3 after a +10% week) were followed by a negative 14d return "
            f"{round(a1['hit_rate'] * 100)}% of the time vs {round(a1['base_rate'] * 100)}% for all +10% weeks (n={a1['n']}, perm p={a1['p_permutation']}, {a1['verdict']}); "
            f"panic spikes after a -10% week rebounded {round(b1['hit_rate'] * 100)}% vs {round(b1['base_rate'] * 100)}% (n={b1['n']}, perm p={b1['p_permutation']}, {b1['verdict']}); "
            f"year-low attention after a down month rose over 30d {round(c1['hit_rate'] * 100)}% vs {round(c1['base_rate'] * 100)}% (n={c1['n']}, perm p={c1['p_permutation']}, {c1['verdict']}).") if a1.get('n') and b1.get('n') and c1.get('n') else 'insufficient events'
    out = {'generatedAt': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'elapsed_s': round(time.time() - t0),
           'proxy': 'PROXY history: Wikipedia daily pageviews (all redirects summed) and Google Trends weekly interest stand in for X mention velocity, which the free tools only expose for 7 days. Prices: Binance spot daily closes.',
           'method': {'attention_z': 'log(1+views) vs trailing 30-day mean/sd (daily); Trends: log(1+index) vs trailing 26 weeks', 'entry': 'close of the day AFTER the attention day (no look-ahead: pageviews publish after the day ends)',
                      'declustering': 'at most one event per token per 14 days (30 for C, 8 weeks for G)', 'base_rate': 'all token-days with the same price context (e.g. every +10% week), regardless of attention',
                      'p_values': 'exact one-sided binomial vs base rate (assumes independent events) and a circular-shift permutation test (each token\'s attention series rotated vs its prices by a random >=60-day offset, 1000 draws), which keeps autocorrelation and market regimes',
                      'effect_sizes': 'hit-rate difference in percentage points, lift, Cohen\'s h, mean forward log return events vs base'},
           'coverage': {**cov, 'gdelt': gd, 'google_trends': gt_status, 'narratives_history': nh_status}, 'tests': tests, 'trends_tests': gt_tests, 'summary_line': line,
           'caveats': ['Proxy, not X: Wikipedia/Google audiences differ from crypto X; spikes there are later and more retail than X chatter.', 'Overlapping horizons and cross-token correlation (crypto moves together) make the binomial p optimistic; trust the permutation p more.',
                       'Survivorship: tokens still listed on Binance with Wikipedia pages are the survivors (dead coins are under-represented), which biases rebound tests upward for both events and base.',
                       'Several thresholds and horizons were tried (listed as sensitivity rows); treat any single p < 0.05 with caution (multiple comparisons).',
                       'Ambiguous proxies (PNUT = the squirrel article, PENGU = the NFT collection, HMSTR = the game) are flagged and excluded in A7.']}
    for P in list(panels.values()): P.pop('_np', None)
    with open(os.path.join(DATA, 'sentiment_history.json'), 'w') as f: json.dump(out, f, separators=(',', ':'))
    print(line)
    for t in tests + gt_tests: print(f"{t['name'][:70]:70} n={t.get('n')} hit={t.get('hit_rate')} base={t.get('base_rate')} diff={t.get('diff_pp')}pp h={t.get('cohen_h')} pb={t.get('p_binomial_one_sided')} pp={t.get('p_permutation')} {t.get('verdict')}")
    print(json.dumps({k: (v if not isinstance(v, list) else len(v)) for k, v in out['coverage'].items()}))

if __name__ == '__main__': main({'refresh': False})
