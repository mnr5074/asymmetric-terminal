"""Burn/buyback CONSISTENCY study. Reads buyburn data (daily DefiLlama holdersRevenue series + discrete official burns).
Writes data/buyburn_consistency.json (+ copy to repo data/). Run after buyburn.py burns.

Consistency score (0-100) = 100 * (0.30*R + 0.25*A + 0.25*U + 0.20*T)
  R interval regularity = 1/(1+CV of intervals between burn events)
  A amount stability    = 1/(1+CV of burn USD per period)   [period = week for daily/weekly programs, event for quarterly]
  U uptime              = share of expected periods (weeks / quarters) since start that had a burn
  T trend stability     = 1/(1+SD of log change of the rolling level)  [30d sums month-to-month; event-to-event for quarterly]
USD (not tokens) is used for amounts so falling prices do not mechanically inflate the size (price artifact found in part 4).
"""
import json, os, math
import numpy as np, pandas as pd
from scipy import stats
import buyburn as B, buyburn_analysis as A

D = B.DATA
W = dict(R=0.30, A=0.25, U=0.25, T=0.20)

def cv(x):
    x = np.asarray(x, float); x = x[np.isfinite(x)]
    return float(np.std(x, ddof=1) / np.mean(x)) if len(x) > 2 and np.mean(x) > 0 else np.nan

def classify(med, cvi):
    f = 'daily' if med <= 1.5 else 'weekly' if med <= 8 else 'monthly' if med <= 35 else 'quarterly' if med <= 110 else 'irregular'
    return f + (' (irregular)' if cvi == cvi and cvi > 1.0 else '')

def score(R, A_, U, T):
    parts = dict(R=R, A=A_, U=U, T=T)
    if any(v is None or v != v for v in parts.values()): return np.nan
    return 100 * sum(W[k] * v for k, v in parts.items())

# ------------------------------------------------------------ metrics for a daily series window
def daily_metrics(df):
    act = df[df.usd > 0]
    if len(act) < 5: return None
    iv = act.index.to_series().diff().dt.days.dropna()
    med = float(iv.median()); cvi = cv(iv) if len(iv) > 2 else np.nan
    if cvi != cvi: cvi = 0.0
    wk = df.usd.resample('W').sum()
    wk = wk.iloc[1:-1] if len(wk) > 3 else wk          # drop partial first/last weeks
    period = 'W' if med <= 8 else 'M'
    per = df.usd.resample('ME').sum().iloc[1:-1] if period == 'M' else wk
    U = float((per > 0).mean()) if len(per) else np.nan
    A_ = 1 / (1 + cv(per[per > 0])) if (per > 0).sum() > 2 else np.nan
    m30 = df.usd.rolling(30).sum().iloc[29::30]
    lr = np.log(m30[m30 > 0]).diff().dropna()
    T = 1 / (1 + float(lr.std())) if len(lr) > 2 else np.nan
    gap_thr = max(3 * med, 7)
    gaps = [(str(a.date()), int(n)) for a, n in zip(act.index[:-1], iv.values) if n > gap_thr] if len(iv) else []
    pc = df.pct_circ.astype(float); pv = df.pct_vol.astype(float).replace([np.inf, -np.inf], np.nan)
    wkpc = pc.resample('W').sum(min_count=4).iloc[1:-1]; wkpv = (df.usd.resample('W').sum() / df.vol.astype(float).resample('W').sum(min_count=4) * 100).iloc[1:-1]
    # CV over time (rolling 90d CV of weekly USD)
    rcv = wk.rolling(13).apply(lambda x: np.std(x, ddof=1) / np.mean(x) if np.mean(x) > 0 else np.nan, raw=True)
    R = 1 / (1 + cvi)
    return dict(n_events=int(len(act)), median_interval_d=med, cv_interval=cvi, frequency=classify(med, cvi),
                usd_per_period_mean=float(per.mean()), usd_cv=cv(per[per > 0]), pct_circ_weekly_cv=cv(wkpc), pct_vol_weekly_cv=cv(wkpv),
                pct_vol_weekly_median=float(wkpv.median()) if wkpv.notna().any() else None,
                uptime=U, gaps=gaps, n_gaps=len(gaps), trend_sd_log30=float(lr.std()) if len(lr) > 2 else None,
                rolling_cv_weekly_usd={str(k.date()): v for k, v in rcv.dropna().iloc[::4].items()},
                R=R, A=A_, U=U, T=T, score=score(R, A_, U, T))

