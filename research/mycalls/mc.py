#!/usr/bin/env python3
"""Martin's Calls: shared helpers (free sources only, everything cached under research/mycalls/cache).

Prices
  - live price at call time: DexScreener /tokens/v1 (deepest-liquidity pair), same order as lib/liveprice.js; GeckoTerminal fallback
    is the guarded hourly candle (below), never GeckoTerminal's raw USD for a non-SOL/USDC/USDT/WETH/USDG quoted pool.
  - candles: GeckoTerminal hourly OHLCV of the token's deepest pool. If the pool is quoted in anything but SOL/USDC/USDT/WETH/USDG
    (CYPHERCAT/CYPH, MICRODUCK/NVDA: tokenized stocks) the USD series is ALWAYS rebuilt as quote-denominated candles x the quote
    token's own USD close for that hour (its deepest safe-quoted pool): the research/waking/ bad-USD guard, hourly. GeckoTerminal's
    USD candles for such pools can sit flat/stale for hours (CYPHERCAT read ~$0.00065 on Oct 21 while it traded ~$0.00085).
Pure scoring functions live in score.py so the tests can run them on synthetic bars."""
import json, os, sys, time, hashlib, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
DATA = os.environ.get('DATA_DIR', os.path.join(ROOT, 'data'))
CACHE = os.path.join(HERE, 'cache')
CALLS_F = os.path.join(DATA, 'martin_calls.json'); OUT_F = os.path.join(DATA, 'martin_calls_scored.json')
GT = 'https://api.geckoterminal.com/api/v2'
PT = ZoneInfo('America/Los_Angeles'); HOUR = 3600; DAY = 86400
NET = {'solana': 'solana', 'robinhood': 'robinhood', 'ethereum': 'eth', 'base': 'base', 'bsc': 'bsc', 'arbitrum': 'arbitrum'}
# quotes whose USD conversion GeckoTerminal gets right (addresses, plus symbols for chains without a list here)
SAFE_ADDR = {'So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
             '0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0x5fc5360d0400a0fd4f2af552add042d716f1d168'}  # Robinhood WETH, USDG
SAFE_SYM = {'SOL', 'WSOL', 'USDC', 'USDT', 'WETH', 'ETH', 'USDG', 'DAI', 'WBNB', 'BNB', 'USD1', 'PYUSD'}
UA = {'accept': 'application/json', 'user-agent': 'asymmetric-terminal/mycalls (+read-only)'}
CALLS = {'gt': 0, 'ds': 0, 'cache': 0, 'fail': 0}; _last = [0.0]; OFFLINE = [False]  # OFFLINE[0]: cache only, no network

def http(url, gt=True, tries=4):
    if OFFLINE[0]: return None
    for k in range(tries):
        if gt:
            w = _last[0] + 2.2 - time.time()
            if w > 0: time.sleep(w)
            _last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25) as r:
                CALLS['gt' if gt else 'ds'] += 1; return json.load(r)
        except Exception as e:
            code = getattr(e, 'code', None)
            if code == 404: return None
            time.sleep(10 * (k + 1) if code == 429 else 2)
    CALLS['fail'] += 1; return None

def cached(name, ttl, fn):
    p = os.path.join(CACHE, name)
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < ttl:
        CALLS['cache'] += 1
        with open(p) as f: return json.load(f), os.path.getmtime(p)
    v = fn()
    if v is not None:
        os.makedirs(CACHE, exist_ok=True); t = p + '.tmp'
        with open(t, 'w') as f: json.dump(v, f)
        os.replace(t, p); return v, time.time()
    if os.path.exists(p):  # upstream failed: fall back to the stale copy, flagged by its mtime
        with open(p) as f: return json.load(f), os.path.getmtime(p)
    return None, None

def same(chain, a, b): return (a or '') == (b or '') if chain == 'solana' else (a or '').lower() == (b or '').lower()
def pt_str(ts): return datetime.fromtimestamp(ts, PT).strftime('%b %-d, %Y %-I:%M %p PT')

