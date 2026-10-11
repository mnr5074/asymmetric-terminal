"""Narratives Desk: theme rotation detector (stdlib only, free keyless sources).
Writes data/narratives.json, data/narratives_boost.json, data/narratives_history.json and (with --validate,
or when stale) data/narratives_validation.json. No X API calls, no Nansen.

Sources: CoinGecko /coins/categories + /coins/markets?category= (mcap, 24h/7d/30d changes, breadth),
DefiLlama /protocols (+ chain TVL history for L2s), DexScreener profiles / boosts / takeovers, pump.fun latest
launches, the live feed (data/live_feed.json), crypto RSS (The Block, Decrypt, Cointelegraph, CoinDesk),
Google News RSS search, Wikipedia pageviews. Google Trends (pytrends) is tried and reported if blocked."""
import json, os, sys, time, math, re, statistics, datetime as dt, urllib.request, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import get, DATA_DIR
from narratives_taxonomy import THEMES, WIKI_BENCH

NOW = time.time()
CACHE = os.path.join(DATA_DIR, 'narratives_cache'); os.makedirs(CACHE, exist_ok=True)
STATUS = {}
UAH = {'user-agent': 'Mozilla/5.0 (asymmetric-terminal narratives research, read-only)'}
LN = math.log
RX = {k: re.compile(v['kw'], re.I) for k, v in THEMES.items()}

def jdump(name, obj):
    p = os.path.join(DATA_DIR, name); tmp = p + '.tmp'
    with open(tmp, 'w') as f: json.dump(obj, f, separators=(',', ':'))
    os.replace(tmp, p)

def jload(name, default=None):
    try:
        with open(os.path.join(DATA_DIR, name)) as f: return json.load(f)
    except Exception: return default

def text(url, timeout=25):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UAH), timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')

def cached(key, ttl, fn):
    p = os.path.join(CACHE, re.sub(r'[^A-Za-z0-9_.-]', '_', key) + '.json')
    try:
        if NOW - os.path.getmtime(p) < ttl:
            with open(p) as f: return json.load(f)
    except Exception: pass
    v = fn()
    if v is not None:
        with open(p, 'w') as f: json.dump(v, f)
    return v

def tag(s):
    s = s or ''
    return [k for k, rx in RX.items() if rx.search(s)]

def med(a):
    a = [x for x in a if x is not None]
    return statistics.median(a) if a else None

def r2(x, n=2):
    return None if x is None else round(x, n)

# ---------------------------------------------------------------- CoinGecko
def is_junk(c):
    n = (c.get('name') or '').lower(); s = (c.get('symbol') or '').lower()
    if any(w in n for w in ('wrapped', 'bridged', 'staked ', 'liquid staked', 'stablecoin')): return True
    if len(s) > 3 and re.search(r'(btc|eth|sol)$', s): return True   # LSTs / LRTs / wrapped majors track BTC/ETH/SOL, not the theme
    c7, c30 = c.get('price_change_percentage_7d_in_currency'), c.get('price_change_percentage_30d_in_currency')
    if c7 is not None and c30 is not None and abs(c7) < 0.6 and abs(c30) < 1.5: return True   # price-stable products (T-bill/HELOC/yield tokens)
    p = c.get('current_price') or 0
    if 0.97 <= p <= 1.03 and abs(c.get('price_change_percentage_7d_in_currency') or 0) < 1.0 and ('usd' in s or 'usd' in n or 'eur' in s): return True
    return False

def coingecko():
    cats = cached('cg_categories', 2 * 3600, lambda: get('https://api.coingecko.com/api/v3/coins/categories'))
    catmap = {c['id']: c for c in (cats or [])}
    STATUS['coingecko_categories'] = f'ok ({len(catmap)} categories)' if catmap else 'failed'
    need = sorted({c for t in THEMES.values() for c in t['cg']})
    lists = {}
    for cid in need:
        if cid not in catmap: STATUS.setdefault('cg_missing_categories', []).append(cid); continue
        try:
            u = ('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1'
                 f'&category={cid}&price_change_percentage=24h,7d,30d&sparkline=false')
            lists[cid] = cached('cg_cat_' + cid, 3 * 3600, lambda u=u: get(u)) or []
        except Exception as e:
            STATUS.setdefault('cg_failed_categories', []).append(f'{cid}: {e}')
    top = []
    for page in (1, 2):
        u = ('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250'
             f'&page={page}&price_change_percentage=24h,7d,30d&sparkline=false')
        try: top += cached(f'cg_top_{page}', 3 * 3600, lambda u=u: get(u)) or []
        except Exception as e: STATUS['cg_top'] = 'failed: ' + str(e)
    glob = None
    try: glob = cached('cg_global', 3 * 3600, lambda: get('https://api.coingecko.com/api/v3/global'))
    except Exception as e: STATUS['cg_global'] = 'failed: ' + str(e)
    STATUS['coingecko_markets'] = f'ok ({len(lists)} category lists, top {len(top)} coins)'
    return catmap, lists, top, glob

def agg_coins(coins):
    """market cap now / 7d / 30d ago from per-coin % changes (coins missing a change are excluded from that ratio)."""
    now = sum(c.get('market_cap') or 0 for c in coins)
    def ago(k):
        a = b = 0
        for c in coins:
            m, ch = c.get('market_cap') or 0, c.get(k)
            if m and ch is not None and ch > -99.9: a += m; b += m / (1 + ch / 100)
        return (a, b)
    return now, ago('price_change_percentage_7d_in_currency'), ago('price_change_percentage_30d_in_currency'), ago('price_change_percentage_24h_in_currency')

