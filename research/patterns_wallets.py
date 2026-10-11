#!/usr/bin/env python3
"""Detector 2: fresh-wallet coordination among top holders (Solana, public RPC only).
For each token: top holders (research-DB snapshot for backtest; getTokenLargestAccounts for live) -> keep system-owned wallets ->
wallet first-tx time (getSignaturesForAddress paged to the end, <=2 pages; >2000 txs = 'old/active', never fresh) and first-acquire time
(oldest signature of the wallet's token account for this mint).
Fresh = wallet's first tx <= FRESH_DAYS before its first acquisition of the token.
Coordination edge: two fresh wallets created within CREATE_WIN h of each other AND first-acquired within BUY_WIN h of each other.
Cluster = largest connected component; score = size and summed % of supply.
Usage: patterns_wallets.py backtest [n_per_cohort] | live"""
import json, os, random, sqlite3, sys, time
from patterns_common import *
SYS = '11111111111111111111111111111111'
FRESH_DAYS, CREATE_WIN, BUY_WIN, TOPN = 7, 72, 6, 15

def accounts(addrs):
    out = {}
    for i in range(0, len(addrs), 100):
        r = rpc('getMultipleAccounts', [addrs[i:i + 100], {'encoding': 'jsonParsed'}])
        for a, v in zip(addrs[i:i + 100], (r or {}).get('value', [])): out[a] = v
    return out

def wallet_profile(owner, mint):
    def f():
        s, done = sigs(owner, max_pages=2)
        first = min((x['t'] for x in s if x['t']), default=None) if done else None
        ta = rpc('getTokenAccountsByOwner', [owner, {'mint': mint}, {'encoding': 'jsonParsed'}]) or {}
        accs = [a['pubkey'] for a in ta.get('value', [])]
        buy = None
        for a in accs[:2]:
            s2, d2 = sigs(a, max_pages=2)
            if d2 and s2:
                t = min((x['t'] for x in s2 if x['t']), default=None)
                if t and (buy is None or t < buy): buy = t
        return {'owner': owner, 'n_tx': len(s), 'exhausted': done, 'first_tx': first, 'first_buy': buy, 'token_accounts': len(accs)}
    return cached('wallet_prof', owner + '_' + mint, f)

def cluster(profiles):
    fr = [p for p in profiles if p['first_tx'] and p['first_buy'] and 0 <= (p['first_buy'] - p['first_tx']) <= FRESH_DAYS * 86400 + 3600]
    adj = {p['owner']: set() for p in fr}
    for i, a in enumerate(fr):
        for b in fr[i + 1:]:
            if abs(a['first_tx'] - b['first_tx']) <= CREATE_WIN * 3600 and abs(a['first_buy'] - b['first_buy']) <= BUY_WIN * 3600:
                adj[a['owner']].add(b['owner']); adj[b['owner']].add(a['owner'])
    seen, best = set(), []
    for o in adj:
        if o in seen: continue
        comp, st = [], [o]
        while st:
            x = st.pop()
            if x in seen: continue
            seen.add(x); comp.append(x); st += list(adj[x])
        if len(comp) > len(best): best = comp
    pm = {p['owner']: p for p in profiles}
    best = best if len(best) >= 2 else []
    return {'n_checked': len(profiles), 'n_fresh': len(fr), 'fresh_pct': round(sum(pm[o].get('pct', 0) for o in [p['owner'] for p in fr]), 3),
            'cluster_size': len(best), 'cluster_pct': round(sum(pm[o].get('pct', 0) for o in best), 3),
            'cluster_buy_span_h': round((max(pm[o]['first_buy'] for o in best) - min(pm[o]['first_buy'] for o in best)) / 3600, 2) if best else None,
            'cluster_first_buy': min((pm[o]['first_buy'] for o in best), default=None), 'cluster_wallets': best[:12]}

def score_token(mint, holders):
    """holders: list of (owner, pct). returns result dict."""
    holders = holders[:TOPN]
    acc = accounts([o for o, _ in holders])
    keep = [(o, p) for o, p in holders if acc.get(o) and acc[o].get('owner') == SYS and not acc[o].get('executable')]
    profs = []
    for o, p in keep:
        try: pr = dict(wallet_profile(o, mint)); pr['pct'] = p; profs.append(pr)
        except Exception as e: log('wallet err', o, str(e)[:80])
    return {'excluded_non_wallets': len(holders) - len(keep), **cluster(profs), 'profiles': profs}

