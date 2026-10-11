"""Historical universe for replays: every daily series we have on disk, labelled for BOTH claims.
Sources: data/cg_series/*.json (CoinGecko 365d daily, catalog + launchpad coins) and data/crash_series/*.json (Binance daily, the
big historical crash cases). Labels come from the series itself so every detector is scored on identical ground truth:
  crash day   = first day the close is <= 30% of the running peak close (a 70% drawdown, same bar as the crash catalog)
  pump day    = first day the close is >= 3x the lowest close of the previous 30 days (a breakout); pump5 = >= 5x the 60-day low
  crashed     = has a crash day
  runner      = never crashed, peak >= 5x the pre-peak low, and the last close is still >= 50% of the peak
A token can pump and later crash (pump-and-dump), so 'predicts pump' and 'predicts crash' are scored as separate claims.
"""
import json, os, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DATA_DIR = os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data')
J = lambda f: json.load(open(os.path.join(DATA_DIR, f))) if os.path.exists(os.path.join(DATA_DIR, f)) else None

def _cg(path):
    d = json.load(open(path)); px = d.get('prices') or []; vol = {t: v for t, v in d.get('total_volumes') or []}
    out = {}
    for t, p in px:
        if p: out[dt.datetime.fromtimestamp(t / 1000, dt.timezone.utc).date().isoformat()] = (p, vol.get(t) or 0)
    days = sorted(out); return days, [out[x][0] for x in days], [out[x][1] for x in days]

def _bn(path):
    d = json.load(open(path)); days, px, vol = d[0], d[1], d[2] if len(d) > 2 else [0] * len(d[0])
    return list(days), [float(x) for x in px], [float(x or 0) for x in vol]

def label(px):
    peak, peak_i, crash_i = 0, None, None
    for i, p in enumerate(px):
        if p > peak: peak, peak_i = p, i
        elif crash_i is None and peak and p <= 0.3 * peak: crash_i = i
    if crash_i is not None: return 'crashed', crash_i, peak_i
    if not px: return 'other', None, None
    mx_i = max(range(len(px)), key=lambda i: px[i]); lo = min(px[:mx_i + 1]) or 1e-18
    if px[mx_i] / lo >= 5 and px[-1] >= 0.5 * px[mx_i]: return 'runner', None, mx_i
    return 'other', None, mx_i

def pump_day(px, mult=3.0, win=30, start=1):
    for i in range(max(1, start), len(px)):
        lo = min(px[max(0, i - win):i])
        if lo > 0 and px[i] >= mult * lo: return i
    return None

def load():
    cat = J('crash_catalog.json') or {}; ids = {x['id']: x for x in cat.get('catalog', [])}
    toks = []
    for sub, fn in (('cg_series', _cg), ('crash_series', _bn)):
        d = os.path.join(DATA_DIR, sub)
        if not os.path.isdir(d): continue
        for f in sorted(os.listdir(d)):
            if not f.endswith('.json'): continue
            try: days, px, vol = fn(os.path.join(d, f))
            except Exception: continue
            if len(px) < 120: continue
            tid = f[:-5]; c = ids.get(tid) or {}
            sym = (tid.split('USDT')[0] if sub == 'crash_series' else (c.get('symbol') or tid)).upper()
            lab, ci, pi = label(px)
            toks.append({'id': tid, 'src': sub, 'symbol': sym, 'name': c.get('name') or sym, 'in_catalog': tid in ids or sub == 'crash_series', 'days': days, 'px': px, 'vol': vol,
                         'label': lab, 'crash_i': ci, 'peak_i': pi, 'pump_i': pump_day(px), 'pump5_i': pump_day(px, 5.0, 60)})
    return toks

def catalog_size():
    cat = J('crash_catalog.json') or {}; fin = J('crash_catalog_final.json') or {}
    return {'crash_catalog': len(cat.get('catalog', [])), 'final_coingecko_coins': len(fin.get('coingecko_coins', [])), 'eco_tokens_ranked': len(fin.get('eco_tokens_ranked', [])),
            'forensics': len(fin.get('forensics', []))}
