"""Shared helpers for the AI Agents desk (research/agents.py, research/agents_birth.py). Free public endpoints only."""
import json, os, time, urllib.request, urllib.parse, urllib.error, threading, hashlib
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data')
CACHE = os.path.join(DATA, 'agents_cache')
os.makedirs(CACHE, exist_ok=True)
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
VAPI = 'https://api.virtuals.io/api'
T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
T_FSWAP = '0x298c349c742327269dc8de6ad66687767310c948ea309df826f5bd103e19d207'  # Virtuals bonding pair Swap(a0In,a0Out,a1In,a1Out)
T_FMINT = '0xcc9c58b575eabd3f6a1ee653e91fcea3ff546867ffc3782a3bbca1f9b6dbb8df'  # bonding pair Mint(reserve0,reserve1)
T_V2SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'
T_V2SYNC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'
VIRTUAL_BASE = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b'
VIRTUAL_USDC_V3 = '0x529d2863a1521d0b57db028168fde2e97120017c'  # Uniswap v3 VIRTUAL/USDC on Base (token0 = VIRTUAL)
BASE_GENESIS_TS = 1686789347  # Base block 0; 2 s blocks -> ts = genesis + 2*n (verified against RPC)
CHAINS = {
    'BASE': {'rpc': 'https://base.gateway.tenderly.co', 'span': 1000, 'multi': True, 'archive': True, 'gt': 'base', 'ds': 'base'},
    'ROBINHOOD': {'rpc': 'https://rpc.mainnet.chain.robinhood.com', 'span': 500000, 'multi': False, 'archive': False, 'gt': 'robinhood', 'ds': 'robinhood'},
}
_lock = threading.Lock(); _last = {}

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)

def http(url, data=None, timeout=40, headers=None, tries=3, min_gap=0.0):
    host = urllib.parse.urlparse(url).netloc
    for i in range(tries):
        if min_gap:
            with _lock:
                w = _last.get(host, 0) + min_gap - time.time()
                if w > 0: time.sleep(w)
                _last[host] = time.time()
        try:
            h = {'user-agent': UA, 'accept': 'application/json', **(headers or {})}
            if data is not None: h['content-type'] = 'application/json'
            r = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers=h)
            with urllib.request.urlopen(r, timeout=timeout) as f: return json.loads(f.read())
        except urllib.error.HTTPError as e:
            body = e.read()[:300]
            if e.code in (429, 502, 503, 504) and i < tries - 1: time.sleep(4 * (i + 1)); continue
            try: return json.loads(body)
            except Exception: raise RuntimeError(f'HTTP {e.code} {body[:120]}')
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(2 * (i + 1))

def jcache(name, key, fn, ttl=None):
    p = os.path.join(CACHE, name); os.makedirs(p, exist_ok=True)
    f = os.path.join(p, hashlib.sha1(key.encode()).hexdigest()[:20] + '.json')
    if os.path.exists(f) and (ttl is None or time.time() - os.path.getmtime(f) < ttl):
        try: return json.load(open(f))
        except Exception: pass
    v = fn()
    if v is not None:
        tmp = f + '.tmp'; json.dump(v, open(tmp, 'w')); os.replace(tmp, f)
    return v

def save(name, obj):
    p = os.path.join(DATA, name); tmp = p + '.tmp'
    json.dump(obj, open(tmp, 'w'), separators=(',', ':'), default=str); os.replace(tmp, p)

def vapi(path, params=None, ttl=None):
    u = f'{VAPI}/{path}' + ('?' + urllib.parse.urlencode(params) if params else '')
    if ttl: return jcache('vapi', u, lambda: http(u, min_gap=0.4), ttl)
    return http(u, min_gap=0.4)

def vapi_all(path, params, max_pages=20, page_size=100):
    out = []
    for pg in range(1, max_pages + 1):
        d = vapi(path, {**params, 'pagination[page]': pg, 'pagination[pageSize]': page_size})
        out += d.get('data') or []
        if pg >= ((d.get('meta') or {}).get('pagination') or {}).get('pageCount', 0): break
    return out

