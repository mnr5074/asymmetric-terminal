'use strict';
// Cross-exchange price gap detector. Polls best bid/ask for the same token on: Binance spot (data-api.binance.vision mirror) + Binance USDT-M perps
// (www.binance.com/fapi), OKX spot + swap, Gate spot + USDT futures, Hyperliquid perps, Coinbase spot (USD), Kraken spot (USD),
// and the deepest DEX pair from DexScreener (on-chain tokens on solana/ethereum/base/bsc/arbitrum; matched by symbol, ≥$200K liquidity and price within
// 2% of the CEX reference at match time, cached 6h; majors excluded because DEX copies are bridged/wrapped; DEX quotes >8% off are treated as a different token).
// USD quotes are converted to USDT with Kraken's live USDT/USD. Reference = median mid of eligible CEX spot quotes (perps if no spot).
// A quote is eligible when spread ≤ 1.5%, 24h volume ≥ $50K (DEX: liquidity ≥ $50K) and it is not stale (> 2 min old when the venue reports a time).
// Perp quotes have the part of the gap explained by the current funding rate removed (funding ≈ the perp premium the market is paying).
// Flag = |adjusted gap| ≥ 1.5% (watch) / ≥ 3% (strong) on ≥ 3 consecutive polls (~2+ minutes), with order-book depth fetched for flagged pairs.
// Model estimates from public data, not financial advice.
const fs = require('fs');
const path = require('path');
const { getJSON, postJSON } = require('./util');

