#!/usr/bin/env python3
"""Detectors 3 + 5: dev/top-holder outflows to CEX wallets and into cross-chain bridges (Solana, public RPC only).
Wallets per token: research-DB deployer + top-2 system-owned holders (DB snapshot). Window: [created-2d, peak+7d] (capped at now).
Each in-window tx (<=TXCAP per wallet, nearest to the peak first) is fetched with getTransaction(jsonParsed) and classified:
  * CEX deposit: SOL/SPL transfer from the wallet whose destination (or destination token-account owner) is a labelled CEX wallet
    (data/patterns_labels.json). 2-hop: SOL recipients of >=5 SOL are checked for a forward to a labelled CEX / bridge within 7d.
  * Bridge: tx invokes a registered bridge program (data/bridges_registry.json). Direction from the wallet's own SOL / token deltas.
    Destination chain + address resolved via free explorer APIs (Wormholescan, deBridge DLN, Relay, CCTP iris, LayerZero scan).
Price impact: GeckoTerminal hourly cache written by patterns_hours.py (same pools). Lead time = crash break (-30% from peak) - event time.
Usage: patterns_flows.py backtest [n_died] [n_mooned] | live"""
import glob, json, os, random, sqlite3, sys, time, datetime as dt
from patterns_common import *
SYS = '11111111111111111111111111111111'
LAB = json.load(open(os.path.join(DATA_DIR, 'patterns_labels.json')))
REG = json.load(open(os.path.join(DATA_DIR, 'bridges_registry.json')))
CEX = LAB['cex']['solana']; BR = REG['solana']
STABLE = {'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT'}
WSOL = 'So11111111111111111111111111111111111111112'
TXCAP = 25

_solpx = None
def sol_price(ts):
    global _solpx
    if _solpx is None:
        d = cached('misc', 'sol_cg_365d', lambda: http('https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=365&interval=daily'), max_age=86400)
        _solpx = sorted((int(t / 1000), p) for t, p in (d or {}).get('prices', []))
    best = None
    for t, p in _solpx:
        if t <= ts + 86400: best = p
        else: break
    return best or (_solpx[-1][1] if _solpx else None)

def classify(t, W):
    """returns list of events for wallet W in parsed tx t."""
    if not t or not t.get('meta') or t['meta'].get('err'): return [], []
    msg = t['transaction']['message']; keys = [k['pubkey'] if isinstance(k, dict) else k for k in msg['accountKeys']]
    meta = t['meta']; ts = t.get('blockTime'); sig = t['transaction']['signatures'][0]
    ins = list(msg.get('instructions', []))
    for g in meta.get('innerInstructions') or []: ins += g.get('instructions', [])
    progs = {i.get('programId') for i in ins}
    # deltas for W
    sol_d = 0.0
    if W in keys:
        i = keys.index(W); sol_d = (meta['postBalances'][i] - meta['preBalances'][i]) / 1e9
        if i == 0: sol_d += meta.get('fee', 0) / 1e9
    tok = {}
    for side, sgn in (('preTokenBalances', -1), ('postTokenBalances', 1)):
        for b in meta.get(side) or []:
            if b.get('owner') == W:
                tok[b['mint']] = tok.get(b['mint'], 0) + sgn * float(b['uiTokenAmount'].get('uiAmount') or 0)
    owner_of = {keys[b['accountIndex']]: b.get('owner') for b in (meta.get('postTokenBalances') or []) + (meta.get('preTokenBalances') or [])}
    px = sol_price(ts) or 0
    usd = lambda sol, tk: abs(sol) * px + sum(abs(v) for m, v in tk.items() if m in STABLE) + sum(abs(v) * px for m, v in tk.items() if m == WSOL)
    ev = []
    br = [BR[p] for p in progs if p in BR]
    if br:
        out_tok = {m: v for m, v in tok.items() if v < 0}; in_tok = {m: v for m, v in tok.items() if v > 0}
        direction = 'out' if (sol_d < -0.02 or out_tok) else ('in' if (sol_d > 0.02 or in_tok) else 'unknown')
        ev.append({'type': 'bridge', 'bridge': br[0]['bridge'], 'role': br[0]['role'], 'dir': direction, 't': ts, 'sig': sig, 'sol': round(sol_d, 4),
                   'tokens': {m[:6]: round(v, 2) for m, v in tok.items()}, 'usd': round(usd(sol_d if direction != 'unknown' else 0, out_tok if direction == 'out' else in_tok), 2)})
    recips = []
    for i in ins:
        p = i.get('parsed')
        if not isinstance(p, dict): continue
        info = p.get('info', {}); ty = p.get('type')
        if i.get('program') == 'system' and ty in ('transfer', 'transferWithSeed') and info.get('source') == W:
            dst = info.get('destination'); sol = info.get('lamports', 0) / 1e9
            if dst in CEX: ev.append({'type': 'cex', 'cex': CEX[dst], 'dst': dst, 't': ts, 'sig': sig, 'sol': sol, 'usd': round(sol * px, 2), 'asset': 'SOL'})
            elif sol >= 5: recips.append((dst, sol))
        elif i.get('program') in ('spl-token', 'spl-token-2022') and ty in ('transfer', 'transferChecked') and (info.get('authority') == W or info.get('multisigAuthority') == W):
            dst = info.get('destination'); o = owner_of.get(dst)
            amt = float((info.get('tokenAmount') or {}).get('uiAmount') or 0) if ty == 'transferChecked' else None
            mint = info.get('mint')
            if o in CEX or dst in CEX:
                ev.append({'type': 'cex', 'cex': CEX.get(o) or CEX.get(dst), 'dst': o or dst, 't': ts, 'sig': sig, 'asset': (STABLE.get(mint) or (mint or '?')[:6]), 'amount': amt,
                           'usd': round(amt, 2) if mint in STABLE and amt else None})
    return ev, recips

