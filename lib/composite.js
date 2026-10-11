'use strict';
// Composite A–F grade per token: pluggable factor model with plain-English explanations.
// Factors (each 0–100, 50 = neutral, missing factors are skipped and weights renormalized):
//   crash patterns (lib/patterns.js / data/patterns_*.json when present + crash-lookalike from lib/crashmatch.js),
//   pump patterns (graduation speed, wallet distribution, buy-size curve from research data),
//   rug forecast, sleeper score, moonshot/asymmetry score, macro calendar proximity, perp funding/OI, token unlocks.
// Higher grade = better risk-adjusted long-side asymmetry. Model estimate from public data, NOT financial advice.
const fs = require('fs');
const path = require('path');
const crashmatch = require('./crashmatch');
let devact = null; try { devact = require('./devactivity'); } catch { /* optional factor */ }

const W = { crash: 2, patterns: 1.5, pump: 1, rug: 2, sleeper: 1, moonshot: 1, macro: 0.75, perp: 1.5, unlocks: 2, dev: 0.5 }; // dev = GitHub developer activity (lib/devactivity.js): small weight, verified repos only, skipped when absent
const GRADE = (s) => (s >= 68 ? 'A' : s >= 58 ? 'B' : s >= 48 ? 'C' : s >= 38 ? 'D' : 'F');
const ORDER = { A: 4, B: 3, C: 2, D: 1, F: 0 };
const minGrade = (a, b) => (ORDER[a] <= ORDER[b] ? a : b);
const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function createComposite({ DATA_DIR, perps, unlocks, macro, live, log = () => {} }) {
  const dev = devact ? devact.createDevActivity({ DATA_DIR }) : null; // developer-activity factor (null-safe)
  const cacheJ = {};
  function readJ(f) { const p = path.join(DATA_DIR, f); try { const st = fs.statSync(p); const c = cacheJ[f]; if (c && c.t === st.mtimeMs) return c.v; const v = JSON.parse(fs.readFileSync(p, 'utf8')); cacheJ[f] = { t: st.mtimeMs, v }; return v; } catch { return null; } }

  // ---------- pattern detectors plug-in (other worker): lib/patterns.js and/or data/patterns_*.json ----------
  // Only LIVE detector outputs are merged (backtest cohorts in patterns_*.json describe past tokens, not current risk).
  function patternSources() {
    const out = { files: [], module: null, entries: [] };
    let feed = null; try { feed = live?.feed?.(); } catch {}
    try {
      const m = require('./patterns'); out.module = Object.keys(m);
      if (typeof m.all === 'function') {
        const a = m.all(DATA_DIR, feed);
        for (const x of a?.hours?.live?.items || []) out.entries.push({ sym: x.symbol ? String(x.symbol).toUpperCase() : null, key: x.key, pattern: 'UTC-hour crash window', value: 70, good: false, why: x.why, src: 'lib/patterns.js hours.live' });
        for (const [name, arr] of [['fresh-wallet coordination', a?.freshWallets?.live], ['dev/insider wallet → exchange', a?.cexFlows?.live]]) for (const x of Array.isArray(arr) ? arr : []) collect(x, name, out.entries, 0, true);
        for (const t of a?.stocks?.tokens || []) if (t && (t.flag || t.flagged || t.live_flag)) collect({ ...t, why: t.why || t.flag_reason || 'stock-paired divergence flag' }, 'stock-paired correlation', out.entries, 0, true);
      }
    } catch { /* module absent or failed: degrade */ }
    let files = []; try { files = fs.readdirSync(DATA_DIR).filter((f) => /^patterns_.*_live\.json$/.test(f)); } catch {}
    for (const f of files) { const d = readJ(f); if (d) { out.files.push(f); if (!out.module) collect(d.items || d, f.replace(/^patterns_|_live\.json$/g, ''), out.entries, 0, true); } }
    return out;
  }
  function collect(d, src, acc, depth = 0, flagOk = false) { // flatten any objects that name a token and carry a numeric score (or are a live flag)
    if (depth > 4 || d == null) return;
    if (Array.isArray(d)) { for (const x of d) collect(x, src, acc, depth + 1, flagOk); return; }
    if (typeof d !== 'object') return;
    const sym = d.symbol || d.sym || d.ticker; const key = d.key || (d.chain && (d.address || d.mint) ? `${d.chain}:${d.address || d.mint}` : null);
    const numKey = ['risk', 'risk_score', 'riskScore', 'score', 'prob', 'probability', 'strength', 'confidence', 'z'].find((k) => typeof d[k] === 'number');
    if ((sym || key) && !numKey && flagOk) { acc.push({ sym: sym ? String(sym).toUpperCase() : null, key, pattern: src, value: 65, field: 'flag', good: false, why: d.why || d.reason || d.text || null, src }); return; }
    if ((sym || key) && numKey) {
      let v = d[numKey]; if (numKey === 'z') v = clamp(50 + v * 15); else if (v <= 1 && v >= 0 && numKey !== 'score') v *= 100;
      const pattern = d.pattern || d.detector || src;
      const isGood = /pump|bull|accum|positive/i.test(String(d.direction || d.bias || ''));
      acc.push({ sym: sym ? String(sym).toUpperCase() : null, key, pattern, value: v, field: numKey, good: isGood, why: d.why || d.reason || d.explain || d.text || d.description || null, src });
      return;
    }
    for (const [, v] of Object.entries(d)) if (v && typeof v === 'object') collect(v, src, acc, depth + 1, flagOk);
  }

  // ---------- macro proximity ----------
  async function macroCtx(N = 3) {
    let snap = null; try { snap = await macro.snapshot(); } catch {}
    const ev = readJ('macro_events.json'); const today = new Date().toISOString().slice(0, 10);
    const days = (d) => Math.round((Date.parse(d + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 864e5);
    const list = [];
    const add = (type, label, d) => { if (d) list.push({ type, label, date: d, days: days(d) }); };
    add('nfp', 'jobs report (NFP)', snap?.calendar?.nfp?.next); add('cpi', 'CPI inflation', snap?.calendar?.cpi?.next); add('fomc', 'FOMC rate decision', snap?.fed?.nextMeeting?.end);
    add('pce', 'PCE inflation', snap?.calendar?.pce?.next);
    list.sort((a, b) => a.days - b.days);
    const near = list.filter((x) => x.days >= 0 && x.days <= N && x.type !== 'pce');
    const base = ev?.baseline?.btc_mean_abs_daily_move;
    const hist = (t) => ev?.summary?.[t + ':all']?.btc?.r0?.mean_abs ?? null; const histN = (t) => ev?.summary?.[t + ':all']?.btc?.r0?.n ?? null;
    let text, score;
    if (!list.length) return { available: false };
    if (near.length) {
      const n = near[0]; const h = hist(n.type);
      const bigger = h != null && base != null ? h > base * 1.1 : null;
      score = (n.days === 0 ? -8 : n.days === 1 ? -6 : -4) + (bigger === false ? 2 : 0); if (near.length > 1) score -= 2;
      text = `${near.map((x) => `${x.label} ${x.days === 0 ? 'today' : x.days === 1 ? 'tomorrow' : 'in ' + x.days + ' days'} (${x.date})`).join(' and ')}. Scheduled US data and Fed decisions hit all of crypto at the same moment, so leveraged positions and fresh entries carry extra gap risk right before them.${h != null && base != null ? ` In our event study BTC's close-to-close move on ${n.label} days averaged ${(+h).toFixed(1)}% (n=${histN(n.type)}) vs ${(+base).toFixed(1)}% on an average day${bigger ? ', i.e. bigger than normal' : ' — not bigger than normal on a daily close basis, so this is a modest caution mainly for leverage'}.` : ''}`;
    } else { score = 0; const n = list.find((x) => x.days >= 0); text = `No jobs report, CPI or FOMC in the next ${N} days${n ? ` (next: ${n.label} on ${n.date}, in ${n.days} days)` : ''}. Calendar risk is low right now.`; }
    return { available: true, score, text, near, upcoming: list.filter((x) => x.days >= 0).slice(0, 4), within: near.length > 0, N };
  }

  // ---------- factor builders ----------
  function fPerp(t) {
    if (!t || t.fAnn == null) return null;
    const f = t.fAnn, oi = t.oiCh24, z = t.z; let s = 52, txt;
    if (f > 15) { s = 48 - Math.min(40, (f - 15) * 0.45) - (oi > 10 ? 5 : 0); txt = `Longs pay ${f.toFixed(0)}%/yr to hold leveraged positions${z != null ? ` (${z.toFixed(1)}σ vs its own last 30 days)` : ''}. Crowded longs are fragile: a dip can trigger forced selling.`; }
    else if (f < -10) { s = 55 + Math.min(20, (-f - 10) * 0.25) + (oi > 10 ? 5 : 0); txt = `Shorts pay ${Math.abs(f).toFixed(0)}%/yr${z != null ? ` (${z.toFixed(1)}σ vs its own last 30 days)` : ''}. Many traders bet on a fall; if price rises they must buy back (squeeze fuel). It also means the market is bearish on it.`; }
    else txt = `Funding is normal (${f.toFixed(1)}%/yr): leveraged traders are not crowded on either side.`;
    if (z != null && Math.abs(z) >= 2.5) s += z > 0 ? -5 : 5;
    if (oi != null) txt += ` Open interest ${oi >= 0 ? '+' : ''}${oi.toFixed(0)}% in 24h.`;
    return { score: clamp(s), text: txt, value: `${f.toFixed(1)}%/yr${oi != null ? `, OI ${oi >= 0 ? '+' : ''}${oi.toFixed(0)}%` : ''}`, cap: f >= 100 ? 'C' : null };
  }
  function fCrash(t, stats, catEntry) {
    const st = stats?.tokens?.[t.sym];
    let m = null;
    if (st?.closes?.length >= 91) { try { m = crashmatch.match(DATA_DIR, st.closes, st.vols, { exclude: t.name }); } catch {} }
    const hist = catEntry && catEntry.crash_depth_pct != null ? ` History: already ${Math.abs(catEntry.crash_depth_pct).toFixed(0)}% below its ${catEntry.ath_date} all-time high.` : '';
    if (!m?.ok || m.crashOdds == null) return hist ? { score: 50, text: `No recent chart pattern check available.${hist}`, value: 'n/a', weightMul: 0.25 } : null;
    const base = m.evidence?.base_rate || 0.15; const lift = m.crashOdds / base;
    const s = clamp(55 - (lift - 1) * 25, 10, 62); // low odds is only mild comfort: the backtest shows no edge in low bands
    const ev = m.evidence?.lift != null ? ` In our backtest, charts in this odds band crashed ${Math.round((m.evidence.hit_rate || 0) * 100)}% of the time (${m.evidence.lift.toFixed(1)}x the ${Math.round(base * 100)}% base rate, n=${m.evidence.n}).` : '';
    return { score: s, value: `${Math.round(m.crashOdds * 100)}% crash odds`, text: `${m.text}. The 25 most similar historical charts were followed by a 70%+ crash within 90 days ${Math.round(m.crashOdds * 100)}% of the time vs a ${Math.round(base * 100)}% base rate.${ev}${hist}` };
  }
  function fPatterns(entries) {
    if (!entries.length) return null;
    const bad = entries.filter((e) => !e.good), good = entries.filter((e) => e.good);
    const risk = bad.length ? Math.max(...bad.map((e) => e.value)) : 0; const boost = good.length ? Math.max(...good.map((e) => e.value)) : 0;
    const s = clamp(60 - risk * 0.5 + boost * 0.2);
    return { score: s, value: entries.map((e) => `${e.pattern} ${Math.round(e.value)}`).join(', '), text: entries.map((e) => `${e.pattern}: ${Math.round(e.value)}/100${e.why ? ' — ' + e.why : ''}`).join(' · ') + '. These detectors look for repeat behaviour seen before crashes (crash timing by UTC hour, fresh-wallet coordination, dev wallets moving to exchanges, stock-paired moves).' };
  }
  function fPump(x) { // x: screener token or live record features
    if (!x) return null;
    const parts = []; let s = 50, n = 0;
    if (x.curve_secs != null) { n++; const c = x.curve_secs; const d = c <= 60 ? 6 : c <= 600 ? 0 : -6; s += d; parts.push(`graduated the bonding curve in ${c < 1 ? 'under a second (likely bundled/bot-driven, or launched straight to a pool)' : Math.round(c) + 's'}`); }
    if (x.top10 != null) { n++; const d = x.top10 > 40 ? -15 : x.top10 > 25 ? -5 : 5; s += d; parts.push(`top-10 wallets hold ${x.top10.toFixed(0)}%${x.top10 > 40 ? ' (concentrated: a few holders can dump)' : x.top10 > 25 ? ' (somewhat concentrated)' : ' (well spread)'}`); }
    if (x.holders != null) { n++; const d = x.holders >= 2000 ? 8 : x.holders >= 300 ? 3 : -6; s += d; parts.push(`${x.holders} holders`); }
    if (x.trades) { const t = x.trades; n++;
      if (t.top_buyer_share != null) { const d = t.top_buyer_share > 15 ? -10 : t.top_buyer_share > 8 ? -3 : 4; s += d; parts.push(`largest buyer is ${t.top_buyer_share.toFixed(1)}% of buy volume${t.top_buyer_share > 15 ? ' (one whale drives it)' : ''}`); }
      if (t.median_buy_usd != null) { const d = t.median_buy_usd < 1 ? -8 : t.median_buy_usd <= 300 ? 3 : 0; s += d; parts.push(`median buy $${t.median_buy_usd < 1 ? t.median_buy_usd.toFixed(2) : t.median_buy_usd.toFixed(0)}${t.median_buy_usd < 1 ? ' (dust-size buys: bot/wash pattern)' : ''}`); }
      if (t.pct_buys_over_1k != null && t.pct_buys_over_1k > 0.2) { s -= 4; parts.push(`${Math.round(t.pct_buys_over_1k * 100)}% of buys over $1K`); } }
    if (x.bp != null) { n++; s += x.bp > 0.55 ? 4 : x.bp < 0.45 ? -4 : 0; parts.push(`buys are ${Math.round(x.bp * 100)}% of trades in the last hour`); }
    if (!n) return null;
    return { score: clamp(s), value: parts.slice(0, 2).join('; '), text: `Launch footprint: ${parts.join('; ')}. Our research found winners usually have many holders and spread-out buying; note the graduation-speed and holder signals are partly look-ahead/artifact in the backtest, so this factor is weighted lightly.` };
  }
  const fRug = (rug) => rug && rug.score != null ? { score: clamp(65 - rug.score) /* clean rug check = mild comfort; high rug risk drags hard */, value: `${rug.score}/100 ${rug.level || ''}`, text: `Rug-risk forecast ${rug.score}/100 (${rug.level}). ${(rug.top || []).slice(0, 2).join('; ') || 'No strong rug signals.'}${rug.dump30 ? ' ⚠ Dump risk flagged for the next 30 days.' : ''}`, cap: rug.score >= 70 ? 'F' : rug.score >= 45 ? 'C' : null } : null;
  const fSleeper = (x) => x ? { score: clamp(x.score), value: `${x.score} (${x.grade})`, text: `Sleeper screen (established coins far below their high): ${x.score}/100, grade ${x.grade}. ${(x.reasons || []).slice(0, 3).join('; ')}.` } : null;
  const fMoon = (x) => x ? { score: clamp(x.score), value: `${x.score} (${x.grade})`, text: `Live-feed asymmetry score ${x.score}/100 (grade ${x.grade}): ${(x.reasons || []).slice(0, 3).join('; ')}.${x.veto ? ' VETO: ' + x.veto : ''}`, cap: x.veto ? 'F' : null } : null;
  function fUnlock(a) { const f = unlocks.factor(a); if (!f) return null; return { adj: -Math.min(30, a.eff * 6), value: a.pct30 != null ? `${a.pct30.toFixed(2)}% circ / 30d` : 'none', text: a.text, cap: f.cap, warn: a.warn }; }

  async function compute() {
    const ps = perps.snapshot(); const stats = perps.loadStats();
    const cat = readJ('crash_catalog.json'); const catBySym = new Map((cat?.catalog || []).map((c) => [String(c.symbol).toUpperCase(), c]));
    const sl = readJ('sleepers.json'); const slBySym = new Map((sl?.items || []).map((x) => [String(x.symbol).toUpperCase(), x]));
    const scr = readJ('screener.json');
    const mac = await macroCtx(3);
    const pats = patternSources();
    const feed = live?.feed?.() || { items: [] };
    const rows = [];
    const build = (base, F) => {
      const factors = [];
      const push = (k, label, f) => {
        if (!f) return factors.push({ key: k, label, available: false });
        const base = { key: k, label, value: f.value, explain: f.text, cap: f.cap || null, warn: f.warn || null };
        if (f.adj != null) factors.push({ ...base, adj: Math.round(f.adj * 10) / 10, kindOf: 'adjustment' });
        else factors.push({ ...base, weight: +(W[k] * (f.weightMul || 1)).toFixed(2), score: Math.round(f.score) });
      };
      for (const [k, label, f] of F) push(k, label, f);
      const av = factors.filter((f) => f.available !== false && f.adj == null);
      const adjs = factors.filter((f) => f.adj != null);
      if (av.length < 2) return null;
      const baseScore = av.reduce((s, f) => s + f.score * f.weight, 0) / av.reduce((s, f) => s + f.weight, 0);
      const adjSum = adjs.reduce((s, f) => s + f.adj, 0);
      const score = clamp(baseScore + adjSum);
      let grade = GRADE(score); const caps = [];
      for (const f of [...av, ...adjs]) if (f.cap && ORDER[f.cap] < ORDER[grade]) { caps.push(`${f.label} caps grade at ${f.cap}`); grade = minGrade(grade, f.cap); }
      const warnings = [...av, ...adjs].filter((f) => f.warn).map((f) => f.warn);
      const strongest = [...av].sort((a, b) => Math.abs(b.score - 50) * b.weight - Math.abs(a.score - 50) * a.weight).slice(0, 2);
      const adjTxt = adjs.filter((f) => f.adj).map((f) => `${f.label.toLowerCase()} ${f.adj}`).join(', ');
      const summary = `${base.sym} grades ${grade} (${score.toFixed(0)}/100${adjTxt ? `; base ${baseScore.toFixed(0)} then ${adjTxt}` : ''}). Biggest drivers: ${strongest.map((f) => `${f.label.toLowerCase()} ${f.score >= 50 ? 'helps' : 'hurts'} (${f.score})`).join(', ')}.${caps.length ? ' ' + caps.join('; ') + '.' : ''}`;
      rows.push({ ...base, score: r1(score), baseScore: r1(baseScore), adjustments: r1(adjSum), grade, caps, warnings, factors, summary });
    };
    // 1) perp-listed tokens (catalog / sleepers / watchlist)
    for (const t of ps.tokens || []) {
      const ua = unlocks.assess(unlocks.find({ sym: t.sym, cgId: t.cgId, price: t.mark }));
      const pe = pats.entries.filter((e) => e.sym === t.sym);
      build({ id: 'perp:' + t.sym, sym: t.sym, name: t.name, kind: 'perp', price: t.mark, fAnn: t.fAnn, unlock: ua && ua.level ? { level: ua.level, pct30: ua.pct30, within: ua.within, warn: ua.warn } : null }, [
        ['crash', 'Crash pattern', fCrash(t, stats, catBySym.get(t.sym))], ['patterns', 'Pattern detectors', fPatterns(pe)], ['pump', 'Pump pattern', null],
        ['rug', 'Rug forecast', null], ['sleeper', 'Sleeper score', fSleeper(slBySym.get(t.sym))], ['moonshot', 'Moonshot score', null],
        ['macro', 'Macro calendar', mac.available ? { adj: mac.score, value: mac.near.length ? mac.near.map((x) => x.type.toUpperCase() + ' ' + (x.days ? '+' + x.days + 'd' : 'today')).join(', ') : 'clear', text: mac.text } : null],
        ['perp', 'Perp funding/OI', fPerp(t)], ['unlocks', 'Token unlocks', fUnlock(ua)],
        ['dev', 'Developer activity', dev ? dev.factor({ cgId: t.cgId, sym: t.sym }) : null],
      ]);
    }
    // 2) live-feed graded tokens (new launches: no perps) — top non-vetoed + vetoed A/B context
    const liveTop = (feed.items || []).filter((x) => x.grade && x.score != null).slice(0, 60);
    const scrBy = new Map((scr?.tokens || []).map((x) => [x.mint, x]));
    for (const x of liveTop) {
      const sc = scrBy.get(x.address);
      const pump = { curve_secs: sc?.curve_secs ?? null, top10: sc?.top10_now ?? null, holders: x.features?.holders ?? sc?.holders_now ?? null, trades: sc?.trades || null, bp: x.features?.bp ?? null };
      const pe = pats.entries.filter((e) => e.key === x.key || (e.sym && e.sym === String(x.symbol || '').toUpperCase() && !e.key));
      build({ id: x.key, sym: x.symbol, name: x.name, kind: 'live', chain: x.chain, price: x.price }, [
        ['crash', 'Crash pattern', null], ['patterns', 'Pattern detectors', fPatterns(pe)], ['pump', 'Pump pattern', fPump(pump)],
        ['rug', 'Rug forecast', fRug(x.rug)], ['sleeper', 'Sleeper score', null], ['moonshot', 'Moonshot score', fMoon(x)],
        ['macro', 'Macro calendar', mac.available ? { adj: mac.score, value: mac.near.length ? mac.near.map((y) => y.type.toUpperCase() + ' ' + (y.days ? '+' + y.days + 'd' : 'today')).join(', ') : 'clear', text: mac.text } : null],
        ['perp', 'Perp funding/OI', null], ['unlocks', 'Token unlocks', null],
      ]);
    }
    // 3) screener tokens not in the live feed
    const seen = new Set(rows.map((r) => r.id.split(':').pop()));
    for (const sc of scr?.tokens || []) {
      if (seen.has(sc.mint)) continue;
      build({ id: 'solana:' + sc.mint, sym: sc.symbol, name: sc.name, kind: 'screener', chain: 'solana' }, [
        ['pump', 'Pump pattern', fPump({ curve_secs: sc.curve_secs, top10: sc.top10_now, holders: sc.holders_now, trades: sc.trades })],
        ['moonshot', 'Moonshot score', { score: clamp(sc.similarity), value: `${sc.similarity}% similar`, text: `Early-feature similarity to past 100x tokens: ${sc.similarity}%. ${scr.disclaimer || ''}` }],
        ['macro', 'Macro calendar', mac.available ? { adj: mac.score, value: mac.near.length ? 'event near' : 'clear', text: mac.text } : null],
      ]);
    }
    rows.sort((a, b) => b.score - a.score);
    return { generatedAt: Date.now(), weights: W, grading: 'Weighted average of available factor scores, then penalty adjustments (macro event proximity up to −10, unlocks up to −30). A ≥ 68, B ≥ 58, C ≥ 48, D ≥ 38, else F; caps: rug ≥70 → F, rug ≥45 → C, live veto → F, funding ≥100%/yr → C, unlock ≥2% effective within 14d → C, ≥5% → D.',
      macro: mac, patterns: { files: pats.files, module: pats.module, entries: pats.entries.length, status: pats.module || pats.files.length ? `lib/patterns.js${pats.files.length ? ' + ' + pats.files.join(', ') : ''} connected: ${pats.entries.length} live detector flag(s) right now${pats.entries.length ? '' : ' (factor skipped for every token until a detector fires)'}` : 'no lib/patterns.js or data/patterns_*_live.json yet: factor skipped (pluggable, picked up automatically when present)' },
      count: rows.length, tokens: rows, nfa: 'Model estimate from public data. Not financial advice.' };
  }
  return { compute, macroCtx, patternSources };
}
module.exports = { createComposite };
