'use strict';
// Tax-lot engine: FIFO (default) / LIFO / HIFO, per-wallet (Rev. Proc. 2024-28 / Treas. Reg. 1.1012-1(j), required for
// digital assets from 2025) or universal pooling; cost basis includes fees; ST vs LT (held more than one year);
// ordinary income at FMV for staking/airdrops/rewards; wash-sale detection (IRC 1091) with disallowed loss added to the
// replacement lot's basis and holding period tacked. Pure function of (events, settings): no I/O.
const A = require('./assets');
const DAY = 86400e3;
const WASH_BILL_DATE = Date.UTC(2026, 8, 15); // H.R. 10357 sec. 301 as reported: dispositions AFTER Sep 14, 2026
const dstr = (t) => new Date(t).toISOString().slice(0, 10);
function isLongTerm(acq, sold) { const a = new Date(acq); const ann = Date.UTC(a.getUTCFullYear() + 1, a.getUTCMonth(), a.getUTCDate()); return dstr(sold) > dstr(ann); }
const r2 = (x) => Math.round(x * 100) / 100;

function washApplies(cls, ts, asset, mode) {
  if (cls === 'stock' || cls === 'option' || cls === 'tokenized_security') return { yes: true, rule: 'IRC 1091 (stock/securities, always applied)' };
  if (A.isStable(asset)) return { yes: false };
  if (mode === 'on') return { yes: true, rule: 'IRC 1091 applied to crypto (user toggle ON; not current law for crypto)' };
  if (mode === 'hr10357' && ts >= WASH_BILL_DATE) return { yes: true, rule: 'H.R. 10357 sec. 301 scenario (pending bill; dispositions after 2026-09-14)' };
  return { yes: false };
}

