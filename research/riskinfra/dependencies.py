"""(6) Cross-protocol dependency risk -> data/riskinfra_dependencies.json (+ _history).
Builds a dependency graph for watchlist tokens and common DeFi positions (lending: Aave v3, Kamino, Morpho, Venus, MarginFi;
LSTs/LRTs; bridged assets; stablecoins) -> their oracle provider, bridge, collateral and issuer. Measures stress on each
dependency node from free public data, then flags every dependent whose (transitive) dependency is stressed.
Stress signals:
  stablecoin depeg      DefiLlama stablecoins prices (|p-1| >=0.5% yellow, >=2% red) + issuance spikes from data/stables.json
  LST/LRT vs NAV        on-chain exchange rate (wstETH/rETH/cbETH/weETH via eth_call, Jito/bSOL/JupSOL SPL stake-pool accounts,
                        Marinade API) vs market price (DexScreener WETH-quoted pool / Jupiter vs SOL): discount >=1% yellow, >=3% red
  lending liquidity     utilization >=95% yellow / >=99% red (Morpho: >=98% / >=99.5%, its IRM targets 90%), paused/frozen reserves
  bridges               DefiLlama Bridge/Canonical Bridge TVL change: 1d <=-10% yellow, <=-25% red; 7d <=-30% yellow
  hacks                 DefiLlama hacks feed (api.llama.fi/hacks) last 30 days matched to graph nodes -> red (<=7d) / yellow
  oracles               data/riskinfra_oracles.json deviations / stale feeds -> provider + asset nodes
Mint authority of Solana watchlist tokens (Jupiter tokens v2) decides whether a token is bridged (Wormhole authority) or native."""
import time, json, re, base64, struct
from common import fetch, eth_batch, sol_rpc, readj, writej, Ctx, median, pmap
from lending import get_lending

ctx = Ctx('dependencies'); T0 = time.time(); NOWMS = int(T0 * 1000)
U = lambda s: (s or '').upper()
WORMHOLE_MINT_AUTH = 'BCD75RNBHrJJpW4dXVagL5mPjzRLnVZq4YirJdjEYMV7'
SEVR = {'green': 0, 'yellow': 1, 'red': 2}

# ---------------- graph definition ----------------
NODES = {}   # id -> {id, type, name, signals:[], status}
EDGES = []   # (from, to, relation)
def node(i, typ, name=None, **kw):
    if i not in NODES: NODES[i] = dict({'id': i, 'type': typ, 'name': name or i.split(':', 1)[-1], 'signals': [], 'status': 'green'}, **kw)
    return NODES[i]
def dep(a, b, rel):
    if (a, b, rel) not in EDGES: EDGES.append((a, b, rel))
def sig(i, level, text, **kw):
    n = NODES.get(i)
    if not n: return
    n['signals'].append(dict({'level': level, 'text': text}, **kw))
    if SEVR[level] > SEVR[n['status']]: n['status'] = level

# oracle providers
for o, nm in [('chainlink', 'Chainlink'), ('pyth', 'Pyth'), ('redstone', 'RedStone'), ('switchboard', 'Switchboard'), ('scope', 'Kamino Scope'),
              ('binance-oracle', 'Binance Oracle'), ('resilient-oracle', 'Venus ResilientOracle'), ('chronicle', 'Chronicle'), ('pendle-oracle', 'Pendle PT oracle')]:
    node('oracle:' + o, 'oracle', nm)
