// Call log + forward-performance tracker + report card + missed winners + auto-recalibration for the Live Alpha Feed.
// Every graded pick (A-F) is logged when first graded (and again when its grade changes). Estimates, not advice.
'use strict';
const fs = require('fs');
const path = require('path');
const HZ = [['5m', 5 * 60e3], ['15m', 15 * 60e3], ['1h', 3600e3], ['4h', 4 * 3600e3], ['24h', 86400e3], ['3d', 3 * 86400e3], ['7d', 7 * 86400e3]];
const COMP = ['flow', 'participation', 'safety', 'upside', 'similarity', 'narrative', 'smart', 'attention', 'rugSafe'];
const med = (a) => { const s = a.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const avg = (a) => { const s = a.filter((x) => x != null && isFinite(x)); return s.length ? s.reduce((p, c) => p + c, 0) / s.length : null; };
const frac = (a, f) => (a.length ? a.filter(f).length / a.length : null);

function createCalls({ DATA_DIR, dsTokens, live, log = () => {} }) {
  const file = path.join(DATA_DIR, 'calls.json');
  const wfile = path.join(DATA_DIR, 'live_weights.json');
  let calls = [];
  try { calls = JSON.parse(fs.readFileSync(file, 'utf8')).calls || []; } catch {}
  const lastByKey = new Map(); for (const c of calls) lastByKey.set(c.key, c);
  let recal = null; try { recal = JSON.parse(fs.readFileSync(wfile, 'utf8')); } catch {}
  const peak = (c) => c.maxPx / c.px0;
  const retNow = (c) => (c.px / c.px0 - 1) * 100;

  function logCalls(items) {
    const now = Date.now(); let n = 0;
    for (const x of items) {
      if (!x.price) continue;
      const prev = lastByKey.get(x.key);
      if (prev && (prev.grade === x.grade || now - prev.t < 30 * 60e3)) continue;
      const c = { id: x.key + '@' + now, key: x.key, chain: x.chain, address: x.address, symbol: x.symbol, name: x.name, url: x.url, t: now, grade: x.grade, score: x.score, veto: x.veto || null, rugRisk: x.rug?.score ?? null,
        px0: x.price, mc0: x.mcap || x.fdv, liq0: x.liq, comps: x.components, feat: x.features, regrade: !!prev, px: x.price, maxPx: x.price, minPx: x.price, at: {}, rugged: false, lastT: now };
      calls.push(c); lastByKey.set(x.key, c); n++;
    }
    if (calls.length > 30000) calls.splice(0, calls.length - 30000);
    return n;
  }
  function apply(c, px, liq, now) {
    if (!px) return;
    c.px = px; c.lastT = now; c.liq = liq;
    if (px > c.maxPx) c.maxPx = px; if (px < c.minPx) c.minPx = px;
    for (const [h, ms] of HZ) if (!c.at[h] && now - c.t >= ms) c.at[h] = { ret: (px / c.px0 - 1) * 100, peak: c.maxPx / c.px0, dd: (c.minPx / c.px0 - 1) * 100 };
    if (!c.rugged && (px <= c.px0 * 0.1 || (liq != null && liq < 1000 && (c.liq0 || 0) >= 3000))) { c.rugged = true; c.rugT = now; }
  }
  async function track(items) {
    const now = Date.now(); const byKey = new Map(items.map((x) => [x.key, x]));
    const open = calls.filter((c) => now - c.t < 7.2 * 86400e3);
    const missing = {};
    for (const c of open) { const x = byKey.get(c.key); if (x) apply(c, x.price, x.liq, now); else if (now - c.lastT > 4 * 60e3) (missing[c.chain] ||= new Set()).add(c.address); }
    for (const [chain, set] of Object.entries(missing)) {
      try {
        const m = await dsTokens(chain, [...set].slice(0, 300));
        for (const c of open) {
          if (c.chain !== chain || !set.has(c.address)) continue;
          if (m[c.address]) apply(c, m[c.address].priceUsd, m[c.address].liquidityUsd, now);
          else if (m[c.address] === null && !c.rugged && now - c.t > 3600e3 && ++c.gone > 10) { c.rugged = true; c.rugT = now; c.rugWhy = 'pair delisted'; }
        }
      } catch {}
    }
  }
  function save() { fs.writeFileSync(file + '.tmp', JSON.stringify({ savedAt: Date.now(), calls })); fs.renameSync(file + '.tmp', file); }
  function bucket(xs) { const b = { '<0.5x': 0, '0.5-1x': 0, '1-2x': 0, '2-5x': 0, '5-10x': 0, '10x+': 0 }; for (const x of xs) b[x < 0.5 ? '<0.5x' : x < 1 ? '0.5-1x' : x < 2 ? '1-2x' : x < 5 ? '2-5x' : x < 10 ? '5-10x' : '10x+']++; return b; }
  function reportCard() {
    const by = {};
    for (const g of ['A', 'B', 'C', 'D', 'F', 'U']) { // U = grade v2 'Unrated — safety checks only' (calls before 2026-10-18 carry the legacy letters)
      const cs = calls.filter((c) => c.grade === g); const r24 = cs.filter((c) => c.at['24h']);
      by[g] = { n: cs.length, resolved24h: r24.length, hit2x: frac(cs, (c) => peak(c) >= 2), hit5x: frac(cs, (c) => peak(c) >= 5), hit10x: frac(cs, (c) => peak(c) >= 10), hit100x: frac(cs, (c) => peak(c) >= 100),
        rugRate: frac(cs, (c) => c.rugged), winRateNow: frac(cs, (c) => retNow(c) > 0), winRate24h: frac(r24, (c) => c.at['24h'].ret > 0), median24h: med(r24.map((c) => c.at['24h'].ret)), avg24h: avg(r24.map((c) => c.at['24h'].ret)),
        medianNow: med(cs.map(retNow)), avgNow: avg(cs.map(retNow)), medianPeak: med(cs.map(peak)), peakDist: bucket(cs.map(peak)),
        byHorizon: Object.fromEntries(HZ.map(([h]) => { const r = cs.filter((c) => c.at[h]); return [h, { n: r.length, median: med(r.map((c) => c.at[h].ret)), win: frac(r, (c) => c.at[h].ret > 0), medPeak: med(r.map((c) => c.at[h].peak)), medDD: med(r.map((c) => c.at[h].dd)) }]; })) };
    }
    return { generatedAt: Date.now(), total: calls.length, firstCallAt: calls[0]?.t || null, byGrade: by, horizons: HZ.map(([h]) => h),
      note: 'Hit rates use the peak multiple reached since the call (up to 7 days; young calls have had less time). Returns are % change from the DexScreener price at the call; slippage, fees, MEV and exit liquidity are ignored, so real results are worse.' };
  }
  const slim = (c) => ({ key: c.key, chain: c.chain, symbol: c.symbol, url: c.url, t: c.t, grade: c.grade, score: c.score, veto: c.veto, rugRisk: c.rugRisk, px0: c.px0, mc0: c.mc0, px: c.px, retNow: retNow(c), peak: peak(c), dd: (c.minPx / c.px0 - 1) * 100, rugged: c.rugged, at: c.at });
  function missedWinners() {
    const now = Date.now();
    const missed = calls.filter((c) => (c.grade === 'D' || c.grade === 'F') && peak(c) >= 2);
    const failed = calls.filter((c) => (c.grade === 'A' || c.grade === 'B') && now - c.t > 4 * 3600e3 && (peak(c) < 1.2 || c.rugged));
    const keys = [...COMP.map((k) => ['comp', k]), ...['bp', 'accel', 'ub', 'holders', 'hVel', 'liqCh1h', 'fdv', 'liq', 'v1h', 'ch1', 'risk', 'ageH', 'sim', 'themeHeat', 'socials', 'boosts', 'devPrior', 'rug'].map((k) => ['feat', k])];
    const val = (c, [t, k]) => (t === 'comp' ? c.comps?.[k] : c.feat?.[k]);
    const gaps = keys.map((k) => { const a = med(missed.map((c) => val(c, k))), b = med(failed.map((c) => val(c, k))); return { feature: (k[0] === 'comp' ? 'component:' : '') + k[1], missedWinners: a, failedAB: b, diff: a != null && b != null ? (a - b) / (Math.abs(a) + Math.abs(b) || 1) : null }; })
      .filter((x) => x.diff != null).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
    const vetoes = {}; for (const c of missed) if (c.veto) vetoes[c.veto] = (vetoes[c.veto] || 0) + 1;
    return { missedCount: missed.length, failedABCount: failed.length, topMissed: missed.sort((a, b) => peak(b) - peak(a)).slice(0, 20).map(slim), topFailed: failed.slice(-10).map(slim), vetoesOnWinners: vetoes, featureGaps: gaps.slice(0, 12),
      note: 'Missed winners = D/F calls that later reached 2x+. Failed A/B = A/B calls older than 4h that never reached 1.2x or rugged. A large gap on a feature the score ignores or penalizes is a reweighting candidate; with small samples it is noise.' };
  }
  // ---- auto-recalibration: L2 logistic regression on score components -> "peak >= 2x and not rugged" ----
  function auc(s, y) { const P = s.map((v, i) => [v, y[i]]).sort((a, b) => a[0] - b[0]); let r = 0, np = 0, nn = 0; P.forEach(([, t], i) => { if (t) { r += i + 1; np++; } else nn++; }); return np && nn ? (r - (np * (np + 1)) / 2) / (np * nn) : null; }
  function fitLogit(X, y, l2 = 2, it = 500, lr = 0.5) { const d = X[0].length; const w = new Array(d + 1).fill(0); for (let k = 0; k < it; k++) { const g = new Array(d + 1).fill(0); for (let i = 0; i < X.length; i++) { const z = w[d] + X[i].reduce((s, x, j) => s + x * w[j], 0); const e = 1 / (1 + Math.exp(-z)) - y[i]; for (let j = 0; j < d; j++) g[j] += e * X[i][j]; g[d] += e; } for (let j = 0; j < d; j++) w[j] -= lr * ((g[j] + l2 * w[j]) / X.length); w[d] -= (lr * g[d]) / X.length; } return w; }
  function persist() { fs.writeFileSync(wfile, JSON.stringify(recal)); }
  function recalibrate() {
    const now = Date.now(); const old = live.getWeights();
    const data = calls.filter((c) => c.comps && now - c.t > 86400e3 && !c.regrade).sort((a, b) => a.t - b.t);
    const y = data.map((c) => (peak(c) >= 2 && !c.rugged ? 1 : 0)); const pos = y.reduce((a, b) => a + b, 0);
    const res = { at: now, samples: data.length, positives: pos, label: 'peak >= 2x and not rugged, calls older than 24h', guardrails: 'min 300 samples and 20 positives; time-ordered 70/30 holdout; L2 penalty; apply only if holdout AUC improves by >= 0.02 with >= 5 holdout positives', old };
    if (data.length < 300 || pos < 20) { res.status = `waiting for data (${data.length}/300 resolved calls, ${pos}/20 positives)`; recal = { ...(recal || {}), active: old, last: res }; persist(); return res; }
    const cut = Math.floor(data.length * 0.7);
    const X = data.map((c) => COMP.map((k) => c.comps[k] ?? 0));
    const w = fitLogit(X.slice(0, cut), y.slice(0, cut));
    const ho = X.slice(cut), hy = y.slice(cut);
    const aOld = auc(ho.map((x) => COMP.reduce((s, k, j) => s + (old[k] || 0) * x[j], 0)), hy);
    const aNew = auc(ho.map((x) => COMP.reduce((s, k, j) => s + w[j] * x[j], 0)), hy);
    const tot = Object.values(old).reduce((a, b) => a + b, 0); const pw = COMP.map((k, j) => Math.max(0, w[j])); const ps = pw.reduce((a, b) => a + b, 0) || 1;
    const proposed = Object.fromEntries(COMP.map((k, j) => [k, Math.round((pw[j] / ps) * tot * 10) / 10]));
    Object.assign(res, { holdout: ho.length, holdoutPositives: hy.reduce((a, b) => a + b, 0), aucOld: aOld, aucNew: aNew, coef: Object.fromEntries(COMP.map((k, j) => [k, +w[j].toFixed(3)])), proposed });
    if (aNew != null && aOld != null && aNew >= aOld + 0.02 && res.holdoutPositives >= 5) { res.status = `applied (holdout AUC ${aOld.toFixed(3)} -> ${aNew.toFixed(3)})`; live.setWeights(proposed); recal = { active: proposed, previous: old, last: res, history: [...(recal?.history || []), res].slice(-20) }; }
    else { res.status = `kept current weights (holdout AUC current ${aOld?.toFixed(3)} vs refit ${aNew?.toFixed(3)})`; recal = { ...(recal || {}), active: old, last: res, history: [...(recal?.history || []), res].slice(-20) }; }
    persist(); return res;
  }
  let lastRecal = 0;
  return {
    async onCycle(feed, items) { logCalls(items); await track(items); save(); if (Date.now() - lastRecal > 6 * 3600e3) { lastRecal = Date.now(); try { recalibrate(); } catch (e) { log('recal: ' + e.message); } } },
    list: ({ grade, limit = 300 } = {}) => calls.filter((c) => !grade || c.grade === grade).slice(-limit).reverse().map(slim),
    forKey: (key) => calls.filter((c) => c.key === key).map(slim),
    // does a feature (e.g. X tone) separate winners? calls older than 24h split by feature > 0, <= 0, missing; hit = peak >= 2x and not rugged
    featureSplit(name) { const g = { positive: [], nonpositive: [], missing: [] }; for (const c of calls) { if (Date.now() - c.t < 24 * 3600e3) continue; const v = c.feat?.[name]; (v == null ? g.missing : v > 0 ? g.positive : g.nonpositive).push(c); }
      return Object.fromEntries(Object.entries(g).map(([k, cs]) => [k, { n: cs.length, hit2x: cs.length ? +(cs.filter((c) => peak(c) >= 2 && !c.rugged).length / cs.length).toFixed(3) : null }])); },
    reportCard, missedWinners, recalibrate, recalState: () => recal, count: () => calls.length,
  };
}
module.exports = { createCalls };
