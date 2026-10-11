# PATTERN LAB

37 crash/pump patterns (31 original + 6 if-then rules), each backtested in **both directions** on the 50-token pattern-detector set (30 crashed + 20 runners, from `data/patterns_flows.json`), then wired live with small documented composite adjustments. Market-wide patterns (16, 18, 28, 29) are also scored against the full event catalog (`data/events_labeled.json`: crashes + pumps).

Files: `research/patternlab/{plcommon,pl_fetch_nansen,pl_fetch_free,pl_backtest,pl_live,pl_report}.py`, `research/patternlab/fv_bridge.js`, `lib/patternlab.js`, `public/patternlab.js`, `data/patternlab_backtest.json`, `data/patternlab_live.json`, `data/patternlab_nansen_ledger.json`. API: `GET /api/patternlab`, `GET /api/patternlab/token?chain=&address=`. Minimal additive edits: `server.js` (1 route line), `public/index.html` (1 script tag), `lib/composite.js` (`plab` adjustment factor).

## Method
- **Event anchors**: crashed tokens use the dump time (first close ≤50% below peak), runners use the breakout time (first 2x over the launch price). A flag counts only if it fired before that anchor (+1h grace for 1-hour bars); flags that fired later are logged as "late" and not counted.
- **Stats**: hit rate in crashed vs runners, one-sided Fisher p for each direction (`p crash`, `p pump`), median lead time before dump / before breakout, false-flag rate (share of the other class flagged). "crash-predictive" / "pump-predictive" = one-sided p<0.05; "weak tilt" = p<0.15.
- **Reuse**: contract flags (4, 5, 6, 21) come from `lib/contractscan.js`; 8 from `lib/mev.js` and the sandwich log; 11/12 from `lib/fakevolume.js` (through `fv_bridge.js`); 13 also uses `lib/copytrade.js` events; 14 from `lib/unlocks.js`; 16 from `lib/stables.js` and riskinfra; 17 from `lib/fees.js`; 18 from `lib/liquidations.js`; 19 from `lib/oracles.js`; 25 from `lib/dependencies.js` and regradar; 27 from `lib/seasonality.js`; 30 from `lib/perps.js`/`lib/fundingdiv.js`; 15 also reads `lib/vcwatch.js`. Pattern-detector outputs (LP pulls, holder concentration, fresh-wallet clusters) are only read here, not rebuilt.

