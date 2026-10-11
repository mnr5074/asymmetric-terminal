"""Tape + bar helpers shared by the expansion rules (cache-only reads; never spends credits)."""
import os, sys, math, statistics as st
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extcommon as E
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'patternlab'))
import pl_fetch_nansen as F

def tape(t, kind='tape'):
    """Nansen dex-trades rows, ascending, with ts (unix) added. [] when not cached."""
    j = E.nansen('tgm/dex-trades', F.body(kind, t), cache_only=True)
    rows = (j or {}).get('data') or [] if isinstance(j, dict) else []
    out = []
    for r in rows:
        ts = E.P.tsof(r.get('block_timestamp'))
        if ts: r = dict(r); r['ts'] = ts; out.append(r)
    out.sort(key=lambda r: r['ts'])
    return out

def pre_peak(trades, t, cap=None):
    pk = t.get('peak_t')
    rows = [r for r in trades if not pk or r['ts'] < pk]
    return rows[:cap] if cap else rows

def bars_before(t, ts):
    return [b for b in (t.get('ohlcv') or []) if b[0] + 3600 <= ts]

def rets(bars):
    out = []
    for a, b in zip(bars, bars[1:]):
        if a[4] and b[4] and a[4] > 0 and b[4] > 0: out.append(math.log(b[4] / a[4]))
        else: out.append(0.0)
    return out

def rv(bars):
    r = rets(bars)
    return st.pstdev(r) if len(r) >= 3 else None

def median(v):
    v = [x for x in v if x is not None]
    return st.median(v) if v else None

def spearman(x, y):
    n = len(x)
    if n < 3: return None
    def rk(v):
        s = sorted(range(n), key=lambda i: v[i]); r = [0] * n
        for k, i in enumerate(s): r[i] = k
        return r
    a, b = rk(x), rk(y)
    d = sum((p - q) ** 2 for p, q in zip(a, b))
    return 1 - 6 * d / (n * (n * n - 1))

SM_WORDS = ('smart', 'fund', 'high balance', 'specialist', 'whale', 'kol', 'influencer', '\U0001f464')
def is_sm(label): return bool(label) and any(w in label.lower() for w in SM_WORDS) and 'deployer' not in label.lower()
def is_dev(label, t=None, addr=None):
    if label and 'deployer' in label.lower(): return True
    return bool(t and addr and t.get('db', {}).get('dev') == addr)

def early(trades, n=300):
    """age-matched early-life window: first n indexed DEX trades (Nansen indexes from DEX migration, so for pump.fun crashes this
    is often already at/after the bonding-curve peak; leads are reported signed, negative = after the event)."""
    return trades[:n]

def early_bars(t, n=48):
    ct = t.get('created_t') or 0
    return [b for b in (t.get('ohlcv') or []) if b[0] >= ct - 3600][:n]
