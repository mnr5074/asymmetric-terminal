'use strict';
// Priority Watch: NEAR + ZEC pinned as PRIORITY tokens.
// Data: research/priority.py -> data/priority.json (market, 4-venue perps, tokenomics, news, narratives) and data/zec_shielded.json
// (ZEC shielded-pool history, price correlation, accumulation signal, scenario table). Live overlays from the existing desks:
// perps (funding/OI flags), liquidations (cascade detector), pricegaps (cross-venue gaps), composite (crash-pattern factor),
// unlocks (DefiLlama calendar), devactivity (GitHub). Raises high-priority TERMINAL alerts (data/priority_alerts.json).
// High-level alerts also go through lib/alerts.js (ntfy / Brevo) when `alerts` is passed; watch-level stays terminal-only.
// Free public data only; no Nansen, no X API. Estimates, not financial advice.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Pinned priority tokens (native L1 coins: tracked by symbol / CoinGecko id, not by a DEX address -> see README note in report)
const PRIORITY = [
  { sym: 'NEAR', cgId: 'near', name: 'NEAR Protocol' },
  { sym: 'ZEC', cgId: 'zcash', name: 'Zcash' },
];
const PY_EVERY = 30 * 60e3;   // research/priority.py cadence (shielded rebuild inside it only when >20h old = daily)
const EVAL_EVERY = 2 * 60e3;  // alert evaluation cadence (perps desk refreshes every 2 min)
const COOLDOWN = 6 * 3600e3;  // same alert key at most once per 6h

