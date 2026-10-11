#!/usr/bin/env python3
"""Detector 1: crash clustering by UTC hour / day-of-week.
Sample: research-DB tokens (cohorts died/middle/mooned, chains solana/base/bsc) + crash_eco stock-paired/pons/robinhood tokens with a
DexScreener pair, hourly OHLCV from GeckoTerminal (free) around the peak. Crash event = close falls >=50% below the peak close within 168h.
Onset hour = UTC hour of the largest single-hour close-to-close drop between the peak and the -50% crossing.
Baselines: uniform 1/24, per-token-normalised volume share by hour, candle-activity share. DOW also from the CoinGecko part of the
crash catalog (ath_date, daily granularity). Output: data/patterns_hours.json"""
import json, os, sqlite3, time, datetime as dt
from patterns_common import *

ASIA = list(range(0, 8))  # pre-registered "Asia session / US asleep" window, 00:00-07:59 UTC
NET = {'solana': 'solana', 'base': 'base', 'bsc': 'bsc', 'robinhood': 'robinhood', 'ethereum': 'eth'}

def sample():
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True); db.row_factory = sqlite3.Row
    out = []
    for r in db.execute("select mint,symbol,chain,cohort,main_pool,peak_ts,created_ts from tokens where cohort in ('died','middle','mooned') and main_pool is not null and peak_ts is not null"):
        out.append({'key': f"{r['chain']}:{r['mint']}", 'symbol': r['symbol'], 'chain': r['chain'], 'cohort': r['cohort'], 'pool': r['main_pool'], 'peak_ts': r['peak_ts'] // 1000, 'src': 'research DB'})
    eco = json.load(open(os.path.join(DATA_DIR, 'crash_eco.json')))['tokens']
    for t in eco:
        o = t.get('ohlcv') or {}
        if not t.get('ds_pair') or not o.get('peak_date') or (o.get('crash_depth_pct') or 0) > -50: continue
        pk = int(dt.datetime.strptime(o['peak_date'], '%Y-%m-%d').replace(tzinfo=UTC).timestamp()) + 43200
        out.append({'key': f"{t['chain']}:{t['address']}", 'symbol': t['symbol'], 'chain': t['chain'], 'cohort': 'eco_crash:' + t['eco'], 'pool': t['ds_pair'].lower() if t['chain'] != 'solana' else t['ds_pair'], 'peak_ts': pk, 'src': 'crash_eco ' + t['eco'], 'quote': t.get('quote')})
    seen, uniq = set(), []
    for s in out:
        if s['key'] in seen: continue
        seen.add(s['key']); uniq.append(s)
    return uniq

def analyse(rows):
    """rows sorted [ts,o,h,l,c,v]. returns event dict or None."""
    if len(rows) < 12: return None
    closes = [r[4] for r in rows]
    pi = max(range(len(rows)), key=lambda i: closes[i]); pk = closes[pi]
    if pk <= 0: return None
    cross = None
    for j in range(pi + 1, len(rows)):
        if rows[j][0] - rows[pi][0] > 168 * 3600: break
        if closes[j] <= 0.5 * pk: cross = j; break
    ev = {'peak_t': rows[pi][0], 'peak_hour': dt.datetime.fromtimestamp(rows[pi][0], UTC).hour, 'peak_idx': pi, 'n': len(rows), 'peak_near_start': rows[pi][0] - rows[0][0] < 6 * 3600}
    if cross is None: ev['crash'] = False; return ev
    best, bj = 0, None
    for j in range(pi + 1, cross + 1):
        r = closes[j] / closes[j - 1] - 1 if closes[j - 1] > 0 else 0
        if r < best: best, bj = r, j
    brk = next(j for j in range(pi + 1, cross + 1) if closes[j] <= 0.7 * pk)
    t = rows[bj][0]; d = dt.datetime.fromtimestamp(t, UTC)
    ev.update({'crash': True, 'onset_t': t, 'onset_hour': d.hour, 'onset_dow': d.weekday(), 'onset_drop_pct': round(best * 100, 1),
               'break_t': rows[brk][0], 'break_hour': dt.datetime.fromtimestamp(rows[brk][0], UTC).hour, 'hours_peak_to_onset': round((t - rows[pi][0]) / 3600, 1),
               'hours_peak_to_half': round((rows[cross][0] - rows[pi][0]) / 3600, 1),
               # sell-pressure proxy at onset: onset-hour volume vs median hourly volume of prior 24h
               'onset_vol_ratio': None})
    prior = sorted(r[5] for r in rows[max(0, bj - 24):bj] if r[5] > 0)
    if prior: ev['onset_vol_ratio'] = round(rows[bj][5] / prior[len(prior) // 2], 2)
    return ev

def main():
    S = sample(); now = time.time(); log('sample', len(S))
    events, base_vol, base_cnt, fetched, errs = [], [0.0] * 24, [0] * 24, 0, []
    for i, s in enumerate(S):
        net = NET.get(s['chain'])
        if not net: continue
        before = s['peak_ts'] + 7 * 86400
        before = None if before > now - 3600 else before
        try: d = gt_hourly(net, s['pool'], before)
        except Exception as e: errs.append([s['key'], str(e)[:120]]); continue
        rows = [r for r in (d or {}).get('rows', []) if r[4] and r[4] > 0]
        if not rows: errs.append([s['key'], (d or {}).get('err', 'empty')]); continue
        fetched += 1
        tv = sum(r[5] for r in rows) or 1
        hv = [0.0] * 24
        for r in rows:
            h = dt.datetime.fromtimestamp(r[0], UTC).hour; hv[h] += r[5] / tv; base_cnt[h] += 1
        for h in range(24): base_vol[h] += hv[h]
        ev = analyse(rows)
        if ev: events.append({**s, **ev})
        if i % 25 == 0: log(i, len(S), 'events', sum(1 for e in events if e.get('crash')))
    crashes = [e for e in events if e.get('crash')]
    tv = sum(base_vol); vol_share = [v / tv for v in base_vol]
    tc = sum(base_cnt); cnt_share = [c / tc for c in base_cnt]
    def hist(xs, k=24):
        h = [0] * k
        for x in xs: h[x] += 1
        return h
    def test(sub, field='onset_hour'):
        hs = hist([e[field] for e in sub]); n = len(sub)
        if n < 10: return {'n': n}
        inw = sum(hs[h] for h in ASIA)
        thin = sorted(range(24), key=lambda h: vol_share[h])[:8]
        inthin = sum(hs[h] for h in thin)
        # 6 x 4h buckets to keep expected counts >=5
        b6 = [sum(hs[h] for h in range(k, k + 4)) for k in range(0, 24, 4)]
        vb6 = [sum(vol_share[h] for h in range(k, k + 4)) for k in range(0, 24, 4)]
        return {'n': n, 'hist': hs,
                'chi2_uniform_24h': chisq(hs, [1 / 24] * 24), 'chi2_volume_24h': chisq(hs, vol_share), 'chi2_activity_24h': chisq(hs, cnt_share),
                'chi2_uniform_4h_buckets': chisq(b6, [1 / 6] * 6), 'chi2_volume_4h_buckets': chisq(b6, vb6), 'buckets_4h': b6,
                'asia_window_utc': '00-08', 'asia_count': inw, 'asia_share': round(inw / n, 3), 'asia_expected_uniform': round(8 / 24, 3),
                'asia_expected_volume': round(sum(vol_share[h] for h in ASIA), 3),
                'asia_p_vs_uniform_one_sided': binom_sf(inw, n, 8 / 24), 'asia_p_vs_volume_one_sided': binom_sf(inw, n, sum(vol_share[h] for h in ASIA)),
                'thinnest8_hours_by_volume': sorted(thin), 'thin8_count': inthin, 'thin8_share': round(inthin / n, 3), 'thin8_expected_volume': round(sum(vol_share[h] for h in thin), 3),
                'thin8_p_vs_volume_one_sided': binom_sf(inthin, n, sum(vol_share[h] for h in thin)),
                'top_hours': sorted(range(24), key=lambda h: -hs[h])[:5]}
    res = {
        'definition': {'crash': 'hourly close falls >=50% below peak close within 168h of peak', 'onset': 'UTC hour of largest 1h close-to-close drop between peak and -50% crossing',
                       'asia_window': 'pre-registered 00:00-07:59 UTC (Asia session, US asleep)', 'baselines': 'uniform; per-token-normalised GeckoTerminal hourly volume share of the same sample; candle-activity share'},
        'sample': {'candidates': len(S), 'fetched': fetched, 'with_events': len(events), 'crash_events': len(crashes), 'non_crash': len(events) - len(crashes), 'errors': len(errs)},
        'baseline_volume_share': [round(v, 4) for v in vol_share], 'baseline_activity_share': [round(v, 4) for v in cnt_share],
        'onset_all': test(crashes), 'onset_excl_launch_peaks': test([e for e in crashes if not e['peak_near_start']]),
        'break_hour_all': test(crashes, 'break_hour'), 'peak_hour_all': test([e for e in events], 'peak_hour'),
        'by_cohort': {c: test([e for e in crashes if e['cohort'] == c]) for c in sorted(set(e['cohort'] for e in crashes))},
        'onset_dow': {'hist_mon0': hist([e['onset_dow'] for e in crashes], 7)}, 'errors': errs[:40],
        'events': [{k: e.get(k) for k in ('key', 'symbol', 'chain', 'cohort', 'pool', 'crash', 'peak_t', 'onset_t', 'onset_hour', 'onset_dow', 'onset_drop_pct', 'break_t', 'hours_peak_to_onset', 'hours_peak_to_half', 'onset_vol_ratio', 'peak_near_start')} for e in events]}
    n = len(crashes)
    if n >= 14: res['onset_dow']['chi2_uniform'] = chisq(res['onset_dow']['hist_mon0'], [1 / 7] * 7)
    # catalog DOW (CoinGecko ath_date, daily granularity)
    cat = json.load(open(os.path.join(DATA_DIR, 'crash_catalog.json')))['catalog']
    dows = [dt.datetime.strptime(c['ath_date'], '%Y-%m-%d').weekday() for c in cat if c.get('ath_date') and c.get('source') == 'coingecko markets' and not c.get('artifact_risk')]
    hd = hist(dows, 7)
    res['catalog_ath_dow'] = {'n': len(dows), 'hist_mon0': hd, 'chi2_uniform': chisq(hd, [1 / 7] * 7), 'weekend_share': round((hd[5] + hd[6]) / len(dows), 3),
                              'weekend_p_vs_2of7_two_sided': binom_two(hd[5] + hd[6], len(dows), 2 / 7), 'note': 'ATH date (UTC day) from CoinGecko; peak day, not hourly onset'}
    save('patterns_hours.json', res)

if __name__ == '__main__': main()
