'use strict';
// Order-book spoofing / thin-book detector: websocket child process (started by lib/orderbook.js with `node --experimental-websocket`).
// Bounded: OB_SYMS (priority + watchlist + top perp flags, <= 14). Public L2 feeds, no keys:
//   Binance spot  data-stream.binance.vision  <sym>usdt@depth20@100ms + @trade   (top-20 snapshots every 100 ms)
//   Binance perps fstream.binance.com/public/stream depth20@100ms + /market/stream aggTrade (the /ws path is silent for trades from US)
//   OKX spot      ws.okx.com books (400-level diffs) + trades
//   Coinbase      ws-feed.exchange.coinbase.com level2_batch + matches (USD)
//   Kraken        ws.kraken.com/v2 book depth 100 + trade (USD)
//   Hyperliquid   api.hyperliquid.xyz/ws l2Book (20 levels) + trades
// Per book we track every price level within ±5 % of mid: when size drops, the part matched by trades at that price (last 3 s) is a fill,
// the rest a cancel. Events (stdout JSON lines): spoof_wall, wall_pulled, pulled_before_move, churn, thin_book, plus control samples,
// each with forward mid returns at 1/5/15/60 min once available. Model heuristics, not proof of manipulation; not financial advice.
const SYMS = (process.env.OB_SYMS || 'BTC,ETH,SOL,NEAR,ZEC,STRK').split(',').filter(Boolean);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const status = {};
const books = new Map();
let seq = 0;
const med = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

