'use strict';
// Fake-volume detector for DEX tokens (Solana, Base, BSC, Ethereum, Robinhood Chain). Free data only (no Nansen, no paid X).
// Trade-level inputs: GeckoTerminal /pools/{pool}/trades (last <=300 swaps, keyless), pool attributes (unique buyers/sellers, volume,
// reserve, price change), DexScreener txns/volume/liquidity, Jupiter lite-api tokens/v2 organic score + organic volume (Solana only).
// research/fakevolume.py feeds the SAME analyzeTrades() with point-in-time trades parsed from Solana public RPC for the backtest.
// Signals: repeated same-size trades, same-wallet buy/sell round trips (self-trading) inside a short window, wallet hand-off rings
// (A buys X tokens, B sells ~X within seconds, and the hand-off graph contains a cycle = circular loop), volume spikes with flat price
// and no holder growth, volume per unique trader, volume/liquidity, % of volume from the top-N wallets, Jupiter non-organic share.
// Output: fake-volume share estimate (USD share of sampled volume caught by the patterns) + 0-100 score with plain-English reasons.
const fs = require('fs');
const path = require('path');

const P = { RT_WINDOW_S: 300, HANDOFF_WINDOW_S: 120, AMT_TOL: 0.02, SAME_WALLET_REPEATS: 3, SAME_SIZE_REPEATS: 4, DUST_USD: 1, TOPN: 5 };
const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);
const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const sig3 = (x) => { if (!(x > 0)) return '0'; const e = Math.floor(Math.log10(x)); const m = Math.round(x / 10 ** (e - 2)); return `${m}e${e - 2}`; };
const ROUND_Q = [0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.3, 0.5, 1, 1.5, 2, 2.5, 3, 5, 10, 20, 25, 50, 100, 1000, 5000, 10000];
const isRound = (q) => ROUND_Q.some((r) => Math.abs(q - r) / r < 0.005);

