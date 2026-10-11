#!/usr/bin/env python3
"""Buyback-and-burn research (free data only: DefiLlama, CoinGecko free, Hyperliquid info API,
official burn announcements). NO Nansen / X APIs.

Stages:  python buyburn.py fetch | revenue | burns | analyze | project | all
Outputs: data/buyburn_revenue.json, data/buyburn_tokens.json, data/buyburn_events.json,
         data/buyburn_daily.json, data/buyburn_stats.json, data/buyburn_projections.json
"""
import json, os, sys, time, math, urllib.request, urllib.error, datetime as dt
import numpy as np, pandas as pd
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data'); RAW = os.path.join(DATA, 'raw')
os.makedirs(RAW, exist_ok=True)
UA = {'user-agent': 'Mozilla/5.0 (research, read-only)', 'accept': 'application/json'}
NOW = int(time.time()); TODAY = pd.Timestamp(dt.date.today())
_last = {}

def fetch(url, cache, max_age=6*3600, gap=1.0, post=None):
    p = os.path.join(RAW, cache)
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < max_age:
        try: return json.load(open(p))
        except Exception: pass
    host = url.split('/')[2]
    for i in range(5):
        w = _last.get(host, 0) + gap - time.time()
        if w > 0: time.sleep(w)
        _last[host] = time.time()
        try:
            data = json.dumps(post).encode() if post is not None else None
            h = dict(UA); 
            if post is not None: h['content-type'] = 'application/json'
            with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=40) as r:
                j = json.loads(r.read().decode())
            json.dump(j, open(p, 'w')); return j
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504): time.sleep(8 * (i + 1)); continue
            if e.code in (400, 404): return None
            raise
        except Exception:
            time.sleep(4 * (i + 1))
    return None

def save(name, obj):
    json.dump(obj, open(os.path.join(DATA, name), 'w'), indent=1, default=lambda o: None if (isinstance(o, float) and not math.isfinite(o)) else (float(o) if isinstance(o, (np.floating,)) else int(o) if isinstance(o, np.integer) else str(o)))

def clean(o):
    if isinstance(o, dict): return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [clean(v) for v in o]
    if isinstance(o, (np.floating, float)): return None if not math.isfinite(float(o)) else round(float(o), 8)
    if isinstance(o, np.integer): return int(o)
    if isinstance(o, (pd.Timestamp, dt.date)): return str(o)[:10]
    return o

