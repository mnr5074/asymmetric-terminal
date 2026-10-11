"""Birth-phase matcher + held-out backtest.
Feature distance (standardised snapshot features at the same age after creation) + curve-shape distance
(log-mcap path over the checkpoints up to that age) -> nearest past launches -> neighbour-weighted probability of
reaching $100K / $1M / $10M. Pump.fun probabilities are re-weighted to the population with an unbiased random sample of
launches (random_pump_hist.py) and of graduations (random_pump_grads.py); other pads have no population sample, so
their numbers are 'share of similar launches in the library' (outcome-enriched) and are flagged uncalibrated.
Writes data/birthphase/model.json (base rates, backtest)."""
import sys, os, json, glob, math, time, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bp_common import BP, THRESH, rjsonl, wjson
SNAP_AGES = [60, 300, 900, 1800, 3600, 10800]
TK = {1e5: 'reached_100k', 1e6: 'reached_1m', 1e7: 'reached_10m'}
FEATS = ['lmcap', 'slope', 'curve', 'lntr', 'lnby', 'lvol', 'top10', 'sell', 'lmed', 'gini20', 'same', 'fresh', 'ldelay', 'dev', 'rep', 'grad']
FW = {'lmcap': 1.5, 'slope': 1.0, 'curve': 1.0, 'lntr': 1.0, 'lnby': 1.0, 'lvol': 1.0, 'top10': 0.6, 'sell': 0.6, 'lmed': 0.7, 'gini20': 0.5, 'same': 0.6,
      'fresh': 0.8, 'ldelay': 0.4, 'dev': 0.6, 'rep': 0.8, 'grad': 1.0}
CHK = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800]

def L10(x): return math.log10(x) if x and x > 0 else None
def vec(s):
    if not s: return None
    g = lambda k: s.get(k)
    v = {'lmcap': L10(g('mcap')), 'slope': (math.log10(g('mcap') / g('mcap_prev')) if g('mcap') and g('mcap_prev') else None),
         'curve': (g('curve_pct') / 100 if g('curve_pct') is not None else None), 'lntr': (math.log1p(g('n_trades')) if g('n_trades') is not None else None),
         'lnby': (math.log1p(g('n_buyers')) if g('n_buyers') is not None else None), 'lvol': (math.log10(1 + g('vol')) if g('vol') is not None else None),
         'top10': g('top10'), 'sell': g('sell_share'), 'lmed': (math.log10(1 + g('med_buy')) if g('med_buy') is not None else None), 'gini20': g('gini20'),
         'same': g('same_sec'), 'fresh': g('fresh20'), 'ldelay': (math.log1p(max(0.0, g('first_buy_delay'))) if g('first_buy_delay') is not None else None),
         'dev': (min(1.0, g('dev_pct') / 100) if g('dev_pct') is not None else None), 'rep': (math.log1p(g('repeat')) if g('repeat') is not None else None),
         'grad': (1.0 if g('graduated') else 0.0) if g('graduated') is not None else None}
    return v

def shape(traj, A):
    pts = {p['t']: p['mcap'] for p in traj or [] if p['t'] <= A and p.get('mcap')}
    if A not in pts: 
        # use last point <= A as the anchor
        if not pts: return None
        ref = pts[max(pts)]
    else: ref = pts[A]
    return {t: math.log10(m / ref) for t, m in pts.items() if t < A and t in CHK}

def load():
    recs = []
    own = set()
    for f in glob.glob(os.path.join(BP, '*.jsonl')):
        rows = rjsonl(f)
        if rows and rows[0].get('schema_version') != '1.0': continue  # another worker's native format: use adapted/ copy
        own.add(os.path.basename(f))
        recs += [r for r in rows if r.get('created_ts')]
    for f in glob.glob(os.path.join(BP, 'adapted', '*.jsonl')):
        if os.path.basename(f) in own: continue
        recs += [r for r in rjsonl(f) if r.get('created_ts')]
    return recs

def mcap_at(r, A):
    s = (r.get('ext') or {}).get('snap', {}).get(str(A)) or (r.get('ext') or {}).get('snap', {}).get(A)
    return (s or {}).get('mcap')

