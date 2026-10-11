#!/usr/bin/env python3
"""Perp Desk research job: settled-funding baselines (per token, per venue) and daily-candle volatility (ATR14, RV30)
for every token in data/perps_universe.json (written by lib/perps.js). Output: data/perps_stats.json.
Free public endpoints only (no keys): Binance USDT-M fapi (www.binance.com mirror when fapi.binance.com is geo-blocked),
OKX v5 public, Hyperliquid info, Gate.io v4. Bybit is attempted by the live module and is geo-blocked from US boxes.
Estimates from public data, not financial advice."""
import json, os, time, math, statistics, urllib.request
from concurrent.futures import ThreadPoolExecutor
from common import DATA_DIR

UA = {'user-agent': 'Mozilla/5.0 (asymmetric-terminal research)', 'accept': 'application/json'}
def get(url, body=None, timeout=25):
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers={**UA, **({'content-type': 'application/json'} if body else {})}, data=json.dumps(body).encode() if body else None)
            return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
        except urllib.error.HTTPError as e:
            if e.code in (451, 403, 404, 400): raise
            if i == 2: raise
            time.sleep(2 * (i + 1))
        except Exception:
            if i == 2: raise
            time.sleep(2 * (i + 1))

BN = None
def binance_base():
    global BN
    if BN: return BN
    for b in ('https://fapi.binance.com', 'https://www.binance.com'):
        try: get(f'{b}/fapi/v1/time'); BN = b; return b
        except Exception: pass
    BN = 'https://www.binance.com'; return BN

DAYS = 30
def ann(rate, h): return rate * (24 / h) * 365 * 100

def fund_binance(c, iv):
    d = get(f'{binance_base()}/fapi/v1/fundingRate?symbol={c}&limit=1000&startTime={int((time.time() - DAYS * 86400) * 1000)}')
    return [ann(float(x['fundingRate']), iv) for x in d]
def fund_okx(c, iv):
    d = get(f'https://www.okx.com/api/v5/public/funding-rate-history?instId={c}&limit=100')['data']
    cutoff = (time.time() - DAYS * 86400) * 1000
    return [ann(float(x['realizedRate'] or x['fundingRate']), iv) for x in d if int(x['fundingTime']) >= cutoff]
def fund_hl(c, iv):
    out, start = [], int((time.time() - DAYS * 86400) * 1000)
    for _ in range(3):  # 500 rows per call, hourly funding
        d = get('https://api.hyperliquid.xyz/info', {'type': 'fundingHistory', 'coin': c, 'startTime': start})
        if not d: break
        out += [ann(float(x['fundingRate']), 1) for x in d]
        if len(d) < 500: break
        start = d[-1]['time'] + 1
    return out
def fund_gate(c, iv):
    d = get(f'https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract={c}&limit=200')
    cutoff = time.time() - DAYS * 86400
    return [ann(float(x['r']), iv) for x in d if x['t'] >= cutoff]
FUND = {'binance': fund_binance, 'okx': fund_okx, 'hyperliquid': fund_hl, 'gate': fund_gate}

