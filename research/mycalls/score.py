#!/usr/bin/env python3
"""Martin's Calls scorer: data/martin_calls.json -> data/martin_calls_scored.json (served at /api/mycalls; works from the frozen file on Render).

For every call (time called, price at call, thesis in Martin's words, Gibi's verdict at the time):
  - gut = buy at the price at call and hold. 1d / 7d / 30d after the call: return, max gain and max drawdown (hourly closes after the
    call), reached 2x?, fell 50%?  A horizon is only 'done' once candles fetched after it ended exist; before that it shows 'so far'.
  - baseline = the same chain's median token over the same window: the Waking Up backtest pool (research/waking: ~325 Solana tokens
    incl. dead launchpad coins; Robinhood Chain rhscan pool), daily closes, tradable tokens only (30-day mean volume >= $5K), window
    starting at the last UTC daily close before the call. Also where the call ranks among those tokens (percentile).
  - Gibi = Gibi's verdict scored on the same call. 'stay out' = cash (0%) unless Gibi's own entry trigger fired inside the window
    (e.g. a 4h close above $0.00100): then entry at that 4h close, exit at the walk-away (daily close below X) or the horizon end.
    A walk-away hit before any entry ends the watch (no later entry). 'buy' = entry at the price at call with the same walk-away.
  - scorecard: calls, hit rate (7d return beat the chain median), median 7d/30d vs baseline, gut vs Gibi head-to-head, and a
    strength label: 'too few calls to judge' until 20 calls have a scored 7d; then backtested / unproven / weak (sign test).
Free data only (GeckoTerminal + DexScreener), all cached. Finished calls (30d done) are frozen and never refetched.
usage: python3 research/mycalls/score.py [--no-fetch]"""
import json, os, sys, time, math, statistics as st, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mc
HOUR, DAY = mc.HOUR, mc.DAY
HZ = [('1d', DAY), ('7d', 7 * DAY), ('30d', 30 * DAY)]
MIN_SCORED = 20; GUT_BET_PCT = 0.25; FLOOR = 5000

# ---------------- pure scoring (bars = [[t_open, o, h, l, c, v], ...] hourly, sorted) ----------------
def close_at(bars, ts):
    """Close of the last hourly bar that had closed by ts (bar closes at t_open + 1h). None if none."""
    c = None
    for b in bars:
        if b[0] + HOUR <= ts: c = b[4]
        else: break
    return c

def horizon(bars, t0, p0, h, data_until):
    """Gut result for one horizon. Window = hourly bars opening at/after the call (the bar the call fell inside is skipped: its
    close may predate the call), up to t0 + h. done = data fetched after the horizon ended."""
    end = t0 + h; lim = min(end, data_until); done = data_until >= end
    t1 = math.ceil(t0 / HOUR) * HOUR
    win = [b[4] for b in bars if b[0] >= t1 and b[0] + HOUR <= lim]
    if not win: return {'done': False, 'pending': True, 'endAt': end}
    c_end = close_at(bars, lim); hi, lo = max(win), min(win)
    r = {'done': done, 'endAt': end, 'asOf': lim, 'endPx': c_end, 'ret': c_end / p0 - 1, 'maxGain': hi / p0 - 1, 'maxDD': lo / p0 - 1,
         'hit2x': hi >= 2 * p0, 'drop50': lo <= 0.5 * p0, 'bars': len(win)}
    return r