dep('oracle:scope', 'oracle:pyth', 'aggregates'); dep('oracle:scope', 'oracle:switchboard', 'aggregates'); dep('oracle:scope', 'oracle:chainlink', 'aggregates')
dep('oracle:resilient-oracle', 'oracle:chainlink', 'main/pivot'); dep('oracle:resilient-oracle', 'oracle:redstone', 'pivot/fallback'); dep('oracle:resilient-oracle', 'oracle:binance-oracle', 'fallback')
# issuers / custodians
ISS = {'circle': 'Circle', 'tether': 'Tether', 'ethena': 'Ethena', 'sky': 'Sky (Maker)', 'paxos': 'Paxos', 'firstdigital': 'First Digital', 'ripple': 'Ripple', 'wlfi': 'World Liberty Financial',
       'bitgo': 'BitGo (WBTC custody)', 'coinbase': 'Coinbase', 'binance': 'Binance', 'threshold': 'Threshold (tBTC)', 'lombard': 'Lombard', 'lido': 'Lido', 'etherfi': 'ether.fi', 'rocketpool': 'Rocket Pool',
       'eigenlayer': 'EigenLayer', 'jito': 'Jito', 'marinade': 'Marinade', 'jupiter': 'Jupiter', 'blaze': 'BlazeStake', 'sanctum': 'Sanctum', 'aave': 'Aave', 'okx': 'OKX', 'bybit': 'Bybit',
       'stonkfun': 'StonkFun (token deployer)'}
for k, v in ISS.items(): node('issuer:' + k, 'issuer', v)
# bridges
BR = {'wormhole': 'Wormhole', 'layerzero': 'LayerZero/Stargate', 'starkgate': 'StarkGate', 'arbitrum-bridge': 'Arbitrum Bridge', 'base-bridge': 'Base Bridge', 'debridge': 'deBridge', 'allbridge': 'Allbridge', 'across': 'Across'}
for k, v in BR.items(): node('bridge:' + k, 'bridge', v)

# assets -> deps (curated, documented)
ASSET_DEPS = {
    'USDC': [('issuer:circle', 'issuer')], 'USDT': [('issuer:tether', 'issuer')], 'PYUSD': [('issuer:paxos', 'issuer')], 'USDG': [('issuer:paxos', 'issuer')],
    'FDUSD': [('issuer:firstdigital', 'issuer')], 'RLUSD': [('issuer:ripple', 'issuer')], 'USD1': [('issuer:wlfi', 'issuer'), ('issuer:bitgo', 'custodian')],
    'USDE': [('issuer:ethena', 'issuer'), ('asset:ETH', 'collateral'), ('asset:BTC', 'collateral'), ('asset:USDT', 'collateral'), ('issuer:binance', 'hedge venue'), ('issuer:okx', 'hedge venue'), ('issuer:bybit', 'hedge venue')],
    'SUSDE': [('asset:USDE', 'wraps')], 'DAI': [('issuer:sky', 'issuer'), ('asset:USDC', 'collateral (PSM)')], 'USDS': [('issuer:sky', 'issuer'), ('asset:USDC', 'collateral (PSM)')], 'SUSDS': [('asset:USDS', 'wraps')],
    'GHO': [('issuer:aave', 'issuer')],
    'WBTC': [('issuer:bitgo', 'custodian'), ('asset:BTC', 'underlying'), ('oracle:chainlink', 'WBTC/BTC feed')], 'CBBTC': [('issuer:coinbase', 'custodian'), ('asset:BTC', 'underlying')],
    'TBTC': [('issuer:threshold', 'issuer'), ('asset:BTC', 'underlying')], 'LBTC': [('issuer:lombard', 'issuer'), ('asset:BTC', 'underlying')], 'BTCB': [('issuer:binance', 'custodian'), ('asset:BTC', 'underlying')],
    'WSTETH': [('lst:wstETH', 'NAV'), ('issuer:lido', 'issuer'), ('asset:ETH', 'underlying')], 'STETH': [('issuer:lido', 'issuer'), ('asset:ETH', 'underlying')],
    'WEETH': [('lst:weETH', 'NAV'), ('issuer:etherfi', 'issuer'), ('issuer:eigenlayer', 'restaking'), ('asset:ETH', 'underlying')],
    'RETH': [('lst:rETH', 'NAV'), ('issuer:rocketpool', 'issuer'), ('asset:ETH', 'underlying')], 'CBETH': [('lst:cbETH', 'NAV'), ('issuer:coinbase', 'issuer'), ('asset:ETH', 'underlying')],
    'JITOSOL': [('lst:JitoSOL', 'NAV'), ('issuer:jito', 'stake pool'), ('asset:SOL', 'underlying')], 'MSOL': [('lst:mSOL', 'NAV'), ('issuer:marinade', 'stake pool'), ('asset:SOL', 'underlying')],
    'JUPSOL': [('lst:JupSOL', 'NAV'), ('issuer:jupiter', 'stake pool'), ('issuer:sanctum', 'LST infra'), ('asset:SOL', 'underlying')], 'BSOL': [('lst:bSOL', 'NAV'), ('issuer:blaze', 'stake pool'), ('asset:SOL', 'underlying')],
    'JLP': [('issuer:jupiter', 'issuer'), ('asset:SOL', 'basket'), ('asset:ETH', 'basket'), ('asset:BTC', 'basket'), ('asset:USDC', 'basket'), ('oracle:pyth', 'perp pricing')],
    'WETH(SOLANA)': [('bridge:wormhole', 'bridge'), ('asset:ETH', 'underlying')], 'WBTC(SOLANA)': [('bridge:wormhole', 'bridge'), ('asset:WBTC', 'underlying')],
}
for a, ds in ASSET_DEPS.items():
    node('asset:' + a, 'asset', a)
    for d, rel in ds:
        if d.startswith('asset:'): node(d, 'asset', d[6:])
        if d.startswith('lst:'): node(d, 'lst', d[4:])
        dep('asset:' + a, d, rel)
