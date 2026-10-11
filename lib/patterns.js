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
  return { utcHour: hr, inFlaggedWindow: inWindow, windows: { asia_00_08: [...asia], thin8_by_volume: [...thin], top_onset_hours: [...top] }, rule: '1h price <= -15% and 1h sells >= 1.2x buys (DexScreener txns); "inWindow" when the current UTC hour is in Asia 00-08, the 8 thinnest-volume hours, or the 5 most common backtested onset hours', items: items.filter((x) => x.inWindow).slice(0, 40), outsideWindow: items.filter((x) => !x.inWindow).length };
}

function all(DATA_DIR, feed) {
  const H = load(DATA_DIR, 'patterns_hours.json'), W = load(DATA_DIR, 'patterns_wallets.json'), WL = load(DATA_DIR, 'patterns_wallets_live.json');
  const F = load(DATA_DIR, 'patterns_flows.json'), FL = load(DATA_DIR, 'patterns_flows_live.json'), S = load(DATA_DIR, 'patterns_stocks.json');
  const cexEv = [];
  for (const t of F?.tokens || []) for (const e of t.events || []) if (e.type === 'cex') cexEv.push({ symbol: t.symbol, cohort: t.cohort, wallet: e.wallet, role: e.role, cex: e.cex, asset: e.asset, usd: e.usd, sol: e.sol, t: e.t, hop: e.hop || 1, hVsPeak: t.peak_t ? Math.round((e.t - t.peak_t) / 360) / 10 : null, leadHBeforeBreak: t.crash_break_t ? Math.round((t.crash_break_t - e.t) / 360) / 10 : null, min72: e['min_ret_72h_pct'] ?? null });
  return {
    generatedAt: Date.now(),
    hours: H ? { ...strip(H, 'events', 'errors'), live: hourFlags(DATA_DIR, feed) } : { ok: false, live: hourFlags(DATA_DIR, feed) },
    freshWallets: W ? { ...strip(W, 'tokens'), tokens: (W.tokens || []).map((t) => strip(t, 'cluster_wallets')), live: WL ? WL.items : [] } : { ok: false },
    cexFlows: F ? { sample: F.sample, labels: F.labels, cex: F.cex, exit_event: F.exit_event, events: cexEv.sort((a, b) => b.t - a.t).slice(0, 80), exits: (F.tokens || []).filter((t) => t.exit_event).map((t) => ({ symbol: t.symbol, cohort: t.cohort, ...t.exit_event })), live: FL ? FL.items.map((x) => strip(x, 'events')) : [] } : { ok: false },
    stocks: S ? { summary: S.summary, rule: S.rule, tokens: (S.tokens || []).map((t) => strip(t, 'neg_div_flags')) } : { ok: false },
    bridges: bridges.summary(DATA_DIR),
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
