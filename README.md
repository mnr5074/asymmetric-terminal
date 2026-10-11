# Asymmetric Terminal: read-only multi-chain token dashboard (Solana first)

Dark "trading terminal" dashboard with a token watchlist, discovery feeds, a candle chart, a wallet viewer, a
**rug/manipulation Token Scanner**, and a **Moonshot Research** module. It's **read-only**: there's no wallet
connection, no private keys, no signing and no trading. Every risk number it shows is a heuristic, **not financial advice**.

## Run

```bash
cd /workspace/sol-terminal
node server.js                       # Node 20+, zero runtime deps → http://0.0.0.0:8000
# persistent background:
setsid nohup node server.js > server.log 2>&1 < /dev/null &
# env: PORT=8000 HOST=0.0.0.0

# Moonshot research data (Python 3 stdlib only, SQLite at data/moonshot.db)
python3 research/collect.py --max 300   # gather candidates + enrich (rate-limited, ~10 tokens/min)
python3 research/analyze.py             # → data/analysis.json (cohort stats, feature ranking)
python3 research/screener.py            # → data/screener.json (live similarity screener)
setsid nohup research/run.sh > data/run.log 2>&1 < /dev/null &   # refresh loop every 30 min

# screenshot (uses system Chrome through playwright-core, a dev dependency)
npm install && node scripts/screenshot.js "http://localhost:8000/?scan=solana:<mint>" screenshot.png
```

URL params: `?scan=solana:<mint>` or `?scan=robinhood:<0x…>`, `&deep=0` (skip the deep scan), `&wallet=<address>`,
`&tab=moon`, `&expand=1`, `&disc=pump|eco|profiles`.

## Features & data sources (each one checked with curl, 2026-10-10)

| Feature | Source | Notes |
|---|---|---|
| Search | DexScreener `latest/dex/search` | Filtered to Solana and Robinhood Chain |
| Watchlist (localStorage, 15s refresh) | DexScreener `tokens/v1/{chain}` + Jupiter `lite-api.jup.ag/price/v3` | Highest-liquidity pair per token |
| Chart | GeckoTerminal OHLCV (free, ~30 req/min) | Native canvas candles; "DS↗" opens the DexScreener embed instead (the embed shows "No data" in headless Chrome) |
| Trending / new | DexScreener `token-boosts/top`, `token-profiles/latest` | Chain selector: Solana / Robinhood |
| pump.fun new launches | `frontend-api-v3.pump.fun/coins?sort=created_timestamp` | Needs a browser User-Agent. `frontend-api.pump.fun` is dead (Cloudflare 1016); the trades and per-coin endpoints return 404/400 |
| Ecosystems → StonkFun | `stonkfun.xyz/api/public/v1/tokens` (no key) | StonkFun is a Solana launchpad for coins paired with tokenized stocks, ETFs, currencies, etc. It runs on Raydium LaunchLab curves and its token is STONK `6GmAFSYs…UNgx` |
| Ecosystems → Robinhood Chain | DexScreener `chainId=robinhood` + public RPC `rpc.mainnet.chain.robinhood.com` (chain 4663) | Blockscout API sits behind a Cloudflare challenge → skipped |
| Ecosystems → pons | pons v2 factory `0x7eD5…EC7e` `eth_getLogs` on Robinhood RPC + DexScreener + `api.ponsapi.dev/v1/tokens/{t}/price` | pons is a launchpad on Robinhood Chain, and PONS `0x39dB…4571` is its token. The official feed `ponsfamily.com/api/pons-launches` returns 404 and the ponsapi feed needs a key. Event meanings (launch `0x8d4a…`, graduation `0x308c…`) were worked out from on-chain data |
| Ecosystems → Fomo | none without a key | fomo.family has no official public API. The unofficial, unaffiliated `api.fomoapi.io` mirrors its trending/graduated/most-held boards but needs a key (free tier: 1,000 calls/month). Set `FOMOAPI_KEY=<key>` to enable the tab and the `fomo_*` research candidates |
| Wallet viewer | Solana RPC `getBalance`, `getTokenAccountsByOwner` (Token + Token-2022), Jupiter prices/metadata | Read-only |
| Token Scanner | RPC `getAccountInfo`, RugCheck `v1/tokens/{mint}/report`, DexScreener `token-pairs`/`orders` | See below |

