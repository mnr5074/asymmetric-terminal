"""(8) Dark-pool / OTC flow detection -> data/riskinfra_otcflow.json (rolling event log, incremental by block).
Ethereum (public RPC eth_getLogs, ERC-20 Transfer):
  A. every Transfer of tracked tokens (Aave-v3 Ethereum reserves + Morpho collateral + watchlist ERC-20s) in the blocks since the last run
     (first run: last ~600 blocks = 2h), kept when USD value >= threshold (alts $250K, ETH/BTC wrappers $1M, stables $5M);
  B. every Transfer (ANY token) to/from known OTC desks / market makers over the last ~12h (topic-filtered), >= $100K.
  Classification: CEX labels (data/patterns_labels.json, 33K Ethereum CEX addresses), market-maker/OTC labels (data/vc_wallets.json when present,
  brianleect/etherscan-labels name tags, small curated set), contract vs wallet via eth_getCode (Safe proxies + EIP-7702 delegations = wallet).
  Kinds: otc_desk (either side MM/OTC), cex_to_cex (two different exchanges), wallet_to_wallet (no DEX/CEX/contract on either side),
  cex_withdrawal_to_wallet / wallet_to_cex (large, informational). Round amounts (token qty with <=2 significant digits, or USD within
  0.5% of a $100K multiple) are marked. Follow-up: Binance 1m klines from the transfer block time -> return after 30/60 min; moves beyond
  1.5% (alts) / 0.75% (majors) are marked `followed_by_move`. Pending outcomes are filled on later runs.
Solana: last signatures of public CEX hot wallets (labels + curated Solscan tags) parsed for large token/SOL moves (CEX->CEX, CEX->wallet).
No paid APIs, no Nansen."""
import time, json, re, math, os
from common import fetch, eth_batch, eth_call1, sol_rpc, readj, writej, Ctx, median, pmap
from lending import get_lending

ctx = Ctx('otcflow'); T0 = time.time(); NOWMS = int(T0 * 1000)
TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
U = lambda s: (s or '').upper()
STABLES = {'USDC', 'USDT', 'DAI', 'USDS', 'USDE', 'PYUSD', 'FDUSD', 'RLUSD', 'GHO', 'FRAX', 'LUSD', 'USD1', 'TUSD', 'CRVUSD', 'USDTB', 'USDG'}
MAJ = {'WETH', 'WBTC', 'CBBTC', 'TBTC', 'WSTETH', 'WEETH', 'RETH', 'CBETH', 'LBTC', 'STETH', 'OSETH', 'RSETH', 'EZETH', 'ETHX'}
WATCH_ERC20 = {'LINK': '0x514910771AF9Ca656af840dff83E8264EcF986CA', 'UNI': '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', 'AAVE': '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
               'LDO': '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', 'ONDO': '0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3', 'ENA': '0x57e114B691Db790C35207b2e685D4A43181e6061',
               'PEPE': '0x6982508145454Ce325dDbE47a25d4ec3d2311933', 'SHIB': '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', 'PENDLE': '0x808507121B80c02388fAd14726482e061B8da827',
               'SKY': '0x56072C95FAA701256059aa122697B133aDEd9279', 'ARB': '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', 'WLD': '0x163f8C2467924be0ae7B5347228CABF260318753',
               'FET': '0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85', 'RENDER': '0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24', 'POL': '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6'}
CURATED_MM = {  # (address, entity, source) - public explorer tags; 'memory' = widely published, not re-verified here
    '0x0000006daea1723962647b7e189d311d757fb793': ('Wintermute', 'gmarkets.io registry / Wintermute 2022 post-mortem'),
    '0x0e5069514a3dd613350bab01b58fd850058e5ca4': ('Wintermute', 'dawsbot/eth-labels exchange list'),
    '0x4f3a120e72c76c22ae802d129f599bfdbc31cb81': ('Wintermute (multisig)', 'memory: widely published Etherscan tag'),
    '0xb89dbf30dd4dfa6bd0cdc7c0aa54a0acaffe1b1f': ('Cumberland DRW', 'gmarkets.io registry (Etherscan public label)'),
    '0xf584f8728b874a6a5c7a8d4d387c9aae9172d621': ('Jump Trading', 'Etherscan label (brianleect) / gmarkets.io'),
    '0x15abb66ba754f05cbc0165a64a11cded1543de48': ('GSR', 'memory: widely published Etherscan tag'),
}
SOL_CEX_CURATED = {'5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'Binance', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'Binance', '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'Coinbase',
                   'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS': 'Coinbase', 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE': 'Coinbase', '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD': 'OKX',
                   'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2': 'Bybit', 'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5': 'Kraken'}

