'use strict';
// Social sentiment desk: mention velocity, crypto-tuned language tone, 0-100 oscillator, price divergences, contrarian composite factor.
// Data: data/sentiment_counts.json + data/sentiment_samples.json, written by research/sentiment.py from the FREE built-in X read tools
// (MCP namespace 'x') that the assistant runs on a schedule (the server itself cannot call them). Never uses the paid X API (lib/xapi.js).
// Formats and query list: research/sentiment/COLLECTOR.md. Historical proxy study: data/sentiment_history.json (research/sentiment/proxy_history.py).
// Everything here is a model estimate from public data. Not financial advice.
const fs = require('fs');
const path = require('path');

const H = 3600e3, D = 24 * H;
const STALE_MS = 26 * H; // composite factor is skipped when counts are older than this
// Regime break (2026-10-18): the free X search started stripping '$', so cashtag-only queries matched plain words ("$NOT" -> "not").
// 14 queries were rewritten (research/sentiment/queries.json 'regime'); older data is not comparable and was dropped at ingest.
// Until PROVISIONAL_DAYS of clean collection exist, the composite factor runs at PROVISIONAL_MUL of its weight (0.25 -> 0.1) for ALL tokens
// (the pooled tone baseline also shifted); tokens marked quality 'unreliable' are shown but never feed the composite.
const PROVISIONAL_DAYS = 3, PROVISIONAL_MUL = 0.4;
const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function phi(z) { // standard normal CDF (Abramowitz-Stegun 26.2.17)
  const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p;
}
// documented constants (COLLECTOR.md §5)
const CFG = { attnWeight: 0.6, toneWeight: 0.4, minPolarPosts: 4, minDailyCount: 20, euphoric: 80, heated: 65, quiet: 35, capitulation: 20,
  flatPct: 3, coolToneDelta: -0.10, coolDayChange: -0.20, spikeZ: 2, spikeRatio: 2, spikeMinCount: 30 };