# ---------------------------------------------------------------- token universe
# type: burn = bought tokens destroyed; treasury = bought & held by protocol/DAO; distrib = paid to stakers;
#       mixed = part burned/part other; matched_reserve_burn = buy -> stakers, equal amount burned from unvested reserve
TOKENS = [
 dict(sym='HYPE', gecko='hyperliquid', hr='hyperliquid', emis='hyperliquid', type='burn',
      note='Assistance Fund (system addr 0xfefe..fe, no key) auto-buys HYPE with ~97-99% of trading fees; validator vote 2025-12-24 (85% yes) formally recognized AF HYPE as burned (~37.5M then).',
      src=['https://crypto.news/hyper-foundation-confirms-hype-burn-as-validators-back-assistance-fund-vote/', 'DefiLlama holdersRevenue hyperliquid']),
 dict(sym='PUMP', gecko='pump-fun', hr='pump', emis='pump', type='treasury->burn',
      note='Jul-2025..Apr-2026: ~100% of revenue bought PUMP held in treasury; 2026-04-28/29 all repurchased PUMP burned (~$370M, ~36% of circ then); since then 50% of net revenue auto buy&burn (locked contract, 1y). Dashboard: $472M, 169.5B PUMP burned (as of Oct 2026).',
      src=['https://pump.fun/pump-token', 'https://www.theblock.co/news/ecosystems/2026-04-28-pump-fun-burns-370-million-pump-399288']),
 dict(sym='UNI', gecko='uniswap', hr='uniswap', emis='uniswap', type='burn',
      note='UNIfication passed 2025-12-25; 100M UNI retro burn 2025-12-28; protocol fees (v2 + selected v3 + Unichain net seq. fees) burn UNI continuously. Offset: 20M UNI/yr growth budget (from 2026).',
      src=['https://www.theblock.co/news/ecosystems/2025-12-25-uniswap-passes-unification-proposal-383742', 'https://blog.uniswap.org/unification']),
 dict(sym='SKY', gecko='sky', hr='sky', emis='sky', type='mixed',
      note='Smart Burn Engine buys SKY with surplus; historically LP/staker distribution, first protocol burn 2.86M SKY Sep-2026 (5% of monthly surplus). Treat as mostly NOT burned.',
      src=['https://www.tradingview.com/news/coinmarketcal:313ac84cf094b:0-sky-first-protocol-burn-removes-2-86m-sky-from-circulation-14-sep-2026/']),
 dict(sym='BONK', gecko='bonk', hr='bonk.fun-launchpad', emis=None, type='mixed', note='BONK.fun launchpad revenue partly buys & burns BONK (DefiLlama labels mixed). Not fully verified.', src=['DefiLlama holdersRevenue bonkfun']),
 dict(sym='LINK', gecko='chainlink', hr='chainlink', emis='chainlink', type='treasury', note='Chainlink Reserve accumulates LINK from revenue; no burn.', src=['DefiLlama holdersRevenue chainlink']),
 dict(sym='RAY', gecko='raydium', hr='raydium', emis='raydium', type='treasury', note='12% of swap fees buy RAY, held at public protocol address (not burned).', src=['https://docs.raydium.io/ray/ray-buybacks']),
 dict(sym='CAKE', gecko='pancakeswap-token', hr='pancakeswap', emis='pancakeswap', type='burn', note='Weekly CAKE burns from trading fees / other revenue (CAKE Tokenomics 3.0); emissions offset.', src=['DefiLlama holdersRevenue pancakeswap', 'https://docs.pancakeswap.finance/']),
 dict(sym='ASTER', gecko='aster-2', hr='aster-spot', emis='aster', type='matched_reserve_burn',
      note='Since 2026-06-17: 99% of daily fees buy ASTER (TWAP) -> distributed to veASTER stakers; equal amount burned bi-weekly from team reserve (reduces TOTAL, not circulating). 207.4M burned across all programs by 2026-10-05.',
      src=['https://www.bitrue.com/blog/aster-buyback-burn-september-2026', 'https://www.cryptotimes.io/2026/06/17/aster-revamps-tokenomics-with-fee-funded-buybacks-and-burns/']),
 dict(sym='ORE', gecko='ore', hr='ore-protocol', emis='ore-protocol', type='mixed', note='Protocol revenue buys ORE; portion burned, portion to stakers (DefiLlama: mixed).', src=['DefiLlama holdersRevenue ore-protocol']),
 dict(sym='JUP', gecko='jupiter-exchange-solana', hr='jupiter', emis='jupiter', type='treasury', note='50% of fees buy JUP into Litterbox Trust (locked 3y), not burned; leadership questioned program Jan-2026 but still active Oct-2026.', src=['https://www.tokenbuybacks.app/token/jup/', 'https://ambcrypto.com/waste-of-resources-jupiter-cto-explains-why-jup-buybacks-may-end/']),
 dict(sym='LIT', gecko='lighter', hr='lighter', emis='lighter', type='treasury->burn',
      note='Fee-funded LIT buybacks since TGE (Dec-2025) held in treasury; 2026-07-10/11 burned 15,638,702 LIT (Q2 buybacks, ~6.3% circ); 100% of fees -> buy & burn going forward. 500M LIT insider unlock starts 2026-12-27 (3y linear).',
      src=['https://www.gate.com/news/detail/lighter-completes-destruction-of-1564m-lit-tokens-accumulated-from-q2-22504923', 'https://beincrypto.com/lighter-lit-token-burn-rally/']),
 dict(sym='LDO', gecko='lido-dao', hr='lido', emis='lido', type='treasury', note='Lido buybacks (DefiLlama holdersRevenue); disposition (treasury/LP) not verified -> treasury.', src=['DefiLlama holdersRevenue lido']),
 dict(sym='EDGE', gecko='edgex', hr='edgex', emis='edgex', type='burn', note='edgeX tokenomics page shows "Buyback Burn 4.93%" of supply repurchased by revenue; DefiLlama: $45M Q2-2026, $1.2M Q3. Funding bridge partially unverified.', src=['https://pro.edgex.exchange/en-US/tokenomics', 'https://defillama.com/token/edge']),
 dict(sym='GMX', gecko='gmx', hr='gmx', emis='gmx', type='treasury/distrib', exclude_stats=True, note='27% of fees buy GMX held by DAO / distributed to stakers; no burn. DefiLlama holdersRevenue for GMX is mostly historical ETH/AVAX fee distribution to stakers (not buybacks) -> excluded from buyback stats.', src=['https://cryptobriefing.com/gmx-dao-token-buyback-program/']),
 dict(sym='ETH', gecko='ethereum', hr='ethereum', emis=None, type='burn(protocol)', note='EIP-1559 base-fee burn (since 2021-08-05); offset by PoS issuance.', src=['DefiLlama holdersRevenue ethereum chain']),
 dict(sym='TRX', gecko='tron', hr='tron', emis=None, type='burn(protocol)', note='TRX burned for energy/bandwidth fees; offset by block rewards.', src=['DefiLlama holdersRevenue tron chain']),
 dict(sym='BNB', gecko='binancecoin', hr='bsc', emis=None, type='burn', note='Quarterly Auto-Burn (formula on price & blocks, target 100M) + BEP-95 real-time gas burn. Not directly fee-funded since auto-burn (2021-12); earlier burns were 20% of Binance profit.', src=['https://www.bnbchain.org/en/blog/36th-bnb-burn', 'https://www.coin-tools.com/bnb/bnb-burn-history/']),
 dict(sym='OKB', gecko='okb', hr=None, emis=None, type='burn(ended)', note='28 quarterly buyback-burns 2019-05..2025-06 funded by OKX revenue; 2025-08-15 one-time burn 65,256,712 OKB, supply fixed at 21M, program ended.', src=['https://www.okx.com/en-us/help/okb-burn-report-2025-03-01-2025-05-31', 'https://www.okx.ac/en-us/help/x-layer-okt-okb']),
 dict(sym='BGB', gecko='bitget-token', hr=None, emis=None, type='burn', note='Quarterly burns; 2025 ~30M/qtr (GetGas formula), 2026 ~3M/qtr Morph-fee formula paid from locked Morph treasury (cuts total, not circ).', src=['https://www.bitget.com/blog/articles/bitget-bgb-q2-2025-token-burn', 'https://mrnasdog.com/research/bgb/inflation']),
 dict(sym='SUN', gecko='sun-token', hr=None, emis='sun', type='burn', note='Quarterly buyback & burn from SunSwap V2 / SunPump / SunX revenue; 51 rounds, 678.5M SUN cumulative to 2026-07-25.', src=['https://sunswap.zendesk.com/hc/en-us/articles/60419313030425']),
]
BURN_TYPES = {'burn', 'burn(protocol)', 'treasury->burn'}

