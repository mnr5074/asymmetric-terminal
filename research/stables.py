#!/usr/bin/env python3
"""Stablecoin mint/burn/net-issuance tracker + spike backtest (free data only).

Sources (all keyless / free):
  * DefiLlama stablecoins API: daily circulating supply per chain per coin (native-minted vs bridged split).
  * Free public EVM RPCs (eth_getLogs): gross mint/burn events
      - USDC Ethereum + Base: FiatToken Mint(minter,to,amt) / Burn(burner,amt) events, minter classified
        (CCTP v1/v2 TokenMinter, Circle Gateway = cross-chain moves; anything else = primary issuance/other)
      - USDT Ethereum: Issue / Redeem / DestroyedBlackFunds events
      - Robinhood Chain (4663): Transfer from/to 0x0 for USDG, USDe, USDC (bridged) etc.
  * Solana RPC getTokenSupply (snapshot only; gross mint/burn history needs per-tx parsing -> paid indexer).
  * CoinGecko free daily prices (majors) + data/cg_series (crash/runner catalog tokens) for the backtest.
Outputs: data/stables.json (summary + backtest), data/stables_onchain.json (hourly on-chain cache),
         data/stables_prices.json (majors daily closes), data/stables_sol_snap.json (Solana supply snapshots).
Env: STABLES_ONCHAIN_DAYS (default 90), STABLES_BASE_DAYS (default = ONCHAIN_DAYS), STABLES_SKIP_ONCHAIN=1.
"""
import json, os, sys, time, math, random, threading, datetime as dt, urllib.request, urllib.error, urllib.parse
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import DATA_DIR, get as cget

UA = {'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (asymmetric-terminal stables research, read-only)', 'accept': 'application/json'}
OUT = os.path.join(DATA_DIR, 'stables.json')
ONCH = os.path.join(DATA_DIR, 'stables_onchain.json')
PXF = os.path.join(DATA_DIR, 'stables_prices.json')
SOLSNAP = os.path.join(DATA_DIR, 'stables_sol_snap.json')
DAYS = int(os.environ.get('STABLES_ONCHAIN_DAYS', '90'))
BASE_DAYS = int(os.environ.get('STABLES_BASE_DAYS', str(DAYS)))
NOW = time.time()
def log(*a): print(time.strftime('%H:%M:%S'), *a, flush=True)
def jload(p, d=None):
    try: return json.load(open(p))
    except Exception: return d
def jsave(p, o):
    tmp = p + '.tmp'; json.dump(o, open(tmp, 'w'), separators=(',', ':')); os.replace(tmp, p)
def day(ts): return dt.datetime.fromtimestamp(int(ts), dt.timezone.utc).strftime('%Y-%m-%d')

# ---------------------------------------------------------------- topics
T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
T_MINT = '0xab8530f87dc9b59234c4623bf917212bb2536d647574c8e7e5da92c2ede0c9f8'   # Mint(address,address,uint256)
T_BURN = '0xcc16f5dbb4873280815c1ee09dbd06736cffcc184412cf7a71a0fdb75d397ca5'   # Burn(address,uint256)
T_ISSUE = '0xcb8241adb0c3fdb35b70c24ce35c5eb0c17af7431c99f827d44a445ca624176a'  # Issue(uint256)
T_REDEEM = '0x702d5967f45f6513a38ffc42d6ba9bf230bd40e8f53b16363c7eb4fd2deb9a44' # Redeem(uint256)
T_DBF = '0x61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6'    # DestroyedBlackFunds(address,uint256)
Z32 = '0x' + '0' * 64
# Circle docs (developers.circle.com/cctp/evm-smart-contracts, /cctp/v1/..., /gateway/references/contract-addresses)
MINTER_LABELS = {
    '0xfd78ee919681417d192449715b2594ab58f5d002': 'cctp_v2',
    '0xc4922d64a24675e16e1586e3e3aa56c06fabe907': 'cctp_v1',   # Ethereum TokenMinter v1
    '0xe45b133ddc64be80252b0e9c75a8e74ef280eed6': 'cctp_v1',   # Base TokenMinter v1
    '0x2222222d7164433c4c09b0b0d809a9b52c04c205': 'gateway',   # Circle GatewayMinter
}
CROSS = {'cctp_v2', 'cctp_v1', 'gateway'}

# ---------------------------------------------------------------- EVM RPC
_rl = {}; _rlk = threading.Lock()
def rpc(url, method, params, gap=0.25, retries=6):
    host = urllib.parse.urlparse(url).hostname
    for i in range(retries + 1):
        with _rlk:
            w = _rl.get(host, 0) + gap - time.time(); _rl[host] = max(time.time(), _rl.get(host, 0) + gap)
        if w > 0: time.sleep(w)
        try:
            req = urllib.request.Request(url, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(), UA)
            r = json.load(urllib.request.urlopen(req, timeout=45))
            if 'error' in r:
                m = str(r['error'])
                if i < retries and any(k in m.lower() for k in ('rate', 'limit exceeded', 'timeout', 'busy', 'try again', 'internal', 'temporarily unavailable', 'unavailable')):
                    time.sleep(2 * (i + 1)); continue
                raise RuntimeError(m[:300])
            return r['result']
        except urllib.error.HTTPError as e:
            if e.code in (504, 524) and method == 'eth_getLogs' and i >= 1: raise  # let caller split the range
            if i < retries and e.code in (429, 500, 502, 503, 504, 520, 522, 524): time.sleep(3 * (i + 1)); continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if i < retries: time.sleep(3 * (i + 1)); continue
            raise

