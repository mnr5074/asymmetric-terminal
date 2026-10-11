#!/usr/bin/env python3
"""Detector 3 upgrade with Nansen (user-approved): labelled exchange movement for the 50-token flows backtest sample.
 A) profiler/address/transactions (1 credit) for each token's deployer in [created-2d, peak+7d]: any token/SOL sent to a Nansen
    exchange-labelled address (incl. deposit wallets).
 B) tgm/transfers (1 credit) per token with include_cex=true only: ANY wallet moving the token to/from a CEX in the same window.
Guards: key only from env NANSEN_API_KEY (never printed); per-call ledger with credits used + balance before/after
(data/patterns_nansen_ledger.json); hard cap MAX_CREDITS (default 100); refuses any endpoint priced >=100 (label endpoints);
stops if balance would fall below FLOOR (300). Responses cached in data/patterns_cache/nansen/.
Usage: patterns_nansen.py backtest [max_credits]"""
import json, os, re, sys, time, urllib.request, urllib.error, datetime as dt
KEY = os.environ.get('NANSEN_API_KEY', '')  # read BEFORE patterns_common strips it from the env
sys.path.insert(0, os.path.dirname(__file__))
from patterns_common import DATA_DIR, CACHE, log, save, mwu
BASE = 'https://api.nansen.ai/api/v1/'
COST = {'account': 0, 'profiler/address/transactions': 1, 'tgm/transfers': 1, 'tgm/who-bought-sold': 1}
FLOOR = 300
LEDGER = os.environ.get('PATTERNS_NANSEN_LEDGER') or os.path.join(DATA_DIR, 'patterns_nansen_ledger.json')
EXCH = re.compile(r'(binance|coinbase|okx|okex|bybit|kraken|kucoin|gate\.io|gate |htx|huobi|mexc|bitget|bingx|crypto\.com|bitfinex|bitstamp|upbit|bithumb|lbank|bitmart|whitebit|poloniex|exchange|deposit|\bcex\b|hot wallet)', re.I)
NOTCEX = re.compile(r'(dex|router|bot|aggregator|swap|liquidity|pool|fee|jito|program|vault|bridge)', re.I)
is_cex = lambda lab: bool(lab) and bool(EXCH.search(lab)) and not NOTCEX.search(lab)
L = {'calls': [], 'used': 0, 'remaining': None}
try: L.update(json.load(open(LEDGER)))
except Exception: pass
RUN_USED = 0

def call(ep, body, max_credits):
    global RUN_USED
    if not KEY: raise RuntimeError('NANSEN_API_KEY not set')
    cost = COST.get(ep)
    if cost is None or cost >= 100: raise RuntimeError(f'refusing {ep}: unknown or >=100-credit endpoint')
    ck = os.path.join(CACHE, 'nansen'); os.makedirs(ck, exist_ok=True)
    f = os.path.join(ck, (ep.replace('/', '_') + '_' + str(abs(hash(json.dumps(body, sort_keys=True)))))[:150] + '.json')
    # deterministic cache key (hash() is salted per process) -> use sha1
    import hashlib; f = os.path.join(ck, ep.replace('/', '_') + '_' + hashlib.sha1(json.dumps(body, sort_keys=True).encode()).hexdigest()[:20] + '.json')
    if os.path.exists(f): return json.load(open(f)), True
    if RUN_USED + cost > max_credits: raise StopIteration('run credit cap reached')
    if L['remaining'] is not None and L['remaining'] - cost < FLOOR: raise StopIteration(f'balance floor {FLOOR} would be crossed')
    before = L['remaining']
    req = urllib.request.Request(BASE + ep, data=json.dumps(body).encode() if body is not None else None, method='POST' if body is not None else 'GET',
                                 headers={'apikey': KEY, 'content-type': 'application/json', 'accept': 'application/json'})
    status, used, rem, j = None, 0, None, None
    for k in range(3):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                status = r.status; used = float(r.headers.get('x-nansen-credits-used') or 0); rem = r.headers.get('x-nansen-credits-remaining'); j = json.loads(r.read().decode())
            break
        except urllib.error.HTTPError as e:
            status = e.code; used = float(e.headers.get('x-nansen-credits-used') or 0); rem = e.headers.get('x-nansen-credits-remaining')
            if e.code == 429 and k < 2: time.sleep(8 * (k + 1)); continue
            j = {'error': e.read().decode()[:300]}; break
    RUN_USED += used; L['used'] += used
    if rem is not None: L['remaining'] = float(rem)
    L['calls'].append({'t': int(time.time()), 'ep': ep, 'status': status, 'credits_used': used, 'balance_before': before, 'balance_after': L['remaining']})
    json.dump(L, open(LEDGER, 'w'))
    log(f'nansen {ep} status={status} used={used} balance {before} -> {L["remaining"]}')
    if status == 200: json.dump(j, open(f, 'w'))
    time.sleep(1.2)
    return j, False

