// Free daily backfill for the Breakouts (flat-base) scanner: daily close + USD volume for every Binance spot USDT pair (multi-year,
// public data-api.binance.vision mirror, no key) + GeckoTerminal daily candles for listed DEX tokens (e.g. TROLL). Cached in data/flatbase_series/<id>.json; skips files < MAX_AGE old.
// Rate limits: Binance 1 call / 150 ms (weight 2, cap 6000/min); GeckoTerminal 1 call / 2.5 s; 429 back-off. Zero paid / Nansen calls.
// Usage: node research/flatbase_backfill.js [maxPairs=2000]
'use strict';
const fs = require('fs'); const path = require('path');
const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA, 'flatbase_series'); fs.mkdirSync(DIR, { recursive: true });
const MAX = +(process.argv[2] || 2000); const MAX_AGE = 20 * 3600e3;
const UA = { 'user-agent': 'asymmetric-terminal research (read-only)', accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP = /^(tether|usd-coin|dai|first-digital-usd|ethena-usde|usds|paypal-usd|true-usd|binance-usd|frax|usdd|wrapped-|weth|wbtc|staked-|lido-staked|coinbase-wrapped|rocket-pool-eth|binance-bridged|bridged-|l2-standard-bridged|mantle-staked|jito-staked|msol|tether-gold|pax-gold|kelp-dao|ether-fi-staked|renzo|stakewise|savings-|sky-|susd|eutbl|blackrock|ondo-us-dollar|usual-usd|global-dollar|ripple-usd|usdx|gho|crvusd|lusd|fdusd|euro-coin|stasis)/;
// DEX tokens not on CoinGecko's top list (GeckoTerminal network + pool address). TROLL = Solana TROLL/USDC Raydium CLMM pool.
const DEX = [{ id: 'dex:troll', symbol: 'TROLL', network: 'solana', token: '5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2' }];
let last = 0;
async function get(url, gap) {
  for (let i = 0; i < 6; i++) {
    const w = last + gap - Date.now(); if (w > 0) await sleep(w); last = Date.now();
    try {
      const r = await fetch(url, { headers: UA });
      if (r.status === 429) { await sleep(30e3 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (i === 5) throw e; await sleep(5e3); }
  }
}
const fresh = (f) => { try { return Date.now() - fs.statSync(f).mtimeMs < MAX_AGE; } catch { return false; } };
(async () => {
  // Binance spot USDT pairs (incl. halted/delisted "BREAK" pairs, to reduce survivorship bias): up to ~5.5 years of daily candles
  // from the public market-data mirror data-api.binance.vision (no key; weight 2 per call, limit 6000/min -> 1 call / 150 ms).
  const BV = 'https://data-api.binance.vision/api/v3';
  const info = await get(`${BV}/exchangeInfo?permissions=SPOT`, 200);
  const LEV = /(UP|DOWN|BULL|BEAR)USDT$/;
  const STABLE = /^(USDC|FDUSD|TUSD|BUSD|USDP|DAI|USDE|EUR|EURI|AEUR|PAXG|XUSD|USD1|BFUSD|RLUSD|PYUSD|WBTC|WBETH|BNSOL|USDS|SUSD|UST|USTC)$/;
  const syms = info.symbols.filter((x) => x.quoteAsset === 'USDT' && !LEV.test(x.symbol) && !STABLE.test(x.baseAsset) && ['TRADING', 'BREAK'].includes(x.status));
  fs.writeFileSync(path.join(DATA, 'flatbase_universe.json'), JSON.stringify({ at: Date.now(), source: 'binance spot USDT', coins: syms.map((x) => ({ id: 'bn_' + x.baseAsset.toLowerCase(), symbol: x.baseAsset, pair: x.symbol, status: x.status })).slice(0, MAX) }));
  let ok = 0, fail = 0;
  for (const x of syms.slice(0, MAX)) {
    const id = 'bn_' + x.baseAsset.toLowerCase(); const f = path.join(DIR, id + '.json'); if (fresh(f)) { ok++; continue; }
    try {
      let rows = []; let end = '';
      for (let k = 0; k < 3; k++) {
        const l = await get(`${BV}/klines?symbol=${x.symbol}&interval=1d&limit=1000${end}`, 150);
        rows = l.concat(rows); if (l.length < 1000) break; end = '&endTime=' + (l[0][0] - 1);
      }
      const s = rows.map((r) => [Math.floor(r[0] / 864e5), +r[4], +r[7]]); // [day, close, quote volume USD]
      fs.writeFileSync(f, JSON.stringify({ id, symbol: x.baseAsset, pair: x.symbol, status: x.status, src: 'binance', at: Date.now(), s })); ok++;
    } catch (e) { fail++; }
    if ((ok + fail) % 100 === 0) console.log(new Date().toISOString(), 'binance', ok, 'ok', fail, 'failed of', syms.length);
  }
  for (const x of DEX) {
    const f = path.join(DIR, x.id.replace(':', '_') + '.json'); if (fresh(f)) continue;
    try {
      const pools = await get(`https://api.geckoterminal.com/api/v2/networks/${x.network}/tokens/${x.token}/pools?page=1`, 2500);
      const pool = pools.data?.[0]?.attributes?.address; if (!pool) throw new Error('no pool');
      let rows = []; let before = '';
      for (let k = 0; k < 2; k++) { // up to 2 x 1000 daily candles
        const o = await get(`https://api.geckoterminal.com/api/v2/networks/${x.network}/pools/${pool}/ohlcv/day?limit=1000&currency=usd&token=base${before}`, 2500);
        const l = o.data?.attributes?.ohlcv_list || []; rows.push(...l); if (l.length < 1000) break; before = '&before_timestamp=' + l[l.length - 1][0];
      }
      rows = rows.sort((a, b) => a[0] - b[0]);
      const s = rows.map((r) => [Math.floor(r[0] / 86400), r[4], r[5]]);
      const ath = Math.max(...rows.map((r) => r[2]));
      fs.writeFileSync(f, JSON.stringify({ id: x.id, symbol: x.symbol, src: 'geckoterminal', pool, at: Date.now(), ath, s }));
      console.log('dex', x.symbol, s.length, 'days');
    } catch (e) { console.log('dex', x.symbol, 'failed', e.message); }
  }
  console.log('done', ok, 'ok', fail, 'failed');
})();
