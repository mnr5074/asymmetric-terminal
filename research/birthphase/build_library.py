"""Build the unified cross-launchpad birth-phase library from the raw caches:
  data/birthphase/<launchpad>.jsonl   one schema.json record per launch
  data/birthphase/coverage.json       per-launchpad coverage (full / partial / outcome-only / failed + reasons)
Also merges any records written by other workers in the same schema (e.g. virtuals.jsonl) when computing
repeat-early-buyer sets. Never fills a value it did not measure (null + coverage.missing reason instead)."""
import sys, os, json, glob, time, math, sqlite3, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bp_common import BP, DATA, CHECKPOINTS, THRESH, short, gini, q, wjsonl, wjson, rjsonl
RAWD = os.path.join(BP, 'cache', 'raw')
NOW = int(time.time() * 1000)
AGES = json.load(open(os.path.join(BP, 'cache', 'wallet_ages.json'))) if os.path.exists(os.path.join(BP, 'cache', 'wallet_ages.json')) else {}
SNAP_AGES = [60, 300, 900, 1800, 3600, 10800]
FRESH_D = 7.0
OWN_PADS = None  # filled in main: pads this builder writes

def fake_set():
    s = {}
    try:
        db = sqlite3.connect(os.path.join(DATA, 'moonshot.db'))
        for m, c, ql in db.execute("select mint, cohort, quality from tokens"):
            if c == 'suspect_fake': s[m] = ql
    except Exception: pass
    return s
FAKE = fake_set()

def wage(full, buy_ts):
    a = AGES.get(full)
    if not a or a.get('err') or not a.get('first_ts'): return None, None, None
    if a['exact']:
        d = (buy_ts - a['first_ts']) / 86400e3
        return round(max(0.0, d), 3), 'exact', d <= FRESH_D
    if a['first_ts'] <= buy_ts:  # history longer than page cap but already older than X at the buy
        d = (buy_ts - a['first_ts']) / 86400e3
        return round(d, 3), 'lower_bound', (False if d > FRESH_D else None)
    return None, 'unresolved_high_activity', None

def milestones(series, c0, res):
    """series: sorted [(ts_ms, mcap)] robust points. returns post dict"""
    out = {'peak_mcap': None, 'peak_ts': None, 't_to_100k_s': None, 't_to_1m_s': None, 't_to_10m_s': None, 'max_dd_from_peak_pct': None, 'now_mcap': None, 'resolution': res}
    pts = [(t, m) for t, m in series if m and m > 0]
    if not pts: return out
    pk = max(pts, key=lambda x: x[1]); out['peak_mcap'] = round(pk[1], 2); out['peak_ts'] = pk[0]
    for th, k in zip(THRESH, ['t_to_100k_s', 't_to_1m_s', 't_to_10m_s']):
        hit = next((t for t, m in pts if m >= th), None)
        out[k] = max(0, round((hit - c0) / 1000)) if hit else None  # hourly candle starts can precede creation
    out['now_mcap'] = round(pts[-1][1], 2)
    out['max_dd_from_peak_pct'] = round(100 * (min([m for t, m in pts if t >= pk[0]]) / pk[1] - 1), 1)
    return out

def robust_trade_points(trades, supply=1e9):
    """3-trade rolling minimum of trade-implied mcap (kills single-print wicks)."""
    px = [(t['ts'], t['pu'] * supply) for t in trades if t.get('pu')]
    return [(px[i][0], min(px[i - 2][1], px[i - 1][1], px[i][1])) for i in range(2, len(px))]

def candle_points(c, supply, field=4):
    if not c or not supply: return []
    return [(int(x[0]) * 1000, float(x[field]) * supply) for x in c if x[field]]

def label(post, observed_s, fake_note=None):
    o = {'reached_100k': None, 'reached_1m': None, 'reached_10m': None, 'label_note': None}
    if fake_note:
        o['label_note'] = 'excluded: ' + fake_note; return o
    pk = post.get('peak_mcap') if post else None
    if pk is None: o['label_note'] = 'no price history'; return o
    for th, k in zip(THRESH, ['reached_100k', 'reached_1m', 'reached_10m']):
        if pk >= th: o[k] = True
        elif observed_s >= 2 * 86400: o[k] = False
        else: o[k] = None
    if observed_s < 2 * 86400: o['label_note'] = 'observed < 48h: negatives censored'
    return o

def base_rec(chain, addr, pad, mech, stratum, c0):
    return {'schema_version': '1.0', 'key': f'{chain}:{addr.lower() if chain != "solana" else addr}', 'chain': chain, 'address': addr, 'symbol': None, 'name': None,
            'launchpad': pad, 'launch_mechanism': mech, 'sample_stratum': stratum, 'sources': [], 'creator': None, 'created_ts': c0, 'first_buy_ts': None,
            'graduation_ts': None, 'phase': 'unknown', 'observed_until_ts': NOW, 'first_buyers': [], 'dev_buy': None, 'presale': None, 'features': {},
            'trajectory': [], 'post': None, 'outcome': {}, 'coverage': {'level': 'failed', 'missing': []}, 'ext': {}}

