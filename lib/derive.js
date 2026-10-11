// Derive Desk — read-only monitor + defined-risk strategy scanner for every option listed on Derive (derive.xyz).
// Data: Derive v3 public JSON-RPC over HTTP POST (https://api.derive.xyz/v3/public/*, keyless, docs.derive.xyz):
//   get_all_instruments (option definitions, fees, sizes), get_tickers (per currency+expiry: bid/ask/size, mark, IV,
//   greeks, 24h stats incl. per-instrument OI), get_tickers perp, get_margin (simulated SM / PM2 margin for a structure).
// Slow inputs (realized vol, Deribit DVOL, DRV price, reward programs with citations) come from research/derive_desk.py
// -> data/derive_ref.json (refreshed by this module every 30 min). History for IV rank -> data/derive_history.json.
// Everything is a model estimate from public data. Not financial advice. Nothing here signs or trades.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const API = 'https://api.derive.xyz/v3/public/';
const YEAR = 365 * 86400e3;
const POLL_MS = +process.env.DERIVE_POLL_MS || 180e3; // ~3 min
const REF_MAX_AGE = 30 * 60e3;

// ---------- math ----------
function ncdf(x) { // Abramowitz-Stegun 26.2.17 (|err| < 7.5e-8)
  const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
// undiscounted Black-76 price of a call/put on forward F
function b76(F, K, sig, T, cp) {
  if (T <= 0 || sig <= 0) return Math.max(cp === 'C' ? F - K : K - F, 0);
  const s = sig * Math.sqrt(T), d1 = (Math.log(F / K) + s * s / 2) / s, d2 = d1 - s;
  return cp === 'C' ? F * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - F * ncdf(-d1);
}
const probAbove = (F, x, sig, T) => (x <= 0 ? 1 : ncdf((Math.log(F / x) - sig * sig * T / 2) / (sig * Math.sqrt(T))));
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const sg = (x, n = 5) => (x == null || !isFinite(x) ? null : +(+x).toPrecision(n)); // significant digits (sub-$1 underlyings)
const median = (a) => { const s = a.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const fmtK = (K) => (K >= 100 ? String(Math.round(K)) : String(+K.toPrecision(4)));

async function rpc(method, params, timeout = 20000) {
  const r = await fetch(API + method, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'asymmetric-terminal (read-only)' }, body: JSON.stringify(params || {}), signal: AbortSignal.timeout(timeout) });
  const d = await r.json();
  if (d.error) throw new Error(`${method}: ${d.error.message}${d.error.data ? ' (' + d.error.data + ')' : ''}`);
  return d.result;
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: String(e.message || e) }; } } })); return out; }

