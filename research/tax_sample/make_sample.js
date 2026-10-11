// Generates the EXAMPLE-DATA sample report: sample_tax_report.pdf / .csv / sample_page1.png / sample_summary.json.
// Run: node research/tax_sample/make_sample.js   (fictional trades only; no network, no personal data)
'use strict';
const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const S = require('../../lib/tax/sample'); const T = require('../../lib/tax');
const OUT = __dirname;
const ev = S.events();
const r = T.compute(ev, S.SETTINGS, {}, { prices: S.PRICES, now: S.NOW });
const { pdf } = T.report.pdfReport(r.res, { year: 2026, settings: S.SETTINGS, harvest: r.harvest, example: true, title: 'EXAMPLE Crypto & Securities Tax Report', law: { washText: T.LAW.washCurrent + ' ' + T.LAW.washPending, pendingExposure: r.exposure.amount } });
fs.writeFileSync(path.join(OUT, 'sample_tax_report.pdf'), pdf);
fs.writeFileSync(path.join(OUT, 'sample_tax_report.csv'), T.report.csv8949(r.res, 2026, { example: true }));
execFileSync('pdftoppm', ['-png', '-r', '110', '-f', '1', '-l', '1', '-singlefile', path.join(OUT, 'sample_tax_report.pdf'), path.join(OUT, 'sample_page1')]);
const out = { EXAMPLE_DATA: true, settings: S.SETTINGS, summary: r.summary, estimate: { totalFederal: r.estimate.totalFederal, baseline: r.estimate.baselineWithoutCrypto, incremental: r.estimate.incrementalFromTrading, ordinaryTax: r.estimate.ordinaryTax, capitalGainsTax: r.estimate.capitalGainsTax, niit: r.estimate.niit, taxableIncome: r.estimate.taxableIncome, netting: r.estimate.netting },
  washSales: r.res.washSales.map((w) => ({ asset: w.asset, sold: new Date(w.soldTs).toISOString().slice(0, 10), disallowed: +w.disallowed.toFixed(2), rule: w.rule })), pendingBillExposure: r.exposure,
  harvest: { savings: r.harvest.estimatedSavings, picks: r.harvest.picks.map((p) => ({ asset: p.asset, unrealized: Math.round(p.unrealized), taxSaved: p.taxSaved })), worthless: r.harvest.worthless.map((w) => w.asset) }, review: r.res.review.map((x) => x.msg) };
fs.writeFileSync(path.join(OUT, 'sample_summary.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
