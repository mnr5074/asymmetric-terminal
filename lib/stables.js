'use strict';
// Stablecoin issuance desk: daily mint / burn / net issuance per chain per coin, spike flags, mint-velocity ranking,
// Base share of USDC issuance, and a spike -> forward-return backtest.
// Data: research/stables.py -> data/stables.json (+ data/stables_onchain.json hourly cache). Free sources only
// (DefiLlama stablecoins API, public EVM RPCs, Solana public RPC, CoinGecko free). Refreshed in the background (~6h).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAX_AGE = 6 * 3600e3;

function createStables({ DATA_DIR, log = () => {} }) {
  let doc = null, docT = 0, running = false, lastSpawn = 0;
  const file = path.join(DATA_DIR, 'stables.json');
  function load() {
    let st = null;
    try { st = fs.statSync(file); if (st.mtimeMs !== docT) { doc = JSON.parse(fs.readFileSync(file, 'utf8')); docT = st.mtimeMs; } } catch { doc = null; }
    const stale = !st || Date.now() - st.mtimeMs > MAX_AGE;
    if (stale && !running && Date.now() - lastSpawn > 30 * 60e3 && process.env.NO_AUTO_REFRESH !== '1') {
      running = true; lastSpawn = Date.now();
      const ch = spawn('nice', ['-n', '10', 'python3', 'stables.py'], { cwd: path.join(__dirname, '..', 'research'), env: { ...process.env, DATA_DIR }, stdio: 'ignore' });
      ch.on('exit', (c) => { running = false; docT = 0; log('stables refresh exit ' + c); }); ch.on('error', () => { running = false; });
    }
    return doc;
  }
  function api(q) {
    const d = load();
    if (!d) throw Object.assign(new Error('stables.json is being generated (first run scans on-chain logs, ~10-20 min); try again shortly'), { status: 503 });
    const ageSec = Math.round((Date.now() - docT) / 1000);
    const pair = q.get('pair');
    if (pair) {
      const p = d.pairs[pair], o = d.onchain[pair];
      if (!p && !o) throw Object.assign(new Error('unknown pair; use chain:COIN e.g. base:USDC'), { status: 404 });
      return { pair, llama: p || null, onchain: o || null, label: d.labels[pair] || null, generatedAt: d.generatedAt };
    }
    if (q.get('full') === '1') return { ...d, ageSec, refreshing: running };
    const strip = (o) => { const { daily, ...r } = o || {}; return r; };
    const pairs = {}; for (const [k, v] of Object.entries(d.pairs || {})) pairs[k] = strip(v);
    const onchain = {}; for (const [k, v] of Object.entries(d.onchain || {})) onchain[k] = { ...strip(v), daily: (v.daily || []).slice(-30) };
    return { generatedAt: d.generatedAt, ageSec, refreshing: running, method: d.method, chains: d.chains, velocity_ranking: d.velocity_ranking, base_share: d.base_share,
      active_spikes: d.active_spikes, pairs, onchain, solana: d.solana, labels: d.labels, backtest: d.backtest, backtest_summary: d.backtest_summary, errors: d.errors, paid_or_unavailable: d.paid_or_unavailable };
  }
  return { api, load, status: () => ({ ok: !!load(), generatedAt: doc && doc.generatedAt, refreshing: running }) };
}
module.exports = { createStables };
