#!/usr/bin/env python3
"""Macro backdrop for every catalog crash + base rates. FRED fredgraph CSV (keyless; must NOT send a browser UA).
Series: DFF fed funds, DGS2/DGS10/DGS30 Treasury yields, MORTGAGE30US, TERMCBCCALLNS (credit-card APR), TERMCBAUTO48NS + RIFLPBCIANM60NM (auto loans),
WALCL (Fed balance sheet), GFDEBTN (federal debt), A091RC1Q027SBEA (federal interest payments). MOVE index is not free: proxy = 20-day realized
volatility of daily 10y yield changes (bp). Output data/macro_overlay.json (+ daily table used by crash_lab as optional detector features)."""
import csv, io, json, os, statistics, urllib.request, datetime as dt, bisect
from common import DATA_DIR
S = ['DFF', 'DGS2', 'DGS10', 'DGS30', 'MORTGAGE30US', 'TERMCBCCALLNS', 'TERMCBAUTO48NS', 'RIFLPBCIANM60NM', 'WALCL', 'GFDEBTN', 'A091RC1Q027SBEA']
CALLS = {'fred.stlouisfed.org': 0}
def fred(sid):
    CALLS['fred.stlouisfed.org'] += 1
    t = urllib.request.urlopen(urllib.request.Request(f'https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd=2020-01-01', headers={'User-Agent': 'curl/8.5'}), timeout=40).read().decode()
    out = []
    for r in list(csv.reader(io.StringIO(t)))[1:]:
        try: out.append((r[0], float(r[1])))
        except Exception: pass
    return out
def asof(series, d):
    ds = [x[0] for x in series]; i = bisect.bisect_right(ds, d) - 1; return series[i][1] if i >= 0 else None
def chg(series, d, days):
    a = asof(series, d); b = asof(series, (dt.date.fromisoformat(d) - dt.timedelta(days=days)).isoformat()); return (a - b) if a is not None and b is not None else None
