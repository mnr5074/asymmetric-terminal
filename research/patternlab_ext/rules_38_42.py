#!/usr/bin/env python3
"""Expansion rules 38-42 -> data/patternlab_ext_38_42.json. Free data + cached Nansen tapes (no new spend here).
Convention (no lookahead): a token-level flag must fire BEFORE the peak (flag_t < peak_t). Crash lead = dump_t - flag_t,
pump lead = peak_t - flag_t. Both directions scored by extcommon.stats2."""
import os, sys, math, json, collections, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extcommon as E, tapes as T
from extcommon import stats2

def evt_fisher(tp_in, fp_in, tp_out, fp_out):
    p2, pg = E.fisher(tp_in, fp_in, tp_out, fp_out)
    pin = tp_in / (tp_in + fp_in) if tp_in + fp_in else None; pout = tp_out / (tp_out + fp_out) if tp_out + fp_out else None
    fp_all = fp_in + fp_out; tp_all = tp_in + tp_out
    return {'tp_in': tp_in, 'fp_in': fp_in, 'tp_out': tp_out, 'fp_out': fp_out,
            'precision_all': round(tp_all / (tp_all + fp_all), 3) if tp_all + fp_all else None,
            'precision_in_window': round(pin, 3) if pin is not None else None, 'precision_out_window': round(pout, 3) if pout is not None else None,
            'false_signals_removed_pct': round(100 * fp_out / fp_all, 1) if fp_all else None,
            'true_signals_kept_pct': round(100 * tp_in / tp_all, 1) if tp_all else None,
            'p_fisher_in_vs_out': round(p2, 4), 'p_in_better_one_sided': round(pg, 4)}

# ---------------- 38: per-token active window ----------------
def prior_hours():
    h = E.jload('patterns_hours.json') or {}
    share = h.get('baseline_volume_share') or [1 / 24] * 24
    return share

def active_hours(bars, prior, cover=0.6, maxh=12):
    vol = [0.0] * 24
    for b in bars: vol[time.gmtime(b[0]).tm_hour] += b[5] or 0
    tot = sum(vol)
    if tot <= 0 or len(bars) < 72: vol, tot = list(prior), sum(prior)
    order = sorted(range(24), key=lambda i: -vol[i]); s = 0; out = set()
    for i in order:
        out.add(i); s += vol[i]
        if s >= cover * tot or len(out) >= maxh: break
    return out

def r38(full, core):
    prior = prior_hours()
    ev = {'dump': [0, 0, 0, 0], 'pump': [0, 0, 0, 0]}  # tp_in, fp_in, tp_out, fp_out
    sess = collections.Counter()
    tok_rows = {}
    for t in full:
        bars = t.get('ohlcv') or []
        flag_t = None; flag_tp = None
        for i in range(25, len(bars) - 1):
            b = bars[i]; pc = bars[i - 1][4]
            if not pc or not b[4]: continue
            r = b[4] / pc - 1
            vm = T.median([x[5] for x in bars[i - 24:i]]) or 0
            if vm <= 0 or (b[5] or 0) < 2 * vm: continue
            kind = 'dump' if r <= -0.15 else 'pump' if r >= 0.15 else None
            if not kind: continue
            fut = bars[i + 1:i + 25]
            if not fut: continue
            tp = (min(x[3] for x in fut) <= 0.8 * b[4]) if kind == 'dump' else (max(x[2] for x in fut) >= 1.2 * b[4])
            win = active_hours(bars[max(0, i - 168):i], prior)
            inw = time.gmtime(b[0]).tm_hour in win
            k = (0 if tp else 1) + (0 if inw else 2)
            ev[kind][k] += 1
            hr = time.gmtime(b[0]).tm_hour; sess[('asia' if hr < 8 else 'eu' if hr < 13 else 'us' if hr < 21 else 'late_us') + ('_in' if inw else '_out') + ('_tp' if tp else '_fp')] += 1
            if kind == 'dump' and inw and flag_t is None and i < 72: flag_t = b[0] + 3600
        tok_rows[t['mint']] = {**E.base(t), 'flag': flag_t is not None, 'flag_t': flag_t,
                               'testable': len(bars) >= 27}
    # smart-money hours from cached tapes (global prior; per-token only when >=5 SM trades)
    smh = [0] * 24; nsm = 0
    for t in core:
        for r in T.tape(t):
            if T.is_sm(r.get('trader_address_label')): smh[time.gmtime(r['ts']).tm_hour] += 1; nsm += 1
    rows_core = [tok_rows[t['mint']] for t in core if t['mint'] in tok_rows]
    return E.row(38, 'Per-token active-window filter', 'built',
                 'built on hourly GT volume (rolling 7d per-token window, cohort prior when <72h history). Crashed tokens die within hours, so the token-level row is mostly untestable for them; the real test is event-level precision across every dump/pump alert bar in the full catalog.',
                 'Every token has hours when it actually trades (Asia vs US open). A sudden dump/pump bar that happens outside the hours that carry 60% of its own recent volume is more often noise. The filter discounts alerts outside the token\'s window and we measure how many false alerts that removes vs how many true ones it keeps.',
                 core=stats2(rows_core), full=stats2(list(tok_rows.values())),
                 extra={'dump_alerts': evt_fisher(*ev['dump']), 'pump_alerts': evt_fisher(*ev['pump']),
                        'alert_def': '1h close-to-close <= -15% (dump) / >= +15% (pump) with volume >= 2x trailing-24h median; TRUE if within next 24h low <= -20% (dump) / high >= +20% (pump) from alert close',
                        'window_def': 'smallest set of UTC hours carrying >=60% of the token\'s trailing-168h volume (max 12h); cohort prior (patterns_hours baseline) when <72 bars',
                        'session_breakdown': dict(sess), 'smart_money_trade_hours_utc': smh, 'smart_money_trades': nsm,
                        'smart_money_note': 'Nansen-labelled smart/fund/KOL trades in the cached launch tapes; too few per token to learn a per-token SM window, shown as a global prior'})

