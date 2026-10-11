const mev = require('../../lib/mev');
const WSOL='So11111111111111111111111111111111111111112', TOK='TokXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1';
const POOL='PooLAuthXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', VT='VaultTokXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', VS='VaultSolXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
function tx(sig, payer, ata1, ata2, dPoolTok, dPoolSol, poolTok, poolSol) {
  const keys=[{pubkey:payer,signer:true,writable:true},{pubkey:ata1,signer:false,writable:true},{pubkey:ata2,signer:false,writable:true},{pubkey:VT,signer:false,writable:true},{pubkey:VS,signer:false,writable:true}];
  const tb=(i,mint,owner,amt,dec)=>({accountIndex:i,mint,owner,uiTokenAmount:{amount:String(amt),decimals:dec}});
  return {transaction:{signatures:[sig],accountKeys:keys},meta:{err:null,fee:5000,preBalances:[1e9,2e6,2e6,2e6,2e6],postBalances:[1e9-5000,2e6,2e6,2e6,2e6],
    preTokenBalances:[tb(3,TOK,POOL,poolTok,6),tb(4,WSOL,POOL,poolSol,9)],postTokenBalances:[tb(3,TOK,POOL,poolTok+dPoolTok,6),tb(4,WSOL,POOL,poolSol+dPoolSol,9)]}};
}
// SELL sandwich: attacker sells TOK first (pool +TOK, -SOL), victim sells (pool +TOK, -SOL), attacker buys back (pool -TOK, +SOL) cheaper
const A='AttackerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', V='VictimXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const blk={transactions:[tx('front',A,'a1','a2', 1000e6, -10e9, 1e12, 1e12), tx('victim',V,'v1','v2', 500e6, -4.8e9, 1e12, 1e12), tx('back',A,'a1','a2', -1000e6, 9.7e9, 1e12, 1e12)]};
// victim's own deltas for side detection
blk.transactions[1].meta.preTokenBalances.push({accountIndex:1,mint:TOK,owner:V,uiTokenAmount:{amount:'500000000',decimals:6}});
blk.transactions[1].meta.postTokenBalances.push({accountIndex:1,mint:TOK,owner:V,uiTokenAmount:{amount:'0',decimals:6}});
(async()=>{ const rpc={call:async()=>blk};
 const r=await mev.bracketCheck(rpc,1,'victim',null,{inMint:TOK,outMint:WSOL,side:'sell'}); console.log('SELL sandwich ->',r.bracketed, JSON.stringify(r.hits[0]));
 // same block judged as a BUY (wrong direction) must not flag
 const r2=await mev.bracketCheck(rpc,2,'victim',null,{inMint:WSOL,outMint:TOK,side:'buy'}); console.log('as BUY ->',r2.bracketed);
})();
(async()=>{ const b2={transactions:[tx('f2',A,'a1','a2',-1000e6, 10e9,1e12,1e12), tx('v2',V,'v1','v2',-500e6,5.2e9,1e12,1e12), tx('b2',A,'a1','a2',1000e6,-10.3e9,1e12,1e12)]};
 const r=await mev.bracketCheck({call:async()=>b2},3,'v2',null,{inMint:WSOL,outMint:TOK,side:'buy'}); console.log('BUY sandwich ->',r.bracketed, r.hits[0].attackerProfitQuote); })();
