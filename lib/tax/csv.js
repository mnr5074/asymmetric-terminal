'use strict';
// CSV import: RFC-4180 parser + exchange-specific normalizers (Coinbase, Kraken, Binance.US, Etherscan-family explorer
// exports for BaseScan/BscScan/etc.) + a generic column mapper. Output: normalized ledger events (see lots.js).
const A = require('./assets');
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  text = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}
const num = (s) => { if (s == null) return null; const t = String(s).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1'); if (t === '' || t === '-') return null; const n = Number(t); return isFinite(n) ? n : null; };
const ts = (s) => { if (s == null || s === '') return NaN; const t = String(s).trim(); if (/^\d{10}$/.test(t)) return +t * 1000; if (/^\d{13}$/.test(t)) return +t;
  let x = t.replace(' UTC', 'Z').replace(/^(\d{4}-\d\d-\d\d) (\d)/, '$1T$2'); if (/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(x)) x += 'Z'; const v = Date.parse(x); return isNaN(v) ? Date.parse(t) : v; };
// find header row (exports often have a preamble) and return array of objects keyed by trimmed header
function table(text, mustHave) {
  const rows = parseCSV(text);
  let h = rows.findIndex((r) => mustHave.every((m) => r.some((c) => c.trim().toLowerCase() === m.toLowerCase())));
  if (h < 0) h = 0;
  const head = rows[h].map((c) => c.trim());
  return rows.slice(h + 1).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] != null ? String(r[i]).trim() : ''])));
}
function detect(text) {
  const head = parseCSV(String(text).slice(0, 20000)).slice(0, 12).map((r) => r.map((c) => c.trim().toLowerCase()).join('|')).join('\n');
  if (/transaction type/.test(head) && /quantity transacted/.test(head)) return 'coinbase';
  if (/refid/.test(head) && /aclass|asset/.test(head) && /amount/.test(head) && /fee/.test(head)) return 'kraken_ledgers';
  if (/ordertxid/.test(head) && /pair/.test(head) && /vol/.test(head)) return 'kraken_trades';
  if (/primary_asset/.test(head) && /realized_amount_for_primary_asset/.test(head)) return 'binanceus_tax';
  if (/date\(utc\)/.test(head) && /pair|market/.test(head) && /executed|amount/.test(head)) return 'binanceus_trades';
  if (/transaction hash/.test(head) && /tokensymbol|token symbol/.test(head)) return 'explorer_tokens';
  if (/transaction hash/.test(head) && /value_in|value_out/.test(head)) return 'explorer_native';
  return 'generic';
}
const ev = (o) => ({ cls: undefined, ...o });