// trades: [{ id, t (unix s), trader, side: 'buy'|'sell', usd, amt (token amount), q (quote amount, optional) }]
function analyzeTrades(trades, ctx = {}) {
  const T = (trades || []).filter((x) => x && x.trader && (x.side === 'buy' || x.side === 'sell') && x.usd >= 0 && x.amt > 0).sort((a, b) => a.t - b.t);
  const out = { n_trades: T.length, params: P };
  if (T.length < 20) return { ...out, ok: false, reason: `only ${T.length} usable trades (need 20)` };
  T.forEach((x, i) => { if (x.id == null) x.id = i; });
  const vol = T.reduce((s, x) => s + x.usd, 0) || 1e-9;
  const flagged = new Map(); // id -> set of reasons
  const flag = (x, why) => { if (!flagged.has(x.id)) flagged.set(x.id, new Set()); flagged.get(x.id).add(why); };
  const byW = new Map(); for (const x of T) { if (!byW.has(x.trader)) byW.set(x.trader, []); byW.get(x.trader).push(x); }
  // 1) self round trips: same wallet buys then sells (or sells then buys) within RT_WINDOW_S. Matched volume counted on both legs.
  let rtUsd = 0, rtWallets = 0, rtPairs = 0;
  for (const [, arr] of byW) {
    const used = new Set(); let hit = false;
    for (let i = 0; i < arr.length; i++) { if (used.has(i)) continue;
      for (let j = i + 1; j < arr.length && arr[j].t - arr[i].t <= P.RT_WINDOW_S; j++) {
        if (used.has(j) || arr[j].side === arr[i].side) continue;
        const a = arr[i], b = arr[j]; const ratio = Math.min(a.amt, b.amt) / Math.max(a.amt, b.amt);
        if (ratio < 0.5) continue; // partial exits are normal trading; only near-full reversals count
        used.add(i); used.add(j); rtPairs++; hit = true; flag(a, 'round_trip'); flag(b, 'round_trip'); break;
      } }
    if (hit) rtWallets++;
    for (const i of used) rtUsd += arr[i].usd;
  }
  // 2) same-size repetition: same wallet repeating one quote size >= 3x, or any non-round size repeated >= 4x across wallets
  const keyQ = (x) => sig3(x.q != null && x.q > 0 ? x.q : x.usd);
  const wk = new Map(), gk = new Map();
  for (const x of T) { const k = keyQ(x); const a = x.trader + '|' + k; (wk.get(a) || wk.set(a, []).get(a)).push(x); (gk.get(k) || gk.set(k, []).get(k)).push(x); }
  let ssWalletUsd = 0, ssGlobalUsd = 0, ssGroups = 0; const ssSet = new Set();
  for (const [, arr] of wk) if (arr.length >= P.SAME_WALLET_REPEATS) { ssGroups++; for (const x of arr) { flag(x, 'same_size'); ssSet.add(x.id); ssWalletUsd += x.usd; } }
  for (const [, arr] of gk) { const q = arr[0].q != null ? arr[0].q : arr[0].usd; if (arr.length >= P.SAME_SIZE_REPEATS && !isRound(q) && new Set(arr.map((x) => x.trader)).size >= 2) for (const x of arr) if (!ssSet.has(x.id)) { flag(x, 'same_size'); ssSet.add(x.id); ssGlobalUsd += x.usd; } }
  // 3) hand-off graph: buy by A then sell by B != A of ~the same token amount within HANDOFF_WINDOW_S -> edge A->B. Cycles (SCC >= 2) = rings.
  const edges = new Map(); const edgeTrades = new Map();
  for (let i = 0; i < T.length; i++) { const a = T[i]; if (a.side !== 'buy') continue;
    for (let j = i + 1; j < T.length && T[j].t - a.t <= P.HANDOFF_WINDOW_S; j++) { const b = T[j];
      if (b.side !== 'sell' || b.trader === a.trader) continue;
      if (Math.abs(b.amt - a.amt) / a.amt > P.AMT_TOL) continue;
      const k = a.trader + '>' + b.trader; edges.set(k, (edges.get(k) || 0) + 1); (edgeTrades.get(k) || edgeTrades.set(k, []).get(k)).push(a, b); break; } }
  for (const e of extraEdges(ctx.transfers)) { const k = e.from + '>' + e.to; edges.set(k, (edges.get(k) || 0) + 1); }
  const adj = new Map(); for (const k of edges.keys()) { const [a, b] = k.split('>'); (adj.get(a) || adj.set(a, []).get(a)).push(b); if (!adj.has(b)) adj.set(b, []); }
  const comps = scc(adj).filter((c) => c.length >= 2);
  const inRing = new Set(comps.flat()); let ringUsd = 0; const ringIds = new Set();
  for (const [k, arr] of edgeTrades) { const [a, b] = k.split('>'); if (inRing.has(a) && inRing.has(b)) for (const x of arr) if (!ringIds.has(x.id)) { ringIds.add(x.id); ringUsd += x.usd; flag(x, 'ring'); } }
  const handoffEdges = [...edges.values()].reduce((s, v) => s + v, 0);
  // 4) concentration, dust, per-trader intensity
  const wUsd = [...byW.entries()].map(([w, arr]) => [w, arr.reduce((s, x) => s + x.usd, 0)]).sort((a, b) => b[1] - a[1]);
  const topShare = wUsd.slice(0, P.TOPN).reduce((s, x) => s + x[1], 0) / vol;
  const dust = T.filter((x) => x.usd < P.DUST_USD); for (const x of dust) flag(x, 'dust');
  const buyUsd = T.filter((x) => x.side === 'buy').reduce((s, x) => s + x.usd, 0);
  const span = Math.max(1, T[T.length - 1].t - T[0].t);
  let fakeUsd = 0; for (const x of T) if (flagged.has(x.id)) fakeUsd += x.usd;
  const m = {
    ok: true, ...out, n_traders: byW.size, sample_usd: Math.round(vol * 100) / 100, span_min: Math.round(span / 6) / 10,
    trades_per_trader: r3(T.length / byW.size), usd_per_trader: Math.round(vol / byW.size),
    round_trip_share: r3(rtUsd / vol), round_trip_wallets: rtWallets, round_trip_pairs: rtPairs,
    same_size_share: r3((ssWalletUsd + ssGlobalUsd) / vol), same_size_wallet_share: r3(ssWalletUsd / vol), same_size_groups: ssGroups,
    ring_share: r3(ringUsd / vol), ring_count: comps.length, ring_wallets: inRing.size, ring_largest: comps.reduce((s, c) => Math.max(s, c.length), 0), handoff_edges: handoffEdges,
    rings: comps.slice(0, 3).map((c) => c.slice(0, 6)),
    top_share: r3(topShare), top_wallets: wUsd.slice(0, P.TOPN).map(([w, u]) => ({ wallet: w, share: r3(u / vol) })),
    dust_count_share: r3(dust.length / T.length), buy_usd_share: r3(buyUsd / vol), net_flow_ratio: r3(Math.abs(2 * buyUsd - vol) / vol),
    fake_share_trades: r3(fakeUsd / vol),
  };
  return score(m, ctx);
}
function extraEdges(tr) { return Array.isArray(tr) ? tr.filter((e) => e && e.from && e.to && e.from !== e.to) : []; }
function scc(adj) { // Tarjan, iterative
  let idx = 0; const ix = new Map(), low = new Map(), on = new Set(), st = [], out = [];
  for (const v0 of adj.keys()) { if (ix.has(v0)) continue;
    const work = [[v0, 0]]; ix.set(v0, idx); low.set(v0, idx); idx++; st.push(v0); on.add(v0);
    while (work.length) { const fr = work[work.length - 1]; const [v, i] = fr; const nb = adj.get(v) || [];
      if (i < nb.length) { fr[1]++; const w = nb[i];
        if (!ix.has(w)) { ix.set(w, idx); low.set(w, idx); idx++; st.push(w); on.add(w); work.push([w, 0]); }
        else if (on.has(w)) low.set(v, Math.min(low.get(v), ix.get(w))); }
      else { work.pop(); if (work.length) { const u = work[work.length - 1][0]; low.set(u, Math.min(low.get(u), low.get(v))); }
        if (low.get(v) === ix.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); out.push(c); } } } }
  return out;
}

