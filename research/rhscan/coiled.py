"""Early 'Coiled' tier for the Robinhood Chain PRIORS-pattern scanner (imported by rh_scan.py).

Coiled = a very tight, quiet base after a 45-70% pullback, with volume starting to rise while price is
still at or BELOW the base top. Plan: 1/4-size starter, stop just under the base low, add the rest only on a
confirmed break of the base top (a 4h close above it with volume >= 1.5x the base average, which is the
same volume rule as the existing Trigger).

PRE-DECLARED TEST (fixed in this file before any result was seen; numbers in data/rh_scan.json -> coiled):
  base        = the 12 bars (2 days) ending 3 bars before the signal bar; "recent" = the last 3 bars
  context     = base-end close 45-70% below the highest close before it; base avg volume <= 50% of the
                busiest 2-day stretch; >= 3 days of history
  tightness T = base close range (max close / min close) <= T,       T in {1.15, 1.25, 1.35}
  volume    V = recent 3-bar avg volume / base avg volume >= V,       V in {1.3, 1.6, 2.0}
  position    = every recent close <= base top (max base close) and >= base low (min base low)
  dedupe      = one signal per token per 7 days (per grid cell)
  outcomes    = same as the Trigger replay: 2x before -30% from entry within 7 days (42 x 4h bars);
                -30% first; plus false alarm = no 4h close above the base top within 3 days (18 bars),
                and the plan stop (4h close under base low -2%) hit before 2x
  display     = if no cell is chosen, current candidates are shown with the middle cell (T=1.25, V=1.6), labelled experimental
  split       = median timestamp of the random-daily-entry sample (same tokens); earlier < split <= later
  selection   = on the EARLIER split only: among cells with n >= 15, max (hit% - drop%), ties -> larger n
  ship rule   = on the LATER split the chosen cell must have n >= 20 on >= 8 tokens AND
                (hit% - drop%) >= random-daily (hit% - drop%) + 5 points AND hit% > random hit%.
                Otherwise it is published only as 'experimental, did not beat random'.
"""
import statistics as st

Q, RECENT, FWD, BREAK_N, STOP = 12, 3, 42, 18, 0.70
T_GRID = [1.15, 1.25, 1.35]
V_GRID = [1.3, 1.6, 2.0]
DEFAULT_CELL = (1.25, 1.6)
MIN_EARLY_N, MIN_LATE_N, MIN_LATE_TOKENS, EDGE_PTS = 15, 20, 8, 5.0
STOP_UNDER_BASE = 0.98

def prep(b):
    """Per-token rolling arrays: 12-bar mean volume ending at k, its running max, running max close."""
    roll, pmax, cmax, m, cm = [], [], [], 0.0, 0.0
    for k in range(len(b)):
        r = st.mean(x['v'] for x in b[k - Q + 1:k + 1]) if k >= Q - 1 else 0.0
        m = max(m, r); cm = max(cm, b[k]['c'])
        roll.append(r); pmax.append(m); cmax.append(cm)
    return {'roll': roll, 'pmax': pmax, 'cmax': cmax}

def coil_at(b, i, T, V, P=None):
    """Coiled state at bar i using bars <= i only, or None."""
    if i < Q + RECENT + 6: return None
    if (b[i]['t'] - b[0]['t']) / 86400 < 3: return None
    w = b[i - RECENT - Q + 1:i - RECENT + 1]; rec = b[i - RECENT + 1:i + 1]
    wc = [x['c'] for x in w]
    top, low = max(wc), min(x['l'] for x in w)
    if min(wc) <= 0 or top / min(wc) > T: return None
    P = P or prep(b)
    s0 = i - RECENT - Q + 1                                     # first base bar
    peak = P['cmax'][s0 - 1] if s0 > 0 else top                 # highest close before the base
    dd = 1 - wc[-1] / peak if peak else 0
    if not (0.45 <= dd <= 0.70): return None
    qv = st.mean(x['v'] for x in w)
    peakv = P['pmax'][i - RECENT]
    if not peakv or qv / peakv > 0.5 or qv <= 0: return None
    vr = st.mean(x['v'] for x in rec) / qv
    if vr < V: return None
    if any(x['c'] > top or x['c'] < low for x in rec): return None
    return {'baseTop': top, 'baseLow': low, 'range': top / min(wc), 'volRatio': vr, 'dd': dd, 'peakClose': peak, 'baseVol': qv}

