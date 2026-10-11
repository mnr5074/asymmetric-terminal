'use strict';
// Session seasonality, live layer. Backtest: research/seasonality.py -> data/seasonality.json (full stats) + data/seasonality_live.json
// (window definitions, NYSE holidays, per-window state per token / pooled). Here we only evaluate "which windows are active now / start
// within the next hour" in DST-correct local time (Intl time zones) and look up the precomputed state. No numbers are made up here:
// every ratio shown comes from the JSON. Free data only (Binance public archives + GeckoTerminal), no Nansen / X.
const fs = require('fs');
const path = require('path');
let C = { mt: 0, live: null, full: null, fullMt: 0, dir: null };
function loadLive(DATA_DIR) {
  try { const f = path.join(DATA_DIR, 'seasonality_live.json'); const mt = fs.statSync(f).mtimeMs; if (C.dir !== DATA_DIR || mt !== C.mt) { C.live = JSON.parse(fs.readFileSync(f, 'utf8')); C.mt = mt; C.dir = DATA_DIR; } return C.live; } catch { return null; }
}
function loadFull(DATA_DIR) {
  try { const f = path.join(DATA_DIR, 'seasonality.json'); const mt = fs.statSync(f).mtimeMs; if (mt !== C.fullMt) { C.full = JSON.parse(fs.readFileSync(f, 'utf8')); C.fullMt = mt; } return C.full; } catch { return null; }
}
const fmtCache = {};
function parts(date, tz) {
  const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }));
  const o = {}; for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { ymd: `${o.year}-${o.month}-${o.day}`, m: (+o.hour % 24) * 60 + +o.minute, wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(o.weekday) };
}
// instant membership, same rules as research/seasonality.py membership() (there: whole bar inside; here: the instant)
function inWindow(w, date, hol) {
  if (w.res_only) return false; // hourly-only proxy windows are never used live
  const { ymd, m, wd } = parts(date, w.tz);
  const d = w.days;
  if (d === 'cme_gap') return (wd === 4 && m >= 1020) || wd === 5 || (wd === 6 && m < 1080);
  const inside = m >= w.start && m < w.end;
  if (d === 'weekend') return inside && wd >= 5;
  if (d.startsWith('dow:')) return inside && wd === +d.slice(4);
  if (d === 'local_weekday') return inside && wd < 5;
  if (d === 'nyse') return inside && wd < 5 && !hol.has(ymd);
  if (d === 'nyse_holiday') return inside && wd < 5 && hol.has(ymd);
  return false;
}
function clock(L, now = new Date(), horizonMin = 24 * 60) {
  const hol = new Set(L.nyse_holidays || []); const W = L.windows || [];
  const active = W.filter((w) => inWindow(w, now, hol)).map((w) => w.id);
  const next = {}, ends = {};
  for (let k = 5; k <= horizonMin; k += 5) {
    const t = new Date(now.getTime() + k * 60e3);
    for (const w of W) {
      if (w.res_only) continue;
      const on = inWindow(w, t, hol);
      if (on && !active.includes(w.id) && next[w.id] == null) next[w.id] = k;
      if (!on && active.includes(w.id) && ends[w.id] == null) ends[w.id] = k;
    }
  }
  return { now: now.toISOString(), active, startsInMin: next, endsInMin: ends };
}
const label = (L, id) => (L.windows || []).find((w) => w.id === id)?.label || id;
const ALIAS = { WETH: 'ETH', WBTC: 'BTC', CBBTC: 'BTC', WSOL: 'SOL', '1000PEPE': 'PEPE', '1000BONK': 'BONK', KPEPE: 'PEPE', KBONK: 'BONK' };
function profileFor(L, { sym, kind } = {}) {
  const s = ALIAS[String(sym || '').toUpperCase()] || String(sym || '').toUpperCase();
  if (s && L.tokens?.[s]) return { source: `${s} own history (Binance)`, scope: 'token', p: L.tokens[s] };
  if (kind === 'perp' || kind === 'major') return { source: 'pooled majors (Binance)', scope: 'pooled_majors', p: L.pooled_majors };
  return { source: 'pooled catalog DEX tokens (GeckoTerminal, run-up/crash periods)', scope: 'pooled_catalog', p: L.pooled_catalog };
}
const fx = (x) => (x == null ? '?' : (+x).toFixed(2));
function evaluate(L, tok, ck) {
  ck = ck || clock(L); const pr = profileFor(L, tok);
  const row = (id, extra) => { const s = pr.p?.[id]; return s ? { id, label: label(L, id), ...s, ...extra } : null; };
  const now = ck.active.map((id) => row(id)).filter(Boolean);
  const entering = Object.entries(ck.startsInMin).filter(([, m]) => m <= 60).map(([id, m]) => row(id, { inMin: m })).filter(Boolean);
  const flagged = [...now, ...entering].filter((x) => x.state === 'volatile' || x.state === 'quiet');
  flagged.sort((a, b) => Math.abs(Math.log(b.vol_ratio || 1)) - Math.abs(Math.log(a.vol_ratio || 1)));
  const top = flagged[0] || null;
  const crashHot = [...now, ...entering].filter((x) => x.crash_onset_q_volume != null && x.crash_onset_q_volume < 0.05 && x.crash_onset_ratio_volume > 1);
  const verdict = top ? top.state : 'normal';
  const desc = (x) => `${x.inMin != null ? `entering in ${x.inMin} min: ` : 'now: '}${x.label} (moves ${fx(x.vol_ratio)}x as big as outside it, ${x.res} bars, q=${x.q != null ? (+x.q).toPrecision(2) : '?'})`;
  const text = top ? `Historically ${verdict === 'volatile' ? 'VOLATILE' : 'QUIET'} window for this token (${pr.source}). ${desc(top)}.${crashHot.length ? ` Catalog crash onsets cluster here (${fx(crashHot[0].crash_onset_ratio_volume)}x the volume-weighted expectation).` : ''}`
    : `No historically unusual session window right now or in the next hour (${pr.source}).`;
  return { profile: pr.source, scope: pr.scope, verdict, top, now, entering, crashCluster: crashHot.map((x) => x.id), text };
}
// composite factor: small-weight timing/risk modifier (documented in lib/composite.js W.season). Score: volatile window 42 (38 if catalog
// crash onsets also cluster there), quiet window 54, normal 50. It never caps a grade.
function factor(DATA_DIR, tok) {
  const L = loadLive(DATA_DIR); if (!L) return null;
  const e = evaluate(L, tok);
  const score = e.verdict === 'volatile' ? (e.crashCluster.length ? 38 : 42) : e.verdict === 'quiet' ? 54 : 50;
  const value = e.top ? `${e.verdict} · ${e.top.id}${e.top.inMin != null ? ` in ${e.top.inMin}m` : ''} · ${fx(e.top.vol_ratio)}x` : 'normal';
  return { score, value, text: `Session timing: ${e.text} Timing/risk modifier only (small weight): ${e.verdict === 'volatile' ? 'bigger swings both ways in this window, so a slight risk haircut.' : e.verdict === 'quiet' ? 'smaller swings than usual in this window, so a slight comfort nudge.' : 'neutral.'}` };
}
function liveState(DATA_DIR, feed) {
  const L = loadLive(DATA_DIR); if (!L) return { ok: false, error: 'data/seasonality_live.json missing: run research/seasonality.py' };
  const ck = clock(L);
  const majors = Object.keys(L.tokens || {}).map((s) => { const e = evaluate(L, { sym: s }, ck); return { sym: s, verdict: e.verdict, top: e.top ? { id: e.top.id, label: e.top.label, vol_ratio: e.top.vol_ratio, inMin: e.top.inMin ?? null } : null }; });
  const nFeed = (feed?.items || []).length;
  return { ok: true, clock: { ...ck, activeLabels: ck.active.map((id) => label(L, id)), next: Object.entries(ck.startsInMin).filter(([id]) => !id.startsWith('dow_')).sort((a, b) => a[1] - b[1]).slice(0, 6).map(([id, m]) => ({ id, label: label(L, id), inMin: m })) },
    pooledMajors: evaluate(L, { kind: 'major' }, ck), pooledCatalog: { ...evaluate(L, { kind: 'live' }, ck), appliesTo: `${nFeed} live-feed tokens (no per-token history: pooled catalog profile)` }, majors, rule: L.rule, generatedAt: L.generatedAt };
}
function summary(DATA_DIR, feed) {
  const F = loadFull(DATA_DIR);
  const strip = F ? { definition: F.definition, data: F.data, findings: F.findings, coverage: { majors_1h: F.majors?.res_1h?.coverage, majors_5m: F.majors?.res_5m?.coverage, catalog_dex: { n_tokens: F.catalog_dex?.n_tokens, n_valid_bars: F.catalog_dex?.n_valid_bars, note: F.catalog_dex?.note } },
    events: F.events, kruskal_wallis: Object.fromEntries(Object.entries(F.majors?.res_1h?.per_token || {}).map(([s, d]) => [s, d.kruskal_wallis])), n_tests_bh: F.n_tests_bh, generatedAt: F.generatedAt } : { ok: false };
  return { ...strip, live: liveState(DATA_DIR, feed) };
}
function routes({ DATA_DIR, live }) {
  const feed = () => { try { return live ? live.feed() : JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'live_feed.json'), 'utf8')); } catch { return null; } };
  return {
    async '/api/seasonality'() { return summary(DATA_DIR, feed()); },
    async '/api/seasonality/live'(q) { const L = loadLive(DATA_DIR); if (!L) return { ok: false }; const sym = q?.get?.('sym'); return sym ? evaluate(L, { sym, kind: q.get('kind') || 'perp' }) : liveState(DATA_DIR, feed()); },
    async '/api/seasonality/full'() { return loadFull(DATA_DIR) || { ok: false }; },
  };
}
module.exports = { routes, factor, evaluate, clock, liveState, summary, loadLive };
