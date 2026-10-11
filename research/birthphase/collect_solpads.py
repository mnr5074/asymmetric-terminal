"""Birth-phase collector for Solana launchpads other than pump.fun (LetsBonk, Raydium LaunchLab, Meteora DBC/Believe,
Bags, Moonshot/Moonit, Boop, Heaven, Daos.fun, StonksFun, memefun). Per token:
  GeckoTerminal token pools -> curve pool (pad dex) + graduated pool; GT minute candles on the curve pool for the arc;
  Solana public RPC getSignaturesForAddress(curve pool) paged to the oldest signature (cap) + getTransaction on the
  earliest successful txs -> first buyers (signer's token delta) and dev buy; GT hourly/daily candles on the graduated
  pool for milestones. Raw -> data/birthphase/cache/raw/solpads/<mint>.json.
usage: python3 collect_solpads.py [--per-pad 35] [--pads letsbonk,bags]"""
import sys, os, json, time, random, argparse, calendar
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bp_common import http, sol, BP, DATA, GT, wjson
RAW = os.path.join(BP, 'cache', 'raw', 'solpads'); os.makedirs(RAW, exist_ok=True)
PADS = {'letsbonk': ['letsbonk-fun'], 'raydium-launchlab': ['raydium-launchlab'], 'meteora-dbc': ['meteora-dbc'], 'bags': ['bags-fm'],
        'moonshot': ['moonshot', 'moonit'], 'boop': ['boop-fun'], 'heaven': ['heaven'], 'daos.fun': ['daos-fun'], 'stonkfun': ['stonkfun'], 'memefun': ['memefun']}
DEX2PAD = {d: p for p, ds in PADS.items() for d in ds}
QUOTES = {'So11111111111111111111111111111111111111112': 'SOL', 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB': 'USD1', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC'}
SIG_PAGES, FIRST_TX = 3, 16

def iso(s):
    try: return calendar.timegm(time.strptime(s[:19], '%Y-%m-%dT%H:%M:%S')) * 1000
    except Exception: return None

def gt_pools(mint):
    d = http(f'{GT}/networks/solana/tokens/{mint}/pools?page=1&include=dex', ttl=12 * 3600)
    out = []
    for p in (d or {}).get('data', []) or []:
        a = p['attributes']; r = p['relationships']
        out.append({'pool': a['address'], 'dex': r['dex']['data']['id'], 'created': iso(a.get('pool_created_at') or ''), 'fdv': float(a.get('fdv_usd') or 0) or None,
                    'px': float(a.get('base_token_price_usd') or 0) or None, 'liq': float(a.get('reserve_in_usd') or 0), 'base': r['base_token']['data']['id'].split('_', 1)[1],
                    'quote': r['quote_token']['data']['id'].split('_', 1)[1], 'name': a.get('name')})
    return out

def ohlcv_latest(pool, tf, limit=1000):
    return ohlcv(pool, tf, None, limit)

def ohlcv(pool, tf, before=None, limit=1000):
    u = f"{GT}/networks/solana/pools/{pool}/ohlcv/{tf}?aggregate=1&limit={limit}&currency=usd&token=base" + (f"&before_timestamp={int(before)}" if before else '')
    d = http(u, ttl=None if before and before < time.time() - 7200 else 6 * 3600)
    try: return sorted(d['data']['attributes']['ohlcv_list'])
    except Exception:
        if before and isinstance(d, dict) and d.get('_http_error') == 401:  # GT free tier refuses old before_timestamp
            return ohlcv_latest(pool, tf, limit)
        return None

def parse_tx(t, mint):
    m = t.get('meta') or {}
    keys = t['transaction']['message']['accountKeys']
    signer = next((k['pubkey'] for k in keys if k.get('signer')), None)
    def bal(arr): return {(b.get('owner'), b['mint']): float(b['uiTokenAmount'].get('uiAmount') or 0) for b in arr or []}
    pre, post = bal(m.get('preTokenBalances')), bal(m.get('postTokenBalances'))
    d = {k: post.get(k, 0) - pre.get(k, 0) for k in set(pre) | set(post)}
    tok = sum(v for (o, mi), v in d.items() if mi == mint and o == signer)
    quote_in = max([v for (o, mi), v in d.items() if mi in QUOTES and o != signer] + [0])
    qsym = next((QUOTES[mi] for (o, mi), v in d.items() if mi in QUOTES and o != signer and v == quote_in and v > 0), None)
    sol_delta = None
    try:
        i = [k['pubkey'] for k in keys].index(signer); sol_delta = (m['postBalances'][i] - m['preBalances'][i]) / 1e9
    except Exception: pass
    logs = ' '.join(m.get('logMessages') or [])
    return {'ts': (t.get('blockTime') or 0) * 1000, 'u': signer, 'tok': tok, 'quote': quote_in or (abs(sol_delta) if sol_delta and sol_delta < 0 and tok > 0 else None),
            'qsym': qsym or ('SOL' if sol_delta else None), 'create': ('Initialize' in logs or 'Create' in logs) and 'Instruction: Initialize' in logs or 'InitializeV2' in logs or 'Instruction: Create' in logs,
            'err': bool(m.get('err'))}