## Results (both directions)
| # | Pattern | Status | Crashed (fired pre-peak) | Runners | p crash | p pump | Lead before dump | Lead before breakout | Verdict | Live flags | Composite |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1★ | Coordinated smart-money exits | built | 2/30 | 11/20 | 1.000 | <0.001 | +0.5h | -0.8h | pump-predictive (p<0.05) | 1 | 0 (info) |
| 2 | Smart money accumulating (incl. dead tokens) | built | 0/30 | 2/20 | 1.000 | 0.155 | – | -0.4h | no edge | 4 | 0 (info) |
| 3 | Dev funded by mixer / sanctioned / fresh / serial funder | built | 10/30 | 13/20 | 0.994 | 0.028 | +5.5h | +1.0h | pump-predictive (p<0.05) | 16 | 0 (info) |
| 4★ | Mint authority live (HARD) | wrapped | 0/30 | 0/20 | 1.000 | 1.000 | – | – | never fired on this set | 97 | cap D, -6 |
| 5★ | Freeze authority live (HARD) | wrapped | 0/30 | 0/20 | 1.000 | 1.000 | – | – | never fired on this set | 5 | cap D, -6 |
| 6 | Ownership / metadata not renounced | wrapped | 0/30 | 0/20 | 1.000 | 1.000 | – | – | never fired on this set | 323 | -1 |
| 7★ | Sniper / MEV-bot volume (clean volume) | built | 30/30 | 19/20 | 0.400 | 1.000 | +1.1h | +0.3h | no edge | 8 | 0 (info) |
| 8 | Sandwich attacks on big buys | wrapped | 1/30 | 0/20 | 0.600 | 1.000 | +0.1h | – | no edge | 1 | 0 (info) |
| 9 | Social: shills only after the pump | partial | 4/30 | 0/20 | 0.119 | 1.000 | +0.5h | – | weak crash tilt (p<0.15) | 6 | 0 (info) |
| 10 | Liquidity concentrated in 1-2 pools | built | 30/30 | 9/20 | <0.001 | 1.000 | +2.2h | +0.7h | crash-predictive (p<0.05) | 15 | -1 |
| 11 | Fake volume then LP pull | wrapped | 28/30 | 13/20 | 0.015 | 0.998 | +2.2h | +1.8h | crash-predictive (p<0.05) | 13 | -1 |
| 12 | Wash trading across same-entity wallets | wrapped | 28/30 | 16/20 | 0.164 | 0.968 | +2.2h | +1.2h | no edge | 27 | 0 (info) |
| 13 | Copy-trading clusters | built | 29/30 | 14/20 | 0.012 | 0.999 | +1.0h | +1.8h | crash-predictive (p<0.05) | 28 | -1 |
| 14★ | Vesting cliff / unlock near the price peak | partial | 0/0 | 0/0 | – | – | – | – | untestable on this set | 25 | 0 (info) |
| 15 | Cross-token links (shared dev/VC/community wallets) | built | 17/30 | 11/20 | 0.568 | 0.658 | +2.1h | +1.0h | no edge | 16 | 0 (info) |
| 16 | Stablecoin depeg (macro warning) | wrapped | 0/30 | 0/20 | 1.000 | 1.000 | – | – | never fired on this set · catalog 0% crash vs 0% pump events (n=969/578, p crash 1.000) | 0 | -1 |
| 17 | Gas / priority-fee spike | wrapped | 0/0 | 0/0 | – | – | – | – | untestable on this set | 0 | 0 (info) |
| 18 | Perp liquidation cascade spilling to spot | wrapped | 0/30 | 1/20 | 1.000 | 0.400 | – | +0.0h | no edge · catalog 13% crash vs 4% pump events (n=1848/609, p crash <0.001) | 2 | 0 (info) |
| 19 | Oracle manipulation flags | wrapped | 0/0 | 0/0 | – | – | – | – | untestable on this set | 11 | 0 (info) |
| 20 | Flash-loan patterns | partial | 0/30 | 0/20 | 1.000 | 1.000 | – | – | never fired on this set | 1 | 0 (info) |
| 21 | Reentrancy / access-control heuristics (EVM) | partial | 0/0 | 0/0 | – | – | – | – | untestable on this set | 108 | 0 (info) |
| 22 | Mempool front-running | built | 2/30 | 1/20 | 0.651 | 0.793 | +7.5h | -0.3h | no edge | 2 | 0 (info) |
| 23 | Jito bundles / block-builder games | partial | 4/30 | 7/20 | 0.984 | 0.073 | +1.7h | +1.7h | weak pump tilt (p<0.15) | 0 | 0 (info) |
| 24 | TWAP manipulation | wrapped | 0/0 | 0/0 | – | – | – | – | untestable on this set | 0 | 0 (info) |
| 25 | Exchange halts / deposit-withdrawal suspensions | wrapped | 0/0 | 0/0 | – | – | – | – | untestable on this set | 0 | 0 (info) |
| 26 | Pump-and-dump phase (accumulation → markup → distribution → markdown) | built | 1/18 | 17/19 | 1.000 | <0.001 | +0.6h | -1.4h | pump-predictive (p<0.05) | 6 | 0 (info) |
| 27 | Seasonality (weekend, month-end, options expiry, CME closed, holidays) | wrapped | 18/30 | 7/20 | 0.074 | 0.979 | +0.0h | +0.0h | weak crash tilt (p<0.15) | 1 | 0 (info) |
| 28 | BTC/ETH beta regime | built | 0/30 | 2/20 | 1.000 | 0.155 | – | +0.0h | no edge · catalog 12% crash vs 9% pump events (n=1895/609, p crash 0.053) | 0 | 0 (info) |
| 29 | Alt-season indicators (breadth, ETH/BTC) | built | 7/30 | 5/20 | 0.685 | 0.575 | +0.0h | +0.0h | no edge · catalog 30% crash vs 19% pump events (n=1835/609, p crash <0.001) | 1 | 0 (info) |
| 30 | Extreme positive perp funding | wrapped | 0/0 | 0/0 | – | – | – | – | untestable on this set | 4 | 0 (info) |
| 31 | OI spike with flat price | wrapped | 0/0 | 0/0 | – | – | – | – | untestable on this set | 0 | 0 (info) |
| 32 | Top-10 share shrinking while price climbs (distribution) | built | 3/30 | 1/20 | 0.472 | 0.881 | +0.8h | -0.5h | no edge | 0 | 0 (info) |
| 33 | First 100 buyers mostly fresh wallets from one funder | built | 1/30 | 0/20 | 0.600 | 1.000 | +14.8h | – | no edge | 2 | 0 (info) |
| 34 | Absorption (volume spike, price flat) + side | built | 0/13 | 2/11 | 1.000 | 0.199 | – | -2.9h | no edge | 1 | 0 (info) |
| 35 | Liquidity / market-cap below floor (rug risk) | built | 0/0 | 0/0 | – | – | – | – | untestable on this set | 43 | 0 (info) |
| 36 | Same deployer, several launches the same day (bundle play) | built | 16/30 | 0/20 | <0.001 | 1.000 | +2.2h | – | crash-predictive (p<0.05) | 1 | -1 |
| 37 | Quiet token gets a burst of new wallets (discovery) | built | 0/30 | 5/20 | 1.000 | 0.007 | – | +14.5h | pump-predictive (p<0.05) | 0 | 1 |