class Model:
    def __init__(self, recs, A, thr, pad_rates=None, now=None):
        self.A, self.thr, self.k = A, thr, TK[thr]
        self.rows = []
        for r in recs:
            sn = (r.get('ext') or {}).get('snap') or {}
            s = sn.get(str(A)) or sn.get(A)
            y = (r.get('outcome') or {}).get(self.k)
            if not s or y is None: continue
            if s.get('mcap') and s['mcap'] >= thr: continue  # already there at age A: not a prediction
            v = vec(s)
            if sum(1 for x in v.values() if x is not None) < 3: continue
            self.rows.append({'r': r, 'v': v, 'sh': shape(r.get('trajectory'), A), 'y': 1 if y else 0, 'pad': r['launchpad']})
        self.sd = {}
        for f in FEATS:
            xs = [row['v'][f] for row in self.rows if row['v'][f] is not None]
            if len(xs) > 5:
                m = sum(xs) / len(xs); sd = math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))
                self.sd[f] = sd if sd > 1e-6 else None
        self.w = cell_weights(self.rows, thr, pad_rates or {})

    def dist(self, v, sh, row, pad):
        num, den, n = 0.0, 0.0, 0
        for f in FEATS:
            a, b, sd = v.get(f), row['v'][f], self.sd.get(f)
            if a is None or b is None or not sd: continue
            z = (a - b) / sd; num += FW[f] * min(z * z, 16); den += FW[f]; n += 1
        if n < 3: return None
        d2 = num / den
        if sh and row['sh']:
            c = [t for t in sh if t in row['sh']]
            if len(c) >= 2:
                ds = sum(abs(sh[t] - row['sh'][t]) for t in c) / len(c) / 0.3
                d2 = 0.7 * d2 + 0.3 * ds * ds
        if pad != row['pad']: d2 += 0.6  # different launch mechanics
        return math.sqrt(d2)

    def predict(self, v, sh, pad, exclude_key=None, before_ts=None, k=30, h=0.7):
        cand = []
        for row in self.rows:
            if exclude_key and row['r']['key'] == exclude_key: continue
            if before_ts and row['r']['created_ts'] >= before_ts: continue
            d = self.dist(v, sh, row, pad)
            if d is not None: cand.append((d, row))
        cand.sort(key=lambda x: x[0]); nb = cand[:k]
        if not nb: return None
        cal = pad in self.w['calibrated_pads']
        num = den = 0.0
        for d, row in nb:
            kw = math.exp(-d * d / (2 * h * h)) * (self.w['w'].get((row['pad'], row['cell'])) or 1.0 if cal and row['pad'] == pad else 1.0)
            num += kw * row['y']; den += kw
        base = self.w['base'].get(pad)
        prior = base if (cal and base is not None) else (sum(r['y'] for d, r in nb) / len(nb))
        m = 1.0
        p = (num + m * prior) / (den + m) if den > 0 else prior
        return {'p': p, 'calibrated': cal, 'base_rate': base, 'neighbors': nb}

def cell_weights(rows, thr, pad_rates):
    """inverse-probability weights per (pad, cell); cell = NG (never graduated) / G0 (graduated, < thr) / G1 (graduated, >= thr)"""
    out = {'w': {}, 'base': {}, 'calibrated_pads': set()}
    for row in rows:
        g = (row['r'].get('outcome') or {}).get('graduated')
        row['cell'] = 'NG' if g is False else ('G1' if row['y'] else 'G0')
    for pad, pr in pad_rates.items():
        g, h = pr.get('p_grad'), (pr.get('p_given_grad') or {}).get(str(int(thr)))
        if g is None or h is None: continue
        pop = {'NG': 1 - g, 'G0': g * (1 - h), 'G1': g * h}
        lib = {}
        for row in rows:
            if row['pad'] == pad: lib[row['cell']] = lib.get(row['cell'], 0) + 1
        tot = sum(lib.values())
        if tot < 30 or any(lib.get(c, 0) == 0 for c in pop if pop[c] > 0): continue
        for c in pop: out['w'][(pad, c)] = pop[c] / (lib[c] / tot)
        out['base'][pad] = g * h; out['calibrated_pads'].add(pad)
    return out

