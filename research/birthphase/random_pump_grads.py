"""Unbiased random sample of pump.fun GRADUATIONS (migrations), to estimate P(reach $X | graduated) without
survivorship/enrichment bias. Migration transactions are signed by the pump.fun migration account
39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg (log 'Instruction: Migrate'/'MigrateV2'). Same anchor method as
random_pump_hist.py. Output: data/birthphase/cache/pump_random_grads.json"""
import sys, os, json, random, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bp_common import sol, BP, wjson
import collect_pump as cp
MIG = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg'
OUT = os.path.join(BP, 'cache', 'pump_random_grads.json')
HIST = os.path.join(BP, 'cache', 'pump_random_hist.json')

def main(n_anchor=60, k=12):
    random.seed(13)
    anchors = json.load(open(HIST)) if os.path.exists(HIST) else []
    anchors = [a for a in anchors if a.get('ts') and a['ts'] < time.time() * 1000 - 3 * 86400e3]
    # one anchor per original anchor window
    seen_w, A = set(), []
    for a in anchors:
        if a['anchor_mint'] not in seen_w: seen_w.add(a['anchor_mint']); A.append(a)
    A = A[:n_anchor]
    out = json.load(open(OUT)) if os.path.exists(OUT) else []
    have = {o['mint'] for o in out}; done = {o['anchor'] for o in out}
    for a in A:
        if a['mint'] in done: continue
        tr, _, _ = cp.page(a['mint'], '9999999999999999999999-%d' % (a['ts'] + 5000))
        if not tr or not tr[-1].get('tx'): continue
        try: sigs = sol('getSignaturesForAddress', [MIG, {'before': tr[-1]['tx'], 'limit': 1000}])
        except Exception as e: print('sig err', e); continue
        sigs = [s for s in sigs or [] if not s.get('err')]
        got = 0
        for s in random.sample(sigs, min(k, len(sigs))):
            try: t = sol('getTransaction', [s['signature'], {'maxSupportedTransactionVersion': 1, 'encoding': 'jsonParsed'}])
            except Exception as e: continue
            if not t: continue
            logs = ' '.join(t['meta'].get('logMessages') or [])
            if 'Instruction: Migrate' not in logs: continue
            ms = [b['mint'] for b in t['meta'].get('postTokenBalances') or [] if b['mint'].endswith('pump') or b['mint'] not in ('So11111111111111111111111111111111111111112',)]
            ms = [m for m in ms if m != 'So11111111111111111111111111111111111111112']
            if not ms or ms[0] in have: continue
            have.add(ms[0]); got += 1
            out.append({'mint': ms[0], 'grad_ts': (t.get('blockTime') or 0) * 1000, 'anchor': a['mint']})
        out.append({'mint': None, 'anchor': a['mint'], 'sampled': min(k, len(sigs)), 'migrations': got}) if got == 0 else None
        wjson(OUT, out)
        print(len([o for o in out if o.get('mint')]), 'random graduations', time.strftime('%Y-%m-%d', time.gmtime(a['ts'] / 1000)), 'hit', got, '/', min(k, len(sigs)), flush=True)

if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 60, int(sys.argv[2]) if len(sys.argv) > 2 else 12)
