#!/usr/bin/env python3
"""Rule 40 for majors: mcap/TVL and mcap/annualised-fees vs DefiLlama category peers (free API, no key).
Live: rich (>=3x category median) / cheap (<=1/3). Backtest: same ratio 90 days ago (TVL history from /protocol/{slug}, mcap from the
cached CoinGecko series data/cg_series) vs forward 90d return relative to the cross-sectional median -> data/patternlab_ext_fairvalue.json"""
import os, sys, json, math, statistics as st, collections, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extcommon as E
PC = E.PC
PC.GAPS['api.llama.fi'] = 0.5
def get(u, age=86400): return E.cached('llama', u, lambda: PC.http(u, timeout=90), max_age=age)

protos = get('https://api.llama.fi/protocols') or []
fees = get('https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true') or {}
f30 = {}
for p in fees.get('protocols', []):
    if (p.get('total30d') or 0) > 0: f30[str(p.get('defillamaId') or p.get('id'))] = p['total30d']; f30[p.get('name')] = p['total30d']
rows = []
for p in protos:
    if not p.get('mcap') or p['mcap'] <= 0 or not p.get('tvl') or p['tvl'] < 5e6 or not p.get('gecko_id'): continue
    fee = f30.get(str(p.get('id'))) or f30.get(p.get('name'))
    rows.append({'name': p['name'], 'symbol': p.get('symbol'), 'gecko': p['gecko_id'], 'slug': p.get('slug'), 'category': p.get('category'),
                 'mcap': p['mcap'], 'tvl': p['tvl'], 'fees_ann': fee * 12 if fee and fee > 0 else None})
cat = collections.defaultdict(list)
for r in rows:
    r['l_tvl'] = math.log(r['mcap'] / r['tvl']); r['l_fee'] = math.log(r['mcap'] / r['fees_ann']) if r['fees_ann'] else None
    cat[r['category']].append(r)
live_rich, live_cheap = [], []
for c, rs in cat.items():
    if len(rs) < 4: continue
    mt = st.median(x['l_tvl'] for x in rs); fl = [x['l_fee'] for x in rs if x['l_fee'] is not None]; mf = st.median(fl) if len(fl) >= 4 else None
    for r in rs:
        gt = r['l_tvl'] - mt; gf = (r['l_fee'] - mf) if (mf is not None and r['l_fee'] is not None) else None
        item = {'symbol': r['symbol'], 'name': r['name'], 'category': c, 'mcap_tvl': round(r['mcap'] / r['tvl'], 2), 'peer_median_mcap_tvl': round(math.exp(mt), 2),
                'mcap_fees': round(r['mcap'] / r['fees_ann'], 1) if r['fees_ann'] else None, 'peer_median_mcap_fees': round(math.exp(mf), 1) if mf is not None else None}
        if gt >= math.log(3) and (gf is None or gf >= 0): live_rich.append({**item, 'gap_x': round(math.exp(gt), 1), 'why': f"mcap/TVL {item['mcap_tvl']} vs {c} median {item['peer_median_mcap_tvl']}"})
        if gt <= -math.log(3) and (gf is None or gf <= 0): live_cheap.append({**item, 'gap_x': round(math.exp(-gt), 1), 'why': f"mcap/TVL {item['mcap_tvl']} vs {c} median {item['peer_median_mcap_tvl']}"})
live_rich.sort(key=lambda x: -x['gap_x']); live_cheap.sort(key=lambda x: -x['gap_x'])
# backtest 90d back
cg = os.path.join(E.DATA_DIR, 'cg_series')
bt = []
PC.GAPS['api.coingecko.com'] = 6.5
def series(gid):
    f = os.path.join(cg, gid + '.json')
    if os.path.exists(f): return json.load(open(f))
    return E.cached('cg_mc', gid, lambda: PC.http(f'https://api.coingecko.com/api/v3/coins/{gid}/market_chart?vs_currency=usd&days=200&interval=daily'), max_age=7 * 86400)
cands = sorted(rows, key=lambda r: -r['mcap'])
for r in cands[:int(os.environ.get("FV_N", 80))]:
    try:
        s = series(r['gecko'])
        if not s or not s.get('prices'): continue
        mc = s['market_caps']; px = s['prices']
        if len(px) < 100: continue
        t90 = px[-91][0] / 1000
        pr = get(f"https://api.llama.fi/protocol/{r['slug']}", age=7 * 86400) or {}
        tv = [x for x in (pr.get('tvl') or []) if abs(x['date'] - t90) < 2 * 86400]
        if not tv or not mc[-91][1]: continue
        bt.append({**r, 'l_tvl90': math.log(mc[-91][1] / tv[0]['totalLiquidityUSD']), 'fwd': px[-1][1] / px[-91][1] - 1})
    except Exception as e: E.log('bt fail', r['name'], e)
cat90 = collections.defaultdict(list)
for r in bt: cat90[r['category']].append(r)
medf = st.median(r['fwd'] for r in bt) if bt else 0
a = b = c = d = 0; ca = cb = cc = cd = 0; ex = []
gm = st.median(r['l_tvl90'] for r in bt) if bt else 0
for k, rs in cat90.items():
    m = st.median(x['l_tvl90'] for x in rs) if len(rs) >= 3 else gm  # small categories fall back to the cross-sectional median
    for r in rs:
        rich = r['l_tvl90'] - m >= math.log(3); cheap = r['l_tvl90'] - m <= -math.log(3); under = r['fwd'] < medf
        if rich: a += under; b += not under; ex.append({'symbol': r['symbol'], 'side': 'rich', 'fwd90d_pct': round(100 * r['fwd'], 1)})
        else: c += under; d += not under
        if cheap: ca += not under; cb += under; ex.append({'symbol': r['symbol'], 'side': 'cheap', 'fwd90d_pct': round(100 * r['fwd'], 1)})
        else: cc += not under; cd += under
p_r = E.fisher(a, b, c, d); p_c = E.fisher(ca, cb, cc, cd)
summary = {'n_live_protocols': len(rows), 'n_backtest': len(bt), 'median_fwd90d_pct': round(100 * medf, 1),
           'rich_underperformed': f'{a}/{a + b}', 'others_underperformed': f'{c}/{c + d}', 'p_rich_underperform_one_sided': round(p_r[1], 4),
           'cheap_outperformed': f'{ca}/{ca + cb}', 'others_outperformed': f'{cc}/{cc + cd}', 'p_cheap_outperform_one_sided': round(p_c[1], 4),
           'examples': ex[:30], 'def': 'mcap/TVL vs DefiLlama category median 90d ago (>=3x rich, <=1/3 cheap); outcome = 90d return vs cross-sectional median'}
E.save('patternlab_ext_fairvalue.json', {'summary': summary, 'live_rich': live_rich[:50], 'live_cheap': live_cheap[:50]})
print(json.dumps(summary)[:800])
