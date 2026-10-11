'use strict';
// Portfolio aggregation (READ-ONLY). Public addresses only; no keys, no signing, no trading.
// Solana: getBalance + getTokenAccountsByOwner (SPL Token + Token-2022) via the visitor's/public RPC; metadata + price +
//         liquidity + verification from Jupiter tokens v2 (free, keyless).
// EVM (ethereum, base, bsc, arbitrum, polygon, avalanche, blast, optimism, robinhood): native balance via publicnode RPCs;
//         ERC-20 balances via Multicall3 balanceOf over the CoinGecko token list for that chain (free, keyless; tokens
//         outside the list, i.e. most airdrop spam, are ignored by design); prices from DexScreener (>= $50K liquidity).
// Cost basis: Solana auto-estimate from the wallet's recent swaps (avg buy price, SOL priced at that day's CoinGecko close);
//         otherwise a manual entry price. Server cache in data/portfolio.json (wallet list, manual entries, cost basis).
const fs = require('fs');
const path = require('path');
const { cached, getJSON, postJSON } = require('./util');
const { rpcFor } = require('./solrpc');
const chains = require('./chains');

const FILE = path.join(__dirname, '..', 'data', 'portfolio.json');
const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const CG_PLATFORM = { ethereum: 'ethereum', base: 'base', bsc: 'binance-smart-chain', arbitrum: 'arbitrum-one', polygon: 'polygon-pos', avalanche: 'avalanche', blast: 'blast', optimism: 'optimistic-ethereum' };
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MIN_LIQ = 50000;        // a price only counts if the token has a pool at least this deep
const MAX_POOL_SHARE = 0.5; // a position worth more than half its pool is not counted at the quoted price
const DUST_USD = 1;           // positions below this are "dust" (hidden by default)

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { wallets: [], entries: {}, costBasis: {} }; } }
let DB = load();
function save() { try { const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(DB, null, 1)); fs.renameSync(t, FILE); } catch {} }
const bad = (m, s = 400) => Object.assign(new Error(m), { status: s });
const isSol = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || '');
const isEvm = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');

// ---------------- Solana ----------------
async function jupTokens(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const arr = await cached('jup:tok:' + chunk.join(','), 60e3, () => getJSON(`https://lite-api.jup.ag/tokens/v2/search?query=${chunk.join(',')}`, {}, 15000)).catch(() => []);
    for (const t of arr || []) out[t.id] = t;
  }
  return out;
}
async function solWallet(addr, req) {
  const rpc = rpcFor(req);
  const [bal, ...tas] = await Promise.all([rpc.call('getBalance', [addr]), ...TOKEN_PROGRAMS.map((p) => rpc.call('getTokenAccountsByOwner', [addr, { programId: p }, { encoding: 'jsonParsed' }]))]);
  const byMint = {};
  tas.forEach((r, pi) => { for (const a of r.value || []) { const info = a.account.data.parsed?.info; const ta = info?.tokenAmount; if (!ta || ta.amount === '0') continue; const m = info.mint; byMint[m] = byMint[m] || { amount: 0, decimals: ta.decimals, program: pi ? 'token-2022' : 'spl' }; byMint[m].amount += +ta.uiAmountString; } });
  const solAmt = bal.value / 1e9;
  const mints = [WSOL, ...Object.keys(byMint)];
  const meta = await jupTokens(mints);
  const positions = [];
  const mk = (mint, amount, extra = {}) => {
    const t = meta[mint] || {}; const px = t.usdPrice ?? null, liq = t.liquidity ?? null;
    const priced = px != null && liq != null && liq >= MIN_LIQ;
    const value = priced ? amount * px : null;
    const spam = !t.id || (!t.isVerified && (t.organicScore ?? 0) < 10 && (liq ?? 0) < MIN_LIQ);
    return { chain: 'solana', wallet: addr, mint, symbol: t.symbol || mint.slice(0, 4) + '…', name: t.name || null, icon: t.icon || null, amount, priceUsd: px, liquidityUsd: liq, valueUsd: value && liq && value > liq * MAX_POOL_SHARE ? null : value,
      priceNote: px == null ? 'no price' : !priced ? 'thin market (<$50K liquidity), not valued' : value > liq * MAX_POOL_SHARE ? 'position > 50% of its pool liquidity (not exit-able at this price), not valued' : undefined,
      verified: !!t.isVerified, organicScore: t.organicScore ?? null, mcap: t.mcap ?? null, ch24: t.stats24h?.priceChange ?? null, audit: t.audit || null, spam, ...extra };
  };
  if (solAmt > 0) positions.push(mk(WSOL, solAmt, { symbol: 'SOL', native: true }));
  for (const [m, x] of Object.entries(byMint)) positions.push(mk(m, x.amount, { tokenProgram: x.program, ...(m === WSOL ? { symbol: 'wSOL' } : {}) }));
  return { address: addr, kind: 'solana', positions, tokenAccounts: Object.keys(byMint).length, source: 'Solana RPC getTokenAccountsByOwner (SPL + Token-2022) · Jupiter tokens v2 prices' };
}

