"""Replay engine: run detectors day-by-day over every historical daily series and score them against BOTH outcome classes.
A detector here is any function token -> set of day indexes on which it would have fired (its signals(token, time) evaluated
for every past day). Plug-ins (Pattern Lab etc.) can instead ship historical signal events (see load_plugin_events)."""
import json, os, glob, math
import numpy as np
import universe as U
from stats import binom_sf, enrich_p, median, rnd
CRASH_H, PUMP_H = 90, 30          # forward windows (days): crash = -70% within 90d, pump = 3x within 30d
WARM = 90                         # detectors need 90 days of history

def outcomes(px):
    n = len(px); a = np.array(px, float); crash = [None] * n; pump = [None] * n
    for i in range(n):
        f = a[i + 1:i + 1 + CRASH_H]
        if len(f) and f.min() <= 0.3 * a[i]: crash[i] = True
        elif i + CRASH_H < n: crash[i] = False
        g = a[i + 1:i + 1 + PUMP_H]
        if len(g) and g.max() >= 3 * a[i]: pump[i] = True
        elif i + PUMP_H < n: pump[i] = False
    return crash, pump

_OUT = {}
def outs(t):
    if t['id'] not in _OUT: _OUT[t['id']] = outcomes(t['px'])
    return _OUT[t['id']]

def score(toks, flags, claim_window=None):
    """flags: {token_id: set(day_idx)}. Returns {'crash': {...}, 'pump': {...}} with event- and token-level stats."""
    res = {}
    for cls, k_ev, k_i, win in (('crash', 0, 'crash_i', CRASH_H), ('pump', 1, 'pump_i', PUMP_H)):
        ev_hit = ev_n = base_hit = base_n = pos_total = 0; leads = []; tok_pos = tok_pos_flag = tok_neg = tok_neg_flag = 0; fp_days = 0; eval_days = 0; tokens_flagged = set()
        per = []
        for t in toks:
            o = outs(t)[k_ev]; F = flags.get(t['id'], set()); a = [0, 0, 0, 0]
            for i in range(WARM, len(t['px'])):
                if o[i] is None: continue
                eval_days += 1; base_n += 1; base_hit += o[i]; pos_total += o[i]; a[2] += 1; a[3] += o[i]
                if i in F:
                    ev_n += 1; ev_hit += o[i]; tokens_flagged.add(t['id']); a[0] += 1; a[1] += o[i]
                    if not o[i]: fp_days += 1
            per.append(a)
            ci = t[k_i]
            if ci is not None and ci > WARM:
                tok_pos += 1; pre = [i for i in F if ci - win <= i < ci]
                if pre: tok_pos_flag += 1; leads.append(ci - min(pre))
            elif ci is None:
                tok_neg += 1; tok_neg_flag += bool([i for i in F if i >= WARM])
        base = base_hit / base_n if base_n else None; prec = ev_hit / ev_n if ev_n else None
        p_ev = binom_sf(ev_hit, ev_n, base) if ev_n and base else None
        p_tok = enrich_p(tok_pos_flag, tok_pos, tok_neg_flag, tok_neg) if tok_pos and tok_neg else None
        p_cl, ci = cluster_boot(per)
        ps = [x for x in (p_ev, p_cl) if x is not None]
        res[cls] = {'design': 'forward', 'n_events': ev_n, 'hits': ev_hit, 'precision': rnd(prec), 'base_rate': rnd(base), 'lift': rnd(prec / base) if prec is not None and base else None,
                    'recall': rnd(ev_hit / pos_total) if pos_total else None, 'n_pos': tok_pos, 'hit_pos': rnd(tok_pos_flag / tok_pos) if tok_pos else None,
                    'n_neg': tok_neg, 'hit_neg': rnd(tok_neg_flag / tok_neg) if tok_neg else None, 'median_lead_h': rnd(median(leads) * 24, 1) if leads else None,
                    'fp_per_token_day': rnd(fp_days / eval_days, 5) if eval_days else None, 'p_event': rnd(p_ev, 6), 'p_token': rnd(p_tok, 6), 'p_cluster': rnd(p_cl, 6), 'lift_ci90': ci,
                    'p': rnd(max(ps), 6) if ps else None, 'tokens_flagged': len(tokens_flagged), 'eval_token_days': eval_days}
    return res

def cluster_boot(per, reps=1000, seed=7):
    """Token-cluster bootstrap of lift (flagged-day hit rate / all-day hit rate): days within a token are autocorrelated, so
    tokens (not days) are resampled. p = share of resamples with lift <= 1. Returns (p, [5%, 95%] lift)."""
    A = np.array(per, float)
    if len(A) < 5 or A[:, 0].sum() == 0: return None, None
    rng = np.random.default_rng(seed); n = len(A); L = []
    for _ in range(reps):
        S = A[rng.integers(0, n, n)].sum(0)
        if S[0] and S[2] and S[3]: L.append((S[1] / S[0]) / (S[3] / S[2]))
    if not L: return None, None
    L = np.array(L); return float((L <= 1).mean()) or 1 / reps / 2, [round(float(np.percentile(L, 5)), 3), round(float(np.percentile(L, 95)), 3)]