# ---------------- 39: vol compression (+catalyst) ----------------
def r39(full):
    # hourly memecoin event study
    n = {'c_exp': 0, 'c_no': 0, 'u_exp': 0, 'u_no': 0, 'c_up': 0, 'c_dn': 0}
    rows = []
    for t in full:
        bars = t.get('ohlcv') or []
        flag_t = None
        for i in range(14 * 24 + 24, len(bars) - 72, 6):
            rvs = [T.rv(bars[j - 24:j]) for j in range(i - 14 * 24, i + 1, 6)]
            rvs = [x for x in rvs if x is not None]
            if len(rvs) < 20: continue
            cur = rvs[-1]; comp = cur <= min(rvs[:-1]) * 1.0001
            c = bars[i][4]; fut = bars[i + 1:i + 73]
            if not c or not fut: continue
            up = max(x[2] for x in fut) / c - 1; dn = 1 - min(x[3] for x in fut) / c
            exp = max(up, dn) >= 0.30
            if comp:
                n['c_exp' if exp else 'c_no'] += 1
                if exp: n['c_up' if up >= dn else 'c_dn'] += 1
                if flag_t is None and t.get('peak_t') and bars[i][0] < t['peak_t'] and bars[i][0] > t['peak_t'] - 14 * 86400: flag_t = bars[i][0]
            else: n['u_exp' if exp else 'u_no'] += 1
        pre = [b for b in bars if t.get('peak_t') and b[0] < t['peak_t']]
        rows.append({**E.base(t), 'flag': flag_t is not None, 'flag_t': flag_t, 'testable': len(pre) >= 14 * 24 + 24, 'mint': t['mint']})
    p2, pg = E.fisher(n['c_exp'], n['c_no'], n['u_exp'], n['u_no'])
    hourly = {**n, 'p_exp_given_compressed': round(n['c_exp'] / max(1, n['c_exp'] + n['c_no']), 3), 'p_exp_base': round(n['u_exp'] / max(1, n['u_exp'] + n['u_no']), 3),
              'p_fisher': round(p2, 4), 'p_compressed_more_expansion': round(pg, 4), 'def': 'compressed = 24h realized vol at its 14-day low (6h steps); expansion = |max move| >= 30% within 72h'}
    # majors daily (CoinGecko cached series)
    d = {'c_exp': 0, 'c_no': 0, 'u_exp': 0, 'u_no': 0, 'c_up': 0, 'c_dn': 0}; live = []
    import glob
    uc = {(x.get('geckoId') or ''): x for x in (E.jload('unlocks_calendar.json') or {}).get('tokens', []) if x.get('geckoId')}
    gs = (E.jload('grok_signals.json') or {}).get('tokens', {})
    for f in glob.glob(os.path.join(E.DATA_DIR, 'cg_series', '*.json')):
        try: px = [p[1] for p in json.load(open(f))['prices']]
        except Exception: continue
        lr = [math.log(b / a) for a, b in zip(px, px[1:]) if a and b and a > 0 and b > 0]
        def rv7(j): seg = lr[j - 7:j]; m = sum(seg) / 7; return math.sqrt(sum((x - m) ** 2 for x in seg) / 7)
        for j in range(49, len(lr) - 14):
            hist = [rv7(k) for k in range(j - 42, j)]; cur = rv7(j)
            comp = cur <= min(hist)
            c = px[j]; fut = px[j + 1:j + 15]
            mv = max(abs(x / c - 1) for x in fut); exp = mv >= 0.20
            if comp:
                d['c_exp' if exp else 'c_no'] += 1
                if exp: d['c_up' if max(fut) / c - 1 >= 1 - min(fut) / c else 'c_dn'] += 1
            else: d['u_exp' if exp else 'u_no'] += 1
        gid = os.path.basename(f)[:-5]
        if len(lr) > 50:
            j = len(lr); cur = rv7(j); hist = [rv7(k) for k in range(j - 42, j)]
            pct = sum(1 for h in hist if h < cur) / len(hist)
            u = uc.get(gid); cl = [c for c in (u or {}).get('cliffs', []) if c.get('daysAway', 99) <= 14 and (c.get('pctCirc') or 0) >= 0.5]
            sym = (u or {}).get('sym') or gid.upper()
            g = gs.get(sym.upper())
            cat = [f"unlock {c['date']} {c['pctCirc']:.1f}% circ" for c in cl[:2]] + ([f"grok news n={g['n']} urg={g['maxUrg']}"] if g else [])
            if pct <= 0.1 and cat: live.append({'symbol': sym, 'gecko': gid, 'rv7_pctile_42d': round(pct, 2), 'catalysts': cat, 'why': 'realized vol at multi-week low with catalyst ahead'})
    p2d, pgd = E.fisher(d['c_exp'], d['c_no'], d['u_exp'], d['u_no'])
    daily = {**d, 'p_exp_given_compressed': round(d['c_exp'] / max(1, d['c_exp'] + d['c_no']), 3), 'p_exp_base': round(d['u_exp'] / max(1, d['u_exp'] + d['u_no']), 3),
             'p_fisher': round(p2d, 4), 'p_compressed_more_expansion': round(pgd, 4), 'def': 'compressed = 7d realized vol <= min of prior 42 days; expansion = |max move| >= 20% within 14d; 246 CoinGecko majors, 365d'}
    return E.row(39, 'Vol compression before catalyst', 'partial',
                 'built: compression detector + event study on memecoin hourly and 246 majors daily; catalyst conditioning (DefiLlama unlock cliffs, grok_signals news) is live-only because there is no free historical catalyst calendar. Crashed test tokens die before a multi-week window exists (untestable).',
                 'When a coin\'s realized volatility sinks to its lowest level in weeks right before a known event (unlock, listing, upgrade, news), a large move often follows. The rule flags the squeeze; the event study checks whether big moves really are more likely after a squeeze than at other times, and which direction they break.',
                 full=stats2(rows), live=live[:30], extra={'hourly_event_study': hourly, 'daily_majors_event_study': daily})

