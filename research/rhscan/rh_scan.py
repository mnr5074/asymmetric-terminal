#!/usr/bin/env python3
"""Robinhood Chain utility scanner: the PRIORS pre-breakout pattern.

Free sources only: GeckoTerminal (pools, 4h OHLCV, token info) and DexScreener (pairs, socials).
No keys. Raw responses cached under research/rhscan/cache/ (OHLCV 6h, info 24h) so reruns are cheap.

Pattern (calibrated on PRIORS 0xedbf…90be: base Sep 26-27 2026 about 50% below its first peak, volume
returned Sep 29, then ~6x within 5 days and ~10x off the base low):
  1. Pullback: a base bar 45-70% below the highest 4h close so far (sweet spot 50-60%).
  2. Quiet stretch: the 12 bars (2 days) ending at the base bar closed inside a <=2.1x range, and their
     average volume is <=50% of the busiest 2-day stretch since launch.
  3. Volume rising (the trigger): within 6 days of a base bar, the last 3 bars average >=1.5x the base
     volume AND a 4h close above the base high (and no more than 1.5x the old peak close: PRIORS' volume arrived as it broke its old peak).
  4. Clean contract (GeckoTerminal): not a honeypot, top-10 holders <= 50%, dev holding <= 10%.
  5. Real utility: a website AND a product description (keyword evidence; confirm by hand).

Outputs: data/rh_scan.json (served at /api/rhscan) and research/rhscan/RH_SCAN.md.
Backtest: the same rules 1-3 are replayed bar-by-bar on every scanned token's own history;
forward result = best high within 42 bars (7 days) vs the signal close, and whether price
first fell 30% below the entry. Strength is labelled from that sample; with only weeks of
chain history it is 'unproven' or 'weak' by construction.

usage: python3 research/rhscan/rh_scan.py [--pages 10] [--no-cache]
"""
import json, os, sys, time, re, math, argparse, urllib.request, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import coiled as CO

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.environ.get('DATA_DIR', os.path.join(ROOT, 'data'))
CACHE = os.path.join(ROOT, 'research', 'rhscan', 'cache')
GT = 'https://api.geckoterminal.com/api/v2'
DS = 'https://api.dexscreener.com'
NET = 'robinhood'
PRIORS = '0xedbf91223639800bcd5756815caf908df3b890be'
# Named by Martin: always included when present. Verified addresses (oldest / deepest pools on DexScreener 2026-10-18).
FORCE = {
    PRIORS: 'PRIORS (reference pattern)',
    '0x63ee32ac3077d1fbd8a77ebba2a6ed4b8e9c1e18': 'iNu',
    '0x18e674231a58c239dc7daedcffe15ec3a24cff5c': 'HOOKR (Hookr.fun)',
}
# Same-ticker copies seen in DexScreener search; flagged, never ranked.
IMPOSTORS = {
    '0x98e670d2e53a9176dcf0084c80cf6a8df939ff5c': 'HOOKR copy "Hookr" created 2026-10-17 with ~$10.8M quoted liquidity and ~$5 volume: likely fake liquidity',
}
QUOTES = {'WETH', 'ETH', 'USDG', 'USDC', 'USDT', 'WBTC', 'USDC.E', 'DAI', 'HOOD'}
# Manual utility review (2026-10-18), from the GeckoTerminal description + website only: no site visits, nothing verified on-chain.
# True = a product is described; False = community/meme token despite keywords; None = site exists but no description to judge.
UTIL_MANUAL = {
    '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18': (False, 'Artificial Inu: community token paired with tokenized NVDA; keywords describe the pair, not a product'),
    '0x18e674231a58c239dc7daedcffe15ec3a24cff5c': (True, 'Hookr.fun: token launchpad (site + docs); no description on GeckoTerminal; usage unverified'),
    '0xdee52f2ab639b6942b0d0f0565400b93b7a0fbe5': (False, 'Harmonic Agent: self-buyback/burn agent token; no product described'),
    '0x9f4ba41f91a59a34e17ee8c9eb3a51363b11abd5': (None, 'grift.world: game described in one line; product status unverified'),
}
UTIL_WORDS = re.compile(r'\b(protocol|platform|lend|lending|credit|dex|swap|launchpad|bridge|wallet|agent|agents|ai|oracle|perp|perps|staking|yield|vault|payments?|marketplace|game|gaming|infrastructure|tool|tools|app|sdk|api|trading|bot|terminal|exchange|stablecoin|rwa|tokeni[sz]ed)\b', re.I)

