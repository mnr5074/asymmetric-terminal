"""Priority Watch (NEAR + ZEC): market, perps, tokenomics, news, narratives cross-reference, ZEC shielded-pool deep dive.
Free public data only (CoinGecko free, Binance www.binance.com/fapi + data-api.binance.vision, OKX, Hyperliquid, Gate,
NEAR public RPC + nearblocks.io free API, ZecStats/ZecScope public APIs, Blockchair free stats, Google News RSS + publisher RSS).
No Nansen, no paid X API. Every number below comes from a source call; when a call fails the field is null and the error is
listed under `errors` - nothing is filled in or estimated silently.

Usage:  python3 priority.py            # everything (shielded deep dive only if older than 20h)
        python3 priority.py fast       # market + perps + news + narratives (+ tokenomics), skip shielded rebuild
        python3 priority.py shielded   # rebuild data/zec_shielded.json only
Writes: data/priority.json, data/priority_news_seen.json, data/priority_history.json, data/zec_shielded.json
Not financial advice."""
import json, os, re, sys, time, math, html, urllib.request, urllib.error, urllib.parse, email.utils, csv, io
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data')
UA = {'user-agent': 'Mozilla/5.0 (asymmetric-terminal priority-watch, read-only)', 'accept': '*/*'}
NOW = time.time()
ERR = []
TOKENS = [
    {'sym': 'NEAR', 'cg': 'near', 'name': 'NEAR Protocol', 'binance': 'NEARUSDT', 'okx': 'NEAR-USDT-SWAP', 'hl': 'NEAR', 'gate': 'NEAR_USDT'},
    {'sym': 'ZEC', 'cg': 'zcash', 'name': 'Zcash', 'binance': 'ZECUSDT', 'okx': 'ZEC-USDT-SWAP', 'hl': 'ZEC', 'gate': 'ZEC_USDT'},
]


def fetch(url, data=None, timeout=25, raw=False, headers=None, retries=2):
    h = dict(UA); h.update(headers or {})
    body = None
    if data is not None:
        body = json.dumps(data).encode(); h['content-type'] = 'application/json'
    last = None
    for i in range(retries + 1):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=h), timeout=timeout) as r:
                b = r.read()
                return b.decode('utf-8', 'replace') if raw else json.loads(b.decode())
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 500, 502, 503, 504) and i < retries: time.sleep(3 * (i + 1)); continue
            raise
        except Exception as e:
            last = e
            if i < retries: time.sleep(2 * (i + 1)); continue
            raise
    raise last


def tryf(label, fn, default=None):
    try:
        return fn()
    except Exception as e:
        ERR.append({'what': label, 'error': str(e)[:200], 'at': int(NOW * 1000)})
        return default


def readj(name, default=None):
    try:
        with open(os.path.join(DATA_DIR, name)) as f: return json.load(f)
    except Exception: return default


def writej(name, obj):
    p = os.path.join(DATA_DIR, name)
    with open(p + '.tmp', 'w') as f: json.dump(obj, f, separators=(',', ':'), allow_nan=False, default=lambda x: None)
    os.replace(p + '.tmp', p)


