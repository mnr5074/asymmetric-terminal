// Breakouts: flat-base scanner (lib/flatbase.js). Finds coins that crashed far from their highs, then went extremely flat
// (tight range, low volatility, volume drying up, long duration) and scores the chance of a large breakout.
// score(series, i, ctx) only reads series[0..i] (no look-ahead) so the same code drives the live scan and the backtest
// (research/flatbase_backtest.js). Series rows: [dayIndex (UTC days since epoch), close, volume24hUsd].
// Weights: drawdown 20, range tightness 25, base duration 15, volume dry-up→uptick 15, on-chain 15, trigger 10.
// When on-chain data is unavailable (always in the backtest), the score is rescaled from the remaining 85 points.
'use strict';
const fs = require('fs');
const path = require('path');

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lin = (x, x0, x1) => clamp((x - x0) / (x1 - x0)); // 0 at x0, 1 at x1 (works for x1 < x0 too)
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pctRank = (arr, x) => (arr.length ? arr.filter((v) => v <= x).length / arr.length : 0.5);

function window(s, i, n) { return s.slice(Math.max(0, i - n + 1), i + 1); }
function rangeOf(rows) { const c = rows.map((r) => r[1]); const hi = Math.max(...c), lo = Math.min(...c); return { hi, lo, rng: (hi - lo) / ((hi + lo) / 2) }; }
function vol30(s, i) { const w = window(s, i, 31).map((r) => r[1]); const r = []; for (let k = 1; k < w.length; k++) if (w[k - 1] > 0 && w[k] > 0) r.push(Math.log(w[k] / w[k - 1])); return sd(r); }
function bbw(s, i) { const c = window(s, i, 20).map((r) => r[1]); const m = mean(c); return m ? (4 * sd(c)) / m : 0; }

// ctx: { athKnown (number|null: ATH only if its date <= day i), onchain: {pts 0..1, why}|null, oiFlat: bool|null }
function score(s, i, ctx = {}) {
  if (i < 119) return null; // >= 120 days of history
  const close = s[i][1]; if (!(close > 0)) return null;
  const hist = window(s, i, 365);
  const hi1y = Math.max(...hist.map((r) => r[1]));
  const ath = Math.max(hi1y, ctx.athKnown || 0);
  const ddAth = 1 - close / ath;
  const hi180 = Math.max(...window(s, i, 180).map((r) => r[1]));
  const ddLocal = 1 - close / hi180; // re-base case (e.g. TROLL: 1c -> 12c -> 3c)
  const ddScore = (dd) => (dd > 0.98 ? 0 : dd >= 0.97 ? lin(dd, 0.98, 0.97) : dd >= 0.7 ? 1 : lin(dd, 0.5, 0.7));
  const sDD = Math.max(ddScore(ddAth), 0.85 * ddScore(ddLocal));

  // range tightness / volatility compression
  const r4 = rangeOf(window(s, i, 28)), r8 = rangeOf(window(s, i, 56)), r12 = rangeOf(window(s, i, 84));
  const tight = (r) => lin(r, 0.6, 0.25);
  const sRange = 0.25 * tight(r4.rng) + 0.45 * tight(r8.rng) + 0.3 * tight(r12.rng);
  const v = vol30(s, i); const vHist = []; for (let k = Math.max(30, i - 364); k <= i; k += 7) vHist.push(vol30(s, k));
  const b = bbw(s, i); const bHist = []; for (let k = Math.max(20, i - 364); k <= i; k += 7) bHist.push(bbw(s, k));
  const sVol = 1 - pctRank(vHist, v), sBB = 1 - pctRank(bHist, b);
  const sTight = 0.6 * sRange + 0.25 * sVol + 0.15 * sBB;

  // base duration: longest look-back L whose range stays <= 35%
  let L = 0; { let hi = -Infinity, lo = Infinity; for (let k = i; k >= Math.max(0, i - 364); k--) { hi = Math.max(hi, s[k][1]); lo = Math.min(lo, s[k][1]); if ((hi - lo) / ((hi + lo) / 2) > 0.35) break; L = i - k + 1; } }
  const sDur = L < 28 ? 0 : L <= 56 ? lin(L, 28, 56) : L <= 210 ? 1 : 1 - 0.3 * lin(L, 210, 365);

  // volume dry-up then uptick (uptick only counts while price is still inside the base)
  const av = (n) => mean(window(s, i, n).map((r) => r[2] || 0));
  const a5 = av(5), a20 = av(20), a120 = av(120);
  const dry = a120 ? av(20) / a120 : 1; const up = a20 ? a5 / a20 : 1;
  const inBase = close <= r8.hi * 1.05;
  const sVolu = 0.5 * lin(dry, 1.2, 0.6) + 0.5 * (inBase ? lin(up, 1.0, 1.5) : 0);

  // trigger: close near the top of the 8-week range (+ OI rising with flat price when a perp exists, live only)
  const pos = r8.hi > r8.lo ? (close - r8.lo) / (r8.hi - r8.lo) : 0.5;
  const sTrig = ctx.oiFlat == null ? lin(pos, 0.5, 0.8) : 0.7 * lin(pos, 0.5, 0.8) + 0.3 * (ctx.oiFlat ? 1 : 0);

  const parts = { drawdown: 20 * sDD, tightness: 25 * sTight, duration: 15 * sDur, volume: 15 * sVolu, trigger: 10 * sTrig };
  let pts = Object.values(parts).reduce((a, x) => a + x, 0);
  if (ctx.onchain) { parts.onchain = 15 * clamp(ctx.onchain.pts); pts += parts.onchain; } else pts = (pts * 100) / 85;
  const sc = Math.round(clamp(pts / 100) * 100);

  // labels
  const prior = window(s, i - 3, 57); const priorHi = prior.length ? Math.max(...prior.map((r) => r[1])) : Infinity;
  const based = L >= 28 || r8.rng <= 0.35;
  let label = null;
  if (based && close > priorHi * 1.03 && up >= 1.5) label = 'Breaking out';
  else if (L >= 28 && r8.rng <= 0.35 && (up >= 1.5 || pos >= 0.85)) label = 'Waking';
  else if (L >= 28 && r8.rng <= 0.35) label = 'Coiled';
  return { score: sc, label, parts: Object.fromEntries(Object.entries(parts).map(([k, x]) => [k, Math.round(x * 10) / 10])),
    m: { close, ath, ddAth: +ddAth.toFixed(3), ddLocal: +ddLocal.toFixed(3), range4w: +r4.rng.toFixed(3), range8w: +r8.rng.toFixed(3), range12w: +r12.rng.toFixed(3), vol30: +v.toFixed(4), volPct1y: +(1 - sVol).toFixed(2), baseDays: L, volDry20v120: +dry.toFixed(2), volUp5v20: +up.toFixed(2), rangePos: +pos.toFixed(2), baseHi: r8.hi, baseLo: r8.lo } };
}

