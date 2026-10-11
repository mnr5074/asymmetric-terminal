// Validation layer wiring (additive): signal bus -> alert ranking -> false-positive log -> paper trading, plus the backtest scoreboard.
// Routes: /api/backtest[?id=], /api/alerts/ranked[?wl=chain:addr,...&limit=&shadow=1], /api/signals, /api/fplog[?id=], /api/paper[?bankroll=&reset=1]
// Only ONE server process writes data/fplog.json, data/papertrade.json, data/events_live.json (lock file data/.validation.lock
// with a heartbeat); other instances serve read-only views. VALIDATION=off disables the loops.
'use strict';
const fs = require('fs');
const path = require('path');
const { createSignalBus } = require('./signalbus');
const { createBacktest } = require('./backtest');
const { createAlertRank } = require('./alertrank');
const { createFpLog } = require('./fplog');
const { createPaperTrade } = require('./papertrade');

function attachValidation({ routes, DATA_DIR, root, live, calls, perps, liquidations, fundingdiv, orderbook, composite, nansen, dsTokens, getJSON, cached, log = () => {} }) {
  const lockF = path.join(DATA_DIR, '.validation.lock'); const me = `${process.pid}:${process.env.PORT || 8000}`;
  function writer() {
    if (process.env.VALIDATION_WRITE === '0') return false;
    try { const [who, t] = fs.readFileSync(lockF, 'utf8').split('|'); if (who === me) return true; const pid = +who.split(':')[0]; let alive = true; try { process.kill(pid, 0); } catch { alive = false; } if (alive && Date.now() - +t < 3 * 60e3) return false; } catch {}
    try { fs.writeFileSync(lockF, `${me}|${Date.now()}`); return true; } catch { return false; }
  }
  const beat = () => { if (writer()) try { fs.writeFileSync(lockF, `${me}|${Date.now()}`); } catch {} };
  process.on('exit', () => { try { if (fs.readFileSync(lockF, 'utf8').startsWith(me + '|')) fs.unlinkSync(lockF); } catch {} });

  let fp = null;
  const bus = createSignalBus({ DATA_DIR, live, perps, liquidations, fundingdiv, orderbook, composite, root, log });
  const bt = createBacktest({ DATA_DIR, root, fplog: () => fp, writer, log });
  fp = createFpLog({ DATA_DIR, bus, live, perps, calls, nansen, dsTokens, getJSON, cached, writer, log, scoreboard: () => { bt.load(); const s = bt.load(); return Object.fromEntries((s?.detectors || []).map((d) => [d.id, d])); } });
  const paper = createPaperTrade({ DATA_DIR, bus, live, perps, dsTokens, writer, log });
  const readPortfolio = () => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'portfolio.json'), 'utf8')); } catch { return {}; } };
  const ar = createAlertRank({ backtest: bt, fplog: fp, readPortfolio, paperKeys: () => paper.openKeys() });
  let lastRank = null, ticks = 0, lastTick = null, lastErr = null;

  async function tick() {
    try {
      beat(); const sigs = await bus.collect({ maxAgeMs: 0 }); const r = ar.rank(sigs, { limit: 200 });
      const rankMap = Object.fromEntries(r.items.map((x) => [x.key, x.rank]));
      if (writer()) {
        fp.record(sigs, { rank: rankMap });                         // every fired alert, active and shadow
        fp.record(r.confluence, { rank: rankMap });                 // confluence meta-alerts are scored like any detector
        await fp.track();
        if (ticks % 5 === 0) await fp.evaluate();
        if (ticks % 30 === 0) { fp.ingest(); fp.rollup(); }
        fp.save();
        await paper.tick(r.items.filter((x) => !x.collapsed));
        if (ticks % 60 === 0) bt.rerun(false);
      }
      lastRank = r; ticks++; lastTick = Date.now();
    } catch (e) { lastErr = e.message; log('validation tick: ' + e.stack); }
  }
  if (process.env.VALIDATION !== 'off') { setTimeout(tick, 20e3); setInterval(tick, +(process.env.VALIDATION_MS || 60e3)).unref(); }

  Object.assign(routes, {
    async '/api/backtest'(q) { return bt.api(q); },
    async '/api/signals'(q) { const s = await bus.collect(); const d = q.get('detector'); return { generatedAt: Date.now(), count: s.length, signals: d ? s.filter((x) => x.detector === d) : s.slice(0, +(q.get('limit') || 500)) }; },
    async '/api/alerts/ranked'(q) {
      const wl = (q.get('wl') || '').split(',').filter(Boolean).slice(0, 200);
      const sigs = await bus.collect(); const r = ar.rank(sigs, { wl, limit: +(q.get('limit') || 40), includeShadow: q.get('shadow') === '1' });
      return { ...r, writer: writer(), lastTick, ticks, lastErr };
    },
    async '/api/fplog'(q) { const id = q.get('id'); if (id) return fp.alert(id) || { error: 'not found' }; return fp.summary({ limit: +(q.get('limit') || 60) }); },
    async '/api/paper'(q) { return paper.api(q); },
  });
  return { bus, bt, fp, paper, ar, tick };
}
module.exports = { attachValidation };