// ---------- Coinbase (Transaction history report, 2023-2026 layouts) ----------
function coinbase(text, account = 'coinbase') {
  const rows = table(text, ['Timestamp', 'Transaction Type']);
  const out = []; const warn = [];
  for (const r of rows) {
    const t = ts(r.Timestamp); if (isNaN(t)) continue;
    const type = (r['Transaction Type'] || '').toLowerCase();
    const asset = A.norm(r.Asset); const qty = Math.abs(num(r['Quantity Transacted']) || 0);
    const cur = A.norm(r['Price Currency'] || r['Spot Price Currency'] || 'USD');
    const px = num(r['Price at Transaction'] ?? r['Spot Price at Transaction']);
    const sub = Math.abs(num(r.Subtotal) ?? (px != null ? px * qty : 0));
    const fee = Math.abs(num(r['Fees and/or Spread'] ?? r.Fees) || 0);
    const notes = r.Notes || '';
    const base = { source: 'coinbase', account, ts: t, txid: r.ID || '', note: `${r['Transaction Type']}: ${notes}`.slice(0, 200) };
    const fmv = px != null ? px * qty : sub;
    if (/^(advanced trade )?buy$|^buy$/.test(type)) out.push(ev({ ...base, type: 'trade', out: { asset: cur, qty: sub }, in: { asset, qty }, usd: sub, fee: fee ? { asset: cur, qty: fee } : null, feeUsd: fee }));
    else if (/^(advanced trade )?sell$/.test(type)) out.push(ev({ ...base, type: 'trade', out: { asset, qty }, in: { asset: cur, qty: sub }, usd: sub, fee: fee ? { asset: cur, qty: fee } : null, feeUsd: fee }));
    else if (type === 'convert') {
      const m = notes.match(/Converted\s+([\d.,]+)\s+(\S+)\s+to\s+([\d.,]+)\s+(\S+)/i);
      if (m) out.push(ev({ ...base, type: 'trade', out: { asset: A.norm(m[2]), qty: num(m[1]) }, in: { asset: A.norm(m[4]), qty: num(m[3]) }, usd: sub || fmv, fee: fee ? { asset: 'USD', qty: fee } : null, feeUsd: fee }));
      else warn.push('Convert row without parsable notes at ' + r.Timestamp);
    }
    else if (/staking income|rewards income|inflation reward|coinbase earn|learning reward|interest|reward/.test(type)) out.push(ev({ ...base, type: 'income', in: { asset, qty }, usd: fmv, incomeKind: /staking|inflation/.test(type) ? 'staking' : /earn|learning/.test(type) ? 'reward' : 'reward' }));
    else if (/airdrop/.test(type)) out.push(ev({ ...base, type: 'income', in: { asset, qty }, usd: fmv, incomeKind: 'airdrop' }));
    else if (/^send$|withdraw/.test(type)) { if (!A.isFiat(asset)) out.push(ev({ ...base, type: 'transfer_out', out: { asset, qty }, usd: fmv, txid: (notes.match(/0x[0-9a-f]{64}|[1-9A-HJ-NP-Za-km-z]{80,90}/i) || [r.ID])[0] })); }
    else if (/^receive$|deposit/.test(type)) { if (!A.isFiat(asset)) out.push(ev({ ...base, type: 'transfer_in', in: { asset, qty }, usd: fmv })); }
    else if (/staking transfer|unstaking transfer/.test(type)) { /* internal move between Coinbase sub-accounts: no tax event */ }
    else warn.push(`Unrecognized Coinbase type "${r['Transaction Type']}" (${r.Timestamp}) skipped`);
  }
  return { events: out, warnings: warn };
}

