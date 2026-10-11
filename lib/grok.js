'use strict';
// Grok (xAI API) news & sentiment layer. Server-side only; the key is read from process.env.XAI_API_KEY and is never logged,
// returned by an endpoint or written to disk. With no key: status 'waiting for key' and ZERO network calls to api.x.ai.
//
// Models + pricing (docs.x.ai/docs/models, checked 2026-10-11, per 1M tokens, prompt < 200k):
//   bulk scoring  grok-4.20-0309-non-reasoning  $1.25 input · $0.20 cached input · $2.50 output   (no reasoning tokens)
//   desk brief    grok-4.7 (reasoning_effort low) $2.00 input · $0.50 cached input · $6.00 output  (1 short call per day, optional)
//   Older "mini/fast" slugs (grok-3-mini, grok-4-fast, grok-4-1-fast…) are now aliases of grok-4.3 at $1.25/$2.50, so nothing cheaper exists.
//   Server-side search tools (web_search $5 / 1k calls, x_search $5 / 1k posts returned) are NOT used (GROK_SEARCH stays off).
//
// Cost control: hard monthly cap XAI_MONTHLY_CAP_USD (default 10) + daily cap XAI_DAILY_CAP_USD (default = monthly/30 ≈ $0.33),
// worst-case cost of every call is checked against BOTH caps before it is sent; actual cost comes from usage.cost_in_usd_ticks
// (fallback: token counts × price table) -> data/grok_budget.json. Every headline is scored ONCE: results are cached by a content hash
// (normalized title + prompt version) in data/grok_cache.json and never re-sent. ~25 headlines per call behind a fixed system prompt
// (identical prefix every call, so xAI's automatic prompt caching bills it at the cached-input rate).
//
// Inputs (no new paid reads): RSS via lib/macro.js news() (The Block/Decrypt/Cointelegraph/CoinDesk/Fed), data/priority.json news
// (Google News + RSS for NEAR/ZEC), data/regradar.json (Google News/regulators/GDELT regulation radar), data/narratives_news_seen.json
// (narratives desk RSS store). Existing X data (data/x_cache.json from lib/xapi.js) holds only per-ticker aggregates (posts/hour, tone),
// not post texts, so it is attached as context ("X buzz") instead of being scored; no X API calls are made here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.x.ai/v1/chat/completions';
const PROMPT_VERSION = 'v1';
const PRICES = { // USD per 1M tokens (input, cachedInput, output); reasoning tokens bill as output
  'grok-4.20-0309-non-reasoning': { in: 1.25, cached: 0.2, out: 2.5 },
  'grok-4.3': { in: 1.25, cached: 0.2, out: 2.5 },
  'grok-4.7': { in: 2.0, cached: 0.5, out: 6.0 },
};
const CATS = ['hack', 'listing', 'regulation', 'macro', 'market', 'unlock', 'partnership', 'rumor', 'other'];
const CAT_LABEL = { hack: 'hack / exploit', listing: 'listing / delisting', regulation: 'regulation', macro: 'macro', market: 'liquidation / market structure', unlock: 'token unlock', partnership: 'partnership', rumor: 'rumor', other: 'other' };
const CAT_EXPLAIN = {
  hack: 'Funds stolen or a protocol bug exploited. Usually immediate selling of the affected token and sometimes contagion to tokens that share the bridge, chain or lender.',
  listing: 'A coin added to (or removed from) a big exchange or perp venue. Listings tend to pop price short-term; delistings force holders out and drain liquidity.',
  regulation: 'A regulator, court or government action (approval, ban, lawsuit, ETF decision). Can move a whole sector at once.',
  macro: 'Interest rates, inflation, jobs data, dollar, stocks. Moves all crypto together, mostly via leveraged traders.',
  market: 'Liquidations, funding, open interest, whale/ETF flows, exchange outages: the plumbing of the market itself.',
  unlock: 'Locked tokens (team/investors) becoming sellable. More supply on a known date often means selling pressure around it.',
  partnership: 'An integration, deal or adoption announcement. Often priced in fast; impact depends on how real the deal is.',
  rumor: 'Unconfirmed report or social-media claim. Treat with care: can reverse when confirmed or denied.',
  other: 'General coverage without a clear trading catalyst.',
};
const SYSTEM = `You score crypto/macro news headlines for a trading desk. For EACH input line "<n>|<source>|<title>" return one JSON object.
Fields (short keys, no extra text):
 i: the input number n
 u: urgency 0-100 (how soon and how strongly it can move prices: 90+ live hack/exchange halt/ETF decision/surprise Fed; 60-89 clear catalyst for named tokens today; 30-59 relevant but slow; <30 commentary, price recaps, opinion, ads, "price prediction")
 s: sentiment -100..100 for the affected assets (positive = bullish/price up, negative = bearish). Price recap headlines: sign of the move, small magnitude.
 t: affected tickers, uppercase symbols only (BTC, ETH, SOL, NEAR, ZEC, COIN, MSTR...). Use "CRYPTO" for the whole market, [] if none.
 c: one of hack|listing|regulation|macro|market|unlock|partnership|rumor|other (listing includes delisting; market = liquidations, funding, flows, outages, market structure)
 f: confidence 0-1 in your reading (low if the headline is vague, clickbait or unverified)
 w: one plain-English line, max 18 words, explaining WHY it matters for price (no jargon).
Return {"r":[...]} with exactly one object per input line, in order. Judge only from the headline; do not invent facts.`;
const SCHEMA = { name: 'scores', strict: true, schema: { type: 'object', additionalProperties: false, required: ['r'], properties: { r: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['i', 'u', 's', 't', 'c', 'f', 'w'], properties: { i: { type: 'integer' }, u: { type: 'integer' }, s: { type: 'integer' }, t: { type: 'array', items: { type: 'string' } }, c: { type: 'string', enum: CATS }, f: { type: 'number' }, w: { type: 'string' } } } } } } };

