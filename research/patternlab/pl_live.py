#!/usr/bin/env python3
"""Pattern Lab live scanner -> data/patternlab_live.json (read by lib/patternlab.js; the server never calls Nansen for this).
Universe: top-N Solana tokens of data/live_feed.json by score (+ all Solana items for the cheap batched mint/freeze check).
Free: Solana RPC getMultipleAccounts (mint/freeze authority, all Solana feed tokens), GeckoTerminal last-300 trades + 5-min OHLCV,
RugCheck report (mutable metadata, markets, creator), RPC deployer profile (fresh/funder/same-day pump.fun creates), Binance public
klines + CoinGecko simple price (market regime). Optional Nansen (--nansen K): smart-money dex-trades last 24h for the top K tokens
(1 credit each, cached 6h, same guarded ledger as the backtest; floor 300; never a >=100-credit endpoint).
Usage: pl_live.py [N=20] [--nansen K]"""
import sys, os, json, time, statistics, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plcommon as P
import pl_backtest as B
import pl_fetch_free as FF
PC = P.PC

def gt_trades(pool):
    j = PC.http(f'https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/trades') or {}
    out = []
    for d in j.get('data') or []:
        a = d.get('attributes') or {}
        side = 'BUY' if a.get('kind') == 'buy' else 'SELL'
        amt = float(a.get('to_token_amount') if side == 'BUY' else a.get('from_token_amount') or 0)
        out.append({'t': P.tsof(a.get('block_timestamp')), 'w': a.get('tx_from_address'), 'label': '', 'side': side, 'amt': amt, 'usd': float(a.get('volume_in_usd') or 0),
                    'px': float(a.get('price_to_in_usd') if side == 'BUY' else a.get('price_from_in_usd') or 0) or None, 'tx': a.get('tx_hash')})
    return sorted([x for x in out if x['t']], key=lambda x: x['t'])

def gt_ohlcv5(pool):
    j = PC.http(f'https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool}/ohlcv/minute?aggregate=5&limit=144&currency=usd') or {}
    rows = sorted(((j.get('data') or {}).get('attributes') or {}).get('ohlcv_list') or [])
    return [{'t': r[0], 'o': r[1], 'h': r[2], 'l': r[3], 'c': r[4], 'v': r[5], 'bv': 0, 'sv': 0} for r in rows]

def mint_auth(mints):
    out = {}
    for i in range(0, len(mints), 100):
        r = PC.rpc('getMultipleAccounts', [mints[i:i + 100], {'encoding': 'jsonParsed'}]) or {}
        for m, v in zip(mints[i:i + 100], r.get('value') or []):
            try:
                info = v['data']['parsed']['info']; out[m] = {'mintAuthority': info.get('mintAuthority'), 'freezeAuthority': info.get('freezeAuthority'), 'program': v.get('owner')}
            except Exception: out[m] = None
    return out

def market_now():
    M = {}
    try:
        kl = {}
        for s in ['BTCUSDT', 'ETHUSDT', 'ETHBTC'] + [a + 'USDT' for a in FF.ALTS]:
            r = PC.http(f'{FF.BX}?symbol={s}&interval=1d&limit=40') or []
            kl[s] = [[int(x[0] / 1000), float(x[4]), float(x[2]), float(x[3])] for x in r]
        C = {'market': {**kl, 'cg_tether': [], 'cg_usd-coin': []}}
        mk = B.mk_market(C); now = int(time.time())
        M['beta'] = mk['beta'](now); M['cascade'] = mk['cascade'](now); M['altseason'] = mk['altseason'](now)
    except Exception as e: M['err_klines'] = str(e)[:100]
    try:
        sp = PC.http('https://api.coingecko.com/api/v3/simple/price?ids=tether,usd-coin,ethena-usde,dai&vs_currencies=usd') or {}
        M['stables'] = {k: v.get('usd') for k, v in sp.items()}
        lo = min((v for v in M['stables'].values() if v), default=None)
        M['depeg'] = [lo is not None and lo < 0.997, {'stable_min_now': lo}]
    except Exception as e: M['err_stables'] = str(e)[:100]
    M['season'] = B.season_feats(int(time.time()))
    return M

