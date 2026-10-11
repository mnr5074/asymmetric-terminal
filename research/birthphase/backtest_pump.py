import sys; sys.path.insert(0,'.')
import match as mt, json
recs=mt.load(); rates=mt.pad_rates(recs)
lab=sorted([r for r in recs if (r.get('outcome') or {}).get('reached_1m') is not None], key=lambda r:r['created_ts'])
cut=lab[int(len(lab)*0.7)]['created_ts']
train=[r for r in recs if r['created_ts']<cut]; test=[r for r in recs if r['created_ts']>=cut and r['launchpad']=='pump.fun']
out={}
for A in (300,900,3600):
  for thr in (1e5,1e6,1e7):
    M=mt.Model(train,A,thr,rates); T=mt.Model(test,A,thr,rates)
    rows=[]
    for rw in T.rows:
        pr=M.predict(rw['v'],rw['sh'],rw['pad'])
        if pr: rows.append((rw['y'],pr['p'],M.w['w'].get((rw['pad'],rw['cell']),1.0),bool(rw['v'].get('grad')),rw['r']['sample_stratum']))
    res={'n':len(rows),'pos':sum(r[0] for r in rows),'n_on_curve':sum(1 for r in rows if not r[3]),'pos_on_curve':sum(r[0] for r in rows if not r[3]),
         'auc_popw':mt.auc([r[0] for r in rows],[r[1] for r in rows],[r[2] for r in rows]),
         'auc_on_curve_popw':mt.auc([r[0] for r in rows if not r[3]],[r[1] for r in rows if not r[3]],[r[2] for r in rows if not r[3]]),'at':[]}
    tw=sum(r[2]*r[0] for r in rows)
    for t in (0.005,0.01,0.02,0.05,0.1,0.2):
        s=[r for r in rows if r[1]>=t]; sw=sum(r[2] for r in s)
        res['at'].append({'p_ge':t,'flagged':len(s),'hits':sum(r[0] for r in s),'prec_popw':(sum(r[2]*r[0] for r in s)/sw) if sw else None,'recall_popw':(sum(r[2]*r[0] for r in s)/tw) if tw else None,
                          'flagged_on_curve':sum(1 for r in s if not r[3]),'hits_on_curve':sum(r[0] for r in s if not r[3])})
    out[f'{A}_{int(thr)}']=res
    print(A,int(thr),{k:(round(v,3) if isinstance(v,float) else v) for k,v in res.items() if k!='at'})
    for a in res['at']: print('   ',{k:(round(v,4) if isinstance(v,float) else v) for k,v in a.items()})
m=json.load(open('../../data/birthphase/model.json')); m['backtest']['pump_only']={'note':'pump.fun test launches only (created after the cut), probabilities and precision re-weighted to the population with the random launch + random graduation samples','by':out}
json.dump(m,open('../../data/birthphase/model.json','w'))
