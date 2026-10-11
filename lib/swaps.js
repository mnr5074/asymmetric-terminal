'use strict';
// Wallet-approved swaps (Solana via Phantom). NO PRIVATE KEYS EVER TOUCH THIS SERVER.
// Flow: quote (Jupiter lite-api, optionally Raydium trade API) -> build unsigned tx server-side ->
// the browser asks Phantom to *signTransaction* (not signAndSend) -> the signed bytes come back here ->
// we submit via a private route (Jito Block Engine, default) or the public RPC -> after confirmation
// lib/mev.js compares the fill with the quote and logs suspected sandwiches.
// The server never signs, never trades on its own and never retries a user's trade on a different route.
const crypto = require('crypto');
const { getJSON, postJSON, cached } = require('./util');
const { rpcFor } = require('./solrpc');

const JUP = process.env.JUP_API || 'https://lite-api.jup.ag/swap/v1';           // free, keyless (rate-limited)
const JUP_PRICE = 'https://lite-api.jup.ag/price/v3';
const RAY = 'https://transaction-v1.raydium.io';
const JITO = process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf'; // regional: ny./amsterdam./frankfurt./tokyo./slc.mainnet.block-engine.jito.wtf
const JITO_TIP_FLOOR = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';
const WSOL = 'So11111111111111111111111111111111111111112';
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const JUP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
// Static fallback list (Jito docs); live list is fetched via getTipAccounts.
const JITO_TIP_ACCOUNTS = ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', 'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt', 'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'];

const DEFAULTS = {
  slippageBps: 50,            // 0.5% hard cap the tx enforces (minOut); dynamic slippage may tighten/loosen within Jupiter's estimate
  dynamicSlippage: true,      // Jupiter estimates slippage from a simulation (Metis v1 flag; still accepted)
  route: 'private',           // private = Jito Block Engine (bundleOnly). public = normal RPC sendTransaction
  tipLamports: 100000,        // 0.0001 SOL Jito tip (private route only). Live p50 landed tip is usually far lower.
  minTipLamports: 1000,       // Jito minimum for bundleOnly
  maxTipLamports: 5000000,    // 0.005 SOL sanity cap (UI blocks above this)
  priorityLevel: 'high',      // public route: Jupiter priority-fee estimate level
  maxPriorityLamports: 200000,// public route: cap 0.0002 SOL
  sandwichTolerancePct: 0.5,  // fill worse than quote by more than this (beyond quoted price impact) => suspected sandwich
};

