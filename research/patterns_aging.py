#!/usr/bin/env python3
"""Detector 6: whale wallet aging ('coin age' / HODL waves) + dormant awakening. Solana, public RPC + RugCheck (live holders).
Per token: top TOPN holders (system-owned wallets only; CEX-labelled, bridge, burn/incinerator and program/pool/vesting PDAs excluded).
For each holder's token account(s): signatures (<=1000) -> up to TXCAP txs parsed (nearest the reference time) -> 'send' = the owner's
balance of this mint decreased. coin age(t) = t - last send before t (or t - first acquisition if never sent).
Supply weight = holder % of supply in the holder snapshot (DB snapshot for backtest, RugCheck now for live): historical balances are NOT
reconstructed (limitation).
Backtest reference = hourly peak (patterns_hours) or DB peak. Metrics: HODL-wave buckets at P-7d and P-1d; aging cluster = >=20% of
supply in holders aged >=7d at P-1d AND share rising vs P-7d; dormant awakening = holder (>=0.5% supply) sends in [P-3d, P+3d] after
being idle >= 7d / 30d / 90d. Merged with detector 3/5 events (same wallet moving to CEX/bridge) into the coordinated exit event.
Usage: patterns_aging.py backtest [n_per_cohort] | live [n]"""
import json, os, random, sqlite3, sys, time
from patterns_common import *
SYS = '11111111111111111111111111111111'
BURN = {'1nc1nerator11111111111111111111111111111111', '1111111111111111111111111111111111111111111'}
LAB = json.load(open(os.path.join(DATA_DIR, 'patterns_labels.json'))); CEX = LAB['cex']['solana']
BR = json.load(open(os.path.join(DATA_DIR, 'bridges_registry.json')))['solana']
TOPN, TXCAP = 8, 8
BUCKETS = [('<1d', 0, 1), ('1-7d', 1, 7), ('7-30d', 7, 30), ('30-90d', 30, 90), ('90-180d', 90, 180), ('180d+', 180, 1e9)]

def holder_history(owner, mint, ref):
    def f():
        ta = rpc('getTokenAccountsByOwner', [owner, {'mint': mint}, {'encoding': 'jsonParsed'}]) or {}
        accs = [a['pubkey'] for a in ta.get('value', [])][:2]
        out = {'accounts': accs, 'first': None, 'sends': [], 'parsed': 0, 'n_sigs': 0, 'complete': True}
        for a in accs:
            s, done = sigs(a, max_pages=1)
            s = [x for x in s if x['t'] and not x['err']]
            out['n_sigs'] += len(s); out['complete'] &= done
            if s and done:
                ft = min(x['t'] for x in s); out['first'] = ft if out['first'] is None else min(out['first'], ft)
            pick = sorted(s, key=lambda x: abs(x['t'] - ref))[:TXCAP]
            for x in pick:
                t = tx(x['sig']); out['parsed'] += 1
                if not t or not t.get('meta'): continue
                d = 0.0
                for side, sg in (('preTokenBalances', -1), ('postTokenBalances', 1)):
                    for b in t['meta'].get(side) or []:
                        if b.get('owner') == owner and b.get('mint') == mint: d += sg * float(b['uiTokenAmount'].get('uiAmount') or 0)
                if d < 0: out['sends'].append({'t': x['t'], 'sig': x['sig'], 'amount': round(-d, 2)})
            out['window'] = [min((x['t'] for x in pick), default=None), max((x['t'] for x in pick), default=None)]
        out['sends'].sort(key=lambda z: z['t'])
        return out
    return cached('aging_hist', f'{owner}_{mint}_{ref // 86400}', f)

def age_at(h, t):
    prev = [s['t'] for s in h['sends'] if s['t'] < t]
    base = max(prev) if prev else h['first']
    if base is None or base > t: return None
    return (t - base) / 86400

def waves(hs, t):
    tot = sum(p for _, p, _ in hs) or 1; b = {k: 0.0 for k, _, _ in BUCKETS}; known = 0.0
    for o, p, h in hs:
        a = age_at(h, t)
        if a is None: continue
        known += p
        for k, lo, hi in BUCKETS:
            if lo <= a < hi: b[k] += p; break
    return {'buckets_pct_of_top': {k: round(v / tot * 100, 1) for k, v in b.items()}, 'aged7_pct_supply': round(sum(b[k] for k in ('7-30d', '30-90d', '90-180d', '180d+')), 2),
            'aged30_pct_supply': round(sum(b[k] for k in ('30-90d', '90-180d', '180d+')), 2), 'known_pct_supply': round(known, 2), 'top_pct_supply': round(tot, 2)}