# ---------------------------------------------------------------- DefiLlama
def defillama():
    out = {'byCat': {}, 'l2': None}
    try:
        P = cached('llama_protocols', 3 * 3600, lambda: get('https://api.llama.fi/protocols', timeout=60)) or []
        for p in P:
            c = p.get('category'); tv = p.get('tvl') or 0
            if not c or not tv or tv < 0: continue
            d = out['byCat'].setdefault(c, {'tvl': 0, 'tvl7': 0, 'tvl7cov': 0, 'n': 0, 'top': []})
            d['tvl'] += tv; d['n'] += 1
            ch = p.get('change_7d')
            if ch is not None and ch > -99.9: d['tvl7'] += tv / (1 + ch / 100); d['tvl7cov'] += tv
            d['top'].append((tv, p.get('name')))
        for d in out['byCat'].values(): d['top'] = [n for _, n in sorted(d['top'], reverse=True)[:5]]
        STATUS['defillama_protocols'] = f'ok ({len(P)} protocols)'
    except Exception as e: STATUS['defillama_protocols'] = 'failed: ' + str(e)
    l2 = ['Base', 'Arbitrum', 'Optimism', 'Linea', 'Scroll', 'zkSync Era', 'Starknet', 'Blast', 'Mantle', 'Unichain']
    tot = {'now': 0, 'd7': 0, 'd30': 0, 'chains': []}
    for ch in l2:
        try:
            h = cached('llama_chain_' + ch, 6 * 3600, lambda ch=ch: get('https://api.llama.fi/v2/historicalChainTvl/' + urllib.parse.quote(ch))) or []
            if len(h) < 31: continue
            tot['now'] += h[-1]['tvl']; tot['d7'] += h[-8]['tvl']; tot['d30'] += h[-31]['tvl']; tot['chains'].append(ch)
        except Exception as e: STATUS.setdefault('llama_chain_failed', []).append(ch)
    if tot['chains']: out['l2'] = tot
    return out

# ---------------------------------------------------------------- Wikipedia pageviews
def wiki_series(article, start, end):
    u = f'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/{urllib.parse.quote(article, safe="")}/daily/{start}/{end}'
    try:
        d = json.loads(text(u))
        return {i['timestamp'][:8]: i['views'] for i in d.get('items', [])}
    except Exception: return None

def wikipedia():
    end = (dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - dt.timedelta(days=1)).strftime('%Y%m%d')
    start = (dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - dt.timedelta(days=75)).strftime('%Y%m%d')
    arts = sorted({a for t in THEMES.values() for a in t['wiki']} | set(WIKI_BENCH))
    S = {}
    for a in arts:
        s = cached(f'wiki_{a}_{end}', 20 * 3600, lambda a=a: wiki_series(a, start, end))
        if s: S[a] = s
        time.sleep(0.1)
    STATUS['wikipedia'] = f'ok ({len(S)}/{len(arts)} articles)'
    days = sorted({d for s in S.values() for d in s})[-35:]
    bench = {d: sum(S.get(a, {}).get(d, 0) for a in WIKI_BENCH) for d in days}
    out = {}
    for k, t in THEMES.items():
        av = [a for a in t['wiki'] if a in S]
        if not av or len(days) < 35: continue
        v = {d: sum(S[a].get(d, 0) for a in av) for d in days}
        r7 = sum(v[d] for d in days[-7:]) / max(1, sum(bench[d] for d in days[-7:]))
        r28 = sum(v[d] for d in days[:28]) / max(1, sum(bench[d] for d in days[:28]))
        out[k] = {'articles': av, 'views7d': sum(v[d] for d in days[-7:]), 'viewsPrior28d': sum(v[d] for d in days[:28]),
                  'share7': r7, 'sharePrior28': r28, 'av': LN(r7 / r28) if r7 > 0 and r28 > 0 else None}
    return out

def google_trends():
    try:
        from pytrends.request import TrendReq  # optional; Google usually answers 429 to datacenter IPs
        p = TrendReq(hl='en-US', tz=0, timeout=(10, 25)); p.build_payload(['zcash'], timeframe='today 3-m'); p.interest_over_time()
        STATUS['google_trends'] = 'reachable (not yet wired into the score)'
    except ImportError: STATUS['google_trends'] = 'skipped: pytrends not installed'
    except Exception as e: STATUS['google_trends'] = 'blocked: ' + type(e).__name__ + ' (Google rate-limits this server IP); not used'

# ---------------------------------------------------------------- news
FEEDS = [('The Block', 'https://www.theblock.co/rss.xml'), ('Decrypt', 'https://decrypt.co/feed'),
         ('Cointelegraph', 'https://cointelegraph.com/rss'), ('CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/')]
GNEWS = {'privacy_zk': 'zcash OR monero OR "privacy coin" OR "dark pool" crypto', 'zk_tech': '"zero-knowledge" OR zkVM OR "zk rollup" crypto',
         'ai_agents': '"AI agent" crypto token', 'ai_infra': 'bittensor OR "decentralized AI" crypto', 'rwa': '"real-world assets" OR "tokenized treasury" crypto',
         'tokenized_stocks': '"tokenized stocks" OR xStocks OR "tokenized equities"', 'perps_dex': 'hyperliquid OR "perp DEX" OR "perpetual DEX"',
         'memes': 'memecoin OR "meme coin"', 'depin': 'DePIN crypto', 'restaking': 'restaking OR eigenlayer', 'prediction_markets': 'polymarket OR kalshi OR "prediction market" crypto',
         'stablecoin_payments': 'stablecoin payments', 'l2': '"layer 2" OR arbitrum OR optimism crypto', 'gaming': 'web3 gaming OR gamefi crypto',
         'quantum': 'quantum bitcoin OR "quantum resistant" crypto', 'socialfi': 'socialfi OR infofi OR kaito crypto', 'btcfi': 'BTCfi OR "bitcoin layer 2" OR "bitcoin staking"', 'launchpads': 'crypto launchpad token sale ICO'}

def parse_items(xml):
    out = []
    for m in re.finditer(r'<item\b[\s\S]*?</item>', xml):
        it = m.group(0)
        g = lambda tag: (re.search(rf'<{tag}[^>]*>([\s\S]*?)</{tag}>', it) or [None, ''])[1]
        t = re.sub(r'<!\[CDATA\[([\s\S]*?)\]\]>', r'\1', g('title')); t = re.sub(r'<[^>]+>', '', t).replace('&amp;', '&').replace('&#39;', "'").replace('&quot;', '"').strip()
        link = re.sub(r'<!\[CDATA\[([\s\S]*?)\]\]>', r'\1', g('link')).strip()
        pd = g('pubDate')
        try: ts = dt.datetime.strptime(pd.strip()[:25], '%a, %d %b %Y %H:%M:%S').replace(tzinfo=dt.timezone.utc).timestamp()
        except Exception: ts = None
        if t: out.append({'title': t, 'link': link, 'ts': ts})
    return out

