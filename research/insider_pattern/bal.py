import json,urllib.request,sys
RPC={'56':'https://bsc-rpc.publicnode.com','1':'https://ethereum-rpc.publicnode.com','8453':'https://base-rpc.publicnode.com'}
def call(c,to,data):
    req=urllib.request.Request(RPC[c],data=json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":to,"data":data},"latest"]}).encode(),headers={'content-type':'application/json','User-Agent':'Mozilla/5.0'})
    return json.loads(urllib.request.urlopen(req,timeout=20).read()).get('result')
def code(c,a):
    req=urllib.request.Request(RPC[c],data=json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":[a,"latest"]}).encode(),headers={'content-type':'application/json','User-Agent':'Mozilla/5.0'})
    return json.loads(urllib.request.urlopen(req,timeout=20).read()).get('result')
c,tok=sys.argv[1],sys.argv[2]
dec=int(call(c,tok,'0x313ce567'),16)
for a in sys.argv[3:]:
    r=call(c,tok,'0x70a08231'+a[2:].lower().rjust(64,'0'))
    o=call(c,a,'0xa0e67e2b'); cd=code(c,a)
    print(a, round(int(r,16)/10**dec,2), 'codelen',(len(cd)-2)//2, 'safe' if o and len(o)>130 else '')
