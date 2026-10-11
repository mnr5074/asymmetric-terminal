#!/usr/bin/env python3
"""Copy-trade watch: wallet discovery + scoring (ALERTS ONLY, never trades). Free sources only, no Nansen calls, no X API.

Solana (primary):
  1. Catalog runners (data/moonshot.db, quality='ok', pump.fun mints, big multiple) -> full early trade tape + large-trade tape
     from pump.fun's public trade API (swap-api.pump.fun/v2/coins/<mint>/trades, no login; covers bonding curve + PumpSwap).
     Per wallet per runner: SOL in on buys, SOL out on sells, entry mcap, first-slot flag, same-slot round trips.
  2. kolscan.io public leaderboard (embedded JSON in the HTML, no login): realized SOL profit + wins/losses for 1d / 7d / 30d.
  3. Nansen labels ALREADY on disk (data/nansen_crash_raw.json; no new calls): positive (Smart Trader, Token Millionaire,
     Top-100 leaderboard) and negative (MEV Bot, Trading Bot, Token Deployer -> excluded).
  4. Verification on public Solana RPC for the shortlist: last <=200 signatures (activity rate, failed ratio) and up to
     VERIFY_TX recent successful txs parsed into swaps (pre/post balances, same method as lib/mev.js) -> realized P&L on
     positions opened AND sold inside the window, win rate, number of swaps, median hold.
Base / BSC (secondary, lower confidence): GeckoTerminal last-24h trades (<=300 per pool) of catalog runners -> realized USD per
  wallet inside that window + Nansen on-disk labels for BSC.
Output: data/copytrade.json (top ~50 per chain), data/copytrade_runners.json (per-runner early-buyer table).
Usage: copytrade.py [runners=30] [verify=70]"""
import json, math, os, re, sqlite3, statistics, sys, time
from collections import defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import patterns_common as pc
from patterns_common import http, rpc, cached, log, DATA_DIR, DB

pc.GAPS.update({'swap-api.pump.fun': 0.4, 'kolscan.io': 2.0})
N_RUNNERS = int(sys.argv[1]) if len(sys.argv) > 1 else 30
N_VERIFY = int(sys.argv[2]) if len(sys.argv) > 2 else 70
VERIFY_TX = int(os.environ.get('CT_VERIFY_TX', 30))
EARLY_MIN = 45            # "early" = first trade within 45 min of the first indexed trade
BIG_SOL = 1.0             # large-trade tape threshold (SOL)
EARLY_PAGES, BIG_PAGES = 10, 22
WSOL = 'So11111111111111111111111111111111111111112'
STABLES = {'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT'}
T0 = time.time()

def iso2ts(s): return int(time.mktime(time.strptime(s[:19], '%Y-%m-%dT%H:%M:%S')) - time.timezone)

# ---------------- pump.fun trade tape ----------------
def pf_page(mint, cursor=None, min_sol=None):
    u = f'https://swap-api.pump.fun/v2/coins/{mint}/trades?limit=100'
    if cursor: u += '&cursor=' + cursor
    if min_sol: u += f'&minSolAmount={min_sol}'
    try: j = http(u, retries=3)
    except Exception as e: log('pf err', mint[:8], e); return [], None
    if not j: return [], None
    pg = j.get('pagination') or {}
    return j.get('trades') or [], (pg.get('nextCursor') if pg.get('hasMore') else None)

def slot_of(t): return int(t['slotIndexId'][:12])

def cursor_at(mint, target_ts, ref):
    """Craft a cursor at target_ts using a (slot, ts) reference; refine twice with what the API returns."""
    s_ref, t_ref = ref
    for _ in range(3):
        slot = int(s_ref - (t_ref - target_ts) / 0.4)
        cur = f'{slot:012d}9999990000-{int(target_ts * 1000)}'
        tr, _nx = pf_page(mint, cur)
        if not tr: return cur
        s_ref, t_ref = slot_of(tr[0]), iso2ts(tr[0]['timestamp'])
        if abs(t_ref - target_ts) < 900: return cur
    return f'{int(s_ref - (t_ref - target_ts) / 0.4):012d}9999990000-{int(target_ts * 1000)}'

def runner_tape(r):
    mint = r['mint']
    def f():
        newest, _ = pf_page(mint)
        if not newest: return None
        ref = (slot_of(newest[0]), iso2ts(newest[0]['timestamp']))
        created = r['created_ts'] // 1000
        trades = {}
        def add(ts):
            for t in ts: trades[t['tx'] + t['userAddress'] + t['type']] = t
        # early tape: walk back from created+3h to the first indexed trade (all sizes)
        cur = cursor_at(mint, created + 90 * 60, ref); pages = 0; first_ts = None
        while cur and pages < EARLY_PAGES:
            tr, cur = pf_page(mint, cur); pages += 1; add(tr)
        early_complete = cur is None
        # large-trade tape: from peak+72h (or now) back to creation, >= BIG_SOL
        start = min(time.time(), (r['peak_ts'] or r['created_ts']) / 1000 + 72 * 3600)
        cur = cursor_at(mint, start, ref) if start < time.time() - 3600 else None
        pages = 0
        while pages < BIG_PAGES:
            tr, cur = pf_page(mint, cur, BIG_SOL); pages += 1; add(tr)
            if not cur or (tr and iso2ts(tr[-1]['timestamp']) < created): break
        out = [{'tx': t['tx'], 'u': t['userAddress'], 'side': t['type'], 'ts': iso2ts(t['timestamp']), 'slot': slot_of(t), 'sol': float(t.get('amountSol') or 0),
                'usd': float(t.get('amountUsd') or 0), 'px': float(t.get('priceUsd') or 0), 'base': float(t.get('baseAmount') or 0), 'prog': t.get('program')} for t in trades.values()]
        out.sort(key=lambda x: (x['slot'], x['tx']))
        return {'mint': mint, 'trades': out, 'early_complete': early_complete, 'big_pages': pages}
    return cached('ct_tape', mint, f, max_age=7 * 86400)

