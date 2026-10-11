#!/usr/bin/env python3
"""Final crash/pump catalog + LAUNCHPAD LEADERBOARD.
Merges crash_catalog.json (CoinGecko categories, research DB, Binance archive), crash_eco.json (StonkFun, Robinhood Chain, PONS),
launchpad_cg.json and launchpad_extra.json (Hooked/Seven/x7/Base pads), research/forensics_cases.json.
BAD-TICK FILTER: a peak counts only if confirmed by DAILY CLOSES (max close within +-3 days of the claimed ATH date >= 50% of the ATH;
otherwise the peak is replaced by the max daily close and the entry is flagged bad_tick). Peaks without daily history are 'unconfirmed'
and are excluded from rankings. Free data only; zero Nansen/X (guarded get)."""
import json, math, os, statistics, time, datetime as dt
from crash_lab import get, COUNTS, log
from common import DATA_DIR
def _syms():
    try:
        u = json.load(open(os.path.join(DATA_DIR, 'opt_universe.json')))['symbols']; return {(x if isinstance(x, str) else x.get('s') or x.get('symbol', '')).upper() for x in u}
    except Exception: return set()
US = _syms()
import re as _re
def is_stock_token(sym):
    s0 = (sym or '').strip(); b = _re.sub(r'^(wt|b)', '', s0); b = _re.sub(r'(x|X|c|ON|on)$', '', b) if len(b) > 2 else b
    return b.upper() in US and s0 != b or s0.upper() in US
MAJORS = {'DAI', 'SUSHI', 'DEEP', 'CAKE', 'UNI', 'LINK', 'ARB', 'OP', 'CBBTC', 'WETH', 'ETH', 'USDG', 'USDC', 'USDT', 'WBTC', 'SOL', 'WSOL', 'BNB', 'WBNB', 'ZEC', 'TON', 'SUI', 'TRX', 'VIRTUAL', 'AERO', 'PUMP', 'BONK'}
SINCE = os.environ.get('SINCE', '2026-04-11')  # ~6 months; PONS launched 2026-07-13
J = lambda f: json.load(open(os.path.join(DATA_DIR, f))) if os.path.exists(os.path.join(DATA_DIR, f)) else None
def cg_daily(cid):
    f = os.path.join(DATA_DIR, 'cg_series', cid + '.json')
    if not os.path.exists(f):
        d = get(f'https://api.coingecko.com/api/v3/coins/{cid}/market_chart?vs_currency=usd&days=365&interval=daily', gap=6.5); json.dump(d, open(f, 'w'))
    d = json.load(open(f)); D = lambda t: dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).date().isoformat()
    return [(D(t), p) for t, p in d['prices'] if p], {D(t): m for t, m in d.get('market_caps', [])}
def confirm(ath, athd, closes):
    """closes: [(date, close)]. Returns (confirmed_peak_close, peak_date, status)."""
    if not closes: return None, None, 'unconfirmed'
    hi = max(closes, key=lambda x: x[1])
    if not ath or not athd: return hi[1], hi[0], 'closes-only'
    a = dt.date.fromisoformat(athd); near = [p for d, p in closes if abs((dt.date.fromisoformat(d) - a).days) <= 3]
    if near and max(near) >= 0.5 * ath: return max(near), athd, 'confirmed'
    if dt.date.fromisoformat(closes[0][0]) > a: return hi[1], hi[0], 'ath-before-window'
    return hi[1], hi[0], 'bad_tick'