### Token Scanner checks (traffic light + evidence; results cached 90s for quick scans, 15 min for deep scans)
Mint/freeze authority (RPC) · Token-2022 extensions/transfer fee · top-10/top-20 holder % with pools, LPs and lockers left out
(RugCheck holders, falling back to RPC `getTokenLargestAccounts`, which the public RPC often 429s) · creator share · holder count ·
LP burned/locked (RugCheck markets; CLMM/DLMM positions have no LP token, so they show as "not determinable") · liquidity depth and
**quote-side ("real") liquidity**, which catches one-sided fake pools · RugCheck insider networks · **deep scan**: pages
`getSignaturesForAddress` back to the oldest transaction (public RPC stops at 20k signatures, a custom RPC goes up to 60k), parses the earliest
transactions for creation-slot bundles, snipers within 10 slots, their current holdings (`getMultipleAccounts`) and shared funding
sources (each wallet's first incoming SOL transfer) · volume/liquidity (wash trading) · price spikes · buy/sell imbalance (honeypot-ish)
· FDV/liquidity (including liquidity ≈ FDV) · pair age · socials · mutable metadata.
Robinhood (EVM) tokens get bytecode/owner()/selector checks plus market checks. Holder and bundle checks are skipped there because there's no free holder API.
**Settings → RPC**: paste a Helius/Triton URL. It's kept in localStorage and sent per request in the `x-rpc-url` header (https only).
All Solana RPC calls go through a throttled queue (260 ms gap on the public RPC) and retry 429s with backoff.

### Moonshot Research (`research/`, SQLite `data/moonshot.db`)

Multi-chain: `python3 research/collect.py --chains all` (or `solana,base,bsc,ethereum`) adds Base/BSC/Ethereum candidates from DexScreener boosts/profiles/searches, GeckoTerminal trending/top-volume/new pools and BSC four.meme pools. These are enriched with GeckoTerminal OHLCV and a GoPlus holder/LP snapshot, and tagged by `chain`. The main feature table stays Solana-only. `analysis.json.byChain` holds per-chain cohorts, medians and separating features, shown when the header chain is Base/BSC/Ethereum and as a summary table under the Solana view. Dead EVM tokens are under-sampled because no free feed lists them.
- **Candidates**: pump.fun lists (by market cap and recently graduated), DexScreener boosts/profiles and themed searches, StonkFun.
- **Per token**: launch time (hour of day, weekday), launchpad, bonding-curve completion time, launch/peak/current price and mcap
  (GeckoTerminal OHLCV: the curve pool at 1-minute candles, then hourly, then daily), multiple, time to 2x/10x/100x, volume needed to
  reach 10x/100x, drawdown before 10x, first-1h/24h volume, share of green candles, socials, ticker/name themes, DexScreener
  profile/boost timing and CTO, dev prior launches and best prior mcap (RugCheck `creatorTokens`), current holders/top-10/insider %,
  LP lock, and top holders shared with other mooned tokens (leave-one-out wallet overlap).
- **Cohorts**: `mooned` (peak close ≥ 100× launch), `died` (now ≤ 10% of peak and illiquid, or rugged), `middle`, `too_young`,
  `suspect_fake` (quote-side liquidity < 0.2% of mcap, or lifetime volume < 2% of claimed peak), `out_of_window` (launched more than 180 days ago).
- **Analysis**: medians and IQR per cohort, Mann-Whitney AUC/z for numeric features, rate gaps and lift for categorical ones, ranked by
  separation, with flags for small samples, look-ahead, outcome-linked and survivorship features.
- **Screener**: binned naive-Bayes log-likelihood ratios on early-available features → a 0–100 "similarity" score for tokens under 3 days old,
  plus GeckoTerminal recent-trade stats (unique buyers, median buy, top buyer share). This is a heuristic, not a prediction.

#### Data limits and what paid keys would unlock
- **GeckoTerminal free tier only serves the last 180 days** of OHLCV, so older winners (TROLL, WIF, BONK…) can't be measured.
  A CoinGecko paid plan (Analyst, ~$129/mo) unlocks full history.
- **No free historical holders or early trades**. Holder count over time, unique buyers before 10x/100x, early buyers' average entry
  price, buy-size distribution at launch, smart-money wallets among early buyers and cross-token early-buyer overlap all need indexed
  trade history:
  **Helius** (parsed transaction history, Developer plan ~$49/mo), **Birdeye** (holders and trades, Starter ~$99/mo), **Bitquery**
  (pump.fun/DEX trades GraphQL, free trial then paid), **Dune** (SQL over `dex_solana.trades`, free tier with credits),
  **Solscan Pro API** (holders/transfers, ~$199/mo). With any of these the collector could fill early-buyer features at the 2×/10×/100× milestones.
- The public Solana RPC can't page past ~6k signatures, so deep scans only work on young tokens. A private RPC fixes that.
- RugCheck holder/LP/insider data is a current snapshot (look-ahead), so it's flagged in the UI.

## Multi-chain (verified keyless 2026-10-10)

A chain selector in the header drives search, Trending/New and Research: Solana (default), Ethereum, Base, BSC, Arbitrum, Polygon, Avalanche, Blast, Optimism, Robinhood Chain, Sui, TON, Tron, or **All chains**. The watchlist has its own chain filter. Registry: `lib/chains.js`.

| Chain | Search / watchlist / chart | Trending · New | Scanner | Wallet viewer |
|---|---|---|---|---|
| Solana | DexScreener + Jupiter, GeckoTerminal OHLC | DS boosts/profiles, pump.fun | full (RPC, RugCheck, bundles/snipers deep scan) | SOL + SPL (RPC) |
| Ethereum, BSC, Base | DexScreener, GeckoTerminal OHLC | DS boosts + GT trending / new pools | GoPlus + **Honeypot.is buy/sell simulation** | native on every EVM chain (publicnode); ERC-20 list on Ethereum only (Ethplorer freekey) |
| Arbitrum, Polygon, Avalanche, Blast, Optimism, Robinhood | same | same | GoPlus (Honeypot.is does not cover these chains) | native balance only |
| Sui | DexScreener, GT OHLC | DS + GT | GoPlus Sui (mintable, deny list, upgradeable, metadata, holders) | SUI + coin list (Sui GraphQL, raw amounts) |
| TON | DexScreener, GT OHLC | DS + GT | tonapi.io (mintable, verification, holders); GoPlus has no TON support | TON + jettons with USD prices (tonapi) |
| Tron | DexScreener, GT OHLC | DS + GT | GoPlus Tron (Honeypot.is: n/a) | TRX + TRC-20 list (TronGrid, raw amounts) |

EVM/Tron scanner checks: honeypot (simulated sell), buy/sell tax and whether the owner can change it, verified source, owner/hidden owner/reclaimable ownership, mint function, proxy/blacklist/pause/cooldown/balance-edit switches (rated inert when ownership is renounced), creator honeypot history, top-10 holders excluding LP/burn/locked, holder count, creator/owner share, V2 LP burned/locked (V3/V4 NFT positions are not covered), plus the DexScreener market checks. First-block bundle detection is Solana-only. GeckoTerminal's free tier (~30 req/min) is shared and serialized in the server.

## Macro & News panel (lower tab)

* **Fed**: target range (FRED DFEDTARU/DFEDTARL), effective rate (DFF), recent FOMC decisions derived from target changes on Fed calendar dates, next meeting (federalreserve.gov FOMC calendar), market odds from **Kalshi** (KXFEDDECISION, public) and **Polymarket** (fed-rates tag).
* **Yields**: 2y/10y Treasury (DGS2/DGS10) and the 2s10s spread.
* **Data**: payrolls m/m (PAYEMS), unemployment (UNRATE), CPI and PCE y/y and m/m (CPIAUCSL, PCEPI), real GDP q/q annualized (GDPC1).
* **Calendar**: exact jobs/CPI/PCE/GDP release dates from FRED's release calendar (BLS's own site and RSS return 403 to scripts).
* **News**: The Block, Decrypt, Cointelegraph, CoinDesk and Fed press-release RSS, merged by time. CryptoPanic needs a key and is not used.
* **Event study** (`research/macro_events.py` → `data/macro_events.json`): BTC (FRED CBBTCUSD, since 2014-12) and SOL (Coinbase candles, since 2021-06) median moves on FOMC cut/hike/hold days, hot/cold jobs reports and CPI prints, same day and +7d, vs the average daily move. FRED's calendar only covers 2025 onward, so earlier jobs-report dates come from the BLS scheduling rule, and CPI history is 2025+ only. "Hot/cold" compares with the trailing-12-month median, not consensus. Small samples; descriptive only.