def resolve_bridge(e):
    """destination chain/address via free explorer APIs. best-effort."""
    sig = e['sig']; b = e['bridge']
    def f():
        try:
            if b == 'Wormhole' or b == 'Mayan':
                j = http(f'https://api.wormholescan.io/api/v1/operations?txHash={sig}')
                for op in (j or {}).get('operations', []):
                    sp = (op.get('content') or {}).get('standarizedProperties') or {}
                    return {'via': 'wormholescan', 'toChain': sp.get('toChain'), 'toAddress': sp.get('toAddress'), 'amount': sp.get('amount'), 'appIds': sp.get('appIds')}
            if b == 'deBridge':
                j = http(f'https://stats-api.dln.trade/api/Transaction/{sig}/orderIds')
                ids = (j or {}).get('orderIds') or []
                if ids:
                    oid = ids[0]['stringValue'] if isinstance(ids[0], dict) else ids[0]
                    o = http(f'https://stats-api.dln.trade/api/Orders/{oid}') or {}
                    import base64
                    tk = o.get('takeOfferWithMetadata') or {}
                    cid = int.from_bytes(base64.b64decode(tk.get('chainId', {}).get('bytesValue') or 'AA=='), 'big')
                    return {'via': 'debridge-stats', 'orderId': oid, 'toChain': cid, 'toAddress': (o.get('receiverDst') or {}).get('stringValue'), 'takeToken': tk.get('symbol'), 'status': o.get('state')}
            if b == 'Relay':
                j = http(f'https://api.relay.link/requests/v2?hash={sig}')
                r = ((j or {}).get('requests') or [None])[0]
                if r: return {'via': 'relay', 'toChain': (r.get('data') or {}).get('outTxs', [{}])[0].get('chainId'), 'toAddress': r.get('recipient'), 'status': r.get('status')}
            if b == 'Circle CCTP':
                j = http(f'https://iris-api.circle.com/v2/messages/5?transactionHash={sig}')
                m = ((j or {}).get('messages') or [None])[0]
                if m: return {'via': 'circle-iris', 'toChain': (m.get('decodedMessage') or {}).get('destinationDomain'), 'toAddress': ((m.get('decodedMessage') or {}).get('decodedMessageBody') or {}).get('mintRecipient')}
            if b == 'LayerZero':
                j = http(f'https://scan.layerzero-api.com/v1/messages/tx/{sig}')
                m = ((j or {}).get('data') or [None])[0]
                if m: return {'via': 'layerzero-scan', 'toChain': (m.get('pathway') or {}).get('receiver', {}).get('chain'), 'toAddress': (m.get('pathway') or {}).get('receiver', {}).get('address')}
        except Exception as ex:
            return {'via': 'error', 'err': str(ex)[:120]}
        return {'via': 'unresolved'}
    return cached('bridge_resolve', sig, f)

