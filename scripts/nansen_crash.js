// One-off, user-approved (2026-10-11): Nansen crash-window wallet forensics for the top crashes. HARD cap 80 credits.
// Key from env only; never printed. Raw responses -> data/nansen_crash_raw.json
'use strict';
const fs = require('fs'); const KEY = process.env.NANSEN_API_KEY; if (!KEY) { console.log('no key'); process.exit(1); }
const CAP = 80; let used = +(process.env.ALREADY_USED || 0); const log = []; // earlier aborted-run credits count toward the cap
async function call(ep, body, method = 'POST', est = 1) {
  if (used + est > CAP) { log.push({ ep, skipped: 'cap' }); return { skipped: 'cap' }; }
  const r = await fetch('https://api.nansen.ai/api/v1/' + ep, { method, headers: { apikey: KEY, 'content-type': 'application/json', accept: 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000) }).catch((e) => ({ ok: false, status: 0, headers: new Map(), json: async () => ({ error: e.message }) }));
  const u = +(r.headers.get('x-nansen-credits-used') || 0); used += u; const rem = r.headers.get('x-nansen-credits-remaining') ?? null;
  const j = await r.json().catch(() => null); log.push({ ep, status: r.status, used: u, remaining: rem, body: method === 'POST' ? body : null });
  if (!r.ok) return { error: r.status + ' ' + JSON.stringify(j).slice(0, 300) };
  return { data: j };
}
const T = [
  { sym: 'LAB', chain: 'bnb', a: '0x7ec43cf65f1663f820427c62a5780b8f2e25593a', from: '2026-06-24', to: '2026-07-10', tfrom: '2026-06-28', minUsd: 100000 },
  { sym: 'VELVET', chain: 'bnb', a: '0x8b194370825e37b33373e74a41009161808c1488', from: '2026-06-26', to: '2026-07-05' },
  { sym: 'SIREN', chain: 'bnb', a: '0x997a58129890bbda032231a52ed1ddc845fc18e1', from: '2026-03-21', to: '2026-04-02' },
  { sym: 'ALLINU', chain: 'solana', a: '4MMQY9bwkxxTtsK3W227Q5ABT6yFY8Pmn9Ze7wmAXKY8', from: '2026-09-13', to: '2026-09-25' },
  { sym: 'STONK', chain: 'solana', a: '6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx', from: '2026-09-18', to: '2026-10-02' },
  { sym: 'ANSEM', chain: 'solana', a: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump', from: '2026-07-04', to: '2026-07-14' },
];
(async () => {
  const out = { startedAt: new Date().toISOString(), tokens: {} };
  const acc0 = await call('account', null, 'GET', 0); out.accountBefore = acc0.data ? { credits_remaining: acc0.data.credits_remaining, plan: acc0.data.plan } : acc0;
  for (const t of T) {
    const o = out.tokens[t.sym] = { ...t };
    o.sellers = await call('tgm/who-bought-sold', { chain: t.chain, token_address: t.a, buy_or_sell: 'SELL', date: { from: t.from, to: t.to }, pagination: { page: 1, per_page: 25 }, order_by: [{ field: 'sold_volume_usd', direction: 'DESC' }] });
    o.transfers = await call('tgm/transfers', { chain: t.chain, token_address: t.a, date: { from: t.tfrom || t.from, to: t.to }, pagination: { page: 1, per_page: 100 }, filters: { include_cex: true, include_dex: false, non_exchange_transfers: true, transfer_value_usd: { min: t.minUsd || 10000 } }, order_by: [{ field: 'transfer_value_usd', direction: 'DESC' }] });
    fs.writeFileSync(__dirname + '/../data/nansen_crash_raw.json', JSON.stringify({ ...out, creditsUsedByHeaders: used, calls: log }));
    console.log(t.sym, 'sellers', o.sellers.error || o.sellers.skipped || (o.sellers.data?.data || []).length, 'transfers', o.transfers.error || o.transfers.skipped || (o.transfers.data?.data || []).length, 'credits so far', used);
  }
  const acc1 = await call('account', null, 'GET', 0); out.accountAfter = acc1.data ? { credits_remaining: acc1.data.credits_remaining, plan: acc1.data.plan } : acc1;
  out.creditsUsedByHeaders = used; out.calls = log;
  fs.writeFileSync(__dirname + '/../data/nansen_crash_raw.json', JSON.stringify(out));
  console.log('before', JSON.stringify(out.accountBefore), 'after', JSON.stringify(out.accountAfter), 'used', used);
})();
