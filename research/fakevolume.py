#!/usr/bin/env python3
"""Fake-volume detector research (free data only; no Nansen, no X). Scoring lives in lib/fakevolume.js (single implementation);
this script collects trade-level data and runs the backtests.

A) POINT-IN-TIME backtest (Solana, pump.fun): for research-DB tokens (data/moonshot.db) in cohort 'died' (crash/rug: now <=10% of
   peak & illiquid, or RugCheck-rugged) vs 'mooned' (>=100x launch->peak = runners), parse the LAST N bonding-curve swaps before
   graduation from Solana public RPC (getSignaturesForAddress on the bonding-curve PDA + getTransaction jsonParsed). Trades are
   measured before the outcome. Token transfers between non-pool wallets inside those txs add graph edges (circular-loop detection).
B) CROSS-SECTIONAL association on the crash catalog (data/crash_catalog_final.json eco_tokens_ranked): tokens now >=80% below peak
   ('crashed') vs within 30% of peak ('runners'), current GeckoTerminal trades + Jupiter organic score. Contemporaneous, NOT predictive.
Usage: fakevolume.py backtest [n_per_cohort] [trades_per_token] | catalog | all
Outputs data/fakevolume_backtest.json (+ data/fakevolume_trades/*.json cache)."""
import calendar, hashlib, json, math, os, random, sqlite3, subprocess, sys, time, threading
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from patterns_common import http, log, DATA_DIR, ROOT, DB, mwu, COUNTS, GAPS
GAPS['swap-api.pump.fun'] = 0.5

CACHE = os.path.join(DATA_DIR, 'fakevolume_cache'); os.makedirs(CACHE, exist_ok=True)
OLD_TX = os.path.join(DATA_DIR, 'patterns_cache', 'sol_tx')
RPC = os.environ.get('FAKEVOL_RPC_URL') or 'https://api.mainnet-beta.solana.com'  # publicnode is not archival for old curves
PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
WSOL = 'So11111111111111111111111111111111111111112'

# ---------- base58 + PDA (pump.fun bonding curve = PDA(["bonding-curve", mint], PUMP)) ----------
B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58d(s):
    n = 0
    for c in s: n = n * 58 + B58.index(c)
    b = n.to_bytes((n.bit_length() + 7) // 8, 'big') if n else b''
    return b'\x00' * (len(s) - len(s.lstrip('1'))) + b
def b58e(b):
    n = int.from_bytes(b, 'big'); s = ''
    while n: n, r = divmod(n, 58); s = B58[r] + s
    return '1' * (len(b) - len(b.lstrip(b'\x00'))) + s
P_ = 2 ** 255 - 19; D_ = (-121665 * pow(121666, P_ - 2, P_)) % P_
def on_curve(b):
    y = int.from_bytes(b, 'little') & ((1 << 255) - 1)
    if y >= P_: return False
    u = (y * y - 1) % P_; v = (D_ * y * y + 1) % P_
    x2 = u * pow(v, P_ - 2, P_) % P_
    if x2 == 0: return True
    return pow(x2, (P_ - 1) // 2, P_) == 1
def pda(seeds, program):
    pb = b58d(program)
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b''.join(seeds) + bytes([bump]) + pb + b'ProgramDerivedAddress').digest()
        if not on_curve(h): return b58e(h)
    return None

def rpc(method, params):
    for i in range(8):
        j = http(RPC, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})
        if j is None: return None
        if 'error' in j:
            m = str(j['error'])
            if '429' in m or 'Too many' in m or j['error'].get('code') in (-32005, 429): time.sleep(2 * (i + 1)); continue
            raise RuntimeError(method + ': ' + m)
        return j['result']
    raise RuntimeError(method + ' rate limited')

def tx(sig):
    for d in (os.path.join(CACHE, 'tx'), OLD_TX):
        f = os.path.join(d, sig + '.json')
        if os.path.exists(f):
            try: return json.load(open(f))
            except Exception: pass
    v = rpc('getTransaction', [sig, {'encoding': 'jsonParsed', 'maxSupportedTransactionVersion': 1}])
    if v is not None:
        os.makedirs(os.path.join(CACHE, 'tx'), exist_ok=True); json.dump(v, open(os.path.join(CACHE, 'tx', sig + '.json'), 'w'))
    return v

