// Heavy Accumulation scorer (lib/accumulation.js -> data/accumulation.json, /api/accumulation).
// Reads ONLY data already collected by other desks: zero new upstream/paid calls (Nansen credits are never spent here).
// Signals (each scored 0-30, capped): Nansen smart-money netflow (data/nansen_cache.json smart-money/netflow), Nansen flow-intelligence
// per-token whale/smart/exchange flows (cached tgm/flow-intelligence), perp OI build with flat price (data/perps_history.json),
// exchange net outflows (CEX -> wallet, data/riskinfra_otcflow.json), VC/fund/MM wallet buys (data/vcwatch_live.json),
// copy-trade wallet buys (data/copytrade_events.json), holder-count growth (data/holder_snaps.json).
// 'heavy' requires >= 3 independent confirming signal families AND score >= 60; 'accumulating' = 2 families.
// Each run appends a compact snapshot to data/accumulation_history.jsonl for forward validation (lib computes hit rates once prices exist).
'use strict';
const fs = require('fs');
const path = require('path');

const STABLE = /^(USDC|USDT|DAI|USDE|FDUSD|PYUSD|USDS|TUSD|BUSD|USD1|RLUSD|EURC|WETH|WBTC|WSOL|SOL|ETH|STETH|CBBTC)$/i;
const STABLE_ADDR = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'So11111111111111111111111111111111111111112', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']);
const CH = { ethereum: 'ethereum', base: 'base', bnb: 'bsc', bsc: 'bsc', solana: 'solana', arbitrum: 'arbitrum', polygon: 'polygon', avalanche: 'avalanche', optimism: 'optimism' };
const fmtUsd = (n) => { const a = Math.abs(n); const s = a >= 1e9 ? (a / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(0) + 'K' : a.toFixed(0); return (n < 0 ? '-$' : '$') + s; };

function createAccumulation({ DATA_DIR, log = () => {} }) {
  const F = (f) => path.join(DATA_DIR, f);
  const readJ = (f) => { try { return JSON.parse(fs.readFileSync(F(f), 'utf8')); } catch { return null; } };
  const mtime = (f) => { try { return fs.statSync(F(f)).mtimeMs; } catch { return null; } };

  function compute() {
    const now = Date.now();
    const toks = new Map(); // key -> {key, chain, address, symbol, signals: {family: {pts, why, src, at}}}
    const symIdx = new Map();
    const get = (chain, address, symbol) => {
      const c = CH[chain] || chain || null;
      const key = address && c ? `${c}:${c === 'solana' ? address : String(address).toLowerCase()}` : `sym:${String(symbol || '').toUpperCase()}`;
      let t = toks.get(key);
      if (!t && symbol && !address) t = symIdx.get(String(symbol).toUpperCase());
      if (!t) { t = { key, chain: c, address: address || null, symbol: symbol || null, signals: {} }; toks.set(key, t); }
      if (symbol && !t.symbol) t.symbol = symbol;
      if (t.symbol) { const s = String(t.symbol).toUpperCase(); if (!symIdx.has(s) || t.address) symIdx.set(s, t); }
      return t;
    };
    const add = (t, fam, ...rest) => { if (t.address && STABLE_ADDR.has(t.address) || STABLE.test(t.symbol || '')) return; add0(t, fam, ...rest); };
    const add0 = (t, fam, pts, why, src, at) => { const prev = t.signals[fam]; if (!prev || prev.pts < pts) t.signals[fam] = { pts: Math.round(Math.min(30, pts)), why, src, at }; };
    const status = {};

    // 1) Nansen smart-money netflow (cached; refreshed hourly by nansenHousekeeping in server.js)
    const nc = readJ('nansen_cache.json') || {};
    const nfKey = Object.keys(nc).find((k) => k.startsWith('smart-money/netflow'));
    if (nfKey) {
      const at = nc[nfKey].t; let n = 0;
      for (const r of nc[nfKey].v?.data || []) {
        if (STABLE.test(r.token_symbol || '')) continue;
        const d24 = r.net_flow_24h_usd || 0, d7 = r.net_flow_7d_usd || 0, mc = r.market_cap_usd || 0;
        if (d24 < 25e3 || d7 < -d24) continue;
        const rel = mc ? d24 / mc : 0; // flow relative to size
        const pts = 8 + Math.min(12, Math.log10(d24 / 25e3 + 1) * 10) + Math.min(10, rel * 2e4);
        add(get(r.chain, r.token_address, r.token_symbol), 'smartmoney', pts, `Nansen smart money net bought ${fmtUsd(d24)} in 24h (${fmtUsd(d7)} over 7d, ${r.trader_count || '?'} wallets)`, 'Nansen smart-money/netflow (cached)', at); n++;
      }
      status.smartmoney = { live: true, at, rows: n };
    } else status.smartmoney = { live: false, why: 'no cached smart-money/netflow (NANSEN_API_KEY unset or not yet fetched)' };

    // 2) Nansen flow-intelligence per token (cached from earlier on-demand/alert lookups): whale + exchange flows
    let fiN = 0, fiAt = 0;
    for (const [k, v] of Object.entries(nc)) {
      if (!k.startsWith('tgm/flow-intelligence|')) continue;
      let q; try { q = JSON.parse(k.split('|')[1]); } catch { continue; }
      const x = v.v?.data?.[0]; if (!x || now - v.t > 3 * 86400e3) continue;
      fiAt = Math.max(fiAt, v.t);
      const t = get(q.chain, q.token_address, null);
      const whale = x.whale_net_flow_usd || 0, smart = (x.smart_trader_net_flow_usd || 0) + (x.top_pnl_net_flow_usd || 0), ex = x.exchange_net_flow_usd || 0;
      if (whale > 10e3) { add(t, 'whales', 8 + Math.log10(whale / 10e3 + 1) * 10, `Whale wallets net bought ${fmtUsd(whale)} (${x.whale_wallet_count} wallets, 1d)`, 'Nansen tgm/flow-intelligence (cached)', v.t); fiN++; }
      if (smart > 10e3) { add(t, 'smartmoney', 6 + Math.log10(smart / 10e3 + 1) * 10, `Smart traders net bought ${fmtUsd(smart)} (1d)`, 'Nansen tgm/flow-intelligence (cached)', v.t); fiN++; }
      if (ex < -10e3) { add(t, 'exchange_outflow', 6 + Math.log10(-ex / 10e3 + 1) * 10, `${fmtUsd(-ex)} net left exchanges (1d)`, 'Nansen tgm/flow-intelligence (cached)', v.t); fiN++; }
    }
    status.flow_intelligence = { live: fiAt > 0, at: fiAt || null, signals: fiN, note: 'only tokens already looked up by other desks; no new calls' };

    // 3) Perp OI build with flat price (perps_history: SYM -> [[t, fAnn, oiUsd, mark]])
    const ph = readJ('perps_history.json') || {}; let oiN = 0, phAt = 0;
    for (const [sym, h] of Object.entries(ph)) {
      if (!Array.isArray(h) || h.length < 4) continue;
      const last = h[h.length - 1]; phAt = Math.max(phAt, last[0]);
      if (now - last[0] > 6 * 3600e3) continue;
      const base = h.find((r) => r[0] >= last[0] - 26 * 3600e3) || h[0];
      if (last[0] - base[0] < 12 * 3600e3 || !base[2] || !base[3]) continue;
      const oiCh = (last[2] / base[2] - 1) * 100, pxCh = (last[3] / base[3] - 1) * 100;
      const marks = h.filter((r) => r[0] >= base[0]).map((r) => r[3]); const range = (Math.max(...marks) / Math.min(...marks) - 1) * 100;
      if (oiCh >= 5 && Math.abs(pxCh) <= 3 && range <= 8 && last[1] < 30) {
        const hrs = Math.round((last[0] - base[0]) / 3600e3);
        add(get(null, null, sym), 'oi_flat', 8 + Math.min(22, oiCh / 2), `Open interest up ${oiCh.toFixed(0)}% in ${hrs}h while price moved ${pxCh >= 0 ? '+' : ''}${pxCh.toFixed(1)}% (range ${range.toFixed(1)}%), funding not overheated`, 'perps_history.json (Binance/OKX/Hyperliquid)', last[0]); oiN++;
      }
    }
    status.oi_flat_price = { live: phAt > now - 6 * 3600e3, at: phAt || null, signals: oiN };

    // 4) Exchange net outflows: CEX -> wallet withdrawals minus wallet -> CEX deposits (riskinfra otcflow, last 48h)
    const of = readJ('riskinfra_otcflow.json'); const exNet = new Map();
    for (const e of of?.events || []) {
      if (!e.t || now - e.t > 48 * 3600e3 || STABLE.test(e.sym || '') || !e.usd) continue;
      const k = (e.chain || 'ethereum') + ':' + e.token; const r = exNet.get(k) || { chain: e.chain || 'ethereum', token: e.token, sym: e.sym, out: 0, inn: 0, at: 0 };
      if (e.fromKind === 'cex' && e.toKind !== 'cex') r.out += e.usd; else if (e.toKind === 'cex' && e.fromKind !== 'cex') r.inn += e.usd;
      r.at = Math.max(r.at, e.t); exNet.set(k, r);
    }
    let exN = 0;
    for (const r of exNet.values()) { const net = r.out - r.inn; if (net >= 50e3) { add(get(r.chain, r.token, r.sym), 'exchange_outflow', 6 + Math.log10(net / 50e3 + 1) * 12, `${fmtUsd(net)} net withdrawn from exchanges to wallets (48h)`, 'riskinfra_otcflow.json (labelled CEX wallets)', r.at); exN++; } }
    status.exchange_outflows = { live: !!of, at: of?.generatedAt || null, signals: exN, note: 'Ethereum tracked tokens + Solana CEX hot wallets only' };

    // 5) VC / fund / market-maker wallet buys (vcwatch, last 7d)
    const vc = readJ('vcwatch_live.json'); let vcN = 0;
    for (const f of vc?.flags || []) {
      if (STABLE.test(f.symbol || '') || !(f.usd_now >= 10e3)) continue;
      const at = (f.last_t || 0) * 1000 || vc.generatedAt;
      const conf = f.confidence === 'high' ? 6 : 0;
      add(get(f.chain, f.token, f.symbol), 'vc_wallets', 8 + conf + Math.log10(f.usd_now / 10e3 + 1) * 8, `${(f.entities || []).slice(0, 2).join(' & ') || 'Fund wallets'} (${(f.entity_types || []).join('/') || 'fund'}) added ${fmtUsd(f.usd_now)}: ${f.source}`, 'vcwatch_live.json', at); vcN++;
    }
    status.vc_wallets = { live: !!vc, at: vc?.generatedAt || null, signals: vcN };

    // 6) Copy-trade wallets (ranked Solana traders): >= 2 distinct wallets net buying the same mint in 48h
    const ct = readJ('copytrade_events.json'); const byMint = new Map();
    for (const e of ct?.events || []) {
      if (now - e.t > 48 * 3600e3) continue;
      const r = byMint.get(e.mint) || { sym: e.symbol, buyers: new Set(), buy: 0, sell: 0, at: 0 };
      if (e.side === 'buy') { r.buyers.add(e.wallet); r.buy += e.usd || 0; } else r.sell += e.usd || 0;
      r.at = Math.max(r.at, e.t); byMint.set(e.mint, r);
    }
    let ctN = 0;
    for (const [mint, r] of byMint) if (r.buyers.size >= 2 && r.buy > r.sell * 1.5) { add(get('solana', mint, r.sym), 'copytrade', 6 + r.buyers.size * 4, `${r.buyers.size} tracked top traders bought (${fmtUsd(r.buy)} in, ${fmtUsd(r.sell)} out, 48h)`, 'copytrade_events.json', r.at); ctN++; }
    status.copytrade = { live: !!ct, at: mtime('copytrade_events.json'), signals: ctN };

    // 7) Holder-count growth (holder_snaps: id -> [[holders, t], ...]); sparse today
    const hs = readJ('holder_snaps.json') || {}; let hN = 0, hMax = 0;
    for (const [id, arr] of Object.entries(hs)) {
      if (!Array.isArray(arr) || arr.length < 2) continue;
      const a = arr[0], b = arr[arr.length - 1]; hMax = Math.max(hMax, b[1] * 1000);
      if (a[0] > 0 && (b[0] / a[0] - 1) >= 0.05) { add(get(null, null, id), 'holders', 6 + Math.min(20, (b[0] / a[0] - 1) * 100), `Holder count +${((b[0] / a[0] - 1) * 100).toFixed(0)}%`, 'holder_snaps.json', b[1] * 1000); hN++; }
    }
    status.holder_growth = { live: hN > 0, at: hMax || mtime('holder_snaps.json'), signals: hN, note: 'only one snapshot per token so far: growth needs a second snapshot' };
    status.cvd_volume_tight_range = { live: false, why: 'no spot CVD / taker-side volume series is collected (orderbook L2 tracks depth/walls, not trade flow)' };

    // score
    const items = [];
    for (const t of toks.values()) {
      const fams = Object.entries(t.signals); if (!fams.length) continue;
      const sum = fams.reduce((s, [, v]) => s + v.pts, 0);
      const score = Math.min(100, Math.round(sum * (1 + 0.15 * (fams.length - 1))));
      const tier = fams.length >= 3 && score >= 60 ? 'heavy' : fams.length >= 2 ? 'accumulating' : 'single';
      const sorted = fams.sort((a, b) => b[1].pts - a[1].pts);
      const oldest = Math.min(...sorted.map(([, v]) => v.at || now));
      items.push({ key: t.key, chain: t.chain, address: t.address, symbol: t.symbol, score, tier, families: sorted.length,
        reasons: sorted.slice(0, 3).map(([, v]) => v.why), signals: Object.fromEntries(sorted),
        oldestSignalAt: oldest, planUrl: t.address && t.chain ? `/?scan=${t.chain}:${t.address}` : null, perpsUrl: !t.address ? '/?view=command' : null });
    }
    items.sort((a, b) => (b.families - a.families) || (b.score - a.score));
    const out = { generatedAt: now, rule: "heavy = >= 3 independent signal families AND score >= 60; accumulating = 2 families; single-signal tokens listed separately", creditsSpent: 0,
      status, counts: { heavy: items.filter((x) => x.tier === 'heavy').length, accumulating: items.filter((x) => x.tier === 'accumulating').length, single: items.filter((x) => x.tier === 'single').length },
      heavy: items.filter((x) => x.tier === 'heavy').slice(0, 30), accumulating: items.filter((x) => x.tier === 'accumulating').slice(0, 40), single: items.filter((x) => x.tier === 'single').slice(0, 60) };
    return out;
  }

  function refresh() {
    try {
      const out = compute();
      fs.writeFileSync(F('accumulation.json.tmp'), JSON.stringify(out)); fs.renameSync(F('accumulation.json.tmp'), F('accumulation.json'));
      const snap = { t: out.generatedAt, items: [...out.heavy, ...out.accumulating].map((x) => ({ k: x.key, s: x.symbol, sc: x.score, tier: x.tier, fam: Object.keys(x.signals) })) };
      fs.appendFileSync(F('accumulation_history.jsonl'), JSON.stringify(snap) + '\n');
      log(`accumulation: ${out.counts.heavy} heavy, ${out.counts.accumulating} accumulating`);
      return out;
    } catch (e) { log('accumulation failed: ' + e.message); return null; }
  }
  let timer = null;
  return {
    compute, refresh,
    start(ms = 10 * 60e3) { if (timer) return; setTimeout(refresh, 30e3).unref(); timer = setInterval(refresh, ms); timer.unref(); },
    api() { const d = readJ('accumulation.json'); if (d) { d.ageSec = Math.round((Date.now() - d.generatedAt) / 1000); return d; } throw Object.assign(new Error('accumulation.json not generated yet'), { status: 404 }); },
  };
}
module.exports = { createAccumulation };
