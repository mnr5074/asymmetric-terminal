#!/usr/bin/env python3
"""Cross-detector backtest harness -> data/backtest_scoreboard.json (served by lib/backtest.js at /api/backtest).
1. rebuilds data/events_labeled.json (both classes: pump + crash/rug)
2. REPLAYS detectors that can be re-run on history (crash lookalike kNN / fingerprint similarity on every daily series,
   static contract/holder flags on the research DB died-vs-mooned cohorts, live-feed grades/vetoes on the call log,
   and any plug-in detector that ships historical signal events: Pattern Lab via data/patternlab*.json)
3. REUSES every desk's own backtest output (adapters.py) and normalizes it
4. scores each detector separately for 'predicts crash' and 'predicts pump', assigns a trust tier per claim, and calibrates
   the confluence (>= 3 independent detectors) lift.
Run: python3 research/backtest/run.py   (stdlib + numpy; ~30 s; zero paid APIs)"""
import json, os, sys, time, sqlite3
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import universe as U, replay as RP, adapters as A, events_build as EB
from stats import tier, enrich_p, rnd, median
D = U.DATA_DIR

def sub_cc(a, n1, b, n2, **kw): return A.cc(a, n1, b, n2, **kw)

def db_static():
    """Static contract / holder flags on research-DB cohorts. Crash claim: died flagged vs mooned flagged; pump claim: reverse."""
    db = sqlite3.connect(f'file:{os.path.join(D, "moonshot.db")}?mode=ro', uri=True)
    rows = db.execute("select cohort, mint_auth, freeze_auth, top10_now, lp_locked_pct, insider_pct_now, dev_prior_tokens, rugcheck_rugged from tokens where cohort in ('died','mooned')").fetchall()
    F = {'contract_mint_authority': ('Live mint authority', lambda r: r[1] == 1, 'leading'), 'contract_freeze_authority': ('Live freeze authority', lambda r: r[2] == 1, 'leading'),
         'lp_unlocked': ('LP not locked/burned (< 50% locked)', lambda r: r[4] is not None and r[4] < 50, 'leading'),
         'holder_concentration': ('Top-10 holders >= 50%', lambda r: r[3] is not None and r[3] >= 50, 'descriptive'),
         'insider_concentration': ('Insiders >= 20% of supply', lambda r: r[5] is not None and r[5] >= 20, 'descriptive'),
         'dev_serial': ('Serial deployer (>= 3 prior tokens)', lambda r: (r[6] or 0) >= 3, 'leading')}
    died = [r for r in rows if r[0] == 'died']; moon = [r for r in rows if r[0] == 'mooned']; out = []; counts = []
    for id, (nm, fn, timing) in F.items():
        a = sum(1 for r in died if fn(r)); b = sum(1 for r in moon if fn(r))
        out.append({'id': id, 'name': nm, 'desk': 'rug', 'claim': 'crash', 'timing': timing, 'method': 'replayed', 'source': 'data/moonshot.db (research DB cohorts)',
                    'definition': 'flag present on died vs mooned memecoins', 'crash': sub_cc(a, len(died), b, len(moon)), 'pump': sub_cc(b, len(moon), a, len(died)),
                    'caveats': ['holder % snapshots were taken after the peak (descriptive)' if timing == 'descriptive' else 'authority/LP state is set at launch, so it precedes the outcome', 'research DB cohorts: %d died / %d mooned' % (len(died), len(moon))]})
    for r in rows: counts.append((r[0], sum(1 for (nm, fn, t) in F.values() if fn(r))))
    return out, counts