# ---------------- 40: fair value vs peers ----------------
def r40(full):
    pts = []  # (age bucket, log ratio) for peer medians
    per = {}
    for t in full:
        sup = t['db'].get('supply') or 0
        bars = t.get('ohlcv') or []; ct = t.get('created_t') or (bars[0][0] if bars else None)
        if not sup or not bars or not ct: continue
        cum = 0.0; seq = []
        for b in bars:
            cum += b[5] or 0
            if b[0] - ct > 48 * 3600: break
            if cum <= 0 or not b[4]: continue
            age = max(1, (b[0] + 3600 - ct) / 3600); bk = int(math.log2(age))
            lr = math.log(b[4] * sup / cum); seq.append((b[0] + 3600, bk, lr)); pts.append((bk, lr))
        per[t['mint']] = seq
    import statistics as st
    bym = collections.defaultdict(list)
    for bk, lr in pts: bym[bk].append(lr)
    pm = {bk: st.median(v) for bk, v in bym.items() if len(v) >= 5}
    TH = math.log(3)
    rows_o, rows_u = [], []
    for t in full:
        seq = per.get(t['mint'])
        fo = next((ts for ts, bk, lr in (seq or []) if bk in pm and lr - pm[bk] >= TH), None)
        fu = next((ts for ts, bk, lr in (seq or []) if bk in pm and lr - pm[bk] <= -TH), None)
        base = {**E.base(t), 'testable': bool(seq)}
        rows_o.append({**base, 'flag': fo is not None, 'flag_t': fo}); rows_u.append({**base, 'flag': fu is not None, 'flag_t': fu})
    fv = E.jload('patternlab_ext_fairvalue.json') or {}
    return [E.row(40, 'Rich vs peers (mcap / cumulative volume) → mean reversion', 'partial',
                  'memecoins have no revenue/TVL, so the backtest uses the closest free proxy: market cap per $ of cumulative traded volume vs age-matched peers (>=3x the peer median = rich). FDV/TVL and FDV/fees vs DefiLlama category peers are computed for majors (live flags + 90d-back test in research/patternlab_ext/fairvalue_majors.py).',
                  'If a token is priced far above comparable projects for what it actually does (fees, TVL, or for memecoins: trading activity per $ of market cap), it tends to drift back toward the peer level. Rich = at least 3x the peer median.',
                  full=stats2(rows_o), live=(fv.get('live_rich') or [])[:30], extra={'peer_medians_by_log2_age_h': {str(k): round(v, 2) for k, v in pm.items()}, 'majors': fv.get('summary')}),
            E.row('40b', 'Cheap vs peers (mcap / cumulative volume <= 1/3 peer median)', 'partial',
                  'mirror of 40 (undervalued side) — tested as a pump predictor', 'A token trading at a third of what peers with similar activity are worth may re-rate upward.',
                  full=stats2(rows_u), live=(fv.get('live_cheap') or [])[:30])]