def hourly_for(chain, pool):
    net = {'solana': 'solana', 'base': 'base', 'bsc': 'bsc'}.get(chain)
    fs = glob.glob(os.path.join(CACHE, 'gt_hour', f'{net}_{pool}_*.json'))
    rows = []
    for f in fs:
        try: rows += json.load(open(f)).get('rows', [])
        except Exception: pass
    return sorted({r[0]: r for r in rows}.values())

def impact(rows, t):
    if not rows or not t: return {}
    before = [r for r in rows if r[0] <= t]
    if not before: return {}
    p0 = before[-1][4]; out = {}
    for h in (24, 72):
        nxt = [r[4] for r in rows if t < r[0] <= t + h * 3600]
        if nxt and p0: out[f'min_ret_{h}h_pct'] = round((min(nxt) / p0 - 1) * 100, 1)
    return out

def scan_wallet(W, role, t0, t1, peak):
    s, done = sigs(W, max_pages=3, until_ts=t0)
    win = [x for x in s if x['t'] and t0 <= x['t'] <= t1 and not x['err']]
    reach = done or (s and s[-1]['t'] and s[-1]['t'] <= t0)
    win.sort(key=lambda x: abs(x['t'] - peak))
    evs, rec = [], []
    for x in win[:TXCAP]:
        try:
            e, r = classify(tx(x['sig']), W)
        except Exception as ex: log('tx err', str(ex)[:80]); continue
        for y in e: y['wallet'] = W; y['role'] = role
        evs += e; rec += [(a, v, x['t']) for a, v in r]
    # 2-hop: big SOL recipients -> CEX / bridge within 7d
    for a, v, ts in sorted(rec, key=lambda z: -z[1])[:2]:
        if a in BR: continue
        try:
            s2, _ = sigs(a, max_pages=1)
            for y in [z for z in s2 if z['t'] and ts <= z['t'] <= ts + 7 * 86400][-6:]:
                e2, _ = classify(tx(y['sig']), a)
                for z in e2:
                    if z['type'] in ('cex', 'bridge') and (z['type'] == 'cex' or z.get('dir') == 'out'):
                        z.update({'wallet': W, 'role': role, 'via': a, 'hop': 2, 'hop1_sol': v, 'hop1_t': ts}); evs.append(z)
        except Exception as ex: log('2hop err', str(ex)[:80])
    return {'wallet': W, 'role': role, 'n_sigs_window': len(win), 'parsed': min(len(win), TXCAP), 'window_reachable': bool(reach), 'events': evs}

def token_flows(mint, chain, pool, dev, holders, created, peak, now):
    t0 = (created or peak - 3 * 86400) - 2 * 86400; t1 = min(peak + 7 * 86400, now)
    ws = []
    if dev: ws.append((dev, 'dev'))
    acc = {}
    try:
        r = rpc('getMultipleAccounts', [[o for o, _ in holders[:12]], {'encoding': 'base64', 'dataSlice': {'offset': 0, 'length': 0}}])
        acc = dict(zip([o for o, _ in holders[:12]], (r or {}).get('value', [])))
    except Exception: pass
    top = [o for o, _ in holders[:12] if acc.get(o) and acc[o].get('owner') == SYS and o != dev][:2]
    ws += [(o, 'top') for o in top]
    res = [scan_wallet(W, role, t0, t1, peak) for W, role in ws]
    rows = hourly_for(chain, pool)
    evs = []
    for w in res:
        for e in w['events']:
            e.update(impact(rows, e['t']))
            if e['type'] == 'bridge': e['dest'] = resolve_bridge(e)
            evs.append(e)
    return res, evs

def load_hours():
    try: return {e['key']: e for e in json.load(open(os.path.join(DATA_DIR, 'patterns_hours.json')))['events']}
    except Exception: return {}

def load_clusters():
    out = {}
    for f in ('patterns_wallets.json', 'patterns_wallets_live.json'):
        try:
            for t in json.load(open(os.path.join(DATA_DIR, f))).get('tokens' if 'live' not in f else 'items', []):
                for w in t.get('cluster_wallets', []): out[w] = t.get('symbol')
        except Exception: pass
    return out

