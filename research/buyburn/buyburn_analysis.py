"""Stats + projections for buyburn research. Reads data/raw caches & data/buyburn_*.json written by buyburn.py."""
import json, os, math
import numpy as np, pandas as pd
from scipy import stats
import buyburn as B

D = B.DATA
WIN = {'1m': 30, '3m': 91, '6m': 182, '9m': 273, '1y': 365, '2y': 730, '3y': 1095}

def corr(x, y):
    x = np.asarray(x, float); y = np.asarray(y, float)
    m = np.isfinite(x) & np.isfinite(y); x, y = x[m], y[m]
    if len(x) < 5 or np.std(x) == 0 or np.std(y) == 0: return dict(n=int(len(x)))
    pr, pp = stats.pearsonr(x, y); sr, sp = stats.spearmanr(x, y)
    sl = stats.linregress(x, y)
    lo, hi = np.percentile(y, [2.5, 97.5]); xl, xh = np.percentile(x, [2.5, 97.5])
    wr, wp = stats.pearsonr(np.clip(x, xl, xh), np.clip(y, lo, hi)) if np.std(np.clip(x, xl, xh)) > 0 else (np.nan, np.nan)
    return dict(n=int(len(x)), pearson_r=pr, pearson_p=pp, spearman_rho=sr, spearman_p=sp, pearson_winsor_r=wr, pearson_winsor_p=wp, slope=sl.slope, intercept=sl.intercept)

def tmean(y):
    y = np.asarray(y, float); y = y[np.isfinite(y)]
    if len(y) < 3: return dict(n=int(len(y)), mean=float(np.mean(y)) if len(y) else None)
    t, p = stats.ttest_1samp(y, 0)
    return dict(n=int(len(y)), mean=float(y.mean()), median=float(np.median(y)), t=float(t), p=float(p), hit_rate=float((y > 0).mean()))

def ols(y, X, names):
    """OLS with classic SE; y, X arrays (X without const)."""
    y = np.asarray(y, float); X = np.column_stack([np.asarray(c, float) for c in X])
    m = np.isfinite(y) & np.isfinite(X).all(1); y, X = y[m], X[m]
    if len(y) < 20: return dict(n=int(len(y)))
    Xc = np.column_stack([np.ones(len(y)), X]); b, *_ = np.linalg.lstsq(Xc, y, rcond=None)
    e = y - Xc @ b; dof = len(y) - Xc.shape[1]; s2 = e @ e / dof
    se = np.sqrt(np.diag(s2 * np.linalg.inv(Xc.T @ Xc))); t = b / se; p = 2 * stats.t.sf(np.abs(t), dof)
    r2 = 1 - (e @ e) / ((y - y.mean()) @ (y - y.mean()))
    return dict(n=int(len(y)), r2=r2, **{f'b_{k}': v for k, v in zip(['const'] + names, b)}, **{f't_{k}': v for k, v in zip(['const'] + names, t)}, **{f'p_{k}': v for k, v in zip(['const'] + names, p)})

def buckets(x, y, edges, label, overlap=1):
    out = []
    x = np.asarray(x, float); y = np.asarray(y, float)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (x >= lo) & (x < hi) & np.isfinite(y)
        r = tmean(y[m]); r.update(bucket=f'{label} [{lo},{hi})')
        if overlap > 1 and r.get('t') is not None:  # overlapping windows: shrink t by sqrt(overlap) (n_eff ~ n/overlap)
            r['t_adj'] = r['t'] / math.sqrt(overlap); r['p_adj'] = float(2 * stats.t.sf(abs(r['t_adj']), max(r['n'] / overlap - 1, 1)))
        out.append(r)
    return out

