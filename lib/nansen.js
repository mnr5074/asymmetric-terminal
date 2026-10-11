// Nansen API (server-side only; key from NANSEN_API_KEY, never sent to the browser or logged).
// Credit budget: hard daily + monthly caps, per-purpose sub-caps, persistent cache. Costs from docs.nansen.ai/getting-started/credits.
'use strict';
const fs = require('fs');
const path = require('path');
const BASE = 'https://api.nansen.ai/api/v1';
const COST = { 'account': 0, 'tgm/flow-intelligence': 1, 'tgm/who-bought-sold': 1, 'profiler/address/first-funder': 1, 'smart-money/netflow': 5, 'tgm/holders': 5 };
const CH = { solana: 'solana', ethereum: 'ethereum', base: 'base', bsc: 'bnb', arbitrum: 'arbitrum', polygon: 'polygon', avalanche: 'avalanche', optimism: 'optimism', sui: 'sui', ton: 'ton', tron: 'tron', robinhood: 'robinhood', sonic: 'sonic', linea: 'linea', mantle: 'mantle' };
const SM_CHAINS = ['solana', 'ethereum', 'base', 'bnb'];

function createNansen({ DATA_DIR, log = () => {} }) {
  const KEY = process.env.NANSEN_API_KEY || '';
  const DAILY = +(process.env.NANSEN_DAILY_CREDITS || 60), MONTHLY = +(process.env.NANSEN_MONTHLY_CREDITS || 1800);
  // per-purpose daily sub-caps (sum <= DAILY)
  const SUB = { netflow: 10, flow_live: 30, flow_sleeper: 6, wbs_alert: 6, holders: 5, funder: 3, ondemand: 5 };
  const bf = path.join(DATA_DIR, 'nansen_budget.json'), cf = path.join(DATA_DIR, 'nansen_cache.json');
  let B = { day: '', month: '', dayUsed: 0, monthUsed: 0, purpose: {}, remaining: null, plan: null, calls: [], errors: 0 };
  let C = {};
  try { B = { ...B, ...JSON.parse(fs.readFileSync(bf, 'utf8')) }; } catch {}
  try { C = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch {}
  const roll = () => { const d = new Date().toISOString(); if (B.day !== d.slice(0, 10)) { B.day = d.slice(0, 10); B.dayUsed = 0; B.purpose = {}; } if (B.month !== d.slice(0, 7)) { B.month = d.slice(0, 7); B.monthUsed = 0; } };
  let dirty = false; const save = () => { if (!dirty) return; dirty = false; try { fs.writeFileSync(bf, JSON.stringify(B)); const now = Date.now(); for (const k of Object.keys(C)) if (now - C[k].t > 180 * 86400e3) delete C[k]; /* long-term store: expired entries stay readable for free (stale) */ fs.writeFileSync(cf, JSON.stringify(C)); } catch {} };
  setInterval(save, 30e3).unref();
  const canSpend = (cost, purpose) => { roll(); return cost === 0 || (B.dayUsed + cost <= DAILY && B.monthUsed + cost <= MONTHLY && (B.purpose[purpose] || 0) + cost <= (SUB[purpose] ?? DAILY) && (B.remaining == null || B.remaining - cost >= 20)); };
  const inflight = new Map();
  async function call(ep, body, { ttl, purpose, method = 'POST' }) {
    if (!KEY) return { skipped: 'NANSEN_API_KEY not set' };
    const ck = ep + '|' + JSON.stringify(body || {});
    const hit = C[ck]; if (hit && hit.exp > Date.now()) return { data: hit.v, cached: true, at: hit.t };
    const cost = COST[ep] ?? 5;
    if (!canSpend(cost, purpose)) return { skipped: 'budget', stale: hit?.v || null };
    if (inflight.has(ck)) return inflight.get(ck);
    const p = (async () => {
      try {
        const r = await fetch(BASE + '/' + ep, { method, headers: { apikey: KEY, 'content-type': 'application/json', accept: 'application/json' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined, signal: AbortSignal.timeout(25000) });
        const used = +(r.headers.get('x-nansen-credits-used') || 0), rem = r.headers.get('x-nansen-credits-remaining');
        roll(); B.dayUsed += used; B.monthUsed += used; B.purpose[purpose] = (B.purpose[purpose] || 0) + used; if (rem != null) B.remaining = +rem;
        B.calls.push({ t: Date.now(), ep, purpose, used, status: r.status }); B.calls = B.calls.slice(-200); dirty = true;
        const j = await r.json().catch(() => null);
        if (!r.ok) { B.errors++; return { error: `HTTP ${r.status}: ${String(j?.detail || j?.message || j?.error || '').slice(0, 120)}` }; }
        C[ck] = { v: j, t: Date.now(), exp: Date.now() + ttl }; dirty = true;
        return { data: j, cached: false, at: Date.now() };
      } catch (e) { return { error: e.message }; } finally { inflight.delete(ck); }
    })();
    inflight.set(ck, p); return p;
  }
  const peekKey = (ep, body) => { const h = C[ep + '|' + JSON.stringify(body || {})]; return h ? { data: h.v, at: h.t } : null; };
  const fiBody = (chain, a, tf) => ({ chain: CH[chain], token_address: a, timeframe: tf });
  function summarizeFlow(d) {
    const x = d?.data?.[0]; if (!x) return null;
    return { smart: (x.smart_trader_net_flow_usd || 0) + (x.top_pnl_net_flow_usd || 0), smartWallets: (x.smart_trader_wallet_count || 0) + (x.top_pnl_wallet_count || 0), whale: x.whale_net_flow_usd || 0, whales: x.whale_wallet_count || 0, exchange: x.exchange_net_flow_usd || 0, fresh: x.fresh_wallets_net_flow_usd || 0, publicFigure: x.public_figure_net_flow_usd || 0 };
  }
  let netMap = new Map(); // chain:address -> netflow row
  function loadNet(d) { netMap = new Map(); for (const r of d?.data || []) { const ch = Object.entries(CH).find(([, v]) => v === r.chain)?.[0] || r.chain; netMap.set(ch + ':' + (ch === 'solana' ? r.token_address : String(r.token_address).toLowerCase()), r); } }
  { const p = peekKey('smart-money/netflow', { chains: SM_CHAINS, pagination: { page: 1, per_page: 500 }, order_by: [{ field: 'net_flow_24h_usd', direction: 'DESC' }] }); if (p) loadNet(p.data); }
  return {
    enabled: !!KEY, CH,
    async account() { const r = await call('account', null, { ttl: 10 * 60e3, purpose: 'account', method: 'GET' }); if (r.data) { B.remaining = r.data.credits_remaining; B.plan = r.data.plan; dirty = true; } return r; },
    async netflow() { const r = await call('smart-money/netflow', { chains: SM_CHAINS, pagination: { page: 1, per_page: 500 }, order_by: [{ field: 'net_flow_24h_usd', direction: 'DESC' }] }, { ttl: 12 * 3600e3, purpose: 'netflow' }); if (r.data) loadNet(r.data); return r; },
    netflowFor: (chain, a) => netMap.get(chain + ':' + (chain === 'solana' ? a : String(a).toLowerCase())) || null,
    netflowTop: (n = 15) => [...netMap.values()].sort((a, b) => (b.net_flow_24h_usd || 0) - (a.net_flow_24h_usd || 0)).slice(0, n),
    async flow(chain, a, tf = '1d', purpose = 'flow_live') { if (!CH[chain]) return { skipped: 'chain not supported' }; const r = await call('tgm/flow-intelligence', fiBody(chain, a, tf), { ttl: (tf === '7d' ? 24 : 6) * 3600e3, purpose }); return { ...r, summary: summarizeFlow(r.data || r.stale) }; },
    peekFlow(chain, a, tf = '1d') { if (!CH[chain]) return null; const p = peekKey('tgm/flow-intelligence', fiBody(chain, a, tf)); return p ? { ...summarizeFlow(p.data), at: p.at } : null; },
    async whoBoughtSold(chain, a, purpose = 'wbs_alert') { if (!CH[chain]) return { skipped: 'chain not supported' }; const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
      return call('tgm/who-bought-sold', { chain: CH[chain], token_address: a, date: { from, to }, pagination: { page: 1, per_page: 25 }, order_by: [{ field: 'bought_volume_usd', direction: 'DESC' }] }, { ttl: 12 * 3600e3, purpose }); },
    async holders(chain, a, label = 'smart_money', purpose = 'holders') { if (!CH[chain]) return { skipped: 'chain not supported' }; return call('tgm/holders', { chain: CH[chain], token_address: a, label_type: label, pagination: { page: 1, per_page: 50 } }, { ttl: 48 * 3600e3, purpose }); },
    async firstFunder(address) { if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { skipped: 'EVM addresses only' }; return call('profiler/address/first-funder', { address, chain: 'all' }, { ttl: 30 * 86400e3, purpose: 'funder' }); },
    lowCredit() {
      roll(); const rem = B.remaining; if (rem == null) return null;
      const now = new Date(); const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate(); const dayN = now.getUTCDate() - 1 + now.getUTCHours() / 24;
      const burn = dayN > 0.5 ? B.monthUsed / dayN : null; const daysLeft = dim - dayN; const projected = burn != null ? burn * daysLeft : null;
      const low = rem < 0.2 * MONTHLY; const early = projected != null && projected > rem && burn > 0;
      if (!low && !early) return null;
      const runOut = burn ? new Date(Date.now() + (rem / burn) * 86400e3).toISOString().slice(0, 10) : null;
      return { month: B.month, remaining: rem, low, early, burnPerDay: burn != null ? +burn.toFixed(1) : null, runOutDate: runOut, resetDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10),
        text: `Nansen credits low: ${rem} left${low ? ` (<20% of ${MONTHLY})` : ''}${early && runOut ? `, burn ${burn.toFixed(0)}/day runs out ~${runOut}` : ''}; reset ${new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(5, 10)}` };
    },
    peekAny(ep, body) { return peekKey(ep, body); },
    status() { roll(); return { enabled: !!KEY, plan: B.plan, creditsRemaining: B.remaining, dailyCap: DAILY, monthlyCap: MONTHLY, usedToday: B.dayUsed, usedThisMonth: B.monthUsed, byPurpose: B.purpose, subCaps: SUB, recent: B.calls.slice(-15).reverse().map(({ t, ep, purpose, used, status }) => ({ t, ep, purpose, used, status })), lowCredit: this.lowCredit(), cached: Object.keys(C).length, netflowTokens: netMap.size, errors: B.errors }; },
  };
}
module.exports = { createNansen };
