'use strict';
// Funding-rate divergence detector (formalizes the 'venues disagree' flag). Input: the live perp snapshot (lib/perps.js, refreshed ~2 min).
// Per venue: funding normalized to its own interval and annualized (rate * 24/intervalH * 365 * 100; Binance/OKX/Gate 8h/4h/1h per contract,
// Hyperliquid hourly) and shown as bps per 8h. Cross-venue median over venues with >= $250K OI; outlier = venue furthest from the median.
// Adjustments: a rate exactly on the default interest clamp (0.01%/8h equivalent, i.e. premium inside the clamp band) carries no crowding
// information and is marked 'default'; a rate at the venue cap (Binance /fapi/v1/fundingInfo caps, Hyperliquid 4%/h) is marked 'capped'
// (true divergence may be larger). Divergence z = vs this token's own divergence history (live 30-min samples; falls back to the
// 90-day historical study in data/fundingdiv_history.json).
// Episode: |div| >= trigger = max(25%/yr, mean + 2.5 sd) on 2 consecutive snapshots, ends when < trigger/2 on 2 snapshots. We log start,
// peak, outlier venue, duration, price during the episode and 1h/4h/24h after it resolves, and realized vol during vs the 30d baseline.
// Model estimates from public data, not financial advice.
const fs = require('fs');
const path = require('path');
const { getJSON } = require('./util');
const MIN_OI = 250e3, FLOOR = 25;
const med = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