// ---------------- base58 / tx wire format (no deps) ----------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58enc(b) { let n = 0n; for (const x of b) n = (n << 8n) + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x === 0) s = '1' + s; else break; } return s; }
function b58dec(s) { let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); } const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } for (const c of s) { if (c === '1') out.unshift(0); else break; } return Buffer.from(out); }
const isAddr = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && (() => { try { return b58dec(s).length === 32; } catch { return false; } })();
function rdCU16(b, o) { let v = 0, s = 0, x; do { x = b[o++]; v |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return [v, o]; }
function cu16(n) { const out = []; do { let x = n & 0x7f; n >>= 7; if (n) x |= 0x80; out.push(x); } while (n); return Buffer.from(out); }

// Parse a serialized legacy / v0 transaction into a human-checkable summary.
function parseTx(buf) {
  let [nsig, o] = rdCU16(buf, 0);
  const sigs = []; for (let i = 0; i < nsig; i++) { sigs.push(buf.subarray(o, o + 64)); o += 64; }
  const msgStart = o;
  let version = 'legacy';
  if (buf[o] & 0x80) { version = buf[o] & 0x7f; o++; }
  if (version !== 'legacy' && version !== 0) return { version, unsupported: true, message: buf.subarray(msgStart), sigs };
  const header = { numRequiredSignatures: buf[o], numReadonlySigned: buf[o + 1], numReadonlyUnsigned: buf[o + 2] }; o += 3;
  let nk; [nk, o] = rdCU16(buf, o);
  const keys = []; for (let i = 0; i < nk; i++) { keys.push(b58enc(buf.subarray(o, o + 32))); o += 32; }
  const blockhash = b58enc(buf.subarray(o, o + 32)); o += 32;
  let ni; [ni, o] = rdCU16(buf, o);
  const ixs = [];
  for (let i = 0; i < ni; i++) {
    const p = buf[o++]; let na; [na, o] = rdCU16(buf, o); const acc = [...buf.subarray(o, o + na)]; o += na;
    let dl; [dl, o] = rdCU16(buf, o); const data = buf.subarray(o, o + dl); o += dl;
    ixs.push({ programIndex: p, program: keys[p] || `lookup#${p}`, accounts: acc, data });
  }
  const lookups = [];
  if (version === 0) { let nl; [nl, o] = rdCU16(buf, o); for (let i = 0; i < nl; i++) { const key = b58enc(buf.subarray(o, o + 32)); o += 32; let w; [w, o] = rdCU16(buf, o); o += w; let r; [r, o] = rdCU16(buf, o); o += r; lookups.push(key); } }
  return { version, header, keys, blockhash, ixs, lookups, sigs, message: buf.subarray(msgStart), feePayer: keys[0] };
}
function summarizeTx(buf, tipAccounts) {
  const t = parseTx(buf);
  if (t.unsupported) return { version: t.version, unsupported: true };
  let cuLimit = null, cuPrice = null, tipLamports = 0, tipTo = null, transfers = [];
  for (const ix of t.ixs) {
    if (ix.program === COMPUTE_BUDGET) {
      if (ix.data[0] === 2) cuLimit = ix.data.readUInt32LE(1);
      if (ix.data[0] === 3) cuPrice = Number(ix.data.readBigUInt64LE(1));
    }
    if (ix.program === SYSTEM && ix.data.length >= 12 && ix.data.readUInt32LE(0) === 2) {
      const to = t.keys[ix.accounts[1]], lam = Number(ix.data.readBigUInt64LE(4));
      transfers.push({ to, lamports: lam });
      if (tipAccounts.includes(to)) { tipLamports += lam; tipTo = to; }
    }
  }
  const sigCount = t.header.numRequiredSignatures;
  const priorityLamports = cuLimit && cuPrice ? Math.ceil((cuLimit * cuPrice) / 1e6) : cuPrice ? Math.ceil((200000 * cuPrice) / 1e6) : 0;
  return {
    version: t.version, feePayer: t.feePayer, signaturesRequired: sigCount, signers: t.keys.slice(0, sigCount), blockhash: t.blockhash,
    programs: [...new Set(t.ixs.map((i) => i.program))], instructionCount: t.ixs.length, addressLookupTables: t.lookups.length,
    computeUnitLimit: cuLimit, computeUnitPriceMicroLamports: cuPrice, baseFeeLamports: 5000 * sigCount, priorityFeeLamports: priorityLamports,
    jitoTipLamports: tipLamports, jitoTipAccount: tipTo, systemTransfers: transfers, sizeBytes: buf.length,
  };
}
// Minimal legacy tx: one System transfer payer -> Jito tip account (used to tip a bundle when the swap tx itself has no tip, e.g. Raydium route).
function buildTipTx(payer, tipAccount, lamports, blockhash) {
  const data = Buffer.alloc(12); data.writeUInt32LE(2, 0); data.writeBigUInt64LE(BigInt(lamports), 4);
  const msg = Buffer.concat([Buffer.from([1, 0, 1]), cu16(3), b58dec(payer), b58dec(tipAccount), b58dec(SYSTEM), b58dec(blockhash), cu16(1), Buffer.from([2]), cu16(2), Buffer.from([0, 1]), cu16(data.length), data]);
  return Buffer.concat([cu16(1), Buffer.alloc(64), msg]);
}

// ---------------- market data helpers ----------------
async function tipAccounts() {
  return cached('jito:tipaccts', 3600e3, async () => {
    try { const j = await postJSON(`${JITO}/api/v1/getTipAccounts`, { jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }, 8000); if (Array.isArray(j.result) && j.result.length) return j.result; } catch {}
    return JITO_TIP_ACCOUNTS;
  });
}
async function tipFloor() {
  return cached('jito:tipfloor', 60e3, async () => { try { const j = await getJSON(JITO_TIP_FLOOR, {}, 8000); const r = j[0] || {}; const L = (x) => (x == null ? null : Math.round(x * 1e9)); return { p25: L(r.landed_tips_25th_percentile), p50: L(r.landed_tips_50th_percentile), p75: L(r.landed_tips_75th_percentile), p95: L(r.landed_tips_95th_percentile), p99: L(r.landed_tips_99th_percentile), emaP50: L(r.ema_landed_tips_50th_percentile), time: r.time }; } catch (e) { return { error: e.message }; } });
}
async function tokenInfo(mints) {
  const ids = [...new Set(mints)].filter(Boolean);
  const key = 'jup:px:' + ids.sort().join(',');
  return cached(key, 20e3, async () => { try { return await getJSON(`${JUP_PRICE}?ids=${ids.join(',')}`, {}, 8000); } catch { return {}; } });
}
async function decimalsOf(mint, req) {
  if (mint === WSOL) return 9;
  return cached('dec:' + mint, 86400e3, async () => {
    const p = await tokenInfo([mint]); if (p[mint]?.decimals != null) return p[mint].decimals;
    const r = await rpcFor(req).call('getTokenSupply', [mint]); return r.value.decimals;
  });
}

// ---------------- state ----------------
const builds = new Map(); // buildId -> build record (unsigned txs + quote snapshot), 3 min TTL
setInterval(() => { const n = Date.now(); for (const [k, v] of builds) if (n - v.createdAt > 180e3) builds.delete(k); }, 60e3).unref();
const quotes = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of quotes) if (n - v.at > 120e3) quotes.delete(k); }, 60e3).unref();

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }
function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > max) { reject(bad('body too large', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(bad('invalid JSON')); } });
    req.on('error', reject);
  });
}

