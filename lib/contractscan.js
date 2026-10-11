'use strict';
// Unified contract vulnerability scanner (EVM + Solana). HEURISTICS from public data, NOT financial advice.
// Sources (all keyless/free): GoPlus token_security (EVM + Solana; throttled ~27 req/min, disk-cached), Honeypot.is (ETH/BSC/Base),
// RugCheck.xyz report (Solana), Sourcify v2 + Blockscout (verified source), chain JSON-RPC (eth_getCode / eth_getStorageAt /
// eth_call with state overrides for our OWN transfer/sell/buy simulation), Solana RPC (jsonParsed mint + Token-2022 extensions,
// program upgrade authority), Jupiter lite-api (Solana sell simulation via simulateTransaction), DexScreener (pairs).
// Not used (paid / key-gated): TokenSniffer API, De.Fi API, Etherscan v2 API, CertiK/Hacken/QuillAudits (see PAID below).
// Usage: require('./contractscan').scanToken(chain, address, opts) | routes({DATA_DIR}) | CLI: node lib/contractscan.js batch
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CHAINS } = require('./chains');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'contractscan_cache');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SOL_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL = 'So11111111111111111111111111111111111111112';
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const BILL = { calls: {}, nansen: 0, x: 0 };

const PAID = [
  { name: 'TokenSniffer API (Solidus Labs)', cost: '$99/mo Sniffer Pack Pro (500 tokens/day, 5 req/s); Enterprise custom', source: 'tokensniffer.readme.io/reference/pricing', status: 'not used (keyless endpoint returns 401 Unauthorized)' },
  { name: 'De.Fi Scanner API', cost: 'credit-based, key by email (info@de.fi); scannerProject = 25 credits/call, 20 req/min; credits must be purchased first', source: 'docs.de.fi/api/api', status: 'not used (public-api.de.fi/graphql returns "Missing API key")' },
  { name: 'GoPlus paid tiers', cost: 'free 150 CU/min, 30K CU/day; paid $199-$3,499/mo', source: 'gopluslabs.io/en/security-api', status: 'free unauthenticated tier used, throttled' },
  { name: 'CertiK audit', cost: 'custom quote; reported ~$8K-$15K for a simple ERC-20, $30K-$45K+ for DeFi', source: 'certik.com/smart-contract-audit; quantumaudit.app pricing comparison (secondary)', status: 'not used (manual audit service)' },
  { name: 'Hacken audit', cost: 'reported ~$5K-$25K; Hacken lists $10K-$30K for small/medium projects', source: 'hacken.io avalanche audit page', status: 'not used' },
  { name: 'QuillAudits', cost: 'Quick Audit reported $5K-$7K per 1,000 LoC, standard $10K-$15K per 1,000 LoC; QuillShield API from $79/100 BLOC credits; QuillCheck API plans not publicly priced', source: 'coinweb.com QuillAudits review (secondary); quillaudits.com/quillshield api-pricing', status: 'not used' },
  { name: 'Etherscan v2 API', cost: 'free key required (keyless call returns "Missing/Invalid API Key")', source: 'api.etherscan.io/v2', status: 'not used: GoPlus is_open_source (Etherscan-derived) + Sourcify + Blockscout instead' },
];