def discrete_metrics(ev, sym):
    e = ev.sort_values('date'); dts = pd.to_datetime(e.date)
    iv = dts.diff().dt.days.dropna()
    med = float(iv.median()); cvi = cv(iv)
    usd = e.usd.astype(float).values
    R = 1 / (1 + cvi)
    A_ = 1 / (1 + cv(usd))
    exp = max(int(round((dts.iloc[-1] - dts.iloc[0]).days / 91.3)) + 1, len(e))
    # uptime: quarters with >=1 burn / quarters spanned (OKB weekly 2019 start counted per quarter)
    q = dts.dt.to_period('Q').nunique(); span = (dts.iloc[-1].to_period('Q') - dts.iloc[0].to_period('Q')).n + 1
    U = q / span
    lr = np.log(usd[usd > 0]); lr = np.diff(lr)
    T = 1 / (1 + float(np.std(lr, ddof=1))) if len(lr) > 2 else np.nan
    gaps = [(str(a.date()), int(n)) for a, n in zip(dts.iloc[:-1], iv.values) if n > 1.5 * med]
    return dict(n_events=int(len(e)), median_interval_d=med, cv_interval=cvi, frequency=classify(med, cvi),
                usd_per_period_mean=float(np.mean(usd)), usd_cv=cv(usd), pct_circ_cv=cv(e.pct_circ.astype(float)),
                uptime=U, gaps=gaps, n_gaps=len(gaps), trend_sd_log_event=float(np.std(lr, ddof=1)) if len(lr) > 2 else None,
                R=R, A=A_, U=U, T=T, score=score(R, A_, U, T))

# ------------------------------------------------------------ price helpers
def xs_series(sym_gecko):
    px = B.prices(sym_gecko); btc = B.prices('bitcoin')
    idx = px.index.intersection(btc.index)
    return px.reindex(idx), btc.reindex(idx)

def xs_ret(px, btc, t0, days):
    t1 = t0 + pd.Timedelta(days=days)
    try:
        p0, p1, b0, b1 = px.asof(t0), px.asof(t1), btc.asof(t0), btc.asof(t1)
    except Exception: return np.nan
    if t1 > px.index.max() or not all(np.isfinite([p0, p1, b0, b1])): return np.nan
    return (p1 / p0 - b1 / b0) * 100

def cohen_d(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float); a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    if len(a) < 2 or len(b) < 2: return np.nan
    s = math.sqrt(((len(a) - 1) * a.var(ddof=1) + (len(b) - 1) * b.var(ddof=1)) / (len(a) + len(b) - 2))
    return (a.mean() - b.mean()) / s if s > 0 else np.nan

def compare(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float); a, b = a[np.isfinite(a)], b[np.isfinite(b)]
    if len(a) < 3 or len(b) < 3: return dict(n_a=len(a), n_b=len(b))
    t, p = stats.ttest_ind(a, b, equal_var=False); u, pu = stats.mannwhitneyu(a, b)
    return dict(n_a=len(a), n_b=len(b), mean_a=a.mean(), mean_b=b.mean(), median_a=float(np.median(a)), median_b=float(np.median(b)),
                welch_t=t, welch_p=p, mannwhitney_p=pu, cohen_d=cohen_d(a, b))