// interpolate y at x on sorted points [[x,y]] (linear, no extrapolation beyond 1 step)
function interp(pts, x) {
  const p = pts.filter((q) => q[1] != null && isFinite(q[1])).sort((a, b) => a[0] - b[0]);
  if (!p.length) return null;
  if (x <= p[0][0]) return p.length > 1 && (p[0][0] - x) > Math.abs(p[1][0] - p[0][0]) * 1.5 ? null : p[0][1];
  if (x >= p[p.length - 1][0]) { const n = p.length; return n > 1 && (x - p[n - 1][0]) > Math.abs(p[n - 1][0] - p[n - 2][0]) * 1.5 ? null : p[n - 1][1]; }
  for (let i = 1; i < p.length; i++) if (x <= p[i][0]) { const [x0, y0] = p[i - 1], [x1, y1] = p[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  return null;
}

function createDerive({ DATA_DIR, log = () => {}, composite = null, perps = null, root = path.join(__dirname, '..') }) {
  const F_SNAP = path.join(DATA_DIR, 'derive_snapshot.json');
  const F_HIST = path.join(DATA_DIR, 'derive_history.json');
  const F_REF = path.join(DATA_DIR, 'derive_ref.json');
  let INS = { t: 0, list: [] };
  let SNAP = null; try { SNAP = JSON.parse(fs.readFileSync(F_SNAP, 'utf8')); } catch {}
  let HIST = { v: 1, assets: {} }; try { HIST = JSON.parse(fs.readFileSync(F_HIST, 'utf8')); } catch {}
  let REF = null, refT = 0, refRunning = false, polling = false, lastErr = null, timer = null;
  const marginCache = new Map();

  function readRef() {
    try { const st = fs.statSync(F_REF); if (st.mtimeMs !== refT) { REF = JSON.parse(fs.readFileSync(F_REF, 'utf8')); refT = st.mtimeMs; } } catch {}
    const stale = !refT || Date.now() - refT > REF_MAX_AGE;
    if (stale && !refRunning && process.env.NO_AUTO_REFRESH !== '1') {
      refRunning = true;
      const ch = spawn('python3', ['derive_desk.py'], { cwd: path.join(root, 'research'), env: { ...process.env, DATA_DIR }, stdio: 'ignore' });
      ch.on('exit', () => { refRunning = false; }); ch.on('error', () => { refRunning = false; });
    }
    return REF;
  }

  async function instruments() {
    if (Date.now() - INS.t < 3600e3 && INS.list.length) return INS.list;
    const all = []; let page = 1;
    for (;;) {
      const d = await rpc('get_all_instruments', { instrument_type: 'option', expired: false, page_size: 1000, page });
      all.push(...d.instruments);
      if (page >= d.pagination.num_pages) break; page++;
    }
    const now = Date.now() / 1000;
    INS = { t: Date.now(), list: all.filter((x) => x.is_active && x.scheduled_activation <= now && x.option_details.expiry > now) };
    return INS.list;
  }

  // ---------- one poll: all tickers -> snapshot + analytics ----------
  async function poll() {
    if (polling) return; polling = true; const t0 = Date.now();
    try {
      const ins = await instruments();
      const meta = new Map(ins.map((x) => [x.instrument_name, x]));
      const groups = new Map();
      for (const x of ins) { const k = x.base_currency + '|' + ymd(x.option_details.expiry * 1000); groups.set(k, (groups.get(k) || 0) + 1); }
      const jobs = [...groups.keys()].map((k) => k.split('|'));
      const res = await pool(jobs, 6, ([cur, exp]) => rpc('get_tickers', { instrument_type: 'option', currency: cur, expiry_date: +exp }));
      let perpT = {}; try { perpT = (await rpc('get_tickers', { instrument_type: 'perp' })).tickers || {}; } catch {}
      const rows = []; let failed = 0;
      res.forEach((r) => {
        if (!r || r.error) { failed++; return; }
        for (const [name, t] of Object.entries(r.tickers || {})) {
          const m = meta.get(name); if (!m) continue;
          const od = m.option_details, op = t.option_pricing || {}, st = t.stats || {};
          rows.push({
            name, cur: m.base_currency, exp: od.expiry * 1000, K: +od.strike, cp: od.option_type,
            bid: +t.b || 0, ask: +t.a || 0, bidAmt: +t.B || 0, askAmt: +t.A || 0, mark: +t.M || 0, index: +t.I || 0,
            iv: +op.i || null, bidIv: +op.bi || null, askIv: +op.ai || null, delta: op.d != null ? +op.d : null, gamma: op.g != null ? +op.g : null, theta: op.t != null ? +op.t : null, vega: op.v != null ? +op.v : null,
            fwd: +op.f || null, df: +op.df || 1,
            oi: +st.oi || 0, vol24c: +st.c || 0, vol24usd: +st.v || 0, prem24: +st.pr || 0, trades24: +st.n || 0,
            minAmt: +m.minimum_amount, step: +m.amount_step, taker: +m.taker_fee_rate, maker: +m.maker_fee_rate, baseFee: +m.base_fee, cap: +m.mark_price_fee_rate_cap, t: t.t,
          });
        }
      });
      const perpsOut = {};
      for (const [n, t] of Object.entries(perpT)) { const cur = n.replace('-PERP', ''); perpsOut[cur] = { mark: +t.M, index: +t.I, bid: +t.b, ask: +t.a, fundingHr: t.f != null ? +t.f : null, vol24usd: +t.stats?.v || 0, oi: +t.stats?.oi || 0, trades24: +t.stats?.n || 0 }; }
      const snap = analyze(rows, perpsOut);
      snap.meta = { generatedAt: Date.now(), elapsedMs: Date.now() - t0, instruments: ins.length, tickers: rows.length, requests: jobs.length + 1, failed, source: 'api.derive.xyz/v3 public/get_all_instruments + get_tickers (option per currency/expiry, perp)', pollMs: POLL_MS };
      recordHistory(snap);
      snap.ivStats = ivStats(snap);
      snap.strategies = scanAll(snap, rows);
      snap.farming = farming(snap, rows, perpsOut);
      SNAP = snap; SNAP.rows = rows;
      await marginTop(snap).catch(() => {});
      const tmp = F_SNAP + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(SNAP)); fs.renameSync(tmp, F_SNAP);
      lastErr = null;
      log(`derive: ${rows.length} tickers / ${jobs.length} chains in ${Date.now() - t0}ms, ${snap.strategies.count} strategies`);
    } catch (e) { lastErr = String(e.message || e); log('derive poll failed: ' + lastErr); }
    finally { polling = false; }
  }

  // ---------- analytics ----------
  function analyze(rows, perpsOut) {
    const now = Date.now();
    const byCur = new Map();
    for (const r of rows) { if (!byCur.has(r.cur)) byCur.set(r.cur, []); byCur.get(r.cur).push(r); }
    const assets = [];
    for (const [cur, rs] of byCur) {
      const spot = median(rs.map((r) => r.index));
      const exps = [...new Set(rs.map((r) => r.exp))].sort((a, b) => a - b);
      const expiries = exps.map((e) => {
        const xs = rs.filter((r) => r.exp === e), T = (e - now) / YEAR;
        const F = median(xs.map((r) => r.fwd)) || spot;
        const calls = xs.filter((r) => r.cp === 'C'), puts = xs.filter((r) => r.cp === 'P');
        // ATM IV: strike-interpolated mark IV in log-moneyness, call & put averaged per strike
        const byK = new Map(); for (const r of xs) if (r.iv) { const a = byK.get(r.K) || []; a.push(r.iv); byK.set(r.K, a); }
        const atm = interp([...byK].map(([K, a]) => [Math.log(K / F), a.reduce((s, x) => s + x, 0) / a.length]), 0);
        const iv25c = interp(calls.filter((r) => r.delta != null && r.iv).map((r) => [r.delta, r.iv]), 0.25);
        const iv25p = interp(puts.filter((r) => r.delta != null && r.iv).map((r) => [r.delta, r.iv]), -0.25);
        const sum = (a, f) => a.reduce((s, r) => s + f(r), 0);
        const oiC = sum(calls, (r) => r.oi), oiP = sum(puts, (r) => r.oi);
        // max pain: settlement price minimizing total intrinsic paid to option holders (OI-weighted)
        let maxPain = null, best = Infinity;
        for (const K of new Set(xs.map((r) => r.K))) { const pay = sum(xs, (r) => r.oi * Math.max(r.cp === 'C' ? K - r.K : r.K - K, 0)); if (pay < best && (oiC + oiP) > 0) { best = pay; maxPain = K; } }
        const top = xs.filter((r) => r.oi > 0).sort((a, b) => b.oi - a.oi).slice(0, 3).map((r) => ({ name: r.name, K: r.K, cp: r.cp, oi: r4(r.oi), oiUsd: Math.round(r.oi * spot) }));
        return {
          exp: e, date: iso(e), dte: r2((e - now) / 86400e3), T, F: r2(F), n: xs.length,
          quoted: xs.filter((r) => r.bid > 0 && r.ask > 0).length,
          atmIv: r4(atm), iv25c: r4(iv25c), iv25p: r4(iv25p), rr25: iv25c != null && iv25p != null ? r4(iv25c - iv25p) : null,
          fly25: iv25c != null && iv25p != null && atm != null ? r4((iv25c + iv25p) / 2 - atm) : null, putSkew: iv25p != null && atm ? r4(iv25p / atm) : null,
          oiC: r4(oiC), oiP: r4(oiP), oiUsd: Math.round((oiC + oiP) * spot), pcOi: oiC > 0 ? r2(oiP / oiC) : null,
          vol24usd: Math.round(sum(xs, (r) => r.vol24usd)), prem24: Math.round(sum(xs, (r) => r.prem24)), trades24: sum(xs, (r) => r.trades24),
          volC: Math.round(sum(calls, (r) => r.vol24usd)), volP: Math.round(sum(puts, (r) => r.vol24usd)), maxPain, topStrikes: top,
        };
      });
      // 30-day constant-maturity ATM IV (linear in total variance)
      const ts = expiries.filter((x) => x.atmIv != null && x.dte >= 1);
      let iv30 = null; const T30 = 30 / 365;
      const lo = [...ts].reverse().find((x) => x.T <= T30), hi = ts.find((x) => x.T >= T30);
      if (lo && hi && lo !== hi) { const w = (T30 - lo.T) / (hi.T - lo.T); iv30 = Math.sqrt(((1 - w) * lo.atmIv ** 2 * lo.T + w * hi.atmIv ** 2 * hi.T) / T30); }
      else if (lo || hi) iv30 = (lo || hi).atmIv;
      const near = ts.find((x) => x.dte >= 5), far = [...ts].reverse().find((x) => x.dte <= 120 && x.dte >= 45) || ts[ts.length - 1];
      const rr30 = interp(ts.filter((x) => x.rr25 != null).map((x) => [x.T, x.rr25]), T30) ?? (ts.find((x) => x.rr25 != null)?.rr25 ?? null);
      const S = (f) => expiries.reduce((s, x) => s + (f(x) || 0), 0);
      const oiC = S((x) => x.oiC), oiP = S((x) => x.oiP), volC = S((x) => x.volC), volP = S((x) => x.volP);
      const oiUsd = S((x) => x.oiUsd), nearOi = expiries.filter((x) => x.dte <= 14).reduce((s, x) => s + x.oiUsd, 0);
      const strikesTop = rs.filter((r) => r.oi > 0).sort((a, b) => b.oi - a.oi).slice(0, 5).map((r) => ({ name: r.name, oi: r4(r.oi), oiUsd: Math.round(r.oi * spot), iv: r4(r.iv), delta: r4(r.delta) }));
      assets.push({
        cur, spot, perp: perpsOut[cur] || null, nInstruments: rs.length, nQuoted: rs.filter((r) => r.bid > 0 && r.ask > 0).length,
        oiC: r4(oiC), oiP: r4(oiP), oiUsd, pcOi: oiC > 0 ? r2(oiP / oiC) : null, vol24usd: S((x) => x.vol24usd), prem24: S((x) => x.prem24), trades24: S((x) => x.trades24), pcVol: volC > 0 ? r2(volP / volC) : null,
        nearOiShare: oiUsd > 0 ? r2(nearOi / oiUsd) : null, iv30: r4(iv30), rr25_30d: r4(rr30),
        term: { front: near ? { date: near.date, atmIv: near.atmIv } : null, back: far ? { date: far.date, atmIv: far.atmIv } : null, slope: near && far && near !== far ? r4(far.atmIv - near.atmIv) : null },
        expiries, topStrikes: strikesTop,
      });
    }
    assets.sort((a, b) => b.oiUsd - a.oiUsd);
    const tot = { oiUsd: assets.reduce((s, a) => s + a.oiUsd, 0), vol24usd: assets.reduce((s, a) => s + a.vol24usd, 0), prem24: assets.reduce((s, a) => s + a.prem24, 0) };
    return { assets, totals: tot, perps: perpsOut };
  }

  // ---------- history (hourly for IV rank, every poll for the last 48h for P/C shifts) ----------
  function recordHistory(snap) {
    const now = Date.now();
    for (const a of snap.assets) {
      const h = HIST.assets[a.cur] ||= { h: [], r: [] };
      const pt = [now, a.iv30, a.rr25_30d, a.pcOi, a.oiUsd, a.vol24usd, a.spot, a.pcVol];
      h.r.push(pt); h.r = h.r.filter((p) => now - p[0] <= 48 * 3600e3);
      if (!h.h.length || now - h.h[h.h.length - 1][0] >= 55 * 60e3) h.h.push(pt);
      h.h = h.h.filter((p) => now - p[0] <= 400 * 86400e3);
    }
    HIST.fields = ['t', 'iv30', 'rr25_30d', 'pcOi', 'oiUsd', 'vol24usd', 'spot', 'pcVol'];
    try { const tmp = F_HIST + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(HIST)); fs.renameSync(tmp, F_HIST); } catch (e) { log('derive history write failed: ' + e.message); }
  }
  function rankOf(vals, cur) {
    const v = vals.filter((x) => x != null && isFinite(x)); if (v.length < 2 || cur == null) return null;
    const mn = Math.min(...v), mx = Math.max(...v);
    return { rank: mx > mn ? r2((cur - mn) / (mx - mn) * 100) : null, pctile: r2(v.filter((x) => x < cur).length / v.length * 100), min: r4(mn), max: r4(mx), n: v.length };
  }
  function ivStats(snap) {
    const ref = readRef() || {};
    const out = {};
    for (const a of snap.assets) {
      const H = HIST.assets[a.cur] || { h: [], r: [] };
      const hv = H.h.map((p) => p[1]);
      const spanD = H.h.length ? (Date.now() - H.h[0][0]) / 86400e3 : 0;
      const own = rankOf(hv, a.iv30);
      const rv = ref.rv?.[a.cur] || null;
      let dvol = null;
      const dv = ref.dvol?.[a.cur];
      if (dv && dv.length > 30) {
        const yr = dv.filter((p) => Date.now() - p[0] <= 365 * 86400e3).map((p) => p[1] / 100);
        const curD = yr[yr.length - 1];
        dvol = { current: r4(curD), asOf: iso(dv[dv.length - 1][0]), ...rankOf(yr, curD), derivePremium: a.iv30 != null ? r4(a.iv30 - curD) : null, rankOfDeriveIv: rankOf(yr, a.iv30) };
      }
      // P/C OI shift vs ~24h ago (from per-poll ring; falls back to hourly)
      const ring = H.r.length ? H.r : H.h;
      const ago = ring.find((p) => Date.now() - p[0] <= 25 * 3600e3 && Date.now() - p[0] >= 20 * 3600e3) || null;
      const first = ring[0] || null;
      const ref24 = ago || first;
      const pcShift = ref24 && ref24[3] != null && a.pcOi != null ? { from: ref24[3], to: a.pcOi, delta: r2(a.pcOi - ref24[3]), hours: r2((Date.now() - ref24[0]) / 3600e3) } : null;
      const oiShift = ref24 && ref24[4] ? { from: ref24[4], to: a.oiUsd, pct: r2((a.oiUsd / ref24[4] - 1) * 100), hours: r2((Date.now() - ref24[0]) / 3600e3) } : null;
      const ivRv = rv?.rv30 && a.iv30 ? r2(a.iv30 / rv.rv30) : null;
      const rankUse = own && spanD >= 14 ? { src: 'own', v: own.rank } : dvol ? { src: 'dvol', v: dvol.rankOfDeriveIv?.rank } : null;
      let verdict = 'neutral', why = [];
      if (ivRv != null) { if (ivRv < 0.9) why.push(`IV ${(a.iv30 * 100).toFixed(0)}% is below 30d realized ${(rv.rv30 * 100).toFixed(0)}% (IV/RV ${ivRv})`); if (ivRv > 1.25) why.push(`IV ${(a.iv30 * 100).toFixed(0)}% is well above 30d realized ${(rv.rv30 * 100).toFixed(0)}% (IV/RV ${ivRv})`); }
      if (rankUse?.v != null) { if (rankUse.v < 25) why.push(`IV rank ${rankUse.v.toFixed(0)} (${rankUse.src === 'own' ? 'own Derive history' : 'vs Deribit DVOL 1y range'})`); if (rankUse.v > 75) why.push(`IV rank ${rankUse.v.toFixed(0)} (${rankUse.src === 'own' ? 'own Derive history' : 'vs Deribit DVOL 1y range'})`); }
      const cheap = (ivRv != null && ivRv < 0.9) || (rankUse?.v != null && rankUse.v < 25), rich = (ivRv != null && ivRv > 1.25) || (rankUse?.v != null && rankUse.v > 75);
      verdict = cheap && !rich ? 'cheap' : rich && !cheap ? 'expensive' : cheap && rich ? 'mixed' : 'neutral';
      const sk = [];
      if (a.rr25_30d != null) { if (a.rr25_30d <= -0.05) sk.push(`puts bid: 25Δ risk reversal ${(a.rr25_30d * 100).toFixed(1)} vol pts (downside hedging demand)`); else if (a.rr25_30d >= 0.05) sk.push(`calls bid: 25Δ risk reversal +${(a.rr25_30d * 100).toFixed(1)} vol pts (upside chasing)`); }
      if (a.term.slope != null && a.term.slope <= -0.03) sk.push(`inverted term structure: front ${(a.term.front.atmIv * 100).toFixed(0)}% vs ${a.term.back.date} ${(a.term.back.atmIv * 100).toFixed(0)}% (near-term stress priced)`);
      out[a.cur] = { iv30: a.iv30, own: own ? { ...own, days: r2(spanD), points: H.h.length, note: spanD < 14 ? `history building: ${H.h.length} hourly point(s) over ${spanD.toFixed(1)} day(s) since first poll; own IV rank shown once ≥14 days` : null } : { days: r2(spanD), points: H.h.length, note: 'history building (first snapshot)' },
        dvol, rv30: rv?.rv30 ?? null, rv90: rv?.rv90 ?? null, rvSource: rv?.source || null, ivRv, verdict, why, skew: { rr25: a.rr25_30d, termSlope: a.term.slope, notes: sk }, pcShift, oiShift };
    }
    return out;
  }

  // ---------- strategy scanner (defined risk only) ----------
  const fee1 = (r, px) => Math.min(r.taker * r.index, r.cap * px); // per-contract taker fee excl. the per-order base fee
  // P&L at expiry for same-expiry legs: legs [{q (+long/-short), K, cp}], debit per structure. Exact piecewise-linear.
  function expiryMetrics(legs, debit, F, sig, T, rv) {
    const pay = (S) => legs.reduce((s, l) => s + l.q * Math.max(l.cp === 'C' ? S - l.K : l.K - S, 0), 0) - debit;
    const ks = [...new Set(legs.map((l) => l.K))].sort((a, b) => a - b);
    const pts = [0, ...ks];
    const slopeHi = legs.reduce((s, l) => s + (l.cp === 'C' ? l.q : 0), 0);
    const vals = pts.map(pay);
    const maxLoss = Math.max(0, -Math.min(...vals));
    const unlimited = slopeHi > 1e-9;
    const maxGain = unlimited ? null : Math.max(...vals);
    // breakevens: zeros on each linear segment (and beyond last kink)
    const bes = [];
    const xs = [...pts, ks[ks.length - 1] * 10];
    const ys = xs.map(pay);
    for (let i = 1; i < xs.length; i++) { const [x0, y0, x1, y1] = [xs[i - 1], ys[i - 1], xs[i], ys[i]]; if ((y0 < 0 && y1 >= 0) || (y0 >= 0 && y1 < 0)) bes.push(x0 + (x1 - x0) * (-y0) / (y1 - y0)); }
    // probability of profit: lognormal mass on segments where P&L > 0
    let pop = 0; const edges = [0, ...bes, Infinity];
    for (let i = 1; i < edges.length; i++) { const a = edges[i - 1], b = edges[i]; const mid = b === Infinity ? a * 1.5 + 1 : (a + b) / 2; if (pay(mid) > 0) pop += probAbove(F, a, sig, T) - (b === Infinity ? 0 : probAbove(F, b, sig, T)); }
    const ev = (s) => legs.reduce((acc, l) => acc + l.q * b76(F, l.K, s, T, l.cp), 0) - debit;
    const curve = []; const lo = F * Math.exp(-3 * sig * Math.sqrt(T)), hi = F * Math.exp(3 * sig * Math.sqrt(T));
    for (let i = 0; i <= 40; i++) { const S = lo * Math.pow(hi / lo, i / 40); curve.push([sg(S), sg(pay(S))]); }
    return { maxLoss, maxGain, unlimited, bes, pop, evIv: ev(sig), evRv: rv ? ev(rv) : null, curve };
  }
  // calendars/diagonals: value at the SHORT expiry, long leg repriced with Black-76 at its current mark IV (sticky strike)
  function calendarMetrics(lg, sh, qS, debit, sig1, T1, rv) {
    const T2r = Math.max((lg.exp - sh.exp) / YEAR, 1 / 365), ratio = (lg.fwd || lg.index) / (sh.fwd || sh.index);
    const val = (S) => b76(S * ratio, lg.K, lg.iv, T2r, lg.cp) * (lg.df / (sh.df || 1)) - qS * Math.max(sh.cp === 'C' ? S - sh.K : sh.K - S, 0) - debit;
    const F1 = sh.fwd || sh.index, sd = sig1 * Math.sqrt(T1);
    const N = 400, lo = F1 * Math.exp(-5 * sd), hi = F1 * Math.exp(5 * sd);
    const grid = []; for (let i = 0; i <= N; i++) grid.push(lo * Math.pow(hi / lo, i / N));
    const vals = grid.map(val);
    const ext = [val(F1 * 1e-3), val(F1 * 50)];
    const maxLoss = Math.max(0, -Math.min(...vals, ...ext));
    const maxGain = Math.max(...vals);
    const bes = []; for (let i = 1; i < grid.length; i++) if ((vals[i - 1] < 0) !== (vals[i] < 0)) bes.push(grid[i - 1] + (grid[i] - grid[i - 1]) * (-vals[i - 1]) / (vals[i] - vals[i - 1]));
    const integ = (s) => { let pop = 0, ev = 0; for (let i = 1; i < grid.length; i++) { const p = probAbove(F1, grid[i - 1], s, T1) - probAbove(F1, grid[i], s, T1); const v = (vals[i - 1] + vals[i]) / 2; ev += p * v; if (v > 0) pop += p; } ev += probAbove(F1, hi, s, T1) * ext[1] + (1 - probAbove(F1, lo, s, T1)) * ext[0]; return { pop, ev }; };
    const a = integ(sig1), b = rv ? integ(rv) : null;
    const curve = []; for (let i = 0; i <= 40; i++) { const S = F1 * Math.exp(-3 * sd + 6 * sd * i / 40); curve.push([sg(S), sg(val(S))]); }
    return { maxLoss, maxGain, unlimited: false, bes, pop: a.pop, evIv: a.ev, evRv: b ? b.ev : null, curve };
  }

  function scanAll(snap, rows) {
    const ref = readRef() || {};
    const out = [];
    const now = Date.now();
    for (const a of snap.assets) {
      const rv = ref.rv?.[a.cur]?.rv30 || null;
      const rs = rows.filter((r) => r.cur === a.cur);
      const expInfo = new Map(a.expiries.map((e) => [e.exp, e]));
      // ---- same-expiry structures ----
      for (const e of a.expiries) {
        if (e.dte < 2 || e.dte > 130 || !e.atmIv) continue;
        const T = e.T, F = e.F, sig = e.atmIv;
        for (const cp of ['C', 'P']) {
          const side = rs.filter((r) => r.exp === e.exp && r.cp === cp && r.delta != null).sort((x, y) => (cp === 'C' ? x.K - y.K : y.K - x.K)); // ordered from ITM to OTM
          const longs = side.filter((r) => r.ask > 0 && r.askAmt > 0 && Math.abs(r.delta) >= 0.2 && Math.abs(r.delta) <= 0.7).sort((x, y) => Math.abs(Math.abs(x.delta) - 0.45) - Math.abs(Math.abs(y.delta) - 0.45)).slice(0, 5);
          for (const L of longs) {
            const shorts = side.filter((r) => r.bid > 0 && r.bidAmt > 0 && Math.abs(r.delta) >= 0.04 && Math.abs(r.delta) < Math.abs(L.delta) && (cp === 'C' ? r.K > L.K : r.K < L.K)).slice(0, 7);
            const costL = L.ask + fee1(L, L.ask);
            const tmpl = [];
            for (const A of shorts) { tmpl.push({ kind: 'vertical', sh: [[A, 1]] }); tmpl.push({ kind: 'partial', sh: [[A, 0.5]] }); tmpl.push({ kind: 'partial', sh: [[A, 0.25]] }); }
            for (let i = 0; i < shorts.length; i++) for (let j = i + 1; j < shorts.length; j++) for (const [x, y] of [[0.15, 0.25], [0.25, 0.25], [0.25, 0.5]]) tmpl.push({ kind: 'ladder', sh: [[shorts[i], x], [shorts[j], y]] });
            for (const t of tmpl) {
              const credit = t.sh.reduce((s, [r, q]) => s + q * (r.bid - fee1(r, r.bid)), 0);
              const debit = costL - credit;
              const legs = [{ q: 1, K: L.K, cp }, ...t.sh.map(([r, q]) => ({ q: -q, K: r.K, cp }))];
              const m = expiryMetrics(legs, debit, F, sig, T, rv);
              const midDebit = L.mark - t.sh.reduce((s, [r, q]) => s + q * r.mark, 0);
              out.push(pack(a, e, cp, t.kind, [{ r: L, q: 1, side: 'buy', px: L.ask }, ...t.sh.map(([r, q]) => ({ r, q, side: 'sell', px: r.bid }))], debit, costL, credit, m, midDebit, rv, sig));
            }
          }
        }
      }
      // ---- calendars / diagonals (sell nearer expiry against a longer-dated long) ----
      const exps = a.expiries.filter((e) => e.atmIv && e.dte >= 2);
      const nearE = exps.filter((e) => e.dte <= 45).slice(0, 3);
      for (const e1 of nearE) {
        const farE = exps.filter((e) => e.dte >= e1.dte + 7 && e.dte <= 200).slice(0, 3);
        for (const cp of ['C', 'P']) {
          const shorts = rs.filter((r) => r.exp === e1.exp && r.cp === cp && r.bid > 0 && r.bidAmt > 0 && r.delta != null && Math.abs(r.delta) >= 0.2 && Math.abs(r.delta) <= 0.5).sort((x, y) => Math.abs(Math.abs(x.delta) - 0.35) - Math.abs(Math.abs(y.delta) - 0.35)).slice(0, 3);
          for (const S of shorts) for (const e2 of farE) {
            const cand = rs.filter((r) => r.exp === e2.exp && r.cp === cp && r.ask > 0 && r.askAmt > 0 && r.iv && (cp === 'C' ? r.K <= S.K : r.K >= S.K)).sort((x, y) => Math.abs(x.K - S.K) - Math.abs(y.K - S.K)).slice(0, 3);
            for (const L of cand) for (const qS of [1, 0.5]) {
              const costL = L.ask + fee1(L, L.ask), credit = qS * (S.bid - fee1(S, S.bid)), debit = costL - credit;
              const m = calendarMetrics(L, S, qS, debit, e1.atmIv, e1.T, rv);
              out.push(pack(a, e1, cp, L.K === S.K ? 'calendar' : 'diagonal', [{ r: L, q: 1, side: 'buy', px: L.ask }, { r: S, q: qS, side: 'sell', px: S.bid }], debit, costL, credit, m, L.mark - qS * S.mark, rv, e1.atmIv, e2));
            }
          }
        }
      }
    }
    // score & rank
    for (const s of out) {
      const evp = s.maxLoss > 0 && s.evRv != null ? Math.max(-0.5, Math.min(0.5, s.evRv / s.maxLoss)) : 0;
      const liq = Math.min(1, s.slipVsMid / Math.max(s.maxLoss, 1e-9));
      s.score = r2(100 * (0.40 * s.pop + 0.30 * (evp + 0.5) + 0.15 * Math.min(1, s.recovered) + 0.15 * (1 - liq)));
      s.scoreParts = { pop: r2(s.pop * 100), evRvPctOfMaxLoss: r2(evp * 100), recoveredPct: r2(s.recovered * 100), slippagePctOfMaxLoss: r2(liq * 100) };
    }
    const valid = out.filter((s) => s.maxLoss > 0.0001 && s.debit > 0 && isFinite(s.score));
    const suspicious = out.length - valid.length;
    valid.sort((x, y) => y.score - x.score);
    const pick = (f, n) => { const seen = new Set(), res = []; for (const s of valid) { if (!f(s)) continue; const k = s.cur + s.kind + s.cp + s.legs[0].name; if (seen.has(k)) continue; seen.add(k); res.push(s); if (res.length >= n) break; } return res; };
    const top = pick((s) => !s.thin, 3);
    const topBull = pick((s) => !s.thin && s.cp === 'C', 3), topBear = pick((s) => !s.thin && s.cp === 'P', 3);
    const byAsset = {}; for (const a of snap.assets) byAsset[a.cur] = pick((s) => s.cur === a.cur, 6);
    const byKind = {}; for (const k of ['ladder', 'partial', 'vertical', 'calendar', 'diagonal']) byKind[k] = pick((s) => s.kind === k && !s.thin, 6);
    return { count: out.length, valid: valid.length, droppedNonPositiveRisk: suspicious, top, topBull, topBear, byAsset, byKind,
      method: 'Longs priced at the best ASK, shorts at the best BID (never mid) plus Derive taker fees per contract (min(0.03% × index, 12.5% × premium)); the $0.50 per-order base fee is added when you size. Only resting quotes with size count. Every short is covered by a long of the same type: same-expiry shorts sit further OTM than the long and never exceed it in quantity; calendar/diagonal shorts expire BEFORE the long and are at the same or a further-OTM strike. Probability of profit uses a lognormal with that expiry\'s ATM implied vol; EV(RV) uses 30d realized vol. Calendars are valued at the short expiry with the long leg repriced at its current IV (sticky strike), so their numbers depend on IV staying put.',
      thinRule: 'Assets with < $5M Derive options OI or < 20 two-sided quotes are marked thin and excluded from the overall / by-structure top lists (still shown per asset).',
      score: 'score = 40 × P(profit) + 30 × EV under realized vol (as share of max loss, clipped ±50%) + 15 × principal recovered upfront + 15 × (1 − slippage vs mid as share of max loss). Ranks trade-offs; does not predict a winner.' };
  }

  function pack(a, e, cp, kind, legs, debit, costL, credit, m, midDebit, rv, sig, e2) {
    const L = legs[0].r;
    const shortQ = legs.slice(1).reduce((s, l) => s + l.q, 0);
    const per20 = legs.map((l) => ({ name: l.r.name, side: l.side, qty20: r2(l.q * 20), q: l.q, K: l.r.K, cp: l.r.cp, exp: iso(l.r.exp), px: l.px, mark: l.r.mark, bid: l.r.bid, ask: l.r.ask, bidAmt: l.r.bidAmt, askAmt: l.r.askAmt, iv: r4(l.r.iv), delta: r4(l.r.delta), minAmt: l.r.minAmt, step: l.r.step, feePer: sg(fee1(l.r, l.px), 4), baseFee: l.r.baseFee }));
    const slip = legs.reduce((s, l) => s + l.q * Math.abs(l.px - l.r.mark), 0);
    const nm = (r) => `${fmtK(r.K)}${r.cp}`;
    const be = m.bes.map((x) => sg(x));
    const money = (x) => (Math.abs(x) >= 1 ? '$' + r2(x).toLocaleString() : '$' + sg(x, 3));
    const tag = { ladder: 'principal-recovery ladder', partial: 'partially covered long', vertical: 'vertical spread', calendar: 'calendar', diagonal: 'diagonal' }[kind];
    const ride = r2((1 - shortQ) * 20);
    let summary;
    const pct = (x) => (x * 100).toFixed(0) + '%';
    if (kind === 'calendar' || kind === 'diagonal') summary = `Buy ${a.cur} ${nm(L)} ${iso(L.exp)} and sell ${legs[1].q === 1 ? 'the same number' : 'half as many'} ${nm(legs[1].r)} expiring ${iso(legs[1].r.exp)}: the short pays back ${pct(credit / costL)} of the cost now; profit if ${a.cur} sits near ${fmtK(legs[1].r.K)} on ${iso(legs[1].r.exp)} (break-even ${be.map(fmtK).join('–') || 'n/a'}), max loss ≈ the ${money(debit)} debit per long${legs[1].q < 1 ? '; half the longs stay unhedged after that date' : '; afterwards you still own the long and can sell again'}.`;
    else summary = `Buy 20 ${a.cur} ${nm(L)} ${iso(L.exp)}${legs.slice(1).map((l) => ` and sell ${r2(l.q * 20)} ${nm(l.r)}`).join(',')}: recovers ${pct(credit / costL)} of the premium upfront, max loss ${money(debit * 20)} per 20, break-even ${be.length ? be.map(fmtK).join(' / ') : 'n/a'}${ride > 0 ? `; ${ride} long${ride === 1 ? '' : 's'} ride with unlimited ${cp === 'C' ? 'upside' : 'downside payoff'} past the top short` : `; capped at ${money(m.maxGain * 20)} per 20`}.`;
    return {
      id: `${kind}:${legs.map((l) => l.r.name + 'x' + l.q).join('|')}`, cur: a.cur, kind, tag, cp, view: cp === 'C' ? 'bullish' : 'bearish', spot: a.spot,
      expiry: iso(e.exp), longExpiry: e2 ? iso(e2.exp) : iso(e.exp), dte: e.dte, legs: per20, debit: sg(debit), longCost: sg(costL), credit: sg(credit), recovered: credit / costL,
      midDebit: sg(midDebit), slipVsMid: slip, maxLoss: sg(m.maxLoss), maxGain: m.maxGain != null ? sg(m.maxGain) : null, unlimited: m.unlimited, breakevens: be, pop: m.pop, evIv: sg(m.evIv), evRv: m.evRv != null ? sg(m.evRv) : null, thin: a.oiUsd < 5e6 || a.nQuoted < 20,
      ivUsed: r4(sig), rvUsed: rv ? r4(rv) : null, curve: m.curve, summary,
      marginNote: kind === 'calendar' || kind === 'diagonal' ? 'Standard Margin offsets spreads only within the SAME expiry, so the near-dated short is margined as if naked under SM; Portfolio Margin (PM2) nets it against the long. See simulated margin below.' : 'Same-expiry covered short: Standard Margin caps the requirement at the spread\'s max loss (docs.derive.xyz/sm-v-pm-comparison).',
    };
  }

  // simulated margin (public/get_margin) for the top strategies, per 1 long contract
  async function marginTop(snap) {
    const S = snap.strategies; if (!S) return;
    const list = [...S.top, ...(S.topBull || []), ...(S.topBear || []), ...Object.values(S.byKind).flat(), ...Object.values(S.byAsset).flat()];
    const uniq = [...new Map(list.map((s) => [s.id, s])).values()].slice(0, 40);
    const COL = 1e6;
    await pool(uniq, 4, async (s) => {
      const c = marginCache.get(s.id);
      if (c && Date.now() - c.t < 15 * 60e3) { s.margin = c.v; return; }
      const pos = s.legs.map((l) => ({ instrument_name: l.name, amount: String(l.side === 'buy' ? l.q : -l.q) }));
      const one = async (type) => { const p = { margin_type: type, simulated_collaterals: [{ asset_name: 'USDC', amount: String(COL) }], simulated_positions: pos }; if (type === 'PM2') p.market = s.cur; const r = await rpc('get_margin', p); return { im: r2(COL - +r.pre_initial_margin), mm: r2(COL - +r.pre_maintenance_margin) }; };
      const v = { sm: null, pm2: null, unit: 'USDC per 1 long contract (structure as listed), beyond paying the debit; from public/get_margin' };
      try { v.sm = await one('SM'); } catch (e) { v.smErr = String(e.message || e).slice(0, 120); }
      try { v.pm2 = await one('PM2'); } catch (e) { v.pm2Err = String(e.message || e).slice(0, 120); }
      marginCache.set(s.id, { t: Date.now(), v }); s.margin = v;
    });
  }

  // ---------- DRV farming math (retail trading rewards: weekly pool pro-rata on fees paid) ----------
  function farming(snap, rows, perpsOut) {
    const ref = readRef() || {};
    const drv = ref.drv || null, prog = ref.programs || null, poolW = prog?.retail_pool_weekly || null;
    // estimate exchange-wide fees from trailing-24h stats (list fee schedule, both sides, no discounts/rebates)
    let optFees = 0, optNotional = 0, optPrem = 0, optTrades = 0;
    for (const r of rows) { if (!r.vol24usd) continue; optNotional += r.vol24usd; optPrem += r.prem24; optTrades += r.trades24; optFees += Math.min(0.0003 * r.vol24usd, 0.125 * r.prem24) + Math.min(0.0001 * r.vol24usd, 0.125 * r.prem24) + 0.5 * r.trades24; }
    let perpFees = 0, perpNotional = 0, perpTrades = 0;
    for (const p of Object.values(perpsOut)) { perpNotional += p.vol24usd; perpTrades += p.trades24; perpFees += 0.0004 * p.vol24usd + 0.01 * p.trades24; }
    const dayFees = optFees + perpFees, weekFees = dayFees * 7;
    const price = drv?.price ?? null;
    const amount = poolW?.amount ?? null;
    const R = price != null && amount && weekFees > 0 ? (amount * price) / weekFees : null; // reward $ per $1 fee
    const sprd = (cur) => { const p = perpsOut[cur]; return p && p.bid > 0 && p.ask > 0 ? (p.ask - p.bid) / ((p.ask + p.bid) / 2) : null; };
    // ATM option half-spread as share of underlying notional (median over near-ATM quoted strikes, BTC+ETH, 7–45d)
    const atmHalf = median(rows.filter((r) => (r.cur === 'BTC' || r.cur === 'ETH') && r.bid > 0 && r.ask > 0 && r.delta != null && Math.abs(Math.abs(r.delta) - 0.5) < 0.15 && (r.exp - Date.now()) / 86400e3 >= 7 && (r.exp - Date.now()) / 86400e3 <= 45).map((r) => (r.ask - r.bid) / 2 / r.index));
    const atmPremPct = median(rows.filter((r) => (r.cur === 'BTC' || r.cur === 'ETH') && r.bid > 0 && r.ask > 0 && r.delta != null && Math.abs(Math.abs(r.delta) - 0.5) < 0.15 && (r.exp - Date.now()) / 86400e3 >= 7 && (r.exp - Date.now()) / 86400e3 <= 45).map((r) => r.mark / r.index));
    const V = 10000;
    const perpSpread = median(['BTC', 'ETH', 'SOL'].map(sprd));
    const orderSize = 2000; // assume $2k per order to spread the per-order base fee
    const cases = [
      { k: 'perp_taker', label: 'Perps, taker (market orders), BTC/ETH/SOL', fees: 0.0003 * V + 0.01 * (V / orderSize), spreadCost: perpSpread != null ? perpSpread / 2 * V : null },
      { k: 'perp_maker', label: 'Perps, maker (resting limit orders)', fees: 0.0001 * V, spreadCost: 0, note: 'Maker earns the spread instead of paying it, but gets filled when price moves against the order (adverse selection), not modeled.' },
      { k: 'opt_taker', label: 'Options, taker, ATM BTC/ETH 7–45d', fees: Math.min(0.0003 * V, atmPremPct != null ? 0.125 * atmPremPct * V : Infinity) + 0.5 * (V / orderSize), spreadCost: atmHalf != null ? atmHalf * V : null },
    ];
    const scen = [0.10, 0.25, price, 0.75, 1, 2, 3, 5].filter((x, i, a) => x != null && a.indexOf(x) === i).sort((a, b) => a - b);
    for (const c of cases) {
      c.fees = r2(c.fees); c.spreadCost = r2(c.spreadCost); const cost = c.fees + (c.spreadCost || 0);
      c.totalCost = r2(cost);
      c.drvPer10k = weekFees > 0 && amount ? r4(c.fees / weekFees * amount) : null; // your share of one weekly pool for $10k of volume that week
      c.rewardUsd = R != null ? r2(c.fees * R) : null;
      c.net = c.rewardUsd != null ? r2(c.rewardUsd - cost) : null;
      c.breakevenPrice = c.drvPer10k ? r4(cost / c.drvPer10k) : null;
      c.scenarios = c.drvPer10k ? scen.map((p) => ({ price: p, reward: r2(c.drvPer10k * p), net: r2(c.drvPer10k * p - cost), netInstantUnstake: r2(c.drvPer10k * p * 0.8 - cost) })) : [];
    }
    return {
      drv: drv ? { price: drv.price, ch24: drv.ch24, ch7d: drv.ch7d, mcap: drv.mcap, fdv: drv.fdv, vol24: drv.vol24, ath: drv.ath, athDate: drv.ath_date, contracts: drv.contracts, dex: drv.dex || null, source: drv.source, updated: drv.cg_updated } : null,
      pool: poolW, programs: prog ? { maker: prog.maker_current, makerSource: prog.maker_source, facts: prog.facts } : null,
      exchange24h: { optionNotional: Math.round(optNotional), optionPremium: Math.round(optPrem), optionTrades: optTrades, perpNotional: Math.round(perpNotional), perpTrades, estFeesDay: Math.round(dayFees), estFeesWeek: Math.round(weekFees) },
      rewardPerFeeDollar: r4(R), cases, scenarioPrices: scen,
      assumptions: [
        'Retail trading rewards are pro-rata on FEES paid (not volume): your weekly stDRV = pool × your fees ÷ all fees (official docs, cited).',
        `Exchange-wide fees are ESTIMATED from Derive's trailing-24h ticker stats × 7 at list rates (taker 3 bps + maker 1 bps of notional, options capped at 12.5% of premium, $0.50/$0.01 base per trade). Market-maker discounts/rebates and RFQ discounts make true fees lower, which would make rewards per fee dollar HIGHER; a busier week makes them LOWER.`,
        'Pool size uses the docs figure ("50,000 stDRV weekly for trading programs", stated as "up to"); the live weekly amount is only in the app.',
        '$10k of volume is assumed to be traded in one week, in $2k orders (per-order base fee).',
        'Rewards are paid in stDRV (staked, non-transferable): 7-day unlock or 20% instant-unlock penalty per the token docs, so the "instant unstake" column values rewards at 80%.',
      ],
      caveats: [
        'Wash trading / self-matching is prohibited; all activity is audited before rewards finalize and ToS violations are disqualified (official docs).',
        'Your fees are certain; rewards are not: other farmers dilute the pool, the pool can change, and DRV price can fall before you can unstake.',
        'Spread + price-impact is often the bigger cost than fees, especially in options; round-tripping also carries market risk while open.',
        'Market-maker DRV pools (institutional program, by score with $50M+ 28-day volume) are not reachable for retail.',
      ],
    };
  }

  // ---------- cross-reference with composite / crash detector / perps ----------
  async function crossFlags(snap) {
    let comp = null; try { comp = composite ? await composite() : null; } catch {}
    let ps = null; try { ps = perps ? perps.snapshot() : null; } catch {}
    const cBy = new Map((comp?.tokens || []).filter((t) => t.kind === 'perp').map((t) => [String(t.sym).toUpperCase(), t]));
    const pBy = new Map((ps?.tokens || []).map((t) => [String(t.sym).toUpperCase(), t]));
    const oiRank = new Map(snap.assets.map((a, i) => [a.cur, i]));
    const out = [];
    for (const a of snap.assets) {
      const st = snap.ivStats?.[a.cur] || {};
      const H = HIST.assets[a.cur]?.h || [];
      const ownOi = H.length >= 24 ? rankOf(H.map((p) => p[4]), a.oiUsd) : null;
      const heavyWhy = [];
      if (ownOi && ownOi.pctile >= 75) heavyWhy.push(`OI at the ${ownOi.pctile.toFixed(0)}th percentile of its stored history`);
      if (oiRank.get(a.cur) < 3 && a.oiUsd > 0) heavyWhy.push(`#${oiRank.get(a.cur) + 1} by OI on Derive ($${(a.oiUsd / 1e6).toFixed(1)}M)`);
      if (a.nearOiShare != null && a.nearOiShare >= 0.4) heavyWhy.push(`${(a.nearOiShare * 100).toFixed(0)}% of OI expires within 14 days`);
      const c = cBy.get(a.cur), p = pBy.get(a.cur);
      const crash = c?.factors?.find((f) => f.key === 'crash' && f.available !== false);
      const riskWhy = [];
      if (c && (c.grade === 'D' || c.grade === 'F')) riskWhy.push(`composite grade ${c.grade} (${c.score}/100)`);
      if (crash && crash.score != null && crash.score <= 35) riskWhy.push(`crash-pattern factor ${crash.score}/100 (${crash.value})`);
      if (p?.flags?.length) riskWhy.push(`perp flags: ${p.flags.map((f) => (typeof f === 'string' ? f : f.text || f.kind || f.level || JSON.stringify(f))).join(', ')}`);
      for (const w of c?.warnings || []) riskWhy.push(w);
      const signals = [];
      if (st.pcShift && Math.abs(st.pcShift.delta) >= 0.15 && st.pcShift.hours >= 1) signals.push(`put/call OI ${st.pcShift.from} → ${st.pcShift.to} over ${st.pcShift.hours.toFixed(0)}h (${st.pcShift.delta > 0 ? 'more puts: hedging/bearish' : 'more calls: bullish/upside'})`);
      if (a.pcOi != null && (a.pcOi >= 1.5 || a.pcOi <= 0.4)) signals.push(`put/call OI ${a.pcOi} (${a.pcOi >= 1.5 ? 'put heavy' : 'call heavy'})`);
      if (a.pcVol != null && a.vol24usd > 50000 && (a.pcVol >= 2 || a.pcVol <= 0.4)) signals.push(`24h put/call volume ${a.pcVol}`);
      for (const n of st.skew?.notes || []) signals.push(n);
      const level = riskWhy.length && heavyWhy.length ? 'alert' : riskWhy.length || signals.length ? 'watch' : 'none';
      out.push({ cur: a.cur, level, heavy: heavyWhy, risk: riskWhy, signals, composite: c ? { grade: c.grade, score: c.score, summary: c.summary } : null, perp: p ? { fAnn: p.fAnn, oiCh24: p.oiCh24, flags: p.flags } : null, oiUsd: a.oiUsd, pcOi: a.pcOi,
        text: level === 'alert' ? `${a.cur}: elevated risk (${riskWhy.join('; ')}) while Derive options OI is heavy (${heavyWhy.join('; ')}).` : null });
    }
    return { generatedAt: Date.now(), compositeAvailable: !!comp, perpsAvailable: !!ps?.generatedAt, items: out.sort((x, y) => ({ alert: 0, watch: 1, none: 2 }[x.level] - { alert: 0, watch: 1, none: 2 }[y.level])),
      rule: 'ALERT when the composite grade is D/F, the crash-pattern factor ≤ 35/100, a perp funding/OI flag or a composite warning fires AND Derive OI is heavy (top-3 by OI on Derive, ≥75th percentile of its own stored history, or ≥40% of OI expiring within 14 days). WATCH = either side alone or a put/call / skew signal.' };
  }

  // ---------- public API ----------
  function start() {
    readRef();
    setTimeout(() => poll(), 2000);
    timer = setInterval(() => poll(), POLL_MS); timer.unref?.();
  }
  function stripRows(s) { const { rows, ...rest } = s; return rest; }
  function routes() {
    return {
      async '/api/derive'(q) {
        if (!SNAP) { poll(); throw Object.assign(new Error('Derive snapshot warming up (first poll takes ~15s), try again shortly'), { status: 503 }); }
        if (Date.now() - (SNAP.meta?.generatedAt || 0) > POLL_MS * 2) poll();
        const s = stripRows(SNAP);
        const ref = readRef();
        return { ...s, cross: await crossFlags(SNAP).catch((e) => ({ error: String(e.message || e), items: [] })), status: { polling, lastErr, ageSec: Math.round((Date.now() - (SNAP.meta?.generatedAt || 0)) / 1000), refAgeSec: refT ? Math.round((Date.now() - refT) / 1000) : null, refErrors: ref?.errors || [] },
          nfa: 'Model estimates from Derive public market data. Not financial advice. Nothing here trades.' };
      },
      async '/api/derive/chain'(q) {
        if (!SNAP?.rows) throw Object.assign(new Error('warming up'), { status: 503 });
        const cur = String(q.get('cur') || 'ETH').toUpperCase(), exp = q.get('exp');
        const rs = SNAP.rows.filter((r) => r.cur === cur && (!exp || iso(r.exp) === exp));
        return { cur, exp, rows: rs.map((r) => ({ ...r, exp: iso(r.exp) })).sort((a, b) => a.exp.localeCompare(b.exp) || a.K - b.K || a.cp.localeCompare(b.cp)) };
      },
      async '/api/derive/history'(q) { const cur = String(q.get('cur') || 'BTC').toUpperCase(); return { cur, fields: HIST.fields, hourly: HIST.assets[cur]?.h || [], recent: HIST.assets[cur]?.r || [] }; },
    };
  }
  return { start, poll, routes, snapshot: () => SNAP };
}

module.exports = { createDerive, _test: { b76, ncdf, probAbove, interp } };
