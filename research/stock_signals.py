#!/usr/bin/env python3
"""Per-ticker stock signals for the options screener (keyless sources, verified 2026-10-11):
  - pre-market / after-hours price: Yahoo chart API with includePrePost (the v7 quote endpoint now returns Unauthorized)
  - up/down volume (10 sessions): Yahoo daily chart
  - headlines + simple lexicon sentiment: Yahoo Finance per-ticker RSS
  - SEC EDGAR (keyless, User-Agent required): recent 8-K filings, Form 4 insider transactions (open-market buys P / sales S), cluster buying
Not free / not implemented: 13F institutional changes per issuer (needs aggregation of every filer: WhaleWisdom/Fintel are paid),
real-time order flow and sweeps (Tradier / Unusual Whales / ThetaData / Polygon, paid). X sentiment: lib/xapi.js (paid, optional).
Cache: data/stock_signals.json, per ticker: prices 20 min, news 1 h, SEC 6 h."""
import json, os, re, time, urllib.request, html
from common import DATA_DIR
SEC_UA = {'User-Agent': os.environ.get('SEC_USER_AGENT', 'AsymmetricTerminal research contact@asymmetric-terminal.local'), 'Accept-Encoding': 'identity'}
WEB_UA = {'User-Agent': 'Mozilla/5.0 asymmetric-terminal'}
POS = ['surge', 'soar', 'rally', 'jump', 'record', 'beat', 'beats', 'upgrade', 'raises', 'raised', 'strong', 'growth', 'approval', 'approved', 'buyback', 'partnership', 'wins', 'gain', 'rise', 'bullish', 'outperform', 'tops', 'higher']
NEG = ['plunge', 'drop', 'falls', 'fall', 'slump', 'miss', 'misses', 'downgrade', 'cuts', 'cut', 'lawsuit', 'probe', 'investigation', 'recall', 'weak', 'loss', 'layoff', 'warns', 'warning', 'bearish', 'underperform', 'lower', 'fraud', 'delay', 'halt', 'sell-off', 'decline']
_last = {}
def get(url, hdr=WEB_UA, gap=0.0, timeout=20, raw=False):
    host = url.split('/')[2]; w = _last.get(host, 0) + gap - time.time()
    if w > 0: time.sleep(w)
    _last[host] = time.time()
    b = urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=timeout).read().decode('utf-8', 'ignore')
    return b if raw else json.loads(b)
def sentiment(t):
    s = t.lower(); p = sum(1 for w in POS if re.search(r'\b' + w + r'\b', s)); n = sum(1 for w in NEG if re.search(r'\b' + w + r'\b', s))
    return p - n
