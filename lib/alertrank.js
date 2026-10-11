// Unified, ranked alert queue across every desk (/api/alerts/ranked). Inputs: normalized signals (lib/signalbus.js).
// Score = severity class (HARD flags always on top) + detector trust (backtest tier blended with live rolling precision, lib/backtest.js)
//       + recency + position exposure (portfolio > watchlist > paper position) + confluence (independent detector families on the
//       same token). Shadow (demoted) detectors are excluded from the queue but still logged/scored by lib/fplog.js.
// Cross-detector agreement meta-signal: >= 3 independent families firing the same direction on a token within 6 h emits a
// 'confluence' alert whose class sits above any single non-HARD alert; its lift is calibrated by the backtest (research DB static
// flags) and replaced by the live confluence precision from fplog once n >= 30.
// Dedupe: one row per token (other detectors listed under it). Noise collapse: low-severity rows from one detector beyond 5 are
// folded into a single summary row.
'use strict';
const CLASS = { hard: 1000, confluence: 450, high: 300, medium: 150, low: 50 };
const FAMILY = { contract_mint_authority: 'contract', contract_freeze_authority: 'contract', contractscan: 'contract', lp_pull: 'liquidity', veto_lowliq: 'liquidity', veto_fake_liquidity: 'liquidity',
  veto_concentration: 'holders', holder_concentration: 'holders', insider_concentration: 'holders', patterns_wallets: 'wallets', rug_forecast: 'rugmodel', honeypot: 'honeypot',
  patterns_bridge_out: 'flows', patterns_cex: 'flows', patterns_nansen_cex: 'flows', copytrade: 'smartwallets', crashmatch_knn: 'chart', crashmatch_similarity: 'chart', crashmatch_knn_macro: 'chart',
  perps_funding: 'funding', fundingdiv_pos: 'funding', fundingdiv_neg: 'funding', liq_oi_build: 'oi', liq_cascade: 'oi', orderbook_thin: 'book', orderbook_spoof: 'book', fakevolume: 'volume',
  birthphase: 'launch', live_grade_ab: 'flowgrade', patterns_aging: 'holders_age', priority: 'priority', riskinfra_oracle: 'oracle' };
const dir = (c) => (c === 'pump' ? 'up' : c === 'volatility' ? 'vol' : 'down');
const NAMES = { honeypot: 'Honeypot', lp_pull: 'Liquidity pull', contract_mint_authority: 'Mint authority live', contract_freeze_authority: 'Freeze authority live', veto_concentration: 'Holder concentration', veto_fake_liquidity: 'Fake liquidity', veto_lowliq: 'Tiny liquidity',
  rug_forecast: 'Rug forecast', live_grade_ab: 'Live alpha A/B (phone paused)', perps_funding: 'Funding crowding', liq_oi_build: 'OI build-up', liq_cascade: 'Liquidation cascade', fundingdiv_pos: 'Funding divergence (+)', fundingdiv_neg: 'Funding divergence (−)',
  orderbook_thin: 'Thin order book', orderbook_spoof: 'Spoof wall', fakevolume: 'Fake volume', copytrade: 'Copy-trade buy', patterns_wallets: 'Fresh-wallet cluster', patterns_bridge_out: 'Bridge-out', patterns_aging: 'Holder awakening', priority: 'Priority watch',
  birthphase: 'Launch model', riskinfra_oracle: 'Oracle risk', crashmatch_knn: 'Crash lookalike', confluence: 'Confluence' };
const fam = (id) => FAMILY[id] || (id.startsWith('pl_') ? id : id);
const nameOf = (id, bt) => NAMES[id] || bt?.row?.(id)?.name || id.replace(/^pl_/, 'Pattern Lab: ').replace(/_/g, ' ');