def coil_outcome(b, i, c):
    e = b[i]['c']; fw = b[i + 1:i + 1 + FWD]
    if not fw: return None
    best = max(x['h'] for x in fw) / e
    jb = max(range(len(fw)), key=lambda j: fw[j]['h'])
    drop = any(x['l'] <= e * STOP for x in fw[:jb + 1])
    stop_lvl = c['baseLow'] * STOP_UNDER_BASE
    # plan stop before 2x?
    j2 = next((j for j, x in enumerate(fw) if x['h'] >= 2 * e), None)
    seg = fw if j2 is None else fw[:j2 + 1]
    planstop = any(x['c'] <= stop_lvl for x in seg)   # plan stop is a 4h CLOSE under base low -2%
    brk = next((j for j, x in enumerate(fw[:BREAK_N]) if x['c'] > c['baseTop']), None)
    return {'best7d': round(best, 3), 'stopFirst': drop, 'complete': len(fw) == FWD, 'falseAlarm': brk is None and len(fw) >= BREAK_N,
            'planStopFirst': planstop, 'end7d': round(fw[-1]['c'] / e, 3)}

def summ(rows):
    d = [r for r in rows if r['complete']]
    n = len(d)
    if not n: return {'n': 0, 'tokens': 0}
    h = sum(1 for r in d if r['best7d'] >= 2 and not r['stopFirst']); s = sum(1 for r in d if r['stopFirst'])
    out = {'n': n, 'tokens': len({r['token'] for r in d}), 'hit2xBeforeDrop': h, 'hitPct': round(100 * h / n, 1),
           'dropFirst': s, 'dropPct': round(100 * s / n, 1), 'netPts': round(100 * (h - s) / n, 1),
           'medianBest7d': round(st.median(r['best7d'] for r in d), 2), 'medianEnd7d': round(st.median(r['end7d'] for r in d), 2)}
    if 'falseAlarm' in d[0]:
        fa = sum(1 for r in d if r['falseAlarm']); ps = sum(1 for r in d if r['planStopFirst'])
        out.update({'falseAlarm3d': fa, 'falseAlarmPct': round(100 * fa / n, 1), 'planStopFirst': ps, 'planStopFirstPct': round(100 * ps / n, 1)})
    return out

