#!/usr/bin/env python3
"""Moonshot research collector: builds data/moonshot.db from free public APIs.
Sources: pump.fun v3 coin lists, DexScreener (pairs, boosts, profiles, orders, search),
StonkFun public API, GeckoTerminal OHLCV (price path), RugCheck (current holder/LP snapshot).
Usage: python3 collect.py [--max N] [--refresh-hours H]
"""
import sys, os, time, json, argparse, traceback, statistics
from concurrent.futures import ThreadPoolExecutor
from common import get, db, theme_of

PUMP = 'https://frontend-api-v3.pump.fun'
DS = 'https://api.dexscreener.com'
GT = 'https://api.geckoterminal.com/api/v2/networks/solana'
GTB = 'https://api.geckoterminal.com/api/v2/networks'
# Research chains beyond Solana: DexScreener chainId -> (GeckoTerminal network, GoPlus chain id, native symbol, CoinGecko id)
EVM_CHAINS = {'base': ('base', '8453', 'ETH', 'ethereum'), 'bsc': ('bsc', '56', 'BNB', 'binancecoin'), 'ethereum': ('eth', '1', 'ETH', 'ethereum')}
STABLE = ('USDC', 'USDT', 'USD1', 'DAI', 'FDUSD', 'USDbC', 'BUSD', 'USDe')
now_ms = lambda: int(time.time() * 1000)

def log(*a): print(time.strftime('%H:%M:%S'), *a, flush=True)
_sol = {}
_nat = {}
def native_usd(sym):
    if not _nat or time.time() - _nat.get('_t', 0) > 600:
        d = get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin&vs_currencies=usd') or {}
        _nat.update({'ETH': (d.get('ethereum') or {}).get('usd'), 'BNB': (d.get('binancecoin') or {}).get('usd'), '_t': time.time()})
    return _nat.get(sym.replace('W', '', 1) if sym in ('WETH', 'WBNB') else sym)
def sol_price():
    if not _sol.get('p') or time.time() - _sol['t'] > 600:
        d = get('https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112') or {}
        _sol['p'] = (d.get('So11111111111111111111111111111111111111112') or {}).get('usdPrice') or 110.0; _sol['t'] = time.time()
    return _sol['p']

# ---------------- candidates ----------------
def add_cand(c, mint, src, hint=None, chain='solana'):
    if not mint or len(mint) < 32: return
    if chain != 'solana': mint = mint.lower()
    row = c.execute('SELECT sources, hint FROM candidates WHERE mint=?', (mint,)).fetchone()
    if row:
        srcs = set(row['sources'].split(',')) | {src}
        c.execute('UPDATE candidates SET sources=?, hint=COALESCE(?, hint) WHERE mint=?', (','.join(sorted(srcs)), json.dumps(hint) if hint else None, mint))
    else:
        c.execute('INSERT INTO candidates(mint, sources, hint, added_at, chain) VALUES(?,?,?,?,?)', (mint, src, json.dumps(hint) if hint else None, now_ms(), chain))

def gt_base(p):
    i = (p.get('relationships', {}).get('base_token', {}).get('data', {}).get('id') or '')
    return i.split('_', 1)[1] if '_' in i else None

