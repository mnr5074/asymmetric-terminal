# Wallet-approved swaps, private routing, sandwich log, portfolio

Design rule (agreed with the user): the terminal never holds private keys and never auto-trades.
Every swap is a one-tap transaction that YOU approve and sign in Phantom (Solana) or Rabby (EVM).

## Files (all new; only additive one-line hooks in server.js + index.html)
- `lib/swaps.js`: quote (Jupiter lite-api swap v1, Raydium trade API), unsigned tx build, tx decoder (fees, tip, fee payer), submit
- `lib/mev.js`: post-fill check (quote vs fill), same-slot bracket check via getBlock, wallet audit jobs; log in `data/sandwich_log.json`
- `lib/portfolio.js`: read-only multi-wallet aggregation (Solana + 8 EVM chains), cost basis estimate, narrative tags; cache in `data/portfolio.json`
- `lib/impact.js`: price-impact ladder (Solana via Jupiter/Raydium; EVM via ParaSwap with KyberSwap fallback, both keyless)
- `lib/fees.js`: priority-fee / gas prediction with history in `data/fee_history.json`
- `research/mev/test_brackets.js`: synthetic buy and sell sandwich tests for the bracket detector (`node research/mev/test_brackets.js`)
- `lib/tradeapi.js`: HTTP glue (GET + POST) mounted from server.js
- `public/swap.js`, `public/portfolio.js`: the Swap and Portfolio views (they add their own nav buttons and scoped CSS)

## Swap flow (Solana)
1. `GET /api/swap/quote?inputMint&outputMint&uiAmount|amount&slippageBps&source=jupiter|raydium`
2. `POST /api/swap/build {quoteId,userPublicKey,route:'private'|'public',tipLamports,dynamicSlippage,priorityLevel}`
   - Jupiter + private: `prioritizationFeeLamports:{jitoTipLamports}` puts the Jito tip transfer inside the swap tx
   - Jupiter + public: `priorityLevelWithMaxLamports` (default high, capped at 0.0002 SOL)
   - Raydium + private: [swap tx, separate tip tx] sent as an atomic Jito bundle (the wallet signs 2 txs)
   - `dynamicComputeUnitLimit:true` and `dynamicSlippage:true` (Jupiter caps it at the max slippage you set, default 50 bps)
   - The server decodes the tx it built (fee payer, CU limit/price, tip, programs) and simulates it with `sigVerify:false`
3. Browser: Phantom `solana:signTransaction` (Wallet Standard, raw bytes). This is not signAndSend, so the terminal controls where the tx goes.
   Fallback: the injected provider's `signTransaction`, with web3.js loaded on demand.
4. `POST /api/swap/submit {buildId,signedTransactions}`: the server checks the fee payer matches the quoted wallet and that the tx is signed. Then:
   - private: `https://mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true` (or `/api/v1/bundles`)
   - public: `sendTransaction` on your RPC (public mainnet-beta unless one is set in ⚙ RPC)
5. A background watcher waits for confirmation, then runs `getTransaction`, computes the fill from balance deltas, compares it with the quote and runs `getBlock` for the bracket check.

## Costs (nothing is paid unless you sign and the tx lands)
- Jito tip (private): 0.0001 SOL by default (about $0.011 at $109/SOL). You can set it from 0.000001 to 0.005 SOL. The UI shows the live landed-tip p50/p75/p95 (about 0.000005 / 0.00001 / 0.000014 SOL on 2026-10-11).
- Network base fee: 0.000005 SOL per signature.
- Priority fee (public route only): Jupiter estimate, capped at 0.0002 SOL (about 0.000016 SOL in the test).
- Opening a new token account takes about 0.00204 SOL of rent, which is refunded if you close the account.
- No platform fee. No paid APIs. Keyless rate limits: Jupiter lite-api, Jito 1 rps/IP, public RPC.

## Alternatives (documented, not wired)
- Helius Sender (`sender.helius-rpc.com/fast`, free and keyless at 1 rps). It needs both a Helius tip (minimum 0.000005 SOL on SWQOS-only, 0.001 SOL on Sender Max) and a priority fee. That means building through Jupiter `/swap-instructions`. `?mev-protect=true` avoids validators linked to sandwiching.
- Jupiter Ultra has its own landing, but it signs and submits through Jupiter's `/execute`, so the terminal would lose control of submission.
- Regional Jito endpoints via `JITO_BLOCK_ENGINE_URL` (ny, amsterdam, frankfurt, tokyo, slc).

## EVM (Rabby)
Rabby lets you set a custom RPC per chain. Free private mempools on Ethereum:
- Flashbots Protect: `https://rpc.flashbots.net/fast`
- MEV Blocker: `https://rpc.mevblocker.io` (or `/noreverts`)

Base, Arbitrum and Optimism run on a centralized sequencer with no public mempool. The terminal does not build EVM swaps. Use the official DEX UI with the private RPC set in Rabby.

## Sandwich detection: what it can and cannot see
- Fill check: shortfall = 1 − fill price ÷ quoted price. The quote's outAmount already includes its price impact. A trade is suspected when the shortfall is above the tolerance (default 0.5%, adjustable in the panel). The log also records whether the fill stayed within the max slippage.
- Bracket check: in the same slot, it looks for a tx by one signer before ours and another by the same signer after ours. Both must move tokens in the pool our tx used. The front tx must buy what we bought and the back tx must sell it. Both must sit within 8 txs of ours, and the attacker must profit in our input token. A pair that matches only partly is reported as a "loose bracket".
- Limits: it misses sandwiches that span several slots or use different wallets for the front and back legs. A natural price move between quote and fill also shows up as shortfall, so results are "suspected", not proof.
- Field check (2026-10-11): 90 recent mainnet blocks (about 5,300 swaps) gave 0 strong brackets with the final rule. Sandwiches on today's Solana mostly happen through private validator flow and multi-wallet setups that same-slot, same-signer matching cannot see.

