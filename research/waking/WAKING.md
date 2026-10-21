# Waking Up scanner: revival signs before a breakout

Generated 2026-10-21 02:41 PT by `research/waking/waking.py` (data `data/waking.json`, panel at the top of the Breakouts tab, API `/api/waking`). Signal and test were fixed in `research/waking/PREDECLARED.md` (sha256 `5e97a4c2c40a761873f6b651dc4672451976c00c44500e0e69c35b350ac26dd2`) before any outcome was computed; one parameter set, no grid search.

**Verdict: no chain passed the out-of-sample test. Strength: unproven on all three pools. The panel ships as an EXPERIMENTAL watch list with NO phone alerts.**

## Signal (daily UTC bars)

- 21-day quiet stretch ending 4 days ago: median volume <= 35% of the busiest week before it, last close >= 40% below the high, closes inside <= 1.6x.
- Wake: >= 3 of the last 4 days with volume >= 1.5x the quiet median, and still >= 1.5x without the biggest day (not one spike).
- Higher low (lowest wake-day close above the base low) and close <= 1.10x the base top (not broken out).
- Volume floor (30-day avg): $5K Solana/Robinhood, $100K majors. One signal per token per 30 days.

Live-only context (shown, never scored, because free data cannot replay it): unique buyers 6h vs 24h pace, holders vs first flag, liquidity vs first flag, X mentions 24h vs prior 6 days. Safety vetoes (grade v2 F): top-10 > 60%, fake liquidity (quote side < 20%), honeypot, freeze authority.

## Backtest (30-day forward, daily closes; random = every other tradable token in the same pool on the same day)

| Pool | Period | n | tokens | 2x | -50% | 7d | 14d | 30d | random 2x | random -50% | random 30d | beats random |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| solana | earlier (split 2026-08-01) | 4 | 4 | 0.0% | 0.0% | -3.1% | -12.3% | -21.8% | 4.4% | 0.0% | -2.8% | no |
| solana | later (split 2026-08-01) | 9 | 9 | 0.0% | 0.0% | -4.6% | 10.5% | 18.6% | 12.8% | 2.3% | 17.9% | no |
| robinhood | earlier (split 2026-09-10) | 0 | 0 | | | | | | | | | no signals |
| robinhood | later (split 2026-09-10) | 0 | 0 | | | | | | | | | no signals |
| majors | earlier (split 2024-01-11) | 5105 | 377 | 4.5% | 1.9% | -0.2% | -0.7% | -2.3% | 4.7% | 1.8% | -2.7% | no |
| majors | later (split 2024-01-11) | 5153 | 523 | 4.4% | 1.8% | -2.1% | -2.9% | -4.8% | 3.9% | 1.9% | -4.5% | no |

- **solana**: 78 tokens, 2026-05-12 to 2026-09-20 (last complete forward window). Strength **unproven**: too few completed signals on the later period (n=9 on 9 tokens; need >= 30 on >= 15).
- **robinhood**: 35 tokens, 2026-08-13 to 2026-09-20 (last complete forward window). Strength **unproven**: too few completed signals on the later period (n=0 on 0 tokens; need >= 30 on >= 15).
- **majors**: 659 tokens, 2017-12-26 to 2026-09-20 (last complete forward window). Strength **unproven**: did not beat random on the later period: n 5153 on 523 tokens; net (2x% - drop%) 2.6 vs random 2.0; median 30d -4.8% vs random -4.5%.

## Earlier / cheaper than the breakout Trigger

- solana earlier: 25.0% of signals later broke out (daily Trigger analogue: close above the base top on 3-day volume >= 1.5x), median 3.0 days earlier and 20.9% cheaper than the breakout close. On those events the 30-day median was -29.1% from the flag vs -41.6% from the breakout (hindsight-conditional: you only know it broke out afterwards).
- solana later: 100.0% of signals later broke out (daily Trigger analogue: close above the base top on 3-day volume >= 1.5x), median 2.0 days earlier and 3.5% cheaper than the breakout close. On those events the 30-day median was 18.6% from the flag vs 1.6% from the breakout (hindsight-conditional: you only know it broke out afterwards).
- majors earlier: 68.1% of signals later broke out (daily Trigger analogue: close above the base top on 3-day volume >= 1.5x), median 2.0 days earlier and 6.1% cheaper than the breakout close. On those events the 30-day median was 7.6% from the flag vs -2.3% from the breakout (hindsight-conditional: you only know it broke out afterwards).
- majors later: 62.3% of signals later broke out (daily Trigger analogue: close above the base top on 3-day volume >= 1.5x), median 1.0 days earlier and 4.9% cheaper than the breakout close. On those events the 30-day median was 5.3% from the flag vs -4.5% from the breakout (hindsight-conditional: you only know it broke out afterwards).
- Robinhood: 0 Waking signals vs 79 real 4h Trigger replays (research/rhscan); none to compare.

