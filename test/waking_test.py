#!/usr/bin/env python3
"""python3 test/waking_test.py : the pre-declared Waking Up signal on synthetic series (fires on a multi-day wake off a dead base,
not on a one-day spike, not after a breakout, never looks ahead) and the stale-USD guard for non-SOL/USDC quote pools."""
import os, sys, json, tempfile
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'research', 'waking'))
import waking as W

def base_series(n=120):
    c = np.ones(n); v = np.full(n, 10000.0)
    c[:20] = np.linspace(1, 3, 20); v[:20] = 200000.0      # busy launch, peak 3.0
    c[20:40] = np.linspace(3, 1.0, 20); v[20:40] = 80000.0  # slide
    c[40:] = 1.0 + 0.05 * np.sin(np.arange(n - 40))         # flat dead base around 1.0
    return c, v
c, v = base_series(); i = 100
c2, v2 = c.copy(), v.copy(); v2[i - 3:i + 1] = [30000, 25000, 32000, 40000]; c2[i - 3:i + 1] = [1.02, 1.03, 1.04, 1.05]
f = W.features(c2, v2, 5000); assert f['sig'][i], {k: bool(f[k][i]) for k in ('tradable', 'dead', 'down', 'flat', 'rising', 'hl', 'near')}
# one-day spike only -> no signal
c3, v3 = c.copy(), v.copy(); v3[i] = 200000; f3 = W.features(c3, v3, 5000); assert not f3['sig'][i], 'single spike must not fire'
# already broken out (close 1.4 > 1.10 x base top ~1.05) -> no signal
c4, v4 = c2.copy(), v2.copy(); c4[i] = 1.4; f4 = W.features(c4, v4, 5000); assert not f4['sig'][i], 'breakout is not waking'
# below the volume floor -> no signal
f5 = W.features(c2, v2 / 100, 5000); assert not f5['sig'][i]
# no look-ahead: features at i are identical whatever happens after i
c6, v6 = c2.copy(), v2.copy(); c6[i + 1:] = 5.0; v6[i + 1:] = 1e7; f6 = W.features(c6, v6, 5000)
assert all(bool(f6[k][i]) == bool(f[k][i]) for k in ('sig', 'dead', 'down', 'flat', 'rising', 'hl', 'near', 'tradable'))
# outcomes: a 2x within 30 days
c7 = c2.copy(); c7[i + 10] = 2.2; o = W.outcomes(c7, len(c7) - 1); assert o is None or i >= o['m'] or o['hit'][i]
c8 = np.concatenate([c2, np.ones(40)]); c8[i + 10] = 2.2; o = W.outcomes(c8, len(c8) - 1); assert o['hit'][i] and not o['drop'][i]
# stale-USD guard: GT USD flat for days while CYPH-denominated candles move -> USD rebuilt from quote candles x quote USD
d = tempfile.mkdtemp(); W.CACHE = d
days = list(range(20000, 20010))
ohl = lambda rows: {'data': {'attributes': {'ohlcv_list': [[dd * 86400, 0, 0, 0, cc, vv] for dd, cc, vv in rows]}}}
json.dump(ohl([(dd, 0.00065, 100) for dd in days]), open(f'{d}/sol_ohlcvd_POOL.json', 'w'))                        # stale USD
json.dump(ohl([(dd, 0.00001 * (1 + 0.1 * k), 1.0) for k, dd in enumerate(days)]), open(f'{d}/sol_ohlcvq_POOL.json', 'w'))  # moving in CYPH
json.dump(ohl([(dd, 50.0, 1e6) for dd in days]), open(f'{d}/sol_ohlcvd_QPOOL.json', 'w'))                           # CYPH = $50
rows = W.gt_rows(f'{d}/sol_ohlcvd_POOL.json')
out, note, stt = W.usd_guard('T', {'pool': 'POOL', 'quote': 'CYPHmint', 'quotePool': 'QPOOL'}, rows)
assert abs(out[-1][1] - 0.00001 * 1.9 * 50) < 1e-9 and 'stale' in note and stt['gtFlatDaysLast7'] >= 3, (out[-1], note)
out2, note2, _ = W.usd_guard('T', {'pool': 'POOL', 'quote': 'So11111111111111111111111111111111111111112'}, rows); assert out2 == rows and note2 is None
out3, note3, _ = W.usd_guard('T', {'pool': 'POOL', 'quote': 'CYPHmint', 'quotePool': None}, rows); assert out3 == [] and 'excluded' in note3
print('waking signal + usd guard ok')
