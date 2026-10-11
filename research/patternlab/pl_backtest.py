#!/usr/bin/env python3
"""Pattern Lab backtest: 37 patterns on the 50-token detector test set (30 crashed + 20 runners), evaluated in BOTH directions:
  crash predictor : flag rate crashed vs runners, Fisher one-sided p (crashed > runners), lead = dump time - flag time (h)
  pump predictor  : flag rate runners vs crashed, Fisher one-sided p (runners > crashed), lead = breakout time - flag time (h)
 dump time     = crash break (-30% from peak, patterns_flows) or first hourly close <= 70% of the peak high
 breakout time = created + hours_to_2x (research DB); falls back to the peak
Market-wide patterns (#16 #18 #27 #28 #29) are also evaluated on the FULL catalog (crash_catalog ATH dates = crash onsets vs runner
peaks from the research DB 'mooned' cohort, + data/events_labeled.json when present).
Inputs: Nansen tape/smart-money/sells (cached by pl_fetch_nansen.py), free caches from pl_fetch_free.py, research DB, other workers'
detector outputs (patterns_*.json; read only). Output: data/patternlab_backtest.json"""
import sys, os, json, re, math, subprocess, statistics, datetime as dt, sqlite3
from collections import defaultdict, Counter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plcommon as P
import pl_fetch_nansen as F
H = 3600
UTC = dt.timezone.utc

def nget(kind, t):
    try: j = F.get(kind, t, 0)
    except P.NansenStop: return None
    if not isinstance(j, dict) or j.get('_error'): return None
    return [{'t': P.tsof(x['block_timestamp']), 'w': x['trader_address'], 'label': x.get('trader_address_label') or '', 'side': x['action'],
             'amt': float(x.get('token_amount') or 0), 'usd': float(x.get('estimated_value_usd') or 0), 'px': x.get('estimated_swap_price_usd'),
             'tx': x['transaction_hash']} for x in j.get('data') or []]

def cache_json(name):
    try: return json.load(open(os.path.join(P.CACHE, name)))
    except Exception: return {}

# ---------------- labels ----------------
SMART = re.compile(r'smart trader|smart money|\bfund\b|🤓', re.I)
LABELLED = re.compile(r'smart|\bfund\b|whale|public figure|millionaire|deployer|kol|influencer|👤|🐳|🤓|high balance|insider', re.I)
MEVBOT = re.compile(r'🤖|mev|sandwich|arbitrage|jito', re.I)
RETAILBOT = re.compile(r'trading bot user', re.I)

def event_times(t):
    db = t['db']; c = t['created_t'] or t['peak_t']
    pump = c + db['hours_to_2x'] * H if db.get('hours_to_2x') is not None else t['peak_t']
    return {'dump': t.get('dump_t') or t['peak_t'], 'pump': pump, 'peak': t['peak_t'], 't0': c}

def row(t, flag, t_flag=None, testable=True, **detail):
    ev = event_times(t); tf = t_flag if t_flag is not None else ev['t0']
    late = None; mkt = detail.pop('_market', False)
    if flag and tf and tf > ev['peak'] + H and not mkt: late, flag = tf, False  # same window for both classes: must fire by peak+1h
    r = {'symbol': t['symbol'], 'mint': t['mint'], 'cohort': t['cohort'], 'flag': bool(flag), 'testable': testable, 't_flag': tf if flag else None}
    if flag and tf:
        if t['cohort'] == 'died': r['lead_h'] = round((ev['dump'] - tf) / H, 2)
        else: r['lead_pump_h'] = round((ev['pump'] - tf) / H, 2); r['lead_peak_h'] = round((ev['peak'] - tf) / H, 2)
    if late: r['late_flag_t'] = late
    r.update(detail); return r

def stats2(rows):
    s = P.stats(rows)
    T = [r for r in rows if r.get('testable', True)]
    M = [r for r in T if r['cohort'] == 'mooned']; D = [r for r in T if r['cohort'] == 'died']
    a, c = s['flag_crashed'], s['flag_runners']
    if D and M:
        p2, pg = P.fisher(c, len(M) - c, a, len(D) - a)
        s['p_pump_one_sided'] = round(pg, 4)
    else: s['p_pump_one_sided'] = None
    s['p_crash_one_sided'] = s.pop('p_fisher_one_sided')
    lp = [r['lead_pump_h'] for r in M if r['flag'] and r.get('lead_pump_h') is not None]
    s['lead_pump_h_median'] = P.med(lp); s['lead_pump_h_all'] = sorted(lp)
    s['lead_crash_h_median'] = s.pop('lead_h_median'); s['lead_crash_h_all'] = s.pop('lead_h_all')
    s['false_flag_rate_as_crash_signal'] = s.pop('false_flag_rate'); s['false_flag_rate_as_pump_signal'] = s['hit_crashed']
    pc, pp = s['p_crash_one_sided'], s['p_pump_one_sided']
    if not D or not M or (a + c == 0): s['verdict'] = 'untestable on this set' if (a + c == 0 and not T) else ('never fired on this set' if a + c == 0 else 'untestable on this set')
    elif a + c == len(T): s['verdict'] = 'fires on every token (no discrimination)'
    elif pc is not None and pc < 0.05: s['verdict'] = 'crash-predictive (p<0.05)'
    elif pp is not None and pp < 0.05: s['verdict'] = 'pump-predictive (p<0.05)'
    elif min(pc or 1, pp or 1) < 0.15: s['verdict'] = 'weak ' + ('crash' if (pc or 1) < (pp or 1) else 'pump') + ' tilt (p<0.15)'
    else: s['verdict'] = 'no edge'
    return s

