"""Shared helpers for research/patterns.py (stdlib only, free data only).
HARD RULE: no Nansen / X calls. get() raises before any request to those hosts; per-host call counts are recorded."""
import json, math, os, time, threading, urllib.request, urllib.error, datetime as dt
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data')
CACHE = os.path.join(DATA_DIR, 'patterns_cache')
DB = os.path.join(DATA_DIR, 'moonshot.db')
BLOCKED = ('nansen.ai', 'x.com', 'twitter.com')
GAPS = {'api.geckoterminal.com': 2.3, 'api.mainnet-beta.solana.com': 0.28, 'query1.finance.yahoo.com': 0.6, 'query2.finance.yahoo.com': 0.6,
        'api.dexscreener.com': 0.35, 'frontend-api-v3.pump.fun': 1.6, 'api.rugcheck.xyz': 1.2}
COUNTS = {}
_last, _lock = {}, threading.Lock()
for k in ('NANSEN_API_KEY', 'X_BEARER_TOKEN'): os.environ.pop(k, None)
log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
UTC = dt.timezone.utc

def _host(url): return url.split('/')[2].split(':')[0]
def _throttle(host):
    with _lock:
        wait = _last.get(host, 0) + GAPS.get(host, 0.3) - time.time()
        _last[host] = max(time.time(), _last.get(host, 0)) + GAPS.get(host, 0.3)
    if wait > 0: time.sleep(wait)

def http(url, body=None, retries=4, timeout=30, headers=None):
    host = _host(url)
    if any(host == b or host.endswith('.' + b) for b in BLOCKED): raise RuntimeError('metered API blocked: ' + host)
    h = {'User-Agent': 'Mozilla/5.0 (asymmetric-terminal research, read-only)', 'Accept': 'application/json'}
    if body is not None: h['Content-Type'] = 'application/json'
    h.update(headers or {})
    delay = 3
    for i in range(retries + 1):
        _throttle(host)
        COUNTS[host] = COUNTS.get(host, 0) + 1
        try:
            req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r: return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if e.code in (429, 500, 502, 503, 504) and i < retries: time.sleep(delay); delay *= 2; continue
            raise
        except Exception:
            if i < retries: time.sleep(delay); delay *= 2; continue
            raise

def cached(kind, key, fn, max_age=None):
    d = os.path.join(CACHE, kind); os.makedirs(d, exist_ok=True)
    f = os.path.join(d, key.replace('/', '_')[:180] + '.json')
    if os.path.exists(f) and (max_age is None or time.time() - os.path.getmtime(f) < max_age):
        try: return json.load(open(f))
        except Exception: pass
    v = fn()
    if v is not None: json.dump(v, open(f, 'w'))
    return v

# ---------- GeckoTerminal hourly OHLCV ----------
def gt_hourly(network, pool, before_ts=None, limit=1000, max_age=None):
    key = f'{network}_{pool}_{before_ts or "now"}'
    def f():
        u = f'https://api.geckoterminal.com/api/v2/networks/{network}/pools/{pool}/ohlcv/hour?aggregate=1&limit={limit}&currency=usd'
        if before_ts: u += f'&before_timestamp={int(before_ts)}'
        j = http(u)
        if not j: return {'rows': [], 'err': 'not found'}
        rows = sorted(j['data']['attributes']['ohlcv_list'])  # [ts, o, h, l, c, v]
        return {'rows': rows}
    return cached('gt_hour', key, f, max_age=max_age)

# ---------- Solana public RPC ----------
RPC = os.environ.get('PATTERNS_RPC_URL') or 'https://api.mainnet-beta.solana.com'
def rpc(method, params):
    for i in range(6):
        j = http(RPC, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})
        if j is None: return None
        if 'error' in j:
            msg = str(j['error'])
            if '429' in msg or 'Too many' in msg or j['error'].get('code') in (-32005, 429): time.sleep(3 * (i + 1)); continue
            raise RuntimeError(f'{method}: {msg}')
        return j['result']
    raise RuntimeError(method + ': rate limited')

