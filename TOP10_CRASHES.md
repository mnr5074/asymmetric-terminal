# TOP 10 crypto crashes: Oct 2024 to Oct 11, 2026, ranked by market cap lost

Built 2026-10-11 (PT). **Free data only.** I made zero calls to Nansen or X, and I did not touch NANSEN_API_KEY or X_BEARER_TOKEN.
Sources: local crash catalog (`data/crash_catalog.json`, `data/cg_series/`, `data/crash_series/`), CoinGecko free API (`/coins/markets` top 2,500, plus `/coins/{id}/market_chart?days=365`, which covers 2025-10-12 to 2026-10-11), Binance public kline archives (data.binance.vision), and news (CoinDesk, The Block, Decrypt, Reuters and others, cited per row). Raw pulls are saved in `research/top10_raw/`.

## Method
- **Market cap lost = peak circulating market cap minus trough circulating market cap.** Peak-minus-now is also shown.
- **Peak** = ATH price × circulating supply at the time. This is an intraday basis, the same one news reports use. Where only CoinGecko daily-close data exists, the daily-close peak is shown too.
- **Trough and now** come from CoinGecko daily `market_caps`, 365-day window. "Now" is 2026-10-11.
- **Inclusion:** the token set its ATH inside the window, and it fell at least 80% from peak to trough. That makes these token-specific collapses. Established coins whose ATH predates the window (DOGE, ADA, AVAX, SHIB, DOT and similar) are excluded, even when their 2025-26 bear-market drawdowns were larger in dollars. See the notes at the end.
- **Type:** *Near-vertical* means most of the drop came within about 1-3 days. *Slow bleed* means it played out over weeks or months.
- Dates are UTC calendar days.

## Ranked table

