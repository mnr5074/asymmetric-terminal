#!/usr/bin/env python3
"""Optionable US stocks/ETFs universe (NASDAQ, NYSE, NYSE American, NYSE Arca, Cboe BZX listings).
Sources (keyless, checked 2026-10-11): OCC product directory (marketdata.theocc.com delo-download) = every optionable underlying;
nasdaqtrader.com nasdaqtraded.txt = listing exchange / ETF flag / test issues; api.nasdaq.com screener = price, volume, market cap.
Value filter: stocks with market cap >= $300M and >= $5M/day traded; ETFs: all optionable ETFs (no free volume field) then pruned by
option open interest seen on the first CBOE scan (see options.py rotation). Output: data/opt_universe.json (refresh weekly)."""
import json, os, time, urllib.request
from common import DATA_DIR
UA = {'User-Agent': 'Mozilla/5.0 asymmetric-terminal', 'Accept': 'application/json,text/plain,*/*'}
def fetch(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read().decode('utf-8', 'ignore')
def num(s):
    try: return float(str(s).replace('$', '').replace(',', '').replace('%', '') or 0)
    except Exception: return 0.0
def main():
    occ = fetch('https://marketdata.theocc.com/delo-download?prodType=ALL&downloadFields=OS;US;SN&format=txt')
    und = {}
    for l in occ.splitlines():
        p = l.split('\t')
        if len(p) >= 3 and p[1].strip(): und.setdefault(p[1].strip(), p[2].strip())
    nt = fetch('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt').splitlines()
    hdr = nt[0].split('|'); listed = {}
    for l in nt[1:]:
        r = dict(zip(hdr, l.split('|')))
        if r.get('Test Issue') == 'Y' or r.get('Listing Exchange') not in ('N', 'A', 'P', 'Q', 'Z'): continue
        listed[r['Symbol']] = {'exch': {'N': 'NYSE', 'A': 'NYSE American', 'P': 'NYSE Arca', 'Q': 'NASDAQ', 'Z': 'Cboe BZX'}[r['Listing Exchange']], 'etf': r.get('ETF') == 'Y', 'name': r.get('Security Name', '')[:60]}
    scr = {r['symbol']: r for r in json.loads(fetch('https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true'))['data']['rows']}
    out, skipped = [], {'not_listed': 0, 'small_or_illiquid': 0}
    for s in und:
        if s not in listed: skipped['not_listed'] += 1; continue
        L = listed[s]; r = scr.get(s, {})
        px, vol, mc = num(r.get('lastsale')), num(r.get('volume')), num(r.get('marketCap'))
        dv = px * vol
        if not L['etf'] and (mc < 3e8 or dv < 5e6): skipped['small_or_illiquid'] += 1; continue
        out.append({'s': s, 'exch': L['exch'], 'etf': L['etf'], 'name': L['name'], 'mcap': mc or None, 'dollar_vol': dv or None})
    out.sort(key=lambda x: -(x['dollar_vol'] or 0))
    res = {'generatedAt': int(time.time() * 1000), 'optionable_underlyings_occ': len(und), 'listed_on_target_exchanges': sum(1 for s in und if s in listed),
           'kept': len(out), 'kept_stocks': sum(not x['etf'] for x in out), 'kept_etfs': sum(x['etf'] for x in out), 'skipped': skipped, 'symbols': out}
    json.dump(res, open(os.path.join(DATA_DIR, 'opt_universe.json'), 'w'))
    print({k: v for k, v in res.items() if k != 'symbols'})
if __name__ == '__main__': main()
