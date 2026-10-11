'use strict';
// Tax desk orchestration: ledger -> lots -> summary / estimate / harvest / wash-sale exposure / exports.
const L = require('./lots');
const { estimate } = require('./estimate');
const { suggest } = require('./harvest');
const { matchTransfers } = require('./transfers');
const report = require('./report');
const LAW = {
  asOf: '2026-10-11',
  washCurrent: 'Current law: IRC 1091 applies to "stock or securities" (and contracts/options to acquire them). The IRS treats crypto as property (Notice 2014-21), so the wash-sale rule does not apply to direct crypto sales. It always applies to stocks, options and tokenized securities.',
  washPending: 'Pending: H.R. 10357 "Digital Asset Tax Certainty Act" (introduced 9/14/2026, ordered reported by House Ways & Means 38-5 on 9/16/2026; not passed by the House or Senate). Sec. 301 would extend IRC 1091 to traded digital assets (excluding qualified USD stablecoins) for dispositions after 9/14/2026 (JCX-50-26). Earlier bill H.R. 9172 (6/8/2026) is introduced only.',
  sources: ['https://www.congress.gov/bill/119th-congress/house-bill/10357', 'https://docs.house.gov/meetings/WM/WM00/20260916/119574/HMKP-119-WM00-20260916-SD002.pdf (JCX-50-26)', 'https://www.irs.gov/pub/irs-drop/rp-25-32.pdf (Rev. Proc. 2025-32, 2026 tables)', 'IRS Notice 2014-21; Rev. Proc. 2024-28; Rev. Rul. 2019-24; Rev. Rul. 2023-14; CCA 202302011; OBBBA (P.L. 119-21) sec. 70110'],
};
function compute(events, settings = {}, overrides = {}, { prices = null, now = Date.now() } = {}) {
  const year = +settings.year || new Date(now).getUTCFullYear();
  const res = L.run(events, settings, overrides);
  const summary = L.summarize(res, year);
  const est = estimate({ year, filingStatus: settings.filingStatus, otherIncome: +settings.otherIncome || 0, qualifiedDividends: +settings.qualifiedDividends || 0, stNet: summary.st.net, ltNet: summary.lt.net, cryptoIncome: summary.income, stCarryover: +settings.stCarryover || 0, ltCarryover: +settings.ltCarryover || 0 });
  // exposure if H.R. 10357 is enacted as reported (only meaningful when the toggle is off)
  const alt = settings.washCrypto === 'hr10357' ? res : L.run(events, { ...settings, washCrypto: 'hr10357' }, overrides);
  const pend = alt.washSales.filter((w) => w.rule.startsWith('H.R.') && new Date(w.soldTs).getUTCFullYear() === year);
  const exposure = { amount: Math.round(pend.reduce((s, w) => s + w.disallowed, 0) * 100) / 100, sales: pend.map((w) => ({ asset: w.asset, sold: L.dstr(w.soldTs), rebought: L.dstr(w.replacementTs), qty: w.replacementQty, deferred: Math.round(w.disallowed * 100) / 100 })) };
  const harvest = prices ? suggest(res, { year, prices, now, settings }) : null;
  return { year, res, summary, estimate: est, exposure, harvest, law: LAW };
}
module.exports = { compute, matchTransfers, report, LAW };
