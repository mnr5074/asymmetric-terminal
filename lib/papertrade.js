// PAPER TRADING — hypothetical trades only. Nothing here builds, signs or sends a transaction; no wallet is touched.
// Signals from the ranked alert queue (active detectors only, never shadow) open virtual positions:
//   pump claim on a DEX token -> paper LONG; pump claim on a perp -> paper LONG perp; crash claim on a perp -> paper SHORT perp.
//   Crash/rug claims on DEX tokens cannot be shorted: they close any open paper long on that token ("signal exit") and are
//   otherwise tracked as 'avoided' by the false-positive log.
// Costs: entry/exit at the current price with modelled slippage (constant-product impact size/(liq/2 + size), the same AMM model
//   lib/impact.js quotes approximate; perps 2 bps) + venue fees (DEX 0.30%, perp taker 0.05%) + network fee from data/fee_history.json
//   (Solana base + priority p50 x 200k CU + Jito p50 tip; EVM gas x 180k) + perp funding accrual from the live funding rate.
// Sizing: risk RISK_PCT of equity to the stop, scaled by detector trust (proven 1, weak 0.5, untested 0.25) and live grade, capped at
//   MAX_POS_PCT of equity and 2% of pool liquidity; max MAX_OPEN positions; DEX pools under $20K liquidity are skipped.
// Exits: stop / take-profit ladder / trailing stop from lib/exitplan.js (same plan the Exit Plan card shows), a time stop
//   (24 h DEX, 72 h perps), rug (liquidity collapse -> exit at the impaired price) or an opposite signal.
// Scored on P&L, win rate, max drawdown, with per-detector and per-grade attribution. Default virtual bankroll $1,000.
'use strict';
const fs = require('fs');
const path = require('path');
const { exitPlan, atrFromMarket } = require('./exitplan');
const DEF = { bankroll: 1000, riskPct: 1, maxPosPct: 10, maxOpen: 8, minLiq: 20000, minTrust: 0.45, dexFeePct: 0.3, perpFeePct: 0.05, perpSlipPct: 0.02, timeStopHDex: 24, timeStopHPerp: 72 };
const TRUSTMUL = { proven: 1, weak: 0.5, untested: 0.25 };
const GRADEMUL = { A: 1, B: 0.7, C: 0.4 };

