"""Normalize EXISTING per-detector backtest outputs (data/*.json written by each desk's research script) into the common record.
Each adapter returns records: {id, name, desk, claim, timing, method:'reused', source, definition, caveats, crash:{..}|None, pump:{..}|None}
sub-stats (one per outcome class): n_pos, n_neg, n_events, hits, precision, base_rate, lift, recall, hit_pos, hit_neg, median_lead_h,
fp_per_token_day, p, auc. 'hit_pos' = share of crash (or pump) cases flagged; 'hit_neg' = share of the comparison group flagged
(runners for crash claims, died/crashed for pump claims, or random/control days)."""
import json, os, re, sqlite3
from stats import enrich_p, binom_sf, rnd
import universe as U
J = U.J

def ab(s):
    a, b = str(s).split('/'); return int(a), int(b)

def fw(a_str, b_str, p=None, lead_h=None, per_day=1.0, **kw):
    """forward test: a = hits/flagged events, b = hits/all units (base rate)."""
    h, n = ab(a_str); bh, bn = ab(b_str); base = bh / bn if bn else None; prec = h / n if n else None
    if p is None: p = binom_sf(h, n, base) if n and base else None
    return {'n_events': n, 'hits': h, 'precision': rnd(prec), 'base_rate': rnd(base), 'lift': rnd(prec / base) if base and prec is not None else None,
            'recall': rnd(h / bh) if bh else None, 'n_pos': bh, 'median_lead_h': lead_h, 'fp_per_token_day': rnd((n - h) / bn * per_day, 5) if bn else None, 'p': rnd(p, 6), **kw}

def cc(a, n1, b, n2, p=None, lead_h=None, **kw):
    """case-control: a of n1 positives flagged, b of n2 negatives flagged."""
    if p is None: p = enrich_p(a, n1, b, n2) if n1 and n2 else None
    hp, hn = (a / n1 if n1 else None), (b / n2 if n2 else None)
    return {'n_pos': n1, 'n_neg': n2, 'n_events': a + b, 'hits': a, 'hit_pos': rnd(hp), 'hit_neg': rnd(hn), 'recall': rnd(hp),
            'precision': rnd(a / (a + b)) if a + b else None, 'lift': rnd(hp / hn) if hn else (None if not hp else 99.0), 'median_lead_h': lead_h, 'p': rnd(p, 6), **kw}

def mw(d, n_pos=None, **kw):
    return {'auc': rnd(d.get('auc')), 'p': rnd(d.get('p'), 6), 'n_pos': n_pos or d.get('n1'), 'n_neg': d.get('n2'), 'n_events': d.get('n1'), **kw}

def R(id, name, desk, claim, timing, source, definition, crash=None, pump=None, caveats=None, **kw):
    return {'id': id, 'name': name, 'desk': desk, 'claim': claim, 'timing': timing, 'method': 'reused', 'source': source, 'definition': definition,
            'crash': crash, 'pump': pump, 'caveats': caveats or [], **kw}

def _try(fn):
    try: return fn() or []
    except Exception as e: return [{'id': fn.__name__.replace('a_', ''), 'name': fn.__name__, 'desk': '?', 'claim': 'crash', 'timing': 'leading', 'method': 'reused', 'error': str(e)[:200], 'crash': None, 'pump': None, 'caveats': []}]