FRED's `fredgraph.csv` rejects browser-like user agents, so the server fetches it with no UA.

## Options screener (header: Options)

Every listed **Derive.xyz** option (about 3,800 across BTC, ETH, SOL, HYPE, XRP, ZEC, ADA, PUMP, LIT, VVV, XAUT, CC; live order book via `api.lyra.finance/public`) plus **CBOE delayed chains** (`cdn-api.cboe.com/api/global/delayed_quotes/options/<SYM>.json`, about 15 min delayed, ~184K contracts) for 63 liquid US stocks/ETFs (change with `OPT_UNIVERSE`). Long calls and puts only, so max loss is the premium. Built by `research/options.py` into `data/options.json`; the server re-runs it in the background when the file is older than 30 minutes (a run takes about 3 minutes).

Per contract: Black-Scholes fair value using realized vol (mean of 30/90/180-day close-to-close; Yahoo daily closes for stocks, Coinbase daily candles for crypto), premium vs fair, IV vs RV, max loss, breakeven and move needed, ±1σ/±2σ range by expiry, the underlying price needed at expiry for 3x/5x/10x, a suggested exit date (keeps 40% of the time left, before theta speeds up) with the price needed by then for a 3x mark, P(ITM) and P(touch the 3x level) under IV and RV, EV, reward:risk at a 2σ move, theta per day, volume/OI (unusual activity flag), earnings date before expiry (Nasdaq calendar, IV crush warning), and the best expiry per underlying.

