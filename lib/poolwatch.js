'use strict';
// Pool monitor (free public data only): QCAT/STRK Raydium CPMM pool on Solana.
// Every ~15 min records pool reserves (vault balance minus protocol/fund/creator fees, i.e. what the
// CPMM actually prices on), LP supply, sqrt(k), the Token-2022 withheld transfer-fee amount on the QCAT
// mint, and any LP-mint activity (Deposit / Withdraw = liquidity added/removed). A CPMM Deposit from
// any wallet is what a real "fees compound into liquidity" mechanism would look like on-chain.
// sqrt(k) growth with flat LP supply is ordinary LP trade-fee accrual, not a deposit.
// Output: data/poolwatch.json. Read-only; never signs anything.
const fs = require('fs');
const path = require('path');
const { rpcFor } = require('./solrpc');

const POOLS = [{
  id: 'QCAT/STRK',
  pool: 'BDnUeUB8qfkxURXrDwZvTsvVKj6Nzsv7SgyqViBVST1X',   // Raydium CPMM (CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C)
  feeWallets: ['5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD'], // StonkFun transfer-fee / reward authority
}];
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) { let n = 0n; for (const x of buf) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of buf) { if (x) break; s = '1' + s; } return s; }
const u64 = (b, o) => b.readBigUInt64LE(o);

function decodeCpmm(buf) {
  let o = 8; const k = {};
  for (const n of ['ammConfig', 'poolCreator', 'vault0', 'vault1', 'lpMint', 'mint0', 'mint1', 'prog0', 'prog1', 'observation']) { k[n] = b58(buf.subarray(o, o + 32)); o += 32; }
  k.status = buf[o + 1]; k.lpDecimals = buf[o + 2]; k.dec0 = buf[o + 3]; k.dec1 = buf[o + 4]; o += 5;
  for (const n of ['lpSupply', 'protocol0', 'protocol1', 'fund0', 'fund1', 'openTime', 'recentEpoch']) { k[n] = u64(buf, o); o += 8; }
  k.creatorFeeOn = buf[o]; k.enableCreatorFee = buf[o + 1]; o += 8;
  k.creator0 = buf.length >= o + 16 ? u64(buf, o) : 0n; k.creator1 = buf.length >= o + 16 ? u64(buf, o + 8) : 0n;
  return k;
}