def num(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception: return None


def clean(o):  # NaN/inf -> None recursively (strict JSON)
    if isinstance(o, float): return o if math.isfinite(o) else None
    if isinstance(o, dict): return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [clean(v) for v in o]
    return o

# ------------------------------------------------------------------ market (CoinGecko free)
def market():
    d = fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=near,zcash&price_change_percentage=1h,24h,7d,30d')
    out = {}
    for x in d:
        out[x['id']] = {'price': x.get('current_price'), 'mcap': x.get('market_cap'), 'fdv': x.get('fully_diluted_valuation'), 'rank': x.get('market_cap_rank'),
                        'vol24': x.get('total_volume'), 'ch1h': x.get('price_change_percentage_1h_in_currency'), 'ch24': x.get('price_change_percentage_24h_in_currency'),
                        'ch7d': x.get('price_change_percentage_7d_in_currency'), 'ch30d': x.get('price_change_percentage_30d_in_currency'),
                        'high24': x.get('high_24h'), 'low24': x.get('low_24h'), 'circ': x.get('circulating_supply'), 'total': x.get('total_supply'), 'max': x.get('max_supply'),
                        'ath': x.get('ath'), 'athDate': x.get('ath_date'), 'athChPct': x.get('ath_change_percentage'), 'updated': x.get('last_updated'), 'src': 'CoinGecko /coins/markets (free)'}
    return out


def cg_categories(cg_id):
    time.sleep(2.5)
    d = fetch(f'https://api.coingecko.com/api/v3/coins/{cg_id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false')
    return d.get('categories') or []

# ------------------------------------------------------------------ perps (4 venues, free public endpoints)
BN = 'https://www.binance.com'  # fapi.binance.com is geo-blocked (HTTP 451) from this box; www.binance.com/fapi serves the same public data


def perps_for(t, hist):
    rows = []
    s = t['sym']
    def bn():
        pi = fetch(f"{BN}/fapi/v1/premiumIndex?symbol={t['binance']}")
        oi = fetch(f"{BN}/fapi/v1/openInterest?symbol={t['binance']}")
        tk = fetch(f"{BN}/fapi/v1/ticker/24hr?symbol={t['binance']}")
        fi = [x for x in fetch(f'{BN}/fapi/v1/fundingInfo') if x['symbol'] == t['binance']]
        iv = (fi[0].get('fundingIntervalHours') if fi else None) or 8
        h = fetch(f"{BN}/futures/data/openInterestHist?symbol={t['binance']}&period=1h&limit=25")
        mark = num(pi['markPrice']); oiu = num(oi['openInterest']) * mark if num(oi.get('openInterest')) and mark else None
        ch = None; hrs = None
        if isinstance(h, list) and len(h) >= 2:
            a, b = num(h[0]['sumOpenInterestValue']), num(h[-1]['sumOpenInterestValue'])
            ch = (b / a - 1) * 100 if a else None; hrs = round((h[-1]['timestamp'] - h[0]['timestamp']) / 3600e3)
        rate = num(pi['lastFundingRate'])
        return {'venue': 'binance', 'contract': t['binance'], 'mark': mark, 'index': num(pi.get('indexPrice')), 'rate': rate, 'intervalH': iv, 'fAnnPct': rate * (24 / iv) * 365 * 100 if rate is not None else None,
                'nextFunding': pi.get('nextFundingTime'), 'oiUsd': oiu, 'oiCh24Pct': ch, 'oiChHours': hrs, 'oiChSrc': 'binance openInterestHist 1h', 'vol24Usd': num(tk.get('quoteVolume')), 'ch24': num(tk.get('priceChangePercent'))}
    def okx():
        B = 'https://www.okx.com/api/v5'
        fr = fetch(f"{B}/public/funding-rate?instId={t['okx']}")['data'][0]
        oi = fetch(f"{B}/public/open-interest?instType=SWAP&instId={t['okx']}")['data'][0]
        tk = fetch(f"{B}/market/ticker?instId={t['okx']}")['data'][0]
        iv = max(1, round((int(fr['nextFundingTime']) - int(fr['fundingTime'])) / 3600e3)) if fr.get('nextFundingTime') and fr.get('fundingTime') else 8
        h = fetch(f"{B}/rubik/stat/contracts/open-interest-history?instId={t['okx']}&period=1H&limit=25").get('data') or []
        ch = None; hrs = None
        if len(h) >= 2:
            b, a = num(h[0][3]), num(h[-1][3]); ch = (b / a - 1) * 100 if a else None; hrs = round((int(h[0][0]) - int(h[-1][0])) / 3600e3)
        rate = num(fr['fundingRate']); last = num(tk.get('last')); op = num(tk.get('open24h'))
        return {'venue': 'okx', 'contract': t['okx'], 'mark': last, 'index': None, 'rate': rate, 'intervalH': iv, 'fAnnPct': rate * (24 / iv) * 365 * 100 if rate is not None else None,
                'nextFunding': num(fr.get('fundingTime')), 'oiUsd': num(oi.get('oiUsd')), 'oiCh24Pct': ch, 'oiChHours': hrs, 'oiChSrc': 'okx rubik OI history 1H',
                'vol24Usd': num(tk.get('volCcy24h')) * last if num(tk.get('volCcy24h')) and last else None, 'ch24': (last / op - 1) * 100 if last and op else None}
    def hl():
        meta, ctx = fetch('https://api.hyperliquid.xyz/info', {'type': 'metaAndAssetCtxs'})
        for u, c in zip(meta['universe'], ctx):
            if u['name'] == t['hl']:
                mk = num(c['markPx']); rate = num(c['funding']); oiu = num(c['openInterest']) * mk if mk else None
                hh = hist.setdefault('hl:' + s, []); ch = None; hrs = None
                old = [x for x in hh if NOW * 1000 - x[0] >= 22 * 3600e3 and NOW * 1000 - x[0] <= 26 * 3600e3]
                if old and oiu: ch = (oiu / old[-1][1] - 1) * 100; hrs = round((NOW * 1000 - old[-1][0]) / 3600e3)
                if not hh or NOW * 1000 - hh[-1][0] > 50 * 60e3: hh.append([int(NOW * 1000), oiu])
                del hh[:-60]
                return {'venue': 'hyperliquid', 'contract': u['name'], 'mark': mk, 'index': num(c.get('oraclePx')), 'rate': rate, 'intervalH': 1, 'fAnnPct': rate * 24 * 365 * 100 if rate is not None else None,
                        'nextFunding': None, 'oiUsd': oiu, 'oiCh24Pct': ch, 'oiChHours': hrs, 'oiChSrc': 'own hourly snapshots (Hyperliquid has no public OI history)' if ch is not None else 'own snapshots building (need 22-26h)',
                        'vol24Usd': num(c.get('dayNtlVlm')), 'ch24': (mk / num(c['prevDayPx']) - 1) * 100 if num(c.get('prevDayPx')) else None, 'maxLev': u.get('maxLeverage')}
        raise RuntimeError('not listed on Hyperliquid')
    def gate():
        B = 'https://api.gateio.ws/api/v4/futures/usdt'
        tk = fetch(f"{B}/tickers?contract={t['gate']}")[0]
        c = fetch(f"{B}/contracts/{t['gate']}")
        st = fetch(f"{B}/contract_stats?contract={t['gate']}&interval=1h&limit=25")
        mk = num(tk['mark_price']); qm = num(tk.get('quanto_multiplier')) or num(c.get('quanto_multiplier')) or 1
        ch = None; hrs = None
        if isinstance(st, list) and len(st) >= 2:
            a, b = num(st[0]['open_interest_usd']), num(st[-1]['open_interest_usd']); ch = (b / a - 1) * 100 if a else None; hrs = round((st[-1]['time'] - st[0]['time']) / 3600)
        iv = (c.get('funding_interval') or 28800) / 3600; rate = num(tk.get('funding_rate'))
        return {'venue': 'gate', 'contract': t['gate'], 'mark': mk, 'index': num(tk.get('index_price')), 'rate': rate, 'intervalH': iv, 'fAnnPct': rate * (24 / iv) * 365 * 100 if rate is not None else None,
                'nextFunding': (c.get('funding_next_apply') or 0) * 1000 or None, 'oiUsd': num(tk.get('total_size')) * qm * mk if num(tk.get('total_size')) is not None and mk else None,
                'oiCh24Pct': ch, 'oiChHours': hrs, 'oiChSrc': 'gate contract_stats 1h', 'vol24Usd': num(tk.get('volume_24h_quote')), 'ch24': num(tk.get('change_percentage'))}
    for name, fn in (('binance', bn), ('okx', okx), ('hyperliquid', hl), ('gate', gate)):
        r = tryf(f'perps {s} {name}', fn)
        if r: rows.append(r)
    tot_oi = sum(r['oiUsd'] or 0 for r in rows) or None
    w = [(r['fAnnPct'], max(r['oiUsd'] or 0, 1e5)) for r in rows if r['fAnnPct'] is not None]
    f_w = sum(a * b for a, b in w) / sum(b for _, b in w) if w else None
    chs = [(r['oiCh24Pct'], r['oiUsd'] or 0) for r in rows if r['oiCh24Pct'] is not None and r['oiUsd']]
    oi_ch = sum(a * b for a, b in chs) / sum(b for _, b in chs) if chs else None
    return {'venues': rows, 'oiUsdTotal': tot_oi, 'fundingAnnPctOiWeighted': f_w, 'oiCh24PctOiWeighted': oi_ch, 'venuesOk': [r['venue'] for r in rows]}

# ------------------------------------------------------------------ NEAR tokenomics
NEAR_RPCS = ['https://rpc.mainnet.near.org', 'https://free.rpc.fastnear.com']


def near_rpc(method, params):
    last = None
    for u in NEAR_RPCS:
        try:
            r = fetch(u, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}, timeout=30)
            if 'result' in r: return r['result']
            last = RuntimeError(str(r.get('error'))[:150])
        except Exception as e: last = e
    raise last


