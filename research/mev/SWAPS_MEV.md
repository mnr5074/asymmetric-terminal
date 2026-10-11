# Wallet-approved swaps, private routing, sandwich log, portfolio

Design rule (agreed with the user): the terminal never holds private keys and never auto-trades.
Every swap is a one-tap transaction that YOU approve and sign in Phantom (Solana) or Rabby (EVM).

## Files (all new; only additive one-line hooks in server.js + index.html)
- `lib/swaps.js`: quote (Jupiter lite-api swap v1, Raydium trade API), unsigned tx build, tx decoder (fees, tip, fee payer), submit
- `lib/mev.js`: post-fill check (quote vs fill), same-slot bracket check via getBlock, wallet audit jobs; log in `data/sandwich_log.json`
- `lib/portfolio.js`: read-only multi-wallet aggregation (Solana + 8 EVM chains), cost basis estimate, narrative tags; cache in `data/portfolio.json`
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
