# Pattern Lab — EXPANSION (rules 38+, categories A–J)

This adds to the Pattern Lab (patterns 1–37, `PATTERN_LAB.md`, `lib/patternlab.js`). Everything here lives in separate files:

| file | role |
|---|---|
| `research/patternlab_ext/extcommon.py` | datasets (core50 / full / events_labeled), two-direction stats (`stats2`), row schema, guarded Nansen wrapper (own ledger + soft cap) |
| `research/patternlab_ext/tapes.py` | cache-only access to the Nansen launch tapes, bar helpers |
| `research/patternlab_ext/fetch_tape.py` | fetches Nansen `tgm/dex-trades` tapes (same request body as `pl_fetch_nansen.py`, so both workers share one cache entry) |
| `research/patternlab_ext/rules_38_42.py` | rules 38–42 → `data/patternlab_ext_38_42.json` |
| `research/patternlab_ext/fairvalue_majors.py` | rule 40 for majors (DefiLlama mcap/TVL + fees vs category, 90-day-back test) → `data/patternlab_ext_fairvalue.json` |
| `research/patternlab_ext/cats_gen.py` | categories A–J + self-generated rules 43–60 → `data/patternlab_ext_aj.json`, `data/patternlab_ext_gen.json` |
| `research/patternlab_ext/build.py` | merge + Benjamini–Hochberg q + robustness flag → `data/patternlab_ext.json` |
| `research/patternlab_ext/gen_md.py` | regenerates the results table below |
| `research/patternlab_ext/run.sh` | whole pipeline (`--fetch` also fetches missing tapes) |
| `lib/patternlab_ext.js` | `GET /api/patternlab/ext` (`?full=1` for the raw backtest, `?id=44` for one row) + live flags from the live feed |
| `public/patternlab_ext.js` | adds the expansion rows under the Pattern Lab table (same columns: status, crashed, runners, p crash, p pump, lead, verdict, live) |

Additive edits to shared files: 2 lines in `server.js` (after the Pattern Lab route) and 1 `<script>` tag in `public/index.html`.

## Row schema (`patternlab-ext-v1`)

```
{ id, name, status: built|wrapped|partial|not-feasible, status_why, explain (plain English), wraps: [module names],
  primary_set: core50|full, hit_crashed, hit_runners, p_fisher (two-sided), q_bh, verdict,
  p_crash_one_sided, p_pump_one_sided, crash_lead_h, pump_lead_h, false_flag_rate_crash, false_flag_rate_pump,
  era_matched {n/flags/p}, robust (bool), live_flags: [{symbol,key,why}], n_live_flags,
  backtest: { core50: stats2|null, full: stats2|null }, extra: {...} }
stats2 = { n_crashed, n_runners, flag_crashed, flag_runners, hit_crashed, hit_runners, p_fisher, verdict, separates,
           crash: {hit_rate, false_flag_rate, precision, p_one_sided, lead_h_median, lead_h_all},
           pump:  {hit_rate, false_flag_rate, precision, p_one_sided, lead_h_median, lead_h_all, lead_vs_breakout_h_median},
           + Pattern Lab aliases: p_crash_one_sided, p_pump_one_sided, lead_crash_h_median, lead_pump_h_median (vs breakout),
             false_flag_rate_as_crash_signal, false_flag_rate_as_pump_signal }
```
The `live` column in the table below counts static flags only; `/api/patternlab/ext` adds feed-based live flags (38 in/out-of-window movers, 41, 47, 56, G1) when it's called. The API also attaches `pl: {status, backtest: {crashed:"a/n", runners:"c/m", p_crash, p_pump, lead_crash_h, lead_pump_h, verdict, false_flag_crash, false_flag_pump}, live: {count, items:[{sym,key,value}]}}`, which is the Pattern Lab `table()` row shape.

## Datasets and conventions

