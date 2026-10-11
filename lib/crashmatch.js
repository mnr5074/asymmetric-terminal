// Inverse (pre-crash) lookalike detector: compares a token's last ~90 daily closes/volumes to fingerprints of
// historical parabolic-run-then-crash cases built by research/crash_lab.py (data/crash_fingerprints.json).
// Same 7 features and similarity as the Python side. Model estimate, not financial advice.
'use strict';
const fs = require('fs'); const path = require('path');
let FP = null, FPt = 0;
function load(dataDir) {
  const f = path.join(dataDir, 'crash_fingerprints.json');
  try { const st = fs.statSync(f); if (!FP || st.mtimeMs !== FPt) { FP = JSON.parse(fs.readFileSync(f, 'utf8')); FPt = st.mtimeMs; } } catch { FP = null; }
  return FP;
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const pstd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
function feats(px, vol, i) {
  if (i < 90 || !(px[i] > 0)) return null;
  const P = px.slice(i - 90, i + 1); const lr = [];
  for (let k = P.length - 60; k < P.length; k++) if (P[k] > 0 && P[k - 1] > 0) lr.push(Math.log(P[k] / P[k - 1]));
  if (lr.length < 20) return null;
  const v7 = mean(vol.slice(i - 6, i + 1)); const v30 = mean(vol.slice(i - 37, i - 6)) || 1e-9; const l30 = lr.slice(-30);
  return { run90: Math.log(px[i] / Math.max(Math.min(...P), 1e-12)), run30: Math.log(px[i] / Math.max(Math.min(...px.slice(i - 30, i + 1)), 1e-12)),
    dd_hi30: px[i] / Math.max(...px.slice(i - 30, i + 1)) - 1, vol30: pstd(l30), vol_trend: Math.log(Math.max(v7, 1e-9) / v30),
    up30: l30.filter((x) => x > 0).length / 30, ath_gap: px[i] / Math.max(...px.slice(0, i + 1)) - 1 };
}
const LABEL = { run90: '90-day run (log x)', run30: '30-day run (log x)', dd_hi30: 'off 30-day high', vol30: 'daily volatility', vol_trend: 'volume 7d vs prior 30d (log)', up30: 'share of up days (30d)', ath_gap: 'off all-time high' };
/** closes/vols oldest->newest daily. Returns best matches or null when < 91 days of history. */
function match(dataDir, closes, vols, { exclude } = {}) {
  const fp = load(dataDir); if (!fp || !fp.fingerprints?.length) return { ok: false, why: 'no crash fingerprints built yet' };
  const i = closes.length - 1; const f = feats(closes, vols, i);
  if (!f) return { ok: false, why: `needs 91+ days of daily history (have ${closes.length})` };
  const K = fp.features; const sim = (a, b) => Math.exp(-Math.sqrt(K.reduce((s, k) => s + ((a[k] - b[k]) / (fp.sd[k] || 1)) ** 2, 0) / K.length)) * 100;
  const ranked = fp.fingerprints.filter((x) => !exclude || !x.name.toLowerCase().startsWith(String(exclude).toLowerCase() + ' '))
    .map((x) => ({ name: x.name, launchpad: x.launchpad, collapse_date: x.collapse_date, similarity: Math.round(sim(f, x.fp)), compare: K.map((k) => ({ k, label: LABEL[k], now: +f[k].toFixed(3), them: +x.fp[k].toFixed(3), close: Math.abs(f[k] - x.fp[k]) / (fp.sd[k] || 1) < 0.5 })) }))
    .sort((a, b) => b.similarity - a.similarity);
  const top = ranked[0]; const bt = fp.backtest || {};
  // kNN crash odds: share of the 25 most similar labelled historical days that were followed by a -70% crash within 90 days
  let odds = null;
  if (fp.knn?.length) { const q = K.map((k) => f[k] / (fp.sd[k] || 1)); const ex = exclude ? String(exclude).toLowerCase() + ' ' : null;
    const d = fp.knn.filter((s) => !ex || !s.n.toLowerCase().startsWith(ex)).map((s) => [s.v.reduce((a, v, j) => a + (v - q[j]) ** 2, 0), s.h]).sort((a, b) => a[0] - b[0]).slice(0, 25);
    odds = d.length ? d.reduce((a, x) => a + x[1], 0) / d.length : null; }
  const kb = bt.knn || {}; const bandKey = odds == null ? null : odds >= 0.5 ? 'ge50' : odds >= 0.4 ? 'ge40' : odds >= 0.3 ? 'ge30' : odds >= 0.2 ? 'ge20' : null;
  const band = bandKey ? kb[bandKey] : null;
  return { ok: true, top, alternatives: ranked.slice(1, 4).map(({ name, similarity }) => ({ name, similarity })), features: f, crashOdds: odds,
    text: `Looks ${top.similarity}% like ${top.name.replace(/ \(.*\)$/, '')} before its collapse (${top.collapse_date})`,
    evidence: band ? { band: bandKey, n: band.n, tokens: band.tokens, hit_rate: band.hit_rate, lift: band.lift, base_rate: bt.base_rate_crash70_within90d } : { base_rate: bt.base_rate_crash70_within90d },
    label: 'Model estimate from daily price/volume shape only, not financial advice.' };
}
// rug-score bump only when this odds band beat the base rate in the leave-one-out backtest (lift >= 1.5 on >= 100 samples)
function riskBump(m) {
  const e = m?.ok && m.evidence; if (!e || e.lift == null || (e.n || 0) < 100 || e.lift < 1.5) return 0;
  return e.lift >= 2.5 ? 12 : 6;
}
module.exports = { match, riskBump, feats };