def parse_time(s):
    """'now' | ISO with offset | 'YYYY-MM-DD HH:MM' (Pacific) | 'HH:MM AM' today (Pacific) -> unix seconds."""
    s = (s or 'now').strip()
    if s.lower() == 'now': return int(time.time())
    try:
        d = datetime.fromisoformat(s.replace('Z', '+00:00'))
        return int((d if d.tzinfo else d.replace(tzinfo=PT)).timestamp())
    except ValueError: pass
    for fmt in ('%Y-%m-%d %I:%M %p', '%Y-%m-%d %I:%M%p', '%I:%M %p', '%I:%M%p', '%H:%M'):
        try:
            d = datetime.strptime(s.upper(), fmt)
            if d.year == 1900: n = datetime.now(PT); d = d.replace(year=n.year, month=n.month, day=n.day)
            return int(d.replace(tzinfo=PT).timestamp())
        except ValueError: continue
    raise ValueError('unrecognised time: ' + s)

def _pools(d):
    out = []
    lst = (d or {}).get('data') or []
    if isinstance(lst, dict): lst = [lst]
    for p in lst:
        a = p['attributes']; rel = p.get('relationships', {})
        rid = lambda k: (((rel.get(k) or {}).get('data') or {}).get('id') or '').split('_', 1)[-1]
        name = a.get('name') or ''
        out.append({'pool': a['address'], 'name': name, 'base': rid('base_token'), 'quote': rid('quote_token'), 'liq': float(a.get('reserve_in_usd') or 0),
                    'quoteSym': (name.split('/')[1].strip().split(' ')[0].upper() if '/' in name else '')})
    return out

def is_safe(p): return p.get('quote') in SAFE_ADDR or (p.get('quote') or '').lower() in SAFE_ADDR or p.get('quoteSym') in SAFE_SYM

def resolve_pool(chain, token, pool=None):
    """Deepest pool with the token as base (or the pinned pool). Cached 7 days."""
    net = NET.get(chain, chain)
    if pool:
        d, _ = cached(f'pool_{chain}_{pool.lower()}.json', 7 * DAY, lambda: http(f'{GT}/networks/{net}/pools/{pool}'))
        ps = _pools(d)
        if ps: return ps[0]
    d, _ = cached(f'tokpools_{chain}_{token.lower()}.json', 7 * DAY, lambda: http(f'{GT}/networks/{net}/tokens/{token}/pools?page=1'))
    ps = sorted([p for p in _pools(d) if same(chain, p['base'], token)], key=lambda p: -p['liq'])
    return ps[0] if ps else None

def _rows(d):
    try: return sorted([[int(r[0])] + [float(x or 0) for x in r[1:6]] for r in d['data']['attributes']['ohlcv_list'] if r[4]])
    except Exception: return []

def hourly(chain, pool, currency, before=None, ttl=3 * HOUR):
    net = NET.get(chain, chain); b = f'&before_timestamp={int(before)}' if before else ''
    name = f'h1_{chain}_{pool.lower()}_{currency}{"_b" + str(int(before)) if before else ""}.json'
    d, at = cached(name, ttl if not before or before > time.time() - HOUR else 400 * DAY,
                   lambda: http(f'{GT}/networks/{net}/pools/{pool}/ohlcv/hour?aggregate=1&limit=1000&currency={currency}&token=base{b}'))
    return _rows(d), at, (d or {}).get('meta')