def runner_wallets(r, tape):
    tr = tape['trades']
    if not tr: return {}, {}
    first_ts, first_slot = tr[0]['ts'], tr[0]['slot']
    W = defaultdict(lambda: {'buySol': 0.0, 'sellSol': 0.0, 'buys': 0, 'sells': 0, 'first': None, 'entryMc': None, 'firstSlot': False, 'slots': defaultdict(set), 'baseB': 0.0, 'baseS': 0.0})
    for t in tr:
        w = W[t['u']]
        if t['side'] == 'buy':
            w['buySol'] += t['sol']; w['buys'] += 1; w['baseB'] += t['base']
            if w['first'] is None: w['first'] = t['ts']; w['entryMc'] = t['px'] * 1e9 if t['px'] else None
            if t['slot'] <= first_slot + 1: w['firstSlot'] = True
        else:
            w['sellSol'] += t['sol']; w['sells'] += 1; w['baseS'] += t['base']
        w['slots'][t['slot']].add(t['side'])
    out = {}
    for a, w in W.items():
        rt = sum(1 for s in w['slots'].values() if len(s) == 2)
        early = w['first'] is not None and ((tape['early_complete'] and w['first'] - first_ts <= EARLY_MIN * 60) or (w['entryMc'] and r.get('peak_mcap') and w['entryMc'] <= r['peak_mcap'] / 30))
        # matched-quantity realized P&L: only the part of the position seen both bought and sold counts (missing tape never inflates P&L)
        if w['baseB'] > 0 and w['baseS'] > 0:
            pnl = w['sellSol'] * min(1.0, w['baseB'] / w['baseS']) - w['buySol'] * min(1.0, w['baseS'] / w['baseB'])
        else: pnl = 0.0
        out[a] = {'buySol': round(w['buySol'], 3), 'sellSol': round(w['sellSol'], 3), 'pnlSol': round(pnl, 3), 'matched': w['baseB'] > 0 and w['baseS'] > 0, 'buys': w['buys'], 'sells': w['sells'],
                  'early': early, 'entryMc': round(w['entryMc']) if w['entryMc'] else None, 'firstSlot': w['firstSlot'], 'sameSlotRT': rt,
                  'soldPctOfBought': round(min(9.99, w['baseS'] / w['baseB']), 2) if w['baseB'] else None}
    return out, {'first_ts': first_ts, 'n_trades': len(tr)}

# ---------------- kolscan ----------------
def kolscan():
    def f():
        import urllib.request
        req = urllib.request.Request('https://kolscan.io/leaderboard', headers={'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/124'})
        pc.COUNTS['kolscan.io'] = pc.COUNTS.get('kolscan.io', 0) + 1
        s = urllib.request.urlopen(req, timeout=30).read().decode().replace('\\"', '"')
        rows = re.findall(r'\{"wallet_address":"(\w+)","name":"([^"]*)","telegram":(?:null|"[^"]*"),"twitter":(null|"[^"]*"),"profit":([-\d.eE]+),"wins":(\d+),"losses":(\d+),"timeframe":(\d+)', s)
        out = {}
        for a, n, tw, p, wi, lo, tf in rows:
            o = out.setdefault(a, {'name': n, 'twitter': tw.strip('"') if tw != 'null' else None})
            o['tf' + tf] = {'profitSol': round(float(p), 2), 'wins': int(wi), 'losses': int(lo)}
        return out
    return cached('ct_kolscan', time.strftime('%Y%m%d%H'), f)

# ---------------- Nansen labels on disk (no calls) ----------------
NEG = re.compile(r'MEV|Bot|Deployer|Distributor|Proxy|Exchange|Binance|Coinbase|OKX|Bybit|Gate|MEXC|Bitget|Kraken', re.I)
POS = re.compile(r'Smart Trader|Smart Money|Millionaire|Top 100 on|Specialist|Whale|Fund', re.I)
def nansen_labels():
    out = {}
    try: d = json.load(open(os.path.join(DATA_DIR, 'nansen_crash_raw.json')))
    except Exception: return out
    def walk(o, tok, ch):
        if isinstance(o, dict):
            if 'address' in o and 'address_label' in o:
                lab = re.sub(r'\s*\[.*?\]\s*', '', o['address_label'] or '').replace('\u200b', '').strip()
                e = out.setdefault(o['address'], {'label': lab, 'chain': 'bsc' if ch == 'bnb' else ch, 'tokens': {}})
                b, s = o.get('bought_volume_usd') or 0, o.get('sold_volume_usd') or 0
                e['tokens'][tok] = {'boughtUsd': round(b), 'soldUsd': round(s)}
                return
            for v in o.values(): walk(v, tok, ch)
        elif isinstance(o, list):
            for v in o: walk(v, tok, ch)
    for sym, t in (d.get('tokens') or {}).items(): walk(t, sym, t.get('chain'))
    for a, e in out.items():
        e['neg'] = bool(NEG.search(e['label'])); e['pos'] = bool(POS.search(e['label'])) and not re.search(r'Former', e['label'])
    return out

