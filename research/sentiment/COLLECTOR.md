# Social sentiment collector: spec

**What it does.** It collects X (Twitter) mention counts and sampled posts for the watchlist and the top composite tokens. The data feeds `lib/sentiment.js`, which computes four things: mention velocity, tone, a 0–100 oscillator, and divergence flags. The oscillator is also used as a small **contrarian** factor in the composite grade (`lib/composite.js`, weight 0.25).

**Where the data comes from.** Only the **free built-in X read tools**, in MCP namespace `x`:
- `get_posts_counts_recent`: 7 days of hourly counts per query.
- `search_posts_all`: up to 25 posts per call, used for the language sample.
- `search_news`: X news stories.

The paid X API (`X_BEARER_TOKEN`, `lib/xapi.js`) is **never** used and stays off until approved. The terminal server cannot call MCP tools, so collection runs as a job that the assistant executes.

Prices come from free public endpoints: Binance spot klines (`data-api.binance.vision`), then the Binance futures mirror (`www.binance.com/fapi`), then GeckoTerminal OHLCV, then CoinGecko `market_chart`.

## 1. Files

| File | Written by | Read by |
|---|---|---|
| `research/sentiment/queries.json` | humans | `research/sentiment.py plan` / `ingest` |
| `research/sentiment/lexicon_crypto.json` | humans | `research/sentiment.py` (scoring) |
| `research/sentiment/raw/<run>/plan.json` + `*.txt` | `plan` + the assistant | `ingest` |
| `data/sentiment_counts.json` | `ingest` | `lib/sentiment.js` |
| `data/sentiment_samples.json` | `ingest` | `lib/sentiment.js` |
| `data/sentiment_calls.json` | `ingest` (budget ledger) | `/api/sentiment` |
| `data/sentiment_history.json` | `research/sentiment/proxy_history.py` | `/api/sentiment`, composite text |
| `research/sentiment/vendor/` | `pip install --no-deps --target vendor vaderSentiment` (3.3.2) | scoring |

## 2. The hourly job (run by the assistant)

```
cd /workspace/sol-terminal
python3 research/sentiment.py plan                      # writes research/sentiment/raw/<UTC run id>/plan.json, prints the files due
# for each entry in plan.json["calls"]:
#   call x.<tool> with entry.arguments and write_to_file=true,
#   copy the result file to research/sentiment/raw/<run>/<entry.file>   (e.g. counts__ZEC.txt, samples__ZEC__24h.txt, news__NEAR.txt)
#   pace the calls at <= 25 per rolling minute (tool limit is 30/min, shared)
python3 research/sentiment.py ingest research/sentiment/raw/<run>
```

- **Raw files.** The raw `.txt` is the tool output exactly as written, including the "X reads left" footer, which `ingest` logs. Keep the last ~3 run folders and delete older ones.
- **Options.**
  - `plan --tiers P` collects only the priority tier.
  - `--max-calls N` caps the run (default 40).
  - `--samples all|auto|none` controls post sampling.
  - `--force` ignores cadence.
- **Rescoring.** After a lexicon change, `python3 research/sentiment.py score` rescores the stored posts.
- **Idempotent.** Post ids are deduplicated. Hourly buckets merge by start time: older history is kept, and a newer fetch replaces the overlapping hours.

## 3. Cadence and budget

The tool limits are 30 reads/min and 1000/day per user. That budget is **shared** with every other use. The plan only emits calls that are due:

| Tier | Tokens | Counts | 24h sample | Prior-6-day sample | News |
|---|---|---|---|---|---|
| P (priority watchlist) | NEAR, ZEC, STRK, QCAT | every 2 h | every 4 h | 1×/day | every 12 h (NEAR, ZEC, STRK) |
| W (watchlist + majors) | BTC, ETH, SOL, JUP, BONK, WIF, TROLL, PEPE, BRETT, CAKE, NOT | every 6 h | every 12 h | 1×/day | – |
| C (top composite perps) | MINA, FARTCOIN, JELLYJELLY, PNUT, ROBO, SWARMS, ZEREBRO, MOODENG, GOAT, CLANKER, CHILLGUY | every 6 h | every 12 h | 1×/day | – |

That works out to about 48+24+4+6 (P) + 88+44+22 (W+C) ≈ **236 reads/day**. The hourly wake usually makes 4–30 calls. Change `CADENCE_H` in `research/sentiment.py` to tune this.

**Adding a token:** append it to `queries.json` with a `sym`, a `tier`, `q`, and `price`. Add `key: "chain:address"` too if the token lives in the live feed. The composite matches live-feed rows **only** by `key`, because live-feed symbols collide.

## 4. Query list

The full list is in `queries.json`. Each query is `"<token clause> <suffix>"`.

**Counts suffix:**
`-is:retweet lang:en -giveaway -giveaways -airdrop -"free mint" -whitelist -presale -"dm me" -"join now" -"claim now" -"claim your"`