GT_GAP = 2.2  # s between GeckoTerminal calls (free tier ~30/min)
_last = [0.0]
CALLS = {'gt': 0, 'ds': 0, 'cache': 0}

def get(url, gt=True, tries=4):
    for k in range(tries):
        if gt:
            w = _last[0] + GT_GAP - time.time()
            if w > 0: time.sleep(w)
            _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={'accept': 'application/json', 'user-agent': 'asymmetric-terminal/rhscan'})
            with urllib.request.urlopen(req, timeout=25) as r:
                CALLS['gt' if gt else 'ds'] += 1
                return json.load(r)
        except Exception as e:
            code = getattr(e, 'code', None)
            if code == 404: return None
            time.sleep(8 * (k + 1) if code == 429 else 2)
    return None

def cached(name, ttl, fn, use_cache=True):
    p = os.path.join(CACHE, name)
    if use_cache and os.path.exists(p) and time.time() - os.path.getmtime(p) < ttl:
        CALLS['cache'] += 1
        with open(p) as f: return json.load(f)
    v = fn()
    if v is not None:
        os.makedirs(CACHE, exist_ok=True)
        with open(p, 'w') as f: json.dump(v, f)
    return v

def num(x):
    try: return float(x)
    except Exception: return None

# ---------- universe ----------
def universe(pages, uc):
    pools = {}
    def add(lst):
        for p in (lst or {}).get('data', []) or []:
            a = p['attributes']; rel = p.get('relationships', {})
            base = (rel.get('base_token', {}).get('data', {}) or {}).get('id', '')
            quote = (rel.get('quote_token', {}).get('data', {}) or {}).get('id', '')
            pools[p['attributes']['address'].lower()] = {
                'pool': a['address'], 'name': a.get('name'), 'base': base.split('_', 1)[-1].lower(), 'quote': quote.split('_', 1)[-1].lower(),
                'liq': num(a.get('reserve_in_usd')), 'fdv': num(a.get('fdv_usd')), 'mcap': num(a.get('market_cap_usd')),
                'vol24': num((a.get('volume_usd') or {}).get('h24')), 'created': a.get('pool_created_at'), 'price': num(a.get('base_token_price_usd')),
            }
    for pg in range(1, pages + 1):
        add(cached(f'pools_{pg}.json', 6 * 3600, lambda pg=pg: get(f'{GT}/networks/{NET}/pools?page={pg}'), uc))
    for pg in range(1, 4):
        add(cached(f'trending_{pg}.json', 6 * 3600, lambda pg=pg: get(f'{GT}/networks/{NET}/trending_pools?page={pg}'), uc))
    # forced tokens: their pools
    for addr in FORCE:
        add(cached(f'tokpools_{addr}.json', 6 * 3600, lambda addr=addr: get(f'{GT}/networks/{NET}/tokens/{addr}/pools?page=1'), uc))
    # best pool per base token (deepest liquidity), skip quote-like bases
    best = {}
    for p in pools.values():
        sym = (p['name'] or '').split('/')[0].strip().upper()
        if sym in QUOTES or not p['base']: continue
        p['symbol'] = sym
        b = best.get(p['base'])
        if not b or (p['liq'] or 0) > (b['liq'] or 0): best[p['base']] = p
    return best, len(pools)

# ---------- OHLCV ----------
def ohlcv(pool, uc):
    d = cached(f'ohlcv4h_{pool.lower()}.json', 6 * 3600, lambda: get(f'{GT}/networks/{NET}/pools/{pool}/ohlcv/hour?aggregate=4&limit=1000&currency=usd'), uc)
    try: rows = sorted(d['data']['attributes']['ohlcv_list'])
    except Exception: return []
    return [{'t': int(r[0]), 'o': r[1], 'h': r[2], 'l': r[3], 'c': r[4], 'v': r[5]} for r in rows if r[4]]