# ---------------- labels ----------------
pl = readj('patterns_labels.json', {}) or {}
CEX = {k.lower(): v for k, v in ((pl.get('cex') or {}).get('ethereum') or {}).items()}
BRIDGE = {k.lower(): v for k, v in ((pl.get('bridge_labels') or {}).get('ethereum') or {}).items()} if isinstance((pl.get('bridge_labels') or {}).get('ethereum'), dict) else {}
SOLCEX = dict(((pl.get('cex') or {}).get('solana') or {})); SOLCEX.update(SOL_CEX_CURATED)
MM = {a: {'entity': e, 'source': s} for a, (e, s) in CURATED_MM.items()}
NAMES = {}
lab_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'etherscan_labels_cache.json')
def etherscan_labels():
    if os.path.exists(lab_path) and time.time() - os.path.getmtime(lab_path) < 7 * 86400: return json.load(open(lab_path))
    d = fetch('https://raw.githubusercontent.com/brianleect/etherscan-labels/main/data/etherscan/combined/combinedAllLabels.json', ctx=ctx, timeout=60)
    slim = {a.lower(): {'name': v.get('name'), 'labels': v.get('labels')} for a, v in d.items()}
    json.dump(slim, open(lab_path, 'w')); return slim
for a, v in (ctx.tryf('etherscan labels', etherscan_labels, {}) or {}).items():
    NAMES[a] = v.get('name') or ''
    if re.search(r'wintermute|cumberland|\bgsr\b|falconx|b2c2|galaxy digital|flowdesk|jump trading|amber group|auros|genesis trading|qcp capital|keyrock|dwf', NAMES[a], re.I) or 'otc' in (v.get('labels') or []):
        MM.setdefault(a, {'entity': NAMES[a], 'source': 'brianleect/etherscan-labels'})
vc = readj('vc_wallets.json', {}) or {}
vc_n = 0
for w in vc.get('wallets') or []:
    if w.get('entity_type') in ('market_maker', 'otc_desk', 'fund_trading') and w.get('confidence') in ('high', 'medium'):
        if str(w.get('chain')) in ('ethereum', '1', 'evm'): MM.setdefault(w['address'].lower(), {'entity': w['entity'], 'source': 'vc_wallets.json: ' + str(w.get('source', ''))[:60]}); vc_n += 1
        elif w.get('chain') == 'solana': SOLCEX.setdefault(w['address'], None); MM.setdefault(w['address'], {'entity': w['entity'], 'source': 'vc_wallets.json'}); vc_n += 1
DEXRX = re.compile(r'uniswap|sushi|curve|balancer|1inch|0x: exchange|0x protocol|cow protocol|gpv2|pancake|router|aggregator|paraswap|kyber|maverick|fluid|bebop|odos|okx dex|pool|pair|vault', re.I)
def cex_name(a):
    n = CEX.get(a)
    return re.sub(r'\s*\(.*\)|\s+\d+$|:.*$', '', n).strip() if n else None

# ---------------- tracked tokens + prices ----------------
lend = get_lending(ctx)
tok = {}
for r in lend.get('reserves', []):
    if r['protocol'] == 'aave-v3' and r['chainId'] == 1 and r.get('address'): tok.setdefault(r['address'].lower(), {'sym': U(r['symbol']), 'px': r.get('oraclePrice')})
    if r['protocol'] == 'morpho-blue' and r['chainId'] == 1 and r.get('collateralAddress'): tok.setdefault(r['collateralAddress'].lower(), {'sym': U(r['collateralSymbol']), 'px': None})
for s, a in WATCH_ERC20.items(): tok.setdefault(a.lower(), {'sym': s, 'px': None})
orc = readj('riskinfra_oracles.json', {}) or {}
refpx = {r['sym']: r['ref'] for r in orc.get('assets', []) if r.get('ref')}
need = [a for a, t in tok.items() if not t['px']]
for a in need:
    t = tok[a]; t['px'] = refpx.get(t['sym'])