// ---------------- keccak256 (for selectors / mapping slots) ----------------
const RC = ['0000000000000001', '0000000000008082', '800000000000808a', '8000000080008000', '000000000000808b', '0000000080000001', '8000000080008081', '8000000000008009', '000000000000008a', '0000000000000088', '0000000080008009', '000000008000000a', '000000008000808b', '800000000000008b', '8000000000008089', '8000000000008003', '8000000000008002', '8000000000000080', '000000000000800a', '800000008000000a', '8000000080008081', '8000000000008080', '0000000080000001', '8000000080008008'].map((h) => BigInt('0x' + h));
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) { const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) s[y + x] ^= d; }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[r];
  }
}
function keccak256(buf) {
  if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
  const rate = 136, s = new Array(25).fill(0n);
  const padLen = rate - (buf.length % rate);
  const p = Buffer.concat([buf, Buffer.alloc(padLen)]); p[buf.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  for (let off = 0; off < p.length; off += rate) { for (let i = 0; i < rate / 8; i++) s[i] ^= p.readBigUInt64LE(off + i * 8); keccakF(s); }
  const out = Buffer.alloc(32); for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out.toString('hex');
}
const sel = (sig) => keccak256(sig).slice(0, 8);

// Function-signature families checked in bytecode (selectors computed, not hard-coded)
const SIGS = {
  mint: ['mint(address,uint256)', 'mint(uint256)', 'mintTo(address,uint256)', 'issue(uint256)', 'mint(address,uint256,bytes)', 'mintFor(address,uint256)'],
  blacklist: ['blacklist(address)', 'addToBlacklist(address)', 'addBlackList(address)', 'setBlacklist(address,bool)', 'blacklistAddress(address,bool)', 'setBots(address[])', 'addBots(address[])', 'addBot(address)', 'setBot(address,bool)', 'setBlacklisted(address,bool)', 'blockBots(address[])', 'setBlackList(address,bool)', 'updateBlacklist(address,bool)', 'blacklistAddresses(address[])', 'setIsBlacklisted(address,bool)', 'isBlacklisted(address)', 'isBot(address)'],
  whitelist: ['setWhitelist(address,bool)', 'addToWhitelist(address)', 'setWhitelisted(address,bool)', 'whitelist(address)', 'setWhiteList(address,bool)', 'addWhitelist(address[])'],
  pause: ['pause()', 'unpause()', 'setPaused(bool)', 'paused()'],
  tradingSwitch: ['enableTrading()', 'openTrading()', 'setTradingEnabled(bool)', 'startTrading()', 'setTrading(bool)', 'tradingEnabled()', 'tradingOpen()', 'setTradingOpen(bool)', 'launch()'],
  maxTx: ['setMaxTxAmount(uint256)', 'setMaxWalletSize(uint256)', 'setMaxWallet(uint256)', 'removeLimits()', 'setMaxTxPercent(uint256)', 'updateMaxTxnAmount(uint256)', 'updateMaxWalletAmount(uint256)', 'setMaxWalletAmount(uint256)', '_maxTxAmount()', 'maxTransactionAmount()', 'maxWallet()', '_maxWalletSize()', 'setLimits(uint256,uint256)'],
  taxSet: ['setFees(uint256,uint256)', 'setTaxFeePercent(uint256)', 'setBuyFee(uint256)', 'setSellFee(uint256)', 'updateBuyFees(uint256,uint256,uint256)', 'updateSellFees(uint256,uint256,uint256)', 'setTax(uint256)', 'setTaxes(uint256,uint256)', 'setFee(uint256,uint256)', 'setBuyTax(uint256)', 'setSellTax(uint256)', 'updateFees(uint256,uint256)', 'setFees(uint256,uint256,uint256,uint256)', 'setTaxFee(uint256)', 'reduceFee(uint256)', 'setMarketingFee(uint256)'],
  ownable: ['owner()', 'renounceOwnership()', 'transferOwnership(address)', 'getOwner()'],
  upgrade: ['upgradeTo(address)', 'upgradeToAndCall(address,bytes)'],
  roles: ['hasRole(bytes32,address)', 'grantRole(bytes32,address)'],
  cooldown: ['setCooldownEnabled(bool)', 'setCooldown(uint256)'],
  balanceEdit: ['setBalance(address,uint256)', 'burnFrom(address,uint256)'],
};
const SEL = Object.fromEntries(Object.entries(SIGS).map(([k, a]) => [k, a.map((s) => [sel(s), s])]));
const S = { owner: sel('owner()'), getOwner: sel('getOwner()'), totalSupply: '18160ddd', balanceOf: '70a08231', decimals: '313ce567', symbol: '95d89b41', getThreshold: sel('getThreshold()'), getOwners: sel('getOwners()'), getMinDelay: sel('getMinDelay()'), delay: sel('delay()'), getRoleMember: sel('getRoleMember(bytes32,uint256)'), implementation: sel('implementation()'), probe: 'dd8e5ec9', token0: sel('token0()') };
const SLOTS = {
  eip1967_impl: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  eip1967_admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  eip1967_beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  eip1822_proxiable: '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7',
  oz_legacy_impl: '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
};
// Probe helper (research/contractscan_probe.sol, solc 0.8.26, optimizer 200, evm paris): probe(token,to,amt) -> (ok, sent, recv, ret)
const PROBE = '0x' + fs.readFileSync(path.join(__dirname, 'contractscan_probe.hex'), 'utf8').trim();
const H_ADDR = '0x7e57000000000000000000000000000000c0ffee'; // simulated fresh holder (code-overridden with PROBE)
const R_ADDR = '0x7e57000000000000000000000000000000b0b0b0'; // fresh recipient

// ---------------- HTTP with per-host throttling ----------------
const GAPS = { 'api.gopluslabs.io': 3000, 'api.honeypot.is': 800, 'api.rugcheck.xyz': 4200, 'sourcify.dev': 250, 'eth.blockscout.com': 350, 'optimism.blockscout.com': 350, 'api.mainnet-beta.solana.com': 300, 'lite-api.jup.ag': 1100, 'api.dexscreener.com': 250, 'api.coingecko.com': 3000 };
const hostQ = {};
async function slot(host) {
  const g = GAPS[host] ?? 60;
  const q = hostQ[host] || (hostQ[host] = { last: 0, p: Promise.resolve() });
  const p = q.p.then(async () => { const w = q.last + g - Date.now(); if (w > 0) await sleep(w); q.last = Date.now(); });
  q.p = p.catch(() => {});
  return p;
}
function guard(url) { if (/nansen\.ai|(^|\.)x\.com|twitter\.com/i.test(new URL(url).hostname)) throw new Error('blocked host (no Nansen/X)'); }
async function http(url, { method = 'GET', body, headers = {}, timeout = 25000, retries = 3, raw = false } = {}) {
  guard(url);
  const host = new URL(url).hostname;
  let delay = 3000;
  for (let i = 0; ; i++) {
    await slot(host);
    BILL.calls[host] = (BILL.calls[host] || 0) + 1;
    let r;
    try { r = await fetch(url, { method, body: body ? JSON.stringify(body) : undefined, headers: { accept: 'application/json', 'user-agent': 'asymmetric-terminal contractscan (read-only)', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, signal: AbortSignal.timeout(timeout) }); }
    catch (e) { if (i < retries) { await sleep(delay); delay *= 2; continue; } throw e; }
    if (r.status === 429 || r.status >= 500) { if (i < retries) { const ra = +(r.headers.get('retry-after') || 0); await sleep(Math.max(delay, ra * 1000)); delay *= 2; continue; } throw Object.assign(new Error(`HTTP ${r.status} from ${host}`), { status: r.status }); }
    if (r.status === 404) return null;
    const txt = await r.text();
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} from ${host}: ${txt.slice(0, 120)}`), { status: r.status });
    if (raw) return txt;
    try { return JSON.parse(txt); } catch { throw new Error(`non-JSON from ${host}`); }
  }
}

// ---------------- disk cache ----------------
function ckey(k) { return path.join(CACHE_DIR, crypto.createHash('sha1').update(k).digest('hex').slice(0, 20) + '.json'); }
const cacheable = (v) => !(v && typeof v.status === 'string' && /^error|too many|rate/i.test(v.status)); // never cache errors / rate-limit answers
async function dcache(key, ttlMs, fn) {
  const f = ckey(key);
  try { const st = fs.statSync(f); if (Date.now() - st.mtimeMs < ttlMs) { const v = JSON.parse(fs.readFileSync(f, 'utf8')).v; if (cacheable(v)) return v; } } catch {}
  const v = await fn();
  if (!cacheable(v)) return v;
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify({ k: key, t: Date.now(), v })); } catch {}
  return v;
}
const DAY = 864e5;

// ---------------- EVM RPC ----------------
async function rpc(chain, method, params) {
  const url = CHAINS[chain]?.rpc; if (!url) throw new Error('no RPC for ' + chain);
  const j = await http(url, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, retries: 3, timeout: 20000 });
  if (!j) throw new Error('RPC 404');
  if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { rpcError: j.error, data: j.error.data });
  return j.result;
}
async function ecall(chain, to, data, state, from) {
  try { return await rpc(chain, 'eth_call', state ? [{ to, data: '0x' + data.replace(/^0x/, ''), ...(from ? { from } : {}) }, 'latest', state] : [{ to, data: '0x' + data.replace(/^0x/, ''), ...(from ? { from } : {}) }, 'latest']); }
  catch (e) { return { error: e.message, data: e.data }; }
}
const isHex = (x) => typeof x === 'string' && /^0x[0-9a-f]*$/i.test(x);
const word = (x) => (isHex(x) && x.length >= 66 ? x.slice(2, 66) : null);
const asAddr = (x) => { const w = word(x); return w && /^0{24}/.test(w) ? '0x' + w.slice(24) : null; };
const pad = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const ZERO = /^0x0{40}$/i;
const DEADS = /^0x(0{40}|0{36}dead|dead0{36}|0{39}1)$/i;

// opcode walk: PUSH4 selectors, dangerous opcodes, skeleton hash for clone/template matching
function analyzeCode(hex) {
  if (!hex || hex === '0x') return null;
  let b = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  // strip trailing CBOR metadata (last 2 bytes = metadata length)
  if (b.length > 4) { const ml = b.readUInt16BE(b.length - 2); if (ml > 0 && ml < 200 && ml + 2 < b.length && b[b.length - 2 - ml] >= 0xa1 && b[b.length - 2 - ml] <= 0xa5) b = b.subarray(0, b.length - 2 - ml); }
  const sels = new Set(); const ops = { selfdestruct: 0, delegatecall: 0, callcode: 0, origin: 0, create2: 0, sstore: 0 };
  const skel = Buffer.from(b);
  for (let i = 0; i < b.length; i++) {
    const op = b[i];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 4 || n === 3) sels.add(b.subarray(i + 1, i + 1 + n).toString('hex').padStart(8, '0'));
      if (n >= 20) skel.fill(0, i + 1, Math.min(b.length, i + 1 + n)); // addresses / big constants differ between clones
      i += n; continue;
    }
    if (op === 0xff) ops.selfdestruct++; else if (op === 0xf4) ops.delegatecall++; else if (op === 0xf2) ops.callcode++; else if (op === 0x32) ops.origin++; else if (op === 0xf5) ops.create2++; else if (op === 0x55) ops.sstore++;
  }
  const fam = {};
  for (const [k, list] of Object.entries(SEL)) { const hit = list.filter(([s]) => sels.has(s)).map(([, n]) => n); if (hit.length) fam[k] = hit; }
  const m1167 = /^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(b.toString('hex'));
  return { bytes: b.length, selectors: [...sels], families: fam, ops, skeleton: crypto.createHash('sha256').update(skel).digest('hex').slice(0, 24), minimalProxyTo: m1167 ? '0x' + m1167[1] : null };
}

async function classifyAddress(chain, a) {
  if (!a) return null;
  if (DEADS.test(a)) return { address: a, type: 'none (renounced/burn address)' };
  const code = await rpc(chain, 'eth_getCode', [a, 'latest']).catch(() => null);
  if (code == null) return { address: a, type: 'unknown (RPC failed)' };
  if (code === '0x') return { address: a, type: 'EOA (single private key)' };
  if (/^0xef0100/i.test(code)) return { address: a, type: 'EOA with EIP-7702 delegation' };
  const th = await ecall(chain, a, S.getThreshold); const ow = await ecall(chain, a, S.getOwners);
  if (word(th) && word(ow)) { const t = parseInt(word(th), 16); const n = ow.length >= 194 ? parseInt(ow.slice(130, 194), 16) : null; return { address: a, type: `multisig (Safe ${t}-of-${n ?? '?'})`, multisig: true, threshold: t, signers: n }; }
  const md = await ecall(chain, a, S.getMinDelay); if (word(md)) return { address: a, type: `timelock (min delay ${Math.round(parseInt(word(md), 16) / 3600)}h)`, timelock: true, delaySec: parseInt(word(md), 16) };
  const dl = await ecall(chain, a, S.delay); if (word(dl) && parseInt(word(dl), 16) > 0 && parseInt(word(dl), 16) < 1e8) return { address: a, type: `timelock-like (delay() = ${Math.round(parseInt(word(dl), 16) / 3600)}h)`, timelock: true, delaySec: parseInt(word(dl), 16) };
  const oo = asAddr(await ecall(chain, a, S.owner));
  return { address: a, type: 'contract (not a recognised multisig/timelock)', contractOwner: oo || null };
}

async function gpGet(url) { // GoPlus answers HTTP 200 + {code!=1, message:'too many requests'} when throttled: back off and retry
  for (let i = 0; i < 5; i++) { const d = await http(url); if (d && d.code !== 1 && /too many|limit/i.test(d.message || '')) { await sleep(20000 * (i + 1)); continue; } return d; }
  return { code: 0, message: 'too many requests (gave up after retries)' };
}
async function goplusEvm(chain, addr) {
  const id = CHAINS[chain]?.goplus; if (!id) return { status: 'chain not supported by GoPlus' };
  return dcache(`gp:${chain}:${addr.toLowerCase()}`, 3 * DAY, async () => {
    const d = await gpGet(`https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${addr.toLowerCase()}`);
    if (!d || d.code !== 1) return { status: 'error: ' + (d?.message || 'no response') };
    const r = d.result?.[addr.toLowerCase()] || Object.values(d.result || {})[0];
    if (!r || !Object.keys(r).length) return { status: 'not indexed by GoPlus' };
    const { dex, holders, lp_holders, ...rest } = r;
    return { status: 'ok', r: { ...rest, dex: (dex || []).slice(0, 6), holders: (holders || []).slice(0, 12), lp_holders: (lp_holders || []).slice(0, 6) } };
  });
}
async function honeypotIs(chain, addr) {
  const id = CHAINS[chain]?.honeypot; if (!id) return { status: 'Honeypot.is supports only Ethereum, BSC, Base' };
  return dcache(`hp:${chain}:${addr.toLowerCase()}`, 2 * DAY, async () => {
    try { const d = await http(`https://api.honeypot.is/v2/IsHoneypot?address=${addr}&chainID=${id}`, { retries: 2 }); return d ? { status: d.simulationSuccess ? 'ok' : 'no simulation: ' + (d.simulationError || 'n/a'), r: d } : { status: 'not found' }; }
    catch (e) { return { status: 'error: ' + e.message.slice(0, 120) }; }
  });
}
async function sourcify(chainId, addr) {
  return dcache(`sfy:${chainId}:${addr.toLowerCase()}`, 7 * DAY, async () => {
    try { const d = await http(`https://sourcify.dev/server/v2/contract/${chainId}/${addr}`, { retries: 1 }); return d ? { status: 'ok', match: d.match || null } : { status: 'ok', match: null }; }
    catch (e) { return { status: 'error: ' + e.message.slice(0, 80) }; }
  });
}
const BLOCKSCOUT = { ethereum: 'https://eth.blockscout.com', optimism: 'https://optimism.blockscout.com' }; // others are behind a Cloudflare challenge (verified 2026-10-11)
async function blockscout(chain, addr) {
  const b = BLOCKSCOUT[chain]; if (!b) return { status: 'no keyless Blockscout for ' + chain };
  return dcache(`bs:${chain}:${addr.toLowerCase()}`, 7 * DAY, async () => {
    try { const d = await http(`${b}/api/v2/smart-contracts/${addr}`, { retries: 1 }); return { status: 'ok', verified: !!(d && (d.is_verified || d.source_code)), name: d?.name || null, proxyType: d?.proxy_type || null }; }
    catch (e) { return { status: 'error: ' + e.message.slice(0, 80) }; }
  });
}
const CHAIN_IDS = { ethereum: 1, base: 8453, bsc: 56, arbitrum: 42161, polygon: 137, avalanche: 43114, blast: 81457, optimism: 10, robinhood: 4663 };

