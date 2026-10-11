'use strict';
// Terminal uptime / restart monitor (server side of scripts/supervisor.js).
// Reads data/restarts.json (written by the supervisor: time, reason, kind exit|signal|hung|planned, downtimeS) and data/supervisor.json.
//  - GET /api/health/detail: uptime, supervisor state + probe profile (normal / volatile), secrets present (booleans only), restart history,
//    banner when an UNPLANNED restart happened in the last hour (shown on the Command view).
//  - Alerts: each unplanned restart of THIS port goes into the alert queue (data/alerts.log via lib/alerts.js) and is texted through the
//    existing SMS/email path at most once per 30 min ("Asymmetric Terminal restarted at HH:MM PT after N s down: reason").
//    Planned restarts (scripts/restart-server.sh) never alert. Only the instance whose PORT matches the record handles it (test servers on
//    other ports sharing data/ stay silent). State: data/restart_alerts_state.json (written only here).
const fs = require('fs');
const path = require('path');

const SECRETS = ['XAI_API_KEY', 'X_BEARER_TOKEN', 'NANSEN_API_KEY'];
function createUptime({ DATA_DIR, alerts, log = () => {}, port = +process.env.PORT || 8000 }) {
  const BOOT = Date.now();
  const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return d; } };
  const stFile = path.join(DATA_DIR, 'restart_alerts_state.json');
  const TEXT_GAP_MS = 30 * 60e3;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const hhmm = (t) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t));
  const restarts = () => ((readJ('restarts.json', {}) || {}).restarts || []).filter((r) => (r.port || 8000) === port);
  function supervisor() {
    const s = readJ('supervisor.json', null); if (!s) return { alive: false, note: 'data/supervisor.json missing (supervisor never started)' };
    let ok = false; try { ok = alive(s.pid) && fs.readFileSync(`/proc/${s.pid}/cmdline`, 'utf8').includes('supervisor.js'); } catch {}
    return { alive: ok, pid: s.pid, port: s.port, startedAt: s.startedAt, childPid: s.childPid, adopted: s.adopted, supervisesMe: s.childPid === process.pid,
      mode: s.mode, volatileReason: s.volatileReason, profile: s.profile, lastOk: s.lastOk, lastProbeMs: s.lastProbeMs, consecutiveFails: s.fails, crashStreak: s.crashStreak, envOk: s.envOk, updatedAt: s.updatedAt };
  }
  function detail() {
    const now = Date.now(); const rs = restarts();
    const un = rs.filter((r) => r.unplanned); const u1 = un.filter((r) => now - r.upAt < 3600e3);
    const last = un[un.length - 1] || null;
    const banner = u1.length ? { t: last.t, upAt: last.upAt, text: `Terminal restarted unexpectedly at ${hhmm(last.t)} PT after ${Math.round(last.downtimeS)}s down: ${last.reason}${u1.length > 1 ? ` (${u1.length} unplanned restarts in the last hour)` : ''}` } : null;
    return { ok: true, time: new Date(now).toISOString(), pid: process.pid, port, bootAt: BOOT, uptimeS: Math.round((now - BOOT) / 1000), node: process.version,
      env: Object.fromEntries(SECRETS.map((k) => [k, !!process.env[k]])),
      supervisor: supervisor(),
      restarts: { unplannedLast1h: u1.length, unplannedLast24h: un.filter((r) => now - r.upAt < 86400e3).length, plannedLast24h: rs.filter((r) => !r.unplanned && now - r.upAt < 86400e3).length,
        lastUnplanned: last, lastAny: rs[rs.length - 1] || null, recent: rs.slice(-20).reverse() },
      banner };
  }
  async function check() {
    let S = { done: {}, lastText: 0 }; try { S = { ...S, ...JSON.parse(fs.readFileSync(stFile, 'utf8')) }; } catch {}
    const now = Date.now(); let changed = false;
    for (const r of restarts()) {
      const id = `restart-${port}-${r.t}`;
      if (!r.unplanned || S.done[id]) continue;
      S.done[id] = now; changed = true;
      if (now - r.upAt > 2 * 3600e3) continue; // history from before this feature / long ago: record, don't alert
      const text = `Asymmetric Terminal restarted at ${hhmm(r.t)} PT after ${Math.round(r.downtimeS)}s down: ${r.reason}`.slice(0, 159);
      if (now - (S.lastText || 0) < TEXT_GAP_MS) { alerts.queue('restart', id, text, 'queued only: restart texts capped at 1 per 30 min'); log('restart alert (queued, cap): ' + text); }
      else { S.lastText = now; const e = await alerts.notice(id, text); log('restart alert: ' + text + ' -> ' + (e && e.status)); }
    }
    for (const k of Object.keys(S.done)) if (now - S.done[k] > 7 * 86400e3) { delete S.done[k]; changed = true; }
    if (changed) { try { fs.writeFileSync(stFile + '.tmp', JSON.stringify(S)); fs.renameSync(stFile + '.tmp', stFile); } catch (e) { log('restart state ' + e.message); } }
  }
  function start() { setTimeout(() => check().catch((e) => log('restart check ' + e.message)), 8000).unref?.(); setInterval(() => check().catch((e) => log('restart check ' + e.message)), 30e3).unref?.(); }
  return { start, detail, check, routes: { async '/api/health/detail'() { return detail(); } } };
}
module.exports = { createUptime };