# ------------------------------------------------------------ regime-change detection
def detect_daily(sym, df):
    flags = []
    s = df.usd; act = s > 0
    start = s[act].index.min()
    s = s[s.index >= start]
    r30 = s.rolling(30).sum(); r90 = s.rolling(90).sum() / 3
    pv = (s.rolling(30).sum() / df.vol.astype(float).reindex(s.index).rolling(30, min_periods=20).sum() * 100)
    pv90 = (s.rolling(90).sum() / df.vol.astype(float).reindex(s.index).rolling(90, min_periods=60).sum() * 100)
    armed = {'drop': True, 'surge': True, 'drop_vol': True}
    for t in s.index[120::7]:                    # weekly checks after 120d warm-up
        a, b = r30.get(t), r90.get(t - pd.Timedelta(days=30))
        if b and b > 0 and a == a:
            ratio = a / b
            if armed['drop'] and ratio < 0.5:
                flags.append(dict(date=str(t.date()), sym=sym, kind='drop>50% (USD 30d vs prior-90d avg)', detail=f'30d ${a/1e6:.2f}M vs trailing avg ${b/1e6:.2f}M/30d ({ratio:.2f}x)')); armed['drop'] = False
            elif ratio > 0.75: armed['drop'] = True
            if armed['surge'] and ratio > 2.0:
                flags.append(dict(date=str(t.date()), sym=sym, kind='surge>2x (USD)', detail=f'30d ${a/1e6:.2f}M vs trailing avg ${b/1e6:.2f}M/30d ({ratio:.2f}x)')); armed['surge'] = False
            elif ratio < 1.5: armed['surge'] = True
        a2, b2 = pv.get(t), pv90.get(t - pd.Timedelta(days=30))
        if b2 and b2 > 0 and a2 == a2:
            if armed['drop_vol'] and a2 / b2 < 0.5:
                flags.append(dict(date=str(t.date()), sym=sym, kind='drop>50% (% of volume)', detail=f'30d buyback {a2:.3f}% of vol vs {b2:.3f}% trailing')); armed['drop_vol'] = False
            elif a2 / b2 > 0.75: armed['drop_vol'] = True
    # stops: zero runs
    z = (~(s > 0)).astype(int); run = 0
    med = s[s > 0].index.to_series().diff().dt.days.median()
    thr = max(14, 3 * (med or 1))
    for t, v in z.items():
        run = run + 1 if v else 0
        if run == thr: flags.append(dict(date=str((t - pd.Timedelta(days=thr - 1)).date()), sym=sym, kind=f'stopped (≥{int(thr)}d no buyback)', detail='DefiLlama shows zero; may be data outage'))
    # frequency shift: active-day share last 60d vs prior 180d
    sh = (s > 0).rolling(60).mean(); sh0 = (s > 0).rolling(180).mean().shift(60)
    armed_f = True
    for t in s.index[240::7]:
        a, b = sh.get(t), sh0.get(t)
        if b and b > 0 and a == a:
            if armed_f and (a / b < 0.5 or a / b > 2):
                flags.append(dict(date=str(t.date()), sym=sym, kind='frequency shift', detail=f'active-day share 60d {a:.2f} vs prior {b:.2f}')); armed_f = False
            elif 0.75 < a / b < 1.33: armed_f = True
    return flags

def detect_discrete(sym, ev):
    flags = []; e = ev.sort_values('date').reset_index(drop=True)
    for i in range(4, len(e)):
        prev = e.usd.iloc[i - 4:i].astype(float).mean(); cur = float(e.usd.iloc[i])
        if cur < 0.5 * prev: flags.append(dict(date=e.date.iloc[i], sym=sym, kind='drop>50% (USD vs prior-4 avg)', detail=f'${cur/1e6:.1f}M vs ${prev/1e6:.1f}M'))
        if cur > 2 * prev: flags.append(dict(date=e.date.iloc[i], sym=sym, kind='surge>2x (USD vs prior-4 avg)', detail=f'${cur/1e6:.1f}M vs ${prev/1e6:.1f}M'))
    return flags

MANUAL = [  # documented structural changes (official/news), date = announcement/execution
 ('2025-08-15', 'OKB', 'program ended (one-time 65.26M burn, supply fixed 21M)'),
 ('2026-01-23', 'BGB', 'quarterly burn size cut ~90% (30M -> 3.06M BGB; Morph-fee formula)'),
 ('2025-12-24', 'HYPE', 'AF HYPE formally recognized as burned (vote)'),
 ('2026-04-28', 'PUMP', 'switch 100% revenue->treasury to 50% revenue auto buy&burn + burn of all repurchased'),
 ('2026-06-17', 'ASTER', 'switch to 99% fee daily TWAP buyback + matched reserve burn'),
 ('2026-07-10', 'LIT', 'treasury buybacks -> burn; 15.64M burned'),
 ('2025-12-28', 'UNI', 'fee-switch burn starts + 100M retro burn'),
]