def collect(mint, pad, stratum, extra=None, force=False):
    fn = os.path.join(RAW, mint + '.json')
    if os.path.exists(fn) and not force:
        try:
            o = json.load(open(fn))
            if o.get('v') == 2 and time.time() * 1000 - o.get('fetched', 0) < 12 * 3600e3: return 'cached'
        except Exception: pass
    now = int(time.time() * 1000)
    rec = {'v': 2, 'mint': mint, 'pad': pad, 'stratum': stratum, 'extra': extra or {}, 'fetched': now, 'notes': []}
    pools = gt_pools(mint); rec['pools'] = pools
    if not pools: rec['notes'].append('GeckoTerminal has no pools for this token'); wjson(fn, rec); return 'nopools'
    curve = sorted([p for p in pools if p['dex'] in PADS[pad]], key=lambda p: p['created'] or 9e15)
    other = sorted([p for p in pools if p['dex'] not in PADS[pad]], key=lambda p: -(p['liq'] or 0))
    if not curve:
        rec['notes'].append(f'no {pad} curve pool indexed on GT; using earliest pool as birth pool')
        curve = sorted(pools, key=lambda p: p['created'] or 9e15)[:1]
    cp = curve[0]; rec['curve_pool'] = cp
    sym = None
    try: sym = (cp['name'] or '').split(' / ')[0]
    except Exception: pass
    rec['symbol'] = sym
    sup = None
    for p in [cp] + other:
        if p['fdv'] and p['px']: sup = p['fdv'] / p['px']; break
    rec['supply'] = sup
    grad_pools = [p for p in other if p['created'] and cp['created'] and p['created'] >= cp['created'] - 60000]
    gp = sorted(grad_pools, key=lambda p: p['created'])[0] if grad_pools else None
    rec['grad_pool'] = gp; rec['main_pool'] = other[0] if other else None
    # signatures on the curve pool, newest -> oldest
    sigs, before, pages = [], None, 0
    try:
        while pages < SIG_PAGES:
            o = {'limit': 1000}
            if before: o['before'] = before
            r = sol('getSignaturesForAddress', [cp['pool'], o], ttl=None if before else 3 * 3600); pages += 1
            if not r: break
            sigs += [{'s': x['signature'], 't': (x.get('blockTime') or 0) * 1000, 'e': bool(x.get('err'))} for x in r]
            if len(r) < 1000: rec['sig_complete'] = True; break
            before = r[-1]['signature']
    except Exception as e: rec['notes'].append('rpc signatures: ' + str(e)[:120])
    rec['n_sigs'] = len(sigs); rec.setdefault('sig_complete', False)
    rec['sig_times'] = [x['t'] for x in sigs if not x['e']] if rec['sig_complete'] else None
    first = []
    if rec['sig_complete'] and sigs:
        early = [x for x in reversed(sigs) if not x['e']][:FIRST_TX]
        for x in early:
            try:
                t = sol('getTransaction', [x['s'], {'maxSupportedTransactionVersion': 1, 'encoding': 'jsonParsed'}])
                if t: first.append(parse_tx(t, mint))
            except Exception as e: rec['notes'].append('getTransaction: ' + str(e)[:100])
    elif not rec['sig_complete']:
        rec['notes'].append(f'curve pool has > {SIG_PAGES * 1000} signatures; oldest (first buyers) not reached within the free-RPC page cap')
    rec['first_txs'] = first
    c0 = (first[0]['ts'] if first else None) or cp['created']
    rec['created'] = c0
    # candles
    if c0:
        b = c0 / 1000 + 1000 * 60
        rec['curve_m1'] = ohlcv(cp['pool'], 'minute', before=b if b < now / 1000 else None)
    post_pool = gp or (other[0] if other else None)
    if post_pool:
        hb = (post_pool['created'] or c0) / 1000 + 1000 * 3600
        rec['post_h1'] = ohlcv(post_pool['pool'], 'hour', before=hb if hb < now / 1000 else None)
        rec['post_d1'] = ohlcv(post_pool['pool'], 'day')
    else:
        rec['curve_h1'] = ohlcv(cp['pool'], 'hour', before=(c0 / 1000 + 1000 * 3600) if c0 and c0 / 1000 + 3.6e6 < now / 1000 else None)
        rec['curve_d1'] = ohlcv(cp['pool'], 'day')
    wjson(fn, rec)
    return f"ok sigs={len(sigs)}{'' if rec['sig_complete'] else '+'} first={len(first)} grad={'y' if gp else 'n'}"

