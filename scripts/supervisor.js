#!/usr/bin/env node
// Asymmetric Terminal supervisor (replaces the old polling scripts/watchdog.sh).
//   node scripts/supervisor.js            run the supervisor (one per port; refuses to start if another is alive)
//   node scripts/supervisor.js restart "why"   planned restart (what scripts/restart-server.sh calls): marker + SIGTERM to the exact child PID
//   node scripts/supervisor.js status     print supervisor state
// Design: spawns scripts/run-server.sh (sources .env, execs node server.js, so child PID == node PID) and restarts it the moment it exits
// (exponential backoff only for rapid crash loops). A health probe (/api/health, any HTTP answer = alive) catches hangs: N consecutive
// failures -> SIGTERM then SIGKILL of that exact PID (never pattern kills). Volatile windows (lib/seasonality live state, fresh liquidation
// cascade in data/liquidations.json) switch to the aggressive profile. Every restart is appended to data/restarts.json with reason + downtime;
// a fresh data/restart_planned.json marker makes it 'planned'. If something else already serves the port (a worker started a server by hand)
// it is adopted (watched by PID + probe) instead of spawning a duplicate that would die with EADDRINUSE.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const PORT = +(process.env.SUP_PORT || 8000);
const STATE = path.join(DATA, 'supervisor.json');
const LOGF = path.join(DATA, 'restarts.json');
const MARK = path.join(DATA, 'restart_planned.json');
const TXT = path.join(ROOT, 'watchdog.log');
const SECRETS = ['XAI_API_KEY', 'X_BEARER_TOKEN', 'NANSEN_API_KEY'];
const P = {
  normal: { probeMs: +(process.env.SUP_PROBE_MS || 5000), timeoutMs: +(process.env.SUP_TIMEOUT_MS || 8000), fails: +(process.env.SUP_FAILS || 3) },
  volatile: { probeMs: 2000, timeoutMs: 5000, fails: 2 },
};
const BOOT_GRACE_MS = +(process.env.SUP_BOOT_GRACE_MS || 120e3); // probes don't count until first healthy answer (or this long)
const PLANNED_TTL_MS = 180e3;

const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, v) => { const t = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1)); fs.renameSync(t, f); };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const cmdline = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch { return ''; } };
const isZombie = (pid) => { try { return /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; } };
const ptTime = (t) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(t)) + ' PT';
function supAlive(st) { return st && st.pid && alive(st.pid) && cmdline(st.pid).includes('supervisor.js'); }

// pid listening on PORT (via ss; null if none / unknown)
function listenerPid() {
  try { const o = execFileSync('ss', ['-ltnpH', `sport = :${PORT}`], { encoding: 'utf8', timeout: 3000 }); const m = o.match(/pid=(\d+)/); return m ? +m[1] : null; } catch { return null; }
}