def news():
    seen = jload('narratives_news_seen.json', {}) or {}
    items = []
    for name, url in FEEDS:
        try:
            x = parse_items(text(url)); STATUS['rss_' + name] = f'ok ({len(x)})'
            for i in x: i['src'] = name
            items += x
        except Exception as e: STATUS['rss_' + name] = 'failed: ' + str(e)
    for i in items:
        if i['ts'] and i['link'] not in seen: seen[i['link']] = {'ts': i['ts'], 'title': i['title'][:200], 'themes': tag(i['title'])}
    seen = {k: v for k, v in seen.items() if NOW - v['ts'] < 45 * 86400}
    jdump('narratives_news_seen.json', seen)
    # RSS: theme mentions in the last 72h (and since the store started), counted per headline
    span_days = (NOW - min([v['ts'] for v in seen.values()] or [NOW])) / 86400
    rss = {k: {'h24': 0, 'h72': 0, 'd7': 0, 'all': 0, 'heads': []} for k in THEMES}
    for v in sorted(seen.values(), key=lambda v: -v['ts']):
        age = (NOW - v['ts']) / 3600
        for k in v['themes']:
            r = rss[k]; r['all'] += 1
            if age <= 24: r['h24'] += 1
            if age <= 72: r['h72'] += 1
            if age <= 168: r['d7'] += 1
            if len(r['heads']) < 3 and age <= 168: r['heads'].append(v['title'])
    tot72 = sum(1 for v in seen.values() if NOW - v['ts'] <= 72 * 3600)
    # Google News: per-theme 7-day search, daily buckets; velocity = last 2 days vs the earlier complete days
    gn = {}
    for k, q in GNEWS.items():
        try:
            x = cached(f'gnews_{k}', 3 * 3600, lambda q=q: parse_items(text('https://news.google.com/rss/search?q=' + urllib.parse.quote(q + ' when:7d') + '&hl=en-US&gl=US&ceid=US:en')))
            ts = sorted([i['ts'] for i in x if i['ts']], reverse=True)
            sat = len(x) >= 100
            oldest = ts[-1] if ts else NOW
            cut = oldest if sat else NOW - 7 * 86400
            recent = sum(1 for t in ts if NOW - t <= 2 * 86400)
            older_days = (NOW - 2 * 86400 - cut) / 86400
            older = sum(1 for t in ts if NOW - t > 2 * 86400 and t >= cut)
            vel = (recent / 2) / (older / older_days) if older_days >= 1.5 and older > 0 else None
            gn[k] = {'n7d': len(x), 'last48h': recent, 'saturated': sat, 'perDayRecent': recent / 2, 'perDayOlder': r2(older / older_days, 2) if older_days >= 1.5 else None, 'ratio': vel}
            time.sleep(0.8)
        except Exception as e: gn[k] = {'error': str(e)}
    ok = sum(1 for v in gn.values() if 'n7d' in v); STATUS['google_news'] = f'ok ({ok}/{len(GNEWS)} themes)'
    # normalise Google-News velocity by the median across themes (removes "all crypto news is up today")
    rat = [v['ratio'] for v in gn.values() if v.get('ratio')]
    m = med(rat) or 1
    for v in gn.values():
        if v.get('ratio'): v['relAv'] = LN(v['ratio'] / m)
    return rss, tot72, span_days, gn

# ---------------------------------------------------------------- launches: DexScreener + pump.fun + live feed
def launches():
    toks = {}  # key chain:address -> rec
    def add(chain, addr, src, **kw):
        if not chain or not addr: return
        k = f'{chain}:{addr}'
        r = toks.setdefault(k, {'chain': chain, 'address': addr, 'src': set(), 'text': '', 'boost': 0})
        r['src'].add(src)
        for a, b in kw.items():
            if a == 'text': r['text'] += ' ' + (b or '')
            elif a == 'boost': r['boost'] = max(r['boost'], b or 0)
            elif b is not None: r[a] = b
    DS = 'https://api.dexscreener.com'
    for src, u in [('ds-profile', '/token-profiles/latest/v1'), ('ds-boost', '/token-boosts/latest/v1'), ('ds-topboost', '/token-boosts/top/v1'), ('ds-cto', '/community-takeovers/latest/v1')]:
        try:
            d = get(DS + u) or []
            for x in d: add(x.get('chainId'), x.get('tokenAddress'), src, text=x.get('description'), boost=x.get('totalAmount') or x.get('amount'))
            STATUS[src] = f'ok ({len(d)})'
        except Exception as e: STATUS[src] = 'failed: ' + str(e)
    # names/symbols/age/returns for DexScreener tokens
    bych = {}
    for k, r in toks.items(): bych.setdefault(r['chain'], []).append(r['address'])
    for ch, addrs in bych.items():
        for i in range(0, len(addrs), 30):
            try:
                pairs = get(f'{DS}/tokens/v1/{ch}/' + ','.join(addrs[i:i + 30])) or []
                best = {}
                for p in pairs:
                    a = (p.get('baseToken') or {}).get('address')
                    if a and ((p.get('liquidity') or {}).get('usd') or 0) >= ((best.get(a, {}).get('liquidity') or {}).get('usd') or 0): best[a] = p
                for a, p in best.items():
                    r = toks.get(f'{ch}:{a}')
                    if not r: continue
                    r['text'] += ' ' + (p['baseToken'].get('name') or '') + ' ' + (p['baseToken'].get('symbol') or '')
                    r.update(symbol=p['baseToken'].get('symbol'), name=p['baseToken'].get('name'), mcap=p.get('marketCap') or p.get('fdv'),
                             ch24=(p.get('priceChange') or {}).get('h24'), ageH=(NOW * 1000 - p['pairCreatedAt']) / 3600e3 if p.get('pairCreatedAt') else None)
            except Exception: pass
    # pump.fun newest launches (pre-graduation bonding curves)
    n = 0
    for off in (0, 50, 100, 150):
        try:
            d = get(f'https://frontend-api-v3.pump.fun/coins?offset={off}&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false') or []
            for c in d:
                add('solana', c.get('mint'), 'pump-new', text=f"{c.get('name')} {c.get('symbol')} {c.get('description') or ''}", symbol=c.get('symbol'), name=c.get('name'),
                    mcap=c.get('usd_market_cap'), ageH=(NOW * 1000 - c['created_timestamp']) / 3600e3 if c.get('created_timestamp') else None, preGrad=not c.get('complete'))
            n += len(d)
        except Exception as e: STATUS['pump_fun'] = 'failed: ' + str(e); break
    if n: STATUS['pump_fun'] = f'ok ({n} newest launches)'
    # live feed (the pump detector's universe)
    lf = jload('live_feed.json', {}) or {}
    for x in lf.get('items', []):
        pre = 'pump-new' in (x.get('sources') or []) or x.get('dex') in ('pumpfun', 'meteoradbc', 'fourmeme')
        add(x.get('chain'), x.get('address'), 'live-feed', text=f"{x.get('name')} {x.get('symbol')}", symbol=x.get('symbol'), name=x.get('name'), mcap=x.get('mcap') or x.get('fdv'),
            ch24=x.get('ch24'), ageH=x.get('ageH'), grade=x.get('grade'), score=x.get('score'), veto=x.get('veto'), preGrad=pre or None, sim=(x.get('features') or {}).get('sim'))
    STATUS['live_feed'] = f"ok ({len(lf.get('items', []))} items, generated {dt.datetime.fromtimestamp((lf.get('generatedAt') or 0) / 1000, dt.timezone.utc).replace(tzinfo=None).isoformat()}Z)" if lf else 'missing'
    for r in toks.values():
        r['themes'] = tag(r['text']); r['src'] = sorted(r['src']); r.pop('text', None)
    return toks

