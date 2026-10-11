"""Live pre-launch matcher. Polls launches that are still in their birth phase on every supported pad, rebuilds
their arc so far with the SAME code as the library (time-normalised snapshots), and matches them against the library.
  pump.fun: newest launches + most recently traded (frontend-api-v3 coins list), trades via swap-api
  other Solana pads / Robinhood / Base / BSC: GeckoTerminal new_pools filtered to pad dexes, GT trades (last 300)
  + minute candles.
Writes data/birthphase/live.json. No wallet-age lookups for live tokens unless BP_LIVE_AGES=1 (keeps RPC quota)."""
import sys, os, json, time, math, calendar
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bp_common import http, BP, GT, GAPS, wjson, short
import collect_pump as cpump
import build_library as bl
import match as mt
LIVE = os.path.join(BP, 'cache', 'live'); os.makedirs(LIVE, exist_ok=True)
GAPS['frontend-api-v3.pump.fun'] = 2.5
SOLPAD_DEX = {'letsbonk-fun': 'letsbonk', 'raydium-launchlab': 'raydium-launchlab', 'meteora-dbc': 'meteora-dbc', 'bags-fm': 'bags', 'moonshot': 'moonshot', 'moonit': 'moonshot',
              'boop-fun': 'boop', 'heaven': 'heaven', 'daos-fun': 'daos.fun', 'stonkfun': 'stonkfun', 'memefun': 'memefun'}
EVM_DEX = {'robinhood': {'pons-dot-family': 'pons', 'pons-v2': 'pons', 'frontier-fun': 'frontier-fun', 'clank-trade': 'clank-trade', 'hoodit': 'hoodit', 'bankr-robinhood': 'bankr-robinhood',
                         'clanker-robinhood': 'clanker-robinhood', 'o1-launchpad-robinhood': 'o1-launchpad-robinhood', 'easya-kickstart-robinhood': 'easya-kickstart-robinhood'},
           'base': {'o1-launchpad': 'o1-launchpad', 'bankr': 'bankr'}, 'bsc': {'four-meme': 'four.meme', 'tiktokfun': 'tiktokfun'}}
MAX_AGE_S = 3 * 3600

def iso(s): return calendar.timegm(time.strptime(s[:19], '%Y-%m-%dT%H:%M:%S')) * 1000

def pump_candidates():
    now = time.time() * 1000; C = {}
    for q in ['sort=created_timestamp&order=DESC&offset=%d' % o for o in (0, 50, 100, 150, 200)] + ['sort=last_trade_timestamp&order=DESC&offset=%d' % o for o in (0, 50, 100)]:
        d = http('https://frontend-api-v3.pump.fun/coins?limit=50&includeNsfw=true&' + q, ttl=0)
        if not isinstance(d, list): continue
        for x in d:
            age = (now - (x.get('created_timestamp') or 0)) / 1000
            if x.get('complete') or age < 60 or age > MAX_AGE_S: continue
            if (x.get('usd_market_cap') or 0) < 6000: continue  # still at the starting price: nothing to match yet
            C[x['mint']] = x
    return sorted(C.values(), key=lambda x: -(x.get('usd_market_cap') or 0))

def gt_candidates():
    out = []
    for net, dexmap in [('solana', SOLPAD_DEX)] + list(EVM_DEX.items()):
        for pg in (1, 2, 3):
            d = http(f'{GT}/networks/{net}/new_pools?page={pg}&include=dex', ttl=0)
            for p in (d or {}).get('data', []) or []:
                dex = p['relationships']['dex']['data']['id']
                if dex not in dexmap: continue
                a = p['attributes']; c0 = iso(a['pool_created_at'])
                if (time.time() * 1000 - c0) / 1000 > MAX_AGE_S: continue
                out.append({'net': net, 'pad': dexmap[dex], 'dex': dex, 'pool': a['address'], 'created': c0, 'name': a.get('name'),
                            'base': p['relationships']['base_token']['data']['id'].split('_', 1)[1], 'fdv': float(a.get('fdv_usd') or 0) or None,
                            'px': float(a.get('base_token_price_usd') or 0) or None, 'liq': float(a.get('reserve_in_usd') or 0)})
    return out

