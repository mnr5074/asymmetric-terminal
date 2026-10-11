"""Pattern Lab shared helpers.
Test set = the 50-token sample used by the pattern detectors (data/patterns_flows.json: 30 crashed 'died' from the crash catalog +
20 runners 'mooned'), joined with the research DB (data/moonshot.db) and the GeckoTerminal hourly cache written by patterns_hours.py.
Stats: Fisher exact (two-sided + one-sided 'crashed > runners'), hit rates, false-flag rate (= runner hit rate), lead times.
Nansen: key from env only (never printed), per-call ledger data/patternlab_nansen_ledger.json with balance before/after,
cache data/patternlab_cache/nansen/, refuses any endpoint priced >= 100 credits or unknown, stops at balance floor 300 or run cap."""
import json, os, sys, time, math, hashlib, sqlite3, glob, urllib.request, urllib.error, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
_NKEY = os.environ.get('NANSEN_API_KEY', '')  # captured before patterns_common pops it
sys.path.insert(0, os.path.dirname(HERE))
import patterns_common as PC  # noqa: E402  (http/rpc/cached/throttle; blocks nansen/x hosts in its own http())
DATA_DIR = PC.DATA_DIR
CACHE = os.path.join(DATA_DIR, 'patternlab_cache'); os.makedirs(CACHE, exist_ok=True)
DB = os.path.join(DATA_DIR, 'moonshot.db')
UTC = dt.timezone.utc
log = PC.log
iso = lambda t: dt.datetime.fromtimestamp(int(t), UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
def tsof(s):
    try: return int(dt.datetime.fromisoformat(str(s).replace('Z', '+00:00')).replace(tzinfo=UTC).timestamp())
    except Exception: return None

def jload(name, default=None):
    try: return json.load(open(os.path.join(DATA_DIR, name)))
    except Exception: return default

def save(name, obj):
    obj['generatedAt'] = int(time.time() * 1000)
    p = os.path.join(DATA_DIR, name); tmp = p + '.tmp'
    json.dump(obj, open(tmp, 'w'), default=str); os.replace(tmp, p); log('wrote', p)

def cached(kind, key, fn, max_age=None):
    d = os.path.join(CACHE, kind); os.makedirs(d, exist_ok=True)
    f = os.path.join(d, hashlib.sha1(key.encode()).hexdigest()[:24] + '.json')
    if os.path.exists(f) and (max_age is None or time.time() - os.path.getmtime(f) < max_age):
        try: return json.load(open(f))
        except Exception: pass
    v = fn()
    if v is not None: json.dump(v, open(f, 'w'))
    return v

# ---------------- test set ----------------
def hourly(pool):
    best = []
    for f in glob.glob(os.path.join(DATA_DIR, 'patterns_cache', 'gt_hour', f'solana_{pool}_*.json')):
        try: rows = json.load(open(f)).get('rows') or []
        except Exception: rows = []
        if len(rows) > len(best): best = rows
    return best  # [ts, o, h, l, c, v]

def test_set():
    fl = jload('patterns_flows.json')
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True); db.row_factory = sqlite3.Row
    out = []
    for t in fl['tokens']:
        r = db.execute('select * from tokens where mint=?', (t['mint'],)).fetchone()
        r = dict(r) if r else {}
        hs = db.execute('select owner,pct from top_holders where mint=? order by pct desc', (t['mint'],)).fetchall()
        x = {'mint': t['mint'], 'symbol': t['symbol'], 'cohort': t['cohort'], 'crashed': t['cohort'] == 'died',
             'peak_t': t['peak_t'], 'break_t': t.get('crash_break_t'), 'created_t': (r.get('created_ts') or 0) // 1000 or None,
             'db': r, 'holders': [(h[0], h[1]) for h in hs], 'wallets': t.get('wallets') or [], 'pool': r.get('main_pool')}
        x['ohlcv'] = hourly(x['pool']) if x['pool'] else []
        if not x['break_t'] and x['ohlcv']:  # first hourly close <= 70% of peak high after the peak (the 'dump' moment)
            pk = max((row for row in x['ohlcv']), key=lambda row: row[2])
            for row in x['ohlcv']:
                if row[0] > pk[0] and row[4] <= 0.7 * pk[2]: x['dump_t'] = row[0]; break
        x['dump_t'] = x.get('break_t') or x.get('dump_t')
        out.append(x)
    return out

# ---------------- stats ----------------
def _hyp(a, b, c, d):
    n = a + b + c + d
    return math.comb(a + b, a) * math.comb(c + d, c) / math.comb(n, a + c)
def fisher(a, b, c, d):
    """2x2 [[a,b],[c,d]] rows = crashed(flag,noflag), runners(flag,noflag). returns (p_two_sided, p_greater)."""
    r1, c1, n = a + b, a + c, a + b + c + d
    lo, hi = max(0, c1 - (n - r1)), min(r1, c1)
    p0 = _hyp(a, b, c, d); two = gt = 0.0
    for x in range(lo, hi + 1):
        p = _hyp(x, r1 - x, c1 - x, n - r1 - c1 + x)
        if p <= p0 * (1 + 1e-9): two += p
        if x >= a: gt += p
    return min(1.0, two), min(1.0, gt)

def med(v):
    v = sorted(x for x in v if x is not None)
    if not v: return None
    m = len(v) // 2
    return round(v[m] if len(v) % 2 else (v[m - 1] + v[m]) / 2, 2)

