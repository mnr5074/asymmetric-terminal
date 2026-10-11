"""Free-data screen for Velvet-style insider structure. GoPlus + DexScreener + CoinGecko markets snapshot. No Nansen, no paid X."""
import json, time, urllib.request, os, sys
H={'User-Agent':'Mozilla/5.0'}
def get(u,t=30):
    for i in range(3):
        try:
            return json.loads(urllib.request.urlopen(urllib.request.Request(u,headers=H),timeout=t).read())
        except Exception as e:
            err=e; time.sleep(3)
    return {'_err':str(err)}
IDS=sys.argv[1].split(',') if len(sys.argv)>1 else []
cg={c['id']:c for c in json.load(open('cg_list.json'))}
mk={m['id']:m for m in json.load(open('../top10_raw/markets.json'))}
CH={'binance-smart-chain':'56','ethereum':'1','base':'8453','solana':'solana'}
out=json.load(open('screen.json')) if os.path.exists('screen.json') else {}
for i in IDS:
    if i in out and not out[i].get('_retry'): continue
    p=cg.get(i,{}).get('platforms',{}) or {}
    m=mk.get(i,{})
    rec={'id':i,'symbol':m.get('symbol') or cg.get(i,{}).get('symbol'),'platforms':{k:v for k,v in p.items() if v},
         'mc':m.get('market_cap'),'fdv':m.get('fully_diluted_valuation'),'circ':m.get('circulating_supply'),'total':m.get('total_supply'),
         'ath':m.get('ath'),'ath_date':(m.get('ath_date') or '')[:10],'ath_chg':m.get('ath_change_percentage'),'chains':{}}
    for plat,addr in rec['platforms'].items():
        c=CH.get(plat)
        if not c: continue
        if c=='solana':
            g=get(f'https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses={addr}')
        else:
            g=get(f'https://api.gopluslabs.io/api/v1/token_security/{c}?contract_addresses={addr}')
        res=(g.get('result') or {})
        v=res.get(addr.lower()) or res.get(addr) or (list(res.values())[0] if res else {})
        ds=get(f'https://api.dexscreener.com/latest/dex/tokens/{addr}')
        pairs=[x for x in (ds.get('pairs') or []) if x.get('baseToken',{}).get('address','').lower()==addr.lower() or x.get('quoteToken',{}).get('address','').lower()==addr.lower()]
        rec['chains'][plat]={'address':addr,'goplus':v,'dex_liq_usd':sum((x.get('liquidity') or {}).get('usd') or 0 for x in pairs),
            'pairs':[{'dex':x.get('dexId'),'pair':x.get('pairAddress'),'liq':(x.get('liquidity') or {}).get('usd'),'chain':x.get('chainId'),'created':x.get('pairCreatedAt')} for x in sorted(pairs,key=lambda x:-((x.get('liquidity') or {}).get('usd') or 0))[:6]]}
        time.sleep(2.2)
    out[i]=rec
    json.dump(out,open('screen.json','w'))
    print(i, list(rec['chains']), flush=True)