def cg_addresses(cat_keys):
    """CoinGecko category runners -> Solana contract addresses (cached forever)."""
    lc = json.load(open(os.path.join(DATA, 'launchpad_cg.json')))
    out = []
    for ck in cat_keys:
        c = lc.get(ck) or {}
        ids = {x['id'] for x in (c.get('notable_recent_ge10M') or []) + (c.get('all_time_top') or [])[:8] + ([c['biggest_recent']] if c.get('biggest_recent') else [])}
        for i in ids:
            d = http(f'https://api.coingecko.com/api/v3/coins/{i}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false', ttl=None)
            a = ((d or {}).get('platforms') or {}).get('solana')
            if a: out.append((a, i))
    return out

def targets(per_pad, pads):
    random.seed(5)
    T = {p: {} for p in pads}
    cat = json.load(open(os.path.join(DATA, 'crash_catalog_final.json')))
    for t in cat.get('eco_tokens_ranked', []):
        if t['chain'] != 'solana': continue
        for pd in t.get('pads') or []:
            dex = pd.split('/')[-1] if pd.startswith('gt:solana/') else pd
            p = DEX2PAD.get(dex)
            if p in T:
                T[p][t['address']] = ('catalog_crash' if (t.get('crash_depth_pct') or 0) <= -70 else 'catalog_runner', {'catalog_peak': t.get('peak_mcap'), 'crash_depth_pct': t.get('crash_depth_pct')})
    GAPS_CG = {'letsbonk': ['letsbonk-fun-ecosystem'], 'meteora-dbc': ['believe-app-ecosystem'], 'moonshot': ['moonshot-ecosystem']}
    for p, cks in GAPS_CG.items():
        if p not in T: continue
        try:
            for a, i in cg_addresses(cks): T[p].setdefault(a, ('catalog_runner', {'cg_id': i}))
        except Exception as e: print('cg', e)
    ex = json.load(open(os.path.join(DATA, 'launchpad_extra.json')))
    act = {p: [] for p in pads}
    for t in ex.get('tokens', []):
        if t['chain'] == 'solana' and t['pad'].startswith('gt:solana/'):
            p = DEX2PAD.get(t['pad'].split('/')[-1])
            if p in act and t['address'] not in T[p]: act[p].append(t['address'])
    for p in pads:
        # GT listing pages 3..10 (zero-activity pools = mostly failed launches) as the failure sample
        fail = []
        for dex in PADS[p]:
            for pg in random.sample(range(3, 11), 3):
                d = http(f'{GT}/networks/solana/dexes/{dex}/pools?page={pg}&sort=h24_tx_count_desc', ttl=24 * 3600)
                for x in (d or {}).get('data', []) or []:
                    a = x['relationships']['base_token']['data']['id'].split('_', 1)[1]
                    if a not in T[p] and a not in QUOTES: fail.append(a)
        n_cat = len(T[p]); room = max(0, per_pad - n_cat)
        random.shuffle(act[p]); random.shuffle(fail)
        for a in act[p][:room // 2]: T[p][a] = ('pad_active_sample', {'src': 'GT dex listing pages 1-3 (active now)'})
        for a in fail[:room - min(len(act[p]), room // 2)]: T[p].setdefault(a, ('pad_listing_sample', {'src': 'GT dex listing pages 3-10 (inactive pools)'}))
    return T

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--per-pad', type=int, default=35); ap.add_argument('--pads', default=','.join(PADS))
    ap.add_argument('--force', action='store_true'); a = ap.parse_args()
    pads = [p for p in a.pads.split(',') if p in PADS]
    T = targets(a.per_pad, pads)
    items = [(m, p, st, ex) for p in pads for m, (st, ex) in T[p].items()]
    # round-robin across pads so partial runs still cover every pad
    items.sort(key=lambda x: ({'catalog_runner': 0, 'catalog_crash': 0}.get(x[2], 1), list(T[x[1]]).index(x[0]), pads.index(x[1])))
    print(len(items), 'targets', {p: len(T[p]) for p in pads}, flush=True)
    t0 = time.time()
    for n, (m, p, st, ex) in enumerate(items, 1):
        try: r = collect(m, p, st, ex, a.force)
        except Exception as e: r = 'ERR ' + str(e)[:150]
        print(f'[{n}/{len(items)} {int(time.time() - t0)}s] {p} {m[:8]} {st} {r}', flush=True)
