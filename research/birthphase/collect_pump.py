"""Pump.fun birth-phase collector. For each mint: pump.fun public coin record (frontend-api-v3 coins-v2), the full
trade sequence from creation forward via swap-api.pump.fun/v2/coins/<mint>/trades (cursor = time, paged backwards
inside forward windows) up to graduation or a page budget, sparse time probes for the rest of the arc, a binary search
for the graduation time, and GeckoTerminal OHLCV on the PumpSwap pool for post-graduation milestones.
Writes raw per-token json to data/birthphase/cache/raw/pump/<mint>.json (full addresses stay private on the box);
build_library.py turns raw files into data/birthphase/pump.fun.jsonl.
usage: python3 collect_pump.py [--random N] [--limit N] [--workers 3]"""
import sys, os, json, time, calendar, math, random, sqlite3, argparse, concurrent.futures as cf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bp_common import http, BP, DATA, GT, CHECKPOINTS, wjson
RAW = os.path.join(BP, 'cache', 'raw', 'pump'); os.makedirs(RAW, exist_ok=True)
SW = 'https://swap-api.pump.fun/v2/coins/%s/trades?limit=100&cursor=%s'
K = 30.0 * 1.073e9  # pump curve constant (virtual SOL 30, virtual tokens 1.073B at start)
CURVE_TOKENS = 793.1e6

def coin(mint, ttl=3 * 3600):
    d = http('https://frontend-api-v3.pump.fun/coins-v2/' + mint, ttl=ttl)
    return d if isinstance(d, dict) and d.get('mint') else None

def page(mint, cursor):
    d = http(SW % (mint, cursor), ttl=None)
    if not isinstance(d, dict) or 'trades' not in d: return [], None, False
    p = d.get('pagination') or {}
    return d['trades'], p.get('nextCursor'), bool(p.get('hasMore'))

def ts_of(t): return calendar.timegm(time.strptime(t['timestamp'][:19], '%Y-%m-%dT%H:%M:%S')) * 1000

def norm(t):
    return {'id': t['slotIndexId'], 'tx': t.get('tx'), 'ts': ts_of(t), 'u': t['userAddress'], 'ty': t['type'], 'pg': t.get('program'),
            'usd': float(t.get('amountUsd') or 0), 'sol': float(t.get('amountSol') or 0), 'base': float(t.get('baseAmount') or 0),
            'pu': float(t.get('priceUsd') or 0), 'ps': float(t.get('priceSol') or 0)}

def window(mint, end_ms, stop_ms, budget):
    """all trades with stop_ms < ts <= end_ms (paged backwards). Returns (trades, pages_used, complete)."""
    out, cur, used = [], '9999999999999999999999-%d' % end_ms, 0
    while used < budget:
        tr, nxt, more = page(mint, cur); used += 1
        if not tr: return out, used, True
        out += [norm(t) for t in tr]
        if not more or ts_of(tr[-1]) <= stop_ms or not nxt: return out, used, True
        cur = nxt
    return out, used, False

def probe(mint, at_ms):
    tr, _, _ = page(mint, '9999999999999999999999-%d' % at_ms)
    return norm(tr[0]) if tr else None

def curve_pct(price_sol_per_token):
    if not price_sol_per_token or price_sol_per_token <= 0: return None
    v_sol = math.sqrt(price_sol_per_token * 1e9 * K / 1e9) if False else math.sqrt(price_sol_per_token * K)
    sold = 1.073e9 - K / v_sol
    return max(0.0, min(100.0, 100 * sold / CURVE_TOKENS))

def ohlcv_latest(pool, tf, limit=1000):
    return gt_ohlcv(pool, tf, None, limit)

def gt_ohlcv(pool, tf, before=None, limit=1000, agg=1):
    u = f"{GT}/networks/solana/pools/{pool}/ohlcv/{tf}?aggregate={agg}&limit={limit}&currency=usd" + (f"&before_timestamp={int(before)}" if before else '')
    d = http(u, ttl=None if before and before < time.time() - 3600 else 3 * 3600)
    try: return sorted(d['data']['attributes']['ohlcv_list'])
    except Exception:
        if before and isinstance(d, dict) and d.get('_http_error') == 401:  # GT free tier refuses old before_timestamp
            return ohlcv_latest(pool, tf, limit)
        return None