async function dsPairs(chain, addr) {
  return dcache(`ds2:${chain}:${addr.toLowerCase()}`, 12 * 3600e3, async () => {
    const d = await http(`https://api.dexscreener.com/token-pairs/v1/${chain}/${addr}`).catch(() => null);
    return (Array.isArray(d) ? d : []).filter((p) => !p.baseToken?.address || p.baseToken.address.toLowerCase() === addr.toLowerCase() || p.quoteToken?.address?.toLowerCase() === addr.toLowerCase()).map((p) => ({ pair: p.pairAddress, dex: p.dexId, labels: p.labels || [], liq: p.liquidity?.usd ?? null, base: p.baseToken?.address, quote: p.quoteToken?.symbol, created: p.pairCreatedAt || null, vol24: p.volume?.h24 ?? null, fdv: p.fdv ?? null, symbol: p.baseToken?.symbol, name: p.baseToken?.name })).sort((a, b) => (b.liq || 0) - (a.liq || 0));
  });
}

// Own transfer / sell / buy simulation with eth_call state overrides (no keys, nothing broadcast)
function decodeProbe(ret) {
  if (!isHex(ret) || ret.length < 2 + 64 * 4) return null;
  const w = (i) => BigInt('0x' + ret.slice(2 + 64 * i, 66 + 64 * i));
  const ok = w(0) === 1n, sent = w(1), recv = w(2);
  let reason = null;
  if (!ok) try { const off = Number(w(3)) * 2 + 2; const len = Number(BigInt('0x' + ret.slice(off, off + 64))); const data = ret.slice(off + 64, off + 64 + len * 2); if (data.startsWith('08c379a0')) { const l = parseInt(data.slice(72, 136), 16); reason = Buffer.from(data.slice(136, 136 + l * 2), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, ''); } else if (data) reason = 'revert 0x' + data.slice(0, 8); } catch {}
  return { ok, sent, recv, reason };
}
async function findBalanceSlot(chain, token) {
  const val = '0x' + (123456789n * 10n ** 18n).toString(16).padStart(64, '0');
  for (let s = 0; s <= 30; s++) {
    for (const vy of [false, true]) {
      const key = '0x' + keccak256(Buffer.from(vy ? pad(s.toString(16)) + pad(H_ADDR) : pad(H_ADDR) + pad(s.toString(16)), 'hex'));
      const r = await ecall(chain, token, S.balanceOf + pad(H_ADDR), { [token]: { stateDiff: { [key]: val } } });
      if (isHex(r) && r.length >= 66 && BigInt(r.slice(0, 66)) === BigInt(val)) return { slot: s, vyper: vy, key };
      if (s > 10 && !vy) break; // keep cost bounded: slots 0-10 for both layouts, 11-30 solidity layout only
    }
  }
  return null;
}
async function simulateEvm(chain, token, pairAddr, totalSupply, holders) {
  const out = { method: 'eth_call with state overrides (code override of the sender with a probe contract); nothing is broadcast', runs: [] };
  let amt = totalSupply && totalSupply > 0n ? totalSupply / 1000000n : 10n ** 18n; if (amt === 0n) amt = 1n;
  const call = async (label, sender, to, state) => {
    const data = S.probe + pad(token) + pad(to) + pad(amt.toString(16));
    const r = await ecall(chain, sender, data, { ...state, [sender]: { ...(state[sender] || {}), code: PROBE } }, sender);
    if (r?.error) { out.runs.push({ label, ok: false, error: String(r.error).slice(0, 160) }); return null; }
    const d = decodeProbe(r); if (!d) { out.runs.push({ label, ok: false, error: 'undecodable' }); return null; }
    const taxPct = d.ok && d.sent > 0n ? Number(((d.sent - d.recv) * 10000n) / d.sent) / 100 : null;
    out.runs.push({ label, ok: d.ok, taxPct, reason: d.reason, sent: d.sent.toString(), recv: d.recv.toString() }); return d;
  };
  const bs = await findBalanceSlot(chain, token);
  let fund = null, sender = null;
  if (bs) { fund = { [token]: { stateDiff: { [bs.key]: '0x' + (amt * 10n).toString(16).padStart(64, '0') } } }; sender = H_ADDR; out.balanceSlot = bs.slot + (bs.vyper ? ' (vyper layout)' : ''); }
  else {
    const h = (holders || []).find((x) => +x.is_contract === 0 && +x.is_locked === 0 && !DEADS.test(x.address));
    if (h) { sender = h.address.toLowerCase(); fund = {}; out.sender = 'top non-contract holder ' + sender + ' (balance slot not found; reflection/non-standard storage)'; }
  }
  if (sender) {
    await call('plain transfer to a fresh wallet', sender, R_ADDR, fund);
    if (pairAddr) await call('sell path: transfer into the main DEX pair', sender, pairAddr, fund);
  } else out.note = 'no balance slot and no holder to simulate from';
  if (pairAddr) await call('buy path: transfer out of the main DEX pair to a fresh wallet', pairAddr, R_ADDR, {});
  const g = (l) => out.runs.find((r) => r.label.startsWith(l));
  const plain = g('plain'), sell = g('sell'), buy = g('buy');
  out.sellBlocked = sell ? !sell.ok && (buy ? buy.ok : true) && (plain ? plain.ok : true) : null;
  out.transferBlocked = plain ? !plain.ok : null;
  out.sellTaxPct = sell?.ok ? sell.taxPct : null; out.buyTaxPct = buy?.ok ? buy.taxPct : null; out.transferTaxPct = plain?.ok ? plain.taxPct : null;
  return out;
}

