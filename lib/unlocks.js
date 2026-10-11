'use strict';
// Token unlocks as a standing risk factor + net supply (buy-burn minus unlocks).
// Data: research/unlocks.py -> data/unlocks_calendar.json (DefiLlama unlocks page data, free; refreshed ~6h).
// (data/unlocks.json is a separate older export owned by research/rugwatch.py / lib/rugrisk.js and is NOT touched here.)
// Net supply: reads data/buyburn*.json written by another worker when present; writes data/net_supply.json.
// Estimates from public data, not financial advice.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_AGE = 6 * 3600e3;
const NET_WINDOWS = ['1m', '3m', '6m', '9m', '1y', '2y', '3y'];
// how likely a category is to be sold soon after unlocking (multiplier on % of circulating)
const CAT_W = { insiders: 1.5, privateSale: 1.5, airdrop: 1.2, publicSale: 1.0, launch: 1.0, liquidity: 0.8, farming: 0.8, staking: 0.6, ecosystem: 0.7, community: 0.7, noncirculating: 0.5, migration: 0.3, other: 0.9, Uncategorized: 0.9 };
const CAT_TXT = { insiders: 'team/insiders', privateSale: 'private-sale investors', airdrop: 'airdrop recipients', publicSale: 'public sale', liquidity: 'liquidity', farming: 'farming rewards', staking: 'staking rewards', ecosystem: 'ecosystem fund', community: 'community', noncirculating: 'reserve/treasury', other: 'other' };
const proxW = (d) => (d <= 7 ? 1 : d <= 14 ? 0.8 : d <= 30 ? 0.5 : 0);
const fmtUsd = (x) => (x == null ? 'unknown USD' : x >= 1e9 ? '$' + (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? '$' + (x / 1e3).toFixed(0) + 'K' : '$' + x.toFixed(0));
const fmtTok = (x) => (x >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'K' : x.toFixed(0));

function createUnlocks({ DATA_DIR, log = () => {} }) {
  let cal = null, calT = 0, running = false;
  let bySym = new Map(), byGecko = new Map();
  function load() {
    const f = path.join(DATA_DIR, 'unlocks_calendar.json');
    try { const st = fs.statSync(f); if (st.mtimeMs !== calT) { cal = JSON.parse(fs.readFileSync(f, 'utf8')); calT = st.mtimeMs; bySym = new Map(); byGecko = new Map(); for (const t of cal.tokens || []) { if (t.geckoId) byGecko.set(t.geckoId, t); if (!bySym.has(t.sym) || t.inUniverse) bySym.set(t.sym, t); } } } catch { cal = null; }
    const stale = !cal || Date.now() - (cal.generatedAt || 0) > MAX_AGE;
    if (stale && !running && process.env.NO_AUTO_REFRESH !== '1') {
      running = true;
      const ch = spawn('python3', ['unlocks.py'], { cwd: path.join(__dirname, '..', 'research'), env: { ...process.env, DATA_DIR }, stdio: 'ignore' });
      ch.on('exit', () => { running = false; calT = 0; load(); }); ch.on('error', () => { running = false; });
    }
    return cal;
  }
  function find({ sym, cgId, price } = {}) {
    load(); let t = cgId && byGecko.get(cgId);
    if (!t && sym) { t = bySym.get(String(sym).toUpperCase()); if (t && price && t.price && (price / t.price > 2 || price / t.price < 0.5)) t = null; } // ticker collision guard
    return t || null;
  }
  // risk assessment over the next 30 days
  function assess(t) {
    if (!t) return null;
    const soon = (t.cliffs || []).filter((c) => c.daysAway <= 30);
    let eff = 0; const parts = [];
    for (const c of soon) { const p = c.pctCirc || 0; const w = proxW(c.daysAway) * (CAT_W[c.category] ?? 0.9); eff += p * w; }
    const w30 = t.windows?.['30d'] || {}; const linPct = t.circ ? (w30.linearTokens || 0) / t.circ * 100 : 0;
    eff += linPct * 0.4; // gradual vesting is absorbed more easily than a cliff
    const big = [...soon].sort((a, b) => (b.pctCirc || 0) - (a.pctCirc || 0))[0];
    const within = soon.length ? (soon[0].daysAway <= 7 ? 7 : soon[0].daysAway <= 14 ? 14 : 30) : null;
    const level = eff >= 3 ? 'major' : eff >= 1 ? 'notable' : eff >= 0.25 ? 'minor' : null;
    // group cliffs by date for display
    const byDate = {};
    for (const c of soon) { const d = byDate[c.date] || (byDate[c.date] = { date: c.date, daysAway: c.daysAway, tokens: 0, pctCirc: 0, usd: 0, categories: [] }); d.tokens += c.tokens; d.pctCirc += c.pctCirc || 0; d.usd += c.usd || 0; d.categories.push(CAT_TXT[c.category] || c.category); }
    const dates = Object.values(byDate).sort((a, b) => a.daysAway - b.daysAway);
    let text;
    if (!soon.length && linPct < 0.05) text = `No scheduled unlocks for ${t.sym} in the next 30 days (DefiLlama schedule).`;
    else {
      const daily = dates.length > 8 ? ` (${dates.length} separate release days, mostly small daily drips)` : '';
      text = `${t.sym}: ${(w30.pctCirc || 0).toFixed(2)}% of circulating supply (${fmtTok(w30.tokens || 0)} tokens, ~${fmtUsd(w30.usd)}) unlocks in the next 30 days${daily}.`;
      if (big && big.pctCirc >= 0.2) text += ` Biggest single release: ${big.pctCirc.toFixed(2)}% on ${big.date} (in ${Math.max(0, big.daysAway).toFixed(0)} days) to ${CAT_TXT[big.category] || big.category}.`;
      if (linPct >= 0.05) text += ` Plus continuous vesting of about ${linPct.toFixed(2)}% over the month.`;
      text += level === 'major' ? ' That is a lot of new supply that holders may sell: expect selling pressure around the date.' : level === 'notable' ? ' Enough new supply to weigh on price, especially if it goes to team or investors.' : ' Small relative to supply.';
    }
    let warn = null;
    if (level === 'major' || (level === 'notable' && within != null && within <= 14)) warn = big && within != null ? `Unlock ${within <= 7 ? 'THIS WEEK' : 'within ' + within + ' days'}: ${big.pctCirc.toFixed(2)}% of circulating on ${big.date} (${CAT_TXT[big.category] || big.category}, ~${fmtUsd(big.usd)}); ${(w30.pctCirc || 0).toFixed(2)}% total over 30 days` : `Heavy vesting: ${(w30.pctCirc || 0).toFixed(2)}% of circulating (~${fmtUsd(w30.usd)}) released over the next 30 days`;
    else if (level === 'notable') warn = `${(w30.pctCirc || 0).toFixed(2)}% of circulating unlocks over the next 30 days (~${fmtUsd(w30.usd)})`;
    return { sym: t.sym, name: t.name, eff: +eff.toFixed(3), level, within, pct30: w30.pctCirc ?? null, tokens30: w30.tokens ?? null, usd30: w30.usd ?? null, insider30: w30.insiderTokens ?? null, linPct30: +linPct.toFixed(3),
      dates: dates.map((d) => ({ ...d, categories: [...new Set(d.categories)] })), biggest: big || null, text, warn, url: t.url };
  }
  // composite factor: 0..100 (100 = no unlock pressure)
  function factor(a) {
    if (!a) return null;
    const score = Math.max(0, 100 - a.eff * 18);
    const cap = a.eff >= 5 ? 'D' : a.eff >= 2 && (a.within == null || a.within <= 14) ? 'C' : null;
    return { score, cap };
  }
  function list({ universeOnly = true, days = 30 } = {}) {
    load(); if (!cal) return [];
    return (cal.tokens || []).filter((t) => !universeOnly || t.inUniverse).map((t) => ({ t, a: assess(t) }))
      .filter(({ t, a }) => (t.cliffs || []).some((c) => c.daysAway <= days) || (a.linPct30 || 0) >= 0.05)
      .map(({ t, a }) => ({ ...a, inUniverse: t.inUniverse, price: t.price, circ: t.circ })).sort((x, y) => y.eff - x.eff);
  }
  // ---------- net supply: burns (data/buyburn*.json, other worker) minus unlocks ----------
  function readBuyburn() {
    let files = []; try { files = fs.readdirSync(DATA_DIR).filter((f) => /^buyburn.*\.json$/.test(f)); } catch {}
    const out = new Map(); const seen = [];
    const pickNum = (v, keys) => { if (typeof v === 'number') return v; if (v && typeof v === 'object') for (const k of keys) if (typeof v[k] === 'number') return v[k]; return null; };
    for (const f of files) {
      let d; try { d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { continue; }
      seen.push(f);
      const arr = Array.isArray(d) ? d : d.tokens || d.items || d.projections || d.results || (typeof d === 'object' ? Object.entries(d).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)).map(([k, v]) => ({ symbol: k, ...v })) : []);
      for (const e of Array.isArray(arr) ? arr : Object.entries(arr).map(([k, v]) => ({ symbol: k, ...v }))) {
        const sym = String(e.symbol || e.sym || e.ticker || e.token || '').toUpperCase(); if (!sym) continue;
        const W = e.windows || e.projections || e.burns || e.projection || e;
        const win = {};
        for (const w of NET_WINDOWS) {
          const v = W[w] ?? W[w.toUpperCase()] ?? W[{ '1m': '30d', '3m': '90d', '6m': '180d', '9m': '270d', '1y': '365d', '2y': '730d', '3y': '1095d' }[w]];
          if (v == null) continue;
          win[w] = { burnTokens: pickNum(v, ['burned_tokens', 'burnTokens', 'tokensBurned', 'burned', 'burn', 'amount']), burnPct: pickNum(v, ['burnPctCirc', 'burn_pct_circ']), burnUsd: pickNum(v, ['burnUsd', 'burn_usd']), theirUnlock: pickNum(v, ['unlocked_tokens', 'unlockTokens']), theirNetPct: pickNum(v, ['net_change_pct']) };
        }
        if (Object.keys(win).length) out.set(sym, { sym, file: f, cgId: e.coingecko_id || e.geckoId || e.cgId || null, circ: e.circ_now ?? e.circ ?? null, unlockBasis: e.unlock_basis || null, burnBasis: e.burn_basis || null, windows: win });
      }
    }
    return { files: seen, map: out };
  }
  function netSupply() {
    load(); const bb = readBuyburn();
    const res = { generatedAt: Date.now(), buyburnFiles: bb.files, status: bb.files.length ? `${bb.map.size} tokens with burn projections` : 'no data/buyburn*.json yet (buy-burn worker output absent): showing unlock side only', windows: NET_WINDOWS, tokens: [] };
    const syms = new Set([...bb.map.keys(), ...(cal?.tokens || []).filter((t) => t.inUniverse).map((t) => t.sym)]);
    for (const s of syms) {
      const b = bb.map.get(s); const u = find({ sym: s, cgId: b?.cgId });
      if (!b && !u) continue;
      const circ = b?.circ ?? u?.circ ?? null; // burns are projected against the buy-burn worker's circulating supply
      const fullSched = u && u.scheduleDetail && u.scheduleDetail.startsWith('protocol');
      const row = { sym: s, hasBurn: !!b, hasUnlocks: !!u, circ, unlockSource: u ? (fullSched ? 'DefiLlama full schedule (lib/unlocks)' : 'DefiLlama next event only') : b ? 'buy-burn worker estimate' : null, burnBasis: b?.burnBasis || null, theirUnlockBasis: b?.unlockBasis || null, windows: {} };
      for (const w of NET_WINDOWS) {
        const uw = u?.windows?.[w]; const bw = b?.windows?.[w];
        let unlockT = uw && (fullSched || !bw?.theirUnlock) ? uw.tokens : (bw?.theirUnlock ?? (u ? uw?.tokens ?? 0 : null));
        const flat = u && u.windows?.['3y'] && u.windows['3y'].tokens <= (u.windows['1m']?.tokens || 0) * 1.01; // schedule ends now = no forward schedule
        if (uw && (!uw.tokens || flat) && bw?.theirUnlock > uw.tokens) { unlockT = bw.theirUnlock; row.unlockSource = 'buy-burn worker trailing-rate estimate (DefiLlama has no forward schedule)'; }
        let burnT = bw ? bw.burnTokens : null;
        if (burnT == null && bw?.burnPct != null && circ) burnT = bw.burnPct / 100 * circ;
        const net = unlockT != null && burnT != null ? unlockT - burnT : null;
        row.windows[w] = { unlockTokens: unlockT, burnTokens: burnT, netTokens: net, netPctCirc: net != null && circ ? net / circ * 100 : null, unlockPctCirc: unlockT != null && circ ? unlockT / circ * 100 : null, burnPctCirc: burnT != null && circ ? burnT / circ * 100 : null, theirNetPct: bw?.theirNetPct ?? null };
      }
      const y = row.windows['1y'];
      row.text = y.netTokens != null ? `Over 1 year: ${fmtTok(Math.abs(y.netTokens))} tokens net ${y.netTokens > 0 ? 'added' : 'removed'} (${y.netPctCirc != null ? Math.abs(y.netPctCirc).toFixed(2) + '% of circulating' : '?'}): unlocks ${y.unlockTokens != null ? fmtTok(y.unlockTokens) : '?'} vs burns ${y.burnTokens != null ? fmtTok(y.burnTokens) : '?'}. ${y.netTokens > 0 ? 'Supply grows: burns do not offset unlocks.' : 'Supply shrinks: burns outpace unlocks.'}`
        : b && !u ? 'Burn projection only (no unlock schedule on DefiLlama for this token).' : `Unlock side only: ${y.unlockPctCirc != null ? y.unlockPctCirc.toFixed(2) + '% of circulating unlocks in 1 year' : 'n/a'}; no buy-burn projection available.`;
      if (row.unlockSource) row.text += ` Unlock source: ${row.unlockSource}${row.burnBasis ? '; burn basis: ' + row.burnBasis : ''}.`;
      res.tokens.push(row);
    }
    try { fs.writeFileSync(path.join(DATA_DIR, 'net_supply.json'), JSON.stringify(res)); } catch {}
    return res;
  }
  function status() { load(); return { generatedAt: cal?.generatedAt || null, source: cal?.source || null, notUsed: cal?.notUsed || null, coverage: cal?.coverage || null, method: cal?.method || null, refreshing: running }; }
  return { load, find, assess, factor, list, netSupply, status };
}
module.exports = { createUnlocks };
