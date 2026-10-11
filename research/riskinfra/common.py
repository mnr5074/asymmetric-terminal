"""Shared helpers for the risk-infrastructure collectors (oracles / dependencies / otcflow).
Free public endpoints only (no Nansen, no paid X API, no keys). Every number written comes from a source call;
failed calls are recorded under `errors` and the field is left null - nothing is estimated silently."""
import json, os, time, statistics, urllib.request, urllib.error, threading
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data')
UA = {'user-agent': 'Mozilla/5.0 (asymmetric-terminal riskinfra, read-only)', 'accept': 'application/json'}
ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org']
SOL_RPC = os.environ.get('SOLANA_RPC_URL') or 'https://api.mainnet-beta.solana.com'
NOW = time.time()


class Ctx:
    def __init__(self, name):
        self.name = name; self.errors = []; self.calls = 0; self.lock = threading.Lock(); self.t0 = time.time()

    def err(self, what, e):
        with self.lock: self.errors.append({'what': what, 'error': str(e)[:240]})

    def tryf(self, what, fn, default=None):
        try: return fn()
        except Exception as e: self.err(what, e); return default


def fetch(url, data=None, timeout=25, raw=False, headers=None, retries=2, ctx=None):
    h = dict(UA); h.update(headers or {})
    body = None
    if data is not None:
        body = json.dumps(data).encode(); h['content-type'] = 'application/json'
    last = None
    for i in range(retries + 1):
        try:
            if ctx: ctx.calls += 1
            with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=h), timeout=timeout) as r:
                b = r.read()
                return b.decode('utf-8', 'replace') if raw else json.loads(b.decode())
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504) and i < retries: time.sleep(2.5 * (i + 1)); continue
            raise
        except Exception as e:
            last = e
            if i < retries: time.sleep(1.5 * (i + 1)); continue
            raise
    raise last


_gt_lock = threading.Lock(); _gt_last = [0.0]
def gt_get(path, ctx=None):
    """GeckoTerminal free tier (~30 req/min): serialized with a 2.2s gap."""
    with _gt_lock:
        w = _gt_last[0] + 2.2 - time.time()
        if w > 0: time.sleep(w)
        _gt_last[0] = time.time()
        return fetch('https://api.geckoterminal.com/api/v2' + path, ctx=ctx, retries=1, headers={'accept': 'application/json;version=20230302'})


def eth_batch(calls, ctx=None, chunk=40):
    """calls: [(method, params)] -> list of results (None on error). JSON-RPC batch to public Ethereum RPCs with fallback."""
    out = [None] * len(calls)
    for s in range(0, len(calls), chunk):
        part = calls[s:s + chunk]
        payload = [{'jsonrpc': '2.0', 'id': s + i, 'method': m, 'params': p} for i, (m, p) in enumerate(part)]
        res = None
        for rpc in ETH_RPCS:
            try:
                res = fetch(rpc, data=payload, timeout=30, retries=1, ctx=ctx)
                if isinstance(res, list): break
            except Exception as e:
                if ctx: ctx.err('eth_batch ' + rpc, e)
                res = None
        for r in res or []:
            if isinstance(r, dict) and 'result' in r: out[r['id']] = r['result']
    return out


def eth_call1(method, params, ctx=None):
    errs = []
    for rpc in ETH_RPCS:
        try:
            r = fetch(rpc, data={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, timeout=30, retries=1, ctx=ctx)
            if 'error' in r: errs.append(rpc.split('/')[2] + ': ' + str(r['error'])[:160]); continue
            return r['result']
        except Exception as e: errs.append(rpc.split('/')[2] + ': ' + str(e)[:160])
    raise Exception(' | '.join(errs))


_sol_lock = threading.Lock(); _sol_last = [0.0]
def sol_rpc(method, params, ctx=None, gap=0.35):
    for i in range(5):
        with _sol_lock:
            w = _sol_last[0] + gap - time.time()
            if w > 0: time.sleep(w)
            _sol_last[0] = time.time()
        try:
            r = fetch(SOL_RPC, data={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, timeout=30, retries=0, ctx=ctx)
        except urllib.error.HTTPError as e:
            if e.code == 429: time.sleep(1.5 * (i + 1)); continue
            raise
        if 'error' in r:
            if r['error'].get('code') == 429 or 'too many' in str(r['error']).lower(): time.sleep(1.5 * (i + 1)); continue
            raise Exception(str(r['error'])[:200])
        return r['result']
    raise Exception('solana rpc rate limited: ' + method)


def readj(name, default=None):
    try:
        with open(os.path.join(DATA_DIR, name)) as f: return json.load(f)
    except Exception: return default


def writej(name, obj):
    p = os.path.join(DATA_DIR, name); tmp = p + '.tmp'
    with open(tmp, 'w') as f: json.dump(obj, f, separators=(',', ':'), default=str)
    os.replace(tmp, p)


def median(xs):
    xs = [x for x in xs if x is not None and x == x and x > 0]
    return statistics.median(xs) if xs else None


def pmap(fn, items, workers=6):
    with ThreadPoolExecutor(workers) as ex: return list(ex.map(fn, items))


def hexint(h):
    try: return int(h, 16)
    except Exception: return None


def int256(h):
    v = int(h, 16)
    return v - (1 << 256) if v >= (1 << 255) else v