# ---------------- generic tape helpers ----------------
def bars(tape, sec=300):
    B = {}
    for x in tape:
        if not x['px']: continue
        k = x['t'] // sec * sec; b = B.setdefault(k, {'t': k, 'o': x['px'], 'h': x['px'], 'l': x['px'], 'c': x['px'], 'v': 0, 'bv': 0, 'sv': 0, 'new': 0})
        b['h'] = max(b['h'], x['px']); b['l'] = min(b['l'], x['px']); b['c'] = x['px']; b['v'] += x['usd']
        b['bv' if x['side'] == 'BUY' else 'sv'] += x['usd']
    return [B[k] for k in sorted(B)]

def first_cluster(trs, min_wallets, win_s, side='SELL', t_max=None, min_usd=0):
    trs = sorted([x for x in trs if x['side'] == side and x['usd'] >= min_usd and (t_max is None or x['t'] <= t_max)], key=lambda x: x['t'])
    for i, x in enumerate(trs):
        ws = {y['w'] for y in trs[i:] if y['t'] - x['t'] <= win_s}
        if len(ws) >= min_wallets: return x['t'], sorted(ws)
    return None, []

# ---------------- pattern implementations (50-token set) ----------------
def p1(T, C):  # coordinated smart-money exits
    rows, rows_b = [], []
    for t in T:
        ev = event_times(t); sm = C['sm'].get(t['mint'])
        if sm is None: rows.append(row(t, False, testable=False)); continue
        tc, ws = first_cluster(sm, 2, 3600, 'SELL', t_max=ev['peak'] + 6 * H, min_usd=50)
        rows.append(row(t, tc is not None, tc, sm_trades=len(sm), sm_wallets=len({x['w'] for x in sm}), cluster=ws[:6]))
        lab = [x for x in (C['tape'].get(t['mint']) or []) + (C['sells'].get(t['mint']) or []) + sm if LABELLED.search(x['label']) and not RETAILBOT.search(x['label'])]
        seen = set(); lab = [x for x in lab if not (x['tx'] in seen or seen.add(x['tx']))]
        tb, wb = first_cluster(lab, 3, 1800, 'SELL', t_max=ev['peak'] + 6 * H, min_usd=100)
        rows_b.append(row(t, tb is not None, tb, cluster=wb[:6], labelled_trades=len(lab)))
    return rows, {'variant_labelled_wallets': {'rule': '>=3 distinct Nansen-labelled wallets (smart trader/fund/whale/public figure/KOL/deployer/millionaire; retail TG-bot labels excluded) each selling >=$100 within 30 min, at or before peak+6h', 'stats': stats2(rows_b), 'rows': rows_b}}

def p2(T, C):  # smart money accumulating (pre-peak) + dead-token accumulation (post-dump)
    rows, dead = [], []
    for t in T:
        ev = event_times(t); sm = C['sm'].get(t['mint'])
        if sm is None: rows.append(row(t, False, testable=False)); continue
        pre = [x for x in sm if x['t'] <= ev['peak']]
        buyers = {x['w'] for x in pre if x['side'] == 'BUY'}; net = sum(x['usd'] * (1 if x['side'] == 'BUY' else -1) for x in pre)
        f = len(buyers) >= 2 and net > 0
        tf = sorted(x['t'] for x in pre if x['side'] == 'BUY')[1] if f else None
        rows.append(row(t, f, tf, sm_buyers_pre_peak=len(buyers), sm_net_usd_pre_peak=round(net)))
        if t['cohort'] == 'died':
            post = [x for x in sm if x['t'] >= ev['dump']]; nb = sum(x['usd'] * (1 if x['side'] == 'BUY' else -1) for x in post)
            dead.append({'symbol': t['symbol'], 'sm_net_usd_after_dump': round(nb), 'sm_buyers_after_dump': len({x['w'] for x in post if x['side'] == 'BUY'})})
    return rows, {'dead_token_accumulation': {'crashed_tokens_with_sm_net_buying_after_dump': sum(1 for d in dead if d['sm_net_usd_after_dump'] > 0), 'n': len(dead), 'rows': [d for d in dead if d['sm_buyers_after_dump']],
                  'note': 'none of the 30 crashed tokens revived inside the window, so "smart money buys a dead token" cannot be validated as a revival signal here'}}

def p3(T, C):  # dev funding: fresh / sanctioned / serial funder
    devs = C['devs']; ofac = set(C['market'].get('ofac', {}).get('SOL', []))
    cex = (P.jload('patterns_labels.json') or {}).get('cex', {}).get('solana', {})
    fcount = Counter(d.get('funder') for d in devs.values() if d.get('funder'))
    rows = []
    for t in T:
        d = devs.get(t['mint'])
        if not d or d.get('err'): rows.append(row(t, False, testable=False)); continue
        fresh = d.get('first_tx') is not None and t['created_t'] - d['first_tx'] <= 3 * 86400
        fu = d.get('funder'); sanc = fu in ofac; serial = fu is not None and fcount[fu] >= 2 and fu not in cex
        rows.append(row(t, fresh or sanc or serial, None, fresh_dev=fresh, dev_age_d=round((t['created_t'] - d['first_tx']) / 86400, 1) if d.get('first_tx') else None,
                        funder=fu, funder_is_cex=cex.get(fu), sanctioned=sanc, serial_funder=serial, dev_history_known=bool(d.get('exhausted'))))
    return rows, {'ofac_sol_addresses': len(ofac), 'mixers': 'no Solana mixer program list is public/free; EVM Tornado addresses are in the OFAC ETH list (used live for EVM devs)'}

