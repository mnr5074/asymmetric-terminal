#!/usr/bin/env python3
"""Revival lab: (1) backtest the Sleeper technical signals on known revivals, (2) Accumulation-phase detector with base rates,
(3) LOOKALIKE engine (pre-breakout fingerprints, nearest-neighbour match), (4) holder-distribution metrics where free.
Daily data = CoinGecko 365-day history (free limit), cached in data/cg_series/. Output: data/revival_lab.json and
lookalike/accumulation fields merged into data/sleepers.json. Small samples; estimates, not advice.

Holder-behaviour data availability (checked 2026-10-11):
  free, used: GoPlus top-holder list + holder count (EVM), RugCheck (Solana), our own repeated snapshots (holder growth).
  needs a key / paid: holding-period buckets, cost basis / % in profit, wallet age, funding-source clustering, active addresses
  history -> Etherscan v2 (free key), Helius/Birdeye (Solana), Bitquery/Dune (free tier with key), Glassnode/IntoTheBlock (paid).
  Public RPCs serve only ~10k recent blocks (no archive), so history cannot be rebuilt keylessly."""
import json, math, os, statistics, time, urllib.request
from common import DATA_DIR
import sleepers as S

CASES = ['zcash', 'dash', 'derive', 'aerodrome-finance']
FEATS = ['dd_365h', 'vol_comp', 'vol_trend', 'rs30', 'rs90', 'range60', 'ch30', 'ch90']

def feats_at(px, vol, btc, i):
    if i < 180: return None
    P, V, B = px[:i + 1], vol[:i + 1], btc[:i + 1]
    t = S.technicals(P, V, B)
    if not t: return None
    return {'dd_365h': P[-1] / max(P[-180:]) - 1, 'vol_comp': t['vol_comp_20v120'] or 1, 'vol_trend': t['vol_trend_30v90'], 'rs30': t['rs_btc_30d'] or 0, 'rs90': t['rs_btc_prior90d'] or 0,
            'range60': t['range60'], 'ch30': t['ch30'], 'ch90': P[-1] / P[-91] - 1, '_t': t}
def breakout_day(px, start=120):
    """First day price >= 2x its 60-day low AND a new 90-day high."""
    for i in range(start, len(px)):
        if px[i] >= 2 * min(px[i - 60:i]) and px[i] >= max(px[i - 90:i]): return i
    return None
def accumulation(f):
    """Flat price + compressed volatility + rising volume (holder/exchange-flow data not free -> volume proxy)."""
    t = f['_t']; conds = [abs(f['ch30']) < 0.15, f['range60'] < 0.5, (t['vol_comp_20v120'] or 1) < 0.8, f['vol_trend'] > 1.2]
    return sum(conds), conds

