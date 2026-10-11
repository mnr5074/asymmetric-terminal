# Velvet Capital (VELVET): tokenomics, wallets, the 2026 crashes and promoters

Built 2026-10-11 (PT). Chain: BNB Chain (BEP-20 `0x8b194370825E37b33373e74A41009161808C1488`, 1,000,000,000 supply). A Wormhole-wrapped copy on Base (`0xbf927b84…`, 13.2M supply) is backed by 13,208,148 VELVET locked in the BSC Wormhole TokenBridge, so about 98.7% of supply lives on BSC.

**Data.** This uses only free data, and **this report used 0 Nansen credits.**
- Every VELVET `Transfer` log from the mint block (53,404,174, Jul 10 2025) to block 127,028,941 (Oct 11 2026 13:37 UTC). That is 12.5M transfers from a public BSC RPC, and the summed balances match `balanceOf`.
- Sablier stream state read with `eth_call`, and contract names from Sourcify.
- CoinGecko daily prices, GeckoTerminal hourly OHLCV (PancakeSwap v3 VELVET/WBNB `0x5d2913…`), and Nansen labels already cached from an earlier pass.
- Velvet docs, blog and X posts (free built-in X reads), plus public registries.
- Findings from the separate insider-pattern pass (`INSIDER_PATTERN_REPORT.md`) are marked **[IP]**.

**Labels.** **FACT** means verifiable on-chain (tx hash or contract read) or in a cited public source. **INFERENCE** is our interpretation. A transfer to an exchange deposit address is **not** proof of a sale. All times are UTC unless marked PT.

---

## 1. Bottom line

1. **Is the team still selling? Not on BSC on-chain, as of Oct 11 13:37 UTC.**
   - In the last 30 days, none of the identified team, treasury or TGE-allocation wallets sent any VELVET. The only exception is the deployer EOA, which sent 16,360 VELVET to one wallet. This covers both Velvet Safes, both Sablier vesting contracts, and wallets 0x150c8a, 0xe2e8fa, 0xb5893a, 0x80952b, 0x3cf3d6, 0x515c18 and 0xa3277d.
   - In the last 7 days they sent nothing at all.
   - The Oct 10 "unlock" listed on tokenomics.com produced **no on-chain release**.
   - We cannot see selling of tokens that already sit on exchanges, or OTC and off-chain deals.
2. **The large insider-path exits happened in June 2026, before the two crashes that people remember.**
   - Between Jun 6 and Jun 12, wallet 0x150c8a… moved **39.04M VELVET (3.90% of supply)**, or 39.29M including an Aug 3 follow-up, to Gate, KuCoin and Bitget deposit addresses: 14.17M directly and 25.12M through 53 single-use relay wallets.
   - At hourly DEX prices that is roughly **$17.2M** of value at the time of deposit. That is not realized proceeds.
   - It received the tokens on Mar 4 2026 from 0x6bff1c…, which got exactly 72,666,667 from the **token deployer 0x579d36…** at TGE (Jul 10 2025).
   - The deployer is also **one of the 5 owners of Velvet Safe #1** (3-of-5) [IP].
   - The wallet still holds 33,381,151 VELVET.
3. **The team's own vesting was cancelled, not released.**
   - On Jul 7–8 2026, two days before the 12-month cliffs ended, Safe #1 cancelled 30 Sablier streams. That returned **312.05M VELVET** to Safe #1, including the **200M Team & Advisors stream**.
   - It re-streamed only **40.39M** to early backers (Aug 22), now starting **Jan 10 2027**.
   - About 272M of former vesting tokens, including the 200M team allocation, now sit **liquid in a 3-of-5 multisig with no on-chain schedule**.
   - Nothing has moved out of that pool since. But nothing on-chain enforces the published schedule any more.
4. **The Aug 24 crash ($0.91 → $0.14 intraday) shows no insider DEX dump on-chain.**
   - The largest non-exchange net sender on BSC between Aug 8 and Sep 1 moved only about 204K VELVET.
   - Large flows were exchange-to-exchange inventory moves between Bitget, Gate, MEXC and KuCoin. Price discovery appears to have happened mostly on CEX order books (INFERENCE).
   - The Epoch 11 airdrop was 88% auto-staked for 12 months, so it was not a material sell source.