# ---------------- RPC verification (swap parsing like lib/mev.js deltas/asSwap) ----------------
def keys_of(tx):
    m = tx['transaction']['message']; ks = list(m['accountKeys'])
    la = (tx.get('meta') or {}).get('loadedAddresses') or {}
    return ks + list(la.get('writable') or []) + list(la.get('readonly') or [])

def deltas(tx, owner):
    m = tx['meta']; out = defaultdict(lambda: [0, 0])
    for b in m.get('preTokenBalances') or []:
        if b.get('owner') == owner: out[b['mint']][0] -= int(b['uiTokenAmount']['amount']); out[b['mint']][1] = b['uiTokenAmount']['decimals']
    for b in m.get('postTokenBalances') or []:
        if b.get('owner') == owner: out[b['mint']][0] += int(b['uiTokenAmount']['amount']); out[b['mint']][1] = b['uiTokenAmount']['decimals']
    ks = keys_of(tx)
    if owner in ks:
        i = ks.index(owner); lam = m['postBalances'][i] - m['preBalances'][i]
        if i == 0: lam += m['fee']
        for j, k in enumerate(ks):
            if j != i and m['preBalances'][j] == 0 and 0 < m['postBalances'][j] <= 2100000 and any(b['accountIndex'] == j and b.get('owner') == owner for b in m.get('postTokenBalances') or []):
                lam += m['postBalances'][j]
        if lam: out[WSOL][0] += lam; out[WSOL][1] = 9
    return {k: v[0] / 10 ** v[1] for k, v in out.items() if v[0]}

def as_swap(dl):
    e = [(k, v) for k, v in dl.items() if not (k == WSOL and abs(v) < 1e-5)]
    neg = [x for x in e if x[1] < 0]; pos = [x for x in e if x[1] > 0]
    if len(neg) != 1 or len(pos) != 1: return None
    return {'inMint': neg[0][0], 'inUi': -neg[0][1], 'outMint': pos[0][0], 'outUi': pos[0][1]}

def get_tx(sig):
    return cached('ct_tx', sig, lambda: rpc('getTransaction', [sig, {'encoding': 'json', 'maxSupportedTransactionVersion': 0}]))

def verify(addr, sol_usd):
    def f():
        s = rpc('getSignaturesForAddress', [addr, {'limit': 200}]) or []
        if not s: return {'n_sigs': 0}
        span_h = max(1 / 60, ((s[0].get('blockTime') or 0) - (s[-1].get('blockTime') or 0)) / 3600)
        failed = sum(1 for x in s if x.get('err'))
        ok = [x for x in s if not x.get('err')][:VERIFY_TX]
        pos = defaultdict(lambda: {'bq': 0.0, 'bs': 0.0, 'sq': 0.0, 'ss': 0.0, 't0': None, 't1': None, 'n': 0})
        swaps = 0; samples = []
        for x in ok:
            try: tx = get_tx(x['signature'])
            except Exception as e: continue
            if not tx or not tx.get('meta'): continue
            sw = as_swap(deltas(tx, addr))
            if not sw: continue
            q = lambda m, v: v if m == WSOL else (v / sol_usd if m in STABLES else None)
            t = tx.get('blockTime') or 0
            if q(sw['inMint'], sw['inUi']) is not None and sw['outMint'] not in STABLES and sw['outMint'] != WSOL:   # buy
                p = pos[sw['outMint']]; p['bq'] += sw['outUi']; p['bs'] += q(sw['inMint'], sw['inUi']); p['n'] += 1; p['t0'] = min(p['t0'] or t, t); swaps += 1
                samples.append({'t': t, 'side': 'buy', 'mint': sw['outMint'], 'sol': round(q(sw['inMint'], sw['inUi']), 3)})
            elif q(sw['outMint'], sw['outUi']) is not None and sw['inMint'] not in STABLES and sw['inMint'] != WSOL:  # sell
                p = pos[sw['inMint']]; p['sq'] += sw['inUi']; p['ss'] += q(sw['outMint'], sw['outUi']); p['n'] += 1; p['t1'] = max(p['t1'] or t, t); swaps += 1
                samples.append({'t': t, 'side': 'sell', 'mint': sw['inMint'], 'sol': round(q(sw['outMint'], sw['outUi']), 3)})
        closed = []
        for m, p in pos.items():
            if p['bq'] > 0 and p['sq'] > 0:
                frac = min(1.0, p['sq'] / p['bq']); sold_part = min(p['sq'], p['bq']) / p['sq']
                pnl = p['ss'] * sold_part - p['bs'] * frac
                closed.append({'mint': m, 'pnlSol': round(pnl, 3), 'roi': round(pnl / (p['bs'] * frac), 3) if p['bs'] else None, 'holdMin': round((p['t1'] - p['t0']) / 60, 1) if p['t0'] and p['t1'] else None})
        holds = [c['holdMin'] for c in closed if c['holdMin'] is not None and c['holdMin'] >= 0]
        return {'n_sigs': len(s), 'span_h': round(span_h, 2), 'tx_per_day': round(len(s) / span_h * 24), 'failed_pct': round(failed / len(s), 3), 'parsed': len(ok), 'swaps': swaps,
                'closed': len(closed), 'wins': sum(1 for c in closed if c['pnlSol'] > 0), 'pnlSol': round(sum(c['pnlSol'] for c in closed), 3),
                'medHoldMin': round(statistics.median(holds), 1) if holds else None, 'closedList': sorted(closed, key=lambda c: -abs(c['pnlSol']))[:8],
                'lastTs': s[0].get('blockTime'), 'recent': samples[:6]}
    return cached('ct_verify', addr, f, max_age=12 * 3600)