**Samples suffix:** the same, plus `-is:reply`. Reply threads are dominated by shill and bot replies.

| sym | token clause | notes |
|---|---|---|
| NEAR | `($NEAR OR "NEAR Protocol" OR nearprotocol OR "NEAR Intents")` | bare "near" is a common word, so it is not used |
| ZEC | `($ZEC OR zcash)` | |
| STRK | `($STRK OR starknet)` | Starknet; the watchlist holds the Solana SPL wrapper |
| QCAT | `($QCAT OR qcat)` | StonkFun reward coin |
| BTC / ETH / SOL | `($BTC OR bitcoin)` / `($ETH OR ethereum)` / `($SOL OR solana)` | |
| JUP | `($JUP OR "jupiter exchange" OR jupiterexchange)` | |
| BONK | `($BONK OR bonkcoin OR "bonk coin")` | |
| WIF | `($WIF OR dogwifhat)` | |
| TROLL, BRETT, PNUT, SWARMS, MOODENG, CLANKER, CHILLGUY | cashtag only | the names are common words, the hippo, or slang |
| PEPE | `($PEPE OR pepecoin)` | |
| CAKE | `($CAKE OR pancakeswap)` | |
| NOT | `($NOT OR notcoin)` | |
| MINA | `($MINA OR "Mina Protocol")` | |
| FARTCOIN, JELLYJELLY, ZEREBRO | `($X OR x)` | |
| ROBO | `($ROBO OR "Fabric Protocol")` | |
| GOAT | `($GOAT OR goatseus)` | |

**Sample call arguments:**
`max_results=25, sort_order=relevancy, expansions=author_id, post.fields=created_at,public_metrics,lang,author_id, user.fields=public_metrics,created_at,verified,description`

- The 24h sample uses `start_time = now-24h`.
- The prior sample uses `start_time = now-7d` and `end_time = now-24h`.
- Relevancy order favours engaged posts. That is a deliberate bias, because those are the posts the crowd actually sees.

## 5. Formats

### `data/sentiment_counts.json`
```json
{ "version": 1, "updatedAt": "2026-10-11T13:53:00Z", "source": "...", "spec": "research/sentiment/COLLECTOR.md",
  "tokens": { "ZEC": {
      "sym": "ZEC", "tier": "P", "key": null,
      "query": "($ZEC OR zcash) -is:retweet lang:en ...",       // full query; history is reset if the query changes
      "granularity": "hour", "fetchedAt": "...Z",                  // = end of the newest bucket
      "windowStart": "...Z", "windowEnd": "...Z", "total7d": 27009,
      "hourly": [[startMs, endMs, count], ...],                   // rolling, max 14 days (336 rows); first/last buckets of a fetch can be partial
      "price": { "source": "binance_spot:ZECUSDT", "fetchedAt": "...Z", "hourly": [[openTimeMs, close, high, quoteVolume], ...], "error": null } } } }
```

### `data/sentiment_samples.json`
```json
{ "version": 1, "updatedAt": "...Z", "lexicon": "VADER 3.3.2 + crypto-v1",
  "tokens": { "ZEC": {
      "runs":  [{ "fetchedAt": "...Z", "window": "24h|prior", "returned": 25, "kept": 20, "dropped": 5, "dropReasons": { "duplicate text": 3 } }],
      "posts": [{ "id": "...", "t": createdMs, "window": "24h", "fetchedAt": "...Z", "author_id": "...", "username": "...", "followers": 81, "following": 1058,
                  "acct_age_d": 1003.2, "verified": false, "metrics": { "like_count": 0, "retweet_count": 0, "reply_count": 0, "quote_count": 0, "impression_count": 18 },
                  "text": "<=300 chars", "compound": 0.62, "lex_hits": ["bullish"], "weight": 0.9, "bot": false, "botReasons": [], "url": "https://x.com/..." }],
      "news": { "fetchedAt": "...Z", "returned": 10, "relevant": 4, "items": [{ "id": "...", "name": "...", "hook": "...", "summary": "...", "updated": "...Z", "url": "...", "compound": -0.4 }] } } } }
```
Posts are kept for 8 days. Bot-flagged posts are stored with `weight: 0` for audit.

### `data/sentiment_calls.json`
`{ "runs": [{ "run", "ingestedAt", "calls": { "counts": n, "samples": n, "news": n }, "total", "xReadsLeftToday" }], "today": { "date", "calls" } }`

## 6. Scoring (implemented in `research/sentiment.py` → `lib/sentiment.js`)

**Bot and spam filter** (per post). A post is dropped with weight 0 if any of these hold:
- the account is under 14 days old;
- the account follows ≥1000 people and has fewer than 0.05× that many followers;
- the account averages more than 200 posts/day;
- the post carries 5 or more distinct cashtags (shill lists);
- the post matches giveaway/presale/"join our telegram"/VIP-group/referral wording;
- the handle is a default one (6+ trailing digits) with fewer than 50 followers;
- the text is a duplicate (normalised) of an already-stored post;
- the author has ≥2 other flagged posts for the same token (author contagion).

