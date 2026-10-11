#!/usr/bin/env python3
"""Virtuals birth-phase library + live matcher (AI Agents desk). Free data only: Virtuals public API, Base archive RPC
(Tenderly public gateway), Robinhood Chain RPC, GeckoTerminal OHLCV (last 180 days), CoinGecko free (ATH for old tokens).

For every Virtuals launch processed, the fingerprint starts at the FIRST bonding-curve trade (prototype phase, before
graduation/official launch) and runs through post-graduation:
  pre-launch: first N buyers (short id, t+ seconds, size in VIRTUAL and USD, wallet nonce before the buy on Base = fresh-wallet
  proxy, repeat early buyers across Virtuals launches), buy-size distribution & timing, curve fill % per hour, time first buy ->
  graduation, curve-buyer concentration (top10 %, Gini), fresh-wallet clusters (detector-2 rule adapted to EVM: >=3 fresh
  wallets among first buyers whose first buys fall within 6 h).
  stages: snapshots when mcap first reaches $10K/$30K/$40K/$100K/$1M/$10M and at graduation (holders, top10 %, Gini, buyers,
  buy-size median/p75/p90, elapsed hours since first buy).
  outcome: peak mcap + date, reached $1M / $10M, current mcap.
Output: data/birthphase/virtuals.jsonl (one launch per line), data/birthphase/virtuals_schema.json, data/agents_birth.json
(summary, case studies, live matches, base rates). Usage: agents_birth.py [build N] [live] [all]"""
import json, math, os, random, sys, time, statistics
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agents_common import *

BP = os.path.join(DATA, 'birthphase'); os.makedirs(BP, exist_ok=True)
LIB = os.path.join(BP, 'virtuals.jsonl')
STAGES = [10e3, 30e3, 40e3, 100e3, 1e6, 10e6]
FIRST_N = 25
ZERO = '0x0000000000000000000000000000000000000000'; DEAD = '0x000000000000000000000000000000000000dead'
GRID_H = [5 / 60, 0.25, 0.5, 1, 2, 4, 8, 16, 24, 48]
CASES = {  # verified identities (see notes); Aristotle / Repo could not be matched to a Virtuals launch
    42701: {'name': 'PRXVT (relaunch)', 'note': 'Original PRXVT (0xc2ff2e5a…4bc0) launched Dec 2025; its stPRXVT staking contract was exploited ~Jan 1-5 2026 (32.8 ETH, reward-accounting bug) and the price crashed. Relaunched on Virtuals 2026-01-07 at 0x4b5D32A0…C5A9 with a 1:1 airdrop to Jan-1 holders, so its "birth" curve starts with airdropped holders, not a fresh crowd.'},
    1199: {'name': 'AIXBT', 'note': 'aixbt, launched on Virtuals bonding v1 2024-11-02; the reference Virtuals runner.'},
}
CASE_UNRESOLVED = {
    'Aristotle': 'No Virtuals launch named Aristotle with meaningful mcap found (Virtuals API name/symbol search returns only 1-holder Robinhood prototypes; DexScreener/GeckoTerminal show only sub-$50K ARISTOTLE pools on Robinhood/Base, and 0G\'s "Aristotle" is a mainnet name, not a token). Needs the contract address from the user.',
    'Repo': 'No Virtuals launch found for REPO: Virtuals API has no record of RepoPrompt 0x45b730D0…A1F7 (Base) and the GeckoTerminal REPO/WETH pools on Base trade on Bankr/Uniswap v4, not Virtuals. Needs the contract address from the user.',
}

def short(a): return a[:6] + '…' + a[-4:] if a else None
def iso(ts): return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(ts)) if ts else None
def pts(s):
    if not s: return None
    import datetime
    return datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()

def nonce_before(addr, n):
    def f():
        code = rpc('BASE', 'eth_getCode', [addr, hex(n)])
        nn = int(rpc('BASE', 'eth_getTransactionCount', [addr, hex(max(0, n - 1))]), 16)
        return {'nonce': nn, 'contract': bool(code and code != '0x')}
    try: return jcache('nonce', f'{addr}:{n}', f)
    except Exception: return None

def first_tx_ts(addr, upto):
    """Binary-search the first block where the wallet's nonce > 0 (Base archive). EOAs only."""
    def f():
        if int(rpc('BASE', 'eth_getTransactionCount', [addr, hex(upto)]), 16) == 0: return None
        lo, hi = 0, upto
        while lo < hi:
            m = (lo + hi) // 2
            if int(rpc('BASE', 'eth_getTransactionCount', [addr, hex(m)]), 16) > 0: hi = m
            else: lo = m + 1
        return block_ts('BASE', lo)
    try: return jcache('firsttx', f'{addr}:{upto // 43200}', f)
    except Exception: return None

# ---------------- pre-launch (bonding curve) ----------------
def pre_phase(v, chain):
    pair = (v.get('preTokenPair') or '').lower(); tok = (v.get('preToken') or '').lower()
    if not pair or not tok: return None, 'no prototype pair'
    t_create = pts(v.get('createdAt')); t_launch = pts(v.get('launchedAt')) or t_create; t_grad = pts(v.get('lpCreatedAt'))
    # trading starts at launchedAt for scheduled launches; for old bonding-v1 launches launchedAt == graduation, so start at creation
    start_ts = ((t_create or t_launch) if (t_grad and abs(t_launch - t_grad) < 120) else max(t_launch, t_create or 0)) - 600
    end_ts = (t_grad + 900) if t_grad else min(time.time() - 60, max(t_launch, start_ts) + 72 * 3600)
    end_ts = min(end_ts, start_ts + (4 if chain == 'BASE' else 14) * 86400, time.time() - 60)
    capped = t_grad and end_ts < t_grad
    a, b = block_at(chain, start_ts), block_at(chain, end_ts)
    if b <= a: return None, 'empty window'
    tsf = TsInterp(chain, a, b)
    logs = get_logs(chain, [pair, tok], a, b, quiet_stop_h=None if t_grad else 12, ts_of=tsf)
    return {'pair': pair, 'tok': tok, 'logs': logs, 'tsf': tsf, 'a': a, 'b': b, 'graduated_ts': t_grad, 'launch_ts': t_launch, 'capped': bool(capped)}, None

