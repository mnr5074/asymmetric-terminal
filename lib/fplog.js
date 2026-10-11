// False-positive log + automatic alert labeling + rolling detector effectiveness + shadow mode + live event ingestion.
// Every fired alert (any detector, active OR shadow) is recorded once per detector/token/6h with its threshold values and price.
// Labels are attached automatically at +1h / +24h / +7d, no manual review:
//   price  : return vs alert price, plus the max/min seen since (live feed / perps marks every tick; the call log's tracked
//            max/min from lib/calls.js is reused for feed tokens instead of duplicating price tracking)
//   liq    : did pool liquidity hold (>= 70% of the alert-time liquidity)?
//   smart  : did smart money follow in? Nansen flow-intelligence 1d (cached; GUARDRAILS: only when balance >= 300, 1 credit/call,
//            <= NANSEN_FPLOG_DAILY calls/day, purpose 'fplog_label', every call logged here) or the free cached netflow
//   cex    : did it get a centralized-exchange listing? (CoinGecko contract tickers, keyless, <= 10 lookups/hour, cached 24h)
// Verdict = did the detector's CLAIM happen (crash / rug / pump / volatility, thresholds scaled for perps vs DEX tokens).
// Rolling effectiveness = time-decayed (7-day half-life) precision, shrunk toward the backtest precision, divided by the live base
// rate of that claim -> lift. Lift < 0.9 on >= 8 effective alerts -> DEMOTE to shadow ('rebuild needed'); shadow detectors keep firing
// silently and are still scored; lift >= 1.15 -> auto-PROMOTE back. HARD flags are never demoted.
// Threshold tuning: proposes stricter thresholds when precision improves >= 10pp on >= 20 labelled alerts with Fisher p < 0.05;
// such a significant proposal is APPLIED only as a ranking filter (alerts under it go to shadow) and documented here. Detector
// code is never rewritten automatically.
// Ingestion: new pumps (>= 3x since first call / runner) and rugs/crashes seen live are appended to data/events_live.json, which
// research/backtest/events_build.py folds into data/events_labeled.json on the backtest schedule.
'use strict';
const fs = require('fs');
const path = require('path');
const HZ = [['1h', 3600e3], ['24h', 86400e3], ['7d', 7 * 86400e3]];
const HALF_LIFE_D = 7, PRIOR_K = 5, DEMOTE_LIFT = 0.9, PROMOTE_LIFT = 1.15, MIN_NEFF = 8;
const HARD = new Set(['honeypot', 'lp_pull', 'contract_mint_authority', 'contract_freeze_authority']);
const DEX_RE = /swap|dex|raydium|orca|meteora|pump|jupiter|aerodrome|uniswap|pancake|curve|balancer|sushi|camelot|velodrome|joe|fluxbeam|lifinity|phoenix|openbook|stonfi|dedust|cetus|turbos|bluefin|kyber|1inch|0x|paraswap|odos|baseswap|thruster|ambient|maverick|aster|hyperliquid|unknown/i;
const CG_PLAT = { solana: 'solana', ethereum: 'ethereum', base: 'base', bsc: 'binance-smart-chain', arbitrum: 'arbitrum-one', polygon: 'polygon-pos', avalanche: 'avalanche', optimism: 'optimistic-ethereum', sui: 'sui', ton: 'the-open-network', tron: 'tron' };

function lg(x) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const v of c) s += v / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
function fisherGreater(a, b, c, d) { const n1 = a + b, n2 = c + d, m = a + c, N = n1 + n2; const lh = (x) => lg(n1 + 1) - lg(x + 1) - lg(n1 - x + 1) + lg(n2 + 1) - lg(m - x + 1) - lg(n2 - m + x + 1) - (lg(N + 1) - lg(m + 1) - lg(N - m + 1)); let p = 0; for (let x = a; x <= Math.min(n1, m); x++) p += Math.exp(lh(x)); return Math.min(1, p); }

