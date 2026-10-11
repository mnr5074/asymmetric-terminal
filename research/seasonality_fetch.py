#!/usr/bin/env python3
"""Session-seasonality data fetcher (free, no keys): Binance public kline archives from data.binance.vision.
Monthly zips for full months, daily zips for the current month. Cached raw zips -> parsed parquet-free .npz per symbol/interval in
data/seasonality_cache/. Columns: open_ms, open, high, low, close, base_vol, quote_vol(USDT), trades.
Binance spot archives switched open_time to MICROseconds from 2025-01; normalised to ms here."""
import io, os, sys, time, zipfile, urllib.request, urllib.error, datetime as dt
from concurrent.futures import ThreadPoolExecutor
import numpy as np
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data')
CACHE = os.path.join(DATA_DIR, 'seasonality_cache')
BASE = 'https://data.binance.vision/data/spot'
HOURLY = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'NEARUSDT', 'ZECUSDT', 'STRKUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT', 'ADAUSDT', 'WIFUSDT', 'PEPEUSDT', 'BONKUSDT']
FIVEM = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'NEARUSDT', 'ZECUSDT', 'STRKUSDT']
H_START, M5_START = (2021, 1), (2024, 10)
log = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)

def get(url, path):
    if os.path.exists(path): return open(path, 'rb').read() if os.path.getsize(path) else None
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'asymmetric-terminal research'}), timeout=60) as r: b = r.read()
            open(path, 'wb').write(b); return b
        except urllib.error.HTTPError as e:
            if e.code == 404: open(path, 'wb').close(); return None  # not listed yet (pre-listing month): cache the miss
            time.sleep(2 * (i + 1))
        except Exception: time.sleep(2 * (i + 1))
    return None

def months(start, end):
    y, m = start
    while (y, m) <= end:
        yield y, m; m += 1
        if m == 13: y, m = y + 1, 1

def parse(b):
    if not b: return None
    with zipfile.ZipFile(io.BytesIO(b)) as z: txt = z.read(z.namelist()[0]).decode()
    rows = [l.split(',') for l in txt.strip().splitlines() if l and l[0].isdigit()]
    a = np.array([[float(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5]), float(r[7]), float(r[8])] for r in rows])
    if len(a): a[:, 0] = np.where(a[:, 0] > 1e14, a[:, 0] / 1000, a[:, 0])
    return a

def fetch(sym, iv, start):
    raw = os.path.join(CACHE, 'raw', iv, sym); os.makedirs(raw, exist_ok=True)
    today = dt.datetime.now(dt.timezone.utc).date()
    last_full = (today.year, today.month - 1) if today.month > 1 else (today.year - 1, 12)
    jobs = [(f'{BASE}/monthly/klines/{sym}/{iv}/{sym}-{iv}-{y}-{m:02d}.zip', os.path.join(raw, f'{y}-{m:02d}.zip')) for y, m in months(start, last_full)]
    # current month: daily archives (published with ~1 day lag); re-try today-1 misses on later runs
    d = today.replace(day=1)
    while d < today:
        p = os.path.join(raw, f'd{d.isoformat()}.zip')
        if os.path.exists(p) and os.path.getsize(p) == 0 and (today - d).days <= 2: os.remove(p)
        jobs.append((f'{BASE}/daily/klines/{sym}/{iv}/{sym}-{iv}-{d.isoformat()}.zip', p)); d += dt.timedelta(days=1)
    with ThreadPoolExecutor(6) as ex: blobs = list(ex.map(lambda j: get(*j), jobs))
    parts = [p for p in (parse(b) for b in blobs) if p is not None and len(p)]
    if not parts: return 0
    a = np.concatenate(parts); a = a[np.argsort(a[:, 0])]; a = a[np.concatenate([[True], np.diff(a[:, 0]) > 0])]
    np.save(os.path.join(CACHE, f'{sym}_{iv}.npy'), a)
    return len(a)

if __name__ == '__main__':
    for s in HOURLY: log(s, '1h', fetch(s, '1h', H_START))
    if '--no5m' not in sys.argv:
        for s in FIVEM: log(s, '5m', fetch(s, '5m', M5_START))
    log('done')