# ---------------------------------------------------------------- discrete events (official announcements)
# (date, amount, date_quality, source). date_quality: exact|blog (announcement date)|approx (+-7d)
BNB_EVENTS = [
 ('2017-10-18',986000,'exact','coin-tools'),('2018-01-15',1821586,'exact','coin-tools'),('2018-04-15',2220314,'exact','coin-tools'),
 ('2018-07-18',2528767,'exact','coin-tools'),('2018-10-17',1643986,'exact','coin-tools'),('2019-01-16',1623818,'exact','coin-tools'),
 ('2019-04-16',829888,'exact','coin-tools'),('2019-07-12',808888,'exact','coin-tools'),('2019-10-17',2061888,'exact','coin-tools'),
 ('2020-01-18',2216888,'exact','coin-tools'),('2020-04-18',3373988,'exact','coin-tools'),('2020-07-18',3477388,'exact','coin-tools'),
 ('2020-10-17',2253888,'exact','coin-tools'),('2021-01-19',3619888,'exact','coin-tools'),('2021-04-16',1099888,'exact','coin-tools'),
 ('2021-07-18',1296728,'exact','coin-tools'),('2021-10-18',1335888,'exact','coin-tools'),
 ('2022-01-18',1684387.11,'approx','binance blog 18th'),('2022-04-14',1839786.26,'approx','19th news'),('2022-07-13',1959595,'approx','coincheckup 20th'),
 ('2022-10-13',2065152.42,'approx','thenewscrypto 21st'),('2023-01-17',2064494,'blog','bnbchain 22nd'),('2023-04-13',2020132.25,'approx','coinlive 23rd'),
 ('2023-07-19',1991854.33,'blog','theblock 24th'),('2023-10-13',2139182.98,'approx','blockchainreporter 25th'),('2024-01-17',2141487,'blog','bnbchain 26th'),
 ('2024-04-24',1944452,'exact','bnbchain 27th / cryptoburntracker'),('2024-07-22',1643698,'blog','bnbchain 28th'),('2024-10-30',1772712,'blog','bnbchain 29th'),
 ('2025-01-15',1634200.95,'approx','bnbchain 30th'),('2025-04-15',1579207.72,'blog','bnbchain 31st'),('2025-07-10',1595599.78,'blog','bnbchain 32nd'),
 ('2025-10-27',1441281.413,'blog','bnbchain 33rd'),('2026-01-15',1371803.77,'blog','bnbchain 34th'),('2026-04-15',1569307.34,'exact','bnbchain 35th'),
 ('2026-07-15',1615827.795,'exact','bnbchain 36th'),
]
OKB_EVENTS = [(d.replace('.', '-'), a, 'exact', 'okx burn report') for d, a in [
 ('2019.05.10',506183.39),('2019.05.17',557364.59),('2019.05.24',452741.79),('2019.05.31',412753.26),('2019.09.03',6104047.53),('2019.12.06',5945273.91),
 ('2020.03.02',3183344.61),('2020.06.02',3509874.52),('2020.09.02',3816358.49),('2020.12.02',4060773.48),('2021.03.03',2006412.69),('2021.06.02',2008753.54),
 ('2021.09.09',2320679.53),('2021.12.07',2435426.87),('2022.03.14',2536277.49),('2022.06.13',3755642.45),('2022.09.16',4760479.82),('2023.01.05',4988637.56),
 ('2023.03.23',5183976.43),('2023.06.08',5497312.77),('2023.09.11',6140520.48),('2023.12.11',10527664.73),('2024.03.13',11476883.02),('2024.06.12',12133523.24),
 ('2024.09.18',17337195.52),('2024.12.06',18488690.46),('2025.03.14',31158862),('2025.06.19',42437632),('2025.08.15',65256712.097)]]
