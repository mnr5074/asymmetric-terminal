# Buyback & Burn Research — 2026-10-11 (data through 2026-10-10 UTC)

Script: `research/buyburn/buyburn.py` (fetch, revenue, burns) + `buyburn_analysis.py` (stats, projections) + `make_tables.py`.
Data: `research/buyburn/data/buyburn_revenue.json, buyburn_tokens.json, buyburn_events.json, buyburn_daily.json, buyburn_stats.json, buyburn_projections.json` (projections also copied to `/workspace/sol-terminal/data/buyburn_projections.json`). Raw caches: `data/raw/`.
Re-run: `cd research/buyburn && .venv/bin/python buyburn.py revenue && .venv/bin/python buyburn.py burns && .venv/bin/python buyburn_analysis.py && .venv/bin/python make_tables.py`

Free sources only: DefiLlama (`api.llama.fi/overview/fees`, `/summary/fees/{parent}?dataType=dailyFees|dailyRevenue|dailyHoldersRevenue`, `coins.llama.fi` prices, public emissions dataset `defillama-datasets.llama.fi/emissions/{slug}`), CoinGecko free (365d price/mcap/volume, current supply), Hyperliquid info API (`tokenDetails`, `spotClearinghouseState` for the Assistance Fund 0xfefe…fe), ultrasound.money (ETH staked), plus official burn announcements (BNB Chain blog, OKX burn reports, Bitget, SunSwap, Lighter, Pump.fun, Uniswap) and news. No Nansen or X APIs were used.

## 1. Revenue ranking (parent-protocol level, DefiLlama)
30d = the 30 full UTC days to 2026-10-10. Annualized = 30d × 365/30. Trend = last 30d vs the prior 30d, and last 90d vs the prior 90d. "Holders rev" is what DefiLlama counts as going to token holders (buybacks, burns or distributions).

| # | Protocol | Token | Category | Fees 30d $M | Revenue 30d $M | Rev annualized $M | Rev vs prior 30d | Rev 90d vs prior 90d | Holders rev (buyback/burn) 30d $M |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Tether | - | Stablecoin Issuer | 516.9 | 516.93 | 6,289 | +7.6% | +0.9% | – |
| 2 | Circle | - | RWA | 211.8 | 211.10 | 2,568 | +8.9% | +2.2% | – |
| 3 | Hyperliquid | HYPE | Derivatives | 88.0 | 71.41 | 869 | -5.0% | +23.0% | 71.41 |
| 4 | Pump | PUMP | Launchpad | 190.7 | 63.73 | 775 | +12.3% | +74.8% | 28.68 |
| 5 | StonkFun | STONK | Launchpad | 25.4 | 25.36 | 309 | +265.0% | – | 12.66 |
| 6 | fomo | - | Trading App | 26.7 | 24.91 | 303 | -2.7% | +602.6% | – |
| 7 | GMGN | - | Trading App | 29.0 | 23.93 | 291 | -39.1% | +257.6% | – |
| 8 | Tron | – | Chain | 23.7 | 23.68 | 288 | -2.5% | -13.5% | 23.68 |
| 9 | Grayscale | - | RWA | 18.0 | 18.00 | 219 | +8.9% | -4.4% | – |
| 10 | Axiom | - | Trading App | 37.9 | 17.94 | 218 | +6.5% | +89.2% | 0.00 |
| 11 | Collector Crypt | CARDS | Physical TCG | 15.9 | 15.86 | 193 | +73.6% | +10.3% | 0.02 |
| 12 | Polymarket | - | Prediction Market | 107.6 | 14.90 | 181 | -20.4% | -1.0% | – |
| 13 | Sky | SKY | CDP | 27.4 | 13.53 | 165 | +0.6% | -2.3% | 5.75 |
| 14 | World Liberty Financial | WLFI | Lending | 12.2 | 12.21 | 149 | +14.3% | -2.3% | 0.00 |
| 15 | Uniswap | UNI | Dexs | 138.1 | 10.90 | 133 | -21.5% | +129.6% | 10.90 |
| 16 | Pons | PONS | Launchpad | 69.8 | 10.90 | 133 | -41.9% | – | 9.97 |
| 17 | Paxos | PAXG | RWA | 19.8 | 9.33 | 114 | +6.8% | -8.5% | 0.00 |
| 18 | Flap sh | - | Launchpad | 35.3 | 8.41 | 102 | -29.8% | +593.1% | – |
| 19 | Phantom | - | Wallets | 8.0 | 8.00 | 97 | -4.0% | +6.1% | – |
| 20 | Aerodrome | AERO | Dexs | 11.6 | 7.71 | 94 | -42.1% | +54.1% | 7.71 |
| 21 | Ripple USD | - | Stablecoin Issuer | 7.2 | 7.22 | 88 | +25.3% | +34.5% | – |
| 22 | Meteora | MET | Dexs | 58.6 | 6.73 | 82 | +110.5% | +112.3% | 0.73 |
| 23 | Raydium | RAY | Dexs | 39.6 | 6.55 | 80 | +124.6% | +300.5% | 3.95 |
| 24 | Jupiter | JUP | DEX Aggregator | 18.0 | 5.81 | 71 | -14.0% | +17.2% | 2.90 |
| 25 | PancakeSwap | CAKE | Dexs | 16.4 | 5.39 | 66 | -29.6% | +68.9% | 3.57 |
| 26 | Aave | AAVE | Lending | 38.1 | 4.94 | 60 | +4.9% | -28.4% | 0.00 |
| 27 | Lighter | LIT | Derivatives | 5.7 | 4.71 | 57 | +17.7% | +47.3% | 2.65 |
| 28 | Chainlink | LINK | Oracle | 4.5 | 4.35 | 53 | -21.3% | -3.4% | 4.35 |
| 29 | Lido | LDO | Liquid Staking | 52.1 | 3.22 | 39 | +15.5% | +11.9% | 2.25 |
| 30 | edgeX | EDGE | Derivatives | 3.6 | 2.64 | 32 | -19.4% | -55.0% | 0.61 |
| 31 | GMX | GMX | Derivatives | 5.4 | 1.49 | 18 | -3.2% | +3.7% | 0.31 |
| 32 | SUN | SUN | Dexs | 0.8 | 0.06 | 1 | -51.1% | +36.7% | 0.04 |
| 33 | Aster Perps | ASTER | Derivatives | 5.2 | – | – | – | – | 3.57 |

Notes: Tether, Circle, Paxos and Grayscale have no buyback token. fomo, GMGN, Axiom, Phantom and Flap have no token or no buyback. Pump's fees ($191M) include PumpSwap LP fees; its revenue is $63.7M. DefiLlama reports no "revenue" for Aster: Perps fees are $5.24M/30d and the buyback series sits under `aster-spot`. Hyperliquid fees exclude the separate "Hyper Foundation HYPE Staking" adapter ($34M/30d of staking rewards). edgeX revenue fell 55% over 90d versus the prior 90d. Lighter rose 47%. Hyperliquid fell 5% m/m but rose 23% over 90d.

## 2. Buyback / burn token list (verified)
Mechanism key: **burn** means the bought tokens are destroyed. **treasury** means they are held. **distrib** means they are paid to stakers. **mixed** means part is burned. **matched_reserve_burn** (ASTER) means the bought tokens go to stakers and an equal amount is burned from the unvested team reserve, which cuts total supply but not circulating supply.

| Token | Verdict | Funding | Key facts / source |
|---|---|---|---|
| HYPE | **burn** (formalized 2025-12-24) | ~97–99% of trading fees, automatic L1 Assistance Fund (AF) | Validator vote: 85% yes to treat AF HYPE as burned (crypto.news, The Block). On-chain right now (Hyperliquid API), the AF holds **47,954,219 HYPE**, cost basis **$1.361B**. |
| PUMP | treasury (Jul-25→Apr-26) → **burn** | Was 100% of revenue; since 2026-04-28, 50% of net revenue for 1 year via a locked contract | On 2026-04-29 all repurchased PUMP was burned (~$370M, ~36% of circ, The Block). Dashboard: **$472.06M, 169.51B PUMP burned** (pump.fun/pump-token). |
| UNI | **burn** | Protocol fees on v2 and some v3 pools, plus Unichain net fees | UNIfication passed 2025-12-25. Retro burn of 100M UNI on 2025-12-28 (treasury, not fee-funded). A 20M UNI/yr growth budget offsets part of it. |
| BNB | **burn** | Quarterly Auto-Burn (formula on price and blocks; not directly revenue-linked since 2021-12) plus BEP-95 gas burn | 36 quarterly burns; #36 = 1,615,827.8 BNB on 2026-07-15; supply 133.17M (BNB Chain blog). Before auto-burn, burns used 20% of Binance profit. |
| OKB | burn, **ended** | OKX revenue, quarterly 2019-05→2025-06 | One-time burn of 65,256,712 OKB on 2025-08-15. Supply fixed at 21M; no ongoing burn (OKX). |
| BGB | burn | 2025: GetGas formula, ~30M per quarter. 2026: Morph fees × booster, ~3M per quarter | 2026 burns come from the locked Morph treasury, so they cut total supply, not circulating (MrNasdog on-chain check). Q3/Q4-2025 amounts not found (see limitations). |
| CAKE | **burn** (net of emissions) | Trading fees and other revenue, weekly | DefiLlama holdersRevenue. |
| ETH | protocol burn (EIP-1559) | Base fees | Recent burn is only ~51 ETH/day ($122k/day), against ~3,000 ETH/day issuance → net inflationary. |
| TRX | protocol burn | Energy/bandwidth fees | ~2.5M TRX/day burned vs ~4M/day gross issuance (inferred) → net inflationary. |
| SUN | **burn** | SunSwap V2 0.05%, SunPump, SunX; quarterly | 51 rounds; 678.5M SUN cumulative by 2026-07-25 (SunSwap). The latest round is tiny ($0.17M). |
| LIT | treasury → **burn** | 100% of fees | Burned 15,638,702 LIT on 2026-07-10 (Q2 buybacks, ~6.3% of circ). All future buybacks are burned (Lighter, Gate). |
| EDGE | **burn** (edgeX page: "Buyback Burn 4.93%") | Protocol revenue | $45.1M in Q2-26, $1.2M in Q3-26. The revenue→buyback link is not independently verified (perpsatlas). |
| ASTER | matched_reserve_burn | 99% of daily fees (since 2026-06-17) | Bought ASTER goes to veASTER stakers; an equal amount is burned from the team reserve. 207.4M burned across all programs by 2026-10-05. |
| SKY | mixed (mostly not burned) | Smart Burn Engine (surplus) | First real protocol burn: 2.86M SKY, Sep-2026. |
| JUP | **treasury** (Litterbox, 3-yr lock) | 50% of fees | Not burned. Still active ($2.9M/30d). |
| RAY | **treasury** | 12% of swap fees | Held at a public address. |
| LINK | treasury (Chainlink Reserve) | Service revenue | No burn. |
| GMX | treasury/distrib | 27% of fees | No burn. The DefiLlama GMX holder series is mostly historical ETH/AVAX distributions, so GMX is excluded from the stats. |
| AERO | **not a buyback** | — | veAERO voters receive fees ($7.7M/30d holders revenue = distribution). |
| BONK, ORE, LDO | mixed / treasury | launchpad revenue / mining fees / Lido | Labelled mixed by DefiLlama; disposition not fully verified. |

