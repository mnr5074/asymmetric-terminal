import json,datetime
s=json.load(open('screen.json'))
rows=[]
for i,r in s.items():
    for plat,c in r['chains'].items():
        g=c['goplus'] or {}
        hs=g.get('holders') or []
        if not hs: continue
        top10=sum(float(h.get('percent') or 0) for h in hs[:10])*100
        eoa=sum(float(h.get('percent') or 0) for h in hs[:10] if not int(h.get('is_contract') or 0))*100
        locked=sum(float(h.get('percent') or 0) for h in hs[:10] if int(h.get('is_locked') or 0))*100
        lps=g.get('lp_holders') or []
        lplock=sum(float(h.get('percent') or 0) for h in lps if int(h.get('is_locked') or 0))*100
        ends=[]
        for h in lps:
            for d in (h.get('locked_detail') or []): ends.append((h.get('tag'),d.get('end_time'),d.get('amount')))
        rows.append((i,r['symbol'],plat[:4],g.get('holder_count'),round(top10,1),round(eoa,1),round(locked,1),round(lplock,1),ends[:2],round(c['dex_liq_usd']),r['mc'] and round(r['mc']/1e6,1), round(100*c['dex_liq_usd']/r['mc'],2) if r['mc'] else None, r['circ'] and r['total'] and round(100*r['circ']/r['total']), g.get('is_mintable'), g.get('owner_address','')[:12], (g.get('creator_address') or '')[:12], g.get('creator_percent')))
for x in sorted(rows,key=lambda x:x[0]): print(x)
