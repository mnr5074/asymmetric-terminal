'use strict';
// Federal estimate (Nevada resident: no state income tax, so federal only). Implements Schedule D netting,
// the $3,000 ($1,500 MFS) capital-loss deduction limit with ST/LT carryforward, ordinary brackets, the 0/15/20%
// qualified-dividend & capital-gain worksheet stacking, and the 3.8% NIIT. Simplified: ignores AMT, 28% collectibles
// (NFTs) and unrecaptured 1250 gain, QBI, credits, phase-outs; "otherIncome" is treated as ordinary income in AGI.
const TB = require('./tables');
function ordinaryTax(ti, br) { let tax = 0, lo = 0; for (const [hi, r] of br) { if (ti > lo) tax += (Math.min(ti, hi) - lo) * r; lo = hi; } return tax; }
function marginal(ti, br) { for (const [hi, r] of br) if (ti <= hi) return r; return br[br.length - 1][1]; }
// Capital gains worksheet: preferential income stacked on top of ordinary taxable income
function prefTax(ordTI, pref, th) {
  if (pref <= 0) return { tax: 0, at0: 0, at15: 0, at20: 0 };
  const top = ordTI + pref;
  const at0 = Math.max(0, Math.min(top, th[0]) - ordTI);
  const at15 = Math.max(0, Math.min(top, th[1]) - Math.max(ordTI, th[0]));
  const at20 = Math.max(0, pref - at0 - at15);
  return { tax: at15 * 0.15 + at20 * 0.20, at0, at15, at20 };
}
// netting -> {ordinaryAdd, pref, deductibleLoss, carry:{st,lt}}
function netCapital(st, lt, stCarry, ltCarry, status) {
  const nst = st - Math.abs(stCarry || 0), nlt = lt - Math.abs(ltCarry || 0);
  const limit = TB.LOSS_LIMIT[status] || 3000;
  const comb = nst + nlt;
  let ordinaryAdd = 0, pref = 0, deductibleLoss = 0, carry = { st: 0, lt: 0 };
  if (nst >= 0 && nlt >= 0) { ordinaryAdd = nst; pref = nlt; }
  else if (comb >= 0) { if (nst >= 0) ordinaryAdd = comb; /* net ST gain survives, taxed as ordinary */ else pref = comb; /* net LT gain survives */ }
  else {
    const loss = -comb; deductibleLoss = Math.min(limit, loss);
    if (nst < 0 && nlt < 0) { const stUse = Math.min(-nst, deductibleLoss); carry.st = -nst - stUse; carry.lt = -nlt - (deductibleLoss - stUse); }
    else if (nst < 0) carry.st = loss - deductibleLoss; else carry.lt = loss - deductibleLoss;
  }
  return { netST: nst, netLT: nlt, combined: comb, ordinaryAdd, pref, deductibleLoss, limit, carry };
}
function estimate({ year = 2026, filingStatus = 'single', otherIncome = 0, qualifiedDividends = 0, stNet = 0, ltNet = 0, cryptoIncome = 0, stCarryover = 0, ltCarryover = 0, itemized = 0 }) {
  const t = TB.table(year); const st = TB.STATUSES[filingStatus] ? filingStatus : 'single';
  const br = t.brackets[st], th = t.ltcg[st];
  const ded = Math.max(t.stdDeduction[st], +itemized || 0);
  const calc = (stN, ltN, inc) => {
    const n = netCapital(stN, ltN, stCarryover, ltCarryover, st);
    const agi = Math.max(0, (+otherIncome || 0) + (+qualifiedDividends || 0) + inc + n.ordinaryAdd + n.pref - n.deductibleLoss);
    const ti = Math.max(0, agi - ded);
    const prefIncome = Math.min(ti, n.pref + (+qualifiedDividends || 0));
    const ordTI = ti - prefIncome;
    const oTax = ordinaryTax(ordTI, br); const p = prefTax(ordTI, prefIncome, th);
    const nii = Math.max(0, n.ordinaryAdd + n.pref + (+qualifiedDividends || 0));
    const niit = TB.NIIT.rate * Math.max(0, Math.min(nii, agi - TB.NIIT.threshold[st]));
    return { n, agi, ti, ordTI, prefIncome, oTax, p, niit, total: oTax + p.tax + niit };
  };
  const withC = calc(stNet, ltNet, cryptoIncome);
  const without = calc(0, 0, 0);
  const r = (x) => Math.round(x);
  return {
    year: +year, filingStatus: st, filingStatusLabel: TB.STATUSES[st], source: t.source, standardDeduction: t.stdDeduction[st], deductionUsed: ded,
    netting: { ...withC.n, netST: r(withC.n.netST), netLT: r(withC.n.netLT), combined: r(withC.n.combined), carry: { st: r(withC.n.carry.st), lt: r(withC.n.carry.lt) } },
    agi: r(withC.agi), taxableIncome: r(withC.ti), ordinaryTaxable: r(withC.ordTI), preferentialTaxable: r(withC.prefIncome),
    ordinaryTax: r(withC.oTax), capitalGainsTax: r(withC.p.tax), ltcgBands: { at0: r(withC.p.at0), at15: r(withC.p.at15), at20: r(withC.p.at20) }, niit: r(withC.niit),
    totalFederal: r(withC.total), baselineWithoutCrypto: r(without.total), incrementalFromTrading: r(withC.total - without.total),
    marginalOrdinary: marginal(withC.ordTI, br), ltcgThresholds: th, brackets: br.map(([hi, rt]) => [hi === Infinity ? null : hi, rt]),
    state: { name: 'Nevada', tax: 0, note: 'Nevada has no state personal income tax; capital gains and crypto income are taxed federally only.' },
    niitNote: `NIIT: 3.8% on the lesser of net investment income or MAGI above $${TB.NIIT.threshold[st].toLocaleString()} (${TB.NIIT.source}). Staking/airdrop income may or may not be NII depending on facts; this estimate counts only capital gains + qualified dividends.`,
    caveats: ['Estimate only, not tax advice. Excludes AMT, credits, phase-outs, self-employment tax on business crypto income, 28% collectibles rate for NFTs, and estimated-tax penalties.', 'Capital-loss deduction against ordinary income capped at $' + (TB.LOSS_LIMIT[st]).toLocaleString() + ' per year (IRC 1211(b)); excess carries forward indefinitely, keeping its short/long-term character (IRC 1212(b)).'],
  };
}
module.exports = { estimate, netCapital, ordinaryTax, prefTax, marginal };