def wilson(k, n, z=1.96):
    if n == 0: return None, None, None
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); e = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return p, max(0, (c - e) / d), min(1, (c + e) / d)

def pad_rates(recs):
    """population rates from the unbiased random strata only"""
    out = {}
    pads = {r['launchpad'] for r in recs}
    for pad in pads:
        R = [r for r in recs if r['launchpad'] == pad and r['sample_stratum'] == 'random' and (r.get('outcome') or {}).get('graduated') is not None]
        G = [r for r in recs if r['launchpad'] == pad and r['sample_stratum'] == 'random_graduates']
        if len(R) < 30: continue
        ng = sum(1 for r in R if r['outcome']['graduated'])
        p, lo, hi = wilson(ng, len(R))
        d = {'n_random_launches': len(R), 'graduated': ng, 'p_grad': p, 'p_grad_ci95': [lo, hi], 'p_given_grad': {}, 'n_random_grads': len(G), 'p_given_grad_ci95': {}, 'launch_base_rate': {}}
        for thr in THRESH:
            k = TK[thr]
            GG = [r for r in G if r['outcome'].get(k) is not None]
            kk = sum(1 for r in GG if r['outcome'][k])
            if len(GG) >= 20:
                pp, l2, h2 = wilson(kk, len(GG)); d['p_given_grad'][str(int(thr))] = pp; d['p_given_grad_ci95'][str(int(thr))] = [l2, h2, kk, len(GG)]
                d['launch_base_rate'][str(int(thr))] = p * pp
            RR = [r for r in R if r['outcome'].get(k) is not None]; kr = sum(1 for r in RR if r['outcome'][k])
            d.setdefault('random_launch_hits', {})[str(int(thr))] = [kr, len(RR)]
        out[pad] = d
    return out

def auc(ys, ps, ws=None):
    ws = ws or [1.0] * len(ys)
    P = [(p, w) for y, p, w in zip(ys, ps, ws) if y]; N = [(p, w) for y, p, w in zip(ys, ps, ws) if not y]
    if not P or not N: return None
    s = 0.0; tw = 0.0
    for p, w in P:
        for q_, v in N:
            s += w * v * (1.0 if p > q_ else 0.5 if p == q_ else 0.0); tw += w * v
    return s / tw