// ---------------- EVM ----------------
async function evmRpc(chain, method, params) {
  const c = chains.CHAINS[chain]; if (!c?.rpc) throw new Error('no rpc for ' + chain);
  const j = await postJSON(c.rpc, { jsonrpc: '2.0', id: 1, method, params }, 20000);
  if (j.error) throw new Error(`${chain} ${method}: ${j.error.message}`);
  return j.result;
}
async function cgList(chain) {
  const p = CG_PLATFORM[chain]; if (!p) return [];
  return cached('cglist:' + p, 86400e3, async () => (await getJSON(`https://tokens.coingecko.com/${p}/all.json`, {}, 30000)).tokens.filter((t) => isEvm(t.address)));
}
const pad = (h, n = 64) => h.replace(/^0x/, '').padStart(n, '0');
// Multicall3.aggregate3((address target,bool allowFailure,bytes callData)[]) with balanceOf(owner) calls
function encAggregate3(targets, owner) {
  const cd = '70a08231' + pad(owner.toLowerCase());          // 36 bytes
  const n = targets.length, TUP = 6 * 32;                     // target, allowFailure, offset, len, data(2 words)
  let head = '', body = '';
  for (let i = 0; i < n; i++) head += pad((n * 32 + i * TUP).toString(16));
  for (const t of targets) body += pad(t.toLowerCase()) + pad('1') + pad('60') + pad('24') + cd + '0'.repeat(56);
  return '0x82ad56cb' + pad('20') + pad(n.toString(16)) + head + body;
}
function decAggregate3(hex, n) {
  const h = hex.replace(/^0x/, ''); const word = (o) => h.slice(o * 2, o * 2 + 64);
  const arr = parseInt(word(0), 16), len = parseInt(word(arr), 16), out = [];
  for (let i = 0; i < Math.min(n, len); i++) {
    const off = arr + 32 + parseInt(word(arr + 32 + i * 32), 16);
    const ok = parseInt(word(off), 16) === 1, dOff = off + parseInt(word(off + 32), 16), dLen = parseInt(word(dOff), 16);
    out.push(ok && dLen >= 32 ? BigInt('0x' + word(dOff + 32)) : 0n);
  }
  return out;
}
async function dsPrices(chain, addrs) {
  const out = {};
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    const pairs = await cached(`ds:tokv:${chain}:${chunk.join(',')}`, 60e3, () => getJSON(`https://api.dexscreener.com/tokens/v1/${chain}/${chunk.join(',')}`, {}, 15000)).catch(() => []);
    for (const p of pairs || []) { const a = (p.baseToken?.address || '').toLowerCase(); const l = p.liquidity?.usd || 0; if (!out[a] || l > out[a].liq) out[a] = { liq: l, px: +p.priceUsd || null, ch24: p.priceChange?.h24 ?? null, mcap: p.marketCap ?? p.fdv ?? null }; }
  }
  return out;
}
async function nativeUsd() {
  return cached('pf:natives', 120e3, async () => { const ids = 'ethereum,binancecoin,polygon-ecosystem-token,avalanche-2'; const d = await getJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, {}, 10000).catch(() => ({})); return { ETH: d.ethereum?.usd, BNB: d.binancecoin?.usd, POL: d['polygon-ecosystem-token']?.usd, AVAX: d['avalanche-2']?.usd }; });
}
async function evmChain(chain, addr, nat) {
  const c = chains.CHAINS[chain]; const positions = []; const notes = [];
  try {
    const wei = BigInt(await evmRpc(chain, 'eth_getBalance', [addr, 'latest'])); const amt = Number(wei) / 1e18;
    if (amt > 0) { const px = nat[c.native] ?? null; positions.push({ chain, wallet: addr, mint: 'native', symbol: c.native, name: c.name + ' native', amount: amt, priceUsd: px, valueUsd: px ? amt * px : null, native: true, verified: true }); }
  } catch (e) { notes.push(`${chain} native: ${e.message.slice(0, 80)}`); }
  const list = await cgList(chain).catch(() => []);
  if (!list.length) { if (CG_PLATFORM[chain]) notes.push(`${chain}: token list unavailable`); else notes.push(`${chain}: native only (no free token list)`); return { positions, notes }; }
  const held = [];
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    try {
      const r = await evmRpc(chain, 'eth_call', [{ to: MULTICALL3, data: encAggregate3(chunk.map((t) => t.address), addr) }, 'latest']);
      decAggregate3(r, chunk.length).forEach((b, k) => { if (b > 0n) held.push({ t: chunk[k], raw: b }); });
    } catch (e) { notes.push(`${chain} multicall chunk ${i}: ${e.message.slice(0, 60)}`); }
  }
  const px = await dsPrices(chain, held.map((h) => h.t.address.toLowerCase()));
  for (const { t, raw } of held) {
    const amount = Number(raw) / 10 ** (t.decimals || 18); const m = px[t.address.toLowerCase()];
    const priced = m && m.px && m.liq >= MIN_LIQ; let value = priced ? amount * m.px : null;
    let note = !m ? 'no DEX market found' : !priced ? 'thin market (<$50K liquidity), not valued' : undefined;
    if (value && value > m.liq * MAX_POOL_SHARE) { value = null; note = 'position > 50% of its pool liquidity (not exit-able at this price), not valued'; }
    positions.push({ chain, wallet: addr, mint: t.address, symbol: t.symbol, name: t.name, icon: t.logoURI || null, amount, priceUsd: m?.px ?? null, liquidityUsd: m?.liq ?? null, valueUsd: value, priceNote: note, ch24: m?.ch24 ?? null, mcap: m?.mcap ?? null, verified: true /* on CoinGecko list */, spam: !priced && !value });
  }
  return { positions, notes };
}
async function evmWallet(addr, onlyChains) {
  const nat = await nativeUsd();
  const list = chains.EVM.filter((c) => !onlyChains || onlyChains.includes(c));
  const res = await Promise.all(list.map((c) => evmChain(c, addr, nat).catch((e) => ({ positions: [], notes: [`${c}: ${e.message}`] }))));
  return { address: addr, kind: 'evm', positions: res.flatMap((r) => r.positions), notes: res.flatMap((r) => r.notes), source: 'publicnode RPCs · Multicall3 balanceOf over CoinGecko token lists · DexScreener prices' };
}