for a in ['BTC', 'ETH', 'SOL', 'NEAR', 'ZEC', 'BNB']: node('asset:' + a, 'asset', a)

# ---------------- data pulls ----------------
lend = get_lending(ctx)
orc = readj('riskinfra_oracles.json', {}) or {}
def stablecoins():
    d = fetch('https://stablecoins.llama.fi/stablecoins?includePrices=true', ctx=ctx, timeout=40)
    out = []
    for p in d['peggedAssets']:
        mc = (p.get('circulating') or {}).get('peggedUSD') or 0
        if p.get('pegType') == 'peggedUSD' and mc >= 1e8 and p.get('price'):
            out.append({'symbol': p['symbol'], 'name': p['name'], 'price': float(p['price']), 'mcap': mc, 'pegMechanism': p.get('pegMechanism'), 'id': p.get('id')})
    return out
def protocols():
    d = fetch('https://api.llama.fi/protocols', ctx=ctx, timeout=60)
    return [{'name': p['name'], 'slug': p.get('slug'), 'category': p.get('category'), 'tvl': p.get('tvl'), 'change_1d': p.get('change_1d'), 'change_7d': p.get('change_7d'), 'id': p.get('id'), 'chains': p.get('chains', [])[:8]}
            for p in d if p.get('category') in ('Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Lending', 'Liquid Staking', 'Liquid Restaking', 'Basis Trading', 'CDP') and (p.get('tvl') or 0) > 5e7]
def hacks():
    d = fetch('https://api.llama.fi/hacks', ctx=ctx, timeout=40)
    cut = T0 - 30 * 86400
    return sorted([h for h in d if (h.get('date') or 0) >= cut], key=lambda h: -h['date'])
def eth_lsts():
    calls = [('wstETH', '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', '0x035faf82'), ('rETH', '0xae78736Cd615f374D3085123A210448E74Fc6393', '0xe6aa216c'),
             ('cbETH', '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', '0x3ba0b9a9'), ('weETH', '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', '0x679aefce')]
    res = eth_batch([('eth_call', [{'to': a, 'data': sel}, 'latest']) for _, a, sel in calls], ctx=ctx)
    out = {}
    pairs = fetch('https://api.dexscreener.com/tokens/v1/ethereum/' + ','.join(a for _, a, _ in calls), ctx=ctx)
    for (n, a, _), h in zip(calls, res):
        nav = int(h, 16) / 1e18 if h and h != '0x' else None
        ps = [p for p in pairs if U(p['baseToken']['address']) == U(a) and U(p['quoteToken']['symbol']) in ('WETH', 'ETH') and p.get('priceNative')]
        ps.sort(key=lambda p: -(p.get('liquidity') or {}).get('usd', 0))
        mkt = float(ps[0]['priceNative']) if ps else None
        out[n] = {'navInUnderlying': nav, 'marketInUnderlying': mkt, 'underlying': 'ETH', 'marketSource': f"DexScreener {ps[0]['dexId']} {ps[0]['pairAddress']} (liq ${ps[0]['liquidity']['usd']:,.0f})" if ps else None,
                  'navSource': 'eth_call exchange rate on ' + a}
    return out