def parse_trade(t, mint, curve):
    """Swap on the bonding curve -> {t, trader, side, amt, q (SOL), tx} + transfer edges between non-curve wallets."""
    if not t or (t.get('meta') or {}).get('err'): return None, []
    m = t['meta']; keys = [k['pubkey'] if isinstance(k, dict) else k for k in t['transaction']['message']['accountKeys']]
    signer = keys[0]
    def bal(arr):
        out = {}
        for b in arr or []:
            if b.get('mint') != mint: continue
            out[b['accountIndex']] = (b.get('owner'), float(b['uiTokenAmount'].get('uiAmount') or 0))
        return out
    pre, post = bal(m.get('preTokenBalances')), bal(m.get('postTokenBalances'))
    own = {i: (post.get(i) or pre.get(i))[0] for i in set(pre) | set(post)}
    delta = {}
    for i in set(pre) | set(post): delta[own[i]] = delta.get(own[i], 0) + (post.get(i, (0, 0))[1] - pre.get(i, (0, 0))[1])
    if abs(delta.get(curve, 0)) <= 0: return None, []  # curve token balance unchanged -> not a curve swap
    d = delta.get(signer, 0)
    trader = signer
    if abs(d) <= 0:  # routed: the counterparty is the largest opposite non-curve delta
        cands = [(o, v) for o, v in delta.items() if o != curve and v * delta[curve] < 0]
        if not cands: return None, []
        trader, d = max(cands, key=lambda x: abs(x[1]))
    sol = 0.0
    try:
        i0 = keys.index(trader); sol = (m['postBalances'][i0] - m['preBalances'][i0] + (m['fee'] if i0 == 0 else 0)) / 1e9
    except ValueError: pass
    for b in m.get('postTokenBalances') or []:  # wSOL legs
        if b.get('mint') == WSOL and b.get('owner') == trader:
            pv = next((float(x['uiTokenAmount'].get('uiAmount') or 0) for x in m.get('preTokenBalances') or [] if x['accountIndex'] == b['accountIndex']), 0)
            sol += float(b['uiTokenAmount'].get('uiAmount') or 0) - pv
    edges = []
    acct_owner = {keys[i]: o for i, o in own.items() if i < len(keys)}
    ins = list(t['transaction']['message'].get('instructions') or [])
    for g in m.get('innerInstructions') or []: ins += g.get('instructions') or []
    for x in ins:
        p = x.get('parsed') if isinstance(x, dict) else None
        if not isinstance(p, dict) or p.get('type') not in ('transfer', 'transferChecked'): continue
        inf = p.get('info') or {}
        a, b = acct_owner.get(inf.get('source')), acct_owner.get(inf.get('destination'))
        if a and b and a != b and curve not in (a, b): edges.append({'from': a, 'to': b})
    return {'t': t.get('blockTime'), 'trader': trader, 'side': 'buy' if d > 0 else 'sell', 'amt': abs(d), 'q': abs(sol), 'tx': t['transaction']['signatures'][0]}, edges

def gt_pool_created(pool):
    f = os.path.join(CACHE, 'gtpool_' + pool + '.json')
    if os.path.exists(f): return json.load(open(f))
    j = http(f'https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}')
    v = {'created': (j or {}).get('data', {}).get('attributes', {}).get('pool_created_at')}
    json.dump(v, open(f, 'w')); return v

