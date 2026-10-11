'use strict';
// Tax-loss harvesting suggestions: open lots with unrealized losses vs realized gains year-to-date.
// Tax saved is measured by re-running the federal estimate with the harvested losses added (so the $3,000 limit,
// ST/LT netting and bracket effects are all reflected). Nevada: federal only.
const { estimate } = require('./estimate');
const { summarize, isLongTerm, WASH_BILL_DATE } = require('./lots');
const A = require('./assets');
function suggest(res, { year = 2026, prices = {}, now = Date.now(), settings = {} } = {}) {
  const ytd = summarize(res, year);
  const base = { year, filingStatus: settings.filingStatus, otherIncome: settings.otherIncome, qualifiedDividends: settings.qualifiedDividends, stCarryover: settings.stCarryover, ltCarryover: settings.ltCarryover, cryptoIncome: ytd.income };
  const est0 = estimate({ ...base, stNet: ytd.st.net, ltNet: ytd.lt.net });
  const lots = [];
  const missing = new Set();
  for (const l of res.holdings) {
    const k = A.norm(l.asset); const px = prices[k] ?? prices[A.taxKey(k)];
    if (px == null) { missing.add(k); continue; }
    const value = l.qty * px, ul = value - l.cost;
    lots.push({ asset: k, cls: l.cls, account: l.account, qty: l.qty, cost: l.cost, value, unrealized: ul, term: isLongTerm(l.acq, now) ? 'LT' : 'ST', acq: l.acq, price: px });
  }
  const losers = lots.filter((l) => l.unrealized < -1).sort((a, b) => a.unrealized - b.unrealized);
  const target = Math.max(0, ytd.netTotal) + 3000; // offset all net gains + the $3,000 ordinary deduction
  const picks = []; let st = ytd.st.net, lt = ytd.lt.net, harvested = 0;
  // prefer ST losses first when net ST gains exist (they offset ordinary-rate gains)
  const ordered = losers.slice().sort((a, b) => (st > 0 ? (a.term === 'ST' ? -1 : 1) - (b.term === 'ST' ? -1 : 1) : 0) || a.unrealized - b.unrealized);
  for (const l of ordered) {
    if (harvested >= target) break;
    const before = estimate({ ...base, stNet: st, ltNet: lt }).totalFederal;
    if (l.term === 'ST') st += l.unrealized; else lt += l.unrealized;
    harvested += -l.unrealized;
    const after = estimate({ ...base, stNet: st, ltNet: lt }).totalFederal;
    const sec = l.cls !== 'crypto' && l.cls !== 'nft';
    picks.push({ ...l, taxSaved: Math.round(before - after),
      washNote: sec ? 'SECURITY: wash-sale rule applies. Do not buy the same or substantially identical security (incl. options on it, or its tokenized version) 30 days before or after, in ANY account incl. IRAs, or the loss is disallowed.'
        : now >= WASH_BILL_DATE ? 'Crypto: no wash-sale rule under current law, BUT H.R. 10357 (passed Ways & Means 9/16/2026, not law) would apply IRC 1091 to digital-asset sales after 9/14/2026, retroactively if enacted. Waiting 31 days before re-buying avoids the risk. Economic-substance doctrine can also challenge same-moment sell/re-buy.'
        : 'Crypto: no wash-sale rule under current law (IRC 1091 covers stock/securities). Same-moment sell/re-buy can still be challenged under economic substance.' });
  }
  const estAfter = estimate({ ...base, stNet: st, ltNet: lt });
  return {
    year, ytd, realizedNet: ytd.netTotal, target: Math.round(target), harvestable: Math.round(losers.reduce((s, l) => s - l.unrealized, 0)), picks,
    estimatedTaxBefore: est0.totalFederal, estimatedTaxAfter: estAfter.totalFederal, estimatedSavings: est0.totalFederal - estAfter.totalFederal,
    carryAfter: estAfter.netting.carry, missingPrices: [...missing], allLots: lots,
    worthless: lots.filter((l) => l.cost > 25 && l.value < l.cost * 0.02).map((l) => ({ asset: l.asset, account: l.account, cost: l.cost, value: l.value, note: 'Near-zero (likely rug/dead). Holding or abandoning gives an investor no deduction (CCA 202302011 + OBBBA sec. 70110 permanent misc-itemized ban). A documented real sale to an unrelated party yields a capital loss: have your tax pro review.' })),
    notes: ['Nevada resident: no state income tax, so savings shown are federal only.', 'Harvested losses first offset gains of the same term, then the other term, then up to $3,000 of ordinary income; the rest carries forward.', 'Suggestions only; prices are live/approximate and fees/slippage are ignored.'],
  };
}
module.exports = { suggest };
