#!/usr/bin/env python3
"""Live moonshot-similarity screener (HEURISTIC, not a prediction).
Scores young tokens by how their EARLY-available features resemble the mooned vs died cohorts
(binned naive-Bayes likelihood ratios learned from data/moonshot.db). Writes data/screener.json."""
import json, math, os, time, statistics
from common import db, get, ROOT, DATA_DIR
import collect

EARLY = ['launch_mcap', 'curve_secs', 'vol_first1h', 'vol24_over_launch_mcap', 'launch_hour_utc', 'ticker_len', 'name_len', 'dev_prior_tokens', 'dev_prior_best_mcap', 'profile_delay_h']
EARLY_CAT = ['launchpad', 'theme', 'has_twitter', 'has_telegram', 'has_website', 'name_has_digit', 'ticker_upper', 'launch_dow']

def excluded_features():
    """Skip features analyze.py flagged as measurement artifacts or small-sample."""
    try:
        a = json.load(open(os.path.join(DATA_DIR, 'analysis.json')))
        return {f['feature'] for f in a['features'] if any(x.startswith('ARTIFACT') or x == 'small sample' for x in f.get('flags', []))}
    except Exception: return set()

def model(rows):
    ex = excluded_features()
    M = [r for r in rows if r['cohort'] == 'mooned']; D = [r for r in rows if r['cohort'] == 'died']
    mdl = {'num': {}, 'cat': {}, 'n_mooned': len(M), 'n_died': len(D)}
    mdl['excluded'] = sorted(ex)
    for f in EARLY:
        if f in ex: continue
        vals = sorted(r[f] for r in M + D if r.get(f) is not None)
        a = [r[f] for r in M if r.get(f) is not None]; b = [r[f] for r in D if r.get(f) is not None]
        if len(a) < 5 or len(b) < 5: continue
        edges = [vals[int(len(vals) * k / 4)] for k in (1, 2, 3)]
        def bins(xs): 
            cnt = [0, 0, 0, 0]
            for x in xs: cnt[sum(1 for e in edges if x > e)] += 1
            return cnt
        ca, cb = bins(a), bins(b)
        lr = [math.log(((ca[i] + 1) / (len(a) + 4)) / ((cb[i] + 1) / (len(b) + 4))) for i in range(4)]
        mdl['num'][f] = {'edges': edges, 'lr': lr, 'n': [len(a), len(b)]}
    for f in EARLY_CAT:
        if f in ex: continue
        a = [r[f] for r in M if r.get(f) is not None]; b = [r[f] for r in D if r.get(f) is not None]
        if len(a) < 5 or len(b) < 5: continue
        lv = set(a) | set(b)
        mdl['cat'][f] = {str(L): math.log(((a.count(L) + 1) / (len(a) + len(lv))) / ((b.count(L) + 1) / (len(b) + len(lv)))) for L in lv}
    return mdl

def score(mdl, r):
    parts, s = [], 0.0
    for f, m in mdl['num'].items():
        x = r.get(f)
        if x is None: continue
        i = sum(1 for e in m['edges'] if x > e); v = max(-1.5, min(1.5, m['lr'][i])); s += v; parts.append((f, round(v, 2)))
    for f, m in mdl['cat'].items():
        x = r.get(f)
        if x is None or str(x) not in m: continue
        v = max(-1.5, min(1.5, m[str(x)])); s += v; parts.append((f, round(v, 2)))
    prior = math.log((mdl['n_mooned'] + 1) / (mdl['n_died'] + 1))
    return round(100 / (1 + math.exp(-(s))), 1), sorted(parts, key=lambda p: -abs(p[1]))[:6], round(s, 2)