async function evmScan(chain, addr, opts = {}) {
  const c = CHAINS[chain]; const a = addr.toLowerCase();
  const src = {}; const f = {}; const ev = {};
  const code = await rpc(chain, 'eth_getCode', [a, 'latest']).then((x) => { src.rpc = 'ok'; return x; }).catch((e) => { src.rpc = 'failed: ' + e.message.slice(0, 100); return null; });
  if (code == null) return { chain, address: addr, scannable: false, reason: 'RPC unavailable', sources: src };
  if (code === '0x') return { chain, address: addr, scannable: false, reason: 'no contract code at address (self-destructed or wrong chain/address)', sources: src };
  const [gp, hp, pairs] = await Promise.all([
    opts.noGoplus ? { status: 'skipped' } : goplusEvm(chain, a).catch((e) => ({ status: 'error: ' + e.message })),
    opts.noHoneypot ? { status: 'skipped' } : honeypotIs(chain, a),
    opts.pairs ? Promise.resolve(opts.pairs) : dsPairs(chain, a).catch(() => []),
  ]);
  src.goplus = gp.status; src.honeypot_is = hp.status; src.dexscreener = pairs.length ? `${pairs.length} pairs` : 'no pairs';
  const g = gp.r || null; const one = (k) => (g && g[k] != null && g[k] !== '' ? g[k] === '1' || g[k] === 1 : null);
  // proxy slots
  const slots = {};
  for (const [k, s] of Object.entries(SLOTS)) { const v = await rpc(chain, 'eth_getStorageAt', [a, s, 'latest']).catch(() => null); slots[k] = v && !/^0x0*$/.test(v) ? '0x' + v.slice(-40) : null; }
  const ca = analyzeCode(code);
  let impl = slots.eip1967_impl || slots.oz_legacy_impl || null; // upgradeable proxy implementation
  const clone = ca.minimalProxyTo || null; // EIP-1167 clone: fixed implementation, NOT upgradeable
  if (!impl && slots.eip1967_beacon) { impl = asAddr(await ecall(chain, slots.eip1967_beacon, S.implementation)); ev.beacon = slots.eip1967_beacon; }
  if (!impl && slots.eip1822_proxiable) impl = slots.eip1822_proxiable;
  let ia = null; if (impl || clone) { const ic = await rpc(chain, 'eth_getCode', [impl || clone, 'latest']).catch(() => null); ia = analyzeCode(ic); }
  const fam = { ...(ca.families || {}) }; if (ia) for (const [k, v] of Object.entries(ia.families)) fam[k] = [...new Set([...(fam[k] || []), ...v])];
  f.proxy = !!impl || one('is_proxy') === true; f.clone = !!clone; ev.proxy = { implementation: impl, cloneOf: clone, slots: Object.fromEntries(Object.entries(slots).filter(([, v]) => v)), goplus_is_proxy: one('is_proxy'), minimalProxy: !!clone };
  // ownership
  const ownerRaw = await ecall(chain, a, S.owner); const owner = asAddr(ownerRaw) || asAddr(await ecall(chain, a, S.getOwner));
  const roleAdmin = asAddr(await ecall(chain, a, S.getRoleMember + pad('0') + pad('0')));
  const proxyAdmin = slots.eip1967_admin;
  const ownerAddr = owner && !DEADS.test(owner) ? owner : null;
  const oc = ownerAddr ? await classifyAddress(chain, ownerAddr) : null;
  const pac = proxyAdmin ? await classifyAddress(chain, proxyAdmin) : null;
  if (pac && pac.contractOwner && !DEADS.test(pac.contractOwner)) pac.ownerOfAdmin = await classifyAddress(chain, pac.contractOwner);
  const rac = roleAdmin && !DEADS.test(roleAdmin) ? await classifyAddress(chain, roleAdmin) : null;
  const gpOwner = g?.owner_address && !DEADS.test(g.owner_address) ? g.owner_address.toLowerCase() : null;
  f.owner_retained = !!(ownerAddr || gpOwner || rac); // someone holds an owner/admin role
  f.owner_function = !!(owner || (ca.families.ownable || ia?.families?.ownable));
  f.owner_renounced = !!owner && DEADS.test(owner);
  f.owner_type = oc?.type || rac?.type || (gpOwner ? 'owner per GoPlus (not readable via owner())' : owner ? 'none (renounced)' : 'no owner() function');
  f.owner_multisig = !!(oc?.multisig || rac?.multisig); f.owner_timelock = !!(oc?.timelock || rac?.timelock);
  f.owner_eoa = /^EOA/.test(oc?.type || rac?.type || '');
  f.proxy_admin_eoa = !!(pac && (/^EOA/.test(pac.type) || /^EOA/.test(pac.ownerOfAdmin?.type || '')));
  f.upgradeable_by_eoa = f.proxy && (f.proxy_admin_eoa || (!proxyAdmin && f.owner_eoa));
  ev.owner = { owner: owner || null, ownerClass: oc, accessControlAdmin: rac, proxyAdmin: pac, goplusOwner: g?.owner_address || null };
  // privilege / honeypot features (GoPlus first, bytecode selectors as fallback/extra)
  f.verified_source = g?.is_open_source === '1' ? true : g?.is_open_source === '0' ? false : null;
  const sfy = await sourcify(CHAIN_IDS[chain] || 0, a); const bsc = opts.noBlockscout ? { status: 'skipped' } : await blockscout(chain, a);
  src.sourcify = sfy.status; src.blockscout = bsc.status;
  if (sfy.match) f.verified_source = true; if (bsc.verified) f.verified_source = true; if (hp.r?.contractCode?.openSource === true) f.verified_source = true;
  if (f.verified_source == null && sfy.status === 'ok' && !sfy.match && bsc.status === 'ok' && !bsc.verified) f.verified_source = false;
  ev.verified = { goplus: g?.is_open_source ?? null, sourcify: sfy.match || null, blockscout: bsc.verified ?? null, honeypot_is: hp.r?.contractCode?.openSource ?? null };
  f.mintable = one('is_mintable') ?? (fam.mint ? true : null); f.mint_selector = !!fam.mint;
  f.mint_owner_only = f.mintable ? !!(f.owner_retained) : false;
  f.blacklist = one('is_blacklisted') ?? (fam.blacklist ? true : null); f.whitelist = one('is_whitelisted') ?? (fam.whitelist ? true : null);
  f.pausable = one('transfer_pausable') ?? (fam.pause ? true : null); f.trading_switch = !!fam.tradingSwitch;
  f.anti_whale = one('is_anti_whale') ?? (fam.maxTx ? true : null); f.anti_whale_modifiable = one('anti_whale_modifiable');
  f.tax_modifiable = one('slippage_modifiable') ?? (fam.taxSet ? true : null); f.personal_tax_modifiable = one('personal_slippage_modifiable');
  f.cooldown = one('trading_cooldown'); f.hidden_owner = one('hidden_owner'); f.take_back_ownership = one('can_take_back_ownership');
  f.owner_change_balance = one('owner_change_balance'); f.selfdestruct = one('selfdestruct') ?? (ca.ops.selfdestruct > 0 || (ia?.ops.selfdestruct || 0) > 0 ? true : null);
  f.external_call = one('external_call'); f.creator_honeypot_history = one('honeypot_with_same_creator');
  f.tx_origin_checks = ca.ops.origin > 0 || (ia?.ops.origin || 0) > 0;
  // honeypot
  const sim = hp.r?.simulationSuccess ? hp.r.simulationResult : null;
  // Honeypot.is sets isHoneypot also when only its holder-sell analysis shows a high fail rate while its own buy/sell simulation passed:
  // keep the two apart (holder sells can fail for locked / vesting / contract holders).
  const hpFlags = hp.r?.flags || []; const ha = hp.r?.holderAnalysis;
  const hpOnlyFailRate = !!hp.r?.honeypotResult?.isHoneypot && sim && hpFlags.length > 0 && hpFlags.every((x) => /fail_rate/i.test(typeof x === 'string' ? x : x.flag || ''));
  f.hp_is_honeypot = hp.r?.honeypotResult ? !!hp.r.honeypotResult.isHoneypot && !hpOnlyFailRate : null;
  f.hp_holder_sell_fail_pct = ha && +ha.holders > 0 ? Math.round((+ha.failed / +ha.holders) * 1000) / 10 : null;
  if (hp.r) ev.honeypotIs = { isHoneypot: hp.r.honeypotResult?.isHoneypot ?? null, reason: hp.r.honeypotResult?.honeypotReason || null, flags: hpFlags.map((x) => (typeof x === 'string' ? x : x.flag)), simulation: sim, holderAnalysis: ha ? { holders: ha.holders, successful: ha.successful, failed: ha.failed, highestTax: ha.highestTax, siphoned: ha.siphoned } : null, pair: hp.r.pair?.pair?.name || null, verdictFromHolderFailRateOnly: hpOnlyFailRate };
  f.gp_is_honeypot = one('is_honeypot'); f.cannot_sell_all = one('cannot_sell_all'); f.cannot_buy = one('cannot_buy');
  const num = (x) => (x === '' || x == null || isNaN(+x) ? null : +x * 100);
  f.buy_tax = sim ? sim.buyTax : num(g?.buy_tax); f.sell_tax = sim ? sim.sellTax : num(g?.sell_tax); f.transfer_tax = sim ? sim.transferTax : num(g?.transfer_tax);
  // own simulation
  let ts = null; try { const t = await ecall(chain, a, S.totalSupply); if (isHex(t) && t.length >= 66) ts = BigInt(t.slice(0, 66)); } catch {}
  const isAddrPair = (p) => /^0x[0-9a-f]{40}$/i.test(p.pair || '');
  const v2 = pairs.find((p) => isAddrPair(p) && (p.labels || []).includes('v2')) || pairs.find((p) => isAddrPair(p) && !(p.labels || []).some((l) => /v3|v4|cl|dlmm/i.test(l)));
  const anyPair = v2 || pairs.find(isAddrPair);
  let own = null;
  if (!opts.noSim) { try { own = await simulateEvm(chain, a, anyPair?.pair?.toLowerCase() || null, ts, g?.holders); } catch (e) { own = { error: e.message }; } }
  if (own && !anyPair) own.note = (own.note ? own.note + '; ' : '') + (pairs.length ? 'only Uniswap-V4-style pools (pool id, not an address): sell path is via the PoolManager, not simulated' : 'no DEX pair found: sell/buy path not simulated');
  if (own) { f.sim_sell_blocked = own.sellBlocked; f.sim_transfer_blocked = own.transferBlocked; f.sim_sell_tax = own.sellTaxPct; f.sim_buy_tax = own.buyTaxPct; ev.simulation = { ...own, pair: anyPair?.pair || null, pairDex: anyPair ? `${anyPair.dex} ${(anyPair.labels || []).join('/')}` : null }; }
  f.honeypot = [f.hp_is_honeypot, f.gp_is_honeypot, f.cannot_sell_all, f.sim_sell_blocked].some((x) => x === true) ? true : [f.hp_is_honeypot, f.gp_is_honeypot, f.sim_sell_blocked].some((x) => x === false) ? false : null;
  const taxes = [f.sell_tax, f.buy_tax, f.sim_sell_tax, f.sim_buy_tax].filter((x) => x != null);
  f.max_tax = taxes.length ? Math.max(...taxes) : null;
  f.hidden_tax = (f.sim_sell_tax != null && f.sim_sell_tax > 1 && (f.sell_tax == null || f.sell_tax < 1)) || (f.sim_buy_tax != null && f.sim_buy_tax > 1 && (f.buy_tax == null || f.buy_tax < 1)) ? true : f.sim_sell_tax != null ? false : null;
  ev.code = { bytes: ca.bytes, skeleton: ca.skeleton, implSkeleton: ia?.skeleton || null, families: fam, ops: ca.ops, implOps: ia?.ops || null };
  const main = pairs[0] || null;
  return { chain, address: addr, kind: 'evm', scannable: true, name: g?.token_name || main?.name || null, symbol: g?.token_symbol || main?.symbol || null,
    features: f, evidence: ev, selectors: [...new Set([...(ca.selectors || []), ...(ia?.selectors || [])])].sort(), skeleton: ia?.skeleton || ca.skeleton,
    market: { pairs: pairs.length, liqUsd: pairs.reduce((s, p) => s + (p.liq || 0), 0), mainPair: main?.pair || null, mainDex: main ? main.dex : null, firstPairAt: pairs.reduce((m, p) => (p.created && (!m || p.created < m) ? p.created : m), null) },
    holders: g?.holder_count ? +g.holder_count : null, creator: g?.creator_address || null, sources: src, scannedAt: Date.now() };
}