// ctx (pool level, all optional): vol24, liq, pc1 / pc24 (%), vol1h, buyers24, sellers24, txns24, holders, holderCh1h / holderCh24 (%),
// jup: { organicScore, organicLabel, organicShare24 }
function score(m, ctx = {}) {
  const R = []; let s = 0;
  const add = (pts, txt, key) => { if (pts > 0) { s += pts; R.push({ pts: Math.round(pts), key, text: txt }); } };
  const pct = (x) => `${Math.round(x * 100)}%`;
  if (m.round_trip_share >= 0.05) add(Math.min(25, m.round_trip_share * 80), `${pct(m.round_trip_share)} of sampled volume is the same wallet buying and selling back within ${P.RT_WINDOW_S / 60} min (${m.round_trip_wallets} wallets): self-trading that adds volume but no new holders.`, 'round_trip');
  if (m.ring_count > 0) add(Math.min(20, 6 + m.ring_share * 60), `${m.ring_count} wallet ring(s) (largest ${m.ring_largest} wallets) pass the same token amount back and forth within ${P.HANDOFF_WINDOW_S}s: circular trading, ${pct(m.ring_share)} of volume.`, 'ring');
  if (m.same_size_share >= 0.15) add(Math.min(15, (m.same_size_share - 0.1) * 40), `${pct(m.same_size_share)} of volume comes from identical trade sizes repeated over and over (bot pattern${m.same_size_groups ? `, ${m.same_size_groups} wallet+size groups repeating ≥${P.SAME_WALLET_REPEATS}x` : ''}).`, 'same_size');
  if (m.top_share >= 0.5) add(Math.min(10, (m.top_share - 0.4) * 25), `The top ${P.TOPN} wallets account for ${pct(m.top_share)} of sampled volume: a handful of wallets generate most of the activity.`, 'top_wallets');
  if (m.trades_per_trader >= 6) add(Math.min(8, (m.trades_per_trader - 4) * 0.8), `${m.trades_per_trader.toFixed(1)} trades per unique wallet in the sample (organic markets are usually 1-3).`, 'per_trader');
  if (m.dust_count_share >= 0.3) add(Math.min(6, m.dust_count_share * 8), `${pct(m.dust_count_share)} of trades are under $${P.DUST_USD} (dust trades inflate trade counts and "makers").`, 'dust');
  const ux = (ctx.buyers24 || 0) + (ctx.sellers24 || 0);
  if (ctx.vol24 > 0 && ux > 0) { m.vol_per_unique_trader24 = Math.round(ctx.vol24 / ux); if (ctx.txns24) m.txns_per_unique_trader24 = r3(ctx.txns24 / ux);
    if (m.txns_per_unique_trader24 >= 8) add(Math.min(8, (m.txns_per_unique_trader24 - 5) * 0.8), `${ctx.txns24} txns in 24h from only ${ux} unique buyer/seller wallets (${m.txns_per_unique_trader24.toFixed(1)} each).`, 'per_trader24'); }
  if (ctx.vol24 > 0 && ctx.liq > 0) { m.vol_liq = r3(ctx.vol24 / ctx.liq); if (m.vol_liq > 10) add(Math.min(10, (m.vol_liq - 8) * 0.5), `24h volume is ${m.vol_liq.toFixed(0)}x the pool liquidity: far more churn than real demand usually supports.`, 'vol_liq'); }
  if (ctx.vol1h > 0 && ctx.vol24 > 0 && ctx.pc1 != null) { const spike = ctx.vol1h / (ctx.vol24 / 24); m.spike_1h = r3(spike);
    const flat = Math.abs(ctx.pc1) < 3; const noHolders = ctx.holderCh1h == null || Math.abs(ctx.holderCh1h) < 0.5;
    if (spike >= 3 && flat && noHolders) add(6, `Volume in the last hour is ${spike.toFixed(1)}x the 24h hourly average, yet price moved only ${ctx.pc1.toFixed(1)}%${ctx.holderCh1h != null ? ` and holders changed ${ctx.holderCh1h.toFixed(2)}%` : ''}: volume without price impact or holder growth.`, 'flat_spike'); }
  const j = ctx.jup; if (j && j.organicScore != null) { m.jup_organic_score = r3(j.organicScore); m.jup_organic_label = j.organicLabel || null; m.jup_non_organic_share24 = j.organicShare24 != null ? r3(1 - j.organicShare24) : null;
    if (j.organicScore < 30) add(Math.min(15, (30 - j.organicScore) * 0.5 + 3), `Jupiter rates its trading activity "${j.organicLabel || 'low'}" organic (score ${j.organicScore.toFixed(0)}/100${j.organicShare24 != null ? `; only ${pct(j.organicShare24)} of 24h volume counted as organic` : ''}).`, 'jupiter'); }
  m.score = Math.round(clamp(s)); m.level = m.score >= 60 ? 'high' : m.score >= 35 ? 'elevated' : 'low';
  // Fake share: trade-level estimate (USD share of sampled swaps caught by >=1 pattern). Jupiter's non-organic share is an upper bound
  // (it also excludes legitimate arbitrage / aggregator bots), shown as the top of the range when present.
  const lo = m.fake_share_trades != null ? m.fake_share_trades : null;
  const hi = m.jup_non_organic_share24 != null ? Math.max(lo || 0, m.jup_non_organic_share24) : lo;
  m.fake_share_estimate = lo != null ? lo : (hi != null ? r3(hi) : null); m.fake_share_range = [lo, r3(hi)];
  if (lo == null) m.data_level = 'pool-level only (no trade sample)';
  m.reasons = R.sort((a, b) => b.pts - a.pts);
  const shareTxt = m.fake_share_estimate == null ? '' : ` about ${pct(m.fake_share_estimate)}${hi != null && lo != null && hi > lo + 0.05 && !(hi >= 0.99 && lo < 0.5) ? `-${pct(hi)}` : '' /* Jupiter 0% organic on thin tokens is too blunt to print as an upper bound */} of volume looks artificial${lo == null ? ' (Jupiter non-organic share; no trade sample)' : ''}.`;
  m.summary = m.reasons.length ? `Fake-volume score ${m.score}/100 (${m.level});${shareTxt} ${m.reasons.slice(0, 2).map((x) => x.text).join(' ')}` : `Fake-volume score ${m.score}/100: no strong wash-trading pattern${m.n_trades ? ` in the last ${m.n_trades} swaps` : ''}.`;
  return m;
}