# ---------------- 41: stealth accumulation ----------------
def socials_at(t, ts):
    d = t['db']; has = (d.get('has_twitter') or 0) + (d.get('has_telegram') or 0) + (d.get('has_website') or 0)
    if not has: return 0
    pd = d.get('profile_delay_h'); ct = t.get('created_t')
    if pd is not None and ct and ts < ct + pd * 3600: return 0
    return has

def r41(full, core):
    rows_core = []
    for t in core:
        tr = T.early(T.tape(t), 300)
        if len(tr) < 30: rows_core.append({'cohort': t['cohort'], 'testable': False}); continue
        t0 = tr[0]['ts']; seen = set(); buckets = collections.Counter()
        for r in tr:
            b = (r['ts'] - t0) // 600
            if r['trader_address'] not in seen: seen.add(r['trader_address']); buckets[b] += 1
        nb = max(buckets) + 1 if buckets else 0
        ser = [buckets.get(i, 0) for i in range(min(nb, 12))]
        flag_t = None
        for k in range(3, len(ser) + 1):
            s = ser[:k]; rho = T.spearman(list(range(k)), s)
            ts = t0 + k * 600
            if rho is not None and rho >= 0.5 and s[-1] > s[0] and socials_at(t, ts) == 0: flag_t = ts; break
        rows_core.append({**E.base(t), 'flag': flag_t is not None, 'flag_t': flag_t, 'testable': True})
    rows_full = []
    for t in full:
        bars = T.early_bars(t, 48)
        if len(bars) < 5: rows_full.append({'cohort': t['cohort'], 'testable': False}); continue
        flag_t = None
        for i in range(3, len(bars) - 1):
            seg = [b[5] or 0 for b in bars[i - 3:i + 1]]
            ret = bars[i][4] / bars[i - 3][1] - 1 if bars[i - 3][1] else 0
            if all(b > a for a, b in zip(seg, seg[1:])) and abs(ret) < 0.25 and socials_at(t, bars[i][0] + 3600) == 0: flag_t = bars[i][0] + 3600; break
        rows_full.append({**E.base(t), 'flag': flag_t is not None, 'flag_t': flag_t, 'testable': True})
    live = []
    for x in ((E.jload('live_feed.json') or {}).get('items') or []):
        f = x.get('features') or {}
        soc = x.get('socials') if x.get('socials') is not None else f.get('nSocials')
        if soc in (0, '0') and (f.get('b1') or 0) > (f.get('b6', 0) or 0) / 6 * 1.5 and abs(x.get('ch1') or 0) < 10:
            live.append({'symbol': x.get('symbol'), 'key': x.get('key'), 'why': f"no socials, 1h buys {f.get('b1')} vs 6h avg {round((f.get('b6') or 0) / 6, 1)}, price flat {x.get('ch1')}%"})
    return E.row(41, 'Stealth accumulation (no socials, rising on-chain activity)', 'built',
                 'core50: new unique traders per 10-min bucket from cached Nansen launch tapes (Spearman rho>=0.5 and rising) while the token has no Twitter/Telegram/website yet (profile_delay_h honoured). full: 4 consecutive rising hourly volumes with |price| < 25% and no socials. No paid X reads: "social volume" = presence of any social channel, since historical mention counts for memecoins are not free.',
                 'Wallet count and activity keep climbing while nobody is talking about the token yet. That usually means early buyers are building positions quietly before the crowd shows up.',
                 core=stats2(rows_core), full=stats2(rows_full), live=live[:30])