// ---------- Kraken ledgers.csv (preferred: has every balance change) ----------
function krakenLedgers(text, account = 'kraken') {
  const rows = table(text, ['refid', 'asset', 'amount']);
  const out = []; const warn = []; const byRef = {};
  for (const r of rows) { (byRef[r.refid] ||= []).push(r); }
  for (const [ref, rs] of Object.entries(byRef)) {
    const t = ts(rs[0].time); if (isNaN(t)) continue;
    const type = (rs[0].type || '').toLowerCase();
    const base = { source: 'kraken', account, ts: t, txid: ref };
    if ((type === 'trade' || type === 'spend' || type === 'receive') && rs.length >= 2) {
      const neg = rs.find((r) => num(r.amount) < 0), pos = rs.find((r) => num(r.amount) > 0);
      if (!neg || !pos) { warn.push('Kraken trade ' + ref + ' incomplete'); continue; }
      const feeRow = rs.find((r) => num(r.fee) > 0);
      const oa = A.norm(neg.asset), ia = A.norm(pos.asset);
      const oq = -num(neg.amount), iq = num(pos.amount);
      let fee = null; if (feeRow) { const fa = A.norm(feeRow.asset); fee = { asset: fa, qty: num(feeRow.fee), fromIn: fa === ia }; }
      const usd = A.isFiat(oa) ? oq : A.isFiat(ia) ? iq : null;
      // Kraken deducts the fee from the balance of the fee asset: received amount in ledger is gross; net it.
      const inQty = fee && fee.fromIn ? iq - fee.qty : iq;
      const feeUsd = fee ? (A.isFiat(fee.asset) ? fee.qty : usd != null && fee.asset === oa ? usd * fee.qty / oq : usd != null && fee.asset === ia ? usd * fee.qty / iq : null) : null;
      const outQty = fee && fee.asset === oa && !A.isFiat(oa) ? oq : oq; // fee charged in out-asset is an extra disposal (handled by engine)
      out.push(ev({ ...base, type: 'trade', out: { asset: oa, qty: outQty }, in: { asset: ia, qty: inQty }, usd, fee, feeUsd }));
    } else if (type === 'deposit' || type === 'withdrawal') {
      for (const r of rs) { const a = A.norm(r.asset), q = Math.abs(num(r.amount)); if (A.isFiat(a) || !q) continue;
        out.push(ev({ ...base, type: type === 'deposit' ? 'transfer_in' : 'transfer_out', [type === 'deposit' ? 'in' : 'out']: { asset: a, qty: type === 'withdrawal' ? q : q - (num(r.fee) || 0) }, fee: type === 'withdrawal' && num(r.fee) ? { asset: a, qty: num(r.fee) } : null })); }
    } else if (['staking', 'earn', 'reward', 'dividend', 'airdrop'].includes(type) || (type === 'earn' && /reward/.test(rs[0].subtype))) {
      for (const r of rs) { const q = num(r.amount); if (q > 0 && !(rs[0].subtype || '').match(/migration|allocation|deallocation|auto/)) out.push(ev({ ...base, type: 'income', in: { asset: A.norm(r.asset), qty: q - (num(r.fee) || 0) }, usd: null, incomeKind: type === 'airdrop' ? 'airdrop' : 'staking' })); }
    } else if (type === 'transfer' || type === 'margin' || type === 'rollover' || type === 'adjustment') { if (type === 'margin' || type === 'rollover') warn.push(`Kraken ${type} ${ref} skipped (margin trading not modeled)`); }
    else warn.push(`Kraken type "${type}" (${ref}) skipped`);
  }
  return { events: out.sort((a, b) => a.ts - b.ts), warnings: warn };
}
// ---------- Kraken trades.csv (fallback) ----------
const KQUOTES = ['ZUSD', 'USD', 'USDT', 'USDC', 'ZEUR', 'EUR', 'XXBT', 'XBT', 'XETH', 'ETH'];
function krakenTrades(text, account = 'kraken') {
  const rows = table(text, ['ordertxid', 'pair']);
  const out = [];
  for (const r of rows) {
    const t = ts(r.time); const pair = (r.pair || '').toUpperCase().replace('/', '');
    const qn = KQUOTES.find((q) => pair.endsWith(q)); if (!qn) continue;
    const b = A.norm(pair.slice(0, pair.length - qn.length)), q = A.norm(qn);
    const vol = num(r.vol), cost = num(r.cost), fee = num(r.fee) || 0;
    const buy = (r.type || '').toLowerCase() === 'buy';
    out.push(ev({ source: 'kraken', account, ts: t, txid: r.txid, type: 'trade', out: buy ? { asset: q, qty: cost } : { asset: b, qty: vol }, in: buy ? { asset: b, qty: vol } : { asset: q, qty: cost - fee }, usd: A.isFiat(q) ? cost : null, fee: fee ? { asset: q, qty: fee, fromIn: !buy } : null, feeUsd: A.isFiat(q) ? fee : null }));
  }
  return { events: out, warnings: [] };
}

