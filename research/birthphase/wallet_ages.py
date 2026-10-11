"""Wallet age (first-ever transaction) for the first early buyers of every Solana launch in the raw caches.
getSignaturesForAddress(wallet) paged newest->oldest, max PAGES pages. If the last page is short we reached the wallet's
first signature (exact age). Otherwise only a bound is known. Output cache: data/birthphase/cache/wallet_ages.json
(full addresses stay on the box; the library only carries short ids + ages)."""
import sys, os, json, glob, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bp_common import sol, BP, wjson
OUT = os.path.join(BP, 'cache', 'wallet_ages.json')
PAGES, PER_TOKEN = 2, int(os.environ.get('BP_AGES_PER_TOKEN', 8))
PRI = {'catalog_runner': 0, 'catalog_crash': 0, 'random': 1, 'screener_db': 2, 'pad_active_sample': 3, 'pad_listing_sample': 3}

def first_buyers():
    out = []
    for f in glob.glob(os.path.join(BP, 'cache', 'raw', 'pump', '*.json')):
        try: d = json.load(open(f))
        except Exception: continue
        cr = (d.get('meta') or {}).get('creator'); seen = []
        for t in d.get('trades') or []:
            if t['ty'] == 'buy' and t['pg'] == 'pump' and t['u'] != cr and t['u'] not in seen: seen.append(t['u'])
            if len(seen) >= PER_TOKEN: break
        out += [(PRI.get(d.get('stratum'), 4), w) for w in seen]
    for f in glob.glob(os.path.join(BP, 'cache', 'raw', 'solpads', '*.json')):
        try: d = json.load(open(f))
        except Exception: continue
        tx = d.get('first_txs') or []; cr = tx[0]['u'] if tx and tx[0].get('create') else None; seen = []
        for t in tx:
            if t.get('tok', 0) > 0 and t['u'] != cr and t['u'] not in seen: seen.append(t['u'])
            if len(seen) >= PER_TOKEN: break
        out += [(PRI.get(d.get('stratum'), 4), w) for w in seen]
    best = {}
    for p, w in out: best[w] = min(p, best.get(w, 9))
    return sorted(best, key=lambda w: best[w])

def age(w):
    before, n, oldest = None, 0, None
    for _ in range(PAGES):
        o = {'limit': 1000}
        if before: o['before'] = before
        r = sol('getSignaturesForAddress', [w, o], ttl=None if before else 30 * 86400)
        if not r: break
        n += len(r); oldest = r[-1].get('blockTime'); before = r[-1]['signature']
        if len(r) < 1000: return {'first_ts': (oldest or 0) * 1000, 'n': n, 'exact': True}
    return {'first_ts': (oldest or 0) * 1000 if oldest else None, 'n': n, 'exact': False}

if __name__ == '__main__':
    A = json.load(open(OUT)) if os.path.exists(OUT) else {}
    ws = [w for w in first_buyers() if w not in A]
    lim = int(sys.argv[1]) if len(sys.argv) > 1 else len(ws)
    print(len(ws), 'wallets to resolve; doing', min(lim, len(ws)), flush=True)
    t0 = time.time()
    for i, w in enumerate(ws[:lim], 1):
        try: A[w] = age(w)
        except Exception as e: A[w] = {'err': str(e)[:80]}
        if i % 50 == 0:
            wjson(OUT, A); print(i, int(time.time() - t0), 's', flush=True)
    wjson(OUT, A); print('done', len(A))