miss = [a for a, t in tok.items() if not t['px']]
for i in range(0, len(miss), 30):
    pairs = ctx.tryf('ds prices', lambda: fetch('https://api.dexscreener.com/tokens/v1/ethereum/' + ','.join(miss[i:i + 30]), ctx=ctx), []) or []
    best = {}
    for p in pairs:
        ad = p['baseToken']['address'].lower(); l = (p.get('liquidity') or {}).get('usd', 0) or 0
        if p.get('priceUsd') and l > best.get(ad, (0, 0))[0]: best[ad] = (l, float(p['priceUsd']))
    for ad, (l, px) in best.items():
        if ad in tok and l > 100000: tok[ad]['px'] = px
tok = {a: t for a, t in tok.items() if t['px']}
addrs = list(tok)
dec = eth_batch([('eth_call', [{'to': a, 'data': '0x313ce567'}, 'latest']) for a in addrs], ctx=ctx)
for a, h in zip(addrs, dec): tok[a]['dec'] = int(h, 16) if h and h != '0x' else 18
def min_usd(sym): return 5e6 if sym in STABLES else 1e6 if sym in MAJ else 2.5e5

# ---------------- Ethereum scans ----------------
state = readj('riskinfra_otcflow.json', {}) or {}
head = int(eth_call1('eth_blockNumber', [], ctx=ctx), 16)
start = max(head - 1200, (state.get('lastBlock') or head - 600) + 1)
def get_logs(flt, frm, to, step):
    out = []; b = frm
    while b <= to:
        e = min(to, b + step - 1)
        try:
            r = eth_call1('eth_getLogs', [dict(flt, fromBlock=hex(b), toBlock=hex(e))], ctx=ctx); out += r or []; b = e + 1
        except Exception as ex:
            if step > 3: step = max(3, step // 3); continue
            ctx.err(f'getLogs {b}-{e}', ex); b = e + 1
        else:
            pass
    return out
big_stable = [a for a in addrs if tok[a]['sym'] in STABLES | {'WETH'}]
alts = [a for a in addrs if a not in big_stable]
logsA = []
for grp, step in ((alts, 200), (big_stable, 60)):
    for i in range(0, len(grp), 25):
        logsA += get_logs({'address': grp[i:i + 25], 'topics': [TRANSFER]}, start, head, step)
pad = lambda a: '0x' + '0' * 24 + a[2:]
mm_list = [a for a in MM if a.startswith('0x')][:200]
mm_from = max(head - 600, min(start, head - 300))  # drpc serves topic-only filters for <=100-block ranges -> ~2h window per run (rolling log keeps history)
logsB = []
if mm_list:
    # topic-only filters: publicnode refuses them (needs an address), eth.drpc.org serves them for <=~60 topics -> groups of 40
    for i in range(0, len(mm_list), 40):
        grp = [pad(a) for a in mm_list[i:i + 40]]
        logsB += get_logs({'topics': [TRANSFER, grp]}, mm_from, head, 100)
        logsB += get_logs({'topics': [TRANSFER, None, grp]}, mm_from, head, 100)
def decode(l):
    if len(l.get('topics') or []) != 3 or l['data'] in ('0x', ''): return None
    a = l['address'].lower(); frm = '0x' + l['topics'][1][-40:]; to = '0x' + l['topics'][2][-40:]
    try: raw = int(l['data'][:66], 16)
    except Exception: return None
    return {'token': a, 'from': frm, 'to': to, 'raw': raw, 'block': int(l['blockNumber'], 16), 'tx': l['transactionHash'], 'logIndex': int(l['logIndex'], 16)}
cands = {}
for l in logsA:
    d = decode(l)
    if not d or d['token'] not in tok: continue
    t = tok[d['token']]; amt = d['raw'] / 10 ** t['dec']; usd = amt * t['px']
    if usd >= min_usd(t['sym']): cands[(d['tx'], d['logIndex'])] = dict(d, sym=t['sym'], amount=amt, usd=usd, scan='tracked')
unknown_tok = set()
for l in logsB:
    d = decode(l)
    if not d: continue
    t = tok.get(d['token'])
    if not t: unknown_tok.add(d['token']); continue
    amt = d['raw'] / 10 ** t['dec']; usd = amt * t['px']
    if usd >= 1e5: cands.setdefault((d['tx'], d['logIndex']), dict(d, sym=t['sym'], amount=amt, usd=usd, scan='mm'))
# classify
ZERO = '0x0000000000000000000000000000000000000000'
addrset = sorted({c[k] for c in cands.values() for k in ('from', 'to')} - {ZERO})
need_code = [a for a in addrset if a not in CEX and a not in MM]
codes = dict(zip(need_code, eth_batch([('eth_getCode', [a, 'latest']) for a in need_code], ctx=ctx, chunk=50)))
def kind_of(a):
    if a == ZERO: return ('mint/burn', None)
    if a in MM: return ('mm', MM[a]['entity'])
    if a in CEX: return ('cex', cex_name(a))
    nm = NAMES.get(a, '')
    if a in BRIDGE or re.search(r'bridge|wormhole|portal|layerzero|stargate|across', nm, re.I): return ('bridge', BRIDGE.get(a) or nm)
    c = codes.get(a)
    if c is None: return ('unknown', nm or None)
    if c in ('0x', '') or c.startswith('0xef0100'): return ('wallet', nm or None)
    if len(c) < 500 and 'a619486e' in c: return ('wallet', (nm or '') + ' Safe multisig')
    if nm and DEXRX.search(nm): return ('dex', nm)
    return ('contract', nm or None)
def roundness(amt, usd):
    r = []
    if amt >= 1000:
        mag = 10 ** (int(math.log10(amt)) - 1)
        if abs(amt / mag - round(amt / mag)) < 1e-6: r.append(f'round qty {amt:,.0f}')
    if usd >= 1e5 and abs(usd / 1e5 - round(usd / 1e5)) * 1e5 <= usd * 0.005 * 0 + 0.005 * usd and abs(usd - round(usd / 1e5) * 1e5) / usd < 0.005: r.append(f'~${round(usd/1e5)*1e5:,.0f}')
    return r
events = []
for (tx, li), c in cands.items():
    fk, fn = kind_of(c['from']); tk, tn = kind_of(c['to'])
    c.update(fromKind=fk, fromName=fn, toKind=tk, toName=tn)
    kinds = []
    if fk == 'mm' or tk == 'mm': kinds.append('otc_desk')
    if fk == 'cex' and tk == 'cex' and fn and tn and fn.split(' ')[0].lower() != tn.split(' ')[0].lower(): kinds.append('cex_to_cex')
    if fk in ('wallet', 'mm') and tk in ('wallet', 'mm') and 'otc_desk' not in kinds: kinds.append('wallet_to_wallet')
    if fk == 'cex' and tk == 'wallet': kinds.append('cex_withdrawal_to_wallet')
    if fk == 'wallet' and tk == 'cex': kinds.append('wallet_to_cex')
    if not kinds: continue
    if c['scan'] == 'tracked' and kinds in (['cex_withdrawal_to_wallet'], ['wallet_to_cex']) and c['usd'] < 3 * min_usd(c['sym']): continue
    c['kinds'] = kinds; c['round'] = roundness(c['amount'], c['usd']); c['id'] = f'{tx}:{li}'; c['chain'] = 'ethereum'
    c['token_amount_raw'] = str(c.pop('raw'))
    events.append(c)
# block timestamps
blocks = sorted({e['block'] for e in events})
bt = dict(zip(blocks, eth_batch([('eth_getBlockByNumber', [hex(b), False]) for b in blocks], ctx=ctx)))
for e in events:
    b = bt.get(e['block']); e['t'] = int(b['timestamp'], 16) * 1000 if b else None

# ---------------- Solana: CEX hot wallets ----------------
def solana_scan():
    jp_cache = {}
    def prices(mints):
        need = [m for m in mints if m not in jp_cache]
        for i in range(0, len(need), 50):
            d = ctx.tryf('jup price', lambda: fetch('https://lite-api.jup.ag/price/v3?ids=' + ','.join(need[i:i + 50]), ctx=ctx), {}) or {}
            for m in need[i:i + 50]: jp_cache[m] = (d.get(m) or {}).get('usdPrice')
        return jp_cache
    WSOL = 'So11111111111111111111111111111111111111112'
    wallets = list(SOL_CEX_CURATED.items())[:8]
    out = []; scanned = 0
    for w, ex in wallets:
        sigs = ctx.tryf('sol sigs ' + ex, lambda: sol_rpc('getSignaturesForAddress', [w, {'limit': 12}], ctx=ctx), []) or []
        for s in sigs:
            if s.get('err'): continue
            tx = ctx.tryf('sol tx', lambda: sol_rpc('getTransaction', [s['signature'], {'encoding': 'jsonParsed', 'maxSupportedTransactionVersion': 0}], ctx=ctx), None)
            if not tx: continue
            scanned += 1
            m = tx['meta']; keys = [k['pubkey'] if isinstance(k, dict) else k for k in tx['transaction']['message']['accountKeys']]
            deltas = {}
            for side, arr in (('pre', m.get('preTokenBalances') or []), ('post', m.get('postTokenBalances') or [])):
                for b in arr:
                    k = (b.get('owner'), b['mint']); v = float(b['uiTokenAmount'].get('uiAmountString') or 0)
                    deltas[k] = deltas.get(k, 0) + (v if side == 'post' else -v)
            for i, k in enumerate(keys):
                d = (m['postBalances'][i] - m['preBalances'][i]) / 1e9
                if abs(d) > 0.5: deltas[(k, WSOL)] = deltas.get((k, WSOL), 0) + d
            px = prices(list({mt for _, mt in deltas}))
            for (own, mt), d in deltas.items():
                if d >= 0 or not px.get(mt): continue
                usd = -d * px[mt]
                if usd < 2.5e5: continue
                recv = [(o2, d2) for (o2, m2), d2 in deltas.items() if m2 == mt and d2 > 0 and o2 != own]
                if not recv: continue
                to, dv = max(recv, key=lambda x: x[1])
                fk = 'cex' if own in SOLCEX else 'mm' if own in MM else 'wallet'; tk = 'cex' if to in SOLCEX else 'mm' if to in MM else 'wallet'
                fn = SOLCEX.get(own) or (MM.get(own) or {}).get('entity'); tn = SOLCEX.get(to) or (MM.get(to) or {}).get('entity')
                kinds = []
                if 'mm' in (fk, tk): kinds.append('otc_desk')
                if fk == tk == 'cex' and fn and tn and fn.split(' ')[0] != tn.split(' ')[0]: kinds.append('cex_to_cex')
                if fk == 'cex' and tk == 'wallet' and usd >= 1e6: kinds.append('cex_withdrawal_to_wallet')
                if fk == 'wallet' and tk == 'cex' and usd >= 1e6: kinds.append('wallet_to_cex')
                if not kinds: continue
                out.append({'id': s['signature'] + ':' + mt[:6], 'chain': 'solana', 'tx': s['signature'], 't': (tx.get('blockTime') or 0) * 1000, 'token': mt, 'sym': 'SOL' if mt == WSOL else mt[:6],
                            'amount': -d, 'usd': usd, 'from': own, 'to': to, 'fromKind': fk, 'toKind': tk, 'fromName': fn, 'toName': tn, 'kinds': kinds, 'round': roundness(-d, usd), 'scan': 'sol-cex-hot'})
    return out, scanned, len(wallets)
sol_events, sol_scanned, sol_wallets = ctx.tryf('solana scan', solana_scan, ([], 0, 0))
events += sol_events

# ---------------- price follow-up (Binance 1m) ----------------
BASE = {'WETH': 'ETH', 'WBTC': 'BTC', 'CBBTC': 'BTC', 'TBTC': 'BTC', 'WSTETH': 'ETH', 'WEETH': 'ETH', 'RETH': 'ETH', 'CBETH': 'ETH', 'SOL': 'SOL'}
def follow(e):
    if not e.get('t') or e['sym'] in STABLES: return
    b = BASE.get(e['sym'], e['sym'])
    if NOWMS - e['t'] < 30 * 60e3: e['outcome'] = 'pending'; return
    try:
        k = fetch(f"https://data-api.binance.vision/api/v3/klines?symbol={b}USDT&interval=1m&startTime={e['t'] - 60000}&limit=62", ctx=ctx, retries=1)
    except Exception: e['outcome'] = 'no Binance USDT market'; return
    if len(k) < 31: e['outcome'] = 'pending'; return
    p0 = float(k[0][4]); r30 = float(k[30][4]) / p0 - 1; r60 = float(k[min(60, len(k) - 1)][4]) / p0 - 1 if len(k) >= 61 else None
    e['ret30Pct'] = round(r30 * 100, 3); e['ret60Pct'] = round(r60 * 100, 3) if r60 is not None else None; e['pxSymbol'] = b + 'USDT'
    lim = 0.75 if b in ('BTC', 'ETH', 'SOL') else 1.5
    mv = max(abs(r30), abs(r60 or 0)) * 100
    e['outcome'] = 'followed_by_move' if mv >= lim else 'no_significant_move'
    if r60 is None: e['outcome'] += ' (60m pending)'
old = {e['id']: e for e in state.get('events', [])}
new_count = sum(1 for e in events if e['id'] not in old)
for e in events: old[e['id']] = dict(old.get(e['id'], {}), **e)
allev = sorted(old.values(), key=lambda e: -(e.get('t') or 0))[:600]
todo = [e for e in allev if e.get('outcome') in (None, 'pending') or '(60m pending)' in (e.get('outcome') or '')][:80]
pmap(follow, todo, 4)
# linked flows: a large receipt followed (<=60 min) by onward transfers of the same token from the recipient, or >=3 equal-size sends from one wallet
byfrom = {}
for e in allev:
    if e.get('t'): byfrom.setdefault((e['chain'], e.get('token'), e['from']), []).append(e)
for e in allev:
    if not e.get('t'): continue
    nxt = [x for x in byfrom.get((e['chain'], e.get('token'), e['to']), []) if 0 <= x['t'] - e['t'] <= 3600e3]
    if nxt:
        e['onward'] = [{'id': x['id'], 'usd': round(x['usd']), 'to': x['to'], 'toKind': x['toKind']} for x in nxt][:10]
        for x in nxt: x['fundedBy'] = e['id']
for (ch, t, f), xs in byfrom.items():
    for x in xs:
        same = [y for y in xs if abs(y['t'] - x['t']) <= 600e3 and abs(y['amount'] / x['amount'] - 1) < 0.001]
        if len(same) >= 3: x['fanout'] = len(same)
new_ids = {e['id'] for e in events}
flags = [e for e in allev if e['id'] in new_ids and (('otc_desk' in e['kinds']) or ('cex_to_cex' in e['kinds']) or ('wallet_to_wallet' in e['kinds']) or e.get('round'))]
cnt = lambda k: sum(1 for e in events if k in e['kinds'])
doc = {'generatedAt': NOWMS, 'elapsedS': round(time.time() - T0, 1), 'lastBlock': head,
       'window': {'trackedFromBlock': start, 'toBlock': head, 'blocks': head - start + 1, 'mmFromBlock': mm_from, 'approxHoursTracked': round((head - start + 1) * 12 / 3600, 2), 'approxHoursMM': round((head - mm_from) * 12 / 3600, 1)},
       'coverage': {'trackedTokens': len(tok), 'logsTracked': len(logsA), 'logsMM': len(logsB), 'mmAddressesEth': len(mm_list), 'mmLabelsTotal': len(MM), 'vcWalletsUsed': vc_n,
                    'cexLabelsEth': len(CEX), 'mmTokensUnpriced': len(unknown_tok), 'solanaCexWallets': sol_wallets, 'solanaTxParsed': sol_scanned},
       'thisRun': {'events': len(events), 'newEvents': new_count, 'otc_desk': cnt('otc_desk'), 'cex_to_cex': cnt('cex_to_cex'), 'wallet_to_wallet': cnt('wallet_to_wallet'),
                   'cex_withdrawal_to_wallet': cnt('cex_withdrawal_to_wallet'), 'wallet_to_cex': cnt('wallet_to_cex'), 'round': sum(1 for e in events if e.get('round')), 'fanout': sum(1 for e in events if e.get('fanout')), 'linked': sum(1 for e in events if e.get('onward')), 'usdTotal': sum(e['usd'] for e in events)},
       'flags': sorted(flags, key=lambda e: -e['usd'])[:100], 'events': allev,
       'followUp': {'followed_by_move': sum(1 for e in allev if (e.get('outcome') or '').startswith('followed_by_move')), 'no_significant_move': sum(1 for e in allev if (e.get('outcome') or '').startswith('no_significant'))},
       'labels': {'curatedMM': CURATED_MM, 'notFound': 'B2C2, Galaxy Digital, Flowdesk: no keyless, verifiable Ethereum address list found (vc_wallets.json from the VC-watch worker is merged when present)'},
       'method': __doc__, 'errors': ctx.errors[:40], 'calls': ctx.calls}
writej('riskinfra_otcflow.json', doc)
print(json.dumps({k: doc[k] for k in ('elapsedS', 'window', 'coverage', 'thisRun', 'followUp')}, default=str), len(ctx.errors))