iso = lambda t: dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def backtest(max_credits):
    fl = json.load(open(os.path.join(DATA_DIR, 'patterns_flows.json')))
    import sqlite3
    db = sqlite3.connect(f"file:{os.path.join(DATA_DIR, 'moonshot.db')}?mode=ro", uri=True)
    acct, _ = call('account', None, max_credits)
    if isinstance(acct, dict) and acct.get('credits_remaining') is not None: L['remaining'] = float(acct['credits_remaining'])
    log('balance at start', L['remaining'])
    out, stopped = [], None
    toks = fl['tokens']
    for t in toks:
        r = db.execute('select dev, created_ts, peak_ts from tokens where mint=?', (t['mint'],)).fetchone()
        dev, cts, pts = r if r else (None, None, None)
        t0 = (cts // 1000 if cts else t['peak_t'] - 3 * 86400) - 2 * 86400; t1 = min(t['peak_t'] + 7 * 86400, int(time.time()))
        rec = {'mint': t['mint'], 'symbol': t['symbol'], 'cohort': t['cohort'], 'peak_t': t['peak_t'], 'break_t': t.get('crash_break_t'), 'dev': dev, 'dev_cex': [], 'token_cex': [], 'dev_tx_rows': None, 'token_cex_rows': None, 'labels_seen': []}
        try:
            if dev:
                j, _ = call('profiler/address/transactions', {'address': dev, 'chain': 'solana', 'date': {'from': iso(t0), 'to': iso(t1)}, 'hide_spam_token': False, 'pagination': {'page': 1, 'per_page': 100}}, max_credits)
                rows = (j or {}).get('data') or []
                rec['dev_tx_rows'] = len(rows) if isinstance(rows, list) else None
                for x in rows if isinstance(rows, list) else []:
                    ts = x.get('block_timestamp')
                    for s in x.get('tokens_sent') or []:
                        lab = s.get('to_address_label') or ''
                        if lab: rec['labels_seen'].append(lab[:60])
                        if is_cex(lab):
                            rec['dev_cex'].append({'t': ts, 'to': s.get('to_address'), 'label': lab, 'token': s.get('token_symbol'), 'amount': s.get('token_amount'), 'usd': s.get('value_usd') or x.get('volume_usd')})
            j, _ = call('tgm/transfers', {'chain': 'solana', 'token_address': t['mint'], 'date': {'from': iso(t0), 'to': iso(t1)}, 'filters': {'include_cex': True, 'include_dex': False, 'non_exchange_transfers': False}, 'pagination': {'page': 1, 'per_page': 100}}, max_credits)
            rows = (j or {}).get('data') or []
            rec['token_cex_rows'] = len(rows) if isinstance(rows, list) else None
            for x in rows if isinstance(rows, list) else []:
                lab = (x.get('to_address_label') or '') + ' | ' + (x.get('from_address_label') or '')
                rec['token_cex'].append({'t': x.get('block_timestamp'), 'from': x.get('from_address'), 'to': x.get('to_address'), 'to_label': x.get('to_address_label'), 'from_label': x.get('from_address_label'), 'usd': x.get('transfer_value_usd'), 'type': x.get('transaction_type'),
                                         'to_cex': is_cex(x.get('to_address_label') or ''), 'tx': x.get('transaction_hash')})
            # router pattern: CEX-labelled address forwards the token onward in the same tx -> not a deposit
            fwd = {(e['tx'], e['from']) for e in rec['token_cex']}
            for e in rec['token_cex']:
                if e['to_cex'] and (e['tx'], e['to']) in fwd: e['to_cex'] = False; e['router_forward'] = True
        except StopIteration as e: stopped = str(e); log('STOP', e); out.append(rec); break
        except Exception as e: rec['err'] = str(e)[:150]
        def ts(s):
            try: return int(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp())
            except Exception: return None
        for k in ('dev_cex', 'token_cex'):
            for e in rec[k]:
                e['ts'] = ts(e['t']) if e.get('t') else None
                if e['ts']: e['h_vs_peak'] = round((e['ts'] - t['peak_t']) / 3600, 1); e['lead_h_before_break'] = round((t['crash_break_t'] - e['ts']) / 3600, 1) if t.get('crash_break_t') else None
        rec['labels_seen'] = sorted(set(rec['labels_seen']))[:25]
        out.append(rec); log(t['symbol'], t['cohort'], 'dev rows', rec['dev_tx_rows'], 'dev->cex', len(rec['dev_cex']), 'token cex rows', rec['token_cex_rows'])
    D = [r for r in out if r['cohort'] == 'died']; M = [r for r in out if r['cohort'] == 'mooned']
    pre = lambda e: e.get('h_vs_peak') is not None and e['h_vs_peak'] <= 0
    dep = lambda r: [e for e in r['dev_cex']] + [e for e in r['token_cex'] if e['to_cex']]
    rate = lambda g, f: {'n': len(g), 'flagged': sum(1 for r in g if f(r)), 'rate': round(sum(1 for r in g if f(r)) / len(g), 3) if g else None}
    res = {'endpoints': ['profiler/address/transactions (deployer)', 'tgm/transfers include_cex (token)'], 'stopped': stopped, 'credits_used_this_run': RUN_USED,
           'balance_end': L['remaining'], 'sample': {'died': len(D), 'mooned': len(M), 'devs_queried': sum(1 for r in out if r['dev_tx_rows'] is not None), 'tokens_queried': sum(1 for r in out if r['token_cex_rows'] is not None)},
           'dev_to_cex': {'died': rate(D, lambda r: bool(r['dev_cex'])), 'mooned': rate(M, lambda r: bool(r['dev_cex']))},
           'any_to_cex': {'died': rate(D, lambda r: bool(dep(r))), 'mooned': rate(M, lambda r: bool(dep(r)))},
           'any_to_cex_before_peak': {'died': rate(D, lambda r: any(pre(e) for e in dep(r))), 'mooned': rate(M, lambda r: any(pre(e) for e in dep(r)))},
           'token_cex_any_direction': {'died': rate(D, lambda r: bool(r['token_cex'])), 'mooned': rate(M, lambda r: bool(r['token_cex']))},
           'lead_h_before_break_died': sorted(e['lead_h_before_break'] for r in D for e in dep(r) if e.get('lead_h_before_break') is not None),
           'tokens': out}
    save('patterns_nansen.json', res)
    res['billing'] = {'nansen_credits_used_this_run': RUN_USED, 'nansen_paid_calls_total': sum(1 for c in L['calls'] if c['credits_used']), 'ledger': 'data/patterns_nansen_ledger.json', 'x_calls': 0, 'free_hosts': res['billing']['hosts']}
    p = os.path.join(DATA_DIR, 'patterns_nansen.json'); json.dump(res, open(p, 'w'), default=str)

if __name__ == '__main__':
    backtest(int(sys.argv[2]) if len(sys.argv) > 2 else 100)
