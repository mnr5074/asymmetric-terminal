#!/usr/bin/env python3
"""Token unlock calendar for catalog + watchlist + sleeper tokens -> data/unlocks_calendar.json.
Source (free): DefiLlama unlocks page data (defillama.com/unlocks, __NEXT_DATA__); their JSON API api.llama.fi/emissions
and /emission/{protocol} return HTTP 402 (paid). Not used (paid / blocked): Tokenomist (HTTP 403), TokenUnlocks (now Tokenomist),
CryptoRank vesting (paid API), Messari unlocks (paid). Note: data/unlocks.json is a different, older export owned by
research/rugwatch.py (read by lib/rugrisk.js) and is left untouched.
Per token: upcoming cliff events (date, tokens, % of circulating, USD at current price, category) and linear emissions
integrated per vesting stream for 7/14/30d and 1m/3m/6m/9m/1y/2y/3y windows. Estimates, not financial advice."""
import json, os, re, time, urllib.request
from common import DATA_DIR

UA = {'user-agent': 'Mozilla/5.0 (asymmetric-terminal research)'}
WINDOWS = {'7d': 7, '14d': 14, '30d': 30, '1m': 30, '3m': 91, '6m': 182, '9m': 273, '1y': 365, '2y': 730, '3y': 1095}
INSIDER = {'insiders', 'privateSale'}