def a_liquidations():
    d = J('liquidations_history.json'); bm = d['binance_metrics']; g = d.get('gate_liquidations') or {}; src = 'data/liquidations_history.json'
    x = bm['predict_next_day_crash_after_oi_build_10pct']; f = bm['oi_flush_10pct_same_day']; ff = bm['funding_flip_pos_to_neg_around_day']; nf = bm['predict_next_day_crash_after_oi_flush']
    out = [R('liq_oi_build', 'Open-interest build (+10% OI in coins, prior day)', 'perps', 'crash', 'leading', src, 'next-day -15% crash after OI +10% day vs all days',
             crash=fw(x['a'], x['b'], p=x['p'], lead_h=24), caveats=['Binance USDT-M perps on catalog tokens only; daily resolution']),
           R('liq_cascade', 'Liquidation cascade', 'perps', 'crash', 'coincident', src, 'OI flush >=10% same day on crash days vs calm control days; next-day test after a flush',
             crash=cc(*ab(f['a']), *ab(f['b']), p=f['p'], lead_h=0, next_day=fw(nf['a'], nf['b'], p=nf['p'])),
             caveats=['Fires DURING the crash (coincident). After a flush, the next day is NOT more likely to crash (lift %.2f)' % nf['lift']] + (["Gate liquidations: liq %% of OI AUC %.2f on crash days" % g['liq_pct_oi']['mw']['auc']] if g.get('liq_pct_oi') else [])),
           R('liq_funding_flip', 'Funding flips positive -> negative', 'perps', 'crash', 'coincident', src, 'funding flip around the crash day vs control', crash=cc(*ab(ff['a']), *ab(ff['b']), p=ff['p'], lead_h=0))]
    return out

def a_fundingdiv():
    d = J('fundingdiv_history.json'); r = d['results']; src = 'data/fundingdiv_history.json'; out = []
    for k, id, nm in (('pos_outlier', 'fundingdiv_pos', 'Funding divergence: one venue pays much more (longs crowded there)'), ('neg_outlier', 'fundingdiv_neg', 'Funding divergence: one venue pays much less'), ('all', 'fundingdiv', 'Funding divergence episode (any direction)')):
        x = r.get(k) or {}
        if not x.get('dump7d'): continue
        out.append(R(id, nm, 'perps', 'crash' if k != 'neg_outlier' else 'pump', 'leading', src, 'episode start -> 7d max drawdown <= -20% (dump) / max-up >= +20% (pump) vs every 8h bucket',
                     crash=fw(x['dump7d']['a'], x['dump7d']['b'], p=x['dump7d']['p'], lead_h=None, per_day=3), pump=fw(x['pump7d']['a'], x['pump7d']['b'], p=x['pump7d']['p'], per_day=3),
                     caveats=['91 perp tokens, ~90 days, 8h buckets (fp/day = 3 buckets per day)']))
    return out

def a_orderbook():
    d = J('orderbook_history.json'); r = d['results']; src = 'data/orderbook_history.json'
    t = r['thin_book_in_6h_before_steepest_hour_crash_vs_calm']; a, n1 = ab(t['a']); b, n2 = ab(t['b'])
    return [R('orderbook_thin', 'Thin order book (depth collapse)', 'perps', 'crash', 'leading', src, 'thin-book event in the 6h before the steepest crash hour (crash days vs calm days)',
              crash=cc(a, n1, b, n2, p=t['p'], lead_h=6, abs_move_auc=r['thin_abs_fwd60']['auc'], fp_per_token_day=rnd(r['thin_events_per_day_crash_vs_calm']['calm'], 3)),
              caveats=['also predicts |move| in the next hour in either direction (AUC %.2f): direction-free' % r['thin_abs_fwd60']['auc'], r.get('caveat', '')]),
            R('orderbook_spoof', 'Spoof / transient wall', 'perps', 'crash', 'leading', src, 'transient wall -> signed 60m return (bid wall should precede drop)',
              crash=mw(r['bid_wall_fwd60_signed']), pump=mw(r['ask_wall_fwd60_signed']), caveats=['walls predict a bigger move (AUC %.2f) but not its direction' % r['wall_abs_fwd15']['auc']])]

def a_pricegaps():
    d = J('pricegaps_history.json'); t = d['tests']['any_gap_vs_zero']; src = 'data/pricegaps_history.json'
    pm, du = t['pump'], t['dump']
    return [R('pricegaps', 'Cross-exchange price gaps', 'perps', 'crash', 'leading', src, d['method'][:300], crash=cc(*ab(du['a']), *ab(du['b']), p=du['p'], lead_h=None), pump=cc(*ab(pm['a']), *ab(pm['b']), p=pm['p']))]