class Chain:
    def __init__(self, name, urls, chunk, gap, threads=1, batch_ts=False):
        self.name, self.urls, self.chunk, self.gap, self.threads, self.batch_ts = name, urls, chunk, gap, threads, batch_ts
        self.tscache = {}
    def call(self, m, p):
        err = None
        for u in self.urls:
            try: return rpc(u, m, p, self.gap)
            except Exception as e: err = e
        raise err
    def ts_many(self, blocks):
        """exact timestamps via JSON-RPC batch (100 per HTTP request)"""
        need = sorted(set(b for b in blocks if b not in self.tscache))
        for i in range(0, len(need), 100):
            part = need[i:i + 100]
            body = [{'jsonrpc': '2.0', 'id': j, 'method': 'eth_getBlockByNumber', 'params': [hex(b), False]} for j, b in enumerate(part)]
            for k in range(5):
                try:
                    r = json.load(urllib.request.urlopen(urllib.request.Request(self.urls[0], json.dumps(body).encode(), UA), timeout=60)); break
                except Exception:
                    if k == 4: raise
                    time.sleep(3 * (k + 1))
            for x in r:
                if 'result' in x and x['result']: self.tscache[part[x['id']]] = int(x['result']['timestamp'], 16)
            time.sleep(self.gap)
        return {b: self.tscache.get(b) for b in blocks}
    def head(self): return int(self.call('eth_blockNumber', []), 16)
    def ts(self, b):
        if b not in self.tscache: self.tscache[b] = int(self.call('eth_getBlockByNumber', [hex(b), False])['timestamp'], 16)
        return self.tscache[b]
    def block_at(self, t, hi=None):
        """first block with timestamp >= t (binary search with interpolation)"""
        hi = hi or self.head(); lo = 1
        if self.ts(hi) < t: return hi
        while hi - lo > 1:
            tl, th = self.ts(lo), self.ts(hi)
            g = lo + int((t - tl) / max(1, th - tl) * (hi - lo)) if th > tl else (lo + hi) // 2
            g = min(max(g, lo + 1), hi - 1)
            if hi - lo > 64: g = min(max(g, lo + (hi - lo) // 64), hi - (hi - lo) // 64)
            if self.ts(g) >= t: hi = g
            else: lo = g
        return hi

ETH = Chain('ethereum', ['https://rpc.mevblocker.io'], 4000, 0.3)  # archive logs; (flashbots returns EMPTY for old ranges -> never use as fallback)
BASE = Chain('base', ['https://gateway.tenderly.co/public/base'], 1000, 0.12, threads=4)
RH = Chain('robinhood', ['https://rpc.mainnet.chain.robinhood.com'], 5_000_000, 0.3, batch_ts=True)  # Nitro returns blockTimestamp=0x0 -> exact ts via batched eth_getBlockByNumber

def a2t(a): return '0x' + '0' * 24 + a[2:].lower()
# Each source: what to scan and how to decode. kind: 'fiat' (USDC Mint/Burn), 'tether' (Issue/Redeem), 'xfer' (Transfer 0x0)
SOURCES = [
    {'id': 'ethereum:USDC', 'chain': ETH, 'coin': 'USDC', 'addr': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'dec': 6, 'kind': 'fiat', 'native': True, 'days': DAYS, 'label': 'native (Circle)'},
    {'id': 'base:USDC', 'chain': BASE, 'coin': 'USDC', 'addr': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'dec': 6, 'kind': 'fiat', 'native': True, 'days': BASE_DAYS, 'label': 'native (Circle)'},
    {'id': 'ethereum:USDT', 'chain': ETH, 'coin': 'USDT', 'addr': '0xdAC17F958D2ee523a2206206994597C13D831ec7', 'dec': 6, 'kind': 'tether', 'native': True, 'days': max(DAYS, 365), 'chunk': 10000, 'label': 'native (Tether)'},
    {'id': 'robinhood:USDG', 'chain': RH, 'coin': 'USDG', 'addr': '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 'dec': 6, 'kind': 'xfer', 'native': True, 'days': 365, 'label': 'native (Paxos-issued Global Dollar; listed on docs.robinhood.com/chain/contracts)'},
]
# Robinhood Chain extra stables (identified via RPC symbol()/name()/decimals(); filled in RH_EXTRA below)
RH_EXTRA = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'stables_rh_tokens.json'))) if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'stables_rh_tokens.json')) else []
for t in RH_EXTRA:
    SOURCES.append({'id': 'robinhood:' + t['coin'], 'chain': RH, 'coin': t['coin'], 'addr': t['addr'], 'dec': t['dec'], 'kind': 'xfer', 'native': t.get('native', False), 'days': 365, 'label': t['label']})

def decode(src, l):
    """-> (type 'mint'|'burn', amount_usd, class)"""
    t0 = l['topics'][0].lower(); d = src['dec']
    if src['kind'] == 'fiat':
        if t0 == T_MINT:
            who = '0x' + l['topics'][1][-40:]; return 'mint', int(l['data'][:66], 16) / 10 ** d, MINTER_LABELS.get(who, 'other')
        if t0 == T_BURN:
            who = '0x' + l['topics'][1][-40:]; return 'burn', int(l['data'][:66], 16) / 10 ** d, MINTER_LABELS.get(who, 'other')
    elif src['kind'] == 'tether':
        if t0 == T_ISSUE: return 'mint', int(l['data'][2:66], 16) / 10 ** d, 'issue'
        if t0 == T_REDEEM: return 'burn', int(l['data'][2:66], 16) / 10 ** d, 'redeem'
        if t0 == T_DBF: return 'burn', int(l['data'][66:130], 16) / 10 ** d, 'destroyed_black_funds'
    elif src['kind'] == 'xfer' and t0 == T_TRANSFER and len(l['topics']) == 3:
        amt = int(l['data'][:66], 16) / 10 ** d
        if l['topics'][1].lower() == Z32: return 'mint', amt, 'transfer_from_0x0'
        if l['topics'][2].lower() == Z32: return 'burn', amt, 'transfer_to_0x0'
    return None

