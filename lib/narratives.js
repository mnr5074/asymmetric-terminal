'use strict';
// Narratives Desk: serves data/narratives*.json built by research/narratives.py (free sources only) and refreshes it
// in the background when stale. Also exposes boostFor() so a composite grade (lib/composite.js) can read the
// narrative boost without parsing files itself. Optional X social-velocity input stays OFF (no X calls are made here).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function createNarratives({ DATA_DIR, root, log = () => {} }) {
  const MAX_AGE = +(process.env.NARRATIVES_MAX_AGE_H || 3) * 3600e3;
  const X_ON = false; // deliberately hard-off: enabling needs user approval (cost estimate in narratives.json -> xModule)
  let running = false, lastErr = null, mem = {};
  const file = (f) => path.join(DATA_DIR, f);
  function read(f) {
    try { const st = fs.statSync(file(f)); if (mem[f] && mem[f].m === st.mtimeMs) return mem[f].d; const d = JSON.parse(fs.readFileSync(file(f), 'utf8')); mem[f] = { m: st.mtimeMs, d, age: st.mtimeMs }; return d; }
    catch { return null; }
  }
  function age(f) { try { return Date.now() - fs.statSync(file(f)).mtimeMs; } catch { return Infinity; } }
  function refresh(force) {
    if (running || process.env.NO_AUTO_REFRESH === '1') return;
    if (!force && age('narratives.json') < MAX_AGE) return;
    running = true; const t0 = Date.now();
    const ch = spawn('python3', ['narratives.py'], { cwd: path.join(root, 'research'), env: { ...process.env, DATA_DIR }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; ch.stderr.on('data', (b) => { err = (err + b).slice(-2000); });
    ch.on('exit', (c) => { running = false; lastErr = c ? `exit ${c}: ${err.slice(-300)}` : null; log(`narratives refresh ${c ? 'failed' : 'ok'} in ${Math.round((Date.now() - t0) / 1000)}s`); });
    ch.on('error', (e) => { running = false; lastErr = e.message; });
  }
  // ---- optional X social velocity (OFF). Would use GET /2/tweets/counts/recent (Counts: Recent, $0.005 per request,
  // 7 days of hourly counts per query) once per theme per run, writing data/narratives_x.json for research/narratives.py.
  // Runs only if BOTH the X_ON constant above is flipped to true AND NARRATIVES_X=1 is set, after the user approves the cost.
  const XQ = { privacy_zk: '(zcash OR monero OR $ZEC OR $XMR OR "dark pool" OR railgun)', zk_tech: '("zero knowledge" OR zkvm OR zkevm OR "zk rollup")', ai_agents: '("ai agent" OR "ai agents" OR virtuals OR x402)', ai_infra: '(bittensor OR $TAO OR "decentralized ai")',
    rwa: '(rwa OR "real world assets" OR "tokenized treasuries")', tokenized_stocks: '("tokenized stocks" OR xstocks)', perps_dex: '(hyperliquid OR "perp dex")', memes: '(memecoin OR memecoins)', depin: '(depin)', restaking: '(restaking OR eigenlayer)',
    prediction_markets: '(polymarket OR kalshi OR "prediction market")', stablecoin_payments: '(stablecoin OR stablecoins) payments', l2: '("layer 2" OR arbitrum OR optimism)', gaming: '(gamefi OR "web3 gaming")', quantum: '("quantum resistant" OR "post quantum") crypto' };
  async function xVelocity() {
    if (!(X_ON && process.env.NARRATIVES_X === '1' && process.env.X_BEARER_TOKEN)) return { skipped: 'off' };
    const out = { t: Date.now(), requests: 0, themes: {} };
    for (const [k, q] of Object.entries(XQ)) {
      const r = await fetch('https://api.x.com/2/tweets/counts/recent?granularity=hour&query=' + encodeURIComponent(q + ' -is:retweet lang:en'), { headers: { authorization: 'Bearer ' + process.env.X_BEARER_TOKEN }, signal: AbortSignal.timeout(20000) });
      out.requests++; if (!r.ok) { out.themes[k] = { error: 'HTTP ' + r.status }; continue; }
      const j = await r.json(); const c = (j.data || []).map((x) => x.tweet_count);
      out.themes[k] = { last24h: c.slice(-24).reduce((a, b) => a + b, 0), prior: c.slice(0, -24).reduce((a, b) => a + b, 0), priorHours: Math.max(0, c.length - 24) };
    }
    out.costUsd = +(out.requests * 0.005).toFixed(3);
    fs.writeFileSync(file('narratives_x.json'), JSON.stringify(out)); return out;
  }
  setTimeout(() => refresh(false), 90e3).unref();
  setInterval(() => refresh(false), 30 * 60e3).unref();
  return {
    api(q) {
      refresh(false);
      const d = read('narratives.json');
      if (!d) throw Object.assign(new Error('narratives.json is being generated (first run takes ~3-5 minutes), try again shortly'), { status: 503 });
      const v = read('narratives_validation.json');
      const out = { ...d, ageSec: Math.round(age('narratives.json') / 1000), refreshing: running, lastError: lastErr, xModule: { ...(d.xModule || {}), enabled: X_ON } };
      out.validation = v ? { theme: v.theme, basket: v.basket, attention: v.attention, rule: v.rule, window: v.window, days: v.days, flagDays: v.flagDays, episodes: v.episodes, flagsOutsideEpisodes: v.flagsOutsideEpisodes, sensitivity: v.sensitivity, caveats: v.caveats, generatedAt: v.generatedAt } : null;
      if (q && q.get('series') === '1' && v) out.validation.series = v.series;
      try { const sa = JSON.parse(fs.readFileSync(file('socialalt.json'), 'utf8')); out.nonX = { generatedAt: sa.generatedAt, byTheme: sa.channel?.byTheme || {}, rumors: (sa.rumors || []).slice(0, 10) }; } catch { out.nonX = null; } // non-X channel (research/socialalt.py)
      if (q && q.get('theme')) out.themes = out.themes.filter((t) => t.id === q.get('theme'));
      return out;
    },
    boosts() { return read('narratives_boost.json') || { byKey: {}, bySymbol: {} }; },
    // composite hook: boostFor('solana', mint, 'SYM') -> { boost, theme, themeStatus, why } | null
    boostFor(chain, address, symbol) {
      const b = read('narratives_boost.json'); if (!b) return null;
      return (chain && address && b.byKey?.[`${chain}:${address}`]) || (address && b.byAddress?.[address]) || (symbol && b.bySymbol?.[String(symbol).toUpperCase()]) || null;
    },
    status() { return { running, lastError: lastErr, ageSec: Math.round(age('narratives.json') / 1000), xEnabled: X_ON }; },
    xVelocity, // not scheduled anywhere; stays off until approved

    refresh,
  };
}
module.exports = { createNarratives };
