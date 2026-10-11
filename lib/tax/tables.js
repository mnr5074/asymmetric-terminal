'use strict';
// Federal individual income tax tables. 2026 figures: IRS Rev. Proc. 2025-32 (Oct 9 2025, reflects the
// One Big Beautiful Bill Act, P.L. 119-21), sections 4.01 (rate tables), 4.03 (max capital gains rate amounts),
// 4.14 (standard deduction). Verified against https://www.irs.gov/pub/irs-drop/rp-25-32.pdf on 2026-10-11.
// 2025 figures: Rev. Proc. 2024-40 as amended by OBBBA (standard deduction 15,750 / 31,500 / 23,625).
// NIIT (IRC 1411) thresholds are statutory and NOT inflation-indexed. Capital loss limit: IRC 1211(b).
const STATUSES = { single: 'Single', mfj: 'Married filing jointly / surviving spouse', mfs: 'Married filing separately', hoh: 'Head of household' };

// [upper bound of bracket, rate]; last bound Infinity
const T = {
  2026: {
    source: 'IRS Rev. Proc. 2025-32 (tax year 2026, incl. OBBBA amendments)',
    brackets: {
      single: [[12400, .10], [50400, .12], [105700, .22], [201775, .24], [256225, .32], [640600, .35], [Infinity, .37]],
      mfj: [[24800, .10], [100800, .12], [211400, .22], [403550, .24], [512450, .32], [768700, .35], [Infinity, .37]],
      mfs: [[12400, .10], [50400, .12], [105700, .22], [201775, .24], [256225, .32], [384350, .35], [Infinity, .37]],
      hoh: [[17700, .10], [67450, .12], [105700, .22], [201750, .24], [256200, .32], [640600, .35], [Infinity, .37]],
    },
    // taxable-income thresholds: 0% up to [0], 15% up to [1], 20% above
    ltcg: { single: [49450, 545500], mfj: [98900, 613700], mfs: [49450, 306850], hoh: [66200, 579600] },
    stdDeduction: { single: 16100, mfj: 32200, mfs: 16100, hoh: 24150 },
  },
  2025: {
    source: 'IRS Rev. Proc. 2024-40 as amended by OBBBA (tax year 2025)',
    brackets: {
      single: [[11925, .10], [48475, .12], [103350, .22], [197300, .24], [250525, .32], [626350, .35], [Infinity, .37]],
      mfj: [[23850, .10], [96950, .12], [206700, .22], [394600, .24], [501050, .32], [751600, .35], [Infinity, .37]],
      mfs: [[11925, .10], [48475, .12], [103350, .22], [197300, .24], [250525, .32], [375800, .35], [Infinity, .37]],
      hoh: [[17000, .10], [64850, .12], [103350, .22], [197300, .24], [250500, .32], [626350, .35], [Infinity, .37]],
    },
    ltcg: { single: [48350, 533400], mfj: [96700, 600050], mfs: [48350, 300000], hoh: [64750, 566700] },
    stdDeduction: { single: 15750, mfj: 31500, mfs: 15750, hoh: 23625 },
  },
};
const NIIT = { rate: 0.038, threshold: { single: 200000, mfj: 250000, mfs: 125000, hoh: 200000 }, source: 'IRC 1411 (thresholds fixed by statute, not indexed)' };
const LOSS_LIMIT = { single: 3000, mfj: 3000, hoh: 3000, mfs: 1500 }; // IRC 1211(b)
const COLLECTIBLES_RATE = 0.28; // not modeled: NFTs may be collectibles (IRS Notice 2023-27); flagged only
function table(year) { return T[year] || T[2026]; }
function years() { return Object.keys(T).map(Number); }
module.exports = { STATUSES, table, years, NIIT, LOSS_LIMIT, COLLECTIBLES_RATE };
