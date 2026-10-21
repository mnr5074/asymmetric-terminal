'use strict';
// Martin's Calls (owner only): Martin's own gut calls, scored honestly against the chain's median token and against Gibi's verdict
// at the time. Calls: data/martin_calls.json (scripts/log_call.py add ...). Scores: research/mycalls/score.py -> data/martin_calls_scored.json.
// The API serves the scored snapshot (works read-only from the frozen file on Render) and lists any call logged since the last
// scoring run as 'not scored yet'. Refresh rides the existing scan schedule: after each Robinhood 4h scan and each Waking Up scan
// (free GeckoTerminal/DexScreener, cached; finished calls are frozen). Guests: /api/mycalls and /mycalls.js are 403 (lib/auth.js).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function createMyCalls({ DATA_DIR, root, log = () => {}, now = () => Date.now() }) {
  const CF = path.join(DATA_DIR, 'martin_calls.json'), SF = path.join(DATA_DIR, 'martin_calls_scored.json');
  const memo = {};
  const readJ = (f) => { try { const m = fs.statSync(f).mtimeMs; if (!memo[f] || memo[f].m !== m) memo[f] = { m, v: JSON.parse(fs.readFileSync(f, 'utf8')) }; return memo[f].v; } catch { return null; } };
  function api() {
    const C = readJ(CF) || { calls: [] }, S = readJ(SF);
    const scored = new Set(((S && S.items) || []).map((x) => x.id));
    const fresh = (C.calls || []).filter((c) => !scored.has(c.id)).map((c) => ({ ...c, lk: `d:${c.chain}:${c.contract}`, unscored: true, gibiDef: c.gibi || {}, gibi: {}, h: {} }));
    const known = new Set((C.calls || []).map((c) => c.id));
    const items = [...fresh, ...((S && S.items) || []).filter((x) => known.has(x.id))].sort((a, b) => b.calledAt - a.calledAt);
    return { generatedAt: S ? S.generatedAt : null, ageSec: S ? Math.round((now() - S.generatedAt) / 1000) : null, scorecard: S ? S.scorecard : null,
      method: S ? S.method : null, baselinePool: S ? S.baselinePool : null, items, running, lastRun };
  }
  let running = false, lastRun = null;
  function run(why = 'schedule') {
    if (running || process.env.RENDER_LITE === '1' || process.env.MYCALLS === 'off') return false;
    running = true; const t = now();
    const ch = spawn('nice', ['-n', '10', 'python3', 'research/mycalls/score.py'], { cwd: root, env: { ...process.env, DATA_DIR }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; ch.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    ch.on('exit', (code) => { running = false; lastRun = { at: t, why, code, ms: now() - t }; if (code !== 0) log(`mycalls score exited ${code}: ${err.trim().split('\n').pop()}`); });
    ch.on('error', () => { running = false; });
    return true;
  }
  function start() { // first run soon after boot only if the snapshot is stale (> 4h); otherwise wait for the next scan
    let age = Infinity; try { age = now() - fs.statSync(SF).mtimeMs; } catch {}
    if (age > 4 * 3600e3) setTimeout(() => run('startup (stale)'), 3 * 60e3).unref();
  }
  return { api, run, start };
}
module.exports = { createMyCalls };