def stub(x, tape):
    now = int(time.time()); c = now - int((x.get('ageH') or 24) * 3600)
    return {'symbol': x['symbol'], 'mint': x['address'], 'cohort': 'live', 'crashed': False, 'peak_t': now + 10 ** 7, 'dump_t': None, 'created_t': c,
            'db': {'supply': (x.get('fdv') / x['price']) if x.get('fdv') and x.get('price') else None}, 'holders': [], 'ohlcv': []}

def main():
    N = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 20
    K = int(sys.argv[sys.argv.index('--nansen') + 1]) if '--nansen' in sys.argv else 0
    feed = P.jload('live_feed.json') or {'items': []}
    sol = [x for x in feed['items'] if x['chain'] == 'solana']
    top = sorted([x for x in sol if x.get('grade') and x.get('score') is not None], key=lambda x: -x['score'])[:N]
    out = {'universe': f'live_feed.json: {len(sol)} Solana items (mint/freeze batch), top {len(top)} by score for trade-tape patterns', 'tokens': {}, 'errors': []}
    try: ma = mint_auth([x['address'] for x in sol])
    except Exception as e: ma = {}; out['errors'].append('mint_auth ' + str(e)[:80])
    for x in sol:
        a = ma.get(x['address'])
        if a: out['tokens'].setdefault(x['key'], {'symbol': x['symbol'], 'flags': {}})['flags'].update({
            '4': {'flag': bool(a['mintAuthority']), 'value': a['mintAuthority'] or 'revoked'}, '5': {'flag': bool(a['freezeAuthority']), 'value': a['freezeAuthority'] or 'revoked'}})
    C = {'tape': {}, 'sm': {}, 'sells': {}, 'fv': {}, 'devs': {}, 'buyers': {}, 'jito': {}, 'meta': {}, 'market': {}}
    T = []
    for x in top:
        fvp = ((P.jload('fakevolume_live.json') or {}).get('tokens') or {}).get(x['key'], {}).get('pool')
        pool = fvp or P.cached('live_gt_pool', x['address'], lambda: ((((PC.http(f"https://api.geckoterminal.com/api/v2/networks/solana/tokens/{x['address']}/pools?page=1") or {}).get('data') or [{}])[0].get('attributes') or {}).get('address')), max_age=86400)
        if not pool: out['errors'].append(f"{x['symbol']} no pool"); continue
        try: tape = P.cached('live_gt_trades', pool, lambda: gt_trades(pool) or None, max_age=600) or []
        except Exception as e: out['errors'].append(f"{x['symbol']} trades {str(e)[:60]}"); tape = []
        st = stub(x, tape); T.append(st); C['tape'][x['address']] = tape
        rec = out['tokens'].setdefault(x['key'], {'symbol': x['symbol'], 'flags': {}}); rec['tape_trades'] = len(tape); rec['grade'] = x.get('grade'); rec['score'] = x.get('score')
        # RugCheck: mutable metadata, markets, creator
        try:
            rc = P.cached('live_rugcheck', x['address'], lambda: PC.http(f"https://api.rugcheck.xyz/v1/tokens/{x['address']}/report"), max_age=6 * 3600) or {}
            tm = rc.get('tokenMeta') or {}
            rec['flags']['6'] = {'flag': bool(tm.get('mutable')), 'value': 'metadata mutable' if tm.get('mutable') else 'immutable'}
            mk = rc.get('markets') or []
            liqs = sorted([float((m.get('lp') or {}).get('quoteUSD') or 0) + float((m.get('lp') or {}).get('baseUSD') or 0) for m in mk], reverse=True)
            share = (sum(liqs[:2]) / sum(liqs)) if liqs and sum(liqs) else None
            rec['flags']['10'] = {'flag': len(mk) <= 2, 'value': f'{len(mk)} pool(s)' + (f', top-2 hold {share * 100:.0f}% of liquidity' if share is not None else ''), 'note': 'launchpad tokens always start in 1-2 pools'}
            creator = rc.get('creator')
        except Exception as e: creator = None; out['errors'].append(f"{x['symbol']} rugcheck {str(e)[:60]}")
        # deployer: fresh / funder / same-day pump.fun creates (#3, #36)
        if creator:
            try:
                prof = FF.wallet_profile(creator, 2)
                fresh = prof.get('first_tx') is not None and time.time() - prof['first_tx'] <= 3 * 86400 + (x.get('ageH') or 0) * 3600
                ofac = set((P.jload('patternlab_cache/market.json') or {}).get('ofac', {}).get('SOL', []))
                rec['flags']['3'] = {'flag': fresh or prof.get('funder') in ofac, 'value': ('fresh deployer' if fresh else f"deployer {prof.get('n_sigs')} txs{' (full history)' if prof.get('exhausted') else '+'}") + (f", funded by {str(prof.get('funder'))[:6]}…" if prof.get('funder') else ''),
                                     'funder': prof.get('funder'), 'sanctioned': prof.get('funder') in ofac}
                s = FF.oldest_sigs(creator, 2)['sigs']; near = [y for y in s if y['t'] and time.time() - y['t'] <= 86400 and not y['err']][:15]
                n = 0
                for y in near:
                    tx = PC.tx(y['sig']); logs = ((tx or {}).get('meta') or {}).get('logMessages') or []
                    if any(FF.PUMP in l for l in logs) and any('Instruction: Create' in l and 'Associated' not in l for l in logs): n += 1
                rec['flags']['36'] = {'flag': n >= 2, 'value': f'{n} pump.fun create(s) by the deployer in the last 24h (checked {len(near)} txs)'}
            except Exception as e: out['errors'].append(f"{x['symbol']} dev {str(e)[:60]}")
        # 5-min OHLCV for phase + absorption fallback
        try: C.setdefault('bars', {})[x['address']] = P.cached('live_gt_ohlcv5', pool, lambda: gt_ohlcv5(pool), max_age=600)
        except Exception: pass
    # fake-volume (same lib/fakevolume.js) on the live tapes
    import subprocess
    inp = {m: [{'t': y['t'], 'trader': y['w'], 'side': y['side'].lower(), 'usd': y['usd'], 'amt': y['amt']} for y in tp] for m, tp in C['tape'].items() if tp}
    try: C['fv'] = json.loads(subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'fv_bridge.js')], input=json.dumps(inp), capture_output=True, text=True, timeout=120).stdout or '{}')
    except Exception as e: out['errors'].append('fv ' + str(e)[:60])
    def put(pid, rows, why):
        for r, x in zip(rows, top):
            if not r.get('testable', True): continue
            det = {k: v for k, v in r.items() if k not in ('symbol', 'mint', 'cohort', 'flag', 'testable', 't_flag', 'lead_pump_h', 'lead_peak_h', 'lead_h')}
            out['tokens'][x['key']]['flags'][str(pid)] = {'flag': r['flag'], 'value': why(det), 'detail': det}
    r7, _ = B.p7(T, C); put(7, r7, lambda d: f"clean volume {round((d.get('clean_volume_share') or 0) * 100)}% (MEV-bot {round((d.get('mevbot_vol_share') or 0) * 100)}%, fake {round((d.get('fake_share') or 0) * 100)}%)")
    r8, _ = B.p8(T, C); put(8, r8, lambda d: f"{d.get('sandwiches')} suspected sandwich(es) in the last {len(C['tape'].get(top[0]['address']) or [])} trades" if top else '')
    (r11, _), (r12, _) = B.p11p12(T, C); put(11, r11, lambda d: f"fake share {d.get('fake_share')}, LP-pull leg: {d.get('lp_pull')}"); put(12, r12, lambda d: f"{d.get('rings')} wallet ring(s), {d.get('round_trip_wallets')} self-trading wallet(s)")
    r13, _ = B.p13(T, C); put(13, r13, lambda d: f"max {d.get('max_followers')} wallets mirroring one source within 3 s")
    r22, _ = B.p22(T, C); put(22, r22, lambda d: f"{d.get('frontruns')} suspected front-run(s)")
    r32, _ = B.p32(T, C); put(32, r32, lambda d: 'top-10 share fell while price rose' if d else '')
    r37, _ = B.p37(T, C); put(37, r37, lambda d: 'burst of first-time wallets after a quiet hour')
    rd, rb = B.p34(T, C); put(34, rd, lambda d: d.get('side') or 'no bearish absorption')
    for r, x in zip(rb, top):
        if r['flag']: out['tokens'][x['key']]['flags']['34'] = {'flag': True, 'value': 'buyers absorbing sells (bullish absorption)', 'direction': 'pump'}
    # phase on 5-min OHLCV
    for x in top:
        bs = (C.get('bars') or {}).get(x['address']) or []
        if len(bs) >= 8:
            t = stub(x, []); C2 = {'tape': {x['address']: []}}
            ph = None
            c = [b['c'] for b in bs[-12:]]; v = [b['v'] for b in bs[-12:]]; hi, lo = max(c), min(c); k = len(c) // 2
            v1, v2 = sum(v[:k]) / k, sum(v[k:]) / (len(v) - k)
            if c[-1] <= hi * 0.6 and c.index(hi) < len(c) - 2: ph = 'markdown'
            elif c[-1] >= hi * 0.85 and c[-1] > c[0] * 1.3 and v2 >= v1: ph = 'markup'
            elif c[-1] >= hi * 0.85 and v2 < v1 * 0.8: ph = 'distribution'
            elif (hi - lo) / lo < 0.35 and v2 >= v1 * 1.2: ph = 'accumulation'
            else: ph = 'neutral'
            out['tokens'][x['key']]['flags']['26'] = {'flag': ph in ('distribution', 'markdown'), 'value': ph, 'direction': 'pump' if ph == 'accumulation' else 'crash' if ph in ('distribution', 'markdown') else None}
    # optional Nansen smart-money (24h) for the top K
    nused = 0
    if K:
        P.balance(); bal0 = P.NL['remaining']
        for x in top[:K]:
            now = int(time.time()) // 21600 * 21600
            body = {'chain': 'solana', 'token_address': x['address'], 'only_smart_money': True, 'date': {'from': P.iso(now - 86400), 'to': P.iso(now + 21600)}, 'pagination': {'page': 1, 'per_page': 500}, 'order_by': [{'field': 'block_timestamp', 'direction': 'ASC'}]}
            try: j = P.nansen('tgm/dex-trades', body, K + 1, 'live_sm')
            except P.NansenStop as e: out['errors'].append('nansen stop ' + str(e)); break
            d = [{'t': P.tsof(y['block_timestamp']), 'w': y['trader_address'], 'side': y['action'], 'usd': float(y.get('estimated_value_usd') or 0), 'label': y.get('trader_address_label') or ''} for y in ((j or {}).get('data') or [])]
            tc, ws = B.first_cluster(d, 2, 3600, 'SELL', min_usd=50)
            buyers = {y['w'] for y in d if y['side'] == 'BUY'}; net = sum(y['usd'] * (1 if y['side'] == 'BUY' else -1) for y in d)
            fl = out['tokens'][x['key']]['flags']
            fl['1'] = {'flag': tc is not None, 'value': f"{len(ws)} smart-money wallets sold within 1h" if tc else f"{len({y['w'] for y in d})} smart-money wallets traded, no clustered exit", 'source': 'Nansen tgm/dex-trades only_smart_money 24h'}
            fl['2'] = {'flag': len(buyers) >= 2 and net > 0, 'value': f"{len(buyers)} smart-money buyers, net ${net:,.0f} (24h)", 'direction': 'pump', 'source': 'Nansen'}
        P.balance(); out['nansen'] = {'balance_before': bal0, 'balance_after': P.NL['remaining'], 'run_used': P.RUN['used']}
    out['market'] = market_now()
    P.save('patternlab_live.json', out)

if __name__ == '__main__':
    main()