# ---------- replayable detectors (Python ports of the live JS logic) ----------
def _feats(px, vol, i):
    """lib/crashmatch.js feats() — identical math."""
    if i < 90 or not px[i] > 0: return None
    P = px[i - 90:i + 1]; lr = [math.log(P[k] / P[k - 1]) for k in range(len(P) - 60, len(P)) if P[k] > 0 and P[k - 1] > 0]
    if len(lr) < 20: return None
    v7 = sum(vol[i - 6:i + 1]) / 7; s = vol[i - 37:i - 6]; v30 = (sum(s) / len(s) if s else 0) or 1e-9; l30 = lr[-30:]
    m = sum(l30) / len(l30); sd = math.sqrt(sum((x - m) ** 2 for x in l30) / len(l30))
    return {'run90': math.log(px[i] / max(min(P), 1e-12)), 'run30': math.log(px[i] / max(min(px[i - 30:i + 1]), 1e-12)), 'dd_hi30': px[i] / max(px[i - 30:i + 1]) - 1,
            'vol30': sd, 'vol_trend': math.log(max(v7, 1e-9) / v30), 'up30': sum(1 for x in l30 if x > 0) / 30, 'ath_gap': px[i] / max(px[:i + 1]) - 1}

def crashmatch(toks, data_dir, knn_thr=0.3, sim_thr=70, step=1):
    fp = json.load(open(os.path.join(data_dir, 'crash_fingerprints.json'))); K = fp['features']; sd = np.array([fp['sd'].get(k) or 1 for k in K])
    kv = np.array([s['v'] for s in fp['knn']]); kh = np.array([s['h'] for s in fp['knn']]); kn = [s['n'].lower() for s in fp['knn']]
    fps = np.array([[x['fp'][k] for k in K] for x in fp['fingerprints']]); fpn = [x['name'].lower() for x in fp['fingerprints']]
    knn_flags, sim_flags, knn_raw = {}, {}, {}
    for t in toks:
        ex = (t['symbol'].lower() + ' ', t['name'].lower() + ' ')       # leave-one-token-out, same as the live `exclude`
        km = np.array([not (n.startswith(ex[0]) or n.startswith(ex[1])) for n in kn]); fm = np.array([not (n.startswith(ex[0]) or n.startswith(ex[1])) for n in fpn])
        KV, KH, FP = kv[km], kh[km], fps[fm]
        for i in range(WARM, len(t['px']), step):
            f = _feats(t['px'], t['vol'], i)
            if not f: continue
            q = np.array([f[k] for k in K]); qs = q / sd
            d = ((KV - qs) ** 2).sum(1); idx = np.argpartition(d, 25)[:25]; odds = KH[idx].mean()
            knn_raw.setdefault(t['id'], {})[i] = float(odds)
            if odds >= knn_thr: knn_flags.setdefault(t['id'], set()).add(i)
            sim = np.exp(-np.sqrt((((FP - q) / sd) ** 2).mean(1))) * 100
            if sim.max() >= sim_thr: sim_flags.setdefault(t['id'], set()).add(i)
    return knn_flags, sim_flags, knn_raw

def load_plugin_events(data_dir, toks):
    """Historical signal events shipped by plug-in detectors (Pattern Lab and future expansions). Accepted files:
    data/patternlab*.json, data/backtest_events_*.json with {"detectors":[{id,name,claim,desk}], "events":[{detector, token|cg_id|symbol|key, date|t}]}
    (also "signals" instead of "events"). Tokens are matched to the series universe by cg id, then symbol."""
    by_id = {t['id']: t for t in toks}; by_sym = {}
    for t in toks: by_sym.setdefault(t['symbol'], t)
    dets, flags = {}, {}
    for f in sorted(glob.glob(os.path.join(data_dir, 'patternlab*.json')) + glob.glob(os.path.join(data_dir, 'backtest_events_*.json'))):
        try: d = json.load(open(f))
        except Exception: continue
        if not isinstance(d, dict): continue
        for x in d.get('detectors') or d.get('patterns') or []:
            if isinstance(x, dict) and x.get('id'): dets.setdefault(x['id'], {**{k: x.get(k) for k in ('id', 'name', 'claim', 'desk', 'description')}, 'file': os.path.basename(f), 'stats': x.get('backtest') or x.get('stats')})
        for e in d.get('events') or d.get('signals') or []:
            if not isinstance(e, dict): continue
            did = e.get('detector') or e.get('pattern') or e.get('id')
            tk = by_id.get(e.get('cg_id') or e.get('token') or '') or by_sym.get(str(e.get('symbol') or e.get('token') or '').upper())
            if not did or not tk: continue
            day = e.get('date') or (None if not e.get('t') else __import__('datetime').datetime.utcfromtimestamp((e['t'] / 1000) if e['t'] > 1e11 else e['t']).date().isoformat())
            if day in tk['days']: flags.setdefault(did, {}).setdefault(tk['id'], set()).add(tk['days'].index(day))
            dets.setdefault(did, {'id': did, 'name': did, 'claim': e.get('claim'), 'desk': 'patternlab', 'file': os.path.basename(f)})
    return dets, flags