// ---------------- cost basis (Solana swaps) ----------------
async function solDailyUsd() {
  return cached('cg:sol:daily', 6 * 3600e3, async () => { const d = await getJSON('https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=365&interval=daily', {}, 15000); const m = {}; for (const [t, p] of d.prices || []) m[new Date(t).toISOString().slice(0, 10)] = p; return m; });
}
const jobs = new Map();
function startCostBasis(addr, limit, req) {
  if (!isSol(addr)) throw bad('Solana address required (EVM cost basis: enter manually)');
  const id = Math.random().toString(36).slice(2, 10);
  const job = { id, address: addr, status: 'running', progress: 'listing signatures', scanned: 0, swaps: 0 };
  jobs.set(id, job); setTimeout(() => jobs.delete(id), 3600e3).unref();
  (async () => {
    const mev = require('./mev'); const rpc = rpcFor(req);
    let solDay = {}; try { solDay = await solDailyUsd(); } catch {}
    const sigs = (await rpc.call('getSignaturesForAddress', [addr, { limit: Math.min(200, limit) }])).filter((s) => !s.err);
    const acc = {};
    for (const s of sigs) {
      job.progress = `tx ${job.scanned + 1}/${sigs.length}`;
      let tx; try { tx = await rpc.call('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1 }]); } catch { continue; }
      job.scanned++;
      if (!tx) continue;
      const sw = mev.asSwap(mev.deltas(tx, addr)); if (!sw) continue;
      job.swaps++;
      const day = new Date((tx.blockTime || 0) * 1000).toISOString().slice(0, 10);
      const quoteUsd = (mint, ui) => (STABLES.has(mint) ? ui : mint === WSOL && solDay[day] ? ui * solDay[day] : null);
      const buyUsd = quoteUsd(sw.inMint, sw.inUi);   // bought sw.outMint paying a quote asset
      if (buyUsd != null && !STABLES.has(sw.outMint) && sw.outMint !== WSOL) { const a = (acc[sw.outMint] ||= { boughtQty: 0, costUsd: 0, soldQty: 0, proceedsUsd: 0, buys: 0, sells: 0 }); a.boughtQty += sw.outUi; a.costUsd += buyUsd; a.buys++; }
      const sellUsd = quoteUsd(sw.outMint, sw.outUi);
      if (sellUsd != null && !STABLES.has(sw.inMint) && sw.inMint !== WSOL) { const a = (acc[sw.inMint] ||= { boughtQty: 0, costUsd: 0, soldQty: 0, proceedsUsd: 0, buys: 0, sells: 0 }); a.soldQty += sw.inUi; a.proceedsUsd += sellUsd; a.sells++; }
    }
    for (const a of Object.values(acc)) a.avgCostUsd = a.boughtQty ? a.costUsd / a.boughtQty : null;
    DB.costBasis[addr] = { at: Date.now(), txsScanned: job.scanned, swaps: job.swaps, oldest: sigs.length ? sigs[sigs.length - 1].blockTime * 1000 : null, tokens: acc };
    save(); job.status = 'done'; job.progress = 'done'; job.result = DB.costBasis[addr];
  })().catch((e) => { job.status = 'error'; job.error = e.message; });
  return job;
}

// ---------------- narratives (from other modules' data files; degrade gracefully) ----------------
function narrativeContext() {
  return cached('pf:narr', 600e3, async () => {
    const dir = path.join(__dirname, '..', 'data');
    const bySym = {}; const themes = []; const src = [];
    try { // data/narratives.json (lib/narratives.js / research/narratives.py) – shape-tolerant
      const d = JSON.parse(fs.readFileSync(path.join(dir, 'narratives.json'), 'utf8')); src.push('narratives.json');
      for (const t of d.themes || []) {
        const crowd = t.overcrowded ?? t.crowded ?? (typeof t.crowding === 'number' ? t.crowding >= 0.7 : /crowd|late|hot|euphor/i.test(String(t.stage || t.phase || t.status || '')));
        themes.push({ id: t.id, name: t.name || t.label || t.id, overcrowded: !!crowd, stage: t.stage || t.phase || null });
        const members = [].concat(t.tokens || [], t.members || [], t.basket || [], t.coins || []);
        for (const m of members) { const s = (typeof m === 'string' ? m : m.symbol || m.sym || '').toUpperCase(); if (s) (bySym[s] ||= []).push({ id: t.id, name: t.name || t.id, overcrowded: !!crowd, src: 'narratives' }); }
      }
    } catch {}
    try { // CoinGecko category snapshots cached by the narratives desk
      const cdir = path.join(dir, 'narratives_cache');
      for (const f of fs.readdirSync(cdir).filter((x) => /^cg_cat_.*\.json$/.test(x))) {
        const id = f.slice(7, -5); let arr; try { arr = JSON.parse(fs.readFileSync(path.join(cdir, f), 'utf8')); } catch { continue; }
        if (!Array.isArray(arr)) continue; src.push(f);
        for (const c of arr) { const s = (c.symbol || '').toUpperCase(); if (s && !(bySym[s] || []).some((x) => x.id === id)) (bySym[s] ||= []).push({ id, name: id.replace(/-/g, ' '), overcrowded: false, src: 'coingecko-category', mcapRank: c.market_cap_rank, mcap: c.market_cap || null }); }
      }
    } catch {}
    return { bySym, themes, sources: src };
  });
}

// ---------------- aggregate ----------------
async function portfolio(q, req) {
  const wallets = [...new Set((q.get('wallets') || '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 10);
  if (!wallets.length) throw bad('wallets=addr1,addr2 required (Solana or EVM 0x… public addresses)');
  const only = q.get('chains') ? q.get('chains').split(',') : null;
  const res = await Promise.all(wallets.map(async (w) => {
    try {
      if (isEvm(w)) return await cached('pf:evm:' + w.toLowerCase() + ':' + (only || []).join(','), 180e3, () => evmWallet(w, only));
      if (isSol(w)) return await cached('pf:sol:' + w, 60e3, () => solWallet(w, req));
      return { address: w, error: 'not a Solana or EVM address' };
    } catch (e) { return { address: w, error: e.message }; }
  }));
  const narr = await narrativeContext().catch(() => ({ bySym: {}, themes: [], sources: [] }));
  let positions = res.flatMap((r) => r.positions || []);
  for (const p of positions) {
    const key = p.chain + ':' + p.mint;
    const cb = p.chain === 'solana' ? DB.costBasis[p.wallet]?.tokens?.[p.mint] : null;
    const manual = DB.entries[key];
    p.entryPrice = manual?.price ?? cb?.avgCostUsd ?? (STABLES.has(p.mint) ? 1 : null);
    p.entrySource = manual ? 'manual' : cb?.avgCostUsd ? `est. avg buy from ${cb.buys} swap(s)` : null;
    p.unrealizedUsd = p.entryPrice && p.priceUsd && p.valueUsd != null ? (p.priceUsd - p.entryPrice) * p.amount : null;
    p.unrealizedPct = p.entryPrice && p.priceUsd ? (p.priceUsd / p.entryPrice - 1) * 100 : null;
    // symbol match; CoinGecko-category matches must also agree on market cap (within 3x) to avoid same-ticker impostors
    p.narratives = p.native || ['SOL', 'WSOL', 'ETH', 'WETH', 'BNB', 'WBNB', 'AVAX', 'POL'].includes((p.symbol || '').toUpperCase()) || STABLES.has(p.mint) ? [{ id: 'majors', name: 'majors / stables', src: 'builtin' }]
      : (narr.bySym[(p.symbol || '').toUpperCase()] || []).filter((n) => n.src !== 'coingecko-category' || (n.mcap && p.mcap && n.mcap / p.mcap < 3 && p.mcap / n.mcap < 3)).map(({ mcap, mcapRank, ...n }) => n).slice(0, 4);
    p.dust = p.valueUsd != null && p.valueUsd < DUST_USD;
  }
  positions.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
  const total = positions.reduce((s, p) => s + (p.valueUsd || 0), 0);
  const hidden = { spamOrUnpriced: positions.filter((p) => p.valueUsd == null && !p.native).length, dust: positions.filter((p) => p.dust).length };
  if (q.get('all') !== '1') positions = positions.filter((p) => p.valueUsd != null || p.native || p.entryPrice != null && !STABLES.has(p.mint)).slice(0, 400);
  return {
    at: Date.now(), wallets: res.map((r) => ({ address: r.address, kind: r.kind, error: r.error, notes: r.notes, source: r.source, positions: (r.positions || []).length })),
    totalUsd: total, hidden, positions, narrativeSources: narr.sources, overcrowdedThemes: narr.themes.filter((t) => t.overcrowded).map((t) => t.name),
    method: { minLiquidityUsd: MIN_LIQ, dustUsd: DUST_USD, spam: 'Solana: unverified on Jupiter + organic score <10 + <$50K liquidity. EVM: not on the CoinGecko token list (never fetched) or no liquid market.', entry: 'manual entry > Solana swap-history estimate (avg buy price, SOL valued at the CoinGecko daily close) > none' },
  };
}

const GET = {
  '/api/portfolio': portfolio,
  '/api/portfolio/state': () => ({ wallets: DB.wallets, entries: DB.entries, costBasis: Object.fromEntries(Object.entries(DB.costBasis).map(([k, v]) => [k, { at: v.at, swaps: v.swaps, txsScanned: v.txsScanned, tokens: Object.keys(v.tokens).length }])) }),
  '/api/portfolio/costbasis': (q, req) => (q.get('job') ? (jobs.get(q.get('job')) || (() => { throw bad('job not found', 404); })()) : startCostBasis((q.get('address') || '').trim(), +q.get('limit') || 100, req)),
  '/api/portfolio/narratives': async () => { const n = await narrativeContext(); return { themes: n.themes, sources: n.sources, symbols: Object.keys(n.bySym).length }; },
};
const POST = {
  '/api/portfolio/wallets': (b) => { const w = (Array.isArray(b.wallets) ? b.wallets : []).map((x) => ({ address: String(x.address || '').trim(), label: String(x.label || '').slice(0, 40) })).filter((x) => isSol(x.address) || isEvm(x.address)).slice(0, 20); DB.wallets = w; save(); return { wallets: w }; },
  '/api/portfolio/entry': (b) => { const k = String(b.key || ''); if (!/^[a-z]+:[A-Za-z0-9]+$/.test(k)) throw bad('key must be chain:mint'); if (b.price == null || b.price === '') delete DB.entries[k]; else { const p = +b.price; if (!(p > 0)) throw bad('price must be > 0'); DB.entries[k] = { price: p, at: Date.now() }; } save(); return { key: k, entry: DB.entries[k] || null }; },
};
module.exports = { GET, POST, solWallet, evmWallet, encAggregate3, decAggregate3 };
