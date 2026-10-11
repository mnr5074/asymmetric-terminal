// Optional X (Twitter) API hook. Server-side only; enabled when X_BEARER_TOKEN is set. Pay-per-use pricing (Oct 2026, docs.x.com):
// Posts Read $0.005 per post returned (search/recent, ~20 posts per item). Hard monthly USD cap ($50 default) + daily post cap + caching.
// Only called for top-ranked tokens/tickers. When unset, everything returns { enabled:false } and the UI hides the panel.
'use strict';
const fs = require('fs');
const path = require('path');
const POS = ['moon', 'bull', 'bullish', 'pump', 'send', 'buy', 'buying', 'long', 'breakout', 'gem', 'rip', 'ath', 'beat', 'upgrade', 'strong', 'calls'];
const NEG = ['rug', 'scam', 'dump', 'dumping', 'sell', 'selling', 'short', 'bear', 'bearish', 'honeypot', 'rekt', 'dead', 'crash', 'puts', 'fraud', 'miss', 'downgrade'];
function createX({ DATA_DIR, log = () => {} }) {
  const TOKEN = process.env.X_BEARER_TOKEN || '';
  const CAP = +(process.env.X_MONTHLY_CAP_USD || 50), POST = 0.005;            // Posts Read only ($0.005/post); no counts, no User Read
  const DAY_POSTS = +(process.env.X_DAILY_POSTS || 330), SAMPLE = Math.min(100, Math.max(10, +(process.env.X_SAMPLE || 20)));
  const TTL = +(process.env.X_CACHE_H || 6) * 3600e3;
  const bf = path.join(DATA_DIR, 'x_budget.json'); const cf = path.join(DATA_DIR, 'x_cache.json');
  let B = { month: '', spent: 0, posts: 0, day: '', dayPosts: 0, calls: 0 }; let C = {};
  try { B = { ...B, ...JSON.parse(fs.readFileSync(bf, 'utf8')) }; } catch {}
  try { C = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch {}
  const roll = () => { const d = new Date().toISOString(); if (B.month !== d.slice(0, 7)) { B.month = d.slice(0, 7); B.spent = 0; B.posts = 0; } if (B.day !== d.slice(0, 10)) { B.day = d.slice(0, 10); B.dayPosts = 0; } };
  const save = () => { try { fs.writeFileSync(bf, JSON.stringify(B)); fs.writeFileSync(cf, JSON.stringify(C)); } catch {} };
  const tone = (t) => { const s = t.toLowerCase(); let p = 0, n = 0; for (const w of POS) if (new RegExp('\\b' + w + '\\b').test(s)) p++; for (const w of NEG) if (new RegExp('\\b' + w + '\\b').test(s)) n++; return p - n; };
  async function term(sym, why) {
    const key = sym.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 15); if (key.length < 2) return null;
    const c = C[key]; if (c && Date.now() - c.t < TTL) return c;
    roll(); if (B.spent + SAMPLE * POST > CAP) return { skipped: 'monthly cap' }; if (B.dayPosts + SAMPLE > DAY_POSTS) return { skipped: 'daily posts' };
    const q = encodeURIComponent(`$${key} -is:retweet lang:en`);
    const r = await fetch(`https://api.x.com/2/tweets/search/recent?query=${q}&max_results=${SAMPLE}&tweet.fields=created_at,public_metrics`, { headers: { authorization: 'Bearer ' + TOKEN }, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => null); B.calls++;
    if (!r.ok) { save(); return { error: 'HTTP ' + r.status }; }
    const raw = j?.data || []; B.spent += raw.length * POST; B.posts += raw.length; B.dayPosts += raw.length;
    // drop copy-paste spam (identical openings) before scoring tone
    const seen = new Set(); const tw = raw.filter((x) => { const k = (x.text || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; });
    const ts = tw.map((x) => Date.parse(x.created_at)).filter(Boolean).sort((a, b) => a - b);
    const spanH = ts.length > 1 ? (ts[ts.length - 1] - ts[0]) / 3600e3 : null;
    const eng = tw.reduce((a, x) => a + (x.public_metrics?.like_count || 0) + (x.public_metrics?.retweet_count || 0), 0);
    const out = { t: Date.now(), sym: key, why, fetched: raw.length, dupShare: raw.length ? +(1 - tw.length / raw.length).toFixed(2) : null, sample: tw.length, postsPerHour: spanH ? +(tw.length / Math.max(spanH, 0.05)).toFixed(2) : null, tone: tw.reduce((a, x) => a + tone(x.text || ''), 0), toneAvg: tw.length ? +(tw.reduce((a, x) => a + tone(x.text || ''), 0) / tw.length).toFixed(2) : null, engagement: eng, newestAgeMin: ts.length ? Math.round((Date.now() - ts[ts.length - 1]) / 60e3) : null };
    C[key] = out; save(); return out;
  }
  return {
    enabled: !!TOKEN,
    // priority: text-alert tokens first, then top-ranked picks; stops at the daily/monthly caps
    async refresh(alerted, top) { if (!TOKEN) return; for (const [list, why] of [[alerted, 'alert'], [top, 'top']]) for (const s of [...new Set(list.filter(Boolean))]) { try { const r = await term(s, why); if (r?.skipped) return; } catch (e) { log('x: ' + e.message); } } },
    get: (sym) => C[(sym || '').toUpperCase()] || null,
    features(sym) { const c = C[(sym || '').toUpperCase()]; if (!c || Date.now() - c.t > 24 * 3600e3) return null; return { xSample: c.sample, xPph: c.postsPerHour, xTone: c.toneAvg, xEng: c.engagement }; },
    status() { roll(); return { enabled: !!TOKEN, monthlyCapUsd: CAP, spentUsd: +B.spent.toFixed(3), postsThisMonth: B.posts, postsToday: B.dayPosts, dailyPostCap: DAY_POSTS, samplePerItem: SAMPLE, calls: B.calls, cached: Object.keys(C).length, pricing: 'Posts Read $0.005 per post returned (search/recent); counts and User Read not used' }; },
    all: () => (TOKEN ? Object.values(C).sort((a, b) => b.t - a.t).slice(0, 20) : []),
  };
}
module.exports = { createX };
