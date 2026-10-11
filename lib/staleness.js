'use strict';
// (7) Data staleness monitor / feed health. Instruments every data/*.json writer (mtime, size, content hash, learned update cadence)
// plus in-memory module snapshots registered as probes (live feed, perps, liquidations, price gaps, ...). Status per feed:
//   green  age < 2x expected interval     yellow  2-3x, or identical content on >=3 consecutive writes / probe checks
//   red    > 3x expected, or empty payload   learning  cadence not known yet (needs 3 observed writes)   static  one-off file
// Also records server boots (data/riskinfra_boots.json) and parses watchdog.log restarts; >=3 restarts/hour = crash loop (red).
// Transitions to red / recoveries are appended to data/riskinfra_alerts.json (and sent through alerts.notice when RISKINFRA_NOTIFY=1).
// /api/feedhealth returns feeds + a panel->status map the UI uses to put a 'stale' badge on panels so silence isn't mistaken for calm.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const M = 60e3, H = 3600e3;
// Known writers: [file or /regex/, expected interval ms, writer, UI panels fed]
const KNOWN = [
  ['live_feed.json', 3 * M, 'lib/livefeed.js (60s cycle)', ['ccLive', 'ccSlow', 'ccWatch']], ['live_state.json', 10 * M, 'lib/livefeed.js (every 5 cycles)'],
  ['perps.json', 2 * M, 'lib/perps.js (2 min)', ['perpDesk']], ['perps_universe.json', 6 * H, 'lib/perps.js universe'],
  ['liquidations.json', 1 * M, 'lib/liquidations.js (60s persist)'], ['liquidations_events.json', 1 * M, 'lib/liquidations.js'],
  ['pricegaps.json', 1.5 * M, 'lib/pricegaps.js (45s poll)'], ['poolwatch.json', 15 * M, 'lib/poolwatch.js (15 min)'],
  ['derive_snapshot.json', 3 * M, 'lib/derive.js (3 min poll)', ['dvOut']], ['fakevolume_live.json', 20 * M, 'lib/fakevolume.js (20 min)'],
  ['priority.json', 30 * M, 'research/priority.py via lib/priority.js (30 min)'], ['fundingdiv.json', 1 * M, 'lib/fundingdiv.js'],
  ['options.json', 30 * M, 'research/options.py (refreshed on request, 30 min)', ['ccOpt']], ['airdrops.json', 6 * H, 'research/airdrops.py (on request, 6h)', ['ccAir']],
  ['sleepers.json', 24 * H, 'research/sleepers.py (on request, 24h)', ['ccSleep']], ['stables.json', 6 * H, 'research/stables.py via lib/stables.js (6h)', ['ccStables']],
  ['narratives.json', 3 * H, 'research/narratives.py via lib/narratives.js (3h)', ['narrPanel']], ['unlocks.json', 12 * H, 'research/unlocks.py via lib/unlocks.js (12h)'],
  ['devactivity_map.json', 24 * H, 'research/devactivity.py (24h)'], ['net_supply.json', 12 * H, 'lib/unlocks.js'],
  ['riskinfra_oracles.json', 10 * M, 'research/riskinfra/oracles.py via lib/oracles.js (10 min)', ['riOracles']],
  ['riskinfra_dependencies.json', 15 * M, 'research/riskinfra/dependencies.py via lib/dependencies.js (15 min)', ['riDeps']],
  ['riskinfra_otcflow.json', 30 * M, 'research/riskinfra/otcflow.py via lib/otcflow.js (30 min)', ['riOtc']],
  ['riskinfra_lending.json', 30 * M, 'research/riskinfra/lending.py (shared, 30 min)'],
];
// files that change only on user action / events: never alert on age
const EVENT_DRIVEN = /^(alerts_state|alerts\.log|calls|portfolio|nansen_|x_budget|x_cache|desks|insider_watch|perps_watch|copytrade_|sandwich_log|mev|tax|riskinfra_boots|riskinfra_alerts|riskinfra_staleness|riskinfra_.*_history|.*\.lock$)/;

