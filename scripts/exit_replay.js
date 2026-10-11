// Replay the Exit Plan card for historical rug/dump cases (LAB, VELVET) on their first rug-forecast flag date,
// then walk forward on daily closes to see what following the card would have done. Writes data/exit_replays.json.
// Limits: CoinGecko free daily closes (no intraday highs/lows), today's float/top-10 applied to the past.
'use strict';
const fs = require('fs'); const path = require('path');
const { exitPlan } = require('../lib/exitplan');
const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const cases = JSON.parse(fs.readFileSync(path.join(DATA, 'rug_cases.json'), 'utf8')).case_studies;
const day = (t) => new Date(t).toISOString().slice(0, 10);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
(async () => {
  const out = [];
  for (const c of cases) {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/${c.coingecko_id}/market_chart?vs_currency=usd&days=365&interval=daily`, { headers: { 'user-agent': 'Mozilla/5.0 asymmetric-terminal' } });
    const j = await r.json(); const P = j.prices, V = j.total_volumes.map((x) => x[1]), MC = j.market_caps.map((x) => x[1]);
    const px = P.map((x) => x[1]);
    // same daily forecast replay as research/rugwatch.py
    let first = null;
    for (let i = 30; i < px.length && !first; i++) {
      let sc = 0; const why = [];
      if (c.circ_ratio && c.circ_ratio < 0.5) { sc += 15; why.push('circulating < 50%'); }
      const r30 = px[i] / Math.min(...px.slice(i - 30, i));
      if (r30 > 5) { sc += 25; why.push(`${r30.toFixed(1)}x in 30 days (parabolic)`); } else if (r30 > 2.5) { sc += 12; why.push(`${r30.toFixed(1)}x in 30 days`); }
      const v7 = mean(V.slice(i - 6, i + 1)), v7p = mean(V.slice(i - 13, i - 6));
      if (px[i] > px[i - 7] * 1.2 && v7 < v7p * 0.8) { sc += 15; why.push('price rising on falling volume'); }
      if (MC[i] > 0 && v7 / MC[i] > 1) { sc += 10; why.push('turnover over 100% of mcap per day (churn)'); }
      if (MC[i] && px[i] >= Math.max(...px.slice(0, i + 1)) * 0.97 && r30 > 2) { sc += 10; why.push('at all-time highs after a run'); }
      if (sc >= 50) first = { i, sc, why };
    }
    if (!first) { out.push({ id: c.coingecko_id, flagged: false }); continue; }
    const i = first.i;
    const rets = []; for (let k = i - 13; k <= i; k++) rets.push(Math.abs(px[k] / px[k - 1] - 1) * 100);
    const lo90 = Math.min(...px.slice(Math.max(0, i - 90), i + 1)); const loI = px.indexOf(lo90);
    const top10 = Math.max(...(c.dex || []).map((d) => d.top10_pct || 0));
    const card = exitPlan({ symbol: c.symbol, price: px[i], high: Math.max(...px.slice(i - 30, i + 1)), atrPct: mean(rets),
      rug: { score: first.sc, signals: first.why.map((w) => ({ why: w })) },
      facts: { circRatio: c.circ_ratio, top10Pct: top10 || null, runMultiple: px[i] / lo90, runDays: i - loI } });
    // walk forward on daily closes
    let remaining = 1, proceeds = 0, runHigh = px[i]; const fills = [];
    const rungs = card.ladder.map((l) => ({ ...l, done: false }));
    for (let k = i; k < px.length && remaining > 1e-9; k++) {
      for (const l of rungs) if (!l.done && px[k] >= l.price) { l.done = true; proceeds += 0.25 * l.price; remaining -= 0.25; fills.push({ date: day(P[k][0]), what: `limit sell 25% filled at ${l.price.toPrecision(4)} (daily close ${px[k].toPrecision(4)})` }); }
      runHigh = Math.max(runHigh, px[k]);
      const stop = runHigh * (1 - card.trailPct);
      if (remaining > 1e-9 && k > i && px[k] <= stop) { proceeds += remaining * px[k]; fills.push({ date: day(P[k][0]), what: `trailing stop: sold remaining ${Math.round(remaining * 100)}% at ${px[k].toPrecision(4)} (stop ${stop.toPrecision(4)}, high ${runHigh.toPrecision(4)})` }); remaining = 0; }
    }
    if (remaining > 0) { proceeds += remaining * px[px.length - 1]; fills.push({ date: day(P[px.length - 1][0]), what: `still holding ${Math.round(remaining * 100)}% at ${px[px.length - 1].toPrecision(4)}` }); }
    const peakI = px.indexOf(Math.max(...px.slice(i)));
    const ci = P.findIndex((x) => day(x[0]) === c.collapse_date_70pct_down);
    out.push({ id: c.coingecko_id, symbol: c.symbol, flag_date: day(P[i][0]), price_at_flag: px[i], card: { text: card.text, sms: card.sms, ladder: card.ladder.map((l) => ({ pct: l.pct, price: l.price, gain: Math.round(l.gain) })), trailPct: Math.round(card.trailPct * 100), trail: card.trail, atrPct: +card.atrPct.toFixed(1), level: card.level, label: card.label },
      outcome: { fills, avg_exit_price: proceeds, avg_exit_vs_flag_pct: (proceeds / px[i] - 1) * 100, peak_after_flag: px[peakI], peak_date: day(P[peakI][0]), peak_vs_flag_pct: (px[peakI] / px[i] - 1) * 100,
        hold_to_collapse_price: ci >= 0 ? px[ci] : null, hold_to_collapse_vs_flag_pct: ci >= 0 ? (px[ci] / px[i] - 1) * 100 : null, price_now: px[px.length - 1], now_vs_flag_pct: (px[px.length - 1] / px[i] - 1) * 100 },
      caveats: 'Limit sells assumed filled at the target price (conservative); daily closes only (intraday spikes and crashes are not visible, so real fills differ); float and top-10 share are today\'s values applied to the flag date.' });
    await new Promise((r) => setTimeout(r, 7000));
  }
  fs.writeFileSync(path.join(DATA, 'exit_replays.json'), JSON.stringify({ generatedAt: Date.now(), cases: out }, null, 1));
  for (const o of out) { console.log('\n==', o.symbol, o.flag_date, 'price', o.price_at_flag); console.log(o.card.text); console.log('SMS:', o.card.sms); console.log(JSON.stringify(o.outcome, null, 1)); }
})();
