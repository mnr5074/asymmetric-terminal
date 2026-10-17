'use strict';
// Live "Now" price for pick cards (Martin, Oct 2026). GET /api/liveprice?k=<key>,<key>,... (max 200 keys per call).
// The page asks for every pick card it renders, on every load/refresh, so 'Now' is never the frozen snapshot price (RENDER_LITE).
// Keys come from lib/firstseen.js (`_fs.lk`):
//   d:<chain>:<address>   on-chain token  -> DexScreener /tokens/v1 (30 per call, deepest-liquidity pair), GeckoTerminal simple token_price fallback
//   b:<SYM>               Binance coin    -> Binance spot SYMUSDT (data-api.binance.vision public mirror), then USDT-M perp, Hyperliquid mid, Gate.io
//   p:<SYM>               perp            -> Binance USDT-M perp, then Hyperliquid mid, Gate.io USDT perp, Binance spot, Gate.io spot
//   c:<coingecko id>:<SYM> large cap      -> CoinGecko simple/price (100 ids per call), Binance spot fallback
//   o:<OCC contract>      option          -> CBOE delayed quotes (free, ~15 min delayed) mid of bid/ask; else 'live price unavailable'
//   x:<Derive instrument> crypto option   -> Derive public get_tickers (one call per currency+expiry), mid of bid/ask else mark
// Free keyless sources only. Results cached 30 s per key; identical concurrent lookups share one upstream request.
const { CHAINS, validAddr } = require('./chains');
const TTL = 30e3, MAX_KEYS = 200, OPT_MAX_NEW = 8; // CBOE chains are a few MB each: at most 8 uncached underlyings per call (the page only asks for option cards on screen)
const cache = new Map(); // key -> { v: {p, src, at} | {err}, t }
const shared = new Map(); // upstream id -> { t, p: Promise } (whole-market lists + CBOE chains)
const UA = { 'user-agent': 'asymmetric-terminal/1.0 (+read-only dashboard)', accept: 'application/json' };
const getJSON = async (url, opt = {}, ms = 12000) => { const r = await fetch(url, { ...opt, headers: { ...UA, ...(opt.headers || {}) }, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`HTTP ${r.status} ${new URL(url).host}`); return r.json(); };
const once = (id, ttl, fn) => { const h = shared.get(id); if (h && Date.now() - h.t < ttl) return h.p; const p = fn().catch((e) => { shared.delete(id); throw e; }); shared.set(id, { t: Date.now(), p }); return p; };
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const pos = (v) => (+v > 0 && isFinite(+v) ? +v : null);

// whole-market price lists (one request each, shared by every key)
const bnSpot = () => once('bn:spot', TTL, async () => new Map((await getJSON('https://data-api.binance.vision/api/v3/ticker/price')).map((x) => [x.symbol, +x.price])));
const bnFut = () => once('bn:fut', TTL, async () => {
  let d; try { d = await getJSON('https://fapi.binance.com/fapi/v1/ticker/price', {}, 8000); } catch { d = await getJSON('https://www.binance.com/fapi/v1/ticker/price'); } // fapi is US geo-blocked (451); www mirror serves the same data
  return new Map(d.map((x) => [x.symbol, +x.price]));
});
const hlMids = () => once('hl:mids', TTL, async () => { const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { ...UA, 'content-type': 'application/json' }, body: '{"type":"allMids"}', signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error('HTTP ' + r.status + ' hyperliquid'); return new Map(Object.entries(await r.json()).map(([k, v]) => [k, +v])); });
const gateFut = () => once('gate:fut', TTL, async () => new Map((await getJSON('https://api.gateio.ws/api/v4/futures/usdt/tickers')).map((x) => [x.contract, +x.last])));
const gateSpot = () => once('gate:spot', TTL, async () => new Map((await getJSON('https://api.gateio.ws/api/v4/spot/tickers')).map((x) => [x.currency_pair, +x.last])));
const tryList = async (fns) => { for (const [src, f] of fns) { try { const p = pos(await f()); if (p) return { p, src }; } catch {} } return null; };
const spotOf = (s) => bnSpot().then((m) => m.get(s + 'USDT') ?? m.get(s + 'USDC') ?? m.get(s + 'FDUSD'));
const futOf = (s) => bnFut().then((m) => m.get(s + 'USDT') ?? m.get('1000' + s + 'USDT') / 1000);
const hlOf = (s) => hlMids().then((m) => m.get(s) ?? m.get('k' + s) / 1000);
const gfOf = (s) => gateFut().then((m) => m.get(s + '_USDT')), gsOf = (s) => gateSpot().then((m) => m.get(s + '_USDT'));
const P = {
  b: (s) => [['Binance spot', () => spotOf(s)], ['Binance perp', () => futOf(s)], ['Hyperliquid', () => hlOf(s)], ['Gate.io spot', () => gsOf(s)], ['Gate.io perp', () => gfOf(s)]],
  p: (s) => [['Binance perp', () => futOf(s)], ['Hyperliquid', () => hlOf(s)], ['Gate.io perp', () => gfOf(s)], ['Binance spot', () => spotOf(s)], ['Gate.io spot', () => gsOf(s)]],
};

async function dexBatch(chain, addrs, out) {
  const want = new Map(addrs.map((a) => [CHAINS[chain].kind === 'evm' ? a.toLowerCase() : a, a]));
  for (const c of chunk(addrs, 30)) {
    try {
      const pairs = await getJSON(`https://api.dexscreener.com/tokens/v1/${chain}/${c.join(',')}`);
      const best = new Map();
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const ba = String(p.baseToken?.address || ''); const k = want.has(ba) ? ba : want.has(ba.toLowerCase()) ? ba.toLowerCase() : null;
        if (!k || !pos(p.priceUsd)) continue; const liq = +(p.liquidity?.usd || 0); const b = best.get(k); if (!b || liq > b.liq) best.set(k, { liq, p: +p.priceUsd });
      }
      for (const [k, b] of best) out[`d:${chain}:${want.get(k)}`] = { p: b.p, src: 'DexScreener' };
    } catch {}
  }
  const miss = addrs.filter((a) => !out[`d:${chain}:${a}`]); const net = CHAINS[chain].gt;
  for (const c of chunk(miss, 30)) {
    try {
      const d = await getJSON(`https://api.geckoterminal.com/api/v2/simple/networks/${net}/token_price/${c.join(',')}`);
      const tp = d?.data?.attributes?.token_prices || {}; const low = Object.fromEntries(Object.entries(tp).map(([k, v]) => [k.toLowerCase(), v]));
      for (const a of c) { const p = pos(tp[a] ?? low[a.toLowerCase()]); if (p) out[`d:${chain}:${a}`] = { p, src: 'GeckoTerminal' }; }
    } catch {}
  }
}
async function cgBatch(items, out) { // items: [key, id, SYM]
  for (const c of chunk(items, 100)) {
    let d = {}; try { d = await getJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${c.map((x) => encodeURIComponent(x[1])).join(',')}&vs_currencies=usd`); } catch {}
    for (const [k, id, s] of c) { const p = pos(d?.[id]?.usd); if (p) out[k] = { p, src: 'CoinGecko' }; else if (s) { const r = await tryList(P.b(s)); if (r) out[k] = r; } }
  }
}
const occRe = /^([A-Z][A-Z.]{0,5})(\d{6})([CP])(\d{8})$/;
const cboeChain = (u) => once('cboe:' + u, TTL, async () => {
  const d = await getJSON(`https://cdn-api.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(u)}.json`, {}, 20000);
  const m = new Map(); for (const o of d?.data?.options || []) { const bid = +o.bid, ask = +o.ask; const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : pos(o.last_trade_price); if (mid) m.set(o.option, mid); }
  return { m, asOf: d.timestamp || null }; // CBOE timestamp is US/Eastern wall time
});
async function optBatch(keys, out) {
  const by = new Map(); for (const k of keys) { const id = k.slice(2); const m = occRe.exec(id); if (!m) { out[k] = { err: 'not an OCC contract id' }; continue; } (by.get(m[1]) || by.set(m[1], []).get(m[1])).push([k, id]); }
  let fresh = 0; const us = [...by.keys()];
  const run = async (u) => {
    const cached = shared.get('cboe:' + u); const isNew = !cached || Date.now() - cached.t >= TTL;
    if (isNew && ++fresh > OPT_MAX_NEW) { for (const [k] of by.get(u)) out[k] = { err: 'busy', retry: 1 }; return; }
    try { const { m, asOf } = await cboeChain(u); for (const [k, id] of by.get(u)) { const p = m.get(id); out[k] = p ? { p, src: 'CBOE delayed (~15 min)', quoteAsOf: asOf ? asOf + ' ET' : null } : { err: 'contract not quoted' }; } }
    catch (e) { for (const [k] of by.get(u)) out[k] = { err: 'CBOE quote unavailable' }; }
  };
  for (const c of chunk(us, 2)) await Promise.all(c.map(run)); // 2 at a time: each chain is a few MB of JSON
}

const drvRe = /^([A-Z0-9]{2,10})-(\d{8})-([\d_]+)-([CP])$/;
const drvChain = (cur, exp) => once(`drv:${cur}:${exp}`, TTL, async () => {
  const r = await fetch('https://api.derive.xyz/v3/public/get_tickers', { method: 'POST', headers: { ...UA, 'content-type': 'application/json' }, body: JSON.stringify({ instrument_type: 'option', currency: cur, expiry_date: exp }), signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' derive'); const t = (await r.json())?.result?.tickers || {};
  const m = new Map(); for (const [id, x] of Object.entries(t)) { const b = +x.b, a = +x.a; const mid = b > 0 && a > 0 ? (b + a) / 2 : pos(x.M); if (mid) m.set(id, mid); } return m;
});
async function drvBatch(keys, out) {
  const by = new Map(); for (const k of keys) { const m = drvRe.exec(k.slice(2)); if (!m) { out[k] = { err: 'bad instrument' }; continue; } const g = m[1] + ':' + m[2]; (by.get(g) || by.set(g, []).get(g)).push(k); }
  await Promise.all([...by].slice(0, 20).map(async ([g, ks]) => { const [cur, exp] = g.split(':'); try { const m = await drvChain(cur, exp); for (const k of ks) { const p = m.get(k.slice(2)); out[k] = p ? { p, src: 'Derive' } : { err: 'contract not quoted (expired?)' }; } } catch { for (const k of ks) out[k] = { err: 'Derive quote unavailable' }; } }));
}

async function resolve(keys) {
  const out = {}; const dex = new Map(), cg = [], opt = [], sym = [], drv = [];
  for (const k of keys) {
    const t = k[0], rest = k.slice(2);
    if (t === 'd') { const i = rest.indexOf(':'); const ch = rest.slice(0, i), a = rest.slice(i + 1); if (CHAINS[ch] && validAddr(ch, a)) (dex.get(ch) || dex.set(ch, []).get(ch)).push(a); else out[k] = { err: 'unsupported chain/address' }; }
    else if (t === 'c') { const [id, s] = rest.split(':'); cg.push([k, id, s]); }
    else if (t === 'o') opt.push(k);
    else if (t === 'x') drv.push(k);
    else if ((t === 'b' || t === 'p') && /^[A-Z0-9]{1,20}$/.test(rest)) sym.push(k);
    else out[k] = { err: 'unknown key' };
  }
  await Promise.all([
    ...[...dex].map(([ch, a]) => dexBatch(ch, a, out)),
    cg.length ? cgBatch(cg, out) : null,
    opt.length ? optBatch(opt, out) : null,
    drv.length ? drvBatch(drv, out) : null,
    ...sym.map(async (k) => { const r = await tryList(P[k[0]](k.slice(2))); if (r) out[k] = r; }),
  ]);
  return out;
}

const inflight = new Map(); // key -> Promise<value>
async function get(keys) {
  const now = Date.now(); const res = {}; const need = [];
  for (const k of keys) { const c = cache.get(k); if (c && now - c.t < TTL) res[k] = c.v; else if (inflight.has(k)) res[k] = inflight.get(k); else need.push(k); }
  if (need.length) {
    const batch = resolve(need).then((out) => { const t = Date.now(); const vals = {}; for (const k of need) { const v = out[k] ? (out[k].p ? { ...out[k], at: t } : out[k]) : { err: 'no free source had a price' }; vals[k] = v; if (!v.retry) cache.set(k, { v, t }); inflight.delete(k); } return vals; }, (e) => { for (const k of need) inflight.delete(k); throw e; });
    for (const k of need) { const p = batch.then((v) => v[k]); inflight.set(k, p); res[k] = p; }
  }
  const ks = Object.keys(res); const vs = await Promise.all(ks.map((k) => Promise.resolve(res[k]).catch(() => ({ err: 'lookup failed' }))));
  { const cut = Date.now() - 2 * TTL; for (const [k, h] of shared) if (h.t < cut) shared.delete(k); } // drop old option chains / market lists (512 MB Render box)
  if (cache.size > 6000) { const cut = Date.now() - TTL; for (const [k, c] of cache) if (c.t < cut) cache.delete(k); }
  return Object.fromEntries(ks.map((k, i) => [k, vs[i]]));
}
const KEY_RE = /^(d:[a-z]+:[A-Za-z0-9:_-]{20,120}|[bp]:[A-Z0-9]{1,20}|c:[a-z0-9-]{1,80}:[A-Z0-9]{0,20}|o:[A-Z.]{1,6}\d{6}[CP]\d{8}|x:[A-Z0-9]{2,10}-\d{8}-[\d_]+-[CP])$/;
const routes = {
  async '/api/liveprice'(q) {
    const keys = [...new Set(String(q.get('k') || '').split(',').map((s) => s.trim()).filter((s) => KEY_RE.test(s)))].slice(0, MAX_KEYS);
    return { at: Date.now(), ttlMs: TTL, px: keys.length ? await get(keys) : {} };
  },
};
module.exports = { routes, get, KEY_RE };
