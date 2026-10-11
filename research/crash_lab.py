#!/usr/bin/env python3
"""Crash catalog + INVERSE (pre-crash) lookalike detector.
Free sources only: CoinGecko public (markets by launchpad/meme category, 365-day daily history), Binance public data archive
(data.binance.vision daily klines, incl. delisted pairs like LUNA/FTT), DexScreener, RugCheck, GoPlus, our research DB, web research.
HARD RULE: zero calls to Nansen or X (enforced in get(): those hosts raise; per-host counter written to the output).
Output: data/crash_catalog.json (catalog, fingerprints, backtest, skipped), data/crash_fingerprints.json (for lib/crashmatch.js)."""
import io, json, math, os, sqlite3, statistics, time, urllib.request, zipfile, datetime as dt
from common import DATA_DIR
COUNTS = {}; BLOCKED = ('nansen.ai', 'api.x.com', 'twitter.com', 'api.twitter.com', 'x.com')
_last = {}
def get(url, raw=False, gap=0.0, timeout=40):
    host = url.split('/')[2]
    if any(host == b or host.endswith('.' + b) for b in BLOCKED): raise RuntimeError('metered API blocked in crash catalog: ' + host)
    COUNTS[host] = COUNTS.get(host, 0) + 1
    w = _last.get(host, 0) + gap - time.time()
    if w > 0: time.sleep(w)
    _last[host] = time.time()
    for k in range(3):
        try:
            b = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 asymmetric-terminal research', 'Accept': 'application/json'}), timeout=timeout).read()
            return b if raw else json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code == 429 and k < 2: time.sleep(30); continue
            raise
cg = lambda p: get('https://api.coingecko.com/api/v3' + p, gap=6.5)
log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
D = lambda ts: dt.datetime.fromtimestamp(ts / 1000 if ts > 1e11 else ts, dt.timezone.utc).strftime('%Y-%m-%d')

