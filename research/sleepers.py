#!/usr/bin/env python3
"""Sleeper / Revival screener for established, overlooked tokens. Output: data/sleepers.json (+ call log calls_sleepers.json).
Sources (keyless, verified 2026-10-11): CoinGecko public API (markets, categories, per-category members, 365-day history,
developer data), DefiLlama fees/revenue overview + protocols (TVL), Hyperliquid perps (funding, open interest).
Not free: holder counts / exchange flows for most chains (needs Glassnode/Nansen/Arkham), X mention counts, history beyond 365 days.
Estimates, not advice."""
import json, math, os, time, statistics, urllib.request, datetime as dt
from common import DATA_DIR
from calltrack import Tracker

UA = {'user-agent': 'Mozilla/5.0 (asymmetric-terminal research)', 'accept': 'application/json'}
CG = 'https://api.coingecko.com/api/v3'
_last = [0.0]
def get(url, data=None, timeout=40, gap=0.0):
    for i in range(4):
        w = _last[0] + gap - time.time()
        if w > 0: time.sleep(w)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers={**UA, **({'content-type': 'application/json'} if data is not None else {})})
            return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
        except Exception as e:
            if i == 3: raise
            time.sleep(15 if '429' in str(e) else 3)
cg = lambda path: get(CG + path, gap=6.5)  # public CoinGecko ~10 calls/min
clip = lambda x: max(0.0, min(1.0, x))
NARRATIVES = {'privacy-coins': 'Privacy', 'real-world-assets-rwa': 'RWA', 'perpetuals': 'Perps DEX', 'options': 'Options', 'artificial-intelligence': 'AI',
              'decentralized-exchange': 'DEX', 'layer-1': 'L1', 'layer-2': 'L2', 'depin': 'DePIN', 'gaming': 'Gaming', 'meme-token': 'Meme',
              'liquid-staking-tokens': 'Liquid staking', 'lending-borrowing': 'Lending', 'oracle': 'Oracles', 'proof-of-work-pow': 'PoW'}
SKIP = ('usd', 'eur', 'wrapped', 'bridged', 'staked', 'stablecoin')

SER_DIR = os.path.join(DATA_DIR, 'cg_series'); os.makedirs(SER_DIR, exist_ok=True)
def series(id_, days=365, max_age=12 * 3600):
    f = os.path.join(SER_DIR, f'{id_}.json')
    try:
        if time.time() - os.path.getmtime(f) < max_age: d = json.load(open(f))
        else: raise FileNotFoundError
    except Exception:
        d = cg(f'/coins/{id_}/market_chart?vs_currency=usd&days={days}&interval=daily'); json.dump(d, open(f, 'w'))
    return [p for _, p in d['prices']], [v for _, v in d['total_volumes']], [dt.datetime.fromtimestamp(t / 1000, dt.UTC).strftime('%Y-%m-%d') for t, _ in d['prices']]
def rv(px, n):
    r = [math.log(px[i] / px[i - 1]) for i in range(len(px) - n, len(px)) if px[i - 1] > 0 and px[i] > 0]
    return statistics.pstdev(r) * math.sqrt(365) if len(r) > 3 else None

def technicals(px, vol, btc, i=None):
    """Signals at day i (default last) from daily price/volume and BTC: compression->expansion, RS vs BTC turn, accumulation proxy."""
    i = len(px) - 1 if i is None else i
    if i < 120: return None
    P, V, B = px[:i + 1], vol[:i + 1], btc[:i + 1]
    v20, v120 = rv(P, 20), rv(P, 120); v5 = rv(P, 5)
    comp = (v20 / v120) if v20 and v120 else None
    expand = (v5 / v20) if v5 and v20 else None
    rs = [P[k] / B[k] for k in range(len(P)) if B[k]]
    rs30 = rs[-1] / rs[-31] - 1 if len(rs) > 31 else None
    rs90 = rs[-31] / rs[-121] - 1 if len(rs) > 121 else None
    vt = statistics.mean(V[-30:]) / (statistics.mean(V[-120:-30]) or 1)
    rng60 = max(P[-60:]) / min(P[-60:]) - 1
    ch30 = P[-1] / P[-31] - 1
    s_comp = clip((0.9 - (comp or 1)) / 0.4) * 0.5 + clip(((expand or 1) - 1) / 1.0) * 0.5
    s_rs = clip((rs30 or 0) / 0.3 + 0.3) * (1.0 if (rs90 or 0) < 0 else 0.6)  # turning up after a downtrend scores best
    s_acc = clip((vt - 1) / 1.5) * (1.0 if rng60 < 0.6 else 0.5)
    return {'vol_comp_20v120': comp, 'vol_expand_5v20': expand, 'rs_btc_30d': rs30, 'rs_btc_prior90d': rs90, 'vol_trend_30v90': vt, 'range60': rng60, 'ch30': ch30,
            's_comp': s_comp, 's_rs': s_rs, 's_acc': s_acc}

