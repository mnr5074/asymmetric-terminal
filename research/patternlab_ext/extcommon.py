"""Pattern Lab EXPANSION (rules 38+, categories A-J) shared helpers.
Reuses research/patternlab/plcommon.py (test set, Fisher, stats) and research/patterns_common.py (throttled free HTTP, GT hourly).
Datasets:
  core50 : the shared 50-token test set (30 crashed 'died' + 20 runners 'mooned'), plcommon.test_set()
  full   : every research-DB token with cohort died/mooned (111 + 62) + GeckoTerminal hourly OHLCV (cached/free)
  labeled: data/events_labeled.json (backtest worker) when present
Both directions are scored for every rule: CRASH (flag rate crashed > runners) and PUMP (flag rate runners > crashed), each with
one-sided Fisher p, hit rates, false-flag rate and lead times (crash: hours before dump; pump: hours before peak).
Nansen: own soft budget (EXT_CAP=200 credits), own ledger data/patternlab_ext_nansen_ledger.json (balance before/after per call),
reads data/nansen_cache.json + Pattern Lab cache (data/patternlab_cache/nansen) before spending; floor 300; refuses >=100-credit calls."""
import json, os, sys, time, hashlib, sqlite3, glob, math
HERE = os.path.dirname(os.path.abspath(__file__))
_NKEY = os.environ.get('NANSEN_API_KEY', '')
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'patternlab'))
sys.path.insert(0, os.path.dirname(HERE))
import plcommon as P  # noqa
import patterns_common as PC  # noqa
DATA_DIR = PC.DATA_DIR
log = PC.log
CACHE = os.path.join(DATA_DIR, 'patternlab_ext_cache'); os.makedirs(CACHE, exist_ok=True)
fisher, med, iso, jload = P.fisher, P.med, P.iso, P.jload

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

# ---------------- datasets ----------------
_CORE = None
def core50():
    global _CORE
    if _CORE is None: _CORE = P.test_set()
    return _CORE

def _dump_t(ohlcv, peak_t):
    if not ohlcv: return None
    pk = max(ohlcv, key=lambda r: r[2])
    for r in ohlcv:
        if r[0] > pk[0] and r[4] <= 0.7 * pk[2]: return r[0]
    return None

_FULL = None
def full(fetch=False):
    """all DB died+mooned tokens (Solana + EVM). ohlcv from GT cache; fetch=True pulls missing ones (free, throttled)."""
    global _FULL
    if _FULL is not None: return _FULL
    db = sqlite3.connect(f'file:{P.DB}?mode=ro', uri=True); db.row_factory = sqlite3.Row
    core = {x['mint']: x for x in core50()}
    out = []
    for r in db.execute("select * from tokens where cohort in ('died','mooned') and main_pool is not null"):
        r = dict(r)
        if r['mint'] in core: out.append(core[r['mint']]); continue
        chain = r.get('chain') or 'solana'; net = {'solana': 'solana', 'base': 'base', 'bsc': 'bsc', 'ethereum': 'eth', 'eth': 'eth'}.get(chain, chain)
        rows = []
        for f in glob.glob(os.path.join(DATA_DIR, 'patterns_cache', 'gt_hour', f'{net}_{r["main_pool"]}_*.json')):
            try: rr = json.load(open(f)).get('rows') or []
            except Exception: rr = []
            if len(rr) > len(rows): rows = rr
        if not rows and fetch:
            try: rows = (PC.gt_hourly(net, r['main_pool'], before_ts=None) or {}).get('rows') or []
            except Exception as e: log('gt fail', r['symbol'], e)
        peak_t = (r.get('peak_ts') or 0) // 1000 or None
        hs = db.execute('select owner,pct from top_holders where mint=? order by pct desc', (r['mint'],)).fetchall()
        x = {'mint': r['mint'], 'symbol': r['symbol'], 'cohort': r['cohort'], 'crashed': r['cohort'] == 'died', 'chain': chain,
             'peak_t': peak_t, 'created_t': (r.get('created_ts') or 0) // 1000 or None, 'db': r, 'holders': [(h[0], h[1]) for h in hs],
             'wallets': [], 'pool': r['main_pool'], 'ohlcv': rows}
        if rows and not peak_t: x['peak_t'] = max(rows, key=lambda q: q[2])[0]
        x['dump_t'] = _dump_t(rows, x['peak_t'])
        out.append(x)
    for x in out:
        x['peak_t'] = int(x['peak_t']) if x.get('peak_t') else None
        x['dump_t'] = int(x['dump_t']) if x.get('dump_t') else None
    _FULL = out
    return out