# ------------------------------------------------------------------ pump.fun
def build_pump(d):
    m = d.get('meta')
    if not m or not m.get('created_timestamp'):
        r = base_rec('solana', d['mint'], 'pump.fun', 'bonding_curve', d.get('stratum'), None)
        r['coverage'] = {'level': 'failed', 'missing': d.get('notes') or ['no pump.fun coin record']}; r['created_ts'] = 0; return r
    c0 = int(m['created_timestamp']); cr = m.get('creator')
    r = base_rec('solana', d['mint'], 'pump.fun', 'bonding_curve', d.get('stratum'), c0)
    r.update(symbol=m.get('symbol'), name=m.get('name'), creator=short(cr), sources=['pump.fun coins-v2', 'swap-api.pump.fun trades', 'GeckoTerminal OHLCV'])
    trades = d.get('trades') or []; cov_to = d.get('covered_to') or c0
    curve = [t for t in trades if t['pg'] == 'pump']
    grad = d.get('grad_ts'); r['graduation_ts'] = grad
    r['phase'] = 'graduated' if grad else ('not_graduated' if NOW - c0 > 86400e3 or not m.get('complete') else 'pre_launch')
    if not grad and NOW - c0 < 6 * 3600e3: r['phase'] = 'pre_launch'
    miss = list(d.get('notes') or [])
    full_curve = bool(d.get('grad_in_seq')) or bool(grad and cov_to >= grad) or (not grad and cov_to >= min(NOW - 120e3, c0 + 86400e3 - 1000))  # birth phase of a non-graduate = its first 24h
    buys = [t for t in curve if t['ty'] == 'buy']
    # first buyers
    fb = []
    for t in buys[:100]:
        a, note, fr = wage(t['u'], t['ts']) if t['u'] != cr else (None, None, None)
        fb.append({'w': short(t['u']), 'ts': t['ts'], 'dt_s': round((t['ts'] - c0) / 1000, 1), 'usd': round(t['usd'], 2), 'quote': round(t['sol'], 6), 'quote_sym': 'SOL',
                   'kind': 'dev_buy' if t['u'] == cr else 'buy', 'wallet_age_d': a, 'wallet_age_note': note, 'fresh': fr, '_base': t['base']})
    r['first_buyers'] = [{k: v for k, v in x.items() if k != '_base'} for x in fb]
    devb = [t for t in buys if t['u'] == cr and t['ts'] - c0 <= 5000]
    if buys or curve:
        r['dev_buy'] = {'usd': round(sum(t['usd'] for t in devb), 2), 'quote': round(sum(t['sol'] for t in devb), 6), 'pct_supply': round(100 * sum(t['base'] for t in devb) / 1e9, 3)}
    nd = [t for t in buys if t['u'] != cr]
    r['first_buy_ts'] = nd[0]['ts'] if nd else None
    # features over the curve phase (only the contiguous covered part)
    f = feat_pump(curve, cr, c0, grad, full_curve, fb)
    r['features'] = f
    # trajectory + snapshots
    traj, snaps = [], {}
    probes = {p['t']: p['tr'] for p in d.get('probes') or [] if p.get('tr')}
    h1 = candle_points(d.get('h1'), 1e9); d1 = candle_points(d.get('d1'), 1e9)
    for cp in CHECKPOINTS:
        at = c0 + cp * 1000
        if at > NOW: break
        pt = {'t': cp, 'mcap': None, 'curve_pct': None, 'n_trades': None, 'n_buyers': None, 'vol_usd': None, 'phase': None}
        if at <= cov_to and trades:
            upto = [t for t in trades if t['ts'] <= at]
            if upto:
                lt = upto[-1]; pt['mcap'] = round(lt['pu'] * 1e9, 2); pt['phase'] = 'curve' if lt['pg'] == 'pump' else 'amm'
                pt['curve_pct'] = round(cpct(lt['ps']), 2) if lt['pg'] == 'pump' else 100.0
                pt['n_trades'] = len(upto); pt['n_buyers'] = len({t['u'] for t in upto if t['ty'] == 'buy'}); pt['vol_usd'] = round(sum(t['usd'] for t in upto), 2)
            else:
                pt.update(mcap=None, n_trades=0, n_buyers=0, vol_usd=0.0, phase='curve', curve_pct=0.0)
        elif cp in probes:
            p = probes[cp]; pt['mcap'] = round(p['pu'] * 1e9, 2); pt['phase'] = 'curve' if p['pg'] == 'pump' else 'amm'
            pt['curve_pct'] = round(cpct(p['ps']), 2) if p['pg'] == 'pump' else 100.0
        else:
            c = [m_ for t_, m_ in h1 if t_ <= at and t_ > at - 3600e3]
            if c: pt['mcap'] = round(c[-1], 2); pt['phase'] = 'amm'; pt['curve_pct'] = 100.0
            elif grad and at >= grad: pt['phase'] = 'amm'; pt['curve_pct'] = 100.0
        traj.append(pt)
    r['trajectory'] = traj
    for A in SNAP_AGES:
        if c0 + A * 1000 > NOW: break
        if c0 + A * 1000 <= cov_to:
            snaps[A] = snap_pump([t for t in trades if t['ts'] <= c0 + A * 1000], cr, c0, A, fb, grad)
        else:
            snaps[A] = snap_from_traj(traj, A, fb, c0, grad, r['dev_buy'], f)
    r['ext']['snap'] = snaps
    # post
    series = sorted(robust_trade_points(trades) + h1 + [(t, m_) for t, m_ in d1 if not h1 or t > h1[-1][0]])
    res = 'trades + 1h candles + daily candles' if h1 else ('trades + daily candles' if d1 else 'trades only')
    post = milestones(series, c0, res)
    post['peak_source'] = 'max of 3-trade rolling-min mcap / GT hourly+daily closes'
    post['pump_ath_mcap'] = round(m['ath_market_cap'], 2) if m.get('ath_market_cap') else None
    if post['peak_mcap'] is None and m.get('ath_market_cap'):
        post['peak_mcap'] = round(m['ath_market_cap'], 2); post['peak_ts'] = m.get('ath_market_cap_timestamp'); post['peak_source'] = 'pump.fun ath_market_cap (no candles)'
        miss.append('no candles: peak from pump.fun ath_market_cap, milestone times unknown')
    nm = m.get('usd_market_cap') or m.get('market_cap_usd')
    if nm: post['now_mcap'] = round(nm, 2)
    r['post'] = post
    obs = (NOW - c0) / 1000
    r['outcome'] = label(post, obs, FAKE.get(d['mint']))
    r['outcome']['graduated'] = bool(grad) if (grad or NOW - c0 > 86400e3) else None
    # coverage
    empty_launch = (not trades) and not m.get('complete') and NOW - c0 > 86400e3 and d.get('stratum') == 'random'
    if empty_launch:
        miss.append('no trades at all in swap-api for a never-graduated launch: treated as an empty birth phase')
        if post.get('peak_mcap') is None:
            r['outcome'] = {'reached_100k': False, 'reached_1m': False, 'reached_10m': False, 'graduated': False, 'label_note': 'never graduated, no trades recorded'}
    elif not trades: miss.append('no trades returned by swap-api')
    if not full_curve and curve: miss.append('curve trade sequence truncated (page budget); later features from probes/candles')
    if grad and not (d.get('h1') or d.get('d1')): miss.append('no post-graduation candles from GeckoTerminal')
    if fb and not any(x['wallet_age_note'] for x in fb if x['kind'] == 'buy'): miss.append('wallet ages not resolved yet')
    lvl = 'full' if ((trades or empty_launch) and full_curve and (not grad or d.get('h1') or d.get('d1'))) else ('partial' if trades else ('outcome_only' if post.get('peak_mcap') else 'failed'))
    r['coverage'] = {'level': lvl, 'missing': miss}
    r['ext'].update({'pump_complete': m.get('complete'), 'trades_collected': len(trades), 'grad_res': d.get('grad_res'), 'twitter': bool(m.get('twitter')), 'stratum_extra': d.get('extra')})
    return r

