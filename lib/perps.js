'use strict';
// Perp Desk: funding / open interest / mark-index from FREE public venue APIs (no keys).
// Venues: Binance USDT-M (fapi; falls back to the www.binance.com/fapi mirror when fapi.binance.com is geo-blocked),
// Bybit v5 (often geo-blocked from US boxes: detected and reported), OKX v5 public, Hyperliquid info, Gate.io v4 (extra fallback).
// Funding history baselines + daily ATR come from research/perps.py -> data/perps_stats.json (refreshed ~6h).
// All output is a model estimate from public data, NOT financial advice. Nothing here trades.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getJSON, postJSON } = require('./util');

const REFRESH_MS = 2 * 60e3;          // live snapshot cadence
const BLOCK_RETRY_MS = 30 * 60e3;     // re-probe geo-blocked venues every 30 min
const STATS_MAX_AGE = 6 * 3600e3;
const MAJORS = ['BTC', 'ETH', 'SOL'];
const ANN = (rate, intervalH) => rate * (24 / intervalH) * 365 * 100; // % per year
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const num = (x) => (x == null || x === '' || isNaN(+x) ? null : +x);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// contract base -> {sym, mult}: 1000PEPE / 1000000MOG / 1MBABYDOGE / kPEPE (Hyperliquid)
function normBase(b, venue) {
  let m;
  if ((m = b.match(/^1000000(.+)$/))) return { sym: m[1], mult: 1e6 };
  if ((m = b.match(/^1M(.+)$/)) && venue !== 'okx') return { sym: m[1], mult: 1e6 };
  if ((m = b.match(/^1000(.+)$/))) return { sym: m[1], mult: 1000 };
  if (venue === 'hyperliquid' && (m = b.match(/^k([A-Z].*)$/))) return { sym: m[1], mult: 1000 };
  return { sym: b, mult: 1 };
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e.message }; } } }));
  return out;
}

