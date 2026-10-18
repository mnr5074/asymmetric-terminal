// Crypto Desk / Live Alpha Feed: always-on discovery -> scan -> Asymmetry Score.
// Everything here is an automated ESTIMATE from free public data. Not financial advice.
'use strict';
const whalewatch = require('./whalewatch');
// Tokens always kept in the live universe (re-upserted every discovery cycle). Add [chain, address, symbol].
const PINNED = [
  ['solana', 'EosbW31T1WAQSiHUErogcaNHd8FBZDbjPPgQMJzXARNV', 'QCAT'], // StonkFun reward coin, Raydium CPMM pool vs STRK
  ['solana', 'HsRpHQn6VbyMs5b5j5SV6xQ2VvpvvCCzu19GjytVSCoz', 'STRK'], // Solana SPL STRK (CoinGecko starknet platform address)
];
// NEAR and ZEC are pinned as PRIORITY tokens in lib/priority.js (symbol + CoinGecko id), not here: they are native L1 coins with no canonical
// DEX address on the supported chains (DexScreener 'NEAR'/'ZEC' pairs on Solana/Ethereum/Robinhood are look-alikes with fake liquidity).
const fs = require('fs');
const path = require('path');

const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';
const UA = { 'user-agent': 'Mozilla/5.0 asymmetric-terminal' };
const H = 3600e3, D = 24 * H;
const clip = (x) => (x == null || isNaN(x) ? 0 : Math.max(0, Math.min(1, x)));
const BASE_WEIGHTS = { flow: 25, participation: 20, safety: 20, upside: 15, similarity: 10, narrative: 5, smart: 5, attention: 5 };