// ---------- live data adapters (free endpoints) ----------
const GT = 'https://api.geckoterminal.com/api/v2';
const NET = { solana: 'solana', ethereum: 'eth', base: 'base', bsc: 'bsc', robinhood: 'robinhood', arbitrum: 'arbitrum' };
const TAPES = new Map(); // last GT tape per token from the live scan -> data/patternlab_ext_cache/live_tapes.json (lib/patternlab_ext.js tape rules)
let gtLast = 0; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gtGet(u) { // GeckoTerminal free tier is ~30 req/min per IP and shared with the rest of the server: pace + back off on 429
  for (let i = 0; ; i++) { const w = gtLast + 3000 - Date.now(); if (w > 0) await sleep(w); gtLast = Date.now();
    const r = await fetch(GT + u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) }); if (r.status === 404) return null;
    if (r.status === 429 && i < 3) { await sleep(10000 * (i + 1)); continue; } if (!r.ok) throw new Error('GT HTTP ' + r.status); return r.json(); } }
async function getJ(u) { const r = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) return null; return r.json(); }
function gtTrades(j, base) {
  return (j?.data || []).map((d, i) => { const a = d.attributes || {}; const buy = a.kind === 'buy';
    const amt = +(buy ? a.to_token_amount : a.from_token_amount); const q = +(buy ? a.from_token_amount : a.to_token_amount);
    return { id: d.id || i, t: Math.floor(Date.parse(a.block_timestamp) / 1000), trader: a.tx_from_address, side: a.kind, usd: +a.volume_in_usd || 0, amt, q, tx: a.tx_hash }; })
    .filter((x) => base == null || true);
}
async function jupiter(mint) { try { const j = await getJ('https://lite-api.jup.ag/tokens/v2/search?query=' + mint); const t = (j || []).find((x) => x.id === mint); if (!t) return null;
  const s24 = t.stats24h || {}; const tot = (s24.buyVolume || 0) + (s24.sellVolume || 0); const org = (s24.buyOrganicVolume || 0) + (s24.sellOrganicVolume || 0);
  return { organicScore: t.organicScore, organicLabel: t.organicScoreLabel, organicShare24: tot > 0 ? org / tot : null, holders: t.holderCount, holderCh1h: t.stats1h?.holderChange ?? null, holderCh24: s24.holderChange ?? null }; } catch { return null; } }
