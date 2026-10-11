'use strict';
// Non-X social channel: serves data/socialalt.json built by research/socialalt.py (Reddit via Arctic Shift archive, Telegram
// public channel previews, Discord invite counts, Discourse governance forums, Snapshot, GitHub issues). Refreshes in the
// background when stale. Hooks for other modules (read-only, no network):
//   forSymbol('ZEC')  -> { mentions24h, velocity, sentiment, spike, events, channels } | null   (sentiment oscillator 'non-X' input)
//   forTheme('privacy_zk') -> { mentions24h, velocity, events } | null                        (narratives attention input)
//   rumors() -> [{ entity, event, mentions, channels, velocity, spike, evidence[] }]
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function createSocialAlt({ DATA_DIR, root, log = () => {} }) {
  const MAX_AGE = +(process.env.SOCIALALT_MAX_AGE_H || 2) * 3600e3;
  const f = path.join(DATA_DIR, 'socialalt.json');
  let mem = { m: 0, d: null }, running = false, lastErr = null;
  function read() { try { const st = fs.statSync(f); if (st.mtimeMs !== mem.m) mem = { m: st.mtimeMs, d: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch {} return mem.d; }
  const age = () => { try { return Date.now() - fs.statSync(f).mtimeMs; } catch { return Infinity; } };
  function refresh(force) {
    if (running || process.env.NO_AUTO_REFRESH === '1' || (!force && age() < MAX_AGE)) return;
    running = true; const t0 = Date.now();
    const ch = spawn('python3', ['socialalt.py'], { cwd: path.join(root, 'research'), env: { ...process.env, DATA_DIR }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; ch.stderr.on('data', (b) => { err = (err + b).slice(-1500); });
    ch.on('exit', (c) => { running = false; lastErr = c ? `exit ${c}: ${err.slice(-300)}` : null; log(`socialalt refresh ${c ? 'failed' : 'ok'} in ${Math.round((Date.now() - t0) / 1000)}s`); });
    ch.on('error', (e) => { running = false; lastErr = e.message; });
  }
  setTimeout(() => refresh(false), 120e3).unref();
  setInterval(() => refresh(false), 30 * 60e3).unref();
  return {
    routes() {
      return {
        async '/api/socialalt'(q) {
          refresh(false);
          const d = read(); if (!d) throw Object.assign(new Error('socialalt.json is being generated (first run ~5 min), try again shortly'), { status: 503 });
          const out = { ...d, ageSec: Math.round(age() / 1000), refreshing: running, lastError: lastErr };
          if (q && q.get('symbol')) { const s = q.get('symbol').toUpperCase(); out.entities = (d.entities || []).filter((e) => e.entity === s); out.rumors = (d.rumors || []).filter((r) => r.entity === s); }
          if (q && q.get('compact') === '1') { delete out.channel; out.entities = (out.entities || []).slice(0, 40); }
          return out;
        },
      };
    },
    forSymbol(sym) { const d = read(); return (d && d.channel && d.channel.bySymbol && d.channel.bySymbol[String(sym || '').toUpperCase()]) || null; },
    forTheme(id) { const d = read(); return (d && d.channel && d.channel.byTheme && d.channel.byTheme[id]) || null; },
    themes() { const d = read(); return (d && d.channel && d.channel.byTheme) || {}; },
    rumors() { const d = read(); return (d && d.rumors) || []; },
    status() { return { running, lastError: lastErr, ageSec: Math.round(age() / 1000) }; },
    refresh,
  };
}
module.exports = { createSocialAlt };