// ---------- Binance.US ----------
function binanceTax(text, account = 'binanceus') {
  const rows = table(text, ['Primary_Asset', 'Operation']);
  const out = []; const warn = [];
  for (const r of rows) {
    const t = ts(r.Time); if (isNaN(t)) continue;
    const cat = (r.Category || '').toLowerCase(), op = (r.Operation || '').toLowerCase();
    const base = { source: 'binanceus', account, ts: t, txid: r.Transaction_Id || r.Order_Id || '' };
    const fee = num(r.Realized_Amount_For_Fee_Asset) ? { asset: A.norm(r.Fee_Asset), qty: num(r.Realized_Amount_For_Fee_Asset) } : null;
    const feeUsd = num(r.Realized_Amount_For_Fee_Asset_In_USD_Value);
    if (/buy|sell/.test(op) || cat === 'spot trading' || cat === 'quick buy' || cat === 'quick sell') {
      const bA = A.norm(r.Base_Asset), bQ = num(r.Realized_Amount_For_Base_Asset), qA = A.norm(r.Quote_Asset), qQ = num(r.Realized_Amount_For_Quote_Asset);
      const usd = num(r.Realized_Amount_For_Quote_Asset_In_USD_Value) ?? num(r.Realized_Amount_For_Base_Asset_In_USD_Value);
      const sell = /sell/.test(op);
      if (bA && qA) out.push(ev({ ...base, type: 'trade', out: sell ? { asset: bA, qty: bQ } : { asset: qA, qty: qQ }, in: sell ? { asset: qA, qty: qQ } : { asset: bA, qty: bQ }, usd, fee, feeUsd }));
    } else if (/deposit/.test(op)) { const a = A.norm(r.Primary_Asset); if (!A.isFiat(a)) out.push(ev({ ...base, type: 'transfer_in', in: { asset: a, qty: num(r.Realized_Amount_For_Primary_Asset) }, usd: num(r.Realized_Amount_For_Primary_Asset_In_USD_Value) })); }
    else if (/withdraw/.test(op)) { const a = A.norm(r.Primary_Asset); if (!A.isFiat(a)) out.push(ev({ ...base, type: 'transfer_out', out: { asset: a, qty: num(r.Realized_Amount_For_Primary_Asset) }, usd: num(r.Realized_Amount_For_Primary_Asset_In_USD_Value), fee, feeUsd })); }
    else if (/staking|reward|distribution|airdrop|referral|interest/.test(op + ' ' + cat)) out.push(ev({ ...base, type: 'income', in: { asset: A.norm(r.Primary_Asset), qty: num(r.Realized_Amount_For_Primary_Asset) }, usd: num(r.Realized_Amount_For_Primary_Asset_In_USD_Value), incomeKind: /airdrop|distribution/.test(op) ? 'airdrop' : 'staking' }));
    else warn.push(`Binance.US "${r.Category}/${r.Operation}" skipped`);
  }
  return { events: out, warnings: warn };
}
const splitAmt = (s) => { const m = String(s || '').replace(/,/g, '').match(/^([\d.eE+-]+)\s*([A-Za-z0-9.]+)$/); return m ? { qty: +m[1], asset: A.norm(m[2]) } : null; };
function binanceTrades(text, account = 'binanceus') {
  const rows = table(text, ['Date(UTC)']);
  const out = [];
  for (const r of rows) {
    const t = ts(r['Date(UTC)']); const side = (r.Side || r.Type || '').toUpperCase();
    const ex = splitAmt(r.Executed), am = splitAmt(r.Amount), fe = splitAmt(r.Fee);
    if (!ex || !am) continue;
    const sell = side === 'SELL';
    out.push(ev({ source: 'binanceus', account, ts: t, type: 'trade', out: sell ? ex : am, in: sell ? am : ex, usd: A.isFiat(am.asset) || A.isStable(am.asset) ? am.qty : null, fee: fe && fe.qty ? { ...fe, fromIn: fe.asset === (sell ? am.asset : ex.asset) } : null }));
  }
  return { events: out, warnings: [] };
}

