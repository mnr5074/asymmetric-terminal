"""Derive Desk reference data (slow-moving inputs for lib/derive.js). Stdlib only, keyless, read-only.

Writes data/derive_ref.json with:
  rv        realized vol per Derive underlying (30d / 90d close-to-close, annualized, 365d) with the source used
            (Coinbase daily candles when the product exists and its price matches Derive's index within 15%,
             else Derive's own perp daily candles via public/get_tradingview_chart_data)
  dvol      Deribit DVOL (30d implied-vol index) daily history for BTC and ETH, ~400 days (external IV benchmark)
  drv       DRV token price/market data (CoinGecko id 'derive', contract cross-checked with DexScreener)
  programs  Derive maker programs from public/get_maker_programs (official API) + reward/emission facts parsed live
            from the official docs pages (URL + page updatedAt kept as citation)
Sources verified 2026-10-11: api.derive.xyz/v3 (Derive v3 JSON-RPC over HTTP POST). NOTE: the legacy
api.lyra.finance host still answers but its index prices were ~2.8% off spot on 2026-10-11, so it is not used here.
"""
import json, os, re, time, math, datetime as dt, urllib.request, urllib.error
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data')
OUT = os.path.join(DATA_DIR, 'derive_ref.json')
API = 'https://api.derive.xyz/v3/public/'
UA = {'user-agent': 'Mozilla/5.0 (asymmetric-terminal research, read-only)', 'accept': 'application/json', 'content-type': 'application/json'}
CB_MAP = {'XAUT': 'PAXG-USD'}  # tokenized gold: PAXG is the liquid Coinbase proxy (price check below guards it)

def http(url, body=None, timeout=25, raw=False, retries=2):
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=UA, method='POST' if body is not None else 'GET')
            with urllib.request.urlopen(req, timeout=timeout) as r:
                b = r.read().decode('utf8', 'ignore')
                return b if raw else json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and i < retries: time.sleep(3 * (i + 1)); continue
            if e.code == 404: return None
            raise
        except Exception:
            if i < retries: time.sleep(2 * (i + 1)); continue
            raise

def rpc(method, params):
    d = http(API + method, params)
    if not d or 'error' in d: raise RuntimeError(f'{method}: {d and d.get("error")}')
    return d['result']

def rv_from_closes(cl, n):
    cl = [c for c in cl if c and c > 0]
    if len(cl) < n + 1: n = len(cl) - 1
    if n < 10: return None
    r = [math.log(cl[i] / cl[i - 1]) for i in range(len(cl) - n, len(cl))]
    m = sum(r) / len(r)
    return math.sqrt(sum((x - m) ** 2 for x in r) / (len(r) - 1) * 365)

def derive_currencies():
    cur = rpc('get_all_currencies', {})
    out = {}
    for c in cur:
        if c.get('option') or 'option' in (c.get('instrument_types') or []): out[c['currency']] = float(c.get('spot_price') or 0) or None
    return out

def coinbase_closes(sym, index_px):
    prod = CB_MAP.get(sym, f'{sym}-USD')
    try:
        d = http(f'https://api.exchange.coinbase.com/products/{prod}/candles?granularity=86400')
        if not isinstance(d, list) or len(d) < 40: return None, None
        d = sorted(d, key=lambda x: x[0])
        if time.time() - d[-1][0] > 3 * 86400: return None, f'{prod} stale'
        cl = [x[4] for x in d]
        if index_px and abs(cl[-1] / index_px - 1) > 0.15: return None, f'{prod} rejected (price {cl[-1]:.4g} vs Derive index {index_px:.4g})'
        return cl, f'Coinbase {prod} daily'
    except Exception as e: return None, None

def derive_perp_closes(sym):
    end = int(time.time()); start = end - 120 * 86400
    try:
        d = rpc('get_tradingview_chart_data', {'instrument_name': f'{sym}-PERP', 'start_timestamp': start, 'end_timestamp': end, 'period': 86400})
        d = sorted(d, key=lambda x: x['timestamp'])
        cl = [float(x['close_price']) for x in d]
        return (cl, f'Derive {sym}-PERP daily trades') if len(cl) >= 20 else (None, None)
    except Exception: return None, None

