'use strict';
// Liquidation websocket collector (child process; started by lib/liquidations.js with `node --experimental-websocket`).
// Emits one JSON line per liquidation on stdout: {v, sym, contract, side: 'long'|'short' (the side that got liquidated), px, qty, usd, t}
// and status lines {status: {...}}. Free public streams only, no keys.
// Venues: Binance fstream !forceOrder@arr (opens from US boxes but delivers no data -> reported), OKX liquidation-orders (SWAP),
// Bybit allLiquidation.<SYMBOL> (public stream reachable even though Bybit REST is geo-blocked), Gate futures.public_liquidates (!all).
const SYMS = (process.env.LIQ_SYMS || 'BTC,ETH,SOL').split(',').filter(Boolean);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const st = {}; const stat = (v, k, val) => { st[v] = { ...(st[v] || {}), [k]: val, at: Date.now() }; };
const norm = (b) => { let m; if ((m = b.match(/^1000000(.+)$/))) return [m[1], 1e6]; if ((m = b.match(/^1000(.+)$/))) return [m[1], 1000]; return [b, 1]; };
let okxCtVal = {}; // instId -> contract value (coins per contract)
let gateQm = {};   // contract -> quanto multiplier

function connect(v, url, onOpen, onMsg, pingMs, pingMsg) {
  let ws, timer, alive = Date.now();
  const go = () => {
    try { ws = new WebSocket(url); } catch (e) { stat(v, 'error', e.message); return setTimeout(go, 30000); }
    ws.onopen = () => { stat(v, 'open', true); stat(v, 'msgs', st[v]?.msgs || 0); onOpen(ws); if (pingMs) timer = setInterval(() => { try { ws.send(typeof pingMsg === 'function' ? pingMsg() : pingMsg); } catch {} }, pingMs); };
    ws.onmessage = (m) => { alive = Date.now(); stat(v, 'msgs', (st[v]?.msgs || 0) + 1); try { onMsg(String(m.data)); } catch {} };
    ws.onerror = (e) => stat(v, 'error', e.message || 'ws error');
    ws.onclose = (e) => { stat(v, 'open', false); stat(v, 'closeCode', e.code); clearInterval(timer); setTimeout(go, 10000); };
  };
  go();
}
// Binance (USDT-M)
connect('binance', 'wss://fstream.binance.com/ws/!forceOrder@arr', () => {}, (s) => {
  const d = JSON.parse(s); const o = d.o; if (!o || !/USDT$/.test(o.s)) return;
  const [sym, mult] = norm(o.s.replace(/USDT$/, '')); const px = +o.ap || +o.p; const qty = +o.z || +o.q;
  stat('binance', 'liqs', (st.binance?.liqs || 0) + 1);
  out({ v: 'binance', sym, contract: o.s, side: o.S === 'SELL' ? 'long' : 'short', px: px / mult, qty: qty * mult, usd: px * qty, t: o.T });
});
// OKX
async function okxMeta() { try { const r = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP', { headers: { 'user-agent': 'Mozilla/5.0' } }); const d = await r.json(); for (const i of d.data || []) okxCtVal[i.instId] = +i.ctVal * (+i.ctMult || 1); } catch {} }
okxMeta();
connect('okx', 'wss://ws.okx.com/ws/v5/public', (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'liquidation-orders', instType: 'SWAP' }] })), (s) => {
  if (s === 'pong') return; const d = JSON.parse(s); if (!d.data) return;
  for (const r of d.data) { if (!/-USDT-SWAP$/.test(r.instId)) continue; const [sym, mult] = norm(r.instId.split('-')[0]); const cv = okxCtVal[r.instId] || 1;
    for (const x of r.details || []) { const px = +x.bkPx, qty = +x.sz * cv; stat('okx', 'liqs', (st.okx?.liqs || 0) + 1);
      out({ v: 'okx', sym, contract: r.instId, side: x.posSide === 'long' || (x.posSide === 'net' && x.side === 'sell') ? 'long' : 'short', px: px / mult, qty: qty * mult, usd: px * qty, t: +x.ts }); } }
}, 20000, 'ping');
// Bybit (public stream; REST is geo-blocked)
connect('bybit', 'wss://stream.bybit.com/v5/public/linear', (ws) => {
  const topics = []; for (const s of SYMS) { topics.push(`allLiquidation.${s}USDT`); if (['PEPE', 'BONK', 'SHIB', 'FLOKI', 'LUNC', 'XEC', 'SATS', 'RATS', 'CAT', 'MOG', 'TURBO', 'NEIROETH', 'BTT', 'WHY', 'X'].includes(s)) topics.push(`allLiquidation.1000${s}USDT`); }
  for (let i = 0; i < topics.length; i += 10) ws.send(JSON.stringify({ op: 'subscribe', args: topics.slice(i, i + 10) }));
}, (s) => {
  const d = JSON.parse(s); if (!d.topic || !Array.isArray(d.data)) return;
  for (const x of d.data) { const [sym, mult] = norm(x.s.replace(/USDT$/, '')); const px = +x.p, qty = +x.v; stat('bybit', 'liqs', (st.bybit?.liqs || 0) + 1);
    out({ v: 'bybit', sym, contract: x.s, side: x.S === 'Buy' ? 'long' : 'short', px: px / mult, qty: qty * mult, usd: px * qty, t: +x.T }); } // Bybit: S = side of the liquidated position
}, 20000, '{"op":"ping"}');
// Gate
async function gateMeta() { try { const r = await fetch('https://api.gateio.ws/api/v4/futures/usdt/contracts'); for (const c of await r.json()) gateQm[c.name] = +c.quanto_multiplier || 1; } catch {} }
gateMeta();
connect('gate', 'wss://fx-ws.gateio.ws/v4/ws/usdt', (ws) => ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.public_liquidates', event: 'subscribe', payload: ['!all'] })), (s) => {
  const d = JSON.parse(s); if (d.channel !== 'futures.public_liquidates' || d.event !== 'update') return;
  for (const x of d.result || []) { if (!/_USDT$/.test(x.contract)) continue; const [sym, mult] = norm(x.contract.replace(/_USDT$/, '')); const qm = gateQm[x.contract] || 1; const px = +x.price; const sz = +x.size; const qty = Math.abs(sz) * qm;
    stat('gate', 'liqs', (st.gate?.liqs || 0) + 1);
    out({ v: 'gate', sym, contract: x.contract, side: sz > 0 ? 'long' : 'short', px: px / mult, qty: qty * mult, usd: px * qty, t: x.time_ms || x.time * 1000 }); }
}, 20000, () => JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.ping' }));
setInterval(() => out({ status: st }), 30000);
process.stdin.on('end', () => process.exit(0)); process.stdin.resume();
