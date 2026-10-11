'use strict';
// Internal-transfer matcher: pairs a transfer_out from one of your accounts/wallets with a transfer_in to another
// of your accounts, so moving coins between your own wallets/exchanges is NOT treated as a sale + new purchase.
// Match rules (in order): identical on-chain txid; else same asset, received qty within [sent*(1-tol), sent],
// arrival within -2h..+72h of departure. Leftover difference = network fee (disposed by the lot engine).
const { taxKey } = require('./assets');
const H = 3600e3;
function matchTransfers(events, { tol = 0.02, before = 2 * H, after = 72 * H } = {}) {
  for (const e of events) if (e.type === 'transfer_out' || e.type === 'transfer_in') { if (!e.matchManual) delete e.match; }
  const outs = events.filter((e) => e.type === 'transfer_out' && !e.match);
  const ins = events.filter((e) => e.type === 'transfer_in' && !e.match);
  const byId = new Map(events.map((e) => [e.id, e]));
  // manual pairs first
  for (const e of events) if (e.matchManual && byId.get(e.matchManual)) { const o = byId.get(e.matchManual); e.match = o.id; o.match = e.id; }
  const norm = (h) => String(h || '').toLowerCase().replace(/^0x/, '');
  let n = 0;
  // 1) txid
  const inByTx = new Map(); for (const i of ins) if (i.txid && !i.match) inByTx.set(norm(i.txid) + '|' + taxKey(i.in.asset), i);
  for (const o of outs) {
    if (o.match || !o.txid) continue;
    const i = inByTx.get(norm(o.txid) + '|' + taxKey(o.out.asset));
    if (i && !i.match && i.account !== o.account) { o.match = i.id; i.match = o.id; o.matchBy = i.matchBy = 'txid'; n++; }
  }
  // 2) amount + time window, greedy by closest time then closest amount
  for (const o of outs) {
    if (o.match) continue;
    const k = taxKey(o.out.asset), q = o.out.qty;
    let best = null, bestScore = Infinity;
    for (const i of ins) {
      if (i.match || i.account === o.account || taxKey(i.in.asset) !== k) continue;
      const dt = i.ts - o.ts; if (dt < -before || dt > after) continue;
      const r = i.in.qty / q; if (r > 1 + 1e-9 || r < 1 - tol) continue;
      const score = Math.abs(dt) / H + (1 - r) * 100;
      if (score < bestScore) { best = i; bestScore = score; }
    }
    if (best) { o.match = best.id; best.match = o.id; o.matchBy = best.matchBy = 'amount+time'; n++; }
  }
  return n;
}
module.exports = { matchTransfers };