def sigs(addr, max_pages=3, until_ts=None):
    """Signatures newest->oldest; stops at max_pages or once blockTime < until_ts. Returns (list, exhausted)."""
    out, before = [], None
    for _ in range(max_pages):
        p = {'limit': 1000}
        if before: p['before'] = before
        r = rpc('getSignaturesForAddress', [addr, p]) or []
        out += [{'sig': s['signature'], 't': s.get('blockTime'), 'err': bool(s.get('err'))} for s in r]
        if len(r) < 1000: return out, True
        before = r[-1]['signature']
        if until_ts and r[-1].get('blockTime') and r[-1]['blockTime'] < until_ts: return out, False
    return out, False

def tx(sig):
    return cached('sol_tx', sig, lambda: rpc('getTransaction', [sig, {'encoding': 'jsonParsed', 'maxSupportedTransactionVersion': 1}]))

# ---------- stats (no scipy) ----------
def _gser(a, x):
    s = term = 1.0 / a; n = a
    for _ in range(500):
        n += 1; term *= x / n; s += term
        if abs(term) < abs(s) * 1e-14: break
    return s * math.exp(-x + a * math.log(x) - math.lgamma(a))
def _gcf(a, x):
    b = x + 1 - a; c = 1e300; d = 1 / b; h = d
    for i in range(1, 500):
        an = -i * (i - a); b += 2; d = an * d + b; d = 1e-300 if abs(d) < 1e-300 else d
        c = b + an / c; c = 1e-300 if abs(c) < 1e-300 else c; d = 1 / d; de = d * c; h *= de
        if abs(de - 1) < 1e-14: break
    return math.exp(-x + a * math.log(x) - math.lgamma(a)) * h
def chi2_sf(x, k):
    if x <= 0: return 1.0
    a = k / 2; x = x / 2
    return 1 - _gser(a, x) if x < a + 1 else _gcf(a, x)
def chisq(obs, probs):
    n = sum(obs); stat = sum((o - n * p) ** 2 / (n * p) for o, p in zip(obs, probs) if p > 0)
    k = sum(1 for p in probs if p > 0) - 1
    return {'chi2': round(stat, 3), 'dof': k, 'p': chi2_sf(stat, k), 'n': n, 'min_expected': round(min(n * p for p in probs if p > 0), 2)}
def binom_sf(k, n, p):
    """P(X >= k) exact."""
    return min(1.0, sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k, n + 1)))
def binom_two(k, n, p):
    lo = sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(0, k + 1))
    return min(1.0, 2 * min(lo, binom_sf(k, n, p)))
def pearson(a, b):
    n = len(a)
    if n < 3: return None
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a); vb = sum((y - mb) ** 2 for y in b)
    if va <= 0 or vb <= 0: return None
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(va * vb)
def corr_p(r, n):
    """two-sided p for Pearson r via t-dist approx (normal approx for large n, Fisher z)."""
    if r is None or n < 4: return None
    z = 0.5 * math.log((1 + min(r, 0.999999)) / (1 - min(r, 0.999999))) * math.sqrt(n - 3)
    return math.erfc(abs(z) / math.sqrt(2))
def mwu(a, b):
    """Mann-Whitney U, returns AUC (P(a>b)) and normal-approx two-sided p."""
    if not a or not b: return None
    allv = sorted([(v, 0) for v in a] + [(v, 1) for v in b]); ranks = {}
    i = 0
    while i < len(allv):
        j = i
        while j + 1 < len(allv) and allv[j + 1][0] == allv[i][0]: j += 1
        for k in range(i, j + 1): ranks.setdefault(k, (i + j) / 2 + 1)
        i = j + 1
    ra = sum(ranks[k] for k, (v, g) in enumerate(allv) if g == 0)
    n1, n2 = len(a), len(b); u = ra - n1 * (n1 + 1) / 2
    mu = n1 * n2 / 2; sd = math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12)
    p = math.erfc(abs((u - mu) / sd) / math.sqrt(2)) if sd else None
    return {'auc': round(u / (n1 * n2), 3), 'p': p, 'n1': n1, 'n2': n2}
def save(name, obj):
    obj['billing'] = {'hosts': dict(COUNTS), 'nansen_calls': 0, 'x_calls': 0, 'guard': 'patterns_common.http() raises before any request to nansen.ai / x.com / twitter.com; NANSEN_API_KEY and X_BEARER_TOKEN popped from env'}
    obj['generatedAt'] = int(time.time() * 1000)
    p = os.path.join(DATA_DIR, name); tmp = p + '.tmp'
    json.dump(obj, open(tmp, 'w'), default=str); os.replace(tmp, p)
    log('wrote', p)