## Why Coiled failed and what was done differently

Coiled (research/rhscan/coiled.py) graded a 9-cell grid on 4h bars of ~50 Robinhood tokens with weeks of history: no cell reached n >= 15 on the earlier split, and its 2%-under-the-base stop was hit first 87% of the time. Waking Up uses one pre-declared cell (no selection), daily bars on three pools (659 Binance coins since 2017, ~230 Solana tokens incl. dead launchpad coins, ~130 Robinhood tokens), a matched same-day random control, and a walk-away at max(0.97 x base low, -35%) instead of a 2% stop. It still did not beat random: on majors n is large and the edge is ~0; on Solana and Robinhood the free history (GeckoTerminal public API: 180 days; Robinhood Chain: since Aug 2026) is too short for enough signals.

## Current state (2026-10-21 02:41 PT)

- Solana / Robinhood flagged in the last 14 days: none.
- Closest on Solana / Robinhood (5-6 of 7 conditions, not flagged): SPX solana 6/7 missing volume up 3 of 4 days; GLD robinhood 6/7 missing volume up 3 of 4 days; BIRB solana 6/7 missing higher low; RAM robinhood 6/7 missing flat base (<=1.6x); AMC robinhood 6/7 missing 40%+ down; DTF robinhood 6/7 missing higher low; MEW solana 5/7 missing volume up 3 of 4 days, higher low; MPLX solana 5/7 missing 40%+ down, volume up 3 of 4 days.
- Majors flagged (39): REQ cheaper than flag -6.5%, SOLV cheaper than flag -2.4%, CTSI cheaper than flag -1.0%, STX cheaper than flag -15.3%, IQ cheaper than flag -5.2%, CHIP cheaper than flag -21.3%, STRAX cheaper than flag -3.4%, CTK cheaper than flag -7.2%, ROSE cheaper than flag -10.0%, ERA cheaper than flag -6.5%, AT cheaper than flag -6.2%, GLM cheaper than flag -10.5%, ID cheaper than flag -11.6%, LAZIO cheaper than flag -0.2%, ACM cheaper than flag -6.1%….
- **CYPHERCAT (CypherCat)** `6AUURRdHb9TrfPHv9AMofa8NEVoZDXcsbWKcUBpFSRXs`: not scored: only 34 days of daily history (the signal needs >= 45 days before the wake window + the current day excluded); USD rebuilt from quote-denominated candles x quote-token USD (non-SOL/USDC quote); GeckoTerminal USD candles disagree with that by up to 37% over the last 10 days
- **QCAT (dead rug)** `EosbW31T1WAQSiHUErogcaNHd8FBZDbjPPgQMJzXARNV`: not scored: only 12 days of daily history (the signal needs >= 45 days before the wake window + the current day excluded); USD rebuilt from quote-denominated candles x quote-token USD (non-SOL/USDC quote)
- **RAM (Ramses)** `0x5173d45a1191ee33cbb7d8c7e65f21b04ed54802`: scanned, not waking (6/7; missing: flat)

## Stale USD guard (CYPHERCAT)

GeckoTerminal's USD price for pools quoted in something other than SOL/USDC/USDT can lag or sit flat (CYPHERCAT/CYPH: GT ~$0.00065 vs DexScreener ~$0.00088 and Jupiter ~$0.00084 on Oct 21). For every such Solana pool the scanner rebuilds USD from the quote-denominated candles x the quote token's own USD close, excludes the token if that is impossible, and takes DexScreener (then Jupiter) as the live "now" price, warning when the series differs by > 25%. 142 pools were rebuilt this run.

## Caveats

- Universes are today's survivors (listed pools / Binance pairs incl. halted ones): dead tokens are under-represented, so DEX results are biased upward.
- Liquidity at signal time is unknown for DEX pools; a 30-day average volume floor is used instead.
- Buyers, holders, liquidity-added, X mentions and smart money cannot be replayed with free data: they are shown as live context only and never scored.
- Daily closes only (Binance series has no intraday highs), so 2x / -50% are close-to-close.

Not financial advice. No auto-trading.