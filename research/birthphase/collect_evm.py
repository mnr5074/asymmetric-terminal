"""Birth-phase collector for EVM launchpads (Robinhood Chain pads, Base pads, BSC four.meme/tiktokfun).
Per token: GeckoTerminal token pools -> birth pool (pad dex, else earliest pool); block at pool creation by timestamp
search on the public RPC; eth_getLogs Transfer(token) from creation forward -> per-tx net token deltas -> first buyers;
wallet freshness = nonce at the buy block (Base) or current nonce (Robinhood RPC has no historical state);
GT minute candles (arc) + hourly/daily candles on the main pool (milestones).
BSC: keyless public RPCs refuse archive eth_getLogs, so BSC records carry candles/outcomes only (coverage=partial).
Raw -> data/birthphase/cache/raw/evm/<chain>_<addr>.json"""
import sys, os, json, time, random, argparse, calendar
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bp_common import http, evm, BP, DATA, GT, wjson
RAW = os.path.join(BP, 'cache', 'raw', 'evm'); os.makedirs(RAW, exist_ok=True)
TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
PADS = {  # launchpad id -> (chain, GT dex ids)
    'pons': ('robinhood', ['pons-dot-family', 'pons-v2', 'pons-v2-dex']), 'frontier-fun': ('robinhood', ['frontier-fun']), 'clank-trade': ('robinhood', ['clank-trade']),
    'hoodit': ('robinhood', ['hoodit']), 'bankr-robinhood': ('robinhood', ['bankr-robinhood']), 'clanker-robinhood': ('robinhood', ['clanker-robinhood']),
    'o1-launchpad-robinhood': ('robinhood', ['o1-launchpad-robinhood']), 'easya-kickstart-robinhood': ('robinhood', ['easya-kickstart-robinhood']),
    'robinhood-uniswap': ('robinhood', ['uniswap-v3-robinhood', 'uniswap-v4-robinhood', 'uniswap-v2-robinhood']),
    'o1-launchpad': ('base', ['o1-launchpad']), 'bankr': ('base', ['bankr']), 'clanker': ('base', ['uniswap-v4-base', 'uniswap-v3-base']),
    'four.meme': ('bsc', ['four-meme']), 'tiktokfun': ('bsc', ['tiktokfun'])}
RANGE = {'robinhood': 2_000_000, 'base': 9_900, 'bsc': 0}
NONCE_HIST = {'base': True, 'robinhood': False, 'bsc': False}

def iso(s):
    try: return calendar.timegm(time.strptime(s[:19], '%Y-%m-%dT%H:%M:%S')) * 1000
    except Exception: return None

def gt_pools(chain, addr):
    d = http(f'{GT}/networks/{chain}/tokens/{addr}/pools?page=1&include=dex', ttl=12 * 3600)
    out = []
    for p in (d or {}).get('data', []) or []:
        a = p['attributes']; r = p['relationships']
        out.append({'pool': a['address'], 'dex': r['dex']['data']['id'], 'created': iso(a.get('pool_created_at') or ''), 'fdv': float(a.get('fdv_usd') or 0) or None,
                    'px': float(a.get('base_token_price_usd') or 0) or None, 'liq': float(a.get('reserve_in_usd') or 0), 'base': r['base_token']['data']['id'].split('_', 1)[1].lower(), 'name': a.get('name')})
    return out

def ohlcv_latest(chain, pool, tf, limit=1000): return ohlcv(chain, pool, tf, None, limit)
def ohlcv(chain, pool, tf, before=None, limit=1000):
    u = f"{GT}/networks/{chain}/pools/{pool}/ohlcv/{tf}?aggregate=1&limit={limit}&currency=usd&token=base" + (f"&before_timestamp={int(before)}" if before else '')
    d = http(u, ttl=None if before and before < time.time() - 7200 else 6 * 3600)
    try: return sorted(d['data']['attributes']['ohlcv_list'])
    except Exception:
        if before and isinstance(d, dict) and d.get('_http_error') == 401: return ohlcv_latest(chain, pool, tf, limit)
        return None

def blk(chain, n): 
    b = evm(chain, 'eth_getBlockByNumber', [hex(n), False])
    return int(b['timestamp'], 16)

def block_at(chain, ts_s):
    hi = int(evm(chain, 'eth_blockNumber', [], ttl=0), 16); thi = blk(chain, hi)
    lo = max(1, hi - 1); tlo = thi
    # expand down
    step = 1000
    while tlo > ts_s:
        lo = max(1, hi - step); tlo = blk(chain, lo); step *= 4
        if lo == 1: break
    for _ in range(40):
        if hi - lo <= 1: break
        guess = lo + int((ts_s - tlo) / max(1e-9, (thi - tlo)) * (hi - lo)) if thi > tlo else (lo + hi) // 2
        mid = min(hi - 1, max(lo + 1, guess))
        if hi - lo > 64 and _ % 2: mid = (lo + hi) // 2
        tm = blk(chain, mid)
        if tm < ts_s: lo, tlo = mid, tm
        else: hi, thi = mid, tm
    return lo