def main():
    log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
    sl = json.load(open(os.path.join(DATA_DIR, 'sleepers.json')))
    ids = list(dict.fromkeys(CASES + [x['id'] for x in sl['items']]))
    bpx, bv, bd = S.series('bitcoin'); bmap = dict(zip(bd, bpx))
    data = {}
    for id_ in ids:
        try: px, vol, ds = S.series(id_); data[id_] = (px, vol, [bmap.get(d) for d in ds], ds)
        except Exception as e: log('series', id_, e)
    # ---- (1) revival backtest on named cases: sleeper technical score per day; when would it have fired?
    cases = []
    for id_ in CASES:
        if id_ not in data: continue
        px, vol, b, ds = data[id_]; bo = breakout_day(px)
        first = None; hist = []
        for i in range(180, len(px)):
            t = S.technicals(px[:i + 1], vol[:i + 1], b[:i + 1])
            if not t: continue
            sc = 15 * t['s_comp'] / 1 + 15 * t['s_rs'] + 10 * t['s_acc']  # technical part only (max 40); fundamentals/narrative are not historical
            hist.append(sc)
            if sc >= 22 and first is None: first = i
        lo = min(range(len(px)), key=lambda i: px[i]); hi = max(range(len(px)), key=lambda i: px[i])
        cases.append({'id': id_, 'start': ds[0], 'start_price': px[0], 'low': px[lo], 'low_date': ds[lo], 'high': px[hi], 'high_date': ds[hi], 'now': px[-1], 'low_to_high_x': px[hi] / px[lo],
                      'breakout_date': ds[bo] if bo else None, 'breakout_price': px[bo] if bo else None,
                      'first_flag_date': ds[first] if first is not None else None, 'first_flag_price': px[first] if first is not None else None,
                      'flag_lead_days_vs_breakout': (bo - first) if (bo is not None and first is not None) else None,
                      'return_flag_to_high_x': px[hi] / px[first] if first is not None and hi > first else None,
                      'note': 'Window starts 180 days into the 365-day history (signals need 120-180 days of lookback), so a breakout earlier than that cannot be flagged.'})
    # ---- (2) accumulation detector base rate across all cached tokens (day-level, non-overlapping 30d outcome)
    fired = ok = base_n = base_ok = 0
    for id_, (px, vol, b, ds) in data.items():
        for i in range(180, len(px) - 30, 5):
            f = feats_at(px, vol, b, i)
            if not f: continue
            fwd = max(px[i + 1:i + 31]) / px[i] - 1
            base_n += 1; base_ok += fwd >= 0.3
            n, _ = accumulation(f)
            if n >= 3: fired += 1; ok += fwd >= 0.3
    acc = {'samples': base_n, 'base_rate_30pct_up_within_30d': base_ok / base_n if base_n else None, 'flags': fired, 'hit_rate_when_flagged': ok / fired if fired else None,
           'definition': '>=3 of: |30d change| <15%, 60-day range <50%, 20d vol <0.8x 120d vol, 30d volume >1.2x prior 90d. Outcome: max price within next 30 days >= +30%. Sampled every 5 days on ' + str(len(data)) + ' tokens (heavily overlapping, survivorship-biased: today\'s top-1000).'}
    # ---- (3) lookalike fingerprints: 30-180 days before breakout -> sample at breakout-45d (or mean of 30..90d window)
    fps = []
    for id_, (px, vol, b, ds) in data.items():
        bo = breakout_day(px, 200)
        if bo is None: continue
        vecs = [feats_at(px, vol, b, j) for j in range(max(180, bo - 90), bo - 29, 5)]
        vecs = [v for v in vecs if v]
        if not vecs: continue
        fp = {k: statistics.mean(v[k] for v in vecs) for k in FEATS}
        fps.append({'id': id_, 'breakout_date': ds[bo], 'gain_after_x': max(px[bo:]) / px[bo - 30], 'fp': fp})
    log('fingerprints', len(fps), [f['id'] for f in fps][:12])
    allv = [f['fp'] for f in fps]
    sd = {k: (statistics.pstdev([v[k] for v in allv]) or 1) if len(allv) > 1 else 1 for k in FEATS}
    def sim(a, b): d = math.sqrt(sum(((a[k] - b[k]) / sd[k]) ** 2 for k in FEATS) / len(FEATS)); return math.exp(-d) * 100
    # backtest: for each token/day, top lookalike (other tokens' fingerprints) similarity; breakout within 60 days?
    hi_n = hi_ok = all_n = all_ok = 0
    for id_, (px, vol, b, ds) in data.items():
        others = [f for f in fps if f['id'] != id_]
        if not others: continue
        for i in range(180, len(px) - 60, 7):
            f = feats_at(px, vol, b, i)
            if not f: continue
            best = max(sim(f, o['fp']) for o in others)
            bo = next((j for j in range(i + 1, i + 61) if px[j] >= 2 * min(px[j - 60:j]) and px[j] >= max(px[j - 90:j])), None)
            all_n += 1; all_ok += bo is not None
            if best >= 60: hi_n += 1; hi_ok += bo is not None
    look_bt = {'samples': all_n, 'base_breakout_rate_60d': all_ok / all_n if all_n else None, 'high_similarity_samples': hi_n, 'breakout_rate_when_similarity_ge60': hi_ok / hi_n if hi_n else None, 'fingerprints': len(fps),
               'definition': 'Breakout = price >= 2x 60-day low and a new 90-day high. Fingerprint = mean of features 30-90 days before breakout. Similarity = exp(-standardized RMS distance). Leave-one-token-out.'}
    # ---- apply to current sleepers
    for x in sl['items']:
        if x['id'] not in data: continue
        px, vol, b, ds = data[x['id']]
        f = feats_at(px, vol, b, len(px) - 1)
        if not f: continue
        n, conds = accumulation(f)
        x['accumulation'] = {'conditions_met': n, 'flag': n >= 3, 'confidence_base_rate': acc['hit_rate_when_flagged'] if n >= 3 else None,
                             'detail': dict(zip(['flat_30d', 'tight_60d_range', 'vol_compressed', 'volume_rising'], conds))}
        ms = sorted([(sim(f, o['fp']), o) for o in fps if o['id'] != x['id']], key=lambda t: -t[0])[:3]
        x['lookalikes'] = [{'like': o['id'], 'similarity': round(s_, 1), 'breakout_date': o['breakout_date'], 'gain_after_x': round(o['gain_after_x'], 2),
                            'compare': {k: {'now': round(f[k], 3), 'them_pre_breakout': round(o['fp'][k], 3)} for k in FEATS}} for s_, o in ms]
    # ---- holder distribution (free): GoPlus for EVM contracts of the top sleepers
    plat_ids = {'ethereum': 1, 'binance-smart-chain': 56, 'base': 8453, 'arbitrum-one': 42161, 'polygon-pos': 137}
    for x in sl['items'][:20]:
        try:
            info = S.cg(f"/coins/{x['id']}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false")
            P = info.get('platforms') or {}; DSC = {'solana': 'solana', 'ethereum': 'ethereum', 'binance-smart-chain': 'bsc', 'base': 'base', 'arbitrum-one': 'arbitrum', 'polygon-pos': 'polygon'}
            for plat in DSC:
                if P.get(plat): x['contract'] = {'chain': DSC[plat], 'address': P[plat]}; break
            for plat, addr in P.items():
                if plat in plat_ids and addr:
                    g = list(S.get(f'https://api.gopluslabs.io/api/v1/token_security/{plat_ids[plat]}?contract_addresses={addr}')['result'].values())[0]
                    ps = sorted([float(h['percent']) for h in g.get('holders') or []], reverse=True)
                    n = len(ps); gini = (sum((2 * (i + 1) - n - 1) * v for i, v in enumerate(sorted(ps))) / (n * sum(ps))) if n and sum(ps) else None
                    x['holders'] = {'chain': plat, 'holder_count': int(g.get('holder_count') or 0), 'top10_pct': sum(ps[:10]) * 100, 'gini_top_holders': gini,
                                    'contracts_in_top10_pct': sum(float(h['percent']) for h in (g.get('holders') or [])[:10] if str(h.get('is_contract')) == '1') * 100,
                                    'needs_key': 'holding periods, cost basis, wallet age, funding clusters: Etherscan v2 / Dune / Bitquery key'}
                    break
        except Exception as e: x['holders_error'] = str(e)[:80]
    # snapshot holder counts over time (growth) -> data/holder_snaps.json
    hf = os.path.join(DATA_DIR, 'holder_snaps.json')
    try: hs = json.load(open(hf))
    except Exception: hs = {}
    for x in sl['items']:
        if x.get('holders'):
            L = hs.setdefault(x['id'], []); L.append([int(time.time()), x['holders']['holder_count']]); hs[x['id']] = L[-200:]
            if len(L) >= 2 and L[-1][0] - L[0][0] > 86400: x['holders']['growth_per_day'] = (L[-1][1] - L[0][1]) / ((L[-1][0] - L[0][0]) / 86400)
    json.dump(hs, open(hf, 'w'))
    for blk, hr, br in ((acc, 'hit_rate_when_flagged', 'base_rate_30pct_up_within_30d'), (look_bt, 'breakout_rate_when_similarity_ge60', 'base_breakout_rate_60d')):
        h, b_ = blk.get(hr), blk.get(br)
        blk['verdict'] = 'no data' if h is None or b_ is None else ('beats base rate' if h > b_ * 1.2 else 'NO EDGE: does not beat the base rate in this sample; treat as descriptive only')
    sl['revival'] = {'cases': cases, 'accumulation': acc, 'lookalike_backtest': look_bt, 'fingerprints': [{'id': f['id'], 'breakout_date': f['breakout_date'], 'gain_after_x': round(f['gain_after_x'], 2)} for f in fps]}
    json.dump(sl, open(os.path.join(DATA_DIR, 'sleepers.json'), 'w'), default=str)
    json.dump(sl['revival'], open(os.path.join(DATA_DIR, 'revival_lab.json'), 'w'), default=str)
    log(json.dumps(cases, default=str)); log(json.dumps(acc)); log(json.dumps(look_bt))
    for x in sl['items'][:8]: log(x['symbol'], x.get('accumulation', {}).get('conditions_met'), [(l['like'], l['similarity']) for l in x.get('lookalikes', [])])

if __name__ == '__main__': main()