def near_tokenomics():
    out = {'src': []}
    pc = tryf('NEAR protocol config', lambda: near_rpc('EXPERIMENTAL_protocol_config', {'finality': 'final'}))
    if pc:
        a, b = pc['max_inflation_rate']; pr = pc['protocol_reward_rate']
        out.update({'protocolVersion': pc.get('protocol_version'), 'maxInflationPct': a / b * 100, 'protocolTreasuryShare': pr[0] / pr[1] if pr[1] else None,
                    'epochLength': pc.get('epoch_length'), 'blocksPerYear': pc.get('num_blocks_per_year')})
        out['src'].append('NEAR RPC EXPERIMENTAL_protocol_config (rpc.mainnet.near.org)')
    out['inflationGovernance'] = ('Max inflation cut from 5% to 2.5%/yr by nearcore 2.9.0 (protocol v81), activated Oct 30 2025 after >80% of block-producer stake upgraded '
                                  '(an Aug 2025 community vote reached 45% vs the 66.67% needed; validators then adopted the cut via the upgrade). Live config above confirms the current max rate. '
                                  'House of Stake is named as the venue for future economic-parameter changes.')
    vals = tryf('NEAR validators', lambda: near_rpc('validators', [None]))
    st = tryf('nearblocks stats', lambda: fetch('https://api.nearblocks.io/v1/stats')['stats'][0])
    ch = tryf('nearblocks charts', lambda: fetch('https://api.nearblocks.io/v1/charts', timeout=40)['charts'])
    supply = None
    if st:
        supply = int(float(st['total_supply'])) / 1e24
        out.update({'totalSupply': supply, 'circSupplyNearblocks': int(float(st['circulating_supply'])) / 1e24, 'gasPriceYocto': st.get('gas_price'), 'nodesOnline': st.get('nodes_online')})
        out['src'].append('nearblocks.io /v1/stats (free)')
    if vals:
        staked = sum(int(v['stake']) for v in vals['current_validators']) / 1e24
        out.update({'stakedNear': staked, 'validators': len(vals['current_validators']), 'stakingRatioPct': staked / supply * 100 if supply else None})
        out['src'].append('NEAR RPC validators (current epoch stake)')
        if out.get('maxInflationPct') and out.get('stakingRatioPct'):
            out['impliedStakingAprPct'] = out['maxInflationPct'] * (1 - (out.get('protocolTreasuryShare') or 0)) / (out['stakingRatioPct'] / 100)
            out['impliedStakingAprNote'] = 'max inflation / staking ratio, before validator commission; assumes ~full uptime (realized issuance can be slightly lower)'
    if ch:
        rows = [r for r in ch if r.get('date')]
        rows.sort(key=lambda r: r['date'])
        def sup(r): return int(float(r['total_supply'])) / 1e24
        def fee(r): return float(r['txn_fee']) / 1e24
        last = rows[-1]
        daily = [{'date': r['date'][:10], 'supply': sup(r), 'fees': fee(r), 'txns': int(r['txns'] or 0)} for r in rows[-120:]]
        for i in range(1, len(daily)): daily[i]['netIssued'] = daily[i]['supply'] - daily[i - 1]['supply']
        def window(n):
            w = rows[-(n + 1):]
            if len(w) < n + 1: return None
            ds = sup(w[-1]) - sup(w[0]); fees = sum(fee(r) for r in w[1:])
            return {'days': n, 'netSupplyChange': ds, 'annualizedNetInflationPct': ds / sup(w[0]) * 365 / n * 100, 'txnFees': fees, 'burnEst70pct': fees * 0.7,
                    'burnEstPerDay': fees * 0.7 / n, 'grossIssuanceEst': ds + fees * 0.7, 'txnsPerDay': sum(int(r['txns'] or 0) for r in w[1:]) / n}
        out['supplyWindows'] = {k: window(n) for k, n in (('7d', 7), ('30d', 30), ('90d', 90))}
        out['feeBurnLastDay'] = {'date': last['date'][:10], 'txnFees': fee(last), 'burnEst70pct': fee(last) * 0.7, 'txns': int(last['txns'] or 0)}
        out['feeBurnNote'] = ('NEAR burns transaction fees except the 30% of function-call gas rebated to the called contract, so burned NEAR is between 70% and 100% of fees; '
                              'shown as 70% (lower bound). Source: nearblocks.io daily txn_fee. At current activity the burn is tiny versus issuance (see net supply change).')
        out['dailySeries'] = daily[-90:]
        out['src'].append('nearblocks.io /v1/charts daily total_supply + txn_fee (free)')
    cal = readj('unlocks_calendar.json') or {}
    u = next((t for t in cal.get('tokens', []) if t.get('geckoId') == 'near'), None)
    out['unlocks'] = ({'source': 'DefiLlama unlocks page via research/unlocks.py (data/unlocks_calendar.json)', 'url': u.get('url'), 'locked': u.get('locked'), 'next30dTokens': (u.get('windows') or {}).get('30d', {}).get('tokens'),
                       'next1yTokens': (u.get('windows') or {}).get('1y', {}).get('tokens'), 'cliffs': u.get('cliffs'), 'detail': u.get('scheduleDetail'), 'calendarAt': cal.get('generatedAt')}
                      if u else {'source': 'DefiLlama (data/unlocks_calendar.json)', 'note': 'NEAR not present in the unlock calendar'})
    return out

# ------------------------------------------------------------------ ZEC tokenomics
HALVING_INTERVAL = 1680000  # post-Blossom (75 s blocks)
HALVINGS = [1046400, 2726400, 4406400, 6086400]


def zec_tokenomics():
    out = {'src': []}
    zs = tryf('ZecStats summary', lambda: fetch('https://zecstats.org/api/zec/summary', timeout=30))
    bc = tryf('Blockchair zcash stats', lambda: fetch('https://api.blockchair.com/zcash/stats')['data'])
    height = None
    if zs:
        net = zs.get('network') or {}; supply = zs.get('supply') or {}; hv = zs.get('halving') or {}; pools = zs.get('pools') or {}
        height = net.get('height') or net.get('tip') or (zs.get('recentBlocks') or [{}])[0].get('height')
        out.update({'supply': supply.get('total'), 'maxSupply': supply.get('max'), 'pctIssued': supply.get('pctIssued'), 'inflationAnnualPctZecStats': supply.get('inflationAnnualPct'),
                    'emissionPerDay': supply.get('emissionPerDayZec'), 'blockSubsidy': hv.get('currentSubsidy'), 'nextSubsidy': hv.get('nextSubsidy'), 'halvingBlockZecStats': hv.get('block'),
                    'halvingEstZecStats': hv.get('estimatedDate'), 'minerSharePct': hv.get('minerSharePct'), 'zcgSharePct': hv.get('zcgSharePct'), 'lockboxSharePct': hv.get('lockboxSharePct'),
                    'lockboxBalance': pools.get('lockbox'), 'shieldedTotal': pools.get('shieldedTotal'), 'shieldedPct': pools.get('shieldedPct'),
                    'pools': {k: pools.get(k) for k in ('transparent', 'sprout', 'sapling', 'orchard', 'ironwood', 'lockbox')}, 'poolDeltas': pools.get('deltas'), 'poolsUpdatedAt': pools.get('updatedAt'),
                    'ironwood': {k: (zs.get('ironwood') or {}).get(k) for k in ('migrationPct', 'activationHeight', 'activationDate', 'orchardRemainingZec', 'ironwoodZec')}})
        out['src'].append('zecstats.org /api/zec/summary (free, CC BY 4.0)')
    if bc:
        out['heightBlockchair'] = bc.get('best_block_height'); out['blocks24h'] = bc.get('blocks_24h'); out['txs24h'] = bc.get('transactions_24h')
        height = height or bc.get('best_block_height')
        out['src'].append('Blockchair /zcash/stats (free tier; its circulation field is broken/negative so it is NOT used for supply)')
    out['height'] = height
    if height:
        nxt = next(h for h in HALVINGS if h > height)
        out['nextHalvingBlock'] = nxt; out['blocksToHalving'] = nxt - height
        out['nextHalvingEst'] = time.strftime('%Y-%m-%d', time.gmtime(NOW + (nxt - height) * 75))
        out['lastHalving'] = {'block': 2726400, 'date': '2024-11-23', 'subsidyAfter': 1.5625}
        out['halvingNote'] = ('Next halving computed here from the consensus schedule (2,726,400 + 1,680,000 = 4,406,400) at the 75 s target block time; ZecStats reports the same block. '
                              'ZIP 214 rev.3 notes funding-stream end heights move with the third halving if NU7 changes it, so treat the date as an estimate.')
        if out.get('blockSubsidy'):
            out['issuancePerDayCalc'] = out['blockSubsidy'] * 86400 / 75
            if out.get('supply'): out['inflationAnnualPctCalc'] = out['issuancePerDayCalc'] * 365.25 / out['supply'] * 100
    out['devFund'] = ('Block reward split (ZecStats live): miners {m}%, Zcash Community Grants {z}%, coinholder-controlled lockbox/fund {l}%. ZIP 1015 (NU6, Nov 2024) created the deferred lockbox; '
                      'NU6.1 (ZIP 1016 + ZIP 271, activation height 3,146,400, ~Nov 2025) disbursed the lockbox to a 2-of-3 key-holder multisig for coinholder-voted grants and extended the 12% stream and 8% ZCG '
                      'stream to block 4,406,400 (3rd halving). Lockbox balance shown is the live value-pool balance.').format(m=out.get('minerSharePct', '?'), z=out.get('zcgSharePct', '?'), l=out.get('lockboxSharePct', '?'))
    return out