// ---------------- Solana ----------------
async function solRpc(method, params) {
  const j = await http(SOL_RPC, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, retries: 4, timeout: 30000 });
  if (j?.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { rpcError: j.error });
  return j?.result;
}
async function rugcheck(mint) {
  return dcache(`rc:${mint}`, 3 * DAY, async () => {
    try { const d = await http(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { retries: 3, timeout: 40000 }); if (!d) return { status: 'not found' };
      return { status: 'ok', r: { score: d.score, score_normalised: d.score_normalised, rugged: d.rugged, risks: d.risks || [], tokenMeta: d.tokenMeta ? { mutable: d.tokenMeta.mutable, updateAuthority: d.tokenMeta.updateAuthority, name: d.tokenMeta.name, symbol: d.tokenMeta.symbol } : null, mintAuthority: d.mintAuthority, freezeAuthority: d.freezeAuthority, creator: d.creator, transferFee: d.transferFee, launchpad: d.launchpad?.name || null, totalHolders: d.totalHolders, lpLockedPct: d.markets?.length ? Math.max(...d.markets.map((m) => m.lp?.lpLockedPct || 0)) : null, topHolders: (d.topHolders || []).slice(0, 10).map((h) => ({ owner: h.owner, address: h.address, pct: h.pct, insider: h.insider })), knownAccounts: Object.fromEntries(Object.entries(d.knownAccounts || {}).slice(0, 30)), verification: d.verification ? { jup_verified: d.verification.jup_verified, jup_strict: d.verification.jup_strict } : null, detectedAt: d.detectedAt || null } }; }
    catch (e) { return { status: 'error: ' + e.message.slice(0, 120) }; }
  });
}
async function goplusSol(mint) {
  return dcache(`gps:${mint}`, 3 * DAY, async () => {
    try { const d = await gpGet(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mint}`); if (d && d.code !== 1) return { status: 'error: ' + d.message }; const r = d?.result?.[mint];
      if (!r) return { status: 'not indexed by GoPlus' }; const { dex, holders, lp_holders, ...rest } = r; return { status: 'ok', r: rest }; }
    catch (e) { return { status: 'error: ' + e.message.slice(0, 120) }; }
  });
}
async function programUpgradeability(programId) {
  return dcache(`prog:${programId}`, 7 * DAY, async () => {
    const acc = await solRpc('getAccountInfo', [programId, { encoding: 'jsonParsed' }]).catch((e) => ({ err: e.message }));
    if (acc?.err) return { status: 'error: ' + acc.err };
    const v = acc?.value; if (!v) return { status: 'program account not found' };
    if (v.owner !== UPGRADEABLE_LOADER) return { status: 'ok', upgradeable: false, loader: v.owner, note: 'non-upgradeable loader' };
    const pd = v.data?.parsed?.info?.programData; if (!pd) return { status: 'ok', upgradeable: null };
    const pda = await solRpc('getAccountInfo', [pd, { encoding: 'jsonParsed', dataSlice: { offset: 0, length: 0 } }]).catch(() => null);
    const auth = pda?.value?.data?.parsed?.info?.authority ?? null;
    return { status: 'ok', upgradeable: !!auth, upgradeAuthority: auth };
  });
}
// Sell simulation: Jupiter route for a real holder -> simulateTransaction (sigVerify off). Nothing is signed or sent.
async function solSellSim(mint, holders, decimals) {
  const out = { method: 'Jupiter lite-api quote+swap tx for a real holder, then RPC simulateTransaction (no signature, nothing sent)', tries: [] };
  for (const h of (holders || []).filter((x) => x.owner && x.pct > 0.01 && x.pct < 30).slice(0, 3)) {
    try {
      const bal = await solRpc('getTokenAccountBalance', [h.address]); const amt = BigInt(bal?.value?.amount || '0') / 100n; if (amt <= 0n) continue;
      const q = await http(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${WSOL}&amount=${amt}&slippageBps=5000`, { retries: 1 });
      if (!q || q.error || !q.routePlan) { out.tries.push({ holder: h.owner, result: 'no route: ' + (q?.error || 'none') }); out.noRoute = true; break; }
      const sw = await http('https://lite-api.jup.ag/swap/v1/swap', { method: 'POST', body: { quoteResponse: q, userPublicKey: h.owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }, retries: 1 });
      if (!sw?.swapTransaction) { out.tries.push({ holder: h.owner, result: 'swap build failed' }); continue; }
      const sim = await solRpc('simulateTransaction', [sw.swapTransaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }]);
      const err = sim?.value?.err; const logs = (sim?.value?.logs || []).filter((l) => /error|failed|frozen|insufficient/i.test(l)).slice(0, 3);
      out.tries.push({ holder: h.owner, amountRaw: amt.toString(), outLamports: q.outAmount, err: err ? JSON.stringify(err).slice(0, 160) : null, logs });
      if (!err) { out.sellOk = true; out.quoteImpactPct = q.priceImpactPct != null ? +q.priceImpactPct * 100 : null; break; }
      if (logs.some((l) => /frozen/i.test(l))) { out.frozen = true; }
    } catch (e) { out.tries.push({ holder: h.owner, result: 'error ' + e.message.slice(0, 100) }); }
  }
  if (out.sellOk == null) out.sellOk = out.tries.some((t) => t.err) && !out.tries.some((t) => !t.err && t.outLamports) ? false : null;
  return out;
}
// At-launch reconstruction: if the full signature history is reachable, read InitializeMint + SetAuthority in the earliest txs
async function solLaunchState(mint, maxPages = 3) {
  return dcache(`sollaunch:${mint}:${maxPages}`, 30 * DAY, async () => {
    let before, all = [], reached = false;
    for (let i = 0; i < maxPages; i++) {
      const page = await solRpc('getSignaturesForAddress', [mint, { limit: 1000, ...(before ? { before } : {}) }]).catch(() => null);
      if (!page) return { status: 'signature paging failed' };
      all.push(...page); if (page.length < 1000) { reached = true; break; } before = page[page.length - 1].signature;
    }
    if (!reached) return { status: `history deeper than ${all.length} txs (public RPC paging cap)`, reached: false };
    const oldest = all.slice(-4).reverse(); const ev = [];
    let init = null;
    for (const s of oldest) {
      const tx = await solRpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]).catch(() => null); if (!tx) continue;
      const ixs = [...(tx.transaction?.message?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap((x) => x.instructions)];
      for (const ix of ixs) {
        const t = ix.parsed?.type, i = ix.parsed?.info || {};
        if (/^initializeMint2?$/.test(t || '') && i.mint === mint) { init = { mintAuthority: i.mintAuthority || null, freezeAuthority: i.freezeAuthority || null, slot: s.slot, time: s.blockTime }; ev.push({ t, slot: s.slot, ...init }); }
        if (t === 'setAuthority' && (i.mint === mint || i.account === mint)) ev.push({ t, slot: s.slot, time: s.blockTime, authorityType: i.authorityType, newAuthority: i.newAuthority ?? null });
      }
    }
    if (!init) return { status: 'earliest txs did not contain InitializeMint (parsed)', reached: true, txs: all.length };
    const st = { mint: !!init.mintAuthority, freeze: !!init.freezeAuthority };
    for (const e of ev.filter((x) => x.t === 'setAuthority')) { if (/mint/i.test(e.authorityType)) st.mint = !!e.newAuthority; if (/freeze/i.test(e.authorityType)) st.freeze = !!e.newAuthority; }
    return { status: 'ok', reached: true, txs: all.length, initialize: init, firstTxEvents: ev, afterCreationTxs: { mintAuthority: st.mint, freezeAuthority: st.freeze } };
  });
}

