"""Birth-phase (pre-launch) library: shared helpers. Stdlib only.
Free sources only: Solana public RPC, pump.fun public frontend/swap APIs, GeckoTerminal, DexScreener,
EVM public RPCs (Base drpc, Robinhood Chain official RPC, BSC dataseed). No Nansen/X. Helius only if HELIUS_API_KEY is
already in the environment (never printed)."""
import json, os, time, threading, urllib.request, urllib.error, urllib.parse, sqlite3, hashlib, math, random
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data')
BP = os.path.join(DATA, 'birthphase')
os.makedirs(BP, exist_ok=True)
UA = {'user-agent': 'Mozilla/5.0 (asymmetric-terminal birthphase research, read-only)', 'accept': 'application/json'}
GAPS = {'api.geckoterminal.com': 2.3, 'api.dexscreener.com': 0.4, 'frontend-api-v3.pump.fun': 0.7, 'swap-api.pump.fun': 0.35,
        'api.mainnet-beta.solana.com': 0.3, 'base.drpc.org': 0.4, 'rpc.mainnet.chain.robinhood.com': 0.15,
        'bsc-dataseed.bnbchain.org': 0.3, 'bsc-dataseed1.binance.org': 0.3}
_last, _lock = {}, threading.Lock()
_cdb_lock = threading.Lock()
_cdb = sqlite3.connect(os.path.join(BP, 'cache', 'http_cache.db'), check_same_thread=False, timeout=60)
_cdb.execute('CREATE TABLE IF NOT EXISTS c(k TEXT PRIMARY KEY, t INTEGER, v TEXT)')
_cdb.commit()
CALLS = {}

import fcntl
def _throttle(host):
    """cross-process throttle (several collectors share the same free-tier quotas)"""
    g = GAPS.get(host, 0.3)
    fn = os.path.join(BP, 'cache', 'thr_' + host.replace('.', '_'))
    with _lock:
        with open(fn, 'a+') as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.seek(0); txt = f.read().strip()
            last = float(txt) if txt else 0.0
            nowt = time.time(); slot = max(nowt, last + g)
            f.seek(0); f.truncate(); f.write(repr(slot)); f.flush()
            fcntl.flock(f, fcntl.LOCK_UN)
    if slot > time.time(): time.sleep(slot - time.time())
    return
def _throttle_old(host):
    with _lock:
        g = GAPS.get(host, 0.3)
        wait = _last.get(host, 0) + g - time.time()
        _last[host] = max(time.time(), _last.get(host, 0) + g)
    if wait > 0: time.sleep(wait)

def _cache_get(k, ttl):
    with _cdb_lock:
        r = _cdb.execute('SELECT t, v FROM c WHERE k=?', (k,)).fetchone()
    if r and (ttl is None or time.time() - r[0] < ttl): return json.loads(r[1])
    return None

def _cache_put(k, v):
    with _cdb_lock:
        _cdb.execute('INSERT OR REPLACE INTO c VALUES (?,?,?)', (k, int(time.time()), json.dumps(v)))
        _cdb.commit()

def http(url, data=None, ttl=None, retries=4, timeout=30, headers=None, ok=None):
    """GET (or POST json if data) with per-host throttle, retry on 429/5xx, sqlite cache. ttl=None -> cache forever
    (immutable history); ttl=0 -> no cache."""
    k = hashlib.sha1((url + '|' + (json.dumps(data, sort_keys=True) if data is not None else '')).encode()).hexdigest()
    if ttl != 0:
        v = _cache_get(k, ttl)
        if v is not None: return v
    host = urllib.parse.urlparse(url).hostname
    h = dict(UA); h.update(headers or {})
    body = None
    if data is not None: body = json.dumps(data).encode(); h['content-type'] = 'application/json'
    last = None
    for i in range(retries + 1):
        _throttle(host)
        CALLS[host] = CALLS.get(host, 0) + 1
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=h), timeout=timeout) as r:
                v = json.loads(r.read().decode())
            if isinstance(v, dict) and v.get('error') and data is not None and i < retries:
                time.sleep(min(30, 3 * (2 ** i))); continue  # JSON-RPC error (often rate limit): retry, never cache
            if ttl != 0 and (ok is None or ok(v)) and not (isinstance(v, dict) and v.get('error') and data is not None): _cache_put(k, v)
            return v
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504, 520, 522, 524) and i < retries:
                time.sleep(min(60, 4 * (2 ** i)) + random.random()); continue
            if e.code in (401, 403):
                return {'_http_error': e.code}  # not cached
            if e.code in (400, 404):
                try: v = json.loads(e.read().decode())
                except Exception: v = {'_http_error': e.code}
                if isinstance(v, dict): v['_http_error'] = e.code
                return v
            raise
        except Exception as e:
            last = e
            if i < retries: time.sleep(3 * (i + 1)); continue
            raise
    raise last

SOL_RPC = 'https://api.mainnet-beta.solana.com'
if os.environ.get('HELIUS_API_KEY'):
    SOL_RPC = 'https://mainnet.helius-rpc.com/?api-key=' + os.environ['HELIUS_API_KEY']
    GAPS['mainnet.helius-rpc.com'] = 0.12

def sol(method, params, ttl=None):
    r = http(SOL_RPC, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, ttl=ttl)
    if isinstance(r, dict) and r.get('error'):
        # transient RPC errors -> no cache poisoning: delete and raise
        raise RuntimeError(f"rpc {method}: {str(r['error'])[:200]}")
    return r.get('result') if isinstance(r, dict) else None

EVM_RPC = {'base': 'https://base.drpc.org', 'robinhood': 'https://rpc.mainnet.chain.robinhood.com', 'bsc': 'https://bsc-dataseed.bnbchain.org'}

def evm(chain, method, params, ttl=None):
    r = http(EVM_RPC[chain], {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, ttl=ttl)
    if isinstance(r, dict) and r.get('error'): raise RuntimeError(f"{chain} {method}: {str(r['error'])[:200]}")
    return r.get('result')

GT = 'https://api.geckoterminal.com/api/v2'
GT_NET = {'solana': 'solana', 'base': 'base', 'bsc': 'bsc', 'robinhood': 'robinhood'}

def short(w):
    """Short wallet id used everywhere in the library (also the join key for repeat-buyer detection)."""
    return (w[:4] + '..' + w[-4:]) if w and len(w) > 10 else w

def gini(xs):
    xs = sorted(x for x in xs if x is not None and x >= 0)
    n = len(xs); s = sum(xs)
    if n < 2 or s <= 0: return None
    cum = sum((i + 1) * x for i, x in enumerate(xs))
    return round((2 * cum) / (n * s) - (n + 1) / n, 4)

def q(xs, p):
    xs = sorted(x for x in xs if x is not None)
    if not xs: return None
    k = (len(xs) - 1) * p; f = math.floor(k); c = min(len(xs) - 1, f + 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)

def wjsonl(path, recs):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        for r in recs: f.write(json.dumps(r, separators=(',', ':')) + '\n')
    os.replace(tmp, path)

def rjsonl(path):
    out = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line:
                    try: out.append(json.loads(line))
                    except Exception: pass
    except FileNotFoundError: pass
    return out

def wjson(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f: json.dump(obj, f, separators=(',', ':'))
    os.replace(tmp, path)

# Checkpoints (seconds after creation) used for time-normalised trajectories in every library file.
CHECKPOINTS = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]
THRESH = [1e5, 1e6, 1e7]