function createStaleness({ DATA_DIR, root, log = () => {}, probes = {}, notify = null, scanMs = 60e3 }) {
  const stFile = path.join(DATA_DIR, 'riskinfra_staleness.json');
  const bootFile = path.join(DATA_DIR, 'riskinfra_boots.json');
  const alertFile = path.join(DATA_DIR, 'riskinfra_alerts.json');
  const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeJ = (f, v) => { try { fs.writeFileSync(f + '.tmp', JSON.stringify(v)); fs.renameSync(f + '.tmp', f); } catch (e) { log('staleness write ' + e.message); } };
  const S = readJ(stFile, {}) || {}; S.files ||= {}; S.mem ||= {};
  const boots = (readJ(bootFile, { boots: [] }) || { boots: [] }).boots || [];
  const BOOT = Date.now();
  boots.push({ t: BOOT, pid: process.pid, port: +process.env.PORT || 8000 }); writeJ(bootFile, { boots: boots.slice(-300) });
  let alerts = (readJ(alertFile, { alerts: [] }) || {}).alerts || [];
  let last = { feeds: [], generatedAt: 0 }, timer = null;
  const known = (f) => KNOWN.find(([k]) => (k instanceof RegExp ? k.test(f) : k === f));

  function hashFile(p, size) {
    const h = crypto.createHash('sha1');
    if (size <= 8 * 1024 * 1024) h.update(fs.readFileSync(p));
    else { const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(262144); fs.readSync(fd, b, 0, b.length, 0); h.update(b); fs.readSync(fd, b, 0, b.length, Math.max(0, size - b.length)); h.update(b); fs.closeSync(fd); h.update(String(size)); }
    return h.digest('hex').slice(0, 16);
  }
  function isEmpty(p, size) {
    if (size < 3) return 'empty file';
    if (size > 2 * 1024 * 1024) return null;
    let d; try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } // mid-write or non-JSON: not judged
    if (d == null || (Array.isArray(d) && !d.length) || (typeof d === 'object' && !Array.isArray(d) && !Object.keys(d).length)) return 'empty JSON';
    if (typeof d === 'object' && !Array.isArray(d)) {
      const ks = ['items', 'tokens', 'events', 'assets', 'picks', 'data', 'reserves', 'pairs'].filter((k) => Array.isArray(d[k]));
      if (ks.length && ks.every((k) => !d[k].length)) return `empty ${ks.join('/')}`;
    }
    return null;
  }
  function grade(age, exp) {
    if (!exp) return 'learning';
    const r = age / exp; return r < 2 ? 'green' : r <= 3 ? 'yellow' : 'red';
  }
  function scanFiles(now) {
    let names = []; try { names = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json') || f.endsWith('.log')); } catch {}
    const out = [];
    for (const f of names) {
      const p = path.join(DATA_DIR, f); let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      const r = (S.files[f] ||= { deltas: [], identical: 0 });
      if (r.mtime !== st.mtimeMs) {
        let hash = null; try { hash = f.endsWith('.json') ? hashFile(p, st.size) : null; } catch {}
        if (r.mtime) { r.deltas = [...r.deltas, st.mtimeMs - r.mtime].filter((x) => x > 1000).slice(-12); r.identical = hash && hash === r.hash ? r.identical + 1 : 0; }
        r.mtime = st.mtimeMs; r.hash = hash; r.size = st.size; r.empty = f.endsWith('.json') ? isEmpty(p, st.size) : null;
      }
      const k = known(f); const age = now - st.mtimeMs;
      const learned = r.deltas.length >= 3 ? r.deltas.slice().sort((a, b) => a - b)[Math.floor(r.deltas.length / 2)] : null;
      const exp = k ? k[1] : learned ? Math.max(learned, 30e3) : null;
      let status, reason;
      if (EVENT_DRIVEN.test(f)) { status = 'event'; reason = 'written on events / user actions (no cadence)'; }
      else if (!exp) { status = age > 3 * 24 * H ? 'static' : 'learning'; reason = status === 'static' ? 'one-off / research output (no cadence observed)' : 'cadence not learned yet'; }
      else {
        status = grade(age, exp); reason = `last write ${fmt(age)} ago, expected every ${fmt(exp)}${k ? '' : ' (learned)'}`;
        if (r.empty) { status = 'red'; reason = r.empty + ' - ' + reason; }
        else if (r.identical >= 3 && status === 'green') { status = 'yellow'; reason = `identical content on last ${r.identical} writes`; }
      }
      out.push({ id: 'file:' + f, kind: 'file', file: f, writer: k ? k[2] : null, panels: k ? k[3] || [] : [], expectedMs: exp, learnedMs: learned, ageMs: age, ratio: exp ? +(age / exp).toFixed(2) : null,
        size: st.size, identicalWrites: r.identical, empty: r.empty || null, status, reason, updatedAt: st.mtimeMs });
    }
    for (const f of Object.keys(S.files)) if (!names.includes(f)) delete S.files[f];
    return out;
  }
  function scanMem(now) {
    const out = [];
    for (const [id, p] of Object.entries(probes)) {
      let v = null, err = null; try { v = p.fn(); } catch (e) { err = e.message; }
      const r = (S.mem[id] ||= { same: 0 });
      const t = v && v.t ? +v.t : null;
      if (v && v.sig != null) { const sg = typeof v.sig === 'string' ? v.sig : JSON.stringify(v.sig); if (t && t !== r.t) { r.same = sg === r.sig ? r.same + 1 : 0; r.sig = sg; } }
      if (t) r.t = t;
      const ref = t || BOOT; const age = now - ref;
      let status = grade(age, p.expectedMs), reason = t ? `last update ${fmt(age)} ago, expected every ${fmt(p.expectedMs)}` : `no update since boot ${fmt(age)} ago`;
      if (err) { status = 'red'; reason = 'probe error: ' + err; }
      else if (!t && age < 2 * p.expectedMs) { status = 'learning'; reason = 'warming up after boot'; }
      else if (v && v.n === 0) { status = 'red'; reason = 'empty (0 items) - ' + reason; }
      else if (r.same >= 5 && status === 'green') { status = 'yellow'; reason = `identical data on last ${r.same} updates`; }
      out.push({ id: 'mem:' + id, kind: 'memory', label: p.label || id, panels: p.panels || [], expectedMs: p.expectedMs, ageMs: age, ratio: +(age / p.expectedMs).toFixed(2), count: v ? v.n : null, identicalUpdates: r.same, status, reason, updatedAt: t });
    }
    return out;
  }
  function restarts(now) {
    const b = boots.filter((x) => now - x.t < 24 * H && (x.port || 8000) === (+process.env.PORT || 8000));
    let wd = [];
    try {
      const L = fs.readFileSync(path.join(root, 'watchdog.log'), 'utf8').split('\n').slice(-500);
      for (const l of L) { const m = l.match(/^(\w{3} \w{3} +\d+ [\d:]+) \w+ (\d{4}) restarted server/); if (m) { const t = Date.parse(`${m[1]} ${m[2]}`); if (t) wd.push(t); } }
    } catch {}
    let watchdogAlive = false;
    try { for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) { try { const cl = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); if (cl.includes('watchdog.sh') || cl.includes('supervisor.js')) { watchdogAlive = true; break; } } catch {} } } catch {}
    // scripts/supervisor.js restart log (data/restarts.json): unplanned (exit/signal/hung) vs planned (scripts/restart-server.sh)
    const myPort = +process.env.PORT || 8000;
    const rl = ((readJ(path.join(DATA_DIR, 'restarts.json'), {}) || {}).restarts || []).filter((r) => (r.port || 8000) === myPort && now - (r.upAt || r.t) < 24 * H);
    const un = rl.filter((r) => r.unplanned); const un1 = un.filter((r) => now - (r.upAt || r.t) < H).length;
    const sup = readJ(path.join(DATA_DIR, 'supervisor.json'), null);
    for (const r of rl) wd.push(r.upAt || r.t); // keep the legacy counters meaningful
    const wd1 = wd.filter((t) => now - t < H).length, wd24 = wd.filter((t) => now - t < 24 * H).length;
    const boots1 = b.filter((x) => now - x.t < H).length;
    const plannedBoots1 = rl.filter((r) => !r.unplanned && now - (r.upAt || r.t) < H).length;
    const status = un1 >= 3 || (sup ? false : wd1 >= 3) || boots1 - plannedBoots1 >= 4 ? 'red' : un1 >= 1 || (!sup && wd1 >= 1) ? 'yellow' : 'green';
    return { status, uptimeMs: now - BOOT, bootAt: BOOT, pid: process.pid, bootsLast1h: boots1, bootsLast24h: b.length, watchdogRestartsLast1h: wd1, watchdogRestartsLast24h: wd24,
      lastWatchdogRestart: wd.length ? Math.max(...wd) : null, watchdogAlive,
      unplannedLast1h: un1, unplannedLast24h: un.length, plannedLast24h: rl.length - un.length, lastUnplanned: un[un.length - 1] || null,
      supervisor: sup ? { pid: sup.pid, mode: sup.mode, volatileReason: sup.volatileReason, profile: sup.profile, adopted: sup.adopted, supervisesMe: sup.childPid === process.pid } : null,
      reason: status === 'red' ? `crash loop: ${un1} unplanned restarts / ${boots1} boots in the last hour` : status === 'yellow' ? `unplanned restart in the last hour (${un1}${un[un.length - 1] ? ': ' + un[un.length - 1].reason : ''})` : 'stable' };
  }
  function fmt(ms) { if (ms == null) return '?'; const s = ms / 1000; return s < 90 ? Math.round(s) + 's' : s < 5400 ? Math.round(s / 60) + 'm' : s < 172800 ? (s / 3600).toFixed(1) + 'h' : (s / 86400).toFixed(1) + 'd'; }
  const RANK = { red: 3, yellow: 2, green: 1, learning: 0, static: 0, event: 0 };
  function scan() {
    const now = Date.now();
    const feeds = [...scanMem(now), ...scanFiles(now)];
    const rs = restarts(now);
    const prev = new Map((last.feeds || []).map((f) => [f.id, f.status]));
    for (const f of feeds) {
      const p = prev.get(f.id);
      if (p && p !== f.status && (f.status === 'red' || (p === 'red' && f.status === 'green'))) {
        const a = { t: now, id: f.id, from: p, to: f.status, reason: f.reason };
        alerts.push(a); log(`[feedhealth] ${f.id} ${p} -> ${f.status}: ${f.reason}`);
        if (notify && process.env.RISKINFRA_NOTIFY === '1') try { notify('feed-' + f.id + '-' + f.status + '-' + Math.floor(now / H), `Feed ${f.id} is ${f.status.toUpperCase()}: ${f.reason}`); } catch {}
      }
    }
    if (last.restarts && last.restarts.status !== rs.status && rs.status === 'red') alerts.push({ t: now, id: 'server', from: last.restarts.status, to: 'red', reason: rs.reason });
    alerts = alerts.slice(-300);
    const panels = {};
    for (const f of feeds) for (const p of f.panels || []) { const c = panels[p]; if (!c || RANK[f.status] > RANK[c.status]) panels[p] = { status: f.status, feed: f.id, ageMs: f.ageMs, reason: f.reason }; }
    const summary = {}; for (const f of feeds) summary[f.status] = (summary[f.status] || 0) + 1;
    last = { generatedAt: now, summary, restarts: rs, panels, feeds: feeds.sort((a, b) => RANK[b.status] - RANK[a.status] || (b.ratio || 0) - (a.ratio || 0)) };
    S.savedAt = now; writeJ(stFile, S); writeJ(alertFile, { alerts });
    return last;
  }
  function start() { if (timer) return; setTimeout(scan, 5000).unref?.(); timer = setInterval(scan, scanMs); timer.unref?.(); }
  function api(q) {
    const d = last.generatedAt && Date.now() - last.generatedAt < scanMs * 1.5 ? last : scan();
    const f = q && q.get && q.get('status');
    return { ...d, feeds: f ? d.feeds.filter((x) => f.split(',').includes(x.status)) : d.feeds, alerts: alerts.slice(-40).reverse(),
      legend: { green: '< 2x expected interval', yellow: '2-3x, or identical data repeated', red: '> 3x, empty payload, or probe error', learning: 'cadence not learned yet', static: 'one-off file', event: 'event-driven (not judged)' } };
  }
  return { start, scan, api, addProbe: (id, p) => { probes[id] = p; } };
}
module.exports = { createStaleness };
