// asymmetric-terminal — READ-ONLY token dashboard backend (no keys, no signing, no trading).
// Zero dependencies: Node 20+ (built-in fetch). Proxies + caches public APIs.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const scanner = require('./lib/scanner');
const { cached, getJSON, postJSON } = require('./lib/util');
const { rpcFor } = require('./lib/solrpc');
const auth = require('./lib/auth');
const chains = require('./lib/chains');
const macro = require('./lib/macro');

const PORT = +process.env.PORT || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const PUB = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UA = { 'user-agent': 'Mozilla/5.0 (asymmetric-terminal read-only dashboard)' };
const DS = 'https://api.dexscreener.com';
const JUP = 'https://lite-api.jup.ag';
const RH_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const WSOL = 'So11111111111111111111111111111111111111112';
const PONS = '0x39dBED3a2bd333467115dE45665cC57F813C4571';
const PONS_FACTORY_V2 = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
// Event topics observed on the pons v2 factory (semantics inferred from on-chain data, see README)
const PONS_TOPIC_LAUNCH = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
const PONS_TOPIC_GRAD = '0x308c390ed1ab5873392818e036cabdf408bc8ad042fbaead3108954ff75ba980';

const CHAINS = new Set(chains.IDS);
const C = chains.CHAINS;
const isSolAddr = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '');
const isEvmAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(s || '');

// ---------- DexScreener helpers ----------
function summarizePair(p) {
  if (!p) return null;
  const info = p.info || {};
  return {
    chainId: p.chainId, dexId: p.dexId, labels: p.labels || [], url: p.url,
    pairAddress: p.pairAddress,
    address: p.baseToken?.address, name: p.baseToken?.name, symbol: p.baseToken?.symbol,
    quoteSymbol: p.quoteToken?.symbol, quoteAddress: p.quoteToken?.address,
    priceUsd: p.priceUsd != null ? +p.priceUsd : null,
    change: p.priceChange || {}, volume: p.volume || {}, txns: p.txns || {},
    liquidityUsd: p.liquidity?.usd ?? null, liquidityBase: p.liquidity?.base ?? null, liquidityQuote: p.liquidity?.quote ?? null,
    fdv: p.fdv ?? null, marketCap: p.marketCap ?? null, pairCreatedAt: p.pairCreatedAt ?? null,
    imageUrl: info.imageUrl || null, websites: info.websites || [], socials: info.socials || [],
    boosts: p.boosts?.active || 0,
  };
}
function bestPairs(pairs, wantAddrs) {
  const best = {};
  for (const p of pairs || []) {
    const a = p.baseToken?.address;
    if (!a) continue;
    const key = wantAddrs ? wantAddrs.find((w) => w.toLowerCase() === a.toLowerCase()) : a;
    if (!key) continue;
    if (!best[key] || (p.liquidity?.usd || 0) > (best[key].liquidity?.usd || 0)) best[key] = p;
  }
  return best;
}
async function dsTokens(chain, addrs) {
  const out = {};
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    const key = `ds:tok:${chain}:${chunk.join(',')}`;
    const pairs = await cached(key, 12000, () => getJSON(`${DS}/tokens/v1/${chain}/${chunk.join(',')}`));
    const best = bestPairs(pairs, chunk);
    for (const a of chunk) out[a] = summarizePair(best[a]) || null;
  }
  return out;
}
async function dsAllPairs(chain, addr) {
  return cached(`ds:pairs:${chain}:${addr}`, 20000, () => getJSON(`${DS}/token-pairs/v1/${chain}/${addr}`));
}
async function jupPrices(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const d = await cached(`jup:${chunk.join(',')}`, 10000, () => getJSON(`${JUP}/price/v3?ids=${chunk.join(',')}`));
      Object.assign(out, d || {});
    } catch (e) { /* degrade */ }
  }
  return out;
}
async function enrichList(chain, items) {
  // items: [{address, ...extra}] -> adds .pair summary from DexScreener
  const addrs = [...new Set(items.map((x) => x.address).filter(Boolean))];
  let map = {};
  try { map = await dsTokens(chain, addrs); } catch (e) {}
  return items.map((x) => ({ ...x, pair: map[x.address] || null }));
}

