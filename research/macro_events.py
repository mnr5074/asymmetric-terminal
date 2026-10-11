#!/usr/bin/env python3
"""Macro event study: how did BTC and SOL move around FOMC decisions, jobs reports (NFP) and CPI releases?
Keyless sources: FRED fredgraph CSV (prices: CBBTCUSD; rates: DFEDTARU; data: PAYEMS, CPIAUCSL),
FRED release calendar (exact BLS release dates), federalreserve.gov FOMC calendar, Coinbase public candles (SOL-USD).
Output: data/macro_events.json. Daily closes (UTC) only: intraday reactions are not resolved.
Small samples, overlapping regimes, revised data. Descriptive only, not a trading signal."""
import json, os, re, statistics as st, time, urllib.request, datetime as dt
from common import DATA_DIR

def fetch(url, ua=None, timeout=30):
    h = {'user-agent': ua} if ua else {'user-agent': 'curl/8'}   # FRED blocks browser-like UAs on fredgraph
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')

def fred(series, since='2014-12-01'):
    rows = fetch(f'https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}&cosd={since}').strip().split('\n')[1:]
    return [(d, float(v)) for d, v in (r.split(',') for r in rows) if v not in ('', '.')]

MON = {m: i + 1 for i, m in enumerate(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'])}
def release_dates(rid, years):
    out = set()
    for y in years:
        try: h = fetch(f'https://fred.stlouisfed.org/releases/calendar?rid={rid}&y={y}')
        except Exception as e: print('calendar', rid, y, e); continue
        for m, d, yy in re.findall(r'(?:Monday|Tuesday|Wednesday|Thursday|Friday)\s+(\w+)\s+(\d{1,2}),\s+(\d{4})', h):
            if m in MON: out.add(f'{yy}-{MON[m]:02d}-{int(d):02d}')
        time.sleep(0.5)
    return sorted(out)

def fomc_meetings():
    h = fetch('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', ua='Mozilla/5.0')
    M3 = {m: i + 1 for i, m in enumerate(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])}
    out = []
    parts = re.split(r'(\d{4}) FOMC Meetings', h)
    for i in range(1, len(parts), 2):
        y = int(parts[i])
        for mon, dates in re.findall(r'fomc-meeting__month[^>]*><strong>([^<]+)</strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)<', parts[i + 1]):
            days = re.findall(r'\d+', dates); mm = mon.strip().split('/')[-1][:3]
            if days and mm in M3: out.append(f'{y}-{M3[mm]:02d}-{int(days[-1]):02d}')
    return sorted(set(out))

def coinbase_daily(product, start='2021-06-01'):
    out = {}
    t = dt.datetime.fromisoformat(start)
    end = dt.datetime.now(dt.UTC).replace(tzinfo=None)
    while t < end:
        t2 = min(t + dt.timedelta(days=290), end)
        url = f'https://api.exchange.coinbase.com/products/{product}/candles?granularity=86400&start={t.isoformat()}Z&end={t2.isoformat()}Z'
        try:
            for ts, lo, hi, op, cl, vol in json.loads(fetch(url, ua='asymmetric-terminal research')):
                out[dt.datetime.fromtimestamp(ts, dt.UTC).strftime('%Y-%m-%d')] = cl
        except Exception as e: print('coinbase', product, t, e)
        t = t2; time.sleep(0.4)
    return sorted(out.items())

def nfp_rule(y, mo):
    """BLS rule: Employment Situation comes out on the 3rd Friday after the reference week (the week containing the 12th).
    Holiday tweaks: an early-January date moves a week later; Independence Day moves the release to the prior business day.
    Validated against official 2025-26 dates: matches all except government-shutdown delays."""
    d12 = dt.date(y, mo, 12); sat = d12 + dt.timedelta(days=(5 - d12.weekday()) % 7)
    r = sat + dt.timedelta(days=20)
    if r.month == 1 and r.day <= 4: r += dt.timedelta(days=7)
    if r.month == 7 and r.day in (3, 4): r = dt.date(r.year, 7, 2 if r.day == 3 else 3)
    return r.isoformat()

def add_days(d, n): return (dt.date.fromisoformat(d) + dt.timedelta(days=n)).isoformat()

def returns(px, d):
    """% move: prior close -> event-day close (r0), -> +1d (r1), -> +7d (r7). Daily UTC closes."""
    base = px.get(add_days(d, -1)); c0 = px.get(d); c1 = px.get(add_days(d, 1)); c7 = px.get(add_days(d, 7))
    if not base: return None
    f = lambda c: (c / base - 1) * 100 if c else None
    return {'r0': f(c0), 'r1': f(c1), 'r7': f(c7)}

def summarize(rows, key):
    v = [r[key] for r in rows if r.get(key) is not None]
    if not v: return {'n': 0}
    return {'n': len(v), 'mean': st.mean(v), 'median': st.median(v), 'pct_up': sum(1 for x in v if x > 0) / len(v) * 100, 'mean_abs': st.mean(abs(x) for x in v)}

def main():
    today = dt.date.today().isoformat()
    years = list(range(2015, dt.date.today().year + 1))
    print('prices…')
    btc = dict(fred('CBBTCUSD'))
    sol = dict(coinbase_daily('SOL-USD'))
    print('btc days', len(btc), 'sol days', len(sol))
    # baseline daily abs move for context
    def base_abs(px):
        ks = sorted(px); ch = [abs(px[ks[i]] / px[ks[i - 1]] - 1) * 100 for i in range(1, len(ks)) if px[ks[i - 1]]]
        return st.mean(ch) if ch else None
    events = []
    # FOMC: rate changes from DFEDTARU (effective the day after the announcement) + holds from the Fed calendar
    up = fred('DFEDTARU', '2014-12-01')
    upd = dict(up)
    for i in range(1, len(up)):
        if up[i][1] != up[i - 1][1]:
            bp = round((up[i][1] - up[i - 1][1]) * 100)
            events.append({'type': 'fomc', 'date': add_days(up[i][0], -1), 'outcome': 'hike' if bp > 0 else 'cut', 'detail': f'{bp:+d}bp to {up[i][1] - 0.25:.2f}-{up[i][1]:.2f}%'})
    changed = {e['date'] for e in events}
    try:
        for m in fomc_meetings():
            if m < today and m not in changed and add_days(m, 1) not in changed and m >= '2015-01-01':
                lvl = max((v for d, v in up if d <= m), default=None)
                lv = [v for d, v in up if d <= m]
                events.append({'type': 'fomc', 'date': m, 'outcome': 'hold', 'detail': f'held at {lv[-1] - 0.25:.2f}-{lv[-1]:.2f}%' if lv else 'hold'})
    except Exception as e: print('fomc calendar', e)
    # NFP: release dates (FRED calendar rid=50); surprise proxy = m/m payroll change vs median of prior 12 months (no free consensus data)
    pay = fred('PAYEMS', '2013-01-01'); payd = dict(pay)
    chg = {pay[i][0][:7]: pay[i][1] - pay[i - 1][1] for i in range(1, len(pay))}
    months = sorted(chg)
    official = release_dates(50, years)
    nfp_dates = sorted(set(official) | {nfp_rule(y, mo) for y in range(2015, 2025) for mo in range(1, 13)})
    nfp_src = {d: ('FRED calendar' if d in official else 'BLS rule') for d in nfp_dates}
    for d in nfp_dates:
        if d >= today: continue
        ref = (dt.date.fromisoformat(d).replace(day=1) - dt.timedelta(days=1)).strftime('%Y-%m')
        if ref not in chg: continue
        i = months.index(ref); prior = [chg[m] for m in months[max(0, i - 12):i]]
        if len(prior) < 6: continue
        med = st.median(prior)
        if abs(chg[ref]) > 2000: continue   # skip 2020 COVID swings (meaningless as surprises)
        events.append({'type': 'nfp', 'date': d, 'outcome': 'hot' if chg[ref] > med else 'cold', 'detail': f'{ref}: {chg[ref]:+.0f}K vs trailing median {med:+.0f}K', 'dateSource': nfp_src[d]})
    # CPI: release dates (rid=10). FRED's calendar only serves 2025+, and CPI dates follow no simple rule, so CPI history is short.; hot/cold = m/m vs trailing-12 median m/m
    cpi = fred('CPIAUCSL', '2013-01-01')
    mom = {cpi[i][0][:7]: (cpi[i][1] / cpi[i - 1][1] - 1) * 100 for i in range(1, len(cpi))}
    cm = sorted(mom)
    for d in release_dates(10, years):
        if d >= today: continue
        ref = (dt.date.fromisoformat(d).replace(day=1) - dt.timedelta(days=1)).strftime('%Y-%m')
        if ref not in mom: continue
        i = cm.index(ref); prior = [mom[m] for m in cm[max(0, i - 12):i]]
        if len(prior) < 6: continue
        med = st.median(prior)
        events.append({'type': 'cpi', 'date': d, 'outcome': 'hot' if mom[ref] > med else 'cold', 'detail': f'{ref}: {mom[ref]:+.2f}% m/m vs trailing median {med:+.2f}%'})
    events.sort(key=lambda e: e['date'])
    for e in events:
        e['btc'] = returns(btc, e['date']); e['sol'] = returns(sol, e['date'])
    groups = {}
    for e in events:
        for k in (e['type'] + ':' + e['outcome'], e['type'] + ':all'):
            groups.setdefault(k, []).append(e)
    summary = {}
    for g, rows in sorted(groups.items()):
        summary[g] = {asset: {h: summarize([r[asset] for r in rows if r.get(asset)], h) for h in ('r0', 'r1', 'r7')} for asset in ('btc', 'sol')}
        summary[g]['n_events'] = len(rows)
        summary[g]['first'] = rows[0]['date']; summary[g]['last'] = rows[-1]['date']
    out = {
        'generatedAt': int(time.time() * 1000),
        'baseline': {'btc_mean_abs_daily_move': base_abs(btc), 'sol_mean_abs_daily_move': base_abs(sol), 'btc_since': min(btc), 'sol_since': min(sol)},
        'summary': summary, 'events': events[-120:], 'n_events': len(events),
        'method': 'Move = prior UTC daily close -> close on event day (r0), next day (r1), +7 days (r7). FOMC hikes/cuts dated from changes in the FRED target-range upper bound (DFEDTARU, effective the day after the announcement), holds from the Fed meeting calendar (covers recent years only). NFP/CPI "hot" or "cold" = the released m/m change vs the median of the prior 12 months, a crude proxy because free consensus forecasts do not exist. Uses today\'s revised data, not the first print.',
        'caveats': [
            'Release dates: FRED\'s calendar only covers 2025 onward. Earlier jobs-report dates are computed from the BLS scheduling rule (it matched every official 2025-26 date except shutdown delays). CPI events are 2025+ only.',
            'Small samples: e.g. only a handful of hikes/cuts since 2015, and SOL history starts mid-2021.',
            'Regimes overlap: crypto-specific news (ETFs, halvings, hacks) dominates many of these days.',
            'Daily closes in UTC: a 2pm ET FOMC decision and an 8:30am ET jobs report land inside one candle with everything else that day.',
            '"Hot/cold" is vs trailing trend, not vs Wall Street consensus (consensus data needs a paid feed, e.g. Trading Economics or Bloomberg).',
            'FRED data are revised: payroll changes here are the latest vintage, not what markets saw at release (ALFRED first-release data needs a free FRED API key).',
            'Descriptive statistics only. Not a trading signal or financial advice.',
        ],
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, 'macro_events.json'), 'w') as f: json.dump(out, f)
    for g in ('fomc:hike', 'fomc:cut', 'fomc:hold', 'nfp:hot', 'nfp:cold', 'cpi:hot', 'cpi:cold'):
        s = summary.get(g)
        if s: print(g, s['n_events'], 'BTC r0', {k: round(v, 2) for k, v in s['btc']['r0'].items() if k != 'n'}, s['btc']['r0']['n'], 'r7 med', round(s['btc']['r7'].get('median') or 0, 2), '| SOL r0 n', s['sol']['r0']['n'], 'med', round(s['sol']['r0'].get('median') or 0, 2), 'r7 med', round(s['sol']['r7'].get('median') or 0, 2))
    print('baseline', out['baseline'])

if __name__ == '__main__': main()