async function solScan(mint, opts = {}) {
  const src = {}; const f = {}; const ev = {};
  const acc = await solRpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]).then((x) => { src.rpc = 'ok'; return x; }).catch((e) => { src.rpc = 'failed: ' + e.message.slice(0, 100); return null; });
  const [rc, gps, pairs] = await Promise.all([opts.noRugcheck ? { status: 'skipped' } : rugcheck(mint), opts.noGoplus ? { status: 'skipped' } : goplusSol(mint), opts.pairs ? Promise.resolve(opts.pairs) : dsPairs('solana', mint).catch(() => [])]);
  src.rugcheck = rc.status; src.goplus = gps.status; src.dexscreener = pairs.length ? `${pairs.length} pairs` : 'no pairs';
  const v = acc?.value; const parsed = v?.data?.parsed; const mi = parsed?.type === 'mint' ? parsed.info : null;
  if (!v && !rc.r) return { chain: 'solana', address: mint, scannable: false, reason: acc === null ? 'RPC unavailable and RugCheck has no report' : 'mint account does not exist (closed or wrong address)', sources: src };
  const program = v?.owner || null;
  f.token2022 = program === TOKEN22; f.custom_program = !!program && program !== TOKEN && program !== TOKEN22;
  if (f.custom_program) { ev.customProgram = { program, upgradeability: await programUpgradeability(program) }; f.custom_program_upgradeable = ev.customProgram.upgradeability.upgradeable ?? null; }
  const rr = rc.r || {};
  f.mint_authority = mi ? !!mi.mintAuthority : rr.mintAuthority !== undefined ? !!rr.mintAuthority : null;
  f.freeze_authority = mi ? !!mi.freezeAuthority : rr.freezeAuthority !== undefined ? !!rr.freezeAuthority : null;
  ev.authorities = { mintAuthority: mi?.mintAuthority ?? rr.mintAuthority ?? null, freezeAuthority: mi?.freezeAuthority ?? rr.freezeAuthority ?? null, source: mi ? 'RPC getAccountInfo (jsonParsed)' : 'RugCheck' };
  const exts = mi?.extensions || []; const E = Object.fromEntries(exts.map((e) => [e.extension, e.state || {}]));
  ev.extensions = exts.map((e) => e.extension);
  const tf = E.transferFeeConfig;
  if (tf) { const nf = tf.newerTransferFee || {}, of = tf.olderTransferFee || {}; f.transfer_fee_bps = Math.max(+nf.transferFeeBasisPoints || 0, +of.transferFeeBasisPoints || 0); f.transfer_fee_max_raw = nf.maximumFee ?? null; f.transfer_fee_authority = !!tf.transferFeeConfigAuthority; f.transfer_fee_modifiable = !!tf.transferFeeConfigAuthority; ev.transferFee = { newer: nf, older: of, configAuthority: tf.transferFeeConfigAuthority || null, withdrawAuthority: tf.withdrawWithheldAuthority || null, maxFeeUi: nf.maximumFee != null && mi?.decimals != null ? Number(nf.maximumFee) / 10 ** mi.decimals : null }; }
  else f.transfer_fee_bps = f.token2022 ? 0 : (rr.transferFee?.pct ? rr.transferFee.pct * 100 : 0);
  if (E.transferHook) { const pid = E.transferHook.programId || null; f.transfer_hook = !!pid; f.transfer_hook_authority = !!E.transferHook.authority; ev.transferHook = { programId: pid, authority: E.transferHook.authority || null }; if (pid) { ev.transferHook.upgradeability = await programUpgradeability(pid); f.transfer_hook_upgradeable = ev.transferHook.upgradeability.upgradeable ?? null; } }
  else f.transfer_hook = false;
  f.permanent_delegate = !!E.permanentDelegate?.delegate; if (f.permanent_delegate) ev.permanentDelegate = E.permanentDelegate.delegate;
  f.non_transferable = 'nonTransferable' in E;
  f.default_frozen = /frozen/i.test(E.defaultAccountState?.accountState || '');
  f.pausable = 'pausableConfig' in E ? true : false; if (E.pausableConfig) ev.pausable = E.pausableConfig;
  f.mint_close_authority = !!E.mintCloseAuthority?.closeAuthority;
  f.scaled_ui_amount = 'scaledUiAmountConfig' in E || 'interestBearingConfig' in E; // displayed balances can be rescaled by an authority
  const tmeta = E.tokenMetadata;
  f.metadata_mutable = tmeta ? !!tmeta.updateAuthority : rr.tokenMeta ? !!rr.tokenMeta.mutable : gps.r?.metadata_mutable ? gps.r.metadata_mutable.status === '1' : null;
  ev.metadata = { updateAuthority: tmeta?.updateAuthority || rr.tokenMeta?.updateAuthority || (gps.r?.metadata_mutable?.metadata_upgrade_authority || [])[0]?.address || null, source: tmeta ? 'Token-2022 tokenMetadata extension' : rr.tokenMeta ? 'RugCheck (Metaplex)' : gps.r ? 'GoPlus' : null };
  if (gps.r) { const st = (k) => (gps.r[k]?.status != null ? gps.r[k].status === '1' : null); f.gp_balance_mutable = st('balance_mutable_authority'); f.gp_closable = st('closable'); f.gp_default_state_upgradable = st('default_account_state_upgradable'); f.gp_transfer_fee_upgradable = st('transfer_fee_upgradable'); f.gp_transfer_hook_upgradable = st('transfer_hook_upgradable'); f.gp_trusted = gps.r.trusted_token === 1 || gps.r.trusted_token === '1'; }
  // RugCheck
  if (rc.r) { f.rugcheck_score = rr.score_normalised ?? null; f.rugcheck_rugged = !!rr.rugged; f.rugcheck_danger = (rr.risks || []).filter((x) => x.level === 'danger').map((x) => x.name); f.lp_locked_pct = rr.lpLockedPct; ev.rugcheck = { risks: (rr.risks || []).map((x) => `${x.level}: ${x.name}${x.value ? ' (' + x.value + ')' : ''}`), launchpad: rr.launchpad, creator: rr.creator, holders: rr.totalHolders }; }
  // honeypot-ish on Solana: anything that lets an authority block or take your tokens
  f.honeypot_mechanics = !!(f.freeze_authority || f.default_frozen || f.non_transferable || f.permanent_delegate || (f.transfer_hook && f.transfer_hook_upgradeable !== false) || f.pausable || (f.transfer_fee_bps || 0) >= 1000);
  if (opts.simulate && (pairs[0]?.liq || 0) > 1000 && rr.topHolders?.length) {
    const excl = new Set(pairs.map((p) => p.pair)); for (const [k, x] of Object.entries(rr.knownAccounts || {})) if (/AMM|LOCKER|POOL|BONDING/i.test(x.type || '')) excl.add(k);
    ev.sellSim = await solSellSim(mint, rr.topHolders.filter((h) => !excl.has(h.owner)), mi?.decimals);
    f.sim_sell_ok = ev.sellSim.sellOk ?? null; f.sim_sell_no_route = !!ev.sellSim.noRoute;
  }
  if (opts.history) { ev.launch = await solLaunchState(mint, opts.historyPages || 3).catch((e) => ({ status: 'error ' + e.message })); if (ev.launch.status === 'ok') { f.launch_mint_authority = ev.launch.afterCreationTxs.mintAuthority; f.launch_freeze_authority = ev.launch.afterCreationTxs.freezeAuthority; } }
  const main = pairs[0] || null;
  return { chain: 'solana', address: mint, kind: 'solana', scannable: true, name: rr.tokenMeta?.name || main?.name || null, symbol: rr.tokenMeta?.symbol || main?.symbol || null, program, features: f, evidence: ev,
    market: { pairs: pairs.length, liqUsd: pairs.reduce((s, p) => s + (p.liq || 0), 0), mainPair: main?.pair || null, mainDex: main?.dex || null, firstPairAt: pairs.reduce((m, p) => (p.created && (!m || p.created < m) ? p.created : m), null) },
    holders: rr.totalHolders ?? (gps.r?.holder_count ? +gps.r.holder_count : null), creator: rr.creator || null, sources: src, scannedAt: Date.now() };
}

// ---------------- EVM at-launch ownership (OwnershipTransferred logs, where a keyless log source exists) ----------------
const OT = '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0';
async function evmOwnershipHistory(chain, addr) {
  return dcache(`own:${chain}:${addr.toLowerCase()}`, 30 * DAY, async () => {
    let logs = null, how = null;
    if (chain === 'ethereum') { const d = await http(`https://eth.blockscout.com/api?module=logs&action=getLogs&address=${addr}&topic0=${OT}&fromBlock=0&toBlock=latest`).catch(() => null); if (d && Array.isArray(d.result)) { logs = d.result.map((l) => ({ block: parseInt(l.blockNumber, 16), time: parseInt(l.timeStamp, 16), from: '0x' + l.topics[1].slice(-40), to: '0x' + l.topics[2].slice(-40) })); how = 'eth.blockscout.com logs API'; } }
    else if (chain === 'robinhood') {
      const head = parseInt(await rpc(chain, 'eth_blockNumber', []), 16); logs = []; how = 'Robinhood Chain RPC eth_getLogs (10M-block windows)';
      for (let from = 0; from <= head; from += 10000000) { const r = await rpc(chain, 'eth_getLogs', [{ address: addr, topics: [OT], fromBlock: '0x' + from.toString(16), toBlock: '0x' + Math.min(head, from + 9999999).toString(16) }]).catch(() => null); if (!r) { logs = null; break; } logs.push(...r.map((l) => ({ block: parseInt(l.blockNumber, 16), from: '0x' + l.topics[1].slice(-40), to: '0x' + l.topics[2].slice(-40) }))); }
      if (logs) for (const l of logs) { const b = await rpc(chain, 'eth_getBlockByNumber', ['0x' + l.block.toString(16), false]).catch(() => null); l.time = b ? parseInt(b.timestamp, 16) : null; }
    } else return { status: 'no keyless archive log source for ' + chain + ' (publicnode requires a token for archive eth_getLogs)' };
    if (!logs) return { status: 'log query failed' };
    logs.sort((a, b) => a.block - b.block);
    const renounce = logs.find((l) => DEADS.test(l.to));
    return { status: 'ok', how, events: logs.slice(0, 20), deployOwner: logs[0]?.to || null, renouncedAt: renounce ? renounce.time : null, renouncedBlock: renounce?.block || null, hasOwnable: logs.length > 0 };
  });
}