def trade_stats(pool):
    """Recent trades (GeckoTerminal, last 24h, max 300): unique buyers, buy-size distribution."""
    d = get(f'https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/trades') or {}
    tr = [t['attributes'] for t in d.get('data') or []]
    buys = [t for t in tr if t.get('kind') == 'buy']; sells = [t for t in tr if t.get('kind') == 'sell']
    sizes = [float(t.get('volume_in_usd') or 0) for t in buys]
    return {'trades': len(tr), 'buys': len(buys), 'sells': len(sells), 'unique_buyers': len({t.get('tx_from_address') for t in buys}),
            'median_buy_usd': statistics.median(sizes) if sizes else None, 'pct_buys_over_1k': (sum(1 for x in sizes if x > 1000) / len(sizes) * 100) if sizes else None,
            'top_buyer_share': (max(sizes) / sum(sizes) * 100) if sizes and sum(sizes) else None}

def main(limit=14):
    c = db()
    rows = [dict(r) for r in c.execute("SELECT * FROM tokens WHERE cohort IN ('mooned','died') AND COALESCE(chain,'solana')='solana'")]
    mdl = model(rows)
    cands = []
    for x in get('https://frontend-api-v3.pump.fun/coins?offset=0&limit=40&sort=created_timestamp&order=DESC&includeNsfw=false&complete=true') or []:
        cands.append((x['mint'], 'pump_graduated_live', json.dumps(collect.pump_hint(x))))
    for x in (get('https://www.stonkfun.xyz/api/public/v1/tokens?sort=newest&status=graduated&pageSize=15') or {}).get('data', {}).get('tokens', []):
        cands.append((x['mint'], 'stonkfun_live', json.dumps({'stonk': True, 'created_ms': collect._iso(x.get('createdAt')), 'graduatedAt': collect._iso(x.get('graduatedAt'))})))
    for x in get('https://api.dexscreener.com/token-profiles/latest/v1') or []:
        if x.get('chainId') == 'solana': cands.append((x['tokenAddress'], 'ds_profiles_live', None))
    seen, out = set(), []
    for mint, src, hint in cands:
        if mint in seen or len(out) >= limit: continue
        seen.add(mint)
        try:
            rec, _ = collect.enrich(mint, src, hint)
        except Exception as e:
            continue
        if not rec.get('created_ts') or time.time() * 1000 - rec['created_ts'] > 3 * 86400e3: continue
        sc, parts, logit = score(mdl, rec)
        ts = {}
        try:
            if rec.get('main_pool'): ts = trade_stats(rec['main_pool'])
        except Exception: pass
        out.append({'mint': mint, 'symbol': rec.get('symbol'), 'name': rec.get('name'), 'source': src, 'launchpad': rec.get('launchpad'), 'theme': rec.get('theme'), 'age_h': (time.time() * 1000 - rec['created_ts']) / 3600e3,
                    'cur_mcap': rec.get('cur_mcap'), 'cur_liq': rec.get('cur_liq'), 'multiple_so_far': rec.get('multiple'), 'curve_secs': rec.get('curve_secs'), 'dev_prior_tokens': rec.get('dev_prior_tokens'),
                    'similarity': sc, 'logit': logit, 'drivers': parts, 'trades': ts, 'holders_now': rec.get('holders_now'), 'top10_now': rec.get('top10_now')})
    out.sort(key=lambda r: -r['similarity'])
    res = {'generatedAt': int(time.time() * 1000), 'model': {'n_mooned': mdl['n_mooned'], 'n_died': mdl['n_died'], 'features': list(mdl['num']) + list(mdl['cat']), 'excluded': mdl['excluded']}, 'tokens': out,
           'disclaimer': 'Similarity to past 100x tokens on a handful of early features, learned from a small, biased sample. NOT a prediction or advice; most tokens with high similarity still go to zero.'}
    with open(os.path.join(DATA_DIR, 'screener.json'), 'w') as f: json.dump(res, f)
    print(json.dumps({'model': res['model'], 'top': [(t['symbol'], t['similarity']) for t in out[:8]]}))

if __name__ == '__main__':
    main()