def merge_exit(evs, hours_ev, thin_hours, clusters):
    """ONE coordinated exit event per token: outbound bridge / CEX moves from dev/top wallets within [peak-3d, peak+3d] or during the dump."""
    pk = hours_ev.get('peak_t') if hours_ev else None
    out = [e for e in evs if ((e['type'] == 'cex') or (e['type'] == 'bridge' and e['dir'] == 'out')) and (not pk or e['t'] >= pk - 3 * 86400)]
    if not out: return None
    tot = sum(e.get('usd') or 0 for e in out)
    sc = min(40, tot / 250) + 10 * len({e['type'] for e in out}) + (15 if any(e['type'] == 'bridge' for e in out) and any(e['type'] == 'cex' for e in out) else 0)
    hrs = [dt.datetime.fromtimestamp(e['t'], UTC).hour for e in out]
    if any(h in thin_hours for h in hrs): sc += 10
    if any(e['wallet'] in clusters for e in out): sc += 15
    if any(e.get('dev', {}) for e in out): pass
    return {'score': round(sc, 1), 'usd_total': round(tot, 2), 'n_moves': len(out), 'kinds': sorted({e['type'] if e['type'] == 'cex' else 'bridge:' + e['bridge'] for e in out}),
            'first_t': min(e['t'] for e in out), 'thin_hour_hit': any(h in thin_hours for h in hrs), 'fresh_cluster_hit': any(e['wallet'] in clusters for e in out),
            'lead_h_before_break': round((hours_ev['break_t'] - min(e['t'] for e in out)) / 3600, 1) if hours_ev and hours_ev.get('break_t') else None,
            'h_vs_peak': round((min(e['t'] for e in out) - pk) / 3600, 1) if pk else None}