function run(events, settings = {}, overrides = {}) {
  const method = ['FIFO', 'LIFO', 'HIFO'].includes(settings.method) ? settings.method : 'FIFO';
  const scope = settings.scope === 'universal' ? 'universal' : 'wallet';
  const washMode = ['on', 'hr10357'].includes(settings.washCrypto) ? settings.washCrypto : 'off';
  const group = A.groupFn(settings.identicalGroups);
  const lots = new Map(); // key -> [lot]
  const disposals = [], income = [], washSales = [], review = [], feesLog = [];
  const moved = new Map(); // transfer_in id -> lots in transit
  const pendingAdj = new Map(); // acquisition event id -> [{qty, disallowed, holdingMs, saleId}]
  const used = new Map(); // acquisition event id -> qty already used as wash replacement
  let lotSeq = 0, dispSeq = 0;
  const ev = events.map((e) => ({ ...e, ...(overrides[e.id] || {}) })).filter((e) => !e.ignore);
  const byId = new Map(ev.map((e) => [e.id, e]));
  // ordering: matched transfer_in processed right after its transfer_out
  for (const e of ev) e._ord = e.ts;
  for (const e of ev) if (e.type === 'transfer_in' && e.match && byId.get(e.match)) e._ord = Math.max(e.ts, byId.get(e.match).ts) + 0.5;
  ev.sort((a, b) => a._ord - b._ord);
  const clsOf = (side) => A.classify(side.asset, side.cls);
  const key = (acct, asset) => (scope === 'wallet' ? acct : '*') + '|' + A.taxKey(asset);
  const lotsFor = (acct, asset) => { const k = key(acct, asset); if (!lots.has(k)) lots.set(k, []); return lots.get(k); };

  // acquisitions index for wash-sale replacement search (purchases only; staking/mining income excluded as in H.R. 10357)
  const acqIdx = new Map();
  for (const e of ev) if (e.type === 'trade' && e.in && !A.isFiat(e.in.asset) && e.in.qty > 0) {
    const c = clsOf(e.in); const g = group(e.in.asset, c);
    if (!acqIdx.has(g)) acqIdx.set(g, []); acqIdx.get(g).push({ id: e.id, ts: e.ts, qty: e.in.qty });
  }

  function addLot(acct, asset, cls, qty, cost, acq, src, extra = {}) {
    if (!(qty > 0)) return;
    const pend = pendingAdj.get(src);
    const list = lotsFor(acct, asset);
    if (pend && pend.length) {
      // split off the wash-replacement portions with adjusted basis + tacked holding period
      let rest = qty, restCost = cost;
      for (const p of pend.splice(0)) {
        const q = Math.min(p.qty, rest); if (q <= 0) continue;
        const c = cost * q / qty; rest -= q; restCost -= c;
        list.push({ id: ++lotSeq, asset, cls, account: acct, qty: q, cost: c + p.disallowed, acq: acq - p.holdingMs, origAcq: acq, src, washAdj: p.disallowed, ...extra });
      }
      if (rest > 1e-12) list.push({ id: ++lotSeq, asset, cls, account: acct, qty: rest, cost: restCost, acq, origAcq: acq, src, washAdj: 0, ...extra });
      return;
    }
    list.push({ id: ++lotSeq, asset, cls, account: acct, qty, cost, acq, origAcq: acq, src, washAdj: 0, ...extra });
  }
  function order(list) {
    if (method === 'FIFO') return list.slice().sort((a, b) => a.acq - b.acq || a.id - b.id);
    if (method === 'LIFO') return list.slice().sort((a, b) => b.origAcq - a.origAcq || b.id - a.id);
    return list.slice().sort((a, b) => b.cost / b.qty - a.cost / a.qty || a.acq - b.acq);
  }
  // take qty out of an account's lots (returns consumed pieces with proportional cost)
  function take(acct, asset, qty) {
    const list = lotsFor(acct, asset); const out = []; let need = qty;
    for (const lot of order(list)) {
      if (need <= 1e-12) break;
      const q = Math.min(lot.qty, need); const c = lot.cost * q / lot.qty;
      out.push({ ...lot, qty: q, cost: c });
      lot.qty -= q; lot.cost -= c; need -= q;
    }
    for (let i = list.length - 1; i >= 0; i--) if (list[i].qty <= 1e-12) list.splice(i, 1);
    return { pieces: out, short: need > 1e-9 ? need : 0 };
  }
  function dispose(e, acct, side, proceeds, kind) {
    const cls = clsOf(side);
    const { pieces, short } = take(acct, side.asset, side.qty);
    if (short && A.isStable(side.asset)) { // USD stablecoin of unknown origin: assume $1.00 basis (no fake gain), but flag it
      pieces.push({ id: 0, asset: side.asset, cls, account: acct, qty: short, cost: short, acq: e.ts, origAcq: e.ts, src: null, noBasis: false });
      review.push({ evId: e.id, ts: e.ts, kind: 'missing_lots', msg: `Spent ${fmtQ(short)} ${side.asset} in ${acct} with no recorded acquisition: assumed $1.00 basis per unit (import the deposit/purchase to confirm).` });
    } else if (short) { pieces.push({ id: 0, asset: side.asset, cls, account: acct, qty: short, cost: 0, acq: e.ts, origAcq: e.ts, src: null, noBasis: true });
      review.push({ evId: e.id, ts: e.ts, kind: 'missing_lots', msg: `Sold ${fmtQ(short)} ${side.asset} in ${acct} with no recorded acquisition: basis set to $0 (add the wallet/exchange it came from, or set a basis).` }); }
    const total = side.qty;
    for (const p of pieces) {
      const pr = proceeds * p.qty / total;
      const d = { id: ++dispSeq, evId: e.id, kind, asset: A.norm(side.asset), cls, account: acct, qty: p.qty, proceeds: pr, cost: p.cost, acq: p.acq, sold: e.ts,
        term: isLongTerm(p.acq, e.ts) ? 'LT' : 'ST', gain: pr - p.cost, adjCode: '', adj: 0, lotSrc: p.src, noBasis: !!p.noBasis, washBasisIn: p.washAdj || 0, source: e.source };
      disposals.push(d);
      if (d.gain < -0.005 && kind !== 'fee') checkWash(d);
    }
  }
  function checkWash(d) {
    const w = washApplies(d.cls, d.sold, d.asset, washMode); if (!w.yes) return;
    const g = group(d.asset, d.cls); const cands = acqIdx.get(g) || [];
    let remaining = d.qty; const loss = -d.gain;
    for (const c of cands) {
      if (remaining <= 1e-12) break;
      if (c.id === d.lotSrc || c.id === d.evId) continue;
      if (Math.abs(c.ts - d.sold) > 30 * DAY) continue;
      const avail = c.qty - (used.get(c.id) || 0); if (avail <= 1e-12) continue;
      const q = Math.min(avail, remaining);
      const disallowed = loss * q / d.qty;
      const holdingMs = Math.max(0, d.sold - d.acq);
      used.set(c.id, (used.get(c.id) || 0) + q); remaining -= q;
      d.adj += disallowed; d.adjCode = 'W';
      washSales.push({ saleEvId: d.evId, dispId: d.id, asset: d.asset, cls: d.cls, account: d.account, soldTs: d.sold, acqTs: d.acq, qtySold: d.qty, loss, replacementEvId: c.id, replacementTs: c.ts, replacementQty: q, disallowed, rule: w.rule, timing: c.ts <= d.sold ? 'bought within 30 days BEFORE the loss sale' : 'bought within 30 days AFTER the loss sale' });
      if (c.ts <= d.sold) adjustHeld(c.id, g, q, disallowed, holdingMs);
      else { if (!pendingAdj.has(c.id)) pendingAdj.set(c.id, []); pendingAdj.get(c.id).push({ qty: q, disallowed, holdingMs, saleId: d.id }); }
    }
    d.gain += d.adj;
  }
  function adjustHeld(srcId, g, qty, disallowed, holdingMs) {
    let need = qty;
    for (const [k, list] of lots) for (let i = 0; i < list.length && need > 1e-12; i++) {
      const lot = list[i]; if (lot.src !== srcId || group(lot.asset, lot.cls) !== g) continue;
      const q = Math.min(lot.qty, need); const share = disallowed * q / qty;
      if (q < lot.qty) { const c = lot.cost * q / lot.qty; list.push({ ...lot, id: ++lotSeq, qty: q, cost: c + share, acq: lot.acq - holdingMs, washAdj: (lot.washAdj || 0) + share }); lot.qty -= q; lot.cost -= c; }
      else { lot.cost += share; lot.acq -= holdingMs; lot.washAdj = (lot.washAdj || 0) + share; }
      need -= q;
    }
    if (need > 1e-9) review.push({ kind: 'wash_replacement_sold', msg: `Wash-sale replacement lot (event ${srcId}) was already sold; ${fmtQ(need)} units of disallowed-loss basis could not be carried. Review manually.` });
  }
  const fmtQ = (q) => (Math.abs(q) >= 1 ? (+q.toFixed(4)).toString() : (+q.toPrecision(4)).toString());
  function feeUsdOf(e) { if (!e.fee || !(e.fee.qty > 0)) return 0; if (e.feeUsd != null) return e.feeUsd; if (A.isFiat(e.fee.asset) || A.isStable(e.fee.asset)) return e.fee.qty; return 0; }
  function payFee(e, acct) {
    // fee paid in a crypto asset = disposal of that asset at FMV (unless already netted out of the received amount)
    if (!e.fee || !(e.fee.qty > 0) || A.isFiat(e.fee.asset) || e.fee.fromIn) return;
    const fu = feeUsdOf(e);
    dispose(e, acct, { asset: e.fee.asset, qty: e.fee.qty, cls: 'crypto' }, fu, 'fee');
    feesLog.push({ evId: e.id, ts: e.ts, asset: e.fee.asset, qty: e.fee.qty, usd: fu });
  }

  for (const e of ev) {
    const acct = e.account || 'default';
    const usd = e.usd != null ? +e.usd : null;
    const fu = feeUsdOf(e);
    if (e.type === 'trade') {
      const outF = e.out && A.isFiat(e.out.asset), inF = e.in && A.isFiat(e.in.asset);
      let value = usd;
      if (value == null) value = outF ? e.out.qty : inF ? e.in.qty : (e.out && A.isStable(e.out.asset)) ? e.out.qty : (e.in && A.isStable(e.in.asset)) ? e.in.qty : null;
      if (value == null) { review.push({ evId: e.id, ts: e.ts, kind: 'no_price', msg: `No USD value for ${e.out?.asset}->${e.in?.asset} trade on ${dstr(e.ts)}; treated as $0. Set a value.` }); value = 0; }
      // Disposal side: proceeds = FMV minus fees. Acquisition side: basis = FMV plus fees (buy with fiat) .
      if (e.out && !outF) dispose(e, acct, e.out, Math.max(0, value - (inF || !outF ? fu : 0)), 'sale');
      if (e.in && !inF) addLot(acct, e.in.asset, clsOf(e.in), e.in.qty, value + (outF ? fu : 0), e.ts, e.id, {});
      payFee(e, acct);
    } else if (e.type === 'income') {
      const v = usd ?? 0; if (usd == null) review.push({ evId: e.id, ts: e.ts, kind: 'no_price', msg: `Income ${e.in.asset} on ${dstr(e.ts)} has no FMV; set it.` });
      income.push({ evId: e.id, ts: e.ts, asset: A.norm(e.in.asset), qty: e.in.qty, usd: v, kind: e.incomeKind || 'income', account: acct, source: e.source });
      addLot(acct, e.in.asset, clsOf(e.in), e.in.qty, v, e.ts, e.id, { income: true });
    } else if (e.type === 'spend') {
      dispose(e, acct, e.out, Math.max(0, (usd ?? 0) - fu), 'spend'); payFee(e, acct);
    } else if (e.type === 'transfer_out') {
      if (A.isFiat(e.out.asset)) continue;
      const mate = e.match && byId.get(e.match);
      if (mate) {
        const recv = Math.min(mate.in.qty, e.out.qty);
        const diff = e.out.qty - recv;
        const { pieces, short } = take(acct, e.out.asset, recv);
        if (short) review.push({ evId: e.id, ts: e.ts, kind: 'missing_lots', msg: `Transferred ${fmtQ(short)} ${e.out.asset} from ${acct} with no recorded acquisition (basis $0 at destination).` });
        if (short) pieces.push({ asset: e.out.asset, cls: clsOf(e.out), qty: short, cost: 0, acq: e.ts, origAcq: e.ts, src: null, noBasis: true });
        moved.set(mate.id, pieces);
        if (diff > 1e-12) { const px = usd != null && e.out.qty ? usd / e.out.qty : (mate.usd != null && mate.in.qty ? mate.usd / mate.in.qty : 0); dispose(e, acct, { asset: e.out.asset, qty: diff, cls: clsOf(e.out) }, diff * px, 'fee'); feesLog.push({ evId: e.id, ts: e.ts, asset: e.out.asset, qty: diff, usd: diff * px, transfer: true }); }
      } else {
        take(acct, e.out.asset, e.out.qty);
        review.push({ evId: e.id, ts: e.ts, kind: 'unmatched_out', msg: `${fmtQ(e.out.qty)} ${e.out.asset} left ${acct} on ${dstr(e.ts)} to an address not in this ledger. Treated as a non-taxable move out. If it was a payment, sale or gift, reclassify it.` });
      }
      payFee(e, acct);
    } else if (e.type === 'transfer_in') {
      if (A.isFiat(e.in.asset)) continue;
      const pieces = moved.get(e.id);
      if (pieces) { for (const p of pieces) { const list = lotsFor(acct, p.asset); list.push({ ...p, id: ++lotSeq, account: acct }); } moved.delete(e.id); }
      else {
        const ov = overrides[e.id] || {};
        const basis = ov.basis != null ? +ov.basis : 0;
        addLot(acct, e.in.asset, clsOf(e.in), e.in.qty, basis, ov.acquired ? Date.parse(ov.acquired) : e.ts, e.id, { unknownBasis: ov.basis == null });
        if (ov.basis == null) review.push({ evId: e.id, ts: e.ts, kind: 'unmatched_in', msg: `${fmtQ(e.in.qty)} ${e.in.asset} arrived in ${acct} on ${dstr(e.ts)} from outside this ledger: basis $0 until you add the source wallet/exchange or set a basis (or mark it as income if it was an airdrop/reward).` });
      }
      payFee(e, acct);
    } else if (e.type === 'fee') {
      payFee({ ...e, fee: e.fee || e.out }, acct);
    }
  }
  const holdings = [];
  for (const list of lots.values()) for (const l of list) if (l.qty > 1e-12) holdings.push({ ...l });
  return { method, scope, washMode, disposals, income, washSales, review, fees: feesLog, holdings };
}