const m0 = (r) => r.m || {};
const { exitPlan, atrFromMarket } = require('./exitplan');
const { createGradeV2 } = require('./gradev2'); // grade v2: letters only from rules that beat the base rate out-of-sample (data/grade_rebuild.json)
let _csLookup = null;
function csCreator(chain, address) {
  try { if (!_csLookup) _csLookup = require('./contractscan').lookup; const r = _csLookup(chain, address); return r?.creator || null; } catch { return null; }
}
function createLiveFeed(o) {
  const { getJSON, cached, gtGet, dsTokens, scan, DATA_DIR, chains, log = () => {} } = o;
  const MODE = o.mode || 'full';
  const FULL = MODE === 'full';
  const CH = FULL ? chains.IDS : ['solana', 'base', 'bsc'];
  const U = new Map(); // key -> record
  const stateFile = path.join(DATA_DIR, 'live_state.json');
  const feedFile = path.join(DATA_DIR, 'live_feed.json');
  let model = null, themes = [], smart = new Map();
  const gv2 = createGradeV2({ DATA_DIR });
  let feedMemo = { k: null, src: null, v: null };
  let weights = { ...BASE_WEIGHTS };
  const st = { cycles: 0, lastCycle: 0, lastError: null, sources: {}, scans: 0, deepScans: 0, startedAt: Date.now(), mode: MODE };
  const listeners = [];
  let gtRot = 0, timer = null, running = false, feed = { items: [], generatedAt: 0 };

  function loadModel() {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'live_model.json'), 'utf8'));
      model = m.model; themes = (m.themes || []).map(([t, rx]) => [t, new RegExp(rx.replace(/\(\?i\)/, ''), 'i')]);
      smart = new Map((m.smartWallets || []).map((w) => [w.wallet.toLowerCase(), w]));
    } catch (e) { log('live: no live_model.json (' + e.message + ')'); }
    try { const w = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'live_weights.json'), 'utf8')); if (w.active) weights = w.active; } catch {}
  }
  function load() {
    loadModel();
    try { for (const r of JSON.parse(fs.readFileSync(stateFile, 'utf8')).records || []) U.set(r.key, r); } catch {}
    try { feed = JSON.parse(fs.readFileSync(feedFile, 'utf8')); } catch {}
  }
  const keyOf = (chain, a) => chain + ':' + (chains.CHAINS[chain]?.kind === 'evm' ? a.toLowerCase() : a);
  function upsert(chain, address, src, extra = {}) {
    if (!chain || !address || !chains.isChain(chain) || !CH.includes(chain)) return;
    if (!chains.validAddr(chain, address)) return;
    const k = keyOf(chain, address);
    let r = U.get(k);
    if (!r) { r = { key: k, chain, address, firstSeen: Date.now(), sources: [], snaps: [], holdersHist: [] }; U.set(k, r); }
    if (!r.sources.includes(src)) r.sources.push(src);
    r.lastSeenTrending = Date.now();
    Object.assign(r, extra);
  }
  const theme = (name, sym) => { const s = `${name || ''} ${sym || ''}`; for (const [t, rx] of themes) if (rx.test(s)) return t; return 'other'; };

  // ---------------- discovery ----------------
  async function discover() {
    const S = st.sources;
    const tryS = async (name, fn) => { try { const n = await fn(); S[name] = { ok: true, n, at: Date.now() }; } catch (e) { S[name] = { ok: false, err: String(e.message).slice(0, 120), at: Date.now() }; } };
    await tryS('DexScreener profiles', async () => { const d = await cached('lf:dsprof', 55e3, () => getJSON(DS + '/token-profiles/latest/v1')); for (const x of d || []) upsert(x.chainId, x.tokenAddress, 'ds-profile', { dsProfileAt: r0(x) }); return (d || []).length; });
    await tryS('DexScreener boosts (latest)', async () => { const d = await cached('lf:dsbl', 55e3, () => getJSON(DS + '/token-boosts/latest/v1')); for (const x of d || []) upsert(x.chainId, x.tokenAddress, 'ds-boost', { boostAmt: x.totalAmount || x.amount }); return (d || []).length; });
    await tryS('DexScreener boosts (top)', async () => { const d = await cached('lf:dsbt', 55e3, () => getJSON(DS + '/token-boosts/top/v1')); for (const x of d || []) upsert(x.chainId, x.tokenAddress, 'ds-topboost', { boostAmt: x.totalAmount || x.amount }); return (d || []).length; });
    await tryS('DexScreener community takeovers', async () => { const d = await cached('lf:dscto', 55e3, () => getJSON(DS + '/community-takeovers/latest/v1')); for (const x of d || []) upsert(x.chainId, x.tokenAddress, 'ds-cto'); return (d || []).length; });
    for (const [c, a, sym] of PINNED) upsert(c, a, 'pinned', { pinned: sym }); // always-tracked tokens
    if (CH.includes('solana')) {
      await tryS('pump.fun new', async () => { const d = await cached('lf:pumpnew', 55e3, () => getJSON('https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false', UA)); for (const c of d || []) if ((c.usd_market_cap || 0) > 8000) upsert('solana', c.mint, 'pump-new', { creator: c.creator, launchpad: 'pump.fun', createdAt: c.created_timestamp }); return (d || []).length; });
      await tryS('pump.fun graduated', async () => { const d = await cached('lf:pumpgrad', 55e3, () => getJSON('https://frontend-api-v3.pump.fun/coins?offset=0&limit=30&sort=last_trade_timestamp&order=DESC&includeNsfw=false&complete=true', UA)); for (const c of d || []) upsert('solana', c.mint, 'pump-graduated', { creator: c.creator, launchpad: 'pump.fun', createdAt: c.created_timestamp }); return (d || []).length; });
      await tryS('StonkFun newest', async () => { const d = await cached('lf:stonk', 55e3, () => getJSON('https://www.stonkfun.xyz/api/public/v1/tokens?sort=newest&pageSize=30', UA)); const t = d?.data?.tokens || []; for (const x of t) upsert('solana', x.mint, 'stonkfun', { launchpad: 'stonk', createdAt: x.createdAt ? Date.parse(x.createdAt) : null }); return t.length; });
    }
    if (process.env.FOMOAPI_KEY && CH.includes('solana')) S['Fomo'] = { ok: false, err: 'key set but not wired into the live loop (1,000 calls/month budget)', at: Date.now() };
    else S['Fomo'] = { ok: false, err: 'no public feed (fomoapi.io needs a key)', at: Date.now() };
    // GeckoTerminal: 30 req/min shared with the UI -> rotate a few calls per cycle
    const jobs = [];
    for (const c of CH) { const g = chains.CHAINS[c].gt; jobs.push([c, `${GT}/networks/${g}/new_pools?page=1`, 'gt-new'], [c, `${GT}/networks/${g}/trending_pools?page=1`, 'gt-trending']); }
    if (CH.includes('bsc')) jobs.push(['bsc', `${GT}/networks/bsc/dexes/four-meme/pools?page=1&sort=h24_tx_count_desc`, 'four.meme']);
    const per = FULL ? 4 : 2;
    for (let i = 0; i < per; i++) {
      const [c, url, src] = jobs[gtRot++ % jobs.length];
      await tryS(`GeckoTerminal ${src} ${c}`, async () => {
        const d = await gtGet(url);
        for (const p of d?.data || []) {
          const id = p.relationships?.base_token?.data?.id || ''; const a = id.slice(id.indexOf('_') + 1);
          const tx = p.attributes?.transactions || {};
          upsert(c, a, src, { gt: { at: Date.now(), pool: p.attributes?.address, h1: tx.h1, h24: tx.h24, m5: tx.m5 }, poolCreatedAt: Date.parse(p.attributes?.pool_created_at) || undefined });
        }
        return (d?.data || []).length;
      });
    }
  }
  const r0 = () => Date.now();

  // ---------------- market refresh (DexScreener batch, 30 tokens/call) ----------------
  async function refreshMarket() {
    const by = {};
    const recs = [...U.values()].sort((a, b) => (b.prio || 0) - (a.prio || 0)).slice(0, FULL ? 900 : 180);
    for (const r of recs) (by[r.chain] ||= []).push(r);
    for (const [c, rs] of Object.entries(by)) {
      let map = {};
      try { map = await dsTokens(c, rs.map((r) => r.address)); } catch (e) { continue; }
      for (const r of rs) {
        const p = map[r.address]; if (!p) { r.noPair = (r.noPair || 0) + 1; continue; }
        r.noPair = 0;
        r.pair = { url: p.url, pairAddress: p.pairAddress, dexId: p.dexId, name: p.name, symbol: p.symbol, imageUrl: p.imageUrl, quoteSymbol: p.quoteSymbol, socials: (p.socials || []).map((s) => ({ type: s.type, url: s.url })), websites: (p.websites || []).map((w) => w.url).slice(0, 2), boosts: p.boosts, pairCreatedAt: p.pairCreatedAt };
        const snap = { t: Date.now(), px: p.priceUsd, liq: p.liquidityUsd, fdv: p.fdv, mc: p.marketCap, v: p.volume, tx: p.txns, ch: p.change };
        r.snaps.push(snap); if (r.snaps.length > 90) r.snaps.splice(0, r.snaps.length - 90);
        r.m = snap;
      }
    }
  }

  // ---------------- dev history (pump.fun creator) ----------------
  async function devHistory(r) {
    if (!r.creator || r.dev) return;
    try {
      const d = await cached('lf:dev:' + r.creator, 3600e3, () => getJSON(`https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&creator=${r.creator}&includeNsfw=true`, UA));
      const mine = (d || []).filter((c) => c.creator === r.creator && c.mint !== r.address);
      r.dev = { prior: mine.length, graduated: mine.filter((c) => c.complete).length, bestMcap: Math.max(0, ...mine.map((c) => c.usd_market_cap || 0)) };
    } catch {}
  }

  // ---------------- scanning ----------------
  function priority(r) {
    const now = Date.now(); const m = r.m || {};
    const created = r.pair?.pairCreatedAt || r.poolCreatedAt || r.createdAt || r.firstSeen;
    const ageH = (now - created) / H;
    const mv = Math.abs(m.ch?.m5 || 0) + Math.abs(m.ch?.h1 || 0) / 3;
    const vol = Math.log10(1 + (m.v?.h1 || 0));
    return (r.scan ? 0 : 30) + Math.max(0, 24 - ageH) + mv / 5 + vol * 3 + (r.boostAmt ? 3 : 0);
  }
  function needsScan(r) {
    if (!r.m || (r.m.liq || 0) < 3000) return false;
    if (!r.scan) return true;
    const age = Date.now() - r.scannedAt;
    const mover = Math.abs(r.m.ch?.m5 || 0) > 10 || Math.abs(r.m.ch?.h1 || 0) > 30;
    return age > (mover ? 5 * 60e3 : 30 * 60e3);
  }
  async function scanOne(r, deep) {
    try {
      const res = await scan(r.chain, r.address, deep);
      st.scans++; if (deep) st.deepScans++;
      const get = (id) => res.checks.find((c) => c.id === id);
      const holdersTxt = get('holders')?.detail || ''; const hm = holdersTxt.replace(/,/g, '').match(/(\d+)\s+holders/);
      if (hm) { r.holdersHist.push({ t: Date.now(), n: +hm[1] }); if (r.holdersHist.length > 60) r.holdersHist.shift(); }
      const tops = get('top10')?.evidence?.top || get('top10')?.evidence?.holders || [];
      whalewatch.snapshot(r, tops);
      const owners = tops.map((h) => (h.owner || h.a || '').toLowerCase()).filter(Boolean);
      const sm = owners.filter((w) => smart.has(w)).map((w) => smart.get(w));
      r.scan = { riskScore: res.riskScore, overall: res.overall, counts: res.counts, checks: res.checks.map((c) => ({ id: c.id, group: c.group, title: c.title, level: c.level, detail: c.detail })), deep: !!deep || !!r.scan?.deep, smart: sm.map((w) => ({ wallet: w.wallet, tokens: w.tokens })), name: res.token?.name, symbol: res.token?.symbol };
      if (!r.creator) { const ce = (res.checks || []).find((c) => c.id === 'creator' || c.id === 'bundle'); r.creator = ce?.evidence?.creator || csCreator(r.chain, r.address) || null; }
      r.scannedAt = Date.now(); if (deep) r.deepAt = Date.now();
    } catch (e) { r.scanErr = String(e.message).slice(0, 120); r.scannedAt = Date.now(); }
  }

  // ---------------- scoring ----------------
  function themeHeat(recs) {
    const heat = {}, sym = {};
    for (const r of recs) {
      if (!r.m) continue;
      const t = theme(r.pair?.name, r.pair?.symbol); r.theme = t;
      const hot = (r.m.ch?.h1 || 0) > 20 || (r.m.v?.h1 || 0) > 100000;
      heat[t] = (heat[t] || 0) + (hot ? 1 : 0.1);
      const s = (r.pair?.symbol || '').toUpperCase(); if (s) (sym[s] ||= new Set()).add(r.chain);
    }
    const mx = Math.max(1, ...Object.entries(heat).filter(([t]) => t !== 'other').map(([, v]) => v));
    return { heat, mx, sym };
  }
  function similarity(r) {
    if (!model || r.chain !== 'solana') return null;
    const name = r.pair?.name || '', sym = r.pair?.symbol || '';
    const created = r.createdAt || r.pair?.pairCreatedAt || r.firstSeen; const d = new Date(created);
    const soc = r.pair?.socials || [];
    const f = { launch_hour_utc: d.getUTCHours(), launch_dow: d.getUTCDay() === 0 ? 6 : d.getUTCDay() - 1, ticker_len: sym.length, name_len: name.length,
      dev_prior_tokens: r.dev?.prior, dev_prior_best_mcap: r.dev?.bestMcap, launchpad: r.launchpad || (/pump/.test(r.pair?.dexId || '') ? 'pump.fun' : null), theme: r.theme,
      has_twitter: soc.some((s) => s.type === 'twitter') ? 1 : 0, has_telegram: soc.some((s) => s.type === 'telegram') ? 1 : 0, has_website: (r.pair?.websites || []).length ? 1 : 0,
      name_has_digit: /\d/.test(name) ? 1 : 0, ticker_upper: sym && sym === sym.toUpperCase() ? 1 : 0 };
    let s = 0; const parts = [];
    for (const [k, m] of Object.entries(model.num || {})) { const x = f[k]; if (x == null) continue; const i = m.edges.filter((e) => x > e).length; const v = Math.max(-1.5, Math.min(1.5, m.lr[i])); s += v; parts.push([k, v]); }
    for (const [k, m] of Object.entries(model.cat || {})) { const x = f[k]; if (x == null || !(String(x) in m) && !(String(x) + '.0' in m)) continue; const v = Math.max(-1.5, Math.min(1.5, m[String(x)] ?? m[String(x) + '.0'])); s += v; parts.push([k, v]); }
    return { p: 100 / (1 + Math.exp(-s)), parts: parts.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4) };
  }
  const VETO = { mint: 'mint authority enabled', freeze: 'freeze authority enabled', honeypot: 'honeypot signs', tax: 'buy/sell tax >10%', ext: 'dangerous Token-2022 extension', bundle: 'bundled launch', quoteside: 'fake liquidity (quote side)', owner: 'owner can change balances' };
  function score(r, ctx) {
    const m = r.m || {}; const now = Date.now();
    const created = r.pair?.pairCreatedAt || r.poolCreatedAt || r.createdAt || r.firstSeen; const ageH = (now - created) / H;
    const b1 = m.tx?.h1?.buys || 0, s1 = m.tx?.h1?.sells || 0; const bp = b1 + s1 ? b1 / (b1 + s1) : null;
    const accel = (m.v?.h1 || 0) > 0 ? ((m.v?.m5 || 0) * 12) / m.v.h1 : null;
    const accel6 = (m.v?.h6 || 0) > 0 ? ((m.v?.h1 || 0) * 6) / m.v.h6 : null;
    const ub = r.gt?.h1?.buyers ?? null, us = r.gt?.h1?.sellers ?? null;
    const first = r.snaps[0], hourAgo = [...r.snaps].reverse().find((s) => now - s.t >= 50 * 60e3) || first;
    const liqCh = first?.liq && m.liq ? (m.liq / first.liq - 1) * 100 : null;
    const liqCh1h = hourAgo?.liq && m.liq ? (m.liq / hourAgo.liq - 1) * 100 : null;
    const hh = r.holdersHist; let hVel = null;
    if (hh.length >= 2 && hh[hh.length - 1].t - hh[0].t > 10 * 60e3) hVel = (hh[hh.length - 1].n - hh[0].n) / ((hh[hh.length - 1].t - hh[0].t) / H);
    const holders = hh.length ? hh[hh.length - 1].n : null;
    const sim = similarity(r);
    const th = r.theme || 'other'; const tHeat = th === 'other' ? 0 : (ctx.heat[th] || 0) / ctx.mx;
    const xchain = ctx.sym[(r.pair?.symbol || '').toUpperCase()]?.size || 1;
    const soc = r.pair?.socials || [];
    const C = {
      flow: (clip(bp == null ? 0.5 : (bp - 0.45) / 0.25) + clip(accel == null ? 0.3 : Math.log2(Math.max(accel, 0.01)) / 2 + 0.5) + clip((m.ch?.h1 || 0) > 300 ? 0.3 : (m.ch?.h1 || 0) / 60 + 0.35)) / 3,
      participation: (clip(Math.log10(1 + (ub ?? b1)) / 2.7) + (hVel != null ? clip(Math.log10(1 + Math.max(0, hVel)) / 2.5) : clip(Math.log10(1 + (holders || 0)) / 3.5))) / 2,
      safety: r.scan ? clip(1 - r.scan.riskScore / 100) : 0.3,
      upside: (m.fdv > 0 ? clip(1 - Math.abs(Math.log10(m.fdv) - 5.5) / 2) : 0) * clip(Math.log10(Math.max(m.liq || 1, 1) / 5000) / 1.5 + 0.2),
      similarity: sim ? sim.p / 100 : 0.5,
      narrative: clip(tHeat + (xchain > 1 ? 0.3 : 0)),
      smart: clip((r.scan?.smart?.length || 0) / 2),
      attention: clip(((r.boostAmt || m.boosts ? 0.4 : 0) + (soc.length >= 2 ? 0.4 : soc.length ? 0.2 : 0) + ((r.pair?.websites || []).length ? 0.2 : 0))),
    };
    let sc = 0; const wsum = Object.values(weights).reduce((a, b) => a + b, 0);
    for (const [k, w] of Object.entries(weights)) sc += (w * (C[k] || 0)) * (100 / wsum);
    const reasons = [], flags = [];
    if (bp != null) reasons.push(`buys ${Math.round(bp * 100)}% of h1 txns (${b1}/${b1 + s1})`);
    if (ub != null) reasons.push(`${ub} unique buyers vs ${us} sellers in 1h`);
    if (accel != null) reasons.push(`volume accel ${accel.toFixed(1)}x (5m vs 1h pace)`);
    if (hVel != null) reasons.push(`holders ${hVel >= 0 ? '+' : ''}${Math.round(hVel)}/h (${holders})`); else if (holders) reasons.push(`${holders} holders`);
    if (liqCh1h != null && Math.abs(liqCh1h) > 15) reasons.push(`liquidity ${liqCh1h > 0 ? '+' : ''}${liqCh1h.toFixed(0)}% in ~1h`);
    if (r.dev) reasons.push(`dev: ${r.dev.prior} prior launches, ${r.dev.graduated} graduated`);
    if (r.scan?.smart?.length) reasons.push(`smart-money wallet(s) in top holders: ${r.scan.smart.map((s) => s.tokens.slice(0, 2).join('/')).join('; ')}`);
    if (tHeat > 0.5) reasons.push(`hot meta: ${th}`);
    if (xchain > 1) reasons.push(`same ticker live on ${xchain} chains`);
    if (sim) reasons.push(`moonshot similarity ${Math.round(sim.p)}%`);
    if (r.boostAmt) reasons.push(`DexScreener boost ${r.boostAmt}`);
    // veto
    let veto = null;
    if (!m.liq || m.liq < 3000) veto = 'liquidity under $3K';
    for (const c of r.scan?.checks || []) if (c.level === 'red' && VETO[c.id]) { veto = VETO[c.id]; flags.push(c.title + ': ' + c.detail.slice(0, 100)); }
    const top = r.scan?.checks?.find((c) => c.id === 'top10'); const t10 = top && +((top.detail.match(/hold ([\d.]+)%/) || [])[1]);
    if (t10 > 60) veto = veto || `top-10 wallets hold ${t10}%`;
    if (liqCh != null && liqCh < -70 && first && now - first.t < 2 * D) veto = veto || `liquidity down ${liqCh.toFixed(0)}% since first seen (pull?)`;
    sc = Math.round(sc * 10) / 10;
    let grade = sc >= 72 ? 'A' : sc >= 60 ? 'B' : sc >= 48 ? 'C' : sc >= 36 ? 'D' : 'F';
    if (veto) grade = 'F';
    else if (grade === 'A' && (!r.scan || r.scan.overall === 'red')) grade = 'B';
    return { score: sc, grade, veto, reasons, flags, components: Object.fromEntries(Object.entries(C).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      features: { ageH: +ageH.toFixed(2), bp, accel, accel6, ub, us, b1, s1, holders, hVel, liqCh, liqCh1h, fdv: m.fdv, liq: m.liq, v1h: m.v?.h1, v24: m.v?.h24, ch5: m.ch?.m5, ch1: m.ch?.h1, ch24: m.ch?.h24, risk: r.scan?.riskScore, smart: r.scan?.smart?.length || 0, theme: th, themeHeat: +tHeat.toFixed(2), xchain, sim: sim ? Math.round(sim.p) : null, devPrior: r.dev?.prior, devGrad: r.dev?.graduated, dev: r.creator || null, boosts: r.boostAmt || 0, socials: soc.length, hourUtc: new Date().getUTCHours(), dow: new Date().getUTCDay() } };
  }

  // ---------------- cycle ----------------
  async function cycle() {
    if (running) return; running = true; const t0 = Date.now();
    try {
      await discover();
      for (const r of U.values()) r.prio = priority(r);
      await refreshMarket();
      // prune
      const now = Date.now();
      for (const [k, r] of U) {
        const created = r.pair?.pairCreatedAt || r.poolCreatedAt || r.createdAt || r.firstSeen;
        const trending = now - (r.lastSeenTrending || 0) < 6 * H;
        if ((now - created > 7 * D && !trending) || (r.noPair > 5) || (r.m && r.m.liq < 1000 && now - r.firstSeen > 2 * H)) U.delete(k);
      }
      if (U.size > (FULL ? 900 : 250)) [...U.values()].sort((a, b) => a.prio - b.prio).slice(0, U.size - (FULL ? 900 : 250)).forEach((r) => U.delete(r.key));
      // scans (priority queue: newest + fastest-moving first)
      const q = [...U.values()].filter(needsScan).sort((a, b) => priority(b) - priority(a)).slice(0, FULL ? 8 : 3);
      for (let i = 0; i < q.length; i += 2) await Promise.all(q.slice(i, i + 2).map(async (r) => { await devHistory(r); await scanOne(r, false); }));
      // score
      const ctx = themeHeat(U.values());
      const prev = new Map(feed.items.map((x) => [x.key, x.grade]));
      const items = [];
      for (const r of U.values()) {
        if (!r.m) continue;
        if (!r.creator) r.creator = csCreator(r.chain, r.address) || null;
        const s = score(r, ctx);
        // Rug Risk Forecast: veto at >= 70, penalty + A->B cap at >= 45
        // Nansen (cached reads only here, zero credits): smart-money / whale / exchange flows
        const nf = o.nansen ? o.nansen.peekFlow(r.chain, r.address) : null; const snf = o.nansen ? o.nansen.netflowFor(r.chain, r.address) : null;
        if (nf || snf) {
          let adj = 0;
          if (nf && nf.smart > 1000 && nf.smartWallets >= 2) { adj += 5; s.reasons.push(`Nansen: ${nf.smartWallets} smart wallets net +$${Math.round(nf.smart).toLocaleString()} (24h)`); }
          if (nf && nf.smart < -1000) { adj -= 5; s.flags.push(`Nansen: smart money net -$${Math.round(-nf.smart).toLocaleString()} (24h)`); }
          if (snf && (snf.net_flow_24h_usd || 0) > 0) { adj += 3; s.reasons.push(`Nansen smart-money netflow 24h +$${Math.round(snf.net_flow_24h_usd).toLocaleString()} (${snf.trader_count} traders)`); }
          if (nf && m0(r).liq && nf.whale < -0.1 * m0(r).liq) s.flags.push(`Nansen: whales net sold $${Math.round(-nf.whale).toLocaleString()} (24h)`);
          if (adj) { s.score = Math.round((s.score + adj) * 10) / 10; if (!s.veto) s.grade = s.score >= 72 ? (r.scan && r.scan.overall !== 'red' ? 'A' : 'B') : s.score >= 60 ? 'B' : s.score >= 48 ? 'C' : s.score >= 36 ? 'D' : 'F'; }
          s.components.nansen = nf ? { smart: Math.round(nf.smart), whale: Math.round(nf.whale), exchange: Math.round(nf.exchange), fresh: Math.round(nf.fresh), at: nf.at } : null;
        }
        let rug = null; try { rug = o.rug ? o.rug.assess(r, nf ? { nansen: nf } : {}) : null; } catch (e) { log('rug assess: ' + e.message); }
        if (rug) {
          if (rug.score >= 70 && !s.veto) { s.veto = `rug forecast ${rug.score}/100 (${rug.likelyTypes.join(', ')})`; s.grade = 'F'; s.flags.push('Rug forecast: ' + rug.signals.slice(0, 2).map((x) => x.why).join('; ')); }
          else if (rug.score >= 45) { s.score = Math.round((s.score - 10) * 10) / 10; if (s.grade === 'A') s.grade = 'B'; s.flags.push(`Rug forecast ${rug.score}/100: ` + rug.signals[0].why); }
          if (rug.dump30) s.flags.push('Dump risk next 30 days');
        }
        s.rug = rug ? { score: rug.score, level: rug.level, dump30: rug.dump30, types: rug.likelyTypes, top: rug.signals.slice(0, 4).map((x) => x.why) } : null;
        if (rug && (rug.score >= 25 || rug.dump30)) {
          const sn = r.snaps || []; const pxs = sn.map((x) => x.px).filter(Boolean); const mm = m0(r);
          const t10 = +(((r.scan?.checks || []).find((c) => c.id === 'top10')?.detail || '').match(/hold ([\d.]+)%/) || [])[1] || null;
          const old6 = sn.find((x) => Date.now() - x.t < 6 * 3600e3) || sn[0];
          const ex = exitPlan({ symbol: r.pair?.symbol || r.scan?.symbol, price: mm.px, high: pxs.length ? Math.max(...pxs) : mm.px, atrPct: atrFromMarket(mm, sn), rug,
            facts: { circRatio: mm.mc && mm.fdv && mm.fdv > mm.mc * 1.05 ? mm.mc / mm.fdv : null, top10Pct: t10, runMultiple: pxs.length ? mm.px / Math.min(...pxs) : null, runDays: sn.length ? Math.max(1, Math.round((Date.now() - sn[0].t) / 86400e3)) : null,
              insiderToExchanges: (rug.signals.find((x) => /exchanges|into the DEX pair|DEX pairs/.test(x.why)) || {}).why || null,
              liqDropPct: old6?.liq && mm.liq ? Math.max(0, (1 - mm.liq / old6.liq) * 100) : null, whaleExit: whalewatch.exits(r), holdersFallingWhilePriceUp: rug.signals.some((x) => /holders down/.test(x.why)) } });
          s.exit = { level: ex.level, text: ex.text, sms: ex.sms, ladder: ex.ladder.map((l) => ({ pct: l.pct, price: l.price, gain: Math.round(l.gain), note: l.note })), trail: ex.trail, trailPct: Math.round(ex.trailPct * 100), triggers: ex.triggers, triggered: ex.triggered, atrPct: Math.round(ex.atrPct), label: ex.label };
        }
        r.last = s;
        items.push({ key: r.key, chain: r.chain, address: r.address, name: r.pair?.name || r.scan?.name, symbol: r.pair?.symbol || r.scan?.symbol, image: r.pair?.imageUrl, url: r.pair?.url, dex: r.pair?.dexId,
          price: r.m.px, mAt: r.m.t, pairAddress: r.pair?.pairAddress, fdv: r.m.fdv, // mAt/pairAddress: provenance (lib/provenance_map.js)
          mcap: r.m.mc, liq: r.m.liq, vol1h: r.m.v?.h1, vol24: r.m.v?.h24, ch5: r.m.ch?.m5, ch1: r.m.ch?.h1, ch24: r.m.ch?.h24,
          ageH: s.features.ageH, creator: r.creator || null, sources: r.sources, scanned: !!r.scan, scannedAt: r.scannedAt, risk: r.scan?.riskScore, overall: r.scan?.overall, deep: r.scan?.deep,
          ...s, firstGradedAt: r.firstGradedAt || (r.firstGradedAt = Date.now()) });
        gv2.regrade(items[items.length - 1], { rugScore: rug?.score }); // grade v2 replaces the legacy letter (legacyGrade/legacyScore kept)
      }
      if (o.rug && st.cycles % 5 === 0) { try { await o.rug.monitor(items.filter((x) => x.grade !== 'F').slice(0, 30).map((x) => U.get(x.key))); } catch (e) { log('rug monitor: ' + e.message); } }
      // deep scan the best Solana candidate (bundles/snipers need many RPC calls)
      if (FULL) { const best = items.filter((x) => x.chain === 'solana' && (x.grade === 'A' || x.grade === 'B')).sort((a, b) => b.score - a.score).map((x) => U.get(x.key)).find((r) => !r.deepAt || now - r.deepAt > 30 * 60e3); if (best) await scanOne(best, true); }
      items.sort((a, b) => b.score - a.score);
      // Nansen spend: only A/B candidates without a cached flow read, max 2 per cycle (daily sub-cap enforced in lib/nansen.js)
      if (o.nansen?.enabled) { const need = items.filter((x) => (x.grade === 'A' || x.grade === 'B') && !x.veto && o.nansen.CH[x.chain] && !o.nansen.peekFlow(x.chain, x.address)).slice(0, 2); for (const x of need) { const res = await o.nansen.flow(x.chain, x.address, '1d', 'flow_live'); if (res.skipped === 'budget') break; } }
      const newA = items.filter((x) => x.grade === 'A' && prev.get(x.key) !== 'A');
      feed = { generatedAt: Date.now(), mode: MODE, chains: CH, universe: U.size, scanned: items.filter((x) => x.scanned).length, grades: items.reduce((g, x) => ((g[x.grade] = (g[x.grade] || 0) + 1), g), {}), weights, items: items.slice(0, 400), newA: newA.map((x) => x.key), sources: st.sources, disclaimer: 'Automated estimates from public data, not financial advice.' };
      fs.writeFileSync(feedFile + '.tmp', JSON.stringify(feed)); fs.renameSync(feedFile + '.tmp', feedFile);
      if (st.cycles % 5 === 0) { fs.writeFileSync(stateFile + '.tmp', JSON.stringify({ savedAt: Date.now(), records: [...U.values()] })); fs.renameSync(stateFile + '.tmp', stateFile); }
      st.cycles++; st.lastCycle = Date.now(); st.lastCycleMs = Date.now() - t0; st.lastError = null;
      for (const fn of listeners) { try { await fn(feed, items, newA); } catch (e) { log('live listener: ' + e.message); } }
    } catch (e) { st.lastError = e.message; log('live cycle error: ' + e.stack); }
    finally { running = false; }
  }
  return {
    start(intervalMs = 60e3) { load(); const loop = async () => { await cycle(); timer = setTimeout(loop, intervalMs); }; timer = setTimeout(loop, 2000); },
    stop() { clearTimeout(timer); },
    // served feed is always re-graded with the current grade v2 file (also covers the frozen RENDER_LITE snapshot written by older code)
    feed: () => { const gi = gv2.info(); const k = feed.generatedAt + ':' + (gi.generatedAt || 0);
      if (feedMemo.k !== k || feedMemo.src !== feed) { const items = (feed.items || []).map((x) => gv2.regrade({ ...x })); feedMemo = { k, src: feed, v: { ...feed, items, grades: items.reduce((g, x) => ((g[x.grade] = (g[x.grade] || 0) + 1), g), {}), gradeModel: gi } }; }
      return feedMemo.v; },
    gradeInfo: () => gv2.info(), status: () => ({ ...st, universe: U.size }),
    token: (key) => { const r = U.get(key); if (!r) return null; return { ...r, snaps: r.snaps.slice(-60) }; },
    onCycle: (fn) => listeners.push(fn), reloadModel: loadModel, setWeights: (w) => { weights = { ...w }; }, getWeights: () => weights, BASE_WEIGHTS, cycle,
  };
}
module.exports = { createLiveFeed, BASE_WEIGHTS };