// Resolve the top pool for a token via DexScreener (correct-case pair address + txns/volume/liquidity), then GT trades + pool attrs.
async function analyzeToken(chain, address, { pool = null, ds = null } = {}) {
  const net = NET[chain]; if (!net) return { ok: false, reason: 'unsupported chain ' + chain };
  if (!ds) { const j = await getJ(`https://api.dexscreener.com/tokens/v1/${chain}/${address}`); ds = (Array.isArray(j) ? j : []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0] || null; }
  pool = pool || ds?.pairAddress; if (!pool) return { ok: false, reason: 'no DEX pool found' };
  let pj = null, tj = null, gtErr = null;
  try { pj = await gtGet(`/networks/${net}/pools/${pool}`); tj = await gtGet(`/networks/${net}/pools/${pool}/trades`); } catch (e) { gtErr = String(e.message || e); } // degrade to DexScreener + Jupiter pool-level signals
  const pa = pj?.data?.attributes || {};
  const baseIsToken = String(pj?.data?.relationships?.base_token?.data?.id || '').toLowerCase().endsWith(String(address).toLowerCase());
  let trades = gtTrades(tj);
  if (!baseIsToken && pj) trades = trades.map((x) => ({ ...x, side: x.side === 'buy' ? 'sell' : 'buy', amt: x.q, q: x.amt })); // token is the quote side
  try { TAPES.set(`${chain}:${address}`, { at: Date.now(), pool, symbol: ds?.baseToken?.symbol || null, poolCreatedAt: pj?.data?.attributes?.pool_created_at ? Date.parse(pj.data.attributes.pool_created_at) : null, trades: trades.map((x) => ({ t: x.t, w: x.trader, s: x.side === 'buy' ? 1 : 0, usd: Math.round((x.usd || 0) * 100) / 100, q: x.q })) }); } catch {} // Pattern Lab EXT live tape rules reuse these trades (no extra calls)
  const jup = chain === 'solana' ? await jupiter(address) : null;
  const tx24 = pa.transactions?.h24 || {};
  const created = pa.pool_created_at ? Date.parse(pa.pool_created_at) : (ds?.pairCreatedAt || null);
  const ctx = { pool_age_h: created ? Math.round((Date.now() - created) / 36e5 * 10) / 10 : null, vol24: +pa.volume_usd?.h24 || ds?.volume?.h24 || 0, vol1h: +pa.volume_usd?.h1 || ds?.volume?.h1 || 0, liq: +pa.reserve_in_usd || ds?.liquidity?.usd || 0,
    pc1: pa.price_change_percentage?.h1 != null ? +pa.price_change_percentage.h1 : ds?.priceChange?.h1 ?? null, pc24: pa.price_change_percentage?.h24 != null ? +pa.price_change_percentage.h24 : null,
    buyers24: tx24.buyers, sellers24: tx24.sellers, txns24: (tx24.buys || 0) + (tx24.sells || 0) || ((ds?.txns?.h24?.buys || 0) + (ds?.txns?.h24?.sells || 0)) || null, holderCh1h: jup?.holderCh1h ?? null, jup };
  const m = analyzeTrades(trades, ctx);
  if (gtErr) m.reason = `trade-level data unavailable (${gtErr}); pool-level signals only`;
  return { chain, address, pool, symbol: ds?.baseToken?.symbol || null, dex: ds?.dexId || null, at: Date.now(), ...(m.ok ? m : { ...m, ...score({ ...m, fake_share_trades: null }, ctx), ok: false }), ctx: { ...ctx, jup: undefined } };
}

