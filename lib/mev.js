'use strict';
// Sandwich detection for swaps executed through the terminal + optional read-only "audit my wallet" scan.
// Free data only: public Solana RPC getTransaction / getBlock (or the user's own RPC via x-rpc-url).
// Log persisted to data/sandwich_log.json. Everything here is heuristic: "suspected", not proof.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFor } = require('./solrpc');
const { sleep } = require('./util');

const FILE = path.join(__dirname, '..', 'data', 'sandwich_log.json');
const WSOL = 'So11111111111111111111111111111111111111112';
const QUOTE_MINTS = new Set([WSOL, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const IGNORE_SHARED = new Set(['11111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'SysvarRent111111111111111111111111111111111', WSOL]);

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { version: 1, settings: { tolerancePct: 0.5 }, trades: [], audits: {} }; } }
let DB = load();
function save() { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(DB, null, 1)); fs.renameSync(tmp, FILE); }
if (!fs.existsSync(FILE)) { try { save(); } catch {} }

// ---------- balance-delta helpers (work on getTransaction json OR getBlock 'accounts' entries) ----------
function keysOf(tx) {
  const ak = tx.transaction.accountKeys || tx.transaction.message?.accountKeys || [];
  const keys = ak.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const la = tx.meta?.loadedAddresses; if (la && keys.length < (tx.meta.preBalances || []).length) keys.push(...(la.writable || []), ...(la.readonly || []));
  return keys;
}
function writableOf(tx) {
  const ak = tx.transaction.accountKeys;
  if (ak && typeof ak[0] === 'object') return ak.filter((k) => k.writable && !k.signer).map((k) => k.pubkey);
  // json encoding: derive from header
  const m = tx.transaction.message; if (!m) return [];
  const h = m.header, n = m.accountKeys.length, out = [];
  m.accountKeys.forEach((k, i) => { const signer = i < h.numRequiredSignatures; const ro = signer ? i >= h.numRequiredSignatures - h.numReadonlySignedAccounts : i >= n - h.numReadonlyUnsignedAccounts; if (!signer && !ro) out.push(k); });
  return out.concat(tx.meta?.loadedAddresses?.writable || []);
}
const sigOf = (tx) => (tx.transaction.signatures || [])[0];
const payerOf = (tx) => keysOf(tx)[0];
// raw token deltas (BigInt) per mint for `owner`; native SOL folded into WSOL (excluding the network fee when owner paid it)
function deltas(tx, owner, { tipLamports = 0 } = {}) {
  const m = tx.meta, out = {};
  const add = (mint, v, dec) => { out[mint] = out[mint] || { raw: 0n, decimals: dec }; out[mint].raw += v; };
  for (const b of m.preTokenBalances || []) if (b.owner === owner) add(b.mint, -BigInt(b.uiTokenAmount.amount), b.uiTokenAmount.decimals);
  for (const b of m.postTokenBalances || []) if (b.owner === owner) add(b.mint, BigInt(b.uiTokenAmount.amount), b.uiTokenAmount.decimals);
  const keys = keysOf(tx), i = keys.indexOf(owner);
  if (i >= 0) {
    let lam = BigInt(m.postBalances[i] - m.preBalances[i]);
    if (i === 0) lam += BigInt(m.fee);              // fee isn't part of the trade
    lam += BigInt(tipLamports);                      // our own Jito tip isn't part of the trade price either
    // rent for token accounts the owner created in this tx (refundable) – don't count as spent on the swap
    keys.forEach((k, j) => { if (j !== i && m.preBalances[j] === 0 && m.postBalances[j] > 0 && m.postBalances[j] <= 2100000 && (m.postTokenBalances || []).some((b) => b.accountIndex === j && b.owner === owner)) lam += BigInt(m.postBalances[j]); });
    if (lam !== 0n) add(WSOL, lam, 9);
  }
  for (const k of Object.keys(out)) if (out[k].raw === 0n) delete out[k];
  return out;
}
const ui = (d) => Number(d.raw) / 10 ** d.decimals;
// classify as swap: one mint out, one mint in (ignore SOL dust under 0.00001 from fees/rent noise)
function asSwap(dl) {
  const ents = Object.entries(dl).filter(([m, d]) => !(m === WSOL && Math.abs(Number(d.raw)) < 10000));
  const neg = ents.filter(([, d]) => d.raw < 0n), pos = ents.filter(([, d]) => d.raw > 0n);
  if (neg.length !== 1 || pos.length !== 1) return null;
  return { inMint: neg[0][0], inUi: -ui(neg[0][1]), outMint: pos[0][0], outUi: ui(pos[0][1]) };
}

// ---------- bracket (front-run/back-run) check via getBlock ----------
const blockCache = new Map();
async function getBlockAccounts(rpc, slot) {
  if (blockCache.has(slot)) return blockCache.get(slot);
  const p = rpc.call('getBlock', [slot, { transactionDetails: 'accounts', maxSupportedTransactionVersion: 1, rewards: false, commitment: 'confirmed' }], { retries: 3 });
  blockCache.set(slot, p); if (blockCache.size > 30) blockCache.delete(blockCache.keys().next().value);
  try { return await p; } catch (e) { blockCache.delete(slot); throw e; }
}
// Pool-side view: owners of the non-signer writable token accounts in OUR tx (AMM vault authorities / bonding curves).
function poolOwners(tx, user) {
  const keys = keysOf(tx), w = new Set(writableOf(tx).filter((k) => !IGNORE_SHARED.has(k))), owners = new Set();
  for (const b of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) if (b.owner && b.owner !== user && w.has(keys[b.accountIndex])) owners.add(b.owner);
  return [...owners];
}
function poolDelta(tx, owners, mint) { let v = 0n, dec = mint === WSOL ? 9 : 0; for (const o of owners) { const d = deltas(tx, o)[mint]; if (d) { v += d.raw; dec = d.decimals; } } return { raw: v, decimals: dec }; }
async function bracketCheck(rpc, slot, sig, _unused, ourSwap) {
  const blk = await getBlockAccounts(rpc, slot);
  const txs = blk.transactions || [];
  const idx = txs.findIndex((t) => sigOf(t) === sig);
  if (idx < 0) return { checked: false, reason: 'tx not found in block' };
  const me = txs[idx], mePayer = payerOf(me);
  const owners = poolOwners(me, mePayer);
  const myW = new Set(writableOf(me).filter((k) => !IGNORE_SHARED.has(k)));
  const tgt = ourSwap?.outMint, q = ourSwap?.inMint;
  // candidate = successful tx by another payer that moved tokens on the same pool (not keepers/oracles that only write config accounts)
  const movesPool = (t) => !t.meta?.err && writableOf(t).some((k) => myW.has(k)) && owners.length && (poolDelta(t, owners, tgt).raw !== 0n || poolDelta(t, owners, q).raw !== 0n);
  const before = [], after = [];
  for (let i = Math.max(0, idx - 40); i < idx; i++) if (payerOf(txs[i]) !== mePayer && movesPool(txs[i])) before.push(i);
  for (let i = idx + 1; i < Math.min(txs.length, idx + 41); i++) if (payerOf(txs[i]) !== mePayer && movesPool(txs[i])) after.push(i);
  const hits = [];
  for (const i of before) for (const j of after) {
    const S = payerOf(txs[i]); if (payerOf(txs[j]) !== S) continue;
    const pf = poolDelta(txs[i], owners, tgt), pb = poolDelta(txs[j], owners, tgt);
    // classic: front run buys what we buy (pool loses tgt), back run sells it (pool gains tgt)
    const dirMatch = pf.raw < 0n && pb.raw > 0n;
    const qf = poolDelta(txs[i], owners, q), qb = poolDelta(txs[j], owners, q);
    const profit = -(Number(qf.raw + qb.raw) / 10 ** (qf.decimals || qb.decimals || 0)); // what the pool paid the attacker net, in our input token
    const tight = idx - i <= 8 && j - idx <= 8; // real sandwiches are usually adjacent (often one Jito bundle)
    hits.push({ attacker: S, frontSig: sigOf(txs[i]), backSig: sigOf(txs[j]), frontOffset: i - idx, backOffset: j - idx, directionMatch: dirMatch, tight, strong: dirMatch && tight && profit > 0, attackerProfitInInputToken: profit });
  }
  hits.sort((a, b) => (b.strong - a.strong) || (b.directionMatch - a.directionMatch) || (a.backOffset - a.frontOffset) - (b.backOffset - b.frontOffset));
  return { checked: true, slot, index: idx, blockTxs: txs.length, poolOwners: owners.length, sameSlotPoolTrades: before.length + after.length, bracketed: hits.some((h) => h.strong), weakBracket: hits.length > 0 && !hits.some((h) => h.strong), hits: hits.slice(0, 3) };
}

// ---------- trades executed through the terminal ----------
function recordSubmitted(t) {
  const trade = { id: crypto.randomBytes(6).toString('hex'), status: 'submitted', submittedAt: Date.now(), ...t };
  delete trade.rpcUrl;
  DB.trades.unshift(trade); DB.trades = DB.trades.slice(0, 2000); save();
  watch(trade.id, t.rpcUrl).catch((e) => { const x = DB.trades.find((y) => y.id === trade.id); if (x) { x.status = 'error'; x.error = e.message; save(); } });
  return trade;
}
async function watch(id, rpcUrl) {
  const rpc = rpcFor({ headers: rpcUrl ? { 'x-rpc-url': rpcUrl } : {} });
  const tr = () => DB.trades.find((x) => x.id === id);
  for (let i = 0; i < 45; i++) { // ~90s
    await sleep(2000);
    const st = await rpc.call('getSignatureStatuses', [[tr().signature], { searchTransactionHistory: false }]).catch(() => null);
    const s = st?.value?.[0];
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
      if (s.err) { Object.assign(tr(), { status: 'failed', err: s.err, slot: s.slot }); save(); return; }
      return analyzeTrade(id, rpc);
    }
  }
  Object.assign(tr(), { status: 'not-landed', note: 'not confirmed within ~90s (blockhash expired). No funds moved except possibly nothing; check Solscan.' }); save();
}
async function analyzeTrade(id, rpc) {
  const t = DB.trades.find((x) => x.id === id);
  const tx = await rpc.call('getTransaction', [t.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }], { retries: 6 });
  const q = t.quote, dl = deltas(tx, t.user, { tipLamports: t.tipLamports || 0 });
  const inD = dl[q.inputMint], outD = dl[q.outputMint];
  const filledIn = inD ? -ui(inD) : q.inUi, filledOut = outD ? ui(outD) : 0;
  const fillPrice = filledIn > 0 ? filledOut / filledIn : null;
  const shortfallPct = fillPrice ? (1 - fillPrice / q.quotedPrice) * 100 : null; // >0 = worse than quoted (quote already includes its price impact)
  const tol = DB.settings.tolerancePct;
  const lostUsd = shortfallPct > 0 && q.outUsdPrice ? (q.quotedPrice * filledIn - filledOut) * q.outUsdPrice : 0;
  let bracket = null;
  try { bracket = await bracketCheck(rpc, tx.slot, t.signature, null, { inMint: q.inputMint, outMint: q.outputMint }); } catch (e) { bracket = { checked: false, reason: e.message }; }
  Object.assign(t, {
    status: 'filled', slot: tx.slot, blockTime: tx.blockTime ? tx.blockTime * 1000 : null, feeLamports: tx.meta.fee,
    filledIn, filledOut, fillPrice, shortfallPct, tolerancePct: tol, lostUsd: Math.max(0, lostUsd || 0),
    withinSlippage: shortfallPct != null ? shortfallPct <= q.slippageBps / 100 : null,
    suspected: (shortfallPct != null && shortfallPct > tol) || !!bracket?.bracketed, bracket,
    reason: bracket?.bracketed ? 'same-slot bracket by one signer (buy before / sell after on a shared pool)' : shortfallPct > tol ? `fill ${shortfallPct.toFixed(2)}% worse than quote (> ${tol}% tolerance; quote already priced in ${(+q.priceImpactPct || 0).toFixed(2)}% impact)` : null,
  });
  save(); return t;
}
function stats() {
  const filled = DB.trades.filter((t) => t.status === 'filled');
  const sus = filled.filter((t) => t.suspected);
  const by = (r) => { const f = filled.filter((t) => t.route === r), s = f.filter((t) => t.suspected); return { trades: f.length, suspected: s.length, pct: f.length ? (s.length / f.length) * 100 : null, lostUsd: s.reduce((a, t) => a + (t.lostUsd || 0), 0) }; };
  return { totalSubmitted: DB.trades.length, filled: filled.length, suspected: sus.length, pctSuspected: filled.length ? (sus.length / filled.length) * 100 : null, lostUsd: sus.reduce((a, t) => a + (t.lostUsd || 0), 0), private: by('private'), public: by('public'), tipsPaidSol: filled.reduce((a, t) => a + (t.tipLamports || 0), 0) / 1e9 };
}
function log(q) { return { settings: DB.settings, stats: stats(), trades: DB.trades.slice(0, Math.min(500, +q?.get?.('limit') || 200)), file: 'data/sandwich_log.json' }; }
function setSettings(b) { const t = +b.tolerancePct; if (!(t >= 0.05 && t <= 20)) throw Object.assign(new Error('tolerancePct must be 0.05-20'), { status: 400 }); DB.settings.tolerancePct = t; save(); return DB.settings; }

