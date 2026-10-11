# Velvet-structure screen: headline buckets locked, other insider paths liquid

Built 2026-10-11 (PT). Data: GoPlus, DexScreener, CoinGecko, public RPC `eth_call` (balances and Safe `getOwners`), the existing Nansen cache, the built-in X read tools (about 10 of 1,000 daily reads), and public reports. **Update (2026-10-11): 37 approved Nansen credits** (balance went from 2,038 to 2,001; the cap was 60). The raw Nansen responses are in `data/insider_pattern_nansen_raw.json`.
Data files: `data/insider_pattern.json` and `research/insider_pattern/{screen,safe_overlap}.json`. Scripts: `research/insider_pattern/*.py`.
The worker's Velvet exposé (`research/velvet_postcrash.*`) did not exist at build time, so the VELVET row here is my own.

**Scale:** each pattern is scored 0–3. P1 = vesting opacity, OTC transfers and intermediary hops. P2 = undisclosed promoters. P3 = airdrop asymmetry. P4 = cosmetic liquidity. "–" means the pattern was not assessed.
**Wording:** a transfer to an exchange is not evidence of a sale. Allegations are attributed to their source. Nothing here asserts fraud.

| # | Token | Chain | P1 | P2 | P3 | P4 | Confidence | Change after Nansen |
|---|---|---|---|---|---|---|---|---|
| 1 | LAB | BSC | 3 | 1 | 2 | 1 | high (path) / medium (intent) | ↑ from #3. Full path verified |
| 2 | LAPTOP | Base | 3 | 0 | 2 | 3 | high (facts) / medium (intent) | Labels and hops verified |
| 3 | RAVE | ETH/BSC/Base | 3 | 1 | – | 1 | high (path) / allegation | ↑ Same-signer Safe → Bitget verified |
| 4 | VELVET | BSC/Base | 3 | **2** | – | 1 | high (structure) / medium | P2 raised. The team link to the large sellers is **not** confirmed |
| 5 | RIVER | ETH/BSC/Base | 3 | 1 | 3 | 0 | medium | Bitget-withdrawal cluster verified (BSC) |
| 6 | M (MemeCore) | BSC/L1 | 2 | 2 | – | 3 | medium | Kraken deposit and DEX selling verified |
| 7 | MELANIA | Solana | 2 | 0 | – | 3 | medium (reported) | not queried |
| 8 | SIREN | BSC | 2 | 0 | – | 3 | medium-high | Single-controller timing; custody-vault label |
| 9 | MMT | Sui/BSC | 2 | – | – | – | medium (reported) | not queried |
| 10 | COAI | BSC | 2 | – | – | 1 | medium | Safe → Bitget the day after TGE verified |
| 11 | STONK | Solana | 2 | – | – | – | medium | – |
| 12 | OM | ETH/MANTRA | 2 | – | – | – | low-medium (disputed) | – |
| 13 | ALLINU (meme) | Solana | 1 | – | – | – | medium | – |
| 14 | AKE | BSC | 1 | – | – | – | low-medium | – |
| 15 | ANSEM (meme) | Solana | 1 | – | – | – | low | – |

The evidence for each row (addresses, transaction hashes, amounts, and what is verified versus reported versus inferred) is in `data/insider_pattern.json`.
Checked but not matching: BEAT (reports describe a leverage unwind, with no team distribution found), H (an admin-key exploit, a different mechanism), COAI's Bubblemaps cluster (not tied to the team).

## Key links confirmed with Nansen (2026-10-11)
Times are UTC as returned by Nansen. Amounts are in tokens. USD figures are Nansen's values at transfer time. In `data/insider_pattern.json`, each candidate has new fields: `nansen_verified`, `upgraded_from_reported` and `not_confirmed`.

**LAB: the reported path is now verified end to end.**
- **Apr 8, 14:58–15:03:** five Safes sent about 200.0M LAB to the EOA 0xe03722…21dd, which Nansen labels "LAB Distributor".
  - The five Safes: 0x80b069… (80M), 0xf760b3… (64.8M), 0x36fc85…, 0xec99ab… and 0xa7d234….
  - Public RPC shows the same 3-of-4 signers as LAB's top-holder Safes 0x78a79d… and 0xf79ff8….
  - Bybit funded the Distributor's gas 40 minutes earlier.
- **Same afternoon:** the Distributor sent 100M to Bitget deposits 0x77156a… and 0xe39f91…, and 36M to Gate deposit 0x8728f7….
- **Apr 23:** two chains of 7–8 single-use hops each (about 9–16 minutes) took at least 59.0M LAB to Bitget deposits 0xdd77bf… and 0x6593aa….
- **May 11–12:** Bitget withdrew 99,999,579 LAB to exactly 10 wallets.
- **Jul 10–11:** two of those wallets (0xf05ced… and 0x82fc0b…) funded the three Astherus depositors with 22.99M LAB.
- **Upgraded to verified:** ZachXBT/Lookonchain's ">196M via Bitget" and "~100M to 10 wallets".