# OKB 2025-08-15 = one-time burn of historical reserve (not a revenue-funded quarterly event) -> flagged
BGB_EVENTS = [('2025-04-09',30006905,'blog','bitget blog'),('2025-07-10',30001053.1,'blog','bitget blog'),
              ('2026-01-23',3060000,'approx','mrnasdog'),('2026-04-09',3000000,'approx','mrnasdog'),('2026-07-14',3010400,'exact','mrnasdog')]
ONE_OFF = [  # single large discrete burns of previously bought-back / treasury tokens
 dict(sym='PUMP', date='2026-04-29', amount=None, usd=370e6, quality='blog', note='burn of all repurchased PUMP (~36% circ)', src='theblock 2026-04-28'),
 dict(sym='LIT', date='2026-07-10', amount=15638702, usd=None, quality='exact', note='burn of Q2 buybacks (~6.3% circ)', src='gate news 2026-07-11'),
 dict(sym='UNI', date='2025-12-28', amount=100e6, usd=596e6, quality='exact', note='retro treasury burn (not fee funded)', src='cointelegraph 2025-12-28'),
 dict(sym='HYPE', date='2025-12-24', amount=37.5e6, usd=912e6, quality='exact', note='AF HYPE formally recognized burned (accounting, no on-chain move)', src='crypto.news 2025-12-24'),
 dict(sym='SUN', date='2026-07-25', amount=9025027.40, usd=None, quality='exact', note='51st quarterly buyback-burn', src='sunswap zendesk'),
]
DISCRETE = {'BNB': BNB_EVENTS, 'OKB': OKB_EVENTS, 'BGB': BGB_EVENTS}