K = 30.0 * 1.073e9
def cpct(ps):
    if not ps or ps <= 0: return 0.0
    v = math.sqrt(ps * K); return max(0.0, min(100.0, 100 * (1.073e9 - K / v) / 793.1e6))

def feat_pump(curve, cr, c0, grad, full, fb):
    f = {}
    buys = [t for t in curve if t['ty'] == 'buy']; sells = [t for t in curve if t['ty'] == 'sell']
    nd = [t for t in buys if t['u'] != cr]
    f['secs_create_to_first_buy'] = round((nd[0]['ts'] - c0) / 1000, 1) if nd else None
    f['n_trades_curve'] = len(curve); f['n_buys_curve'] = len(buys); f['n_unique_buyers_curve'] = len({t['u'] for t in buys})
    f['curve_vol_usd'] = round(sum(t['usd'] for t in curve), 2)
    sz = [t['usd'] for t in nd]
    f['buy_usd_median'] = round(q(sz, .5), 2) if sz else None; f['buy_usd_p90'] = round(q(sz, .9), 2) if sz else None; f['buy_usd_gini'] = gini(sz)
    per = {}
    for t in nd: per[t['u']] = per.get(t['u'], 0) + t['usd']
    tot = sum(per.values())
    f['top10_buyer_share'] = round(sum(sorted(per.values(), reverse=True)[:10]) / tot, 4) if tot > 0 else None
    f['buyer_gini'] = gini(list(per.values()))
    f20 = [x for x in fb if x['kind'] == 'buy'][:20]
    fr = [x['fresh'] for x in f20 if x['fresh'] is not None]
    f['first20_fresh_share'] = round(sum(fr) / len(fr), 3) if len(fr) >= 5 else None
    f['first20_ages_resolved'] = len(fr)
    f['same_second_buys_first20'] = same_sec(f20)
    f['fresh_cluster_max'] = fresh_cluster(f20)
    devs = [t for t in curve if t['u'] == cr]
    f['dev_buy_usd'] = round(sum(t['usd'] for t in devs if t['ty'] == 'buy' and t['ts'] - c0 <= 5000), 2) if curve else None
    f['dev_sold_before_grad'] = any(t['ty'] == 'sell' for t in devs) if curve else None
    sv = sum(t['usd'] for t in sells); bv = sum(t['usd'] for t in buys)
    f['sell_share_curve'] = round(sv / (sv + bv), 4) if sv + bv > 0 else None
    if grad and nd:
        mins = max(1 / 60, (grad - nd[0]['ts']) / 60000)
        f['secs_first_buy_to_grad'] = round((grad - nd[0]['ts']) / 1000, 1); f['curve_fill_pct_per_min'] = round(100 / mins, 3)
    elif curve and nd:
        lt = curve[-1]; mins = max(1 / 60, (lt['ts'] - nd[0]['ts']) / 60000)
        f['secs_first_buy_to_grad'] = None; f['curve_fill_pct_per_min'] = round(cpct(lt['ps']) / mins, 3)
    f['curve_complete_in_data'] = bool(full)
    return f