Q = 12          # quiet stretch, bars (2 days of 4h bars)
FWD = 42        # forward window, bars (7 days)
LOOK = 36       # a trigger must come within 36 bars (6 days) of a base bar (PRIORS: base Sep 27 04:00 UTC, volume trigger Sep 29 00:00 UTC = 30 bars)
STOP = 0.70     # backtest + plan stop: -30% from entry (or the base low, whichever is higher)

def base_at(b, j):
    """Setup state at bar j (bars <= j only): pullback + quiet stretch ending at j."""
    if j < Q + 6: return None
    closes = [x['c'] for x in b[:j + 1]]
    peak = max(closes); dd = 1 - closes[j] / peak if peak else 0
    w = b[j - Q + 1:j + 1]; wc = [x['c'] for x in w]
    qrange = max(wc) / min(wc) if min(wc) > 0 else 99
    qv = st.mean(x['v'] for x in w)
    roll = [st.mean(x['v'] for x in b[k - Q + 1:k + 1]) for k in range(Q - 1, j + 1)]
    peakv = max(roll) if roll else 0
    return {'j': j, 'dd': dd, 'peakClose': peak, 'qRange': qrange, 'qVol': qv, 'qVolVsPeak': (qv / peakv) if peakv else None,
            'baseHigh': max(wc[-6:]),  # top of the last day of the base (the full 2-day window still contains the slide)
             'baseLow': min(x['l'] for x in w), 'ageDays': (b[j]['t'] - b[0]['t']) / 86400}

def is_setup(f):
    return bool(f) and 0.45 <= f['dd'] <= 0.70 and f['qRange'] <= 2.1 and (f['qVolVsPeak'] is not None and f['qVolVsPeak'] <= 0.5) and f['ageDays'] >= 3

def state_at(b, i, cache=None):
    """Most recent setup within LOOK bars before/at i, and whether bar i triggers off it."""
    cache = cache if cache is not None else {}
    setup = None
    for j in range(i, max(Q + 5, i - LOOK) , -1):
        f = cache.get(j)
        if f is None: f = cache[j] = base_at(b, j) or {}
        if is_setup(f): setup = f; break
    if not setup: return None, False, None
    v3 = st.mean(x['v'] for x in b[max(0, i - 2):i + 1])
    vr = v3 / setup['qVol'] if setup['qVol'] else 0
    c = b[i]['c']
    trig = setup['j'] < i and vr >= 1.5 and c > setup['baseHigh'] and c <= 1.5 * setup['peakClose']  # PRIORS' volume came on the push through its old peak, so allow up to 1.5x the old peak
    return setup, trig, vr

def rule_pass(b, i):
    s, trig, vr = state_at(b, i)
    return {'pullback': bool(s), 'quiet': bool(s), 'volRising': bool(trig), 'age': bool(s)}, s, trig, vr

def outcome(b, i):
    e = b[i]['c']; fw = b[i + 1:i + 1 + FWD]
    if not fw: return None
    best = max(x['h'] for x in fw) / e
    jbest = max(range(len(fw)), key=lambda j: fw[j]['h'])
    stopped = any(x['l'] <= e * STOP for x in fw[:jbest + 1])
    return {'best7d': round(best, 3), 'stopFirst': stopped, 'end7d': round(fw[-1]['c'] / e, 3), 'complete': len(fw) == FWD}

def backtest(series):
    """Replay the price/volume rules on each token's own history. One trigger per token per 7 days.
    Baseline = every 6th bar (once a day) of the same tokens after day 3, same outcome definition."""
    sig, base = [], []
    for addr, (sym, b) in series.items():
        last = -10**9; cache = {}
        for i in range(Q + 6, len(b) - 1):
            if (b[i]['t'] - b[0]['t']) / 86400 >= 3 and i % 6 == 0:
                o = outcome(b, i)
                if o: base.append({'token': addr, 't': b[i]['t'], **o})
            s, trig, vr = state_at(b, i, cache)
            if trig and i - last >= FWD:
                last = i; o = outcome(b, i)
                if o: sig.append({'symbol': sym, 'token': addr, 't': b[i]['t'], **o})
    return sig, base