def a_patterns():
    out = []
    w = J('patterns_wallets.json')
    if w:
        th = next((x for x in w['thresholds'] if x['rule'] == 'cluster_size>=2'), w['thresholds'][0]); lead = w.get('cluster_first_buy_lead_h_before_peak_died') or []
        out.append(R('patterns_wallets', 'Fresh-wallet buy cluster', 'patterns', 'crash', 'leading', 'data/patterns_wallets.json', th['rule'] + ' (died vs mooned cohorts)',
                     crash=cc(th['died_flagged'], th['died_n'], th['mooned_flagged'], th['mooned_n'], lead_h=rnd(sorted(lead)[len(lead) // 2], 1) if lead else None),
                     pump=cc(th['mooned_flagged'], th['mooned_n'], th['died_flagged'], th['died_n']), caveats=[w['sample'].get('holders_source', '')]))
    f = J('patterns_flows.json')
    if f:
        for k, id, nm in (('bridge_out', 'patterns_bridge_out', 'Dev/top-holder bridge-out'), ('cex', 'patterns_cex', 'Dev/top-holder deposits to CEX')):
            x = f[k]; out.append(R(id, nm, 'patterns', 'crash', 'leading', 'data/patterns_flows.json', f'{k} before break (died vs mooned)',
                                   crash=cc(x['died']['flagged'], x['died']['n'], x['mooned']['flagged'], x['mooned']['n']), pump=cc(x['mooned']['flagged'], x['mooned']['n'], x['died']['flagged'], x['died']['n'])))
    a = J('patterns_aging.json')
    if a:
        x = a['awakening_7d']; out.append(R('patterns_aging', 'Dormant-holder awakening (idle >=7d)', 'patterns', 'crash', 'leading', 'data/patterns_aging.json', a['params']['awakening'],
                                            crash=cc(x['died']['flagged'], x['died']['n'], x['mooned']['flagged'], x['mooned']['n']), pump=cc(x['mooned']['flagged'], x['mooned']['n'], x['died']['flagged'], x['died']['n'])))
    n = J('patterns_nansen.json')
    if n:
        x = n['any_to_cex_before_peak']; lead = n.get('lead_h_before_break_died') or []
        out.append(R('patterns_nansen_cex', 'Nansen: holder -> CEX before peak', 'patterns', 'crash', 'leading', 'data/patterns_nansen.json', 'any tracked holder to CEX before peak',
                     crash=cc(x['died']['flagged'], x['died']['n'], x['mooned']['flagged'], x['mooned']['n'], lead_h=rnd(sorted(lead)[len(lead) // 2], 1) if lead else None), caveats=['only %d died / %d mooned tokens (Nansen budget)' % (x['died']['n'], x['mooned']['n'])]))
    s = J('patterns_stocks.json')
    if s:
        m = s['summary']; out.append(R('patterns_stocks', 'Stock-token divergence vs underlying', 'patterns', 'crash', 'leading', 'data/patterns_stocks.json', s.get('rule', '')[:300],
                                       crash=cc(m['crashed_with_neg_div_flag_within_10d_before_break'], m['crashed_tokens'], m['non_crash_tokens_with_any_flag'], m['non_crash_tokens'], fp_per_token_day=m['fp_flag_days_per_token_day_non_crash'])))
    h = J('patterns_hours.json')
    if h:
        o = h['onset_all']; out.append(R('patterns_hours', 'Crash-onset hour (Asia session / thin hours)', 'patterns', 'crash', 'descriptive', 'data/patterns_hours.json', h['definition']['onset'],
                                         crash={'n_pos': o['n'], 'n_events': o['n'], 'p': rnd(o['chi2_volume_24h']['p'], 6), 'lift': rnd(o['asia_share'] / o['asia_expected_volume'], 3), 'hit_pos': o['asia_share'], 'hit_neg': o['asia_expected_volume']},
                                         caveats=['WHEN crashes start, not WHICH tokens crash: hour pattern disappears against volume baseline (p=%.2f)' % o['chi2_volume_24h']['p']]))
    return out

def a_seasonality():
    d = J('seasonality.json'); f = d['findings']; sig = [x for x in f if (x.get('q') or 1) < 0.05]
    best = min(f, key=lambda x: x.get('q') or 1)
    return [R('seasonality', 'Session seasonality (Asia / London / US windows)', 'patterns', 'volatility', 'descriptive', 'data/seasonality.json', d.get('live_rule', '')[:300],
              crash={'n_events': len(f), 'n_pos': len(sig), 'p': rnd(best.get('q'), 6), 'lift': rnd(best.get('vol_ratio'), 3), 'significant_findings': len(sig), 'tests': len(f)},
              caveats=['volatility timing (BH-corrected q), not a crash/pump selector'])]

def a_contractscan():
    d = J('contractscan_corr.json'); best = None
    for c in d['comparisons']:
        for f in c.get('features') or []:
            if best is None or (f.get('p') or 1) < (best[1].get('p') or 1): best = (c, f)
    if not best: return [R('contractscan', 'Contract vulnerability scan', 'rug', 'crash', 'leading', 'data/contractscan_corr.json', 'no comparison with enough tokens', caveats=d.get('caveats', [])[:2])]
    c, f = best
    return [R('contractscan', 'Contract vulnerability scan (best feature: %s)' % f['feature'], 'rug', 'crash', 'leading', 'data/contractscan_corr.json', c['label'],
              crash=cc(f['with_outcome'], f['n_outcome'], f['with_control'], f['n_control'], p=f['p'], odds_ratio=f.get('odds_ratio')), caveats=['crashed vs runner comparison had too few runners scanned (%s)' % d['comparisons'][0].get('note', '')] + d.get('caveats', [])[:2])]

def a_rug_cases():
    d = J('rug_cases.json'); b = d['backtest_static']; ts = d['backtest_timeseries']
    return [R('rug_forecast_static', 'Rug forecast >= 30 (static signals)', 'rug', 'crash', 'leading', 'data/rug_cases.json', 'rug score >= 30, died vs mooned memecoins',
              crash=cc(b['died_flagged_ge30'], b['died_n'], b['mooned_flagged_ge30'], b['mooned_n']), pump=cc(b['mooned_flagged_ge30'], b['mooned_n'], b['died_flagged_ge30'], b['died_n']), caveats=[b['note'], ts['note']])]

def a_sentiment():
    d = J('sentiment_history.json'); T = d['tests']
    eu = next((t for t in T if t['name'].startswith('A1')), None); pa = next((t for t in T if 'panic' in t['name'].lower()), None)
    sub = lambda t: {'n_events': t['n'], 'hits': t['hits'], 'precision': t['hit_rate'], 'base_rate': t['base_rate'], 'lift': t['lift'], 'p': t.get('p_permutation'), 'n_pos': t['n']} if t else None
    return [R('sentiment_attention', 'Attention spikes (Wikipedia proxy)', 'sentiment', 'crash', 'leading', 'data/sentiment_history.json', d['summary_line'][:300], crash=sub(eu), pump=sub(pa))]

def a_regradar():
    d = J('regradar_study.json'); s = d['summary'].get('curated_all', {}).get('stats', {}).get('BTC', {}).get('0,1')
    return [R('regradar', 'Regulatory event radar', 'macro', 'volatility', 'leading', 'data/regradar_study.json', 'BTC return day 0..+1 after curated regulatory events vs placebo days',
              crash={'n_events': s['n'], 'n_pos': s['n'], 'p': rnd(s.get('p_placebo'), 4), 'lift': None} if s else None, caveats=d.get('caveats', [])[:2])]

def a_narratives():
    d = J('narratives_validation.json')
    return [R('narratives', 'Narrative rotation (%s)' % d.get('theme'), 'narratives', 'pump', 'leading', 'data/narratives_validation.json', d.get('rule', '')[:300],
              pump={'n_pos': len(d.get('episodes') or []), 'n_events': d.get('flagDays'), 'p': None, 'fp_flags_outside': d.get('flagsOutsideEpisodes')}, caveats=d.get('caveats', [])[:2])]

def a_stables():
    d = J('stables.json'); e = (d.get('backtest') or {}).get('ethereum', {}); t = e.get('targets', {}).get('ETH', {}).get('3d')
    if not t: return []
    return [R('stables_mint_spike', 'Stablecoin mint spikes', 'stables', 'pump', 'leading', 'data/stables.json', 'ETH 3d return after stablecoin mint spike days',
              pump={'n_events': t['n_spike'], 'precision': rnd(t['hit_spike']), 'base_rate': rnd(t['hit_base']), 'lift': rnd(t['hit_spike'] / t['hit_base']) if t['hit_base'] else None, 'p': rnd(t.get('perm_p'), 4), 'n_pos': t['n_spike']})]

def a_buyburn():
    d = J('buyburn_consistency.json'); x = d['score_vs_forward_returns_rolling']['fwd_6m']['pooled']
    return [R('buyburn', 'Buy-back / burn consistency score', 'fundamentals', 'pump', 'leading', 'data/buyburn_consistency.json', 'score vs forward 6m return (Spearman)',
              pump={'n_events': x['n'], 'n_pos': x['n'], 'p': rnd(x['p'], 4), 'rho': rnd(x['spearman_rho'], 3), 'auc': rnd(0.5 + x['spearman_rho'] / 2, 3)}, caveats=[x.get('note', '')])]

def a_macro_knn():
    d = J('macro_knn_eval.json'); w = d['with_macro']['ge30']; base = d['with_macro']['base']; n = d['with_macro']['samples']
    h = round(w['hit_rate'] * w['n'])
    return [R('crashmatch_knn_macro', 'Crash lookalike kNN + macro features', 'crash', 'crash', 'leading', 'data/macro_knn_eval.json', 'kNN odds >= 30% (with macro) -> -70% within 90d, leave-one-token-out',
              crash=fw(f"{h}/{w['n']}", f"{round(base * n)}/{n}", lead_h=None), caveats=[d['note'], 'days within a token overlap: p optimistic'])]

def a_crashmatch_catalog():
    d = J('crash_fingerprints.json')['backtest']; k = d['knn']['ge30']; base = d['base_rate_crash70_within90d']; n = d['samples']
    return [R('crashmatch_knn_catalog', 'Crash lookalike kNN (research LOO, catalog cases)', 'crash', 'crash', 'leading', 'data/crash_fingerprints.json', d['definition'],
              crash=fw(f"{round(k['hit_rate'] * k['n'])}/{k['n']}", f"{round(base * n)}/{n}"), caveats=['in-sample universe of the fingerprints (leave-one-token-out); the out-of-sample replay is crashmatch_knn'])]

def a_revival():
    d = J('revival_lab.json')['lookalike_backtest']; n = d['high_similarity_samples']
    return [R('revival_lookalike', 'Revival / breakout lookalike', 'sleepers', 'pump', 'leading', 'data/revival_lab.json', d['definition'],
              pump=fw(f"{round(d['breakout_rate_when_similarity_ge60'] * n)}/{n}", f"{round(d['base_breakout_rate_60d'] * d['samples'])}/{d['samples']}"), caveats=[d['verdict']])]

def a_birthphase():
    m = json.load(open(os.path.join(U.DATA_DIR, 'birthphase', 'model.json'))); b = next((x for x in m['backtest']['by'] if x['threshold'] == 1000000.0 and x['age_s'] == 1800), None) or next((x for x in m['backtest']['by'] if x['threshold'] == 1000000.0), m['backtest']['by'][0])
    at = next((x for x in b['at'] if x['p_ge'] == 0.2), b['at'][0]); base = b['test_rate']
    return [R('birthphase', 'Birth-phase launch model (P reach $%dK >= 20%%)' % (b['threshold'] / 1000), 'launch', 'pump', 'leading', 'data/birthphase/model.json', m['backtest']['method'],
              pump={'n_events': at['flagged'], 'hits': at['hits'], 'precision': rnd(at['precision']), 'recall': rnd(at['recall']), 'base_rate': rnd(base), 'lift': rnd(at['precision'] / base),
                    'n_pos': b['positives'], 'n_neg': b['n_test'] - b['positives'], 'auc': rnd(b['auc']), 'p': rnd(binom_sf(at['hits'], at['flagged'], base), 8), 'median_lead_h': rnd(b['age_s'] / 3600, 2)},
              caveats=['snapshot at %ds after launch; temporal hold-out' % b['age_s']])]

def _discover(d, path=''):
    """generic: find {died:{n,flagged},mooned:{n,flagged}} pairs and {auc,p} dicts anywhere in a backtest JSON (fakevolume, devactivity, Pattern Lab)."""
    found = []
    if isinstance(d, dict):
        if isinstance(d.get('died'), dict) and isinstance(d.get('mooned'), dict) and 'flagged' in d['died']: found.append(('cc', path, d))
        elif 'auc' in d and 'p' in d and isinstance(d.get('auc'), (int, float)): found.append(('mw', path, d))
        for k, v in d.items(): found += _discover(v, path + '.' + str(k))
    elif isinstance(d, list):
        for i, v in enumerate(d[:50]): found += _discover(v, path + f'[{i}]')
    return found

def generic(id, name, desk, claim, fname):
    d = J(fname)
    if d is None: return [R(id, name, desk, claim, 'leading', 'data/' + fname, 'backtest output not generated yet', caveats=['pending: data/%s missing' % fname])]
    F = _discover(d)
    if not F: return [R(id, name, desk, claim, 'leading', 'data/' + fname, 'no recognisable test in output', caveats=['inspect data/' + fname])]
    def pv(x):
        if x[0] == 'cc':
            q = x[2]; return enrich_p(q['died']['flagged'], q['died']['n'], q['mooned']['flagged'], q['mooned']['n']) or 1
        return x[2].get('p') or 1
    best = min(F, key=pv); q = best[2]
    if best[0] == 'cc':
        crash = cc(q['died']['flagged'], q['died']['n'], q['mooned']['flagged'], q['mooned']['n']); pump = cc(q['mooned']['flagged'], q['mooned']['n'], q['died']['flagged'], q['died']['n'])
    else:
        crash = mw(q); pump = None
    return [R(id, name, desk, claim, 'leading', 'data/' + fname, 'best of %d tests found at %s' % (len(F), best[1]), crash=crash, pump=pump, caveats=['multiple tests: picked the most significant (p not corrected)'] if len(F) > 1 else [])]

def untested(id, name, desk, claim, why):
    return R(id, name, desk, claim, 'leading', None, why, caveats=[why])

def all_records():
    out = []
    for fn in (a_liquidations, a_fundingdiv, a_orderbook, a_pricegaps, a_patterns, a_seasonality, a_contractscan, a_rug_cases, a_sentiment, a_regradar, a_narratives,
               a_stables, a_buyburn, a_macro_knn, a_crashmatch_catalog, a_revival, a_birthphase):
        out += _try(fn)
    out += generic('fakevolume', 'Fake / wash volume', 'rug', 'crash', 'fakevolume_backtest.json')
    out += generic('devactivity', 'Developer activity (silence / bursts)', 'fundamentals', 'crash', 'devactivity_backtest.json')
    out += [untested('perps_funding', 'Funding / OI crowding flags', 'perps', 'crash', 'no historical replay of the crowded-long/short flag yet (perps_stats has funding history; add a forward test)'),
            untested('unlocks', 'Token unlock dump risk', 'unlocks', 'crash', 'no backtest of unlock -> drawdown yet'),
            untested('copytrade', 'Copy-trade wallet buys', 'copytrade', 'pump', 'copy-trade study ranks wallets but has no forward test of their buys'),
            untested('priority', 'Priority watch (NEAR / ZEC)', 'priority', 'pump', 'two tokens; no backtest'),
            untested('riskinfra_oracle', 'Oracle manipulation / thin oracle pools', 'riskinfra', 'crash', 'no labelled incidents replayed yet'),
            untested('honeypot', 'Honeypot (cannot sell)', 'rug', 'rug', 'HARD flag: definitional (sells fail); too few labelled cases to measure'),
            untested('lp_pull', 'Liquidity pulled while price holds', 'rug', 'rug', 'HARD flag: definitional; live outcomes accumulate in fplog')]
    return out
