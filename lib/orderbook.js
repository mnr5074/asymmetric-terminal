'use strict';
// Order-book spoofing / thin-book detector (parent). Spawns lib/orderbook_ws.js (public L2 websockets: Binance spot+perps, OKX, Coinbase,
// Kraken, Hyperliquid) for a bounded token set: NEAR, ZEC, STRK, BTC, ETH, SOL + watchlist perps + the 4 most extreme funding flags (<= 14).
// Every detection and a control sample every 5 min per book is logged with forward mid returns (1/5/15/60 min) to data/orderbook_events.json,
// building an evaluation set; /api/orderbook reports detections, live book stats and the evaluation (events vs controls).
// Heuristic signals, not proof of manipulation. Not financial advice.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const PRIORITY = ['NEAR', 'ZEC', 'STRK', 'BTC', 'ETH', 'SOL'];
const med = (a) => { const s = a.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const ncdf = (z) => 0.5 * (1 + Math.sign(z) * Math.sqrt(1 - Math.exp(-2 * z * z / Math.PI))); // approx
function mw(a, b) {
  a = a.filter((x) => x != null); b = b.filter((x) => x != null); const n1 = a.length, n2 = b.length; if (n1 < 5 || n2 < 5) return null;
  const all = [...a.map((v) => [v, 0]), ...b.map((v) => [v, 1])].sort((x, y) => x[0] - y[0]); let r1 = 0, i = 0;
  while (i < all.length) { let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++; for (let k = i; k <= j; k++) if (all[k][1] === 0) r1 += (i + j) / 2 + 1; i = j + 1; }
  const u = r1 - n1 * (n1 + 1) / 2; const sd = Math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12); const z = (u - n1 * n2 / 2) / sd;
  return { n1, n2, auc: +(u / (n1 * n2)).toFixed(3), p: +(2 * (1 - ncdf(Math.abs(z)))).toFixed(4) };
}
const EXPLAIN = {
  spoof_wall: 'A very large resting order (≥ 8× the typical level and ≥ 10% of that side\'s visible depth within 5%) appeared and was cancelled within a minute without being traded and without price reaching it. Classic spoofing looks like this: a fake wall that scares the other side, pulled before it can fill. Market makers also do it legitimately, so treat it as a hint.',
  wall_pulled: 'A large wall that rested for more than a minute was cancelled (not filled) before price reached it.',
  pulled_before_move: 'A wall at least 0.5% away was pulled and, within a minute, price moved at least halfway toward where it stood: the wall was holding price back (or advertising a level), then got out of the way.',
  churn: 'Within one minute, far more size was placed and cancelled near the price (±2%) than actually traded (cancel-to-trade ratio ≥ 30 and ≥ 3σ above this book\'s norm): order-book noise that can mislead depth readers.',
  thin_book: 'Visible depth within ±1% of the price fell to less than half of its 30-minute median (≥ 3σ drop): the book is thin, so a modest order can move price a lot. Liquidity often disappears just before sharp moves.',
};