def p4p5(T, C, which):
    rows = [row(t, bool(t['db'].get(which)), None) for t in T]
    db = sqlite3.connect(f'file:{P.DB}?mode=ro', uri=True)
    sup = db.execute(f"select cohort, count(*), sum({which}>0) from tokens where cohort in ('died','mooned') and {which} is not null group by cohort").fetchall()
    sup2 = db.execute(f"select launchpad, cohort, count(*), sum({which}>0) from tokens where cohort in ('died','mooned') and launchpad not in ('pump.fun','four.meme') group by launchpad, cohort").fetchall()
    d = {c: (n, k) for c, n, k in sup}; nd, kd = d.get('died', (0, 0)); nm, km = d.get('mooned', (0, 0))
    p2_, pg = P.fisher(kd, nd - kd, km, nm - km) if nd and nm else (None, None)
    return rows, {'supplementary_full_db': {'died': {'n': nd, 'flagged': kd}, 'mooned': {'n': nm, 'flagged': km}, 'p_fisher': round(p2_, 4) if p2_ is not None else None,
                  'by_launchpad_non_pumpfun': [list(x) for x in sup2]},
                  'note': 'pump.fun / four.meme programs revoke mint+freeze authority at launch, so on the 50-token (all pump.fun) set it can never fire; it is still a HARD flag live (grade cap) because when present the issuer can mint/freeze at will (lib/contractscan.js already caps)'}

def p6(T, C):
    rows = []
    for t in T:
        m = C['meta'].get(t['mint'])
        if not m: rows.append(row(t, False, testable=False)); continue
        rows.append(row(t, bool(m.get('mutable')), None, mutable=m.get('mutable'), update_authority=m.get('updateAuthority')))
    return rows, {'definition': 'Solana: metadata still mutable / update authority not burned (RugCheck tokenMeta). EVM live: contractscan owner() != 0x0 and not renounced'}

def tape_rows(T, C, fn):
    rows = []
    for t in T:
        tp = C['tape'].get(t['mint'])
        if not tp or len(tp) < 20: rows.append(row(t, False, testable=False, tape_trades=len(tp or []))); continue
        rows.append(fn(t, tp))
    return rows

def p7(T, C):  # snipers / MEV bots; clean volume
    def fn(t, tp):
        t0 = tp[0]['t']
        buys = [x for x in tp if x['side'] == 'BUY']; tot_amt = sum(x['amt'] for x in buys) or 1e-9
        snipers = {x['w'] for x in buys if x['t'] - t0 <= 3}
        sn_share = sum(x['amt'] for x in buys if x['w'] in snipers) / tot_amt
        bot_usd = sum(x['usd'] for x in tp if MEVBOT.search(x['label'])); vol = sum(x['usd'] for x in tp) or 1e-9
        rt = C['fv'].get(t['mint']) or {}
        fake = (rt.get('fake_share_trades') or 0)
        clean = max(0.0, 1 - bot_usd / vol - fake)
        f = sn_share >= 0.25 or clean < 0.5
        return row(t, f, t0 + 300, sniper_wallets=len(snipers), sniper_share_of_bought=round(sn_share, 3), mevbot_vol_share=round(bot_usd / vol, 3), fake_share=round(fake, 3), clean_volume_share=round(clean, 3),
                   tape_trades=len(tp), tape_covers_peak=tp[-1]['t'] >= t['peak_t'])
    return tape_rows(T, C, fn), {'rule': 'flag if wallets buying in the first 3 s took >=25% of tokens bought in the tape, or clean volume (minus MEV-bot-labelled and fake-volume flagged trades) < 50%'}

def same_sec(tp):
    by = defaultdict(list)
    for i, x in enumerate(tp): by[x['t']].append((i, x))
    return by

def p8(T, C):  # sandwich attacks on big buys
    def fn(t, tp):
        n, first = 0, None
        for i in range(1, len(tp) - 1):
            v = tp[i]
            if v['side'] != 'BUY' or v['usd'] < 200: continue
            pre = [x for x in tp[max(0, i - 3):i] if x['side'] == 'BUY' and x['w'] != v['w'] and v['t'] - x['t'] <= 1]
            post = [x for x in tp[i + 1:i + 4] if x['side'] == 'SELL' and x['t'] - v['t'] <= 1]
            if any(a['w'] == b['w'] for a in pre for b in post): n += 1; first = first or v['t']
        return row(t, n >= 2, first, sandwiches=n)
    return tape_rows(T, C, fn), {'rule': 'same wallet buys <=1 s before and sells <=1 s after a >=$200 buy by someone else (within 3 trades); flag at >=2 occurrences'}

def p9(T, C):
    rows = []
    for t in T:
        db = t['db']; ttp = db.get('time_to_peak_h')
        d = [x for x in (db.get('profile_delay_h'), db.get('first_boost_delay_h')) if x is not None]
        if ttp is None or not d: rows.append(row(t, False, testable=ttp is not None, profile_delay_h=db.get('profile_delay_h'), boost_delay_h=db.get('first_boost_delay_h'))); continue
        late = min(d) > 0.5 * ttp
        rows.append(row(t, late, (t['created_t'] or 0) + min(d) * H, profile_delay_h=db.get('profile_delay_h'), boost_delay_h=db.get('first_boost_delay_h'), time_to_peak_h=round(ttp, 2)))
    return rows, {'rule': 'promotion appears only after the pump: first DexScreener paid profile/boost later than 50% of the launch->peak time',
                  'not_feasible_free': 'same accounts shilling multiple rugs / deleted-banned accounts need X post reads (paid; user said no) - X counts only, no handles available for these tokens (pump.fun metadata had no links)'}

def p10(T, C):
    rows = [row(t, (C['meta'].get(t['mint']) or {}).get('markets', 0) <= 2, None, markets=(C['meta'].get(t['mint']) or {}).get('markets')) if C['meta'].get(t['mint']) else row(t, False, testable=False) for t in T]
    return rows, {'note': 'every pump.fun token trades in 1-2 pools (curve + PumpSwap), so this cannot discriminate here; live it is applied to non-launchpad tokens via DexScreener pair counts'}