★ = priority item. "Live flags" = tokens currently flagged across the live feed and module outputs (snapshot at build time; the panel shows the current count).

## What actually correlates
- **Crash-predictive (p<0.05)**: #10 liquidity in 1-2 pools (30/30 vs 9/20), #11 fake volume (28/30 vs 13/20), #13 copy-trading clusters (29/30 vs 14/20), **#36 same-deployer same-day launches (16/30 vs 0/20, about 2.2h before the dump)**. The first three fire on most launchpad tokens, so they work as base-rate risk, not as timing signals.
- **Pump-predictive (p<0.05)**: #1 smart-money sell clusters (11/20 runners: smart money trades the winners), #3 dev-funding red flags (13/20 runners vs 10/30), #26 phase classifier, and **#37 discovery burst (5/20 vs 0/30, median 14.5h before the breakout, the only early pump signal)**. For #1 and #26 the median lead is negative (they fire around or after the breakout), so they confirm the move rather than predict it.
- **Catalog (market-wide)**: crash events happened more often during perp liquidation cascades (#18: 13% of crash events vs 4% of pump events, p<0.001) and during alt-season conditions (#29: 30% vs 19%, p<0.001). #28 beta regime was borderline (p=0.053). #16 depeg never happened in the window.
- **No edge / untestable**: #7 sniper volume fires on nearly every token (30/30, 19/20). 14, 17, 19, 21, 24, 25, 30, 31 and 35 can't be tested on pump.fun tokens (no unlocks, perps, oracles or EVM source, and no point-in-time liq/mcap); they run live as information only.
- **#4/#5 mint/freeze**: never fired in the test set (pump.fun revokes both at launch). They stay **hard flags** live: grade capped at D, and stablecoin mints are exempt.

## Composite wiring (`lib/composite.js` → `plab` adjustment, in points)
| Pattern | Adj | Why |
|---|---|---|
| #4 mint authority live | −6 + **cap D** | hard flag (priority) |
| #5 freeze authority live | −6 + **cap D** | hard flag (priority) |
| #6 ownership not renounced | −1 | prior. If the hit comes from contractscan it only adds the cap, because the contract factor already penalizes it |
| #10 liquidity in 1-2 pools | −1 | crash p<0.001 |
| #11 fake volume then LP pull | −1 | crash p=0.015 |
| #13 copy-trading clusters | −1 | crash p=0.012 |
| #16 stablecoin depeg | −1 | documented prior (never happened in the window) |
| #36 same-deployer bundle | −1 | crash p<0.001 |
| #37 discovery burst | +1 | pump p=0.007, 14.5h early |
| all others | 0 | information only until they show an edge |

The total is floored at −15. Contract-scan-sourced hits add only the cap, so they aren't counted twice. #3 and #33 started at −1 and were set to 0 after the backtest (#3 fired more in runners; #33 had no edge). #35 was set to 0 after calibration (below).

## #35 liquidity/mcap floor: calibration
Calibrated on `data/calls.json` live-feed calls using liquidity and market cap **at call time** (n=2467). The outcome is rugged/−70% vs ran 2x. Post-crash values were not used, to avoid leaking the outcome. **Result: no floor separates rugs.** At every candidate floor (2–10%+), tokens below it rugged *less* often (at 5%: 8.3% below vs 20.8% above, Youden J −0.14), and they also ran 2x less often. A low ratio marks quiet tokens, not rugs. **Chosen value: 5%, shown as information only, weight 0.**

## Nansen
Endpoints: `tgm/dex-trades` only (tape, smart money only, and sells around the peak), 1 credit per call, all cached under `data/patternlab_cache/`, with every call logged with before/after balance in `data/patternlab_nansen_ledger.json`. **This job used 137 credits** (soft budget 250). The account went from 1678 to 1447 over the run; the extra drop came from other workers using the same key at the same time. No call cost more than 1 credit, none was refused, and the balance never came near the 300 floor. Dev and buyer first-funder lookups (#3, #15, #33) used free public RPC instead of Nansen profiler. **Proposals (not run):** Nansen premium labels / `profiler/address/labels` (100+ credits each) to label serial-dev funders and cross-token community wallets for #3/#15. No paid X reads and no new Grok spend.

## Caveats
n=50, so p-values are rough and many patterns are flat. Several "crash-predictive" patterns are near-universal on launchpad tokens. Buyer profiles for #33 cover the first 15 distinct buyers (public RPC limits), and wallets with >1000 signatures count as "not fresh". Live coverage is the top ~200 live-feed Solana tokens. GeckoTerminal tape/OHLCV for the top 20 is refreshed in the background (`pl_live.py`) when `patternlab_live.json` is older than 30 min.
