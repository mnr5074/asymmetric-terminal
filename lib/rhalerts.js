'use strict';
// Robinhood Chain scanner phone alerts (ntfy via lib/alerts.js; NTFY_TOPIC / ALERT_QUIET / ALERT_TZ from .env).
//  - Trigger: one push per token per base (key rh-trigger:<token>:<base bar>); a key that was pushed is never pushed again.
//  - Quiet hours (ALERT_QUIET, default 23-7 America/Los_Angeles): Trigger alerts are queued and pushed when quiet hours end (7 AM PT).
//  - Rug/walk-away alerts for tokens we already alerted (honeypot or top-10 > 50% flag, or pool liquidity down 40%+ since the alert)
//    are HARD: they bypass quiet hours. Each fires once per token per reason.
// State: DATA_DIR/rh_alerts_state.json. Every attempt is also written to data/alerts.log by lib/alerts.js.
const fs = require('fs');
const path = require('path');

function createRhAlerts({ DATA_DIR, alerts, log = () => {}, now = () => Date.now() }) {
  const sf = path.join(DATA_DIR, 'rh_alerts_state.json');
  let S = { done: {}, queue: [], alerted: {} };
  try { S = { ...S, ...JSON.parse(fs.readFileSync(sf, 'utf8')) }; } catch {}
  const save = () => { const t = sf + '.tmp'; fs.writeFileSync(t, JSON.stringify(S, null, 1)); fs.renameSync(t, sf); };
  const p6 = (x) => (x == null ? '?' : Number(x).toPrecision(4));
  const PT = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' PT';

  function triggerText(x, D) {
    const pl = x.plan || {}; const m = x.m || {};
    return [
      `$${x.symbol} (Robinhood Chain) hit TRIGGER at ${p6(x.price)} (4h bar ${PT(x.priceAt)}). Strength: ${x.strength || D.strength || '?'}.`,
      `Base ${m.setupBarUtc || '?'} UTC, top ${p6(m.baseHigh)}, low ${p6(m.baseLow)}; volume ${m.volRise == null ? '?' : Number(m.volRise).toFixed(1)}x the base.`,
      `Entry: ${pl.entry || 'n/a'}`,
      `Size: ${pl.size || 'n/a'}`,
      `Sell: ${(pl.sells || []).join(' | ') || 'n/a'}`,
      `Walk away: ${(pl.walkAway || []).join(' | ') || 'n/a'}`,
      pl.backtestNote || '',
      `Token ${x.token} · ${x.dexscreener || ''}`,
      'Mechanical plan, not advice. No auto-trading.',
    ].filter(Boolean).join('\n');
  }

  async function push(a) {
    const e = await alerts.push(a.title, a.text, { kind: a.kind, key: a.key, hard: !!a.hard, priority: a.hard ? 5 : 4, sms: false, tags: a.hard ? 'rotating_light,warning' : 'chart_with_upwards_trend', click: a.click });
    const st = String((e && e.status) || '');
    if (st.startsWith('suppressed:')) return false;         // hourly cap or quiet: keep queued, retry later
    if (st.startsWith('error')) { a.tries = (a.tries || 0) + 1; return a.tries >= 5; } // transport error: retry up to 5 runs
    return true;                                             // sent or DRY RUN (no transport configured)
  }

  async function flush() {
    if (!S.queue.length) return 0;
    let n = 0; const keep = [];
    for (const a of S.queue) {
      if (!a.hard && alerts.isQuiet()) { keep.push(a); continue; }
      const ok = await push(a);
      if (ok) { S.done[a.key] = { t: now(), queuedAt: a.queuedAt }; n++; } else keep.push(a);
    }
    S.queue = keep; save(); return n;
  }

  function enqueue(a) {
    if (S.done[a.key] || S.queue.some((q) => q.key === a.key)) return false;
    S.queue.push({ ...a, queuedAt: now() }); return true;
  }

  // Called after every scan with the parsed data/rh_scan.json.
  async function onScan(D) {
    if (!D || !Array.isArray(D.items)) return { queued: 0, sent: 0 };
    let queued = 0;
    for (const x of D.items) {
      if (x.state !== 'Trigger') continue;
      const key = `rh-trigger:${x.token}:${(x.m && x.m.setupBarUtc) || 'nobase'}`;
      if (enqueue({ kind: 'rh-trigger', key, title: `AT RH Trigger $${x.symbol}`, text: triggerText(x, D), click: x.dexscreener })) {
        queued++; S.alerted[x.token] = { key, t: now(), price: x.price, liqUsd: x.liqUsd, symbol: x.symbol };
      }
    }
    // walk-away / rug checks for tokens alerted in the last 14 days (HARD: bypass quiet hours)
    const byTok = Object.fromEntries(D.items.map((x) => [x.token, x]));
    for (const [tok, al] of Object.entries(S.alerted)) {
      if (now() - al.t > 14 * 86400e3) { delete S.alerted[tok]; continue; }
      const x = byTok[tok]; const reasons = [];
      if (x && x.contract && x.contract.honeypot === true) reasons.push(['honeypot', 'GeckoTerminal now flags it as a honeypot']);
      if (x && x.contract && x.contract.top10 != null && x.contract.top10 > 50) reasons.push(['top10', `top-10 holders now own ${x.contract.top10.toFixed(1)}%`]);
      if (x && al.liqUsd && x.liqUsd != null && x.liqUsd <= 0.6 * al.liqUsd) reasons.push(['liq', `pool liquidity fell from $${Math.round(al.liqUsd).toLocaleString()} to $${Math.round(x.liqUsd).toLocaleString()} (40%+ drop, liquidity pulled?)`]);
      const miss = (D.missing || []).find((m) => m.token === tok);
      if (miss) reasons.push(['missing', `scanner can no longer score it: ${miss.reason}`]);
      for (const [rid, why] of reasons) {
        if (enqueue({ kind: 'hard-rh-rug', hard: true, key: `rh-rug:${tok}:${rid}:${al.key}`, title: `AT HARD RH $${al.symbol}`,
          text: `HARD $${al.symbol} (Robinhood Chain, alerted ${PT(al.t)} at ${p6(al.price)}): ${why}. Walk-away rule: exit.${x ? ` Price now ${p6(x.price)}.` : ''}` })) queued++;
      }
    }
    save();
    const sent = await flush();
    return { queued, sent, pending: S.queue.length };
  }

  function readScan() { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rh_scan.json'), 'utf8')); } catch { return null; } }
  let timer = null;
  return {
    onScan,
    flush,
    async afterScan() { try { const r = await onScan(readScan()); if (r.queued || r.sent) log(`rh alerts: queued ${r.queued}, sent ${r.sent}, pending ${r.pending}`); return r; } catch (e) { log('rh alerts: ' + e.message); return null; } },
    start(ms = 5 * 60e3) { if (!timer) { timer = setInterval(() => flush().catch((e) => log('rh alerts flush: ' + e.message)), ms); timer.unref(); } },
    status() { return { pending: S.queue.map((a) => ({ key: a.key, kind: a.kind, hard: !!a.hard, queuedAt: a.queuedAt })), sent: Object.keys(S.done).length, watching: Object.keys(S.alerted).length, quietNow: alerts.isQuiet() }; },
    _state: () => S,
  };
}
module.exports = { createRhAlerts };