// ---------- persisted live scan + composite factor ----------
function load(DATA_DIR, f) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; } }
let fcache = { t: 0, v: null };
function liveMap(DATA_DIR) { const p = path.join(DATA_DIR, 'fakevolume_live.json'); let st; try { st = fs.statSync(p); } catch { return null; }
  if (fcache.t !== st.mtimeMs) fcache = { t: st.mtimeMs, v: load(DATA_DIR, 'fakevolume_live.json') }; return fcache.v; }
// Composite factor: 0-100 (50 neutral). Clean tape = mild comfort (58); score 60+ drags hard. Caps only where the backtest supports it.
function compositeFactor(DATA_DIR, chain, address) {
  const L = liveMap(DATA_DIR); const x = L?.tokens?.[`${chain}:${address}`]; if (!x || x.score == null) return null;
  if (Date.now() - (x.at || 0) > 6 * 3600e3) return null; // stale
  const bt = load(DATA_DIR, 'fakevolume_backtest.json'); const capOk = !!bt?.composite_policy?.cap_supported;
  // grade cap only where the backtest applies: young pools (the point-in-time test is graduation-window pump.fun data; on mature catalog tokens the
  // current score did not separate crashed from runners). Pool age proxy: DexScreener pairCreatedAt carried in ctx.pool_age_h when present.
  const young = x.ctx?.pool_age_h == null ? (x.ctx?.vol24 != null && x.ctx?.liq != null && x.ctx.liq < 250000) : x.ctx.pool_age_h <= 72;
  return { score: clamp(58 - x.score * 0.55), value: `${x.score}/100 (${x.level}), ~${Math.round((x.fake_share_estimate || 0) * 100)}% fake`, text: x.summary + (bt?.composite_policy?.short ? ' ' + bt.composite_policy.short : ''),
    cap: capOk && x.score >= 75 && young ? 'D' : null };
}
function createFakeVolume({ DATA_DIR, live = null, log = () => {}, intervalMs = 20 * 60e3, maxTokens = 40 }) {
  let running = false, timer = null, last = null;
  async function scanOnce() {
    if (running) return; running = true; const t0 = Date.now();
    try {
      let feed = null; try { feed = live?.feed?.() || load(DATA_DIR, 'live_feed.json'); } catch {}
      const items = (feed?.items || []).filter((x) => NET[x.chain] && x.address).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, maxTokens);
      const prev = load(DATA_DIR, 'fakevolume_live.json')?.tokens || {}; const tokens = {};
      for (const x of items) { const k = `${x.chain}:${x.address}`;
        try { const r = await analyzeToken(x.chain, x.address); tokens[k] = { symbol: x.symbol, grade: x.grade, ...r, rings: r.rings, top_wallets: (r.top_wallets || []).slice(0, 3) }; }
        catch (e) { if (prev[k]) tokens[k] = prev[k]; log('fakevolume', k, String(e.message || e).slice(0, 80)); } }
      const arr = Object.values(tokens).filter((x) => x.score != null);
      const out = { generatedAt: Date.now(), elapsed_s: Math.round((Date.now() - t0) / 1000), source: 'GeckoTerminal trades+pool, DexScreener, Jupiter lite-api (keyless)', params: P, count: arr.length,
        high: arr.filter((x) => x.level === 'high').length, elevated: arr.filter((x) => x.level === 'elevated').length, tokens };
      fs.writeFileSync(path.join(DATA_DIR, 'fakevolume_live.json.tmp'), JSON.stringify(out)); fs.renameSync(path.join(DATA_DIR, 'fakevolume_live.json.tmp'), path.join(DATA_DIR, 'fakevolume_live.json'));
      last = out;
      try { const dir = path.join(DATA_DIR, 'patternlab_ext_cache'); fs.mkdirSync(dir, { recursive: true }); const keep = {}; for (const k of Object.keys(tokens)) if (TAPES.has(k)) keep[k] = TAPES.get(k); TAPES.clear();
        fs.writeFileSync(path.join(dir, 'live_tapes.json.tmp'), JSON.stringify({ generatedAt: Date.now(), source: 'GeckoTerminal /pools/{pool}/trades (last <=300 swaps) via lib/fakevolume.js live scan', tokens: keep })); fs.renameSync(path.join(dir, 'live_tapes.json.tmp'), path.join(dir, 'live_tapes.json')); } catch (e) { log('fakevolume tapes', e.message); }
    } finally { running = false; }
  }
  return {
    start() { if (timer) return; setTimeout(() => scanOnce().catch((e) => log('fakevolume scan', e.message)), 90e3).unref?.(); timer = setInterval(() => scanOnce().catch((e) => log('fakevolume scan', e.message)), intervalMs); timer.unref?.(); },
    scanOnce, factor: (chain, address) => compositeFactor(DATA_DIR, chain, address),
    routes() { return {
      async '/api/fakevolume'() { const L = liveMap(DATA_DIR); const bt = load(DATA_DIR, 'fakevolume_backtest.json');
        const toks = Object.values(L?.tokens || {}).filter((x) => x.score != null).sort((a, b) => b.score - a.score).map((x) => ({ chain: x.chain, address: x.address, symbol: x.symbol, score: x.score, level: x.level, fake_share_estimate: x.fake_share_estimate, fake_share_range: x.fake_share_range, summary: x.summary, reasons: x.reasons }));
        return { generatedAt: L?.generatedAt || null, running, count: toks.length, tokens: toks, backtest: bt ? { summary: bt.summary, tests: bt.tests, composite_policy: bt.composite_policy } : null, nfa: 'Model estimate from public data. Not financial advice.' }; },
      async '/api/fakevolume/token'(q) { const chain = q.get('chain') || 'solana', address = q.get('address'); if (!address) return { error: 'address required' }; return analyzeToken(chain, address); },
    }; },
  };
}
module.exports = { analyzeTrades, score, analyzeToken, compositeFactor, createFakeVolume, P, scc };

// CLI: node lib/fakevolume.js score <in.json> <out.json>   (in: [{key, trades, ctx}]) — used by research/fakevolume.py
//      node lib/fakevolume.js token <chain> <address>
if (require.main === module) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'score') { const inp = JSON.parse(fs.readFileSync(a, 'utf8')); const res = inp.map((x) => ({ key: x.key, ...analyzeTrades(x.trades, x.ctx || {}) })); fs.writeFileSync(b, JSON.stringify(res)); }
  else if (cmd === 'token') analyzeToken(a, b).then((r) => console.log(JSON.stringify(r, null, 1))).catch((e) => { console.error(e); process.exit(1); });
}