def same_sec(f20):
    if len(f20) < 3: return None
    c = {}
    for x in f20: c[int(x['ts'] / 1000)] = c.get(int(x['ts'] / 1000), 0) + 1
    return sum(v for v in c.values() if v >= 2)

def fresh_cluster(f20):
    """largest set of fresh wallets buying within 2 s of each other with sizes within +-10% (bundle signature)"""
    fr = [x for x in f20 if x.get('fresh') and x.get('quote')]
    best = 0
    for a in fr:
        g = [b for b in fr if abs(b['ts'] - a['ts']) <= 2000 and abs(b['quote'] - a['quote']) <= 0.1 * a['quote']]
        best = max(best, len(g))
    return best if f20 and any(x.get('fresh') is not None for x in f20) else None

def snap_pump(upto, cr, c0, A, fb, grad):
    s = {'age': A}
    curve = [t for t in upto if t['pg'] == 'pump']; buys = [t for t in curve if t['ty'] == 'buy']
    nd = [t for t in buys if t['u'] != cr]
    lt = upto[-1] if upto else None
    s['mcap'] = lt['pu'] * 1e9 if lt else None
    s['curve_pct'] = (cpct(lt['ps']) if lt['pg'] == 'pump' else 100.0) if lt else 0.0
    s['graduated'] = bool(grad and grad <= c0 + A * 1000)
    s['n_trades'] = len(upto); s['n_buyers'] = len({t['u'] for t in buys}); s['vol'] = sum(t['usd'] for t in upto)
    sv = sum(t['usd'] for t in curve if t['ty'] == 'sell'); bv = sum(t['usd'] for t in buys)
    s['sell_share'] = sv / (sv + bv) if sv + bv > 0 else None
    per = {}
    for t in nd: per[t['u']] = per.get(t['u'], 0) + t['usd']
    tot = sum(per.values()); s['top10'] = sum(sorted(per.values(), reverse=True)[:10]) / tot if tot > 0 else None
    s.update(early_feats(fb, c0, A))
    # mcap 60s / A/5 earlier for slope
    t5 = c0 + max(30, A // 5) * 1000; e = [t for t in upto if t['ts'] <= t5]
    s['mcap_prev'] = e[-1]['pu'] * 1e9 if e else None
    s['dev_pct'] = 100 * sum(t['base'] for t in buys if t['u'] == cr and t['ts'] - c0 <= 5000) / 1e9 if buys else None
    s['dev_sold'] = any(t['ty'] == 'sell' and t['u'] == cr for t in curve)
    s['first_buy_delay'] = (nd[0]['ts'] - c0) / 1000 if nd else None
    return s

def early_feats(fb, c0, A):
    """features from the first buyers list restricted to buys before age A"""
    s = {}
    x = [b for b in fb if b['kind'] == 'buy' and b['ts'] <= c0 + A * 1000][:20]
    sz = [b['usd'] for b in x if b.get('usd') is not None]
    s['med_buy'] = q(sz, .5) if sz else None; s['gini20'] = gini(sz) if len(sz) >= 3 else None
    ss = same_sec(x); s['same_sec'] = ss / len(x) if ss is not None and x else None
    fr = [b['fresh'] for b in x if b.get('fresh') is not None]
    s['fresh20'] = sum(fr) / len(fr) if len(fr) >= 4 else None
    s['n_first'] = len(x); s['_w'] = [b['w'] for b in x]
    return s

def snap_from_traj(traj, A, fb, c0, grad, dev, f):
    s = {'age': A}
    pts = [p for p in traj if p['t'] <= A and p.get('mcap')]
    s['mcap'] = pts[-1]['mcap'] if pts else None
    s['curve_pct'] = pts[-1]['curve_pct'] if pts else None
    s['graduated'] = bool(grad and grad <= c0 + A * 1000)
    prev = [p for p in traj if p['t'] <= max(30, A // 5) and p.get('mcap')]
    s['mcap_prev'] = prev[-1]['mcap'] if prev else None
    nt = [p for p in traj if p['t'] <= A and p.get('n_trades') is not None]
    s['n_trades'] = nt[-1]['n_trades'] if nt and nt[-1]['t'] == max(p['t'] for p in traj if p['t'] <= A) else None
    s['n_buyers'] = None; s['vol'] = None; s['top10'] = None; s['sell_share'] = None
    s.update(early_feats(fb, c0, A))
    s['dev_pct'] = dev.get('pct_supply') if dev else None
    s['first_buy_delay'] = f.get('secs_create_to_first_buy')
    return s

# ------------------------------------------------------------------ Solana pads + EVM (shared logic)
def candle_mcap_at(c, supply, at_ms):
    if not c or not supply: return None
    best = None
    for x in c:
        if int(x[0]) * 1000 <= at_ms: best = x
        else: break
    return float(best[4]) * supply if best else None

def build_generic(d, chain):
    pad = d['pad']; mech = 'bonding_curve' if pad not in ('clanker', 'robinhood-uniswap', 'bankr', 'o1-launchpad', 'bankr-robinhood', 'clanker-robinhood', 'o1-launchpad-robinhood') else 'direct_pool'
    if pad == 'daos.fun': mech = 'fundraise_then_curve'
    addr = d.get('mint') or d.get('address')
    c0 = d.get('created')
    r = base_rec(chain, addr, pad, mech, d.get('stratum'), c0 or 0)
    r['symbol'] = d.get('symbol'); miss = list(d.get('notes') or [])
    r['sources'] = ['GeckoTerminal pools+OHLCV'] + (['Solana public RPC'] if chain == 'solana' else [f'{chain} public RPC logs'])
    if not c0:
        r['coverage'] = {'level': 'failed', 'missing': miss or ['no creation time']}; return r
    sup = d.get('supply')
    m1 = d.get('curve_m1') or d.get('birth_m1')
    tx = d.get('first_txs') or []
    if chain == 'solana':
        cr = tx[0]['u'] if tx and tx[0].get('create') else None
        rows = [t for t in tx if not t.get('err')]
        buys = [t for t in rows if t.get('tok', 0) > 0]
        sells = [t for t in rows if t.get('tok', 0) < 0]
    else:
        cr = None
        rows = [t for t in tx if t.get('ts')]
        buys = [t for t in rows if t.get('kind') == 'buy']; sells = []
    r['creator'] = short(cr) if cr else None
    fb = []
    for t in buys[:100]:
        px = None
        if m1 and sup and t.get('tok'):
            mc = candle_mcap_at(m1, sup, t['ts'] + 60000)
            px = (mc / sup) if mc else None
        usd = round(t['tok'] * px, 2) if px else None
        if chain == 'solana':
            a, note, fr = wage(t['u'], t['ts']) if t['u'] != cr else (None, None, None)
        else:
            n = t.get('nonce'); a = None
            note = ('nonce_at_buy' if t.get('nonce_note') == 'at_buy' else 'nonce_now') if n is not None else None
            fr = (n <= 3) if n is not None else None
        fb.append({'w': short(t['u']), 'ts': t['ts'], 'dt_s': round((t['ts'] - c0) / 1000, 1), 'usd': usd, 'quote': round(t['quote'], 6) if t.get('quote') else None,
                   'quote_sym': t.get('qsym'), 'kind': 'dev_buy' if (cr and t['u'] == cr) else 'buy', 'wallet_age_d': a, 'wallet_age_note': note, 'fresh': fr,
                   **({'nonce': t.get('nonce')} if chain != 'solana' else {})})
    r['first_buyers'] = fb
    devb = [t for t in buys if cr and t['u'] == cr and t['ts'] - c0 <= 5000]
    if cr: r['dev_buy'] = {'usd': None, 'quote': round(sum(t.get('quote') or 0 for t in devb), 6), 'pct_supply': round(100 * sum(t['tok'] for t in devb) / sup, 3) if sup else None}
    nd = [x for x in fb if x['kind'] == 'buy']
    r['first_buy_ts'] = nd[0]['ts'] if nd else None
    gp = d.get('grad_pool')
    grad = gp['created'] if gp and gp.get('created') else None
    r['graduation_ts'] = grad
    r['phase'] = 'graduated' if grad else ('no_curve' if mech == 'direct_pool' else ('not_graduated' if NOW - c0 > 86400e3 else 'pre_launch'))
    f = {}
    f['secs_create_to_first_buy'] = nd[0]['dt_s'] if nd else None
    sz = [x['usd'] for x in nd if x['usd'] is not None]
    f['buy_usd_median'] = round(q(sz, .5), 2) if sz else None; f['buy_usd_p90'] = round(q(sz, .9), 2) if sz else None; f['buy_usd_gini'] = gini(sz)
    f20 = nd[:20]; fr = [x['fresh'] for x in f20 if x['fresh'] is not None]
    f['first20_fresh_share'] = round(sum(fr) / len(fr), 3) if len(fr) >= 4 else None; f['first20_ages_resolved'] = len(fr)
    f['same_second_buys_first20'] = same_sec(f20); f['fresh_cluster_max'] = fresh_cluster(f20)
    f['dev_buy_usd'] = None
    st_ = d.get('sig_times')
    if st_: f['n_trades_curve'] = len([t for t in st_ if not grad or t <= grad])
    if grad and nd:
        f['secs_first_buy_to_grad'] = round((grad - nd[0]['ts']) / 1000, 1); f['curve_fill_pct_per_min'] = round(100 / max(1 / 60, (grad - nd[0]['ts']) / 60000), 3)
    f['n_first_txs_parsed'] = len(tx)
    r['features'] = f
    traj = []
    vol_c = 0.0
    for cp in CHECKPOINTS:
        at = c0 + cp * 1000
        if at > NOW: break
        mc = candle_mcap_at(m1, sup, at) if m1 and m1 and int(m1[-1][0]) * 1000 >= at - 60000 else None
        v = sum(float(x[5]) for x in (m1 or []) if int(x[0]) * 1000 <= at) if m1 else None
        nt = len([t for t in st_ if t <= at]) if st_ else None
        traj.append({'t': cp, 'mcap': round(mc, 2) if mc else None, 'curve_pct': None, 'n_trades': nt, 'n_buyers': None, 'vol_usd': round(v, 2) if v is not None else None,
                     'phase': ('amm' if grad and at >= grad else ('curve' if mech != 'direct_pool' else 'amm'))})
    r['trajectory'] = traj
    snaps = {}
    for A in SNAP_AGES:
        if c0 + A * 1000 > NOW: break
        s = {'age': A}
        pts = [p for p in traj if p['t'] <= A]
        s['mcap'] = next((p['mcap'] for p in reversed(pts) if p['mcap']), None)
        s['mcap_prev'] = next((p['mcap'] for p in reversed([p for p in traj if p['t'] <= max(30, A // 5)]) if p['mcap']), None)
        s['curve_pct'] = None; s['graduated'] = bool(grad and grad <= c0 + A * 1000)
        s['n_trades'] = pts[-1]['n_trades'] if pts else None; s['vol'] = pts[-1]['vol_usd'] if pts else None
        s['n_buyers'] = None; s['top10'] = None; s['sell_share'] = None
        s.update(early_feats(fb, c0, A))
        s['dev_pct'] = r['dev_buy']['pct_supply'] if r['dev_buy'] else None
        s['first_buy_delay'] = f['secs_create_to_first_buy']
        snaps[A] = s
    r['ext']['snap'] = snaps
    ph = d.get('post_h1') or d.get('curve_h1'); pd_ = d.get('post_d1') or d.get('curve_d1')
    h1 = candle_points(ph, sup); d1 = candle_points(pd_, sup); mm = candle_points(m1, sup)
    series = sorted(mm + h1 + [(t, x) for t, x in d1 if not h1 or t > h1[-1][0]])
    post = milestones(series, c0, 'GT 1m (birth) + 1h + daily closes')
    post['peak_source'] = 'GeckoTerminal closes x supply (fdv/price)'
    r['post'] = post
    fake = None
    try:
        mp = d.get('main_pool') or {}
        if post.get('peak_mcap') and mp.get('liq') is not None and post['peak_mcap'] >= 1e6 and (mp.get('liq') or 0) < 2000 and (post.get('now_mcap') or 0) > 5e5:
            fake = 'mcap >= $1M with < $2K liquidity now (likely illiquid/fake mcap)'
    except Exception: pass
    r['outcome'] = label(post, (NOW - c0) / 1000, fake)
    r['outcome']['graduated'] = bool(grad) if mech != 'direct_pool' and (grad or NOW - c0 > 86400e3) else None
    if not sup: miss.append('token supply unknown (no fdv/price on GT) -> no mcap')
    if not m1: miss.append('no birth-pool minute candles on GT (free tier keeps ~6 months)')
    if not tx: miss.append('no first-buyer transactions')
    lvl = 'full' if (tx and m1 and sup and (post['peak_mcap'] is not None)) else ('partial' if (tx or m1) else ('outcome_only' if post['peak_mcap'] else 'failed'))
    r['coverage'] = {'level': lvl, 'missing': miss}
    r['ext'].update({'curve_pool_dex': (d.get('curve_pool') or d.get('birth_pool') or {}).get('dex'), 'n_sigs_on_curve': d.get('n_sigs'), 'stratum_extra': d.get('extra')})
    return r


# ------------------------------------------------------------------ adapter for other workers' files
def _iso(s):
    try: return int(time.mktime(time.strptime(s[:19], '%Y-%m-%dT%H:%M:%S')) - time.timezone) * 1000 if False else __import__('calendar').timegm(time.strptime(s[:19], '%Y-%m-%dT%H:%M:%S')) * 1000
    except Exception: return None

def adapt_v1(r):
    """Virtuals worker's 'birthphase/v1' record -> schema 1.0 (read-only; their file is never modified)."""
    c0 = _iso(r.get('created_at') or ''); tok = (r.get('token') or r.get('pre_token') or '').lower()
    out = base_rec(r.get('chain') or 'base', tok, r.get('launchpad') or 'virtuals', 'genesis_points' if r.get('genesis') else 'bonding_curve', 'other_worker', c0 or 0)
    out.update(symbol=r.get('symbol'), name=r.get('name'), sources=['Virtuals birth-phase worker (data/birthphase/virtuals.jsonl)'])
    fb = []
    for b in r.get('first_buyers') or []:
        w = b.get('wallet')
        ts = (c0 + 1000 * b['t_s']) if c0 is not None and b.get('t_s') is not None else None
        fb.append({'w': short(w) if w else b.get('short'), 'ts': ts, 'dt_s': b.get('t_s'), 'usd': b.get('usd'), 'quote': b.get('virtual'), 'quote_sym': 'VIRTUAL', 'kind': 'buy',
                   'wallet_age_d': b.get('wallet_age_days'), 'wallet_age_note': 'nonce' if b.get('nonce_before') is not None else None, 'fresh': b.get('fresh')})
    out['first_buyers'] = fb
    out['first_buy_ts'] = _iso(r.get('first_buy_at') or '')
    g = _iso(r.get('graduated_at') or '') if r.get('graduated_at') else None
    out['graduation_ts'] = g; out['phase'] = 'graduated' if g else 'not_graduated'
    cv = r.get('curve') or {}
    out['features'] = {'n_trades_curve': cv.get('n_trades'), 'n_buys_curve': cv.get('n_buys'), 'n_unique_buyers_curve': cv.get('unique_buyers'),
                       'secs_first_buy_to_grad': (cv.get('first_buy_to_graduation_h') or 0) * 3600 if cv.get('first_buy_to_graduation_h') is not None else None,
                       'curve_fill_pct_per_min': (cv.get('fill_pct_per_h') / 60) if cv.get('fill_pct_per_h') is not None else None,
                       'fresh_cluster_max': r.get('fresh_cluster_size'), 'secs_create_to_first_buy': ((out['first_buy_ts'] - c0) / 1000) if out['first_buy_ts'] and c0 else None}
    ser = [(h * 3600, m) for h, m in (r.get('_curve_series') or []) if m]
    traj = []
    for cp in CHECKPOINTS:
        if c0 and c0 + cp * 1000 > NOW: break
        pts = [m for t, m in ser if t <= cp]
        traj.append({'t': cp, 'mcap': pts[-1] if pts else None, 'curve_pct': None, 'n_trades': None, 'n_buyers': None, 'vol_usd': None, 'phase': 'amm' if g and c0 and c0 + cp * 1000 >= g else 'curve'})
    out['trajectory'] = traj
    snaps = {}
    if c0 and ser:
        for A in SNAP_AGES:
            pts = [m for t, m in ser if t <= A]; pv = [m for t, m in ser if t <= max(30, A // 5)]
            s = {'age': A, 'mcap': pts[-1] if pts else None, 'mcap_prev': pv[-1] if pv else None, 'curve_pct': None, 'graduated': bool(g and g <= c0 + A * 1000),
                 'n_trades': None, 'n_buyers': None, 'vol': None, 'top10': None, 'sell_share': None, 'dev_pct': None,
                 'first_buy_delay': out['features']['secs_create_to_first_buy']}
            s.update(early_feats([b for b in fb if b['ts'] is not None], c0, A))
            snaps[A] = s
    out['ext'] = {'snap': snaps, 'virtuals_id': r.get('virtuals_id'), 'cohort': r.get('cohort'), 'genesis': r.get('genesis'), 'source_schema': r.get('schema')}
    o = r.get('outcome') or {}
    hk = lambda k: (o.get(k) * 3600) if o.get(k) is not None else None
    out['post'] = {'peak_mcap': o.get('peak_mcap_usd'), 'peak_ts': _iso(o.get('peak_at') or '') if o.get('peak_at') else None, 't_to_100k_s': hk('hours_to_100k'),
                   't_to_1m_s': hk('hours_to_1000k'), 't_to_10m_s': hk('hours_to_10000k'), 'max_dd_from_peak_pct': None, 'now_mcap': None,
                   'resolution': (r.get('post') or {}).get('resolution'), 'peak_source': 'Virtuals worker'}
    pk = o.get('peak_mcap_usd')
    out['outcome'] = {'reached_100k': (pk >= 1e5) if pk is not None else None, 'reached_1m': o.get('reached_1m'), 'reached_10m': o.get('reached_10m'), 'graduated': o.get('graduated'), 'label_note': 'from Virtuals worker'}
    cov = r.get('coverage') or {}
    out['coverage'] = {'level': 'full' if cov.get('pre') == 'ok' and cov.get('post') == 'ok' else ('partial' if cov.get('pre') or cov.get('post') else 'outcome_only'),
                       'missing': [f'{k}: {v}' for k, v in cov.items() if v not in ('ok', True, False, None) and k in ('pre', 'post')]}
    return out

# ------------------------------------------------------------------ repeat early buyers (time-respecting)
def repeat_buyers(recs):
    """For each record: how many of its first-20 buyers were first-20 buyers in >=2 EARLIER launches in the library,
    and how many of those had been early in an earlier launch that reached $1M. Earlier = created before this one,
    so the feature is usable in a backtest without peeking into the future."""
    ev = []
    for r in recs:
        ws = [b.get('w') for b in r.get('first_buyers') or [] if b.get('kind', 'buy') in ('buy', 'pledge', 'genesis') and b.get('w')][:20]
        ev.append((r['created_ts'] or 0, r['key'], ws, bool((r.get('outcome') or {}).get('reached_1m'))))
    ev.sort()
    hist = {}  # w -> [ (ts, win) ]
    out = {}
    for ts, key, ws, win in ev:
        rep = [w for w in ws if len(hist.get(w, [])) >= 2]
        repw = [w for w in ws if any(x[1] and x[0] < ts - 2 * 86400e3 for x in hist.get(w, []))]
        out[key] = (len(rep), len(repw))
        for w in set(ws): hist.setdefault(w, []).append((ts, win))
    top = sorted(((w, len(v), sum(1 for x in v if x[1])) for w, v in hist.items() if len(v) >= 3), key=lambda x: (-x[1], -x[2]))
    return out, top

def main():
    recs = {}
    for f in glob.glob(os.path.join(RAWD, 'pump', '*.json')):
        try: r = build_pump(json.load(open(f)))
        except Exception as e: print('pump build err', f[-20:], e); continue
        recs.setdefault(r['launchpad'], []).append(r)
    for f in glob.glob(os.path.join(RAWD, 'solpads', '*.json')):
        try: r = build_generic(json.load(open(f)), 'solana')
        except Exception as e: print('solpad build err', f[-20:], e); continue
        recs.setdefault(r['launchpad'], []).append(r)
    for f in glob.glob(os.path.join(RAWD, 'evm', '*.json')):
        try: d = json.load(open(f)); r = build_generic(d, d['chain'])
        except Exception as e: print('evm build err', f[-20:], e); continue
        recs.setdefault(r['launchpad'], []).append(r)
    # sanity: a memecoin peak above $10B is a supply/price-feed artefact (e.g. GT pricing a pool with a broken supply); never label from it
    for v in recs.values():
        for r in v:
            pk = (r.get('post') or {}).get('peak_mcap')
            if pk and pk > 1e10:
                r['outcome'] = {'reached_100k': None, 'reached_1m': None, 'reached_10m': None, 'graduated': (r.get('outcome') or {}).get('graduated'),
                                'label_note': 'implausible peak mcap $%.3g (bad supply/price data) - outcome withheld' % pk}
                r['post']['implausible'] = True
                r['coverage']['missing'].append('implausible peak mcap (>$10B) from price feed: outcome labels withheld')
    own = set(recs)
    # merge other workers' files (same schema) for repeat-buyer sets; we never overwrite them
    foreign = {}
    for f in glob.glob(os.path.join(BP, '*.jsonl')):
        pad = os.path.basename(f)[:-6]
        if pad in own: continue
        rows = rjsonl(f)
        foreign[pad] = [adapt_v1(x) if x.get('schema') == 'birthphase/v1' else x for x in rows if x.get('schema') == 'birthphase/v1' or x.get('schema_version') == '1.0']
    os.makedirs(os.path.join(BP, 'adapted'), exist_ok=True)
    for pad, v in foreign.items(): wjsonl(os.path.join(BP, 'adapted', pad + '.jsonl'), v)
    allr = [r for v in recs.values() for r in v] + [r for v in foreign.values() for r in v]
    rep, top = repeat_buyers(allr)
    for v in recs.values():
        for r in v:
            a, b = rep.get(r['key'], (None, None))
            r['features']['repeat_early_buyers'] = a; r['features']['repeat_early_buyers_winners'] = b
            for s in (r['ext'].get('snap') or {}).values():
                s['repeat'] = a  # first-20 set is (nearly) complete within minutes on active launches
    cov = {}
    for pad, v in sorted(recs.items()):
        v.sort(key=lambda r: r['created_ts'] or 0)
        wjsonl(os.path.join(BP, pad + '.jsonl'), v)
        c = {'n': len(v), 'full': 0, 'partial': 0, 'outcome_only': 0, 'failed': 0, 'by_stratum': {}, 'reasons': {}, 'labelled_1m': 0, 'reached_1m': 0, 'reached_100k': 0, 'graduated': 0}
        for r in v:
            c[r['coverage']['level']] += 1
            c['by_stratum'][r['sample_stratum']] = c['by_stratum'].get(r['sample_stratum'], 0) + 1
            for mm in r['coverage']['missing']:
                k = mm.split(':')[0][:90]; c['reasons'][k] = c['reasons'].get(k, 0) + 1
            o = r.get('outcome') or {}
            if o.get('reached_1m') is not None: c['labelled_1m'] += 1
            c['reached_1m'] += bool(o.get('reached_1m')); c['reached_100k'] += bool(o.get('reached_100k')); c['graduated'] += bool(o.get('graduated'))
        cov[pad] = c
    for pad, v in foreign.items():
        c = {'n': len(v), 'foreign': 'built by another worker (data/birthphase/%s.jsonl), adapted read-only' % pad, 'full': 0, 'partial': 0, 'outcome_only': 0, 'failed': 0, 'by_stratum': {}, 'reasons': {}, 'reached_1m': 0, 'reached_100k': 0, 'graduated': 0, 'labelled_1m': 0}
        for r in v:
            c[(r.get('coverage') or {}).get('level', 'failed')] = c.get((r.get('coverage') or {}).get('level', 'failed'), 0) + 1
            st_ = (r.get('ext') or {}).get('cohort') or r.get('sample_stratum'); c['by_stratum'][st_] = c['by_stratum'].get(st_, 0) + 1
            o = r.get('outcome') or {}; c['reached_1m'] += bool(o.get('reached_1m')); c['reached_100k'] += bool(o.get('reached_100k')); c['graduated'] += bool(o.get('graduated'))
            c['labelled_1m'] += o.get('reached_1m') is not None
        cov[pad] = c
    wjson(os.path.join(BP, 'coverage.json'), {'generatedAt': NOW, 'pads': cov, 'total': sum(c['n'] for c in cov.values()),
          'wallet_ages_resolved': len(AGES), 'repeat_early_buyers_top': [{'w': w, 'launches': n, 'early_in_1m_winners': k} for w, n, k in top[:40]]})
    print(json.dumps({p: {k: c[k] for k in ('n', 'full', 'partial', 'outcome_only', 'failed') if k in c} for p, c in cov.items()}))

if __name__ == '__main__':
    main()