# ------------------------------------------------------------------ news (RSS + Google News), deduped + timestamped
GN = 'https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&q='
NEWS_Q = {
    'NEAR': ['"NEAR Intents"', '"NEAR AI" OR "Near AI" Polosukhin', '"NEAR Protocol" partnership', '"NEAR" ETF Grayscale OR Bitwise OR "21Shares"', '"NEAR Protocol"'],
    'ZEC': ['Zcash NU7 OR "Network Upgrade 7"', 'Zashi Zcash', 'Zcash Crosslink OR "proof of stake"', 'Zcash ETF Grayscale', 'Zcash SEC OR regulation OR delisting OR MiCA', 'Zcash adoption OR shielded', 'Zcash Ironwood', 'Zcash'],
}
RSS = [('Cointelegraph', 'https://cointelegraph.com/rss'), ('Decrypt', 'https://decrypt.co/feed'), ('The Block', 'https://www.theblock.co/rss.xml'),
       ('z.cash', 'https://z.cash/feed/'), ('Shielded Labs', 'https://shieldedlabs.net/rss/'), ('Zcash Forum', 'https://forum.zcashcommunity.com/latest.rss')]
RX = {'NEAR': re.compile(r'\bNEAR\b(?! (?:term|record|zero|future|year|month|week|-term))|\bNear (?:Protocol|Intents|AI|Foundation)\b|Polosukhin|\bwNEAR\b'),
      'ZEC': re.compile(r'zcash|\bZEC\b|zashi|\bzebra\b|shielded labs|electric coin', re.I)}
TOPICS = [('intents', r'intent'), ('ai', r'\bAI\b|artificial intel|agent'), ('etf', r'\bETFs?\b|S-1|19b-4|filing'), ('partnership', r'partner|integrat|collaborat|launch(?:es|ed)? on'),
          ('upgrade', r'\bNU\d|network upgrade|ironwood|crosslink|proof[- ]of[- ]stake|\bPoS\b|zashi|zebra|hard fork|release|mainnet'),
          ('regulatory', r'\bSEC\b|regulat|delist|\bban\b|MiCA|AML|sanction|lawsuit|court|compliance'), ('adoption', r'adopt|merchant|payments?|users|wallet|record|shielded supply|treasury')]


def norm_title(t):
    t = re.sub(r'\s+-\s+[^-]{2,60}$', '', t)  # Google News " - Publisher"
    return re.sub(r'[^a-z0-9]+', ' ', t.lower()).strip()


def parse_rss(text, src):
    out = []
    try: root = ET.fromstring(text.encode('utf-8') if isinstance(text, str) else text)
    except Exception: return out
    for it in root.iter('item'):
        title = html.unescape((it.findtext('title') or '').strip()); link = (it.findtext('link') or '').strip(); pd = it.findtext('pubDate') or ''
        so = it.find('source'); pub = (so.text if src == 'Google News' and so is not None and so.text else src)
        try: ts = email.utils.parsedate_to_datetime(pd).timestamp()
        except Exception: ts = None
        if title: out.append({'title': title, 'url': link, 'ts': ts, 'source': pub})
    for it in root.iter('{http://www.w3.org/2005/Atom}entry'):
        title = (it.findtext('{http://www.w3.org/2005/Atom}title') or '').strip(); l = it.find('{http://www.w3.org/2005/Atom}link')
        out.append({'title': title, 'url': l.get('href') if l is not None else '', 'ts': None, 'source': src})
    return out


def news():
    seen = readj('priority_news_seen.json', {}) or {}
    items = {}
    def add(sym, x, via):
        if not x['title']: return
        k = norm_title(x['title'])
        if not k: return
        if x['ts'] and NOW - x['ts'] > 21 * 86400: return
        cur = items.get(k)
        if cur:
            if sym not in cur['tokens']: cur['tokens'].append(sym)
            if via not in cur['via']: cur['via'].append(via)
            return
        tp = [n for n, rx in TOPICS if re.search(rx, x['title'], re.I)]
        items[k] = {'id': k[:120], 'title': x['title'], 'url': x['url'], 'source': x['source'], 'publishedAt': int(x['ts'] * 1000) if x['ts'] else None,
                    'tokens': [sym], 'topics': tp, 'via': [via]}
    for sym, qs in NEWS_Q.items():
        for q in qs:
            res = tryf(f'google news {q}', lambda: parse_rss(fetch(GN + urllib.parse.quote(q + ' when:7d'), raw=True, timeout=20), 'Google News'), [])
            for x in res[:25]:
                if RX[sym].search(x['title']): add(sym, x, 'Google News: ' + q)
            time.sleep(0.7)
    for name, url in RSS:
        res = tryf(f'rss {name}', lambda: parse_rss(fetch(url, raw=True, timeout=20), name), [])
        if name == 'Zcash Forum': res = res[:8]  # community forum: newest topics only (noisy)
        for x in res:
            for sym in ('NEAR', 'ZEC'):
                if name in ('z.cash', 'Shielded Labs', 'Zcash Forum'):
                    if sym == 'ZEC': add(sym, x, 'RSS ' + name)
                elif RX[sym].search(x['title']): add(sym, x, 'RSS ' + name)
    out = []
    for k, it in items.items():
        it['firstSeen'] = seen.get(k) or int(NOW * 1000); seen[k] = it['firstSeen']
        it['t'] = it['publishedAt'] or it['firstSeen']
        out.append(it)
    cutoff = (NOW - 45 * 86400) * 1000
    seen = {k: v for k, v in seen.items() if v > cutoff}
    writej('priority_news_seen.json', seen)
    out.sort(key=lambda x: -x['t'])
    return {'items': out[:160], 'count': len(out), 'queries': NEWS_Q, 'rss': [n for n, _ in RSS],
            'note': 'Deduplicated by normalized headline (Google News publisher suffix stripped); timestamp = publisher pubDate, else first time this terminal saw it. Last 21 days.'}

