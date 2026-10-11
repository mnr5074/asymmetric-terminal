# Asymmetric Terminal: Paid Data Provider Comparison

**Research date:** Sunday, Oct 11, 2026 (all prices were read from the provider's own pricing or docs page on this date unless marked otherwise)
**Scope:** Web research only. No signups and no purchases.
**Rules:** Every price is cited to a URL. "Contact sales" means no public price. Prices marked *(3rd-party)* could not be read on the official page (JS-rendered or bot-blocked) and come from an aggregator. Verify those before you buy.

---

## 0. TL;DR

- **Best single purchase: Helius Developer, $49/mo.** It covers full Solana transaction history (early buyers, entry prices, bundles at each milestone), enhanced websockets (`transactionSubscribe`), webhooks and pump.fun parsing. At 10 credits per 100 full transactions, the plan's 10M credits come to roughly 100M historical transactions a month.
- **Best second purchase: CoinGecko Analyst, $129/mo ($103.20/mo billed yearly).** It extends onchain pool and token OHLCV back to 2021 (fixing the >180-day gap for small tokens) and adds top and historical holders, top traders, pump.fun bonding-curve data, and WebSocket and webhooks across 220+ networks, including TON, Sui and Tron.
- **US options:** a funded **Tradier brokerage account ($0 platform fee)** gives real-time chains with ORATS-sourced greeks. Add **Unusual Whales API Basic, $150/mo** for flow and dark pool, or **ThetaData Options Standard, $80/mo** for tick, NBBO and streaming.
- **Real-time Solana new-pair / pump.fun stream at the lowest latency:** use **Triton PAYG** Yellowstone gRPC ($125 prepaid deposit lasting 12 months, $0.08/GB) instead of the $499 gRPC tiers at Helius and QuickNode.
- **Social:** use **X API pay-per-use** (`Counts: Recent` at $0.005/request) for mention counts. Only add LunarCrush ($90/mo) if you want precomputed sentiment.

---

## 1. Provider-by-provider notes

Format: **What it adds to this terminal** · **Cheapest useful tier** · Limits · Latency · Coverage · Overlaps

### A. Solana / multi-chain infrastructure (RPC, streams, raw history)

**Helius**: https://www.helius.dev/pricing
- Adds: full Solana tx history via `getTransactionsForAddress` (10 credits per 100 full txs, or 10 credits flat for signatures only; https://www.helius.dev/docs/rpc/gettransactionsforaddress), Parsed Events history (pump.fun mints and swaps; https://www.helius.dev/docs/parsed-events), DAS (holders, token metadata), webhooks, `transactionSubscribe` enhanced WS, staked tx sending.
- Tiers: Free $0 (1M credits, 10 RPS, archival yes, webhooks yes, LaserStream WSS standard, **no** transactionSubscribe). **Developer $49** (10M credits, 50 RPS, DAS 10/s, transactionSubscribe yes, LaserStream gRPC devnet only, extra credits $5/M). Business $499 (100M credits, 200 RPS, LaserStream gRPC mainnet). Professional $999 (200M credits, 500 RPS). Enterprise: contact sales. Dedicated nodes from $2,900/mo.
- Credit cost: 1 per RPC call. getProgramAccounts, archival calls and DAS cost 10. The pricing page says Parsed Events were "free on all paid plans until September 21st, 2026". That date has passed, so check the current Parsed Events cost.
- Latency: slot-level WS. gRPC is lower latency but needs $499+.
- Coverage: Solana only. Overlaps: Triton, QuickNode, Alchemy (Solana RPC); Birdeye and Codex (parsed trades).

**Triton One**: https://triton.one/pricing
- Adds: the lowest-cost access to **Yellowstone gRPC streaming** (new pools, pump.fun program, account updates). The page says every product is on every plan, with no tier gating.
- Pricing: **$125 minimum prepaid deposit** (non-refundable, valid 12 months). Standard RPC/ledger costs $0.08/GB + $10 per million calls. Streaming costs $0.08/GB bandwidth. Shred streaming from $900/mo.
- Latency: bare-metal, GeoDNS, regarded as top tier for Solana. Coverage: Solana, Sui, Monad.
- Overlaps: Helius (gRPC only at $499+), QuickNode (gRPC add-on $499).

**QuickNode**: https://www.quicknode.com/pricing
- Adds: one multi-chain RPC for the EVM chains (ETH/Base/BSC/Arbitrum) plus Solana and others. Streams to webhook/S3/Postgres, with reorg handling.
- Tiers: Free trial (10M credits, 15 RPS, 1 month). **Build $49** ($42 annually; 80M credits, 50 RPS, 10 Streams). Accelerate $249. Scale $499 (includes Solana gRPC). Solana gRPC is a $499/mo add-on on lower tiers.
- Overlaps: Alchemy (cheaper for low-volume EVM RPC), Helius (Solana).

**Alchemy**: https://www.alchemy.com/pricing
- Adds: EVM RPC, Token, Transfers and Prices APIs, webhooks, full archive.
- Tiers: **Free, 30M CU/mo, 15 RPS (excellent)**. Pay-as-you-go $0.525 per 1M CU, 300 RPS included. Solana gRPC "starting at $75/TB" on PAYG. Enterprise: contact sales.
- Overlaps: QuickNode and Moralis. The free tier alone likely covers EVM RPC needs.

### B. Token / DEX market data APIs

**CoinGecko API (includes GeckoTerminal onchain)**: https://www.coingecko.com/en/api/pricing
- Adds: **onchain token and pool OHLCV (1-minute and 1-second) from 2021 on Analyst+**, compared with 6 months on Demo/Basic. Also top and historical token holders, top token traders, recent trades, Megafilter, trending pools, pump.fun/Four.meme/LaunchLab bonding-curve data, and WebSocket (onchain DEX trades and price) plus webhooks.
- Tiers: Demo free (10k credits, 100/min, 60s freshness). Basic $35/mo ($29 yearly; 100k credits, 300/min, 5 sockets). **Analyst $129/mo ($103.20 yearly; 500k credits, 500/min, real-time, 10 sockets)**. Lite $499 ($399.20). Pro $999 ($799.20). Overage $0.0005/call.
- Freshness: "Real-time" on Analyst+. The FAQ says `simple/price` is cached at about 30s on paid plans.
- Coverage: 220+ networks, 48M+ tokens (includes TON, Sui, Tron, Solana and the EVM chains). Requires the "Data provided by CoinGecko" attribution.
- Overlaps: Birdeye, Codex, Mobula, CMC, DexTools, GeckoTerminal (the free source already in the stack).

**Birdeye Data (BDS)**: https://bds.birdeye.so/pricing
- Adds: Solana-first token and pair tick trades, OHLCV, wallet PnL/portfolio, trader profiles, top holders and traders, new listings, and a WS new-pair stream (`SUBSCRIBE_NEW_PAIR`, includes pump.fun; https://docs.birdeye.so/docs/subscribe_new_pair).
- Tiers: Standard free. **Lite $39** (2.5M CUs, 15 rps, no WS). Starter $99 (8M CUs, 15 rps, WS is a toggle). Premium $199 (20M CUs, 50 rps, WebSocket with 500 concurrent connections). Business $499 (60M CUs, 100 rps, 2,000 WS). Overage $15 → $6.9 per 1M CUs.
- Overlaps: heavily with CoinGecko Analyst and Codex. Helius covers the raw trade history.

**Codex.io**: https://www.codex.io/pricing
- Adds: the most complete "one API" option: 80+ networks, 90M+ tokens, sub-second freshness, launchpad coverage (pump.fun etc.), token filters, holders, wallets, prediction markets, WebSockets and webhooks. Used by TradingView.
- Tiers: "Almost free" $0 (10k requests/mo, 5 rps; $1 one-time signup fee, no WS). **Growth from $350/mo** (1M requests, $350 per extra 1M, 300 rps, 300 WS connections). Enterprise: contact sales.
- Overlaps: Birdeye, CoinGecko, Mobula, Bitquery. Excellent, but expensive per request.

**Mobula**: https://docs.mobula.io/pricing (the mobula.io/pricing page returned 404)
- Tiers: Free (10k credits, 1 RPS). Start-up $50 (125k credits, 30 RPS, **no WSS**). Growth $400 (1.25M credits, WSS feeds, including the pump.fun "Pulse" stream). Enterprise from $750. WS costs 1 credit per minute open plus underlying usage.
- Overlaps: Codex and Birdeye.

**DexTools API**: https://www.dextools.io/app/en/api (Cloudflare blocked the fetch)
- *(3rd-party: https://cryptomarkets.tools/tools/dextools)* Standard $99 (1M calls), Advanced $249, Pro $799.
- Adds little beyond DexScreener and GeckoTerminal, which are already free.

**CoinMarketCap API**: https://coinmarketcap.com/api/pricing/
- Tiers: Basic free (15k credits). Builder $29/mo (150k credits). Startup $79 (450k credits, WebSocket, DEX holders). Growth $299. Professional $699.
- Adds DEX holder count and trend, and a liquidity-change history. Overlaps with CoinGecko almost entirely.

**Moralis**: https://moralis.com/pricing
- Tiers (billed annually): Starter $149/mo (2M CU, 40 RPS). Pro $249 (100M CU). Business $749.
- Adds EVM wallet history, token holders, swaps by token, and Streams. Note: Moralis' **pump.fun endpoints are deprecated and scheduled for removal on July 31, 2026** (https://docs.moralis.com/changelog/pump-fun-api).
- Overlaps: GoldRush, Alchemy, Bitquery.

**Covalent / GoldRush**: https://goldrush.dev/pricing/
- Tiers: Free trial ($0, 25k credits, 14 days, 4 RPS). Vibe Coding $10/mo (10k credits, personal/non-commercial). **Professional $250/mo** (300k credits, 50 RPS, flex credits $0.00077 each). Inner Circle: contact sales.
- Adds: decoded historical balances and transactions across 100+ chains, including **historical token holders at a block height on EVM**. That suits "holders at milestone X" on EVM chains.

**Bitquery**: https://bitquery.io/pricing
- Adds: real-time GraphQL plus **WebSocket streams of DEX trades, transfers and mempool** on 10 core chains: **Solana, Ethereum, Base, BSC, Arbitrum, Optimism, Polygon, Tron, Robinhood Chain**, Arc. It is one of the few providers that covers Robinhood Chain and Tron. Also Polymarket and Hyperliquid data.
- Tiers: Personal $49/mo ($29 yearly; 100k points, 30 req/min, **no streams, non-commercial**). **Pro $99/mo ($69 yearly; 1M points, 100 concurrent streams, 100k stream-minutes, 5 GB)**. Scale $299/mo ($199 yearly). Enterprise: contact sales. 7-day free trial includes live streaming.
- Limits: the self-serve window is only 30 days for trades and 8 hours (Solana) to 4 days (EVM) for raw on-chain data. Archive packs are extra. Monthly / yearly prices: Solana trading $300 / $210; Solana transfers $500 / $350; each EVM chain $150 / $105; EVM bundle $600 / $420; 9-chain holders pack $250 / $175 (no Solana); labels $99 / $69.
- One stream running all month uses 44,640 stream-minutes, so Pro's 100k covers about 2 always-on streams.
- Overlaps: Helius (Solana), Codex/Birdeye (trades), Dune (history).

### C. Analytics / SQL warehouses

**Dune (API)**: pricing page is JS-rendered. Prices are from https://docs.dune.com/resources/credits-billing/how-credits-work
- Tiers: Free is view-only (no API). **Analyst $75/mo ($65 yearly), 4,000 credits**, overage $1.875 per 100. Plus $399/mo ($349 yearly), 25,000 credits. 14-day trial includes 2,500 credits.
- Adds: SQL over decoded Solana and EVM tables. It is the cheapest way to compute **HODL waves / holding-period cohorts, first-buyer lists and exchange-labelled flows** as scheduled batch jobs.
- Latency: minutes (raw) to hourly (curated). Not suitable for real-time.

**Flipside**: no current public API pricing (https://docs.flipsidecrypto.com/api). **Contact sales.**
**Allium**: plans are contact sales. Machine-payment PAYG costs $0.01 per raw-SQL call and $0.02 per price call (https://docs.allium.so/ai/machine-payments/endpoints-pricing).

### D. Wallet labels / smart money / exchange flows

**Nansen**: https://docs.nansen.ai/getting-started/credits and https://academy.nansen.ai/help/articles/1287744-plans-and-pricing
- Tiers: Free (100 one-time credits plus a daily top-up to 10; 15 rps). **Pro $69/mo or $49/mo yearly**: tops credits back up to 2,000 each month and raises the limit to 75 rps. Extra API credits cost **$10 per 10,000** on any plan. Nansen says it has no Enterprise plan.
- Adds: smart-money labels (500M+ labelled wallets), token flows by label, profiler and PnL. Freshness is seconds to minutes.
- Coverage: multi-chain, including Solana and the EVM chains.

**Arkham Intelligence**: https://arkm.com/llms/guides/getting-access.md and https://arkm.com/llms/guides/credit-pricing.md
- Pricing: API plans are custom and usage-based, **starting at $100/mo** (official). x402 pay-per-request costs $0.20 per credit. Trial gives 100k credits (individual) or 1M (organisation). An aggregator lists "from $900/mo", which contradicts the official docs.
- Adds: entity labels (exchanges, funds, whales), entity balance changes, transfers and swaps with entity tags.

**CryptoQuant**: https://cryptoquant.com/apis and https://docs.cryptoquant.com/guides/plans-and-limits
- Tiers: Basic free (10k credits, 10/min, 30 days, market data only). Advanced (300k credits, market data only). **Professional (500k credits, 120/min, 1 year, on-chain daily)**. Premium (unlimited, full history, block-level, commercial licence; annual, contact sales).
- Prices are not rendered on https://cryptoquant.com/pricing. *(3rd-party: Advanced $29, Professional $99; https://pricetrack.dev/products/cryptoquant)*
- Adds: **exchange inflow/outflow/reserve** for BTC, ETH, ERC-20s, stablecoins, XRP and Tron. No Solana memecoins.

**Glassnode**: https://studio.glassnode.com/pricing
- Tiers: Advanced $49/mo (daily data; "API Light" has only 14 days of history and 50 calls a day). Professional with API is a configurable add-on: **contact sales**.
- Adds: HODL waves, cost basis and exchange flows for about 11 chains and major assets only. Personal licence on Advanced.

**Santiment**: https://app.santiment.net/pricing
- Tiers: Free (30-day lag). Sanbase Pro $49/mo. **Sanbase Max $249/mo**, the minimum tier for real-time API without lag.
- Adds: social volume, dev activity, on-chain data for the top ~3000 assets. Its chain list has no Solana.

### E. Fundamentals / unlocks

**Tokenomist (formerly Token Unlocks)**: https://tokenomist.ai/pricing
- Tiers: Free. **Pro / API $69/mo (1,000 API calls/mo, supply data covering 1 year back to 1 year forward)**. Standard API $249.95/mo (50k calls, ±2 years). Elite $449.95/mo (±3 years). The page also shows struck-through list prices ($99, $749.95, $999.95).
- Adds: unlock schedules, daily emission, allocations, fundraising. Calling once per day per tracked token and caching the result fits within 1k calls.

**Token Terminal**: https://tokenterminal.com/pricing. Pro is **$350/mo** (the figure is in the page HTML). The API tier (250k requests/day) is book-a-demo, so **contact sales**. Adds protocol fundamentals (revenue, fees), which is not core to this terminal.

**Messari**: https://messari.io/pricing. Enterprise prices are not rendered. Token Unlocks, News and Signals APIs are a "Custom API Package": **contact sales**. *(3rd-party: Enterprise Individual $5,000/yr; https://comparedge.com/tools/messari/pricing)*

### F. Social / news

**X API**: https://docs.x.com/x-api/getting-started/pricing (fetched via curl)
- Pay-per-use with no subscription: Post read $0.005 per post, User read $0.010, **Counts: Recent $0.005 per request**, Counts: All $0.010, Trends $0.010. Capped at 3M post reads per month. $20 free credit when you save a card. Enterprise: contact sales.
- Adds: raw mention counts and velocity per ticker or contract address, KOL post monitoring.

**LunarCrush**: https://lunarcrush.com/pricing
- Tiers: Light $90/mo ($72 yearly; 10 req/min, 2,000/day). Medium $300 ($240). Heavy $900 ($720).
- Adds: aggregated social volume, sentiment, Galaxy Score and AltRank across X, Reddit, YouTube, TikTok and news. Daily history back to 2020. Covers crypto and stocks.

**Tree News (TreeOfAlpha)**: https://www.treeofalpha.com/ and https://docs.treeofalpha.com/websockets
- Free: main WS (`wss://news.treeofalpha.com/ws`) with delays and fewer sources. **Sprout $500/mo** (no delay, advanced sources, Tokyo WS for exchange-listing news). Sapling $2,500/mo (adds Tree Terminal). Paid via TREE-token credits.
- Latency: among the fastest crypto news feeds (1,150+ sources, 2,300+ X accounts).

**Benzinga news**: the direct API is **contact sales**. A free Basic News API (headlines and teasers) is on AWS Marketplace (https://aws.amazon.com/marketplace/pp/prodview-xwgvhwowjmw3g). Massive resells Benzinga **real-time news and analyst ratings at $99/mo per dataset** (https://massive.com/pricing).

### G. US stock options

**Tradier**: https://tradier.com/individuals/pricing and https://docs.tradier.com/docs/market-data
- Real-time US stock and options data is free with any Tradier **Brokerage** account. The Lite plan is $0/mo and the account minimum is $0, but per the docs, accounts left unfunded for 60+ days get a limited online experience. Sandbox data is 15-minute delayed.
- Option chains with `greeks=true` include **greeks and IV "courtesy of ORATS"** (https://docs.tradier.com/reference/brokerage-api-markets-get-options-chains). The docs don't state the greek refresh rate (historically reported as about hourly; verify). HTTP streaming is also available.
- This is the cheapest real-time options chain available.

**ThetaData**: https://www.thetadata.net/pricing
- Options tiers: Value $40/mo (real-time, 1-minute, 6 years, 2 concurrent requests). **Standard $80/mo** (tick level, chain snapshots, 15k trade streams, every OPRA NBBO quote, 10 years). Pro $160/mo (stream every trade, 14 years). Individual use only.
- The docs table (https://docs.thetadata.us/Articles/Getting-Started/Subscriptions.html) shows conflicting delay and history values for Value, so check before you buy it.
- Runs through a local Theta Terminal process. Very good value for raw options data.

**Massive (formerly Polygon.io)**: https://massive.com/pricing?product=options
- Options tiers: Basic $0 (5 calls/min, end of day). Starter $29 (15-minute delayed, unlimited calls, 2 years, snapshot, WS). Developer $79 (4 years, trades, still delayed). **Advanced $199 (real-time, quotes, 5+ years)**. Individual use; Advanced is for non-professionals.
- Greeks/IV and snapshots are listed in the feature set, but the page's per-tier checkmarks were not machine-readable. Partner datasets: Benzinga $99/mo.
- Clean REST and WebSocket.

**ORATS**: https://orats.com/data-api
- Tiers: Delayed $199/mo (20k requests). Live $299 (100k requests). Live Intraday $599. All-In $899.
- Adds best-in-class smoothed IV surfaces, forecasts and earnings effects. Overkill unless you're building vol analytics.

**Unusual Whales API**: https://unusualwhales.com/pricing?product=api
- Tiers: **API Basic $150/mo** (7-day free trial). API Advanced $375/mo. Commercial plans (Startup, Kafka, Enterprise) from $625/mo billed annually.
- Includes real-time options flow with 100% market coverage (enriched with bid, ask, greeks, OI), flow alerts, dark pool, GEX, net premium, congress and insider trades, 2-year lookback, unlimited requests, MCP.
- The Basic list mentions WebSocket streaming, but the page also says "WebSockets included on API Advanced". Confirm which tier you need for WS.
- Individual-use licence.

**Databento**: https://databento.com/pricing and https://databento.com/blog/introducing-new-opra-pricing-plans
- OPRA Standard **$199/mo** (live options; per the blog and search synthesis; the pricing page showed CME by default). Plus $1,750/mo. Unlimited $4,500/mo.
- Raw institutional feed, so you calculate greeks yourself. Overkill for this terminal.

**Intrinio**: https://intrinio.com/pricing
- Individual $150/mo (OptionsEdge and EquitiesEdge real-time, EOD history, personal use, no display or redistribution). Startup $333 → $999/mo. Enterprise $1,250+.

---

## 2. Ranked TOP 10 (best value for this terminal)

| # | Provider & tier | $/mo | What it unlocks for Asymmetric Terminal | Why it ranks here |
|---|---|---|---|---|
| 1 | **Helius Developer** ([pricing](https://www.helius.dev/pricing)) | **$49** | Full Solana tx history for any mint (first buyers, entry prices, bundles in the same slot, holders at each milestone), `transactionSubscribe` live stream, webhooks, pump.fun parsing, DAS holders, staked sends | Solana is your core chain, and this plugs your biggest gap. 10M credits ≈ 100M historical txs via `getTransactionsForAddress`. Nothing else is close per dollar. |
| 2 | **CoinGecko Analyst** ([pricing](https://www.coingecko.com/en/api/pricing)) | **$129** ($103.20 yearly) | Onchain token and pool OHLCV from 2021 (fixes >180-day history for small tokens), top and historical holders, top traders, bonding-curve data, Megafilter, WS and webhooks on 220+ chains incl. TON, Sui, Tron | One subscription covers every chain in your list, and it's the same backend as GeckoTerminal, which you already use. |
| 3 | **Tradier Brokerage** ([pricing](https://tradier.com/individuals/pricing), [docs](https://docs.tradier.com/docs/market-data)) | **$0** (funded brokerage account) | Real-time (not delayed) US options chains with ORATS greeks and IV, plus quotes and streaming | It replaces CBOE delayed data at no cost. The only catch is opening a brokerage account. |
| 4 | **Triton PAYG** ([pricing](https://triton.one/pricing)) | **$125 deposit** lasting up to 12 months; usage $0.08/GB | Yellowstone gRPC: the fastest pump.fun and new-pool stream, plus fallback RPC | You get gRPC latency without paying $499/mo at Helius or QuickNode. For a filtered stream of a few programs, bandwidth costs should be small. |
| 5 | **Unusual Whales API Basic** ([pricing](https://unusualwhales.com/pricing?product=api)) | **$150** | Real-time unusual options flow, sweeps, flow alerts, dark pool, GEX, net premium, congress trades | This is the "unusual flow" feature, ready to use. Building it yourself from OPRA ticks would take far more work. |
| 6 | **Nansen Pro + credits** ([credits](https://docs.nansen.ai/getting-started/credits)) | **$69** ($49 yearly) + $10 per 10k credits | Smart-money and wallet labels, labelled token flows, CEX flows per token | Cheapest serious labelling. API credits cost the same on Free, so you can start on Free and pay only for credits. |
| 7 | **Bitquery Pro** ([pricing](https://bitquery.io/pricing)) | **$99** ($69 yearly) | WebSocket DEX-trade and transfer streams on ETH, Base, BSC, Arbitrum, Tron, **Robinhood Chain** and Solana, plus mempool | One subscription streams DEX trades across all your EVM chains. History is only 30 days, so it is for live data only. |
| 8 | **Tokenomist Pro/API** ([pricing](https://tokenomist.ai/pricing)) | **$69** | Token unlock schedules, emissions, allocations | The only affordable dedicated unlock API. Messari and Token Terminal are $350+ or contact sales. |
| 9 | **X API pay-per-use** ([pricing](https://docs.x.com/x-api/getting-started/pricing)) | **~$10–50 usage** | Mention counts per ticker or CA (`Counts: Recent` $0.005/request), KOL post reads | Raw social data far cheaper than LunarCrush or Santiment. A count every 15 minutes for 100 tokens ≈ $48/mo; poll less often to cut that. |
| 10 | **ThetaData Options Standard** ([pricing](https://www.thetadata.net/pricing)) | **$80** | Tick-level OPRA trades and NBBO, chain snapshots, 15k trade streams, 10 years of history | Best raw options data per dollar. Use it if you outgrow Tradier or want your own flow detection and backtests. |

**Honourable mentions:**
- **Dune Analyst** ($75): batch HODL-wave and cohort SQL across chains.
- **Birdeye Lite** ($39): Solana trader PnL and top traders. Overlaps #2.
- **CryptoQuant Professional** (*3rd-party $99*): BTC, ETH, ERC-20 and stablecoin exchange flows.
- **Massive Options Advanced** ($199): polished REST/WS if you'd rather not run ThetaData's local terminal.
- **Codex Growth** ($350+): the best all-in-one if budget allows.

---

## 3. "Skip this → use that instead"

| Skip | Use instead | Why |
|---|---|---|
| Helius Business $499 or QuickNode Solana gRPC add-on $499 (for gRPC streaming only) | **Triton PAYG** ($125 deposit, $0.08/GB) or **Alchemy Solana gRPC** (PAYG "from $75/TB") | Same Yellowstone gRPC, priced on usage |
| Moralis Starter $149 (annual) | **Helius Dev $49 + CoinGecko Analyst** | 2M CU is thin, and its pump.fun endpoints are being deprecated |
| CoinMarketCap Startup $79 / DexTools API $99 *(3rd-party)* | **CoinGecko Analyst** (or free DexScreener and GeckoTerminal) | CoinGecko has longer onchain OHLCV history, holders and traders |
| Mobula Growth $400 (just for WSS) | **Bitquery Pro $99** (EVM + Solana streams) or Birdeye Premium $199 | Cheaper streaming |
| Birdeye Premium $199 (if you already have Helius + CoinGecko Analyst) | **Helius `transactionSubscribe` + CoinGecko WS** | Mostly duplicated data |
| Bitquery archive packs ($300–$500/mo for Solana) | **Helius Developer** (Solana history) + **Dune Analyst** (SQL cohorts) | Much cheaper for full history |
| Glassnode Advanced $49 | **CryptoQuant Professional** *(3rd-party $99)*, or Dune for cohorts | Glassnode Advanced's "API Light" is daily data with only 14 days of history |
| Santiment Max $249 (for social) | **X API pay-per-use + LunarCrush Light $90** | Santiment has no Solana and costs more |
| Messari Enterprise / Token Terminal Pro $350 (for unlocks) | **Tokenomist $69** | A dedicated dataset at a fraction of the price |
| Arkham custom (from $100) at the start | **Nansen Pro + credits** (try the Arkham trial for labels) | Nansen has transparent self-serve pricing |
| ORATS Live $299 / Intrinio $150 / Databento OPRA $199 | **Tradier (free) + ThetaData Standard $80** | Tradier's greeks come from ORATS anyway |
| Massive Options Developer $79 | **ThetaData Value/Standard** ($40/$80, real-time) | Massive is still 15-minute delayed below $199 |
| Benzinga direct (contact sales) | **Massive Benzinga dataset $99/mo** or the free AWS Basic feed | Public price, same source |
| Tree News Sprout $500 (day one) | **Free Tree WS + RSS**. Upgrade only if you trade on headlines | The free tier is delayed but otherwise good |
| Dune Plus $399 | **Dune Analyst $75** | 4,000 credits is enough for scheduled batch cohort jobs |
| Bitquery Personal $49 | **Bitquery Pro $99** (or skip) | Personal has no streams and a non-commercial licence |
| GoldRush Vibe $10 | GoldRush free trial, then Professional only if EVM historical holders are needed | Vibe is non-commercial, with 10k credits |

---

## 4. Recommended bundles

### ~$50/mo: "Solana truth layer"
- **Helius Developer, $49.** Full tx history, early buyers and bundles, live tx stream, webhooks.
- Free alongside it: Tradier (real-time options and greeks), Alchemy Free (EVM RPC, 30M CU), CoinGecko Demo, Codex Almost-free (10k requests), Nansen Free credits, Tree News free WS, X API $20 free credit.
- **Total ≈ $49.** This tier gives the biggest jump in capability per dollar.

### ~$150/mo: "Multi-chain history + holders"
- Helius Developer **$49**
- CoinGecko Analyst **$103.20** (yearly billing) or $129 (monthly)
- Tradier **$0** for options, X API ~$10–20 usage
- **Total ≈ $152 (yearly CoinGecko) / $178 (monthly).**
- Unlocks: >180-day small-token history, holders and traders on all chains, WS price streams, full Solana forensics, real-time options chains.

### ~$300/mo: pick by focus
- **A. Balanced (crypto + options flow):** Helius $49 + CoinGecko Analyst $103.20 + Unusual Whales API Basic $150 = **≈ $302** (plus Triton's $125 one-time deposit for gRPC new-pair speed).
- **B. Crypto-heavy:** Helius $49 + CoinGecko Analyst $103.20 + Bitquery Pro $69 (yearly) + Nansen Pro $49 (yearly) + Tokenomist $69 = **≈ $339** (≈ $270 without Tokenomist). Adds EVM/Robinhood/Tron DEX streams, smart money and unlocks.

### "No compromise" (≈ $2.5–4k+/mo)
| Need | Pick | Price |
|---|---|---|
| Solana infra | Helius Professional (LaserStream gRPC + data add-ons) **or** Helius Business, with Triton as a redundant gRPC feed | $999 / $499 + usage |
| All-chain token data | Codex Growth (sub-1s, 80+ networks, launchpads) | $350+ (per 1M requests) |
| Solana trader/PnL data | Birdeye Business | $499 |
| Long history, multi-chain | CoinGecko Lite | $499 ($399.20 yearly) |
| EVM streams + archive | Bitquery Scale + EVM bundle | $299 + $600 (monthly) |
| Labels / smart money | Nansen credits at volume + Arkham custom | usage / contact sales |
| Exchange flows | CryptoQuant Premium / Glassnode Professional | contact sales |
| Unlocks | Tokenomist Standard API | $249.95 |
| Cohorts SQL | Dune Plus | $399 |
| Options flow | Unusual Whales API Advanced | $375 |
| Options ticks | ThetaData Options Pro | $160 |
| Stocks/options REST + news | Massive Options Advanced + Benzinga | $199 + $99 |
| Crypto news latency | Tree News Sprout | $500 |
| Social | LunarCrush Medium + X API | $300 + usage |

**Which upgrades are objectively worth the extra money:**
- **gRPC vs websockets** (Triton PAYG cheaply, or Helius Business): yes, if you show pump.fun launches and new pairs in real time. gRPC is lower latency and more reliable under load.
- **Tree News Sprout:** worth it only if you act on headlines within seconds. Otherwise RSS plus the free WS is fine.
- **Codex:** worth it for reliability and breadth across exotic chains (TON, Sui, Tron) once request volume justifies it. Before that, CoinGecko Analyst covers ~90% of the same ground.
- **Unusual Whales Advanced and ORATS:** mostly convenience or vol-modelling depth, not core needs.
- **CoinGecko Pro over Analyst:** only buys more credits and rate limit.

---

## 5. Free tiers to try first

| Provider | Free offer | Source |
|---|---|---|
| Helius | 1M credits, 10 RPS, archival, webhooks, LaserStream WSS | https://www.helius.dev/pricing |
| Alchemy | 30M CU/mo, 15 RPS, all chains | https://www.alchemy.com/pricing |
| QuickNode | 1-month trial, 10M credits | https://www.quicknode.com/pricing |
| Bitquery | 7-day trial including live WS streaming | https://bitquery.io/pricing |
| Dune | 14-day trial, 2,500 credits (Plus features, API) | https://docs.dune.com/resources/credits-billing/how-credits-work |
| CoinGecko | Demo: 10k calls/mo, 100/min | https://www.coingecko.com/en/api/pricing |
| CoinMarketCap | Basic: 15k credits + keyless public API | https://coinmarketcap.com/api/pricing/ |
| Codex | 10k requests/mo ($1 one-time fee) | https://www.codex.io/pricing |
| Mobula | 10k credits, 1 RPS | https://docs.mobula.io/pricing |
| GoldRush | 25k credits, 14 days | https://goldrush.dev/pricing/ |
| Birdeye | Standard (free) pack | https://bds.birdeye.so/pricing |
| Nansen | 100 credits + daily refill to 10 | https://academy.nansen.ai/en/articles/0938495-get-started-with-api |
| Arkham | Trial: 100k credits (individual) | https://arkm.com/llms/guides/credit-pricing.md |
| CryptoQuant | Basic: 10k credits, market data | https://cryptoquant.com/apis |
| Santiment | Free (30-day lag) | https://app.santiment.net/pricing |
| X API | $20 credit when you save a card | https://docs.x.com/x-api/getting-started/pricing |
| Tree News | Free WS (delayed, fewer sources) | https://docs.treeofalpha.com/websockets |
| Benzinga | Basic News API on AWS Marketplace | https://aws.amazon.com/marketplace/pp/prodview-xwgvhwowjmw3g |
| Unusual Whales | 7-day API trial | https://unusualwhales.com/pricing?product=api |
| Massive | Options Basic: EOD, 5 calls/min | https://massive.com/pricing?product=options |
| ThetaData | Free EOD tier (per docs) | https://docs.thetadata.us/Articles/Getting-Started/Subscriptions.html |
| Tradier | Sandbox (delayed); real-time with a brokerage account | https://docs.tradier.com/docs/market-data |

**Suggested order:**
1. Helius Free → validate the early-buyer / bundle pipeline.
2. CoinGecko Demo → test whether the onchain endpoints fit.
3. Bitquery 7-day trial → test EVM and Robinhood Chain streams.
4. Dune 14-day trial → prototype the HODL-wave SQL.
5. Unusual Whales 7-day trial → test flow.
6. Pay for whatever proved essential, starting with Helius Developer.

---

## 6. Caveats

- Several pages were JS-rendered or bot-blocked: Dune, CryptoQuant, DexTools, Messari, Tokenomist (Cloudflare on curl). For Dune I used the official docs. Third-party figures are marked as such.
- Helius' note that Parsed Events are free "until September 21st, 2026" is past, so expect a credit cost now.
- Licensing: Tradier, ThetaData, Massive (individual), Unusual Whales and Intrinio Individual are **personal-use** plans. If Asymmetric Terminal is ever offered to other users, you need commercial or redistribution tiers (contact sales). CoinGecko and Moralis require attribution.
- A tier label of "real-time" doesn't mean the same freshness everywhere. CoinGecko still caches about 30s on simple price, while Helius, Triton and Codex are sub-second.