def collect(chain, addr, pad, stratum, extra=None, force=False):
    addr = addr.lower(); fn = os.path.join(RAW, f'{chain}_{addr}.json')
    if os.path.exists(fn) and not force:
        try:
            o = json.load(open(fn))
            if o.get('v') == 1 and time.time() * 1000 - o.get('fetched', 0) < 12 * 3600e3: return 'cached'
        except Exception: pass
    now = int(time.time() * 1000)
    rec = {'v': 1, 'chain': chain, 'address': addr, 'pad': pad, 'stratum': stratum, 'extra': extra or {}, 'fetched': now, 'notes': []}
    pools = gt_pools(chain, addr); rec['pools'] = pools
    if not pools: rec['notes'].append('GeckoTerminal has no pools for this token'); wjson(fn, rec); return 'nopools'
    dexes = PADS.get(pad, (chain, []))[1]
    birth = sorted([p for p in pools if p['dex'] in dexes], key=lambda p: p['created'] or 9e15) or sorted(pools, key=lambda p: p['created'] or 9e15)
    bp = birth[0]; rec['birth_pool'] = bp
    other = sorted([p for p in pools if p['pool'] != bp['pool']], key=lambda p: -(p['liq'] or 0))
    gp = sorted([p for p in other if p['created'] and bp['created'] and p['created'] >= bp['created']], key=lambda p: p['created'])
    rec['grad_pool'] = gp[0] if (gp and pad in ('four.meme', 'tiktokfun', 'pons', 'frontier-fun', 'hoodit', 'clank-trade')) else None
    rec['main_pool'] = max(pools, key=lambda p: p['liq'] or 0)
    rec['symbol'] = (bp['name'] or '').split(' / ')[0]
    sup = next((p['fdv'] / p['px'] for p in [bp] + other if p['fdv'] and p['px']), None); rec['supply'] = sup
    c0 = bp['created']; rec['created'] = c0
    if c0:
        b = c0 / 1000 + 1000 * 60
        rec['birth_m1'] = ohlcv(chain, bp['pool'], 'minute', before=b if b < now / 1000 else None)
    post = rec['grad_pool'] or rec['main_pool']
    if post:
        hb = ((post['created'] or c0) / 1000) + 1000 * 3600
        rec['post_h1'] = ohlcv(chain, post['pool'], 'hour', before=hb if hb < now / 1000 else None)
        rec['post_d1'] = ohlcv(chain, post['pool'], 'day')
    # first buyers from Transfer logs
    if RANGE.get(chain) and c0:
        try:
            b0 = block_at(chain, c0 / 1000 - 120); rec['block0'] = b0
            logs, frm = [], b0
            head = int(evm(chain, 'eth_blockNumber', [], ttl=0), 16)
            for _ in range(6):
                to = min(head, frm + RANGE[chain])
                L = evm(chain, 'eth_getLogs', [{'fromBlock': hex(frm), 'toBlock': hex(to), 'address': addr, 'topics': [TRANSFER]}], ttl=None if to < head - 1000 else 0) or []
                logs += L
                if len({l['transactionHash'] for l in logs}) >= 60 or to >= head: break
                frm = to + 1
            txs = {}
            for l in logs:
                if len(l['topics']) < 3: continue
                f, t = '0x' + l['topics'][1][-40:], '0x' + l['topics'][2][-40:]
                v = int(l['data'], 16) / 1e18 if l['data'] not in ('0x', '') else 0
                d = txs.setdefault(l['transactionHash'], {'bn': int(l['blockNumber'], 16), 'i': int(l['logIndex'], 16), 'd': {}})
                d['d'][f] = d['d'].get(f, 0) - v; d['d'][t] = d['d'].get(t, 0) + v
            pool_like = {p['pool'].lower()[:42] for p in pools}
            # the busiest net sender in early txs is the curve / pool manager
            sendc = {}
            for d in txs.values():
                for a, v in d['d'].items():
                    if v < 0: sendc[a] = sendc.get(a, 0) + 1
            zero = '0x' + '0' * 40
            mgr = {a for a, c in sorted(sendc.items(), key=lambda x: -x[1])[:2] if a != zero} | pool_like
            buys = []
            for h, d in sorted(txs.items(), key=lambda x: (x[1]['bn'], x[1]['i'])):
                gains = [(a, v) for a, v in d['d'].items() if v > 0 and a not in mgr and a != zero]
                senders = [a for a, v in d['d'].items() if v < 0]
                if not gains: continue
                a, v = max(gains, key=lambda x: x[1])
                kind = 'mint' if senders == [zero] else ('buy' if any(s in mgr for s in senders) else 'transfer')
                buys.append({'bn': d['bn'], 'tx': h, 'u': a, 'tok': v, 'kind': kind})
            # timestamps for distinct blocks of the first 40 rows
            bts = {}
            for b in sorted({x['bn'] for x in buys[:20]}):
                try: bts[b] = blk(chain, b) * 1000
                except Exception: pass
            kb = sorted(bts)
            for x in buys[:40]:
                if x['bn'] in bts: x['ts'] = bts[x['bn']]
                elif len(kb) >= 2 and x['bn'] > kb[-1]:  # extrapolate from the last two known blocks (approx, flagged)
                    r = (bts[kb[-1]] - bts[kb[0]]) / max(1, kb[-1] - kb[0]); x['ts'] = int(bts[kb[-1]] + r * (x['bn'] - kb[-1])); x['ts_approx'] = True
            # nonce
            for x in [y for y in buys if y['kind'] == 'buy'][:15]:
                try:
                    x['nonce'] = int(evm(chain, 'eth_getTransactionCount', [x['u'], hex(x['bn']) if NONCE_HIST[chain] else 'latest'], ttl=None if NONCE_HIST[chain] else 24 * 3600), 16)
                    x['nonce_note'] = 'at_buy' if NONCE_HIST[chain] else 'now'
                except Exception as e: x['nonce_err'] = str(e)[:80]
            rec['first_txs'] = buys[:40]; rec['mgr'] = sorted(mgr)[:3]; rec['n_logs'] = len(logs)
        except Exception as e:
            rec['notes'].append('rpc logs: ' + str(e)[:150])
    elif chain == 'bsc':
        rec['notes'].append('BSC: keyless public RPCs refuse historical eth_getLogs (archive) -> no first-buyer list')
    wjson(fn, rec)
    return f"ok first={len(rec.get('first_txs') or [])} m1={len(rec.get('birth_m1') or [])}"