Not analysed (no free daily data gathered): GT, KCS, CRO, WOO, SOL (50% base-fee burn, negligible), STONK/PONS (new launchpads with large holders revenue: $12.7M and $10.0M per 30d).

### Cumulative program data (DefiLlama holdersRevenue → tokens at daily price)
| Token | Mechanism | Program start (DefiLlama series) | Cum. bought USD $M | Cum. tokens (M) | Cum. as % circ now | Avg/day last 90d (tokens) | Avg/day last 90d $k | Median % of daily vol (90d) |
|---|---|---|---|---|---|---|---|---|
| HYPE | burn | 2024-12-23 | 1,336.9 | 37.63 | 16.92% | 26,357 | 1992 | 0.288% |
| PUMP | treasury->burn | 2025-07-15 | 383.6 | 141,228.35 | 30.49% | 241,217,234 | 806 | 0.543% |
| UNI | burn | 2025-12-29 | 55.9 | 13.10 | 2.10% | 62,267 | 336 | 0.079% |
| SKY | mixed | 2024-11-14 | 170.0 | 2,622.79 | 11.19% | 1,666,091 | 114 | 0.816% |
| BONK | mixed | 2025-05-04 | 43.3 | 3,897,580.22 | 4.43% | 20,548,802,812 | 66 | 0.013% |
| LINK | treasury | 2025-08-07 | 69.1 | 6.16 | 0.80% | 15,719 | 161 | 0.000% |
| RAY | treasury | 2023-01-01 | 66.1 | 50.23 | 18.61% | 62,608 | 74 | 0.206% |
| CAKE | burn | 2021-04-24 | 356.4 | 88.34 | 24.70% | 66,642 | 124 | 0.223% |
| ASTER | matched_reserve_burn | 2026-01-20 | 27.2 | 43.67 | 1.61% | 190,765 | 128 | 0.145% |
| ORE | mixed | 2025-10-20 | 41.3 | 0.45 | 88.66% | 1,229 | 90 | 10.229% |
| JUP | treasury | 2025-02-17 | 102.2 | 308.32 | 9.29% | 403,174 | 91 | 0.209% |
| LIT | treasury->burn | 2026-01-05 | 29.9 | 17.86 | 7.14% | 26,161 | 83 | 0.127% |
| LDO | treasury | 2026-06-01 | 7.1 | 20.30 | 2.45% | 80,509 | 34 | 0.000% |
| EDGE | burn | 2026-04-02 | 47.3 | 49.13 | 14.04% | 48,341 | 21 | 0.589% |
| GMX | treasury/distrib | 2021-09-03 | 135.3 | 5.16 | 49.25% | 1,891 | 13 | 0.378% |
| ETH | burn(protocol) | 2021-08-05 | 13,133.1 | 4.64 | 3.80% | 51 | 122 | 0.001% |
| TRX | burn(protocol) | 2022-11-23 | 1,807.7 | 11,891.52 | 12.52% | 2,521,812 | 839 | 0.230% |
| BNB | burn | 2025-06-04 | 28.1 | 0.03 | 0.03% | 83 | 56 | 0.007% |
| OKB | burn(ended) | – | – | – | – | – | – | – |
| BGB | burn | – | – | – | – | – | – | – |
| SUN | burn | – | – | – | – | – | – | – |

Cross-checks against official/on-chain figures:
- **HYPE:** DefiLlama gives $1,337M and 37.6M HYPE since 2024-12-23. On-chain, the AF holds 47.95M HYPE with a $1,361M cost basis. USD matches within 2%. The token gap comes from the AF buying from 2024-11-29 (before the DefiLlama series starts) at $3–15 prices, plus daily-price averaging. **Use 47.95M as the authoritative cumulative**: 21.6% of CoinGecko circ (222.4M), or 15.9% of the Hyperliquid API circulatingSupply (302.2M). The two circ definitions differ.
- **PUMP:** DefiLlama shows $384M and 141B PUMP; the official dashboard shows $472M and 169.5B. DefiLlama under-counts by about 19%.
- **EDGE:** 49.1M tokens matches edgeX's "4.93% of 1B" (49.3M).
- **LIT:** 17.9M bought by DefiLlama, consistent with 15.64M burned through Q2.

## 3. Event histories (discrete burns), with price at the event and after
All periodic events are in `data/buyburn_events.json` (BNB 36, OKB 29, BGB 5, plus one-offs). Each event has price D-1, D0, +24h, +7d, +30d (coins.llama daily close), BTC returns, and excess returns. Rows from 2024 onward:

| Token | Date | Amount | USD $M | % circ | % 30d-avg daily vol | Ret 24h | XS 24h | XS 7d | XS 30d | Date quality |
|---|---|---|---|---|---|---|---|---|---|---|
| HYPE | 2025-12-24 | 37,500,000 | 912.0 | 15.74% | 267% | +1.1% | +2.1% | +4.3% | -15.0% | exact |
| PUMP | 2026-04-29 | 194,770,901,235 | 370.0 | 33.01% | 847% | -1.9% | +0.1% | -0.1% | +0.7% | blog |
| UNI | 2025-12-28 | 100,000,000 | 596.0 | 15.88% | 166% | +6.7% | +6.1% | -2.2% | -20.3% | exact |
| LIT | 2026-07-10 | 15,638,702 | 37.5 | 6.26% | 68% | +15.4% | +12.4% | -4.7% | -6.5% | exact |
| BNB | 2024-01-17 | 2,141,487 | 674.9 | 1.42% | – | -2.6% | -3.1% | +0.3% | -10.4% | blog |
| BNB | 2024-04-24 | 1,944,452 | 1,180.0 | 1.31% | – | +0.5% | +4.4% | +4.8% | -2.6% | exact |
| BNB | 2024-07-22 | 1,643,698 | 990.3 | 1.12% | – | -1.0% | -1.6% | -3.2% | +8.1% | blog |
| BNB | 2024-10-30 | 1,772,712 | 1,074.1 | 1.22% | – | -0.8% | -4.3% | -5.4% | -27.9% | blog |
| BNB | 2025-01-15 | 1,634,201 | 1,141.2 | 1.14% | – | +3.9% | -2.5% | -11.8% | -5.1% | approx |
| BNB | 2025-04-15 | 1,579,208 | 923.0 | 1.11% | – | -0.7% | -0.7% | -2.4% | -12.2% | blog |
| BNB | 2025-07-10 | 1,595,600 | 1,067.7 | 1.14% | – | +3.8% | -2.6% | -1.8% | +13.0% | blog |
| BNB | 2025-10-27 | 1,441,281 | 1,640.6 | 1.04% | 35% | +2.0% | -0.2% | -2.0% | -1.0% | blog |
| BNB | 2026-01-15 | 1,371,804 | 1,301.6 | 1.00% | 128% | -1.3% | -1.5% | -0.1% | -6.5% | blog |
| BNB | 2026-04-15 | 1,569,307 | 964.0 | 1.15% | 103% | +1.2% | +0.8% | +0.2% | +1.4% | exact |
| BNB | 2026-07-15 | 1,615,828 | 939.7 | 1.20% | 136% | +2.4% | -1.6% | -5.6% | +5.8% | exact |
| OKB | 2024-03-13 | 11,476,883 | 755.6 | 5.23% | – | +7.1% | +5.8% | -2.6% | -13.3% | exact |
| OKB | 2024-06-12 | 12,133,523 | 551.3 | 5.84% | – | -1.3% | +0.5% | -2.7% | -4.8% | exact |
| OKB | 2024-09-18 | 17,337,196 | 661.1 | 8.86% | – | -0.1% | -6.2% | -6.3% | -10.2% | exact |
| OKB | 2024-12-06 | 18,488,690 | 1,049.4 | 10.37% | – | +2.5% | +1.4% | -6.5% | -11.7% | exact |
| OKB | 2025-03-14 | 31,158,862 | 1,289.7 | 19.49% | – | +11.3% | +11.1% | +24.4% | +27.7% | exact |
| OKB | 2025-06-19 | 42,437,632 | 2,042.5 | 32.98% | – | +7.7% | +7.6% | +2.5% | -13.2% | exact |
| OKB | 2025-08-15 | 65,256,712 | 6,353.4 | 75.65% | – | -11.7% | -6.8% | +126.6% | +97.4% | exact |
| BGB | 2025-04-09 | 30,006,905 | 120.3 | 2.56% | – | +3.9% | -0.5% | -2.6% | -21.4% | blog |
| BGB | 2025-07-10 | 30,001,053 | 132.3 | 2.56% | – | +6.2% | -0.2% | +0.7% | -3.4% | blog |
| BGB | 2026-01-23 | 3,060,000 | 11.2 | 0.44% | 19% | +0.2% | +0.1% | +0.9% | -12.0% | approx |
| BGB | 2026-04-09 | 3,000,000 | 5.7 | 0.43% | 26% | +3.4% | +3.7% | -1.7% | +3.4% | approx |
| BGB | 2026-07-14 | 3,010,400 | 4.9 | 0.43% | 44% | +1.5% | -0.4% | -3.6% | +1.7% | exact |
| SUN | 2026-07-25 | 9,025,027 | 0.2 | 0.05% | 0% | -0.3% | +0.8% | +0.4% | -23.0% | exact |