function getBook(venue, sym, snapFeed) {
  const k = venue + ':' + sym; let b = books.get(k);
  if (!b) { b = { k, venue, sym, snapFeed, bids: new Map(), asks: new Map(), trades: [], lv: new Map(), cancelN: 0, tradeN: 0, churnH: [], depthH: [], mids: [], pending: [], lastThin: 0, lastCtrl: 0, lastScan: 0, updates: 0, lastChurn: Date.now(), created: Date.now(), cool: {} }; books.set(k, b); }
  return b;
}
function mid(b) { let bb = 0, ba = Infinity; for (const p of b.bids.keys()) if (+p > bb) bb = +p; for (const p of b.asks.keys()) if (+p < ba) ba = +p; return bb && ba < Infinity && ba > bb ? (bb + ba) / 2 : null; }
function trade(b, px, qty) { const t = Date.now(); b.trades.push([t, px, qty]); while (b.trades.length && b.trades[0][0] < t - 3000) b.trades.shift(); b.tradeN += px * qty; }
function consume(b, px, want) { let got = 0; for (const tr of b.trades) { if (got >= want) break; if (tr[2] > 0 && Math.abs(tr[1] / px - 1) < 2e-4) { const u = Math.min(tr[2], want - got); tr[2] -= u; got += u; } } return got; }
function change(b, side, pStr, sz, m) {
  const map = side === 'bid' ? b.bids : b.asks; const old = map.get(pStr) || 0; const px = +pStr;
  if (sz > 0) map.set(pStr, sz); else map.delete(pStr);
  if (!m || Math.abs(px / m - 1) > 0.05) return;
  const key = side + '|' + pStr; let L = b.lv.get(key);
  if (!L && sz > 0) { L = { t0: Date.now(), max: sz, filled: 0, cancelled: 0, wall: false }; b.lv.set(key, L); }
  if (!L) return;
  if (sz > L.max) L.max = sz;
  const d = sz - old;
  if (d < 0) { const f = consume(b, px, -d); L.filled += f; L.cancelled += -d - f; if (Math.abs(px / m - 1) <= 0.02) b.cancelN += (-d - f) * px; }
  if (L.wall && sz < 0.2 * L.max) wallGone(b, side, px, L, m);
  if (sz <= 0) b.lv.delete(key);
}
function emit(b, type, extra) {
  const m = mid(b); if (!m) return;
  const e = { id: `${b.k}:${Date.now()}:${++seq}`, t: Date.now(), venue: b.venue, sym: b.sym, type, mid: m, ...extra, fwd: {} };
  if (type !== 'control') out({ live: e });
  b.pending.push(e);
}
function wallGone(b, side, px, L, m) {
  L.wall = false;
  const life = (Date.now() - L.wallAt) / 1000; const fillShare = L.filled / L.max; const dist = (px / m - 1) * 100;
  if (fillShare >= 0.2 || Math.abs(dist) < 0.1) return; // filled or price reached it: not a pulled wall
  if (life < 1.5 || Date.now() - b.created < 60e3) return; // sub-second flicker / warm-up
  const base = { side, price: px, usd: Math.round(L.max * px), distPct: +dist.toFixed(3), lifeSec: +life.toFixed(1), fillShare: +fillShare.toFixed(3), xMedian: L.xMed, shareOfSide: L.share };
  // re-quote check 3 s later: a market maker moving the same size to a nearby price (±0.15 %) is not a pulled wall
  setTimeout(() => {
    const map = side === 'bid' ? b.bids : b.asks;
    for (const [p, sz] of map) if (Math.abs(+p / px - 1) <= 0.0015 && sz >= 0.5 * L.max) { b.requotes = (b.requotes || 0) + 1; return; }
    const k = side + (life < 60 ? 's' : 'p'); if (Date.now() - (b.cool[k] || 0) < 30e3) return; b.cool[k] = Date.now();
    emit(b, life < 60 ? 'spoof_wall' : 'wall_pulled', base);
  }, 3000);
  if (Math.abs(dist) >= 0.5) { const t = Date.now(); if (Date.now() - (b.cool.pm || 0) < 60e3) return; b.cool.pm = Date.now(); setTimeout(() => { const m2 = mid(b); if (!m2) return; const moved = (m2 / m - 1) * 100; const toward = side === 'bid' ? -moved : moved; if (toward >= Math.abs(dist) * 0.5) emit(b, 'pulled_before_move', { ...base, movedPct: +moved.toFixed(3), afterSec: Math.round((Date.now() - t) / 1000) }); }, 60e3); }
}
function scan(b) {
  const now = Date.now(); const m = mid(b); if (!m) return;
  if (now - b.lastScan >= 1000) {
    b.lastScan = now;
    for (const [side, map] of [['bid', b.bids], ['ask', b.asks]]) {
      const lv = []; let tot = 0;
      for (const [p, s] of map) { const px = +p; if (Math.abs(px / m - 1) <= 0.05) { const n = px * s; lv.push([p, n]); tot += n; } }
      if (lv.length < 5) continue;
      const md = med(lv.map((x) => x[1]));
      for (const [p, n] of lv) {
        const L = b.lv.get(side + '|' + p); if (!L || L.wall) continue;
        if (n >= 8 * md && n >= 0.1 * tot && n >= 20e3) { L.wall = true; L.wallAt = now; L.xMed = +(n / md).toFixed(1); L.share = +(n / tot).toFixed(3); }
      }
    }
  }
  if (!b.mids.length || now - b.mids[b.mids.length - 1][0] >= 5000) {
    b.mids.push([now, m]); while (b.mids.length && b.mids[0][0] < now - 70 * 60e3) b.mids.shift();
    // depth within 1 % (both sides), every 10 s
    if (b.mids.length % 2 === 0) {
      let d = 0; for (const [p, s] of b.bids) if (+p >= m * 0.99) d += +p * s; for (const [p, s] of b.asks) if (+p <= m * 1.01) d += +p * s;
      const H = b.depthH; if (H.length >= 90) { const L = H.map((x) => Math.log(Math.max(x, 1))); const mu = L.reduce((x, y) => x + y, 0) / L.length; const sd = Math.sqrt(L.reduce((x, y) => x + (y - mu) ** 2, 0) / L.length) || 1e-9; const z = (Math.log(Math.max(d, 1)) - mu) / sd; const mdd = med(H);
        if (z <= -3 && d < 0.5 * mdd && now - b.lastThin > 10 * 60e3) { b.lastThin = now; emit(b, 'thin_book', { depth1pctUsd: Math.round(d), baselineUsd: Math.round(mdd), z: +z.toFixed(2), ratio: +(d / mdd).toFixed(3) }); } }
      H.push(d); if (H.length > 180) H.shift(); b.depth1 = d;
    }
    if (now - b.lastCtrl >= 5 * 60e3) { b.lastCtrl = now; emit(b, 'control', {}); }
  }
  if (now - b.lastChurn >= 60e3) {
    const ratio = b.cancelN / (b.tradeN + 1); const H = b.churnH;
    if (H.length >= 10) { const L = H.map((x) => Math.log1p(x)); const mu = L.reduce((x, y) => x + y, 0) / L.length; const sd = Math.sqrt(L.reduce((x, y) => x + (y - mu) ** 2, 0) / L.length) || 1e-9; const z = (Math.log1p(ratio) - mu) / sd;
      if (ratio >= 30 && z >= 3 && b.cancelN >= 100e3) emit(b, 'churn', { cancelUsd: Math.round(b.cancelN), tradeUsd: Math.round(b.tradeN), ratio: +ratio.toFixed(1), z: +z.toFixed(2) }); }
    b.lastStats = { cancelUsd: Math.round(b.cancelN), tradeUsd: Math.round(b.tradeN), ratio: +ratio.toFixed(1) };
    H.push(ratio); if (H.length > 60) H.shift(); b.cancelN = 0; b.tradeN = 0; b.lastChurn = now;
  }
  // forward returns for pending events
  for (const e of b.pending) for (const mins of [1, 5, 15, 60]) {
    if (e.fwd[mins] != null || now < e.t + mins * 60e3) continue;
    const x = b.mids.find((p) => p[0] >= e.t + mins * 60e3); if (x) e.fwd[mins] = +((x[1] / e.mid - 1) * 100).toFixed(4);
  }
  b.pending = b.pending.filter((e) => { if (e.fwd[60] != null || now > e.t + 75 * 60e3) { out({ done: e }); return false; } return true; });
}
function snapshot(b, bids, asks) {
  // replace the book; levels that vanished INSIDE the covered price range count as size 0 (cancel/fill), outside the range are simply dropped
  const m = mid(b) || (bids.length && asks.length ? (+bids[0][0] + +asks[0][0]) / 2 : null);
  const nb = new Map(bids.map(([p, s]) => [String(+p), +s])), na = new Map(asks.map(([p, s]) => [String(+p), +s]));
  const lowB = Math.min(...[...nb.keys()].map(Number)), highA = Math.max(...[...na.keys()].map(Number));
  for (const p of [...b.bids.keys()]) if (!nb.has(p) && +p >= lowB) change(b, 'bid', p, 0, m); else if (!nb.has(p)) { b.bids.delete(p); b.lv.delete('bid|' + p); }
  for (const p of [...b.asks.keys()]) if (!na.has(p) && +p <= highA) change(b, 'ask', p, 0, m); else if (!na.has(p)) { b.asks.delete(p); b.lv.delete('ask|' + p); }
  for (const [p, s] of nb) if (b.bids.get(p) !== s) change(b, 'bid', p, s, m);
  for (const [p, s] of na) if (b.asks.get(p) !== s) change(b, 'ask', p, s, m);
  b.updates++; scan(b);
}
function diff(b, list, m0) { const m = m0 || mid(b); for (const [side, p, s] of list) change(b, side, String(+p), +s, m); b.updates++; scan(b); }

