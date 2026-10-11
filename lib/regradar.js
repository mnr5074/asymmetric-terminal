'use strict';
// Regulatory Radar (additive): crypto-regulation news radar + flow cross-reference + historical event study.
// Data: research/regradar.py -> data/regradar.json (live, refreshed ~every 30 min) and data/regradar_study.json (event study, ~daily).
// Free sources only (Google News RSS, regulator RSS, GDELT, public exchange tickers, DefiLlama, pytrends). Alerts are stored locally
// in data/regradar_alerts.json; nothing is pushed externally.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LIVE_MAX_AGE = 30 * 60e3;
const STUDY_MAX_AGE = 24 * 3600e3;

function createRegRadar({ DATA_DIR, log = () => {} }) {
  const files = { live: path.join(DATA_DIR, 'regradar.json'), study: path.join(DATA_DIR, 'regradar_study.json'), alerts: path.join(DATA_DIR, 'regradar_alerts.json') };
  const docs = {}, mt = {};
  let running = null, lastSpawn = { live: 0, study: 0 };
  function read(k) {
    try { const st = fs.statSync(files[k]); if (st.mtimeMs !== mt[k]) { docs[k] = JSON.parse(fs.readFileSync(files[k], 'utf8')); mt[k] = st.mtimeMs; } return { doc: docs[k], age: Date.now() - st.mtimeMs }; }
    catch { return { doc: null, age: Infinity }; }
  }
  function refresh(kind) {
    if (running || process.env.NO_AUTO_REFRESH === '1' || process.env.REGRADAR === 'off') return;
    if (Date.now() - lastSpawn[kind] < 20 * 60e3) return;
    running = kind; lastSpawn[kind] = Date.now();
    const ch = spawn('nice', ['-n', '10', 'python3', 'regradar.py', kind], { cwd: path.join(__dirname, '..', 'research'), env: { ...process.env, DATA_DIR }, stdio: 'ignore' });
    ch.on('exit', (c) => { running = null; log(`regradar ${kind} refresh exit ${c}`); });
    ch.on('error', () => { running = null; });
  }
  function maybeRefresh() {
    const L = read('live'), S = read('study');
    if (L.age > LIVE_MAX_AGE) refresh('live'); else if (S.age > STUDY_MAX_AGE) refresh('study');
    return { L, S };
  }
  function live(q) {
    const { L } = maybeRefresh();
    if (!L.doc) throw Object.assign(new Error('regradar.json is being generated (first live run ~3 min); try again shortly'), { status: 503 });
    const d = L.doc; const minSev = +(q.get('minsev') || 0); const c = q.get('country');
    let items = d.items || [];
    if (minSev) items = items.filter((x) => x.severity >= minSev);
    if (c) items = items.filter((x) => x.country === c.toUpperCase());
    if (q.get('full') !== '1') items = items.slice(0, +(q.get('limit') || 150));
    return { ...d, items, ageSec: Math.round(L.age / 1000), refreshing: running };
  }
  function study(q) {
    const { S } = maybeRefresh();
    if (!S.doc) throw Object.assign(new Error('regradar_study.json not generated yet (run python3 research/regradar.py study, ~5-10 min)'), { status: 503 });
    if (q.get('full') === '1') return { ...S.doc, ageSec: Math.round(S.age / 1000) };
    const { gdelt, ...rest } = S.doc;
    const g = {}; for (const [k, v] of Object.entries(gdelt || {})) g[k] = { query: v.query, total_articles: v.total_articles, monthly: v.monthly, spikes: (v.spikes || []).map(({ headlines, ...s }) => ({ ...s, headline: headlines && headlines[0] })) };
    return { ...rest, gdelt: g, ageSec: Math.round(S.age / 1000), refreshing: running };
  }
  function alerts() { try { return { alerts: JSON.parse(fs.readFileSync(files.alerts, 'utf8')).slice(-100).reverse() }; } catch { return { alerts: [] }; } }
  return {
    routes: () => ({ '/api/regradar': async (q) => live(q), '/api/regradar/study': async (q) => study(q), '/api/regradar/alerts': async () => alerts() }),
    status: () => ({ live: !!read('live').doc, study: !!read('study').doc, refreshing: running }),
  };
}
module.exports = { createRegRadar };
