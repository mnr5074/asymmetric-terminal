#!/usr/bin/env python3
"""Detectors 7-9 on the same 50-token sample as patterns_flows (30 crashed 'died' from the crash catalog, 20 runners 'mooned').
 7) Liquidity pulls (free, public RPC): find the main pool's LP mint generically (scan the pool account for 32-byte keys that are SPL
    mints other than the pair mints), read LP-mint signatures, classify LP-supply decreases as withdrawals (pool-side WSOL/USDC
    outflow) vs pure burns (lock). Flag withdrawal >= $1k within [peak-3d, peak+1d]. Pools without an LP mint (DLMM/CLMM positions,
    bonding-curve-only) are n/a.
 8) Sudden holder concentration (Nansen tgm/who-bought-sold, 1 credit): top buyers in the 24h before the peak (or since launch if
    younger). share = bought tokens / supply. Flag top1 >= 5% or top2 >= 10% of supply. Follow-up SELL query in [peak, peak+24h]
    (1 credit) only for flagged tokens to see whether the same wallets dumped.
 9) Bridge-hop-then-dump: outbound bridge events from detector 5 with a resolved EVM destination -> Nansen
    profiler/address/transactions on the destination chain in [t, t+3d] (1 credit each) -> did the destination sell/swap right after?
Nansen: separate ledger data/patterns_nansen_ledger_extra.json, soft cap PATTERNS_EXTRA_MAX (default 100), floor 300, no >=100 calls.
Usage: patterns_extra.py backtest | live"""
import json, os, re, sys, time, sqlite3, statistics, datetime as dt
os.environ.setdefault('PATTERNS_NANSEN_LEDGER', os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'patterns_nansen_ledger_extra.json'))
import patterns_nansen as N  # reads NANSEN_API_KEY before patterns_common strips it
from patterns_common import *
WSOL = 'So11111111111111111111111111111111111111112'; USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
MAXC = int(os.environ.get('PATTERNS_EXTRA_MAX', '100')) - int(N.L.get('used') or 0)  # cumulative cap across runs (separate ledger)
B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58(b):
    n = int.from_bytes(b, 'big'); s = ''
    while n: n, r = divmod(n, 58); s = B58[r] + s
    return '1' * (len(b) - len(b.lstrip(b'\0'))) + s