def stats(rows, flag_key='flag', lead_key='lead_h', testable_key='testable'):
    """rows: per-token dicts with cohort, flag(bool), lead_h (hours before peak/dump, + = before), testable(bool)."""
    T = [r for r in rows if r.get(testable_key, True)]
    D = [r for r in T if r['cohort'] == 'died']; M = [r for r in T if r['cohort'] == 'mooned']
    a = sum(1 for r in D if r.get(flag_key)); c = sum(1 for r in M if r.get(flag_key))
    p2, pg = fisher(a, len(D) - a, c, len(M) - c) if D and M else (None, None)
    hd = a / len(D) if D else None; hm = c / len(M) if M else None
    leads = [r.get(lead_key) for r in D if r.get(flag_key) and r.get(lead_key) is not None]
    return {'n_crashed': len(D), 'n_runners': len(M), 'flag_crashed': a, 'flag_runners': c,
            'hit_crashed': round(hd, 3) if hd is not None else None, 'hit_runners': round(hm, 3) if hm is not None else None,
            'false_flag_rate': round(hm, 3) if hm is not None else None,
            'precision': round(a / (a + c), 3) if a + c else None,
            'lift': round(hd / hm, 2) if hd is not None and hm else None,
            'p_fisher': round(p2, 4) if p2 is not None else None, 'p_fisher_one_sided': round(pg, 4) if pg is not None else None,
            'lead_h_median': med(leads), 'lead_h_all': sorted(round(x, 1) for x in leads), 'n_untestable': len(rows) - len(T)}

# ---------------- Nansen (guarded) ----------------
NCOST = {'account': 0, 'tgm/dex-trades': 1, 'tgm/who-bought-sold': 1, 'tgm/transfers': 1, 'profiler/address/first-funder': 1,
         'profiler/address/transactions': 1, 'profiler/address/related-wallets': 1, 'tgm/flow-intelligence': 1}
FLOOR = 300
LEDGER = os.path.join(DATA_DIR, 'patternlab_nansen_ledger.json')
NL = {'calls': [], 'used': 0.0, 'balance_start': None, 'remaining': None, 'refused': []}
try: NL.update(json.load(open(LEDGER)))
except Exception: pass
RUN = {'used': 0.0}
class NansenStop(Exception): pass

def _nsave(): json.dump(NL, open(LEDGER + '.tmp', 'w')); os.replace(LEDGER + '.tmp', LEDGER)

def _raw(ep, body):
    req = urllib.request.Request('https://api.nansen.ai/api/v1/' + ep, data=json.dumps(body).encode() if body is not None else None,
                                 method='POST' if body is not None else 'GET',
                                 headers={'apikey': _NKEY, 'content-type': 'application/json', 'accept': 'application/json'})
    for k in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, r.headers, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429 and k < 3: time.sleep(6 * (k + 1)); continue
            try: j = json.loads(e.read().decode()[:2000])
            except Exception: j = {'error': 'http %s' % e.code}
            return e.code, e.headers, j
        except Exception as e:
            if k < 3: time.sleep(4); continue
            return None, {}, {'error': str(e)[:200]}

def balance():
    st, h, j = _raw('account', None)
    if st == 200 and isinstance(j, dict) and j.get('credits_remaining') is not None:
        NL['remaining'] = float(j['credits_remaining'])
        if NL['balance_start'] is None: NL['balance_start'] = NL['remaining']
        _nsave()
    return NL['remaining']

def nansen(ep, body, run_cap, purpose=''):
    """cached + ledgered call. returns json (or None). raises NansenStop on cap/floor."""
    key = ep + '|' + json.dumps(body, sort_keys=True)
    f = os.path.join(CACHE, 'nansen'); os.makedirs(f, exist_ok=True)
    f = os.path.join(f, ep.replace('/', '_') + '_' + hashlib.sha1(key.encode()).hexdigest()[:20] + '.json')
    if os.path.exists(f): return json.load(open(f))
    cost = NCOST.get(ep)
    if not _NKEY: raise NansenStop('NANSEN_API_KEY not set')
    if cost is None or cost >= 100:
        NL['refused'].append({'ep': ep, 'why': 'unknown or >=100-credit endpoint (proposal only)'}); _nsave(); return None
    if RUN['used'] + cost > run_cap: raise NansenStop(f'run cap {run_cap} reached')
    before = NL['remaining'] if NL['remaining'] is not None else balance()
    if before is not None and before - max(cost, 1) < FLOOR: raise NansenStop(f'balance {before} would cross floor {FLOOR}')
    st, h, j = _raw(ep, body)
    used = float((h.get('x-nansen-credits-used') if h else 0) or 0); quoted = (h.get('x-nansen-credits-cost') if h else None)
    rem = h.get('x-nansen-credits-remaining') if h else None
    if rem is not None: NL['remaining'] = float(rem)
    RUN['used'] += used; NL['used'] += used
    NL['calls'].append({'t': int(time.time()), 'ep': ep, 'purpose': purpose, 'status': st, 'quoted_cost': quoted, 'credits_used': used,
                        'balance_before': before, 'balance_after': NL['remaining']})
    _nsave()
    log(f'nansen {ep} [{purpose}] status={st} used={used} quoted={quoted} balance {before} -> {NL["remaining"]}')
    if quoted is not None and float(quoted) >= 100: raise NansenStop(f'{ep} quoted {quoted} credits — stopping')
    time.sleep(1.1)
    if st == 200:
        json.dump(j, open(f, 'w')); return j
    return {'_error': st, 'detail': j}