def usd_series(chain, token, pool_pin=None, before=None):
    """-> {'bars': [[t,o,h,l,c,v_usd]...] hourly, 'fetchedAt': unix s, 'pool': {...}, 'how': str, 'guard': {...}|None} or None."""
    p = resolve_pool(chain, token, pool_pin)
    if not p: return None
    usd, at_u, meta = hourly(chain, p['pool'], 'usd', before)
    if meta and meta.get('quote'):
        q = meta['quote']; p['quoteSym'] = (q.get('symbol') or p.get('quoteSym') or '').upper(); p['quote'] = q.get('address') or p['quote']
    if is_safe(p):
        return {'bars': usd, 'fetchedAt': at_u, 'pool': p, 'how': f'GeckoTerminal hourly USD candles, pool {p["name"]}', 'guard': None}
    tok, at_t, _ = hourly(chain, p['pool'], 'token', before)
    # the quote token's deepest SAFE-quoted pool
    net = NET.get(chain, chain)
    d, _ = cached(f'tokpools_{chain}_{p["quote"].lower()}.json', 7 * DAY, lambda: http(f'{GT}/networks/{net}/tokens/{p["quote"]}/pools?page=1'))
    qs = sorted([x for x in _pools(d) if same(chain, x['base'], p['quote']) and is_safe(x)], key=lambda x: -x['liq'])
    if not tok or not qs:
        return {'bars': [], 'fetchedAt': at_t, 'pool': p, 'how': 'excluded: quoted in a non-SOL/USDC token and no quote-denominated or quote-USD series (GeckoTerminal USD for such pools can be stale)', 'guard': None}
    qusd, at_q, _ = hourly(chain, qs[0]['pool'], 'usd', before)
    qc = {r[0]: r[4] for r in qusd}
    out = []
    for r in tok:
        k = r[0]
        while k not in qc and k > r[0] - 12 * HOUR: k -= HOUR
        if k in qc: m = qc[k]; out.append([r[0], r[1] * m, r[2] * m, r[3] * m, r[4] * m, r[5] * m])
    gt = {r[0]: r[4] for r in usd}; tail = out[-48:]
    diffs = [abs(r[4] / gt[r[0]] - 1) for r in tail if gt.get(r[0])]
    ur = usd[-25:]; flat = sum(1 for x, y in zip(ur, ur[1:]) if x[4] and abs(y[4] / x[4] - 1) < 0.001)
    guard = {'quotePool': qs[0]['pool'], 'quotePoolName': qs[0]['name'], 'gtUsdMaxDiffLast48hPct': round(100 * max(diffs), 1) if diffs else None, 'gtUsdFlatHoursLast24': flat}
    return {'bars': out, 'fetchedAt': min(x for x in (at_t, at_q) if x), 'pool': p, 'guard': guard,
            'how': f'USD rebuilt hourly: {p["name"]} candles in {p["quoteSym"] or "quote"} x {qs[0]["name"]} USD close (bad-USD guard for non-SOL/USDC quotes)'}

def dexscreener(chain, tokens):
    """Live USD per token, deepest-liquidity pair (lib/liveprice.js order). One request per 30 tokens; never cached long (60 s)."""
    out = {}
    for i in range(0, len(tokens), 30):
        c = tokens[i:i + 30]
        d, _ = cached(f'ds_{chain}_{hashlib.md5(",".join(c).encode()).hexdigest()[:12]}.json', 60, lambda: http(f'https://api.dexscreener.com/tokens/v1/{chain}/{",".join(c)}', gt=False))
        best = {}
        for p in d if isinstance(d, list) else []:
            ba = (p.get('baseToken') or {}).get('address') or ''
            k = next((t for t in c if same(chain, t, ba)), None)
            try: px = float(p.get('priceUsd') or 0)
            except ValueError: px = 0
            if not k or px <= 0: continue
            liq = float((p.get('liquidity') or {}).get('usd') or 0)
            if k not in best or liq > best[k][0]: best[k] = (liq, px, p.get('pairAddress'))
        for k, (liq, px, pair) in best.items(): out[k] = {'usd': px, 'src': 'DexScreener', 'pair': pair, 'liqUsd': round(liq)}
    return out

def load_calls():
    try:
        with open(CALLS_F) as f: return json.load(f)
    except FileNotFoundError: return {'version': 1, 'calls': []}

def save_json(path, obj):
    t = path + '.tmp'
    with open(t, 'w') as f: json.dump(obj, f, indent=1)
    os.replace(t, path)
