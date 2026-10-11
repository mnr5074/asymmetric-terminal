'use strict';
// Price-impact ladder: quote the same pair at several sizes and show how the execution price degrades with size.
// Solana: Jupiter lite-api (or Raydium) via lib/swaps.quote. EVM: ParaSwap /prices (keyless) with KyberSwap (keyless) fallback.
// 0x and 1inch need API keys (checked 2026-10-11: "No API key found" / "Unauthorized"); Odos returned a Cloudflare block.
// impact(size) = max(source-reported impact, 1 - price(size)/price(smallest size)). Read-only, nothing is built or signed.
const { getJSON, postJSON, cached } = require('./util');
const chains = require('./chains');
const swaps = require('./swaps');

const USD_LADDER = [50, 250, 1000, 5000, 25000, 100000, 500000, 2500000];
const PCT_LADDER = [0.01, 0.05, 0.1, 0.25, 0.5, 1];
const THRESHOLDS = [1, 2, 5];
const PARASWAP_NET = { ethereum: 1, bsc: 56, polygon: 137, arbitrum: 42161, optimism: 10, base: 8453, avalanche: 43114 };
const KYBER_CHAIN = { ethereum: 'ethereum', bsc: 'bsc', polygon: 'polygon', arbitrum: 'arbitrum', optimism: 'optimism', base: 'base', avalanche: 'avalanche', blast: 'blast' };
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (e) => /HTTP (429|5\d\d)|timeout|fetch failed/i.test(e.message || '');
// free quote APIs rate-limit bursts: pace calls and retry transient errors
async function paced(fn) { let d = 1200; for (let i = 0; ; i++) { try { const r = await fn(); await sleep(300); return r; } catch (e) { if (i < 3 && transient(e)) { await sleep(d); d *= 2; continue; } throw e; } } }

function maxUnder(points, t) {
  // points sorted by usd; impact roughly increasing. Log-linear interpolation at the first crossing.
  const p = points.filter((x) => x.impactPct != null && x.usd > 0);
  if (!p.length) return { usd: null, note: 'no quotes' };
  if (p[0].impactPct > t) return { usd: null, below: p[0].usd, note: `already > ${t}% at the smallest size tested` };
  for (let i = 1; i < p.length; i++) if (p[i].impactPct > t) {
    const a = p[i - 1], b = p[i]; const f = (t - a.impactPct) / (b.impactPct - a.impactPct || 1e-9);
    return { usd: Math.exp(Math.log(a.usd) + f * (Math.log(b.usd) - Math.log(a.usd))), between: [a.usd, b.usd] };
  }
  return { usd: p[p.length - 1].usd, atLeast: true, note: `stays under ${t}% up to the largest size tested` };
}
function finish(points, intendedUsd, threshold) {
  points.sort((a, b) => a.usd - b.usd);
  const ref = points.find((x) => x.price > 0);
  for (const x of points) { const drop = ref && x.price ? (1 - x.price / ref.price) * 100 : null; x.dropVsSmallestPct = drop; x.impactPct = Math.max(0, x.reportedImpactPct ?? 0, drop ?? 0); }
  const maxSize = Object.fromEntries(THRESHOLDS.map((t) => [t + '%', maxUnder(points, t)]));
  const atIntended = intendedUsd ? points.filter((x) => x.kind === 'pct').find((x) => Math.abs(x.fraction - 1) < 1e-9) : null;
  return { points, maxSize, threshold, intended: atIntended ? { usd: atIntended.usd, impactPct: atIntended.impactPct, overThreshold: atIntended.impactPct > threshold } : null,
    explain: 'Each row is a fresh quote for that size. Impact = how much worse the price gets versus the mid/smallest quote. "Max size under X%" is interpolated between the two ladder sizes around the crossing. Bigger than ~2% usually means the pool is thin for your size: split the order or accept the cost knowingly.' };
}

async function solLadder(q, req) {
  const { inputMint, outputMint } = q; const source = q.source === 'raydium' ? 'raydium' : 'jupiter';
  if (!swaps.isAddr(inputMint) || !swaps.isAddr(outputMint)) throw bad('inputMint/outputMint required');
  const px = (await swaps.tokenInfo([inputMint]))[inputMint]?.usdPrice; if (!px) throw bad('no USD price for the input token (cannot build a $ ladder)', 502);
  const intendedUi = +q.uiAmount || 0, intendedUsd = intendedUi ? intendedUi * px : null;
  const sizes = USD_LADDER.map((u) => ({ kind: 'usd', usd: u, ui: u / px }));
  if (intendedUi) for (const f of PCT_LADDER) sizes.push({ kind: 'pct', fraction: f, usd: intendedUsd * f, ui: intendedUi * f });
  sizes.sort((a, b) => a.usd - b.usd);
  const points = []; let stopAbove = Infinity;
  for (const s of sizes) {
    if (s.usd > stopAbove && s.kind === 'usd') continue; // stop the $ ladder once impact > 8% (saves free-API calls)
    try {
      const r = await paced(() => swaps.quote({ inputMint, outputMint, uiAmount: s.ui, slippageBps: 100, source }, req));
      const pt = { ...s, inUi: r.inUi, outUi: r.outUi, price: r.quotedPrice, reportedImpactPct: +r.priceImpactPct || 0, route: r.route };
      points.push(pt); if (pt.reportedImpactPct > 8) stopAbove = Math.min(stopAbove, s.usd);
    } catch (e) { points.push({ ...s, error: e.message.slice(0, 120) }); if (s.kind === 'usd' && !transient(e)) stopAbove = Math.min(stopAbove, s.usd); }
  }
  const ok = points.filter((p) => !p.error);
  return { chain: 'solana', source, inputMint, outputMint, inputUsdPrice: px, intendedUsd, ...finish(ok, intendedUsd, +q.threshold || 2), errors: points.filter((p) => p.error).map((p) => ({ usd: p.usd, error: p.error })) };
}