* **core50**: the shared test set (30 crashed + 20 runners, `data/patterns_flows.json`). Nansen launch tapes are cached for all 50.
* **full**: every research-DB token with cohort `died` (111) or `mooned` (62), with GeckoTerminal hourly OHLCV (162/173).
* **events_labeled**: `data/events_labeled.json` from the backtest worker. It did not exist at build time. `extcommon.labeled()` loads it once it appears, but no scorer reads it yet.
* **Both directions** are scored for every rule. Crash = Fisher one-sided crashed > runners, with lead = hours from the flag to the dump (crash break, or the first hourly close ≤ 70% of peak). Pump = Fisher one-sided runners > crashed, with lead = hours from the flag to the peak. The lead against the Pattern Lab "breakout" (created + hours_to_2x) is also stored.
* **Early-life window (age-matched).** Tape rules use the first 300 Nansen-indexed DEX trades. Hourly rules use the first 48 bars. Token-level flags never look ahead: each feature only uses data up to `flag_t`.
* **False-flag rate**: for a crash signal, the share of runners it flags. For a pump signal, the share of crashed tokens it flags.

### Caveats (please read before using any number)
1. **Lifespan confound.** The crashed core tokens lived 2–18 hours, while runners have weeks of history. Rules that need multi-week history (38 token-level, 39) can't be tested on crashed tokens; those rows are marked untestable/partial.
2. **Nansen indexes pump.fun tokens from DEX migration, not from the bonding curve.** For most crashed tokens the curve peak comes *before* the first indexed trade (19/30 have zero pre-peak indexed trades). So the "early tape" of a crashed token sits at or after its peak. Crash leads are short or negative by construction, and the tape rules work as "at migration" classifiers, not as pre-peak early warnings for crashes.
3. **Era/batch confound.** 15 of the 30 crashed core tokens come from one 3-hour launch batch on 2026-10-10. Every tape row therefore carries an **era-matched** re-test (tokens created ≥ 2026-09-09: 14 crashed vs 11 runners). A1, 46 and 51 lose significance there; 44, 47 and 54 keep it.
4. **Leakage found and fixed.** "No socials", "no website" and "DEX boosts" looked hugely predictive (p<1e-6) until they were made time-aware. Runners add DexScreener profiles and buy boosts *after* they pump. With `profile_delay_h` / `first_boost_delay_h` honoured (state 1 h after creation) all three show **no separation**.
5. The top-holder overlap in rule 42 (full set) uses a holder snapshot taken after the crash, so it's post-hoc only.
6. **Multiple testing.** About 35 tests were run. Use `q_bh` and the ★ robust flag (q < 0.10 and era-matched p < 0.10 where an era test exists).
7. Rule 40 on memecoins is a proxy (mcap ÷ cumulative traded volume vs age-matched peers). Crashed tokens get flagged "cheap" *at* the dump (median crash lead 0 h), so it's coincident, not an early warning. On the pump side, "rich vs peers" is momentum: it flags runners about 84 h before the peak. That's the **opposite** of the mean-reversion hypothesis.