def targets(per_pad, pads):
    random.seed(9)
    T = {p: {} for p in pads}
    cat = json.load(open(os.path.join(DATA, 'crash_catalog_final.json')))
    for t in cat.get('eco_tokens_ranked', []):
        ch = t['chain']; pd = ' '.join(t.get('pads') or [])
        p = None
        if ch == 'robinhood':
            p = 'pons' if 'pons' in pd else next((k for k, (c, ds) in PADS.items() if c == 'robinhood' and any(d in pd for d in ds)), 'robinhood-uniswap')
        elif ch == 'base': p = 'o1-launchpad' if 'o1-launchpad' in pd else ('bankr' if 'bankr' in pd else 'clanker' if 'uniswap' in pd else None)
        elif ch == 'bsc': p = 'four.meme' if 'four-meme' in pd else ('tiktokfun' if 'tiktokfun' in pd else None)
        if p in T: T[p][t['address'].lower()] = ('catalog_crash' if (t.get('crash_depth_pct') or 0) <= -70 else 'catalog_runner', {'catalog_peak': t.get('peak_mcap'), 'crash_depth_pct': t.get('crash_depth_pct'), 'pads': t.get('pads')})
    for p in pads:
        ch, ds = PADS[p]
        if p in ('robinhood-uniswap', 'clanker'): continue
        act, fail = [], []
        for dex in ds[:1]:
            for pg in [1, 2] + random.sample(range(3, 11), 3):
                d = http(f'{GT}/networks/{ch}/dexes/{dex}/pools?page={pg}&sort=h24_tx_count_desc', ttl=24 * 3600)
                for x in (d or {}).get('data', []) or []:
                    a = x['relationships']['base_token']['data']['id'].split('_', 1)[1].lower()
                    (act if pg <= 2 else fail).append(a)
        room = max(0, per_pad - len(T[p])); random.shuffle(act); random.shuffle(fail)
        for a in act[:room // 2]: T[p].setdefault(a, ('pad_active_sample', {'src': 'GT dex listing pages 1-2'}))
        for a in fail[:room - room // 2]: T[p].setdefault(a, ('pad_listing_sample', {'src': 'GT dex listing pages 3-10'}))
    # Clanker (Base): newest launches from the public clanker.world API as a live-random cohort
    if 'clanker' in T:
        d = http('https://www.clanker.world/api/tokens?sort=desc&page=1', ttl=3600)
        for x in (d or {}).get('data', [])[:10]:
            if x.get('chain_id') in ('8453', 8453): T['clanker'].setdefault(x['contract_address'].lower(), ('live_poll', {'src': 'clanker.world newest'}))
    return T

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--per-pad', type=int, default=25); ap.add_argument('--pads', default=','.join(PADS)); ap.add_argument('--force', action='store_true')
    a = ap.parse_args(); pads = [p for p in a.pads.split(',') if p in PADS]
    T = targets(a.per_pad, pads)
    items = [(PADS[p][0], m, p, st, ex) for p in pads for m, (st, ex) in T[p].items()]
    items.sort(key=lambda x: ({'catalog_runner': 0, 'catalog_crash': 0}.get(x[3], 1), list(T[x[2]]).index(x[1])))
    print(len(items), 'targets', {p: len(T[p]) for p in pads}, flush=True)
    t0 = time.time()
    for n, (ch, m, p, st, ex) in enumerate(items, 1):
        try: r = collect(ch, m, p, st, ex, a.force)
        except Exception as e: r = 'ERR ' + str(e)[:150]
        print(f'[{n}/{len(items)} {int(time.time() - t0)}s] {p} {m[:10]} {st} {r}', flush=True)