def filters(src):
    a = src['addr']
    if src['kind'] == 'fiat': return [{'address': a, 'topics': [[T_MINT, T_BURN]]}]
    if src['kind'] == 'tether': return [{'address': a, 'topics': [[T_ISSUE, T_REDEEM, T_DBF]]}]
    return [{'address': a, 'topics': [T_TRANSFER, Z32]}, {'address': a, 'topics': [T_TRANSFER, None, Z32]}]

def scan_range(src, a, b):
    """fetch + decode logs in [a,b]; returns list of (ts, type, amt, cls). Splits on too-many-results errors."""
    ch = src['chain']; out = []
    for f in filters(src):
        stack = [(a, b)]
        while stack:
            x, y = stack.pop()
            try: logs = ch.call('eth_getLogs', [dict(f, fromBlock=hex(x), toBlock=hex(y))])
            except Exception as e:
                m = str(e).lower()
                if y > x and any(k in m for k in ('exceed', 'too many', 'limit', 'range', 'response size', 'timeout', 'timed out', 'time-out', '504', '10000')):
                    mid = (x + y) // 2; stack += [(x, mid), (mid + 1, y)]; continue
                raise
            for l in logs:
                if l.get('blockTimestamp') in ('0x0', '0x', 0): l.pop('blockTimestamp')
            need = [l for l in logs if not l.get('blockTimestamp')]
            exact = {}
            if need and ch.batch_ts: exact = ch.ts_many([int(l['blockNumber'], 16) for l in need])
            elif need:  # interpolate timestamps inside [x,y]
                tx, ty = ch.ts(x), ch.ts(y)
            for l in logs:
                r = decode(src, l)
                if not r: continue
                bn = int(l['blockNumber'], 16)
                t = int(l['blockTimestamp'], 16) if l.get('blockTimestamp') else exact.get(bn) if exact.get(bn) else (ch.ts(x) + (ch.ts(y) - ch.ts(x)) * (bn - x) / max(1, y - x))
                out.append((t, *r))
    return out