def main():
    daily = A.load_daily()
    ev = pd.DataFrame(json.load(open(os.path.join(D, 'buyburn_events.json')))['events'])
    meta = {t['sym']: t for t in B.TOKENS}
    rows, flags = {}, []
    for sym, df in daily.items():
        key = 'BNB-gas' if sym == 'BNB' else sym
        m = daily_metrics(df)
        if not m: continue
        m.update(sym=key, type=meta[sym]['type'], source='DefiLlama holdersRevenue daily', start=str(df[df.usd > 0].index.min().date()))
        rows[key] = m
        for f in detect_daily(key, df): f['gecko'] = meta[sym]['gecko']; flags.append(f)
    for sym, sub in [('BNB-Q', ev[(ev.sym == 'BNB') & (ev.kind == 'periodic')]), ('OKB', ev[(ev.sym == 'OKB') & (ev.date < '2025-08-01')]), ('BGB', ev[ev.sym == 'BGB'])]:
        m = discrete_metrics(sub, sym); g = meta[sym.split('-')[0]]['gecko']
        m.update(sym=sym, type=meta[sym.split('-')[0]]['type'], source='official burn announcements', start=sub.date.min())
        rows[sym] = m
        for f in detect_discrete(sym, sub): f['gecko'] = g; flags.append(f)
    for d0, s, what in MANUAL:
        flags.append(dict(date=d0, sym=s, kind='documented structural change', detail=what, gecko=meta[s]['gecko']))
    rows['SUN'] = dict(sym='SUN', note='insufficient data: only aggregate (51 rounds since 2021-12, 678.5M SUN) + 51st round; ~quarterly per SunSwap', score=None, frequency='quarterly (stated)')

    # ---------- excess returns per token (trailing 3/6/12m to today; and over program life)
    today = B.TODAY - pd.Timedelta(days=1)
    for k, m in rows.items():
        if m.get('score') is None: continue
        g = meta[k.split('-')[0]]['gecko']; px, btc = xs_series(g)
        for lab, n in [('3m', 91), ('6m', 182), ('12m', 365)]:
            m[f'xs_trailing_{lab}'] = xs_ret(px, btc, today - pd.Timedelta(days=n), n)
        st = pd.Timestamp(m['start']); yrs = (today - st).days / 365
        p0, p1, b0, b1 = px.asof(st), px.asof(today), btc.asof(st), btc.asof(today)
        m['xs_log_per_year_program'] = (math.log(p1 / p0) - math.log(b1 / b0)) / yrs if yrs > 0.25 else np.nan
    # ---------- (a) group comparison: top tercile vs bottom tercile of score (+ 'sporadic large' = discrete lumpy programs)
    sc = pd.DataFrame([dict(sym=k, score=v['score'], **{c: v.get(c) for c in ['xs_trailing_3m', 'xs_trailing_6m', 'xs_trailing_12m', 'xs_log_per_year_program', 'frequency', 'usd_cv', 'type']}) for k, v in rows.items() if v.get('score') is not None and k != 'BNB-gas']).sort_values('score', ascending=False)  # BNB counted once (BNB-Q) in tests
    q1, q2 = sc.score.quantile([1 / 3, 2 / 3])
    hi, lo = sc[sc.score >= q2], sc[sc.score <= q1]
    group = dict(definition=f'high = score >= {q2:.1f} (top tercile), low/sporadic = score <= {q1:.1f} (bottom tercile)', high=list(hi.sym), low=list(lo.sym),
                 token_level={c: compare(hi[c], lo[c]) for c in ['xs_trailing_3m', 'xs_trailing_6m', 'xs_trailing_12m', 'xs_log_per_year_program']})
    # token-month panel: monthly excess returns during program life, grouped by score tercile
    panel = []
    for _, r in sc.iterrows():
        g = meta[r.sym.split('-')[0]]['gecko']; px, btc = xs_series(g)
        st = pd.Timestamp(rows[r.sym]['start']); me = pd.date_range(st, today, freq='ME')
        for a, b in zip(me[:-1], me[1:]):
            panel.append(dict(sym=r.sym, grp='high' if r.score >= q2 else 'low' if r.score <= q1 else 'mid', xsr=xs_ret(px, btc, a, (b - a).days)))
    P = pd.DataFrame(panel)
    group['token_month_panel'] = compare(P[P.grp == 'high'].xsr, P[P.grp == 'low'].xsr)
    group['token_month_panel']['note'] = 'months pooled across tokens; observations not independent across tokens in same month -> p optimistic'
    # sporadic-large events vs continuous-days: excess after one-off big burns / discrete burns vs random program days
    evx = ev[(ev.kind == 'one_off') | ((ev.sym.isin(['BNB', 'OKB', 'BGB'])) & (ev.date >= '2019-06-01'))]
    group['sporadic_large_burn_events_vs_zero'] = {h: dict(n=int(evx[f'xs_{h}'].notna().sum()), mean=float(evx[f'xs_{h}'].mean()), median=float(evx[f'xs_{h}'].median()), p=float(stats.ttest_1samp(evx[f'xs_{h}'].dropna(), 0).pvalue)) for h in ['7d', '30d']}
    # ---------- (b) score vs returns: current cross-section (trailing) + rolling score -> forward returns (Fama-MacBeth by quarter)
    corr_b = {}
    for c in ['xs_trailing_3m', 'xs_trailing_6m', 'xs_trailing_12m', 'xs_log_per_year_program']:
        x = sc[['score', c]].dropna()
        rho, p = stats.spearmanr(x.score, x[c]) if len(x) > 4 else (np.nan, np.nan)
        corr_b[c] = dict(n=len(x), spearman_rho=rho, p=p)
    # rolling: at each quarter-end, score from trailing 180d for daily programs; forward 3/6/12m excess
    qe = pd.date_range('2023-06-30', today, freq='QE'); fm = []
    for t in qe:
        for sym, df in daily.items():
            w = df[(df.index > t - pd.Timedelta(days=180)) & (df.index <= t)]
            if len(w) < 150 or w.usd.sum() <= 0: continue
            m = daily_metrics(w)
            if not m or m['score'] != m['score']: continue
            px, btc = xs_series(meta[sym]['gecko'])
            fm.append(dict(t=t, sym=sym, score=m['score'], **{f'fwd_{lab}': xs_ret(px, btc, t, n) for lab, n in [('3m', 91), ('6m', 182), ('12m', 365)]}))
    F = pd.DataFrame(fm)
    roll = {}
    for c in ['fwd_3m', 'fwd_6m', 'fwd_12m']:
        x = F[['score', c, 't', 'sym']].dropna()
        rho, p = stats.spearmanr(x.score, x[c]) if len(x) > 4 else (np.nan, np.nan)
        per_t = [stats.spearmanr(g.score, g[c])[0] for _, g in x.groupby('t') if len(g) >= 4]
        per_t = [v for v in per_t if v == v]
        fmb = dict(n_dates=len(per_t), mean_rho=float(np.mean(per_t)) if per_t else None,
                   t=float(np.mean(per_t) / (np.std(per_t, ddof=1) / math.sqrt(len(per_t)))) if len(per_t) > 2 else None)
        if fmb['t'] is not None: fmb['p'] = float(2 * stats.t.sf(abs(fmb['t']), len(per_t) - 1))
        roll[c] = dict(pooled=dict(n=len(x), n_tokens=int(x.sym.nunique()), spearman_rho=rho, p=p, note='overlapping horizons for 6m/12m -> p optimistic'), fama_macbeth=fmb)
    # ---------- (c) regime flags -> forward excess vs token baseline
    out_flags = []
    base_cache = {}
    for f in sorted(flags, key=lambda x: (x['date'], x['sym'])):
        g = f['gecko']; px, btc = xs_series(g); t0 = pd.Timestamp(f['date'])
        if g not in base_cache:
            st = pd.Timestamp(rows.get(f['sym'], {}).get('start') or px.index.min())
            days = pd.date_range(max(st, px.index.min()), today)
            base_cache[g] = {n: np.nanmean([xs_ret(px, btc, d, n) for d in days[::3]]) for n in (7, 30, 90)}
        r = dict(f); r.pop('gecko')
        r['xs_prior_30d'] = xs_ret(px, btc, t0 - pd.Timedelta(days=30), 30)
        for n in (7, 30, 90):
            r[f'xs_next_{n}d'] = xs_ret(px, btc, t0, n); r[f'baseline_{n}d'] = base_cache[g][n]
            r[f'vs_baseline_{n}d'] = r[f'xs_next_{n}d'] - r[f'baseline_{n}d'] if r[f'xs_next_{n}d'] == r[f'xs_next_{n}d'] else np.nan
        r['dump_next_30d'] = bool(r['xs_next_30d'] == r['xs_next_30d'] and r['xs_next_30d'] <= -20)
        r['dump_already_before'] = bool(r['xs_prior_30d'] == r['xs_prior_30d'] and r['xs_prior_30d'] <= -20)
        out_flags.append(r)
    FL = pd.DataFrame(out_flags)
    summ = {}
    for kind, sub in [('all', FL)] + [(k, FL[FL.kind.str.startswith(k)]) for k in ['drop', 'surge', 'stopped', 'frequency', 'documented']]:
        d = {}
        for n in (7, 30, 90):
            v = sub[f'vs_baseline_{n}d'].dropna()
            d[f'{n}d'] = dict(n=int(len(v)), mean_vs_baseline=float(v.mean()) if len(v) else None, median=float(v.median()) if len(v) else None,
                             p=float(stats.ttest_1samp(v, 0).pvalue) if len(v) > 2 else None, share_negative=float((v < 0).mean()) if len(v) else None)
        d['n_dumps_next30'] = int(sub.dump_next_30d.sum()); d['n_flags'] = int(len(sub))
        summ[kind] = d
    # base rate of 'dump' (30d excess <= -20pp) over all program days of flagged tokens, sampled every 3 days
    br = []
    for g in set(f['gecko'] for f in flags):
        px, btc = xs_series(g); days = pd.date_range(px.index.min() + pd.Timedelta(days=120), today - pd.Timedelta(days=30))[::3]
        br += [xs_ret(px, btc, d, 30) for d in days]
    br = np.array([v for v in br if v == v])
    summ['base_rate_dump_30d'] = dict(n_windows=int(len(br)), share=float((br <= -20).mean()))
    def rate(sub):
        n = int(sub.xs_next_30d.notna().sum()); k = int(sub.dump_next_30d.sum())
        bt = stats.binomtest(k, n, summ['base_rate_dump_30d']['share']) if n else None
        return dict(n=n, dumps=k, share=k / n if n else None, binom_p_vs_base=bt.pvalue if bt else None)
    summ['dump_rates'] = {'all_flags': rate(FL), 'drop_or_stop': rate(FL[FL.kind.str.startswith(('drop', 'stopped'))]),
                          'drop_pct_volume_only': rate(FL[FL.kind == 'drop>50% (% of volume)']),
                          'surge_after_prior30d_gt_+25pp': rate(FL[FL.kind.str.startswith('surge') & (FL.xs_prior_30d > 25)]),
                          'surge_other': rate(FL[FL.kind.str.startswith('surge') & ~(FL.xs_prior_30d > 25)]),
                          'documented_changes': rate(FL[FL.kind.str.startswith('documented')])}
    res = B.clean(dict(generated=str(B.TODAY)[:10], score_formula=__doc__, weights=W,
                       tokens=rows, score_table=sc.to_dict('records'), group_comparison=group, score_vs_returns_current=corr_b,
                       score_vs_forward_returns_rolling=roll, regime_flags=out_flags, regime_flag_summary=summ,
                       dump_definition='next-30d BTC-excess return <= -20pp; dump_already_before = prior-30d excess <= -20pp (flag followed, not preceded, the dump)'))
    B.save('buyburn_consistency.json', res)
    root = os.path.join(os.path.dirname(os.path.dirname(B.HERE)), 'data')
    if os.path.isdir(root): json.dump(res, open(os.path.join(root, 'buyburn_consistency.json'), 'w'), indent=1)
    print('done', len(rows), 'tokens', len(out_flags), 'flags')

if __name__ == '__main__':
    main()