# ---------------------------------------------------------------- scoring
def pct_rank(vals, x):
    v = sorted(a for a in vals if a is not None)
    if x is None or not v: return None
    return sum(1 for a in v if a < x) / max(1, len(v) - 1) if len(v) > 1 else 0.5

def build():
    catmap, lists, top, glob = coingecko()
    llama = defillama()
    wk = wikipedia()
    google_trends()
    rss, tot72, newsSpan, gn = news()
    toks = launches()
    hist = jload('narratives_history.json', {'snaps': []}) or {'snaps': []}
    prev = [s for s in hist['snaps'] if NOW - s['t'] > 6 * 3600]  # baselines at least 6h old

    tn, t7, t30, t24 = agg_coins([c for c in top if not is_junk(c)])
    total_now = (glob or {}).get('data', {}).get('total_market_cap', {}).get('usd') or tn
    g7 = t7[0] / t7[1] if t7[1] else 1; g30 = t30[0] / t30[1] if t30[1] else 1; g24 = t24[0] / t24[1] if t24[1] else 1
    fresh = [r for r in toks.values() if r.get('ageH') is not None and r['ageH'] <= 72]
    launches24 = [r for r in toks.values() if r.get('ageH') is not None and r['ageH'] <= 24]
    allMed24 = med([r.get('ch24') for r in fresh if r.get('ch24') is not None])
    boostTot = sum(r['boost'] for r in toks.values()) or 0
    xdata = jload('narratives_x.json')
    if xdata and NOW - xdata.get('t', 0) / 1000 > 6 * 3600: xdata = None
    xr = [((v['last24h'] / 24) / (v['prior'] / v['priorHours'])) for v in ((xdata or {}).get('themes') or {}).values() if v.get('prior') and v.get('priorHours') and v.get('last24h')]
    xmed = med(xr)
    rows = {}
    for k, t in THEMES.items():
        coins = {}
        for cid in t['cg']:
            for c in lists.get(cid, []):
                if c['id'] in t.get('exclude', []): continue
                if not is_junk(c) and (c.get('market_cap') or 0) > 0: coins[c['id']] = c
        coins = list(coins.values())
        now, a7, a30, a24 = agg_coins(coins)
        gr7 = a7[0] / a7[1] - 1 if a7[1] else None; gr30 = a30[0] / a30[1] - 1 if a30[1] else None; gr24 = a24[0] / a24[1] - 1 if a24[1] else None
        share = now / total_now if total_now else None
        mv7 = LN((1 + gr7) / g7) if gr7 is not None else None
        mv30 = LN((1 + gr30) / g30) if gr30 is not None else None
        big = [c for c in coins if (c.get('market_cap') or 0) >= 1e6]
        def breadth(key):
            v = [c.get(key) for c in big if c.get(key) is not None]
            return sum(1 for x in v if x > 0) / len(v) if v else None
        b24, b7, b30 = breadth('price_change_percentage_24h_in_currency'), breadth('price_change_percentage_7d_in_currency'), breadth('price_change_percentage_30d_in_currency')
        tv = {'now': 0, 'd7': 0, 'cov': 0, 'cats': [], 'top': []}
        for lc in t['llama']:
            d = llama['byCat'].get(lc)
            if d: tv['now'] += d['tvl']; tv['d7'] += d['tvl7']; tv['cov'] += d['tvl7cov']; tv['cats'].append(lc); tv['top'] += d['top'][:3]
        tvl7 = (tv['cov'] / tv['d7'] - 1) if tv['d7'] else None
        if k == 'l2' and llama.get('l2'):
            L2 = llama['l2']; tv = {'now': L2['now'], 'cats': ['chain TVL: ' + ', '.join(L2['chains'])], 'top': L2['chains'][:3]}; tvl7 = L2['now'] / L2['d7'] - 1 if L2['d7'] else None
        mine = [r for r in toks.values() if k in r['themes']]
        mfresh = [r for r in mine if r.get('ageH') is not None and r['ageH'] <= 72]
        ml24 = [r for r in mine if r.get('ageH') is not None and r['ageH'] <= 24]
        launchShare = len(ml24) / len(launches24) if launches24 else None
        boostShare = sum(r['boost'] for r in mine) / boostTot if boostTot else None
        newsShare = rss[k]['h72'] / tot72 if tot72 else None
        # attention velocity: average of available log-ratios (each source = theme share now vs its own baseline)
        av_parts = {}
        if wk.get(k, {}).get('av') is not None: av_parts['wikipedia'] = wk[k]['av']
        if gn.get(k, {}).get('relAv') is not None: av_parts['googleNews'] = gn[k]['relAv']
        xv = (xdata.get('themes') or {}).get(k) if xdata else None   # optional X counts (only exists if the OFF module is enabled)
        if xv and xv.get('prior') and xv.get('priorHours') and xv.get('last24h') is not None and xmed:
            av_parts['x'] = LN(((xv['last24h'] / 24) / (xv['prior'] / xv['priorHours'])) / xmed)
        base = [s['themes'].get(k) for s in prev if s['themes'].get(k)]
        if base:
            bl = med([b.get('launchShare') for b in base]); bn = med([b.get('newsShare') for b in base]); bb = med([b.get('boostShare') for b in base])
            if bl and launchShare is not None and len(launches24) >= 30: av_parts['launches'] = LN((launchShare + 0.01) / (bl + 0.01))
            if bn and newsShare is not None and tot72 >= 30: av_parts['rssNews'] = LN((newsShare + 0.01) / (bn + 0.01))
            if bb and boostShare is not None: av_parts['boosts'] = LN((boostShare + 0.01) / (bb + 0.01))
        av = sum(av_parts.values()) / len(av_parts) if av_parts else None
        # new entrants' returns (overcrowding)
        m24 = med([r.get('ch24') for r in mfresh if r.get('ch24') is not None]); n24 = sum(1 for r in mfresh if r.get('ch24') is not None)
        prevM = med([b.get('newMedian24') for b in base if b.get('newMedian24') is not None]) if base else None
        prevB7 = med([b.get('breadth7') for b in base if b.get('breadth7') is not None]) if base else None
        topc = sorted(coins, key=lambda c: -(c.get('market_cap') or 0))[:12]
        # concentration: how much of the theme's 7d market-cap change comes from its single biggest mover
        gains = [((c.get('market_cap') or 0) - (c.get('market_cap') or 0) / (1 + c['price_change_percentage_7d_in_currency'] / 100), c) for c in coins if c.get('price_change_percentage_7d_in_currency') not in (None,) and c['price_change_percentage_7d_in_currency'] > -99.9]
        net = sum(g for g, _ in gains); lead = max(gains, key=lambda x: x[0]) if gains else None
        leader = {'symbol': (lead[1].get('symbol') or '').upper(), 'gainUsd': lead[0], 'ch7': r2(lead[1].get('price_change_percentage_7d_in_currency'), 1), 'shareOfNetGain': (lead[0] / net if net > 0 else None)} if lead and lead[0] > 0 else None
        rows[k] = dict(id=k, name=t['name'], parent=t['parent'], blurb=t['blurb'], cgCategories=[c for c in t['cg'] if c in catmap],
            cgCategoryStats=[{'id': c, 'mcap': catmap[c].get('market_cap'), 'ch24': r2(catmap[c].get('market_cap_change_24h'))} for c in t['cg'] if c in catmap],
            nCoins=len(coins), mcap=now, mcapShare=share, mcapGrowth24=gr24, mcapGrowth7=gr7, mcapGrowth30=gr30, mcapShareVel7=mv7, mcapShareVel30=mv30,
            breadth24=b24, breadth7=b7, breadth30=b30, medianCh7=med([c.get('price_change_percentage_7d_in_currency') for c in big]),
            tvl=tv['now'] or None, tvlGrowth7=tvl7, tvlSources=tv['cats'], tvlTop=tv['top'][:4],
            wiki=wk.get(k), googleNews=gn.get(k), rss={kk: rss[k][kk] for kk in ('h24', 'h72', 'd7')}, headlines=rss[k]['heads'], newsShare=newsShare,
            launches24=len(ml24), launches72=len(mfresh), launchShare=launchShare, boostShare=boostShare, boostAmount=sum(r['boost'] for r in mine),
            leader7=leader, newMedian24=m24, newN24=n24, newMedian24Prev=prevM, breadth7Prev=prevB7, attentionVel=av, attentionParts=av_parts,
            tokens=[{'id': c['id'], 'symbol': (c.get('symbol') or '').upper(), 'name': c.get('name'), 'mcap': c.get('market_cap'), 'price': c.get('current_price'),
                     'ch24': r2(c.get('price_change_percentage_24h_in_currency'), 1), 'ch7': r2(c.get('price_change_percentage_7d_in_currency'), 1), 'ch30': r2(c.get('price_change_percentage_30d_in_currency'), 1)} for c in topc],
            newTokens=[{k2: r.get(k2) for k2 in ('chain', 'address', 'symbol', 'name', 'mcap', 'ageH', 'ch24', 'grade', 'preGrad', 'src', 'boost')} for r in sorted(mfresh, key=lambda r: r.get('ageH') or 0)[:10]])
    # momentum score: percentile of each input across themes (missing inputs drop out, weights renormalised)
    W = {'attentionVel': 30, 'mcapShareVel7': 20, 'mcapShareVel30': 5, 'tvlGrowth7': 15, 'breadth7': 15, 'launchShare': 5, 'boostShare': 5, 'newsShare': 5}
    for k, r in rows.items():
        s = w = 0; parts = {}
        for f, wt in W.items():
            p = pct_rank([x[f] for x in rows.values()], r[f])
            if p is None: continue
            parts[f] = round(p * 100); s += p * wt; w += wt
        r['momentum'] = round(100 * s / w) if w >= 40 else None
        r['momentumParts'] = parts
        # flags
        av, mv7 = r['attentionVel'], r['mcapShareVel7']
        r['emerging'] = bool(av is not None and mv7 is not None and av >= LN(1.5) and av - mv7 >= LN(1.3) and (r['mcapGrowth30'] is None or r['mcapGrowth30'] < 1.0))
        ov = []
        if r['launches24'] >= 8 and r['launchShare'] is not None and r['launchShare'] >= 0.15 and (r['newsShare'] or 0) < r['launchShare'] / 2:
            ov.append(f"supply glut: {r['launches24']} of {len(launches24)} launches seen in the last 24h ({r['launchShare']*100:.0f}%) are in this theme, far above its {100*(r['newsShare'] or 0):.0f}% share of news")
        if r['newMedian24'] is not None and r['newN24'] >= 5:
            if r['newMedian24'] < 0 and allMed24 is not None and r['newMedian24'] <= allMed24 - 10:
                ov.append(f"new entrants underwater: median 24h return of its {r['newN24']} tokens under 72h old is {r['newMedian24']:.0f}% vs {allMed24:.0f}% for all new tokens")
            if r['newMedian24Prev'] is not None and r['newMedian24'] < r['newMedian24Prev'] - 15:
                ov.append(f"new-entrant returns falling: median {r['newMedian24']:.0f}% vs {r['newMedian24Prev']:.0f}% in earlier snapshots")
        if r['mcapGrowth30'] is not None and r['breadth7'] is not None and r['breadth30'] is not None and r['mcapGrowth30'] > 0.25 and r['breadth7'] < 0.4 and r['breadth7'] < r['breadth30'] - 0.15:
            ov.append(f"breadth deteriorating: sector mcap +{r['mcapGrowth30']*100:.0f}% over 30d but only {r['breadth7']*100:.0f}% of its tokens are up this week (vs {r['breadth30']*100:.0f}% over 30d)")
        if r['breadth7Prev'] is not None and r['breadth7'] is not None and r['breadth7'] < r['breadth7Prev'] - 0.25:
            ov.append(f"breadth falling: {r['breadth7']*100:.0f}% of tokens up on the week vs {r['breadth7Prev']*100:.0f}% in earlier snapshots")
        r['crowding'] = ov
        r['crowdLevel'] = 'overcrowded' if len(ov) >= 2 else 'caution' if ov else 'ok'
        m = r['momentum']
        r['status'] = 'emerging' if r['emerging'] else 'heating' if (m is not None and m >= 65 and (mv7 or 0) >= LN(1.02) and (av is None or av >= 0)) else 'cooling' if (m is not None and m < 35) else 'neutral'
        r['plain'] = plain(r)
    ranked = sorted(rows.values(), key=lambda r: -(r['momentum'] if r['momentum'] is not None else -1))
    for i, r in enumerate(ranked): r['rank'] = i + 1
    # history snapshot
    hist['snaps'].append({'t': NOW, 'themes': {k: {f: r[f] for f in ('mcapShare', 'launchShare', 'newsShare', 'boostShare', 'newMedian24', 'breadth7', 'attentionVel', 'momentum')} for k, r in rows.items()}})
    hist['snaps'] = [s for s in hist['snaps'] if NOW - s['t'] < 60 * 86400][-500:]
    jdump('narratives_history.json', hist)
    boost = boosts(rows, toks)
    out = {'generatedAt': int(NOW * 1000), 'market': {'totalMcap': total_now, 'top500Growth7': g7 - 1, 'top500Growth30': g30 - 1, 'top500Growth24': g24 - 1},
           'launchesSeen24h': len(launches24), 'newTokensMedian24': allMed24, 'newsItems72h': tot72, 'newsStoreDays': round(newsSpan, 2), 'historySnapshots': len(hist['snaps']),
           'themes': ranked, 'flagged': [r['id'] for r in ranked if r['status'] in ('emerging', 'heating')], 'overcrowded': [r['id'] for r in ranked if r['crowdLevel'] != 'ok'],
           'boostSummary': {'tokens': len(boost['byKey']), 'positive': sum(1 for v in boost['byKey'].values() if v['boost'] > 0)},
           'sources': STATUS, 'xModule': x_estimate(15),
           'method': METHOD, 'disclaimer': 'Automated estimates from free public data. Not financial advice.'}
    jdump('narratives.json', out)
    return out

