#!/usr/bin/env python3
"""Session seasonality (trading-session windows, day-of-week, US holidays) for majors and pooled catalog DEX tokens.
Free data only (no Nansen / X): Binance public kline archives (data.binance.vision, via research/seasonality_fetch.py) and the
GeckoTerminal hourly OHLCV already cached by the crash-hour detector (research/patterns_hours.py -> data/patterns_cache/gt_hour).
REUSES detector 1: crash events (peak, onset hour) come from data/patterns_hours.json; nothing about onset detection is redefined here.

Windows are defined in LOCAL exchange time with IANA zones (zoneinfo), so DST is handled per date (e.g. US open = 13:30 UTC in
summer, 14:30 UTC in winter; London/NY DST mismatch weeks are handled). A bar belongs to a window only if the whole bar interval
lies inside it, so half-hour windows (US open 30/60 min, pre-market end 09:30) are measured on 5m bars; on 1h bars they are
either skipped or replaced by an explicitly labelled hourly proxy (us_open_bar = the 09:00-10:00 NY bar that contains the open).

Per window (in-window bars vs out-of-window bars of the same token):
  return: mean/median bar return (bps) and per-occurrence window return (sum of log returns over one window instance)
  volatility: realised per-hour vol (bps) and vol ratio = sqrt(mean z^2 in / mean z^2 out), z = return / trailing 30d sigma (regime-free)
  volume share: share of each day's quote volume inside the window / share of the day's bars inside it (intensity, 1 = proportional)
  skew of z, tail-event frequency (|z| > 2, up/down separately) and tail ratio in vs out
Significance: day-block bootstrap (resample whole UTC days, B=2000) for ratios; occurrence bootstrap for mean window return;
Kruskal-Wallis across an exclusive session partition; Benjamini-Hochberg FDR across every per-window test.
Event clustering: catalog crash onsets (detector 1) and runner breakouts vs exposure-weighted baselines (each event's own candidate
bars, by time and by volume), Poisson-binomial exact p, BH-corrected. Output: data/seasonality.json (+ data/seasonality_live.json profile)."""
import glob, json, math, os, sys, time
import datetime as dt
import numpy as np, pandas as pd
from patterns_common import DATA_DIR, CACHE as PCACHE, chi2_sf, log, save
SCACHE = os.path.join(DATA_DIR, 'seasonality_cache')
B = 2000
ZCLIP = 10  # z winsorised at +-10 for variance/skew (a single bad print with a tiny trailing sigma would otherwise dominate); tail counts use raw z
RNG = np.random.default_rng(20261011)
NY, LDN, TYO, HKG = 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Asia/Hong_Kong'
# NYSE full-day closures (nyse.com holiday schedule; 2025-01-09 national day of mourning). Early 13:00 closes are NOT modelled.
NYSE_HOLIDAYS = ['2021-01-01', '2021-01-18', '2021-02-15', '2021-04-02', '2021-05-31', '2021-07-05', '2021-09-06', '2021-11-25', '2021-12-24',
                 '2022-01-17', '2022-02-21', '2022-04-15', '2022-05-30', '2022-06-20', '2022-07-04', '2022-09-05', '2022-11-24', '2022-12-26',
                 '2023-01-02', '2023-01-16', '2023-02-20', '2023-04-07', '2023-05-29', '2023-06-19', '2023-07-04', '2023-09-04', '2023-11-23', '2023-12-25',
                 '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
                 '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
                 '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
                 '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']
