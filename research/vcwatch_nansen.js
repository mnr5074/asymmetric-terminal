// Nansen enrichment for the VC/fund/MM watch (user-approved 2026-10-11 07:15 PT: "use Nansen freely where it materially improves the result").
// Rules: key from env only (never printed); everything cached in data/vcwatch_nansen_cache.json (no duplicate lookups); every call logged with
// credits in data/vcwatch_nansen_log.json; stop if the balance would fall below FLOOR (300); never call label/premium-label endpoints (>=100 credits).
// Steps: entity-name search (0 cr) -> funds/holdings small-cap accumulation (5 cr/call) -> who-bought-sold Fund/Smart buyers on flagged +
// catalog tokens (1 cr) -> smart-money/historical-holdings Fund time series per token (1 cr) for the historical lead-time study.
'use strict';
const fs = require('fs'); const path = require('path');
const KEY = process.env.NANSEN_API_KEY; if (!KEY) { console.log('NANSEN_API_KEY not set'); process.exit(1); }
const DATA = path.join(__dirname, '..', 'data');
const CF = path.join(DATA, 'vcwatch_nansen_cache.json'), LF = path.join(DATA, 'vcwatch_nansen_log.json'), OUT = path.join(DATA, 'vcwatch_nansen.json');
const FLOOR = 300, RUN_CAP = +(process.env.VCN_CAP || 260);
const COST = { 'account': 0, 'search/entity-name': 0, 'search/general': 0, 'funds/holdings': 5, 'smart-money/holdings': 5, 'tgm/who-bought-sold': 1, 'smart-money/historical-holdings': 1, 'tgm/transfers': 1, 'tgm/holders': 5 };
const BASE = { 'funds/holdings': 'https://api.nansen.ai/api/v1beta1/' };
let C = {}; try { C = JSON.parse(fs.readFileSync(CF, 'utf8')); } catch {}
let LOG = { runs: [] }; try { LOG = JSON.parse(fs.readFileSync(LF, 'utf8')); } catch {}
const run = { startedAt: new Date().toISOString(), calls: [], used: 0, remaining: null, stopped: null }; LOG.runs.push(run);
const save = () => { fs.writeFileSync(CF, JSON.stringify(C)); fs.writeFileSync(LF, JSON.stringify(LOG, null, 1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(ep, body, method = 'POST') {
  if (!(ep in COST) || COST[ep] >= 100) throw new Error('endpoint not allowed: ' + ep);
  const ck = ep + '|' + JSON.stringify(body || {}); if (C[ck]) return { data: C[ck].v, cached: true };
  const cost = COST[ep];
  if (cost > 0 && run.remaining != null && run.remaining - cost < FLOOR) { run.stopped = `balance ${run.remaining} would fall below ${FLOOR}`; return { skipped: run.stopped }; }
  if (run.used + cost > RUN_CAP) { run.stopped = `run cap ${RUN_CAP} reached`; return { skipped: run.stopped }; }
  for (let i = 0; i < 3; i++) {
    let r; try { r = await fetch((BASE[ep] || 'https://api.nansen.ai/api/v1/') + ep, { method, headers: { apikey: KEY, 'content-type': 'application/json', accept: 'application/json' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined, signal: AbortSignal.timeout(90000) }); }
    catch (e) { run.calls.push({ t: Date.now(), ep, status: 'timeout', used: null, body }); save(); if (i < 1) { await sleep(5000); continue; } return { error: 'timeout' }; }
    const used = +(r.headers.get('x-nansen-credits-used') || 0); const rem = r.headers.get('x-nansen-credits-remaining');
    run.used += used; if (rem != null) run.remaining = +rem;
    const j = await r.json().catch(() => null);
    run.calls.push({ t: Date.now(), ep, status: r.status, used, remaining: rem != null ? +rem : null, body: ep.startsWith('search') ? body : { ...body, pagination: body?.pagination } });
    if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
    if (!r.ok) { save(); return { error: `HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}` }; }
    C[ck] = { t: Date.now(), v: j }; save(); await sleep(400); return { data: j };
  }
  return { error: '429' };
}
const CH = { ethereum: 'ethereum', base: 'base', bsc: 'bnb', solana: 'solana', robinhood: 'robinhood' };
const ENTITIES = ['Wintermute', 'GSR', 'Jump', 'DWF', 'Amber', 'Flowdesk', 'Cumberland', 'B2C2', 'Keyrock', 'Auros', 'Kairon', 'Selini', 'Presto', 'Folkvang', 'QCP', 'Galaxy', 'Alameda', 'Gravity Team',
  'a16z', 'Paradigm', 'Polychain', 'Multicoin', 'Pantera', 'Dragonfly', 'Delphi', 'Spartan', 'Hashed', 'Binance Labs', 'YZi', 'Coinbase Ventures', 'DeFiance', 'Mechanism', 'Arrington', 'Animoca', 'Fenbushi',
  'Mirana', 'Blockchain Capital', 'Electric Capital', 'Variant', 'Hack VC', 'Outlier', 'LD Capital', 'CMS Holdings', 'Fasanara', 'ParaFi', 'Hypersphere', 'Sigil', 'Robot Ventures', 'Maven 11', 'Big Brain', 'Symbolic', 'Abraxas', 'OKX Ventures', 'Laser Digital', 'FalconX', 'Matrixport'];
(async () => {
  const out = { generatedAt: Date.now(), entities: {}, funds_holdings: [], buyers: {}, fund_history: {} };
  const acc = await call('account', null, 'GET'); run.remaining = acc.data?.credits_remaining ?? null; run.balanceBefore = run.remaining; delete C['account|{}']; // never cache the balance
  console.log('balance before', run.remaining);
  // 1) entity names (free)
  for (const e of ENTITIES) { const r = await call('search/entity-name', { search_query: e }); out.entities[e] = r.data?.data || r.data || r.error || r.skipped; }
  // 2) Fund holdings in small/young tokens (accumulation feed)
  const fb = (order, page) => ({ chains: ['ethereum', 'base', 'bnb', 'solana', 'robinhood'], filters: { market_cap_usd: { max: 100e6 }, token_age_days: { max: 365 }, value_usd: { min: 10000 } }, pagination: { page, per_page: 100 }, order_by: [{ field: order, direction: 'DESC' }] });
  for (const [o, p] of [['balance_24h_percent_change', 1], ['holders_count', 1]]) { const r = await call('funds/holdings', fb(o, p)); if (r.data?.data) out.funds_holdings.push(...r.data.data.map((x) => ({ ...x, _order: o }))); else console.log('funds/holdings', o, r.error || r.skipped); }
  const fh = new Map(); for (const x of out.funds_holdings) fh.set(x.chain + ':' + x.token_address, x); out.funds_holdings = [...fh.values()];
  console.log('fund holdings rows', out.funds_holdings.length, 'used', run.used);
  // 3) who are the Fund / Smart buyers (address-level) for (a) fund-held small caps with rising balances, (b) crash-catalog leaderboard + live-feed tokens
  const to = new Date().toISOString().slice(0, 10), from30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const targets = [];
  for (const x of out.funds_holdings.filter((x) => (x.balance_24h_percent_change || 0) > 0.02 || (x.holders_count || 0) >= 2).slice(0, 40)) targets.push({ chain: x.chain, a: x.token_address, sym: x.token_symbol, why: 'fund-held small cap' });
  let cat = {}; try { cat = JSON.parse(fs.readFileSync(path.join(DATA, 'crash_catalog_final.json'), 'utf8')); } catch {}
  for (const x of (cat.eco_tokens_ranked || []).filter((x) => CH[x.chain]).slice(0, 25)) targets.push({ chain: CH[x.chain], a: x.address, sym: x.symbol, why: 'crash catalog (eco ranked)' });
  for (const t of targets) {
    const k = t.chain + ':' + t.a; if (out.buyers[k]) continue; // top-50 buyers (unfiltered) so every labelled counterparty is harvested
    const r = await call('tgm/who-bought-sold', { chain: t.chain, token_address: t.a, buy_or_sell: 'BUY', date: { from: from30, to }, pagination: { page: 1, per_page: 50 }, order_by: [{ field: 'bought_volume_usd', direction: 'DESC' }] });
    out.buyers[k] = { ...t, rows: r.data?.data || [], err: r.error || r.skipped || null }; if (r.skipped) break;
  }
  console.log('buyers done', Object.keys(out.buyers).length, 'used', run.used);
  // 3b) which wallets are the Fund holders (tgm/holders, Fund cohort filter, 5 cr): addresses + 7d/30d balance change = accumulation evidence.
  // Free-tier labels only (premium entity names = 150 cr/call, not used): the wallet is a Nansen 'Fund' cohort member, entity unnamed.
  out.fund_holders = out.fund_holders || {};
  for (const x of out.funds_holdings) {
    const k = x.chain + ':' + x.token_address;
    const r = await call('tgm/holders', { chain: x.chain, token_address: x.token_address, label_type: 'smart_money', filters: { include_smart_money_labels: ['Fund'] }, pagination: { page: 1, per_page: 25 } });
    out.fund_holders[k] = { chain: x.chain, token: x.token_address, sym: x.token_symbol, rows: r.data?.data || [], err: r.error || r.skipped || null }; if (r.skipped) break;
  }
  // 4) Fund holdings time series per token (365d). Probe 2026-10-11: the historical Smart Money cohort no longer contains Fund wallets
  // (0 rows for 30 tokens incl. fund-held GLMR; 0 rows chain-wide with the Fund filter) -> disabled unless VCN_HIST=1.
  if (process.env.VCN_HIST === '1') {
  const hist = targets.filter((t) => ['ethereum', 'base', 'bnb', 'solana', 'robinhood'].includes(t.chain)).slice(0, 60);
  const from365 = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  for (const t of hist) {
    const k = t.chain + ':' + t.a; if (out.fund_history[k]) continue;
    const r = await call('smart-money/historical-holdings', { date_range: { from: from365, to }, chains: [t.chain], filters: { include_smart_money_labels: ['Fund'], token_address: t.a }, pagination: { page: 1, per_page: 400 }, order_by: [{ field: 'date', direction: 'ASC' }] });
    out.fund_history[k] = { ...t, rows: (r.data?.data || []).map((x) => ({ date: x.date, balance: x.balance, value_usd: x.value_usd, holders: x.holders_count, labels: x.smart_money_labels })), err: r.error || r.skipped || null };
    if (r.skipped) break;
  }
  }
  { let prev = {}; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {} for (const k of ['fund_history']) if (!Object.keys(out[k]).length && prev[k]) out[k] = prev[k]; }
  const acc2 = await fetch('https://api.nansen.ai/api/v1/account', { headers: { apikey: KEY, accept: 'application/json' } }).then((r) => r.json()).catch(() => null);
  run.balanceAfter = acc2?.credits_remaining ?? run.remaining; run.finishedAt = new Date().toISOString();
  out.credits = { used_this_run: run.used, balance_before: run.balanceBefore, balance_after: run.balanceAfter, floor: FLOOR, stopped: run.stopped, calls: run.calls.length, by_endpoint: run.calls.reduce((m, c) => { m[c.ep] = (m[c.ep] || 0) + c.used; return m; }, {}) };
  out.credits.total_all_runs = LOG.runs.reduce((a, r) => a + (r.calls || []).reduce((b, c) => b + (c.used || 0), 0), 0) + 7; // +7 = manual schema probes 2026-10-11 (tgm/holders 5, historical-holdings 2)
  fs.writeFileSync(OUT, JSON.stringify(out)); save();
  console.log(JSON.stringify(out.credits));
})().catch((e) => { console.error('fatal', e.message); save(); process.exit(1); });