**Grade formula** (0-100): `30*EV + 25*touch + 20*convexity + 15*cheapness + 10*liquidity`
- EV = clip((EV% + 25) / 225), EV% = (BS value at realized vol - premium) / premium
- touch = clip(P(touch 3x level before expiry, realized vol) / 0.5)
- convexity = clip(ln(1 + R) / ln 11), R = payoff multiple at a +2σ (IV) move
- cheapness = clip((1.3 - IV/RV) / 0.6)
- liquidity = clip(1 - spread / 30% of mid), 0 without a live bid/ask or open interest
- A ≥ 75, B ≥ 60, C ≥ 45, D ≥ 30, else F. Caps: mark-only quote (common on Derive) max C; under 3 days max D; under 7 days or theta > 20%/day max C; theta > 10%/day max B; earnings before expiry with IV/RV > 1.5 max C.

Limits: lognormal, driftless model; touch uses the reflection approximation; realized vol looks backward, so "cheap vs RV" can just mean the stock was wild recently. No dividends; flat rates (4% stocks, 0% crypto). CBOE quotes outside market hours are last-session values. Coinbase vol is rejected when the Coinbase price disagrees with the Derive index by >15% (e.g. LIT is a different asset on Coinbase), and CC has no free vol source. Estimates, not advice: long options usually expire worthless.

## Airdrops & points (header: Airdrops)

`research/airdrops.py` → `data/airdrops.json` (refreshed when older than 6 h). Sources: airdrops.io `/latest/ /hot/ /speculative/` listing pages (status, heat, publish date, required actions, official host, KYC flag); DefiLlama `api.llama.fi/protocols` (TVL, tokenless protocols, listing date, official URL); funding from the public `defillama.com/raises` page data (the `api.llama.fi/raises` API now returns HTTP 402, paid only). Funded tokenless protocols with ≥ $5M TVL that have no airdrops.io listing are added as "no announced program" candidates. Not available free: CryptoRank (403 without key), DropsTab (no public API), CoinGecko airdrops (404), and participant or points totals from any source, so TVL per user cannot be computed. airdrops.io heat stands in for crowding.

