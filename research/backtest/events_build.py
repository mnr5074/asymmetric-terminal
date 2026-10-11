#!/usr/bin/env python3
"""Unified labelled event dataset: data/events_labeled.json — BOTH classes (pump and crash/rug) from every source we have.
Any detector (existing desks, Pattern Lab, future expansions) can score itself against it: an event says WHAT happened to WHICH
token WHEN; detectors supply their own signal times and the harness measures hit rate / lead time per class.

Event schema: {id, class: 'pump'|'crash'|'rug', key (chain:address when known), cg_id, symbol, chain, t (ms, the moment that
defines the event: breakout / peak / crash-crossing / rug), date, peak_t, magnitude (pump multiple, or crash depth %), source,
definition, has_series (daily series on disk for replays), quality ('confirmed'|'snapshot'|'live')}
Sources: daily series (cg_series + crash_series), crash catalog (860), final catalog eco tokens + launchpad leaderboard runners,
research DB cohorts (died / mooned), patterns_* cohorts, birthphase library outcomes, copy-trade runners, rug/exploit cases,
the live call log (calls.json: rugged / >=3x), and data/events_live.json (auto-ingested by lib/fplog.js on a schedule).
Stdlib only. Run: python3 research/backtest/events_build.py
"""
import json, os, sqlite3, glob, time, datetime as dt, hashlib
import universe as U
DATA_DIR = U.DATA_DIR; J = U.J
def to_ms(t):
    if t is None or t == '': return None
    if isinstance(t, str):
        try: return int(float(t)) if t.replace('.', '', 1).isdigit() else int(dt.datetime.fromisoformat(t.replace('Z', '+00:00')).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
        except Exception: return None
    t = float(t); return int(t * 1000) if t < 1e11 else int(t)
iso = lambda ms: dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).date().isoformat() if ms else None
ms_of = lambda d: int(dt.datetime.fromisoformat(d).replace(tzinfo=dt.timezone.utc).timestamp() * 1000) if d else None

