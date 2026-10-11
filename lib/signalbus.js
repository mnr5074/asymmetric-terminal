// Common signal interface across ALL detectors (existing desks + Pattern Lab + future expansions).
// A signal = one detector firing on one token at one time, normalized so the alert ranker, the false-positive log, the backtest
// harness and paper trading all speak the same language:
//   { id, detector, desk, claim: 'crash'|'pump'|'rug'|'volatility', severity: 'hard'|'high'|'medium'|'low', token: { key, chain, address, symbol },
//     t, price, liq, strength (0..1), values {}, thresholds {}, reason (one plain-English line), explain (longer), source }
// HARD = definitional danger (live mint/freeze authority, honeypot, LP pull): always ranked on top regardless of backtests.
// Plug-ins: register({ id, name, desk, claim, live: async (ctx) => [signal-like objects] }) — or export `liveSignals(ctx)` /
// `signals(token, time)` / `detectors[]` from lib/patternlab.js, or write data/patternlab_live.json {signals:[...]}; all are picked up.
// Historical events for backtests go in data/patternlab*.json {detectors:[...], events:[{detector, token|cg_id|symbol, date|t}]}.
'use strict';
const fs = require('fs');
const path = require('path');

const plugins = new Map();
function register(det) { if (det && det.id) plugins.set(det.id, det); return det; }
const num = (x) => (x == null || x === '' || isNaN(+x) ? null : +x);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const fmtUsd = (x) => (x == null ? '?' : x >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? '$' + (x / 1e3).toFixed(0) + 'K' : '$' + Math.round(x));

function sig(o) {
  const tok = o.token || {}; const key = tok.key || (tok.chain && tok.address ? `${tok.chain}:${tok.address}` : tok.symbol ? 'sym:' + String(tok.symbol).toUpperCase() : 'unknown');
  const t = o.t || Date.now();
  return { id: `${o.detector}|${key}|${o.variant || ''}`, detector: o.detector, desk: o.desk || 'crypto', claim: o.claim || 'crash', severity: o.severity || 'medium',
    token: { key, chain: tok.chain || null, address: tok.address || null, symbol: tok.symbol || null }, t, price: num(o.price), liq: num(o.liq), strength: clamp(num(o.strength) ?? 0.5),
    values: o.values || {}, thresholds: o.thresholds || {}, reason: o.reason || o.detector, explain: o.explain || o.reason || '', source: o.source || null };
}

