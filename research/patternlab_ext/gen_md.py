#!/usr/bin/env python3
"""Regenerate the results table inside PATTERN_LAB_EXT.md (between the AUTO markers) from data/patternlab_ext.json."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extcommon as E
d = E.jload('patternlab_ext.json')
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
md = os.path.join(ROOT, 'PATTERN_LAB_EXT.md')
f = lambda p: '–' if p is None else ('<.001' if p < 0.001 else f'{p:.3f}')
h = lambda x: '–' if x is None else f'{x:g}h'
pc = lambda x: '–' if x is None else f'{round(x * 100)}%'
L = ['| id | rule | status | set | crashed hit | runner hit | p crash (1-s) | p pump (1-s) | BH q | crash lead | pump lead | false-flag (as crash / as pump) | era-matched p | other set | live |', '|' + '---|' * 15]
for r in d['rows']:
    b = (r.get('backtest') or {}).get(r.get('primary_set')) if r.get('primary_set') else None
    o = [k for k, v in (r.get('backtest') or {}).items() if v and k != r.get('primary_set')]
    os_ = ''
    if o:
        x = r['backtest'][o[0]]; os_ = f"{o[0]}: {x['flag_crashed']}/{x['n_crashed']} vs {x['flag_runners']}/{x['n_runners']}, p={f(x['p_fisher'])} ({x['verdict']})"
    em = (b or {}).get('era_matched')
    L.append('| ' + ' | '.join(str(v) for v in [
        r['id'], r['name'] + (' ★' if r.get('robust') else ''), r['status'], r.get('primary_set') or '–',
        f"{b['flag_crashed']}/{b['n_crashed']} ({pc(b['hit_crashed'])})" if b else '–', f"{b['flag_runners']}/{b['n_runners']} ({pc(b['hit_runners'])})" if b else '–',
        f(b['crash']['p_one_sided']) if b else '–', f(b['pump']['p_one_sided']) if b else '–', f(r.get('q_bh')) if b else '–',
        h(b['crash']['lead_h_median']) if b else '–', h(b['pump']['lead_h_median']) if b else '–',
        f"{pc(b['crash']['false_flag_rate'])} / {pc(b['pump']['false_flag_rate'])}" if b else '–', f(em['p_fisher']) + f" ({em['flag_crashed']}/{em['n_crashed']} vs {em['flag_runners']}/{em['n_runners']})" if em else '–',
        os_ or '–', r.get('n_live_flags', 0)]) + ' |')
ex = {r['id']: r.get('extra') or {} for r in d['rows']}
x38 = ex.get(38, {}); x39 = ex.get(39, {})
L += ['', '**Rule 38 event-level (every dump/pump alert bar in the full catalog):**', '',
      f"- dump alerts: {json.dumps(x38.get('dump_alerts'))}", f"- pump alerts: {json.dumps(x38.get('pump_alerts'))}",
      '', '**Rule 39 event studies:**', '', f"- memecoin hourly: {json.dumps(x39.get('hourly_event_study'))}", f"- majors daily: {json.dumps(x39.get('daily_majors_event_study'))}",
      '', '**Rule 40 majors (DefiLlama mcap/TVL vs category, 90d-back test):** ' + json.dumps({k: v for k, v in (ex.get(40, {}).get('majors') or {}).items() if k != 'examples'}),
      '', '**Rule 42 top closed loops (core50 tapes):** ' + json.dumps(ex.get(42, {}).get('top_loops')),
      '', f"**Nansen (this job):** {json.dumps(d.get('nansen'))}", '', f"Generated {d.get('generatedAt')} (ms epoch)."]
txt = open(md).read() if os.path.exists(md) else '<!-- AUTO:START -->\n<!-- AUTO:END -->\n'
a, b = txt.split('<!-- AUTO:START -->')[0], txt.split('<!-- AUTO:END -->')[1]
open(md, 'w').write(a + '<!-- AUTO:START -->\n' + '\n'.join(L) + '\n<!-- AUTO:END -->' + b)
print('wrote', md)
