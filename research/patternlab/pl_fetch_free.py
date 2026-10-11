#!/usr/bin/env python3
"""Free-data fetchers for the Pattern Lab (no Nansen, no X). All cached under data/patternlab_cache/.
 market : Binance public klines (data-api.binance.vision) daily BTC/ETH/ETHBTC + 28 alts (beta regime, alt breadth, BTC drawdowns),
          CoinGecko free daily USDT/USDC prices (depeg history), OFAC SDN SOL/ETH address lists (0xB10C mirror of the Treasury SDN file)
 devs   : deployer wallet profile via public Solana RPC: first tx, first funder (oldest tx SOL sender), fresh-at-launch, pump.fun
          creates by the same deployer within +-12h of the token's creation (bundle play, pattern #36)
 buyers : first 100 distinct buyers from the Nansen tape (cached) -> RPC age + funder for the first 15 (PL_NBUY) (pattern #33)
 jito   : early tape txs (first 2 s of trading) -> getTransaction -> Jito tip-account transfers (pattern #23), flash-loan program ids (#20)
Usage: pl_fetch_free.py market|devs|buyers|jito"""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plcommon as P
PC = P.PC
PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
JITO_TIPS = {'96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
             'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', 'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
             'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'}
FLASH = {'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo': 'solend', 'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA': 'marginfi',
         'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD': 'kamino-lend', 'FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn': 'flash-trade'}
BX = 'https://data-api.binance.vision/api/v3/klines'
ALTS = ['SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'TRX', 'NEAR', 'SUI', 'APT', 'ARB', 'OP', 'INJ', 'TIA', 'PEPE', 'SHIB',
        'WIF', 'BONK', 'FET', 'UNI', 'AAVE', 'ATOM', 'FIL', 'ETC', 'HBAR']

def market():
    out = {}
    for s in ['BTCUSDT', 'ETHUSDT', 'ETHBTC'] + [a + 'USDT' for a in ALTS]:
        rows = []
        end = None
        for _ in range(2):  # ~2000 days max, 1000/call
            u = f'{BX}?symbol={s}&interval=1d&limit=1000' + (f'&endTime={end}' if end else '')
            r = PC.http(u) or []
            rows = r + rows
            if len(r) < 1000: break
            end = r[0][0] - 1
        out[s] = [[int(x[0] / 1000), float(x[4]), float(x[2]), float(x[3])] for x in rows]  # ts, close, high, low
        P.log('kline', s, len(out[s]))
    for cg in ('tether', 'usd-coin'):
        j = PC.http(f'https://api.coingecko.com/api/v3/coins/{cg}/market_chart?vs_currency=usd&days=365&interval=daily') or {}
        out['cg_' + cg] = [[int(t / 1000), p] for t, p in j.get('prices', [])]
        P.log('cg', cg, len(out['cg_' + cg]))
    ofac = {}
    for ch in ('SOL', 'ETH'):
        try:
            import urllib.request
            txt = urllib.request.urlopen(f'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_{ch}.txt', timeout=30).read().decode()
            ofac[ch] = [l.strip() for l in txt.splitlines() if l.strip()]
        except Exception as e: ofac[ch] = []; P.log('ofac err', e)
    out['ofac'] = ofac
    json.dump(out, open(os.path.join(P.CACHE, 'market.json'), 'w')); P.log('market saved')

def oldest_sigs(addr, pages=3):
    return P.cached('sigs', f'{addr}_{pages}', lambda: (lambda r: {'sigs': r[0], 'done': r[1]})(PC.sigs(addr, max_pages=pages)))

def funder_of(addr, sig):
    t = PC.tx(sig)
    if not t: return None
    ins = list(t['transaction']['message'].get('instructions', []))
    for g in (t.get('meta') or {}).get('innerInstructions') or []: ins += g.get('instructions', [])
    for i in ins:
        p = i.get('parsed')
        if isinstance(p, dict) and i.get('program') == 'system' and p.get('type') in ('transfer', 'createAccount', 'transferWithSeed'):
            inf = p.get('info', {})
            if inf.get('destination') == addr or inf.get('newAccount') == addr: return {'funder': inf.get('source'), 'sol': (inf.get('lamports') or 0) / 1e9, 't': t.get('blockTime')}
    keys = [k['pubkey'] if isinstance(k, dict) else k for k in t['transaction']['message']['accountKeys']]
    return {'funder': keys[0] if keys and keys[0] != addr else None, 'sol': None, 't': t.get('blockTime'), 'fee_payer_guess': True}

def wallet_profile(addr, pages=3):
    s = oldest_sigs(addr, pages)
    sig = s['sigs']; prof = {'addr': addr, 'n_sigs': len(sig), 'exhausted': s['done']}
    if s['done'] and sig:
        old = min((x for x in sig if x['t']), key=lambda x: x['t'], default=None)
        if old: prof['first_tx'] = old['t']; f = funder_of(addr, old['sig']); prof.update(f or {})
    return prof