def p11p12(T, C):
    extra = P.jload('patterns_extra.json') or {}
    lp = {}
    for r in extra.get('tokens') or []:
        if isinstance(r, dict) and r.get('mint'): lp[r['mint']] = r
    r11, r12 = [], []
    for t in T:
        fv = C['fv'].get(t['mint'])
        if not fv or not fv.get('ok'): r11.append(row(t, False, testable=False)); r12.append(row(t, False, testable=False)); continue
        fake = (fv.get('fake_share_trades') or 0) >= 0.25 or (fv.get('round_trip_share') or 0) >= 0.1
        e = lp.get(t['mint']) or {}
        pull = None
        for k in ('lp_pull', 'liquidity_pull', 'lp_withdrawal', 'pull'):
            if k in e: pull = bool(e[k]); break
        r11.append(row(t, fake and (pull if pull is not None else True), None, fake_share=fv.get('fake_share_trades'), round_trip_share=fv.get('round_trip_share'), lp_pull=pull, lp_source='patterns_extra.json' if e else 'n/a (pattern-detector worker output not available yet: fake-volume leg only)'))
        ring = (fv.get('ring_count') or 0) >= 1 or (fv.get('round_trip_wallets') or 0) >= 3
        r12.append(row(t, ring, None, rings=fv.get('ring_count'), ring_largest=fv.get('ring_largest'), round_trip_wallets=fv.get('round_trip_wallets')))
    return (r11, {'reuse': 'lib/fakevolume.js analyzeTrades() via fv_bridge.js on the Nansen tape; LP pull leg read from the pattern-detector worker (data/patterns_extra.json) - not duplicated'}), (r12, {'reuse': 'lib/fakevolume.js ring/self-trade detector'})

def p13(T, C):  # copy-trading clusters
    def fn(t, tp):
        buys = [x for x in tp if x['side'] == 'BUY']; sells = [x for x in tp if x['side'] == 'SELL']
        fol = defaultdict(Counter)
        for arr, wt in ((buys, 1), (sells, 1)):
            for i, a in enumerate(arr):
                for b in arr[i + 1:]:
                    if b['t'] - a['t'] > 3: break
                    if b['w'] != a['w']: fol[a['w']][b['w']] += wt
        best, lead = 0, None
        for w, c in fol.items():
            k = sum(1 for v, n in c.items() if n >= 2)
            if k > best: best, lead = k, w
        tf = None
        if best >= 3: tf = next((x['t'] for x in buys if x['w'] == lead), None)
        return row(t, best >= 3, tf, max_followers=best, leader=lead if best >= 3 else None)
    return tape_rows(T, C, fn), {'rule': 'a source wallet with >=3 followers that each traded the same side within 3 s after it on >=2 occasions (entry and/or exit)', 'reuse_live': 'lib/copytrade.js events (>=2 tracked wallets entering the same token within 6h)'}

def p15(T, C):
    db = sqlite3.connect(f'file:{P.DB}?mode=ro', uri=True)
    cnt = Counter(o for (o,) in db.execute('select owner from top_holders'))
    created = {m: c for m, c in db.execute('select mint, created_ts from tokens')}
    devf = Counter(d.get('funder') for d in C['devs'].values() if d.get('funder'))
    cex = (P.jload('patterns_labels.json') or {}).get('cex', {}).get('solana', {})
    rows = []
    for t in T:
        shared = [o for o, pct in t['holders'] if 2 <= cnt[o] <= 30 and o not in cex]
        fu = (C['devs'].get(t['mint']) or {}).get('funder')
        f = len(shared) >= 3 or (fu and devf[fu] >= 2 and fu not in cex)
        rows.append(row(t, f, None, shared_top_holders=len(shared), shared_dev_funder=bool(fu and devf[fu] >= 2 and fu not in cex)))
    return rows, {'rule': '>=3 of its top holders are top holders of other research-DB tokens (owners seen in 2-30 tokens, CEX excluded) or its deployer shares a funder with another test-set deployer',
                  'caveat': 'holder snapshot taken Oct 9-10 (mostly after the outcome)'}

def market_rows(T, C, fn):
    rows = []
    for t in T:
        ev = event_times(t)
        tt = ev['dump'] if t['cohort'] == 'died' else ev['pump']
        f, det = fn(tt)
        rows.append(row(t, f, tt, _market=True, **det))
    return rows

def mk_market(C):
    M = C['market']
    def series(k): return sorted(M.get(k) or [])
    btc = series('BTCUSDT'); eth = series('ETHUSDT'); ethbtc = series('ETHBTC')
    alts = {k: series(k) for k in M if k.endswith('USDT') and k not in ('BTCUSDT', 'ETHUSDT')}
    stab = {k: series('cg_' + k) for k in ('tether', 'usd-coin')}
    def at(s, t):
        lo, hi = 0, len(s) - 1; r = None
        while lo <= hi:
            m = (lo + hi) // 2
            if s[m][0] <= t: r = s[m]; lo = m + 1
            else: hi = m - 1
        return r
    def ret(s, t, d):
        a = at(s, t); b = at(s, t - d * 86400)
        return (a[1] / b[1] - 1) if a and b and b[1] else None
    def depeg(t):
        lows = [p for k in stab for (ts, p) in stab[k] if t - 3 * 86400 <= ts <= t]
        m = min(lows) if lows else None
        return (m is not None and m < 0.997), {'stable_min_3d': round(m, 4) if m else None}
    def cascade(t):
        worst = None
        for d in range(0, 3):
            a = at(btc, t - d * 86400); b = at(btc, t - (d + 1) * 86400)
            if a and b: x = a[3] / b[1] - 1; worst = x if worst is None else min(worst, x)
        return (worst is not None and worst <= -0.05), {'btc_worst_intraday_low_vs_prev_close_3d': round(worst, 4) if worst is not None else None}
    def beta(t):
        r7 = ret(btc, t, 7)
        return (r7 is not None and r7 <= -0.05), {'btc_7d_ret': round(r7, 4) if r7 is not None else None, 'eth_7d_ret': round(ret(eth, t, 7) or 0, 4)}
    def altseason(t):
        b = ret(btc, t, 30); outs = [ret(s, t, 30) for s in alts.values()]; outs = [o for o in outs if o is not None]
        br = sum(1 for o in outs if b is not None and o > b) / len(outs) if outs and b is not None else None
        eb = ret(ethbtc, t, 30)
        return (br is not None and br <= 0.25), {'alt_breadth_30d': round(br, 3) if br is not None else None, 'ethbtc_30d': round(eb, 4) if eb is not None else None, 'alt_season': br is not None and br >= 0.75}
    return {'depeg': depeg, 'cascade': cascade, 'beta': beta, 'altseason': altseason, 'at': at, 'btc': btc}