// ---------- Robinhood Chain (EVM) helpers ----------
async function evmCall(method, params, rpc = RH_RPC) {
  const d = await postJSON(rpc, { jsonrpc: '2.0', id: 1, method, params });
  if (d.error) throw new Error(d.error.message || 'rpc error');
  return d.result;
}
async function evmCallChain(chain, method, params) { return evmCall(method, params, C[chain].rpc); }
// Native coin prices (CoinGecko simple price, keyless, cached 60s) keyed by symbol
async function nativePrices() {
  const ids = [...new Set(chains.IDS.map((c) => C[c].cg).filter(Boolean)), 'bitcoin'];
  const d = await cached('cg:natives', 60000, () => getJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true`)).catch(() => ({}));
  const bySym = {};
  for (const c of chains.IDS) { const p = d[C[c].cg]; if (p) bySym[C[c].native] = { usd: p.usd, change24h: p.usd_24h_change }; }
  if (d.bitcoin) bySym.BTC = { usd: d.bitcoin.usd, change24h: d.bitcoin.usd_24h_change };
  return bySym;
}
async function quotePrices() {
  const n = await nativePrices(); const q = {};
  const map = { ETH: ['ETH', 'WETH'], BNB: ['BNB', 'WBNB'], POL: ['POL', 'WPOL', 'MATIC', 'WMATIC'], AVAX: ['AVAX', 'WAVAX'], SUI: ['SUI'], TON: ['TON', 'WTON', 'PTON'], TRX: ['TRX', 'WTRX'], SOL: ['SOL', 'WSOL'] };
  for (const [k, syms] of Object.entries(map)) if (n[k]) for (const s2 of syms) q[s2] = n[k].usd;
  return q;
}
// GeckoTerminal free tier is ~30 req/min shared by everything: serialize with a gap, retry once on 429.
let gtChain = Promise.resolve(), gtLast = 0;
function gtGet(url, timeout = 15000) {
  const run = async () => {
    for (let i = 0; i < 2; i++) {
      const wait = gtLast + 2100 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      gtLast = Date.now();
      try { return await getJSON(url, {}, timeout); } catch (e) { if (!/429/.test(e.message) || i) throw e; await new Promise((r) => setTimeout(r, 4000)); }
    }
  };
  const p = gtChain.then(run, run); gtChain = p.catch(() => {}); return p;
}
// GeckoTerminal pool -> {chain, address} of base token
function gtBase(pool) { const id = pool.relationships?.base_token?.data?.id || ''; const i = id.indexOf('_'); return i > 0 ? id.slice(i + 1) : null; }
const GT2DS = Object.fromEntries(chains.IDS.map((c) => [C[c].gt, c]));
async function gtPools(chain, kind) {
  const path = chain === 'all' ? `/networks/trending_pools?page=1` : `/networks/${C[chain].gt}/${kind === 'new' ? 'new_pools' : 'trending_pools'}?page=1`;
  const d = await cached('gt:list:' + chain + ':' + kind, 90000, () => gtGet('https://api.geckoterminal.com/api/v2' + path));
  return (d?.data || []).map((p) => ({ chain: chain === 'all' ? GT2DS[p.relationships?.network?.data?.id] : chain, address: gtBase(p), gtDex: p.relationships?.dex?.data?.id })).filter((x) => x.chain && x.address);
}
async function enrichMixed(items) {
  const by = {};
  for (const x of items) (by[x.chain] ||= []).push(x);
  const out = [];
  await Promise.all(Object.entries(by).map(async ([c, xs]) => { const r = await enrichList(c, xs); out.push(...r); }));
  const order = new Map(items.map((x, i) => [x.chain + ':' + x.address, i]));
  return out.sort((a, b) => order.get(a.chain + ':' + a.address) - order.get(b.chain + ':' + b.address));
}

function decodeAbiString(hex) {
  try {
    if (!hex || hex === '0x') return null;
    const h = hex.slice(2);
    if (h.length >= 128) {
      const len = parseInt(h.slice(64, 128), 16);
      return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, '');
    }
    return Buffer.from(h, 'hex').toString('utf8').replace(/\0/g, '').trim();
  } catch { return null; }
}

// ---------- multi-chain wallets (read-only) ----------
const toNum = (hex, dec) => Number(BigInt(hex || '0x0')) / 10 ** dec;
async function priceTokens(chain, addrs) { try { return await dsTokens(chain, addrs); } catch { return {}; } }
async function walletEvm(addr) {
  const n = await nativePrices();
  const natives = await Promise.all(chains.EVM.map(async (c) => {
    try { const b = toNum(await evmCallChain(c, 'eth_getBalance', [addr, 'latest']), 18); const px = n[C[c].native]?.usd; return { chain: c, symbol: C[c].native, amount: b, valueUsd: px ? b * px : null }; }
    catch (e) { return { chain: c, symbol: C[c].native, amount: null, error: e.message }; }
  }));
  let tokens = [], tokenNote = 'ERC-20 balances: Ethereum only (Ethplorer free key). Other EVM chains need a paid indexer (Alchemy/Moralis/Covalent).';
  try {
    const d = await cached('ethplorer:' + addr.toLowerCase(), 120000, () => getJSON(`https://api.ethplorer.io/getAddressInfo/${addr}?apiKey=freekey`, {}, 20000));
    tokens = (d.tokens || []).map((t) => { const dec = +t.tokenInfo.decimals || 0; const amt = +t.rawBalance / 10 ** dec; const pr = t.tokenInfo.price || {}; const px = pr.rate || null; const liquidPrice = px && (pr.volume24h || 0) >= 50000;
        return { chain: 'ethereum', mint: t.tokenInfo.address, symbol: t.tokenInfo.symbol, name: t.tokenInfo.name, amount: amt, priceUsd: px, valueUsd: liquidPrice ? amt * px : null, priceNote: px && !liquidPrice ? 'thin market, not valued' : undefined }; })
      .filter((t) => t.amount > 0).sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0)).slice(0, 60);
    // Value only tokens with a real DEX market: DexScreener pair with >= $50K liquidity (Ethplorer prices include airdrop spam)
    const liq = {};
    const addrs = tokens.map((t) => t.mint.toLowerCase());
    for (let i = 0; i < addrs.length; i += 30) {
      const chunk = addrs.slice(i, i + 30);
      const pairs = await cached('ds:tokv:eth:' + chunk.join(','), 60000, () => getJSON(`${DS}/tokens/v1/ethereum/${chunk.join(',')}`)).catch(() => []);
      for (const p of pairs || []) { const a = (p.baseToken?.address || '').toLowerCase(); const l = p.liquidity?.usd || 0; if (!liq[a] || l > liq[a].l) liq[a] = { l, px: +p.priceUsd || null }; }
    }
    for (const t of tokens) {
      const m = liq[t.mint.toLowerCase()];
      if (m && m.l >= 50000 && m.px && t.amount * m.px <= m.l) { t.priceUsd = m.px; t.valueUsd = t.amount * m.px; t.priceNote = undefined; }
      else if (m && m.px && m.l >= 50000) { t.priceUsd = m.px; t.valueUsd = null; t.priceNote = `position worth more than its whole pool (${Math.round(m.l)} USD liquidity), not valued`; }
      else { t.valueUsd = null; t.priceNote = 'no liquid DEX market, not valued'; }
    }
    tokens.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    tokenNote += ' Only tokens with a DexScreener pool of at least $50K liquidity, and positions smaller than that pool, are valued (airdrop spam is listed but not counted).';
  } catch (e) { tokenNote = 'Ethplorer failed: ' + e.message; }
  const total = natives.reduce((s2, x) => s2 + (x.valueUsd || 0), 0) + tokens.reduce((s2, t) => s2 + (t.valueUsd || 0), 0);
  return { kind: 'evm', address: addr, natives: natives.filter((x) => x.amount || x.error), tokens, totalUsd: total, rpc: 'publicnode.com + Robinhood public RPCs', note: tokenNote };
}
async function walletTon(addr) {
  const n = await nativePrices();
  const acc = await getJSON(`https://tonapi.io/v2/accounts/${encodeURIComponent(addr)}`, {}, 15000);
  const j = await getJSON(`https://tonapi.io/v2/accounts/${encodeURIComponent(addr)}/jettons?currencies=usd`, {}, 15000).catch(() => ({ balances: [] }));
  const ton = (+acc.balance || 0) / 1e9;
  const tokens = (j.balances || []).map((b) => { const dec = +b.jetton.decimals || 9; const amt = +b.balance / 10 ** dec; const px = b.price?.prices?.USD || null; return { chain: 'ton', mint: b.jetton.address, symbol: b.jetton.symbol, name: b.jetton.name, amount: amt, priceUsd: px, valueUsd: px ? amt * px : null, verified: b.jetton.verification === 'whitelist' }; })
    .filter((t) => t.amount > 0).sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
  const tv = n.TON ? ton * n.TON.usd : null;
  return { kind: 'ton', address: addr, natives: [{ chain: 'ton', symbol: 'TON', amount: ton, valueUsd: tv }], tokens, totalUsd: (tv || 0) + tokens.reduce((s2, t) => s2 + (t.valueUsd || 0), 0), rpc: 'tonapi.io (keyless)' };
}
async function walletTron(addr) {
  const n = await nativePrices();
  const d = await getJSON(`https://api.trongrid.io/v1/accounts/${addr}`, {}, 15000);
  const a = d.data?.[0] || {};
  const trx = (a.balance || 0) / 1e6;
  const raw = Object.assign({}, ...(a.trc20 || []));
  const px = await priceTokens('tron', Object.keys(raw).slice(0, 30));
  const tokens = Object.entries(raw).map(([m, v]) => { const p = px[m]; return { chain: 'tron', mint: m, symbol: p?.symbol || null, rawAmount: v, priceUsd: p?.priceUsd ?? null, amount: null, valueUsd: null }; }).filter((t) => t.symbol);
  const tv = n.TRX ? trx * n.TRX.usd : null;
  return { kind: 'tron', address: addr, natives: [{ chain: 'tron', symbol: 'TRX', amount: trx, valueUsd: tv }], tokens, totalUsd: tv || 0, rpc: 'TronGrid (keyless)', note: `${Object.keys(raw).length} TRC-20 balances; showing the ${tokens.length} with a DexScreener market among the first 30. Amounts raw (decimals need a per-token call); not in total.` };
}
async function walletSui(addr) {
  const n = await nativePrices();
  const q = `{ address(address:"${addr}") { balances(first:50){ nodes { coinType { repr } totalBalance } } } }`;
  const d = await postJSON('https://graphql.mainnet.sui.io/graphql', { query: q });
  const nodes = d?.data?.address?.balances?.nodes || [];
  const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
  const sui = nodes.find((x) => x.coinType.repr === SUI);
  const amt = sui ? +sui.totalBalance / 1e9 : 0;
  const tokens = nodes.filter((x) => x.coinType.repr !== SUI).map((x) => ({ chain: 'sui', mint: x.coinType.repr, symbol: x.coinType.repr.split('::').pop(), rawAmount: x.totalBalance, amount: null, valueUsd: null }));
  return { kind: 'sui', address: addr, natives: [{ chain: 'sui', symbol: 'SUI', amount: amt, valueUsd: n.SUI ? amt * n.SUI.usd : null }], tokens, totalUsd: n.SUI ? amt * n.SUI.usd : 0, rpc: 'Sui GraphQL (keyless)', note: 'Coin amounts raw (decimals need per-coin metadata).' };
}

