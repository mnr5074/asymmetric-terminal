# Robinhood Chain utility scanner: PRIORS pre-breakout pattern

Generated 2026-10-18 14:09 UTC by `research/rhscan/rh_scan.py` (Oct 18 2026, 7:09 AM PT). Sources: GeckoTerminal API v2 and DexScreener, both free; {'gt': 0, 'ds': 1, 'cache': 146} API calls on the final (warm-cache) run, about 130 GeckoTerminal calls cold.

**Strength: WEAK.** 55 triggers; 29.1% hit 2x before -30% vs baseline 19.4% (n=2018); survivor-biased universe.

## The reference: PRIORS (0xedbf…90be)

Launched Sep 19 2026 (graduated from a launchpad), first peak ~0.0027 on Sep 25, slid ~50-58% into a 2-day quiet base on Sep 26-27 (volume fell to 30-45% of its busiest 2 days), then volume returned (2.7x the base average) on the Sep 29 04:00 UTC bar as it closed through the old peak at 0.00342. Best high within 7 days: 0.0142 (4.1x from that trigger close, ~10x from the 0.00134 base). On 4h bars the volume did **not** come back while price sat 50-60% under the high; it came on the push through the old peak. The scanner's trigger is defined to match that, which means the rules were fitted to one example (n=1).

## Rules

| Rule | Definition |
|---|---|
| pullback | base bar 45-70% below the highest 4h close so far (best 50-60%) |
| quiet | 12 bars (2 days) ending at the base bar close inside a <=2.1x range; their avg volume <=50% of the busiest 2-day stretch |
| volRising | within 6 days of the base: last 3 bars avg volume >=1.5x the base average and a close above the base high (and no more than 1.5x the old peak close: PRIORS volume arrived as it broke its old peak) |
| age | >=3 days of history |
| cleanContract | GeckoTerminal: not honeypot, top-10 <=50%, dev <=10%, data present |
| utility | website + product description (keyword evidence; confirm manually) |