# ----------------------------------------------------------------- discrete events
def event_stats():
    ev = pd.DataFrame(json.load(open(os.path.join(D, 'buyburn_events.json')))['events'])
    res = {}
    per = ev[(ev.kind == 'periodic') & ~((ev.sym == 'OKB') & (ev.date == '2025-08-15'))]
    for name, sub in [('pooled_periodic(BNB+OKB+BGB)', per), ('BNB', per[per.sym == 'BNB']), ('OKB', per[per.sym == 'OKB']),
                      ('BNB_exact_dates_only', per[(per.sym == 'BNB') & (per.quality != 'approx')]),
                      ('pooled_periodic_2019plus', per[per.date >= '2019-06-01'])]:
        r = {}
        for h in ['24h', '7d', '30d']:
            r[h] = dict(excess_return=tmean(sub[f'xs_{h}']), raw_return=tmean(sub[f'ret_{h}']),
                        corr_pct_circ_vs_excess=corr(sub.pct_circ.values.astype(float), sub[f'xs_{h}'].values.astype(float)),
                        corr_pct_dailyvol_vs_excess=corr(sub.pct_dailyvol.values.astype(float), sub[f'xs_{h}'].values.astype(float)))
        r['buckets_pct_circ_xs7d'] = buckets(sub.pct_circ, sub.xs_7d, [0, 0.5, 1, 2, 100], 'burn %circ')
        r['buckets_pct_circ_xs30d'] = buckets(sub.pct_circ, sub.xs_30d, [0, 0.5, 1, 2, 100], 'burn %circ')
        res[name] = r
    res['one_offs'] = ev[ev.kind == 'one_off'][['sym', 'date', 'amount', 'usd', 'pct_circ', 'pct_dailyvol', 'ret_24h', 'xs_24h', 'ret_7d', 'xs_7d', 'ret_30d', 'xs_30d', 'note']].to_dict('records')
    return res

# ----------------------------------------------------------------- continuous programs
def load_daily():
    j = json.load(open(os.path.join(D, 'buyburn_daily.json')))['series']
    out = {}
    btc = B.prices('bitcoin')
    meta = {t['sym']: t for t in B.TOKENS}
    for sym, rows in j.items():
        if meta[sym].get('exclude_stats'): continue
        df = pd.DataFrame(rows); df['date'] = pd.to_datetime(df.date); df = df.set_index('date').sort_index()
        px = B.prices(meta[sym]['gecko'])
        idx = pd.date_range(df.index.min(), B.TODAY - pd.Timedelta(days=1))
        df = df.reindex(idx); df['usd'] = df.usd.fillna(0); df['tokens'] = df.tokens.fillna(0)
        df['px'] = px.reindex(idx).ffill(); df['btc'] = btc.reindex(idx).ffill()
        out[sym] = df
    return out

def fwd(s, a, b):  # return from t+a to t+b (pct)
    return (s.shift(-b) / s.shift(-a) - 1) * 100