// ---------- routes ----------
const routes = {
  async '/api/health'() { return { ok: true, time: new Date().toISOString(), readOnly: true, auth: auth.ENABLED }; },

  async '/api/chains'() { return { chains: chains.publicList(), natives: await nativePrices() }; },

  async '/api/search'(q) {
    const query = (q.get('q') || '').trim();
    if (!query) return { pairs: [] };
    const want = (q.get('chains') || 'all').split(',');
    const all = want.includes('all');
    const d = await cached(`ds:search:${query}`, 15000, () => getJSON(`${DS}/latest/dex/search?q=${encodeURIComponent(query)}`));
    // 'all' includes every DexScreener chain (unknown ones are shown but have no scanner/chart mapping)
    const pairs = (d.pairs || []).filter((p) => all || want.includes(p.chainId)).map(summarizePair);
    for (const p of pairs) p.supported = CHAINS.has(p.chainId);
    pairs.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
    return { pairs: pairs.slice(0, 40) };
  },

  // ?items=solana:MINT,robinhood:0x..
  async '/api/tokens'(q) {
    const items = (q.get('items') || '').split(',').map((s) => s.split(':')).filter(([c, a]) => CHAINS.has(c) && a);
    const byChain = {};
    for (const [c, a] of items) (byChain[c] ||= []).push(a);
    const result = {};
    await Promise.all(Object.entries(byChain).map(async ([c, addrs]) => {
      const m = await dsTokens(c, addrs).catch(() => ({}));
      for (const a of addrs) result[`${c}:${a}`] = m[a] || null;
    }));
    const solIds = [...new Set([WSOL, ...(byChain.solana || [])])];
    const jp = await jupPrices(solIds);
    for (const a of byChain.solana || []) {
      const k = `solana:${a}`;
      if (jp[a]) result[k] = { ...(result[k] || { address: a, chainId: 'solana' }), jupPrice: jp[a].usdPrice, jupChange24h: jp[a].priceChange24h };
    }
    return { tokens: result, sol: jp[WSOL] || null, natives: await nativePrices(), updatedAt: Date.now() };
  },

  // OHLCV candles from GeckoTerminal public API (free, no key, ~30 req/min)
  async '/api/ohlcv'(q) {
    const chain = CHAINS.has(q.get('chain')) ? q.get('chain') : 'solana';
    const pool = (q.get('pool') || '').split(':')[0];
    if (!/^[A-Za-z0-9:_\-]{20,140}$/.test(pool)) throw Object.assign(new Error('bad pool'), { status: 400 });
    const tf = ['minute', 'hour', 'day'].includes(q.get('tf')) ? q.get('tf') : 'minute';
    const agg = ['1', '4', '5', '12', '15'].includes(q.get('agg')) ? q.get('agg') : '15';
    const d = await cached(`gt:${chain}:${pool}:${tf}:${agg}`, 30000, () => gtGet(`https://api.geckoterminal.com/api/v2/networks/${C[chain].gt}/pools/${encodeURIComponent(pool)}/ohlcv/${tf}?aggregate=${agg}&limit=300&currency=usd`));
    const list = (d?.data?.attributes?.ohlcv_list || []).map(([t, o, h, l, c, v]) => ({ t: t * 1000, o, h, l, c, v })).sort((a, b) => a.t - b.t);
    return { candles: list, source: 'GeckoTerminal' };
  },

  async '/api/price'(q) {
    const ids = (q.get('ids') || WSOL).split(',').filter(isSolAddr).slice(0, 100);
    return { prices: await jupPrices(ids) };
  },

  // discovery: kind = boosts (trending) | profiles (new) | latestboosts ; chain = any registry chain or 'all'
  // DexScreener boosts/profiles first, topped up with GeckoTerminal trending / new pools for that network.
  async '/api/discover'(q) {
    const kind = q.get('kind') || 'boosts';
    const chain = q.get('chain') === 'all' ? 'all' : CHAINS.has(q.get('chain')) ? q.get('chain') : 'solana';
    const url = { boosts: '/token-boosts/top/v1', profiles: '/token-profiles/latest/v1', latestboosts: '/token-boosts/latest/v1' }[kind];
    if (!url) throw new Error('bad kind');
    const list = await cached(`ds:disc:${kind}`, 30000, () => getJSON(DS + url)).catch(() => []);
    const seen = new Set();
    let items = (list || []).filter((x) => (chain === 'all' ? CHAINS.has(x.chainId) : x.chainId === chain) && !seen.has(x.chainId + x.tokenAddress) && seen.add(x.chainId + x.tokenAddress))
      .slice(0, chain === 'all' ? 25 : 30).map((x) => ({ chain: x.chainId, address: x.tokenAddress, description: x.description || '', boost: x.totalAmount || x.amount || 0, icon: x.icon, src: 'ds' }));
    const sources = ['DexScreener ' + (kind === 'profiles' ? 'token profiles' : 'boosts')];
    if (items.length < 20 || chain === 'all') {
      try {
        const gt = await gtPools(chain, kind === 'profiles' ? 'new' : 'trending');
        const cap = chain === 'all' ? 45 : 30;
        for (const x of gt) if (items.length < cap && !seen.has(x.chain + x.address) && seen.add(x.chain + x.address)) items.push({ ...x, src: 'gt' });
        sources.push('GeckoTerminal ' + (chain === 'all' ? 'global trending' : kind === 'profiles' ? 'new pools' : 'trending pools'));
      } catch (e) { sources.push('GeckoTerminal failed: ' + e.message); }
    }
    const out = await enrichMixed(items);
    return { source: sources.join(' + '), items: out.filter((x) => x.pair || x.src === 'ds') };
  },

  async '/api/pumpfun'() {
    const d = await cached('pump:new', 15000, () => getJSON('https://frontend-api-v3.pump.fun/coins?offset=0&limit=30&sort=created_timestamp&order=DESC&includeNsfw=false', UA));
    return { items: (d || []).map((c) => ({ address: c.mint, name: c.name, symbol: c.symbol, image: c.image_uri, createdAt: c.created_timestamp, marketCapUsd: c.usd_market_cap, complete: c.complete, replies: c.reply_count, creator: c.creator })) };
  },

  // Ecosystems
  async '/api/eco/stonkfun'(q) {
    const sort = ['volume', 'newest', 'marketCap'].includes(q.get('sort')) ? q.get('sort') : 'volume';
    const d = await cached(`stonk:${sort}`, 20000, () => getJSON(`https://www.stonkfun.xyz/api/public/v1/tokens?sort=${sort}&pageSize=30`, UA));
    const items = (d?.data?.tokens || []).map((t) => ({
      address: t.mint, name: t.name, symbol: t.symbol, image: t.imageUrl, quoteSymbol: t.quote?.symbol, quoteCategory: t.quote?.categoryLabel,
      priceUsd: t.market?.priceUsd, marketCapUsd: t.market?.marketCapUsd, volume24hUsd: t.market?.volume24hUsd, liquidityUsd: t.market?.liquidityUsd,
      change24h: t.market?.priceChange24h, status: t.status, mode: t.mode, transferFeeBps: t.transferFee?.bps || 0, createdAt: t.createdAt ? Date.parse(t.createdAt) : null,
    }));
    return { source: 'stonkfun.xyz public API v1', items };
  },
  async '/api/eco/robinhood'() {
    const [boosts, profiles, s1, s2] = await Promise.all([
      cached('ds:disc:boosts', 30000, () => getJSON(DS + '/token-boosts/top/v1')).catch(() => []),
      cached('ds:disc:profiles', 30000, () => getJSON(DS + '/token-profiles/latest/v1')).catch(() => []),
      cached('ds:search:USDG', 30000, () => getJSON(`${DS}/latest/dex/search?q=USDG`)).catch(() => ({})),
      cached('ds:search:robinhood', 30000, () => getJSON(`${DS}/latest/dex/search?q=robinhood`)).catch(() => ({})),
    ]);
    const addrs = new Set([PONS]);
    for (const x of [...boosts, ...profiles]) if (x.chainId === 'robinhood') addrs.add(x.tokenAddress);
    for (const p of [...(s1.pairs || []), ...(s2.pairs || [])]) if (p.chainId === 'robinhood' && !/^(WETH|USDG|ETH)$/i.test(p.baseToken.symbol)) addrs.add(p.baseToken.address);
    const items = await enrichList('robinhood', [...addrs].map((a) => ({ address: a })));
    items.sort((a, b) => (b.pair?.volume?.h24 || 0) - (a.pair?.volume?.h24 || 0));
    return { source: 'DexScreener chainId=robinhood (boosts, profiles, searches)', items: items.filter((x) => x.pair) };
  },
  // Fomo (fomo.family) — no official public API. Optional: unofficial fomoapi.io key via env FOMOAPI_KEY.
  async '/api/eco/fomo'(q) {
    const board = ['trending', 'graduated', 'most-held'].includes(q.get('board')) ? q.get('board') : 'trending';
    const key = process.env.FOMOAPI_KEY;
    if (!key) return { source: 'fomo.family has no official public API', unavailable: true, items: [],
      note: 'fomo.family publishes no keyless token feed. The unofficial, unaffiliated fomoapi.io mirrors FOMO\'s trending/graduated/most-held boards but requires an API key (free tier: 1,000 calls/month). Start the server with FOMOAPI_KEY=<key> to enable this tab.' };
    const d = await cached(`fomo:${board}`, 120000, async () => {
      const r = await fetch(`https://api.fomoapi.io/v2/leaderboard/tokens/${board}?limit=25`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('fomoapi HTTP ' + r.status); return r.json();
    });
    const toks = (d.tokens || []).filter((t) => t.network === 'solana' || t.network === 'robinhood');
    const sol = await enrichList('solana', toks.filter((t) => t.network === 'solana').map((t) => ({ address: t.token.address, fomoRank: t.rank, holders: t.holders })));
    const rh = await enrichList('robinhood', toks.filter((t) => t.network === 'robinhood').map((t) => ({ address: t.token.address, fomoRank: t.rank, holders: t.holders })));
    return { source: `fomoapi.io (unofficial) ${board} board, captured ${d.capturedAt || '?'}`, items: [...sol.map((x) => ({ ...x, chain: 'solana' })), ...rh.map((x) => ({ ...x, chain: 'robinhood' }))].sort((a, b) => a.fomoRank - b.fomoRank) };
  },

  // four.meme (BSC launchpad): pools on GeckoTerminal dex id "four-meme" (keyless), enriched via DexScreener
  async '/api/eco/fourmeme'() {
    const d = await cached('gt:fourmeme', 90000, () => gtGet('https://api.geckoterminal.com/api/v2/networks/bsc/dexes/four-meme/pools?page=1&sort=h24_volume_usd_desc'));
    const items = (d?.data || []).map((p) => ({ chain: 'bsc', address: gtBase(p), gtName: p.attributes?.name, gtVol24: +p.attributes?.volume_usd?.h24 || 0 })).filter((x) => x.address);
    const out = await enrichList('bsc', items);
    out.sort((a, b) => (b.pair?.volume?.h24 || b.gtVol24) - (a.pair?.volume?.h24 || a.gtVol24));
    return { source: 'GeckoTerminal bsc dex four-meme + DexScreener', items: out };
  },

  async '/api/eco/pons'() {
    return cached('eco:pons', 60000, async () => {
      const head = parseInt(await evmCall('eth_blockNumber', []), 16);
      const logs = async (topic, span) => evmCall('eth_getLogs', [{ address: PONS_FACTORY_V2, topics: [topic], fromBlock: '0x' + (head - span).toString(16), toBlock: 'latest' }]);
      const [grads, launches] = await Promise.all([logs(PONS_TOPIC_GRAD, 3000000).catch(() => []), logs(PONS_TOPIC_LAUNCH, 60000).catch(() => [])]);
      const gradTokens = [...new Set(grads.map((l) => '0x' + l.topics[1].slice(-40)).reverse())].slice(0, 30);
      const graduated = (await enrichList('robinhood', [{ address: PONS, note: 'PONS (launchpad token)' }, ...gradTokens.map((a) => ({ address: a }))]));
      const notIdx = graduated.filter((x) => !x.pair).slice(0, 15);
      await Promise.all(notIdx.map(async (r) => {
        try { r.symbol = decodeAbiString(await evmCall('eth_call', [{ to: r.address, data: '0x95d89b41' }, 'latest'])); } catch {}
        try { const m = await getJSON(`https://api.ponsapi.dev/v1/tokens/${r.address}/price`); r.ponsapi = { priceUsd: m.priceUsd, mcapUsd: m.mcapUsd, kind: m.kind, graduated: m.graduated }; } catch {}
      }));
      const recent = launches.slice(-12).reverse().map((l) => ({ address: '0x' + l.topics[1].slice(-40), block: parseInt(l.blockNumber, 16) }));
      await Promise.all(recent.map(async (r) => { try { r.symbol = decodeAbiString(await evmCall('eth_call', [{ to: r.address, data: '0x95d89b41' }, 'latest'])); } catch {} }));
      let ponsMarket = null;
      try { ponsMarket = await getJSON(`https://api.ponsapi.dev/v1/tokens/${PONS}/price`); } catch {}
      return {
        source: 'Robinhood Chain public RPC eth_getLogs on pons v2 factory ' + PONS_FACTORY_V2 + ' + DexScreener',
        headBlock: head, launchesLastWindow: launches.length, launchWindowBlocks: 60000, graduationsInWindow: grads.length,
        graduated: graduated.filter((x) => x.pair), graduatedNotIndexed: notIdx, graduatedNotIndexedCount: graduated.filter((x) => !x.pair).length, recentLaunches: recent, ponsMarket,
      };
    });
  },

  async '/api/macro'() { return macro.snapshot(); },
  async '/api/news'() { return macro.news(); },
  async '/api/macro/events'() { return readData('macro_events.json'); },

  async '/api/moon/analysis'() { return readData('analysis.json'); },
  async '/api/moon/screener'() { return readData('screener.json'); },
  async '/api/moon/status'() {
    let log = ''; try { log = fs.readFileSync(path.join(DATA_DIR, 'collect.log'), 'utf8').split('\n').slice(-6).join('\n'); } catch {}
    return { log };
  },

  async '/api/wallet'(q, req) {
    const addr = (q.get('address') || '').trim();
    const kinds = chains.guessKinds(addr);
    if (kinds.includes('evm')) return walletEvm(addr);
    if (kinds.includes('ton')) return walletTon(addr);
    if (kinds.includes('tron')) return walletTron(addr);
    if (kinds.includes('sui') && !addr.includes('::')) return walletSui(addr);
    if (!isSolAddr(addr)) throw Object.assign(new Error('Not a recognized Solana / EVM / Sui / TON / Tron address'), { status: 400 });
    const rpc = rpcFor(req);
    const [bal, t1, t2] = await Promise.all([
      rpc.call('getBalance', [addr]),
      rpc.call('getTokenAccountsByOwner', [addr, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]),
      rpc.call('getTokenAccountsByOwner', [addr, { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }, { encoding: 'jsonParsed' }]).catch(() => ({ value: [] })),
    ]);
    const agg = {};
    for (const acc of [...(t1.value || []), ...(t2.value || [])]) {
      const info = acc.account.data.parsed.info;
      const ui = +info.tokenAmount.uiAmountString;
      if (!ui) continue;
      agg[info.mint] = (agg[info.mint] || 0) + ui;
    }
    const mints = Object.keys(agg);
    const prices = await jupPrices([WSOL, ...mints]);
    let meta = {};
    try {
      for (let i = 0; i < mints.length; i += 100) {
        const chunk = mints.slice(i, i + 100);
        const d = await cached(`jupmeta:${chunk.join(',')}`, 600000, () => getJSON(`${JUP}/tokens/v2/search?query=${chunk.join(',')}`));
        for (const t of d || []) meta[t.id] = { symbol: t.symbol, name: t.name, icon: t.icon, verified: t.isVerified };
      }
    } catch {}
    const sol = bal.value / 1e9;
    const solPrice = prices[WSOL]?.usdPrice || null;
    const tokens = mints.map((m) => ({ mint: m, amount: agg[m], priceUsd: prices[m]?.usdPrice ?? null, valueUsd: prices[m]?.usdPrice ? prices[m].usdPrice * agg[m] : null, ...(meta[m] || {}) }))
      .sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    const total = (solPrice ? sol * solPrice : 0) + tokens.reduce((s, t) => s + (t.valueUsd || 0), 0);
    return { kind: 'solana', address: addr, sol, solPrice, solValueUsd: solPrice ? sol * solPrice : null, natives: [{ chain: 'solana', symbol: 'SOL', amount: sol, valueUsd: solPrice ? sol * solPrice : null }], tokens: tokens.map((t) => ({ ...t, chain: 'solana' })), totalUsd: total, rpc: rpc.label };
  },

  async '/api/scan'(q, req) {
    const chain = CHAINS.has(q.get('chain')) ? q.get('chain') : 'solana';
    const address = (q.get('address') || '').trim();
    if (!chains.validAddr(chain, address)) throw Object.assign(new Error(`Not a valid ${C[chain].name} token address`), { status: 400 });
    const deep = q.get('deep') === '1' && chain === 'solana';
    const ctx = { rpc: rpcFor(req), dsAllPairs, jupPrices, evmCall, evmCallChain, decodeAbiString, summarizePair, quotePrices: await quotePrices() };
    return scanner.scan(chain, address, deep, ctx);
  },
};

function readData(f) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); }
  catch { throw Object.assign(new Error(f + ' not generated yet — run research/run.sh'), { status: 404 }); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

// Simple per-IP rate limit (PUBLIC_MODE): protects the free upstream APIs when hosted publicly.
const hits = new Map();
function limited(req, key, max, winMs) {
  if (!process.env.PUBLIC_MODE) return false;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const k = ip + '|' + key, now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < winMs);
  arr.push(now); hits.set(k, arr);
  return arr.length > max;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.length || n - v[v.length - 1] > 600e3) hits.delete(k); }, 300e3).unref();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (await auth.gate(req, res, u)) return;
  if (u.pathname.startsWith('/api/')) {
    const deep = u.pathname === '/api/scan' && u.searchParams.get('deep') === '1';
    if (limited(req, 'api', 240, 60e3) || (deep && limited(req, 'deep', 4, 60e3))) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":"rate limited, slow down"}'); }
    const h = routes[u.pathname];
    if (!h) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not found"}'); }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    try {
      const data = await h(u.searchParams, req);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(e.status || 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '\\') p = '/index.html';
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  });
});
server.listen(PORT, HOST, () => console.log(`[asymmetric-terminal] read-only dashboard on http://${HOST}:${PORT}${auth.ENABLED ? ` (password-protected, user '${auth.USER}')` : ' (open: SITE_PASSWORD not set)'}`));