def plain(r):
    bits = []
    if r['attentionVel'] is not None: bits.append(f"attention share {'up' if r['attentionVel'] > 0 else 'down'} {abs(math.exp(r['attentionVel']) - 1) * 100:.0f}% vs its baseline")
    if r['mcapShareVel7'] is not None: bits.append(f"market-cap share {'up' if r['mcapShareVel7'] > 0 else 'down'} {abs(math.exp(r['mcapShareVel7']) - 1) * 100:.0f}% this week")
    if r['breadth7'] is not None: bits.append(f"{r['breadth7'] * 100:.0f}% of its tokens up on the week")
    if r['tvlGrowth7'] is not None: bits.append(f"TVL {r['tvlGrowth7'] * 100:+.1f}% 7d")
    L = r.get('leader7')
    if L and L.get('shareOfNetGain') and L['shareOfNetGain'] > 0.6 and (r['mcapGrowth7'] or 0) > 0: bits.append(f"note: {L['symbol']} ({L['ch7']:+.0f}% 7d) " + (f"added more than the theme's whole net weekly gain (the rest of the theme fell), so the move is concentrated" if L['shareOfNetGain'] > 1 else f"accounts for {L['shareOfNetGain'] * 100:.0f}% of the theme's net weekly gain, so the move is concentrated"))
    head = {'emerging': 'EMERGING: people are paying more attention faster than money has moved in.', 'heating': 'HEATING: momentum 65+ with market-cap share rising and attention not falling.',
            'cooling': 'Cooling: below most themes on attention and price momentum.', 'neutral': 'Neutral.'}[r['status']]
    return head + ' ' + '; '.join(bits) + '.' + (' Caution: ' + r['crowding'][0] + '.' if r['crowding'] else '')

