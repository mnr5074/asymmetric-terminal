'use strict';
// Pre-launch (birth-phase) desk: serves the cross-launchpad birth-phase library built by research/birthphase/*.py
// (data/birthphase/<launchpad>.jsonl, coverage.json, model.json, live.json) and refreshes the live matcher in the
// background when stale. Free sources only (Solana public RPC, pump.fun public APIs, GeckoTerminal, public EVM RPCs).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function createBirthphase({ DATA_DIR, root, log = () => {} }) {
  const DIR = path.join(DATA_DIR, 'birthphase');
  const LIVE_MAX_AGE = +(process.env.BIRTHPHASE_LIVE_MIN || 10) * 60e3;
  const mem = {};
  let running = false, lastErr = null, lastRun = 0;
  function read(f) {
    const p = path.join(DIR, f);
    try { const st = fs.statSync(p); if (mem[f] && mem[f].m === st.mtimeMs) return mem[f].d; const d = JSON.parse(fs.readFileSync(p, 'utf8')); mem[f] = { m: st.mtimeMs, d }; return d; }
    catch { return null; }
  }
  function age(f) { try { return Date.now() - fs.statSync(path.join(DIR, f)).mtimeMs; } catch { return Infinity; } }
  function refresh(force) {
    if (running || process.env.NO_AUTO_REFRESH === '1' || process.env.RUN_RESEARCH === '0') return;
    if (!force && age('live.json') < LIVE_MAX_AGE) return;
    if (Date.now() - lastRun < 3 * 60e3) return;
    running = true; lastRun = Date.now(); const t0 = Date.now();
    const ch = spawn('python3', ['live_poll.py'], { cwd: path.join(root, 'research', 'birthphase'), env: { ...process.env, DATA_DIR }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; ch.stderr.on('data', (b) => { err = (err + b).slice(-2000); });
    ch.on('exit', (c) => { running = false; lastErr = c ? `exit ${c}: ${err.slice(-300)}` : null; log(`birthphase live ${c ? 'failed' : 'ok'} in ${Math.round((Date.now() - t0) / 1000)}s`); });
    ch.on('error', (e) => { running = false; lastErr = e.message; });
  }
  function libRecord(key) {
    const pad = (read('coverage.json') || {}).pads || {};
    for (const p of Object.keys(pad)) {
      const f = path.join(DIR, p + '.jsonl');
      let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const i = txt.indexOf(`"key":"${key}"`);
      if (i < 0) continue;
      const s = txt.lastIndexOf('\n', i) + 1, e = txt.indexOf('\n', i);
      try { return JSON.parse(txt.slice(s, e < 0 ? undefined : e)); } catch { return null; }
    }
    return null;
  }
  async function api(q) {
    refresh(false);
    const cov = read('coverage.json'), model = read('model.json'), live = read('live.json');
    if (!cov) return { error: 'birth-phase library not built yet (research/birthphase/build_library.py)' };
    return { coverage: cov, model: model ? { generatedAt: model.generatedAt, n_library: model.n_library, pad_rates: model.pad_rates, backtest: model.backtest, features: model.features } : null,
      live: live || null, liveAgeSec: live ? Math.round(age('live.json') / 1000) : null, refreshing: running, lastErr };
  }
  async function token(q) {
    const k = String(q.get('key') || '').slice(0, 120);
    const r = libRecord(k);
    if (!r) throw Object.assign(new Error('not in birth-phase library'), { status: 404 });
    return r;
  }
  return { api, token, refresh };
}
module.exports = { createBirthphase };
