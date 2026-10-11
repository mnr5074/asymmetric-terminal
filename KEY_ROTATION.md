# API key rotation — Asymmetric Terminal

What the terminal tracks (lib/keyhealth.js, `/api/keyhealth`, the **keys** badge in the top bar):

- **Key age.** The terminal records the date it first sees each key. That date is a lower bound: the key may be older. xAI's `GET /v1/api-key` returns no `create_time` for the current key, so this applies to xAI too.
- **Rotation schedule.** Every key is due every **90 days**. You get a reminder **14 days before** it's due, in the terminal and once in the alert queue (`alerts.notice`). To change the schedule, create `data/keyhealth_config.json`:
  `{"defaultDays": 90, "remindDays": 14, "keys": {"XAI_API_KEY": {"days": 60}}, "sessionAutoRotate": true, "restartAfterRotate": true}`
  The env variables `KEY_ROTATE_DAYS` and `KEY_REMIND_DAYS` override the file.
- **Health checks.** None of these checks cost money or credits. They run every 12 hours on the :8000 server and whenever you open `/api/keyhealth?check=1` (at most once every 10 minutes).
  - Nansen: `GET https://api.nansen.ai/api/v1/account`, which uses 0 credits.
  - X: `GET https://api.x.com/2/usage/tweets?days=1`. This usage endpoint is not billed.
  - xAI: `GET https://api.x.ai/v1/api-key`. This key-info endpoint is free and also reports if the key is blocked or disabled.
  - Brevo (once it is set): `GET https://api.brevo.com/v3/account`.
  - The checks also look for 401/403 errors in the modules' own records (`nansen_budget.json`, `grok_budget.json`).
- **Leak scan.** `node scripts/leakscan.js` runs daily on :8000. It reports **file paths and line numbers only**, never the matching text. It checks:
  - **What it scans:** source files, `*.log` files, `data/` and `public/` (the bundle served to browsers), plus git-tracked files if this becomes a git repository.
  - **What it looks for:** exact copies of the current secret values, and strings shaped like keys.
  - **Where results go:** `data/keyhealth_leakscan.json`.
- **Fingerprints.** The terminal stores a salted scrypt hash for each key (in `data/keyhealth.json`, mode 600) so it can tell when a key changes. It never stores or logs the key itself.

## Status per key

| Key | Stored in | Auto-rotation now? | What true automation would need |
|---|---|---|---|
| `SESSION_SECRET` | `.env` | **Yes, on schedule** | Nothing more. See below. |
| `SITE_PASSWORD` | `.env` | No. You choose the password. | — |
| `NTFY_TOPIC` | `.env` | No, on purpose. | A new topic is easy to generate, but your phone has to subscribe to it again. |
| `XAI_API_KEY` | Grok Bot secure box (env) | No. Needs your management key. | An **xAI management key** plus the key's `apiKeyId` (the terminal already records it in `data/keyhealth.json`). |
| `X_BEARER_TOKEN` | Grok Bot secure box (env) | No. Needs your app credentials. | The X app's **consumer API key + secret** (OAuth2 client credentials). |
| `NANSEN_API_KEY` | Grok Bot secure box (env) | **Not possible.** | Nansen has no key-management API; keys can only be changed in the dashboard. |
| `BREVO_API_KEY` (when added) | Grok Bot secure box (env) | No. | Brevo has no documented API for rotating keys; use the dashboard. |

**Important:** the three provider keys are not in `.env`. They reach the server through the environment of `scripts/supervisor.js`, which passes its own environment to each server it starts. After you save a new key in the Grok Bot secure box, `scripts/restart-server.sh` alone is **not enough**. The **supervisor** has to be relaunched from a fresh session so the new environment is used (step 4 below).

## Automatic: SESSION_SECRET

`scripts/rotate-session-secret.js` writes a new random 32-byte secret into `.env` (mode 600). It never prints the value and logs the event to `data/keyhealth_events.jsonl`. With `--restart` it applies the change immediately through `scripts/restart-server.sh`. The only effect is that every browser session is logged out.

- **Schedule:** lib/keyhealth.js runs it on :8000 once the secret is overdue (90 days by default).
- **Turn it off:** set `KEYHEALTH_AUTOROTATE=off` or `"sessionAutoRotate": false`.
- **Rotate now:** `node scripts/rotate-session-secret.js --restart --reason "manual"`
- **Preview without changing anything:** `node scripts/rotate-session-secret.js --dry-run`

## Rotating a provider key yourself

The flow is the same for every provider:

1. **Create** the new key in the provider's dashboard (steps below). Do not revoke the old one yet.
2. **Save** it in the **Grok Bot secure box** under the same variable name, replacing the old value. Never paste a key into a chat, a file in this repo, `.env`, or a URL.
3. **Verify** from a fresh agent session with `node -e "console.log(!!process.env.XAI_API_KEY)"` (prints `true` or `false`, never the value).
4. **Relaunch the supervisor** from that session so it inherits the new environment. Ask an agent to "relaunch the terminal supervisor with the new env": it stops the old supervisor (not the server directly) and runs `scripts/start-supervisor.sh`, which warns if a key is missing.
5. **Check:**
   - open `/api/keyhealth?check=1` and confirm the key shows `valid`;
   - the badge should say `keys ok`;
   - "rotation detected" appears automatically and resets the 90-day clock.
6. **Revoke the old key** in the dashboard.

### xAI (XAI_API_KEY)
- **Manually:** go to console.x.ai, then **API Keys**, then **Create API key**. Give it the same ACLs as the current key (it has 2 ACLs, typically `api-key:model:*` and `api-key:endpoint:*`). Save it (steps 2–5 above), then disable or delete the old key.
- **Automatic rotation would need a management key** (console.x.ai, then Settings, then **Management Keys**; your account needs *Management Keys* read+write). Save it in the secure box as `XAI_MANAGEMENT_KEY`. With it:
  - `POST https://management-api.x.ai/auth/api-keys/{apiKeyId}/rotate` with `Authorization: Bearer $XAI_MANAGEMENT_KEY` returns the new secret **once** in `apiKey`, and keeps the same id, ACLs and rate limits;
  - `oldSecretExpireTime` keeps the old secret working for up to 7 days (default 24 hours), so the swap has no downtime;
  - `GET /auth/api-keys/{apiKeyId}/propagation` confirms the new secret is live.
  - The missing piece is **writing** the new secret back into the Grok Bot secure box. No API for that is available to the terminal, so a fully unattended job would have to keep the key in a local file (mode 600) instead. That is a design choice for you to make.
- **Cost:** none. Management API calls are not billed.

### X API (X_BEARER_TOKEN, app-only bearer)
- **Manually:** go to developer.x.com, then **Apps**, then your app, then **Keys and tokens**, then **Bearer Token**, then **Regenerate**. The old token stops working **immediately**, so save the new one and relaunch right away (steps 2–5).
- **Automatic rotation would need** the app's **consumer API key + secret**, saved as `X_API_KEY` / `X_API_SECRET`:
  - `POST https://api.x.com/oauth2/invalidate_token` (Basic auth with key:secret, body `access_token=<current>`), then
  - `POST https://api.x.com/oauth2/token` with `grant_type=client_credentials` returns the new bearer.
  - Only one app-only token exists at a time, and there is no overlap period.
- **Cost:** none for the token endpoints. The health check uses `/2/usage/tweets`, which is not billed.

### Nansen (NANSEN_API_KEY)
- **Manually:** go to app.nansen.ai/api?tab=api, then **Create API Key**. Save it (steps 2–5), then **Revoke** the old key.
- **Automation:** not possible. Nansen documents no API for managing keys, so the terminal can only remind you, check validity with `/account` (0 credits) and detect 401 errors.

### Brevo (BREVO_API_KEY, if or when it is added for alerts)
- **Manually:** go to app.brevo.com, then **SMTP & API**, then **API keys**, then **Generate a new API key**. Save it (steps 2–5), then delete the old key.

### SITE_PASSWORD / NTFY_TOPIC (local, in .env)
- **SITE_PASSWORD:**
  1. Edit `.env` (keep mode 600).
  2. Run `scripts/restart-server.sh "password change"`.
  - Changing it invalidates all existing sessions.
- **NTFY_TOPIC:**
  1. Generate a new topic with something like `openssl rand -hex 16` (do not paste it anywhere public).
  2. Update `.env`.
  3. Subscribe to the new topic in the ntfy app.
  4. Run `scripts/restart-server.sh "ntfy topic rotation"`.
  - The topic name is the credential: anyone who knows it can read and post your alerts.
  - The leak scan looks for it verbatim, and lib/provenance.js removes it from any URL it logs.

## If the leak scan finds something
- **Critical** means an exact copy of a live secret value, or anything in `public/`. Rotate that key **now** (steps above), then delete or clean the file. Files in `data/` and logs are local only. Anything in `public/` is served to browsers.
- **High/medium** findings are key-shaped strings. Check the path, since most hits in third-party caches are false positives. Known false positives are marked `info`.