function createFpLog({ DATA_DIR, bus, live, perps, calls, nansen, dsTokens, getJSON, cached, scoreboard, writer = () => true, log = () => {} }) {
  const file = path.join(DATA_DIR, 'fplog.json'); const evFile = path.join(DATA_DIR, 'events_live.json');
  let S = { version: 1, createdAt: Date.now(), alerts: [], detectors: {}, proposals: [], applied: {}, nansen: { day: '', used: 0, calls: [] }, cex: { hour: 0, used: 0 }, ingest: { lastAt: 0, added: 0 } };
  try { S = { ...S, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const NANSEN_DAILY = +(process.env.NANSEN_FPLOG_DAILY || 30), NANSEN_MIN_BAL = 300;
  const lastFired = new Map(); for (const a of S.alerts) lastFired.set(a.detector + '|' + a.key, a.t);
  let dirty = false, loadedAt = Date.now();
  // read-only (non-writer) instances re-read the writer's file so their views stay current
  const sync = () => { if (writer() || Date.now() - loadedAt < 30e3) return; loadedAt = Date.now(); try { S = { ...S, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {} };
  const save = () => { if (!dirty || !writer()) return; try { if (S.alerts.length > 20000) S.alerts.splice(0, S.alerts.length - 20000); fs.writeFileSync(file + '.tmp', JSON.stringify(S)); fs.renameSync(file + '.tmp', file); dirty = false; } catch (e) { log('fplog save: ' + e.message); } };

  const isPerp = (a) => a.key.startsWith('perp:');
  // claim thresholds: perps are large caps, DEX tokens are memecoins
  const TH = (a) => isPerp(a) ? { crash: -10, crash7: -15, pump: 10, pump7: 20, rugLiq: null, vol: 5 } : { crash: -30, crash7: -50, pump: 50, pump7: 100, rugLiq: 0.3, vol: 25 };

  function record(signals, meta = {}) {
    const now = Date.now(); let n = 0;
    for (const s of signals) {
      const k = s.detector + '|' + s.token.key; const last = lastFired.get(k);
      if (last && now - last < 6 * 3600e3) continue;
      if (s.price == null && !s.token.key.startsWith('perp:') && !s.token.address) continue; // nothing to price later
      lastFired.set(k, now); n++;
      const st = S.detectors[s.detector]?.status || 'active';
      S.alerts.push({ id: k + '@' + now, t: now, detector: s.detector, desk: s.desk, claim: s.claim, severity: s.severity, key: s.token.key, chain: s.token.chain, address: s.token.address, symbol: s.token.symbol,
        price0: s.price, liq0: s.liq, values: s.values, thresholds: s.thresholds, reason: s.reason, status: st, rank: meta.rank?.[s.id] ?? null, members: s.members || undefined,
        maxRet: 0, minRet: 0, lastPx: s.price, lastLiq: s.liq, minLiqRatio: 1, labels: {}, verdict: 'pending' });
    }
    if (n) dirty = true; return n;
  }

  // ---- price / liquidity lookups (live feed + perps + call log first, DexScreener batch for the rest) ----
  function localPx() {
    const m = new Map();
    for (const x of (bus?.liveItems?.() || live?.feed?.().items || [])) m.set(x.key, { px: x.price, liq: x.liq });
    for (const t of (bus?.perpTokens?.() || perps?.snapshot?.().tokens || [])) m.set('perp:' + t.sym, { px: t.mark, liq: null });
    return m;
  }
  function bump(a, px, liq) {
    if (!px) return;
    if (a.price0 == null) { a.price0 = px; a.liq0 = a.liq0 ?? liq; }
    const r = (px / a.price0 - 1) * 100; a.lastPx = px; a.maxRet = Math.max(a.maxRet, r); a.minRet = Math.min(a.minRet, r);
    if (liq != null) { a.lastLiq = liq; if (a.liq0) a.minLiqRatio = Math.min(a.minLiqRatio, liq / a.liq0); }
    // reuse the call log's own tracking (max/min since its call) when the call predates the alert
    const cs = calls?.forKey?.(a.key); const c = cs && cs.find((c) => c.t <= a.t + 60e3);
    if (c && c.maxPx && c.px0) { /* call extremes are since the call, not since the alert: only use as an upper bound sanity check */ a.callGrade = c.grade; }
  }
  async function track() {
    const now = Date.now(); const open = S.alerts.filter((a) => !a.done && now - a.t < 7.2 * 86400e3); if (!open.length) return;
    const L = localPx(); const miss = {};
    for (const a of open) { const p = L.get(a.key); if (p) bump(a, p.px, p.liq); else if (a.chain && a.address && !isPerp(a)) (miss[a.chain] ||= new Set()).add(a.address); }
    // DexScreener batch only for alerts that are due a checkpoint (keeps it light)
    const due = (a) => HZ.some(([h, ms]) => !a.labels[h] && now - a.t >= ms);
    for (const [chain, set] of Object.entries(miss)) {
      const want = [...set].filter((ad) => open.some((a) => a.address === ad && due(a))).slice(0, 120); if (!want.length || !dsTokens) continue;
      try { const m = await dsTokens(chain, want); for (const a of open) if (a.chain === chain && m[a.address]) bump(a, m[a.address].priceUsd, m[a.address].liquidityUsd); else if (a.chain === chain && want.includes(a.address) && m[a.address] === null) a.delisted = (a.delisted || 0) + 1; } catch {}
    }
    dirty = true;
  }

  async function smartLabel(a) {
    if (!nansen?.status?.().enabled || isPerp(a) || !a.chain || !a.address) return { status: 'n/a' };
    const peek = nansen.peekFlow?.(a.chain, a.address, '1d'); if (peek) return { status: 'cached', smartNetUsd: Math.round(peek.smart || 0), followed: (peek.smart || 0) > 0, smartWallets: peek.smartWallets };
    const nf = nansen.netflowFor?.(a.chain, a.address); if (nf) return { status: 'netflow', smartNetUsd: Math.round(nf.net_flow_24h_usd || nf.netflow24h || 0), followed: (nf.net_flow_24h_usd || nf.netflow24h || 0) > 0 };
    const day = new Date().toISOString().slice(0, 10); if (S.nansen.day !== day) S.nansen = { day, used: 0, calls: S.nansen.calls.slice(-50) };
    const st = nansen.status(); if ((st.creditsRemaining ?? 0) < NANSEN_MIN_BAL) return { status: 'skipped: balance < ' + NANSEN_MIN_BAL };
    if (S.nansen.used >= NANSEN_DAILY) return { status: 'skipped: fplog daily cap' };
    // flow-intelligence costs 1 credit (COST table in lib/nansen.js): never a 100+ credit call
    const r = await nansen.flow(a.chain, a.address, '1d', 'fplog_label'); S.nansen.used++; S.nansen.calls.push({ t: Date.now(), key: a.key, credits: r.cached ? 0 : 1, status: r.error || r.skipped || 'ok', balance: st.creditsRemaining });
    const s = r.summary; if (!s) return { status: r.skipped || r.error || 'no data' };
    return { status: r.cached ? 'cached' : 'nansen', smartNetUsd: Math.round(s.smart || 0), followed: (s.smart || 0) > 0, smartWallets: s.smartWallets, credits: r.cached ? 0 : 1 };
  }
  async function cexLabel(a) {
    if (isPerp(a)) return { listed: true, status: 'perp (already CEX-listed)' };
    const plat = CG_PLAT[a.chain]; if (!plat || !a.address || !getJSON) return { status: 'n/a' };
    const hr = Math.floor(Date.now() / 3600e3); if (S.cex.hour !== hr) S.cex = { hour: hr, used: 0 };
    if (S.cex.used >= 10) return { status: 'deferred (rate limit)' };
    S.cex.used++;
    try {
      const addr = a.chain === 'solana' ? a.address : a.address.toLowerCase();
      const d = await cached('cgcontract:' + plat + ':' + addr, 24 * 3600e3, () => getJSON(`https://api.coingecko.com/api/v3/coins/${plat}/contract/${addr}`, {}, 12000));
      const cex = [...new Set((d?.tickers || []).map((t) => t.market?.identifier || t.market?.name || '').filter((m) => m && !DEX_RE.test(m)))];
      return { listed: cex.length > 0, exchanges: cex.slice(0, 6), status: 'coingecko' };
    } catch (e) { return { listed: false, status: /404/.test(e.message) ? 'not on coingecko' : 'error: ' + e.message.slice(0, 60) }; }
  }
  function verdictFor(a, h) {
    const th = TH(a); const rugged = (th.rugLiq != null && a.minLiqRatio <= th.rugLiq) || (a.delisted || 0) > 5 || a.minRet <= -80;
    const late = h === '7d';
    switch (a.claim) {
      case 'rug': return rugged || a.minRet <= (late ? -60 : -50);
      case 'crash': return rugged || a.minRet <= (late ? th.crash7 : th.crash);
      case 'pump': return !rugged && a.maxRet >= (late ? th.pump7 : th.pump);
      case 'volatility': return Math.max(a.maxRet, -a.minRet) >= th.vol;
      default: return null;
    }
  }
  async function evaluate() {
    const now = Date.now(); let n = 0;
    for (const a of S.alerts) {
      if (a.done) continue;
      for (const [h, ms] of HZ) {
        if (a.labels[h] || now - a.t < ms) continue;
        if (now - a.t > ms * 3 && h !== '7d' && a.lastPx == null) { a.labels[h] = { at: now, status: 'no price' }; continue; }
        const lab = { at: now, retPct: a.lastPx && a.price0 ? +((a.lastPx / a.price0 - 1) * 100).toFixed(2) : null, maxRetPct: +a.maxRet.toFixed(2), minRetPct: +a.minRet.toFixed(2),
          liqHeld: a.liq0 ? (a.lastLiq ?? a.liq0) / a.liq0 >= 0.7 : null, liqRatio: a.liq0 && a.lastLiq != null ? +(a.lastLiq / a.liq0).toFixed(3) : null, hit: a.lastPx != null || a.price0 != null ? verdictFor(a, h) : null };
        if (h === '24h' && (a.claim === 'pump' || a.claim === 'crash')) { try { lab.smart = await smartLabel(a); } catch (e) { lab.smart = { status: 'error' }; } }
        if (h !== '1h' && a.claim === 'pump') { try { lab.cex = await cexLabel(a); } catch { lab.cex = { status: 'error' }; } }
        a.labels[h] = lab; n++;
        if (h === '24h') { a.verdict = lab.hit == null ? 'unscorable' : lab.hit ? 'hit' : 'miss'; a.verdictAt = now; }
        if (h === '7d') { if (a.verdict === 'miss' && lab.hit) a.lateHit = true; if (a.verdict === 'pending') a.verdict = lab.hit == null ? 'unscorable' : lab.hit ? 'hit' : 'miss'; a.done = true; }
      }
    }
    if (n) { dirty = true; rollup(); }
    return n;
  }

  // ---- rolling effectiveness, demotion / shadow / promotion ----
  function rollup() {
    const now = Date.now(); const base = {}; const det = {};
    const scored = S.alerts.filter((a) => a.verdict === 'hit' || a.verdict === 'miss');
    for (const a of scored) { const u = (isPerp(a) ? 'perp:' : 'dex:') + a.claim; (base[u] ||= [0, 0]); base[u][0] += a.verdict === 'hit'; base[u][1]++; }
    for (const a of scored) {
      const w = Math.pow(0.5, (now - a.t) / 86400e3 / HALF_LIFE_D); const d = (det[a.detector] ||= { n: 0, hits: 0, ewN: 0, ewHits: 0, ewBase: 0, units: {} });
      const u = (isPerp(a) ? 'perp:' : 'dex:') + a.claim; const br = base[u][0] / base[u][1];
      d.n++; d.hits += a.verdict === 'hit'; d.ewN += w; d.ewHits += w * (a.verdict === 'hit'); d.ewBase += w * br; d.units[u] = (d.units[u] || 0) + 1;
      if (a.labels['24h']?.smart?.followed != null) { d.smartN = (d.smartN || 0) + 1; d.smartFollowed = (d.smartFollowed || 0) + a.labels['24h'].smart.followed; }
      if (a.labels['24h']?.liqHeld != null) { d.liqN = (d.liqN || 0) + 1; d.liqHeld = (d.liqHeld || 0) + a.labels['24h'].liqHeld; }
      const cx = a.labels['7d']?.cex || a.labels['24h']?.cex; if (cx?.listed != null && cx.status !== 'perp (already CEX-listed)') { d.cexN = (d.cexN || 0) + 1; d.cexListed = (d.cexListed || 0) + cx.listed; }
    }
    const sb = scoreboard?.() || {}; const ids = new Set([...Object.keys(det), ...Object.keys(S.detectors), ...Object.keys(sb)]);
    for (const id of ids) {
      const d = det[id] || { n: 0, hits: 0, ewN: 0, ewHits: 0, ewBase: 0 }; const b = sb[id]; const prev = S.detectors[id] || {};
      const claimStats = b ? (b[b.claim === 'pump' ? 'pump' : 'crash'] || {}) : {};
      const priorP = claimStats.precision ?? null; const baseLive = d.ewN ? d.ewBase / d.ewN : null;
      const prior = priorP != null && claimStats.base_rate && baseLive != null ? Math.min(0.95, baseLive * (claimStats.lift || 1)) : baseLive; // translate backtest lift into the live base
      const prec = d.ewN ? (d.ewHits + (prior ?? 0) * PRIOR_K) / (d.ewN + (prior != null ? PRIOR_K : 0)) : null;
      const lift = prec != null && baseLive ? prec / baseLive : null;
      let status = prev.status || 'active', why = prev.why || null, rebuild = !!prev.rebuild;
      if (!prev.status && b && b.trust === 'weak' && b.edge === false && !HARD.has(id)) { status = 'shadow'; why = 'backtest: ' + (b.trust_why || 'tested, no reliable edge'); rebuild = true; }
      if (!HARD.has(id) && d.ewN >= MIN_NEFF && lift != null) {
        if (status === 'active' && lift < DEMOTE_LIFT) { status = 'shadow'; why = `live rolling lift ${lift.toFixed(2)} < ${DEMOTE_LIFT} on ${d.ewN.toFixed(1)} effective alerts`; rebuild = true; }
        else if (status === 'shadow' && lift >= PROMOTE_LIFT) { status = 'active'; why = `auto-promoted: live rolling lift recovered to ${lift.toFixed(2)}`; rebuild = false; }
      }
      const changed = status !== prev.status;
      S.detectors[id] = { ...prev, n: d.n, hits: d.hits, precision: d.n ? +(d.hits / d.n).toFixed(3) : null, ewN: +d.ewN.toFixed(2), rollingPrecision: prec != null ? +prec.toFixed(3) : null, liveBase: baseLive != null ? +baseLive.toFixed(3) : null,
        rollingLift: lift != null ? +lift.toFixed(3) : null, status, why, rebuild, since: changed ? now : prev.since || now, history: changed ? [...(prev.history || []), { t: now, status, why }].slice(-20) : prev.history || [],
        smartFollowRate: d.smartN ? +(d.smartFollowed / d.smartN).toFixed(3) : null, liqHeldRate: d.liqN ? +(d.liqHeld / d.liqN).toFixed(3) : null, cexListRate: d.cexN ? +(d.cexListed / d.cexN).toFixed(3) : null, hard: HARD.has(id) };
    }
    proposeThresholds(scored);
    dirty = true;
  }
  function proposeThresholds(scored) {
    const by = {}; for (const a of scored) for (const [k, thr] of Object.entries(a.thresholds || {})) { const v = a.values?.[k]; if (typeof thr === 'number' && typeof v === 'number') ((by[a.detector] ||= {})[k] ||= []).push({ v, hit: a.verdict === 'hit', thr }); }
    const out = [];
    for (const [det, ks] of Object.entries(by)) for (const [k, rows] of Object.entries(ks)) {
      if (rows.length < 20) continue;
      const hiBetter = rows.filter((r) => r.hit).reduce((s, r) => s + r.v, 0) / Math.max(1, rows.filter((r) => r.hit).length) >= rows.filter((r) => !r.hit).reduce((s, r) => s + r.v, 0) / Math.max(1, rows.filter((r) => !r.hit).length);
      const p0 = rows.filter((r) => r.hit).length / rows.length; let best = null;
      const vs = [...new Set(rows.map((r) => r.v))].sort((a, b) => a - b);
      for (const c of vs) { const kept = rows.filter((r) => hiBetter ? r.v >= c : r.v <= c); const drop = rows.filter((r) => !(hiBetter ? r.v >= c : r.v <= c)); if (kept.length < 10 || !drop.length) continue;
        const pk = kept.filter((r) => r.hit).length / kept.length; if (!best || pk > best.precision) best = { cut: c, precision: pk, kept: kept.length, dropped: drop.length, hk: kept.filter((r) => r.hit).length, hd: drop.filter((r) => r.hit).length }; }
      if (!best || best.precision - p0 < 0.1) continue;
      const p = fisherGreater(best.hk, best.kept - best.hk, best.hd, best.dropped - best.hd); const significant = p < 0.05 && rows.length >= 20;
      const prop = { detector: det, field: k, direction: hiBetter ? '>=' : '<=', current: rows[0].thr, proposed: best.cut, precisionNow: +p0.toFixed(3), precisionProposed: +best.precision.toFixed(3), keeps: best.kept, drops: best.dropped, n: rows.length, p: +p.toFixed(4), significant, at: Date.now(),
        note: significant ? 'significant: applied as a ranking filter (alerts beyond it are shadowed); detector code unchanged' : 'proposal only (not significant yet)' };
      out.push(prop); if (significant) S.applied[det + '.' + k] = prop; else delete S.applied[det + '.' + k];
    }
    S.proposals = out;
  }
  // ranking filter from applied (significant) proposals
  function passesTuned(s) { for (const [k, p] of Object.entries(S.applied || {})) { if (!k.startsWith(s.detector + '.')) continue; const v = s.values?.[p.field]; if (typeof v === 'number' && !(p.direction === '>=' ? v >= p.proposed : v <= p.proposed)) return false; } return true; }

  // ---- ingest new pumps / rugs into the labelled dataset ----
  function ingest() {
    let d = { events: [] }; try { d = JSON.parse(fs.readFileSync(evFile, 'utf8')); } catch {}
    const seen = new Set(d.events.map((e) => e.class + '|' + e.key)); let added = 0; const now = Date.now();
    const push = (e) => { const k = e.class + '|' + e.key; if (!e.key || seen.has(k)) return; seen.add(k); d.events.push({ ...e, ingestedAt: now }); added++; };
    try {
      const cf = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'calls.json'), 'utf8')).calls || []; const first = new Map();
      for (const c of cf) if (!first.has(c.key)) first.set(c.key, c);
      for (const c of first.values()) {
        if (c.rugged) push({ class: 'rug', key: c.key, chain: c.chain, symbol: c.symbol, t: c.rugT || c.lastT, magnitude: -90, source: 'calls', definition: 'live: rugged after first call (price <= 10% or liquidity pulled / delisted)' });
        else if (c.px0 && c.maxPx >= 3 * c.px0) push({ class: 'pump', key: c.key, chain: c.chain, symbol: c.symbol, t: c.lastT, magnitude: +(c.maxPx / c.px0).toFixed(2), source: 'calls', definition: 'live: >= 3x from first call price' });
      }
    } catch {}
    for (const a of S.alerts) if (a.labels['24h'] && !isPerp(a)) {
      if (a.maxRet >= 200 && a.minLiqRatio > 0.3) push({ class: 'pump', key: a.key, chain: a.chain, symbol: a.symbol, t: a.labels['24h'].at, magnitude: +(1 + a.maxRet / 100).toFixed(2), source: 'fplog', definition: 'live: >= 3x within 24h of an alert' });
      if (a.minLiqRatio <= 0.3 || a.minRet <= -80) push({ class: a.minLiqRatio <= 0.3 ? 'rug' : 'crash', key: a.key, chain: a.chain, symbol: a.symbol, t: a.labels['24h'].at, magnitude: +a.minRet.toFixed(1), source: 'fplog', definition: 'live: liquidity pulled (<= 30%) or -80% within 24h of an alert' });
    }
    if (added && writer()) { if (d.events.length > 50000) d.events.splice(0, d.events.length - 50000); fs.writeFileSync(evFile + '.tmp', JSON.stringify({ updatedAt: now, events: d.events })); fs.renameSync(evFile + '.tmp', evFile); }
    S.ingest = { lastAt: now, added: (S.ingest?.added || 0) + added, total: d.events.length, pumps: d.events.filter((e) => e.class === 'pump').length, crashes: d.events.filter((e) => e.class !== 'pump').length }; dirty = true;
    return added;
  }

  function summary({ limit = 60 } = {}) {
    sync();
    const recent = S.alerts.slice(-limit).reverse().map(({ id, t, detector, claim, severity, key, symbol, price0, values, thresholds, reason, status, verdict, labels, maxRet, minRet, lateHit }) =>
      ({ id, t, detector, claim, severity, key, symbol, price0, values, thresholds, reason, status, verdict, lateHit, maxRetPct: +maxRet.toFixed(1), minRetPct: +minRet.toFixed(1), labels }));
    const counts = { total: S.alerts.length, pending: S.alerts.filter((a) => a.verdict === 'pending').length, hit: S.alerts.filter((a) => a.verdict === 'hit').length, miss: S.alerts.filter((a) => a.verdict === 'miss').length };
    return { generatedAt: Date.now(), counts, detectors: S.detectors, proposals: S.proposals, applied: S.applied, nansen: { ...S.nansen, calls: S.nansen.calls.slice(-15), guardrails: { minBalance: NANSEN_MIN_BAL, dailyCap: NANSEN_DAILY, maxCreditsPerCall: 1 } }, ingest: S.ingest,
      rules: { horizons: HZ.map((h) => h[0]), halfLifeDays: HALF_LIFE_D, demoteLift: DEMOTE_LIFT, promoteLift: PROMOTE_LIFT, minEffectiveAlerts: MIN_NEFF, verdicts: 'DEX: crash <= -30% (24h) / -50% (7d), pump >= +50% / +100%, rug = liquidity <= 30% or -80%; perps: crash <= -10% / -15%, pump >= +10% / +20%' }, recent };
  }
  return { record, track, evaluate, rollup, ingest, save, summary, passesTuned, state: () => S, detectorState: (id) => { sync(); return S.detectors[id] || null; }, alert: (id) => S.alerts.find((a) => a.id === id) || null };
}
module.exports = { createFpLog, HARD };
