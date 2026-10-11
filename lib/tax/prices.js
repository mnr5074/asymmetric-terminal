'use strict';
// Historical USD prices at transaction time, free keyless sources only, in this order:
//  1. USD / USD stablecoins = 1.00
//  2. Coinbase Exchange public candles (hourly; full history) for majors
//  3. Binance public market-data mirror data-api.binance.vision (daily USDT klines; full history)
//  4. CoinGecko free API (daily; last 365 days only on the keyless tier) by contract address
//  5. GeckoTerminal pool OHLCV (daily; ~6 months on the free tier) via the top DexScreener pool for the token
// Cached on disk in data/tax/price_cache.json. Every price records its source so the report can show it.
const fs = require('fs');
const path = require('path');
const A = require('./assets');
const store = require('./store');
const UA = { 'user-agent': 'Mozilla/5.0 (asymmetric-terminal tax desk)', accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CACHE_F = () => path.join(store.ensureDir(), 'price_cache.json');
let cache = null;
function C() { if (!cache) { try { cache = JSON.parse(fs.readFileSync(CACHE_F(), 'utf8')); } catch { cache = {}; } } return cache; }
let dirty = 0; function persist() { if (dirty) { store.writePrivate(CACHE_F(), JSON.stringify(cache)); dirty = 0; } }
const gaps = {}; async function throttle(host, ms) { const w = (gaps[host] || 0) + ms - Date.now(); if (w > 0) { gaps[host] = Date.now() + w; await sleep(w); } else gaps[host] = Date.now(); }
async function get(url, host, gap) { await throttle(host, gap); const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`HTTP ${r.status} ${host}`); return r.json(); }