def gt_live_record(c):
    tr = http(f"{GT}/networks/{c['net']}/pools/{c['pool']}/trades", ttl=0)
    rows = []
    for t in (tr or {}).get('data', []) or []:
        a = t['attributes']
        if a.get('kind') != 'buy': 
            rows.append({'ts': iso(a['block_timestamp']), 'u': a['tx_from_address'], 'tok': -float(a.get('from_token_amount') or 0), 'quote': None, 'qsym': None, 'create': False, 'err': False, 'kind': 'sell'}); continue
        rows.append({'ts': iso(a['block_timestamp']), 'u': a['tx_from_address'], 'tok': float(a.get('to_token_amount') or 0), 'quote': float(a.get('from_token_amount') or 0),
                     'qsym': None, 'create': False, 'err': False, 'kind': 'buy', 'usd': float(a.get('volume_in_usd') or 0)})
    rows.sort(key=lambda x: x['ts'])
    complete_hist = len(rows) < 300
    m1 = cpump.gt_ohlcv(c['pool'], 'minute') if c['net'] == 'solana' else None
    if c['net'] != 'solana':
        u = f"{GT}/networks/{c['net']}/pools/{c['pool']}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=base"
        dd = http(u, ttl=0)
        try: m1 = sorted(dd['data']['attributes']['ohlcv_list'])
        except Exception: m1 = None
    sup = c['fdv'] / c['px'] if c['fdv'] and c['px'] else None
    d = {'v': 2, 'mint': c['base'], 'address': c['base'], 'pad': c['pad'], 'stratum': 'live_poll', 'created': c['created'], 'supply': sup, 'symbol': (c['name'] or '').split(' / ')[0],
         'first_txs': rows if complete_hist else [], 'curve_m1': m1, 'curve_pool': {'pool': c['pool'], 'dex': c['dex']}, 'grad_pool': None, 'main_pool': {'liq': c['liq']}, 'notes': [] if complete_hist else ['>300 trades: first buyers not in GT trade window'], 'sig_times': [r['ts'] for r in rows] if complete_hist else None}
    if c['net'] != 'solana':
        for r in d['first_txs']: r['kind'] = 'buy' if r['tok'] > 0 else 'sell'
    return d

def explain(r, pr, s, A):
    """plain-English reasons, only from measured values"""
    out = []
    f = r.get('features') or {}
    if s.get('curve_pct') is not None: out.append(f"curve {s['curve_pct']:.0f}% full at {A // 60} min")
    if s.get('mcap'): out.append(f"mcap ${s['mcap']:,.0f}")
    if s.get('n_buyers') is not None: out.append(f"{s['n_buyers']} unique buyers")
    if s.get('same_sec') is not None and s['same_sec'] >= 0.5: out.append(f"{s['same_sec'] * 100:.0f}% of first buys landed in the same second as another buy (bundle/sniper pattern)")
    if s.get('dev_pct') is not None and s['dev_pct'] >= 5: out.append(f"dev bought {s['dev_pct']:.1f}% of supply at creation")
    if s.get('top10') is not None and s['top10'] >= 0.6: out.append(f"top-10 curve buyers hold {s['top10'] * 100:.0f}% of buy volume")
    if s.get('repeat'): out.append(f"{s['repeat']} of the first 20 buyers were early in >=2 earlier launches (repeat sniper/insider set)")
    if s.get('sell_share') is not None and s['sell_share'] >= 0.4: out.append(f"heavy selling already ({s['sell_share'] * 100:.0f}% of volume)")
    return out