async function scanToken(chain, address, opts = {}) {
  const c = CHAINS[chain];
  if (!c) return { chain, address, scannable: false, reason: `chain "${chain}" not supported by the scanner` };
  if (chain === 'solana') return solScan(address, opts);
  if (c.kind === 'evm') { const r = await evmScan(chain, address, opts); if (opts.history && r.scannable) { r.evidence.ownershipHistory = await evmOwnershipHistory(chain, address).catch((e) => ({ status: 'error ' + e.message })); } return r; }
  return { chain, address, scannable: false, reason: `${c.name} (${c.kind}) contract checks not implemented in contractscan (scanner.js covers Sui/TON basics)` };
}

// ---------------- risk factors: plain-English flags from features ----------------
function riskFlags(r, templates) {
  const f = r.features || {}; const out = [];
  const add = (sev, id, title, plain) => out.push({ sev, id, title, plain });
  if (!r.scannable) return out;
  if (r.kind === 'evm') {
    if (f.honeypot === true) add('critical', 'honeypot', 'Honeypot: selling looks blocked', `At least one independent check says you may not be able to sell: ${[f.hp_is_honeypot && 'Honeypot.is buy/sell simulation failed', f.gp_is_honeypot && 'GoPlus flags it as a honeypot', f.cannot_sell_all && 'GoPlus: holders cannot sell their whole balance', f.sim_sell_blocked && 'our own simulated sell into the pool reverted'].filter(Boolean).join('; ')}.`);
    if (f.honeypot !== true && f.hp_holder_sell_fail_pct != null && f.hp_holder_sell_fail_pct >= 5) add('medium', 'holder_fails', `${f.hp_holder_sell_fail_pct}% of simulated holder sells fail`, `Honeypot.is re-ran sells for real holders and ${f.hp_holder_sell_fail_pct}% failed (its own fresh buy/sell passed). Often locked, vesting or contract wallets, but can also mean selective blocking.`);
    if (f.max_tax != null && f.max_tax > 10) add(f.max_tax >= 50 ? 'critical' : 'high', 'tax', `High trading tax (${f.max_tax.toFixed(1)}%)`, `Buying or selling loses about ${f.max_tax.toFixed(1)}% to the contract. Taxes above 10% are mostly used to drain buyers.`);
    if (f.hidden_tax) add('high', 'hidden_tax', 'Hidden tax found by simulation', `Our simulated transfer into the pool lost ${f.sim_sell_tax ?? f.sim_buy_tax}% while the public scanners report ~0%: the tax is not advertised.`);
    if (f.owner_change_balance) add('critical', 'balance_edit', 'Owner can change balances', 'The owner can edit anyone\'s balance, i.e. confiscate or print tokens.');
    if (f.hidden_owner || f.take_back_ownership) add('critical', 'hidden_owner', 'Hidden or reclaimable ownership', 'Ownership looks renounced but a hidden owner or a reclaim function exists.');
    if (f.mintable && f.owner_retained) add(f.owner_multisig || f.owner_timelock ? 'low' : f.owner_eoa ? 'high' : 'medium', 'mint', 'Owner can mint new tokens', `A mint function exists and an admin (${f.owner_type}) still controls the contract: supply can be inflated and dumped on holders${f.owner_eoa ? '' : ' (admin is a contract: check whether it is an emissions/staking contract)'}.`);
    else if (f.mintable) add('medium', 'mint', 'Mint function present', 'A mint function exists; no active owner was found, but another role may still be able to call it.');
    if (f.upgradeable_by_eoa) add('high', 'proxy_eoa', 'Upgradeable by a single wallet', 'The token is an upgradeable proxy whose admin is a plain wallet address (one private key, or an MPC/custodian wallet: indistinguishable on-chain): its code, and with it your balance, can be swapped at any moment.');
    else if (f.proxy) add(f.owner_multisig || f.owner_timelock ? 'low' : 'medium', 'proxy', 'Upgradeable proxy', `The token's logic lives in a separate implementation that an admin can replace${f.owner_timelock ? ' (behind a timelock)' : f.owner_multisig ? ' (admin is a multisig)' : ''}.`);
    const sw = [f.blacklist && 'blacklist', f.whitelist && 'whitelist', f.pausable && 'pause transfers', f.trading_switch && 'trading on/off switch', f.anti_whale_modifiable && 'changeable max-tx/max-wallet', f.tax_modifiable && 'changeable tax', f.personal_tax_modifiable && 'per-wallet tax', f.cooldown && 'trading cooldown'].filter(Boolean);
    if (sw.length && f.owner_retained) add(sw.some((x) => /blacklist|pause|tax/.test(x)) ? 'high' : 'medium', 'switches', 'Owner-controlled trading switches', `The active owner (${f.owner_type}) has: ${sw.join(', ')}. Any of these can be used to stop you selling or to raise the tax later.`);
    else if (sw.length) add('low', 'switches', 'Trading switches (owner renounced)', `Code contains ${sw.join(', ')}, but no active owner was found, so they should be inert unless another role exists.`);
    if (f.owner_retained && !f.owner_multisig && !f.owner_timelock) add(f.owner_eoa ? 'medium' : 'low', 'owner', 'Ownership not renounced', `Admin rights are held by ${f.owner_type}${f.owner_eoa ? ': one leaked or malicious key controls every privileged function' : ''}.`);
    if (f.verified_source === false) add('medium', 'unverified', 'Source code not verified', 'No verified source on the explorer, Sourcify or Blockscout: nobody can review what the privileged functions do.');
    if (f.selfdestruct) add('high', 'selfdestruct', 'Self-destruct opcode present', 'The contract (or its implementation) contains SELFDESTRUCT.');
    if (f.creator_honeypot_history) add('critical', 'creator', 'Creator deployed honeypots before', 'GoPlus links the deployer wallet to earlier honeypot tokens.');
  } else {
    if (f.mint_authority) add('high', 'mint', 'Mint authority active', `Wallet ${String(r.evidence?.authorities?.mintAuthority).slice(0, 6)}… can mint unlimited new tokens.`);
    if (f.freeze_authority) add('high', 'freeze', 'Freeze authority active', 'An authority can freeze your token account so you cannot sell (classic Solana honeypot).');
    if (f.permanent_delegate) add('critical', 'perm_delegate', 'Permanent delegate (Token-2022)', 'A permanent delegate can transfer or burn tokens out of ANY holder\'s wallet without permission.');
    if (f.non_transferable) add('critical', 'non_transferable', 'Non-transferable token', 'Token-2022 non-transferable extension: holders cannot send or sell it.');
    if (f.default_frozen) add('critical', 'default_frozen', 'New accounts start frozen', 'Default account state is FROZEN: every new buyer\'s account is frozen until the authority thaws it.');
    if (f.pausable) add('high', 'pausable', 'Pausable (Token-2022)', 'An authority can pause all transfers.');
    if (f.transfer_hook) add(f.transfer_hook_upgradeable === false ? 'medium' : 'high', 'hook', 'Transfer hook program', `Every transfer runs custom program ${String(r.evidence?.transferHook?.programId).slice(0, 6)}…${f.transfer_hook_upgradeable ? ', which is UPGRADEABLE: its owner can make sells fail at any time' : f.transfer_hook_upgradeable === false ? ' (immutable)' : ''}.`);
    if ((f.transfer_fee_bps || 0) > 0) add(f.transfer_fee_bps >= 1000 ? 'high' : f.transfer_fee_modifiable ? 'medium' : 'low', 'tfee', `Transfer fee ${(f.transfer_fee_bps / 100).toFixed(2)}%`, `Token-2022 transfer fee of ${(f.transfer_fee_bps / 100).toFixed(2)}%${r.evidence?.transferFee?.maxFeeUi != null ? ` (max ${r.evidence.transferFee.maxFeeUi} tokens per transfer)` : ''}${f.transfer_fee_modifiable ? '; the fee authority can raise it (up to 100%)' : ''}.`);
    else if (f.transfer_fee_modifiable) add('medium', 'tfee', 'Transfer fee can be switched on', 'Fee is 0% now, but a fee authority exists and can raise it.');
    if (f.custom_program) add('high', 'custom_program', 'Not a standard token program', `Mint is owned by program ${String(r.program).slice(0, 6)}…${f.custom_program_upgradeable ? ' (upgradeable)' : ''}, not SPL Token / Token-2022.`);
    if (f.metadata_mutable) add('low', 'mutable', 'Metadata can be changed', 'The update authority can change name, symbol and image (used for impersonation / bait-and-switch).');
    if (f.rugcheck_rugged) add('critical', 'rugged', 'RugCheck marks it as rugged', 'RugCheck has flagged this token as rugged.');
    if (f.scaled_ui_amount) add('medium', 'scaled', 'Displayed balance can be rescaled', 'Interest-bearing / scaled-UI extension: an authority can change how balances display.');
    if (f.sim_sell_ok === false) add('high', 'sim_sell', 'Simulated sell failed', 'A real holder\'s sell built by Jupiter failed in RPC simulation.');
  }
  if (templates && r.skeleton && templates.skeletons?.[r.skeleton] && templates.skeletons[r.skeleton].honeypots > 0 && !templates.skeletons[r.skeleton].self?.includes?.(r.address.toLowerCase())) add('high', 'template', 'Same bytecode as known honeypots', `This contract's bytecode skeleton matches ${templates.skeletons[r.skeleton].honeypots} token(s) in our scan that were confirmed honeypots.`);
  else if (templates && r.selectors?.length && templates.nearest?.[r.address.toLowerCase()]?.jaccard >= 0.9) add('medium', 'template', 'Near-identical to a known honeypot', `Function list is ${Math.round(templates.nearest[r.address.toLowerCase()].jaccard * 100)}% identical to honeypot ${templates.nearest[r.address.toLowerCase()].to}.`);
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}
function riskScore(flags) { const w = { critical: 40, high: 18, medium: 7, low: 2 }; return Math.min(100, flags.reduce((s, x) => s + w[x.sev], 0)); }