# ---------------------------------------------------------------- fetch helpers
def llama_summary(slug, dtype):
    return fetch(f'https://api.llama.fi/summary/fees/{slug}?dataType={dtype}', f'sum_{slug}_{dtype}.json', gap=0.6)

def chart_series(j):
    if not j or not j.get('totalDataChart'): return pd.Series(dtype=float)
    s = pd.Series({pd.Timestamp(int(t), unit='s').normalize(): float(v or 0) for t, v in j['totalDataChart']}).sort_index()
    return s

def prices(gecko, start='2017-07-01'):
    """daily USD price from coins.llama.fi (free, full history)."""
    cache = f'px_{gecko}.json'
    p = os.path.join(RAW, cache)
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < 6*3600:
        d = json.load(open(p)); return _dense(pd.Series({pd.Timestamp(k): v for k, v in d.items()}).sort_index())
    out = {}; t = int(pd.Timestamp(start).timestamp())
    while t < NOW:
        j = fetch(f'https://coins.llama.fi/chart/coingecko:{gecko}?start={t}&span=500&period=1d', f'_tmp_px.json', max_age=0, gap=0.4)
        pts = ((j or {}).get('coins') or {}).get(f'coingecko:{gecko}', {}).get('prices', [])
        for x in pts: out[str(pd.Timestamp(x['timestamp'], unit='s').round('D'))[:10]] = x['price']
        t += 500 * 86400
    json.dump(out, open(p, 'w'))
    return _dense(pd.Series({pd.Timestamp(k): v for k, v in out.items()}).sort_index())

def _dense(s):
    """daily index; fill isolated 1-2 day gaps by log-linear interpolation (coins.llama timestamps drift)."""
    s = s[s > 0]
    idx = pd.date_range(s.index.min(), s.index.max())
    return np.exp(np.log(s).reindex(idx).interpolate(limit=2, limit_area='inside'))

def cg365(gecko):
    j = fetch(f'https://api.coingecko.com/api/v3/coins/{gecko}/market_chart?vs_currency=usd&days=365&interval=daily', f'cg365_{gecko}.json', gap=6.5)
    if not j or 'prices' not in j: return pd.DataFrame()
    f = lambda k: pd.Series({pd.Timestamp(t, unit='ms').normalize(): v for t, v in j[k]})
    df = pd.DataFrame({'price': f('prices'), 'mcap': f('market_caps'), 'vol': f('total_volumes')})
    df = df[~df.index.duplicated(keep='last')].sort_index()
    df['circ'] = df.mcap / df.price
    return df

def cg_coin(gecko):
    return fetch(f'https://api.coingecko.com/api/v3/coins/{gecko}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false', f'cgcoin_{gecko}.json', gap=6.5)

def emissions(slug):
    if not slug: return None
    return fetch(f'https://defillama-datasets.llama.fi/emissions/{slug}', f'emis_{slug}.json', max_age=24*3600)

def emis_unlocked_series(slug):
    """total unlocked (sum of documented sections, falling back to default data) by day."""
    j = emissions(slug)
    if not j: return pd.Series(dtype=float), None
    secs = (j.get('documentedData') or {}).get('data') or j.get('data') or []
    tot = {}
    for sec in secs:
        for x in sec.get('data', []):
            k = pd.Timestamp(x['timestamp'], unit='s').normalize(); tot[k] = tot.get(k, 0) + float(x.get('unlocked') or 0)
    return pd.Series(tot).sort_index(), j