function createFundingDiv({ DATA_DIR, perps, log = () => {} }) {
  const fLive = path.join(DATA_DIR, 'fundingdiv_live.json');
  let st = { hist: {}, episodes: [], open: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(fLive, 'utf8')) }; } catch {}
  let histStudy = null; const loadStudy = () => { try { histStudy = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'fundingdiv_history.json'), 'utf8')); } catch { histStudy = null; } };
  loadStudy();
  let caps = {}, capsAt = 0;
  async function loadCaps() { try { const d = await getJSON('https://www.binance.com/fapi/v1/fundingInfo', {}, 20000); caps = Object.fromEntries(d.map((x) => [x.symbol, { cap: +x.adjustedFundingRateCap, floor: +x.adjustedFundingRateFloor, ih: +x.fundingIntervalHours }])); capsAt = Date.now(); } catch (e) { log(`[fdiv] fundingInfo ${e.message}`); } }
  const px = {}; // sym -> [[t, mark]] (26h)
  let snap = { generatedAt: null, tokens: [], active: [], episodes: [] };
  let lastGen = 0;
  function step() {
    const s = perps.snapshot(); if (!s.generatedAt || s.generatedAt === lastGen) return; lastGen = s.generatedAt;
    if (Date.now() - capsAt > 6 * 3600e3) loadCaps();
    const now = s.generatedAt; const out = [];
    for (const t of s.tokens || []) {
      const a = px[t.sym] || (px[t.sym] = []); a.push([now, t.mark]); while (a.length && a[0][0] < now - 26 * 3600e3) a.shift();
      const vs = (t.venues || []).filter((v) => v.rate != null && v.intervalH).map((v) => {
        const r8 = v.rate * 8 / v.intervalH; const ann = v.rate * 24 / v.intervalH * 365 * 100;
        const dflt = Math.abs(r8 - 0.0001) < 1e-7;
        const c = v.venue === 'binance' ? caps[v.contract] : null;
        const capped = (c && (v.rate >= c.cap * 0.98 || v.rate <= c.floor * 0.98)) || (v.venue === 'hyperliquid' && Math.abs(v.rate) >= 0.04 * 0.98);
        return { venue: v.venue, contract: v.contract, ann, bps8h: r8 * 1e4, intervalH: v.intervalH, oiUsd: v.oiUsd, dflt, capped: !!capped, eligible: (v.oiUsd || 0) >= MIN_OI };
      });
      const el = vs.filter((v) => v.eligible);
      if (el.length < 2) continue;
      const m = med(el.map((v) => v.ann));
      const cand = el.filter((v) => !v.dflt).length ? el.filter((v) => !v.dflt) : el; // a venue on the default clamp cannot be the crowded outlier
      const o = cand.reduce((b, v) => (Math.abs(v.ann - m) > Math.abs(b.ann - m) ? v : b));
      const div = o.ann - m; const cheap = el.reduce((b, v) => (v.ann < b.ann ? v : b)); const rich = el.reduce((b, v) => (v.ann > b.ann ? v : b));
      // own history (30-min samples, 30 days)
      const H = st.hist[t.sym] || (st.hist[t.sym] = []);
      if (!H.length || now - H[H.length - 1][0] >= 30 * 60e3) { H.push([now, +Math.abs(div).toFixed(2)]); while (H.length > 1440) H.shift(); }
      let mean = null, sd = null, src = null;
      if (H.length >= 48) { const xs = H.map((x) => x[1]); mean = xs.reduce((p, q) => p + q, 0) / xs.length; sd = Math.sqrt(xs.reduce((p, q) => p + (q - mean) ** 2, 0) / xs.length); src = `own live history (${H.length} samples)`; }
      else if (histStudy?.tokens?.[t.sym]) { const h = histStudy.tokens[t.sym]; mean = h.meanAbsDiv; sd = h.sdAbsDiv; src = `90-day 8h buckets (${h.buckets})`; }
      const z = sd ? (Math.abs(div) - mean) / sd : null;
      const trig = Math.max(FLOOR, mean != null && sd != null ? mean + 2.5 * sd : FLOOR);
      const big = Math.abs(div) >= trig && !o.dflt;
      // episodes
      let ep = st.open[t.sym];
      if (!ep && big) { const p = st.pending?.[t.sym]; st.pending = st.pending || {}; if (p) { ep = st.open[t.sym] = { sym: t.sym, start: p.t, peakDiv: div, outlier: o.venue, cheap: cheap.venue, rich: rich.venue, median: m, trigger: trig, pxStart: p.px, pxPeak: t.mark, calm: 0, rvBase: t.stats?.rv30 ?? null }; delete st.pending[t.sym]; } else st.pending[t.sym] = { t: now, px: t.mark }; }
      else if (!big && st.pending?.[t.sym]) delete st.pending[t.sym];
      if (ep) {
        if (Math.abs(div) > Math.abs(ep.peakDiv)) { ep.peakDiv = div; ep.outlier = o.venue; ep.pxPeak = t.mark; ep.peakAt = now; }
        ep.calm = Math.abs(div) < ep.trigger / 2 ? ep.calm + 1 : 0;
        if (ep.calm >= 2) {
          const seg = a.filter((x) => x[0] >= ep.start); const rets = seg.slice(1).map((x, i) => Math.abs(x[1] / seg[i][1] - 1));
          const minsPer = seg.length > 1 ? (seg[seg.length - 1][0] - seg[0][0]) / 60e3 / (seg.length - 1) : 2;
          const hourlyMeanAbs = rets.length ? rets.reduce((p, q) => p + q, 0) / rets.length * Math.sqrt(60 / minsPer) * 100 : null;
          const baseHourly = ep.rvBase != null ? ep.rvBase / Math.sqrt(8760) * 0.8 : null; // mean |hourly return| ≈ 0.8 sd
          st.episodes.push({ ...ep, end: now, durMin: Math.round((now - ep.start) / 60e3), pxEnd: t.mark, duringPct: (t.mark / ep.pxStart - 1) * 100, rvRatio: hourlyMeanAbs != null && baseHourly ? +(hourlyMeanAbs / baseHourly).toFixed(2) : null, after: {} });
          if (st.episodes.length > 500) st.episodes.shift();
          delete st.open[t.sym];
        }
      }
      out.push({ sym: t.sym, mark: t.mark, median: m, div, divBps8h: div / 365 / 3 * 100, outlier: o.venue, outlierDefault: o.dflt, outlierCapped: o.capped, cheap: cheap.venue, rich: rich.venue, z, zSrc: src, trigger: trig, active: !!st.open[t.sym], venues: vs });
    }
    // fill post-resolution returns (1h / 4h / 24h after the episode ended)
    for (const e of st.episodes) for (const [k, h] of [['h1', 1], ['h4', 4], ['h24', 24]]) {
      if (e.after[k] != null || now < e.end + h * 3600e3) continue;
      const a = px[e.sym]; if (!a) continue; const x = a.find((p) => p[0] >= e.end + h * 3600e3); if (x && x[0] - (e.end + h * 3600e3) < 15 * 60e3) e.after[k] = +((x[1] / e.pxEnd - 1) * 100).toFixed(2);
      // relative to the cheap side: if the outlier venue paid MORE (crowded longs there) the hypothesis is price down
      if (e.after.h24 != null && e.hit == null) e.hit = e.peakDiv > 0 ? e.after.h24 < 0 : e.after.h24 > 0;
    }
    out.sort((x, y) => Math.abs(y.div) - Math.abs(x.div));
    const active = Object.values(st.open).map((e) => ({ ...e, durMin: Math.round((now - e.start) / 60e3), cur: out.find((t) => t.sym === e.sym) || null }));
    const text = (e) => `${e.sym}: ${e.outlier} funding sits ${Math.abs(e.peakDiv).toFixed(0)}%/yr ${e.peakDiv > 0 ? 'ABOVE' : 'BELOW'} the other venues' median (${e.median.toFixed(0)}%/yr). ${e.peakDiv > 0 ? `Longs on ${e.outlier} are paying much more than elsewhere: that venue's traders are crowded long, and arbitrageurs short there / buy on ${e.cheap} until it converges.` : `Shorts on ${e.outlier} are paying (or longs being paid) far more than elsewhere: shorts crowded there; arbitrageurs go long there / short on ${e.rich}.`} The cheaper place to hold a long is ${e.cheap}.`;
    for (const e of active) e.text = text(e);
    const recent = st.episodes.slice(-60).reverse().map((e) => ({ ...e, text: text(e) }));
    const done = st.episodes.filter((e) => e.hit != null);
    snap = { generatedAt: now, tokens: out.slice(0, 150), active, episodes: recent,
      evaluation: { closed: st.episodes.length, with24h: done.length, hits: done.filter((e) => e.hit).length },
      rules: `funding annualized per venue interval; median over venues with ≥ $${MIN_OI / 1e3}K OI; episode when |outlier − median| ≥ max(${FLOOR}%/yr, mean + 2.5 sd of the token's own divergence) on 2 snapshots, ends below half that on 2 snapshots; 'default' = rate on the 0.01%/8h interest clamp (ignored as outlier), 'capped' = at the venue funding cap`,
      history: histStudy ? { generatedAt: histStudy.generatedAt, days: histStudy.days, results: histStudy.results, recentEpisodes: (histStudy.episodes || []).slice(0, 30) } : null };
    try { fs.writeFileSync(path.join(DATA_DIR, 'fundingdiv.json'), JSON.stringify({ ...snap, history: undefined })); fs.writeFileSync(fLive, JSON.stringify({ hist: st.hist, episodes: st.episodes, open: st.open, pending: st.pending || {} })); } catch {}
  }
  function forSym(sym) { return snap.tokens.find((t) => t.sym === sym) || null; }
  // composite factor (weight 0.5): an active divergence episode = one venue crowded; positive outlier (longs crowded somewhere) mildly negative.
  function factor(sym) {
    const t = forSym(sym); if (!t) return null;
    const e = snap.active.find((x) => x.sym === sym);
    if (e) return { score: e.peakDiv > 0 ? 42 : 50, value: `${e.outlier} ${e.peakDiv > 0 ? '+' : ''}${e.peakDiv.toFixed(0)}%/yr vs median`, text: e.text + ` Episode running for ${e.durMin} min.`, warn: e.peakDiv > 0 && Math.abs(e.peakDiv) >= 100 ? `Funding divergence: ${e.outlier} longs paying ${e.peakDiv.toFixed(0)}%/yr more than other venues` : null };
    return { score: t.z != null && t.z >= 2 ? 48 : 52, value: `${t.div >= 0 ? '+' : ''}${t.div.toFixed(0)}%/yr (${t.outlier})`, text: `Funding for ${sym} is roughly consistent across venues: largest gap ${t.outlier} ${t.div >= 0 ? '+' : ''}${t.div.toFixed(1)}%/yr vs the median ${t.median.toFixed(1)}%/yr${t.z != null ? ` (z ${t.z.toFixed(1)} vs its own history)` : ''}. No divergence episode.` };
  }
  let started = false;
  function start() { if (started) return; started = true; loadCaps(); setInterval(() => { try { step(); } catch (e) { log(`[fdiv] ${e.message}`); } }, 30e3).unref(); setInterval(loadStudy, 30 * 60e3).unref(); }
  return { start, step, snapshot: () => snap, forSym, factor };
}
module.exports = { createFundingDiv };