def dvol(cur):
    end = int(time.time() * 1000); start = end - 400 * 86400000
    d = http(f'https://www.deribit.com/api/v2/public/get_volatility_index_data?currency={cur}&start_timestamp={start}&end_timestamp={end}&resolution=1D')
    pts = (d or {}).get('result', {}).get('data') or []
    return [[p[0], p[4]] for p in pts]  # [ms, close DVOL %]

def drv_token():
    out = {'coingecko_id': 'derive'}
    d = http('https://api.coingecko.com/api/v3/coins/derive?localization=false&tickers=false&community_data=false&developer_data=false')
    m = d['market_data']
    out.update({'symbol': d['symbol'].upper(), 'name': d['name'], 'price': m['current_price']['usd'], 'mcap': m['market_cap']['usd'], 'fdv': (m.get('fully_diluted_valuation') or {}).get('usd'),
                'vol24': m['total_volume']['usd'], 'ch24': m.get('price_change_percentage_24h'), 'ch7d': m.get('price_change_percentage_7d'), 'ath': m['ath']['usd'], 'ath_date': m['ath_date']['usd'],
                'circ': m.get('circulating_supply'), 'total_supply': m.get('total_supply'), 'contracts': d.get('platforms') or {}, 'cg_updated': d.get('last_updated'), 'source': 'https://www.coingecko.com/en/coins/derive'})
    eth = (out['contracts'] or {}).get('ethereum')
    if eth:
        ds = http(f'https://api.dexscreener.com/latest/dex/tokens/{eth}') or {}
        pairs = sorted([p for p in ds.get('pairs') or [] if (p.get('baseToken') or {}).get('address', '').lower() == eth.lower()], key=lambda p: -((p.get('liquidity') or {}).get('usd') or 0))
        if pairs:
            p = pairs[0]
            out['dex'] = {'pair': p.get('url'), 'dex': p.get('dexId'), 'chain': p.get('chainId'), 'price': float(p.get('priceUsd') or 0), 'liq': (p.get('liquidity') or {}).get('usd'), 'vol24': (p.get('volume') or {}).get('h24'), 'symbol': p['baseToken']['symbol']}
    return out

def doc(url):
    try: return http(url, raw=True) or ''
    except Exception: return ''