def filt(holders):
    hs = [(o, p) for o, p in holders if o not in CEX and o not in BR and o not in BURN][:TOPN + 6]
    r = rpc('getMultipleAccounts', [[o for o, _ in hs], {'encoding': 'base64', 'dataSlice': {'offset': 0, 'length': 0}}]) or {}
    acc = dict(zip([o for o, _ in hs], r.get('value', [])))
    return [(o, p) for o, p in hs if acc.get(o) and acc[o].get('owner') == SYS][:TOPN]

def awakenings(hs, lo, hi):
    out = []
    for o, p, h in hs:
        if p < 0.5: continue
        for s in h['sends']:
            if lo <= s['t'] <= hi:
                idle = age_at(h, s['t'])
                if idle is not None and idle >= 7: out.append({'wallet': o, 'pct': round(p, 2), 't': s['t'], 'idle_d': round(idle, 1), 'amount': s['amount'], 'sig': s['sig']})
                break
    return out

def flows_index():
    idx = {}
    for f in ('patterns_flows.json', 'patterns_flows_live.json'):
        try:
            d = json.load(open(os.path.join(DATA_DIR, f)))
            for t in d.get('tokens', d.get('items', [])):
                for e in t.get('events', []):
                    if e['type'] == 'cex' or (e['type'] == 'bridge' and e.get('dir') == 'out'): idx.setdefault(e['wallet'], []).append(e)
        except Exception: pass
    return idx