function createSentiment({ DATA_DIR }) {
  const cache = {};
  function readJ(f) { const p = path.join(DATA_DIR, f); try { const st = fs.statSync(p); const c = cache[f]; if (c && c.t === st.mtimeMs) return c.v; const v = JSON.parse(fs.readFileSync(p, 'utf8')); cache[f] = { t: st.mtimeMs, v }; return v; } catch { return null; } }

  function velocity(c) {
    const rows = c.hourly || []; if (!rows.length) return null;
    const T = Date.parse(c.windowEnd || c.fetchedAt);
    const day = [0, 0, 0, 0, 0, 0, 0];
    for (const [, e, n] of rows) { const k = Math.floor((T - e) / D); if (k >= 0 && k < 7) day[k] += n; }
    const c24 = day[0], base = day.slice(1), m = mean(base);
    const lb = base.map((x) => Math.log1p(x)); const lsd = Math.max(sd(lb) || 0, 0.10);
    const z = (Math.log1p(c24) - mean(lb)) / lsd;
    // last 6h vs every earlier 6h block in the window (is it spiking right now?)
    const blocks = []; for (let k = 0; k < 28; k++) blocks.push(rows.filter(([, e]) => e <= T - k * 6 * H && e > T - (k + 1) * 6 * H).reduce((s, r) => s + r[2], 0));
    const lb6 = blocks.slice(1).map((x) => Math.log1p(x)); const z6 = (Math.log1p(blocks[0]) - mean(lb6)) / Math.max(sd(lb6) || 0, 0.10);
    const spark = rows.filter(([, e]) => e > T - 7 * D).map((r) => r[2]);
    return { asOf: new Date(T).toISOString(), c24, prev24: day[1], avgDaily7d: r1(m), daily: day.slice().reverse(), ratio: m ? r2(c24 / m) : null, z: r2(z), z6h: r2(z6), last6h: blocks[0],
      dayChange: day[1] ? r2(c24 / day[1] - 1) : null, total7d: c.total7d, lowVolume: c24 < CFG.minDailyCount, spark };
  }
  function tone(posts, T) {
    const win = (lo, hi) => {
      const ps = posts.filter((p) => !p.bot && p.weight > 0 && p.t > lo && p.t <= hi);
      let B = 0, N = 0, W = 0, cw = 0, nb = 0, nn = 0;
      for (const p of ps) { W += p.weight; cw += p.weight * p.compound; if (p.compound >= 0.05) { B += p.weight; nb++; } else if (p.compound <= -0.05) { N += p.weight; nn++; } }
      return { posts: ps.length, polar: nb + nn, bull: nb, bear: nn, bullShare: r2((B + 1) / (B + N + 2)), meanCompound: W ? r2(cw / W) : null, ok: nb + nn >= CFG.minPolarPosts };
    };
    return { last24h: win(T - D, T + H), prior: win(T - 7 * D, T - D) };
  }
  function priceStats(pr, T) {
    const h = (pr?.hourly || []).filter((r) => r[1] != null); if (h.length < 6) return null;
    const last = h[h.length - 1]; const tl = last[0];
    const in7 = h.filter((r) => r[0] > tl - 7 * D); const hi7 = Math.max(...in7.map((r) => r[1])); const lo7 = Math.min(...in7.map((r) => r[1]));
    const at = (dt) => { let b = null; for (const r of h) if (r[0] <= tl - dt) b = r; return b ? b[1] : null; };
    const coverageH = Math.round((tl - h[0][0]) / H) + 1; const full7 = coverageH >= 6.5 * 24;
    const p24 = at(D), p7 = full7 ? in7[0][1] : null;
    const hi12 = Math.max(...h.filter((r) => r[0] > tl - 12 * H).map((r) => r[1]));
    return { source: pr.source, asOf: new Date(tl + H).toISOString(), last: last[1], ch24: p24 ? r2((last[1] / p24 - 1) * 100) : null, ch7d: p7 ? r2((last[1] / p7 - 1) * 100) : null, hi7, lo7, coverageH,
      fromHi7Pct: r2((last[1] / hi7 - 1) * 100), newHigh7d: full7 && hi12 >= hi7 && last[1] >= hi7 * 0.97, spark: in7.map((r) => r[1]) };
  }
  // Tone baseline: crypto X is bullish-skewed (most opinionated posts are bullish), so tone is scored relative to the pooled prior-window
  // bullish share across all collected tokens (median / sd), not relative to 50%. Falls back to 0.75 / 0.15 with < 8 usable tokens.
  let baseMemo = null;
  function toneBase() {
    const C = readJ('sentiment_counts.json'), S = readJ('sentiment_samples.json'); const k = (C?.updatedAt || '') + (S?.updatedAt || '');
    if (baseMemo && baseMemo.k === k) return baseMemo.v;
    const xs = [];
    for (const [sym, c] of Object.entries(C?.tokens || {})) { const v = velocity(c); if (!v) continue; const tn = tone(S?.tokens?.[sym]?.posts || [], Date.parse(v.asOf)); if (tn.prior.ok) xs.push(tn.prior.bullShare); }
    xs.sort((a, b) => a - b);
    const v = xs.length >= 8 ? { mu: xs[Math.floor(xs.length / 2)], sigma: Math.max(0.08, sd(xs)), n: xs.length, src: 'pooled prior-window bullish share (median, sd)' } : { mu: 0.75, sigma: 0.15, n: xs.length, src: 'fallback constants' };
    baseMemo = { k, v }; return v;
  }
  function marketZ() { // BTC+ETH+SOL summed counts: market-wide attention (weekend / macro cycles); reported, not used in the oscillator
    const C = readJ('sentiment_counts.json'); const ms = ['BTC', 'ETH', 'SOL'].map((s) => C?.tokens?.[s]).filter(Boolean); if (ms.length < 2) return null;
    const by = new Map(); for (const c of ms) for (const r of c.hourly || []) { const k = r[1]; const o = by.get(k) || [r[0], r[1], 0]; o[2] += r[2]; by.set(k, o); }
    const v = velocity({ hourly: [...by.values()].sort((a, b) => a[0] - b[0]), windowEnd: ms[0].windowEnd, fetchedAt: ms[0].fetchedAt }); return v ? v.z : null;
  }
  function read(sym) {
    const C = readJ('sentiment_counts.json'), S = readJ('sentiment_samples.json'); const c = C?.tokens?.[sym]; if (!c) return null;
    const v = velocity(c); if (!v) return null;
    const T = Date.parse(v.asOf); const posts = S?.tokens?.[sym]?.posts || [];
    const tn = tone(posts, T); const px = priceStats(c.price, T);
    const A = 100 * phi(clamp(v.z, -4, 4));
    const tb = toneBase(); const toneOk = tn.last24h.ok;
    const Tsc = toneOk ? 100 * phi(clamp((tn.last24h.bullShare - tb.mu) / tb.sigma, -4, 4)) : null;
    const osc = toneOk ? CFG.attnWeight * A + CFG.toneWeight * Tsc : A;
    const mz = marketZ(); const wd = new Date(T - 12 * H).getUTCDay();
    let zone = 'neutral';
    if (osc >= CFG.euphoric) zone = 'euphoric'; else if (osc >= CFG.heated) zone = 'heated'; else if (osc <= CFG.capitulation) zone = toneOk && Tsc < 35 ? 'capitulation' : 'silence'; else if (osc <= CFG.quiet) zone = 'quiet';
    const toneDelta = toneOk && tn.prior.ok ? r2(tn.last24h.bullShare - tn.prior.bullShare) : null;
    const flags = [];
    if (px?.newHigh7d) {
      const why = [];
      if (toneDelta != null && toneDelta <= CFG.coolToneDelta) why.push(`bullish share of posts fell ${Math.round(-toneDelta * 100)} pts vs the prior 6 days`);
      if (v.dayChange != null && v.dayChange <= CFG.coolDayChange && !v.lowVolume) why.push(`mentions down ${Math.round(-v.dayChange * 100)}% vs the previous 24h`);
      if (v.z <= -0.5 && !v.lowVolume) why.push(`mention velocity below its 7d norm (z ${v.z})`);
      if (why.length) flags.push({ kind: 'high_while_cooling', bias: 'bearish', text: `Price set a new 7-day high (${px.last} , ${px.fromHi7Pct}% from the high) while social interest is cooling: ${why.join('; ')}. Rallies that lose the crowd tend to stall.` });
    }
    if ((v.z >= CFG.spikeZ || (v.ratio != null && v.ratio >= CFG.spikeRatio)) && v.c24 >= CFG.spikeMinCount && px?.ch24 != null && Math.abs(px.ch24) < CFG.flatPct) {
      flags.push({ kind: 'spike_flat_price', bias: 'caution', text: `Mentions spiked (${v.c24} posts in 24h, ${v.ratio}x the 7-day daily average, z ${v.z}) but price barely moved (${px.ch24}% 24h). Attention without price follow-through is either distribution into hype or an early setup; treat it as a warning, not a buy signal.` });
    }
    return { sym, tier: c.tier, key: c.key || null, query: c.query, countsAt: c.fetchedAt, ageMin: Math.round((Date.now() - T) / 60e3), velocity: v, tone: { ...tn, delta: toneDelta },
      grokNews: (() => { const g = readJ('grok_signals.json')?.tokens?.[sym]; return g ? { headlineTone: g.sent, n: g.n, maxUrgency: g.maxUrg, hack: g.hack, src: 'data/grok_signals.json (lib/grok.js, read-only; not used in the oscillator)' } : null; })(),
      oscillator: r1(osc), attention: r1(A), toneScore: r1(Tsc), toneBaseline: tb, zone, zVsMarket: mz == null ? null : r2(v.z - mz), marketZ: mz,
      weekend: wd === 0 || wd === 6, divergences: flags, price: px, news: S?.tokens?.[sym]?.news || null,
      lowSample: v.lowVolume || !toneOk, ...regimeInfo(c) };
  }
  function regimeInfo(c) {
    const since = c.regimeSince ? Date.parse(c.regimeSince) : null; const cleanDays = since ? r1((Date.now() - since) / D) : null;
    const quality = c.quality || 'clean'; const pd = c.provisionalDays || PROVISIONAL_DAYS; // per-token override (new tokens need a longer baseline)
    const isNew = /^new token/i.test(c.regimeReason || '');
    return { quality, qualityNote: c.qualityNote || null, regime: since ? { since: c.regimeSince, cleanDays, provisional: cleanDays < pd, provisionalDays: pd, breaks: c.regimeBreaks || [],
      note: (isNew ? `Added to the watch ${c.regimeSince.slice(0, 10)}; no earlier collected history.` : `Query changed ${c.regimeSince.slice(0, 10)} (X search strips '$'); data before that is a different series and was dropped.`) + ` ${cleanDays < pd ? 'Provisional: under ' + pd + ' days of clean collection.' : ''}` } : null,
      suppressed: quality === 'unreliable', suppressReason: quality === 'unreliable' ? (c.qualityNote || 'query not clean') : null };
  }
  function lastRegime() { // newest regime start across tokens -> global provisional window for the composite weight
    const C = readJ('sentiment_counts.json'); let m = 0; for (const c of Object.values(C?.tokens || {})) if (c.regimeSince && !/^new token/i.test(c.regimeReason || '')) m = Math.max(m, Date.parse(c.regimeSince)); return m || null; // a newly added token is provisional on its own, not a global break
  }
  function all() {
    const C = readJ('sentiment_counts.json'); if (!C) return [];
    return Object.keys(C.tokens || {}).map(read).filter(Boolean).sort((a, b) => b.oscillator - a.oscillator);
  }
  function lookup({ sym, key }) {
    const C = readJ('sentiment_counts.json'); if (!C) return null;
    if (key) { const k = Object.values(C.tokens || {}).find((t) => t.key && t.key === key); return k ? read(k.sym) : null; }
    return sym && C.tokens?.[String(sym).toUpperCase()] ? read(String(sym).toUpperCase()) : null;
  }
  // composite hook: contrarian factor (COLLECTOR.md §6). Euphoria costs points, capitulation/silence adds a little; divergences cost points.
  function factor(q) {
    const r = lookup(q); if (!r) return null;
    if (Date.now() - Date.parse(r.velocity.asOf) > STALE_MS) return null;
    if (r.suppressed) return null; // unreliable query (see queries.json quality): never feeds the composite
    const lr = lastRegime(); const ownProv = !!r.regime?.provisional && /^Added/.test(r.regime.note || ''); const prov = (lr && Date.now() - lr < PROVISIONAL_DAYS * D) || ownProv;
    const o = r.oscillator; let s = 50;
    if (o >= CFG.euphoric) s = 50 - (o - CFG.euphoric) * 1.0; else if (o >= CFG.heated) s = 50 - (o - CFG.heated) * 0.2; else if (o <= CFG.capitulation) s = 50 + (CFG.capitulation - o) * (r.zone === 'silence' && r.weekend ? 0.3 : 0.6); // weekend lulls are normal: half credit for weekend 'silence'
    for (const f of r.divergences) s += f.kind === 'high_while_cooling' ? -6 : -3;
    s = clamp(s, 25, 65);
    const ev = readJ('sentiment_history.json')?.summary_line;
    return { score: s, weightMul: (r.lowSample ? 0.5 : 1) * (prov ? PROVISIONAL_MUL : 1), value: `osc ${o} (${r.zone})${r.divergences.length ? ', ' + r.divergences.map((f) => f.kind).join('+') : ''}`,
      text: `X social oscillator ${o}/100 (${r.zone}): ${r.velocity.c24} posts in 24h vs ${r.velocity.avgDaily7d}/day over the prior 6 days (z ${r.velocity.z})${r.tone.last24h.ok ? `, ${Math.round(r.tone.last24h.bullShare * 100)}% of weighted opinionated posts bullish` : ', too few opinionated posts to read tone'}. Used contrarian: crowd euphoria lowers the score, capitulation/silence raises it slightly.${r.divergences.length ? ' ' + r.divergences.map((f) => f.text).join(' ') : ''}${ev ? ' Evidence (proxy backtest): ' + ev : ''}${r.lowSample ? ' Low sample, half weight.' : ''}${prov ? (ownProv ? ` Weight cut to ${PROVISIONAL_MUL}x until ${new Date(Date.parse(r.regime.since) + r.regime.provisionalDays * D).toISOString().slice(0, 10)}: newly added to the watch, under ${r.regime.provisionalDays} days of history.` : ` Weight cut to ${PROVISIONAL_MUL}x until ${new Date(lr + PROVISIONAL_DAYS * D).toISOString().slice(0, 10)}: X queries were rebuilt on ${new Date(lr).toISOString().slice(0, 10)} and need a few days of clean data.`) : ''} Strength: unproven (no X-data backtest; proxy backtest found no reliable edge).` };
  }
  function api(q) {
    const C = readJ('sentiment_counts.json'), S = readJ('sentiment_samples.json'), L = readJ('sentiment_calls.json'), Hh = readJ('sentiment_history.json');
    const rows = all().map((r) => { if (!(q && q.get && q.get('full') === '1')) { delete r.velocity.spark; if (r.price) delete r.price.spark; } return r; });
    if (q && q.get && q.get('sym')) { const s = q.get('sym').toUpperCase(); const r = rows.find((x) => x.sym === s); const posts = (S?.tokens?.[s]?.posts || []).filter((p) => !p.bot).sort((a, b) => b.weight - a.weight).slice(0, 15); return r ? { ...r, topPosts: posts } : { error: 'no data for ' + s }; }
    return {
      generatedAt: Date.now(), countsUpdatedAt: C?.updatedAt || null, samplesUpdatedAt: S?.updatedAt || null, lexicon: S?.lexicon || null, source: C?.source || null,
      status: C ? `${rows.length} tokens; counts ${Math.round((Date.now() - Date.parse(C.updatedAt)) / 60e3)} min old` : 'no data yet: run the collector (research/sentiment/COLLECTOR.md)',
      calls: L ? { today: L.today, last: (L.runs || []).slice(-1)[0] || null } : null, config: CFG,
      regime: (() => { const lr = lastRegime(); return lr ? { since: new Date(lr).toISOString(), provisionalUntil: new Date(lr + PROVISIONAL_DAYS * D).toISOString(), provisional: Date.now() - lr < PROVISIONAL_DAYS * D, compositeWeightMul: Date.now() - lr < PROVISIONAL_DAYS * D ? PROVISIONAL_MUL : 1,
        text: "Regime break: on " + new Date(lr).toISOString().slice(0, 10) + " the free X search began stripping '$', so cashtag-only queries matched plain words. 14 queries were rewritten (names, contract addresses, AND crypto words); history before the change was dropped (not comparable). Composite weight is cut until a few days of clean data exist." } : null; })(),
      suppressed: rows.filter((r) => r.suppressed).map((r) => ({ sym: r.sym, why: r.suppressReason })), strength: 'unproven',
      euphoric: rows.filter((r) => r.oscillator >= CFG.euphoric).map((r) => r.sym), capitulation: rows.filter((r) => r.oscillator <= CFG.capitulation).map((r) => r.sym),
      divergences: rows.flatMap((r) => r.divergences.map((f) => ({ sym: r.sym, ...f }))),
      tokens: rows, history: Hh ? { generatedAt: Hh.generatedAt, proxy: Hh.proxy, summary_line: Hh.summary_line, tests: Hh.tests, caveats: Hh.caveats, coverage: Hh.coverage } : null,
      nfa: 'Model estimate from public data (free X read tools). Not financial advice.',
    };
  }
  return { all, read, lookup, factor, api, CFG };
}
module.exports = { createSentiment };