// Aggregate realized results for a calendar year
function summarize(res, year) {
  const inY = (t) => new Date(t).getUTCFullYear() === +year;
  const D = res.disposals.filter((d) => inY(d.sold));
  const s = { year: +year, count: D.length, proceeds: 0, cost: 0, washDisallowed: 0, st: { gains: 0, losses: 0, net: 0 }, lt: { gains: 0, losses: 0, net: 0 }, income: 0, incomeByKind: {} };
  for (const d of D) { s.proceeds += d.proceeds; s.cost += d.cost; s.washDisallowed += d.adj; const b = d.term === 'ST' ? s.st : s.lt; if (d.gain >= 0) b.gains += d.gain; else b.losses += d.gain; b.net += d.gain; }
  for (const i of res.income.filter((x) => inY(x.ts))) { s.income += i.usd; s.incomeByKind[i.kind] = (s.incomeByKind[i.kind] || 0) + i.usd; }
  s.netTotal = s.st.net + s.lt.net;
  for (const k of ['proceeds', 'cost', 'washDisallowed', 'income', 'netTotal']) s[k] = r2(s[k]);
  for (const b of [s.st, s.lt]) for (const k of Object.keys(b)) b[k] = r2(b[k]);
  return s;
}
module.exports = { run, summarize, isLongTerm, washApplies, WASH_BILL_DATE, dstr };