def programs():
    now = time.time() * 1000
    mp = rpc('get_maker_programs', {})
    cur = [p for p in mp if p['start_timestamp'] <= now < p['end_timestamp']]
    nxt = [p for p in mp if p['start_timestamp'] > now]
    iso = lambda ms: dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    maker = [{'name': p['name'], 'asset_types': p['asset_types'], 'currencies': p['currencies'], 'min_notional': float(p['min_notional']), 'start': iso(p['start_timestamp']), 'end': iso(p['end_timestamp']),
              'rewards': {k: float(v) for k, v in (p.get('rewards') or {}).items() if float(v)}} for p in cur]
    facts = []
    # Retail trading rewards (legacy docs; v3 docs no longer host the page) — parse live, keep updatedAt
    def page(url, label, pats):
        t = doc(url)
        upd = (re.search(r'updatedAt:\s*(\S+)', t) or [None, None])[1]
        found = {}
        for k, rx in pats.items():
            m = re.search(rx, t, flags=re.I | re.S)
            found[k] = re.sub(r'\s+', ' ', m.group(1)).strip() if m else None
        facts.append({'label': label, 'url': url.replace('.md', ''), 'updatedAt': upd, 'ok': bool(t), **found})
    page('https://legacy.docs.derive.xyz/docs/retail-trading-rewards-program.md', 'Retail Trading Rewards Program', {
        'allocation': r'(Rewards are distributed on a pro-rata basis according to the fees you pay\.)', 'epoch': r'(At the end of each weekly epoch, rewards are allocated proportionally based on the fees you\s*paid\.)',
        'token': r'Rewards are paid out in \*?\*?(stDRV)', 'audit': r'(All trading activity is subject to an audit before rewards are finalized\.[^\n]*)', 'payout': r'(Typically, rewards are paid out one week after the epoch ends\.)'})
    page('https://legacy.docs.derive.xyz/docs/token.md', 'DRV token & emissions', {
        'trading_pool': r'Weekly Emission Pool\*?\*?:\s*([^\n]+)', 'trading_pool_table': r'Protocol Incentives\s*\|\s*([^|\n]+)', 'staking_weekly': r'Weekly Rewards\*?\*?:\s*([^\n]+)', 'buybacks': r'Revenue Buybacks\s*\|\s*([^|\n]+)',
        'unstake': r'Staking Token\s*\|\s*([^|\n]+)'})
    page('https://legacy.docs.derive.xyz/docs/staking-rewards-program.md', 'Staking Rewards Program', {'staking_weekly': r'\((currently [^)]+)\)'})
    page('https://docs.derive.xyz/integrators/programs/institutional-trading-rewards.md', 'Institutional Trading Rewards (market makers)', {
        'usdc_pool': r'Up to \*\*\\?\$?([\d,]+ USDC exchange rebates per 28-day epoch)', 'drv_pool': r'\*\*(1M DRV)\*\* rewards are distributed', 'wash': r'(Wash trading is strictly prohibited[^.]*\.)',
        'obligations': r'(\*\*28-day notional trading volume:\*\* [^\n]+)'})
    page('https://docs.derive.xyz/integrators/trading/trading-fees.md', 'Trading fees', {'option_taker': r'\| Option \| `([^`]+)`', 'option_maker': r'\| Option \| `[^`]+` \| `([^`]+)`', 'perp_taker': r'\| Perp \| `([^`]+)`', 'perp_maker': r'\| Perp \| `[^`]+` \| `([^`]+)`',
        'rfq': r'(2-leg option spreads[^\n]+)'})
    # pool size for the retail trading program: prefer the explicit "50,000 stDRV weekly for trading programs" figure
    pool = None
    for f in facts:
        for k in ('trading_pool_table', 'trading_pool'):
            v = f.get(k)
            if v:
                m = re.search(r'([\d,]+)\s*(st)?DRV', v)
                if m: pool = {'amount': float(m.group(1).replace(',', '')), 'token': ('stDRV' if m.group(2) else 'DRV'), 'text': v, 'url': f['url'], 'updatedAt': f['updatedAt'], 'caveat': 'Docs say "up to"; the actual weekly amount is shown only in the app (app.derive.xyz/rewards) and is not available from a public API we could find.'}; break
        if pool: break
    return {'maker_current': maker, 'maker_next_count': len(nxt), 'maker_source': 'https://docs.derive.xyz/api-reference/maker-scoring/publicget_maker_programs (api.derive.xyz/v3/public/get_maker_programs)', 'facts': facts, 'retail_pool_weekly': pool}

def main():
    t0 = time.time(); log = []
    out = {'generatedAt': int(time.time() * 1000), 'errors': []}
    try:
        curs = derive_currencies()
    except Exception as e:
        curs = {}; out['errors'].append(f'currencies: {e}')
    rv = {}
    for sym, px in sorted(curs.items()):
        cl, src = coinbase_closes(sym, px)
        note = None
        if not cl:
            note = src; cl, src = derive_perp_closes(sym)
        rv[sym] = {'rv30': rv_from_closes(cl, 30) if cl else None, 'rv90': rv_from_closes(cl, 90) if cl else None, 'rv7': rv_from_closes(cl, 7) if cl and len(cl) > 8 else None, 'days': len(cl) if cl else 0, 'source': src, 'note': note}
    out['rv'] = rv
    out['dvol'] = {}
    for c in ('BTC', 'ETH'):
        try: out['dvol'][c] = dvol(c)
        except Exception as e: out['errors'].append(f'dvol {c}: {e}')
    out['dvol_source'] = 'Deribit DVOL index (public/get_volatility_index_data, 1D close) — external 30-day implied-vol benchmark'
    try: out['drv'] = drv_token()
    except Exception as e: out['drv'] = None; out['errors'].append(f'drv: {e}')
    try: out['programs'] = programs()
    except Exception as e: out['programs'] = None; out['errors'].append(f'programs: {e}')
    out['elapsedSec'] = round(time.time() - t0, 1)
    tmp = OUT + '.tmp'
    with open(tmp, 'w') as f: json.dump(out, f)
    os.replace(tmp, OUT)
    print(f"derive_desk: rv {sum(1 for v in rv.values() if v['rv30'])}/{len(rv)}, dvol {list(out['dvol'])}, drv {out['drv'] and out['drv'].get('price')}, errors {out['errors']} in {out['elapsedSec']}s")

if __name__ == '__main__':
    main()
