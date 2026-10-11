# StonkFun: identification and competitor landscape

Research date: Sun Oct 11, 2026 (~05:15 PT). Web research only, no signups.
Data conventions:
- "DefiLlama" numbers were pulled from the public API (api.llama.fi/overview/fees, with and without dataType=dailyRevenue) on Oct 11, 2026 ~05:20 PT. "24h" is DefiLlama's last complete UTC day (Oct 10, 2026). "30d" is the trailing 30 days. "All" is all-time. All values in USD.
- DefiLlama counts different things for different protocols. For example, Pons "fees" include money passed through to creators, and LaunchLab's numbers include StonkFun's launches. Use these figures to compare scale, not as exact numbers.
- "Unknown" means I found no reliable number. No numbers were made up.

---

## 1. What StonkFun is

| Field | Finding |
|---|---|
| Name / domain | **StonkFun**, **stonkfun.xyz** (sometimes written "Stonk.fun"). It is **not** stonks.fun (see "Name collisions" below). |
| X / Telegram | **@LaunchOnSF** (display name "Stonk", bio "Launch coins paired with anything · Powered by $STONK", 59,451 followers on Oct 11, 2026 via X API). Telegram t.me/StonkFunXyz. The account was briefly suspended on Sep 27, 2026 and restored the same night (trenchbook). |
| Chain | **Solana** mainnet |
| What it does | A memecoin launchpad where the creator **picks the quote asset**, so coins don't have to pair with SOL. Options include tokenized stocks/ETFs (xStocks such as SPYx, NVDAx, TSLAx; Backpack "Sunrise" stocks), pre-IPO tokens (PreStocks OPENAI, ANTHROPIC), currencies, gold, crypto (ZEC, WBTC, HYPE, PEPE), SOL, or another StonkFun coin. Its public API listed 535 launchable pairs (StalkChain snapshot) and Blockworks counted 465 on Sep 14. |
| Mechanics | Fixed supply. **Before Sep 6, 2026:** each launch opened a one-sided Raydium CLMM pool directly. **Since Sep 6, 2026:** launches use a **Raydium LaunchLab** bonding curve and graduate to Raydium CPMM pools (counted as "graduated" at a $40k mcap per the live config). "Reward mode" coins are Token-2022 coins with a permanent 1% or 3% transfer tax paid to holders in the quote asset. StonkFun keeps the LP of graduated pools, so it keeps earning about 50 bps after graduation (Blockworks). It has a public developer API. |
| Token | **$STONK**, mint 6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx, paired with **SPYx**. The first pool opened Jul 23, 2026. About 60% of revenue goes to STONK buyback-and-burn (its own docs). Buybacks are discretionary. |
| Team | Anonymous. Its terms say it is not registered with the CFTC or any other regulator (StonkBuilder summary). |
| Audit | None shown in its docs (solanaguides). |

### StonkFun traction (with sources)

| Metric | Value | Source / date |
|---|---|---|
| Tokens with a live pool | 175,397 | StonkFun public API /api/public/v1/stats, generatedAt 2026-10-11 05:14 PT |
| "Graduated" (mcap > $40k) | 4,612 (≈2.6%) | same |
| Reward-mode launches | 133,372 | same |
| 24h volume, all tokens | $18.2M | same |
| Total mcap, all tokens | $813M | same |
| Lifetime revenue | $34.1M; $20.4M spent on STONK buybacks; $23.0M burned (value at burn) | same (/revenue) |
| DefiLlama fees = revenue | 24h $163K · 7d $2.36M · 30d $25.4M · all $32.8M | DefiLlama, Oct 11, 2026 |
| Daily fee trend | $428K (Oct 6) → $285K → $284K → $193K → $163K (Oct 10) | DefiLlama summary/fees/stonkfun |
| Peak | ~$2.3M/day fees on Sep 11. Topped Pump.fun on Sep 6, 11 and 21 (Sep 6 includes a one-off harvest) | solanaguides.com (Oct 9, 2026) citing DefiLlama |
| Early revenue | $12.4M since launch, $8.2M of it from Sep 7–12, "level with Pump.fun" over those days | Blockworks 0xResearch, Sep 14, 2026 |
| Unique traders | ~7.2K (Aug 3) → 47K (Aug 8) → ~222K cumulative (Sep 25) | Birdeye, via KuCoin insight |
| STONK market cap | ~$140M on Sep 6 (The Block). StalkChain snapshot: $187M, 43% below a $330.8M peak | The Block, Sep 6, 2026; StalkChain (undated snapshot) |

What sets it apart: it pairs against almost any asset (500+), runs on Raydium (no DEX of its own), earns fees after graduation by keeping the LP, pays holder rewards in the quote asset, and uses revenue to buy back STONK.