# ------------------------------------------------------------------ narratives cross-reference
def narratives(cats):
    nd = readj('narratives.json') or {}
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from narratives_taxonomy import THEMES
    except Exception as e:
        THEMES = {}; ERR.append({'what': 'narratives taxonomy import', 'error': str(e)[:150]})
    catlist = tryf('coingecko categories list', lambda: fetch('https://api.coingecko.com/api/v3/coins/categories/list'), []) or []
    name2id = {c['name']: c['category_id'] for c in catlist}
    flagged = set(nd.get('flagged') or []); over = set(nd.get('overcrowded') or [])
    out = {}
    for t in TOKENS:
        ids = [name2id.get(n) for n in cats.get(t['cg'], [])]
        ids = [i for i in ids if i]
        rows = []
        for th in nd.get('themes', []):
            tax = THEMES.get(th['id'], {})
            incat = sorted(set(th.get('cgCategories') or []) & set(ids))
            excl = t['cg'] in (tax.get('exclude') or [])
            intop = any((x.get('id') == t['cg']) for x in th.get('tokens') or [])
            if not (incat or intop): continue
            me = next((x for x in th.get('tokens') or [] if x.get('id') == t['cg']), None)
            rows.append({'theme': th['id'], 'name': th['name'], 'status': th.get('status'), 'crowd': th.get('crowdLevel'), 'momentum': th.get('momentum'), 'rank': th.get('rank'),
                         'mcapGrowth7': th.get('mcapGrowth7'), 'attentionVel': th.get('attentionVel'), 'breadth7': th.get('breadth7'), 'plain': th.get('plain'),
                         'viaCgCategory': incat, 'excludedByTaxonomy': excl, 'inThemeTopTokens': intop, 'flagged': th['id'] in flagged, 'overcrowded': th['id'] in over,
                         'tokenCh7': me.get('ch7') if me else None, 'leader7': th.get('leader7'),
                         'counted': (not excl)})
        rows.sort(key=lambda r: (not r['counted'], -(r['momentum'] or 0)))
        out[t['sym']] = {'cgCategories': cats.get(t['cg'], []), 'themes': rows}
    q = next((r for r in out.get('ZEC', {}).get('themes', []) if r['theme'] == 'quantum'), None)
    out['zecQuantumNote'] = (('CoinGecko DOES tag Zcash "Quantum-Resistant", but the Narratives Desk taxonomy excludes zcash from the quantum theme (it is counted under Privacy/ZK), '
                              'so ZEC does not drive or ride that theme\'s score. The quantum theme\'s move is led by ' + (((q or {}).get('leader7') or {}).get('symbol') or 'other coins') + ' (largest 7-day gain in the theme)' + '.')
                             if q and q['excludedByTaxonomy'] else ('ZEC is counted in the quantum theme.' if q and q['counted'] else 'ZEC is not tagged quantum-resistant by CoinGecko right now.'))
    out['narrativesAt'] = nd.get('generatedAt')
    return out

# ------------------------------------------------------------------ stats helpers (stdlib + numpy, no scipy)
import numpy as np


def betacf(a, b, x):
    MAXIT, EPS, FPMIN = 300, 3e-14, 1e-300
    qab, qap, qam = a + b, a + 1, a - 1; c = 1.0; d = 1 - qab * x / qap
    d = FPMIN if abs(d) < FPMIN else d; d = 1 / d; h = d
    for m in range(1, MAXIT + 1):
        m2 = 2 * m; aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d; d = FPMIN if abs(d) < FPMIN else d; c = 1 + aa / c; c = FPMIN if abs(c) < FPMIN else c; d = 1 / d; h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d; d = FPMIN if abs(d) < FPMIN else d; c = 1 + aa / c; c = FPMIN if abs(c) < FPMIN else c; d = 1 / d; de = d * c; h *= de
        if abs(de - 1) < EPS: break
    return h


def betai(a, b, x):
    if x <= 0: return 0.0
    if x >= 1: return 1.0
    bt = math.exp(math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) + a * math.log(x) + b * math.log(1 - x))
    return bt * betacf(a, b, x) / a if x < (a + 1) / (a + b + 2) else 1 - bt * betacf(b, a, 1 - x) / b


def t_p(t, df):
    if df <= 0 or t is None or not math.isfinite(t): return None
    return betai(df / 2, 0.5, df / (df + t * t))


def f_p(F, d1, d2):
    if F is None or not math.isfinite(F) or F < 0 or d2 <= 0: return None
    return betai(d2 / 2, d1 / 2, d2 / (d2 + d1 * F))


def corr(x, y):
    x = np.asarray(x, float); y = np.asarray(y, float); m = np.isfinite(x) & np.isfinite(y); x, y = x[m], y[m]; n = len(x)
    if n < 8 or x.std() == 0 or y.std() == 0: return {'r': None, 'n': int(n), 'p': None}
    r = float(np.corrcoef(x, y)[0, 1]); t = r * math.sqrt((n - 2) / max(1e-12, 1 - r * r))
    return {'r': round(r, 4), 'n': int(n), 'p': t_p(t, n - 2)}


def ols(y, X):
    y = np.asarray(y, float); X = np.asarray(X, float)
    beta, *_ = np.linalg.lstsq(X, y, rcond=None); res = y - X @ beta; n, k = X.shape
    s2 = res @ res / (n - k); cov = s2 * np.linalg.pinv(X.T @ X); se = np.sqrt(np.diag(cov))
    return beta, se, res, n, k


def adf(series, lags=4):
    y = np.asarray(series, float); dy = np.diff(y); n = len(dy)
    rows = []; Y = []
    for t in range(lags, n):
        rows.append([1.0, y[t]] + [dy[t - i] for i in range(1, lags + 1)]); Y.append(dy[t])
    b, se, *_ = ols(Y, rows); tstat = b[1] / se[1]
    return float(tstat)


def granger(y, x, lags):
    """Does x help predict y beyond y's own lags? F-test, returns F, p, n."""
    y = np.asarray(y, float); x = np.asarray(x, float); n = len(y)
    Y = y[lags:]; R = [[1.0] + [y[t - i] for i in range(1, lags + 1)] for t in range(lags, n)]
    U = [r + [x[t - i] for i in range(1, lags + 1)] for r, t in zip(R, range(lags, n))]
    _, _, rr, nn, kr = ols(Y, R); _, _, ru, _, ku = ols(Y, U)
    rss_r, rss_u = rr @ rr, ru @ ru; d1 = ku - kr; d2 = nn - ku
    F = ((rss_r - rss_u) / d1) / (rss_u / d2)
    return {'lags': lags, 'F': round(float(F), 3), 'p': f_p(float(F), d1, d2), 'n': int(nn)}

# ------------------------------------------------------------------ ZEC shielded-pool deep dive
POOLS = ('sprout', 'sapling', 'orchard', 'ironwood')