Plan (mechanical, from each token's own levels): entry only on the trigger and no more than 15% above the base high; size = 0.5% portfolio risk to the walk-away, capped at 1% of portfolio and 1% of pool liquidity; sell 1/3 at the nearer of (prior peak close, 2x entry), 1/3 at the farther, trail the last 1/3 with a 35% stop from the highest close; walk away on a 4h close below max(base low, entry -30%), no +30% in 7 days, liquidity -40%, top-10 >50% or a honeypot flag.

## Replay (price/volume rules only)

Universe: 291 pools → 185 tokens; 101 with ≥$20,000 liquidity today; 52 with ≥3 days of 4h bars.

| | n | tokens | 2x before -30% | -30% first | median best 7d | median 7d end |
|---|---|---|---|---|---|---|
| Pattern triggers | 55 | 22 | 16 (29.1%) | 18 (32.7%) | 1.78x | 1.09x |
| Triggers excluding PRIORS | 52 | 21 | 15 (28.8%) | 16 | | |
| Baseline (1 entry/day, same tokens, day 3+) | 2018 | 47 | 392 (19.4%) | 349 (17.3%) | 1.29x | 1.0x |

Read: triggers reach 2x more often than a random day (≈29% vs ≈19%), but they also hit -30% first more often (≈33% vs ≈17%). They are more volatile in both directions, not cleanly better. The median trigger ended 7 days roughly flat (1.09x). With n=55 on 22 tokens, rules tuned on PRIORS, and a survivor-only universe, this is **weak** evidence.

Caveats:

- Universe is today's survivors (pools still listed): dead tokens are missing, so results are biased upward.
- Chain history is only weeks long; liquidity at signal time is unknown (today's is used for the filter).
- Rules 4-5 (contract, utility) cannot be replayed historically; only price/volume rules 1-3 are tested.

## Current scan

| State | Token | Price | Liq | FDV | Why |
|---|---|---|---|---|---|
| Watch | CASHCAT `0x020bfc65…` | 0.1034 | $2,454K | $102.1M | base at 2026-10-18 12:00 UTC: pullback 65% from peak close (want 45-70%, best 50-60%); price is inside the base: waiting for the volume trigger |
| Watch | WALLET `0x0339f545…` | 0.02311 | $2,237K | $22.7M | base at 2026-10-18 00:00 UTC: pullback 70% from peak close (want 45-70%, best 50-60%); price is inside the base: waiting for the volume trigger |
| Watch | DELTA `0xe8ffd7e2…` | 0.01076 | $874K | $10.7M | base at 2026-10-18 12:00 UTC: pullback 64% from peak close (want 45-70%, best 50-60%); price is inside the base: waiting for the volume trigger |
| Watch | SCHIFFY `0x42afa212…` | 0.003644 | $498K | $3.6M | base at 2026-10-18 12:00 UTC: pullback 67% from peak close (want 45-70%, best 50-60%); price is inside the base: waiting for the volume trigger |
| Watch | VRAX `0x94641b97…` | 0.005478 | $315K | $5.5M | base at 2026-10-18 08:00 UTC: pullback 51% from peak close (want 45-70%, best 50-60%); price is inside the base: waiting for the volume trigger |
| Watch | SLIPPY `0xf0568863…` | 0.001506 | $175K | $1.5M | base at 2026-10-18 12:00 UTC: pullback 54% from peak close (want 45-70%, best 50-60%); price is inside the base: waiting for the volume trigger |
| Watch | GRIFT `0x9f4ba41f…` | 0.0006554 | $87K | $0.6M | base at 2026-10-16 16:00 UTC: pullback 49% from peak close (want 45-70%, best 50-60%); price is inside the base: waiting for the volume trigger |
| Watch | GOLD `0xa62f748f…` | 0.0004647 | $41K | $0.5M | base at 2026-10-16 08:00 UTC: pullback 52% from peak close (want 45-70%, best 50-60%); price is inside the base: waiting for the volume trigger |
| Extended | TORCH `0x000050e1…` | 0.005796 | $917K | $5.6M | base at 2026-10-15 08:00 UTC: pullback 49% from peak close (want 45-70%, best 50-60%); price is now 2.3x the base high: it left the base (no qualifying volume trigger inside the chase limit), no entry; wait for a new base |
| Extended | PRIORS (PRIORS (reference pattern)) `0xedbf9122…` | 0.01336 | $765K | $13.4M | base at 2026-10-15 00:00 UTC: pullback 45% from peak close (want 45-70%, best 50-60%); price is now 1.5x the base high: it left the base (no qualifying volume trigger inside the chase limit), no entry; wait for a new base |
| Extended | HYDX `0xaa5751ff…` | 0.002394 | $155K | $2.4M | base at 2026-10-17 20:00 UTC: pullback 46% from peak close (want 45-70%, best 50-60%); price is now 1.2x the base high: it left the base (no qualifying volume trigger inside the chase limit), no entry; wait for a new base |
| Extended | V4 `0xc60ba256…` | 0.005374 | $373K | $5.0M | base at 2026-10-17 08:00 UTC: pullback 46% from peak close (want 45-70%, best 50-60%); price is now 1.3x the base high: it left the base (no qualifying volume trigger inside the chase limit), no entry; wait for a new base |
| Broke base | WORM `0x3ba500f1…` | 0.0008921 | $140K | $0.8M | base at 2026-10-15 12:00 UTC: pullback 69% from peak close (want 45-70%, best 50-60%); price is now under the base low 0.00169213: base broken, pattern void |
| Broke base | VERDEX `0x96f455a9…` | 6.568e-05 | $38K | $0.1M | base at 2026-10-16 08:00 UTC: pullback 51% from peak close (want 45-70%, best 50-60%); price is now under the base low 0.000119038: base broken, pattern void |
| Broke base | AI `0x2e8c3116…` | 0.076 | $3,330K | $76.0M | base at 2026-10-16 08:00 UTC: pullback 69% from peak close (want 45-70%, best 50-60%); price is now under the base low 0.0838775: base broken, pattern void |
| Broke base | BONER `0x98096d17…` | 0.01284 | $1,492K | $12.8M | base at 2026-10-14 16:00 UTC: pullback 69% from peak close (want 45-70%, best 50-60%); price is now under the base low 0.0192994: base broken, pattern void |
| Broke base | HARMONIC `0xdee52f2a…` | 0.001437 | $146K | $1.3M | base at 2026-10-14 20:00 UTC: pullback 69% from peak close (want 45-70%, best 50-60%); price is now under the base low 0.00236394: base broken, pattern void |
| Broke base | SURPLUS `0xe1838f0d…` | 0.0002538 | $68K | $0.2M | base at 2026-10-17 08:00 UTC: pullback 67% from peak close (want 45-70%, best 50-60%); price is now under the base low 0.00030472: base broken, pattern void |
| Broke base | GIGATENEV `0xc9675fe6…` | 0.0004249 | $67K | $0.4M | base at 2026-10-17 04:00 UTC: pullback 70% from peak close (want 45-70%, best 50-60%); price is now under the base low 0.000484032: base broken, pattern void |
| Broke base | PONS `0x39dbed3a…` | 0.2712 | $2,764K | $182.9M | base at 2026-10-18 08:00 UTC: pullback 70% from peak close (want 45-70%, best 50-60%); price is now under the base low 0.274306: base broken, pattern void |
| Broke base | ORBIO `0xaa07a0e9…` | 0.02137 | $505K | $20.4M | base at 2026-10-14 08:00 UTC: pullback 66% from peak close (want 45-70%, best 50-60%); price is now under the base low 0.0296657: base broken, pattern void |
| Fails | TIBBIR `0x4db7374e…` | 0.2238 | $837K | $223.8M | base at 2026-10-16 08:00 UTC: pullback 50% from peak close (want 45-70%, best 50-60%); price is inside the base: waiting for the volume trigger |
| Fails | VOLT `0x5d102d1e…` | 0.01243 | $339K | $3.7M | base at 2026-10-18 12:00 UTC: pullback 56% from peak close (want 45-70%, best 50-60%); price is inside the base: waiting for the volume trigger |
| Fails | LM `0xa5c8cc9f…` | 4.582e-05 | $22K | $0.0M | base at 2026-10-18 08:00 UTC: pullback 70% from peak close (want 45-70%, best 50-60%); price is inside the base: waiting for the volume trigger |
| Fails | INCOME `0x6a08b947…` | 6.288e-05 | $21K | $0.0M | base at 2026-10-18 12:00 UTC: pullback 47% from peak close (want 45-70%, best 50-60%); price is inside the base: waiting for the volume trigger |
| Fails | HOOKR (HOOKR (Hookr.fun)) `0x18e67423…` | 0.02557 | $1,163K | $25.4M | now: pullback 22% from peak close (want 45-70%, best 50-60%); quiet stretch: closes in a 1.20x range (want <=2.1x), volume 18% of its busiest 2 days (want <=50%) |
| Fails | INU (iNu) `0x63ee32ac…` | 0.001617 | $513K | $1.6M | now: pullback 90% from peak close (want 45-70%, best 50-60%); quiet stretch: closes in a 1.19x range (want <=2.1x), volume 3% of its busiest 2 days (want <=50%) |
| Fails | SEED `0x6adb9cd4…` | 7.148e-05 | $55K | $0.1M | now: pullback 64% from peak close (want 45-70%, best 50-60%); quiet stretch: closes in a 1.84x range (want <=2.1x), volume 81% of its busiest 2 days (want <=50%) |
| Fails | ZERO `0x316fa3ab…` | 0.0008057 | $49K | $0.8M | now: pullback 59% from peak close (want 45-70%, best 50-60%); quiet stretch: closes in a 2.95x range (want <=2.1x), volume 8% of its busiest 2 days (want <=50%) |

**Bottom line (Oct 18 2026):** no token is at Trigger or Setup. The 4 utility tokens that formed a base (TORCH, PRIORS, HYDX, plus V4 with no description) already left it without the volume trigger (Extended), and WORM and VERDEX broke below their bases. The 8 Watch names have a base intact but show no utility evidence; their plans are monitor-only.

**iNu** (0x63ee…1e18): 90% below its peak close, deeper than the pattern, so no entry under it. **HOOKR** (Hookr.fun, 0x18e6…ff5c): only 22% below its peak close. It would qualify only after a 50-60% pullback and a new base. A same-ticker copy, "Hookr" 0x98e6…ff5c (created Oct 17, ~$10.8M quoted liquidity, ~$5 volume), is excluded as likely fake liquidity.

Utility checks use the GeckoTerminal description and website only (no site visits); manual overrides are listed in `UTIL_MANUAL` in the script. Contract checks come from GeckoTerminal's honeypot, holder and dev fields only; no bytecode audit. Not financial advice; no auto-trading.