def labeled():
    j = jload('events_labeled.json')
    if not j: return None
    return j.get('events') or j.get('items') or j.get('tokens') or (j if isinstance(j, list) else None)

# ---------------- two-direction stats ----------------
def base(t):
    """per-token reference times: peak, dump (crash break / first close <=70% of peak), breakout (created + hours_to_2x, Pattern Lab def)."""
    h2 = (t.get('db') or {}).get('hours_to_2x'); ct = t.get('created_t')
    bo = int(ct + h2 * 3600) if ct and h2 is not None else t.get('peak_t')
    return {'cohort': t['cohort'], 'peak_t': t.get('peak_t'), 'dump_t': t.get('dump_t'), 'breakout_t': bo, 'symbol': t.get('symbol'), 'mint': t.get('mint')}

def stats2(rows):
    """rows: {cohort, flag, testable, flag_t (unix)}, plus peak_t/dump_t. Returns crash-direction + pump-direction stats."""
    T = [r for r in rows if r.get('testable', True)]
    D = [r for r in T if r['cohort'] == 'died']; M = [r for r in T if r['cohort'] == 'mooned']
    a = sum(1 for r in D if r.get('flag')); c = sum(1 for r in M if r.get('flag'))
    nD, nM = len(D), len(M)
    if nD and nM: p2, pg = fisher(a, nD - a, c, nM - c); _, pl = fisher(c, nM - c, a, nD - a)
    else: p2 = pg = pl = None
    def lead(r, ref):
        t = r.get(ref); f = r.get('flag_t')
        return round((t - f) / 3600, 1) if t and f else None
    crash_leads = [lead(r, 'dump_t') for r in D if r.get('flag')]
    pump_leads = [lead(r, 'peak_t') for r in M if r.get('flag')]
    bo_leads = [lead(r, 'breakout_t') for r in M if r.get('flag')]
    hd = a / nD if nD else None; hm = c / nM if nM else None
    rd = lambda v: round(v, 3) if v is not None else None
    out = {'n_crashed': nD, 'n_runners': nM, 'flag_crashed': a, 'flag_runners': c, 'hit_crashed': rd(hd), 'hit_runners': rd(hm),
           'p_fisher': round(p2, 4) if p2 is not None else None, 'n_untestable': len(rows) - len(T),
           'crash': {'hit_rate': rd(hd), 'false_flag_rate': rd(hm), 'precision': rd(a / (a + c)) if a + c else None,
                     'p_one_sided': round(pg, 4) if pg is not None else None, 'lead_h_median': med(crash_leads), 'lead_h_all': sorted(x for x in crash_leads if x is not None)},
           'pump': {'hit_rate': rd(hm), 'false_flag_rate': rd(hd), 'precision': rd(c / (a + c)) if a + c else None,
                    'p_one_sided': round(pl, 4) if pl is not None else None, 'lead_h_median': med(pump_leads), 'lead_h_all': sorted(x for x in pump_leads if x is not None),
                    'lead_vs_breakout_h_median': med(bo_leads)}}
    # Pattern Lab (patternlab_backtest.json stats) compatible aliases
    out.update({'p_crash_one_sided': out['crash']['p_one_sided'], 'p_pump_one_sided': out['pump']['p_one_sided'],
                'lead_crash_h_median': out['crash']['lead_h_median'], 'lead_pump_h_median': out['pump']['lead_vs_breakout_h_median'],
                'lead_pump_vs_peak_h_median': out['pump']['lead_h_median'],
                'false_flag_rate_as_crash_signal': rd(hm), 'false_flag_rate_as_pump_signal': rd(hd)})
    v = 'untestable' if p2 is None else 'crash-predictive (p<0.05)' if (pg or 1) < 0.05 else 'pump-predictive (p<0.05)' if (pl or 1) < 0.05 else 'weak' if min(pg, pl) < 0.15 else 'no separation'
    out['verdict'] = v
    if p2 is not None and p2 < 0.05: out['separates'] = 'crash' if hd > hm else 'pump'
    elif p2 is not None and p2 < 0.15: out['separates'] = ('crash' if hd > hm else 'pump') + ' (weak, p<0.15)'
    else: out['separates'] = 'no'
    return out

