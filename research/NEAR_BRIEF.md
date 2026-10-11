# NEAR Protocol (NEAR): Research Brief
**As of:** Sun Oct 11, 2026, about 06:30 PT (data pulled 13:27 to 13:35 UTC). **Sources:** free sources only. No Nansen. No paid X key. I used about 9 reads from the built-in X tools.
Labels: [CG] CoinGecko free API · [DL] DefiLlama API · [NB] nearblocks.io API · [RPC] NEAR mainnet RPC (rpc.mainnet.near.org) · [BN]/[OKX]/[HL]/[GATE] the venues' public APIs. Web sources are linked inline.

---
## TL;DR
NEAR is the standout large-cap of the last 90 days. It is up about 3x since mid-July while BTC, ETH and SOL are down 26% to 41% over the past year. Four things are driving it: NEAR Intents volume (record month of $4.8B in September), confidential perps and tokenized stocks on near.com, the first US spot NEAR ETF (Bitwise NRR, launched Sep 29), and a second proposed issuance cut (2.5% → 1.6%). Leverage is high: about $0.9B of OI on 4 venues, roughly 13% of market cap. Account long/short ratios have flipped toward shorts, which could fuel a squeeze. The base L1's own activity is still far below 2025 levels, and the value captured from fees (Intents buybacks) is still small next to issuance. **The story is real and measurable, but price is ahead of the fundamentals. Momentum plus crowding means sharp two-way risk around CPI (Oct 14) and FOMC (Oct 28).**