SOLPX = {}
def sol_price(ts):
    """Daily SOL/USD close (CoinGecko free market_chart, 365d) — only used to express SOL sizes in USD for the $1 dust rule."""
    if not SOLPX:
        f = os.path.join(CACHE, 'sol_px.json')
        if os.path.exists(f) and time.time() - os.path.getmtime(f) < 86400: SOLPX.update(json.load(open(f)))
        else:
            j = http('https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=365&interval=daily') or {}
            for t, p in j.get('prices', []): SOLPX[str(int(t // 86400000))] = p
            json.dump(SOLPX, open(f, 'w'))
    d = int(ts // 86400)
    for k in range(0, 10):
        if str(d - k) in SOLPX: return SOLPX[str(d - k)]
    return 150.0

PUMPAPI = 'https://swap-api.pump.fun/v2/coins/{mint}/trades?limit=100&cursor={cur}&minSolAmount=0'
def pump_page(mint, cur):
    return http(PUMPAPI.format(mint=mint, cur=cur)) or {}

def pump_trade(x):
    return {'t': int(calendar.timegm(time.strptime(x['timestamp'][:19], '%Y-%m-%dT%H:%M:%S'))), 'trader': x['userAddress'], 'side': x['type'],
            'amt': float(x.get('baseAmount') or 0), 'q': float(x.get('quoteAmount') or x.get('amountSol') or 0), 'usd': float(x.get('amountUsd') or 0), 'tx': x['tx'], 'program': x.get('program'), 'id': x['tx'] + x.get('slotIndexId', '')}

def window_before(mint, t_end, n):
    """n trades at or before t_end (newest first from the API), returned chronological."""
    out, cur = [], f'9999999999999999999999-{int(t_end) * 1000 + 999}'
    while len(out) < n:
        j = pump_page(mint, cur); tr = j.get('trades') or []
        out += [pump_trade(x) for x in tr]
        cur = (j.get('pagination') or {}).get('nextCursor')
        if not tr or not cur or not (j.get('pagination') or {}).get('hasMore'): break
    return sorted(out[:n], key=lambda x: x['t'])

def collect_range(mint, a, b, cap=2000):
    """all trades with a < t <= b (paging backwards from b)."""
    out, cur = {}, f'9999999999999999999999-{int(b) * 1000 + 999}'
    while len(out) < cap:
        j = pump_page(mint, cur); tr = [pump_trade(x) for x in j.get('trades') or []]
        for x in tr:
            if a < x['t'] <= b: out[x['id']] = x
        cur = (j.get('pagination') or {}).get('nextCursor')
        if not tr or min(x['t'] for x in tr) <= a or not cur or not (j.get('pagination') or {}).get('hasMore'): break
    return list(out.values())

def window_after(mint, t_start, n, step=120, max_span=7 * 86400):
    """first ~n trades after t_start: consecutive forward segments, each collected by paging backwards to its lower bound."""
    got, lo = [], t_start
    while len(got) < n and lo - t_start < max_span:
        hi = lo + step
        seg = collect_range(mint, lo, hi, cap=n * 2)
        got += seg; lo = hi
        rate = len(seg) / step if seg else 0
        step = int(min(86400, max(60, ((n - len(got)) / rate * 1.2) if rate > 0 else step * 4)))
    return sorted(got, key=lambda x: x['t'])[:n]

def newest_program(mint, t):
    j = pump_page(mint, f'9999999999999999999999-{int(t) * 1000 + 999}'); tr = j.get('trades') or []
    return (tr[0].get('program'), pump_trade(tr[0])['t']) if tr else (None, None)

def find_grad(mint, lo, hi):
    """last bonding-curve ('pump') trade time: binary search on the time cursor (API pages backwards from any timestamp)."""
    p, t0 = newest_program(mint, hi)
    if p == 'pump': return t0
    for _ in range(26):
        if hi - lo <= 30: break
        mid = (lo + hi) // 2; p, t = newest_program(mint, mid)
        if p == 'pump' or p is None: lo = max(mid, t or mid)  # None = no trades yet at mid -> boundary is later
        else: hi = mid
    p, t = newest_program(mint, lo)
    return t if p == 'pump' else None

def collect_token(row, ntr):
    mint, sym, coh, cts, curve_db, main_pool, peak_ts, curve_secs = row
    f = os.path.join(CACHE, 'trades', f'{mint}_{ntr}_v5.json')
    if os.path.exists(f): return json.load(open(f))
    hi = None
    if main_pool:
        c = gt_pool_created(main_pool).get('created')
        if c: hi = calendar.timegm(time.strptime(c[:19], '%Y-%m-%dT%H:%M:%S')) + 5
    lo = cts // 1000 if cts else None
    if not hi and lo and curve_secs is not None: hi = int(lo + curve_secs + 5)
    if not hi or not lo: raise RuntimeError('no launch/graduation time')
    grad = find_grad(mint, lo, max(hi, lo + 60)); no_curve = not grad
    if no_curve: grad = hi - 6  # no bonding-curve trades in the API (direct AMM launch): AMM window starts at pool creation
    pre = []; cur_t = grad
    for _ in range(0 if no_curve else 8):
        w = window_before(mint, cur_t, 100)
        pre = {x['id']: x for x in pre + [x for x in w if x['program'] == 'pump']}.values(); pre = list(pre)
        if len(pre) >= ntr or not w or len(w) < 100: break
        cur_t = min(x['t'] for x in w)
    pre = sorted(pre, key=lambda x: x['t'])[-ntr:]
    post = [x for x in window_after(mint, grad, ntr) if x['program'] == 'pump_amm'][:ntr]
    h1 = [x for x in window_after(mint, grad + 3600, ntr) if x['program'] == 'pump_amm'][:ntr]
    pk = peak_ts // 1000 + 3600 if peak_ts else None  # hourly-candle peak: count trades after the END of the peak hour
    out = {'mint': mint, 'symbol': sym, 'cohort': coh, 'grad_ts': grad, 'no_curve': no_curve, 'gt_pool_created': hi - 5 if main_pool else None, 'peak_hour_end_ts': pk, 'created_ts': lo,
           'curve_end': pre, 'amm_start': post, 'amm_1h': h1, 'transfers': [],
           'after_peak_share': {'curve_end': round(sum(1 for x in pre if pk and x['t'] > pk) / len(pre), 3) if pre else None,
                                'amm_start': round(sum(1 for x in post if pk and x['t'] > pk) / len(post), 3) if post else None,
                                'amm_1h': round(sum(1 for x in h1 if pk and x['t'] > pk) / len(h1), 3) if h1 else None}}
    os.makedirs(os.path.dirname(f), exist_ok=True); json.dump(out, open(f, 'w'))
    return out

def node_score(items):
    inp, outp = os.path.join(CACHE, 'score_in.json'), os.path.join(CACHE, 'score_out.json')
    json.dump(items, open(inp, 'w'))
    subprocess.run(['node', os.path.join(ROOT, 'lib', 'fakevolume.js'), 'score', inp, outp], check=True)
    return json.load(open(outp))

# ---------- stats ----------
def fisher(a, b, c, d):
    """2x2 [[a,b],[c,d]] two-sided Fisher exact p + Haldane-corrected odds ratio and 95% CI (Woolf)."""
    n = a + b + c + d; r1, c1 = a + b, a + c
    def hp(x): return math.comb(c1, x) * math.comb(n - c1, r1 - x) / math.comb(n, r1)
    p0 = hp(a); p = sum(hp(x) for x in range(max(0, r1 + c1 - n), min(r1, c1) + 1) if hp(x) <= p0 * (1 + 1e-9))
    A, B, C, D = a + .5, b + .5, c + .5, d + .5; orr = A * D / (B * C); se = math.sqrt(1 / A + 1 / B + 1 / C + 1 / D)
    return {'odds_ratio': round(orr, 2), 'ci95': [round(math.exp(math.log(orr) - 1.96 * se), 2), round(math.exp(math.log(orr) + 1.96 * se), 2)], 'p_fisher': round(min(1, p), 4)}

def tests(rows, pos, neg, label_pos, label_neg):
    P_ = [r for r in rows if r['cohort'] in pos]; N_ = [r for r in rows if r['cohort'] in neg]
    out = {'n_' + label_pos: len(P_), 'n_' + label_neg: len(N_), 'rules': [], 'continuous': {}}
    feats = ['score', 'fake_share_estimate', 'round_trip_share', 'same_size_share', 'ring_share', 'ring_count', 'top_share', 'trades_per_trader', 'dust_count_share', 'jup_organic_score']
    for k in feats:
        a = [r[k] for r in P_ if r.get(k) is not None]; b = [r[k] for r in N_ if r.get(k) is not None]
        if len(a) >= 5 and len(b) >= 5:
            mw = mwu(a, b); med = lambda v: sorted(v)[len(v) // 2]
            out['continuous'][k] = {'median_' + label_pos: round(med(a), 3), 'median_' + label_neg: round(med(b), 3), 'auc_' + label_pos + '_higher': mw['auc'], 'p_mwu': round(mw['p'], 4) if mw['p'] is not None else None, 'n': [len(a), len(b)]}
    rules = [('score>=60 (high)', lambda r: r.get('score', 0) >= 60), ('score>=35 (elevated+)', lambda r: r.get('score', 0) >= 35),
             ('fake_share>=30%', lambda r: (r.get('fake_share_estimate') or 0) >= 0.3), ('round_trip_share>=10%', lambda r: (r.get('round_trip_share') or 0) >= 0.10),
             ('any wallet ring', lambda r: (r.get('ring_count') or 0) > 0), ('same_size_share>=25%', lambda r: (r.get('same_size_share') or 0) >= 0.25),
             ('top5 wallets>=50% of volume', lambda r: (r.get('top_share') or 0) >= 0.5)]
    for name, fn in rules:
        a = sum(1 for r in P_ if fn(r)); b = len(P_) - a; c = sum(1 for r in N_ if fn(r)); d = len(N_) - c
        if not P_ or not N_: continue
        f = fisher(a, b, c, d)
        out['rules'].append({'rule': name, f'{label_pos}_flagged': f'{a}/{len(P_)}', f'{label_neg}_flagged': f'{c}/{len(N_)}', f'rate_{label_pos}': round(a / len(P_), 3), f'rate_{label_neg}': round(c / len(N_), 3), **f})
    return out

def backtest(nper=100, ntr=300):
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    rows = db.execute("select mint,symbol,cohort,created_ts,curve_pool,main_pool,peak_ts,curve_secs from tokens where chain='solana' and launchpad='pump.fun' and cohort in ('died','mooned','middle')").fetchall()
    random.seed(11); sel = []
    for c in ('mooned', 'died', 'middle'):
        g = [r for r in rows if r[2] == c]; random.shuffle(g); sel += g[:nper]
    res = []
    for i, r in enumerate(sel):
        try: d = collect_token(r, ntr)
        except Exception as e: log('token err', r[1], str(e)[:120]); continue
        res.append(d); log(i, r[1], r[2], 'curve', len(d['curve_end']), 'amm', len(d['amm_start']))
    out = {}
    for w in ('curve_end', 'amm_start', 'amm_1h'):
        sc = node_score([{'key': d['mint'], 'trades': d[w]} for d in res])
        rows_w = []
        for d, s in zip(res, sc):
            if not s.get('ok'): continue
            rows_w.append({'mint': d['mint'], 'symbol': d['symbol'], 'cohort': d['cohort'], 'n_trades': s['n_trades'], 'after_peak_share': d['after_peak_share'][w],
                           **{k: s.get(k) for k in ('score', 'level', 'fake_share_estimate', 'round_trip_share', 'same_size_share', 'ring_share', 'ring_count', 'top_share', 'trades_per_trader', 'dust_count_share', 'n_traders')},
                           'reasons': [x['key'] for x in s.get('reasons', [])]})
        ap = [x['after_peak_share'] for x in rows_w if x['cohort'] == 'died' and x['after_peak_share'] is not None]
        out[w] = {'scored': len(rows_w), 'died_window_after_peak_mean_share': round(sum(ap) / len(ap), 3) if ap else None,
                  'tests_died_vs_mooned': tests(rows_w, ('died',), ('mooned',), 'died', 'mooned'),
                  'tests_died_vs_survivors': tests(rows_w, ('died',), ('mooned', 'middle'), 'died', 'survivor'),
                  'tokens': rows_w}
    return {'design': f'point-in-time: {ntr} bonding-curve swaps ending at graduation ("curve_end") the first {ntr} PumpSwap AMM swaps after graduation ("amm_start") and the first {ntr} AMM swaps starting 1h after graduation ("amm_1h"), from the free pump.fun swap API (same data as on-chain swaps: wallet, side, SOL, token amount); outcome (cohort) measured afterwards',
            'cohorts': {'died': 'research DB: now <=10% of peak and liquidity <$10k or mcap <$50k, or RugCheck rugged, or never >2x and <$10k mcap after 3 days (crash/rug)', 'mooned': '>=100x launch->peak (runners)', 'middle': 'neither (survivor reference)'},
            'requested_per_cohort': nper, 'collected': len(res), 'by_cohort': {c: sum(1 for d in res if d['cohort'] == c) for c in ('died', 'mooned', 'middle')}, 'windows': out,
            'caveat': 'Many died tokens peak within ~1h of launch, so part of the amm_start window can fall after their peak (see died_window_after_peak_mean_share); curve_end is always pre-graduation.'}

def catalog():
    d = json.load(open(os.path.join(DATA_DIR, 'crash_catalog_final.json')))
    sel = []
    for x in d['eco_tokens_ranked']:
        cd = x.get('crash_depth_pct')
        if x['chain'] not in ('solana', 'base', 'bsc', 'robinhood', 'ethereum') or cd is None: continue
        coh = 'crashed' if cd <= -80 else 'runner' if cd > -30 else None
        if coh: sel.append((x, coh))
    out = []
    for i, (x, coh) in enumerate(sel):
        f = os.path.join(CACHE, 'catalog', f"{x['chain']}_{x['address']}.json")
        r = None
        if os.path.exists(f) and time.time() - os.path.getmtime(f) < 12 * 3600: r = json.load(open(f))
        else:
            try:
                p = subprocess.run(['node', os.path.join(ROOT, 'lib', 'fakevolume.js'), 'token', x['chain'], x['address']], capture_output=True, text=True, timeout=120)
                r = json.loads(p.stdout); os.makedirs(os.path.dirname(f), exist_ok=True); json.dump(r, open(f, 'w'))
            except Exception as e: log('catalog err', x['symbol'], str(e)[:100])
            time.sleep(2.5)
        if not r or r.get('score') is None or not r.get('ok'): continue
        out.append({'symbol': x['symbol'], 'chain': x['chain'], 'address': x['address'], 'cohort': coh, 'crash_depth_pct': round(x['crash_depth_pct'], 1), 'peak_date': x.get('peak_date'),
                    **{k: r.get(k) for k in ('score', 'level', 'fake_share_estimate', 'round_trip_share', 'same_size_share', 'ring_share', 'ring_count', 'top_share', 'trades_per_trader', 'dust_count_share', 'jup_organic_score', 'vol_liq', 'n_trades')}})
        log(i, x['symbol'], coh, r.get('score'))
    return {'design': 'cross-sectional, CURRENT trades (GeckoTerminal last <=300 swaps + Jupiter organic) vs catalog state; association only, not a forecast (fake volume measured after the crash/run)',
            'cohorts': {'crashed': 'catalog token now <=-80% from confirmed peak', 'runner': 'within 30% of confirmed peak'}, 'n': len(out),
            'tests': tests(out, ('crashed',), ('runner',), 'crashed', 'runner'), 'by_chain': {c: sum(1 for r in out if r['chain'] == c) for c in set(r['chain'] for r in out)}, 'tokens': out}

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'all'
    path = os.path.join(DATA_DIR, 'fakevolume_backtest.json')
    res = json.load(open(path)) if os.path.exists(path) else {}
    if cmd in ('backtest', 'all'):
        res['point_in_time_solana'] = backtest(int(sys.argv[2]) if len(sys.argv) > 2 else 100, int(sys.argv[3]) if len(sys.argv) > 3 else 300)
    if cmd in ('catalog', 'all'):
        res['catalog_cross_section'] = catalog()
    W = (res.get('point_in_time_solana') or {}).get('windows', {})
    best = [dict(r, window=w) for w in ('curve_end', 'amm_start', 'amm_1h') for r in (W.get(w, {}).get('tests_died_vs_mooned', {}).get('rules', [])) if r['p_fisher'] < 0.05 and r['odds_ratio'] > 1]
    res['composite_policy'] = {'cap_supported': bool([r for r in best if r['rule'].startswith('score>=')]),
                               'note': ('Backtest support: ' + '; '.join(f"{r['window']} {r['rule']}: crash/rug OR {r['odds_ratio']} (p={r['p_fisher']})" for r in best)) if best else 'Point-in-time backtest did not show a significant crash/rug lift for the score, so it is used as a light risk factor with no grade cap.'}
    def _r(w, rule):
        for r in (W.get(w, {}).get('tests_died_vs_mooned', {}).get('rules', [])):
            if r['rule'] == rule: return r
    ra, rc = _r('amm_start', 'score>=35 (elevated+)'), _r('curve_end', 'score>=35 (elevated+)')
    cs = (res.get('catalog_cross_section') or {}).get('tests', {}).get('continuous', {}).get('score', {})
    res['composite_policy']['short'] = ('Backtest (pump.fun, measured before the outcome): score>=35 at graduation flagged '
        + (f"{ra['died_flagged']} crash/rug vs {ra['mooned_flagged']} runners (OR {ra['odds_ratio']})" if ra else 'n/a')
        + (f"; bonding-curve end {rc['died_flagged']} vs {rc['mooned_flagged']} (OR {rc['odds_ratio']})" if rc else '')
        + ('. On mature catalog tokens the CURRENT score does not separate crashed from runners' + (f" (AUC {cs.get('auc_crashed_higher')})" if cs else '') + ', so it is a young-token signal.' if res.get('catalog_cross_section') else '.'))
    res['billing'] = {'hosts': dict(COUNTS), 'nansen_calls': 0, 'x_calls': 0}
    res['generatedAt'] = int(time.time() * 1000)
    try: cur = json.load(open(path)); res = {**cur, **{k: v for k, v in res.items() if v is not None}}  # merge: backtest and catalog can run in separate processes
    except Exception: pass
    json.dump(res, open(path + '.tmp', 'w'), default=str); os.replace(path + '.tmp', path); log('wrote', path)

if __name__ == '__main__': main()