def backtest(nper):
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    toks = db.execute("select mint,symbol,cohort,created_ts,peak_ts,multiple,cur_vs_peak from tokens where chain='solana' and cohort in ('died','mooned') and mint in (select mint from top_holders)").fetchall()
    random.seed(7)
    sel = []
    for c in ('died', 'mooned'):
        g = [t for t in toks if t[2] == c]; random.shuffle(g); sel += g[:nper]
    out = []
    for i, (mint, sym, coh, cts, pts, mult, cvp) in enumerate(sel):
        hs = db.execute('select owner,pct from top_holders where mint=? order by pct desc', (mint,)).fetchall()
        try: r = score_token(mint, hs)
        except Exception as e: log('token err', sym, str(e)[:100]); continue
        r.update({'mint': mint, 'symbol': sym, 'cohort': coh, 'created_ts': cts // 1000 if cts else None, 'peak_ts': pts // 1000 if pts else None, 'multiple': mult, 'cur_vs_peak': cvp})
        if r['cluster_first_buy'] and r['peak_ts']: r['cluster_lead_h_before_peak'] = round((r['peak_ts'] - r['cluster_first_buy']) / 3600, 1)
        out.append(r); log(i, sym, coh, 'fresh', r['n_fresh'], 'cluster', r['cluster_size'], r['cluster_pct'])
    D = [r for r in out if r['cohort'] == 'died']; M = [r for r in out if r['cohort'] == 'mooned']
    thr = []
    for k in (2, 3, 4, 5):
        hd = sum(1 for r in D if r['cluster_size'] >= k); hm = sum(1 for r in M if r['cluster_size'] >= k)
        thr.append({'rule': f'cluster_size>={k}', 'died_flagged': hd, 'died_n': len(D), 'hit_rate_died': round(hd / len(D), 3) if D else None, 'mooned_flagged': hm, 'mooned_n': len(M), 'false_pos_rate_mooned': round(hm / len(M), 3) if M else None,
                    'precision_died': round(hd / (hd + hm), 3) if hd + hm else None})
    for p in (1, 5, 10):
        hd = sum(1 for r in D if r['cluster_size'] >= 2 and r['cluster_pct'] >= p); hm = sum(1 for r in M if r['cluster_size'] >= 2 and r['cluster_pct'] >= p)
        thr.append({'rule': f'cluster>=2 & cluster_pct>={p}%', 'died_flagged': hd, 'died_n': len(D), 'hit_rate_died': round(hd / len(D), 3) if D else None, 'mooned_flagged': hm, 'mooned_n': len(M), 'false_pos_rate_mooned': round(hm / len(M), 3) if M else None, 'precision_died': round(hd / (hd + hm), 3) if hd + hm else None})
    leads = sorted(r['cluster_lead_h_before_peak'] for r in D if r.get('cluster_lead_h_before_peak') is not None and r['cluster_size'] >= 2)
    res = {'params': {'FRESH_DAYS': FRESH_DAYS, 'CREATE_WIN_h': CREATE_WIN, 'BUY_WIN_h': BUY_WIN, 'TOPN': TOPN, 'max_sig_pages': 2},
           'sample': {'died': len(D), 'mooned': len(M), 'requested_per_cohort': nper, 'holders_source': 'research DB top_holders snapshot (taken Oct 9-10 2026, i.e. mostly AFTER the peak/crash)'},
           'mwu_cluster_size_died_vs_mooned': mwu([r['cluster_size'] for r in D], [r['cluster_size'] for r in M]),
           'mwu_fresh_count_died_vs_mooned': mwu([r['n_fresh'] for r in D], [r['n_fresh'] for r in M]),
           'mwu_cluster_pct_died_vs_mooned': mwu([r['cluster_pct'] for r in D], [r['cluster_pct'] for r in M]),
           'mean': {c: {'n_fresh': round(sum(r['n_fresh'] for r in g) / len(g), 2), 'cluster_size': round(sum(r['cluster_size'] for r in g) / len(g), 2), 'cluster_pct': round(sum(r['cluster_pct'] for r in g) / len(g), 2), 'n_checked': round(sum(r['n_checked'] for r in g) / len(g), 1)} for c, g in (('died', D), ('mooned', M)) if g},
           'thresholds': thr, 'cluster_first_buy_lead_h_before_peak_died': leads,
           'tokens': [{k: v for k, v in r.items() if k != 'profiles'} for r in out]}
    save('patterns_wallets.json', res)

def rugcheck(mint):
    return cached('rugcheck', mint, lambda: http(f'https://api.rugcheck.xyz/v1/tokens/{mint}/report'), max_age=1800)

def live_holders(mint):
    """top-20 holders via RugCheck free report (public RPC getTokenLargestAccounts is 429-limited)."""
    j = rugcheck(mint) or {}
    hs = {}
    for h in j.get('topHolders') or []:
        o = h.get('owner')
        if o: hs[o] = hs.get(o, 0) + float(h.get('pct') or 0)
    return sorted(hs.items(), key=lambda x: -x[1])

def live(n=10):
    f = json.load(open(os.path.join(DATA_DIR, 'live_feed.json')))
    items = [x for x in f['items'] if x['chain'] == 'solana' and x.get('grade') in ('A', 'B', 'C')]
    items.sort(key=lambda x: -(x.get('score') or 0))
    out = []
    for x in items[:n]:
        try:
            hs = live_holders(x['address']); r = score_token(x['address'], hs)
        except Exception as e: log('live err', x['symbol'], str(e)[:100]); continue
        r = {k: v for k, v in r.items() if k != 'profiles'}
        r.update({'key': x['key'], 'symbol': x['symbol'], 'grade': x.get('grade'), 'ageH': x.get('ageH'), 'mcap': x.get('mcap'),
                  'flag': r['cluster_size'] >= 3 or (r['cluster_size'] >= 2 and r['cluster_pct'] >= 5)})
        out.append(r); log('live', x['symbol'], r['n_fresh'], r['cluster_size'], r['cluster_pct'])
    prev = {}
    try: prev = json.load(open(os.path.join(DATA_DIR, 'patterns_wallets_live.json')))
    except Exception: pass
    save('patterns_wallets_live.json', {'items': out, 'scanned_from': 'live_feed.json top Solana A/B/C by score', 'rule': 'flag if cluster_size>=3 or (cluster>=2 and cluster_pct>=5%)'})

if __name__ == '__main__':
    if sys.argv[1] == 'backtest': backtest(int(sys.argv[2]) if len(sys.argv) > 2 else 30)
    else: live(int(sys.argv[2]) if len(sys.argv) > 2 else 10)
