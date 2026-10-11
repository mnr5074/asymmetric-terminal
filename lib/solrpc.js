'use strict';
// Throttled Solana JSON-RPC client. Public mainnet RPC is heavily rate-limited, so we
// serialize calls with a minimum gap and retry 429s with backoff. A user-supplied RPC
// (e.g. Helius) can be passed per-request via the `x-rpc-url` header (set in Settings).
const { postJSON, sleep } = require('./util');
const PUBLIC = 'https://api.mainnet-beta.solana.com';
const clients = new Map();

class RpcClient {
  constructor(url, gapMs) { this.url = url; this.gap = gapMs; this.last = 0; this.chain = Promise.resolve(); this.label = url === PUBLIC ? 'public mainnet-beta' : 'custom RPC (' + new URL(url).host + ')'; this.isPublic = url === PUBLIC; }
  _slot() {
    const p = this.chain.then(async () => { const w = this.last + this.gap - Date.now(); if (w > 0) await sleep(w); this.last = Date.now(); });
    this.chain = p.catch(() => {});
    return p;
  }
  async call(method, params, { retries = 4 } = {}) {
    let delay = 600;
    for (let i = 0; ; i++) {
      await this._slot();
      let j;
      try { j = await postJSON(this.url, { jsonrpc: '2.0', id: 1, method, params }); }
      catch (e) { if (i < retries && (e.httpStatus === 429 || e.httpStatus >= 500 || e.name === 'TimeoutError')) { await sleep(delay); delay *= 2; continue; } throw e; }
      if (j.error) {
        const rl = j.error.code === 429 || /too many/i.test(j.error.message || '');
        if (rl && i < retries) { await sleep(delay); delay *= 2; continue; }
        throw Object.assign(new Error(`${method}: ${j.error.message}`), { rpcCode: j.error.code, rateLimited: rl });
      }
      return j.result;
    }
  }
}
// Optional server-side default RPC (e.g. a Helius URL with key) used when the visitor supplies none.
const DEFAULT = process.env.SOLANA_RPC_URL || PUBLIC;
function rpcFor(req) {
  let url = DEFAULT;
  const h = req && req.headers['x-rpc-url'];
  if (h) {
    try {
      const u = new URL(h);
      // In PUBLIC_MODE only well-known RPC providers are allowed (prevents SSRF via the x-rpc-url header).
      const allowed = !process.env.PUBLIC_MODE || /(^|\.)(helius-rpc\.com|helius\.xyz|quiknode\.pro|rpcpool\.com|alchemy\.com|ankr\.com|chainstack\.com|syndica\.io|extrnode\.com|shyft\.to|solana\.com)$/i.test(u.hostname);
      if (u.protocol === 'https:' && allowed) url = u.toString();
    } catch {}
  }
  if (!clients.has(url)) clients.set(url, new RpcClient(url, url === PUBLIC ? 260 : 40));
  return clients.get(url);
}
module.exports = { rpcFor, PUBLIC };