def rpc(chain, method, params):
    c = CHAINS[chain]
    for i in range(4):
        d = http(c['rpc'], {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, min_gap=0.12 if chain == 'BASE' else 0.03)
        if d is None: continue
        if 'error' in d:
            msg = str(d['error'])
            if 'rate' in msg.lower() or 'limit' in msg.lower() and 'range' not in msg.lower(): time.sleep(3 * (i + 1)); continue
            raise RuntimeError(msg[:300])
        return d.get('result')
    raise RuntimeError('rpc retries exhausted')

def head(chain):
    return int(rpc(chain, 'eth_blockNumber', []), 16) - 30

_bts = {}
def block_ts(chain, n):
    if chain == 'BASE': return BASE_GENESIS_TS + 2 * n
    k = (chain, n)
    if k not in _bts:
        b = rpc(chain, 'eth_getBlockByNumber', [hex(n), False]); _bts[k] = int(b['timestamp'], 16)
    return _bts[k]

def block_at(chain, ts):
    if chain == 'BASE': return max(0, (int(ts) - BASE_GENESIS_TS) // 2)
    def f():
        lo, hi = 1, head(chain)
        while lo < hi:
            m = (lo + hi) // 2
            if block_ts(chain, m) < ts: lo = m + 1
            else: hi = m
        return lo
    return jcache('blockat', f'{chain}:{int(ts) // 60 * 60}', f)

class TsInterp:
    """Block -> timestamp. Base is exact (2 s blocks); other chains interpolate between fetched anchor blocks."""
    def __init__(s, chain, a, b):
        s.chain = chain; s.anch = {}
        if chain != 'BASE':
            step = max(1, (b - a) // 40)
            for n in list(range(a, b, step)) + [b]: s.anch[n] = block_ts(chain, n)
            s.keys = sorted(s.anch)
    def __call__(s, n):
        if s.chain == 'BASE': return BASE_GENESIS_TS + 2 * n
        import bisect
        i = bisect.bisect_right(s.keys, n)
        if i <= 0: return s.anch[s.keys[0]]
        if i >= len(s.keys): return s.anch[s.keys[-1]]
        a, b = s.keys[i - 1], s.keys[i]
        return s.anch[a] + (s.anch[b] - s.anch[a]) * (n - a) / max(1, b - a)

def get_logs(chain, addresses, a, b, topics=None, quiet_stop_h=None, ts_of=None):
    """Logs for addresses in [a, b], chunked per chain limits. quiet_stop_h: stop after this many hours without logs (once some were seen)."""
    c = CHAINS[chain]; out = []; span = c['span']
    groups = [addresses] if c['multi'] else [[x] for x in addresses]
    for g in groups:
        n = a; last_hit = None
        while n <= b:
            e = min(b, n + span - 1)
            q = {'fromBlock': hex(n), 'toBlock': hex(e), 'address': g if len(g) > 1 else g[0]}
            if topics: q['topics'] = topics
            try: r = rpc(chain, 'eth_getLogs', [q])
            except RuntimeError as ex:
                if span > 50 and ('range' in str(ex).lower() or 'too many' in str(ex).lower() or 'limit' in str(ex).lower()):
                    span //= 2; continue
                raise
            out += r or []
            if r: last_hit = e
            if quiet_stop_h and last_hit and ts_of and ts_of(e) - ts_of(last_hit) > quiet_stop_h * 3600 and len(groups) == 1: break
            n = e + 1
    return out

def u256(h, i): return int(h[2 + 64 * i: 2 + 64 * (i + 1)] or '0', 16)
def addr_t(t): return '0x' + t[-40:]

_vp = {}
def virtual_usd(ts):
    """VIRTUAL/USD at a timestamp (hour bucket) from the Uniswap v3 VIRTUAL/USDC pool slot0 on Base (archive eth_call)."""
    hb = int(ts) // 3600 * 3600
    if hb in _vp: return _vp[hb]
    def f():
        n = block_at('BASE', min(hb, time.time() - 120))
        r = rpc('BASE', 'eth_call', [{'to': VIRTUAL_USDC_V3, 'data': '0x3850c7bd'}, hex(n)])
        sp = int(r[2:66], 16)
        return (sp / 2 ** 96) ** 2 * 1e12 if sp else None
    v = jcache('vusd', str(hb), f); _vp[hb] = v; return v

def gini(vals):
    v = sorted(x for x in vals if x > 0); n = len(v)
    if n < 2: return None
    s = sum(v); cum = sum((i + 1) * x for i, x in enumerate(v))
    return round((2 * cum) / (n * s) - (n + 1) / n, 4)

def pct(vs, q):
    v = sorted(vs)
    if not v: return None
    k = (len(v) - 1) * q; f = int(k); c = min(f + 1, len(v) - 1)
    return v[f] + (v[c] - v[f]) * (k - f)