def sol_price():
    try:
        j = http('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'); return float(j['solana']['usd'])
    except Exception: return 150.0

# ---------------- EVM (Base / BSC): GeckoTerminal 24h trade window ----------------
def gt_trades(net, pool):
    def f():
        j = http(f'https://api.geckoterminal.com/api/v2/networks/{net}/pools/{pool}/trades')
        return [x['attributes'] for x in (j or {}).get('data', [])]
    return cached('ct_gt_trades', f'{net}_{pool}', f, max_age=6 * 3600)

def evm_chain(con, chain, nl):
    net = {'base': 'base', 'bsc': 'bsc'}[chain]
    rows = con.execute("select symbol, mint, main_pool, peak_mcap, multiple, cur_mcap from tokens where chain=? and main_pool is not null and peak_mcap>=1e6 and (quality='ok' or quality is null) order by vol_total desc limit 18", (chain,)).fetchall()
    W = defaultdict(lambda: {'buyUsd': 0.0, 'sellUsd': 0.0, 'n': 0, 'tokens': {}, 'blocks': defaultdict(set)})
    used = []
    for sym, mint, pool, pk, mult, cur in rows:
        tr = gt_trades(net, pool)
        if not tr: continue
        used.append({'symbol': sym, 'address': mint, 'pool': pool, 'trades': len(tr)})
        for t in tr:
            a = (t.get('tx_from_address') or '').lower(); v = float(t.get('volume_in_usd') or 0)
            if not a: continue
            w = W[a]; w['n'] += 1; tk = w['tokens'].setdefault(sym, {'buyUsd': 0.0, 'sellUsd': 0.0})
            if t.get('kind') == 'buy': w['buyUsd'] += v; tk['buyUsd'] += v
            else: w['sellUsd'] += v; tk['sellUsd'] += v
            w['blocks'][(sym, t.get('block_number'))].add(t.get('kind'))
    out = []
    for a, w in W.items():
        rt = sum(1 for s in w['blocks'].values() if len(s) == 2)
        lab = nl.get(a) or {}
        bot = rt >= 2 or w['n'] >= 60 or lab.get('neg')
        toks = {k: {'buyUsd': round(v['buyUsd']), 'sellUsd': round(v['sellUsd']), 'pnlUsd': round(v['sellUsd'] - v['buyUsd'])} for k, v in w['tokens'].items()}
        wins = sum(1 for v in toks.values() if v['sellUsd'] > 0 and v['pnlUsd'] > 0); closed = sum(1 for v in toks.values() if v['sellUsd'] > 0 and v['buyUsd'] > 0)
        pnl = w['sellUsd'] - w['buyUsd']
        out.append({'address': a, 'chain': chain, 'pnlUsd24h': round(pnl), 'buyUsd': round(w['buyUsd']), 'sellUsd': round(w['sellUsd']), 'trades': w['n'], 'tokens': toks,
                    'wins': wins, 'closed': closed, 'sameBlockRT': rt, 'excluded': 'bot/MEV pattern' if bot else None, 'nansenLabel': lab.get('label'), 'confidence': 'low: 24h GeckoTerminal window, sells may be from older buys'})
    # Nansen on-disk labels for this chain (realized on crash tokens)
    for a, lab in nl.items():
        if lab['chain'] != chain or lab['neg']: continue
        b = sum(t['boughtUsd'] for t in lab['tokens'].values()); s = sum(t['soldUsd'] for t in lab['tokens'].values())
        ex = next((o for o in out if o['address'] == a.lower()), None)
        if ex: ex['nansenPnlUsd'] = s - b; continue
        out.append({'address': a.lower(), 'chain': chain, 'pnlUsd24h': None, 'nansenPnlUsd': s - b, 'nansenLabel': lab['label'], 'tokens': lab['tokens'], 'trades': None, 'excluded': None, 'confidence': 'low: Nansen label + net flow on catalog crash tokens (on-disk, no new calls)'})
    def sc(o):
        p = (o.get('pnlUsd24h') or 0) + 0.5 * (o.get('nansenPnlUsd') or 0)
        return p * (1.3 if o.get('nansenLabel') and POS.search(o['nansenLabel'] or '') else 1)
    NS = nansen_enrich()
    for row in NS['sm'].get('bnb' if chain == 'bsc' else chain, []):
        a = row['address'].lower(); lab = row.get('address_label') or ''
        ex = next((o for o in out if o['address'] == a), None)
        rec = ex or {'address': a, 'chain': chain, 'pnlUsd24h': None, 'tokens': {t.get('token_symbol', '?'): t for t in (row.get('top_traded_tokens_info') or [])[:4]} if isinstance(row.get('top_traded_tokens_info'), list) else {}, 'trades': row.get('n_trades'), 'excluded': None}
        rec.update({'smRealizedUsd30d': round(row.get('realized_pnl_usd') or 0), 'smWinRate': row.get('win_rate'), 'smTrades': row.get('n_trades'), 'smTokens': row.get('n_tokens'), 'nansenLabel': lab,
                    'confidence': 'medium: Nansen Smart Money 30d realized P&L leaderboard'})
        if NEG.search(lab): rec['excluded'] = 'nansen label ' + lab
        if not ex: out.append(rec)
    def sc(o):
        p = (o.get('pnlUsd24h') or 0) + 0.5 * (o.get('nansenPnlUsd') or 0) + (o.get('smRealizedUsd30d') or 0) * (0.5 + (o.get('smWinRate') or 0.5))
        return p * (1.3 if o.get('nansenLabel') and POS.search(o['nansenLabel'] or '') else 1)
    keep = sorted([o for o in out if not o['excluded'] and sc(o) > 0], key=sc, reverse=True)[:50]
    for i, o in enumerate(keep): o['rank'] = i + 1; o['score'] = round(sc(o))
    return {'wallets': keep, 'runnersUsed': used, 'excludedBots': sum(1 for o in out if o['excluded']), 'candidates': len(out)}