def shielded_history(prev):
    rows = {}
    zs = tryf('ZecScope daily (genesis..)', lambda: fetch('https://www.zecscope.com/api/v1/daily', timeout=90), None)
    srcs = []
    if zs and zs.get('rows'):
        for r in zs['rows']:
            rows[r['date']] = {'date': r['date'], 'height': r.get('height'), 'supply': num(r.get('supply')), 'transparent': num(r.get('transparent')), 'lockbox': num(r.get('lockbox')),
                               **{p: num(r.get(p)) or 0.0 for p in POOLS}, 'src': 'zecscope'}
        srcs.append({'name': 'ZecScope /api/v1/daily (measured node value pools, one row per UTC day since genesis)', 'from': zs['rows'][0]['date'], 'to': zs['rows'][-1]['date'], 'n': len(zs['rows'])})
    overlap = []
    pc = tryf('ZecStats pools.csv', lambda: fetch('https://zecstats.org/api/zec/pools.csv', raw=True, timeout=40), None)
    if pc:
        rd = list(csv.DictReader(io.StringIO(pc)))
        for r in rd:
            new = {'date': r['day'], 'height': int(r['height']), 'supply': num(r['chain_supply']), 'transparent': num(r['transparent']), 'lockbox': num(r['lockbox']),
                   **{p: num(r.get(p)) or 0.0 for p in POOLS}, 'src': 'zecstats'}
            old = rows.get(r['day'])
            if old:
                so = sum(old[p] for p in POOLS); sn = sum(new[p] for p in POOLS)
                overlap.append(abs(sn / so - 1) * 100 if so else None)
            rows[r['day']] = new  # newer source wins on overlap (end-of-day snapshot)
        if rd: srcs.append({'name': 'ZecStats /api/zec/pools.csv (own daily snapshot archive, CC BY 4.0)', 'from': rd[0]['day'], 'to': rd[-1]['day'], 'n': len(rd)})
    # carry forward rows we stored earlier if a source is down
    for r in (prev or {}).get('history', []):
        d = r[0]
        if d not in rows:
            rows[d] = {'date': d, 'height': None, 'supply': r[6], 'transparent': None, 'lockbox': None, 'sprout': r[2], 'sapling': r[3], 'orchard': r[4], 'ironwood': r[5], 'src': 'stored'}
    ov = [x for x in overlap if x is not None]
    return [rows[k] for k in sorted(rows)], srcs, ({'days': len(ov), 'maxAbsDiffPct': round(max(ov), 3), 'meanAbsDiffPct': round(sum(ov) / len(ov), 4)} if ov else None)


def price_history():
    out = {}; start = 1546300800000  # 2019-01-01 (Binance ZECUSDT spot starts 2019-03-21)
    for _ in range(6):
        k = fetch(f'https://data-api.binance.vision/api/v3/klines?symbol=ZECUSDT&interval=1d&limit=1000&startTime={start}')
        if not k: break
        for c in k: out[time.strftime('%Y-%m-%d', time.gmtime(c[0] / 1000))] = float(c[4])
        start = k[-1][0] + 86400000
        if len(k) < 1000: break
    return out


