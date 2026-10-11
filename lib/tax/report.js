'use strict';
// Accountant-ready outputs: Form 8949-style CSV and a PDF report (summary, estimate, 8949 detail, wash sales,
// ordinary income, harvesting ideas, worthless-token flags, on-chain context, review items, methodology).
const { PDF } = require('./pdf');
const { summarize, dstr, WASH_BILL_DATE } = require('./lots');
const { estimate } = require('./estimate');
const { tokenContext } = require('./context');
const CEX = new Set(['coinbase', 'kraken', 'binanceus']);
const money = (x, d = 2) => (x == null || isNaN(x) ? '' : (x < 0 ? '-' : '') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const qfmt = (q) => (q >= 1000 ? q.toLocaleString('en-US', { maximumFractionDigits: 2 }) : q >= 1 ? (+q.toFixed(4)).toString() : (+q.toPrecision(5)).toString());
// Form 8949 check box. Digital assets (2025+ forms): ST G/H/I, LT J/K/L. Securities: ST A/B/C, LT D/E/F.
function box(d) {
  const lt = d.term === 'LT';
  if (d.cls === 'stock' || d.cls === 'option') return lt ? 'D' : 'A';
  if (CEX.has(d.source)) return lt ? 'K' : 'H';
  return lt ? 'L' : 'I';
}
function rows8949(res, year, { example = false } = {}) {
  return res.disposals.filter((d) => new Date(d.sold).getUTCFullYear() === +year).sort((a, b) => a.term.localeCompare(b.term) * -1 || a.sold - b.sold).map((d) => ({
    description: `${example ? 'EXAMPLE - ' : ''}${qfmt(d.qty)} ${d.asset}${d.kind === 'fee' ? ' (fee)' : ''}`,
    acquired: d.noBasis ? 'UNKNOWN' : dstr(d.acq), sold: dstr(d.sold), proceeds: +d.proceeds.toFixed(2), cost: +d.cost.toFixed(2),
    code: d.adjCode, adj: d.adj ? +d.adj.toFixed(2) : 0, gain: +d.gain.toFixed(2), term: d.term === 'LT' ? 'Long-term' : 'Short-term', box: box(d),
    asset: d.asset, qty: d.qty, account: d.account, cls: d.cls, source: d.source, washRule: d.adjCode === 'W' ? (res.washSales.find((w) => w.dispId === d.id)?.rule || '') : '',
  }));
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function csv8949(res, year, opts = {}) {
  const head = ['Description of property', 'Date acquired', 'Date sold or disposed', 'Proceeds', 'Cost or other basis', 'Adjustment code', 'Adjustment amount', 'Gain or (loss)', 'Term', 'Form 8949 box', 'Asset', 'Quantity', 'Account', 'Asset class', 'Wash-sale rule basis'];
  const lines = [];
  if (opts.example) lines.push(csvCell('EXAMPLE DATA - fictional trades for demonstration only; not a real taxpayer, not tax advice'));
  lines.push(head.map(csvCell).join(','));
  for (const r of rows8949(res, year, opts)) lines.push([r.description, r.acquired, r.sold, r.proceeds.toFixed(2), r.cost.toFixed(2), r.code, r.adj ? r.adj.toFixed(2) : '', r.gain.toFixed(2), r.term, r.box, r.asset, r.qty, r.account, r.cls, r.washRule].map(csvCell).join(','));
  return lines.join('\n') + '\n';
}
function worthless(harvest) {
  return (harvest?.allLots || []).filter((l) => l.cost > 25 && l.value < l.cost * 0.02);
}
function pdfReport(res, { year = 2026, settings = {}, harvest = null, example = false, title = 'Crypto & Securities Tax Report', law = {} } = {}) {
  const S = summarize(res, year);
  const E = estimate({ year, filingStatus: settings.filingStatus, otherIncome: settings.otherIncome, qualifiedDividends: settings.qualifiedDividends, stNet: S.st.net, ltNet: S.lt.net, cryptoIncome: S.income, stCarryover: settings.stCarryover, ltCarryover: settings.ltCarryover });
  const p = new PDF(); const M = p.M, CW = p.W - 2 * M;
  const RED = [190, 30, 45], GRN = [20, 130, 70], MUT = [100, 110, 125], DARK = [20, 24, 32];
  const gc = (v) => (v < 0 ? RED : v > 0 ? GRN : DARK);
  const banner = () => { if (example) { p.rect(M, p.y, CW, 18, { fill: [255, 236, 179], stroke: [217, 119, 6] }); p.text(p.W / 2, p.y + 4, 'EXAMPLE DATA - fictional trades for demonstration only. Not a real taxpayer. Not tax advice.', { size: 9, bold: true, color: [146, 64, 14], align: 'center' }); p.y += 24; } };
  const h1 = (s) => { p.ensure(30); p.text(M, p.y, s, { size: 13, bold: true, color: [15, 23, 42] }); p.y += 17; p.line(M, p.y, M + CW, p.y, { color: [30, 41, 59], lw: 1 }); p.y += 6; };
  const h2 = (s) => { p.ensure(22); p.text(M, p.y, s, { size: 10, bold: true, color: [30, 41, 59] }); p.y += 14; };
  // ---- page 1: summary ----
  banner();
  p.text(M, p.y, `${title} - Tax Year ${year}`, { size: 18, bold: true, color: [15, 23, 42] }); p.y += 24;
  p.text(M, p.y, `Filing status: ${E.filingStatusLabel}  |  Lot method: ${res.method} (${res.scope === 'wallet' ? 'per wallet/account' : 'universal'})  |  Resident state: Nevada (no state income tax)  |  Generated ${new Date().toISOString().slice(0, 10)}`, { size: 8, color: MUT }); p.y += 16;
  const cards = [['Net short-term', S.st.net], ['Net long-term', S.lt.net], ['Net capital gain/loss', S.netTotal], ['Wash-sale disallowed', S.washDisallowed], ['Ordinary income (staking/airdrops)', S.income], ['Est. federal tax (total)', E.totalFederal], ['Est. tax from trading', E.incrementalFromTrading], ['Nevada state tax', 0]];
  const cw = (CW - 3 * 8) / 4;
  cards.forEach(([k, v], i) => { const x = M + (i % 4) * (cw + 8), y = p.y + Math.floor(i / 4) * 52; p.rect(x, y, cw, 46, { fill: [241, 245, 249], stroke: [203, 213, 225] }); p.text(x + 7, y + 7, k, { size: 7.5, color: MUT, maxWidth: cw - 10 }); p.text(x + 7, y + 22, money(v, 0), { size: 14, bold: true, color: i >= 5 ? DARK : gc(i === 3 ? 0 : v) }); });
  p.y += 112;
  h2('Realized gains and losses');
  // bar chart
  const bars = [['ST gains', S.st.gains, GRN], ['ST losses', S.st.losses, RED], ['LT gains', S.lt.gains, GRN], ['LT losses', S.lt.losses, RED], ['Income', S.income, [37, 99, 235]]];
  const mx = Math.max(1, ...bars.map((b) => Math.abs(b[1]))); const bw = 300;
  for (const [k, v, c] of bars) { p.text(M, p.y + 1, k, { size: 8 }); p.rect(M + 70, p.y, Math.max(1, Math.abs(v) / mx * bw), 11, { fill: c }); p.text(M + 76 + Math.abs(v) / mx * bw, p.y + 1, money(v, 0), { size: 8, bold: true, color: c }); p.y += 15; }
  p.y += 4;
  p.table([{ key: 'k', label: '', w: 200 }, { key: 'st', label: 'Short-term', w: 110, align: 'right' }, { key: 'lt', label: 'Long-term', w: 110, align: 'right' }, { key: 't', label: 'Total', w: 112, align: 'right' }], [
    { k: 'Proceeds', st: money(res.disposals.filter((d) => new Date(d.sold).getUTCFullYear() === +year && d.term === 'ST').reduce((s, d) => s + d.proceeds, 0)), lt: money(res.disposals.filter((d) => new Date(d.sold).getUTCFullYear() === +year && d.term === 'LT').reduce((s, d) => s + d.proceeds, 0)), t: money(S.proceeds) },
    { k: 'Gains', st: money(S.st.gains), lt: money(S.lt.gains), t: money(S.st.gains + S.lt.gains) },
    { k: 'Losses (after wash-sale adjustments)', st: money(S.st.losses), lt: money(S.lt.losses), t: money(S.st.losses + S.lt.losses) },
    { k: 'Net', st: money(S.st.net), lt: money(S.lt.net), t: money(S.netTotal), _bold: true },
    { k: 'Prior-year carryover applied', st: money(-Math.abs(settings.stCarryover || 0)), lt: money(-Math.abs(settings.ltCarryover || 0)), t: money(-Math.abs(settings.stCarryover || 0) - Math.abs(settings.ltCarryover || 0)) },
    { k: 'Capital loss deducted vs ordinary income', st: '', lt: '', t: money(-E.netting.deductibleLoss) },
    { k: 'Carryforward to next year', st: money(E.netting.carry.st), lt: money(E.netting.carry.lt), t: money(E.netting.carry.st + E.netting.carry.lt) },
  ]);
  h2('Key notes');
  const washTxt = res.washMode === 'off' ? 'OFF for crypto (current law): IRC 1091 applies to stock/securities, not to crypto (property under Notice 2014-21). Always applied to stock, options and tokenized securities.' : res.washMode === 'hr10357' ? 'PENDING-BILL SCENARIO: wash-sale applied to crypto loss sales after 2026-09-14 as H.R. 10357 sec. 301 would (passed Ways & Means 9/16/2026; NOT law).' : 'ON for crypto (user override; not current law).';
  for (const t of [`Wash-sale rule: ${washTxt}`, `Disposals: ${S.count} 8949 lines. Wash sales flagged: ${res.washSales.filter((w) => new Date(w.soldTs).getUTCFullYear() === +year).length}. Review items: ${res.review.length}.`, `Federal estimate uses ${E.source}. Capital-loss deduction limit $${E.netting.limit.toLocaleString()}; NIIT ${money(E.niit, 0)}.`, 'Nevada: no state personal income tax, so this report is federal only.', ...(law.pendingExposure ? [`Pending-bill risk: if H.R. 10357 is enacted as reported, ${money(law.pendingExposure)} of crypto losses on sales after 2026-09-14 that were followed/preceded by a repurchase within 30 days would be deferred (see Wash sales page).`] : [])])
    p.para('- ' + t, { size: 8.5 });
  // ---- estimate ----
  p.newPage(); banner(); h1('Estimated federal tax (' + year + ')');
  p.table([{ key: 'k', label: 'Line', w: 330 }, { key: 'v', label: 'Amount', w: 202, align: 'right' }], [
    { k: 'Other ordinary income (wages etc., user input)', v: money(settings.otherIncome || 0, 0) }, { k: 'Qualified dividends (user input)', v: money(settings.qualifiedDividends || 0, 0) },
    { k: 'Crypto ordinary income (staking, airdrops, rewards at FMV)', v: money(S.income, 0) }, { k: 'Net short-term after netting (taxed as ordinary)', v: money(E.netting.ordinaryAdd, 0) },
    { k: 'Net long-term after netting (0/15/20%)', v: money(E.netting.pref, 0) }, { k: 'Capital loss deducted (max $3,000; $1,500 MFS)', v: money(-E.netting.deductibleLoss, 0) },
    { k: 'Adjusted gross income (approx.)', v: money(E.agi, 0), _bold: true }, { k: `Deduction (standard ${money(E.standardDeduction, 0)})`, v: money(-E.deductionUsed, 0) },
    { k: 'Taxable income', v: money(E.taxableIncome, 0), _bold: true }, { k: 'Tax on ordinary taxable income', v: money(E.ordinaryTax, 0) },
    { k: `Capital gains tax (0%: ${money(E.ltcgBands.at0, 0)}, 15%: ${money(E.ltcgBands.at15, 0)}, 20%: ${money(E.ltcgBands.at20, 0)})`, v: money(E.capitalGainsTax, 0) },
    { k: 'Net investment income tax (3.8%)', v: money(E.niit, 0) }, { k: 'Estimated total federal income tax', v: money(E.totalFederal, 0), _bold: true },
    { k: 'Same return without any trading/crypto income', v: money(E.baselineWithoutCrypto, 0) }, { k: 'Incremental federal tax from trading', v: money(E.incrementalFromTrading, 0), _bold: true },
    { k: 'Nevada state income tax', v: '$0' }, { k: 'Marginal ordinary rate', v: (E.marginalOrdinary * 100).toFixed(0) + '%' },
  ]);
  h2(`${year} brackets used (${E.filingStatusLabel})`);
  p.para(E.brackets.map(([hi, r], i) => `${(r * 100).toFixed(0)}% ${i ? 'over ' + money(E.brackets[i - 1][0], 0) : 'from $0'}${hi ? ' to ' + money(hi, 0) : ''}`).join('  |  '), { size: 8 });
  p.para(`Long-term capital gains: 0% up to ${money(E.ltcgThresholds[0], 0)} taxable income, 15% up to ${money(E.ltcgThresholds[1], 0)}, 20% above. Source: ${E.source}.`, { size: 8 });
  p.para(E.niitNote, { size: 8 }); for (const c of E.caveats) p.para('- ' + c, { size: 8, color: MUT });
  // ---- 8949 ----
  const R = rows8949(res, year, { example });
  const cols = [{ key: 'description', label: '(a) Description', w: 118 }, { key: 'acquired', label: '(b) Acquired', w: 54 }, { key: 'sold', label: '(c) Sold', w: 54 }, { key: 'proceeds', label: '(d) Proceeds', w: 62, align: 'right' }, { key: 'cost', label: '(e) Basis', w: 62, align: 'right' }, { key: 'code', label: '(f) Code', w: 30 }, { key: 'adj', label: '(g) Adj.', w: 52, align: 'right' }, { key: 'gain', label: '(h) Gain/loss', w: 64, align: 'right' }, { key: 'box', label: 'Box', w: 36 }];
  const fm = { proceeds: (v) => money(v), cost: (v) => money(v), adj: (v) => (v ? money(v) : ''), gain: (v) => money(v) };
  for (const [term, part] of [['Short-term', 'Part I - Short-term (held one year or less)'], ['Long-term', 'Part II - Long-term (held more than one year)']]) {
    p.newPage(); banner(); h1('Form 8949-style detail: ' + part);
    const rr = R.filter((r) => r.term === term);
    const tot = rr.reduce((a, r) => ({ proceeds: a.proceeds + r.proceeds, cost: a.cost + r.cost, adj: a.adj + r.adj, gain: a.gain + r.gain }), { proceeds: 0, cost: 0, adj: 0, gain: 0 });
    p.table(cols, [...rr, { description: 'TOTAL', ...tot, _bold: true }], { fmt: fm, size: 7, rowH: 10.5, rowColor: (r, c) => (c.key === 'gain' ? gc(r.gain) : c.key === 'code' && r.code ? RED : undefined) });
    p.para('Boxes: digital assets G/H/I (short) and J/K/L (long) per 2025+ Form 8949 (G/J = 1099-DA with basis, H/K = 1099-DA without basis, I/L = no 1099-DA, typical for DEX/self-custody). Securities A-F. Verify against the 1099-DA/1099-B you receive. Code W = wash sale; column (g) adds the disallowed loss back.', { size: 7.5, color: MUT });
  }
  // ---- wash sales ----
  p.newPage(); banner(); h1('Wash sales (IRC 1091)');
  p.para(law.washText || 'IRC 1091 disallows a loss on stock or securities when substantially identical stock/securities (including options to acquire them) are bought within 30 days before or after the sale, in any account (including IRAs). The disallowed loss is added to the basis of the replacement shares and their holding period includes that of the shares sold. Crypto: not covered under current law; see the toggle setting on page 1.', { size: 8.5 });
  p.y += 4;
  const W = res.washSales.filter((w) => new Date(w.soldTs).getUTCFullYear() === +year);
  if (!W.length) p.para('No wash sales detected for this year under the selected settings.', { size: 9, bold: true });
  else p.table([{ key: 'asset', label: 'Asset', w: 60 }, { key: 'cls', label: 'Class', w: 70 }, { key: 'sold', label: 'Loss sale', w: 56 }, { key: 'qty', label: 'Qty sold', w: 50, align: 'right' }, { key: 'loss', label: 'Loss', w: 62, align: 'right' }, { key: 'rep', label: 'Replacement', w: 56 }, { key: 'rq', label: 'Repl. qty', w: 50, align: 'right' }, { key: 'dis', label: 'Disallowed', w: 62, align: 'right' }, { key: 'rule', label: 'Rule', w: 66 }],
    W.map((w) => ({ asset: w.asset, cls: w.cls, sold: dstr(w.soldTs), qty: qfmt(w.qtySold), loss: money(-w.loss), rep: dstr(w.replacementTs), rq: qfmt(w.replacementQty), dis: money(w.disallowed), rule: w.rule.startsWith('IRC 1091 (stock') ? 'Securities' : w.rule.startsWith('H.R.') ? 'H.R.10357 scen.' : 'Crypto toggle' })), { size: 7.2 });
  if (W.length) p.para(`Total disallowed: ${money(W.reduce((s, w) => s + w.disallowed, 0))}. Each disallowed amount was added to the replacement lot's basis (deferred, not lost) and the holding period was tacked.`, { size: 8.5, bold: true });
  if (law.pendingExposure != null) p.para(`Pending-bill exposure (H.R. 10357 scenario, crypto loss sales after 2026-09-14 with a repurchase within 30 days): ${money(law.pendingExposure)} of losses would be deferred if the bill is enacted as reported.`, { size: 8.5, color: RED });
  // ---- income ----
  h1('Ordinary income at fair market value (staking, airdrops, rewards)');
  const I = res.income.filter((i) => new Date(i.ts).getUTCFullYear() === +year);
  if (!I.length) p.para('None recorded.', { size: 9 });
  else p.table([{ key: 'd', label: 'Date', w: 70 }, { key: 'k', label: 'Type', w: 70 }, { key: 'a', label: 'Asset', w: 70 }, { key: 'q', label: 'Quantity', w: 90, align: 'right' }, { key: 'u', label: 'FMV (USD) = income & basis', w: 130, align: 'right' }, { key: 'acct', label: 'Account', w: 102 }],
    [...I.map((i) => ({ d: dstr(i.ts), k: i.kind, a: i.asset, q: qfmt(i.qty), u: money(i.usd), acct: i.account })), { d: 'TOTAL', u: money(S.income), _bold: true }]);
  p.para('Staking rewards are income when you gain dominion and control (Rev. Rul. 2023-14); airdrops are income at FMV when received (Rev. Rul. 2019-24). Report on Schedule 1 (other income) or Schedule C if a business. This FMV becomes the cost basis of the tokens.', { size: 8, color: MUT });
  // ---- harvesting + worthless ----
  if (harvest) {
    p.newPage(); banner(); h1('Tax-loss harvesting ideas (open positions)');
    p.para(`Realized net ${year} to date: ${money(harvest.realizedNet)}. Harvesting target (net gains + $3,000 ordinary offset): ${money(harvest.target)}. Unrealized losses available: ${money(harvest.harvestable)}. Est. federal tax before ${money(harvest.estimatedTaxBefore, 0)} -> after ${money(harvest.estimatedTaxAfter, 0)} (saves ${money(harvest.estimatedSavings, 0)}). Nevada: no state tax, federal only.`, { size: 8.5 });
    if (harvest.picks.length) p.table([{ key: 'asset', label: 'Asset', w: 60 }, { key: 'cls', label: 'Class', w: 72 }, { key: 'term', label: 'Term', w: 30 }, { key: 'qty', label: 'Qty', w: 60, align: 'right' }, { key: 'cost', label: 'Basis', w: 70, align: 'right' }, { key: 'value', label: 'Value now', w: 70, align: 'right' }, { key: 'ul', label: 'Unrealized', w: 80, align: 'right' }, { key: 'saved', label: 'Tax saved', w: 90, align: 'right' }],
      harvest.picks.map((l) => ({ asset: l.asset, cls: l.cls, term: l.term, qty: qfmt(l.qty), cost: money(l.cost), value: money(l.value), ul: money(l.unrealized), saved: money(l.taxSaved, 0) })), { size: 7.5 });
    for (const n of [...new Set(harvest.picks.map((l) => l.washNote))]) p.para('- ' + n, { size: 8, color: RED });
    for (const n of harvest.notes) p.para('- ' + n, { size: 8, color: MUT });
    const wl = worthless(harvest);
    h2('Near-zero / rug-pulled positions');
    if (!wl.length) p.para('None flagged (positions worth < 2% of basis).', { size: 8.5 });
    else { p.table([{ key: 'asset', label: 'Asset', w: 80 }, { key: 'acct', label: 'Account', w: 150 }, { key: 'cost', label: 'Basis', w: 90, align: 'right' }, { key: 'value', label: 'Value now', w: 90, align: 'right' }, { key: 'ul', label: 'Unrealized', w: 122, align: 'right' }], wl.map((l) => ({ asset: l.asset, acct: l.account, cost: money(l.cost), value: money(l.value), ul: money(l.unrealized) })), { size: 7.5 });
      p.para('Holding or "abandoning" a worthless token generally gives an investor NO deduction: IRS CCA 202302011 treats a worthlessness/abandonment loss on crypto as a miscellaneous itemized deduction, and OBBBA sec. 70110 made their suspension permanent (tax years after 2025). A real sale (even for a fraction of a cent, via any remaining DEX liquidity or to a genuine unrelated buyer) produces a capital loss on Form 8949. Document the sale (tx hash, counterparty) and have your tax professional review; sham or related-party (IRC 267) sales are disallowed. H.R. 10357 sec. 306 (pending, not law) would treat worthless digital assets as sold on Dec 31.', { size: 8, color: RED }); }
  }
  // ---- on-chain context ----
  const syms = [...new Set(res.disposals.concat(res.holdings).map((d) => d.asset))];
  const ctx = tokenContext(syms);
  if (Object.keys(ctx).length) { p.newPage(); banner(); h1('On-chain context per token (terminal research modules)');
    for (const [s, lines] of Object.entries(ctx)) { h2(s); for (const l of lines) p.para('- ' + l, { size: 8 }); }
    p.para('Context only, from this terminal\'s live feed / crash catalog / rug case studies at report time. It does not change tax results, but supports a worthless-asset or theft-loss analysis with your tax professional.', { size: 7.5, color: MUT }); }
  // ---- review + method ----
  p.newPage(); banner(); h1('Items to review');
  if (!res.review.length) p.para('No open review items.', { size: 9 });
  else for (const r of res.review.slice(0, 80)) p.para('- ' + (r.ts ? dstr(r.ts) + ': ' : '') + r.msg, { size: 8 });
  if (res.review.length > 80) p.para(`...and ${res.review.length - 80} more (see the Tax desk).`, { size: 8 });
  h1('Method, sources and limits');
  for (const t of [
    `Lots: ${res.method}${res.method !== 'FIFO' ? ' (specific identification: requires adequate identification at the time of sale; brokers default to FIFO)' : ''}. Basis tracked ${res.scope === 'wallet' ? 'per wallet/account as required for digital assets from 1/1/2025 (Rev. Proc. 2024-28; Treas. Reg. 1.1012-1(j))' : 'universally (pre-2025 style)'}. Fees are added to basis on purchases and subtract from proceeds on sales; fees paid in crypto are themselves disposals of that crypto.`,
    'Term: long-term if held more than one year (sold after the 1-year anniversary of acquisition). Crypto-to-crypto swaps are taxable disposals at fair market value.',
    'Internal transfers between your own wallets/exchanges are matched (same tx hash, or same asset and amount within 2% within 72 hours) and are not taxable; lots move with original dates and basis.',
    'Prices: USD stablecoins = $1; Coinbase Exchange hourly candles; Binance public daily closes; CoinGecko free (<=365 days); GeckoTerminal pool daily closes. Exchange CSV values are used as reported when present.',
    'Not modeled: margin/futures, Section 1256 contracts (60/40), 28% collectibles rate for NFTs, AMT, trader tax status / 475(f), state taxes other than Nevada (none).',
    'This report is an estimate prepared from user-provided data and free public sources. It is not tax advice. Give it to a CPA/EA for review before filing.',
  ]) p.para('- ' + t, { size: 8 });
  p.footer((pp, i, n) => { pp.line(M, pp.H - M + 4, pp.W - M, pp.H - M + 4); pp.text(M, pp.H - M + 8, example ? 'EXAMPLE DATA - fictional' : 'CONFIDENTIAL - contains personal tax data', { size: 7, color: example ? [180, 83, 9] : MUT, bold: example }); pp.text(pp.W - M, pp.H - M + 8, `Asymmetric Terminal Tax desk  |  page ${i} of ${n}`, { size: 7, color: MUT, align: 'right' }); });
  return { pdf: p.build({ title: `${example ? 'EXAMPLE - ' : ''}${title} ${year}` }), summary: S, estimate: E };
}
module.exports = { csv8949, rows8949, pdfReport, box, worthless };