def nansen_enrich():
    """Read-only: data/copytrade_nansen.json written by `node lib/copytrade.js nansen` (this script never calls Nansen)."""
    out = {'sm': {}, 'pnl': {}, 'tgm': {}, 'credits': None}
    try: d = json.load(open(os.path.join(DATA_DIR, 'copytrade_nansen.json')))
    except Exception: return out
    for k, rows in (d.get('smLeaderboard') or {}).items(): out['sm'].setdefault(k.split(':')[0], []).extend(rows or [])
    out['pnl'] = d.get('pnlSummary') or {}; out['tgm'] = d.get('tgmLeaderboard') or {}
    out['credits'] = {'total': d.get('totalCredits'), 'lastRun': d.get('lastRunCredits'), 'before': (d.get('accountBefore') or {}).get('remaining'), 'after': (d.get('accountAfter') or {}).get('remaining'),
                      'calls': [c for c in d.get('calls', []) if c.get('used') or c.get('skipped') or c.get('error')][-60:]}
    return out

# ---------------- main ----------------
def main():
    con = sqlite3.connect(DB)
    since = (time.time() - 150 * 86400) * 1000
    rows = con.execute("""select symbol, mint, created_ts, peak_ts, peak_mcap, multiple, cur_mcap, vol_total from tokens where chain='solana' and quality='ok'
        and mint like '%pump' and peak_mcap>=2e6 and multiple>=30 and vol_total>=3e6 and created_ts>=? order by peak_mcap desc limit ?""", (since, N_RUNNERS)).fetchall()
    runners = [dict(zip(['symbol', 'mint', 'created_ts', 'peak_ts', 'peak_mcap', 'multiple', 'cur_mcap', 'vol_total'], r)) for r in rows]
    log('runners', len(runners))
    agg = defaultdict(lambda: {'runners': {}, 'pnl': 0.0})
    rsum = []
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(4) as ex: tapes = list(ex.map(lambda r: (r, runner_tape(r)), runners))
    for i, (r, tape) in enumerate(tapes):
        if not tape or not tape['trades']: log('no tape', r['symbol']); continue
        ws, meta = runner_wallets(r, tape)
        early = [(a, w) for a, w in ws.items() if w['early']]
        good = sorted([(a, w) for a, w in ws.items() if w['pnlSol'] > 0 and w['matched']], key=lambda x: -x[1]['pnlSol'])
        rsum.append({'symbol': r['symbol'], 'mint': r['mint'], 'peakMcap': round(r['peak_mcap']), 'multiple': round(r['multiple']), 'tradesSeen': meta['n_trades'],
                     'earlyComplete': tape['early_complete'], 'earlyBuyers': len(early), 'earlyProfitable': sum(1 for a, w in early if w['pnlSol'] > 0),
                     'top': [{'wallet': a, **w} for a, w in good[:8]]})
        for a, w in ws.items():
            if w['early'] or w['pnlSol'] >= 3:
                agg[a]['runners'][r['symbol'] + ':' + r['mint'][:6]] = w
        log(f"[{i+1}/{len(runners)}] {r['symbol']} trades={meta['n_trades']} early={len(early)} profitable={len(good)} t={int(time.time()-T0)}s")
    json.dump({'generatedAt': int(time.time() * 1000), 'runners': rsum}, open(os.path.join(DATA_DIR, 'copytrade_runners.json'), 'w'))

    # candidate scoring from runner tapes
    K = kolscan(); NL = nansen_labels(); NS = nansen_enrich()
    log('kolscan wallets', len(K), 'nansen labelled', len(NL))
    cands = {}
    for a, g in agg.items():
        rs = g['runners']
        clean = {k: w for k, w in rs.items() if not w['firstSlot'] and w['sameSlotRT'] < 2 and w['buys'] + w['sells'] < 150}
        insider = [k for k, w in rs.items() if w['firstSlot']]
        pnl = sum(w['pnlSol'] for w in clean.values() if w.get('matched'))
        wins = sum(1 for w in clean.values() if w.get('matched') and w['pnlSol'] > 0); closed = sum(1 for w in clean.values() if w.get('matched'))
        nearly = sum(1 for w in clean.values() if w['early'])
        if (pnl >= 5 and wins >= 1) or (nearly >= 2 and pnl > 0):
            cands[a] = {'address': a, 'runnerPnlSol': round(pnl, 2), 'runnerWins': wins, 'runnerClosed': closed, 'runnerEarly': nearly, 'runners': clean, 'insiderOn': insider, 'src': ['runners']}
    for a, k in K.items():
        c = cands.setdefault(a, {'address': a, 'runnerPnlSol': 0, 'runnerWins': 0, 'runnerClosed': 0, 'runnerEarly': 0, 'runners': {}, 'insiderOn': [], 'src': []})
        c['kolscan'] = k; c['src'].append('kolscan')
    for a, l in NL.items():
        if l['chain'] == 'solana' and a in cands: cands[a]['nansenLabel'] = l['label']; cands[a]['nansenNeg'] = l['neg']
        elif l['chain'] == 'solana' and l['pos']:
            cands[a] = {'address': a, 'runnerPnlSol': 0, 'runnerWins': 0, 'runnerClosed': 0, 'runnerEarly': 0, 'runners': {}, 'insiderOn': [], 'src': ['nansen-label'], 'nansenLabel': l['label'], 'nansenNeg': False}
    # Nansen smart-money P&L leaderboard (Solana, 30d) + token P&L leaderboards of truncated runners (cached by lib/copytrade.js nansen)
    for row in NS['sm'].get('solana', []):
        a = row['address']; lab = row.get('address_label') or ''
        c = cands.setdefault(a, {'address': a, 'runnerPnlSol': 0, 'runnerWins': 0, 'runnerClosed': 0, 'runnerEarly': 0, 'runners': {}, 'insiderOn': [], 'src': []})
        c['src'].append('nansen-sm'); c['nansenSm'] = {k: row.get(k) for k in ('realized_pnl_usd', 'win_rate', 'n_trades', 'n_tokens', 'avg_trade_roi')}
        c['nansenLabel'] = c.get('nansenLabel') or lab; c['nansenNeg'] = bool(NEG.search(lab))
    for mint, t in NS['tgm'].items():
        for row in t['rows'][:40]:
            if (row.get('r') or 0) <= 0: continue
            c = cands.setdefault(row['a'], {'address': row['a'], 'runnerPnlSol': 0, 'runnerWins': 0, 'runnerClosed': 0, 'runnerEarly': 0, 'runners': {}, 'insiderOn': [], 'src': []})
            if 'nansen-tgm' not in c['src']: c['src'].append('nansen-tgm')
            c.setdefault('nansenRunners', {})[t['symbol']] = {'realizedUsd': round(row['r']), 'roi': row.get('roi'), 'trades': row.get('n'), 'label': row.get('l')}
            if row.get('l') and NEG.search(row['l']): c['nansenNeg'] = True; c['nansenLabel'] = row['l']
    log('candidates', len(cands))

    def pre(c):
        k = c.get('kolscan') or {}
        kp = max([(k.get('tf' + t) or {}).get('profitSol', 0) for t in ('30', '7', '1')] or [0])
        ns = (c.get('nansenSm') or {}).get('realized_pnl_usd') or 0
        nr = sum(v['realizedUsd'] for v in (c.get('nansenRunners') or {}).values())
        return c['runnerPnlSol'] + 0.5 * kp + 20 * c['runnerEarly'] + (30 if c.get('nansenLabel') and not c.get('nansenNeg') else 0) + (ns + nr) / 150 * 0.5
    sol_usd = sol_price()
    def pre_free(c):
        k = c.get('kolscan') or {}
        kp = max([(k.get('tf' + t) or {}).get('profitSol', 0) for t in ('30', '7', '1')] or [0])
        return c['runnerPnlSol'] + 0.5 * kp + 20 * c['runnerEarly']
    # quotas so free-source wallets (runner tapes, kolscan) are always scored next to Nansen smart-money wallets
    free_q = int(N_VERIFY * 0.45)
    short = sorted([c for c in cands.values() if set(c['src']) & {'runners', 'kolscan'}], key=pre_free, reverse=True)[:free_q]
    seen = {c['address'] for c in short}
    short += [c for c in sorted(cands.values(), key=pre, reverse=True) if c['address'] not in seen][:N_VERIFY - len(short)]
    log('verifying', len(short), 'wallets on public RPC, SOL $', sol_usd)
    for i, c in enumerate(short):
        try: c['rpc'] = verify(c['address'], sol_usd)
        except Exception as e: c['rpc'] = {'error': str(e)[:120]}
        if i % 10 == 9: log(f'  verified {i+1}/{len(short)} t={int(time.time()-T0)}s')

    out = []
    for c in short:
        v = c.get('rpc') or {}; k = c.get('kolscan') or {}
        flags = []
        if c.get('nansenNeg'): flags.append('nansen: ' + c['nansenLabel'])
        swap_share = (v.get('swaps') or 0) / max(1, v.get('parsed') or 0)
        if v.get('tx_per_day', 0) > 2500 and swap_share >= 0.5: flags.append(f"bot-rate {v['tx_per_day']} swaps/day ({round(swap_share*100)}% of txs are swaps)")
        elif v.get('tx_per_day', 0) > 2500: c['spamNote'] = f"{v['tx_per_day']} sigs/day but only {round(swap_share*100)}% swaps: incoming spam/dust, not a bot"

        if v.get('medHoldMin') is not None and v['medHoldMin'] < 0.5 and v.get('closed', 0) >= 4: flags.append('sub-30s median hold (MEV/bot)')
        if c['insiderOn'] and c['runnerPnlSol'] <= 0 and not k: flags.append('first-slot buyer only (bundle/dev)')
        if v.get('n_sigs') == 0: flags.append('no recent activity')
        kw = sum((k.get('tf' + t) or {}).get('wins', 0) for t in ('30',)); kl = sum((k.get('tf' + t) or {}).get('losses', 0) for t in ('30',))
        if kw + kl > 40: kw, kl = 40 * kw / (kw + kl), 40 * kl / (kw + kl)   # cap kolscan's weight like the Nansen counts
        ps = NS['pnl'].get(c['address']) or {}; sm = c.get('nansenSm') or {}
        if not ps.get('traded_times'): ps = {}
        nw, nn = 0.0, 0
        if ps.get('win_rate') is not None and ps.get('traded_token_count'): nn = min(40, ps['traded_token_count']); nw = ps['win_rate'] * nn
        elif sm.get('win_rate') is not None and sm.get('n_tokens'): nn = min(40, sm['n_tokens']); nw = sm['win_rate'] * nn
        nr_closed = len(c.get('nansenRunners') or {}); nr_wins = sum(1 for x in (c.get('nansenRunners') or {}).values() if x['realizedUsd'] > 0)
        wins = c['runnerWins'] + v.get('wins', 0) + kw + nw + nr_wins; n = c['runnerClosed'] + v.get('closed', 0) + kw + kl + nn + nr_closed
        winrate = (wins + 1) / (n + 2)
        kp30 = (k.get('tf30') or {}).get('profitSol'); kp7 = (k.get('tf7') or {}).get('profitSol'); kp1 = (k.get('tf1') or {}).get('profitSol')
        nsol = (ps.get('realized_pnl_usd') if ps.get('realized_pnl_usd') is not None else sm.get('realized_pnl_usd'))
        nsol = nsol / sol_usd if nsol is not None else None
        runner_extra = sum(x['realizedUsd'] for x in (c.get('nansenRunners') or {}).values()) / sol_usd
        pnl = max(c['runnerPnlSol'], runner_extra) + max(0, v.get('pnlSol', 0)) * 0.5 + (nsol if nsol is not None else (kp30 if kp30 is not None else (kp7 or 0)))
        per_tok = [w['pnlSol'] for w in c['runners'].values() if w.get('matched')] + [x['pnlSol'] for x in v.get('closedList', [])]
        pos_sum = sum(p for p in per_tok if p > 0)
        top_share = max(per_tok) / pos_sum if pos_sum > 0 and per_tok else 1.0
        tf_vals = [kp1, kp7, kp30, (ps.get('realized_pnl_usd') if ps else None), sm.get('realized_pnl_usd')]
        tf_pos = sum(1 for p in tf_vals if p is not None and p > 0); tf_n = sum(1 for p in tf_vals if p is not None)
        if ps.get('realized_pnl_usd') is not None and ps['realized_pnl_usd'] < 0: flags.append(f"Nansen 90d realized P&L negative (${round(ps['realized_pnl_usd']):,})")
        consistency = 0.6 * (1 - top_share if len(per_tok) >= 2 else 0) + 0.4 * (tf_pos / tf_n if tf_n else (1 if c['runnerWins'] >= 2 else 0.3))
        score = 35 * min(1, math.log10(1 + max(0, pnl)) / math.log10(1 + 1000)) + 25 * winrate + 10 * min(1, n / 20) + 20 * consistency + 10 * min(1, c['runnerEarly'] / 3)
        out.append({'address': c['address'], 'chain': 'solana', 'score': round(score, 1), 'excluded': '; '.join(flags) or None, 'name': k.get('name'), 'twitter': k.get('twitter'),
                    'nansenLabel': c.get('nansenLabel'), 'sources': c['src'], 'realizedSol': round(pnl, 1), 'runnerPnlSol': c['runnerPnlSol'], 'winRate': round(winrate, 3), 'wins': wins, 'closedTrades': n,
                    'consistency': round(consistency, 2), 'note': c.get('spamNote'), 'topTokenShare': round(top_share, 2), 'earlyRunners': c['runnerEarly'], 'insiderOn': c['insiderOn'][:5],
                    'kolscan': {t: k.get('tf' + t) for t in ('1', '7', '30') if k.get('tf' + t)}, 'nansen': {'pnlSummary90d': {kk: ps.get(kk) for kk in ('realized_pnl_usd', 'realized_pnl_percent', 'win_rate', 'traded_times', 'traded_token_count')} if ps else None, 'smLeaderboard30d': sm or None, 'runners': c.get('nansenRunners')}, 'rpc': {kk: v.get(kk) for kk in ('tx_per_day', 'failed_pct', 'parsed', 'swaps', 'closed', 'wins', 'pnlSol', 'medHoldMin', 'lastTs', 'span_h', 'error')},
                    'rpcClosed': v.get('closedList', [])[:5], 'runners': [{'runner': kk.split(':')[0], **{x: w[x] for x in ('buySol', 'sellSol', 'pnlSol', 'entryMc', 'early', 'soldPctOfBought')}} for kk, w in sorted(c['runners'].items(), key=lambda kv: -kv[1]['pnlSol'])[:6]]})
    keep = sorted([o for o in out if not o['excluded']], key=lambda o: -o['score'])[:50]
    for i, o in enumerate(keep): o['rank'] = i + 1
    excl = [o for o in out if o['excluded']]
    log('solana top', len(keep), 'excluded', len(excl))
    evm = {}
    for ch in ('base', 'bsc'):
        try: evm[ch] = evm_chain(con, ch, NL); log(ch, len(evm[ch]['wallets']))
        except Exception as e: evm[ch] = {'error': str(e)}; log(ch, 'err', e)
    res = {'chains': {'solana': {'wallets': keep, 'excluded': [{'address': o['address'], 'why': o['excluded'], 'score': o['score'], 'name': o['name']} for o in excl], 'candidates': len(cands), 'verified': len(short)}, **evm},
           'runners': [{k: v for k, v in r.items() if k != 'top'} for r in rsum], 'solUsd': sol_usd,
           'method': {'sources': ['pump.fun public trade API (swap-api.pump.fun/v2/coins/<mint>/trades): early tape (all sizes, first hours) + large-trade tape (>=%s SOL) per runner' % BIG_SOL,
                                  'kolscan.io/leaderboard public JSON (realized SOL profit, wins/losses, 1d/7d/30d)', 'Nansen labels already in data/nansen_crash_raw.json (no new Nansen calls)',
                                  'public Solana RPC: getSignaturesForAddress(200) + getTransaction(%d) per shortlisted wallet' % VERIFY_TX, 'GeckoTerminal /pools/<pool>/trades (last 24h, <=300) for Base/BSC'],
                      'score': '35 realized P&L (log, SOL) + 25 win rate (Bayesian (w+1)/(n+2) over runner positions + RPC closed positions + kolscan 30d) + 10 number of closed trades + 20 consistency (1 - best-token share of profits; positive across kolscan 1d/7d/30d) + 10 early on multiple runners',
                      'exclusions': 'first-slot buyers (bundle/dev = insider of own token) lose that runner; >=2 same-slot buy+sell round trips or >=150 trades on one runner = bot; >2500 tx/day; median hold <30s; Nansen labels MEV/Trading Bot/Deployer/Distributor/CEX'},
           'limits': ['Runner P&L only counts trades the tape captured: all early trades + trades >= %s SOL later, so small later sells are missed (P&L is a lower bound for scalers-out).' % BIG_SOL,
                      'RPC window = last %d successful txs per wallet (hours to days); positions bought before the window are not scored.' % VERIFY_TX,
                      'kolscan covers ~90 KOL wallets only and its own P&L method; used as one input, not ground truth.',
                      'GMGN (Cloudflare 403), Birdeye (API key required, 401) and Cielo (login) were NOT used: not fetchable without login.',
                      'Base/BSC: no free per-wallet swap history without an API key (BscScan/Basescan need keys); GeckoTerminal only exposes the last 24h/300 trades per pool, so EVM lists are low-confidence.'],
           'nansen': NS['credits'], 'nansenPlan': nansen_plan(), 'elapsedS': int(time.time() - T0)}
    pc.save('copytrade.json', res)

