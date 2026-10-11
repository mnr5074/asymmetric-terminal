"""Current-state check (free public RPC): for top holders of each token, read balance, detect Gnosis Safe (getOwners/getThreshold),
and find signer overlap between holder buckets. Overlap = same keys control 'locked' and 'liquid' buckets."""
import json,urllib.request,sys,time
RPC={'56':['https://bsc-rpc.publicnode.com','https://bsc-dataseed1.binance.org'],'1':['https://ethereum-rpc.publicnode.com'],'8453':['https://base-rpc.publicnode.com','https://mainnet.base.org']}
PL={'binance-smart-chain':'56','ethereum':'1','base':'8453'}
def call(c,to,data):
    for u in RPC[c]:
        try:
            req=urllib.request.Request(u,data=json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":to,"data":data},"latest"]}).encode(),headers={'content-type':'application/json','User-Agent':'Mozilla/5.0'})
            r=json.loads(urllib.request.urlopen(req,timeout=20).read())
            if 'result' in r: return r['result']
        except Exception as e: pass
    return None
def owners(c,a):
    r=call(c,a,'0xa0e67e2b')
    if not r or len(r)<130: return None
    try:
        b=bytes.fromhex(r[2:]); n=int.from_bytes(b[32:64],'big')
        if n==0 or n>50: return None
        os_=['0x'+b[64+32*i+12:64+32*(i+1)].hex() for i in range(n)]
        t=call(c,a,'0xe75235b8'); th=int(t,16) if t and t!='0x' else None
        return {'owners':os_,'threshold':th}
    except Exception: return None
s=json.load(open('screen.json'))
ids=sys.argv[1].split(',')
out=json.load(open('safe_overlap.json')) if __import__('os').path.exists('safe_overlap.json') else {}
for i in ids:
    r=s[i]
    for plat,ch in r['chains'].items():
        c=PL.get(plat)
        if not c: continue
        hs=(ch['goplus'] or {}).get('holders') or []
        rows=[]
        for h in hs[:10]:
            o=owners(c,h['address']) if int(h.get('is_contract') or 0) else None
            rows.append({'address':h['address'],'pct':round(float(h['percent'])*100,2),'contract':int(h.get('is_contract') or 0),'tag':h.get('tag'),'safe':o})
        # overlap
        safes=[x for x in rows if x['safe']]
        ov=[]
        for a in range(len(safes)):
            for b in range(a+1,len(safes)):
                inter=set(safes[a]['safe']['owners'])&set(safes[b]['safe']['owners'])
                if inter: ov.append({'a':safes[a]['address'],'b':safes[b]['address'],'shared':sorted(inter)})
        out[f'{i}:{plat}']={'holders':rows,'overlap':ov}
        print(i,plat,'safes',len(safes),'overlaps',len(ov))
        for x in rows: print('  ',x['address'],x['pct'],'C' if x['contract'] else 'E', (str(x['safe']['threshold'])+'/'+str(len(x['safe']['owners']))) if x['safe'] else '')
        json.dump(out,open('safe_overlap.json','w'),indent=1)