// ---------------- composite factor (for lib/composite.js / scanner.js) ----------------
let RES = null, RES_T = 0;
function loadResults() { const p = path.join(DATA_DIR, 'contractscan.json'); try { const st = fs.statSync(p); if (!RES || st.mtimeMs !== RES_T) { RES = JSON.parse(fs.readFileSync(p, 'utf8')); RES_T = st.mtimeMs; } } catch {} return RES; }
function lookup(chain, address) { const d = loadResults(); if (!d) return null; const k = `${chain}:${chain === 'solana' ? address : String(address).toLowerCase()}`; return d.tokens?.[k] || null; }
function lookupSym(sym) { const d = loadResults(); if (!d) return null; const s = String(sym || '').toUpperCase(); const hits = Object.values(d.tokens || {}).filter((t) => (t.symbol || '').toUpperCase() === s && t.scannable); return hits.length === 1 ? hits[0] : null; }
function lookupCg(cgId) { if (!cgId) return null; const d = loadResults(); if (!d) return null; return Object.values(d.tokens || {}).find((t) => t.cg_id === cgId && t.scannable) || null; }
function compositeFactor(t) {
  if (!t || !t.scannable) return null;
  const fl = t.flags || []; const rs = t.riskScore ?? riskScore(fl);
  const crit = fl.filter((x) => x.sev === 'critical'), high = fl.filter((x) => x.sev === 'high');
  const score = Math.max(0, Math.min(100, 62 - rs * 0.6));
  const ageH = t.scannedAt ? Math.round((Date.now() - t.scannedAt) / 3600e3) : null;
  return { score, value: fl.length ? `${crit.length} critical, ${high.length} high` : 'no contract red flags',
    text: (fl.length ? `Contract scan: ${fl.slice(0, 3).map((x) => `${x.title} — ${x.plain}`).join(' · ')}${fl.length > 3 ? ` (+${fl.length - 3} more)` : ''}` : 'Contract scan found no honeypot, mint, freeze, proxy or owner-switch red flags.') + ` (scanned ${ageH != null ? ageH + 'h ago' : 'recently'}; current on-chain state, not at-launch.)`,
    cap: crit.length ? 'F' : high.length >= 2 ? 'D' : high.length ? 'C' : null };
}

// ---------------- HTTP routes (additive) ----------------
function routes() {
  return {
    async '/api/contractscan'(q) {
      const chain = q.get('chain'), address = (q.get('address') || '').trim();
      if (chain && address) {
        const cachedR = lookup(chain, address);
        if (cachedR && q.get('fresh') !== '1') return cachedR;
        const r = await scanToken(chain, address, { simulate: chain === 'solana', history: q.get('history') === '1' });
        const tpl = readJSON('contractscan_templates.json'); r.flags = riskFlags(r, tpl); r.riskScore = riskScore(r.flags); return r;
      }
      const d = loadResults() || {};
      return { generatedAt: d.generatedAt || null, count: Object.keys(d.tokens || {}).length, coverage: readJSON('contractscan_coverage.json'), correlation: readJSON('contractscan_corr.json'), watchlist: d.watchlist || [], paid: PAID };
    },
  };
}
function readJSON(f) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; } }

// ---------------- batch over data/contractscan_universe.json ----------------
const OUT = () => path.join(DATA_DIR, 'contractscan.json');
const jsonSafe = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));
function slim(r) { if (r.evidence?.simulation?.runs) for (const x of r.evidence.simulation.runs) { delete x.sent; delete x.recv; } return r; }
async function batch(args) {
  const U = readJSON('contractscan_universe.json'); if (!U) throw new Error('run research/contractscan.py universe first');
  const limit = +(args.find((a) => /^--limit=/.test(a)) || '').split('=')[1] || Infinity;
  const only = (args.find((a) => /^--chain=/.test(a)) || '').split('=')[1] || null;
  const force = args.includes('--force');
  const prev = readJSON('contractscan.json') || {}; const T = prev.tokens || {};
  const tpl = readJSON('contractscan_templates.json');
  const rescanEvm = args.includes('--rescan-evm');
  const stale = (r) => !r || (!r.scannable && /RPC unavailable|error/i.test(r.reason || '')) || /^error|too many/i.test(r.sources?.goplus || '') || /^error/i.test(r.sources?.rugcheck || '');
  const todo = U.tokens.filter((t) => (!only || t.chain === only) && (force || stale(T[t.key]) || (rescanEvm && CHAINS[t.chain]?.kind === 'evm')));
  // watchlist first, then live tokens
  todo.sort((a, b) => (b.groups.includes('watchlist') - a.groups.includes('watchlist')));
  const meta = (t) => ({ key: t.key, groups: t.groups, cg_id: t.cg_id || null, peak_date: t.peak_date || null, crash_depth_pct: t.crash_depth_pct ?? null, run_multiple: t.run_multiple ?? null, db_snapshot: t.db_snapshot || null });
  let done = 0, saving = false; const t0 = Date.now();
  const save = () => { if (saving) return; saving = true; try { const wl = U.tokens.filter((t) => t.groups.includes('watchlist')).map((t) => t.key); fs.writeFileSync(OUT() + '.tmp', JSON.stringify(jsonSafe({ generatedAt: Date.now(), count: Object.keys(T).length, watchlist: wl, billing: { ...BILL, nansen_calls: 0, x_calls: 0 }, paid: PAID, tokens: T }))); fs.renameSync(OUT() + '.tmp', OUT()); } finally { saving = false; } };
  const one = async (t) => {
    const isWL = t.groups.includes('watchlist');
    let r;
    try { r = await scanToken(t.chain, t.address, { simulate: t.chain === 'solana', history: true, historyPages: 2, noGoplus: t.chain === 'solana' && !isWL }); }
    catch (e) { r = { chain: t.chain, address: t.address, scannable: false, reason: 'error: ' + String(e.message).slice(0, 160) }; }
    if (r.scannable && t.chain === 'solana' && !isWL && (r.market?.liqUsd || 0) < 5000 && r.evidence?.sellSim) delete r.evidence.sellSim;
    r = slim(jsonSafe(r)); r.flags = riskFlags(r, tpl); r.riskScore = riskScore(r.flags); Object.assign(r, meta(t));
    T[t.key] = r; done++;
    if (done % 10 === 0) { save(); console.log(`[contractscan] ${done}/${Math.min(limit, todo.length)} ${((Date.now() - t0) / 60e3).toFixed(1)}min last=${t.key} ${r.symbol || ''} ${r.scannable ? 'risk ' + r.riskScore : r.reason}`); }
  };
  const lanes = { solana: [], evm: [], other: [] };
  for (const t of todo.slice(0, limit)) (t.chain === 'solana' ? lanes.solana : CHAINS[t.chain]?.kind === 'evm' ? lanes.evm : lanes.other).push(t);
  for (const t of lanes.other) await one(t);
  const worker = async (q) => { while (q.length) await one(q.shift()); };
  await Promise.all([worker(lanes.solana), worker(lanes.evm), worker(lanes.evm)]);
  save(); console.log('[contractscan] batch done', done, 'tokens in', ((Date.now() - t0) / 60e3).toFixed(1), 'min', JSON.stringify(BILL.calls));
}
function reflag() { const d = readJSON('contractscan.json'); const tpl = readJSON('contractscan_templates.json'); for (const r of Object.values(d.tokens || {})) { r.flags = riskFlags(r, tpl); r.riskScore = riskScore(r.flags); } fs.writeFileSync(OUT(), JSON.stringify(d)); console.log('reflagged', Object.keys(d.tokens || {}).length); }

module.exports = { scanToken, riskFlags, riskScore, compositeFactor, lookup, lookupSym, lookupCg, routes, analyzeCode, keccak256, PAID, BILL, evmOwnershipHistory, solLaunchState };

// ---------------- CLI batch runner ----------------
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'one') { scanToken(process.argv[3], process.argv[4], { simulate: true, history: process.argv.includes('--history') }).then((r) => { r.flags = riskFlags(r); r.riskScore = riskScore(r.flags); console.log(JSON.stringify(r, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1)); }).catch((e) => { console.error(e); process.exit(1); }); }
  else if (cmd === 'batch') batch(process.argv.slice(3)).catch((e) => { console.error(e); process.exit(1); });
  else if (cmd === 'reflag') reflag();
}
