# Live Alpha Feed grade rebuild (v2), 2026-10-18

Script: `research/grades/ab_rebuild.py` → `data/grade_rebuild.json` (re-run any time; `lib/gradev2.js` reloads it). Grading code: `lib/gradev2.js`, applied in `lib/livefeed.js`.

## Data and method

- Source: forward call log `data/calls.json` (every live-feed pick logged at grading time with its call-time features). Span: 2026-10-11 03:26 PT → 2026-10-16 15:01 PT (the log is capped at 30,000 rows, so only ~7 days exist).
- Unit: first call per token (regrades dropped), calls ≥ 24h old. Hit = peak ≥ 2x after the call AND not rugged. Rug = price ≤ 10% of the call price, liquidity pulled under $1K from ≥ $3K, or the pair delisted (lib/calls.js). Peak is tracked up to 7.2 days.
- Time split on non-vetoed calls: train = oldest 60% (n=3222, 2026-10-11 03:26 PT → 2026-10-12 14:25 PT), test = newest 40% (n=2148, to 2026-10-16 15:01 PT). Base rates on test: hit 7.4%, rug 38.0%.
- 86 single-feature threshold rules were chosen on train (quintile edges, ≥ 40 calls, beat train base rate) and scored once on test. Pass = test hit rate above base with one-sided binomial p < 0.05 after Bonferroni ×86, n ≥ 20, AND test rug rate not above base. No lookahead: features are the values stored at call time; market cap is DexScreener fdv at call time (no current-supply back-fill).

## Before (old score-based grade), all resolved first calls

| grade | n | hit 2x clean | rugged |
|---|---|---|---|
| A | 232 | 4.7% | 87.5% |
| B | 267 | 4.9% | 75.3% |
| C | 651 | 9.8% | 69.9% |
| D | 1600 | 8.9% | 50.6% |
| F | 9541 | 4.2% | 23.9% |
| A+B | 499 | 4.8% | 81.0% |
| all | 12291 | 5.1% | 32.1% |

Old A rugged 87.5% and hit 2x-clean 4.7%, below the 5.1% base rate. The old score ranks rug risk (test AUC for rug 0.80): higher score = MORE likely to rug.

## Rules that passed out-of-sample

| rule | train n / hit | test n | test hit | test rug | p (Bonferroni) |
|---|---|---|---|---|---|
| `comps.attention >= 0.4` | 854 / 6.9% | 417 | 13.7% | 25.4% | 0.0009 |
| `feat.socials >= 1` | 981 / 7.8% | 485 | 13.2% | 26.8% | 0.0009 |

`feat.socials` = number of social links on the DexScreener profile at call time; `comps.attention` = socials + website + DexScreener boost. Both say the same thing: a token whose team paid for / filled in a profile. Rules that raised hit rate but ALSO raised rug rate (5m momentum, 1h volume, participation) were rejected.
A logistic model on all features reached test AUC 0.69 (permutation p 0.001), but it is not used: it rewards momentum features that raise the rug rate.

## After (grade v2 on the test period)

| tier | n | hit 2x clean | rugged |
|---|---|---|---|
| A | 416 | 13.5% | 25.7% |
| B | 74 | 12.2% | 32.4% |
| U | 1668 | 5.6% | 41.3% |
| F | 2699 | 4.6% | 9.7% |
| A+B | 490 | 13.3% | 26.7% |

Before on the same test period: old A n=211 hit 4.7% rug 88.6%; old A+B n=334 hit 4.8% rug 80.2%.

Grade v2: F = failed a safety veto; A = meets every passing rule (capped at B if the contract scan has not run or the rug forecast is ≥ 45); B = meets one; U = 'Unrated — safety checks only'. If a re-run finds no passing rule, every non-vetoed token becomes U automatically.

## Safety vetoes (resolved first calls)

| veto | n | rugged | never hit 2x clean | strength |
|---|---|---|---|---|
| top-10 holders > 60% | 138 | 89.1% | 94.9% | backtested |
|   of which > 90% | 112 | 88.4% | – | backtested |
| fake liquidity (quote side) | 33 | 57.6% | 100.0% | backtested |
| honeypot signs | 29 | 89.7% | 96.5% | backtested (small n) |
| liquidity < $3K | 6716 | 18.7% | 95.4% | exclusion |

The audit quoted 93% (top-10 > 90%) and 72% (fake liquidity); on this log the rug-only rates are 88% and 58%, and both vetoes are right ≥ 95% of the time if 'right' means the token never hit 2x clean.

## Honest strength

- **Weak, backtested.** One week of calls; the test period is ~4 days; the effect was absent on the last two days (Oct 15–16, n=84 and 54, small). Even tier A rugged about 1 in 4. Re-run the script daily and expect the letters to switch off if the edge fades.
- Rug definition can't trigger the liquidity rule for calls that started under $3K liquidity, so vetoed-for-thin-liquidity calls look safer than they are.
- Not changed: the composite grade (lib/composite.js) used for majors/perps, options and airdrop grades.