def calls_replay():
    d = U.J('calls.json') or {}; first = {}
    for c in d.get('calls', []):
        if c['key'] not in first: first[c['key']] = c
    now = max([c.get('lastT') or 0 for c in first.values()] or [0]); C = [c for c in first.values() if now - c['t'] >= 3600e3 and c.get('px0')]
    crash = lambda c: bool(c.get('rugged') or (c.get('minPx') or c['px0']) <= 0.5 * c['px0']); pump = lambda c: (c.get('maxPx') or 0) >= 2 * c['px0'] and not c.get('rugged')
    v = lambda c: str(c.get('veto') or '')
    D_ = {'live_grade_ab': ('Live alpha grade A/B', 'pump', lambda c: c['grade'] in ('A', 'B')), 'rug_forecast': ('Rug forecast >= 25 (live)', 'crash', lambda c: (c.get('rugRisk') or 0) >= 25),
          'veto_lowliq': ('Veto: liquidity under $3K', 'crash', lambda c: v(c).startswith('liquidity under')), 'veto_concentration': ('Veto: top-10 wallets hold > 90%', 'crash', lambda c: v(c).startswith('top-10')),
          'honeypot_live': ('Veto: honeypot signs', 'crash', lambda c: 'honeypot' in v(c)), 'veto_fake_liquidity': ('Veto: fake liquidity', 'crash', lambda c: 'fake liquidity' in v(c))}
    out = []; span_h = (now - min([c['t'] for c in C] or [now])) / 3600e3
    for id, (nm, claim, fn) in D_.items():
        f = [c for c in C if fn(c)]; nf = [c for c in C if not fn(c)]
        def s(o):
            a = sum(map(o, f)); b = sum(map(o, nf)); base = (a + b) / len(C) if C else None; prec = a / len(f) if f else None
            leads = [((c.get('rugT') or c['lastT']) - c['t']) / 3600e3 for c in f if o(c) and o is crash and c.get('rugT')]
            return {'n_events': len(f), 'hits': a, 'precision': rnd(prec), 'base_rate': rnd(base), 'lift': rnd(prec / base) if prec is not None and base else None,
                    'recall': rnd(a / (a + b)) if a + b else None, 'n_pos': a + b, 'n_neg': len(C) - a - b, 'p': rnd(enrich_p(a, len(f), b, len(nf)), 6) if f and nf else None,
                    'median_lead_h': rnd(median(leads), 2) if leads else None, 'fp_per_token_day': None}
        out.append({'id': id, 'name': nm, 'desk': 'crypto', 'claim': claim, 'timing': 'leading', 'method': 'replayed', 'source': 'data/calls.json (live call log, first call per token)',
                    'definition': 'crash = rugged or -50% from call; pump = >= 2x from call and not rugged; calls >= 1h old', 'crash': s(crash), 'pump': s(pump),
                    'caveats': ['call log covers only %.1f h so far: outcomes are short-horizon; fplog keeps extending this' % span_h]})
    return out

def finalize(r):
    for cls in ('crash', 'pump'):
        s = r.get(cls)
        if not s: continue
        s['has_control'] = bool(s.get('n_neg') or s.get('base_rate') is not None or s.get('auc') is not None or s.get('n_events'))
        t, edge, why = tier({**s, 'timing': r.get('timing', 'leading')})
        if s.get('lift') is not None and s['lift'] < 1 and t != 'untested' and (s.get('p') is None or s['p'] > 0.05): edge = False
        s['trust'], s['edge'], s['why'] = t, edge, why
    stated = r['claim'] if r['claim'] in ('crash', 'pump') else 'crash'
    if r['claim'] == 'rug': stated = 'crash'
    s = r.get(stated) or {}
    r['trust'] = s.get('trust') or 'untested'; r['edge'] = s.get('edge'); r['trust_why'] = s.get('why') or (r.get('caveats') or ['no data'])[0]
    best = [(c, r[c]) for c in ('crash', 'pump') if r.get(c) and r[c].get('trust') == 'proven' and r[c].get('edge')]
    r['proven_claims'] = [c for c, _ in best]
    r['score'] = score_of(r)
    return r

