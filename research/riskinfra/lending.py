"""Lending-market snapshot shared by oracles.py and dependencies.py -> data/riskinfra_lending.json.
Aave v3 (official GraphQL api.v3.aave.com), Kamino (api.kamino.finance reserves/metrics), Venus core pool (api.venus.io),
Morpho Blue listed markets (blue-api.morpho.org). MarginFi: no free keyless reserve API found -> listed as unavailable.
Prices inside these responses ARE the protocols' own oracle prices (AaveOracle, Kamino Scope, Venus ResilientOracle)."""
import time
from common import fetch, readj, writej, Ctx, pmap

AAVE_Q = '{ markets(request:{chainIds:[1,8453,42161]}) { name address chain { chainId name } reserves { underlyingToken { symbol address } usdExchangeRate isFrozen isPaused supplyInfo { total { value } canBeCollateral } borrowInfo { total { usd } utilizationRate { value } availableLiquidity { usd } } } } }'
MORPHO_Q = '{ markets(first: 60, orderBy: SupplyAssetsUsd, orderDirection: Desc, where:{listed:true}) { items { marketId loanAsset { symbol address } collateralAsset { symbol address } oracle { address type } morphoBlue { chain { id } } state { utilization supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd collateralAssetsUsd } } } }'
F = lambda x: float(x) if x not in (None, '') else None


def aave(ctx):
    d = fetch('https://api.v3.aave.com/graphql', data={'query': AAVE_Q}, ctx=ctx, timeout=40)
    out = []
    for m in d['data']['markets']:
        for r in m['reserves']:
            px = F(r['usdExchangeRate']); sup = F((r['supplyInfo'] or {}).get('total', {}).get('value'))
            b = r.get('borrowInfo') or {}
            out.append({'protocol': 'aave-v3', 'market': m['name'], 'chainId': m['chain']['chainId'], 'chain': m['chain']['name'],
                        'symbol': r['underlyingToken']['symbol'], 'address': r['underlyingToken']['address'], 'oraclePrice': px,
                        'oracleName': 'AaveOracle (Chainlink/CAPO adapters)', 'supplyUsd': sup * px if sup is not None and px else None,
                        'borrowUsd': F((b.get('total') or {}).get('usd')), 'utilization': F((b.get('utilizationRate') or {}).get('value')),
                        'availableUsd': F((b.get('availableLiquidity') or {}).get('usd')), 'collateral': (r['supplyInfo'] or {}).get('canBeCollateral'),
                        'borrowable': bool(b), 'frozen': r['isFrozen'], 'paused': r['isPaused']})
    return out


def kamino(ctx):
    mk = fetch('https://api.kamino.finance/v2/kamino-market', ctx=ctx)
    def one(m):
        rs = fetch(f"https://api.kamino.finance/kamino-market/{m['lendingMarket']}/reserves/metrics?env=mainnet-beta", ctx=ctx)
        out = []
        for r in rs:
            ts, tb, tsu, tbu = F(r.get('totalSupply')), F(r.get('totalBorrow')), F(r.get('totalSupplyUsd')), F(r.get('totalBorrowUsd'))
            out.append({'protocol': 'kamino', 'market': m['name'], 'chainId': 'solana', 'chain': 'Solana', 'symbol': r['liquidityToken'], 'address': r['liquidityTokenMint'],
                        'oraclePrice': tsu / ts if ts else None, 'oracleName': 'Kamino Scope (aggregates Pyth/Switchboard/Chainlink/DEX TWAPs)',
                        'supplyUsd': tsu, 'borrowUsd': tbu, 'utilization': tb / ts if ts else None, 'availableUsd': (tsu - tbu) if tsu is not None and tbu is not None else None,
                        'collateral': F(r.get('maxLtv')) not in (None, 0.0), 'borrowable': True, 'maxLtv': F(r.get('maxLtv'))})
        return out
    res = []
    for part in pmap(lambda m: ctx.tryf('kamino ' + m['name'], lambda: one(m), []), mk[:14], 4): res += part
    return res


def venus(ctx):
    d = fetch('https://api.venus.io/markets/core-pool?limit=100', ctx=ctx, timeout=40)
    out = []
    for r in d['result']:
        sup = F(r.get('totalSupplyUnderlyingCents')); bor = F(r.get('totalBorrowCents')); liq = F(r.get('liquidityCents'))
        out.append({'protocol': 'venus', 'market': 'Venus Core Pool', 'chainId': 56, 'chain': 'BNB Chain', 'symbol': r['underlyingSymbol'], 'address': r.get('underlyingAddress'),
                    'oraclePrice': F(r.get('tokenPriceCents')) / 100 if r.get('tokenPriceCents') else None, 'oracleName': 'Venus ResilientOracle (Chainlink/RedStone/Binance Oracle/Pyth)',
                    'supplyUsd': sup / 100 if sup is not None else None, 'borrowUsd': bor / 100 if bor is not None else None,
                    'utilization': bor / sup if sup else None, 'availableUsd': liq / 100 if liq is not None else None,
                    'collateral': r.get('canBeCollateral'), 'borrowable': r.get('isBorrowable')})
    return out


def morpho(ctx):
    d = fetch('https://blue-api.morpho.org/graphql', data={'query': MORPHO_Q}, ctx=ctx, timeout=40)
    out = []
    for m in d['data']['markets']['items']:
        st = m['state'] or {}; col = m.get('collateralAsset') or {}
        out.append({'protocol': 'morpho-blue', 'market': f"{col.get('symbol')}/{m['loanAsset']['symbol']}", 'marketId': m['marketId'], 'chainId': m['morphoBlue']['chain']['id'],
                    'chain': {1: 'Ethereum', 8453: 'Base', 42161: 'Arbitrum'}.get(m['morphoBlue']['chain']['id'], str(m['morphoBlue']['chain']['id'])),
                    'symbol': m['loanAsset']['symbol'], 'collateralSymbol': col.get('symbol'), 'collateralAddress': col.get('address'),
                    'oracleAddress': (m.get('oracle') or {}).get('address'), 'oracleType': (m.get('oracle') or {}).get('type'),
                    'supplyUsd': st.get('supplyAssetsUsd'), 'borrowUsd': st.get('borrowAssetsUsd'), 'utilization': st.get('utilization'),
                    'availableUsd': st.get('liquidityAssetsUsd'), 'collateralUsd': st.get('collateralAssetsUsd'), 'borrowable': True})
    return out


def get_lending(ctx, max_age=1800):
    old = readj('riskinfra_lending.json')
    if old and time.time() * 1000 - old.get('generatedAt', 0) < max_age * 1000: return old
    srcs = {'aave-v3': aave, 'kamino': kamino, 'venus': venus, 'morpho-blue': morpho}
    res = dict(zip(srcs, pmap(lambda k: ctx.tryf('lending ' + k, lambda: srcs[k](ctx), None), list(srcs), 4)))
    reserves = [r for v in res.values() for r in (v or [])]
    doc = {'generatedAt': int(time.time() * 1000), 'reserves': reserves,
           'sources': {k: (len(v) if v is not None else 'failed') for k, v in res.items()},
           'unavailable': {'marginfi': 'no free keyless reserve/utilization API found (would need on-chain account decoding of every Bank)'}}
    if reserves: writej('riskinfra_lending.json', doc)
    return doc


if __name__ == '__main__':
    c = Ctx('lending'); d = get_lending(c, 0); print(d['sources'], len(d['reserves']), c.errors)