US_HOL = {'01-01', '07-04', '12-25', '11-27', '11-26', '05-25', '09-07', '01-19', '02-16', '06-19'}
def season_feats(t):
    d = dt.datetime.fromtimestamp(t, UTC)
    last_fri = (d.weekday() == 4 and (d + dt.timedelta(days=7)).month != d.month)
    cme_closed = d.weekday() == 5 or (d.weekday() == 4 and d.hour >= 21) or (d.weekday() == 6 and d.hour < 22)
    return {'weekend': d.weekday() >= 5, 'month_end_25plus': d.day >= 25, 'options_expiry_last_friday': last_fri, 'cme_closed': cme_closed, 'us_holiday': d.strftime('%m-%d') in US_HOL, 'month': d.month}

def p26(T, C):  # phase classifier on 5-min tape bars (fallback hourly)
    def classify(bs):
        if len(bs) < 6: return None
        c = [b['c'] for b in bs]; v = [b['v'] for b in bs]
        hi, lo = max(c), min(c); last = c[-1]; rng = (hi - lo) / lo if lo else 0
        k = len(bs) // 2; v1, v2 = sum(v[:k]) / k, sum(v[k:]) / (len(v) - k)
        up = c[-1] > c[0] * 1.3; near_hi = last >= hi * 0.85; off_hi = last <= hi * 0.6
        if off_hi and c.index(hi) < len(c) - 2: return 'markdown'
        if near_hi and up and v2 >= v1: return 'markup'
        if near_hi and v2 < v1 * 0.8: return 'distribution'
        if rng < 0.35 and v2 >= v1 * 1.2: return 'accumulation'
        return 'neutral'
    rows_d, rows_a = [], []
    for t in T:
        tp = C['tape'].get(t['mint']) or []
        bs = bars(tp, 300)
        if len(bs) < 8:
            bs = [{'t': r[0], 'c': r[4], 'v': r[5]} for r in t['ohlcv']]
        if len(bs) < 8: rows_d.append(row(t, False, testable=False)); rows_a.append(row(t, False, testable=False)); continue
        ev = event_times(t); first = {}
        for i in range(8, len(bs) + 1):
            ph = classify(bs[max(0, i - 12):i])
            if ph and ph not in first: first[ph] = bs[i - 1]['t']
        td = first.get('distribution'); ta = first.get('accumulation')
        rows_d.append(row(t, td is not None, td, phases=sorted(first, key=first.get)))
        rows_a.append(row(t, ta is not None, ta))
    return rows_d, rows_a

def p32(T, C):  # top-10 share shrinking while price climbs
    def fn(t, tp):
        sup = t['db'].get('supply') or 1e9; bal = defaultdict(float); ck = []
        for i, x in enumerate(tp):
            if MEVBOT.search(x['label']): continue
            bal[x['w']] += x['amt'] if x['side'] == 'BUY' else -x['amt']
            if i % 50 == 49 and x['px']:
                top = sorted((b for b in bal.values() if b > 0), reverse=True)[:10]
                ck.append((x['t'], x['px'], sum(top) / sup * 100))
        hit = None
        for a, b in zip(ck, ck[1:]):
            if b[1] >= a[1] * 1.2 and b[2] <= a[2] - 2: hit = b[0]; break
        return row(t, hit is not None, hit, checkpoints=len(ck))
    return tape_rows(T, C, fn), {'rule': 'net balances rebuilt from the trade tape (MEV-bot wallets excluded); between two 50-trade checkpoints price +20% while the top-10 wallets\' share of supply fell >=2 points'}

def p33(T, C):  # first buyers fresh + funded from one source
    B = C['buyers']; rows = []
    for t in T:
        b = B.get(t['mint'])
        if not b or not b.get('profiles'): rows.append(row(t, False, testable=False)); continue
        pr = [p for p in b['profiles'] if p.get('buy_t')]
        known = [p for p in pr if p.get('first_tx')]
        fresh = [p for p in known if p['buy_t'] - p['first_tx'] <= 3 * 86400]
        fc = Counter(p.get('funder') for p in fresh if p.get('funder'))
        top_f, top_n = (fc.most_common(1)[0] if fc else (None, 0))
        f = len(pr) >= 10 and len(fresh) >= 0.5 * len(pr) and top_n >= 3
        rows.append(row(t, f, max((p['buy_t'] for p in pr), default=None), profiled=len(pr), fresh=len(fresh), history_known=len(known), top_common_funder=top_f, wallets_from_top_funder=top_n))
    pw = P.jload('patterns_wallets.json') or {}
    overlap = [r for r in pw.get('tokens') or [] if r.get('mint') in {t['mint'] for t in T}]
    return rows, {'rule': 'of the first 15 distinct buyers (Nansen tape), >=50% had their first-ever tx <=3 days before buying AND >=3 of those fresh wallets share one funder (oldest-tx SOL sender via public RPC)',
                  'coordination': f'pattern-detector worker fresh-wallet clusters (patterns_wallets.json) overlap {len(overlap)} of these tokens; their top-holder cluster flags are shown alongside live, not recomputed'}

