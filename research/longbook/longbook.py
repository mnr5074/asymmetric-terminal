#!/usr/bin/env python3
"""Long Book builder: long-term (quantum-resistance + real buyback) candidates.

Free sources only, all cached in research/longbook/cache/ (gitignored):
  CoinGecko /coins/{id} (market data + tickers), DefiLlama /summary/fees (fees,
  revenue, holders revenue), Hyperliquid candleSnapshot (HYPE spot daily), and the
  Binance daily closes already in data/flatbase_series/.
Claims come from candidates.json (hand-curated, primary-source links).
Output: data/longbook.json (served by /api/longbook, frozen for Render).

Backtest: "accumulate in a deep, quiet drawdown" vs fixed weekly DCA vs lump sum.
Rule grid chosen on TRAIN (entries before 2023-01-01) and reported on TEST
(entries from 2023-01-01). Weekly entries overlap, so effective n ~ number of
independent episodes, which is reported alongside the raw count.
Usage: python3 research/longbook/longbook.py [--refresh] [--no-net]
"""
import json, math, os, statistics as st, sys, time, urllib.request, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
DATA = os.path.join(ROOT, 'data')
CACHE = os.path.join(HERE, 'cache')
SERIES = os.path.join(DATA, 'flatbase_series')
os.makedirs(CACHE, exist_ok=True)
REFRESH = '--refresh' in sys.argv
NONET = '--no-net' in sys.argv
UA = {'User-Agent': 'asymmetric-terminal-longbook/1.0', 'accept': 'application/json'}
TRAIN_END = dt.date(2023, 1, 1).toordinal() - dt.date(1970, 1, 1).toordinal()  # day index
EPOCH = dt.date(1970, 1, 1)


def day_str(d):
    return (EPOCH + dt.timedelta(days=int(d))).isoformat()


def cached(name, url, ttl_h=6, post=None):
    p = os.path.join(CACHE, name)
    if os.path.exists(p) and (NONET or (not REFRESH and time.time() - os.path.getmtime(p) < ttl_h * 3600)):
        with open(p) as f:
            return json.load(f), os.path.getmtime(p)
    if NONET:
        return None, None
    data = json.dumps(post).encode() if post is not None else None
    hdr = dict(UA)
    if post is not None:
        hdr['content-type'] = 'application/json'
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers=hdr)
            with urllib.request.urlopen(req, timeout=40) as r:
                js = json.load(r)
            with open(p, 'w') as f:
                json.dump(js, f)
            return js, time.time()
        except Exception as e:  # rate limits on the free CoinGecko tier
            sys.stderr.write(f'fetch fail {name} ({e}); retry\n')
            time.sleep(20 * (attempt + 1))
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f), os.path.getmtime(p)
    return None, None


# ---------------- sources ----------------
def coingecko(cid):
    url = (f'https://api.coingecko.com/api/v3/coins/{cid}?localization=false&tickers=true'
           '&market_data=true&community_data=false&developer_data=false&sparkline=false')
    p = os.path.join(CACHE, f'cg_{cid}.json')
    fresh = os.path.exists(p) and time.time() - os.path.getmtime(p) < 6 * 3600
    js, ts = cached(f'cg_{cid}.json', url)
    if not fresh and not NONET:
        time.sleep(7)  # free tier ~10/min
    return js, ts