function connect(v, url, onOpen, onMsg, pingMs, pingMsg) {
  let timer;
  const go = () => {
    let ws; try { ws = new WebSocket(url); } catch (e) { status[v] = { error: e.message }; return setTimeout(go, 30000); }
    ws.onopen = () => { status[v] = { ...(status[v] || {}), open: true }; onOpen(ws); if (pingMs) timer = setInterval(() => { try { ws.send(pingMsg); } catch {} }, pingMs); };
    ws.onmessage = (m) => { status[v].msgs = (status[v].msgs || 0) + 1; try { onMsg(String(m.data)); } catch {} };
    ws.onerror = (e) => { status[v] = { ...(status[v] || {}), error: e.message || 'ws error' }; };
    ws.onclose = () => { status[v] = { ...(status[v] || {}), open: false }; clearInterval(timer); for (const b of books.values()) if (b.venue === v) { b.bids.clear(); b.asks.clear(); b.lv.clear(); } setTimeout(go, 10000); };
  };
  go();
}
const lc = SYMS.map((s) => s.toLowerCase());
connect('binance-spot', `wss://data-stream.binance.vision/stream?streams=${lc.map((s) => `${s}usdt@depth20@100ms/${s}usdt@trade`).join('/')}`, () => {}, (s) => {
  const d = JSON.parse(s); const sym = d.stream.split('usdt@')[0].toUpperCase(); const b = getBook('binance-spot', sym, true);
  if (d.stream.endsWith('@trade')) trade(b, +d.data.p, +d.data.q); else snapshot(b, d.data.bids, d.data.asks);
});
connect('binance-perp', `wss://fstream.binance.com/public/stream?streams=${lc.map((s) => `${s}usdt@depth20@100ms`).join('/')}`, () => {}, (s) => {
  const d = JSON.parse(s); const sym = d.stream.split('usdt@')[0].toUpperCase(); snapshot(getBook('binance-perp', sym, true), d.data.b, d.data.a);
});
connect('binance-perp-trades', `wss://fstream.binance.com/market/stream?streams=${lc.map((s) => `${s}usdt@aggTrade`).join('/')}`, () => {}, (s) => {
  const d = JSON.parse(s); const sym = d.stream.split('usdt@')[0].toUpperCase(); trade(getBook('binance-perp', sym, true), +d.data.p, +d.data.q);
});
connect('okx', 'wss://ws.okx.com/ws/v5/public', (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: SYMS.flatMap((s) => [{ channel: 'books', instId: `${s}-USDT` }, { channel: 'trades', instId: `${s}-USDT` }]) })), (s) => {
  if (s === 'pong') return; const d = JSON.parse(s); if (!d.data || !d.arg) return; const sym = d.arg.instId.split('-')[0]; const b = getBook('okx', sym, false);
  if (d.arg.channel === 'trades') { for (const t of d.data) trade(b, +t.px, +t.sz); return; }
  const x = d.data[0]; if (d.action === 'snapshot') { b.bids.clear(); b.asks.clear(); b.lv.clear(); for (const [p, q] of x.bids) b.bids.set(String(+p), +q); for (const [p, q] of x.asks) b.asks.set(String(+p), +q); return; }
  diff(b, [...x.bids.map(([p, q]) => ['bid', p, q]), ...x.asks.map(([p, q]) => ['ask', p, q])]);
}, 20000, 'ping');
(async () => {
  let prods = new Set(); try { const r = await fetch('https://api.exchange.coinbase.com/products', { headers: { 'user-agent': 'Mozilla/5.0' } }); prods = new Set((await r.json()).filter((p) => p.quote_currency === 'USD' && p.status === 'online').map((p) => p.base_currency)); } catch {}
  const ids = SYMS.filter((s) => prods.has(s)).map((s) => `${s}-USD`);
  if (ids.length) connect('coinbase', 'wss://ws-feed.exchange.coinbase.com', (ws) => ws.send(JSON.stringify({ type: 'subscribe', product_ids: ids, channels: ['level2_batch', 'matches'] })), (s) => {
    const d = JSON.parse(s); if (!d.product_id) return; const b = getBook('coinbase', d.product_id.split('-')[0], false);
    if (d.type === 'snapshot') { b.bids.clear(); b.asks.clear(); b.lv.clear(); for (const [p, q] of d.bids) b.bids.set(String(+p), +q); for (const [p, q] of d.asks) b.asks.set(String(+p), +q); }
    else if (d.type === 'l2update') diff(b, d.changes.map(([sd, p, q]) => [sd === 'buy' ? 'bid' : 'ask', p, q]));
    else if (d.type === 'match' || d.type === 'last_match') trade(b, +d.price, +d.size);
  });
  const ksym = SYMS.map((s) => (s === 'BTC' ? 'BTC' : s) + '/USD');
  connect('kraken', 'wss://ws.kraken.com/v2', (ws) => { ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'book', symbol: ksym, depth: 100 } })); ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'trade', symbol: ksym } })); }, (s) => {
    const d = JSON.parse(s); if (!d.data || !d.channel) return;
    for (const x of d.data) { const sym = String(x.symbol || '').split('/')[0]; if (!sym) continue; const b = getBook('kraken', sym, false);
      if (d.channel === 'trade') { trade(b, +x.price, +x.qty); continue; }
      if (d.channel !== 'book') continue;
      if (d.type === 'snapshot') { b.bids.clear(); b.asks.clear(); b.lv.clear(); for (const l of x.bids) b.bids.set(String(+l.price), +l.qty); for (const l of x.asks) b.asks.set(String(+l.price), +l.qty); continue; }
      diff(b, [...x.bids.map((l) => ['bid', l.price, l.qty]), ...x.asks.map((l) => ['ask', l.price, l.qty])]);
      // keep depth 100 (Kraken expects the client to truncate)
      for (const [map, asc] of [[b.bids, false], [b.asks, true]]) if (map.size > 100) { const ks = [...map.keys()].map(Number).sort((p, q) => (asc ? p - q : q - p)); for (const p of ks.slice(100)) map.delete(String(p)); }
    }
  }, 30000, JSON.stringify({ method: 'ping' }));
})();
connect('hyperliquid', 'wss://api.hyperliquid.xyz/ws', (ws) => { for (const s of SYMS) { ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin: s } })); ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: s } })); } }, (s) => {
  const d = JSON.parse(s);
  if (d.channel === 'l2Book') { const b = getBook('hyperliquid', d.data.coin, true); snapshot(b, d.data.levels[0].map((l) => [l.px, l.sz]), d.data.levels[1].map((l) => [l.px, l.sz])); }
  else if (d.channel === 'trades') for (const t of d.data) trade(getBook('hyperliquid', t.coin, true), +t.px, +t.sz);
}, 30000, JSON.stringify({ method: 'ping' }));
setInterval(() => out({ status, books: [...books.values()].map((b) => ({ k: b.k, venue: b.venue, sym: b.sym, mid: mid(b), levels: b.bids.size + b.asks.size, depth1pctUsd: b.depth1 ? Math.round(b.depth1) : null, updates: b.updates, minute: b.lastStats || null, walls: [...b.lv.entries()].filter(([, L]) => L.wall).map(([k, L]) => ({ side: k.split('|')[0], price: +k.split('|')[1], usd: Math.round(L.max * +k.split('|')[1]), ageSec: Math.round((Date.now() - L.wallAt) / 1000), xMedian: L.xMed })).slice(0, 6), requotes: b.requotes || 0 })) }), 15000);
process.stdin.on('end', () => process.exit(0)); process.stdin.resume();