def summarize(sig):
    done = [s for s in sig if s['complete']]
    n = len(done)
    if not n: return {'n': 0}
    hit2 = [s for s in done if s['best7d'] >= 2 and not s['stopFirst']]
    any2 = [s for s in done if s['best7d'] >= 2]
    stop = [s for s in done if s['stopFirst']]
    return {'n': n, 'tokens': len({s['token'] for s in done}), 'hit2xBeforeStop': len(hit2), 'hit2xBeforeStopPct': round(100 * len(hit2) / n, 1),
            'reached2x': len(any2), 'stoppedFirst': len(stop), 'stoppedFirstPct': round(100 * len(stop) / n, 1),
            'medianBest7d': round(st.median(s['best7d'] for s in done), 2), 'medianEnd7d': round(st.median(s['end7d'] for s in done), 2),
            'incomplete': len(sig) - n}

def strength(summ, base):
    n = summ.get('n', 0); bp = base.get('hit2xBeforeStopPct')
    if n < 30: return 'unproven', f'only {n} completed historical triggers on Robinhood Chain (need >=30 for even a weak read); baseline {bp}% of n={base.get("n")}'
    sp = summ['hit2xBeforeStopPct']
    if n >= 100 and bp is not None and sp >= 2 * bp: return 'backtested', f'{n} triggers, {sp}% vs baseline {bp}%'
    return 'weak', f'{n} triggers; {sp}% hit 2x before -30% vs baseline {bp}% (n={base.get("n")}); survivor-biased universe'

# ---------- per-token enrichment ----------
def gt_info(addr, uc):
    d = cached(f'info_{addr}.json', 24 * 3600, lambda: get(f'{GT}/networks/{NET}/tokens/{addr}/info'), uc)
    try: return d['data']['attributes']
    except Exception: return {}

def ds_pairs(addrs, uc):
    out = {}
    for k in range(0, len(addrs), 30):
        chunk = addrs[k:k + 30]
        d = cached(f'ds_{abs(hash(",".join(chunk))) % 10**10}.json', 3 * 3600, lambda chunk=chunk: get(f'{DS}/tokens/v1/{NET}/{",".join(chunk)}', gt=False), uc)
        for p in d or []:
            a = p['baseToken']['address'].lower()
            if a not in out or (p.get('liquidity', {}).get('usd') or 0) > (out[a].get('liquidity', {}).get('usd') or 0): out[a] = p
    return out

def contract_check(info):
    h = (info.get('holders') or {}).get('distribution_percentage') or {}
    top10 = num(h.get('top_10')); dev = num(info.get('developer_holding_percentage'))
    flags = []
    if info.get('is_honeypot') is True: flags.append('honeypot flagged by GeckoTerminal')
    if top10 is not None and top10 > 100: top10 = None  # GeckoTerminal data error (seen: 281%)
    if top10 is not None and top10 > 50: flags.append(f'top-10 holders own {top10:.1f}%')
    if dev is not None and dev > 10: flags.append(f'developer holds {dev:.1f}%')
    unknown = info.get('is_honeypot') is None or top10 is None
    return {'clean': not flags and not unknown, 'flags': flags, 'unknown': unknown, 'top10': top10, 'devPct': dev,
            'holders': (info.get('holders') or {}).get('count'), 'honeypot': info.get('is_honeypot'), 'gtScore': info.get('gt_score'),
            'gtVerified': info.get('gt_verified'), 'source': 'GeckoTerminal token info (holders updated ' + str((info.get('holders') or {}).get('last_updated')) + ')'}

def utility_check(info, ds):
    desc = (info.get('description') or '').strip()
    sites = list(info.get('websites') or []) + [w.get('url') for w in ((ds or {}).get('info') or {}).get('websites', []) if w.get('url')]
    sites = sorted(set(s for s in sites if s))
    words = sorted(set(w.lower() for w in UTIL_WORDS.findall(desc)))
    cats = info.get('categories') or []
    meme = any('meme' in c.lower() for c in cats)
    ev = bool(sites) and len(words) >= 2 and len(desc) >= 80 and not meme
    man = UTIL_MANUAL.get((info.get('address') or '').lower())
    if man is not None: ev = bool(man[0])
    return {'evidence': ev, 'websites': sites[:3], 'keywords': words[:8], 'categories': cats, 'description': desc[:280],
            'twitter': info.get('twitter_handle'), 'manual': man[1] if man else None, 'note': 'keyword evidence only: confirm the product exists and is used before buying'}

