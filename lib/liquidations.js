'use strict';
// Liquidation cascade detector. Free public sources only (no keys):
//  websockets (child process lib/liq_ws.js, needs `node --experimental-websocket` on Node 20): OKX liquidation-orders, Bybit allLiquidation.<SYM>,
//  Gate futures.public_liquidates, Binance fstream !forceOrder@arr via /market/stream (the /ws and /stream paths are silent from this US box);
//  REST: Gate /futures/usdt/liq_orders (all contracts, 1-hour windows, ~6 months back), OKX /public/liquidation-orders (latest 100 per underlying),
//  Gate /futures/usdt/contract_stats (hourly long/short liquidation USD + OI, 180 days) for per-asset baselines.
//  Hyperliquid has no public liquidation feed (liquidations are only visible per user), so it is covered by the OI-drop proxy only.
// Model estimates from public data, not financial advice.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getJSON } = require('./util');

const KEEP_MS = 48 * 3600e3;
const UA = { 'user-agent': 'Mozilla/5.0 (asymmetric-terminal read-only)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (b) => { let m; if ((m = b.match(/^1000000(.+)$/))) return [m[1], 1e6]; if ((m = b.match(/^1000(.+)$/))) return [m[1], 1000]; return [b, 1]; };
const fmtUsd = (x) => (x >= 1e6 ? '$' + (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? '$' + (x / 1e3).toFixed(0) + 'K' : '$' + Math.round(x || 0));

function createLiquidations({ DATA_DIR, perps, log = () => {} }) {
  const evFile = path.join(DATA_DIR, 'liquidations_events.json');
  let events = []; const seen = new Set();
  try { const d = JSON.parse(fs.readFileSync(evFile, 'utf8')); events = (d.events || []).filter((e) => e.t > Date.now() - KEEP_MS); for (const e of events) seen.add(key(e)); } catch {}
  function key(e) { return `${e.v}|${e.contract}|${Math.round(e.t / 1000)}|${(+e.qty).toPrecision(6)}`; }
  function add(e) { if (!(e.usd > 0) || !e.sym || !e.t) return; const k = key(e); if (seen.has(k)) return; seen.add(k); events.push(e); }
  const venues = {
    binance: { name: 'Binance fstream !forceOrder@arr (/market/stream path)', mode: 'websocket' }, okx: { name: 'OKX liquidation-orders', mode: 'websocket + REST' },
    bybit: { name: 'Bybit allLiquidation (public ws)', mode: 'websocket' }, gate: { name: 'Gate public_liquidates + liq_orders', mode: 'websocket + REST' },
    hyperliquid: { name: 'Hyperliquid', mode: 'none', note: 'no public liquidation feed (only per-user fills); covered by the OI-drop proxy' },
  };
  let wsStatus = {}, child = null, childSyms = '', wsSince = null;
  function startChild() {
    const syms = (perps.snapshot().tokens || []).map((t) => t.sym).filter((s) => /^[A-Z0-9]+$/.test(s)).slice(0, 150).join(',') || 'BTC,ETH,SOL';
    if (child && syms === childSyms) return;
    if (child) { try { child.kill(); } catch {} }
    childSyms = syms; if (!wsSince) wsSince = Date.now();
    child = spawn(process.execPath, ['--experimental-websocket', '--no-warnings', path.join(__dirname, 'liq_ws.js')], { env: { ...process.env, LIQ_SYMS: syms }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(line); if (o.status) wsStatus = o.status; else add(o); } catch {} } });
    child.on('exit', () => { child = null; setTimeout(startChild, 15000); });
    log(`[liq] ws collector started for ${syms.split(',').length} symbols`);
  }
  // ---------- REST ----------
  let gateQm = null;
  async function gateMeta() { if (gateQm) return gateQm; const c = await getJSON('https://api.gateio.ws/api/v4/futures/usdt/contracts', {}, 30000); gateQm = Object.fromEntries(c.map((x) => [x.name, +x.quanto_multiplier || 1])); return gateQm; }
  async function gateWindow(from, to) {
    const qm = await gateMeta();
    const d = await getJSON(`https://api.gateio.ws/api/v4/futures/usdt/liq_orders?from=${from}&to=${to}&limit=1000`, {}, 20000);
    if (d.length >= 1000 && to - from > 600) { const mid = Math.floor((from + to) / 2); await gateWindow(from, mid); await gateWindow(mid, to); return; }
    for (const x of d) { if (!/_USDT$/.test(x.contract)) continue; const [sym, mult] = norm(x.contract.replace(/_USDT$/, '')); const sz = +x.size; const qty = Math.abs(sz) * (qm[x.contract] || 1); const px = +x.fill_price || +x.order_price;
      add({ v: 'gate', sym, contract: x.contract, side: sz > 0 ? 'long' : 'short', px: px / mult, qty: qty * mult, usd: px * qty, t: x.time * 1000, src: 'rest' }); }
  }
  let gateBackfilled = false, gateRestOk = null;
  async function pollGate() {
    try {
      const now = Math.floor(Date.now() / 1000);
      if (!gateBackfilled) { for (let h = 24; h >= 1; h--) { await gateWindow(now - h * 3600, now - (h - 1) * 3600); await sleep(150); } gateBackfilled = true; }
      else await gateWindow(now - 3600, now);
      gateRestOk = { ok: true, at: Date.now() };
    } catch (e) { gateRestOk = { ok: false, error: e.message, at: Date.now() }; }
  }
  let okxRestOk = null;
  async function pollOkx() {
    const toks = (perps.snapshot().tokens || []).filter((t) => t.venues.some((v) => v.venue === 'okx')).slice(0, 40);
    let n = 0;
    for (const t of toks) {
      const ins = t.venues.find((v) => v.venue === 'okx'); const uly = ins.contract.replace(/-SWAP$/, '');
      try {
        const d = await getJSON(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=${uly}&state=filled&limit=100`, UA, 15000);
        for (const r of d.data || []) for (const x of r.details || []) { const [sym, mult] = norm(r.instId?.split('-')[0] || uly.split('-')[0]); const cv = ctVal[r.instId || ins.contract] || 1; const px = +x.bkPx, qty = +x.sz * cv;
          add({ v: 'okx', sym, contract: r.instId || ins.contract, side: x.posSide === 'long' || (x.posSide === 'net' && x.side === 'sell') ? 'long' : 'short', px: px / mult, qty: qty * mult, usd: px * qty, t: +x.ts, src: 'rest' }); n++; }
        okxRestOk = { ok: true, at: Date.now() };
      } catch (e) { okxRestOk = { ok: false, error: e.message, at: Date.now() }; }
      await sleep(250);
    }
  }
  let ctVal = {};
  async function okxMeta() { try { const d = await getJSON('https://www.okx.com/api/v5/public/instruments?instType=SWAP', UA, 20000); for (const i of d.data || []) ctVal[i.instId] = +i.ctVal * (+i.ctMult || 1); } catch {} }
  // Gate hourly baselines (contract_stats, 7 days of hourly liquidation USD) -> per-asset Gate-only z-score while our own history is short
  let gateBase = {}, gateBaseAt = 0;
  async function gateBaselines() {
    const toks = (perps.snapshot().tokens || []).filter((t) => t.venues.some((v) => v.venue === 'gate'));
    for (const t of toks) {
      const c = t.venues.find((v) => v.venue === 'gate').contract;
      try {
        const d = await getJSON(`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${c}&interval=1h&limit=168`, {}, 15000);
        const h = d.map((x) => (+x.long_liq_usd || 0) + (+x.short_liq_usd || 0));
        const m = h.reduce((a, b) => a + b, 0) / (h.length || 1); const sd = Math.sqrt(h.reduce((a, b) => a + (b - m) ** 2, 0) / (h.length || 1));
        gateBase[t.sym] = { mean: m, sd, n: h.length, max: Math.max(0, ...h) };
      } catch {}
      await sleep(120);
    }
    gateBaseAt = Date.now();
  }
  // ---------- price buffer (from perp snapshots) ----------
  const px = {}; // sym -> [[t, mark]]
  function trackPrices() { const s = perps.snapshot(); for (const t of s.tokens || []) { const a = px[t.sym] || (px[t.sym] = []); if (!a.length || s.generatedAt - a[a.length - 1][0] > 60e3) a.push([s.generatedAt, t.mark]); while (a.length && a[0][0] < Date.now() - 3 * 3600e3) a.shift(); } }
  const chg = (sym, mins) => { const a = px[sym]; if (!a || a.length < 2) return null; const now = a[a.length - 1]; const ago = a.find((x) => x[0] >= now[0] - mins * 60e3); return ago && now[0] - ago[0] >= mins * 60e3 * 0.6 ? (now[1] / ago[1] - 1) * 100 : null; };

  // ---------- analysis ----------
  let summary = { generatedAt: null, assets: [], flags: [] };
  function analyze() {
    const now = Date.now();
    events = events.filter((e) => e.t > now - KEEP_MS);
    if (seen.size > events.length * 3 + 10000) { seen.clear(); for (const e of events) seen.add(key(e)); }
    const s = perps.snapshot(); const tok = new Map((s.tokens || []).map((t) => [t.sym, t]));
    const first = events.length ? Math.min(...events.filter((e) => e.src !== 'rest' || e.v === 'gate').map((e) => e.t)) : now;
    const coverH = (now - first) / 3600e3;
    const by = new Map();
    for (const e of events) { let a = by.get(e.sym); if (!a) by.set(e.sym, (a = [])); a.push(e); }
    const assets = [];
    for (const [sym, es] of by) {
      const w = (mins) => { const r = { long: 0, short: 0, n: 0, venues: {} }; for (const e of es) if (e.t >= now - mins * 60e3) { r[e.side] += e.usd; r.n++; r.venues[e.v] = (r.venues[e.v] || 0) + e.usd; } r.total = r.long + r.short; return r; };
      const w5 = w(5), w15 = w(15), w60 = w(60), w24 = w(1440);
      // own hourly baseline over the collected window (zeros included), excluding the current hour
      // venue-consistent baseline: until the websockets have >= 6h of history only Gate (24h REST backfill) is compared with Gate
      let z60 = null, base = null;
      const wsH = wsSince ? (now - wsSince) / 3600e3 : 0;
      const useAll = wsH >= 6; const inSet = (e) => useAll || e.v === 'gate';
      const hours = Math.floor(Math.min(useAll ? wsH : coverH, 48)) - 1;
      if (hours >= 6) { const b = new Array(hours).fill(0); let cur = 0; for (const e of es) { if (!inSet(e)) continue; if (e.t >= now - 3600e3) cur += e.usd; const k = Math.floor((now - 3600e3 - e.t) / 3600e3); if (k >= 0 && k < hours) b[k] += e.usd; } const m = b.reduce((x, y) => x + y, 0) / hours; const sd = Math.sqrt(b.reduce((x, y) => x + (y - m) ** 2, 0) / hours); base = { mean: m, sd, hours, venues: useAll ? 'all' : 'gate' }; if (sd > 0) z60 = (cur - m) / Math.max(sd, 1000); }
      const gb = gateBase[sym]; const g60 = w60.venues.gate || 0; const gz = gb && gb.sd > 0 ? (g60 - gb.mean) / gb.sd : null;
      const t = tok.get(sym); const oi = t?.oiUsd || null;
      const pctOI60 = oi ? w60.total / oi * 100 : null, pctOI15 = oi ? w15.total / oi * 100 : null;
      const zUse = z60 ?? gz;
      let level = null;
      if ((w15.total >= Math.max(250e3, oi ? oi * 0.0025 : 0) && (zUse == null || zUse >= 4)) || w60.total >= Math.max(1e6, oi ? oi * 0.01 : 0)) level = 'cascade';
      else if (w60.total >= Math.max(100e3, oi ? oi * 0.002 : 0) && (zUse == null || zUse >= 3)) level = 'elevated';
      const dom = w60.total ? (w60.long / w60.total >= 0.7 ? 'long' : w60.short / w60.total >= 0.7 ? 'short' : 'mixed') : null;
      const c60 = chg(sym, 60);
      let text = null;
      if (level) {
        text = `${fmtUsd(w60.total)} of ${sym} positions force-closed in the last hour (${fmtUsd(w15.total)} in 15 min${pctOI60 != null ? `, ${pctOI60.toFixed(2)}% of open interest` : ''}${zUse != null ? `, ${zUse.toFixed(1)}σ above its ${z60 != null ? 'own' : 'Gate hourly'} baseline` : ''}). `;
        text += dom === 'long' ? 'Mostly LONGS were liquidated: forced selling pushes price down, which can trigger more liquidations (a cascade).' : dom === 'short' ? 'Mostly SHORTS were liquidated: forced buying pushes price up (a short squeeze).' : 'Both sides were liquidated: violent two-way chop.';
        if (c60 != null) text += ` Price ${c60 >= 0 ? '+' : ''}${c60.toFixed(1)}% over the hour.`;
      }
      assets.push({ sym, level, dom, w5, w15, w60, w24: { long: w24.long, short: w24.short, total: w24.total, n: w24.n }, z60, base, gateZ: gz, gateBase: gb || null, oiUsd: oi, pctOI15, pctOI60, ch60: c60, ch24: t?.ch24 ?? null, fAnn: t?.fAnn ?? null, text });
    }
    assets.sort((a, b) => b.w60.total - a.w60.total || b.w24.total - a.w24.total);
    const mk = (mins) => events.filter((e) => e.t >= now - mins * 60e3).reduce((r, e) => { r[e.side] += e.usd; return r; }, { long: 0, short: 0 });
    const vstat = Object.fromEntries(Object.entries(venues).map(([k, v]) => {
      const ws = wsStatus[k] || {}; const n24 = events.filter((e) => e.v === k && e.t > now - 86400e3).length;
      let state = v.mode === 'none' ? 'unavailable' : ws.open ? (ws.liqs > 0 || n24 ? 'live' : 'connected, no liquidations received yet') : ws.error ? 'error' : 'connecting';
      if (k === 'binance' && ws.open && !(ws.liqs > 0)) state = 'connected via fstream /market/stream, no liquidations received yet';
      if (k === 'gate' && gateRestOk) state += ` · REST ${gateRestOk.ok ? 'ok' : 'error: ' + gateRestOk.error}`;
      if (k === 'okx' && okxRestOk) state += ` · REST ${okxRestOk.ok ? 'ok' : 'error: ' + okxRestOk.error}`;
      return [k, { ...v, state, wsLiqs: ws.liqs || 0, events24h: n24, error: ws.error || null }];
    }));
    summary = { generatedAt: now, coverageHours: +coverH.toFixed(1), events: events.length, venues: vstat, market: { m15: mk(15), m60: mk(60), h24: mk(1440) },
      flags: assets.filter((a) => a.level).map((a) => a.sym), assets: assets.slice(0, 200),
      rules: 'cascade: ≥ max($250K, 0.25% of OI) in 15 min with z ≥ 4 (or no baseline yet), or ≥ max($1M, 1% of OI) in 60 min · elevated: ≥ max($100K, 0.2% of OI) in 60 min with z ≥ 3 · z = last hour vs our own hourly history (Gate-only until the websockets have 6h, then all venues), else vs Gate hourly liquidation stats (7 days, Gate share only)' };
    return summary;
  }
  function persist() {
    try { fs.writeFileSync(evFile, JSON.stringify({ savedAt: Date.now(), events: events.slice(-60000) })); } catch {}
    try { fs.writeFileSync(path.join(DATA_DIR, 'liquidations.json'), JSON.stringify(summary)); } catch {}
  }
  function forSym(sym) { return summary.assets.find((a) => a.sym === sym) || null; }
  // composite factor: long-liquidation cascade in progress = crash risk (lower); short squeeze = mild plus
  function factor(sym) {
    const a = forSym(sym); if (!a || !summary.generatedAt) return null;
    if (!a.level) return { score: 52, value: a.w24.total ? `${fmtUsd(a.w24.total)} / 24h` : 'quiet', text: `No liquidation cascade on ${sym}: ${fmtUsd(a.w60.total)} liquidated in the last hour, ${fmtUsd(a.w24.total)} in 24h (${a.w24.n} orders across venues we can see).` };
    const s = a.dom === 'long' ? (a.level === 'cascade' ? 20 : 35) : a.dom === 'short' ? (a.level === 'cascade' ? 60 : 56) : 42;
    return { score: s, value: `${a.level} (${a.dom})`, text: a.text, warn: a.level === 'cascade' ? `Liquidation cascade: ${a.text.split('. ')[0]}` : null };
  }
  let started = false;
  function start() {
    if (started) return; started = true;
    const boot = async () => { await okxMeta(); startChild(); pollGate(); gateBaselines(); };
    setTimeout(boot, 15000); // after the first perp snapshot
    setInterval(() => { trackPrices(); analyze(); }, 30e3).unref();
    setInterval(persist, 60e3).unref();
    setInterval(pollGate, 2 * 60e3).unref();
    setInterval(pollOkx, 5 * 60e3).unref(); setTimeout(pollOkx, 40e3);
    setInterval(() => { if (Date.now() - gateBaseAt > 6 * 3600e3) gateBaselines(); startChild(); }, 30 * 60e3).unref();
  }
  return { start, analyze, snapshot: () => summary, forSym, factor, events: () => events };
}
module.exports = { createLiquidations };