def p34(T, C):  # absorption: volume spike with flat price, side
    rd, rb = [], []
    for t in T:
        tp = C['tape'].get(t['mint']) or []; bs = bars(tp, 300)
        if len(bs) < 8: rd.append(row(t, False, testable=False)); rb.append(row(t, False, testable=False)); continue
        bear = bull = None
        for i in range(6, len(bs)):
            medv = statistics.median(b['v'] for b in bs[i - 6:i]) or 1e-9; b = bs[i]
            if b['v'] >= 3 * medv and abs(b['c'] / b['o'] - 1) <= 0.03:
                if b['bv'] > b['sv'] * 1.2 and bear is None: bear = b['t']
                if b['sv'] > b['bv'] * 1.2 and bull is None: bull = b['t']
        rd.append(row(t, bear is not None, bear, side='sellers absorbing buys' if bear else None))
        rb.append(row(t, bull is not None, bull, side='buyers absorbing sells' if bull else None))
    return rd, rb

def p35(T, C):  # liquidity / mcap floor calibrated on calls.json (point-in-time, live-feed calls) + DB
    calls = (P.jload('calls.json') or {}).get('calls') or []
    pts = [(c['liq0'] / c['mc0'], bool(c.get('rugged')) or (c.get('minPx') and c['px0'] and c['minPx'] / c['px0'] <= 0.3), bool(c.get('maxPx') and c['px0'] and c['maxPx'] / c['px0'] >= 2))
           for c in calls if c.get('liq0') and c.get('mc0') and c['mc0'] > 0]
    best = None; table = []
    for fl in (0.02, 0.03, 0.05, 0.07, 0.1, 0.12, 0.15, 0.2, 0.25):
        a = sum(1 for r, bad, g in pts if r < fl and bad); b = sum(1 for r, bad, g in pts if r >= fl and bad)
        c = sum(1 for r, bad, g in pts if r < fl and not bad); d = sum(1 for r, bad, g in pts if r >= fl and not bad)
        tpr = a / (a + b) if a + b else 0; fpr = c / (c + d) if c + d else 0
        rug_below = a / (a + c) if a + c else None; rug_above = b / (b + d) if b + d else None
        g_below = sum(1 for r, bad, g in pts if r < fl and g) / max(1, a + c); g_above = sum(1 for r, bad, g in pts if r >= fl and g) / max(1, b + d)
        p2_, _ = P.fisher(a, b, c, d)
        e = {'floor': fl, 'below_n': a + c, 'rug_rate_below': round(rug_below, 3) if rug_below is not None else None, 'rug_rate_above': round(rug_above, 3) if rug_above is not None else None,
             'ran2x_rate_below': round(g_below, 3), 'ran2x_rate_above': round(g_above, 3), 'youden_j': round(tpr - fpr, 3), 'p_fisher': round(p2_, 6)}
        table.append(e)
        if (a + c) >= 30 and (best is None or e['youden_j'] > best['youden_j']): best = e
    if best and best['youden_j'] <= 0:
        best = {**[e for e in table if e['floor'] == 0.05][0], 'note': 'NO floor separates rugs: at every candidate floor tokens BELOW it rugged LESS often (Youden J < 0). The rule is not supported by the live-call data; 5% kept as an informational live threshold with zero composite weight.'}
    rows = [row(t, False, testable=False) for t in T]
    return rows, {'calibration_source': f'data/calls.json live-feed calls with liquidity & mcap at call time (n={len(pts)}); outcome = rugged/-70% vs ran 2x', 'table': table, 'chosen_floor': best,
                  'note': 'the 50-token set has no point-in-time liquidity, so this row is evaluated on the calls dataset (both classes) instead'}

