'use strict';
// On-chain history -> normalized ledger events. Free public sources only.
// Solana: JSON-RPC getSignaturesForAddress + getTransaction(jsonParsed) via lib/solrpc (public mainnet-beta by default;
//         uses SOLANA_RPC_URL, or a Helius URL only if HELIUS_API_KEY is already set in the environment). Swaps are
//         detected from the owner's pre/post SOL + token balance deltas (works for Jupiter, Raydium, Orca, pump.fun...).
// EVM:    Etherscan-compatible account API (txlist / tokentx / txlistinternal):
//         Etherscan API V2 if ETHERSCAN_API_KEY is set (free key; free tier covers Ethereum/Arbitrum/Polygon/etc,
//         NOT Base/BSC/OP since Nov 2025), else keyless Blockscout instances, else keyless Routescan (Ethereum, Avalanche).
//         When no free API serves a chain (e.g. BSC), import the explorer's "Download CSV" export instead.
const { rpcFor } = require('../solrpc');
const A = require('./assets');
const UA = { 'user-agent': 'Mozilla/5.0 (asymmetric-terminal tax desk)', accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WSOL = 'So11111111111111111111111111111111111111112';
const KNOWN_MINTS = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT', [WSOL]: 'SOL' };

function solRpc() {
  if (process.env.HELIUS_API_KEY && !process.env.SOLANA_RPC_URL) return rpcFor({ headers: { 'x-rpc-url': `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` } });
  return rpcFor({ headers: {} });
}
async function jupMeta(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 100) {
    try { const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mints.slice(i, i + 100).join(',')}`, { headers: UA, signal: AbortSignal.timeout(15000) }); const d = await r.json(); for (const t of d || []) out[t.id] = { symbol: t.symbol, name: t.name, verified: !!t.isVerified }; } catch {}
  }
  return out;
}
async function solanaHistory(addr, { max = 300, onProgress = () => {} } = {}) {
  const rpc = solRpc(); const sigs = []; let before;
  while (sigs.length < max) {
    const page = await rpc.call('getSignaturesForAddress', [addr, { limit: Math.min(1000, max - sigs.length), ...(before ? { before } : {}) }]);
    if (!page.length) break; sigs.push(...page); before = page[page.length - 1].signature; if (page.length < 1000) break;
  }
  const ok = sigs.filter((s) => !s.err);
  const raw = []; let i = 0;
  for (const s of ok) {
    i++; if (i % 10 === 0) onProgress(`fetched ${i}/${ok.length} transactions`);
    try { const tx = await rpc.call('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); if (tx) raw.push(tx); } catch (e) { if (e.rateLimited) await sleep(2000); }
  }
  const mints = new Set();
  for (const tx of raw) for (const b of [...(tx.meta?.preTokenBalances || []), ...(tx.meta?.postTokenBalances || [])]) if (b.owner === addr) mints.add(b.mint);
  const meta = await jupMeta([...mints].filter((m) => !KNOWN_MINTS[m]));
  const sym = (m) => KNOWN_MINTS[m] || meta[m]?.symbol || m.slice(0, 4) + '…' + m.slice(-4);
  const events = [];
  for (const tx of raw) {
    const e = parseSolTx(tx, addr, sym); if (e) events.push(...e);
  }
  return { events, scanned: sigs.length, failed: sigs.length - ok.length, fetched: raw.length, truncated: sigs.length >= max, rpc: rpc.label };
}
function parseSolTx(tx, addr, sym) {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const idx = keys.indexOf(addr); const m = tx.meta; if (!m) return null;
  const ts = (tx.blockTime || 0) * 1000; const sig = tx.transaction.signatures[0];
  const feePayer = keys[0] === addr; const fee = feePayer ? m.fee / 1e9 : 0;
  let sol = idx >= 0 ? (m.postBalances[idx] - m.preBalances[idx]) / 1e9 + fee : 0;
  const deltas = {}; const dec = {};
  const add = (b, sign) => { if (b.owner !== addr) return; const k = b.mint; deltas[k] = (deltas[k] || 0) + sign * (+b.uiTokenAmount.uiAmountString || 0); dec[k] = b.uiTokenAmount.decimals; };
  for (const b of m.preTokenBalances || []) add(b, -1);
  for (const b of m.postTokenBalances || []) add(b, +1);
  if (deltas[WSOL]) { sol += deltas[WSOL]; delete deltas[WSOL]; } // wrap/unwrap is not a trade
  let rent = 0;
  const tok = Object.entries(deltas).filter(([, d]) => Math.abs(d) > 1e-12);
  if (tok.length && Math.abs(sol) < 0.0025) { rent = -sol; sol = 0; } // token-account rent / tips folded into fees
  const legs = tok.map(([mint, d]) => ({ asset: sym(mint), qty: Math.abs(d), sign: Math.sign(d), chain: 'solana', address: mint }));
  if (Math.abs(sol) > 1e-9) legs.push({ asset: 'SOL', qty: Math.abs(sol), sign: Math.sign(sol), chain: 'solana', address: WSOL });
  const outs = legs.filter((l) => l.sign < 0), ins = legs.filter((l) => l.sign > 0);
  const base = { source: 'solana', account: `solana:${addr}`, ts, txid: sig };
  const feeObj = fee + Math.max(0, rent) > 0 ? { asset: 'SOL', qty: fee + Math.max(0, rent), chain: 'solana', address: WSOL } : null;
  const strip = (l) => ({ asset: l.asset, qty: l.qty, chain: l.chain, address: l.address });
  if (outs.length && ins.length) {
    // primary swap = largest out vs largest in (by qty of known-priced side is unknown here; SOL/stable preferred)
    const pick = (arr) => arr.find((l) => l.asset === 'SOL' || A.isStable(l.asset)) || arr[0];
    const o = pick(outs), i = pick(ins);
    const ev = [{ ...base, type: 'trade', out: strip(o), in: strip(i), fee: feeObj, note: 'on-chain swap' }];
    let n = 0; for (const l of [...outs, ...ins]) if (l !== o && l !== i) ev.push({ ...base, subIdx: ++n, type: l.sign < 0 ? 'transfer_out' : 'transfer_in', [l.sign < 0 ? 'out' : 'in']: strip(l), note: 'extra leg of multi-asset tx (review)' });
    return ev;
  }
  if (ins.length) return ins.map((l, k) => ({ ...base, subIdx: k, type: 'transfer_in', in: strip(l), fee: k === 0 ? feeObj : null, note: l.asset !== 'SOL' && !feePayer ? 'unsolicited token receipt (possible airdrop/spam)' : '' }));
  if (outs.length) return outs.map((l, k) => ({ ...base, subIdx: k, type: 'transfer_out', out: strip(l), fee: k === 0 ? feeObj : null }));
  if (feeObj && feePayer) return [{ ...base, type: 'fee', fee: feeObj, note: 'transaction fee only' }];
  return null;
}

// ---------------- EVM ----------------
const EVM = {
  ethereum: { id: 1, native: 'ETH', blockscout: 'https://eth.blockscout.com/api', routescan: 1 },
  base: { id: 8453, native: 'ETH', blockscout: 'https://base.blockscout.com/api', paidOnEtherscan: true },
  arbitrum: { id: 42161, native: 'ETH', blockscout: 'https://arbitrum.blockscout.com/api' },
  optimism: { id: 10, native: 'ETH', blockscout: 'https://optimism.blockscout.com/api', paidOnEtherscan: true },
  polygon: { id: 137, native: 'POL', blockscout: 'https://polygon.blockscout.com/api' },
  bsc: { id: 56, native: 'BNB', paidOnEtherscan: true },
  avalanche: { id: 43114, native: 'AVAX', routescan: 43114 },
};
function providers(chain) {
  const c = EVM[chain]; const p = [];
  if (process.env.ETHERSCAN_API_KEY && !c.paidOnEtherscan) p.push({ name: 'Etherscan API V2 (free key)', url: (q) => `https://api.etherscan.io/v2/api?chainid=${c.id}&${q}&apikey=${process.env.ETHERSCAN_API_KEY}`, gap: 400 });
  if (c.blockscout) p.push({ name: 'Blockscout (keyless)', url: (q) => `${c.blockscout}?${q}`, gap: 300 });
  if (c.routescan) p.push({ name: 'Routescan (keyless)', url: (q) => `https://api.routescan.io/v2/network/mainnet/evm/${c.routescan}/etherscan/api?${q}`, gap: 600 });
  return p;
}
async function ecall(prov, q) {
  await sleep(prov.gap);
  const r = await fetch(prov.url(q), { headers: UA, signal: AbortSignal.timeout(20000) });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { throw new Error(`${prov.name}: HTTP ${r.status} non-JSON (blocked or down)`); }
  if (j.status === '0' && !/no transactions/i.test(j.message || '') && !Array.isArray(j.result)) throw new Error(`${prov.name}: ${j.result || j.message}`);
  return Array.isArray(j.result) ? j.result : [];
}
async function evmHistory(chain, addr, { max = 2000 } = {}) {
  const c = EVM[chain]; if (!c) throw new Error('unsupported EVM chain ' + chain);
  const errors = [];
  for (const prov of providers(chain)) {
    try {
      const q = (action) => `module=account&action=${action}&address=${addr}&startblock=0&endblock=99999999&page=1&offset=${Math.min(max, 10000)}&sort=asc`;
      const [txs, toks, ints] = [await ecall(prov, q('txlist')), await ecall(prov, q('tokentx')), await ecall(prov, q('txlistinternal')).catch(() => [])];
      return { events: evmToEvents(chain, addr, c.native, txs, toks, ints), provider: prov.name, counts: { txs: txs.length, tokenTransfers: toks.length, internal: ints.length }, truncated: txs.length >= Math.min(max, 10000) };
    } catch (e) { errors.push(e.message); }
  }
  const why = c.paidOnEtherscan ? `${chain}: no keyless API reachable (Etherscan free tier excludes ${chain}${c.blockscout ? '; Blockscout blocked/unavailable from this server' : ''}).` : `${chain}: all free providers failed.`;
  throw Object.assign(new Error(`${why} ${errors.join(' | ')} Fallback: open the address on the chain explorer, use "Download CSV" for Transactions and Token Transfers, and import them here as "Explorer CSV".`), { status: 502 });
}
function evmToEvents(chain, addr, native, txs, toks, ints) {
  const o = addr.toLowerCase(); const account = `${chain}:${o}`; const by = {};
  const g = (h) => (by[h] ||= { legs: [], fee: 0, ts: 0, failed: false });
  for (const t of txs) {
    const x = g(t.hash); x.ts = +t.timeStamp * 1000;
    if (t.isError === '1' || t.txreceipt_status === '0') x.failed = true;
    if ((t.from || '').toLowerCase() === o) x.fee += (+t.gasUsed * +(t.effectiveGasPrice || t.gasPrice)) / 1e18;
    const v = +t.value / 1e18; if (!x.failed && v) x.legs.push({ asset: native, qty: v, sign: (t.from || '').toLowerCase() === o ? -1 : 1 });
  }
  for (const t of ints) { const x = g(t.hash); x.ts ||= +t.timeStamp * 1000; const v = +t.value / 1e18; if (v && t.isError !== '1') x.legs.push({ asset: native, qty: v, sign: (t.from || '').toLowerCase() === o ? -1 : 1 }); }
  for (const t of toks) {
    const x = g(t.hash); x.ts ||= +t.timeStamp * 1000; const d = +t.tokenDecimal || 0; const v = Number(BigInt(t.value || '0')) / 10 ** d; if (!v) continue;
    const f = (t.from || '').toLowerCase(), to = (t.to || '').toLowerCase(); if (f === o && to === o) continue;
    x.legs.push({ asset: A.norm(t.tokenSymbol || t.contractAddress.slice(0, 8)), qty: v, sign: f === o ? -1 : 1, chain, address: t.contractAddress });
  }
  const events = [];
  for (const [hash, x] of Object.entries(by)) {
    // net per asset
    const net = {}; for (const l of x.legs) { const k = l.address || l.asset; net[k] ||= { ...l, qty: 0 }; net[k].qty += l.sign * l.qty; }
    const legs = Object.values(net).filter((l) => Math.abs(l.qty) > 1e-15).map((l) => ({ asset: l.asset, qty: Math.abs(l.qty), sign: Math.sign(l.qty), chain: l.chain || chain, address: l.address }));
    const fee = x.fee > 0 ? { asset: native, qty: x.fee, chain } : null;
    const base = { source: 'evm:' + chain, account, ts: x.ts, txid: hash };
    const outs = legs.filter((l) => l.sign < 0), ins = legs.filter((l) => l.sign > 0); const strip = (l) => ({ asset: l.asset, qty: l.qty, chain: l.chain, address: l.address });
    if (outs.length && ins.length) { const o1 = outs[0], i1 = ins.find((l) => l.asset === native) || ins[0];
      events.push({ ...base, type: 'trade', out: strip(o1), in: strip(i1), fee, note: 'on-chain swap' });
      let n = 0; for (const l of legs) if (l !== o1 && l !== i1) events.push({ ...base, subIdx: ++n, type: l.sign < 0 ? 'transfer_out' : 'transfer_in', [l.sign < 0 ? 'out' : 'in']: strip(l), note: 'extra leg (review)' }); }
    else if (ins.length) ins.forEach((l, k) => events.push({ ...base, subIdx: k, type: 'transfer_in', in: strip(l), fee: k ? null : fee }));
    else if (outs.length) outs.forEach((l, k) => events.push({ ...base, subIdx: k, type: 'transfer_out', out: strip(l), fee: k ? null : fee }));
    else if (fee) events.push({ ...base, type: 'fee', fee, note: x.failed ? 'failed tx gas' : 'contract call (approve etc.)' });
  }
  return events.sort((a, b) => a.ts - b.ts);
}
function detectChains(addr) {
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return Object.keys(EVM);
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return ['solana'];
  return [];
}
module.exports = { solanaHistory, evmHistory, parseSolTx, evmToEvents, detectChains, EVM, providers };