### Name collisions (don't confuse these)
- **stonks.fun**: a different product. It offers fully backed **index baskets of tokenized stocks on Robinhood Chain** (MAG7, DEGEN, SILICON; Chainlink feeds). It is not a memecoin launchpad and isn't really a competitor, though it is adjacent (stock tokens).
- **sTONks** (DefiLlama slug "stonks"): a small multichain launchpad starting from TON, about $5K 30d revenue. Unrelated.
- **BaseStonk** (Base/Robinhood Chain launchpad, $86K 30d revenue) and **StonkBrokers** (a suite of Robinhood Chain products): unrelated to StonkFun.

---

## 2. Ranked top competitors (by how directly they compete × traction)

| # | Competitor | Chain | One-line difference vs StonkFun | Key traction (DefiLlama, Oct 11, 2026 unless noted) |
|---|---|---|---|---|
| 1 | **Pump.fun** | Solana | The incumbent. Copied StonkFun's core features within a week: **Custom Pairs** (93 xStocks/Sunrise/WBTC/WETH/metals, Sep 9) and **Holder Rewards** (Sep 12). It has far more distribution but far fewer pairs, and graduates to its own PumpSwap. | Rev 24h $1.39M · 30d $41.0M · all $1.16B (fees 30d $57.9M). PumpSwap rev 30d $15.5M. It won back about 58–67% of custom-pair bonding-curve volume after Holder Rewards (Blockworks, Sep 14) |
| 2 | **Pons (ponsfamily.com)** | Robinhood Chain | The stock-paired leader on another chain. V2 adds approved quotes including **NVDA, AAPL, HOOD**, USDG, cbBTC. ETH bonding curve, then locked Uniswap v4. Launching is whitelist-only per its V2 docs, and it is unaudited. Not affiliated with Robinhood. | Pons V2: fees 30d $67.6M, rev 30d $10.4M (all-time fees $164M). About $5.95M fees, ~25K tokens and $544M volume on Sep 2. ~646K tokens from 167K creators since July (CoinDesk, Sep 3, 2026) |
| 3 | **Flap.sh** | BSC, Robinhood Chain, X Layer, Monad (+Base per docs) | Takes the stock angle from the other side: tax tokens pay **holder dividends in tokenized stocks** through Stocks Vaults and basket tokens, and BSC supports stock-token quotes. Not on Solana. | Fees 30d $35.3M, rev 30d $8.41M, all-time rev $36.7M |
| 4 | **Raydium LaunchLab** | Solana | **The infrastructure StonkFun runs on**, so it is both partner and rival. It is open to any quote asset, so anyone (BONK.fun, other pads, or direct launches on raydium.io) can copy StonkFun's model on the same rails. 1% curve fee, launcher-set graduation threshold of at least 24 SOL. | Fees 30d $11.1M, rev 30d $2.15M (includes StonkFun launches; DefiLlama methodology changed around Sep 9 per solanaguides) |
| 5 | **BONK.fun / LetsBonk** | Solana | A community launchpad on LaunchLab, built with Graphite Protocol. It pairs with SOL/USD1 and gives the BONK ecosystem's 51% revenue share to buying BONK for Bonk Inc (no burn since Dec 2025). No stock-pair focus. | DefiLlama rev 30d $5.25M (fees $8.83M), **but** its own dashboard shows only ~$1.06K/day in October (solanaguides, Oct 6), so the numbers conflict. Graphite Protocol is listed separately at $3.56M rev 30d. It had ~54% share in Jul 2025 and has been "commercially dead" since (memecentral, Aug 31) |
| 6 | **four.meme** | BNB Chain | The BSC incumbent, now with a **"Stock Meme"** feature: 76 new bStock quote assets and a unified $10K raise target (Oct 8, 2026), plus 4Stock assets. It is the closest equivalent of StonkFun on BSC, graduating to PancakeSwap. | Rev 30d $239K · all-time $96.9M. DEX volume ~$32.8M (30d) / $9.96B cumulative (DefiLlama via search; volume page not independently re-pulled) |
| 7 | **Bankr / Long (long.xyz)** | Base & Robinhood Chain | The stock-paired cohort on EVM. Long introduced stock-paired launches on Robinhood Chain on Jul 14 (its AI/NVDA pair was the chain's top volume source), and Bankr followed Jul 20 with 90+ stock/ETF pairs. | Bankr (DefiLlama "Interface"): fees 30d $3.11M, rev 30d $1.73M. Bankr did $5.6M 24h volume on Jul 27 (memecentral). Long: **unknown** |
| 8 | **x7 (x7pad.com)** | Solana | **The closest feature clone.** Every coin pairs with a tokenized stock (or any tradable mint). Its basket mode pairs with up to 6 stocks at once. Runs on Meteora DBC curves. Charges about 0.03 SOL with no platform launch fee, and creators pick a 1/2/5% fee split 70/20/10 between creator or holders, $X7 burn, and treasury. Its curves are built so tokens rarely graduate. | Tiny: **160 coins total** per its public API (Oct 11, 2026). The $X7 token (SOL-paired) is ~$200K mcap. Not on DefiLlama |

### Next tier / niche
- **Meteora Dynamic Bonding Curve (DBC)** (Solana): white-label curve infrastructure behind Believe, Jupiter Studio, Bags, x7 and Hooked. Fees 30d $2.99M, rev 30d $537K, all-time fees $98.6M. It competes the way LaunchLab does, as rails that let rivals launch stock-paired pads.
- **Bags** (Solana + Robinhood Chain): creator-royalty launchpad (1% of trades to creators, splittable across up to 100 recipients). It was the #2 Solana pad in Jan 2026 (~$647K/day fees) but fell to ~$2.3K/day by Oct 4 (solanaguides). DefiLlama rev 30d $167K, all-time $32.2M.
- **Jupiter Studio** (Solana): Jupiter's launchpad on Meteora DBC, aimed at builders and API launches. Rev 30d $26.9K, all-time $5.39M. Niche.
- **Moonshot Create** (Solana, DEX Screener's Moonshot): rev 30d $69.8K, all-time $4.35M. The Moonshot trading app is separate: rev 30d $172K.
- **Pools.trade** (Robinhood Chain, Uniswap Labs): zero launch fee, 0.25% fee that autocompounds into locked v4 liquidity, Crowd Launch TWAP auctions. DefiLlama fees 30d $619K, rev $0. ~50% of Robinhood Chain launchpad volume shortly after its Aug 5 launch (memecentral, Aug 31).
- **hood.fun** (Robinhood Chain): standard curve that migrates to locked Uniswap v3. Deployed 6,471 tokens on Jul 17. Described as "nearly dead" (madeonsol). Current numbers **unknown**.
- **Clanker** (Base + Arbitrum, Unichain, Ethereum, Monad, Robinhood Chain): AI-agent and Farcaster deployments straight into Uniswap v4, with no curve. Fees 30d $1.23M, rev 30d $205K, all-time rev $15.4M. About 1.5M tokens deployed on Base (clanker.world stats). No stock-pair focus.
- **Seven (seven.fun)** (Solana): a **presale** launchpad, not a bonding curve. Raises are funded in SOL or **X Money**, with goals of 50–200 SOL or $5K–$50K. 77.7% of supply goes to the presale and 22.3% to locked Meteora DAMM v2 LP, and Seven takes 10% of the raise. Creation is limited to approved beta creators until the $7 token launches. Traction **unknown**. It competes for launches, not for stock pairs.
- **Hooked (hookedpad.com / hookedpad.fun)** (Solana): launches Token-2022 coins with **transfer hooks** (48 rule types such as wallet caps, anti-snipe, market-hours trading, venue locks) on Meteora curves. 1% curve fee, 85% of which goes to $HOOKED buyback-and-burn. Hooks are upgradeable by Hooked's deploy key (trenchbook). Traction **unknown**. Its pitch is token rules, not stock pairs.

### Dead or dormant (don't rank)
- **Believe** (Solana): rev 30d ~$520, all-time $32.7M. It paused on-chain payouts and moved creators to PayPal (The Defiant), faces a class action (SDNY, Mar 2026), and its founder has been arrested (SolanaFloor). Its operating status is not confirmed.
- **Heaven** (Solana, no-curve "God Flywheel" into LIGHT): $0 fees since Jun 2026. All-time $4.63M.
- **Boop.fun** (Solana): $0 since Feb 2026. All-time $4.48M. The founder stepped back in Nov 2025.
- **Zora Coins** (Base): rev 30d $3.6K. Brian Armstrong (Jul 13, 2026): "It didn't work... time to move on."
- **Flaunch** (Base): rev 30d $0, fees 30d $6.6K.
- **Noxa.fun** (Robinhood Chain): halted Jul 11, 2026.

---

## 3. Trading bots and terminals (not launchpads)

| Tool | Status | Launch features? | DefiLlama (Oct 11, 2026) |
|---|---|---|---|
| **Axiom** (Solana, BSC, Robinhood Chain) | Active, volume leader | **No native token creation found**. It trades and snipes tokens from launchpads, StonkFun included. Guides on "launching on Axiom" use an outside token creator and then trade on Axiom. | Rev 30d $17.9M (fees $37.9M), all-time rev $465M |
| **Photon** (Solana) | Active | No native launch feature found. Trading terminal only. | Rev 30d $363K, all-time $442M |
| **Trojan** (Solana, Telegram) | Active | No native launch feature found. | Rev 30d $845K, all-time $170M |
| **BONKbot** (Solana, Telegram) | Active, small | No native launch feature found. | Rev 30d $65K, all-time $62.2M |
| **BullX** | **Trading disabled Jun 1, 2026** | n/a | Rev 30d $772, all-time $203M |
| (GMGN, multichain) | Active | Terminal, not a launchpad | Rev 30d $23.9M |

Note: "No native launch feature found" means my web search turned up nothing. I did not log in to confirm. These terminals are **distribution channels** for StonkFun coins, not competitors.

---

## 4. Takeaways
1. **Pump.fun is the real threat.** It shipped stock pairs and holder rewards within a week, won back most custom-pair curve volume, and still earns about 8.5× StonkFun's daily revenue (Oct 10: $1.39M vs $163K). StonkFun's advantages are pair breadth (500+ vs 93) and fees after graduation from the LP it keeps.
2. **Stock-paired memecoins are a cross-chain trend:** Pons, Long and Bankr on Robinhood Chain; Flap and four.meme on BSC. Pons V2 has higher gross fees (30d $67.6M) but lower retained revenue (30d $10.4M) than StonkFun ($25.4M). The two are counted differently, since Pons fees include creator pass-through.
3. **The infrastructure is open.** LaunchLab and Meteora DBC both accept any quote asset, so clones like x7 are cheap to build. So far none has meaningful traction.
4. **StonkFun is cooling:** daily fees fell from about $2.3M (Sep 11 peak) to $163K (Oct 10).

## Sources
- StonkFun site and dev API: https://www.stonkfun.xyz/ , https://www.stonkfun.xyz/developers , https://www.stonkfun.xyz/api/public/v1/stats and /revenue (live, Oct 11, 2026)
- Bitquery StonkFun docs: https://docs.bitquery.io/docs/blockchain/Solana/stonkfun-api/
- StalkChain StonkFun: https://stalkchain.com/data/stonkfun
- The Block, Sep 6, 2026: https://www.theblock.co/news/defi/2026-09-06-stonk-surges-250-to-140-million-market-cap-as-stock-paired-solana-launchpad-stonkfun-pulls-volume-to-raydium-and-jupiter-413621
- Blockworks 0xResearch "Pump Strikes Back", Sep 14, 2026: https://blockworks.com/newsletter/0xresearch/issue/post_7f9ac9ee-2ac4-416a-a67a-a3a7fa5267ba
- KuCoin/Birdeye trader counts: https://www.kucoin.com/news/insight/SOL/6aba1f3474fd460007c5cf90
- trenchbook STONK: https://trenchbook.app/coin/solana/STONK
- Gate Learn STONK: https://www.gate.com/learn/articles/what-is-stonk-stonkfun-solana-token
- X API: @LaunchOnSF profile (Oct 11, 2026)
- DefiLlama API: https://api.llama.fi/overview/fees (Oct 11, 2026); protocol pages at https://defillama.com/protocol/<slug> (pump.fun, stonkfun, pons-v2, flap-sh, launchlab, bonk.fun-launchpad, four.meme, bankr, meteora-dynamic-bonding-curve, bags, jupiter-studio, moonshot-create, pools, clanker, zora-coins, flaunch, launch-coin-on-believe, heaven, boop.fun, axiom, photon, trojan, bonkbot, bullx)
- solanaguides.com, Oct 9, 2026: https://solanaguides.com/best-memecoin-launchpads-on-solana-2026-pump-fun-vs-letsbonk-vs-raydium-launchlab
- CoinDesk on Pons, Sep 3, 2026: https://www.coindesk.com/tech/2026/09/03/a-memecoin-making-app-becomes-crypto-s-top-fee-generators-as-robinhood-chain-activity-explodes
- memecentral.fun Robinhood Chain launchpads (Aug 31, 2026): https://memecentral.fun/guides/robinhood-chain-launchpads-compared
- memecentral.fun dead launchpads (Aug 31, 2026): https://memecentral.fun/guides/dead-and-dying-memecoin-launchpads
- x7 docs and API: https://x7pad.com/docs , https://x7pad.com/api/public/coins
- Seven docs: https://www.seven.fun/docs/supply-and-liquidity , /fees , /creating-a-launch , /token-unlocks
- Hooked: https://www.hookedpad.com/ ; trenchbook HOOKED: https://trenchbook.app/coin/solana/HOOKED
- four.meme Stock Meme (Oct 8, 2026): https://www.kucoin.com/news/flash/four-meme-upgrades-stock-meme-feature-with-76-new-bstock-assets-and-unified-funding-target
- Flap docs: https://docs.flap.sh/flap/developers/token-launcher-developers/robinhood-integration-guide
- Terminals: https://blog.ape.store/best-meme-coin-trading-tools/ (Jul 22, 2026)
- stonks.fun (different product): https://stonks.fun/