---

## 2. Price timeline (verified)

GeckoTerminal hourly data is from the main PancakeSwap v3 pool. CoinGecko daily points are 00:00 UTC snapshots.

| Phase | Dates (UTC) | Price | Notes |
|---|---|---|---|
| Base | May–Jun 3 2026 | $0.09–0.12 | |
| **June run #1** | Jun 3 → Jun 12 | $0.093 → **$2.146** intraday high (Jun 12 09:00) | 0x150c8a cluster deposited 39.29M to exchanges between Jun 7 and Jun 12 |
| Crash #1 | Jun 12 09:00 → 21:00 | $2.15 → $0.35 (−84% intraday) | 7 relay wallets put 7.0M on Gate at 16:39–16:40 |
| **June run #2** | Jun 26 → Jun 29 | $0.51 → **$2.158** (Jun 29 02:00) | CoinGecko peak $2.08 and ~$792M market cap (Jun 29) |
| Crash #2 | Jul 2 | $1.52 → $0.456 (19:00) | Jul 1 Gate depositors were funded by Bitget withdrawals [IP and our trace] |
| Vesting cancellations | Jul 7 14:59 → Jul 8 19:16 | ~$0.42–0.47 | Section 4 |
| Epoch 11 snapshot | Aug 10 | $0.43–0.45 | Pool: 2,710,049 VELVET |
| **August pump** | Aug 11 09:00 → Aug 15 06:00 | $0.43 → $1.06 (Aug 11 11:00) → **$1.3074** high (Aug 15 06:00) | Pump started ~8.5h *before* the 12%/88% claim rules were posted (Aug 11 17:50) |
| Fade | Aug 17 | $1.03 → $0.55 | |
| **Crash #3** | Aug 24 09:00–13:00 | spike to $0.913, then **$0.16**; low **$0.1381** at 21:00 | CoinGecko volume $58M on Aug 25 |
| Grind | Sep 1 → Sep 14 | $0.094 → $0.051 | |
| Now | Oct 11 | ~$0.073 | Market cap ~$34M; CoinGecko circulating 463.8M |

The user's recollection checks out: an airdrop at about $0.40, a rise to about $1.0–1.3, then a crash to about $0.10–0.14. The DEX top was $1.27 on Aug 14 and $1.31 on Aug 15.

---

## 3. Tokenomics

### 3.1 Published allocation vs. on-chain buckets

The published figures come from docs.velvet.capital and tokenomics.com. The on-chain mapping is our reading of TGE transfers from the deployer 0x579d36… on Jul 10 2025.

