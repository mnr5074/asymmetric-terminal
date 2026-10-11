'use strict';
// Detector 5 (cross-chain bridges): registry of bridge programs/contracts + summary of research/patterns_flows.py output.
// Free data only; no Nansen / X. The registry lives in data/bridges_registry.json (sources + confidence per entry).
const fs = require('fs');
const path = require('path');
function load(DATA_DIR, f) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; } }
function registry(DATA_DIR) {
  const r = load(DATA_DIR, 'bridges_registry.json') || { solana: {}, evm: {} };
  const by = {};
  for (const [chain, m] of [['solana', r.solana || {}], ['evm', r.evm || {}]]) for (const [a, v] of Object.entries(m)) (by[v.bridge] ||= []).push({ chain, address: a, role: v.role, conf: v.conf });
  return { note: r.note, bridges: by, explorers: r.explorers, counts: { solana: Object.keys(r.solana || {}).length, evm: Object.keys(r.evm || {}).length } };
}
const isBridge = (DATA_DIR) => { const r = load(DATA_DIR, 'bridges_registry.json') || {}; const evm = r.evm || {}; return (a) => (r.solana || {})[a] || evm[String(a).toLowerCase()] || null; };
function summary(DATA_DIR) {
  const f = load(DATA_DIR, 'patterns_flows.json'); const l = load(DATA_DIR, 'patterns_flows_live.json');
  const ev = [];
  for (const t of f?.tokens || []) for (const e of t.events || []) if (e.type === 'bridge') ev.push({ symbol: t.symbol, cohort: t.cohort, wallet: e.wallet, role: e.role, bridge: e.bridge, dir: e.dir, usd: e.usd, sol: e.sol, t: e.t, hVsPeak: t.peak_t ? Math.round((e.t - t.peak_t) / 360) / 10 : null, leadHBeforeBreak: t.crash_break_t ? Math.round((t.crash_break_t - e.t) / 360) / 10 : null, dest: e.dest || null, sig: e.sig, hop: e.hop || 1, min72: e['min_ret_72h_pct'] ?? null });
  return { backtest: f ? { generatedAt: f.generatedAt, sample: f.sample, bridge_out: f.bridge_out, bridge_any: f.bridge_any, inbound_bridge_before_peak: f.inbound_bridge_before_peak, exit_event: f.exit_event, partial: f.partial } : null, events: ev.sort((a, b) => b.t - a.t).slice(0, 80),
    live: l ? { generatedAt: l.generatedAt, rule: l.rule, items: (l.items || []).map((x) => ({ symbol: x.symbol, key: x.key, flag: x.flag, out_usd: x.out_usd, inbound_bridge_usd: x.inbound_bridge_usd, bridges: (x.events || []).filter((e) => e.type === 'bridge').map((e) => ({ bridge: e.bridge, dir: e.dir, usd: e.usd, role: e.role, wallet: e.wallet, t: e.t, dest: e.dest })) })) } : null };
}
module.exports = { registry, summary, isBridge };