def zec_shielded(cur_price=None):
    prev = readj('zec_shielded.json')
    hist, srcs, overlap = shielded_history(prev)
    px = tryf('Binance ZECUSDT daily klines', price_history, {}) or {}
    if not px:
        pc = tryf('ZecStats price.csv', lambda: fetch('https://zecstats.org/api/zec/price.csv', raw=True), None)
        if pc: px = {r['day']: float(r['close']) for r in csv.DictReader(io.StringIO(pc))}
    today = time.strftime('%Y-%m-%d', time.gmtime(NOW))
    if cur_price: px[today] = cur_price  # live CoinGecko for the open UTC day
    for r in hist:
        r['shielded'] = sum(r[p] or 0 for p in POOLS)
        r['price'] = px.get(r['date'])
        r['share'] = r['shielded'] / r['supply'] * 100 if r.get('supply') else None
    last = hist[-1]
    def ago(n):
        d = time.strftime('%Y-%m-%d', time.gmtime(time.mktime(time.strptime(last['date'], '%Y-%m-%d')) - n * 86400))
        return next((r for r in reversed(hist) if r['date'] <= d), None)
    cur = {'date': last['date'], 'height': last.get('height'), 'supply': last['supply'], 'shielded': last['shielded'], 'sharePct': last['share'],
           'pools': {p: last[p] for p in POOLS}, 'poolSharePct': {p: (last[p] / last['supply'] * 100 if last['supply'] else None) for p in POOLS},
           'transparent': last.get('transparent'), 'lockbox': last.get('lockbox'), 'src': last['src']}
    for n in (1, 7, 30, 90, 365):
        a = ago(n)
        if a: cur[f'ch{n}d'] = {'zec': last['shielded'] - a['shielded'], 'pct': (last['shielded'] / a['shielded'] - 1) * 100 if a['shielded'] else None, 'sharePts': (last['share'] or 0) - (a['share'] or 0),
                                'pools': {p: last[p] - a[p] for p in POOLS}}
    # ------------- analysis window: 2020-01-01 .. last day with price
    A = [r for r in hist if r['date'] >= '2020-01-01' and r['price'] and r['shielded'] > 0]
    dates = [r['date'] for r in A]
    lp = np.log([r['price'] for r in A]); ls = np.log([r['shielded'] for r in A]); S = np.array([r['shielded'] for r in A]); sup = np.array([r['supply'] for r in A])
    ret = np.diff(lp); flow = np.diff(S); flow_pct = np.diff(ls) * 100
    an = {'window': {'from': dates[0], 'to': dates[-1], 'days': len(A)}}
    an['levels'] = {'logPrice_vs_logShielded': corr(lp, ls), 'price_vs_sharePct': corr([r['price'] for r in A], [r['share'] for r in A]),
                    'note': 'Level correlations between two trending series are usually spurious (both drift over time), so the p-value here is NOT meaningful on its own. Use the change-based and cointegration tests below.'}
    an['daily'] = {'return_vs_flowPct_sameDay': corr(ret, flow_pct)}
    # weekly, non-overlapping (Mondays of the series)
    wk = list(range(0, len(A), 7)); wl = lp[wk]; ws = ls[wk]; wS = S[wk]
    wret = np.diff(wl); wflow = np.diff(ws) * 100
    lead = []
    for L in range(-4, 5):  # L>0: flow leads price by L weeks (flow_t vs ret_{t+L})
        if L > 0: c = corr(wflow[:-L], wret[L:])
        elif L < 0: c = corr(wflow[-L:], wret[:L])
        else: c = corr(wflow, wret)
        lead.append({'lagWeeks': L, **c})
    an['weekly'] = {'return_vs_flowPct_sameWeek': corr(wret, wflow), 'leadLag': lead,
                    'leadLagNote': 'lagWeeks > 0 = shielded flow this week vs price return L weeks LATER (flow leads); < 0 = price return L weeks EARLIER vs this week\'s flow (price leads). Non-overlapping weeks.'}
    gr = {'flowLeadsPrice_daily': [granger(ret, flow_pct, L) for L in (1, 3, 7)], 'priceLeadsFlow_daily': [granger(flow_pct, ret, L) for L in (1, 3, 7)],
          'flowLeadsPrice_weekly': [granger(wret, wflow, L) for L in (1, 2, 4)], 'priceLeadsFlow_weekly': [granger(wflow, wret, L) for L in (1, 2, 4)]}
    an['granger'] = gr
    # rolling correlations (daily changes, 90d) and (weekly changes, 52w) - for the chart
    roll = []
    for i in range(90, len(ret) + 1, 7):
        c = corr(ret[i - 90:i], flow_pct[i - 90:i]); roll.append([dates[i], c['r'], c['p']])
    an['rolling90d'] = roll
    an['rolling90dSummary'] = {'n': len(roll), 'share_positive': round(sum(1 for x in roll if x[1] and x[1] > 0) / max(1, len(roll)), 3), 'share_p_lt_05': round(sum(1 for x in roll if x[2] is not None and x[2] < 0.05) / max(1, len(roll)), 3),
                               'latest': roll[-1] if roll else None}
    # cointegration (Engle-Granger): log price on log shielded, ADF on residuals
    b, se, res, n, k = ols(lp, np.column_stack([np.ones(len(ls)), ls]))
    adf_res = adf(res, 7); adf_lp = adf(lp, 7); adf_ls = adf(ls, 7)
    an['cointegration'] = {'method': 'Engle-Granger: OLS log(price) = a + b*log(shielded), ADF(7 lags, constant) on residuals', 'beta': round(float(b[1]), 3), 'adfResidualT': round(adf_res, 3),
                           'critical': {'1%': -3.90, '5%': -3.34, '10%': -3.04}, 'cointegrated5pct': adf_res < -3.34, 'adfLogPriceT': round(adf_lp, 3), 'adfLogShieldedT': round(adf_ls, 3),
                           'unitRootCritical5pct': -2.86,
                           'read': ('Residuals look stationary at 5%: log price and log shielded supply move together over the long run (cointegrated).' if adf_res < -3.34 else
                                    'No cointegration at 5%: the long-run level relationship is not statistically stable, so level-based projections below are fragile.')}
    # ------------- accumulation signal
    fl = np.diff([r['shielded'] for r in hist]); fdates = [r['date'] for r in hist[1:]]
    def roll_sum(a, n): c = np.cumsum(np.insert(a, 0, 0)); return c[n:] - c[:-n]
    f7 = roll_sum(fl, 7); f30 = roll_sum(fl, 30)
    def z(arr, win):
        base = arr[-win - 1:-1]; base = base[np.isfinite(base)]
        return float((arr[-1] - base.mean()) / base.std()) if len(base) > 30 and base.std() > 0 else None
    z7 = z(f7, 365); z30 = z(f30, 365); z1 = z(fl, 180)
    rate7, rate30 = f7[-1] / 7, f30[-1] / 30
    flags = []
    if z1 is not None and z1 <= -3: flags.append({'kind': 'deshield_spike', 'level': 'high', 'text': f'Deshielding spike: {fl[-1]:,.0f} ZEC left the shielded pools on {fdates[-1]} ({z1:.1f} standard deviations vs the last 180 days).'})
    if z1 is not None and z1 >= 3: flags.append({'kind': 'shield_spike', 'level': 'high', 'text': f'Shielding spike: +{fl[-1]:,.0f} ZEC moved into shielded pools on {fdates[-1]} ({z1:.1f} standard deviations vs the last 180 days).'})
    if f7[-1] > 0 and rate7 > 1.5 * max(rate30, 1e-9) and f30[-1] > 0: flags.append({'kind': 'inflow_accelerating', 'level': 'watch', 'text': f'Shielding is accelerating: last 7 days averaged {rate7:,.0f} ZEC/day vs {rate30:,.0f} ZEC/day over 30 days.'})
    if f30[-1] > 0 and f7[-1] < 0: flags.append({'kind': 'inflow_reversing', 'level': 'watch', 'text': f'Inflows reversing: 30-day net flow is +{f30[-1]:,.0f} ZEC but the last 7 days are {f7[-1]:,.0f} ZEC (net deshielding).'})
    if z7 is not None and z7 <= -2: flags.append({'kind': 'outflow_7d_extreme', 'level': 'high', 'text': f'7-day net deshielding of {f7[-1]:,.0f} ZEC is {z7:.1f} standard deviations below the 1-year norm.'})
    if z7 is not None and z7 >= 2: flags.append({'kind': 'inflow_7d_extreme', 'level': 'watch', 'text': f'7-day net shielding of +{f7[-1]:,.0f} ZEC is {z7:.1f} standard deviations above the 1-year norm.'})
    sig = {'asOf': fdates[-1], 'flow1d': float(fl[-1]), 'flow7d': float(f7[-1]), 'flow30d': float(f30[-1]), 'rate7dPerDay': float(rate7), 'rate30dPerDay': float(rate30),
           'z1d_vs180d': z1, 'z7d_vs1y': z7, 'z30d_vs1y': z30, 'flags': flags,
           'note': 'Net flow = day-over-day change in total shielded supply (Sprout+Sapling+Orchard+Ironwood). Pool-to-pool migrations (e.g. Orchard->Ironwood) net to zero. z-scores use overlapping rolling windows, so they overstate rarity a little.',
           'series': [[fdates[i], float(fl[i]), float(f7[i - 6]) if i >= 6 else None, float(f30[i - 29]) if i >= 29 else None] for i in range(max(0, len(fl) - 400), len(fl))]}
    # ------------- scenario model
    price_now = cur_price or A[-1]['price']; supply_now = last['supply']; sh_now = last['shielded']
    resid_q = np.percentile(res, [5, 50, 95])
    # walk-forward: refit at each month end with data to date, then predict price 90 days later GIVEN the actual shielded supply then
    wf = []
    idx = {d: i for i, d in enumerate(dates)}
    for i in range(365, len(A) - 90, 30):
        bb, *_ = ols(lp[:i], np.column_stack([np.ones(i), ls[:i]]))
        pred = bb[0] + bb[1] * ls[i + 90]; wf.append(float(lp[i + 90] - pred))
    wf = np.array(wf)
    wf_err = {'n': int(len(wf)), 'medianAbsPctError': float(np.median(np.abs(np.exp(wf) - 1)) * 100) if len(wf) else None,
              'p90AbsPctError': float(np.percentile(np.abs(np.exp(wf) - 1), 90) * 100) if len(wf) else None, 'bias': float(np.median(wf)) if len(wf) else None,
              'note': 'Refit monthly on data up to that date, predict the price 90 days later using the shielded supply that actually happened (i.e. the error you get even when you guess the shielded supply right).'}
    ins = {'medianAbsPctError': float(np.median(np.abs(np.exp(res) - 1)) * 100), 'r2': float(1 - (res @ res) / ((lp - lp.mean()) @ (lp - lp.mean()))), 'residualSdLog': float(res.std())}
    n1 = min(365, len(A)); b1, se1, res1, *_ = ols(lp[-n1:], np.column_stack([np.ones(n1), ls[-n1:]])); rq1 = np.percentile(res1, [5, 50, 95])
    ins1 = {'medianAbsPctError': float(np.median(np.abs(np.exp(res1) - 1)) * 100), 'r2': float(1 - (res1 @ res1) / ((lp[-n1:] - lp[-n1:].mean()) @ (lp[-n1:] - lp[-n1:].mean()))), 'n': n1}
    ok1 = bool(b1[1] > 0 and ins1['r2'] >= 0.1)
    ratio = np.array([r['price'] * r['supply'] / r['shielded'] for r in A])  # market cap per shielded ZEC (= price / shielded share)
    last365 = ratio[-365:]
    rq_all = np.percentile(ratio, [10, 50, 90]); rq_1y = np.percentile(last365, [10, 50, 90])
    ratio_now = price_now * supply_now / sh_now
    targets = [('current', sh_now), ('+25%', sh_now * 1.25), ('+50%', sh_now * 1.5), ('+100%', sh_now * 2.0), ('40% of supply', 0.40 * supply_now), ('50% of supply', 0.50 * supply_now), ('60% of supply', 0.60 * supply_now)]
    rows = []
    for name, tgt in targets:
        base = math.exp(b[0] + b[1] * math.log(tgt))
        rows.append({'scenario': name, 'shieldedZec': tgt, 'sharePct': tgt / supply_now * 100,
                     'loglog': {'low': base * math.exp(resid_q[0]), 'base': base, 'high': base * math.exp(resid_q[2])},
                     'loglog1y': None if not ok1 else {'low': math.exp(b1[0] + b1[1] * math.log(tgt) + rq1[0]), 'base': math.exp(b1[0] + b1[1] * math.log(tgt)), 'high': math.exp(b1[0] + b1[1] * math.log(tgt) + rq1[2])},
                     'ratio1y': {'low': rq_1y[0] * tgt / supply_now, 'base': rq_1y[1] * tgt / supply_now, 'high': rq_1y[2] * tgt / supply_now},
                     'ratioSince2020': {'low': rq_all[0] * tgt / supply_now, 'base': rq_all[1] * tgt / supply_now, 'high': rq_all[2] * tgt / supply_now},
                     'ratioNow': ratio_now * tgt / supply_now})
    scen = {'priceNow': price_now, 'supplyNow': supply_now, 'shieldedNow': sh_now,
            'loglog': {'a': float(b[0]), 'b': float(b[1]), 'seB': float(se[1]), 'fitWindow': [dates[0], dates[-1]], 'inSample': ins, 'walkForward90d': wf_err, 'residualPctiles5_50_95': [float(x) for x in resid_q],
                       'fittedNow': math.exp(b[0] + b[1] * math.log(sh_now)),
                       'explain': f'log(price) = {b[0]:.2f} + {b[1]:.2f} x log(shielded ZEC), fit on daily data since 2020. Low/high = 5th/95th percentile of historical misses around the line (empirical band, not a formal confidence interval: the misses are strongly autocorrelated).'},
            'loglog1y': {'a': float(b1[0]), 'b': float(b1[1]), 'seB': float(se1[1]), 'inSample': ins1, 'fittedNow': math.exp(b1[0] + b1[1] * math.log(sh_now)), 'residualPctiles5_50_95': [float(x) for x in rq1], 'usable': ok1,
                         'explain': f'Same log-log line fit on the last {n1} days only (the post-2025 regime): log(price) = {b1[0]:.2f} + {b1[1]:.2f} x log(shielded). Very short sample; a slope this size mostly reflects the 2025-26 rally, not a stable law.' + ('' if ok1 else f' NOT USED in the scenario table: slope {b1[1]:.2f} (<=0) and/or R2 {ins1["r2"]:.2f} (<0.10) means there is no usable price-vs-shielded relationship inside the last year.')},
            'ratio': {'nowUsdPerShieldedZec': ratio_now, 'since2020': {'p10': rq_all[0], 'p50': rq_all[1], 'p90': rq_all[2]}, 'last365d': {'p10': rq_1y[0], 'p50': rq_1y[1], 'p90': rq_1y[2]},
                      'explain': 'Market cap per shielded ZEC (= price / shielded share). Implied price = ratio x target shielded ZEC / current supply. Low/base/high = 10th/50th/90th percentile of the ratio actually observed.'},
            'rows': rows,
            'label': 'SCENARIOS, NOT PREDICTIONS. They answer "if shielded supply were X and the market valued it the way it has before". Shielded supply does not cause price; the two have trended together. Uses current supply (it grows ~1,800 ZEC/day).'}
    # ------------- chart series (daily since 2020 + weekly before)
    series = [[r['date'], round(r['shielded'], 2), round(r['sprout'], 2), round(r['sapling'], 2), round(r['orchard'], 2), round(r['ironwood'], 2), round(r['supply'], 2) if r['supply'] else None, r['price']]
              for i, r in enumerate(hist) if r['date'] >= '2020-01-01' or i % 7 == 0]
    out = {'generatedAt': int(NOW * 1000), 'current': cur, 'sources': srcs, 'sourceOverlapCheck': overlap, 'priceSource': 'Binance ZECUSDT spot daily close (data-api.binance.vision); today = live CoinGecko',
           'historyCols': ['date', 'shielded', 'sprout', 'sapling', 'orchard', 'ironwood', 'supply', 'price'], 'history': series, 'analysis': an, 'signal': sig, 'scenarios': scen,
           'caveats': ['Shielded and price both trend: level correlations are mostly common drift. Only the change-based tests, Granger tests and the cointegration test say anything about co-movement.',
                       'Ironwood (NU6.3, active since block 3,428,143 on 2026-07-28 per ZecStats/ZecZcash) is counted as shielded on the same basis as Sprout/Sapling/Orchard.',
                       'Exchange/custodian behaviour (e.g. an exchange moving reserves into a shielded pool) can move shielded supply without any change in end-user demand.',
                       'Daily rows are end-of-UTC-day pool balances; ZecScope covers genesis..' + (srcs[0]['to'] if srcs else '?') + ', ZecStats from 2026-07-30; overlap agreement is reported in sourceOverlapCheck.',
                       'p-values assume independent observations; daily crypto returns have fat tails and volatility clustering, so treat p near 0.05 as weak evidence.'],
           'nfa': 'Research from free public data. Not financial advice.'}
    writej('zec_shielded.json', clean(out))
    return out