def tf_closes(bars, size, data_until):
    """UTC-aligned bars of `size` seconds built from hourly: [(close_time, close)] for complete bars only."""
    g = {}
    for b in bars: g[b[0] // size] = b[4]  # bars sorted: last hourly close in the bucket wins
    return [((k + 1) * size, c) for k, c in sorted(g.items()) if (k + 1) * size <= data_until]

TF = {'4h': 4 * HOUR, '1d': DAY, '1h': HOUR}
def gibi_horizon(bars, t0, p0, g, h, data_until):
    end = t0 + h; lim = min(end, data_until); done = data_until >= end
    v = (g.get('verdict') or '').lower(); trig = g.get('entryTrigger') or {}; walk = g.get('walkAway') or {}
    buy = v.startswith(('buy', 'enter', 'in', 'long', 'starter'))
    ev = []
    if trig.get('closeAbove') and not buy: ev += [(t, 0, 'trig', c) for t, c in tf_closes(bars, TF.get(trig.get('tf', '4h'), 4 * HOUR), lim) if t > t0]
    if walk.get('closeBelow'): ev += [(t, 1, 'walk', c) for t, c in tf_closes(bars, TF.get(walk.get('tf', '1d'), DAY), lim) if t > t0]
    ev.sort()
    ent = (t0, p0) if buy else None; ext = None; why = None
    for t, _, k, c in ev:
        if ent is None:
            if k == 'walk' and c < walk['closeBelow']: why = f'walk-away hit before any entry ({walk.get("tf", "1d")} close {c:.4g} < {walk["closeBelow"]}): watch ended'; break
            if k == 'trig' and c > trig['closeAbove']: ent = (t, c)
        elif k == 'walk' and t > ent[0] and c < walk['closeBelow']: ext = (t, c, 'walk-away'); break
    if ent is None:
        return {'done': done, 'entered': False, 'ret': 0.0, 'why': why or ('stayed out: entry trigger did not fire' if trig.get('closeAbove') else 'stayed out')}
    if ext is None:
        c = close_at(bars, lim)
        if c is None: return {'done': False, 'pending': True, 'entered': True}
        ext = (lim, c, 'horizon end' if done else 'so far')
    return {'done': done, 'entered': True, 'entryAt': ent[0], 'entryPx': ent[1], 'entryHow': 'price at call' if buy else f'{trig.get("tf", "4h")} close above {trig["closeAbove"]}',
            'exitAt': ext[0], 'exitPx': ext[1], 'exitWhy': ext[2], 'ret': ext[1] / ent[1] - 1}

def baseline(series, t0, h, exclude=None, floor=FLOOR):
    """series: {token: (day0, closes[], vols[])} complete UTC days only. Window = last daily close before t0 -> +h days."""
    s_day = t0 // DAY - 1; hd = int(round(h / DAY)); rs, hit, drop, elig = [], 0, 0, 0
    for tid, (d0, c, v) in series.items():
        if exclude and tid.lower() == exclude.lower(): continue
        i = s_day - d0
        if i < 7 or i >= len(c) or not c[i]: continue
        w30 = v[max(0, i - 29):i + 1]
        if sum(w30) / len(w30) < floor: continue
        elig += 1; j = i + hd
        if j >= len(c): continue
        r = c[j] / c[i] - 1; rs.append(r); w = c[i + 1:j + 1]
        hit += max(w) >= 2 * c[i]; drop += min(w) <= 0.5 * c[i]
    out = {'eligible': elig, 'n': len(rs), 'windowStart': (s_day + 1) * DAY, 'windowEnd': (s_day + 1 + hd) * DAY}
    if len(rs) < 10 or len(rs) < 0.6 * elig: out['pending'] = True; return out, rs
    out.update({'median': st.median(rs), 'hit2xPct': round(100 * hit / len(rs), 1), 'drop50Pct': round(100 * drop / len(rs), 1)}); return out, rs

def binom_p(k, n):
    """One-sided sign test P(X >= k), X ~ Bin(n, 0.5)."""
    return sum(math.comb(n, i) for i in range(k, n + 1)) / 2 ** n if n else 1.0

def scorecard(items):
    med = lambda a: st.median(a) if a else None
    def side(key):
        S = [x for x in items if (x['h'].get(key) or {}).get('done')]
        base = [x for x in S if (x['h'][key].get('baseline') or {}).get('median') is not None]
        gut = [x['h'][key]['ret'] for x in S]; gb = [x['gibi'][key]['ret'] for x in S if (x['gibi'].get(key) or {}).get('done')]
        ex = [x['h'][key]['ret'] - x['h'][key]['baseline']['median'] for x in base]
        h2h = [x['h2h'].get(key) for x in S if x['h2h'].get(key)]
        return {'n': len(S), 'nBaseline': len(base), 'gutMedian': med(gut), 'baselineMedian': med([x['h'][key]['baseline']['median'] for x in base]),
                'gibiMedian': med(gb), 'excessMedian': med(ex), 'beatBaseline': sum(e > 0 for e in ex),
                'hit2x': sum(x['h'][key]['hit2x'] for x in S), 'drop50': sum(x['h'][key]['drop50'] for x in S),
                'gutWins': h2h.count('gut'), 'gibiWins': h2h.count('gibi'), 'ties': h2h.count('tie')}
    c = {'calls': len(items), 'd1': side('1d'), 'd7': side('7d'), 'd30': side('30d'), 'minScored': MIN_SCORED}
    s7 = c['d7']; n = s7['nBaseline']
    c['hitRate'] = (s7['beatBaseline'] / n) if n else None
    c['hitRateDef'] = 'share of calls whose 7d return beat the chain median token over the same 7 days'
    if s7['n'] < MIN_SCORED:
        c['strength'] = 'too few'; c['strengthNote'] = f'Too few calls to judge: {s7["n"]} of {MIN_SCORED} calls have a scored 7-day result. Until then the numbers are anecdotes, good or bad.'
    else:
        p = binom_p(s7['beatBaseline'], n)
        c['signP'] = round(p, 4)
        if s7['excessMedian'] is not None and s7['excessMedian'] > 0 and p < 0.05:
            c['strength'] = 'backtested'; c['strengthNote'] = f'Edge shows: beat the chain median on {s7["beatBaseline"]} of {n} calls at 7 days (sign test p={p:.3f}), median excess {100 * s7["excessMedian"]:+.1f} points.'
        elif s7['excessMedian'] is None or s7['excessMedian'] <= 0:
            c['strength'] = 'weak'; c['strengthNote'] = f'Weak: beat the chain median on {s7["beatBaseline"]} of {n} calls at 7 days; median excess {100 * (s7["excessMedian"] or 0):+.1f} points. No edge over picking a random token.'
        else:
            c['strength'] = 'unproven'; c['strengthNote'] = f'Unproven: ahead of the chain median (median excess {100 * s7["excessMedian"]:+.1f} points, {s7["beatBaseline"]} of {n}) but not by enough to rule out luck (sign test p={p:.3f}).'
    edge = c['strength'] == 'backtested'
    c['gutBet'] = {'pct': GUT_BET_PCT, 'edgeProven': edge, 'rule': f'Gut bet: {GUT_BET_PCT}% of portfolio per call until the scorecard proves an edge (20+ scored calls labelled backtested). Display only: nothing is traded automatically.',
                   'status': 'Edge shown on 20+ calls: you may revisit the size by hand (the panel never raises it on its own).' if edge else f'Stays at {GUT_BET_PCT}%: no proven edge yet.'}
    return c

# ---------------- driver ----------------
def chain_series(chain):
    """Waking Up backtest pool for the baseline: complete UTC days only."""
    try:
        sys.path.insert(0, os.path.join(mc.ROOT, 'research', 'waking')); import waking as W
        s = W.load_solana()[0] if chain == 'solana' else W.load_robinhood()[0] if chain == 'robinhood' else {}
    except Exception as e:
        print('baseline load', chain, e, file=sys.stderr); return {}, None
    out, newest = {}, 0
    for tid, x in s.items():
        d0, c, v = x['s']; fa = (x.get('fetchedAt') or 0) / 1000
        lc = min(len(c) - 1, int(fa // DAY) - 1 - d0)
        if lc < 8: continue
        out[tid] = (d0, [float(y) for y in c[:lc + 1]], [float(y) for y in v[:lc + 1]]); newest = max(newest, d0 + lc)
    return out, newest

def score_call(c, prev, fetch, bases, now):
    t0 = int(c['calledAt'] / 1000); p0 = float(c['priceAtCall']['usd'])
    if prev and prev.get('final') and prev.get('defHash') == def_hash(c): return prev  # frozen
    before = t0 + 31 * DAY + HOUR
    mc.OFFLINE[0] = not fetch
    ser = mc.usd_series(c['chain'], c['contract'], c.get('pool'), before if before < now - HOUR else None)
    bars = (ser or {}).get('bars') or []; until = int((ser or {}).get('fetchedAt') or 0)
    out = {k: c.get(k) for k in ('id', 'symbol', 'chain', 'contract', 'call', 'thesis', 'notes', 'priceAtCall', 'addedVia')}
    out['gibiDef'] = c.get('gibi') or {}  # Gibi's verdict as given at the time; out['gibi'][horizon] = that verdict scored
    out.update({'calledAt': c['calledAt'], 'calledAtPT': mc.pt_str(t0), 'lk': f'd:{c["chain"]}:{c["contract"]}', 'defHash': def_hash(c)})
    if ser: out['series'] = {'how': ser['how'], 'pool': ser['pool'].get('pool'), 'poolName': ser['pool'].get('name'), 'guard': ser.get('guard'), 'fetchedAt': until * 1000, 'lastBarAt': (bars[-1][0] * 1000) if bars else None}
    nb = min(bars, key=lambda b: abs(b[0] + HOUR - t0)) if bars else None
    if nb: out['candleAtCall'] = {'usd': nb[4], 'closeAt': (nb[0] + HOUR) * 1000, 'how': 'hourly candle close nearest the call time (cross-check, ' + ('USD rebuilt via quote token' if ser.get('guard') else 'GeckoTerminal USD') + ')',
                                  'vsPriceAtCallPct': round(100 * (nb[4] / p0 - 1), 1)}
    out['h'], out['gibi'], out['h2h'] = {}, {}, {}
    for k, h in HZ:
        r = horizon(bars, t0, p0, h, until) if bars else {'done': False, 'pending': True, 'endAt': t0 + h}
        bs, rs = bases.get(c['chain'], ({}, None))[0], None
        if bs and r.get('done'):
            b, rs = baseline(bs, t0, h, c['contract']); r['baseline'] = b
            if rs and b.get('median') is not None: r['beatsBaseline'] = r['ret'] > b['median']; r['pctile'] = round(100 * sum(x < r['ret'] for x in rs) / len(rs))
        elif r.get('done'): r['baseline'] = {'pending': True, 'note': 'no baseline pool for this chain'}
        out['h'][k] = r
        g = gibi_horizon(bars, t0, p0, c.get('gibi') or {}, h, until) if bars else {'done': False, 'pending': True}
        out['gibi'][k] = g
        if r.get('done') and g.get('done'):
            d = r['ret'] - g['ret']; out['h2h'][k] = 'tie' if abs(d) < 0.005 else 'gut' if d > 0 else 'gibi'
    out['final'] = bool(out['h']['30d'].get('done') and (out['h']['30d'].get('baseline') or {}).get('median') is not None and out['gibi']['30d'].get('done'))
    if bars: out['lastCandle'] = {'usd': bars[-1][4], 'closeAt': (bars[-1][0] + HOUR) * 1000}
    if prev and prev.get('nowAtScore'): out['nowAtScore'] = prev['nowAtScore']  # replaced below when this run fetches
    return out

def def_hash(c):
    import hashlib
    return hashlib.sha1(json.dumps({k: c.get(k) for k in ('calledAt', 'priceAtCall', 'gibi', 'contract', 'chain', 'pool')}, sort_keys=True).encode()).hexdigest()[:12]

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--no-fetch', action='store_true'); a = ap.parse_args()
    now = int(time.time()); C = mc.load_calls()
    try: prev = {x['id']: x for x in json.load(open(mc.OUT_F)).get('items', [])}
    except Exception: prev = {}
    chains = sorted({c['chain'] for c in C['calls']})
    bases = {ch: chain_series(ch) for ch in chains}
    items = []
    for c in C['calls']:
        try: items.append(score_call(c, prev.get(c['id']), not a.no_fetch, bases, now))
        except Exception as e:
            print('score', c.get('id'), repr(e), file=sys.stderr)
            if c['id'] in prev: items.append(prev[c['id']])
    # live 'now' at scoring time (the panel re-asks /api/liveprice on every load; this is the snapshot fallback)
    if not a.no_fetch:
        for ch in chains:
            live = mc.dexscreener(ch, [x['contract'] for x in items if x['chain'] == ch])
            for x in items:
                if x['chain'] == ch and x['contract'] in live: x['nowAtScore'] = {**live[x['contract']], 'at': now * 1000}
    items.sort(key=lambda x: -x['calledAt'])
    out = {'generatedAt': now * 1000, 'scorecard': scorecard(items), 'items': items,
           'baselinePool': {ch: {'tokens': len(bases[ch][0]), 'lastCompleteDayUtc': time.strftime('%Y-%m-%d', time.gmtime(bases[ch][1] * DAY)) if bases[ch][1] else None} for ch in chains},
           'method': {'gut': 'buy at the price at call, hold; returns on hourly closes after the call', 'baseline': 'median token of the same chain (Waking Up backtest pool, tradable: 30-day mean volume >= $5K), daily closes from the last UTC close before the call',
                      'gibi': "Gibi's verdict at the time: 'stay out' = 0% unless Gibi's own entry trigger fired in the window (then entry at that close, exit at walk-away or horizon end)",
                      'hit': 'hit = 7d return beat the chain median', 'strength': f'too few calls to judge until {MIN_SCORED} scored 7d calls; then sign test vs the chain median: backtested (p<0.05, median excess > 0) / unproven / weak (median excess <= 0)'},
           'fetch': mc.CALLS}
    mc.save_json(mc.OUT_F, out)
    print(json.dumps({'items': len(items), 'calls': mc.CALLS, 'strength': out['scorecard']['strength']}))

if __name__ == '__main__': main()