def ext_hours(sym):
    d = get(f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1d&interval=5m&includePrePost=true')['chart']['result'][0]
    m = d['meta']; per = m.get('currentTradingPeriod', {}); ts = d.get('timestamp') or []; cl = d['indicators']['quote'][0]['close']
    reg = m.get('regularMarketPrice'); prev = m.get('chartPreviousClose') or m.get('previousClose')
    last = next(((t, c) for t, c in zip(reversed(ts), reversed(cl)) if c), None)
    out = {'regular': reg, 'prev_close': prev, 'session': 'regular', 'ext_price': None, 'ext_pct': None}
    if last:
        t, c = last
        if t >= per.get('post', {}).get('start', 1e20): out.update(session='after-hours', ext_price=c, ext_pct=(c / reg - 1) * 100 if reg else None)
        elif t < per.get('regular', {}).get('start', 0): out.update(session='pre-market', ext_price=c, ext_pct=(c / prev - 1) * 100 if prev else None)
    return out
def updown(sym):
    d = get(f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1mo&interval=1d')['chart']['result'][0]['indicators']['quote'][0]
    up = dn = 0.0
    rows = [(o, c, v) for o, c, v in zip(d['open'], d['close'], d['volume']) if o and c and v][-10:]
    for o, c, v in rows: (up := up + v) if c >= o else (dn := dn + v)
    return {'up_volume_share_10d': up / (up + dn) if up + dn else None, 'sessions': len(rows)}
def news(sym):
    x = get(f'https://feeds.finance.yahoo.com/rss/2.0/headline?s={sym}&region=US&lang=en-US', raw=True)
    items = []
    for it in re.findall(r'<item>(.*?)</item>', x, re.S)[:10]:
        t = html.unescape((re.search(r'<title>(.*?)</title>', it, re.S) or [None, ''])[1]).strip()
        l = (re.search(r'<link>(.*?)</link>', it, re.S) or [None, ''])[1].strip(); d = (re.search(r'<pubDate>(.*?)</pubDate>', it) or [None, ''])[1]
        if t: items.append({'title': t[:200], 'link': l, 'date': d, 'sent': sentiment(t)})
    return items
_cik = None
def cik_of(sym):
    global _cik
    if _cik is None:
        f = os.path.join(DATA_DIR, 'sec_tickers.json')
        try:
            if time.time() - os.path.getmtime(f) > 7 * 86400: raise FileNotFoundError
            _cik = json.load(open(f))
        except Exception:
            _cik = {v['ticker']: v['cik_str'] for v in get('https://www.sec.gov/files/company_tickers.json', SEC_UA, 0.15).values()}; json.dump(_cik, open(f, 'w'))
    return _cik.get(sym.replace('.', '-')) or _cik.get(sym)
def sec(sym, max_f4=8):
    cik = cik_of(sym)
    if not cik: return {'note': 'no SEC CIK (ETF/fund or foreign issuer)'}
    d = get(f'https://data.sec.gov/submissions/CIK{int(cik):010d}.json', SEC_UA, 0.15); r = d['filings']['recent']
    now = time.time(); d8, f4 = [], []
    for i in range(min(len(r['form']), 200)):
        age = (now - time.mktime(time.strptime(r['filingDate'][i], '%Y-%m-%d'))) / 86400
        if r['form'][i] == '8-K' and age <= 14: d8.append({'date': r['filingDate'][i], 'items': r.get('items', [''] * 999)[i], 'url': f"https://www.sec.gov/Archives/edgar/data/{cik}/{r['accessionNumber'][i].replace('-', '')}/{r['primaryDocument'][i]}"})
        if r['form'][i] == '4' and age <= 90 and len(f4) < max_f4: f4.append((r['accessionNumber'][i], r['primaryDocument'][i], r['filingDate'][i]))
    tx = []
    for acc, doc, date in f4:
        try:
            x = get(f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{doc.split('/')[-1]}", SEC_UA, 0.15, raw=True)
            who = (re.findall(r'<rptOwnerName>(.*?)</rptOwnerName>', x) or ['?'])[0]; title = (re.findall(r'<officerTitle>(.*?)</officerTitle>', x) or [''])[0]
            for blk in re.findall(r'<nonDerivativeTransaction>(.*?)</nonDerivativeTransaction>', x, re.S):
                code = (re.findall(r'<transactionCode>(\w)</transactionCode>', blk) or [''])[0]
                sh = float((re.findall(r'<transactionShares>\s*<value>([\d.]+)', blk) or [0])[0]); px = float((re.findall(r'<transactionPricePerShare>\s*<value>([\d.]+)', blk) or [0])[0])
                plan = '10b5-1' in x
                if code in ('P', 'S'): tx.append({'date': date, 'who': who[:40], 'title': title[:30], 'code': code, 'shares': sh, 'usd': sh * px, 'plan_10b5_1': plan})
        except Exception: pass
    buys30 = [t for t in tx if t['code'] == 'P' and (now - time.mktime(time.strptime(t['date'], '%Y-%m-%d'))) / 86400 <= 30]
    sells30 = [t for t in tx if t['code'] == 'S' and (now - time.mktime(time.strptime(t['date'], '%Y-%m-%d'))) / 86400 <= 30]
    return {'cik': cik, 'name': d.get('name'), 'filings_8k_14d': d8[:5], 'insider_tx_90d': tx[:20], 'form4_parsed': len(f4),
            'insider_buy_usd_30d': sum(t['usd'] for t in buys30), 'insider_sell_usd_30d': sum(t['usd'] for t in sells30),
            'cluster_buying': len({t['who'] for t in buys30}) >= 2 and sum(t['usd'] for t in buys30) >= 100000, 'buyers_30d': len({t['who'] for t in buys30})}
def x_sentiment(sym):
    """X/social data is fetched server-side by lib/xapi.js (budget-capped, top-ranked tickers only), not here."""
    return None

def collect(tickers, log=print):
    f = os.path.join(DATA_DIR, 'stock_signals.json')
    try: S = json.load(open(f))
    except Exception: S = {}
    now = time.time(); stats = {'price': 0, 'news': 0, 'sec': 0, 'errors': 0}
    for sym in tickers:
        e = S.setdefault(sym, {})
        try:
            if now - e.get('t_px', 0) > 1200: e['ext'] = ext_hours(sym); e['flowvol'] = updown(sym); e['t_px'] = now; stats['price'] += 1
            if now - e.get('t_news', 0) > 3600: e['news'] = news(sym); e['t_news'] = now; stats['news'] += 1
            if now - e.get('t_sec', 0) > 6 * 3600: e['sec'] = sec(sym); e['t_sec'] = now; stats['sec'] += 1
            xs = x_sentiment(sym)
            if xs: e['x'] = xs
        except Exception as ex: stats['errors'] += 1; e['error'] = str(ex)[:100]
    json.dump(S, open(f, 'w'))
    log('stock signals', len(tickers), stats)
    return S

def adjust(p, s, flow=None):
    """Signal points for one pick (+ favours the pick's direction). Returns (points, plain-English reasons)."""
    if not s: return 0, []
    up = 1 if p['type'] == 'call' else -1; pts, why = 0, []
    sc = s.get('sec') or {}
    if sc.get('cluster_buying'): pts += 4 * up if up > 0 else -2; why.append(f"{sc['buyers_30d']} insiders bought shares on the open market in the last 30 days (${sc['insider_buy_usd_30d']:,.0f}): insiders buying with their own money is a bullish sign.")
    elif sc.get('insider_buy_usd_30d', 0) > 0: pts += 1 * up; why.append(f"An insider bought ${sc['insider_buy_usd_30d']:,.0f} of shares in the last 30 days.")
    if sc.get('insider_sell_usd_30d', 0) > 5e6: pts -= 2 * up; why.append(f"Insiders sold ${sc['insider_sell_usd_30d']:,.0f} in 30 days (often planned 10b5-1 sales, so a weaker signal than buying).")
    ns = s.get('news') or []
    net = sum(n['sent'] for n in ns[:8])
    if net >= 2: pts += 2 * up; why.append(f'Recent headlines lean positive (tone +{net}).')
    elif net <= -2: pts -= 2 * up; why.append(f'Recent headlines lean negative (tone {net}).')
    fv = s.get('flowvol') or {}; u = fv.get('up_volume_share_10d')
    cpr = (flow or {}).get('call_put_vol')
    if u is not None and cpr is not None:
        if u > 0.6 and cpr > 1.5: pts += 2 * up; why.append(f'Buyers in control: {u * 100:.0f}% of the last 10 sessions\' volume came on up days and calls outtraded puts {cpr:.1f}:1.')
        elif u < 0.4 and cpr < 0.67: pts -= 2 * up; why.append(f'Sellers in control: only {u * 100:.0f}% of volume on up days and puts outtraded calls.')
    ex = s.get('ext') or {}
    if ex.get('ext_pct') is not None and abs(ex['ext_pct']) >= 3: why.append(f"{ex['session']} move {ex['ext_pct']:+.1f}% (${ex['ext_price']:.2f}): option prices shown are from the last regular session and will reprice at the open.")
    if sc.get('filings_8k_14d'): why.append(f"Fresh 8-K filing on {sc['filings_8k_14d'][0]['date']} (material event, items {sc['filings_8k_14d'][0]['items'] or '?'}): read it before trading.")
    return max(-6, min(6, pts)), why
if __name__ == '__main__':
    import sys; r = collect(sys.argv[1:] or ['MU', 'AAPL'])
    for k, v in r.items(): print(k, json.dumps({a: b for a, b in v.items() if a in ('ext', 'flowvol')}), (v.get('sec') or {}).get('insider_buy_usd_30d'), (v.get('sec') or {}).get('insider_sell_usd_30d'), len(v.get('news') or []))