import base64
iso = lambda t: dt.datetime.fromtimestamp(t, UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
def tsof(s):
    try: return int(dt.datetime.fromisoformat(str(s).replace('Z', '+00:00')).replace(tzinfo=UTC).timestamp()) if s and 'T' in str(s) else None
    except Exception: return None

# ---------- 7 ----------
def lp_mint_of(pool, mint):
    def f():
        a = rpc('getAccountInfo', [pool, {'encoding': 'base64'}])
        v = (a or {}).get('value')
        if not v: return {'pool_owner': None, 'lp_mint': None, 'why': 'pool account not found'}
        data = base64.b64decode(v['data'][0]); owner = v['owner']
        cands = list(dict.fromkeys(b58(data[i:i + 32]) for i in range(0, min(len(data), 420) - 31)))
        skip = {mint, WSOL, USDC, pool}
        cands = [c for c in cands if c not in skip and 32 <= len(c) <= 44]
        found = []
        for i in range(0, len(cands), 100):
            r = rpc('getMultipleAccounts', [cands[i:i + 100], {'encoding': 'jsonParsed'}]) or {}
            for c, acc in zip(cands[i:i + 100], r.get('value', [])):
                try:
                    if acc and acc['data']['parsed']['type'] == 'mint': found.append({'mint': c, 'supply': acc['data']['parsed']['info']['supply'], 'decimals': acc['data']['parsed']['info']['decimals']})
                except Exception: pass
        return {'pool_owner': owner, 'data_len': len(data), 'lp_candidates': found, 'lp_mint': found[0]['mint'] if found else None}
    return cached('lp_mint', pool, f)

def lp_events(lp, t0, t1):
    s, done = sigs(lp, max_pages=1)
    win = [x for x in s if x['t'] and t0 <= x['t'] <= t1 and not x['err']]
    out = []
    for x in win[:30]:
        t = tx(x['sig'])
        if not t or not t.get('meta'): continue
        m = t['meta']; keys = [k['pubkey'] if isinstance(k, dict) else k for k in t['transaction']['message']['accountKeys']]
        signer = keys[0]; d_lp = 0.0; q_out = 0.0
        for side, sg in (('preTokenBalances', -1), ('postTokenBalances', 1)):
            for b in m.get(side) or []:
                amt = float(b['uiTokenAmount'].get('uiAmount') or 0)
                if b['mint'] == lp: d_lp += sg * amt
                elif b['mint'] in (WSOL, USDC) and b.get('owner') != signer: q_out -= sg * amt  # pool-side decrease => positive outflow
        px = 1.0 if False else None
        out.append({'t': x['t'], 'sig': x['sig'], 'lp_supply_delta': round(d_lp, 4), 'pool_quote_out': round(q_out, 4), 'signer': signer})
    return out, len(s), done

# ---------- 8 ----------
def concentration(mint, supply, t0, t1, side='BUY', cap=None):
    j, _ = N.call('tgm/who-bought-sold', {'chain': 'solana', 'token_address': mint, 'buy_or_sell': side, 'date': {'from': iso(t0), 'to': iso(t1)}, 'pagination': {'page': 1, 'per_page': 10}}, MAXC if cap is None else cap)
    rows = (j or {}).get('data') or []
    # NET accumulation (bought - sold) for BUY, net distribution (sold - bought) for SELL: gross volume double-counts wash/bot round trips
    sg = 1 if side == 'BUY' else -1
    top = [{'address': r.get('address'), 'label': r.get('address_label'), 'gross_bought': float(r.get('bought_token_volume') or 0), 'gross_sold': float(r.get('sold_token_volume') or 0),
            'tokens': max(0.0, sg * (float(r.get('bought_token_volume') or 0) - float(r.get('sold_token_volume') or 0))), 'usd': r.get('bought_volume_usd' if side == 'BUY' else 'sold_volume_usd')} for r in rows]
    # sanity filter: Nansen bonding-curve rows often carry token volume with ~$0 USD (unit/attribution artefacts, e.g. pump.fun program
    # 'Mayhem_Mode' showing 404% of supply for $9). Keep rows whose implied price (usd/tokens) is within 0.2x-5x of the median
    # implied price of rows with >= $5, and drop pump.fun/program/AMM-labelled addresses.
    g = lambda r: (r['gross_bought'] if side == 'BUY' else r['gross_sold'])
    pxs = sorted(float(r['usd'] or 0) / g(r) for r in top if g(r) > 0 and float(r['usd'] or 0) >= 5)
    med = pxs[len(pxs) // 2] if pxs else None
    for r in top:
        ip = float(r['usd'] or 0) / g(r) if g(r) > 0 else 0
        bad_lab = bool(re.search(r'pump\.fun:|program|amm|pool|raydium|meteora|liquidity', r['label'] or '', re.I))
        r['valid'] = bool(med) and 0.2 * med <= ip <= 5 * med and not bad_lab
        if not r['valid']: r['tokens'] = 0.0
    top.sort(key=lambda r: -r['tokens'])
    for r in top: r['share_pct'] = round(r['tokens'] / supply * 100, 3) if supply else None
    return top

def run_backtest():
    fl = json.load(open(os.path.join(DATA_DIR, 'patterns_flows.json')))
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    acct, _ = N.call('account', None, MAXC)
    if isinstance(acct, dict) and acct.get('credits_remaining') is not None: N.L['remaining'] = float(acct['credits_remaining'])
    bal0 = N.L['remaining']; log('balance start', bal0)
    sol_px = None
    try:
        from patterns_flows import sol_price; sol_px = sol_price
    except Exception: pass
    out, stopped = [], None
    for t in fl['tokens']:
        mint = t['mint']; r = db.execute('select created_ts, peak_ts, main_pool, main_dex, supply, lp_locked_pct from tokens where mint=?', (mint,)).fetchone()
        cts, pts, pool, dex, supply, lpl = r
        P = t['peak_t']; C = cts // 1000 if cts else P - 86400; brk = t.get('crash_break_t')
        rec = {'mint': mint, 'symbol': t['symbol'], 'cohort': t['cohort'], 'peak_t': P, 'break_t': brk, 'dex': dex, 'lp_locked_pct_db': lpl}
        # 7
        try:
            lm = lp_mint_of(pool, mint) if pool else {'lp_mint': None, 'why': 'no pool'}
            rec['lp'] = {k: lm.get(k) for k in ('pool_owner', 'lp_mint', 'why')}
            if lm.get('lp_mint'):
                ev, nsig, done = lp_events(lm['lp_mint'], C - 86400, min(P + 7 * 86400, int(time.time())))
                px = (sol_px(P) if sol_px else None) or 0
                wd = [e for e in ev if e['lp_supply_delta'] < 0 and e['pool_quote_out'] > 0]
                for e in wd: e['usd'] = round(e['pool_quote_out'] * px, 2); e['h_vs_peak'] = round((e['t'] - P) / 3600, 1); e['lead_h_before_break'] = round((brk - e['t']) / 3600, 1) if brk else None
                rec['lp'].update({'lp_sigs': nsig, 'events_parsed': len(ev), 'withdrawals': wd, 'burns': sum(1 for e in ev if e['lp_supply_delta'] < 0 and e['pool_quote_out'] <= 0),
                                  'pull_flag': any(e['usd'] >= 1000 and -72 <= e['h_vs_peak'] <= 24 for e in wd)})
        except Exception as ex: rec['lp'] = {'err': str(ex)[:120]}
        # 8
        try:
            t0 = max(C, P - 86400)
            top = concentration(mint, supply, t0, P + 3600)
            rec['conc'] = {'window_h': round((P + 3600 - t0) / 3600, 1), 'top': top[:5], 'top1_pct': top[0]['share_pct'] if top else 0, 'top2_pct': round(sum(x['share_pct'] or 0 for x in top[:2]), 3) if top else 0}
            rec['conc']['flag'] = (rec['conc']['top1_pct'] or 0) >= 5 or (rec['conc']['top2_pct'] or 0) >= 10
            if rec['conc']['flag']:  # SELL follow-up only from cache (no new credits; dropped mid-run for budget)
                try:
                    sells = concentration(mint, supply, P, P + 86400, 'SELL', cap=N.RUN_USED); bset = {x['address'] for x in top[:2]}
                    rec['conc']['same_wallet_sold_24h'] = [s for s in sells if s['address'] in bset and s['tokens'] > 0]
                except StopIteration: rec['conc']['same_wallet_sold_24h'] = None
        except StopIteration as e: stopped = str(e); rec['conc'] = {'skipped': stopped}
        except Exception as ex: rec['conc'] = {'err': str(ex)[:150]}
        # 9
        hops = []
        for e in t['events']:
            d = e.get('dest') or {}
            if e['type'] != 'bridge' or e.get('dir') != 'out' or not d.get('toAddress'): continue
            ch = {56: 'bnb', '56': 'bnb', 8453: 'base', '8453': 'base', 1: 'ethereum', '1': 'ethereum', 42161: 'arbitrum', '42161': 'arbitrum'}.get(d.get('toChain'))
            key = (ch, d['toAddress'].lower())
            if not ch or key in {(h['chain'], h['dest']) for h in hops}: continue
            h = {'chain': ch, 'dest': d['toAddress'].lower(), 't': e['t'], 'bridge': e['bridge'], 'usd': e.get('usd'), 'wallet': e['wallet']}
            try:
                j, _ = N.call('profiler/address/transactions', {'address': d['toAddress'], 'chain': ch, 'date': {'from': iso(e['t'] - 600), 'to': iso(e['t'] + 3 * 86400)}, 'hide_spam_token': False, 'pagination': {'page': 1, 'per_page': 50}}, MAXC)
                rows = (j or {}).get('data') or []
                sold = []
                for x in rows:
                    ts = tsof(x.get('block_timestamp'))
                    for s in x.get('tokens_sent') or []:
                        lab = s.get('to_address_label') or ''
                        sold.append({'t': ts, 'token': s.get('token_symbol'), 'usd': s.get('value_usd'), 'to_label': lab[:60], 'same_symbol': (s.get('token_symbol') or '').upper() == (t['symbol'] or '').upper()})
                for s_ in sold: s_['kind'] = 'rebridge' if re.search(r'relay|bridge|wormhole|debridge|dln|stargate|layerzero|across|mayan', s_['to_label'], re.I) else ('dex_sell' if re.search(r'dex|swap|pool|pancake|uniswap|router|aggregator|1inch|0x|okx dex|kyber', s_['to_label'], re.I) else ('cex' if N.is_cex(s_['to_label']) else 'other'))
                w24 = [s_ for s_ in sold if s_['t'] and 0 <= s_['t'] - e['t'] <= 86400]
                h.update({'dest_txs_3d': len(rows), 'sends': sold[:20], 'kinds_24h': {k: sum(1 for s_ in w24 if s_['kind'] == k) for k in ('dex_sell', 'cex', 'rebridge', 'other')},
                          'sold_within_24h': any(s_['kind'] in ('dex_sell', 'cex') for s_ in w24), 'same_token_sold': any(s_['same_symbol'] and s_['kind'] in ('dex_sell', 'cex') for s_ in sold)})
            except StopIteration as ex: h['skipped'] = str(ex); stopped = str(ex)
            except Exception as ex: h['err'] = str(ex)[:120]
            hops.append(h)
        rec['bridge_hops'] = hops
        out.append(rec); log(t['symbol'], t['cohort'], 'lp', (rec.get('lp') or {}).get('lp_mint') and len((rec['lp'].get('withdrawals') or [])), 'conc', (rec.get('conc') or {}).get('top1_pct'), 'hops', len(hops))
    D = [r for r in out if r['cohort'] == 'died']; M = [r for r in out if r['cohort'] == 'mooned']
    def rate(g, f, elig=lambda r: True):
        g = [r for r in g if elig(r)]; k = sum(1 for r in g if f(r)); return {'n': len(g), 'flagged': k, 'rate': round(k / len(g), 3) if g else None}
    def fisher(a, b, c, d):  # one-sided P(died flagged >= a) hypergeometric
        from math import comb
        n = a + b + c + d; r1 = a + b; c1 = a + c
        return round(sum(comb(c1, x) * comb(n - c1, r1 - x) / comb(n, r1) for x in range(a, min(r1, c1) + 1)), 4) if n else None
    def stat(f, elig=lambda r: True):
        rd, rm = rate(D, f, elig), rate(M, f, elig)
        return {'died': rd, 'mooned': rm, 'fisher_one_sided_p': fisher(rd['flagged'], rd['n'] - rd['flagged'], rm['flagged'], rm['n'] - rm['flagged'])}
    has_lp = lambda r: bool((r.get('lp') or {}).get('lp_mint'))
    has_c = lambda r: 'top1_pct' in (r.get('conc') or {})
    res = {'sample': {'died': len(D), 'mooned': len(M)}, 'stopped': stopped, 'nansen_credits_used_this_run': N.RUN_USED, 'balance_start': bal0, 'balance_end': N.L['remaining'],
           'liquidity_pull': {**stat(lambda r: r['lp'].get('pull_flag'), has_lp), 'with_lp_mint': {'died': sum(1 for r in D if has_lp(r)), 'mooned': sum(1 for r in M if has_lp(r))},
                              'any_withdrawal': stat(lambda r: bool(r['lp'].get('withdrawals')), has_lp),
                              'lead_h_before_break': sorted(e['lead_h_before_break'] for r in D if has_lp(r) for e in r['lp'].get('withdrawals') or [] if e.get('lead_h_before_break') is not None)},
           'concentration': {**stat(lambda r: r['conc'].get('flag'), has_c), 'mwu_top1_died_vs_mooned': mwu([r['conc']['top1_pct'] or 0 for r in D if has_c(r)], [r['conc']['top1_pct'] or 0 for r in M if has_c(r)]),
                             'median_top1_pct': {c: (statistics.median([r['conc']['top1_pct'] or 0 for r in g if has_c(r)]) if any(has_c(r) for r in g) else None) for c, g in (('died', D), ('mooned', M))},
                             'flagged_then_same_wallet_sold': {c: sum(1 for r in g if has_c(r) and r['conc'].get('same_wallet_sold_24h')) for c, g in (('died', D), ('mooned', M))},
                             'peak_to_break_h_when_flagged': sorted(round((r['break_t'] - r['peak_t']) / 3600, 1) for r in D if has_c(r) and r['conc'].get('flag') and r.get('break_t'))},
           'bridge_hop': {'hops_checked': sum(len(r['bridge_hops']) for r in out), **stat(lambda r: any(h.get('sold_within_24h') for h in r['bridge_hops']))},
           'tokens': out}
    save('patterns_extra.json', res)
    res['billing'].update({'nansen_credits_used_this_run': N.RUN_USED, 'nansen_ledger': os.path.basename(N.LEDGER)}); json.dump(res, open(os.path.join(DATA_DIR, 'patterns_extra.json'), 'w'), default=str)

def run_live(nmax=8, nansen_max=8):
    """Live: tokens of the detector-3/5 live pass. 7 = LP withdrawals in last 72h (free); 8 = top buyers last 24h (1 Nansen credit/token,
    capped at nansen_max per pass, cached 6h); 9 = resolved outbound bridge hops in the live flows events."""
    FL = json.load(open(os.path.join(DATA_DIR, 'patterns_flows_live.json')))
    now = int(time.time()); items = []; used0 = N.RUN_USED
    try: prev = {x['key']: x for x in json.load(open(os.path.join(DATA_DIR, 'patterns_extra_live.json')))['items']}
    except Exception: prev = {}
    if nansen_max:
        acct, _ = N.call('account', None, MAXC)
        if isinstance(acct, dict) and acct.get('credits_remaining') is not None: N.L['remaining'] = float(acct['credits_remaining'])
    for it in FL['items'][:nmax]:
        mint = it['key'].split(':', 1)[1]; rec = {'key': it['key'], 'symbol': it['symbol'], 'flags': []}
        try:
            ds = cached('ds_tok', mint, lambda: http(f'https://api.dexscreener.com/latest/dex/tokens/{mint}'), max_age=3600) or {}
            pairs = sorted([p for p in ds.get('pairs') or [] if p.get('chainId') == 'solana'], key=lambda p: -((p.get('liquidity') or {}).get('usd') or 0))
            pool = pairs[0]['pairAddress'] if pairs else None; rec['pool'] = pool; rec['dex'] = pairs[0].get('dexId') if pairs else None
            rec['liq_usd'] = (pairs[0].get('liquidity') or {}).get('usd') if pairs else None
            px = float(pairs[0].get('priceNative') or 0) if pairs else 0
            lm = lp_mint_of(pool, mint) if pool else {}
            rec['lp_mint'] = lm.get('lp_mint')
            if lm.get('lp_mint'):
                ev, nsig, _ = lp_events(lm['lp_mint'], now - 72 * 3600, now)
                from patterns_flows import sol_price
                sp = sol_price(now) or 0
                wd = [dict(e, usd=round(e['pool_quote_out'] * sp, 2)) for e in ev if e['lp_supply_delta'] < 0 and e['pool_quote_out'] > 0]
                rec['lp_withdrawals_72h'] = wd
                if any(e['usd'] >= 1000 for e in wd): rec['flags'].append('liquidity-pull')
        except Exception as ex: rec['lp_err'] = str(ex)[:120]
        try:
            if N.RUN_USED - used0 < nansen_max:
                sup = float(((rpc('getTokenSupply', [mint]) or {}).get('value') or {}).get('uiAmount') or 0)
                top = cached('conc_live', mint, lambda: concentration(mint, sup, now - 86400, now), max_age=6 * 3600)
                rec['conc'] = {'top1_pct': top[0]['share_pct'] if top else 0, 'top2_pct': round(sum(x['share_pct'] or 0 for x in top[:2]), 3) if top else 0, 'top': top[:3]}
                if rec['conc']['top1_pct'] >= 5 or rec['conc']['top2_pct'] >= 10: rec['flags'].append('holder-concentration')
            elif prev.get(it['key'], {}).get('conc'):
                rec['conc'] = dict(prev[it['key']]['conc'], carried_from_previous_pass=True)
                if (rec['conc'].get('top1_pct') or 0) >= 5 or (rec['conc'].get('top2_pct') or 0) >= 10: rec['flags'].append('holder-concentration')
        except StopIteration as ex: rec['conc'] = {'skipped': str(ex)}
        except Exception as ex: rec['conc'] = {'err': str(ex)[:120]}
        evs = it.get('events') if isinstance(it.get('events'), list) else []
        rec['bridge_hops'] = [e for e in evs if e.get('type') == 'bridge' and (e.get('dest') or {}).get('toAddress')]
        if rec['bridge_hops']: rec['flags'].append('bridge-hop')
        items.append(rec); log('live', it['symbol'], rec['flags'], rec.get('conc', {}).get('top1_pct'))
    save('patterns_extra_live.json', {'items': items, 'nansen_credits_used_this_pass': N.RUN_USED - used0,
         'rule': 'liquidity-pull: LP withdrawal >= $1k in last 72h; holder-concentration: top1 buyer >= 5% or top2 >= 10% of supply in last 24h (Nansen who-bought-sold, cached 6h); bridge-hop: outbound bridge with resolved destination in live flows'})

def run_control():
    """Age-matched control for detector 8: died tokens peaked ~2h after launch, so their 'pre-peak 24h' window is their whole life.
    Query runners over their FIRST 2h after launch (same exposure) and compare top-1 net-accumulation share. 1 credit per runner."""
    R = json.load(open(os.path.join(DATA_DIR, 'patterns_extra.json')))
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    acct, _ = N.call('account', None, MAXC)
    if isinstance(acct, dict) and acct.get('credits_remaining') is not None: N.L['remaining'] = float(acct['credits_remaining'])
    valid = lambda v: v is not None and v <= 100
    for r in R['tokens']:
        if r['cohort'] != 'mooned': continue
        cts, supply = db.execute('select created_ts, supply from tokens where mint=?', (r['mint'],)).fetchone()
        if not cts: continue
        C = cts // 1000
        try:
            top = concentration(r['mint'], supply, C, C + 2 * 3600)
            r['conc_launch2h'] = {'top1_pct': top[0]['share_pct'] if top else 0, 'top2_pct': round(sum(x['share_pct'] or 0 for x in top[:2]), 3) if top else 0, 'top': top[:3]}
        except StopIteration as e: r['conc_launch2h'] = {'skipped': str(e)}; break
        except Exception as e: r['conc_launch2h'] = {'err': str(e)[:120]}
    D = [r['conc']['top1_pct'] for r in R['tokens'] if r['cohort'] == 'died' and valid((r.get('conc') or {}).get('top1_pct'))]
    M = [r['conc_launch2h']['top1_pct'] for r in R['tokens'] if r['cohort'] == 'mooned' and valid((r.get('conc_launch2h') or {}).get('top1_pct'))]
    fl = lambda xs: sum(1 for x in xs if x >= 5)
    from math import comb
    a, n1, c, n2 = fl(D), len(D), fl(M), len(M); N_ = n1 + n2; c1 = a + c
    p = sum(comb(c1, x) * comb(N_ - c1, n1 - x) / comb(N_, n1) for x in range(a, min(n1, c1) + 1)) if N_ else None
    R['concentration_age_matched'] = {'rule': 'died: pre-peak window (median ~2h = whole life); runners: first 2h after launch; top1 net buyer >= 5% of supply; shares >100% dropped as Nansen artefacts',
        'died': {'n': n1, 'flagged': a, 'median_top1_pct': statistics.median(D) if D else None}, 'mooned_launch2h': {'n': n2, 'flagged': c, 'median_top1_pct': statistics.median(M) if M else None},
        'fisher_one_sided_p': round(p, 4) if p is not None else None, 'mwu': mwu(D, M), 'credits_used': N.RUN_USED}
    R['billing']['nansen_credits_used_control'] = N.RUN_USED
    json.dump(R, open(os.path.join(DATA_DIR, 'patterns_extra.json'), 'w'), default=str)
    log('control', R['concentration_age_matched'])

if __name__ == '__main__':
    if sys.argv[1:2] == ['control']: run_control(); sys.exit()
    if sys.argv[1:2] == ['live']: run_live(*(int(a) for a in sys.argv[2:4]))
    else: run_backtest()