function createPaperTrade({ DATA_DIR, bus, live, perps, dsTokens, writer = () => true, log = () => {} }) {
  const file = path.join(DATA_DIR, 'papertrade.json');
  const fresh = (cfg = {}) => { const c = { ...DEF, ...cfg }; return { mode: 'PAPER', label: 'PAPER TRADING — hypothetical, no real execution', config: c, createdAt: Date.now(), cash: c.bankroll, open: [], closed: [], equity: [{ t: Date.now(), eq: c.bankroll }], skipped: {}, peak: c.bankroll, maxDD: 0 }; };
  let P = fresh(); try { P = { ...P, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  if (process.env.PAPER_BANKROLL && !fs.existsSync(file)) P = fresh({ bankroll: +process.env.PAPER_BANKROLL });
  let dirty = false; const save = () => { if (!dirty || !writer()) return; try { if (P.closed.length > 3000) P.closed.splice(0, P.closed.length - 3000); if (P.equity.length > 5000) P.equity = P.equity.filter((_, i) => i % 2 === 0); fs.writeFileSync(file + '.tmp', JSON.stringify(P)); fs.renameSync(file + '.tmp', file); dirty = false; } catch (e) { log('paper save: ' + e.message); } };
  const skip = (why) => { P.skipped[why] = (P.skipped[why] || 0) + 1; };

  function netFeeUsd(chain) {
    try {
      const fh = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'fee_history.json'), 'utf8')); const s = fh.samples[fh.samples.length - 1] || {};
      const marks = Object.fromEntries((bus?.perpTokens?.() || perps?.snapshot?.().tokens || []).map((t) => [t.sym, t.mark]));
      if (chain === 'solana') { const lam = 5000 + (s.sol?.p50 || 0) * 200000 / 1e6 + (s.jito?.p50 || 0); return lam / 1e9 * (marks.SOL || 150); }
      const ev = s.evm?.[chain === 'bsc' ? 'bsc' : chain]; if (ev) return ev.totalGwei * 180000 / 1e9 * (chain === 'bsc' ? marks.BNB || 600 : marks.ETH || 2500);
    } catch {}
    return chain === 'solana' ? 0.01 : 0.3;
  }
  const impactPct = (usd, liq) => (liq > 0 ? (usd / (liq / 2 + usd)) * 100 : 5);
  function quote(pos, side) { // side: 'open' | 'close'; returns fill price + cost breakdown
    const sign = (pos.dir === 'long') === (side === 'open') ? 1 : -1; // buying -> pay up
    if (pos.venue === 'perp') { const slip = DEF.perpSlipPct; return { px: pos.mark * (1 + sign * slip / 100), feeUsd: pos.notional * P.config.perpFeePct / 100, slipPct: slip, netUsd: 0 }; }
    const slip = impactPct(pos.notional, pos.liq || 0); return { px: pos.mark * (1 + sign * slip / 100), feeUsd: pos.notional * P.config.dexFeePct / 100 + netFeeUsd(pos.chain), slipPct: +slip.toFixed(3), netUsd: +netFeeUsd(pos.chain).toFixed(4) };
  }
  function marks() {
    const m = new Map();
    for (const x of (bus?.liveItems?.() || live?.feed?.().items || [])) m.set(x.key, { px: x.price, liq: x.liq, grade: x.grade, rug: x.rug, ch: { h1: x.ch1, h24: x.ch24 } });
    for (const t of (bus?.perpTokens?.() || perps?.snapshot?.().tokens || [])) m.set('perp:' + t.sym, { px: t.mark, liq: null, fAnn: t.fAnn, atrPct: t.stats?.atrPct, ch: { h24: t.ch24 } });
    return m;
  }
  const equityNow = () => P.cash + P.open.reduce((s, p) => s + p.valueUsd, 0);

  function consider(rows, M) {
    const now = Date.now(); const openKeys = new Set(P.open.map((p) => p.key));
    for (const r of rows) {
      if (r.collapsed || !r.detectors?.length) continue;
      const lead = r.detectors[0]; const isPerp = r.key.startsWith('perp:'); const m = M.get(r.key);
      // opposite / exit signals
      for (const p of P.open) if (p.key === r.key && ((p.dir === 'long' && (r.claim === 'crash' || r.claim === 'rug')) || (p.dir === 'short' && r.claim === 'pump'))) p.exitSignal = `${lead.name}: ${r.headline}`;
      if (openKeys.has(r.key) || P.open.length >= P.config.maxOpen) { if (P.open.length >= P.config.maxOpen) skip('max open positions'); continue; }
      if (r.severity === 'hard') continue;
      let dir = null; if (r.claim === 'pump') dir = 'long'; else if ((r.claim === 'crash') && isPerp) dir = 'short';
      if (!dir) { if (r.claim === 'crash' || r.claim === 'rug') skip('crash claim on DEX token (cannot short): tracked as avoided'); continue; }
      if (r.detectors.some((d) => d.severity === 'hard')) { skip('hard flag present'); continue; }
      const trustScore = r.severity === 'confluence' ? 0.7 : (lead.tier === 'proven' ? 0.9 : lead.tier === 'weak' ? 0.55 : 0.4);
      if (trustScore < P.config.minTrust && r.severity !== 'confluence') { skip('detector trust below minimum'); continue; }
      if (!m?.px) { skip('no live price'); continue; }
      if (!isPerp && (m.liq || 0) < P.config.minLiq) { skip('pool liquidity under minimum'); continue; }
      const atr = isPerp ? Math.max(3, (m.atrPct || 4)) : atrFromMarket({ ch: m.ch });
      const plan = exitPlan({ symbol: r.symbol, price: m.px, atrPct: atr, rug: m.rug || {}, high: m.px });
      const stopDist = Math.max(0.03, Math.min(0.4, plan.trailPct));
      const eq = equityNow(); const tierMul = r.severity === 'confluence' ? 1 : TRUSTMUL[lead.tier] || 0.25; const gMul = GRADEMUL[m.grade] || (isPerp ? 1 : 0.5);
      let size = (eq * P.config.riskPct / 100 * tierMul * gMul) / stopDist; size = Math.min(size, eq * P.config.maxPosPct / 100, P.cash * 0.95); if (!isPerp) size = Math.min(size, (m.liq || 0) * 0.02);
      if (size < 10) { skip('size under $10 after caps'); continue; }
      const pos = { id: r.key + '@' + now, key: r.key, symbol: r.symbol, chain: isPerp ? 'perp' : r.chain, venue: isPerp ? 'perp' : 'dex', dir, mark: m.px, liq: m.liq, liq0: m.liq, notional: size, detector: lead.id, detectorName: lead.name, tier: lead.tier,
        detectors: r.detectors.map((d) => d.id), grade: m.grade || null, reason: r.headline, t: now };
      const q = quote(pos, 'open'); const qty = (size - q.feeUsd) / q.px;
      Object.assign(pos, { entry: q.px, entryMark: m.px, qty, costs: { entryFeeUsd: +q.feeUsd.toFixed(4), entrySlipPct: q.slipPct, netFeeUsd: q.netUsd }, high: m.px, low: m.px, stopDist, trailPct: plan.trailPct,
        stop: dir === 'long' ? m.px * (1 - stopDist) : m.px * (1 + stopDist), tps: plan.ladder.filter((l) => l.gain > 0).map((l) => dir === 'long' ? l.price : m.px * (1 - (l.price / m.px - 1))).slice(0, 3), tpHit: 0,
        timeStop: now + (isPerp ? P.config.timeStopHPerp : P.config.timeStopHDex) * 3600e3, valueUsd: size - q.feeUsd, fundingUsd: 0, plan: { trailPct: +plan.trailPct.toFixed(3), level: plan.level } });
      P.cash -= size; P.open.push(pos); openKeys.add(r.key); dirty = true;
    }
  }
  function close(p, why, M, frac = 1) {
    const m = M.get(p.key); p.mark = m?.px || p.mark; p.liq = m?.liq ?? p.liq;
    const part = { ...p, notional: Math.abs(p.qty * frac) * p.mark };
    const q = quote(part, 'close'); const qty = p.qty * frac; let px = q.px; if (why === 'rug') px = p.mark * 0.5;
    const gross = p.dir === 'long' ? qty * px : qty * (2 * p.entry - px); // short P&L mirrored around entry
    const proceeds = gross - q.feeUsd + p.fundingUsd * frac; const cost = p.notional * frac;
    P.cash += proceeds; p.qty -= qty; p.notional -= cost; p.fundingUsd -= p.fundingUsd * frac;
    const rec = { id: p.id + (frac < 1 ? ':tp' + p.tpHit : ''), key: p.key, symbol: p.symbol, venue: p.venue, dir: p.dir, detector: p.detector, detectorName: p.detectorName, tier: p.tier, grade: p.grade, detectors: p.detectors,
      opened: p.t, closed: Date.now(), entry: p.entry, exit: px, sizeUsd: +cost.toFixed(2), pnlUsd: +(proceeds - cost).toFixed(2), pnlPct: +((proceeds / cost - 1) * 100).toFixed(2), why, exitFeeUsd: +q.feeUsd.toFixed(4), exitSlipPct: q.slipPct, frac };
    P.closed.push(rec); dirty = true; return rec;
  }
  function manage(M) {
    const now = Date.now();
    for (const p of [...P.open]) {
      const m = M.get(p.key); if (m?.px) { p.mark = m.px; p.liq = m.liq ?? p.liq; }
      if (p.venue === 'perp' && m?.fAnn != null) { const dtH = (now - (p.lastFundAt || p.t)) / 3600e3; p.fundingUsd += (p.dir === 'long' ? -1 : 1) * p.notional * (m.fAnn / 100) * dtH / 8760; p.lastFundAt = now; }
      p.high = Math.max(p.high, p.mark); p.low = Math.min(p.low, p.mark);
      const trail = p.dir === 'long' ? Math.max(p.stop, p.high * (1 - p.stopDist)) : Math.min(p.stop, p.low * (1 + p.stopDist));
      p.valueUsd = p.dir === 'long' ? p.qty * p.mark : p.qty * (2 * p.entry - p.mark); p.valueUsd += p.fundingUsd;
      const rug = p.venue === 'dex' && p.liq0 && p.liq != null && p.liq < 0.3 * p.liq0;
      let why = null;
      if (rug) why = 'rug'; else if (p.exitSignal) why = 'signal exit: ' + p.exitSignal.slice(0, 80);
      else if ((p.dir === 'long' && p.mark <= trail) || (p.dir === 'short' && p.mark >= trail)) why = p.tpHit ? 'trailing stop' : 'stop';
      else if (now >= p.timeStop) why = 'time stop';
      if (why) { close(p, why, M, 1); P.open = P.open.filter((x) => x !== p); continue; }
      const tp = p.tps[p.tpHit]; if (tp && ((p.dir === 'long' && p.mark >= tp) || (p.dir === 'short' && p.mark <= tp))) { p.tpHit++; close(p, `take-profit ${p.tpHit}`, M, p.tpHit >= p.tps.length ? 1 : 1 / 3); if (p.qty <= 1e-12 || p.tpHit >= p.tps.length) P.open = P.open.filter((x) => x !== p); else p.stop = p.dir === 'long' ? Math.max(p.stop, p.entry) : Math.min(p.stop, p.entry); }
    }
    const eq = equityNow(); P.peak = Math.max(P.peak, eq); P.maxDD = Math.max(P.maxDD, P.peak ? (P.peak - eq) / P.peak : 0);
    const last = P.equity[P.equity.length - 1]; if (!last || now - last.t > 5 * 60e3) P.equity.push({ t: now, eq: +eq.toFixed(2) });
    dirty = true;
  }
  async function refreshMissing(M) {
    const need = {}; for (const p of P.open) if (!M.get(p.key) && p.venue === 'dex') { const [c, a] = [p.key.slice(0, p.key.indexOf(':')), p.key.slice(p.key.indexOf(':') + 1)]; (need[c] ||= []).push(a); }
    for (const [c, as] of Object.entries(need)) { try { const r = await dsTokens(c, as.slice(0, 30)); for (const a of as) if (r[a]) M.set(c + ':' + a, { px: r[a].priceUsd, liq: r[a].liquidityUsd }); } catch {} }
  }
  async function tick(rankedRows) {
    const M = marks(); await refreshMissing(M); manage(M); consider(rankedRows || [], M); save();
  }
  function attribution(key) {
    const g = {}; for (const c of P.closed) { const k = c[key] || '—'; const x = (g[k] ||= { trades: 0, wins: 0, pnlUsd: 0 }); x.trades++; x.wins += c.pnlUsd > 0; x.pnlUsd += c.pnlUsd; }
    return Object.entries(g).map(([k, x]) => ({ [key]: k, ...x, pnlUsd: +x.pnlUsd.toFixed(2), winRate: x.trades ? +(x.wins / x.trades).toFixed(3) : null })).sort((a, b) => b.pnlUsd - a.pnlUsd);
  }
  let loadedAt = Date.now();
  function api(q) {
    if (!writer() && Date.now() - loadedAt > 30e3) { loadedAt = Date.now(); try { P = { ...P, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {} }
    if (!writer() && (q?.get?.('reset') || q?.get?.('bankroll'))) return { error: 'this instance is read-only for paper trading (another server process owns data/papertrade.json)' };
    if (q?.get?.('reset') === '1') { const b = +(q.get('bankroll') || P.config.bankroll || 1000); P = fresh({ ...P.config, bankroll: b > 0 ? b : 1000 }); dirty = true; save(); }
    else if (q?.get?.('bankroll')) { const b = +q.get('bankroll'); if (b > 0 && !P.closed.length && !P.open.length) { P = fresh({ ...P.config, bankroll: b }); dirty = true; save(); } }
    for (const k of ['riskPct', 'maxPosPct', 'maxOpen', 'minLiq', 'minTrust']) if (q?.get?.(k)) { P.config[k] = +q.get(k); dirty = true; }
    const eq = equityNow(); const wins = P.closed.filter((c) => c.pnlUsd > 0).length;
    return { mode: 'PAPER', label: P.label, config: P.config, startedAt: P.createdAt, bankroll: P.config.bankroll, cash: +P.cash.toFixed(2), equity: +eq.toFixed(2), pnlUsd: +(eq - P.config.bankroll).toFixed(2), pnlPct: +((eq / P.config.bankroll - 1) * 100).toFixed(2),
      trades: P.closed.length, winRate: P.closed.length ? +(wins / P.closed.length).toFixed(3) : null, maxDrawdownPct: +(P.maxDD * 100).toFixed(2), open: P.open.map((p) => ({ ...p, uPnlUsd: +(p.valueUsd - p.notional).toFixed(2) })), closed: P.closed.slice(-50).reverse(),
      byDetector: attribution('detector'), byGrade: attribution('grade'), byTier: attribution('tier'), skipped: P.skipped, equityCurve: P.equity.slice(-300),
      nfa: 'PAPER: hypothetical fills with modelled slippage and fees. No orders are placed, nothing is signed, no wallet is used.' };
  }
  return { tick, api, openKeys: () => new Set(P.open.map((p) => p.key)) };
}
module.exports = { createPaperTrade, DEF };
