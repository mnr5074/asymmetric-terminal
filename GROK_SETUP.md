# Grok (xAI) news & sentiment layer — setup

What it does: reads the headlines the terminal already collects (RSS, Google News, GDELT/regulation radar, priority news, narratives
store) and asks Grok to score each one once: urgency 0–100, sentiment −100…+100, tickers, category, confidence, a one-line "why".
Results show on the Perp Desk ("News pulse" strip + "Grok news feed" panel), at `/api/grok` and `/api/grok/pulse`, and as a small
"News (Grok)" factor (weight 0.5) in the composite grade. Code: `lib/grok.js`, `public/grok.js`.

## 1. Create the key (console.x.ai)
1. Sign in at https://console.x.ai → pick (or create) your team.
2. **Billing → spending limit**: set a monthly team limit of **$10** (this is the real hard stop at xAI's side; the terminal's own cap is a second guard).
3. **API Keys → Create API key**, name it `asymmetric-terminal`.
4. If the form offers restrictions, allow only **chat completions** (`/v1/chat/completions`) and only the models
   `grok-4.20-0309-non-reasoning` and `grok-4.7`. Leave everything else (image, video, voice, files, collections) off.
5. Copy the key once. Do **not** paste it anywhere except step 2.

## 2. Save it safely
- Save it **only** through the secure secret box in Grok Bot chat, under the name **`XAI_API_KEY`**.
- Never paste it into a chat message, an email, `.env`, or any file in this project. The server reads it from its process
  environment only, never logs it and never returns it from an endpoint.
- After saving, the server must be restarted once (new process picks up the env). Until then `/api/grok` reports
  `status: "waiting for key"` and makes **zero** calls.

## 3. Costs and caps (prices from docs.x.ai/docs/models, 2026-10-11, per 1M tokens)
| Use | Model | Input | Cached input | Output |
|---|---|---|---|---|
| Bulk headline scoring | `grok-4.20-0309-non-reasoning` | $1.25 | $0.20 | $2.50 |
| Optional daily desk brief (1 call/day) | `grok-4.7` (reasoning low) | $2.00 | $0.50 | $6.00 |

- ~25 headlines per call behind an identical system prompt (so xAI's prompt cache bills it at the cached rate).
- Every headline is hashed and cached in `data/grok_cache.json`: the same story is never paid for twice, even if it appears in four feeds.
- Hard caps, checked against the worst-case cost **before** each call: `XAI_MONTHLY_CAP_USD` (default **10**) and
  `XAI_DAILY_CAP_USD` (default monthly/30 ≈ **$0.33**). Spend is tracked from `usage.cost_in_usd_ticks` (1 tick = 1e-10 USD) in `data/grok_budget.json`.
- Measured on the first live run (2026-10-11): 66 headlines in 3 calls = $0.0105 (≈ $0.00016 each), desk brief $0.0085. The current free sources
  produce roughly 100–200 genuinely new headlines/day ⇒ **≈ $0.50–1.00/month** scoring + **≈ $0.26/month** brief ⇒ **≈ $1–1.5/month**, far under the $10 cap.
  Worst case (sources spike) is still limited to $0.33/day by the daily cap.
- Only the main :8000 server spends; test servers on other ports are read-only (override with `GROK_PAID=1`/`0`).
- Live search tools are **OFF** and not implemented: `web_search` costs $5 per 1,000 calls and `x_search` $5 per 1,000 posts returned,
  on top of tokens. Turning them on would need a code change with its own cap.

Other knobs: `GROK=off` (disable module), `GROK_BRIEF=off`, `GROK_BATCH` (25), `GROK_MAX_BATCHES` per 10-min cycle (4),
`GROK_EVERY_MIN` (10), `GROK_MAX_AGE_H` (only score headlines newer than 36h), `GROK_MODEL`, `GROK_BRIEF_MODEL`.

## 4. Revoke / rotate
- console.x.ai → **API Keys** → `asymmetric-terminal` → **Delete/Revoke**. Takes effect immediately; the terminal falls back to errors
  shown in the feed header and stops at the first failed call each cycle.
- Remove or replace `XAI_API_KEY` in the Grok Bot secure box, then restart the server once.
- If you ever think the key leaked: revoke first, then check console.x.ai usage for calls you don't recognise.