def page_data(url):
    h = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90).read().decode()
    return json.loads(re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', h, re.S).group(1))['props']['pageProps']

def rj(f):
    try: return json.load(open(os.path.join(DATA_DIR, f)))
    except Exception: return None

def section(desc):
    m = re.search(r'(?:from|of) (.+?)(?: on \{timestamp\}| tokens will| on|$)', desc or '')
    return (m.group(1) if m else desc or '?').strip()

def linear_tokens(events, t0, t1):
    """Integrate linear vesting streams over [t0, t1] (unix s). Each linear event sets a stream's rate (tokens/week) from its timestamp."""
    streams = {}
    for e in sorted([e for e in events if e.get('unlockType') == 'linear'], key=lambda e: e['timestamp']):
        k = (e.get('category'), section(e.get('description')))
        n = e.get('noOfTokens') or [0, 0]
        streams.setdefault(k, []).append((e['timestamp'], float(n[-1] or 0) / 7 / 86400, float(e.get('rateDurationDays') or 0)))  # tokens per second
    total, by_cat, rate_now = 0.0, {}, 0.0
    for (cat, _), ch in streams.items():
        for i, (ts, r, dur) in enumerate(ch):
            # a stream's last rate runs until the next change, or for rateDurationDays when it is the final event
            te = ch[i + 1][0] if i + 1 < len(ch) else (ts + dur * 86400 if dur > 0 else float('inf'))
            if ts <= t0 < te: rate_now += r * 86400
            a, b = max(ts, t0), min(te, t1)
            if b > a and r > 0:
                total += r * (b - a); by_cat[cat] = by_cat.get(cat, 0) + r * (b - a)
    return total, by_cat, rate_now

def chart_total(chart, ts):
    r = None
    for x in chart:
        if x['timestamp'] / 1000 <= ts: r = x
        else: break
    return sum(v for k, v in r.items() if k != 'timestamp' and isinstance(v, (int, float))) if r else 0.0

def main():
    pp = page_data('https://defillama.com/unlocks'); now = time.time()
    cat = rj('crash_catalog.json') or {}; sl = rj('sleepers.json') or {}; wl = rj('perps_watch.json') or {}
    ids = {c['id']: c['symbol'].upper() for c in cat.get('catalog', [])}
    syms = {c['symbol'].upper(): 'catalog' for c in cat.get('catalog', [])}
    for c in (sl.get('items') or []) + (sl.get('laggards') or []): ids.setdefault(c['id'], c['symbol'].upper()); syms.setdefault(c['symbol'].upper(), 'sleepers')
    for s in wl: syms.setdefault(s.upper(), 'watchlist')
    pu = rj('perps_universe.json') or {}
    for t in pu.get('tokens', []): syms.setdefault(t['sym'].upper(), 'perps')
    import glob
    for f in glob.glob(os.path.join(DATA_DIR, 'buyburn*.json')):
        try:
            bb = json.load(open(f)); toks = bb.get('tokens', bb)
            for k in (toks.keys() if isinstance(toks, dict) else [x.get('sym') or x.get('symbol') for x in toks]):
                if k: syms.setdefault(str(k).upper(), 'buyburn')
        except Exception: pass
    out = []
    for x in pp['data']:
        sym = (x.get('tSymbol') or '').upper(); gid = x.get('gecko_id')
        src = 'catalog' if gid and gid in ids else syms.get(sym)
        circ = x.get('circSupply') or None; px = x.get('tPrice')
        ev = x.get('events') or []; chart = None; detail = 'list page (next event only)'
        if src and x.get('protocolSlug'):  # universe token: the per-protocol page carries the FULL future schedule
            try:
                em = page_data(f"https://defillama.com/unlocks/{x['protocolSlug']}")['emissions']
                ev = em.get('events') or ev; chart = (em.get('chartData') or {}).get('documented') or None; detail = 'protocol page (full schedule)'
                time.sleep(0.5)
            except Exception as e:
                detail = f'protocol page failed ({str(e)[:60]}); list page only'
        cl = {}
        for e in ev:
            if e.get('unlockType') != 'cliff' or not (now <= e['timestamp'] <= now + 1095 * 86400) or e.get('category') == 'burned': continue
            d = time.strftime('%Y-%m-%d', time.gmtime(e['timestamp'])); k = (d, e.get('category') or 'other')
            c = cl.setdefault(k, {'date': d, 'ts': e['timestamp'], 'category': k[1], 'tokens': 0.0, 'streams': set()})
            c['tokens'] += float(sum(e.get('noOfTokens') or [0])); c['streams'].add(section(e.get('description')))
        cliffs = sorted(cl.values(), key=lambda c: c['ts'])
        for c in cliffs:
            c['streams'] = sorted(c['streams'])[:4]; c['pctCirc'] = c['tokens'] / circ * 100 if circ else None; c['usd'] = c['tokens'] * px if px else None
            c['daysAway'] = round((c['ts'] - now) / 86400, 1)
        win = {}
        for w, days in WINDOWS.items():
            t1 = now + days * 86400
            cliff_t = sum(c['tokens'] for c in cliffs if c['ts'] <= t1); ins = sum(c['tokens'] for c in cliffs if c['ts'] <= t1 and c['category'] in INSIDER)
            lin, lin_cat, _ = linear_tokens(ev, now, t1)
            ins += sum(v for k, v in lin_cat.items() if k in INSIDER)
            tot = cliff_t + lin
            if chart:  # cross-check with DefiLlama's cumulative unlock chart (daily); prefer it for the total
                ct = chart_total(chart, t1) - chart_total(chart, now)
                if ct is not None and ct >= 0: tot = ct; lin = max(0.0, ct - cliff_t)
            win[w] = {'cliffTokens': cliff_t, 'linearTokens': lin, 'tokens': tot, 'insiderTokens': ins, 'pctCirc': tot / circ * 100 if circ else None, 'usd': tot * px if px else None}
        _, _, rate_now = linear_tokens(ev, now, now + 1)
        out.append({'scheduleDetail': detail, 'sym': sym, 'name': x.get('name'), 'geckoId': gid, 'slug': x.get('protocolSlug'), 'inUniverse': src, 'price': px, 'circ': circ, 'maxSupply': x.get('maxSupply'),
                    'locked': x.get('totalLocked'), 'linearPerDayNow': rate_now, 'llamaUnlocksPerDay': x.get('unlocksPerDay'),
                    'cliffs': [c for c in cliffs if c['daysAway'] <= 365][:40], 'windows': win, 'url': f"https://defillama.com/unlocks/{x.get('protocolSlug')}"})
    res = {'generatedAt': int(now * 1000), 'source': 'DefiLlama unlocks page data (defillama.com/unlocks, free; api.llama.fi/emissions is paid HTTP 402)',
           'notUsed': {'api.llama.fi/emissions & /emission/{protocol}': 'HTTP 402 paid plan', 'Tokenomist / TokenUnlocks': 'HTTP 403 / paid API', 'CryptoRank vesting': 'paid API', 'Messari unlocks': 'paid API', 'project docs': 'not machine-readable at scale; not scraped'},
           'method': 'Cliffs = scheduled one-time releases grouped by date and category. Linear = continuous vesting streams integrated over each window from DefiLlama rate-change events. % of circulating uses DefiLlama circSupply; USD uses DefiLlama current token price.',
           'coverage': {'llamaTokens': len(out), 'inUniverse': sum(1 for t in out if t['inUniverse'])}, 'tokens': out}
    tmp = os.path.join(DATA_DIR, 'unlocks_calendar.json.tmp'); json.dump(res, open(tmp, 'w')); os.replace(tmp, os.path.join(DATA_DIR, 'unlocks_calendar.json'))
    print('unlocks_calendar:', res['coverage'])

if __name__ == '__main__': main()