function createOrderbook({ DATA_DIR, perps, log = () => {} }) {
  const evFile = path.join(DATA_DIR, 'orderbook_events.json');
  let done = []; try { done = JSON.parse(fs.readFileSync(evFile, 'utf8')).events || []; } catch {}
  let live = [], status = {}, booksInfo = [], child = null, childSyms = '', startedAt = null;
  function symbols() {
    const s = new Set(PRIORITY);
    try { const w = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'perps_watch.json'), 'utf8')); const list = Array.isArray(w) ? w : Array.isArray(w.tokens) ? w.tokens : Object.keys(w); for (const x of list) { const sym = String(x.sym || x).toUpperCase(); if (/^[A-Z0-9]{2,10}$/.test(sym) && s.size < 10) s.add(sym); } } catch {}
    const fl = (perps.snapshot().tokens || []).filter((t) => t.flags?.length && /^[A-Z0-9]{2,10}$/.test(t.sym)).sort((a, b) => Math.abs(b.fAnn) - Math.abs(a.fAnn)).slice(0, 4);
    for (const t of fl) if (s.size < 14) s.add(t.sym);
    return [...s].join(',');
  }
  function startChild() {
    const syms = symbols(); if (child && syms === childSyms) return;
    if (child) { try { child.kill(); } catch {} }
    childSyms = syms; startedAt = Date.now();
    child = spawn(process.execPath, ['--experimental-websocket', '--no-warnings', path.join(__dirname, 'orderbook_ws.js')], { env: { ...process.env, OB_SYMS: syms }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(line);
      if (o.status) { status = o.status; booksInfo = o.books; } else if (o.live) { live.push(o.live); if (live.length > 400) live.shift(); } else if (o.done) { done.push(o.done); if (done.length > 30000) done.splice(0, done.length - 30000); const l = live.find((x) => x.id === o.done.id); if (l) l.fwd = o.done.fwd; } } catch {} } });
    child.on('exit', () => { child = null; setTimeout(startChild, 15000); });
    log(`[orderbook] L2 collector started for ${syms}`);
  }
  // hypothesis sign per type: positive = moved the way the signal suggests
  const signed = (e, r) => (r == null ? null : e.type === 'spoof_wall' || e.type === 'wall_pulled' || e.type === 'pulled_before_move' ? (e.side === 'bid' ? -r : r) : r);
  function evaluate() {
    const ctrl = done.filter((e) => e.type === 'control');
    const types = ['spoof_wall', 'wall_pulled', 'pulled_before_move', 'churn', 'thin_book'];
    const ev = {};
    for (const t of types) {
      const E = done.filter((e) => e.type === t); const r = { n: E.length };
      for (const m of [1, 5, 15, 60]) {
        const a = E.map((e) => e.fwd?.[m]).filter((x) => x != null); const c = ctrl.map((e) => e.fwd?.[m]).filter((x) => x != null);
        r['abs' + m] = { median: med(a.map(Math.abs)), ctrlMedian: med(c.map(Math.abs)), mw: mw(a.map(Math.abs), c.map(Math.abs)) };
        if (t !== 'churn' && t !== 'thin_book') { const sg = E.map((e) => signed(e, e.fwd?.[m])).filter((x) => x != null); r['signed' + m] = { median: med(sg), hit: sg.length ? +(sg.filter((x) => x > 0).length / sg.length * 100).toFixed(1) : null, n: sg.length }; }
      }
      ev[t] = r;
    }
    return { controls: ctrl.length, byType: ev, note: 'abs = median |mid move| after the event vs control samples (random 5-min samples on the same books); signed = move in the direction the signal implies (pulled bid wall -> down, pulled ask wall -> up), hit = share positive. Small n early on: wait for hundreds of events before trusting.' };
  }
  let summary = {};
  function analyze() {
    const now = Date.now();
    const recent = live.filter((e) => e.t > now - 6 * 3600e3);
    const by = {}; for (const e of recent) { const k = e.sym; (by[k] || (by[k] = { sym: k, spoof_wall: 0, wall_pulled: 0, pulled_before_move: 0, churn: 0, thin_book: 0, venues: {} }))[e.type]++; by[k].venues[e.venue] = (by[k].venues[e.venue] || 0) + 1; }
    let hist = null; try { hist = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'orderbook_history.json'), 'utf8')); delete hist.sample_thin; } catch {}
    summary = { generatedAt: now, symbols: childSyms.split(','), runningMin: startedAt ? Math.round((now - startedAt) / 60e3) : 0, status, books: booksInfo,
      detections: recent.slice(-150).reverse().map((e) => ({ ...e, explain: EXPLAIN[e.type] })), perToken6h: Object.values(by), evaluation: evaluate(), explain: EXPLAIN,
      venuesNotUsed: { gate: 'public spot.order_book works (verified) but not wired to keep the collector bounded', dex: 'Raydium/Orca CLMM tick liquidity needs on-chain RPC tick-array reads (not wired); DEX depth is not covered', 'binance-futures depth': 'top-20 snapshots only (fstream /public path)', bybit: 'REST geo-blocked' },
      history: hist };
    return summary;
  }
  function persist() { try { fs.writeFileSync(evFile, JSON.stringify({ savedAt: Date.now(), events: done })); fs.writeFileSync(path.join(DATA_DIR, 'orderbook.json'), JSON.stringify({ ...summary, history: undefined })); } catch {} }
  let started = false;
  function start() { if (started) return; started = true; setTimeout(startChild, 20000); setInterval(() => { try { analyze(); } catch (e) { log(`[orderbook] ${e.message}`); } }, 30e3).unref(); setInterval(persist, 120e3).unref(); setInterval(startChild, 6 * 3600e3).unref(); }
  return { start, snapshot: () => summary, analyze };
}
module.exports = { createOrderbook };