const CB = new Set('BTC ETH SOL AVAX DOGE LTC LINK UNI AAVE MATIC POL ADA DOT XRP XLM ATOM ALGO SHIB BONK WIF JUP PYTH RNDR RENDER ARB OP SUI APT NEAR FIL ICP HBAR SEI TIA INJ JTO PEPE ONDO ENA EIGEN TRUMP HYPE'.split(' '));
const CG_PLATFORM = { solana: 'solana', ethereum: 'ethereum', base: 'base', bsc: 'binance-smart-chain', arbitrum: 'arbitrum-one', polygon: 'polygon-pos', optimism: 'optimistic-ethereum', avalanche: 'avalanche' };
const GT_NET = { solana: 'solana', ethereum: 'eth', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum', polygon: 'polygon_pos', optimism: 'optimism', avalanche: 'avax' };

async function coinbase(sym, t) {
  const bucket = Math.floor(t / (12 * 86400e3)); const k = `cb:${sym}:${bucket}`;
  if (!C()[k]) {
    const start = new Date(bucket * 12 * 86400e3).toISOString(), end = new Date((bucket + 1) * 12 * 86400e3).toISOString();
    const d = await get(`https://api.exchange.coinbase.com/products/${sym}-USD/candles?granularity=3600&start=${start}&end=${end}`, 'coinbase', 350);
    if (!Array.isArray(d)) throw new Error('coinbase: no candles');
    C()[k] = d.map((c) => [c[0], c[4]]); dirty++;
  }
  return nearest(C()[k], t / 1000, 3 * 3600);
}
async function binance(sym, t) {
  const bucket = Math.floor(t / (900 * 86400e3)); const k = `bn:${sym}:${bucket}`;
  if (!C()[k]) {
    const d = await get(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=1d&startTime=${bucket * 900 * 86400e3}&limit=1000`, 'binance', 300);
    C()[k] = d.map((c) => [Math.floor(c[0] / 1000) + 43200, +c[4]]); dirty++;
  }
  return nearest(C()[k], t / 1000, 86400);
}
async function coingeckoContract(chain, addr, t) {
  const plat = CG_PLATFORM[chain]; if (!plat || Date.now() - t > 364 * 86400e3) return null;
  const k = `cg:${chain}:${addr}`;
  if (!C()[k] || (C()[k].at < Date.now() - 6 * 3600e3 && t > C()[k].upto)) {
    const from = Math.floor((Date.now() - 364 * 86400e3) / 1000), to = Math.floor(Date.now() / 1000);
    const d = await get(`https://api.coingecko.com/api/v3/coins/${plat}/contract/${addr}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`, 'coingecko', 2500);
    C()[k] = { at: Date.now(), upto: Date.now(), p: (d.prices || []).map(([ms, p]) => [Math.floor(ms / 1000), p]) }; dirty++;
  }
  return nearest(C()[k].p, t / 1000, 86400 * 1.5);
}
async function geckoterminal(chain, addr, t) {
  const net = GT_NET[chain]; if (!net) return null;
  const pk = `ds:pool:${chain}:${addr}`;
  if (C()[pk] === undefined) {
    const pairs = await get(`https://api.dexscreener.com/token-pairs/v1/${chain}/${addr}`, 'dexscreener', 300).catch(() => []);
    const p = (pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    C()[pk] = p ? String(p.pairAddress).split(':')[0] : null; dirty++;
  }
  const pool = C()[pk]; if (!pool) return null;
  const k = `gt:${chain}:${pool}`;
  if (!C()[k] || C()[k].at < Date.now() - 12 * 3600e3) {
    const d = await get(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pool}/ohlcv/day?aggregate=1&limit=1000&currency=usd&token=base`, 'geckoterminal', 2200);
    C()[k] = { at: Date.now(), p: (d?.data?.attributes?.ohlcv_list || []).map((x) => [x[0] + 43200, +x[4]]) }; dirty++;
  }
  return nearest(C()[k].p, t / 1000, 86400 * 1.5);
}
function nearest(arr, sec, maxGap) {
  let best = null, bd = Infinity;
  for (const [s, p] of arr || []) { const d = Math.abs(s - sec); if (d < bd) { bd = d; best = p; } }
  return best != null && bd <= maxGap ? best : null;
}
// asset: symbol; opts: {chain, address}
async function priceAt(asset, t, opts = {}) {
  const s = A.taxKey(asset);
  if (A.isFiat(s) || A.isStable(s)) return { usd: 1, source: 'USD / stablecoin at $1.00' };
  const tries = [];
  if (CB.has(s)) tries.push(['Coinbase Exchange hourly candle', () => coinbase(s === 'MATIC' ? 'POL' : s, t)]);
  if (/^[A-Z0-9]{2,10}$/.test(s)) tries.push(['Binance public daily close (USDT)', () => binance(s, t)]);
  if (opts.chain && opts.address) { tries.push(['CoinGecko daily (free tier, <=365d)', () => coingeckoContract(opts.chain, opts.address, t)]); tries.push(['GeckoTerminal daily close (top pool)', () => geckoterminal(opts.chain, opts.address, t)]); }
  for (const [src, fn] of tries) { try { const p = await fn(); if (p != null && p > 0) return { usd: p, source: src }; } catch (e) { /* next source */ } }
  return null;
}
// current prices for harvest suggestions
async function spot(symbols) {
  const out = {};
  for (const s0 of symbols) { const s = A.taxKey(s0); if (A.isFiat(s) || A.isStable(s)) { out[s0] = 1; continue; }
    try { if (CB.has(s)) { const d = await get(`https://api.exchange.coinbase.com/products/${s}-USD/ticker`, 'coinbase', 350); if (+d.price) { out[s0] = +d.price; continue; } } } catch {}
    try { const d = await get(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${s}USDT`, 'binance', 300); if (+d.price) out[s0] = +d.price; } catch {} }
  return out;
}
// Fill missing USD values on events in place (trades valued from the side with a known price)
async function fillValues(events, { log = () => {}, budget = 400 } = {}) {
  let filled = 0, lookups = 0;
  for (const e of events) {
    if (lookups >= budget) break;
    if (e.type === 'trade' && e.usd == null) {
      for (const side of [e.out, e.in]) { if (!side) continue; const p = await priceAt(side.asset, e.ts, side); lookups++; if (p) { e.usd = p.usd * side.qty; e.priceSource = `${side.asset}: ${p.source}`; filled++; break; } }
    } else if ((e.type === 'income' || e.type === 'transfer_in' || e.type === 'transfer_out' || e.type === 'spend') && e.usd == null) {
      const side = e.in || e.out; const p = await priceAt(side.asset, e.ts, side); lookups++; if (p) { e.usd = p.usd * side.qty; e.priceSource = `${side.asset}: ${p.source}`; filled++; }
    }
    if (e.fee && e.fee.qty > 0 && e.feeUsd == null) { const p = await priceAt(e.fee.asset, e.ts, e.fee); lookups++; if (p) e.feeUsd = p.usd * e.fee.qty; }
  }
  persist();
  return { filled, lookups, budgetHit: lookups >= budget };
}
module.exports = { priceAt, spot, fillValues, persist };