// ---------------- quote ----------------
async function quote(q, req) {
  const inputMint = q.inputMint, outputMint = q.outputMint;
  if (!isAddr(inputMint) || !isAddr(outputMint) || inputMint === outputMint) throw bad('inputMint/outputMint must be two different Solana mint addresses');
  const inDec = await decimalsOf(inputMint, req), outDec = await decimalsOf(outputMint, req);
  let amount = q.amount != null ? String(q.amount) : null;            // raw units
  if (!amount && q.uiAmount != null) amount = BigInt(Math.round(+q.uiAmount * 10 ** inDec)).toString();
  if (!/^\d+$/.test(amount || '') || BigInt(amount) <= 0n) throw bad('amount (raw) or uiAmount required');
  const slippageBps = Math.min(5000, Math.max(1, +q.slippageBps || DEFAULTS.slippageBps));
  const source = q.source === 'raydium' ? 'raydium' : 'jupiter';
  let raw, outAmount, minOut, priceImpactPct, routeLabel, contextSlot;
  if (source === 'jupiter') {
    const u = `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
    raw = await getJSON(u, {}, 12000);
    if (raw.error) throw bad('Jupiter: ' + raw.error, 502);
    outAmount = raw.outAmount; minOut = raw.otherAmountThreshold; priceImpactPct = +raw.priceImpactPct * 100;
    routeLabel = (raw.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean).join(' → '); contextSlot = raw.contextSlot;
  } else {
    raw = await getJSON(`${RAY}/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&txVersion=V0`, {}, 12000);
    if (!raw.success) throw bad('Raydium: ' + (raw.msg || 'no route'), 502);
    const d = raw.data; outAmount = d.outputAmount; minOut = d.otherAmountThreshold; priceImpactPct = +d.priceImpactPct;
    routeLabel = 'Raydium ' + (d.routePlan || []).map((r) => r.poolId?.slice(0, 4)).join(' → '); contextSlot = null;
  }
  const px = await tokenInfo([inputMint, outputMint]);
  const inUi = Number(amount) / 10 ** inDec, outUi = Number(outAmount) / 10 ** outDec, minUi = Number(minOut) / 10 ** outDec;
  const inUsd = px[inputMint]?.usdPrice != null ? inUi * px[inputMint].usdPrice : null;
  const outUsd = px[outputMint]?.usdPrice != null ? outUi * px[outputMint].usdPrice : null;
  const id = crypto.randomBytes(9).toString('base64url');
  const summary = {
    quoteId: id, source, inputMint, outputMint, inDecimals: inDec, outDecimals: outDec, inAmount: amount, outAmount: String(outAmount), minOutAmount: String(minOut),
    inUi, outUi, minOutUi: minUi, quotedPrice: outUi / inUi /* output per 1 input */, slippageBps, priceImpactPct, route: routeLabel, contextSlot,
    inUsd, outUsd, inUsdPrice: px[inputMint]?.usdPrice ?? null, outUsdPrice: px[outputMint]?.usdPrice ?? null, at: Date.now(),
  };
  quotes.set(id, { ...summary, raw });
  return summary;
}

// ---------------- build (unsigned) ----------------
async function build(body, req) {
  const qt = quotes.get(body.quoteId); if (!qt) throw bad('quote expired, request a new quote');
  const user = body.userPublicKey; if (!isAddr(user)) throw bad('userPublicKey (your wallet address) required');
  const route = body.route === 'public' ? 'public' : 'private';
  const tipLamports = route === 'private' ? Math.round(+body.tipLamports || DEFAULTS.tipLamports) : 0;
  if (route === 'private' && (tipLamports < DEFAULTS.minTipLamports || tipLamports > DEFAULTS.maxTipLamports)) throw bad(`Jito tip must be between ${DEFAULTS.minTipLamports} and ${DEFAULTS.maxTipLamports} lamports`);
  const dynamicSlippage = body.dynamicSlippage !== false;
  const tips = await tipAccounts();
  let txs = [], lastValidBlockHeight = null, dynamicSlippageReport = null, submitMode;
  if (qt.source === 'jupiter') {
    const prio = route === 'private'
      ? { jitoTipLamports: tipLamports } // Jupiter inserts a transfer to a Jito tip account inside the swap tx
      : { priorityLevelWithMaxLamports: { priorityLevel: ['medium', 'high', 'veryHigh'].includes(body.priorityLevel) ? body.priorityLevel : DEFAULTS.priorityLevel, maxLamports: Math.min(5e6, Math.max(0, +body.maxPriorityLamports || DEFAULTS.maxPriorityLamports)) } };
    const r = await postJSON(`${JUP}/swap`, { userPublicKey: user, quoteResponse: qt.raw, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, dynamicSlippage, prioritizationFeeLamports: prio }, 20000);
    if (r.error || !r.swapTransaction) throw bad('Jupiter /swap: ' + (r.error || JSON.stringify(r).slice(0, 200)), 502);
    txs = [r.swapTransaction]; lastValidBlockHeight = r.lastValidBlockHeight; dynamicSlippageReport = r.dynamicSlippageReport || null;
    submitMode = route === 'private' ? 'jito-transaction-bundleOnly' : 'rpc';
  } else {
    const cu = route === 'public' ? Math.round(((+body.maxPriorityLamports || DEFAULTS.maxPriorityLamports) * 1e6) / 400000) : 1000;
    const r = await postJSON(`${RAY}/transaction/swap-base-in`, { computeUnitPriceMicroLamports: String(cu), swapResponse: qt.raw, txVersion: 'V0', wallet: user, wrapSol: qt.inputMint === WSOL, unwrapSol: qt.outputMint === WSOL }, 20000);
    if (!r.success || !r.data?.length) throw bad('Raydium build: ' + (r.msg || 'failed'), 502);
    txs = r.data.map((x) => x.transaction);
    if (route === 'private') {
      if (txs.length > 4) throw bad('Raydium returned too many transactions for a Jito bundle');
      const bh = parseTx(Buffer.from(txs[0], 'base64')).blockhash;
      const tipAcct = tips[Math.floor(Math.random() * tips.length)];
      txs.push(buildTipTx(user, tipAcct, tipLamports, bh).toString('base64')); // separate tip tx => wallet signs 2 txs; bundle is atomic
      submitMode = 'jito-bundle';
    } else submitMode = 'rpc';
  }
  const summaries = txs.map((b) => summarizeTx(Buffer.from(b, 'base64'), tips));
  for (const s of summaries) if (s.feePayer && s.feePayer !== user) throw bad('built transaction fee payer does not match your wallet; refusing');
  const fees = summaries.reduce((a, s) => ({ base: a.base + (s.baseFeeLamports || 0), prio: a.prio + (s.priorityFeeLamports || 0), tip: a.tip + (s.jitoTipLamports || 0) }), { base: 0, prio: 0, tip: 0 });
  // Simulation (sigVerify off, fresh blockhash): proves the tx is well-formed. Fails with an insufficient-funds style error for wallets that can't afford it; harmless.
  let simulation = null;
  if (body.simulate !== false) {
    try {
      const s = await rpcFor(req).call('simulateTransaction', [txs[0], { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }], { retries: 1 });
      simulation = { err: s.value.err, unitsConsumed: s.value.unitsConsumed, logsTail: (s.value.logs || []).slice(-4) };
    } catch (e) { simulation = { error: e.message }; }
  }
  const id = crypto.randomBytes(12).toString('base64url');
  const solUsd = (await tokenInfo([WSOL]))[WSOL]?.usdPrice ?? null;
  const costs = {
    networkBaseFeeLamports: fees.base, priorityFeeLamports: fees.prio, jitoTipLamports: fees.tip,
    totalLamports: fees.base + fees.prio + fees.tip, totalSol: (fees.base + fees.prio + fees.tip) / 1e9,
    totalUsd: solUsd ? ((fees.base + fees.prio + fees.tip) / 1e9) * solUsd : null, solUsd,
    note: 'Paid by YOUR wallet only if you sign and the tx lands. The terminal charges nothing and adds no platform fee. A new token account may also need ~0.00204 SOL refundable rent.',
  };
  const rec = { buildId: id, createdAt: Date.now(), user, route, submitMode, tipLamports: fees.tip, txs, quote: Object.fromEntries(Object.entries(qt).filter(([k]) => k !== 'raw')), routePlanAmms: (qt.raw.routePlan || []).map((r) => r.swapInfo?.ammKey || r.poolId).filter(Boolean), lastValidBlockHeight, dynamicSlippageReport };
  builds.set(id, rec);
  return { buildId: id, route, submitMode, transactions: txs, txSummaries: summaries, costs, lastValidBlockHeight, dynamicSlippageReport, simulation, quote: rec.quote, expiresInSec: 90, signWith: 'Phantom signTransaction (wallet-standard solana:signTransaction). You approve in Phantom; nothing is sent until you sign.' };
}

// ---------------- submit (signed by the wallet) ----------------
function sameMessage(unsignedB64, signedB64) {
  const a = parseTx(Buffer.from(unsignedB64, 'base64')), b = parseTx(Buffer.from(signedB64, 'base64'));
  return { identical: Buffer.compare(a.message, b.message) === 0, a, b };
}
async function submit(body, req, mev) {
  const rec = builds.get(body.buildId); if (!rec) throw bad('build expired (blockhash ~60-90s). Re-quote.');
  if (rec.submitted) throw bad('already submitted');
  const signed = body.signedTransactions; if (!Array.isArray(signed) || signed.length !== rec.txs.length) throw bad('signedTransactions must match the built transactions');
  const checks = signed.map((s, i) => {
    const { identical, b } = sameMessage(rec.txs[i], s);
    if (b.unsupported) throw bad('unsupported tx version');
    if (b.feePayer !== rec.user) throw bad('signed tx fee payer is not the wallet the quote was built for');
    if (b.sigs[0].every((x) => x === 0)) throw bad('transaction is not signed');
    return { identical, walletModified: !identical };
  });
  rec.submitted = true;
  const sig = b58enc(parseTx(Buffer.from(signed[0], 'base64')).sigs[0]);
  let result;
  try {
    if (rec.submitMode === 'jito-transaction-bundleOnly') {
      const j = await postJSON(`${JITO}/api/v1/transactions?bundleOnly=true`, { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [signed[0], { encoding: 'base64' }] }, 15000);
      if (j.error) throw new Error('Jito: ' + (j.error.message || JSON.stringify(j.error)));
      result = { via: `Jito Block Engine (${new URL(JITO).host}) sendTransaction bundleOnly=true`, signature: j.result || sig };
    } else if (rec.submitMode === 'jito-bundle') {
      const j = await postJSON(`${JITO}/api/v1/bundles`, { jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [signed, { encoding: 'base64' }] }, 15000);
      if (j.error) throw new Error('Jito: ' + (j.error.message || JSON.stringify(j.error)));
      result = { via: `Jito Block Engine (${new URL(JITO).host}) sendBundle`, bundleId: j.result, signature: sig };
    } else {
      const r = await rpcFor(req).call('sendTransaction', [signed[0], { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }], { retries: 1 });
      result = { via: 'public RPC sendTransaction (' + rpcFor(req).label + ')', signature: r || sig };
    }
  } catch (e) { rec.submitted = false; throw bad(e.message + ' (nothing landed; re-quote to try again)', 502); }
  const trade = mev.recordSubmitted({ signature: result.signature, bundleId: result.bundleId, via: result.via, route: rec.route, submitMode: rec.submitMode, user: rec.user, quote: rec.quote, tipLamports: rec.tipLamports, routePlanAmms: rec.routePlanAmms, walletModified: checks.some((c) => c.walletModified), lastValidBlockHeight: rec.lastValidBlockHeight, rpcUrl: req.headers['x-rpc-url'] || null });
  return { ...result, walletModifiedTx: checks.some((c) => c.walletModified), tradeId: trade.id, solscan: 'https://solscan.io/tx/' + result.signature };
}

async function config() {
  const [tips, floor] = await Promise.all([tipAccounts(), tipFloor()]);
  return {
    defaults: DEFAULTS, jito: { blockEngine: JITO, tipAccounts: tips, tipFloorLamports: floor },
    routes: {
      private: 'Jito Block Engine: Jupiter route -> single tx with embedded tip sent via /api/v1/transactions?bundleOnly=true (only Jito-Solana leaders see it, never broadcast to the public gossip/TPU path). Raydium route -> /api/v1/bundles [swap, tip tx], atomic.',
      public: 'Your RPC (public mainnet-beta unless you set one in ⚙ RPC) sendTransaction. Any leader/RPC on the path sees it; higher sandwich risk on thin pools.',
      alternatives: [
        'Helius Sender (sender.helius-rpc.com/fast, free/keyless 1 rps): needs BOTH a tip to a Helius tip account (min 0.000005 SOL SWQOS-only, 0.001 SOL Sender Max) AND a priority fee, so it needs Jupiter /swap-instructions (not wired). Has ?mev-protect=true to avoid validators linked to sandwiching.',
        'Jupiter Ultra (api.jup.ag/ultra) has its own MEV-protected landing ("Beam") but signs via its own /execute endpoint; not used so we keep control of submission.',
        'Regional Jito engines (lower latency): ny./amsterdam./frankfurt./tokyo./slc.mainnet.block-engine.jito.wtf via JITO_BLOCK_ENGINE_URL.',
      ],
    },
    evm: {
      note: 'EVM (Rabby): switch Rabby\'s network RPC to a private mempool endpoint before swapping in the official DEX UI. Free, no account: ',
      endpoints: [
        { name: 'Flashbots Protect', chainId: 1, rpcUrl: 'https://rpc.flashbots.net/fast', info: 'https://docs.flashbots.net/flashbots-protect/overview' },
        { name: 'MEV Blocker', chainId: 1, rpcUrl: 'https://rpc.mevblocker.io', info: 'https://mevblocker.io (rebates backrun value to you)' },
        { name: 'MEV Blocker (no-revert)', chainId: 1, rpcUrl: 'https://rpc.mevblocker.io/noreverts', info: 'failed txs never land => no gas on reverts' },
      ],
      l2: 'Base/Arbitrum/Optimism use a centralized sequencer with a private mempool (no public sandwiching); BSC: use the wallet\'s default private-RPC (e.g. 48 Club / bloXroute) if offered.',
    },
    guarantees: ['No private keys on the server or in this page', 'Never auto-trades: every swap requires your signature in Phantom', 'Server rejects signed txs whose fee payer differs from the quoted wallet', 'No platform fee'],
  };
}

module.exports = { quote, build, submit, config, readBody, parseTx, summarizeTx, b58enc, b58dec, isAddr, tipAccounts, DEFAULTS, WSOL, JUP_PROGRAM, tokenInfo, decimalsOf };
