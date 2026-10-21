'use strict';
// Waking Up desk (research/waking/waking.py -> data/waking.json; pre-declared test in research/waking/PREDECLARED.md).
// Tokens showing revival signs BEFORE a breakout: long dead/quiet stretch, volume up several days in a row off a low baseline,
// higher low, price still at/near the base. The API serves the snapshot (works read-only from the frozen file on Render).
// Alerts: ntfy ONLY for pools whose backtest beat random out-of-sample (data/waking.json alertsOn[pool] === true). When no pool
// passes, nothing is ever pushed: the panel is an experimental watch list. When on: one push per token per signal day (deduped
// forever, survives restarts), queued through quiet hours (ALERT_QUIET, 11 PM-7 AM PT) to the 7 AM flush; only HARD rug /
// walk-away notices bypass quiet hours. State: DATA_DIR/waking_alerts_state.json.
const fs = require('fs');
const path = require('path');

function createWaking({ DATA_DIR, alerts, log = () => {}, now = () => Date.now() }) {
  const F = path.join(DATA_DIR, 'waking.json');
  let C = { m: 0, v: null };
  function read() { try { const m = fs.statSync(F).mtimeMs; if (m !== C.m) C = { m, v: JSON.parse(fs.readFileSync(F, 'utf8')) }; return C.v; } catch { return null; } }
  function api(q) {
    const d = read(); if (!d) return { error: 'no Waking Up scan yet (run python3 research/waking/waking.py)', items: [] };
    const full = q && q.get && q.get('full') === '1';
    const { ledger, ...rest } = d; // ledger = first-flag memory for the scanner; not needed by the panel
    const out = { ...rest, ageSec: Math.round((now() - d.generatedAt) / 1000), alertState: status() };
    if (!full) { out.predeclared = { ...d.predeclared, text: undefined }; out.backtest = Object.fromEntries(Object.entries(d.backtest || {}).map(([k, v]) => [k, { ...v, signals: (v.signals || []).slice(0, 25) }])); }
    return out;
  }
  // ---- alerts (inert unless a pool passed the pre-declared test) ----
  const sf = path.join(DATA_DIR, 'waking_alerts_state.json');
  let S = { done: {}, queue: [], alerted: {} };
  try { S = { ...S, ...JSON.parse(fs.readFileSync(sf, 'utf8')) }; } catch {}
  const save = () => { try { const t = sf + '.tmp'; fs.writeFileSync(t, JSON.stringify(S, null, 1)); fs.renameSync(t, sf); } catch {} };
  const p4 = (x) => (x == null ? '?' : Number(x).toPrecision(4));
  const poolOf = (x) => (x.chain === 'solana' ? 'solana' : x.chain === 'robinhood' ? 'robinhood' : 'majors');
  function text(x, D) {
    const pl = x.plan || {}; const bt = (D.backtest || {})[poolOf(x)] || {};
    return [`$${x.symbol} (${x.chain}) is WAKING UP at ${p4(x.flag.flagPrice)} (signal day ${x.flag.signalDay} UTC). Strength: ${bt.strength}.`,
      `Signs: ${(x.signs || []).join('; ')}`, `Entry: ${pl.entry}`, `Size: ${pl.size}`, `Sell: ${(pl.sells || []).join(' | ')}`, `Walk away: ${(pl.walkAway || []).join(' | ')}`,
      `Contract ${x.contract || x.pair || ''}${x.dexscreener ? ' · ' + x.dexscreener : ''}`, 'Mechanical plan, not advice. No auto-trading.'].join('\n');
  }
  async function push(a) {
    const e = await alerts.push(a.title, a.text, { kind: a.kind, key: a.key, hard: !!a.hard, priority: a.hard ? 5 : 4, sms: false, tags: a.hard ? 'rotating_light,warning' : 'seedling', click: a.click });
    const st = String((e && e.status) || '');
    if (st.startsWith('suppressed:')) return false;
    if (st.startsWith('error')) { a.tries = (a.tries || 0) + 1; return a.tries >= 5; }
    return true;
  }
  async function flush() {
    if (!S.queue.length) return 0; let n = 0; const keep = [];
    for (const a of S.queue) { if (!a.hard && alerts.isQuiet()) { keep.push(a); continue; } if (await push(a)) { S.done[a.key] = { t: now() }; n++; } else keep.push(a); }
    S.queue = keep; save(); return n;
  }
  const enqueue = (a) => { if (S.done[a.key] || S.queue.some((q) => q.key === a.key)) return false; S.queue.push({ ...a, queuedAt: now() }); return true; };
  async function onScan(D) {
    if (!D || !Array.isArray(D.items)) return { queued: 0, sent: 0, off: true };
    const on = D.alertsOn || {}; let queued = 0;
    for (const x of D.items) {
      if (!on[poolOf(x)] || !x.flag || x.status === 'invalidated' || x.status === 'broke out') continue;
      if (x.flag.how !== 'live') continue; // never alert on replayed (past) signals
      const key = `waking:${poolOf(x)}:${x.token}:${x.flag.signalDay}`;
      if (enqueue({ kind: 'waking', key, title: `AT Waking $${x.symbol}`, text: text(x, D), click: x.dexscreener })) { queued++; S.alerted[x.token] = { key, t: now(), symbol: x.symbol, chain: x.chain }; }
    }
    const by = Object.fromEntries(D.items.map((x) => [x.token, x]));
    for (const [tok, al] of Object.entries(S.alerted)) {
      if (now() - al.t > 30 * 86400e3) { delete S.alerted[tok]; continue; }
      const x = by[tok]; if (!x || x.status !== 'invalidated') continue;
      if (enqueue({ kind: 'hard-waking-rug', hard: true, key: `waking-rug:${tok}:${al.key}`, title: `AT HARD $${al.symbol}`, text: `HARD $${al.symbol} (${al.chain}, Waking alert ${new Date(al.t).toISOString()}): ${x.statusWhy}. Walk-away rule: exit.` })) queued++;
    }
    save(); const sent = await flush(); return { queued, sent, pending: S.queue.length };
  }
  let timer = null;
  function status() { const d = C.v || {}; return { enabled: Object.values(d.alertsOn || {}).some(Boolean), alertsOn: d.alertsOn || {}, pending: S.queue.length, sent: Object.keys(S.done).length }; }
  return { api, read, onScan, flush, status,
    async afterScan() { try { C.m = 0; const r = await onScan(read()); if (r.queued || r.sent) log(`waking alerts: queued ${r.queued}, sent ${r.sent}`); return r; } catch (e) { log('waking alerts: ' + e.message); return null; } },
    start(ms = 5 * 60e3) { if (!timer) { timer = setInterval(() => flush().catch(() => {}), ms); timer.unref(); } } };
}
module.exports = { createWaking };