// ---------- audit a wallet (read-only) ----------
const jobs = new Map();
function startAudit(address, limit, req) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = { id, address, status: 'running', startedAt: Date.now(), scanned: 0, swaps: [], progress: 'listing signatures' };
  jobs.set(id, job); setTimeout(() => jobs.delete(id), 3600e3).unref();
  runAudit(job, Math.min(40, Math.max(5, limit || 20)), rpcFor(req)).catch((e) => { job.status = 'error'; job.error = e.message; });
  return job;
}
async function runAudit(job, limit, rpc) {
  const sigs = await rpc.call('getSignaturesForAddress', [job.address, { limit: Math.min(100, limit * 3) }]);
  const ok = sigs.filter((s) => !s.err);
  job.totalSigs = sigs.length;
  for (const s of ok) {
    if (job.swaps.length >= limit) break;
    job.progress = `reading tx ${job.scanned + 1}/${ok.length}`;
    let tx; try { tx = await rpc.call('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]); } catch { continue; }
    job.scanned++;
    if (!tx || payerOf(tx) !== job.address) continue; // only txs this wallet signed/paid
    const sw = asSwap(deltas(tx, job.address)); if (!sw) continue;
    const row = { signature: s.signature, slot: tx.slot, time: tx.blockTime ? tx.blockTime * 1000 : null, ...sw, execPrice: sw.outUi / sw.inUi };
    job.progress = `checking block ${tx.slot} for brackets (${job.swaps.length + 1}/${limit})`;
    try { row.bracket = await bracketCheck(rpc, tx.slot, s.signature, null, sw); } catch (e) { row.bracket = { checked: false, reason: e.message.slice(0, 120) }; }
    row.suspected = !!row.bracket?.bracketed;
    job.swaps.push(row);
  }
  // $ estimate: attacker profit in the victim's input token (best available proxy for the victim's loss)
  try {
    const { tokenInfo } = require('./swaps');
    const mints = [...new Set(job.swaps.filter((x) => x.suspected).map((x) => x.inMint))];
    const px = mints.length ? await tokenInfo(mints) : {};
    for (const r of job.swaps) if (r.suspected) { const h = r.bracket.hits.find((x) => x.strong); const p = px[r.inMint]?.usdPrice; r.estLostUsd = h?.attackerProfitInInputToken > 0 && p ? h.attackerProfitInInputToken * p : null; }
  } catch {}
  const sus = job.swaps.filter((x) => x.suspected);
  job.summary = { swapsFound: job.swaps.length, suspected: sus.length, weak: job.swaps.filter((x) => x.bracket?.weakBracket).length, pct: job.swaps.length ? (sus.length / job.swaps.length) * 100 : null, estLostUsd: sus.reduce((a, x) => a + (x.estLostUsd || 0), 0), blocksChecked: job.swaps.filter((x) => x.bracket?.checked).length };
  job.status = 'done'; job.progress = 'done'; job.finishedAt = Date.now();
  DB.audits[job.address] = { at: job.finishedAt, summary: job.summary, swaps: job.swaps.slice(0, 40) };
  const ks = Object.keys(DB.audits); if (ks.length > 50) delete DB.audits[ks[0]];
  save();
}
function getAudit(id) { const j = jobs.get(id); if (!j) throw Object.assign(new Error('audit job not found (expired?)'), { status: 404 }); return j; }

module.exports = { recordSubmitted, analyzeTrade, log, stats, setSettings, startAudit, getAudit, deltas, asSwap, bracketCheck, audits: () => DB.audits };
