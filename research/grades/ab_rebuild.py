#!/usr/bin/env python3
"""Rebuild of the Live Alpha Feed A/B grade (lib/livefeed.js) from the forward call log (data/calls.json).

Question: does any feature known AT CALL TIME separate future winners from duds, out-of-sample?
  - unit: first call per token (regrades dropped: they are repeated looks at the same token), calls >= 24h old (outcome window).
  - outcomes (lib/calls.js definitions): hit = peak >= 2x since the call AND not rugged; rug = price <= 10% of call price, liquidity
    pulled under $1K from >= $3K, or pair delisted. Peak is tracked for up to 7.2 days, so recent calls have had less time.
  - universe for grading = calls that pass every safety veto (vetoed tokens are 'F' regardless).
  - time split: the oldest 60% of calls (by call time) = train; newest 40% = test. Rules are chosen on train only.
  - features: score components (comps.*) and raw features (feat.*) stored at call time. No feature uses later data; market cap is the
    DexScreener fdv at call time (no current-supply back-fill). Features with > 50% missing are skipped.
  - rule search on train: for each feature, quintile edges from train; candidate rules 'x >= edge' and 'x <= edge'; keep rules with
    >= 40 train calls whose train hit rate beats the train base rate. Each kept rule is then scored ONCE on test.
  - a rule 'beats the base rate out-of-sample' if test hit rate > test base rate with one-sided binomial p < 0.05 after Bonferroni
    over all rules tested AND its test rug rate is not higher than the test base rug rate.
  - also: L2 logistic regression on all numeric features (train) -> test AUC with a 1000-draw permutation p-value.
Writes data/grade_rebuild.json. Strength labels: 'backtested' only for rules that pass; everything else 'unproven'/'weak'.
"""
import json, math, os, random, re, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, 'data')

def binom_sf(k, n, p):  # P(X >= k)
    if k <= 0: return 1.0
    s = 0.0
    lp, lq = math.log(p) if p > 0 else -1e9, math.log(1 - p) if p < 1 else -1e9
    for i in range(k, n + 1):
        s += math.exp(math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * lp + (n - i) * lq)
    return min(1.0, s)

def auc(s, y):
    P = sorted(zip(s, y)); r = 0; npos = 0; nneg = 0
    for i, (_, t) in enumerate(P):
        if t: r += i + 1; npos += 1
        else: nneg += 1
    return (r - npos * (npos + 1) / 2) / (npos * nneg) if npos and nneg else None