**Weight** = `min(3.5, 0.5 + log10(1+followers)/2) × min(2, 1 + log10(1 + likes + 2·reposts + replies + 2·quotes)/2)`. That weight is then:
- divided by the number of that author's posts in the same call;
- divided by `(cashtags − 1)` for posts with 3+ cashtags.

**Language.** VADER 3.3.2 compound score, with `lexicon_crypto.json` merged in:
- ~150 words, such as moon +2.2, sendit +2.0, ape +1.0, bullish +2.6, wagmi +2.5, rug −3.4, dump −2.4, scam −3.5, exit −0.8, exitliquidity −3.0, rekt −3.0, ngmi −2.4, ponzi −3.2, honeypot −3.2.
- Phrase joins, such as "rug pull", "exit liquidity", "to the moon", "pump and dump", "send it", "buy the dip" and "going to zero".
- Emoji mapping: 🚀 rocket, 📉 chartdown, 💀 skull and others.

A post counts as bullish if compound ≥ 0.05 and bearish if compound ≤ −0.05.

**Mention velocity.** Buckets are anchored at the newest bucket end T:
- `c24` = posts in (T−24h, T].
- `d1..d6` are the prior six 24h windows.
- `z = (ln(1+c24) − mean ln(1+d)) / max(sd ln(1+d), 0.10)`.
- Also reported: `ratio = c24 / mean(d)`, `z6h` (last 6h against every earlier 6h block), and `dayChange = c24/d1 − 1`.
- `zVsMarket` = z minus the z of BTC+ETH+SOL combined. It is reported to expose weekend and market-wide cycles but is not used in the oscillator.

**Tone.** `bullShare = (B+1)/(B+N+2)`, where B and N are the weight sums of bullish and bearish non-bot posts in the window. Windows are the last 24h and the prior 6 days. Tone is "ok" with at least 4 opinionated posts.

Crypto X is bullish-skewed, so tone is scored against the **pooled prior-window bullish share across all collected tokens**: `toneScore = 100·Φ((bullShare − median)/max(0.08, sd))`. If fewer than 8 tokens are usable, it falls back to 0.75 / 0.15.

**Oscillator (0–100).**
- With tone: `0.6 · 100·Φ(z) + 0.4 · toneScore`.
- Without usable tone: `100·Φ(z)`, and the row is marked low-sample.

| Zone | Oscillator |
|---|---|
| euphoric | ≥ 80 |
| heated | 65–80 |
| neutral | 35–65 |
| quiet | 20–35 |
| capitulation-silence | ≤ 20 |

Within the bottom zone, the label is `capitulation` when toneScore < 35 and `silence` otherwise. `lowVolume` is set when c24 < 20.

**Divergence flags.**
- `high_while_cooling` (bearish). The price set its 7-day high within the last 12h and is within 3% of it, AND at least one of these holds:
  - bullish share fell ≥ 10 pts vs the prior 6 days;
  - mentions fell ≥ 20% vs the previous 24h (not when low volume);
  - z ≤ −0.5.
- `spike_flat_price` (caution). z ≥ 2 or ratio ≥ 2, with c24 ≥ 30, and |price 24h| < 3%.

**Composite factor** (`sentiment`, weight 0.25, contrarian). It starts at 50 and then:
- osc ≥ 80: `50 − (osc−80)`, i.e. 30–50.
- osc 65–80: `50 − 0.2·(osc−65)`.
- osc ≤ 20: `50 + 0.6·(20−osc)`, up to 62. Weekend "silence" only gets 0.3 per point.
- `high_while_cooling`: −6. `spike_flat_price`: −3.
- The result is clamped to 25–65.

Low-sample rows count at half weight. The factor is skipped entirely when the counts are older than 26h. The weight is small on purpose (0.25): the proxy backtest in §7 found no reliable contrarian edge.

## 7. Historical proxy (`python3 research/sentiment.py history`)

The free X counts only reach back 7 days, so `research/sentiment/proxy_history.py` tests the idea on **proxies**:
- **Wikipedia pageviews:** daily since 2015-07, canonical article plus up to 40 redirects summed, 37 tokens.
- **Google Trends:** weekly, 5-year window, via pytrends when reachable.
- **GDELT:** probed. It refuses this box's egress with "one request every 5 seconds", so it is reported as unavailable.
- **`data/narratives_history.json`:** checked. It holds only minutes of theme snapshots, so there is not enough to test.

Prices are Binance daily closes. Entry is at the close of the day *after* the attention day, to avoid look-ahead. The base rate is every token-day with the same price context. Events are declustered to one per token per 14 days. p-values are an exact binomial test plus a circular-shift permutation test with 1000 draws. Results, caveats and the per-test table are in `data/sentiment_history.json`. **It is a proxy: the Wikipedia/Google audience is not crypto X.**