## Findings in short
* **38 active-window filter: no improvement.** Across 263 dump alerts and 614 pump alerts in the full catalog, precision inside a token's own active window (dump 0.56, pump 0.66) is not better than outside it (0.60 / 0.66). The filter would remove about 59% of false alerts but also about 62% of true ones. Not recommended as a discount, though it's kept as live context.
* **39 vol compression: no expansion edge.** On memecoin hourly bars, 74% of compressed bars led to a ≥30% move vs a 70% base rate (p=0.33). On 246 majors (daily), compression was followed by *fewer* big moves (49% vs 54%), which fits volatility clustering. When memecoin compressions did break, 84% broke upward. The catalyst-conditioned version is live-only.
* **40 majors (DefiLlama):** mcap/TVL ≥3x the category median 90 days ago → underperformed the cross-section 11/18 vs 26/57 for the rest (one-sided p=0.19, weak); "cheap" ≤1/3 did not outperform (4/16). Live rich/cheap lists from 152 protocols are in the row's live flags.
* **41 stealth accumulation → pump** (full: 9/61 runners vs 1/63 crashed, p=0.007, lead about 80 h). Precise but rare.
* **42 wallet rotation → crash, weak on tapes** (core50 15/30 vs 6/20, p=0.13 two-sided; era-matched 12/14 vs 6/11, p=0.18). The holder-overlap version is strong (p<0.001) but post-hoc. The tapes do show concrete closed loops, e.g. Memecoin/AD/PAIR/Meta sharing 16 wallets.
* **Self-generated rules that hold up:** 47 (≥2 smart-money/KOL/high-balance wallets in the early tape → **pump**, 11/20 vs 2/30, holds era-matched). 44 (block-0 snipers ≥20% of early buy volume → **pump**, an inversion of the usual sniper-dump story; holds era-matched). 54 (pump.fun Mayhem-mode trading in the early tape → **crash**, 23/30 vs 0/20, holds era-matched; but it is a new pump.fun mode, so it's also a regime marker). G1 theme crowding (≥3 same-theme launches in the prior 24 h → crash, full p=0.003). 56 repeat deployer → crash (full, one-sided p=0.046). F2 (wrapped patterns detector 3): CEX-linked flows before the peak → **pump**, not crash.
* **No separation:** contract admin powers (D1–D3; pump.fun tokens are uniform), behavioural fingerprints (E1), sandwich density (H1), deployer early sells (43), wash round-trips (49), bot-dominated tapes (50).

## Not feasible with free data + Nansen (and why)
C1 staking flows (memecoins don't stake; no labelled majors event set; Nansen proposal about 40–100 credits). D4 compiler/CREATE2 (no per-token compiler data on pump.fun SPL). E-KYC clustering (not possible from public data; behavioural fingerprinting E1 and funder clustering, Pattern Lab #33/#36, are used instead). F dark pools (no public crypto dark-pool data). G3 diffusion speed (needs paid X timelines). H3 reorgs/sequencer/gas griefing (no token-level variance on Solana). I2 audits/slither/mythril/formal verification (no audited or verified-source test tokens). J2 NFT crossover, J3 referral launches (no free structured feed).

## Nansen
Own ledger: `data/patternlab_ext_nansen_ledger.json` (balance before/after per call, soft cap 200, floor 300, refuses ≥100-credit or unpriced endpoints). Every request first checks `data/nansen_cache.json` and the Pattern Lab cache `data/patternlab_cache/nansen/`, and writes results back to both caches so the two workers never pay twice. **This job used 5 credits** (5 × `tgm/dex-trades` tapes). The other 45 tapes were fetched by the Pattern Lab worker in parallel and reused from the shared cache.
Proposals (not run): `tgm/who-bought-sold` on airdrop claim days (A2, about 1 credit per token); LST/restaking flows for 20 majors (C1, about 40–100 credits); `profiler/address/related-wallets` for core50 deployers (E, 50 credits).

## Results (auto-generated)
<!-- AUTO:START -->
| id | rule | status | set | crashed hit | runner hit | p crash (1-s) | p pump (1-s) | BH q | crash lead | pump lead | false-flag (as crash / as pump) | era-matched p | other set | live |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 38 | Per-token active-window filter | built | full | 1/3 (33%) | 18/58 (31%) | 0.681 | 0.773 | 1.000 | -52h | 143.5h | 31% / 33% | – | core50: 0/0 vs 6/19, p=– (untestable) | 0 |
| 39 | Vol compression before catalyst | partial | – | – | – | – | – | – | – | – | – | – | full: 0/0 vs 16/22, p=– (untestable) | 0 |
| 40 | Rich vs peers (mcap / cumulative volume) → mean reversion ★ | partial | full | 13/95 (14%) | 51/52 (98%) | 1.000 | <.001 | <.001 | 0h | 84h | 98% / 14% | – | – | 25 |
| 40b | Cheap vs peers (mcap / cumulative volume <= 1/3 peer median) ★ | partial | full | 88/95 (93%) | 23/52 (44%) | <.001 | 1.000 | <.001 | 0h | 69h | 44% / 93% | – | – | 27 |
| 41 | Stealth accumulation (no socials, rising on-chain activity) | built | core50 | 2/30 (7%) | 0/20 (0%) | 0.355 | 1.000 | 0.952 | 1.3h | – | 0% / 7% | – | full: 1/63 vs 9/61, p=0.008 (pump-predictive (p<0.05)) | 0 |
| 42 | Wallet rotation / closed loop (same wallets cycling 3-4 tokens) | built | core50 | 15/30 (50%) | 6/20 (30%) | 0.133 | 0.956 | 0.616 | 1h | 58.4h | 30% / 50% | 0.177 (12/14 vs 6/11) | full: 26/106 vs 3/62, p=0.001 (crash-predictive (p<0.05)) | 0 |
| A1 | Sybil buy bundle (>=5 wallets, same size +-5%, within 2 s) | built | core50 | 4/30 (13%) | 9/20 (45%) | 0.998 | 0.015 | 0.068 | 0.45h | 160.4h | 45% / 13% | 1.000 (4/14 vs 3/11) | – | 0 |
| A2 | Airdrop / points farming then dump | wrapped | – | – | – | – | – | – | – | – | – | – | – | 10 |
| B1 | Governance: whale votes / Snapshot / delegation changes | wrapped | – | – | – | – | – | – | – | – | – | – | – | 3 |
| C1 | Staking flows: large unstakes / LST & restaking outflows before dumps | not-feasible | – | – | – | – | – | – | – | – | – | – | – | 0 |
| D1 | Contract admin powers (mint/freeze/fee/hook/owner/proxy/hidden owner/selfdestruct/unverified) | wrapped | core50 | 0/30 (0%) | 0/20 (0%) | 1.000 | 1.000 | 1.000 | – | – | 0% / 0% | – | full: 9/111 vs 7/62, p=0.586 (no separation) | 0 |
| D2 | Mutable metadata (update authority kept) | wrapped | core50 | 0/30 (0%) | 0/20 (0%) | 1.000 | 1.000 | 1.000 | – | – | 0% / 0% | – | full: 0/111 vs 0/62, p=1.000 (no separation) | 0 |
| D3 | Mint or freeze authority not revoked (research DB) | built | core50 | 0/30 (0%) | 0/20 (0%) | 1.000 | 1.000 | 1.000 | – | – | 0% / 0% | – | full: 1/111 vs 4/62, p=0.056 (weak) | 0 |
| D4 | Compiler-version anomalies / CREATE2-vanity deployers | not-feasible | – | – | – | – | – | – | – | – | – | – | – | 0 |
| E1 | Behavioural fingerprint: same odd buy size reused by >=3 wallets | built | core50 | 17/30 (57%) | 12/20 (60%) | 0.700 | 0.524 | 1.000 | 0.7h | 367.4h | 60% / 57% | 0.116 (10/14 vs 4/11) | – | 0 |
| E2 | Funding-source clustering (first funder / related wallets) | wrapped | – | – | – | – | – | – | – | – | – | – | – | 0 |
| F1 | Block trade: single sell >= 10% of cumulative volume | built | core50 | 0/30 (0%) | 0/20 (0%) | 1.000 | 1.000 | 1.000 | – | – | 0% / 0% | 1.000 (0/14 vs 0/11) | – | 0 |
| F2 | CEX deposit flows before the peak (dev/top holders → CEX) ★ | wrapped | core50 | 1/30 (3%) | 10/20 (50%) | 1.000 | <.001 | 0.001 | – | – | 50% / 3% | – | – | 0 |
| F3 | Stablecoin mint/burn spikes | wrapped | – | – | – | – | – | – | – | – | – | – | – | 0 |
| F4 | OTC desk / market-maker flows | wrapped | – | – | – | – | – | – | – | – | – | – | – | 0 |
| F5 | Options flow: put/call ratio (Derive public data) | partial | – | – | – | – | – | – | – | – | – | – | – | 7 |
| G1 | Theme crowding: >=3 same-theme launches in the prior 24h | built | core50 | 4/13 (31%) | 0/4 (0%) | 0.300 | 1.000 | 0.952 | 2.15h | – | 0% / 31% | – | full: 17/48 vs 1/23, p=0.004 (crash-predictive (p<0.05)) | 20 |
| G2 | Sentiment velocity & divergence from price | wrapped | – | – | – | – | – | – | – | – | – | – | – | 6 |
| G3 | Influence propagation speed / diffusion | not-feasible | – | – | – | – | – | – | – | – | – | – | – | 0 |
| H1 | MEV sandwich density (same wallet buy→sell within 2 s around others) | built | core50 | 6/30 (20%) | 3/20 (15%) | 0.477 | 0.793 | 1.000 | 0.55h | 487.6h | 15% / 20% | 0.406 (5/14 vs 2/11) | – | 0 |
| H2 | Priority-fee / tip anomalies, block-inclusion timing | partial | – | – | – | – | – | – | – | – | – | – | – | 0 |
| H3 | Gas griefing, reorgs, L2 sequencer downtime | not-feasible | – | – | – | – | – | – | – | – | – | – | – | 0 |
| I1 | Code similarity to known rug/honeypot contracts | wrapped | – | – | – | – | – | – | – | – | – | – | – | 0 |
| I2 | Audit-firm reputation, symbolic execution (slither/mythril), formal verification | not-feasible | – | – | – | – | – | – | – | – | – | – | – | 0 |
| J1 | No website / docs 1h after creation (and website changes) | partial | core50 | 25/30 (83%) | 16/20 (80%) | 0.523 | 0.753 | 1.000 | 2.2h | 372h | 80% / 83% | – | full: 91/111 vs 50/62, p=0.840 (no separation) | 0 |
| J2 | NFT community crossover | not-feasible | – | – | – | – | – | – | – | – | – | – | – | 0 |
| J3 | Referral / points program launches attracting mercenary capital | not-feasible | – | – | – | – | – | – | – | – | – | – | – | 0 |
| 43 | Deployer sells in the early tape | built | core50 | 3/30 (10%) | 1/20 (5%) | 0.472 | 0.881 | 1.000 | 7.7h | 555.7h | 5% / 10% | 1.000 (1/14 vs 1/11) | – | 0 |
| 44 | Block-0 snipers: >=20% of early buy volume in the first 5 s ★ | built | core50 | 6/30 (20%) | 14/20 (70%) | 1.000 | <.001 | 0.005 | 0.45h | 135.8h | 70% / 20% | 0.042 (5/14 vs 9/11) | – | 0 |
| 45 | Flippers: >=40% of first 100 buyers sell within 10 min | built | core50 | 2/30 (7%) | 5/20 (25%) | 0.988 | 0.080 | 0.301 | -7.25h | 56.9h | 25% / 7% | 0.056 (1/14 vs 5/11) | – | 0 |
| 46 | Buyer concentration: top-5 wallets >=50% of early buy volume | built | core50 | 23/30 (77%) | 8/20 (40%) | 0.010 | 0.998 | 0.060 | 0.9h | 57.5h | 40% / 77% | 0.689 (7/14 vs 7/11) | – | 0 |
| 47 | Smart-money / KOL / high-balance wallets present early (>=2) ★ | built | core50 | 2/30 (7%) | 11/20 (55%) | 1.000 | <.001 | 0.001 | 0.9h | 147.9h | 55% / 7% | 0.081 (2/14 vs 6/11) | – | 0 |
| 48 | Sell ramp: sell share in last quarter >=55% and +15pp vs first quarter | built | core50 | 1/30 (3%) | 0/20 (0%) | 0.600 | 1.000 | 1.000 | 14.8h | – | 0% / 3% | 1.000 (1/14 vs 0/11) | – | 0 |
| 49 | Round-trip wash: wallets with >=3 buys and >=3 sells carry >=20% of volume | built | core50 | 5/30 (17%) | 1/20 (5%) | 0.217 | 0.963 | 0.838 | 0.4h | 487.6h | 5% / 17% | 0.105 (4/14 vs 0/11) | – | 0 |
| 50 | Bot-dominated tape: >=50% of trades by labelled trading bots | built | core50 | 17/30 (57%) | 10/20 (50%) | 0.431 | 0.774 | 1.000 | 1h | 324.65h | 50% / 57% | 0.677 (6/14 vs 3/11) | – | 0 |
| 51 | Serial deployers trading it (>=3 wallets labelled as other tokens' deployers) | built | core50 | 15/30 (50%) | 17/20 (85%) | 0.998 | 0.011 | 0.060 | 0.9h | 200.3h | 85% / 50% | 0.661 (10/14 vs 9/11) | – | 0 |
| 52 | Wallet velocity: >=150 distinct wallets in the first 30 min | built | core50 | 2/30 (7%) | 3/20 (15%) | 0.924 | 0.310 | 0.838 | 0.45h | 84h | 15% / 7% | 0.623 (2/14 vs 3/11) | – | 0 |
| 53 | Large median buy (>= $50) | built | core50 | 2/30 (7%) | 1/20 (5%) | 0.651 | 0.793 | 1.000 | 0.65h | 555.6h | 5% / 7% | 1.000 (2/14 vs 1/11) | – | 0 |
| 54 | Mayhem-mode program participation (>=10 trades) ★ | built | core50 | 23/30 (77%) | 0/20 (0%) | <.001 | 1.000 | <.001 | 0.9h | – | 0% / 77% | 0.008 (7/14 vs 0/11) | – | 0 |
| 55 | Activity collapse: trades in minutes 10-20 < 30% of minutes 0-10 | built | core50 | 9/30 (30%) | 2/20 (10%) | 0.090 | 0.983 | 0.448 | 6.1h | 519.9h | 10% / 30% | 1.000 (2/14 vs 1/11) | – | 0 |
| 56 | Repeat deployer: >=3 prior launches | built | core50 | 4/30 (13%) | 2/20 (10%) | 0.544 | 0.783 | 1.000 | 2.05h | 900.75h | 10% / 13% | – | full: 14/100 vs 2/51, p=0.091 (crash-predictive (p<0.05)) | 0 |
| 57 | No socials 1h after creation (no X, Telegram or website) | built | core50 | 23/30 (77%) | 16/20 (80%) | 0.731 | 0.533 | 1.000 | 3.1h | 372h | 80% / 77% | – | full: 81/111 vs 48/62, p=0.587 (no separation) | 0 |
| 58 | Fast bonding curve (<10 min to graduate) | built | core50 | 16/30 (53%) | 2/2 (100%) | 1.000 | 0.308 | 0.952 | 1.8h | 10.05h | 100% / 53% | – | full: 60/100 vs 7/7, p=0.044 (pump-predictive (p<0.05)) | 0 |
| 59 | Asia-hours launch (00-08 UTC) ★ | built | core50 | 3/30 (10%) | 10/20 (50%) | 1.000 | 0.002 | 0.013 | 16.2h | 227.7h | 50% / 10% | – | full: 19/111 vs 19/62, p=0.055 (pump-predictive (p<0.05)) | 0 |
| 60 | DEX boost paid within 1h of creation | built | core50 | 0/30 (0%) | 0/20 (0%) | 1.000 | 1.000 | 1.000 | – | – | 0% / 0% | – | full: 0/111 vs 0/62, p=1.000 (no separation) | 0 |

**Rule 38 event-level (every dump/pump alert bar in the full catalog):**

- dump alerts: {"tp_in": 58, "fp_in": 45, "tp_out": 96, "fp_out": 64, "precision_all": 0.586, "precision_in_window": 0.563, "precision_out_window": 0.6, "false_signals_removed_pct": 58.7, "true_signals_kept_pct": 37.7, "p_fisher_in_vs_out": 0.6085, "p_in_better_one_sided": 0.7648}
- pump alerts: {"tp_in": 165, "fp_in": 87, "tp_out": 238, "fp_out": 124, "precision_all": 0.656, "precision_in_window": 0.655, "precision_out_window": 0.657, "false_signals_removed_pct": 58.8, "true_signals_kept_pct": 40.9, "p_fisher_in_vs_out": 1.0, "p_in_better_one_sided": 0.5624}

**Rule 39 event studies:**

- memecoin hourly: {"c_exp": 50, "c_no": 18, "u_exp": 895, "u_no": 381, "c_up": 42, "c_dn": 8, "p_exp_given_compressed": 0.735, "p_exp_base": 0.701, "p_fisher": 0.589, "p_compressed_more_expansion": 0.3278, "def": "compressed = 24h realized vol at its 14-day low (6h steps); expansion = |max move| >= 30% within 72h"}
- majors daily: {"c_exp": 1088, "c_no": 1126, "u_exp": 21625, "u_no": 18482, "c_up": 565, "c_dn": 523, "p_exp_given_compressed": 0.491, "p_exp_base": 0.539, "p_fisher": 0.0, "p_compressed_more_expansion": 1.0, "def": "compressed = 7d realized vol <= min of prior 42 days; expansion = |max move| >= 20% within 14d; 246 CoinGecko majors, 365d"}

**Rule 40 majors (DefiLlama mcap/TVL vs category, 90d-back test):** {"n_live_protocols": 152, "n_backtest": 75, "median_fwd90d_pct": 33.1, "rich_underperformed": "11/18", "others_underperformed": "26/57", "p_rich_underperform_one_sided": 0.1907, "cheap_outperformed": "4/16", "others_outperformed": "34/59", "p_cheap_outperform_one_sided": 0.9959, "def": "mcap/TVL vs DefiLlama category median 90d ago (>=3x rich, <=1/3 cheap); outcome = 90d return vs cross-sectional median"}

**Rule 42 top closed loops (core50 tapes):** [{"tokens": ["Memecoin", "AD", "PAIR", "Meta"], "wallets": 16}, {"tokens": ["FACEBOOK", "pair", "pair", "SIRAT"], "wallets": 16}, {"tokens": ["AODF", "FPES", "NTDA", "FPES"], "wallets": 16}, {"tokens": ["solisland", "FRANKPQC", "MISTAKE"], "wallets": 12}, {"tokens": ["Memecoin", "MASK", "AD", "Meta"], "wallets": 8}]

**Nansen (this job):** {"credits_used": 5.0, "calls": 5, "balance_start": 1618.0, "balance_last": 1590.0, "cache_hits": 0, "refused": [], "soft_budget": 200, "floor": 300}

Generated 1791730477620 (ms epoch).
<!-- AUTO:END -->

## Live wiring (added 2026-10-11 PT)

Every rule now has a live path, a stated backtest-only reason, or a not-feasible reason. Nothing is silently skipped.

- **Live from the live feed** (re-evaluated on every request, lib/patternlab_ext.js `liveFlags`): 38, 41, 47 (live-feed `smart` feature), 56, 57, 59, 60, G1, and **40 / 40b memecoin version**. The 40/40b version is mcap per $ of cumulative volume vs age-matched live peers in the 0-1 h, 1-6 h and 6-24 h buckets, with at least 8 peers per bucket.
- **Live from trade tapes** (`tapeFlags`): A1, E1, F1, H1, 42 (closed loop across the tapes held), 43, 45, 46, 48, 49 and 53. Early-life rules 44, 52 and 55 run only when the tape reaches back to pool creation.
  - Input is `data/patternlab_ext_cache/live_tapes.json`. These are the last 300 or fewer GeckoTerminal swaps that lib/fakevolume.js already fetches in its 20-minute live scan of the top 40 live tokens, so there are **no extra API calls**.
  - Each flag states whether it was computed on a "launch tape" or on the "last N swaps".
  - GT tapes have no wallet labels. Rule 43 therefore fires only when the live record carries a deployer address.
- **Live from the build** (refreshed every 12 h from caches and free endpoints by `run.sh`, which never spends Nansen credits): 39 (compression + unlock/news catalyst), 40/40b majors (FDV/TVL), A2, B1, F5 and G2.
- **Backtest-only.** These need Nansen wallet labels on every trade, which would cost 1 credit per token per refresh. They were not run, per the credit budget.
  - 50 (bot-dominated tape) and 51 (serial deployers trading it).
  - 54 (Mayhem-mode participation): the label exists only in Nansen.
  - 58 (fast bonding curve <10 min): needs the pump.fun curve-start time. The live feed only sees graduated pools.
- **Wrapped (live elsewhere):** D1, D2, D3 and I1 (contractscan composite factor), E2 (patterns #2 / bridges), F2 (patterns #3 CEX flows), F3 (stables) and F4 (otcflow).
- **Not feasible** (reasons in each row's `status_why`): C1, D4, G3, H2 (partial), H3, I2, J2 and J3.
- **Composite:** a new adjustment `plabx` is added on live, screener and perp rows.
  - Only **robust** rules carry weight, and only when they matched a live-feed token by chain:address: 40b −3, 40 +2, 44 +2, 47 +2, 59 +1, capped at ±6.
  - Every other firing rule is shown as info (0).
  - The majors FDV/TVL version of 40/40b is info only, because its 90-day test was not significant (patternlab_ext_fairvalue.json).
- **Learning loop:** a signal-bus plug-in `plx` sends every rule that has a tested direction into the alert ranker and the false-positive log, as detectors `plx_<id>`. They get auto-labels at +1h/+24h/+7d, rolling lift and shadow-mode demotion like every other detector.