def collect(mint, stratum, extra=None, page_budget=25, force=False, out_dir=None, meta=None):
    fn = os.path.join(out_dir or RAW, mint + '.json')
    if os.path.exists(fn) and not force:
        try:
            old = json.load(open(fn))
            if old.get('v') == 3 and (old.get('meta') or {}).get('complete') and old.get('post_done'): return 'cached'
            if old.get('v') == 3 and time.time() * 1000 - old.get('fetched', 0) < 4 * 3600e3: return 'fresh'
        except Exception: pass
    now = int(time.time() * 1000)
    m = meta or coin(mint)
    rec = {'v': 3, 'mint': mint, 'stratum': stratum, 'extra': extra or {}, 'fetched': now, 'meta': None, 'trades': [], 'probes': [], 'notes': []}
    if not m:
        rec['notes'].append('pump.fun coin record not found (not a pump.fun mint or delisted)'); wjson(fn, rec); return 'nometa'
    keep = ['mint', 'name', 'symbol', 'creator', 'created_timestamp', 'complete', 'pump_swap_pool', 'pool_address', 'ath_market_cap', 'ath_market_cap_timestamp',
            'usd_market_cap', 'market_cap_usd', 'total_supply', 'program', 'quote_mint', 'last_trade_timestamp', 'twitter', 'website', 'telegram', 'is_banned', 'reply_count', 'king_of_the_hill_timestamp']
    rec['meta'] = {k: m.get(k) for k in keep}
    c0 = int(m.get('created_timestamp') or 0)
    if not c0: rec['notes'].append('no created_timestamp'); wjson(fn, rec); return 'nocreated'
    if m.get('quote_mint') not in (None, '11111111111111111111111111111111', 'So11111111111111111111111111111111111111112'):
        rec['notes'].append('non-SOL quote curve; curve_pct formula not applied')
    # ---- shortcut: whole history fits in <=3 pages from now backwards (most failed launches)
    seen, trades, pages, end, grad_seen, covered_to = set(), [], 0, c0 + 20000, False, c0 - 1000
    tr, used, comp = window(mint, now + 60000, c0 - 1000, 3); pages += used
    if comp:
        trades = sorted(tr, key=lambda t: t['id']); seen = {t['id'] for t in trades}
        covered_to = now; grad_seen = any(t['pg'] and t['pg'] != 'pump' for t in trades)
        end = now + 10 ** 12  # skip forward windows
    while pages < page_budget and end <= now + 60000:
        tr, used, comp = window(mint, end, covered_to, page_budget - pages); pages += used
        new = [t for t in tr if t['id'] not in seen]
        if not comp:
            rec['dropped_partial_window'] = len(new)  # budget ran out inside a window: the window's earliest part is missing -> keep only contiguous part
            rec['notes'].append('page budget exhausted inside a window (curve sequence truncated at covered_to)'); break
        for t in new: seen.add(t['id'])
        trades += new
        covered_to = end
        if any(t['pg'] and t['pg'] != 'pump' for t in new): grad_seen = True; break
        if not trades and end - c0 > 600e3:
            rec['notes'].append('swap-api returned no trades in the first 10 min (early history not indexed)'); break
        if end - c0 >= 86400e3: break
        rate = len(new) / max(1, (end - (c0 if len(trades) == len(new) else end - 1)) / 1000) if new else 0
        span = (end - c0)
        step = max(30000, min(3600e3, int(span * 1.5))) if len(new) < 150 else max(15000, int(span * 0.5))
        end = int(min(now, end + step)) if end < now else now + 60001
    trades.sort(key=lambda t: t['id'])
    rec['trades'] = trades; rec['covered_to'] = covered_to; rec['pages'] = pages; rec['grad_in_seq'] = grad_seen
    # ---- probes at checkpoints beyond coverage
    for cp in ([] if grad_seen else CHECKPOINTS):
        at = c0 + cp * 1000
        if at <= covered_to or at > now: continue
        p = probe(mint, at)
        rec['probes'].append({'t': cp, 'tr': p})
        if p and p['pg'] != 'pump': break  # graduated before this checkpoint; post-grad arc comes from GT candles
    # ---- graduation time
    grad_ts = None
    if grad_seen:
        g = [t for t in trades if t['pg'] and t['pg'] != 'pump']
        cv = [t for t in trades if t['pg'] == 'pump']
        grad_ts = (max(t['ts'] for t in cv) if cv else g[0]['ts'])
        rec['grad_res'] = 'trade sequence'
    elif m.get('complete'):
        lo, hi = covered_to, None
        for p in rec['probes']:
            if p['tr'] and p['tr']['pg'] != 'pump': hi = c0 + p['t'] * 1000; break
            if p['tr']: lo = c0 + p['t'] * 1000
        if hi is None:  # graduated after the last probe (or within 24h) -> probe now
            hi = now
        it = 0
        while hi - lo > max(60000, (hi - lo) * 0 + 60000) and it < 14:
            mid = (lo + hi) // 2; p = probe(mint, mid); it += 1
            if p is None or p['pg'] == 'pump': lo = mid
            else: hi = mid
        grad_ts = hi; rec['grad_res'] = f'binary search ±{round((hi - lo) / 1000)}s'
    rec['grad_ts'] = grad_ts
    # ---- post-graduation candles (PumpSwap pool)
    pool = m.get('pump_swap_pool') or (m.get('pool_address') if m.get('complete') else None)
    rec['pool'] = pool
    if pool and grad_ts:
        hb = grad_ts / 1000 + 1000 * 3600
        # GT quota (30/min shared by all collectors): hourly candles only where a $1M-scale run is plausible
        rec['h1'] = gt_ohlcv(pool, 'hour', before=hb if hb < now / 1000 else None) if (m.get('ath_market_cap') or 0) >= 3e5 else None
        rec['d1'] = gt_ohlcv(pool, 'day')
        rec['m1'] = None  # minute candles skipped (trade sequence covers the early arc; saves GT quota)
        rec['post_done'] = bool(rec['h1'] or rec['d1'])
    wjson(fn, rec)
    return f'ok trades={len(trades)} pages={pages} grad={"y" if grad_ts else "n"}'