def p36(T, C):
    rows = []
    db = sqlite3.connect(f'file:{P.DB}?mode=ro', uri=True)
    bydev = defaultdict(list)
    for m, d, c in db.execute('select mint, dev, created_ts from tokens where dev is not null'): bydev[d].append((m, (c or 0) // 1000))
    for t in T:
        d = C['devs'].get(t['mint']) or {}; dev = t['db'].get('dev')
        cr = d.get('creates_pm12h') or []
        same_db = [m for m, c in bydev.get(dev, []) if m != t['mint'] and abs(c - (t['created_t'] or 0)) <= 86400]
        n = len({x.get('mint') or x['sig'] for x in cr} - {t['mint']}) + len(same_db)
        testable = bool(d) and not d.get('err')
        rows.append(row(t, n >= 1, None, testable=testable, other_launches_same_day=n, rpc_sigs_checked=d.get('near_sigs_checked'), rpc_sigs_in_window=d.get('near_sigs_total')))
    return rows, {'rule': 'deployer created >=1 other pump.fun token within +-12h (RPC: deployer signatures parsed for pump.fun Create) or within 24h in the research DB'}

def p37(T, C):  # discovery burst
    def fn(t, tp):
        seen = set(); B = defaultdict(int)
        for x in tp:
            if x['w'] not in seen: seen.add(x['w']); B[x['t'] // 600 * 600] += 1
        ks = sorted(B); hit = None
        if ks:
            allk = list(range(ks[0], ks[-1] + 600, 600))
            for i in range(6, len(allk)):
                prior = [B.get(k, 0) for k in allk[i - 6:i]]
                if statistics.median(prior) <= 3 and B.get(allk[i], 0) >= max(15, 5 * max(1, statistics.median(prior))): hit = allk[i]; break
        return row(t, hit is not None, hit)
    return tape_rows(T, C, fn), {'rule': '10-min bucket of first-time wallets >= max(15, 5x the median of the prior hour) after a quiet hour (median <=3 new wallets/10 min)'}

def p20(T, C):
    J = C['jito']; rows = []
    for t in T:
        r = J.get(t['mint'])
        if r is None: rows.append(row(t, False, testable=False)); continue
        rows.append(row(t, any(x['flash'] for x in r), None, early_txs=len(r)))
    return rows, {'note': 'flash-loan programs (Solend/marginfi/Kamino/Flash) looked for in the earliest trade txs only'}

def p22(T, C):
    def fn(t, tp):
        n, first = 0, None
        for i, v in enumerate(tp):
            if v['side'] != 'BUY' or v['usd'] < 300: continue
            pre = [x for x in tp[max(0, i - 2):i] if x['side'] == 'BUY' and x['w'] != v['w'] and v['t'] - x['t'] <= 1]
            for a in pre:
                if any(y['w'] == a['w'] and y['side'] == 'SELL' and 0 <= y['t'] - v['t'] <= 30 for y in tp[i + 1:i + 40]): n += 1; first = first or v['t']; break
        return row(t, n >= 2, first, frontruns=n)
    return tape_rows(T, C, fn), {'rule': 'wallet buys <=1 s before a >=$300 buy and sells within 30 s after it; flag at >=2 (superset of #8 with a longer exit window)'}

def p23(T, C):
    J = C['jito']; rows = []
    for t in T:
        r = J.get(t['mint'])
        if not r: rows.append(row(t, False, testable=False)); continue
        tipped = {x['trader'] for x in r if x['jito_tip'] and x['action'] == 'BUY'}
        slots = Counter(x['slot'] for x in r if x['action'] == 'BUY'); same_slot = max(slots.values()) if slots else 0
        rows.append(row(t, len(tipped) >= 3 or same_slot >= 4, None, jito_tipped_buyers=len(tipped), max_buys_same_slot=same_slot, early_txs=len(r)))
    return rows, {'rule': '>=3 distinct first-2-second buyers paid a Jito tip, or >=4 buys landed in one slot (bundle)'}

# ---------------- catalog-level market tests (both classes) ----------------
def catalog_events():
    ev = []
    el = P.jload('events_labeled.json')
    if el:
        for e in (el.get('events') if isinstance(el, dict) else el) or []:
            t = e.get('t') or e.get('peak_t')
            if not t and e.get('date'):
                try: t = int(dt.datetime.fromisoformat(e['date']).replace(tzinfo=UTC).timestamp()) + 43200
                except Exception: t = None
            cls = str(e.get('class') or '').lower()
            if t and cls in ('crash', 'rug', 'pump'): ev.append({'t': int(t / 1000) if t > 1e11 else int(t), 'cls': 'pump' if cls == 'pump' else 'crash', 'raw': cls, 'src': 'events_labeled'})
        if ev: return ev, 'data/events_labeled.json (crash+rug n=%d vs pump n=%d with a timestamp)' % (sum(1 for e in ev if e['cls'] == 'crash'), sum(1 for e in ev if e['cls'] == 'pump'))
    for c in (P.jload('crash_catalog.json') or {}).get('catalog', []):
        if c.get('ath_date') and not c.get('artifact_risk'):
            ev.append({'t': int(dt.datetime.fromisoformat(c['ath_date']).replace(tzinfo=UTC).timestamp()) + 43200, 'cls': 'crash', 'sym': c.get('symbol')})
    db = sqlite3.connect(f'file:{P.DB}?mode=ro', uri=True)
    for m, s, c, h2 in db.execute("select mint, symbol, created_ts, hours_to_2x from tokens where cohort='mooned' and created_ts is not null"):
        ev.append({'t': c // 1000 + int((h2 or 0) * H), 'cls': 'pump', 'sym': s})
    for (cg, sym, mult) in []: pass
    return ev, 'crash_catalog.json ATH dates (crash onsets, n=%d) + research-DB mooned cohort breakouts' % sum(1 for e in ev if e['cls'] == 'crash')

def catalog_test(events, fn):
    rows = []
    for e in events:
        f, det = fn(e['t'])
        if det and all(v is None for v in det.values() if not isinstance(v, bool)): continue
        rows.append({'cohort': 'died' if e['cls'] == 'crash' else 'mooned', 'flag': f, 'testable': True})
    return stats2([{**r, 'symbol': '', 'mint': ''} for r in rows])

# ---------------- main ----------------
def main():
    T = P.test_set()
    C = {'tape': {}, 'sm': {}, 'sells': {}, 'devs': cache_json('devs.json'), 'buyers': cache_json('buyers.json'), 'jito': cache_json('jito.json'),
         'meta': cache_json('meta.json'), 'market': cache_json('market.json')}
    for t in T:
        for k in ('tape', 'sm', 'sells'):
            v = nget(k, t)
            if v is not None: C[k][t['mint']] = sorted(v, key=lambda x: x['t'])
    # fake-volume detector (lib/fakevolume.js) on each tape
    inp = {m: [{'t': x['t'], 'trader': x['w'], 'side': x['side'].lower(), 'usd': x['usd'], 'amt': x['amt']} for x in tp] for m, tp in C['tape'].items()}
    try:
        out = subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'fv_bridge.js')], input=json.dumps(inp), capture_output=True, text=True, timeout=120)
        C['fv'] = json.loads(out.stdout or '{}')
    except Exception as e: P.log('fv bridge err', e); C['fv'] = {}
    MK = mk_market(C) if C['market'] else None
    R = {}
    def put(pid, rows, extra=None, **kw):
        R[pid] = {'stats': stats2(rows), 'rows': rows, **(extra or {}), **kw}
    r, x = p1(T, C); put(1, r, x)
    r, x = p2(T, C); put(2, r, x)
    r, x = p3(T, C); put(3, r, x)
    r, x = p4p5(T, C, 'freeze_auth'); put(5, r, x)
    r, x = p4p5(T, C, 'mint_auth'); put(4, r, x)
    r, x = p6(T, C); put(6, r, x)
    r, x = p7(T, C); put(7, r, x)
    r, x = p8(T, C); put(8, r, x)
    r, x = p9(T, C); put(9, r, x)
    r, x = p10(T, C); put(10, r, x)
    (r11, x11), (r12, x12) = p11p12(T, C); put(11, r11, x11); put(12, r12, x12)
    r, x = p13(T, C); put(13, r, x)
    put(14, [row(t, False, testable=False) for t in T], {'note': 'pump.fun memecoins have no vesting schedules; historical unlock dates for the catalog are paywalled (DefiLlama emissions HTTP 402, Tokenomist 403) so a peak-vs-unlock backtest is not possible from free data. Live: lib/unlocks.js calendar (next cliffs) wrapped.'})
    r, x = p15(T, C); put(15, r, x)
    r, x = p20(T, C); put(20, r, x)
    put(21, [row(t, False, testable=False) for t in T], {'note': 'EVM-only heuristics (verified source / bytecode); the test set is Solana. Live: applied to lib/contractscan.js results'})
    r, x = p22(T, C); put(22, r, x)
    r, x = p23(T, C); put(23, r, x)
    rd, ra = p26(T, C); put(26, rd, {'variant_accumulation_early_entry': {'stats': stats2(ra), 'rows': ra}})
    r, x = p32(T, C); put(32, r, x)
    r, x = p33(T, C); put(33, r, x)
    rd, rb = p34(T, C); put(34, rd, {'side': 'bearish: sellers absorbing buys (buy volume >1.2x sell volume, price flat)', 'variant_bullish_absorption': {'side': 'buyers absorbing sells', 'stats': stats2(rb), 'rows': rb}})
    r, x = p35(T, C); put(35, r, x)
    r, x = p36(T, C); put(36, r, x)
    r, x = p37(T, C); put(37, r, x)
    # market-wide (50-set + full catalog)
    evs, evsrc = catalog_events()
    if MK:
        for pid, key, note in ((16, 'depeg', 'USDT or USDC daily price < $0.997 in the 3 days before the event'), (18, 'cascade', 'BTC intraday low <= -5% vs the prior close in the 3 days before the event (liquidation-cascade day proxy)'),
                               (28, 'beta', 'BTC 7-day return <= -5% at the event (risk-off beta regime)'), (29, 'altseason', 'alt breadth (share of 28 large alts beating BTC over 30d) <= 25% = BTC season')):
            rows = market_rows(T, C, MK[key])
            put(pid, rows, {'rule': note, 'catalog': {'source': evsrc, 'stats': catalog_test(evs, MK[key])}})
        if True:
            rows = market_rows(T, C, lambda tt: (season_feats(tt)['weekend'], season_feats(tt)))
            feats = {}
            for fk in ('weekend', 'month_end_25plus', 'options_expiry_last_friday', 'cme_closed', 'us_holiday'):
                feats[fk] = {'test_set': stats2(market_rows(T, C, lambda tt, fk=fk: (season_feats(tt)[fk], {}))), 'catalog': catalog_test(evs, lambda tt, fk=fk: (season_feats(tt)[fk], {}))}
            put(27, rows, {'features': feats, 'rule': 'event falls on a weekend (headline feature); day-of-month, options-expiry, CME-closed and US-holiday variants tested separately (multiple testing: treat p<0.01 as the bar)'})
    for pid, why in ((17, 'no free historical Solana priority-fee series (lib/fees.js only accumulates from its first run; EVM backfill is 7 days) - live only'),
                     (19, 'pump.fun tokens have no oracle feeds - live only via lib/oracles.js (riskinfra_oracles.json)'), (24, 'no oracle/TWAP consumers for these tokens - live only via riskinfra_oracles twap checks'),
                     (25, 'exchange halts are information events; no historical halt list for these tokens (none are CEX-listed) - live headline scan only'),
                     (30, 'no perps on these tokens; wrapped from lib/fundingdiv.js 90d study'), (31, 'no perps on these tokens; wrapped from liquidations_history.json OI study')):
        if pid not in R: put(pid, [row(t, False, testable=False) for t in T], {'note': why})
    fd = P.jload('fundingdiv_history.json') or {}; lh = P.jload('liquidations_history.json') or {}
    R[30]['wrapped_study'] = {'source': 'data/fundingdiv_history.json (lib/fundingdiv.js)', 'summary': {k: fd.get(k) for k in list(fd)[:6] if k not in ('tokens', 'episodes')}, 'composite_note': 'positive-outlier funding episode: 7d dump rate 9.2% vs 2.7% base, p=1e-5 (from lib/composite.js header)'}
    R[31]['wrapped_study'] = {'source': 'data/liquidations_history.json binance_metrics', 'oi_metrics': {k: (lh.get('binance_metrics') or {}).get(k) for k in ('oi_coin_chg_prev', 'px_chg_prev', 'oi_flush_10pct_same_day', 'n_crash_days', 'n_control_days')}}
    cov = {t['symbol'] + ':' + t['mint'][:4]: {'tape': len(C['tape'].get(t['mint']) or []), 'tape_covers_peak': bool(C['tape'].get(t['mint'])) and C['tape'][t['mint']][-1]['t'] >= t['peak_t'], 'sm': len(C['sm'].get(t['mint']) or []), 'sells': len(C['sells'].get(t['mint']) or [])} for t in T}
    P.save('patternlab_backtest.json', {'test_set': {'source': 'data/patterns_flows.json tokens (30 crashed from crash catalog + 20 runners) joined with research DB', 'n_crashed': sum(t['crashed'] for t in T), 'n_runners': sum(not t['crashed'] for t in T)},
                                        'definitions': {'dump_time': 'crash break (-30% from peak) or first hourly close <= 70% of peak high', 'breakout_time': 'created + hours_to_2x (research DB), fallback peak',
                                                        'crash_p': 'Fisher exact one-sided crashed>runners', 'pump_p': 'Fisher exact one-sided runners>crashed'},
                                        'coverage': cov, 'patterns': {str(k): v for k, v in sorted(R.items())}, 'nansen_ledger': {'used_total': P.NL.get('used'), 'balance_start': P.NL.get('balance_start'), 'remaining': P.NL.get('remaining')}})
    for k, v in sorted(R.items()):
        s = v['stats']; print(k, s['verdict'], 'D', s['flag_crashed'], '/', s['n_crashed'], 'M', s['flag_runners'], '/', s['n_runners'], 'pc', s['p_crash_one_sided'], 'pp', s['p_pump_one_sided'], 'lead', s['lead_crash_h_median'], s['lead_pump_h_median'])

if __name__ == '__main__':
    main()
