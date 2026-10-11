# Birth-phase (pre-launch) fingerprint library

Goal: judge a launch while it is still on its bonding curve / in presale by comparing its arc so far with the
birth phases of past launches on every supported pad, both winners and failures.

Pipeline (free sources only; no Nansen, no X; Helius only if HELIUS_API_KEY is already set):

| step | script | source |
|---|---|---|
| unbiased random pump.fun launches | `random_pump_hist.py` | Solana RPC: signatures of the pump mint-authority PDA (only create txs touch it) at ~100 past anchor times |
| unbiased random pump.fun graduations | `random_pump_grads.py` | Solana RPC: signatures of the pump migration signer 39azUY… (Migrate logs) |
| pump.fun birth phase | `collect_pump.py` | pump.fun coins-v2 + swap-api trades (time cursor) + GeckoTerminal OHLCV |
| other Solana pads | `collect_solpads.py` | GT pools/OHLCV + RPC getSignaturesForAddress/getTransaction on the curve pool |
| EVM pads (Robinhood, Base, BSC) | `collect_evm.py` | GT pools/OHLCV + public RPC Transfer logs (BSC: candles only, archive logs need a key) |
| wallet ages | `wallet_ages.py` | RPC signatures of each early buyer (2 pages cap) |
| library | `build_library.py` | -> `data/birthphase/<launchpad>.jsonl` (schema: `data/birthphase/schema.json`), `coverage.json` |
| model + backtest | `match.py` then `backtest_pump.py` (pump.fun-only, population-weighted precision/recall; adds model.backtest.pump_only) | -> `data/birthphase/model.json` |
| alert calibration | `calibrate_launch.py` (pump.fun out-of-sample, population-weighted isotonic map raw p -> real odds + lift; used by `lib/alerts.js` launch picks) | -> `data/birthphase/launch_calibration.json` |
| live matcher | `live_poll.py` | -> `data/birthphase/live.json` (served by `lib/birthphase.js`, panel `public/birthphase.js`) |

Other workers (e.g. the Virtuals birth-phase library) can drop `data/birthphase/<pad>.jsonl` in the same schema; it is
picked up for repeat-early-buyer sets and, if records carry `ext.snap`, for matching.