def targets(nrand):
    T = {}
    db = sqlite3.connect(os.path.join(DATA, 'moonshot.db'))
    for mint, cohort, peak in db.execute("select mint, cohort, peak_mcap from tokens where launchpad='pump.fun'"):
        T[mint] = ('screener_db', {'cohort': cohort, 'db_peak': peak})
    cat = json.load(open(os.path.join(DATA, 'crash_catalog_final.json')))
    for t in cat.get('eco_tokens_ranked', []):
        if t['chain'] == 'solana' and t['address'].endswith('pump'):
            st = 'catalog_crash' if (t.get('crash_depth_pct') or 0) <= -70 else 'catalog_runner'
            T[t['address']] = (st, {'catalog_peak': t.get('peak_mcap'), 'crash_depth_pct': t.get('crash_depth_pct'), 'pads': t.get('pads')})
    ex = json.load(open(os.path.join(DATA, 'launchpad_extra.json')))
    for t in ex.get('tokens', []):
        if t['chain'] == 'solana' and ('pump' in t['pad']) and t['address'] not in T:
            T[t['address']] = ('pad_active_sample', {'pad': t['pad']})
    # random sample: uniform draws from pump.fun create transactions at ~100 historical anchor times
    # (built by random_pump_hist.py from the pump mint-authority account's signature history)
    rnd_file = os.path.join(BP, 'cache', 'pump_random_hist.json')
    R = json.load(open(rnd_file)) if os.path.exists(rnd_file) else []
    if nrand: R = R[:nrand]
    for r in R:
        T[r['mint']] = ('random', {'anchor_ts': r.get('anchor_ts'), 'create_ts': r.get('ts')})
    gf = os.path.join(BP, 'cache', 'pump_random_grads.json')
    for r in (json.load(open(gf)) if os.path.exists(gf) else []):
        if r.get('mint') and r['mint'] not in T: T[r['mint']] = ('random_graduates', {'grad_ts_sampled': r.get('grad_ts')})
    return T

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--random', type=int, default=0); ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--workers', type=int, default=3); ap.add_argument('--only', default=''); ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    T = targets(a.random)
    items = list(T.items())
    if a.only: items = [x for x in items if x[1][0] == a.only]
    random.seed(7); random.shuffle(items)
    # priority: catalog first, then random, then screener db, then active
    pr = {'catalog_runner': 0, 'catalog_crash': 0, 'random': 1, 'random_graduates': 1, 'screener_db': 2, 'pad_active_sample': 3}
    items.sort(key=lambda x: pr.get(x[1][0], 9))
    if a.limit: items = items[:a.limit]
    print(f'{len(items)} targets', flush=True)
    t0 = time.time(); n = 0
    with cf.ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(collect, mint, st, extra, 25, a.force): mint for mint, (st, extra) in items}
        for f in cf.as_completed(futs):
            n += 1
            try: r = f.result()
            except Exception as e: r = 'ERR ' + str(e)[:120]
            print(f'[{n}/{len(items)} {int(time.time() - t0)}s] {futs[f][:8]} {r}', flush=True)