# ---------- daily series ----------
def binance_series(sym, start, end, market='spot'):
    """Monthly daily-kline zips from data.binance.vision (keyless). market: spot | um (USD-M futures)."""
    cf = os.path.join(DATA_DIR, 'crash_series', f'{sym}-{market}.json')
    try: return tuple(json.load(open(cf)))
    except Exception: pass
    base = 'https://data.binance.vision/data/' + ('spot' if market == 'spot' else 'futures/um') + f'/monthly/klines/{sym}/1d/'
    y, m = start; rows = []
    while (y, m) <= end:
        try:
            z = zipfile.ZipFile(io.BytesIO(get(f'{base}{sym}-1d-{y}-{m:02d}.zip', raw=True)))
            for line in z.read(z.namelist()[0]).decode().splitlines():
                p = line.split(',')
                if not p[0].isdigit(): continue
                t = int(p[0]); t = t // 1000 if t > 1e14 else t  # some files use microseconds
                rows.append((t // 1000, float(p[4]), float(p[7])))   # open time (s), close, quote volume (USD)
        except Exception: pass
        m += 1
        if m > 12: y, m = y + 1, 1
    rows.sort(); out = {}
    for t, c, v in rows: out[D(t)] = (c, v)
    ds = sorted(out); r = (ds, [out[d][0] for d in ds], [out[d][1] for d in ds])
    if ds: os.makedirs(os.path.dirname(cf), exist_ok=True); json.dump(r, open(cf, 'w'))
    return r
def cg_series(cid):
    f = os.path.join(DATA_DIR, 'cg_series', cid + '.json')
    try:
        if time.time() - os.path.getmtime(f) > 3 * 86400: raise FileNotFoundError
        d = json.load(open(f))
    except Exception:
        d = cg(f'/coins/{cid}/market_chart?vs_currency=usd&days=365&interval=daily'); os.makedirs(os.path.dirname(f), exist_ok=True); json.dump(d, open(f, 'w'))
    pr = {D(t / 1000): p for t, p in d['prices']}; vo = {D(t / 1000): v for t, v in d['total_volumes']}
    ds = sorted(pr); return ds, [pr[x] for x in ds], [vo.get(x, 0) for x in ds]

# ---------- features (daily close + USD volume only, so every era/source is comparable) ----------
FEATS = ['run90', 'run30', 'dd_hi30', 'vol30', 'vol_trend', 'up30', 'ath_gap']
def feats(px, vol, i):
    if i < 90 or px[i] <= 0: return None
    P = px[i - 90:i + 1]; lr = [math.log(P[k] / P[k - 1]) for k in range(len(P) - 60, len(P)) if P[k] > 0 and P[k - 1] > 0]
    if len(lr) < 20: return None
    v7 = statistics.mean(vol[i - 6:i + 1]); v30 = statistics.mean(vol[i - 37:i - 6]) or 1e-9
    return {'run90': math.log(px[i] / max(min(P), 1e-12)), 'run30': math.log(px[i] / max(min(px[i - 30:i + 1]), 1e-12)), 'dd_hi30': px[i] / max(px[i - 30:i + 1]) - 1,
            'vol30': statistics.pstdev(lr[-30:]), 'vol_trend': math.log(max(v7, 1e-9) / v30), 'up30': sum(1 for x in lr[-30:] if x > 0) / 30, 'ath_gap': px[i] / max(px[:i + 1]) - 1}
def collapse_idx(px, start=120):
    """First day that closes <= 30% of the max of the previous 120 days, after a run (that max >= 2x the low of the 180 days before it;
    2x not 3x because exchange listings often start after the early run)."""
    for i in range(start, len(px)):
        hi = max(px[i - 120:i]); j = px.index(hi, i - 120, i)
        if px[i] <= 0.3 * hi and hi >= 2 * min(px[max(0, j - 180):j + 1]): return i
    return None

# ---------- catalog ----------
BINANCE = [  # (symbol, market, first month, last month, label, launchpad/type)
    ('LUNAUSDT', 'spot', (2021, 6), (2022, 5), 'LUNA (Terra)', 'large-cap collapse'), ('USTUSDT', 'spot', (2021, 11), (2022, 5), 'UST (Terra stablecoin)', 'stablecoin depeg'),
    ('FTTUSDT', 'spot', (2022, 1), (2022, 12), 'FTT (FTX)', 'large-cap collapse'), ('SRMUSDT', 'spot', (2022, 1), (2022, 12), 'SRM (Serum)', 'large-cap collapse'),
    ('CELUSDT', 'spot', (2021, 11), (2022, 7), 'CEL (Celsius)', 'large-cap collapse'), ('OMUSDT', 'spot', (2024, 9), (2025, 5), 'OM (MANTRA)', 'large-cap collapse'),
    ('GOATUSDT', 'um', (2024, 10), (2025, 4), 'GOAT', 'pump.fun'), ('GRIFFAINUSDT', 'um', (2024, 12), (2025, 4), 'GRIFFAIN', 'pump.fun'),
    ('AI16ZUSDT', 'um', (2024, 11), (2025, 5), 'ai16z', 'daos.fun'), ('ACTUSDT', 'spot', (2024, 11), (2025, 5), 'ACT (AI Prophecy)', 'pump.fun'),
    ('PNUTUSDT', 'spot', (2024, 11), (2025, 5), 'PNUT', 'pump.fun'), ('MOODENGUSDT', 'um', (2024, 9), (2025, 5), 'MOODENG', 'pump.fun'),
    ('CHILLGUYUSDT', 'um', (2024, 11), (2025, 5), 'CHILLGUY', 'pump.fun'), ('ZEREBROUSDT', 'um', (2024, 11), (2025, 5), 'ZEREBRO', 'pump.fun'),
    ('SWARMSUSDT', 'um', (2024, 12), (2025, 5), 'SWARMS', 'pump.fun'), ('TRUMPUSDT', 'spot', (2025, 1), (2025, 6), 'TRUMP (official)', 'Solana celebrity launch'),
    ('MELANIAUSDT', 'um', (2025, 1), (2025, 6), 'MELANIA', 'Meteora celebrity launch'), ('BOMEUSDT', 'spot', (2024, 3), (2025, 4), 'BOME', 'Solana presale meme'),
    ('AIXBTUSDT', 'um', (2024, 11), (2025, 5), 'AIXBT', 'Virtuals (Base)'), ('VINEUSDT', 'um', (2025, 1), (2025, 6), 'VINE', 'pump.fun'),
    ('FARTCOINUSDT', 'um', (2024, 11), (2025, 4), 'FARTCOIN', 'pump.fun'), ('MEWUSDT', 'spot', (2024, 3), (2025, 4), 'MEW', 'Solana meme'),
    ('POPCATUSDT', 'um', (2024, 4), (2025, 4), 'POPCAT', 'Solana meme'), ('WIFUSDT', 'spot', (2024, 3), (2025, 4), 'WIF', 'Solana meme'),
    ('BTCUSDT', 'spot', (2021, 6), (2022, 12), 'control: BTC 2021-22', 'control'), ('SOLUSDT', 'spot', (2021, 6), (2022, 12), 'control: SOL 2021-22', 'control'),
]
CATS = ['pump-fun', 'letsbonk-fun-ecosystem', 'believe-app-ecosystem', 'moonshot-ecosystem', 'four-meme-ecosystem', 'zora-ecosystem', 'clanker-ecosystem',
        'virtuals-protocol-ecosystem', 'base-meme-coins', 'solana-meme-coins', 'ai-agents', 'meme-token']
WEB = [  # metrics found by web research where no free daily history exists (older than CoinGecko/GeckoTerminal free windows)
    {'name': 'Department of Gov Efficiency (DOGE, Solana)', 'symbol': 'DOGE', 'chain': 'solana', 'address': '9TY6DUg1VSssYH5tFE95qoq5hnAGFak4w3cn72sJNCoV', 'pool': '3pvmL7M24uqzudAxUYmvixtkWTC5yaDhTUSyB8cewnJK',
     'launchpad': 'Raydium (Solana)', 'first_trade': '2024-10-29', 'ath_price': 8.55, 'ath_date': '2024-11-13', 'supply': 9.9e6,
     'sources': ['messari.io/project/department-of-gov-efficiency (ATH $8.55 on 2024-11-13, first trade 2024-10-29 on Raydium)', 'phantom.com token page (ATH $4.48 shown, 34,768 holders, top-10 51.97%)',
                 'geckoterminal pool page (78.71% of tokens bought via bundled buys, LP 99.87% locked)'],
     'note': 'Daily history before the last 180 days needs a paid GeckoTerminal/CoinGecko plan; peak mcap = ATH x 9.9M supply. Sources disagree on the ATH ($8.55 Messari vs $4.48 Phantom).'},
]

def main():
    t0 = time.time(); skipped = []; catalog = []
    # A) launchpad / meme categories (CoinGecko markets: ath, ath date, atl, supply)
    seen = {}
    for cat in CATS:
        for page in (1, 2) if cat in ('meme-token', 'solana-meme-coins') else (1,):
            try: rows = cg(f'/coins/markets?vs_currency=usd&category={cat}&order=market_cap_desc&per_page=250&page={page}')
            except Exception as e: skipped.append(f'CoinGecko category {cat} p{page}: {str(e)[:60]}'); continue
            for r in rows:
                e = seen.setdefault(r['id'], {'id': r['id'], 'symbol': (r['symbol'] or '').upper(), 'name': r['name'], 'categories': set(), 'm': r}); e['categories'].add(cat)
    for cid, e in seen.items():
        r = e['m']; ath, px, circ = r.get('ath'), r.get('current_price'), r.get('circulating_supply') or r.get('total_supply')
        if not ath or not px or not circ: continue
        depth = px / ath - 1; peak_mc = ath * circ
        if depth <= -0.8 and peak_mc >= 20e6:
            lp = next((c for c in ['pump-fun', 'letsbonk-fun-ecosystem', 'believe-app-ecosystem', 'moonshot-ecosystem', 'four-meme-ecosystem', 'zora-ecosystem', 'clanker-ecosystem', 'virtuals-protocol-ecosystem'] if c in e['categories']), sorted(e['categories'])[0])
            catalog.append({'id': cid, 'symbol': e['symbol'], 'name': e['name'], 'launchpad': lp, 'categories': sorted(e['categories']), 'source': 'coingecko markets',
                            'ath': ath, 'ath_date': (r.get('ath_date') or '')[:10], 'price_now': px, 'crash_depth_pct': depth * 100, 'peak_mcap_est': peak_mc, 'mcap_now': r.get('market_cap'),
                            'atl': r.get('atl'), 'atl_date': (r.get('atl_date') or '')[:10], 'artifact_risk': bool(r.get('atl') and ath / r['atl'] > 1000), 'run_multiple_ath_over_atl': (ath / r['atl']) if r.get('atl') and (r.get('atl_date') or '') < (r.get('ath_date') or '') else None})
    log('coingecko categories', len(seen), 'coins scanned ->', len(catalog), 'parabolic-then-crash (>= -80% from ATH, est. peak mcap >= $20M)')
    # B) research DB: launchpad memecoins that ran >= 10x then lost >= 80%, and those that died
    try:
        con = sqlite3.connect(os.path.join(DATA_DIR, 'moonshot.db')); con.row_factory = sqlite3.Row
        for t in con.execute("select * from tokens where peak_mcap is not null and ((multiple >= 10 and cur_vs_peak <= 0.2) or cohort='died') and coalesce(quality,'') != 'suspect_fake'"):
            catalog.append({'id': 'db:' + t['mint'], 'symbol': t['symbol'], 'name': t['name'], 'chain': t['chain'] or 'solana', 'address': t['mint'], 'launchpad': t['launchpad'], 'source': 'research DB',
                            'launch_mcap': t['launch_mcap'], 'peak_mcap_est': t['peak_mcap'], 'peak_date': D(t['peak_ts']) if t['peak_ts'] else None, 'created': D(t['created_ts']) if t['created_ts'] else None,
                            'run_multiple': t['multiple'], 'crash_depth_pct': ((t['cur_vs_peak'] or 0) - 1) * 100 if t['cur_vs_peak'] is not None else None, 'time_to_peak_h': t['time_to_peak_h'],
                            'top10_now': t['top10_now'], 'insider_pct_now': t['insider_pct_now'], 'dev_prior_tokens': t['dev_prior_tokens'], 'cohort': t['cohort']})
    except Exception as e: skipped.append('research DB: ' + str(e)[:80])
    # C) web-researched entries
    for w in WEB:
        x = dict(w); x['id'] = 'web:' + w['symbol']; x['source'] = 'web research'; x['peak_mcap_est'] = w['ath_price'] * w['supply']
        try:
            ps = get(f"https://api.dexscreener.com/token-pairs/v1/{w['chain']}/{w['address']}") or []
            p = max(ps, key=lambda q: (q.get('liquidity') or {}).get('usd') or 0)
            x['price_now'] = float(p['priceUsd']); x['mcap_now'] = p.get('marketCap'); x['liq_now'] = (p.get('liquidity') or {}).get('usd'); x['crash_depth_pct'] = (x['price_now'] / w['ath_price'] - 1) * 100
        except Exception as e: skipped.append(f"DexScreener {w['symbol']}: {str(e)[:60]}")
        catalog.append(x)
    skipped.append('Daily price history for Solana DOGE (Oct 2024-Jan 2025) and other launchpad tokens older than 180/365 days: needs paid GeckoTerminal/CoinGecko/Birdeye plans; kept as metrics-only entries.')
    # D) series: Binance archive (curated) + CoinGecko 365d for catalog items whose ATH is inside the free window
    series = {}
    for sym, mk, a, b, label, lp in BINANCE:
        ds, px, vol = binance_series(sym, a, b, mk)
        if len(px) < 120: skipped.append(f'Binance archive {sym}: only {len(px)} days'); continue
        series[label] = {'ds': ds, 'px': px, 'vol': vol, 'launchpad': lp, 'source': 'binance archive ' + mk}
    cutoff = (dt.date.today() - dt.timedelta(days=300)).isoformat()
    recent = sorted([c for c in catalog if c['source'] == 'coingecko markets' and c['ath_date'] >= cutoff], key=lambda c: -c['peak_mcap_est'])[:45]
    for c in recent + [{'id': 'lab', 'symbol': 'LAB', 'launchpad': 'BSC'}, {'id': 'velvet', 'symbol': 'VELVET', 'launchpad': 'BSC/Base'}]:
        if any(s.get('cid') == c['id'] for s in series.values()): continue
        try: ds, px, vol = cg_series(c['id']); series[f"{c['symbol']} ({c['id']})"] = {'ds': ds, 'px': px, 'vol': vol, 'launchpad': c.get('launchpad'), 'source': 'coingecko 365d', 'cid': c['id']}
        except Exception as e: skipped.append(f"CoinGecko history {c['id']}: {str(e)[:60]}")
    # controls: cached non-crash series from the sleeper screen (if present)
    sd = os.path.join(DATA_DIR, 'cg_series')
    for fn in sorted(os.listdir(sd)) if os.path.isdir(sd) else []:
        cid = fn[:-5]
        if any(s.get('cid') == cid for s in series.values()): continue
        try: d = json.load(open(os.path.join(sd, fn))); pr = {D(t / 1000): p for t, p in d['prices']}; vo = {D(t / 1000): v for t, v in d['total_volumes']}; ds = sorted(pr)
        except Exception: continue
        series[f'{cid} (cached)'] = {'ds': ds, 'px': [pr[x] for x in ds], 'vol': [vo.get(x, 0) for x in ds], 'launchpad': 'control/other', 'source': 'coingecko 365d (cached)', 'cid': cid}
    log('series', len(series))
    # E) collapses + fingerprints (features averaged 90..30 days before the collapse; falls back to 60..7 for fast memecoin runs)
    fps = []
    for name, s in series.items():
        px, vol, ds = s['px'], s['vol'], s['ds']; ci = collapse_idx(px)
        s['collapse'] = ci
        if ci is None: continue
        pi = px.index(max(px[max(0, ci - 120):ci]), max(0, ci - 120), ci)
        lo_i = px.index(min(px[max(0, pi - 180):pi + 1]), max(0, pi - 180), pi + 1)
        s['anatomy'] = {'run_low': px[lo_i], 'run_low_date': ds[lo_i], 'peak': px[pi], 'peak_date': ds[pi], 'run_multiple': px[pi] / px[lo_i], 'run_days': pi - lo_i, 'collapse_date': ds[ci], 'collapse_price': px[ci],
                        'days_peak_to_collapse': ci - pi, 'min_after': min(px[ci:]), 'depth_from_peak_pct': (min(px[ci:]) / px[pi] - 1) * 100,
                        'volume_at_peak_vs_30d_before': (statistics.mean(vol[pi - 3:pi + 1]) / (statistics.mean(vol[max(0, pi - 33):pi - 3]) or 1e-9)) if pi > 35 else None}
        for lo, hi in ((90, 30), (60, 7)):
            vs = [feats(px, vol, j) for j in range(max(90, ci - lo), ci - hi + 1, 3)]; vs = [v for v in vs if v]
            if len(vs) >= 3: break
        if len(vs) < 3: skipped.append(f'fingerprint {name}: not enough pre-collapse history'); continue
        fps.append({'name': name, 'launchpad': s['launchpad'], 'collapse_date': ds[ci], 'peak_date': ds[pi], 'fp': {k: statistics.mean(v[k] for v in vs) for k in FEATS}})
    allv = [f['fp'] for f in fps]; SD = {k: (statistics.pstdev([v[k] for v in allv]) or 1) for k in FEATS} if len(allv) > 1 else {k: 1 for k in FEATS}
    sim = lambda a, b: math.exp(-math.sqrt(sum(((a[k] - b[k]) / SD[k]) ** 2 for k in FEATS) / len(FEATS))) * 100
    log('fingerprints', len(fps))
    # F) backtest. Two scores, both leave-one-token-out, every 3rd day; outcome = close falls >= 70% below that day's close within 90 days.
    #  (1) fingerprint similarity to other tokens' pre-crash averages ("looks X% like LUNA");
    #  (2) kNN crash odds: share of the 25 most similar labelled days from OTHER tokens that were followed by a -70% crash.
    TH = (50, 60, 70, 80); samp = []
    for name, s in series.items():
        px, vol, ds = s['px'], s['vol'], s['ds']
        for i in range(90, len(px) - 1, 3):
            f = feats(px, vol, i)
            if not f: continue
            fut = px[i + 1:i + 91]; hit = bool(fut) and min(fut) <= 0.3 * px[i]
            if len(fut) >= 60 or hit: samp.append((name, i, ds[i], px[i], f, hit))
    vecs = [[x[4][k] / SD[k] for k in FEATS] for x in samp]
    def knn(qv, qname, k=25):
        dd = sorted(((sum((a - b) ** 2 for a, b in zip(qv, v)), samp[j][5]) for j, v in enumerate(vecs) if samp[j][0] != qname))[:k]
        return sum(h for _, h in dd) / len(dd) if dd else None
    base = sum(x[5] for x in samp) / len(samp) if samp else None
    rows = []
    for j, (name, i, d, p, f, hit) in enumerate(samp):
        others = [o for o in fps if o['name'] != name]
        b = max(others, key=lambda o: sim(f, o['fp'])) if others else None
        rows.append({'name': name, 'i': i, 'date': d, 'price': p, 'hit': hit, 'sim': sim(f, b['fp']) if b else 0, 'like': b['name'] if b else None, 'knn': knn(vecs[j], name), 'f': f, 'bfp': b['fp'] if b else None})
    def band(sel):
        n = len(sel); return {'n': n, 'tokens': len({r['name'] for r in sel}), 'hit_rate': (sum(r['hit'] for r in sel) / n) if n else None}
    backtest = {'samples': len(samp), 'tokens': len(series), 'base_rate_crash70_within90d': base, 'fingerprints': len(fps),
                'similarity': {f'ge{t}': band([r for r in rows if r['sim'] >= t]) for t in TH},
                'knn': {f'ge{int(t*100)}': band([r for r in rows if r['knn'] is not None and r['knn'] >= t]) for t in (0.2, 0.3, 0.4, 0.5)},
                'definition': 'Outcome: close falls >= 70% below that day\'s close within the next 90 days. Leave-one-token-out (a token is never matched to itself). Every 3rd day of every series.'}
    for grp in ('similarity', 'knn'):
        for k, b in backtest[grp].items(): b['lift'] = (b['hit_rate'] / base) if b['hit_rate'] is not None and base else None
    # LAB replay: first date each score crossed its flag threshold
    lab = None; ls = series.get('LAB (lab)')
    if ls:
        an = ls.get('anatomy') or {}; lr = [r for r in rows if r['name'] == 'LAB (lab)']
        def ff(sel):
            if not sel: return None
            r = sel[0]; o = {'date': r['date'], 'price': r['price'], 'similarity': round(r['sim'], 1), 'like': r['like'], 'knn_crash_odds': r['knn'], 'outcome_hit': r['hit'],
                             'compare': {k: {'now': round(r['f'][k], 3), 'them': round(r['bfp'][k], 3)} for k in FEATS} if r['bfp'] else None}
            if an.get('peak_date'):
                o['days_before_peak'] = (dt.date.fromisoformat(an['peak_date']) - dt.date.fromisoformat(r['date'])).days; o['days_before_collapse'] = (dt.date.fromisoformat(an['collapse_date']) - dt.date.fromisoformat(r['date'])).days
                o['price_vs_peak_pct'] = (r['price'] / an['peak'] - 1) * 100
            return o
        lab = {'series_days': len(ls['px']), 'anatomy': an, 'labelled_days': len(lr), 'crash_days_in_lab': sum(r['hit'] for r in lr),
               'first_similarity_ge70': ff([r for r in lr if r['sim'] >= 70]), 'first_similarity_ge80': ff([r for r in lr if r['sim'] >= 80]),
               'first_knn_ge30': ff([r for r in lr if (r['knn'] or 0) >= 0.3]), 'first_knn_ge50': ff([r for r in lr if (r['knn'] or 0) >= 0.5]),
               'knn_hit_rate_on_lab_flags': band([r for r in lr if (r['knn'] or 0) >= 0.3]), 'timeline': [{'date': r['date'], 'price': r['price'], 'sim': round(r['sim']), 'knn': r['knn'], 'hit': r['hit']} for r in lr[::3]]}
    backtest['LAB'] = lab
    # the live matcher needs the labelled samples for kNN odds (compact)
    knn_samples = [{'n': x[0], 'v': [round(a, 4) for a in v], 'h': int(x[5])} for x, v in zip(samp, vecs)]
    json.dump([{'n': x[0], 'd': x[2], 'v': [round(a, 4) for a in v], 'h': int(x[5])} for x, v in zip(samp, vecs)], open(os.path.join(DATA_DIR, 'crash_samples.json'), 'w'))
    # G) dump anatomy (free, CURRENT state only) for Solana / EVM catalog entries with an address
    anat = 0
    for c in catalog:
        if anat >= 40 or not c.get('address'): continue
        try:
            if c.get('chain', 'solana') == 'solana':
                r = get(f"https://api.rugcheck.xyz/v1/tokens/{c['address']}/report", gap=1.0)
                th = r.get('topHolders') or []
                c['anatomy_now'] = {'source': 'RugCheck', 'top10_pct': sum(h.get('pct') or 0 for h in th[:10]), 'insiders_detected': bool(r.get('graphInsidersDetected')), 'creator_balance': r.get('creatorBalance'), 'risks': [x.get('name') for x in (r.get('risks') or [])][:6], 'lp_locked_pct': (r.get('markets') or [{}])[0].get('lp', {}).get('lpLockedPct') if r.get('markets') else None}
            anat += 1
        except Exception as e: skipped.append(f"RugCheck {c.get('symbol')}: {str(e)[:50]}")
    skipped.append('On-chain dump anatomy AT crash time (which wallets sold, when, to where) needs historical transfer indexing: Helius/Birdeye/Bitquery/Dune (keyed or paid) or Nansen (excluded by rule). Only current holder concentration (RugCheck/GoPlus) is recorded.')
    # series-based anatomy for named cases
    named = [{'name': n, 'launchpad': s['launchpad'], 'source': s['source'], **s['anatomy']} for n, s in series.items() if s.get('anatomy')]
    billing = {'nansen_calls': sum(v for h, v in COUNTS.items() if 'nansen' in h), 'x_calls': sum(v for h, v in COUNTS.items() if h in ('api.x.com', 'x.com', 'twitter.com', 'api.twitter.com')), 'hosts': COUNTS,
               'guard': 'get() raises before any request to nansen.ai / x.com / twitter.com; job launched with NANSEN_API_KEY and X_BEARER_TOKEN removed from its environment'}
    out = {'generatedAt': int(time.time() * 1000), 'elapsed_s': round(time.time() - t0), 'catalog_size': len(catalog) + len([n for n in named if not any(n['name'].lower().startswith(c['symbol'].lower() + ' ') for c in catalog)]),
           'catalog': catalog, 'series_cases': named, 'fingerprints': fps, 'feature_sd': SD, 'backtest': backtest, 'skipped': skipped, 'billing': billing}
    json.dump(out, open(os.path.join(DATA_DIR, 'crash_catalog.json'), 'w'), default=lambda o: sorted(o) if isinstance(o, set) else None)
    json.dump({'features': FEATS, 'sd': SD, 'fingerprints': fps, 'knn': knn_samples, 'backtest': {k: v for k, v in backtest.items() if k != 'LAB'}}, open(os.path.join(DATA_DIR, 'crash_fingerprints.json'), 'w'))
    log('catalog', len(catalog), 'series cases', len(named), 'fingerprints', len(fps)); log(json.dumps({k: v for k, v in backtest.items() if k != 'LAB'})); log('LAB', json.dumps({k: v for k, v in (lab or {}).items() if k != 'timeline'})[:3000]); log('billing', json.dumps(billing))
if __name__ == '__main__': main()