def scan_source(src, cache):
    sid = src['id']; ch = src['chain']; st = cache.setdefault(sid, {'hours': {}, 'first': None, 'last': None})
    head = ch.head(); want_from_ts = NOW - src['days'] * 86400
    last = st['last']; first = st['first']
    jobs = []
    chunk = src.get('chunk', ch.chunk)
    if first is None:
        b0 = ch.block_at(want_from_ts, head) if ch is not RH or want_from_ts > ch.ts(1) else 1
        jobs.append((b0, head)); newfirst, newlast = b0, head
    else:
        newfirst, newlast = first, head
        if last < head: jobs.append((last + 1, head))
        if ch.ts(first) > want_from_ts + 3600:
            b0 = ch.block_at(want_from_ts, first) if ch is not RH or want_from_ts > ch.ts(1) else 1
            if b0 < first: jobs.append((b0, first - 1)); newfirst = b0
    ranges = []
    for a, b in jobs:
        x = a
        while x <= b: ranges.append((x, min(b, x + chunk - 1))); x += chunk
    log(sid, 'scan', len(ranges), 'chunks', jobs)
    H = st['hours']; done = [0]; lk = threading.Lock()
    def work(r):
        ev = scan_range(src, *r)
        with lk:
            for t, typ, amt, cls in ev:
                hk = str(int(t // 3600) * 3600)
                h = H.setdefault(hk, {'mint': 0.0, 'burn': 0.0, 'nm': 0, 'nb': 0, 'cls': {}})
                h[typ] += amt; h['nm' if typ == 'mint' else 'nb'] += 1
                c = h['cls'].setdefault(cls, [0.0, 0.0]); c[0 if typ == 'mint' else 1] += amt
            done[0] += 1
            if done[0] % 25 == 0: log(sid, done[0], '/', len(ranges), 'events so far', sum(h['nm'] + h['nb'] for h in H.values()))
    if ch.threads > 1:
        with ThreadPoolExecutor(ch.threads) as ex: list(ex.map(work, ranges))
    else:
        # newest first so a failure mid-backfill still leaves a contiguous [lowest_done, head] window we can keep
        fwdj = [r for r in ranges if first is None or r[0] > (last or 0)]; back = [r for r in ranges if r not in fwdj]
        for grp in (fwdj, back):
            grp.sort(key=lambda r: -r[0]); low = None
            for r in grp:
                try: work(r); low = r[0]
                except Exception:
                    if grp is fwdj and first is not None: raise  # incremental gap -> do not save inconsistent state
                    if low is not None:
                        st['first'] = low; st['last'] = newlast if grp is fwdj else st['last']
                        st['first_ts'], st['last_ts'] = ch.ts(st['first']), ch.ts(st['last']); st['partial'] = True
                        st.update({'coin': src['coin'], 'chain': ch.name, 'addr': src['addr'], 'kind': src['kind'], 'native': src['native'], 'label': src['label']})
                    raise
    st.pop('partial', None)
    st['first'], st['last'] = newfirst, newlast
    st['first_ts'], st['last_ts'] = ch.ts(newfirst), ch.ts(newlast)
    # totalSupply snapshot for reconciliation
    try:
        st['totalSupply'] = int(ch.call('eth_call', [{'to': src['addr'], 'data': '0x18160ddd'}, 'latest']), 16) / 10 ** src['dec']
        st['totalSupply_at'] = int(time.time())
    except Exception as e: st['totalSupply_err'] = str(e)[:120]
    # reconciliation: totalSupply(last) - totalSupply(first-1) must equal sum(mint) - sum(burn) over the scanned range
    try:
        sup = lambda b: int(ch.call('eth_call', [{'to': src['addr'], 'data': '0x18160ddd'}, hex(b)]), 16) / 10 ** src['dec']
        a, b = (0.0 if newfirst <= 1 else sup(newfirst - 1)), sup(newlast)
        ev = sum(h['mint'] - h['burn'] for h in H.values())
        st['reconcile'] = {'supply_delta': b - a, 'events_net': ev, 'diff': (b - a) - ev, 'ok': abs((b - a) - ev) <= max(1.0, 1e-6 * abs(b))}
    except Exception as e: st['reconcile'] = {'error': str(e)[:160]}
    st.update({'coin': src['coin'], 'chain': ch.name, 'addr': src['addr'], 'kind': src['kind'], 'native': src['native'], 'label': src['label']})

def onchain_windows(st):
    H = st['hours']; res = {}
    for name, sec in (('24h', 86400), ('7d', 7 * 86400), ('30d', 30 * 86400)):
        lo = NOW - sec
        if st.get('first_ts', 1e18) > lo + 3600: res[name] = None; continue
        m = b = 0.0; nm = nb = 0; cls = {}
        for hk, h in H.items():
            if int(hk) + 3600 > lo:  # bucket overlaps window (hour granularity)
                m += h['mint']; b += h['burn']; nm += h['nm']; nb += h['nb']
                for c, (cm, cb) in h['cls'].items():
                    x = cls.setdefault(c, [0.0, 0.0]); x[0] += cm; x[1] += cb
        cross_m = sum(v[0] for k, v in cls.items() if k in CROSS); cross_b = sum(v[1] for k, v in cls.items() if k in CROSS)
        res[name] = {'mint': m, 'burn': b, 'net': m - b, 'n_mint': nm, 'n_burn': nb,
                     'by_class': {k: {'mint': v[0], 'burn': v[1], 'net': v[0] - v[1]} for k, v in cls.items()},
                     'primary_mint': m - cross_m, 'primary_burn': b - cross_b, 'primary_net': (m - cross_m) - (b - cross_b),
                     'crosschain_mint': cross_m, 'crosschain_burn': cross_b}
    return res

def onchain_daily(st):
    D = {}
    for hk, h in st['hours'].items():
        d = D.setdefault(day(int(hk)), {'mint': 0.0, 'burn': 0.0, 'pm': 0.0, 'pb': 0.0})
        d['mint'] += h['mint']; d['burn'] += h['burn']
        d['pm'] += h['mint'] - sum(v[0] for k, v in h['cls'].items() if k in CROSS)
        d['pb'] += h['burn'] - sum(v[1] for k, v in h['cls'].items() if k in CROSS)
    # drop partial first day
    if st.get('first_ts') and D:
        fd = day(st['first_ts'])
        if st['first_ts'] % 86400 > 60 and fd in D: D.pop(fd)
    return dict(sorted(D.items()))

# ---------------------------------------------------------------- DefiLlama
LL = 'https://stablecoins.llama.fi'
LL_CHAINS = {'ethereum': 'Ethereum', 'base': 'Base', 'solana': 'Solana', 'robinhood': 'Robinhood Chain', 'arbitrum': 'Arbitrum', 'bsc': 'BSC', 'tron': 'Tron'}
COINS = {'USDT': '1', 'USDC': '2', 'USDG': '286', 'USDe': '146', 'USD1': '262', 'PYUSD': '120'}
MAJOR = {'USDT', 'USDC', 'USDG'}  # fiat-backed set used for the chain-level signal (USDe/USD1/PYUSD shown as context)
def llama_get(url):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r: return json.loads(r.read())
        except Exception:
            if i == 3: raise
            time.sleep(4 * (i + 1))

def llama():
    allc = llama_get(LL + '/stablecoins?includePrices=false')['peggedAssets']
    byid = {a['id']: a for a in allc}
    pairs = {}
    for coin, cid in COINS.items():
        a = byid.get(cid)
        if not a: continue
        for ck, cn in LL_CHAINS.items():
            cur = ((a.get('chainCirculating') or {}).get(cn) or {}).get('current', {}).get('peggedUSD')
            if not cur or cur < 1e6: continue
            rows = llama_get(f"{LL}/stablecoincharts/{urllib.parse.quote(cn)}?stablecoin={cid}"); time.sleep(0.3)
            ser = []
            for r in rows:
                c = (r.get('totalCirculating') or {}).get('peggedUSD')
                if c is None: continue
                ser.append({'date': day(int(r['date'])), 'circ': c, 'minted': (r.get('totalMintedUSD') or {}).get('peggedUSD'), 'bridged': (r.get('totalBridgedToUSD') or {}).get('peggedUSD')})
            pairs[f'{ck}:{coin}'] = {'chain': ck, 'coin': coin, 'current': cur, 'series': ser[-420:]}
    # global USDC/USDT totals (for "share of total net issuance")
    glob = {}
    for coin in ('USDC', 'USDT'):
        rows = llama_get(f"{LL}/stablecoincharts/all?stablecoin={COINS[coin]}")
        glob[coin] = [{'date': day(int(r['date'])), 'circ': (r.get('totalCirculating') or {}).get('peggedUSD')} for r in rows if (r.get('totalCirculating') or {}).get('peggedUSD') is not None][-420:]
    return pairs, glob

def net_series(ser):
    out = []
    for p, c in zip(ser, ser[1:]):
        out.append({'date': c['date'], 'net': c['circ'] - p['circ'], 'circ': c['circ'], 'prev': p['circ']})
    return out

def spike_flags(net, k=3.0, zthr=2.5, win=30, zmin_ratio=1.5, min_frac=0.0005):
    """net: list of {'date','net','prev'}. Spike if net>0, net >= min_frac of prior supply (materiality, when known) and
    (z > zthr  OR  (net > k * trailing-30d mean (mean>0) AND z > zmin_ratio)). Trailing window excludes the day.
    The z>1.5 guard on the 3x rule stops near-zero 30d averages from flagging trivial days."""
    res = []
    for i, r in enumerate(net):
        if i < win: res.append(None); continue
        w = [x['net'] for x in net[i - win:i]]
        mu = sum(w) / win; sd = math.sqrt(sum((x - mu) ** 2 for x in w) / (win - 1))
        z = (r['net'] - mu) / sd if sd > 0 else None
        ratio = r['net'] / mu if mu > 0 else None
        prev = r.get('prev') or 0
        material = (r['net'] >= min_frac * prev) if prev > 0 else True
        flag = r['net'] > 0 and material and ((z is not None and z > zthr) or (ratio is not None and ratio > k and z is not None and z > zmin_ratio))
        res.append({'date': r['date'], 'net': r['net'], 'avg30': mu, 'z': z, 'ratio_vs_avg30': ratio, 'spike': bool(flag)})
    return res

# ---------------------------------------------------------------- Solana
SOL_MINTS = {'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
             'USDG': '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', 'PYUSD': '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'}
def solana_snap():
    snaps = jload(SOLSNAP, {'snaps': []})
    row = {'ts': int(time.time())}
    for coin, mint in SOL_MINTS.items():
        try:
            r = rpc('https://api.mainnet-beta.solana.com', 'getTokenSupply', [mint], gap=0.6)
            row[coin] = float(r['value']['uiAmountString'])
        except Exception as e: row[coin + '_err'] = str(e)[:100]
    snaps['snaps'].append(row); snaps['snaps'] = snaps['snaps'][-2000:]
    jsave(SOLSNAP, snaps)
    return row, snaps['snaps']

# ---------------------------------------------------------------- prices + backtest
MAJORS = {'solana': 'SOL', 'ethereum': 'ETH', 'binancecoin': 'BNB', 'tron': 'TRX', 'aerodrome-finance': 'AERO'}
def prices():
    px = jload(PXF, {}) or {}
    if px.get('ts', 0) < NOW - 6 * 3600:
        for cid in MAJORS:
            try:
                d = cget(f'https://api.coingecko.com/api/v3/coins/{cid}/market_chart?vs_currency=usd&days=365&interval=daily')
                px[cid] = {day(t / 1000): p for t, p in d['prices'] if int(t / 1000) % 86400 == 0}
            except Exception as e: log('cg fail', cid, e)
        px['ts'] = NOW; jsave(PXF, px)
    return px

def catalog_chain_tokens():
    cat = jload(os.path.join(DATA_DIR, 'crash_catalog.json'), {}) or {}
    sd = os.path.join(DATA_DIR, 'cg_series'); have = set(f[:-5] for f in os.listdir(sd)) if os.path.isdir(sd) else set()
    SOLK = {'pump-fun', 'pump.fun', 'solana-meme-coins', 'letsbonk-fun-ecosystem', 'believe-app-ecosystem', 'moonshot-ecosystem', 'Raydium (Solana)', 'solana-ecosystem'}
    BASEK = {'base-meme-coins', 'clanker-ecosystem', 'zora-ecosystem', 'base:uniswap', 'base:aerodrome', 'base-ecosystem', 'virtuals-protocol-ecosystem'}
    BSCK = {'four-meme-ecosystem', 'four.meme', 'bsc:pancakeswap', 'binance-smart-chain', 'bnb-chain-ecosystem'}
    out = {'solana': {}, 'base': {}, 'bsc': {}}
    for c in cat.get('catalog', []):
        cid = c.get('id')
        if not cid or cid not in have or c.get('artifact_risk'): continue
        keys = set(c.get('categories') or []) | {c.get('launchpad') or ''}
        ch = c.get('chain') or ('solana' if keys & SOLK else 'base' if keys & BASEK else 'bsc' if keys & BSCK else None)
        if ch in out:
            try:
                d = json.load(open(os.path.join(sd, cid + '.json')))
                s = {day(t / 1000): p for t, p in d['prices'] if int(t / 1000) % 86400 == 0 and p}
                if len(s) >= 60: out[ch][cid] = s
            except Exception: pass
    return out

def fwd(series, d, h):
    dd = dt.date.fromisoformat(d); e = (dd + dt.timedelta(days=h)).isoformat()
    a, b = series.get(d), series.get(e)
    return math.log(b / a) if a and b and a > 0 and b > 0 else None

def tcdf(t, df):  # two-sided p for Student t via regularized incomplete beta (continued fraction)
    x = df / (df + t * t)
    def betacf(a, b, x):
        qab, qap, qam = a + b, a + 1, a - 1; c, d = 1.0, 1 - qab * x / qap
        d = 1 / d if abs(d) > 1e-30 else 1e30; h = d
        for m in range(1, 200):
            m2 = 2 * m; aa = m * (b - m) * x / ((qam + m2) * (a + m2))
            d = 1 + aa * d; d = 1 / d if abs(d) > 1e-30 else 1e30; c = 1 + aa / c if abs(c) > 1e-30 else 1e30; h *= d * c
            aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
            d = 1 + aa * d; d = 1 / d if abs(d) > 1e-30 else 1e30; c = 1 + aa / c if abs(c) > 1e-30 else 1e30; de = d * c; h *= de
            if abs(de - 1) < 3e-12: break
        return h
    a, b = df / 2, 0.5
    bt = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x)) if 0 < x < 1 else 0
    ib = bt * betacf(a, b, x) / a if x < (a + 1) / (a + b + 2) else 1 - bt * betacf(b, a, 1 - x) / b
    return min(1.0, max(0.0, ib))