## Sell-side protection (added 2026-10-11)
- **Buy/Sell toggle in the Swap tab.** Buy is SOL/USDC to token. Sell is token to SOL/USDC (a token-to-token swap counts as a sell of the input). Choosing Sell, or arriving from a Portfolio sell button, switches the route to **Private (Jito)**. You can still switch to Public. The tip display, the cost review and the confirm checkbox are the same as for buys.
- **Portfolio sell buttons.** Each Solana position has 25% / 50% / 100% buttons. They open the Swap tab with a prefilled SELL quote. Nothing is signed from Portfolio. 100% of SOL keeps 0.01 SOL back for fees. If the connected Phantom wallet is not the wallet that holds the position, the review shows a warning. EVM positions point to the DEX UI with a private RPC set in Rabby.
- **Amounts round down.** Quote amounts are floored, so a 100% sell never asks for more than the wallet holds.
- **Every trade carries side=buy|sell.** The log shows a side column. Stats show buys and sells separately: suspected count, % sandwiched and $ lost. Wallet audits report buys and sells separately too.
- **Bracket detector works in both directions.** In a buy sandwich, the front-run buys the token and the back-run sells it. In a sell sandwich, the front-run sells the token before ours and the back-run buys it back after. A hit is "strong" when both legs are within 8 txs of ours and the attacker's net gain in SOL/USDC (from the pool's balance changes) is positive. The synthetic tests confirm a sell sandwich is flagged, a buy sandwich is flagged, and a sell pattern checked as a buy is not flagged.
- **Chunk check for thin sells.** `GET /api/swap/chunks` runs when quoted impact is 1% or more. It quotes 100%, 50%, 25% and 10% slices and shows the impact per slice and the total you'd receive if split, assuming the pool refills between slices. Example: selling 200M BOME (about $220K) has 2.2% impact in one tx, versus 0.15% per slice in 10 slices (about +2.1% more SOL in total). Each slice is a separate tx you sign.

## Price-impact ladder (added 2026-10-11)
- `GET /api/swap/ladder`. Solana takes `inputMint&outputMint&uiAmount`. EVM takes `chain&tokenIn&tokenOut&uiAmount`.
- Sizes: $50, $250, $1K, $5K, $25K, $100K, $500K and $2.5M, plus 1/5/10/25/50/100% of your intended size. The $ ladder stops once impact passes 8%, to save free-API calls. Calls are spaced out and retried, because Jupiter's free tier returns 503 on bursts.
- impact = max(the source's reported impact, how much worse the price is than the smallest quote).
- The output includes the largest size that stays under 1%, 2% and 5% impact, estimated between the two ladder sizes around each crossing. The UI shows an SVG curve with your size marked.
- **Extra confirm.** When impact is above your alert threshold (default 2%), the review shows an extra "I accept X% impact (about $Y lost)" checkbox. Sign stays disabled until both boxes are ticked. Impact here is the higher of the quote's own figure and the ladder's figure at your size.
- **EVM sources.** ParaSwap `/prices` and KyberSwap `/routes` work without a key. 0x and 1inch require keys. Odos was blocked by Cloudflare (all checked 2026-10-11).
- **Examples (2026-10-11).**

| Pair | Your size | Impact at your size | Max size under 1% | Under 2% | Under 5% |
|---|---|---|---|---|---|
| BOME to SOL | $55K | 0.55% | about $97K | about $145K | about $452K |
| DEGEN to WETH on Base (ParaSwap) | $1K | 0.38% | about $6K | about $14K | about $40K |

## Fees and timing (added 2026-10-11)
- `GET /api/fees`, with optional `accounts=` (up to 5 pool addresses) for fees scoped to a specific route.
- **Solana priority fee.** Uses `getRecentPrioritizationFees` scoped to the busiest SOL/USDC Orca Whirlpool. The unscoped call returns each slot's minimum fee, which is almost always 0. Values are in micro-lamports per compute unit. Swap cost assumes about 200k compute units (1e6 micro-lamports = 1 lamport). Example: p75 of about 2,356 means about 0.00000047 SOL per swap. Helius's fee estimate needs a key, so it is not used.
- **Jito tips.** From the landed-tip floor (p25 to p99).
- **EVM gas.** `eth_feeHistory` on Ethereum, Base, BSC and Arbitrum, converted to $ per ~180k-gas swap.
- **History.** A sample every 15 min goes to `data/fee_history.json` (kept 30 days). For the past 7 days, EVM history is backfilled hourly from free endpoints that keep old fee data: eth.drpc.org (fallback rpc.flashbots.net), mainnet.base.org and bsc-dataseed.bnbchain.org. publicnode refuses fee history older than about a day. No free endpoint serves past Arbitrum fee data, so Arbitrum, Solana and Jito history only starts when the terminal began sampling. Their verdict reads "history building" for the first 24h.
- **Output.** Where the current fee sits among the last 7 days of samples, a verdict (30th percentile or lower = cheap, 70th or higher = expensive), the cheapest hours of the day and week in PT, and plain-English explanations. A "use p75×1.5" button sets the Jito tip from current tip levels.
