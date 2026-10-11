'use strict';
// VC / fund / market-maker wallet watch. Data from research/vcwatch.py (free sources only; no Nansen calls, no paid X):
//   data/vc_wallets.json   label DB (entity, address, chain, source, confidence)
//   data/vcwatch_live.json  live accumulation flags (tokens not yet widely known receiving inflows from labelled wallets)
//   data/vcwatch_history.json  historical scan (pre-listing allocations / pre-run accumulation with tx hashes + lead time)
// Routes: /api/vcwatch, /api/vcwatch/wallets?entity=&type=&chain=, /api/vcwatch/lookup?chain=&address=
// The monitor is refreshed by spawning `python3 research/vcwatch.py monitor` when the live file is older than VCWATCH_MS (default 2h).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cache = {};
function readJ(DATA_DIR, f) { const p = path.join(DATA_DIR, f); try { const st = fs.statSync(p); const c = cache[p]; if (c && c.t === st.mtimeMs) return c.v; const v = JSON.parse(fs.readFileSync(p, 'utf8')); cache[p] = { t: st.mtimeMs, v, age: st.mtimeMs }; return v; } catch { return null; } }
const norm = (chain, a) => `${chain}:${String(a || '').startsWith('0x') ? String(a).toLowerCase() : a}`;
let index = { t: 0, m: null };
function walletIndex(DATA_DIR) { const d = readJ(DATA_DIR, 'vc_wallets.json'); if (!d) return new Map(); if (index.t === d.generatedAt) return index.m; const m = new Map(); for (const w of d.wallets || []) m.set(norm(w.chain, w.address), w); index = { t: d.generatedAt, m }; return m; }
function lookup(DATA_DIR, chain, address) { return walletIndex(DATA_DIR).get(norm(chain, address)) || null; }
// token-level: is a labelled fund/MM accumulating this token right now? (used by other desks; read-only)
function tokenFlag(DATA_DIR, chain, address) { const L = readJ(DATA_DIR, 'vcwatch_live.json'); const k = String(address || '').toLowerCase(); return (L?.flags || []).find((f) => f.chain === chain && String(f.token).toLowerCase() === k) || null; }
function routes({ DATA_DIR, root, log = () => {} }) {
  let running = false;
  const refresh = () => {
    if (running || process.env.VCWATCH === 'off' || process.env.NO_AUTO_REFRESH === '1') return;
    let st = null; try { st = fs.statSync(path.join(DATA_DIR, 'vcwatch_live.json')); } catch {}
    if (st && Date.now() - st.mtimeMs < +(process.env.VCWATCH_MS || 2 * 3600e3)) return;
    running = true; const ch = spawn('python3', ['vcwatch.py', 'monitor'], { cwd: path.join(root, 'research'), env: { ...process.env, DATA_DIR, NANSEN_API_KEY: '', X_BEARER_TOKEN: '' }, stdio: 'ignore' });
    ch.on('exit', () => { running = false; }); ch.on('error', () => { running = false; });
  };
  return {
    async '/api/vcwatch'() {
      refresh();
      const W = readJ(DATA_DIR, 'vc_wallets.json'), L = readJ(DATA_DIR, 'vcwatch_live.json'), H = readJ(DATA_DIR, 'vcwatch_history.json');
      return { generatedAt: Date.now(), refreshing: running,
        labels: W ? { count: W.count, by_entity_type: W.by_entity_type, by_confidence: W.by_confidence, by_chain: W.by_chain, top_entities: W.top_entities, source_rows: W.source_rows, confidence_rules: W.confidence_rules, not_used: W.not_used, caveats: W.caveats, generatedAt: W.generatedAt } : null,
        live: L ? { generatedAt: L.generatedAt, lookback_days: L.lookback_days, criteria: L.criteria, chains: L.chains, flags: L.flags, rejected: L.rejected } : null,
        history: H ? { generatedAt: H.generatedAt, summary: H.summary, pre_listing: H.pre_listing, pre_run: H.pre_run } : null,
        nansen: (() => { const N = readJ(DATA_DIR, 'vcwatch_nansen.json'); return N ? { generatedAt: N.generatedAt, credits: N.credits, fund_held_small_caps: N.funds_holdings, entities_resolved: Object.values(N.entities || {}).filter((v) => Array.isArray(v) && v.length).length,
          note: 'research/vcwatch_nansen.js (manual, cached; credits logged in data/vcwatch_nansen_log.json). The auto-refresh monitor never calls Nansen.' } : null; })(),
        nfa: 'Labels come from public explorer tag sets and existing Nansen exports; an inflow is not proof of a trade or endorsement. Not financial advice.' };
    },
    async '/api/vcwatch/wallets'(q) {
      const W = readJ(DATA_DIR, 'vc_wallets.json'); if (!W) return { count: 0, wallets: [] };
      const e = (q.get('entity') || '').toLowerCase(), t = q.get('type'), c = q.get('chain');
      const ws = (W.wallets || []).filter((w) => (!e || String(w.entity).toLowerCase().includes(e)) && (!t || w.entity_type === t) && (!c || w.chain === c));
      return { count: ws.length, wallets: ws.slice(0, +(q.get('limit') || 500)) };
    },
    async '/api/vcwatch/lookup'(q) { return { wallet: lookup(DATA_DIR, q.get('chain') || 'ethereum', q.get('address')), token_flag: tokenFlag(DATA_DIR, q.get('chain') || 'ethereum', q.get('address')) }; },
  };
}
module.exports = { routes, lookup, tokenFlag };