def program_stats(daily):
    res = {}; pooled = []
    for sym, df in daily.items():
        if df.usd.sum() < 1e6 or len(df) < 60: continue
        typ = next(t['type'] for t in B.TOKENS if t['sym'] == sym)
        d = df.copy()
        # coins.llama daily point = 00:00 UTC, buyback day t accrues during [t, t+1)
        d['xs_contemp1'] = fwd(d.px, 0, 1) - fwd(d.btc, 0, 1)
        d['xs_fwd1'] = fwd(d.px, 1, 2) - fwd(d.btc, 1, 2)
        d['xs_fwd7'] = fwd(d.px, 1, 8) - fwd(d.btc, 1, 8)
        d['xs_fwd30'] = fwd(d.px, 1, 31) - fwd(d.btc, 1, 31)
        d['pct_circ'] = d.pct_circ.astype(float); d['pct_vol'] = d.pct_vol.astype(float)
        r = dict(type=typ, days=int((d.usd > 0).sum()), start=str(d.index.min())[:10])
        r['daily'] = {h: dict(pct_circ=corr(d.pct_circ.values, d[h].values), pct_vol=corr(d.pct_vol.values, d[h].values)) for h in ['xs_contemp1', 'xs_fwd1']}
        # non-overlapping weekly / 30d blocks
        for blk, n in [('weekly', 7), ('monthly', 30)]:
            g = (np.arange(len(d)) // n)
            agg = pd.DataFrame({'pct_circ': d.pct_circ.groupby(g).sum(min_count=n - 1), 'usd': d.usd.groupby(g).sum(),
                                'vol': d.vol.astype(float).groupby(g).sum(min_count=n - 1),
                                'px0': d.px.groupby(g).first(), 'px1': d.px.groupby(g).last(), 'b0': d.btc.groupby(g).first(), 'b1': d.btc.groupby(g).last()})
            agg['pct_vol'] = agg.usd / agg.vol * 100
            agg['xs'] = (agg.px1 / agg.px0 - 1) * 100 - (agg.b1 / agg.b0 - 1) * 100
            agg['xs_next'] = agg['xs'].shift(-1)
            r[blk] = dict(contemp_pct_circ=corr(agg.pct_circ.values, agg['xs'].values), next_pct_circ=corr(agg.pct_circ.values, agg.xs_next.values),
                          contemp_pct_vol=corr(agg.pct_vol.values, agg['xs'].values), next_pct_vol=corr(agg.pct_vol.values, agg.xs_next.values))
        r['buckets_daily_pct_vol_fwd1'] = buckets(d.pct_vol, d.xs_fwd1, [0, 0.25, 0.5, 1, 2, 5, 1e9], 'buyback %daily vol')
        r['buckets_daily_pct_vol_fwd7(overlapping)'] = buckets(d.pct_vol, d.xs_fwd7, [0, 0.25, 0.5, 1, 2, 5, 1e9], 'buyback %daily vol', 7)
        d['ret_fwd1'] = fwd(d.px, 1, 2); d['btc_fwd1'] = fwd(d.btc, 1, 2); d['ret_c1'] = fwd(d.px, 0, 1); d['btc_c1'] = fwd(d.btc, 0, 1)
        r['ols_fwd1_ret_on_btc_and_pctcirc'] = ols(d.ret_fwd1, [d.btc_fwd1, d.pct_circ], ['btc', 'pct_circ'])
        r['ols_contemp_ret_on_btc_and_pctcirc'] = ols(d.ret_c1, [d.btc_c1, d.pct_circ], ['btc', 'pct_circ'])
        r['ols_fwd1_ret_on_btc_and_pctvol'] = ols(d.ret_fwd1, [d.btc_fwd1, d.pct_vol], ['btc', 'pct_vol'])
        res[sym] = r
        d = d.replace([np.inf, -np.inf], np.nan)
        z = d[['pct_circ', 'pct_vol', 'xs_contemp1', 'xs_fwd1', 'xs_fwd7', 'xs_fwd30']].copy(); z['sym'] = sym; z['type'] = typ
        # within-token z-scores to pool
        for c in ['pct_circ', 'pct_vol']:
            z[c + '_z'] = (z[c] - z[c].mean()) / z[c].std()
        pooled.append(z)
    P = pd.concat(pooled)
    pool = {}
    for name, sub in [('all_programs', P), ('burn_types', P[P.type.isin(B.BURN_TYPES)]), ('treasury_types', P[~P.type.isin(B.BURN_TYPES)])]:
        pool[name] = {h: dict(pct_circ_z=corr(sub.pct_circ_z.values, sub[h].values), pct_vol_z=corr(sub.pct_vol_z.values, sub[h].values),
                              pct_circ_raw=corr(sub.pct_circ.values, sub[h].values), pct_vol_raw=corr(sub.pct_vol.values, sub[h].values)) for h in ['xs_contemp1', 'xs_fwd1', 'xs_fwd7']}
        pool[name]['buckets_pct_vol_fwd1'] = buckets(sub.pct_vol, sub.xs_fwd1, [0, 0.25, 0.5, 1, 2, 5, 1e9], 'buyback %daily vol')
        pool[name]['buckets_pct_vol_fwd7(overlapping)'] = buckets(sub.pct_vol, sub.xs_fwd7, [0, 0.25, 0.5, 1, 2, 5, 1e9], 'buyback %daily vol', 7)
        pool[name]['buckets_pct_circ_bps_fwd1'] = buckets(sub.pct_circ * 100, sub.xs_fwd1, [0, 0.5, 1, 2, 5, 10, 1e9], 'buyback bps of circ/day')
        pool[name]['buckets_pct_circ_bps_fwd7(overlapping)'] = buckets(sub.pct_circ * 100, sub.xs_fwd7, [0, 0.5, 1, 2, 5, 10, 1e9], 'buyback bps of circ/day', 7)
    return res, pool

# ----------------------------------------------------------------- cross-section & over time
def cross_section(daily, toks):
    rows = []
    for sym, df in daily.items():
        t = toks.get(sym, {})
        if df.usd.sum() < 1e6: continue
        start = df[df.usd > 0].index.min(); d = df[df.index >= start]
        p0, p1, b0, b1 = d.px.iloc[0], d.px.dropna().iloc[-1], d.btc.iloc[0], d.btc.dropna().iloc[-1]
        yrs = (d.index[-1] - start).days / 365
        cum_pct = (d.tokens.sum() / t['circ_now'] * 100) if t.get('circ_now') else np.nan
        ann_yield = (d.usd.iloc[-30:].sum() * 365 / 30) / t['mcap_now'] * 100 if t.get('mcap_now') else np.nan
        rows.append(dict(sym=sym, type=t.get('type'), start=str(start)[:10], years=yrs, cum_usd=d.usd.sum(), cum_tokens=d.tokens.sum(),
                         cum_pct_circ_now=cum_pct, cum_pct_circ_per_year=cum_pct / yrs if yrs > 0 else np.nan, buyback_yield_ann_pct=ann_yield,
                         ret_since_start=(p1 / p0 - 1) * 100, btc_since_start=(b1 / b0 - 1) * 100, xs_since_start=(p1 / p0 - b1 / b0) * 100,
                         xs_log_per_year=(math.log(p1 / p0) - math.log(b1 / b0)) / yrs if yrs > 0.2 else np.nan))
    X = pd.DataFrame(rows)
    out = dict(rows=X.to_dict('records'),
               cum_pct_vs_xs=corr(X.cum_pct_circ_now.values, X.xs_since_start.values),
               cum_pct_per_year_vs_xs_log_per_year=corr(X.cum_pct_circ_per_year.values, X.xs_log_per_year.values),
               yield_vs_xs_log_per_year=corr(X.buyback_yield_ann_pct.values, X.xs_log_per_year.values))
    Y = X[X.sym != 'ORE']; Z = X[X.type.isin(B.BURN_TYPES)]
    out['ex_ORE'] = dict(cum_pct_vs_xs=corr(Y.cum_pct_circ_now.values, Y.xs_since_start.values), cum_pct_per_year_vs_xs_log_per_year=corr(Y.cum_pct_circ_per_year.values, Y.xs_log_per_year.values), yield_vs_xs_log_per_year=corr(Y.buyback_yield_ann_pct.values, Y.xs_log_per_year.values))
    out['burn_types_only'] = dict(cum_pct_per_year_vs_xs_log_per_year=corr(Z.cum_pct_circ_per_year.values, Z.xs_log_per_year.values), yield_vs_xs_log_per_year=corr(Z.buyback_yield_ann_pct.values, Z.xs_log_per_year.values))
    # over time: rolling 90d buyback % circ (sum of daily pct) at month ends vs next 90d excess (non-overlapping 90d blocks)
    ot = []
    for sym, df in daily.items():
        if df.usd.sum() < 1e6: continue
        g = np.arange(len(df)) // 90
        a = pd.DataFrame({'pct': df.pct_circ.astype(float).groupby(g).sum(min_count=60), 'p0': df.px.groupby(g).first(), 'p1': df.px.groupby(g).last(),
                          'b0': df.btc.groupby(g).first(), 'b1': df.btc.groupby(g).last()})
        a['xs'] = (a.p1 / a.p0 - a.b1 / a.b0) * 100; a['xs_next'] = a['xs'].shift(-1); a['sym'] = sym; ot.append(a)
    O = pd.concat(ot)
    out['over_time_90d_blocks'] = dict(contemp=corr(O.pct.values, O['xs'].values), next=corr(O.pct.values, O.xs_next.values))
    # discrete: BNB / OKB cumulative burned % vs cumulative excess return (time series)
    return out

# ----------------------------------------------------------------- projections
def projections(daily, toks):
    ev = pd.DataFrame(json.load(open(os.path.join(D, 'buyburn_events.json')))['events'])
    out = {}
    for T in B.TOKENS:
        sym = T['sym']; t = toks.get(sym, {})
        circ, total = t.get('circ_now'), t.get('total_now')
        if not circ: continue
        rec = dict(sym=sym, type=T['type'], circ_now=circ, total_now=total, price_now=t.get('price_now'), flags=[])
        burn_pd, buy_pd, basis = 0.0, 0.0, ''
        df = daily.get(sym)
        if df is not None and len(df) > 30:
            r90 = df.tokens.iloc[-90:].mean()
            if T['type'] in B.BURN_TYPES: burn_pd = r90; basis = 'DefiLlama holdersRevenue last-90d avg / daily price'
            else: buy_pd = r90; basis = 'bought back (NOT burned) last-90d avg'
            if sym == 'PUMP':  # post-Apr-28-2026 regime = 50% revenue burn
                burn_pd = df.tokens[df.index >= '2026-04-29'].iloc[-90:].mean(); rec['flags'].append('PUMP 50%-revenue burn contract committed for 1y from 2026-04-28; projection beyond ~Apr-2027 assumes renewal')
            if sym == 'LIT': rec['flags'].append('LIT: 100% fees -> buy&burn since Jul-2026; daily series = DefiLlama buybacks')
        if sym == 'BNB':
            last4 = ev[(ev.sym == 'BNB') & (ev.kind == 'periodic')].sort_values('date').tail(4)
            q = last4.amount.sum() / 365; rt = df.tokens.iloc[-90:].mean() if df is not None else 0
            burn_pd = q + rt; basis = f'last 4 quarterly auto-burns ({last4.amount.sum():,.0f} BNB/yr) + BEP-95 gas burn (DefiLlama bsc holdersRevenue)'
            rec['flags'].append('BNB auto-burn stops once total supply reaches 100M')
        if sym == 'BGB':
            last4 = ev[(ev.sym == 'BGB')].sort_values('date').tail(3); burn_pd = last4.amount.sum() / 273
            basis = 'avg of 2026 quarterly burns (~3M/qtr)'; rec['flags'].append('2026 BGB burns paid from locked Morph treasury -> reduce TOTAL not circulating')
        if sym == 'SUN': burn_pd = 9025027.40 / 91; basis = '51st quarterly burn (9.03M SUN / 91d)'
        if sym == 'OKB': burn_pd = 0; basis = 'program ended 2025-08 (supply fixed 21M)'
        if sym == 'ASTER':
            rec['flags'].append('ASTER: bought tokens go to stakers (stay circulating); equal amount burned from team reserve -> reduces TOTAL supply & future unlocks, not current circ')
            rec['reserve_burn_per_day'] = buy_pd
        rec['burn_per_day'] = burn_pd; rec['buyback_not_burned_per_day'] = buy_pd; rec['burn_basis'] = basis
        rec['burn_pct_circ_per_year'] = burn_pd * 365 / circ * 100
        # unlocks / issuance
        unl_pd_trail, sched = None, None
        s, j = B.emis_unlocked_series(T.get('emis'))
        if not s.empty:
            s = s[~s.index.duplicated()].sort_index()
            today = B.TODAY
            cur = s[s.index <= today].iloc[-1] if (s.index <= today).any() else np.nan
            past = s[s.index <= today - pd.Timedelta(days=90)]
            unl_pd_trail = (cur - past.iloc[-1]) / 90 if len(past) else np.nan
            if s.index.max() < today - pd.Timedelta(days=30):
                unl_pd_trail = 0.0; rec['flags'].append(f'DefiLlama emissions series ends {str(s.index.max())[:10]} (stale/complete) -> future unlocks assumed 0 (UNCERTAIN)')
                rec['unlock_basis'] = 'emissions series ended -> 0'
            if unl_pd_trail is not None and unl_pd_trail == unl_pd_trail and unl_pd_trail < 0:
                rec['flags'].append(f'negative trailing unlock rate ({unl_pd_trail:,.0f}/d) clamped to 0'); unl_pd_trail = 0.0
            if s.index.max() > today + pd.Timedelta(days=60):
                sched = s; rec['unlock_basis'] = 'DefiLlama emissions schedule (defillama-datasets.llama.fi/emissions/' + T['emis'] + ')'
            else:
                rec['unlock_basis'] = 'DefiLlama emissions: no forward schedule -> trailing-90d realized unlock rate extrapolated'
            rec['emis_unlocked_now'] = cur; rec['unlock_per_day_trailing90'] = unl_pd_trail
        # observed circ change (CoinGecko 365d) for issuance inference
        cg = B.cg365(T['gecko'])
        if not cg.empty and cg.circ.notna().sum() > 100:
            c = cg.circ.dropna(); c90 = c[c.index <= c.index.max() - pd.Timedelta(days=90)]
            rec['cg_circ_change_per_day_90d'] = (c.iloc[-1] - c90.iloc[-1]) / 90 if len(c90) else None
        if sym == 'ETH':
            us = B.fetch('https://ultrasound.money/api/v2/fees/eth-supply-parts', 'ultrasound_supply_parts.json')
            staked = int(us['beaconBalancesSum']) / 1e9 if us else None
            if staked:
                unl_pd_trail = 940.87 * math.sqrt(staked / 32) / 365
                rec['unlock_basis'] = f'PoS issuance estimate = 940.87*sqrt(validators)/yr with {staked/1e6:.2f}M ETH staked (ultrasound.money beaconBalancesSum) = theoretical max (~perfect participation)'
                rec['staked_eth'] = staked
        elif sym == 'TRX' and rec.get('cg_circ_change_per_day_90d') is not None:
            unl_pd_trail = rec['cg_circ_change_per_day_90d'] + burn_pd   # gross issuance = net change + burn
            rec['unlock_basis'] = 'gross issuance inferred = CoinGecko 90d net circ change + burn (protocol issuance)'
        if sym == 'HYPE':
            rec['flags'].append('Base case uses DefiLlama-documented realized unlocks (core-contributor monthly + validator rewards, trailing 90d). Hyperliquid API (tokenDetails) lists 237.9M HYPE at non-circulating 0x43e9..a251 and futureEmissions 410.8M; if 237.9M vested linearly to end-2027 (DefiLlama note) unlocks would be ~0.53M/day = ~20x the base case. Treat base case as LOWER bound for dilution.')
            rec['scenario_upper_unlock_per_day'] = 237901677 / max((pd.Timestamp('2027-12-31') - B.TODAY).days, 1)
        if sym == 'BNB': unl_pd_trail = 0; rec['unlock_basis'] = 'no emissions (all supply circulating)'
        if sym == 'OKB': unl_pd_trail = 0; rec['unlock_basis'] = 'fixed 21M supply'
        if sym in ('BGB', 'SUN', 'BONK') and unl_pd_trail is None:
            v = rec.get('cg_circ_change_per_day_90d'); unl_pd_trail = max(v + (burn_pd if sym == 'SUN' else 0), 0) if v is not None else 0
            rec['unlock_basis'] = 'CoinGecko 90d net circ change (+burn) used as unlock proxy'
        rec['windows'] = {}
        for w, n in WIN.items():
            burned = burn_pd * n
            if sched is not None:
                tgt = B.TODAY + pd.Timedelta(days=n)
                v1 = sched[sched.index <= tgt].iloc[-1]; unlocked = max(v1 - rec['emis_unlocked_now'], 0)
            else:
                unlocked = (unl_pd_trail or 0) * n
            if sym == 'ASTER': circ_burn = 0
            elif sym == 'BGB': circ_burn = 0
            else: circ_burn = burned
            net = circ - circ_burn + unlocked
            rec['windows'][w] = dict(days=n, burned_tokens=burned, unlocked_tokens=unlocked, bought_not_burned_tokens=buy_pd * n,
                                     net_supply=net, net_change_pct=(net / circ - 1) * 100,
                                     net_float_ex_treasury_buys=net - buy_pd * n,
                                     total_supply_after_burn=(total - burned) if total else None)
            if rec.get('scenario_upper_unlock_per_day'):
                u2 = min(rec['scenario_upper_unlock_per_day'] * n, 237901677)
                rec['windows'][w]['scenario_upper_unlocked_tokens'] = u2
                rec['windows'][w]['scenario_upper_net_change_pct'] = ((circ - circ_burn + u2) / circ - 1) * 100
        out[sym] = rec
    return out

def main():
    toks = {t['sym']: t for t in json.load(open(os.path.join(D, 'buyburn_tokens.json')))['tokens']}
    daily = load_daily()
    es = event_stats()
    ps, pool = program_stats(daily)
    cs = cross_section(daily, toks)
    B.save('buyburn_stats.json', B.clean(dict(generated=str(B.TODAY)[:10], excess_def='token return minus BTC return, percentage points, close-to-close daily (coins.llama 00:00 UTC)',
                                         discrete_events=es, programs=ps, pooled_programs=pool, cross_section=cs)))
    pj = projections(daily, toks)
    obj = B.clean(dict(generated=str(B.TODAY)[:10], method='net_supply = circ_now - burned_tokens + unlocked_tokens; burn at trailing-90d rate (constant token rate); unlocks from DefiLlama emissions schedule when available else trailing-90d realized unlock/issuance rate. bought_not_burned = treasury buybacks (not subtracted from net_supply; see net_float_ex_treasury_buys).',
                         windows=list(WIN), tokens=pj))
    B.save('buyburn_projections.json', obj)
    root = os.path.join(os.path.dirname(os.path.dirname(B.HERE)), 'data')
    if os.path.isdir(root): json.dump(obj, open(os.path.join(root, 'buyburn_projections.json'), 'w'), indent=1)
    print('done')

if __name__ == '__main__':
    main()