def main():
    t0 = time.time()
    recs = mt.load(); rates = mt.pad_rates(recs)
    models = {}
    rep_sets = {}
    for r in recs:
        for b in (r.get('first_buyers') or [])[:20]:
            if b['kind'] == 'buy': rep_sets.setdefault(b['w'], set()).add(r['key'])
    live = []
    # ---- pump.fun
    budget = float(os.environ.get('BP_LIVE_BUDGET_S', 360))
    for x in pump_candidates()[:int(os.environ.get('BP_LIVE_PUMP', 40))]:
        if time.time() - t0 > budget * 0.6: print('pump time budget reached'); break
        try:
            cpump.collect(x['mint'], 'live_poll', None, page_budget=12, force=True, out_dir=LIVE, meta=x)
            d = json.load(open(os.path.join(LIVE, x['mint'] + '.json')))
            r = bl.build_pump(d); live.append(r)
        except Exception as e: print('pump live err', x['mint'][:8], e)
    # ---- GT pads
    for c in gt_candidates()[:int(os.environ.get('BP_LIVE_GT', 30))]:
        if time.time() - t0 > budget: print('gt time budget reached'); break
        try:
            d = gt_live_record(c); r = bl.build_generic(d, c['net']); r['ext']['live_pool'] = c['pool']; live.append(r)
        except Exception as e: print('gt live err', c['pool'][:8], e)
    out = []
    for r in live:
        age = (time.time() * 1000 - r['created_ts']) / 1000
        sn = r['ext'].get('snap') or {}
        As = [a for a in mt.SNAP_AGES if a <= age and (sn.get(a) or sn.get(str(a)))]
        if not As: continue
        A = max(As); s = sn.get(A) or sn.get(str(A))
        ws = s.get('_w') or []
        s['repeat'] = sum(1 for w in ws if len(rep_sets.get(w, ())) >= 2)
        v = mt.vec(s); sh = mt.shape(r['trajectory'], A)
        item = {'key': r['key'], 'chain': r['chain'], 'address': r['address'], 'symbol': r['symbol'], 'launchpad': r['launchpad'], 'age_s': round(age), 'snapshot_age_s': A,
                'phase': r['phase'], 'mcap': s.get('mcap'), 'curve_pct': s.get('curve_pct'), 'n_buyers': s.get('n_buyers'), 'repeat_early_buyers': s['repeat'],
                'why': [], 'probs': {}, 'matches': []}
        for thr in (1e6, 1e7, 1e5):
            mk = (A, thr)
            if mk not in models: models[mk] = mt.Model(recs, A, thr, rates)
            M = models[mk]
            if s.get('mcap') and s['mcap'] >= thr: item['probs'][str(int(thr))] = {'p': 1.0, 'note': 'already above'}; continue
            pr = M.predict(v, sh, r['launchpad'])
            if not pr: continue
            item['probs'][str(int(thr))] = {'p': round(pr['p'], 4), 'calibrated': pr['calibrated'], 'base_rate': pr['base_rate'], 'n_neighbors': len(pr['neighbors'])}
            if thr == 1e6:
                for d_, row in pr['neighbors'][:8]:
                    rr = row['r']; po = rr.get('post') or {}
                    item['matches'].append({'symbol': rr.get('symbol'), 'key': rr['key'], 'launchpad': rr['launchpad'], 'similarity_pct': round(100 * math.exp(-d_ * d_ / 2), 1),
                                            'peak_mcap': po.get('peak_mcap'), 't_to_1m_s': po.get('t_to_1m_s'), 'max_dd_pct': po.get('max_dd_from_peak_pct'),
                                            'reached_1m': (rr.get('outcome') or {}).get('reached_1m'), 'reached_10m': (rr.get('outcome') or {}).get('reached_10m'), 'stratum': rr.get('sample_stratum')})
        item['why'] = explain(r, None, s, A)
        out.append(item)
    out.sort(key=lambda x: -((x['probs'].get('1000000') or {}).get('p') or 0))
    model = {}
    try: model = json.load(open(os.path.join(BP, 'model.json')))
    except Exception: pass
    wjson(os.path.join(BP, 'live.json'), {'generatedAt': int(time.time() * 1000), 'elapsed_s': round(time.time() - t0), 'n_live': len(out), 'n_library': len(recs),
                                          'pad_rates': rates, 'items': out, 'flag_rule': flag_rule(model)})
    print('live', len(out), 'in', round(time.time() - t0), 's')
    for x in out[:10]: print(x['symbol'], x['launchpad'], x['age_s'], x['probs'].get('1000000'), [m['symbol'] for m in x['matches'][:3]])

def flag_rule(model):
    """cut used to flag 'high-probability runners' + what the held-out pump.fun backtest says about that cut (never tuned on live)"""
    po = ((model.get('backtest') or {}).get('pump_only') or {}).get('by') or {}
    b = po.get('900_1000000') or {}
    a = next((x for x in b.get('at', []) if x['p_ge'] == 0.1), None)
    note = 'flag = model P($1M) >= 10%.'
    if a: note += (f" Held-out pump.fun backtest at 15 min: {a['flagged']} of {b.get('n')} test launches flagged, {a['hits']} reached $1M "
                   f"(population-weighted precision {(f"{a['prec_popw'] * 100:.0f}%") if a['prec_popw'] is not None else 'n/a'}); on-curve flags: {a['flagged_on_curve']} with {a['hits_on_curve']} hits. "
                   "Probabilities are over-confident at lower cuts (P>=5% flagged launches hit ~0.3% after population weighting): use as a ranking, not odds.")
    return {'threshold': 1e6, 'p_ge': 0.1, 'note': note}

if __name__ == '__main__':
    main()