def welch(a, b):
    if len(a) < 2 or len(b) < 2: return None
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    va = sum((x - ma) ** 2 for x in a) / (len(a) - 1); vb = sum((x - mb) ** 2 for x in b) / (len(b) - 1)
    se = math.sqrt(va / len(a) + vb / len(b))
    if se == 0: return None
    t = (ma - mb) / se
    df = (va / len(a) + vb / len(b)) ** 2 / ((va / len(a)) ** 2 / (len(a) - 1) + (vb / len(b)) ** 2 / (len(b) - 1))
    sp = math.sqrt(((len(a) - 1) * va + (len(b) - 1) * vb) / (len(a) + len(b) - 2))
    return {'diff': ma - mb, 't': t, 'df': df, 'p': tcdf(t, df), 'cohen_d': (ma - mb) / sp if sp > 0 else None}

def perm_p(days_all, spike_set, ret, n=2000, seed=7):
    """circular-shift permutation of spike dates (keeps clustering) -> two-sided p of mean diff"""
    idx = [d for d in days_all if ret.get(d) is not None]
    if len(idx) < 20: return None
    flags = [1 if d in spike_set else 0 for d in idx]; vals = [ret[d] for d in idx]
    k = sum(flags)
    if k < 2 or k > len(idx) - 2: return None
    def md(fl):
        s = [v for v, f in zip(vals, fl) if f]; o = [v for v, f in zip(vals, fl) if not f]
        return sum(s) / len(s) - sum(o) / len(o)
    obs = md(flags); rnd = random.Random(seed); cnt = 0; N = len(idx)
    for _ in range(n):
        sh = rnd.randrange(1, N); fl = flags[sh:] + flags[:sh]
        if abs(md(fl)) >= abs(obs) - 1e-15: cnt += 1
    return (cnt + 1) / (n + 1)