def run(series, trig_sig, base_sig):
    """series: {addr: (sym, bars)}; trig_sig/base_sig: lists with 't', 'token', outcome fields (from rh_scan.backtest)."""
    ts = sorted(r['t'] for r in base_sig if r.get('complete'))
    split = ts[len(ts) // 2] if ts else 0
    cells = {}; PREP = {}
    for T in T_GRID:
        for V in V_GRID:
            rows = []
            for addr, (sym, b) in series.items():
                last = -10**9; pc = PREP.setdefault(addr, prep(b))
                for i in range(Q + RECENT + 6, len(b) - 1):
                    if i - last < FWD: continue
                    c = coil_at(b, i, T, V, pc)
                    if not c: continue
                    o = coil_outcome(b, i, c)
                    if o: last = i; rows.append({'token': addr, 'symbol': sym, 't': b[i]['t'], **o})
            cells[(T, V)] = rows
    early = lambda rows: [r for r in rows if r['t'] < split]
    late = lambda rows: [r for r in rows if r['t'] >= split]
    grid = []
    for (T, V), rows in cells.items():
        grid.append({'T': T, 'V': V, 'early': summ(early(rows)), 'late': summ(late(rows)), 'all': summ(rows)})
    elig = [g for g in grid if g['early']['n'] >= MIN_EARLY_N]
    chosen = max(elig, key=lambda g: (g['early']['netPts'], g['early']['n'])) if elig else None
    rand = {'early': summ(early(base_sig)), 'late': summ(late(base_sig)), 'all': summ(base_sig)}
    trig = {'early': summ(early(trig_sig)), 'late': summ(late(trig_sig)), 'all': summ(trig_sig)}
    ship, why = False, 'no grid cell had n >= %d on the earlier split' % MIN_EARLY_N
    if chosen:
        L, R = chosen['late'], rand['late']
        fails = []
        if L['n'] < MIN_LATE_N: fails.append(f"later-split n={L['n']} < {MIN_LATE_N}")
        if L.get('tokens', 0) < MIN_LATE_TOKENS: fails.append(f"only {L.get('tokens', 0)} tokens < {MIN_LATE_TOKENS}")
        if L['n'] and R['n']:
            if L['netPts'] < R['netPts'] + EDGE_PTS: fails.append(f"net {L['netPts']} pts vs random {R['netPts']} pts (needs +{EDGE_PTS})")
            if L['hitPct'] <= R['hitPct']: fails.append(f"hit {L['hitPct']}% <= random {R['hitPct']}%")
        ship = not fails
        why = 'passed the pre-declared ship rule on the later split' if ship else '; '.join(fails)
    return {'split': split, 'grid': grid, 'chosen': {'T': chosen['T'], 'V': chosen['V']} if chosen else None,
            'chosenResult': chosen, 'random': rand, 'trigger': trig, 'ship': ship, 'shipWhy': why,
            'signals': sorted(([{**r} for r in cells[(chosen['T'], chosen['V'])]] if chosen else []), key=lambda r: -r['t'])[:60]}

def plan(sym, price, c, liq, peak):
    """Coiled plan: 1/4 starter now, stop under base low, add 3/4 on a confirmed break of the base top."""
    stop = c['baseLow'] * STOP_UNDER_BASE
    risk = 1 - stop / price if price > stop else None
    if not risk: return None
    normal = round(min(1.0, 0.5 / (risk * 100) * 100), 2)        # same sizing as the Trigger plan: 0.5% risk, cap 1%
    starter = round(normal / 4, 3)
    liq_cap = round(0.01 * liq) if liq else None
    add_at = c['baseTop']
    avg_if_added = (price * 0.25 + add_at * 0.75)
    two = avg_if_added * 2
    first, second = sorted([(peak, 'prior peak close'), (two, '2x the blended entry')])
    return {
        'entry': f'Starter now near {price:.6g}: 1/4 of normal size. Add the other 3/4 only on a 4h close above the base top {add_at:.6g} with volume >= 1.5x the base average (the Trigger). Skip the add if it is already more than 15% above ({add_at * 1.15:.6g}).',
        'size': f'starter {starter}% of portfolio (normal size {normal}% = 0.5% risk to the stop, capped at 1%); full {normal}% only after the break' + (f'; never more than ${liq_cap:,} total (1% of pool liquidity)' if liq_cap else ''),
        'starterPct': starter, 'normalPct': normal, 'addAt': add_at, 'maxUsdByLiquidity': liq_cap,
        'sells': [f'Sell 1/3 at {first[0]:.6g} ({first[1]})', f'Sell 1/3 at {second[0]:.6g} ({second[1]})', 'Trail the last 1/3: exit on a 4h close 35% below the highest close since entry'],
        'sellLevels': [first[0], second[0]],
        'walkAway': [f'Stop: 4h close below {stop:.6g} (2% under the base low {c["baseLow"]:.6g}): exit everything; the starter risks about {risk * 100:.0f}% of itself = {starter * risk:.2f}% of portfolio',
                     'No break of the base top within 3 days: exit the starter (the replay\'s false-alarm window)',
                     'Pool liquidity drops 40%+, top-10 holders rise above 50%, or a honeypot/tax flag appears: exit'],
        'stop': stop, 'riskToStopPct': round(risk * 100, 1),
    }