def main():
    log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
    status = {}
    mk = []
    for page in (1, 2, 3, 4):
        try: mk += cg(f'/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page={page}&price_change_percentage=7d,30d,1y')
        except Exception as e: status[f'coingecko markets p{page}'] = f'failed: {e}'
    status['coingecko markets'] = f'ok ({len(mk)})'
    now = dt.datetime.now(dt.UTC)
    # fundamentals: DefiLlama fees + revenue + TVL mapped to gecko ids
    gid = {}; fees = {}; rev = {}; tvl = {}
    try:
        protos = get('https://api.llama.fi/protocols')
        for p in protos:
            if p.get('gecko_id'): gid[p['slug']] = p['gecko_id']; tvl.setdefault(p['gecko_id'], {'tvl': 0, 'ch7': p.get('change_7d'), 'ch1m': p.get('change_1m')}); tvl[p['gecko_id']]['tvl'] += p.get('tvl') or 0
        status['defillama protocols'] = f'ok ({len(protos)})'
    except Exception as e: status['defillama protocols'] = f'failed: {e}'
    for kind, store in (('dailyFees', fees), ('dailyRevenue', rev)):
        try:
            d = get(f'https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType={kind}')
            for p in d['protocols']:
                g = gid.get(p.get('slug')) or gid.get((p.get('parentProtocol') or '').replace('parent#', ''))
                if not g: continue
                x = store.setdefault(g, {'d30': 0, 'p30': 0})
                x['d30'] += p.get('total30d') or 0; x['p30'] += p.get('total60dto30d') or 0
            status[f'defillama {kind}'] = f'ok ({len(store)} mapped)'
        except Exception as e: status[f'defillama {kind}'] = f'failed: {e}'
    # funding/OI
    hl = {}
    try:
        meta, ctx = get('https://api.hyperliquid.xyz/info', {'type': 'metaAndAssetCtxs'})
        for u, c in zip(meta['universe'], ctx): hl[u['name'].upper()] = {'funding_8h': float(c['funding']) * 8, 'oi_usd': float(c['openInterest']) * float(c['markPx'])}
        status['hyperliquid'] = f'ok ({len(hl)} perps)'
    except Exception as e: status['hyperliquid'] = f'failed: {e}'
    # narratives: members per sector -> heatmap
    sector_of, heat = {}, {}
    for cid, name in NARRATIVES.items():
        try:
            ms = cg(f'/coins/markets?vs_currency=usd&category={cid}&order=market_cap_desc&per_page=100&page=1&price_change_percentage=7d,30d')
            c30 = [m.get('price_change_percentage_30d_in_currency') for m in ms if m.get('price_change_percentage_30d_in_currency') is not None]
            c7 = [m.get('price_change_percentage_7d_in_currency') for m in ms if m.get('price_change_percentage_7d_in_currency') is not None]
            mcap = sum(m.get('market_cap') or 0 for m in ms)
            w30 = sum((m.get('price_change_percentage_30d_in_currency') or 0) * (m.get('market_cap') or 0) for m in ms) / (mcap or 1)
            heat[name] = {'members': len(ms), 'median30d': statistics.median(c30) if c30 else None, 'median7d': statistics.median(c7) if c7 else None, 'mcapWeighted30d': w30,
                          'leaders': [m['symbol'].upper() for m in sorted(ms, key=lambda m: -(m.get('price_change_percentage_30d_in_currency') or -999))[:5]]}
            for m in ms: sector_of.setdefault(m['id'], []).append(name)
        except Exception as e: heat[name] = {'error': str(e)[:80]}
    status['coingecko categories'] = f'ok ({len(heat)} sectors)'
    hot = sorted([k for k, v in heat.items() if v.get('median30d') is not None], key=lambda k: -heat[k]['median30d'])
    # pre-screen
    cands = []
    for m in mk:
        sym = (m.get('symbol') or '').lower(); nm = (m.get('name') or '').lower()
        if any(s in sym or s in nm for s in SKIP) or not m.get('ath') or not m.get('ath_date') or not m.get('current_price'): continue
        ath_age_y = (now - dt.datetime.fromisoformat(m['ath_date'].replace('Z', '+00:00'))).days / 365
        dd = m.get('ath_change_percentage') or 0
        if dd > -50 or ath_age_y < 0.75: continue
        g = m['id']; f, r = fees.get(g), rev.get(g)
        mcap = m.get('market_cap') or 0
        fees_g = (f['d30'] / f['p30'] - 1) if f and f['p30'] else None
        pf = mcap / (f['d30'] * 12) if f and f['d30'] else None
        ps = mcap / (r['d30'] * 12) if r and r['d30'] else None
        secs = sector_of.get(g, []); sh = max([heat[s]['median30d'] or 0 for s in secs] or [0])
        lag = (sh - (m.get('price_change_percentage_30d_in_currency') or 0)) if secs else None
        s_value = clip(-dd / 95) * 0.6 + clip(ath_age_y / 5) * 0.4
        s_fund = 0.5 if f is None else clip(0.4 + (fees_g or 0)) * 0.6 + (clip((60 - (pf or 60)) / 60) * 0.4)
        s_narr = clip(sh / 40) * 0.6 + clip((lag or 0) / 40) * 0.4 if secs else 0.2
        pre = 15 * s_value + 20 * s_fund + 15 * s_narr
        cands.append({'id': g, 'symbol': m['symbol'].upper(), 'name': m['name'], 'price': m['current_price'], 'mcap': mcap, 'fdv': m.get('fully_diluted_valuation'), 'rank': m.get('market_cap_rank'),
                      'ath': m['ath'], 'ath_date': m['ath_date'][:10], 'drawdown_pct': dd, 'years_since_ath': round(ath_age_y, 1), 'ch7': m.get('price_change_percentage_7d_in_currency'), 'ch30': m.get('price_change_percentage_30d_in_currency'), 'ch1y': m.get('price_change_percentage_1y_in_currency'),
                      'circ_ratio': (m['circulating_supply'] / m['total_supply']) if m.get('circulating_supply') and m.get('total_supply') else None, 'vol24': m.get('total_volume'),
                      'fees30d': f['d30'] if f else None, 'fees_growth_30d': fees_g, 'p_fees': pf, 'revenue30d': r['d30'] if r else None, 'p_rev': ps, 'tvl': (tvl.get(g) or {}).get('tvl'), 'tvl_ch_1m': (tvl.get(g) or {}).get('ch1m'),
                      'sectors': secs, 'sector_heat30d': sh, 'laggard_gap_pp': lag, 'funding_8h': (hl.get(m['symbol'].upper()) or {}).get('funding_8h'), 'oi_usd': (hl.get(m['symbol'].upper()) or {}).get('oi_usd'),
                      's_value': s_value, 's_fund': s_fund, 's_narr': s_narr, 'pre': pre})
    cands.sort(key=lambda x: -x['pre'])
    log('pre-screen', len(cands))
    btc_px, btc_v, btc_d = series('bitcoin')
    btc_map = dict(zip(btc_d, btc_px))
    N = int(os.environ.get('SLEEPER_DEEP', '45'))
    out = []
    for c in cands[:N]:
        try:
            px, vol, ds = series(c['id'])
            b = [btc_map.get(d) for d in ds]
            t = technicals(px, vol, b)
            if not t: continue
            c.update(t)
            dev = None
            if len(out) < 25:
                try:
                    dd_ = cg(f"/coins/{c['id']}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=true").get('developer_data') or {}
                    dev = dd_.get('commit_count_4_weeks')
                except Exception: pass
            c['commits_4w'] = dev
            s_dev = 0.5 if dev is None else clip(dev / 60)
            fr = c['funding_8h']; s_fund_rate = 0.5 if fr is None else clip(0.6 - fr * 2000) * (1.0 if (c['oi_usd'] or 0) > 2e6 else 0.6)
            comps = {'deep_value': c['s_value'], 'fundamentals': c['s_fund'], 'narrative': c['s_narr'], 'compression': t['s_comp'], 'rs_btc': t['s_rs'], 'accumulation': t['s_acc'], 'dev': s_dev, 'derivs': s_fund_rate}
            W = {'deep_value': 15, 'fundamentals': 20, 'narrative': 15, 'compression': 15, 'rs_btc': 15, 'accumulation': 10, 'dev': 5, 'derivs': 5}
            score = sum(W[k] * comps[k] for k in W)
            why = [f"{c['drawdown_pct']:.0f}% below ATH ({c['ath_date']}, {c['years_since_ath']}y ago)"]
            if c['fees_growth_30d'] is not None: why.append(f"fees 30d {c['fees_growth_30d'] * 100:+.0f}% vs prior 30d")
            if c['p_fees']: why.append(f"mcap/annualized fees {c['p_fees']:.0f}x")
            if c['sectors']: why.append(f"sector {', '.join(c['sectors'][:2])} median 30d {c['sector_heat30d']:+.0f}%" + (f", lagging by {c['laggard_gap_pp']:.0f}pp" if (c['laggard_gap_pp'] or 0) > 10 else ''))
            if t['vol_comp_20v120'] and t['vol_comp_20v120'] < 0.8: why.append(f"volatility compressed ({t['vol_comp_20v120']:.2f}x of 120d)")
            if t['vol_expand_5v20'] and t['vol_expand_5v20'] > 1.4: why.append(f"vol expanding ({t['vol_expand_5v20']:.1f}x 5d vs 20d)")
            if t['rs_btc_30d'] is not None: why.append(f"vs BTC 30d {t['rs_btc_30d'] * 100:+.0f}% (prior 90d {t['rs_btc_prior90d'] * 100:+.0f}%)")
            if t['vol_trend_30v90'] > 1.3: why.append(f"volume {t['vol_trend_30v90']:.1f}x prior 90d avg")
            if dev: why.append(f'{dev} commits in 4 weeks')
            if fr is not None: why.append(f"HL funding {fr * 100:.3f}%/8h, OI ${c['oi_usd'] / 1e6:.1f}M")
            g = 'A' if score >= 70 else 'B' if score >= 58 else 'C' if score >= 46 else 'D' if score >= 34 else 'F'
            c.update({'score': round(score, 1), 'grade': g, 'components': {k: round(v, 2) for k, v in comps.items()}, 'reasons': why, 'spark': px[-90::3]})
            out.append(c)
        except Exception as e: log('series', c['id'], e)
    out.sort(key=lambda x: -x['score'])
    # call log
    tr = Tracker('sleepers')
    price_now = {m['id']: m['current_price'] for m in mk}
    for k in tr.keys_open(400 * 86400): tr.update(k, price_now.get(k))
    for c in out: tr.log(c['id'], c['grade'], c['score'], c['price'], c['symbol'], {k: c.get(k) for k in ('drawdown_pct', 'fees_growth_30d', 'p_fees', 'sector_heat30d', 'rs_btc_30d', 'vol_comp_20v120')}, f"https://www.coingecko.com/en/coins/{c['id']}")
    tr.save()
    res = {'generatedAt': int(time.time() * 1000), 'sources': status, 'heatmap': heat, 'hotSectors': hot[:5], 'items': out, 'prescreened': len(cands),
           'laggards': [x for x in out if (x.get('laggard_gap_pp') or 0) > 15 and x.get('sector_heat30d', 0) > 10][:20],
           'formula': 'Sleeper Score 0-100 = 15 deep value (drawdown from ATH, years since ATH) + 20 fundamentals (DefiLlama fees 30d vs prior 30d, mcap/annualized fees) + 15 narrative (sector 30d median move, laggard gap) + 15 volatility compression then expansion + 15 relative strength vs BTC turning up + 10 accumulation proxy (volume rising in a tight range) + 5 developer commits (CoinGecko) + 5 derivatives (Hyperliquid funding not crowded, OI present). A>=70, B>=58, C>=46, D>=34. Universe: CoinGecko top 1000, >=50% below an ATH set >=9 months ago, no stables/wrapped.',
           'limits': ['Holder counts and exchange flows are not free for most chains, so accumulation is a price/volume proxy.', 'CoinGecko free history is 365 days.', 'X/social mention counts are not free; narrative momentum uses sector price moves.', 'Estimates, not advice.']}
    json.dump(res, open(os.path.join(DATA_DIR, 'sleepers.json'), 'w'), default=str)
    log('done', len(out), status)
    for x in out[:12]: log(x['grade'], x['score'], x['symbol'], x['reasons'][:3])

if __name__ == '__main__':
    main()
    try:
        import revival_lab; revival_lab.main()  # lookalikes + accumulation + holder distribution (reuses cached series)
    except Exception as e: print('revival_lab failed:', e)
