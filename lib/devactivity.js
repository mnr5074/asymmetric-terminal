'use strict';
// Developer-activity desk: GitHub commit frequency / silence / burst flags per token.
// Data: research/devactivity.py -> data/devactivity.json (refreshed ~24h; free GitHub git-over-HTTPS + public pages, CoinGecko links).
// Composite factor `dev` (lib/composite.js): small weight; direction from data/devactivity.json backtest. Estimates, not advice.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const MAX_AGE = 24 * 3600e3;

function createDevActivity({ DATA_DIR, log = () => {} }) {
  let d = null, t = 0, running = false, bySym = new Map(), byId = new Map();
  function load() {
    const f = path.join(DATA_DIR, 'devactivity.json');
    try { const st = fs.statSync(f); if (st.mtimeMs !== t) { d = JSON.parse(fs.readFileSync(f, 'utf8')); t = st.mtimeMs; bySym = new Map(); byId = new Map();
      for (const r of d.live || []) { byId.set(r.id, r); const s = String(r.symbol || '').toUpperCase(); if (s && r.verified && !bySym.has(s)) bySym.set(s, r); } } } catch { /* not generated yet */ }
    if ((!d || Date.now() - (d.generatedAt || 0) > MAX_AGE) && !running && process.env.NO_AUTO_REFRESH !== '1' && process.env.DEVACTIVITY_REFRESH === '1') {
      running = true; // opt-in background refresh (full run takes ~1h on free limits)
      const ch = spawn('python3', ['devactivity.py', 'all'], { cwd: path.join(__dirname, '..', 'research'), env: { ...process.env, DATA_DIR }, stdio: 'ignore' });
      ch.on('exit', () => { running = false; t = 0; }); ch.on('error', () => { running = false; });
    }
    return d;
  }
  const find = ({ cgId, sym } = {}) => { load(); return (cgId && byId.get(cgId)) || (sym && bySym.get(String(sym).toUpperCase())) || null; };
  // Composite factor (0-100, 50 neutral). Only verified repos. Silence after prior activity = mild negative; burst = mild positive;
  // the size is scaled down unless the backtest found a significant effect (cluster-permutation p < 0.05).
  function factor(q) {
    const r = find(q); if (!r || !r.verified) return null;
    const T = load()?.tests || {};
    const sig = (k) => { const x = T[k]; return x && x.cluster_perm_p_mean != null && x.cluster_perm_p_mean < 0.05 ? x : null; };
    const silT = sig('silence_onset_30d -> 90d'), burT = sig('burst -> 30d');
    let s = 50; const bits = [];
    const f = r.frequency_score;
    bits.push(`${r.commits_90d} commits / ${r.contributors_90d} contributors in 90d across ${r.repos.length} repo(s); last commit ${r.days_since_last_commit}d ago; frequency score ${f}/100`);
    if (r.silence && r.previously_active) { const pen = r.silence === 'silent_60d' ? 12 : r.silence === 'silent_30d' ? 9 : 5; s -= silT ? pen : pen / 2; bits.push(`went quiet (${r.silence.replace('_', ' ')}) after being active`); }
    else if (f != null) s += (f - 50) * 0.08;
    if (r.burst) { s += burT ? 6 : 3; bits.push(`commit burst: ${r.commits_7d} in 7d vs ${r.avg_weekly_prev8}/wk avg`); }
    const ev = silT || burT ? ' Backtest found a significant effect for ' + [silT && 'silence', burT && 'bursts'].filter(Boolean).join(' and ') + '.' : ' Our backtest found no statistically significant price edge from these flags, so this factor is deliberately small.';
    return { score: Math.max(25, Math.min(70, s)), value: r.silence ? `${r.silence.replace('_', ' ')}` : r.burst ? 'burst' : `freq ${f}`, text: `Developer activity (GitHub): ${bits.join('; ')}.${ev}` };
  }
  function api(q) {
    const x = load(); if (!x) return { ok: false, note: 'data/devactivity.json not generated yet: run python3 research/devactivity.py all' };
    const id = q?.get?.('id'), sym = q?.get?.('sym'), flag = q?.get?.('flag');
    if (id || sym) { const r = find({ cgId: id, sym }); return { ok: !!r, item: r, case: x.cases?.[id] || null }; }
    let live = x.live || [];
    if (flag === 'silent') live = x.live_silent; else if (flag === 'burst') live = x.live_bursting;
    return { ok: true, generatedAt: x.generatedAt, coverage: x.coverage, definitions: x.definitions, tests: Object.fromEntries(Object.entries(x.tests || {}).map(([k, v]) => [k, { ...v, events: (v.events || []).slice(0, 30) }])),
      subgroups: x.subgroups, live_silent: (x.live_silent || []).map(slim), live_bursting: (x.live_bursting || []).map(slim), items: live.map(slim), cases: x.cases, nfa: 'Research from public GitHub data. Not financial advice.' };
  }
  const slim = (r) => { const { weekly_commits_26w, cg_developer_data, ...o } = r; return { ...o, weekly: weekly_commits_26w }; };
  return { load, find, factor, api };
}
module.exports = { createDevActivity };
