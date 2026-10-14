// No-look-ahead backtest of the Breakouts flat-base score (lib/flatbase.js) on data/flatbase_series (365d daily, free backfill).
// Each coin is scored weekly using only data up to that day (ATH used only if its date is <= that day). Outcome: a "breakout"
// = within the next 90 days the close reaches >= 2x the scoring-day close AND the close 7 days after that first 2x day is still
// >= 1.6x (did not give it back). Groups compared against the beaten-down baseline (>= 70% below its high, any shape).
// Significance: one-sided binomial vs baseline rate + coin-cluster bootstrap of lift (coins resampled, 2000 draws).
// "proven" bar (same as lib backtest): >= 30 flagged events with >= 10 hits, p < 0.01, lift >= 1.5, bootstrap 5th pct lift > 1.
'use strict';
const fs = require('fs'); const path = require('path');
const { score } = require('../lib/flatbase');
const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA, 'flatbase_series');
const H = 90, STEP = 7;
function outcome(s, i) {
  const c0 = s[i][1]; let first = -1;
  for (let j = i + 1; j <= Math.min(s.length - 1, i + H); j++) if (s[j][1] >= 2 * c0) { first = j; break; }
  if (first < 0) return { hit: false, peak: Math.max(...s.slice(i + 1, i + H + 1).map((r) => r[1])) / c0 };
  const k = Math.min(s.length - 1, first + 7);
  return { hit: s[k][1] >= 1.6 * c0, peak: Math.max(...s.slice(i + 1, i + H + 1).map((r) => r[1])) / c0, days: first - i };
}
function binomP(k, n, p) { // P[X >= k], normal approx with continuity (n large) / exact for small n
  if (n === 0) return 1;
  if (n <= 200) { let s = 0, c = 1; const lp = Math.log(p), lq = Math.log(1 - p); for (let x = 0; x <= n; x++) { if (x > 0) c += Math.log((n - x + 1) / x); if (x >= k) s += Math.exp(c + x * lp + (n - x) * lq); } return Math.min(1, s); }
  const m = n * p, sd = Math.sqrt(n * p * (1 - p)); const z = (k - 0.5 - m) / sd; return 0.5 * erfc(z / Math.SQRT2);
}
function erfc(x) { const t = 1 / (1 + 0.5 * Math.abs(x)); const r = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))); return x >= 0 ? r : 2 - r; }

