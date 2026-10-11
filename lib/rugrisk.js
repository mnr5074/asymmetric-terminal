// Pre-rug / slow-rug early warning: Rug Risk Forecast (0-100) + "dump risk next 30 days" flag, with reasons.
// Works on Live Feed records (new memecoins) and on demand for established tokens. Estimates, not advice.
'use strict';
const fs = require('fs');
const path = require('path');
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function createRugRisk({ DATA_DIR, getJSON, cached, evmCallChain, chains, log = () => {} }) {
  let unlocks = new Map(), unlocksByGecko = new Map();
  function loadUnlocks() {
    try {
      const u = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'unlocks.json'), 'utf8'));
      unlocks = new Map(); unlocksByGecko = new Map();
      for (const t of u.tokens || []) { const [c, a] = (t.token || '').split(':'); if (a) unlocks.set(`${c === 'bsc' ? 'bsc' : c}:${a.toLowerCase()}`, t); if (t.gecko_id) unlocksByGecko.set(t.gecko_id, t); }
    } catch {}
  }
  loadUnlocks(); setInterval(loadUnlocks, 3600e3).unref();
  const wfile = path.join(DATA_DIR, 'insider_watch.json');
  let watch = {}; try { watch = JSON.parse(fs.readFileSync(wfile, 'utf8')); } catch {}
  const dsChainToLlama = (c) => ({ bsc: 'bsc', ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', polygon: 'polygon', avalanche: 'avax', optimism: 'optimism', solana: 'solana' }[c] || c);

  // signals from a Live Feed record (+ optional established-token fundamentals)
  function assess(r, extra = {}) {
    const m = r.m || {}; const sig = []; let s = 0;
    const add = (pts, why, kind) => { s += pts; sig.push({ pts, why, kind }); };
    const checks = r.scan?.checks || []; const ck = (id) => checks.find((c) => c.id === id);
    const mc = m.mc || m.fdv, fdv = m.fdv;
    // float / FDV gap
    const circ = extra.circRatio ?? (mc && fdv && fdv > mc * 1.05 ? mc / fdv : null);
    if (circ != null) { if (circ < 0.3) add(15, `only ${Math.round(circ * 100)}% of supply circulating (FDV ${(1 / circ).toFixed(1)}x mcap)`, 'unlock_dump'); else if (circ < 0.5) add(8, `${Math.round(circ * 100)}% circulating`, 'low_float_squeeze'); }
    // liquidity depth vs mcap (squeeze / exit-liquidity risk)
    if (mc && m.liq) { const d = m.liq / mc; if (d < 0.01) add(15, `DEX liquidity ${(d * 100).toFixed(2)}% of mcap: thin exit, squeeze-prone`, 'low_float_squeeze'); else if (d < 0.03) add(8, `DEX liquidity ${(d * 100).toFixed(1)}% of mcap`, 'low_float_squeeze'); }
    // contracts holding a big share (staking/vesting/locks -> tiny liquid float)
    const top = ck('top10')?.evidence; const hs = top?.holders || [];
    const inContracts = extra.top10InContractsPct ?? hs.filter((h) => h.contract).reduce((a, h) => a + (h.p || 0), 0);
    if (inContracts > 40) add(10, `${Math.round(inContracts)}% of supply sits in contracts (staking/vesting/locks): liquid float is smaller than it looks`, 'staking_float_illusion');
    // unlocks
    const U = extra.unlock || unlocks.get(`${dsChainToLlama(r.chain)}:${(r.address || '').toLowerCase()}`);
    if (U) { const p = U.unlock30d_pct_circ || 0; if (p >= 5) add(20, `unlock of ${p.toFixed(1)}% of circulating supply within 30 days (${U.next?.[0]?.date}, ${U.next?.[0]?.category})`, 'unlock_dump'); else if (p >= 2) add(10, `unlock ${p.toFixed(1)}% of circ within 30 days`, 'unlock_dump'); if ((U.insider30d_pct_circ || 0) >= 2) add(8, `insider/private-sale share of that unlock ${U.insider30d_pct_circ.toFixed(1)}%`, 'unlock_dump'); }
    // holders falling while price rises
    const hh = r.holdersHist || [];
    if (hh.length >= 3 && hh[hh.length - 1].n < hh[0].n * 0.97 && (m.ch?.h6 || m.ch?.h24 || 0) > 10) add(10, `holders down ${hh[0].n - hh[hh.length - 1].n} while price is up`, 'slow_rug');
    // buy pressure from few wallets
    const g = r.gt?.h1; if (g && g.buys >= 20 && g.buyers && g.buys / g.buyers > 5 && g.buyers < 15) add(10, `${g.buys} buys from only ${g.buyers} wallets in 1h`, 'kol_pump_dump');
    // price/volume divergence
    const sn = r.snaps || []; if (sn.length >= 6) { const a = sn[sn.length - 6], b = sn[sn.length - 1]; if (a.px && b.px > a.px * 1.2 && (b.v?.h1 || 0) < (a.v?.h1 || 0) * 0.6) add(8, 'price rising on falling volume', 'low_float_squeeze'); }
    // LP removal trend
    const old = sn.find((x) => Date.now() - x.t < 6 * 3600e3) || sn[0];
    if (old?.liq && m.liq && m.liq < old.liq * 0.7 && (m.px || 0) >= (old.px || 0) * 0.85) add(15, `liquidity down ${Math.round((1 - m.liq / old.liq) * 100)}% while price holds (LP being pulled?)`, 'hard_rug');
    // dev / concentration / bundles / scanner reds
    if (ck('creator')?.level === 'red') add(10, 'creator/dev wallet flagged by scanner', 'slow_rug');
    if (r.dev && r.dev.prior >= 5 && r.dev.graduated === 0) add(10, `serial launcher: ${r.dev.prior} prior launches, none graduated`, 'bundled_dev_dump');
    const t10 = +(((ck('top10')?.detail || '').match(/hold ([\d.]+)%/) || [])[1]); if (t10 > 40) add(10, `top-10 wallets ${t10}%`, 'bundled_dev_dump');
    if (ck('bundle')?.level === 'red') add(20, 'bundled launch detected', 'bundled_dev_dump'); else if (ck('bundle')?.level === 'amber') add(10, 'some bundling', 'bundled_dev_dump');
    if (ck('quoteside')?.level === 'red') add(30, 'fake liquidity: quote side tiny vs reported liquidity', 'fake_liquidity');
    if (ck('wash')?.level === 'red') add(10, 'wash-trading signs', 'wash_volume');
    if (ck('lplock')?.level === 'red') add(10, 'LP not burned/locked', 'hard_rug');
    if (ck('honeypot')?.level === 'red') add(30, 'honeypot signs', 'honeypot');
    if (ck('mint')?.level === 'red' || ck('freeze')?.level === 'red') add(20, 'mint/freeze authority live', 'mint_freeze_abuse');
    // promo spike without organic presence
    const ageH = (Date.now() - (r.pair?.pairCreatedAt || r.firstSeen)) / 3600e3;
    if ((r.boostAmt || 0) >= 100 && ageH < 24 && !(r.pair?.socials || []).length) add(8, `paid boosts (${r.boostAmt}) on a <24h token with no socials`, 'kol_pump_dump');
    if (!(r.pair?.socials || []).length && !(r.pair?.websites || []).length && ageH > 48) add(5, 'no socials or website listed (team silence check not possible without X data)', 'slow_rug');
    // insider outflows (forward monitoring of top holders on EVM)
    const w = watch[r.key]; if (w) { const d1 = w.sells24hPct || 0; if (d1 >= 1) add(15, `top holders sold ${d1.toFixed(2)}% of supply into DEX pairs in 24h`, 'slow_rug'); else if ((w.sells24h || 0) >= 3) add(10, `${w.sells24h} transfers from top-8 holder wallets into the DEX pair in 24h`, 'slow_rug'); if (w.monthlyPattern) add(15, `recurring monthly outflows from ${w.monthlyPattern} insider wallet(s)`, 'slow_rug'); }
    // Nansen flows (cached): exchange inflows / whale + smart-money distribution
    const N = extra.nansen; if (N && m.liq) {
      if (N.exchange > 0.05 * m.liq) add(10, `Nansen: $${Math.round(N.exchange).toLocaleString()} net sent to exchanges in 24h (${Math.round(N.exchange / m.liq * 100)}% of liquidity)`, 'slow_rug');
      if (N.whale < -0.1 * m.liq) add(10, `Nansen: whales net sold $${Math.round(-N.whale).toLocaleString()} in 24h`, 'slow_rug');
      if (N.smart < -0.05 * m.liq) add(8, `Nansen: smart money distributing ($${Math.round(-N.smart).toLocaleString()} net out)`, 'slow_rug');
    }
    // parabolic run with low float (squeeze then dump)
    if (extra.r30 && extra.r30 > 5 && circ != null && circ < 0.5) add(15, `${extra.r30.toFixed(1)}x in 30 days with ${Math.round(circ * 100)}% float`, 'low_float_squeeze');
    const score = Math.min(100, s);
    const kinds = {}; for (const x of sig) kinds[x.kind] = (kinds[x.kind] || 0) + x.pts;
    const top2 = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
    const dump30 = (U && (U.unlock30d_pct_circ || 0) >= 5) || !!(N && m.liq && N.whale + N.smart < -0.15 * m.liq) || !!(w && (w.sells24hPct >= 1 || w.sells24h >= 3 || w.monthlyPattern)) || score >= 60;
    return { score, level: score >= 70 ? 'high' : score >= 45 ? 'elevated' : score >= 25 ? 'watch' : 'low', dump30, likelyTypes: top2, signals: sig.sort((a, b) => b.pts - a.pts) };
  }

  // Forward insider monitor (EVM): Transfer logs from top non-LP holders into the token's DEX pairs (= sells). Public RPCs keep ~10k blocks, so we poll.
  async function monitor(records) {
    const evm = records.filter((r) => chains.CHAINS[r.chain]?.kind === 'evm' && r.scan?.checks).slice(0, 15);
    for (const r of evm) {
      try {
        const hs = (r.scan.checks.find((c) => c.id === 'top10')?.evidence?.holders || []).filter((h) => !h.contract).slice(0, 8).map((h) => h.a.toLowerCase());
        if (!hs.length || !r.pair?.pairAddress) continue;
        const head = parseInt(await evmCallChain(r.chain, 'eth_blockNumber', []), 16);
        const W = (watch[r.key] ||= { holders: hs, events: [], from: head - 2000 });
        W.holders = hs; const from = Math.max(W.from, head - 9000);
        const logs = await evmCallChain(r.chain, 'eth_getLogs', [{ address: r.address, topics: [TRANSFER], fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16) }]);
        const pair = r.pair.pairAddress.toLowerCase().split(':')[0];
        const supply = r.supplyRaw;
        for (const l of logs || []) {
          const f = '0x' + l.topics[1].slice(26), t = '0x' + l.topics[2].slice(26);
          if (hs.includes(f) && t === pair) W.events.push({ t: Date.now(), from: f, raw: l.data });
        }
        W.from = head + 1;
        W.events = W.events.filter((e) => Date.now() - e.t < 120 * 86400e3);
        const day = W.events.filter((e) => Date.now() - e.t < 86400e3);
        W.sells24h = day.length;
        // share of supply: need decimals/supply; use holder % from GoPlus evidence as proxy when the whole holding moved is unknown
        W.sells24hPct = null;
        // monthly pattern: same wallet selling in >= 2 windows ~25-35 days apart
        const by = {}; for (const e of W.events) (by[e.from] ||= []).push(e.t);
        let pat = 0; for (const ts of Object.values(by)) { ts.sort(); for (let i = 1; i < ts.length; i++) { const dd = (ts[i] - ts[i - 1]) / 86400e3; if (dd >= 25 && dd <= 35) { pat++; break; } } }
        W.monthlyPattern = pat || 0;
      } catch (e) { /* public RPC hiccup: skip this round */ }
    }
    try { fs.writeFileSync(wfile, JSON.stringify(watch)); } catch {}
  }

  // On-demand for established tokens: DexScreener + CoinGecko contract lookup (circulating/total, 30d run) + unlocks + GoPlus holders via scan
  async function established(chain, address, rec) {
    const plat = { ethereum: 'ethereum', bsc: 'binance-smart-chain', base: 'base', arbitrum: 'arbitrum-one', polygon: 'polygon-pos', avalanche: 'avalanche', optimism: 'optimistic-ethereum', solana: 'solana' }[chain];
    const extra = {};
    if (plat) {
      try {
        const cg = await cached(`cg:c:${plat}:${address}`, 3600e3, () => getJSON(`https://api.coingecko.com/api/v3/coins/${plat}/contract/${address}?localization=false&tickers=false&community_data=false&developer_data=false`));
        const md = cg.market_data || {}; const circ = md.circulating_supply, tot = md.total_supply || md.max_supply;
        if (circ && tot) extra.circRatio = circ / tot;
        extra.coingecko = { id: cg.id, mcap: md.market_cap?.usd, fdv: md.fully_diluted_valuation?.usd, ath: md.ath?.usd, athDate: md.ath_date?.usd, ch30: md.price_change_percentage_30d, price: md.current_price?.usd };
        if (md.price_change_percentage_30d != null) extra.r30 = 1 + md.price_change_percentage_30d / 100;
        if (unlocksByGecko.get(cg.id)) extra.unlock = unlocksByGecko.get(cg.id);
      } catch (e) { extra.coingeckoError = e.message; }
    }
    return { ...assess(rec, extra), fundamentals: extra };
  }
  return { assess, monitor, established, reloadUnlocks: loadUnlocks };
}
module.exports = { createRugRisk };