def main():
    F = {s: fred(s) for s in S}
    # MOVE proxy: 20d stdev of daily 10y changes, bp; percentile vs 2020+ history
    y = F['DGS10']; dch = [(y[i][0], (y[i][1] - y[i - 1][1]) * 100) for i in range(1, len(y))]
    mv = [(dch[i][0], statistics.pstdev([c for _, c in dch[i - 19:i + 1]])) for i in range(19, len(dch))]; mvals = sorted(v for _, v in mv)
    pct = lambda v: bisect.bisect_left(mvals, v) / len(mvals) * 100
    def feat(d):
        f = {'fedfunds': asof(F['DFF'], d), 'fedfunds_chg_90d': chg(F['DFF'], d, 90), 'y2': asof(F['DGS2'], d), 'y10': asof(F['DGS10'], d), 'y30': asof(F['DGS30'], d),
             'y10_chg_30d_bp': (chg(F['DGS10'], d, 30) or 0) * 100, 'y10_chg_90d_bp': (chg(F['DGS10'], d, 90) or 0) * 100, 'y30_chg_30d_bp': (chg(F['DGS30'], d, 30) or 0) * 100, 'y2_chg_90d_bp': (chg(F['DGS2'], d, 90) or 0) * 100,
             'curve_10y_2y': (asof(F['DGS10'], d) or 0) - (asof(F['DGS2'], d) or 0), 'mortgage30': asof(F['MORTGAGE30US'], d), 'mortgage_chg_90d': chg(F['MORTGAGE30US'], d, 90),
             'cc_apr': asof(F['TERMCBCCALLNS'], d), 'auto48_apr': asof(F['TERMCBAUTO48NS'], d), 'auto60_apr': asof(F['RIFLPBCIANM60NM'], d),
             'walcl_chg_90d_pct': (lambda a, b: (a / b - 1) * 100 if a and b else None)(asof(F['WALCL'], d), asof(F['WALCL'], (dt.date.fromisoformat(d) - dt.timedelta(days=90)).isoformat())),
             'debt': asof(F['GFDEBTN'], d), 'interest_outlays_saar_bn': asof(F['A091RC1Q027SBEA'], d), 'move_proxy_bp': asof(mv, d)}
        f['move_proxy_pct'] = pct(f['move_proxy_bp']) if f['move_proxy_bp'] is not None else None
        f['rising_rates'] = (f['fedfunds_chg_90d'] or 0) > 0.1 or f['y10_chg_90d_bp'] >= 40
        f['bond_selloff'] = f['y10_chg_30d_bp'] >= 25 or f['y30_chg_30d_bp'] >= 25 or (f['move_proxy_pct'] or 0) >= 80
        f['qt'] = (f['walcl_chg_90d_pct'] or 0) < -1; f['qe'] = (f['walcl_chg_90d_pct'] or 0) > 1
        return f
    # crash onsets: series cases (collapse date), forensics drop dates, confirmed catalog crashes (peak date) from catalog_build if present
    J = lambda f: json.load(open(os.path.join(DATA_DIR, f))) if os.path.exists(os.path.join(DATA_DIR, f)) else None
    cases = []
    cl = J('crash_catalog.json') or {}
    for s in cl.get('series_cases', []):
        if 'control' in s['name'] or '(cached)' in s['name']: continue
        cases.append({'name': s['name'], 'peak_date': s['peak_date'], 'onset': s['collapse_date'], 'source': 'daily series'})
    fx = json.load(open(os.path.join(os.path.dirname(__file__), 'forensics_cases.json')))['cases']
    for c in fx:
        if not any(x['name'].startswith(c['symbol'] + ' ') for x in cases): cases.append({'name': c['symbol'], 'peak_date': c['peak']['date'], 'onset': c['drop']['date'], 'source': 'forensics'})
    fin = J('crash_catalog_final.json') or {}
    for c in fin.get('coingecko_coins', []):
        if c.get('status') in ('confirmed', 'closes-only', 'bad_tick') and (c.get('crash_depth_pct') or 0) <= -80 and (c.get('peak_mcap') or 0) >= 10e6 and not any(x['name'].split(' ')[0] == c['symbol'] for x in cases):
            cases.append({'name': c['symbol'] + ' (' + c['id'] + ')', 'peak_date': c['peak_date'], 'onset': c['peak_date'], 'source': 'confirmed CG peak (onset = peak)'})
    for c in cases:
        for tag, d in (('f_pre60', (dt.date.fromisoformat(c['peak_date']) - dt.timedelta(days=60)).isoformat()), ('f_peak', c['peak_date']), ('f_onset', c['onset'])): c[tag] = feat(d)
        c['tag'] = {'rising_rates_before_or_during': c['f_pre60']['rising_rates'] or c['f_peak']['rising_rates'] or c['f_onset']['rising_rates'],
                    'bond_selloff_before_or_during': c['f_pre60']['bond_selloff'] or c['f_peak']['bond_selloff'] or c['f_onset']['bond_selloff'], 'qt_at_onset': c['f_onset']['qt'], 'qe_at_onset': c['f_onset']['qe']}
    # base rates over every calendar day since 2021-06-01: P(a catalog crash onset within next 30d | condition) vs | not condition
    onsets = sorted(dt.date.fromisoformat(c['onset']) for c in cases); start = dt.date(2021, 6, 1); end = dt.date.today() - dt.timedelta(days=30)
    days = []; d = start
    while d <= end:
        f = feat(d.isoformat()); j = bisect.bisect_left(onsets, d); hit = j < len(onsets) and onsets[j] <= d + dt.timedelta(days=30)
        days.append((d.isoformat(), f, hit)); d += dt.timedelta(days=1)
    def br(key):
        on = [h for _, f, h in days if f[key]]; off = [h for _, f, h in days if not f[key]]
        return {'days_condition': len(on), 'p_crash30_given_condition': sum(on) / len(on) if on else None, 'days_no_condition': len(off), 'p_crash30_given_no_condition': sum(off) / len(off) if off else None,
                'crashes_with_condition_before_or_during': sum(1 for c in cases if c['tag'].get(key + '_before_or_during', c['f_onset'].get(key))), 'crashes_total': len(cases)}
    base = {k: br(k) for k in ('rising_rates', 'bond_selloff', 'qt', 'qe')}
    for k, v in base.items(): v['lift'] = (v['p_crash30_given_condition'] / v['p_crash30_given_no_condition']) if v['p_crash30_given_condition'] is not None and v['p_crash30_given_no_condition'] else None
    daily = {d: {k: f[k] for k in ('y10_chg_30d_bp', 'fedfunds_chg_90d', 'move_proxy_pct', 'walcl_chg_90d_pct')} for d, f, _ in days}
    now = feat(dt.date.today().isoformat())
    out = {'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'series': {s: {'first': F[s][0][0], 'last': F[s][-1]} for s in S}, 'now': now, 'cases': cases, 'base_rates': base, 'daily_features': daily,
           'note': 'MOVE index itself is licensed (ICE); proxy = 20-day realized vol of daily 10y changes. Crash onsets cluster (many memecoins crash together), so base-rate days are not independent.',
           'billing': {'nansen_calls': 0, 'x_calls': 0, 'hosts': CALLS}}
    json.dump(out, open(os.path.join(DATA_DIR, 'macro_overlay.json'), 'w'))
    print('cases', len(cases), 'now', {k: (round(v, 2) if isinstance(v, float) else v) for k, v in now.items()})
    print(json.dumps(base, indent=0))
    for c in cases[:60]: print(c['name'][:28], c['peak_date'], c['onset'], c['tag'], 'y10 30d', round(c['f_peak']['y10_chg_30d_bp']), 'ff90', c['f_peak']['fedfunds_chg_90d'], 'move%', round(c['f_peak']['move_proxy_pct'] or 0))
if __name__ == '__main__': main()