const files = fs.readdirSync(DIR); const ev = []; const sanity = {};
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); const s = (d.s || []).filter((r) => r[1] > 0);
  if (['STRK', 'TROLL'].includes(String(d.symbol).toUpperCase())) { const r = score(s, s.length - 1, { athKnown: Math.max(d.ath || 0, ...s.map((x) => x[1])) }); const hist = []; for (let k = Math.max(119, s.length - 120); k < s.length; k += 7) { const q = score(s, k, { athKnown: Math.max(...s.slice(0, k + 1).map((x) => x[1])) }); if (q) hist.push({ date: new Date(s[k][0] * 864e5).toISOString().slice(0, 10), close: s[k][1], score: q.score, label: q.label, baseDays: q.m.baseDays, range8w: q.m.range8w }); }
    sanity[d.id] = r ? { history: hist, symbol: String(d.symbol).toUpperCase(), src: d.src, days: s.length, score: r.score, label: r.label, m: r.m, parts: r.parts } : { symbol: String(d.symbol).toUpperCase(), src: d.src, days: s.length, note: 'too little history to score (< 120 days)' }; }
  if (s.length < 120 + H) continue;
  let runMax = 0;
  for (let i = 119; i <= s.length - 1 - H; i += STEP) {
    runMax = Math.max(runMax, ...s.slice(Math.max(0, i - STEP + 1), i + 1).map((x) => x[1]), ...(i === 119 ? s.slice(0, 120).map((x) => x[1]) : []));
    const r = score(s, i, { athKnown: runMax }); // ATH known at day i only (no look-ahead)
    if (!r) continue;
    const vol20 = s.slice(i - 19, i + 1).reduce((a, x) => a + (x[2] || 0), 0) / 20;
    if (vol20 < 250e3 || r.m.ddAth > 0.98) continue; // same hard filters as live (where computable historically)
    const o = outcome(s, i);
    ev.push({ coin: d.id, sym: String(d.symbol).toUpperCase(), day: s[i][0], score: r.score, label: r.label, dd: r.m.ddAth, flat: r.m.range8w <= 0.35 && r.m.baseDays >= 28, up: r.m.volUp5v20 >= 1.5, hit: o.hit, peak: o.peak, days: o.days });
  }

}
const rate = (a) => (a.length ? a.filter((x) => x.hit).length / a.length : null);
const base = ev.filter((x) => x.dd >= 0.7); const pBase = rate(base);
const coins = [...new Set(ev.map((x) => x.coin))];
function group(name, pred) {
  const g = ev.filter(pred); const hits = g.filter((x) => x.hit).length; const r = rate(g);
  const lift = r != null && pBase ? r / pBase : null;
  // coin-cluster bootstrap of lift
  const byCoin = new Map(); for (const x of ev) { const v = byCoin.get(x.coin) || []; v.push(x); byCoin.set(x.coin, v); }
  const lifts = []; let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let b = 0; b < 2000; b++) { let gn = 0, gh = 0, bn = 0, bh = 0; for (let k = 0; k < coins.length; k++) { for (const x of byCoin.get(coins[Math.floor(rnd() * coins.length)])) { if (pred(x)) { gn++; gh += x.hit; } if (x.dd >= 0.7) { bn++; bh += x.hit; } } } if (gn && bn && bh) lifts.push((gh / gn) / (bh / bn)); }
  lifts.sort((a, b) => a - b);
  const med = (a) => { const v = a.map((x) => x.peak).sort((p, q) => p - q); return v.length ? +v[Math.floor(v.length / 2)].toFixed(2) : null; };
  return { name, n: g.length, coins: new Set(g.map((x) => x.coin)).size, hits, hitRate: r != null ? +r.toFixed(3) : null, lift: lift != null ? +lift.toFixed(2) : null,
    p: g.length ? +binomP(hits, g.length, pBase || 0.01).toExponential(2) : null, liftCI90: lifts.length ? [+lifts[Math.floor(lifts.length * 0.05)].toFixed(2), +lifts[Math.floor(lifts.length * 0.95)].toFixed(2)] : null,
    medianPeak90d: med(g), medianDaysToBreakout: (() => { const v = g.filter((x) => x.hit).map((x) => x.days).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; })() };
}
const tiers = [
  group('baseline: beaten-down (>= 70% below high), any shape', (x) => x.dd >= 0.7),
  group('all scored coin-weeks', () => true),
  group('score >= 70', (x) => x.score >= 70),
  group('score 55-69', (x) => x.score >= 55 && x.score < 70),
  group('score < 55', (x) => x.score < 55),
  group('label Coiled', (x) => x.label === 'Coiled'),
  group('label Waking', (x) => x.label === 'Waking'),
  group('label Breaking out', (x) => x.label === 'Breaking out'),
  group('flat base but no volume uptick', (x) => x.dd >= 0.7 && x.flat && !x.up),
  group('flat base + volume uptick', (x) => x.dd >= 0.7 && x.flat && x.up),
];
const top = tiers.find((t) => t.name === 'score >= 70');
const proven = top.n >= 30 && top.hits >= 10 && top.p < 0.01 && top.lift >= 1.5 && top.liftCI90 && top.liftCI90[0] > 1;
const weak = !proven && top.lift != null && top.lift > 1.1 && top.hits >= 5;
const tierOf = (t) => (t.n >= 30 && t.hits >= 10 && t.p < 0.01 && t.lift >= 1.5 && t.liftCI90 && t.liftCI90[0] > 1 ? 'proven' : t.lift != null && t.lift > 1.1 && t.hits >= 5 && t.liftCI90 && t.liftCI90[0] > 1 ? 'weak' : 'unproven');
const CUT = Math.floor(Date.parse('2024-01-01') / 864e5);
const labelTiers = {};
for (const L of ['Coiled', 'Waking', 'Breaking out']) {
  const all = tiers.find((t) => t.name === 'label ' + L);
  const early = group(`label ${L}, before 2024`, (x) => x.label === L && x.day < CUT), late = group(`label ${L}, 2024 onward (out-of-time)`, (x) => x.label === L && x.day >= CUT);
  tiers.push(early, late);
  let tier = tierOf(all); if (tier === 'proven' && !(late.lift >= 1.3 && early.lift >= 1.3)) tier = 'weak'; // must hold in both periods
  labelTiers[L] = { tier, why: `${all.hits}/${all.n} broke out (${(all.hitRate * 100).toFixed(1)}%) vs ${(pBase * 100).toFixed(1)}% baseline, lift ${all.lift} (90% CI ${all.liftCI90?.join('–')}); before 2024 lift ${early.lift} (n ${early.n}), 2024+ lift ${late.lift} (n ${late.n})` };
}
const verdict = { tier: proven ? 'proven' : weak ? 'weak' : 'unproven',
  why: `score >= 70: ${top.hits}/${top.n} coin-weeks broke out (${top.hitRate != null ? (top.hitRate * 100).toFixed(1) : '—'}%) vs ${(pBase * 100).toFixed(1)}% for all beaten-down coins; lift ${top.lift ?? '—'} (90% CI ${top.liftCI90 ? top.liftCI90.join('–') : '—'}), p ${top.p}. Bar for proven: >= 30 events, >= 10 hits, p < 0.01, lift >= 1.5.` };
const out = { generatedAt: Date.now(), method: 'weekly no-look-ahead replay, multi-year daily history (Binance spot USDT pairs incl. delisted, + GeckoTerminal for TROLL), breakout = 2x within 90d held 7d, baseline = beaten-down coins',
  sample: { coins: coins.length, coinWeeks: ev.length, firstDay: ev.length ? new Date(Math.min(...ev.map((x) => x.day)) * 864e5).toISOString().slice(0, 10) : null, lastDay: ev.length ? new Date(Math.max(...ev.map((x) => x.day)) * 864e5).toISOString().slice(0, 10) : null },
  baselineRate: pBase, tiers, verdict, labelTiers, sanity,
  caveats: ['Weekly samples of the same coin overlap (not independent); the coin-cluster bootstrap CI accounts for that.', 'On-chain inputs (holders, smart money) have no history, so the backtest uses the 85-point price/volume score only.', 'Universe = Binance USDT pairs incl. halted ones; fully delisted pairs that Binance no longer lists are missing (some survivorship bias). Binance listing itself is a quality filter.'] };
fs.writeFileSync(path.join(DATA, 'flatbase_backtest.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ sample: out.sample, baseline: pBase, verdict, labelTiers }, null, 1));
for (const t of tiers) console.log(t.name.padEnd(55), 'n', t.n, 'hits', t.hits, 'rate', t.hitRate, 'lift', t.lift, 'CI', t.liftCI90, 'p', t.p, 'medPeak', t.medianPeak90d);
console.log('sanity', JSON.stringify(sanity));
