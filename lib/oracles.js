'use strict';
// Oracle manipulation desk (research/riskinfra/oracles.py -> data/riskinfra_oracles.json).
// Chainlink (on-chain, Ethereum public RPC) / Pyth (Solana push feeds) / RedStone / lending-protocol oracles vs CEX (Binance, OKX,
// Coinbase, Kraken) and DEX (Jupiter, DexScreener, GeckoTerminal TWAP). Flags deviations, stale feeds, thin DEX pools behind collateral.
// Also exports createRunner(): a tiny background runner for the riskinfra python collectors (lock file so several server
// instances on one box never run the same collector twice). RISKINFRA=off disables background runs. Read-only, free sources only.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function createRunner({ DATA_DIR, name, script, args = [], file, everyMs, timeoutMs = 15 * 60e3, log = () => {}, after = null }) {
  const out = path.join(DATA_DIR, file);
  const lock = path.join(DATA_DIR, `riskinfra_${name}.lock`);
  const cwd = path.join(__dirname, '..', 'research', 'riskinfra');
  let doc = null, docT = 0, child = null, lastExit = null, lastStart = 0, timer = null;
  function load() {
    try { const st = fs.statSync(out); if (st.mtimeMs !== docT) { doc = JSON.parse(fs.readFileSync(out, 'utf8')); docT = st.mtimeMs; } } catch { /* not generated yet */ }
    return doc;
  }
  function locked() {
    try { const l = JSON.parse(fs.readFileSync(lock, 'utf8')); if (alive(l.pid) && Date.now() - l.t < timeoutMs) return l; } catch {}
    return null;
  }
  function run(force = false) {
    if (child || process.env.RISKINFRA === 'off' && !force) return false;
    if (locked()) return false;
    load();
    if (!force && docT && Date.now() - docT < everyMs * 0.9) return false;
    lastStart = Date.now();
    child = spawn('nice', ['-n', '10', 'python3', script, ...args], { cwd, env: { ...process.env, DATA_DIR }, stdio: ['ignore', 'ignore', 'pipe'] });
    try { fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, t: Date.now(), name })); } catch {}
    let err = '';
    child.stderr.on('data', (b) => { err = (err + b).slice(-2000); });
    const kill = setTimeout(() => { try { child && child.kill('SIGKILL'); } catch {} }, timeoutMs); kill.unref?.();
    child.on('exit', (code) => {
      clearTimeout(kill); lastExit = { code, t: Date.now(), ms: Date.now() - lastStart, err: code ? err.split('\n').slice(-4).join(' | ') : undefined };
      child = null; docT = 0; try { fs.unlinkSync(lock); } catch {}
      log(`riskinfra ${name} exit ${code} in ${Math.round(lastExit.ms / 1000)}s`); load();
      if (after && code === 0) try { after(); } catch {}
    });
    child.on('error', () => { child = null; try { fs.unlinkSync(lock); } catch {} });
    return true;
  }
  function start(delayMs = 30e3) {
    if (timer || process.env.RISKINFRA === 'off') return;
    setTimeout(() => run(), delayMs).unref?.();
    timer = setInterval(() => run(), Math.max(60e3, Math.min(everyMs / 2, 5 * 60e3))); timer.unref?.();
  }
  function status() { load(); return { name, file, everyMs, running: !!child || !!locked(), lastStart: lastStart || null, lastExit, updatedAt: docT || null, ageSec: docT ? Math.round((Date.now() - docT) / 1000) : null }; }
  return { load, run, start, status };
}

function createOracles({ DATA_DIR, log = () => {}, everyMs = 10 * 60e3, after }) {
  const r = createRunner({ DATA_DIR, name: 'oracles', script: 'oracles.py', file: 'riskinfra_oracles.json', everyMs, timeoutMs: 10 * 60e3, log, after });
  function api(q) {
    const d = r.load();
    if (!d) { r.run(); throw Object.assign(new Error('riskinfra_oracles.json is being generated (~1-2 min); try again shortly'), { status: 503 }); }
    if (q && q.get && q.get('full') === '1') return { ...d, runner: r.status() };
    const { assets, method, ...rest } = d;
    return { ...rest, assets: (assets || []).map(({ sources, lending, ...a }) => ({ ...a, sources: (sources || []).map(({ src, kind, price, devPct, ageS, stale, poolLiqUsd }) => ({ src, kind, price, devPct, ageS, stale, poolLiqUsd })) })), runner: r.status() };
  }
  return { ...r, api };
}

module.exports = { createOracles, createRunner };