def backtest(chain_signal, majors_px, cat_tokens):
    """chain_signal: chain -> list of spike_flags rows. Returns effect sizes per chain x target x horizon."""
    TARGETS = {'solana': [('SOL', majors_px.get('solana', {}))], 'ethereum': [('ETH', majors_px.get('ethereum', {}))],
               'base': [('ETH', majors_px.get('ethereum', {})), ('AERO', majors_px.get('aerodrome-finance', {}))],
               'bsc': [('BNB', majors_px.get('binancecoin', {}))], 'tron': [('TRX', majors_px.get('tron', {}))],
               'arbitrum': [('ETH', majors_px.get('ethereum', {}))], 'robinhood': [('ETH', majors_px.get('ethereum', {}))]}
    res = {}
    for ch, rows in chain_signal.items():
        rows = [r for r in rows if r]
        spikes = {r['date'] for r in rows if r['spike']}; days_all = [r['date'] for r in rows]
        tg = list(TARGETS.get(ch, []))
        toks = cat_tokens.get(ch, {})
        if toks: tg.append((f'catalog basket ({len(toks)} {ch} tokens, equal-weight)', None))
        out = {'n_days': len(days_all), 'n_spike_days': len(spikes), 'spike_dates': sorted(spikes)[-40:], 'targets': {}}
        for name, ser in tg:
            hz = {}
            for h in (1, 3, 7, 14):
                ret = {}
                for d in days_all:
                    if ser is not None: v = fwd(ser, d, h)
                    else:
                        xs = [fwd(s, d, h) for s in toks.values()]; xs = [x for x in xs if x is not None]
                        v = sum(xs) / len(xs) if len(xs) >= 5 else None
                    if v is not None: ret[d] = v
                a = [ret[d] for d in days_all if d in spikes and d in ret]; b = [ret[d] for d in days_all if d not in spikes and d in ret]
                w = welch(a, b)
                hz[f'{h}d'] = {'n_spike': len(a), 'n_base': len(b), 'mean_spike': (sum(a) / len(a)) if a else None, 'mean_base': (sum(b) / len(b)) if b else None,
                               'hit_spike': (sum(1 for x in a if x > 0) / len(a)) if a else None, 'hit_base': (sum(1 for x in b if x > 0) / len(b)) if b else None,
                               'welch': w, 'perm_p': perm_p(days_all, spikes, ret) if a else None}
            out['targets'][name] = hz
        res[ch] = out
    return res