def boosts(rows, toks):
    """Cross-reference with the pump detector: token in a heating/emerging theme AND matching early-launch / pre-graduation
    pattern -> boost (composite-grade points on a 0-100 scale). Overcrowded themes get a small penalty instead."""
    by = {}
    for k, r in toks.items():
        if not r['themes']: continue
        best = None
        for t in r['themes']:
            th = rows[t]; base = 6 if th['status'] == 'emerging' else 4 if th['status'] == 'heating' else 0
            if th['crowdLevel'] == 'overcrowded': base = -3
            elif th['crowdLevel'] == 'caution' and base > 0: base = base / 2
            if best is None or base > best[0]: best = (base, t)
        base, t = best
        early = r.get('ageH') is not None and r['ageH'] <= 24
        pre = bool(r.get('preGrad'))
        pattern = 'pre-graduation + <24h' if early and pre else '<24h launch' if early else 'pre-graduation' if pre else None
        ok_grade = r.get('veto') is None and (r.get('grade') in (None, 'A', 'B', 'C'))
        mult = 1.0 if (pattern and ok_grade) else 0.5 if ok_grade else 0
        b = round(base * mult, 1) if base > 0 else base
        if b == 0 and base >= 0: continue
        rec = {'theme': t, 'themeStatus': rows[t]['status'], 'crowd': rows[t]['crowdLevel'], 'pattern': pattern, 'boost': b, 'symbol': r.get('symbol'), 'chain': r['chain'], 'address': r['address'],
               'why': (f"{rows[t]['name']} is {rows[t]['status']}" + (f' and the token matches the {pattern} pattern' if pattern and b > 0 else '') + (f"; theme {rows[t]['crowdLevel']}" if rows[t]['crowdLevel'] != 'ok' else ''))}
        by[k] = rec
    sym = {}
    for th in rows.values():  # established tokens (CoinGecko) in flagged themes: small boost by symbol
        base = 3 if th['status'] == 'emerging' else 2 if th['status'] == 'heating' else 0
        if th['crowdLevel'] == 'overcrowded': base = -2
        elif th['crowdLevel'] == 'caution' and base > 0: base = 1
        if not base: continue
        for c in th['tokens']:
            s = c['symbol']
            if s and (s not in sym or base > sym[s]['boost']): sym[s] = {'theme': th['id'], 'themeStatus': th['status'], 'crowd': th['crowdLevel'], 'boost': base, 'coingeckoId': c['id'], 'why': f"{th['name']} is {th['status']}"}
    out = {'generatedAt': int(NOW * 1000), 'scale': 'points to add to a 0-100 composite score; range -3..+6',
           'readme': 'byKey is keyed "chain:address" (also byAddress by bare address); bySymbol for established CoinGecko tokens. Read boost, and why for the tooltip.',
           'byKey': by, 'byAddress': {v['address']: v for v in by.values()}, 'bySymbol': sym}
    jdump('narratives_boost.json', out)
    return out

