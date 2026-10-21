# Waking Up: pre-declared signal and test (written 2026-10-21 1:53 AM PT, BEFORE any outcome was computed)

One definition, one parameter set. No grid search, no tuning on outcomes (the Coiled tier failed partly because a 9-cell
grid on a tiny 4h sample left every cell with n < 15). If these numbers change after results are seen, that must be
written below as a NEW, separately labelled post-hoc variant, never as the main result.

## Data (daily UTC bars, close + USD volume; days without trades are filled with the previous close and volume 0)
- majors: every Binance spot USDT pair in data/flatbase_series (multi-year, includes halted 'BREAK' pairs).
- solana: GeckoTerminal daily OHLCV of the deepest pool for each base token on GT Solana pool pages 1-10 (default sort),
  pages 1-5 sorted by 24h volume, trending pages 1-3, plus named tokens (QCAT). Today's survivors only (bias up).
- robinhood: the Robinhood Chain scanner's GeckoTerminal 4h bars (research/rhscan/cache) summed to UTC days, + RAM.
- The current (incomplete) UTC day is never used in the backtest.

## Signal on day i (uses bars <= i only)
- history: >= 45 daily bars before day i.
- Q (quiet stretch) = the 21 days i-24..i-4; W (wake window) = the 4 days i-3..i. qbase = median Q volume (mean if the median is 0; no signal if both are 0).
- dead: qbase <= 35% of the highest 7-day average volume in all history before Q.
- down: last Q close >= 40% below the highest close up to day i-4.
- flat: Q closes inside a <= 1.6x range (max/min).
- volume rising for several days, not one spike: >= 3 of the 4 W days have volume >= 1.5x qbase, AND the W volume
  without its single biggest day still averages >= 1.5x qbase.
- higher low: the lowest W close is above the lowest Q close.
- not broken out yet: close on day i <= 1.10x the highest Q close (the base top).
- tradable (applied identically to signals and to random): 30-day average daily volume up to day i >= $5,000 (solana,
  robinhood) / $100,000 (majors).
- dedupe: one signal per token per 30 days.

## Outcomes (entry = close of day i; only complete 30-day forward windows count)
- hit2x: any close within 30 days >= 2x entry. drop50: any close within 30 days <= 0.5x entry. Also which came first.
- median return at 7 / 14 / 30 days (close).
- plan walk-away first: a daily close <= max(0.97 x lowest Q close, 0.65 x entry) before any 2x.
- breakout comparison: first day j in (i, i+30] with close > base top AND 3-day avg volume >= 1.5x the Q average volume
  (the daily analogue of the Robinhood Trigger). Report share of signals that later broke out, median days earlier,
  and median % cheaper (breakout close / signal close - 1). For Robinhood also match the scanner's real 4h Trigger events.

## Controls (same pool, same dates)
- random: every other tradable token (history >= 45 days, same volume floor) on the same day as each signal, with a complete
  forward window; rates averaged per signal date, then across signals.
- quiet-not-waking: tokens on the same dates that pass dead + down + flat but not the wake conditions (reported only).

## Periods
- Per pool, split at the median day of the tradable random token-day sample. earlier < split <= later.

## Decision (per pool)
- Beats random on a period = n >= 30 signals on >= 15 tokens AND (hit2x% - drop50%) >= random's + 5 points AND
  median 30-day return > random's median 30-day return.
- backtested = beats random on BOTH periods; weak = beats random on the later period only; unproven = anything else
  (too few signals, or did not beat random on the later period).
- Phone alerts (ntfy, deduped, quiet hours 11 PM-7 AM PT queued to 7 AM) only for pools labelled backtested or weak.
  Otherwise the panel ships as an informational, experimental watch list with NO alerts.

## Live-only context signs (cannot be replayed with free data, so they are shown but never scored)
buys / unique buyers rising (GeckoTerminal pool transactions h6 vs h24), holder count vs our own earlier snapshot,
pool liquidity now vs at first flag (added vs pulled), X mentions last 24h vs the prior 6-day hourly baseline
(sentiment collector, free X reads), Nansen smart-money first buys (optional, only if a lookup costs < 20 credits).
Safety (grade v2 F vetoes): top-10 holders > 60%, fake liquidity (quote side), honeypot; F cards are marked invalidated.