async function evmCall(chain, to, data) { const j = await postJSON(chains.CHAINS[chain].rpc, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }, 15000); if (j.error) throw new Error(j.error.message); return j.result; }
async function decimals(chain, token) { if (token.toLowerCase() === NATIVE.toLowerCase()) return 18; return cached(`dec:${chain}:${token.toLowerCase()}`, 86400e3, async () => parseInt(await evmCall(chain, token, '0x313ce567'), 16)); }
async function evmQuote(chain, tIn, tOut, dIn, dOut, raw) {
  const net = PARASWAP_NET[chain];
  if (net) {
    try {
      const j = await getJSON(`https://api.paraswap.io/prices?srcToken=${tIn}&destToken=${tOut}&amount=${raw}&srcDecimals=${dIn}&destDecimals=${dOut}&side=SELL&network=${net}&version=6.2`, {}, 15000);
      const r = j.priceRoute; if (r) return { src: 'paraswap', inUsd: +r.srcUSD, outUsd: +r.destUSD, outRaw: r.destAmount, gasUsd: +r.gasCostUSD };
    } catch {}
  }
  const k = KYBER_CHAIN[chain]; if (!k) throw new Error('no keyless EVM quote source for ' + chain);
  const j = await getJSON(`https://aggregator-api.kyberswap.com/${k}/api/v1/routes?tokenIn=${tIn}&tokenOut=${tOut}&amountIn=${raw}`, { 'x-client-id': 'asymmetric-terminal' }, 15000);
  const r = j.data?.routeSummary; if (!r) throw new Error('kyber: ' + (j.message || 'no route'));
  return { src: 'kyberswap', inUsd: +r.amountInUsd, outUsd: +r.amountOutUsd, outRaw: r.amountOut, gasUsd: +r.gasUsd };
}
async function evmLadder(q) {
  const chain = q.chain; if (!chains.CHAINS[chain] || chains.CHAINS[chain].kind !== 'evm') throw bad('chain must be an EVM chain');
  const tIn = q.tokenIn, tOut = q.tokenOut; if (!/^0x[0-9a-fA-F]{40}$/.test(tIn || '') || !/^0x[0-9a-fA-F]{40}$/.test(tOut || '')) throw bad('tokenIn/tokenOut (0x… addresses; native = 0xEeee…EEeE) required');
  const [dIn, dOut] = await Promise.all([decimals(chain, tIn), decimals(chain, tOut)]);
  const probe = await evmQuote(chain, tIn, tOut, dIn, dOut, (10n ** BigInt(dIn)).toString());
  const px = probe.inUsd; if (!(px > 0)) throw bad('no USD price for tokenIn', 502);
  const intendedUi = +q.uiAmount || 0, intendedUsd = intendedUi ? intendedUi * px : null;
  const sizes = USD_LADDER.slice(0, 7).map((u) => ({ kind: 'usd', usd: u, ui: u / px }));
  if (intendedUi) for (const f of PCT_LADDER) sizes.push({ kind: 'pct', fraction: f, usd: intendedUsd * f, ui: intendedUi * f });
  sizes.sort((a, b) => a.usd - b.usd);
  const points = []; let stop = Infinity;
  for (const s of sizes) {
    if (s.usd > stop && s.kind === 'usd') continue;
    const raw = BigInt(Math.floor(s.ui * 10 ** Math.min(dIn, 15))) * 10n ** BigInt(Math.max(0, dIn - 15));
    try { const r = await paced(() => evmQuote(chain, tIn, tOut, dIn, dOut, raw.toString())); const outUi = Number(r.outRaw) / 10 ** dOut; const pt = { ...s, inUi: s.ui, outUi, price: outUi / s.ui, reportedImpactPct: r.inUsd > 0 && r.outUsd > 0 ? Math.max(0, (1 - r.outUsd / r.inUsd) * 100) : null, src: r.src, gasUsd: r.gasUsd }; points.push(pt); if ((pt.reportedImpactPct || 0) > 8) stop = Math.min(stop, s.usd); }
    catch (e) { points.push({ ...s, error: e.message.slice(0, 120) }); if (s.kind === 'usd' && !transient(e)) stop = Math.min(stop, s.usd); }
  }
  const ok = points.filter((p) => !p.error);
  return { chain, source: [...new Set(ok.map((p) => p.src))].join('+'), tokenIn: tIn, tokenOut: tOut, inputUsdPrice: px, intendedUsd, ...finish(ok, intendedUsd, +q.threshold || 2), errors: points.filter((p) => p.error).map((p) => ({ usd: p.usd, error: p.error })), note: 'EVM reported impact = 1 − outUSD/inUSD from the aggregator (includes DEX fees). Swap EVM tokens in the DEX UI with a private RPC set in Rabby.' };
}
async function ladder(q, req) {
  const key = 'ladder:' + JSON.stringify(q);
  return cached(key, 30e3, () => (q.chain && q.chain !== 'solana' ? evmLadder(q) : solLadder(q, req)));
}
module.exports = { ladder, maxUnder };