# ---------------------------------------------------------------- main
def main():
    t0 = time.time()
    cache = jload(ONCH, {}) or {}
    errors = {}
    if os.environ.get('STABLES_SKIP_ONCHAIN') != '1':
        import copy
        only = set(filter(None, os.environ.get('STABLES_ONLY', '').split(',')))
        for src in SOURCES:
            if only and src['id'] not in only: continue
            snap = copy.deepcopy(cache.get(src['id']))
            try:
                scan_source(src, cache); jsave(ONCH, cache)
            except Exception as e:
                errors[src['id']] = str(e)[:300]; log('onchain fail', src['id'], e)
                st = cache.get(src['id']) or {}
                if st.get('partial') and st.get('first') is not None: jsave(ONCH, cache); errors[src['id']] += ' (partial window kept; next run resumes backfill)'
                elif snap is None: cache.pop(src['id'], None)
                else: cache[src['id']] = snap
    log('defillama...')
    pairs, glob = llama()
    log('solana snapshot...')
    sol_row, sol_snaps = solana_snap()

    # per-pair metrics from DefiLlama
    pm = {}
    for k, p in pairs.items():
        ns = net_series(p['series']); fl = spike_flags(ns)
        s = p['series']; last = s[-1]
        def dlt(n): return (s[-1]['circ'] - s[-1 - n]['circ']) if len(s) > n else None
        cur_fl = next((x for x in reversed(fl) if x), None)
        pm[k] = {'chain': p['chain'], 'coin': p['coin'], 'supply': last['circ'], 'asof': last['date'],
                 'minted_native': last.get('minted'), 'bridged_in': last.get('bridged'),
                 'net_1d': dlt(1), 'net_7d': dlt(7), 'net_30d': dlt(30), 'net_90d': dlt(90),
                 'velocity_7d': (dlt(7) / last['circ']) if dlt(7) is not None and last['circ'] else None,
                 'spike_today': cur_fl, 'spikes_90d': [x['date'] for x in fl[-90:] if x and x['spike']],
                 'daily': [{'date': x['date'], 'net': round(x['net'], 2), 'circ': round(x['circ'], 2)} for x in ns[-365:]]}
    # chain aggregate (USDT+USDC+USDG) signal
    chains = {}
    for ck in LL_CHAINS:
        mem = [pairs[k] for k in pairs if pairs[k]['chain'] == ck and pairs[k]['coin'] in MAJOR]
        if not mem: continue
        dates = sorted(set.intersection(*[set(r['date'] for r in m['series']) for m in mem])) if len(mem) > 1 else [r['date'] for r in mem[0]['series']]
        # union-with-zero-before-listing: use dates where at least one exists, treat missing (pre-launch) as 0
        dates = sorted(set(r['date'] for m in mem for r in m['series']))
        agg = []
        for d in dates:
            tot = 0.0
            for m in mem:
                v = next((r['circ'] for r in m['series'] if r['date'] == d), None) if False else None
            agg.append(d)
        maps = [{r['date']: r['circ'] for r in m['series']} for m in mem]
        ser = []
        for d in dates:
            vals = [mp.get(d) for mp in maps]
            # carry: missing before first listing = 0; missing after = skip day
            ok = True; tot = 0.0
            for mp, v in zip(maps, vals):
                if v is None:
                    if d < min(mp): v = 0.0
                    else: ok = False; break
                tot += v
            if ok: ser.append({'date': d, 'circ': tot})
        ns = net_series(ser); fl = spike_flags(ns)
        def dlt(n): return (ser[-1]['circ'] - ser[-1 - n]['circ']) if len(ser) > n else None
        chains[ck] = {'coins': [m['coin'] for m in mem], 'supply': ser[-1]['circ'], 'asof': ser[-1]['date'], 'net_1d': dlt(1), 'net_7d': dlt(7), 'net_30d': dlt(30),
                      'velocity_7d': dlt(7) / ser[-1]['circ'] if dlt(7) is not None else None, 'spike_latest': next((x for x in reversed(fl) if x), None),
                      'spikes_90d': [x['date'] for x in fl[-90:] if x and x['spike']], 'flags': fl[-370:], 'history_days': len(ser)}
    ranking = sorted([{'chain': c, 'velocity_7d': v['velocity_7d'], 'net_7d': v['net_7d'], 'supply': v['supply']} for c, v in chains.items() if v['velocity_7d'] is not None], key=lambda x: -x['velocity_7d'])

    # Base share of USDC net issuance
    def gd(lst, n):
        return (lst[-1]['circ'] - lst[-1 - n]['circ']) if len(lst) > n else None
    share = {}
    for n, lab in ((1, '1d'), (7, '7d'), (30, '30d'), (90, '90d')):
        b = pm.get('base:USDC', {}).get('net_' + lab) if lab != '90d' else pm.get('base:USDC', {}).get('net_90d')
        e = pm.get('ethereum:USDC', {}).get('net_' + lab) if lab != '90d' else pm.get('ethereum:USDC', {}).get('net_90d')
        g = gd(glob.get('USDC', []), n)
        share[lab] = {'base_net': b, 'eth_net': e, 'global_usdc_net': g,
                      'base_share_of_global': (b / g) if b is not None and g and g > 0 else None,
                      'base_share_of_eth_plus_base': (b / (b + e)) if b is not None and e is not None and (b + e) > 0 and b >= 0 and e >= 0 else None,
                      'note': None if (g and g > 0) else 'global USDC net change <= 0 in window: share undefined'}
    # on-chain summaries
    onc = {}
    for sid, st in cache.items():
        if not isinstance(st, dict) or 'hours' not in st: continue
        dly = onchain_daily(st)
        rows = [{'date': d, 'net': v['mint'] - v['burn'], 'prev': 0} for d, v in dly.items() if d < day(NOW)]
        pf = spike_flags([{'date': d, 'net': v['pm'] - v['pb']} for d, v in dly.items() if d < day(NOW)])
        onc[sid] = {k: st.get(k) for k in ('coin', 'chain', 'addr', 'kind', 'native', 'label', 'totalSupply', 'totalSupply_at', 'first_ts', 'last_ts', 'reconcile')}
        onc[sid]['windows'] = onchain_windows(st)
        onc[sid]['daily'] = [{'date': d, 'mint': round(v['mint'], 2), 'burn': round(v['burn'], 2), 'net': round(v['mint'] - v['burn'], 2), 'primary_net': round(v['pm'] - v['pb'], 2)} for d, v in dly.items()][-365:]
        onc[sid]['spike_latest_primary'] = next((x for x in reversed(pf) if x), None)
        onc[sid]['spikes_primary_90d'] = [x['date'] for x in pf[-90:] if x and x['spike']]
    # gross mint share Base vs ETH (on-chain)
    gs = {}
    for w in ('24h', '7d', '30d'):
        e = ((onc.get('ethereum:USDC') or {}).get('windows') or {}).get(w); b = ((onc.get('base:USDC') or {}).get('windows') or {}).get(w)
        if e and b:
            gs[w] = {'base_gross_mint_share': b['mint'] / (b['mint'] + e['mint']) if (b['mint'] + e['mint']) else None,
                     'base_primary_mint_share': b['primary_mint'] / (b['primary_mint'] + e['primary_mint']) if (b['primary_mint'] + e['primary_mint']) > 0 else None,
                     'base_net': b['net'], 'eth_net': e['net'], 'base_primary_net': b['primary_net'], 'eth_primary_net': e['primary_net']}
    share['onchain'] = gs

    # Solana: compare snapshots (net change since ~24h / 7d ago if available)
    sol = {'latest': sol_row, 'n_snaps': len(sol_snaps), 'gross_mint_burn': 'unavailable from free sources (needs per-transaction parsing of mintTo/burn via an indexer such as Helius; public RPC cannot page USDC mint history at this volume). Net from DefiLlama daily + supply snapshots.'}
    for lab, sec in (('24h', 86400), ('7d', 7 * 86400)):
        old = [s for s in sol_snaps if s['ts'] <= sol_row['ts'] - sec + 1800]
        if old:
            o = old[-1]; sol['net_' + lab] = {c: sol_row[c] - o[c] for c in SOL_MINTS if c in sol_row and c in o}; sol['net_' + lab + '_from_ts'] = o['ts']
    # spikes active now
    active = []
    for ck, v in chains.items():
        x = v['spike_latest']
        if x and x['spike'] and x['date'] >= day(NOW - 2 * 86400): active.append({'scope': 'chain', 'chain': ck, **x})
    for k, v in pm.items():
        x = v['spike_today']
        if x and x['spike'] and x['date'] >= day(NOW - 2 * 86400): active.append({'scope': 'pair', 'pair': k, **x})
    for k, v in onc.items():
        x = v.get('spike_latest_primary')
        if x and x['spike'] and x['date'] >= day(NOW - 2 * 86400): active.append({'scope': 'onchain_primary', 'pair': k, **x})

    log('backtest...')
    px = prices(); cat = catalog_chain_tokens()
    bt = backtest({c: v['flags'] for c, v in chains.items()}, px, cat)
    tests = [(c, t, h, x) for c, v in bt.items() for t, hz in v['targets'].items() for h, x in hz.items() if x.get('perm_p') is not None]
    bt_summary = {'n_tests': len(tests), 'bonferroni_alpha_0.05': (0.05 / len(tests)) if tests else None,
                  'nominal_hits_perm_p_lt_0.05': [{'chain': c, 'target': t, 'h': h, 'diff': (x['welch'] or {}).get('diff'), 'n_spike': x['n_spike'], 'perm_p': x['perm_p']} for c, t, h, x in tests if x['perm_p'] < 0.05],
                  'expected_false_positives_at_0.05': round(0.05 * len(tests), 1),
                  'caveats': ['overlapping forward windows + clustered spike days: Welch p is optimistic; prefer the circular-shift permutation p',
                              'BSC USDT/USDC are Binance-Peg (bridged) and move in large round lumps (treasury top-ups); n is tiny and the Oct 8/14 2025 spikes sit next to the Oct 10 2025 market-wide liquidation crash',
                              'Robinhood Chain has only ~66 days of DefiLlama history and no chain-native token in the catalog (ETH used as proxy)']}
    labels = {
        'base:USDT': 'No native Tether USDT on Base. DefiLlama lists no USDT on Base; bridged variants (e.g. bridged "Tether USD" 0xfde4…bb2, USDT0 routes) are third-party bridged tokens and are not counted as USDT issuance.',
        'base:USDbC': 'USDbC (0xd9aA…6CA) = legacy bridged USDC (Base canonical bridge), not Circle-native; excluded from USDC issuance.',
        'robinhood:USDC': 'USDC on Robinhood Chain is a bridged StandardArbERC20 (Arbitrum-style canonical bridge), not Circle-native; supply tiny.',
        'robinhood:USDG': 'USDG on Robinhood Chain: canonical token per docs.robinhood.com/chain/contracts; DefiLlama counts it as natively minted (totalMintedUSD) since Jul 2026, earlier entries were tagged bridged.',
        'arbitrum:USDT': 'DefiLlama USDT on Arbitrum includes USDT0 (LayerZero OFT) - bridged/omnichain, not a Tether-native mint on Arbitrum.',
        'ethereum:USDC': 'Circle-native. On-chain gross mints include CCTP/Gateway cross-chain arrivals; "primary" = minters other than CCTP v1/v2 TokenMinter and GatewayMinter.',
    }
    out = {'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), 'elapsed_s': round(time.time() - t0, 1),
           'method': {'net_issuance_llama': 'day-over-day change in DefiLlama totalCirculating (USD) per chain per coin; snapshot at ~00:00 UTC',
                      'onchain': 'gross mint/burn from token events over free public RPCs (mevblocker/flashbots for Ethereum, Tenderly public gateway for Base, Robinhood public RPC), hourly buckets; windows are rolling to scan time',
                      'spike': 'daily net > 0, >= 0.05% of prior supply, and (z > 2.5 vs trailing 30d OR (net > 3x trailing-30d mean net with mean>0 AND z > 1.5)); trailing window excludes the day',
                      'velocity': '7d net change / current supply (DefiLlama, USDT+USDC+USDG per chain)',
                      'backtest': 'signal date D (DefiLlama snapshot D 00:00 UTC) -> forward log return from CoinGecko daily close at D 00:00 UTC to D+h; spike days vs all other days; Welch t + circular-shift permutation p (2000 shifts) to respect clustering; catalog basket = equal-weight mean of available crash/runner catalog tokens per chain (needs >=5 tokens with data that day)'},
           'chains': {k: {kk: vv for kk, vv in v.items() if kk != 'flags'} for k, v in chains.items()}, 'chain_flags_recent': {k: [x for x in v['flags'][-60:] if x] for k, v in chains.items()},
           'pairs': pm, 'velocity_ranking': ranking, 'base_share': share, 'onchain': onc, 'solana': sol, 'active_spikes': active,
           'labels': labels, 'backtest': bt, 'backtest_summary': bt_summary, 'errors': errors,
           'paid_or_unavailable': ['Solana gross mint/burn history (needs Helius/indexer; free key not configured)', 'Etherscan/Basescan V2 API needs a (free) key: ETHERSCAN_API_KEY not set, so RPC logs used instead', 'Blockscout API for Robinhood Chain is behind a Cloudflare challenge for scripts; used the public RPC instead', 'Tron USDT mint/burn events not scanned (DefiLlama net only)', 'Arbitrum/BSC: DefiLlama net only']}
    jsave(OUT, out)
    log('wrote', OUT, round(time.time() - t0, 1), 's', 'errors:', errors)

if __name__ == '__main__':
    main()