// ---------- Etherscan-family explorer exports (BaseScan, BscScan, Arbiscan... "Download CSV") ----------
function explorer(text, kind, owner, chain = 'evm') {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner || '')) throw Object.assign(new Error('Explorer CSV import needs the wallet address it was exported for'), { status: 400 });
  const o = owner.toLowerCase(); const account = `${chain}:${o}`;
  const rows = table(text, ['Transaction Hash']);
  const native = { bsc: 'BNB', polygon: 'POL', avalanche: 'AVAX' }[chain] || 'ETH';
  const out = [];
  for (const r of rows) {
    const t = ts(r.UnixTimestamp || r['DateTime (UTC)'] || r.DateTime); if (isNaN(t)) continue;
    const from = (r.From || '').toLowerCase(), to = (r.To || '').toLowerCase();
    if (kind === 'explorer_tokens') {
      const q = num(r.TokenValue || r.Value || r.Quantity); if (!q) continue;
      const sym = A.norm(r.TokenSymbol || r['Token Symbol']);
      const usd = num(r.USDValueDayOfTx);
      if (to === o && from !== o) out.push(ev({ source: 'explorer:' + chain, account, ts: t, txid: r['Transaction Hash'], type: 'transfer_in', in: { asset: sym, qty: q, contract: r.ContractAddress }, usd }));
      else if (from === o && to !== o) out.push(ev({ source: 'explorer:' + chain, account, ts: t, txid: r['Transaction Hash'], type: 'transfer_out', out: { asset: sym, qty: q, contract: r.ContractAddress }, usd }));
    } else {
      const vin = num(Object.entries(r).find(([k]) => /^Value_IN/i.test(k))?.[1]) || 0, vout = num(Object.entries(r).find(([k]) => /^Value_OUT/i.test(k))?.[1]) || 0;
      const fee = num(Object.entries(r).find(([k]) => /^TxnFee\(/.test(k) && !/USD/.test(k))?.[1]) || 0;
      const hp = num(Object.entries(r).find(([k]) => /Historical \$Price/i.test(k))?.[1]);
      if ((r.Status || '').toLowerCase().includes('error')) { if (from === o && fee) out.push(ev({ source: 'explorer:' + chain, account, ts: t, txid: r['Transaction Hash'], type: 'fee', fee: { asset: native, qty: fee }, feeUsd: hp ? fee * hp : null })); continue; }
      if (vin) out.push(ev({ source: 'explorer:' + chain, account, ts: t, txid: r['Transaction Hash'], type: 'transfer_in', in: { asset: native, qty: vin }, usd: hp ? vin * hp : null }));
      if (vout) out.push(ev({ source: 'explorer:' + chain, account, ts: t, txid: r['Transaction Hash'], type: 'transfer_out', out: { asset: native, qty: vout }, usd: hp ? vout * hp : null, fee: from === o && fee ? { asset: native, qty: fee } : null, feeUsd: hp && fee ? fee * hp : null }));
      else if (from === o && fee) out.push(ev({ source: 'explorer:' + chain, account, ts: t, txid: r['Transaction Hash'], type: 'fee', fee: { asset: native, qty: fee }, feeUsd: hp ? fee * hp : null, note: r.Method || '' }));
    }
  }
  return { events: out, warnings: ['Explorer exports list raw transfers; swaps appear as an out + an in with the same tx hash and are merged into trades.'] };
}
// merge same-txid transfer_out + transfer_in of different assets within one account into a trade (DEX swap)
function mergeSwaps(events) {
  const by = {}; const keep = [];
  for (const e of events) { if (e.txid && (e.type === 'transfer_in' || e.type === 'transfer_out')) (by[e.account + '|' + e.txid] ||= []).push(e); else keep.push(e); }
  for (const g of Object.values(by)) {
    const outs = g.filter((e) => e.type === 'transfer_out'), ins = g.filter((e) => e.type === 'transfer_in');
    if (outs.length && ins.length) {
      const o = outs.sort((a, b) => (b.usd || 0) - (a.usd || 0))[0], i = ins.sort((a, b) => (b.usd || 0) - (a.usd || 0))[0];
      const fee = g.find((e) => e.fee)?.fee || null, feeUsd = g.find((e) => e.fee)?.feeUsd ?? null;
      keep.push({ ...o, type: 'trade', out: o.out, in: i.in, usd: o.usd ?? i.usd ?? null, fee, feeUsd, note: 'DEX swap (merged from explorer transfers)' });
      for (const x of [...outs, ...ins]) if (x !== o && x !== i) keep.push(x);
    } else keep.push(...g);
  }
  return keep.sort((a, b) => a.ts - b.ts);
}

// ---------- Generic mapper ----------
// mapping: {date, type, asset, qty, quoteAsset, quoteQty, usd, fee, feeAsset, txid, account, cls}; types: buy, sell, trade,
// deposit/receive, withdrawal/send, income/staking/airdrop/reward, spend, fee. Unmapped -> guessed from header names.
const GUESS = { date: /^(date|time|timestamp|datetime|date \(utc\))/i, type: /^(type|side|action|kind|transaction type)$/i, asset: /^(asset|symbol|coin|currency|base( asset)?|ticker)$/i, qty: /^(qty|quantity|amount|size|units|base amount)$/i,
  quoteAsset: /^(quote( asset)?|quote currency|counter( currency)?)$/i, quoteQty: /^(quote amount|total|cost|counter amount)$/i, usd: /^(usd|usd value|value( usd)?|proceeds|total usd|fmv)$/i, fee: /^(fee|fees|fee amount|commission)$/i, feeAsset: /^(fee asset|fee currency|fee coin)$/i, txid: /^(txid|tx hash|hash|transaction id|id)$/i, account: /^(account|wallet|exchange)$/i, cls: /^(class|asset class|asset type)$/i };