**LAPTOP**
- Nansen labels "wallet F" 0x246c84… as "LAPTOP Distributor".
- **Launch-day transfer:** at 12:06:13 on Sep 9 it sent 30,000,000 to 0xef36a582b2d7922ba238359448899d4d643096c3 (tx 0x1bd73c8d…). Nansen labels that recipient **GSR**, a market maker, not a fresh wallet.
- **Sep 18 onward:**
  - 00:52: the Distributor sent 25,015,385 to the fresh wallet 0xb47e6c….
  - 01:00: that wallet passed it to 0xae823f….
  - Sep 18–24: 0xae823f… deposited to KuCoin (18.67M), Gate (4.01M) and Kraken (2.34M).

**RAVE**
- **Nov 2025:** "RaveDAO: RAVE Multisig" 0x6020656d… sent 35M to Safe 0x53d7d5…. That Safe shares 4 of its 5 signers with the 78.4% multisig.
- **Apr 12, 2026:** 0x53d7d5… sent 8.98M to Bitget deposit 0x2dc20f… and 3.0M to Gate deposit 0x317112….
- **Apr 19, 2026, 19:47:59:** in a single tx (0xcea5f160…), 0x53d7d5… sent 23.0M to two fresh EOAs. Both forwarded to Bitget deposits within 4–6 minutes.
- **Direct CEX deposits from the multisig:** Gate, MEXC and LBank (small amounts).
- **Recurring payouts:** EOAs funded by the multisig made recurring fixed-amount payouts. One recipient carries the Nansen label "Funded @langeriuseth On Friend.tech" and sent its 25,000 to Bitget within 5 minutes. The purpose of these payouts is unknown.

**VELVET**
- **Mar 4:** fixed-amount tranches moved between wallets (72,666,667 / 35,000,000 / 28,193,720 / 10,000,000 / 5,333,333).
- **0x150c8a…:** received the 72.67M on Mar 4. On Jun 7–9 it sent at least 26.35M to 25 Gate and KuCoin deposit addresses.
  - This verifies Bubblemaps' "72M in March" finding.
  - However, the sender 0x6bff1c… has no VELVET inflow visible since Oct 2025, so the link to the creator is **not confirmed**.
- **Earlier hypothesis rejected:** the Jul 1 Gate depositors were funded by Bitget withdrawals, not by the Safes or the creator.
- **P2 (promoter):**
  - The creator and Safe 0xd19dce… sent 48,577 VELVET to thebullishtradr.eth (0x559acc…). The wallet sold the Dec 4 tranche of 27,777 about 2.4 hours later.
  - X @TheBullishTradR (63.8K followers) posted unlabeled $VELVET promos, for example "$1 is inevitable" on Dec 17. He disclosed being an "affiliate" only in a Dec 19 reply.
  - The ENS name and the X handle match by name only.

**RIVER**
- Nansen labels the wallets "RIVER Concentrated Supply Group".
- **Bitget withdrawals on BSC:** on Dec 3 and Dec 29, 2025, Bitget paid out to cluster wallets, including 0x67902d… (Bubblemaps' "0x6790…").
- **Gas funding:** cluster wallets were gas-funded within the same few seconds on Dec 1 at 04:39 UTC.
- **Amount gap:** only about 2.8M RIVER is visible on BSC, against the 230M reported.
- The creator link is **not confirmed**.

**M**
- **Jun 20, 2025:** 207.2M M was minted to 0x6f1f0a….
- **Jul 3, 2025 (listing day):**
  - 4.0M went to Kraken deposit 0xaa1f9f… (tx 0x89f9ca02…).
  - 15.72M was sold into PancakeSwap.
  - 175M went via 0x06ef57… to Binance (100M) and to "Binance: DEX/CEX Trading" (75M).
- **Partly verified:** ZachXBT reported 5.3M to two Kraken deposits. Nansen shows one deposit of 4.0M on BSC.

**SIREN**
- The Hedgey redeemers forwarded their balances within 5 seconds of each other.
- Two of them sent to the Nansen-labeled "SIREN Custody Vaults".
- Three of the redeemers were first funded within 40 minutes on Jan 15, 2025, by different unlabeled wallets.

**COAI**
- Safe 0x24c667…, which uses the same 2-of-3 keys, sent 10,000,000 COAI to Bitget deposit 0x0e7bf0… on Sep 26, 2025, the day after TGE (tx 0xb640a6e5…).
- Nansen labels 0x8348bc… "COAI Multisig" and 0x7a1818… "COAI Distributor".

## Credits used
- **Balance:** 2,038 before, 2,001 after, so **37 used** out of the 60 cap.
- **By endpoint:** 26 × tgm/transfers, 9 × first-funder, 2 × profiler/transactions.
- **By token:** VELVET 9, M 6, RIVER 5, LAB 4, SIREN 4, RAVE 3, promoter wallets 3, LAPTOP 2, COAI 1.
- **Not charged:** 3 calls timed out without being charged (checked against the balance). The account and entity-search calls were free.
- **Avoided:** labels endpoints (100–500 credits each) and counterparties (5 credits each).

## Remaining gaps
- The upstream source of VELVET's Mar 4 tranches. It may sit in pre-Oct-2025 history or come via a bridge.
- The RIVER creator funder (0x365b…), and RIVER flows on chains other than BSC.
- M promoter rewards on MemeCore L1, which Nansen does not cover.
- Which published tokenomics bucket each Safe is, for LAB, RAVE, LAPTOP and COAI.
- MELANIA and MMT were not queried.