def llama_sum(slug, dtype):
    js, ts = cached(f'llama_{slug}_{dtype}.json',
                    f'https://api.llama.fi/summary/fees/{slug}?dataType={dtype}')
    if not js or not js.get('totalDataChart'):
        return None, ts
    ch = js['totalDataChart']
    last = ch[-1][0]
    out = {'asOf': day_str(last // 86400)}
    for k, n in (('d30', 30), ('d90', 90), ('y1', 365)):
        out[k] = round(sum(v for t, v in ch if t > last - n * 86400))
    # monthly average over the year, for thesis-break checks
    out['monthlyAvg1y'] = round(out['y1'] / 12)
    return out, ts


def llama_chain(chain):
    js, ts = cached(f'llama_chain_{chain}.json', f'https://api.llama.fi/summary/fees/{chain}?dataType=dailyFees')
    if not js or not js.get('totalDataChart'):
        return None, ts
    ch = js['totalDataChart']
    last = ch[-1][0]
    return {'asOf': day_str(last // 86400), 'd30': round(sum(v for t, v in ch if t > last - 30 * 86400)),
            'y1': round(sum(v for t, v in ch if t > last - 365 * 86400))}, ts


def binance(sym):
    p = os.path.join(SERIES, f'bn_{sym}.json')
    if not os.path.exists(p):
        return None
    d = json.load(open(p))
    return [(int(a[0]), float(a[1])) for a in d['s'] if a[1]]


def hyperliquid(coin):
    js, ts = cached(f'hl_{coin.replace("@", "at")}.json', 'https://api.hyperliquid.xyz/info',
                    post={'type': 'candleSnapshot', 'req': {'coin': coin, 'interval': '1d',
                          'startTime': 1730000000000, 'endTime': int(time.time() * 1000)}})
    if not js:
        return None
    return [(int(c['t']) // 86400000, float(c['c'])) for c in js]


def cg_series(cid):
    p = os.path.join(DATA, 'cg_series', f'{cid}.json')
    js = json.load(open(p)) if os.path.exists(p) else None
    if js and js.get('prices') and time.time() - js['prices'][-1][0] / 1000 < 2 * 86400:
        pass
    else:
        js, _ = cached(f'cgchart_{cid}.json',
                       f'https://api.coingecko.com/api/v3/coins/{cid}/market_chart?vs_currency=usd&days=365&interval=daily', ttl_h=24)
        if not NONET:
            time.sleep(7)
    if not js or not js.get('prices'):
        return None
    out = {}
    for t, v in js['prices']:
        out[int(t) // 86400000] = float(v)
    return sorted(out.items())


# ---------------- price analytics ----------------
def sma(closes, i, n):
    if i + 1 < n:
        return None
    return sum(closes[i - n + 1:i + 1]) / n


def features(series):
    """Per-day features. series: [(day, close)] sorted, daily."""
    days = [d for d, _ in series]
    c = [v for _, v in series]
    lr = [0.0] + [math.log(c[i] / c[i - 1]) for i in range(1, len(c))]
    out = []
    run = 0.0
    for i in range(len(c)):
        s200 = sma(c, i, 200)
        hi = max(c[max(0, i - 364):i + 1]) if i >= 364 else None
        vol = st.pstdev(lr[i - 29:i + 1]) * math.sqrt(365) if i >= 30 else None
        out.append({'i': i, 'day': days[i], 'c': c[i], 'sma200': s200, 'hi365': hi, 'vol30': vol})
    # quiet = 30d vol <= median 30d vol over the prior 365 days
    vols = [o['vol30'] for o in out]
    for i, o in enumerate(out):
        win = [v for v in vols[max(0, i - 364):i + 1] if v is not None]
        o['quiet'] = (o['vol30'] is not None and len(win) >= 120 and o['vol30'] <= st.median(win))
        o['below'] = (1 - o['c'] / o['sma200']) if o['sma200'] else None
        o['dd'] = (1 - o['c'] / o['hi365']) if o['hi365'] else None
    return out


def rule_fn(kind, thr, quiet):
    def f(o):
        if kind == 'sma':
            ok = o['below'] is not None and o['below'] >= thr
        else:
            ok = o['dd'] is not None and o['dd'] >= thr
        return ok and (o['quiet'] if quiet else True)
    f.label = (f"price >= {int(thr*100)}% below 200d SMA" if kind == 'sma' else f"drawdown from 1y high >= {int(thr*100)}%") + (' AND 30d vol <= 1y median (quiet)' if quiet else '')
    f.key = f"{kind}{int(thr*100)}{'q' if quiet else ''}"
    f.kind, f.thr, f.quiet = kind, thr, quiet
    return f


GRID = [rule_fn('sma', x, q) for x in (0.2, 0.3, 0.4, 0.5) for q in (False, True)] + \
       [rule_fn('dd', y, q) for y in (0.5, 0.6, 0.7, 0.8) for q in (False, True)]


def fwd(feat, i, h):
    j = i + h
    if j >= len(feat) or feat[j]['day'] - feat[i]['day'] != h:  # require gapless
        return None
    return feat[j]['c'] / feat[i]['c'] - 1


def mdd_fwd(feat, i, h=365):
    seg = [o['c'] for o in feat[i:i + h + 1]]
    if len(seg) < h + 1:
        return None
    return min(seg) / seg[0] - 1


def summarize(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return {'n': 0}
    return {'n': len(xs), 'mean': round(st.mean(xs), 4), 'median': round(st.median(xs), 4),
            'pctPos': round(sum(1 for x in xs if x > 0) / len(xs), 3)}


def episodes(days_true):
    """Count independent episodes: signal weeks separated by > 90 days start a new episode."""
    n, last = 0, None
    for d in sorted(days_true):
        if last is None or d - last > 90:
            n += 1
        last = d
    return n


def entries(feat, start_ok=lambda d: True):
    """Weekly entry points (every 7th day) with features available."""
    return [o for o in feat[::7] if o['sma200'] is not None and o['hi365'] is not None and start_ok(o['day'])]


def event_study(coinfeat, rule, split):
    """Pooled across coins. split: 'train' (<2023) or 'test' (>=2023)."""
    keep = (lambda d: d < TRAIN_END) if split == 'train' else (lambda d: d >= TRAIN_END)
    sig1, base1, sig2, base2, sigm, basem, sdays, coins = [], [], [], [], [], [], [], set()
    for sym, feat in coinfeat.items():
        for o in entries(feat, keep):
            r1 = fwd(feat, o['i'], 365)
            if r1 is None:
                continue
            r2 = fwd(feat, o['i'], 730)
            m = mdd_fwd(feat, o['i'])
            base1.append(r1); base2.append(r2); basem.append(m)
            if rule(o):
                sig1.append(r1); sig2.append(r2); sigm.append(m)
                sdays.append((sym, o['day']))
                coins.add(sym)
    eps = sum(episodes([d for s, d in sdays if s == sym]) for sym in coins)
    return {'signal': {'fwd1y': summarize(sig1), 'fwd2y': summarize(sig2), 'maxDD1y': summarize(sigm)},
            'baseline': {'fwd1y': summarize(base1), 'fwd2y': summarize(base2), 'maxDD1y': summarize(basem)},
            'coins': sorted(coins), 'episodes': eps}


def simulate(feat, rule, start_day, end_day=None):
    """$1/week budget from start_day. Returns money multiple for lump sum, DCA, rule-only,
    and 50/50 (half DCA, half saved for the rule). Cash earns 0. Max drawdown of total value."""
    pts = [o for o in feat if o['day'] >= start_day and (end_day is None or o['day'] <= end_day)]
    if len(pts) < 60:
        return None
    weeks = pts[::7]
    W = len(weeks)
    res = {}
    # lump sum: all W dollars at first close
    lump_units = W / weeks[0]['c']
    pk, lmdd = 0.0, 0.0
    for o in pts:
        pk = max(pk, o['c']); lmdd = min(lmdd, o['c'] / pk - 1)
    res['lumpSum'] = {'multiple': round(lump_units * pts[-1]['c'] / W, 3), 'maxDD': round(lmdd, 3)}

    def run(dca_share):
        units, cash, contrib = 0.0, 0.0, 0.0
        peak, mdd, wi = 0.0, 0.0, 0
        for o in pts:
            if wi < W and o['day'] == weeks[wi]['day']:
                contrib += 1
                units += dca_share / o['c']
                cash += 1 - dca_share
                if rule is not None and rule(o) and cash > 0:
                    units += cash / o['c']; cash = 0.0
                wi += 1
            # drawdown of the value/cost multiple (peak-to-trough), so new contributions don't hide losses
            m = (units * o['c'] + cash) / contrib if contrib else 1.0
            peak = max(peak, m)
            mdd = min(mdd, m / peak - 1)
        final = units * pts[-1]['c'] + cash
        return {'multiple': round(final / contrib, 3), 'investedPct': round(1 - cash / contrib, 3), 'maxDD': round(mdd, 3)}
    res['dca'] = run(1.0)
    if rule is not None:
        res['ruleOnly'] = run(0.0)
        res['half'] = run(0.5)
    res['from'] = day_str(pts[0]['day']); res['to'] = day_str(pts[-1]['day']); res['weeks'] = W
    return res


def euphoria_study(coinfeat, mult):
    """1y forward return when price >= mult x 200d SMA, pooled, all history."""
    s, b, eps = [], [], 0
    for feat in coinfeat.values():
        dd_ = []
        for o in entries(feat):
            r = fwd(feat, o['i'], 365)
            if r is None:
                continue
            b.append(r)
            if o['c'] >= mult * o['sma200']:
                s.append(r); dd_.append(o['day'])
        eps += episodes(dd_)
    return {'mult': mult, 'signal': summarize(s), 'baseline': summarize(b), 'episodes': eps}


def strength(test, train, broad_test):
    ts, tb = test['signal']['fwd1y'], test['baseline']['fwd1y']
    if ts.get('n', 0) == 0:
        return 'unproven', 'no test-period signals'
    edge = ts['median'] - tb['median']
    tr_edge = train['signal']['fwd1y']['median'] - train['baseline']['fwd1y']['median']
    bs, bb = broad_test['signal']['fwd1y'], broad_test['baseline']['fwd1y']
    b_edge = (bs.get('median', 0) - bb.get('median', 0)) if bs.get('n') else None
    note = (f"candidates 2023+: median 1y {ts['median']*100:+.0f}% vs all-weeks {tb['median']*100:+.0f}% "
            f"(n={ts['n']} weekly entries, {test['episodes']} episodes); train edge {tr_edge*100:+.0f} pts; "
            f"broad Binance universe 2023+: {bs.get('median', 0)*100:+.0f}% vs {bb.get('median', 0)*100:+.0f}%")
    if edge > 0 and tr_edge > 0.05 and test['episodes'] >= 6 and (b_edge or 0) > 0:
        return 'weak (backtested, small independent sample)', note
    if edge > 0 and (b_edge is not None and b_edge <= 0):
        return 'unproven (worked on these candidates 2023+, failed on the broad universe)', note
    if edge > 0:
        return 'unproven (positive but too few episodes / no train edge)', note
    return 'failed out-of-sample', note


# ---------------- main ----------------
def main():
    cfg = json.load(open(os.path.join(HERE, 'candidates.json')))
    unl = json.load(open(os.path.join(DATA, 'unlocks.json')))
    unl_by = {t.get('gecko_id'): t for t in unl['tokens'] if t.get('gecko_id')}
    unl_at = unl.get('generatedAt')
    sent_path = os.path.join(DATA, 'zec_shielded.json')
    out = {'generatedAt': int(time.time() * 1000), 'reviewedAt': cfg['reviewedAt'], 'candidates': [],
           'rejected': cfg['rejected'], 'sources': {},
           # watchlist = names we track but do NOT buy (no capPct, no DCA plan); passed through as hand-curated, dated snapshots
           'watchlist': cfg.get('watchlist', [])}

    # price series (Binance preferred: longest; HL for HYPE; CG 365d fallback)
    series = {}
    for c in cfg['candidates']:
        s, src = None, None
        if c.get('bn'):
            s, src = binance(c['bn']), 'binance daily (data/flatbase_series)'
        if not s and c.get('hl'):
            s, src = hyperliquid(c['hl']), 'hyperliquid spot candles'
        if not s:
            s, src = cg_series(c['cg']), 'coingecko 365d'
        series[c['sym']] = (s, src)

    # backtest universe = candidates with Binance history >= 3y (BTC excluded by construction)
    bt = {}
    for c in cfg['candidates']:
        s, src = series[c['sym']]
        if s and src.startswith('binance') and len(s) >= 3 * 365:
            bt[c['sym']] = features(s)
    # robustness universe: every Binance series >= 4y, excluding BTC/stables/wrapped/tokenized stocks
    skip = {'btc', 'wbtc', 'usdc', 'fdusd', 'tusd', 'busd', 'usdp', 'dai', 'eur', 'paxg', 'usd1', 'wbeth', 'bfusd'}
    broad = {}
    for f in sorted(os.listdir(SERIES)):
        sym = f[3:-5]
        if sym in skip or sym.endswith('b') and len(sym) > 4:
            continue
        s = binance(sym)
        if s and len(s) >= 4 * 365:
            broad[sym] = features(s)

    grid = []
    for r in GRID:
        tr = event_study(bt, r, 'train')
        te = event_study(bt, r, 'test')
        grid.append({'key': r.key, 'label': r.label, 'train': tr,
                     'testSummary': {'fwd1y': te['signal']['fwd1y'], 'baseMedian1y': te['baseline']['fwd1y'].get('median'), 'episodes': te['episodes']}})
    elig = [g for g in grid if g['train']['signal']['fwd1y'].get('n', 0) >= 30 and len(g['train']['coins']) >= 3]
    best = max(elig, key=lambda g: g['train']['signal']['fwd1y']['median'] - g['train']['baseline']['fwd1y']['median'])
    rule = next(r for r in GRID if r.key == best['key'])
    test = event_study(bt, rule, 'test')
    best['test'] = test
    broad_tr = event_study(broad, rule, 'train'); broad_te = event_study(broad, rule, 'test')
    lab, note = strength(test, best['train'], broad_te)
    sims = {}
    for sym, feat in bt.items():
        first = feat[0]['day']  # rule cannot fire until 365d of history exist; it holds cash until then
        sims[sym] = {'full': simulate(feat, rule, first), 'test': simulate(feat, rule, TRAIN_END)}
    euph = [euphoria_study(bt, m) for m in (1.8, 2.5, 3.5)]
    out['backtest'] = {
        'rule': {'key': rule.key, 'label': rule.label, 'chosenBy': 'max train (entries < 2023-01-01) median 1y forward return minus unconditional median, n>=30 and >=3 coins'},
        'universe': sorted(bt), 'trainEnd': '2023-01-01', 'grid': grid, 'chosen': best,
        'strength': lab, 'strengthNote': note,
        'broad': {'n_coins': len(broad), 'train': broad_tr, 'test': broad_te,
                  'caveat': 'survivor-biased: only coins still listed on Binance today'},
        'simulations': sims, 'euphoria': euph,
        'caveats': ['Weekly entries overlap (52 per year share most of the same forward window): treat episodes, not weekly n, as the real sample size.',
                    'Survivorship: delisted coins are missing, which flatters every strategy.',
                    'Price only: no fees, slippage, taxes; cash earns 0%.',
                    'Rule-only leaves cash idle when no drawdown comes (investedPct < 100%); in a straight bull run it lags DCA and lump sum (see ZEC).',
                    '2023+ test period is a single market cycle.']}

    # per-candidate metrics
    for c in cfg['candidates']:
        cg, cgts = coingecko(c['cg'])
        md = (cg or {}).get('market_data') or {}
        g = lambda k: (md.get(k) or {}).get('usd') if isinstance(md.get(k), dict) else md.get(k)
        price = g('current_price'); mcap = g('market_cap'); fdv = g('fully_diluted_valuation')
        circ, tot, mx = md.get('circulating_supply'), md.get('total_supply'), md.get('max_supply')
        tick = (cg or {}).get('tickers') or []
        majors = ['Binance', 'Coinbase Exchange', 'OKX', 'Bybit', 'Kraken', 'Upbit', 'Bitget', 'KuCoin', 'Gate', 'Hyperliquid', 'Uniswap V3 (Ethereum)', 'Raydium', 'PancakeSwap (v3)']
        names = sorted({t['market']['name'] for t in tick if t.get('market')})
        liq = {'vol24h': g('total_volume'), 'venues': len(names),
               'majors': [m for m in majors if any(n.startswith(m.split(' (')[0]) for n in names)],
               'cgTickersNote': 'first page of CoinGecko tickers (up to 100)'}
        # drawdowns
        s, src = series[c['sym']]
        dd = {}
        if s:
            last_d, last_c = s[-1]
            for lab_, n in (('y1', 365), ('y3', 3 * 365)):
                win = [v for d, v in s if d > last_d - n]
                covered = s[0][0] <= last_d - n + 1
                dd[lab_] = {'high': max(win), 'ddPct': round((last_c / max(win) - 1) * 100, 1),
                            'fullWindow': covered}
            feat = features(s)
            fz = feat[-1]
            dd['lastClose'] = last_c; dd['lastDay'] = day_str(last_d); dd['src'] = src
            dd['sma200'] = round(fz['sma200'], 6) if fz['sma200'] else None
            dd['xSma200'] = round(last_c / fz['sma200'], 3) if fz['sma200'] else None
            # accumulation zone under the chosen rule, priced today
            if rule.kind == 'sma' and fz['sma200']:
                zone = (1 - rule.thr) * fz['sma200']
            elif rule.kind == 'dd' and fz['hi365']:
                zone = (1 - rule.thr) * fz['hi365']
            else:
                zone = None
            dd['zone'] = {'buyBelow': round(zone, 6) if zone else None, 'inZone': bool(zone and last_c <= zone),
                          'quietNow': fz['quiet'], 'ruleFiresNow': bool(rule(fz)) if (fz['sma200'] and fz['hi365']) else None,
                          'distPct': round((zone / last_c - 1) * 100, 1) if zone else None}
            dd['trim'] = [{'mult': m, 'price': round(m * fz['sma200'], 6)} for m in (1.8, 2.5, 3.5)] if fz['sma200'] else []
        ath = g('ath'); athd = (md.get('ath_date') or {}).get('usd')
        unlock = unl_by.get(c['cg'])
        rev = {}
        if c.get('llama'):
            for dtp, k in (('dailyFees', 'fees'), ('dailyRevenue', 'revenue'), ('dailyHoldersRevenue', 'holdersRevenue')):
                v, _ = llama_sum(c['llama'], dtp)
                rev[k] = v
        elif c.get('llamaChain'):
            v, _ = llama_chain(c['llamaChain'])
            rev['chainFees'] = v
        ann = None
        for k in ('holdersRevenue', 'revenue', 'fees', 'chainFees'):
            if rev.get(k) and rev[k].get('y1'):
                ann = (k, rev[k]['y1']); break
        ps = {}
        if mcap:
            for k in ('fees', 'revenue', 'holdersRevenue', 'chainFees'):
                if rev.get(k) and rev[k].get('y1'):
                    ps[k] = round(mcap / rev[k]['y1'], 1)
        buyback_yield = None
        if mcap and rev.get('holdersRevenue') and rev['holdersRevenue'].get('y1'):
            buyback_yield = round(rev['holdersRevenue']['y1'] / mcap * 100, 2)
        derived = []
        if c['sym'] == 'DRV' and mcap and rev.get('revenue'):
            # DefiLlama does not track Derive's buyback; derive it from the documented 35% share
            derived.append({'what': 'implied buyback = 35% of trailing-1y revenue (derived, not measured)',
                            'usd1y': round(0.35 * rev['revenue']['y1']), 'pctMcap': round(0.35 * rev['revenue']['y1'] / mcap * 100, 2)})
        out['candidates'].append({
            'sym': c['sym'], 'name': (cg or {}).get('name'), 'theme': c['theme'], 'bucket': c['bucket'], 'capPct': c['capPct'],
            'thesis': c['thesis'], 'claims': c['claims'], 'risks': c['risks'], 'thesisBreak': c['thesisBreak'],
            'sentimentSym': c.get('sentiment'), 'cgId': c['cg'],
            'market': {'price': price, 'mcap': mcap, 'fdv': fdv, 'circ': circ, 'total': tot, 'max': mx,
                       'circPct': round(circ / (mx or tot) * 100, 1) if circ and (mx or tot) else None,
                       'ath': ath, 'athDate': athd, 'athDDPct': round((price / ath - 1) * 100, 1) if price and ath else None,
                       'asOf': int(cgts * 1000) if cgts else None, 'src': 'coingecko /coins'},
            'liquidity': liq,
            'unlocks': ({'next': unlock['next'][:4], 'unlock30dPctCirc': round(unlock['unlock30d_pct_circ'], 2),
                         'insider30dPctCirc': round(unlock['insider30d_pct_circ'], 2), 'llamaCirc': unlock['circ'],
                         'llamaMax': unlock['max'], 'asOf': unl_at, 'src': 'defillama.com/unlocks (scraped by research/unlocks.py)'}
                        if unlock else {'note': 'not in DefiLlama unlocks data', 'asOf': unl_at}),
            'revenue': rev, 'priceToRevenue': ps, 'holdersYieldPct': buyback_yield, 'derived': derived,
            'price': dd,
            'netSupply': None})
    # buyback consistency / net supply from the terminal's buyburn worker (slimmed)
    try:
        ns = json.load(open(os.path.join(DATA, 'net_supply.json')))
        bc = json.load(open(os.path.join(DATA, 'buyburn_consistency.json')))
        nsb = {r.get('sym'): r for r in ns.get('tokens', []) if isinstance(r, dict)}
        bcb = bc.get('tokens', {})
        for cnd in out['candidates']:
            r = nsb.get(cnd['sym'])
            if r:
                cnd['netSupply'] = {'asOf': ns.get('generatedAt'), 'circBasis': r.get('circ'), 'basis': r.get('burnBasis'),
                                    'unlockSource': r.get('unlockSource'),
                                    'windows': {k: {kk: round(v[kk], 3) for kk in ('unlockPctCirc', 'burnPctCirc', 'netPctCirc') if v.get(kk) is not None}
                                                for k, v in (r.get('windows') or {}).items()}}
            k = bcb.get(cnd['sym'])
            if k:
                cnd['consistency'] = {'asOf': bc.get('generated'), 'frequency': k.get('frequency'), 'uptime': k.get('uptime'),
                                      'nGaps': k.get('n_gaps'), 'gaps': (k.get('gaps') or [])[:3], 'nEvents': k.get('n_events')}
    except Exception as e:
        sys.stderr.write(f'net supply merge skipped: {e}\n')
    try:
        z = json.load(open(sent_path))
        cur = z.get('current') or {}
        for cnd in out['candidates']:
            if cnd['sym'] == 'ZEC':
                cnd['extra'] = {'zecShielded': {'date': cur.get('date'), 'sharePct': round(cur.get('sharePct', 0), 2),
                                'ironwoodPct': round((cur.get('poolSharePct') or {}).get('ironwood', 0), 2), 'src': cur.get('src')}}
    except Exception:
        pass
    # DCA plan per candidate: weekly % of the Long Book budget
    tot = sum(c['capPct'] for c in out['candidates'])
    for cnd in out['candidates']:
        w = cnd['capPct'] / tot
        cnd['plan'] = {'weeklyPctOfBudget': round(w * 100 / 52, 3), 'weightPct': round(w * 100, 1),
                       'split': '50% fixed weekly DCA; 50% saved and deployed only in weeks the accumulation rule fires (the "half" strategy in the backtest)'}
    out['portfolio'] = {'capSumPct': tot, 'memeSliceMaxPct': 7, 'coreCapRangePct': [5, 15],
                        'note': 'capPct = max position as % of the whole portfolio. Meme slice (PUMP + any memecoins elsewhere) capped at 7% total; speculative names (QRL, DRV) 2% each.'}
    with open(os.path.join(DATA, 'longbook.json'), 'w') as f:
        json.dump(out, f, indent=1, default=lambda o: None)
    b = out['backtest']
    print('rule', b['rule']['label'], '|', b['strength'], '|', b['strengthNote'])
    for cnd in out['candidates']:
        m = cnd['market']; p = cnd['price']
        print(cnd['sym'], m['price'], m['mcap'], p.get('xSma200'), p.get('y1', {}).get('ddPct'), p.get('zone'))


if __name__ == '__main__':
    main()