| Bucket (published) | % | Published vesting | On-chain at TGE (FACT) | Mapping confidence |
|---|---|---|---|---|
| Team & Advisors | 20% | 12m cliff + 36m linear | Stream #442: **200,000,000**, start 2026-07-10, end 2029-06-09, recipient Safe #2. **Cancelled Jul 8 2026, fully refunded to Safe #1** | High (amount and schedule match) |
| Early Backers | 15% | 12m cliff + 30m linear | About 30 streams (#514–552, #613, #1485), cliff 2026-07-10, end 2028-01/07, 100–25M each. **All cancelled Jul 7–8 2026.** 40.39M re-streamed Aug 22 starting 2027-01-10 | Medium |
| Foundation Treasury | ~18.3% | 40% at TGE + 12m linear | **72,666,667** to 0x6bff1c (= 40% of 181.67M), then 0x150c8a on Mar 4 2026. **110M** stream #441 (Jul 10 2025 → Jun 10 2026) to Safe #2 | Medium-high (40/60 split matches exactly). INFERENCE |
| Ecosystem & Community | 17.5% | 42m linear | Stream #440: 165M to Safe #2, end 2028-04-10 (50M withdrawn, 25M withdrawable) | Low-medium |
| Future Listings & Marketing | 7% | 12m cliff + 30m | Not isolated | Unknown |
| Liquidity Provision | 5% | 100% TGE | **50,000,000** to 0xa3277d. That wallet funded the pool LP (0xe8b826, tx `0xbdadabfa…42c3`) and 5 market-maker-style wallets. **28.19M** went to 0x80952b on Mar 4 2026 | High |
| Growth Fund / Airdrop & Staking | 5% + 5% | 42m linear | Stream #438: 45M to Safe #2 (1M at cliff, linear to 2029-04). Monthly ~0.5–1M from Safe #1 to the deployer, which seeded monthly Gems distributors | Low-medium |
| Future Investments | 4.5% | 100% TGE | 35,000,000 to 0xcd5710 → 0xe2e8fa (Mar 4 2026); 10M to 0x9d6abf → 0x3cf3d6 (Mar 4) | Low |
| Binance Wallet IDO | 2% | 100% TGE | 20,000,000 to the IDO contract `0x1227d3…` (IDOInitializableV3) | High |
| Community round (Echo) | 0.53% | 5% TGE, 3m cliff, 24m | 5,333,333 to 0x167e53 → 0x515c18 (Mar 4). Stream #439 (5.33M) partly cancelled Jul 10 | Medium |
| Wallet Marketing | 0.2% | 100% TGE | 7.98M went to a campaign distributor `0x317cd61f…` (798/3 claims). 32M went to 0x029d7b → 0x93deb6 → 0xb5893a (Feb 2026), which sent 8.88M to a Nansen-labelled "Binance DEX/CEX Trading Bot" `0x73d8bd…` | Unknown |

**The Mar 4 2026 rotation (FACT).** Between 06:30 and 09:54 UTC on Mar 4, five TGE wallets that had been dormant since July 2025 each moved their whole balance to a fresh address:
- 72,666,667 (tx `0x2c45f5a0…1cc5`)
- 35,000,000 (`0x31b2bd36…8a48`)
- 28,193,720 (`0xc5ad978a…35b0`)
- 10,000,000 (`0x7aa6a5dd…5b05`)
- 5,333,333 (`0xda4be0e3…9660`)

The amounts are round tranches and the timing is tight. That points to one operator (INFERENCE).

**Resolved vs. the [IP] report.** That report said the creator link for 0x6bff1c was "not confirmed". Our full-history logs show the deployer 0x579d36… sent 72,666,667 to 0x6bff1c… at TGE, as a 1-token test (tx `0x1dfe7b0d38b5d7a8ffb6aad8657f5101618769dc837450e282c8ebf982e5cc86`) followed by 72,666,666 (tx `0x6fcbe41c69b03183cb67f47983c465055e1f9475e83ec35db2a246299e6d79fa`) on Jul 10 2025. The deployer is also a Safe #1 signer [IP]. **The deployer-to-wallet link is therefore on-chain FACT.** Whether the bucket is "Foundation Treasury" is still INFERENCE.

### 3.2 Where supply sits now (Oct 11, FACT)

| Holder | VELVET | % | Control |
|---|---|---|---|
| Velvet Safe #1 `0xd19dce…` | 376,633,704 | 37.66 | 3-of-5 Safe. Owners include the deployer 0x579d36 [IP] |
| Velvet Safe #2 `0x75e748…` | 160,324,313 | 16.03 | 3-of-5 Safe. 3 owners overlap with Safe #1 [IP] |
| Sablier Lockup 2025 `0x6e0bad…` | 159,283,473 | 15.93 | Streams #438/#440/#441. **39.29M is withdrawable right now** by Safe #2 |
| Sablier Lockup (new) `0x6cd06a…` | 40,391,150 | 4.04 | Backer streams, start 2027-01-10, cancelable |
| 0xe2e8fa (35M tranche) | 35,000,000 | 3.50 | EOA, untouched since Mar 4 |
| 0x150c8a (72.67M tranche) | 33,381,151 | 3.34 | EOA |
| 0xb5893a (32M tranche) | 23,105,601 | 2.31 | EOA |
| 0x80952b (from LP allocation) | 14,195,964 | 1.42 | EOA |
| 0x3cf3d6 / 0x515c18 | 10.0M / 5.33M | 1.53 | EOAs, untouched |
| veVELVET vault `0x61e0e1…` | 4,838,502 | 0.48 | Staking |

**Roughly 87% of supply is in team-controlled Safes, vesting contracts or dormant TGE wallets** (INFERENCE on control for the EOAs). The main DEX pool holds only 4.14M VELVET (about $570K liquidity).

**Float illusion.** Market caps of $650–790M in June were set by trading a float of a few percent. That float sat beside about 870M tokens which, on-chain, need only a multisig signature to move. Since the Jul 8 cancellations, about 272M of them are not under any time-lock at all.

The staking side is small. veVELVET holds only 3.3–4.8M (0.3–0.5%), so staking was **not** a large float lock. The "staking-lock" part of that catalog pattern does not fit VELVET. What fits is a **vesting- and treasury-lock** illusion.

CoinGecko's circulating count jumped by 40.4M on Aug 23, right after the Aug 22 re-stream into the new Sablier contract. Our reading is that the data provider did not treat that contract as locked (INFERENCE).

### 3.3 The Epoch 11 airdrop (the user's 54,000)

- **FACT.** On Aug 11 2026 at 17:50 UTC, Velvet announced on X that Epoch 11 pays **12% liquid and 88% "VELVET staked for 12 months"** ([post](https://x.com/Velvet_Capital/status/2087235170185224350)). The rule was published after the Aug 10 snapshot.
- **FACT.** Safe #1 funded it with 275,000 to the liquid-claim contract `0xcfa0ef…` (tx `0x3b6f7390…98cf7`) and 2,017,104 to the staked-claim contract `0x276d0c…` (tx `0x3584601d…ef50`). The staked-claim contract forwards into the veVELVET vault `0x61e0e1…`.
  - Total funded: 2,292,104 of the advertised 2,710,049.
  - Paid so far: 237,894 liquid across 1,633 claims, and 1,737,361 staked.
- **INFERENCE.** One liquid claim of 6,504 VELVET (implying an allocation of 54,201) sits at rank 4, which gets 2% of the pool. That matches the user's ~54,000 allocation, of which ~6,480 would be liquid. We do not assert which wallet is the user's.
- **INFERENCE.** Liquid airdrop tokens totalled only 0.024% of supply. Airdrop recipients were not a material sell source in the August crash.

---

## 4. Wallet-level story

### 4.1 June 2026: the 0x150c8a distribution (the largest insider-path exchange flow)

- **Funding (FACT).** Deployer 0x579d36 → 0x6bff1c (72,666,667, Jul 10 2025) → **0x150c8a** (Mar 4 2026).
- **Jun 6 18:57 → Jun 11 09:12 UTC.** The wallet sent:
  - **14,167,421** directly to 21 Gate deposit addresses, for example `0xe206294d…9034` (1.24M) and `0x8b130f7d…afa` (1.16M) on Jun 8 13:51–13:56.
  - About **25.1M** to 53 fresh relay wallets of ~0.4–1.1M each. Those relays then deposited **13.84M to KuCoin**, **4.27M to Bitget** and **7.0M to Gate** (Gate total, direct plus relayed: 21.17M).
- **Jun 12 16:39:46–16:40:03 UTC.** Seven relay wallets deposited 7,003,254 to Gate within 17 seconds. This was during the intraday crash from $2.15 to $0.35. Example txs: `0xef480cb1…def7`, `0x3501e607…0f3e`, `0x34959646…66f0`.
- **Total: 39,285,516 VELVET (3.93%), ~$17.2M at hourly DEX prices.** 39,035,516 of that moved Jun 6–12. The remaining 250,000 went toward Bitget through a relay on Aug 3.
- **Exchange totals.** Net CEX inflow from all addresses in Jun 1–24 was about 48.7M (Gate +25.8M, KuCoin +15.2M, Bitget +7.6M). The 0x150c8a cluster accounts for about 80% of it.
- **The [IP] figure.** It reported ≥26.35M to 25 Gate/KuCoin deposits on Jun 7–9. Ours is the more complete count: it includes Jun 11–12 and the Bitget relays.
- **Neutral reading.** A deposit does not prove a sale. Treasury tokens could also go to market makers. But the pattern of single-use relays and a deposit burst at the top is consistent with distribution into the run-up (INFERENCE).

### 4.2 Liquidity allocation wallet (0xa3277d → 0x80952b)

- **FACT.** The 50M bucket seeded the DEX pool and 5 market-maker-style wallets at TGE. 28.19M went to 0x80952b on Mar 4.
- **May 2026 (FACT).** 0x80952b sent 2.17M to Gate and about 5.8M to three wallets (0xa92a3f, which was a TGE recipient, 0x160aafa3 and 0xfb442fa1).
- **Jun 5 (FACT).** It sent 5,000,000 to 0xa6608acb.
- Using the liquidity allocation for market making is disclosed in the docs. These moves are consistent with that purpose.

### 4.3 Late June / Jul 2 crash

- **FACT.** The three wallets Nansen flagged earlier — 0x2ef99d (412,090), 0x7e64fa (456,877) and 0x9b4e1b (418,760) — deposited to Gate on Jul 1 05:17–05:22.
- **FACT.** All three were funded **by Bitget withdrawals on Jun 30**, with 10K–20K test transfers first. Our trace and [IP] agree.
- **INFERENCE.** This looks like one entity moving inventory between exchanges. No on-chain link to the team was found.
- **FACT.** Between Jun 25 and Jul 12 the largest non-exchange net senders were small (≤373K). CEX net flows were mixed: Gate +1.5M, KuCoin +1.5M, Bitget −2.5M.

### 4.4 Jul 7–8: vesting cancellations (FACT)

- **Jul 7 14:59 → Jul 8 19:16 UTC.** Sablier streams were cancelled in 31 refund transfers totalling 312,051,691 VELVET refunded to Safe #1.
  - The 200M team stream: tx `0x6b393738e1b32a8d0bb79d25af362890921e4b02986c0ce776689083f5ff8e96` (Jul 8 18:24).
  - The Echo community-round remainder (3,090,669) on Jul 10 11:59.
- **Aug 22 07:58–09:35 UTC.** 40,391,150 was re-streamed through a new BatchLockup (`0xf90ca7…`) into Sablier `0x6cd06a…` (e.g. tx `0x87debb78…6139`).
  - These are 22 streams, cancelable, linear 2027-01-10 → 2029.
  - Several recipient addresses changed (e.g. 4a8c67 → c4b1c4, 2d1eef → 267a5c).
  - Not re-streamed: the 200M team stream, plus 25M (0xff4e09), 16M (0x5287a9), 10M (0x5d51a7), 8M (0xce147d), 6.25M (0xb87c2a), 4M (0x50081f) and 0.78M (0x9fb281). Those amounts stay in Safe #1.
- **No public announcement** of these changes was found in the posts we read. We may have missed one.

### 4.5 August pump and the Aug 24 crash

- **FACT.** Aug 8–Sep 1: the largest non-exchange net senders were only 204K (0xefbe44), 97K and 96K.
- **Exchange flows during the crash window (Aug 24 08:00 → Aug 26).**

  | Exchange | Net flow |
  |---|---|
  | Gate | −18.2M (net withdrawals) |
  | Bitget | −6.1M (net withdrawals) |
  | Binance-labelled bot | +7.6M (net inflow) |

  These were mostly exchange-to-exchange hops:
  - 0x55e42ffd: Bitget → MEXC, 1M and 3M on Aug 24 11:49–14:27.
  - 0x1c1dc22f: Bitget → Gate, 7.15M on Aug 25–26.
  - 0x5cba1298: repeated Gate → Bitget transfers.
  - 0x04e47f01: Bitget → KuCoin.
- **INFERENCE.** These look like market makers or arbitrage desks rebalancing, not insiders entering the market. Selling of tokens already on exchanges cannot be seen on-chain.

### 4.6 After the crash

- **Sep 7 (FACT).** Holder 0x7313e2be moved 11.69M through contract 0x2704b216 to three wallets: 5M, 4.25M and 2.44M. These wallets had originally withdrawn from Gate in Dec 2025. None of it went to an exchange.
- **Oct 1 (FACT).** 0xed9ab5bc consolidated about 19.8M, mostly withdrawn from Bitget-labelled wallets, into 0x4cad1e. Tokens left an exchange; this is not selling.
- **Last 30 days (FACT).** The biggest non-exchange net senders were 0x8216affe (1.43M, Oct 3), 0x91dca378 (1.35M) and 0xc83c9bcd (941K, Oct 4, an Epoch 11-era recipient). None has a traced team link.

### 4.7 Remaining schedule

- **On-chain (FACT).**
  - Streams #440 and #438 accrue about 6M per month to Safe #2. 39.29M is withdrawable now and has not been claimed.
  - Backer re-streams total 40.39M, linear from Jan 10 2027, about 1.7M per month.
- **Off-chain (FACT).** The 200M team allocation and about 72M of other cancelled backer tokens have **no on-chain schedule**. Any release from Safe #1 is at the signers' discretion.

---

## 5. Team, entity and location

- **Founder & CEO: Vasily Nikonov** (X: @defivas, "Founder @Velvet_Capital").
  - Sources: [LinkedIn](https://linkedin.com/in/vasily-nikonov), IQ.wiki, Fundraising Fox, and the *Behind Company Lines* podcast ep. 280.
  - Background: BCG 2015–2022 (Project Leader, New York; earlier Sydney), LongHash Ventures venture builder (Singapore, 2019), MBAs from INSEAD and Wharton, MSc/BSc from MIPT.
- **CTO: Ankit Raj** (since May 2022). Background: BigchainDB, Red Hat, Ethereum Foundation research, co-founder of BitBerri and BlockVidhya (theorg.com, Crunchbase).
- **Jay Singh Dhakad** is listed as a co-founder by StartupIntros.
- **Michael Hage** is "Chief Degen Officer" (LinkedIn company page). X **@degen_mike14**'s bio says "Building @Velvet_Capital @VU_Virtuals". The handle-to-person match is INFERENCE.
- **Funding.** $3.7M announced Jul 9 2025 ([blog](https://blog.velvet.capital/p/velvet-raises-37-million-to-launch)). YZi Labs and Blockchain Founders Fund led. Other backers include FunFair, Selini, Mucker, PAKA, LucidBlue, Mindfulness, SkyVision, Gate Labs, Poolz, NexGen, Cointelegraph Accelerator, Gains Associates, Rarestone, Echo and DWF Ventures.
- **Entities.**
  - **Velvet DAO Limited**: British Virgin Islands, reg. no. 2109304, incorporated Oct 12 2022 (i-BVI). Crunchbase lists it as the legal name.
  - The current [Terms of Service](https://www.velvet.capital/terms-of-service.html) (updated May 13 2026) name **Stronghold Fund One Inc.** (Panama, Law 32 of 1927; Panamanian registry shows incorporation in April 2024) as the operator. Disputes go to arbitration seated in Panama.
- **California.** Crunchbase and LinkedIn list headquarters as **San Francisco, CA**. Both are self-reported.
  - We **could not verify** any California (or Delaware) registration. The CA Secretary of State bizfile search blocked our automated request, and no public record surfaced.
  - The LinkedIn staff breakdown is about 12 people across India (5), the US (2), Brazil, Nigeria, Pakistan and Singapore.
  - Treat "California-based" as **unproven**. A manual bizfileonline.sos.ca.gov search is the next step.

---

## 6. Promoters on X

### 6.1 The "on-chain video" livestreams

- **FACT.** "Trenching on VelvetX" livestreams were hosted by **@degen_mike14** with guests **@PhilOnChain** (40.9K followers) and **@jcrew_eth**, whose bio lists @Velvet_Capital. Velvet's account amplified them:
  - Aug 20, with jcrew_eth.
  - Aug 25 15:00 UTC, with PhilOnChain. That was the day after the Aug 24 crash.
  - Oct 8.
  - @Velvet_Capital also reposted **@cometcalls** (103.5K) on Aug 25: "Follow my trades live".
- **INFERENCE.** These are the most likely "couple of guys doing on-chain videos". degen_mike14 describes himself as building Velvet, so he is team-affiliated, not an independent reviewer.

### 6.2 Other promoters and what they disclosed

| Account | Followers | Evidence (FACT) | Disclosure |
|---|---|---|---|
| **@TheBullishTradR** [IP] | 63.8K | Unlabeled $VELVET promos, e.g. "$1 is inevitable" (Dec 17 2025). The creator and Safe #1 sent **48,577 VELVET** to `thebullishtradr.eth` (0x559acc…): 20,800 from Safe #1 on Nov 3 2025 (tx `0x09e860b8…`) and 27,777 from the deployer in Dec. Part was sold ~2.4h after receipt | Only "affiliate", in a Dec 19 reply. The ENS name and X handle match by name only (unproven link) |
| @100xDarren | 23.4K | Repeated VelvetX promos with referral codes "DARREN" and "100x". Wrote "I think **we** only get 12% upfront" (Sep 22) | Referral codes are visible; no #ad |
| @CryptoTeluguO (CryptoTelugu YouTube) | 167K | Jul 30 airdrop guide with code "TELUGU" (48.7K views). A reply accused him of "paid partnership" | No disclosure seen |
| @QuintenFrancois | 216.8K | Jul 21 Gems-season promo | None seen |
| @TruthChain (WEB3 VDM) | 5.2K | Many VelvetX threads | Bio: "Amb @Velvet_Capital" |
| @Tomheroy_io | 9.0K | Epoch threads | Bio: "Ambassador: @Velvet_Capital" |
| @kreator_nobot | 7.1K | Video posts | Calls himself an "ambassador" in a post |
| @VegaSnipes | 5.9K | Code "SNIPES" | Bio: "Team @velvet_capital ⬩ Ambassador" |

- **Coordinated wave (FACT).** Aug 21–25: @danielsamuel_et, @Adielevictor123, @Xaint___, @LoveOkon01, @manincrypto332, @TheKarenEddy, @wizzybanks26 and @Tomheroy_io posted near-identical "over $1M airdropped, Epoch 12 is LIVE" threads within hours of Velvet's Aug 21 post. Most had no disclosure.
- **INFERENCE.** This is consistent with an ambassador or KOL campaign. The docs describe a referral/Growth program (50% fee share).
- **On-chain ties.** Apart from thebullishtradr.eth, we found **no published wallets** for these accounts. So we have not shown any of them received VELVET from team or marketing wallets.

---

## 7. What remains unproven

1. **Who controls 0x150c8a and the other Mar 4 tranche wallets.**
   - The deployer link is on-chain (FACT). Which tokenomics bucket they belong to, and whether the June deposits were sales or market-maker inventory, is not.
   - Exchange KYC or the team's own disclosure would settle it.
2. **Whether the 200M team tokens returned to Safe #1 count as "unlocked".** Velvet has not, in what we read, published a new team schedule.
3. **CEX-side selling.** Tokens already on Gate, Bitget, KuCoin, MEXC and Binance cannot be traced.
4. **Promoter compensation.** Apart from 0x559acc, no payment trail was found, and the ENS-to-X match is by name only.
5. **California registration.** Not verified.
6. **Recipients of the large non-re-streamed backer streams.** We have not identified who 0xff4e09 (25M), 0x5287a9 (16M), 0x5d51a7 (10M) and 0xce147d (8M) are.

## 8. Optional Nansen plan (not executed, 0 credits spent)

This is only if the user later approves it. At about 1 credit per call it comes to roughly **20 credits**:
- Address labels/related wallets (`/profiler/address/labels`-type lookups) for 0x150c8a, 0x6bff1c, 0xe2e8fa, 0xb5893a, 0x80952b, 0x7313e2be, 0xed9ab5bc/0x4cad1e, 0xff4e09, 0x5287a9, 0x5d51a7 and 0xce147d. That is about 11 calls.
- Counterparties for 0x150c8a and 0x80952b. That is 2 calls.
- Token holder/flow intelligence for VELVET, Jun 5–13 and Aug 23–26. That is about 4 calls.
- Spare for retries: about 3 calls.

The labels endpoints that cost 100–500 credits each should be avoided.

Data: `data/velvet_postcrash.json`; working files in `/workspace/velvet/` (`tx.db` holds the full transfer history).