**Grade formula** (0-100): `25*no token + 20*funding (log10 $ raised: $1M=0, $100M+=1) + 20*early (1 - days since first seen / 365) + 15*uncrowded (1 - heat / 150) + 10*low dilution (TVL $1M=1 … $1B=0) + 5 top-tier backer + 5 speculative`; minus 5 for KYC, 15 for an announced TGE, 35 for claim live or ended; capped at C with no disclosed funding and under $1M TVL. A ≥ 70, B ≥ 55, C ≥ 40, D ≥ 25, else F.

**Assist mode** (right panel): track a campaign to get a checklist (safety steps + the campaign's listed actions) with progress, due and reminder dates, an `.ics` calendar reminder and optional browser notifications. Everything is kept in your browser's localStorage. Wallets: **Phantom** through its injected Solana provider (`window.phantom.solana`, Wallet Standard compatible; the @solana/wallet-adapter React library is not bundled because the frontend has no build step) and **Rabby** through **EIP-6963** discovery (`io.rabby`) with an EIP-1193 `window.ethereum` fallback. Prepared steps: send native coin to an address you copy from the official docs (SOL transfer message built in the page and byte-checked against @solana/web3.js; EVM `eth_sendTransaction` after `wallet_switchEthereumChain`), or sign an ownership message. Every step opens in your wallet for review; the page never sees keys and never signs automatically. For protocol actions (swaps, LP, lending) use the official app with the same wallet and tick the task.

## Files
`server.js` (HTTP + API proxy/cache) · `lib/scanner.js` · `lib/solrpc.js` · `lib/util.js` · `public/` (vanilla JS/CSS) ·
`research/` (collector, analysis, screener) · `scripts/screenshot.js`.

## Deploying as a public website

The app is deploy-ready: zero-dependency Node server, honours `PORT`/`HOST`, health check at `/api/health`,
`Dockerfile` + `render.yaml` (Render Blueprint) + `scripts/start.sh` entrypoint. Nothing has been deployed.

**Environment variables** (see `.env.example`)

| var | default | purpose |
|---|---|---|
| `PORT` | 8000 | listen port (Render/Railway/Fly set this automatically) |
| `HOST` | 0.0.0.0 | bind address |
| `PUBLIC_MODE` | unset (`1` in Docker) | per-IP rate limits (240 API calls/min, 4 deep scans/min) and a custom RPC URL is only accepted for known providers (Helius, QuickNode, Triton, Alchemy, Ankr, Chainstack, Syndica, Shyft, …), which blocks SSRF through the `x-rpc-url` header |
| `DATA_DIR` | `./data` | analysis.json / screener.json / moonshot.db location (mount a disk here) |
| `RUN_RESEARCH` | 0 | `1` = run the research collector loop inside the container (`RESEARCH_MAX`, `RESEARCH_SLEEP`) |
| `FOMOAPI_KEY` | unset | optional key for the Fomo ecosystem tab |
| `SITE_PASSWORD` | unset | when set, every page and `/api/*` route needs a login (except `/api/health`). Unset means the site is open (local use) |
| `SITE_USER` | `martin` | login user name |
| `SESSION_SECRET` | random per process | HMAC key for the session cookie. Set it (Render generates one), or logins reset on every restart |
| `SESSION_DAYS` | 14 | session lifetime |
| `SOLANA_RPC_URL` | public mainnet-beta | server-side default Solana RPC (e.g. `https://mainnet.helius-rpc.com/?api-key=…`); keep it secret, set it in the host dashboard |

**Password protection.** If `SITE_PASSWORD` is set, visitors get a `/login` page. A correct user and password sets a signed session cookie (HMAC-SHA256, httpOnly, SameSite=Lax, and Secure over HTTPS). Without that cookie, pages redirect to `/login` and API calls return 401. `/api/health` stays open for Render's health check. Each IP gets 5 failed logins per 15 minutes, and there's a cap of 30 failures per 15 minutes across all IPs. Changing the password signs everyone out. **Sign out** in the header, or `/logout`, clears the cookie.

**Render, free plan (needs a Render account + a GitHub/GitLab account):**
1. Push `/workspace/sol-terminal` to a new GitHub repo (`git init && git add . && git commit -m init && git remote add origin … && git push`). `.gitignore` leaves out the SQLite db but keeps the `data/analysis.json` and `data/screener.json` snapshot.
2. In Render: **New → Blueprint**, pick the repo. Render reads `render.yaml` and builds the Dockerfile. In the form, enter **SITE_PASSWORD**, a long password that only you know. `SESSION_SECRET` is generated for you. `SOLANA_RPC_URL` and `FOMOAPI_KEY` are optional, so leave them blank if you don't have them.
3. Open `https://asymmetric-terminal.onrender.com` (or whatever name Render assigns). Custom domain: Settings → Custom Domains.

**Tradeoffs**
- *Free plan:* $0, but it sleeps after about 15 min idle (the first request takes roughly 30–60 s to wake it). The disk is ephemeral, so the Moonshot tab serves the research snapshot baked into the image, and you refresh it by re-running research locally and pushing.
- *Persistent research:* switch to `plan: starter` (about $7/mo) and uncomment `disk` (1 GB, about $0.25/mo), then set `RUN_RESEARCH=1`. SQLite on one disk is fine for a single instance. Disks block horizontal scaling and zero-downtime deploys.
- *Hosted DB alternative:* move the dataset to Postgres (Render Postgres, Neon or Supabase free tiers) if you need several instances or a separate worker. That means porting `research/common.py` from sqlite3 to psycopg, and the web tier only reads JSON outputs, so it barely changes.
- *Other hosts:* the same Dockerfile runs on Railway (volume support, usage-based billing at about $5/mo), Fly.io (volumes, needs a card), or any VPS (`docker build -t asymmetric-terminal . && docker run -p 80:8000 asymmetric-terminal`).
- *Public traffic:* all users share the free upstream limits (public Solana RPC, DexScreener, GeckoTerminal, RugCheck). Expect 429s under load. A Helius key ($0 tier / $49 per month) used server-side is the first upgrade to make.

## Command Center (default view)
One dense page fed by backend **desks**, each running its own loop and writing a ranked digest plus a rule-based "what changed in the last hour" summary (templates, no LLM):
- **Crypto Desk** – live alpha feed (`lib/livefeed.js`): discovery on 13 chains → scanner → Asymmetry Score/grade, with the **Rug Risk Forecast** (`lib/rugrisk.js`) applied as veto (≥70) or penalty (≥45: −10 pts, A capped at B). Every graded pick is logged and tracked (`lib/calls.js`).
- **Stocks & Options Desk** – best A pick per underlying + unusual volume (`research/options.py`).
- **Macro/Fed Desk** – FRED, FOMC calendar, Kalshi/Polymarket odds (`lib/macro.js`).
- **News Desk** – RSS headlines with keyword-lexicon sentiment and ticker/token mentions linked to the live feed and the options universe.
- **Airdrop Desk** and **Sleeper Desk**.
Click any token (feed, watchlist, slow-rug list) for the scanner detail. API: `/api/desks`, `/api/live`, `/api/rug/watch`, `/api/rug/token`, `/api/reportcard`, `/api/sleepers`, `/api/alerts`.

## Text alerts
`lib/alerts.js` texts new A-grade tokens (<160 chars: grade, score, ticker, chain, mcap, dump-risk flag, link), dedupes per token for 24h, caps at `ALERT_MAX_PER_HOUR`, respects quiet hours, and sends a periodic follow-up digest. It speaks plain SMTP (STARTTLS/TLS, AUTH LOGIN) to an email-to-SMS gateway. **Default is DRY RUN**: every would-be text is written to `data/alerts.log` and visible at `/api/alerts`. To go live set `ALERTS_LIVE=1` and `SMTP_HOST/SMTP_USER/SMTP_PASS/ALERT_TO` (see `.env.example`).

## Revival lab (Sleepers: lookalikes + accumulation)
`research/revival_lab.py` (runs after `sleepers.py`) adds, from CoinGecko 365-day daily history:
- **Accumulation-phase detector**: ≥3 of flat 30d price, tight 60d range, compressed volatility, rising volume → flag, with a backtested base rate.
- **Lookalike engine**: pre-breakout fingerprints (features averaged 30–90 days before each breakout) and nearest-neighbour matching ("looks like X before its run, similarity N%") with a leave-one-out backtest.
- **Holder distribution (free)**: GoPlus holder count, top-10 share, Gini of top holders, share in contracts (EVM only), and our own holder-count snapshots over time.
**Needs a key / paid** (not implemented): holding-period buckets, cost basis / share in profit, wallet age, funding-source clustering, active-address history — Etherscan v2 (free key), Helius/Birdeye (Solana), Bitquery/Dune (free tier with key), Glassnode/IntoTheBlock (paid). Public RPCs are not archive nodes, so this history can't be rebuilt keylessly.

## Options: full universe, signals, trade plan, explanations
- **Universe** (`research/opt_universe.py`, weekly): OCC product directory (every optionable underlying, 6,091) ∩ NASDAQ Trader `nasdaqtraded.txt` listings on NASDAQ / NYSE / NYSE American / NYSE Arca / Cboe BZX ∩ value filter (stocks: market cap ≥ $300M and ≥ $5M/day traded via the Nasdaq screener; ETFs: all optionable) → ~4,950 symbols. `options.py` scans the 64 core tickers every run plus a rotating batch (`OPT_BATCH`, default 250): never-seen first, then high-OI symbols (total OI ≥ 5,000) hourly, low-OI symbols weekly; chains with < 1,000 total OI are skipped. Picks from earlier rotations are reused for up to 3 days (marked with their age).
- **Ticker signals** (`research/stock_signals.py`, keyless): pre-market/after-hours price (Yahoo chart `includePrePost`; the v7 quote endpoint is now Unauthorized), up/down volume over 10 sessions, Yahoo per-ticker RSS headlines + lexicon tone, SEC EDGAR 8-Ks and Form 4 open-market buys/sales with cluster-buying detection (set `SEC_USER_AGENT` with a contact), call/put volume and premium from the CBOE chain. They adjust the score by at most ±6 and never lift a capped grade. Not free: 13F per-issuer changes (WhaleWisdom/Fintel), real-time order flow/sweeps (Tradier, Unusual Whales, ThetaData, Polygon). CBOE quotes are ~15 min delayed; a real-time provider can replace `stock_contracts()`' CBOE fetch (same contract dict format).
- **Chance of profit** (finish beyond breakeven) and **chance of hitting 2x / 3x before the time stop** (21-DTE rule, touch approximation with realized vol) on every pick.
- **Trade plan** per pick (model estimate, not advice): limit price (mid, shaded to the bid on wide spreads, not above fair value), entry timing (earnings / IV vs RV), sizing from your budget and max-%-at-risk (saved in the browser), take-profit levels, time stop, stop-loss guidance, exercise-vs-sell with the cash needed.
- **Plain-English ⓘ** popups on every column/metric (tap on mobile; examples use that row's numbers), a one-line summary per pick, and a **Guide** page (glossary + how every grade works).

## Nansen (optional, `NANSEN_API_KEY`, server-side only)
Pro plan = 2,000 credits/month top-up. `lib/nansen.js` enforces a daily cap (`NANSEN_DAILY_CREDITS`, 60) and monthly cap (`NANSEN_MONTHLY_CREDITS`, 1800) plus per-purpose sub-caps, caches every response long-term (re-reads are free), and stops if fewer than 20 credits remain. Used: `account` (free, credits left), `smart-money/netflow` (5 cr, ≤2×/day, 500 tokens on Solana/Ethereum/Base/BNB), `tgm/flow-intelligence` (1 cr, A/B live candidates and top sleepers only, cached 6–24 h), `tgm/who-bought-sold` (1 cr, alerted tokens only). Address labels (100 cr) are deliberately not used. Low-credit warning (< 20% of the monthly budget, or projected to run out before the 1st) shows a banner and sends one text alert.

## X API (optional, `X_BEARER_TOKEN`)
Posts Read only ($0.005 per post returned; counts and User Read are not used). `lib/xapi.js` samples ~20 recent posts per item (`X_SAMPLE`) for text-alert tokens first, then the top live picks and top option underlyings, every 30 min with a 6 h cache; hard caps `X_DAILY_POSTS` (330) and `X_MONTHLY_CAP_USD` ($50 ≈ 10,000 posts). Features (posts/hour, average tone, engagement) are written into each live call so `/api/x` reports whether positive X tone actually separated 2x winners. Without a token the panel is hidden.