def backtest(recs, rates, split=0.7):
    out = {'method': 'temporal hold-out: model built only from launches created before the cut; scored on later launches. Launches already at/above the threshold at the snapshot age are excluded (no free wins).', 'by': []}
    lab = [r for r in recs if (r.get('outcome') or {}).get('reached_1m') is not None]
    lab.sort(key=lambda r: r['created_ts'])
    if len(lab) < 40: return out
    cut = lab[int(len(lab) * split)]['created_ts']
    out['cut_ts'] = cut; out['n_train'] = sum(1 for r in lab if r['created_ts'] < cut); out['n_test_pool'] = sum(1 for r in lab if r['created_ts'] >= cut)
    train = [r for r in recs if r['created_ts'] < cut]
    test = [r for r in recs if r['created_ts'] >= cut]
    for A in [300, 900, 3600]:
        for thr in [1e5, 1e6, 1e7]:
            M = Model(train, A, thr, rates)
            T = Model(test, A, thr, rates)  # just to reuse row construction (vectors, labels, cells)
            ys, ps, ws, pads, cal, used = [], [], [], [], [], []
            for row in T.rows:
                pr = M.predict(row['v'], row['sh'], row['pad'])
                if not pr: continue
                used.append(row)
                ys.append(row['y']); ps.append(pr['p']); pads.append(row['pad']); cal.append(pr['calibrated'])
                ws.append(M.w['w'].get((row['pad'], row['cell']), 1.0) if pr['calibrated'] else 1.0)
            if not ys: continue
            res = {'age_s': A, 'threshold': thr, 'n_test': len(ys), 'positives': sum(ys), 'n_train_rows': len(M.rows), 'auc': auc(ys, ps),
                   'auc_baseline_mcap_only': auc(ys, [(rw['v'].get('lmcap') or 0) for rw in used]),
                   'brier': sum((p - y) ** 2 for p, y in zip(ps, ys)) / len(ys), 'test_rate': sum(ys) / len(ys), 'at': []}
            for t in [0.02, 0.05, 0.1, 0.2, 0.3, 0.5]:
                sel = [(y, w) for y, p, w in zip(ys, ps, ws) if p >= t]
                tp = sum(y for y, w in sel); n = len(sel)
                res['at'].append({'p_ge': t, 'flagged': n, 'hits': tp, 'precision': tp / n if n else None, 'recall': tp / sum(ys) if sum(ys) else None,
                                  'precision_pop_weighted': (sum(w for y, w in sel if y) / sum(w for y, w in sel)) if sel else None})
            # segments: still on the bonding curve at age A (the 'allocation before launch' case) vs already graduated
            gflag = [bool(row['v'].get('grad')) for row in T.rows if M.predict(row['v'], row['sh'], row['pad'])] if False else None
            seg = {}
            for name, cond in [('still_on_curve', lambda rw: not rw['v'].get('grad')), ('already_graduated', lambda rw: bool(rw['v'].get('grad')))]:
                idx = [i for i, rw in enumerate(used) if cond(rw)]
                if len(idx) >= 8:
                    yy = [ys[i] for i in idx]; pp = [ps[i] for i in idx]; ww = [ws[i] for i in idx]
                    seg[name] = {'n': len(idx), 'pos': sum(yy), 'auc': auc(yy, pp), 'auc_pop_weighted': auc(yy, pp, ww), 'auc_baseline_mcap_only': auc(yy, [(used[i]['v'].get('lmcap') or 0) for i in idx]),
                                 'at': [{'p_ge': t, 'flagged': sum(1 for p in pp if p >= t), 'hits': sum(y for y, p in zip(yy, pp) if p >= t)} for t in (0.05, 0.1, 0.2, 0.3)]}
            res['segments'] = seg
            # per pad (pump.fun vs others)
            for pd in sorted(set(pads)):
                idx = [i for i, x in enumerate(pads) if x == pd]
                if len(idx) >= 10:
                    yy = [ys[i] for i in idx]; pp = [ps[i] for i in idx]; ww = [ws[i] for i in idx]
                    res.setdefault('per_pad', {})[pd] = {'n': len(idx), 'pos': sum(yy), 'auc': auc(yy, pp), 'auc_pop_weighted': auc(yy, pp, ww),
                                                         'calibrated': any(cal[i] for i in idx),
                                                         'calib': calib(yy, pp, ww)}
            out['by'].append(res)
    return out

def calib(ys, ps, ws):
    bins = [0, 0.02, 0.05, 0.1, 0.2, 0.4, 1.01]; out = []
    for lo, hi in zip(bins, bins[1:]):
        idx = [i for i, p in enumerate(ps) if lo <= p < hi]
        if not idx: continue
        w = sum(ws[i] for i in idx)
        out.append({'bin': [lo, min(1, hi)], 'n': len(idx), 'mean_p': sum(ps[i] for i in idx) / len(idx), 'hit_rate': sum(ys[i] for i in idx) / len(idx),
                    'hit_rate_pop_weighted': sum(ws[i] * ys[i] for i in idx) / w if w else None})
    return out

if __name__ == '__main__':
    recs = load()
    rates = pad_rates(recs)
    bt = backtest(recs, rates)
    wjson(os.path.join(BP, 'model.json'), {'generatedAt': int(time.time() * 1000), 'n_library': len(recs), 'pad_rates': rates, 'backtest': bt,
                                            'features': FEATS, 'feature_weights': FW, 'snap_ages': SNAP_AGES})
    print(json.dumps(rates, indent=0)[:1500])
    for b in bt.get('by', []):
        print(b['age_s'], int(b['threshold']), 'n', b['n_test'], 'pos', b['positives'], 'auc', b['auc'] and round(b['auc'], 3), [(a['p_ge'], a['flagged'], a['hits']) for a in b['at']])
