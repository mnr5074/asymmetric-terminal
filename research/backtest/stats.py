"""Stats helpers for the cross-detector backtest harness (stdlib only).
Trust tiers (applied identically to every detector, reused or replayed):
  proven   : leading signal, enough sample (case-control: >= 30 cases, >= 20 controls, >= 10 flagged cases; forward: >= 30 flagged
             events with >= 10 hits), p < 0.01 (or p < 0.05 with >= 100 cases / 300 events),
             and a real effect (lift >= 1.5, or AUC >= 0.65 / <= 0.35 for continuous scores).
  weak     : tested, but only partly meets the bar (small n, borderline p, coincident-only timing, or tested and found no edge;
             `edge` says which).
  untested : no historical data, too few positives (< 10), or no comparison group.
"""
import math

def binom_sf(k, n, p):
    """P(X >= k) for X ~ Binomial(n, p). Exact for n <= 3000, normal approx (continuity) above."""
    if n <= 0 or k <= 0: return 1.0
    if p <= 0: return 0.0 if k > 0 else 1.0
    if p >= 1: return 1.0
    if n > 3000:
        mu, sd = n * p, math.sqrt(n * p * (1 - p)); z = (k - 0.5 - mu) / sd
        return 0.5 * math.erfc(z / math.sqrt(2))
    lp, lq = math.log(p), math.log1p(-p); tot = 0.0
    for i in range(k, n + 1):
        tot += math.exp(math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * lp + (n - i) * lq)
    return min(1.0, tot)

def fisher_greater(a, b, c, d):
    """One-sided Fisher exact p for table [[a,b],[c,d]] (a = flagged positives) testing enrichment of a."""
    n1, n2, m = a + b, c + d, a + c; N = n1 + n2
    def lh(x): return math.lgamma(n1 + 1) - math.lgamma(x + 1) - math.lgamma(n1 - x + 1) + math.lgamma(n2 + 1) - math.lgamma(m - x + 1) - math.lgamma(n2 - m + x + 1) - (math.lgamma(N + 1) - math.lgamma(m + 1) - math.lgamma(N - m + 1))
    lo, hi = max(0, m - n2), min(n1, m)
    return min(1.0, sum(math.exp(lh(x)) for x in range(a, hi + 1))) if a <= hi else 0.0

def two_prop_p(a, n1, b, n2):
    """Two-sided two-proportion z-test p (used when Fisher would be slow: n > 5000)."""
    if not n1 or not n2: return None
    p = (a + b) / (n1 + n2)
    if p in (0, 1): return 1.0
    z = (a / n1 - b / n2) / math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    return math.erfc(abs(z) / math.sqrt(2))

def enrich_p(a, n1, b, n2):
    """One-sided p that rate a/n1 > b/n2."""
    if not n1 or not n2: return None
    if n1 + n2 <= 5000: return fisher_greater(a, n1 - a, b, n2 - b)
    p2 = two_prop_p(a, n1, b, n2); return p2 / 2 if a / n1 > b / n2 else 1 - p2 / 2

def median(xs):
    s = sorted(x for x in xs if x is not None and x == x)
    if not s: return None
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2

def mwu_auc(a, b):
    """AUC = P(a > b) + 0.5 P(a == b) and a two-sided normal-approx p (no tie correction)."""
    if not a or not b: return None, None
    allv = sorted([(v, 0) for v in a] + [(v, 1) for v in b]); ranks = [0.0] * len(allv); i = 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]: j += 1
        for k in range(i, j + 1): ranks[k] = (i + j) / 2 + 1
        i = j + 1
    r1 = sum(r for r, (v, g) in zip(ranks, allv) if g == 0); n1, n2 = len(a), len(b)
    u = r1 - n1 * (n1 + 1) / 2; auc = u / (n1 * n2)
    sd = math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12) or 1
    p = math.erfc(abs((u - n1 * n2 / 2) / sd) / math.sqrt(2))
    return auc, p

def tier(rec):
    """rec needs: n_pos (positives / crash cases tested), n_events, p, lift, auc, timing ('leading'|'coincident'|'descriptive'), has_control."""
    n_pos, n_ev, p, lift, auc = rec.get('n_pos') or 0, rec.get('n_events') or 0, rec.get('p'), rec.get('lift'), rec.get('auc')
    timing = rec.get('timing', 'leading')
    if not rec.get('has_control', True) or (n_pos < 10 and n_ev < 30) or p is None:
        return 'untested', None, 'not enough historical data or no comparison group'
    effect = (lift is not None and lift >= 1.5) or (auc is not None and (auc >= 0.65 or auc <= 0.35))
    some = (lift is not None and lift >= 1.2) or (auc is not None and (auc >= 0.57 or auc <= 0.43))
    hits = rec.get('hits')
    if rec.get('design') != 'forward' and rec.get('hit_pos') is not None and rec.get('n_neg'):      # case-control: need both groups reasonably sized
        enough = n_pos >= 30 and rec['n_neg'] >= 20 and (hits is None or hits >= 10)
    else:                                                        # forward events: enough flagged events AND hits
        enough = n_ev >= 30 and (hits is None or hits >= 10) or (n_ev >= 100 and hits is None)
    sig = p < 0.01 or (p < 0.05 and (n_pos >= 100 or n_ev >= 300))
    if effect and enough and sig and timing == 'leading':
        return 'proven', True, f'leading, significant (p={p:.2g}), effect size ok, n={max(n_pos, n_ev)}'
    if effect and sig and timing != 'leading':
        return 'weak', True, f'strong but {timing}: confirms a move already under way, no lead time'
    if some and p < 0.2:
        why = []
        if not enough: why.append('small sample')
        if not sig: why.append(f'p={p:.2g} not significant enough')
        if not effect: why.append('small effect')
        return 'weak', True, 'partial evidence: ' + (', '.join(why) or 'borderline')
    return 'weak', False, f'tested, no reliable edge (p={p:.2g}' + (f', lift={lift:.2f}' if lift is not None else '') + (f', AUC={auc:.2f}' if auc is not None else '') + ')'

def rnd(x, k=4):
    return None if x is None else round(x, k) if isinstance(x, float) else x