# ---------------------------------------------------------------- stage 1: revenue ranking
ALIAS = {'maker': 'sky', 'sun.io': 'sun', 'astherus': 'aster-perps'}
FORCE_PARENTS = ['hyperliquid', 'edgex', 'lighter', 'astherus', 'jupiter', 'raydium', 'pancakeswap', 'aerodrome', 'gmx', 'maker', 'uniswap', 'pump', 'sun', 'chainlink', 'aave', 'lido']

def stage_revenue():
    ov = {}
    for t in ['dailyFees', 'dailyRevenue', 'dailyHoldersRevenue']:
        ov[t] = fetch(f'https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType={t}', f'overview_{t}.json')
    agg = {}
    for t, j in ov.items():
        for p in j['protocols']:
            key = (p.get('parentProtocol') or '').replace('parent#', '') or p.get('slug')
            a = agg.setdefault(key, dict(key=key, is_parent=bool(p.get('parentProtocol')), name=p.get('name'), category=p.get('category'), ptype=p.get('protocolType'), children=[]))
            if not p.get('parentProtocol'): a['name'] = p.get('name')
            a.setdefault(t + '_30d', 0); a[t + '_30d'] += p.get('total30d') or 0
            if t == 'dailyRevenue': a['children'].append(p.get('name'))
    rows = sorted(agg.values(), key=lambda a: -(a.get('dailyRevenue_30d') or 0))
    top = [r['key'] for r in rows[:22]]
    keys = list(dict.fromkeys(top + FORCE_PARENTS))
    out = []
    for k in keys:
        r = agg.get(k, {'key': k})
        rec = dict(key=k, name=r.get('name'), category=r.get('category'), type=r.get('ptype'))
        for t, lab in [('dailyFees', 'fees'), ('dailyRevenue', 'rev'), ('dailyHoldersRevenue', 'hrev')]:
            rec[f'{lab}_30d_overview'] = r.get(t + '_30d')
            j = llama_summary(ALIAS.get(k, k), t)
            s = chart_series(j)
            if j: rec['name'] = j.get('name') or rec['name']; rec['gecko_id'] = j.get('gecko_id'); rec['symbol'] = j.get('symbol')
            if s.empty: continue
            s = s[s.index < TODAY]  # drop partial day
            last = s.index.max(); d = lambda a, b: s[(s.index > last - pd.Timedelta(days=a)) & (s.index <= last - pd.Timedelta(days=b))].sum()
            rec[f'{lab}_30d'] = d(30, 0); rec[f'{lab}_prev30d'] = d(60, 30)
            rec[f'{lab}_90d'] = d(90, 0); rec[f'{lab}_prev90d'] = d(180, 90)
            rec[f'{lab}_annualized'] = rec[f'{lab}_30d'] * 365 / 30
            rec[f'{lab}_chg30_pct'] = (rec[f'{lab}_30d'] / rec[f'{lab}_prev30d'] - 1) * 100 if rec[f'{lab}_prev30d'] else None
            rec[f'{lab}_chg90_pct'] = (rec[f'{lab}_90d'] / rec[f'{lab}_prev90d'] - 1) * 100 if rec[f'{lab}_prev90d'] else None
            rec[f'{lab}_alltime'] = s.sum(); rec[f'{lab}_data_through'] = str(last)[:10]
            if last < TODAY - pd.Timedelta(days=5): rec[f'{lab}_STALE'] = True
        out.append(rec)
    for rec in out:  # fall back to overview aggregate when summary missing
        for lab in ['fees', 'rev', 'hrev']:
            if rec.get(f'{lab}_30d') is None and rec.get(f'{lab}_30d_overview'):
                rec[f'{lab}_30d'] = rec[f'{lab}_30d_overview']; rec[f'{lab}_annualized'] = rec[f'{lab}_30d'] * 365 / 30; rec[f'{lab}_from_overview'] = True
    out.sort(key=lambda r: -(r.get('rev_30d') or 0))
    save('buyburn_revenue.json', clean(dict(generated=str(TODAY)[:10], source='DefiLlama api.llama.fi/summary/fees/{parent}?dataType=dailyFees|dailyRevenue|dailyHoldersRevenue', rows=out)))
    return out