W = lambda id, label, tz, s, e, days, **k: dict(id=id, label=label, tz=tz, start=s, end=e, days=days, **k)
WINDOWS = [
    W('asia_tokyo', 'Asia: Tokyo stock session (09:00-15:00 Tokyo)', TYO, 540, 900, 'local_weekday'),
    W('asia_hk_sg', 'Asia: Hong Kong / Singapore session (09:30-16:00 local)', HKG, 570, 960, 'local_weekday'),
    W('london_open', 'London open (08:00-09:00 London)', LDN, 480, 540, 'local_weekday'),
    W('london_close', 'London close (16:00-17:00 London, around the 16:30 auction)', LDN, 960, 1020, 'local_weekday'),
    W('us_premarket', 'US pre-market (04:00-09:30 New York)', NY, 240, 570, 'nyse'),
    W('us_open_30', 'US open, first 30 minutes (09:30-10:00 New York)', NY, 570, 600, 'nyse'),
    W('us_open_60', 'US open, first hour (09:30-10:30 New York)', NY, 570, 630, 'nyse'),
    W('us_open_bar', 'US open hour bar (09:00-10:00 New York, hourly proxy that contains the 09:30 open)', NY, 540, 600, 'nyse', res_only=60),
    W('us_midday', 'US midday lull (11:30-14:00 New York)', NY, 690, 840, 'nyse'),
    W('us_close', 'US close, last hour (15:00-16:00 New York)', NY, 900, 960, 'nyse'),
    W('us_afterhours', 'US after-hours (16:00-20:00 New York)', NY, 960, 1200, 'nyse'),
    W('us_holiday', 'US market holiday (NYSE shut on a weekday, whole New York day)', NY, 0, 1440, 'nyse_holiday'),
    W('cme_gap', 'CME futures weekend gap (Fri 17:00 - Sun 18:00 New York)', NY, 0, 1440, 'cme_gap'),
    W('weekend_utc', 'Weekend dead zone (Saturday and Sunday, UTC)', 'UTC', 0, 1440, 'weekend'),
] + [W(f'dow_{k}', f'{n} (UTC day)', 'UTC', 0, 1440, f'dow:{k}') for k, n in enumerate(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])]
WBY = {w['id']: w for w in WINDOWS}
PARTITION = ['weekend_utc', 'us_holiday', 'us_open_60', 'us_premarket', 'us_midday', 'us_close', 'us_afterhours', 'london_open', 'london_close', 'asia_tokyo']
_HOL = None

def membership(t_ms, res, w):
    """bool mask: bar [t, t+res) entirely inside window w (DST-correct local time)."""
    global _HOL
    if w.get('res_only') and w['res_only'] != res: return None
    idx = pd.to_datetime(t_ms, unit='ms', utc=True)
    loc = idx.tz_convert(w['tz']) if w['tz'] != 'UTC' else idx
    m = (loc.hour * 60 + loc.minute).values; wd = loc.weekday.values; e = m + res
    d = w['days']
    if d == 'cme_gap': return ((wd == 4) & (m >= 1020)) | (wd == 5) | ((wd == 6) & (e <= 1080))
    inside = (m >= w['start']) & (e <= w['end'])
    if d == 'weekend': return inside & (wd >= 5)
    if d.startswith('dow:'): return inside & (wd == int(d[4:]))
    if d == 'local_weekday': return inside & (wd < 5)
    if _HOL is None: _HOL = set(NYSE_HOLIDAYS)
    hol = np.array([x in _HOL for x in loc.strftime('%Y-%m-%d')])
    if d == 'nyse': return inside & (wd < 5) & ~hol
    if d == 'nyse_holiday': return inside & (wd < 5) & hol
    raise ValueError(d)