const POLL_MS = 45e3, SUSTAIN = 3, WATCH = 1.5, STRONG = 3;
const UA = { 'user-agent': 'Mozilla/5.0 (asymmetric-terminal read-only)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const num = (x) => (x == null || x === '' || !isFinite(+x) ? null : +x);
const KRAKEN_ALIAS = { XBT: 'BTC', XDG: 'DOGE' };

function createPriceGaps({ DATA_DIR, perps, log = () => {} }) {
  const statsFile = path.join(DATA_DIR, 'pricegaps_stats.json');
  let stats = {}; try { stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')).tokens || {}; } catch {}
  let hist = null; const loadHist = () => { try { hist = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pricegaps_history.json'), 'utf8')); } catch { hist = null; } };
  loadHist();
  const venueState = {};
  const ok = (v, extra) => { venueState[v] = { ok: true, at: Date.now(), ...extra }; };
  const bad = (v, e) => { venueState[v] = { ok: false, at: Date.now(), error: e.message || String(e) }; };
  // slow-changing metadata
  let meta = { at: 0, cb: new Set(), kraken: {}, bnVol: {}, okxCt: {}, gateQm: {} };
  async function refreshMeta() {
    try { const p = await getJSON('https://api.exchange.coinbase.com/products', UA, 20000); meta.cb = new Set(p.filter((x) => x.quote_currency === 'USD' && x.status === 'online' && !x.trading_disabled).map((x) => x.base_currency)); } catch (e) { bad('coinbase', e); }
    try { const p = await getJSON('https://api.kraken.com/0/public/AssetPairs', {}, 20000); meta.kraken = {}; for (const [k, v] of Object.entries(p.result || {})) { const ws = v.wsname || ''; const [b, q] = ws.split('/'); if (q === 'USD' && b) meta.kraken[KRAKEN_ALIAS[b] || b] = k; } } catch (e) { bad('kraken', e); }
    try { const t = await getJSON('https://data-api.binance.vision/api/v3/ticker/24hr?type=MINI', {}, 30000); meta.bnVol = Object.fromEntries(t.map((x) => [x.symbol, +x.quoteVolume])); } catch (e) { bad('binance-spot', e); }
    try { const d = await getJSON('https://www.okx.com/api/v5/public/instruments?instType=SWAP', UA, 20000); for (const i of d.data || []) meta.okxCt[i.instId] = +i.ctVal * (+i.ctMult || 1); } catch {}
    try { const c = await getJSON('https://api.gateio.ws/api/v4/futures/usdt/contracts', {}, 30000); meta.gateQm = Object.fromEntries(c.map((x) => [x.name, +x.quanto_multiplier || 1])); } catch {}
    meta.at = Date.now();
  }
  // DEX pair mapping (DexScreener search; cached)
  const dexMap = {}; // sym -> {chainId, pairAddress, at} | {none:true, at}
  // majors trade on DEXes only as bridged/wrapped copies (and symbol squatters), so they are not DEX-matched
  const NO_DEX = new Set('BTC ETH SOL XRP ADA DOGE BNB TRX LTC BCH ETC DOT AVAX SHIB TON XLM ATOM FIL NEAR APT SUI HBAR ICP XMR ALGO EOS XTZ META'.split(' '));
  const DEX_CHAINS = new Set(['solana', 'ethereum', 'base', 'bsc', 'arbitrum']);
  async function mapDex(sym, ref) {
    const c = dexMap[sym]; if (c && Date.now() - c.at < 6 * 3600e3) return;
    if (NO_DEX.has(sym)) { dexMap[sym] = { none: true, at: Date.now() + 1e12 }; return; }
    try {
      const d = await getJSON(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`, {}, 15000);
      const ps = (d.pairs || []).filter((p) => (p.baseToken?.symbol || '').toUpperCase() === sym && DEX_CHAINS.has(p.chainId) && (p.liquidity?.usd || 0) >= 200e3 && (p.volume?.h24 || 0) >= 50e3 && +p.priceUsd > 0 && Math.abs(+p.priceUsd / ref - 1) < 0.02)
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      dexMap[sym] = ps[0] ? { chainId: ps[0].chainId, pairAddress: ps[0].pairAddress, dex: ps[0].dexId, token: ps[0].baseToken.address, at: Date.now() } : { none: true, at: Date.now() };
    } catch { dexMap[sym] = { none: true, at: Date.now() - 5 * 3600e3 }; }
  }
  // ---------- polling ----------
  const series = {}; // sym -> venueKey -> [mid,...] (last 12 polls)
  const streak = {}; // sym|venueKey -> consecutive gap polls
  let snap = { generatedAt: null, tokens: [], flags: [] };
  const depthCache = {};
  async function poll() {
    if (Date.now() - meta.at > 6 * 3600e3) await refreshMeta();
    const s = perps.snapshot(); const toks = (s.tokens || []).filter((t) => t.mark > 0);
    if (!toks.length) return;
    const Q = {}; const put = (sym, q) => { (Q[sym] || (Q[sym] = [])).push(q); };
    const want = new Set(toks.map((t) => t.sym));
    const jobs = []; const fut = {};
    // USDT/USD
    let usdt = 1;
    jobs.push(getJSON('https://api.kraken.com/0/public/Ticker?pair=USDTZUSD', {}, 10000).then((d) => { const r = Object.values(d.result || {})[0]; if (r) usdt = (+r.a[0] + +r.b[0]) / 2; }).catch(() => {}));
    jobs.push(getJSON('https://data-api.binance.vision/api/v3/ticker/bookTicker', {}, 20000).then((d) => {
      for (const x of d) { if (!x.symbol.endsWith('USDT')) continue; const b = x.symbol.slice(0, -4); if (!want.has(b)) continue; put(b, { venue: 'binance', kind: 'spot', bid: +x.bidPrice, ask: +x.askPrice, vol: meta.bnVol[x.symbol] ?? null, ts: null }); } ok('binance-spot');
    }).catch((e) => bad('binance-spot', e)));
    jobs.push(getJSON('https://www.binance.com/fapi/v1/ticker/bookTicker', {}, 20000).then((d) => { const m = Object.fromEntries(d.map((x) => [x.symbol, x])); fut.binance = m; ok('binance-perp'); }).catch((e) => bad('binance-perp', e)));
    jobs.push(getJSON('https://www.okx.com/api/v5/market/tickers?instType=SPOT', UA, 20000).then((d) => {
      for (const x of d.data || []) { const [b, q] = x.instId.split('-'); if (q !== 'USDT' || !want.has(b)) continue; put(b, { venue: 'okx', kind: 'spot', bid: num(x.bidPx), ask: num(x.askPx), vol: num(x.volCcy24h), ts: +x.ts }); } ok('okx-spot');
    }).catch((e) => bad('okx-spot', e)));
    jobs.push(getJSON('https://www.okx.com/api/v5/market/tickers?instType=SWAP', UA, 20000).then((d) => { fut.okx = Object.fromEntries((d.data || []).map((x) => [x.instId, x])); ok('okx-swap'); }).catch((e) => bad('okx-swap', e)));
    jobs.push(getJSON('https://api.gateio.ws/api/v4/spot/tickers', {}, 20000).then((d) => {
      for (const x of d) { const [b, q] = x.currency_pair.split('_'); if (q !== 'USDT' || !want.has(b)) continue; put(b, { venue: 'gate', kind: 'spot', bid: num(x.highest_bid), ask: num(x.lowest_ask), vol: num(x.quote_volume), ts: null }); } ok('gate-spot');
    }).catch((e) => bad('gate-spot', e)));
    jobs.push(getJSON('https://api.gateio.ws/api/v4/futures/usdt/tickers', {}, 20000).then((d) => { fut.gate = Object.fromEntries(d.map((x) => [x.contract, x])); ok('gate-perp'); }).catch((e) => bad('gate-perp', e)));
    jobs.push(postJSON('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' }, 20000).then(([m, c]) => { fut.hyperliquid = Object.fromEntries(m.universe.map((u, i) => [u.name, c[i]])); ok('hyperliquid'); }).catch((e) => bad('hyperliquid', e)));
    // Kraken (one call for all mapped pairs)
    const kp = toks.map((t) => meta.kraken[t.sym]).filter(Boolean);
    if (kp.length) jobs.push(getJSON(`https://api.kraken.com/0/public/Ticker?pair=${kp.join(',')}`, {}, 20000).then((d) => {
      const inv = Object.fromEntries(Object.entries(meta.kraken).map(([b, k]) => [k, b]));
      for (const [k, r] of Object.entries(d.result || {})) { const b = inv[k]; if (!b) continue; const mid = (+r.a[0] + +r.b[0]) / 2; put(b, { venue: 'kraken', kind: 'spot', bid: +r.b[0], ask: +r.a[0], vol: +r.v[1] * mid, ts: null, usd: true }); } ok('kraken', { pairs: kp.length });
    }).catch((e) => bad('kraken', e)));
    // Coinbase (one call per product, throttled)
    const cbs = toks.filter((t) => meta.cb.has(t.sym)).map((t) => t.sym);
    jobs.push((async () => { let n = 0, err = null; for (const b of cbs) { try { const x = await getJSON(`https://api.exchange.coinbase.com/products/${b}-USD/ticker`, UA, 8000); put(b, { venue: 'coinbase', kind: 'spot', bid: num(x.bid), ask: num(x.ask), vol: num(x.volume) * num(x.price), ts: Date.parse(x.time), usd: true }); n++; } catch (e) { err = e; } await sleep(110); } n ? ok('coinbase', { products: n }) : err && bad('coinbase', err); })());
    await Promise.all(jobs);
    // perps (contracts from the perp snapshot)
    for (const t of toks) for (const v of t.venues) {
      const m = v.mult || 1; let q = null;
      if (v.venue === 'binance' && fut.binance?.[v.contract]) { const x = fut.binance[v.contract]; q = { bid: +x.bidPrice / m, ask: +x.askPrice / m, ts: +x.time || null }; }
      if (v.venue === 'okx' && fut.okx?.[v.contract]) { const x = fut.okx[v.contract]; q = { bid: num(x.bidPx) / m, ask: num(x.askPx) / m, ts: +x.ts }; }
      if (v.venue === 'gate' && fut.gate?.[v.contract]) { const x = fut.gate[v.contract]; q = { bid: num(x.highest_bid) / m, ask: num(x.lowest_ask) / m, ts: null }; }
      if (v.venue === 'hyperliquid' && fut.hyperliquid?.[v.contract]) { const x = fut.hyperliquid[v.contract]; const ip = x.impactPxs || []; q = { bid: num(ip[0]) / m, ask: num(ip[1]) / m, ts: null }; if (!(q.bid > 0)) { const mid = num(x.midPx) || num(x.markPx); q = { bid: mid / m, ask: mid / m, ts: null }; } }
      if (q && q.bid > 0 && q.ask > 0) put(t.sym, { venue: v.venue, kind: 'perp', ...q, vol: v.vol24Usd, rate: v.rate, intervalH: v.intervalH });
    }
    // DEX
    const dexJobs = []; const byChain = {};
    for (const t of toks) { const d = dexMap[t.sym]; if (!d) { if (dexJobs.length < 8) dexJobs.push(mapDex(t.sym, t.mark)); continue; } if (!d.none) (byChain[d.chainId] || (byChain[d.chainId] = [])).push([t.sym, d.pairAddress]); }
    await Promise.all(dexJobs);
    for (const [chain, list] of Object.entries(byChain)) for (let i = 0; i < list.length; i += 30) {
      const part = list.slice(i, i + 30);
      try { const d = await getJSON(`https://api.dexscreener.com/latest/dex/pairs/${chain}/${part.map((x) => x[1]).join(',')}`, {}, 15000);
        for (const p of d.pairs || []) { const e = part.find((x) => x[1].toLowerCase() === p.pairAddress.toLowerCase()); if (!e) continue; const mid = +p.priceUsd; put(e[0], { venue: `dex:${p.dexId}@${chain}`, kind: 'dex', bid: mid, ask: mid, vol: p.volume?.h24 ?? null, liq: p.liquidity?.usd ?? null, ts: null, usd: true }); }
        ok('dexscreener'); } catch (e) { bad('dexscreener', e); }
    }
    // ---------- gaps ----------
    const now = Date.now(); const out = []; const flags = [];
    for (const t of toks) {
      const qs = (Q[t.sym] || []).map((q) => {
        const conv = q.usd ? 1 / usdt : 1; const bid = q.bid * conv, ask = q.ask * conv; const mid = (bid + ask) / 2;
        const spreadPct = mid ? (ask - bid) / mid * 100 : null; const age = q.ts ? (now - q.ts) / 1000 : null;
        const why = [];
        if (!(mid > 0)) why.push('no price'); if (spreadPct > 1.5) why.push(`wide spread ${spreadPct.toFixed(2)}%`);
        if (q.kind === 'dex' ? (q.liq || 0) < 50e3 : q.vol != null && q.vol < 50e3) why.push('low volume');
        if (age != null && age > 120) why.push(`stale ${Math.round(age)}s`);
        if (q.kind === 'dex' && (q.vol || 0) < 100e3) why.push('thin DEX volume');
        return { ...q, bid, ask, mid, spreadPct, age, eligible: !why.length, why, key: `${q.venue}:${q.kind}` };
      }).filter((q) => q.mid > 0);
      const spot = qs.filter((q) => q.kind === 'spot' && q.eligible);
      const refSet = spot.length ? spot : qs.filter((q) => q.kind === 'perp' && q.eligible);
      const ref = med(refSet.map((q) => q.mid));
      if (!ref) continue;
      const S = series[t.sym] || (series[t.sym] = {});
      let worst = null;
      for (const q of qs) {
        q.gapPct = (q.mid / ref - 1) * 100;
        if (q.kind === 'dex' && Math.abs(q.gapPct) > 8) { q.eligible = false; q.why.push('price >8% off: likely a different or bridged token with the same ticker'); }
        q.fundAdj = q.kind === 'perp' && q.rate != null ? q.rate * 100 : 0; // funding per interval in %
        q.adjGapPct = q.gapPct - q.fundAdj;
        const a = S[q.key] || (S[q.key] = []); a.push(q.mid); if (a.length > 12) a.shift();
        const k = t.sym + '|' + q.key;
        const big = q.eligible && Math.abs(q.adjGapPct) >= WATCH && refSet.length >= (spot.length ? 1 : 2) && !(refSet.length === 1 && refSet[0] === q);
        streak[k] = big ? (streak[k] || 0) + 1 : 0; q.streak = streak[k];
        if (q.eligible && (!worst || Math.abs(q.adjGapPct) > Math.abs(worst.adjGapPct))) worst = q;
      }
      // per-token frequency tracking
      const st = stats[t.sym] || (stats[t.sym] = { polls: 0, gapPolls: 0, episodes: [], lead: {} });
      st.polls++;
      const sustained = qs.filter((q) => q.streak >= SUSTAIN);
      if (sustained.length) st.gapPolls++;
      for (const q of sustained) {
        // who moved: compare the gapped venue's own move vs the reference venues' move over the last 3 polls
        const a = S[q.key]; const own = a.length >= 4 ? (a[a.length - 1] / a[a.length - 4] - 1) * 100 : null;
        const refMoves = refSet.filter((r) => r.key !== q.key).map((r) => { const b = S[r.key]; return b && b.length >= 4 ? (b[b.length - 1] / b[b.length - 4] - 1) * 100 : null; }).filter((x) => x != null);
        const rm = refMoves.length ? med(refMoves) : null;
        q.mover = own == null || rm == null ? 'unknown' : Math.abs(own) > Math.abs(rm) ? 'this venue moved (leading or off-market)' : 'others moved, this venue lagged';
        if (q.streak === SUSTAIN) { st.episodes.push({ start: now, venue: q.key, gapPct: +q.adjGapPct.toFixed(2), mover: q.mover }); if (st.episodes.length > 50) st.episodes.shift(); const L = q.mover.startsWith('this') ? q.key : q.mover.startsWith('others') ? 'reference' : null; if (L) st.lead[L] = (st.lead[L] || 0) + 1; }
        else { const ep = [...st.episodes].reverse().find((e) => e.venue === q.key); if (ep && Math.abs(q.adjGapPct) > Math.abs(ep.gapPct)) ep.gapPct = +q.adjGapPct.toFixed(2); if (ep) ep.last = now; }
        const level = Math.abs(q.adjGapPct) >= STRONG ? 'strong' : 'watch';
        const dir = q.adjGapPct > 0 ? 'ABOVE' : 'BELOW';
        flags.push({ sym: t.sym, venue: q.venue, kind: q.kind, key: q.key, level, gapPct: +q.gapPct.toFixed(2), adjGapPct: +q.adjGapPct.toFixed(2), ref, mid: q.mid, polls: q.streak, mover: q.mover, spreadPct: q.spreadPct, vol: q.vol, liq: q.liq ?? null, refVenues: refSet.map((r) => r.key),
          text: `${t.sym} on ${q.venue} ${q.kind} trades ${Math.abs(q.adjGapPct).toFixed(2)}% ${dir} the other venues (median ${ref.toPrecision(5)}) for ${q.streak} polls in a row (~${Math.round(q.streak * POLL_MS / 60e3)} min)${q.kind === 'perp' ? ' after removing what funding explains' : ''}. ${q.mover.startsWith('others') ? 'The rest of the market moved and this venue has not caught up yet (lagging/stale venue).' : q.mover.startsWith('this') ? 'This venue moved away on its own: either it is leading a move or someone is pushing a thin book.' : ''} Gaps that persist usually mean deposits/withdrawals are closed, liquidity is thin, or one venue is being pushed. Arbitrage needs transfers to work; check before assuming free money.` });
      }
      st.freqPct = +(st.gapPolls / st.polls * 100).toFixed(2);
      out.push({ sym: t.sym, ref, refN: refSet.length, quotes: qs.map(({ key, venue, kind, mid, gapPct, adjGapPct, spreadPct, vol, liq, eligible, why, streak: sk, age }) => ({ key, venue, kind, mid, gapPct: +gapPct.toFixed(3), adjGapPct: +adjGapPct.toFixed(3), spreadPct: spreadPct != null ? +spreadPct.toFixed(3) : null, vol, liq: liq ?? null, eligible, why, streak: sk, age })),
        maxGap: worst ? +worst.adjGapPct.toFixed(3) : 0, maxVenue: worst?.key || null, freqPct: st.freqPct, polls: st.polls, hist: hist?.tokens?.[t.sym] || null });
    }
    // depth for flagged quotes (top levels within ±1% of mid), max 6 per poll, cached 2 min
    for (const f of flags.slice(0, 6)) { f.depth = await depth(f, toks.find((t) => t.sym === f.sym)).catch(() => null); }
    out.sort((a, b) => Math.abs(b.maxGap) - Math.abs(a.maxGap));
    flags.sort((a, b) => Math.abs(b.adjGapPct) - Math.abs(a.adjGapPct));
    snap = { generatedAt: now, pollMs: POLL_MS, usdtUsd: usdt, venues: { ...venueState }, flags, tokens: out, dexMapped: Object.values(dexMap).filter((d) => !d.none).length,
      rules: `gap = venue mid vs median of eligible spot mids (perps: minus funding per interval) · flag if |gap| ≥ ${WATCH}% (watch) / ≥ ${STRONG}% (strong) for ≥ ${SUSTAIN} consecutive polls (${POLL_MS / 1000}s) · ineligible: spread > 1.5%, 24h volume < $50K, quote > 2 min old`,
      historyAt: hist?.generatedAt || null };
    try { fs.writeFileSync(path.join(DATA_DIR, 'pricegaps.json'), JSON.stringify(snap)); } catch {}
    try { fs.writeFileSync(statsFile, JSON.stringify({ savedAt: now, tokens: stats })); } catch {}
  }
  async function depth(f, t) {
    const k = f.sym + f.key; const c = depthCache[k]; if (c && Date.now() - c.at < 120e3) return c.d;
    const b = f.sym; const v = t?.venues.find((x) => x.venue === f.venue); const m = v?.mult || 1;
    let bids = [], asks = [], scale = 1;
    if (f.key === 'binance:spot') { const d = await getJSON(`https://data-api.binance.vision/api/v3/depth?symbol=${b}USDT&limit=100`); bids = d.bids; asks = d.asks; }
    else if (f.key === 'binance:perp' && v) { const d = await getJSON(`https://www.binance.com/fapi/v1/depth?symbol=${v.contract}&limit=100`); bids = d.bids; asks = d.asks; }
    else if (f.key === 'okx:spot') { const d = await getJSON(`https://www.okx.com/api/v5/market/books?instId=${b}-USDT&sz=100`, UA); bids = d.data[0].bids; asks = d.data[0].asks; }
    else if (f.key === 'okx:perp' && v) { const d = await getJSON(`https://www.okx.com/api/v5/market/books?instId=${v.contract}&sz=100`, UA); bids = d.data[0].bids; asks = d.data[0].asks; scale = meta.okxCt[v.contract] || 1; }
    else if (f.key === 'gate:spot') { const d = await getJSON(`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${b}_USDT&limit=100`); bids = d.bids; asks = d.asks; }
    else if (f.key === 'gate:perp' && v) { const d = await getJSON(`https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${v.contract}&limit=50`); bids = d.bids.map((x) => [x.p, x.s]); asks = d.asks.map((x) => [x.p, x.s]); scale = meta.gateQm[v.contract] || 1; }
    else if (f.key === 'coinbase:spot') { const d = await getJSON(`https://api.exchange.coinbase.com/products/${b}-USD/book?level=2`, UA); bids = d.bids; asks = d.asks; }
    else if (f.key === 'kraken:spot' && meta.kraken[b]) { const d = await getJSON(`https://api.kraken.com/0/public/Depth?pair=${meta.kraken[b]}&count=100`); const r = Object.values(d.result)[0]; bids = r.bids; asks = r.asks; }
    else if (f.key === 'hyperliquid:perp' && v) { const d = await postJSON('https://api.hyperliquid.xyz/info', { type: 'l2Book', coin: v.contract }); bids = d.levels[0].map((x) => [x.px, x.sz]); asks = d.levels[1].map((x) => [x.px, x.sz]); }
    else return null;
    const mid = (+bids[0][0] + +asks[0][0]) / 2;
    const sum = (lv, lo, hi) => lv.reduce((s, [p, q]) => (+p >= lo && +p <= hi ? s + +p * Math.abs(+q) * scale : s), 0);
    const d = { bidUsd1pct: Math.round(sum(bids, mid * 0.99, mid)), askUsd1pct: Math.round(sum(asks, mid, mid * 1.01)), levels: Math.min(bids.length, asks.length), note: m !== 1 ? `contract quoted per ${m}` : null };
    depthCache[k] = { at: Date.now(), d }; return d;
  }
  function forSym(sym) { return snap.tokens.find((t) => t.sym === sym) || null; }
  // composite factor: small weight. Active sustained gap or a gap-prone history = thin/fragmented market (manipulation & exit risk), mildly negative.
  function factor(sym) {
    const t = forSym(sym); if (!t) return null;
    const f = snap.flags.find((x) => x.sym === sym);
    const h = t.hist; const histFreq = h?.gapDayPct ?? null;
    if (f) return { score: f.level === 'strong' ? 35 : 44, value: `${f.adjGapPct > 0 ? '+' : ''}${f.adjGapPct}% on ${f.venue}`, text: f.text, warn: f.level === 'strong' ? `Price gap: ${f.sym} ${f.adjGapPct}% off on ${f.venue} ${f.kind} (sustained)` : null };
    const live = t.polls >= 40 ? t.freqPct : null;
    const prone = (live != null && live >= 5) || (histFreq != null && histFreq >= 10);
    const txt = `Prices for ${sym} agree across ${t.quotes.filter((q) => q.eligible).length} venues right now (largest gap ${Math.abs(t.maxGap).toFixed(2)}%). ` + (live != null ? `Gaps were present in ${live}% of our polls. ` : '') + (histFreq != null ? `Historically ${histFreq}% of days closed with a >2% gap between exchanges.` : '');
    return { score: prone ? 45 : 52, value: prone ? 'gap-prone' : 'aligned', text: prone ? txt + ' That makes it a gap-prone (fragmented, easier to push) market.' : txt };
  }
  let started = false;
  function start() { if (started) return; started = true; const loop = async () => { try { await poll(); } catch (e) { log(`[gaps] poll error ${e.message}`); } setTimeout(loop, POLL_MS); }; setTimeout(loop, 20000); setInterval(loadHist, 30 * 60e3).unref(); }
  return { start, poll, snapshot: () => snap, forSym, factor };
}
module.exports = { createPriceGaps };
