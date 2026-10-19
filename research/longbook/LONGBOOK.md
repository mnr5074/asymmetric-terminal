# Long Book

Long-term desk: quantum-resistance (PQ signatures) and real buy-and-burn candidates. Bitcoin excluded.

Build: `python3 research/longbook/longbook.py` (cached; `--refresh` refetches, `--no-net` rebuilds from cache). Output `data/longbook.json` -> `/api/longbook` (frozen snapshot on Render; route merges live sentiment for NEAR/ZEC/CAKE). UI: Long Book tab (`public/longbook.js`), read-only, guest-safe. Claims are hand-curated in `candidates.json` with primary sources; review date in the file.

Sources (free only): CoinGecko /coins (market + tickers), DefiLlama /summary/fees (fees, revenue, holders revenue), defillama.com/unlocks via research/unlocks.py, Hyperliquid candleSnapshot (HYPE), Binance daily closes in data/flatbase_series. No Nansen, no paid X.

## Backtest (built 2026-10-19)

Rule chosen on train (weekly entries < 2023-01-01) from a 16-cell grid (X% below 200d SMA in 20/30/40/50, or drawdown from 1y high in 50/60/70/80, each with/without a quiet-volatility filter): **drawdown from 1y high >= 70%**.

- Train: 1y fwd median -51% vs all-weeks -55% (n=221 weekly entries, 9 episodes). Train covered mostly the 2021-22 bear, so every cell was negative.
- Test (2023+, candidates): +40% vs +9% (n=186, 13 episodes); 2y fwd median +101% vs +5%.
- Broad Binance universe (261 coins, survivor-biased), test: -38% vs -30% -> the rule did NOT generalize.
- Strength: **unproven (worked on these candidates 2023+, failed on the broad universe)**.

Trim levels (1.8x / 2.5x / 3.5x the 200d average) come from the euphoria study in the same file; 3.5x has too few cases to mean anything.

Caveats: Weekly entries overlap (52 per year share most of the same forward window): treat episodes, not weekly n, as the real sample size. Survivorship: delisted coins are missing, which flatters every strategy. Price only: no fees, slippage, taxes; cash earns 0%. Rule-only leaves cash idle when no drawdown comes (investedPct < 100%); in a straight bull run it lags DCA and lump sum (see ZEC). 2023+ test period is a single market cycle.