def prep(a, res, trail, min_trail, skip_head=0):
    t = a[:, 0].astype(np.int64); c = a[:, 4]; qv = a[:, 6]
    r = np.full(len(a), np.nan)
    ok = (np.diff(t) == res * 60000) & (c[:-1] > 0) & (c[1:] > 0)
    r[1:][ok] = np.log(c[1:][ok] / c[:-1][ok])
    s = pd.Series(r).rolling(trail, min_periods=min_trail).std().shift(1).values
    with np.errstate(invalid='ignore', divide='ignore'): z = r / s
    # volume normalised by its own trailing mean (same window as sigma), so whole-day windows (weekend, DOW) can show volume effects
    vm = pd.Series(qv).rolling(trail, min_periods=min_trail).mean().shift(1).values
    with np.errstate(invalid='ignore', divide='ignore'): vn = qv / vm
    valid = np.isfinite(z) & (s > 0) & np.isfinite(vn)
    if skip_head: valid[:skip_head] = False
    return {'t': t, 'r': r, 'z': z, 's': s, 'qv': qv, 'vn': vn, 'valid': valid, 'res': res, 'day': t // 86400000}

def skew(x, clip=None):
    x = x[np.isfinite(x)]
    if clip: x = np.clip(x, -clip, clip)
    if len(x) < 20: return None
    m = x.mean(); sd = x.std()
    return float(((x - m) ** 3).mean() / sd ** 3) if sd > 0 else None

def bh(ps):
    ps = np.asarray(ps, float); n = len(ps)
    if not n: return []
    o = np.argsort(ps); q = np.empty(n); prev = 1.0
    for rank, i in reversed(list(enumerate(o, 1))): prev = min(prev, ps[i] * n / rank); q[i] = prev
    return q.tolist()

def kruskal(groups):
    groups = [g[np.isfinite(g)] for g in groups if len(g[np.isfinite(g)]) >= 5]
    if len(groups) < 2: return None
    allv = np.concatenate(groups); N = len(allv)
    rk = pd.Series(allv).rank().values; H, i0 = 0.0, 0
    for g in groups: R = rk[i0:i0 + len(g)].sum(); H += R * R / len(g); i0 += len(g)
    H = 12 / (N * (N + 1)) * H - 3 * (N + 1)
    _, cnt = np.unique(allv, return_counts=True); tie = 1 - ((cnt ** 3 - cnt).sum()) / (N ** 3 - N)
    H = H / tie if tie > 0 else H; k = len(groups)
    return {'H': round(float(H), 2), 'dof': k - 1, 'p': float(chi2_sf(float(H), k - 1)), 'N': int(N), 'epsilon2': round(float(max(0.0, (H - k + 1) / (N - k))), 5),
            'note': 'bars are serially dependent; treat p as optimistic and read epsilon2 (effect size) plus the day-block bootstrap'}

def daily_aggs(P, mask):
    """per-UTC-day additive sums for in-window and all bars (valid only)."""
    v = P['valid']; d = P['day'][v]; z = P['z'][v]; m = mask[v]; vn = P['vn'][v]
    days, inv = np.unique(d, return_inverse=True); D = len(days)
    bc = lambda w: np.bincount(inv, weights=w, minlength=D)
    zc = np.clip(z, -ZCLIP, ZCLIP); z2 = zc * zc; t2 = (np.abs(z) > 2).astype(float); up = (z > 2).astype(float); dn = (z < -2).astype(float); one = np.ones_like(z)
    return days, np.vstack([bc(one * m), bc(z2 * m), bc(t2 * m), bc(up * m), bc(dn * m), bc(one), bc(z2), bc(t2), bc(up), bc(dn), bc(vn * m), bc(vn)]).T

def ratios(A):
    """A: (..., 12) summed aggregates -> in-vs-out var ratio, tail ratios, volume intensity."""
    nin, s2in, tin, uin, din, nall, s2all, tall, uall, dall, vin, vall = np.moveaxis(A, -1, 0)
    nout = nall - nin
    with np.errstate(invalid='ignore', divide='ignore'):
        return {'vol_ratio': np.sqrt((s2in / nin) / ((s2all - s2in) / nout)), 'tail_ratio': (tin / nin) / ((tall - tin) / nout),
                'down_tail_ratio': (din / nin) / ((dall - din) / nout), 'up_tail_ratio': (uin / nin) / ((uall - uin) / nout), 'vol_intensity': (vin / nin) / ((vall - vin) / nout)}

def boot_p(rb, base=1.0):
    rb = rb[np.isfinite(rb)]
    if len(rb) < 100: return None
    return float(max(1 / len(rb), min(1.0, 2 * min((rb <= base).mean(), (rb >= base).mean()))))

_WCACHE = {}
def boot_weights(D):
    if D not in _WCACHE: _WCACHE[D] = RNG.multinomial(D, np.full(D, 1 / D), size=B).astype(np.float32)
    return _WCACHE[D]

def ratio_stats(days, A):
    pt = ratios(A.sum(0)); Wt = boot_weights(len(days)); Ab = (Wt @ A.astype(np.float32)).astype(float); rb = ratios(Ab)
    out = {}
    for k, v in pt.items():
        b = rb[k][np.isfinite(rb[k])]
        out[k] = None if not np.isfinite(v) else round(float(v), 3)
        out[k + '_ci95'] = [round(float(np.percentile(b, 2.5)), 3), round(float(np.percentile(b, 97.5)), 3)] if len(b) > 100 else None
        out[k + '_p'] = boot_p(rb[k])
    out['tail_rate_in'] = round(float(A[:, 2].sum() / A[:, 0].sum()), 4) if A[:, 0].sum() else None
    out['tail_rate_out'] = round(float((A[:, 7].sum() - A[:, 2].sum()) / (A[:, 5].sum() - A[:, 0].sum())), 4)
    out['time_share'] = round(float(A[:, 0].sum() / A[:, 5].sum()), 4)
    out['volume_share'] = round(float(A[:, 10].sum() / A[:, 11].sum()), 4)  # share of regime-normalised volume inside the window (compare with time_share)
    return out

def occurrences(P, mask, standardize):
    """contiguous runs of in-window bars -> per-occurrence return (raw log-return sum, or z-units for pooling)."""
    t, r, s, res = P['t'], P['r'], P['s'], P['res']
    idx = np.where(mask & np.isfinite(r))[0]
    if not len(idx): return np.array([])
    br = np.where((np.diff(idx) != 1) | (np.diff(t[idx]) != res * 60000))[0] + 1
    runs = np.split(idx, br); L = max(len(x) for x in runs)
    out = []
    for x in runs:
        if len(x) < 0.8 * L: continue
        v = r[x].sum()
        if standardize:
            if not (np.isfinite(s[x[0]]) and s[x[0]] > 0): continue
            v = v / (s[x[0]] * math.sqrt(len(x)))
        out.append(v)
    return np.array(out)

def occ_stats(o, scale):
    if len(o) < 10: return {'n': int(len(o))}
    m = o.mean(); idx = RNG.integers(0, len(o), size=(B, len(o))); mb = o[idx].mean(1)
    p = float(max(1 / B, (np.abs(mb - m) >= abs(m)).mean()))
    return {'n': int(len(o)), 'mean': round(float(m * scale), 3), 'median': round(float(np.median(o) * scale), 3), 'std': round(float(o.std() * scale), 3),
            'skew': None if skew(o) is None else round(skew(o), 3), 'pct_positive': round(float((o > 0).mean()), 3), 'mean_p': p}

def bar_stats(P, mask):
    v = P['valid'] & mask; r = P['r'][v]; z = P['z'][v]
    if len(r) < 20: return {'n_bars': int(len(r))}
    hr = math.sqrt(60 / P['res'])
    return {'n_bars': int(len(r)), 'mean_bps': round(float(r.mean() * 1e4), 3), 'median_bps': round(float(np.median(r) * 1e4), 3),
            'vol_per_hour_bps': round(float(np.sqrt((r * r).mean()) * hr * 1e4), 2), 'skew_z': None if skew(z, ZCLIP) is None else round(skew(z, ZCLIP), 3)}

def analyse_token(P, windows, raw=True, min_bars=20):
    out, aggs, occ = {}, {}, {}
    for w in windows:
        m = membership(P['t'], P['res'], w)
        if m is None or (m & P['valid']).sum() < min_bars: continue
        days, A = daily_aggs(P, m)
        st = {**bar_stats(P, m), **ratio_stats(days, A)}
        o_raw = occurrences(P, m, False); o_z = occurrences(P, m, True)
        st['occurrence_bps'] = occ_stats(o_raw, 1e4) if raw else None
        st['occurrence_z'] = occ_stats(o_z, 1)
        out[w['id']] = st; aggs[w['id']] = (days, A); occ[w['id']] = o_z
    # Kruskal-Wallis across exclusive partition
    lab = np.full(len(P['t']), 'other', dtype=object); taken = np.zeros(len(P['t']), bool)
    for wid in PARTITION:
        wid2 = 'us_open_bar' if (wid == 'us_open_60' and P['res'] == 60) else wid
        m = membership(P['t'], P['res'], WBY[wid2])
        if m is None: continue
        m = m & ~taken; lab[m] = wid2; taken |= m
    v = P['valid']; groups = sorted(set(lab[v]))
    kw = {'groups': groups, 'abs_z': kruskal([np.abs(P['z'][v & (lab == g)]) for g in groups]), 'z': kruskal([P['z'][v & (lab == g)] for g in groups])}
    return out, aggs, occ, kw

def pooled(agg_list, occ_list, zs_by_window, z_all=None):
    """sum per-day aggregates across tokens on the same UTC days (cross-token correlation kept by day-block bootstrap)."""
    out = {}
    for wid in sorted({k for a in agg_list for k in a}):
        frames = [a[wid] for a in agg_list if wid in a]
        alld = np.unique(np.concatenate([d for d, _ in frames])); A = np.zeros((len(alld), 12))
        for d, X in frames: A[np.searchsorted(alld, d)] += X
        st = ratio_stats(alld, A); st['n_tokens'] = len(frames)
        o = np.concatenate([x[wid] for x in occ_list if wid in x]) if any(wid in x for x in occ_list) else np.array([])
        st['occurrence_z'] = occ_stats(o, 1)
        z = zs_by_window.get(wid)
        if z is not None and len(z): st['skew_z'] = None if skew(z, ZCLIP) is None else round(skew(z, ZCLIP), 3); st['mean_z'] = round(float(np.clip(z, -ZCLIP, ZCLIP).mean()), 4); st['n_bars'] = int(len(z))
        if z_all is not None and len(z_all): st['mean_z_all_bars'] = round(float(np.clip(z_all, -ZCLIP, ZCLIP).mean()), 4)  # sample drift baseline
        out[wid] = st
    return out

def load_binance(sym, iv):
    f = os.path.join(SCACHE, f'{sym}_{iv}.npy')
    return np.load(f) if os.path.exists(f) else None

def run_majors(iv, res, syms):
    trail = 30 * 24 * 60 // res
    per, aggs, occs, zsw, cov, zall = {}, [], [], {}, {}, []
    for s in syms:
        a = load_binance(s, iv)
        if a is None or len(a) < trail * 2: continue
        P = prep(a, res, trail, trail // 2)
        o, ag, oc, kw = analyse_token(P, WINDOWS)
        sym = s.replace('USDT', '')
        per[sym] = {'windows': o, 'kruskal_wallis': kw}
        n_exp = (a[-1, 0] - a[0, 0]) / (res * 60000) + 1
        cov[sym] = {'start': dt.datetime.fromtimestamp(a[0, 0] / 1000, dt.timezone.utc).strftime('%Y-%m-%d %H:%M'), 'end': dt.datetime.fromtimestamp(a[-1, 0] / 1000, dt.timezone.utc).strftime('%Y-%m-%d %H:%M'),
                    'bars': int(len(a)), 'missing_bars': int(n_exp - len(a)), 'valid_z_bars': int(P['valid'].sum())}
        aggs.append(ag); occs.append(oc); zall.append(P['z'][P['valid']])
        for w in WINDOWS:
            m = membership(P['t'], res, w)
            if m is not None: zsw.setdefault(w['id'], []).append(P['z'][P['valid'] & m])
        log(iv, sym, 'done')
    zsw = {k: np.concatenate(v) for k, v in zsw.items()}
    return {'coverage': cov, 'per_token': per, 'pooled': pooled(aggs, occs, zsw, np.concatenate(zall) if zall else None)}

# ---------- catalog DEX tokens (GeckoTerminal cache written by detector 1) ----------
NET = {'solana': 'solana', 'base': 'base', 'bsc': 'bsc', 'robinhood': 'robinhood', 'ethereum': 'eth'}
def gt_rows(ev):
    net = NET.get(ev.get('chain'))
    if not net or not ev.get('pool'): return None
    fs = glob.glob(os.path.join(PCACHE, 'gt_hour', f"{net}_{ev['pool'].replace('/', '_')}_*.json"))
    best = None
    for f in fs:
        try: rows = [r for r in json.load(open(f)).get('rows', []) if r[4] and r[4] > 0]
        except Exception: continue
        if best is None or len(rows) > len(best): best = rows
    return best

def run_catalog(events):
    aggs, occs, zsw, used, nb, zall = [], [], {}, 0, 0, []
    wins = [w for w in WINDOWS if not w.get('res_only') or w['res_only'] == 60]
    for ev in events:
        rows = gt_rows(ev)
        if not rows or len(rows) < 120: continue
        a = np.array([[r[0] * 1000, r[1], r[2], r[3], r[4], r[5], r[5], 0] for r in rows], float)  # GT volume is already USD
        P = prep(a, 60, 168, 48, skip_head=24)
        if P['valid'].sum() < 60: continue
        o, ag, oc, _ = analyse_token(P, wins, raw=False, min_bars=1)  # pool every token-bar (a 20-bar floor would keep only long-lived tokens in 1h windows)
        aggs.append(ag); occs.append(oc); used += 1; nb += int(P['valid'].sum()); zall.append(P['z'][P['valid']])
        for w in wins:
            m = membership(P['t'], 60, w)
            if m is not None: zsw.setdefault(w['id'], []).append(P['z'][P['valid'] & m])
    zsw = {k: np.concatenate(v) for k, v in zsw.items()}
    return {'n_tokens': used, 'n_valid_bars': nb, 'pooled': pooled(aggs, occs, zsw, np.concatenate(zall) if zall else None),
            'note': 'GeckoTerminal free OHLCV: max 1000 hourly candles per call, fetched around each token\'s peak (peak-7d window), so the sample is a run-up/crash period, not steady-state trading; z uses a trailing 7-day sigma and the first 24h of each series is dropped; empty hours are absent (gaps break returns). Because the sample is selected around peaks, mean returns drift (see mean_z_all_bars): occurrence-mean tests vs zero are NOT session effects for this pool; use vol/tail/volume ratios (in vs out of window, same tokens) instead.'}

# ---------- event clustering vs exposure-weighted baselines ----------
def poibin_p(obs, ps):
    """exact Poisson-binomial two-sided p (sum of probs of outcomes no more likely than obs)."""
    dist = np.zeros(len(ps) + 1); dist[0] = 1.0
    for p in ps: dist[1:] = dist[1:] * (1 - p) + dist[:-1] * p; dist[0] *= (1 - p)
    return float(min(1.0, dist[dist <= dist[obs] * (1 + 1e-9)].sum()))

def cluster_test(items, wins):
    """items: [{t_event, cand_t: array, cand_v: array}] -> per window O, E (time and volume exposure), ratios, exact p."""
    out = {}
    for w in wins:
        if w.get('res_only') and w['res_only'] != 60: continue
        obs, pt, pv = 0, [], []
        for it in items:
            m = membership(it['cand_t'], 60, w); e = membership(np.array([it['t_event']]), 60, w)[0]
            obs += int(e); pt.append(m.mean()); vv = it['cand_v']; pv.append(float((vv * m).sum() / vv.sum()) if vv.sum() > 0 else m.mean())
        Et, Ev = sum(pt), sum(pv); n = len(items)
        if Et <= 0: continue  # window has no complete hourly bar (e.g. 30-min US open on 1h data): untestable, not counted in BH
        out[w['id']] = {'n': n, 'observed': obs, 'expected_time': round(Et, 2), 'ratio_time': round(obs / Et, 3) if Et else None, 'p_time': poibin_p(obs, pt),
                        'expected_volume': round(Ev, 2), 'ratio_volume': round(obs / Ev, 3) if Ev else None, 'p_volume': poibin_p(obs, pv)}
    ks = list(out)
    for kind in ('time', 'volume'):
        qs = bh([out[k]['p_' + kind] for k in ks])
        for k, q in zip(ks, qs): out[k]['q_' + kind] = q
    return out

def run_events():
    H = json.load(open(os.path.join(DATA_DIR, 'patterns_hours.json')))
    evs = H.get('events', [])
    crash_items, run_items, run_all3x, used = [], [], [], 0
    for ev in evs:
        rows = gt_rows(ev)
        if not rows: continue
        ts = np.array([r[0] for r in rows], np.int64) * 1000; c = np.array([r[4] for r in rows]); v = np.array([r[5] for r in rows])
        if ev.get('peak_t') is None: continue
        pi = np.searchsorted(ts, ev['peak_t'] * 1000)
        if pi >= len(ts) or ts[pi] != ev['peak_t'] * 1000: continue
        used += 1
        if ev.get('crash') and ev.get('onset_t'):
            pk = c[pi]; cross = next((j for j in range(pi + 1, len(ts)) if c[j] <= 0.5 * pk and ts[j] - ts[pi] <= 168 * 3600e3), None)
            if cross is not None:
                crash_items.append({'t_event': ev['onset_t'] * 1000, 'cand_t': ts[pi + 1:cross + 1], 'cand_v': v[pi + 1:cross + 1], 'cohort': ev['cohort'], 'excl_launch': not ev.get('peak_near_start')})
        # runner breakout: largest 1h close-to-close gain in the 168h before the peak, ignoring the first 6 bars of the series (launch prints)
        lo = max(6, int(np.searchsorted(ts, ts[pi] - 168 * 3600e3)))
        if pi - lo >= 6 and not ev.get('peak_near_start'):
            idx = np.arange(lo, pi + 1); contig = (ts[idx] - ts[idx - 1]) == 3600e3
            g = np.where(contig, c[idx] / c[idx - 1] - 1, -np.inf)
            if np.isfinite(g).any() and g.max() > 0:
                j = idx[int(np.argmax(g))]; rise = c[pi] / c[lo - 1:pi + 1].min()
                it = {'t_event': int(ts[j]), 'cand_t': ts[idx][contig], 'cand_v': v[idx][contig], 'cohort': ev['cohort'], 'rise_x': float(rise), 'gain_pct': float(g.max() * 100)}
                if ev['cohort'] == 'mooned': run_items.append(it)
                if rise >= 3: run_all3x.append(it)
    wins = [w for w in WINDOWS]
    res = {'events_in_detector1': len(evs), 'events_with_cached_series': used,
           'crash_onsets_all': cluster_test(crash_items, wins), 'crash_onsets_excl_launch_peaks': cluster_test([x for x in crash_items if x['excl_launch']], wins),
           'runner_breakouts_mooned_cohort': cluster_test(run_items, wins), 'runner_breakouts_any_3x_into_peak': cluster_test(run_all3x, wins),
           'definitions': {'crash_onset': 'detector 1 (research/patterns_hours.py): bar of the largest 1h close-to-close drop between the peak and the first close <= 50% of peak within 168h',
                           'crash_exposure': "each crash's candidate bars = every bar after the peak up to the -50% crossing (onset could only have happened there); time exposure = share of those bars in the window, volume exposure = share of their volume",
                           'runner_breakout': 'bar of the largest 1h close-to-close gain within the 168h before the peak (first 6 bars of the series excluded; launch-peak tokens excluded); runners = research-DB "mooned" cohort, and separately any token rising >=3x into its peak',
                           'runner_exposure': 'candidate bars = contiguous hourly bars in that pre-peak range',
                           'test': 'observed count vs sum of per-event exposure probabilities; exact Poisson-binomial two-sided p; BH q across windows within each family'}}
    return res

def bh_all(R):
    """BH across every per-window bootstrap test (vol, tail, volume intensity, mean occurrence return) in majors + catalog."""
    refs = []
    def walk(wins, tag):
        for wid, st in wins.items():
            for k in ('vol_ratio_p', 'tail_ratio_p', 'vol_intensity_p'):
                if st.get(k) is not None: refs.append((st, k.replace('_p', '_q'), st[k]))
            for ok in ('occurrence_bps', 'occurrence_z'):
                o = st.get(ok)
                if o and o.get('mean_p') is not None: refs.append((o, 'mean_q', o['mean_p']))
    for iv in ('res_1h', 'res_5m'):
        M = R['majors'].get(iv) or {}
        for sym, d in (M.get('per_token') or {}).items(): walk(d['windows'], sym)
        walk(M.get('pooled') or {}, 'pooled')
    walk(R['catalog_dex']['pooled'], 'catalog')
    qs = bh([p for _, _, p in refs])
    for (o, k, _), q in zip(refs, qs): o[k] = q
    return len(refs)

VOL_HI, VOL_LO, Q = 1.15, 0.87, 0.05
def classify(st):
    if not st or st.get('vol_ratio') is None: return 'unknown'
    q = st.get('vol_ratio_q', 1)
    if st['vol_ratio'] >= VOL_HI and q < Q: return 'volatile'
    if st['vol_ratio'] <= VOL_LO and q < Q: return 'quiet'
    return 'normal'

def live_profiles(R):
    def prof(w1, w5=None):
        out = {}
        for w in WINDOWS:
            st = (w5 or {}).get(w['id']) or w1.get(w['id'])
            if not st: continue
            src = '5m' if (w5 or {}).get(w['id']) else '1h'
            out[w['id']] = {'state': classify(st), 'vol_ratio': st.get('vol_ratio'), 'vol_ratio_ci95': st.get('vol_ratio_ci95'), 'q': st.get('vol_ratio_q'), 'tail_ratio': st.get('tail_ratio'),
                            'down_tail_ratio': st.get('down_tail_ratio'), 'vol_intensity': st.get('vol_intensity'), 'n_bars': st.get('n_bars'), 'res': src}
        return out
    M1 = R['majors']['res_1h']; M5 = R['majors'].get('res_5m') or {'per_token': {}, 'pooled': {}}
    tokens = {s: prof(d['windows'], (M5['per_token'].get(s) or {}).get('windows')) for s, d in M1['per_token'].items()}
    crash = R['events']['crash_onsets_all']
    cat = prof(R['catalog_dex']['pooled'])
    for wid, c in crash.items():
        if wid in cat: cat[wid]['crash_onset_ratio_volume'] = c['ratio_volume']; cat[wid]['crash_onset_q_volume'] = c['q_volume']
    return {'rule': f'state = volatile if in-vs-out vol ratio >= {VOL_HI} and BH q < {Q}; quiet if <= {VOL_LO} and q < {Q}; else normal. Per-token profile for Binance majors (5m stats preferred for half-hour windows), pooled majors for other perps, pooled catalog DEX for launches.',
            'windows': WINDOWS, 'nyse_holidays': NYSE_HOLIDAYS, 'tokens': tokens, 'pooled_majors': prof(M1['pooled'], M5['pooled']), 'pooled_catalog': cat, 'thresholds': {'vol_hi': VOL_HI, 'vol_lo': VOL_LO, 'q': Q}}

def findings(R):
    """plain-English lines built only from computed numbers."""
    F = []; pm = R['majors']['res_1h']['pooled']; p5 = (R['majors'].get('res_5m') or {}).get('pooled') or {}
    def line(scope, wid, st):
        if not st or st.get('vol_ratio') is None: return
        F.append({'scope': scope, 'window': wid, 'label': WBY[wid]['label'], 'state': classify(st), 'vol_ratio': st['vol_ratio'], 'ci95': st.get('vol_ratio_ci95'), 'q': st.get('vol_ratio_q'),
                  'tail_ratio': st.get('tail_ratio'), 'tail_q': st.get('tail_ratio_q'), 'volume_share': st.get('volume_share'), 'time_share': st.get('time_share'), 'vol_intensity': st.get('vol_intensity'),
                  'mean_occ_z': (st.get('occurrence_z') or {}).get('mean'), 'mean_occ_q': (st.get('occurrence_z') or {}).get('mean_q')})
    for wid in WBY:
        line('majors_1h_pooled', wid, pm.get(wid))
        if wid in p5: line('majors_5m_pooled', wid, p5.get(wid))
        line('catalog_dex_pooled', wid, R['catalog_dex']['pooled'].get(wid))
    return F

def main():
    t0 = time.time()
    from seasonality_fetch import HOURLY, FIVEM
    R = {'definition': {'windows': WINDOWS, 'partition_for_kruskal_wallis': PARTITION, 'nyse_holidays': NYSE_HOLIDAYS,
                        'notes': ['all windows in local exchange time via IANA zones (DST-correct per date); a bar counts only if fully inside the window',
                                  'z = bar log return / trailing 30-day sigma (majors) or 7-day sigma (DEX), so regime shifts do not masquerade as seasonality',
                                  'vol_ratio, tail_ratio compare in-window bars with out-of-window bars of the same token; vol_intensity = mean volume (normalised by its own trailing 30d/7d mean) in-window / out-of-window; volume_share = share of that normalised volume inside the window, compare with time_share',
                                  'Japanese, HK, UK bank holidays and NYSE early closes are not modelled; CME daily 17:00-18:00 ET maintenance halt not modelled',
                                  'p-values from day-block bootstrap (B=2000, floor 1/B, so the smallest reportable BH q is ~0.002); BH FDR q across all per-window tests', 'z winsorised at +-10 for variance ratios and skew; tail counts (|z|>2) use raw z']},
         'data': {'binance': 'data.binance.vision spot kline archives (free); quote volume in USDT', 'geckoterminal': 'GeckoTerminal hourly OHLCV cached by detector 1 (patterns_hours.py)'}}
    R['majors'] = {'res_1h': run_majors('1h', 60, HOURLY)}
    if '--no5m' not in sys.argv: R['majors']['res_5m'] = run_majors('5m', 5, FIVEM)
    H = json.load(open(os.path.join(DATA_DIR, 'patterns_hours.json')))
    R['catalog_dex'] = run_catalog(H.get('events', [])); log('catalog done', R['catalog_dex']['n_tokens'])
    R['events'] = run_events(); log('events done')
    R['n_tests_bh'] = bh_all(R)
    R['findings'] = findings(R)
    L = live_profiles(R); R['live_rule'] = L['rule']
    R['elapsed_s'] = round(time.time() - t0, 1)
    save('seasonality_live.json', L)
    save('seasonality.json', R)

if __name__ == '__main__': main()