// ---------- subcommands ----------
const cmd = process.argv[2];
if (cmd === 'status') { const st = readJ(STATE, null); console.log(JSON.stringify({ ...st, supervisorAlive: supAlive(st), childAlive: st ? alive(st.childPid) : false }, null, 1)); process.exit(0); }
if (cmd === 'restart') {
  const st = readJ(STATE, null); const why = process.argv.slice(3).join(' ').trim() || 'planned restart';
  if (!supAlive(st)) { console.error('supervisor not running (data/supervisor.json). Start it first: scripts/start-supervisor.sh. No pattern kill was done.'); process.exit(2); }
  const pid = st.childPid; if (!pid || !alive(pid)) { console.error('no live supervised child PID; the supervisor will start one itself'); process.exit(3); }
  writeJ(MARK, { t: Date.now(), pid, reason: why, by: process.env.AGENT_NAME || process.env.USER || 'unknown' });
  process.kill(pid, 'SIGTERM'); console.log(`planned restart: SIGTERM -> pid ${pid} (${why}); waiting for a new healthy server...`);
  const t0 = Date.now();
  const iv = setInterval(() => {
    const s = readJ(STATE, {});
    if (s.childPid && s.childPid !== pid && s.healthy) { console.log(`up again: pid ${s.childPid} after ${((Date.now() - t0) / 1000).toFixed(1)}s`); clearInterval(iv); process.exit(0); }
    if (alive(pid) && Date.now() - t0 > 10e3 && !isZombie(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    if (Date.now() - t0 > 150e3) { console.error('timed out waiting for the server to come back (see data/server.log)'); clearInterval(iv); process.exit(4); }
  }, 500);
  return;
}

// ---------- supervisor ----------
{
  const st = readJ(STATE, null);
  if (supAlive(st) && st.pid !== process.pid && (st.port || 8000) === PORT) { console.error(`another supervisor (pid ${st.pid}) already supervises :${PORT}`); process.exit(1); }
}
const S = { pid: process.pid, port: PORT, startedAt: Date.now(), childPid: null, adopted: false, childStartedAt: null, healthy: false, lastOk: null, fails: 0,
  firstFailAt: null, mode: 'normal', volatileReason: null, envOk: null, crashStreak: 0, backoffMs: 0, pending: null, lastRestart: null };
const say = (m) => { const l = `${new Date().toString().replace(/ GMT.*/, '')} [supervisor] ${m}`; console.log(l); try { fs.appendFileSync(TXT, l + '\n'); } catch {} };
const saveState = () => { try { writeJ(STATE, { ...S, profile: P[S.mode], updatedAt: Date.now() }); } catch (e) { console.error('state write', e.message); } };
let child = null, adoptTimer = null, probeTimer = null, killing = null, stopping = false;

function envCheck(pid) { try { const k = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').map((l) => l.split('=')[0]); const m = SECRETS.filter((s) => !k.includes(s)); return m.length ? 'missing: ' + m.join(',') : 'ok'; } catch { return null; } }

function appendRestart(r) {
  const d = readJ(LOGF, { restarts: [] }); d.restarts = [...(d.restarts || []), r].slice(-500); d.updatedAt = Date.now();
  try { writeJ(LOGF, d); } catch (e) { say('restarts.json write failed ' + e.message); }
}

function onDown(reason, kind, extra = {}) {
  if (stopping) return;
  const now = Date.now(); const oldPid = S.childPid; const lived = S.childStartedAt ? now - S.childStartedAt : null;
  const m = readJ(MARK, null);
  const planned = m && now - m.t < PLANNED_TTL_MS && (!m.pid || m.pid === oldPid);
  if (planned) { try { fs.unlinkSync(MARK); } catch {} kind = 'planned'; reason = `planned: ${m.reason}${m.by ? ' (by ' + m.by + ')' : ''}`; }
  const downAt = kind === 'hung' && S.firstFailAt ? S.firstFailAt : now;
  clearTimeout(killing); killing = null; S.pendingHang = null; clearInterval(adoptTimer);
  if (S.pending) { S.pending.attempts++; S.pending.lastReason = reason; } // died again before ever becoming healthy
  else S.pending = { t: downAt, detectedAt: now, reason, kind, oldPid, livedS: lived != null ? Math.round(lived / 1000) : null, attempts: 1, port: PORT, ...extra };
  // backoff only for rapid crash loops (process died < 30s after start, unplanned)
  if (kind !== 'planned' && lived != null && lived < 30e3) S.crashStreak++; else S.crashStreak = 0;
  S.backoffMs = S.crashStreak > 1 ? Math.min(60e3, 1000 * 2 ** (S.crashStreak - 2)) : 0;
  S.childPid = null; S.adopted = false; S.healthy = false; S.fails = 0; S.firstFailAt = null; child = null;
  say(`server pid ${oldPid} down: ${reason}${S.backoffMs ? ` · crash loop x${S.crashStreak}, backoff ${S.backoffMs / 1000}s` : ''}`);
  saveState();
  setTimeout(launch, S.backoffMs);
}

function adopt(pid, why) {
  S.childPid = pid; S.adopted = true; S.childStartedAt = Date.now(); S.fails = 0; S.firstFailAt = null; S.envOk = envCheck(pid);
  say(`adopted existing server pid ${pid} on :${PORT} (${why}); env secrets ${S.envOk}`);
  clearInterval(adoptTimer);
  adoptTimer = setInterval(() => {
    if (S.adopted && S.childPid === pid && (!alive(pid) || isZombie(pid))) { clearInterval(adoptTimer); const h = S.pendingHang; h ? onDown(h, 'hung') : onDown('adopted process exited (code unknown: not our child)', 'exit'); }
  }, 250);
  saveState();
}

function launch() {
  if (stopping || S.childPid) return;
  const other = listenerPid();
  if (other && alive(other)) { adopt(other, 'port already in use'); return; }
  const out = fs.openSync(path.join(DATA, 'server.log'), 'a');
  const c = spawn('sh', [path.join(ROOT, 'scripts/run-server.sh')], { cwd: ROOT, env: process.env, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  child = c; S.childPid = c.pid; S.adopted = false; S.childStartedAt = Date.now(); S.healthy = false; S.fails = 0; S.firstFailAt = null;
  setTimeout(() => { if (S.childPid === c.pid) { S.envOk = envCheck(c.pid); saveState(); } }, 1500);
  say(`started server pid ${c.pid}`);
  c.on('exit', (code, signal) => {
    if (S.childPid !== c.pid) return;
    const hung = S.pendingHang;
    if (hung) onDown(hung, 'hung');
    else if (signal) onDown(`killed by signal ${signal}`, 'signal', { signal });
    else onDown(`exited with code ${code}`, 'exit', { code });
  });
  saveState();
}

function killExact(pid, why) {
  if (!pid || killing) return;
  S.pendingHang = why; say(`server pid ${pid} unresponsive: ${why} -> SIGTERM`);
  try { process.kill(pid, 'SIGTERM'); } catch {}
  killing = setTimeout(() => { killing = null; if (alive(pid) && !isZombie(pid)) { say(`pid ${pid} ignored SIGTERM -> SIGKILL`); try { process.kill(pid, 'SIGKILL'); } catch {} } }, 3000);
}

function probeOnce(timeoutMs) {
  return new Promise((res) => {
    const t0 = Date.now();
    const rq = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', agent: false, timeout: timeoutMs }, (r) => { r.resume(); res({ ok: true, ms: Date.now() - t0, status: r.statusCode }); });
    rq.on('timeout', () => { rq.destroy(); res({ ok: false, err: `timeout ${timeoutMs}ms` }); });
    rq.on('error', (e) => res({ ok: false, err: e.code || e.message }));
  });
}

async function probeLoop() {
  const prof = P[S.mode]; const t0 = Date.now();
  const pid = S.childPid;
  if (pid && !killing) {
    const r = await probeOnce(prof.timeoutMs);
    if (S.childPid === pid) {
      if (r.ok) {
        if (!S.healthy) {
          S.healthy = true;
          if (S.pending) {
            const p = S.pending; S.pending = null;
            const rec = { ...p, at: new Date(p.t).toISOString(), upAt: Date.now(), newPid: pid, downtimeS: +((Date.now() - p.t) / 1000).toFixed(1), unplanned: p.kind !== 'planned' };
            appendRestart(rec); S.lastRestart = rec;
            say(`server back: pid ${pid} healthy after ${rec.downtimeS}s down (${rec.reason})`);
          } else say(`server pid ${pid} healthy`);
        }
        S.fails = 0; S.firstFailAt = null; S.lastOk = Date.now(); S.lastProbeMs = r.ms;
      } else {
        const inGrace = !S.healthy && Date.now() - S.childStartedAt < BOOT_GRACE_MS;
        if (!inGrace) {
          S.fails++; S.firstFailAt ||= t0; S.lastErr = r.err;
          if (S.fails >= prof.fails) killExact(pid, `hung: ${S.fails} consecutive failed health probes (${r.err}, ${S.mode} profile)`);
        }
      }
      saveState();
    }
  }
  // while (re)starting, poll fast so recovery is noticed (and downtime measured) within ~300ms
  const every = S.childPid && !S.healthy && !killing ? 300 : prof.probeMs;
  probeTimer = setTimeout(probeLoop, Math.max(200, every - (Date.now() - t0)));
}

// volatility: seasonality live state + fresh liquidation cascade (+ SUP_FORCE_VOLATILE=1 / data/supervisor_force_volatile flag for tests)
let season = null; try { season = require(path.join(ROOT, 'lib/seasonality.js')); } catch {}
function volatility() {
  const why = [];
  if (process.env.SUP_FORCE_VOLATILE === '1' || fs.existsSync(path.join(DATA, 'supervisor_force_volatile'))) why.push('forced');
  try { const ls = season && season.liveState(DATA); const pm = ls && ls.ok && ls.pooledMajors; if (pm && pm.verdict === 'volatile') why.push(`seasonality: ${pm.top?.id}${pm.top?.inMin != null ? ' in ' + pm.top.inMin + 'm' : ' now'}`); } catch {}
  try { const l = readJ(path.join(DATA, 'liquidations.json'), null); if (l && Date.now() - l.generatedAt < 10 * 60e3) { const c = (l.assets || []).filter((a) => a.level === 'cascade').map((a) => a.sym); if (c.length) why.push('liquidation cascade: ' + c.slice(0, 4).join(',')); } } catch {}
  const mode = why.length ? 'volatile' : 'normal';
  if (mode !== S.mode) say(`probe profile -> ${mode} (${why.join('; ') || 'calm'}): every ${P[mode].probeMs / 1000}s, restart after ${P[mode].fails} failures`);
  S.mode = mode; S.volatileReason = why.join('; ') || null;
}

function stop(sig) { stopping = true; say(`supervisor stopping on ${sig}; server pid ${S.childPid} left running (next supervisor adopts it)`); S.stoppedAt = Date.now(); saveState(); process.exit(0); }
process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT')); process.on('SIGHUP', () => {});

say(`supervisor pid ${process.pid} starting for :${PORT} (normal ${P.normal.probeMs / 1000}s/${P.normal.timeoutMs / 1000}s timeout/${P.normal.fails} fails; volatile 2s/5s/2)`);
volatility(); setInterval(volatility, 30e3);
launch(); probeLoop();
