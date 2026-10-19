# python3 test/rhscan_sticky_test.py : sticky list keeps carded tokens, flags missing ones (with reasons), tracked pools are pinned.
import os, sys, json, tempfile
d = tempfile.mkdtemp(); os.environ['DATA_DIR'] = d
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'research', 'rhscan'))
import rh_scan as R
assert R.FORCE['0xaa5751ff3fb61e613993b2eb4eab1fce017081fc'].startswith('HYDX')
assert R.PINNED['0xaa5751ff3fb61e613993b2eb4eab1fce017081fc'] == '0x2f509c6e2675a1a7945902c64ba4aefaef32b2fbf34245f12078a1d0573db170'
for k in ('0xedbf91223639800bcd5756815caf908df3b890be', '0x63ee32ac3077d1fbd8a77ebba2a6ed4b8e9c1e18', '0x18e674231a58c239dc7daedcffe15ec3a24cff5c'): assert k in R.PINNED
st = {'0xold': {'symbol': 'OLD', 'lastSeen': 1}, '0xthin': {'symbol': 'THIN'}, '0xshort': {'symbol': 'SHORT'}}
out = [{'token': '0xnew', 'symbol': 'NEW', 'pool': '0xp', 'state': 'Setup'}]
best = {'0xthin': {'liq': 900}, '0xshort': {'liq': 50000}, '0xnew': {'liq': 1e5}}
miss = R.update_sticky(st, out, best, {'0xshort': 1, '0xnew': 1}, {'0xnew': 1}, 20000, 1000)
why = {m['symbol']: m['reason'] for m in miss}
assert 'no pool found' in why['OLD'] and 'under the $20,000 floor' in why['THIN'] and '4h history' in why['SHORT'], why
assert any(m['tracked'] for m in miss), 'tracked tokens never seen are flagged too'
saved = json.load(open(os.path.join(d, 'rh_sticky.json')))['tokens']; assert '0xnew' in saved and saved['0xnew']['lastState'] == 'Setup'
log = [json.loads(l) for l in open(os.path.join(d, 'rh_missing.log'))]; n = len(log)
R.update_sticky(st, out, best, {'0xshort': 1, '0xnew': 1}, {'0xnew': 1}, 20000, 2000)
assert len([1 for _ in open(os.path.join(d, 'rh_missing.log'))]) == n, 'missing logged once, not every run'
# coming back clears the flag
R.update_sticky(st, out + [{'token': '0xold', 'symbol': 'OLD', 'pool': '0xq', 'state': 'Watch'}], best, {}, {}, 20000, 3000)
assert 'missingSince' not in st['0xold']
# pinned pool wins over a deeper pool of the same token in universe()
pools = []
def fake_cached(name, ttl, fn, uc=True):
    if name.startswith('pools_') or name.startswith('trending_'):
        return {'data': [{'attributes': {'address': '0xdeep', 'name': 'HYDX / USDG', 'reserve_in_usd': '900000'}, 'relationships': {'base_token': {'data': {'id': 'robinhood_0xaa5751ff3fb61e613993b2eb4eab1fce017081fc'}}, 'quote_token': {'data': {'id': 'robinhood_0xusdg'}}}}]}
    if name.startswith('pool_0x2f509c'):
        return {'data': {'attributes': {'address': '0x2f509c6e2675a1a7945902c64ba4aefaef32b2fbf34245f12078a1d0573db170', 'name': 'HYDX / WETH', 'reserve_in_usd': '150000'}, 'relationships': {'base_token': {'data': {'id': 'robinhood_0xaa5751ff3fb61e613993b2eb4eab1fce017081fc'}}, 'quote_token': {'data': {'id': 'robinhood_0xweth'}}}}}
    pools.append(name); return None
R.cached = fake_cached
fetched = set(); best, n = R.universe(1, True, {'0xgone': {}}, fetched)
assert best['0xaa5751ff3fb61e613993b2eb4eab1fce017081fc']['pool'].startswith('0x2f509c'), 'pinned pool used'
assert 'tokpools_0xgone.json' in pools and '0xgone' in fetched, 'sticky token off the pages is re-fetched'
print('rhscan sticky ok')