def row(id, name, status, why, explain, core=None, full=None, live=None, extra=None, wraps=None):
    """Pattern Lab row (schema documented in PATTERN_LAB_EXT.md)."""
    r = {'id': id, 'name': name, 'status': status, 'status_why': why, 'explain': explain, 'wraps': wraps or [],
         'backtest': {'core50': core, 'full': full}, 'live_flags': live or [], 'n_live_flags': len(live or [])}
    b = core or full
    if b:
        r.update({'hit_crashed': b['hit_crashed'], 'hit_runners': b['hit_runners'], 'p_fisher': b['p_fisher'], 'separates': b['separates'],
                  'crash_lead_h': b['crash']['lead_h_median'], 'pump_lead_h': b['pump']['lead_h_median'],
                  'false_flag_rate_crash': b['crash']['false_flag_rate'], 'false_flag_rate_pump': b['pump']['false_flag_rate']})
    if extra: r['extra'] = extra
    return r

# ---------------- Nansen (guarded, own budget) ----------------
EXT_CAP = float(os.environ.get('EXT_NANSEN_CAP', 200)); FLOOR = 300
LEDGER = os.path.join(DATA_DIR, 'patternlab_ext_nansen_ledger.json')
NL = {'calls': [], 'used': 0.0, 'balance_start': None, 'remaining': None, 'refused': [], 'cache_hits': 0, 'cap': EXT_CAP}
try: NL.update(json.load(open(LEDGER)))
except Exception: pass
class NansenStop(Exception): pass
def _nsave(): json.dump(NL, open(LEDGER + '.tmp', 'w')); os.replace(LEDGER + '.tmp', LEDGER)
NCOST = dict(P.NCOST)
_SHARED = None
def _shared():
    global _SHARED
    if _SHARED is None:
        try: _SHARED = json.load(open(os.path.join(DATA_DIR, 'nansen_cache.json')))
        except Exception: _SHARED = {}
    return _SHARED

def nbalance():
    st, h, j = P._raw('account', None)
    if st == 200 and isinstance(j, dict) and j.get('credits_remaining') is not None:
        NL['remaining'] = float(j['credits_remaining'])
        if NL['balance_start'] is None: NL['balance_start'] = NL['remaining']
        _nsave()
    return NL['remaining']

def nansen(ep, body, purpose='', cache_only=False):
    key = ep + '|' + json.dumps(body, sort_keys=True)
    fname = ep.replace('/', '_') + '_' + hashlib.sha1(key.encode()).hexdigest()[:20] + '.json'
    mine = os.path.join(CACHE, 'nansen', fname); os.makedirs(os.path.dirname(mine), exist_ok=True)
    theirs = os.path.join(P.CACHE, 'nansen', fname)
    for f in (mine, theirs):
        if os.path.exists(f):
            NL['cache_hits'] += 1
            return json.load(open(f))
    sh = _shared().get(ep + '|' + json.dumps(body, separators=(',', ':')))
    if sh and 'v' in sh: NL['cache_hits'] += 1; return sh['v']
    if cache_only: return None
    if not P._NKEY: raise NansenStop('NANSEN_API_KEY not set')
    cost = NCOST.get(ep)
    if cost is None or cost >= 100:
        NL['refused'].append({'ep': ep, 'purpose': purpose, 'why': 'unknown or >=100-credit endpoint (proposal only)'}); _nsave(); return None
    if NL['used'] + cost > EXT_CAP: raise NansenStop(f'ext soft budget {EXT_CAP} reached (used {NL["used"]})')
    before = nbalance()
    if before is None: raise NansenStop('cannot read balance')
    if before - max(cost, 1) < FLOOR: raise NansenStop(f'balance {before} would cross floor {FLOOR}')
    st, h, j = P._raw(ep, body)
    used = float((h.get('x-nansen-credits-used') if h else 0) or 0); quoted = h.get('x-nansen-credits-cost') if h else None
    rem = h.get('x-nansen-credits-remaining') if h else None
    after = float(rem) if rem is not None else None
    if after is not None: NL['remaining'] = after
    NL['used'] += used
    NL['calls'].append({'t': int(time.time()), 'ep': ep, 'purpose': purpose, 'status': st, 'quoted_cost': quoted, 'credits_used': used,
                        'balance_before': before, 'balance_after': after})
    _nsave()
    log(f'nansen {ep} [{purpose}] status={st} used={used} balance {before} -> {after}')
    if quoted is not None and float(quoted) >= 100: raise NansenStop(f'{ep} quoted {quoted} credits — stopping')
    time.sleep(1.1)
    if st == 200:
        json.dump(j, open(mine, 'w'))
        try:  # share with the Pattern Lab cache so the other worker never pays twice for the same body
            if not os.path.exists(theirs): json.dump(j, open(theirs, 'w'))
        except Exception: pass
        return j
    return {'_error': st, 'detail': j}