def candles(v):  # -> (src, [(t, o, h, l, c, vol_usd)]) daily, oldest first, prices per coin
    if 'binance' in v:
        c, m = v['binance']['contract'], v['binance'].get('mult', 1)
        try:
            d = get(f'{binance_base()}/fapi/v1/klines?symbol={c}&interval=1d&limit=200')
            return 'binance', [(x[0], float(x[1]) / m, float(x[2]) / m, float(x[3]) / m, float(x[4]) / m, float(x[7])) for x in d]
        except Exception: pass
    if 'okx' in v:
        c, m = v['okx']['contract'], v['okx'].get('mult', 1)
        try:
            d = get(f'https://www.okx.com/api/v5/market/history-candles?instId={c}&bar=1Dutc&limit=100')['data']
            if d:
                d2 = get(f'https://www.okx.com/api/v5/market/history-candles?instId={c}&bar=1Dutc&limit=100&after={d[-1][0]}')['data']
                rows = sorted(d + d2, key=lambda x: int(x[0]))
                return 'okx', [(int(x[0]), float(x[1]) / m, float(x[2]) / m, float(x[3]) / m, float(x[4]) / m, float(x[7]) * float(x[4]) / m if len(x) > 7 else 0) for x in rows]
        except Exception: pass
    if 'hyperliquid' in v:
        c, m = v['hyperliquid']['contract'], v['hyperliquid'].get('mult', 1)
        try:
            now = int(time.time() * 1000)
            d = get('https://api.hyperliquid.xyz/info', {'type': 'candleSnapshot', 'req': {'coin': c, 'interval': '1d', 'startTime': now - 200 * 86400000, 'endTime': now}})
            return 'hyperliquid', [(x['t'], float(x['o']) / m, float(x['h']) / m, float(x['l']) / m, float(x['c']) / m, float(x['v']) * float(x['c'])) for x in d]
        except Exception: pass
    if 'gate' in v:
        c, m = v['gate']['contract'], v['gate'].get('mult', 1)
        try:
            d = get(f'https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract={c}&interval=1d&limit=200')
            return 'gate', [(x['t'] * 1000, float(x['o']) / m, float(x['h']) / m, float(x['l']) / m, float(x['c']) / m, float(x.get('sum', 0) or 0)) for x in d]
        except Exception: pass
    return None, []

def one(tok):
    sym, v = tok['sym'], tok['venues']
    out = {'funding': {}, 'errors': {}}
    for ven, info in v.items():
        if ven not in FUND: continue
        try:
            xs = FUND[ven](info['contract'], info.get('intervalH') or 8)
            if len(xs) >= 5:
                s = sorted(xs)
                out['funding'][ven] = {'n': len(xs), 'mean': statistics.fmean(xs), 'sd': statistics.pstdev(xs), 'p5': s[int(0.05 * (len(s) - 1))], 'p95': s[int(0.95 * (len(s) - 1))], 'last': xs[-1] if ven != 'okx' else xs[0], 'days': DAYS}
        except Exception as e:
            out['errors'][ven] = str(e)[:120]
    src, k = candles(v)
    k = [r for r in k if r[4] > 0]
    full = k[:-1] if k and k[-1][0] > (time.time() - 86400) * 1000 else k  # drop today's partial candle for ATR/RV
    if len(full) >= 15:
        trs = []
        for i in range(1, len(full)):
            h, l, pc = full[i][2], full[i][3], full[i - 1][4]
            trs.append(max(h - l, abs(h - pc), abs(l - pc)))
        atr = statistics.fmean(trs[-14:])
        lr = [math.log(full[i][4] / full[i - 1][4]) for i in range(max(1, len(full) - 30), len(full))]
        out.update({'candleSrc': src, 'days': len(k), 'atr14': atr, 'atrPct': atr / full[-1][4] * 100, 'rv30': statistics.pstdev(lr) * math.sqrt(365) * 100 if len(lr) > 5 else None,
                    'close': k[-1][4], 'closes': [round(r[4], 10) for r in k], 'vols': [round(r[5]) for r in k], 'lastCandle': k[-1][0]})
    return sym, out

def main():
    U = json.load(open(os.path.join(DATA_DIR, 'perps_universe.json')))['tokens']
    t0 = time.time()
    with ThreadPoolExecutor(5) as ex: res = dict(ex.map(one, U))
    out = {'generatedAt': int(time.time() * 1000), 'elapsed_s': round(time.time() - t0), 'binanceRoute': binance_base(), 'fundingWindowDays': DAYS,
           'method': 'Funding annualized = rate x (24/interval h) x 365, in %/yr. z-score baseline = mean/stdev of settled rates over the last 30 days per venue. ATR14 = mean true range of last 14 daily candles.',
           'tokens': res}
    tmp = os.path.join(DATA_DIR, 'perps_stats.json.tmp'); json.dump(out, open(tmp, 'w')); os.replace(tmp, os.path.join(DATA_DIR, 'perps_stats.json'))
    print(f"perps_stats: {len(res)} tokens, {sum(1 for x in res.values() if x.get('atrPct'))} with ATR, {sum(len(x['funding']) for x in res.values())} venue baselines in {out['elapsed_s']}s")

if __name__ == '__main__': main()
