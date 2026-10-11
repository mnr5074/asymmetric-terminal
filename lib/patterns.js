'use strict';
// Pattern detectors 1-5 (see research/patterns_*.py). Serves precomputed backtests + live flags; detector-1 live flags are computed
// on request from the live feed (current UTC hour vs the backtested crash-onset windows). Free data only, no Nansen / X.
const fs = require('fs');
const path = require('path');
const bridges = require('./bridges');
function load(DATA_DIR, f) { try { const st = fs.statSync(path.join(DATA_DIR, f)); return { ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')), ageSec: Math.round((Date.now() - st.mtimeMs) / 1000) }; } catch { return null; } }
const strip = (o, ...ks) => { if (!o) return o; const c = { ...o }; for (const k of ks) delete c[k]; return c; };

function hourFlags(DATA_DIR, feed) {
  const h = load(DATA_DIR, 'patterns_hours.json');
  const o = h?.onset_all || {};
  const thin = new Set(o.thinnest8_hours_by_volume || []);
  const top = new Set(o.top_hours || []);
  const asia = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
  const hr = new Date().getUTCHours();
  const inWindow = asia.has(hr) || thin.has(hr) || top.has(hr);
  const items = (feed?.items || []).filter((x) => x.features && x.ch1 != null).map((x) => {
    const f = x.features; const sells = f.s1 || 0, buys = f.b1 || 0;
    const sellSkew = buys ? sells / buys : null;
    const hit = x.ch1 <= -15 && sellSkew != null && sellSkew >= 1.2;
    return hit ? { key: x.key, symbol: x.symbol, chain: x.chain, ch1: x.ch1, ch24: x.ch24, sellSkew: Math.round(sellSkew * 100) / 100, vol1h: x.vol1h, mcap: x.mcap, inWindow, why: `${x.ch1}% 1h with ${sells}/${buys} sells/buys` + (inWindow ? ` during flagged UTC hour ${hr}` : '') } : null;
  }).filter(Boolean).sort((a, b) => a.ch1 - b.ch1);
  return { utcHour: hr, inFlaggedWindow: inWindow, windows: { asia_00_08: [...asia], thin8_by_volume: [...thin], top_onset_hours: [...top] }, rule: '1h price <= -15% and 1h sells >= 1.2x buys (DexScreener txns); "inWindow" when the current UTC hour is in Asia 00-08, the 8 thinnest-volume hours, or the 5 most common backtested onset hours', items: items.filter((x) => x.inWindow).slice(0, 40), outsideWindow: items.filter((x) => !x.inWindow).length, outsideItems: items.filter((x) => !x.inWindow).slice(0, 15) };
}

function all(DATA_DIR, feed) {
  const H = load(DATA_DIR, 'patterns_hours.json'), W = load(DATA_DIR, 'patterns_wallets.json'), WL = load(DATA_DIR, 'patterns_wallets_live.json');
  const F = load(DATA_DIR, 'patterns_flows.json'), FL = load(DATA_DIR, 'patterns_flows_live.json'), S = load(DATA_DIR, 'patterns_stocks.json');
  const A = load(DATA_DIR, 'patterns_aging.json'), AL = load(DATA_DIR, 'patterns_aging_live.json');
  const X = load(DATA_DIR, 'patterns_extra.json'), XL = load(DATA_DIR, 'patterns_extra_live.json'), NX = load(DATA_DIR, 'patterns_nansen.json');
  const cexEv = [];
  for (const t of F?.tokens || []) for (const e of t.events || []) if (e.type === 'cex') cexEv.push({ symbol: t.symbol, cohort: t.cohort, wallet: e.wallet, role: e.role, cex: e.cex, asset: e.asset, usd: e.usd, sol: e.sol, t: e.t, hop: e.hop || 1, hVsPeak: t.peak_t ? Math.round((e.t - t.peak_t) / 360) / 10 : null, leadHBeforeBreak: t.crash_break_t ? Math.round((t.crash_break_t - e.t) / 360) / 10 : null, min72: e['min_ret_72h_pct'] ?? null });
  return {
    generatedAt: Date.now(),
    hours: H ? { ...strip(H, 'events', 'errors'), live: hourFlags(DATA_DIR, feed) } : { ok: false, live: hourFlags(DATA_DIR, feed) },
    freshWallets: W ? { ...strip(W, 'tokens'), tokens: (W.tokens || []).map((t) => strip(t, 'cluster_wallets')), live: WL ? WL.items : [] } : { ok: false },
    cexFlows: F ? { sample: F.sample, labels: F.labels, cex: F.cex, exit_event: F.exit_event, events: cexEv.sort((a, b) => b.t - a.t).slice(0, 80), exits: (F.tokens || []).filter((t) => t.exit_event).map((t) => ({ symbol: t.symbol, cohort: t.cohort, ...t.exit_event })), live: FL ? FL.items.map((x) => strip(x, 'events')) : [] } : { ok: false },
    stocks: S ? { summary: S.summary, rule: S.rule, tokens: (S.tokens || []).map((t) => strip(t, 'neg_div_flags')) } : { ok: false },
    bridges: bridges.summary(DATA_DIR),
    aging: A ? { ...strip(A, 'tokens'), tokens: (A.tokens || []).map((t) => ({ symbol: t.symbol, cohort: t.cohort, token_age_at_peak_d: t.token_age_at_peak_d, waves_p7: t.waves_p7, waves_p1: t.waves_p1, aging_cluster: t.aging_cluster, awakenings: t.awakenings })), live: AL ? AL.items : [] } : { ok: false },
    nansenCex: NX ? { ...strip(NX, 'tokens'), tokens: (NX.tokens || []).filter((t) => (t.dev_cex || []).length).map((t) => ({ symbol: t.symbol, cohort: t.cohort, dev_cex: (t.dev_cex || []).slice(0, 5) })) } : { ok: false },
    // detectors 7-9 (research/patterns_extra.py)
    liquidityPull: X ? { ...X.liquidity_pull, live: (XL?.items || []).map((x) => ({ symbol: x.symbol, key: x.key, dex: x.dex, liq_usd: x.liq_usd, lp_mint: x.lp_mint, withdrawals: x.lp_withdrawals_72h || [], flag: (x.flags || []).includes('liquidity-pull') })) } : { ok: false },
    holderConcentration: X ? { ...X.concentration, age_matched: X.concentration_age_matched, tokens: (X.tokens || []).map((t) => ({ symbol: t.symbol, cohort: t.cohort, ...(t.conc ? { window_h: t.conc.window_h, top1_pct: t.conc.top1_pct, top2_pct: t.conc.top2_pct, flag: t.conc.flag } : {}) })), live: (XL?.items || []).map((x) => ({ symbol: x.symbol, key: x.key, conc: x.conc, flag: (x.flags || []).includes('holder-concentration') })) } : { ok: false },
    bridgeHop: X ? { ...X.bridge_hop, hops: (X.tokens || []).flatMap((t) => (t.bridge_hops || []).map((h) => ({ symbol: t.symbol, cohort: t.cohort, ...strip(h, 'sends') }))), live: (XL?.items || []).filter((x) => (x.bridge_hops || []).length).map((x) => ({ symbol: x.symbol, key: x.key, hops: x.bridge_hops })) } : { ok: false },
    extraMeta: X ? { sample: X.sample, billing: X.billing, generatedAt: X.generatedAt, liveGeneratedAt: XL?.generatedAt, liveNansenCredits: XL?.nansen_credits_used_this_pass } : null,
    // ONE coordinated-exit record per token: CEX/bridge outflows (det. 3/5) + dormant awakenings (det. 6), boosted by thin-hour (det. 1) / fresh-cluster (det. 2) hits
    coordinatedExits: [
      ...(F?.tokens || []).filter((t) => t.exit_event).map((t) => ({ when: 'backtest', symbol: t.symbol, cohort: t.cohort, ...t.exit_event, significant: (t.exit_event.usd_total || 0) >= 1000 })),
      ...(FL?.items || []).filter((x) => x.flag || (x.events || []).length).map((x) => ({ when: 'live', symbol: x.symbol, key: x.key, usd_total: x.out_usd, inbound_bridge_usd: x.inbound_bridge_usd, fresh_cluster_hit: x.fresh_cluster_wallet, significant: !!x.flag })),
      ...(AL?.items || []).filter((x) => (x.awakenings || []).some((a) => (a.merged_exit || []).length)).map((x) => ({ when: 'live', symbol: x.symbol, key: x.key, kinds: ['dormant-awakening+exit'], awakenings: x.awakenings.filter((a) => a.merged_exit.length) })),
    ],
  };
}
function routes({ DATA_DIR, live }) {
  const feed = () => { try { return live ? live.feed() : JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'live_feed.json'), 'utf8')); } catch { return null; } };
  return {
    async '/api/patterns'() { return all(DATA_DIR, feed()); },
    async '/api/patterns/hours'() { return hourFlags(DATA_DIR, feed()); },
    async '/api/bridges'() { return { registry: bridges.registry(DATA_DIR), ...bridges.summary(DATA_DIR) }; },
  };
}
module.exports = { routes, all, hourFlags };
