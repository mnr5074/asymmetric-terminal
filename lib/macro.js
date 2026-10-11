'use strict';
// Macro & News: keyless public sources only (verified 2026-10-10).
//  FRED fredgraph CSV (no key; must be fetched WITHOUT a browser user-agent), FRED release calendar HTML,
//  federalreserve.gov FOMC calendar + press RSS, Kalshi public market data, Polymarket gamma API,
//  The Block / Decrypt / Cointelegraph / CoinDesk RSS.
const { cached, getJSON } = require('./util');

async function text(url, headers = {}, timeout = 15000) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.text();
}
const UA = { 'user-agent': 'Mozilla/5.0 (asymmetric-terminal; read-only)' };

// ---------- FRED ----------
async function fred(id, since = '2024-01-01') {
  return cached('fred:' + id + ':' + since, 3 * 3600e3, async () => {
    const csv = await text(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${since}`, {}, 20000);
    return csv.trim().split('\n').slice(1).map((l) => l.split(',')).filter(([, v]) => v && v !== '.').map(([d, v]) => ({ d, v: +v }));
  });
}
const last = (a, k = 1) => a[a.length - k] || null;
function yoy(series) { // monthly index -> latest y/y % and m/m %
  const L = last(series); if (!L) return {};
  const prev = last(series, 2); const y = series.find((x) => x.d === (+L.d.slice(0, 4) - 1) + L.d.slice(4));
  return { date: L.d, level: L.v, mom: prev ? (L.v / prev.v - 1) * 100 : null, yoy: y ? (L.v / y.v - 1) * 100 : null };
}

// ---------- FRED release calendar (exact release dates, past + scheduled) ----------
const RELEASES = { nfp: { rid: 50, name: 'Jobs report (Employment Situation: NFP, unemployment)' }, cpi: { rid: 10, name: 'CPI' }, pce: { rid: 54, name: 'PCE (Personal Income & Outlays)' }, gdp: { rid: 53, name: 'GDP' } };
const MONTHS = { January: 0, February: 1, March: 2, April: 3, May: 4, June: 5, July: 6, August: 7, September: 8, October: 9, November: 10, December: 11 };
async function releaseDates(key, year) {
  return cached(`fredcal:${key}:${year}`, 12 * 3600e3, async () => {
    const h = await text(`https://fred.stlouisfed.org/releases/calendar?rid=${RELEASES[key].rid}&y=${year}`, {}, 20000);
    const out = new Set();
    for (const m of h.matchAll(/(?:Monday|Tuesday|Wednesday|Thursday|Friday)\s+(\w+)\s+(\d{1,2}),\s+(\d{4})/g)) {
      if (MONTHS[m[1]] == null) continue;
      out.add(`${m[3]}-${String(MONTHS[m[1]] + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`);
    }
    return [...out].sort();
  });
}

// ---------- FOMC calendar ----------
const MON3 = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
async function fomcMeetings() {
  return cached('fomc:cal', 12 * 3600e3, async () => {
    const h = await text('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', UA, 20000);
    const out = [];
    const parts = h.split(/(\d{4}) FOMC Meetings/);
    for (let i = 1; i < parts.length; i += 2) {
      const year = +parts[i], body = parts[i + 1];
      for (const m of body.matchAll(/fomc-meeting__month[^>]*><strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g)) {
        const months = m[1].trim().split('/'); const dates = m[2].trim();
        const days = dates.match(/\d+/g) || []; if (!days.length) continue;
        const mEnd = months[months.length - 1].slice(0, 3);
        if (MON3[mEnd] == null) continue;
        const end = `${year}-${String(MON3[mEnd] + 1).padStart(2, '0')}-${days[days.length - 1].padStart(2, '0')}`;
        out.push({ end, label: `${m[1].trim()} ${dates}`, sep: dates.includes('*'), unscheduled: /unscheduled|notation/i.test(dates) });
      }
    }
    return out.sort((a, b) => a.end.localeCompare(b.end));
  });
}

// ---------- market-implied odds ----------
async function kalshi() {
  return cached('kalshi:fed', 10 * 60e3, async () => {
    const d = await getJSON('https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXFEDDECISION&status=open&limit=4&with_nested_markets=true', {}, 15000);
    return (d.events || []).map((e) => ({
      event: e.event_ticker, title: e.title,
      outcomes: (e.markets || []).map((m) => ({ outcome: m.yes_sub_title, prob: m.last_price_dollars != null ? +m.last_price_dollars : null, bid: +m.yes_bid_dollars, ask: +m.yes_ask_dollars, volume: m.volume })).sort((a, b) => (b.prob || 0) - (a.prob || 0)),
    }));
  });
}
async function polymarket() {
  return cached('poly:fed', 10 * 60e3, async () => {
    const d = await getJSON('https://gamma-api.polymarket.com/events?tag_slug=fed-rates&closed=false&limit=6', {}, 15000);
    return (d || []).slice(0, 4).map((e) => ({ title: e.title, endDate: e.endDate, markets: (e.markets || []).map((m) => { let p = null; try { p = JSON.parse(m.outcomePrices || '[]')[0]; } catch {} return { q: m.groupItemTitle || m.question, yes: p != null ? +p : null }; }).filter((m) => m.yes != null).sort((a, b) => b.yes - a.yes).slice(0, 6) }));
  });
}

// ---------- news (RSS) ----------
const FEEDS = [
  ['The Block', 'https://www.theblock.co/rss.xml', 'crypto'],
  ['Decrypt', 'https://decrypt.co/feed', 'crypto'],
  ['Cointelegraph', 'https://cointelegraph.com/rss', 'crypto'],
  ['CoinDesk', 'https://www.coindesk.com/arc/outboundfeeds/rss/', 'crypto'],
  ['Federal Reserve', 'https://www.federalreserve.gov/feeds/press_all.xml', 'macro'],
];
const decode = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#039;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
function parseRss(xml, source, cat) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const it = m[0];
    const g = (tag) => (it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1];
    const title = decode(g('title')); let link = decode(g('link'));
    if (!link) link = (it.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    const ts = Date.parse(decode(g('pubDate')) || decode(g('dc:date')) || '') || null;
    if (title && /^https:\/\//.test(link)) items.push({ source, cat, title: title.slice(0, 220), link, ts });
  }
  return items;
}
async function news() {
  return cached('news:all', 5 * 60e3, async () => {
    const status = {};
    const lists = await Promise.all(FEEDS.map(async ([name, url, cat]) => {
      try { const x = parseRss(await text(url, UA, 15000), name, cat); status[name] = x.length ? `ok (${x.length})` : 'no items'; return x; }
      catch (e) { status[name] = 'failed: ' + e.message; return []; }
    }));
    const items = lists.flat().filter((x) => x.ts).sort((a, b) => b.ts - a.ts);
    const seen = new Set();
    return { items: items.filter((x) => !seen.has(x.title.toLowerCase()) && seen.add(x.title.toLowerCase())).slice(0, 80), status, note: 'CryptoPanic is not used: its API needs a key and the site blocks keyless requests.' };
  });
}

// ---------- snapshot ----------
async function safe(p) { try { return await p; } catch (e) { return { error: e.message }; } }
async function snapshot() {
  return cached('macro:snap', 10 * 60e3, async () => {
    const y = new Date().getUTCFullYear();
    const [dff, up, lo, dgs2, dgs10, payems, unrate, cpi, pce, gdp, meetings, k, poly] = await Promise.all([
      safe(fred('DFF', '2025-01-01')), safe(fred('DFEDTARU', '2015-01-01')), safe(fred('DFEDTARL', '2015-01-01')), safe(fred('DGS2', '2025-06-01')), safe(fred('DGS10', '2025-06-01')),
      safe(fred('PAYEMS', '2024-01-01')), safe(fred('UNRATE', '2024-01-01')), safe(fred('CPIAUCSL', '2024-01-01')), safe(fred('PCEPI', '2024-01-01')), safe(fred('GDPC1', '2023-01-01')),
      safe(fomcMeetings()), safe(kalshi()), safe(polymarket()),
    ]);
    const cal = {};
    await Promise.all(Object.keys(RELEASES).map(async (k2) => {
      const a = await safe(releaseDates(k2, y)); const b = await safe(releaseDates(k2, y + 1));
      cal[k2] = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
    }));
    const today = new Date().toISOString().slice(0, 10);
    const nextOf = (arr) => (Array.isArray(arr) ? arr.find((d) => d >= today) : null);
    const prevOf = (arr) => (Array.isArray(arr) ? [...arr].reverse().find((d) => d < today) : null);
    // recent FOMC decisions from target-range changes (+ holds from meeting dates)
    const decisions = [];
    if (Array.isArray(up) && Array.isArray(meetings)) {
      const at = (d) => { let v = null; for (const x of up) { if (x.d <= d) v = x.v; else break; } return v; };
      const add1 = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
      for (const m of meetings.filter((x) => x.end < today).slice(-8)) {
        const before = at(add1(m.end, -1)), after = at(add1(m.end, 2));
        if (before == null || after == null) continue;
        const bp = Math.round((after - before) * 100);
        decisions.push({ date: m.end, label: m.label, decision: bp > 0 ? `hike +${bp}bp` : bp < 0 ? `cut ${bp}bp` : 'hold', upper: after, lower: after - 0.25 });
      }
    }
    const pay = Array.isArray(payems) ? payems : [];
    const L = last(pay), P = last(pay, 2);
    const payChg = L && P ? Math.round(L.v - P.v) : null;
    const gdpS = Array.isArray(gdp) ? gdp : [];
    const gL = last(gdpS), gP = last(gdpS, 2);
    return {
      asOf: new Date().toISOString(),
      fed: {
        target: Array.isArray(up) && Array.isArray(lo) ? { lower: last(lo).v, upper: last(up).v, date: last(up).d } : null,
        effective: Array.isArray(dff) ? last(dff) : null,
        nextMeeting: Array.isArray(meetings) ? meetings.find((m) => m.end >= today) || null : null,
        recentDecisions: decisions.reverse(),
        kalshi: Array.isArray(k) ? k : null, polymarket: Array.isArray(poly) ? poly : null,
      },
      yields: { dgs2: Array.isArray(dgs2) ? last(dgs2) : null, dgs10: Array.isArray(dgs10) ? last(dgs10) : null, spread2s10s: Array.isArray(dgs2) && Array.isArray(dgs10) ? +(last(dgs10).v - last(dgs2).v).toFixed(2) : null },
      data: {
        nfp: L ? { refMonth: L.d.slice(0, 7), level: L.v, change: payChg, unit: 'thousands of jobs (m/m)' } : null,
        unrate: Array.isArray(unrate) ? last(unrate) : null,
        cpi: Array.isArray(cpi) ? yoy(cpi) : null, pce: Array.isArray(pce) ? yoy(pce) : null,
        gdp: gL && gP ? { quarter: gL.d, saar: (Math.pow(gL.v / gP.v, 4) - 1) * 100 } : null,
      },
      calendar: Object.fromEntries(Object.entries(RELEASES).map(([k2, r]) => [k2, { name: r.name, last: prevOf(cal[k2]), next: nextOf(cal[k2]), upcoming: (cal[k2] || []).filter((d) => d >= today).slice(0, 3) }])),
      sources: {
        fred: 'fred.stlouisfed.org fredgraph CSV (keyless): DFF, DFEDTARU/L, DGS2, DGS10, PAYEMS, UNRATE, CPIAUCSL, PCEPI, GDPC1',
        calendar: 'FRED release calendar (BLS/BEA dates)', fomc: 'federalreserve.gov FOMC calendar', odds: 'Kalshi KXFEDDECISION (public market data) + Polymarket fed-rates',
        errors: Object.fromEntries(Object.entries({ dff, up, dgs2, dgs10, payems, unrate, cpi, pce, gdp, meetings, k, poly }).filter(([, v]) => v && v.error).map(([n, v]) => [n, v.error])),
      },
    };
  });
}
module.exports = { snapshot, news, fred, releaseDates, fomcMeetings };