# ------------------------------------------------------------------ main
def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
    prev = readj('priority.json', {}) or {}
    hist = readj('priority_history.json', {}) or {}
    mk = tryf('coingecko markets', market, {}) or {}
    if mode == 'shielded':
        zec_shielded((mk.get('zcash') or {}).get('price')); return
    cats = {}
    for t in TOKENS:
        c = tryf('coingecko categories ' + t['cg'], lambda: cg_categories(t['cg']))
        cats[t['cg']] = c if c is not None else ((prev.get('narratives') or {}).get(t['sym'], {}).get('cgCategories') or [])
    out = {'generatedAt': int(NOW * 1000), 'tokens': {}, 'nfa': 'Free public data; null = source unavailable (see errors). Not financial advice.'}
    for t in TOKENS:
        p = perps_for(t, hist)
        out['tokens'][t['sym']] = {'sym': t['sym'], 'name': t['name'], 'cgId': t['cg'], 'market': mk.get(t['cg']), 'perps': p}
        hh = hist.setdefault('px:' + t['sym'], []); m = mk.get(t['cg']) or {}
        if m.get('price') and (not hh or NOW * 1000 - hh[-1][0] > 20 * 60e3): hh.append([int(NOW * 1000), m['price'], p.get('oiUsdTotal'), p.get('fundingAnnPctOiWeighted')])
        del hh[:-500]
    out['tokens']['NEAR']['tokenomics'] = near_tokenomics()
    out['tokens']['ZEC']['tokenomics'] = zec_tokenomics()
    out['news'] = news()
    out['narratives'] = narratives(cats)
    z = readj('zec_shielded.json')
    if mode == 'all' and (not z or NOW * 1000 - z.get('generatedAt', 0) > 20 * 3600e3):
        tryf('zec shielded deep dive', lambda: zec_shielded((mk.get('zcash') or {}).get('price')))
    out['errors'] = ERR
    writej('priority_history.json', hist)
    writej('priority.json', clean(out))


if __name__ == '__main__':
    main()
    if ERR: print(json.dumps(ERR, indent=1)[:3000], file=sys.stderr)