# ---------------- 42: wallet rotation / closed loop ----------------
def r42(full, core):
    w2t = collections.defaultdict(set); early = {}
    for t in core:
        tr = T.early(T.tape(t), 300)
        ws = {r['trader_address'] for r in tr}
        early[t['mint']] = (ws, tr[0]['ts'] if tr else None)
        for w in ws: w2t[w].add(t['mint'])
    infra = {w for w, s in w2t.items() if len(s) > 12}  # routers / aggregators / pools
    rows = []; loops = collections.Counter()
    for t in core:
        ws, t0 = early[t['mint']]
        if not ws: rows.append({'cohort': t['cohort'], 'testable': False}); continue
        rot = [w for w in ws if w not in infra and 3 <= len(w2t[w]) <= 12]
        share = len(rot) / len(ws)
        for w in rot: loops[tuple(sorted(w2t[w]))] += 1
        rows.append({**E.base(t), 'created_t': t.get('created_t'), 'flag': share >= 0.10 and len(rot) >= 5, 'flag_t': t0, 'testable': True,
                     'share': round(share, 3), 'n_rot': len(rot), 'symbol': t['symbol']})
    sym = {t['mint']: t['symbol'] for t in core}
    top_loops = [{'tokens': [sym[m] for m in k], 'wallets': v} for k, v in loops.most_common(8) if 3 <= len(k) <= 4]
    # full set: top-holder overlap (snapshot, labelled as post-hoc)
    h2t = collections.defaultdict(set)
    for t in full:
        for o, p in t['holders']: h2t[o].add(t['mint'])
    hinfra = {o for o, s in h2t.items() if len(s) > 10}
    rows_f = []
    for t in full:
        hs = [o for o, p in t['holders'] if o not in hinfra]
        if not hs: rows_f.append({'cohort': t['cohort'], 'testable': False}); continue
        rot = [o for o in hs if len(h2t[o]) >= 3]
        rows_f.append({**E.base(t), 'flag': len(rot) >= 2, 'flag_t': None, 'testable': True})
    return E.row(42, 'Wallet rotation / closed loop (same wallets cycling 3-4 tokens)', 'built',
                 'core50: wallets in the first 300 pre-peak trades (cached Nansen tapes) that also trade 3-12 other test tokens (wallets in >12 = routers/infra, excluded). Flag = >=10% of early traders are rotators and >=5 of them. full: top-holder overlap (DB snapshot taken after the peak, so post-hoc only).',
                 'The same group of wallets keeps jumping between the same few tokens: buying one, dumping into the next. That is a closed loop or a farming community, and the price is held up by the group rather than new buyers.',
                 core={**stats2(rows), 'era_matched': {k: v for k, v in stats2([x for x in rows if (x.get('created_t') or 0) >= 1789000000]).items() if k in ('n_crashed', 'n_runners', 'flag_crashed', 'flag_runners', 'p_fisher', 'verdict')}}, full=stats2(rows_f),
                 extra={'top_loops': top_loops, 'per_token': [{k: r[k] for k in ('symbol', 'cohort', 'share', 'n_rot')} for r in rows if r.get('testable')],
                        'infra_wallets_excluded': len(infra)})

if __name__ == '__main__':
    full = E.full(); core = E.core50()
    out = {'schema': 'patternlab-ext-v1', 'rows': []}
    for fn in (lambda: r38(full, core), lambda: r39(full), lambda: r40(full), lambda: r41(full, core), lambda: r42(full, core)):
        try:
            r = fn(); out['rows'] += r if isinstance(r, list) else [r]
        except Exception as e:
            import traceback; traceback.print_exc()
    E.save('patternlab_ext_38_42.json', out)
    for r in out['rows']:
        print(r['id'], r['name'][:40], 'hitC', r.get('hit_crashed'), 'hitR', r.get('hit_runners'), 'p', r.get('p_fisher'), r.get('separates'), 'lead c/p', r.get('crash_lead_h'), r.get('pump_lead_h'))
