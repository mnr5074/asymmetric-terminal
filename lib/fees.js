'use strict';
// Priority-fee / gas prediction (free, keyless). Read-only.
// Solana: getRecentPrioritizationFees (last ~150 slots, micro-lamports per compute unit) + Jito landed-tip floor.
//   (Helius getPriorityFeeEstimate needs an API key, so it is not used.)
// EVM: eth_feeHistory on Ethereum / Base / BSC / Arbitrum (publicnode RPCs).
// History: a sample every 15 min to data/fee_history.json (30 days). EVM is backfilled hourly for the last 7 days from
// eth_feeHistory at past blocks; Solana/Jito history only accumulates from when this module first ran (no free backfill).
const fs = require('fs');
const path = require('path');
const { getJSON, postJSON, sleep } = require('./util');
const { rpcFor } = require('./solrpc');
const chains = require('./chains');

const FILE = path.join(__dirname, '..', 'data', 'fee_history.json');
const EVM = ['ethereum', 'base', 'bsc', 'arbitrum'];
const SWAP_GAS = 180000, SOL_SWAP_CU = 200000;
const TZ = 'America/Los_Angeles';
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { samples: [], backfill: {} }; } }
let DB = load();
function save() { try { const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(DB)); fs.renameSync(t, FILE); } catch {} }
const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
// publicnode refuses fee history older than ~1 day ('archive requests require a token'); these free endpoints serve 7 days.
// Arbitrum's feeHistory needs historical state no free endpoint serves -> forward-only sampling there.
const BACKFILL_RPC = { ethereum: ['https://eth.drpc.org', 'https://rpc.flashbots.net'], base: ['https://mainnet.base.org'], bsc: ['https://bsc-dataseed.bnbchain.org'] };
async function evmRpc(chain, method, params, url) { const j = await postJSON(url || chains.CHAINS[chain].rpc, { jsonrpc: '2.0', id: 1, method, params }, 15000); if (j.error) throw new Error(`${chain} ${method}: ${j.error.message}`); return j.result; }
const gwei = (hex) => Number(BigInt(hex)) / 1e9;

