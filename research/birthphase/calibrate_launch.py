"""Calibrate the birth-phase launch model P(reach $1M) for phone alerts (lib/alerts.js 'launch-model').
Only pump.fun has an unbiased population base rate (random launch + random graduation samples), so only pump.fun is
calibrated; other pads' numbers are outcome-enriched catalog shares (not odds) and are never alerted.
Method: forward-chaining temporal folds (train on launches created before each cut, score pump.fun launches in the next
window), every snapshot age, population-weighted by the inverse-sampling cell weights from match.cell_weights.
Calibration population = what the live alert can see: still on the bonding curve, snapshot mcap >= $5K.
Weighted isotonic regression (PAV) of outcome on raw model p -> step map p -> real odds; lift = real / pump.fun base rate.
Also reports the same-second bundle split. Writes data/birthphase/launch_calibration.json."""
import sys, os, json, time, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import match as mt
from bp_common import BP, wjson
MIN_MCAP = 5000

def wr(rows):
    w = sum(r['w'] for r in rows)
    return {'n': len(rows), 'pos': sum(r['y'] for r in rows), 'real': (sum(r['w'] * r['y'] for r in rows) / w) if w else None, 'mean_p': (sum(r['p'] for r in rows) / len(rows)) if rows else None}

def pav(rows):
    bl = []
    for d in sorted(rows, key=lambda d: d['p']):
        bl.append([d['w'] * d['y'], d['w'], d['p'], d['p'], 1, d['y']])
        while len(bl) > 1 and bl[-2][0] / bl[-2][1] >= bl[-1][0] / bl[-1][1]:
            b = bl.pop(); a = bl[-1]; a[0] += b[0]; a[1] += b[1]; a[3] = b[3]; a[4] += b[4]; a[5] += b[5]
    return [{'p_lo': b[2], 'p_hi': b[3], 'real': b[0] / b[1], 'n': b[4], 'pos': b[5]} for b in bl]

def platt(rows, it=4000, lr=2.0):
    lg = lambda p: math.log(min(max(p, 1e-5), 1 - 1e-5) / (1 - min(max(p, 1e-5), 1 - 1e-5)))
    a, b = 1.0, 0.0; W = sum(r['w'] for r in rows)
    for _ in range(it):
        ga = gb = 0.0
        for r in rows:
            x = lg(r['p']); q = 1 / (1 + math.exp(-(a * x + b))); g = (q - r['y']) * r['w'] / W; ga += g * x; gb += g
        a -= lr * ga; b -= lr * gb
    return a, b

def main():
    recs = mt.load(); rates = mt.pad_rates(recs)
    lab = sorted([r for r in recs if (r.get('outcome') or {}).get('reached_1m') is not None], key=lambda r: r['created_ts'])
    cuts = [lab[int(len(lab) * f)]['created_ts'] for f in (0.5, 0.6, 0.7, 0.8, 0.9)] + [10 ** 15]
    D = []
    for A in mt.SNAP_AGES:
        for i in range(5):
            train = [r for r in recs if r['created_ts'] < cuts[i]]
            test = [r for r in recs if cuts[i] <= r['created_ts'] < cuts[i + 1] and r['launchpad'] == 'pump.fun']
            M = mt.Model(train, A, 1e6, rates); T = mt.Model(test, A, 1e6, rates)
            if 'pump.fun' not in M.w['calibrated_pads']: continue
            for rw in T.rows:
                pr = M.predict(rw['v'], rw['sh'], 'pump.fun')
                if not pr: continue
                sn = rw['r']['ext']['snap']; s = sn.get(str(A)) or sn.get(A) or {}
                D.append({'A': A, 'y': rw['y'], 'p': pr['p'], 'w': M.w['w'].get(('pump.fun', rw['cell']), 1.0), 'grad': bool(rw['v'].get('grad')),
                          'same': s.get('same_sec'), 'mcap': s.get('mcap') or 0, 'key': rw['r']['key']})
    base = rates['pump.fun']['launch_base_rate']['1000000']
    E = [d for d in D if d['mcap'] >= MIN_MCAP and not d['grad']]
    bins = [0, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.4, 1.01]
    def table(R):
        out = []
        for lo, hi in zip(bins, bins[1:]):
            s = [d for d in R if lo <= d['p'] < hi]
            if s: t = wr(s); t['bin'] = [lo, min(hi, 1)]; t['lift'] = t['real'] / base; out.append(t)
        return out
    iso = pav(E)
    for b in iso: b['lift'] = b['real'] / base
    a, b_ = platt(E)
    bundle = {}
    for nm, f in [('same_sec_ge_50', lambda d: d['same'] is not None and d['same'] >= 0.5), ('same_sec_lt_50', lambda d: d['same'] is not None and d['same'] < 0.5)]:
        s = [d for d in E if f(d)]
        bundle[nm] = {'all': wr(s), 'lift_ge_3': wr([d for d in s if any(bb['p_lo'] <= d['p'] <= bb['p_hi'] and bb['lift'] >= 3 for bb in iso) or d['p'] > iso[-1]['p_hi']])}
    # share of all pump.fun launches that ever qualify (lift >= 3) at some snapshot age, population-weighted
    def lift_of(p):
        L = iso[0]['lift']
        for bb in iso:
            if p >= bb['p_lo']: L = bb['lift']
        return L
    keys = {}
    for d in D: keys.setdefault(d['key'], {'w': d['w'], 'q3': False, 'q10': False})
    for d in E:
        L = lift_of(d['p']); keys[d['key']]['q3'] |= L >= 3; keys[d['key']]['q10'] |= L >= 10
    W = sum(k['w'] for k in keys.values())
    share3 = sum(k['w'] for k in keys.values() if k['q3']) / W; share10 = sum(k['w'] for k in keys.values() if k['q10']) / W
    out = {'generatedAt': int(time.time() * 1000), 'target': 'reach $1M mcap', 'pad': 'pump.fun', 'base_rate': base, 'min_mcap': MIN_MCAP,
           'population': 'pump.fun, still on bonding curve, snapshot mcap >= $5K, all snapshot ages ' + str(mt.SNAP_AGES),
           'method': 'forward-chaining temporal folds (5 cuts at 50..90% of labelled launches), population-weighted (random launch + random graduation samples), weighted isotonic (PAV)',
           'n_rows': len(E), 'n_pos': sum(d['y'] for d in E), 'n_rows_all_pump': len(D),
           'isotonic': iso, 'platt': {'a': a, 'b': b_, 'note': 'q = sigmoid(a*logit(p)+b); reference only (extrapolates beyond the data); alerts use isotonic'},
           'table_eligible': table(E), 'table_all_pump': table(D), 'bundle': bundle,
           'qualify_share_of_launches': {'lift_ge_3': share3, 'lift_ge_10': share10},
           'calibrated_pads': ['pump.fun'], 'note': 'Virtuals and every other pad have no random population sample -> not calibrated -> never alerted.'}
    wjson(os.path.join(BP, 'launch_calibration.json'), out)
    print(json.dumps({k: v for k, v in out.items() if k not in ('table_all_pump',)}, indent=1, default=str)[:6000])
    print('ALL pump rows table'); [print(t) for t in out['table_all_pump']]

if __name__ == '__main__':
    main()