def plan(sym, price, f, liq, summ, state=None):
    """Mechanical plan from the token's own levels. Sizes are % of the trading portfolio."""
    if not f or not price or 'baseHigh' not in f: return None
    if f.get('dd') is not None and not (0.40 <= f['dd'] <= 0.75) and not f.get('setupBarUtc'):
        ph = f['peakClose']; lo, hi = ph * 0.40, ph * 0.55
        why = (f'only {f["dd"] * 100:.0f}% below its peak close {ph:.6g}' if f['dd'] < 0.40 else f'{f["dd"] * 100:.0f}% below its peak close {ph:.6g}: deeper than the pattern (45-70%)')
        return {'entry': f'No entry: not in the PRIORS pattern ({why}). It would qualify only after a 50-60% pullback ({lo:.6g}-{hi:.6g}), a 2-day quiet base, then a volume close above the base.' if f['dd'] < 0.40 else
                         f'No entry: {why}. The pattern does not apply; treat it as a separate thesis.',
                'entryTrigger': None, 'size': '0% under this pattern', 'sizePct': 0, 'sells': [], 'sellLevels': [],
                'walkAway': ['Not applicable: no position under this pattern'], 'walkAwayLevel': None, 'qualifyZone': [lo, hi] if f['dd'] < 0.40 else None,
                'backtestNote': ''}
    if state in ('Extended', 'Broke base'):
        return {'entry': ('No entry: price is %.1fx the base high, above the 15%% chase limit; chasing is outside the plan. Re-scan for a new base.' % (price / f['baseHigh'])) if state == 'Extended'
                         else f'No entry: price fell below the base low {f["baseLow"]:.6g}, so the setup failed.',
                'entryTrigger': None, 'size': '0% under this pattern', 'sizePct': 0, 'sells': [], 'sellLevels': [],
                'walkAway': ['Not applicable: no position'], 'walkAwayLevel': None, 'backtestNote': ''}
    trig = f['baseHigh']                       # breakout = 4h close above the base high
    ref = max(price, trig)
    stop = max(f['baseLow'], ref * STOP)       # walk-away: base low, but never risk more than 30%
    risk = 1 - stop / ref
    risk_budget = 0.5                          # % of portfolio lost if the walk-away level is hit
    size = round(min(1.0, risk_budget / (risk * 100) * 100), 2) if risk > 0 else 0.5
    liq_cap = round(0.01 * liq) if liq else None
    ph = f['peakClose']; two = ref * 2
    first, second = sorted([(ph, 'prior peak close'), (two, '2x from entry')])
    return {
        'entry': (f'Trigger already fired: buy only while price is under {trig * 1.15:.6g} (15% above the base high {trig:.6g}); otherwise wait for a pullback toward {trig:.6g}.' if f.get('triggerNow') else
                  f'Wait. Buy only on a 4h close above {trig:.6g} (top of the base) with volume >=1.5x the base average; skip it if it is already more than 15% above ({trig * 1.15:.6g}).'),
        'entryTrigger': trig, 'chaseLimit': trig * 1.15,
        'size': f'{size}% of portfolio (risks {risk_budget}% at the walk-away; capped at 1% because the signal is weak/unproven)' + (f'; and never more than ${liq_cap:,} (1% of pool liquidity)' if liq_cap else ''),
        'sizePct': size, 'maxUsdByLiquidity': liq_cap,
        'sells': [f'Sell 1/3 at {first[0]:.6g} ({first[1]})', f'Sell 1/3 at {second[0]:.6g} ({second[1]})', 'Trail the last 1/3: exit on a 4h close 35% below the highest close since entry'],
        'sellLevels': [first[0], second[0]],
        'walkAway': [f'4h close below {stop:.6g}: exit all (' + ('the base low' if stop == f['baseLow'] else '-30% from entry; the base low is deeper') + ')',
                     'No +30% within 7 days of entry: exit (time stop)',
                     'Pool liquidity drops 40%+ from entry, top-10 holders rise above 50%, or a honeypot/tax flag appears: exit'],
        'walkAwayLevel': stop, 'riskToWalkAwayPct': round(risk * 100, 1),
        'backtestNote': f'Replay on Robinhood Chain: {summ.get("hit2xBeforeStop", 0)} of {summ.get("n", 0)} past triggers reached 2x before -30%; median best in 7 days {summ.get("medianBest7d")}x.' if summ.get('n') else 'No completed past triggers to compare.',
    }

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--pages', type=int, default=10); ap.add_argument('--no-cache', action='store_true')
    ap.add_argument('--min-liq', type=float, default=20000)
    a = ap.parse_args(); uc = not a.no_cache
    t0 = time.time()
    best, npools = universe(a.pages, uc)
    toks = {k: v for k, v in best.items() if (v['liq'] or 0) >= a.min_liq or k in FORCE}
    toks = {k: v for k, v in toks.items() if k not in IMPOSTORS}
    series = {}
    for addr, p in toks.items():
        b = ohlcv(p['pool'], uc)
        if len(b) >= Q + 8: series[addr] = (p['symbol'], b)
    sig, basesig = backtest(series); summ = summarize(sig); bsumm = summarize(basesig); strg, why = strength(summ, bsumm)
    coil = CO.run(series, sig, basesig)
    cT, cV = (coil['chosen']['T'], coil['chosen']['V']) if coil['chosen'] else CO.DEFAULT_CELL
    coil_now = {}
    for addr, (sym, b) in series.items():
        c = CO.coil_at(b, len(b) - 1, cT, cV)
        if c: coil_now[addr] = c
    # current state
    rows = []
    for addr, (sym, b) in series.items():
        i = len(b) - 1; r, setup, trig, vr = rule_pass(b, i)
        f = setup or base_at(b, i) or {}
        if f: f = {**f, 'volRise': vr, 'triggerNow': trig, 'setupBarUtc': time.strftime('%Y-%m-%d %H:%M', time.gmtime(b[f['j']]['t'])) if setup else None}
        rows.append((addr, sym, b, f, r))
    # enrich: anything in pullback zone or forced
    focus = [x for x in rows if x[4].get('pullback') or x[0] in FORCE or x[0] in coil_now or (x[3] and 0.40 <= x[3].get('dd', 0) <= 0.75)]
    dsx = ds_pairs([x[0] for x in focus], uc)
    out = []
    for addr, sym, b, f, r in focus:
        info = gt_info(addr, uc); ds = dsx.get(addr, {})
        cc = contract_check(info); ut = utility_check(info, ds)
        p = toks[addr]; price = b[-1]['c']
        checks = {**r, 'cleanContract': cc['clean'], 'utility': ut['evidence']}
        npass = sum(1 for v in checks.values() if v)
        # where is price now relative to the base? (a base found up to 6 days ago can already be stale)
        pos = None
        if f.get('setupBarUtc'):
            pos = ('above' if price > f['baseHigh'] * 1.15 else 'below' if price < f['baseLow'] else 'in')
        ok_now = pos == 'in'
        if pos is not None: checks['baseIntact'] = pos == 'in'
        state = ('Trigger' if all(checks.values()) and f.get('triggerNow') else
                 'Extended' if pos == 'above' else
                 'Broke base' if pos == 'below' else
                 'Setup' if r.get('pullback') and cc['clean'] and ut['evidence'] and ok_now else
                 'Watch' if r.get('pullback') and cc['clean'] and ok_now else 'Fails')
        ma = ('base at %s UTC: ' % f['setupBarUtc'] if f.get('setupBarUtc') else 'now: ') + 'pullback %.0f%% from peak close (want 45-70%%, best 50-60%%)' % (f['dd'] * 100)
        posTxt = {'above': 'price is now %.1fx the base high: it left the base (no qualifying volume trigger inside the chase limit), no entry; wait for a new base' % (price / f['baseHigh']) if f.get('baseHigh') else '',
                  'below': 'price is now under the base low %.6g: base broken, pattern void' % f.get('baseLow', 0), 'in': 'price is inside the base: waiting for the volume trigger'}.get(pos)
        reasons = [ma] + ([posTxt] if posTxt else []) + [
                   'quiet stretch: closes in a %.2fx range (want <=2.1x), volume %s of its busiest 2 days (want <=50%%)' % (f['qRange'], ('%.0f%%' % (f['qVolVsPeak'] * 100)) if f.get('qVolVsPeak') is not None else 'n/a'),
                   ('last-12h volume %.1fx the base average' % f['volRise'] if f.get('volRise') is not None else 'no base yet, so no volume trigger') + (' and price closed above the base: TRIGGER' if f.get('triggerNow') else ''),
                   ('contract: clean' if cc['clean'] else 'contract: ' + ('; '.join(cc['flags']) or 'unknown (GeckoTerminal has no holder/honeypot data)')),
                   ('utility evidence: ' + ', '.join(ut['keywords'][:4]) if ut['evidence'] else 'utility: not evidenced (no site/description or meme category)')]
        out.append({
            'token': addr, 'symbol': sym, 'name': info.get('name') or sym, 'named': FORCE.get(addr), 'pool': p['pool'], 'state': state,
            'checks': checks, 'passed': npass, 'of': len(checks), 'reasons': reasons,
            'price': price, 'priceAt': b[-1]['t'] * 1000, 'liqUsd': p['liq'], 'fdvUsd': p['fdv'], 'vol24Usd': p['vol24'],
            'ageDays': round((b[-1]['t'] - b[0]['t']) / 86400, 1), 'm': {k: (round(v, 6) if isinstance(v, float) else v) for k, v in f.items()},
            'contract': cc, 'utility': ut, 'basePosition': pos,
            'plan': plan(sym, price, f, p['liq'], summ, state) if state != 'Fails' or addr in FORCE else None,
            'dexscreener': f'https://dexscreener.com/robinhood/{p["pool"]}', 'strength': strg,
        })
    for x in out:
        pl = x.get('plan')
        if pl and x['state'] == 'Watch' and pl.get('entryTrigger'):
            pl['entry'] = 'Monitor only: fails the real-utility check (' + (x['utility'].get('manual') or 'no product description found') + '). Only if utility is confirmed by hand: ' + pl['entry']
            pl['monitorOnly'] = True
    for x in out:
        c = coil_now.get(x['token'])
        if not c: continue
        full = x['checks'].get('cleanContract') and x['checks'].get('utility')
        pl = CO.plan(x['symbol'], x['price'], c, x['liqUsd'], c['peakClose'])
        if pl and not full:
            pl['entry'] = 'Monitor only: ' + ('fails the clean-contract check' if not x['checks'].get('cleanContract') else 'fails the real-utility check') + '. ' + pl['entry']
        x['coiled'] = {'live': coil['ship'] and bool(full), 'experimental': not coil['ship'], 'T': cT, 'V': cV,
                       'reason': 'base closes in a %.2fx range (<= %.2fx), volume %.1fx the base average (>= %.1fx), price %.0f%% under the base top, %.0f%% below the prior peak close' % (c['range'], cT, c['volRatio'], cV, 100 * (1 - x['price'] / c['baseTop']), 100 * c['dd']),
                       'baseTop': c['baseTop'], 'baseLow': c['baseLow'], 'plan': pl, 'monitorOnly': not full}
        if coil['ship'] and full and x['state'] not in ('Trigger',): x['state'] = 'Coiled'
    order = {'Trigger': 0, 'Coiled': 0.5, 'Setup': 1, 'Watch': 2, 'Extended': 3, 'Broke base': 4, 'Fails': 5}
    out.sort(key=lambda x: (order[x['state']], -(x['passed']), -(x['liqUsd'] or 0)))
    # PRIORS calibration: features at its base (Sep 29 2026 ~ the first volume-rising 4h bar)
    cal = None
    if PRIORS in series:
        b = series[PRIORS][1]
        cache = {}; hits = []; setups = []
        for i in range(Q + 6, len(b)):
            s_, trig, vr = state_at(b, i, cache)
            if s_ and s_['j'] == i: setups.append(b[i]['t'])
            if trig: hits.append((b[i]['t'], b[i]['c'], outcome(b, i)))
        cal = {'setupBarsUtc': [time.strftime('%Y-%m-%d %H:%M', time.gmtime(t)) for t in setups][:12],
               'triggers': [{'barUtc': time.strftime('%Y-%m-%d %H:%M', time.gmtime(t)), 'close': c, **(o or {})} for t, c, o in hits][:12],
               'note': 'Rules were tuned on this one example (n=1), so PRIORS matching them proves nothing; the replay on other tokens is the test.'}
    now = int(time.time() * 1000)
    res = {
        'v': 1, 'generatedAt': now, 'dataAsOf': now, 'lastBarAt': max((x['priceAt'] for x in out), default=None), 'chain': 'Robinhood Chain (GeckoTerminal "robinhood", DexScreener "robinhood")',
        'sources': ['GeckoTerminal API v2 (free)', 'DexScreener API (free)'], 'calls': CALLS, 'elapsedSec': round(time.time() - t0),
        'universe': {'poolsSeen': npools, 'tokens': len(best), 'withMinLiquidity': len(toks), 'withHistory': len(series), 'minLiqUsd': a.min_liq},
        'rules': {'pullback': 'base bar 45-70% below the highest 4h close so far (best 50-60%)', 'quiet': f'{Q} bars (2 days) ending at the base bar close inside a <=2.1x range; their avg volume <=50% of the busiest 2-day stretch',
                  'volRising': 'within 6 days of the base: last 3 bars avg volume >=1.5x the base average and a close above the base high (and no more than 1.5x the old peak close: PRIORS volume arrived as it broke its old peak)', 'age': '>=3 days of history',
                  'cleanContract': 'GeckoTerminal: not honeypot, top-10 <=50%, dev <=10%, data present', 'utility': 'website + product description (keyword evidence; confirm manually)'},
        'coiled': {**{k: coil[k] for k in ('split', 'grid', 'chosen', 'chosenResult', 'random', 'trigger', 'ship', 'shipWhy', 'signals')},
                   'splitUtc': time.strftime('%Y-%m-%d %H:%M', time.gmtime(coil['split'])) if coil['split'] else None,
                   'displayCell': {'T': cT, 'V': cV}, 'candidates': len(coil_now),
                   'strength': 'weak' if coil['ship'] else 'unproven',
                   'label': 'live tier (passed the pre-declared test on the later split)' if coil['ship'] else 'experimental, did not beat random (failed the pre-declared test: ' + coil['shipWhy'] + ')',
                   'preDeclared': CO.__doc__.split('PRE-DECLARED TEST')[1].strip()},
        'baseline': {**bsumm, 'what': 'one entry per day on the same tokens after day 3 (no pattern), same 2x-before--30% rule'},
        'backtest': {**summ, 'forward': '7 days (42 x 4h bars)', 'win': 'best high >= 2x entry before any 4h low <= -30%', 'trigger': 'volume (last 3 bars) >=1.5x the base average AND close above the base high and no more than 1.5x the prior peak close, within 6 days of a base bar',
                     'caveats': ['Universe is today\'s survivors (pools still listed): dead tokens are missing, so results are biased upward.',
                                 'Chain history is only weeks long; liquidity at signal time is unknown (today\'s is used for the filter).',
                                 'Rules 4-5 (contract, utility) cannot be replayed historically; only price/volume rules 1-3 are tested.'],
                     'signals': sorted(sig, key=lambda s: -s['t'])[:60]},
        'strength': strg, 'strengthWhy': why, 'priorsCalibration': cal,
        'impostors': [{'token': k, 'why': v} for k, v in IMPOSTORS.items()],
        'items': out,
    }
    with open(os.path.join(DATA, 'rh_scan.json'), 'w') as fh: json.dump(res, fh, indent=1)
    print(json.dumps({'coiled': {k: res['coiled'][k] for k in ('chosen', 'ship', 'shipWhy', 'candidates', 'splitUtc')}, 'universe': res['universe'], 'backtest': summ, 'baseline': bsumm, 'strength': strg, 'states': {s: sum(1 for x in out if x['state'] == s) for s in order}, 'calls': CALLS, 'priors': cal}, indent=1))

if __name__ == '__main__':
    main()
