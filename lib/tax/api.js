'use strict';
// HTTP glue for the Tax desk. Mounted from server.js with one line (like lib/tradeapi.js). All routes under /api/tax/.
// Privacy: ledger + uploads live only in data/tax (0700/0600, gitignored). Routes refuse to serve unless the site
// password gate is enabled (SITE_PASSWORD) or the request comes from localhost (or TAX_ALLOW_OPEN=1 is set).
const store = require('./store');
const T = require('./index');
const L = require('./lots');
const csv = require('./csv');
const chain = require('./chain');
const prices = require('./prices');
const sample = require('./sample');
const TB = require('./tables');
const A = require('./assets');
let auth = null; try { auth = require('../auth'); } catch {}
let portfolio = null; try { portfolio = require('../portfolio'); } catch {}

const jobs = new Map(); let jobSeq = 0;
function job(kind, fn) {
  const id = 't' + (++jobSeq) + '-' + Date.now().toString(36); const j = { id, kind, status: 'running', progress: '', startedAt: Date.now(), result: null, error: null };
  jobs.set(id, j);
  Promise.resolve().then(() => fn((m) => { j.progress = m; })).then((r) => { j.status = 'done'; j.result = r; }, (e) => { j.status = 'error'; j.error = String(e.message || e); });
  for (const [k, v] of jobs) if (Date.now() - v.startedAt > 6 * 3600e3) jobs.delete(k);
  return j;
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const yearOf = (q, d) => +(q.get('year') || d.settings.year || 2026);
function view(r, year) {
  return {
    year, summary: r.summary, estimate: r.estimate, exposure: r.exposure, law: r.law, method: r.res.method, scope: r.res.scope, washMode: r.res.washMode,
    rows: T.report.rows8949(r.res, year), washSales: r.res.washSales.map((w) => ({ ...w, sold: L.dstr(w.soldTs), rebought: L.dstr(w.replacementTs) })),
    income: r.res.income.filter((i) => new Date(i.ts).getUTCFullYear() === year).map((i) => ({ ...i, date: L.dstr(i.ts) })),
    holdings: aggHoldings(r.res.holdings), review: r.res.review.slice(0, 300), reviewCount: r.res.review.length,
  };
}
function aggHoldings(h) {
  const m = {}; for (const l of h) { const k = l.account + '|' + l.asset; m[k] ||= { account: l.account, asset: A.norm(l.asset), cls: l.cls, qty: 0, cost: 0, lots: 0, washAdj: 0, unknownBasis: false }; const x = m[k]; x.qty += l.qty; x.cost += l.cost; x.lots++; x.washAdj += l.washAdj || 0; if (l.unknownBasis || l.noBasis) x.unknownBasis = true; }
  return Object.values(m).sort((a, b) => b.cost - a.cost);
}
function computeLedger(d, extra = {}) { T.matchTransfers(d.events); return T.compute(d.events, d.settings, d.overrides, extra); }
async function livePrices(d, req) {
  const out = {}; const sources = {}; const reconcile = [];
  if (portfolio) for (const w of d.wallets) {
    try {
      const r = w.kind === 'solana' ? await portfolio.solWallet(w.address, req) : w.kind === 'evm' ? await portfolio.evmWallet(w.address) : null;
      for (const p of r?.positions || []) { const s = A.norm(p.symbol); if (p.priceUsd != null && p.valueUsd != null && out[s] == null) { out[s] = p.priceUsd; sources[s] = 'portfolio module (' + (p.chain || w.kind) + ')'; }
        reconcile.push({ account: `${p.chain || w.kind}:${w.kind === 'evm' ? w.address.toLowerCase() : w.address}`, asset: s, onchain: p.amount }); }
    } catch (e) { sources['_err_' + w.address] = e.message; }
  }
  return { out, sources, reconcile };
}
const GET = {
  '/api/tax/law': () => ({ ...T.LAW, tables: { 2026: TB.table(2026), 2025: TB.table(2025) }, niit: TB.NIIT, lossLimit: TB.LOSS_LIMIT, statuses: TB.STATUSES,
    optionalPaid: [{ name: 'Keeper Tax', cost: '$20/mo bookkeeping only; $199/yr Standard (filing); $399/yr Premium (keepertax.com/pricing, checked 2026-10-11)' }, { name: 'TaxGPT', cost: 'Pro / Pro Plus / Enterprise: contact sales (third-party reviews cite from ~$49/mo for preparers); aimed at tax firms' }, { name: 'Koinly / CoinTracker', cost: 'free import; paid tax reports roughly $49-$599/yr depending on transaction count (verify on vendor site)' }, { name: 'Helius RPC', cost: 'free tier 1M credits/mo (used only if HELIUS_API_KEY is already set)' }, { name: 'Etherscan API V2', cost: 'free key (Ethereum/Arbitrum/Polygon...); Base/BSC/OP need Lite plan ~$49/mo' }],
    note: 'Paid services are listed for reference only and are NOT integrated. Prices approximate as published; verify on vendor sites.' }),
  '/api/tax/state': () => { const d = store.load(); const n = d.events.length;
    return { settings: d.settings, wallets: d.wallets, imports: d.imports.slice(-30), eventCount: n, events: d.events.slice(-400).reverse().map((e) => ({ ...pick(e, ['id', 'ts', 'type', 'account', 'source', 'out', 'in', 'usd', 'fee', 'feeUsd', 'txid', 'note', 'match', 'matchBy', 'incomeKind', 'priceSource']), override: d.overrides[e.id] || null })), missingUsd: d.events.filter((e) => e.usd == null && e.type !== 'fee').length, storage: 'data/tax (private, 0600)', heliusKey: !!process.env.HELIUS_API_KEY, etherscanKey: !!process.env.ETHERSCAN_API_KEY }; },
  '/api/tax/compute': (q) => { const d = store.load(); const y = yearOf(q, d); const r = computeLedger(d); return view(r, y); },
  '/api/tax/harvest': async (q, req) => {
    const d = store.load(); const y = yearOf(q, d); const base = computeLedger(d);
    const syms = [...new Set(base.res.holdings.map((h) => A.norm(h.asset)))];
    const lp = await livePrices(d, req); const px = { ...lp.out };
    const need = syms.filter((s) => px[s] == null && A.classify(s) === 'crypto');
    Object.assign(px, await prices.spot(need));
    for (const [k, v] of Object.entries(JSON.parse(q.get('prices') || '{}'))) px[A.norm(k)] = +v; // manual overrides (stocks/options)
    const r = T.compute(d.events, d.settings, d.overrides, { prices: px });
    const held = aggHoldings(r.res.holdings);
    const recon = lp.reconcile.map((x) => { const h = held.find((z) => z.account === x.account && z.asset === x.asset); return { ...x, ledger: h ? h.qty : 0, diff: x.onchain - (h ? h.qty : 0) }; }).filter((x) => Math.abs(x.diff) > Math.max(1e-6, x.onchain * 0.01));
    return { ...r.harvest, allLots: undefined, prices: px, priceSources: lp.sources, reconcile: recon.slice(0, 100) };
  },
  '/api/tax/sync/status': (q) => { const j = jobs.get(q.get('job') || ''); if (!j) throw Object.assign(new Error('unknown job'), { status: 404 }); return j; },
  '/api/tax/sample': () => { const ev = sample.events(); const r = T.compute(ev, sample.SETTINGS, {}, { prices: sample.PRICES, now: sample.NOW }); return { EXAMPLE_DATA: true, settings: sample.SETTINGS, ...view(r, 2026), harvest: { ...r.harvest, allLots: undefined } }; },
};
const FILES = {
  '/api/tax/export.csv': (q) => { const d = store.load(); const y = yearOf(q, d); const r = computeLedger(d); return { type: 'text/csv; charset=utf-8', name: `form8949_${y}.csv`, body: T.report.csv8949(r.res, y) }; },
  '/api/tax/export.pdf': async (q, req) => { const d = store.load(); const y = yearOf(q, d); const base = computeLedger(d);
    let harvest = null; try { const px = await prices.spot([...new Set(base.res.holdings.map((h) => A.norm(h.asset)))].filter((s) => A.classify(s) === 'crypto').slice(0, 40)); harvest = T.compute(d.events, d.settings, d.overrides, { prices: px }).harvest; } catch {}
    const { pdf } = T.report.pdfReport(base.res, { year: y, settings: d.settings, harvest, law: { washText: T.LAW.washCurrent + ' ' + T.LAW.washPending, pendingExposure: base.exposure.amount } });
    return { type: 'application/pdf', name: `tax_report_${y}.pdf`, body: pdf }; },
  '/api/tax/sample.pdf': () => { const ev = sample.events(); const r = T.compute(ev, sample.SETTINGS, {}, { prices: sample.PRICES, now: sample.NOW }); return { type: 'application/pdf', name: 'EXAMPLE_tax_report_2026.pdf', body: T.report.pdfReport(r.res, { year: 2026, settings: sample.SETTINGS, harvest: r.harvest, example: true, title: 'EXAMPLE Crypto & Securities Tax Report', law: { washText: T.LAW.washCurrent + ' ' + T.LAW.washPending, pendingExposure: r.exposure.amount } }).pdf }; },
  '/api/tax/sample.csv': () => { const r = T.compute(sample.events(), sample.SETTINGS, {}, {}); return { type: 'text/csv; charset=utf-8', name: 'EXAMPLE_form8949_2026.csv', body: T.report.csv8949(r.res, 2026, { example: true }) }; },
};
const SETTING_KEYS = ['method', 'scope', 'washCrypto', 'year', 'filingStatus', 'otherIncome', 'qualifiedDividends', 'stCarryover', 'ltCarryover', 'identicalGroups'];
const POST = {
  '/api/tax/settings': (b) => { const d = store.load(); for (const k of SETTING_KEYS) if (b[k] !== undefined) d.settings[k] = ['year', 'otherIncome', 'qualifiedDividends', 'stCarryover', 'ltCarryover'].includes(k) ? +b[k] || 0 : String(b[k]).slice(0, 2000); store.save(d); return { settings: d.settings }; },
  '/api/tax/wallets': (b) => {
    const d = store.load(); const added = [];
    const list = (Array.isArray(b.addresses) ? b.addresses : String(b.addresses || '').split(/[\s,;]+/)).map((s) => s.trim()).filter(Boolean).slice(0, 50);
    for (const a of list) { const kinds = chain.detectChains(a); if (!kinds.length) continue; const kind = kinds[0] === 'solana' ? 'solana' : 'evm';
      if (d.wallets.some((w) => w.address.toLowerCase() === a.toLowerCase())) continue;
      const w = { address: a, kind, label: String(b.label || '').slice(0, 60), chains: kind === 'evm' ? (Array.isArray(b.chains) && b.chains.length ? b.chains.filter((c) => chain.EVM[c]) : ['ethereum', 'base', 'arbitrum', 'bsc']) : ['solana'], addedAt: Date.now() };
      d.wallets.push(w); added.push(w); }
    if (Array.isArray(b.remove)) d.wallets = d.wallets.filter((w) => !b.remove.includes(w.address));
    store.save(d); return { wallets: d.wallets, added: added.length };
  },
  '/api/tax/sync': (b) => {
    const max = Math.min(+b.max || 300, 5000); const only = b.address;
    const j = job('sync', async (prog) => {
      const d0 = store.load(); const report = [];
      for (const w of d0.wallets.filter((w) => !only || w.address === only)) {
        for (const c of w.chains) {
          prog(`${c} ${w.address.slice(0, 6)}...`);
          try {
            const r = c === 'solana' ? await chain.solanaHistory(w.address, { max, onProgress: (m) => prog(`solana ${w.address.slice(0, 6)}: ${m}`) }) : await chain.evmHistory(c, w.address, { max });
            prog(`${c}: pricing ${r.events.length} events`);
            const pf = await prices.fillValues(r.events, { budget: +b.priceBudget || 300 });
            const d = store.load(); const added = store.addEvents(d, r.events, { kind: 'chain', chain: c, address: w.address, provider: r.provider || r.rpc }); w.syncedAt = Date.now();
            const ww = d.wallets.find((x) => x.address === w.address); if (ww) ww.syncedAt = Date.now(); store.save(d);
            report.push({ chain: c, address: w.address, events: r.events.length, added, priced: pf.filled, priceBudgetHit: pf.budgetHit, provider: r.provider || r.rpc, truncated: r.truncated, counts: r.counts });
          } catch (e) { report.push({ chain: c, address: w.address, error: e.message }); }
        }
      }
      return { report };
    });
    return { job: j.id };
  },
  '/api/tax/fillprices': (b) => { const j = job('prices', async (prog) => { const d = store.load(); prog('looking up historical prices'); const r = await prices.fillValues(d.events, { budget: Math.min(+b.budget || 300, 2000) }); store.save(d); return r; }); return { job: j.id }; },
  '/api/tax/import': (b) => {
    const text = String(b.csv || ''); if (!text.trim()) throw Object.assign(new Error('empty CSV'), { status: 400 });
    if (text.length > 15e6) throw Object.assign(new Error('CSV too large (15 MB max)'), { status: 413 });
    const r = csv.importCSV(text, { format: b.format, account: b.account ? String(b.account).slice(0, 80) : undefined, mapping: b.mapping, owner: b.owner, chain: b.chain });
    if (r.format.startsWith('explorer')) r.events = csv.mergeSwaps(r.events);
    if (b.preview) return { format: r.format, count: r.events.length, sample: r.events.slice(0, 15), warnings: r.warnings.slice(0, 30), columns: r.columns, mapped: r.mapped };
    const d = store.load(); const added = store.addEvents(d, r.events, { kind: 'csv', format: r.format, account: b.account || r.format, file: String(b.filename || '').slice(0, 120), rows: r.events.length });
    const matched = T.matchTransfers(d.events); store.save(d);
    return { format: r.format, parsed: r.events.length, added, duplicates: r.events.length - added, transfersMatched: matched, warnings: r.warnings.slice(0, 30), mapped: r.mapped };
  },
  '/api/tax/override': (b) => { const d = store.load(); if (!d.events.some((e) => e.id === b.id)) throw Object.assign(new Error('unknown event'), { status: 404 });
    if (b.clear) delete d.overrides[b.id]; else { const o = { ...(d.overrides[b.id] || {}) }; for (const k of ['type', 'usd', 'basis', 'acquired', 'ignore', 'incomeKind', 'cls', 'matchManual']) if (b[k] !== undefined) o[k] = k === 'usd' || k === 'basis' ? +b[k] : b[k]; d.overrides[b.id] = o;
      if (b.matchManual) { const e = d.events.find((x) => x.id === b.id); e.matchManual = b.matchManual; const m = d.events.find((x) => x.id === b.matchManual); if (m) m.matchManual = b.id; } }
    store.save(d); return { ok: true, override: d.overrides[b.id] || null }; },
  '/api/tax/reset': (b) => { if (b.confirm !== 'DELETE') throw Object.assign(new Error('send {"confirm":"DELETE"} to wipe the private tax ledger'), { status: 400 }); const d = store.EMPTY(); d.settings = { ...d.settings, ...(store.load().settings) }; store.save(d); return { ok: true }; },
};
function allowed(req) {
  if (auth && auth.ENABLED) return true; // auth.gate already rejected unauthenticated requests
  if (process.env.TAX_ALLOW_OPEN === '1') return true;
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  return !req.headers['x-forwarded-for'] && (ip === '127.0.0.1' || ip === '::1');
}
function readBody(req, max = 16e6) {
  return new Promise((resolve, reject) => { const ch = []; let n = 0; req.on('data', (c) => { n += c.length; if (n > max) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else ch.push(c); }); req.on('end', () => { try { resolve(n ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } }); req.on('error', reject); });
}
const owns = (p) => p.startsWith('/api/tax/');
async function handle(req, res, u) {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }); res.end(JSON.stringify(obj)); };
  if (!allowed(req)) return send(403, { error: 'Tax desk is private: enable the site password (SITE_PASSWORD) or use it from localhost.' });
  try {
    if (req.method === 'GET' && FILES[u.pathname]) { const f = await FILES[u.pathname](u.searchParams, req); res.writeHead(200, { 'content-type': f.type, 'content-disposition': `attachment; filename="${f.name}"`, 'cache-control': 'no-store' }); return res.end(f.body); }
    const table = req.method === 'POST' ? POST : req.method === 'GET' ? GET : null; const h = table && table[u.pathname];
    if (!h) return send(table ? 404 : 405, { error: 'not found' });
    const arg = req.method === 'POST' ? await readBody(req) : u.searchParams;
    send(200, await h(arg, req));
  } catch (e) { send(e.status || 500, { error: String(e.message || e) }); }
}
module.exports = { owns, handle, GET, POST };