function createPoolWatch({ DATA_DIR, log = () => {}, intervalMs = 15 * 60e3 }) {
  const file = path.join(DATA_DIR, 'poolwatch.json');
  let state = { pools: {} };
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const rpc = rpcFor(null);
  let timer = null, running = false;

  async function lpEvents(P, st, k) {
    // Only Deposit / Withdraw / Initialize touch the LP mint, so its signature list is small.
    const sigs = await rpc.call('getSignaturesForAddress', [k.lpMint, { limit: 50 }]);
    const seen = new Set(st.seenSigs || []); const out = [];
    for (const s of sigs.reverse()) {
      if (seen.has(s.signature)) continue; seen.add(s.signature);
      if (s.err) continue;
      let tx = null; try { tx = await rpc.call('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]); } catch (e) { log('poolwatch tx: ' + e.message); seen.delete(s.signature); continue; }
      if (!tx) continue;
      const logs = tx.meta?.logMessages || [];
      const kind = logs.some((l) => /Instruction: Deposit/.test(l)) ? 'deposit' : logs.some((l) => /Instruction: Withdraw/.test(l)) ? 'withdraw' : logs.some((l) => /Initialize|MigrateToCpswap/.test(l)) ? 'initialize' : 'other';
      const signer = tx.transaction?.message?.accountKeys?.find((a) => a.signer)?.pubkey || null;
      const delta = (mint, owner) => { const f = (L) => (L || []).filter((b) => b.mint === mint && (!owner || b.owner === owner)).reduce((x, b) => x + (+b.uiTokenAmount.uiAmountString || 0), 0); return f(tx.meta.postTokenBalances) - f(tx.meta.preTokenBalances); };
      const vaultOwner = (tx.meta.postTokenBalances || []).find((b) => b.mint === k.mint0 && b.owner && b.owner !== signer)?.owner;
      out.push({ sig: s.signature, t: (s.blockTime || 0) * 1000, kind, signer, fromFeeWallet: P.feeWallets.includes(signer),
        lpDelta: delta(k.lpMint), base0: vaultOwner ? delta(k.mint0, vaultOwner) : null, quote1: vaultOwner ? delta(k.mint1, vaultOwner) : null });
    }
    st.seenSigs = [...seen].slice(-300);
    return out;
  }

  async function tick() {
    if (running) return; running = true;
    try {
      for (const P of POOLS) {
        const st = (state.pools[P.id] ||= { pool: P.pool, snaps: [], lpEvents: [] });
        try {
          const acc = await rpc.call('getAccountInfo', [P.pool, { encoding: 'base64' }]);
          if (!acc?.value || acc.value.owner !== CPMM) throw new Error('pool account missing / not CPMM');
          const k = decodeCpmm(Buffer.from(acc.value.data[0], 'base64'));
          const m = await rpc.call('getMultipleAccounts', [[k.vault0, k.vault1, k.lpMint, k.mint0], { encoding: 'jsonParsed' }]);
          const [v0, v1, lp, mint0] = m.value.map((x) => x?.data?.parsed?.info);
          const raw0 = BigInt(v0.tokenAmount.amount), raw1 = BigInt(v1.tokenAmount.amount);
          const r0 = Number(raw0 - k.protocol0 - k.fund0 - k.creator0) / 10 ** k.dec0;
          const r1 = Number(raw1 - k.protocol1 - k.fund1 - k.creator1) / 10 ** k.dec1;
          const lpSupply = Number(lp.supply) / 10 ** k.lpDecimals;
          const tf = (mint0?.extensions || []).find((e) => e.extension === 'transferFeeConfig')?.state;
          const snap = { t: Date.now(), reserve0: r0, reserve1: r1, mint0: k.mint0, mint1: k.mint1, price1per0: r0 ? r1 / r0 : null,
            sqrtK: Math.sqrt(r0 * r1), lpSupply, sqrtKPerLp: lpSupply ? Math.sqrt(r0 * r1) / lpSupply : null,
            pendingFees: { protocol0: Number(k.protocol0) / 10 ** k.dec0, protocol1: Number(k.protocol1) / 10 ** k.dec1, fund0: Number(k.fund0) / 10 ** k.dec0, fund1: Number(k.fund1) / 10 ** k.dec1, creator0: Number(k.creator0) / 10 ** k.dec0, creator1: Number(k.creator1) / 10 ** k.dec1 },
            mint0WithheldFee: tf ? Number(tf.withheldAmount) / 10 ** k.dec0 : null, transferFeeBps: tf ? tf.newerTransferFee?.transferFeeBasisPoints : null };
          const prev = st.snaps[st.snaps.length - 1];
          if (prev) { snap.lpSupplyChange = lpSupply - prev.lpSupply; snap.sqrtKPerLpChangePct = prev.sqrtKPerLp ? (snap.sqrtKPerLp / prev.sqrtKPerLp - 1) * 100 : null; }
          st.snaps.push(snap); if (st.snaps.length > 3000) st.snaps.splice(0, st.snaps.length - 3000); // ~31 days at 15 min
          st.lpMint = k.lpMint; st.vaults = [k.vault0, k.vault1];
          const ev = await lpEvents(P, st, k);
          if (ev.length) { st.lpEvents.push(...ev); if (st.lpEvents.length > 500) st.lpEvents.splice(0, st.lpEvents.length - 500); }
          st.feeToLiquidityDeposits = st.lpEvents.filter((e) => e.kind === 'deposit' && e.fromFeeWallet);
          st.lastOk = Date.now(); st.lastErr = null;
        } catch (e) { st.lastErr = String(e.message).slice(0, 200); st.lastErrAt = Date.now(); log('poolwatch ' + P.id + ': ' + e.message); }
      }
      state.updatedAt = Date.now(); state.intervalMs = intervalMs;
      state.note = 'reserves exclude pending protocol/fund/creator fees; sqrtKPerLp rising with flat LP supply = LP fee accrual; deposits = LP mint Deposit txs';
      fs.writeFileSync(file + '.tmp', JSON.stringify(state)); fs.renameSync(file + '.tmp', file);
    } finally { running = false; }
  }
  function start() { if (timer) return; setTimeout(() => tick().catch((e) => log('poolwatch: ' + e.message)), 20e3).unref?.(); timer = setInterval(() => tick().catch((e) => log('poolwatch: ' + e.message)), intervalMs); timer.unref?.(); }
  function status() { return state; }
  return { start, tick, status, POOLS };
}
module.exports = { createPoolWatch, decodeCpmm };
if (require.main === module) { // one-shot: node lib/poolwatch.js
  const pw = createPoolWatch({ DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'), log: console.error });
  pw.tick().then(() => { const s = pw.status().pools['QCAT/STRK']; console.log(JSON.stringify({ last: s.snaps.at(-1), lpEvents: s.lpEvents, err: s.lastErr }, null, 1)); });
}