def gather_evm(c, args):
    """Base / BSC / Ethereum candidates: DexScreener boosts+profiles+searches, GeckoTerminal trending, top-volume,
    new pools and (BSC) four.meme launchpad pools. Dead tokens are under-sampled: no free feed lists dead EVM tokens."""
    n0 = c.execute("SELECT COUNT(*) FROM candidates WHERE chain!='solana'").fetchone()[0]
    for path, src in [('/token-boosts/top/v1', 'ds_boost_top'), ('/token-boosts/latest/v1', 'ds_boost_latest'), ('/token-profiles/latest/v1', 'ds_profiles')]:
        for x in get(DS + path) or []:
            if x.get('chainId') in EVM_CHAINS: add_cand(c, x['tokenAddress'], src, None, x['chainId'])
    for q in ['ai', 'cat', 'dog', 'trump', 'pepe', 'frog', 'moon', 'inu', 'meme', 'base', 'bnb', 'cz', 'four', 'brett', 'toshi', 'degen']:
        for p in (get(f'{DS}/latest/dex/search?q={q}') or {}).get('pairs') or []:
            if p['chainId'] in EVM_CHAINS and p['quoteToken']['symbol'] in ('WETH', 'ETH', 'WBNB', 'BNB') + STABLE: add_cand(c, p['baseToken']['address'], 'ds_search', None, p['chainId'])
    for ch, (net, *_r) in EVM_CHAINS.items():
        feeds = [(f'{GTB}/{net}/trending_pools?page={pg}', 'gt_trending') for pg in (1, 2, 3)] + \
                [(f'{GTB}/{net}/pools?page={pg}&sort=h24_volume_usd_desc', 'gt_top_volume') for pg in range(1, args.gt_pages + 1)] + \
                [(f'{GTB}/{net}/new_pools?page={pg}', 'gt_new') for pg in (1, 2, 3)]
        if ch == 'bsc': feeds += [(f'{GTB}/bsc/dexes/four-meme/pools?page={pg}', 'fourmeme') for pg in range(1, args.gt_pages + 1)]
        for url, src in feeds:
            for p in (get(url) or {}).get('data') or []:
                a = gt_base(p)
                if a and not a.startswith(('0x4200000000000000000000000000000000000006', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')):
                    add_cand(c, a, src, {'gt_dex': p['relationships']['dex']['data']['id']}, ch)
    c.commit()
    log('evm candidates', n0, '->', c.execute("SELECT COUNT(*) FROM candidates WHERE chain!='solana'").fetchone()[0])

def goplus_snapshot(chain, addr):
    gid = EVM_CHAINS[chain][1]
    d = get(f'https://api.gopluslabs.io/api/v1/token_security/{gid}?contract_addresses={addr}') or {}
    r = (d.get('result') or {}).get(addr.lower()) or (list((d.get('result') or {}).values()) or [None])[0]
    return r

def gather(c, args):
    n0 = c.execute('SELECT COUNT(*) FROM candidates').fetchone()[0]
    # pump.fun: current large caps (survivors), and graduated coins (recent → mostly losers)
    for off in range(0, args.pump_mcap, 50):
        d = get(f'{PUMP}/coins?offset={off}&limit=50&sort=market_cap&order=DESC&includeNsfw=false') or []
        if not isinstance(d, list) or not d: break
        for x in d: add_cand(c, x['mint'], 'pump_mcap', pump_hint(x))
    for off in range(0, args.pump_grad, 50):
        d = get(f'{PUMP}/coins?offset={off}&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false&complete=true') or []
        if not isinstance(d, list) or not d: break
        for x in d: add_cand(c, x['mint'], 'pump_graduated', pump_hint(x))
    # pump.fun graduated coins sorted by market cap ASCENDING = dead/rugged graduates of all ages (loser cohort, any age)
    for off in range(0, args.pump_dead, 50):
        d = get(f'{PUMP}/coins?offset={off}&limit=50&sort=market_cap&order=ASC&includeNsfw=false&complete=true') or []
        if not isinstance(d, list) or not d: break
        for x in d: add_cand(c, x['mint'], 'pump_dead_graduated', pump_hint(x))
    # DexScreener discovery feeds
    for path, src in [('/token-boosts/top/v1', 'ds_boost_top'), ('/token-boosts/latest/v1', 'ds_boost_latest'), ('/token-profiles/latest/v1', 'ds_profiles')]:
        for x in get(DS + path) or []:
            if x.get('chainId') == 'solana': add_cand(c, x['tokenAddress'], src)
    for q in ['ai', 'cat', 'dog', 'trump', 'pepe', 'frog', 'elon', 'moon', 'inu', 'pump', 'troll', 'meme', 'chill', 'goat', 'bonk']:
        for p in (get(f'{DS}/latest/dex/search?q={q}') or {}).get('pairs') or []:
            if p['chainId'] == 'solana' and p['quoteToken']['symbol'] in ('SOL', 'USDC', 'WSOL'): add_cand(c, p['baseToken']['address'], 'ds_search')
    # StonkFun launchpad
    for sort in ('marketCap', 'newest', 'volume'):
        d = get(f'https://www.stonkfun.xyz/api/public/v1/tokens?sort={sort}&pageSize=40') or {}
        for t in (d.get('data') or {}).get('tokens') or []:
            add_cand(c, t['mint'], 'stonkfun', {'stonk': True, 'created_ms': _iso(t.get('createdAt')), 'graduatedAt': _iso(t.get('graduatedAt')), 'quote': (t.get('quote') or {}).get('symbol'), 'mode': t.get('mode'), 'website': bool((t.get('links') or {}).get('website')), 'twitter': bool((t.get('links') or {}).get('twitter')), 'telegram': bool((t.get('links') or {}).get('telegram'))})
    # Fomo app boards via unofficial fomoapi.io — only if the user supplies a key (no keyless feed exists)
    key = os.environ.get('FOMOAPI_KEY')
    if key:
        import urllib.request
        for board in ('trending', 'graduated'):
            try:
                req = urllib.request.Request(f'https://api.fomoapi.io/v2/leaderboard/tokens/{board}?limit=25', headers={'authorization': f'Bearer {key}', 'user-agent': 'Mozilla/5.0'})
                for t in json.loads(urllib.request.urlopen(req, timeout=20).read()).get('tokens') or []:
                    if t.get('network') == 'solana': add_cand(c, t['token']['address'], f'fomo_{board}')
            except Exception as e: log('fomo error', e)
    else: log('fomo: skipped (no FOMOAPI_KEY; fomo.family has no keyless public feed)')
    c.commit()
    log('candidates', n0, '->', c.execute('SELECT COUNT(*) FROM candidates').fetchone()[0])

def _iso(s):
    if not s: return None
    try: return int(time.mktime(time.strptime(s[:19], '%Y-%m-%dT%H:%M:%S')) * 1000 - time.timezone * 1000)
    except Exception: return None

def pump_hint(x):
    return {'pump': True, 'created_ms': x.get('created_timestamp'), 'koth_ms': x.get('king_of_the_hill_timestamp'), 'creator': x.get('creator'),
            'twitter': bool(x.get('twitter')), 'telegram': bool(x.get('telegram')), 'website': bool(x.get('website')), 'replies': x.get('reply_count'), 'complete': x.get('complete'), 'name': x.get('name'), 'symbol': x.get('symbol')}

# ---------------- enrichment ----------------
def ohlcv(pool, tf, agg, before_s=None, limit=1000, net='solana'):
    pool = pool.split(':')[0]  # DexScreener suffixes launchpad curves (e.g. "0x…:4meme"); GeckoTerminal uses the bare address
    q = f'{GTB}/{net}/pools/{pool}/ohlcv/{tf}?aggregate={agg}&limit={limit}&currency=usd'
    if before_s: q += f'&before_timestamp={int(before_s)}'
    d = get(q) or {}
    lst = ((d.get('data') or {}).get('attributes') or {}).get('ohlcv_list') or []
    return sorted([{'t': r[0] * 1000, 'o': r[1], 'h': r[2], 'l': r[3], 'c': r[4], 'v': r[5]} for r in lst], key=lambda x: x['t'])

def path_features(path, launch_ms, launch_price):
    f = {}
    if not path or not launch_price: return f
    f['n_candles'] = len(path)
    closes = [x['c'] for x in path]
    pk = max(range(len(path)), key=lambda i: closes[i])
    f['peak_price'] = closes[pk]; f['peak_ts'] = path[pk]['t']
    f['time_to_peak_h'] = (path[pk]['t'] - launch_ms) / 3600e3
    cum, run_max, max_dd, hit = 0.0, 0.0, 0.0, {}
    for x in path:
        cum += x['v'] or 0
        run_max = max(run_max, x['c'])
        if run_max > 0: max_dd = max(max_dd, 1 - x['c'] / run_max)
        m = x['c'] / launch_price
        for k in (2, 10, 100):
            if k not in hit and m >= k:
                hit[k] = ((x['t'] - launch_ms) / 3600e3, cum, max_dd)
    for k in (2, 10, 100):
        if k in hit: f[f'hours_to_{k}x'] = max(0.0, hit[k][0])
    if 10 in hit: f['vol_to_10x'] = hit[10][1]; f['max_dd_before_10x'] = hit[10][2]
    else: f['max_dd_before_10x'] = max_dd
    if 100 in hit: f['vol_to_100x'] = hit[100][1]
    first1 = [x for x in path if x['t'] < launch_ms + 3600e3]
    first24 = [x for x in path if x['t'] < launch_ms + 86400e3]
    f['vol_first1h'] = sum(x['v'] or 0 for x in first1)
    f['vol_first24h'] = sum(x['v'] or 0 for x in first24)
    if first1: f['mult_at_1h'] = first1[-1]['c'] / launch_price
    if first24: f['mult_at_24h'] = first24[-1]['c'] / launch_price; f['green_ratio_24h'] = sum(1 for x in first24 if x['c'] > x['o']) / len(first24)
    return f

def enrich(mint, sources, hint, chain='solana'):
    rec = {'mint': mint, 'sources': sources, 'updated_at': now_ms(), 'chain': chain}
    hint = json.loads(hint) if hint else {}
    evm = chain in EVM_CHAINS
    net = EVM_CHAINS[chain][0] if evm else 'solana'
    pairs = [p for p in (get(f'{DS}/token-pairs/v1/{chain}/{mint}') or []) if (p.get('baseToken', {}).get('address') or '').lower() == mint.lower()]
    if not pairs:  # DexScreener drops dead pairs — fall back to GeckoTerminal pools
        gt = get(f'{GTB}/{net}/tokens/{mint}/pools?page=1') or {}
        for p in gt.get('data') or []:
            a = p['attributes']; dex = p['relationships']['dex']['data']['id']
            try: created_p = int(time.mktime(time.strptime(a['pool_created_at'][:19], '%Y-%m-%dT%H:%M:%S')) * 1000 - time.timezone * 1000)
            except Exception: created_p = None
            pairs.append({'dexId': {'pump-fun': 'pumpfun'}.get(dex, dex), 'pairAddress': a['address'], 'pairCreatedAt': created_p, 'liquidity': {'usd': float(a.get('reserve_in_usd') or 0)},
                          'priceUsd': a.get('base_token_price_usd'), 'fdv': float(a.get('fdv_usd') or 0) or None, 'baseToken': {'address': mint, 'symbol': hint.get('symbol') or '?', 'name': hint.get('name') or '?'},
                          'quoteToken': {'symbol': '?'}, 'info': {}, 'labels': []})
        rec['err'] = 'dexscreener: no pairs (dead); used GeckoTerminal pools' if pairs else None
    if not pairs: rec['err'] = 'no pairs on DexScreener or GeckoTerminal'; return rec, []
    curve = next((p for p in pairs if p['dexId'] in ('pumpfun', 'launchlab', 'moonshot', 'boop', 'fourmeme', 'four-meme') or 'LaunchLab' in (p.get('labels') or [])), None)
    nonc = [p for p in pairs if p is not curve] or pairs
    main = max(nonc, key=lambda p: (p.get('liquidity') or {}).get('usd') or 0)
    oldest = min(pairs, key=lambda p: p.get('pairCreatedAt') or 9e15)
    rec.update(symbol=main['baseToken']['symbol'], name=main['baseToken']['name'], main_pool=main['pairAddress'], main_dex=main['dexId'], curve_pool=curve['pairAddress'] if curve else None)
    price = float(main.get('priceUsd') or 0) or None
    fdv = main.get('fdv') or main.get('marketCap')
    rec['cur_price'] = price; rec['cur_mcap'] = fdv
    rec['cur_liq'] = sum((p.get('liquidity') or {}).get('usd') or 0 for p in pairs)
    supply = fdv / price if fdv and price else None
    if not evm and mint.endswith('pump') and (not supply or not (5e8 < supply < 1.5e9)): supply = 1e9  # pump.fun fixed supply
    ql, qknown = 0.0, False
    for p in pairs:
        qa, qs = (p.get('liquidity') or {}).get('quote') or 0, p['quoteToken']['symbol']
        if qs in ('SOL', 'WSOL') and not evm: ql += qa * sol_price(); qknown = True
        elif qs in STABLE: ql += qa; qknown = True
        elif evm and qs in ('WETH', 'ETH', 'WBNB', 'BNB') and native_usd(qs): ql += qa * native_usd(qs); qknown = True
    rec['quote_liq_usd'] = ql if qknown else None
    rec['supply'] = supply
    created = hint.get('created_ms') or oldest.get('pairCreatedAt')
    rec['created_ts'] = created
    if created:
        t = time.gmtime(created / 1000); rec['launch_hour_utc'] = t.tm_hour; rec['launch_dow'] = t.tm_wday
    lp = ('four.meme' if (curve or 'fourmeme' in sources or hint.get('gt_dex') == 'four-meme') and chain == 'bsc' else f'{chain}:{main["dexId"]}') if evm else 'pump.fun' if (hint.get('pump') or mint.endswith('pump') or (curve and curve['dexId'] == 'pumpfun')) else 'stonkfun' if hint.get('stonk') else 'letsbonk' if mint.endswith('bonk') else ('raydium-launchlab' if curve and (curve['dexId'] == 'launchlab' or 'LaunchLab' in (curve.get('labels') or [])) else (curve['dexId'] if curve else 'direct-dex'))
    if 'stonkfun' in sources: lp = 'stonkfun'
    rec['launchpad'] = lp
    if curve and main is not curve and main.get('pairCreatedAt') and curve.get('pairCreatedAt'):
        rec['curve_secs'] = (main['pairCreatedAt'] - curve['pairCreatedAt']) / 1000
    elif hint.get('graduatedAt') and hint.get('created_ms'):
        rec['curve_secs'] = (hint['graduatedAt'] - hint['created_ms']) / 1000
    # socials / meta
    info = main.get('info') or {}
    rec['n_socials_dex'] = len(info.get('websites') or []) + len(info.get('socials') or [])
    st = {s.get('type') for s in info.get('socials') or []}
    rec['has_twitter'] = int(bool(hint.get('twitter')) or 'twitter' in st)
    rec['has_telegram'] = int(bool(hint.get('telegram')) or 'telegram' in st)
    rec['has_website'] = int(bool(hint.get('website')) or bool(info.get('websites')))
    rec['reply_count'] = hint.get('replies')
    nm, sy = rec['name'] or '', rec['symbol'] or ''
    rec.update(theme=theme_of(nm, sy), ticker_len=len(sy), name_len=len(nm), name_has_digit=int(any(ch.isdigit() for ch in nm + sy)), ticker_upper=int(sy.isupper()))
    # RugCheck snapshot (CURRENT state — look-ahead for cohort analysis, flagged in UI)
    holders = []; r = None
    if evm:  # GoPlus snapshot (CURRENT state, look-ahead like RugCheck on Solana)
        try:
            g = goplus_snapshot(chain, mint) or {}
            if g:
                rec['holders_now'] = int(g['holder_count']) if g.get('holder_count') else None
                lpset = {(p.get('pairAddress') or '').lower() for p in pairs}
                hs = [h for h in g.get('holders') or [] if not (str(h.get('is_locked')) == '1' or (h.get('address') or '').lower() in lpset or (h.get('address') or '').lower().endswith('dead') or set((h.get('address') or '0x')[2:]) <= {'0'})]
                rec['top10_now'] = sum(float(h.get('percent') or 0) * 100 for h in hs[:10])
                holders = [((h.get('address') or '').lower(), float(h.get('percent') or 0) * 100) for h in hs[:20]]
                lps = g.get('lp_holders') or []
                if lps: rec['lp_locked_pct'] = sum(float(h.get('percent') or 0) * 100 for h in lps if str(h.get('is_locked')) == '1' or (h.get('address') or '').lower().endswith('dead') or set((h.get('address') or '0x')[2:]) <= {'0'})
                rec['mint_auth'] = int(g.get('is_mintable') == '1')
                rec['freeze_auth'] = int(g.get('is_blacklisted') == '1' or g.get('transfer_pausable') == '1')
                rec['rugcheck_rugged'] = int(g.get('is_honeypot') == '1' or g.get('cannot_sell_all') == '1')
                rec['dev'] = (g.get('creator_address') or '').lower() or None
                rec['insider_pct_now'] = float(g.get('creator_percent') or 0) * 100
        except Exception as e:
            rec['err'] = (rec.get('err') or '') + f' goplus: {e}'
    else:
     try:
        r = get(f'https://api.rugcheck.xyz/v1/tokens/{mint}/report')
        if r:
            supply_raw = float((r.get('token') or {}).get('supply') or 0)
            rec['holders_now'] = r.get('totalHolders')
            rec['mint_auth'] = int(bool((r.get('token') or {}).get('mintAuthority')))
            rec['freeze_auth'] = int(bool((r.get('token') or {}).get('freezeAuthority')))
            rec['rugcheck_rugged'] = int(bool(r.get('rugged')))
            known = {k for k, v in (r.get('knownAccounts') or {}).items() if v.get('type') in ('AMM', 'LOCKER')}
            known |= {m.get('pubkey') for m in r.get('markets') or []}
            th = [h for h in r.get('topHolders') or [] if h.get('owner') not in known and h.get('pct', 0) < 60]
            rec['top10_now'] = sum(h.get('pct') or 0 for h in th[:10])
            holders = [(h['owner'], h.get('pct') or 0) for h in th[:20] if h.get('owner')]
            if supply_raw: rec['insider_pct_now'] = sum(float(n.get('currentHolding') or 0) for n in r.get('insiderNetworks') or []) / supply_raw * 100
            mk = r.get('markets') or []
            if mk: rec['lp_locked_pct'] = max((m.get('lp') or {}).get('lpLockedPct') or 0 for m in mk)
            rec['dev'] = r.get('creator') or hint.get('creator')
            ct = [t for t in r.get('creatorTokens') or [] if t.get('mint') != mint and (not created or _iso(t.get('createdAt')) is None or _iso(t.get('createdAt')) < created)]
            rec['dev_prior_tokens'] = len(ct)
            rec['dev_prior_best_mcap'] = max([t.get('marketCap') or 0 for t in ct], default=0)
     except Exception as e:
        rec['err'] = (rec.get('err') or '') + f' rugcheck: {e}'
    if r and r.get('detectedAt'):
        det = _iso(r['detectedAt'])
        if det and (not created or det < created): created = det; rec['created_ts'] = created; t = time.gmtime(created / 1000); rec['launch_hour_utc'] = t.tm_hour; rec['launch_dow'] = t.tm_wday
    if r and (r.get('launchpad') or {}).get('platform') and rec['launchpad'] in ('direct-dex',):
        rec['launchpad'] = {'pump_fun': 'pump.fun', 'stonk_fun': 'stonkfun'}.get(r['launchpad']['platform'], r['launchpad']['platform'])
    # price path (GeckoTerminal) — free API only serves the last 180 days
    path = []
    if created and now_ms() - created > 178 * 86400e3:
        rec['cohort'] = 'out_of_window'; rec['err'] = 'launched >180d ago: free GeckoTerminal history unavailable'
        if not rec.get('dev'): rec['dev'] = hint.get('creator')
        return rec, holders
    try:
        if curve:
            cstart = (curve.get('pairCreatedAt') or created) / 1000
            path += ohlcv(curve['pairAddress'], 'minute', 1, before_s=min(time.time(), cstart + 1000 * 60), net=net)
        hp = oldest if (oldest is not curve and oldest is not main and (oldest.get('pairCreatedAt') or 9e15) < (main.get('pairCreatedAt') or 0)) else main
        mstart = (hp.get('pairCreatedAt') or created or now_ms()) / 1000
        if main is not curve:
            hourly = ohlcv(hp['pairAddress'], 'hour', 1, before_s=min(time.time(), mstart + 1000 * 3600), net=net)
            if path and hourly: hourly = [x for x in hourly if x['t'] > path[-1]['t']]
            path += hourly
            if time.time() - mstart > 1000 * 3600:
                daily = ohlcv(main['pairAddress'], 'day', 1, net=net)
                if path: daily = [x for x in daily if x['t'] > path[-1]['t']]
                path += daily
    except Exception as e:
        rec['err'] = f'ohlcv: {e}'
    if path:
        launch_ms = created or path[0]['t']
        lp0 = path[0]['o'] or path[0]['c']
        rec['launch_price'] = lp0
        rec.update(path_features(path, launch_ms, lp0))
        rec['vol_total'] = sum(x['v'] or 0 for x in path)
        if supply: rec['launch_mcap'] = lp0 * supply; rec['peak_mcap'] = (rec.get('peak_price') or 0) * supply
        rec['multiple'] = (rec.get('peak_price') or 0) / lp0 if lp0 else None
        if rec.get('peak_price') and price: rec['cur_vs_peak'] = price / rec['peak_price']
        if rec.get('launch_mcap') and rec.get('vol_first24h') is not None: rec['vol24_over_launch_mcap'] = rec['vol_first24h'] / rec['launch_mcap']
    # DexScreener paid orders timing
    try:
        o = get(f'{DS}/orders/v1/{chain}/{mint}') or {}
        orders = o.get('orders') or []; boosts = o.get('boosts') or []
        prof = [x['paymentTimestamp'] for x in orders if x.get('type') == 'tokenProfile' and x.get('paymentTimestamp')]
        if prof and created: rec['profile_delay_h'] = (min(prof) - created) / 3600e3
        rec['cto'] = int(any(x.get('type') == 'communityTakeover' for x in orders))
        rec['boost_count'] = len(boosts); rec['boost_total'] = sum(x.get('amount') or 0 for x in boosts)
        if boosts and created: rec['first_boost_delay_h'] = (min(x['paymentTimestamp'] for x in boosts) - created) / 3600e3
    except Exception: pass
    if not rec.get('dev'): rec['dev'] = hint.get('creator')
    rec['cohort'] = cohort(rec)
    return rec, holders

def quality(r):
    """Detect self-priced / fake-mcap tokens: tiny real (quote-side) liquidity or trivial turnover vs claimed peak."""
    why = []
    mc = r.get('cur_mcap') or 0
    if mc > 100000 and r.get('quote_liq_usd') is not None and r['quote_liq_usd'] < 0.002 * mc: why.append('quote-side liquidity <0.2% of mcap')
    if (r.get('peak_mcap') or 0) > 1e6 and (r.get('vol_total') or 0) < 0.02 * r['peak_mcap']: why.append('lifetime volume <2% of peak mcap')
    return 'suspect_fake: ' + '; '.join(why) if why else 'ok'

def cohort(r):
    if r.get('cohort') == 'out_of_window': return 'out_of_window'
    r['quality'] = quality(r)
    if r['quality'] != 'ok': return 'suspect_fake'
    m, cvp, age_d = r.get('multiple'), r.get('cur_vs_peak'), (now_ms() - (r.get('created_ts') or now_ms())) / 86400e3
    if m is None: return 'unknown'
    if m >= 100: return 'mooned'
    if (cvp is not None and cvp <= 0.1 and ((r.get('cur_liq') or 0) < 10000 or (r.get('cur_mcap') or 0) < 50000)) or r.get('rugcheck_rugged'): return 'died'
    if age_d >= 3 and m < 2 and (r.get('cur_mcap') or 0) < 10000: return 'died'  # never took off, now worthless
    if age_d < 3: return 'too_young'
    return 'middle'

COLS = None
def save(c, rec, holders):
    global COLS
    if COLS is None: COLS = [r[1] for r in c.execute('PRAGMA table_info(tokens)')]
    keys = [k for k in rec if k in COLS]
    c.execute(f'INSERT OR REPLACE INTO tokens({",".join(keys)}) VALUES({",".join("?" * len(keys))})', [rec[k] for k in keys])
    c.execute('DELETE FROM top_holders WHERE mint=?', (rec['mint'],))
    c.executemany('INSERT OR IGNORE INTO top_holders VALUES(?,?,?)', [(rec['mint'], o, p) for o, p in holders])
    c.commit()

def winner_overlap(c):
    """Leave-one-out count of a token's current top holders that also top-hold OTHER mooned tokens."""
    moon = {r[0] for r in c.execute("SELECT mint FROM tokens WHERE cohort='mooned'")}
    wm = {}
    for mint, owner in c.execute('SELECT mint, owner FROM top_holders'):
        if mint in moon: wm.setdefault(owner, set()).add(mint)
    for (mint,) in c.execute('SELECT mint FROM tokens').fetchall():
        owners = [o for (o,) in c.execute('SELECT owner FROM top_holders WHERE mint=?', (mint,))]
        n = sum(1 for o in owners if len(wm.get(o, set()) - {mint}) >= 1)
        c.execute('UPDATE tokens SET winner_overlap=? WHERE mint=?', (n if owners else None, mint))
    c.commit()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--max', type=int, default=220)
    ap.add_argument('--refresh-hours', type=float, default=12)
    ap.add_argument('--pump-mcap', type=int, default=300)
    ap.add_argument('--pump-grad', type=int, default=200)
    ap.add_argument('--pump-dead', type=int, default=500)
    ap.add_argument('--workers', type=int, default=2)
    ap.add_argument('--no-gather', action='store_true')
    ap.add_argument('--source', default='')
    ap.add_argument('--chains', default='solana', help='comma list: solana,base,bsc,ethereum or all')
    ap.add_argument('--gt-pages', type=int, default=3)
    args = ap.parse_args()
    c = db()
    chains = list(EVM_CHAINS) + ['solana'] if args.chains == 'all' else args.chains.split(',')
    if not args.no_gather:
        if 'solana' in chains:
            try: gather(c, args)
            except Exception as e: log('gather error', e)
        if any(ch in EVM_CHAINS for ch in chains):
            try: gather_evm(c, args)
            except Exception as e: log('gather_evm error', e)
    cutoff = now_ms() - args.refresh_hours * 3600e3
    qs = ','.join('?' * len(chains))
    todo = c.execute(f'''SELECT cd.mint, cd.sources, cd.hint, COALESCE(cd.chain,'solana') AS chain FROM candidates cd LEFT JOIN tokens t ON t.mint=cd.mint
                        WHERE (t.mint IS NULL OR t.updated_at < ?) AND cd.sources LIKE ? AND COALESCE(cd.chain,'solana') IN ({qs}) ORDER BY (t.mint IS NOT NULL), cd.added_at LIMIT ?''', (cutoff, f'%{args.source}%', *chains, args.max)).fetchall()
    # balance sources so the sample isn't all one feed
    log('to enrich:', len(todo))
    def work(row):
        try: return enrich(row['mint'], row['sources'], row['hint'], row['chain'])
        except Exception as e: return ({'mint': row['mint'], 'sources': row['sources'], 'chain': row['chain'], 'err': str(e)[:200], 'updated_at': now_ms(), 'cohort': 'unknown'}, [])
    done = 0
    with ThreadPoolExecutor(args.workers) as ex:
        for rec, holders in ex.map(work, todo):
            save(c, rec, holders); done += 1
            if done % 10 == 0: log(f'{done}/{len(todo)} last={rec.get("symbol")} cohort={rec.get("cohort")} x{(rec.get("multiple") or 0):.1f}')
    winner_overlap(c)
    log('done', done, 'tokens total', c.execute('SELECT COUNT(*) FROM tokens').fetchone()[0])

if __name__ == '__main__':
    main()