def build():
    ev = {}
    def add(cls, src, t=None, key=None, cg=None, sym=None, chain=None, mag=None, peak_t=None, definition='', has_series=False, quality='confirmed', extra=None):
        t = to_ms(t); peak_t = to_ms(peak_t)
        tok = key or (('cg:' + cg) if cg else ('sym:' + (sym or '?').upper()))
        eid = hashlib.sha1(f'{cls}|{tok}|{iso(t) or ""}'.encode()).hexdigest()[:14]
        # one event per (class, token, day); first source wins, later ones are appended as corroboration
        if eid in ev: ev[eid]['sources'].append(src); return
        ev[eid] = {'id': eid, 'class': cls, 'key': key, 'cg_id': cg, 'symbol': (sym or '').upper() or None, 'chain': chain, 't': t, 'date': iso(t), 'peak_t': peak_t,
                   'magnitude': None if mag is None else round(mag, 3), 'source': src, 'sources': [src], 'definition': definition, 'has_series': has_series, 'quality': quality, **(extra or {})}
    # 1) daily series: computed labels (identical to the replay ground truth)
    for x in U.load():
        cg = x['id'] if x['src'] == 'cg_series' else None; ms = lambda i: ms_of(x['days'][i])
        if x['crash_i'] is not None:
            pk = x['peak_i']; add('crash', 'series:' + x['src'], ms(x['crash_i']), cg=cg, sym=x['symbol'], mag=-70.0, peak_t=ms(pk) if pk is not None else None,
                                 definition='close <= 30% of running peak close', has_series=True)
        if x['pump_i'] is not None:
            i = x['pump_i']; lo = min(x['px'][max(0, i - 30):i]); add('pump', 'series:' + x['src'], ms(i), cg=cg, sym=x['symbol'], mag=x['px'][i] / lo, definition='close >= 3x lowest close of prior 30d', has_series=True)
    # 2) crash catalog (CoinGecko ATH -> crash depth)
    cat = J('crash_catalog.json') or {}
    for c in cat.get('catalog', []):
        if (c.get('crash_depth_pct') or 0) <= -70:
            add('crash', 'crash_catalog', ms_of(c.get('ath_date')), cg=c.get('id'), sym=c.get('symbol'), mag=c.get('crash_depth_pct'), peak_t=ms_of(c.get('ath_date')),
                definition='>= 70% below ATH (t = ATH date; crash crossing unknown)', has_series=os.path.exists(os.path.join(DATA_DIR, 'cg_series', (c.get('id') or '') + '.json')), quality='snapshot',
                extra={'launchpad': c.get('launchpad')})
    fin = J('crash_catalog_final.json') or {}
    for e in fin.get('eco_tokens_ranked', []):
        d = e.get('crash_depth_pct') or 0; pk = ms_of(e.get('peak_date'))
        if d <= -70: add('crash', 'eco_catalog', pk, key=e.get('id'), sym=e.get('symbol'), chain=e.get('chain'), mag=d, peak_t=pk, definition='>= 70% below confirmed peak close', quality='snapshot')
        if (e.get('run_multiple_closes') or 0) >= 5: add('pump', 'eco_catalog', pk, key=e.get('id'), sym=e.get('symbol'), chain=e.get('chain'), mag=e['run_multiple_closes'], peak_t=pk, definition='>= 5x run in daily closes (t = peak date)', quality='snapshot')
    for lb in fin.get('leaderboard', []):
        for row in lb.get('notable_list') or []:
            try: sym, mcm, d, mult = row[:4]
            except Exception: continue
            if (mult or 0) >= 5: add('pump', 'launchpad_leaderboard', ms_of(d), sym=sym, mag=mult, peak_t=ms_of(d), definition=f'launchpad leaderboard runner ({lb.get("pad")})', quality='snapshot')
    # 3) research DB cohorts
    try:
        db = sqlite3.connect(os.path.join(DATA_DIR, 'moonshot.db'))
        for mint, sym, chain, pk, mult, cvp, cohort in db.execute("select mint,symbol,coalesce(chain,'solana'),peak_ts,multiple,cur_vs_peak,cohort from tokens where cohort in ('died','mooned')"):
            key = f'{chain}:{mint}'
            if cohort == 'mooned': add('pump', 'research_db:mooned', pk, key=key, sym=sym, chain=chain, mag=mult, peak_t=pk, definition='research DB mooned cohort (t = peak)', quality='snapshot')
            else: add('crash', 'research_db:died', pk, key=key, sym=sym, chain=chain, mag=(cvp - 1) * 100 if cvp is not None else None, peak_t=pk, definition='research DB died cohort (t = peak; crashed after)', quality='snapshot')
    except Exception as e: print('db', e)
    # 4) patterns_* cohorts (have break times)
    for f in ('patterns_flows.json', 'patterns_aging.json', 'patterns_wallets.json'):
        for t in (J(f) or {}).get('tokens', []):
            c = t.get('cohort'); key = 'solana:' + t['mint'] if t.get('mint') else None
            br = t.get('crash_break_t') or t.get('break_t'); pk = t.get('peak_t') or t.get('peak_ts')
            if c == 'died': add('crash', f, (br or pk or 0) * 1000 or None, key=key, sym=t.get('symbol'), chain='solana', peak_t=(pk or 0) * 1000 or None, definition='patterns cohort died (t = break)', quality='snapshot')
            elif c == 'mooned': add('pump', f, (pk or 0) * 1000 or None, key=key, sym=t.get('symbol'), chain='solana', mag=t.get('multiple'), definition='patterns cohort mooned (t = peak)', quality='snapshot')
    # 5) birthphase library (launch outcomes): pump = reached $1M mcap
    for fp in glob.glob(os.path.join(DATA_DIR, 'birthphase', '*.jsonl')):
        for line in open(fp):
            try: r = json.loads(line)
            except Exception: continue
            o = r.get('outcome') or {}
            if o.get('reached_1m'):
                t = o.get('peak_at') or r.get('graduation_ts') or r.get('created_ts') or None
                add('pump', 'birthphase:' + (r.get('launchpad') or '?'), t, key=r.get('key'), sym=r.get('symbol'), chain=r.get('chain'), mag=(o.get('peak_mcap_usd') or 1e6) / 1e5,
                    definition='launch reached $1M mcap (birthphase library; magnitude ~ x vs $100K)', quality='snapshot', extra={'launch_t': r.get('created_ts')})
    # 6) copy-trade runners
    for r in (J('copytrade_runners.json') or {}).get('runners', []):
        add('pump', 'copytrade_runners', None, key='solana:' + r['mint'] if r.get('mint') else None, sym=r.get('symbol'), chain='solana', mag=r.get('multiple'), definition='copy-trade study runner', quality='snapshot')
    # 7) rugs / exploits
    for c in (J('rug_cases.json') or {}).get('cases', []):
        add('rug', 'rug_cases:' + str(c.get('source', '')), ms_of(c.get('date')), sym=c.get('name'), mag=c.get('amountUsd'), definition=f"{c.get('type')}: {c.get('technique') or ''}".strip(), quality='snapshot')
    # 8) live call log: rugged / >= 3x since the call
    for c in (J('calls.json') or {}).get('calls', []):
        if c.get('rugged'): add('rug', 'calls', c.get('rugT') or c.get('lastT'), key=c['key'], sym=c.get('symbol'), chain=c.get('chain'), mag=-90.0, definition='live call log: price <= 10% of call or liquidity pulled / pair delisted', quality='live')
        elif c.get('px0') and c.get('maxPx', 0) >= 3 * c['px0']: add('pump', 'calls', c.get('lastT'), key=c['key'], sym=c.get('symbol'), chain=c.get('chain'), mag=c['maxPx'] / c['px0'], definition='live call log: >= 3x from call price', quality='live')
    # 9) auto-ingested live events (lib/fplog.js)
    for e in (J('events_live.json') or {}).get('events', []):
        add(e.get('class', 'pump'), 'live:' + e.get('source', 'fplog'), e.get('t'), key=e.get('key'), sym=e.get('symbol'), chain=e.get('chain'), mag=e.get('magnitude'), definition=e.get('definition', 'auto-ingested live outcome'), quality='live')
    out = sorted(ev.values(), key=lambda e: (e['t'] or 0))
    by = {}
    for e in out: by.setdefault(e['class'], {}).setdefault(e['source'].split(':')[0], 0); by[e['class']][e['source'].split(':')[0]] += 1
    return {'generatedAt': int(time.time() * 1000), 'schema': 'see research/backtest/events_build.py docstring', 'counts': {k: sum(v.values()) for k, v in by.items()}, 'by_source': by,
            'with_series': {k: sum(1 for e in out if e['class'] == k and e['has_series']) for k in by}, 'catalog_sizes': U.catalog_size(), 'events': out}

if __name__ == '__main__':
    d = build(); p = os.path.join(DATA_DIR, 'events_labeled.json'); json.dump(d, open(p + '.tmp', 'w'), separators=(',', ':')); os.replace(p + '.tmp', p)
    print('events_labeled.json', d['counts'], d['with_series'])
