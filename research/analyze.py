#!/usr/bin/env python3
"""Cohort analysis: 'mooned' (>=100x launch→peak) vs 'died' (now <=10% of peak & illiquid, or rugged).
Ranks features by separation (AUC for numeric, rate gap for categorical) and flags weak/biased patterns.
Writes data/analysis.json. HEURISTIC research, not a prediction."""
import json, math, os, statistics, time
from common import db, ROOT, DATA_DIR

NUM = [  # (column, label, timing)
    ('launch_mcap', 'Launch mcap (first candle, USD)', 'early'),
    ('curve_secs', 'Bonding-curve completion time (s)', 'early'),
    ('vol_first1h', 'Volume in first hour (USD)', 'early'),
    ('vol_first24h', 'Volume in first 24h (USD)', 'early'),
    ('vol24_over_launch_mcap', 'First-24h volume / launch mcap', 'early'),
    ('mult_at_1h', 'Price multiple at +1h', 'path'),
    ('mult_at_24h', 'Price multiple at +24h', 'path'),
    ('hours_to_2x', 'Hours to first 2x', 'path'),
    ('green_ratio_24h', 'Share of green candles, first 24h', 'path'),
    ('max_dd_before_10x', 'Max drawdown before 10x (or ever)', 'path'),
    ('launch_hour_utc', 'Launch hour (UTC)', 'early'),
    ('ticker_len', 'Ticker length', 'early'),
    ('name_len', 'Name length', 'early'),
    ('dev_prior_tokens', 'Dev prior launches (RugCheck)', 'early'),
    ('dev_prior_best_mcap', 'Dev best prior token mcap', 'early'),
    ('profile_delay_h', 'Hours from launch to paid DexScreener profile', 'early'),
    ('first_boost_delay_h', 'Hours from launch to first DexScreener boost', 'early'),
    ('reply_count', 'pump.fun reply count', 'current'),
    ('boost_count', 'DexScreener boosts (lifetime)', 'current'),
    ('n_socials_dex', 'Socials listed on DexScreener', 'current'),
    ('holders_now', 'Holder count (now)', 'current'),
    ('top10_now', 'Top-10 holder % (now)', 'current'),
    ('insider_pct_now', 'Insider-network % (now)', 'current'),
    ('lp_locked_pct', 'LP locked/burned % (now)', 'current'),
    ('winner_overlap', 'Top holders shared with other mooners (LOO)', 'current'),
]
CAT = [
    ('launchpad', 'Launchpad', 'early'), ('theme', 'Name/ticker theme', 'early'), ('launch_dow', 'Launch weekday (UTC, 0=Mon)', 'early'),
    ('hour_bucket', 'Launch time-of-day (UTC)', 'early'), ('has_twitter', 'Has Twitter/X', 'early*'), ('has_telegram', 'Has Telegram', 'early*'),
    ('has_website', 'Has website', 'early*'), ('cto', 'Community takeover (CTO) order', 'current'), ('name_has_digit', 'Digit in name/ticker', 'early'),
    ('ticker_upper', 'All-caps ticker', 'early'), ('mint_auth', 'Mint authority enabled', 'current'), ('freeze_auth', 'Freeze authority enabled', 'current'),
    ('has_profile', 'Paid DexScreener profile (ever)', 'current'),
]

def auc(a, b):
    """P(X_a > X_b) via Mann–Whitney U (ties = 0.5) + normal-approx z."""
    if not a or not b: return None, None
    allv = sorted([(v, 0) for v in a] + [(v, 1) for v in b])
    ranks, i = {}, 0
    r = [0.0] * len(allv)
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]: j += 1
        for k in range(i, j + 1): r[k] = (i + j) / 2 + 1
        i = j + 1
    ra = sum(r[k] for k in range(len(allv)) if allv[k][1] == 0)
    n1, n2 = len(a), len(b)
    u = ra - n1 * (n1 + 1) / 2
    A = u / (n1 * n2)
    sd = math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12) or 1
    return A, (u - n1 * n2 / 2) / sd

def med(x): return statistics.median(x) if x else None
def q(x, p):
    if not x: return None
    s = sorted(x); k = (len(s) - 1) * p; f = math.floor(k); c = math.ceil(k)
    return s[f] if f == c else s[f] + (s[c] - s[f]) * (k - f)