function createPerps({ DATA_DIR, log = () => {} }) {
  const venues = {
    binance: { name: 'Binance USDT-M', ok: false, route: null, error: null, at: null, n: 0 },
    bybit: { name: 'Bybit v5 linear', ok: false, route: null, error: null, at: null, n: 0 },
    okx: { name: 'OKX USDT swaps', ok: false, route: null, error: null, at: null, n: 0 },
    hyperliquid: { name: 'Hyperliquid', ok: false, route: null, error: null, at: null, n: 0 },
    gate: { name: 'Gate.io USDT futures (extra fallback)', ok: false, route: null, error: null, at: null, n: 0 },
  };
  const blockedUntil = {};
  const slow = {}; // slow-changing caches: {key: {t, v}}
  async function slowGet(key, ttl, fn) { const c = slow[key]; if (c && Date.now() - c.t < ttl) return c.v; try { const v = await fn(); slow[key] = { t: Date.now(), v }; return v; } catch (e) { if (c) return c.v; throw e; } }
  async function getFirst(urls) { // try each route, return {route, data}; remembers HTTP status for geo detection
    let last;
    for (const u of urls) { try { return { route: new URL(u).host, data: await getJSON(u, { 'user-agent': 'Mozilla/5.0 (asymmetric-terminal read-only)' }, 15000) }; } catch (e) { last = e; } }
    throw last;
  }
  const geoMsg = (e) => /HTTP (451|403)/.test(e.message) ? `${e.message} (geo-blocked from this server's location)` : e.message;

  // ---------------- per-venue bulk fetchers -> [{venue, contract, sym, mult, mark, index, rate, intervalH, nextFundingTime, oiUsd, vol24Usd, ch24, maxLev}] ----------------
  async function fetchBinance() {
    const bases = venues.binance.route ? [venues.binance.route] : ['https://fapi.binance.com', 'https://www.binance.com'];
    let pi = null, base = null, err = null;
    for (const b of bases) { try { pi = await getJSON(`${b}/fapi/v1/premiumIndex`, {}, 20000); base = b; break; } catch (e) { err = e; } }
    if (!pi) throw err;
    venues.binance.route = base;
    venues.binance.note = base.includes('www.binance.com') ? 'fapi.binance.com returns HTTP 451 (US geo-block); using the public www.binance.com/fapi mirror (same data)' : null;
    const [t24, fi] = await Promise.all([
      getJSON(`${base}/fapi/v1/ticker/24hr`, {}, 20000).catch(() => []),
      slowGet('bn:fundingInfo', 3600e3, () => getJSON(`${base}/fapi/v1/fundingInfo`, {}, 20000)).catch(() => []),
    ]);
    const T = new Map((t24 || []).map((x) => [x.symbol, x])); const I = new Map((fi || []).map((x) => [x.symbol, x]));
    return pi.filter((x) => /^[A-Z0-9]+USDT$/.test(x.symbol) && +x.markPrice > 0).map((x) => {
      const nb = normBase(x.symbol.replace(/USDT$/, ''), 'binance'); const t = T.get(x.symbol) || {}; const iv = I.get(x.symbol)?.fundingIntervalHours || 8;
      return { venue: 'binance', contract: x.symbol, ...nb, mark: +x.markPrice / nb.mult, index: num(x.indexPrice) / nb.mult, rate: +x.lastFundingRate, intervalH: iv, nextFundingTime: x.nextFundingTime, oiUsd: null, vol24Usd: num(t.quoteVolume), ch24: num(t.priceChangePercent), maxLev: null };
    });
  }
  async function fetchBybit() {
    const { route, data } = await getFirst(['https://api.bybit.com/v5/market/tickers?category=linear', 'https://api.bytick.com/v5/market/tickers?category=linear']);
    venues.bybit.route = route;
    return (data?.result?.list || []).filter((x) => /USDT$/.test(x.symbol) && +x.markPrice > 0).map((x) => {
      const nb = normBase(x.symbol.replace(/USDT$/, ''), 'bybit');
      return { venue: 'bybit', contract: x.symbol, ...nb, mark: +x.markPrice / nb.mult, index: num(x.indexPrice) / nb.mult, rate: num(x.fundingRate), intervalH: num(x.fundingIntervalHour) || 8, nextFundingTime: num(x.nextFundingTime), oiUsd: num(x.openInterestValue), vol24Usd: num(x.turnover24h), ch24: num(x.price24hPcnt) != null ? +x.price24hPcnt * 100 : null, maxLev: null };
    });
  }
  async function fetchOkx() {
    const B = 'https://www.okx.com/api/v5';
    const [fr, oi, tk, mp, ins] = await Promise.all([
      getJSON(`${B}/public/funding-rate?instId=ANY`, {}, 20000), getJSON(`${B}/public/open-interest?instType=SWAP`, {}, 20000).catch(() => ({ data: [] })),
      getJSON(`${B}/market/tickers?instType=SWAP`, {}, 20000).catch(() => ({ data: [] })), getJSON(`${B}/public/mark-price?instType=SWAP`, {}, 20000).catch(() => ({ data: [] })),
      slowGet('okx:ins', 3600e3, () => getJSON(`${B}/public/instruments?instType=SWAP`, {}, 20000)).catch(() => ({ data: [] })),
    ]);
    venues.okx.route = 'www.okx.com';
    const OI = new Map(oi.data.map((x) => [x.instId, x])), TK = new Map(tk.data.map((x) => [x.instId, x])), MP = new Map(mp.data.map((x) => [x.instId, x])), IN = new Map((ins.data || []).map((x) => [x.instId, x]));
    return fr.data.filter((x) => /-USDT-SWAP$/.test(x.instId)).map((x) => {
      const nb = normBase(x.instId.split('-')[0], 'okx'); const t = TK.get(x.instId) || {}; const m = num(MP.get(x.instId)?.markPx) ?? num(t.last);
      const iv = x.nextFundingTime && x.fundingTime ? Math.max(1, Math.round((+x.nextFundingTime - +x.fundingTime) / 3600e3)) : 8;
      return { venue: 'okx', contract: x.instId, ...nb, mark: m != null ? m / nb.mult : null, index: null, rate: num(x.fundingRate), intervalH: iv, nextFundingTime: num(x.fundingTime), oiUsd: num(OI.get(x.instId)?.oiUsd), vol24Usd: num(t.volCcy24h) != null && m ? +t.volCcy24h * m : null, ch24: num(t.open24h) && num(t.last) ? (t.last / t.open24h - 1) * 100 : null, maxLev: num(IN.get(x.instId)?.lever) };
    }).filter((x) => x.mark > 0 && x.rate != null);
  }
  async function fetchHL() {
    const [meta, ctx] = await postJSON('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' });
    venues.hyperliquid.route = 'api.hyperliquid.xyz';
    return meta.universe.map((u, i) => ({ u, c: ctx[i] })).filter(({ u, c }) => c && !u.isDelisted && +c.markPx > 0).map(({ u, c }) => {
      const nb = normBase(u.name, 'hyperliquid'); const mk = +c.markPx;
      return { venue: 'hyperliquid', contract: u.name, ...nb, mark: mk / nb.mult, index: num(c.oraclePx) / nb.mult, rate: num(c.funding), intervalH: 1, nextFundingTime: null, oiUsd: num(c.openInterest) * mk, vol24Usd: num(c.dayNtlVlm), ch24: num(c.prevDayPx) ? (mk / c.prevDayPx - 1) * 100 : null, maxLev: u.maxLeverage };
    });
  }
  async function fetchGate() {
    const B = 'https://api.gateio.ws/api/v4/futures/usdt';
    const [tk, ct] = await Promise.all([getJSON(`${B}/tickers`, {}, 20000), slowGet('gate:contracts', 3600e3, () => getJSON(`${B}/contracts`, {}, 30000)).catch(() => [])]);
    venues.gate.route = 'api.gateio.ws';
    const C = new Map((ct || []).map((x) => [x.name, x]));
    return tk.filter((x) => /_USDT$/.test(x.contract) && +x.mark_price > 0).map((x) => {
      const nb = normBase(x.contract.replace(/_USDT$/, ''), 'gate'); const c = C.get(x.contract) || {}; const mk = +x.mark_price; const qm = num(x.quanto_multiplier) || num(c.quanto_multiplier) || 1;
      if (c.in_delisting) return null;
      return { venue: 'gate', contract: x.contract, ...nb, mark: mk / nb.mult, index: num(x.index_price) / nb.mult, rate: num(x.funding_rate), intervalH: c.funding_interval ? c.funding_interval / 3600 : 8, nextFundingTime: c.funding_next_apply ? c.funding_next_apply * 1000 : null, oiUsd: num(x.total_size) != null ? +x.total_size * qm * mk : null, vol24Usd: num(x.volume_24h_quote), ch24: num(x.change_percentage), maxLev: num(c.leverage_max) };
    }).filter(Boolean);
  }
  const FETCH = { binance: fetchBinance, bybit: fetchBybit, okx: fetchOkx, hyperliquid: fetchHL, gate: fetchGate };

  // ---------------- universe: catalog + sleepers + watchlist (+ majors) ----------------
  const readJ = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; } };
  const watchFile = path.join(DATA_DIR, 'perps_watch.json');
  let watchSyms = readJ('perps_watch.json') || {}; // {SYM: {price, t}}
  function addWatch(list) { // [{sym, price}] from the browser watchlist
    let ch = false;
    for (const { sym, price } of list) { const s = String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (!s || s.length > 15) continue; if (!watchSyms[s] || (price && watchSyms[s].price !== price)) { watchSyms[s] = { price: price || watchSyms[s]?.price || null, t: Date.now() }; ch = true; } else watchSyms[s].t = Date.now(); }
    if (ch) { try { fs.writeFileSync(watchFile, JSON.stringify(watchSyms)); } catch {} }
  }
  function universe() {
    const U = new Map(); // SYM -> {sym, refs:[{src, name, id, price}]}
    const add = (sym, ref) => { const s = String(sym || '').toUpperCase(); if (!s) return; if (!U.has(s)) U.set(s, { sym: s, refs: [] }); U.get(s).refs.push(ref); };
    const cat = readJ('crash_catalog.json');
    for (const c of cat?.catalog || []) add(c.symbol, { src: 'catalog', id: c.id, name: c.name, price: c.price_now });
    const sl = readJ('sleepers.json');
    for (const c of [...(sl?.items || []), ...(sl?.laggards || [])]) add(c.symbol, { src: 'sleepers', id: c.id, name: c.name, price: c.price });
    for (const [s, w] of Object.entries(watchSyms)) add(s, { src: 'watchlist', price: w.price });
    for (const s of MAJORS) add(s, { src: 'major' });
    return U;
  }

  // ---------------- state ----------------
  let snap = { generatedAt: null, tokens: [], venues };
  if (process.env.RENDER_LITE === '1') { try { const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'perps.json'), 'utf8')); if (s && s.generatedAt) snap = { ...s, venues: s.venues || venues, snapshot: true }; } catch {} } // RENDER_LITE: serve last saved snapshot
  const histFile = path.join(DATA_DIR, 'perps_history.json');
  let hist = readJ('perps_history.json') || {}; // SYM -> [[t, fAnn, oiUsd, mark]]
  let stats = null, statsT = 0;
  function loadStats() { try { const f = path.join(DATA_DIR, 'perps_stats.json'); const st = fs.statSync(f); if (st.mtimeMs !== statsT) { stats = JSON.parse(fs.readFileSync(f, 'utf8')); statsT = st.mtimeMs; } } catch { stats = null; } return stats; }
  let pyRunning = false;
  function maybeRunPy(univ) {
    try { fs.writeFileSync(path.join(DATA_DIR, 'perps_universe.json'), JSON.stringify({ generatedAt: Date.now(), tokens: univ })); } catch {}
    const st = loadStats(); const have = new Set(Object.keys(st?.tokens || {}));
    const missing = univ.filter((u) => !have.has(u.sym)).length;
    const stale = !st || Date.now() - (st.generatedAt || 0) > STATS_MAX_AGE || missing > 5;
    if (!stale || pyRunning || process.env.NO_AUTO_REFRESH === '1') return;
    pyRunning = true;
    const ch = spawn('python3', ['perps.py'], { cwd: path.join(__dirname, '..', 'research'), env: { ...process.env, DATA_DIR }, stdio: 'ignore' });
    ch.on('exit', () => { pyRunning = false; loadStats(); }); ch.on('error', () => { pyRunning = false; });
  }

  // OI 24h change: Binance openInterestHist (1h x25), else OKX rubik OI history (1H x25), else own snapshots
  const oiHist = {}; // contract -> {t, now, ago, ch}
  async function oiChange(row) {
    const key = row.venue + ':' + row.contract; const c = oiHist[key]; if (c && Date.now() - c.t < 30 * 60e3) return c;
    let r = null;
    if (row.venue === 'binance') {
      const d = await getJSON(`${venues.binance.route}/futures/data/openInterestHist?symbol=${row.contract}&period=1h&limit=25`, {}, 15000);
      if (Array.isArray(d) && d.length >= 2) { const a = +d[0].sumOpenInterestValue, b = +d[d.length - 1].sumOpenInterestValue; r = { now: b, ago: a, ch: a ? (b / a - 1) * 100 : null, hours: Math.round((d[d.length - 1].timestamp - d[0].timestamp) / 3600e3), src: 'binance openInterestHist' }; }
    } else if (row.venue === 'okx') {
      const d = await getJSON(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=${row.contract}&period=1H&limit=25`, {}, 15000);
      const a = d?.data || []; if (a.length >= 2) { const b = +a[0][3], o = +a[a.length - 1][3]; r = { now: b, ago: o, ch: o ? (b / o - 1) * 100 : null, hours: Math.round((+a[0][0] - +a[a.length - 1][0]) / 3600e3), src: 'okx rubik OI history' }; await sleep(450); }
    }
    oiHist[key] = { t: Date.now(), ...(r || { none: true }) }; return oiHist[key];
  }

  function aggregate(t) {
    const vs = t.venues;
      const w = (v) => Math.max(v.oiUsd || 0, 1e5); // OI-weight (floor so OI-less venues still count a little)
      const wf = vs.filter((v) => v.fAnn != null);
      const fAnn = wf.length ? wf.reduce((s, v) => s + v.fAnn * w(v), 0) / wf.reduce((s, v) => s + w(v), 0) : null;
      const wz = vs.filter((v) => v.z != null);
      const z = wz.length ? wz.reduce((s, v) => s + v.z * w(v), 0) / wz.reduce((s, v) => s + w(v), 0) : null;
      const spread = wf.length >= 2 ? Math.max(...wf.map((v) => v.fAnn)) - Math.min(...wf.map((v) => v.fAnn)) : null;
      const oiUsd = vs.reduce((s, v) => s + (v.oiUsd || 0), 0) || null;
      const vol24Usd = vs.reduce((s, v) => s + (v.vol24Usd || 0), 0) || null;
    Object.assign(t, { fAnn, z, spread, oiUsd, vol24Usd });
  }
  async function refresh() {
    const t0 = Date.now();
    const rows = [];
    await Promise.all(Object.entries(FETCH).map(async ([v, fn]) => {
      if (blockedUntil[v] && Date.now() < blockedUntil[v]) return; // keep previous error status
      try { const r = await fn(); rows.push(...r); Object.assign(venues[v], { ok: true, error: null, at: Date.now(), n: r.length }); }
      catch (e) { Object.assign(venues[v], { ok: false, error: geoMsg(e), at: Date.now(), n: 0 }); if (/HTTP (451|403)/.test(e.message)) blockedUntil[v] = Date.now() + BLOCK_RETRY_MS; }
    }));
    const U = universe();
    const bySym = new Map();
    for (const r of rows) { if (!U.has(r.sym)) continue; if (!bySym.has(r.sym)) bySym.set(r.sym, []); bySym.get(r.sym).push(r); }
    const st = loadStats();
    const tokens = [];
    for (const [sym, vs0] of bySym) {
      const u = U.get(sym);
      // sanity 1: venues must agree on price (drop outliers = a different coin sharing the ticker)
      const med = median(vs0.map((x) => x.mark));
      let vs = vs0.filter((x) => x.mark / med < 1.15 && x.mark / med > 0.87);
      // sanity 2: reference price from catalog/sleepers/watchlist must roughly match (ticker collisions)
      const refPx = u.refs.map((r) => r.price).filter((p) => p > 0);
      let refOk = null;
      if (refPx.length) { refOk = refPx.some((p) => med / p > 0.5 && med / p < 2); if (!refOk) continue; }
      if (!vs.length) continue;
      for (const v of vs) {
        v.fAnn = v.rate != null ? ANN(v.rate, v.intervalH) : null;
        const sv = st?.tokens?.[sym]?.funding?.[v.venue];
        v.z = sv && sv.sd > 0 && v.fAnn != null && sv.n >= 20 ? (v.fAnn - sv.mean) / sv.sd : null;
        v.histMean = sv?.mean ?? null; v.histSd = sv?.sd ?? null; v.histN = sv?.n ?? 0;
        v.basisPct = v.index ? (v.mark / v.index - 1) * 100 : null;
      }
      const best = [...vs].sort((a, b) => (b.oiUsd || 0) - (a.oiUsd || 0))[0];
      tokens.push({ sym, name: u.refs.find((r) => r.name)?.name || sym, sources: [...new Set(u.refs.map((r) => r.src))], cgId: u.refs.find((r) => r.id)?.id || null,
        mark: med, ch24: best.ch24, venues: vs.map(({ sym: _s, ...r }) => r), refPriceOk: refOk,
        stats: st?.tokens?.[sym] ? { atr14: st.tokens[sym].atr14, atrPct: st.tokens[sym].atrPct, rv30: st.tokens[sym].rv30, candles: st.tokens[sym].candleSrc, days: st.tokens[sym].days } : null });
    }
    // OI change (24h) on the deepest Binance/OKX contract for each token
    await pool(tokens, 4, async (t) => {
      aggregate(t);
      const cand = t.venues.filter((v) => v.venue === 'binance' || v.venue === 'okx').sort((a, b) => (a.venue === 'binance' ? -1 : 1) - (b.venue === 'binance' ? -1 : 1));
      for (const v of cand) { const r = await oiChange(v).catch(() => null); if (r && !r.none) { t.oiCh24 = r.ch; t.oiChSrc = `${r.src} (${v.contract}, ${r.hours}h)`; if (v.oiUsd == null) v.oiUsd = r.now; break; } }
      if (t.oiCh24 == null) { const h = hist[t.sym] || []; const ago = h.find((x) => x[0] >= Date.now() - 25 * 3600e3); if (ago && Date.now() - ago[0] > 20 * 3600e3 && ago[2] && t.oiUsd) { t.oiCh24 = (t.oiUsd / ago[2] - 1) * 100; t.oiChSrc = 'own snapshots'; } }
      aggregate(t);
    });
    // own snapshot history (30-min sampling, 14 days) -> z-score fallback
    const now = Date.now();
    for (const t of tokens) {
      const h = hist[t.sym] || (hist[t.sym] = []);
      if (!h.length || now - h[h.length - 1][0] > 30 * 60e3) h.push([now, t.fAnn != null ? +t.fAnn.toFixed(3) : null, t.oiUsd ? Math.round(t.oiUsd) : null, t.mark]);
      while (h.length && h[0][0] < now - 14 * 864e5) h.shift();
      if (t.z == null) { const xs = h.slice(0, -1).map((x) => x[1]).filter((x) => x != null); if (xs.length >= 24) { const m = xs.reduce((a, b) => a + b, 0) / xs.length; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); if (sd > 0) { t.z = (t.fAnn - m) / sd; t.zSrc = 'own 30-min snapshots'; } } } else t.zSrc = 'settled funding history (research/perps.py)';
      t.flags = flagsFor(t);
    }
    try { fs.writeFileSync(histFile, JSON.stringify(hist)); } catch {}
    tokens.sort((a, b) => (b.oiUsd || 0) - (a.oiUsd || 0));
    snap = { generatedAt: now, elapsedMs: now - t0, universe: U.size, matched: tokens.length, tokens, venues, statsAt: st?.generatedAt || null };
    try { fs.writeFileSync(path.join(DATA_DIR, 'perps.json'), JSON.stringify({ ...snap, tokens: tokens.map(({ venues: vv, ...r }) => ({ ...r, venues: vv.map((v) => ({ venue: v.venue, contract: v.contract, fAnn: v.fAnn, oiUsd: v.oiUsd, mark: v.mark })) })) })); } catch {}
    maybeRunPy(tokens.map((t) => ({ sym: t.sym, venues: Object.fromEntries(t.venues.map((v) => [v.venue, { contract: v.contract, mult: v.mult, intervalH: v.intervalH }])) })));
    log(`[perps] ${tokens.length} tokens with perps from ${U.size} universe in ${now - t0}ms; venues ok: ${Object.entries(venues).filter(([, v]) => v.ok).map(([k]) => k).join(',')}`);
    return snap;
  }

  // ---------------- flags ----------------
  const fmt = (x, d = 1) => (x == null ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d));
  function flagsFor(t) {
    const F = []; const f = t.fAnn, z = t.z, oi = t.oiCh24;
    if (f == null) return F;
    const thin = (t.oiUsd || 0) < 2e6;
    const oiTxt = oi != null ? ` Open interest ${fmt(oi, 0)}% in 24h${oi > 10 ? ': new positions are piling in, which adds fuel' : oi < -10 ? ': positions are being closed, so the pressure is easing' : ''}.` : '';
    if (f >= 50 || (z != null && z >= 2.5 && f >= 20)) F.push({ kind: 'crowded_long', level: f >= 100 || (z != null && z >= 3.5) ? 'extreme' : 'high', text: `Crowded longs: longs pay ${f.toFixed(0)}%/yr funding${z != null ? ` (${z.toFixed(1)} standard deviations above its own normal)` : ''}. When too many traders are long with leverage, a small dip can force sales and cause a sharp drop (squeeze-down risk).${oiTxt}` });
    else if (f >= 25 || (z != null && z >= 2 && f >= 15)) F.push({ kind: 'elevated_long', level: 'watch', text: `Funding elevated at ${f.toFixed(0)}%/yr: longs are paying up. Not extreme yet, but long positioning is getting heavy.${oiTxt}` });
    if (f <= -30 || (z != null && z <= -2.5 && f <= -10)) F.push({ kind: 'crowded_short', level: f <= -80 || (z != null && z <= -3.5) ? 'extreme' : 'high', text: `Crowded shorts: shorts pay ${Math.abs(f).toFixed(0)}%/yr to hold${z != null ? ` (${z.toFixed(1)} standard deviations from its own normal)` : ''}. If price rises, shorts are forced to buy back, which can spike the price (short-squeeze potential).${oiTxt}` });
    else if (f <= -12 || (z != null && z <= -2 && f <= -5)) F.push({ kind: 'elevated_short', level: 'watch', text: `Funding negative at ${f.toFixed(0)}%/yr: more traders are short than long. A squeeze needs a catalyst, but the setup is there.${oiTxt}` });
    const chronic = z != null && Math.abs(z) < 1.5 && Math.abs(f) >= 30;
    if (chronic && F.length) F[F.length - 1].text += ` Note: funding has been this ${f > 0 ? 'high' : 'negative'} for a while (z ${z.toFixed(1)} vs its own 30-day history), so the crowding is chronic rather than a fresh extreme.`;
    if (t.spread != null && t.spread >= 40) F.push({ kind: 'venue_spread', level: 'watch', text: `Venues disagree: funding differs by ${t.spread.toFixed(0)}%/yr between exchanges. One venue is much more crowded than the others; check which before trading.` });
    if (thin && F.length) F.push({ kind: 'thin', level: 'watch', text: `Thin market: only ${Math.round((t.oiUsd || 0) / 1e3)}K USD open interest across venues. Funding on small contracts swings wildly and is easy to push around.` });
    return F;
  }

  // ---------------- perp setups ----------------
  // Entry zone, conservative max leverage (a 1.5x ATR move must not liquidate; cap 5x), stop, TPs, liquidation price, funding cost/day.
  function setupFor(t, ctx = {}) {
    const atrPct = t.stats?.atrPct; if (!atrPct || !t.mark || t.fAnn == null) return null;
    const crowdedL = t.flags.find((f) => f.kind === 'crowded_long'), crowdedS = t.flags.find((f) => f.kind === 'crowded_short');
    const comp = ctx.composite; let side = null, why = [], type = null;
    if (crowdedS && (t.oiCh24 == null || t.oiCh24 > -15) && (t.ch24 == null || t.ch24 > -12)) { side = 'long'; type = 'short-squeeze'; why.push(`Shorts are crowded (${t.fAnn.toFixed(0)}%/yr funding, longs get paid to hold).`); if (t.oiCh24 > 5) why.push(`Open interest is still rising (${fmt(t.oiCh24, 0)}% in 24h): more shorts adding = more squeeze fuel.`); }
    else if (crowdedL && (t.ch24 == null || t.ch24 > -5)) { side = 'short'; type = 'crowded-long fade'; why.push(`Longs are crowded (${t.fAnn.toFixed(0)}%/yr funding, shorts get paid to hold).`); if (t.oiCh24 > 5) why.push(`Open interest up ${fmt(t.oiCh24, 0)}% in 24h: leveraged longs keep piling in.`); }
    else if (comp && (comp.grade === 'A' || comp.grade === 'B') && t.fAnn < 20 && t.fAnn > -12) { side = 'long'; type = 'composite tilt'; why.push(`Composite grade ${comp.grade} with neutral funding (${t.fAnn.toFixed(0)}%/yr): no crowding against a long.`); }
    if (!side) return null;
    const atr = t.mark * atrPct / 100;
    const mmr = 0.005, fees = 0.003; // maintenance margin + fees/slippage buffer
    let lev = Math.floor(1 / (1.5 * atrPct / 100 + mmr + fees));
    const venueMax = Math.min(...t.venues.map((v) => v.maxLev).filter((x) => x > 0));
    lev = Math.max(1, Math.min(lev, 5, isFinite(venueMax) ? venueMax : 5));
    const s = side === 'long' ? 1 : -1;
    const entryHi = side === 'long' ? t.mark : t.mark + 0.5 * atr, entryLo = side === 'long' ? t.mark - 0.5 * atr : t.mark;
    const entry = (entryHi + entryLo) / 2;
    const stop = entry - s * 1.2 * atr;
    const tp1 = entry + s * 1.5 * atr, tp2 = entry + s * 3 * atr;
    const liq = side === 'long' ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
    const dailyRatePct = t.fAnn / 365; // % of notional per day, + = longs pay
    const payPct = s * dailyRatePct; // positive = this side pays
    const notionalPer1k = 1000 * lev;
    const warn = [];
    if (atrPct > 12) warn.push(`Very volatile: a normal day moves ${atrPct.toFixed(1)}% (ATR), so even ${lev}x is risky.`);
    if ((t.oiUsd || 0) < 5e6) warn.push(`Small market (${Math.round((t.oiUsd || 0) / 1e6 * 10) / 10}M USD open interest): slippage and wicks can hit stops.`);
    if (payPct > 0.05) warn.push(`You pay funding: about ${payPct.toFixed(3)}% of position size per day.`);
    if (t.z != null && Math.abs(t.z) < 1.5 && Math.abs(t.fAnn) >= 30) warn.push(`Funding has been about this extreme for weeks (z ${t.z.toFixed(1)} vs its own 30-day history): chronic crowding often persists, so do not expect a quick squeeze.`);
    if (type === 'short-squeeze') warn.push('Crowded shorts can stay crowded for weeks while price grinds lower; negative funding is not a timing signal by itself.');
    if (type === 'crowded-long fade') warn.push('Crowded longs can keep pushing higher (shorts get squeezed first); shorting a strong trend is dangerous — respect the stop.');
    if (ctx.macro?.within) warn.push(`Macro event soon: ${ctx.macro.text}. Volatility usually rises around these releases.`);
    if (ctx.unlock?.warn) warn.push(ctx.unlock.warn);
    if (t.venues.length === 1) warn.push(`Only listed on ${t.venues[0].venue}; venue-specific moves possible.`);
    if (comp && side === 'long' && (comp.grade === 'D' || comp.grade === 'F')) warn.push(`Composite grade is ${comp.grade}: other factors argue against a long.`);
    if (comp && side === 'short' && (comp.grade === 'A' || comp.grade === 'B')) warn.push(`Composite grade is ${comp.grade}: other factors are positive, so the fade fights the bigger picture.`);
    const r = (x) => +x.toPrecision(5);
    return { sym: t.sym, side, type, why, mark: r(t.mark), entryZone: [r(entryLo), r(entryHi)], entry: r(entry), atr: r(atr), atrPct: +atrPct.toFixed(2),
      maxLeverage: lev, leverageRule: `max leverage = 1 / (1.5 × ATR% + 0.5% maintenance + 0.3% fees), capped at 5x${isFinite(venueMax) ? ` and venue max ${venueMax}x` : ''}`,
      stop: r(stop), stopPct: +(-1.2 * atrPct).toFixed(2), tp1: r(tp1), tp2: r(tp2), tpPct: [+(1.5 * atrPct).toFixed(2), +(3 * atrPct).toFixed(2)], rr: [1.25, 2.5],
      liquidation: r(liq), liqDistPct: +((Math.abs(liq / entry - 1)) * 100).toFixed(2),
      funding: { annPct: +t.fAnn.toFixed(2), perDayPctOfNotional: +payPct.toFixed(4), usdPerDayPer1kMargin: +(notionalPer1k * payPct / 100).toFixed(2), note: payPct > 0 ? 'you pay' : 'you receive' },
      oiCh24: t.oiCh24 ?? null, venues: t.venues.map((v) => v.venue), warnings: warn, nfa: 'Model estimate from public data. Not financial advice.' };
  }

  let timer = null;
  function start() { if (timer) return; const run = () => refresh().catch((e) => log('[perps] refresh failed: ' + e.message)); run(); timer = setInterval(run, REFRESH_MS); timer.unref?.(); }
  return { start, refresh, snapshot: () => snap, addWatch, setupFor, venues, loadStats };
}
module.exports = { createPerps, normBase };
