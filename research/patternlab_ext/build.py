#!/usr/bin/env python3
"""Merge expansion outputs -> data/patternlab_ext.json (served by lib/patternlab_ext.js at /api/patternlab/ext).
Adds Benjamini-Hochberg q-values across every tested row (core50 p when testable there, else full-catalog p) and the Nansen ledger."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extcommon as E

parts = [E.jload(f) or {} for f in ('patternlab_ext_38_42.json', 'patternlab_ext_aj.json', 'patternlab_ext_gen.json')]
rows = [r for p in parts for r in p.get('rows', [])]
def pick(r):
    c, f = r['backtest'].get('core50'), r['backtest'].get('full')
    if c and c.get('p_fisher') is not None and c.get('n_crashed') and c.get('n_runners'): return 'core50', c
    if f and f.get('p_fisher') is not None and f.get('n_crashed') and f.get('n_runners'): return 'full', f
    return None, None
tested = []
for r in rows:
    k, b = pick(r)
    r['primary_set'] = k
    if b:
        r.update({'hit_crashed': b['hit_crashed'], 'hit_runners': b['hit_runners'], 'p_fisher': b['p_fisher'], 'verdict': b.get('verdict'),
                  'p_crash_one_sided': b['crash']['p_one_sided'], 'p_pump_one_sided': b['pump']['p_one_sided'],
                  'crash_lead_h': b['crash']['lead_h_median'], 'pump_lead_h': b['pump']['lead_h_median'],
                  'false_flag_rate_crash': b['crash']['false_flag_rate'], 'false_flag_rate_pump': b['pump']['false_flag_rate'],
                  'n': f"{b['flag_crashed']}/{b['n_crashed']} crashed vs {b['flag_runners']}/{b['n_runners']} runners", 'era_matched': b.get('era_matched')})
        tested.append(r)
# BH over two-sided p
ps = sorted(tested, key=lambda r: r['p_fisher']); m = len(ps); prev = 1.0
for i in range(m - 1, -1, -1):
    q = min(prev, ps[i]['p_fisher'] * m / (i + 1)); ps[i]['q_bh'] = round(q, 4); prev = q
for r in rows:
    em = r.get('era_matched')
    r['robust'] = bool(r.get('q_bh') is not None and r['q_bh'] < 0.10 and (em is None or (em.get('p_fisher') or 1) < 0.10))
def sig(side):
    out = []
    for r in rows:
        for k, b in (r.get('backtest') or {}).items():
            p = (b or {}).get(side, {}).get('p_one_sided') if b else None
            if p is not None and p < 0.05: out.append(f"{r['id']} {r['name']} [{k}: p={p}, lead {b[side]['lead_h_median']}h]")
    return out
L = E.jload('patternlab_ext_nansen_ledger.json') or {}
lab = E.labeled()
out = {'schema': 'patternlab-ext-v1',
       'schema_doc': 'see PATTERN_LAB_EXT.md: row = {id, name, status built|wrapped|partial|not-feasible, status_why, explain, wraps[], hit_crashed, hit_runners, p_fisher, q_bh, verdict, p_crash_one_sided, p_pump_one_sided, crash_lead_h, pump_lead_h, false_flag_rate_crash, false_flag_rate_pump, n_live_flags, live_flags[], backtest{core50, full}, extra}',
       'datasets': {'core50': '30 crashed + 20 runners (data/patterns_flows.json), Nansen launch tapes for 50/50', 'full': 'research DB died (111) + mooned (62) with GeckoTerminal hourly OHLCV',
                    'events_labeled': (f'present ({len(lab)} events) — not yet scored by this build' if lab else 'data/events_labeled.json not present at build time')},
       'conventions': {'crash_lead_h': 'hours from flag to dump (crash break / first close <=70% of peak); negative = after', 'pump_lead_h': 'hours from flag to peak',
                       'pump_lead_vs_breakout': 'backtest.*.pump.lead_vs_breakout_h_median (Pattern Lab breakout = created + hours_to_2x)',
                       'early_window': 'tape rules: first 300 Nansen-indexed DEX trades (Nansen indexes pump.fun tokens from DEX migration, so for crashed tokens this is often at/after the curve peak); hourly rules: first 48 bars',
                       'era_matched': 'core50 subset created >= 2026-09-09 (crashed core50 is dominated by one Oct-10 launch batch)',
                       'robust': 'q_bh < 0.10 and era-matched p < 0.10 (when available)'},
       'nansen': {'credits_used': L.get('used'), 'calls': len(L.get('calls') or []), 'balance_start': L.get('balance_start'), 'balance_last': L.get('remaining'), 'cache_hits': L.get('cache_hits'),
                  'refused': L.get('refused'), 'soft_budget': 200, 'floor': 300},
       'summary': {'n_rows': len(rows), 'n_tested': len(tested),
                   'crash_predictive': sig('crash'), 'pump_predictive': sig('pump'),
                   'robust': [f"{r['id']} {r['name']} ({r['verdict']})" for r in rows if r.get('robust')]},
       'rows': rows}
E.save('patternlab_ext.json', out)
print(json.dumps(out['summary'], indent=1))