def main():
    c = db()
    allrows = [dict(r) for r in c.execute('SELECT * FROM tokens')]
    rows = [r for r in allrows if (r.get('chain') or 'solana') == 'solana']  # main feature table = Solana (primary); other chains in byChain
    for r in allrows:
        h = r.get('launch_hour_utc')
        r['hour_bucket'] = None if h is None else ['00-05', '06-11', '12-17', '18-23'][h // 6]
        r['has_profile'] = None if r.get('profile_delay_h') is None and r.get('boost_count') is None else int(r.get('profile_delay_h') is not None)
    coh = {}
    for r in rows: coh.setdefault(r['cohort'] or 'unknown', []).append(r)
    M, D, MID = coh.get('mooned', []), coh.get('died', []), coh.get('middle', [])
    out = {'generatedAt': int(time.time() * 1000), 'counts': {k: len(v) for k, v in coh.items()}, 'total': len(rows)}
    # source mix per cohort (selection bias check)
    def mix(rs):
        m = {}
        for r in rs:
            for s in (r.get('sources') or '').split(','): m[s] = m.get(s, 0) + 1
        return dict(sorted(m.items(), key=lambda x: -x[1]))
    out['sourceMix'] = {k: mix(v) for k, v in coh.items() if k in ('mooned', 'died', 'middle', 'too_young')}
    out['launchpadMix'] = {k: {} for k in ('mooned', 'died', 'middle')}
    for k in out['launchpadMix']:
        for r in coh.get(k, []): out['launchpadMix'][k][r.get('launchpad') or '?'] = out['launchpadMix'][k].get(r.get('launchpad') or '?', 0) + 1
    def compute(M, D, MID):
        feats = []
        for col, label, timing in NUM:
            a = [r[col] for r in M if r.get(col) is not None]
            b = [r[col] for r in D if r.get(col) is not None]
            m = [r[col] for r in MID if r.get(col) is not None]
            A, z = auc(a, b)
            flags = []
            if min(len(a), len(b)) < 15: flags.append('small sample')
            if timing == 'current': flags.append('look-ahead: measured now, not at launch')
            if timing == 'path': flags.append('outcome-linked: part of the price path itself')
            if col in ('reply_count', 'holders_now', 'boost_count'): flags.append('survivorship: grows with success/time')
            feats.append({'feature': col, 'label': label, 'type': 'numeric', 'timing': timing, 'n_mooned': len(a), 'n_died': len(b), 'n_middle': len(m),
                          'median_mooned': med(a), 'median_died': med(b), 'median_middle': med(m), 'p25_mooned': q(a, .25), 'p75_mooned': q(a, .75), 'p25_died': q(b, .25), 'p75_died': q(b, .75),
                          'auc': A, 'z': z, 'separation': abs(A - 0.5) * 2 if A is not None else None, 'direction': None if A is None else ('higher in mooned' if A > 0.5 else 'lower in mooned'), 'flags': flags})
        for col, label, timing in CAT:
            levels = sorted({r.get(col) for r in M + D if r.get(col) is not None}, key=str)
            na = sum(1 for r in M if r.get(col) is not None); nb = sum(1 for r in D if r.get(col) is not None)
            lv = []
            for L in levels:
                ka = sum(1 for r in M if r.get(col) == L); kb = sum(1 for r in D if r.get(col) == L)
                ra = ka / na if na else None; rb = kb / nb if nb else None
                lift = ((ka + 0.5) / (na + 1)) / ((kb + 0.5) / (nb + 1)) if na and nb else None
                lv.append({'level': L, 'mooned': ka, 'died': kb, 'rate_mooned': ra, 'rate_died': rb, 'lift': lift})
            gap = max((abs((x['rate_mooned'] or 0) - (x['rate_died'] or 0)) for x in lv), default=None)
            flags = []
            if min(na, nb) < 15: flags.append('small sample')
            if timing == 'current': flags.append('look-ahead: measured now')
            if timing == 'early*': flags.append('socials may have been added after launch')
            if col == 'launchpad': flags.append('selection bias: launchpad mix depends on which feeds were sampled')
            feats.append({'feature': col, 'label': label, 'type': 'categorical', 'timing': timing, 'n_mooned': na, 'n_died': nb, 'levels': lv, 'separation': gap, 'flags': flags})
        # measurement-artifact check: was the launch measured from the bonding curve (curve candles) in both cohorts?
        cov = lambda rs: (sum(1 for r in rs if r.get('curve_secs') is not None) / len(rs)) if rs else 0
        if abs(cov(M) - cov(D)) > 0.3:
            for f in feats:
                if f['feature'] in ('launch_mcap', 'vol_first1h', 'vol_first24h', 'vol24_over_launch_mcap', 'mult_at_1h', 'mult_at_24h', 'curve_secs', 'hours_to_2x', 'green_ratio_24h', 'max_dd_before_10x'):
                    f['flags'].insert(0, f'ARTIFACT: launch measured from curve for {cov(D):.0%} of died but {cov(M):.0%} of mooned (older winners start at graduation)')
        feats.sort(key=lambda f: -(f['separation'] or 0))
        return feats
    out['totalAllChains'] = len(allrows)
    cov = lambda rs: (sum(1 for r in rs if r.get('curve_secs') is not None) / len(rs)) if rs else 0
    out['curveCoverage'] = {'mooned': cov(M), 'died': cov(D)}
    feats = compute(M, D, MID)
    # per-chain cohort comparison (Base / BSC / Ethereum use GoPlus instead of RugCheck; no bonding-curve data except four.meme)
    out['byChain'] = {}
    for ch in sorted({(r.get('chain') or 'solana') for r in allrows}):
        rs = [r for r in allrows if (r.get('chain') or 'solana') == ch]
        cc = {}
        for r in rs: cc.setdefault(r['cohort'] or 'unknown', []).append(r)
        m_, d_, mid_ = cc.get('mooned', []), cc.get('died', []), cc.get('middle', [])
        fs = compute(m_, d_, mid_) if ch != 'solana' else feats
        allm_ = [r['multiple'] for r in rs if r.get('multiple')]
        key = {}
        for k in ('launch_mcap', 'peak_mcap', 'multiple', 'hours_to_10x', 'time_to_peak_h', 'vol_first24h', 'holders_now', 'top10_now', 'lp_locked_pct', 'cur_vs_peak'):
            key[k] = {'mooned': med([r[k] for r in m_ if r.get(k) is not None]), 'died': med([r[k] for r in d_ if r.get(k) is not None]), 'middle': med([r[k] for r in mid_ if r.get(k) is not None])}
        lpm = {}
        for r in rs: lpm[r.get('launchpad') or '?'] = lpm.get(r.get('launchpad') or '?', 0) + 1
        out['byChain'][ch] = {'counts': {k: len(v) for k, v in cc.items()}, 'total': len(rs),
            'multipleDist': {b: sum(1 for m in allm_ if lo <= m < hi) for b, lo, hi in [('<2x', 0, 2), ('2-10x', 2, 10), ('10-100x', 10, 100), ('100-1000x', 100, 1000), ('>=1000x', 1000, 1e18)]},
            'medians': key, 'launchpads': dict(sorted(lpm.items(), key=lambda x: -x[1])[:8]),
            'features': [f for f in fs if f.get('separation') is not None][:15],
            'top': [{k: r.get(k) for k in ('mint', 'symbol', 'launchpad', 'multiple', 'launch_mcap', 'peak_mcap', 'cur_mcap', 'cohort', 'created_ts')} for r in sorted([r for r in rs if r.get('cohort') in ('mooned', 'middle', 'died', 'too_young')], key=lambda r: -(r.get('multiple') or 0))[:12]]}
    out['features'] = feats
    # path to 100x (per token + aggregate)
    paths = []
    for r in sorted(M, key=lambda r: -(r.get('multiple') or 0)):
        paths.append({k: r.get(k) for k in ('mint', 'symbol', 'launchpad', 'created_ts', 'launch_mcap', 'peak_mcap', 'multiple', 'hours_to_10x', 'hours_to_100x', 'vol_to_10x', 'vol_to_100x', 'time_to_peak_h', 'cur_vs_peak', 'cur_mcap', 'holders_now', 'curve_secs', 'theme')})
    agg = {}
    for k in ('launch_mcap', 'hours_to_10x', 'hours_to_100x', 'vol_to_10x', 'vol_to_100x', 'time_to_peak_h', 'cur_vs_peak', 'multiple', 'holders_now'):
        xs = [p[k] for p in paths if p.get(k) is not None]
        agg[k] = {'n': len(xs), 'median': med(xs), 'p25': q(xs, .25), 'p75': q(xs, .75)}
    out['pathTo100x'] = {'tokens': paths, 'aggregate': agg,
        'roundTrip': sum(1 for p in paths if (p.get('cur_vs_peak') or 1) <= 0.1),
        'note': 'Holder counts and buy counts at 10x/100x milestones need historical holder/trade data (Helius/Bitquery/Birdeye); free sources only give volume along the price path and holder count NOW.'}
    # died stats
    dd = {}
    for k in ('multiple', 'time_to_peak_h', 'launch_mcap', 'peak_mcap', 'curve_secs', 'cur_vs_peak'):
        xs = [r[k] for r in D if r.get(k) is not None]
        dd[k] = {'n': len(xs), 'median': med(xs)}
    out['diedStats'] = dd
    # multiples distribution among all resolved tokens
    allm = [r['multiple'] for r in rows if r.get('multiple')]
    out['multipleDist'] = {b: sum(1 for m in allm if lo <= m < hi) for b, lo, hi in [('<2x', 0, 2), ('2-10x', 2, 10), ('10-100x', 10, 100), ('100-1000x', 100, 1000), ('>=1000x', 1000, 1e18)]}
    sf = coh.get('suspect_fake', [])
    out['suspectFake'] = {'n': len(sf), 'claimed_peak_mcap_sum': sum(r.get('peak_mcap') or 0 for r in sf),
        'share_of_pump_mcap_feed': (sum(1 for r in sf if 'pump_mcap' in (r.get('sources') or '')) / max(1, sum(1 for r in rows if 'pump_mcap' in (r.get('sources') or '')))),
        'examples': [{k: r.get(k) for k in ('mint', 'symbol', 'cur_mcap', 'quote_liq_usd', 'peak_mcap', 'vol_total', 'quality', 'created_ts')} for r in sorted(sf, key=lambda r: -(r.get('cur_mcap') or 0))[:12]]}
    keep = ('chain', 'mint', 'symbol', 'launchpad', 'cohort', 'multiple', 'launch_mcap', 'peak_mcap', 'cur_mcap', 'cur_vs_peak', 'hours_to_10x', 'hours_to_100x', 'curve_secs', 'theme', 'holders_now', 'created_ts', 'quality', 'sources')
    out['tokens'] = [{k: r.get(k) for k in keep} for r in allrows]
    out['caveats'] = [
        f"Curve coverage: {out['curveCoverage']['mooned']:.0%} of mooned vs {out['curveCoverage']['died']:.0%} of died tokens have bonding-curve candles. Mooned tokens are mostly older, and GeckoTerminal no longer serves their curve pool, so their 'launch' is the first post-graduation candle (~$30-50K mcap). Their multiples are understated and launch-mcap/early-volume gaps are largely an artifact.",
        'Free GeckoTerminal OHLCV only covers the last 180 days, so older winners (e.g. TROLL, launched 2024) are excluded as out_of_window — the mooned cohort is therefore recent-only.',
        'Launch price = first candle open of the earliest indexed pool (pump.fun curve if indexed). For tokens that started elsewhere the multiple is understated.',
        'Peak uses candle CLOSE, not wick high, to reduce single-trade spikes; thin pools can still print outliers.',
        'Holder counts, top-10 %, insider %, LP lock, boosts and replies are CURRENT snapshots (look-ahead/survivorship): winners accumulate holders and boosts after mooning.',
        'Candidate sampling is not random: market-cap-sorted feeds over-represent survivors; graduated-recent feeds over-represent young tokens. Compare the source mix per cohort before trusting a pattern.',
        'Self-priced "fake mcap" tokens (tiny quote-side liquidity or negligible turnover vs claimed peak) are removed into a suspect_fake bucket before any cohort stats.',
        'Only GRADUATED pump.fun coins are sampled; the ~99% of launches that never leave the bonding curve are not in the loser cohort, so "died" means died after graduating.',
        'Winners mostly come from the market-cap-DESC feed and losers from the market-cap-ASC graduated feed, so cohort membership partly follows the feed it came from. Features tied to the feeds (launchpad, recency) are especially suspect.',
        'Many features are tested; with this sample size some apparent separation is noise (multiple comparisons). Treat |z|<2 or n<15 as unproven.',
    ]
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, 'analysis.json'), 'w') as f: json.dump(out, f, default=lambda o: None)
    print(json.dumps({'counts': out['counts'], 'top': [(f['feature'], round(f['separation'] or 0, 2), f.get('direction'), f['n_mooned'], f['n_died']) for f in feats[:12]]}, indent=1))

if __name__ == '__main__':
    main()