function generic(text, mapping = {}, account = 'generic') {
  const rows = parseCSV(text); const head = rows[0].map((h) => h.trim());
  const col = {}; for (const k of Object.keys(GUESS)) { const m = mapping[k]; col[k] = m != null && m !== '' ? head.indexOf(m) : head.findIndex((h) => GUESS[k].test(h)); }
  if (col.date < 0 || col.asset < 0 || col.qty < 0) throw Object.assign(new Error('Generic CSV needs at least date, asset and quantity columns (map them: ' + head.join(', ') + ')'), { status: 400 });
  const g = (r, k) => (col[k] >= 0 ? (r[col[k]] || '').trim() : '');
  const out = []; const warn = [];
  for (const r of rows.slice(1)) {
    const t = ts(g(r, 'date')); if (isNaN(t)) continue;
    const type = (g(r, 'type') || 'buy').toLowerCase(); const asset = g(r, 'asset'); const qty = Math.abs(num(g(r, 'qty')) || 0);
    const qa = A.norm(g(r, 'quoteAsset') || 'USD'), qq = Math.abs(num(g(r, 'quoteQty')) ?? 0), usd = num(g(r, 'usd'));
    const fee = Math.abs(num(g(r, 'fee')) || 0), fa = A.norm(g(r, 'feeAsset') || qa);
    const cls = A.classify(asset, (g(r, 'cls') || '').toLowerCase().replace(/[ -]/g, '_') || undefined);
    const base = { source: 'generic', account: g(r, 'account') || account, ts: t, txid: g(r, 'txid') };
    const v = usd != null ? Math.abs(usd) : (A.isFiat(qa) || A.isStable(qa)) ? qq : null;
    const F = fee ? { asset: fa, qty: fee } : null, FU = fee && (A.isFiat(fa) || A.isStable(fa)) ? fee : null;
    if (/^(buy|bought|purchase|long|bto|buy to open|btc|buy to close)$/.test(type)) out.push(ev({ ...base, type: 'trade', out: { asset: qa, qty: qq || v || 0 }, in: { asset, qty, cls }, usd: v, fee: F, feeUsd: FU }));
    else if (/^(sell|sold|sale|sto|sell to open|stc|sell to close)$/.test(type)) out.push(ev({ ...base, type: 'trade', out: { asset, qty, cls }, in: { asset: qa, qty: qq || v || 0 }, usd: v, fee: F, feeUsd: FU }));
    else if (/^(trade|swap|convert|exchange)$/.test(type)) out.push(ev({ ...base, type: 'trade', out: { asset, qty, cls }, in: { asset: qa, qty: qq }, usd: v, fee: F, feeUsd: FU }));
    else if (/deposit|receive|transfer in|incoming/.test(type)) out.push(ev({ ...base, type: 'transfer_in', in: { asset, qty, cls }, usd: v }));
    else if (/withdraw|send|transfer out|outgoing/.test(type)) out.push(ev({ ...base, type: 'transfer_out', out: { asset, qty, cls }, usd: v, fee: F, feeUsd: FU }));
    else if (/staking|stake reward|reward|interest|airdrop|income|mining|dividend|bonus/.test(type)) out.push(ev({ ...base, type: 'income', in: { asset, qty, cls }, usd: v, incomeKind: /airdrop/.test(type) ? 'airdrop' : /mining/.test(type) ? 'mining' : /staking|stake/.test(type) ? 'staking' : 'reward' }));
    else if (/spend|payment|purchase goods/.test(type)) out.push(ev({ ...base, type: 'spend', out: { asset, qty, cls }, usd: v, fee: F, feeUsd: FU }));
    else warn.push(`Row type "${type}" skipped`);
  }
  return { events: out, warnings: warn, columns: head, mapped: Object.fromEntries(Object.entries(col).map(([k, i]) => [k, i >= 0 ? head[i] : null])) };
}
function importCSV(text, { format, account, mapping, owner, chain } = {}) {
  const f = format && format !== 'auto' ? format : detect(text);
  let r;
  if (f === 'coinbase') r = coinbase(text, account || 'coinbase');
  else if (f === 'kraken_ledgers') r = krakenLedgers(text, account || 'kraken');
  else if (f === 'kraken_trades') r = krakenTrades(text, account || 'kraken');
  else if (f === 'binanceus_tax') r = binanceTax(text, account || 'binanceus');
  else if (f === 'binanceus_trades') r = binanceTrades(text, account || 'binanceus');
  else if (f === 'explorer_tokens' || f === 'explorer_native') { r = explorer(text, f, owner, chain || 'evm'); }
  else r = generic(text, mapping || {}, account || 'generic');
  r.events = r.events.filter((e) => (e.out ? e.out.qty > 0 : true) && (e.in ? e.in.qty > 0 : true));
  return { format: f, ...r };
}
module.exports = { parseCSV, detect, importCSV, mergeSwaps, num, ts };