// The global call returns the per-slot MINIMUM fee across all txs, which is ~always 0. Scoping to a hot writable account
// (the busiest SOL/USDC Orca Whirlpool by default, or the pools of your quoted route) gives the fee band swaps actually pay.
const REF_POOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
async function solNow(accounts) {
  const rpc = rpcFor(null);
  const r = await rpc.call('getRecentPrioritizationFees', [accounts && accounts.length ? accounts : [REF_POOL]]);
  const f = r.map((x) => x.prioritizationFee);
  const nz = f.filter((x) => x > 0);
  return { slots: f.length, p25: q(f, 0.25), p50: q(f, 0.5), p75: q(f, 0.75), p90: q(f, 0.9), nonzeroShare: f.length ? nz.length / f.length : null, unit: 'micro-lamports per CU', scope: accounts && accounts.length ? accounts : ['SOL/USDC Orca Whirlpool ' + REF_POOL] };
}
async function jitoNow() {
  const j = await getJSON('https://bundles.jito.wtf/api/v1/bundles/tip_floor', {}, 8000); const r = j[0] || {}; const L = (x) => (x == null ? null : Math.round(x * 1e9));
  return { p25: L(r.landed_tips_25th_percentile), p50: L(r.landed_tips_50th_percentile), p75: L(r.landed_tips_75th_percentile), p95: L(r.landed_tips_95th_percentile), emaP50: L(r.ema_landed_tips_50th_percentile), unit: 'lamports' };
}
async function evmNow(chain) {
  const h = await evmRpc(chain, 'eth_feeHistory', ['0x14', 'latest', [25, 50, 75]]);
  const base = h.baseFeePerGas.map(gwei); const pr = (h.reward || []).map((r) => r.map(gwei));
  const prio50 = q(pr.map((r) => r[1]), 0.5), prio75 = q(pr.map((r) => r[2]), 0.5);
  return { baseGwei: base[base.length - 1], prioP50Gwei: prio50, prioP75Gwei: prio75, totalGwei: base[base.length - 1] + (prio50 || 0), gasUsedRatio: q(h.gasUsedRatio || [], 0.5) };
}
async function sample() {
  const s = { t: Date.now() };
  await Promise.all([
    solNow().then((x) => { s.sol = x; }).catch((e) => { s.solErr = e.message; }),
    jitoNow().then((x) => { s.jito = x; }).catch((e) => { s.jitoErr = e.message; }),
    ...EVM.map((c) => evmNow(c).then((x) => { (s.evm ||= {})[c] = x; }).catch(() => {})),
  ]);
  DB.samples.push(s); const cut = Date.now() - 30 * 86400e3; DB.samples = DB.samples.filter((x) => x.t >= cut); save();
  return s;
}
// EVM backfill: one eth_feeHistory window per past hour for 7 days (~168 calls per chain, throttled).
let backfilling = false;
async function backfill() {
  if (backfilling) return; backfilling = true;
  try {
    for (const c of EVM) {
      const bf = DB.backfill[c];
      if (bf && Date.now() - bf.at < 6 * 3600e3 && (bf.points || []).length >= 100) continue;
      const urls = BACKFILL_RPC[c]; if (!urls) { DB.backfill[c] = { at: Date.now(), points: [], note: 'no free endpoint serves historical fee data for this chain; forward sampling only' }; continue; }
      let url = urls[0];
      try {
        const latest = parseInt(await evmRpc(c, 'eth_blockNumber', [], url), 16);
        const back = 100000; const [bl, bo] = await Promise.all([evmRpc(c, 'eth_getBlockByNumber', ['0x' + latest.toString(16), false], url), evmRpc(c, 'eth_getBlockByNumber', ['0x' + (latest - back).toString(16), false], url)]);
        const bt = (parseInt(bl.timestamp, 16) - parseInt(bo.timestamp, 16)) / back; const now = parseInt(bl.timestamp, 16) * 1000;
        const pts = [];
        for (let h = 1; h <= 168; h++) {
          const n = Math.round(latest - (h * 3600) / bt); if (n < 1) break;
          try { let r; try { r = await evmRpc(c, 'eth_feeHistory', ['0x5', '0x' + n.toString(16), [50]], url); } catch (e) { if (!urls[1]) throw e; url = urls[1]; r = await evmRpc(c, 'eth_feeHistory', ['0x5', '0x' + n.toString(16), [50]], url); } const base = r.baseFeePerGas.map(gwei), pr = (r.reward || []).map((x) => gwei(x[0])); pts.push({ t: now - h * 3600e3, baseGwei: q(base, 0.5), prioP50Gwei: q(pr, 0.5), totalGwei: q(base, 0.5) + (q(pr, 0.5) || 0) }); } catch {}
          await sleep(120);
        }
        DB.backfill[c] = { at: Date.now(), blockTimeSec: bt, points: pts, rpc: new URL(url).host }; save();
      } catch (e) { DB.backfill[c] = { at: Date.now(), error: e.message, points: (bf && bf.points) || [] }; }
    }
  } finally { backfilling = false; }
}
// ---------- analysis ----------
const ptParts = (t) => { const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date(t)); return { wd: p.find((x) => x.type === 'weekday').value, hr: +p.find((x) => x.type === 'hour').value % 24 }; };
function analyze(series, current, lowerIsCheaper = true) {
  const wk = series.filter((x) => x.t >= Date.now() - 7 * 86400e3 && x.v != null);
  const vals = wk.map((x) => x.v);
  const pct = vals.length && current != null ? (vals.filter((v) => v < current).length + 0.5 * vals.filter((v) => v === current).length) / vals.length * 100 : null;
  const spanH = wk.length ? (Date.now() - Math.min(...wk.map((x) => x.t))) / 3600e3 : 0;
  const how = {};
  for (const x of wk) { const { wd, hr } = ptParts(x.t); (how[wd + ' ' + hr] ||= []).push(x.v); }
  const hours = Object.entries(how).map(([k, v]) => ({ slot: k, median: q(v, 0.5), n: v.length })).sort((a, b) => a.median - b.median);
  const hod = {}; for (const x of wk) { const { hr } = ptParts(x.t); (hod[hr] ||= []).push(x.v); }
  const byHour = Object.entries(hod).map(([h, v]) => ({ hourPT: +h, median: q(v, 0.5) })).sort((a, b) => a.median - b.median);
  const enough = vals.length >= 24 && spanH >= 24;
  const verdict = !enough ? 'history building' : pct <= 30 ? 'cheap' : pct >= 70 ? 'expensive' : 'normal';
  return { current, samples7d: vals.length, historyHours: Math.round(spanH), percentile7d: pct, median7d: q(vals, 0.5), p10: q(vals, 0.1), p90: q(vals, 0.9), verdict, cheapestHoursOfWeekPT: enough ? hours.slice(0, 5) : [], cheapestHoursOfDayPT: enough ? byHour.slice(0, 4) : [], mostExpensiveHoursOfDayPT: enough ? byHour.slice(-3).reverse() : [] };
}
async function feesApi(qp) {
  const accts = (qp?.get?.('accounts') || '').split(',').filter((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)).slice(0, 5);
  const last = DB.samples[DB.samples.length - 1];
  const s0 = !last || Date.now() - last.t > 120e3 ? await sample() : last;
  // free RPCs fail transiently: fill any missing component from the newest sample < 30 min old
  const s = { ...s0, evm: { ...(s0.evm || {}) } };
  for (const x of [...DB.samples].reverse()) { if (s0.t - x.t > 30 * 60e3) break; if (!s.sol && x.sol) s.sol = x.sol; if (!s.jito && x.jito) s.jito = x.jito; for (const c of EVM) if (!s.evm[c] && x.evm?.[c]) s.evm[c] = x.evm[c]; }
  backfill().catch(() => {});
  const ser = (f) => DB.samples.map((x) => ({ t: x.t, v: f(x) })).filter((x) => x.v != null);
  let natives = {}; try { const d = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum,binancecoin&vs_currencies=usd', {}, 8000); natives = { SOL: d.solana?.usd, ETH: d.ethereum?.usd, BNB: d.binancecoin?.usd }; } catch {}
  const out = { at: s.t, tz: 'PT (America/Los_Angeles)', solana: null, jito: null, evm: {} };
  if (s.sol) {
    const a = analyze(ser((x) => x.sol?.p75), s.sol.p75);
    out.solana = { ...s.sol, analysis: a, swapCost: { cuAssumed: SOL_SWAP_CU, p50Sol: (s.sol.p50 * SOL_SWAP_CU) / 1e15, p75Sol: (s.sol.p75 * SOL_SWAP_CU) / 1e15, p90Sol: (s.sol.p90 * SOL_SWAP_CU) / 1e15, p75Usd: natives.SOL ? ((s.sol.p75 * SOL_SWAP_CU) / 1e15) * natives.SOL : null },
      explain: `Solana priority fee = compute-unit price × compute units. Over the last ~${s.sol.slots} slots (~1 min) 75% of slots landed txs paying ≤ ${Math.round(s.sol.p75).toLocaleString()} micro-lamports/CU, i.e. about ${((s.sol.p75 * SOL_SWAP_CU) / 1e15).toFixed(6)} SOL for a ~200k-CU swap. Jupiter's "high" level targets roughly this band. The private Jito route uses a tip instead.` };
  }
  if (s.jito) { const a = analyze(ser((x) => x.jito?.p50), s.jito.p50); out.jito = { ...s.jito, analysis: a, usdP50: natives.SOL ? (s.jito.p50 / 1e9) * natives.SOL : null, explain: `Half of recent Jito bundles landed with a tip ≤ ${(s.jito.p50 / 1e9).toFixed(7)} SOL; 95% ≤ ${(s.jito.p95 / 1e9).toFixed(7)} SOL. The terminal default tip (0.0001 SOL) is above p95, so you can lower it when the network is calm.` }; }
  for (const c of EVM) {
    const cur = s.evm?.[c]; if (!cur) continue;
    const bf = (DB.backfill[c]?.points || []).map((p) => ({ t: p.t, v: p.totalGwei }));
    const live = ser((x) => x.evm?.[c]?.totalGwei);
    const merged = [...bf.filter((p) => !live.length || p.t < live[0].t), ...live];
    const nat = c === 'bsc' ? natives.BNB : natives.ETH;
    out.evm[c] = { ...cur, analysis: analyze(merged, cur.totalGwei), swapCostUsd: nat ? (cur.totalGwei * SWAP_GAS * nat) / 1e9 : null, gasAssumed: SWAP_GAS, backfilledHours: bf.length,
      explain: `${chains.CHAINS[c].name}: base fee ${cur.baseGwei.toPrecision(3)} gwei + tip ${(cur.prioP50Gwei || 0).toPrecision(3)} gwei. A ~${SWAP_GAS / 1000}k-gas swap costs ≈ ${nat ? '$' + ((cur.totalGwei * SWAP_GAS * nat) / 1e9).toFixed(c === 'ethereum' ? 2 : 4) : '?'}${c === 'base' || c === 'arbitrum' ? ' plus a small L1 data fee' : ''}.` };
  }
  if (accts.length) { try { const r = await solNow(accts); out.routeFees = { ...r, swapCostSol: { p50: (r.p50 * SOL_SWAP_CU) / 1e15, p75: (r.p75 * SOL_SWAP_CU) / 1e15, p90: (r.p90 * SOL_SWAP_CU) / 1e15 }, explain: 'Same measure, scoped to the pools in your quoted route.' }; } catch {} }
  out.method = 'Percentile = where the current value sits among all samples from the last 7 days (lower = cheaper). Verdict: ≤30th cheap, ≥70th expensive. Hours-of-week use the median of samples in each PT hour. EVM history is backfilled for 7 days; Solana and Jito history only starts when this terminal began sampling (every 15 min), so their verdict says "history building" for the first day.';
  return out;
}
setTimeout(() => { sample().catch(() => {}); backfill().catch(() => {}); }, 20e3).unref();
setInterval(() => sample().catch(() => {}), 15 * 60e3).unref();
module.exports = { feesApi, sample, backfill, analyze };
