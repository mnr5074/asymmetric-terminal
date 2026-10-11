// Exit Plan / Rug Warning card: plain-English guidance + concrete sell levels from volatility (ATR) and recent highs.
// Model estimate, not financial advice. Pure function: same logic for live tokens, watchlist tokens and historical replays.
'use strict';
const precedents = require('./precedents');
const f = (x) => (x == null || isNaN(x) ? '?' : x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(3) : x.toPrecision(3));
const pc = (x) => `${x >= 0 ? '+' : ''}${Math.round(x)}%`;

/**
 * in: { symbol, price, high (recent high, e.g. 30d or since first seen), atrPct (typical daily move, %), rug: {score, signals:[{why}], dump30},
 *       facts: { circRatio, top10Pct, runMultiple, runDays, insiderToExchanges, unlockDays, unlockPct, liqDropPct, holdersFallingWhilePriceUp, devSellPct24h } }
 */
function exitPlan(inp) {
  const { symbol = '?', price, rug = {}, facts = {} } = inp;
  const high = Math.max(inp.high || price, price);
  const atr = Math.min(60, Math.max(6, inp.atrPct || 15)) / 100;    // clamp to 6..60% per day
  const score = rug.score || 0;
  const level = score >= 70 ? 'high' : score >= 45 ? 'elevated' : score >= 25 ? 'watch' : 'low';
  // reasons: concrete facts first, then the model's top signals
  const why = [];
  if (facts.circRatio != null && facts.circRatio < 0.6) why.push(`only ${Math.round(facts.circRatio * 100)}% of supply circulating`);
  if (facts.top10Pct != null && facts.top10Pct >= 40) why.push(`top 10 wallets hold ${Math.round(facts.top10Pct)}%`);
  if (facts.insiderToExchanges) why.push(facts.insiderToExchanges);
  if ((facts.whaleExit?.cutPct || 0) >= 1) why.push(facts.whaleExit.text);
  if (facts.runMultiple && facts.runMultiple >= 3) why.push(`price up ${facts.runMultiple >= 10 ? Math.round(facts.runMultiple) : facts.runMultiple.toFixed(1)}x in ${facts.runDays || '?'} days`);
  if (inp.crash?.ok && (inp.crash.evidence?.lift || 0) >= 1.5) why.push(`chart pattern ${inp.crash.text.replace('Looks', 'looks')}; ${Math.round(inp.crash.crashOdds * 100)}% of the most similar past days were followed by a 70%+ crash within 90 days`);
  for (const s of rug.signals || []) { const w = String(s.why || s); if (facts.circRatio != null && /circulat/i.test(w)) continue; if (facts.top10Pct != null && /top-?10/i.test(w)) continue; if (why.length < 6 && !why.some((x) => x.slice(0, 18) === w.slice(0, 18))) why.push(w); }
  // ladder: tighter and earlier the riskier it is; first rung "now" when risk is high
  const steps = level === 'high' ? [0, 0.5, 1, 1.5] : level === 'elevated' ? [0.5, 1, 1.75, 2.5] : [1, 2, 3, 4];
  const ladder = steps.map((k, i) => { const p = k === 0 ? price : price * (1 + k * atr); return { pct: 25, price: p, gain: (p / price - 1) * 100, note: k === 0 ? 'now' : i === 3 ? 'last quarter, or let it ride with the trailing stop' : '' }; });
  // trailing stop from the recent high, wider for calmer tokens; tighter when risk is high
  const trailPct = Math.min(0.4, Math.max(0.12, (level === 'high' ? 1.5 : level === 'elevated' ? 2 : 2.5) * atr));
  let trail = high * (1 - trailPct); if (trail >= price) trail = price * (1 - trailPct / 2);
  // exit-now triggers (TRIGGERED when the data already shows it)
  const T = [
    { t: 'Liquidity pulled: pool liquidity down 30%+ while price holds', on: facts.liqDropPct != null && facts.liqDropPct >= 30 },
    { t: 'Dev/insider wallets sell more than 1% of supply in 24h (or send large amounts to exchanges)', on: facts.devSellPct24h != null && facts.devSellPct24h >= 1 || !!facts.insiderToExchanges },
    { t: 'A token unlock of 2%+ of supply within 7 days', on: facts.unlockDays != null && facts.unlockDays <= 7 && (facts.unlockPct || 0) >= 2 },
    { t: `Top holders exiting: ${facts.whaleExit?.text || 'top-10 wallets cut 2%+ of supply within 72h'}`, on: (facts.whaleExit?.cutPct || 0) >= 2 },
    { t: 'Several wallets deposit similar amounts to one exchange within an hour', on: !!facts.cexCluster },
    { t: 'A fund/VC or treasury wallet routes tokens to an exchange (directly or via a fresh hop)', on: !!facts.fundToCex },
    { t: 'Holder count falling while price rises', on: !!facts.holdersFallingWhilePriceUp },
    { t: `Price closes below the trailing stop (${f(trail)})`, on: price <= trail },
  ];
  for (const x of T) x.precedent = precedents.forTrigger(x.t);
  const head = level === 'high' ? `High chance this could dump (rug risk ${score}/100).` : level === 'elevated' ? `Elevated dump risk (rug risk ${score}/100).` : level === 'watch' ? `Some warning signs (rug risk ${score}/100).` : `Low rug signals right now (rug risk ${score}/100), but keep an exit plan.`;
  const plan = `Take profits in steps: ${ladder.map((l) => `sell ${l.pct}% ${l.note === 'now' ? 'now' : `at ${f(l.price)} (${pc(l.gain)})`}`).join(', ')}. Trailing stop: sell the rest if it falls ${Math.round(trailPct * 100)}% from the high (${f(trail)}).`;
  const text = `${head} Reasons: ${why.slice(0, 5).join(', ') || 'none recorded'}. ${plan}`;
  const lk = inp.crash?.ok && (inp.crash.evidence?.lift || 0) >= 1.5 ? ` ~${inp.crash.top.similarity}% like ${inp.crash.top.name.split(' ')[0]} pre-crash` : '';
  const sms = `${symbol} rug risk ${score}${rug.dump30 ? ' DUMP-30d' : ''}${lk}: take profits above ${f(ladder.find((l) => l.gain > 0)?.price || price)}; trail stop ${f(trail)}`.slice(0, 159);
  return { level, score, head, why, crashLike: inp.crash?.ok ? { text: inp.crash.text, similarity: inp.crash.top.similarity, like: inp.crash.top.name, compare: inp.crash.top.compare, evidence: inp.crash.evidence, crashOdds: inp.crash.crashOdds } : null, ladder, trailPct, trail, high, atrPct: atr * 100, triggers: T, triggered: T.filter((x) => x.on).map((x) => x.t), text, sms,
    precedents: precedents.all().map((c) => ({ symbol: c.symbol, type: c.type, lesson: c.lesson })),
    label: 'Model estimate, not financial advice. Levels come from recent volatility and highs; low-liquidity tokens can gap through any level.' };
}

// typical daily move (%) from live-feed snapshots / DexScreener changes (no OHLC for most new tokens)
function atrFromMarket(m = {}, snaps = []) {
  const c = [];
  if (m.ch?.h24 != null) c.push(Math.abs(m.ch.h24));
  if (m.ch?.h6 != null) c.push(Math.abs(m.ch.h6) * 2);       // ~sqrt(4)
  if (m.ch?.h1 != null) c.push(Math.abs(m.ch.h1) * 4.9);     // ~sqrt(24)
  if (snaps.length >= 10) { const r = []; for (let i = 1; i < snaps.length; i++) if (snaps[i].px && snaps[i - 1].px) r.push(Math.abs(Math.log(snaps[i].px / snaps[i - 1].px))); const span = (snaps[snaps.length - 1].t - snaps[0].t) / 86400e3; if (r.length && span > 0) c.push(r.reduce((a, b) => a + b, 0) / r.length * Math.sqrt(r.length / span) * 100); }
  if (!c.length) return 20;
  c.sort((a, b) => a - b); return c[Math.floor(c.length / 2)];
}
module.exports = { exitPlan, atrFromMarket };