def backtest(nd, nm):
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    cat = json.load(open(os.path.join(DATA_DIR, 'crash_catalog.json')))['catalog']
    cat_ids = {c['address'] for c in cat if c.get('source') == 'research DB' and c.get('chain') == 'solana'}
    toks = db.execute("select mint,symbol,cohort,created_ts,peak_ts,main_pool,dev from tokens where chain='solana' and cohort in ('died','mooned') and peak_ts is not null").fetchall()
    random.seed(11)
    D = [t for t in toks if t[2] == 'died' and t[0] in cat_ids]; M = [t for t in toks if t[2] == 'mooned']
    random.shuffle(D); random.shuffle(M)
    H = load_hours(); now = int(time.time())
    try: thin = set(json.load(open(os.path.join(DATA_DIR, 'patterns_hours.json')))['onset_all']['thinnest8_hours_by_volume'])
    except Exception: thin = set()
    CL = load_clusters(); out = []
    for i, (mint, sym, coh, cts, pts, pool, dev) in enumerate(D[:nd] + M[:nm]):
        hs = db.execute('select owner,pct from top_holders where mint=? order by pct desc', (mint,)).fetchall()
        try: res, evs = token_flows(mint, 'solana', pool, dev, hs, cts // 1000 if cts else None, pts // 1000, now)
        except Exception as ex: log('token err', sym, str(ex)[:100]); continue
        hev = H.get('solana:' + mint)
        ex = merge_exit(evs, hev, thin, CL)
        inb = [e for e in evs if e['type'] == 'bridge' and e['dir'] == 'in' and e['t'] < pts // 1000]
        r = {'mint': mint, 'symbol': sym, 'cohort': coh, 'peak_t': pts // 1000, 'crash_break_t': hev.get('break_t') if hev else None, 'wallets': [{k: v for k, v in w.items() if k != 'events'} for w in res],
             'events': evs, 'exit_event': ex, 'inbound_bridge_before_peak': len(inb), 'inbound_bridge_usd': round(sum(e.get('usd') or 0 for e in inb), 2)}
        out.append(r); log(i, sym, coh, 'events', len(evs), 'exit', ex and ex['score'])
        if i % 5 == 4: summarise(out, partial=True)
    summarise(out)

def summarise(out, partial=False):
    D = [r for r in out if r['cohort'] == 'died']; M = [r for r in out if r['cohort'] == 'mooned']
    def rate(g, f): return {'n': len(g), 'flagged': sum(1 for r in g if f(r)), 'rate': round(sum(1 for r in g if f(r)) / len(g), 3) if g else None}
    cexf = lambda r: any(e['type'] == 'cex' for e in r['events'])
    brf = lambda r: any(e['type'] == 'bridge' and e['dir'] == 'out' for e in r['events'])
    brany = lambda r: any(e['type'] == 'bridge' for e in r['events'])
    exf = lambda r: bool(r['exit_event'])
    leads = lambda g, typ: sorted(round((r['crash_break_t'] - min(e['t'] for e in r['events'] if typ(e))) / 3600, 1) for r in g if r['crash_break_t'] and any(typ(e) for e in r['events']))
    res = {'partial': partial, 'params': {'TXCAP_per_wallet': TXCAP, 'wallets': 'dev + top-2 system-owned holders', 'window': '[created-2d, peak+7d]', 'two_hop_min_sol': 5},
           'labels': {'cex_solana_addresses': len(CEX), 'bridge_programs_solana': len(BR), 'cex_source': LAB['source']},
           'sample': {'died_from_catalog': len(D), 'mooned': len(M), 'wallets_scanned': sum(len(r['wallets']) for r in out), 'txs_parsed': sum(w['parsed'] for r in out for w in r['wallets']),
                      'wallets_window_unreachable': sum(1 for r in out for w in r['wallets'] if not w['window_reachable'])},
           'cex': {'died': rate(D, cexf), 'mooned': rate(M, cexf), 'lead_h_first_cex_before_break_died': leads(D, lambda e: e['type'] == 'cex')},
           'bridge_out': {'died': rate(D, brf), 'mooned': rate(M, brf), 'lead_h_before_break_died': leads(D, lambda e: e['type'] == 'bridge' and e['dir'] == 'out')},
           'bridge_any': {'died': rate(D, brany), 'mooned': rate(M, brany)},
           'inbound_bridge_before_peak': {'died': rate(D, lambda r: r['inbound_bridge_before_peak'] > 0), 'mooned': rate(M, lambda r: r['inbound_bridge_before_peak'] > 0)},
           'exit_event': {'died': rate(D, exf), 'mooned': rate(M, exf)},
           'tokens': out}
    save('patterns_flows.json', res)

def live(n=8):
    """live: deployer (pump.fun API creator, free) + top-2 holders of top live Solana tokens; last 3 days."""
    f = json.load(open(os.path.join(DATA_DIR, 'live_feed.json')))
    items = sorted([x for x in f['items'] if x['chain'] == 'solana'], key=lambda x: -(x.get('score') or 0))[:n]
    from patterns_wallets import live_holders
    now = int(time.time()); CL = load_clusters(); out = []
    for x in items:
        mint = x['address']; dev = None
        try:
            from patterns_wallets import rugcheck
            dev = (rugcheck(mint) or {}).get('creator')
        except Exception: pass
        try:
            hs = live_holders(mint)
            res, evs = token_flows(mint, 'solana', None, dev, hs, now - 3 * 86400, now, now)
        except Exception as ex: log('live err', x['symbol'], str(ex)[:100]); continue
        outb = [e for e in evs if e['type'] == 'cex' or (e['type'] == 'bridge' and e['dir'] == 'out')]
        out.append({'key': x['key'], 'symbol': x['symbol'], 'grade': x.get('grade'), 'mcap': x.get('mcap'), 'dev': dev, 'wallets': len(res), 'events': evs,
                    'flag': bool(outb) and sum(e.get('usd') or 0 for e in outb) >= 1000, 'out_usd': round(sum(e.get('usd') or 0 for e in outb), 2),
                    'inbound_bridge_usd': round(sum(e.get('usd') or 0 for e in evs if e['type'] == 'bridge' and e['dir'] == 'in'), 2), 'fresh_cluster_wallet': any(e['wallet'] in CL for e in evs)})
        log('live', x['symbol'], len(evs))
    save('patterns_flows_live.json', {'items': out, 'rule': 'flag if dev/top-2 holders sent >= $1k to labelled CEX or outbound bridge in last 3 days'})

def reresolve():
    p = os.path.join(DATA_DIR, 'patterns_flows.json'); d = json.load(open(p))
    for t in d['tokens']:
        for e in t['events']:
            if e['type'] == 'bridge' and (e.get('dest') or {}).get('via') in (None, 'unresolved', 'error'):
                f = os.path.join(CACHE, 'bridge_resolve', e['sig'] + '.json')
                if os.path.exists(f): os.remove(f)
                e['dest'] = resolve_bridge(e)
    json.dump(d, open(p, 'w'), default=str); log('re-resolved')

if __name__ == '__main__':
    if sys.argv[1] == 'reresolve': reresolve(); sys.exit()
    if sys.argv[1] == 'backtest': backtest(int(sys.argv[2]) if len(sys.argv) > 2 else 30, int(sys.argv[3]) if len(sys.argv) > 3 else 20)
    else: live(int(sys.argv[2]) if len(sys.argv) > 2 else 8)
