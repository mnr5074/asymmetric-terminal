// asymmetric-terminal — READ-ONLY token dashboard backend (no keys, no signing, no trading).
// Zero dependencies: Node 20+ (built-in fetch). Proxies + caches public APIs.
'use strict';
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const scanner = require('./lib/scanner');
const { cached, getJSON, postJSON } = require('./lib/util');
const { rpcFor } = require('./lib/solrpc');
const auth = require('./lib/auth');
const chains = require('./lib/chains');
const macro = require('./lib/macro');
const { createLiveFeed } = require('./lib/livefeed');
const { createCalls } = require('./lib/calls');
const { createRugRisk } = require('./lib/rugrisk');
const { createAlerts } = require('./lib/alerts');
const { createDesks } = require('./lib/desks');
const { createNansen } = require('./lib/nansen');
const { createX } = require('./lib/xapi');
const { exitPlan, atrFromMarket } = require('./lib/exitplan');
const crashmatch = require('./lib/crashmatch');
const { createNarratives } = require('./lib/narratives');
const { createPerps } = require('./lib/perps'); // Perp Desk (funding/OI, setups)
const { createComposite } = require('./lib/composite');
const { createUnlocks } = require('./lib/unlocks');
const { createLiquidations } = require('./lib/liquidations'); // liquidation cascade detector
const { createPriceGaps } = require('./lib/pricegaps'); // cross-exchange price gaps
const { createFundingDiv } = require('./lib/fundingdiv'); // funding-rate divergence episodes
const { createOrderbook } = require('./lib/orderbook'); // L2 spoofing / thin-book detector
const tradeapi = require('./lib/tradeapi'); // wallet-approved swaps + sandwich log (never holds keys)
const taxapi = require('./lib/tax/api'); // Tax desk: private ledger in data/tax (lib/tax/*)

// RENDER_LITE: small-instance mode (Render Starter = 512 MB). Auto-on when RENDER is set (Render injects it) or RENDER_LITE=1;
// RENDER_LITE=0 forces it off. Skips every background collector/refresh loop and python spawn; data/*.json is served read-only.
const RENDER_LITE = process.env.RENDER_LITE === '1' || (!!process.env.RENDER && process.env.RENDER_LITE !== '0');
if (process.env.RENDER && process.env.ALERTS_ENABLED === undefined) process.env.ALERTS_ENABLED = '0'; // box already sends alerts: no duplicates
if (RENDER_LITE) {
  for (const k of ['PERPS', 'ORDERBOOK', 'LIQ', 'GAPS', 'DERIVE', 'PRIORITY', 'POOLWATCH', 'FAKEVOL', 'COPYTRADE', 'GROK', 'KEYHEALTH', 'RISKINFRA']) process.env[k] = 'off';
  process.env.RENDER_LITE = '1'; // lib/* module timers check this
  process.env.LIVE_FEED = 'off'; process.env.NO_AUTO_REFRESH = '1'; process.env.RUN_RESEARCH = '0';
  console.log('[asymmetric-terminal] RENDER_LITE on: background collectors/refresh loops disabled, serving data/*.json read-only');
}

const PORT = +process.env.PORT || 8000;
const HOST = process.env.HOST || '0.0.0.0';
const PUB = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const prov = require('./lib/provenance'); prov.start({ dataDir: DATA_DIR }); // data provenance: upstream-fetch registry + audit log data/provenance_log.jsonl (lib/provenance.js)
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
  async '/api/whoami'(q, req) { return { user: req.authUser || null, role: req.authRole || (auth.ENABLED ? null : 'owner'), lite: RENDER_LITE }; },
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

  // Options screener (research/options.py -> data/options.json); refreshed in the background when older than 30 min
  async '/api/options'() { return withRefresh('options.json', 'options.py', 30 * 60e3); },
  // Airdrop / points campaigns (research/airdrops.py -> data/airdrops.json); refreshed when older than 6 h
  async '/api/airdrops'() { return withRefresh('airdrops.json', 'airdrops.py', 6 * 3600e3); },
  // Recent Solana blockhash for transactions the USER builds and signs in Phantom (server never sees keys or signs)
  async '/api/sol/blockhash'(q, req) {
    const r = await rpcFor(req).call('getLatestBlockhash', [{ commitment: 'finalized' }]);
    return { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight };
  },
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

// ---------- desks: Crypto (live feed + rug forecast + call log + alerts), Options, Macro, News, Airdrops, Sleepers ----------
const LIVE = process.env.LIVE_FEED || 'full'; // full | lite | off
const L = (m) => console.log('[desks] ' + m);
const rug = createRugRisk({ DATA_DIR, getJSON, cached, evmCallChain, chains, log: L });
const nansen = createNansen({ DATA_DIR, log: L });
const xapi = createX({ DATA_DIR, log: L });
const live = createLiveFeed({ getJSON, cached, gtGet, dsTokens, DATA_DIR, chains, rug, nansen, mode: LIVE, log: L,
  scan: async (chain, address, deep) => scanner.scan(chain, address, deep, { rpc: rpcFor({ headers: {} }), dsAllPairs, jupPrices, evmCall, evmCallChain, decodeAbiString, summarizePair, quotePrices: await quotePrices() }) });