function createPriority({ DATA_DIR, perps, liquidations, pricegaps, unlocks, devactivity, composite, alerts = null, log = () => {} }) {
  const readJ = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; } };
  const alertFile = path.join(DATA_DIR, 'priority_alerts.json');
  let A = readJ('priority_alerts.json') || { log: [], last: {} };
  A.log ||= []; A.last ||= {};
  const px = {}; // sym -> [[t, mark]] from the perps desk snapshot (3h buffer)
  let pyRunning = false, pyAt = 0, pyErr = null, evalAt = 0, lastEvalErr = null;

  function runPy(mode = 'all') {
    if (pyRunning || process.env.NO_AUTO_REFRESH === '1') return;
    pyRunning = true; pyAt = Date.now();
    const ch = spawn('python3', ['priority.py', mode], { cwd: path.join(__dirname, '..', 'research'), env: { ...process.env, DATA_DIR }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; ch.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    ch.on('exit', (c) => { pyRunning = false; pyErr = c ? `exit ${c}: ${err.slice(-300)}` : null; evaluate().catch(() => {}); });
    ch.on('error', (e) => { pyRunning = false; pyErr = e.message; });
  }
  function ensurePerpsUniverse() { // NEAR/ZEC were not in the perps universe (catalog/sleepers/watchlist/majors); add via the desk's own watch API
    const p = readJ('priority.json');
    const list = PRIORITY.map((t) => ({ sym: t.sym, price: p?.tokens?.[t.sym]?.market?.price || null }));
    try { perps.addWatch(list); } catch (e) { log('[priority] perps.addWatch: ' + e.message); }
  }
  function track() {
    const s = perps.snapshot(); if (!s?.generatedAt) return;
    for (const t of s.tokens || []) {
      if (!PRIORITY.some((p) => p.sym === t.sym)) continue;
      const a = px[t.sym] || (px[t.sym] = []);
      if (!a.length || s.generatedAt - a[a.length - 1][0] > 60e3) a.push([s.generatedAt, t.mark]);
      while (a.length && a[0][0] < Date.now() - 3 * 3600e3) a.shift();
    }
  }
  const chg = (sym, mins) => { const a = px[sym] || []; if (a.length < 2) return null; const now = a[a.length - 1]; const old = a.find((x) => x[0] >= now[0] - mins * 60e3); if (!old || now[0] - old[0] < mins * 60e3 * 0.75) return null; return (now[1] / old[1] - 1) * 100; };
  const f0 = (x, d = 1) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d));

  // ---------- detectors -> alert candidates ----------
  async function candidates() {
    const out = []; const P = readJ('priority.json'); const Z = readJ('zec_shielded.json');
    const snap = perps.snapshot(); const pt = new Map((snap?.tokens || []).map((t) => [t.sym, t]));
    let comp = null; try { comp = composite ? await composite() : null; } catch {}
    const liq = liquidations?.snapshot?.() || {}; const gaps = pricegaps?.snapshot?.() || {};
    for (const T of PRIORITY) {
      const s = T.sym; const m = P?.tokens?.[s]?.market || {};
      // 1) crash / pump: live perps marks (1h) + CoinGecko 24h
      const c60 = chg(s, 60);
      if (c60 != null && Math.abs(c60) >= 5) out.push({ sym: s, kind: c60 < 0 ? 'crash_1h' : 'pump_1h', level: Math.abs(c60) >= 8 ? 'high' : 'watch', bucket: Math.floor(Date.now() / 3600e3), text: `${s} ${f0(c60)}% in the last hour (perp mark across venues).` });
      if (m.ch24 != null && Math.abs(m.ch24) >= 12) out.push({ sym: s, kind: m.ch24 < 0 ? 'crash_24h' : 'pump_24h', level: Math.abs(m.ch24) >= 20 ? 'high' : 'watch', bucket: new Date().toISOString().slice(0, 10), text: `${s} ${f0(m.ch24)}% in 24h (CoinGecko), price $${m.price}.` });
      const ct = (comp?.tokens || []).find((x) => x.kind === 'perp' && x.sym === s);
      const cf = ct?.factors?.find((f) => f.key === 'crash' && f.available !== false);
      if (cf && cf.score <= 30) out.push({ sym: s, kind: 'crash_pattern', level: cf.score <= 20 ? 'high' : 'watch', bucket: new Date().toISOString().slice(0, 10), text: `${s} crash-lookalike detector: ${cf.value} (composite crash factor ${cf.score}/100). ${String(cf.text || '').slice(0, 220)}` });
      // 2) perps: desk flags (crowded long/short = extreme/high funding), OI surge
      const t = pt.get(s);
      for (const f of t?.flags || []) if (f.level === 'extreme' || f.level === 'high') out.push({ sym: s, kind: 'funding_' + f.kind, level: f.level === 'extreme' ? 'high' : 'watch', bucket: new Date().toISOString().slice(0, 10), text: `${s} perps: ${f.text}` });
      if (t?.oiCh24 != null && Math.abs(t.oiCh24) >= 25) out.push({ sym: s, kind: t.oiCh24 > 0 ? 'oi_surge' : 'oi_flush', level: Math.abs(t.oiCh24) >= 40 ? 'high' : 'watch', bucket: new Date().toISOString().slice(0, 10), text: `${s} open interest ${f0(t.oiCh24, 0)}% in 24h (${t.oiChSrc || 'perps desk'}).` });
      if (!t) { const pv = P?.tokens?.[s]?.perps; const fa = pv?.fundingAnnPctOiWeighted; if (fa != null && Math.abs(fa) >= 50) out.push({ sym: s, kind: 'funding_extreme_py', level: 'high', bucket: new Date().toISOString().slice(0, 10), text: `${s} OI-weighted funding ${f0(fa, 0)}%/yr across ${pv.venuesOk.join(', ')}.` }); }
      // 3) liquidation cascade
      const la = (liq.assets || []).find((x) => x.sym === s);
      if (la?.level) out.push({ sym: s, kind: 'liq_' + la.level, level: la.level === 'cascade' ? 'high' : 'watch', bucket: Math.floor(Date.now() / 3600e3), text: la.text || `${s} liquidations ${la.level}.` });
      // 4) price gaps
      for (const g of (gaps.flags || []).filter((x) => x.sym === s)) out.push({ sym: s, kind: 'price_gap', level: g.level === 'high' || g.level === 'extreme' ? 'high' : 'watch', bucket: Math.floor(Date.now() / 3600e3), text: `${s} price gap ${f0(g.adjGapPct, 2)}% on ${g.venue} ${g.kind} vs reference ${g.ref}.` });
      // 5) unlocks
      try { const ua = unlocks?.assess(unlocks.find({ sym: s, cgId: T.cgId, price: m.price })); if (ua && ua.level && ua.level !== 'none' && ua.warn) out.push({ sym: s, kind: 'unlock', level: ua.level === 'high' ? 'high' : 'watch', bucket: new Date().toISOString().slice(0, 10), text: `${s}: ${ua.warn}` }); } catch {}
      // 6) dev activity
      try { const d = devactivity?.find({ cgId: T.cgId, sym: s }); if (d && d.verified && (d.silence || d.burst)) out.push({ sym: s, kind: d.silence ? 'dev_silence' : 'dev_burst', level: 'watch', bucket: new Date().toISOString().slice(0, 10), text: `${s} GitHub: ${d.silence ? 'developer silence (' + d.silence + ')' : 'commit burst'}.` }); } catch {}
      // 7) high-impact news (ETF / regulatory / upgrade), first seen in the last 3h
      for (const n of (P?.news?.items || []).filter((x) => x.tokens.includes(s) && x.publishedAt && Date.now() - x.publishedAt < 6 * 3600e3 && Date.now() - x.firstSeen < 3 * 3600e3 && !/stock (quote|price)|price, news|\(N(YSE|ASDAQ)|\) risk\b|price prediction/i.test(x.title) && x.topics.some((k) => k === 'etf' || k === 'regulatory'))) out.push({ sym: s, kind: 'news_' + n.topics.find((k) => k === 'etf' || k === 'regulatory'), level: 'watch', bucket: n.id.slice(0, 60), text: `${s} news (${n.source}): ${n.title}`.slice(0, 280), url: n.url });
    }
    // 8) ZEC shielded-pool flow signal
    for (const f of Z?.signal?.flags || []) out.push({ sym: 'ZEC', kind: 'shielded_' + f.kind, level: f.level, bucket: Z.signal.asOf, text: 'ZEC shielded pools: ' + f.text });
    return out;
  }
  async function evaluate() {
    try {
      track();
      const c = await candidates(); const now = Date.now();
      const active = [];
      for (const x of c) {
        const k = `${x.sym}|${x.kind}|${x.bucket}`; const lastT = A.last[x.sym + '|' + x.kind] || 0;
        const isNew = !A.log.some((l) => l.key === k) && now - lastT > COOLDOWN;
        if (isNew) { A.log.unshift({ key: k, t: now, ...x }); A.last[x.sym + '|' + x.kind] = now; log(`[priority] ALERT ${x.level.toUpperCase()} ${x.text.slice(0, 160)}`);
          if (alerts && x.level === 'high') { try { await alerts.notice('priority:' + k, ('PRIORITY ' + x.sym + ': ' + x.text).slice(0, 159), { kind: 'priority-high', priority: 3, title: 'AT Priority ' + x.sym, sms: false }); } catch (e) { log('[priority] alert send: ' + e.message); } } }
        active.push({ ...x, key: k, since: (A.log.find((l) => l.key === k) || {}).t || now });
      }
      A.log = A.log.slice(0, 300); A.active = active; A.evaluatedAt = now;
      for (const k of Object.keys(A.last)) if (now - A.last[k] > 7 * 864e5) delete A.last[k];
      fs.writeFileSync(alertFile + '.tmp', JSON.stringify(A)); fs.renameSync(alertFile + '.tmp', alertFile);
      evalAt = now; lastEvalErr = null;
    } catch (e) { lastEvalErr = e.message; log('[priority] evaluate: ' + e.message); }
  }

  // ---------- API ----------
  async function api() {
    const P = readJ('priority.json'); const Z = readJ('zec_shielded.json');
    const snap = perps.snapshot(); const liq = liquidations?.snapshot?.() || {}; const gaps = pricegaps?.snapshot?.() || {};
    let comp = null; try { comp = composite ? await composite() : null; } catch {}
    const tokens = {};
    for (const T of PRIORITY) {
      const base = P?.tokens?.[T.sym] || { sym: T.sym, name: T.name };
      const t = (snap?.tokens || []).find((x) => x.sym === T.sym);
      const ct = (comp?.tokens || []).find((x) => x.kind === 'perp' && x.sym === T.sym);
      let ua = null; try { ua = unlocks?.assess(unlocks.find({ sym: T.sym, cgId: T.cgId, price: base.market?.price })); } catch {}
      let dev = null; try { dev = devactivity?.find({ cgId: T.cgId, sym: T.sym }) || null; } catch {}
      tokens[T.sym] = { ...base,
        perpsDesk: t ? { inUniverse: true, mark: t.mark, fAnn: t.fAnn, z: t.z, oiUsd: t.oiUsd, oiCh24: t.oiCh24, oiChSrc: t.oiChSrc, flags: t.flags, venues: t.venues.map((v) => ({ venue: v.venue, fAnn: v.fAnn, oiUsd: v.oiUsd, mark: v.mark })), at: snap.generatedAt }
          : { inUniverse: false, note: snap?.generatedAt ? 'added to the perps watch universe; appears after the next 2-min perps refresh' : 'perps desk warming up' },
        move1h: chg(T.sym, 60), move15m: chg(T.sym, 15),
        liquidations: (() => { const a = (liq.assets || []).find((x) => x.sym === T.sym); return a ? { level: a.level, dom: a.dom, w60: a.w60?.total, w24: a.w24, z60: a.z60, text: a.text } : null; })(),
        priceGaps: (gaps.flags || []).filter((x) => x.sym === T.sym),
        composite: ct ? { grade: ct.grade, score: ct.score, crash: ct.factors.find((f) => f.key === 'crash') || null, summary: ct.summary } : null,
        unlock: ua, dev: dev ? { verified: dev.verified, silence: dev.silence || null, burst: dev.burst || null, freq: dev.freq ?? null, repo: dev.repo || dev.repos || null } : { note: 'data/devactivity.json not generated yet (research/devactivity.py all)' },
        narratives: P?.narratives?.[T.sym] || null };
    }
    const zs = Z ? { generatedAt: Z.generatedAt, current: Z.current, signal: { ...Z.signal, series: undefined }, analysis: { ...Z.analysis, rolling90d: undefined }, scenarios: Z.scenarios, sources: Z.sources, sourceOverlapCheck: Z.sourceOverlapCheck, caveats: Z.caveats } : null;
    return { generatedAt: P?.generatedAt || null, tokens, news: P?.news || null, zecQuantumNote: P?.narratives?.zecQuantumNote || null, narrativesAt: P?.narratives?.narrativesAt || null,
      shielded: zs, alerts: { active: A.active || [], recent: A.log.slice(0, 40), evaluatedAt: A.evaluatedAt || null, sms: alerts ? 'high -> ntfy (Brevo SMS off for priority; HARD/A/sentiment/restart only)' : 'off: no alerts module wired' },
      status: { pyRunning, pyAt, pyErr, evalAt, lastEvalErr, errors: P?.errors || [] }, nfa: 'Free public data. Scenarios are not predictions. Not financial advice.' };
  }
  function shieldedApi() { const Z = readJ('zec_shielded.json'); if (!Z) throw Object.assign(new Error('zec_shielded.json is being generated (python3 research/priority.py shielded)'), { status: 503 }); return Z; }

  let started = false;
  function start() {
    if (started) return; started = true;
    ensurePerpsUniverse();
    const p = readJ('priority.json');
    if (!p || Date.now() - (p.generatedAt || 0) > PY_EVERY) setTimeout(() => runPy('all'), 20e3); else pyAt = p.generatedAt;
    setInterval(() => runPy('all'), PY_EVERY).unref();
    setInterval(ensurePerpsUniverse, 6 * 3600e3).unref();
    setTimeout(evaluate, 45e3); setInterval(evaluate, EVAL_EVERY).unref();
    setInterval(track, 60e3).unref();
  }
  return { start, api, shieldedApi, evaluate, PRIORITY, alerts: () => A };
}
module.exports = { createPriority, PRIORITY };