| # | Token | Chain | Peak mcap (circ.) | Peak date | Main crash | Peak→trough | Price ATH→now | **Mcap lost (peak→trough)** | Peak→now | Type | Cause (one line) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **PI** (Pi Network) | Pi mainnet | ~$16B (reported $16B; self-reported >$18B) ⚠ | 2025-02-26 | No single event; bleed from Mar 2025 | -94.8% (trough $0.84B, 2026-07-17) | -97.2% | **~$15.2B** (up to ~$17.2B on the $18B figure) | ~$15.1B | Slow bleed | Circulating supply grew from 6.3B to 11.2B on a thin-liquidity, referral-driven token |
| 2 | **TRUMP** | Solana | $14.5B | 2025-01-19 | 2025-01-19/20 (-47% in hours, ~$6B gone), -77% by 2025-02-04 | -97.6% (trough $0.35B, 2026-08-14) | -97.4% | **~$14.2B** | ~$14.0B | Sharp day-1 drop, then slow bleed | Inauguration hype peak, the MELANIA launch, 80% insider supply, unlocks |
| 3 | **PEPE** | Ethereum | $11.8B (fixed 420.69T supply) | 2024-12-09 | Gradual; no single crash day | -91.7% (trough $0.98B, 2026-07-02) | -85.7% | **~$10.8B** | ~$10.1B | Slow bleed | Memecoin cycle unwind plus the 2026 bear market |
| 4 | **LAB** (LABtrade) | BNB Chain | ~$8.6B intraday ($27.48 × ~313M); $6.18B daily close (06-27) | 2026-06-02 | **2026-07-07/08**: $14.09→$1.25 in 2 days (-85% in 24h) | -99.6% (trough $37M, 2026-09-11) | -99.8% | **~$8.6B** (daily-close basis $6.15B) | ~$8.6B | Near-vertical | ZachXBT: insiders controlled the float and manipulated price through a market maker; a team-funded wallet dumped; unlocks |
| 5 | **OM** (MANTRA) | MANTRA chain / ERC-20 | ~$8.2B (reported) ⚠ supply figures vary | 2025-02-23 | **2025-04-13**: $6.26→$0.37 intraday (-90% in ~1h, $5.4-5.5B wiped) | -99.7% (now ~$24-30M; OM→MANTRA 1:4 redenomination, Mar 2026) | ~-99.8% (old-OM terms) | **~$8.2B** | ~$8.2B | Near-vertical | Concentrated supply, large deposits to exchanges, a forced-liquidation cascade |
| 6 | **MNT** (Mantle) | Ethereum L2 | ~$8.9-9.1B (reported) ⚠ | 2025-10-09 | Began with the 2025-10-10 market crash ($5.3B by 10-12), then bled | -85.6% (trough $1.30B, 2026-08-01) | -80.4% | **~$7.7B** | ~$7.1B | Slow bleed | Exchange-linked L2 token peaked the day before the $19B liquidation event, then rode the bear market down |
| 7 | **RAVE** (RaveDAO) | Ethereum / BNB / Base | ~$6.8B intraday ($27.33 × ~248M); $5.48B daily close | 2026-04-18 | **2026-04-18/19**: $28.3→$0.53 on Binance perps (-90% in 24h) | -99.3% (trough $45M, 2026-09-17) | -99.4% | **~$6.75B** (daily-close basis $5.43B; Decrypt says $6.6B) | ~$6.7B | Near-vertical | Alleged insider short squeeze; ~90% of supply sat in 3 team multisigs; Binance and Bitget opened probes |
| 8 | **WLFI** (World Liberty Financial) | Ethereum | ~$8.2B ($0.331 × 24.67B circ.; reported $7-8.7B; FDV >$30B) ⚠ | 2025-09-01 | Gradual (-45% in the first 4 days) | -80.0% (trough $1.63B, 2026-08-09) | -82.8% | **~$6.5B** | ~$6.4B | Slow bleed | Selling after launch and a growing circulating supply (24.7B to 31.8B) |
| 9 | **M** (MemeCore) | MemeCore L1 / BNB | ~$6.3B ($4.869 Binance high × 1.294B); $5.9B daily close | 2026-04-24 | **2026-06-25**: $2.92→$0.51 (-75% in a day, ~$3B wiped) after a ~40% two-month drift | -87.7% (trough $0.78B, 2026-06-30) | -79% vs the Apr high (has rebounded) | **~$5.5B** | ~$4.2B (now $2.15B) | Near-vertical main leg | Ghost market cap: under $100k of on-chain liquidity, concentrated supply, ZachXBT manipulation claims |
| 10 | **COAI** (ChainOpera AI) | BNB Chain | $4.29B (daily close; CG's $43.81 ATH treated as an artifact) | 2025-10-17 | 2025-10-17→21: -76% in 4 days | -99.0% (trough $42M, 2026-06-07) | -99.3% | **~$4.2B** | ~$4.2B | Fast collapse (4 days), then bleed | 100x AI-token pump unwound as leverage was liquidated and holders took profit |

**Statistical tie at #10, all ~$4.2B lost:** **BONK** (Solana; ~$4.4B peak on 2024-11-20, trough $0.20B on 2026-08-13; slow bleed) and **IP / Story** (Story L1; ~$4.26B peak on 2025-09-21 per a Phemex blog, which is a weak source; trough $62M on 2026-08-19; slow bleed). The differences among COAI, BONK and IP are inside the data uncertainty.

⚠ = the peak relies on reported figures or on circulating-supply estimates that vary by source. Treat these as ±10-15%.

## Below the cut (requested candidates), peak→trough circulating mcap
- **LIBRA** (Solana, 2025-02-14): reported peak ~$4.5B, but about 82% of supply was insider-held, so this is effectively FDV ⚠. It fell 94-95% in ~11 hours to ~$232-257M (Cointelegraph, The Block). Near-vertical, $107M insider cash-out. If the FDV figure were accepted it would sit around #10 (~$4.3B lost). It is not ranked because the circulating figure is unclear.
- **AI16Z** (Solana): ~$2.7B peak on 2025-01-01, -100% in the catalog. It migrated to ELIZAOS, so it is not directly comparable. Slow bleed.
- **FARTCOIN** $2.48B (2025-01-19) to trough $0.106B. **PNUT** $2.44B (2024-11-13) to $0.038B. **MELANIA** ~$2.1B (2025-01-20; circ. ~162-192M; CoinGecko now shows 1B circ., so the catalog's $13B is wrong) to $0.067B. **POPCAT** $2.0B (2024-11-17) to ~$0.046B. **SIREN** $1.74B (2026-03-24) to $0.017B, with -57% in a day on 03-25. **GOAT** $1.35B to $0.016B. **AIXBT** $0.94B. **PIPPIN** $0.81B (2026-02-25) to $0.0135B. **VELVET** $0.79B (2026-06-29) to $0.024B. **MOODENG** $0.67B. **GRIFFAIN** $0.62B. **VINE** $0.47B. **MAMO**, **BOSS**, **ALLINU**, **ANSEM**, **PONS**: all under $0.25B peak.
- **WIF**: ATH was in March 2024 (outside the window), so it is excluded by rule.
- Large caps that just missed the 80% bar: SUI (-79.4%), ONDO (-77%), ASTER (-70%), EDGE (-77%).

## Excluded as data artifacts
- **AIAT** (CG "$9.1B"): prices alternate between $0.25 and $80 with zero volume. Artifact.
- **EVER** (CG "$3.5B", 2026-05-29): a 1-2 day spike from $0.003 to $1.77 on $0.8M volume. Artifact.
- **LAPTOP** (CG "$9.6B", 2026-09-09): first listing day on $0.3M volume. The real peak was about $0.65B.
- Ruble stablecoin **A7A5**, and **PENGU** and **Magic Eden ME**, whose TGE first-minute wicks ($0.07 and $17) gave inflated "peaks".
- Catalog `peak_mcap_est` entries flagged artifact_risk, such as RIPS and LEASH.
- **MemeCore** CG ATH $5.64 (2026-07-02) and **COAI** CG ATH $43.81: neither shows up in daily data or Binance klines.
- LAB's CG daily market cap of $7.98B on 2026-05-31 comes from a circulating-supply glitch: 1B circulating that day vs 313M the days after.

## Market-wide context (not ranked)
- **2025-10-10/11 "crypto Black Friday"**: a record $19B+ in liquidations after the 100% China tariff threat. Many altcoins wicked down more than 75% and recovered within hours. USDe printed about $0.65 on Binance only, a local oracle and liquidity failure (CoinDesk, Pharos). These intraday wicks are not counted as crashes. MNT (#6) peaked the day before.
- **Exploits** in the window (Bybit hack, Cetus, Balancer, Stream xUSD and others) caused large losses of assets, but none erased token market cap on the scale of the top 10.
- **Bear-market drawdowns** of 2021-era large caps (DOGE, ADA, AVAX, SHIB, DOT; for reference SOL is -63% and ETH -49% from ATH) would beat every entry above in dollar terms. They are excluded by the "ATH set inside the window" rule.

## Sources
- CoinGecko free API: `/coins/markets` (pulled 2026-10-11), and `/coins/{id}/market_chart?days=365` for pi-network, official-trump, pepe, lab, mantra, mantle, ravedao, world-liberty-financial, memecore, chainopera-ai, bonk, story-2 and others. Saved in `research/top10_raw/cg/`.
- Binance public klines (data.binance.vision): TRUMPUSDT, PEPEUSDT, OMUSDT, WLFIUSDT spot; LAB, RAVE, M, COAI, IP, MELANIA USD-M. Saved in `research/top10_raw/bn/`.
- PI: CoinDesk 2025-02-20 (6.3B circ. at launch); CryptoSlate 2025-02-27 (>$18B self-reported); BraveNewCoin and Bitget News (~$16B); CoinMarketCap (ATH $2.98, 2025-02-26).
- TRUMP: Reuters 2025-02-03 (peak >$14.5B, 200M initial supply); Crypto Briefing 2025-01-19 ($72→<$39, $6B wiped).
- LAB: Crypto Times 2026-07-08 and 07-14; Cryptopolitan 2026-07-08; BeInCrypto (ZachXBT findings; the June -77% drop wiped ~$6B).
- OM: CoinDesk 2025-04-14; Decrypt; Cointelegraph; Forbes ($5.4B crash); CoinMarketCap and news (~$8.2B at the $9.04 ATH); Binance announcement (OM→MANTRA 1:4, March 2026).
- MNT: Bitget News and BeInCrypto (ATH ~$2.85-2.86, 2025-10-09, mcap ~$8.9-9.1B).
- RAVE: CoinDesk 2026-04-18 and 04-19; Decrypt ($6.6B shed); The Block 2026-04-18; CryptoPotato.
- WLFI: The Block 2025-09-01; CoinMarketCap Academy (24.67B circulating at launch).
- MemeCore: CoinDesk 2026-06-25; crypto.news; TechTimes; DEXTools.
- COAI: Inside Crypto; CG/Binance daily data. BONK: Unchained and TronWeekly (~$4.4B, 2024-11-20). IP: Phemex blog (~$4.26B).
- LIBRA: Cointelegraph; The Block 2025-02-15; Decrypt; Reuters 2025-02-20. MELANIA: Forbes 2025-01-20 (> $2B), Cointelegraph/TradingView.
- Oct 10, 2025: CoinDesk "Market Spotlight: $19B liquidation"; CoinDesk 2025-10-11 (USDe).
