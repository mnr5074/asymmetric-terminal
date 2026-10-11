"""Hard-capped Nansen client for the insider-pattern run (user-approved cap: 60 credits).
Reads NANSEN_API_KEY from env (never printed). Ledger -> ../../data/insider_pattern_nansen_raw.json"""
import json, os, time, urllib.request, urllib.error
BASE='https://api.nansen.ai/api/v1'
CAP=60
COST={'account':0,'tgm/transfers':1,'profiler/address/first-funder':1,'profiler/address/related-wallets':1,'profiler/address/transactions':1,'search/entity-name':0}
RAW=os.path.join(os.path.dirname(__file__),'..','..','data','insider_pattern_nansen_raw.json')
L=json.load(open(RAW)) if os.path.exists(RAW) else {'cap':CAP,'used':0,'calls':[],'accountBefore':None,'accountAfter':None}
def save(): json.dump(L,open(RAW,'w'),indent=1)
def call(ep,body=None,method='POST',tag=''):
    exp=COST.get(ep)
    if exp is None: raise SystemExit('unknown cost for '+ep+'; refusing')
    if L['used']+exp>CAP: return {'skipped':'cap','used':L['used']}
    key=os.environ.get('NANSEN_API_KEY')
    req=urllib.request.Request(BASE+'/'+ep,data=json.dumps(body).encode() if method=='POST' else None,method=method,
        headers={'apikey':key,'content-type':'application/json','accept':'application/json'})
    st=None; hdr={}
    try:
        r=urllib.request.urlopen(req,timeout=120); st=r.status; hdr=dict(r.headers); data=json.loads(r.read() or b'null')
    except (TimeoutError,OSError) as e:
        if not isinstance(e,urllib.error.HTTPError):
            L['used']+=exp; L['calls'].append({'t':time.strftime('%Y-%m-%dT%H:%M:%S'),'ep':ep,'tag':tag,'body':body,'status':'timeout','used':exp,'assumed':True,'cum':L['used'],'data':None}); save()
            print(tag,'TIMEOUT (counted',exp,'credit conservatively) cum',L['used'],flush=True); return {'error':'timeout'}
        e2=e
        st=e2.code; hdr=dict(e2.headers)
        try: data={'error':json.loads(e2.read())}
        except Exception: data={'error':str(e2)}
        used=int(hdr.get('x-nansen-credits-used') or 0); rem=hdr.get('x-nansen-credits-remaining')
        L['used']+=used; L['calls'].append({'t':time.strftime('%Y-%m-%dT%H:%M:%S'),'ep':ep,'tag':tag,'body':body,'status':st,'used':used,'remaining':rem,'cum':L['used'],'data':data}); save()
        print(tag,ep,'status',st,'used',used,'cum',L['used'],flush=True); return data
    except urllib.error.HTTPError as e:
        st=e.code; hdr=dict(e.headers); 
        try: data={'error':json.loads(e.read())}
        except Exception: data={'error':str(e)}
    used=int(hdr.get('x-nansen-credits-used') or hdr.get('X-Nansen-Credits-Used') or 0)
    rem=hdr.get('x-nansen-credits-remaining') or hdr.get('X-Nansen-Credits-Remaining')
    L['used']+=used
    L['calls'].append({'t':time.strftime('%Y-%m-%dT%H:%M:%S'),'ep':ep,'tag':tag,'body':body,'status':st,'used':used,'remaining':rem,'cum':L['used'],'data':data})
    save()
    print(f"{tag:28s} {ep:36s} status={st} used={used} cum={L['used']} remaining={rem}",flush=True)
    return data
def account(which):
    d=call('account',None,'GET','account_'+which)
    L['account'+which.capitalize()]=d; save(); return d