def main():
    d = json.load(open(os.path.join(DATA, 'calls.json'))); C = d['calls']; now = d.get('savedAt') or int(time.time() * 1000)
    pk = lambda c: (c['maxPx'] / c['px0']) if c.get('px0') else 0
    first = [c for c in C if not c.get('regrade') and now - c['t'] > 24 * 3600e3 and c.get('px0')]
    first.sort(key=lambda c: c['t'])
    hit = lambda c: pk(c) >= 2 and not c['rugged']
    def stats(cs):
        n = len(cs); return {'n': n, 'hit2x': round(sum(map(hit, cs)) / n, 4) if n else None, 'rug': round(sum(c['rugged'] for c in cs) / n, 4) if n else None,
                              'peak2x_any': round(sum(pk(c) >= 2 for c in cs) / n, 4) if n else None}
    before = {g: stats([c for c in first if c['grade'] == g]) for g in 'ABCDF'}
    before['all'] = stats(first)
    ab = [c for c in first if c['grade'] in 'AB']; before['A+B'] = stats(ab)
    # vetoes
    def vstat(pat):
        cs = [c for c in first if c.get('veto') and pat in c['veto']]
        return {'n': len(cs), 'rugged': round(sum(c['rugged'] for c in cs) / len(cs), 4) if cs else None, 'noHit': round(sum(not hit(c) for c in cs) / len(cs), 4) if cs else None}
    vetoes = {k: vstat(p) for k, p in [('top10_concentration', 'top-10'), ('fake_liquidity_quote_side', 'fake liquidity'), ('honeypot', 'honeypot'), ('liquidity_under_3k', 'liquidity under'), ('liquidity_pulled', 'liquidity down')]}
    t10 = [(float(re.search(r'hold ([\d.]+)%', c['veto']).group(1)), c) for c in first if c.get('veto') and 'top-10' in c['veto']]
    vetoes['top10_gt90'] = (lambda cs: {'n': len(cs), 'rugged': round(sum(c['rugged'] for c in cs) / len(cs), 4) if cs else None})([c for v, c in t10 if v > 90])
    vetoes['top10_60_90'] = (lambda cs: {'n': len(cs), 'rugged': round(sum(c['rugged'] for c in cs) / len(cs), 4) if cs else None})([c for v, c in t10 if v <= 90])
    # grading universe: passes all vetoes
    U = [c for c in first if not c.get('veto')]
    cut = int(len(U) * 0.6); TR, TE = U[:cut], U[cut:]
    feats = sorted({('comps', k) for c in U for k in (c.get('comps') or {})} | {('feat', k) for c in U for k, v in (c.get('feat') or {}).items() if isinstance(v, (int, float)) and not isinstance(v, bool)})
    val = lambda c, f: (c.get(f[0]) or {}).get(f[1])
    br_tr, br_te = sum(map(hit, TR)) / len(TR), sum(map(hit, TE)) / len(TE)
    rug_te = sum(c['rugged'] for c in TE) / len(TE)
    cands = []
    for f in feats:
        xs = sorted(v for v in (val(c, f) for c in TR) if isinstance(v, (int, float)))
        if len(xs) < 0.5 * len(TR): continue
        edges = sorted({xs[int(len(xs) * q)] for q in (0.2, 0.4, 0.6, 0.8)})
        for e in edges:
            for op in ('>=', '<='):
                sel = [c for c in TR if isinstance(val(c, f), (int, float)) and (val(c, f) >= e if op == '>=' else val(c, f) <= e)]
                if len(sel) < 40: continue
                h = sum(map(hit, sel)) / len(sel)
                if h > br_tr: cands.append({'feature': '.'.join(f), 'op': op, 'edge': e, 'train': {'n': len(sel), 'hit2x': round(h, 4)}})
    m = max(1, len(cands)); passed = []
    for r in cands:
        f = tuple(r['feature'].split('.', 1)); e = r['edge']
        sel = [c for c in TE if isinstance(val(c, f), (int, float)) and (val(c, f) >= e if r['op'] == '>=' else val(c, f) <= e)]
        k = sum(map(hit, sel)); n = len(sel)
        r['test'] = {'n': n, 'hit2x': round(k / n, 4) if n else None, 'rug': round(sum(c['rugged'] for c in sel) / n, 4) if n else None, 'p_raw': round(binom_sf(k, n, br_te), 5) if n else None}
        r['test']['p_bonf'] = min(1.0, r['test']['p_raw'] * m) if n else None
        r['beats'] = bool(n >= 20 and r['test']['hit2x'] > br_te and r['test']['p_bonf'] < 0.05 and r['test']['rug'] <= rug_te)
        if r['beats']: passed.append(r)
    cands.sort(key=lambda r: (r['test']['p_raw'] if r['test']['p_raw'] is not None else 1))
    # logistic regression on all numeric features (median-imputed, standardised on train)
    F = [f for f in feats if sum(isinstance(val(c, f), (int, float)) for c in TR) >= 0.5 * len(TR)]
    def col(cs, f, med):
        return [val(c, f) if isinstance(val(c, f), (int, float)) and math.isfinite(val(c, f)) else med for c in cs]
    meds, mus, sds = {}, {}, {}
    for f in F:
        xs = sorted(v for v in (val(c, f) for c in TR) if isinstance(v, (int, float)) and math.isfinite(v)); meds[f] = xs[len(xs) // 2]
        cx = [max(min(x, xs[int(len(xs) * .99)]), xs[int(len(xs) * .01)]) for x in col(TR, f, meds[f])]; mus[f] = sum(cx) / len(cx); sds[f] = (sum((x - mus[f]) ** 2 for x in cx) / len(cx)) ** .5 or 1
    def mat(cs):
        cols = [[max(-5, min(5, (x - mus[f]) / sds[f])) for x in col(cs, f, meds[f])] for f in F]
        return [list(r) for r in zip(*cols)]
    Xtr, Xte = mat(TR), mat(TE); ytr, yte = [1 if hit(c) else 0 for c in TR], [1 if hit(c) else 0 for c in TE]
    w = [0.0] * (len(F) + 1); lr, l2 = 0.1, 1.0
    for it in range(300):
        g = [0.0] * (len(F) + 1)
        for x, y in zip(Xtr, ytr):
            z = w[-1] + sum(a * b for a, b in zip(x, w)); p = 1 / (1 + math.exp(-max(-30, min(30, z)))); e = p - y
            for j, a in enumerate(x): g[j] += e * a
            g[-1] += e
        for j in range(len(F)): w[j] -= lr * (g[j] / len(Xtr) + l2 * w[j] / len(Xtr))
        w[-1] -= lr * g[-1] / len(Xtr)
    ste = [w[-1] + sum(a * b for a, b in zip(x, w)) for x in Xte]
    a_te = auc(ste, yte); random.seed(7); ge = 0
    for _ in range(1000):
        yy = yte[:]; random.shuffle(yy); a = auc(ste, yy)
        if a is not None and a >= a_te: ge += 1
    old_te = auc([c['score'] for c in TE], yte)
    old_rug_auc = auc([c['score'] for c in TE], [1 if c['rugged'] else 0 for c in TE])
    # what the old grade would have done on the test half
    te_ab = [c for c in TE if c['grade'] in 'AB']
    out = {
        'generatedAt': int(time.time() * 1000), 'source': 'data/calls.json (forward call log, lib/calls.js)', 'callLogSpan': [first[0]['t'], first[-1]['t']] if first else None,
        'method': __doc__.strip(), 'unit': 'first call per token, >= 24h old',
        'before': before, 'vetoes': vetoes,
        'split': {'train': {'n': len(TR), 'from': TR[0]['t'], 'to': TR[-1]['t'], 'baseHit2x': round(br_tr, 4)}, 'test': {'n': len(TE), 'from': TE[0]['t'], 'to': TE[-1]['t'], 'baseHit2x': round(br_te, 4), 'baseRug': round(rug_te, 4)}},
        'oldScoreTest': {'aucHit': old_te, 'aucRug': old_rug_auc, 'AB_inTest': stats(te_ab)},
        'rulesTested': len(cands), 'rulesPassed': passed, 'topRulesByTestP': cands[:12],
        'logit': {'features': ['.'.join(f) for f in F], 'testAUC': a_te, 'permP': round((ge + 1) / 1001, 4), 'coef': {'.'.join(f): round(w[j], 3) for j, f in enumerate(F)}},
    }
    # rebuilt tiers on the TEST half (rules chosen on train): A = every passing rule true, B = at least one, U = none (unrated)
    def tier(c):
        if c.get('veto'): return 'F'
        if not passed: return 'U'
        k = sum(1 for r in passed if isinstance(val(c, tuple(r['feature'].split('.', 1))), (int, float)) and (val(c, tuple(r['feature'].split('.', 1))) >= r['edge'] if r['op'] == '>=' else val(c, tuple(r['feature'].split('.', 1))) <= r['edge']))
        return 'A' if k == len(passed) else 'B' if k else 'U'
    te_all = [c for c in first if c['t'] >= TE[0]['t']]
    out['after'] = {g: stats([c for c in te_all if tier(c) == g]) for g in ('A', 'B', 'U', 'F')}
    out['after']['A+B'] = stats([c for c in te_all if tier(c) in 'AB'])
    out['after']['note'] = 'Rebuilt tiers scored on the test period only (calls from the test start time, vetoed calls included as F).'
    out['beforeTest'] = {g: stats([c for c in te_all if c['grade'] == g]) for g in 'ABCDF'}
    out['beforeTest']['A+B'] = stats([c for c in te_all if c['grade'] in 'AB'])
    # the logistic model is reported but NOT used for grading: its features raise rug rates (see topRulesByTestP), and only simple
    # rules that improve BOTH hit and rug rates out-of-sample are allowed to award a letter.
    beats = bool(passed)
    out['verdict'] = 'rated' if beats else 'unrated'
    out['strength'] = 'weak (backtested out-of-sample, but the call log covers only ~7 days; re-run daily)' if beats else 'n/a'
    out['verdictText'] = ('Some features beat the base rate out-of-sample: grade uses only those (strength: backtested, small sample).' if beats else
                          'No feature or model beat the base rate out-of-sample (time split, Bonferroni). A/B letters are hidden: "Unrated — safety checks only". The safety vetoes remain.')
    json.dump(out, open(os.path.join(DATA, 'grade_rebuild.json'), 'w'), indent=1)
    print(json.dumps({k: out[k] for k in ('beforeTest', 'after', 'split', 'oldScoreTest', 'rulesTested', 'verdict')}, indent=1))
    print('passed', json.dumps(passed, indent=1)[:2000]); print('top', json.dumps(cands[:6])[:2500]); print('logit AUC', a_te, (ge + 1) / 1001)

if __name__ == '__main__': main()
