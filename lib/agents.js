'use strict';
// AI Agents desk (weighted to Virtuals): serves data/agents.json (research/agents.py) + data/agents_birth.json and
// data/birthphase/virtuals.jsonl (research/agents_birth.py), refreshing them in the background when stale.
// Free public data only (Virtuals public API, CoinGecko, DefiLlama, DexScreener, GeckoTerminal, Base/Robinhood RPC, Google News RSS).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function createAgents({ DATA_DIR, root, log = () => {} }) {
  const DESK_MAX_AGE = +(process.env.AGENTS_MAX_AGE_H || 2) * 3600e3;
  const LIVE_MAX_AGE = +(process.env.AGENTS_LIVE_MIN || 20) * 60e3;
  const LIB_MAX_AGE = +(process.env.AGENTS_LIB_MAX_AGE_H || 24) * 3600e3;
  const file = (f) => path.join(DATA_DIR, f);
  const running = {}; const lastErr = {}; const mem = {};
  function read(f) {
    try { const st = fs.statSync(file(f)); if (mem[f] && mem[f].m === st.mtimeMs) return mem[f].d; const d = JSON.parse(fs.readFileSync(file(f), 'utf8')); mem[f] = { m: st.mtimeMs, d }; return d; } catch { return null; }
  }
  function age(f) { try { return Date.now() - fs.statSync(file(f)).mtimeMs; } catch { return Infinity; } }
  function buildLocked() { // research/agents_birth.py build writes agents_cache/build.lock with its pid
    try { const pid = +fs.readFileSync(file('agents_cache/build.lock'), 'utf8'); process.kill(pid, 0); return true; } catch { return false; }
  }
  function run(key, script, args) {
    if (running[key] || process.env.NO_AUTO_REFRESH === '1') return;
    running[key] = true; const t0 = Date.now();
    const ch = spawn('python3', [script, ...args], { cwd: path.join(root, 'research'), env: { ...process.env, DATA_DIR }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; ch.stderr.on('data', (b) => { err = (err + b).slice(-2000); });
    ch.on('exit', (c) => { running[key] = false; lastErr[key] = c ? `exit ${c}: ${err.slice(-300)}` : null; log(`agents ${key} ${c ? 'failed' : 'ok'} in ${Math.round((Date.now() - t0) / 1000)}s`); });
    ch.on('error', (e) => { running[key] = false; lastErr[key] = e.message; });
  }
  function refresh() {
    if (age('agents.json') > DESK_MAX_AGE) run('desk', 'agents.py', []);
    const locked = buildLocked();
    if (!locked && age('agents_birth.json') > LIVE_MAX_AGE && !running.build) run('live', 'agents_birth.py', ['live']);
    if (!locked && age('birthphase/virtuals.jsonl') > LIB_MAX_AGE && !running.live) run('build', 'agents_birth.py', ['build', '100']);
  }
  setTimeout(refresh, 120e3).unref();
  setInterval(refresh, 10 * 60e3).unref();
  return {
    api(q) {
      refresh();
      const d = read('agents.json');
      if (!d) throw Object.assign(new Error('agents.json is being generated (first run takes ~10 minutes), try again shortly'), { status: 503 });
      const b = read('agents_birth.json');
      const out = { ...d, ageSec: Math.round(age('agents.json') / 1000), birth: b ? { ...b, ageSec: Math.round(age('agents_birth.json') / 1000) } : null,
        status: { running: { ...running, build: running.build || buildLocked() }, lastError: lastErr } };
      if (q && q.get('section')) { const s = q.get('section'); return { generatedAt: out.generatedAt, [s]: s === 'birth' ? out.birth : out[s] }; }
      return out;
    },
    // full birth-phase record for one launch (curve series included): /api/agents/launch?id=virtuals:123
    launch(q) {
      const id = q.get('id'); if (!id) throw Object.assign(new Error('id required'), { status: 400 });
      let txt = ''; try { txt = fs.readFileSync(file('birthphase/virtuals.jsonl'), 'utf8'); } catch {}
      for (const line of txt.split('\n')) { if (line.includes(`"id":"${id}"`)) { try { return JSON.parse(line); } catch {} } }
      throw Object.assign(new Error('not in library'), { status: 404 });
    },
    status() { return { running, lastError: lastErr, ageSec: Math.round(age('agents.json') / 1000) }; },
    refresh,
  };
}
module.exports = { createAgents };