def nansen_plan():
    # credit prices from docs.nansen.ai/getting-started/credits (Pro plan, checked 2026-10-11)
    return {'status': 'Nansen approved 2026-10-11: steps 1, 2 (top 60) and 3 (6 truncated runners) run via node lib/copytrade.js nansen with a 300-credit floor; see the nansen block for credits actually used',
            'steps': [{'what': 'Smart-money realized-P&L leaderboard per chain (solana, base, bnb), 2 pages each', 'endpoint': 'POST /api/v1/smart-money/pnl-leaderboard', 'creditsPerCall': 5, 'calls': 6, 'credits': 30},
                      {'what': 'Per-runner trader P&L leaderboard (who realized most on each catalog runner): 30 Solana + 15 Base + 15 BSC', 'endpoint': 'POST /api/v1/tgm/pnl-leaderboard (premium_labels=false; true costs 150/call)', 'creditsPerCall': 5, 'calls': 60, 'credits': 300},
                      {'what': 'Runners older than the live lookback (if needed, ~10)', 'endpoint': 'POST /api/v1/tgm/historical-pnl-leaderboard', 'creditsPerCall': 25, 'calls': 10, 'credits': 250, 'optional': True},
                      {'what': 'Consistency check of the best 150 merged wallets (realized P&L, win rate, tokens traded)', 'endpoint': 'POST /api/v1/profiler/address/pnl-summary', 'creditsPerCall': 1, 'calls': 150, 'credits': 150}],
            'oneOff': '~480 credits (730 with the optional historical step)', 'weekly': '~65 credits (3 smart-money leaderboards = 15 + pnl-summary for the top 50 = 50)',
            'budgetNote': 'Account shows ~2,031 credits left (plan pro) and the terminal caps Nansen at 60/day, 1,800/month (lib/nansen.js). The one-off pass would need a temporary cap raise or ~8 days of the daily cap.'}

if __name__ == '__main__':
    main()
