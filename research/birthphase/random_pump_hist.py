"""Unbiased historical random sample of pump.fun launches (both outcomes, no survivorship filter).
Every pump.fun create/create_v2 transaction references the pump mint-authority PDA TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM
(read-only) and ordinary trades do not, so getSignaturesForAddress on that account lists launches only. We take anchor
signatures at many past times (first trades of library tokens), read the 1000 launches just before each anchor and draw
K of them uniformly; getTransaction gives the mint. Output: data/birthphase/cache/pump_random_hist.json"""
import sys, os, json, random, sqlite3, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bp_common import sol, BP, DATA, wjson
import collect_pump as cp
AUTH = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM'
OUT = os.path.join(BP, 'cache', 'pump_random_hist.json')

def main(n_anchor=100, k=10):
    random.seed(11)
    db = sqlite3.connect(os.path.join(DATA, 'moonshot.db'))
    rows = [r for r in db.execute("select mint, created_ts from tokens where launchpad='pump.fun' and created_ts > 1775000000000 order by created_ts")]
    # spread anchors evenly in time (Apr..Oct 2026) and leave >=2 days for outcomes
    rows = [r for r in rows if r[1] < time.time() * 1000 - 2 * 86400e3]
    step = max(1, len(rows) // n_anchor); anchors = rows[::step][:n_anchor]
    out = json.load(open(OUT)) if os.path.exists(OUT) else []
    have = {o['mint'] for o in out}; done_anchor = {o['anchor_mint'] for o in out}
    for mint, cts in anchors:
        if mint in done_anchor: continue
        mm = cp.coin(mint)
        if not mm or not mm.get('created_timestamp'): continue
        cts = int(mm['created_timestamp'])
        tr, _, _ = cp.page(mint, '9999999999999999999999-%d' % (cts + 5000))
        if not tr or not tr[-1].get('tx'): continue
        try: sigs = sol('getSignaturesForAddress', [AUTH, {'before': tr[-1]['tx'], 'limit': 1000}])
        except Exception as e: print('sig err', e); continue
        sigs = [s for s in (sigs or []) if not s.get('err')]
        if not sigs: continue
        span = (sigs[0]['blockTime'] - sigs[-1]['blockTime']) if len(sigs) > 1 else None
        for s in random.sample(sigs, min(k, len(sigs))):
            try: t = sol('getTransaction', [s['signature'], {'maxSupportedTransactionVersion': 1, 'encoding': 'jsonParsed'}])
            except Exception as e: print('tx err', e); continue
            if not t: continue
            logs = ' '.join(t['meta'].get('logMessages') or [])
            if 'Instruction: Create' not in logs: continue
            mints = [b['mint'] for b in (t['meta'].get('postTokenBalances') or []) if b['mint'] not in ('So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')]
            keys = [kk['pubkey'] for kk in t['transaction']['message']['accountKeys']]
            m = mints[0] if mints else (keys[1] if len(keys) > 1 else None)
            if not m or m in have: continue
            have.add(m)
            out.append({'mint': m, 'ts': (t.get('blockTime') or 0) * 1000, 'anchor_mint': mint, 'anchor_ts': cts, 'window_launches': len(sigs), 'window_s': span})
        wjson(OUT, out)
        print(len(out), 'random launches; anchor', time.strftime('%Y-%m-%d', time.gmtime(cts / 1000)), 'launches/min ~', round(len(sigs) / max(1, span) * 60, 1) if span else None, flush=True)

if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 100, int(sys.argv[2]) if len(sys.argv) > 2 else 10)