# ---------------------------------------------------------------- stage 2: burn histories
def stage_burns():
    btc = prices('bitcoin')
    tokens_out, daily_out, events_out = [], {}, []
    for T in TOKENS:
        sym, g = T['sym'], T['gecko']
        print('..', sym, flush=True)
        px = prices(g)
        cg = cg365(g)
        coin = cg_coin(g) or {}
        md = coin.get('market_data') or {}
        unl, ej = emis_unlocked_series(T.get('emis'))
        rec = dict(sym=sym, gecko=g, type=T['type'], note=T['note'], sources=T['src'],
                   price_now=(md.get('current_price') or {}).get('usd'), circ_now=md.get('circulating_supply'),
                   total_now=md.get('total_supply'), max_supply=md.get('max_supply'), mcap_now=(md.get('market_cap') or {}).get('usd'),
                   vol24_now=(md.get('total_volume') or {}).get('usd'))
        # continuous program from DefiLlama holdersRevenue
        if T.get('hr'):
            s = chart_series(llama_summary(T['hr'], 'dailyHoldersRevenue'))
            s = s[(s.index < TODAY)]
            if not s.empty:
                s = s[s.index >= s[s > 0].index.min()] if (s > 0).any() else s
                df = pd.DataFrame({'usd': s})
                df['price'] = px.reindex(df.index).ffill()
                df['tokens'] = df.usd / df.price
                if not cg.empty:
                    df['circ'] = cg.circ.reindex(df.index); df['vol'] = cg.vol.reindex(df.index)
                else: df['circ'] = np.nan; df['vol'] = np.nan
                if not unl.empty:  # fallback circ estimate = emissions 'unlocked' total
                    df['circ_emis'] = unl.reindex(df.index).ffill()
                if 'circ_emis' in df and df.circ.notna().any() and (df.circ.notna() & df.circ_emis.notna()).sum() > 20:
                    k = (df.circ / df.circ_emis).median(); df['circ_emis'] = df.circ_emis * k   # splice emissions-based circ onto CoinGecko level
                df['circ_best'] = df['circ'].fillna(df.get('circ_emis', pd.Series(index=df.index, dtype=float)))
                df['pct_circ'] = df.tokens / df.circ_best * 100
                df['pct_vol'] = df.usd / df.vol * 100
                df['btc'] = btc.reindex(df.index).ffill()
                daily_out[sym] = df
                last90 = df[df.index > df.index.max() - pd.Timedelta(days=90)]
                last30 = df[df.index > df.index.max() - pd.Timedelta(days=30)]
                rec.update(program_start=str(df.index.min())[:10], cum_usd=df.usd.sum(), cum_tokens=df.tokens.sum(),
                           usd_30d=last30.usd.sum(), usd_90d=last90.usd.sum(),
                           tokens_per_day_90d=last90.tokens.mean(), tokens_per_day_30d=last30.tokens.mean(),
                           usd_per_day_90d=last90.usd.mean(), pct_vol_median_90d=last90.pct_vol.median(),
                           cum_pct_of_circ_now=(df.tokens.sum() / rec['circ_now'] * 100) if rec.get('circ_now') else None,
                           source_daily='DefiLlama holdersRevenue (USD) / coins.llama price')
        # discrete events
        evs = [dict(date=d, amount=a, quality=q, src=s, kind='periodic') for d, a, q, s in DISCRETE.get(sym, [])]
        evs += [dict(date=o['date'], amount=o['amount'], usd=o['usd'], quality=o['quality'], src=o['src'], kind='one_off', note=o['note']) for o in ONE_OFF if o['sym'] == sym]
        for e in evs:
            e['sym'] = sym; d0 = pd.Timestamp(e['date'])
            pb = px.reindex([d0 - pd.Timedelta(days=1)]).iloc[0] if (d0 - pd.Timedelta(days=1)) in px.index else np.nan
            def at(k):
                t = d0 + pd.Timedelta(days=k); return px.get(t, np.nan), btc.get(t, np.nan)
            e['price_pre'] = pb; e['price_event'] = px.get(d0, np.nan)
            bpre = btc.get(d0 - pd.Timedelta(days=1), np.nan)
            for k, lab in [(1, '24h'), (7, '7d'), (30, '30d')]:
                p, b = at(k)
                e[f'price_{lab}'] = p
                e[f'ret_{lab}'] = (p / pb - 1) * 100 if pb and p == p else np.nan
                e[f'btc_{lab}'] = (b / bpre - 1) * 100 if bpre and b == b else np.nan
                e[f'xs_{lab}'] = e[f'ret_{lab}'] - e[f'btc_{lab}']
            if e.get('amount') is None and e.get('usd') and e['price_event'] == e['price_event']:
                e['amount'] = e['usd'] / e['price_event']; e['amount_est'] = True
            if e.get('usd') is None and e.get('amount'): e['usd'] = e['amount'] * (e['price_event'] if e['price_event'] == e['price_event'] else pb)
            circ = cg.circ.get(d0, np.nan) if not cg.empty else np.nan
            vol30 = cg.vol[(cg.index < d0) & (cg.index >= d0 - pd.Timedelta(days=30))].mean() if not cg.empty else np.nan
            e['circ_at_event'] = circ; e['avg_vol30_usd'] = vol30
            e['pct_circ'] = e['amount'] / circ * 100 if circ == circ and e.get('amount') else np.nan
            e['pct_dailyvol'] = e['usd'] / vol30 * 100 if vol30 == vol30 and e.get('usd') else np.nan
            events_out.append(e)
        tokens_out.append(rec)
    # supply denominators for old events where CG 365d circ unavailable
    for e in events_out:
        if e['pct_circ'] != e['pct_circ']:
            if e['sym'] == 'BNB':  # BNB circ ~= total supply (no locked allocations after 2021); supply before burn
                cum_before = sum(a for d, a, *_ in BNB_EVENTS if d < e['date'])
                e['supply_proxy'] = 200e6 - cum_before; e['pct_circ'] = e['amount'] / e['supply_proxy'] * 100; e['pct_circ_basis'] = 'total supply before burn (200M - prior burns)'
            elif e['sym'] == 'BGB':  # Bitget: 30.0M = 2.56% of total supply (Jul-2025 release) -> total ~1.17B
                e['supply_proxy'] = 30001053.1 / 0.0256; e['pct_circ'] = e['amount'] / e['supply_proxy'] * 100; e['pct_circ_basis'] = 'total supply implied by Bitget (2.56%)'
            elif e['sym'] == 'OKB':
                cum_before = sum(a for d, a, *_ in OKB_EVENTS if d < e['date'])
                e['supply_proxy'] = 300e6 - cum_before; e['pct_circ'] = e['amount'] / e['supply_proxy'] * 100; e['pct_circ_basis'] = 'TOTAL supply before burn (300M - prior burns); circ was lower -> understates %'
    save('buyburn_tokens.json', clean(dict(generated=str(TODAY)[:10], tokens=tokens_out)))
    save('buyburn_events.json', clean(dict(generated=str(TODAY)[:10], note='price_pre = daily close D-1 (coins.llama); returns vs D-1; xs = token return - BTC return (pp). pct_dailyvol = burn USD / prior-30d avg CoinGecko volume (only within last 365d).', events=events_out)))
    dd = {k: [dict(date=str(i)[:10], **{c: v[c] for c in ['usd', 'tokens', 'price', 'circ_best', 'pct_circ', 'vol', 'pct_vol']}) for i, v in df.iterrows()] for k, df in daily_out.items()}
    save('buyburn_daily.json', clean(dict(generated=str(TODAY)[:10], source='DefiLlama holdersRevenue daily USD; tokens = USD / daily price', series=dd)))
    return tokens_out, daily_out, events_out

if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if st in ('revenue', 'all'): stage_revenue()
    if st in ('burns', 'all'): stage_burns()
    if st in ('analyze', 'all', 'post'):
        import buyburn_analysis; buyburn_analysis.main()
