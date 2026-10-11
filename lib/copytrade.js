'use strict';
// Copy-trade watch (ALERTS ONLY — this module never builds, signs or sends a trade).
// Wallet list: data/copytrade.json from research/copytrade.py (free sources: pump.fun trade tape of catalog runners, kolscan
// public leaderboard, on-disk Nansen labels, public RPC verification). Monitor: polls getSignaturesForAddress for the top
// Solana wallets in small batches on the shared throttled RPC client, parses new swaps (lib/mev.js deltas/asSwap) and records
// entries/exits. Flags tokens the terminal watches (live feed universe + ALERT_WATCH) and new low-cap tokens. Text alerts go
// through the existing capped path (alerts.notice -> deliver: hourly cap, quiet hours, DRY RUN unless ALERTS_LIVE=1) and only
// when >= COPYTRADE_MIN_WALLETS (2) top wallets entered the same watched token within COPYTRADE_WINDOW_H (6h).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { rpcFor } = require('./solrpc');
const { cached, getJSON } = require('./util');
const mev = require('./mev');

const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

function createCopyTrade({ DATA_DIR, root, live, alerts, log = () => {} }) {
  const E = process.env;
  const cfg = { tickMs: +(E.COPYTRADE_MS || 60e3), batch: +(E.COPYTRADE_BATCH || 8), maxTxPerWallet: +(E.COPYTRADE_MAX_TX || 4), topN: +(E.COPYTRADE_TOP || 50),
    minWallets: +(E.COPYTRADE_MIN_WALLETS || 2), windowH: +(E.COPYTRADE_WINDOW_H || 6), lowCap: +(E.COPYTRADE_LOWCAP || 5e6), minCap: +(E.COPYTRADE_MINCAP || 3e4), newAgeH: +(E.COPYTRADE_NEW_AGE_H || 168), minSol: +(E.COPYTRADE_MIN_SOL || 1), minTrackSol: +(E.COPYTRADE_MIN_TRACK_SOL || 50), refreshH: +(E.COPYTRADE_REFRESH_H || 2) };
  const F = (f) => path.join(DATA_DIR, f);
  const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(F(f), 'utf8')); } catch { return d; } };
  let S = readJ('copytrade_state.json', { cursors: {}, polled: {} });
  let EV = readJ('copytrade_events.json', { events: [] }).events || [];
  let mem = { m: 0, d: null }, timer = null, idx = 0, running = false, refreshing = false;
  const stat = { started: null, ticks: 0, lastTick: null, polledWallets: 0, txParsed: 0, swaps: 0, errors: 0, lastError: null, alertsTried: 0 };
  const save = () => { try { fs.writeFileSync(F('copytrade_state.json'), JSON.stringify(S)); fs.writeFileSync(F('copytrade_events.json'), JSON.stringify({ events: EV.slice(-800) })); } catch {} };
  function data() { try { const st = fs.statSync(F('copytrade.json')); if (mem.m !== st.mtimeMs) mem = { m: st.mtimeMs, d: JSON.parse(fs.readFileSync(F('copytrade.json'), 'utf8')) }; } catch {} return mem.d; }
  function wallets() { const d = data(); return ((d && d.chains && d.chains.solana && d.chains.solana.wallets) || []).slice(0, cfg.topN); }
  const byAddr = () => Object.fromEntries(wallets().map((w) => [w.address, w]));
  function watchedSet() {
    const s = new Set((E.ALERT_WATCH || '').split(',').map((x) => x.trim()).filter(Boolean));
    try { for (const it of live.feed().items || []) s.add(it.key); } catch {}
    return s;
  }
  async function tokenInfo(mint) {
    return cached('ct:ds:' + mint, 10 * 60e3, async () => {
      try {
        const a = await getJSON('https://api.dexscreener.com/tokens/v1/solana/' + mint, {}, 10000);
        const p = (Array.isArray(a) ? a : []).sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))[0];
        if (!p) return { symbol: null };
        return { symbol: p.baseToken?.address === mint ? p.baseToken.symbol : p.quoteToken?.symbol, mcap: p.marketCap || p.fdv || null, liq: p.liquidity?.usd || null, ageH: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3600e3 : null, url: p.url };
      } catch { return { symbol: null }; }
    });
  }
  async function solUsd() { return cached('ct:solusd', 10 * 60e3, async () => { try { const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'); return j.solana.usd; } catch { return 150; } }); }

  async function pollWallet(rpc, w) {
    const a = w.address; const first = !S.cursors[a];
    const opts = { limit: first ? 10 : 25 }; if (!first) opts.until = S.cursors[a];
    const sigs = await rpc.call('getSignaturesForAddress', [a, opts]);
    S.polled[a] = Date.now(); stat.polledWallets++;
    if (!sigs.length) return;
    S.cursors[a] = sigs[0].signature;
    const fresh = sigs.filter((s) => !s.err && (!first || Date.now() / 1000 - (s.blockTime || 0) < 2 * 3600)).slice(0, cfg.maxTxPerWallet);
    const px = await solUsd();
    for (const s of fresh.reverse()) {
      let tx; try { tx = await rpc.call('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]); } catch (e) { stat.errors++; continue; }
      stat.txParsed++;
      if (!tx || !tx.meta) continue;
      const sw = mev.asSwap(mev.deltas(tx, a)); if (!sw) continue;
      const quote = (m) => m === WSOL || STABLES.has(m);
      let side, mint, quoteAmt, qm, qty;
      if (quote(sw.inMint) && !quote(sw.outMint)) { side = 'buy'; mint = sw.outMint; quoteAmt = sw.inUi; qm = sw.inMint; qty = sw.outUi; }
      else if (quote(sw.outMint) && !quote(sw.inMint)) { side = 'sell'; mint = sw.inMint; quoteAmt = sw.outUi; qm = sw.outMint; qty = sw.inUi; }
      else continue;
      stat.swaps++;
      const sol = qm === WSOL ? quoteAmt : quoteAmt / px;
      const ti = await tokenInfo(mint);
      const key = 'solana:' + mint; const watched = watchedSet().has(key);
      const lowCapNew = ti.mcap != null && ti.mcap < cfg.lowCap && ti.mcap >= cfg.minCap && (ti.ageH == null || ti.ageH <= cfg.newAgeH);
      const ev = { t: (tx.blockTime || 0) * 1000, sig: s.signature, wallet: a, rank: w.rank, name: w.name || null, side, mint, symbol: ti.symbol, sol: +sol.toFixed(3), usd: Math.round(sol * px), qty,
        mcap: ti.mcap, ageH: ti.ageH != null ? +ti.ageH.toFixed(1) : null, watched, lowCapNew, baseline: first,
        track: { score: w.score, realizedSol: w.realizedSol, winRate: w.winRate, closedTrades: w.closedTrades } };
      if (!EV.some((x) => x.sig === ev.sig && x.wallet === a)) EV.push(ev);
    }
  }
  function confluence() {
    const since = Date.now() - cfg.windowH * 3600e3; const g = {};
    for (const e of EV) { if (e.side !== 'buy' || e.t < since) continue; const x = (g[e.mint] ||= { mint: e.mint, symbol: e.symbol, mcap: e.mcap, watched: false, lowCapNew: false, wallets: {} }); x.watched ||= e.watched; x.lowCapNew ||= e.lowCapNew; x.mcap = e.mcap ?? x.mcap; const w = (x.wallets[e.wallet] ||= { wallet: e.wallet, rank: e.rank, name: e.name, sol: 0, track: e.track }); w.sol += e.sol; }
    return Object.values(g).map((x) => ({ ...x, wallets: Object.values(x.wallets).sort((a, b) => a.rank - b.rank), n: Object.keys(x.wallets).length })).filter((x) => x.n >= 1).sort((a, b) => b.n - a.n || (b.watched - a.watched));
  }
  const fm = (n) => (n == null ? '?' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : Math.round(n) + '');
  async function maybeAlert() {
    const B = byAddr();
    for (const c0 of confluence()) {
      // only wallets still in the current top list, with a real entry (>= minSol, not dust/micro-buys) and a real track record
      const cw = c0.wallets.filter((w) => B[w.wallet] && w.sol >= cfg.minSol && (B[w.wallet].realizedSol || 0) >= cfg.minTrackSol)
        .map((w) => ({ ...w, rank: B[w.wallet].rank, track: { score: B[w.wallet].score, realizedSol: B[w.wallet].realizedSol, winRate: B[w.wallet].winRate } }));
      const c = { ...c0, wallets: cw, n: cw.length };
      if (c.n < cfg.minWallets || !c.watched) continue;
      if (c.wallets.every((w) => EV.find((e) => e.wallet === w.wallet && e.mint === c.mint && e.side === 'buy')?.baseline)) continue; // never alert on the startup baseline
      const day = new Date().toISOString().slice(0, 10);
      const ws = c.wallets.slice(0, 3).map((w) => `#${w.rank} ${w.sol.toFixed(1)}SOL(${w.track?.realizedSol != null ? (w.track.realizedSol >= 0 ? '+' : '') + Math.round(w.track.realizedSol) : '?'}SOL ${w.track?.winRate != null ? Math.round(w.track.winRate * 100) + '%w' : ''})`).join(' ');
      const text = `CT ${c.n} top wallets in $${(c.symbol || '?').slice(0, 10)} mc$${fm(c.mcap)}: ${ws} dexscreener.com/solana/${c.mint}`;
      stat.alertsTried++;
      try { await alerts.notice(`copytrade:${c.mint}:${day}`, text.length > 159 ? text.replace(/\(.*?\)/g, '').slice(0, 159) : text); } catch (e) { stat.lastError = 'alert: ' + e.message; }
    }
  }
  async function tick() {
    if (running) return; running = true;
    try {
      const ws = wallets(); if (!ws.length) return;
      const rpc = rpcFor(null);
      for (let k = 0; k < Math.min(cfg.batch, ws.length); k++) {
        const w = ws[idx++ % ws.length];
        try { await pollWallet(rpc, w); } catch (e) { stat.errors++; stat.lastError = e.message; }
      }
      EV = EV.filter((e) => Date.now() - e.t < 7 * 86400e3);
      await maybeAlert(); save();
      stat.ticks++; stat.lastTick = Date.now();
    } finally { running = false; }
  }
  function refresh(force) {
    if (refreshing || E.NO_AUTO_REFRESH === '1') return;
    let age = Infinity; try { age = Date.now() - fs.statSync(F('copytrade.json')).mtimeMs; } catch {}
    if (!force && age < cfg.refreshH * 3600e3) return;
    refreshing = true;
    const ch = spawn('python3', ['copytrade.py'], { cwd: path.join(root, 'research'), env: { ...E, DATA_DIR }, stdio: 'ignore' });
    ch.on('exit', (c) => { refreshing = false; log('copytrade wallet refresh ' + (c ? 'failed ' + c : 'ok')); }); ch.on('error', () => { refreshing = false; });
  }
  return {
    start() { if (timer) return; stat.started = Date.now(); timer = setInterval(() => tick().catch(() => {}), cfg.tickMs); timer.unref(); setTimeout(() => tick().catch(() => {}), 20e3).unref(); setInterval(() => refresh(false), 3600e3).unref(); },
    tick, confluence,
    routes() {
      return {
        async '/api/copytrade'(q) {
          const d = data(); if (!d) throw Object.assign(new Error('copytrade.json not generated yet: run python3 research/copytrade.py'), { status: 503 });
          const ch = q && q.get('chain');
          const B = byAddr();
          const sol = (d.chains.solana?.wallets || []).slice(0, cfg.topN).map((w) => ({ ...w, polledAt: S.polled[w.address] || null, lastEvent: [...EV].reverse().find((e) => e.wallet === w.address) || null }));
          return { generatedAt: d.generatedAt, ageSec: Math.round((Date.now() - mem.m) / 1000), alertsOnly: true, chains: { solana: { ...d.chains.solana, wallets: sol }, base: d.chains.base, bsc: d.chains.bsc },
            chain: ch || 'solana', events: EV.slice(-150).reverse().map((e) => ({ ...e, walletName: B[e.wallet]?.name || null })), confluence: confluence().slice(0, 30),
            status: { ...stat, polling: !!timer, wallets: sol.length, cfg }, runners: d.runners, method: d.method, limits: d.limits, nansenPlan: d.nansenPlan };
        },
        async '/api/copytrade/wallet'(q) {
          const a = (q.get('address') || '').trim(); const d = data() || { chains: {} };
          const all = Object.values(d.chains).flatMap((c) => (c && c.wallets) || []); const w = all.find((x) => x.address === a || x.address === a.toLowerCase());
          if (!w) throw Object.assign(new Error('wallet not in the copy-trade list'), { status: 404 });
          return { wallet: w, events: EV.filter((e) => e.wallet === w.address).slice(-100).reverse() };
        },
      };
    },
    status: () => ({ ...stat, polling: !!timer }),
    refresh,
  };
}
module.exports = { createCopyTrade };

// ---------------- Nansen enrichment CLI (user-approved 2026-10-11): `node lib/copytrade.js nansen` ----------------
// Key from NANSEN_API_KEY only (never printed). Every call is cached and logged with credits used/remaining in
// data/copytrade_nansen.json. Hard rules: skip any call priced >= 100 credits (premium_labels is never sent), stop when the
// balance would fall below CT_NANSEN_FLOOR (300), cap this run at CT_NANSEN_MAX (default 160 credits).
async function nansenEnrich(DATA_DIR) {
  const KEY = process.env.NANSEN_API_KEY; if (!KEY) { console.log('NANSEN_API_KEY not set'); return; }
  const FLOOR = +(process.env.CT_NANSEN_FLOOR || 300), MAX = +(process.env.CT_NANSEN_MAX || 160);
  const f = path.join(DATA_DIR, 'copytrade_nansen.json');
  let N = {}; try { N = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  N.calls ||= []; N.cache ||= {}; N.smLeaderboard ||= {}; N.pnlSummary ||= {}; N.tgmLeaderboard ||= {};
  const save = () => fs.writeFileSync(f, JSON.stringify(N));
  let remaining = null, usedRun = 0;
  async function call(ep, body, est, method = 'POST', ttlH = 24) {
    const ck = ep + '|' + JSON.stringify(body || {});
    const hit = N.cache[ck]; if (hit && Date.now() - hit.t < ttlH * 3600e3) return { data: hit.v, cached: true };
    if (est >= 100) { N.calls.push({ t: Date.now(), ep, skipped: 'cost>=100' }); return { skipped: 'cost>=100' }; }
    if (remaining != null && remaining - est < FLOOR) { N.calls.push({ t: Date.now(), ep, skipped: `floor ${FLOOR} (remaining ${remaining})` }); return { skipped: 'floor' }; }
    if (usedRun + est > MAX) { N.calls.push({ t: Date.now(), ep, skipped: 'run cap ' + MAX }); return { skipped: 'cap' }; }
    let r; try { r = await fetch('https://api.nansen.ai/api/v1/' + ep, { method, headers: { apikey: KEY, 'content-type': 'application/json', accept: 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) }); }
    catch (e) { N.calls.push({ t: Date.now(), ep, error: e.message }); return { error: e.message }; }
    const used = +(r.headers.get('x-nansen-credits-used') || 0), cost = r.headers.get('x-nansen-credits-cost'), rem = r.headers.get('x-nansen-credits-remaining');
    usedRun += used; if (rem != null) remaining = +rem;
    const j = await r.json().catch(() => null);
    N.calls.push({ t: Date.now(), ep, status: r.status, cost: cost != null ? +cost : null, used, remaining: rem != null ? +rem : null });
    console.log(`nansen ${ep} -> ${r.status} used ${used} remaining ${rem}`);
    if (!r.ok) return { error: r.status + ' ' + String(j?.message || j?.detail || '').slice(0, 160) };
    N.cache[ck] = { t: Date.now(), v: j }; save();
    return { data: j };
  }
  const acc = await call('account', null, 0, 'GET', 0); if (acc.data) remaining = acc.data.credits_remaining;
  N.accountBefore = { remaining, at: Date.now() };
  console.log('nansen balance before', remaining);
  // 1) Smart-money realized-P&L leaderboards (5 credits each): Solana 2 pages, Base 1, BNB 1 (30d)
  for (const [chain, pages] of [['solana', 2], ['base', 1], ['bnb', 1]]) {
    for (let p = 1; p <= pages; p++) {
      const r = await call('smart-money/pnl-leaderboard', { chains: [chain], timeframe: 30, pagination: { page: p, per_page: 100 }, order_by: [{ field: 'realized_pnl_usd', direction: 'DESC' }] }, 5);
      if (r.error && /order_by|field/i.test(r.error)) { const r2 = await call('smart-money/pnl-leaderboard', { chains: [chain], timeframe: 30, pagination: { page: p, per_page: 100 } }, 5); if (r2.data) N.smLeaderboard[chain + ':' + p] = r2.data.data || []; continue; }
      if (r.data) N.smLeaderboard[chain + ':' + p] = r.data.data || [];
      else console.log('sm leaderboard', chain, p, r.error || r.skipped);
    }
  }
  // 2) Address P&L summary (1 credit each) for the current top Solana list (90 days)
  let ct = null; try { ct = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'copytrade.json'), 'utf8')); } catch {}
  const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 90 * 86400e3).toISOString().slice(0, 10);
  const addrs = ((ct && ct.chains.solana.wallets) || []).slice(0, +(process.env.CT_NANSEN_PROFILES || 60)).map((w) => w.address);
  for (const a of addrs) {
    if (N.pnlSummary[a] && Date.now() - N.pnlSummary[a].t < 3 * 86400e3) continue;
    const r = await call('profiler/address/pnl-summary', { address: a, chain: 'solana', date: { from, to } }, 1, 'POST', 72);
    if (r.data) N.pnlSummary[a] = { t: Date.now(), from, to, realized_pnl_usd: r.data.realized_pnl_usd, realized_pnl_percent: r.data.realized_pnl_percent, win_rate: r.data.win_rate, traded_times: r.data.traded_times, traded_token_count: r.data.traded_token_count, top5: (r.data.top5_tokens || []).slice(0, 5) };
    else if (r.skipped) break;
  }
  // 3) Token P&L leaderboards (5 credits each) for the biggest runners whose free tape was truncated
  const runners = ((ct && ct.runners) || []).filter((r) => !r.earlyComplete && r.tradesSeen >= 3000).slice(0, +(process.env.CT_NANSEN_RUNNERS || 6));
  let db = null; try { db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'copytrade_runners.json'), 'utf8')); } catch {}
  for (const r of runners) {
    if (N.tgmLeaderboard[r.mint]) continue;
    const rr = await call('tgm/pnl-leaderboard', { chain: 'solana', token_address: r.mint, date: { from: '2026-04-01', to }, pagination: { page: 1, per_page: 100 }, order_by: [{ field: 'pnl_usd_realised', direction: 'DESC' }] }, 5, 'POST', 168);
    if (rr.data) N.tgmLeaderboard[r.mint] = { symbol: r.symbol, t: Date.now(), rows: (rr.data.data || []).map((x) => ({ a: x.trader_address, l: x.trader_address_label, r: x.pnl_usd_realised, u: x.pnl_usd_unrealised, roi: x.roi_percent_realised, n: x.nof_trades })) };
    else if (rr.skipped) break;
  }
  const acc2 = await call('account', null, 0, 'GET', 0); if (acc2.data) remaining = acc2.data.credits_remaining;
  N.accountAfter = { remaining, at: Date.now() }; N.lastRunCredits = usedRun; N.totalCredits = N.calls.reduce((s, c) => s + (c.used || 0), 0);
  save(); console.log('nansen credits used this run', usedRun, 'balance after', remaining);
}
if (require.main === module && process.argv[2] === 'nansen') nansenEnrich(process.env.DATA_DIR || path.join(__dirname, '..', 'data')).catch((e) => { console.error(e.message); process.exit(1); });
module.exports.nansenEnrich = nansenEnrich;