---
## 1. Price & valuation [CG, last_updated 2026-10-11 13:27 UTC]
| Metric | Value |
|---|---|
| Price | **$5.36** (24h range $5.17 to $5.43) |
| Market cap | **$7.02B** (rank #20) |
| FDV | $7.02B (no max supply; FDV ≈ MC) |
| Circulating / total supply | 1.3087B / 1.3087B per CG. [NB] reports circ 1.2498B and total 1.3087B. |
| 24h volume | $583M |
| 24h / 7d / 30d | +0.8% / +10.4% / +108.3% |
| 60d / 200d / 1y | +224.2% / +312.2% / +121.1% |
| 90d (computed from CG daily closes) | $1.888 (Jul 13) → $5.355, about **+184%** |
| ATH / drawdown | $20.44 (Jan 16, 2022) / **−73.8%** |
| Relative 1y (CG markets) | NEAR +116% vs BTC −26.1%, ETH −34.8%, SOL −40.5%, SUI −59.4% |

## 2. Recent developments (about the last 6 months)
**Protocol**
- Mainnet is on protocol version **86** with **10 shards**. The shard layout V3 shows splits of shards 0, 2, 3 and 5 [RPC]. nearcore 2.13.0 (protocol 84→85) enabled **dynamic resharding**: shards split automatically at epoch boundaries based on state size ([release](https://github.com/near/nearcore/releases/tag/2.13.0-rc.1)). Stateless validation (chunk state witnesses) is live.
- **Post-quantum signing:** ML-DSA account keys are live on mainnet (Polosukhin says it launched in July; [@ilblackdragon](https://x.com/ilblackdragon/status/2108835083260162274)). NEP-645 is a draft that would formalise ML-DSA-65 as a third tx-signature scheme. It does *not* cover validator or block keys ([TokenPost, Oct 11](https://www.tokenpost.com/news/technology/29751)).
- An inflation cut from 5% to 2.5% went live in late 2025 with nearcore 2.9.0 (see §3).

**NEAR Intents / chain abstraction** [DL]
- All-time volume is **$33.44B**. Last 30d: **$4.76B**. Last 7d: $1.09B. Last 24h: $153M.
- Monthly volume: Mar $2.15B · Apr $1.83B · May $2.05B · Jun $2.35B · Jul $2.16B · Aug $2.85B · **Sep $4.80B (record)** · Oct MTD (11 days) $1.29B.
- Intents is about 80% of NEAR-chain DEX volume ($4.76B of $5.92B over 30d). Intents TVL is $223M. 30d fees are $7.85M and 30d revenue is $2.19M; trailing-1y revenue is $7.89M.
- Fee switch went live **Feb 23, 2026**. Revenue funds open-market NEAR buybacks; it is not burned ([TokenPost](https://www.tokenpost.com/news/technology/29751); [Sandmark/NEAR docs](https://docs.near-intents.org/resources/fees)). Covers 30+ to 35 chains.
- **near.com** is one account for spot across chains, tokenized stocks/ETFs (Ondo, integrated in September), perps (Hyperliquid integration, 50+ markets; **confidential by default since Sep 17**), and stock/commodity perps via trade.xyz. Robinhood Chain went live on near.com around Oct 7 to 9. Fiat on/off-ramps run via Monerium EURe/IBAN ([The Block, Oct 7](https://www.theblock.co/news/ecosystems/2026-10-07-nears-polosukhin-sees-shrinking-need-for-centralized-exchanges-as-onchain-tools-expand-417912)). Most Intents infrastructure now runs on a **confidential shard** connected through a TEE-based bridge.
- **Security incident:** on Sep 30 to Oct 1 an exploit in the Omni (HOT Bridge) deposit flow drained **about $3.865M USDT** from the BSC vault. A refund-cap fix had been public since March but was only deployed on **Oct 2** (intents.near v0.4.4). The attacker returned the funds in full ([CoinDesk](https://www.coindesk.com/tech/2026/10/01/near-intents-hit-by-usd3-8-million-exploit-as-crypto-s-rough-year-of-hacks-continues), [CertiK](https://www.certik.com/blog/hot-bridge-near-intents), [Blackpaper](https://blackpaper.wiki/incident/BP-1310/)). Deposits and withdrawals on about 11 chains stayed paused for longer while fixes were completed.

**AI / agents**
- NEAR AI Cloud offers confidential inference (Intel TDX plus NVIDIA confidential GPUs, attestation, OpenAI-compatible API).
- IronClaw 1.0 is an open-source Rust agent runtime in TEEs, launched Jul 27, 2026. There is also a confidential GPU marketplace ([near.ai blog](https://www.near.ai/blog/introducing-ironclaw-1-0)).
- Agent integrations: Circuit AI trading agents now use Intents and Confidential Intents (Oct 9, [@near_intents](https://x.com/near_intents/status/2108589493234323659)). One community post says Brave and Venice offer NEAR AI private inference (claim from [@haenko21](https://x.com/i/status/2107081133057888695); I did not verify it independently).

**Institutional**
- **Bitwise NEAR ETF (NYSE Arca: NRR)** launched **Sep 29, 2026**. Fee 0.75%. It stakes in-house ([Bitwise](https://bitwiseinvestments.com/newsroom/the-bitwise-near-etf-nrr-launches-as-first-spot-near-etp-in-the-us)). Day one: $35.5M, about 7.2M NEAR ([CMC](https://coinmarketcap.com/academy/article/near-price-jumps-10-percent-etf-draws-35m)). Cumulative flows about **$71.4M through Oct 9** (secondary tracker, [cryptoetf.today](https://cryptoetf.today/en/etf/nrr-etf-price); not checked against Bitwise's own numbers).
- **Grayscale GSNR** is still pending. S-1/A filed Jun 12, 2026. It trades on OTCQB, with no staking for now and no public SEC deadline ([SEC](https://www.sec.gov/Archives/edgar/data/2025000/000119312526269337/gsnr_s-1_amendment_1.htm)).
- **SVRN (Nasdaq: SVRN)**, formerly OceanPal, is a NEAR treasury company. It held **55.5M+ NEAR** as of Aug 27, 2026, about 4.2% of supply, and targets 10% of supply. It **acquired FastNEAR** (RPC, archival, NEARDATA) on Oct 8 ([SVRN](https://svrn.net/news/why-svrn-acquired-fastnear)).

**Ecosystem metrics**
- Chain TVL [DL]: **$248.8M** (Oct 10). Earlier points: $221.9M (Oct 3), $136.1M (Sep 10), $111.6M (Jul 12), $109.2M (Apr 13), $161.4M (Oct 10, 2025). Much of the recent rise is the NEAR price itself. Top protocols: Rhea Lend $209M, NEAR Intents $137M, Meta Pool $131M, LiNEAR $127M.
- Chain fees [DL]: 30d $9.13M (−63% m/m), 1y $57.0M. 30d revenue $2.46M; 1y $9.29M.
- On-chain activity [NB], daily averages:

| Period | Txns/day | Active accounts | New accounts | Tx fees (USD/day) |
|---|---|---|---|---|
| Oct 2025 | 4.55M | 273.7k | 246.2k | $8.3k |
| Apr 2026 | 947k | 129.5k | 22.0k | $1.0k |
| Jul 2026 | 738k | 93.4k | 14.1k | $1.5k |
| Sep 2026 | 800k | 62.9k | 12.4k | $3.7k |
| **Last 7d (Oct 4 to 10)** | **876k** | **109.6k** | 8.8k | $6.4k |

  Activity is down about 80% in txns and about 60% in active accounts year on year. Active accounts did rebound about 63% against the prior 30 days. Price is running ahead of base-layer usage. The value capture comes through Intents rather than L1 gas.
- Pikespeak: not used (no free API access confirmed).

## 3. Tokenomics
- **Inflation: 2.5% max annual issuance. Verified on-chain:** `max_inflation_rate = [1, 40]` [RPC]. The 2025 validator vote to halve issuance from 5% to 2.5% did happen. It closed when 2/3 of stake voted yes or at the Aug 1, 2025 deadline ([vote page](https://vote.linearprotocol.org/): "voting has ended", 89 votes / 255.33M). It passed with about 80% validator support and **went live with nearcore 2.9.0 in late 2025** ([Crypto Briefing](https://cryptobriefing.com/near-protocol-token-issuance-cut-proposal/)). The 90/10 split between stakers and treasury is retained.
  - Run-rate: 2.5% × 1.3087B ≈ **32.7M NEAR/yr ≈ 89.6k NEAR/day ≈ $480k/day** at $5.36 (my calculation; Crypto Briefing also cites about 89.5k/day).
- **Proposed next cut, HSP (draft):** 2.5% → **1.6%** over a 24-month per-epoch ramp (about 3.75 bp/month), with a 90-day grace period before any reduction starts. Governance could pause it but not reverse it. Author is Sal Ternullo (SVRN). The vote was slated for around **Oct 11, 2026** on House of Stake (veNEAR). Validator adoption is required separately ([forum](https://gov.near.org/t/hsp-xxx-establish-a-24-month-issuance-ramp-to-a-1-6-target-rate-of-near-token-emissions/42644)). **Status as of writing: unconfirmed.** The forum still says "Draft" and the HoS page needs JavaScript. Per the proposal, gross staking yield would go from 4.80% to 3.07%, and about 24 of 405 validators would lose viability.
- **Fee burn:** on-chain `burnt_gas_reward = [3, 10]`. 30% of gas goes to contracts and **70% is burned**, confirming the 70% figure [RPC]. In dollars the burn is negligible: total L1 tx fees are about $6.4k/day [NB], against about $480k/day of issuance.
- **Buybacks:** Intents revenue goes to open-market NEAR buys. That was $2.19M over 30d (≈$73k/day ≈ 13.6k NEAR/day at spot) and $7.89M over 1y [DL]. Even at the September pace this offsets only about 15% of gross issuance.
- **Unlocks:** none remaining. DefiLlama emissions (cached in `data/unlocks.json`) show locked = 0 and no scheduled unlocks. Genesis vesting is complete, so new supply comes from inflation only.
- **Staking:** **559.3M NEAR** active validator stake / 1.3087B ≈ **42.7%**, with 415 current validators [RPC]. StakingRewards shows about 5.27% APY ([link](https://www.stakingrewards.com/asset/near-protocol)). Bitwise NRR and SVRN both stake.

## 4. Market structure (perps), pulled about 13:30 UTC
| Venue | Funding (current) | ≈ Annualised | OI |
|---|---|---|---|
| Binance (www.binance.com/fapi) | +0.0013% / 8h | ~+1.4% | 57.74M NEAR ≈ **$310M** |
| OKX | +0.0100% / 8h | ~+11% | 12.71M NEAR ≈ **$68M** |
| Hyperliquid | +0.00325% / 1h | ~+28% | 77.76M NEAR ≈ **$417M** (24h notional volume $147M) |
| Gate | +0.0100% (indicative) | ~+11% at 8h | 23.45M NEAR ≈ $126M by position size (Gate's contract_stats says $212M; the two Gate figures don't match) |
| **Total (4 venues)** | | | **≈ $0.92B ≈ 13% of market cap** |

- **Binance OI trend (daily):** Sep 12: 42.45M NEAR ($100M) → Sep 20: 53.6M ($223M) → Oct 1: 50.6M ($247M) → **Oct 10: 58.11M NEAR ($308M)**. That is +37% in coin terms and +207% in USD over 4 weeks. OI in coins is at its 30-day high, so new leverage is coming in again after the late-September flush. Santiment noted that coin-OI peaked Sep 21 and fell about a fifth by ETF launch day (via CMC).
- **Binance 21-period average funding** is +0.0060% / 8h (min −0.0052%, max +0.0100%), which is mild.
- **Positioning:** Binance global account L/S fell from 1.52 (Oct 8) to 1.27 (Oct 9) to **1.03 (Oct 10)**. Gate account LSR fell from 1.64 (Sep 12) to **0.67 (Oct 10)**. Cointelegraph (Sep 30): "Most top $NEAR traders on Hyperliquid hold short positions." Shorts are building into strength, which is squeeze fuel if price holds, but HL funding is still clearly positive.
- **Exchange flows:** no free source available. Not included.
- **Terminal data:** NEAR is **not** in `data/perps.json`, `perps_stats.json`, `perps_universe.json`, `perps_history.json` or `analysis.json` (checked Oct 11). The terminal has **no composite grade** for NEAR. To add it, add NEAR to the perps universe.

## 5. Sentiment (X, free built-in tools)
- **Mention volume** (`$NEAR OR "NEAR Protocol" OR "NEAR Intents"`, excluding retweets): about **12.2k posts in 7 days**. Daily: 1,574 (Oct 5) → 1,613 → 1,717 → **2,212 (Oct 8 peak)** → 1,666 → 1,927 (Oct 10). The trend is rising and stable at high levels.
- **Tone:** clearly bullish and narrative-heavy. The common framing is that NEAR covers every hot narrative: quantum, privacy, perps, RWA, AI. A noticeable minority says it's overheated or wants a pullback, and there are some loud bears and shorts. There is also a lot of signal-group spam.
- **Representative quotes (as written):**
  - [@CryptoMichNL](https://x.com/i/status/2106436619553386499) (823k followers, Oct 3): "$NEAR is one of my, fundamental, favourites for this cycle… I wouldn't be surprised if this is going to be a 30-40% correction on the markets… $3.90 --> the first real area that I consider adding back".
  - [@haenko21](https://x.com/i/status/2107081133057888695) (Oct 5): "I think $NEAR can be a top 10 coin… today NEAR Intents has 500k+ monthly users, and the protocol's cut of the fees buys NEAR on the open market."
  - [@onehellofarun](https://x.com/i/status/2107599910296224012) (Oct 6): "$NEAR is breaking out, but I'd actually rather see a pullback before the next major leg… golden pocket around the 0.618 near $3.69".
  - [@angelodotsui](https://x.com/angelodotsui/status/2108697915128471711) (Oct 9): "crypto hottest narratives > quantum resistance > privacy > perps trading > rwa and tokenization > ai  $NEAR has it all".
  - [@Cointelegraph](https://x.com/Cointelegraph/status/2105437733443265019) (Sep 30): "Most top $NEAR traders on Hyperliquid hold short positions, with the largest short sitting on nearly $13M in unrealized losses".
  - [@chroe_trades](https://x.com/chroe_trades/status/2108476489788280900) (Oct 9, bear/trader): "I shorted $NEAR - TP hit (20% down, 3.5R)".
  - [@papajasepi](https://x.com/papajasepi/status/2108699263320608969) (skeptic): "I can see why @mert pivoted away from Solana, and max shilling $ZEC// $NEAR."
- Also cited: FXEmpire's Yashu Gola called the inverse H&S target $12.04 and flagged the move as "overheated" (via CMC).

## 6. Risks
- **Competition:** Solana ($6.19B TVL, $475M 30d fees) and Base ($6.21B TVL, $56M) dwarf NEAR ($249M TVL, $9.1M) [DL]. Cross-chain swap competitors include THORChain, LI.FI/Across and Relay-style intents; Hyperliquid owns perps liquidity, and near.com perps run on it. Sui is $526M TVL. NEAR's edge is Intents distribution plus confidentiality, not L1 throughput.
- **Usage vs price divergence:** L1 txns and active accounts are down 60% to 80% year on year [NB]. Chain fees are down 63% m/m [DL]. Intents volume is concentrated and cyclical.
- **Security / centralization:** the Sep 30 Omni exploit came from a known fix that was **not deployed for about 6 months**. The bridge uses an MPC/HOT vault. The confidential shard depends on a **TEE-based bridge**, which concentrates trust in hardware enclaves. FastNEAR (a large share of RPC and archival) is now owned by one public company (SVRN), which is also authoring the tokenomics changes. Governance concentration in House of Stake is unquantified here. Also unverified: an X news summary claims Intents' "SHIELD" layer froze Bitget-hack funds. If true, that shows protocol-level censorship ability, which cuts both ways.
- **Inflation pressure:** about 32.7M NEAR a year of new supply (~$175M at spot) against about $8 to 26M a year of buybacks at the 1y versus September run-rate. If the 1.6% cut is rejected or delayed, the narrative takes a hit. If it passes, lower yields could reduce the staking ratio.
- **Leverage / crowding:** about $0.9B OI (13% of market cap). Hyperliquid funding is about 28% annualised. The move is parabolic: 60d +224%, weekly RSI >75 per several analysts. ETF flows are young and small ($71M against a $7B market cap).
- **Macro:** **CPI Tuesday Oct 14, 8:30 ET (05:30 PT)**. **FOMC Oct 27 to 28** (statement Oct 28, 2:00 ET / 11:00 PT) ([Fed](https://www.federalreserve.gov/newsevents/2026-october.htm), [BLS](https://www.bls.gov/schedule/2026/10_sched_list.htm)). BTC is $83.0k and down 26% year on year. A risk-off shock would hit a high-beta, leveraged alt hardest.

---
## Bull case
1. Intents is a real cash-flow engine: $33B all-time, a record $4.8B in September, and revenue going to buybacks. near.com's "one confidential account for everything" (spot, stocks, perps, fiat) is a credible consumer product.
2. The supply side is tightening: issuance already halved, a second cut is proposed, there are no unlocks left, and ETF and treasury buyers (NRR, SVRN at 4.2% of supply and targeting 10%) stake and lock coins.
3. The narrative fit is unusually broad: post-quantum (live on mainnet), privacy, AI agents (NEAR AI, IronClaw, Circuit) and RWA. Relative strength is outstanding against majors, the chart has broken a multi-year downtrend, and shorts are building, which is squeeze fuel.

## Bear case
1. Price (+184% in 90d) is far ahead of fundamentals. L1 activity is down sharply year on year. 30d revenue of about $2.2 to 2.5M is roughly 0.4% annualised against a $7B market cap. Buybacks offset only about 15% of issuance.
2. Leverage is heavy (about 13% of market cap in OI, HL funding about 28% annualised) after a parabolic move. Several well-followed bulls (van de Poppe) expect a 30% to 40% correction toward $3.4 to 3.9.
3. Execution and trust risks: a bridge exploit from a fix left undeployed, TEE and MPC trust assumptions, infrastructure concentrated in SVRN, Intents volume that can fade with market volatility, and a still-pending governance vote.

## Key catalysts through end-2026
| Date | Event |
|---|---|
| ~Oct 11 to mid-Oct | House of Stake vote on 2.5% → 1.6% issuance ramp (result unconfirmed at writing). Validator adoption follows, then a 90-day grace period, so the earliest reduction is around Jan 2027 if approved. |
| Oct 14 (Tue) 05:30 PT | US September CPI |
| Oct (ongoing) | Full restoration of Intents deposits/withdrawals on paused chains; Bitwise NRR daily flows |
| Oct 27 to 28 | FOMC (decision Oct 28, 11:00 PT) |
| Oct 31 / early Nov | October Intents volume print [DL]: watch whether it holds ≥$4B |
| Nov 3 | US midterm elections (cited by traders as a volatility window) |
| Dec 8 to 9 | FOMC (per Fed 2026 calendar; check against federalreserve.gov) |
| TBD | Grayscale GSNR SEC effectiveness/listing (no public deadline); NEP-645 ML-DSA-65 standardisation; further near.com fiat routes and stock listings; possible nearcore releases on resharding |

## What would make NEAR outperform (measurable triggers)
1. **Intents volume ≥ $4B/month for Oct and Nov** [DL near-intents]. Intents 30d revenue ≥ $3M/month, which would make buybacks ≥ ~20% of issuance.
2. **Issuance cut passes** on House of Stake **and** validators adopt it. On-chain `max_inflation_rate` starts stepping below 1/40 after the grace period [RPC]. Staking ratio holds ≥ 40% (now 42.7%).
3. **ETF demand persists:** NRR cumulative flows > $150M by end-Nov with few outflow days, and/or GSNR goes live on NYSE Arca. SVRN keeps adding (> 60M NEAR).
4. **Leverage resets without breaking structure:** price holds above about $4.30 to 4.80 (the support levels cited by several analysts) while OI/market cap falls below ~10% and HL funding normalises below ~10% annualised. Alternatively, a short squeeze above $5.50 to 6.20 with Binance and Gate account L/S still ≤ 1.
5. **L1 usage confirms:** nearblocks 7-day average active accounts > 150k (now 110k) and DefiLlama chain TVL > $300M while price stays flat (not price-driven).
6. **No new security incidents.** Intents chains are fully restored.

## Gaps / not covered
Exchange net flows (no free source). Pikespeak dashboards. House of Stake vote tally (page needs JavaScript). Some ETF flow figures come from secondary trackers. The SOL terminal has no NEAR composite grade.