const fmtPct = (x) => Math.round(x * 100) + '%';
function reasons(r, sym) {
  const m = r.m, out = [];
  out.push(`${fmtPct(m.ddAth)} below its high${m.ddLocal < m.ddAth - 0.1 ? ` (${fmtPct(m.ddLocal)} below its 6-month high)` : ''}`);
  out.push(`${m.baseDays} days in a tight base; 8-week range only ${fmtPct(m.range8w)}`);
  if (m.volUp5v20 >= 1.5) out.push(`volume waking up: last 5 days ${m.volUp5v20}x the 20-day average`);
  else if (m.volDry20v120 <= 0.7) out.push(`volume dried up to ${fmtPct(m.volDry20v120)} of its 4-month average`);
  if (m.rangePos >= 0.8) out.push('price pressing the top of the range');
  return out.slice(0, 3);
}

// ---- live scan over data/flatbase_series (+ hard filters, on-chain from accumulation.json, OI from perps_history.json) ----
function createFlatbase({ DATA_DIR, log = () => {} }) {
  const F = (f) => path.join(DATA_DIR, f);
  const readJ = (f) => { try { return JSON.parse(fs.readFileSync(F(f), 'utf8')); } catch { return null; } };
  function compute() {
    const now = Date.now(); const today = Math.floor(now / 864e5);
    const uni = new Map(((readJ('flatbase_universe.json') || {}).coins || []).map((c) => [c.id, c]));
    const bt = readJ('flatbase_backtest.json');
    const strength = bt?.verdict?.tier || 'unproven';
    // on-chain + safety context
    const acc = readJ('accumulation.json'); const accBySym = new Map();
    for (const x of [...(acc?.heavy || []), ...(acc?.accumulating || []), ...(acc?.single || [])]) if (x.symbol) accBySym.set(String(x.symbol).toUpperCase(), x);
    const ph = readJ('perps_history.json') || {};
    const oiFlat = (sym) => { const h = ph[sym]; if (!Array.isArray(h) || h.length < 4) return null; const a = h[0], z = h[h.length - 1]; if (!a[2] || !a[3]) return null; return z[2] / a[2] >= 1.05 && Math.abs(z[3] / a[3] - 1) <= 0.03; };
    const dangers = new Set(); // contract-scan danger / rug flags by symbol (proven vetoes)
    try { const cs = readJ('contractscan.json'); for (const t of cs?.tokens || cs?.items || []) if (t.verdict === 'danger' || t.danger || t.honeypot) dangers.add(String(t.symbol || '').toUpperCase()); } catch {}
    let dir = []; try { dir = fs.readdirSync(F('flatbase_series')); } catch {}
    const rows = []; const excluded = { history: 0, stale: 0, liquidity: 0, safety: 0, dead: 0 };
    for (const f of dir) {
      let d; try { d = JSON.parse(fs.readFileSync(path.join(F('flatbase_series'), f), 'utf8')); } catch { continue; }
      const s = (d.s || []).filter((r) => r[1] > 0); if (s.length < 120) { excluded.history++; continue; }
      const lastDay = s[s.length - 1][0]; if (today - lastDay > 3) { excluded.stale++; continue; }
      const sym = String(d.symbol || '').toUpperCase(); const u = uni.get(d.id) || {};
      const vol20 = mean(window(s, s.length - 1, 20).map((r) => r[2] || 0));
      if (vol20 < 250e3) { excluded.liquidity++; continue; } // liquidity floor: 20-day avg USD volume (proxy for depth on CEX-listed coins)
      if (dangers.has(sym)) { excluded.safety++; continue; }
      const a = accBySym.get(sym);
      const on = a ? { pts: Math.min(1, a.score / 60), why: a.reasons?.[0] } : null;
      const r = score(s, s.length - 1, { athKnown: Math.max(d.ath || 0, ...s.map((x) => x[1])), onchain: on, oiFlat: oiFlat(sym) });
      if (!r) continue; if (r.m.ddAth > 0.98) { excluded.dead++; continue; }
      if (!r.label && r.score < 55) continue;
      rows.push({ id: d.id, symbol: sym, name: u.name || d.symbol, rank: u.rank || null, src: d.src, score: r.score, label: r.label || 'Watching', parts: r.parts, m: r.m,
        reasons: [...reasons(r, sym), ...(on?.why ? ['on-chain: ' + on.why] : [])].slice(0, 3), onchain: !!on,
        dataAsOf: lastDay * 864e5, fetchedAt: d.at, strength: (r.label && bt?.labelTiers?.[r.label]?.tier) || strength, link: d.src === 'binance' ? `https://www.binance.com/en/trade/${d.pair}` : null });
    }
    const order = { 'Breaking out': 0, Waking: 1, Coiled: 2, Watching: 3 };
    rows.sort((a, b) => (order[a.label] - order[b.label]) || (b.score - a.score));
    return { generatedAt: now, strength, strengthWhy: bt?.verdict?.why || 'not backtested yet', backtest: bt ? { generatedAt: bt.generatedAt, sample: bt.sample, baselineRate: bt.baselineRate, verdict: bt.verdict, labelTiers: bt.labelTiers, tiers: bt.tiers, sanity: bt.sanity, caveats: bt.caveats } : null,
      universe: dir.length, excluded, counts: { breaking: rows.filter((r) => r.label === 'Breaking out').length, waking: rows.filter((r) => r.label === 'Waking').length, coiled: rows.filter((r) => r.label === 'Coiled').length },
      rules: { hardFilters: '>= 120 days history, data <= 3 days old (drops delisted pairs), 20-day avg volume >= $250K (liquidity floor), no contract-scan danger / honeypot flag, not > 98% below ATH (dead)', weights: 'drawdown 20 · tightness 25 · duration 15 · volume 15 · on-chain 15 (rescaled when n/a) · trigger 10' },
      items: rows.slice(0, 150) };
  }
  function refresh() { try { const o = compute(); fs.writeFileSync(F('flatbase.json.tmp'), JSON.stringify(o)); fs.renameSync(F('flatbase.json.tmp'), F('flatbase.json')); log(`flatbase: ${o.items.length} bases (${o.counts.breaking} breaking, ${o.counts.waking} waking, ${o.counts.coiled} coiled)`); return o; } catch (e) { log('flatbase failed: ' + e.message); return null; } }
  let timer = null;
  return { compute, refresh,
    start() { if (timer) return; setTimeout(refresh, 45e3).unref(); timer = setInterval(refresh, 60 * 60e3); timer.unref(); },
    api() { const d = readJ('flatbase.json'); if (!d) throw Object.assign(new Error('flatbase.json not generated yet'), { status: 404 }); d.ageSec = Math.round((Date.now() - d.generatedAt) / 1000); return d; } };
}
module.exports = { score, reasons, createFlatbase };