def backtest(nper):
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    try: W = json.load(open(os.path.join(DATA_DIR, 'patterns_wallets.json')))['tokens']
    except Exception: W = []
    try: H = {e['key']: e for e in json.load(open(os.path.join(DATA_DIR, 'patterns_hours.json')))['events']}
    except Exception: H = {}
    FI = flows_index()
    random.seed(5); sel = []
    for c in ('died', 'mooned'):
        g = [t for t in W if t['cohort'] == c]; random.shuffle(g); sel += g[:nper]
    out = []
    for i, t in enumerate(sel):
        mint = t['mint']; hev = H.get('solana:' + mint) or {}
        P = hev.get('peak_t') or t['peak_ts']
        holders = db.execute('select owner,pct from top_holders where mint=? order by pct desc', (mint,)).fetchall()
        try:
            hs = [(o, p, holder_history(o, mint, P)) for o, p in filt(holders)]
        except Exception as ex: log('err', t['symbol'], str(ex)[:100]); continue
        w7, w1 = waves(hs, P - 7 * 86400), waves(hs, P - 86400)
        aw = awakenings(hs, P - 3 * 86400, P + 3 * 86400)
        for a in aw:
            a['lead_h_before_break'] = round((hev['break_t'] - a['t']) / 3600, 1) if hev.get('break_t') else None
            a['merged_exit'] = [{'type': e['type'], 'bridge': e.get('bridge'), 'cex': e.get('cex'), 't': e['t'], 'usd': e.get('usd')} for e in FI.get(a['wallet'], []) if abs(e['t'] - a['t']) <= 7 * 86400]
        age_token_d = round((P - t['created_ts']) / 86400, 1) if t.get('created_ts') else None
        r = {'mint': mint, 'symbol': t['symbol'], 'cohort': t['cohort'], 'peak_t': P, 'break_t': hev.get('break_t'), 'token_age_at_peak_d': age_token_d, 'holders': len(hs),
             'waves_p7': w7, 'waves_p1': w1, 'aging_cluster': w1['aged7_pct_supply'] >= 20 and w1['aged7_pct_supply'] > w7['aged7_pct_supply'], 'awakenings': aw,
             'sends_parsed': sum(len(h['sends']) for _, _, h in hs), 'txs_parsed': sum(h['parsed'] for _, _, h in hs)}
        out.append(r); log(i, t['symbol'], t['cohort'], 'aged7', w1['aged7_pct_supply'], 'awake', len(aw))
    D = [r for r in out if r['cohort'] == 'died']; M = [r for r in out if r['cohort'] == 'mooned']
    rate = lambda g, f: {'n': len(g), 'flagged': sum(1 for r in g if f(r)), 'rate': round(sum(1 for r in g if f(r)) / len(g), 3) if g else None}
    res = {'params': {'TOPN': TOPN, 'TXCAP_per_account': TXCAP, 'aging_cluster': '>=20% supply aged>=7d at P-1d and rising vs P-7d', 'awakening': 'holder >=0.5% sends in [P-3d,P+3d] after idle >=7d', 'buckets': [b[0] for b in BUCKETS]},
           'sample': {'died': len(D), 'mooned': len(M), 'holders_scanned': sum(r['holders'] for r in out), 'txs_parsed': sum(r['txs_parsed'] for r in out),
                      'median_token_age_at_peak_d': {c: (sorted(x['token_age_at_peak_d'] for x in g if x['token_age_at_peak_d'] is not None) or [None])[len(g) // 2] if g else None for c, g in (('died', D), ('mooned', M))}},
           'aging_cluster': {'died': rate(D, lambda r: r['aging_cluster']), 'mooned': rate(M, lambda r: r['aging_cluster'])},
           'awakening_7d': {'died': rate(D, lambda r: bool(r['awakenings'])), 'mooned': rate(M, lambda r: bool(r['awakenings']))},
           'awakening_30d': {'died': rate(D, lambda r: any(a['idle_d'] >= 30 for a in r['awakenings'])), 'mooned': rate(M, lambda r: any(a['idle_d'] >= 30 for a in r['awakenings']))},
           'awakening_90d': {'died': rate(D, lambda r: any(a['idle_d'] >= 90 for a in r['awakenings'])), 'mooned': rate(M, lambda r: any(a['idle_d'] >= 90 for a in r['awakenings']))},
           'awakening_lead_h_before_break_died': sorted(a['lead_h_before_break'] for r in D for a in r['awakenings'] if a.get('lead_h_before_break') is not None),
           'mwu_aged7_p1_died_vs_mooned': mwu([r['waves_p1']['aged7_pct_supply'] for r in D], [r['waves_p1']['aged7_pct_supply'] for r in M]),
           'merged_exit_events': sum(1 for r in out for a in r['awakenings'] if a['merged_exit']), 'tokens': out}
    save('patterns_aging.json', res)

def live(n=8):
    from patterns_wallets import live_holders
    f = json.load(open(os.path.join(DATA_DIR, 'live_feed.json'))); FI = flows_index()
    items = sorted([x for x in f['items'] if x['chain'] == 'solana'], key=lambda x: -(x.get('score') or 0))[:n]
    # plus research-DB runners/middles that are still alive (older tokens make 30d/90d ages possible)
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    extra = db.execute("select mint,symbol from tokens where chain='solana' and cohort in ('mooned','middle') and cur_mcap > 1000000 order by cur_mcap desc limit ?", (n,)).fetchall()
    now = int(time.time()); out = []
    for key, mint, sym, src in [(x['key'], x['address'], x['symbol'], 'live feed') for x in items] + [('solana:' + m, m, s, 'research DB alive') for m, s in extra]:
        try: hs = [(o, p, holder_history(o, mint, now)) for o, p in filt(live_holders(mint))]
        except Exception as ex: log('live err', sym, str(ex)[:100]); continue
        w = waves(hs, now); w30 = waves(hs, now - 30 * 86400)
        aw = awakenings(hs, now - 3 * 86400, now)
        for a in aw: a['merged_exit'] = [{'type': e['type'], 'bridge': e.get('bridge'), 'cex': e.get('cex'), 't': e['t'], 'usd': e.get('usd')} for e in FI.get(a['wallet'], []) if abs(e['t'] - a['t']) <= 7 * 86400]
        flag = []
        if w['aged7_pct_supply'] >= 20: flag.append(f"aging cluster: {w['aged7_pct_supply']}% of supply idle >=7d")
        if w['aged30_pct_supply'] >= 20: flag.append(f"{w['aged30_pct_supply']}% of supply idle >=30d")
        big = [a for a in aw if a['idle_d'] >= 30]
        if big: flag.append(f"dormant awakening: {len(big)} wallet(s) idle >=30d sent in last 3d")
        out.append({'key': key, 'symbol': sym, 'source': src, 'holders': len(hs), 'waves': w, 'waves_30d_ago': w30, 'awakenings': aw, 'flags': flag})
        log('live', sym, w['aged7_pct_supply'], len(aw))
    save('patterns_aging_live.json', {'items': out})

if __name__ == '__main__':
    if sys.argv[1] == 'backtest': backtest(int(sys.argv[2]) if len(sys.argv) > 2 else 20)
    else: live(int(sys.argv[2]) if len(sys.argv) > 2 else 8)