def main():
    t0 = time.time(); cat = J('crash_catalog.json') or {'catalog': []}; eco = J('crash_eco.json') or {'tokens': []}; lcg = J('launchpad_cg.json') or {}; extra = J('launchpad_extra.json') or {'tokens': []}
    fx = json.load(open(os.path.join(os.path.dirname(__file__), 'forensics_cases.json')))['cases']
    oldest = (dt.date.today() - dt.timedelta(days=364)).isoformat()
    # ---- CoinGecko coins: catalog crashes + launchpad category coins (one record per coin id) ----
    coins = {}
    for x in cat['catalog']:
        if x['source'] == 'coingecko markets': coins[x['id']] = {'id': x['id'], 'symbol': x['symbol'], 'name': x['name'], 'pads': set(x.get('categories', [])), 'ath': x['ath'], 'athd': x['ath_date'], 'mc': x.get('mcap_now'), 'px': x.get('price_now'), 'circ': x['peak_mcap_est'] / x['ath'] if x.get('ath') else None}
    for pad, v in lcg.items():
        if pad.startswith('_') or 'error' in v: continue
        for x in v.get('notable_recent_ge10M', []) + v.get('all_time_top', []) + ([v['biggest_recent']] if v.get('biggest_recent') else []):
            c = coins.setdefault(x['id'], {'id': x['id'], 'symbol': x['sym'], 'name': x['sym'], 'pads': set(), 'ath': x['ath'], 'athd': x['athd'], 'mc': x['mc'], 'px': x['px'], 'circ': x['athmc'] / x['ath'] if x['ath'] else None}); c['pads'].add(pad)
    n_fetch = 0
    for c in sorted(coins.values(), key=lambda c: -(c['ath'] or 0) * (c['circ'] or 0)):
        if c['athd'] and c['athd'] >= oldest:
            try: closes, mcs = cg_daily(c['id'])
            except Exception as e: c['status'] = 'unconfirmed'; c['err'] = str(e)[:60]; continue
            n_fetch += 1
            pk, pkd, st = confirm(c['ath'], c['athd'], closes); c['status'] = st; c['peak_close'] = pk; c['peak_date'] = pkd
            est = pk * c['circ'] if pk and c['circ'] else None; m = mcs.get(pkd)
            c['peak_mcap'] = est if est else m
            if m and est and not (est / 3 <= m <= est * 3): c['mcap_series_glitch'] = round(m)
            if c['peak_mcap'] and c['peak_mcap'] > 1e9 and pre and pk / min(pre) < 2 and closes[0][0] >= pkd: c['status'] = 'excluded (>$1B peak on first day of history, unverifiable)'
            pre = [p for d, p in closes if d <= pkd]; c['run_multiple_closes'] = pk / min(pre) if pre and min(pre) > 0 else None; c['run_low_date'] = min([(p, d) for d, p in closes if d <= pkd])[1] if pre else None
            c['claimed_peak_mcap'] = c['ath'] * c['circ'] if c['circ'] else None; c['crash_depth_pct'] = (c['px'] / pk - 1) * 100 if c.get('px') and pk else None
            c['series_truncated'] = closes[0][0] > (c.get('run_low_date') or '9')  # low may predate the 365d window
        else:
            c['status'] = 'unconfirmed (ATH older than the free 365-day window)'; c['claimed_peak_mcap'] = c['ath'] * c['circ'] if c['circ'] else None
    log('coingecko coins', len(coins), 'series checked', n_fetch, {s: sum(1 for c in coins.values() if c.get('status') == s) for s in ('confirmed', 'bad_tick', 'ath-before-window')})
    # ---- eco tokens (StonkFun / Robinhood / PONS): peak from GT daily closes; StonkFun's own peakMarketCapUsd checked against closes ----
    def eco_rec(t, pad):
        o = t.get('ohlcv'); sup = (t['mcap_now'] / t['price_now']) if t.get('mcap_now') and t.get('price_now') else None
        r = {'id': f"{t['chain']}:{t['address']}", 'symbol': t.get('symbol'), 'chain': t['chain'], 'address': t['address'], 'pads': {pad}, 'pair_asset': t.get('quote'), 'mc': t.get('mcap_now'), 'liq': t.get('liq_now')}
        if o and o.get('closes'):
            cl = list(zip(o['dates'], o['closes'])); spikes = 0
            # bad-tick filter for GT closes: a peak close must be backed by an adjacent day closing at >= 40% of it; else drop that day and retry
            order = sorted(range(len(cl)), key=lambda i: -cl[i][1]); hi = None
            for i in order[:6]:
                nb = [cl[j][1] for j in (i - 1, i + 1) if 0 <= j < len(cl)]
                if nb and max(nb) >= 0.4 * cl[i][1]: hi = cl[i]; break
                spikes += 1
            if hi is None: hi = cl[order[min(6, len(order) - 1)]]
            pre = [p for d, p in cl if d <= hi[0] and p > 0]
            r.update({'status': 'closes-only', 'peak_close': hi[1], 'peak_date': hi[0], 'peak_mcap': hi[1] * sup if sup else None, 'run_multiple_closes': hi[1] / min(pre) if pre else None,
                      'first_day': o['dates'][0], 'series_truncated': o.get('truncated_180d'), 'crash_depth_pct': (o['closes'][-1] / hi[1] - 1) * 100})
            if spikes: r['status'] = 'bad_tick'; r['spike_days_removed'] = spikes
            # GT USD-conversion glitches (e.g. many STONK-quoted pools all 'peaking' at ~$360M on 2026-09-21): peak mcap must be plausible vs liquidity
            pl = max([r.get('liq') or 0] + [q.get('liq') or 0 for q in t.get('pools') or []])
            recent = (dt.date.today() - dt.date.fromisoformat(hi[0])).days <= 3
            if r['peak_mcap'] and ((pl and r['peak_mcap'] / pl > 1000) or (recent and (r.get('mc') or 0) < 0.05 * r['peak_mcap'])):
                r['status'] = 'excluded (implausible peak vs liquidity: GT conversion glitch)'; r['claimed_peak_mcap'] = r['peak_mcap']; r['peak_mcap'] = None
            if r['peak_mcap'] and (r['peak_mcap'] > 2e9 or (r.get('symbol') or '').upper() in MAJORS or 'USD' in (r.get('symbol') or '').upper() or (is_stock_token(r.get('symbol')) and (r.get('run_multiple_closes') or 0) < 5) or (r['peak_mcap'] > 3e8 and (r.get('run_multiple_closes') or 0) < 2)): r['status'] = 'excluded (not a launch / quote-unit glitch)'; r['peak_mcap'] = None
            if t.get('peak_mcap_src') and r.get('peak_mcap'): r['claimed_peak_mcap'] = t['peak_mcap_src']; r['claim_bad_tick'] = t['peak_mcap_src'] > 3 * r['peak_mcap']
        else: r.update({'status': 'unconfirmed', 'claimed_peak_mcap': t.get('peak_mcap_src')})
        return r
    eco_recs = []
    for t in eco['tokens']:
        pad = 'stonkfun' if t['eco'] == 'stonkfun' else ('pons' if t['eco'] == 'pons' else 'robinhood:' + (t.get('dex') or '?'))
        eco_recs.append(eco_rec(t, pad))
    for t in extra.get('tokens', []): eco_recs.append(eco_rec(t, t['pad']))
    # ---- leaderboard ----
    groups = {}
    def add(pad, r): groups.setdefault(pad, []).append(r)
    for c in coins.values():
        for p in c['pads']: add('cg:' + p, c)
    for r in eco_recs:
        p = next(iter(r['pads'])); add('stock-paired (all DEXes)' if p.startswith('stock-paired:') else p, r)
        if p.startswith('robinhood:') or p == 'pons': add('robinhood (all pads)', r)
    NAMES = {'cg:pump-fun': 'pump.fun', 'cg:letsbonk-fun-ecosystem': 'LetsBonk', 'cg:believe-app-ecosystem': 'Believe', 'cg:moonshot-ecosystem': 'Moonshot', 'cg:four-meme-ecosystem': 'four.meme', 'cg:zora-ecosystem': 'Zora', 'cg:zora-creator-coins': 'Zora creator coins',
             'cg:clanker-ecosystem': 'Clanker', 'cg:virtuals-protocol-ecosystem': 'Virtuals', 'cg:robinhood-chain-meme': 'Robinhood Chain memes (CG)', 'cg:pons-launchpad': 'PONS (CG)', 'cg:sun-pump-ecosystem': 'SunPump', 'cg:base-meme-coins': 'Base memes (aggregate, not a pad)',
             'cg:printr-launchpad': 'Printr', 'cg:metadao-launchpad': 'MetaDAO', 'cg:surge-launchpad': 'Surge', 'cg:yoink-fun-launchpad': 'Yoink', 'stonkfun': 'StonkFun', 'pons': 'PONS (on-chain launches)', 'robinhood (all pads)': 'Robinhood Chain (all pads, GT)'}
    rows = []
    for g, L in groups.items():
        if g.startswith('robinhood:') or g in ('cg:meme-token', 'cg:solana-meme-coins', 'cg:ai-agents', 'cg:base-meme-coins', 'cg:bnb-chain-meme-coins') or len(L) < 5: continue
        ok = [r for r in L if r.get('status') in ('confirmed', 'closes-only', 'bad_tick', 'ath-before-window') and r.get('peak_mcap') and (r.get('peak_date') or '') >= SINCE and r['peak_mcap'] < 2e10]
        best = max(ok, key=lambda r: r['peak_mcap'], default=None)
        notable = [r for r in ok if (r['peak_mcap'] >= 10e6 and (r.get('run_multiple_closes') or 0) >= 3) or ((r.get('run_multiple_closes') or 0) >= 100 and r['peak_mcap'] >= 1e6)]
        peak_sum = sum(r['peak_mcap'] for r in ok); now_sum = sum(min(r.get('mc') or 0, r['peak_mcap'] * 5) for r in ok)
        last30 = (dt.date.today() - dt.timedelta(days=30)).isoformat(); recent_peaks = sum(1 for r in ok if r['peak_date'] >= last30)
        lcg_v = lcg.get(g[3:], {}) if g.startswith('cg:') else {}
        rows.append({'pad': NAMES.get(g, g), 'key': g, 'tokens_seen': len(L), 'tokens_with_confirmed_peak_in_window': len(ok),
                     'biggest': best and {'symbol': best['symbol'], 'peak_mcap': round(best['peak_mcap']), 'peak_date': best['peak_date'], 'run_multiple_closes': round(best['run_multiple_closes'], 1) if best.get('run_multiple_closes') else None, 'now_mcap': round(best.get('mc') or 0), 'pair_asset': best.get('pair_asset'), 'status': best['status']},
                     'notable_runners': len(notable), 'notable_list': [(r['symbol'], round(r['peak_mcap'] / 1e6, 1), r['peak_date'], round(r.get('run_multiple_closes') or 0)) for r in sorted(notable, key=lambda r: -r['peak_mcap'])[:8]],
                     'health': {'retention_now_vs_peak_pct': round(now_sum / peak_sum * 100, 1) if peak_sum else None, 'peaks_in_last_30d': recent_peaks, 'category_mcap_now': lcg_v.get('cat_mcap'), 'category_vol24': lcg_v.get('cat_vol24')},
                     'bad_ticks_removed': sum(1 for r in L if r.get('status') == 'bad_tick' or r.get('claim_bad_tick'))})
    def rk(key):
        vals = sorted({key(r) for r in rows}, reverse=True); return {id(r): vals.index(key(r)) + 1 for r in rows}
    r1 = rk(lambda r: (r['biggest'] or {}).get('peak_mcap') or 0); r2 = rk(lambda r: r['notable_runners'])
    r3 = rk(lambda r: (r['health']['peaks_in_last_30d'] or 0) * 1000 + (r['health']['retention_now_vs_peak_pct'] or 0))
    for r in rows: r['ranks'] = {'biggest_runner': r1[id(r)], 'notable_count': r2[id(r)], 'health': r3[id(r)]}; r['score'] = round((r1[id(r)] + r2[id(r)] + r3[id(r)]) / 3, 2)
    rows.sort(key=lambda r: (r['score'], r['ranks']['biggest_runner']))
    for i, r in enumerate(rows): r['rank'] = i + 1
    ser = lambda o: sorted(o) if isinstance(o, set) else None
    final = {'generatedAt': int(time.time() * 1000), 'window_since': SINCE, 'bad_tick_rule': 'peak confirmed only if max daily close within +-3 days of the claimed ATH >= 50% of it; else replaced by max daily close (flag bad_tick)',
             'coingecko_coins': list(coins.values()), 'eco_tokens_ranked': sorted([r for r in eco_recs if r.get('peak_mcap')], key=lambda r: -r['peak_mcap'])[:400],
             'eco_counts': {p: sum(1 for r in eco_recs if p in r['pads']) for p in {next(iter(r['pads'])) for r in eco_recs}}, 'forensics': fx, 'leaderboard': rows,
             'billing': {'nansen_calls': 0 if not any('nansen' in h for h in COUNTS) else 'NONZERO', 'x_calls': 0 if not any('x.com' in h or 'twitter' in h for h in COUNTS) else 'NONZERO', 'hosts': COUNTS}, 'elapsed_s': round(time.time() - t0)}
    json.dump(final, open(os.path.join(DATA_DIR, 'crash_catalog_final.json'), 'w'), default=ser)
    for r in rows[:30]: print(r['rank'], r['pad'], 'score', r['score'], r['ranks'], 'best', r['biggest'] and (r['biggest']['symbol'], round(r['biggest']['peak_mcap'] / 1e6, 1), r['biggest']['peak_date'], r['biggest']['run_multiple_closes']), 'notable', r['notable_runners'], 'health', r['health'], 'badticks', r['bad_ticks_removed'])
    log('done', final['billing'])
if __name__ == '__main__': main()