function createSignalBus({ DATA_DIR, live, perps, liquidations, fundingdiv, orderbook, composite, root, log = () => {} }) {
  const readJ = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; } };
  const fresh = (d, maxMs) => d && (!d.generatedAt || Date.now() - (d.generatedAt > 1e12 ? d.generatedAt : d.generatedAt * 1000) < maxMs);
  // in-memory snapshot first, else the file the owning desk persists (lets a read-only / secondary instance rank too)
  const snapOr = (obj, file, maxMs = 30 * 60e3) => { let v = null; try { v = obj?.(); } catch {} const ok = v && ((v.items && v.items.length) || (v.tokens && v.tokens.length) || (v.assets && v.assets.length) || (v.detections && v.detections.length) || (v.active && v.active.length));
    if (ok) return v; const d = readJ(file); return d && (!d.generatedAt || Date.now() - d.generatedAt < maxMs) ? d : v; };
  const safe = async (name, fn) => { try { return (await fn()) || []; } catch (e) { log(`signalbus ${name}: ${e.message}`); return []; } };

  // ---- live alpha feed + rug forecast + vetoes ----
  function fromLive() {
    const f = snapOr(() => live?.feed?.(), 'live_feed.json'); const out = [];
    for (const x of f?.items || []) {
      const tok = { key: x.key, chain: x.chain, address: x.address, symbol: x.symbol }; const base = { token: tok, price: x.price, liq: x.liq, source: 'live feed' };
      const txt = [...(x.rug?.top || []), ...(x.flags || []), String(x.veto || ''), ...(x.reasons || [])].join(' | ');
      const types = x.rug?.types || [];
      if (/honeypot/i.test(String(x.veto || '')) || types.includes('honeypot') && (x.rug?.score || 0) >= 40)
        out.push(sig({ ...base, detector: 'honeypot', desk: 'rug', claim: 'rug', severity: 'hard', strength: 1, values: { rugScore: x.rug?.score }, reason: `${x.symbol}: honeypot signs — buyers may be unable to sell`, explain: 'The scanner saw honeypot indicators (sell tax / blocked sells / sell simulation failed). If you cannot sell, the price is meaningless.' }));
      if (/LP being pulled|liquidity down \d+% while price holds|liquidity pulled/i.test(txt)) {
        const m = txt.match(/liquidity down (\d+)%/i);
        out.push(sig({ ...base, detector: 'lp_pull', desk: 'rug', claim: 'rug', severity: 'hard', strength: 1, values: { liqDropPct: m ? +m[1] : null }, thresholds: { liqDropPct: 30 }, reason: `${x.symbol}: liquidity is being pulled while price holds`, explain: 'Pool liquidity fell sharply while the quoted price stayed up — the classic setup right before a rug pull, when the team removes the money backing the price.' }));
      }
      if (/mint authority (is )?(enabled|live|not renounced|active)|can mint/i.test(txt)) out.push(sig({ ...base, detector: 'contract_mint_authority', desk: 'rug', claim: 'rug', severity: 'hard', strength: 1, reason: `${x.symbol}: live mint authority — supply can be inflated`, explain: 'Someone still holds the power to print new tokens and dump them on holders.' }));
      if (/freeze authority (is )?(enabled|live|not renounced|active)|can freeze/i.test(txt)) out.push(sig({ ...base, detector: 'contract_freeze_authority', desk: 'rug', claim: 'rug', severity: 'hard', strength: 1, reason: `${x.symbol}: live freeze authority — your tokens can be frozen`, explain: 'The deployer can freeze any wallet, i.e. stop you from selling.' }));
      const v = String(x.veto || '');
      if (/^top-10 wallets hold/i.test(v)) out.push(sig({ ...base, detector: 'veto_concentration', desk: 'rug', claim: 'crash', severity: 'high', strength: 0.8, values: { top10: num((v.match(/([\d.]+)%/) || [])[1]) }, thresholds: { top10: 90 }, reason: `${x.symbol}: ${v} — a few wallets can dump the whole market`, explain: 'Extreme holder concentration: a handful of wallets control most of the supply.' }));
      if (/fake liquidity/i.test(v)) out.push(sig({ ...base, detector: 'veto_fake_liquidity', desk: 'rug', claim: 'crash', severity: 'high', strength: 0.8, reason: `${x.symbol}: ${v}`, explain: 'The pool’s quote side is the project’s own token or a dust asset, so the liquidity is not real money.' }));
      if (/^liquidity under/i.test(v)) out.push(sig({ ...base, detector: 'veto_lowliq', desk: 'rug', claim: 'crash', severity: 'low', strength: 0.2, values: { liq: x.liq }, thresholds: { liq: 3000 }, reason: `${x.symbol}: ${v}`, explain: 'Tiny pools are easy to rug and impossible to exit in size.' }));
      if ((x.rug?.score || 0) >= 45 || x.rug?.dump30) out.push(sig({ ...base, detector: 'rug_forecast', desk: 'rug', claim: 'crash', severity: (x.rug.score || 0) >= 70 ? 'high' : 'medium', strength: clamp((x.rug.score || 45) / 100), values: { rugScore: x.rug.score, dump30: !!x.rug.dump30 }, thresholds: { rugScore: 45 }, reason: `${x.symbol}: rug forecast ${x.rug.score}/100${x.rug.dump30 ? ' + 30-day dump risk' : ''} (${(x.rug.top || []).slice(0, 2).join('; ')})`, explain: `Rug-risk model signals: ${(x.rug.top || []).join(' · ') || 'n/a'}. Types: ${types.join(', ') || 'n/a'}.` }));
      if ((x.grade === 'A' || x.grade === 'B') && !x.veto) out.push(sig({ ...base, detector: 'live_grade_ab', desk: 'crypto', claim: 'pump', severity: 'medium', strength: clamp((x.score || 60) / 100), values: { grade: x.grade, score: x.score }, thresholds: { grade: 'B' }, reason: `${x.symbol}: live alpha grade ${x.grade} (score ${x.score}) — ${(x.reasons || []).slice(0, 2).join('; ')}`, explain: `Live alpha feed grade ${x.grade}. Reasons: ${(x.reasons || []).join(' · ')}` }));
    }
    return out;
  }
  // ---- perps: funding crowding, OI build ----
  function fromPerps() {
    const s = snapOr(() => perps?.snapshot?.(), 'perps.json'); const out = [];
    for (const t of s?.tokens || []) {
      const tok = { key: 'perp:' + t.sym, symbol: t.sym, chain: 'perp' };
      for (const f of t.flags || []) {
        if (f.kind === 'venue_spread') continue; // folded into funding divergence
        out.push(sig({ token: tok, price: t.mark, detector: 'perps_funding', variant: f.kind, desk: 'perps', claim: f.kind === 'crowded_short' ? 'pump' : 'crash', severity: f.level === 'extreme' ? 'medium' : 'low', strength: f.level === 'extreme' ? 0.7 : 0.4,
          values: { fundingAnnPct: t.fAnn, z: t.z, oiCh24: t.oiCh24 }, reason: `${t.sym} perp: ${f.text.split('.')[0]}`, explain: f.text, source: 'perps snapshot' }));
      }
      if ((t.oiCh24 || 0) >= 10 && Math.abs(t.ch24 || 0) < 8) out.push(sig({ token: tok, price: t.mark, detector: 'liq_oi_build', desk: 'perps', claim: 'crash', severity: 'medium', strength: clamp(t.oiCh24 / 30),
        values: { oiCh24: t.oiCh24, ch24: t.ch24 }, thresholds: { oiCh24: 10 }, reason: `${t.sym}: open interest +${Math.round(t.oiCh24)}% in 24h while price is flat — leverage is piling in`, explain: 'In the backtest, a +10% OI day was followed by a -15% crash day 3.5x more often than average (next-day). OI here is USD-based (the study used coin-denominated OI).', source: 'perps snapshot' }));
    }
    return out;
  }
  function fromLiquidations() {
    const s = snapOr(() => liquidations?.snapshot?.(), 'liquidations.json'); const out = [];
    for (const a of s?.assets || []) {
      if (a.level !== 'cascade' && a.level !== 'elevated') continue;
      const shorts = a.dom === 'short';
      out.push(sig({ token: { key: 'perp:' + a.sym, symbol: a.sym, chain: 'perp' }, detector: 'liq_cascade', desk: 'perps', claim: shorts ? 'pump' : 'crash', severity: a.level === 'cascade' ? 'medium' : 'low', strength: a.level === 'cascade' ? 0.7 : 0.4,
        values: { usd60: a.w60?.total, z60: a.z60, dominant: a.dom }, thresholds: { level: 'elevated' }, reason: `${a.sym}: liquidation ${a.level} — ${fmtUsd(a.w60?.total)} of ${shorts ? 'shorts' : 'longs'} force-closed in 1h`, explain: a.text || '', source: 'liquidations' }));
    }
    return out;
  }
  function fromFundingDiv() {
    const s = snapOr(() => fundingdiv?.snapshot?.(), 'fundingdiv.json'); const out = [];
    for (const e of s?.active || []) {
      const pos = (e.peakDiv || 0) > 0;
      out.push(sig({ token: { key: 'perp:' + e.sym, symbol: e.sym, chain: 'perp' }, price: e.cur?.mark, detector: pos ? 'fundingdiv_pos' : 'fundingdiv_neg', desk: 'perps', claim: pos ? 'crash' : 'pump', severity: 'medium', strength: clamp(Math.abs(e.peakDiv || 0) / 100),
        values: { divAnnPct: e.peakDiv, outlier: e.outlier }, thresholds: { trigger: e.trigger }, reason: `${e.sym}: ${e.outlier} funding ${pos ? 'far above' : 'far below'} other venues (${Math.round(e.peakDiv)}%/yr gap)`, explain: pos ? 'When one venue pays much more funding than the rest, longs are crowded there; the backtest saw 7-day dumps 3.4x the base rate after these episodes.' : 'Negative outlier episodes: no reliable direction in the backtest.', source: 'funding divergence' }));
    }
    return out;
  }
  function fromOrderbook() {
    const s = snapOr(() => orderbook?.snapshot?.(), 'orderbook.json'); const out = []; const seen = new Set();
    for (const d of (s?.detections || []).filter((d) => Date.now() - d.t < 6 * 3600e3)) {
      const k = d.sym + d.type; if (seen.has(k)) continue; seen.add(k);
      if (d.type === 'thin_book') out.push(sig({ token: { key: 'perp:' + d.sym, symbol: d.sym, chain: 'perp' }, price: d.mid, t: d.t, detector: 'orderbook_thin', desk: 'perps', claim: 'crash', severity: 'medium', strength: 0.6, values: { venue: d.venue }, reason: `${d.sym}: order book depth collapsed on ${d.venue}`, explain: d.explain || 'Thin books preceded the steepest crash hour 2.4x more often than calm days.', source: 'orderbook' }));
      else if (d.type === 'spoof_wall' || d.type === 'wall_pulled') out.push(sig({ token: { key: 'perp:' + d.sym, symbol: d.sym, chain: 'perp' }, price: d.mid, t: d.t, detector: 'orderbook_spoof', desk: 'perps', claim: 'volatility', severity: 'low', strength: 0.3, values: { usd: d.usd, side: d.side, venue: d.venue }, reason: `${d.sym}: ${fmtUsd(d.usd)} ${d.side} wall appeared and vanished (${d.venue})`, explain: d.explain || '', source: 'orderbook' }));
    }
    return out;
  }
  function fromFiles() {
    const out = [];
    const fv = readJ('fakevolume_live.json');
    if (fresh(fv, 6 * 3600e3)) for (const [key, t] of Object.entries(fv.tokens || {})) if (t.level === 'high' || t.level === 'elevated')
      out.push(sig({ token: { key, chain: t.chain, address: t.address, symbol: t.symbol }, t: t.at, detector: 'fakevolume', desk: 'rug', claim: 'crash', severity: t.level === 'high' ? 'medium' : 'low', strength: clamp((t.score || 50) / 100), values: { score: t.score, fakeShare: t.fake_share_estimate }, thresholds: { score: t.level === 'high' ? 60 : 45 }, reason: `${t.symbol}: ${t.level} fake-volume score ${t.score} (~${Math.round((t.fake_share_estimate || 0) * 100)}% of volume looks fake)`, explain: t.summary || (t.reasons || []).join(' · '), source: 'fakevolume' }));
    const ct = readJ('copytrade_events.json');
    for (const e of (ct?.events || []).filter((e) => e.side === 'buy' && e.watched && Date.now() - e.t < 6 * 3600e3).slice(-40))
      out.push(sig({ token: { key: 'solana:' + e.mint, chain: 'solana', address: e.mint, symbol: e.symbol }, t: e.t, detector: 'copytrade', desk: 'copytrade', claim: 'pump', severity: 'low', strength: clamp((e.track?.score || 50) / 100), values: { wallet: e.name || e.wallet.slice(0, 6), usd: e.usd, winRate: e.track?.winRate }, reason: `${e.symbol}: tracked wallet ${e.name || e.wallet.slice(0, 6)} bought ${fmtUsd(e.usd)} (win rate ${Math.round((e.track?.winRate || 0) * 100)}%)`, explain: 'Copy-trade watch: alert only, never trades.', source: 'copytrade' }));
    for (const [f, det, field] of [['patterns_wallets_live.json', 'patterns_wallets', 'flag'], ['patterns_flows_live.json', 'patterns_bridge_out', 'flag'], ['patterns_aging_live.json', 'patterns_aging', 'flags']]) {
      const d = readJ(f); if (!fresh(d, 12 * 3600e3)) continue;
      for (const x of d.items || []) { const on = Array.isArray(x[field]) ? x[field].length : x[field]; if (!on || !x.key) continue; const [chain, address] = [x.key.slice(0, x.key.indexOf(':')), x.key.slice(x.key.indexOf(':') + 1)];
        out.push(sig({ token: { key: x.key, chain, address, symbol: x.symbol }, detector: det, desk: 'patterns', claim: det === 'patterns_aging' ? 'pump' : 'crash', severity: 'low', strength: 0.4, values: { cluster: x.cluster_size, outUsd: x.out_usd }, reason: `${x.symbol}: ${det === 'patterns_wallets' ? `fresh-wallet buy cluster (${x.cluster_size} wallets)` : det === 'patterns_bridge_out' ? `dev/top holder moved ${fmtUsd(x.out_usd)} out` : 'dormant holders woke up'}`, source: f })); }
    }
    const pa = readJ('priority_alerts.json');
    for (const a of pa?.active || []) out.push(sig({ token: { key: 'sym:' + a.sym, symbol: a.sym }, t: a.since, detector: 'priority', desk: 'priority', claim: 'pump', severity: 'low', strength: 0.4, reason: a.text, source: 'priority watch' }));
    const bp = readJ(path.join('birthphase', 'live.json'));
    if (fresh(bp, 3 * 3600e3)) for (const x of bp.items || []) { const p = x.probs?.['1000000']?.p; if (p == null || p < 0.2) continue;
      out.push(sig({ token: { key: x.key, chain: x.chain, address: x.address, symbol: x.symbol }, detector: 'birthphase', desk: 'launch', claim: 'pump', severity: 'medium', strength: clamp(p), values: { pReach1M: p, mcap: x.mcap, ageS: x.age_s }, thresholds: { pReach1M: 0.2 }, reason: `${x.symbol}: ${Math.round(p * 100)}% model odds of reaching $1M mcap (${(x.why || []).slice(0, 2).join('; ')})`, explain: (x.why || []).join(' · '), source: 'birthphase' })); }
    const ro = readJ('riskinfra_oracles.json');
    for (const f of (ro?.flags || []).filter((f) => f.severity === 'high').slice(0, 10)) out.push(sig({ token: { key: 'sym:' + f.asset, symbol: f.asset }, detector: 'riskinfra_oracle', desk: 'riskinfra', claim: 'crash', severity: 'low', strength: 0.4, reason: `${f.asset}: ${f.type.replace(/_/g, ' ')}`, explain: f.detail, source: 'oracles' }));
    // contract scanner HARD flags, only for tokens currently in the live universe (avoid replaying research catalog)
    const cs = readJ('contractscan.json'); const liveKeys = new Set((snapOr(() => live?.feed?.(), 'live_feed.json')?.items || []).map((x) => x.key));
    for (const [key, t] of Object.entries(cs?.tokens || {})) { if (!liveKeys.has(key)) continue;
      for (const fl of t.flags || []) { const n = String(fl.id || fl.flag || fl.name || fl).toLowerCase();
        if (/mint/.test(n)) out.push(sig({ token: { key, chain: t.chain, address: t.address, symbol: t.symbol }, detector: 'contract_mint_authority', desk: 'rug', claim: 'rug', severity: 'hard', strength: 1, reason: `${t.symbol || key.slice(-6)}: contract scan — mint authority live`, explain: fl.plain || fl.title || JSON.stringify(fl).slice(0, 300), source: 'contractscan' }));
        else if (/freeze|blacklist|pause/.test(n)) out.push(sig({ token: { key, chain: t.chain, address: t.address, symbol: t.symbol }, detector: 'contract_freeze_authority', desk: 'rug', claim: 'rug', severity: 'hard', strength: 1, reason: `${t.symbol || key.slice(-6)}: contract scan — ${fl.title || n}`, explain: fl.plain || fl.title || JSON.stringify(fl).slice(0, 300), source: 'contractscan' })); } }
    return out;
  }
  async function fromComposite() {
    if (!composite) return [];
    const c = await composite(); const out = [];
    for (const t of c?.tokens || []) { const f = (t.factors || []).find((x) => x.key === 'crash' && x.available !== false); const m = String(f?.value || '').match(/(\d+)% crash odds/); if (!m || +m[1] < 30) continue;
      const tok = t.kind === 'perp' ? { key: 'perp:' + t.sym, symbol: t.sym, chain: 'perp' } : { key: t.key || 'sym:' + t.sym, symbol: t.sym };
      out.push(sig({ token: tok, detector: 'crashmatch_knn', desk: 'crash', claim: 'crash', severity: 'medium', strength: clamp(+m[1] / 60), values: { crashOdds: +m[1] / 100 }, thresholds: { crashOdds: 0.3 }, reason: `${t.sym}: chart looks like past pre-crash charts (${m[1]}% of the 25 closest crashed 70%+ within 90d)`, explain: f.text || '', source: 'composite/crashmatch' })); }
    return out;
  }
  async function fromPatternLab() {
    const out = [];
    const norm = (x, d = {}) => sig({ desk: 'patternlab', ...d, ...x, detector: 'pl_' + String(x.detector || x.pattern || x.id || d.id || 'pattern').replace(/^pl_/, ''), token: x.token || { key: x.key, chain: x.chain, address: x.address, symbol: x.symbol || x.sym }, reason: x.reason || x.text || x.why || x.name, claim: x.claim || d.claim || 'crash' });
    try {
      const f = path.join(root || path.join(DATA_DIR, '..'), 'lib', 'patternlab.js');
      if (fs.existsSync(f)) { const pl = require(f); const fn = pl.liveSignals || pl.signals || pl.alerts;
        if (typeof fn === 'function' && fn.length <= 1) { const r = await fn({ DATA_DIR, live }); if (Array.isArray(r)) for (const x of r.slice(0, 500)) out.push(norm(x)); } }
    } catch (e) { log('patternlab: ' + e.message); }
    if (!out.length) for (const fn of ['patternlab_live.json', 'patternlab.json']) { const d = readJ(fn); const arr = d?.signals || d?.alerts || d?.active || d?.live; if (Array.isArray(arr)) { for (const x of arr.slice(0, 500)) out.push(norm(x)); break; } }
    for (const det of plugins.values()) if (typeof det.live === 'function') { try { for (const x of (await det.live({ DATA_DIR, live })) || []) out.push(sig({ desk: det.desk, claim: det.claim, ...x, detector: det.id })); } catch (e) { log('plugin ' + det.id + ': ' + e.message); } }
    return out;
  }

  let cache = { t: 0, signals: [] };
  async function collect({ maxAgeMs = 45e3 } = {}) {
    if (Date.now() - cache.t < maxAgeMs) return cache.signals;
    const parts = await Promise.all([safe('live', fromLive), safe('perps', fromPerps), safe('liq', fromLiquidations), safe('fdiv', fromFundingDiv), safe('ob', fromOrderbook), safe('files', fromFiles), safe('composite', fromComposite), safe('patternlab', fromPatternLab)]);
    const by = new Map(); for (const s of parts.flat()) { const p = by.get(s.id); if (!p || s.strength > p.strength) by.set(s.id, s); }
    cache = { t: Date.now(), signals: [...by.values()] }; return cache.signals;
  }
  return { collect, register, plugins: () => [...plugins.keys()], liveItems: () => snapOr(() => live?.feed?.(), 'live_feed.json')?.items || [], perpTokens: () => snapOr(() => perps?.snapshot?.(), 'perps.json')?.tokens || [] };
}
module.exports = { createSignalBus, register, sig };
