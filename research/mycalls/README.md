# Martin's Calls

Owner-only tracker (⋯ menu → Martin's Calls; guests get 403 on `/api/mycalls` and `/mycalls.js`) that scores Martin's own gut calls
honestly, so the question "is my gut any good?" gets evidence instead of memory.

- **Calls**: `data/martin_calls.json`, added with `python3 scripts/log_call.py add --symbol … --chain solana|robinhood --contract … --call "his words" --time "2026-10-21 01:46" [--gibi "stay out" --gibi-why … --gibi-trigger 0.001 --gibi-trigger-tf 4h --gibi-walkaway 0.0016] [--note …]`.
  `list`, `remove --id`, `score` also exist. Times are Pacific.
- **Price at call** is never invented: `reported` (quoted at the time, `--price` + `--quote SRC=PRICE`), `live` (DexScreener at logging time, call within 15 min),
  or `backfill` (nearest hourly candle close, labelled BACKFILLED). An hourly candle close nearest the call is stored as a cross-check either way.
- **Scores** (`research/mycalls/score.py` → `data/martin_calls_scored.json`): 1d / 7d / 30d return, max gain / drawdown, 2x?, −50%? on hourly closes after
  the call; the chain's median token over the same window (Waking Up backtest pool, tradable tokens, daily closes) and where the call ranks; Gibi's verdict
  scored on the same call (stay out = 0% unless Gibi's own trigger fired; then entry at that close, exit at walk-away or horizon end). Unfinished windows
  show "so far" and never count.
- **Scorecard**: hit rate = 7d return beat the chain median; "too few calls to judge" until 20 calls have a 7d score; then a sign test vs the chain median
  labels it backtested (p < 0.05, median excess > 0) / unproven / weak (median excess ≤ 0).
- **Gut bet rule** (display only): 0.25% of portfolio per call until the scorecard shows an edge. Nothing trades.
- **Data**: free GeckoTerminal hourly candles + DexScreener, cached in `research/mycalls/cache/` (gitignored). Pools quoted in a tokenized stock or any
  non-SOL/USDC/USDT/WETH/USDG token are rebuilt in USD as quote-denominated candles × the quote token's USD close (the research/waking bad-USD guard).
  Re-scored after each Robinhood 4h scan and each Waking Up scan; calls whose 30d window is done are frozen. On Render (RENDER_LITE) the frozen
  snapshot is served and "Now" still comes live from `/api/liveprice`.
- Note: the repo is public, so the logged calls in `data/martin_calls.json` are readable on GitHub even though the site hides them from guests.
