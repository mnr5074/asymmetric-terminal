#!/usr/bin/env python3
"""Render the Pattern Lab results table (markdown) from /api/patternlab (or lib/patternlab.js via node). Usage: pl_report.py [port]"""
import json, sys, subprocess, os, urllib.request
port = sys.argv[1] if len(sys.argv) > 1 else None
if port: d = json.load(urllib.request.urlopen(f'http://localhost:{port}/api/patternlab', timeout=60))
else:
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    d = json.loads(subprocess.run(['node', '-e', "const m=require('./lib/patternlab');process.stdout.write(JSON.stringify(m.shared(require('path').join(process.cwd(),'data')).table()))"], cwd=root, capture_output=True, text=True).stdout)
pv = lambda p: '–' if p is None else ('<0.001' if p < 0.001 else f'{p:.3f}')
hl = lambda h: '–' if h is None else f'{h:+.1f}h'
print('| # | Pattern | Status | Crashed (fired pre-peak) | Runners | p crash | p pump | Lead before dump | Lead before breakout | Verdict | Live flags | Composite |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|')
for r in d['rows']:
    b = r.get('backtest') or {}
    comp = (f"cap {r['cap']}" if r.get('cap') else '') + ((', ' if r.get('cap') else '') + f"{r['w']}" if r.get('w') else '') or '0 (info)'
    c = b.get('catalog'); vd = b.get('verdict', '–') + (f" · catalog {round(c['crash']*100)}% crash vs {round(c['pump']*100)}% pump events (n={c['n_crash']}/{c['n_pump']}, p crash {pv(c['p_crash'])})" if c else '')
    print(f"| {r['id']}{'★' if r.get('prio') else ''} | {r['name']} | {r['status']} | {b.get('crashed', '–')} | {b.get('runners', '–')} | {pv(b.get('p_crash'))} | {pv(b.get('p_pump'))} | {hl(b.get('lead_crash_h'))} | {hl(b.get('lead_pump_h'))} | {vd} | {r['live']['count']} | {comp} |")