def x_estimate(n_themes=15):
    """Optional X social-velocity input (OFF). Cost per day of the two ways to measure it. Prices: docs.x.com pricing page, checked 2026-10-11."""
    counts, post = 0.005, 0.005
    plans = []
    for per_day, label in [(1, 'daily'), (8, 'every 3h'), (24, 'hourly')]:
        plans.append({'refresh': label, 'countsRequestsPerDay': n_themes * per_day, 'countsUsdPerDay': round(n_themes * per_day * counts, 3),
                      'postsReadPerDay_20each': n_themes * per_day * 20, 'postsUsdPerDay_20each': round(n_themes * per_day * 20 * post, 2)})
    return {'enabled': False, 'themes': n_themes, 'pricing': 'Counts: Recent $0.005 per request (one request returns 7 days of hourly/daily counts for one query); Posts: Read $0.005 per post returned',
            'plans': plans, 'recommendation': f'counts/recent once per 3h for all {n_themes} themes = ${n_themes * 8 * counts:.2f}/day (~${n_themes * 8 * counts * 30:.0f}/month); reading 20 posts per theme instead would be ${n_themes * 8 * 20 * post:.2f}/day',
            'assumes': 'one counts response per query (7 days of hourly buckets); if X paginates the cost scales with pages',
            'note': 'Not called. Code is in lib/narratives.js xVelocity() (counts/recent, 15 theme queries per run); it runs only if X_ON is flipped in code AND NARRATIVES_X=1, after approval. It would share the existing X budget ($50/month cap).'}

METHOD = {
    'attention': 'Attention velocity = average of log(theme share now / its own baseline) across available sources: Wikipedia pageviews (theme articles / Bitcoin+Ethereum+Cryptocurrency+Solana+XRP articles, last 7d vs prior 28d), Google News 7-day search (last 48h per-day vs earlier days, divided by the median across themes), and once history exists: share of crypto RSS headlines, of new launches, of DexScreener boosts vs earlier snapshots.',
    'market': 'Market-cap share velocity = log(theme share of top-500 crypto market cap now / 7 days ago), from CoinGecko category coin lists (per-coin 7d/30d changes; stablecoins, wrapped and bridged tokens removed). Breadth = % of the theme\'s tokens (mcap >= $1M) up. TVL growth from DefiLlama protocol categories (L2s: chain TVL).',
    'momentum': 'Momentum 0-100 = percentile across themes of: attention velocity 30, mcap-share velocity 7d 20, 30d 5, TVL growth 15, breadth 15, launch share 5, boost share 5, news share 5 (missing inputs drop out).',
    'emerging': 'Emerging = attention velocity >= ln(1.5) (attention share up 50%+) AND attention velocity minus mcap-share velocity >= ln(1.3) (attention outrunning money) AND theme mcap not already doubled in 30d.',
    'overcrowding': 'Caution/overcrowded (1 / 2+ triggers): supply glut (>=15% of all launches seen in 24h and >2x its news share), new entrants\' median 24h return negative and 10pp below all new tokens or falling 15pp vs earlier snapshots, breadth deterioration (sector +25% in 30d but <40% of tokens up this week, or breadth down 25pp vs earlier snapshots).',
}

# ---------------------------------------------------------------- retrospective validation (privacy / ZEC)
def cb_daily(prod, start, end):
    out = {}; s = dt.datetime.fromisoformat(start); e = dt.datetime.fromisoformat(end)
    while s < e:
        t = min(s + dt.timedelta(days=290), e)
        d = get(f'https://api.exchange.coinbase.com/products/{prod}/candles?granularity=86400&start={s.isoformat()}Z&end={t.isoformat()}Z') or []
        for r in d: out[dt.datetime.fromtimestamp(r[0], dt.timezone.utc).strftime('%Y%m%d')] = r[4]
        s = t; time.sleep(0.4)
    return out

def kraken_daily(pair, since):
    d = get(f'https://api.kraken.com/0/public/OHLC?pair={pair}&interval=1440&since={int(since)}') or {}
    res = d.get('result', {}); k = [x for x in res if x != 'last']
    return {dt.datetime.fromtimestamp(r[0], dt.timezone.utc).strftime('%Y%m%d'): float(r[4]) for r in res.get(k[0], [])} if k else {}

