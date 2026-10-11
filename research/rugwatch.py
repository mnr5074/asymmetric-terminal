#!/usr/bin/env python3
"""Pre-rug / slow-rug early warning: case library, case studies, backtest, unlock calendar export.
Outputs: data/rug_cases.json, data/unlocks.json. Heuristic estimates from free data, not advice.
Sources (keyless, verified 2026-10-11): DefiLlama hacks API (api.llama.fi/hacks), DefiLlama unlocks page data
(api.llama.fi/emissions is paid/402), CoinGecko public API (365-day daily history limit), GoPlus token security,
DexScreener pairs, our research DB (data/moonshot.db). Not available free: full historical insider transfer logs
(public RPCs serve only ~10k recent blocks; archive needs an Etherscan/Allnodes/Covalent key), X post counts."""
import json, os, re, time, math, sqlite3, statistics, urllib.request, datetime as dt
from common import DATA_DIR

UA = {'user-agent': 'Mozilla/5.0 (asymmetric-terminal research)', 'accept': 'application/json'}
def get(url, timeout=40):
    for i in range(3):
        try: return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read())
        except Exception as e:
            if i == 2: raise
            time.sleep(4 * (i + 1))
def page_data(url):
    h = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read().decode()
    return json.loads(re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', h, re.S).group(1))['props']['pageProps']
D = lambda ts: dt.datetime.fromtimestamp(ts, dt.UTC).strftime('%Y-%m-%d')

TAXONOMY = {
    'hard_rug': 'Hard rug: liquidity pulled', 'honeypot': 'Honeypot: buys allowed, sells blocked/taxed', 'mint_freeze_abuse': 'Mint/freeze authority abuse',
    'bundled_dev_dump': 'Bundled launch, dev/insiders dump', 'slow_rug': 'Slow rug: gradual dev/insider selling', 'unlock_dump': 'Unlock/vesting dump',
    'low_float_squeeze': 'Low float / high FDV squeeze then dump', 'staking_float_illusion': 'Staking/lock float illusion', 'wash_volume': 'Wash-traded volume',
    'kol_pump_dump': 'KOL / paid-promo pump and dump', 'fake_liquidity': 'Fake liquidity (pool priced against itself / fake quote)', 'exploit': 'Exploit / hack / key compromise',
}
PRE_SIGNALS = {
    'hard_rug': ['LP not burned/locked', 'young pool', 'liquidity falling while price flat'], 'honeypot': ['sell simulation fails', 'sells near zero vs buys', 'owner-modifiable tax'],
    'mint_freeze_abuse': ['mint authority enabled', 'freeze authority enabled'], 'bundled_dev_dump': ['many wallets bought in the creation slot', 'top-10 concentration high', 'common funding source'],
    'slow_rug': ['dev/insider wallets sell on a schedule', 'holder count falling while price holds', 'team silence while wallets sell'],
    'unlock_dump': ['large cliff unlock within 30 days', 'circulating << total supply', 'FDV >> market cap'],
    'low_float_squeeze': ['circulating < 50% of supply', 'DEX liquidity < 1-3% of market cap', 'parabolic run on falling volume'],
    'staking_float_illusion': ['large share of supply in staking/lock contracts', 'tiny liquid float vs mcap', 'unstake queue growing'],
    'wash_volume': ['volume/liquidity > 10x', 'few makers vs many txns', 'round-trip trades'], 'kol_pump_dump': ['paid boosts/promo spike', 'buy pressure from few wallets', 'no organic socials'],
    'fake_liquidity': ['quote-side liquidity tiny vs reported liquidity', 'FDV equals liquidity', 'no real volume'], 'exploit': ['unaudited/new contract', 'admin keys', 'oracle on thin pools'],
}

def hacks_cases():
    d = get('https://api.llama.fi/hacks'); out = []
    for x in d:
        cl, te = x.get('classification') or '', x.get('technique') or ''
        t = 'hard_rug' if te in ('Liquidity Rug', 'Exit Scam') else 'slow_rug' if te == 'Admin Drain' else 'honeypot' if 'Backdoor' in te else 'exploit'
        if cl == 'Rugpull' and t == 'exploit': t = 'hard_rug'
        out.append({'name': x.get('name'), 'date': D(x['date']) if x.get('date') else None, 'type': t, 'technique': te, 'classification': cl, 'amountUsd': x.get('amount'), 'chains': x.get('chain'), 'source': 'DefiLlama hacks'})
    return out

def db_cases():
    """Died memecoins from our research DB, with the pre-collapse signals we snapshotted while they were alive."""
    c = sqlite3.connect(os.path.join(DATA_DIR, 'moonshot.db')); c.row_factory = sqlite3.Row
    cols = {r[1] for r in c.execute('PRAGMA table_info(tokens)')}
    rows = [dict(r) for r in c.execute("SELECT * FROM tokens WHERE cohort IN ('died','mooned')")]
    out = []
    for r in rows:
        sig = {k: r.get(k) for k in ('top10_now', 'insider_pct_now', 'lp_locked_pct', 'mint_auth', 'freeze_auth', 'dev_prior_tokens', 'holders_now', 'quote_liq_usd', 'cur_liq', 'peak_mcap', 'multiple', 'rugcheck_rugged') if k in cols}
        t = 'bundled_dev_dump' if (sig.get('insider_pct_now') or 0) > 10 else 'hard_rug' if (sig.get('lp_locked_pct') is not None and sig['lp_locked_pct'] < 50) else 'slow_rug'
        out.append({'name': r.get('symbol'), 'mint': r['mint'], 'chain': r.get('chain') or 'solana', 'cohort': r['cohort'], 'type': t if r['cohort'] == 'died' else None, 'signals': sig, 'source': 'research DB'})
    return out

def static_rug_score(s):
    """Same signal family the live module uses, restricted to fields the research DB snapshotted."""
    sc, why = 0, []
    if (s.get('top10_now') or 0) > 40: sc += 15; why.append('top-10 > 40%')
    if (s.get('insider_pct_now') or 0) > 10: sc += 20; why.append('insiders > 10%')
    if s.get('lp_locked_pct') is not None and s['lp_locked_pct'] < 50: sc += 15; why.append('LP < 50% locked')
    if s.get('mint_auth'): sc += 20; why.append('mint authority')
    if s.get('freeze_auth'): sc += 20; why.append('freeze authority')
    if (s.get('dev_prior_tokens') or 0) >= 5: sc += 10; why.append('serial launcher dev')
    return min(100, sc), why

def case_study(cg_id, contracts, label):
    """Daily-series study: run-up, collapse, float, FDV gap, liquidity depth, holders; and when the forecast would have fired."""
    info = get(f'https://api.coingecko.com/api/v3/coins/{cg_id}?localization=false&tickers=false&community_data=false&developer_data=false')
    m = info['market_data']; u = lambda k: (m.get(k) or {}).get('usd') if isinstance(m.get(k), dict) else m.get(k)
    time.sleep(3)
    ch = get(f'https://api.coingecko.com/api/v3/coins/{cg_id}/market_chart?vs_currency=usd&days=365&interval=daily')
    P = [(D(t / 1000), p) for t, p in ch['prices']]; V = [v for _, v in ch['total_volumes']]; MC = [v for _, v in ch['market_caps']]
    px = [p for _, p in P]
    ip = max(range(len(px)), key=lambda i: px[i])
    lo_i = min(range(max(0, ip - 120), ip + 1), key=lambda i: px[i])
    after = px[ip:]; cur = px[-1]
    collapse_i = next((i for i in range(ip, len(px)) if px[i] <= px[ip] * 0.3), None)
    circ, tot = u('circulating_supply'), u('total_supply') or u('max_supply')
    res = {'label': label, 'coingecko_id': cg_id, 'name': info['name'], 'symbol': info['symbol'].upper(), 'platforms': info.get('platforms'),
           'price_now': cur, 'ath_intraday': u('ath'), 'ath_date': (m.get('ath_date') or {}).get('usd', '')[:10], 'daily_close_peak': px[ip], 'daily_peak_date': P[ip][0],
           'runup_low': px[lo_i], 'runup_low_date': P[lo_i][0], 'runup_multiple_daily': px[ip] / px[lo_i], 'runup_days': ip - lo_i,
           'drawdown_from_daily_peak_pct': (cur / px[ip] - 1) * 100, 'collapse_date_70pct_down': P[collapse_i][0] if collapse_i is not None else None,
           'days_peak_to_collapse': (collapse_i - ip) if collapse_i is not None else None,
           'circulating': circ, 'total_supply': tot, 'circ_ratio': (circ / tot) if circ and tot else None, 'mcap_now': u('market_cap'), 'fdv_now': u('fully_diluted_valuation'),
           'vol_now': u('total_volume'), 'mcap_at_peak': MC[ip], 'vol_at_peak': V[ip], 'turnover_runup_avg': statistics.mean(V[i] / MC[i] for i in range(lo_i, ip + 1) if MC[i] and MC[i] > 0 and V[i] >= 0) if ip > lo_i else None}
    # liquidity depth + holders now (DexScreener + GoPlus)
    dex = []
    for plat, addr in (contracts or {}).items():
        chain = {'binance-smart-chain': 'bsc', 'base': 'base', 'ethereum': 'ethereum', 'solana': 'solana'}.get(plat)
        if not chain or not addr: continue
        try:
            pairs = get(f'https://api.dexscreener.com/token-pairs/v1/{chain}/{addr}') or []
            liq = sum((p.get('liquidity') or {}).get('usd') or 0 for p in pairs)
            dex.append({'chain': chain, 'address': addr, 'pairs': len(pairs), 'dex_liquidity_usd': liq})
        except Exception as e: dex.append({'chain': chain, 'error': str(e)})
        gid = {'bsc': 56, 'base': 8453, 'ethereum': 1}.get(chain)
        if gid:
            try:
                g = list(get(f'https://api.gopluslabs.io/api/v1/token_security/{gid}?contract_addresses={addr}')['result'].values())[0]
                hs = g.get('holders') or []
                dex[-1].update({'holder_count': int(g.get('holder_count') or 0), 'top10_pct': sum(float(h['percent']) for h in hs[:10]) * 100,
                                'top10_in_contracts_pct': sum(float(h['percent']) for h in hs[:10] if str(h.get('is_contract')) == '1') * 100,
                                'top10_locked_pct': sum(float(h['percent']) for h in hs[:10] if str(h.get('is_locked')) == '1') * 100,
                                'top_holders': [{'address': h['address'], 'pct': round(float(h['percent']) * 100, 2), 'contract': str(h.get('is_contract')) == '1', 'tag': h.get('tag')} for h in hs[:6]]})
            except Exception as e: dex[-1]['goplus_error'] = str(e)[:80]
        time.sleep(1)
    res['dex'] = dex
    tl = sum(x.get('dex_liquidity_usd') or 0 for x in dex)
    res['dex_liquidity_total'] = tl; res['liq_to_mcap_pct'] = (tl / res['mcap_now'] * 100) if res['mcap_now'] else None
    # daily forecast replay using only price/volume/mcap + static float (the float ratio today is assumed for the past: stated as a limitation)
    fired = []
    for i in range(30, len(px)):
        sc, why = 0, []
        if res['circ_ratio'] and res['circ_ratio'] < 0.5: sc += 15; why.append('circulating < 50%')
        r30 = px[i] / min(px[i - 30:i]); 
        if r30 > 5: sc += 25; why.append(f'{r30:.1f}x in 30d (parabolic)')
        elif r30 > 2.5: sc += 12; why.append(f'{r30:.1f}x in 30d')
        v7 = statistics.mean(V[i - 6:i + 1]); v7p = statistics.mean(V[i - 13:i - 6])
        if px[i] > px[i - 7] * 1.2 and v7 < v7p * 0.8: sc += 15; why.append('price up, volume falling (divergence)')
        if MC[i] and MC[i] > 0 and v7 / MC[i] > 1.0: sc += 10; why.append('turnover > 100%/day (churn)')
        if MC[i] and px[i] >= max(px[:i + 1]) * 0.97 and r30 > 2: sc += 10; why.append('at highs after run')
        if sc >= 50: fired.append({'date': P[i][0], 'score': sc, 'why': why, 'price': px[i]})
    first = fired[0] if fired else None
    pre = [f for f in fired if collapse_i is not None and f['date'] <= P[collapse_i][0]]
    res['forecast_replay'] = {'days_flagged': len(fired), 'first_flag': first, 'flags_before_collapse': len(pre), 'first_flag_before_collapse': pre[0] if pre else None,
                              'lead_days_vs_collapse': ((dt.date.fromisoformat(P[collapse_i][0]) - dt.date.fromisoformat(pre[0]['date'])).days if pre else None),
                              'lead_days_vs_peak': ((dt.date.fromisoformat(P[ip][0]) - dt.date.fromisoformat(pre[0]['date'])).days if pre else None),
                              'price_at_first_flag_vs_peak_pct': ((pre[0]['price'] / px[ip] - 1) * 100 if pre else None)}
    return res

def main():
    log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
    out = {'generatedAt': int(time.time() * 1000), 'taxonomy': TAXONOMY, 'pre_signals': PRE_SIGNALS, 'sources': {}}
    try: hk = hacks_cases(); out['sources']['DefiLlama hacks'] = f'ok ({len(hk)})'
    except Exception as e: hk = []; out['sources']['DefiLlama hacks'] = f'failed: {e}'
    dbc = db_cases(); out['sources']['research DB'] = f'ok ({len(dbc)})'
    out['sources']['rekt.news'] = 'not used: leaderboard page redirects and has no public API'; out['sources']['Chainabuse/Comparitech'] = 'not used: no keyless API'
    # unlock calendar (DefiLlama unlocks page data)
    unl = []
    try:
        ud = page_data('https://defillama.com/unlocks')['data']; now = time.time()
        for x in ud:
            nxt = [e for e in x.get('events') or [] if e.get('unlockType') == 'cliff' and now <= e['timestamp'] <= now + 90 * 86400]
            amt30 = sum(sum(e.get('noOfTokens') or [0]) for e in nxt if e['timestamp'] <= now + 30 * 86400)
            ins30 = sum(sum(e.get('noOfTokens') or [0]) for e in nxt if e['timestamp'] <= now + 30 * 86400 and e.get('category') in ('insiders', 'privateSale'))
            unl.append({'token': x['token'], 'name': x['name'], 'gecko_id': x.get('gecko_id'), 'circ': x.get('circSupply'), 'max': x.get('maxSupply'), 'locked': x.get('totalLocked'),
                        'next': [{'date': D(e['timestamp']), 'tokens': sum(e.get('noOfTokens') or [0]), 'category': e.get('category')} for e in sorted(nxt, key=lambda e: e['timestamp'])[:5]],
                        'unlock30d_pct_circ': (amt30 / x['circSupply'] * 100) if x.get('circSupply') else None, 'insider30d_pct_circ': (ins30 / x['circSupply'] * 100) if x.get('circSupply') else None})
        out['sources']['DefiLlama unlocks (page data)'] = f'ok ({len(unl)} tokens)'
    except Exception as e: out['sources']['DefiLlama unlocks (page data)'] = f'failed: {e}'
    json.dump({'generatedAt': out['generatedAt'], 'tokens': unl}, open(os.path.join(DATA_DIR, 'unlocks.json'), 'w'))
    # backtest 1: static signals on DB tokens (died vs mooned)
    died = [c for c in dbc if c['cohort'] == 'died']; moon = [c for c in dbc if c['cohort'] == 'mooned']
    sd = [static_rug_score(c['signals'])[0] for c in died]; sm = [static_rug_score(c['signals'])[0] for c in moon]
    out['backtest_static'] = {'died_n': len(died), 'mooned_n': len(moon), 'died_flagged_ge50': sum(s >= 50 for s in sd), 'mooned_flagged_ge50': sum(s >= 50 for s in sm),
                              'died_flagged_ge30': sum(s >= 30 for s in sd), 'mooned_flagged_ge30': sum(s >= 30 for s in sm), 'died_median': statistics.median(sd) if sd else None, 'mooned_median': statistics.median(sm) if sm else None,
                              'note': 'Signals snapshotted by the research collector while tokens were alive (not at launch). Died and mooned memecoins share many launch-time signals, so overlap is expected.'}
    # case studies
    studies = []
    for cg, label in (('lab', 'LAB (BSC) - closest match to "LABS": pumped then crashed'), ('velvet', 'VELVET (Velvet Capital)')):
        try:
            info_platforms = get(f'https://api.coingecko.com/api/v3/coins/{cg}?localization=false&tickers=false&community_data=false&developer_data=false').get('platforms'); time.sleep(3)
            studies.append(case_study(cg, info_platforms, label)); log('case', cg, 'ok')
        except Exception as e: studies.append({'label': label, 'error': str(e)}); log('case', cg, e)
        time.sleep(5)
    out['case_studies'] = studies
    out['backtest_timeseries'] = {'cases': len([s for s in studies if 'forecast_replay' in s]), 'flagged_before_collapse': sum(1 for s in studies if s.get('forecast_replay', {}).get('first_flag_before_collapse')),
                                  'note': 'Daily replay on CoinGecko 365-day history (free limit). The float ratio is today\'s value applied to the past, which flatters the result. Two cases is not a validation, it is a sanity check.'}
    by = {}
    for c in hk: by[c['type']] = by.get(c['type'], 0) + 1
    for c in died: by[c['type']] = by.get(c['type'], 0) + 1
    out['library_counts'] = by
    out['cases'] = hk[-400:] + [c for c in died]
    json.dump(out, open(os.path.join(DATA_DIR, 'rug_cases.json'), 'w'), default=str)
    log('done', out['sources'], out['backtest_static'], by)
    for s in studies: log(json.dumps({k: s.get(k) for k in ('symbol', 'runup_low', 'runup_low_date', 'daily_close_peak', 'daily_peak_date', 'runup_multiple_daily', 'ath_intraday', 'ath_date', 'price_now', 'drawdown_from_daily_peak_pct', 'collapse_date_70pct_down', 'days_peak_to_collapse', 'circ_ratio', 'mcap_now', 'fdv_now', 'dex_liquidity_total', 'liq_to_mcap_pct', 'turnover_runup_avg')}, default=str)); log(json.dumps(s.get('forecast_replay'), default=str)); log(json.dumps(s.get('dex'), default=str)[:1500])

if __name__ == '__main__': main()