Continuous programs (HYPE, PUMP, UNI, CAKE, JUP, RAY, LIT, EDGE, ASTER, SKY, ETH, TRX, BNB BEP-95, …) are aggregated daily in `data/buyburn_daily.json`, with USD, tokens, price, circ, % of circ and % of CoinGecko volume.

## 4. Does burn size move price? (excess return = token return − BTC return, pp)
**A. Discrete periodic burns (BNB + OKB + BGB, n = 69; OKB's 2025-08 one-time burn excluded).**
- Mean excess return after the event: 24h −0.80pp (p = 0.51), 7d −1.75pp (p = 0.17), 30d median −2.9pp (the mean of +18pp is driven by 2017–2021 outliers; p = 0.33). Hit rate is 42–43% at every horizon.
- Burn size (% of circ) vs excess return:
  - 24h: r = 0.18 (p = 0.14), Spearman ρ = 0.16 (p = 0.18). Winsorized r = 0.28 (p = 0.02) is the only nominally significant result and does not hold in rank terms.
  - 7d: r = 0.17 (p = 0.16), ρ = 0.05 (p = 0.68).
  - 30d: r = −0.05 (p = 0.70).
- 2019+ only (n = 58): every correlation has p > 0.1.
- BNB alone (n = 36): excess return after a burn is negative on average (24h −3.4pp, p = 0.08; 7d −3.0pp, p = 0.08). Burn %circ vs returns: ρ ≈ −0.05 to −0.15, all p > 0.15.
- OKB (n = 28): 24h +2.2pp (p = 0.16), 30d −4.0pp (p = 0.22). ρ(size, 30d) = 0.23 (p = 0.25).
- Threshold buckets by burn size (% circ: <0.5, 0.5–1, 1–2, >2): no bucket has a significant positive excess return at 7d or 30d. BNB's 1–2% bucket: 7d −4.2pp (n = 25, p = 0.02).
- Volume-relative size (burn USD / 30d average daily volume) is only measurable for the 7 events within the last 365 days. These burns were 19–136% of a day's volume; correlation with 24h excess return r = −0.59 (p = 0.17). Not enough data.
- **Conclusion: scheduled, pre-announced quarterly burns are priced in. Neither the event nor its size predicts excess returns.**
- The large one-offs (HYPE 15.7% of circ, UNI 15.9%, PUMP ~33%, LIT 6.3%) gave a 24h pop for UNI (+6.1pp) and LIT (+12.4pp). All four had **negative** 30d excess returns, except PUMP (+0.7pp). The OKB Aug-2025 restructuring (+127pp over 7d) was driven by the announcement (X Layer upgrade, fixed supply), not the burn mechanics.

**B. Continuous fee-funded programs (daily data, 17 tokens, ~8,800 token-days).**
Regression of next-day return on BTC return plus buyback size:
- **Buyback as % of circulating supply** (token terms): significantly positive for HYPE (t = 2.5, p = 0.01), PUMP (t = 3.6), UNI (t = 3.6), RAY (t = 3.8), ASTER (t = 2.9), JUP (t = 2.1) and BONK (t = 2.1). Not significant for CAKE, SKY, LINK, LIT, EDGE or ORE. Negative for BNB, ETH and LDO.
  - Pooled (within-token z-scores): r = 0.05 to next-day excess (p < 0.001) and 0.06 to next-7d excess.
  - Burn-type tokens: r = 0.06, ρ = 0.06.
  - This explains about 0.3% of variance.
- **Buyback as % of that day's volume** (USD/USD, which does not depend on price): not significant for any major token at the 5% level except ASTER (t = 2.2, p = 0.03).
  - Pooled: r = 0.02 (p = 0.23), Spearman 0.04 (p = 0.002).
  - Weekly non-overlapping: HYPE r = 0.10 (p = 0.49), PUMP 0.00 (p = 1.0).
- **Why % of circ "works" but % of volume does not:** tokens bought = USD / price, so a falling price mechanically raises the token count bought, and short-term reversal then shows up as a "buyback effect". Fees are also higher on volatile days. The price-neutral measure (% of volume) shows essentially nothing, so **the % of circ result should not be read as causal**.
- Threshold buckets (pooled, buyback % of daily volume, next 7d excess return; p adjusted for overlapping windows):
  - <0.25%: +0.3pp (n = 3,210)
  - 0.25–0.5%: +1.7pp (p = 0.13)
  - 0.5–1%: +2.1pp (p = 0.23)
  - **1–2%: +4.9pp (median +1.7, n = 264, p_adj = 0.056)**
  - 2–5%: +2.2pp (p = 0.79)
  - >5%: +4.5pp (median −1.5, p = 0.32)
  - Next-day buckets are monotone from +0.03pp to +1.0pp up to 5% of volume, but none is significant (p ≥ 0.15).
  - **Best read:** a weak, non-robust hint that buybacks of ≥1–2% of daily volume help over about a week. Below about 0.5% of volume (where HYPE, UNI, CAKE, JUP and most programs sit), there is no detectable effect.

**C. The HYPE example.**
- The AF buys about **$2.0M/day** (last 90 days), roughly 26k HYPE/day, down from 60–77k/day in H1-2025 as the price rose.
- Relative to CoinGecko spot volume, that is a **median of 0.42% of daily volume** (p10 0.16%, p90 0.95%, max 3.5%; n = 364) and about **0.024% of circ per day** (≈ 4.3% of circ per year at the current pace).
- Results:
  - Next-day excess return vs % of volume: r = −0.01 (p = 0.86).
  - Weekly (n = 51): r = 0.10 (p = 0.49).
  - Monthly (n = 11): r = 0.34 (p = 0.31).
  - Buckets by % of volume: <0.25% gives +0.57pp next day; 1–2% gives −0.30pp. Nothing significant.
  - Token-denominated size: next-day t = 2.5 (p = 0.01). 1 SD more (0.015% of circ) goes with +0.43pp next day, but this is subject to the price-reversal artifact above.
- Since the program start (2024-12-23), HYPE is +199% vs BTC −13%, an excess of +212pp. That is consistent with buybacks absorbing a large share of float (47.95M HYPE ≈ 16–22% of circ). But **day-to-day changes in AF size do not predict HYPE returns**. The AF is a steady, predictable bid (about 0.4% of volume). Its value shows up as a long-run supply sink tied to revenue, not as a short-term catalyst.

## 5. Burn rate and net supply projections (current rate held constant)
Net supply = circ_now − burned + unlocked.
- **Burn rate:** trailing 90-day average in tokens. For BNB, the last 4 quarterly burns plus BEP-95. For BGB, 2026 quarters. For SUN, the last round.
- **Unlocks:** the DefiLlama emissions schedule where it extends forward (PUMP, LIT, EDGE, ASTER). Otherwise the trailing-90d realized unlock rate.
- **ETH issuance:** 940.87·√validators per year, with 44.28M ETH staked (ultrasound.money); this is a theoretical maximum.
- **TRX issuance:** inferred from the CoinGecko 90d net change plus burns.
- Treasury buybacks (JUP, RAY, LINK, SKY, LDO, BONK) are not subtracted. See `bought_not_burned_tokens` and `net_float_ex_treasury_buys` in the JSON.

| Token | Circ now (M) | Burn/day (tokens) | Burn %circ/yr | 1m | 3m | 6m | 9m | 1y | 2y | 3y | 1y burned (M) | 1y unlocked (M) | Unlock basis |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HYPE | 222.4 | 26,357 | 4.32% | +0.3% | +1.0% | +2.0% | +3.1% | +4.1% | +8.2% | +12.3% | 9.62 | 18.72 | DefiLlama emissions: no forward schedule -> trailing-90d realized unlo |
| PUMP | 463,189.0 | 241,217,234 | 19.01% | -0.1% | -0.3% | -0.6% | -0.9% | -1.2% | -2.4% | -6.6% | 88,044.29 | 82,500.00 | DefiLlama emissions schedule (defillama-datasets.llama.fi/emissions/pu |
| UNI | 625.0 | 62,267 | 3.64% | -0.3% | -0.9% | -1.8% | -2.7% | -3.6% | -7.2% | -10.8% | 22.73 | 0.20 | DefiLlama emissions: no forward schedule -> trailing-90d realized unlo |
| SKY | 23,433.2 | 0 | 0.00% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | 0.00 | 0.00 | DefiLlama emissions: no forward schedule -> trailing-90d realized unlo |
| BONK | 87,994,363.9 | 0 | 0.00% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | 0.00 | 0.00 | CoinGecko 90d net circ change (+burn) used as unlock proxy |
| LINK | 766.8 | 0 | 0.00% | +0.8% | +2.5% | +4.9% | +7.4% | +9.9% | +19.8% | +29.7% | 0.00 | 76.04 | DefiLlama emissions: no forward schedule -> trailing-90d realized unlo |
| RAY | 269.9 | 0 | 0.00% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | 0.00 | 0.00 | DefiLlama emissions: no forward schedule -> trailing-90d realized unlo |
| CAKE | 357.6 | 66,642 | 6.80% | -0.4% | -1.2% | -2.4% | -3.5% | -4.7% | -9.5% | -14.2% | 24.32 | 7.39 | DefiLlama emissions: no forward schedule -> trailing-90d realized unlo |
| ASTER | 2,713.6 | 0 | 0.00% | +0.4% | +1.4% | +2.7% | +4.1% | +5.4% | +10.8% | +16.2% | 0.00 | 146.97 | DefiLlama emissions schedule (defillama-datasets.llama.fi/emissions/as |
| ORE | 0.5 | 0 | 0.00% | +8.3% | +25.1% | +50.1% | +75.2% | +100.5% | +201.0% | +301.5% | 0.00 | 0.51 | DefiLlama emissions: no forward schedule -> trailing-90d realized unlo |
| JUP | 3,319.4 | 0 | 0.00% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | 0.00 | 0.00 | DefiLlama emissions: no forward schedule -> trailing-90d realized unlo |
| LIT | 250.0 | 26,161 | 3.82% | -0.3% | +1.2% | +16.9% | +32.6% | +48.4% | +111.2% | +174.0% | 9.55 | 130.51 | DefiLlama emissions schedule (defillama-datasets.llama.fi/emissions/li |
| LDO | 829.6 | 0 | 0.00% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | 0.00 | 0.00 | DefiLlama emissions: no forward schedule -> trailing-90d realized unlo |
| EDGE | 350.0 | 48,341 | 5.04% | -0.4% | -1.3% | -1.3% | +1.0% | +6.9% | +79.8% | +155.7% | 17.64 | 41.67 | DefiLlama emissions schedule (defillama-datasets.llama.fi/emissions/ed |
| GMX | 10.5 | 0 | 0.00% | +0.1% | +0.3% | +0.7% | +1.0% | +1.4% | +2.7% | +4.1% | 0.00 | 0.14 | DefiLlama emissions: no forward schedule -> trailing-90d realized unlo |
| ETH | 122.1 | 51 | 0.02% | +0.1% | +0.2% | +0.4% | +0.7% | +0.9% | +1.8% | +2.7% | 0.02 | 1.11 | PoS issuance estimate = 940.87*sqrt(validators)/yr with 44.28M ETH sta |
| TRX | 94,991.3 | 2,521,812 | 0.97% | +0.0% | +0.1% | +0.3% | +0.4% | +0.6% | +1.1% | +1.7% | 920.46 | 1,446.88 | gross issuance inferred = CoinGecko 90d net circ change + burn (protoc |
| BNB | 133.2 | 16,516 | 4.53% | -0.4% | -1.1% | -2.3% | -3.4% | -4.5% | -9.1% | -13.6% | 6.03 | 0.00 | no emissions (all supply circulating) |
| OKB | 21.0 | 0 | 0.00% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | 0.00 | 0.00 | fixed 21M supply |
| BGB | 700.0 | 33,225 | 1.73% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | +0.0% | 12.13 | 0.00 | CoinGecko 90d net circ change (+burn) used as unlock proxy |
| SUN | 19,222.2 | 99,176 | 0.19% | -0.0% | -0.0% | -0.1% | -0.1% | -0.2% | -0.4% | -0.6% | 36.20 | 0.00 | DefiLlama emissions: no forward schedule -> trailing-90d realized unlo |

How to read it:
- **Net deflationary at the current rate:** BNB (−4.5%/yr), CAKE (−4.7%/yr; emissions 7.4M vs burns 24.3M per year), UNI (−3.6%/yr), PUMP (−1.2%/yr — burns of 88B/yr roughly match investor/team unlocks of 82.5B/yr; the 50% contract is only committed until ~Apr-2027), and SUN (−0.2%/yr).
- **HYPE:** base case +4.1%/yr (burns 9.6M vs documented realized unlocks 18.7M per year). Upper scenario: if the 237.9M HYPE held at non-circulating 0x43e9…a251 (Hyperliquid API) vested linearly to end-2027, net supply would rise about **+83% in 1 year**. Treat +4%/yr as a lower bound for dilution; the true vesting cadence is not published in a free machine-readable form.
- **LIT** (+48%/yr) and **EDGE** (+7% in 1y, +80% in 2y): unlock schedules swamp burns. LIT's 500M insider unlock starts 2026-12-27; burns are only about 3.8% of circ per year.
- **ETH:** +0.9%/yr (burn about 18k ETH/yr vs about 1.1M issuance). **TRX:** +0.6%/yr.
- **ASTER** (+5.4%/yr circ): reserve burns cut total supply and future unlocks, not current float.
- **BGB:** 2026 burns are paid from the treasury, so circ is flat. **OKB:** flat (fixed 21M).
- **ORE** (+100%/yr): emits about 1,440 ORE/day against a 0.5M circ.

## 6. Cumulative burn % vs price performance
- **Across tokens** (17 programs; excess return vs BTC since each program started):
  - Cumulative % of circ vs total excess return: r = 0.33 (p = 0.19), ρ = 0.27 (p = 0.30).
  - Annual burn % vs annualized log excess return: r = 0.49 (p = 0.048). This is **entirely due to ORE**: excluding ORE gives r = −0.33 (p = 0.21), ρ = 0.14 (p = 0.61).
  - Buyback yield (annualized buybacks / market cap) vs annualized excess return: r = 0.49 (p = 0.04) with ORE, r = −0.34 (p = 0.20) without.
  - Burn-type tokens only (n = 9): ρ = −0.10 (p = 0.80).
  - Winners: HYPE (+212pp), RAY (+1,120pp since 2023), TRX (+146pp), LIT (+47pp). Losers despite large buybacks: CAKE (24.7% of circ burned since 2021, −153pp vs BTC), EDGE (14% of circ bought in 6 months, −69pp), JUP (9.3%, −43pp), BONK (−66pp).
- **Over time** (non-overlapping 90-day blocks, pooled n = 96): buyback % of circ in a block vs that block's excess return r = 0.19 (p = 0.06), ρ ≈ 0; vs the next block r = 0.01 (p = 0.96).
- **Conclusion:** cumulative burn share does not explain cross-sectional or forward performance once dilution, revenue growth and the one outlier are accounted for. Revenue growth and net supply (burns minus unlocks) matter more than gross burns.

## 7. Limitations
- **Small samples.** Discrete events n = 69 (BNB 36, OKB 28, BGB 5); volume-scaled events only n = 7. Cross-section n = 17. Many p-values are near the threshold, and many tests were run, so expect false positives (no multiple-testing correction applied).
- **Endogeneity.** Buybacks are funded by fees, and fees rise with volatility and volume. Token-denominated size is mechanically higher after price drops. Excess return assumes BTC beta = 1. The OLS with an estimated beta (1.0–1.8 for most tokens) gives the same conclusions.
- **DefiLlama holdersRevenue** is USD-valued receipts, not exact on-chain buy fills. Tokens were computed at the daily price (coins.llama 00:00 UTC). Known under-counts: PUMP (−19%) and HYPE tokens (pre-2024-12-23 history missing). EDGE's revenue→buyback link is unverified. SKY, BONK and ORE are "mixed", with no burned/distributed split.
- **Date quality.** Several BNB burn dates are blog-publication or approximate (flagged `quality=blog|approx`; "exact only" subsets reported). The BNB 18–21, 23, 25 and 30 burns use news amounts; the 30th amount is from search results.
- **Supply denominators.** Circulating supply history is only available for the last 365 days (CoinGecko free). Earlier HYPE circ is spliced from DefiLlama emissions. Older BNB/OKB/BGB events use total-supply proxies; OKB % is therefore understated, and the 2025 OKB figures (19–76%) are of total minus prior burns. HYPE circ differs between CoinGecko (222M) and the Hyperliquid API (302M).
- **Volume** is CoinGecko aggregate spot (last 365 days only). No perps volume.
- **Projections** hold the current token burn rate constant (not USD). That is wrong if price or revenue changes. Unlock schedules are missing or stale for JUP (series ended 2026-02-25), RAY (ended 2024), SKY (MKR→SKY conversions distort circ), BONK and LDO; these are set to 0 and flagged in the JSON.
- **Not found in free sources:** BGB Q3/Q4-2025 burn amounts; SUN per-round history (only round 51 used); exact on-chain timestamps for BNB burns #18–#30 (BscScan/BNB Beacon explorer could provide them with an API key); OKX/Bitget exchange-token buybacks beyond the official reports.

### Paid lookups NOT done (estimated cost)
| Lookup | Why | Est. cost |
|---|---|---|
| CoinGecko Analyst/Lite API | Full-history daily volume and circulating supply (>365d) for volume-scaled tests on pre-2025 events | ~$129/mo (Analyst) |
| DefiLlama Pro API (`api.llama.fi/emissions`, unlock calendars) | Forward unlock schedules (the free public dataset was used instead; the HYPE core-contributor schedule is missing) | ~$300/mo |
| Token Terminal Pro / API | Cross-checked revenue and buyback series and token-holder metrics | ~$325+/mo (est.) |
| Etherscan/BscScan Pro (or a free key, not available here) | Exact timestamps and amounts of every burn transfer to 0x…dEaD for BNB/CAKE/UNI | free key, or ~$199/mo Pro (est.) |
| Kaiko / Amberdata / CryptoCompare paid | Intraday price and volume for ±1h event windows around burns | $1k+/mo (enterprise, est.) |
| Tokenomist (formerly TokenUnlocks) Pro | Vesting schedules for HYPE / LIT / EDGE / ASTER / PUMP | ~$150–500/mo (est.) |
| Nansen | Wallet attribution (explicitly excluded by instruction) | — |


---

## 8. Burn CONSISTENCY (follow-up, 2026-10-11)

Script: `research/buyburn/buyburn_consistency.py`. Output: `data/buyburn_consistency.json` (also copied to the repo `data/`).
- **Inputs:** the daily DefiLlama holdersRevenue programs (USD; GMX excluded) plus the discrete official burns (BNB quarterly = `BNB-Q`, OKB until Jul-2025, BGB). The BNB BEP-95 gas burn is a separate series, `BNB-gas`; BNB is counted only once (as BNB-Q) in the tests.
- **SUN:** not scored. Only the aggregate (51 rounds, 678.5M SUN) and round 51 are available.
- **Price artifact:** amounts are measured in **USD** and **% of volume**, never in token counts, so a falling price cannot inflate the measured size.

**Frequency** comes from the median interval between burn days: ≤1.5d daily, ≤8d weekly, ≤35d monthly, ≤110d quarterly, otherwise irregular. "(irregular)" is added when the interval CV is above 1.
**Gap** = an interval longer than max(3× median, 7d). **Uptime** = share of weeks (daily/weekly programs) or quarters (discrete programs) since the start that had at least one burn.

**Consistency score (0–100)** = 100 × (0.30·R + 0.25·A + 0.25·U + 0.20·T), where:
- R = 1/(1+CV of intervals) — interval regularity
- A = 1/(1+CV of USD per period) — weekly sums for daily/weekly programs, per event for quarterly ones
- U = uptime
- T = 1/(1+SD of month-to-month log change of 30d USD sums), or event-to-event for quarterly programs — trend stability

| Token | Mechanism | Frequency | Events | Med. interval d | CV interval | CV USD | CV %circ (wk) | CV %vol (wk) | Median wk %vol | Uptime | Gaps | **Score** | XS 3m | XS 6m | XS 12m |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LINK | treasury | weekly | 62 | 7 | 0.00 | 0.05 | 0.33 | 0.51 | 0.043 | 100% | 0 | **95.8** | +32.0 | +27.8 | -9.7 |
| PUMP | treasury->burn | daily | 453 | 1 | 0.00 | 0.40 | 0.31 | 0.61 | 0.770 | 100% | 0 | **87.9** | +245.6 | +180.9 | +30.7 |
| JUP | treasury | daily | 601 | 1 | 0.00 | 0.60 | 0.39 | 0.40 | 0.335 | 100% | 0 | **85.5** | +55.7 | +112.4 | +19.0 |
| ORE | mixed | daily | 356 | 1 | 0.00 | 0.71 | 0.17 | 0.40 | 11.023 | 100% | 0 | **84.9** | -12.6 | +158.0 | +902.7 |
| HYPE | burn | daily | 653 | 1 | 0.11 | 0.41 | 0.45 | 0.44 | 0.461 | 100% | 0 | **84.8** | -4.1 | +89.1 | +123.1 |
| UNI | burn | daily | 286 | 1 | 0.00 | 0.72 | 0.52 | 0.44 | 0.071 | 100% | 0 | **83.4** | +78.9 | +118.1 | +25.3 |
| LIT | treasury->burn | daily | 270 | 1 | 0.21 | 0.59 | 0.60 | 0.49 | 0.191 | 100% | 0 | **80.6** | +6.1 | +205.8 | – |
| BNB-gas | burn | daily | 494 | 1 | 0.00 | 1.03 | 0.41 | 0.99 | 0.004 | 100% | 0 | **79.6** | – | – | – |
| CAKE | burn | daily | 1996 | 1 | 0.00 | 1.33 | 2.46 | 0.42 | 0.238 | 100% | 0 | **79.2** | +28.1 | +32.1 | -9.2 |
| EDGE | burn | daily | 192 | 1 | 0.00 | 1.31 | 1.04 | 1.29 | 0.684 | 100% | 0 | **77.0** | -38.2 | -77.0 | – |
| BNB-Q | burn | quarterly | 36 | 91 | 0.06 | 0.88 | 0.32 | – | – | 100% | 0 | **76.2** | +0.2 | +9.3 | -8.8 |
| ETH | burn(protocol) | daily | 1893 | 1 | 0.00 | 1.63 | 0.90 | 1.02 | 0.001 | 100% | 0 | **76.1** | +9.7 | -2.4 | -10.9 |
| LDO | treasury | monthly | 5 | 29 | 0.54 | 0.47 | 2.17 | 2.04 | 0.000 | 100% | 0 | **71.4** | +11.5 | +13.1 | -31.6 |
| OKB | burn(ended) | quarterly | 28 | 91 | 0.34 | 1.64 | 1.72 | – | – | 96% | 0 | **67.8** | +27.3 | +34.5 | -8.0 |
| TRX | burn(protocol) | daily (irregular) | 1335 | 1 | 2.09 | 0.31 | 0.15 | 0.27 | 0.174 | 95% | 1 | **65.5** | -28.3 | -9.2 | +30.7 |
| BGB | burn | quarterly | 5 | 94 | 0.48 | 1.19 | 0.91 | – | – | 83% | 1 | **61.8** | -12.0 | -12.1 | -33.7 |
| BONK | mixed | daily | 445 | 1 | 0.94 | 2.66 | 2.08 | 1.66 | 0.016 | 96% | 3 | **53.8** | -46.9 | -56.1 | -49.9 |
| SKY | mixed | daily (irregular) | 599 | 1 | 3.41 | 0.71 | 2.23 | 0.80 | 1.013 | 87% | 1 | **53.4** | -1.4 | -15.9 | +45.8 |
| RAY | treasury | daily (irregular) | 1093 | 1 | 6.83 | 1.10 | 0.97 | 0.67 | 0.156 | 80% | 1 | **43.8** | +199.4 | +233.0 | +16.8 |
| ASTER | matched_reserve_burn | daily (irregular) | 122 | 1 | 5.61 | 0.42 | 1.33 | 1.16 | 0.028 | 50% | 2 | **39.8** | -17.0 | -7.4 | -26.1 |

XS = BTC-excess return (pp) over the trailing 3/6/12 months to 2026-10-10. Rolling 90d CVs of weekly USD over time are in the JSON (`tokens.*.rolling_cv_weekly_usd`). Gap lists: `tokens.*.gaps`.
Gaps and missed periods: TRX 2022-11-23 (82d); BGB 2025-07-10 (197d); BONK 2025-05-04 (8d); BONK 2025-05-19 (15d); BONK 2025-06-29 (8d); SKY 2024-11-18 (98d); RAY 2024-07-04 (286d); ASTER 2026-01-23 (9d); ASTER 2026-02-02 (135d). The DefiLlama daily gaps (RAY 286d in 2024, SKY 98d, TRX 82d, ASTER 135d before its Jun-2026 relaunch, BONK) may partly be adapter data outages rather than missed buybacks. BGB's gap is the missing Q3/Q4-2025 data.

### (a) High-consistency vs sporadic / low-consistency tokens
Groups: high = score >= 80.6 (top tercile), low/sporadic = score <= 67.8 (bottom tercile). High = LINK, PUMP, JUP, ORE, HYPE, UNI, LIT. Low = OKB, TRX, BGB, BONK, SKY, RAY, ASTER.

| Measure | n high / low | Mean high | Mean low | Median high | Median low | Welch p | Mann-Whitney p | Cohen d |
|---|---|---|---|---|---|---|---|---|
| xs_trailing_3m | 7/7 | +57.4 | +17.3 | +32.0 | -12.0 | 0.403 | 0.128 | 0.46 |
| xs_trailing_6m | 7/7 | +127.4 | +23.8 | +118.1 | -9.2 | 0.036 | 0.038 | 1.29 |
| xs_trailing_12m | 6/7 | +181.8 | -3.5 | +28.0 | -8.0 | 0.259 | 0.101 | 0.77 |
| xs_log_per_year_program | 7/7 | +0.5 | -0.1 | +0.3 | +0.2 | 0.139 | 0.209 | 0.85 |
| token-month panel (monthly XS during program) | 95/241 | +6.5 | +3.8 | +0.7 | -1.8 | 0.481 | 0.222 | 0.08 |

Sporadic large burns: discrete BNB/OKB/BGB burns since mid-2019 plus the one-offs (n = 64). Excess return after the event: 7d mean +1.7pp (median -0.2, p = 0.44); 30d mean +2.5pp (median -1.9, p = 0.54).

**Reading:**
- Consistent programs did better over the trailing 6 months: +127pp vs +24pp, d = 1.29, Welch p = 0.036, MW p = 0.038, n = 7 vs 7. The 3m and 12m differences and the full-program-life difference are **not significant**.
- The monthly panel shows no difference: d = 0.08, p = 0.48.
- Scores and trailing returns cover the same period, so this is partly reverse causality: a token in demand produces steady fee flow and therefore steady buybacks.

### (b) Consistency score vs BTC-excess return
| Test | n | Spearman ρ | p |
|---|---|---|---|
| Current score vs xs_trailing_3m (contemporaneous) | 19 | 0.41 | 0.081 |
| Current score vs xs_trailing_6m (contemporaneous) | 19 | 0.49 | 0.031 |
| Current score vs xs_trailing_12m (contemporaneous) | 17 | 0.38 | 0.135 |
| Current score vs xs_log_per_year_program (contemporaneous) | 19 | 0.12 | 0.616 |
| Rolling 180d score at quarter-ends → **forward** 3m (pooled, 14 tokens) | 79 | 0.14 | 0.222 |
| …same, Fama-MacBeth (mean cross-sectional ρ over 11 quarters) | 11 dates | 0.08 | 0.633 (t = 0.49) |
| Rolling 180d score at quarter-ends → **forward** 6m (pooled, 12 tokens) | 65 | 0.26 | 0.040 |
| …same, Fama-MacBeth (mean cross-sectional ρ over 10 quarters) | 10 dates | 0.27 | 0.075 (t = 2.01) |
| Rolling 180d score at quarter-ends → **forward** 12m (pooled, 8 tokens) | 43 | 0.31 | 0.041 |
| …same, Fama-MacBeth (mean cross-sectional ρ over 8 quarters) | 8 dates | 0.12 | 0.541 (t = 0.64) |

**Reading:**
- Contemporaneously, consistency and returns move together: 6m ρ = 0.49, p = 0.03.
- Out of sample (score measured first, returns after), the link is weak:
  - forward 3m: ρ = 0.14, p = 0.22 (Fama-MacBeth p = 0.63)
  - forward 6m: ρ = 0.26, pooled p = 0.04 (overlapping windows, so optimistic); Fama-MacBeth ρ = 0.27, p = 0.075
  - forward 12m: ρ = 0.31, pooled p = 0.04 (only 8 tokens); Fama-MacBeth p = 0.54
- **At most a weak positive tilt at about 6 months; not robust.**

### (c) Regime-change flags
**Detectors:**
- Daily programs, checked weekly after a 120d warm-up:
  - **drop**: 30d USD < 50% of the prior 90d average (per 30d); re-armed above 75%
  - **drop (% of volume)**: same rule on 30d buyback / 30d volume (last 365d only)
  - **surge**: more than 2× the prior average
  - **stopped**: ≥14 consecutive zero days (≥3× the median interval)
  - **frequency shift**: active-day share over 60d vs the prior 180d moves by more than 2× (up or down)
- Discrete programs: burn USD < 50% or > 200% of the average of the prior 4 burns.
- Plus 7 documented structural changes.

**Measures:**
- BTC-excess return over the next 7/30/90 days.
- `vs baseline` = that minus the token's average excess return over the same horizon across its whole program period.
- **Dump** = next-30d excess ≤ −20pp. Base rate over all 30d windows of the flagged tokens: **14.6%** (n = 10354).

| Flag type | n | 7d vs baseline (mean / median, p) | 30d vs baseline | 90d vs baseline | Dumps next 30d |
|---|---|---|---|---|---|
| all | 103 | +0.5 / -1.5 (p = 0.76) | +1.6 / -2.7 (p = 0.63) | +6.6 / -7.9 (p = 0.56) | 12 |
| drop | 44 | -1.7 / -1.3 (p = 0.11) | +1.1 / +0.5 (p = 0.77) | +2.2 / -5.5 (p = 0.74) | 4 |
| stopped | 5 | +9.0 / +11.2 (p = 0.05) | +0.4 / -5.2 (p = 0.96) | -9.8 / -13.4 (p = 0.56) | 1 |
| frequency | 3 | +1.4 / +5.9 (p = 0.86) | -4.3 / -4.3 (p = –) | +18.4 / +18.4 (p = –) | 0 |
| surge | 44 | -1.2 / -2.0 (p = 0.44) | +2.7 / -1.6 (p = 0.67) | +15.8 / -13.8 (p = 0.55) | 6 |
| documented | 7 | +18.5 / -0.0 (p = 0.39) | +0.6 / -8.5 (p = 0.97) | -9.4 / -11.4 (p = 0.51) | 1 |

| Dump rate by flag subset | n with 30d outcome | Dumps | Share | Binomial p vs 14.6% base |
|---|---|---|---|---|
| all_flags | 98 | 12 | 12.2% | 0.570 |
| drop_or_stop | 47 | 5 | 10.6% | 0.540 |
| drop_pct_volume_only | 14 | 1 | 7.1% | 0.708 |
| surge_after_prior30d_gt_+25pp | 14 | 6 | 42.9% | 0.010 |
| surge_other | 28 | 0 | 0.0% | 0.027 |
| documented_changes | 7 | 1 | 14.3% | 1.000 |

**Did any regime change precede a dump?**
- **Buyback drops and stops did not foreshadow dumps.** 5 of 47 (10.6%) were followed by a dump, versus a 14.6% base rate (p = 0.54). Drops measured as % of volume: 1 of 14.
- Mean excess after a drop: 7d −1.7pp (p = 0.11), 30d +1.1pp (p = 0.77).
- Three drop or stop flags came right before a dump:
  - CAKE, 2022-01-16: −30pp
  - ORE, 2026-02-24: −31pp (then +61pp over 90d)
  - EDGE, 2026-07-31: buybacks fell to 0.05× the trailing average; −27pp over 30d. This is the clearest case. The collapse matches the Q2→Q3 drop in DefiLlama-recorded buybacks ($45M → $1.2M) after the post-TGE buyback period.
- BONK's "stop" (2025-05-20, −27pp) is likely a DefiLlama data artifact at program start.
- **Surges are the warning sign, not drops.** Buyback-USD surges that came after a +25pp 30d rally were followed by a dump 6 of 14 times (43%, binomial p = 0.01). Cases: CAKE 2023-11, 2024-03 and 2024-12; RAY 2024-03 and 2025-05; BONK 2026-01. Surges without a prior rally: 0 of 28 dumps.
  - Interpretation: fee-funded buybacks peak at the top of a speculative volume spike. The surge marks the top of the fee cycle rather than causing anything.
  - Caveat: the +25pp split was chosen after looking at the data (post-hoc), so treat it as a hypothesis to test.
- Documented structural changes (n = 7): 30d median −8.5pp vs baseline; 6 of 7 were negative over 30d, but p = 0.97. Only UNI (fee switch + 100M burn, −21.5pp) qualifies as a dump. OKB's program end came with a +109pp rally.

**All regime flags** (XS = BTC-excess pp; prior = the 30d before the flag; "–" = horizon not yet complete):

| Date | Token | What changed | Detail | Prior 30d | Next 7d | Next 30d | Next 90d | 30d vs baseline | Dump? |
|---|---|---|---|---|---|---|---|---|---|
| 2019-01-16 | BNB-Q | drop>50% (USD vs prior-4 avg) | $9.4M vs $29.6M | +13.8 | +11.2 | +49.1 | +192.9 | +32.8 |  |
| 2019-09-03 | OKB | surge>2x (USD vs prior-4 avg) | $16.4M vs $0.7M | -5.7 | -0.7 | -2.3 | +20.6 | -8.0 |  |
| 2019-10-17 | BNB-Q | surge>2x (USD vs prior-4 avg) | $36.6M vs $16.5M | +9.7 | +0.5 | +8.4 | -16.2 | -7.9 |  |
| 2019-12-06 | OKB | surge>2x (USD vs prior-4 avg) | $15.1M vs $4.6M | -1.0 | +6.5 | +4.6 | +95.7 | -1.1 |  |
| 2020-03-02 | OKB | surge>2x (USD vs prior-4 avg) | $17.4M vs $8.2M | +80.6 | -8.0 | +3.7 | -14.6 | -2.0 |  |
| 2021-01-19 | BNB-Q | surge>2x (USD vs prior-4 avg) | $164.3M vs $55.0M | -17.0 | +3.0 | +217.5 | +896.4 | +201.2 |  |
| 2021-04-16 | BNB-Q | surge>2x (USD vs prior-4 avg) | $597.2M vs $86.1M | +98.4 | +11.7 | +29.8 | +5.0 | +13.5 |  |
| 2021-10-18 | BNB-Q | surge>2x (USD vs prior-4 avg) | $628.7M vs $304.8M | -14.4 | +2.3 | +27.6 | +35.2 | +11.3 |  |
| 2021-11-21 | CAKE | surge>2x (USD) | 30d $29.17M vs trailing avg $13.57M/30d (2.15x) | -16.1 | -9.6 | -2.5 | -18.3 | -0.2 |  |
| 2021-12-07 | OKB | surge>2x (USD vs prior-4 avg) | $63.4M vs $31.6M | +18.6 | +15.1 | +15.2 | -7.1 | +9.5 |  |
| 2022-01-16 | CAKE | drop>50% (USD 30d vs prior-90d avg) | 30d $9.56M vs trailing avg $23.02M/30d (0.42x) | +2.5 | -17.3 | -30.1 | -24.5 | -27.9 | **DUMP** |
| 2022-03-04 | ETH | drop>50% (USD 30d vs prior-90d avg) | 30d $587.97M vs trailing avg $1215.79M/30d (0.48x) | -8.1 | -0.9 | +13.4 | -5.9 | +13.7 |  |
| 2022-06-10 | ETH | drop>50% (USD 30d vs prior-90d avg) | 30d $235.08M vs trailing avg $478.31M/30d (0.49x) | -20.7 | -8.1 | -3.7 | +27.1 | -3.4 |  (already fell before) |
| 2022-07-10 | CAKE | drop>50% (USD 30d vs prior-90d avg) | 30d $1.70M vs trailing avg $3.72M/30d (0.46x) | +1.5 | +3.2 | +29.2 | +51.3 | +31.5 |  |
| 2022-11-24 | TRX | stopped (≥14d no buyback) | DefiLlama shows zero; may be data outage | -1.9 | +2.8 | +4.3 | -12.1 | +4.1 |  |
| 2023-01-05 | OKB | surge>2x (USD vs prior-4 avg) | $136.7M vs $55.9M | +29.2 | -5.4 | +11.0 | -18.3 | +5.2 |  |
| 2023-03-03 | ETH | surge>2x (USD) | 30d $148.84M vs trailing avg $74.08M/30d (2.01x) | +2.6 | +0.5 | -10.8 | -2.3 | -10.5 |  |
| 2023-03-23 | OKB | surge>2x (USD vs prior-4 avg) | $236.5M vs $74.2M | -24.3 | -9.1 | +6.4 | -10.3 | +0.7 |  (already fell before) |
| 2023-03-23 | TRX | surge>2x (USD) | 30d $36.20M vs trailing avg $4.05M/30d (8.94x) | -27.0 | +3.8 | +8.6 | +14.0 | +8.4 |  (already fell before) |
| 2023-05-05 | ETH | surge>2x (USD) | 30d $269.91M vs trailing avg $133.59M/30d (2.02x) | -2.0 | +2.1 | +6.9 | -3.1 | +7.2 |  |
| 2023-06-08 | OKB | surge>2x (USD vs prior-4 avg) | $246.0M vs $122.3M | +6.6 | -7.2 | -19.1 | -2.9 | -24.8 |  |
| 2023-07-16 | CAKE | surge>2x (USD) | 30d $2.17M vs trailing avg $0.92M/30d (2.37x) | -4.5 | +0.6 | -0.3 | -17.7 | +2.0 |  |
| 2023-08-27 | CAKE | drop>50% (USD 30d vs prior-90d avg) | 30d $0.66M vs trailing avg $1.32M/30d (0.50x) | -4.4 | -1.8 | -10.6 | +42.3 | -8.3 |  |
| 2023-10-13 | ETH | drop>50% (USD 30d vs prior-90d avg) | 30d $56.16M vs trailing avg $124.74M/30d (0.45x) | -6.8 | -5.5 | -5.4 | -6.2 | -5.1 |  |
| 2023-11-06 | RAY | surge>2x (USD) | 30d $0.25M vs trailing avg $0.09M/30d (2.71x) | +20.8 | +36.5 | +35.9 | +282.2 | +25.2 |  |
| 2023-11-19 | CAKE | surge>2x (USD) | 30d $1.39M vs trailing avg $0.62M/30d (2.26x) | +104.8 | -4.5 | -26.3 | -29.8 | -24.0 | **DUMP** |
| 2023-11-24 | ETH | surge>2x (USD) | 30d $182.60M vs trailing avg $88.65M/30d (2.06x) | +5.3 | -1.6 | -5.4 | +5.2 | -5.0 |  |
| 2023-12-11 | OKB | surge>2x (USD vs prior-4 avg) | $634.8M vs $219.1M | -20.3 | -3.0 | -16.5 | -54.4 | -22.3 |  (already fell before) |
| 2024-03-08 | ETH | surge>2x (USD) | 30d $473.90M vs trailing avg $221.15M/30d (2.14x) | +7.6 | -6.4 | -16.1 | -6.2 | -15.8 |  |
| 2024-03-13 | OKB | surge>2x (USD vs prior-4 avg) | $755.6M vs $343.6M | -15.6 | -1.0 | -11.8 | -26.1 | -17.5 |  |
| 2024-03-17 | CAKE | surge>2x (USD) | 30d $5.55M vs trailing avg $2.54M/30d (2.19x) | +25.8 | -2.3 | -32.1 | -43.1 | -29.8 | **DUMP** |
| 2024-03-18 | RAY | surge>2x (USD) | 30d $4.85M vs trailing avg $2.28M/30d (2.13x) | +134.3 | -17.6 | -39.7 | -34.7 | -50.3 | **DUMP** |
| 2024-04-24 | BNB-Q | surge>2x (USD vs prior-4 avg) | $1180.0M vs $559.9M | +8.0 | +4.0 | -3.6 | -4.9 | -19.9 |  |
| 2024-05-03 | ETH | drop>50% (USD 30d vs prior-90d avg) | 30d $153.83M vs trailing avg $348.97M/30d (0.44x) | +0.9 | -5.0 | +13.1 | -1.1 | +13.4 |  |
| 2024-06-03 | RAY | drop>50% (USD 30d vs prior-90d avg) | 30d $1.42M vs trailing avg $3.30M/30d (0.43x) | -6.5 | -2.8 | +25.8 | +4.0 | +15.2 |  |
| 2024-07-05 | RAY | stopped (≥14d no buyback) | DefiLlama shows zero; may be data outage | +6.6 | +13.2 | +1.7 | -1.4 | -8.9 |  |
| 2024-07-29 | RAY | drop>50% (USD 30d vs prior-90d avg) | 30d $0.55M vs trailing avg $2.84M/30d (0.19x) | +37.5 | -17.6 | -18.3 | +25.9 | -28.9 |  |
| 2024-08-06 | RAY | frequency shift | active-day share 60d 0.45 vs prior 0.99 | -7.5 | +13.0 | -5.2 | +97.0 | -15.8 |  |
| 2024-10-11 | ETH | surge>2x (USD) | 30d $97.21M vs trailing avg $45.20M/30d (2.15x) | -4.8 | -2.5 | +4.1 | -18.2 | +4.4 |  |
| 2024-11-19 | SKY | stopped (≥14d no buyback) | DefiLlama shows zero; may be data outage | -3.6 | +15.4 | -3.6 | -42.6 | -5.2 |  |
| 2024-12-08 | CAKE | surge>2x (USD) | 30d $5.26M vs trailing avg $2.33M/30d (2.26x) | +97.7 | -23.9 | -35.1 | -45.2 | -32.9 | **DUMP** |
| 2025-02-16 | CAKE | surge>2x (USD) | 30d $8.89M vs trailing avg $4.26M/30d (2.09x) | +9.4 | -2.0 | +10.0 | -19.9 | +12.3 |  |
| 2025-02-21 | ETH | drop>50% (USD 30d vs prior-90d avg) | 30d $43.44M vs trailing avg $146.19M/30d (0.30x) | -10.2 | -2.0 | -13.0 | -18.2 | -12.7 |  |
| 2025-03-14 | SKY | surge>2x (USD) | 30d $15.17M vs trailing avg $0.12M/30d (130.29x) | +34.3 | +7.5 | +18.1 | +47.4 | +16.5 |  |
| 2025-05-19 | RAY | surge>2x (USD) | 30d $3.84M vs trailing avg $0.00M/30d (1262.53x) | +31.5 | -7.9 | -38.5 | -4.2 | -49.1 | **DUMP** |
| 2025-05-20 | BONK | stopped (≥14d no buyback) | DefiLlama shows zero; may be data outage | +34.3 | -1.0 | -26.6 | +10.0 | -21.7 | **DUMP** |
| 2025-06-06 | ETH | surge>2x (USD) | 30d $26.24M vs trailing avg $9.91M/30d (2.65x) | +28.3 | +5.3 | -2.5 | +74.0 | -2.2 |  |
| 2025-06-19 | OKB | surge>2x (USD vs prior-4 avg) | $2042.5M vs $887.9M | -7.4 | +3.9 | -11.9 | +296.3 | -17.6 |  |
| 2025-07-12 | SKY | frequency shift | active-day share 60d 1.00 vs prior 0.46 | -15.9 | +6.7 | +9.0 | -19.0 | +7.3 |  |
| 2025-08-15 | OKB | documented structural change | program ended (one-time 65.26M burn, supply fixed 21M) | +103.0 | +140.0 | +108.6 | +42.1 | +102.9 |  |
| 2025-09-01 | BONK | drop>50% (USD 30d vs prior-90d avg) | 30d $1.48M vs trailing avg $8.57M/30d (0.17x) | -8.6 | -8.4 | -19.4 | -40.6 | -14.6 |  |
| 2025-10-09 | BNB-gas | surge>2x (USD) | 30d $4.74M vs trailing avg $1.12M/30d (4.23x) | +38.8 | -0.9 | -8.0 | -5.8 | -24.3 |  |
| 2025-10-12 | CAKE | surge>2x (USD) | 30d $16.34M vs trailing avg $4.92M/30d (3.32x) | +8.4 | +11.8 | +3.4 | -7.5 | +5.6 |  |
| 2025-10-27 | RAY | drop>50% (USD 30d vs prior-90d avg) | 30d $2.30M vs trailing avg $5.06M/30d (0.45x) | -32.7 | -9.0 | -16.5 | -24.8 | -27.1 |  (already fell before) |
| 2025-11-14 | ETH | drop>50% (USD 30d vs prior-90d avg) | 30d $8.99M vs trailing avg $18.85M/30d (0.48x) | -9.8 | +0.8 | +5.9 | -7.1 | +6.2 |  |
| 2025-11-27 | BNB-gas | drop>50% (USD 30d vs prior-90d avg) | 30d $1.64M vs trailing avg $3.38M/30d (0.49x) | -1.1 | +0.0 | -2.9 | -5.3 | -19.2 |  |
| 2025-12-09 | JUP | drop>50% (USD 30d vs prior-90d avg) | 30d $4.10M vs trailing avg $8.37M/30d (0.49x) | -23.5 | -12.0 | -5.1 | -0.5 | -3.8 |  (already fell before) |
| 2025-12-14 | CAKE | drop>50% (USD 30d vs prior-90d avg) | 30d $4.42M vs trailing avg $10.68M/30d (0.41x) | +3.7 | -15.9 | -15.2 | -16.3 | -13.0 |  |
| 2025-12-24 | HYPE | documented structural change | AF HYPE formally recognized as burned (vote) | -25.5 | +7.3 | -12.8 | +74.6 | -22.9 |  (already fell before) |
| 2025-12-28 | UNI | documented structural change | fee-switch burn starts + 100M retro burn | +0.9 | -3.9 | -21.5 | -18.7 | -31.9 | **DUMP** |
| 2026-01-05 | BONK | surge>2x (USD) | 30d $2.32M vs trailing avg $0.98M/30d (2.36x) | +29.3 | -12.1 | -24.0 | -26.0 | -19.1 | **DUMP** |
| 2026-01-09 | ETH | drop>50% (% of volume) | 30d buyback 0.000% of vol vs 0.002% trailing | -4.7 | +1.9 | -8.8 | -7.6 | -8.5 |  |
| 2026-01-23 | BGB | documented structural change | quarterly burn size cut ~90% (30M -> 3.06M BGB; Morph-fee formula) | +3.4 | +0.4 | -12.3 | -34.3 | -8.5 |  |
| 2026-02-03 | ASTER | stopped (≥14d no buyback) | DefiLlama shows zero; may be data outage | -11.0 | +17.1 | +34.8 | +18.1 | +34.0 |  |
| 2026-02-24 | ORE | drop>50% (USD 30d vs prior-90d avg) | 30d $2.98M vs trailing avg $6.00M/30d (0.50x) | -16.2 | +4.2 | -30.6 | +61.4 | -48.0 | **DUMP** |
| 2026-03-02 | BONK | drop>50% (USD 30d vs prior-90d avg) | 30d $0.63M vs trailing avg $1.55M/30d (0.40x) | -5.4 | -4.9 | -3.3 | -19.2 | +1.5 |  |
| 2026-03-13 | ETH | drop>50% (USD 30d vs prior-90d avg) | 30d $1.25M vs trailing avg $3.34M/30d (0.38x) | +0.2 | +3.9 | +6.6 | -9.0 | +6.9 |  |
| 2026-03-13 | ETH | drop>50% (% of volume) | 30d buyback 0.000% of vol vs 0.000% trailing | +0.2 | +3.9 | +6.6 | -9.0 | +6.9 |  |
| 2026-03-16 | BONK | drop>50% (% of volume) | 30d buyback 0.021% of vol vs 0.047% trailing | -9.1 | +0.5 | -5.4 | -14.4 | -0.5 |  |
| 2026-04-03 | SKY | drop>50% (USD 30d vs prior-90d avg) | 30d $3.39M vs trailing avg $8.23M/30d (0.41x) | +7.1 | -2.9 | -9.6 | -19.1 | -11.2 |  |
| 2026-04-03 | SKY | drop>50% (% of volume) | 30d buyback 0.616% of vol vs 1.813% trailing | +7.1 | -2.9 | -9.6 | -19.1 | -11.2 |  |
| 2026-04-20 | RAY | drop>50% (USD 30d vs prior-90d avg) | 30d $0.74M vs trailing avg $1.53M/30d (0.48x) | -1.7 | +12.3 | +7.3 | +18.5 | -3.3 |  |
| 2026-04-20 | RAY | drop>50% (% of volume) | 30d buyback 0.103% of vol vs 0.211% trailing | -1.7 | +12.3 | +7.3 | +18.5 | -3.3 |  |
| 2026-04-24 | ETH | surge>2x (USD) | 30d $6.00M vs trailing avg $2.64M/30d (2.28x) | -2.8 | -0.7 | -7.2 | -1.5 | -6.9 |  |
| 2026-04-27 | BONK | drop>50% (USD 30d vs prior-90d avg) | 30d $0.35M vs trailing avg $1.50M/30d (0.23x) | -8.4 | -0.9 | -1.9 | -32.8 | +2.9 |  |
| 2026-04-27 | BONK | drop>50% (% of volume) | 30d buyback 0.024% of vol vs 0.053% trailing | -8.4 | -0.9 | -1.9 | -32.8 | +2.9 |  |
| 2026-04-28 | PUMP | documented structural change | switch 100% revenue->treasury to 50% revenue auto buy&burn + burn of all repurchased | -12.4 | -0.6 | +4.7 | +29.0 | -6.9 |  |
| 2026-05-05 | LIT | drop>50% (USD 30d vs prior-90d avg) | 30d $2.15M vs trailing avg $4.79M/30d (0.45x) | -26.7 | +8.0 | +116.5 | +145.0 | +100.4 |  (already fell before) |
| 2026-05-19 | JUP | drop>50% (% of volume) | 30d buyback 0.175% of vol vs 0.355% trailing | +9.8 | +0.7 | +11.2 | +2.0 | +12.5 |  |
| 2026-05-20 | ASTER | drop>50% (USD 30d vs prior-90d avg) | 30d $0.00M vs trailing avg $3.36M/30d (0.00x) | -6.9 | +6.4 | +16.2 | +8.5 | +15.5 |  |
| 2026-05-20 | ASTER | drop>50% (% of volume) | 30d buyback 0.000% of vol vs 0.076% trailing | -6.9 | +6.4 | +16.2 | +8.5 | +15.5 |  |
| 2026-06-02 | HYPE | drop>50% (% of volume) | 30d buyback 0.225% of vol vs 0.528% trailing | +87.3 | -1.8 | +0.8 | +0.1 | -9.3 |  |
| 2026-06-09 | LIT | drop>50% (% of volume) | 30d buyback 0.158% of vol vs 0.325% trailing | +60.5 | +10.8 | +60.9 | +181.7 | +44.8 |  |
| 2026-06-17 | ASTER | documented structural change | switch to 99% fee daily TWAP buyback + matched reserve burn | +17.5 | +0.6 | -3.8 | -12.9 | -4.6 |  |
| 2026-07-10 | ETH | drop>50% (USD 30d vs prior-90d avg) | 30d $2.13M vs trailing avg $5.57M/30d (0.38x) | +4.0 | +5.8 | +7.1 | +15.7 | +7.4 |  |
| 2026-07-10 | LIT | documented structural change | treasury buybacks -> burn; 15.64M burned | +48.8 | -5.9 | -7.6 | +17.2 | -23.7 |  |
| 2026-07-14 | BGB | drop>50% (USD vs prior-4 avg) | $4.9M vs $67.4M | -5.8 | -3.5 | +2.0 | – | +5.8 |  |
| 2026-07-17 | ETH | drop>50% (% of volume) | 30d buyback 0.001% of vol vs 0.001% trailing | +6.8 | -1.2 | +2.1 | – | +2.5 |  |
| 2026-07-22 | ASTER | surge>2x (USD) | 30d $3.92M vs trailing avg $0.25M/30d (15.52x) | -6.4 | +2.9 | -4.0 | – | -4.7 |  |
| 2026-07-31 | EDGE | drop>50% (USD 30d vs prior-90d avg) | 30d $0.73M vs trailing avg $14.71M/30d (0.05x) | +33.3 | -4.3 | -27.2 | – | -25.6 | **DUMP** |
| 2026-07-31 | EDGE | drop>50% (% of volume) | 30d buyback 0.268% of vol vs 1.421% trailing | +33.3 | -4.3 | -27.2 | – | -25.6 | **DUMP** |
| 2026-08-25 | UNI | surge>2x (USD) | 30d $8.20M vs trailing avg $4.08M/30d (2.01x) | -4.7 | +21.3 | +106.5 | – | +96.1 |  |
| 2026-09-04 | SKY | surge>2x (USD) | 30d $2.81M vs trailing avg $1.12M/30d (2.51x) | -4.0 | -7.1 | +27.9 | – | +26.3 |  |
| 2026-09-06 | CAKE | surge>2x (USD) | 30d $4.24M vs trailing avg $2.02M/30d (2.10x) | +36.0 | +2.0 | +2.3 | – | +4.5 |  |
| 2026-09-07 | BONK | surge>2x (USD) | 30d $0.36M vs trailing avg $0.13M/30d (2.82x) | +13.3 | -16.2 | +0.6 | – | +5.4 |  |
| 2026-09-07 | RAY | surge>2x (USD) | 30d $1.63M vs trailing avg $0.57M/30d (2.89x) | +83.6 | +11.4 | +63.9 | – | +53.3 |  |
| 2026-09-09 | PUMP | drop>50% (% of volume) | 30d buyback 0.411% of vol vs 0.844% trailing | +40.4 | -14.9 | +24.2 | – | +12.6 |  |
| 2026-09-11 | LINK | drop>50% (% of volume) | 30d buyback 0.023% of vol vs 0.067% trailing | +10.3 | -0.5 | +5.1 | – | +5.9 |  |
| 2026-09-15 | ORE | drop>50% (% of volume) | 30d buyback 5.177% of vol vs 12.728% trailing | -24.7 | +11.6 | – | – | – |  (already fell before) |
| 2026-09-17 | ASTER | frequency shift | active-day share 60d 1.00 vs prior 0.21 | -1.2 | -12.0 | – | – | – |  |
| 2026-09-29 | JUP | drop>50% (% of volume) | 30d buyback 0.119% of vol vs 0.280% trailing | +42.5 | +3.9 | – | – | – |  |
| 2026-09-29 | LDO | surge>2x (USD) | 30d $2.25M vs trailing avg $1.11M/30d (2.04x) | +16.9 | +3.9 | – | – | – |  |
| 2026-10-02 | ETH | surge>2x (USD) | 30d $5.27M vs trailing avg $2.31M/30d (2.28x) | +2.3 | -4.9 | – | – | – |  |

**Consistency limitations:**
- The score weights are a judgment call (documented above). Scores cover each token's own history, which varies from 0.4 to 5.5 years, and newer programs look more uniform.
- DefiLlama zero days may be adapter outages.
- Token-level tests have n = 7 vs 7; panel p-values ignore cross-token correlation in the same month.
- Overlapping 6m/12m forward windows make pooled p-values optimistic (the Fama-MacBeth values are the honest ones).
- Many detectors and subsets were tested (multiple testing); the surge-after-rally finding is post-hoc.
