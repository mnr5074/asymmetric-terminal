// Cross-detector backtest scoreboard (research/backtest/*.py -> data/backtest_scoreboard.json) + live feedback.
// Detector registry: every detector id that can fire a live signal (lib/signalbus.js) maps to a scoreboard row. Each row carries
// separate CRASH and PUMP stats (precision, recall, hit rate on crash/pump cases vs the comparison group, median lead time,
// false flags per token-day, p-value, sample size) and a trust tier per claim (proven / weak / untested).
// effective(id) blends the backtest score with the live rolling score from lib/fplog.js and returns active/shadow status;
// shadow detectors are kept out of the live ranking and paper trading but are still logged and scored.
// The harness re-runs on a schedule (default every 6 h, BACKTEST_EVERY_H) so new live pumps/rugs ingested by fplog flow back in.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const HARD = new Set(['honeypot', 'lp_pull', 'contract_mint_authority', 'contract_freeze_authority']);
// live detector id -> scoreboard id when they differ (live variants of a backtested detector)
const ALIAS = { honeypot: 'honeypot_live', contract_mint_authority: 'contract_mint_authority', contract_freeze_authority: 'contract_freeze_authority' };

function createBacktest({ DATA_DIR, root, fplog: getFp, writer = () => true, log = () => {} }) {
  const file = path.join(DATA_DIR, 'backtest_scoreboard.json');
  let SB = null, SBt = 0, byId = {};
  function load() {
    try { const st = fs.statSync(file); if (st.mtimeMs !== SBt) { SB = JSON.parse(fs.readFileSync(file, 'utf8')); SBt = st.mtimeMs; byId = Object.fromEntries((SB.detectors || []).map((d) => [d.id, d])); } } catch { SB = SB || null; }
    return SB;
  }
  const row = (id) => { load(); return byId[ALIAS[id] && byId[ALIAS[id]] ? ALIAS[id] : id] || byId[id] || null; };
  function effective(id) {
    const b = row(id); const fp = getFp?.()?.detectorState?.(id) || null;
    let score = b ? b.score : (id.startsWith('pl_') ? 0.35 : 0.32);
    const tierB = b ? b.trust : 'untested';
    let liveW = 0;
    if (fp && fp.ewN >= 3 && fp.rollingLift != null) { liveW = Math.min(0.7, fp.ewN / 30); const liveScore = Math.max(0, Math.min(1, 0.4 + (fp.rollingLift - 1) * 0.4)); score = (1 - liveW) * score + liveW * liveScore; }
    let tier = tierB;
    if (fp && fp.ewN >= 15 && fp.rollingLift != null) tier = fp.rollingLift >= 1.5 && tierB !== 'untested' ? 'proven' : fp.rollingLift >= 1.15 ? (tierB === 'proven' ? 'proven' : 'weak') : 'weak';
    const hard = HARD.has(id);
    let status = fp?.status || (b && b.trust === 'weak' && b.edge === false && !hard ? 'shadow' : 'active');
    if (hard) status = 'active';
    return { id, score: +score.toFixed(3), tier, backtestTier: tierB, status, hard, rebuild: !!fp?.rebuild || (status === 'shadow'), why: fp?.why || (status === 'shadow' ? 'backtest: tested, no reliable edge' : null), liveWeight: +liveW.toFixed(2), backtest: b, live: fp };
  }
  function line(id) {
    const b = row(id); if (!b) return 'not backtested yet';
    const s = b[b.claim === 'pump' ? 'pump' : 'crash'] || {}; const bits = [];
    if (s.precision != null) bits.push(`precision ${Math.round(s.precision * 100)}%`); if (s.lift != null) bits.push(`${s.lift.toFixed(1)}x base`); if (s.auc != null) bits.push(`AUC ${s.auc}`);
    if (s.n_events != null) bits.push(`n=${s.n_events}`); if (s.p != null) bits.push(`p=${s.p < 0.001 ? '<0.001' : s.p.toFixed(3)}`); if (s.median_lead_h != null) bits.push(`lead ${s.median_lead_h >= 48 ? Math.round(s.median_lead_h / 24) + 'd' : Math.round(s.median_lead_h) + 'h'}`);
    const other = b[b.claim === 'pump' ? 'crash' : 'pump'];
    const warn = other && other.trust === 'proven' && other.edge && other.lift > 1.5 ? ` — note: it predicts ${b.claim === 'pump' ? 'CRASHES' : 'PUMPS'} too (${other.lift.toFixed(1)}x base, precision ${Math.round((other.precision || 0) * 100)}%)` : '';
    return `backtest ${b.trust}${b.edge === false ? ' (no edge)' : ''}: ${bits.join(', ') || b.trust_why}${warn}`;
  }
  // ---- scheduled re-run ----
  let running = false, lastRun = null;
  function rerun(force = false) {
    if (running || !writer()) return false;
    let age = Infinity; try { age = Date.now() - fs.statSync(file).mtimeMs; } catch {}
    const every = +(process.env.BACKTEST_EVERY_H || 6) * 3600e3; if (!force && age < every) return false;
    const lock = path.join(DATA_DIR, '.backtest_run.lock'); try { const st = fs.statSync(lock); if (Date.now() - st.mtimeMs < 20 * 60e3) return false; } catch {}
    fs.writeFileSync(lock, String(process.pid)); running = true; const t0 = Date.now();
    const ch = spawn('python3', [path.join(root, 'research', 'backtest', 'run.py')], { cwd: path.join(root, 'research', 'backtest'), env: { ...process.env, DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
    ch.on('exit', (code) => { running = false; lastRun = { t: Date.now(), ms: Date.now() - t0, code, tail: out.slice(-400) }; try { fs.unlinkSync(lock); } catch {} log(`backtest rerun exit ${code} in ${Math.round((Date.now() - t0) / 1000)}s`); });
    ch.on('error', () => { running = false; try { fs.unlinkSync(lock); } catch {} });
    return true;
  }
  function api(q) {
    const sb = load(); if (!sb) throw Object.assign(new Error('data/backtest_scoreboard.json not generated yet: python3 research/backtest/run.py'), { status: 503 });
    const dets = sb.detectors.map((d) => { const e = effective(d.id); return { ...d, status: e.status, rebuild: e.rebuild, statusWhy: e.why, effectiveScore: e.score, effectiveTier: e.tier, live: e.live ? { n: e.live.n, hits: e.live.hits, rollingPrecision: e.live.rollingPrecision, rollingLift: e.live.rollingLift, ewN: e.live.ewN, smartFollowRate: e.live.smartFollowRate, liqHeldRate: e.live.liqHeldRate, cexListRate: e.live.cexListRate, history: e.live.history } : null }; });
    const claimed = (d) => d[d.claim === 'pump' ? 'pump' : 'crash'] || {};
    const tested = dets.filter((d) => d.trust !== 'untested');
    const top = [...tested].sort((a, b) => b.effectiveScore - a.effectiveScore).slice(0, 8).map((d) => d.id);
    const worst = [...tested].filter((d) => claimed(d).lift != null).sort((a, b) => (claimed(a).lift ?? 1) - (claimed(b).lift ?? 1)).slice(0, 8).map((d) => d.id);
    const fp = getFp?.(); const conf = fp?.detectorState?.('confluence');
    const id = q?.get?.('id'); if (id) return dets.find((d) => d.id === id) || effective(id);
    return { ...sb, detectors: dets, top, worst, status: { active: dets.filter((d) => d.status === 'active').length, shadow: dets.filter((d) => d.status === 'shadow').map((d) => d.id), rebuild: dets.filter((d) => d.rebuild).map((d) => d.id) },
      confluence: { ...sb.confluence, live: conf ? { n: conf.n, hits: conf.hits, rollingPrecision: conf.rollingPrecision, rollingLift: conf.rollingLift } : null }, rerun: { running, lastRun, everyH: +(process.env.BACKTEST_EVERY_H || 6) },
      label: 'Research statistics from free historical data. Not financial advice.' };
  }
  return { load, row, effective, line, rerun, api, confluenceMultiplier: () => { const s = load(); const live = getFp?.()?.detectorState?.('confluence'); if (live && live.n >= 30 && live.rollingLift) return Math.max(1, Math.min(3, live.rollingLift)); return s?.confluence?.rank_multiplier || 1.5; } };
}
module.exports = { createBacktest, HARD };