const norm = (s) => String(s || '').replace(/\s+[-–|]\s+[^-–|]{2,40}$/, '').toLowerCase().replace(/&[a-z]+;/g, ' ').replace(/[^a-z0-9$% ]+/g, ' ').replace(/\s+/g, ' ').trim();
const hash = (t) => crypto.createHash('sha1').update(PROMPT_VERSION + '|' + norm(t)).digest('hex').slice(0, 16);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const BREAK_URG = 75, BREAK_MIN = 30;

function createGrok({ DATA_DIR, macro = null, sources = {}, log = () => {} }) {
  const key = () => process.env.XAI_API_KEY || '';
  // Only the main :8000 server spends money by default; test instances on other ports (other workers) serve the shared cache read-only.
  const PAID = process.env.GROK_PAID === '1' || (process.env.GROK_PAID !== '0' && (+process.env.PORT || 8000) === 8000);
  const CAP = +(process.env.XAI_MONTHLY_CAP_USD || 10);
  const DAY_CAP = +(process.env.XAI_DAILY_CAP_USD || +(CAP / 30).toFixed(2));
  const MODEL = process.env.GROK_MODEL || 'grok-4.20-0309-non-reasoning';
  const BRIEF_MODEL = process.env.GROK_BRIEF_MODEL || 'grok-4.7';
  const BRIEF_ON = (process.env.GROK_BRIEF || 'on') !== 'off';
  const BATCH = clamp(+(process.env.GROK_BATCH || 25), 5, 40);
  const MAX_BATCHES = +(process.env.GROK_MAX_BATCHES || 4); // per cycle
  const EVERY = +(process.env.GROK_EVERY_MIN || 10) * 60e3;
  const MAX_AGE = +(process.env.GROK_MAX_AGE_H || 36) * 3600e3; // only headlines this fresh are worth paying for
  const F = { budget: path.join(DATA_DIR, 'grok_budget.json'), cache: path.join(DATA_DIR, 'grok_cache.json'), signals: path.join(DATA_DIR, 'grok_signals.json'), brief: path.join(DATA_DIR, 'grok_brief.json') };
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const wj = (f, v) => { try { fs.writeFileSync(f + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.tmp', f); } catch (e) { log('grok write ' + path.basename(f) + ': ' + e.message); } };
  let B = { month: '', spent: 0, day: '', daySpent: 0, calls: 0, callsMonth: 0, inTok: 0, cachedTok: 0, outTok: 0, items: 0, lastCallAt: null, lastError: null, days: {}, ...rj(F.budget, {}) };
  let C = rj(F.cache, {});
  let items = [], lastRun = null, running = false, lastSkip = null;
  const roll = () => { const d = new Date().toISOString(); if (B.month !== d.slice(0, 7)) { B.month = d.slice(0, 7); B.spent = 0; B.callsMonth = 0; } if (B.day !== d.slice(0, 10)) { B.day = d.slice(0, 10); B.daySpent = 0; } };
  let cMt = 0;
  const syncDisk = () => { // merge what another process may have written (never lose spend or paid scores)
    const d = rj(F.budget, null); if (d && d.month === B.month && (d.spent || 0) > B.spent) B = { ...B, ...d };
    try { const st = fs.statSync(F.cache); if (st.mtimeMs !== cMt) { C = { ...rj(F.cache, {}), ...C }; cMt = st.mtimeMs; } } catch {}
  };
  const room = () => { roll(); return Math.min(CAP - B.spent, DAY_CAP - B.daySpent); };
  const estTok = (s) => Math.ceil(String(s).length / 3.2) + 8;
  const priceOf = (m) => PRICES[m] || PRICES['grok-4.3'];
  const worst = (m, inTok, maxOut) => (inTok * priceOf(m).in + maxOut * priceOf(m).out) / 1e6;

  // ---------- ingestion ----------
  const rd = (f) => rj(path.join(DATA_DIR, f), null);
  async function collect() {
    const raw = [];
    const add = (title, source, url, ts, origin, hint = {}) => { if (!title || title.length < 12) return; raw.push({ title: String(title).replace(/\s+/g, ' ').trim().slice(0, 220), source: source || '', url: url || null, ts: ts || null, origin, hint }); };
    try { const n = macro ? await macro.news() : null; for (const x of n?.items || []) add(x.title, x.source, x.link, x.ts, 'rss', { cat: x.cat }); } catch (e) { log('grok: rss ' + e.message); }
    const P = rd('priority.json'); for (const x of P?.news?.items || []) add(x.title, x.source, x.url, x.publishedAt || x.t, 'priority', { tokens: x.tokens, topics: x.topics });
    const R = rd('regradar.json'); for (const x of R?.items || []) add(x.title, x.publisher, x.link, x.ts ? (x.ts < 1e12 ? x.ts * 1000 : x.ts) : null, 'regradar', { country: x.country, type: x.type_label, severity: x.severity, nSources: x.n_sources });
    const N = rd('narratives_news_seen.json'); for (const [url, x] of Object.entries(N || {})) add(x.title, (url.match(/^https?:\/\/(?:www\.)?([^/]+)/) || [])[1], url, x.ts ? (x.ts < 1e12 ? x.ts * 1000 : x.ts) : null, 'narratives', { themes: x.themes });
    for (const [name, fn] of Object.entries(sources)) { try { for (const x of (await fn()) || []) add(x.title, x.source, x.url, x.ts, name, x.hint || {}); } catch {} }
    // dedupe on the content hash; merge origins/sources so one story seen in 4 feeds is one item (and one paid score)
    const by = new Map();
    for (const x of raw) {
      const h = hash(x.title); const e = by.get(h);
      if (!e) by.set(h, { id: h, ...x, origins: [x.origin], sources: [x.source].filter(Boolean) });
      else { if (!e.origins.includes(x.origin)) e.origins.push(x.origin); if (x.source && !e.sources.includes(x.source)) e.sources.push(x.source); if (x.ts && (!e.ts || x.ts < e.ts)) e.ts = x.ts; Object.assign(e.hint, x.hint); }
    }
    return [...by.values()].filter((x) => x.ts && Date.now() - x.ts < 7 * 864e5).sort((a, b) => b.ts - a.ts);
  }

  // ---------- xAI call ----------
  async function chat(model, messages, maxOut, extra = {}) {
    if (!PAID) return { skipped: 'read-only instance (GROK_PAID=0 / not port 8000)' };
    roll(); syncDisk();
    const inTok = messages.reduce((a, m) => a + estTok(m.content), 0);
    const w = worst(model, inTok, maxOut);
    if (w > room()) { lastSkip = `cap: next call could cost up to $${w.toFixed(4)}, only $${Math.max(0, room()).toFixed(4)} left (${B.spent + w > CAP ? 'monthly' : 'daily'} cap)`; return { skipped: lastSkip }; }
    const r = await fetch(API, { method: 'POST', headers: { authorization: 'Bearer ' + key(), 'content-type': 'application/json' }, body: JSON.stringify({ model, messages, max_completion_tokens: maxOut, temperature: 0, ...extra }), signal: AbortSignal.timeout(90e3) });
    const j = await r.json().catch(() => null);
    B.calls++; B.callsMonth++; B.lastCallAt = Date.now();
    const u = j?.usage || {};
    const pin = u.prompt_tokens ?? u.input_tokens ?? 0, cached = u.prompt_tokens_details?.cached_tokens ?? 0, out = (u.completion_tokens ?? u.output_tokens ?? 0) + (u.completion_tokens_details?.reasoning_tokens || 0); // reasoning tokens bill at the output rate
    const p = priceOf(model);
    const cost = u.cost_in_usd_ticks != null ? u.cost_in_usd_ticks / 1e10 : ((pin - cached) * p.in + cached * p.cached + out * p.out) / 1e6;
    roll(); B.spent += cost; B.daySpent += cost; B.inTok += pin; B.cachedTok += cached; B.outTok += out;
    const d = (B.days[B.day] ||= { usd: 0, calls: 0, items: 0 }); d.usd += cost; d.calls++;
    for (const k of Object.keys(B.days).sort().slice(0, -45)) delete B.days[k];
    if (!r.ok) { B.lastError = `HTTP ${r.status}: ${String(j?.error?.message || j?.error || j?.code || '').slice(0, 160)}`; wj(F.budget, B); return { error: B.lastError, cost }; }
    B.lastError = null; wj(F.budget, B);
    return { text: j?.choices?.[0]?.message?.content || '', cost, usage: { prompt: pin, cached, output: out, ticks: u.cost_in_usd_ticks ?? null } };
  }

  async function scoreBatch(batch) {
    const lines = batch.map((x, n) => `${n}|${(x.sources[0] || x.origin).slice(0, 24)}|${x.title.replace(/\|/g, '/')}`).join('\n');
    const res = await chat(MODEL, [{ role: 'system', content: SYSTEM }, { role: 'user', content: lines }], 70 * batch.length + 60, { response_format: { type: 'json_schema', json_schema: SCHEMA } });
    if (res.skipped || res.error) return res;
    let arr = []; try { arr = JSON.parse(res.text).r || []; } catch { const m = res.text.match(/\{[\s\S]*\}/); try { arr = JSON.parse(m[0]).r || []; } catch {} }
    let ok = 0;
    for (const o of arr) {
      const x = batch[o.i]; if (!x) continue;
      C[x.id] = { u: clamp(Math.round(+o.u || 0), 0, 100), s: clamp(Math.round(+o.s || 0), -100, 100), t: [...new Set((o.t || []).map((s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter((s) => s.length >= 2 && s.length <= 12))].slice(0, 6), c: CATS.includes(o.c) ? o.c : 'other', f: clamp(+o.f || 0, 0, 1), w: String(o.w || '').slice(0, 160), m: MODEL, at: Date.now(), title: x.title.slice(0, 160) };
      ok++;
    }
    B.items += ok; if (B.days[B.day]) B.days[B.day].items += ok;
    // anything Grok skipped is cached as unscored so we never pay for it twice
    for (const x of batch) if (!C[x.id]) C[x.id] = { u: null, s: null, t: [], c: 'other', f: 0, w: 'not scored (model returned no row)', m: MODEL, at: Date.now(), title: x.title.slice(0, 160) };
    const keys = Object.keys(C); if (keys.length > 20000) for (const k of keys.sort((a, b) => C[a].at - C[b].at).slice(0, keys.length - 20000)) delete C[k];
    wj(F.cache, C); wj(F.budget, B);
    return { ok, cost: res.cost, usage: res.usage };
  }

  // ---------- assembled view ----------
  function view(list) {
    const now = Date.now();
    return list.map((x) => { const c = C[x.id]; const ageMin = x.ts ? Math.round((now - x.ts) / 60e3) : null;
      const tokens = [...new Set([...(c?.t || []), ...(x.hint?.tokens || [])])];
      return { id: x.id, title: x.title, url: x.url, source: x.sources.join(', ') || x.origin, origins: x.origins, ts: x.ts, ageMin, scored: !!(c && c.u != null),
        urgency: c?.u ?? null, sentiment: c?.s ?? null, tokens, category: c?.c || null, categoryLabel: c ? CAT_LABEL[c.c] : null, confidence: c?.f ?? null, why: c?.w || null, model: c?.m || null,
        breaking: !!(c && c.u >= BREAK_URG && ageMin != null && ageMin < BREAK_MIN), hint: x.hint };
    });
  }
  function signals(v) { // per-ticker aggregation for the composite factor + News pulse (recency half-life 12h, last 24h only)
    const T = {}; const now = Date.now();
    for (const x of v) { if (!x.scored || !x.ts || now - x.ts > 24 * 3600e3 || x.confidence < 0.4) continue;
      const w = (x.confidence) * (0.3 + x.urgency / 100) * Math.pow(0.5, (now - x.ts) / (12 * 3600e3));
      for (const s of x.tokens) { const a = (T[s] ||= { n: 0, w: 0, ws: 0, maxUrg: 0, hack: 0, breaking: 0, ids: [] });
        a.n++; a.w += w; a.ws += w * x.sentiment; a.maxUrg = Math.max(a.maxUrg, x.urgency); if (x.category === 'hack' && x.urgency >= 60 && x.sentiment < 0) a.hack++; if (x.breaking) a.breaking++; if (a.ids.length < 8) a.ids.push(x.id); } }
    for (const a of Object.values(T)) { a.sent = a.w ? Math.round(a.ws / a.w) : 0; a.w = +a.w.toFixed(3); delete a.ws; }
    return T;
  }

  async function run() {
    if (running) return; running = true;
    try {
      items = await collect(); lastRun = Date.now();
      syncDisk();
      if (key() && PAID) {
        const todo = items.filter((x) => !C[x.id] && Date.now() - x.ts < MAX_AGE);
        for (let b = 0; b < MAX_BATCHES && todo.length; b++) {
          const r = await scoreBatch(todo.splice(0, BATCH));
          if (r.skipped || r.error) { if (r.error) log('grok: ' + r.error); break; }
        }
        if (BRIEF_ON) await brief().catch((e) => log('grok brief: ' + e.message));
      }
      const v = view(items); wj(F.signals, { generatedAt: Date.now(), promptVersion: PROMPT_VERSION, tokens: signals(v) });
    } catch (e) { log('grok run: ' + e.message); } finally { running = false; }
  }

  // ---------- optional daily desk brief (grok-4.7, one call/day, uses only already-scored headlines) ----------
  async function brief() {
    const cur = rj(F.brief, null); const today = new Date().toISOString().slice(0, 10);
    if (cur?.day === today) return cur;
    const top = view(items).filter((x) => x.scored && x.urgency >= 40 && Date.now() - x.ts < 24 * 3600e3).sort((a, b) => b.urgency - a.urgency).slice(0, 30);
    if (top.length < 5) return null;
    const body = top.map((x) => `[u${x.urgency} s${x.sentiment} ${x.tokens.join('/') || '-'} ${x.category}] ${x.title}`).join('\n');
    if (room() < 0.06) return null; // leave headroom for scoring
    const r = await chat(BRIEF_MODEL, [{ role: 'system', content: 'You write a 6-bullet morning desk brief for a perp trader who wants plain English. Each bullet: what happened, which tokens, likely price effect, how sure. Last bullet: the one thing to watch today. Max 140 words. Only use the headlines given.' }, { role: 'user', content: body }], 1200, { reasoning_effort: 'low' });
    if (r.skipped || r.error) return null;
    const out = { day: today, at: Date.now(), model: BRIEF_MODEL, text: r.text.trim().slice(0, 2000), costUsd: +r.cost.toFixed(5), basedOn: top.length };
    wj(F.brief, out); return out;
  }

  // ---------- API ----------
  function status() {
    roll(); const has = !!key();
    return { status: !has ? 'waiting for key' : !PAID ? 'read-only (cache only; paid calls run on the :8000 server)' : B.lastError ? 'error' : lastSkip && room() <= 0.001 ? 'paused (cap reached)' : 'active',
      keyPresent: has, note: has ? null : 'XAI_API_KEY is not in this server process environment: no calls are made. Save it in Grok Bot chat (secure box) as XAI_API_KEY, then restart the server (see GROK_SETUP.md).',
      model: MODEL, briefModel: BRIEF_ON ? BRIEF_MODEL : 'off', search: 'off (web_search $5/1k calls, x_search $5/1k posts: not used)',
      pricing: Object.fromEntries([MODEL, BRIEF_MODEL].map((m) => [m, `$${priceOf(m).in} input / $${priceOf(m).cached} cached / $${priceOf(m).out} output per 1M tokens`])),
      budget: { monthlyCapUsd: CAP, dailyCapUsd: DAY_CAP, spentMonthUsd: +B.spent.toFixed(5), spentTodayUsd: +B.daySpent.toFixed(5), leftTodayUsd: +Math.max(0, room()).toFixed(4), callsMonth: B.callsMonth, callsTotal: B.calls, itemsScored: B.items, tokens: { input: B.inTok, cachedInput: B.cachedTok, output: B.outTok }, lastCallAt: B.lastCallAt, lastSkip, lastError: B.lastError, days: B.days },
      cacheSize: Object.keys(C).length, batch: BATCH, everyMin: EVERY / 60e3, maxAgeH: MAX_AGE / 3600e3, lastRun, running };
  }
  function xBuzz() { const X = rd('x_cache.json') || {}; const out = {}; for (const [k, v] of Object.entries(X)) if (v && Date.now() - v.t < 24 * 3600e3) out[k] = { postsPerHour: v.postsPerHour, toneAvg: v.toneAvg, sample: v.sample, ageMin: Math.round((Date.now() - v.t) / 60e3) }; return out; }
  async function api(q) {
    if (!items.length && !running) await run(); else syncDisk();
    let v = view(items); const unscoredAll = v.filter((x) => !x.scored).length;
    const tok = (q.get('token') || '').toUpperCase(), cat = q.get('cat'), minU = +(q.get('minurg') || 0), sc = q.get('scored');
    if (tok) v = v.filter((x) => x.tokens.includes(tok));
    if (cat) v = v.filter((x) => x.category === cat);
    if (minU) v = v.filter((x) => (x.urgency || 0) >= minU);
    if (sc === '1') v = v.filter((x) => x.scored);
    const flags = v.filter((x) => x.breaking);
    const limit = Math.min(+(q.get('limit') || 150), 500);
    return { ...status(), flags, items: v.slice(0, limit), total: v.length, unscored: unscoredAll,
      signals: rj(F.signals, {})?.tokens || {}, xBuzz: xBuzz(), brief: rj(F.brief, null),
      categories: Object.fromEntries(CATS.map((c) => [c, { label: CAT_LABEL[c], explain: CAT_EXPLAIN[c] }])),
      rules: `Urgency 0-100 = how soon/strongly it can move price; sentiment -100 (bearish) .. +100 (bullish); BREAKING = urgency >= ${BREAK_URG} and under ${BREAK_MIN} min old. Scores come from ${MODEL} reading the headline only; each headline is scored once and cached.`,
      nfa: 'Model reading of headlines, not verified facts. Not financial advice.' };
  }
  // News pulse: which tokens have a live desk signal (liquidations / price gaps / funding divergence / order book) + matching headlines
  async function pulse(desk) {
    if (!items.length && !running) await run();
    const v = view(items).filter((x) => x.scored && Date.now() - x.ts < 48 * 3600e3);
    const fired = [];
    const add = (tab, sym, label) => { if (sym && !fired.find((f) => f.tab === tab && f.sym === sym)) fired.push({ tab, sym: String(sym).toUpperCase(), label }); };
    try { for (const a of desk.liquidations?.()?.assets || []) if (a.level) add('liq', a.sym, `${a.level}${a.dom ? ' (' + a.dom + ')' : ''}`); } catch {}
    try { for (const f of desk.pricegaps?.()?.flags || []) add('gaps', f.sym, `${f.level} gap ${f.adjGapPct != null ? (+f.adjGapPct).toFixed(1) + '%' : ''} on ${f.venue}`); } catch {}
    try { for (const e of desk.fundingdiv?.()?.active || []) add('fdiv', e.sym, `${e.outlier} outlier ${e.peakDiv != null ? Math.round(e.peakDiv) + '%/yr' : ''}`); } catch {}
    try { for (const e of desk.orderbook?.()?.detections || []) if (Date.now() - e.t < 60 * 60e3) add('ob', e.sym, String(e.type || '').replace(/_/g, ' ')); } catch {}
    const xb = xBuzz(); const sig = rj(F.signals, {})?.tokens || {};
    const rows = fired.map((f) => { const hits = v.filter((x) => x.tokens.includes(f.sym) || x.tokens.includes(f.sym.replace(/^1000+/, ''))).sort((a, b) => (b.urgency * (b.confidence || 0.5)) - (a.urgency * (a.confidence || 0.5)) || b.ts - a.ts).slice(0, 4);
      return { ...f, headlines: hits, signal: sig[f.sym] || null, xBuzz: xb[f.sym] || null, explain: hits.length ? `Headlines Grok tied to ${f.sym} in the last 48h; the top one is the most likely driver.` : `No scored headline mentions ${f.sym} in the last 48h: the move looks flow-driven (positioning, liquidations, a single venue) rather than news-driven.` }; });
    const marketWide = v.filter((x) => x.tokens.includes('CRYPTO') || x.tokens.includes('BTC')).sort((a, b) => b.urgency - a.urgency).slice(0, 3);
    return { status: status().status, generatedAt: Date.now(), fired: rows, marketWide, breaking: v.filter((x) => x.breaking).slice(0, 5) };
  }
  let started = false;
  function start() { if (started) return; started = true; setTimeout(run, 30e3).unref?.(); setInterval(run, EVERY).unref(); }
  return { start, run, api, pulse, status, brief: () => rj(F.brief, null), _scoreBatch: scoreBatch, _collect: collect };
}

// Composite factor (null-safe, file-based so lib/composite.js needs no wiring): reads data/grok_signals.json.
// Score 50 = neutral. Weighted headline sentiment (confidence × urgency × 12h half-life, last 24h) moves it at most ±12 (38..62);
// a fresh high-urgency negative hack/exploit headline for the token sets 30 (44 if the overall tone is still positive, e.g. funds recovered) and a warning. Skipped when no scored headline names the token
// or the signals file is >2h old. Small weight (0.5) because headline sentiment is noisy and largely priced in within minutes.
let SIGC = null;
function factor(DATA_DIR, sym) {
  const f = path.join(DATA_DIR, 'grok_signals.json');
  try { const st = fs.statSync(f); if (Date.now() - st.mtimeMs > 2 * 3600e3) return null; if (!SIGC || SIGC.t !== st.mtimeMs) SIGC = { t: st.mtimeMs, v: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { return null; }
  const a = SIGC.v?.tokens?.[String(sym || '').toUpperCase()]; if (!a || !a.n) return null;
  const strength = Math.min(1, a.w / 1.5);
  let score = 50 + clamp(a.sent * 0.12 * strength, -12, 12); let warn = null;
  if (a.hack) { score = a.sent <= 0 ? 30 : 44; warn = `Grok: ${a.hack} high-urgency hack/exploit headline(s) in 24h${a.sent > 0 ? ' (overall tone positive: possibly resolved/recovered)' : ''}`; }
  return { score, value: `${a.n} headline${a.n > 1 ? 's' : ''}, tone ${a.sent > 0 ? '+' : ''}${a.sent}, max urgency ${a.maxUrg}${a.breaking ? ', BREAKING' : ''}`,
    text: `Grok read ${a.n} recent headline(s) about ${sym}: average tone ${a.sent > 0 ? '+' : ''}${a.sent} on a −100 (bearish) to +100 (bullish) scale, most urgent ${a.maxUrg}/100.${a.hack ? ' At least one is a fresh hack/exploit report, which usually means immediate selling.' : ''} News moves fast and is often priced in within minutes, so this factor is weighted lightly.`, warn };
}
module.exports = { createGrok, factor, PRICES, SYSTEM, PROMPT_VERSION };