TW = {'proven': 1.0, 'weak': 0.55, 'untested': 0.4}
def score_of(r):
    """0..1 trust score used by the alert ranker: tier weight x evidence strength (lift, sample)."""
    s = r.get(r['claim'] if r['claim'] in ('crash', 'pump') else 'crash') or {}
    w = TW[r['trust']]
    if r['trust'] == 'weak' and r.get('edge') is False: w = 0.25
    lift = s.get('lift'); auc = s.get('auc')
    eff = min(1.0, max(0.0, ((lift or 1) - 1) / 3)) if lift is not None else (min(1.0, abs((auc or 0.5) - 0.5) * 4) if auc is not None else 0.3)
    return round(w * (0.7 + 0.3 * eff), 3)

def main():
    t0 = time.time()
    ev = EB.build(); json.dump(ev, open(os.path.join(D, 'events_labeled.json.tmp'), 'w'), separators=(',', ':')); os.replace(os.path.join(D, 'events_labeled.json.tmp'), os.path.join(D, 'events_labeled.json'))
    toks = U.load(); recs = []
    knn, sim, raw = RP.crashmatch(toks, D)
    def rp(id, nm, desk, claim, flags, definition, caveats):
        r = RP.score(toks, flags); return {'id': id, 'name': nm, 'desk': desk, 'claim': claim, 'timing': 'leading', 'method': 'replayed', 'source': 'daily series replay (%d tokens)' % len(toks),
                                         'definition': definition, 'crash': r['crash'], 'pump': r['pump'], 'caveats': caveats}
    recs.append(rp('crashmatch_knn', 'Crash lookalike kNN (lib/crashmatch.js)', 'crash', 'crash', knn, 'kNN crash odds >= 30% (25 nearest labelled days), leave-one-token-out',
                   ['out-of-sample on CoinGecko/Binance daily series; it also fires before PUMPS (it detects violent regimes, not direction)']))
    recs.append(rp('crashmatch_similarity', 'Crash fingerprint similarity >= 70%', 'crash', 'crash', sim, 'top fingerprint similarity >= 70%', ['the headline "looks X% like LUNA" number']))
    sens = {}
    for thr in (0.2, 0.4, 0.5):
        fl = {k: {i for i, v in d.items() if v >= thr} for k, d in raw.items()}; s = RP.score(toks, fl)
        sens[f'ge{int(thr * 100)}'] = {c: {k: s[c][k] for k in ('n_events', 'precision', 'lift', 'p', 'median_lead_h')} for c in s}
    recs[0]['sensitivity'] = sens
    st, counts = db_static(); recs += st
    recs += calls_replay()
    pdets, pflags = RP.load_plugin_events(D, toks)
    for did, meta in pdets.items():
        if pflags.get(did): recs.append(rp('pl_' + did if not did.startswith('pl_') else did, meta.get('name') or did, meta.get('desk') or 'patternlab', meta.get('claim') or 'crash', pflags[did], meta.get('description') or 'plug-in historical events', ['Pattern Lab plug-in: ' + meta.get('file', '')]))
        elif meta.get('stats'):
            g = A._discover({'x': meta['stats']}); s = meta['stats']
            sub = {k: s.get(k) for k in ('n_events', 'hits', 'precision', 'recall', 'lift', 'base_rate', 'median_lead_h', 'fp_per_token_day', 'p', 'auc', 'n_pos', 'n_neg', 'hit_pos', 'hit_neg') if k in s}
            cl = meta.get('claim') or 'crash'
            recs.append({'id': 'pl_' + did, 'name': meta.get('name') or did, 'desk': 'patternlab', 'claim': cl, 'timing': 'leading', 'method': 'reused', 'source': 'data/' + meta.get('file', ''),
                         'definition': meta.get('description') or '', 'crash': sub if cl != 'pump' else s.get('crash'), 'pump': sub if cl == 'pump' else s.get('pump'), 'caveats': ['Pattern Lab self-reported stats']})
        else:
            recs.append({'id': 'pl_' + did, 'name': meta.get('name') or did, 'desk': 'patternlab', 'claim': meta.get('claim') or 'crash', 'timing': 'leading', 'method': 'pending', 'source': 'data/' + meta.get('file', ''), 'definition': 'registered, no historical events yet', 'crash': None, 'pump': None, 'caveats': ['Pattern Lab detector registered without history']})
    recs += A.all_records()
    recs = [finalize(r) for r in recs]
    # confluence calibration (research DB: count of independent static flags per token)
    conf = {}
    for k in (1, 2, 3):
        dk = sum(1 for c, n in counts if c == 'died' and (n >= k if k == 3 else n == k)); mk = sum(1 for c, n in counts if c == 'mooned' and (n >= k if k == 3 else n == k))
        conf['flags_' + ('ge3' if k == 3 else str(k))] = {'died': dk, 'mooned': mk, 'precision_crash': rnd(dk / (dk + mk)) if dk + mk else None}
    nd = sum(1 for c, n in counts if c == 'died'); nm = sum(1 for c, n in counts if c == 'mooned'); base = nd / (nd + nm)
    one = conf['flags_1']['precision_crash']; g3 = conf['flags_ge3']['precision_crash']
    conf['base_precision'] = rnd(base); conf['lift_ge3_vs_single'] = rnd(g3 / one) if g3 and one else None; conf['lift_ge3_vs_base'] = rnd(g3 / base) if g3 else None
    conf['n_ge3'] = conf['flags_ge3']['died'] + conf['flags_ge3']['mooned']
    # crash x pump replay overlap: does kNN + similarity agreeing add anything (same family, NOT independent — shown as a control)
    both = {k: knn.get(k, set()) & sim.get(k, set()) for k in knn}; sb = RP.score(toks, both)
    conf['same_family_control_knn_and_similarity'] = {'crash_lift': sb['crash']['lift'], 'n': sb['crash']['n_events'], 'note': 'not independent; shown to illustrate that correlated detectors do not add up'}
    conf['note'] = ('Calibrated on research-DB static flags (mint/freeze authority, LP unlocked, holder/insider concentration, serial deployer) because those are the only '
                    'independent detectors observed together on the same historical tokens. Live confluence precision accrues in data/fplog.json and overrides this when n >= 30.')
    conf['rank_multiplier'] = rnd(max(1.0, min(3.0, conf['lift_ge3_vs_single'] or 1.5))) if conf['n_ge3'] >= 5 else 1.5
    tiers = {}
    for r in recs: tiers[r['trust']] = tiers.get(r['trust'], 0) + 1
    rank = lambda r: (-(r['score']), r['id'])
    out = {'generatedAt': int(time.time() * 1000), 'elapsed_s': round(time.time() - t0, 1),
           'universe': {'series_tokens': len(toks), 'labels': {k: sum(1 for t in toks if t['label'] == k) for k in ('crashed', 'runner', 'other')}, 'pump_breakouts_3x': sum(1 for t in toks if t['pump_i'] is not None),
                        'catalog': U.catalog_size(), 'events_labeled': ev['counts'], 'events_with_series': ev['with_series']},
           'definitions': {'crash': 'close falls to <= 30% of the day\'s close within 90 days (series) / study-specific for reused outputs', 'pump': 'close >= 3x within 30 days (series) / study-specific',
                           'trust': open(os.path.join(os.path.dirname(__file__), 'stats.py')).read().split('"""')[1].strip(), 'p': 'replays: max(event binomial, token-cluster bootstrap) — conservative'},
           'tiers': tiers, 'confluence': conf, 'detectors': sorted(recs, key=rank)}
    p = os.path.join(D, 'backtest_scoreboard.json'); json.dump(out, open(p + '.tmp', 'w'), separators=(',', ':'), default=str); os.replace(p + '.tmp', p)
    print('scoreboard', len(recs), 'detectors', tiers, 'confluence', conf['lift_ge3_vs_single'], 'in', out['elapsed_s'], 's')
    for r in out['detectors'][:12]: print(' ', r['id'], r['trust'], r['score'], (r.get(r['claim'] if r['claim'] in ('crash','pump') else 'crash') or {}).get('lift'))

if __name__ == '__main__': main()