def validate():
    start, end = '2025-03-01T00:00:00', (dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - dt.timedelta(days=1)).strftime('%Y-%m-%dT00:00:00')
    px = {s: cb_daily(f'{s}-USD', start, end) for s in ('ZEC', 'DASH', 'BTC', 'ETH', 'SOL')}
    px['XMR'] = kraken_daily('XMRUSD', dt.datetime.fromisoformat(start).timestamp())
    # circulating supply (approximation): current CoinGecko supply; ZEC back-extrapolated from its own CoinGecko mcap/price series
    sup = {'BTC': 19.93e6, 'ETH': 120.7e6, 'SOL': 5.6e8, 'XMR': 18.45e6, 'DASH': 12.5e6}
    try:
        for c in get('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana,monero,dash,zcash') or []:
            sup[{'bitcoin': 'BTC', 'ethereum': 'ETH', 'solana': 'SOL', 'monero': 'XMR', 'dash': 'DASH', 'zcash': 'ZEC'}[c['id']]] = c['circulating_supply']
    except Exception: pass
    zs = jload('cg_series/zcash.json') or {}
    zsup = None
    if zs.get('prices') and zs.get('market_caps'):
        a, b = zs['market_caps'][0][1] / zs['prices'][0][1], zs['market_caps'][-1][1] / zs['prices'][-1][1]
        t0, t1 = zs['prices'][0][0] / 1000, zs['prices'][-1][0] / 1000; slope = (b - a) / max(1, (t1 - t0) / 86400)
        zsup = lambda d: a + slope * ((dt.datetime.strptime(d, '%Y%m%d').replace(tzinfo=dt.timezone.utc).timestamp() - t0) / 86400)
    supply = lambda s, d: (zsup(d) if (s == 'ZEC' and zsup) else sup.get(s))
    wst, wen = start[:10].replace('-', ''), end[:10].replace('-', '')
    W = {a: wiki_series(a, wst, wen) or {} for a in THEMES['privacy_zk']['wiki'] + WIKI_BENCH}
    days = sorted(d for d in px['ZEC'] if all(d in px[s] for s in ('BTC', 'ETH', 'SOL')) and all(d in W[a] for a in WIKI_BENCH))
    priv = [s for s in ('ZEC', 'XMR', 'DASH')]
    mc = {d: sum(px[s][d] * supply(s, d) for s in priv if d in px[s]) for d in days}
    bm = {d: sum(px[s][d] * supply(s, d) for s in ('BTC', 'ETH', 'SOL')) for d in days}
    att = {d: sum(W[a].get(d, 0) for a in THEMES['privacy_zk']['wiki']) for d in days}
    ben = {d: sum(W[a].get(d, 0) for a in WIKI_BENCH) for d in days}
    rowsv = []
    for i in range(35, len(days)):
        d = days[i]; L7 = days[i - 6:i + 1]; P28 = days[i - 34:i - 6]
        s7 = sum(att[x] for x in L7) / sum(ben[x] for x in L7); s28 = sum(att[x] for x in P28) / sum(ben[x] for x in P28)
        av = LN(s7 / s28)
        mv = LN((mc[d] / bm[d]) / (mc[days[i - 7]] / bm[days[i - 7]]))
        g30 = mc[d] / mc[days[i - 30]] - 1
        flag = av >= LN(1.5) and av - mv >= LN(1.3) and g30 < 1.0
        rowsv.append({'d': d, 'zec': px['ZEC'][d], 'av': round(av, 3), 'mv': round(mv, 3), 'g30': round(g30, 3), 'flag': flag})
    # episodes = ZEC runs: price >= 2x its trailing 60-day median; start = first day >= 1.3x of it, peak = max close in the episode (+60d)
    z = [px['ZEC'][d] for d in days]
    eps = []; i = 60
    while i < len(days):
        base = statistics.median(z[i - 60:i])
        if z[i] >= 2 * base:
            j = i
            while j > 60 and z[j - 1] >= 1.3 * statistics.median(z[j - 61:j - 1]): j -= 1
            win = range(i, min(len(days), i + 75)); pk = max(win, key=lambda q: z[q])
            eps.append({'start': days[j], 'startPx': z[j], 'twoX': days[i], 'peak': days[pk], 'peakPx': z[pk], 'baseMedian60d': round(base, 2)})
            i = pk + 30; continue
        i += 1
    res = []
    for e in eps:
        fl = [r for r in rowsv if r['flag'] and days.index(e['start']) - 45 <= days.index(r['d']) <= days.index(e['peak'])]
        f = fl[0] if fl else None
        res.append({**e, 'firstFlag': f['d'] if f else None, 'flagPx': f['zec'] if f else None,
                    'daysBeforePeak': (days.index(e['peak']) - days.index(f['d'])) if f else None,
                    'daysVsStart': (days.index(f['d']) - days.index(e['start'])) if f else None,
                    'upsideLeftToPeak': round(e['peakPx'] / f['zec'] - 1, 2) if f else None,
                    'flagDays': len(fl)})
    inside = set()
    for e in eps:
        a, b = days.index(e['start']) - 45, days.index(e['peak'])
        inside |= set(days[max(0, a):b + 1])
    fp = [r['d'] for r in rowsv if r['flag'] and r['d'] not in inside]
    # what happened after false-positive flag days (30d forward ZEC return)
    fwd = []
    for d in fp:
        k = days.index(d)
        if k + 30 < len(days): fwd.append(z[k + 30] / z[k] - 1)
    # sensitivity: same data, other thresholds (the live rule stays at 1.5 / 1.3, chosen before this test)
    sens = []
    for A in (1.3, 1.5, 2.0):
        for D in (1.2, 1.3):
            fl = lambda r: r['av'] >= LN(A) and r['av'] - r['mv'] >= LN(D) and r['g30'] < 1.0
            ep = []
            for e in eps:
                a, b = days.index(e['start']) - 45, days.index(e['peak'])
                f = next((r for r in rowsv if fl(r) and a <= days.index(r['d']) <= b), None)
                ep.append({'start': e['start'], 'firstFlag': f['d'] if f else None, 'daysBeforePeak': (b - days.index(f['d'])) if f else None, 'daysVsStart': (days.index(f['d']) - days.index(e['start'])) if f else None, 'upsideLeftToPeak': round(e['peakPx'] / f['zec'] - 1, 2) if f else None})
            sens.append({'attentionUpAtLeast': A, 'attentionVsMcapAtLeast': D, 'episodes': ep, 'flagDaysOutside': sum(1 for r in rowsv if fl(r) and r['d'] not in inside)})
    out = {'generatedAt': int(NOW * 1000), 'theme': 'privacy_zk', 'sensitivity': sens, 'basket': 'ZEC + XMR + DASH (price x circulating supply) vs BTC + ETH + SOL',
           'attention': 'Wikipedia pageviews: ' + ', '.join(THEMES['privacy_zk']['wiki']) + ' / ' + ', '.join(WIKI_BENCH),
           'rule': METHOD['emerging'] + ' (same rule as live, Wikipedia is the only historical attention source: Google News/RSS/launch history is not free historically; GDELT refused requests from this server)',
           'window': [days[0], days[-1]], 'days': len(rowsv), 'flagDays': sum(1 for r in rowsv if r['flag']),
           'episodes': res, 'flagsOutsideEpisodes': len(fp), 'flagsOutsideEpisodesDates': fp[:40],
           'falsePositiveFwd30dMedian': r2(med(fwd), 3), 'falsePositiveFwd30dN': len(fwd),
           'caveats': ['supply for BTC/ETH/SOL/XMR/DASH held at current CoinGecko circulating supply; ZEC supply back-extrapolated linearly from its CoinGecko series', 'XMR from Kraken daily closes (Coinbase does not list XMR)', 'only three ZEC episodes in the free data window (Mar 2025 onward): a small sample, not proof'],
           'series': rowsv}
    jdump('narratives_validation.json', out)
    return out

if __name__ == '__main__':
    if '--validate' in sys.argv:
        v = validate(); print(json.dumps({k: v[k] for k in ('window', 'days', 'flagDays', 'episodes', 'flagsOutsideEpisodes', 'falsePositiveFwd30dMedian')}, indent=1))
    else:
        o = build()
        st = os.path.join(DATA_DIR, 'narratives_validation.json')
        if not os.path.exists(st) or NOW - os.path.getmtime(st) > 7 * 86400:
            try: validate()
            except Exception as e: print('validation failed:', e)
        for r in o['themes']: print(f"{r['rank']:>2} {r['id']:<20} m={r['momentum']} {r['status']:<9} crowd={r['crowdLevel']:<11} av={r2(r['attentionVel'])} mv7={r2(r['mcapShareVel7'])} b7={r2(r['breadth7'])} tvl7={r2(r['tvlGrowth7'],3)}")
        print(json.dumps(o['sources'], indent=1))