function createAlertRank({ backtest, fplog, readPortfolio = () => ({}), paperKeys = () => new Set() }) {
  function exposureOf(key, sym, ex) {
    if (ex.portfolio.has(key) || (sym && ex.portfolioSym.has(String(sym).toUpperCase()))) return { kind: 'portfolio', bonus: 250 };
    if (ex.watch.has(key)) return { kind: 'watchlist', bonus: 150 };
    if (ex.paper.has(key)) return { kind: 'paper position', bonus: 100 };
    return null;
  }
  function liveLine(e) { const l = e.live; if (!l || !l.n) return 'live: no labelled alerts yet'; return `live: ${l.hits}/${l.n} hit (rolling precision ${Math.round((l.rollingPrecision || 0) * 100)}%, ${l.rollingLift ? l.rollingLift.toFixed(2) + 'x base' : '?'})`; }

  function rank(signals, { wl = [], limit = 60, includeShadow = false } = {}) {
    const now = Date.now(); const pf = readPortfolio() || {};
    const pkeys = new Set([...Object.keys(pf.entries || {}), ...Object.keys(pf.costBasis || {})].map((k) => (k.includes(':') ? k : 'solana:' + k)));
    const ex = { portfolio: pkeys, portfolioSym: new Set((pf.symbols || []).map((s) => String(s).toUpperCase())), watch: new Set(wl), paper: paperKeys() };
    const eff = new Map(); const E = (id) => { if (!eff.has(id)) eff.set(id, backtest.effective(id)); return eff.get(id); };
    const shadowed = []; const usable = [];
    for (const s of signals) {
      const e = E(s.detector); const tuned = fplog?.passesTuned ? fplog.passesTuned(s) : true;
      if ((e.status === 'shadow' || !tuned) && !e.hard) { shadowed.push({ ...s, shadowWhy: !tuned ? 'below tuned threshold' : e.why }); if (!includeShadow) continue; }
      usable.push(s);
    }
    // per-signal score
    const scored = usable.map((s) => {
      const e = E(s.detector); const ageH = Math.max(0, (now - s.t) / 3600e3);
      const x = exposureOf(s.token.key, s.token.symbol, ex);
      const score = (e.hard || s.severity === 'hard' ? CLASS.hard : CLASS[s.severity] || 50) + e.score * 200 + Math.exp(-ageH / 6) * 100 + (x?.bonus || 0) + s.strength * 30;
      return { s, e, score, x };
    });
    // confluence meta-signals: >= 3 independent families, same direction, within 6 h (shadow members count only if not low severity)
    const byTok = new Map();
    for (const s of signals) { if (now - s.t > 6 * 3600e3) continue; const e = E(s.detector); if (e.status === 'shadow' && s.severity === 'low') continue; if (s.claim === 'volatility') continue;
      const k = s.token.key + '|' + dir(s.claim); const g = byTok.get(k) || { fams: new Map(), sig: s }; const f = fam(s.detector); const prev = g.fams.get(f); if (!prev || e.score > E(prev.detector).score) g.fams.set(f, s); byTok.set(k, g); }
    const mult = backtest.confluenceMultiplier(); const conf = [];
    for (const [k, g] of byTok) {
      if (g.fams.size < 3) continue;
      const members = [...g.fams.values()]; const s0 = members[0]; const d = dir(s0.claim);
      const memberScore = Math.max(...members.map((m) => E(m.detector).score));
      const x = exposureOf(s0.token.key, s0.token.symbol, ex);
      const ce = E('confluence');
      const c = { id: 'confluence|' + s0.token.key + '|' + d, detector: 'confluence', desk: 'meta', claim: d === 'up' ? 'pump' : 'crash', severity: 'confluence', token: s0.token, t: Math.max(...members.map((m) => m.t)), price: members.find((m) => m.price)?.price ?? null, liq: members.find((m) => m.liq)?.liq ?? null,
        strength: Math.min(1, g.fams.size / 5), values: { families: g.fams.size }, thresholds: { families: 3 }, members: members.map((m) => m.detector),
        reason: `${s0.token.symbol || s0.token.key}: ${g.fams.size} independent detectors agree (${members.map((m) => nameOf(m.detector, backtest)).join(', ')}) → ${d === 'up' ? 'pump' : 'crash/rug'} risk`,
        explain: `Independent detector families firing together within 6h. Backtest calibration: tokens with 3+ independent flags had ${mult.toFixed(2)}x the precision of single-flag tokens${ce.live?.n >= 30 ? ' (live-calibrated)' : ' (research DB, small n)'}.` };
      conf.push(c);
      scored.push({ s: c, e: { ...ce, score: Math.min(1, memberScore * mult) }, score: CLASS.confluence + Math.min(1, memberScore * mult) * 200 + 100 + (x?.bonus || 0) + g.fams.size * 15, x });
    }
    // one row per token
    const rows = new Map();
    for (const it of scored.sort((a, b) => b.score - a.score)) {
      const k = it.s.token.key; const r = rows.get(k);
      const det = { id: it.s.detector, name: nameOf(it.s.detector, backtest), claim: it.s.claim, severity: it.s.severity, status: it.e.status, tier: it.e.tier, reason: it.s.reason, backtest: it.s.detector === 'confluence' ? `calibrated multiplier ${mult.toFixed(2)}x` : backtest.line(it.s.detector), live: liveLine(it.e), values: it.s.values, thresholds: it.s.thresholds };
      if (!r) rows.set(k, { key: k, symbol: it.s.token.symbol, chain: it.s.token.chain, address: it.s.token.address, score: Math.round(it.score), severity: it.s.severity, claim: it.s.claim, headline: it.s.reason, explain: it.s.explain,
        exposure: it.x?.kind || null, t: it.s.t, price: it.s.price, top: it.s.detector, detectors: [det], confluence: it.s.detector === 'confluence' ? it.s.members.length : 0, tier: it.e.tier });
      else { if (!r.detectors.some((d) => d.id === det.id)) r.detectors.push(det); r.score += Math.round(Math.min(40, it.score * 0.05)); if (it.s.claim !== r.claim && dir(it.s.claim) !== dir(r.claim) && it.s.claim !== 'volatility') r.conflict = true; }
    }
    let list = [...rows.values()].sort((a, b) => b.score - a.score);
    for (const r of list) {
      const fams = new Set(r.detectors.filter((d) => d.id !== 'confluence').map((d) => fam(d.id)));
      r.reasons = [ (r.severity === 'hard' ? 'HARD FLAG — ' : r.severity === 'confluence' ? 'CONFLUENCE — ' : '') + r.headline,
        ...(r.exposure ? [`You have exposure: ${r.exposure}`] : []), `Trust: ${r.detectors[0].backtest}; ${r.detectors[0].live}`,
        ...(fams.size > 1 ? [`${fams.size} independent detector families on this token`] : []), ...(r.conflict ? ['Detectors disagree on direction (some up, some down)'] : []) ];
      r.plain = r.reasons.join(' · ');
    }
    // noise collapse
    const out = []; const perDet = {}; const collapsed = {};
    for (const r of list) {
      if (r.severity === 'low' && !r.exposure && r.detectors.length === 1) { perDet[r.top] = (perDet[r.top] || 0) + 1; if (perDet[r.top] > 5) { (collapsed[r.top] ||= []).push(r.symbol || r.key); continue; } }
      out.push(r);
    }
    for (const [d, syms] of Object.entries(collapsed)) out.push({ key: 'collapsed:' + d, collapsed: true, top: d, severity: 'low', score: 0, count: syms.length, headline: `${syms.length} more ${nameOf(d, backtest)} alerts collapsed (low severity, no exposure)`, examples: syms.slice(0, 8), detectors: [], reasons: [], plain: '' });
    out.forEach((r, i) => { r.rank = i + 1; });
    return { generatedAt: now, count: out.length, signals: signals.length, shadowed: shadowed.length, shadowDetectors: [...new Set(shadowed.map((s) => s.detector))], confluenceAlerts: conf.length, confluenceMultiplier: +mult.toFixed(2), items: out.slice(0, limit), confluence: conf,
      legend: 'Rank = severity class (HARD > confluence > high > medium > low) + detector trust (backtest tier x live precision) + recency + your exposure + agreement. Shadow = demoted detectors, logged silently. Phone pump alerts: launch-model (P reach $1M ≥ 20%); A-grade phone pushes paused pending grade retraining (A/B still shown here and logged).' };
  }
  return { rank, FAMILY };
}
module.exports = { createAlertRank, FAMILY, CLASS };