def sol_lsts():
    pools = {'JitoSOL': ('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb', 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'), 'bSOL': ('stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi', 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'),
             'JupSOL': ('8VpRhuxa7sUUepdY3kQiTmX9rS5vx4WgaXiAnXq4KCtr', 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v')}
    r = sol_rpc('getMultipleAccounts', [[p for p, _ in pools.values()], {'encoding': 'base64'}], ctx=ctx)
    mints = [m for _, m in pools.values()] + ['mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 'So11111111111111111111111111111111111111112']
    jp = fetch('https://lite-api.jup.ag/price/v3?ids=' + ','.join(mints), ctx=ctx)
    sol = (jp.get('So11111111111111111111111111111111111111112') or {}).get('usdPrice')
    out = {}
    for (n, (p, m)), v in zip(pools.items(), r['value']):
        b = base64.b64decode(v['data'][0]); tl, sup = struct.unpack_from('<QQ', b, 258)
        mk = (jp.get(m) or {}).get('usdPrice')
        out[n] = {'navInUnderlying': tl / sup if sup else None, 'marketInUnderlying': mk / sol if mk and sol else None, 'underlying': 'SOL', 'navSource': 'SPL stake pool ' + p + ' total_lamports/pool_token_supply', 'marketSource': 'Jupiter price v3 ratio vs SOL'}
    ms = ctx.tryf('marinade', lambda: float(fetch('https://api.marinade.finance/msol/price_sol', ctx=ctx, raw=True)), None)
    mk = (jp.get('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So') or {}).get('usdPrice')
    out['mSOL'] = {'navInUnderlying': ms, 'marketInUnderlying': mk / sol if mk and sol else None, 'underlying': 'SOL', 'navSource': 'api.marinade.finance/msol/price_sol', 'marketSource': 'Jupiter price v3 ratio vs SOL'}
    return out
def sol_watch_tokens():
    """Solana watchlist tokens (priority/poolwatch/live A-B grades) -> mint authority -> bridged or native."""
    pw = readj('poolwatch.json', {}) or {}
    mints = set()
    for p in (pw.get('pools') or {}).values():
        sn = (p.get('snaps') or [{}])[-1]
        for k in ('mint0', 'mint1'):
            if sn.get(k): mints.add(sn[k])
    lf = readj('live_feed.json', {}) or {}
    for it in (lf.get('items') or [])[:200]:
        if it.get('chain') == 'solana' and it.get('grade') in ('A', 'B') and not it.get('veto'): mints.add(it['address'])
    mints.add('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'); mints.add('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs')  # Wormhole WBTC / WETH (Portal) as controls
    out = []
    ml = list(mints)[:40]
    for i in range(0, len(ml), 20):
        d = ctx.tryf('jupiter tokens', lambda: fetch('https://lite-api.jup.ag/tokens/v2/search?query=' + ','.join(ml[i:i + 20]), ctx=ctx), []) or []
        for t in d:
            ma = t.get('mintAuthority')
            out.append({'mint': t['id'], 'symbol': t.get('symbol'), 'name': t.get('name'), 'mintAuthority': ma, 'freezeAuthority': t.get('freezeAuthority'), 'liquidity': t.get('liquidity'),
                        'mcap': t.get('mcap'), 'bridged': 'wormhole' if ma == WORMHOLE_MINT_AUTH else None, 'verified': t.get('isVerified'), 'tags': t.get('tags')})
    return out

jobs = {'stables': stablecoins, 'protocols': protocols, 'hacks': hacks, 'ethLst': eth_lsts, 'solLst': sol_lsts, 'solTokens': sol_watch_tokens}
R = dict(zip(jobs, pmap(lambda k: ctx.tryf(k, jobs[k], None), list(jobs), 6)))

# ---------------- signals ----------------
# stablecoins
stab = R['stables'] or []
for s in stab:
    sym = U(s['symbol']); dev = s['price'] - 1
    i = 'asset:' + sym
    if i not in NODES and abs(dev) >= 0.005: node(i, 'asset', sym)
    if i in NODES:
        NODES[i].update(price=s['price'], mcap=s['mcap'])
        if dev >= 0.02: NODES[i]['note'] = 'trades >2% above $1: yield-accumulating token (not a depeg)'; continue
        if abs(dev) >= 0.02: sig(i, 'red', f"{sym} trading at ${s['price']:.4f} ({dev*100:+.2f}% vs $1 peg, DefiLlama)", value=dev)
        elif abs(dev) >= 0.005: sig(i, 'yellow', f"{sym} at ${s['price']:.4f} ({dev*100:+.2f}% vs peg)", value=dev)
st = readj('stables.json', {}) or {}
for a in (st.get('active_spikes') or [])[:10]:
    coin = U(a.get('coin') or a.get('pair', '').split(':')[-1] or '')
    for c in ('USDC', 'USDT', 'USDG'):
        if c in coin or c in json.dumps(a).upper():
            sig('asset:' + c, 'green', f"issuance spike (stables desk): {a.get('chain') or a.get('pair')} net {a.get('net')} z={a.get('z')}", info=True); break
# LST NAV
lsts = {}
for k in ('ethLst', 'solLst'): lsts.update(R[k] or {})
for n, v in lsts.items():
    node('lst:' + n, 'lst', n)
    if v.get('navInUnderlying') and v.get('marketInUnderlying'):
        disc = v['marketInUnderlying'] / v['navInUnderlying'] - 1; v['premiumPct'] = disc * 100
        NODES['lst:' + n].update(nav=v['navInUnderlying'], market=v['marketInUnderlying'], premiumPct=disc * 100)
        if disc <= -0.03: sig('lst:' + n, 'red', f"{n} trades {disc*100:.2f}% below NAV ({v['marketInUnderlying']:.4f} vs {v['navInUnderlying']:.4f} {v['underlying']})", value=disc)
        elif disc <= -0.01: sig('lst:' + n, 'yellow', f"{n} discount {disc*100:.2f}% to NAV", value=disc)
# lending
res = lend.get('reserves', [])
PROT_ORACLE = {'aave-v3': ['oracle:chainlink'], 'kamino': ['oracle:scope'], 'venus': ['oracle:resilient-oracle'], 'marginfi': ['oracle:pyth', 'oracle:switchboard']}
for p, nm in [('aave-v3', 'Aave v3'), ('kamino', 'Kamino Lend'), ('venus', 'Venus Core Pool'), ('morpho-blue', 'Morpho Blue'), ('marginfi', 'MarginFi')]:
    node('protocol:' + p, 'protocol', nm)
    for o in PROT_ORACLE.get(p, []): dep('protocol:' + p, o, 'price oracle')
sig('protocol:marginfi', 'green', 'no free keyless reserve API: utilization not monitored (static dependencies only)', info=True)
positions = []
def morpho_oracle(t):
    t = t or ''
    return 'oracle:chainlink' if 'Chainlink' in t else 'oracle:pendle-oracle' if 'Pendle' in t else None
for r in res:
    if (r.get('supplyUsd') or 0) < 2e7 or not r.get('borrowable'): continue
    p = r['protocol']; mid = f"market:{p}:{r['chain']}:{r['market']}:{r['symbol']}"
    node(mid, 'market', f"{r['symbol']} on {r['market']} ({r['chain']})", protocol=p, supplyUsd=r.get('supplyUsd'), utilization=r.get('utilization'), availableUsd=r.get('availableUsd'))
    dep(mid, 'protocol:' + p, 'protocol'); sym = U(r['symbol'])
    if 'asset:' + sym in NODES: dep(mid, 'asset:' + sym, 'loan asset')
    if p == 'morpho-blue':
        cs = U(r.get('collateralSymbol'))
        if cs:
            node('asset:' + cs, 'asset', cs); dep(mid, 'asset:' + cs, 'collateral')
        mo = morpho_oracle(r.get('oracleType'))
        if mo: dep(mid, mo, 'market oracle (' + (r.get('oracleType') or '?') + ')')
        NODES[mid]['oracleType'] = r.get('oracleType')
    u = r.get('utilization')
    if u is not None:
        hi, cr = (0.98, 0.995) if p == 'morpho-blue' else (0.95, 0.99)
        if u >= cr: sig(mid, 'red', f"utilization {u*100:.2f}% - lenders' withdrawal liquidity ${(r.get('availableUsd') or 0)/1e6:.2f}M of ${r['supplyUsd']/1e6:.1f}M", value=u)
        elif u >= hi: sig(mid, 'yellow', f"utilization {u*100:.2f}% (available ${(r.get('availableUsd') or 0)/1e6:.2f}M)", value=u)
    if r.get('paused') or r.get('frozen'): sig(mid, 'yellow', 'reserve ' + ('PAUSED' if r.get('paused') else 'frozen') + ' on Aave', value=1)
    positions.append(mid)
# collateral reserves paused/frozen with size
for r in res:
    if r['protocol'] == 'aave-v3' and r.get('paused') and (r.get('supplyUsd') or 0) > 1e6:
        mid = f"market:aave-v3:{r['chain']}:{r['market']}:{r['symbol']}"; node(mid, 'market', f"{r['symbol']} on {r['market']} ({r['chain']})", protocol='aave-v3', supplyUsd=r.get('supplyUsd'))
        dep(mid, 'protocol:aave-v3', 'protocol'); sig(mid, 'red', f"Aave reserve PAUSED with ${r['supplyUsd']/1e6:.1f}M supplied", value=1); positions.append(mid)
# bridges + protocol TVL
BRIDGE_MATCH = {'wormhole': r'^(wormhole|portal)', 'layerzero': r'stargate|layerzero', 'starkgate': r'starkgate|starknet bridge', 'arbitrum-bridge': r'^arbitrum (bridge|canonical)', 'base-bridge': r'^base (bridge|canonical)',
                'debridge': r'debridge|dln', 'allbridge': r'allbridge', 'across': r'^across'}
prot = R['protocols'] or []
bridges_seen = []
for p in prot:
    nm = p['name'].lower()
    if p['category'] in ('Bridge', 'Canonical Bridge', 'Cross Chain Bridge'):
        bid = next((k for k, rx in BRIDGE_MATCH.items() if re.search(rx, nm)), None)
        rec = dict(p, node='bridge:' + bid if bid else None); bridges_seen.append(rec)
        tgt = 'bridge:' + bid if bid else None
        c1, c7 = p.get('change_1d'), p.get('change_7d')
        lvl = 'red' if (c1 is not None and c1 <= -25) else 'yellow' if ((c1 is not None and c1 <= -10) or (c7 is not None and c7 <= -30)) else None
        if lvl and tgt: sig(tgt, lvl, f"{p['name']} TVL {c1:+.1f}% 1d / {c7 if c7 is not None else 0:+.1f}% 7d (now ${p['tvl']/1e6:,.0f}M)", value=c1)
        rec['flag'] = lvl
    else:
        for k, rx in [('aave-v3', r'^aave v3'), ('kamino', r'^kamino lend'), ('venus', r'^venus core'), ('morpho-blue', r'^morpho (blue|v1)$'), ('marginfi', r'^marginfi'), ('issuer:lido', r'^lido$'),
                      ('issuer:etherfi', r'^ether\.fi'), ('issuer:jito', r'^jito liquid'), ('issuer:ethena', r'^ethena usde'), ('issuer:marinade', r'^marinade liquid')]:
            if re.search(rx, nm):
                i = k if k.startswith('issuer:') else 'protocol:' + k
                NODES[i]['tvl'] = p['tvl']; NODES[i]['tvlChange1d'] = p.get('change_1d')
                if p.get('change_1d') is not None and p['change_1d'] <= -15: sig(i, 'yellow', f"{p['name']} TVL {p['change_1d']:+.1f}% in 1d", value=p['change_1d'])
bridges_seen.sort(key=lambda x: -(x['tvl'] or 0))
# hacks
hk = R['hacks'] or []
for h in hk:
    nm = (h.get('name') or '').lower(); age_d = (T0 - h['date']) / 86400; lvl = 'red' if age_d <= 7 else 'yellow'
    for i, n in NODES.items():
        if n['type'] in ('protocol', 'bridge', 'issuer', 'oracle'):
            key = n['name'].lower().split(' (')[0].split('/')[0]
            if len(key) >= 4 and (key in nm or nm.split(' ')[0] == key.split(' ')[0]) and nm.split(' ')[0] not in ('the',):
                sig(i, lvl, f"DefiLlama hacks feed: {h['name']} ({h.get('technique') or h.get('classification') or '?'}) ${h.get('amount') or 0:,.0f} on {', '.join(h.get('chain') or [])}, {age_d:.0f}d ago", value=h.get('amount'))
    w0 = U(nm.split(' ')[0])
    for i in ('asset:' + w0, 'token:' + w0):
        if len(w0) >= 3 and i in NODES: sig(i, 'yellow', f"ecosystem hack (DefiLlama): {h['name']} ${h.get('amount') or 0:,.0f}, {age_d:.0f}d ago", value=h.get('amount'))
    if h.get('bridgeHack'):
        for i in [i for i in NODES if i.startswith('bridge:')]:
            if NODES[i]['name'].lower().split('/')[0] in nm: sig(i, lvl, f"bridge hack reported: {h['name']}")
# oracles (from riskinfra_oracles.json)
ofl = orc.get('flags') or []
for f in ofl:
    a = U(f['asset']); src = f.get('source', '')
    if f['type'] in ('oracle_deviation', 'stale_oracle', 'lending_oracle_deviation') and f['severity'] != 'low':
        prov = 'oracle:' + src if src in ('chainlink', 'pyth', 'redstone') else ('oracle:scope' if src.startswith('kamino') else 'oracle:chainlink' if src.startswith('aave') else 'oracle:resilient-oracle' if src.startswith('venus') else None)
        if prov: sig(prov, 'yellow', f"{f['asset']}: {f['detail']}", asset=a)
        if 'asset:' + a in NODES: sig('asset:' + a, 'yellow' if f['severity'] == 'medium' else 'red', 'oracle: ' + f['detail'])
    if f['type'] == 'thin_dex_liquidity' and f['severity'] in ('high', 'medium') and 'asset:' + a in NODES:
        sig('asset:' + a, 'yellow', 'thin DEX liquidity behind lending collateral: ' + f['detail'])
# Solana watchlist tokens: bridged vs native
for t in R['solTokens'] or []:
    i = 'token:solana:' + t['mint']; node(i, 'token', f"{t['symbol']} (Solana {t['mint'][:4]}…)", mint=t['mint'], mintAuthority=t.get('mintAuthority'), freezeAuthority=t.get('freezeAuthority'), bridged=t.get('bridged'))
    if t.get('bridged') == 'wormhole':
        dep(i, 'bridge:wormhole', 'bridged via Wormhole (mint authority ' + WORMHOLE_MINT_AUTH[:6] + '…)')
    elif t.get('mintAuthority'):
        sig(i, 'yellow', f"native SPL with a LIVE mint authority {t['mintAuthority'][:6]}… (supply can be inflated) - not a bridged asset", info=False)
    if t.get('freezeAuthority'): sig(i, 'yellow', f"freeze authority set ({t['freezeAuthority'][:6]}…)")
    if t['symbol'] and U(t['symbol']) == 'STRK': NODES[i]['note'] = 'Solana "STRK" here is a native SPL token (not Starknet STRK bridged via StarkGate/Wormhole): no bridge dependency.'
    if t['symbol'] in ('QCAT', 'STRK'): dep(i, 'issuer:stonkfun', 'launchpad / fee authority')

# watchlist tokens (priority / perps top)
for s in ['NEAR', 'ZEC', 'BTC', 'ETH', 'SOL']: node('token:' + s, 'token', s); dep('token:' + s, 'asset:' + s, 'is')
for a in ['JITOSOL', 'MSOL', 'WSTETH', 'WEETH', 'USDE', 'SUSDE', 'JLP', 'WBTC(SOLANA)', 'WETH(SOLANA)', 'CBBTC', 'WBTC', 'USDC', 'USDT', 'PYUSD', 'USDS']:
    node('position:hold:' + a, 'position', 'hold ' + a); dep('position:hold:' + a, 'asset:' + a, 'holds')

# ---------------- propagation ----------------
adj = {}
for a, b, rel in EDGES: adj.setdefault(a, []).append((b, rel))
def walk(start):
    out, seen, stack = [], {start}, [(start, [])]
    while stack:
        cur, path = stack.pop()
        for b, rel in adj.get(cur, []):
            if b in seen: continue
            seen.add(b); p2 = path + [(b, rel)]
            out.append((b, p2)); stack.append((b, p2))
    return out
dependents = []
for i, n in NODES.items():
    if n['type'] not in ('position', 'market', 'token', 'asset'): continue
    hits = []
    for b, path in walk(i):
        nb = NODES.get(b)
        if nb and nb['status'] != 'green':
            hits.append({'dependency': b, 'name': nb['name'], 'status': nb['status'], 'path': ' -> '.join([n['name']] + [f"{NODES[x]['name']} [{rel}]" for x, rel in path]),
                         'signals': [s['text'] for s in nb['signals'] if s['level'] != 'green'][:3]})
    own = n['status']
    worst = max([SEVR[h['status']] for h in hits] + [SEVR[own]])
    n['inherited'] = hits; n['effective'] = [k for k, v in SEVR.items() if v == worst][0]
    if hits: dependents.append({'id': i, 'name': n['name'], 'type': n['type'], 'own': own, 'effective': n['effective'], 'via': hits[:6]})
dependents.sort(key=lambda d: (-SEVR[d['effective']], d['type'] != 'position', d['name']))
stressed = sorted([{'id': i, 'name': n['name'], 'type': n['type'], 'status': n['status'], 'signals': [s for s in n['signals'] if s['level'] != 'green']} for i, n in NODES.items() if n['status'] != 'green'],
                  key=lambda x: (-SEVR[x['status']], x['type']))
doc = {'generatedAt': NOWMS, 'elapsedS': round(time.time() - T0, 1),
       'summary': {'nodes': len(NODES), 'edges': len(EDGES), 'stressedNodes': len(stressed), 'red': sum(1 for s in stressed if s['status'] == 'red'), 'yellow': sum(1 for s in stressed if s['status'] == 'yellow'),
                   'flaggedDependents': len(dependents), 'positionsFlagged': sum(1 for d in dependents if d['type'] == 'position')},
       'stressed': stressed, 'dependents': dependents, 'lst': lsts, 'stablecoins': sorted(stab, key=lambda s: -abs(s['price'] - 1))[:25], 'bridges': bridges_seen[:30],
       'hacks30d': [{'date': h['date'] * 1000, 'name': h['name'], 'amount': h.get('amount'), 'chain': h.get('chain'), 'technique': h.get('technique'), 'bridgeHack': h.get('bridgeHack')} for h in hk],
       'lendingMarkets': [dict(NODES[m], inherited=None) for m in positions], 'solanaTokens': R['solTokens'],
       'nodes': {i: {k: v for k, v in n.items() if k != 'inherited'} for i, n in NODES.items()}, 'edges': EDGES,
       'unavailable': {'marginfi': 'no free reserve API', 'bridge_pauses': 'no free pause feed; inferred only from TVL outflows + hacks feed', 'lrt_navs': 'rsETH/ezETH NAV not read (oracle contracts differ per LRT)'},
       'method': __doc__, 'errors': ctx.errors, 'calls': ctx.calls}
writej('riskinfra_dependencies.json', doc)
hist = readj('riskinfra_dependencies_history.json', {'runs': []}) or {'runs': []}
hist['runs'] = (hist['runs'] + [{'t': NOWMS, **doc['summary']}])[-500:]
writej('riskinfra_dependencies_history.json', hist)
print(json.dumps({'elapsed': doc['elapsedS'], 'summary': doc['summary'], 'errors': ctx.errors}, default=str))
