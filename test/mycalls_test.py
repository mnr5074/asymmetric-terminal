#!/usr/bin/env python3
"""python3 test/mycalls_test.py : Martin's Calls scoring on synthetic hourly bars: horizons only 'done' after they end, max gain /
drawdown / 2x / -50% on closes after the call, Gibi 'stay out' = 0% unless its own trigger fires (entry at that 4h close, walk-away
exit), walk-away before entry ends the watch, chain-median baseline, 'too few calls to judge' below 20, honest strength labels, and
the non-SOL/USDC bad-USD guard (USD rebuilt from quote-denominated candles x quote USD)."""
import os, sys, json, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'research', 'mycalls'))
import score as S, mc
H, D = 3600, 86400
T0 = 1792572360  # Oct 21 2026 01:46 PT
def bars(prices, start=(T0 // H) * H - 5 * H):
    return [[start + i * H, p, p, p, p, 100.0] for i, p in enumerate(prices)]

# --- horizon: only 'done' after it ends; window starts with the first full hour after the call ---
b = bars([1.0] * 6 + [1.5, 2.2, 0.4] + [1.1] * 40)
r = S.horizon(b, T0, 1.0, D, T0 + 10 * H)
assert not r['done'] and abs(r['ret'] - 0.1) < 1e-9, r
assert r['hit2x'] and r['drop50'] and abs(r['maxGain'] - 1.2) < 1e-9 and abs(r['maxDD'] + 0.6) < 1e-9
r = S.horizon(b, T0, 1.0, D, T0 + 2 * D); assert r['done'] and r['endAt'] == T0 + D
assert S.horizon(b, T0, 1.0, D, T0 - H).get('pending')
# the bar the call fell inside never counts (its close may predate the call)
b2 = bars([1.0] * 5 + [9.0] + [1.0] * 30); assert not S.horizon(b2, T0, 1.0, D, T0 + 2 * D)['hit2x']

# --- Gibi: stay out = 0% unless the trigger fires; entry at that 4h close; walk-away exit; walk-away before entry ends the watch ---
g = {'verdict': 'stay out', 'entryTrigger': {'tf': '4h', 'closeAbove': 1.2}}
flat = bars([1.0] * 200)
x = S.gibi_horizon(flat, T0, 1.0, g, 7 * D, T0 + 8 * D); assert x['done'] and not x['entered'] and x['ret'] == 0.0
up = bars([1.0] * 20 + [1.3] * 30 + [1.56] * 200)
x = S.gibi_horizon(up, T0, 1.0, g, 7 * D, T0 + 8 * D); assert x['entered'] and abs(x['entryPx'] - 1.3) < 1e-9 and abs(x['ret'] - 0.2) < 1e-9 and x['entryAt'] % (4 * H) == 0, x
gw = {**g, 'walkAway': {'tf': '1d', 'closeBelow': 0.5}}
dn = bars([1.0] * 20 + [1.3] * 30 + [0.4] * 200)
x = S.gibi_horizon(dn, T0, 1.0, gw, 7 * D, T0 + 8 * D); assert x['exitWhy'] == 'walk-away' and abs(x['exitPx'] - 0.4) < 1e-9
dead = bars([0.4] * 60 + [2.0] * 200)
x = S.gibi_horizon(dead, T0, 1.0, gw, 7 * D, T0 + 8 * D); assert not x['entered'] and 'walk-away' in x['why'], x
x = S.gibi_horizon(up, T0, 1.0, {'verdict': 'buy starter'}, 7 * D, T0 + 8 * D); assert x['entered'] and abs(x['ret'] - 0.56) < 1e-9

# --- baseline: chain median over the same window, tradable tokens only, called token excluded ---
d0 = T0 // D - 40
ser = {f't{k}': (d0, [1.0] * 40 + [1.0 + k / 10] * 10, [10000.0] * 50) for k in range(20)}
ser['illiquid'] = (d0, [1.0] * 40 + [50.0] * 10, [10.0] * 50); ser['CALLED'] = (d0, [1.0] * 40 + [99.0] * 10, [10000.0] * 50)
bl, rs = S.baseline(ser, T0, 7 * D, exclude='called')
assert bl['n'] == 20 and abs(bl['median'] - 0.95) < 1e-9 and bl['hit2xPct'] == 50.0, bl
assert S.baseline({k: v for k, v in list(ser.items())[:5]}, T0, 7 * D)[0].get('pending'), 'n<10 -> pending'

# --- scorecard: too few until 20; then weak / unproven / backtested ---
def item(ret, base, gib=0.0):
    return {'h': {'1d': {}, '7d': {'done': True, 'ret': ret, 'hit2x': False, 'drop50': False, 'baseline': {'median': base}}, '30d': {}},
            'gibi': {'7d': {'done': True, 'ret': gib}}, 'h2h': {'7d': 'gut' if ret > gib else 'gibi'}}
c = S.scorecard([item(0.5, 0.0)] * 19); assert c['strength'] == 'too few' and 'Too few calls to judge' in c['strengthNote'] and c['gutBet']['pct'] == 0.25 and not c['gutBet']['edgeProven']
assert S.scorecard([item(-0.1, 0.0)] * 25)['strength'] == 'weak'
assert S.scorecard([item(0.3, 0.0)] * 15 + [item(-0.1, 0.0)] * 10)['strength'] == 'unproven'  # 15/25: p~0.21
c = S.scorecard([item(0.3, 0.0)] * 22 + [item(-0.1, 0.0)] * 3); assert c['strength'] == 'backtested' and c['gutBet']['edgeProven'] and c['hitRate'] == 22 / 25
assert c['d7']['gutWins'] == 22 and c['d7']['gibiWins'] == 3

# --- bad-USD guard: non-SOL/USDC quote -> USD = quote-denominated close x quote token USD close (never GT's own USD) ---
calls = []
def fake_hourly(chain, pool, currency, before=None, ttl=0):
    if pool == 'P' and currency == 'usd': return [[T0, .00065, .00065, .00065, .00065, 1]], T0 + H, {'quote': {'symbol': 'CYPH', 'address': 'Q'}}
    if pool == 'P' and currency == 'token': return [[T0, .0003, .0003, .0003, .0003, 1]], T0 + H, None
    if pool == 'QP': return [[T0 - H, 2.0, 2.0, 2.0, 2.0, 1]], T0 + H, None
mc.hourly = fake_hourly
mc.resolve_pool = lambda chain, tok, pool=None: {'pool': 'P', 'name': 'CAT / CYPH', 'base': tok, 'quote': 'Q', 'quoteSym': 'CYPH', 'liq': 1}
mc.cached = lambda name, ttl, fn: ({'data': [{'attributes': {'address': 'QP', 'name': 'CYPH / USDC', 'reserve_in_usd': 9}, 'relationships': {'base_token': {'data': {'id': 'solana_Q'}}, 'quote_token': {'data': {'id': 'solana_EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'}}}}]}, T0 + H)
s = mc.usd_series('solana', 'CAT')
assert abs(s['bars'][0][4] - 0.0006) < 1e-12 and s['guard']['quotePool'] == 'QP' and 'rebuilt' in s['how'], s
print('mycalls scoring ok')
