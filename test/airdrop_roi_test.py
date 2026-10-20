#!/usr/bin/env python3
"""Airdrop ROI: model math, labels, ranking tiers, no secrets. Run: python3 test/airdrop_roi_test.py"""
import json, math, os, re, sys
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.join(ROOT, 'research'))
import airdrops_roi as M

seed = json.load(open(os.path.join(ROOT, 'data', 'airdrop_roi_seed.json')))
out = json.load(open(os.path.join(ROOT, 'data', 'airdrop_roi.json')))
ok = 0
def check(c, msg):
    global ok
    assert c, msg
    ok += 1

# every numeric input is labelled
KINDS = {'sourced', 'derived', 'assumed', 'unknown'}
for c in seed['candidates']:
    for k, v in c.items():
        if isinstance(v, dict) and ('base' in v or 'usd' in v or k in ('participants', 'fdv')):
            check(v.get('kind') in KINDS, f"{c['key']}.{k} has no sourced/assumed label")
    for f in ('actions', 'budget_cap', 'time', 'stop', 'claim'):
        check(c['plan'].get(f) not in (None, '', []), f"{c['key']} plan.{f} missing")
    check(c['us'] in ('allowed', 'restricted', 'unknown'), c['key'] + ' us status')
for r in seed['calibration']:
    check(r['wallets'] > 0 and r['tokens'] > 0 and r['src'].startswith('https://'), r['sym'] + ' calibration row')

# per_wallet math: EV = p * fdv * comm / participants * k
cal = {'buckets': {}}
you = seed['you']
c = {'model': 'per_wallet', 'p_token': {'lo': .5, 'base': .5, 'hi': .5}, 'fdv': {'lo': 1e9, 'base': 1e9, 'hi': 1e9}, 'comm_pct': {'lo': 10, 'base': 10, 'hi': 10},
     'participants': {'lo': 1e5, 'base': 1e5, 'hi': 1e5}, 'k': {'lo': 1, 'base': 1, 'hi': 1}, 'weeks_left': {'lo': 4, 'base': 4, 'hi': 4},
     'hours_week': {'lo': 1, 'base': 1, 'hi': 1}, 'weekly_cost': {'lo': 5, 'base': 5, 'hi': 5}, 'capital': {'base': 0}, 'risk_yr': {'base': 0}}
m = M.model(c, cal, you, {})
check(abs(m['ev']['base'] - 500) < 1e-6, f"per_wallet EV {m['ev']['base']}")
cost = 4 * 1 * you['hourly_value_usd']['base'] + 4 * 5
check(abs(m['cost']['base']['total'] - cost) < 1e-6, 'cost = time + fees')
check(abs(m['roi']['base'] - round(500 / cost, 2)) < 1e-9, 'ROI = EV / cost')

# weekly pool: remaining points cap binds
w = dict(c, model='weekly_pool', total_points={'lo': 1e6, 'base': 1e6, 'hi': 1e6}, weekly_pool={'lo': 1e5, 'base': 1e5, 'hi': 1e5}, points_left={'lo': 0, 'base': 0, 'hi': 0})
check(M.model(w, cal, you, {})['ev']['base'] == 0, 'exhausted points pool gives zero EV')
w['points_left'] = None; del w['points_left']
ev = M.model(w, cal, you, {})['ev']['base']  # 4 wk * 1e5 / 1e5 people = 4 pts of 1e6 -> 4e-6 * 0.5*1e9*0.1 = 200
check(abs(ev - 200) < 1e-6, f'weekly pool EV {ev}')

# more participants -> lower EV and lower saturation score (monotonic)
c2 = dict(c, participants={'lo': 1e6, 'base': 1e6, 'hi': 1e6})
check(M.model(c2, cal, you, {})['ev']['base'] < m['ev']['base'], 'crowding lowers EV')
check(M.saturation(c2, {'posts7d': 100})['score'] < M.saturation(c, {'posts7d': 100})['score'], 'crowding lowers saturation score')
check(M.saturation(c, {'posts7d': 5000})['score'] < M.saturation(c, {'posts7d': 50})['score'], 'hype lowers saturation score')

# spearman sanity
check(M.spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])[0] == -1.0, 'spearman -1')

# output: ranges ordered, tiers ordered, restricted never first, unknowns stay unknown
order = {'allowed': 0, 'unknown': 1, 'restricted': 2}
tiers = [order[r['tier']] for r in out['candidates']]
check(tiers == sorted(tiers), 'tiers sorted allowed > unknown > restricted')
for r in out['candidates']:
    e = r['ev']
    if None not in e.values():
        check(e['lo'] <= e['base'] <= e['hi'], r['key'] + ' EV range ordered')
    check(r['strength'].startswith('unproven'), r['key'] + ' strength label')
check(out['calibration']['n'] >= 10, 'calibration sample size')
check(all(r['per_wallet_usd'] for r in out['calibration']['rows']), 'all calibration drops priced')

# no secrets in committed files
pat = re.compile(r'(api[_-]?key|secret|private[_-]?key|seed phrase\s*[:=]|NTFY_TOPIC\s*=|-----BEGIN)', re.I)
for f in ('data/airdrop_roi_seed.json', 'data/airdrop_roi.json', 'data/airdrop_roi_xcounts.json', 'research/airdrops_roi.py', 'scripts/airdrop_roi_weekly.sh'):
    txt = open(os.path.join(ROOT, f)).read()
    check(not pat.search(txt), 'possible secret in ' + f)
print(f'airdrop_roi_test: {ok} checks passed')