def parse_curve(P, supply):
    pair, tok, tsf = P['pair'], P['tok'], P['tsf']
    bytx = {}
    r0 = r1 = None; mint_seen = False
    swaps = []; transfers = []
    for l in sorted(P['logs'], key=lambda x: (int(x['blockNumber'], 16), int(x['logIndex'], 16))):
        ad = l['address'].lower(); t0 = l['topics'][0] if l['topics'] else None; bn = int(l['blockNumber'], 16)
        if ad == pair and t0 == T_FMINT:
            r0, r1 = u256(l['data'], 0) / 1e18, u256(l['data'], 1) / 1e18; mint_seen = True
        elif ad == pair and t0 == T_FSWAP and len(l['data']) >= 258:
            a0i, a0o, a1i, a1o = (u256(l['data'], i) / 1e18 for i in range(4))
            swaps.append({'bn': bn, 'tx': l['transactionHash'], 'a0i': a0i, 'a0o': a0o, 'a1i': a1i, 'a1o': a1o, 'li': int(l['logIndex'], 16)})
        elif ad == tok and t0 == T_TRANSFER and len(l['topics']) >= 3:
            fr, to = addr_t(l['topics'][1]).lower(), addr_t(l['topics'][2]).lower(); val = int(l['data'], 16) / 1e18 if l['data'] not in ('0x', '') else 0
            transfers.append({'bn': bn, 'tx': l['transactionHash'], 'fr': fr, 'to': to, 'v': val})
            bytx.setdefault(l['transactionHash'], []).append((fr, to, val))
    return swaps, transfers, bytx, (r0, r1, mint_seen)

def trade_rows(P, swaps, bytx, reserves):
    pair = P['pair']; r0, r1, mint_seen = reserves; tsf = P['tsf']
    rows = []; kc = (r0 * r1) if (r0 and r1) else None
    for s in swaps:
        buy = s['a0o'] > 0 and s['a1i'] > 0; sell = s['a0i'] > 0 and s['a1o'] > 0
        if not (buy or sell): continue
        if r0 is not None:
            # constant product on the token side only (token amounts are exact; VIRTUAL legs can include anti-sniper tax)
            r0 = r0 - s['a0o'] + s['a0i']; r1 = kc / r0 if r0 > 0 else r1
        net = {}
        for fr, to, val in bytx.get(s['tx'], []):
            if fr != pair: net[fr] = net.get(fr, 0) - val
            if to != pair: net[to] = net.get(to, 0) + val
        for k in (ZERO, DEAD): net.pop(k, None)
        who = (max(net.items(), key=lambda kv: kv[1])[0] if buy else min(net.items(), key=lambda kv: kv[1])[0]) if net else None
        tokens = s['a0o'] if buy else s['a0i']; vv = s['a1i'] if buy else s['a1o']
        px = (r1 / r0) if (r0 and r0 > 0) else (vv / tokens if tokens else None)  # VIRTUAL per token after the trade (spot)
        rows.append({'bn': s['bn'], 'ts': tsf(s['bn']), 'side': 'buy' if buy else 'sell', 'who': who, 'tokens': tokens, 'virtual': vv, 'px_v': px, 'tx': s['tx']})
    return rows

class Holders:
    def __init__(s, exclude): s.b = {}; s.ex = set(exclude)
    def apply(s, t):
        if t['fr'] not in s.ex and t['fr'] != ZERO: s.b[t['fr']] = s.b.get(t['fr'], 0) - t['v']
        if t['to'] not in s.ex and t['to'] not in (ZERO, DEAD): s.b[t['to']] = s.b.get(t['to'], 0) + t['v']
    def snap(s, supply):
        v = sorted((x for x in s.b.values() if x > 1e-9), reverse=True)
        return {'holders': len(v), 'top10_pct': round(sum(v[:10]) / supply * 100, 2) if supply else None, 'top10_pct_of_held': round(sum(v[:10]) / sum(v) * 100, 2) if v else None, 'gini': gini(v)}

def buy_stats(buys):
    us = [b['usd'] for b in buys if b.get('usd') is not None]
    if not us: return {'n_buys': len(buys)}
    tot = sum(us); by = {}
    for b in buys: by[b['who']] = by.get(b['who'], 0) + (b.get('usd') or 0)
    return {'n_buys': len(buys), 'unique_buyers': len(by), 'buy_usd_total': round(tot, 2), 'median_buy_usd': round(statistics.median(us), 2), 'p75_buy_usd': round(pct(us, .75), 2), 'p90_buy_usd': round(pct(us, .9), 2),
            'pct_buys_over_1k': round(sum(1 for x in us if x > 1000) / len(us) * 100, 1), 'top_buyer_share': round(max(by.values()) / tot * 100, 2) if tot else None}

