#!/usr/bin/env python3
"""VC / fund / market-maker wallet tracker (free sources only; NO Nansen calls, NO paid X).
labels   : build data/vc_wallets.json from
           - dawsbot/eth-labels (GitHub, accounts.csv: Etherscan/Basescan/BscScan... name tags, MIT)        -> chain ids 1/56/8453/...
           - brianleect/etherscan-labels (GitHub, combinedAccountLabels.json for etherscan + bscscan, 2023 snapshot)
           - Blockscout metadata service (keyless public tags incl. Open Labels Initiative / Kleros curated tags)
           - labels already paid for in data/nansen_crash_raw.json / nansen_crash.json / nansen_cache.json (Fund + Smart Trader labels)
           Not usable keyless (tried 2026-10-11): Etherscan label pages (Cloudflare 403), Arkham (API key / login), Dune API (key),
           Solscan labels (Pro API key).
monitor  : token inflows into labeled wallets: Ethereum + Base via Blockscout v2 token-transfers (keyless), BSC + Robinhood Chain via
           public RPC eth_getLogs (Transfer to wallet), Solana via getTokenAccountsByOwner snapshots (diff vs previous run).
           Flags tokens NOT yet widely known (low mcap, few holders, young pool, no CoinGecko listing) with a real DEX market.
history  : past cases where labeled wallets received tokens before the token's first DEX pool (pre-listing allocation) or before a
           >=2x run, with tx hashes and lead time, plus the base rate over all qualifying inflows.
Usage: vcwatch.py labels | monitor | history | all"""
import csv, json, os, re, sys, time, math, calendar
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from patterns_common import http, log, DATA_DIR, ROOT, COUNTS, GAPS
GAPS.update({'eth.blockscout.com': 0.25, 'base.blockscout.com': 0.25, 'metadata.services.blockscout.com': 0.15, 'api.coingecko.com': 6.5,
             'bsc-rpc.publicnode.com': 0.25, 'rpc.mainnet.chain.robinhood.com': 0.25, 'raw.githubusercontent.com': 0.1, 'api.github.com': 1})
SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vcwatch_src')
CACHE = os.path.join(DATA_DIR, 'vcwatch_cache'); os.makedirs(CACHE, exist_ok=True); os.makedirs(SRC, exist_ok=True)
CHAIN_ID = {1: 'ethereum', 56: 'bsc', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon', 43114: 'avalanche', 480: 'worldchain', 100: 'gnosis'}  # celo omitted: its fund tags are validators
now = lambda: int(time.time())

# ---------- entity dictionary (name regex -> canonical entity, type). Only used to NORMALISE labels found in sources. ----------
ENT = [
  # market makers / trading firms / OTC
  (r'\bwintermute\b', 'Wintermute', 'market_maker'), (r'\bgsr\b(?! ?:? ?token)', 'GSR', 'market_maker'), (r'\bjump (trading|crypto)\b|^jump\b', 'Jump Trading / Jump Crypto', 'market_maker'),
  (r'\bdwf\b', 'DWF Labs', 'market_maker'), (r'\bamber ?group\b|^amber$', 'Amber Group', 'market_maker'), (r'\bflowdesk\b', 'Flowdesk', 'market_maker'),
  (r'\bcumberland\b', 'Cumberland (DRW)', 'market_maker'), (r'\bb2c2\b', 'B2C2', 'market_maker'), (r'\bkeyrock\b', 'Keyrock', 'market_maker'),
  (r'\bauros\b', 'Auros', 'market_maker'), (r'\bkairon\b', 'Kairon Labs', 'market_maker'), (r'\bselini\b', 'Selini Capital', 'market_maker'),
  (r'\bpresto labs\b', 'Presto Labs', 'market_maker'), (r'\bfolkvang\b', 'Folkvang', 'market_maker'), (r'\btokka labs\b', 'Tokka Labs', 'market_maker'),
  (r'\bqcp capital\b', 'QCP Capital', 'market_maker'), (r'\bgenesis trading\b', 'Genesis Trading', 'otc_desk'), (r'\balameda research\b', 'Alameda Research', 'market_maker'),
  (r'\bgalaxy digital\b', 'Galaxy Digital', 'fund_trading'), (r'\befficient frontier\b', 'Efficient Frontier', 'market_maker'), (r'\bgravity team\b', 'Gravity Team', 'market_maker'),
  (r'\blaser digital\b', 'Laser Digital (Nomura)', 'market_maker'), (r'\bjane street\b', 'Jane Street', 'market_maker'), (r'\bmatrixport\b', 'Matrixport', 'otc_desk'),
  (r'\bfalconx\b', 'FalconX', 'otc_desk'), (r'\bcircle trade\b', 'Circle Trade', 'otc_desk'), (r'\bnonco\b', 'Nonco', 'market_maker'), (r'\bmanifold trading\b', 'Manifold Trading', 'market_maker'),
  (r'\bdexterity capital\b', 'Dexterity Capital', 'market_maker'), (r'\bsigma capital\b', 'Sigma Capital', 'market_maker'), (r'\bbluesky capital\b', 'Bluesky Capital', 'market_maker'),
  # VCs / funds
  (r'\ba16z\b|andreessen', 'a16z', 'vc_fund'), (r'\bparadigm\b(?! bridge)', 'Paradigm', 'vc_fund'), (r'\bpolychain\b(?! monsters)', 'Polychain Capital', 'vc_fund'),
  (r'\bmulticoin\b', 'Multicoin Capital', 'vc_fund'), (r'\bpantera\b', 'Pantera Capital', 'vc_fund'), (r'\bdragonfly\b', 'Dragonfly', 'vc_fund'),
  (r'\bdelphi (digital|ventures|labs)\b', 'Delphi', 'vc_fund'), (r'\bthree arrows\b|\b3ac\b', 'Three Arrows Capital', 'vc_fund'), (r'\bblocktower\b', 'BlockTower Capital', 'vc_fund'),
  (r'\bframework (ventures)?\b', 'Framework Ventures', 'vc_fund'), (r'\bspartan (group|capital)\b', 'Spartan Group', 'vc_fund'), (r'\bhashed\b', 'Hashed', 'vc_fund'),
  (r'\bbinance labs\b|\byzi labs\b', 'Binance Labs / YZi Labs', 'vc_fund'), (r'\bcoinbase ventures\b', 'Coinbase Ventures', 'vc_fund'), (r'\bdefiance capital\b', 'DeFiance Capital', 'vc_fund'),
  (r'\bmechanism capital\b', 'Mechanism Capital', 'vc_fund'), (r'\bnascent\b', 'Nascent', 'vc_fund'), (r'\b1kx\b', '1kx', 'vc_fund'), (r'\barrington\b', 'Arrington Capital', 'vc_fund'),
  (r'\banimoca\b', 'Animoca Brands', 'vc_fund'), (r'\bfenbushi\b', 'Fenbushi Capital', 'vc_fund'), (r'\bmirana\b', 'Mirana Ventures', 'vc_fund'),
  (r'\bblockchain capital\b', 'Blockchain Capital', 'vc_fund'), (r'\belectric capital\b', 'Electric Capital', 'vc_fund'), (r'\bvariant fund\b|^variant\b', 'Variant', 'vc_fund'),
  (r'\bhack vc\b', 'Hack VC', 'vc_fund'), (r'\boutlier ventures\b', 'Outlier Ventures', 'vc_fund'), (r'\bld capital\b', 'LD Capital', 'vc_fund'), (r'\bcms holdings\b', 'CMS Holdings', 'vc_fund'),
  (r'\bfasanara\b', 'Fasanara', 'vc_fund'), (r'\bparafi\b', 'ParaFi Capital', 'vc_fund'), (r'\bhypersphere\b', 'Hypersphere Ventures', 'vc_fund'), (r'\bsigil fund\b', 'Sigil Fund', 'vc_fund'),
  (r'\brobot ventures\b', 'Robot Ventures', 'vc_fund'), (r'\bmaven ?11\b', 'Maven 11', 'vc_fund'), (r'\blemniscap\b', 'Lemniscap', 'vc_fund'), (r'\bkenetic\b', 'Kenetic Capital', 'vc_fund'),
  (r'\bversion one\b', 'Version One Ventures', 'vc_fund'), (r'\barca\b(?!de)', 'Arca', 'vc_fund'), (r'\bbig brain holdings\b', 'Big Brain Holdings', 'vc_fund'), (r'\bsymbolic capital\b', 'Symbolic Capital', 'vc_fund'),
  (r'\blongling\b', 'Longling Capital', 'vc_fund'), (r'\babraxas\b', 'Abraxas Capital', 'vc_fund'), (r'\bcrypto\.?com capital\b', 'Crypto.com Capital', 'vc_fund'), (r'\bokx ventures\b', 'OKX Ventures', 'vc_fund'),
  (r'\bkucoin (ventures|labs)\b', 'KuCoin Ventures', 'vc_fund'), (r'\bdigital currency group\b|\bdcg\b', 'Digital Currency Group', 'vc_fund'), (r'\bgrayscale\b', 'Grayscale', 'fund_trading'),
  (r'\bblackrock\b', 'BlackRock', 'fund_trading'), (r'\bfidelity\b', 'Fidelity', 'fund_trading'), (r'\bark invest\b', 'ARK Invest', 'fund_trading'), (r'\bsequoia\b', 'Sequoia', 'vc_fund'),
  (r'\bhashkey capital\b', 'HashKey Capital', 'vc_fund'), (r'\bsnz\b', 'SNZ Holding', 'vc_fund'), (r'\bcobo ventures\b', 'Cobo Ventures', 'vc_fund'), (r'\bderibit\b(?!)', None, None),
]
ENT_RE = [(re.compile(p, re.I), e, t) for p, e, t in ENT if e]
EXCL = re.compile(r'exploit|hack|drainer|phish|scam|validator|\btoken\b|old contract|price feed|oracle|governance voting|voting:|sybil delegate|pool\b|vault\b|staking|registry|deployer|airdrop|merkle|bridge|charity|endaoment|monsters|wbtc merchant|avs operator|node operator|compound:|governance|mev builder|sushiswap|uniswap|unicef|^null$', re.I)

def entity_of(name):
    for rx, e, t in ENT_RE:
        if rx.search(name or ''): return e, t
    return None, None

def add(db, chain, addr, entity, etype, source, conf, label, extra=None):
    if not addr: return
    a = addr.lower() if addr.startswith('0x') else addr
    k = f'{chain}:{a}'
    rec = db.get(k) or {'chain': chain, 'address': a, 'entity': entity, 'entity_type': etype, 'labels': [], 'sources': [], 'confidence': conf}
    if label and label not in rec['labels']: rec['labels'].append(label)
    if source not in rec['sources']: rec['sources'].append(source)
    order = {'low': 0, 'medium': 1, 'high': 2}
    if order[conf] > order[rec['confidence']]: rec['confidence'] = conf; rec['entity'] = entity; rec['entity_type'] = etype
    if extra: rec.update({k2: v for k2, v in extra.items() if v is not None})
    db[k] = rec

def fetch_raw(name, url):
    f = os.path.join(SRC, name)
    if not os.path.exists(f) or time.time() - os.path.getmtime(f) > 7 * 86400:
        import urllib.request
        urllib.request.urlretrieve(url, f)
    return f

def mhttp(u):
    import hashlib
    f = os.path.join(CACHE, 'meta_' + hashlib.md5(u.encode()).hexdigest() + '.json')
    if os.path.exists(f) and time.time() - os.path.getmtime(f) < 7 * 86400: return json.load(open(f))
    try: v = http(u, retries=2, timeout=20)
    except Exception as e: log('meta err', u[-80:], str(e)[:60]); return {}
    json.dump(v, open(f, 'w')); return v

def labels():
    db = {}; stats = {}
    # 1) dawsbot/eth-labels accounts.csv
    f = fetch_raw('eth_labels_accounts.csv', 'https://raw.githubusercontent.com/dawsbot/eth-labels/v1/data/csv/accounts.csv')
    n = 0
    for r in csv.DictReader(open(f)):
        tag, lab = r['nameTag'] or '', r['label'] or ''
        if EXCL.search(tag) or lab in ('validator', 'validator-group', 'exploit', 'heist', 'bybit-exploit', 'radiant-capital-exploit', 'token-contract', 'old-contract', 'endaoment', 'charity', 'nonprofit'): continue
        chain = CHAIN_ID.get(int(r['chainId'])) if r['chainId'].isdigit() else None
        if not chain: continue
        e, t = entity_of(tag)
        if not e and lab.replace('-', ' ') != lab: e, t = entity_of(lab.replace('-', ' '))
        if e: add(db, chain, r['address'], e, t, 'github:dawsbot/eth-labels', 'high', tag or lab); n += 1
        elif lab in ('fund', 'venture-capital') and tag and tag.lower() != 'null':  # generic explorer category, entity = name tag prefix
            ent = (tag.split(':')[0].strip() or 'Unknown fund') if not tag.lower().startswith('fund:') else 'Unnamed fund (Etherscan "Fund" label)'
            add(db, chain, r['address'], ent, 'otc_desk' if lab == 'otc' else 'vc_fund', 'github:dawsbot/eth-labels', 'medium', f'{tag} [{lab}]'); n += 1
    stats['dawsbot/eth-labels'] = n
    # 2) brianleect/etherscan-labels combined accounts (etherscan + bscscan)
    n = 0
    for c, chain in (('etherscan', 'ethereum'), ('bscscan', 'bsc')):
        f = fetch_raw(f'brianleect_{c}_accounts.json', f'https://raw.githubusercontent.com/brianleect/etherscan-labels/main/data/{c}/combined/combinedAccountLabels.json')
        for a, v in json.load(open(f)).items():
            tag = v.get('name') or ''; labs = v.get('labels') or []
            if EXCL.search(tag) or any(l in ('exploit', 'heist', 'validator', 'old-contract', 'token-contract') for l in labs): continue
            e, t = entity_of(tag)
            if e: add(db, chain, a, e, t, 'github:brianleect/etherscan-labels', 'high', tag); n += 1
            elif any(l in ('fund', 'venture-capital', 'otc') for l in labs):
                ent = tag.split(':')[0].strip() if tag and not tag.lower().startswith('fund:') else 'Unnamed fund (Etherscan "Fund" label)'
                add(db, chain, a, ent, 'vc_fund', 'github:brianleect/etherscan-labels', 'medium', f'{tag} {labs}'); n += 1
    stats['brianleect/etherscan-labels'] = n
    # 3) Blockscout metadata service (keyless). Search each entity name, keep 'name'/'generic' tags whose name maps to the same entity.
    n = 0; comp = set()
    names = sorted({e for _, e, _ in ENT_RE})
    for nm in names:
        q = nm.split(' (')[0].split(' / ')[0]
        log('blockscout entity', nm)
        for tt in ('name', 'generic'):
            j = mhttp(f'https://metadata.services.blockscout.com/api/v1/tags:search?name={q.replace(" ", "%20")}&tag_types={tt}') or {}
            for it in j.get('items', []):
                tg = it['tag']; e, t = entity_of(tg['name'])
                if e != nm or EXCL.search(tg['name']): continue
                for cid, chain in ((1, 'ethereum'), (8453, 'base'), (56, 'bsc'), (42161, 'arbitrum'), (10, 'optimism')):
                    r = mhttp(f'https://metadata.services.blockscout.com/api/v1/addresses?slug={tg["slug"]}&tag_type={tg["tagType"]}&chain_id={cid}') or {}
                    for a in r.get('addresses') or r.get('items') or []:
                        if isinstance(a, dict): a = a.get('hash') or a.get('address')
                        add(db, chain, a, e, t, 'blockscout-metadata', 'high' if tt == 'name' else 'medium', f'{tg["name"]} ({tg["slug"]})'); n += 1
    # compromised flag (Blockscout generic tag 'compromised')
    for cid, chain in ((1, 'ethereum'), (8453, 'base'), (56, 'bsc')):
        r = mhttp(f'https://metadata.services.blockscout.com/api/v1/addresses?slug=compromised&tag_type=generic&chain_id={cid}') or {}
        for a in r.get('addresses') or []: comp.add(f'{chain}:{a.lower()}')
    for k in comp:
        if k in db: db[k]['compromised'] = True; db[k]['note'] = 'Blockscout tag "Compromised" (e.g. Profanity weak key): inflows may be spam/attacker activity'
    stats['blockscout-metadata'] = n
    # 4) Nansen labels already paid for (no new calls)
    n = 0
    for fn in ('nansen_crash_raw.json', 'nansen_crash.json', 'nansen_cache.json', 'vcwatch_nansen.json'):
        try: d = json.load(open(os.path.join(DATA_DIR, fn)))
        except Exception: continue
        def walk(x, chain=None):
            nonlocal n
            if isinstance(x, dict):
                chain = x.get('chain', chain)
                for ak, lk in (('address', 'address_label'), ('from_address', 'from_address_label'), ('to_address', 'to_address_label'), ('address', 'label')):
                    a, l = x.get(ak), x.get(lk)
                    if not a or not isinstance(l, str): continue
                    ch = 'solana' if not str(a).startswith('0x') else ({'bnb': 'bsc'}.get(chain, chain) or 'evm')
                    e, t = entity_of(l)
                    if e: add(db, ch, a, e, t, (f'nansen-label ({fn}, already paid)' if fn != 'vcwatch_nansen.json' else 'nansen-label (vcwatch_nansen.js harvest 2026-10-11)'), 'high', l); n += 1
                    elif re.search(r'\bfund\b|ventures|capital\b', l, re.I) and not re.search(r'on FOMO|"|\.eth\b|friendtech', l, re.I):
                        add(db, ch, a, re.sub(r'\s*\[.*$', '', l).strip(' 🤓👤👀🔧🤖🏦'), 'vc_fund', (f'nansen-label ({fn}, already paid)' if fn != 'vcwatch_nansen.json' else 'nansen-label (vcwatch_nansen.js harvest 2026-10-11)'), 'medium', l); n += 1
                    elif re.search(r'Smart Trader|Smart Money|Smart LP|Smart Fund', l):
                        former = 'Former' in l
                        add(db, ch, a, 'Nansen Smart Trader' + (' (former)' if former else ''), 'smart_money', (f'nansen-label ({fn}, already paid)' if fn != 'vcwatch_nansen.json' else 'nansen-label (vcwatch_nansen.js harvest 2026-10-11)'), 'low' if former else 'medium', l); n += 1
                for v in x.values(): walk(v, chain)
            elif isinstance(x, list):
                for v in x: walk(v, chain)
        walk(d)
    stats['nansen (existing files)'] = n
    # Nansen Fund-cohort holders (research/vcwatch_nansen.js, tgm/holders with include_smart_money_labels=['Fund'], 5 cr/call, 2026-10-11).
    # The wallet passed Nansen's Fund filter, but the entity name is a premium label (150 cr/call, not bought) -> entity left unnamed.
    VN = load('vcwatch_nansen.json', {}) or {}; nf = 0
    ROUTERS = {'0x1111110f0f73c0b2ef09ec012eae758b3e03a902', '0x1111111254eeb25477b68fb85ed929f73a960582'}  # 1inch routers show up in the Fund filter (aggregation contracts, not funds)
    for h in (VN.get('fund_holders') or {}).values():
        ch = {'bnb': 'bsc'}.get(h['chain'], h['chain'])
        for r in h.get('rows') or []:
            a = r.get('address') or ''
            if a.lower() in ROUTERS or (r.get('value_usd') or 0) < 1000: continue
            fl = (r.get('address_label') or '').strip()
            add(db, ch, a, 'Nansen Fund-cohort wallet (entity unnamed)', 'vc_fund', 'nansen tgm/holders Fund filter (vcwatch_nansen.js 2026-10-11)', 'medium',
                f"Nansen Fund cohort holder of {h.get('sym')}" + (f' (free label: {fl})' if fl else ''), {'nansen_fund_cohort': True}); nf += 1
    stats['nansen fund-cohort holders (paid run 2026-10-11)'] = nf
    recs = sorted(db.values(), key=lambda r: ({'high': 0, 'medium': 1, 'low': 2}[r['confidence']], r['entity_type'], r['entity'], r['chain']))
    by_type, by_conf, by_chain, by_entity = {}, {}, {}, {}
    for r in recs:
        by_type[r['entity_type']] = by_type.get(r['entity_type'], 0) + 1; by_conf[r['confidence']] = by_conf.get(r['confidence'], 0) + 1
        by_chain[r['chain']] = by_chain.get(r['chain'], 0) + 1; by_entity[r['entity']] = by_entity.get(r['entity'], 0) + 1
    out = {'generatedAt': int(time.time() * 1000), 'count': len(recs), 'by_entity_type': by_type, 'by_confidence': by_conf, 'by_chain': by_chain,
           'top_entities': dict(sorted(by_entity.items(), key=lambda x: -x[1])[:40]), 'source_rows': stats,
           'confidence_rules': {'high': 'explicit entity name tag from a block-explorer label set (Etherscan via GitHub datasets, Blockscout/OLI name tag) or an entity-named Nansen label',
                                'medium': 'generic explorer category ("Fund", "OTC") with the entity only in the name tag, Blockscout generic tag, or Nansen 30D/90D/180D Smart Trader (behavioural, not an entity)',
                                'low': 'Nansen "Former Smart Trader"'},
           'nansen_fund_cohort_note': 'entity "Nansen Fund-cohort wallet (entity unnamed)" = address returned by Nansen tgm/holders with the Fund label filter (medium: Nansen classifies it as a fund wallet; which fund is a premium label we did not buy)',
           'not_used': {'etherscan.io label pages': 'Cloudflare 403 to scripts', 'Arkham': 'API requires key; entity pages require login', 'Dune': 'API key required',
                        'Solscan labels': 'Pro API key required', 'news/disclosures': 'no address list found that could be verified without a key; nothing added by hand (no invented labels)'},
           'caveats': ['Explorer labels can be stale (2023 snapshot in brianleect) and an entity can control many unlabeled wallets.', 'Exchange deposit addresses tagged to a fund (e.g. "Galaxy Digital: HTX Deposit") are swept by the exchange.', 'Addresses tagged Compromised are kept but excluded from flags.'],
           'wallets': recs}
    json.dump(out, open(os.path.join(DATA_DIR, 'vc_wallets.json'), 'w'), indent=0)
    log('vc_wallets', len(recs), by_type, by_conf, by_chain)
    return out

# =====================================================================================================================
# monitor + history
# =====================================================================================================================
TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
BS = {'ethereum': 'https://eth.blockscout.com', 'base': 'https://base.blockscout.com'}
EVM_RPC = {'bsc': 'https://bsc-rpc.publicnode.com', 'robinhood': 'https://rpc.mainnet.chain.robinhood.com', 'base': 'https://base-rpc.publicnode.com', 'ethereum': 'https://ethereum-rpc.publicnode.com'}
GT_NET = {'ethereum': 'eth', 'base': 'base', 'bsc': 'bsc', 'robinhood': 'robinhood', 'solana': 'solana'}
CG_PLATFORM = {'ethereum': 'ethereum', 'base': 'base', 'bsc': 'binance-smart-chain', 'solana': 'solana'}
MAJORS = re.compile(r'^(W?ETH|WBTC|CBBTC|USDC|USDT|DAI|USDE|SUSDE|FDUSD|PYUSD|USDS|TUSD|BUSD|WBNB|BNB|STETH|WSTETH|RETH|CBETH|WEETH|EZETH|LINK|UNI|AAVE|MKR|LDO|ARB|OP|PEPE|SHIB|SOL|WSOL|JUP|BONK|WIF|EURC|GHO|CRV|CVX|FRAX|ENA|ONDO|USD0|USDT0|XAUT|PAXG|SKY)$', re.I)
CRIT = {'max_mcap': 100e6, 'min_liq': 20000, 'max_age_d': 180, 'max_holders': 10000, 'min_usd': 1000}

def load(f, default=None):
    try: return json.load(open(os.path.join(DATA_DIR, f)))
    except Exception: return default

def bs_transfers(chain, addr, pages=1, since=None):
    out, params = [], ''
    for _ in range(pages):
        j = http(f'{BS[chain]}/api/v2/addresses/{addr}/token-transfers?type=ERC-20&filter=to{params}', headers={'User-Agent': 'Mozilla/5.0 (asymmetric-terminal research)'})
        if not j: break
        for x in j.get('items') or []:
            t = calendar.timegm(time.strptime(x['timestamp'][:19], '%Y-%m-%dT%H:%M:%S')) if x.get('timestamp') else None
            tk = x.get('token') or {}
            try: amt = int((x.get('total') or {}).get('value') or 0) / 10 ** int(tk.get('decimals') or (x.get('total') or {}).get('decimals') or 18)
            except Exception: amt = None
            out.append({'chain': chain, 'wallet': addr.lower(), 't': t, 'tx': x.get('transaction_hash'), 'token': (tk.get('address_hash') or tk.get('address') or '').lower(), 'symbol': tk.get('symbol'), 'name': tk.get('name'),
                        'amount': amt, 'from': ((x.get('from') or {}).get('hash') or '').lower(), 'from_name': (x.get('from') or {}).get('name'), 'method': x.get('method'),
                        'holders': int(tk['holders_count']) if tk.get('holders_count') not in (None, '') else None, 'reputation': tk.get('reputation'), 'scam': bool((x.get('from') or {}).get('is_scam')),
                        'total_supply': tk.get('total_supply'), 'decimals': tk.get('decimals'), 'exchange_rate': tk.get('exchange_rate')})
        np_ = j.get('next_page_params')
        if not np_ or (since and out and out[-1]['t'] and out[-1]['t'] < since): break
        params = '&' + '&'.join(f'{k}={v}' for k, v in np_.items() if v is not None)
    return [x for x in out if not since or (x['t'] or 0) >= since]

def ds_tokens(chain, addrs):
    """DexScreener tokens/v1 batch (30) -> {addr: summary of best pair}"""
    out = {}
    for i in range(0, len(addrs), 30):
        j = http(f'https://api.dexscreener.com/tokens/v1/{chain}/' + ','.join(addrs[i:i + 30])) or []
        for p in j if isinstance(j, list) else []:
            a = ((p.get('baseToken') or {}).get('address') or '')
            k = a.lower() if a.startswith('0x') else a
            if k not in [x.lower() if x.startswith('0x') else x for x in addrs[i:i + 30]]: continue
            cur = out.get(k) or {'pairs': [], 'liq': 0, 'mcap': None, 'created': None, 'symbol': p['baseToken'].get('symbol'), 'price': None, 'vol24': 0, 'cex_hint': None}
            cur['pairs'].append((p.get('pairAddress') or '').lower()); liq = (p.get('liquidity') or {}).get('usd') or 0
            if liq >= cur['liq']: cur['liq'] = liq; cur['price'] = float(p['priceUsd']) if p.get('priceUsd') else None; cur['mcap'] = p.get('marketCap') or p.get('fdv'); cur['url'] = p.get('url')
            cur['vol24'] += (p.get('volume') or {}).get('h24') or 0
            if p.get('pairCreatedAt'): cur['created'] = min(cur['created'] or 1e18, p['pairCreatedAt'] / 1000)
            out[k] = cur
    return out

def cg_listed(chain, addr):
    f = os.path.join(CACHE, f'cg_{chain}_{addr}.json')
    if os.path.exists(f) and time.time() - os.path.getmtime(f) < 3 * 86400: return json.load(open(f))
    try: j = http(f'https://api.coingecko.com/api/v3/coins/{CG_PLATFORM[chain]}/contract/{addr}')
    except Exception: return None
    v = {'listed': bool(j and j.get('id')), 'id': (j or {}).get('id'), 'cex': sorted({t['market']['name'] for t in (j or {}).get('tickers', []) if (t.get('market') or {}).get('identifier') and t.get('trust_score') and 'swap' not in t['market']['name'].lower() and 'dex' not in t['market']['name'].lower()})[:8]}
    json.dump(v, open(f, 'w')); return v

def desk_refs():
    """symbol/address index of other desks: airdrops, narratives, unlocks, desks, launchpad catalog."""
    idx = {}
    def put(key, src, txt):
        if key and len(str(key)) >= 3 and len(str(txt).strip()) >= 3: idx.setdefault(str(key).lower(), []).append({'desk': src, 'text': str(txt)[:160]})
    for f, src in (('airdrops.json', 'airdrops'), ('airdrop_desk.json', 'airdrop desk'), ('narratives.json', 'narratives'), ('unlocks_calendar.json', 'unlocks'), ('desks.json', 'desks'), ('launchpad_cg.json', 'launchpads')):
        d = load(f)
        def walk(x, depth=0):
            if depth > 5: return
            if isinstance(x, dict):
                lab = x.get('name') or x.get('title') or x.get('project') or x.get('narrative') or ''
                for k in ('symbol', 'ticker', 'address', 'mint', 'contract', 'token'):
                    v = x.get(k)
                    if isinstance(v, str) and 1 < len(v) < 60: put(v, src, lab or v)
                for v in x.values(): walk(v, depth + 1)
            elif isinstance(x, list):
                for v in x: walk(v, depth + 1)
        if d: walk(d)
    return idx

def wallets_for(chains, types=('market_maker', 'vc_fund', 'fund_trading', 'otc_desk'), conf=('high', 'medium')):
    W = load('vc_wallets.json', {}).get('wallets', [])
    out = {}
    for w in W:
        if w.get('compromised') or w['entity_type'] not in types or w['confidence'] not in conf: continue
        if w['chain'] in chains: out[(w['chain'], w['address'])] = w
        # EOAs reuse the same address on every EVM chain: also watch ETH-labelled MM/VC addresses on Base/BSC/Robinhood (marked label_chain)
        if w['chain'] == 'ethereum' and w['confidence'] == 'high':
            for c in chains:
                if c in ('base', 'bsc', 'robinhood') and (c, w['address']) not in out: out[(c, w['address'])] = {**w, 'chain': c, 'label_chain': 'ethereum', 'confidence': 'medium'}
    return out

def qualify(chain, inflows, ds, now_t):
    """apply 'not yet widely known' + real-market filters; returns (flags, rejected_counts)"""
    rej = {}; flags = []
    by_tok = {}
    for x in inflows: by_tok.setdefault(x['token'], []).append(x)
    for tok, xs in by_tok.items():
        sym = xs[0].get('symbol') or (ds.get(tok) or {}).get('symbol') or '?'
        def no(r): rej[r] = rej.get(r, 0) + 1
        if MAJORS.match(sym or ''): no('major/stable'); continue
        if any(x.get('reputation') not in (None, 'ok') or x.get('scam') for x in xs): no('explorer reputation not ok'); continue
        d = ds.get(tok)
        if not d or d['liq'] < CRIT['min_liq']: no(f"no DEX market >= ${CRIT['min_liq']:,} liquidity (spam/airdrop filter)"); continue
        if d['mcap'] and d['mcap'] > CRIT['max_mcap']: no('mcap > $100M (already known)'); continue
        age = (now_t - d['created']) / 86400 if d.get('created') else None
        if age is not None and age > CRIT['max_age_d']: no('older than 180d'); continue
        holders = max([x['holders'] for x in xs if x.get('holders') is not None] or [None]) if any(x.get('holders') for x in xs) else None
        if holders and holders > CRIT['max_holders']: no('> 10k holders'); continue
        amt = sum(x['amount'] or 0 for x in xs); usd = amt * d['price'] if d.get('price') else None
        if usd is not None and usd < CRIT['min_usd']: no('inflow < $1k at current price'); continue
        src = 'bought on DEX' if any(x['from'] in d['pairs'] for x in xs) else 'direct transfer (allocation / OTC / CEX withdrawal)'
        ents = sorted({x['entity'] for x in xs})
        nw = len({x['wallet'] for x in xs})
        if nw >= 5 and len(ents) >= 3 and (usd or 0) < 50000:  # spam pattern: dust of a fresh token pushed to many famous wallets (often with a spoofed Transfer from the pair)
            no('likely spam airdrop (>=5 labelled wallets of >=3 entities, < $50k total)'); continue
        flags.append({'chain': chain, 'token': tok, 'symbol': sym, 'entities': ents, 'entity_types': sorted({x['entity_type'] for x in xs}), 'confidence': max((x['confidence'] for x in xs), key=lambda c: {'low': 0, 'medium': 1, 'high': 2}[c]),
                      'wallets': sorted({x['wallet'] for x in xs}), 'n_transfers': len(xs), 'first_t': min(x['t'] for x in xs), 'last_t': max(x['t'] for x in xs), 'amount': amt, 'usd_now': round(usd) if usd else None,
                      'source': src, 'txs': [x['tx'] for x in sorted(xs, key=lambda x: x['t'])][:6], 'liq': round(d['liq']), 'mcap': d['mcap'], 'pool_age_d': round(age, 1) if age is not None else None, 'holders': holders, 'dex_url': d.get('url')})
    return flags, rej

def evm_logs_token_centric(chain, tokens, wallets, blocks=4000):
    """public RPC eth_getLogs with address filter (token list) and topic2 = labelled wallets (recent blocks only; non-archive)."""
    rpc = EVM_RPC[chain]; out = []
    bn = int(http(rpc, {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_blockNumber'})['result'], 16)
    topics2 = ['0x' + '0' * 24 + w[2:] for w in wallets]
    for i in range(0, len(tokens), 20):
        for j in range(0, len(topics2), 200):
            r = http(rpc, {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getLogs', 'params': [{'address': tokens[i:i + 20], 'fromBlock': hex(bn - blocks), 'toBlock': hex(bn), 'topics': [TRANSFER, None, topics2[j:j + 200]]}]}) or {}
            for lg in r.get('result') or []:
                out.append({'chain': chain, 'token': lg['address'].lower(), 'wallet': '0x' + lg['topics'][2][-40:], 'from': '0x' + lg['topics'][1][-40:], 'tx': lg['transactionHash'], 'block': int(lg['blockNumber'], 16), 'raw': int(lg['data'], 16) if lg.get('data') not in (None, '0x') else 0})
            if r.get('error'): log('getLogs', chain, str(r['error'])[:100])
    return out, bn

def monitor(lookback_d=7):
    now_t = now(); since = now_t - lookback_d * 86400
    report = {'generatedAt': int(time.time() * 1000), 'lookback_days': lookback_d, 'criteria': CRIT, 'chains': {}, 'flags': [], 'rejected': {}}
    refs = desk_refs()
    # A) wallet-centric: Ethereum + Base (Blockscout)
    for chain in ('ethereum', 'base'):
        W = wallets_for((chain,)); inflows = []
        for (c, a), w in W.items():
            try: xs = bs_transfers(chain, a, pages=1, since=since)
            except Exception as e: log('bs err', chain, a, str(e)[:80]); continue
            for x in xs: x.update({'entity': w['entity'], 'entity_type': w['entity_type'], 'confidence': w['confidence']})
            inflows += xs
        toks = sorted({x['token'] for x in inflows if x['token'] and not MAJORS.match(x.get('symbol') or '')})
        ds = ds_tokens(chain, toks)
        fl, rej = qualify(chain, inflows, ds, now_t)
        report['chains'][chain] = {'mode': 'wallet-centric (Blockscout token-transfers, last page per wallet)', 'wallets_watched': len(W), 'inflow_transfers': len(inflows), 'tokens_seen': len(toks), 'flags': len(fl)}
        report['rejected'][chain] = rej; report['flags'] += fl
    # B) token-centric: BSC + Robinhood (+ young Base/ETH tokens from the live feed) via public RPC getLogs (recent blocks)
    feed = load('live_feed.json', {}) or {}
    for chain, blocks in (('bsc', 4000), ('robinhood', 28000), ('base', 4000)):
        toks = sorted({x['address'].lower() for x in feed.get('items', []) if x.get('chain') == chain and x.get('address', '').startswith('0x')})
        W = wallets_for((chain,))
        if not toks or not W: report['chains'].setdefault(chain, {})['token_centric'] = {'tokens': len(toks), 'wallets': len(W)}; continue
        try: logs, bn = evm_logs_token_centric(chain, toks, sorted({a for (_, a) in W}), blocks)
        except Exception as e: log('logs err', chain, str(e)[:100]); logs, bn = [], None
        ds = ds_tokens(chain, sorted({l['token'] for l in logs})) if logs else {}
        inflows = []
        for l in logs:
            w = W.get((chain, l['wallet'])); d = ds.get(l['token']) or {}
            inflows.append({**l, 't': now_t, 'symbol': d.get('symbol'), 'amount': None, 'holders': None, 'reputation': 'ok', 'scam': False, 'entity': w['entity'] if w else '?', 'entity_type': w['entity_type'] if w else '?', 'confidence': w['confidence'] if w else 'low'})
        fl, rej = qualify(chain, inflows, ds, now_t)
        report['chains'].setdefault(chain, {})['token_centric'] = {'mode': f'token-centric getLogs over the last {blocks} blocks (public RPC, non-archive) for {len(toks)} live-feed tokens', 'wallets': len(W), 'logs': len(logs), 'flags': len(fl), 'block': bn}
        report['flags'] += fl
    # C) Solana: Nansen-labelled smart-money / fund wallets, holdings snapshot diff (getTokenAccountsByOwner)
    sol = [w for w in load('vc_wallets.json', {}).get('wallets', []) if w['chain'] == 'solana' and w['confidence'] in ('high', 'medium')]
    snap_f = os.path.join(DATA_DIR, 'vcwatch_sol_snap.json'); prev = load('vcwatch_sol_snap.json', {}) or {}
    snap = {}; new_pos = []
    for w in sol:
        try:
            r = http('https://api.mainnet-beta.solana.com', {'jsonrpc': '2.0', 'id': 1, 'method': 'getTokenAccountsByOwner', 'params': [w['address'], {'programId': 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'}, {'encoding': 'jsonParsed'}]}) or {}
        except Exception as e: log('sol err', str(e)[:80]); continue
        bal = {}
        for a in (r.get('result') or {}).get('value', []):
            inf = a['account']['data']['parsed']['info']; amt = float(inf['tokenAmount'].get('uiAmount') or 0)
            if amt > 0: bal[inf['mint']] = bal.get(inf['mint'], 0) + amt
        snap[w['address']] = bal
        old = prev.get('wallets', {}).get(w['address'])
        for m, amt in bal.items():
            if old is None: continue  # first snapshot = baseline
            if amt > (old.get(m) or 0) * 1.5: new_pos.append({'wallet': w['address'], 'entity': w['entity'], 'entity_type': w['entity_type'], 'confidence': w['confidence'], 'token': m, 'amount': amt, 'prev': old.get(m) or 0})
        time.sleep(0.3)
    json.dump({'t': now_t, 'wallets': snap}, open(snap_f, 'w'))
    sol_flags = []
    if new_pos:
        ds = ds_tokens('solana', sorted({x['token'] for x in new_pos}))
        for x in new_pos:
            d = ds.get(x['token'])
            if not d or d['liq'] < CRIT['min_liq'] or (d['mcap'] or 0) > CRIT['max_mcap']: continue
            age = (now_t - d['created']) / 86400 if d.get('created') else None
            if age is not None and age > CRIT['max_age_d']: continue
            sol_flags.append({'chain': 'solana', 'token': x['token'], 'symbol': d['symbol'], 'entities': [x['entity']], 'entity_types': [x['entity_type']], 'confidence': x['confidence'], 'wallets': [x['wallet']],
                              'first_t': prev.get('t'), 'last_t': now_t, 'amount': x['amount'] - x['prev'], 'usd_now': round((x['amount'] - x['prev']) * d['price']) if d.get('price') else None, 'source': 'balance increase between snapshots',
                              'liq': round(d['liq']), 'mcap': d['mcap'], 'pool_age_d': round(age, 1) if age is not None else None, 'dex_url': d.get('url'), 'txs': []})
    report['chains']['solana'] = {'mode': 'holdings snapshot diff (getTokenAccountsByOwner), Nansen-labelled wallets', 'wallets': len(sol), 'baseline_run': not prev, 'new_or_increased_positions': len(new_pos), 'flags': len(sol_flags)}
    report['flags'] += sol_flags
    # D) Nansen: Fund-cohort accumulation in small/young tokens (funds/holdings filtered mcap<=$100M, age<=365d, >=$10k held; then
    #    tgm/holders Fund filter -> per-wallet 7d/30d balance change). Data from research/vcwatch_nansen.js (cached run).
    VN = load('vcwatch_nansen.json', {}) or {}; nflags = 0
    fh_meta = {x['chain'] + ':' + x['token_address']: x for x in VN.get('funds_holdings') or []}
    for k, h in (VN.get('fund_holders') or {}).items():
        m = fh_meta.get(k) or {}; ch = {'bnb': 'bsc'}.get(h['chain'], h['chain'])
        acc = [r for r in h.get('rows') or [] if (r.get('balance_change_30d') or 0) > 0 and (r.get('value_usd') or 0) >= 1000 and r['address'].lower() not in ('0x1111110f0f73c0b2ef09ec012eae758b3e03a902',)]
        if not acc: continue
        px = lambda r: (r['value_usd'] / r['token_amount']) if r.get('token_amount') else 0
        usd30 = sum(r['balance_change_30d'] * px(r) for r in acc); usd7 = sum(max(0, r.get('balance_change_7d') or 0) * px(r) for r in acc)
        if usd30 < CRIT['min_usd']: continue
        tok = h['token'].lower() if h['token'].startswith('0x') else h['token']
        report['flags'].append({'chain': ch, 'token': tok, 'symbol': h.get('sym'), 'entities': ['Nansen Fund-cohort wallet (entity unnamed)'], 'entity_types': ['vc_fund'], 'confidence': 'medium',
                                'wallets': [r['address'] for r in acc], 'n_wallets_accumulating': len(acc), 'fund_wallets_holding': len(h.get('rows') or []),
                                'first_t': None, 'last_t': VN.get('generatedAt', 0) // 1000, 'amount': sum(r['balance_change_30d'] for r in acc), 'usd_now': round(usd30), 'usd_7d': round(usd7),
                                'source': 'Nansen Fund-cohort balance increase (30d), tgm/holders', 'mcap': m.get('market_cap_usd'), 'token_age_d': m.get('token_age_days'), 'fund_value_usd': round(m.get('value_usd') or 0),
                                'liq': None, 'pool_age_d': None, 'txs': [], 'nansen': True})
        nflags += 1
    report['chains']['nansen'] = {'mode': 'Nansen funds/holdings + tgm/holders (Fund filter) snapshot', 'snapshot_at': VN.get('generatedAt'), 'fund_held_small_caps': len(fh_meta), 'flags': nflags}
    # merge flags for the same token from different paths (Blockscout inflows + Nansen fund cohort)
    mg = {}
    for f in report['flags']:
        k = (f['chain'], f['token'])
        if k not in mg: mg[k] = f; continue
        g = mg[k]; order = {'low': 0, 'medium': 1, 'high': 2}
        g['entities'] = sorted(set(g['entities']) | set(f['entities'])); g['entity_types'] = sorted(set(g['entity_types']) | set(f['entity_types']))
        g['wallets'] = sorted(set(g['wallets']) | set(f['wallets'])); g['txs'] = (g.get('txs') or []) + [t for t in f.get('txs') or [] if t not in (g.get('txs') or [])]
        g['source'] = g['source'] + ' + ' + f['source']; g['usd_now'] = max(g.get('usd_now') or 0, f.get('usd_now') or 0) or None
        if order[f['confidence']] > order[g['confidence']]: g['confidence'] = f['confidence']
        for kk in ('n_wallets_accumulating', 'fund_wallets_holding', 'usd_7d', 'token_age_d', 'nansen', 'liq', 'pool_age_d', 'holders', 'dex_url', 'mcap'):
            if g.get(kk) is None and f.get(kk) is not None: g[kk] = f[kk]
    report['flags'] = list(mg.values())
    # enrich: CoinGecko listing (no-CEX proxy), desk cross-refs, plain-English why, merge multi-entity
    for f in report['flags']:
        cg = cg_listed(f['chain'], f['token']) if f['chain'] in CG_PLATFORM else None
        f['coingecko'] = cg
        f['cross_refs'] = (refs.get(f['token'].lower()) or []) + (refs.get(str(f.get('symbol') or '').lower()) or [])
        f['cross_refs'] = [dict(t) for t in dict.fromkeys(tuple(sorted(x.items())) for x in f['cross_refs'])][:5]
        unknown = [] if (cg and cg.get('listed')) else ['not on CoinGecko']
        if f.get('mcap') and f['mcap'] < 20e6: unknown.append(f"mcap ${f['mcap'] / 1e6:.1f}M")
        if f.get('pool_age_d') is not None: unknown.append(f"pool {f['pool_age_d']:.0f}d old")
        if f.get('token_age_d') is not None: unknown.append(f"token {f['token_age_d']}d old")
        if f.get('nansen'): unknown.append(f"{f['n_wallets_accumulating']} of {f['fund_wallets_holding']} Nansen fund wallets added in 30d (~${f['usd_7d']:,} in the last 7d)")
        if f.get('holders'): unknown.append(f"{f['holders']:,} holders")
        f['why'] = (f"{' + '.join(f['entities'])} ({'/'.join(f['entity_types'])}, {f['confidence']} label confidence) received {f['symbol']} on {f['chain']}"
                    f"{' worth ~$' + format(f['usd_now'], ',') + ' at current price' if f.get('usd_now') else ''} via {f['source']}. Little-known token: {', '.join(unknown) or 'n/a'}."
                    f"{' Desk cross-ref: ' + '; '.join(x['desk'] + ': ' + x['text'] for x in f['cross_refs'][:2]) if f['cross_refs'] else ''}")
        f['strength'] = (2 if len(f['entities']) > 1 else 1) + (1 if f['confidence'] == 'high' else 0) + (1 if f['source'].startswith('bought') else 0) + (1 if not (cg and cg.get('listed')) else 0)
    report['flags'].sort(key=lambda f: (-f['strength'], -(f.get('usd_now') or 0)))
    report['billing'] = {'hosts': dict(COUNTS), 'nansen': (VN.get('credits') or {}), 'nansen_note': 'Nansen credits are spent only by research/vcwatch_nansen.js (cached); this monitor reads its output', 'x_calls': 0}
    json.dump(report, open(os.path.join(DATA_DIR, 'vcwatch_live.json'), 'w'), default=str)
    log('vcwatch_live flags', len(report['flags']))
    return report

# ---------------- historical scan ----------------
def gt(u):
    f = os.path.join(CACHE, 'gt_' + re.sub(r'[^A-Za-z0-9]', '_', u)[-150:] + '.json')
    if os.path.exists(f): return json.load(open(f))
    j = http('https://api.geckoterminal.com/api/v2' + u)
    json.dump(j, open(f, 'w')); return j

def token_history(chain, tok):
    pj = gt(f'/networks/{GT_NET[chain]}/tokens/{tok}/pools?page=1') or {}
    pools = [(p['attributes'].get('pool_created_at'), p['attributes'].get('address'), float(p['attributes'].get('reserve_in_usd') or 0)) for p in pj.get('data') or []]
    pools = [p for p in pools if p[0]]
    if not pools: return None
    first = min(calendar.timegm(time.strptime(p[0][:19], '%Y-%m-%dT%H:%M:%S')) for p in pools)
    top = max(pools, key=lambda p: p[2])[1]
    oj = gt(f'/networks/{GT_NET[chain]}/pools/{top}/ohlcv/day?aggregate=1&limit=400&currency=usd&token=base') or {}
    rows = sorted(((oj.get('data') or {}).get('attributes') or {}).get('ohlcv_list') or [])
    return {'first_pool_t': first, 'top_pool': top, 'daily': rows}

def history(pages=4, days=365):
    now_t = now(); since = now_t - days * 86400
    W = wallets_for(('ethereum', 'base'), conf=('high',))
    for w in load('vc_wallets.json', {}).get('wallets', []):  # + Nansen Fund-cohort wallets (medium; the small-cap fund wallets Nansen knows)
        if w.get('nansen_fund_cohort') and w['chain'] in ('ethereum', 'base'): W[(w['chain'], w['address'])] = w
    inflows = []
    for (chain, a), w in W.items():
        cf = os.path.join(CACHE, f'hist_{chain}_{a}_{pages}.json')
        if os.path.exists(cf) and time.time() - os.path.getmtime(cf) < 24 * 3600: xs = json.load(open(cf))
        else:
            try: xs = bs_transfers(chain, a, pages=pages, since=since)
            except Exception as e: log('bs err', a, str(e)[:80]); continue
            json.dump(xs, open(cf, 'w'))
        for x in xs: x.update({'entity': w['entity'], 'entity_type': w['entity_type'], 'confidence': w['confidence'], 'label_chain': w.get('label_chain')})
        inflows += xs
        log('hist wallet', chain, w['entity'], a[:10], len(xs))
    first = {}
    for x in sorted(inflows, key=lambda x: x['t'] or 0):
        if not x['token'] or MAJORS.match(x.get('symbol') or '') or x.get('reputation') not in (None, 'ok') or x.get('scam'): continue
        k = (x['chain'], x['token'], x['entity'])
        if k not in first: first[k] = {**x, 'n': 0, 'amount_total': 0}
        first[k]['n'] += 1; first[k]['amount_total'] += x['amount'] or 0
    cases, skipped = [], {}
    def sk(r): skipped[r] = skipped.get(r, 0) + 1
    known = {}
    for chain in ('ethereum', 'base'):  # cheap prefilter: token must have at least one DEX pair on DexScreener (dead pairs included)
        known[chain] = ds_tokens(chain, sorted({t for (c, t, _) in first if c == chain}))
    for (chain, tok, ent), x in first.items():
        if tok not in known.get(chain, {}): sk('no DEX pair on DexScreener (spam / CEX-only)'); continue
        kd = known[chain][tok]; created = kd.get('created')
        pre_c = created is not None and x['t'] and x['t'] < created - 86400  # inflow >1 day before the first DEX pair = pre-listing candidate
        if not pre_c and created is not None and created < x['t'] - 180 * 86400: sk('DEX pair older than 180d at inflow (already known token)'); continue
        if not pre_c and (kd.get('liq') or 0) < 5000 and (kd.get('vol24') or 0) < 5000: sk('dead DEX market now and not pre-listing (skip OHLCV)'); continue
        try: h = token_history(chain, tok)
        except Exception as e: sk('gt error'); continue
        if not h or not h['daily']: sk('no DEX pool / price history (spam or CEX-only)'); continue
        vol = sum(r[5] for r in h['daily'])
        if vol < 250000: sk('lifetime DEX volume < $250k (spam/dust filter)'); continue
        d0 = max(x['t'], h['first_pool_t'])
        after = [r for r in h['daily'] if r[0] >= d0 - 86400]
        if len(after) < 3: sk('too little price history after inflow'); continue
        p0 = after[0][4]
        w30 = [r for r in after if r[0] <= d0 + 30 * 86400]; w90 = [r for r in after if r[0] <= d0 + 90 * 86400]
        if not w30: sk('price history gap after inflow'); continue
        mx30 = max(w30, key=lambda r: r[4]); mx90 = max(w90, key=lambda r: r[4])
        lead_pool = (h['first_pool_t'] - x['t']) / 86400
        usd_at = x['amount_total'] * p0 if p0 else None
        c = {'chain': chain, 'token': tok, 'symbol': x['symbol'], 'entity': ent, 'entity_type': x['entity_type'], 'wallet': x['wallet'], 'label_chain': x.get('label_chain'),
             'first_inflow_t': x['t'], 'first_inflow_date': time.strftime('%Y-%m-%d', time.gmtime(x['t'])), 'first_tx': x['tx'], 'from': x['from'], 'n_transfers': x['n'],
             'first_dex_pool_date': time.strftime('%Y-%m-%d', time.gmtime(h['first_pool_t'])), 'lead_days_before_first_pool': round(lead_pool, 1),
             'pre_listing': lead_pool >= 1, 'usd_at_first_price': round(usd_at) if usd_at else None,
             'max_ret_30d': round(mx30[4] / p0 - 1, 3) if p0 else None, 'days_to_30d_max': round((mx30[0] - d0) / 86400, 1), 'max_ret_90d': round(mx90[4] / p0 - 1, 3) if p0 else None,
             'ret_30d_close': round(w30[-1][4] / p0 - 1, 3) if p0 else None, 'lifetime_dex_volume_usd': round(vol)}
        c['pre_run_2x_30d'] = (c['max_ret_30d'] or 0) >= 1.0
        cases.append(c)
    q = [c for c in cases if (c['usd_at_first_price'] or 0) >= 5000]
    post = [c for c in q if not c['pre_listing']]
    pre = [c for c in q if c['pre_listing']]
    med = lambda v: sorted(v)[len(v) // 2] if v else None
    summ = {'wallets_scanned': len(W), 'inflow_transfers': len(inflows), 'distinct_entity_token_pairs': len(first), 'with_dex_history': len(cases), 'qualified_ge_5k': len(q), 'skipped': skipped,
            'pre_listing_cases': len(pre), 'pre_listing_median_lead_days': med([c['lead_days_before_first_pool'] for c in pre]),
            'post_listing_inflows': len(post), 'post_listing_hit_rate_2x_30d': round(sum(c['pre_run_2x_30d'] for c in post) / len(post), 3) if post else None,
            'post_listing_median_ret_30d_close': med([c['ret_30d_close'] for c in post if c['ret_30d_close'] is not None]),
            'pre_listing_hit_rate_2x_30d_after_listing': round(sum(c['pre_run_2x_30d'] for c in pre) / len(pre), 3) if pre else None,
            'coverage_note': f'Blockscout last {pages} pages (<= {pages * 50} ERC-20 inbound transfers) per high-confidence wallet, last {days} days; Ethereum + Base only (BSC has no keyless history API; publicnode is non-archive). Busy MM wallets are covered for weeks, quiet fund wallets for the full year.',
            'bias_note': 'No control group: the hit rate is descriptive. To bound runtime, post-listing inflows into tokens whose DEX market is now dead (<$5k liquidity and <$5k 24h volume) or whose pair was >180d old at inflow are skipped, which biases the post-listing hit rate UPWARD (survivorship); pre-listing candidates are always kept. Tokens without any DEX pool or < $250k lifetime DEX volume are dropped (spam filter), which also drops CEX-only listings. Price at first inflow uses the daily close of the top pool on that day (or listing day for pre-listing cases).'}
    out = {'generatedAt': int(time.time() * 1000), 'summary': summ,
           'pre_listing': sorted(pre, key=lambda c: -(c['usd_at_first_price'] or 0))[:60],
           'pre_run': sorted([c for c in post if c['pre_run_2x_30d']], key=lambda c: -(c['max_ret_30d'] or 0))[:60],
           'all_cases': sorted(q, key=lambda c: -c['first_inflow_t']), 'billing': {'hosts': dict(COUNTS), 'nansen_calls': 0, 'x_calls': 0}}
    json.dump(out, open(os.path.join(DATA_DIR, 'vcwatch_history.json'), 'w'), default=str)
    log('history', summ)
    return out

def nansen_plan():
    """Proposal only (NO calls): how paid Nansen credits could upgrade the label DB, with credit estimates from data/nansen_crash_raw.json."""
    raw = load('nansen_crash_raw.json', {}) or {}
    calls = raw.get('calls') or []
    per = {}
    for c in calls:
        if c.get('used') is not None: per.setdefault(c.get('ep'), []).append(c['used'])
    obs = {k: round(sum(v) / len(v), 2) for k, v in per.items() if v}
    return {'observed_credits_per_call': obs, 'account_after_last_run': raw.get('accountAfter'), 'note': 'observed in data/nansen_crash_raw.json (tgm endpoints ~1 credit/call on the pro plan)'}

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if cmd in ('labels', 'all'): labels()
    if cmd in ('monitor', 'all'): monitor()
    if cmd in ('history', 'all'): history(int(sys.argv[2]) if len(sys.argv) > 2 else 4)
    if cmd == 'plan': print(json.dumps(nansen_plan(), indent=1))
