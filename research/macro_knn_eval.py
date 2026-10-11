#!/usr/bin/env python3
"""Does adding macro features (FRED) to the inverse detector's kNN improve it? Leave-one-token-out on data/crash_samples.json. No network."""
import json, os, statistics
from common import DATA_DIR
S = json.load(open(os.path.join(DATA_DIR, 'crash_samples.json'))); M = json.load(open(os.path.join(DATA_DIR, 'macro_overlay.json')))['daily_features']
K = ['y10_chg_30d_bp', 'fedfunds_chg_90d', 'move_proxy_pct', 'walcl_chg_90d_pct']
S = [s for s in S if s['d'] in M and all(M[s['d']].get(k) is not None for k in K)]
sd = {k: statistics.pstdev([M[s['d']][k] for s in S]) or 1 for k in K}
def run(use_macro, k=25):
    V = [s['v'] + ([M[s['d']][kk] / sd[kk] for kk in K] if use_macro else []) for s in S]; out = []
    for i, q in enumerate(V):
        dd = sorted((sum((a - b) ** 2 for a, b in zip(q, v)), S[j]['h']) for j, v in enumerate(V) if S[j]['n'] != S[i]['n'])[:k]
        out.append((sum(h for _, h in dd) / k, S[i]['h']))
    base = sum(h for _, h in out) / len(out); res = {'samples': len(out), 'base': round(base, 4)}
    for t in (0.2, 0.3, 0.5):
        sel = [h for o, h in out if o >= t]; res[f'ge{int(t*100)}'] = {'n': len(sel), 'hit_rate': round(sum(sel) / len(sel), 4) if sel else None, 'lift': round(sum(sel) / len(sel) / base, 2) if sel else None}
    return res
r = {'price_volume_only': run(False), 'with_macro': run(True), 'macro_features': K, 'note': 'Only samples on/after 2021-06 with full macro coverage.'}
json.dump(r, open(os.path.join(DATA_DIR, 'macro_knn_eval.json'), 'w')); print(json.dumps(r, indent=1))