const calls = createCalls({ DATA_DIR, dsTokens, live, log: L });
const alerts = createAlerts({ DATA_DIR, log: L });
const desks = createDesks({ DATA_DIR, live, calls, rug, macro, nansen, readData: (f) => readData(f), log: L });
live.onCycle(async (feed, items, newA) => {
  if (xapi.enabled) for (const it of items) { const xf = xapi.features(it.symbol); if (xf && it.features) Object.assign(it.features, xf); }
  await calls.onCycle(feed, items); await alerts.onFeed(feed, items, newA.map((x) => x.key), calls);
  // alerted A-grade tokens: who bought/sold (7d) + 1d flows, budget-capped
  if (nansen.enabled) for (const x of items.filter((i) => newA.some((n) => n.key === i.key)).slice(0, 2)) { await nansen.flow(x.chain, x.address, '1d', 'wbs_alert'); await nansen.whoBoughtSold(x.chain, x.address); }
});
async function nansenHousekeeping() {
  if (!nansen.enabled) return;
  try { await nansen.account(); await nansen.netflow(); const lc = nansen.lowCredit(); if (lc) await alerts.notice('nansen-low-' + lc.month, lc.text); } catch (e) { L('nansen: ' + e.message); }
}
async function xHousekeeping() {
  if (!xapi.enabled) return;
  const al = alerts.status().recent.filter((r) => r.key && Date.now() - r.t < 24 * 3600e3).map((r) => (live.feed().items.find((i) => i.key === r.key) || {}).symbol);
  const top = live.feed().items.filter((x) => (x.grade === 'A' || x.grade === 'B') && !x.veto).slice(0, 8).map((x) => x.symbol);
  let opt = []; try { const seen = new Set(); for (const p of readData('options.json').picks) if (p.grade === 'A' && !p.venue.startsWith('Derive') && !seen.has(p.underlying) && seen.add(p.underlying) && seen.size <= 4) opt.push(p.underlying); } catch {}
  await xapi.refresh(al, [...top, ...opt]);
}
if (LIVE !== 'off') { setTimeout(xHousekeeping, 60000); setInterval(xHousekeeping, 30 * 60e3).unref(); }
if (LIVE !== 'off') { setTimeout(nansenHousekeeping, 15000); setInterval(nansenHousekeeping, 3600e3).unref(); }
if (LIVE !== 'off') { live.start(+(process.env.LIVE_INTERVAL_MS || 60e3)); desks.start(); }
// QCAT/STRK pool monitor (lib/poolwatch.js -> data/poolwatch.json): reserves, LP supply, LP deposits every 15 min
const poolwatch = require('./lib/poolwatch').createPoolWatch({ DATA_DIR, log: L, intervalMs: +(process.env.POOLWATCH_MS || 15 * 60e3) });
if (LIVE !== 'off' && process.env.POOLWATCH !== 'off') poolwatch.start();
routes['/api/poolwatch'] = async () => poolwatch.status();
Object.assign(routes, {
  async '/api/live'(q) { const f = live.feed(); const g = q.get('grade'), ch = q.get('chain'); let items = f.items; if (g) items = items.filter((x) => g.split(',').includes(x.grade)); if (ch && ch !== 'all') items = items.filter((x) => x.chain === ch); return { ...f, items: items.slice(0, +(q.get('limit') || 150)), status: live.status() }; },
  async '/api/live/token'(q) { const k = q.get('key') || ''; const r = live.token(k); if (!r) throw Object.assign(new Error('not in live universe'), { status: 404 }); return { record: r, calls: calls.forKey(k) }; },
  async '/api/calls'(q) { return { calls: calls.list({ grade: q.get('grade'), limit: +(q.get('limit') || 200) }), total: calls.count() }; },
  async '/api/reportcard'() { const r = calls.reportCard(); for (const [f, k] of [['calls_options.json', 'options'], ['calls_airdrops.json', 'airdrops'], ['calls_sleepers.json', 'sleepers']]) { try { r[k] = readData(f).summary || null; } catch { r[k] = null; } } return { ...r, missed: calls.missedWinners(), recal: calls.recalState(), weights: live.getWeights() }; },
  async '/api/rug/cases'() { const d = readData('rug_cases.json') || {}; return { ...d, forensics: require('./lib/precedents').all() }; },
  async '/api/rug/watch'() { const f = live.feed(); return { generatedAt: f.generatedAt, items: f.items.filter((x) => x.rug && (x.rug.score >= 25 || x.rug.dump30)).sort((a, b) => b.rug.score - a.rug.score).slice(0, 60) }; },
  async '/api/rug/token'(q) { const chain = CHAINS.has(q.get('chain')) ? q.get('chain') : 'solana'; const a = (q.get('address') || '').trim(); if (!chains.validAddr(chain, a)) throw Object.assign(new Error('bad address'), { status: 400 });
    const rec = live.token(chain + ':' + a) || { chain, address: a, m: {}, snaps: [], holdersHist: [] };
    if (!rec.scan) { try { const s = await routes['/api/scan'](new URLSearchParams({ chain, address: a }), { headers: {} }); rec.scan = s; const p = s.market?.pair || s.pairs?.[0]; if (p) rec.m = { mc: p.marketCap, fdv: p.fdv, liq: p.liquidity, px: p.priceUsd }; } catch {} }
    return rug.established(chain, a, rec); },
  // Exit Plan / Rug Warning card for any token (watchlist / held): live record if tracked, else on-demand scan + rug assessment
  async '/api/exitplan'(q) {
    const chain = CHAINS.has(q.get('chain')) ? q.get('chain') : 'solana'; const a = (q.get('address') || '').trim();
    if (!chains.validAddr(chain, a)) throw Object.assign(new Error('bad address'), { status: 400 });
    const li = live.feed().items.find((x) => x.key === chain + ':' + a);
    if (li?.exit) return { source: 'live feed', symbol: li.symbol, rug: li.rug, exit: li.exit };
    return cached('exitplan:' + chain + ':' + a, 10 * 60e3, async () => {
      const rr = await routes['/api/rug/token'](new URLSearchParams({ chain, address: a }));
      const pairs = await dsAllPairs(chain, a).catch(() => []); const p = (pairs || []).sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))[0];
      if (!p) throw Object.assign(new Error('no trading pair found'), { status: 404 });
      const m = { px: +p.priceUsd, mc: p.marketCap, fdv: p.fdv, liq: p.liquidity?.usd, ch: p.priceChange || {} };
      const ch30 = rr.fundamentals?.coingecko?.ch30; const ath = rr.fundamentals?.coingecko?.ath;
      // inverse detector: daily GeckoTerminal candles (free: last 180 days) vs pre-crash fingerprints
      let crash = null;
      try { const net = C[chain]?.gt; if (net) { const pool = String(p.pairAddress).split(':')[0];
        const d = await cached(`gtday:${chain}:${pool}`, 6 * 3600e3, () => gtGet(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${encodeURIComponent(pool)}/ohlcv/day?aggregate=1&limit=180&currency=usd`));
        const L = (d?.data?.attributes?.ohlcv_list || []).slice().sort((x, y) => x[0] - y[0]);
        crash = crashmatch.match(DATA_DIR, L.map((x) => +x[4]), L.map((x) => +x[5] || 0)); } } catch (e) { crash = { ok: false, why: 'daily candles unavailable' }; }
      const bump = crashmatch.riskBump(crash); if (bump) rr.score = Math.min(100, (rr.score || 0) + bump);
      const ex = exitPlan({ symbol: p.baseToken?.symbol, price: m.px, crash, high: Math.max(m.px, m.px / (1 + (m.ch.h24 || 0) / 100) * (1 + Math.max(0, m.ch.h24 || 0) / 100)), atrPct: atrFromMarket(m), rug: rr,
        facts: { circRatio: rr.fundamentals?.circRatio ?? (m.mc && m.fdv && m.fdv > m.mc * 1.05 ? m.mc / m.fdv : null), runMultiple: ch30 != null ? 1 + ch30 / 100 : null, runDays: ch30 != null ? 30 : null,
          insiderToExchanges: (rr.signals || []).find((x) => /exchanges/.test(x.why))?.why || null } });
      return { source: 'on-demand', symbol: p.baseToken?.symbol, rug: { score: rr.score, level: rr.level, dump30: rr.dump30, crashBump: bump }, exit: ex, ath, crash };
    });
  },
  async '/api/exitplan/replays'() { return readData('exit_replays.json'); },
  async '/api/crash/catalog'() {
    const d = readData('crash_catalog.json'); if (!d) return { ok: false };
    const fin = readData('crash_catalog_final.json'); const st = new Map((fin?.coingecko_coins || []).map((c) => [c.id, c]));
    const catalog = (d.catalog || []).map((x) => { const c = st.get(x.id); return c ? { ...x, peak_status: c.status, peak_mcap_confirmed: c.peak_mcap ?? null, peak_date_confirmed: c.peak_date ?? null } : x; });
    return { ...d, catalog, bad_tick_rule: fin?.bad_tick_rule, fingerprints: d.fingerprints.map(({ fp, ...r }) => r) };
  },
  async '/api/crash/leaderboard'() {
    const fin = readData('crash_catalog_final.json'); const mo = readData('macro_overlay.json');
    if (!fin) return { ok: false };
    return { ok: true, generatedAt: fin.generatedAt, since: fin.window_since, rule: fin.bad_tick_rule, leaderboard: fin.leaderboard, forensics: fin.forensics, eco_counts: fin.eco_counts,
      macro: mo ? { now: mo.now, base_rates: mo.base_rates, note: mo.note } : null, label: 'Research summary from free data. Not financial advice.' };
  },
  async '/api/sleepers'() { return withRefresh('sleepers.json', 'sleepers.py', 24 * 3600e3); },
  async '/api/desks'() { return { ...desks.all(), nansen: nansen.status(), x: xapi.enabled ? { status: xapi.status(), items: xapi.all() } : { enabled: false } }; },
  async '/api/x'() { return xapi.enabled ? { ...xapi.status(), items: xapi.all(), predictive: calls.featureSplit('xTone') } : { enabled: false }; },
  async '/api/nansen/status'() { return nansen.status(); },
  async '/api/nansen/token'(q) { const chain = CHAINS.has(q.get('chain')) ? q.get('chain') : 'solana'; const a = (q.get('address') || '').trim(); if (!chains.validAddr(chain, a)) throw Object.assign(new Error('bad address'), { status: 400 });
    const tf = q.get('tf') === '7d' ? '7d' : '1d';
    const flow = q.get('fetch') === '1' ? await nansen.flow(chain, a, tf, 'ondemand') : { summary: nansen.peekFlow(chain, a, tf), cached: true };
    return { enabled: nansen.enabled, flow, netflow: nansen.netflowFor(chain, a), status: { creditsRemaining: nansen.status().creditsRemaining, usedToday: nansen.status().usedToday, dailyCap: nansen.status().dailyCap } }; },
  async '/api/alerts'() { return alerts.status(); },
  async '/api/alerts/test'() { return alerts.test('Asymmetric Terminal test alert'); },
});

// ---------- Perp Desk: funding/OI flags, composite A–F grade, unlocks, perp setups (lib/perps.js, lib/composite.js, lib/unlocks.js) ----------
const perps = createPerps({ DATA_DIR, log: L });
const unlocksMod = createUnlocks({ DATA_DIR, log: L });
const liquidations = createLiquidations({ DATA_DIR, perps, log: L });
const pricegaps = createPriceGaps({ DATA_DIR, perps, log: L });
const fundingdiv = createFundingDiv({ DATA_DIR, perps, log: L });
const orderbook = createOrderbook({ DATA_DIR, perps, log: L });
const composite = createComposite({ DATA_DIR, perps, unlocks: unlocksMod, macro, live, liquidations, pricegaps, fundingdiv, log: L });
if (process.env.PERPS !== 'off') { perps.start(); if (process.env.LIQ !== 'off') liquidations.start(); if (process.env.GAPS !== 'off') pricegaps.start(); fundingdiv.start(); if (process.env.ORDERBOOK !== 'off') orderbook.start(); }
async function compositeCached() { return cached('composite:all', 60e3, () => composite.compute()); }
Object.assign(routes, {
  async '/api/perps'(q) {
    const wl = (q.get('wl') || '').split(',').filter(Boolean).slice(0, 60).map((x) => { const [sym, px] = x.split(':'); return { sym, price: +px || null }; });
    if (wl.length) perps.addWatch(wl);
    const s = perps.snapshot(); if (!s.generatedAt) throw Object.assign(new Error('perp snapshot warming up (first fetch takes ~10s), try again shortly'), { status: 503 });
    let comp = null; try { comp = await compositeCached(); } catch {}
    const cBy = new Map((comp?.tokens || []).filter((t) => t.kind === 'perp').map((t) => [t.sym, t]));
    const mac = comp?.macro;
    const setups = s.tokens.map((t) => { const ua = unlocksMod.assess(unlocksMod.find({ sym: t.sym, cgId: t.cgId, price: t.mark })); return perps.setupFor(t, { composite: cBy.get(t.sym), macro: mac?.within ? { within: true, text: mac.near.map((x) => `${x.label} ${x.date}`).join(', ') } : null, unlock: ua }); }).filter(Boolean)
      .map((x) => ({ ...x, grade: cBy.get(x.sym)?.grade || null }))
      .sort((a, b) => (a.type === 'composite tilt') - (b.type === 'composite tilt') || Math.abs(b.funding.annPct) - Math.abs(a.funding.annPct));
    const flagged = s.tokens.filter((t) => t.flags.length).sort((a, b) => Math.abs(b.fAnn) - Math.abs(a.fAnn));
    return { ...s, flaggedCount: flagged.length, flagged: flagged.map((t) => t.sym), setups, nfa: 'Model estimates from public exchange data. Not financial advice. Nothing here trades.' };
  },
  async '/api/composite'(q) { const c = await compositeCached(); const k = q.get('kind'); return k ? { ...c, tokens: c.tokens.filter((t) => t.kind === k) } : c; },
  async '/api/liquidations'() {
    const s = liquidations.snapshot(); let comp = null; try { comp = await compositeCached(); } catch {}
    const cBy = new Map((comp?.tokens || []).filter((t) => t.kind === 'perp').map((t) => [t.sym, t]));
    let hist = null; try { hist = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'liquidations_history.json'), 'utf8')); delete hist.sample_crash_days; } catch {}
    return { ...s, assets: (s.assets || []).map((a) => { const c = cBy.get(a.sym); const cf = c?.factors.find((f) => f.key === 'crash'); return { ...a, grade: c?.grade || null, crash: cf && cf.available !== false ? { score: cf.score, value: cf.value } : null }; }), history: hist };
  },
  async '/api/fundingdiv'() { return fundingdiv.snapshot(); },
  async '/api/orderbook'() { return orderbook.snapshot(); },
  async '/api/pricegaps'() {
    const s = pricegaps.snapshot(); let hist = null; try { const h = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pricegaps_history.json'), 'utf8')); const { tokens, ...rest } = h; hist = { ...rest, topGapProne: Object.entries(tokens || {}).sort((a, b) => b[1].gapDayPct - a[1].gapDayPct).slice(0, 25).map(([sym, v]) => ({ sym, ...v })) }; } catch {}
    return { ...s, history: hist };
  },
  async '/api/unlocks'(q) { return { ...unlocksMod.status(), days: 30, tokens: unlocksMod.list({ universeOnly: q.get('all') !== '1', days: +(q.get('days') || 30) }), netSupply: unlocksMod.netSupply() }; },
});

// Derive Desk (lib/derive.js + research/derive_desk.py): every Derive option (OI/vol/IV/greeks), defined-risk strategy scanner,
// IV rank/skew, DRV farming math, cross-flags vs composite/perps. Polls api.derive.xyz/v3 every ~3 min (DERIVE=off disables).
const deriveDesk = require('./lib/derive').createDerive({ DATA_DIR, log: L, composite: compositeCached, perps, root: __dirname });
if (process.env.DERIVE === 'on') deriveDesk.start(); // Derive tab removed (Martin, Oct 2026): collector off by default (its ~7s synchronous strategy build was tripping the supervisor's health probe); DERIVE=on re-enables
Object.assign(routes, deriveDesk.routes());

// Developer activity desk (lib/devactivity.js; data from research/devactivity.py): GitHub commit frequency / silence / burst flags
const devactivity = require('./lib/devactivity').createDevActivity({ DATA_DIR, log: L });
routes['/api/devactivity'] = async (q) => devactivity.api(q);
// Priority Watch: NEAR + ZEC (lib/priority.js; research/priority.py -> data/priority.json, data/zec_shielded.json). Terminal-only high-priority alerts.
const priority = require('./lib/priority').createPriority({ DATA_DIR, perps, liquidations, pricegaps, unlocks: unlocksMod, devactivity, composite: compositeCached, alerts, log: L });
if (process.env.PRIORITY !== 'off') priority.start();
routes['/api/priority'] = async () => priority.api();
routes['/api/priority/shielded'] = async () => priority.shieldedApi();

// Pattern detectors 1-5 (crash hours, fresh-wallet clusters, CEX + bridge flows, stock pairs) — lib/patterns.js, additive routes
Object.assign(routes, require('./lib/patterns').routes({ DATA_DIR, live }));
// Session seasonality (lib/seasonality.js; research/seasonality.py): DST-correct session windows, live volatile/quiet flags — additive
Object.assign(routes, require('./lib/seasonality').routes({ DATA_DIR, live }));
// Terminal uptime / restarts (lib/uptime.js; scripts/supervisor.js writes data/restarts.json): /api/health/detail + restart alerts — additive
{ const up = require('./lib/uptime').createUptime({ DATA_DIR, alerts, log: (m) => console.log('[uptime] ' + m) }); Object.assign(routes, up.routes); if (!RENDER_LITE) up.start(); }
// Airdrop Desk v2: tracker, under-farmed score, My Farms monitor, dilution, value estimates (lib/airdrops.js; research/airdrops_v2.py)
Object.assign(routes, require('./lib/airdrops').routes({ DATA_DIR, root: __dirname }));

// Narratives Desk (lib/narratives.js; data from research/narratives.py). narratives.boostFor(chain, address, symbol) for composite grades.
const narratives = createNarratives({ DATA_DIR, root: __dirname, log: L });
routes['/api/narratives'] = async (q) => narratives.api(q);
routes['/api/narratives/boost'] = async () => narratives.boosts();
// AI Agents desk (lib/agents.js; data from research/agents.py + research/agents_birth.py)
const agentsDesk = require('./lib/agents').createAgents({ DATA_DIR, root: __dirname, log: L });
routes['/api/agents'] = async (q) => agentsDesk.api(q);
routes['/api/agents/launch'] = async (q) => agentsDesk.launch(q);
// Social sentiment desk (lib/sentiment.js; data from the assistant-run free X collector, research/sentiment/COLLECTOR.md). Read-only.
const sentimentDesk = require('./lib/sentiment').createSentiment({ DATA_DIR });
routes['/api/sentiment'] = async (q) => sentimentDesk.api(q);
// Stablecoin issuance desk (lib/stables.js; data from research/stables.py) — additive
const stablesDesk = require('./lib/stables').createStables({ DATA_DIR, log: L });
routes['/api/stables'] = async (q) => stablesDesk.api(q);
// Regulatory Radar (lib/regradar.js; data from research/regradar.py): crypto-regulation news radar, flow cross-ref, event study — additive
Object.assign(routes, require('./lib/regradar').createRegRadar({ DATA_DIR, log: L }).routes());
// Pre-launch birth-phase library + live matcher (lib/birthphase.js; data from research/birthphase/*.py) — additive
const birthphase = require('./lib/birthphase').createBirthphase({ DATA_DIR, root: __dirname, log: L });
routes['/api/birthphase'] = async (q) => birthphase.api(q);
routes['/api/birthphase/token'] = async (q) => birthphase.token(q);
// keep live.json fresh for launch-model phone alerts (lib/alerts.js refuses snapshots > 30 min old); refresh() no-ops if < BIRTHPHASE_LIVE_MIN old or NO_AUTO_REFRESH=1
if (!RENDER_LITE) setInterval(() => { try { birthphase.refresh(false); } catch {} }, 5 * 60e3).unref();
// Contract vulnerability scanner (lib/contractscan.js; batch via research/contractscan.py): /api/contractscan[?chain=&address=] — additive
Object.assign(routes, require('./lib/contractscan').routes());
// Fake-volume detector (lib/fakevolume.js; backtest research/fakevolume.py): /api/fakevolume, /api/fakevolume/token?chain=&address= — additive (FAKEVOL=off disables the live scan)
const fakevolume = require('./lib/fakevolume').createFakeVolume({ DATA_DIR, live, log: L });
if (process.env.FAKEVOL !== 'off') fakevolume.start();
Object.assign(routes, fakevolume.routes());
// VC / fund / market-maker wallet watch (lib/vcwatch.js; research/vcwatch.py): /api/vcwatch, /api/vcwatch/wallets, /api/vcwatch/lookup — additive
Object.assign(routes, require('./lib/vcwatch').routes({ DATA_DIR, root: __dirname, log: L }));
// Copy-trade watch (ALERTS ONLY, never trades) + non-X social channel (lib/copytrade.js, lib/socialalt.js; research/copytrade.py, research/socialalt.py) — additive
const copytrade = require('./lib/copytrade').createCopyTrade({ DATA_DIR, root: __dirname, live, alerts, log: L });
if (LIVE !== 'off' && process.env.COPYTRADE !== 'off') copytrade.start();
Object.assign(routes, copytrade.routes());
const socialalt = require('./lib/socialalt').createSocialAlt({ DATA_DIR, root: __dirname, log: L });
Object.assign(routes, socialalt.routes());
// Pattern Lab: 37 crash/pump patterns, backtests + live flags (lib/patternlab.js; research/patternlab/*.py; PATTERN_LAB.md) — additive
Object.assign(routes, require('./lib/patternlab').shared(DATA_DIR).routes());
// Pattern Lab EXPANSION: rules 38+ and categories A-J (lib/patternlab_ext.js; research/patternlab_ext/*.py; PATTERN_LAB_EXT.md) — additive
Object.assign(routes, require('./lib/patternlab_ext').routes({ DATA_DIR, live }));
// Insider-privilege pattern scan + Velvet exposé (lib/insider.js; data/insider_pattern.json, data/velvet_postcrash.json): /api/insider, /api/insider/velvet — additive.
// Signal-bus plug-ins (lib/signalbus.js register): insider scan + developer-activity silence/burst flags feed the alert ranker / false-positive log
// (auto-labels, rolling scores, shadow mode). Pattern Lab EXT registers its own plug-in in lib/patternlab_ext.js.
{ const insider = require('./lib/insider').createInsider({ DATA_DIR, root: __dirname }); Object.assign(routes, insider.routes());
  const bus = require('./lib/signalbus');
  bus.register(insider.signalPlugin(async () => { try { return ((await compositeCached()).tokens || []).map((t) => ({ chain: t.chain, address: t.kind === 'perp' ? null : t.id.split(':').slice(1).join(':'), sym: t.sym, price: t.price })); } catch { return []; } }));
  bus.register({ id: 'dev_activity', name: 'Developer activity (GitHub silence / burst)', desk: 'crypto', claim: 'crash', async live() {
    const d = devactivity.load(); if (!d) return []; const marks = new Map(((perps.snapshot && perps.snapshot().tokens) || []).map((t) => [String(t.sym).toUpperCase(), t.mark]));
    const out = [];
    for (const r of d.live || []) { if (!r.verified) continue; const sym = String(r.symbol || '').toUpperCase(); const px = marks.get(sym); const tok = px != null ? { key: 'perp:' + sym, chain: 'perp', symbol: sym } : { symbol: sym };
      if (r.silence && r.previously_active) out.push({ token: tok, price: px ?? null, claim: 'crash', variant: 'silence', severity: 'low', strength: r.silence === 'silent_60d' ? 0.5 : 0.35, values: { days: r.days_since_last_commit }, reason: `${sym}: GitHub went quiet (${r.silence.replace('_', ' ')}) after being active`, source: 'data/devactivity.json' });
      if (r.burst) out.push({ token: tok, price: px ?? null, claim: 'pump', variant: 'burst', severity: 'low', strength: 0.35, values: { commits_7d: r.commits_7d, avg_weekly_prev8: r.avg_weekly_prev8 }, reason: `${sym}: commit burst ${r.commits_7d} in 7d vs ${r.avg_weekly_prev8}/wk`, source: 'data/devactivity.json' }); }
    return out; } }); }
// Grok news & sentiment layer (lib/grok.js; xAI API, XAI_API_KEY from env only, hard monthly/daily USD caps, cache-by-hash) — additive
const grokDesk = require('./lib/grok').createGrok({ DATA_DIR, macro, log: L });
if (process.env.GROK !== 'off') grokDesk.start();
routes['/api/grok'] = async (q) => grokDesk.api(q);
routes['/api/grok/pulse'] = async () => grokDesk.pulse({ liquidations: () => liquidations.snapshot(), pricegaps: () => pricegaps.snapshot(), fundingdiv: () => fundingdiv.snapshot(), orderbook: () => orderbook.snapshot() });
// Validation layer (lib/validation.js): cross-detector backtest scoreboard, ranked alert queue, false-positive log with automatic
// labels + rolling detector effectiveness/shadow mode, PAPER trading (no execution) — additive
require('./lib/validation').attachValidation({ routes, DATA_DIR, root: __dirname, live, calls, perps, liquidations, fundingdiv, orderbook, composite: compositeCached, nansen, dsTokens, getJSON, cached, log: (m) => console.log('[validation] ' + m) });
// Data provenance (lib/provenance.js + lib/provenance_map.js): /api/provenance?path=&field=&row=, /api/provenance/coverage|log|upstream — additive
Object.assign(routes, prov.routes({ routes, DATA_DIR, mem: { perps: () => perps.snapshot().generatedAt, live: () => live.feed().generatedAt, liquidations: () => liquidations.snapshot().generatedAt, pricegaps: () => pricegaps.snapshot().generatedAt } }));
// API key health: age / 90-day rotation schedule / reminders / zero-cost validity probes / leak scan / SESSION_SECRET auto-rotation (lib/keyhealth.js, KEY_ROTATION.md) — additive
const keyhealth = require('./lib/keyhealth').createKeyHealth({ DATA_DIR, root: __dirname, log: L, alerts });
if (process.env.KEYHEALTH !== 'off') keyhealth.start();
routes['/api/keyhealth'] = async (q) => keyhealth.api(q);
const refreshing = new Set();
function withRefresh(file, script, maxAge) {
  let st = null; try { st = fs.statSync(path.join(DATA_DIR, file)); } catch {}
  const stale = !st || Date.now() - st.mtimeMs > maxAge;
  if (stale && !refreshing.has(script) && process.env.NO_AUTO_REFRESH !== '1') {
    refreshing.add(script);
    const ch = spawn('python3', [script], { cwd: path.join(__dirname, 'research'), env: { ...process.env, DATA_DIR }, stdio: 'ignore' });
    ch.on('exit', () => refreshing.delete(script)); ch.on('error', () => refreshing.delete(script));
  }
  if (!st) throw Object.assign(new Error(`${file} is being generated (first run takes a few minutes), try again shortly`), { status: 503 });
  const d = readData(file);
  d.refreshing = refreshing.has(script); d.ageSec = Math.round((Date.now() - st.mtimeMs) / 1000);
  return d;
}
function readData(f) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); }
  catch { throw Object.assign(new Error(f + ' not generated yet — run research/run.sh'), { status: 404 }); }
}
// Proactive desk refreshes: withRefresh/load() only run on API hits, so idle files go 5–10h stale.
// Free scripts only; NO_AUTO_REFRESH=1 disables. Cadences: options 30m (US equity hours), unlocks/airdrops/regradar/stables 6h,
// seasonality daily, ZEC shielded via priority.py (>20h inside its 30m loop), contractscan daily (new/stale only), VC/copytrade 2h.
if (LIVE !== 'off' && process.env.NO_AUTO_REFRESH !== '1') {
  const fileAge = (f) => { try { return Date.now() - fs.statSync(path.join(DATA_DIR, f)).mtimeMs; } catch { return Infinity; } };
  const py = (script, args = [], key = script) => {
    if (refreshing.has(key)) return;
    refreshing.add(key);
    const ch = spawn('nice', ['-n', '10', 'python3', script, ...args], { cwd: path.join(__dirname, 'research'), env: { ...process.env, DATA_DIR, NANSEN_API_KEY: '', X_BEARER_TOKEN: '' }, stdio: 'ignore' });
    ch.on('exit', () => refreshing.delete(key)); ch.on('error', () => refreshing.delete(key));
  };
  const usEquityOpen = () => { // Mon–Fri 09:30–16:00 America/New_York
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const o = {}; for (const p of fmt.formatToParts(new Date())) o[p.type] = p.value;
    if (['Sat', 'Sun'].includes(o.weekday)) return false;
    const m = (+o.hour) * 60 + (+o.minute); return m >= 9 * 60 + 30 && m < 16 * 60;
  };
  setInterval(() => { if (usEquityOpen() && fileAge('options.json') > 30 * 60e3) py('options.py'); }, 10 * 60e3).unref();
  setInterval(() => {
    if (fileAge('unlocks_calendar.json') > 6 * 3600e3) py('unlocks.py');
    if (fileAge('airdrops.json') > 6 * 3600e3) py('airdrops.py');
    if (fileAge('airdrop_desk.json') > 6 * 3600e3) py('airdrops_v2.py');
    if (fileAge('regradar.json') > 6 * 3600e3) py('regradar.py', ['live'], 'regradar.py:live');
    if (fileAge('stables.json') > 6 * 3600e3) py('stables.py');
  }, 30 * 60e3).unref();
  setInterval(() => { if (fileAge('seasonality_live.json') > 24 * 3600e3) py('seasonality.py'); }, 60 * 60e3).unref();
  setInterval(() => { if (fileAge('vcwatch_live.json') > 2 * 3600e3) py('vcwatch.py', ['monitor'], 'vcwatch.py:monitor'); }, 30 * 60e3).unref();
  setInterval(() => { try { copytrade.refresh(false); } catch {} }, 30 * 60e3).unref();
  setInterval(() => { // contract scan: rebuild universe then batch new/stale only (batch skips already-ok tokens)
    if (fileAge('contractscan.json') < 24 * 3600e3 || refreshing.has('contractscan:daily')) return;
    refreshing.add('contractscan:daily');
    const u = spawn('nice', ['-n', '10', 'python3', 'contractscan.py', 'universe'], { cwd: path.join(__dirname, 'research'), env: { ...process.env, DATA_DIR }, stdio: 'ignore' });
    u.on('exit', () => {
      const b = spawn('nice', ['-n', '10', 'node', 'lib/contractscan.js', 'batch', '--limit=80'], { cwd: __dirname, env: { ...process.env, DATA_DIR }, stdio: 'ignore' });
      b.on('exit', () => refreshing.delete('contractscan:daily')); b.on('error', () => refreshing.delete('contractscan:daily'));
    });
    u.on('error', () => refreshing.delete('contractscan:daily'));
  }, 60 * 60e3).unref();
  // kick once shortly after boot for anything already past cadence
  setTimeout(() => {
    try { unlocksMod.status(); } catch {}
    try { stablesDesk.api(new URLSearchParams()); } catch {}
    if (usEquityOpen() && fileAge('options.json') > 30 * 60e3) py('options.py');
    if (fileAge('airdrops.json') > 6 * 3600e3) py('airdrops.py');
    if (fileAge('airdrop_desk.json') > 6 * 3600e3) py('airdrops_v2.py');
    if (fileAge('regradar.json') > 6 * 3600e3) py('regradar.py', ['live'], 'regradar.py:live');
    if (fileAge('seasonality_live.json') > 24 * 3600e3) py('seasonality.py');
    if (fileAge('vcwatch_live.json') > 2 * 3600e3) py('vcwatch.py', ['monitor'], 'vcwatch.py:monitor');
    try { copytrade.refresh(false); } catch {}
  }, 45e3).unref();
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

// ---------- transfer: gzip/brotli + static caching (helps slow first loads on Render's 0.5 CPU) ----------
const zlib = require('zlib');
const COMPRESSIBLE = /^(application\/json|text\/|application\/javascript|image\/svg)/;
function pickEnc(req) { const ae = String(req.headers['accept-encoding'] || ''); return /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null; }
function compressBody(enc, buf, fast) {
  return enc === 'br' ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: fast ? 4 : 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    : zlib.gzipSync(buf, { level: fast ? 5 : 9 });
}
// Wrap res so any single-shot response (JSON from every handler incl. tax/trade, HTML, JS, CSS) is compressed; streamed writes pass through untouched.
function withCompression(req, res) {
  const enc = pickEnc(req); if (!enc || req.method === 'HEAD') return;
  const wh = res.writeHead.bind(res), we = res.write.bind(res), en = res.end.bind(res);
  let pending = null, streamed = false;
  const flushHead = () => { if (pending) { wh(...pending); pending = null; } };
  res.writeHead = (...a) => { pending = a; return res; };
  res.write = (...a) => { streamed = true; flushHead(); return we(...a); };
  res.end = (body, ...rest) => {
    if (streamed || body == null || typeof body === 'function') { flushHead(); return en(body, ...rest); }
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const [status = res.statusCode, a1, a2] = pending || []; const hdrs = { ...(typeof a1 === 'object' ? a1 : a2 || {}) };
    const ct = String(hdrs['content-type'] || hdrs['Content-Type'] || res.getHeader('content-type') || '');
    pending = null;
    if (buf.length < 1024 || !COMPRESSIBLE.test(ct) || hdrs['content-encoding'] || res.getHeader('content-encoding')) { wh(status, hdrs); return en(buf); }
    const z = res._precompressed || compressBody(enc, buf, true);
    wh(status, { ...hdrs, 'content-encoding': enc, vary: 'Accept-Encoding', 'content-length': z.length }); return en(z);
  };
}
// Static: index.html revalidates (no-cache + ETag) and points at ?v=<mtime> asset URLs, which are cached for a year (immutable).
const staticZ = new Map(); // path|enc|mtime -> compressed buffer (computed once per file version, brotli q9)
const assetV = (rel) => { try { return Math.round(fs.statSync(path.join(PUB, rel)).mtimeMs).toString(36); } catch { return '0'; } };
const versionAssets = (html) => html.replace(/(src|href)="\/([\w.-]+\.(?:js|css))"/g, (m, a, f) => `${a}="/${f}?v=${assetV(f)}"`);

// RENDER_LITE: data only changes on redeploy, so memoize GET API responses for 60s (one CPU-bound compute per minute per URL).
const liteMemo = new Map();
const firstSeen = require('./lib/firstseen').createFirstSeen({ DATA_DIR, log: L }); // 'First posted / Updated' stamps on pick cards
let optBody = null; // /api/options serialized + compressed cache

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  withCompression(req, res);
  if (await auth.gate(req, res, u)) return;
  if (u.pathname.startsWith('/api/')) {
    const deep = u.pathname === '/api/scan' && u.searchParams.get('deep') === '1';
    if (limited(req, 'api', 240, 60e3) || (deep && limited(req, 'deep', 4, 60e3))) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":"rate limited, slow down"}'); }
    if (taxapi.owns(u.pathname)) return taxapi.handle(req, res, u); // Tax desk (lib/tax/api.js)
    if (tradeapi.owns(u.pathname)) return tradeapi.handle(req, res, u); // swaps / MEV log / portfolio (lib/tradeapi.js)
    const h = routes[u.pathname];
    if (!h) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not found"}'); }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (u.pathname === '/api/options') { // 15 MB of picks on the box: serialize once per file version, floats to 5 significant digits, precompressed per encoding
      try {
        const data = await h(u.searchParams, req); const mt = fs.statSync(path.join(DATA_DIR, 'options.json')).mtimeMs;
        if (!optBody || optBody.mt !== mt || optBody.refreshing !== data.refreshing) optBody = { mt, refreshing: data.refreshing, body: Buffer.from(JSON.stringify(prov.attach(u.pathname, firstSeen.annotate(u.pathname, data), DATA_DIR), (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? +v.toPrecision(5) : v))), z: {} };
        const enc = pickEnc(req); if (enc) res._precompressed = optBody.z[enc] ||= compressBody(enc, optBody.body, false);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(optBody.body);
      } catch (e) { res.writeHead(e.status || 502, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: String(e.message || e) })); }
    }
    const memoK = RENDER_LITE && !/^\/api\/(whoami|health)/.test(u.pathname) ? u.pathname + '?' + u.searchParams.toString() : null;
    const hit = memoK && liteMemo.get(memoK);
    if (hit && Date.now() - hit.t < 60e3) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(hit.body); }
    try {
      const data = await h(u.searchParams, req);
      const body = JSON.stringify(prov.attach(u.pathname, firstSeen.annotate(u.pathname, data), DATA_DIR)); // adds `_prov` (shallow copy) — lib/provenance.js
      if (memoK) { liteMemo.set(memoK, { t: Date.now(), body }); if (liteMemo.size > 500) liteMemo.delete(liteMemo.keys().next().value); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
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
  fs.stat(f, (serr, st) => fs.readFile(f, (err, buf) => {
    if (err || serr) { res.writeHead(404); return res.end('not found'); }
    if (p === '/index.html') buf = Buffer.from(versionAssets(String(buf)));
    if (req.authRole === 'guest' && p === '/index.html') { // guest login: hide owner-only nav (portfolio, swap, tax, wallet viewer, settings); APIs are 403'd in lib/auth.js
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(String(buf).replace('</head>', `<style>#viewNav [data-v=portfolio],#viewNav [data-v=swap],#viewNav [data-v=tax],#lowerTabs [data-t=wallet],#lowerWallet,#settingsBtn,#ownerMenu{display:none!important}</style>
<script>window.ST_ROLE='guest';addEventListener('DOMContentLoaded',()=>{const b=document.querySelector('#lowerTabs [data-t=moon]');b&&b.click();const o=new MutationObserver(()=>document.querySelectorAll('#viewNav [data-v=portfolio],#viewNav [data-v=swap],#viewNav [data-v=tax]').forEach((x)=>x.remove()));o.observe(document.body,{childList:true,subtree:true});});</script></head>`));
    }
    const ct = MIME[path.extname(f)] || 'application/octet-stream';
    const etag = `W/"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}${p === '/index.html' ? '-' + (req.authRole || 'o') : ''}"`;
    const versioned = u.searchParams.has('v') && p !== '/index.html';
    const hdr = { 'content-type': ct, etag, 'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, hdr); return res.end(); }
    const enc = pickEnc(req);
    if (enc && COMPRESSIBLE.test(ct) && buf.length >= 1024) { const k = `${p}|${enc}|${etag}`; let z = staticZ.get(k); if (!z) { z = compressBody(enc, buf, false); staticZ.set(k, z); } res._precompressed = z; }
    res.writeHead(200, hdr);
    res.end(buf);
  }));
});
server.listen(PORT, HOST, () => console.log(`[asymmetric-terminal] read-only dashboard on http://${HOST}:${PORT}${auth.ENABLED ? ` (password-protected, user '${auth.USER}')` : ' (open: SITE_PASSWORD not set)'}`));

// Breakouts: flat-base scanner (lib/flatbase.js -> data/flatbase.json; series from research/flatbase_backfill.js, daily, free sources)
const flatbase = require('./lib/flatbase').createFlatbase({ DATA_DIR, log: L });
routes['/api/flatbase'] = async () => flatbase.api();
if (!RENDER_LITE && process.env.FLATBASE !== 'off') {
  flatbase.start();
  const backfill = () => { const ch = spawn('nice', ['-n', '10', 'node', 'research/flatbase_backfill.js'], { cwd: __dirname, env: { ...process.env, DATA_DIR }, stdio: 'ignore' }); ch.on('exit', () => flatbase.refresh()); ch.on('error', () => {}); };
  setTimeout(backfill, 10 * 60e3).unref(); setInterval(backfill, 24 * 3600e3).unref(); // cached files < 20h old are skipped
}

// Heavy Accumulation desk (lib/accumulation.js -> data/accumulation.json): scores tokens from data other desks already collected (0 credits).
const accumulation = require('./lib/accumulation').createAccumulation({ DATA_DIR, log: L });
routes['/api/accumulation'] = async () => accumulation.api();
if (!RENDER_LITE && process.env.ACCUMULATION !== 'off') accumulation.start(+(process.env.ACCUMULATION_MS || 10 * 60e3));

// ---------- Risk infrastructure (additive): (5) oracle manipulation, (6) dependency risk, (7) feed health / staleness, (8) OTC flow ----------
// lib/oracles.js, lib/dependencies.js, lib/otcflow.js run research/riskinfra/*.py in the background (RISKINFRA=off disables; lock files
// keep several server instances from running the same collector). lib/staleness.js instruments data/*.json + in-memory snapshots.
{
  const RL = (m) => console.log('[riskinfra] ' + m);
  const riDeps = require('./lib/dependencies').createDependencies({ DATA_DIR, log: RL });
  const riOracles = require('./lib/oracles').createOracles({ DATA_DIR, log: RL, after: () => riDeps.run(true) });
  const riOtc = require('./lib/otcflow').createOtcFlow({ DATA_DIR, log: RL });
  const sig = (arr, k) => (arr || []).slice(0, 12).map((x) => x && x[k]);
  const probes = {};
  if (LIVE !== 'off') probes.live = { label: 'Live alpha feed (in-memory)', expectedMs: 3 * 60e3, panels: ['ccLive', 'ccSlow'], fn: () => { const f = live.feed(); return { t: f.generatedAt, n: (f.items || []).length, sig: (f.items || []).slice(0, 12).map((x) => x.m && x.m.px) }; } };
  if (process.env.PERPS !== 'off') {
    probes.perps = { label: 'Perp snapshot (in-memory)', expectedMs: 2 * 60e3, panels: ['perpDesk'], fn: () => { const s = perps.snapshot(); return { t: s.generatedAt, n: (s.tokens || []).length, sig: sig(s.tokens, 'mark') }; } };
    if (process.env.LIQ !== 'off') probes.liquidations = { label: 'Liquidation detector (in-memory)', expectedMs: 60e3, panels: [], fn: () => { const s = liquidations.snapshot(); return { t: s.generatedAt, n: (s.assets || []).length }; } };
    if (process.env.GAPS !== 'off') probes.pricegaps = { label: 'Cross-exchange price gaps (in-memory)', expectedMs: 90e3, panels: [], fn: () => { const s = pricegaps.snapshot(); return { t: s.generatedAt, n: (s.tokens || []).length, sig: sig(s.tokens, 'mark') }; } };
  }
  if (LIVE !== 'off' && process.env.POOLWATCH !== 'off') probes.poolwatch = { label: 'QCAT/STRK pool watch (in-memory)', expectedMs: 15 * 60e3, panels: [], fn: () => { const s = poolwatch.status() || {}; return { t: s.updatedAt }; } };
  const feedHealth = require('./lib/staleness').createStaleness({ DATA_DIR, root: __dirname, log: RL, probes, notify: (k, t) => alerts.notice(k, t) });
  if (!RENDER_LITE) feedHealth.start();
  if (process.env.RISKINFRA !== 'off') { riOracles.start(45e3); riDeps.start(120e3); riOtc.start(150e3); }
  Object.assign(routes, {
    async '/api/oracles'(q) { return riOracles.api(q); },
    async '/api/dependencies'(q) { return riDeps.api(q); },
    async '/api/otcflow'(q) { return riOtc.api(q); },
    async '/api/feedhealth'(q) { return feedHealth.api(q); },
    async '/api/riskinfra'() {
      const g = (fn) => { try { return fn(); } catch (e) { return { error: e.message }; } };
      const o = g(() => riOracles.api(new URLSearchParams())), d = g(() => riDeps.api(new URLSearchParams())), x = g(() => riOtc.api(new URLSearchParams('limit=40'))), h = feedHealth.api(new URLSearchParams());
      return {
        oracles: o.error ? o : { generatedAt: o.generatedAt, summary: o.summary, coverage: o.coverage, flags: (o.flags || []).slice(0, 25), thinPools: (o.thinPools || []).filter((t) => t.severity).slice(0, 12), runner: o.runner },
        dependencies: d.error ? d : { generatedAt: d.generatedAt, summary: d.summary, stressed: (d.stressed || []).slice(0, 20), dependents: (d.dependents || []).slice(0, 20), lst: d.lst, hacks30d: (d.hacks30d || []).slice(0, 8), runner: d.runner },
        otcflow: x.error ? x : { generatedAt: x.generatedAt, window: x.window, coverage: x.coverage, thisRun: x.thisRun, followUp: x.followUp, flags: (x.flags || []).slice(0, 20), runner: x.runner },
        feedhealth: { generatedAt: h.generatedAt, summary: h.summary, restarts: h.restarts, panels: h.panels, problems: h.feeds.filter((f) => f.status === 'red' || f.status === 'yellow').slice(0, 30), alerts: h.alerts.slice(0, 10) },
      };
    },
  });
}