def devs():
    out = {}
    for t in P.test_set():
        dev = t['db'].get('dev'); c = t['created_t']
        if not dev: continue
        try:
            prof = wallet_profile(dev, 3)
            # same-day creates: dev signatures within +-12h of creation, parse up to 30 and count pump.fun create instructions
            s = oldest_sigs(dev, 3)['sigs']
            near = [x for x in s if x['t'] and abs(x['t'] - c) <= 12 * 3600 and not x['err']][:30]
            creates = []
            for x in near:
                tx = PC.tx(x['sig'])
                logs = ((tx or {}).get('meta') or {}).get('logMessages') or []
                if any(PUMP in l for l in logs) and any('Instruction: Create' in l and 'Associated' not in l for l in logs):
                    mint = None
                    for b in (tx['meta'].get('postTokenBalances') or []):
                        if b.get('mint', '').endswith('pump'): mint = b['mint']; break
                    creates.append({'t': x['t'], 'sig': x['sig'], 'mint': mint})
            prof['creates_pm12h'] = creates; prof['near_sigs_checked'] = len(near); prof['near_sigs_total'] = sum(1 for x in s if x['t'] and abs(x['t'] - c) <= 12 * 3600)
        except Exception as e: prof = {'addr': dev, 'err': str(e)[:120]}
        out[t['mint']] = prof; P.log('dev', t['symbol'], prof.get('n_sigs'), prof.get('funder'), len(prof.get('creates_pm12h') or []))
    json.dump(out, open(os.path.join(P.CACHE, 'devs.json'), 'w'))

def tape_of(t):
    import pl_fetch_nansen as F
    try: j = F.get('tape', t, 0)
    except P.NansenStop: return []
    return (j or {}).get('data') or [] if isinstance(j, dict) else []

NBUY = int(os.environ.get('PL_NBUY', '15'))
def buyers():
    out = {}
    for t in P.test_set():
        tape = tape_of(t)
        seen, first = set(), []
        for x in tape:
            if x['action'] == 'BUY' and x['trader_address'] not in seen:
                seen.add(x['trader_address']); first.append((x['trader_address'], P.tsof(x['block_timestamp'])))
            if len(first) >= 100: break
        from concurrent.futures import ThreadPoolExecutor
        def one(a):
            w, bt = a
            try: pr = wallet_profile(w, 1); pr['buy_t'] = bt; return pr
            except Exception as e: return {'addr': w, 'err': str(e)[:80], 'buy_t': bt}
        with ThreadPoolExecutor(5) as ex: profs = list(ex.map(one, first[:NBUY]))
        out[t['mint']] = {'n_first_buyers': len(first), 'profiles': profs}
        P.log('buyers', t['symbol'], len(first), sum(1 for p in profs if p.get('first_tx')))
        json.dump(out, open(os.path.join(P.CACHE, 'buyers.json'), 'w'))

def jito():
    out = {}
    for t in P.test_set():
        tape = tape_of(t)
        if not tape: continue
        t0 = P.tsof(tape[0]['block_timestamp'])
        early = [x for x in tape if P.tsof(x['block_timestamp']) - t0 <= 2][:12]
        res = []
        for x in early:
            tx = PC.tx(x['transaction_hash'])
            if not tx: continue
            keys = [k['pubkey'] if isinstance(k, dict) else k for k in tx['transaction']['message']['accountKeys']]
            res.append({'sig': x['transaction_hash'][:16], 'trader': x['trader_address'], 'action': x['action'], 'jito_tip': bool(JITO_TIPS & set(keys)),
                        'flash': [FLASH[k] for k in keys if k in FLASH], 'slot': tx.get('slot')})
        out[t['mint']] = res; P.log('jito', t['symbol'], len(res), sum(r['jito_tip'] for r in res))
        json.dump(out, open(os.path.join(P.CACHE, 'jito.json'), 'w'))

def meta():
    """RugCheck free report (mutable metadata / markets / risks) + pump.fun coin record (twitter/telegram/website links) per token."""
    out = {}
    for t in P.test_set():
        m = t['mint']
        rc = P.cached('rugcheck', m, lambda: PC.http(f'https://api.rugcheck.xyz/v1/tokens/{m}/report'))
        pf = P.cached('pumpcoin', m, lambda: PC.http(f'https://frontend-api-v3.pump.fun/coins/{m}', headers={'User-Agent': 'Mozilla/5.0'}))
        rc = rc or {}; pf = pf or {}
        out[m] = {'risks': [r.get('name') for r in rc.get('risks') or []], 'mutable': rc.get('tokenMeta', {}).get('mutable') if isinstance(rc.get('tokenMeta'), dict) else None,
                  'updateAuthority': (rc.get('tokenMeta') or {}).get('updateAuthority') if isinstance(rc.get('tokenMeta'), dict) else None,
                  'markets': len(rc.get('markets') or []), 'mintAuthority': rc.get('mintAuthority'), 'freezeAuthority': rc.get('freezeAuthority'),
                  'creator': rc.get('creator') or pf.get('creator'), 'twitter': pf.get('twitter'), 'telegram': pf.get('telegram'), 'website': pf.get('website'),
                  'pf_created': pf.get('created_timestamp')}
        P.log('meta', t['symbol'], out[m]['mutable'], out[m]['markets'], out[m]['twitter'])
    json.dump(out, open(os.path.join(P.CACHE, 'meta.json'), 'w'))

if __name__ == '__main__':
    {'market': market, 'devs': devs, 'meta': meta, 'buyers': buyers, 'jito': jito}[sys.argv[1]]()