def fingerprint(v, cohort, deep=False):
    chain = v.get('chain'); vid = v['id']
    supply = float(v.get('totalSupply') or 1e9)
    rec = {'schema': 'birthphase/v1', 'launchpad': 'virtuals', 'id': f'virtuals:{vid}', 'virtuals_id': vid, 'chain': chain.lower(), 'symbol': v.get('symbol'), 'name': v.get('name'),
           'token': (v.get('tokenAddress') or v.get('preToken') or '').lower() or None, 'pre_token': (v.get('preToken') or '').lower() or None, 'curve_pair': (v.get('preTokenPair') or '').lower() or None,
           'lp': (v.get('lpAddress') or '').lower() or None, 'factory': v.get('factory'), 'category': v.get('category'), 'cohort': cohort,
           'created_at': v.get('createdAt'), 'launched_at': v.get('launchedAt'), 'graduated_at': v.get('lpCreatedAt'), 'supply': supply,
           'modules': {k: (v.get('launchInfo') or {}).get(k) for k in ('launchRadarEnabled', 'isProject60days', 'needAcf', 'antiSniperTaxType', 'airdropPercent', 'isRobotics')},
           'genesis': bool(v.get('genesis')), 'coverage': {}, 'built_at': iso(time.time())}
    if chain not in CHAINS: rec['coverage']['pre'] = f'chain {chain} not supported'; return rec
    P, err = pre_phase(v, chain)
    if err: rec['coverage']['pre'] = err; return rec
    swaps, transfers, bytx, reserves = parse_curve(P, supply)
    rows = trade_rows(P, swaps, bytx, reserves)
    rec['coverage']['pre'] = 'ok' if rows else 'no curve trades found'
    rec['coverage']['pre_logs'] = len(P['logs']); rec['coverage']['pre_window_capped'] = P['capped']; rec['coverage']['reserves_from_mint'] = bool(reserves[2])
    if not rows: return rec
    for r in rows:
        vu = virtual_usd(r['ts']); r['vusd'] = vu
        r['usd'] = r['virtual'] * vu if vu else None
        r['mcap_usd'] = r['px_v'] * supply * vu if (vu and r['px_v']) else None
    t_first = next((r['ts'] for r in rows if r['side'] == 'buy'), rows[0]['ts'])
    rec['first_buy_at'] = iso(t_first)
    fb = next((r for r in rows if r['side'] == 'buy'), None)
    # Pre-buy module / creator buy: a first buy of >=5,000 VIRTUAL in the first block of trading
    rec['prebuy'] = {'virtual': round(fb['virtual'], 1), 'usd': round(fb['usd'] or 0), 'wallet': short(fb['who'])} if fb and fb['virtual'] >= 5000 and fb['bn'] == rows[0]['bn'] else None
    # first N buyers
    seen = {}; firsts = []
    for r in rows:
        if r['side'] != 'buy' or not r['who'] or r['who'] in seen: continue
        seen[r['who']] = 1
        firsts.append({'wallet': r['who'], 'short': short(r['who']), 't_s': round(r['ts'] - t_first), 'virtual': round(r['virtual'], 3), 'usd': round(r['usd'], 2) if r['usd'] else None, 'bn': r['bn']})
        if len(firsts) >= FIRST_N: break
    if chain == 'BASE':
        for f in firsts:
            nb = nonce_before(f['wallet'], f['bn'])
            if nb: f['nonce_before'] = nb['nonce']; f['contract_wallet'] = nb['contract']; f['fresh'] = (not nb['contract']) and nb['nonce'] <= 2
        if deep:
            for f in firsts[:12]:
                if f.get('contract_wallet') is False:
                    ft = first_tx_ts(f['wallet'], f['bn'])
                    if ft: f['wallet_age_days'] = round((t_first + f['t_s'] - ft) / 86400, 2)
        rec['coverage']['wallet_nonce'] = 'base archive nonce before the buy (fresh = EOA with <=2 prior txs)'
    else:
        rec['coverage']['wallet_nonce'] = 'not available (no archive state on this chain RPC)'
    for f in firsts: f.pop('bn', None)
    rec['first_buyers'] = firsts
    fr = [f for f in firsts if f.get('fresh')]
    rec['fresh_first_buyers'] = len(fr) if chain == 'BASE' else None
    # fresh cluster (detector-2 rule, EVM proxy): >=3 fresh first buyers with first buys within BUY_WIN=6h
    cl = 0
    if fr:
        ts_ = sorted(f['t_s'] for f in fr); j = 0
        for i in range(len(ts_)):
            while ts_[i] - ts_[j] > 6 * 3600: j += 1
            cl = max(cl, i - j + 1)
    rec['fresh_cluster_size'] = cl if chain == 'BASE' else None
    rec['fresh_cluster_flag'] = (cl >= 3) if chain == 'BASE' else None
    # holder replay + stage snapshots
    excl = {P['pair'], P['tok'], (rec['lp'] or '').lower()}
    H = Holders(excl); ti = 0; tr = sorted(transfers, key=lambda x: x['bn'])
    stages = {}; buys = []; grid = {}; vin = 0.0; vout = 0.0
    def advance(bn):
        nonlocal ti
        while ti < len(tr) and tr[ti]['bn'] <= bn: H.apply(tr[ti]); ti += 1
    peak_pre = 0; peak_pre_ts = None
    grad_ts = P['graduated_ts']
    for r in rows:
        if r['side'] == 'buy': buys.append(r); vin += r['virtual']
        else: vout += r['virtual']
        el = (r['ts'] - t_first) / 3600
        m = r['mcap_usd'] or 0
        if m > peak_pre: peak_pre, peak_pre_ts = m, r['ts']
        for s in STAGES:
            if s not in stages and m >= s:
                advance(r['bn'])
                stages[s] = {'stage_usd': s, 'phase': 'curve', 'at': iso(r['ts']), 'elapsed_h': round(el, 3), 'mcap_usd': round(m), 'virtual_in': round(vin, 1), 'net_virtual': round(vin - vout, 1),
                             'sell_buy_ratio': round(vout / vin, 3) if vin else None, **H.snap(supply), **buy_stats(buys)}
    obs_end_h = ((grad_ts or P['tsf'](P['b'])) - t_first) / 3600 if True else 0
    for g in GRID_H:
        if g > obs_end_h: break
        prior = [r for r in rows if (r['ts'] - t_first) / 3600 <= g]
        grid[g] = prior[-1]['mcap_usd'] if prior else None
    advance(10 ** 12)
    last = rows[-1]
    grad_ts = P['graduated_ts']
    rec['curve'] = {'n_trades': len(rows), 'n_buys': len(buys), 'unique_buyers': len({b['who'] for b in buys}), 'virtual_in': round(vin, 1), 'virtual_out': round(vout, 1),
                    'first_buy_to_graduation_h': round((grad_ts - t_first) / 3600, 3) if grad_ts else None,
                    'fill_pct_per_h': round((vin - vout) / 42000 * 100 / max(0.05, ((grad_ts or last['ts']) - t_first) / 3600), 2),
                    'launch_mcap_usd': round(rows[0]['mcap_usd']) if rows[0]['mcap_usd'] else None,
                    'peak_curve_mcap_usd': round(peak_pre), 'peak_curve_at': iso(peak_pre_ts), 'end_mcap_usd': round(last['mcap_usd'] or 0),
                    'buy_size': buy_stats(buys), 'holders_end': H.snap(supply),
                    'buy_size_by_hour': [{'h': h, **{k: v2 for k, v2 in buy_stats([b for b in buys if h - 1 <= (b['ts'] - t_first) / 3600 < h]).items() if k in ('n_buys', 'median_buy_usd', 'p90_buy_usd', 'unique_buyers')}} for h in (1, 2, 3, 4, 6, 12, 24)]}
    rec['curve_mcap_grid'] = {str(k): (round(v2) if v2 else None) for k, v2 in grid.items()}
    rec['stages'] = [stages[s] for s in STAGES if s in stages]
    rec['_curve_series'] = [[round((r['ts'] - t_first) / 3600, 4), round(r['mcap_usd'] or 0)] for r in rows[:: max(1, len(rows) // 300)]]
    # post graduation
    if rec['lp'] and grad_ts:
        post(rec, v, chain, t_first, stages, supply, deep)
    out_peak = max([rec['curve']['peak_curve_mcap_usd']] + [rec.get('post', {}).get('peak_mcap_usd') or 0])
    rec['outcome'] = {'peak_mcap_usd': round(out_peak), 'peak_at': rec.get('post', {}).get('peak_at') if (rec.get('post', {}).get('peak_mcap_usd') or 0) >= rec['curve']['peak_curve_mcap_usd'] else rec['curve']['peak_curve_at'],
                      'reached_1m': out_peak >= 1e6, 'reached_10m': out_peak >= 10e6, 'graduated': bool(grad_ts)}
    for s in STAGES:
        rec['outcome'][f'hours_to_{int(s/1000)}k'] = next((x['elapsed_h'] for x in rec['stages'] if x['stage_usd'] == s), None)
    return rec

def post(rec, v, chain, t_first, stages, supply, deep):
    lp = rec['lp']; tok = rec['token']; grad = pts(v.get('lpCreatedAt'))
    try:
        t0 = rpc(chain, 'eth_call', [{'to': lp, 'data': '0x0dfe1681'}, 'latest']); token0 = ('0x' + t0[-40:]).lower()
    except Exception as e:
        rec['coverage']['post'] = f'lp token0 failed: {e}'; return
    is0 = token0 == tok
    P = {}
    # first 24h of LP swaps: price path + buy sizes
    a, b = block_at(chain, grad - 120), block_at(chain, min(time.time() - 60, grad + 24 * 3600))
    tsf = TsInterp(chain, a, b)
    logs = get_logs(chain, [lp], a, b)
    rows = []; res = None
    for l in sorted(logs, key=lambda x: (int(x['blockNumber'], 16), int(x['logIndex'], 16))):
        t = l['topics'][0] if l['topics'] else None
        if t == T_V2SYNC:
            r0, r1 = u256(l['data'], 0) / 1e18, u256(l['data'], 1) / 1e18; res = (r0, r1)
        elif t == T_V2SWAP and res:
            a0i, a1i, a0o, a1o = (u256(l['data'], i) / 1e18 for i in range(4))
            tok_out = a0o if is0 else a1o; v_in = a1i if is0 else a0i; tok_in = a0i if is0 else a1i; v_out = a1o if is0 else a0o
            rt, rv = (res if is0 else (res[1], res[0]))
            ts = tsf(int(l['blockNumber'], 16)); vu = virtual_usd(ts)
            m = rv / rt * supply * vu if (rt and vu) else None
            if tok_out > 0: rows.append({'ts': ts, 'side': 'buy', 'usd': v_in * vu if vu else None, 'who': addr_t(l['topics'][2]) if len(l['topics']) > 2 else None, 'mcap': m})
            elif tok_in > 0: rows.append({'ts': ts, 'side': 'sell', 'usd': v_out * vu if vu else None, 'mcap': m})
    buys = [r for r in rows if r['side'] == 'buy']
    pm = {'first24h_trades': len(rows), 'first24h_buy_size': buy_stats(buys) if buys else None,
          'first24h_peak_mcap_usd': round(max((r['mcap'] or 0) for r in rows)) if rows else None}
    for r in rows:
        for s in STAGES:
            if s not in stages and (r['mcap'] or 0) >= s:
                stages[s] = {'stage_usd': s, 'phase': 'post-graduation', 'at': iso(r['ts']), 'elapsed_h': round((r['ts'] - t_first) / 3600, 3), 'mcap_usd': round(r['mcap'])}
    # long horizon path
    path = long_path(rec, v, chain, grad, supply, is0)
    pm.update(path)
    for t, m in path.pop('_series', []):
        for s in STAGES:
            if s not in stages and m >= s:
                stages[s] = {'stage_usd': s, 'phase': 'post-graduation', 'at': iso(t), 'elapsed_h': round((t - t_first) / 3600, 2), 'mcap_usd': round(m), 'resolution': path.get('resolution')}
    rec['stages'] = [stages[s] for s in STAGES if s in stages]
    rec['post'] = pm; rec['coverage']['post'] = 'ok'

def long_path(rec, v, chain, grad, supply, is0):
    lp = rec['lp']; tok = rec['token']; out = {}
    age_d = (time.time() - grad) / 86400
    series = []
    if age_d < 178 and chain in CHAINS:
        net = CHAINS[chain]['gt']
        for tf, lim in (('hour', 1000), ('day', 200)):
            u = f'https://api.geckoterminal.com/api/v2/networks/{net}/pools/{lp}/ohlcv/{tf}?limit={lim}&currency=usd&token={tok}'
            d = jcache('gt', u + time.strftime('%Y%m%d'), lambda: http(u, min_gap=2.3))
            for c in ((d or {}).get('data') or {}).get('attributes', {}).get('ohlcv_list', []):
                series.append((c[0], c[4] * supply, c[2] * supply))  # (ts, close mcap, high mcap)
        out['resolution'] = 'GeckoTerminal hourly (first ~41 days) + daily closes'
    elif chain == 'BASE':
        # archive getReserves sampling: every 6h for 3 days, daily to day 30, every 3 days to day 180
        tl = [grad + 6 * 3600 * i for i in range(1, 13)] + [grad + 86400 * d for d in range(4, 31)] + [grad + 86400 * d for d in range(33, 181, 3)]
        tl = [t for t in tl if t < time.time() - 600]
        for t in tl:
            def f(t=t):
                r = rpc('BASE', 'eth_call', [{'to': lp, 'data': '0x0902f1ac'}, hex(block_at('BASE', t))])
                return [int(r[2:66], 16) / 1e18, int(r[66:130], 16) / 1e18]
            try: r0, r1 = jcache('resv', f'{lp}:{int(t)}', f)
            except Exception: continue
            rt, rv = (r0, r1) if is0 else (r1, r0); vu = virtual_usd(t)
            if rt and vu: m = rv / rt * supply * vu; series.append((t, m, m))
        out['resolution'] = 'on-chain reserves sampled every 6 h (days 0-3), daily (to day 30), every 3 days (to day 180)'
    if series:
        series.sort(); pk = max(series, key=lambda x: x[1])
        out['peak_mcap_usd'] = round(pk[1]); out['peak_at'] = iso(pk[0]); out['peak_basis'] = 'close'
        out['peak_high_mcap_usd'] = round(max(x[2] for x in series))
        out['_series'] = [(t, m) for t, m, _ in series]
        out['series_days'] = round((series[-1][0] - series[0][0]) / 86400, 1)
    if age_d >= 178:
        cg = cg_ath(tok)
        if cg: out['coingecko'] = cg
        if cg and cg.get('ath_fdv_usd') and cg['ath_fdv_usd'] > (out.get('peak_mcap_usd') or 0):
            out['peak_mcap_usd'] = cg['ath_fdv_usd']; out['peak_at'] = cg['ath_date']; out['peak_basis'] = 'CoinGecko ATH price x total supply (outside sampled window)'
    return out

def cg_ath(tok):
    u = f'https://api.coingecko.com/api/v3/coins/base/contract/{tok}'
    def f():
        d = http(u, min_gap=6)
        md = (d or {}).get('market_data') or {}
        if not md: return None
        return {'id': d.get('id'), 'ath_usd': md.get('ath', {}).get('usd'), 'ath_date': md.get('ath_date', {}).get('usd'), 'ath_fdv_usd': round(md['ath']['usd'] * (md.get('total_supply') or 1e9)) if md.get('ath', {}).get('usd') else None,
                'mcap_usd': md.get('market_cap', {}).get('usd'), 'fdv_usd': md.get('fully_diluted_valuation', {}).get('usd'), 'ath_change_pct': md.get('ath_change_percentage', {}).get('usd')}
    try: return jcache('cgath', u, f, ttl=7 * 86400)
    except Exception: return None

# ---------------- selection / build ----------------
def fetch_virtual(vid):
    d = vapi(f'virtuals/{vid}', ttl=1800)
    return (d or {}).get('data')

def select(n_random=120, seed=7):
    """Cohorts: case studies; top Base/Robinhood graduated by mcap ('top_mcap', outcome-selected, excluded from base rates);
    all graduations in the last 120 days ('graduated_recent'); and a seeded RANDOM sample of launches created in the last 120 days
    with >=20 holders ('random', outcome-blind -> used for base rates)."""
    since = time.strftime('%Y-%m-%dT00:00:00Z', time.gmtime(time.time() - 120 * 86400))
    sel = {}
    for vid in CASES:
        v = fetch_virtual(vid)
        if v: sel[vid] = (v, 'case_study')
    for ch in ('BASE', 'ROBINHOOD'):
        for v in vapi_all('virtuals', {'filters[chain]': ch, 'filters[lpAddress][$notNull]': 'true', 'sort[0]': 'mcapInVirtual:desc'}, max_pages=1, page_size=40 if ch == 'BASE' else 25):
            sel.setdefault(v['id'], (v, 'top_mcap'))
    for v in vapi_all('virtuals', {'filters[lpCreatedAt][$gt]': since, 'sort[0]': 'lpCreatedAt:desc'}, max_pages=3):
        if v.get('chain') in CHAINS: sel.setdefault(v['id'], (v, 'graduated_recent'))
    pool = []
    for ch in ('BASE', 'ROBINHOOD'):
        pool += vapi_all('virtuals', {'filters[chain]': ch, 'filters[createdAt][$gt]': since, 'filters[holderCount][$gte]': 20, 'sort[0]': 'id:asc'}, max_pages=15)
    rnd = random.Random(seed); rnd.shuffle(pool)
    k = 0
    for v in pool:
        if k >= n_random: break
        if v['id'] in sel:
            if sel[v['id']][1] == 'graduated_recent': sel[v['id']] = (v, 'random'); k += 1  # random draw wins: keeps base-rate sample outcome-blind
            continue
        sel[v['id']] = (v, 'random'); k += 1
    return sel, {'random_pool_size': len(pool), 'since': since}

def load_lib():
    out = {}
    if os.path.exists(LIB):
        for line in open(LIB):
            try: r = json.loads(line); out[r['virtuals_id']] = r
            except Exception: pass
    return out

def write_lib(lib):
    tmp = LIB + '.tmp'
    with open(tmp, 'w') as f:
        for k in sorted(lib): f.write(json.dumps(lib[k], separators=(',', ':'), default=str) + '\n')
    os.replace(tmp, LIB)

def build(n_random=120, workers=3, max_new=None, refresh_days=3):
    sel, meta = select(n_random)
    lib = load_lib(); todo = []
    for vid, (v, coh) in sel.items():
        old = lib.get(vid)
        fresh = old and time.time() - (pts(old.get('built_at')) or 0) < refresh_days * 86400 and (old.get('outcome') or not old.get('first_buy_at'))
        if old and old.get('graduated_at') is None and v.get('lpCreatedAt'): fresh = False
        if fresh: lib[vid]['cohort'] = coh if old.get('cohort') != 'case_study' else 'case_study'; continue
        todo.append((v, coh))
    todo.sort(key=lambda x: ({'case_study': 0, 'top_mcap': 2, 'graduated_recent': 1, 'random': 3}[x[1]]))
    if max_new: todo = todo[:max_new]
    log('selected', len(sel), 'to build', len(todo), meta)
    def one(item):
        v, coh = item
        full = fetch_virtual(v['id']) or v
        try:
            r = fingerprint(full, coh, deep=(coh == 'case_study'))
        except Exception as e:
            r = {'schema': 'birthphase/v1', 'launchpad': 'virtuals', 'id': f"virtuals:{v['id']}", 'virtuals_id': v['id'], 'chain': (v.get('chain') or '').lower(), 'symbol': v.get('symbol'), 'name': v.get('name'), 'cohort': coh, 'coverage': {'error': str(e)[:300]}, 'built_at': iso(time.time())}
        if v['id'] in CASES: r['case_study'] = CASES[v['id']]
        return r
    done = 0
    with ThreadPoolExecutor(workers) as ex:
        for r in ex.map(one, todo):
            lib[r['virtuals_id']] = r; done += 1
            log('built', done, '/', len(todo), r.get('symbol'), r.get('cohort'), (r.get('coverage') or {}).get('pre'), (r.get('outcome') or {}).get('peak_mcap_usd'))
            if done % 5 == 0: write_lib(lib)
    write_lib(lib)
    # repeat early buyers across launches (by first-buy time)
    recs = sorted([r for r in lib.values() if r.get('first_buyers')], key=lambda r: r.get('first_buy_at') or '')
    seen = {}
    for r in recs:
        rep = 0
        for f in r['first_buyers']:
            prev = seen.get(f['wallet'], [])
            f['prior_early_launches'] = len(prev)
            if prev: rep += 1
        for f in r['first_buyers']: seen.setdefault(f['wallet'], []).append(r['virtuals_id'])
        r['repeat_early_buyers'] = rep; r['repeat_share'] = round(rep / len(r['first_buyers']), 3)
    write_lib(lib)
    write_schema()
    return lib, meta

def write_schema():
    sch = {'schema': 'birthphase/v1', 'file': 'data/birthphase/virtuals.jsonl', 'one_record_per_line': True, 'note': 'Virtuals Protocol launches. Times ISO-8601 UTC. USD values use VIRTUAL/USD from the Uniswap v3 VIRTUAL/USDC pool on Base at the trade hour. mcap = spot price x total supply (FDV-style; Virtuals agent supply is fixed at 1B).',
           'fields': {
               'id': 'virtuals:<virtuals api id>', 'chain': 'base | robinhood', 'token/pre_token/curve_pair/lp': 'addresses (lowercase); pre_token trades on curve_pair (bonding curve) before graduation; lp = Uniswap V2 pool after graduation',
               'cohort': 'case_study | top_mcap (outcome-selected, never used for base rates) | graduated_recent | random (seeded random sample of launches with >=20 holders, outcome-blind; base rates use this)',
               'first_buy_at': 'first bonding-curve buy (birth start)', 'first_buyers[]': 'first 25 distinct buyers: short id, t_s since first buy, VIRTUAL and USD size, nonce_before (Base), contract_wallet, fresh (EOA with <=2 prior txs), wallet_age_days (case studies), prior_early_launches (times this wallet was a first-25 buyer in an earlier library launch)',
               'fresh_first_buyers / fresh_cluster_size / fresh_cluster_flag': 'detector-2 rule adapted to EVM: >=3 fresh first buyers whose first buys fall within 6 h',
               'curve': 'bonding-curve phase: trades, buyers, VIRTUAL in/out, first_buy_to_graduation_h, fill_pct_per_h (net VIRTUAL vs the 42,000 VIRTUAL graduation threshold per hour), launch/peak/end mcap, buy_size (median/p75/p90, %>$1k, top buyer share), buy_size_by_hour',
               'curve_mcap_grid': 'mcap (USD) at fixed hours after the first buy: 0.083, 0.25, 0.5, 1, 2, 4, 8, 16, 24, 48',
               'stages[]': 'first time mcap reached $10K/$30K/$40K/$100K/$1M/$10M: elapsed_h since first buy and (curve phase) holders, top10_pct (of total supply, curve inventory excluded), gini, unique buyers, buy sizes, sell/buy ratio',
               'post': 'after graduation: first-24h buy sizes and peak, long-horizon path (GeckoTerminal hourly/daily or archive reserve samples), peak_mcap_usd + peak_at, CoinGecko ATH for tokens older than 180 days',
               'outcome': 'peak_mcap_usd, peak_at, reached_1m, reached_10m, graduated, hours_to_<stage>k', 'coverage': 'what was and was not available for this launch'}}
    json.dump(sch, open(os.path.join(BP, 'virtuals_schema.json'), 'w'), indent=1)

# ---------------- matching ----------------
FEATS = [('elapsed_h', lambda s, r: math.log1p(s.get('elapsed_h') or 0)), ('unique_buyers', lambda s, r: math.log1p(s.get('unique_buyers') or 0)),
         ('top10_pct', lambda s, r: s.get('top10_pct')), ('gini', lambda s, r: s.get('gini')), ('median_buy', lambda s, r: math.log1p(s.get('median_buy_usd') or 0)),
         ('p90_buy', lambda s, r: math.log1p(s.get('p90_buy_usd') or 0)), ('sell_buy_ratio', lambda s, r: s.get('sell_buy_ratio')), ('top_buyer_share', lambda s, r: s.get('top_buyer_share')),
         ('prebuy_usd', lambda s, r: math.log1p((r.get('prebuy') or {}).get('usd') or 0)),
         ('fresh_share', lambda s, r: (r['fresh_first_buyers'] / max(1, len(r.get('first_buyers') or []))) if r.get('fresh_first_buyers') is not None else None),
         ('repeat_share', lambda s, r: r.get('repeat_share'))]

def stage_of(r, stage):
    return next((x for x in r.get('stages') or [] if x['stage_usd'] == stage and x.get('phase') == 'curve'), None)

def arc(r, stage):
    """Mcap arc from first buy to the stage, resampled at 12 normalized time points (log10 mcap)."""
    s = stage_of(r, stage); ser = r.get('_curve_series') or []
    if not s or not ser: return None
    T = max(1e-4, s['elapsed_h']); pts_ = [p for p in ser if p[0] <= T + 1e-9] or ser[:1]
    out = []
    for i in range(12):
        t = T * i / 11; prior = [p for p in pts_ if p[0] <= t]
        out.append(math.log10(max(1, (prior[-1] if prior else pts_[0])[1])))
    return out

def dtw(a, b):
    n, m = len(a), len(b); INF = 1e18
    D = [[INF] * (m + 1) for _ in range(n + 1)]; D[0][0] = 0
    for i in range(1, n + 1):
        for j in range(max(1, i - 3), min(m, i + 3) + 1):
            c = abs(a[i - 1] - b[j - 1]); D[i][j] = c + min(D[i - 1][j], D[i][j - 1], D[i - 1][j - 1])
    return D[n][m] / max(n, m)

def vec(r, stage):
    s = stage_of(r, stage)
    if not s: return None
    return [f(s, r) for _, f in FEATS]

def norms(vs):
    out = []
    for i in range(len(FEATS)):
        xs = [v[i] for v in vs if v and v[i] is not None]
        mu = statistics.mean(xs) if xs else 0; sd = statistics.pstdev(xs) if len(xs) > 1 else 1
        out.append((mu, sd or 1))
    return out

def distance(va, vb, aa, ab, nz):
    d = []; 
    for i, (x, y) in enumerate(zip(va, vb)):
        if x is None or y is None: continue
        d.append(((x - nz[i][0]) / nz[i][1] - (y - nz[i][0]) / nz[i][1]) ** 2)
    fd = math.sqrt(sum(d) / len(d)) if d else 3
    ad = dtw(aa, ab) if (aa and ab) else 1
    return fd + 1.5 * ad, fd, ad

def candidates(lib, stage):
    return [r for r in lib.values() if stage_of(r, stage) and r.get('outcome') and r.get('cohort') != 'live']

def match(live, lib, stage, k=10):
    pool = [r for r in candidates(lib, stage) if r['virtuals_id'] != live.get('virtuals_id')]
    if not pool: return None
    nz = norms([vec(r, stage) for r in pool] + [vec(live, stage)])
    vl, al = vec(live, stage), arc(live, stage)
    sc = []
    for r in pool:
        d, fd, ad = distance(vl, vec(r, stage), al, arc(r, stage), nz)
        sc.append((d, fd, ad, r))
    sc.sort(key=lambda x: x[0])
    near = sc[:k]; near_rand = [x for x in sc if x[3].get('cohort') == 'random'][:k]
    rate = lambda xs, key: (round(sum(1 for x in xs if x[3]['outcome'].get(key)) / len(xs), 3) if xs else None)
    rnd_all = [r for r in pool if r.get('cohort') == 'random']
    return {'stage_usd': stage, 'pool_n': len(pool), 'top': [{'symbol': x[3].get('symbol'), 'id': x[3]['id'], 'cohort': x[3].get('cohort'), 'similarity_pct': round(100 / (1 + x[0]), 1), 'feature_dist': round(x[1], 3), 'arc_dtw': round(x[2], 3),
                        'what_it_did_next': {'peak_mcap_usd': x[3]['outcome'].get('peak_mcap_usd'), 'peak_at': x[3]['outcome'].get('peak_at'), 'reached_1m': x[3]['outcome'].get('reached_1m'), 'reached_10m': x[3]['outcome'].get('reached_10m'), 'graduated': x[3]['outcome'].get('graduated')}} for x in near[:5]],
            'nearest10_rate_1m': rate(near, 'reached_1m'), 'nearest10_rate_10m': rate(near, 'reached_10m'),
            'nearest10_random_rate_1m': rate(near_rand, 'reached_1m'), 'nearest10_random_n': len(near_rand),
            'base_rate_1m_random': round(sum(1 for r in rnd_all if r['outcome'].get('reached_1m')) / len(rnd_all), 3) if rnd_all else None, 'base_rate_n': len(rnd_all),
            'base_rate_10m_random': round(sum(1 for r in rnd_all if r['outcome'].get('reached_10m')) / len(rnd_all), 3) if rnd_all else None}

def validate(lib, stage=30e3, k=10):
    """Leave-one-out on the outcome-blind random cohort: does kNN similarity rank future $1M reachers above the base rate?"""
    R = [r for r in candidates(lib, stage) if r.get('cohort') == 'random']
    if len(R) < 15: return {'stage_usd': stage, 'n': len(R), 'note': 'too few random-cohort launches reached this stage to validate'}
    nz = norms([vec(r, stage) for r in R]); preds = []
    for r in R:
        sc = sorted((distance(vec(r, stage), vec(o, stage), arc(r, stage), arc(o, stage), nz)[0], o) for o in R if o is not r)[:k]
        preds.append((sum(1 for _, o in sc if o['outcome'].get('reached_1m')) / len(sc), r['outcome'].get('reached_1m')))
    preds.sort(key=lambda x: -x[0]); third = max(1, len(preds) // 3)
    base = sum(1 for _, y in preds if y) / len(preds)
    pos = [p for p, y in preds if y]; neg = [p for p, y in preds if not y]
    auc = (sum((p > q) + 0.5 * (p == q) for p in pos for q in neg) / (len(pos) * len(neg))) if pos and neg else None
    return {'stage_usd': stage, 'n': len(R), 'k': k, 'base_rate_1m': round(base, 3), 'top_third_rate_1m': round(sum(1 for _, y in preds[:third] if y) / third, 3), 'bottom_third_rate_1m': round(sum(1 for _, y in preds[-third:] if y) / third, 3), 'auc': round(auc, 3) if auc is not None else None}

def live_candidates():
    since = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 7 * 86400)); vu = virtual_usd(time.time() - 120) or 0.7
    lo, hi = 15e3 / vu, 80e3 / vu
    out = []
    for ch in CHAINS:
        d = vapi('virtuals', {'filters[chain]': ch, 'filters[lpAddress][$null]': 'true', 'filters[launchedAt][$gt]': since, 'filters[mcapInVirtual][$gte]': round(lo), 'filters[mcapInVirtual][$lte]': round(hi), 'sort[0]': 'mcapInVirtual:desc', 'pagination[pageSize]': 25})
        out += d.get('data') or []
    return out, vu

def live(lib):
    cands, vu = live_candidates(); res = []
    for v in cands[:20]:
        full = fetch_virtual(v['id']) or v
        try: r = fingerprint(full, 'live', deep=False)
        except Exception as e: res.append({'symbol': v.get('symbol'), 'id': v['id'], 'error': str(e)[:200]}); continue
        # repeat early buyers vs library
        idx = {}
        for o in lib.values():
            for f in o.get('first_buyers') or []: idx.setdefault(f['wallet'], []).append(o.get('symbol'))
        rep = [f for f in r.get('first_buyers') or [] if f['wallet'] in idx]
        r['repeat_early_buyers'] = len(rep); r['repeat_share'] = round(len(rep) / max(1, len(r.get('first_buyers') or [])), 3)
        cur = (r.get('curve') or {}).get('end_mcap_usd') or 0
        reached = [x['stage_usd'] for x in r.get('stages') or [] if x.get('phase') == 'curve']
        stage = 40e3 if 40e3 in reached else 30e3 if 30e3 in reached else 10e3 if 10e3 in reached else None
        m = match(r, lib, stage) if stage else None
        best = (m or {}).get('top', [{}])[0] if m and m.get('top') else None
        res.append({'symbol': r.get('symbol'), 'name': r.get('name'), 'id': r['id'], 'chain': r['chain'], 'token': r.get('pre_token'), 'url': f"https://app.virtuals.io/virtuals/{v['id']}",
                    'mcap_usd_now': round((v.get('mcapInVirtual') or 0) * vu), 'curve_end_mcap_usd': cur, 'holders': v.get('holderCount'), 'first_buy_at': r.get('first_buy_at'), 'stage_matched': stage,
                    'fresh_first_buyers': r.get('fresh_first_buyers'), 'fresh_cluster_flag': r.get('fresh_cluster_flag'), 'repeat_early_buyers': len(rep), 'repeat_with': sorted({s for f in rep for s in idx[f['wallet']]})[:8],
                    'prebuy': r.get('prebuy'), 'curve': {k2: (r.get('curve') or {}).get(k2) for k2 in ('n_buys', 'unique_buyers', 'fill_pct_per_h', 'peak_curve_mcap_usd')}, 'match': m,
                    'headline': (f"looks {best['similarity_pct']}% like {best['symbol']} at the same ${int(stage/1000)}K stage; {best['symbol']} then peaked at ${best['what_it_did_next']['peak_mcap_usd']:,}" if best else 'no comparable library launches at this stage yet')})
    return res, vu

def case_fingerprints(lib):
    out = []
    for vid, meta in CASES.items():
        r = lib.get(vid)
        if not r: out.append({'name': meta['name'], 'status': 'not built yet'}); continue
        out.append({'name': meta['name'], 'note': meta['note'], 'symbol': r.get('symbol'), 'token': r.get('token'), 'chain': r.get('chain'), 'first_buy_at': r.get('first_buy_at'), 'graduated_at': r.get('graduated_at'),
                    'prebuy': r.get('prebuy'), 'curve': r.get('curve'), 'stages': r.get('stages'), 'outcome': r.get('outcome'), 'first_buyers': (r.get('first_buyers') or [])[:10],
                    'fresh_first_buyers': r.get('fresh_first_buyers'), 'fresh_cluster_size': r.get('fresh_cluster_size'), 'repeat_early_buyers': r.get('repeat_early_buyers'), 'coverage': r.get('coverage'),
                    'post': {k: (r.get('post') or {}).get(k) for k in ('peak_mcap_usd', 'peak_at', 'peak_basis', 'resolution', 'first24h_buy_size', 'first24h_peak_mcap_usd', 'coingecko')}})
    return out

def protocol_wallets(lib):
    cnt = {}
    for r in lib.values():
        for f in (r.get('first_buyers') or [])[:3]: cnt[f['wallet']] = cnt.get(f['wallet'], 0) + 1
    n = max(1, sum(1 for r in lib.values() if r.get('first_buyers')))
    return [{'wallet': w, 'short': short(w), 'launches_as_top3_first_buyer': c, 'share': round(c / n, 3)} for w, c in sorted(cnt.items(), key=lambda x: -x[1]) if c >= max(4, 0.05 * n)][:10]

def summarize(lib, live_res=None, vu=None, meta=None):
    recs = list(lib.values())
    full = [r for r in recs if r.get('first_buyers') and r.get('stages') and r.get('outcome')]
    cov = {'n_launches': len(recs), 'n_with_prelaunch_trades': sum(1 for r in recs if (r.get('coverage') or {}).get('pre') == 'ok'),
           'n_full_fingerprint': len(full), 'n_with_wallet_nonce': sum(1 for r in recs if any('nonce_before' in f for f in r.get('first_buyers') or [])),
           'n_graduated': sum(1 for r in recs if (r.get('outcome') or {}).get('graduated')), 'n_with_post_path': sum(1 for r in recs if (r.get('post') or {}).get('peak_mcap_usd')),
           'n_errors': sum(1 for r in recs if (r.get('coverage') or {}).get('error')), 'by_cohort': {}, 'by_chain': {}}
    for r in recs:
        cov['by_cohort'][r.get('cohort')] = cov['by_cohort'].get(r.get('cohort'), 0) + 1; cov['by_chain'][r.get('chain')] = cov['by_chain'].get(r.get('chain'), 0) + 1
    runners = sorted([r for r in full if (r['outcome'].get('peak_mcap_usd') or 0) >= 1e6], key=lambda r: -r['outcome']['peak_mcap_usd'])
    base = {}
    for st in (30e3, 40e3, 100e3):
        R = [r for r in candidates(lib, st) if r.get('cohort') == 'random']
        base[str(int(st))] = {'n_random_reached_stage': len(R), 'then_reached_1m': sum(1 for r in R if r['outcome'].get('reached_1m')), 'then_reached_10m': sum(1 for r in R if r['outcome'].get('reached_10m')),
                              'rate_1m': round(sum(1 for r in R if r['outcome'].get('reached_1m')) / len(R), 3) if R else None, 'graduated': sum(1 for r in R if r['outcome'].get('graduated'))}
    out = {'generatedAt': int(time.time() * 1000), 'coverage': cov, 'select_meta': meta, 'case_studies': case_fingerprints(lib), 'case_unresolved': CASE_UNRESOLVED,
           'runners': [{'symbol': r.get('symbol'), 'chain': r.get('chain'), 'cohort': r.get('cohort'), 'peak_mcap_usd': r['outcome']['peak_mcap_usd'], 'peak_at': r['outcome'].get('peak_at'), 'first_buy_at': r.get('first_buy_at'),
                        'hours_to_100k': r['outcome'].get('hours_to_100k'), 'hours_to_1m': r['outcome'].get('hours_to_1000k'), 'hours_to_10m': r['outcome'].get('hours_to_10000k'), 'curve_h': (r.get('curve') or {}).get('first_buy_to_graduation_h'),
                        'unique_buyers_curve': (r.get('curve') or {}).get('unique_buyers'), 'median_buy_usd': ((r.get('curve') or {}).get('buy_size') or {}).get('median_buy_usd')} for r in runners[:25]],
           'base_rates': base, 'validation': validate(lib, 30e3), 'validation_10k': validate(lib, 10e3), 'protocol_wallets': protocol_wallets(lib),
           'live': live_res, 'virtual_usd': vu, 'method': {'similarity': 'similarity % = 100 / (1 + d), d = RMS of z-scored stage features (elapsed hours, unique buyers, top-10 %, Gini, median & p90 buy, sell/buy ratio, top-buyer share, pre-buy size, fresh-wallet share, repeat-early-buyer share) + 1.5 x DTW distance between log-mcap arcs from first buy to the stage, resampled on normalized time. Missing features are skipped pairwise.',
                                                                       'base_rate': 'Rates come only from the seeded random cohort (outcome-blind). top_mcap/case-study launches can appear as matches but never count toward base rates.',
                                                                       'stage': 'Live tokens are matched at the highest of $40K/$30K/$10K they have reached on the curve, against library launches truncated at that same stage.'}}
    save('agents_birth.json', out)
    return out

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if mode in ('build', 'all'):
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 100
        lk = os.path.join(CACHE, 'build.lock')
        try:
            pid = int(open(lk).read()); os.kill(pid, 0); log('another build is running', pid); return
        except Exception: pass
        open(lk, 'w').write(str(os.getpid()))
        lib, meta = build(n_random=n, workers=int(os.environ.get('AGENTS_WORKERS', 3)))
        summarize(lib, meta=meta)
    if mode in ('live', 'all'):
        lib = load_lib(); prev = {}
        try: prev = json.load(open(os.path.join(DATA, 'agents_birth.json')))
        except Exception: pass
        lr, vu = live(lib)
        summarize(lib, lr, vu, prev.get('select_meta'))
    if mode == 'summary':
        summarize(load_lib())

if __name__ == '__main__':
    main()
